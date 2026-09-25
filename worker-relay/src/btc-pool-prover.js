// tacit-btc-pool-prover: Groth16 proving for T_BTC_SPEND (DESIGN-btc-shielded-pool.md §4) on behalf of
// wallets that cannot run SP1 themselves, such as the browser dapp.
//
//   POST /btc-pool/prove   body: the btc-pool-prove stdin witness
//                          {"body","root","inputs":[{"cx","cy","value","blinding","spend_key","nk_pub","nk_note",
//                            "leaf_index","path":[32],"sig"}],"outputs":[{"value","blinding"}]}
//                          200 {"proof","public_values","vkey"}
//   GET  /health
//
// What the prover learns. The witness carries every opening of the spend (input and output amounts and
// blindings), the spent leaves and their nk_note, and one BIP-340 signature per input. It never carries
// sk_spend (§4 "What a prover learns", G8): the signatures cover the whole body, so the prover cannot
// redirect the spend, and nk_note alone does not link the owner's other notes. It does see the amounts and
// which leaves are spent, so the wallet uses this service only when the user chooses to. Witnesses are
// never logged or stored.
//
// Each request runs the btc-pool-prove binary twice: PROVE_MODE=execute first, locally and without the
// network key, so a bad witness is rejected before any proving spend; then PROVE_MODE=network for the
// Groth16 proof. The result is returned only after its vkey matches the pinned btc_pool_vkey, its public
// values equal abi.encode(uint16 1, root, keccak(body)) of the request, and btc-pool-verify accepts it.
//
// NETWORK_PRIVATE_KEY is read once at startup, removed from process.env, and handed only to the network
// child through an explicit environment. It is never placed in argv and is redacted from anything logged
// or returned.
//
// Env: BTC_POOL_PROVE_BIN, BTC_POOL_VERIFY_BIN, NETWORK_PRIVATE_KEY, NETWORK_RPC_URL, BTC_POOL_NETWORK
// (signet; mainnet needs PROVER_ENABLE_MAINNET=1), PROVER_CONCURRENCY (2), PROVER_QUEUE_MAX (8),
// PROVER_RATE_MAX (4) per PROVER_RATE_WINDOW_SECS (3600), PROVER_DAILY_BUDGET (50 network proofs per UTC
// day, in memory), PROVER_EXECUTE_TIMEOUT_SECS (300), PROVER_TIMEOUT_SECS (900), PROVER_BODY_MAX (65536),
// PROVER_CORS_ORIGINS (extra comma-separated origins), PROVER_ROOTS_URL (optional btc-pool indexer base:
// the witness root must be one of its retained roots), PORT.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { keccak256 } from 'viem';
import { makeBtcPoolVerifier, loadBtcPoolVkey } from './lib/btc-pool-verify.js';

const TREE_DEPTH = 32;
const MAX_IN = 2;
const MAX_OPEN = 4; // n_out ≤ 3 plus the exit
const MAX_BODY_BYTES = 1024; // a canonical T_BTC_SPEND body is under 1 KB
const U64_MAX = (1n << 64n) - 1n;
const DEFAULT_RPC = 'https://rpc.mainnet.succinct.xyz';
export const DEFAULT_ORIGINS = ['https://tacit.finance', 'https://www.tacit.finance'];
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

// ── witness validation ──
class BadRequest extends Error {}
const bad = (m) => { throw new BadRequest(m); };

function hexField(v, name, len) {
  if (typeof v !== 'string') bad(`${name} must be a hex string`);
  const h = v.startsWith('0x') || v.startsWith('0X') ? v.slice(2) : v;
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2) bad(`${name} is not hex`);
  if (len != null && h.length !== len * 2) bad(`${name} must be ${len} bytes`);
  return '0x' + h.toLowerCase();
}

function u64Field(v, name, max = U64_MAX) {
  let n;
  if (typeof v === 'string' && /^\d{1,20}$/.test(v)) n = BigInt(v);
  else if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) n = BigInt(v);
  else bad(`${name} must be a non-negative integer or decimal string`);
  if (n > max) bad(`${name} out of range`);
  return n.toString(10);
}

function exactKeys(o, keys, name) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) bad(`${name} must be an object`);
  const got = Object.keys(o);
  for (const k of got) if (!keys.includes(k)) bad(`${name} has unexpected field ${k}`);
  for (const k of keys) if (!(k in o)) bad(`${name} is missing ${k}`);
}

// Returns a canonical copy (0x-lowercase hex, decimal-string integers) holding only the known fields, so
// the child only ever sees bytes this function produced.
export function validateWitness(w) {
  exactKeys(w, ['body', 'root', 'inputs', 'outputs'], 'witness');
  const body = hexField(w.body, 'body');
  const bodyLen = (body.length - 2) / 2;
  if (bodyLen < 1 || bodyLen > MAX_BODY_BYTES) bad('body length out of range');
  if (body.slice(2, 4) !== '6d') bad('body must start with the T_BTC_SPEND opcode 0x6d');
  const root = hexField(w.root, 'root', 32);
  if (!Array.isArray(w.inputs) || w.inputs.length < 1 || w.inputs.length > MAX_IN) bad(`inputs must hold 1..${MAX_IN} entries`);
  if (!Array.isArray(w.outputs) || w.outputs.length < 1 || w.outputs.length > MAX_OPEN) bad(`outputs must hold 1..${MAX_OPEN} entries`);
  const inputs = w.inputs.map((i, k) => {
    const n = `inputs[${k}]`;
    exactKeys(i, ['cx', 'cy', 'value', 'blinding', 'spend_key', 'nk_pub', 'nk_note', 'leaf_index', 'path', 'sig'], n);
    if (!Array.isArray(i.path) || i.path.length !== TREE_DEPTH) bad(`${n}.path must hold ${TREE_DEPTH} entries`);
    const nkPub = hexField(i.nk_pub, `${n}.nk_pub`, 33);
    if (nkPub.slice(2, 4) !== '02' && nkPub.slice(2, 4) !== '03') bad(`${n}.nk_pub must be a compressed point`);
    const nkNote = hexField(i.nk_note, `${n}.nk_note`, 32);
    if (/^0x0+$/.test(nkNote)) bad(`${n}.nk_note must be non-zero`);
    return {
      cx: hexField(i.cx, `${n}.cx`, 32),
      cy: hexField(i.cy, `${n}.cy`, 32),
      value: u64Field(i.value, `${n}.value`),
      blinding: hexField(i.blinding, `${n}.blinding`, 32),
      spend_key: hexField(i.spend_key, `${n}.spend_key`, 32),
      nk_pub: nkPub,
      nk_note: nkNote,
      leaf_index: u64Field(i.leaf_index, `${n}.leaf_index`, (1n << BigInt(TREE_DEPTH)) - 1n),
      path: i.path.map((p, j) => hexField(p, `${n}.path[${j}]`, 32)),
      sig: hexField(i.sig, `${n}.sig`, 64),
    };
  });
  const outputs = w.outputs.map((o, k) => {
    exactKeys(o, ['value', 'blinding'], `outputs[${k}]`);
    return { value: u64Field(o.value, `outputs[${k}].value`), blinding: hexField(o.blinding, `outputs[${k}].blinding`, 32) };
  });
  return { body, root, inputs, outputs };
}

// abi.encode(uint16 1, bytes32 root, bytes32 keccak(body)): what the guest commits for this witness.
export function expectedPublicValues(w) {
  return '0x' + '00'.repeat(31) + '01' + w.root.slice(2) + keccak256(w.body).slice(2);
}

// ── client identity, rate limit, budget ──
// Right-most X-Forwarded-For entry: the hop the fronting proxy appended, the only one a client cannot set.
export function clientKey(req) {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff.join(',') : xff;
  if (raw) {
    const hops = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}

export function makeRateLimiter({ max, windowMs, now = Date.now, maxKeys = 50000 }) {
  const hits = new Map();
  const prune = (t) => { for (const [k, a] of hits) { const f = a.filter((x) => t - x < windowMs); if (f.length) hits.set(k, f); else hits.delete(k); } };
  return {
    // null when allowed (and recorded), else seconds until the oldest hit leaves the window.
    take(key) {
      const t = now();
      if (hits.size >= maxKeys) prune(t);
      if (hits.size >= maxKeys) return Math.ceil(windowMs / 1000);
      const a = (hits.get(key) || []).filter((x) => t - x < windowMs);
      if (a.length >= max) { hits.set(key, a); return Math.max(1, Math.ceil((a[0] + windowMs - t) / 1000)); }
      a.push(t);
      hits.set(key, a);
      return null;
    },
    size: () => hits.size,
  };
}

export function makeBudget({ limit, now = Date.now }) {
  let day = null, used = 0;
  const roll = () => { const d = new Date(now()).toISOString().slice(0, 10); if (d !== day) { day = d; used = 0; } };
  return {
    remaining() { roll(); return Math.max(0, limit - used); },
    take() { roll(); if (used >= limit) return false; used++; return true; },
    snapshot() { roll(); return { day, used, limit }; },
    secondsToReset() { const t = now(); return Math.max(1, Math.ceil((86400000 - (t % 86400000)) / 1000)); },
  };
}

// ── child process ──
export function makeRedactor(secrets) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= 8)
    .flatMap((s) => [s, s.replace(/^0x/i, '')]).filter((s) => s.length >= 8);
  return (text) => { let t = String(text ?? ''); for (const s of list) t = t.split(s).join('[redacted]'); return t; };
}

class ProveError extends Error {
  constructor(message, { rejected = false, code = null } = {}) { super(message); this.rejected = rejected; this.code = code; }
}

function runProve(bin, witness, env, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env });
    let out = '', err = '', done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(v); } };
    const onAbort = () => { child.kill('SIGKILL'); finish(reject, new ProveError('client went away')); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(reject, new ProveError(`${env.PROVE_MODE} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c) => { if (out.length < 1 << 20) out += c; });
    child.stderr.on('data', (c) => { if (err.length < 1 << 16) err += c; });
    child.on('error', (e) => finish(reject, new ProveError(`spawn failed: ${e.message}`)));
    child.on('close', (code, sig) => {
      if (code !== 0) {
        const line = err.split('\n').map((l) => l.trim()).filter(Boolean).reverse().find((l) => l.startsWith('btc-pool-prove:')) || err.trim().split('\n').pop() || '';
        // Exit 2 is the binary's own refusal: bad witness JSON or a guest rejection.
        return finish(reject, new ProveError(line.replace(/^btc-pool-prove:\s*/, '').slice(0, 300) || `exited ${code ?? sig}`, { rejected: code === 2, code: code ?? sig }));
      }
      const last = out.trim().split('\n').pop();
      try { finish(resolve, JSON.parse(last)); } catch { finish(reject, new ProveError('prover printed non-JSON')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(witness));
  });
}

// ── service ──
export function createProver({
  proveBin, verifier, vkey, network = 'signet', networkPrivateKey, networkRpcUrl = DEFAULT_RPC,
  concurrency = 2, queueMax = 8, rateMax = 4, rateWindowMs = 3600000, dailyBudget = 50,
  executeTimeoutMs = 300000, proveTimeoutMs = 900000, bodyMax = 65536,
  origins = DEFAULT_ORIGINS, rootsUrl = null, fetchImpl = globalThis.fetch,
  baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
  log = console.log, now = Date.now,
}) {
  if (!proveBin) throw new Error('btc-pool-prove binary is not configured');
  if (!verifier?.enabled || typeof verifier.verify !== 'function') throw new Error(`btc-pool-verify unavailable: ${verifier?.reason || 'no verifier'}`);
  if (!/^0x[0-9a-f]{64}$/.test(vkey || '')) throw new Error('pinned btc_pool_vkey missing');
  if (!networkPrivateKey) throw new Error('NETWORK_PRIVATE_KEY is not set');

  const redact = makeRedactor([networkPrivateKey]);
  const say = (...a) => log(...a.map((x) => redact(typeof x === 'string' ? x : JSON.stringify(x))));
  const limiter = makeRateLimiter({ max: rateMax, windowMs: rateWindowMs, now });
  const budget = makeBudget({ limit: dailyBudget, now });
  const inFlight = new Set(); // client keys with a queued or running request
  const queue = [];
  let running = 0, seq = 0;
  const stats = { proved: 0, rejected: 0, failed: 0 };

  const acquire = (signal) => new Promise((resolve, reject) => {
    if (running < concurrency) { running++; return resolve(); }
    const entry = { resolve, reject };
    const onAbort = () => { const i = queue.indexOf(entry); if (i >= 0) queue.splice(i, 1); reject(new ProveError('client went away')); };
    entry.resolve = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
    queue.push(entry);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const release = () => { const next = queue.shift(); if (next) next.resolve(); else running--; };

  let rootsCache = { at: 0, roots: null };
  async function rootKnown(root) {
    if (!rootsUrl) return true;
    if (!rootsCache.roots || now() - rootsCache.at > 30000) {
      const r = await fetchImpl(`${rootsUrl.replace(/\/$/, '')}/btc-pool/roots`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`roots ${r.status}`);
      const j = await r.json();
      rootsCache = { at: now(), roots: new Set((j.roots || []).map((x) => String(x.root).toLowerCase())) };
    }
    return rootsCache.roots.has(root);
  }

  const childEnv = (mode) => mode === 'network'
    ? { ...baseEnv, PROVE_MODE: 'network', NETWORK_PRIVATE_KEY: networkPrivateKey, NETWORK_RPC_URL: networkRpcUrl }
    : { ...baseEnv, PROVE_MODE: 'execute' };

  async function prove(w, id, signal) {
    const pv = expectedPublicValues(w);
    const ex = await runProve(proveBin, w, childEnv('execute'), { timeoutMs: executeTimeoutMs, signal });
    if (String(ex.public_values).toLowerCase() !== pv) throw new ProveError('execute committed unexpected public values');
    if (!budget.take()) throw Object.assign(new ProveError('daily proof budget exhausted'), { budget: true });
    say(`#${id} witness executes (${ex.cycles} cycles); proving on the network`);
    // The witness already executed, so any failure from here on is the service's, never a rejection.
    const res = await runProve(proveBin, w, childEnv('network'), { timeoutMs: proveTimeoutMs, signal })
      .catch((e) => { e.rejected = false; throw e; });
    const proof = typeof res.proof === 'string' && /^0x[0-9a-fA-F]+$/.test(res.proof) ? res.proof.toLowerCase() : null;
    if (!proof || proof.length > 2 + 2 * 512) throw new ProveError('prover returned a malformed proof');
    if (String(res.vkey).toLowerCase() !== vkey) throw new ProveError(`prover vkey ${res.vkey} is not the pinned btc_pool_vkey`);
    if (String(res.public_values).toLowerCase() !== pv) throw new ProveError('proof public values do not match the witness');
    if ((await verifier.verify({ proof, publicValues: pv })) !== true) throw new ProveError('proof failed local verification');
    return { proof, public_values: pv, vkey };
  }

  const allowedOrigin = (o) => !!o && (origins.includes(o) || LOCAL_ORIGIN.test(o));

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const len = Number(req.headers['content-length']);
      if (Number.isFinite(len) && len > bodyMax) return reject(Object.assign(new Error('body too large'), { status: 413 }));
      const chunks = []; let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > bodyMax) { req.removeAllListeners('data'); req.resume(); return reject(Object.assign(new Error('body too large'), { status: 413 })); }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const status = () => ({
    service: 'btc-pool-prover', network, vkey, running, queued: queue.length, concurrency, queueMax,
    budget: budget.snapshot(), stats: { ...stats },
  });

  const handler = async (req, res) => {
    const origin = req.headers.origin;
    const cors = allowedOrigin(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
    const send = (code, body, extra = {}) => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors, ...extra });
      res.end(JSON.stringify(body));
    };
    const p = new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    if (p === '/health' && req.method === 'GET') return send(200, status());
    if (p !== '/btc-pool/prove') return send(404, { error: 'not found' });
    if (req.method !== 'POST') return send(405, { error: 'POST only' }, { Allow: 'POST, OPTIONS' });
    if (origin && !allowedOrigin(origin)) return send(403, { error: 'origin not allowed' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(415, { error: 'content-type must be application/json' });

    let w;
    try {
      const raw = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return send(400, { error: 'body is not JSON' }); }
      w = validateWitness(parsed);
    } catch (e) {
      if (e instanceof BadRequest) return send(400, { error: e.message });
      return send(e.status || 400, { error: e.status === 413 ? `body exceeds ${bodyMax} bytes` : 'bad request' }, e.status === 413 ? { Connection: 'close' } : {});
    }

    // Cached, so it runs before the synchronous admission checks below and nothing awaits between them.
    try {
      if (!(await rootKnown(w.root))) return send(422, { error: 'root is not a known pool root' });
    } catch (e) {
      say(`roots lookup failed: ${e.message}`);
      return send(503, { error: 'pool roots unavailable' }, { 'Retry-After': '30' });
    }

    const key = clientKey(req);
    if (inFlight.has(key)) return send(429, { error: 'a proof for this client is already in progress' }, { 'Retry-After': '30' });
    if (budget.remaining() <= 0) return send(503, { error: 'daily proof budget exhausted' }, { 'Retry-After': String(budget.secondsToReset()) });
    if (running >= concurrency && queue.length >= queueMax) return send(503, { error: 'prover busy' }, { 'Retry-After': '60' });
    const wait = limiter.take(key);
    if (wait != null) return send(429, { error: 'rate limited' }, { 'Retry-After': String(wait) });

    const id = ++seq;
    const ac = new AbortController();
    const onClose = () => { if (!res.writableEnded) ac.abort(); };
    res.on('close', onClose);
    inFlight.add(key);
    let slot = false;
    try {
      await acquire(ac.signal);
      slot = true;
      const t0 = now();
      const out = await prove(w, id, ac.signal);
      stats.proved++;
      say(`#${id} proved in ${Math.round((now() - t0) / 1000)}s`);
      return send(200, out);
    } catch (e) {
      if (e.budget) return send(503, { error: 'daily proof budget exhausted' }, { 'Retry-After': String(budget.secondsToReset()) });
      if (e.rejected) { stats.rejected++; say(`#${id} witness rejected`); return send(422, { error: 'witness rejected', reason: redact(e.message) }); }
      if (e.message === 'client went away') { say(`#${id} client went away`); return; }
      stats.failed++;
      say(`!!! #${id} proving failed: ${e.message}`);
      return send(502, { error: 'proving failed' });
    } finally {
      if (slot) release();
      inFlight.delete(key);
      res.off('close', onClose);
    }
  };

  return { handler, status, stats };
}

// ── main ──
async function main() {
  const env = process.env;
  const network = env.BTC_POOL_NETWORK || 'signet';
  if (network !== 'signet' && network !== 'mainnet') throw new Error('BTC_POOL_NETWORK must be signet or mainnet');
  if (network === 'mainnet' && env.PROVER_ENABLE_MAINNET !== '1') throw new Error('mainnet proving is disabled; set PROVER_ENABLE_MAINNET=1');
  const networkPrivateKey = env.NETWORK_PRIVATE_KEY;
  delete env.NETWORK_PRIVATE_KEY; // nothing else this process spawns inherits it
  const proveBin = env.BTC_POOL_PROVE_BIN || '/app/prover/bin/btc-pool-prove';
  accessSync(proveBin, constants.X_OK);
  const log = (...a) => console.log(`[btc-pool-prover ${network} ${new Date().toISOString()}]`, ...a);
  const verifier = makeBtcPoolVerifier({ log: (...a) => console.error(...a) });
  const num = (k, d) => { const v = Number(env[k] ?? d); if (!Number.isFinite(v) || v < 0) throw new Error(`${k} must be a non-negative number`); return v; };
  const origins = [...DEFAULT_ORIGINS, ...String(env.PROVER_CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)];
  const prover = createProver({
    proveBin, verifier, vkey: loadBtcPoolVkey(), network, networkPrivateKey,
    networkRpcUrl: env.NETWORK_RPC_URL || DEFAULT_RPC,
    concurrency: Math.max(1, num('PROVER_CONCURRENCY', 2)), queueMax: num('PROVER_QUEUE_MAX', 8),
    rateMax: num('PROVER_RATE_MAX', 4), rateWindowMs: num('PROVER_RATE_WINDOW_SECS', 3600) * 1000,
    dailyBudget: num('PROVER_DAILY_BUDGET', 50),
    executeTimeoutMs: num('PROVER_EXECUTE_TIMEOUT_SECS', 300) * 1000, proveTimeoutMs: num('PROVER_TIMEOUT_SECS', 900) * 1000,
    bodyMax: num('PROVER_BODY_MAX', 65536), origins, rootsUrl: env.PROVER_ROOTS_URL || null, log,
  });
  if (!env.PROVER_ROOTS_URL) log('PROVER_ROOTS_URL unset: witness roots are not checked against the indexer');
  const server = createServer(prover.handler);
  server.requestTimeout = 0; // a proof can take many minutes; the per-proof timeouts bound it
  server.headersTimeout = 30000;
  server.listen(Number(env.PORT || 10000), () => log(`listening on ${env.PORT || 10000}; vkey ${prover.status().vkey}`));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(String(e?.message || e)); process.exit(1); });
}
