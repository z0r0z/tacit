#!/usr/bin/env node
// The relay API over Nostr: when no forwarder answers, the page's apiFetch carries the request by public relays; the server's gateway answers it through the same handler, and the worker counts
// each envelope under an address made for it alone, never the road's. Run: node tests/route-api-nostr.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createTacitServer } from '../server/harness.mjs';
import { makeApiSealed } from '../server/sealed-api.mjs';
import { makeNostrRoad } from '../worker-relay/src/lib/evm-pool-keeper-nostr.js';
import { newGatewayKey, gatewayKeys } from '../dapp/sealed-request.js';
import { bytesToHex } from '../dapp/vendor/tacit-deps.min.js';

const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { WebSocketServer, WebSocket } = require('ws');
globalThis.WebSocket = WebSocket;
process.env.TRUST_PROXY = '1';
let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a relay that passes events to the subscriptions that match them
async function fakeRelay() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await new Promise((r) => wss.on('listening', r));
  const subs = new Set();
  const match = (f, ev) => (!f.kinds || f.kinds.includes(ev.kind)) && Object.entries(f).every(([k, v]) => !k.startsWith('#') || ev.tags.some((t) => t[0] === k.slice(1) && v.includes(t[1])));
  wss.on('connection', (ws) => { ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m[0] === 'REQ') subs.add({ ws, id: m[1], f: m[2] }); if (m[0] === 'EVENT') { ws.send(JSON.stringify(['OK', m[1].id, true, ''])); for (const s of subs) if (s.ws.readyState === 1 && match(s.f, m[1])) s.ws.send(JSON.stringify(['EVENT', s.id, m[1]])); } }); ws.on('close', () => { for (const s of subs) if (s.ws === ws) subs.delete(s); }); });
  return { url: `ws://127.0.0.1:${wss.address().port}`, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}

const secret = newGatewayKey(), keys = gatewayKeys(secret), PUB = Buffer.from(keys.pub).toString('hex');
const worker = [];
const workerModule = { fetch: async (req) => { const u = new URL(req.url); worker.push({ path: u.pathname + u.search, ip: req.headers.get('CF-Connecting-IP') }); return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); } };
const env = {};
const sealed = makeApiSealed({ env, secret, forwarders: [] });
const srv = createTacitServer({ workerModule, env, driver: { get: async () => null }, ctxFactory: { makeCtx: () => ({ waitUntil() {}, passThroughOnException() {} }), pending: new Set() }, sealed });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const relay = await fakeRelay();
const road = makeNostrRoad({ take: (rq, rs) => sealed(rq, rs, srv.handle), kidHex: bytesToHex(keys.kid), relays: [relay.url], WS: WebSocket, minBits: 8 }).start();
for (let i = 0; i < 50 && road.stats().relays.length < 1; i++) await sleep(50);
assert.equal(road.stats().relays.length, 1, 'the server is listening on the relay');

// the page's route, with forwarders that are not there and the relay above
const dir = mkdtempSync(join(tmpdir(), 'route-api-nostr-'));
const dapp = (f) => pathToFileURL(fileURLToPath(new URL(`../dapp/${f}`, import.meta.url))).href;
writeFileSync(join(dir, 'private-route.mjs'), readFileSync(new URL('../dapp/private-route.js', import.meta.url), 'utf8')
  .replace(/\/sealed-request\.js\?cb=[A-Za-z0-9_-]+/g, dapp('sealed-request.js')).replace(/\/route-nostr\.js\?cb=[A-Za-z0-9_-]+/g, dapp('route-nostr.js')));
const { ROUTE, apiFetch } = await import(pathToFileURL(join(dir, 'private-route.mjs')).href);
Object.assign(ROUTE, { gateway: bytesToHex(gatewayKeys(newGatewayKey()).pub), forwarders: ['http://127.0.0.1:1'], nostr: [relay.url], api: { url: 'https://api.test', id: 'a', gateway: PUB } });
const direct = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { const u = String(url); if (u.startsWith('https://api.test')) { direct.push(u); return new Response('{"direct":true}'); } return realFetch(url, init); };

await check('with no forwarder, the page\'s request goes over Nostr and the API answers it', async () => {
  const f = apiFetch({ now: () => 1e12 });
  const r = await f('https://api.test/confidential/quote?asset=cETH&amountWei=1000');
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
  assert.equal(direct.length, 0, 'the API was not asked directly');
  assert.equal(worker[0].path, '/confidential/quote?asset=cETH&amountWei=1000');
});

await check('each envelope on the road is counted under an address of its own, never the road\'s or a real one', async () => {
  worker.length = 0; const f = apiFetch({ now: () => 1e12 });
  await f('https://api.test/confidential/relay'); await f('https://api.test/confidential/status?id=0x01'); await f('https://api.test/confidential/relay');
  const ips = worker.map((w) => w.ip);
  assert.equal(new Set(ips).size, 3, 'three envelopes, three addresses');
  assert.ok(ips.every((ip) => /^fd00:/.test(ip)), ips.join(' '));
  assert.ok(!ips.some((ip) => ip.includes('127.0.0.9') || ip.includes('127.0.0.1')));
});

await check('with the relay gone too the request still reaches the API, directly', async () => {
  await relay.close(); worker.length = 0; direct.length = 0;
  const f = apiFetch({ now: () => 2e12 });
  const r = await f('https://api.test/confidential/relay');
  assert.deepEqual(await r.json(), { direct: true }); assert.equal(direct.length, 1);
});

globalThis.fetch = realFetch; road.stop(); srv.close();
console.log(`\n${n} checks passed`);
process.exit(0);
