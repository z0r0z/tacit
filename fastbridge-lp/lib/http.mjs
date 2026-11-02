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

export function makeHttpServer({ handle, origins = [], maxBody = 65536, limits = { default: [60, 60], offer: [6, 60] }, trustProxy = false }) {
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

  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = origin && (origins.includes('*') || origins.includes(origin)) ? { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' } : {};
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const ip = (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
    const url = new URL(req.url, 'http://x');
    const kind = url.pathname === '/offer' ? 'offer' : 'default';
    if (!allowed(ip, kind)) return send(429, { error: 'too many requests' });
    let body = null;
    if (req.method === 'POST') {
      const tooBig = () => { res.shouldKeepAlive = false; send(413, { error: 'body too large' }); res.once('finish', () => req.destroy()); };
      if (Number(req.headers['content-length']) > maxBody) return tooBig();
      let text;
      try { text = await readBody(req, maxBody); } catch { return req.destroy(); }
      if (text == null) return tooBig();
      try { body = JSON.parse(text || '{}'); } catch { return send(400, { error: 'body is not JSON' }); }
    }
    const r = await handle({ method: req.method, path: url.pathname, body });
    send(r.status, r.body);
  });
}
