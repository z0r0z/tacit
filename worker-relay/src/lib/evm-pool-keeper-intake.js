// Intake for the EVM pool box keeper: validates a submitted deposit intent + hint (re-derived through the gateway,
// so a hint that does not produce the intent's leaves and memo hashes is refused) or a wrap intent, and stores it.
// Request bodies are capped before parsing. Hints are never echoed back or logged.

import { getAddress, isAddress } from 'viem';
import { depositIntent } from '../../../dapp/evm-pool-gateway.js';
import { P_FR } from '../../../dapp/btc-pool-zk.js';
import { ETH } from './evm-pool-keeper-config.js';
import { safeErr } from './safe-err.js';

const VMAX = 1n << 120n;
const U256 = 1n << 256n;
const ZERO32 = '0x' + '0'.repeat(64);
const PREFIX = '/evm-pool/keeper';

export class IntakeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new IntakeError(400, m);

function uint(x, name, max = U256) {
  let v;
  if (typeof x === 'number' && Number.isSafeInteger(x)) v = BigInt(x);
  else if (typeof x === 'string' && /^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(x)) v = BigInt(x);
  else throw bad(`${name} must be an integer (decimal string or 0x hex)`);
  if (v < 0n || v >= max) throw bad(`${name} out of range`);
  return v;
}
function addr(x, name) {
  if (typeof x !== 'string' || !isAddress(x)) throw bad(`${name} must be an address`);
  if (x.toLowerCase() === ETH) throw bad(`${name} must not be the zero address`);
  return getAddress(x);
}
function b32(x, name) {
  if (typeof x !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(x)) throw bad(`${name} must be 32 bytes of hex`);
  return x.toLowerCase();
}
function memo(x, name, maxBytes) {
  if (x === undefined || x === null || x === '' || x === '0x') return '0x';
  if (typeof x !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(x)) throw bad(`${name} must be 0x hex`);
  if ((x.length - 2) / 2 > maxBytes) throw bad(`${name} is longer than ${maxBytes} bytes`);
  return x.toLowerCase();
}
function deadline(x, now, cfg) {
  const d = uint(x, 'deadline', 1n << 64n);
  if (d < BigInt(now + cfg.minDeadlineSecs)) throw bad(`deadline must be at least ${cfg.minDeadlineSecs}s away`);
  if (d > BigInt(now + cfg.maxDeadlineSecs)) throw bad(`deadline must be within ${cfg.maxDeadlineSecs}s`);
  return d;
}
const obj = (x, name) => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad(`${name} must be an object`);
  return x;
};
const hex = (b) => '0x' + Buffer.from(b).toString('hex');

// → { intent, hint, reward }. `asset` is the pool's asset field.
export function parseDepositSubmission(body, { zk, asset, now, cfg }) {
  const i = obj(obj(body, 'body').intent, 'intent');
  const h = obj(body.hint, 'hint');
  const amount = uint(i.amount, 'amount', VMAX);
  if (amount === 0n) throw bad('amount must be positive');
  if (!Array.isArray(h.outputs) || h.outputs.length > 2) throw bad('hint.outputs must be an array of at most two');
  const outputs = h.outputs.map((o, k) => {
    if (o === null) return null;
    obj(o, `hint.outputs[${k}]`);
    return { v: uint(o.v, `outputs[${k}].v`, VMAX), npk: uint(o.npk, `outputs[${k}].npk`, P_FR), rho: uint(o.rho, `outputs[${k}].rho`, P_FR) };
  });
  const m0 = memo(h.memo0, 'hint.memo0', cfg.maxMemoBytes);
  const m1 = memo(h.memo1, 'hint.memo1', cfg.maxMemoBytes);
  let derived;
  try {
    derived = depositIntent(zk, {
      asset, amount, outputs, memo0: m0, memo1: m1,
      refund: addr(i.refund, 'refund'), deadline: deadline(i.deadline, now, cfg), nonce: uint(i.nonce ?? '0', 'nonce'),
    });
  } catch (e) {
    if (e instanceof IntakeError) throw e;
    throw bad(String(e.message || e).replace(/^evm-pool-gateway: /, ''));
  }
  const d = derived.intent;
  if (uint(i.outLeaf0, 'outLeaf0') !== d.outLeaf0 || uint(i.outLeaf1, 'outLeaf1') !== d.outLeaf1) throw bad('the hint does not produce the intent\'s leaves');
  if (b32(i.memo0Hash, 'memo0Hash') !== d.memo0Hash || b32(i.memo1Hash, 'memo1Hash') !== d.memo1Hash) throw bad('the hint\'s memos do not match the intent\'s memo hashes');
  const hint = { outputs: derived.hint.outputs, fee: derived.hint.fee, memo0: hex(derived.hint.memo0), memo1: hex(derived.hint.memo1) };
  return { intent: d, hint, reward: hint.fee };
}

export function parseWrapSubmission(body, { now, cfg }) {
  const i = obj(obj(body, 'body').intent, 'intent');
  const intent = {
    assetId: b32(i.assetId, 'assetId'),
    amount: uint(i.amount, 'amount'),
    tip: uint(i.tip ?? '0', 'tip'),
    tipTo: i.tipTo === undefined || i.tipTo === null || String(i.tipTo).toLowerCase() === ETH ? getAddress(ETH) : addr(i.tipTo, 'tipTo'),
    commit: b32(i.commit, 'commit'),
    refund: addr(i.refund, 'refund'),
    deadline: deadline(i.deadline, now, cfg),
    nonce: uint(i.nonce ?? '0', 'nonce'),
  };
  if (intent.amount === 0n) throw bad('amount must be positive');
  if (intent.amount + intent.tip >= U256) throw bad('amount + tip overflows');
  if (intent.commit === ZERO32) throw bad('commit must be non-zero');
  const paysKeeper = intent.tipTo.toLowerCase() === ETH || intent.tipTo.toLowerCase() === String(cfg.keeperAddress || '').toLowerCase();
  return { intent, reward: paysKeeper ? intent.tip : 0n };
}

// Stored JSON (decimal strings) → contract arguments.
export function depositIntentArgs(j) {
  return {
    amount: BigInt(j.amount), outLeaf0: BigInt(j.outLeaf0), outLeaf1: BigInt(j.outLeaf1),
    memo0Hash: j.memo0Hash, memo1Hash: j.memo1Hash, refund: getAddress(j.refund), deadline: BigInt(j.deadline), nonce: BigInt(j.nonce),
  };
}
export function wrapIntentArgs(j) {
  return {
    assetId: j.assetId, amount: BigInt(j.amount), tip: BigInt(j.tip), tipTo: getAddress(j.tipTo ?? ETH), commit: j.commit,
    refund: getAddress(j.refund), deadline: BigInt(j.deadline), nonce: BigInt(j.nonce),
  };
}
export function hintArgs(j) {
  const unhex = (m) => Uint8Array.from(Buffer.from(String(m).replace(/^0x/, ''), 'hex'));
  return {
    outputs: j.outputs.map((o) => (o ? { v: BigInt(o.v), npk: BigInt(o.npk), rho: BigInt(o.rho) } : null)),
    fee: BigInt(j.fee), memo0: unhex(j.memo0), memo1: unhex(j.memo1),
  };
}

export function makeRateLimiter({ perMin = 20, burst = 10, maxClients = 10_000, now = () => Date.now() } = {}) {
  const buckets = new Map();
  const fill = (b, t) => { b.tokens = Math.min(burst, b.tokens + ((t - b.at) * perMin) / 60_000); b.at = t; };
  return (key) => {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxClients) for (const [k, v] of buckets) { fill(v, t); if (v.tokens >= burst) buckets.delete(k); }
      if (buckets.size >= maxClients) return false;
      b = { tokens: burst, at: t };
      buckets.set(key, b);
    }
    fill(b, t);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

function clientKey(req) {
  const f = req.headers?.['x-forwarded-for'];
  // The right-most hop is the one the fronting proxy appended; earlier hops are client-supplied.
  if (f) { const k = String(f).split(',').pop().trim(); if (k) return k; }
  return req.socket?.remoteAddress || 'unknown';
}

function readJson(req, max) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) {
    req.resume();
    return Promise.reject(new IntakeError(413, 'body too large'));
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on('end', () => {
      if (size > max) return reject(new IntakeError(413, 'body too large'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('body is not JSON')); }
    });
    req.on('error', reject);
  });
}

// chain: { address, chainId, pool, router, asset, v1, depositBoxOf(intent), wrapBoxOf(intent), wrapToken(assetId) }
export function createIntakeHandler({ store, chain, zk, assetField, cfg, now = () => Math.floor(Date.now() / 1000), log = () => {}, isReady = () => true }) {
  const limited = makeRateLimiter({ perMin: cfg.ratePerMin, burst: Math.max(1, Math.min(10, cfg.ratePerMin)) });
  const view = (r) => ({ box: r.box, kind: r.kind, status: r.status, reward: r.reward, ...(r.tx_hash ? { txHash: r.tx_hash } : {}) });

  async function accept(kind, body) {
    if (store.pendingCount() >= cfg.maxPending) throw new IntakeError(503, 'the keeper is at capacity; try again later');
    const t = now();
    let parsed, box, token;
    if (kind === 'deposit') {
      parsed = parseDepositSubmission(body, { zk, asset: assetField, now: t, cfg });
      box = await chain.depositBoxOf(parsed.intent);
      token = chain.asset;
    } else {
      if (!chain.v1 || chain.v1.toLowerCase() === ETH) throw bad('this router has no wrap target');
      parsed = parseWrapSubmission(body, { now: t, cfg });
      const w = await chain.wrapToken(parsed.intent.assetId);
      if (!w.registered) throw bad('assetId is not registered on the wrap target');
      box = await chain.wrapBoxOf(parsed.intent);
      token = w.token;
    }
    const fresh = store.addIntent({ box, kind, intent: parsed.intent, hint: parsed.hint ?? null, reward: parsed.reward, token, deadline: parsed.intent.deadline, now: t });
    const r = store.get(box);
    if (r.kind !== kind) throw bad('box already registered under another kind');
    if (fresh) log(`accepted ${kind} box ${box} reward ${parsed.reward}`);
    return view(r);
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/$/, '');
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ...(code === 429 ? { 'Retry-After': '10' } : {}) });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }
    try {
      let m;
      if (p === '/health' && req.method === 'GET') return send(isReady() ? 200 : 503, { ok: isReady() });
      if (p === `${PREFIX}/info` && req.method === 'GET') {
        return send(200, { chainId: chain.chainId, pool: chain.pool, router: chain.router, asset: chain.asset, keeper: chain.address, wraps: !!chain.v1 && chain.v1.toLowerCase() !== ETH });
      }
      if ((p === `${PREFIX}/deposit` || p === `${PREFIX}/wrap`) && req.method === 'POST') {
        if (!limited(clientKey(req))) throw new IntakeError(429, 'rate limited');
        const body = await readJson(req, cfg.maxBody);
        return send(200, await accept(p.endsWith('/deposit') ? 'deposit' : 'wrap', body));
      }
      if ((m = p.match(/^\/evm-pool\/keeper\/status\/(0x[0-9a-fA-F]{40})$/)) && req.method === 'GET') {
        const r = store.get(m[1]);
        return r ? send(200, view(r)) : send(404, { error: 'unknown box' });
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      if (e instanceof IntakeError) return send(e.status, { error: e.message });
      log(`intake error: ${safeErr(e)}`);
      return send(500, { error: 'internal error' });
    }
  };
}
