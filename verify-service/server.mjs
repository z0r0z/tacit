import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as snarkjs from 'snarkjs';

const PORT = parseInt(process.env.PORT || '8080', 10);
const AUTH_TOKEN = process.env.VERIFY_SERVICE_TOKEN || '';
// 500 MB default ceiling — comfortable headroom over pot18 (288 MB), the
// largest blob the service handles today. Operator can tighten via env if
// a smaller circuit's ptau is the only thing in use.
const MAX_BYTES = parseInt(process.env.MAX_BYTES || String(500 * 1024 * 1024), 10);
// Default 3 min per gateway. pot18 is 288 MB and the slowest public
// gateway (ipfs.io) typically completes the full download in 5–15 s
// once it gets going, but cold-cache misses can add a minute or two of
// indirect lookup.
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || '180000', 10);

const GATEWAYS = (process.env.IPFS_GATEWAYS || 'https://content.wrappr.wtf/ipfs/,https://ipfs.io/ipfs/,https://w3s.link/ipfs/,https://dweb.link/ipfs/')
  .split(',').map(s => s.trim()).filter(Boolean);

const CID_RE = /^[A-Za-z0-9]{46,80}$/;

// Single-flight gate. snarkjs verify holds the full r1cs + ptau + zkey in
// memory; running two in parallel doubles peak RSS and is a quick way to
// OOM a small VM. Queue everything serially — verify is rare (one per
// contribute) and fast enough (5-60s) that latency from queueing is fine.
let _inflight = Promise.resolve();
function serial(fn) {
  const next = _inflight.catch(() => null).then(fn);
  _inflight = next.catch(() => null);
  return next;
}

async function fetchToFile(cid, dest) {
  if (!CID_RE.test(cid)) throw new Error(`bad cid: ${cid}`);
  const errs = [];
  for (const gw of GATEWAYS) {
    const url = gw + cid;
    const t0 = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) {
        errs.push(`${gw}: HTTP ${r.status}`);
        console.log(`[fetch] ${gw} cid=${cid.slice(0,12)}… HTTP ${r.status} (${Date.now()-t0}ms)`);
        continue;
      }
      const len = Number(r.headers.get('content-length') || '0');
      if (len > MAX_BYTES) {
        errs.push(`${gw}: content-length ${len} > MAX_BYTES ${MAX_BYTES}`);
        console.log(`[fetch] ${gw} cid=${cid.slice(0,12)}… content-length ${len} too big`);
        continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length === 0) {
        errs.push(`${gw}: empty body`);
        console.log(`[fetch] ${gw} cid=${cid.slice(0,12)}… empty body`);
        continue;
      }
      if (buf.length > MAX_BYTES) {
        errs.push(`${gw}: body ${buf.length} > MAX_BYTES ${MAX_BYTES}`);
        console.log(`[fetch] ${gw} cid=${cid.slice(0,12)}… body too big`);
        continue;
      }
      fs.writeFileSync(dest, buf);
      console.log(`[fetch] ${gw} cid=${cid.slice(0,12)}… OK ${buf.length}B (${Date.now()-t0}ms)`);
      return { gw, bytes: buf.length };
    } catch (e) {
      errs.push(`${gw}: ${(e && e.message) || e}`);
      console.log(`[fetch] ${gw} cid=${cid.slice(0,12)}… throw: ${(e && e.message) || e}`);
    }
  }
  throw new Error(`all gateways failed for ${cid}: ${errs.join(' | ')}`);
}

async function runVerify({ r1cs_cid, ptau_cid, new_cid }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tacit-verify-'));
  const r1csPath = path.join(tmp, 'circuit.r1cs');
  const ptauPath = path.join(tmp, 'pot.ptau');
  const zkeyPath = path.join(tmp, 'head.zkey');
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
  const startMs = Date.now();
  try {
    await Promise.all([
      fetchToFile(r1cs_cid, r1csPath),
      fetchToFile(ptau_cid, ptauPath),
      fetchToFile(new_cid,  zkeyPath),
    ]);
    // snarkjs's CLI logger interface — just need an .info/.warn/.error
    // sink so its progress messages don't blow up. Capture .error so the
    // response can surface a useful failure reason instead of just false.
    const captured = [];
    const logger = {
      info:  () => {},
      warn:  (m) => captured.push(`WARN: ${m}`),
      error: (m) => captured.push(`ERROR: ${m}`),
      debug: () => {},
    };
    const ok = await snarkjs.zKey.verifyFromR1cs(r1csPath, ptauPath, zkeyPath, logger);
    const ms = Date.now() - startMs;
    if (ok) return { ok: true, ms };
    return { ok: false, error: captured.find(s => s.startsWith('ERROR')) || 'verify returned false', ms };
  } finally {
    cleanup();
  }
}

function send(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'POST' || req.url !== '/verify') {
    return send(res, 404, { ok: false, error: 'not found' });
  }
  // Constant-time-ish token check so brute force from the open internet
  // doesn't yield timing oracles. Both strings get compared via timingSafeEqual.
  if (AUTH_TOKEN) {
    const hdr = String(req.headers.authorization || '');
    const supplied = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
    const a = Buffer.from(supplied.padEnd(AUTH_TOKEN.length, '\0'));
    const b = Buffer.from(AUTH_TOKEN);
    let okAuth = a.length === b.length && supplied.length === AUTH_TOKEN.length;
    try { if (okAuth) okAuth = crypto.timingSafeEqual(a, b); } catch { okAuth = false; }
    if (!okAuth) return send(res, 401, { ok: false, error: 'unauthorized' });
  }
  let body;
  try {
    const chunks = [];
    let len = 0;
    for await (const c of req) {
      chunks.push(c);
      len += c.length;
      if (len > 4096) return send(res, 413, { ok: false, error: 'request body too large' });
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return send(res, 400, { ok: false, error: 'expected JSON body' });
  }
  const { r1cs_cid, ptau_cid, new_cid } = body || {};
  if (!CID_RE.test(String(r1cs_cid || '')) || !CID_RE.test(String(ptau_cid || '')) || !CID_RE.test(String(new_cid || ''))) {
    return send(res, 400, { ok: false, error: 'r1cs_cid, ptau_cid, new_cid all required and must be CID-shaped' });
  }
  try {
    const result = await serial(() => runVerify({ r1cs_cid, ptau_cid, new_cid }));
    return send(res, 200, result);
  } catch (e) {
    return send(res, 502, { ok: false, error: (e && e.message) || String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`tacit-verify-service listening on :${PORT} (gateways=${GATEWAYS.length}, auth=${AUTH_TOKEN ? 'enabled' : 'disabled'})`);
});
