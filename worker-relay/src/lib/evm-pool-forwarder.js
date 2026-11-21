// A forwarder for the private route (dapp/sealed-request.js, docs/EVM-POOL.md "Private route"). It carries a wallet's sealed request to
// a keeper's /sealed and the sealed answer back. It sees the caller's address and the size and time of each envelope, and nothing
// of what is in it; it holds no key, forwards no header of the caller's, and keeps nothing. The route hides a caller from the
// keeper only while the forwarder and the keeper are not one party.
//
// community: { find(chainId, relayer) → { url } | null, request(url, { method, body, headers, maxBytes, timeoutMs }) → { status, body } } carries the /r/ routes,
// to a relay that is in the registry and only to its own /sealed and /sealed/key on its https origin (relayOrigin), never to a url a caller gives. Without
// it the /r/ routes answer 404.
//
//   POST /f/<id>        a sealed request → the answer of the gateway named <id>
//   POST /r/<chainId>/<relayer>       a sealed request → the answer of the relay the relay registry lists for that chain and address (its /sealed)
//   GET  /r/<chainId>/<relayer>/key   that relay's gateway key, signed for by its relayer key (its /sealed/key), which the wallet checks
//   GET  /health
//
// gateways: { "<id>": "<a /sealed URL>" }: an id is a chain's ("1"), a pool's ("1-xdac17f958d") or a service's ("k": the multi-keeper
// service's POST /sealed, which carries every pool). Each caller is limited by its address, as the keeper limits its own.

import { createHmac } from 'node:crypto';
import { makeTokenBucket, clientKey } from './token-bucket.js';
import { MAX_REQUEST } from '../../../dapp/sealed-request.js';
import { relayOrigin } from './safe-https.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
const MAX_ANSWER = 9 << 20;

function readBody(req, max) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) { req.resume(); return Promise.reject(new Error('too large')); }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on('end', () => (size > max ? reject(new Error('too large')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

const MAX_KEY_DOC = 16 << 10;

// A stand-in for who is asking, for a service that has to count each caller (queue fairness, daily budgets) and must not be told who: a keyed hash, made here and only
// here, of the caller's network (an IPv4 /24, an IPv6 /64) and the UTC day. The same network gets the same token for a day, so a service can group its callers by it; the
// token cannot be turned back into an address (the key is this forwarder's), and tomorrow's does not match today's, so a service cannot follow a caller across days.
export function senderToken(secret, key, day = Math.floor(Date.now() / 86_400_000)) {
  const k = String(key);
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(k);
  const prefix = v4 ? `${v4[1]}.${v4[2]}.${v4[3]}.0/24` : k;
  return createHmac('sha256', secret).update(`${day}|${prefix}`).digest('hex').slice(0, 12);
}

// `senderSecret` and `senderIds`: the gateway ids (FORWARDER_SENDER_IDS) that get the caller's token in an `x-tacit-sender` header. The others get nothing of the caller's.
export function makeForwarder({ gateways, ratePerMin = 60, timeoutMs = 210_000, fetchImpl = globalThis.fetch, community = null, senderSecret = null, senderIds = [] }) {
  const wantsToken = new Set(senderIds);
  const allowed = makeTokenBucket({ perMin: ratePerMin, burst: Math.max(1, Math.min(20, ratePerMin)) });
  const relayAllowed = makeTokenBucket({ perMin: ratePerMin * 20, burst: 60 });      // a relay is asked for by every caller: its own limit, wider than one caller's
  const reply = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...CORS });
    res.end(body);
  };
  return async function forward(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return reply(res, 400, '{"error":"bad request"}'); }
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (url.pathname === '/health' && req.method === 'GET') return reply(res, 200, '{"ok":true}');
    const mr = /^\/r\/(\d{1,10})\/(0x[0-9a-fA-F]{40})(\/key)?$/.exec(url.pathname);
    if (mr) {
      if (!community || req.method !== (mr[3] ? 'GET' : 'POST')) return reply(res, 404, '{"error":"not found"}');
      if (!allowed(clientKey(req))) { res.setHeader?.('Retry-After', '10'); return reply(res, 429, '{"error":"rate limited"}'); }
      let entry = null;
      try { entry = await community.find(Number(mr[1]), mr[2]); } catch { return reply(res, 502, '{"error":"the registry could not be read"}'); }
      const origin = entry && relayOrigin(entry.url);
      if (!origin) return reply(res, 404, '{"error":"no such relay"}');
      if (!relayAllowed(`${mr[1]}:${mr[2].toLowerCase()}`)) { res.setHeader?.('Retry-After', '10'); return reply(res, 429, '{"error":"rate limited"}'); }
      if (mr[3]) {
        let up;
        try { up = await community.request(`${origin}/sealed/key`, { method: 'GET', maxBytes: MAX_KEY_DOC, timeoutMs: 15_000 }); } catch { return reply(res, 502, '{"error":"the relay did not answer"}'); }
        let doc = null;
        try { doc = JSON.parse(up.body.toString('utf8')); } catch { /* not JSON */ }
        if (up.status !== 200 || !Array.isArray(doc?.docs)) return reply(res, 502, '{"error":"the relay has no gateway key to show"}');
        return reply(res, 200, JSON.stringify({ docs: doc.docs.slice(0, 16) }));
      }
      let body;
      try { body = await readBody(req, MAX_REQUEST); } catch { return reply(res, 413, '{"error":"body too large"}'); }
      let up;
      try { up = await community.request(`${origin}/sealed`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, maxBytes: MAX_ANSWER, timeoutMs }); } catch { return reply(res, 502, '{"error":"the relay did not answer"}'); }
      if (up.body.length > MAX_ANSWER) return reply(res, 502, '{"error":"the answer is too large"}');
      if (up.status !== 200) return reply(res, up.status === 429 || up.status >= 500 ? up.status : 400, '{"error":"the relay did not take the request"}');
      return reply(res, 200, up.body, 'application/octet-stream');
    }
    const m = /^\/f\/([0-9A-Za-z_-]{1,40})$/.exec(url.pathname);
    if (!m || req.method !== 'POST') return reply(res, 404, '{"error":"not found"}');
    const gateway = Object.hasOwn(gateways, m[1]) ? gateways[m[1]] : null;
    if (!gateway) return reply(res, 404, '{"error":"no keeper for that id"}');
    if (!allowed(clientKey(req))) { res.setHeader?.('Retry-After', '10'); return reply(res, 429, '{"error":"rate limited"}'); }
    let body;
    try { body = await readBody(req, MAX_REQUEST); } catch { return reply(res, 413, '{"error":"body too large"}'); }
    let up;
    try {
      up = await fetchImpl(gateway, { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...(senderSecret && wantsToken.has(m[1]) ? { 'x-tacit-sender': senderToken(senderSecret, clientKey(req)) } : {}) }, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch { return reply(res, 502, '{"error":"the keeper did not answer"}'); }
    const answer = Buffer.from(await up.arrayBuffer());
    if (answer.length > MAX_ANSWER) return reply(res, 502, '{"error":"the answer is too large"}');
    if (up.status !== 200) return reply(res, up.status === 429 || up.status >= 500 ? up.status : 400, '{"error":"the keeper did not take the request"}');
    return reply(res, 200, answer, 'application/octet-stream');
  };
}
