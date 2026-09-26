// Back to sats on signet, the way /sats runs it: a fresh wallet buys a faucet lot straight into the pool
// (dapp/sats/secret.js buyAndShield), then sells part of it to the faucet's maker (secret.js sellForSats) and
// keeps the change private. Proofs are made here with the page's own client and the pinned system; the funding
// wallet only pays the fresh wallet's first sats.
//
//   node tests/secret-sats-sell-signet.mjs [fund|join|sell|report|all]   (default: all, resumable)
//
// Env: BTC_POOL_API, SATS_FAUCET, ESPLORA (default blockstream signet), STATE_FILE, SELL_UNITS (default 6000),
// CONFIRM_TIMEOUT_MIN (default 90).
import { JSDOM } from 'jsdom';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME_V = path.join(os.homedir(), '.tacit-validation');
const STATE_FILE = process.env.STATE_FILE || path.join(HOME_V, 'secret-sats-sell-state.json');
const WALLET_FILE = path.join(HOME_V, 'signet.json');
const POOL_API = (process.env.BTC_POOL_API || 'https://tacit-btc-pool.onrender.com').replace(/\/$/, '');
const FAUCET = (process.env.SATS_FAUCET || 'https://tacit-sats-faucet.onrender.com').replace(/\/$/, '');
const ESPLORA = (process.env.ESPLORA || 'https://blockstream.info/signet/api').replace(/\/$/, '');
const SELL_UNITS = BigInt(process.env.SELL_UNITS || '6000');
const CONFIRM_TIMEOUT_MS = Number(process.env.CONFIRM_TIMEOUT_MIN || 90) * 60_000;
const FUND_SATS = 15_000;
const MIN_FUNDING_COIN = 10_000; // funding-wallet coins below this may be Tacit notes; never spent here

// ── the page's environment: DOM globals, signet, /btc-pool/ artifacts from dapp/btc-pool ──
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, location: dom.window.location });
if (!globalThis.navigator) globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.__TACIT_BTC_POOL_API__ = POOL_API;
globalThis.__SATS_FAUCET_URL__ = FAUCET;
localStorage.setItem('tacit-network-v1', 'signet');
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  let u = typeof url === 'string' ? url : String(url?.url ?? url);
  if (u.startsWith('/btc-pool/') || u.startsWith('http://localhost/btc-pool/')) {
    const name = u.replace(/^(http:\/\/localhost)?\/btc-pool\//, '').split('?')[0];
    if (!/^[\w.-]+$/.test(name)) return new Response('bad name', { status: 400 });
    try { return new Response(readFileSync(path.join(ROOT, 'dapp/btc-pool', name))); } catch { return new Response('not found', { status: 404 }); }
  }
  // Chain reads go to ESPLORA; fee estimates stay on mempool.space, as the page reads them.
  if (u.startsWith('https://mempool.space/signet/api') && !u.includes('/v1/fees')) u = ESPLORA + u.slice('https://mempool.space/signet/api'.length);
  return realFetch(u, opts);
};

const T = await import('../dapp/tacit.js');
const secret = await import('../dapp/sats/secret.js');
const { secp, bytesToHex, hexToBytes } = await import('../dapp/vendor/tacit-deps.min.js');

const log = (m) => console.log(`  ${m}`);
const link = (txid) => `https://mempool.space/signet/tx/${txid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (h) => String(h).replace(/^0x/i, '').toLowerCase();
const jsonOut = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? '0x' + bytesToHex(x) : x), 2);
const state = (() => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } })();
const saveState = () => { mkdirSync(path.dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, jsonOut(state), { mode: 0o600 }); };

// A fresh throwaway wallet for this run, kept in the state file.
if (!state.walletPriv) { state.walletPriv = bytesToHex(crypto.getRandomValues(new Uint8Array(32))); state.createdAt = new Date().toISOString(); saveState(); }
const priv = hexToBytes(state.walletPriv);
T.wallet.priv = priv;
T.wallet.pub = secp.getPublicKey(priv, true);
localStorage.setItem('tacit-backup-ack-v1:' + bytesToHex(T.wallet.pub), '1');
const pw = secret.poolWalletFor(priv, 'signet');
// Signet fee estimates swing to tens of sat/vB on an empty mempool (blockstream's /fee-estimates); the page's
// transactions here pay a fixed FEE_RATE instead, as tests/secret-sats-e2e-signet.mjs does.
const FEE_RATE = Number(process.env.FEE_RATE || 2);
const TX = new Proxy(T, { get: (t, k) => (k === 'getFeeRate' ? async () => FEE_RATE : t[k]) });

const Wf = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
if (Wf.network !== 'signet' || !/^tb1q/.test(Wf.address)) throw new Error('funding wallet must be a signet P2WPKH');
const FUND = { priv: hexToBytes(Wf.priv_hex) };
FUND.pub = secp.getPublicKey(FUND.priv, true);
if (bytesToHex(FUND.pub) !== String(Wf.pub_hex).toLowerCase()) throw new Error('funding wallet pub_hex does not match its key');
FUND.spk = T.p2wpkhScript(FUND.pub);

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
async function waitConfirmed(txid, label) {
  const t0 = Date.now();
  for (;;) {
    try { const s = await esploraJson(`/tx/${txid}/status`); if (s.confirmed) { log(`${label} confirmed in block ${s.block_height}`); return s.block_height; } } catch {}
    if (Date.now() - t0 > CONFIRM_TIMEOUT_MS) throw new Error(`${label} ${txid} not confirmed; re-run to resume`);
    await sleep(30_000);
  }
}
const poolGet = async (p) => {
  for (let i = 0; ; i++) {
    const r = await realFetch(POOL_API + p).catch(() => null);
    if (r?.ok) return r.json();
    if (i >= 8) throw new Error(`${POOL_API}${p}: HTTP ${r?.status}`);
    await sleep(5000);
  }
};
async function waitIndexed(height, label) {
  const t0 = Date.now();
  for (;;) {
    const s = await poolGet('/btc-pool/status');
    if (s.halted) throw new Error(`pool replay halted: ${JSON.stringify(s.halted)}`);
    if (s.height >= height) return s;
    if (Date.now() - t0 > CONFIRM_TIMEOUT_MS) throw new Error(`the pool did not reach ${height} for ${label}`);
    await sleep(20_000);
  }
}

// ── fund: the funding wallet pays the fresh wallet; coins are selected right before broadcasting ──
async function stageFund() {
  console.log('\n--- fund ---');
  if (state.fund?.txid) { log(`funded in ${link(state.fund.txid)}`); return; }
  const script = T.p2wpkhScript(T.wallet.pub);
  for (let attempt = 0; ; attempt++) {
    const coins = JSON.parse(await esplora(`/address/${Wf.address}/utxo`)).filter((u) => u.value >= MIN_FUNDING_COIN).sort((a, b) => b.value - a.value);
    const picked = []; let total = 0, fee = 0;
    for (const u of coins) { picked.push(u); total += u.value; fee = T.feeFor(11 + 68 * picked.length + 31 + 31, 2); if (total >= FUND_SATS + fee + 546) break; }
    if (total < FUND_SATS + fee) throw new Error(`funding wallet has ${total} sats in coins >= ${MIN_FUNDING_COIN}`);
    const change = total - FUND_SATS - fee;
    const tx = {
      version: 2, locktime: 0,
      inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
      outputs: [{ value: FUND_SATS, script }, ...(change >= 546 ? [{ value: change, script: FUND.spk }] : [])],
    };
    picked.forEach((u, i) => { tx.inputs[i].witness = T.signP2wpkhInputWithKey(tx, i, u.value, FUND.priv, FUND.pub); });
    try {
      const got = (await esplora('/tx', { method: 'POST', body: bytesToHex(T.serializeTx(tx)) })).trim();
      state.fund = { txid: got, sats: FUND_SATS }; saveState();
      log(`funded the fresh wallet ${T.wallet.address()} with ${FUND_SATS} sats in ${link(got)}`);
      break;
    } catch (e) {
      if (attempt < 5 && /conflict|missingorspent|missing-inputs|already spent/i.test(e.message)) { log('funding coin taken by another spender; reselecting'); await sleep(4000); continue; }
      throw e;
    }
  }
  await waitConfirmed(state.fund.txid, 'funding');
}

// ── join: one faucet lot straight into the pool ──
async function stageJoin() {
  console.log('\n--- join (buy and shield) ---');
  const st = state.join || (state.join = {});
  if (!st.revealTxid) {
    const status = await secret.fetchFaucet(FAUCET);
    const t0 = performance.now();
    const r = await secret.buyAndShield(TX, { status, poolWallet: pw, say: (m) => log(`join: ${m}`) });
    Object.assign(st, { commitTxid: r.commitTxid, revealTxid: r.revealTxid, saleId: r.sale.sale_id, units: r.poolNote.value, seconds: Number(((performance.now() - t0) / 1000).toFixed(1)) });
    saveState();
    log(`bought ${st.units} units into the pool in ${link(st.revealTxid)} (${st.seconds} s with proving)`);
  }
  if (!st.height) { st.height = await waitConfirmed(st.revealTxid, 'join carrier'); saveState(); }
  await waitIndexed(st.height, 'join');
  const mine = (await secret.poolNotes(pw, null)).filter((x) => x.txid === st.revealTxid);
  if (!mine.length) throw new Error(`the pool did not accept the join ${st.revealTxid}`);
  log(`the pool accepted the join: ${mine[0].value} units at leaf ${mine[0].leafIndex}`);
}

// ── sell: back to sats through the faucet's maker ──
async function stageSell() {
  console.log(`\n--- sell ${SELL_UNITS} units back to sats ---`);
  const st = state.sell || (state.sell = {});
  const status = await secret.fetchFaucet(FAUCET);
  if (!st.revealTxid) {
    if (!status.maker?.enabled) throw new Error('the faucet maker is off');
    const pool = await poolGet('/btc-pool/status');
    log(`pool ${pool.proofSystem} ${String(pool.vkHash).slice(0, 16)}…, tip ${pool.height}; maker ${status.maker.sats_per_lot} sats per lot`);
    const used = new Set(st.usedScripts || []);
    const t0 = performance.now();
    let r;
    try {
      r = await secret.sellForSats(TX, { poolWallet: pw, amount: SELL_UNITS, asset: status.asset_id, anchor: pool.height, usedScripts: used, say: (m) => log(`sell: ${m}`) });
    } finally { st.usedScripts = [...used]; saveState(); }
    if (r.wait) throw new Error(`anchor wait ${r.wait}`);
    Object.assign(st, { revealTxid: r.revealTxid, commitTxid: r.commitTxid, sats: r.sats, payout: r.payout, anchor: r.anchor, proofSystem: pool.proofSystem, seconds: Number(((performance.now() - t0) / 1000).toFixed(1)) });
    saveState();
    log(`sold ${SELL_UNITS} units for ${r.sats} sats in ${link(r.revealTxid)} (${st.seconds} s end to end)`);
  }
  if (!st.height) { st.height = await waitConfirmed(st.revealTxid, 'sell carrier'); saveState(); }
  await waitIndexed(st.height, 'sell');
  const tx = await esploraJson(`/tx/${st.revealTxid}`);
  const want = tx.vout[st.payout.vout];
  if (strip(want.scriptpubkey) !== strip(st.payout.scriptPubKey) || want.value < st.sats) throw new Error('the carrier does not pay the want');
  const ex = await poolGet(`/btc-pool/exit/${st.revealTxid}/0`);
  if (!ex.exists || strip(ex.asset) !== strip(status.asset_id)) throw new Error(`the pool has no exit record: ${JSON.stringify(ex)}`);
  const notes = await secret.poolNotes(pw, status.asset_id);
  const change = notes.filter((x) => x.txid === st.revealTxid && !x.spent);
  const spentJoin = notes.filter((x) => x.txid === state.join.revealTxid).every((x) => x.spent);
  if (!spentJoin) throw new Error('the joined note is not spent');
  st.change = change.reduce((t, x) => t + x.value, 0n).toString();
  st.changeInternal = change.every((x) => x.internal);
  st.exitRecord = ex;
  saveState();
  log(`the pool recorded the exit ${st.revealTxid}:0 at ${ex.height}; ${want.value} sats paid to the fresh key ${want.scriptpubkey_address}; ${st.change} units kept as private change`);
}

async function stageReport() {
  console.log('\n--- report ---');
  log(`fund   ${state.fund?.txid ? link(state.fund.txid) : '-'}`);
  log(`join   ${state.join?.revealTxid ? link(state.join.revealTxid) : '-'} (commit ${state.join?.commitTxid || '-'})`);
  log(`sell   ${state.sell?.revealTxid ? link(state.sell.revealTxid) : '-'} (commit ${state.sell?.commitTxid || '-'}), ${state.sell?.sats ?? '-'} sats, change ${state.sell?.change ?? '-'} units, ${state.sell?.proofSystem || '-'}`);
}

const STAGES = { fund: stageFund, join: stageJoin, sell: stageSell, report: stageReport };
const want = process.argv[2] || 'all';
console.log(`=== secret sats: back to sats on signet (${want}) ===`);
console.log(`  wallet  ${T.wallet.address()}`);
console.log(`  pool    ${POOL_API}`);
console.log(`  faucet  ${FAUCET}`);
if (want === 'all') for (const s of ['fund', 'join', 'sell', 'report']) await STAGES[s]();
else if (STAGES[want]) await STAGES[want]();
else throw new Error(`unknown stage ${want}`);
process.exit(0);
