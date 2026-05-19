// End-to-end signet test for the blinded-pubkey stealth-address scheme
// (SPEC-BLINDED-PUBKEY-AMENDMENT.md, ECDH-derived variant).
//
// Resumable harness — state persisted at .local/stealth-signet-state.json.
//
// What it tests:
//   Bob (sender) emits a Bitcoin tx with:
//     vin[0]  = Bob's classical P2WPKH UTXO (signet sats)
//     vout[0] = stealth-shaped P2WPKH output to Alice's stealth address
//               (DUST + small amount)
//     vout[1] = Bob's change at his classical P2WPKH address
//
//   Alice's scanner walks recent blocks, finds vout[0] paying her commit
//   (via §A.2.5 input aggregation + ECDH symmetry), derives tweaked_sk.
//
//   Alice spends the stealth UTXO back to Bob's classical address.
//
// Verifies:
//   1. Class-2 stealth output is correctly emitted at sender side.
//   2. Recipient scanner detects the receipt without prior coordination.
//   3. tweaked_sk derived by recipient spends the UTXO under standard
//      P2WPKH ECDSA — same custody model as a classical P2WPKH.
//   4. Backwards compat: vin[0]'s classical P2WPKH spend is unchanged.
//
// Pre-reqs:
//   .local/stealth-signet-alice.json  (run gen-stealth-signet-wallets.mjs)
//   .local/stealth-signet-bob.json    (same)
//   Bob's classical address funded with ≥ 20,000 signet sats.
//
// Optional env:
//   STEALTH_AMOUNT     sats sent to Alice's stealth address (default 5000)
//   FEE_RATE           sat/vB (default 2)
//   MEMPOOL_URL        signet mempool base (default https://mempool.space/signet/api)
//   SKIP_SPEND         set =1 to stop after Phase 4 (Alice detects);
//                      useful for iterative debug

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import {
  encodeStealthAddress, decodeStealthAddress,
  senderComputeStealthCommit, recipientScanTxForStealth,
  p2wpkhScript, matchesCommit,
  deriveEcdhBlinding, computeCommit, computeTweakedSk,
  DOMAIN_CXFER_STEALTH,
} from './stealth-primitives.mjs';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', '.local');
const STATE_FILE = path.join(STATE_DIR, 'stealth-signet-state.json');
const ALICE_FILE = path.join(STATE_DIR, 'stealth-signet-alice.json');
const BOB_FILE   = path.join(STATE_DIR, 'stealth-signet-bob.json');

const STEALTH_AMOUNT = Number(process.env.STEALTH_AMOUNT || 5000);
const FEE_RATE       = Number(process.env.FEE_RATE || 2);
const MEMPOOL_URL    = process.env.MEMPOOL_URL || 'https://mempool.space/signet/api';
const SKIP_SPEND     = process.env.SKIP_SPEND === '1';
const DUST           = 546;

if (!existsSync(ALICE_FILE) || !existsSync(BOB_FILE)) {
  console.error(`✗ Wallets not found. Run: node tests/gen-stealth-signet-wallets.mjs`);
  process.exit(1);
}
const ALICE = JSON.parse(readFileSync(ALICE_FILE, 'utf8'));
const BOB   = JSON.parse(readFileSync(BOB_FILE, 'utf8'));

const alicePriv = hexToBytes(ALICE.priv_hex);
const alicePub  = hexToBytes(ALICE.pub_hex);
const bobPriv   = hexToBytes(BOB.priv_hex);
const bobPub    = hexToBytes(BOB.pub_hex);

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function step(n, msg) { console.log(`\n--- Phase ${n}: ${msg} ---`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// =============================================================================
//                              Mempool API
// =============================================================================

async function getUtxos(address) {
  const r = await fetch(`${MEMPOOL_URL}/address/${address}/utxo`);
  if (!r.ok) fail(`mempool utxo fetch ${r.status}: ${address}`);
  return await r.json();
}

async function broadcast(hex) {
  const r = await fetch(`${MEMPOOL_URL}/tx`, {
    method: 'POST', body: hex,
    headers: { 'Content-Type': 'text/plain' },
  });
  const body = await r.text();
  if (!r.ok) fail(`broadcast ${r.status}: ${body}`);
  return body.trim();
}

async function getTx(txid) {
  const r = await fetch(`${MEMPOOL_URL}/tx/${txid}`);
  if (!r.ok) return null;
  return await r.json();
}

async function waitForConfirm(txid, timeoutMs = 600_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await getTx(txid);
    if (t?.status?.confirmed) return t;
    await sleep(5000);
    process.stdout.write('.');
  }
  fail(`timeout waiting for ${txid} to confirm`);
}

async function getTxRaw(txid) {
  const r = await fetch(`${MEMPOOL_URL}/tx/${txid}/hex`);
  if (!r.ok) fail(`tx hex fetch ${r.status}: ${txid}`);
  return (await r.text()).trim();
}

// =============================================================================
//                          Bitcoin tx construction
// =============================================================================
//
// Minimal BIP-143 segwit-v0 tx builder. P2WPKH inputs only; P2WPKH outputs.
// All inputs SIGHASH_ALL. Single-input for simplicity; can extend.

const TXID_BYTES = (h) => {
  const b = hexToBytes(h);
  const r = new Uint8Array(32);
  for (let i = 0; i < 32; i++) r[i] = b[31 - i];
  return r;
};

function _ser_u8(n) { return new Uint8Array([n & 0xff]); }
function _ser_u16le(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
function _ser_u32le(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
function _ser_u64le(n) {
  const b = new Uint8Array(8);
  const big = BigInt(n);
  new DataView(b.buffer).setUint32(0, Number(big & 0xffffffffn), true);
  new DataView(b.buffer).setUint32(4, Number((big >> 32n) & 0xffffffffn), true);
  return b;
}
function _varint(n) {
  if (n < 0xfd) return _ser_u8(n);
  if (n <= 0xffff) return concatBytes(_ser_u8(0xfd), _ser_u16le(n));
  if (n <= 0xffffffff) return concatBytes(_ser_u8(0xfe), _ser_u32le(n));
  return concatBytes(_ser_u8(0xff), _ser_u64le(n));
}

function bip143Sighash({ tx, inputIndex, prevoutScript, prevoutValue }) {
  // BIP-143 segwit-v0 sighash for SIGHASH_ALL.
  const hashPrevouts = sha256(sha256(concatBytes(
    ...tx.inputs.flatMap(i => [TXID_BYTES(i.txid), _ser_u32le(i.vout)]),
  )));
  const hashSequence = sha256(sha256(concatBytes(
    ...tx.inputs.map(i => _ser_u32le(i.sequence)),
  )));
  const hashOutputs = sha256(sha256(concatBytes(
    ...tx.outputs.flatMap(o => [_ser_u64le(o.value), _varint(o.script.length), o.script]),
  )));
  const inp = tx.inputs[inputIndex];
  // scriptCode = OP_DUP OP_HASH160 <20-byte program> OP_EQUALVERIFY OP_CHECKSIG
  // for P2WPKH, derived from the prevout's hash160(pubkey).
  const program = prevoutScript.slice(2);  // strip 0x00 0x14
  const scriptCode = concatBytes(
    new Uint8Array([0x76, 0xa9, 0x14]), program, new Uint8Array([0x88, 0xac]),
  );
  const preimage = concatBytes(
    _ser_u32le(tx.version),
    hashPrevouts,
    hashSequence,
    TXID_BYTES(inp.txid),
    _ser_u32le(inp.vout),
    _varint(scriptCode.length), scriptCode,
    _ser_u64le(prevoutValue),
    _ser_u32le(inp.sequence),
    hashOutputs,
    _ser_u32le(tx.locktime),
    _ser_u32le(1),  // SIGHASH_ALL
  );
  return sha256(sha256(preimage));
}

function ecdsaSign(msgHash32, priv32) {
  // Deterministic ECDSA per RFC-6979 with low-S enforcement.
  const sig = secp.sign(msgHash32, priv32, { lowS: true });
  return sig.toDERRawBytes();
}

function signP2wpkhInput({ tx, inputIndex, prevoutScript, prevoutValue, priv, pub }) {
  const sh = bip143Sighash({ tx, inputIndex, prevoutScript, prevoutValue });
  const der = ecdsaSign(sh, priv);
  const sigBytes = concatBytes(der, new Uint8Array([0x01]));  // SIGHASH_ALL
  return [sigBytes, pub];  // witness: <sig> <pubkey>
}

function serializeTx(tx) {
  const parts = [_ser_u32le(tx.version)];
  // Segwit marker + flag
  const hasWitness = tx.inputs.some(i => i.witness && i.witness.length > 0);
  if (hasWitness) parts.push(new Uint8Array([0x00, 0x01]));
  parts.push(_varint(tx.inputs.length));
  for (const i of tx.inputs) {
    parts.push(TXID_BYTES(i.txid));
    parts.push(_ser_u32le(i.vout));
    parts.push(_varint(0));  // empty scriptSig
    parts.push(_ser_u32le(i.sequence));
  }
  parts.push(_varint(tx.outputs.length));
  for (const o of tx.outputs) {
    parts.push(_ser_u64le(o.value));
    parts.push(_varint(o.script.length));
    parts.push(o.script);
  }
  if (hasWitness) {
    for (const i of tx.inputs) {
      const w = i.witness || [];
      parts.push(_varint(w.length));
      for (const item of w) {
        parts.push(_varint(item.length));
        parts.push(item);
      }
    }
  }
  parts.push(_ser_u32le(tx.locktime));
  return concatBytes(...parts);
}

function txid(tx) {
  // Strip witness for txid computation.
  const stripped = { ...tx, inputs: tx.inputs.map(i => ({ ...i, witness: [] })) };
  // Manual non-witness serialization
  const parts = [_ser_u32le(tx.version), _varint(tx.inputs.length)];
  for (const i of tx.inputs) {
    parts.push(TXID_BYTES(i.txid));
    parts.push(_ser_u32le(i.vout));
    parts.push(_varint(0));
    parts.push(_ser_u32le(i.sequence));
  }
  parts.push(_varint(tx.outputs.length));
  for (const o of tx.outputs) {
    parts.push(_ser_u64le(o.value));
    parts.push(_varint(o.script.length));
    parts.push(o.script);
  }
  parts.push(_ser_u32le(tx.locktime));
  const ser = concatBytes(...parts);
  const h = sha256(sha256(ser));
  // txid is reverse-byte-order
  const r = new Uint8Array(32);
  for (let i = 0; i < 32; i++) r[i] = h[31 - i];
  return bytesToHex(r);
}

// =============================================================================
//                            The actual test phases
// =============================================================================

console.log(`\n=== Stealth signet round-trip ===\n`);
console.log(`  Alice (recipient): ${ALICE.address}`);
console.log(`  Alice stealth:     ${ALICE.stealth_address}`);
console.log(`  Bob   (sender):    ${BOB.address}`);
console.log(`  stealth amount:    ${STEALTH_AMOUNT} sats`);
console.log(`  fee rate:          ${FEE_RATE} sat/vB`);

const state = loadState();

// ---- Phase 1: pre-flight ----
step(1, 'pre-flight (Bob has signet sats)');
const bobUtxos = await getUtxos(BOB.address);
const bobSats = bobUtxos.reduce((s, u) => s + u.value, 0);
info(`Bob balance: ${bobSats.toLocaleString()} sats across ${bobUtxos.length} UTXO(s)`);
if (bobSats < STEALTH_AMOUNT + 5000) {
  fail(`Bob underfunded. Top up at https://signet.bublina.eu.org/ → ${BOB.address}`);
}
ok(`pre-flight passed`);

// ---- Phase 2: Bob sends stealth payment to Alice ----
step(2, 'Bob emits stealth-shaped tx to Alice');
let sendTxid;
if (state.sendTxid) {
  sendTxid = state.sendTxid;
  ok(`reusing send txid from prior run: ${sendTxid}`);
} else {
  // Decode Alice's stealth address.
  const decoded = decodeStealthAddress(ALICE.stealth_address);
  if (decoded.mode !== 'single') fail(`expected single-mode address`);
  info(`decoded Alice's stealth address: ${decoded.mode}, ${bytesToHex(decoded.recipientPub).slice(0,16)}…`);

  // Pick a Bob UTXO to spend.
  const utxo = bobUtxos.sort((a, b) => b.value - a.value)[0];
  info(`Bob spending UTXO: ${utxo.txid.slice(0,16)}…:${utxo.vout} (${utxo.value} sats)`);

  // tx_anchor_head per §C anchor registry = vin[0].outpoint = txid(32) || vout(4 LE)
  const txAnchorHead = concatBytes(
    TXID_BYTES(utxo.txid).slice().reverse() === undefined ? hexToBytes(utxo.txid) : hexToBytes(utxo.txid), // big-endian txid bytes for anchor (deterministic; canonical choice; recipient uses same)
    _ser_u32le(utxo.vout),
  );

  // Sender computes commit for vout[0] (the stealth output).
  const voutIndex = 0;
  const { commit } = senderComputeStealthCommit({
    senderEligibleInputPrivs: [bobPriv],
    recipientPub: decoded.recipientPub,
    networkTag: 'signet',
    domain: DOMAIN_CXFER_STEALTH,
    txAnchorHead,
    voutIndex,
  });
  info(`stealth commit (vout[0]): ${bytesToHex(commit).slice(0,16)}…`);
  info(`stealth output script: P2WPKH(hash160(commit))`);

  // Build the tx.
  const feeBytesEstimate = 110 + 32 + 32;  // ~rough p2wpkh + 2 outputs
  const fee = feeBytesEstimate * FEE_RATE;
  const changeValue = utxo.value - STEALTH_AMOUNT - fee;
  if (changeValue < DUST) fail(`change ${changeValue} below dust; pick larger input`);

  const tx = {
    version: 2,
    locktime: 0,
    inputs: [{ txid: utxo.txid, vout: utxo.vout, sequence: 0xfffffffd, witness: [] }],
    outputs: [
      { value: STEALTH_AMOUNT, script: p2wpkhScript(commit) },            // stealth output to Alice
      { value: changeValue,    script: p2wpkhScript(bobPub) },            // Bob's change
    ],
  };

  // Sign vin[0] under Bob's P2WPKH.
  const bobScript = p2wpkhScript(bobPub);
  tx.inputs[0].witness = signP2wpkhInput({
    tx, inputIndex: 0, prevoutScript: bobScript, prevoutValue: utxo.value,
    priv: bobPriv, pub: bobPub,
  });

  const hex = bytesToHex(serializeTx(tx));
  const computedTxid = txid(tx);
  info(`tx serialized: ${hex.length / 2} bytes, txid: ${computedTxid}`);

  info(`broadcasting…`);
  sendTxid = await broadcast(hex);
  ok(`broadcasted: ${sendTxid}`);

  state.sendTxid = sendTxid;
  state.sendVout = voutIndex;
  state.sendCommitHex = bytesToHex(commit);
  state.sendAmount = STEALTH_AMOUNT;
  state.sendInputTxid = utxo.txid;
  state.sendInputVout = utxo.vout;
  state.sendInputValue = utxo.value;
  saveState(state);
}

// ---- Phase 3: Wait for send confirmation ----
step(3, 'wait for send tx confirmation');
if (state.sendConfirmedHeight) {
  ok(`already confirmed at height ${state.sendConfirmedHeight}`);
} else {
  info(`polling ${sendTxid}…`);
  const t = await waitForConfirm(sendTxid);
  console.log();
  ok(`confirmed at height ${t.status.block_height}`);
  state.sendConfirmedHeight = t.status.block_height;
  saveState(state);
}

// ---- Phase 4: Alice scans and detects the stealth receipt ----
step(4, "Alice's scanner detects the stealth receipt");
// Alice fetches the send tx and runs the recipient scan.
const sendTxJson = await getTx(sendTxid);
if (!sendTxJson) fail(`could not fetch send tx`);

// Build a `tx` object matching the shape recipientScanTxForStealth expects.
// Inputs: extract pubkey from each P2WPKH witness.
const scanTx = {
  inputs: sendTxJson.vin.map(v => {
    // P2WPKH witness: [sig, pubkey(33)]. We need the pubkey.
    const witness = v.witness || [];
    let kind = 'unknown', pub = null;
    if (witness.length === 2 && witness[1].length === 66) {  // 33 bytes hex = 66 chars
      kind = 'p2wpkh';
      pub = hexToBytes(witness[1]);
    }
    return { kind, pub };
  }),
  outputs: sendTxJson.vout.map(o => ({
    script: hexToBytes(o.scriptpubkey),
  })),
};

// Recompute tx_anchor_head from the send tx's vin[0].outpoint.
const inp0 = sendTxJson.vin[0];
const txAnchorHead = concatBytes(
  hexToBytes(inp0.txid),
  _ser_u32le(inp0.vout),
);

const credits = recipientScanTxForStealth({
  tx: scanTx,
  walletPriv: alicePriv,
  walletPub: alicePub,
  networkTag: 'signet',
  domain: DOMAIN_CXFER_STEALTH,
  txAnchorHead,
});

info(`scanner ran over ${scanTx.outputs.length} output(s); found ${credits.length} stealth credit(s)`);
if (credits.length === 0) {
  fail(`Alice's scanner did NOT detect the stealth receipt — math mismatch?`);
}
const c = credits[0];
ok(`detected stealth output at vout[${c.voutIndex}], script_kind=${c.scriptKind}`);
info(`tweaked_sk (Alice spending key): ${bytesToHex(c.tweakedSk).slice(0,16)}…`);

// Verify the tweaked_sk · G == commit
const derivedPub = secp.getPublicKey(c.tweakedSk, true);
if (bytesToHex(derivedPub) !== bytesToHex(c.commit)) {
  fail(`tweaked_sk does not derive to commit — derivation bug`);
}
ok(`tweaked_sk · G == commit (Alice can spend)`);

state.stealthUtxoTxid = sendTxid;
state.stealthUtxoVout = c.voutIndex;
state.stealthUtxoValue = STEALTH_AMOUNT;
state.stealthTweakedSkHex = bytesToHex(c.tweakedSk);
state.stealthCommitHex = bytesToHex(c.commit);
saveState(state);

if (SKIP_SPEND) {
  console.log(`\n=== Stopped after Phase 4 (SKIP_SPEND=1) ===`);
  console.log(`  Stealth UTXO: ${sendTxid}:${c.voutIndex}`);
  console.log(`  Value: ${STEALTH_AMOUNT} sats`);
  console.log(`  Alice's tweaked_sk: ${bytesToHex(c.tweakedSk).slice(0,16)}…`);
  process.exit(0);
}

// ---- Phase 5: Alice spends the stealth UTXO ----
step(5, "Alice spends the stealth UTXO back to Bob's classical address");
let spendTxid;
if (state.spendTxid) {
  spendTxid = state.spendTxid;
  ok(`reusing spend txid from prior run: ${spendTxid}`);
} else {
  const commit = hexToBytes(state.stealthCommitHex);
  const tweakedSk = hexToBytes(state.stealthTweakedSkHex);

  const fee = 110 * FEE_RATE;  // ~110 vB for 1-in 1-out P2WPKH
  const spendValue = STEALTH_AMOUNT - fee;
  if (spendValue < DUST) fail(`spend value below dust after fee`);

  const tx = {
    version: 2,
    locktime: 0,
    inputs: [{ txid: sendTxid, vout: c.voutIndex, sequence: 0xfffffffd, witness: [] }],
    outputs: [
      { value: spendValue, script: p2wpkhScript(bobPub) },  // sent to Bob's classical
    ],
  };

  // The stealth UTXO sits at P2WPKH(hash160(commit_compressed)).
  // Alice spends it using tweaked_sk + commit as the pubkey in the witness.
  const stealthPrevoutScript = p2wpkhScript(commit);
  tx.inputs[0].witness = signP2wpkhInput({
    tx, inputIndex: 0, prevoutScript: stealthPrevoutScript, prevoutValue: STEALTH_AMOUNT,
    priv: tweakedSk, pub: commit,
  });

  const hex = bytesToHex(serializeTx(tx));
  spendTxid = txid(tx);
  info(`spend tx: ${hex.length / 2} bytes, txid: ${spendTxid}`);
  info(`broadcasting…`);
  await broadcast(hex);
  ok(`broadcasted: ${spendTxid}`);

  state.spendTxid = spendTxid;
  state.spendValue = spendValue;
  saveState(state);
}

// ---- Phase 6: Wait for spend confirmation ----
step(6, 'wait for spend tx confirmation');
if (state.spendConfirmedHeight) {
  ok(`already confirmed at height ${state.spendConfirmedHeight}`);
} else {
  info(`polling ${spendTxid}…`);
  const t = await waitForConfirm(spendTxid);
  console.log();
  ok(`confirmed at height ${t.status.block_height}`);
  state.spendConfirmedHeight = t.status.block_height;
  saveState(state);
}

// ---- Phase 7: Verify ----
step(7, 'verify Bob received the spend');
const finalUtxos = await getUtxos(BOB.address);
const got = finalUtxos.find(u => u.txid === spendTxid && u.vout === 0);
if (!got) {
  fail(`spend tx output not found at Bob's address — something went wrong`);
}
ok(`Bob received ${got.value} sats at ${BOB.address} via the stealth-routed spend`);

console.log(`\n=== Stealth round-trip PASSED ===\n`);
console.log(`  Send tx (Bob → Alice stealth):  ${sendTxid}`);
console.log(`  Spend tx (Alice → Bob):         ${spendTxid}`);
console.log(`  Stealth UTXO value:             ${STEALTH_AMOUNT} sats`);
console.log(`  Recovered (after fees):         ${state.spendValue} sats`);
console.log();
console.log(`  Verified:`);
console.log(`    1. Sender emitted stealth-shaped output at P2WPKH(hash160(commit))`);
console.log(`    2. Recipient scanner detected without prior coordination`);
console.log(`    3. ECDH symmetry: sender + recipient landed on same blinding`);
console.log(`    4. tweaked_sk = recipient_priv + blinding spends the output via standard P2WPKH`);
console.log(`    5. End-to-end on signet — no protocol changes required`);
console.log();
