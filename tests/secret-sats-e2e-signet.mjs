// Secret Sats end to end on signet with real transactions and client proofs (DESIGN-btc-shielded-pool.md §3–§9,
// carrier binding and payout condition). Every proof is made here, with the wallet and client modules the
// browser runs (dapp/btc-shielded-pool.js, dapp/btc-pool-client.js) and the pinned signet key.
//
//   node tests/secret-sats-e2e-signet.mjs [fund|join|pay|exit|report|all]   (default: all, resumable)
//
// fund  the funding wallet sends Alice's transparent key ~20,000 sats, and in a separate transaction funds a
//       fresh relay key with a carrier coin and a bind coin.
// join  buyAndShield: Alice takes one faucet sale and shields its lot in one carrier (vin[0] shield envelope,
//       vin[1]/vout[1] the seller's SIGHASH_SINGLE|ANYONECANPAY lot and payout); the shield carries its proof.
// pay   Alice pays Bob 6,000 units under the wallet defaults (anchor policy, internal change, padding to 3).
//       PAY_VIA=relayer (default): the pool relayer (RELAY_API) quotes a fee and a bind, Alice adds the fee
//       output, proves, and submits; the relayer posts the carrier. PAY_VIA=key: a fresh relay key funded here
//       posts the carrier; bind names its bind coin, which the carrier spends.
// exit  Bob exits 4,000 units via exitToSats to the funding wallet acting as maker, wanting 2,000 sats to a
//       fresh exit key; the maker validates the offer, builds the carrier with makerCarrierOutputs and pays the
//       want. Bob keeps 2,000 units as an internal change note.
// Every stage is confirmed against the pool indexer (BTC_POOL_API).
//
// Anchor: ANCHOR=policy uses the wallet default (tip − 6 rounded down to 6, so a fresh note waits 6–11 blocks);
// ANCHOR=latest (default) anchors at the replayed tip, which the indexer accepts the same way.
//
// Env: BTC_POOL_API, RELAY_API, PAY_VIA, ESPLORA (default blockstream signet), STATE_FILE, ANCHOR,
// CONFIRM_TIMEOUT_MIN (default 90), FEE_RATE (sat/vB, default 2).
import { JSDOM } from 'jsdom';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME_V = path.join(os.homedir(), '.tacit-validation');
const STATE_FILE = process.env.STATE_FILE || path.join(HOME_V, 'secret-sats-e2e-state.json');
const WALLET_FILE = path.join(HOME_V, 'signet.json');
const POOL_API = (process.env.BTC_POOL_API || 'https://tacit-btc-pool.onrender.com').replace(/\/$/, '');
const FAUCET = (process.env.SATS_FAUCET || 'https://tacit-sats-faucet.onrender.com').replace(/\/$/, '');
const ESPLORA = (process.env.ESPLORA || 'https://blockstream.info/signet/api').replace(/\/$/, '');
const RELAY_API = (process.env.RELAY_API || 'https://tacit-btc-pool-relay.onrender.com').replace(/\/$/, '');
const PAY_VIA = process.env.PAY_VIA || 'relayer';
if (!['relayer', 'key'].includes(PAY_VIA)) throw new Error('PAY_VIA must be relayer or key');
const ANCHOR = process.env.ANCHOR || 'latest';
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
const ART = path.join(ROOT, 'dapp/btc-pool');
const client = makePoolClient({ api: POOL_API, readFile: (n) => readFileSync(path.join(ART, n)), fetchImpl: (...a) => realFetch(...a) });
const relayClient = makePoolClient({ api: RELAY_API, readFile: (n) => readFileSync(path.join(ART, n)), fetchImpl: (...a) => realFetch(...a) });
const verifier = makeBtcPoolVerifier({ network: 'signet', log: () => {} });
if (!verifier.enabled) throw new Error(`verifier: ${verifier.reason}`);

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
const allNotes = () => client.allNotes();
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
// Anchor, root and paths for `notes`: the replayed tip (ANCHOR=latest) or the wallet policy, waiting for it.
async function anchorAndPaths(notes, label) {
  const t0 = Date.now();
  for (;;) {
    const s = await poolStatus();
    const r = await client.anchorAndPaths(notes, ANCHOR === 'latest' ? { anchor: s.height } : {});
    if (!r.wait) {
      for (const n of r.notes) if (strip(pool.merkleRootFrom(n.leaf, n.leafIndex, n.path)) !== strip(r.root)) throw new Error('indexer path does not reach its root');
      log(`${label}: tip ${r.tip}, anchor ${r.hAnchor} (${ANCHOR}), root ${r.root}`);
      return r;
    }
    if (Date.now() - t0 > 4 * CONFIRM_TIMEOUT_MS) throw new Error(`anchor policy did not reach ${r.need}`);
    log(`${label}: tip ${r.tip}, the policy anchor needs ${r.wait} more block(s); waiting`);
    await sleep(60_000);
  }
}
async function proveTimed(label, built, st) {
  const system = await client.system();
  const t0 = performance.now();
  const r = await pool.prove(built, system);
  st.proveSeconds = Number(((performance.now() - t0) / 1000).toFixed(2));
  st.proofBytes = r.proof.length;
  st.system = system.id;
  st.vkHash = system.vkHash;
  saveState();
  log(`${label}: proved in ${st.proveSeconds} s (${system.id}, ${r.proof.length}-byte proof, payload ${r.payload.length} bytes)`);
  return r;
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
  if (PAY_VIA === 'key' && !st.relay) {
    // A separate, later transaction: the relay's coins share nothing with Alice's funding.
    const r = await fundingSend([{ value: RELAY_CARRIER_COIN, script: relay.spk }, { value: RELAY_BIND_COIN, script: relay.spk }]);
    st.relay = { ...r, bind: { txid: r.txid, vout: 1, value: RELAY_BIND_COIN } };
    saveState();
  }
  if (st.relay) await broadcastHex(st.relay.hex, st.relay.txid, 'fund relay');
  if (!st.aliceHeight) { st.aliceHeight = await waitConfirmed(st.alice.txid, 'fund Alice'); saveState(); }
  if (st.relay && !st.relayHeight) { st.relayHeight = await waitConfirmed(st.relay.txid, 'fund relay'); saveState(); }
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
    const system = await client.system();
    const t0 = performance.now();
    const r = await zap.buyAndShield({
      tacit: { ...dapp, wallet: dapp.wallet, resolveNote },
      pool, sale, wallet: { utxos, feeRate: await feeRate() }, recipientAddress: alice.addressString, system,
    });
    const { value, ...fields } = r.note;
    Object.assign(st, {
      saleId: sale.sale_id, lot: sale.asset_outpoint, price: sale.min_price_sats, sellerPayout: sale.seller_payout_script, faucetTakesBefore: status.taken_total,
      commitTxid: r.commitTxid, commitHex: r.commitHex, revealTxid: r.carrierTxid, revealHex: r.carrierHex,
      commitFee: r.commitFee, revealFee: r.revealFee, payloadBytes: r.shield.payload.length, note: fields, noteValue: value,
      buildAndProveSeconds: Number(((performance.now() - t0) / 1000).toFixed(2)), system: system.id, vkHash: system.vkHash,
    });
    saveState();
    const mine = pool.scan(alice, [r.note]);
    if (mine.length !== 1 || mine[0].value !== BigInt(sale.asset_opening.amount)) throw new Error('Alice does not receive her shield note');
    if (!(await pool.verifyPayload(system, r.shield.payload))) throw new Error('shield payload does not verify');
    log(`shield built and proved in ${st.buildAndProveSeconds} s, payload ${st.payloadBytes} bytes; Alice receives ${mine[0].value} units`);
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

// Scans the feed for a wallet's notes, each with its nullifier and spent flag.
const walletNotes = (w) => client.walletNotes(pool, w);

async function stagePay() {
  console.log(`\n--- pay (Alice → Bob, ${PAY_VIA === 'relayer' ? `relayed by ${RELAY_API}` : 'relay-key carrier with bind'}) ---`);
  const st = state.pay || (state.pay = {});
  if (!st.revealHex && !st.submitId) {
    const q = PAY_VIA === 'relayer' ? await relayClient.quote({ asset: '0x' + ASSET }) : null;
    const fee = q ? BigInt(q.fee) : 0n;
    const unspent = (await walletNotes(alice)).filter((x) => !x.spent);
    const { inputs } = pool.selectInputs(unspent, PAY_TO_BOB + fee, { asset: '0x' + ASSET });
    if (inputs.length !== 1) throw new Error(`expected Alice's first spend to have 1 input, got ${inputs.length}`);
    const a = await anchorAndPaths(inputs, 'pay');
    const outputs = [{ address: bob.addressString, value: PAY_TO_BOB }];
    if (q) outputs.push({ address: q.address, value: fee });
    const built = pool.buildSpendBody({
      asset: '0x' + ASSET, hAnchor: a.hAnchor, root: a.root,
      inputs: a.notes, outputs, wallet: alice,
      bind: q ? q.bind : { txid: state.fund.relay.bind.txid, vout: state.fund.relay.bind.vout },
    });
    const toBob = pool.scan(bob, built.outputs);
    const own = pool.scan(alice, built.outputs);
    if (toBob.length !== 1 || toBob[0].value !== PAY_TO_BOB) throw new Error('Bob does not receive the pay output');
    if (!own.length || !own.every((x) => x.internal) || own.reduce((t, x) => t + x.value, 0n) !== inputs[0].value - PAY_TO_BOB - fee) throw new Error('Alice does not receive change and padding internally');
    if (pool.scan(pool.viewWallet(alice), built.outputs).length !== 0) throw new Error('change is visible to the incoming-only view key');
    Object.assign(st, {
      via: PAY_VIA, quote: q, relayFee: fee,
      bodyHex: built.bodyHex, root: a.root, hAnchor: built.hAnchor, tipAtBuild: a.tip, bind: built.bind,
      nIn: inputs.length, nOut: built.outputs.length, nullifiers: built.nullifiers,
      outputs: built.outputs.map(({ value, npk, rho, ...f }) => f), inputLeaf: inputs[0].leafIndex,
    });
    saveState();
    log(`pay body ${hexToBytes(strip(built.bodyHex)).length} bytes: 1 input, ${built.outputs.length} outputs (Bob ${PAY_TO_BOB}${q ? `, relayer fee ${fee}` : ''}, change ${inputs[0].value - PAY_TO_BOB - fee}), bind ${built.bind.txid}:${built.bind.vout}`);
    const { payload, payloadHex } = await proveTimed('pay', built, st);
    const pp = pool.payloadPublics(payload, { root: a.root });
    if (!(await verifier.verify({ proof: hexToBytes(strip(pp.parsed.proof)), publics: pp.publics }))) throw new Error('pay payload does not verify natively');
    st.payloadBytes = payload.length;
    if (q) {
      const sub = await relayClient.submit({ payload: payloadHex, quoteId: q.quoteId });
      st.submitId = sub.id; st.batchId = sub.batchId;
      saveState();
      log(`submitted to the relayer: payload ${sub.id}, batch ${sub.batchId}`);
    } else {
      const coins = (await utxosOf(relay.spk)).filter((u) => !(u.txid === st.bind.txid && u.vout === st.bind.vout));
      const r = await buildCarrier({
        signer: relay, coins, payload,
        extraInputs: [{ txid: st.bind.txid, vout: st.bind.vout, value: state.fund.relay.bind.value, priv: relay.priv, pub: relay.pub }],
        outputs: [{ value: dapp.DUST, script: relay.spk }],
      });
      Object.assign(st, r);
      saveState();
    }
  }
  if (st.submitId && !st.revealTxid) {
    const t0 = Date.now();
    for (;;) {
      const s = await relayClient.relayStatus(st.submitId);
      if (s.carrier) { st.revealTxid = s.carrier; st.commitTxid = s.commit; st.broadcast = true; saveState(); log(`relayer posted the carrier ${link(s.carrier)} (commit ${s.commit})`); break; }
      if (['dropped', 'rejected'].includes(s.state)) throw new Error(`relayer ${s.state} the pay: ${s.reason}`);
      if (Date.now() - t0 > CONFIRM_TIMEOUT_MS) throw new Error('relayer did not post the carrier');
      await sleep(10_000);
    }
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
  if (!st.revealHex) {
    const unspent = (await walletNotes(bob)).filter((x) => !x.spent);
    if (unspent.length !== 1) throw new Error(`Bob should hold one note, has ${unspent.length}`);
    const a = await anchorAndPaths(unspent, 'exit');
    const used = new Set(st.usedScripts || []);
    const r = zap.exitToSats({ pool, wallet: bob, notes: a.notes, amount: EXIT_AMOUNT, maker, asset: '0x' + ASSET, hAnchor: a.hAnchor, root: a.root, usedScripts: used });
    const change = pool.scan(bob, r.spend.outputs);
    if (change.reduce((t, x) => t + x.value, 0n) !== unspent[0].value - EXIT_AMOUNT || !change.every((x) => x.internal)) throw new Error('Bob does not keep his change internally');
    Object.assign(st, {
      bodyHex: r.spend.bodyHex, root: a.root, hAnchor: r.spend.hAnchor, tipAtBuild: a.tip, bind: r.spend.bind,
      nIn: 1, nOut: r.spend.outputs.length, nullifiers: r.spend.nullifiers,
      outputs: r.spend.outputs.map(({ value, npk, rho, ...f }) => f),
      exit: { exitVout: r.spend.exit.exitVout, cx: r.spend.exit.cx, cy: r.spend.exit.cy, destSpkHash: r.spend.exit.destSpkHash },
      want: r.spend.want, offer: r.offer, payout: { counter: r.payout.counter, scriptPubKey: r.payout.scriptPubKey, outputKey: r.payout.outputKey },
      usedScripts: [...used],
    });
    saveState();
    log(`exit body ${hexToBytes(strip(r.spend.bodyHex)).length} bytes: exit ${EXIT_AMOUNT} at vout 0 to the maker, want ${EXIT_SATS} sats at vout 1 to Bob's exit key #${r.payout.counter}, ${r.spend.outputs.length} internal outputs`);
    const { payload } = await proveTimed('exit', r.spend, st);
    // Maker side: check the offer, the exit boundary and the proof natively before paying anything.
    const v = await zap.validateExitToSats({ pool, payload, offer: st.offer, maker, amount: EXIT_AMOUNT, asset: '0x' + ASSET, root: st.root, verify: verifier.verify });
    st.makerVerifiedProof = true;
    log('maker validated the offer, the exit boundary and the proof natively');
    const outputs = zap.makerCarrierOutputs({ exitVout: v.exitVout, wantVout: v.wantVout, wantValue: v.wantValue, payoutScriptPubKey: v.payoutScriptPubKey, makerSpk: FUND.spk, exitSats: dapp.DUST })
      .map((o) => ({ value: Number(o.value), script: o.script }));
    const coins = await fundingCoins([`${makerBind.txid}:${makerBind.vout}`]);
    const c = await buildCarrier({
      signer: FUND, coins, payload,
      extraInputs: [{ txid: makerBind.txid, vout: makerBind.vout, value: makerBind.value, priv: FUND.priv, pub: FUND.pub }],
      outputs,
    });
    Object.assign(st, c, { payloadBytes: payload.length });
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
