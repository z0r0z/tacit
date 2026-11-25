// The write path of the HTTPS window: the browser's way into the queue, the head's download and the upload in parts.
// A page served over HTTPS cannot call the coordinator's plain-HTTP address, so these routes pass the same requests through,
// streaming both ways, and tell the coordinator the caller's real address (it limits places, downloads and bans by address).
//
//   /api/c/join (POST)  /api/c/slot (GET)  /api/c/claim (POST)  /api/c/leave (DELETE)  /api/c/f/phase2-<n> (GET, ranges)
//   /api/c/upload-part (GET, PUT ?offset=)  /api/c/upload-finish (POST)  /api/c/upload-result (GET)  /api/c/whoami (GET)
//
// The coordinator must run with --client-ip-header X-Tacit-Client-IP --trusted-proxies <this service's outbound addresses>.
import { Readable } from 'node:stream';

const ROUTES = [
  ['POST', /^\/api\/c\/join$/, () => '/api/join'],
  ['GET', /^\/api\/c\/slot$/, () => '/api/slot'],
  ['POST', /^\/api\/c\/claim$/, () => '/api/claim'],
  ['DELETE', /^\/api\/c\/leave$/, () => '/api/leave'],
  ['GET', /^\/api\/c\/f\/(phase2-\d+)$/, (m) => `/f/${m[1]}`],
  ['GET', /^\/api\/c\/upload-part$/, () => '/api/upload-part'],
  ['PUT', /^\/api\/c\/upload-part$/, () => '/api/upload-part'],
  ['POST', /^\/api\/c\/upload-finish$/, () => '/api/upload-finish'],
  ['GET', /^\/api\/c\/upload-result$/, () => '/api/upload-result'],
];
const PASS_REQ = ['content-type', 'content-length', 'x-ceremony-token', 'range', 'if-range'];
const PASS_RES = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'retry-after', 'etag', 'last-modified'];
export const CLIENT_HEADER = 'X-Tacit-Client-IP';
const IP = /^[0-9a-fA-F:.]{2,45}$/;

// The caller's address as the platform's edge reports it (CLIENT_IP_HEADERS, first one present), else the socket's.
export function clientIP(req, headers = ['true-client-ip', 'cf-connecting-ip']) {
  for (const h of headers) {
    const v = String(req.headers[h] || '').split(',')[0].trim();
    if (IP.test(v)) return v;
  }
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

export function isWrite(path) { return path.startsWith('/api/c/'); }
export const WRITE_METHODS = 'GET, POST, PUT, DELETE';
export const WRITE_HEADERS = 'Content-Type, X-Ceremony-Token, Range';

let active = 0;
export async function handleWrite(req, res, { upstream, cors, maxActive = 200, ipHeaders }) {
  const u = new URL(req.url, 'http://x');
  const send = (code, body, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors, ...extra }); res.end(JSON.stringify(body)); };
  if (u.pathname === '/api/c/whoami' && req.method === 'GET') return send(200, { ip: clientIP(req, ipHeaders) });
  let target = null;
  for (const [m, re, to] of ROUTES) {
    const hit = u.pathname.match(re);
    if (hit && m === req.method) { target = to(hit); break; }
  }
  if (!target) return send(404, { error: 'not found' });
  if (active >= maxActive) return send(503, { error: 'busy; try again in a moment' }, { 'Retry-After': '5' });
  const headers = { [CLIENT_HEADER]: clientIP(req, ipHeaders) };
  for (const h of PASS_REQ) if (req.headers[h] !== undefined) headers[h] = req.headers[h];
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  active++;
  try {
    const hasBody = req.method === 'PUT' || req.method === 'POST';
    const r = await fetch(upstream + target + (u.search && target.startsWith('/api/upload-part') ? u.search : ''), {
      method: req.method, headers, signal: ac.signal,
      ...(hasBody && Number(req.headers['content-length'] || 0) > 0 ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
    });
    const out = { 'Cache-Control': 'no-store', ...cors };
    for (const h of PASS_RES) { const v = r.headers.get(h); if (v) out[h] = v; }
    res.writeHead(r.status, out);
    if (!r.body) return res.end();
    for await (const chunk of r.body) { if (!res.write(chunk)) await new Promise((ok) => res.once('drain', ok)); }
    res.end();
  } catch (e) {
    if (!res.headersSent) send(502, { error: 'the coordinator did not answer' });
    else res.destroy();
  } finally { active--; }
}
