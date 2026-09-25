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
//   PORT                    HTTP port for GET /faucet/status and /health (default 10000)

import { createServer } from 'node:http';
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
  };
  if (cfg.network !== 'signet') throw new Error('sats-faucet runs on signet only');
  if (cfg.assetId && !/^[0-9a-f]{64}$/.test(cfg.assetId)) throw new Error('FAUCET_ASSET_ID must be 32-byte hex');
  if (cfg.lot <= 0n || cfg.supply < cfg.lot) throw new Error('FAUCET_LOT must be positive and at most FAUCET_SUPPLY');
  if (cfg.target > 50) throw new Error('FAUCET_TARGET_LISTINGS above 50');
  return cfg;
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

export function makeFaucet({ tacit, deps, cfg, store, logger = log }) {
  const state = store.load();
  const esplora = tacit.NET.api;
  let busy = false;
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
    const avail = BigInt(state.reserve.amount) / cfg.lot;
    let k = SPLIT_SIZES.find((n) => n >= deficit) || SPLIT_SIZES[SPLIT_SIZES.length - 1];
    if (BigInt(k) > avail) k = [...SPLIT_SIZES].reverse().find((n) => BigInt(n) <= avail) || 0;
    if (!k) { logger(`reserve ${state.reserve.amount} below one lot; not splitting`); return; }
    const reserve = { ...state.reserve, value: await outValue(state.reserve.txid, state.reserve.vout) };
    logger(`splitting ${k} lots of ${cfg.lot} from ${opKey(reserve)}`);
    const own = sellerPub();
    const r = await tacit.buildAndBroadcastCXferMulti({
      assetIdHex: state.assetId,
      recipients: Array.from({ length: k }, () => ({ pubHex: own, amount: cfg.lot })),
      forceUtxos: [forceUtxo(reserve)],
      allowDuplicateRecipients: true,
    });
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
      await ensureAsset();
      await refreshLots();
      await split();
      await reconcileListings();
      lastError = null;
      return true;
    } catch (e) {
      lastError = String(e?.message || e).slice(0, 500);
      logger(`tick failed: ${lastError}`);
      return false;
    } finally {
      lastTick = Math.floor(Date.now() / 1000);
      busy = false;
    }
  }

  function status() {
    const open = state.lots.filter((l) => l.saleId);
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
      buffered_lots: state.lots.length - open.length,
      reserve: state.reserve ? state.reserve.amount : '0',
      taken_total: state.takenTotal || 0,
      recent_takes: (state.taken || []).slice(0, 10),
      last_tick: lastTick,
      last_error: lastError,
    };
  }

  return { tick, status, state };
}

export function serve(faucet, port) {
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://x');
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
    if (url.pathname === '/health') return send(200, { ok: true });
    if (url.pathname === '/faucet/status') return send(200, faucet.status());
    return send(404, { error: 'not found' });
  });
  server.listen(port, () => log(`listening on :${port}`));
  return server;
}

async function main() {
  const cfg = configFromEnv();
  if (!process.env.FAUCET_KEY) throw new Error('FAUCET_KEY is required');
  const loaded = await loadTacitHeadless(cfg.network);
  const pub = setWalletKey(loaded, process.env.FAUCET_KEY);
  log(`faucet seller ${pub} on ${cfg.network}; lot ${cfg.lot}, price ${cfg.priceSats} sats, target ${cfg.target}`);
  const faucet = makeFaucet({ ...loaded, cfg, store: openStateFile(cfg.statePath) });
  serve(faucet, cfg.port);
  for (;;) {
    await faucet.tick();
    await sleep(cfg.pollSecs * 1000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[sats-faucet] fatal: ${e?.message || e}`); process.exit(1); });
}
