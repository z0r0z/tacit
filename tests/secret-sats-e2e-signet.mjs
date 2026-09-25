// Secret Sats end to end on signet with real transactions and real proofs (DESIGN-btc-shielded-pool.md §3–§9,
// carrier binding and payout condition).
//
//   node tests/secret-sats-e2e-signet.mjs [fund|join|pay|exit|report|all]   (default: all, resumable)
//
// fund  the funding wallet sends Alice's transparent key ~20,000 sats, and in a separate transaction funds a
//       fresh relay key with a carrier coin and a bind coin.
// join  buyAndShield: Alice takes one faucet sale and shields its lot in one carrier (vin[0] shield envelope,
//       vin[1]/vout[1] the seller's SIGHASH_SINGLE|ANYONECANPAY lot and payout).
// pay   Alice pays Bob 6,000 units under the wallet defaults (anchor policy, internal change, padding to 3).
//       The relay key posts the carrier; bind names the relay's bind coin, which the carrier spends.
// exit  Bob exits 4,000 units via exitToSats to the funding wallet acting as maker, wanting 2,000 sats to a
//       fresh exit key; the maker validates the offer, builds the carrier with makerCarrierOutputs and pays the
//       want. Bob keeps 2,000 units as an internal change note.
// Every stage is confirmed against the pool indexer (BTC_POOL_API).
//
// Proofs: the btc-pool-prove host, PROVE_MODE=execute first, then network. NETKEY_FILE points to a file holding
// NETWORK_PRIVATE_KEY; it is passed to the prover only through its environment.
//
// Env: BTC_POOL_API, ESPLORA (default blockstream signet), STATE_FILE, NETKEY_FILE, PROVER_BIN, VERIFY_BIN,
// CONFIRM_TIMEOUT_MIN (default 90), FEE_RATE (sat/vB, default 2).
import { JSDOM } from 'jsdom';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { makeBtcShieldedPool, defaultAnchor } from '../dapp/btc-shielded-pool.js';
import { makeBtcPoolZap, makeNoteResolver } from '../dapp/btc-pool-zap.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME_V = path.join(os.homedir(), '.tacit-validation');
const STATE_FILE = process.env.STATE_FILE || path.join(HOME_V, 'secret-sats-e2e-state.json');
const WALLET_FILE = path.join(HOME_V, 'signet.json');
const POOL_API = (process.env.BTC_POOL_API || 'https://tacit-btc-pool.onrender.com').replace(/\/$/, '');
const FAUCET = (process.env.SATS_FAUCET || 'https://tacit-sats-faucet.onrender.com').replace(/\/$/, '');
const ESPLORA = (process.env.ESPLORA || 'https://blockstream.info/signet/api').replace(/\/$/, '');
const PROVER_BIN = process.env.PROVER_BIN || path.join(ROOT, 'contracts/sp1/confidential/btc-pool-host/target/release/btc-pool-prove');
const VERIFY_BIN = process.env.VERIFY_BIN || path.join(ROOT, 'contracts/sp1/confidential/btc-pool-host/target/release/btc-pool-verify');
const NETKEY_FILE = process.env.NETKEY_FILE || null;
const CONFIRM_TIMEOUT_MS = Number(process.env.CONFIRM_TIMEOUT_MIN || 90) * 60_000;

const ASSET = '17619b4c65ad462481b74a59dbd566730a4376f07fb0e6ff8beca216044466c5';
const FUND_ALICE = 20_000;
const RELAY_CARRIER_COIN = 6_000;
const RELAY_BIND_COIN = 1_500;
const MAKER_BIND_COIN = 1_500;
const PAY_TO_BOB = 6_000n;
const EXIT_AMOUNT = 4_000n;
const EXIT_SATS = 2_000n;
const MIN_FUNDING_COIN = 10_000; // funding-wallet coins below this may be Tacit notes; never spent here

// ── headless tacit.js (jsdom), its signet chain reads routed to ESPLORA ──
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
globalThis.__TACIT_BTC_POOL_API__ = POOL_API;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  if (typeof url === 'string' && url.startsWith('https://mempool.space/signet/api')) url = ESPLORA + url.slice('https://mempool.space/signet/api'.length);
  return realFetch(url, opts);
};

const W = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
if (W.network !== 'signet' || !/^tb1q/.test(W.address)) throw new Error('funding wallet must be a signet P2WPKH');
const FUND = { priv: hexToBytes(W.priv_hex) };
FUND.pub = secp.getPublicKey(FUND.priv, true);
if (bytesToHex(FUND.pub) !== String(W.pub_hex).toLowerCase()) throw new Error('funding wallet pub_hex does not match its key');

const dapp = await import('../dapp/tacit.js');
const pool = makeBtcShieldedPool({ secp, keccak256: keccak_256, sha256 });
const zap = makeBtcPoolZap({ secp, sha256, keccak256: keccak_256 });

const log = (m) => console.log(`  ${m}`);
const link = (txid) => `https://mempool.space/signet/tx/${txid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const te = new TextEncoder();
const N = secp.CURVE.n;
const strip = (h) => String(h).replace(/^0x/i, '').toLowerCase();
const jsonOut = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? '0x' + bytesToHex(x) : x), 2);
const loadState = () => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = () => { mkdirSync(path.dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, jsonOut(state), { mode: 0o600 }); };
const state = loadState();
if (!state.demoSeed) { state.demoSeed = bytesToHex(crypto.getRandomValues(new Uint8Array(32))); state.createdAt = new Date().toISOString(); saveState(); }
state.reserved = state.reserved || [];

// ── identities, all from the demo seed ──
const sub = (label) => sha256(concatBytes(te.encode('tacit-secret-sats-e2e:' + label + ':'), hexToBytes(state.demoSeed)));
const keyOf = (label) => {
  const x = BigInt('0x' + bytesToHex(sub(label))) % N;
  const priv = hexToBytes(x.toString(16).padStart(64, '0'));
  const pub = secp.getPublicKey(priv, true);
  return { priv, pub, spk: wpkh(pub) };
};
function wpkh(pub) { return concatBytes(Uint8Array.of(0x00, 0x14), dapp.hash160(pub)); }
FUND.spk = wpkh(FUND.pub);
const alice = pool.walletFromSeed(sub('alice-pool'), 'signet');
const bob = pool.walletFromSeed(sub('bob-pool'), 'signet');
const aliceT = keyOf('alice-transparent');
const relay = keyOf('relay');
const useKey = (k) => { dapp.wallet.priv = k.priv; dapp.wallet.pub = k.pub; try { localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(k.pub), '1'); } catch {} };

// ── esplora ──
async function esplora(p, opts) {
  for (let i = 0; ; i++) {
    try {
      const r = await realFetch(ESPLORA + p, opts);
      const t = await r.text();
      if (!r.ok) { const e = new Error(`esplora ${p}: HTTP ${r.status} ${t.slice(0, 300)}`); e.status = r.status; e.body = t; throw e; }
      return t;
    } catch (e) {
      if (e.status && e.status < 500) throw e;
      if (i >= 4) throw e;
      await sleep(3000 * (i + 1));
    }
  }
}
const esploraJson = async (p) => JSON.parse(await esplora(p));
const scripthash = (spk) => bytesToHex(sha256(spk));
const utxosOf = async (spk) => esploraJson(`/scripthash/${scripthash(spk)}/utxo`);
async function txKnown(txid) { try { await esplora(`/tx/${txid}`); return true; } catch (e) { if (e.status === 404 || e.status === 400) return false; throw e; } }
async function broadcastHex(hex, txid, label) {
  if (await txKnown(txid)) { log(`${label} already broadcast ${link(txid)}`); return; }
  for (let i = 0; ; i++) {
    try {
      const got = (await esplora('/tx', { method: 'POST', body: hex })).trim();
      if (got !== txid) throw new Error(`${label}: broadcast returned ${got}, expected ${txid}`);
      log(`${label} ${link(txid)}`);
      return;
    } catch (e) {
      // A reveal right after its commit can race the commit's propagation.
      if (i < 5 && /missing|orphan|bad-txns-inputs-missingorspent/i.test(e.message) && !/spent/i.test(e.body || '')) { await sleep(5000); continue; }
      throw e;
    }
  }
}
async function waitConfirmed(txid, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const s = await esploraJson(`/tx/${txid}/status`);
      if (s.confirmed) { log(`${label} confirmed in block ${s.block_height}`); return s.block_height; }
    } catch { /* not visible yet */ }
    if (Date.now() - t0 > CONFIRM_TIMEOUT_MS) throw new Error(`${label} ${txid} not confirmed after ${CONFIRM_TIMEOUT_MS / 60000} min; re-run to resume`);
    await sleep(30_000);
  }
}
async function vsizeOf(txid) { const t = await esploraJson(`/tx/${txid}`); return { vsize: Math.ceil(t.weight / 4), weight: t.weight, size: t.size, fee: t.fee }; }

// ── pool indexer ──
async function poolGet(p) {
  for (let i = 0; ; i++) {
    try {
      const r = await realFetch(POOL_API + p);
      const j = await r.json().catch(() => null);
      if (r.status === 503 && i < 10) { await sleep(2000); continue; }
      if (!r.ok) throw Object.assign(new Error(`${POOL_API}${p}: HTTP ${r.status} ${JSON.stringify(j)}`), { status: r.status });
      return j;
    } catch (e) {
      if (e.status && e.status < 500) throw e;
      if (i >= 6) throw e;
      await sleep(5000 * (i + 1));
    }
  }
}
const poolStatus = () => poolGet('/btc-pool/status');
async function allNotes() {
  const out = [];
  for (let from = 0, guard = 0; guard < 1000; guard++) {
    const j = await poolGet(`/btc-pool/notes?from=${from}&limit=1000`);
    for (const x of j.notes) {
      out.push({ leafIndex: x.leafIndex, txid: x.txid, height: x.height, leaf: x.leaf, asset: x.asset, cx: x.Cx, cy: x.Cy, spendKey: x.spend_key, nkPub: x.nk_pub, pkEph: x.pk_eph, ctNote: x.ct_note });
    }
    if (!j.notes.length || j.next === from) break;
    from = j.next;
  }
  return out;
}
async function waitIndexed(height, label) {
  const t0 = Date.now();
  for (;;) {
    const s = await poolStatus();
    if (s.halted) throw new Error(`pool indexer halted: ${JSON.stringify(s.halted)}`);
    if (s.tip != null && s.tip >= height) return s;
    if (Date.now() - t0 > CONFIRM_TIMEOUT_MS) throw new Error(`indexer did not reach ${height} for ${label}`);
    await sleep(20_000);
  }
}
// Waits for the wallet anchor policy to reach the block that added the note; returns the anchor, root and path.
async function anchorAndPath(note, label) {
  const t0 = Date.now();
  for (;;) {
    const s = await poolStatus();
    if (s.halted) throw new Error(`pool indexer halted: ${JSON.stringify(s.halted)}`);
    const hAnchor = defaultAnchor(s.tip);
    if (hAnchor >= note.height) {
      const j = await poolGet(`/btc-pool/path/${note.leafIndex}?at=${hAnchor}`);
      if (j.hAnchor !== hAnchor || strip(j.leaf) !== strip(note.leaf) || j.path.length !== 32) throw new Error(`unexpected path response ${JSON.stringify(j).slice(0, 300)}`);
      if (strip(pool.merkleRootFrom(note.leaf, note.leafIndex, j.path)) !== strip(j.root)) throw new Error('indexer path does not reach its root');
      log(`${label}: tip ${s.tip}, anchor ${hAnchor}, root ${j.root}`);
      return { hAnchor, root: j.root, path: j.path, tip: s.tip };
    }
    if (Date.now() - t0 > 4 * CONFIRM_TIMEOUT_MS) throw new Error(`anchor policy did not reach ${note.height}`);
    log(`${label}: tip ${s.tip}, anchor ${hAnchor} < note block ${note.height}; waiting`);
    await sleep(60_000);
  }
}

// ── transactions ──
// Signet fee estimates swing to tens of sat/vB on an empty mempool; a fixed rate (FEE_RATE) is used instead.
const FEE_RATE = Number(process.env.FEE_RATE || 2);
async function feeRate() { return FEE_RATE; }
const outpointOf = (u) => `${u.txid}:${u.vout}`;
function pickCoins(coins, need, feeFn) {
  const picked = []; let total = 0, fee = 0;
  for (const u of coins) {
    picked.push(u); total += u.value; fee = feeFn(picked.length);
    if (total >= need + fee + dapp.DUST) break;
  }
  if (total < need + fee) throw new Error(`insufficient signet sats: need ${need + fee}, have ${total}`);
  return { picked, total, fee };
}
async function fundingCoins(exclude = []) {
  const skip = new Set([...state.reserved, ...(state.spentByUs || []), ...exclude]);
  return (await utxosOf(FUND.spk)).filter((u) => u.value >= MIN_FUNDING_COIN && !skip.has(outpointOf(u))).sort((a, b) => b.value - a.value);
}
// A plain P2WPKH payment from the funding wallet.
async function fundingSend(outputs) {
  const rate = await feeRate();
  const coins = await fundingCoins();
  const outSum = outputs.reduce((s, o) => s + o.value, 0);
  const vb = (n) => 11 + 68 * n + outputs.reduce((s, o) => s + 9 + o.script.length, 0) + 31;
  const { picked, total, fee } = pickCoins(coins, outSum, (n) => dapp.feeFor(vb(n), rate));
  const change = total - outSum - fee;
  const tx = {
    version: 2, locktime: 0,
    inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: [...outputs, ...(change >= dapp.DUST ? [{ value: change, script: FUND.spk }] : [])],
  };
  picked.forEach((u, i) => { tx.inputs[i].witness = dapp.signP2wpkhInputWithKey(tx, i, u.value, FUND.priv, FUND.pub); });
  state.spentByUs = [...new Set([...(state.spentByUs || []), ...picked.map(outpointOf)])];
  return { txid: dapp.txid(tx), hex: bytesToHex(dapp.serializeTx(tx)) };
}

// Tacit commit/reveal carrier posted by `signer`: vin[0] spends the envelope commit, vin[1..] are extra P2WPKH
// inputs; the commit is funded from the signer's own coins (`coins`).
async function buildCarrier({ signer, coins, payload, extraInputs = [], outputs }) {
  useKey(signer);
  const envelopeScript = dapp.encodeEnvelopeScript(dapp.wallet.xonly(), payload);
  const { Q_xonly, parity } = dapp.tweakedOutputKey(dapp.TAP_NUMS, dapp.tapLeafHash(envelopeScript));
  const commitSpk = dapp.p2trScript(Q_xonly);
  const cb = dapp.controlBlock(dapp.TAP_NUMS, parity);
  const lenPush = envelopeScript.length < 0xfd ? 1 : 3;
  const witnessLen = 1 + 65 + lenPush + envelopeScript.length + 1 + 33 + extraInputs.length * 108;
  const baseLen = 4 + 1 + 41 * (1 + extraInputs.length) + 1 + outputs.reduce((s, o) => s + 9 + o.script.length, 0) + 4;
  const revealVb = Math.ceil((baseLen * 4 + 2 + witnessLen) / 4) + 5;
  const rate = await feeRate();
  const revealFee = dapp.feeFor(revealVb, rate);
  const outSum = outputs.reduce((s, o) => s + o.value, 0);
  const extraSum = extraInputs.reduce((s, i) => s + i.value, 0);
  const commitValue = Math.max(dapp.DUST, outSum + revealFee - extraSum);
  const avoid = new Set(extraInputs.map(outpointOf));
  const { picked, total, fee: commitFee } = pickCoins(coins.filter((u) => !avoid.has(outpointOf(u))), commitValue, (n) => dapp.feeFor(dapp.estCommitVb(n), rate));
  const change = total - commitValue - commitFee;
  const commitTx = {
    version: 2, locktime: 0,
    inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: [{ value: commitValue, script: commitSpk }, ...(change >= dapp.DUST ? [{ value: change, script: signer.spk }] : [])],
  };
  picked.forEach((u, i) => { commitTx.inputs[i].witness = dapp.signP2wpkhInputWithKey(commitTx, i, u.value, signer.priv, signer.pub); });
  state.spentByUs = [...new Set([...(state.spentByUs || []), ...picked.map(outpointOf)])];
  const commitTxid = dapp.txid(commitTx);
  const revealTx = {
    version: 2, locktime: 0,
    inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }, ...extraInputs.map((i) => ({ txid: i.txid, vout: i.vout, sequence: 0xfffffffd, witness: [] }))],
    outputs,
  };
  const prevouts = [{ value: commitValue, script: commitSpk }, ...extraInputs.map((i) => ({ value: i.value, script: wpkh(i.pub) }))];
  revealTx.inputs[0].witness = dapp.signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
  extraInputs.forEach((i, j) => { revealTx.inputs[1 + j].witness = dapp.signP2wpkhInputWithKey(revealTx, 1 + j, i.value, i.priv, i.pub); });
  return {
    commitTxid, commitHex: bytesToHex(dapp.serializeTx(commitTx)),
    revealTxid: dapp.txid(revealTx), revealHex: bytesToHex(dapp.serializeTx(revealTx)),
    commitFee, revealFee,
  };
}
async function broadcastPair(st, label) {
  await broadcastHex(st.commitHex, st.commitTxid, `${label} commit`);
  await broadcastHex(st.revealHex, st.revealTxid, `${label} carrier`);
  st.broadcast = true; saveState();
}

// ── prover ──
function run(bin, input, env) {
  return new Promise((resolve) => {
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const expectedPublicValues = (root, bodyHex) => '0x' + '00'.repeat(31) + '01' + strip(root) + bytesToHex(keccak_256(hexToBytes(strip(bodyHex))));
async function prove(stage, st) {
  const proofFile = path.join(HOME_V, `secret-sats-${stage}-proof.json`);
  if (existsSync(proofFile)) {
    const j = JSON.parse(readFileSync(proofFile, 'utf8'));
    if (j.public_values === expectedPublicValues(st.root, st.bodyHex)) return j;
    throw new Error(`${proofFile} is for another body; move it aside`);
  }
  const witness = readFileSync(st.witnessFile, 'utf8');
  const want = expectedPublicValues(st.root, st.bodyHex);
  if (!st.execute) {
    const t0 = Date.now();
    const r = await run(PROVER_BIN, witness, { PROVE_MODE: 'execute' });
    if (r.code !== 0) throw new Error(`${stage}: execute failed (${r.code}): ${r.err.trim().slice(-800)}`);
    const j = JSON.parse(r.out.trim().split('\n').pop());
    if (j.public_values !== want) throw new Error(`${stage}: execute public values ${j.public_values} != ${want}`);
    st.execute = { cycles: j.cycles, seconds: Math.round((Date.now() - t0) / 1000) };
    saveState();
    log(`${stage}: execute ok, ${j.cycles} cycles, public values match abi.encode(1, root, keccak(body))`);
  }
  if (!NETKEY_FILE || !existsSync(NETKEY_FILE)) throw new Error(`${stage}: execute passed; set NETKEY_FILE for the network proof`);
  const key = readFileSync(NETKEY_FILE, 'utf8').trim();
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    log(`${stage}: network Groth16 proof, attempt ${attempt}`);
    const r = await run(PROVER_BIN, witness, { PROVE_MODE: 'network', NETWORK_PRIVATE_KEY: key, NETWORK_RPC_URL: 'https://rpc.mainnet.succinct.xyz', RUST_LOG: 'warn' });
    if (r.code === 0) {
      const j = JSON.parse(r.out.trim().split('\n').pop());
      if (j.public_values !== want) throw new Error(`${stage}: proof public values ${j.public_values} != ${want}`);
      writeFileSync(proofFile, JSON.stringify(j, null, 2), { mode: 0o600 });
      st.proveSeconds = Math.round((Date.now() - t0) / 1000);
      saveState();
      return j;
    }
    const msg = r.err.replace(new RegExp(key.replace(/^0x/, ''), 'gi'), '<redacted>').trim().slice(-1200);
    if (/guest rejected|witness json|missing|must be/.test(msg) || attempt >= 5) throw new Error(`${stage}: network proving failed (${r.code}): ${msg}`);
    log(`${stage}: prover error, retrying: ${msg.split('\n').slice(-3).join(' | ')}`);
    await sleep(20_000 * attempt);
  }
}

// ── stages ──
async function stageFund() {
  console.log('\n--- fund ---');
  const st = state.fund || (state.fund = {});
  if (!st.alice) {
    const r = await fundingSend([{ value: FUND_ALICE, script: aliceT.spk }, { value: MAKER_BIND_COIN, script: FUND.spk }]);
    st.alice = { ...r, aliceVout: 0, makerBind: { txid: r.txid, vout: 1, value: MAKER_BIND_COIN } };
    state.reserved.push(`${r.txid}:1`);
    saveState();
  }
  await broadcastHex(st.alice.hex, st.alice.txid, 'fund Alice');
  if (!st.relay) {
    // A separate, later transaction: the relay's coins share nothing with Alice's funding.
    const r = await fundingSend([{ value: RELAY_CARRIER_COIN, script: relay.spk }, { value: RELAY_BIND_COIN, script: relay.spk }]);
    st.relay = { ...r, bind: { txid: r.txid, vout: 1, value: RELAY_BIND_COIN } };
    saveState();
  }
  await broadcastHex(st.relay.hex, st.relay.txid, 'fund relay');
  if (!st.aliceHeight) { st.aliceHeight = await waitConfirmed(st.alice.txid, 'fund Alice'); saveState(); }
  if (!st.relayHeight) { st.relayHeight = await waitConfirmed(st.relay.txid, 'fund relay'); saveState(); }
}

async function pickSale() {
  const status = await (await realFetch(`${FAUCET}/faucet/status`)).json();
  if (strip(status.asset_id) !== ASSET) throw new Error(`faucet asset ${status.asset_id} is not ${ASSET}`);
  for (const s of status.open_sales || []) {
    const sp = await esploraJson(`/tx/${s.txid}/outspend/${s.vout}`).catch(() => null);
    if (!sp || sp.spent) continue;
    const sale = await dapp.fetchPreauthSale({ assetIdHex: status.asset_id, saleIdHex: s.sale_id }).catch(() => null);
    if (sale && !sale.expired) return { status, sale };
  }
  throw new Error('no open faucet sale');
}

async function stageJoin() {
  console.log('\n--- join (buy and shield) ---');
  const st = state.join || (state.join = {});
  if (!st.commitHex) {
    const { status, sale } = await pickSale();
    log(`sale ${sale.sale_id}: lot ${sale.asset_outpoint.txid}:${sale.asset_outpoint.vout}, ${sale.asset_opening.amount} units for ${sale.min_price_sats} sats`);
    useKey(aliceT);
    const resolveNote = makeNoteResolver({ validateOutpoint: dapp.validateOutpoint, txOutputEnvelope: dapp.txOutputEnvelope, getParentEnvelopeData: dapp.getParentEnvelopeData, fetchTx: dapp.getTx });
    const utxos = (await utxosOf(aliceT.spk)).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }));
    const r = await zap.buyAndShield({
      tacit: { ...dapp, wallet: dapp.wallet, resolveNote },
      pool, sale, wallet: { utxos, feeRate: await feeRate() }, recipientAddress: alice.addressString,
    });
    const { value, blinding, ...fields } = r.note;
    Object.assign(st, {
      saleId: sale.sale_id, lot: sale.asset_outpoint, price: sale.min_price_sats, sellerPayout: sale.seller_payout_script, faucetTakesBefore: status.taken_total,
      commitTxid: r.commitTxid, commitHex: r.commitHex, revealTxid: r.carrierTxid, revealHex: r.carrierHex,
      commitFee: r.commitFee, revealFee: r.revealFee, shieldPayload: r.shield.payloadHex, note: fields, noteValue: value,
    });
    saveState();
    const mine = pool.scan(alice, [r.note]);
    if (mine.length !== 1 || mine[0].value !== BigInt(sale.asset_opening.amount)) throw new Error('Alice does not receive her shield note');
    log(`Alice receives the shield note: ${mine[0].value} units`);
  }
  if (!st.broadcast) await broadcastPair(st, 'join');
  if (!st.height) { st.height = await waitConfirmed(st.revealTxid, 'join carrier'); saveState(); }
  await waitIndexed(st.height, 'join');
  const notes = await allNotes();
  const row = notes.find((n) => strip(n.leaf) === strip(st.note.leaf));
  if (!row) throw new Error(`indexer did not accept the shield ${st.revealTxid}: leaf ${st.note.leaf} is not in /btc-pool/notes`);
  if (row.txid !== st.revealTxid) throw new Error(`shield leaf recorded for ${row.txid}`);
  st.leafIndex = row.leafIndex; st.leafHeight = row.height;
  st.indexer = await poolStatus();
  saveState();
  log(`indexer accepted the shield: leaf ${row.leafIndex} at ${row.height}; leafCount ${st.indexer.leafCount}, root ${st.indexer.root}`);
}

// Scans the feed for a wallet's notes, each with its nullifier.
async function walletNotes(w) {
  const notes = await allNotes();
  const mine = pool.scan(w, notes).map((x) => ({ ...x, height: notes.find((n) => n.leafIndex === x.leafIndex).height, txid: notes.find((n) => n.leafIndex === x.leafIndex).txid }));
  for (const x of mine) x.spent = (await poolGet(`/btc-pool/nullifier/${strip(x.nf)}`)).spent;
  return mine;
}

async function stagePay() {
  console.log('\n--- pay (Alice → Bob, relay carrier with bind) ---');
  const st = state.pay || (state.pay = {});
  if (!st.bodyHex) {
    const unspent = (await walletNotes(alice)).filter((x) => !x.spent);
    const { inputs } = pool.selectInputs(unspent, PAY_TO_BOB, { asset: '0x' + ASSET });
    if (inputs.length !== 1) throw new Error(`expected Alice's first spend to have 1 input, got ${inputs.length}`);
    const a = await anchorAndPath(inputs[0], 'pay');
    const built = pool.buildSpendBody({
      asset: '0x' + ASSET, tip: a.tip, root: a.root,
      inputs: [{ ...inputs[0], path: a.path }],
      outputs: [{ address: bob.addressString, value: PAY_TO_BOB }],
      wallet: alice,
      bind: { txid: state.fund.relay.bind.txid, vout: state.fund.relay.bind.vout },
    });
    if (built.hAnchor !== a.hAnchor) throw new Error('anchor drift');
    const toBob = pool.scan(bob, built.outputs);
    const own = pool.scan(alice, built.outputs);
    if (toBob.length !== 1 || toBob[0].value !== PAY_TO_BOB) throw new Error('Bob does not receive the pay output');
    if (own.length !== 2 || !own.every((x) => x.internal) || own.reduce((t, x) => t + x.value, 0n) !== inputs[0].value - PAY_TO_BOB) throw new Error('Alice does not receive change and padding internally');
    if (pool.scan(pool.viewWallet(alice), built.outputs).length !== 0) throw new Error('change is visible to the incoming-only view key');
    st.witnessFile = path.join(HOME_V, 'secret-sats-pay-witness.json');
    writeFileSync(st.witnessFile, jsonOut(built.witness), { mode: 0o600 });
    Object.assign(st, {
      bodyHex: built.bodyHex, root: a.root, hAnchor: built.hAnchor, tipAtBuild: a.tip, bind: built.bind,
      nIn: inputs.length, nOut: built.outputs.length, nullifiers: built.nullifiers,
      outputs: built.outputs.map(({ value, blinding, ...f }) => f), inputLeaf: inputs[0].leafIndex,
    });
    saveState();
    log(`pay body ${hexToBytes(strip(built.bodyHex)).length} bytes: 1 input, ${built.outputs.length} outputs (Bob 6000, change ${inputs[0].value - PAY_TO_BOB}, one zero pad), bind ${built.bind.txid}:${built.bind.vout}`);
  }
  if (!st.revealHex) {
    const proof = await prove('pay', st);
    st.proofBytes = hexToBytes(strip(proof.proof)).length; st.vkey = proof.vkey; saveState();
    log(`pay proof ${st.proofBytes} bytes, vkey ${proof.vkey}`);
    const payload = pool.assembleSpendEnvelope(st.bodyHex, proof.proof);
    const coins = (await utxosOf(relay.spk)).filter((u) => !(u.txid === st.bind.txid && u.vout === st.bind.vout));
    const r = await buildCarrier({
      signer: relay, coins, payload,
      extraInputs: [{ txid: st.bind.txid, vout: st.bind.vout, value: state.fund.relay.bind.value, priv: relay.priv, pub: relay.pub }],
      outputs: [{ value: dapp.DUST, script: relay.spk }],
    });
    Object.assign(st, r, { payloadBytes: payload.length });
    saveState();
  }
  if (!st.broadcast) await broadcastPair(st, 'pay');
  if (!st.height) { st.height = await waitConfirmed(st.revealTxid, 'pay carrier'); saveState(); }
  await waitIndexed(st.height, 'pay');
  for (const nf of st.nullifiers) {
    const r = await poolGet(`/btc-pool/nullifier/${strip(nf)}`);
    if (!r.spent || r.txid !== st.revealTxid) throw new Error(`indexer did not accept the pay ${st.revealTxid}: nullifier ${nf} ${JSON.stringify(r)}`);
  }
  const bobNotes = await walletNotes(bob);
  const got = bobNotes.find((x) => x.txid === st.revealTxid);
  if (!got || got.value !== PAY_TO_BOB) throw new Error('Bob does not find his note in the indexer feed');
  st.bobLeaf = got.leafIndex;
  st.indexer = await poolStatus();
  saveState();
  log(`indexer accepted the pay: nullifier spent at ${st.height}; Bob scans /btc-pool/notes and finds ${got.value} units at leaf ${got.leafIndex}`);
}

async function stageExit() {
  console.log('\n--- exit to sats (Bob → maker, want 2,000 sats) ---');
  const st = state.exit || (state.exit = {});
  const makerBind = state.fund.alice.makerBind;
  const maker = { spk: '0x' + bytesToHex(FUND.spk), sats: EXIT_SATS, vout: 1, exitVout: 0, bind: { txid: makerBind.txid, vout: makerBind.vout } };
  if (!st.bodyHex) {
    const unspent = (await walletNotes(bob)).filter((x) => !x.spent);
    if (unspent.length !== 1) throw new Error(`Bob should hold one note, has ${unspent.length}`);
    const a = await anchorAndPath(unspent[0], 'exit');
    const used = new Set(st.usedScripts || []);
    const r = zap.exitToSats({ pool, wallet: bob, notes: [{ ...unspent[0], path: a.path }], amount: EXIT_AMOUNT, maker, asset: '0x' + ASSET, tip: a.tip, root: a.root, usedScripts: used });
    if (r.spend.hAnchor !== a.hAnchor) throw new Error('anchor drift');
    const change = pool.scan(bob, r.spend.outputs);
    if (change.reduce((t, x) => t + x.value, 0n) !== unspent[0].value - EXIT_AMOUNT || !change.every((x) => x.internal)) throw new Error('Bob does not keep his change internally');
    st.witnessFile = path.join(HOME_V, 'secret-sats-exit-witness.json');
    writeFileSync(st.witnessFile, jsonOut(r.spend.witness), { mode: 0o600 });
    Object.assign(st, {
      bodyHex: r.spend.bodyHex, root: a.root, hAnchor: r.spend.hAnchor, tipAtBuild: a.tip, bind: r.spend.bind,
      nIn: 1, nOut: r.spend.outputs.length, nullifiers: r.spend.nullifiers,
      outputs: r.spend.outputs.map(({ value, blinding, ...f }) => f),
      exit: { exitVout: r.spend.exit.exitVout, cx: r.spend.exit.cx, cy: r.spend.exit.cy, destSpkHash: r.spend.exit.destSpkHash },
      want: r.spend.want, offer: r.offer, payout: { counter: r.payout.counter, scriptPubKey: r.payout.scriptPubKey, outputKey: r.payout.outputKey },
      usedScripts: [...used],
    });
    saveState();
    log(`exit body ${hexToBytes(strip(r.spend.bodyHex)).length} bytes: exit ${EXIT_AMOUNT} at vout 0 to the maker, want ${EXIT_SATS} sats at vout 1 to Bob's exit key #${r.payout.counter}, ${r.spend.outputs.length} internal outputs`);
  }
  if (!st.revealHex) {
    const proof = await prove('exit', st);
    st.proofBytes = hexToBytes(strip(proof.proof)).length; st.vkey = proof.vkey; saveState();
    log(`exit proof ${st.proofBytes} bytes, vkey ${proof.vkey}`);
    const payload = pool.assembleSpendEnvelope(st.bodyHex, proof.proof);
    // Maker side: check the offer and the proof before paying anything.
    const { makeBtcPoolVerifier } = await import('../worker-relay/src/lib/btc-pool-verify.js');
    const verifier = makeBtcPoolVerifier({ bin: VERIFY_BIN, log: () => {} });
    const verify = verifier.verify;
    const v = await zap.validateExitToSats({ pool, payload, offer: st.offer, maker, amount: EXIT_AMOUNT, asset: '0x' + ASSET, root: st.root, verify: verify || undefined });
    st.makerVerifiedProof = !!verify;
    log(`maker validated the offer${verify ? ' and verified the proof locally' : ''}`);
    const outputs = zap.makerCarrierOutputs({ exitVout: v.exitVout, wantVout: v.wantVout, wantValue: v.wantValue, payoutScriptPubKey: v.payoutScriptPubKey, makerSpk: FUND.spk, exitSats: dapp.DUST })
      .map((o) => ({ value: Number(o.value), script: o.script }));
    const coins = await fundingCoins([`${makerBind.txid}:${makerBind.vout}`]);
    const r = await buildCarrier({
      signer: FUND, coins, payload,
      extraInputs: [{ txid: makerBind.txid, vout: makerBind.vout, value: makerBind.value, priv: FUND.priv, pub: FUND.pub }],
      outputs,
    });
    Object.assign(st, r, { payloadBytes: payload.length });
    saveState();
  }
  if (!st.broadcast) await broadcastPair(st, 'exit');
  if (!st.height) { st.height = await waitConfirmed(st.revealTxid, 'exit carrier'); saveState(); }
  await waitIndexed(st.height, 'exit');
  for (const nf of st.nullifiers) {
    const r = await poolGet(`/btc-pool/nullifier/${strip(nf)}`);
    if (!r.spent || r.txid !== st.revealTxid) throw new Error(`indexer did not accept the exit ${st.revealTxid}: nullifier ${nf} ${JSON.stringify(r)}`);
  }
  const ex = await poolGet(`/btc-pool/exit/${st.revealTxid}/${st.exit.exitVout}`);
  if (!ex.exists || strip(ex.Cx) !== strip(st.exit.cx) || strip(ex.Cy) !== strip(st.exit.cy) || strip(ex.asset) !== ASSET) throw new Error(`indexer has no matching exit record: ${JSON.stringify(ex)}`);
  st.exitRecord = ex;
  const C = pool.commitXY(EXIT_AMOUNT, BigInt(st.offer.exitOpening.blinding));
  if (strip(C.cx) !== strip(ex.Cx) || strip(C.cy) !== strip(ex.Cy)) throw new Error('maker\'s exit opening does not open the recorded exit');
  dapp.clearBtcPoolExitCache();
  const reasons = new Map();
  const ok = await dapp.validateOutpoint(st.revealTxid, st.exit.exitVout, new Map(), dapp.getTx, 0, null, null, null, reasons);
  st.makerNoteValid = ok === true;
  if (ok !== true) throw new Error(`validateOutpoint rejects the maker's exit note: ${reasons.get(`${st.revealTxid}:${st.exit.exitVout}`)}`);
  const tx = await esploraJson(`/tx/${st.revealTxid}`);
  const wantOut = tx.vout[st.want.vout];
  if (strip(wantOut.scriptpubkey) !== strip(st.payout.scriptPubKey) || BigInt(wantOut.value) < EXIT_SATS) throw new Error('carrier does not pay Bob\'s want');
  const bobNotes = await walletNotes(bob);
  const change = bobNotes.filter((x) => x.txid === st.revealTxid && !x.spent);
  st.bobChange = change.reduce((t, x) => t + x.value, 0n);
  st.indexer = await poolStatus();
  saveState();
  log(`indexer recorded the exit ${st.revealTxid}:${st.exit.exitVout}; the maker's note validates; Bob received ${wantOut.value} sats at ${tx.vout[st.want.vout].scriptpubkey_address}; Bob's change ${st.bobChange} units (internal)`);
}

async function stageReport() {
  console.log('\n--- report ---');
  const sz = state.sizes || (state.sizes = {});
  const txs = {
    fundAlice: state.fund?.alice?.txid, fundRelay: state.fund?.relay?.txid,
    joinCommit: state.join?.commitTxid, joinCarrier: state.join?.revealTxid,
    payCommit: state.pay?.commitTxid, payCarrier: state.pay?.revealTxid,
    exitCommit: state.exit?.commitTxid, exitCarrier: state.exit?.revealTxid,
  };
  for (const [k, t] of Object.entries(txs)) if (t && !sz[k]) { try { sz[k] = { txid: t, ...(await vsizeOf(t)) }; } catch { /* not visible */ } }
  state.finalStatus = await poolStatus();
  saveState();
  for (const [k, v] of Object.entries(sz)) log(`${k.padEnd(12)} ${String(v.vsize).padStart(5)} vB  fee ${v.fee}  ${link(v.txid)}`);
  log(`indexer: ${JSON.stringify(state.finalStatus)}`);
}

// Read-only preflight: fee rate, funding coins, an open sale whose lot the transparent validator accepts.
async function stageProbe() {
  console.log('\n--- probe ---');
  log(`fee rate ${await feeRate()} sat/vB`);
  const coins = await fundingCoins();
  log(`funding coins >= ${MIN_FUNDING_COIN}: ${coins.length}, ${coins.reduce((s, u) => s + u.value, 0)} sats`);
  const { sale } = await pickSale();
  const resolveNote = makeNoteResolver({ validateOutpoint: dapp.validateOutpoint, txOutputEnvelope: dapp.txOutputEnvelope, getParentEnvelopeData: dapp.getParentEnvelopeData, fetchTx: dapp.getTx });
  const lot = await resolveNote(sale.asset_outpoint.txid, sale.asset_outpoint.vout);
  log(`sale ${sale.sale_id}: lot ${lot ? 'valid, asset ' + lot.assetIdHex : 'NOT valid'}`);
}

const STAGES = { probe: stageProbe, fund: stageFund, join: stageJoin, pay: stagePay, exit: stageExit, report: stageReport };
const want = process.argv[2] || 'all';
console.log(`=== secret sats signet e2e (${want}) ===`);
console.log(`  funding ${W.address}`);
console.log(`  alice   ${alice.addressString.slice(0, 24)}…`);
console.log(`  bob     ${bob.addressString.slice(0, 24)}…`);
console.log(`  pool    ${POOL_API}`);
console.log(`  state   ${STATE_FILE}`);
if (want === 'all') for (const s of ['fund', 'join', 'pay', 'exit', 'report']) await STAGES[s]();
else {
  if (!STAGES[want]) throw new Error(`unknown stage ${want}`);
  await STAGES[want]();
}
process.exit(0);
