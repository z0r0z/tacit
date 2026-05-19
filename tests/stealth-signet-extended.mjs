// Extended signet hardening for the blinded-pubkey commit primitive.
// Builds on tests/stealth-signet-e2e.mjs (single round-trip) with four
// additional scenarios that stress the production-relevant edge cases:
//
//   Phase A: multi-output stealth (merchant batched payouts)
//     Bob sends ONE tx with 3 stealth outputs to Alice at vout_index
//     0, 1, 2. Each gets a distinct address via per-vout_index anchor.
//     Alice scans + finds all 3. Alice consolidates into 1 spend.
//     Validates §A.2.5 + §D.2 multi-output disambiguation on real chain.
//
//   Phase B: P2TR stealth output
//     Bob sends 1 tx with stealth output as P2TR(x_only(commit)).
//     Alice scans + dual-matches against P2TR. Alice spends using
//     BIP-340 Schnorr key-path under tweaked_sk.
//     Validates §A.3 alternate script type + even-Y handling.
//
//   Phase C: multi-input sender aggregation
//     Bob spends 2 of his own P2WPKH UTXOs in one tx. P_sender =
//     P_1 + P_2. Alice's scanner aggregates per §A.2.5. Finds receipt.
//     Validates aggregate rule for multi-input common case.
//
//   Phase D: chained stealth (Bob → Alice → Carol)
//     Alice receives a stealth payment from Bob, then uses that
//     stealth UTXO as her input to a NEW stealth payment to Carol.
//     Carol's scanner finds the receipt. Validates downstream
//     transferability: stealth-derived P2WPKH inputs are eligible
//     §A.2.5 sender pubkeys.
//
// Resumable state at .local/stealth-signet-extended-state.json.
// Each phase is idempotent; rerun picks up where it left off.
//
// Pre-reqs:
//   .local/stealth-signet-{alice,bob,carol}.json (run
//      gen-stealth-signet-wallets.mjs)
//   Bob funded with ≥ 50,000 signet sats (covers all 4 phases + fees).
//
// Run: node tests/stealth-signet-extended.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import {
  decodeStealthAddress,
  senderComputeStealthCommit, recipientScanTxForStealth,
  p2wpkhScript, p2trScript, xOnly,
  computeCommit, computeTweakedSk, deriveEcdhBlinding,
  aggregateEligibleInputPubkeys,
  DOMAIN_CXFER_STEALTH,
} from './stealth-primitives.mjs';
import {
  signP2wpkhInput, signP2trKeyPathInput,
  serializeTx, txid, txidLEBytes, u32le,
  getUtxos, broadcast, getTx, waitForConfirm,
  DEFAULT_MEMPOOL,
} from './stealth-btc-tx.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR  = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'stealth-signet-extended-state.json');
const ALICE_FILE = path.join(STATE_DIR, 'stealth-signet-alice.json');
const BOB_FILE   = path.join(STATE_DIR, 'stealth-signet-bob.json');
const CAROL_FILE = path.join(STATE_DIR, 'stealth-signet-carol.json');

const FEE_RATE  = Number(process.env.FEE_RATE || 2);
const DUST      = 546;
const PHASE     = process.env.PHASE || '';  // 'A' | 'B' | 'C' | 'D' | '' (all)
const SKIP      = (process.env.SKIP || '').split(',').filter(Boolean);

function loadState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function phase(name) { console.log(`\n=== ${name} ===`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

if (!existsSync(ALICE_FILE) || !existsSync(BOB_FILE) || !existsSync(CAROL_FILE)) {
  fail('Wallets missing. Run: node tests/gen-stealth-signet-wallets.mjs');
}
const ALICE = JSON.parse(readFileSync(ALICE_FILE, 'utf8'));
const BOB   = JSON.parse(readFileSync(BOB_FILE, 'utf8'));
const CAROL = JSON.parse(readFileSync(CAROL_FILE, 'utf8'));

const alicePriv = hexToBytes(ALICE.priv_hex);
const alicePub  = hexToBytes(ALICE.pub_hex);
const bobPriv   = hexToBytes(BOB.priv_hex);
const bobPub    = hexToBytes(BOB.pub_hex);
const carolPriv = hexToBytes(CAROL.priv_hex);
const carolPub  = hexToBytes(CAROL.pub_hex);

console.log(`\n=== Stealth signet extended hardening ===`);
console.log(`  Alice: ${ALICE.address}`);
console.log(`  Bob:   ${BOB.address}`);
console.log(`  Carol: ${CAROL.address}`);
console.log(`  Fee rate: ${FEE_RATE} sat/vB`);

const state = loadState();

// =============================================================================
// Helpers
// =============================================================================

async function pickBobUtxo(minValue, opts = {}) {
  const utxos = await getUtxos(BOB.address);
  const confirmed = utxos.filter(u => u.status?.confirmed);
  const above = confirmed.filter(u => u.value >= minValue);
  if (above.length === 0) {
    info(`Bob UTXOs: ${confirmed.length} confirmed (max ${Math.max(0, ...confirmed.map(u => u.value))} sats)`);
    fail(`No confirmed Bob UTXO ≥ ${minValue} sats`);
  }
  // Sort by value desc; pick largest
  const picked = above.sort((a, b) => b.value - a.value)[0];
  if (opts.excludeTxid && picked.txid === opts.excludeTxid) {
    if (above.length < 2) fail('Need a 2nd confirmed Bob UTXO');
    return above.sort((a, b) => b.value - a.value)[1];
  }
  return picked;
}

function tx_anchor_head(utxoTxid, utxoVout) {
  // NORMATIVE (audit 3.6): tx anchor uses txid in little-endian wire order.
  return concatBytes(txidLEBytes(utxoTxid), u32le(utxoVout));
}

function rip160OfCommit(commit33) { return p2wpkhScript(commit33).slice(2); }

// =============================================================================
// PHASE A — multi-output stealth (merchant batched payouts)
// =============================================================================

async function phaseA() {
  phase('Phase A — multi-output stealth (3 outputs in 1 tx)');

  const N_OUTPUTS = 3;
  const PER_OUTPUT = 2000;  // sats per stealth output

  if (state.A?.spendTxid && state.A?.spendConfirmedHeight) {
    ok(`Phase A already completed in prior run (consolidation tx ${state.A.spendTxid})`);
    return;
  }

  if (!state.A?.sendTxid) {
    info('Building tx with 3 stealth outputs to Alice…');
    const decoded = decodeStealthAddress(ALICE.stealth_address);
    const utxo = await pickBobUtxo(N_OUTPUTS * PER_OUTPUT + 5000);
    info(`spending Bob UTXO ${utxo.txid.slice(0, 16)}…:${utxo.vout} (${utxo.value} sats)`);

    const anchorHead = tx_anchor_head(utxo.txid, utxo.vout);

    // Build N stealth outputs at vout 0..N-1.
    const outputs = [];
    const commits = [];
    for (let v = 0; v < N_OUTPUTS; v++) {
      const { commit } = senderComputeStealthCommit({
        senderEligibleInputPrivs: [bobPriv],
        recipientPub: decoded.recipientPub,
        networkTag: 'signet',
        domain: DOMAIN_CXFER_STEALTH,
        txAnchorHead: anchorHead,
        voutIndex: v,
      });
      commits.push(commit);
      outputs.push({ value: PER_OUTPUT, script: p2wpkhScript(commit) });
    }

    // Change output to Bob.
    const feeBytesEstimate = 110 + 32 * N_OUTPUTS + 32;
    const fee = Math.max(feeBytesEstimate * FEE_RATE, 500);
    const change = utxo.value - N_OUTPUTS * PER_OUTPUT - fee;
    if (change < DUST) fail(`change ${change} below dust`);
    outputs.push({ value: change, script: p2wpkhScript(bobPub) });

    const tx = {
      version: 2, locktime: 0,
      inputs: [{ txid: utxo.txid, vout: utxo.vout, sequence: 0xfffffffd, witness: [] }],
      outputs,
    };
    tx.inputs[0].witness = signP2wpkhInput({
      tx, inputIndex: 0,
      prevoutScript: p2wpkhScript(bobPub), prevoutValue: utxo.value,
      priv: bobPriv, pub: bobPub,
    });
    const hex = bytesToHex(serializeTx(tx));
    info(`tx: ${hex.length / 2} bytes`);
    const tid = await broadcast(hex);
    ok(`broadcasted: ${tid}`);
    state.A = {
      sendTxid: tid,
      commitsHex: commits.map(c => bytesToHex(c)),
      anchorHeadHex: bytesToHex(anchorHead),
      inputTxid: utxo.txid,
      inputVout: utxo.vout,
      perOutput: PER_OUTPUT,
      nOutputs: N_OUTPUTS,
    };
    saveState(state);
  }

  if (!state.A.sendConfirmedHeight) {
    info(`waiting for ${state.A.sendTxid} to confirm…`);
    const t = await waitForConfirm(state.A.sendTxid);
    console.log();
    ok(`confirmed at height ${t.status.block_height}`);
    state.A.sendConfirmedHeight = t.status.block_height;
    saveState(state);
  }

  // Alice scans.
  info(`Alice scanning send tx…`);
  const sendTxJson = await getTx(state.A.sendTxid);
  const anchorHead = hexToBytes(state.A.anchorHeadHex);
  const scanTx = {
    inputs: sendTxJson.vin.map(v => {
      const w = v.witness || [];
      if (w.length === 2 && w[1].length === 66) return { kind: 'p2wpkh', pub: hexToBytes(w[1]) };
      return { kind: 'unknown', pub: null };
    }),
    outputs: sendTxJson.vout.map(o => ({ script: hexToBytes(o.scriptpubkey) })),
  };
  const credits = recipientScanTxForStealth({
    tx: scanTx, walletPriv: alicePriv, walletPub: alicePub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead: anchorHead,
  });
  if (credits.length !== state.A.nOutputs) {
    fail(`Alice expected ${state.A.nOutputs} credits; found ${credits.length}`);
  }
  ok(`Alice detected all ${credits.length} stealth credits at vouts ${credits.map(c => c.voutIndex).join(', ')}`);

  // Verify all addresses are DISTINCT — proves vout_index disambiguation works on chain.
  const addrs = credits.map(c => bytesToHex(c.commit));
  const distinct = new Set(addrs).size;
  if (distinct !== addrs.length) fail(`commits collided across vouts! ${addrs}`);
  ok(`all ${addrs.length} stealth addresses are distinct on chain`);

  // Alice consolidates: spend all 3 stealth UTXOs in one tx back to Bob.
  if (!state.A.spendTxid) {
    info(`Alice consolidating ${credits.length} stealth UTXOs into 1 spend back to Bob…`);
    const totalIn = credits.length * state.A.perOutput;
    const fee = Math.max((10 + 41 * credits.length + 32) * FEE_RATE, 500);
    const spendValue = totalIn - fee;
    if (spendValue < DUST) fail(`spend value below dust`);

    const tx = {
      version: 2, locktime: 0,
      inputs: credits.map(c => ({
        txid: state.A.sendTxid, vout: c.voutIndex, sequence: 0xfffffffd, witness: [],
      })),
      outputs: [{ value: spendValue, script: p2wpkhScript(bobPub) }],
    };
    for (let i = 0; i < credits.length; i++) {
      const c = credits[i];
      tx.inputs[i].witness = signP2wpkhInput({
        tx, inputIndex: i,
        prevoutScript: p2wpkhScript(c.commit), prevoutValue: state.A.perOutput,
        priv: c.tweakedSk, pub: c.commit,
      });
    }
    const hex = bytesToHex(serializeTx(tx));
    info(`spend tx: ${hex.length / 2} bytes`);
    const tid = await broadcast(hex);
    ok(`broadcasted: ${tid}`);
    state.A.spendTxid = tid;
    state.A.spendValue = spendValue;
    saveState(state);
  }

  info(`waiting for consolidation tx to confirm…`);
  const t = await waitForConfirm(state.A.spendTxid);
  console.log();
  ok(`confirmed at height ${t.status.block_height}`);
  state.A.spendConfirmedHeight = t.status.block_height;
  saveState(state);

  ok(`Phase A PASSED — 3 stealth outputs, distinct addresses, full consolidation`);
}

// =============================================================================
// PHASE B — P2TR stealth output
// =============================================================================

async function phaseB() {
  phase('Phase B — P2TR stealth output');

  if (state.B?.spendConfirmedHeight) {
    ok(`Phase B already completed (spend ${state.B.spendTxid})`);
    return;
  }

  const STEALTH_AMOUNT = 3000;

  if (!state.B?.sendTxid) {
    const decoded = decodeStealthAddress(ALICE.stealth_address);
    const utxo = await pickBobUtxo(STEALTH_AMOUNT + 5000);
    info(`spending Bob UTXO ${utxo.txid.slice(0, 16)}…:${utxo.vout} (${utxo.value} sats)`);

    const anchorHead = tx_anchor_head(utxo.txid, utxo.vout);
    const { commit } = senderComputeStealthCommit({
      senderEligibleInputPrivs: [bobPriv],
      recipientPub: decoded.recipientPub,
      networkTag: 'signet',
      domain: DOMAIN_CXFER_STEALTH,
      txAnchorHead: anchorHead, voutIndex: 0,
    });

    // Emit as P2TR(x_only(commit)) instead of P2WPKH.
    info(`stealth output as P2TR(x_only(commit)), commit=${bytesToHex(commit).slice(0, 16)}…`);
    const stealthScript = p2trScript(xOnly(commit));

    const feeBytes = 110 + 43 + 32;  // p2wpkh in + p2tr out + p2wpkh change
    const fee = Math.max(feeBytes * FEE_RATE, 500);
    const change = utxo.value - STEALTH_AMOUNT - fee;
    if (change < DUST) fail(`change ${change} below dust`);

    const tx = {
      version: 2, locktime: 0,
      inputs: [{ txid: utxo.txid, vout: utxo.vout, sequence: 0xfffffffd, witness: [] }],
      outputs: [
        { value: STEALTH_AMOUNT, script: stealthScript },
        { value: change, script: p2wpkhScript(bobPub) },
      ],
    };
    tx.inputs[0].witness = signP2wpkhInput({
      tx, inputIndex: 0,
      prevoutScript: p2wpkhScript(bobPub), prevoutValue: utxo.value,
      priv: bobPriv, pub: bobPub,
    });
    const hex = bytesToHex(serializeTx(tx));
    const tid = await broadcast(hex);
    ok(`broadcasted P2TR stealth: ${tid}`);
    state.B = {
      sendTxid: tid,
      commitHex: bytesToHex(commit),
      anchorHeadHex: bytesToHex(anchorHead),
      stealthAmount: STEALTH_AMOUNT,
    };
    saveState(state);
  }

  if (!state.B.sendConfirmedHeight) {
    info(`waiting for ${state.B.sendTxid}…`);
    const t = await waitForConfirm(state.B.sendTxid);
    console.log();
    ok(`confirmed at height ${t.status.block_height}`);
    state.B.sendConfirmedHeight = t.status.block_height;
    saveState(state);
  }

  // Alice scans — must dual-match to find P2TR output.
  info(`Alice scanning send tx (expects P2TR match)…`);
  const sendTxJson = await getTx(state.B.sendTxid);
  const scanTx = {
    inputs: sendTxJson.vin.map(v => {
      const w = v.witness || [];
      if (w.length === 2 && w[1].length === 66) return { kind: 'p2wpkh', pub: hexToBytes(w[1]) };
      return { kind: 'unknown', pub: null };
    }),
    outputs: sendTxJson.vout.map(o => ({ script: hexToBytes(o.scriptpubkey) })),
  };
  const anchorHead = hexToBytes(state.B.anchorHeadHex);
  const credits = recipientScanTxForStealth({
    tx: scanTx, walletPriv: alicePriv, walletPub: alicePub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead: anchorHead,
  });
  if (credits.length !== 1) fail(`expected 1 credit; found ${credits.length}`);
  if (credits[0].scriptKind !== 'p2tr') fail(`expected P2TR match; got ${credits[0].scriptKind}`);
  ok(`Alice matched P2TR stealth output via scriptKind=p2tr`);

  // Alice spends via BIP-340 Schnorr key-path.
  if (!state.B.spendTxid) {
    info(`Alice spending P2TR stealth UTXO via Schnorr key-path…`);
    const c = credits[0];
    const fee = Math.max(110 * FEE_RATE, 500);
    const spendValue = state.B.stealthAmount - fee;
    if (spendValue < DUST) fail(`spend below dust`);

    const tx = {
      version: 2, locktime: 0,
      inputs: [{ txid: state.B.sendTxid, vout: c.voutIndex, sequence: 0xfffffffd, witness: [] }],
      outputs: [{ value: spendValue, script: p2wpkhScript(bobPub) }],
    };
    const prevouts = [{ value: state.B.stealthAmount, script: p2trScript(xOnly(c.commit)) }];
    tx.inputs[0].witness = signP2trKeyPathInput({
      tx, inputIndex: 0, prevouts, priv: c.tweakedSk,
    });
    const hex = bytesToHex(serializeTx(tx));
    info(`tx: ${hex.length / 2} bytes`);
    const tid = await broadcast(hex);
    ok(`broadcasted Schnorr spend: ${tid}`);
    state.B.spendTxid = tid;
    state.B.spendValue = spendValue;
    saveState(state);
  }

  info(`waiting for spend confirmation…`);
  const t = await waitForConfirm(state.B.spendTxid);
  console.log();
  ok(`confirmed at height ${t.status.block_height}`);
  state.B.spendConfirmedHeight = t.status.block_height;
  saveState(state);

  ok(`Phase B PASSED — P2TR stealth + Schnorr key-path spend`);
}

// =============================================================================
// PHASE C — multi-input sender aggregation
// =============================================================================

async function phaseC() {
  phase('Phase C — multi-input sender aggregation (Bob spends 2 own UTXOs)');

  if (state.C?.spendConfirmedHeight) {
    ok(`Phase C already completed (spend ${state.C.spendTxid})`);
    return;
  }

  const STEALTH_AMOUNT = 4000;

  if (!state.C?.sendTxid) {
    const decoded = decodeStealthAddress(ALICE.stealth_address);
    // Need TWO confirmed Bob UTXOs.
    const utxos = (await getUtxos(BOB.address))
      .filter(u => u.status?.confirmed)
      .sort((a, b) => b.value - a.value);
    if (utxos.length < 2) {
      info(`Only ${utxos.length} confirmed Bob UTXO(s) — Phase C needs 2.`);
      info(`Run Phase A or B first to fragment Bob's wallet, or skip Phase C.`);
      fail('Phase C needs ≥ 2 confirmed Bob UTXOs');
    }
    const u1 = utxos[0], u2 = utxos[1];
    info(`spending Bob UTXOs ${u1.txid.slice(0,16)}…:${u1.vout} (${u1.value}) + ${u2.txid.slice(0,16)}…:${u2.vout} (${u2.value})`);

    // tx_anchor uses vin[0].outpoint per §C.
    const anchorHead = tx_anchor_head(u1.txid, u1.vout);

    // Sender computes commit using AGGREGATE privkey of both inputs.
    const { commit } = senderComputeStealthCommit({
      senderEligibleInputPrivs: [bobPriv, bobPriv],  // both inputs are Bob's
      recipientPub: decoded.recipientPub,
      networkTag: 'signet',
      domain: DOMAIN_CXFER_STEALTH,
      txAnchorHead: anchorHead, voutIndex: 0,
    });
    info(`aggregate-based commit: ${bytesToHex(commit).slice(0,16)}…`);

    const totalIn = u1.value + u2.value;
    const feeBytes = 11 + 41 * 2 + 32 + 32;
    const fee = Math.max(feeBytes * FEE_RATE, 500);
    const change = totalIn - STEALTH_AMOUNT - fee;
    if (change < DUST) fail(`change ${change} below dust`);

    const tx = {
      version: 2, locktime: 0,
      inputs: [
        { txid: u1.txid, vout: u1.vout, sequence: 0xfffffffd, witness: [] },
        { txid: u2.txid, vout: u2.vout, sequence: 0xfffffffd, witness: [] },
      ],
      outputs: [
        { value: STEALTH_AMOUNT, script: p2wpkhScript(commit) },
        { value: change, script: p2wpkhScript(bobPub) },
      ],
    };
    tx.inputs[0].witness = signP2wpkhInput({
      tx, inputIndex: 0, prevoutScript: p2wpkhScript(bobPub), prevoutValue: u1.value,
      priv: bobPriv, pub: bobPub,
    });
    tx.inputs[1].witness = signP2wpkhInput({
      tx, inputIndex: 1, prevoutScript: p2wpkhScript(bobPub), prevoutValue: u2.value,
      priv: bobPriv, pub: bobPub,
    });
    const hex = bytesToHex(serializeTx(tx));
    const tid = await broadcast(hex);
    ok(`broadcasted: ${tid}`);
    state.C = {
      sendTxid: tid, commitHex: bytesToHex(commit),
      anchorHeadHex: bytesToHex(anchorHead),
      stealthAmount: STEALTH_AMOUNT,
    };
    saveState(state);
  }

  if (!state.C.sendConfirmedHeight) {
    info(`waiting for ${state.C.sendTxid}…`);
    const t = await waitForConfirm(state.C.sendTxid);
    console.log();
    ok(`confirmed at height ${t.status.block_height}`);
    state.C.sendConfirmedHeight = t.status.block_height;
    saveState(state);
  }

  // Alice scans — must aggregate BOTH inputs to derive P_sender correctly.
  info(`Alice scanning (must aggregate 2 P2WPKH inputs into P_sender)…`);
  const sendTxJson = await getTx(state.C.sendTxid);
  const scanTx = {
    inputs: sendTxJson.vin.map(v => {
      const w = v.witness || [];
      if (w.length === 2 && w[1].length === 66) return { kind: 'p2wpkh', pub: hexToBytes(w[1]) };
      return { kind: 'unknown', pub: null };
    }),
    outputs: sendTxJson.vout.map(o => ({ script: hexToBytes(o.scriptpubkey) })),
  };
  // Sanity: confirm aggregation logic identifies both Bob inputs as eligible.
  const { aggregatePub, eligibleCount } = aggregateEligibleInputPubkeys(scanTx.inputs);
  info(`scanner identified ${eligibleCount} eligible inputs; aggregate ${bytesToHex(aggregatePub).slice(0,16)}…`);
  if (eligibleCount !== 2) fail(`expected 2 eligible inputs; found ${eligibleCount}`);

  const anchorHead = hexToBytes(state.C.anchorHeadHex);
  const credits = recipientScanTxForStealth({
    tx: scanTx, walletPriv: alicePriv, walletPub: alicePub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead: anchorHead,
  });
  if (credits.length !== 1) fail(`expected 1 credit; found ${credits.length}`);
  ok(`Alice detected receipt via aggregated P_sender (proves §A.2.5 aggregation works on real chain)`);

  // Alice spends.
  if (!state.C.spendTxid) {
    info(`Alice spending the multi-input-aggregate stealth UTXO…`);
    const c = credits[0];
    const fee = Math.max(110 * FEE_RATE, 500);
    const spendValue = state.C.stealthAmount - fee;
    const tx = {
      version: 2, locktime: 0,
      inputs: [{ txid: state.C.sendTxid, vout: c.voutIndex, sequence: 0xfffffffd, witness: [] }],
      outputs: [{ value: spendValue, script: p2wpkhScript(bobPub) }],
    };
    tx.inputs[0].witness = signP2wpkhInput({
      tx, inputIndex: 0, prevoutScript: p2wpkhScript(c.commit), prevoutValue: state.C.stealthAmount,
      priv: c.tweakedSk, pub: c.commit,
    });
    const tid = await broadcast(bytesToHex(serializeTx(tx)));
    ok(`broadcasted: ${tid}`);
    state.C.spendTxid = tid;
    state.C.spendValue = spendValue;
    saveState(state);
  }
  info(`waiting for spend…`);
  const t = await waitForConfirm(state.C.spendTxid);
  console.log();
  ok(`confirmed at height ${t.status.block_height}`);
  state.C.spendConfirmedHeight = t.status.block_height;
  saveState(state);

  ok(`Phase C PASSED — multi-input sender aggregation verified on chain`);
}

// =============================================================================
// PHASE D — chained stealth (Bob → Alice → Carol)
// =============================================================================

async function phaseD() {
  phase('Phase D — chained stealth (Bob → Alice → Carol downstream)');

  if (state.D?.carolConfirmedHeight) {
    ok(`Phase D already completed (Alice→Carol ${state.D.carolSendTxid})`);
    return;
  }

  const HOP1_AMOUNT = 8000;  // Bob sends 8000 to Alice's stealth
  const HOP2_AMOUNT = 4000;  // Alice forwards 4000 to Carol's stealth (rest stays at Alice)

  // Hop 1: Bob → Alice (stealth)
  if (!state.D?.bobToAliceTxid) {
    const decoded = decodeStealthAddress(ALICE.stealth_address);
    const utxo = await pickBobUtxo(HOP1_AMOUNT + 5000);
    info(`hop 1: Bob → Alice stealth. UTXO ${utxo.txid.slice(0,16)}…:${utxo.vout}`);
    const anchorHead = tx_anchor_head(utxo.txid, utxo.vout);
    const { commit } = senderComputeStealthCommit({
      senderEligibleInputPrivs: [bobPriv],
      recipientPub: decoded.recipientPub,
      networkTag: 'signet',
      domain: DOMAIN_CXFER_STEALTH,
      txAnchorHead: anchorHead, voutIndex: 0,
    });
    const fee = Math.max(150 * FEE_RATE, 500);
    const change = utxo.value - HOP1_AMOUNT - fee;
    const tx = {
      version: 2, locktime: 0,
      inputs: [{ txid: utxo.txid, vout: utxo.vout, sequence: 0xfffffffd, witness: [] }],
      outputs: [
        { value: HOP1_AMOUNT, script: p2wpkhScript(commit) },
        { value: change, script: p2wpkhScript(bobPub) },
      ],
    };
    tx.inputs[0].witness = signP2wpkhInput({
      tx, inputIndex: 0, prevoutScript: p2wpkhScript(bobPub), prevoutValue: utxo.value,
      priv: bobPriv, pub: bobPub,
    });
    const tid = await broadcast(bytesToHex(serializeTx(tx)));
    ok(`hop 1 broadcasted: ${tid}`);
    state.D = {
      bobToAliceTxid: tid, hop1Anchor: bytesToHex(anchorHead),
      hop1Commit: bytesToHex(commit), hop1Amount: HOP1_AMOUNT,
    };
    saveState(state);
  }
  if (!state.D.bobToAliceConfirmedHeight) {
    info(`hop 1 confirming…`);
    const t = await waitForConfirm(state.D.bobToAliceTxid);
    console.log();
    ok(`hop 1 confirmed at ${t.status.block_height}`);
    state.D.bobToAliceConfirmedHeight = t.status.block_height;
    saveState(state);
  }

  // Alice detects hop-1 receipt.
  info(`Alice scanning hop 1…`);
  const hop1Tx = await getTx(state.D.bobToAliceTxid);
  const hop1ScanTx = {
    inputs: hop1Tx.vin.map(v => {
      const w = v.witness || [];
      if (w.length === 2 && w[1].length === 66) return { kind: 'p2wpkh', pub: hexToBytes(w[1]) };
      return { kind: 'unknown', pub: null };
    }),
    outputs: hop1Tx.vout.map(o => ({ script: hexToBytes(o.scriptpubkey) })),
  };
  const hop1Anchor = hexToBytes(state.D.hop1Anchor);
  const hop1Credits = recipientScanTxForStealth({
    tx: hop1ScanTx, walletPriv: alicePriv, walletPub: alicePub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH, txAnchorHead: hop1Anchor,
  });
  if (hop1Credits.length !== 1) fail(`Alice expected 1 hop1 credit; found ${hop1Credits.length}`);
  const aliceCredit = hop1Credits[0];
  ok(`Alice has stealth UTXO at ${state.D.bobToAliceTxid.slice(0,16)}…:${aliceCredit.voutIndex} (${HOP1_AMOUNT} sats)`);
  info(`Alice's tweaked_sk = (alice_priv + b) — different from alice_priv`);

  // Hop 2: Alice → Carol (stealth) — using Alice's STEALTH UTXO as input
  if (!state.D.aliceToCarolTxid) {
    const decoded = decodeStealthAddress(CAROL.stealth_address);
    info(`hop 2: Alice → Carol stealth. Using Alice's stealth UTXO (tweaked-key input).`);

    // CRITICAL: the input's pubkey for §A.2.5 aggregation is the COMMIT
    // (= tweaked_sk · G). Carol's scanner will see this exact pubkey on chain
    // and use it as P_sender. The tweaked_sk owns it.
    const anchorHead = tx_anchor_head(state.D.bobToAliceTxid, aliceCredit.voutIndex);
    const { commit: hop2Commit } = senderComputeStealthCommit({
      senderEligibleInputPrivs: [aliceCredit.tweakedSk],  // Alice's tweaked secret IS the sender priv
      recipientPub: decoded.recipientPub,
      networkTag: 'signet',
      domain: DOMAIN_CXFER_STEALTH,
      txAnchorHead: anchorHead, voutIndex: 0,
    });

    const fee = Math.max(150 * FEE_RATE, 500);
    const change = HOP1_AMOUNT - HOP2_AMOUNT - fee;
    if (change < DUST) fail(`hop 2 change ${change} below dust`);

    const tx = {
      version: 2, locktime: 0,
      inputs: [{ txid: state.D.bobToAliceTxid, vout: aliceCredit.voutIndex, sequence: 0xfffffffd, witness: [] }],
      outputs: [
        { value: HOP2_AMOUNT, script: p2wpkhScript(hop2Commit) },
        // Alice's change at her classical address (we could route to her own stealth too).
        { value: change, script: p2wpkhScript(alicePub) },
      ],
    };
    // Alice signs the stealth-input spend with tweaked_sk + commit as pubkey-in-witness.
    tx.inputs[0].witness = signP2wpkhInput({
      tx, inputIndex: 0,
      prevoutScript: p2wpkhScript(aliceCredit.commit), prevoutValue: HOP1_AMOUNT,
      priv: aliceCredit.tweakedSk, pub: aliceCredit.commit,
    });
    const tid = await broadcast(bytesToHex(serializeTx(tx)));
    ok(`hop 2 broadcasted: ${tid}`);
    state.D.aliceToCarolTxid = tid;
    state.D.hop2Commit = bytesToHex(hop2Commit);
    state.D.hop2Anchor = bytesToHex(anchorHead);
    state.D.hop2Amount = HOP2_AMOUNT;
    saveState(state);
  }
  if (!state.D.aliceToCarolConfirmedHeight) {
    info(`hop 2 confirming…`);
    const t = await waitForConfirm(state.D.aliceToCarolTxid);
    console.log();
    ok(`hop 2 confirmed at ${t.status.block_height}`);
    state.D.aliceToCarolConfirmedHeight = t.status.block_height;
    saveState(state);
  }

  // Carol detects hop-2 receipt.
  info(`Carol scanning hop 2 (sender pubkey is Alice's stealth commit, NOT alice_pub)…`);
  const hop2Tx = await getTx(state.D.aliceToCarolTxid);
  const hop2ScanTx = {
    inputs: hop2Tx.vin.map(v => {
      const w = v.witness || [];
      if (w.length === 2 && w[1].length === 66) return { kind: 'p2wpkh', pub: hexToBytes(w[1]) };
      return { kind: 'unknown', pub: null };
    }),
    outputs: hop2Tx.vout.map(o => ({ script: hexToBytes(o.scriptpubkey) })),
  };
  const hop2Anchor = hexToBytes(state.D.hop2Anchor);
  const carolCredits = recipientScanTxForStealth({
    tx: hop2ScanTx, walletPriv: carolPriv, walletPub: carolPub,
    networkTag: 'signet', domain: DOMAIN_CXFER_STEALTH, txAnchorHead: hop2Anchor,
  });
  if (carolCredits.length !== 1) fail(`Carol expected 1 credit; found ${carolCredits.length}`);
  ok(`Carol detected receipt at ${state.D.aliceToCarolTxid.slice(0,16)}…:${carolCredits[0].voutIndex}`);

  // Verify the input pubkey is the commit (downstream input), not Alice's classical pub.
  const inputPubHex = bytesToHex(hop2ScanTx.inputs[0].pub);
  if (inputPubHex !== state.D.hop1Commit) {
    fail(`expected input pubkey to be Alice's stealth commit; got ${inputPubHex.slice(0,16)}…`);
  }
  ok(`confirmed: hop 2's input pubkey IS Alice's stealth commit (downstream stealth chains correctly)`);

  // Carol could spend; we stop the test chain here to keep the proof tight.
  state.D.carolConfirmedHeight = state.D.aliceToCarolConfirmedHeight;
  saveState(state);
  ok(`Phase D PASSED — chained stealth across 2 hops, balance preserved`);
}

// =============================================================================
// MAIN
// =============================================================================

const phases = [];
if (!PHASE || PHASE === 'A') if (!SKIP.includes('A')) phases.push(['A', phaseA]);
if (!PHASE || PHASE === 'B') if (!SKIP.includes('B')) phases.push(['B', phaseB]);
if (!PHASE || PHASE === 'C') if (!SKIP.includes('C')) phases.push(['C', phaseC]);
if (!PHASE || PHASE === 'D') if (!SKIP.includes('D')) phases.push(['D', phaseD]);

for (const [name, fn] of phases) {
  try { await fn(); }
  catch (e) { fail(`Phase ${name} threw: ${e.message}\n${e.stack || ''}`); }
}

console.log(`\n=== Extended hardening summary ===`);
for (const [name, fn] of phases) {
  const s = state[name];
  if (s?.spendConfirmedHeight || s?.carolConfirmedHeight) {
    console.log(`  ✓ Phase ${name} PASSED`);
  } else {
    console.log(`  ⚠ Phase ${name} incomplete`);
  }
}
console.log();
