#!/usr/bin/env node
// The relay API's private route (server/sealed-api.mjs) through the real server harness: a sealed request is answered by the API's handler, counted under an address made from the
// forwarder's token (never a real one), believed only from a listed forwarder, and limited to what a page asks of the relay. Run: node tests/server-sealed-api.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTacitServer } from '../server/harness.mjs';
import { makeApiSealed, senderAddress, API_CARRIED } from '../server/sealed-api.mjs';
import { newGatewayKey, gatewayKeys, sealRequest } from '../dapp/sealed-request.js';

process.env.TRUST_PROXY = '1';
let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };

const secret = newGatewayKey(), PUB = Buffer.from(gatewayKeys(secret).pub).toString('hex');
const seen = [];
const workerModule = { fetch: async (req) => { const u = new URL(req.url); seen.push({ path: u.pathname + u.search, ip: req.headers.get('CF-Connecting-IP') }); return new Response(JSON.stringify({ ok: true, path: u.pathname, ip: req.headers.get('CF-Connecting-IP') }), { headers: { 'content-type': 'application/json' } }); } };
const env = {};
const sealed = makeApiSealed({ env, secret, forwarders: ['198.51.100.7'], log: (m) => console.log('LOG', m) });
const ctxFactory = { makeCtx: () => ({ waitUntil() {}, passThroughOnException() {} }), pending: new Set() };
const driver = { get: async () => null };
const srv = createTacitServer({ workerModule, env, driver, ctxFactory, sealed });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const post = (path, body, headers) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-length': body.length, ...headers } }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c) })); });
  r.on('error', reject); r.end(body);
});
const get = (path, headers = {}) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path, headers }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: String(Buffer.concat(c)) })); }).on('error', reject); });
// a sealed request, as a forwarder passes it on (`from` is the forwarder's address as the edge reports it)
const ask = async (req, { from = '198.51.100.7', token = null } = {}) => {
  const sl = await sealRequest(PUB, req);
  const r = await post('/sealed', Buffer.from(sl.bytes), { 'true-client-ip': from, ...(token ? { 'x-tacit-sender': token } : {}) });
  assert.equal(r.status, 200, `the envelope was taken (${r.status} ${String(r.body).slice(0, 80)})`);
  const out = await sl.open(new Uint8Array(r.body));
  return { status: out.status, body: out.body.length ? JSON.parse(Buffer.from(out.body).toString()) : null };
};

await check('a carried request is answered, and the API counts it under an address made from the token', async () => {
  seen.length = 0;
  const r = await ask({ method: 'GET', path: '/confidential/quote?asset=cETH&amountWei=1000' }, { token: 'a1b2c3d4e5f6' });
  assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  assert.equal(seen[0].path, '/confidential/quote?asset=cETH&amountWei=1000');
  assert.equal(seen[0].ip, 'fd00:a1b2:c3d4:e5f6::/64', 'the worker saw the token\'s address, as the /64 it counts an IPv6 caller by');
  assert.ok(!JSON.stringify(seen).includes('198.51.100.7'), 'and not the forwarder\'s');
});

await check('two tokens are two senders, one token is one sender', async () => {
  seen.length = 0;
  for (const t of ['111111111111', '111111111111', '222222222222']) await ask({ method: 'GET', path: '/confidential/relay' }, { token: t });
  assert.equal(seen[0].ip, seen[1].ip); assert.notEqual(seen[0].ip, seen[2].ip);
  assert.equal(senderAddress('111111111111'), 'fd00:1111:1111:1111::1');
});

await check('a token is believed only from a listed forwarder; anyone else is counted under the address they came from', async () => {
  seen.length = 0;
  await ask({ method: 'GET', path: '/confidential/relay' }, { from: '203.0.113.9', token: 'abcdefabcdef' });
  assert.equal(seen[0].ip, '203.0.113.9', 'a forged token changed nothing');
  await ask({ method: 'GET', path: '/confidential/relay' }, { from: '198.51.100.7', token: 'not-a-token' });
  assert.equal(seen[1].ip, '198.51.100.7', 'a listed forwarder with a bad token is its own address');
  await ask({ method: 'GET', path: '/confidential/relay' }, { from: '198.51.100.7' });
  assert.equal(seen[2].ip, '198.51.100.7', 'and with none');
});

await check('a submission is carried with its body, and what the relay\'s own services call is not carried', async () => {
  seen.length = 0;
  const sub = await ask({ method: 'POST', path: '/confidential/submit', body: { type: 'swap', op: {} } }, { token: '333333333333' });
  assert.equal(sub.status, 200); assert.equal(seen[0].path, '/confidential/submit');
  for (const [m, p] of [['GET', '/confidential/job'], ['POST', '/confidential/ack'], ['POST', '/confidential/refresh'], ['GET', '/confidential/queue'], ['GET', '/stats'], ['GET', '/prover/pool/stats'], ['POST', '/confidential/requeue']]) {
    const r = await ask({ method: m, path: p, ...(m === 'POST' ? { body: {} } : {}) }, { token: '333333333333' });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  assert.equal(seen.length, 1, 'none of those reached the handler');
});

await check('a request that is not sealed goes to the handler as it always did, and /sealed/key is public', async () => {
  seen.length = 0;
  const r = await get('/stats', { 'true-client-ip': '203.0.113.5' });
  assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).ip, '203.0.113.5');
  const k = await get('/sealed/key');
  assert.equal(k.status, 200);
});

await check('the carried list is a page\'s side of the relay, and nothing with a box token', () => {
  const text = API_CARRIED.map(([m, re]) => `${m} ${re.source}`).join(' ');
  for (const bad of ['ack', 'job', 'queue', 'refresh', 'requeue', 'wake', 'ledger']) assert.ok(!new RegExp(`confidential\\\\/[^ ]*\\b${bad}\\b`).test(text.replace(/\(status\|quote\|relay\|open\|index\|armed\)/, '')), `${bad} is not carried`);
});

srv.close();
console.log(`\n${n} checks passed`);
process.exit(0);
