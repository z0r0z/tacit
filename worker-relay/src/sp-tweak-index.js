// Silent-payment tweak index (BIP-352). For every block it publishes, per
// transaction with at least one taproot output, the public tweak data
// input_hash·A_sum (33-byte compressed) and that transaction's taproot outputs.
// A wallet multiplies each tweak by its own scan key and compares outputs
// locally, so the index never learns which outputs, if any, belong to whom.
// Eligibility and the tweak come from dapp/bip352.js, the same code the wallet
// runs.
//
// Env:
//   SP_NETWORK        signet (default) or mainnet
//   BTC_RPC_URL       bitcoind JSON-RPC (getblock verbosity 3); used instead of Esplora when set.
//                     Credentials in the URL or in BTC_RPC_USER / BTC_RPC_PASS.
//   ESPLORA_URLS      comma-separated Esplora bases (default mempool.space + blockstream.info for the network)
//   SP_DB             SQLite file (default /var/lib/tacit-sp-index/index.db)
//   START_HEIGHT      first height indexed on an empty database (default tip - 1000)
//   REORG_DEPTH       deepest rollback attempted before halting (default 100)
//   POLL_SECS         tip poll interval (default 30)
//   ESPLORA_MIN_MS    minimum spacing between Esplora requests (default 120)
//   PREFETCH          blocks fetched ahead in parallel (default 4)
//   PORT              HTTP port (default 10000)
//
// HTTP (GET, CORS *):
//   /health                  { ok, network, height, source }
//   /sp/tip                  { network, height, hash, startHeight }
//   /sp/tweaks/:height       { height, hash, time, tweaks: [{ txid, tweak, outputs: [{ vout, xonly, value }] }] }
//   /sp/tweaks?from=&to=     { tip, blocks: [ ...as above ] }, at most 100 blocks

import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { bip352PublicTweakFromEsploraTx } from '../../dapp/bip352.js';

const log = (...a) => console.log(`[sp-index ${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const RANGE_MAX = 100;

const ESPLORA_DEFAULTS = {
  signet: ['https://mempool.space/signet/api', 'https://blockstream.info/signet/api'],
  mainnet: ['https://mempool.space/api', 'https://blockstream.info/api'],
};

// ---------------------------------------------------------------- tweaks

// Esplora-shaped tx → index entry, or null when the tx has no taproot output
// or contributes no tweak (coinbase, witness v2+ input, no eligible key).
export function tweakEntryForTx(tx) {
  const outputs = [];
  (tx.vout || []).forEach((o, vout) => {
    const spk = o.scriptpubkey || '';
    if (spk.length === 68 && spk.startsWith('5120')) outputs.push({ vout, xonly: spk.slice(4), value: Number(o.value) });
  });
  if (!outputs.length) return null;
  let tweak;
  try { tweak = bip352PublicTweakFromEsploraTx(tx); } catch { return null; }
  if (!tweak) return null;
  return { txid: tx.txid, tweak: bytesToHex(tweak), outputs };
}

export function computeBlockTweaks(txs) {
  const out = [];
  for (const tx of txs) {
    const e = tweakEntryForTx(tx);
    if (e) out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------- sources

// Esplora: /block/:hash/txs/:start pages carry prevout scripts, scriptSig and
// witness for every input, which is all BIP-352 needs.
// Requests are spaced minIntervalMs apart across all callers. A base that
// answers 429 or 5xx cools down (doubling per strike, reset on success) and
// requests go to the others meanwhile.
export function makeEsploraSource({ bases, minIntervalMs = 120, fetchImpl = fetch } = {}) {
  const state = bases.map((url) => ({ url, until: 0, strikes: 0 }));
  let gate = Promise.resolve(), turn = 0;
  const slot = () => { const g = gate.then(() => sleep(minIntervalMs)); gate = g; return gate; };
  async function pick() {
    for (;;) {
      await slot();
      const now = Date.now();
      for (let i = 0; i < state.length; i++) {
        const s = state[(turn + i) % state.length];
        if (s.until <= now) { turn = (turn + i + 1) % state.length; return s; }
      }
      await sleep(Math.max(50, Math.min(...state.map((s) => s.until)) - now));
    }
  }
  async function get(p, { text = false } = {}) {
    let last, notFound = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      const s = await pick();
      try {
        const r = await fetchImpl(s.url + p, { signal: AbortSignal.timeout(30_000) });
        if (r.ok) { s.strikes = 0; return text ? (await r.text()).trim() : await r.json(); }
        last = new Error(`${r.status} ${s.url}${p}`);
        if (r.status === 404 || r.status === 400) { if (++notFound >= state.length) throw last; continue; }
        s.strikes++;
        s.until = Date.now() + Math.min(120_000, 2000 * 2 ** (s.strikes - 1));
        if (s.strikes <= 2 || s.strikes % 5 === 0) log(`esplora ${r.status} from ${s.url}; cooling down (strike ${s.strikes})`);
      } catch (e) {
        if (e === last) throw e;
        last = e;
        s.strikes++;
        s.until = Date.now() + Math.min(120_000, 2000 * 2 ** (s.strikes - 1));
      }
    }
    throw last;
  }
  return {
    name: 'esplora',
    async tipHeight() { return Number(await get('/blocks/tip/height', { text: true })); },
    async blockHash(h) { return get(`/block-height/${h}`, { text: true }); },
    async block(hash) {
      const b = await get(`/block/${hash}`);
      const starts = [];
      for (let s = 0; s < b.tx_count; s += 25) starts.push(s);
      const txs = [];
      for (let i = 0; i < starts.length; i += 4) {
        const pages = await Promise.all(starts.slice(i, i + 4).map((s) => get(`/block/${hash}/txs/${s}`)));
        for (const [j, page] of pages.entries()) {
          if (!Array.isArray(page)) throw new Error(`bad txs page ${hash}/${starts[i + j]}`);
          txs.push(...page);
        }
      }
      if (txs.length !== b.tx_count) throw new Error(`block ${hash}: ${txs.length} txs of ${b.tx_count}`);
      return { hash: b.id, height: b.height, prev: b.previousblockhash || null, time: b.timestamp, txs };
    },
  };
}

// bitcoind: getblock verbosity 3 includes each input's prevout.
export function makeRpcSource({ url, user, pass, fetchImpl = fetch } = {}) {
  const u = new URL(url);
  const auth = user || u.username ? Buffer.from(`${decodeURIComponent(user || u.username)}:${decodeURIComponent(pass || u.password)}`).toString('base64') : null;
  u.username = ''; u.password = '';
  let id = 0;
  async function rpc(method, params = []) {
    let last;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const r = await fetchImpl(u.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Basic ${auth}` } : {}) },
          body: JSON.stringify({ jsonrpc: '1.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(120_000),
        });
        const j = await r.json();
        if (j.error) throw Object.assign(new Error(`${method}: ${j.error.message}`), { rpc: true });
        return j.result;
      } catch (e) { if (e.rpc) throw e; last = e; }
      await sleep(1000 * 2 ** attempt);
    }
    throw last;
  }
  const sats = (btc) => Math.round(Number(btc) * 1e8);
  return {
    name: 'bitcoind',
    tipHeight: () => rpc('getblockcount'),
    blockHash: (h) => rpc('getblockhash', [h]),
    async block(hash) {
      const b = await rpc('getblock', [hash, 3]);
      const txs = b.tx.map((t) => ({
        txid: t.txid,
        vin: t.vin.map((v) => v.coinbase ? { is_coinbase: true, txid: '00'.repeat(32), vout: 0xffffffff } : {
          txid: v.txid, vout: v.vout,
          scriptsig: v.scriptSig?.hex || '',
          witness: v.txinwitness || [],
          prevout: { scriptpubkey: v.prevout?.scriptPubKey?.hex || '' },
        }),
        vout: t.vout.map((o) => ({ scriptpubkey: o.scriptPubKey.hex, value: sats(o.value) })),
      }));
      return { hash: b.hash, height: b.height, prev: b.previousblockhash || null, time: b.time, txs };
    },
  };
}

// ---------------------------------------------------------------- store

export function openStore(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      height INTEGER PRIMARY KEY, hash TEXT NOT NULL, prev TEXT, time INTEGER, tweaks TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  const q = {
    top: db.prepare('SELECT height, hash FROM blocks ORDER BY height DESC LIMIT 1'),
    get: db.prepare('SELECT * FROM blocks WHERE height = ?'),
    range: db.prepare('SELECT * FROM blocks WHERE height BETWEEN ? AND ? ORDER BY height'),
    put: db.prepare('INSERT OR REPLACE INTO blocks (height, hash, prev, time, tweaks) VALUES (?, ?, ?, ?, ?)'),
    del: db.prepare('DELETE FROM blocks WHERE height >= ?'),
    getMeta: db.prepare('SELECT v FROM meta WHERE k = ?'),
    setMeta: db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)'),
  };
  const row = (r) => r && { height: r.height, hash: r.hash, time: r.time, tweaks: JSON.parse(r.tweaks) };
  return {
    db,
    top: () => q.top.get() || null,
    get: (h) => row(q.get.get(h)),
    range: (a, b) => q.range.all(a, b).map(row),
    put: (b) => q.put.run(b.height, b.hash, b.prev, b.time, JSON.stringify(b.tweaks)),
    rollbackFrom: (h) => q.del.run(h),
    meta: (k) => q.getMeta.get(k)?.v ?? null,
    setMeta: (k, v) => q.setMeta.run(k, String(v)),
  };
}

// ---------------------------------------------------------------- indexer

export function createIndexer({ source, store, startHeight = null, reorgDepth = 100, network = 'signet', prefetch = 4 }) {
  let halted = null;
  async function start() {
    let s = store.meta('startHeight');
    if (s === null) {
      const h = Number.isInteger(startHeight) ? startHeight : Math.max(0, (await source.tipHeight()) - 1000);
      store.setMeta('startHeight', h);
      store.setMeta('network', network);
      s = h;
    } else if (store.meta('network') !== network) {
      throw new Error(`database is for ${store.meta('network')}, not ${network}`);
    }
    return Number(s);
  }
  // Roll back while the stored top no longer matches the chain.
  async function reconcile() {
    for (let depth = 0; ; depth++) {
      const top = store.top();
      if (!top) return;
      const hash = await source.blockHash(top.height).catch(() => null);
      if (hash === top.hash) return;
      if (depth >= reorgDepth) { halted = `reorg deeper than ${reorgDepth} at ${top.height}`; throw new Error(halted); }
      log(`reorg: dropping ${top.height} ${top.hash.slice(0, 16)}…`);
      store.rollbackFrom(top.height);
    }
  }
  const fetchHeight = async (h) => {
    const hash = await source.blockHash(h);
    const b = await source.block(hash);
    if (b.height !== h || b.hash !== hash) throw new Error(`block ${h}: source returned ${b.height} ${b.hash}`);
    return b;
  };
  // Store one fetched block; returns false when it does not extend the stored chain.
  function commit(h, b) {
    const below = store.get(h - 1);
    if (below && b.prev !== below.hash) return false;
    store.put({ height: h, hash: b.hash, prev: b.prev, time: b.time, tweaks: computeBlockTweaks(b.txs) });
    return true;
  }
  // Blocks are fetched `prefetch` ahead in parallel and committed strictly in height order.
  async function step({ maxBlocks = Infinity } = {}) {
    const startH = await start();
    await reconcile();
    const tip = await source.tipHeight();
    let h = (store.top()?.height ?? startH - 1) + 1;
    let n = 0;
    const pending = new Map();
    while (h <= tip && n < maxBlocks) {
      for (let k = h; k < h + prefetch && k <= tip; k++) {
        if (!pending.has(k)) pending.set(k, fetchHeight(k).then((b) => ({ b }), (err) => ({ err })));
      }
      const r = await pending.get(h);
      pending.delete(h);
      if (r.err) throw r.err;
      if (!commit(h, r.b)) {
        pending.clear();
        await reconcile();
        h = (store.top()?.height ?? startH - 1) + 1;
        continue;
      }
      if (h % 50 === 0 || h === tip) log(`indexed ${h}/${tip}`);
      h++; n++;
    }
    return n;
  }
  return { start, step, reconcile, halted: () => halted };
}

// ---------------------------------------------------------------- http

export function createHandler({ store, network, sourceName = '' }) {
  const tipInfo = () => {
    const top = store.top();
    return { network, height: top ? top.height : null, hash: top ? top.hash : null, startHeight: Number(store.meta('startHeight') ?? 0) };
  };
  return (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': code === 200 && body && body.height != null && req.url.startsWith('/sp/tweaks/') ? 'public, max-age=60' : 'no-store',
      });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*', 'Access-Control-Max-Age': '86400' });
      return res.end();
    }
    if (req.method !== 'GET') return send(405, { error: 'GET only' });
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (p === '/health' || p === '/') { const t = tipInfo(); return send(200, { ok: t.height !== null, network, height: t.height, source: sourceName }); }
    if (p === '/sp/tip') return send(200, tipInfo());
    let m;
    if ((m = p.match(/^\/sp\/tweaks\/(\d{1,9})$/))) {
      const b = store.get(Number(m[1]));
      return b ? send(200, b) : send(404, { error: 'height not indexed', tip: tipInfo().height });
    }
    if (p === '/sp/tweaks') {
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return send(400, { error: 'from and to must be integers, from <= to' });
      if (to - from + 1 > RANGE_MAX) return send(400, { error: `at most ${RANGE_MAX} blocks per request` });
      return send(200, { tip: tipInfo().height, blocks: store.range(from, to) });
    }
    return send(404, { error: 'not found' });
  };
}

// ---------------------------------------------------------------- main

export function configFromEnv(env = process.env) {
  const network = env.SP_NETWORK || 'signet';
  if (!ESPLORA_DEFAULTS[network]) throw new Error(`SP_NETWORK must be signet or mainnet, got ${network}`);
  const int = (v) => (v === undefined || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : null);
  return {
    network,
    rpcUrl: env.BTC_RPC_URL || null,
    rpcUser: env.BTC_RPC_USER || null,
    rpcPass: env.BTC_RPC_PASS || null,
    esploraBases: (env.ESPLORA_URLS ? env.ESPLORA_URLS.split(',') : ESPLORA_DEFAULTS[network]).map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
    db: env.SP_DB || '/var/lib/tacit-sp-index/index.db',
    startHeight: int(env.START_HEIGHT),
    reorgDepth: int(env.REORG_DEPTH) ?? 100,
    pollSecs: int(env.POLL_SECS) ?? 30,
    esploraMinMs: int(env.ESPLORA_MIN_MS) ?? 120,
    prefetch: Math.max(1, int(env.PREFETCH) ?? 4),
    port: int(env.PORT) ?? 10000,
  };
}

async function main() {
  const cfg = configFromEnv();
  const source = cfg.rpcUrl
    ? makeRpcSource({ url: cfg.rpcUrl, user: cfg.rpcUser, pass: cfg.rpcPass })
    : makeEsploraSource({ bases: cfg.esploraBases, minIntervalMs: cfg.esploraMinMs });
  const store = openStore(cfg.db);
  const ix = createIndexer({ source, store, startHeight: cfg.startHeight, reorgDepth: cfg.reorgDepth, network: cfg.network, prefetch: cfg.prefetch });
  createServer(createHandler({ store, network: cfg.network, sourceName: source.name }))
    .listen(cfg.port, () => log(`${cfg.network} via ${source.name}, listening on ${cfg.port}`));
  for (;;) {
    try { await ix.step(); }
    catch (e) {
      log('step failed:', e.message);
      if (ix.halted()) { log('halted:', ix.halted()); return; }
    }
    await sleep(cfg.pollSecs * 1000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
