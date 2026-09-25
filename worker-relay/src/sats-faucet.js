// Signet cBTC faucet for the Secret Sats demo. The faucet is a set of pre-authorized sales
// (buyer-completable T_AXFER): the faucet key holds a signet cBTC stand-in, splits it into lots of
// FAUCET_LOT units, and keeps FAUCET_TARGET_LISTINGS lots listed at FAUCET_PRICE_SATS. A user claims a
// lot by taking a sale, one Bitcoin transaction in which they pay the price and receive the note.
//
// Env:
//   FAUCET_KEY              signet P2WPKH private key, hex (secret)
//   FAUCET_ASSET_ID         asset to sell; unset etches a fresh cBTC stand-in on first run
//   FAUCET_SUPPLY           etch supply in base units (default 10,000,000,000 = 100 BTC at 8 decimals)
//   FAUCET_LOT              units per sale (default 10,000)
//   FAUCET_PRICE_SATS       price per sale in signet sats (default 1,000)
//   FAUCET_TARGET_LISTINGS  live sales to keep listed (default 5)
//   FAUCET_EXPIRY_DAYS      listing expiry (default 30); relisted FAUCET_RELIST_HOURS before it lapses (default 24)
//   FAUCET_POLL_SECS        reconcile interval (default 60)
//   FAUCET_STATE            state file (default /var/lib/tacit-sats-faucet/state.json)
//   FAUCET_NETWORK          signet only
//   TACIT_WORKER_BASE       control-plane worker (tacit.js default when unset)
//   FAUCET_DRIP_SATS        signet sats sent per POST /faucet/sats (default 10,000)
//   FAUCET_DRIP_DAILY       drips per rolling 24h across all clients (default 50)
//   FAUCET_DRIP_FLOOR_SATS  sats balance kept back for the faucet's own listings (default 50,000)
//   FAUCET_CORS_ORIGINS     origins allowed to POST (default https://tacit.finance,http://localhost:8765)
//   PORT                    HTTP port for GET /faucet/status, GET /health, POST /faucet/sats (default 10000)
//
// Maker for exit-to-sats (btc-pool-zap.js exitToSats): the faucet buys private cBTC back at its sale rate less
// a spread. GET /faucet/maker/quote?units=N reserves a bind coin and names the terms; POST /faucet/maker/fill
// takes the user's proved spend, checks it natively (terms, exit opening, root, nullifiers, proof) and posts
// the carrier from the maker's own coins. The maker coins sit on a key derived from FAUCET_KEY, so no Tacit
// note is ever among them; the exit notes it buys pay the faucet key and rejoin its inventory.
//   FAUCET_MAKER             "off" disables the maker (default on)
//   FAUCET_POOL_API          pool replay service (default https://tacit-btc-pool.onrender.com)
//   FAUCET_MAKER_SPREAD_BPS  discount on the sale rate (default 500 = 5%)
//   FAUCET_MAKER_MAX_UNITS   units per fill (default 50,000)
//   FAUCET_MAKER_DAILY_SATS  sats paid out per rolling 24h, quotes included (default 50,000)
//   FAUCET_MAKER_IP_FILLS    fills per client per 24h (default 3)
//   FAUCET_MAKER_QUOTE_SECS  quote lifetime (default 1200)
//   FAUCET_MAKER_COINS       maker coins kept on hand (default 4), each FAUCET_MAKER_COIN_SATS (default 10,000)
//   FAUCET_MAKER_FEE_RATE    carrier fee rate, sat/vB (default 2)

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAPP = path.resolve(HERE, '../../dapp');

export const TICKER = 'cBTC';
export const DECIMALS = 8;
const SPLIT_SIZES = [1, 3, 7]; // K + 1 a power of two: no zero-value padding outputs
const TAKEN_HISTORY = 50;
const WORKER_BASE = (process.env.TACIT_WORKER_BASE || 'https://api.tacit.finance').replace(/\/$/, '');

const log = (...a) => console.log(`[sats-faucet ${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const int = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };

export function configFromEnv(env = process.env) {
  const cfg = {
    network: env.FAUCET_NETWORK || 'signet',
    assetId: (env.FAUCET_ASSET_ID || '').toLowerCase().replace(/^0x/, '') || null,
    supply: BigInt(env.FAUCET_SUPPLY || '10000000000'),
    lot: BigInt(env.FAUCET_LOT || '10000'),
    priceSats: int(env.FAUCET_PRICE_SATS, 1000),
    target: int(env.FAUCET_TARGET_LISTINGS, 5),
    expiryDays: int(env.FAUCET_EXPIRY_DAYS, 30),
    relistHours: int(env.FAUCET_RELIST_HOURS, 24),
    pollSecs: int(env.FAUCET_POLL_SECS, 60),
    statePath: env.FAUCET_STATE || '/var/lib/tacit-sats-faucet/state.json',
    port: int(env.PORT, 10000),
    dripSats: int(env.FAUCET_DRIP_SATS, 10_000),
    dripDaily: int(env.FAUCET_DRIP_DAILY, 50),
    dripFloorSats: int(env.FAUCET_DRIP_FLOOR_SATS, 50_000),
    corsOrigins: (env.FAUCET_CORS_ORIGINS || 'https://tacit.finance,http://localhost:8765').split(',').map((s) => s.trim()).filter(Boolean),
    maker: String(env.FAUCET_MAKER || 'on').toLowerCase() !== 'off',
    poolApi: (env.FAUCET_POOL_API || 'https://tacit-btc-pool.onrender.com').replace(/\/$/, ''),
    makerSpreadBps: Math.min(9000, Math.max(0, Number.isFinite(Number(env.FAUCET_MAKER_SPREAD_BPS)) ? Math.floor(Number(env.FAUCET_MAKER_SPREAD_BPS)) : 500)),
    makerMaxUnits: BigInt(env.FAUCET_MAKER_MAX_UNITS || '50000'),
    makerDailySats: int(env.FAUCET_MAKER_DAILY_SATS, 50_000),
    makerIpFills: int(env.FAUCET_MAKER_IP_FILLS, 3),
    makerQuoteSecs: int(env.FAUCET_MAKER_QUOTE_SECS, 1200),
    makerCoins: int(env.FAUCET_MAKER_COINS, 4),
    makerCoinSats: int(env.FAUCET_MAKER_COIN_SATS, 10_000),
    makerFeeRate: int(env.FAUCET_MAKER_FEE_RATE, 2),
  };
  if (cfg.network !== 'signet') throw new Error('sats-faucet runs on signet only');
  if (cfg.assetId && !/^[0-9a-f]{64}$/.test(cfg.assetId)) throw new Error('FAUCET_ASSET_ID must be 32-byte hex');
  if (cfg.lot <= 0n || cfg.supply < cfg.lot) throw new Error('FAUCET_LOT must be positive and at most FAUCET_SUPPLY');
  if (cfg.target > 50) throw new Error('FAUCET_TARGET_LISTINGS above 50');
  if (cfg.dripSats <= 546) throw new Error('FAUCET_DRIP_SATS must be above dust');
  if (cfg.makerMaxUnits <= 0n) throw new Error('FAUCET_MAKER_MAX_UNITS must be positive');
  if (cfg.makerCoins < 2 || cfg.makerCoins > 20) throw new Error('FAUCET_MAKER_COINS must be 2..20');
  if (cfg.makerCoinSats <= 546) throw new Error('FAUCET_MAKER_COIN_SATS must be above dust');
  return cfg;
}

// ── signet address decoding (BIP-173 / BIP-350) ──
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}

function convertBits(data, from, to) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return out;
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// A signet segwit address (tb1q… P2WPKH/P2WSH, tb1p… P2TR) to its output script. Throws HttpError(400).
export function decodeSignetAddress(address) {
  const bad = (m) => new HttpError(400, m);
  const raw = String(address ?? '').trim();
  if (raw.length < 14 || raw.length > 90) throw bad('address must be a signet tb1q… or tb1p… address');
  if (raw !== raw.toLowerCase() && raw !== raw.toUpperCase()) throw bad('address has mixed case');
  const a = raw.toLowerCase();
  if (!a.startsWith('tb1')) throw bad('address must be a signet tb1q… or tb1p… address');
  const data = [];
  for (const c of a.slice(3)) {
    const v = BECH32_CHARSET.indexOf(c);
    if (v < 0) throw bad('address is not valid bech32');
    data.push(v);
  }
  if (data.length < 7) throw bad('address is not valid bech32');
  const version = data[0];
  const hrp = [...'tb'].map((c) => c.charCodeAt(0));
  const check = bech32Polymod([...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31), ...data]);
  if (check !== (version === 0 ? BECH32_CONST : BECH32M_CONST)) throw bad('address checksum is invalid');
  const prog = convertBits(data.slice(1, -6), 5, 8);
  if (!prog) throw bad('address is not valid bech32');
  if (version === 0 && (prog.length === 20 || prog.length === 32)) return { address: a, script: Uint8Array.from([0x00, prog.length, ...prog]) };
  if (version === 1 && prog.length === 32) return { address: a, script: Uint8Array.from([0x51, 0x20, ...prog]) };
  throw bad('only tb1q… and tb1p… addresses are supported');
}

// Right-most X-Forwarded-For hop: the one the fronting proxy appended, which a client cannot set.
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff.join(',') : xff;
  if (raw) {
    const hops = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}

const ipTag = (ip) => createHash('sha256').update('sats-faucet:' + ip).digest('hex').slice(0, 32);

// Serialises everything that spends from the faucet key, so two spends never select the same UTXOs.
export function makeLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

// tacit.js is a browser module: DOM globals and the network must exist before it is imported.
export async function loadTacitHeadless(network = 'signet') {
  if (globalThis.__satsFaucetTacit) return globalThis.__satsFaucetTacit;
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const g = globalThis;
  const set = (k, v) => { try { g[k] = v; } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); } };
  set('window', dom.window);
  set('document', dom.window.document);
  set('localStorage', dom.window.localStorage);
  set('location', dom.window.location);
  if (!g.navigator) set('navigator', dom.window.navigator);
  if (!g.crypto) set('crypto', dom.window.crypto);
  g.prompt = () => null;
  g.alert = () => {};
  g.confirm = () => true;
  g.__TACIT_NO_INIT__ = true;
  dom.window.localStorage.setItem('tacit-network-v1', network);
  const tacit = await import(path.join(DAPP, 'tacit.js'));
  const deps = await import(path.join(DAPP, 'vendor/tacit-deps.min.js'));
  if (tacit.NET?.name !== network) throw new Error(`tacit.js loaded for ${tacit.NET?.name}, want ${network}`);
  g.__satsFaucetTacit = { tacit, deps };
  return g.__satsFaucetTacit;
}

// Signing key into the module's wallet; the passphrase path is for browsers.
export function setWalletKey({ tacit, deps }, privHex) {
  const hex = String(privHex || '').trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('FAUCET_KEY must be 32-byte hex');
  const priv = deps.hexToBytes(hex);
  tacit.wallet.priv = priv;
  tacit.wallet.pub = deps.secp.getPublicKey(priv, true);
  try { globalThis.localStorage.setItem('tacit-backup-ack-v1:' + deps.bytesToHex(tacit.wallet.pub), '1'); } catch {}
  try { tacit.invalidateHoldingsCache(); } catch {}
  return deps.bytesToHex(tacit.wallet.pub);
}

export function openStateFile(statePath) {
  return {
    load() { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return {}; } },
    save(s) {
      mkdirSync(path.dirname(statePath), { recursive: true });
      const tmp = statePath + '.tmp';
      writeFileSync(tmp, JSON.stringify(s, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2), { mode: 0o600 });
      renameSync(tmp, statePath);
    },
  };
}

const hex32 = (x) => BigInt(x).toString(16).padStart(64, '0');
const opKey = (o) => `${o.txid}:${o.vout}`;

const ANCHOR_WINDOW = 144; // retained roots, as the pool replay and relayer
const MAX_PAYLOAD_BYTES = 128 * 1024;
const DRIP_WINDOW_SECS = 86400;
const DRIP_MAX_QUEUED = 5;
const SPENT_MEMORY_SECS = 3600;

export function makeFaucet({ tacit, deps, cfg, store, logger = log, now = () => Math.floor(Date.now() / 1000), dripWaitMs = 30_000, maker = null }) {
  const state = store.load();
  // A fill cut off by a restart is not retried; its quote lapses and frees the bind.
  for (const q of Object.values(state.makerQuotes || {})) if (q.state === 'filling') q.state = 'failed';
  const esplora = tacit.NET.api;
  const locked = makeLock();
  const recentlySpent = new Map(); // outpoint -> time, until the indexer stops listing it
  let busy = false;
  let dripsQueued = 0;
  let lastError = null;
  let lastTick = null;

  const save = () => { state.updatedAt = Math.floor(Date.now() / 1000); store.save(state); };
  const sellerPub = () => deps.bytesToHex(tacit.wallet.pub);

  async function getJson(p) {
    const r = await fetch(esplora + p);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`esplora ${p}: HTTP ${r.status}`);
    return r.json();
  }
  async function outValue(txid, vout) {
    const tx = await getJson(`/tx/${txid}`);
    const o = tx?.vout?.[vout];
    if (!o) throw new Error(`${txid}:${vout} not visible`);
    return o.value;
  }
  async function waitVisible(txid, maxMs = 90_000) {
    const t0 = Date.now();
    for (;;) {
      try { if (await getJson(`/tx/${txid}/status`)) return; } catch {}
      if (Date.now() - t0 > maxMs) throw new Error(`${txid} not visible after ${maxMs / 1000}s`);
      await sleep(3000);
    }
  }
  const forceUtxo = (u) => ({ utxo: { txid: u.txid, vout: u.vout, value: u.value }, amount: BigInt(u.amount), blinding: BigInt('0x' + u.blinding) });
  const workerSales = async () => {
    const r = await fetch(`${WORKER_BASE}/assets/${state.assetId}/preauth-sales?network=${tacit.NET.name}`);
    if (!r.ok) throw new Error(`preauth-sales list: HTTP ${r.status}`);
    return (await r.json()).sales || [];
  };

  async function ensureAsset() {
    if (cfg.assetId && state.assetId && state.assetId !== cfg.assetId) {
      throw new Error(`state file holds asset ${state.assetId}, FAUCET_ASSET_ID is ${cfg.assetId}; point FAUCET_STATE elsewhere`);
    }
    if (!state.assetId && cfg.assetId) { state.assetId = cfg.assetId; save(); }
    if (!state.assetId) {
      if (state.etchPending) throw new Error(`etch ${state.etchPending} broadcast without a recorded result; set FAUCET_ASSET_ID`);
      logger(`etching ${TICKER}: supply ${cfg.supply}, decimals ${DECIMALS}`);
      state.etchPending = 'in-flight'; save();
      const r = await tacit.buildAndBroadcastCEtch({ ticker: TICKER, supplyBase: cfg.supply, decimals: DECIMALS, mintable: false });
      const raw = deps.hexToBytes(r.commitHex);
      const p = raw[4] === 0 && raw[5] === 1 ? 6 : 4;
      const anchor = raw.slice(p + 1, p + 1 + 36);
      const blinding = tacit.deriveEtchBlinding(tacit.wallet.priv, anchor);
      state.assetId = r.assetIdHex;
      state.etch = { commitTxid: r.commitTxid, revealTxid: r.revealTxid, supply: cfg.supply.toString() };
      state.reserve = { txid: r.revealTxid, vout: 0, value: tacit.DUST, amount: cfg.supply.toString(), blinding: hex32(blinding) };
      state.lots = [];
      delete state.etchPending;
      save();
      logger(`etched asset ${r.assetIdHex} reveal ${r.revealTxid}`);
    }
    if (!state.lots) state.lots = [];
    if (!state.reserve && !state.recovered) await recoverFromHoldings();
  }

  // Rebuild reserve and lots from the wallet's holdings, adopting any live listing of ours.
  async function recoverFromHoldings() {
    logger('no reserve on record; recovering from holdings');
    const h = (await tacit.scanHoldings(true))?.get(state.assetId);
    const utxos = (h?.utxos || []).map((u) => ({ txid: u.utxo.txid, vout: u.utxo.vout, value: u.utxo.value, amount: BigInt(u.amount).toString(), blinding: hex32(u.blinding) }));
    const known = new Set(state.lots.map(opKey));
    utxos.sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
    const [top, ...rest] = utxos;
    if (top && BigInt(top.amount) > cfg.lot) state.reserve = top; else if (top) rest.unshift(top);
    for (const u of rest) if (BigInt(u.amount) === cfg.lot && !known.has(opKey(u))) state.lots.push(u);
    let sales = [];
    try { sales = await workerSales(); } catch (e) { logger(`listing lookup failed: ${e.message}`); }
    for (const s of sales) {
      if (s.seller_pubkey !== sellerPub() || s.expired) continue;
      const lot = state.lots.find((l) => l.txid === s.asset_outpoint?.txid && l.vout === s.asset_outpoint?.vout);
      if (lot) Object.assign(lot, { saleId: s.sale_id, expiry: s.expiry });
    }
    state.recovered = true;
    save();
    logger(`recovered reserve ${state.reserve ? state.reserve.amount : 'none'}, ${state.lots.length} lots`);
  }

  async function refreshLots() {
    const keep = [];
    for (const lot of state.lots) {
      let sp = null;
      try { sp = await getJson(`/tx/${lot.txid}/outspend/${lot.vout}`); } catch (e) { keep.push(lot); continue; }
      if (sp?.spent) {
        state.taken = [{ saleId: lot.saleId || null, lot: opKey(lot), txid: sp.txid, at: Math.floor(Date.now() / 1000) }, ...(state.taken || [])].slice(0, TAKEN_HISTORY);
        state.takenTotal = (state.takenTotal || 0) + 1;
        logger(`lot ${opKey(lot)} taken in ${sp.txid}`);
        continue;
      }
      keep.push(lot);
    }
    state.lots = keep;
    save();
  }

  async function split() {
    const live = state.lots.length;
    const deficit = cfg.target - live;
    if (deficit <= 0 || !state.reserve) return;
    // Exit notes bought back by the maker fold into the reserve here.
    const extras = (state.makerNotes || []).filter((x) => x.status === 'ready').slice(0, 3);
    const pooled = extras.reduce((s, x) => s + BigInt(x.amount), BigInt(state.reserve.amount));
    const avail = pooled / cfg.lot;
    let k = SPLIT_SIZES.find((n) => n >= deficit) || SPLIT_SIZES[SPLIT_SIZES.length - 1];
    if (BigInt(k) > avail) k = [...SPLIT_SIZES].reverse().find((n) => BigInt(n) <= avail) || 0;
    if (!k) { logger(`reserve ${state.reserve.amount} below one lot; not splitting`); return; }
    const reserve = { ...state.reserve, value: await outValue(state.reserve.txid, state.reserve.vout) };
    logger(`splitting ${k} lots of ${cfg.lot} from ${opKey(reserve)}${extras.length ? ` and ${extras.length} bought-back note(s)` : ''}`);
    const own = sellerPub();
    let r;
    try {
      r = await tacit.buildAndBroadcastCXferMulti({
        assetIdHex: state.assetId,
        recipients: Array.from({ length: k }, () => ({ pubHex: own, amount: cfg.lot })),
        forceUtxos: [forceUtxo(reserve), ...extras.map(forceUtxo)],
        allowDuplicateRecipients: true,
      });
    } catch (e) {
      if (!extras.length) throw e;
      logger(`split with bought-back notes failed (${e.message}); holding them and splitting the reserve alone`);
      for (const x of extras) x.status = 'hold';
      save();
      return split();
    }
    for (const x of extras) x.status = 'merged';
    for (const x of r.recipients) state.lots.push({ txid: r.revealTxid, vout: x.vout, value: tacit.DUST, amount: BigInt(x.amount).toString(), blinding: hex32(x.blinding) });
    state.reserve = BigInt(r.changeAmount) > 0n
      ? { txid: r.revealTxid, vout: r.changeVout, value: tacit.DUST, amount: BigInt(r.changeAmount).toString(), blinding: hex32(r.changeBlinding) }
      : null;
    state.splits = [...(state.splits || []), { commitTxid: r.commitTxid, revealTxid: r.revealTxid, k }].slice(-TAKEN_HISTORY);
    save();
    logger(`split reveal ${r.revealTxid}`);
    await waitVisible(r.revealTxid);
  }

  async function publish(lot) {
    const expiry = Math.floor(Date.now() / 1000) + cfg.expiryDays * 86400;
    try {
      const pub = await tacit.publishPreauthSale({
        utxoTxid: lot.txid, utxoVout: lot.vout, minPriceSats: cfg.priceSats, expiry,
        preResolvedTarget: { utxo: { txid: lot.txid, vout: lot.vout, value: lot.value }, amount: BigInt(lot.amount), blinding: BigInt('0x' + lot.blinding), ticker: TICKER, decimals: DECIMALS },
        preResolvedAssetIdHex: state.assetId,
      });
      Object.assign(lot, { saleId: pub.sale_id, expiry });
      logger(`listed ${opKey(lot)} as sale ${pub.sale_id}`);
    } catch (e) {
      if (!/already exists/.test(String(e?.message))) throw e;
      const s = (await workerSales()).find((x) => x.seller_pubkey === sellerPub() && x.asset_outpoint?.txid === lot.txid && x.asset_outpoint?.vout === lot.vout && !x.expired);
      if (!s) throw e;
      Object.assign(lot, { saleId: s.sale_id, expiry: s.expiry });
      logger(`adopted live sale ${s.sale_id} for ${opKey(lot)}`);
    }
    save();
  }

  async function reconcileListings() {
    const now = Math.floor(Date.now() / 1000);
    const listed = state.lots.filter((l) => l.saleId);
    for (const lot of listed) {
      let gone = false;
      try { gone = !(await tacit.fetchPreauthSale({ assetIdHex: state.assetId, saleIdHex: lot.saleId })); } catch {}
      if (gone) { logger(`sale ${lot.saleId} no longer on the worker; relisting`); delete lot.saleId; delete lot.expiry; continue; }
      if ((lot.expiry || 0) - now < cfg.relistHours * 3600) {
        try { await tacit.cancelPreauthSale({ assetIdHex: state.assetId, saleIdHex: lot.saleId }); } catch (e) { logger(`cancel ${lot.saleId}: ${e.message}`); }
        delete lot.saleId; delete lot.expiry;
      }
    }
    const want = cfg.target - state.lots.filter((l) => l.saleId).length;
    for (const lot of state.lots.filter((l) => !l.saleId).slice(0, Math.max(0, want))) await publish(lot);
    save();
  }

  async function tick() {
    if (busy) return false;
    busy = true;
    try {
      return await locked(async () => {
        try {
          await ensureAsset();
          await refreshLots();
          if (mk) await refreshMakerNotes();
          await split();
          await reconcileListings();
          if (mk) { pruneQuotes(now()); await topUpMaker(); }
          lastError = null;
          return true;
        } catch (e) {
          lastError = String(e?.message || e).slice(0, 500);
          logger(`tick failed: ${lastError}`);
          return false;
        }
      });
    } finally {
      lastTick = Math.floor(Date.now() / 1000);
      busy = false;
    }
  }

  const recentDrips = (t) => (state.drips || []).filter((d) => t - d.at < DRIP_WINDOW_SECS);

  const pruneSpent = (t) => { for (const [k, at] of recentlySpent) if (t - at > SPENT_MEMORY_SECS) recentlySpent.delete(k); };

  // Plain payment of `outs` ([{ value, script }]) from the faucet key's non-asset UTXOs, keeping
  // dripFloorSats back for the listings. Caller holds the lock.
  async function sendOutputs(outs, { wait = dripWaitMs } = {}) {
    const t = now();
    pruneSpent(t);
    const amount = outs.reduce((s, o) => s + o.value, 0);
    const holdings = await tacit.scanHoldings(true);
    if (!(holdings instanceof Map)) throw new HttpError(503, 'faucet could not classify its UTXOs; try again shortly');
    const utxos = tacit.selectSatsUtxosSafe(await tacit.getUtxos(tacit.wallet.address()), holdings)
      .filter((u) => u.value > tacit.DUST && !recentlySpent.has(opKey(u)))
      .sort((a, b) => ((b.status?.confirmed ? 1 : 0) - (a.status?.confirmed ? 1 : 0)) || b.value - a.value);
    const balance = utxos.reduce((s, u) => s + u.value, 0);
    const feeRate = await tacit.getFeeRate();
    const outVb = outs.reduce((s, o) => s + 9 + o.script.length, 0);
    const picked = [];
    let total = 0, fee = 0;
    for (const u of utxos) {
      picked.push(u);
      total += u.value;
      fee = tacit.feeFor(11 + 68 * picked.length + outVb + 31, feeRate);
      if (total >= amount + fee) break;
    }
    if (total < amount + fee || balance - amount - fee < cfg.dripFloorSats) {
      throw new HttpError(503, 'the faucet is low on signet sats; try a public signet faucet');
    }
    const change = total - amount - fee;
    const outputs = outs.map((o) => ({ value: o.value, script: o.script }));
    if (change > tacit.DUST) outputs.push({ value: change, script: tacit.p2wpkhScript(tacit.wallet.pub) });
    const tx = {
      version: 2, locktime: 0,
      inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
      outputs,
    };
    picked.forEach((u, i) => { tx.inputs[i].witness = tacit.signP2wpkhInput(tx, i, u.value); });
    await tacit.broadcast(deps.bytesToHex(tacit.serializeTx(tx)));
    const txid = tacit.txid(tx);
    for (const u of picked) recentlySpent.set(opKey(u), t);
    if (wait > 0) { try { await waitVisible(txid, wait); } catch {} }
    return txid;
  }
  const sendSats = (script, amount) => sendOutputs([{ value: amount, script }]);

  // POST /faucet/sats: one drip per address and per client per 24h, within a global 24h budget.
  async function drip({ address, ip }) {
    const { address: addr, script } = decodeSignetAddress(address);
    const tag = ipTag(ip || 'unknown');
    if (dripsQueued >= DRIP_MAX_QUEUED) throw new HttpError(503, 'the faucet is busy; try again in a minute');
    dripsQueued++;
    try {
      return await locked(async () => {
        const t = now();
        const recent = recentDrips(t);
        if (recent.some((d) => d.address === addr)) throw new HttpError(429, 'this address already received signet sats in the last 24 hours');
        if (recent.some((d) => d.ip === tag)) throw new HttpError(429, 'one drip per client every 24 hours');
        if (recent.length >= cfg.dripDaily) throw new HttpError(429, 'the faucet has given out its daily budget; try again later');
        const txid = await sendSats(script, cfg.dripSats);
        state.drips = [...recent, { address: addr, ip: tag, txid, at: t }];
        state.dripTotal = (state.dripTotal || 0) + 1;
        save();
        logger(`dripped ${cfg.dripSats} sats to ${addr} in ${txid}`);
        return { txid, sats: cfg.dripSats };
      });
    } finally {
      dripsQueued--;
    }
  }

  // ── maker: exit-to-sats ──
  // maker = { key: { priv, pub }, pool, zap, verifier: { verify({ proof, publics }), system }, poolGet?(path), utxos?(spkHex) }
  const mk = cfg.maker && maker ? maker : null;
  const mainSpk = () => tacit.p2wpkhScript(tacit.wallet.pub);
  const makerSpk = mk ? tacit.p2wpkhScript(mk.key.pub) : null;
  const poolGet = mk?.poolGet || (async (p) => {
    const r = await fetch(cfg.poolApi + p);
    const j = await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error(j?.error || `pool ${p}: HTTP ${r.status}`), { status: r.status });
    return j;
  });
  const makerUtxosRaw = mk?.utxos || (async (spkHex) => (await getJson(`/scripthash/${createHash('sha256').update(Buffer.from(spkHex, 'hex')).digest('hex')}/utxo`)) || []);
  // The maker key only ever receives plain sats (top-ups, commit change), so every coin on it is spendable.
  async function makerCoins() {
    pruneSpent(now());
    const all = await makerUtxosRaw(deps.bytesToHex(makerSpk));
    return all.filter((u) => u.value > tacit.DUST && !recentlySpent.has(opKey(u)))
      .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: !!u.status?.confirmed }));
  }

  const FILL_WINDOW_SECS = 86400;
  const QUOTE_IP_HOURLY = 20;
  const QUOTE_IP_OPEN = 2;
  const MAKER_FEE_ALLOWANCE = 6000; // commit + reveal at the maker fee rate, for proofs up to a few kB
  const WANT_DUST = 330;             // the want pays a P2TR exit key
  const EXIT_VOUT = 0, WANT_VOUT = 1;

  const quotes = () => (state.makerQuotes ||= {});
  const recentFills = (t) => (state.makerFills || []).filter((f) => t - f.at < FILL_WINDOW_SECS);
  function pruneQuotes(t) {
    for (const [id, q] of Object.entries(quotes())) if (q.state !== 'filling' && t >= q.expiry) delete quotes()[id];
  }
  // Quotes that still hold their bind and their sats: open or failed until they lapse, and any in flight.
  const openQuotes = (t = now()) => Object.values(quotes()).filter((q) => q.state === 'filling' || t < q.expiry);
  const reservedBinds = (except = null) => new Set(openQuotes().filter((q) => q.id !== except).map((q) => opKey(q.bind)));
  const satsCommitted = (t) => recentFills(t).reduce((s, f) => s + f.sats, 0) + openQuotes(t).reduce((s, q) => s + q.sats, 0);

  // Sats for `units`: the faucet's own sale rate less the spread, rounded down.
  const priceOf = (units) => Number((BigInt(units) * BigInt(cfg.priceSats) * BigInt(10_000 - cfg.makerSpreadBps)) / (cfg.lot * 10_000n));
  const minUnits = () => {
    const per = BigInt(cfg.priceSats) * BigInt(10_000 - cfg.makerSpreadBps);
    return per > 0n ? (BigInt(WANT_DUST) * cfg.lot * 10_000n + per - 1n) / per : null;
  };

  function makerOff() {
    if (!mk) throw new HttpError(404, 'the faucet is not buying cBTC back');
    if (!state.assetId) throw new HttpError(503, 'the faucet is starting; try again shortly');
  }

  // GET /faucet/maker/quote?units=N
  async function makerQuote({ units, ip }) {
    makerOff();
    if (!/^\d{1,20}$/.test(String(units ?? ''))) throw new HttpError(400, 'units must be a positive integer');
    const u = BigInt(units);
    if (u <= 0n) throw new HttpError(400, 'units must be a positive integer');
    if (u > cfg.makerMaxUnits) throw new HttpError(400, `the faucet buys at most ${cfg.makerMaxUnits} units per swap`);
    const sats = priceOf(u);
    if (sats < WANT_DUST) throw new HttpError(400, `amount too small: the faucet buys at least ${minUnits()} units`);
    const tag = ipTag(ip || 'unknown');
    return locked(async () => {
      const t = now();
      pruneQuotes(t);
      if (recentFills(t).filter((f) => f.ip === tag).length >= cfg.makerIpFills) throw new HttpError(429, `at most ${cfg.makerIpFills} swaps per client every 24 hours`);
      const mine = Object.values(quotes()).filter((q) => q.ip === tag);
      if (mine.filter((q) => q.state === 'open').length >= QUOTE_IP_OPEN) throw new HttpError(429, 'finish or let lapse your open quotes first');
      state.makerQuoteLog = (state.makerQuoteLog || []).filter((x) => t - x.at < 3600);
      if (state.makerQuoteLog.filter((x) => x.ip === tag).length >= QUOTE_IP_HOURLY) throw new HttpError(429, 'too many quotes; try again within the hour');
      if (satsCommitted(t) + sats > cfg.makerDailySats) throw new HttpError(429, 'the faucet has bought back its daily budget; try again later');
      const coins = await makerCoins();
      const taken = reservedBinds();
      const free = coins.filter((c) => !taken.has(opKey(c)));
      // Smallest free coin binds; the rest must cover the want, the exit output and the fees.
      const bind = [...free].sort((a, b) => a.value - b.value)[0];
      const rest = free.filter((c) => c !== bind).reduce((s, c) => s + c.value, 0);
      if (!bind || rest + bind.value < sats + tacit.DUST + MAKER_FEE_ALLOWANCE || rest <= tacit.DUST) {
        throw new HttpError(503, 'the faucet has no sats free to buy back right now; try again in a few minutes');
      }
      const id = randomBytes(16).toString('hex');
      const q = { id, units: u.toString(), sats, bind: { txid: bind.txid, vout: bind.vout, value: bind.value }, expiry: t + cfg.makerQuoteSecs, ip: tag, state: 'open', at: t };
      quotes()[id] = q;
      state.makerQuoteLog.push({ ip: tag, at: t });
      save();
      logger(`maker quote ${id}: ${q.units} units for ${sats} sats, bind ${opKey(bind)}`);
      return quoteView(q);
    });
  }
  const quoteView = (q) => ({
    quoteId: q.id, asset: state.assetId, units: q.units, sats: q.sats,
    makerSpk: deps.bytesToHex(mainSpk()), exitVout: EXIT_VOUT, wantVout: WANT_VOUT,
    bind: { txid: q.bind.txid, vout: q.bind.vout }, expiry: q.expiry,
  });
  const termsOf = (q) => ({ spk: mainSpk(), sats: BigInt(q.sats), vout: WANT_VOUT, exitVout: EXIT_VOUT, bind: { txid: q.bind.txid, vout: q.bind.vout } });

  const readHex = (h, name, max) => {
    const s = String(h ?? '').replace(/^0x/i, '');
    if (!s || s.length % 2 || s.length > max * 2 || /[^0-9a-f]/i.test(s)) throw new HttpError(400, `${name} must be hex`);
    return deps.hexToBytes(s.toLowerCase());
  };
  function readOffer(o) {
    if (!o || typeof o !== 'object') throw new HttpError(400, 'offer required');
    const op = o.exitOpening;
    if (!op || !/^\d{1,20}$/.test(String(op.value ?? ''))) throw new HttpError(400, 'offer.exitOpening.value must be a decimal string');
    if (!/^(0x)?[0-9a-f]{1,64}$/i.test(String(op.blinding ?? ''))) throw new HttpError(400, 'offer.exitOpening.blinding must be hex');
    const b = String(op.blinding);
    const payout = readHex(o.payoutScriptPubKey, 'offer.payoutScriptPubKey', 64);
    return { exitOpening: { value: String(op.value), blinding: /^0x/i.test(b) ? b : '0x' + b }, payoutScriptPubKey: '0x' + deps.bytesToHex(payout) };
  }

  // Checks that stand for the indexer's acceptance, run before any sats move: the offer against the quote,
  // the anchor and its root, the nullifiers, and the proof under the pool's pinned system.
  async function checkOffer(q, payload, offer) {
    let sp;
    try { sp = mk.pool.parseSpend(payload, { full: true }); } catch (e) { throw new HttpError(400, `not a pool spend: ${e.message}`); }
    const st = await poolGet('/btc-pool/status');
    if (st.halted || st.height == null) throw new HttpError(503, 'the pool replay is paused; try again later');
    const sys = mk.verifier.system;
    if (!mk.verifier.verify || (st.proofSystem && sys?.id && st.proofSystem !== sys.id) || (st.vkHash && sys?.vkHash && String(st.vkHash).replace(/^0x/, '') !== String(sys.vkHash).replace(/^0x/, ''))) {
      throw new HttpError(503, 'the faucet is updating to the pool\'s proof system; try again shortly');
    }
    if (sp.hAnchor > st.height || sp.hAnchor < st.height + 2 - ANCHOR_WINDOW) throw new HttpError(400, 'the spend\'s anchor is outside the pool window; build it again');
    let r;
    try { r = await poolGet(`/btc-pool/root/${sp.hAnchor}`); } catch { r = null; }
    if (!r?.retained || !r.root) throw new HttpError(400, 'the pool keeps no root at the spend\'s anchor; build it again');
    for (const nf of sp.nullifiers) {
      const n = await poolGet(`/btc-pool/nullifier/${String(nf).replace(/^0x/, '')}`);
      if (n?.spent) throw new HttpError(409, 'a note in this spend is already spent');
    }
    try {
      return await mk.zap.validateExitToSats({ pool: mk.pool, payload, offer, maker: termsOf(q), amount: BigInt(q.units), asset: '0x' + state.assetId, root: r.root, verify: mk.verifier.verify });
    } catch (e) {
      throw new HttpError(400, String(e?.message || e).replace(/^btc-pool-zap: /, ''));
    }
  }

  // The carrier: vin[0] the envelope commit (script path, faucet key), vin[1] the bind coin; outputs from
  // makerCarrierOutputs. The commit is funded from the maker's other coins. Caller holds the lock.
  async function postCarrier(q, payload, v) {
    const coins = await makerCoins();
    const bind = coins.find((c) => c.txid === q.bind.txid && c.vout === q.bind.vout);
    if (!bind) throw new HttpError(409, 'the quote\'s bind coin is gone; get a new quote');
    const taken = reservedBinds(q.id);
    const funding = coins.filter((c) => !taken.has(opKey(c)) && opKey(c) !== opKey(bind))
      .sort((a, b) => (Number(b.confirmed) - Number(a.confirmed)) || b.value - a.value);
    const outputs = mk.zap.makerCarrierOutputs({
      exitVout: v.exitVout, wantVout: v.wantVout, wantValue: v.wantValue, payoutScriptPubKey: v.payoutScriptPubKey,
      makerSpk: mainSpk(), exitSats: tacit.DUST,
    }).map((o) => ({ value: Number(o.value), script: o.script }));
    const rate = cfg.makerFeeRate;
    const env = tacit.encodeEnvelopeScript(tacit.wallet.xonly(), payload);
    const { Q_xonly, parity } = tacit.tweakedOutputKey(tacit.TAP_NUMS, tacit.tapLeafHash(env));
    const commitSpk = tacit.p2trScript(Q_xonly);
    const cb = tacit.controlBlock(tacit.TAP_NUMS, parity);
    const witnessLen = 1 + 65 + (env.length < 0xfd ? 1 : 3) + env.length + 1 + 33 + 108;
    const baseLen = 4 + 1 + 41 * 2 + 1 + outputs.reduce((s, o) => s + 9 + o.script.length, 0) + 4;
    const revealFee = tacit.feeFor(Math.ceil((baseLen * 4 + 2 + witnessLen) / 4) + 5, rate);
    const outSum = outputs.reduce((s, o) => s + o.value, 0);
    const commitValue = Math.max(tacit.DUST, outSum + revealFee - bind.value);
    const picked = [];
    let total = 0, commitFee = 0;
    for (const c of funding) {
      picked.push(c); total += c.value;
      commitFee = tacit.feeFor(tacit.estCommitVb(picked.length), rate);
      if (total >= commitValue + commitFee + tacit.DUST) break;
    }
    if (!picked.length || total < commitValue + commitFee) throw new HttpError(503, 'the faucet has no sats free to buy back right now; try again in a few minutes');
    const change = total - commitValue - commitFee;
    const commitTx = {
      version: 2, locktime: 0,
      inputs: picked.map((c) => ({ txid: c.txid, vout: c.vout, sequence: 0xfffffffd, witness: [] })),
      outputs: [{ value: commitValue, script: commitSpk }, ...(change >= tacit.DUST ? [{ value: change, script: makerSpk }] : [])],
    };
    picked.forEach((c, i) => { commitTx.inputs[i].witness = tacit.signP2wpkhInputWithKey(commitTx, i, c.value, mk.key.priv, mk.key.pub); });
    const commitTxid = tacit.txid(commitTx);
    const revealTx = {
      version: 2, locktime: 0,
      inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }, { txid: bind.txid, vout: bind.vout, sequence: 0xfffffffd, witness: [] }],
      outputs,
    };
    const prevouts = [{ value: commitValue, script: commitSpk }, { value: bind.value, script: makerSpk }];
    revealTx.inputs[1].witness = tacit.signP2wpkhInputWithKey(revealTx, 1, bind.value, mk.key.priv, mk.key.pub);
    revealTx.inputs[0].witness = tacit.signTaprootScriptPathInput(revealTx, prevouts, env, cb);
    const revealTxid = tacit.txid(revealTx);
    const t = now();
    await tacit.broadcast(deps.bytesToHex(tacit.serializeTx(commitTx)));
    for (const c of picked) recentlySpent.set(opKey(c), t);
    try {
      await tacit.broadcastWithRetry(deps.bytesToHex(tacit.serializeTx(revealTx)));
    } catch (e) {
      // The commit output is the faucet key's (script path); recorded for manual recovery.
      state.makerStranded = [...(state.makerStranded || []), { quoteId: q.id, commitTxid, revealHex: deps.bytesToHex(tacit.serializeTx(revealTx)), at: t }].slice(-TAKEN_HISTORY);
      throw e;
    }
    recentlySpent.set(opKey(bind), t);
    return { commitTxid, revealTxid, fee: commitFee + revealFee };
  }

  // POST /faucet/maker/fill { quoteId, payload, offer }
  async function makerFill({ quoteId, payload: payloadHex, offer: rawOffer, ip }) {
    makerOff();
    if (!/^[0-9a-f]{32}$/.test(String(quoteId ?? ''))) throw new HttpError(400, 'quoteId required');
    const payload = readHex(payloadHex, 'payload', MAX_PAYLOAD_BYTES);
    const offer = readOffer(rawOffer);
    const tag = ipTag(ip || 'unknown');
    const q0 = quotes()[quoteId];
    if (!q0) throw new HttpError(404, 'no such quote; get a new one');
    if (now() >= q0.expiry) throw new HttpError(410, 'the quote has expired; get a new one');
    if (q0.state !== 'open') throw new HttpError(409, 'the quote is already being filled');
    if (recentFills(now()).filter((f) => f.ip === tag).length >= cfg.makerIpFills) throw new HttpError(429, `at most ${cfg.makerIpFills} swaps per client every 24 hours`);
    const v = await checkOffer(q0, payload, offer);
    return locked(async () => {
      const t = now();
      const q = quotes()[quoteId];
      if (!q || t >= q.expiry) throw new HttpError(410, 'the quote has expired; get a new one');
      if (q.state !== 'open') throw new HttpError(409, 'the quote is already being filled');
      q.state = 'filling'; save();
      let r;
      try {
        r = await postCarrier(q, payload, v);
      } catch (e) {
        // A carrier whose commit went out is not retried: its bind stays reserved until the quote lapses.
        q.state = (state.makerStranded || []).some((s) => s.quoteId === q.id) ? 'failed' : 'open';
        save();
        if (!(e instanceof HttpError)) logger(`maker fill ${quoteId} failed: ${String(e?.message || e).slice(0, 300)}`);
        throw e;
      }
      delete quotes()[quoteId];
      const sats = Number(v.wantValue);
      state.makerFills = [...recentFills(t), { quoteId, txid: r.revealTxid, units: q.units, sats, ip: tag, at: t }];
      state.makerFillTotal = (state.makerFillTotal || 0) + 1;
      // The exit note pays the faucet key; its opening comes from the offer.
      state.makerNotes = [...(state.makerNotes || []), {
        txid: r.revealTxid, vout: v.exitVout, value: tacit.DUST, amount: q.units,
        blinding: hex32(offer.exitOpening.blinding), quoteId, at: t, status: 'pending',
      }];
      save();
      logger(`maker filled ${quoteId}: ${q.units} units for ${sats} sats in ${r.revealTxid}`);
      return { txid: r.revealTxid, commitTxid: r.commitTxid, sats, units: q.units, exitVout: v.exitVout, wantVout: v.wantVout };
    });
  }

  // Exit notes the pool has recorded join the inventory: a lot-sized one is listed as a lot, others fold
  // into the reserve on the next split.
  async function refreshMakerNotes() {
    for (const n of (state.makerNotes || []).filter((x) => x.status === 'pending')) {
      let ex = null;
      try { ex = await poolGet(`/btc-pool/exit/${n.txid}/${n.vout}`); } catch { continue; }
      if (!ex?.exists) continue;
      if (BigInt(n.amount) === cfg.lot) {
        state.lots.push({ txid: n.txid, vout: n.vout, value: n.value, amount: n.amount, blinding: n.blinding });
        n.status = 'listed';
      } else n.status = 'ready';
      logger(`exit note ${opKey(n)} recorded by the pool: ${n.status}`);
    }
    const all = state.makerNotes || [];
    const done = (x) => x.status === 'listed' || x.status === 'merged';
    state.makerNotes = [...all.filter((x) => !done(x)), ...all.filter(done).slice(-TAKEN_HISTORY)];
    save();
  }

  // Keeps cfg.makerCoins coins on the maker key, funded from the faucet key above its floor.
  async function topUpMaker() {
    const coins = await makerCoins();
    const total = coins.reduce((s, c) => s + c.value, 0);
    if (coins.length >= Math.ceil(cfg.makerCoins / 2) && total >= (cfg.makerCoins * cfg.makerCoinSats) / 2) return;
    const k = Math.max(1, cfg.makerCoins - coins.length);
    try {
      const txid = await sendOutputs(Array.from({ length: k }, () => ({ value: cfg.makerCoinSats, script: makerSpk })), { wait: 0 });
      for (let i = 0; i < k; i++) recentlySpent.delete(`${txid}:${i}`);
      logger(`maker topped up with ${k} x ${cfg.makerCoinSats} sats in ${txid}`);
    } catch (e) {
      logger(`maker top-up skipped: ${e.message}`);
    }
  }

  function makerStatus() {
    if (!mk) return { enabled: false };
    const t = now();
    return {
      enabled: true,
      spread_bps: cfg.makerSpreadBps,
      sats_per_lot: priceOf(cfg.lot),
      min_units: String(minUnits()),
      max_units: cfg.makerMaxUnits.toString(),
      sats_left_today: Math.max(0, cfg.makerDailySats - satsCommitted(t)),
      open_quotes: openQuotes(t).length,
      fills_total: state.makerFillTotal || 0,
      recent_fills: recentFills(t).slice(-10).reverse().map(({ ip, ...f }) => f),
      notes_pending: (state.makerNotes || []).filter((x) => x.status === 'pending').length,
      notes_ready: (state.makerNotes || []).filter((x) => x.status === 'ready').length,
    };
  }

  function status() {
    const lots = state.lots || [];
    const open = lots.filter((l) => l.saleId);
    return {
      network: tacit.NET.name,
      asset_id: state.assetId || null,
      ticker: TICKER,
      decimals: DECIMALS,
      lot: cfg.lot.toString(),
      price_sats: cfg.priceSats,
      target_listings: cfg.target,
      seller_pubkey: tacit.wallet.pub ? sellerPub() : null,
      worker_base: WORKER_BASE,
      open_sales: open.map((l) => ({ sale_id: l.saleId, txid: l.txid, vout: l.vout, amount: l.amount, expiry: l.expiry })),
      buffered_lots: lots.length - open.length,
      reserve: state.reserve ? state.reserve.amount : '0',
      taken_total: state.takenTotal || 0,
      recent_takes: (state.taken || []).slice(0, 10),
      drip_sats: cfg.dripSats,
      drips_left_today: Math.max(0, cfg.dripDaily - recentDrips(now()).length),
      last_tick: lastTick,
      last_error: lastError,
      maker: makerStatus(),
    };
  }

  return { tick, status, drip, makerQuote, makerFill, state };
}

const MAX_BODY = 1024;
const MAX_FILL_BODY = 2 * MAX_PAYLOAD_BYTES + 8 * 1024;

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { req.removeAllListeners('data'); req.resume(); reject(new HttpError(413, 'body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// GET routes are public read-only data (any origin). POST /faucet/sats is limited to corsOrigins.
export function makeHandler(faucet, { corsOrigins = [], logger = log } = {}) {
  const allowed = new Set(corsOrigins);
  return async (req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    // Routes that spend or reserve the faucet's coins: allow-listed origins only.
    const ROUTES = {
      '/faucet/sats': { method: 'POST', label: 'drip' },
      '/faucet/maker/quote': { method: 'GET', label: 'maker quote' },
      '/faucet/maker/fill': { method: 'POST', label: 'maker fill' },
    };
    const route = ROUTES[url.pathname];
    if (route) {
      if (origin && allowed.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', `${route.method}, OPTIONS`);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      if (req.method === 'OPTIONS') { res.writeHead(origin && allowed.has(origin) ? 204 : 403); return res.end(); }
      if (req.method !== route.method) return send(405, { error: 'method not allowed' });
      if (origin && !allowed.has(origin)) return send(403, { error: 'origin not allowed' });
      try {
        const ip = clientIp(req);
        if (url.pathname === '/faucet/maker/quote') return send(200, await faucet.makerQuote({ units: url.searchParams.get('units'), ip }));
        const fill = url.pathname === '/faucet/maker/fill';
        let body;
        try { body = JSON.parse(await readBody(req, fill ? MAX_FILL_BODY : MAX_BODY)); } catch (e) {
          throw e instanceof HttpError ? e : new HttpError(400, fill ? 'body must be JSON {"quoteId", "payload", "offer"}' : 'body must be JSON {"address": "tb1…"}');
        }
        if (fill) return send(200, await faucet.makerFill({ quoteId: body?.quoteId, payload: body?.payload, offer: body?.offer, ip }));
        return send(200, await faucet.drip({ address: body?.address, ip }));
      } catch (e) {
        if (e instanceof HttpError) return send(e.status, { error: e.message });
        logger(`${route.label} failed: ${String(e?.message || e).slice(0, 300)}`);
        return send(502, { error: 'the faucet could not send right now; try again shortly' });
      }
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
    if (url.pathname === '/health') return send(200, { ok: true });
    if (url.pathname === '/faucet/status') return send(200, faucet.status());
    return send(404, { error: 'not found' });
  };
}

export function serve(faucet, port, opts = {}) {
  const handler = makeHandler(faucet, opts);
  const server = createServer((req, res) => handler(req, res).catch((e) => {
    log(`request failed: ${String(e?.message || e).slice(0, 300)}`);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"internal error"}'); }
  }));
  server.listen(port, () => log(`listening on :${port}`));
  return server;
}

// The maker's coin key, derived from the faucet key.
export function makerKeyFor({ deps }, privHex) {
  const seed = Buffer.from(String(privHex).trim().toLowerCase().replace(/^0x/, ''), 'hex');
  const d = BigInt('0x' + createHash('sha256').update('tacit-sats-faucet-maker-v1:').update(seed).digest('hex')) % deps.secp.CURVE.n;
  if (d === 0n) throw new Error('degenerate maker key');
  const priv = deps.hexToBytes(d.toString(16).padStart(64, '0'));
  return { priv, pub: deps.secp.getPublicKey(priv, true) };
}

// Pool modules and the pool's own proof verifier (the one the replay service accepts spends with).
// Returns null, with the reason logged, when the verifier cannot load; the maker is then off.
async function loadMaker(loaded, privHex) {
  const { deps } = loaded;
  const [{ makeBtcShieldedPool }, { makeBtcPoolZap }, { makeBtcPoolVerifier }] = await Promise.all([
    import(path.join(DAPP, 'btc-shielded-pool.js')),
    import(path.join(DAPP, 'btc-pool-zap.js')),
    import('./lib/btc-pool-verify.js'),
  ]);
  const verifier = makeBtcPoolVerifier({ network: 'signet', log });
  if (!verifier.enabled) { log(`maker off: ${verifier.reason}`); return null; }
  const hashes = { secp: deps.secp, sha256: deps.sha256, keccak256: deps.keccak_256 };
  return {
    key: makerKeyFor(loaded, privHex),
    pool: makeBtcShieldedPool({ ...hashes, ripemd160: deps.ripemd160 }),
    zap: makeBtcPoolZap(hashes),
    verifier,
  };
}

async function main() {
  const cfg = configFromEnv();
  if (!process.env.FAUCET_KEY) throw new Error('FAUCET_KEY is required');
  const loaded = await loadTacitHeadless(cfg.network);
  const pub = setWalletKey(loaded, process.env.FAUCET_KEY);
  log(`faucet seller ${pub} on ${cfg.network}; lot ${cfg.lot}, price ${cfg.priceSats} sats, target ${cfg.target}`);
  const maker = cfg.maker ? await loadMaker(loaded, process.env.FAUCET_KEY) : null;
  if (maker) log(`maker on: key ${loaded.deps.bytesToHex(maker.key.pub)}, proofs ${maker.verifier.system.id} ${maker.verifier.vkHash}`);
  const faucet = makeFaucet({ ...loaded, cfg, store: openStateFile(cfg.statePath), maker });
  serve(faucet, cfg.port, { corsOrigins: cfg.corsOrigins });
  for (;;) {
    await faucet.tick();
    await sleep(cfg.pollSecs * 1000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[sats-faucet] fatal: ${e?.message || e}`); process.exit(1); });
}
