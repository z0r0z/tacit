#!/usr/bin/env node
// The relay API over the private route, end to end: the page's apiFetch, a forwarder that adds a caller token, the real server harness with the API gateway, and a stand-in worker that
// records the address each request was counted under. Run: node tests/route-api.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { createTacitServer } from '../server/harness.mjs';
import { makeApiSealed, senderAddress } from '../server/sealed-api.mjs';
import { makeForwarder, senderToken } from '../worker-relay/src/lib/evm-pool-forwarder.js';
import { newGatewayKey, gatewayKeys } from '../dapp/sealed-request.js';

process.env.TRUST_PROXY = '1';
let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

const sealedUrl = pathToFileURL(new URL('../dapp/sealed-request.js', import.meta.url).pathname).href;
const source = readFileSync(new URL('../dapp/private-route.js', import.meta.url), 'utf8').replace(/\/sealed-request\.js\?cb=[A-Za-z0-9_-]+/, sealedUrl);
const dir = mkdtempSync(join(tmpdir(), 'route-api-'));
writeFileSync(join(dir, 'private-route.mjs'), source);
const { ROUTE, apiFetch } = await import(pathToFileURL(join(dir, 'private-route.mjs')).href);

// the API: a real server harness with the gateway in front, and a worker that records what it was asked and who it counted it under
const apiKey = newGatewayKey(), PUB = Buffer.from(gatewayKeys(apiKey).pub).toString('hex');
const worker = [];
const workerModule = { fetch: async (req) => { const u = new URL(req.url); const body = req.method === 'POST' ? await req.text() : null; worker.push({ method: req.method, path: u.pathname + u.search, ip: req.headers.get('CF-Connecting-IP'), body });
  return new Response(u.pathname === '/confidential/quote' && u.searchParams.get('amountWei') === 'bad' ? '{"error":"bad amount"}' : '{"ok":true}', { status: u.searchParams.get('amountWei') === 'bad' ? 400 : 200, headers: { 'content-type': 'application/json' } }); } };
const env = {};
const sealed = makeApiSealed({ env, secret: apiKey, forwarders: ['127.0.0.1'] });
const srv = createTacitServer({ workerModule, env, driver: { get: async () => null }, ctxFactory: { makeCtx: () => ({ waitUntil() {}, passThroughOnException() {} }), pending: new Set() }, sealed });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const API_DIRECT = `http://127.0.0.1:${srv.address().port}`;

// a forwarder in front of it, with the sender key
const SECRET = 'c'.repeat(64);
const fwd = makeForwarder({ gateways: { a: `${API_DIRECT}/sealed` }, senderSecret: SECRET, senderIds: ['a'], ratePerMin: 600 });
let callerIp = '203.0.113.7', forwarderUp = true; const direct = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === 'https://f1.test/f/a') {
    if (!forwarderUp) throw new Error('connection refused');
    const bytes = Buffer.from(init.body);
    const req = Readable.from([bytes]); req.method = 'POST'; req.url = '/f/a'; req.headers = { 'content-length': String(bytes.length), 'x-forwarded-for': callerIp, origin: 'https://tacit.finance' }; req.socket = { remoteAddress: callerIp };
    return new Promise((resolve) => { const chunks = []; let status = 200; fwd(req, { headersSent: false, setHeader() {}, writeHead(c) { status = c; }, write(d) { chunks.push(Buffer.from(d)); }, end(d) { if (d) chunks.push(Buffer.from(d)); resolve(new Response(Buffer.concat(chunks), { status })); } }); });
  }
  if (u.startsWith('https://api.test') || u.startsWith('https://other.test')) { direct.push(u); return new Response('{"direct":true}', { status: 200, headers: { 'content-type': 'application/json' } }); }
  return realFetch(url, init);
};
Object.assign(ROUTE, { gateway: 'unused-but-set', forwarders: ['https://f1.test'], api: { url: 'https://api.test', id: 'a', gateway: PUB } });
ROUTE.gateway = Buffer.from(gatewayKeys(newGatewayKey()).pub).toString('hex');   // the relay key the page also names, so the route counts as available

let clock = 1e12;
const f = () => apiFetch({ now: () => clock });
const day = Math.floor(Date.now() / 86_400_000);
const ipKey64 = (a) => a.replace(/::1$/, '').split(':').map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';   // as the server counts an IPv6 caller: its /64, leading zeros dropped
const reset = () => { worker.length = 0; direct.length = 0; clock += 120_000; };

await check('a read of the relay goes through a forwarder, and the worker counts it under the caller\'s token, never an address', async () => {
  reset();
  const r = await f()('https://api.test/confidential/quote?asset=cETH&amountWei=1000');
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
  assert.equal(direct.length, 0, 'the API was not asked directly');
  assert.equal(worker[0].path, '/confidential/quote?asset=cETH&amountWei=1000');
  assert.equal(worker[0].ip, ipKey64(senderAddress(senderToken(SECRET, '203.0.113.7', day))), 'the address the worker counted is made from the token');
  const seenAnywhere = JSON.stringify(worker);
  assert.ok(!seenAnywhere.includes('203.0.113') && !seenAnywhere.includes('127.0.0.1') && !seenAnywhere.includes('tacit.finance'), 'no address and no origin reached the worker');
});

await check('a submission carries its body, and callers on one network are one sender, on two networks two', async () => {
  reset();
  callerIp = '203.0.113.7'; await f()('https://api.test/confidential/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'swap', op: { x: 1 } }) });
  callerIp = '203.0.113.99'; await f()('https://api.test/confidential/status?id=0xaa');
  callerIp = '198.51.100.4'; await f()('https://api.test/confidential/status?id=0xbb');
  callerIp = '203.0.113.7';
  assert.deepEqual(JSON.parse(worker[0].body), { type: 'swap', op: { x: 1 } });
  assert.equal(worker[0].ip, worker[1].ip, 'the same /24');
  assert.notEqual(worker[0].ip, worker[2].ip, 'another network');
  assert.equal(direct.length, 0);
});

await check('an answer of the API\'s own, an error included, is the answer', async () => {
  reset();
  const r = await f()('https://api.test/confidential/quote?asset=cETH&amountWei=bad');
  assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: 'bad amount' });
  assert.equal(direct.length, 0, 'not sent again in the open');
});

await check('what is not on the carried list, and any other host, is fetched as it was', async () => {
  reset();
  await f()('https://api.test/stats?network=mainnet');
  await f()('https://api.test/confidential/ack', { method: 'POST', body: '{}' });
  await f()('https://other.test/confidential/quote?asset=cETH');
  assert.deepEqual(direct, ['https://api.test/stats?network=mainnet', 'https://api.test/confidential/ack', 'https://other.test/confidential/quote?asset=cETH']);
  assert.equal(worker.length, 0);
});

await check('when no forwarder answers the relay is still reached, and the road is left alone for a minute', async () => {
  reset(); forwarderUp = false; const g = f();
  const r = await g('https://api.test/confidential/relay');
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { direct: true });
  assert.equal(direct.length, 1);
  await g('https://api.test/confidential/relay'); await g('https://api.test/confidential/status?id=0x1');
  assert.equal(direct.length, 3, 'not tried through the road again within the minute');
  forwarderUp = true; clock += 61_000;
  assert.deepEqual(await (await g('https://api.test/confidential/relay')).json(), { ok: true }, 'and tried again after it');
});

await check('with no API gateway named the page is as it was', async () => {
  reset(); const saved = ROUTE.api; ROUTE.api = null;
  await f()('https://api.test/confidential/quote?asset=cETH');
  assert.equal(direct.length, 1); ROUTE.api = saved;
});

srv.close(); globalThis.fetch = realFetch;
console.log(`\n${n} checks passed`);
process.exit(0);
