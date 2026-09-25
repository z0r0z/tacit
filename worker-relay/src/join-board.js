// Secret Sats Join bulletin board (contracts/sp1/confidential/DESIGN-secret-sats-join.md §5.1).
//
// Stores and forwards signed messages per topic. It checks sizes and signatures (a JOIN under its coin's
// key, every other message under a session key bound by a JOIN in the topic) and runs no protocol logic:
// round formation, the transaction and every exclusion are computed by the participants. Its one duty is
// CLOSE(topic, last_seq), signed with the board key at the first block after the topic's h_ref plus a delay.
// It holds no funds and no participant key. Anyone can run it.
//
// Env:
//   JOIN_NETWORK            signet (default) or mainnet
//   JOIN_BOARD_KEY          32-byte hex BIP-340 board key. Optional: when unset the key is loaded from the
//                           database, or generated (and stored when JOIN_DB is set). Topics commit the key,
//                           so a new key starts new topics.
//   JOIN_DB                 SQLite file for messages and the board key (default: memory only)
//   ESPLORA_URLS            comma-separated Esplora bases for the tip (default mempool.space + blockstream.info)
//   JOIN_CLOSE_DELAY_SECS   delay after the first block past h_ref before CLOSE (default 60)
//   JOIN_TICK_SECS          tip poll interval (default 15)
//   JOIN_TTL_HOURS          message retention (default 24)
//   JOIN_MAX_TOPICS         open topics kept at once (default 256)
//   JOIN_MAX_JOINS          JOINs per topic (default 4 × k_max)
//   JOIN_MAX_MSGS           messages per topic (default 20,000)
//   JOIN_MAX_BODY_BYTES     largest request body (default 65,536 + 80·k_max²)
//   JOIN_RATE_POST          POSTs per IP per minute (default 600)
//   JOIN_RATE_GET           GETs per IP per minute (default 2,400)
//   JOIN_CORS_ORIGINS       allowed origins (default https://tacit.finance,http://localhost:8765)
//   PORT                    HTTP port (default 10000)
//
// HTTP:
//   GET  /health                        { ok, network, tip }
//   GET  /join/v1/info                  { boardKey, network, tip, kMin, kMax, tiers, buckets, closeDelaySecs }
//   POST /join/v1/<topic>               append a JOIN, MSG, EVIDENCE → { seq }
//   GET  /join/v1/<topic>?since=&wait=  messages after seq, long-polled up to `wait` seconds (≤ 25)
//   GET  /join/v1/topics                open and recent topics with JOIN counts
//   GET  /join/v1/evidence              every EVIDENCE message held
//   POST /join/v1/log                   { topic, txid } a completed join (unsigned; clients check the chain)
//   GET  /join/v1/log                   { log: [{ topic, txid, at }] }

import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NETWORKS, BUCKETS, STEP, topicId, verifyJoin, verifyMsg, verifyEvidenceSig, makeClose, xonlyOfPriv,
  randomScalar, checkBucket,
} from '../../dapp/secret-sats-join.js';

const log = (...a) => console.log(`[join-board ${new Date().toISOString()}]`, ...a);
const int = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const ESPLORA_DEFAULTS = {
  signet: ['https://mempool.space/signet/api', 'https://blockstream.info/signet/api'],
  mainnet: ['https://mempool.space/api', 'https://blockstream.info/api'],
};

export function configFromEnv(env = process.env) {
  const network = env.JOIN_NETWORK || 'signet';
  if (!NETWORKS[network]) throw new Error(`JOIN_NETWORK ${network} unknown`);
  const kMax = NETWORKS[network].kMax;
  return {
    network,
    boardKeyHex: (env.JOIN_BOARD_KEY || '').replace(/^0x/, '').toLowerCase() || null,
    db: env.JOIN_DB || null,
    esplora: (env.ESPLORA_URLS || ESPLORA_DEFAULTS[network].join(',')).split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
    closeDelayMs: int(env.JOIN_CLOSE_DELAY_SECS, 60) * 1000,
    tickMs: int(env.JOIN_TICK_SECS, 15) * 1000,
    ttlMs: int(env.JOIN_TTL_HOURS, 24) * 3600_000,
    maxTopics: int(env.JOIN_MAX_TOPICS, 256),
    maxJoins: int(env.JOIN_MAX_JOINS, 4 * kMax),
    maxMsgs: int(env.JOIN_MAX_MSGS, 20_000),
    // Evidence of a bad vector carries every DC vector of the run: about 64·k_max² bytes of hex.
    maxBody: int(env.JOIN_MAX_BODY_BYTES, 65_536 + 80 * kMax * kMax),
    ratePost: int(env.JOIN_RATE_POST, 600),
    rateGet: int(env.JOIN_RATE_GET, 2400),
    corsOrigins: (env.JOIN_CORS_ORIGINS || 'https://tacit.finance,http://localhost:8765').split(',').map((s) => s.trim()).filter(Boolean),
    port: int(env.PORT, 10000),
  };
}

// ─────────────────────────────────────────────────────────────── storage

// Memory store; with a SQLite path it also writes through and reloads on start.
export async function openStore(dbPath = null) {
  const topics = new Map(); // topic → { meta, msgs: [{ seq, msg, at }], closed, sessions, outpoints, stepCounts }
  let db = null;
  if (dbPath) {
    const { default: Database } = await import('better-sqlite3');
    mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
             CREATE TABLE IF NOT EXISTS msgs (topic TEXT, seq INTEGER, at INTEGER, json TEXT, PRIMARY KEY (topic, seq));
             CREATE TABLE IF NOT EXISTS joinlog (topic TEXT, txid TEXT, at INTEGER, PRIMARY KEY (topic, txid));`);
  }
  const txLog = [];
  const store = {
    topics, txLog,
    getMeta: (k) => (db ? db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null : null),
    setMeta: (k, v) => { if (db) db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(k, v); },
    persist: (topic, rec) => { if (db) db.prepare('INSERT INTO msgs (topic, seq, at, json) VALUES (?, ?, ?, ?)').run(topic, rec.seq, rec.at, JSON.stringify(rec.msg)); },
    persistLog: (e) => { if (db) db.prepare('INSERT OR IGNORE INTO joinlog (topic, txid, at) VALUES (?, ?, ?)').run(e.topic, e.txid, e.at); },
    drop: (topic) => { topics.delete(topic); if (db) db.prepare('DELETE FROM msgs WHERE topic = ?').run(topic); },
    pruneLog: (before) => {
      while (txLog.length && txLog[0].at < before) txLog.shift();
      if (db) db.prepare('DELETE FROM joinlog WHERE at < ?').run(before);
    },
    load: () => {
      if (!db) return [];
      const rows = db.prepare('SELECT topic, seq, at, json FROM msgs ORDER BY topic, seq').all();
      for (const e of db.prepare('SELECT topic, txid, at FROM joinlog ORDER BY at').all()) txLog.push(e);
      return rows.map((r) => ({ topic: r.topic, seq: r.seq, at: r.at, msg: JSON.parse(r.json) }));
    },
  };
  return store;
}

// ─────────────────────────────────────────────────────────────── board core

// tip: async () → height. now: clock. Returns the board's operations, independent of HTTP.
export function createBoard({ cfg, store, boardPriv, tip, now = () => Date.now() }) {
  const boardKey = hexOf(xonlyOfPriv(boardPriv));
  const params = NETWORKS[cfg.network];
  const waiters = new Map(); // topic → Set(fn)
  let tipHeight = null;
  let tipSeenAt = new Map(); // height → first time the board saw it

  const topicRec = (topic) => store.topics.get(topic);
  const wake = (topic) => { for (const w of waiters.get(topic) || []) w(); };

  function append(topic, msg, { persist = true, at = now(), seq = null } = {}) {
    const t = topicRec(topic);
    const rec = { seq: seq ?? t.msgs.length + 1, msg, at };
    t.msgs.push(rec);
    t.last = at;
    if (msg.t === 'JOIN') { t.sessions.add(msg.session); t.outpoints.add(`${msg.txid}:${msg.vout}`); }
    if (msg.t === 'MSG') { const k = `${msg.session}:${msg.r}:${msg.step}`; t.stepCounts.set(k, (t.stepCounts.get(k) || 0) + 1); }
    if (msg.t === 'CLOSE') t.closed = rec.seq;
    if (persist) store.persist(topic, rec);
    wake(topic);
    return rec.seq;
  }

  function newTopic(topic, meta, at = now()) {
    const rec = { meta, msgs: [], closed: 0, sessions: new Set(), outpoints: new Set(), stepCounts: new Map(), created: at, last: at };
    store.topics.set(topic, rec);
    return rec;
  }

  // Rebuild from persisted messages.
  for (const row of store.load()) {
    if (!topicRec(row.topic)) {
      const m = row.msg;
      if (m.t !== 'JOIN') continue;
      newTopic(row.topic, { network: m.network, d: m.d, fr: m.fr, hRef: m.hRef }, row.at);
    }
    append(row.topic, row.msg, { persist: false, at: row.at, seq: row.seq });
  }

  const err = (status, error) => Object.assign(new Error(error), { status });

  // Validates and appends one posted message. Returns { seq }.
  function post(topic, msg) {
    if (!/^[0-9a-f]{64}$/.test(topic)) throw err(404, 'unknown topic');
    if (!msg || typeof msg !== 'object' || msg.topic !== topic) throw err(400, 'message topic mismatch');
    let t = topicRec(topic);
    if (msg.t === 'JOIN') {
      if (msg.network !== cfg.network) throw err(400, 'wrong network');
      if (!params.tiers.includes(msg.d)) throw err(400, 'tier not offered');
      try { checkBucket(msg.fr); } catch { throw err(400, 'not a fee bucket'); }
      if (!Number.isInteger(msg.hRef) || msg.hRef < 0) throw err(400, 'bad h_ref');
      if (tipHeight != null && (msg.hRef > tipHeight + 1 || msg.hRef < tipHeight - 6)) throw err(400, 'h_ref is not near the tip');
      if (topicId({ network: msg.network, d: msg.d, fr: msg.fr, hRef: msg.hRef, boardKey }) !== topic) throw err(400, 'topic is not this board\'s');
      if (!verifyJoin(msg)) throw err(400, 'JOIN signature does not verify');
      if (!t) {
        if (store.topics.size >= cfg.maxTopics) throw err(503, 'too many open topics');
        t = newTopic(topic, { network: msg.network, d: msg.d, fr: msg.fr, hRef: msg.hRef });
      }
      if (t.closed) throw err(409, 'topic closed');
      if (t.outpoints.has(`${msg.txid}:${msg.vout}`)) throw err(409, 'coin already joined this topic');
      if (t.sessions.has(msg.session)) throw err(409, 'session key already bound');
      if (t.sessions.size >= cfg.maxJoins) throw err(429, 'topic full');
      return { seq: append(topic, strip(msg, JOIN_FIELDS)) };
    }
    if (!t) throw err(404, 'unknown topic');
    if (t.msgs.length >= cfg.maxMsgs) throw err(429, 'topic message cap');
    if (msg.t === 'MSG') {
      if (!t.closed) throw err(409, 'topic not closed');
      if (!sessionBound(t, msg.session)) throw err(403, 'session not bound by a JOIN before CLOSE');
      if (!verifyMsg(msg, { kMax: params.kMax })) throw err(400, 'message does not verify');
      const k = `${msg.session}:${msg.r}:${msg.step}`;
      // Two per step keeps equivocation provable without letting a session flood a step.
      if ((t.stepCounts.get(k) || 0) >= 2) throw err(429, 'step cap');
      return { seq: append(topic, strip(msg, MSG_FIELDS)) };
    }
    if (msg.t === 'EVIDENCE') {
      if (!sessionBound(t, msg.session)) throw err(403, 'session not bound by a JOIN');
      if (!verifyEvidenceSig(msg)) throw err(400, 'evidence signature does not verify');
      if (t.msgs.filter((m) => m.msg.t === 'EVIDENCE').length >= 4 * params.kMax) throw err(429, 'evidence cap');
      return { seq: append(topic, strip(msg, EVIDENCE_FIELDS)) };
    }
    throw err(400, 'unknown message type');
  }

  function sessionBound(t, session) {
    return t.msgs.some((m) => m.msg.t === 'JOIN' && m.msg.session === session && (!t.closed || m.seq <= t.closed));
  }

  function messagesSince(topic, since) {
    const t = topicRec(topic);
    if (!t) return null;
    return t.msgs.filter((m) => m.seq > since).map(({ seq, msg }) => ({ seq, msg }));
  }

  // Long-poll: resolves at once when messages exist after `since`, else on the next append or timeout.
  function poll(topic, since, waitMs) {
    const now0 = messagesSince(topic, since);
    if (now0 === null) {
      if (!waitMs) return Promise.resolve({ messages: [], closed: false });
    } else if (now0.length || !waitMs) {
      return Promise.resolve({ messages: now0, closed: !!topicRec(topic)?.closed, last: topicRec(topic).msgs.length });
    }
    return new Promise((resolve) => {
      const set = waiters.get(topic) || new Set();
      waiters.set(topic, set);
      const done = () => {
        clearTimeout(timer); set.delete(done);
        resolve({ messages: messagesSince(topic, since) || [], closed: !!topicRec(topic)?.closed, last: topicRec(topic)?.msgs.length ?? since });
      };
      const timer = setTimeout(done, waitMs);
      set.add(done);
    });
  }

  function topics() {
    return [...store.topics.entries()].map(([topic, t]) => ({
      topic, ...t.meta, joins: t.sessions.size, closed: !!t.closed, lastSeq: t.msgs.length, created: t.created,
    }));
  }

  function evidence() {
    const out = [];
    for (const t of store.topics.values()) for (const m of t.msgs) if (m.msg.t === 'EVIDENCE') out.push(m.msg);
    return out;
  }

  function addLog(topic, txid) {
    if (!/^[0-9a-f]{64}$/.test(String(txid)) || !topicRec(topic)) throw err(400, 'bad log entry');
    if (store.txLog.some((e) => e.topic === topic && e.txid === txid)) return { ok: true };
    if (store.txLog.filter((e) => e.topic === topic).length >= 16) throw err(429, 'log cap');
    const e = { topic, txid, at: now() };
    store.txLog.push(e); store.persistLog(e);
    return { ok: true };
  }

  // Closes topics whose h_ref the chain has passed (after the delay), and drops expired topics.
  async function tick() {
    try {
      const h = await tip();
      if (Number.isInteger(h)) {
        if (!tipSeenAt.has(h)) tipSeenAt.set(h, now());
        tipHeight = h;
        for (const k of tipSeenAt.keys()) if (k < h - 20) tipSeenAt.delete(k);
      }
    } catch (e) { log('tip fetch failed:', e.message); }
    const t0 = now();
    for (const [topic, t] of store.topics) {
      if (t.last + cfg.ttlMs < t0) { store.drop(topic); continue; }
      if (t.closed || tipHeight == null || tipHeight <= t.meta.hRef) continue;
      // First block after h_ref: the earliest height above h_ref the board has seen.
      let first = null;
      for (const [hh, at] of tipSeenAt) if (hh > t.meta.hRef && (first == null || at < first)) first = at;
      if (first == null) first = t0;
      if (t0 >= first + cfg.closeDelayMs) {
        const close = makeClose({ topic, lastSeq: t.msgs.length, boardPriv });
        append(topic, close);
        log(`CLOSE ${topic.slice(0, 12)}… d=${t.meta.d} fr=${t.meta.fr} h_ref=${t.meta.hRef} joins=${t.sessions.size}`);
      }
    }
    store.pruneLog(t0 - cfg.ttlMs);
  }

  // Test hook: close a topic now.
  function closeNow(topic) {
    const t = topicRec(topic);
    if (!t || t.closed) return null;
    return append(topic, makeClose({ topic, lastSeq: t.msgs.length, boardPriv }));
  }

  const info = () => ({
    boardKey, network: cfg.network, tip: tipHeight, kMin: params.kMin, kMax: params.kMax, tiers: params.tiers,
    buckets: BUCKETS, closeDelaySecs: cfg.closeDelayMs / 1000,
  });

  return { boardKey, post, poll, topics, evidence, addLog, tick, closeNow, info, log: () => store.txLog.slice(), get tip() { return tipHeight; } };
}

const JOIN_FIELDS = ['t', 'topic', 'network', 'd', 'fr', 'hRef', 'txid', 'vout', 'value', 'spk', 'pub', 'session', 'sig'];
const MSG_FIELDS = ['t', 'topic', 'r', 'step', 'session', 'body', 'view', 'sig'];
const EVIDENCE_FIELDS = ['t', 'topic', 'txid', 'vout', 'kind', 'bundle', 'session', 'sig'];
function strip(msg, fields) {
  const o = {};
  for (const f of fields) if (msg[f] !== undefined) o[f] = msg[f];
  return o;
}

// In-process transport over a board core (tests, and local drivers).
export function memoryTransport(core) {
  const wrap = async (f) => { try { return await f(); } catch (e) { throw new Error(`board: ${e.status || ''} ${e.message}`); } };
  return {
    info: async () => core.info(),
    post: (topic, msg) => wrap(async () => core.post(topic, JSON.parse(JSON.stringify(msg)))),
    poll: async (topic, since, waitMs) => {
      const r = await core.poll(topic, since, Math.min(waitMs, 25_000));
      return JSON.parse(JSON.stringify(r));
    },
    topics: async () => ({ topics: core.topics() }),
    evidence: async () => ({ evidence: JSON.parse(JSON.stringify(core.evidence())) }),
    log: (topic, txid) => wrap(async () => core.addLog(topic, txid)),
  };
}

// ─────────────────────────────────────────────────────────────── HTTP

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

function rateLimiter(perMin, now = () => Date.now()) {
  const buckets = new Map();
  return (key) => {
    const t = now();
    let b = buckets.get(key);
    if (!b) { b = { tokens: perMin, at: t }; buckets.set(key, b); }
    b.tokens = Math.min(perMin, b.tokens + ((t - b.at) / 60_000) * perMin);
    b.at = t;
    if (buckets.size > 50_000) for (const [k, v] of buckets) if (t - v.at > 600_000) buckets.delete(k);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

export function createHandler({ core, cfg }) {
  const postOk = rateLimiter(cfg.ratePost), getOk = rateLimiter(cfg.rateGet);
  const pollsPerIp = new Map();
  return async (req, res) => {
    const origin = req.headers.origin;
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    if (origin && cfg.corsOrigins.includes(origin)) {
      Object.assign(headers, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' });
    }
    const send = (status, body) => { res.writeHead(status, headers); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    const url = new URL(req.url, 'http://board');
    const parts = url.pathname.split('/').filter(Boolean);
    const ip = clientIp(req);
    try {
      if (req.method === 'GET') {
        if (!getOk(ip)) return send(429, { error: 'rate limited' });
        if (url.pathname === '/health') return send(200, { ok: true, network: cfg.network, tip: core.tip });
        if (parts[0] !== 'join' || parts[1] !== 'v1') return send(404, { error: 'not found' });
        if (parts[2] === 'info') return send(200, core.info());
        if (parts[2] === 'topics') return send(200, { topics: core.topics() });
        if (parts[2] === 'evidence') return send(200, { evidence: core.evidence() });
        if (parts[2] === 'log') return send(200, { log: core.log() });
        if (parts.length === 3 && /^[0-9a-f]{64}$/.test(parts[2])) {
          const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
          const wait = Math.min(25, Math.max(0, Number(url.searchParams.get('wait')) || 0)) * 1000;
          const open = pollsPerIp.get(ip) || 0;
          if (open >= 64) return send(429, { error: 'too many open polls' });
          pollsPerIp.set(ip, open + 1);
          let aborted = false;
          req.on('close', () => { aborted = true; });
          try {
            const r = await core.poll(parts[2], since, wait);
            if (!aborted) send(200, r);
          } finally {
            const left = (pollsPerIp.get(ip) || 1) - 1;
            if (left > 0) pollsPerIp.set(ip, left); else pollsPerIp.delete(ip);
          }
          return;
        }
        return send(404, { error: 'not found' });
      }
      if (req.method === 'POST') {
        if (!postOk(ip)) return send(429, { error: 'rate limited' });
        if (parts[0] !== 'join' || parts[1] !== 'v1' || parts.length !== 3) return send(404, { error: 'not found' });
        const raw = await readBody(req, cfg.maxBody);
        let body;
        try { body = JSON.parse(raw); } catch { return send(400, { error: 'body is not JSON' }); }
        if (parts[2] === 'log') return send(200, core.addLog(String(body.topic), String(body.txid)));
        return send(200, core.post(parts[2], body));
      }
      return send(405, { error: 'method not allowed' });
    } catch (e) {
      return send(e.status || 500, { error: e.status ? e.message : 'internal error' });
    }
  };
}

// Reads at most `max` bytes; a larger body is drained and refused with 413 once it ends, so the client
// still receives the response.
function readBody(req, max) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) {
    req.resume();
    return Promise.reject(Object.assign(new Error('body too large'), { status: 413 }));
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on('end', () => (size > max ? reject(Object.assign(new Error('body too large'), { status: 413 })) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

export function esploraTip(bases) {
  return async () => {
    let lastErr;
    for (const b of bases) {
      try {
        const r = await fetch(`${b}/blocks/tip/height`, { signal: AbortSignal.timeout(10_000) });
        if (r.ok) return Number(await r.text());
        lastErr = new Error(`HTTP ${r.status}`);
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  };
}

export async function startBoard(cfg = configFromEnv()) {
  const store = await openStore(cfg.db);
  let keyHex = cfg.boardKeyHex || store.getMeta('boardKey');
  if (!keyHex) {
    keyHex = randomScalar().toString(16).padStart(64, '0');
    store.setMeta('boardKey', keyHex);
  }
  const boardPriv = BigInt('0x' + keyHex);
  const core = createBoard({ cfg, store, boardPriv, tip: esploraTip(cfg.esplora) });
  await core.tick();
  setInterval(() => { core.tick().catch((e) => log('tick:', e.message)); }, cfg.tickMs);
  const server = createServer(createHandler({ core, cfg }));
  server.keepAliveTimeout = 30_000;
  server.requestTimeout = 60_000;
  server.listen(cfg.port, () => log(`listening on ${cfg.port} network=${cfg.network} boardKey=${core.boardKey} tip=${core.tip} store=${cfg.db || 'memory'}`));
  return { core, server };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBoard().catch((e) => { console.error(e); process.exit(1); });
}

export { STEP };
