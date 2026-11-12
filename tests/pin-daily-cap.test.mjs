// The pin routes: the daily per-client cap holds under parallel requests, a body over a route's ceiling is refused before it is read,
// and a drop-snapshot attempt counts whether or not it turns out to be a snapshot. The upstream pin service is a stub.
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const { createMemDriver } = await import(`${ROOT}/server/driver-mem.mjs`);
const { createCacheStorage } = await import(`${ROOT}/server/cache-mem.mjs`);
const { buildEnv, createCtxFactory, createTacitServer } = await import(`${ROOT}/server/harness.mjs`);
globalThis.caches = createCacheStorage({ maxBytes: 16 * 1024 * 1024 });
const b32 = (u8) => { const A = 'abcdefghijklmnopqrstuvwxyz234567'; let bits = 0, v = 0, o = ''; for (const b of u8) { v = (v << 8) | b; bits += 8; while (bits >= 5) { o += A[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) o += A[(v << (5 - bits)) & 31]; return o; };
let upstreamPins = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.pinata.cloud/')) {
    const file = init.body.get('file');
    const bytes = new Uint8Array(await file.arrayBuffer());
    await new Promise((r) => setTimeout(r, 120));
    upstreamPins++;
    const cid = Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), crypto.createHash('sha256').update(bytes).digest()]);
    return new Response(JSON.stringify({ IpfsHash: 'b' + b32(cid) }), { status: 200 });
  }
  return realFetch(url, init);
};
const workerModule = (await import(`${ROOT}/worker/src/index.js`)).default;
const driver = createMemDriver();
const env = buildEnv(driver, { extra: { PINATA_JWT: 'dummy', FILEBASE_KEY: '', DAILY_LIMIT: '20' } });
const server = createTacitServer({ workerModule, env, driver, ctxFactory: createCtxFactory() });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const png = (i, size = 200) => { const b = new Uint8Array(size); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); b[20] = i & 255; b[21] = (i >> 8) & 255; return b; };
const pin = async (i, size) => {
  const fd = new FormData(); fd.append('file', new Blob([png(i, size)], { type: 'image/png' }), 'x.png');
  return (await realFetch(`${base}/pin`, { method: 'POST', body: fd })).status;
};
const tally = (a) => a.reduce((m, s) => (m[s] = (m[s] || 0) + 1, m), {});
let fails = 0, n = 0;
const check = (label, ok, detail = '') => { console.log(ok ? 'ok  ' : 'FAIL', label, detail); if (!ok) fails++; };

// 1. parallel requests from one client are held to the daily limit
const burst = tally(await Promise.all(Array.from({ length: 60 }, () => pin(n++))));
check('60 parallel pins: exactly the daily limit pass', burst[200] === 20 && burst[429] === 40, JSON.stringify(burst));
check('the upstream saw no more than the limit', upstreamPins === 20, `upstream pins ${upstreamPins}`);

// 2. a /pin body over the route's ceiling is refused whole
const big = await pin(999, 4 * 1024 * 1024);
check('a 4 MiB /pin body is refused before it is read', big === 413, `status ${big}`);

// 3. a drop-snapshot attempt counts even when it is not a snapshot, and a body over its ceiling is refused
const day = new Date().toISOString().slice(0, 10);
const before = await env.UPLOAD_KV.get(`pin:${day}:127.0.0.1`);
await driver.reset?.();
const driver2 = createMemDriver();
const env2 = buildEnv(driver2, { extra: { PINATA_JWT: 'dummy', FILEBASE_KEY: '', DAILY_LIMIT: '3' } });
const server2 = createTacitServer({ workerModule, env: env2, driver: driver2, ctxFactory: createCtxFactory() });
await new Promise((r) => server2.listen(0, '127.0.0.1', r));
const base2 = `http://127.0.0.1:${server2.address().port}`;
const snap = (body) => realFetch(`${base2}/pin-airdrop-snapshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
const codes = [];
for (let i = 0; i < 5; i++) codes.push((await snap('{"schema":"nope"}')).status);
check('rejected snapshot attempts count against the daily limit', codes.slice(0, 3).every((c) => c === 400) && codes.slice(3).every((c) => c === 429), codes.join(','));
const over = await snap(JSON.stringify({ rows: 'x'.repeat(9 * 1024 * 1024) }));
check('a 9 MiB snapshot body is refused before it is read', over.status === 413 || over.status === 429, `status ${over.status}`);
server.close(); server2.close();
if (fails) { console.error(`${fails} check(s) failed`); process.exit(1); }
console.log('pin route checks passed');
process.exit(0);
