// The Tacit Praxis ceremony's read-only HTTPS window onto the coordinator: GET /api/head and GET /api/transcript, cached a
// few seconds, so tacit.finance/praxis/ can show the chain live (an HTTPS page cannot read the plain-HTTP coordinator).
// Contributions go to the coordinator directly with the CLI; nothing is written through here. No dependencies.
//
//   COORDINATOR_URL=http://143.55.45.86:53874 PORT=10000 node ceremony-phase2/proxy/server.mjs
//
// With MIRROR_BUCKET (and MIRROR_ENDPOINT, MIRROR_KEY, MIRROR_SECRET) set, it also copies each accepted file and the
// transcript to that bucket (mirror.mjs); GET /api/mirror lists what is copied, with IPFS CIDs where the store gives them.
//
// GET /api/credits?day=<n> is the ceremony's points feed (credits.mjs): one credit per 0x address, from signed receipts only;
// CEREMONY_POINTS (100) points a credit, CEREMONY_EXCLUDE a comma-separated list of addresses never credited.
//
// GET /api/coordinator tells a prover-pool machine where to contribute: { open, coordinator, key, queue } (COORDINATOR_PUBLIC_URL,
// default COORDINATOR_URL). The machine pins the key and the tool's hashes itself; only the address comes from here, so the
// coordinator can move without a new release.
import { createServer } from 'node:http';
import { startMirror } from './mirror.mjs';
import { dayTally, DAY_MS } from './credits.mjs';

const UPSTREAM = String(process.env.COORDINATOR_URL || '').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 10000);
const ORIGINS = String(process.env.ALLOWED_ORIGINS || 'https://tacit.finance,https://tacit-ioq0.onrender.com').split(',').map((s) => s.trim());
const TTL_MS = Number(process.env.CACHE_MS || 10_000);
if (!/^https?:\/\//.test(UPSTREAM)) { console.error('COORDINATOR_URL is required'); process.exit(1); }

const mirror = process.env.MIRROR_BUCKET
  ? startMirror({ upstream: UPSTREAM, bucket: process.env.MIRROR_BUCKET, endpoint: process.env.MIRROR_ENDPOINT || 'https://s3.filebase.com',
      key: process.env.MIRROR_KEY, secret: process.env.MIRROR_SECRET })
  : null;

const PUBLIC_URL = String(process.env.COORDINATOR_PUBLIC_URL || UPSTREAM).replace(/\/$/, '');
const CREDIT_POINTS = Number(process.env.CEREMONY_POINTS || 100);
const EXCLUDE = String(process.env.CEREMONY_EXCLUDE || '').split(',').map((s) => s.trim()).filter(Boolean);

const cache = new Map();                      // path -> { at, status, body }
const inflight = new Map();                   // path -> the one fetch under way, shared by every request meanwhile
function upstream(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit);
  if (!inflight.has(path)) inflight.set(path, fetchUpstream(path, hit).finally(() => inflight.delete(path)));
  return inflight.get(path);
}
async function fetchUpstream(path, hit) {
  try {
    const r = await fetch(UPSTREAM + path, { signal: AbortSignal.timeout(8000) });
    const body = await r.text();
    JSON.parse(body);                          // only JSON is passed on
    const v = { at: Date.now(), status: r.status, body };
    cache.set(path, v);
    return v;
  } catch (e) {
    if (hit) return { ...hit, stale: true };   // the coordinator did not answer: the last answer, marked stale
    return { at: Date.now(), status: 502, body: JSON.stringify({ error: 'the coordinator did not answer' }) };
  }
}

createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = origin && ORIGINS.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' }); return res.end(); }
  const path = (req.url || '').split('?')[0];
  if (req.method === 'GET' && path === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  if (req.method === 'GET' && path === '/api/mirror') {
    res.writeHead(mirror ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30', ...cors });
    return res.end(JSON.stringify(mirror ? { bucket: process.env.MIRROR_BUCKET, files: mirror.status() } : { error: 'no mirror' }));
  }
  if (req.method === 'GET' && path === '/api/coordinator') {
    const v = await upstream('/api/head');
    let head = null;
    try { head = v.status === 200 && !v.stale ? JSON.parse(v.body) : null; } catch {}
    res.writeHead(head ? 200 : 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
    return res.end(JSON.stringify(head ? { open: head.closed === false, coordinator: PUBLIC_URL, key: process.env.COORDINATOR_KEY || null, queue: head.queue, index: head.index } : { error: 'the coordinator did not answer' }));
  }
  if (req.method === 'GET' && path === '/api/credits') {
    const day = Number(new URL(req.url, 'http://x').searchParams.get('day'));
    const today = Math.floor(Date.now() / DAY_MS);
    const send = (code, v) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors }); res.end(JSON.stringify(v)); };
    if (!Number.isSafeInteger(day) || day < 0 || day > today) return send(400, { error: 'day must be a UTC day number, today or before' });
    const v = await upstream('/api/transcript');
    if (v.status !== 200 || v.stale) return send(502, { error: 'the coordinator did not answer' });
    return send(200, await dayTally(JSON.parse(v.body), day, { points: CREDIT_POINTS, exclude: EXCLUDE }));
  }
  if (req.method !== 'GET' || !['/api/head', '/api/transcript'].includes(path)) { res.writeHead(404, { 'Content-Type': 'application/json', ...cors }); return res.end('{"error":"not found"}'); }
  const v = await upstream(path);
  res.writeHead(v.status, { 'Content-Type': 'application/json', 'Cache-Control': v.status === 200 ? 'public, max-age=10' : 'no-store', ...(v.stale ? { 'X-Stale': '1' } : {}), ...cors });
  res.end(v.body);
}).listen(PORT, () => console.log(`praxis ceremony proxy on ${PORT} -> ${UPSTREAM}`));
