// Harness bridge test: boots the real worker (worker/src/index.js) on the
// Node harness with the mem driver and exercises the HTTP path end to end —
// request bridging, CORS, body handling, IP-header hygiene, the caches shim,
// and cron alignment. No network egress: only KV-free routes are hit.
//
// Run: `node tests/server-harness.test.mjs`

import { createMemDriver } from '../server/driver-mem.mjs';
import { createCacheStorage } from '../server/cache-mem.mjs';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

// caches.default must exist before the worker module loads.
const cacheStorage = createCacheStorage({ maxBytes: 8 * 1024 * 1024 });
globalThis.caches = cacheStorage;

const { buildEnv, createCtxFactory, createTacitServer, nextTickDelay, clientIpFrom, toWebRequest } =
  await import('../server/harness.mjs');
const workerModule = (await import('../worker/src/index.js')).default;

const driver = createMemDriver();
const env = buildEnv(driver);
const ctxFactory = createCtxFactory();
const server = createTacitServer({ workerModule, env, driver, ctxFactory });
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

// wrangler [vars] flow through buildEnv
ok('env carries wrangler vars', typeof env.ALLOWED_ORIGINS === 'string'
  && env.ALLOWED_ORIGINS.includes('https://tacit.finance'));

// harness-level health (storage probe)
const hz = await fetch(`${base}/healthz`);
ok('/healthz 200', hz.status === 200 && (await hz.json()).ok === true);

// worker route end to end
const h = await fetch(`${base}/health`, { headers: { Origin: 'https://tacit.finance' } });
const hBody = await h.json();
ok('worker /health 200 with body', h.status === 200 && hBody.ok === true);
ok('CORS header on allowed origin', h.headers.get('access-control-allow-origin') === 'https://tacit.finance');

// OPTIONS preflight
const opt = await fetch(`${base}/anything`, { method: 'OPTIONS', headers: { Origin: 'https://tacit.finance' } });
ok('OPTIONS preflight 204', opt.status === 204);

// unknown route falls through the full router and still returns JSON + CORS
const nf = await fetch(`${base}/no-such-route-xyz`, { headers: { Origin: 'https://tacit.finance' } });
ok('unknown route is a handled 404', nf.status === 404
  && (nf.headers.get('content-type') || '').includes('json'));

// POST body bridging: /prover-heartbeat parses JSON and auth-gates before any
// KV/egress, so a bad token proves the body crossed the bridge intact
const hb = await fetch(`${base}/prover-heartbeat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: 'wrong-token', ok: true }),
});
ok('POST body reaches worker (auth-gated, not 5xx)', hb.status >= 400 && hb.status < 500, hb.status);

// spoofed CF-Connecting-IP is stripped and re-derived
{
  const fakeReq = {
    method: 'GET',
    url: '/x',
    headers: { host: 'h', 'cf-connecting-ip': '6.6.6.6', 'x-forwarded-for': '9.9.9.9' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const req1 = toWebRequest(fakeReq, { ...env, TRUST_PROXY: undefined });
  ok('spoofed CF-Connecting-IP replaced by socket addr',
    req1.headers.get('CF-Connecting-IP') === '127.0.0.1');
  const req2 = toWebRequest(fakeReq, { ...env, TRUST_PROXY: '1' });
  ok('TRUST_PROXY=1 takes first X-Forwarded-For hop',
    req2.headers.get('CF-Connecting-IP') === '9.9.9.9');
  const envKey = { ...env, TRUST_PROXY: undefined, PROXY_TRUST_KEY: 's3cret' };
  const proxied = {
    ...fakeReq,
    headers: { ...fakeReq.headers, 'x-tacit-proxy-key': 's3cret', 'x-tacit-forwarded-ip': '1.2.3.4' },
  };
  ok('legacy proxy handshake forwards client ip', clientIpFrom(proxied, envKey) === '1.2.3.4');
  const badKey = { ...proxied, headers: { ...proxied.headers, 'x-tacit-proxy-key': 'nope' } };
  ok('wrong proxy key ignored', clientIpFrom(badKey, envKey) === '127.0.0.1');
}

// caches shim: store/match/delete with X-Cached-At preserved (SWR contract)
{
  const key = new Request('https://_market-cache_/market?network=mainnet', { method: 'GET' });
  const stamped = Date.now();
  await caches.default.put(key, new Response(JSON.stringify({ rows: [1] }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60', 'X-Cached-At': String(stamped) },
  }));
  const hit = await caches.default.match(key);
  ok('cache match returns stored response', hit && (await hit.json()).rows[0] === 1);
  ok('X-Cached-At preserved', hit.headers.get('X-Cached-At') === String(stamped));
  ok('cache delete', (await caches.default.delete(key)) === true
    && (await caches.default.match(key)) === undefined);
  await caches.default.put(key, new Response('x', { headers: { 'Cache-Control': 'no-store' } }));
  ok('no-store responses are not cached', (await caches.default.match(key)) === undefined);
}

// cron alignment: ticks land on wall-clock multiples like Cloudflare's scheduler
{
  const interval = 5 * 60 * 1000;
  const boundary = 1_700_000_100_000 - (1_700_000_100_000 % interval);
  ok('nextTickDelay reaches the boundary',
    (boundary - 1234 + nextTickDelay(boundary - 1234, interval)) % interval === 0);
  ok('nextTickDelay at boundary waits a full interval',
    nextTickDelay(boundary, interval) === interval);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
