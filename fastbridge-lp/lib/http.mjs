// The HTTP face of the service: JSON in and out, a size limit on bodies, CORS for the pages named in `origins`, and a
// token bucket per client address (offers are dearer to check than anything else here, so they have a smaller one).

import { createServer } from 'node:http';

// The request body as text, or null once it passes `max` (the rest is read and dropped, so the answer can be sent).
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, over = false;
    req.on('data', (c) => { if (over) return; size += c.length; if (size > max) { over = true; chunks.length = 0; resolve(null); } else chunks.push(c); });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

// An address as a number and its width (32 or 128 bits), or null for anything that is not one. An IPv4-mapped IPv6 address is its IPv4 one.
function ipNum(addr) {
  const a = String(addr).trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (m4) { const p = m4.slice(1).map(Number); return p.some((x) => x > 255) ? null : { bits: 32, n: p.reduce((s, x) => (s << 8n) | BigInt(x), 0n) }; }
  if (a.length > 39 || !/^[0-9a-f:]+$/.test(a) || a.split('::').length > 2) return null;
  const [h, t] = a.split('::'), head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const groups = t === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return { bits: 128, n: groups.reduce((s, g) => (s << 16n) | BigInt(parseInt(g, 16)), 0n) };
}
// A client's address as a key: an IPv6 one by its /64, since a network gives all the rest of it to one customer.
function ipKey(addr) {
  const a = String(addr).trim().toLowerCase();
  if (!a.includes(':') || /^(::ffff:)?\d+\.\d+\.\d+\.\d+$/.test(a)) return a;
  const [h, t = ''] = a.split('::'), head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const full = a.includes('::') ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return `${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
// Cloudflare's own addresses (https://www.cloudflare.com/ips/, read 2026-11-25): an entry of the forwarded list in one of them is a hop of its edge.
export const CLOUDFLARE = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];
function rangesOf(list) {
  const nets = list.map((c) => {
    const [ip, len] = String(c).split('/'), a = ipNum(ip), l = Number(len);
    if (!a || len === undefined || !Number.isInteger(l) || l < 0 || l > a.bits) throw new Error(`clientIp.proxies: "${c}" is not an address range`);
    return { bits: a.bits, shift: BigInt(a.bits - l), net: a.n >> BigInt(a.bits - l) };
  });
  return (addr) => { const a = ipNum(addr); return !!a && nets.some((r) => r.bits === a.bits && a.n >> r.shift === r.net); };
}
// Where the client's address is read behind a proxy (`trustProxy`, or a `clientIp` rule):
//   { header: 'x-forwarded-for', hops, proxies }  the list each proxy adds an entry to the end of; the entries before the ones the proxies added are the
//     client's own and are not read. The client is the entry `hops` from the right (1: the last one). With `proxies` ('cloudflare', or address ranges)
//     an entry is passed over only when it is one of theirs, so a request that came in some other way is counted by the address that connected.
//     On Render (behind Cloudflare) its edge adds the address it accepted and Render adds the edge's own: the client is 2 from the right.
//   { header: '<name>' }  one header holding one address, for a proxy that always sets it itself.
// `trustProxy` alone is RENDER_CLIENT_IP. No other header (True-Client-IP, X-Real-IP) is read unless it is named.
export const RENDER_CLIENT_IP = Object.freeze({ header: 'x-forwarded-for', hops: 2, proxies: 'cloudflare' });
export function clientRule({ trustProxy = false, clientIp = null } = {}) {
  if (!clientIp && !trustProxy) return null;
  const c = clientIp || RENDER_CLIENT_IP, header = String(c.header || 'x-forwarded-for').toLowerCase(), hops = c.hops == null ? 1 : Number(c.hops);
  if (!/^[a-z0-9-]+$/.test(header)) throw new Error(`clientIp.header: "${c.header}" is not a header name`);
  if (!Number.isInteger(hops) || hops < 1 || hops > 8) throw new Error('clientIp.hops must be 1 to 8');
  const proxies = c.proxies == null ? null : rangesOf(c.proxies === 'cloudflare' ? CLOUDFLARE : Array.isArray(c.proxies) ? c.proxies : [c.proxies]);
  return { header, hops, proxies };
}
// Who is asking: the socket's address, or behind a proxy the address its rule reads (the socket's when that is missing or not an address).
export function clientOf(req, rule) {
  const direct = ipKey(req.socket.remoteAddress || 'unknown');
  if (!rule) return direct;
  const raw = req.headers[rule.header];
  const list = String(Array.isArray(raw) ? raw.join(',') : raw || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (rule.header !== 'x-forwarded-for') return list.length === 1 && ipNum(list[0]) ? ipKey(list[0]) : direct;
  let i = list.length - 1;
  for (let k = 1; k < rule.hops && i > 0 && (!rule.proxies || rule.proxies(list[i])); k++) i--;
  return i >= 0 && ipNum(list[i]) ? ipKey(list[i]) : direct;
}

export function makeHttpServer({ handle, origins = [], maxBody = 65536, limits = { default: [60, 60], offer: [6, 60] }, trustProxy = false, clientIp = null, kindOf = (method, path) => (path === '/offer' ? 'offer' : 'default') }) {
  const rule = clientRule({ trustProxy, clientIp });
  const buckets = new Map();
  function allowed(ip, kind) {
    const [cap, perSecs] = limits[kind] || limits.default;
    const key = `${kind}|${ip}`, t = Date.now() / 1000;
    const b = buckets.get(key) || { n: cap, at: t };
    b.n = Math.min(cap, b.n + ((t - b.at) * cap) / perSecs); b.at = t;
    if (b.n < 1) { buckets.set(key, b); return false; }
    b.n -= 1; buckets.set(key, b);
    return true;
  }
  setInterval(() => { const t = Date.now() / 1000; for (const [k, b] of buckets) if (t - b.at > 600) buckets.delete(k); }, 60000).unref();

  async function onRequest(req, res) {
    const origin = req.headers.origin;
    const cors = origin && (origins.includes('*') || origins.includes(origin)) ? { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' } : {};
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const ip = clientOf(req, rule);
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return send(400, { error: 'bad request' }); }
    const kind = kindOf(req.method, url.pathname);
    if (!allowed(ip, kind)) return send(429, { error: 'too many requests' });
    let body = null;
    if (req.method === 'POST' || req.method === 'PUT') {
      const tooBig = () => { res.shouldKeepAlive = false; send(413, { error: 'body too large' }); res.once('finish', () => req.destroy()); };
      if (Number(req.headers['content-length']) > maxBody) return tooBig();
      let text;
      try { text = await readBody(req, maxBody); } catch { return req.destroy(); }
      if (text == null) return tooBig();
      try { body = JSON.parse(text || '{}'); } catch { return send(400, { error: 'body is not JSON' }); }
    }
    const r = await handle({ method: req.method, path: url.pathname, body, client: ip });
    send(r.status, r.body);
  }
  // whatever a request does, the process stays up: a listener that throws is an unhandled rejection, which ends it
  const server = createServer((req, res) => {
    onRequest(req, res).catch(() => { try { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'the service could not answer' })); } catch { /* the connection is gone */ } });
  });
  // a connection is kept longer than a proxy in front keeps its own idle ones, so the proxy never reuses one this side has closed
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  return server;
}
