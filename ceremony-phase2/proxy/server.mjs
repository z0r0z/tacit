// The Tacit Praxis ceremony's read-only HTTPS window onto the coordinator: GET /api/head and GET /api/transcript, cached a
// few seconds, so tacit.finance/praxis/ can show the chain live (an HTTPS page cannot read the plain-HTTP coordinator).
// Contributions go to the coordinator directly with the CLI; nothing is written through here. No dependencies.
//
//   COORDINATOR_URL=http://143.55.45.86:53874 PORT=10000 node ceremony-phase2/proxy/server.mjs
import { createServer } from 'node:http';

const UPSTREAM = String(process.env.COORDINATOR_URL || '').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 10000);
const ORIGINS = String(process.env.ALLOWED_ORIGINS || 'https://tacit.finance,https://tacit-ioq0.onrender.com').split(',').map((s) => s.trim());
const TTL_MS = Number(process.env.CACHE_MS || 10_000);
if (!/^https?:\/\//.test(UPSTREAM)) { console.error('COORDINATOR_URL is required'); process.exit(1); }

const cache = new Map();                       // path -> { at, status, body }
async function upstream(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
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
  if (req.method !== 'GET' || !['/api/head', '/api/transcript'].includes(path)) { res.writeHead(404, { 'Content-Type': 'application/json', ...cors }); return res.end('{"error":"not found"}'); }
  const v = await upstream(path);
  res.writeHead(v.status, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10', ...(v.stale ? { 'X-Stale': '1' } : {}), ...cors });
  res.end(v.body);
}).listen(PORT, () => console.log(`praxis ceremony proxy on ${PORT} -> ${UPSTREAM}`));
