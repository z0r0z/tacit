// The private route's envelope (dapp/sealed-request.js): a request sealed to a keeper's gateway key and its reply, and the
// fetch a wallet gets for it.
//   node tests/sealed-request.test.mjs
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { gatewayKeys, newGatewayKey, sealRequest, openRequest, makeSealedFetch, SealedError, REQUEST_OVERHEAD, CLOCK_WINDOW, MAX_BATCH } from '../dapp/sealed-request.js';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const te = new TextEncoder();
const hex = (b) => Buffer.from(b).toString('hex');
const has = (bytes, text) => Buffer.from(bytes).includes(Buffer.from(text));
const T = 1_800_000_000;
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

const SECRET = 'a1'.repeat(32);
const keys = gatewayKeys(SECRET);
const PUB = hex(keys.pub);
const relay = { method: 'POST', path: '/relay', body: { tx: { recipient: '0xabc', marker: 'distinctive-marker-12345' }, reservation: null } };

await check('a gateway key gives a fixed public key and key id, and only a 32-byte scalar in range is a key', () => {
  assert.equal(PUB, hex(gatewayKeys('0x' + SECRET).pub));
  assert.equal(keys.pub.length, 33);
  assert.equal(keys.kid.length, 4);
  assert.notEqual(hex(gatewayKeys('b2'.repeat(32)).kid), hex(keys.kid));
  for (const bad of ['', 'zz'.repeat(32), 'a1'.repeat(31), '00'.repeat(32), 'ff'.repeat(32)]) assert.throws(() => gatewayKeys(bad), SealedError, bad.slice(0, 8));
  assert.match(newGatewayKey(), /^[0-9a-f]{64}$/);
  assert.notEqual(newGatewayKey(), newGatewayKey());
});

await check('a request opens at the gateway as it was sealed, and the reply opens at the caller', async () => {
  const sealed = await sealRequest(PUB, relay, { now: () => T });
  assert.equal(sealed.bytes[0], 2, 'version 2: AES-256-GCM');
  const opened = await openRequest(keys, sealed.bytes, { now: () => T });
  assert.deepEqual([opened.method, opened.path, opened.body], ['POST', '/relay', relay.body]);
  const reply = await opened.reply(200, { 'content-type': 'application/json', 'retry-after': '10' }, te.encode('{"txHash":"0x1"}'));
  const got = await sealed.open(reply);
  assert.equal(got.status, 200);
  assert.deepEqual(got.headers, { 'content-type': 'application/json', 'retry-after': '10' });
  assert.equal(Buffer.from(got.body).toString(), '{"txHash":"0x1"}');
  const bare = await openRequest(keys, (await sealRequest(PUB, { method: 'GET', path: '/quote?gas=700000' }, { now: () => T })).bytes, { now: () => T });
  assert.deepEqual([bare.method, bare.path, bare.body], ['GET', '/quote?gas=700000', null]);
});

await check('requests are padded to a few sizes, so an envelope does not say which request it holds', async () => {
  const size = async (r) => (await sealRequest(PUB, r, { now: () => T })).bytes.length;
  const small = await size({ method: 'GET', path: '/head' });
  assert.equal(small, 4096 + REQUEST_OVERHEAD);
  assert.equal(await size({ method: 'GET', path: '/quote?gas=700000' }), small);
  assert.equal(await size(relay), small);
  assert.equal(await size({ method: 'POST', path: '/relay', body: { pad: 'x'.repeat(5000) } }), 8192 + REQUEST_OVERHEAD);
  assert.equal(await size({ method: 'POST', path: '/relay', body: { pad: 'x'.repeat(60000) } }), 65536 + REQUEST_OVERHEAD);
  await assert.rejects(size({ method: 'POST', path: '/relay', body: { pad: 'x'.repeat(70000) } }), /too large/);
});

await check('the envelope shows nothing of the request, and two seals of one request differ throughout', async () => {
  const a = (await sealRequest(PUB, relay, { now: () => T })).bytes, b = (await sealRequest(PUB, relay, { now: () => T })).bytes;
  for (const text of ['/relay', 'POST', 'recipient', 'distinctive-marker-12345', '0xabc', '"tx"']) assert.ok(!has(a, text), text);
  assert.notDeepEqual(a.subarray(5, 38), b.subarray(5, 38), 'a new one-time key each time');
  let same = 0;
  for (let i = 54; i < a.length - 16; i++) if (a[i] === b[i]) same++;
  assert.ok(same < (a.length - 70) * 0.02, `${same} of ${a.length - 70} bytes equal`);
});

await check('a changed byte anywhere in a request is refused, and a refusal says no more than that', async () => {
  const sealed = (await sealRequest(PUB, relay, { now: () => T })).bytes;
  const at = [0, 1, 4, 5, 20, 37, 38, 53, 54, 55, 1000, 2000, sealed.length - 17, sealed.length - 16, sealed.length - 1];
  for (const i of at) {
    const bad = Uint8Array.from(sealed);
    bad[i] ^= 1;
    await assert.rejects(openRequest(keys, bad, { now: () => T }), (e) => e instanceof SealedError && e.message === 'not a request', `byte ${i}`);
  }
  await assert.rejects(openRequest(keys, sealed.subarray(0, sealed.length - 1), { now: () => T }), SealedError);
  await assert.rejects(openRequest(keys, new Uint8Array(10), { now: () => T }), SealedError);
  await assert.rejects(openRequest(keys, concat(sealed, new Uint8Array(70000)), { now: () => T }), SealedError);
  const v1 = Uint8Array.from(sealed);
  v1[0] = 1;
  await assert.rejects(openRequest(keys, v1, { now: () => T }), /not a request/, 'the earlier cipher\'s version is refused');
});

await check('a request is opened only by the gateway it was sealed to', async () => {
  const sealed = (await sealRequest(PUB, relay, { now: () => T })).bytes;
  await assert.rejects(openRequest(gatewayKeys('b2'.repeat(32)), sealed, { now: () => T }), SealedError);
  const other = gatewayKeys('c3'.repeat(32));
  const forOther = (await sealRequest(hex(other.pub), relay, { now: () => T })).bytes;
  await assert.rejects(openRequest(keys, forOther, { now: () => T }), SealedError);
  await openRequest(other, forOther, { now: () => T });
  await assert.rejects(sealRequest('02' + '00'.repeat(32), relay), SealedError);
});

await check('a request is single use and must be within a few minutes of the gateway\'s clock', async () => {
  const seen = new Set();
  const once = (id) => (seen.has(id) ? false : (seen.add(id), true));
  const sealed = (await sealRequest(PUB, relay, { now: () => T })).bytes;
  await openRequest(keys, sealed, { now: () => T, seen: once });
  await assert.rejects(openRequest(keys, sealed, { now: () => T, seen: once }), /seen/);
  const old = (await sealRequest(PUB, relay, { now: () => T - CLOCK_WINDOW - 1 })).bytes;
  await assert.rejects(openRequest(keys, old, { now: () => T }), /clock/);
  const future = (await sealRequest(PUB, relay, { now: () => T + CLOCK_WINDOW + 1 })).bytes;
  await assert.rejects(openRequest(keys, future, { now: () => T }), /clock/);
  const edge = (await sealRequest(PUB, relay, { now: () => T - CLOCK_WINDOW })).bytes;
  await openRequest(keys, edge, { now: () => T });
  const tamperedOld = Uint8Array.from(old);
  tamperedOld[100] ^= 1;
  const probe = new Set();
  await assert.rejects(openRequest(keys, tamperedOld, { now: () => T, seen: (id) => { probe.add(id); return true; } }), SealedError);
  assert.equal(probe.size, 0, 'a request that fails its tag is not remembered');
  // The same envelope handed to the gateway twice at once is opened once.
  const twice = (await sealRequest(PUB, relay, { now: () => T })).bytes, once2 = new Set();
  const results = await Promise.allSettled([1, 2].map(() => openRequest(keys, twice, { now: () => T, seen: (id) => (once2.has(id) ? false : (once2.add(id), true)) })));
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
});

await check('a reply is padded, opens only for its own request, and is new each time it is made', async () => {
  const a = await sealRequest(PUB, relay, { now: () => T }), b = await sealRequest(PUB, relay, { now: () => T });
  const opened = await openRequest(keys, a.bytes, { now: () => T });
  const r1 = await opened.reply(200, {}, te.encode('{}')), r2 = await opened.reply(200, {}, te.encode('{}'));
  assert.equal(r1.length, 1 + 16 + 1024 + 16);
  assert.notDeepEqual(r1, r2, 'a fresh nonce per reply');
  assert.equal(Buffer.from((await a.open(r1)).body).toString(), '{}');
  assert.equal(Buffer.from((await a.open(r2)).body).toString(), '{}');
  await assert.rejects(b.open(r1), SealedError);
  for (const i of [0, 1, 17, 500, r1.length - 1]) { const x = Uint8Array.from(r1); x[i] ^= 1; await assert.rejects(a.open(x), SealedError, `byte ${i}`); }
  assert.equal((await opened.reply(200, {}, new Uint8Array(3000))).length, 1 + 16 + 4096 + 16);
  assert.equal((await opened.reply(200, {}, new Uint8Array(30000))).length, 1 + 16 + 65536 + 16);
  assert.equal((await opened.reply(200, {}, new Uint8Array(70000))).length, 1 + 16 + 131072 + 16);
  await assert.rejects(opened.reply(200, {}, new Uint8Array(9 << 20)), /too large/);
});

await check('a compressed reply is expanded at the caller, and its length is hidden the same way', async () => {
  const text = JSON.stringify({ events: Array.from({ length: 400 }, (_, i) => ({ block: i, memo: 'ab'.repeat(65) })) });
  const sealed = await sealRequest(PUB, { method: 'GET', path: '/events?from=1' }, { now: () => T });
  const opened = await openRequest(keys, sealed.bytes, { now: () => T });
  const z = gzipSync(text);
  assert.ok(z.length < text.length / 4);
  const reply = await opened.reply(200, { 'content-type': 'application/json' }, z, { gzip: true });
  assert.equal((reply.length - 33) % 1024, 0);
  const got = await sealed.open(reply);
  assert.equal(Buffer.from(got.body).toString(), text);
});

await check('a page of a million bytes is sealed and opened whole, and sealing it does not hold up the event loop', async () => {
  const body = Buffer.alloc(1_000_000);
  for (let i = 0; i < body.length; i += 65536) globalThis.crypto.getRandomValues(body.subarray(i, Math.min(body.length, i + 65536)));
  const sealed = await sealRequest(PUB, { method: 'GET', path: '/events?from=1' }, { now: () => T });
  const opened = await openRequest(keys, sealed.bytes, { now: () => T });
  let last = performance.now(), worst = 0;
  const tick = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last); last = t; }, 2);
  let reply;
  for (let i = 0; i < 6; i++) reply = await opened.reply(200, {}, body);
  worst = Math.max(worst, performance.now() - last);   // a loop that never ran the timer shows up in this last gap
  clearInterval(tick);
  assert.ok(worst < 150, `the loop was held ${worst.toFixed(0)} ms`);
  assert.equal(reply.length, 1 + 16 + Math.ceil((4 + 32 + body.length) / 65536) * 65536 + 16);
  const got = await sealed.open(reply);
  assert.equal(got.status, 200);
  assert.ok(Buffer.from(got.body).equals(body), 'every byte');
});

await check('a list of requests is sealed in one envelope and answered with one answer each, in order', async () => {
  const reqs = [
    { method: 'GET', path: '/1/evm-pool/keeper/quote' },
    { method: 'GET', path: '/8453/evm-pool/keeper/events?from=51864014&facts=1' },
    { method: 'POST', path: '/1/evm-pool/keeper/receive', body: { chainId: 1, npk: '123' } },
  ];
  const sealed = await sealRequest(PUB, reqs, { now: () => T });
  assert.equal(sealed.bytes.length, 4096 + REQUEST_OVERHEAD, 'the same size as a request alone');
  const opened = await openRequest(keys, sealed.bytes, { now: () => T });
  assert.equal(opened.batch, true);
  assert.deepEqual(opened.requests, [
    { method: 'GET', path: '/1/evm-pool/keeper/quote', body: null },
    { method: 'GET', path: '/8453/evm-pool/keeper/events?from=51864014&facts=1', body: null },
    { method: 'POST', path: '/1/evm-pool/keeper/receive', body: { chainId: 1, npk: '123' } },
  ]);
  const z = gzipSync('x'.repeat(5000));
  const reply = await opened.replyMany([
    { status: 200, headers: { 'content-type': 'application/json' }, body: te.encode('{"fee":"1"}'), gzip: false },
    { status: 429, headers: { 'retry-after': '10' }, body: new Uint8Array(0), gzip: false },
    { status: 200, headers: {}, body: z, gzip: true },
  ]);
  const got = await sealed.open(reply);
  assert.equal(got.length, 3);
  assert.deepEqual([got[0].status, got[1].status, got[2].status], [200, 429, 200]);
  assert.equal(Buffer.from(got[0].body).toString(), '{"fee":"1"}');
  assert.equal(got[1].body.length, 0);
  assert.equal(got[1].headers['retry-after'], '10');
  assert.equal(Buffer.from(got[2].body).toString(), 'x'.repeat(5000));
  await assert.rejects(opened.replyMany([{ status: 200, headers: {}, body: te.encode('{}'), gzip: false }]), /one answer for each/);
  // a request alone is still opened and answered as before
  const one = await openRequest(keys, (await sealRequest(PUB, reqs[0], { now: () => T })).bytes, { now: () => T });
  assert.equal(one.batch, false);
  assert.equal(one.requests.length, 1);
});

await check('an envelope carries one to MAX_BATCH requests, and a reply of the wrong shape is refused at the caller', async () => {
  await assert.rejects(sealRequest(PUB, [], { now: () => T }), /1 to 24/);
  await assert.rejects(sealRequest(PUB, Array.from({ length: MAX_BATCH + 1 }, () => ({ method: 'GET', path: '/head' })), { now: () => T }), /1 to 24/);
  const full = await sealRequest(PUB, Array.from({ length: MAX_BATCH }, (_, i) => ({ method: 'GET', path: `/8453-xfde4c96c85/evm-pool/keeper/events?from=${51864014 + i}&facts=1` })), { now: () => T });
  assert.equal(full.bytes.length, 4096 + REQUEST_OVERHEAD, 'twenty-four reads still fit the smallest size');
  assert.equal((await openRequest(keys, full.bytes, { now: () => T })).requests.length, MAX_BATCH);
  // a single answer for a list, and a list for a single request, are both refused
  const pair = await sealRequest(PUB, [{ method: 'GET', path: '/a' }, { method: 'GET', path: '/b' }], { now: () => T });
  const openedPair = await openRequest(keys, pair.bytes, { now: () => T });
  await assert.rejects(pair.open(await openedPair.reply(200, {}, te.encode('{}'))), /not a reply/);
  const alone = await sealRequest(PUB, { method: 'GET', path: '/a' }, { now: () => T });
  const openedAlone = await openRequest(keys, alone.bytes, { now: () => T });
  await assert.rejects(alone.open(await openedAlone.reply(200, {}, te.encode('{}'))).then((r) => { assert.equal(r.status, 200); throw new SealedError('fine'); }), /fine/);
});

// A forwarder that opens each envelope at a gateway in this process and answers every request in it with `handler(request)`.
function batchGateway({ handler = (r) => ({ body: JSON.stringify({ path: r.path }) }), hold = () => null } = {}) {
  const log = [], seen = new Set();
  const f = async (url, init) => {
    const opened = await openRequest(keys, init.body, { now: () => T, seen: (id) => (seen.has(id) ? false : (seen.add(id), true)) });
    log.push({ url, requests: opened.requests, at: Date.now() });
    await hold(opened.requests);
    const parts = await Promise.all(opened.requests.map(async (r) => {
      const a = await handler(r);
      return { status: a.status ?? 200, headers: a.headers ?? { 'content-type': 'application/json' }, body: te.encode(a.body ?? '{}'), gzip: false };
    }));
    const reply = opened.batch ? await opened.replyMany(parts) : await opened.reply(parts[0].status, parts[0].headers, parts[0].body);
    return new Response(reply, { status: 200 });
  };
  return { f, log };
}
const sealedFetch = (g, extra = {}) => makeSealedFetch({ keeper: 'https://k.test', chainId: 'k', gateway: PUB, forwarders: ['https://f.test'], fetchImpl: g.f, now: () => T, batchMs: 40, ...extra });

await check('reads made together share envelopes, each caller gets its own answer, and the first one is not held back', async () => {
  const g = batchGateway();
  const sf = sealedFetch(g);
  const paths = Array.from({ length: 24 }, (_, i) => `/${i % 3 ? '1' : '8453'}/evm-pool/keeper/${i % 2 ? 'quote' : 'events'}?n=${i}`);
  const t0 = Date.now();
  const answers = await Promise.all(paths.map((p) => sf(`https://k.test${p}`).then((r) => r.json())));
  assert.deepEqual(answers.map((a) => a.path), paths, 'every caller has the answer to its own request');
  assert.ok(g.log.length <= 3, `${g.log.length} envelopes for 24 reads`);
  assert.equal(g.log[0].requests.length, 1, 'the first read went out alone, at once');
  assert.equal(g.log.reduce((a, e) => a + e.requests.length, 0), 24);
  assert.ok(g.log.every((e) => e.requests.length <= 16), 'no envelope above maxBatch');
  assert.ok(Date.now() - t0 < 400, 'and the wait behind it was bounded');
});

await check('a read that follows another one waits for nothing, so a page after a page costs no more than it did', async () => {
  const g = batchGateway();
  const sf = sealedFetch(g, { batchMs: 500 });
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) assert.equal((await sf(`https://k.test/1/evm-pool/keeper/events?from=${i}`)).status, 200);
  assert.equal(g.log.length, 12, 'one envelope each');
  assert.ok(Date.now() - t0 < 400, `twelve in a row took ${Date.now() - t0} ms against a window of 500`);
});

await check('a write goes alone and at once, and neither it nor a read held behind it waits for the other', async () => {
  let releaseRelay;
  const relayHeld = new Promise((r) => { releaseRelay = r; });
  const g = batchGateway({ hold: async (rs) => { if (rs.some((r) => r.method === 'POST')) await relayHeld; } });
  const sf = sealedFetch(g, { batchMs: 30 });
  const write = sf('https://k.test/1/evm-pool/keeper/relay', { method: 'POST', body: JSON.stringify({ tx: 1 }) });
  const reads = await Promise.all(['quote', 'head', 'info'].map((r) => sf(`https://k.test/1/evm-pool/keeper/${r}`).then((x) => x.json())));
  assert.deepEqual(reads.map((r) => r.path), ['/1/evm-pool/keeper/quote', '/1/evm-pool/keeper/head', '/1/evm-pool/keeper/info'], 'the reads were answered while the relay was still waiting');
  const post = g.log.find((e) => e.requests.some((r) => r.method === 'POST'));
  assert.equal(post.requests.length, 1, 'the write was alone in its envelope');
  releaseRelay();
  assert.equal((await write).status, 200);
});

await check('a caller that gives up stops waiting alone, and the envelope goes without it', async () => {
  const g = batchGateway();
  const sf = sealedFetch(g, { batchMs: 60 });
  const first = sf('https://k.test/1/evm-pool/keeper/head');   // leaves at once
  const ctl = new AbortController();
  const quits = sf('https://k.test/1/evm-pool/keeper/quote', { signal: ctl.signal });
  const stays = sf('https://k.test/1/evm-pool/keeper/info');
  ctl.abort();
  await assert.rejects(quits, (e) => e.name === 'AbortError');
  assert.equal((await stays).status, 200);
  assert.equal((await first).status, 200);
  const sent = g.log.flatMap((e) => e.requests.map((r) => r.path));
  assert.ok(!sent.includes('/1/evm-pool/keeper/quote'), 'the aborted read was not sent');
  const pre = new AbortController(); pre.abort();
  await assert.rejects(sf('https://k.test/1/evm-pool/keeper/head', { signal: pre.signal }), (e) => e.name === 'AbortError');
});

await check('an envelope that fails fails every request in it after trying the other forwarder, and each try is a new envelope', async () => {
  const g = batchGateway();
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(url); if (url.startsWith('https://down.test')) throw new Error('connection refused'); return g.f(url, init); };
  const sf = makeSealedFetch({ keeper: 'https://k.test', chainId: 'k', gateway: PUB, forwarders: ['https://down.test', 'https://up.test'], fetchImpl, now: () => T, batchMs: 30 });
  const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => sf(`https://k.test/1/evm-pool/keeper/events?from=${i}`).then((r) => r.json())));
  assert.equal(answers.length, 6);
  assert.ok(calls.some((u) => u.startsWith('https://up.test')));
  const dead = makeSealedFetch({ keeper: 'https://k.test', chainId: 'k', gateway: PUB, forwarders: ['https://down.test'], fetchImpl, now: () => T, batchMs: 30 });
  const results = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => dead(`https://k.test/1/evm-pool/keeper/events?from=${i}`)));
  assert.ok(results.every((r) => r.status === 'rejected' && /refused/.test(r.reason.message)), 'all four fail');
});

await check('an answer too large to share an envelope is asked for again by itself', async () => {
  let asks = 0;
  const g = batchGateway({ handler: (r) => {
    if (!/events/.test(r.path)) return { body: '{"ok":true}' };
    asks++;
    return asks === 1 ? { status: 502, headers: { 'content-type': 'application/json', 'x-sealed': 'alone' }, body: '{"error":"too large"}' } : { body: '{"events":"the whole page"}' };
  } });
  const sf = sealedFetch(g, { batchMs: 30 });
  const head = sf('https://k.test/1/evm-pool/keeper/head');
  const page = sf('https://k.test/1/evm-pool/keeper/events?from=1');
  const info = sf('https://k.test/1/evm-pool/keeper/info');
  const [h, p, i] = await Promise.all([head, page, info]);
  assert.equal(h.status, 200); assert.equal(i.status, 200);
  assert.equal(p.status, 200, 'the caller sees the page, not the marker');
  assert.deepEqual(await p.json(), { events: 'the whole page' });
  assert.equal(g.log.filter((e) => e.requests.length === 1 && /events/.test(e.requests[0].path)).length >= 1, true, 'and it was asked for again alone');
});

await check('an answer with a status that carries no body is still a response, alone or in a burst', async () => {
  const g = batchGateway({ handler: (r) => (/nothing/.test(r.path) ? { status: 204, headers: {}, body: '' } : { body: '{"ok":true}' }) });
  const sf = sealedFetch(g, { batchMs: 30 });
  const [a, b, c] = await Promise.all([sf('https://k.test/1/evm-pool/keeper/head'), sf('https://k.test/1/evm-pool/keeper/nothing'), sf('https://k.test/1/evm-pool/keeper/info')]);
  assert.deepEqual([a.status, b.status, c.status], [200, 204, 200]);
  assert.equal(await b.text(), '');
  assert.deepEqual(await c.json(), { ok: true });
  assert.equal((await sf('https://k.test/1/evm-pool/keeper/nothing')).status, 204);
});

await check('a burst is capped at maxBatch, and batchMs 0 sends every request alone', async () => {
  const g = batchGateway();
  const sf = sealedFetch(g, { maxBatch: 5, batchMs: 200 });
  await Promise.all(Array.from({ length: 20 }, (_, i) => sf(`https://k.test/1/evm-pool/keeper/events?from=${i}`)));
  assert.ok(g.log.every((e) => e.requests.length <= 5), g.log.map((e) => e.requests.length).join(','));
  assert.equal(g.log.reduce((a, e) => a + e.requests.length, 0), 20);
  const g2 = batchGateway();
  const alone = sealedFetch(g2, { batchMs: 0 });
  await Promise.all(Array.from({ length: 6 }, (_, i) => alone(`https://k.test/1/evm-pool/keeper/events?from=${i}`)));
  assert.equal(g2.log.length, 6);
});

// A forwarder that hands the bytes it is given to a gateway in this process.
function gateway({ seen = new Set(), status = 200, headers = {}, answer = (req) => te.encode(JSON.stringify({ path: req.path, method: req.method, body: req.body })) } = {}) {
  const log = [];
  const f = async (url, init) => {
    log.push({ url, init, bytes: init.body });
    const opened = await openRequest(keys, init.body, { now: () => T, seen: (id) => (seen.has(id) ? false : (seen.add(id), true)) });
    return new Response(await opened.reply(status, { 'content-type': 'application/json', ...headers }, answer(opened)), { status: 200 });
  };
  return { f, log };
}

await check('the sealed fetch answers like fetch, through a forwarder chosen at random, and says it is sealed', async () => {
  const g = gateway();
  const sf = makeSealedFetch({ keeper: 'https://k.test/1/evm-pool/keeper/', chainId: 1, gateway: PUB, forwarders: ['https://f1.test', 'https://f2.test/'], fetchImpl: g.f, now: () => T });
  assert.equal(sf.sealed, true);
  const r = await sf('https://k.test/1/evm-pool/keeper/quote?gas=700000');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { path: '/quote?gas=700000', method: 'GET', body: null });
  const p = await sf('https://k.test/1/evm-pool/keeper/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: { a: '1' } }) });
  assert.deepEqual(await p.json(), { path: '/relay', method: 'POST', body: { tx: { a: '1' } } });
  assert.match(g.log[0].url, /^https:\/\/f[12]\.test\/f\/1$/);
  assert.equal(g.log[0].init.method, 'POST');
  assert.ok(!has(g.log[0].bytes, 'quote') && !has(g.log[1].bytes, 'relay'), 'the forwarder is handed nothing readable');
  const used = new Set();
  for (let i = 0; i < 30; i++) { await sf('https://k.test/1/evm-pool/keeper/head'); used.add(new URL(g.log.at(-1).url).host); }
  assert.deepEqual([...used].sort(), ['f1.test', 'f2.test'], 'both forwarders are used');
});

await check('an answer keeps its status and Retry-After, so the wallet\'s own handling of a busy keeper still works', async () => {
  const g = gateway({ status: 429, headers: { 'retry-after': '10' }, answer: () => te.encode('{"error":"rate limited"}') });
  const sf = makeSealedFetch({ keeper: 'https://k.test/k', chainId: 1, gateway: PUB, forwarders: ['https://f1.test'], fetchImpl: g.f, now: () => T });
  const r = await sf('https://k.test/k/relay', { method: 'POST', body: '{}' });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '10');
  assert.deepEqual(await r.json(), { error: 'rate limited' });
});

await check('a forwarder that fails is passed over, a new envelope is sealed each try, and nothing falls back to a direct request', async () => {
  const seenBodies = [];
  const g = gateway();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    seenBodies.push(init.body);
    if (url.startsWith('https://down.test')) throw new Error('connection refused');
    if (url.startsWith('https://busy.test')) return new Response('busy', { status: 503 });
    if (url.startsWith('https://forged.test')) return new Response(new Uint8Array(4096 + 33).fill(7), { status: 200 });
    return g.f(url, init);
  };
  const sf = makeSealedFetch({ keeper: 'https://k.test/k', chainId: 8453, gateway: PUB, forwarders: ['https://down.test', 'https://busy.test', 'https://forged.test', 'https://ok.test'], fetchImpl, now: () => T });
  for (let i = 0; i < 6; i++) {
    calls.length = 0; seenBodies.length = 0;
    const r = await sf('https://k.test/k/head');
    assert.equal(r.status, 200);
    assert.equal(calls.at(-1), 'https://ok.test/f/8453', 'the working forwarder answers in the end');
    assert.ok(calls.every((u) => u.includes('/f/8453')), 'every request goes to a forwarder, none to the keeper');
    assert.equal(new Set(seenBodies.map((b) => hex(b.subarray(5, 38)))).size, seenBodies.length, 'a one-time key for each try');
  }
  const none = makeSealedFetch({ keeper: 'https://k.test/k', chainId: 1, gateway: PUB, forwarders: ['https://down.test', 'https://busy.test'], fetchImpl, now: () => T });
  await assert.rejects(none('https://k.test/k/head'), /503|refused/);
});

await check('a forwarder that says the envelope is bad is believed, not retried, and only the keeper\'s own URLs are carried', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('bad', { status: 400 }); };
  const sf = makeSealedFetch({ keeper: 'https://k.test/k', chainId: 1, gateway: PUB, forwarders: ['https://a.test', 'https://b.test'], fetchImpl, now: () => T });
  await assert.rejects(sf('https://k.test/k/head'), /400/);
  assert.equal(calls, 1);
  await assert.rejects(sf('https://other.test/k/head'), /own keeper/);
  await assert.rejects(sf('https://k.test/kk/head'), /own keeper/);
  assert.throws(() => makeSealedFetch({ keeper: 'https://k.test/k', chainId: 1, gateway: PUB, forwarders: [] }), /forwarder/);
  assert.throws(() => makeSealedFetch({ keeper: 'https://k.test/k', chainId: 1, gateway: '02' + '00'.repeat(32), forwarders: ['https://a.test'] }), SealedError);
});

console.log(`\n${n} checks passed`);
