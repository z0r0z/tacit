// Bitcoin-native shielded pool on signet with real transactions (DESIGN-btc-shielded-pool.md §2–§5).
//
//   node tests/btc-pool-e2e-signet.mjs [etch|split|shield|pay|exit|all]   (default: all, resumable)
//
// Stages: etch a demo asset → T_CXFER 50,000 units to Alice's transparent key → T_BTC_SHIELD that note
// into Alice's pool address → T_BTC_SPEND pay Alice→Bob (change and padding to Alice's internal address)
// → T_BTC_SPEND exit Bob's note to a fresh exit key derived from his pool seed.
// pay/exit need the pool indexer (BTC_POOL_API, default http://localhost:8787) for leaf index, root and
// path, and a proof from the separate prover: set PROOF_FILE to its {"proof": "0x.."} output.
//
// Env: BTC_POOL_API, PROOF_FILE, STATE_FILE, H_ANCHOR / LEAF_INDEX (overrides), NO_WAIT=1 (skip
// confirmation waits), CONFIRM_TIMEOUT_MIN (default 60).
import { JSDOM } from 'jsdom';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { makeBtcShieldedPool } from '../dapp/btc-shielded-pool.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

const STATE_FILE = process.env.STATE_FILE || path.join(os.homedir(), '.tacit-validation', 'btc-pool-signet-state.json');
const WALLET_FILE = '/Users/z/.tacit-validation/signet.json';
const MEMPOOL = 'https://mempool.space/signet/api';
const POOL_API = (process.env.BTC_POOL_API || 'http://localhost:8787').replace(/\/$/, '');
const NO_WAIT = process.env.NO_WAIT === '1';
const CONFIRM_TIMEOUT_MS = Number(process.env.CONFIRM_TIMEOUT_MIN || 60) * 60_000;

const TICKER = 'PSAT';
const SUPPLY = 21_000_000n;
const SPLIT_AMOUNT = 50_000n;
const PAY_TO_BOB = 30_000n;

const W = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
if (W.network !== 'signet' || !/^tb1q/.test(W.address)) throw new Error('funding wallet must be a signet P2WPKH');
const PRIV = hexToBytes(W.priv_hex);
const PUB = secp.getPublicKey(PRIV, true);
if (bytesToHex(PUB) !== String(W.pub_hex).toLowerCase()) throw new Error('funding wallet pub_hex does not match its key');

const dapp = await import('../dapp/tacit.js');
const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });
try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(PUB), '1'); } catch {}
dapp.wallet.priv = PRIV;
dapp.wallet.pub = PUB;

const log = (m) => console.log(`  ${m}`);
const link = (txid) => `https://mempool.space/signet/tx/${txid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const te = new TextEncoder();
const N = secp.CURVE.n;
const loadState = () => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { mkdirSync(path.dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2), { mode: 0o600 }); };
const state = loadState();
if (!state.demoSeed) { state.demoSeed = bytesToHex(crypto.getRandomValues(new Uint8Array(32))); state.derivation = 2; saveState(state); }
if (state.derivation !== 2) {
  if (state.shield) throw new Error(`${STATE_FILE} was made with the earlier wallet derivation; set a new STATE_FILE`);
  state.derivation = 2; saveState(state);
}

// Demo identities, all from DEMO_SEED: Alice/Bob pool wallets and Alice's transparent P2WPKH key.
const sub = (label) => sha256(concatBytes(te.encode('tacit-btc-pool-e2e:' + label + ':'), hexToBytes(state.demoSeed)));
const scalarKey = (label) => { const x = BigInt('0x' + bytesToHex(sub(label))) % N; return hexToBytes(x.toString(16).padStart(64, '0')); };
const alice = pool.walletFromSeed(sub('alice-pool'), 'signet');
const bob = pool.walletFromSeed(sub('bob-pool'), 'signet');
const aliceT = { priv: scalarKey('alice-transparent') }; aliceT.pub = secp.getPublicKey(aliceT.priv, true);
const wpkh = (pub) => concatBytes(new Uint8Array([0x00, 0x14]), dapp.hash160(pub));
const WALLET_SPK = wpkh(PUB);

async function mempoolJson(p) {
  const r = await fetch(MEMPOOL + p);
  if (!r.ok) throw new Error(`mempool ${p}: HTTP ${r.status}`);
  return r.json();
}
async function waitConfirmed(txid, label) {
  if (NO_WAIT) { log(`(NO_WAIT) not waiting for ${label}`); return null; }
  const t0 = Date.now();
  for (;;) {
    try {
      const s = await mempoolJson(`/tx/${txid}/status`);
      if (s.confirmed) { log(`${label} confirmed in block ${s.block_height}`); return s.block_height; }
    } catch { /* not yet visible */ }
    if (Date.now() - t0 > CONFIRM_TIMEOUT_MS) throw new Error(`${label} ${txid} not confirmed after ${CONFIRM_TIMEOUT_MS / 60000} min; re-run to resume`);
    await sleep(30_000);
  }
}
const pointXY = (compressed) => { const a = secp.ProjectivePoint.fromHex(bytesToHex(compressed)).toAffine(); return { cx: '0x' + a.x.toString(16).padStart(64, '0'), cy: '0x' + a.y.toString(16).padStart(64, '0') }; };

// Standard Tacit commit/reveal carrier: vin[0] spends the envelope commit, vin[1..] are extra inputs.
async function broadcastCarrier({ payload, extraInputs = [], outputs }) {
  const envelopeScript = dapp.encodeEnvelopeScript(dapp.wallet.xonly(), payload);
  const { Q_xonly, parity } = dapp.tweakedOutputKey(dapp.TAP_NUMS, dapp.tapLeafHash(envelopeScript));
  const commitSpk = dapp.p2trScript(Q_xonly);
  const cb = dapp.controlBlock(dapp.TAP_NUMS, parity);

  const lenPush = envelopeScript.length < 0xfd ? 1 : 3;
  const witnessLen = 1 + 65 + lenPush + envelopeScript.length + 1 + 33 + extraInputs.length * 108;
  const baseLen = 4 + 1 + 41 * (1 + extraInputs.length) + 1 + outputs.reduce((s, o) => s + 9 + o.script.length, 0) + 4;
  const revealVb = Math.ceil((baseLen * 4 + 2 + witnessLen) / 4) + 5;
  const feeRate = await dapp.getFeeRate();
  const revealFee = dapp.feeFor(revealVb, feeRate);
  const outSum = outputs.reduce((s, o) => s + o.value, 0);
  const extraSum = extraInputs.reduce((s, i) => s + i.value, 0);
  const commitValue = Math.max(dapp.DUST, outSum + revealFee - extraSum);

  const avoid = new Set([...(state.reserved || []), ...extraInputs.map((i) => `${i.txid}:${i.vout}`)]);
  const utxos = (await dapp.getUtxos(W.address)).filter((u) => u.value > dapp.DUST && !avoid.has(`${u.txid}:${u.vout}`)).sort((a, b) => b.value - a.value);
  const picked = []; let total = 0, commitFee = 0;
  for (const u of utxos) {
    picked.push(u); total += u.value;
    commitFee = dapp.feeFor(dapp.estCommitVb(picked.length), feeRate);
    if (total >= commitValue + commitFee + dapp.DUST) break;
  }
  if (total < commitValue + commitFee) throw new Error(`insufficient signet sats: need ${commitValue + commitFee}, have ${total}`);
  const change = total - commitValue - commitFee;
  const commitTx = {
    version: 2, locktime: 0,
    inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: [{ value: commitValue, script: commitSpk }, ...(change >= dapp.DUST ? [{ value: change, script: WALLET_SPK }] : [])],
  };
  for (let i = 0; i < picked.length; i++) commitTx.inputs[i].witness = dapp.signP2wpkhInput(commitTx, i, picked[i].value);
  const commitTxid = dapp.txid(commitTx);

  const revealTx = {
    version: 2, locktime: 0,
    inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }, ...extraInputs.map((i) => ({ txid: i.txid, vout: i.vout, sequence: 0xfffffffd, witness: [] }))],
    outputs,
  };
  const prevouts = [{ value: commitValue, script: commitSpk }, ...extraInputs.map((i) => ({ value: i.value, script: wpkh(i.pub) }))];
  revealTx.inputs[0].witness = dapp.signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
  extraInputs.forEach((i, j) => { revealTx.inputs[1 + j].witness = dapp.signP2wpkhInputWithKey(revealTx, 1 + j, i.value, i.priv, i.pub); });
  const revealTxid = dapp.txid(revealTx);

  await dapp.broadcast(bytesToHex(dapp.serializeTx(commitTx)));
  log(`commit ${link(commitTxid)}`);
  await dapp.broadcastWithRetry(bytesToHex(dapp.serializeTx(revealTx)));
  log(`reveal ${link(revealTxid)}`);
  return { commitTxid, revealTxid, revealFee, commitFee };
}

// ── pool indexer API ──
async function poolGet(p) {
  let r;
  try { r = await fetch(POOL_API + p); } catch (e) { throw new Error(`pool indexer unreachable at ${POOL_API} (start worker-relay/src/btc-pool-indexer.js or set BTC_POOL_API): ${e.cause?.code || e.message}`); }
  if (!r.ok) throw new Error(`${POOL_API}${p}: HTTP ${r.status}`);
  return r.json();
}
async function findLeafIndex(leaf, envKey) {
  if (process.env[envKey] != null) return Number(process.env[envKey]);
  const want = leaf.toLowerCase();
  for (let from = 0, guard = 0; guard < 1000; guard++) {
    const j = await poolGet(`/btc-pool/notes?from=${from}`);
    const list = Array.isArray(j) ? j : (j.notes || j.items || []);
    for (const x of list) {
      if (String(x.leaf || '').toLowerCase().replace(/^(0x)?/, '0x') === want) return Number(x.leaf_index ?? x.leafIndex ?? x.index);
    }
    const next = j.next ?? j.next_from ?? j.cursor ?? null;
    if (next == null || !list.length) break;
    from = Number(next);
  }
  throw new Error(`leaf ${leaf} not in ${POOL_API}/btc-pool/notes yet (indexed after confirmation); or set ${envKey}`);
}
async function fetchPath(leafIndex) {
  const j = await poolGet(`/btc-pool/path/${leafIndex}`);
  const p = j.path || j.siblings;
  if (!j.root || !Array.isArray(p) || p.length !== 32) throw new Error(`unexpected /btc-pool/path response: ${JSON.stringify(j).slice(0, 300)}`);
  let hAnchor = process.env.H_ANCHOR != null ? Number(process.env.H_ANCHOR) : (j.height ?? j.h_anchor ?? j.anchor_height ?? j.root_height ?? j.block_height);
  if (hAnchor == null) {
    try { const r = await poolGet('/btc-pool/root'); hAnchor = r.height ?? r.h_anchor ?? r.block_height; if (r.root && r.root.toLowerCase() !== j.root.toLowerCase()) hAnchor = null; } catch { /* no root route */ }
  }
  if (hAnchor == null) throw new Error('indexer did not report the height of the root; set H_ANCHOR');
  return { root: j.root, path: p, hAnchor: Number(hAnchor) };
}
function readProof(stage) {
  const f = process.env[`${stage.toUpperCase()}_PROOF_FILE`] || process.env.PROOF_FILE;
  if (!f || !existsSync(f)) return null;
  const j = JSON.parse(readFileSync(f, 'utf8'));
  const proof = j.proof || j.proof_hex || j.bytes;
  if (!proof) throw new Error(`${f} has no "proof" field`);
  return proof;
}
function witnessFile(stage) { return path.join(path.dirname(STATE_FILE), `btc-pool-${stage}-witness.json`); }

// ── stages ──
async function stageEtch() {
  console.log('\n--- etch ---');
  if (state.etch?.revealTxid) { log(`asset ${state.etch.assetId} (${link(state.etch.revealTxid)})`); }
  else {
    const r = await dapp.buildAndBroadcastCEtch({ ticker: TICKER, supplyBase: SUPPLY, decimals: 0, mintable: false });
    const raw = hexToBytes(r.commitHex);
    let p = 4; if (raw[4] === 0 && raw[5] === 1) p = 6;
    const anchor = raw.slice(p + 1, p + 1 + 36);
    const blinding = dapp.deriveEtchBlinding(PRIV, anchor);
    state.etch = { commitTxid: r.commitTxid, revealTxid: r.revealTxid, assetId: r.assetIdHex, supply: SUPPLY, blinding: '0x' + blinding.toString(16).padStart(64, '0') };
    saveState(state);
    log(`commit ${link(r.commitTxid)}`);
    log(`reveal ${link(r.revealTxid)}  asset ${r.assetIdHex}`);
  }
  if (!state.etch.confirmed) { state.etch.confirmed = await waitConfirmed(state.etch.revealTxid, 'etch') ?? false; saveState(state); }
  const tx = await mempoolJson(`/tx/${state.etch.revealTxid}`);
  const env = dapp.decodeEnvelopeScript(hexToBytes(tx.vin[0].witness[1]));
  const L = env.payload[1];
  const C = env.payload.slice(3 + L, 3 + L + 33);
  if (bytesToHex(dapp.pedersenCommit(SUPPLY, BigInt(state.etch.blinding)).toRawBytes(true)) !== bytesToHex(C)) throw new Error('etch opening does not match the on-chain commitment');
  log('etch opening matches the on-chain commitment');
}

async function stageSplit() {
  console.log('\n--- split ---');
  if (state.split?.revealTxid) { log(`Alice's note ${state.split.revealTxid}:0 (${link(state.split.revealTxid)})`); }
  else {
    const r = await dapp.buildAndBroadcastCXfer({
      assetIdHex: state.etch.assetId,
      recipientPubHex: bytesToHex(aliceT.pub),
      amount: SPLIT_AMOUNT,
      forceUtxos: [{ utxo: { txid: state.etch.revealTxid, vout: 0, value: (await mempoolJson(`/tx/${state.etch.revealTxid}`)).vout[0].value }, amount: SUPPLY, blinding: BigInt(state.etch.blinding) }],
    });
    const C = r.revealCommitmentRecipient;
    const { cx, cy } = pointXY(C);
    const check = pool.commitXY(SPLIT_AMOUNT, BigInt(r.recipBlinding));
    if (check.cx !== cx || check.cy !== cy) throw new Error('split recipient opening does not match its commitment');
    state.split = {
      commitTxid: r.commitTxid, revealTxid: r.revealTxid,
      note: { txid: r.revealTxid, vout: 0, value: SPLIT_AMOUNT, blinding: '0x' + BigInt(r.recipBlinding).toString(16).padStart(64, '0'), Cx: cx, Cy: cy },
      change: { txid: r.revealTxid, vout: 1, value: SUPPLY - SPLIT_AMOUNT, blinding: '0x' + BigInt(r.changeBlinding).toString(16).padStart(64, '0') },
    };
    state.reserved = [...new Set([...(state.reserved || []), `${r.revealTxid}:0`, `${r.revealTxid}:1`])];
    saveState(state);
    log(`commit ${link(r.commitTxid)}`);
    log(`reveal ${link(r.revealTxid)}  (${SPLIT_AMOUNT} ${TICKER} → Alice's transparent key at vout 0)`);
  }
  if (!state.split.confirmed) { state.split.confirmed = await waitConfirmed(state.split.revealTxid, 'split') ?? false; saveState(state); }
}

async function stageShield() {
  console.log('\n--- shield ---');
  if (state.shield?.revealTxid) { log(`shield ${link(state.shield.revealTxid)}`); }
  else {
    const input = state.split.note;
    const inputSats = (await mempoolJson(`/tx/${input.txid}`)).vout[input.vout].value;
    const sh = pool.buildShieldEnvelope({
      asset: '0x' + state.etch.assetId,
      inputs: [{ txid: input.txid, vout: input.vout, Cx: input.Cx, Cy: input.Cy, value: BigInt(input.value), blinding: BigInt(input.blinding) }],
      recipientAddress: alice.addressString,
      network: 'signet',
    });
    if (!pool.verifyShield(sh.payload, [{ txid: input.txid, vout: input.vout, Cx: input.Cx, Cy: input.Cy }])) throw new Error('shield kernel self-check failed');
    const r = await broadcastCarrier({
      payload: sh.payload,
      extraInputs: [{ txid: input.txid, vout: input.vout, value: inputSats, priv: aliceT.priv, pub: aliceT.pub }],
      outputs: [{ value: dapp.DUST, script: WALLET_SPK }],
    });
    const { value, blinding, ...fields } = sh.note;
    state.shield = { ...r, payload: sh.payloadHex, note: fields, noteValue: value, noteBlinding: blinding };
    saveState(state);
  }
  const mine = pool.scan(alice, [state.shield.note]);
  if (mine.length !== 1 || mine[0].value !== SPLIT_AMOUNT) throw new Error('Alice does not receive her shield note');
  if (pool.scan(bob, [state.shield.note]).length) throw new Error('Bob should not receive Alice\'s note');
  log(`Alice scans the shield note: ${mine[0].value} ${TICKER}, leaf ${mine[0].leaf}`);
  if (!state.shield.confirmed) { state.shield.confirmed = await waitConfirmed(state.shield.revealTxid, 'shield') ?? false; saveState(state); }
}

async function spendStage(stage, buildArgs, carrierOutputs) {
  const st = state[stage] || (state[stage] = {});
  if (st.revealTxid) { log(`${stage} ${link(st.revealTxid)}`); return true; }
  if (!st.bodyHex) {
    const built = await buildArgs();
    st.bodyHex = built.bodyHex;
    st.nullifiers = built.nullifiers;
    st.outputs = built.outputs;
    st.exit = built.exit;
    st.hAnchor = built.hAnchor;
    writeFileSync(witnessFile(stage), JSON.stringify(built.witness, null, 2), { mode: 0o600 });
    saveState(state);
  }
  log(`witness: ${witnessFile(stage)}`);
  const proof = readProof(stage);
  if (!proof) {
    console.log(`\n  ${stage}: waiting for a proof. Run the btc-pool prover on the witness above, then:`);
    console.log(`    PROOF_FILE=<prover output {"proof": "0x.."}> node tests/btc-pool-e2e-signet.mjs ${stage}`);
    console.log(`  The body is frozen in the state file; the proof must commit abi.encode(1, root, keccak(body)).`);
    console.log(`  h_anchor ${st.hAnchor}: broadcast before block ${st.hAnchor + 145}.`);
    return false;
  }
  const payload = pool.assembleSpendEnvelope(st.bodyHex, proof);
  const r = await broadcastCarrier({ payload, outputs: await carrierOutputs() });
  Object.assign(st, r, { payload: '0x' + bytesToHex(payload) });
  saveState(state);
  st.confirmed = await waitConfirmed(r.revealTxid, stage) ?? false;
  saveState(state);
  return true;
}

async function stagePay() {
  console.log('\n--- pay ---');
  return spendStage('pay', async () => {
    const leafIndex = await findLeafIndex(state.shield.note.leaf, 'LEAF_INDEX');
    const [note] = pool.scan(alice, [{ ...state.shield.note, leafIndex }]);
    const { root, path: p, hAnchor } = await fetchPath(leafIndex);
    log(`Alice's note at leaf ${leafIndex}, root ${root} @ ${hAnchor}`);
    // Alice holds one note, so this first spend after a shield has 1 input; outputs pad to 3.
    const built = pool.buildSpendBody({
      asset: '0x' + state.etch.assetId, hAnchor, root,
      inputs: [{ ...note, path: p }],
      outputs: [{ address: bob.addressString, value: PAY_TO_BOB }],
      wallet: alice,
    });
    const change = pool.scan(alice, built.outputs);
    if (change.reduce((t, x) => t + x.value, 0n) !== SPLIT_AMOUNT - PAY_TO_BOB || !change.every((x) => x.internal)) throw new Error('Alice does not receive her internal change');
    const toBob = pool.scan(bob, built.outputs);
    if (toBob.length !== 1 || toBob[0].value !== PAY_TO_BOB) throw new Error('Bob does not receive the pay output');
    log(`Bob scans the pay body: ${toBob[0].value} ${TICKER}; nf ${built.nullifiers[0]}`);
    return { ...built, hAnchor };
  }, async () => [{ value: dapp.DUST, script: WALLET_SPK }]);
}

async function stageExit() {
  console.log('\n--- exit ---');
  const st = state.exit || (state.exit = {});
  if (!st.exitSpk) { st.exitSpk = pool.freshExitKey(bob, st.usedScripts || []).scriptPubKey; saveState(state); }
  const bobSpk = hexToBytes(st.exitSpk.slice(2));
  return spendStage('exit', async () => {
    const outs = state.pay.outputs.map(({ value, blinding, ...f }) => f);
    const mineOut = outs.find((o) => pool.scan(bob, [o]).length);
    if (!mineOut) throw new Error('Bob cannot find his pay note');
    const leafIndex = await findLeafIndex(mineOut.leaf, 'EXIT_LEAF_INDEX');
    const [note] = pool.scan(bob, [{ ...mineOut, leafIndex }]);
    const { root, path: p, hAnchor } = await fetchPath(leafIndex);
    log(`Bob's note at leaf ${leafIndex}, root ${root} @ ${hAnchor}`);
    const built = pool.buildSpendBody({
      asset: '0x' + state.etch.assetId, hAnchor, root,
      inputs: [{ ...note, path: p }],
      exit: { exitVout: 0, scriptPubKey: bobSpk },
      usedScripts: st.usedScripts || [],
    });
    st.usedScripts = [...new Set([...(st.usedScripts || []), built.exit.destSpkHash])];
    const rec = pool.recoverExit(bob, built.body, [note]);
    if (rec.value !== built.exit.value || rec.blinding !== built.exit.blinding) throw new Error('exit opening does not recover from the seed');
    return { ...built, hAnchor };
  }, async () => [{ value: dapp.DUST, script: bobSpk }]);
}

const STAGES = { etch: stageEtch, split: stageSplit, shield: stageShield, pay: stagePay, exit: stageExit };
const want = process.argv[2] || 'all';
console.log(`=== btc-pool signet e2e (${want}) ===`);
console.log(`  funding ${W.address}`);
console.log(`  alice   ${alice.addressString}`);
console.log(`  bob     ${bob.addressString}`);
console.log(`  state   ${STATE_FILE}`);
if (want === 'all') {
  for (const s of ['etch', 'split', 'shield', 'pay', 'exit']) {
    const r = await STAGES[s]();
    if (r === false) break;
  }
} else {
  if (!STAGES[want]) throw new Error(`unknown stage ${want}`);
  await STAGES[want]();
}
console.log('\n  txids:');
for (const s of ['etch', 'split', 'shield', 'pay', 'exit']) {
  const x = state[s];
  if (x?.revealTxid) console.log(`    ${s.padEnd(6)} commit ${link(x.commitTxid)}\n           reveal ${link(x.revealTxid)}`);
}

process.exit(0);
