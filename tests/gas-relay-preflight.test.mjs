// The browser sends OPTIONS before POST /gas/order; a non-2xx answer there stopped every order a page tried to post (live 2026-11-25: 405).
//
// Run: node tests/gas-relay-preflight.test.mjs

import worker from '../worker/src/index.js';

const kv = () => { const m = new Map(); return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); }, async list() { return { keys: [], list_complete: true }; } }; };
let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };

const env = { REGISTRY_KV: kv() };
for (const path of ['/gas/order', '/gas/orders', '/gas/done']) {
  const r = await worker.fetch(new Request(`https://api.tacit.finance${path}`, { method: 'OPTIONS', headers: { Origin: 'https://tacit.finance', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }), env, { waitUntil() {} });
  ok(r.status === 204, `OPTIONS ${path} answers 204 (got ${r.status})`);
  ok(!!r.headers.get('access-control-allow-origin') && /POST/.test(r.headers.get('access-control-allow-methods') || ''), `OPTIONS ${path} allows the origin and POST`);
}
const bad = await worker.fetch(new Request('https://api.tacit.finance/gas/order', { method: 'PUT', headers: { Origin: 'https://tacit.finance' } }), env, { waitUntil() {} });
ok(bad.status === 405, `PUT /gas/order is still 405 (got ${bad.status})`);
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
