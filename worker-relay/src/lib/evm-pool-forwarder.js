// A forwarder for the private route (dapp/sealed-request.js, docs/EVM-POOL.md "Private route"). It carries a wallet's sealed request to
// a keeper's /sealed and the sealed answer back. It sees the caller's address and the size and time of each envelope, and nothing
// of what is in it; it holds no key, forwards no header of the caller's, and keeps nothing. The route hides a caller from the
// keeper only while the forwarder and the keeper are not one party.
//
//   POST /f/<id>        a sealed request → the answer of the gateway named <id>
//   GET  /health
//
// gateways: { "<id>": "<a /sealed URL>" }: an id is a chain's ("1"), a pool's ("1-xdac17f958d") or a service's ("k": the multi-keeper
// service's POST /sealed, which carries every pool). Each caller is limited by its address, as the keeper limits its own.

import { makeTokenBucket, clientKey } from './token-bucket.js';
import { MAX_REQUEST } from '../../../dapp/sealed-request.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
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

export function makeForwarder({ gateways, ratePerMin = 60, timeoutMs = 210_000, fetchImpl = globalThis.fetch }) {
  const allowed = makeTokenBucket({ perMin: ratePerMin, burst: Math.max(1, Math.min(20, ratePerMin)) });
  const reply = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...CORS });
    res.end(body);
  };
  return async function forward(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return reply(res, 400, '{"error":"bad request"}'); }
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (url.pathname === '/health' && req.method === 'GET') return reply(res, 200, '{"ok":true}');
    const m = /^\/f\/([0-9A-Za-z_-]{1,40})$/.exec(url.pathname);
    if (!m || req.method !== 'POST') return reply(res, 404, '{"error":"not found"}');
    const gateway = Object.hasOwn(gateways, m[1]) ? gateways[m[1]] : null;
    if (!gateway) return reply(res, 404, '{"error":"no keeper for that id"}');
    if (!allowed(clientKey(req))) { res.setHeader?.('Retry-After', '10'); return reply(res, 429, '{"error":"rate limited"}'); }
    let body;
    try { body = await readBody(req, MAX_REQUEST); } catch { return reply(res, 413, '{"error":"body too large"}'); }
    let up;
    try {
      up = await fetchImpl(gateway, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch { return reply(res, 502, '{"error":"the keeper did not answer"}'); }
    const answer = Buffer.from(await up.arrayBuffer());
    if (answer.length > MAX_ANSWER) return reply(res, 502, '{"error":"the answer is too large"}');
    if (up.status !== 200) return reply(res, up.status === 429 || up.status >= 500 ? up.status : 400, '{"error":"the keeper did not take the request"}');
    return reply(res, 200, answer, 'application/octet-stream');
  };
}
