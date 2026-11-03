// Silent-payment hints. A Tacit app that makes a silent payment posts the transaction id sealed to the recipient's
// scan key (dapp/sp-hints.js); every recipient's app reads all hints and opens only its own, so a payment shows up
// without scanning every block. The service keeps opaque blobs for a while: it cannot tell who a hint is for.
//
//   POST /sp/hints  { e: 33-byte compressed point (hex), c: 48 bytes (hex) }  → { id }
//   GET  /sp/hints?after=<id>&limit=<1..5000>                                 → { hints: [[id, e, c], …], next }
//
// Mounted by btc-pool-indexer.js when BTC_POOL_SP_HINTS=1.

import { clientKey, makeRateLimiter } from './btc-pool-relayer.js';
import { parseUrl } from './safe-url.js';

const E_RE = /^0[23][0-9a-f]{64}$/;
const C_RE = /^[0-9a-f]{96}$/;
const MAX_BODY = 1024;

export function makeSpHints({ db, now = () => Date.now(), keepDays = 45, rateLimit = { perMin: 6, burst: 20 } }) {
  db.exec('CREATE TABLE IF NOT EXISTS sp_hints (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, e TEXT NOT NULL, c TEXT NOT NULL)');
  db.exec('CREATE INDEX IF NOT EXISTS sp_hints_at ON sp_hints(at)');
  const ins = db.prepare('INSERT INTO sp_hints (at, e, c) VALUES (?, ?, ?)');
  const page = db.prepare('SELECT id, e, c FROM sp_hints WHERE id > ? ORDER BY id LIMIT ?');
  const prune = db.prepare('DELETE FROM sp_hints WHERE at < ?');
  const allow = makeRateLimiter({ now, ...rateLimit });
  let prunedAt = 0;

  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0, over = false;
    const parts = [];
    req.on('data', (d) => { n += d.length; if (n <= MAX_BODY) parts.push(d); else if (!over) { over = true; reject(Object.assign(new Error('too large'), { status: 413 })); } });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });

  async function handle(req, res) {
    const url = parseUrl(req);
    if (!url) return false;                      // no URL: not this handler's, and the next one answers it
    if (url.pathname.replace(/\/$/, '') !== '/sp/hints') return false;
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ...(code === 429 ? { 'Retry-After': '30' } : {}) });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return true;
    }
    if (now() - prunedAt > 3600e3) { prunedAt = now(); prune.run(now() - keepDays * 86400e3); }
    try {
      if (req.method === 'GET') {
        const after = Math.max(0, Math.floor(Number(url.searchParams.get('after')) || 0));
        const limit = Math.min(5000, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 1000)));
        const rows = page.all(after, limit);
        send(200, { hints: rows.map((r) => [r.id, r.e, r.c]), next: rows.length === limit ? rows[rows.length - 1].id : null });
      } else if (req.method === 'POST') {
        if (!allow(`hint ${clientKey(req)}`)) return send(429, { error: 'rate limited' }), true;
        let b;
        try { b = JSON.parse(await readBody(req)); } catch (e) { return send(e.status || 400, { error: e.status ? 'too large' : 'bad json' }), true; }
        const e = String(b?.e || '').toLowerCase(), c = String(b?.c || '').toLowerCase();
        if (!E_RE.test(e) || !C_RE.test(c)) return send(400, { error: 'e must be a compressed point and c 48 bytes, both hex' }), true;
        send(200, { id: Number(ins.run(now(), e, c).lastInsertRowid) });
      } else send(405, { error: 'GET or POST' });
    } catch {
      send(500, { error: 'internal error' });
    }
    return true;
  }
  return { handle, wrap: (next) => async (req, res) => { if (!(await handle(req, res))) next(req, res); } };
}
