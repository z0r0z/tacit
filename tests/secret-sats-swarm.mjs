// Secret Sats swarm on signet: many independent wallets driving the client-proved Bitcoin shielded pool end to
// end (DESIGN-btc-shielded-pool.md), to exercise it at volume, check that every envelope is accepted, and audit
// what public chain data reveals. Every proof is made here with the modules the browser runs
// (dapp/btc-shielded-pool.js, dapp/btc-pool-zap.js, dapp/btc-pool-client.js) and the pinned signet key.
//
//   node tests/secret-sats-swarm.mjs [init|fund|join|pay|exit|verify|audit|status|all|reseed|reseed-all]   (default: all, resumable)
//
// init    N random wallets (N_WALLETS, default 24), each with its own seed: a P2WPKH funding key and a pool
//         wallet (view / spend / nullifier keys, internal address, exit keys).
// fund    one funding-wallet transaction with one output per wallet (FUND_EACH sats).
// join    each wallet buys one faucet lot and shields it (buyAndShield); entries are spread over time and a
//         sale taken by someone else is retried with another one.
// pay     randomized private payments (PAY_MIN..PAY_MAX units) between swarm wallets and to fresh third-party
//         pool addresses, proved here and posted through the relayer (fee note inside the pool). Inputs, change
//         and padding follow the wallet defaults (selectInputs, internal change, pad to 3 outputs).
// exit    about a third of the wallets exit part of their balance, keeping private change: exit-to-sats with
//         the funding wallet as maker, or through the relayer to a fresh exit key of their own.
// verify  every wallet scans /btc-pool/notes; balances reconcile against the ledger of confirmed actions.
// audit   what public data (esplora + the indexer) shows, scored against the ground truth kept here.
//
// State: ~/.tacit-validation/secret-sats-swarm-state.json (0600). Keys are never printed.
// Env: BTC_POOL_API, BTC_POOL_RELAY, ESPLORA, FEE_RATE (default 2), N_WALLETS, FUND_EACH, PAYS (default 40),
//      ANCHOR (policy|latest|mixed, default mixed: each spend uses the wallet policy anchor or the replayed tip at
//      random, so part of the traffic reflects real wallet behavior), CONFIRM_TIMEOUT_MIN (default 180).
import { JSDOM } from 'jsdom';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { makeBtcShieldedPool, defaultAnchor } from '../dapp/btc-shielded-pool.js';
import { makeBtcPoolZap, makeNoteResolver } from '../dapp/btc-pool-zap.js';
import { makePoolClient } from '../dapp/btc-pool-client.js';
import { makeBtcPoolVerifier } from '../worker-relay/src/lib/btc-pool-verify.js';
import { parseTx, txEnvelopes } from '../worker-relay/src/lib/btc-pool-chain.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME_V = path.join(os.homedir(), '.tacit-validation');
const STATE_FILE = process.env.STATE_FILE || path.join(HOME_V, 'secret-sats-swarm-state.json');
const AUDIT_FILE = process.env.AUDIT_FILE || path.join(HOME_V, 'secret-sats-swarm-audit.json');
const WALLET_FILE = path.join(HOME_V, 'signet.json');
const POOL_API = (process.env.BTC_POOL_API || 'https://tacit-btc-pool.onrender.com').replace(/\/$/, '');
const RELAY_API = (process.env.BTC_POOL_RELAY || 'https://tacit-btc-pool-relay.onrender.com').replace(/\/$/, '');
const FAUCET = (process.env.SATS_FAUCET || 'https://tacit-sats-faucet.onrender.com').replace(/\/$/, '');
const ESPLORA = (process.env.ESPLORA || 'https://blockstream.info/signet/api').replace(/\/$/, '');
const ANCHOR = process.env.ANCHOR || 'mixed'; // policy | latest | mixed (each spend picks one at random)
const CONFIRM_TIMEOUT_MS = Number(process.env.CONFIRM_TIMEOUT_MIN || 180) * 60_000;
const FEE_RATE = Number(process.env.FEE_RATE || 2);

const ASSET = '17619b4c65ad462481b74a59dbd566730a4376f07fb0e6ff8beca216044466c5';
const N_WALLETS = Number(process.env.N_WALLETS || 24);
const FUND_EACH = Number(process.env.FUND_EACH || 3_600);
const JOIN_NEED = Number(process.env.JOIN_NEED || 3_900); // sats a wallet needs for one buy-and-shield (Halo2 shield ≈ 3.1 KB)
const SWARM_BUDGET = 170_000;
const PAYS = Number(process.env.PAYS || 40);
const PAY_MIN = 500, PAY_MAX = 6_000;
const THIRD_PARTY_SHARE = 0.25;
const MAKER_WANT_SATS = 1_000n;
const MAKER_BIND_COIN = 1_500;
const MIN_FUNDING_COIN = 20_000; // only large funding-wallet coins are spent here

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
const rawFetch = globalThis.fetch;
// Every request gets a deadline: a hung connection must not stall the swarm.
const realFetch = (url, opts = {}) => rawFetch(url, opts.signal ? opts : { ...opts, signal: AbortSignal.timeout(Number(process.env.FETCH_TIMEOUT_MS || 60_000)) });
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
const ART = path.join(ROOT, 'dapp/btc-pool');
const readArt = (n) => readFileSync(path.join(ART, n));
const client = makePoolClient({ api: POOL_API, readFile: readArt, fetchImpl: (...a) => realFetch(...a) });
const relay = makePoolClient({ api: RELAY_API, readFile: readArt, fetchImpl: (...a) => realFetch(...a) });
const verifier = makeBtcPoolVerifier({ network: 'signet', log: () => {} });
if (!verifier.enabled) throw new Error(`verifier: ${verifier.reason}`);

const log = (m) => console.log(`  [${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const te = new TextEncoder();
const N = secp.CURVE.n;
const strip = (h) => String(h).replace(/^0x/i, '').toLowerCase();
const short = (h) => strip(h).slice(0, 12);
const jsonOut = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? '0x' + bytesToHex(x) : x), 2);
const loadState = () => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
function saveState() {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, jsonOut(state), { mode: 0o600 });
  renameSync(tmp, STATE_FILE);
}
const state = loadState();
const randHex = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

// ── identities ──
function wpkh(pub) { return concatBytes(Uint8Array.of(0x00, 0x14), dapp.hash160(pub)); }
FUND.spk = wpkh(FUND.pub);
function keyFromSeed(seedHex) {
  const x = BigInt('0x' + bytesToHex(sha256(concatBytes(te.encode('tacit-secret-sats-swarm-transparent:'), hexToBytes(seedHex))))) % N;
  if (x === 0n) throw new Error('zero key');
  const priv = hexToBytes(x.toString(16).padStart(64, '0'));
  const pub = secp.getPublicKey(priv, true);
  return { priv, pub, spk: wpkh(pub) };
}
const useKey = (k) => { dapp.wallet.priv = k.priv; dapp.wallet.pub = k.pub; try { localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(k.pub), '1'); } catch {} };
const WAL = new Map(); // index → { pw, tk }
function walletOf(i) {
  if (!WAL.has(i)) {
    const s = state.wallets[i];
    WAL.set(i, { pw: pool.walletFromSeed(hexToBytes(s.poolSeed), 'signet'), tk: keyFromSeed(s.tSeed) });
  }
  return WAL.get(i);
}
const THIRD = new Map();
function thirdOf(k) {
  if (!THIRD.has(k)) THIRD.set(k, pool.walletFromSeed(hexToBytes(state.third[k].poolSeed), 'signet'));
  return THIRD.get(k);
}

// ── esplora ──
async function esplora(p, opts) {
  for (let i = 0; ; i++) {
    try {
      const r = await realFetch(ESPLORA + p, opts);
      const t = await r.text();
      if (!r.ok) { const e = new Error(`esplora ${p}: HTTP ${r.status} ${t.slice(0, 300)}`); e.status = r.status; e.body = t; throw e; }
      return t;
    } catch (e) {
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      if (i >= 10) throw e;
      await sleep(e.status === 429 ? 30_000 * (i + 1) : 3000 * (i + 1));
    }
  }
}
const esploraJson = async (p) => JSON.parse(await esplora(p));
const scripthash = (spk) => bytesToHex(sha256(spk));
const utxosOf = async (spk) => esploraJson(`/scripthash/${scripthash(spk)}/utxo`);
async function txKnown(txid) { try { await esplora(`/tx/${txid}`); return true; } catch (e) { if (e.status === 404 || e.status === 400) return false; throw e; } }
async function broadcastHex(hex, txid, label, parentsOk = null) {
  if (await txKnown(txid)) { log(`${label} already broadcast ${txid}`); return; }
  for (let i = 0; ; i++) {
    try {
      const got = (await esplora('/tx', { method: 'POST', body: hex })).trim();
      if (got !== txid) throw new Error(`${label}: broadcast returned ${got}, expected ${txid}`);
      log(`${label} ${txid}`);
      return;
    } catch (e) {
      // A reveal right after its commit can reach an esplora backend that has not seen the commit yet
      // (bad-txns-inputs-missingorspent); retry while `parentsOk` says every input is still unspent.
      if (i < 8 && /missingorspent|missing-inputs|orphan/i.test(e.message) && parentsOk && (await parentsOk())) { await sleep(5000 + 2500 * i); continue; }
      throw e;
    }
  }
}
async function txHeight(txid) {
  try { const s = await esploraJson(`/tx/${txid}/status`); return s.confirmed ? s.block_height : null; } catch { return null; }
}
async function waitConfirmed(txid, label) {
  const t0 = Date.now();
  for (;;) {
    const h = await txHeight(txid);
    if (h != null) { log(`${label} confirmed in block ${h}`); return h; }
    if (Date.now() - t0 > CONFIRM_TIMEOUT_MS) throw new Error(`${label} ${txid} not confirmed after ${CONFIRM_TIMEOUT_MS / 60000} min; re-run to resume`);
    await sleep(30_000);
  }
}
async function chainTip() { return Number(await esplora('/blocks/tip/height')); }

// ── pool indexer ──
async function poolGet(p, base = POOL_API) {
  for (let i = 0; ; i++) {
    try {
      const r = await realFetch(base + p);
      const j = await r.json().catch(() => null);
      if (r.status === 503 && i < 10) { await sleep(2000); continue; }
      if (!r.ok) throw Object.assign(new Error(`${base}${p}: HTTP ${r.status} ${JSON.stringify(j)}`), { status: r.status });
      return j;
    } catch (e) {
      if (e.status && e.status < 500) throw e;
      if (i >= 8) throw e;
      await sleep(5000 * (i + 1));
    }
  }
}
const poolStatus = () => poolGet('/btc-pool/status');
const nullifierRec = (nf) => poolGet(`/btc-pool/nullifier/${strip(nf)}`);
async function feed() { for (let i = 0; ; i++) { try { return await client.allNotes(); } catch (e) { if (i >= 5) throw e; await sleep(5000); } } }
async function waitIndexed(height, label) {
  const t0 = Date.now();
  for (;;) {
    const s = await poolStatus();
    if (s.halted) throw new Error(`pool indexer halted: ${JSON.stringify(s.halted)}`);
    if (s.height != null && s.height >= height) return s;
    if (Date.now() - t0 > CONFIRM_TIMEOUT_MS) throw new Error(`indexer did not reach ${height} for ${label}`);
    await sleep(20_000);
  }
}
// A wallet's notes in `notes` (the feed), each with nf and spent flag from the indexer.
async function notesOf(w, notes) {
  for (let i = 0; ; i++) { try { return await client.walletNotes(pool, w, { notes }); } catch (e) { if (i >= 5) throw e; await sleep(5000); } }
}
const sumV = (xs) => xs.reduce((t, x) => t + BigInt(x.value), 0n);

// Anchor, root and paths for spending `notes` now, or null while the policy anchor is below a note's block.
async function anchorFor(notes, mode) {
  const s = await poolStatus();
  const r = await client.anchorAndPaths(notes, mode === 'latest' ? { anchor: s.height } : {});
  if (r.wait) return null;
  for (const n of r.notes) if (strip(pool.merkleRootFrom(n.leaf, n.leafIndex, n.path)) !== strip(r.root)) throw new Error('indexer path does not reach its root');
  return r;
}
const spendableAt = (tip, height, mode) => (mode === 'latest' ? height <= tip : defaultAnchor(tip) >= height);
const pickMode = () => (ANCHOR === 'mixed' ? (Math.random() < 0.5 ? 'policy' : 'latest') : ANCHOR);

let SYSTEM = null;
async function system() { return (SYSTEM ||= await client.system()); }
async function proveTimed(built) {
  const sys = await system();
  const t0 = performance.now();
  const r = await pool.prove(built, sys);
  return { ...r, seconds: Number(((performance.now() - t0) / 1000).toFixed(2)) };
}

// ── transactions ──
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
  const skip = new Set([...(state.spentByUs || []), ...exclude]);
  return (await utxosOf(FUND.spk)).filter((u) => u.value >= MIN_FUNDING_COIN && !skip.has(outpointOf(u)))
    .sort((a, b) => (b.status?.confirmed === a.status?.confirmed ? b.value - a.value : b.status?.confirmed ? 1 : -1));
}
async function fundingSend(outputs) {
  const coins = await fundingCoins();
  const outSum = outputs.reduce((s, o) => s + o.value, 0);
  const vb = (n) => 11 + 68 * n + outputs.reduce((s, o) => s + 9 + o.script.length, 0) + 31;
  const { picked, total, fee } = pickCoins(coins, outSum, (n) => dapp.feeFor(vb(n), FEE_RATE));
  const change = total - outSum - fee;
  const tx = {
    version: 2, locktime: 0,
    inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
    outputs: [...outputs, ...(change >= dapp.DUST ? [{ value: change, script: FUND.spk }] : [])],
  };
  picked.forEach((u, i) => { tx.inputs[i].witness = dapp.signP2wpkhInputWithKey(tx, i, u.value, FUND.priv, FUND.pub); });
  state.spentByUs = [...new Set([...(state.spentByUs || []), ...picked.map(outpointOf)])];
  return { txid: dapp.txid(tx), hex: bytesToHex(dapp.serializeTx(tx)), fee, inputs: picked.map(outpointOf) };
}

// Tacit commit/reveal carrier posted by `signer` (the maker): vin[0] spends the envelope commit, vin[1..] are
// extra P2WPKH inputs (the bind); the commit is funded from the signer's own coins.
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
  const revealFee = dapp.feeFor(revealVb, FEE_RATE);
  const outSum = outputs.reduce((s, o) => s + o.value, 0);
  const extraSum = extraInputs.reduce((s, i) => s + i.value, 0);
  const commitValue = Math.max(dapp.DUST, outSum + revealFee - extraSum);
  const avoid = new Set(extraInputs.map(outpointOf));
  const { picked, total, fee: commitFee } = pickCoins(coins.filter((u) => !avoid.has(outpointOf(u))), commitValue, (n) => dapp.feeFor(dapp.estCommitVb(n), FEE_RATE));
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

// A broadcast commit whose reveal can no longer go out (its sale was taken): spend the envelope output back to
// the buyer by the script path. The reveal has no lot input, so it is not a valid shield and adds nothing.
async function sweepCommit(tk, st) {
  useKey(tk);
  const payload = hexToBytes(strip(st.payloadHex));
  const script = dapp.encodeEnvelopeScript(dapp.wallet.xonly(), payload);
  const { Q_xonly, parity } = dapp.tweakedOutputKey(dapp.TAP_NUMS, dapp.tapLeafHash(script));
  const spk = dapp.p2trScript(Q_xonly);
  const cb = dapp.controlBlock(dapp.TAP_NUMS, parity);
  const commit = await esploraJson(`/tx/${st.commitTxid}`);
  const value = commit.vout[0].value;
  const vb = Math.ceil(((4 + 1 + 41 + 1 + 31 + 4) * 4 + 2 + 1 + 65 + 3 + script.length + 1 + 33) / 4) + 2;
  const out = value - dapp.feeFor(vb, FEE_RATE);
  if (out < dapp.DUST) return null;
  const tx = { version: 2, locktime: 0, inputs: [{ txid: st.commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: out, script: tk.spk }] };
  tx.inputs[0].witness = dapp.signTaprootScriptPathInput(tx, [{ value, script: spk }], script, cb);
  const txid = dapp.txid(tx);
  await broadcastHex(bytesToHex(dapp.serializeTx(tx)), txid, 'sweep stranded commit');
  return txid;
}

// ── ledger (confirmed actions only) ──
const led = (k) => BigInt((state.ledger ||= {})[k] || '0');
const ledAdd = (k, v) => { state.ledger[k] = (led(k) + BigInt(v)).toString(); };
const wKey = (i) => `w${i}`, tKey = (k) => `t${k}`;
function event(type, rec) { (state.events ||= []).push({ t: new Date().toISOString(), type, ...rec }); }

// ── stages ──
async function stageInit() {
  console.log('\n--- init ---');
  if (!state.createdAt) state.createdAt = new Date().toISOString();
  state.wallets ||= [];
  while (state.wallets.length < N_WALLETS) state.wallets.push({ i: state.wallets.length, poolSeed: randHex(), tSeed: randHex() });
  state.third ||= [];
  state.pays ||= [];
  state.exits ||= [];
  state.ledger ||= {};
  saveState();
  log(`${state.wallets.length} wallets, ${state.third.length} third-party addresses; state ${STATE_FILE}`);
}

// The signet pool restarted on a new proof system with a fresh tree: archive the finished epoch (its notes are
// gone), keep the wallets and their keys, and top every funding key up to JOIN_NEED in one transaction.
async function stageReseed() {
  console.log('\n--- reseed (pool restarted: archive the epoch, top up every wallet in one transaction) ---');
  const s = await poolStatus();
  const tag = `${s.proofSystem || 'unknown'}@${s.startHeight}`;
  if (state.epoch !== tag) {
    (state.epochs ||= []).push({
      tag: state.epoch || 'groth16-bn254@323678', archivedAt: new Date().toISOString(),
      joins: state.wallets.map((w) => ({ i: w.i, ...w.join, joinFailures: w.joinFailures, topUp: w.topUp ? { txid: w.topUp.txid } : null })),
      pays: state.pays, exits: state.exits, third: state.third, ledger: state.ledger, afterJoin: state.afterJoin,
      fund: { txid: state.fund?.txid, total: state.fund?.total, fee: state.fund?.fee }, payErrors: state.payErrors, relayBindWaits: state.relayBindWaits,
    });
    for (const w of state.wallets) { delete w.join; delete w.joinFailures; delete w.topUp; delete w.usedExitScripts; }
    Object.assign(state, { epoch: tag, pays: [], exits: [], third: [], ledger: {}, afterJoin: null, payErrors: [], relayBindWaits: 0, salesTried: [], reseed: null });
    WAL.clear(); THIRD.clear();
    saveState();
  }
  const st = state.reseed ||= {};
  if (!st.txid) {
    const outs = [];
    for (const w of state.wallets) {
      const bal = (await utxosOf(walletOf(w.i).tk.spk)).reduce((t, u) => t + u.value, 0);
      const need = JOIN_NEED - bal;
      if (need > 0) outs.push({ i: w.i, value: Math.max(need, 600), script: walletOf(w.i).tk.spk, bal });
      await sleep(300);
    }
    const spentSoFar = (state.fund?.total || 0) + (state.epochs || []).reduce((t, e) => t + (e.joins || []).filter((j) => j.topUp).length * 2_400, 0);
    const total = outs.reduce((t, o) => t + o.value, 0);
    if (spentSoFar + total > SWARM_BUDGET) throw new Error(`top-up ${total} would exceed the budget (${spentSoFar} already)`);
    outs.sort(() => Math.random() - 0.5);
    const r = await fundingSend(outs.map(({ value, script }) => ({ value, script })));
    Object.assign(st, r, { total, outputs: outs.map(({ i, value, bal }) => ({ i, value, bal })), spentBefore: spentSoFar });
    saveState();
  }
  await broadcastHex(st.hex, st.txid, `top up ${st.outputs.length} wallets (${st.total} sats, fee ${st.fee})`);
}

async function stageFund() {
  console.log('\n--- fund ---');
  const st = state.fund ||= {};
  if (!st.txid) {
    if (N_WALLETS * FUND_EACH > SWARM_BUDGET) throw new Error(`swarm funding ${N_WALLETS * FUND_EACH} exceeds the ${SWARM_BUDGET} budget`);
    const outs = state.wallets.map((w) => ({ value: FUND_EACH, script: walletOf(w.i).tk.spk }));
    // Output order shuffled so the vout does not follow the wallet index.
    const order = outs.map((_, i) => i).sort(() => Math.random() - 0.5);
    const r = await fundingSend(order.map((i) => outs[i]));
    Object.assign(st, r, { each: FUND_EACH, order, total: N_WALLETS * FUND_EACH });
    saveState();
  }
  await broadcastHex(st.hex, st.txid, `fund ${N_WALLETS} wallets (${st.total} sats, fee ${st.fee})`);
  if (!st.height) { st.height = await waitConfirmed(st.txid, 'fund'); saveState(); }
}

async function openSales() {
  const status = await (await realFetch(`${FAUCET}/faucet/status`)).json();
  if (strip(status.asset_id) !== ASSET) throw new Error(`faucet asset ${status.asset_id} is not ${ASSET}`);
  return status;
}
// makeNoteResolver with one validateOutpoint memo shared across joins: faucet lots descend from one long
// reserve chain, so every ancestor validates once per process instead of once per lot.
const VALIDATED = new Map();
const resolveNoteRaw = makeNoteResolver({ validateOutpoint: (t, v, _m, f) => dapp.validateOutpoint(t, v, VALIDATED, f), txOutputEnvelope: dapp.txOutputEnvelope, getParentEnvelopeData: dapp.getParentEnvelopeData, fetchTx: dapp.getTx });
let lastResolveMs = null;
const resolveNote = async (txid, vout) => { const t0 = performance.now(); try { return await resolveNoteRaw(txid, vout); } finally { lastResolveMs = Math.round(performance.now() - t0); } };
const lotSpent = async (op) => { const sp = await esploraJson(`/tx/${op.txid}/outspend/${op.vout}`).catch(() => null); return !sp || sp.spent; };

// One entry: returns 'done', 'retry' (sale gone), or throws.
async function joinOne(i, sale) {
  const w = state.wallets[i];
  const { pw, tk } = walletOf(i);
  const st = w.join ||= {};
  if (!st.commitHex) {
    useKey(tk);
    let utxos = (await utxosOf(tk.spk)).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }));
    if (utxos.reduce((t, u) => t + u.value, 0) < JOIN_NEED - 400) {
      // A failed earlier attempt left too little: a separate small top-up from the funding wallet.
      if (!w.topUp) { w.topUp = await fundingSend([{ value: 2_400, script: tk.spk }]); saveState(); }
      await broadcastHex(w.topUp.hex, w.topUp.txid, `w${i} top-up after a failed entry`);
      for (let k = 0; k < 12 && !(await utxosOf(tk.spk)).some((u) => u.txid === w.topUp.txid); k++) await sleep(10_000);
      utxos = (await utxosOf(tk.spk)).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }));
    }
    const t0 = performance.now();
    const r = await zap.buyAndShield({ tacit: { ...dapp, wallet: dapp.wallet, resolveNote }, pool, sale, wallet: { utxos, feeRate: FEE_RATE }, recipientAddress: pw.addressString, system: await system() });
    const secs = Number(((performance.now() - t0) / 1000).toFixed(2));
    const mine = pool.scan(pw, [r.note]);
    if (mine.length !== 1 || mine[0].value !== BigInt(sale.asset_opening.amount)) throw new Error(`wallet ${i} does not receive its shield note`);
    if (!(await pool.verifyPayload(await system(), r.shield.payload))) throw new Error('shield payload does not verify');
    const { value, npk, rho, ...fields } = r.note;
    Object.assign(st, {
      saleId: sale.sale_id, lot: sale.asset_outpoint, price: sale.min_price_sats, amount: String(sale.asset_opening.amount),
      commitTxid: r.commitTxid, commitHex: r.commitHex, revealTxid: r.carrierTxid, revealHex: r.carrierHex,
      commitFee: r.commitFee, revealFee: r.revealFee, payloadHex: r.shield.payloadHex, payloadBytes: r.shield.payload.length,
      note: fields, buildAndProveSeconds: secs, lotResolveSeconds: lastResolveMs == null ? null : lastResolveMs / 1000,
    });
    saveState();
  }
  if (!st.broadcast) {
    if (await lotSpent(st.lot)) { log(`wallet ${i}: lot of sale ${st.saleId} already taken before broadcast; retrying with another sale`); resetJoin(w, 'lot taken before broadcast'); return 'retry'; }
    await broadcastHex(st.commitHex, st.commitTxid, `w${i} join commit`);
    try {
      const parentsOk = async () => !(await lotSpent(st.lot)) && (await txKnown(st.commitTxid)) && !(await esploraJson(`/tx/${st.commitTxid}/outspend/0`).catch(() => ({ spent: true }))).spent;
      await broadcastHex(st.revealHex, st.revealTxid, `w${i} join carrier (sale ${st.saleId}, shield ${st.payloadBytes} B, ${st.buildAndProveSeconds} s, lot validation ${st.lotResolveSeconds} s)`, parentsOk);
    } catch (e) {
      if (/conflict|missingorspent/i.test(e.message + (e.body || '')) && (await lotSpent(st.lot))) {
        log(`w${i}: carrier refused (${e.message.slice(0, 160)}); sale taken, sweeping the commit`);
        const sweep = await sweepCommit(walletOf(i).tk, st).catch((x) => { log(`sweep failed: ${x.message}`); return null; });
        resetJoin(w, `carrier refused: ${e.message.slice(0, 200)}`, sweep);
        return 'retry';
      }
      throw e;
    }
    st.broadcast = true; st.broadcastAt = new Date().toISOString();
    event('join', { wallet: i, txid: st.revealTxid });
    saveState();
  }
  return 'done';
}
function resetJoin(w, reason, sweep = null) {
  const { commitHex, ...keep } = w.join;
  (w.joinFailures ||= []).push({ ...keep, reason, sweep, at: new Date().toISOString() });
  (state.salesTried ||= []).push(w.join.saleId);
  w.join = {};
  saveState();
}

async function stageJoin() {
  console.log('\n--- join (buy and shield, spread over time) ---');
  for (;;) {
    const todo = state.wallets.filter((w) => !w.join?.broadcast);
    if (!todo.length) break;
    // A wallet with a built but unbroadcast carrier finishes first when its sale is still open.
    const pending = todo.find((w) => w.join?.commitHex);
    if (pending) { await joinOne(pending.i, null).catch((e) => log(`w${pending.i}: ${e.message}`)); continue; }
    const status = await openSales().catch(() => null);
    const tried = new Set(state.salesTried || []);
    const open = [];
    for (const s of status?.open_sales || []) {
      if (tried.has(s.sale_id) || (await lotSpent(s))) continue;
      const sale = await dapp.fetchPreauthSale({ assetIdHex: ASSET, saleIdHex: s.sale_id }).catch(() => null);
      if (sale && !sale.expired) open.push(sale);
    }
    // Take at most two sales per round and leave the rest listed for other testers.
    const take = Math.min(open.length, rnd(1, Number(process.env.JOIN_PER_ROUND || 2)), todo.length);
    if (!take) { log(`no open sale (listed ${status?.open_sales?.length ?? '?'}); waiting`); await sleep(60_000); continue; }
    const ws = [...todo].sort(() => Math.random() - 0.5).slice(0, take);
    for (let k = 0; k < take; k++) {
      const r = await joinOne(ws[k].i, open[k]).catch((e) => { log(`w${ws[k].i}: join failed: ${e.message}`); (state.salesTried ||= []).push(open[k].sale_id); saveState(); return 'error'; });
      if (k + 1 < take) await sleep(rnd(15, 60) * 1000);
      if (r === 'error') break;
    }
    const left = state.wallets.filter((w) => !w.join?.broadcast).length;
    if (left) { const d = rnd(Number(process.env.JOIN_GAP_MIN || 60), Number(process.env.JOIN_GAP_MAX || 180)); log(`${N_WALLETS - left}/${N_WALLETS} joined; next entry in ${d} s`); await sleep(d * 1000); }
  }
  // Confirmation and indexer acceptance of every shield.
  for (const w of state.wallets) {
    const st = w.join;
    if (!st.height) { st.height = await waitConfirmed(st.revealTxid, `w${w.i} join`); saveState(); }
  }
  const maxH = Math.max(...state.wallets.map((w) => w.join.height));
  await waitIndexed(maxH, 'joins');
  const notes = await feed();
  for (const w of state.wallets) {
    const st = w.join;
    if (st.leafIndex != null) continue;
    const row = notes.find((n) => strip(n.leaf) === strip(st.note.leaf));
    if (!row) throw new Error(`indexer did not accept w${w.i}'s shield ${st.revealTxid}`);
    if (row.txid !== st.revealTxid) throw new Error(`w${w.i} shield leaf recorded for ${row.txid}`);
    st.leafIndex = row.leafIndex; st.leafHeight = row.height;
    ledAdd(wKey(w.i), st.amount);
    saveState();
  }
  const s = await poolStatus();
  state.afterJoin = { leafCount: s.leafCount, root: s.root, height: s.height };
  saveState();
  log(`all ${N_WALLETS} shields accepted; leafCount ${s.leafCount}, root ${short(s.root)}`);
}

// ── pay / exit bookkeeping ──
const OPEN = new Set(['proved', 'submitted', 'broadcast']);
const busy = (i) => state.pays.some((p) => p.from === i && OPEN.has(p.state)) || state.exits.some((x) => x.from === i && OPEN.has(x.state));
const pendingNfs = () => new Set([...state.pays, ...state.exits].filter((p) => OPEN.has(p.state)).flatMap((p) => p.nullifiers.map(strip)));

// Settles open pays and exits: a record is done once its nullifiers are spent and its block is replayed.
async function settle(notes) {
  const s = await poolStatus();
  for (const rec of [...state.pays, ...state.exits]) {
    if (!OPEN.has(rec.state)) continue;
    const kind = state.pays.includes(rec) ? 'pay' : 'exit';
    if (rec.relayId && rec.state !== 'broadcast') {
      const r = await relay.relayStatus(rec.relayId).catch((e) => ({ error: e.message, status: e.status }));
      if (r?.state && r.state !== rec.relayState) { rec.relayState = r.state; log(`${kind} ${rec.id}: relay ${r.state}${r.carrier ? ' ' + r.carrier : ''}${r.reason ? ' (' + r.reason + ')' : ''}`); }
      if (r?.carrier) rec.carrier = r.carrier;
      if (r?.commit) rec.commitTxid = r.commit;
      if (['dropped', 'rejected'].includes(r?.state)) { rec.state = 'failed'; rec.reason = `relay ${r.state}: ${r.reason || ''}`; saveState(); continue; }
      if (r?.status === 404 && Date.now() - Date.parse(rec.submittedAt) > 15 * 60_000 && !rec.carrier) rec.relayLost = true;
    }
    const nfs = await Promise.all(rec.nullifiers.map((nf) => nullifierRec(nf)));
    if (!nfs.every((x) => x.spent)) {
      const age = Date.now() - Date.parse(rec.submittedAt || rec.builtAt);
      if (rec.state === 'proved' && age > 20 * 60_000) { rec.state = 'failed'; rec.reason = 'never submitted (quote expired)'; }
      else if (rec.relayLost && age > 60 * 60_000) { rec.state = 'failed'; rec.reason = 'relayer lost the payload'; }
      saveState();
      continue;
    }
    const txs = new Set(nfs.map((x) => x.txid));
    if (txs.size !== 1) throw new Error(`${kind} ${rec.id}: nullifiers spent in different transactions ${[...txs]}`);
    const txid = [...txs][0];
    if (rec.carrier && rec.carrier !== txid) log(`${kind} ${rec.id}: carried by ${txid} (relay reported ${rec.carrier}, replaced)`);
    rec.carrier = txid; rec.height = nfs[0].height;
    if (s.height < rec.height) continue;
    if (kind === 'pay') await finishPay(rec, notes); else await finishExit(rec, notes);
  }
}

async function finishPay(p, notes) {
  const payee = p.to.startsWith('t') ? thirdOf(Number(p.to.slice(1))) : walletOf(Number(p.to.slice(1))).pw;
  const got = pool.scan(payee, notes.filter((n) => n.txid === p.carrier));
  const recv = got.find((x) => !x.internal && x.value === BigInt(p.amount));
  if (!recv) throw new Error(`pay ${p.id}: payee ${p.to} does not find ${p.amount} units in ${p.carrier}`);
  const own = pool.scan(walletOf(p.from).pw, notes.filter((n) => n.txid === p.carrier));
  const change = own.reduce((t, x) => t + x.value, 0n);
  if (!own.every((x) => x.internal) || change !== BigInt(p.inputTotal) - BigInt(p.amount) - BigInt(p.fee)) throw new Error(`pay ${p.id}: change ${change} does not reconcile`);
  const txNotes = notes.filter((n) => n.txid === p.carrier);
  p.payeeLeaf = recv.leafIndex; p.carrierOutputs = txNotes.length;
  p.state = 'done'; p.doneAt = new Date().toISOString();
  ledAdd(wKey(p.from), -(BigInt(p.amount) + BigInt(p.fee)));
  ledAdd(p.to.startsWith('t') ? tKey(Number(p.to.slice(1))) : p.to.replace('w', 'w'), p.amount);
  event('pay-done', { id: p.id, txid: p.carrier, height: p.height });
  saveState();
  log(`pay ${p.id} done: w${p.from} → ${p.to} ${p.amount} units (fee ${p.fee}), ${p.nIn} in / ${p.nOut} out, carrier ${p.carrier} @${p.height}; payee finds leaf ${recv.leafIndex}`);
}

async function finishExit(x, notes) {
  const ex = await poolGet(`/btc-pool/exit/${x.carrier}/${x.exitVout}`);
  if (!ex.exists || strip(ex.Cx) !== strip(x.cx) || strip(ex.Cy) !== strip(x.cy) || strip(ex.asset) !== ASSET) throw new Error(`exit ${x.id}: indexer has no matching exit record: ${JSON.stringify(ex)}`);
  const C = pool.commitXY(BigInt(x.amount), BigInt(x.blinding));
  if (strip(C.cx) !== strip(ex.Cx) || strip(C.cy) !== strip(ex.Cy)) throw new Error(`exit ${x.id}: opening does not open the recorded exit`);
  dapp.clearBtcPoolExitCache();
  const reasons = new Map();
  const ok = await dapp.validateOutpoint(x.carrier, x.exitVout, new Map(), dapp.getTx, 0, null, null, null, reasons);
  x.exitNoteValid = ok === true;
  if (ok !== true) log(`exit ${x.id}: validateOutpoint rejects the exit note: ${reasons.get(`${x.carrier}:${x.exitVout}`)}`);
  const tx = await esploraJson(`/tx/${x.carrier}`);
  x.exitOutput = { value: tx.vout[x.exitVout].value, spk: tx.vout[x.exitVout].scriptpubkey };
  if (strip(x.exitOutput.spk) !== strip(x.exitSpk)) throw new Error(`exit ${x.id}: carrier output ${x.exitVout} is not the exit script`);
  if (x.mode === 'maker') {
    const wantOut = tx.vout[x.wantVout];
    if (strip(wantOut.scriptpubkey) !== strip(x.payoutSpk) || BigInt(wantOut.value) < BigInt(x.wantSats)) throw new Error(`exit ${x.id}: carrier does not pay the want`);
    x.wantPaid = wantOut.value;
  }
  const own = pool.scan(walletOf(x.from).pw, notes.filter((n) => n.txid === x.carrier));
  const change = own.reduce((t, n) => t + n.value, 0n);
  if (change !== BigInt(x.inputTotal) - BigInt(x.amount) - BigInt(x.fee)) throw new Error(`exit ${x.id}: change ${change} does not reconcile`);
  x.state = 'done'; x.doneAt = new Date().toISOString();
  ledAdd(wKey(x.from), -(BigInt(x.amount) + BigInt(x.fee)));
  event('exit-done', { id: x.id, txid: x.carrier, height: x.height });
  saveState();
  log(`exit ${x.id} done (${x.mode}): w${x.from} exits ${x.amount} units at ${x.carrier}:${x.exitVout}${x.mode === 'maker' ? `, received ${x.wantPaid} sats` : ''}; change ${change} internal; exit note ${x.exitNoteValid ? 'validates' : 'NOT validated'}`);
}

// Spendable (unspent, not held by an open record, anchorable) notes of wallet i.
async function spendable(i, notes, tip, mode) {
  const held = pendingNfs();
  const mine = await notesOf(walletOf(i).pw, notes);
  return mine.filter((x) => !x.spent && !held.has(strip(x.nf)) && spendableAt(tip, x.height, mode));
}

let relayInfoCache = null;
async function relayUp() {
  try { relayInfoCache = await relay.relayInfo(); return !!(relayInfoCache && relayInfoCache.verifierEnabled); } catch { return false; }
}

async function onePay(notes, tip) {
  const fee = BigInt(relayInfoCache.fees?.['0x' + ASSET] ?? relayInfoCache.fees?.[ASSET] ?? 'NaN');
  const mode = pickMode();
  const candidates = [];
  for (const w of state.wallets) {
    if (busy(w.i)) continue;
    const sp = await spendable(w.i, notes, tip, mode);
    const bal = sumV(sp);
    if (bal >= BigInt(PAY_MIN) + fee) candidates.push({ i: w.i, sp, bal });
  }
  if (!candidates.length) return false;
  const c = pick(candidates);
  const maxAmt = Math.min(PAY_MAX, Number(c.bal - fee));
  const amount = BigInt(rnd(PAY_MIN, maxAmt));
  let to;
  if (Math.random() < THIRD_PARTY_SHARE) { state.third.push({ poolSeed: randHex() }); to = `t${state.third.length - 1}`; }
  else { const others = state.wallets.filter((w) => w.i !== c.i); to = `w${pick(others).i}`; }
  const payeeAddr = to.startsWith('t') ? thirdOf(Number(to.slice(1))).addressString : walletOf(Number(to.slice(1))).pw.addressString;
  const { inputs, total } = pool.selectInputs(c.sp, amount + fee, { asset: '0x' + ASSET });
  const a = await anchorFor(inputs, mode);
  if (!a) return false;
  const q = await relay.quote({ asset: '0x' + ASSET });
  if (BigInt(q.fee) !== fee) throw new Error(`relay fee changed: ${q.fee}`);
  if (q.minAnchor != null && a.hAnchor < q.minAnchor) throw new Error(`anchor ${a.hAnchor} below relayer minAnchor ${q.minAnchor}`);
  const { pw } = walletOf(c.i);
  const built = pool.buildSpendBody({
    asset: '0x' + ASSET, hAnchor: a.hAnchor, root: a.root, inputs: a.notes,
    outputs: [{ address: payeeAddr, value: amount }, { address: q.address, value: fee }],
    wallet: pw, bind: q.bind,
  });
  const id = `p${state.pays.length}`;
  const rec = {
    id, anchorMode: mode, from: c.i, to, amount: amount.toString(), fee: fee.toString(), inputTotal: total.toString(), nIn: inputs.length, nOut: built.outputs.length,
    inputLeaves: inputs.map((x) => x.leafIndex), inputHeights: inputs.map((x) => x.height), inputValues: inputs.map((x) => x.value.toString()),
    nullifiers: built.nullifiers, hAnchor: built.hAnchor, root: a.root, tipAtBuild: a.tip, bind: q.bind, quoteId: q.quoteId,
    outputLeaves: built.outputs.map((o) => o.leaf), outputValues: built.outputs.map((o) => o.value.toString()),
    builtAt: new Date().toISOString(), state: 'building',
  };
  const payeeW = to.startsWith('t') ? thirdOf(Number(to.slice(1))) : walletOf(Number(to.slice(1))).pw;
  if (pool.scan(payeeW, built.outputs).filter((x) => !x.internal && x.value === amount).length !== 1) throw new Error('payee does not receive the pay output');
  const own = pool.scan(pw, built.outputs);
  if (!own.every((x) => x.internal) || sumV(own) !== total - amount - fee) throw new Error('change does not go to the internal address');
  const pr = await proveTimed(built);
  const pp = pool.payloadPublics(pr.payload, { root: a.root });
  if (!(await verifier.verify({ proof: hexToBytes(strip(pp.parsed.proof)), publics: pp.publics }))) throw new Error('pay payload does not verify natively');
  Object.assign(rec, { proveSeconds: pr.seconds, payloadBytes: pr.payload.length, state: 'proved' });
  state.pays.push(rec);
  saveState();
  try {
    const r = await relay.submit({ payload: bytesToHex(pr.payload), quoteId: q.quoteId });
    Object.assign(rec, { relayId: r.id, batchId: r.batchId, state: 'submitted', submittedAt: new Date().toISOString() });
  } catch (e) {
    Object.assign(rec, { state: 'failed', reason: `submit: ${e.status || ''} ${e.message}` });
  }
  saveState();
  log(`pay ${id}: w${c.i} → ${to} ${amount} units + fee ${fee}; ${inputs.length} in (leaves ${rec.inputLeaves}), ${rec.nOut} out; anchor ${a.hAnchor} (tip ${a.tip}); proved ${pr.seconds} s, ${pr.payload.length} B; ${rec.state}${rec.reason ? ' ' + rec.reason : ''}`);
  return true;
}

async function stagePay() {
  console.log('\n--- pay (randomized private payments via the relayer) ---');
  state.pays ||= []; state.third ||= [];
  let idleSince = Date.now(), waitingBind = false;
  for (;;) {
    const notes = await feed();
    await settle(notes);
    const done = state.pays.filter((p) => p.state === 'done').length;
    const open = state.pays.filter((p) => OPEN.has(p.state)).length;
    const attempted = state.pays.filter((p) => p.state !== 'failed').length;
    if (done >= PAYS || (attempted >= PAYS && !open)) break;
    if (attempted >= PAYS) { await sleep(60_000); continue; }
    if (!(await relayUp())) { log(`relayer ${RELAY_API} not available; waiting`); await sleep(120_000); continue; }
    const tip = (await poolStatus()).height;
    let did = false;
    try { did = await onePay(notes, tip); } catch (e) {
      // The relayer binds each carrier to a confirmed coin of its own; with every coin in flight it opens no
      // batch until the next block.
      if (/no confirmed relayer UTXO/.test(e.message)) { if (!waitingBind) log('relayer has no confirmed coin to bind; waiting for a block'); waitingBind = true; (state.relayBindWaits ||= 0); state.relayBindWaits++; saveState(); await sleep(60_000); continue; }
      log(`pay attempt failed: ${e.message}${/JSON/.test(e.message) ? ' @ ' + String(e.stack).split('\n').slice(1, 6).join(' | ') : ''}`); (state.payErrors ||= []).push({ at: new Date().toISOString(), error: e.message }); saveState();
    }
    // Several payers often land in one relayer batch (one carrier); otherwise spread over minutes.
    if (did) { waitingBind = false; idleSince = Date.now(); await sleep((Math.random() < 0.6 ? rnd(3, 20) : rnd(15, 240)) * 1000); }
    else {
      if (Date.now() - idleSince > 4 * CONFIRM_TIMEOUT_MS) { log('no spendable wallet for too long; stopping pays'); break; }
      await sleep(90_000);
    }
  }
  log(`pays: ${state.pays.filter((p) => p.state === 'done').length} done, ${state.pays.filter((p) => p.state === 'failed').length} failed`);
}

async function ensureMakerBinds(k) {
  const st = state.makerBinds ||= { coins: [] };
  if (!st.txid) {
    const r = await fundingSend(Array.from({ length: k }, () => ({ value: MAKER_BIND_COIN, script: FUND.spk })));
    Object.assign(st, r, { coins: Array.from({ length: k }, (_, v) => ({ txid: r.txid, vout: v, value: MAKER_BIND_COIN, used: false })) });
    saveState();
  }
  await broadcastHex(st.hex, st.txid, `maker bind coins (${k} × ${MAKER_BIND_COIN})`);
  if (!st.height) { st.height = await waitConfirmed(st.txid, 'maker binds'); saveState(); }
  return st;
}

async function oneExit(i, mode, notes, tip) {
  const { pw } = walletOf(i);
  const w = state.wallets[i];
  const anchorMode = pickMode();
  const sp = await spendable(i, notes, tip, anchorMode);
  const bal = sumV(sp);
  const fee = mode === 'relay' ? BigInt(relayInfoCache.fees?.['0x' + ASSET] ?? 0) : 0n;
  if (bal < 1_000n + fee) return null;
  const amount = BigInt(Math.max(500, Math.floor(Number(bal - fee) * (0.3 + Math.random() * 0.4))));
  const a0 = pool.selectInputs(sp, amount + fee, { asset: '0x' + ASSET });
  const a = await anchorFor(a0.inputs, anchorMode);
  if (!a) return null;
  const used = new Set(w.usedExitScripts || []);
  const id = `x${state.exits.length}`;
  const rec = { id, anchorMode, from: i, mode, amount: amount.toString(), fee: fee.toString(), builtAt: new Date().toISOString(), state: 'building', hAnchor: a.hAnchor, root: a.root, tipAtBuild: a.tip };
  let built, pr, maker = null, bindCoin = null, q = null, payout = null;
  if (mode === 'maker') {
    const mb = state.makerBinds;
    bindCoin = mb.coins.find((c) => !c.used);
    if (!bindCoin) throw new Error('no maker bind coin left');
    maker = { spk: '0x' + bytesToHex(FUND.spk), sats: MAKER_WANT_SATS, vout: 1, exitVout: 0, bind: { txid: bindCoin.txid, vout: bindCoin.vout } };
    const r = zap.exitToSats({ pool, wallet: pw, notes: a.notes, amount, maker, asset: '0x' + ASSET, hAnchor: a.hAnchor, root: a.root, usedScripts: used });
    built = r.spend; payout = r.payout;
    Object.assign(rec, { offer: r.offer, payoutSpk: r.payout.scriptPubKey, payoutCounter: r.payout.counter, wantSats: MAKER_WANT_SATS.toString(), wantVout: 1, exitVout: 0, exitSpk: bytesToHex(FUND.spk), bind: maker.bind });
  } else {
    payout = pool.freshExitKey(pw, used);
    q = await relay.quote({ asset: '0x' + ASSET, exitScriptPubKey: payout.scriptPubKey });
    const mk = (exitVout) => {
      const change = a0.total - amount - fee;
      const outs = [{ address: q.address, value: fee }];
      if (change > 0n) outs.push({ address: pw.internalAddress, network: 'signet', value: change });
      while (outs.length < 3) outs.push({ address: pw.internalAddress, network: 'signet', value: 0n });
      outs.sort(() => Math.random() - 0.5);
      return pool.buildSpendBody({ asset: '0x' + ASSET, hAnchor: a.hAnchor, root: a.root, inputs: a.notes, outputs: outs, wallet: pw, bind: q.bind, usedScripts: new Set(used), exit: { exitVout, scriptPubKey: payout.scriptPubKey, value: amount } });
    };
    built = mk(q.exitVout);
    Object.assign(rec, { exitVout: q.exitVout, exitSpk: strip(payout.scriptPubKey), payoutCounter: payout.counter, bind: q.bind, quoteId: q.quoteId });
  }
  Object.assign(rec, {
    inputTotal: a0.total.toString(), nIn: a0.inputs.length, nOut: built.outputs.length, inputLeaves: a0.inputs.map((x) => x.leafIndex),
    inputHeights: a0.inputs.map((x) => x.height), nullifiers: built.nullifiers, cx: built.exit.cx, cy: built.exit.cy, blinding: built.exit.blinding,
    outputLeaves: built.outputs.map((o) => o.leaf), outputValues: built.outputs.map((o) => o.value.toString()),
  });
  pr = await proveTimed(built);
  rec.proveSeconds = pr.seconds; rec.payloadBytes = pr.payload.length;
  if (mode === 'relay') {
    let r;
    try { r = await relay.submit({ payload: bytesToHex(pr.payload), quoteId: q.quoteId }); }
    catch (e) {
      if (e.status === 409 && e.body?.exitVout != null) {
        log(`exit ${id}: relayer asks exit_vout ${e.body.exitVout}; re-signing`);
        built = (() => { const change = a0.total - amount - fee; const outs = [{ address: q.address, value: fee }]; if (change > 0n) outs.push({ address: pw.internalAddress, network: 'signet', value: change }); while (outs.length < 3) outs.push({ address: pw.internalAddress, network: 'signet', value: 0n }); return pool.buildSpendBody({ asset: '0x' + ASSET, hAnchor: a.hAnchor, root: a.root, inputs: a.notes, outputs: outs, wallet: pw, bind: q.bind, usedScripts: new Set(used), exit: { exitVout: e.body.exitVout, scriptPubKey: payout.scriptPubKey, value: amount } }); })();
        pr = await proveTimed(built);
        Object.assign(rec, { exitVout: e.body.exitVout, nullifiers: built.nullifiers, cx: built.exit.cx, cy: built.exit.cy, blinding: built.exit.blinding, outputLeaves: built.outputs.map((o) => o.leaf), outputValues: built.outputs.map((o) => o.value.toString()), reproveSeconds: pr.seconds });
        r = await relay.submit({ payload: bytesToHex(pr.payload), quoteId: q.quoteId });
      } else {
        Object.assign(rec, { state: 'failed', reason: `submit: ${e.status || ''} ${e.message}` });
        state.exits.push(rec); saveState();
        log(`exit ${id}: ${rec.reason}`);
        return rec;
      }
    }
    Object.assign(rec, { relayId: r.id, batchId: r.batchId, state: 'submitted', submittedAt: new Date().toISOString() });
  } else {
    // Maker side: validate the offer and the proof natively, then build and post the carrier from its own coins.
    const v = await zap.validateExitToSats({ pool, payload: pr.payload, offer: rec.offer, maker, amount, asset: '0x' + ASSET, root: a.root, verify: verifier.verify });
    const outputs = zap.makerCarrierOutputs({ exitVout: v.exitVout, wantVout: v.wantVout, wantValue: v.wantValue, payoutScriptPubKey: v.payoutScriptPubKey, makerSpk: FUND.spk, exitSats: dapp.DUST })
      .map((o) => ({ value: Number(o.value), script: o.script }));
    const coins = await fundingCoins([`${bindCoin.txid}:${bindCoin.vout}`]);
    const c = await buildCarrier({ signer: FUND, coins, payload: pr.payload, extraInputs: [{ txid: bindCoin.txid, vout: bindCoin.vout, value: bindCoin.value, priv: FUND.priv, pub: FUND.pub }], outputs });
    bindCoin.used = true;
    Object.assign(rec, { commitTxid: c.commitTxid, carrierBuilt: c.revealTxid, makerFees: c.commitFee + c.revealFee, state: 'submitted', submittedAt: new Date().toISOString() });
    state.exits.push(rec); saveState();
    await broadcastHex(c.commitHex, c.commitTxid, `exit ${id} maker commit`);
    await broadcastHex(c.revealHex, c.revealTxid, `exit ${id} maker carrier`, async () => txKnown(c.commitTxid));
    rec.carrier = c.revealTxid;
    saveState();
  }
  if (!state.exits.includes(rec)) state.exits.push(rec);
  w.usedExitScripts = [...new Set([...(w.usedExitScripts || []), payout.destSpkHash])];
  saveState();
  log(`exit ${id} (${mode}): w${i} exits ${amount} of ${bal} units; ${rec.nIn} in, ${rec.nOut} internal out; proved ${rec.proveSeconds} s; ${rec.state}`);
  return rec;
}

async function stageExit() {
  console.log('\n--- exit (about a third of the wallets, partial, private change kept) ---');
  state.exits ||= [];
  const exiters = state.wallets.filter((w) => w.i % 3 === 0).map((w) => w.i);
  const modeOf = (i, k) => (k % 2 === 0 ? 'maker' : 'relay');
  const plan = exiters.map((i, k) => ({ i, mode: modeOf(i, k) }));
  await ensureMakerBinds(plan.filter((p) => p.mode === 'maker').length);
  const t0 = Date.now();
  for (;;) {
    const notes = await feed();
    await settle(notes);
    const left = plan.filter((p) => !state.exits.some((x) => x.from === p.i && x.state !== 'failed'));
    const open = state.exits.filter((x) => OPEN.has(x.state)).length;
    if (!left.length && !open) break;
    if (Date.now() - t0 > 6 * CONFIRM_TIMEOUT_MS) { log('exit phase timed out'); break; }
    const tip = (await poolStatus()).height;
    const up = await relayUp();
    let did = false;
    for (const p of left) {
      if (busy(p.i)) continue;
      const mode = p.mode === 'relay' && !up ? 'maker' : p.mode;
      if (mode === 'maker' && !state.makerBinds.coins.some((c) => !c.used)) continue;
      try { if (await oneExit(p.i, mode, notes, tip)) { did = true; break; } }
      catch (e) { log(`exit w${p.i}: ${e.message}`); (state.exitErrors ||= []).push({ at: new Date().toISOString(), wallet: p.i, error: e.message }); saveState(); }
    }
    await sleep(did ? rnd(20, 120) * 1000 : 90_000);
  }
  log(`exits: ${state.exits.filter((x) => x.state === 'done').length} done, ${state.exits.filter((x) => x.state === 'failed').length} failed`);
}

async function stageVerify() {
  console.log('\n--- verify (every wallet scans /btc-pool/notes) ---');
  const notes = await feed();
  await settle(notes);
  const s = await poolStatus();
  const rows = [];
  let ok = true;
  for (const w of state.wallets) {
    const mine = await notesOf(walletOf(w.i).pw, notes);
    const unspent = mine.filter((x) => !x.spent);
    const got = sumV(unspent), want = led(wKey(w.i));
    const open = busy(w.i);
    rows.push({ wallet: w.i, notes: mine.length, unspent: unspent.length, balance: got.toString(), expected: want.toString(), open });
    if (got !== want && !open) { ok = false; log(`w${w.i}: balance ${got} != expected ${want}`); }
  }
  for (let k = 0; k < (state.third || []).length; k++) {
    const mine = pool.scan(thirdOf(k), notes);
    const got = sumV(mine), want = led(tKey(k));
    rows.push({ third: k, notes: mine.length, balance: got.toString(), expected: want.toString() });
    if (got !== want) { ok = false; log(`t${k}: balance ${got} != expected ${want}`); }
  }
  // Every recorded nullifier resolves to its carrier; every recorded leaf is in the feed.
  const leaves = new Set(notes.map((n) => strip(n.leaf)));
  for (const r of [...state.pays, ...state.exits].filter((x) => x.state === 'done')) {
    for (const l of r.outputLeaves) if (!leaves.has(strip(l))) { ok = false; log(`${r.id}: output leaf ${short(l)} missing from the feed`); }
  }
  state.verify = { at: new Date().toISOString(), ok, leafCount: s.leafCount, feedCount: notes.length, root: s.root, height: s.height, rows };
  saveState();
  const total = rows.filter((r) => r.wallet != null).reduce((t, r) => t + BigInt(r.balance), 0n);
  log(`verify ${ok ? 'OK' : 'MISMATCH'}: leafCount ${s.leafCount} (feed ${notes.length}), root ${short(s.root)} @${s.height}; swarm holds ${total} units, third parties ${rows.filter((r) => r.third != null).reduce((t, r) => t + BigInt(r.balance), 0n)}`);
  if (s.leafCount !== notes.length) log(`leafCount ${s.leafCount} != feed length ${notes.length}`);
  return ok;
}

// ── audit: public data only, then scored against the ground truth ──
async function rawTx(txid) { return parseTx(hexToBytes((await esplora(`/tx/${txid}/hex`)).trim())).tx; }
async function stageAudit() {
  console.log('\n--- audit (public chain data + indexer endpoints) ---');
  const notes = await feed();
  const status = await poolStatus();
  const byTx = new Map();
  for (const n of notes) { if (!byTx.has(n.txid)) byTx.set(n.txid, []); byTx.get(n.txid).push(n); }
  const heightOfLeaf = notes.map((n) => n.height);
  const leafCountAt = (h) => notes.filter((n) => n.height <= h).length;
  const leafSet = new Set(notes.map((n) => strip(n.leaf)));
  const pub = { carriers: [], shields: [], spends: [] };
  const swarmT = new Set(state.wallets.map((w) => bytesToHex(walletOf(w.i).tk.spk)));
  const fundSpk = bytesToHex(FUND.spk);
  for (const [txid, rows] of byTx) {
    const tx = await rawTx(txid);
    const ej = await esploraJson(`/tx/${txid}`);
    const envs = txEnvelopes(tx);
    const carrier = { txid, height: rows[0].height, inputs: ej.vin.map((v) => ({ op: `${v.txid}:${v.vout}`, spk: v.prevout?.scriptpubkey, addr: v.prevout?.scriptpubkey_address, value: v.prevout?.value })), outputs: ej.vout.map((o) => ({ value: o.value, spk: o.scriptpubkey, addr: o.scriptpubkey_address })), envelopes: [] };
    // The commit transaction(s) funding the envelope inputs.
    const commitIds = [...new Set(envs.map((e, k) => (e ? ej.vin[k].txid : null)).filter(Boolean))];
    carrier.commitFunders = [];
    for (const c of commitIds) {
      const cj = await esploraJson(`/tx/${c}`);
      for (const v of cj.vin) carrier.commitFunders.push({ spk: v.prevout?.scriptpubkey, addr: v.prevout?.scriptpubkey_address, value: v.prevout?.value });
    }
    envs.forEach((e, k) => {
      if (!e) return;
      const b = e.payload;
      if (e.opcode === 0x6c) {
        const sh = pool.parseShield(b);
        const lot = ej.vin[1];
        const rec = { txid, vin: k, kind: 'shield', nOut: sh.outputs.length, leaves: sh.outputs.map((o) => o.leaf), lot: lot ? `${lot.txid}:${lot.vout}` : null, bytes: b.length };
        carrier.envelopes.push(rec); pub.shields.push(rec);
      } else if (e.opcode === 0x6d) {
        const sp = pool.parseSpend(b, { full: true });
        const rec = {
          txid, vin: k, kind: 'spend', hAnchor: sp.hAnchor, bind: sp.bind, nIn: sp.nullifiers.length, nullifiers: sp.nullifiers, nOut: sp.outputs.length,
          leaves: sp.outputs.map((o) => o.leaf), exit: sp.exit ? { vout: sp.exit.exitVout, destSpkHash: sp.exit.destSpkHash } : null,
          want: sp.want ? { vout: sp.want.vout, value: sp.want.value.toString(), spkHash: sp.want.spkHash } : null, bytes: b.length,
          anonSet: leafCountAt(sp.hAnchor), leafIndexesInTx: rows.map((r) => r.leafIndex),
          bindSpent: sp.bind ? ej.vin.some((v) => v.txid === sp.bind.txid && v.vout === sp.bind.vout) : null,
          nfIsLeaf: sp.nullifiers.some((nf) => leafSet.has(strip(nf))),
        };
        carrier.envelopes.push(rec); pub.spends.push(rec);
      }
    });
    carrier.fundedBySwarmKey = [...carrier.commitFunders, ...carrier.inputs].some((x) => swarmT.has(strip(x.spk || '')));
    carrier.fundedByFundingWallet = [...carrier.commitFunders, ...carrier.inputs].some((x) => strip(x.spk || '') === fundSpk);
    pub.carriers.push(carrier);
  }

  // ── ground truth scoring ──
  const truth = [...state.pays, ...state.exits].filter((r) => r.state === 'done');
  const byNf = new Map(pub.spends.flatMap((s) => s.nullifiers.map((nf) => [strip(nf), s])));
  const leafIndexOf = new Map(notes.map((n) => [strip(n.leaf), n.leafIndex]));
  const scored = [];
  let amountLeaks = 0;
  for (const r of truth) {
    const s = byNf.get(strip(r.nullifiers[0]));
    if (!s) { scored.push({ id: r.id, missing: true }); continue; }
    const eligible = notes.filter((n) => n.height <= s.hAnchor);
    const byRecency = [...eligible].sort((x, y) => y.leafIndex - x.leafIndex);
    const ranks = r.inputLeaves.map((li) => byRecency.findIndex((n) => n.leafIndex === li) + 1);
    const top = eligible.filter((n) => n.height === Math.max(...eligible.map((e) => e.height)));
    const freshestHit = r.inputLeaves.some((li) => top.some((n) => n.leafIndex === li)) ? 1 / top.length : 0;
    // Plaintext value search: any true output or exit amount as 8-byte LE or BE in the envelope bytes.
    const tx = await rawTx(s.txid);
    const env = txEnvelopes(tx)[s.vin];
    const hexp = bytesToHex(env.payload);
    const vals = [...r.outputValues, r.amount].map(BigInt).filter((v) => v > 0n);
    const leaks = vals.filter((v) => { const le = new Uint8Array(8); new DataView(le.buffer).setBigUint64(0, v, true); const be = le.slice().reverse(); return hexp.includes(bytesToHex(le)) || hexp.includes(bytesToHex(be)); });
    if (s.want) leaks.push(`want ${s.want.value} sats (public by design)`);
    amountLeaks += leaks.filter((x) => typeof x === 'bigint').length;
    const shieldInputs = r.inputLeaves.filter((li) => pub.shields.some((sh) => sh.leaves.some((l) => leafIndexOf.get(strip(l)) === li)));
    scored.push({
      id: r.id, anchorMode: r.anchorMode, txid: s.txid, hAnchor: s.hAnchor, anonSet: s.anonSet, eligibleShields: eligible.filter((n) => pub.shields.some((sh) => sh.txid === n.txid)).length,
      nIn: r.nIn, ranks, freshestHit, inputAgeBlocks: r.inputHeights.map((h) => s.hAnchor - h), shieldInputs: shieldInputs.length,
      plaintextAmounts: leaks.map(String), sameCarrierAs: pub.spends.filter((x) => x.txid === s.txid && x !== s).length,
    });
  }
  const med = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
  const allRanks = scored.flatMap((x) => x.ranks || []);
  const relayCarriers = pub.carriers.filter((c) => c.envelopes.some((e) => e.kind === 'spend') && !c.fundedByFundingWallet);
  const makerCarriers = pub.carriers.filter((c) => c.envelopes.some((e) => e.kind === 'spend') && c.fundedByFundingWallet);
  const relayerAddrs = [...new Set(relayCarriers.flatMap((c) => c.commitFunders.map((f) => f.addr)))];
  const summary = {
    at: new Date().toISOString(), indexer: status,
    leafCount: notes.length, shieldCarriers: pub.carriers.filter((c) => c.envelopes.some((e) => e.kind === 'shield')).length,
    spendEnvelopes: pub.spends.length, relayCarriers: relayCarriers.length, makerCarriers: makerCarriers.length,
    batchedCarriers: relayCarriers.filter((c) => c.envelopes.length > 1).map((c) => ({ txid: c.txid, envelopes: c.envelopes.length })),
    relayCarrierFundedBySwarmKey: relayCarriers.filter((c) => c.fundedBySwarmKey).map((c) => c.txid),
    relayerFundingAddresses: relayerAddrs,
    nullifierEqualsALeaf: pub.spends.filter((s) => s.nfIsLeaf).length,
    bindsSpentByCarrier: pub.spends.filter((s) => s.bind && s.bindSpent).length + '/' + pub.spends.filter((s) => s.bind).length,
    wantsVisible: pub.spends.filter((s) => s.want).map((s) => ({ txid: s.txid, sats: s.want.value })),
    exitsVisible: pub.spends.filter((s) => s.exit).map((s) => ({ txid: s.txid, vout: s.exit.vout })),
    plaintextAmountHits: amountLeaks,
    anonSet: { min: Math.min(...scored.map((x) => x.anonSet ?? Infinity)), median: med(scored.map((x) => x.anonSet).filter((x) => x != null)), max: Math.max(...scored.map((x) => x.anonSet ?? 0)) },
    recencyRankByMode: Object.fromEntries(['policy', 'latest'].map((m) => { const rs = scored.filter((x) => x.anchorMode === m).flatMap((x) => x.ranks || []); return [m, { n: rs.length, median: med(rs), top1: rs.filter((r) => r === 1).length, top5: rs.filter((r) => r <= 5).length }]; })),
    recencyRank: { median: med(allRanks), top1: allRanks.filter((r) => r === 1).length, top5: allRanks.filter((r) => r <= 5).length, n: allRanks.length },
    freshestHeuristicExpectedHits: Number(scored.reduce((t, x) => t + (x.freshestHit || 0), 0).toFixed(2)) + '/' + scored.length,
    inputAgeBlocks: { min: Math.min(...scored.flatMap((x) => x.inputAgeBlocks || [])), median: med(scored.flatMap((x) => x.inputAgeBlocks || [])) },
    firstSpendFromShield: scored.filter((x) => x.shieldInputs > 0).length,
    proveSeconds: { median: med([...state.pays, ...state.exits].map((x) => x.proveSeconds).filter(Boolean)), max: Math.max(...[...state.pays, ...state.exits].map((x) => x.proveSeconds || 0)) },
  };
  writeFileSync(AUDIT_FILE, jsonOut({ summary, scored, public: pub }), { mode: 0o600 });
  state.audit = summary;
  saveState();
  console.log(jsonOut(summary));
  log(`audit written to ${AUDIT_FILE}`);
}

async function stageStatus() {
  console.log('\n--- status ---');
  const s = await poolStatus();
  log(`indexer ${JSON.stringify(s)}`);
  log(`relayer ${(await relayUp()) ? JSON.stringify(relayInfoCache) : 'not available'}`);
  log(`joined ${state.wallets?.filter((w) => w.join?.broadcast).length || 0}/${state.wallets?.length || 0}, indexed ${state.wallets?.filter((w) => w.join?.leafIndex != null).length || 0}`);
  const cnt = (xs, st) => xs.filter((x) => x.state === st).length;
  log(`pays: ${cnt(state.pays || [], 'done')} done, ${(state.pays || []).filter((p) => OPEN.has(p.state)).length} open, ${cnt(state.pays || [], 'failed')} failed`);
  log(`exits: ${cnt(state.exits || [], 'done')} done, ${(state.exits || []).filter((p) => OPEN.has(p.state)).length} open, ${cnt(state.exits || [], 'failed')} failed`);
  for (const p of [...(state.pays || []), ...(state.exits || [])].filter((x) => x.state === 'failed')) log(`  ${p.id}: ${p.reason}`);
}

const STAGES = { reseed: stageReseed, init: stageInit, fund: stageFund, join: stageJoin, pay: stagePay, exit: stageExit, verify: stageVerify, audit: stageAudit, status: stageStatus };
const want = process.argv[2] || 'all';
console.log(`=== secret sats swarm (${want}) ===`);
console.log(`  funding ${W.address}  pool ${POOL_API}  relay ${RELAY_API}  anchor ${ANCHOR}`);
console.log(`  state   ${STATE_FILE}`);
if (want !== 'init' && !state.wallets) await stageInit();
if (want === 'all') for (const s of ['init', 'fund', 'join', 'pay', 'exit', 'verify', 'audit']) await STAGES[s]();
else if (want === 'reseed-all') for (const s of ['reseed', 'join', 'pay', 'exit', 'verify', 'audit']) await STAGES[s]();
else {
  if (!STAGES[want]) throw new Error(`unknown stage ${want}`);
  await STAGES[want]();
}
process.exit(0);
