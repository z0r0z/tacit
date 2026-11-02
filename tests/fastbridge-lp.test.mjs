// The LP service (fastbridge-lp/) end to end on the simulated Bitcoin and pool of the machine tests: the HTTP API on a real
// socket, quotes, the durable store, the explorer adapter against an esplora-shaped server, and a whole swap through all of
// it. The user's side speaks to the service with dapp/fastbridge-http.js, as the page will.
//   node tests/fastbridge-lp.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { realFetch } from './lib/real-fetch.mjs';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as rootSecp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import * as X from '../dapp/adaptor-xswap.js';
import { bigintToBytes32 } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { makeAdaptorBtcTx, tacitKit } from '../dapp/adaptor-btc-tx.js';
import { makeHttpCounter } from '../dapp/fastbridge-http.js';
import { fetched, tacit } from './lib/btc-sim.mjs';
import { pool, ASSET } from './lib/chain-sim.mjs';
import { startEsploraMock, decodeRawTx } from './lib/esplora-mock.mjs';
import { world, memStore, VALUE } from './lib/fastbridge-world.mjs';
import { makeLpService } from '../fastbridge-lp/lib/service.mjs';
import { makeHttpServer } from '../fastbridge-lp/lib/http.mjs';
import { makeFileStore, makeFileLogStore } from '../fastbridge-lp/lib/store.mjs';
import { makeFileStorage } from '../fastbridge-lp/lib/storage.mjs';
import { makeNodeBtcChain } from '../fastbridge-lp/lib/btc-chain.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ZERO32 = '0x' + '00'.repeat(32);
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const closers = [];
const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'fb-lp-')); dirs.push(d); return d; };

function configFor(w, { quote = {}, policy = {}, alertSecs } = {}) {
  return {
    claimPub: bytesToHex(w.lW.wallet.pub), csvBlocks: 144, alertSecs,
    quote: { btcAsset: bytesToHex(w.etch.asset), evmAsset: ASSET, minAmount: 1000, maxAmount: 1_000_000, feeBps: 0, flatFee: 0, validSecs: 3600, ...quote },
    policy: {
      minCsv: 72, minConfsFor: () => 1, evmWindowSecs: 4 * 3600, minClaimSecs: 3600, claimSlackSecs: 7200, roundSecs: 600, refundMarginSecs: 600,
      maxOfferAgeSecs: 3600, minAmount: 1000, maxAmount: 1_000_000, ...policy,
    },
  };
}

// The service on a socket of its own, driven by the world's clock: `w.lpTick` becomes its tick.
async function serve(w, { config = configFor(w), quoteStore = memStore(), swaps = w.lpStore, btc = w.lBtc, origins = ['*'], limits, maxBody, trustProxy } = {}) {
  const alerts = [], logs = [];
  const svc = makeLpService({ seed: w.lKeys.seed, btc, evm: w.lEvmCtx, swaps, quoteStore, config, now: w.clock.now, log: (o) => logs.push(o), alert: (o) => alerts.push(o) });
  await svc.start();
  const server = makeHttpServer({ handle: svc.handle, origins, ...(limits ? { limits } : {}), ...(maxBody ? { maxBody } : {}), ...(trustProxy ? { trustProxy } : {}) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const s = { svc, server, config, quoteStore, swaps, alerts, logs, base: `http://127.0.0.1:${server.address().port}` };
  s.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  closers.push(s.close);
  w.lpStore = swaps;
  w.lpTick = () => svc.tick();
  return s;
}

async function call(base, method, path, body, headers = {}) {
  const r = await realFetch(base + path, { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, headers: r.headers, text };
}

// a world whose user talks to whatever `ref.base` names, over HTTP
function httpWorld(opts = {}) {
  const ref = { base: null };
  const w = world({ funds: 0, userCounter: () => makeHttpCounter({ base: () => ref.base, fetchImpl: realFetch }), ...opts });
  return { w, ref };
}
const startSwap = (w, q) => w.userBl.start({ asset: w.etch.asset, amount: BigInt(q.btcValue), notes: [w.note], counterClaimPub: hexToBytes(q.claimPub), evmAsset: q.evmAsset, evmAmount: BigInt(q.evmAmount), quoteId: q.id });
const bothDone = (w) => async () => (await w.user())?.phase === 'done' && (await w.lp())?.phase === 'done';

// ── the API ──

test('/info and /health: the LP\'s terms, and 503 once a tick has failed', async () => {
  const { w } = httpWorld();
  const flaky = { failing: false };
  const inner = w.lpStore;
  const swaps = { get: (i) => inner.get(i), put: (r) => inner.put(r), list: async () => { if (flaky.failing) throw new Error('disk gone'); return inner.list(); } };
  const s = await serve(w, { swaps, config: configFor(w, { quote: { feeBps: 30, flatFee: 200 } }) });
  const info = await call(s.base, 'GET', '/info');
  assert.equal(info.status, 200);
  assert.equal(info.body.claimPub, bytesToHex(w.lW.wallet.pub));
  assert.equal(info.body.btcAsset, bytesToHex(w.etch.asset));
  assert.equal(info.body.evmAsset, ASSET);
  assert.deepEqual([info.body.minAmount, info.body.maxAmount, info.body.feeBps, info.body.flatFee, info.body.csvBlocks], ['1000', '1000000', 30, '200', 144]);
  assert.equal((await call(s.base, 'GET', '/health')).status, 200);
  flaky.failing = true;
  await s.svc.tick();
  const h = await call(s.base, 'GET', '/health');
  assert.equal(h.status, 503);
  assert.match(h.body.error, /disk gone/);
  flaky.failing = false;
  await s.svc.tick();
  assert.equal((await call(s.base, 'GET', '/health')).status, 200);
});

test('/quote: the fee is a share of the amount plus a flat part, within limits, and the quote is kept', async () => {
  const { w } = httpWorld();
  const s = await serve(w, { config: configFor(w, { quote: { feeBps: 30, flatFee: 200, minAmount: 1000, maxAmount: 100_000 } }) });
  const q = (await call(s.base, 'POST', '/quote', { amount: '5000' })).body;
  assert.equal(q.btcValue, '5000');
  assert.equal(q.evmAmount, String(5000 - (15 + 200)), 'fee = 30 bps of 5000 + 200');
  assert.equal(q.claimPub, bytesToHex(w.lW.wallet.pub));
  assert.match(q.id, /^[0-9a-f]{32}$/);
  assert.equal(q.validUntil, q.created + 3600);
  assert.equal(q.minConfs, 1);
  assert.deepEqual(await s.svc.quoter.get(q.id), q, 'the quote is stored');
  assert.equal(await s.svc.quoter.get('../../etc/passwd'), null, 'only a quote id is looked up');
  assert.equal(await s.svc.quoter.get('0'.repeat(32)), null);
  for (const [amount, re] of [['999', /between 1000 and 100000/], ['100001', /between/], ['12.5', /whole number/], ['-5', /whole number/], ['abc', /whole number/], [null, /whole number/]]) {
    const r = await call(s.base, 'POST', '/quote', { amount });
    assert.equal(r.status, 400, String(amount));
    assert.match(r.body.error, re);
  }
  assert.equal((await call(s.base, 'POST', '/quote', {})).status, 400);
  // a fee that eats the amount is refused
  const fat = await serve(w, { config: configFor(w, { quote: { flatFee: 2000, minAmount: 1000 } }) });
  const r = await call(fat.base, 'POST', '/quote', { amount: '1500' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /does not cover the fee/);
  // a rate converts what is left of the amount
  const half = await serve(w, { config: configFor(w, { quote: { feeBps: 0, flatFee: 0, rate: { num: 1, den: 2 } } }) });
  assert.equal((await call(half.base, 'POST', '/quote', { amount: '5000' })).body.evmAmount, '2500');
});

test('the number of confirmations asked for rises with the amount', async () => {
  const { w } = httpWorld();
  const s = await serve(w, { config: configFor(w, { policy: { minConfsFor: (v) => (BigInt(v) >= 10_000n ? 3 : 1) } }) });
  assert.equal((await call(s.base, 'POST', '/quote', { amount: '5000' })).body.minConfs, 1);
  assert.equal((await call(s.base, 'POST', '/quote', { amount: '50000' })).body.minConfs, 3);
});

test('malformed and unknown requests are answered with a reason and change nothing', async () => {
  const { w } = httpWorld();
  const s = await serve(w, { maxBody: 400, limits: { default: [1000, 1], offer: [1000, 1] } });
  const id = '0'.repeat(72);
  const cases = [
    ['POST', '/quote', '{not json', 400, /not JSON/],
    ['POST', '/offer', {}, 400, /quoteId and offer/],
    ['POST', '/offer', { quoteId: 'x', offer: 'no' }, 400, /quoteId and offer/],
    ['GET', `/swap/${id}`, undefined, 404, /unknown swap/],
    ['GET', `/swap/${id}/offer`, undefined, 404, /no offer yet/],
    ['GET', '/swap/xyz', undefined, 404, /not found/],
    ['GET', `/swap/${id}/extra`, undefined, 404, /not found/],
    ['POST', `/swap/${id}`, {}, 404, /not found/],
    ['GET', '/nothing', undefined, 404, /not found/],
    ['DELETE', '/info', undefined, 404, /not found/],
  ];
  for (const [method, path, body, status, re] of cases) {
    const r = typeof body === 'string'
      ? await realFetch(s.base + path, { method, headers: { 'content-type': 'application/json' }, body }).then(async (x) => ({ status: x.status, body: await x.json() }))
      : await call(s.base, method, path, body);
    assert.equal(r.status, status, `${method} ${path}`);
    assert.match(r.body.error, re, `${method} ${path}`);
  }
  // an offer the checks cannot read is an answer, not a server error
  for (const offer of [{}, { swapId: 'zz' }, { swapId: '0'.repeat(72) }, { swapId: '0'.repeat(72), btc: {}, evm: {} }]) {
    const r = await call(s.base, 'POST', '/offer', { quoteId: 'x'.repeat(32), offer });
    assert.equal(r.status, 200, JSON.stringify(offer));
    assert.equal(r.body.ok, false);
    assert.equal(r.body.retry, false);
    assert.ok(r.body.why);
  }
  assert.deepEqual(await w.lpStore.list(), [], 'nothing was stored');
  // a body over the limit is refused as such, whether its length is declared or not
  const big = { quoteId: 'a'.repeat(32), offer: { filler: 'x'.repeat(2000) } };
  const r1 = await call(s.base, 'POST', '/offer', big);
  assert.equal(r1.status, 413);
  const r2 = await realFetch(s.base + '/offer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(big))); c.close(); } }), duplex: 'half' }).then((x) => x.status);
  assert.equal(r2, 413, 'a chunked body is counted as it arrives');
  assert.equal((await call(s.base, 'GET', '/health')).status, 200, 'the server is still answering');
});

test('CORS: a page named in origins is answered, others get nothing, the preflight is answered', async () => {
  const { w } = httpWorld();
  const s = await serve(w, { origins: ['https://tacit.finance'] });
  const ok = await call(s.base, 'GET', '/info', undefined, { origin: 'https://tacit.finance' });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://tacit.finance');
  assert.equal(ok.headers.get('vary'), 'origin');
  const other = await call(s.base, 'GET', '/info', undefined, { origin: 'https://evil.example' });
  assert.equal(other.status, 200);
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  const none = await call(s.base, 'GET', '/info');
  assert.equal(none.headers.get('access-control-allow-origin'), null);
  const pre = await realFetch(s.base + '/offer', { method: 'OPTIONS', headers: { origin: 'https://tacit.finance', 'access-control-request-method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://tacit.finance');
  const pre2 = await realFetch(s.base + '/offer', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
  assert.equal(pre2.status, 204);
  assert.equal(pre2.headers.get('access-control-allow-origin'), null);
  const star = await serve(w, { origins: ['*'] });
  assert.equal((await call(star.base, 'GET', '/info', undefined, { origin: 'https://anything.example' })).headers.get('access-control-allow-origin'), 'https://anything.example');
});

test('rate limits: a bucket per client and kind, offers having the smaller one', async () => {
  const { w } = httpWorld();
  const s = await serve(w, { limits: { default: [3, 3600], offer: [2, 3600] } });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await call(s.base, 'GET', '/health')).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  const offers = [];
  for (let i = 0; i < 3; i++) offers.push((await call(s.base, 'POST', '/offer', { quoteId: 'x'.repeat(32), offer: {} })).status);
  assert.deepEqual(offers, [200, 200, 429], 'offers are counted apart from the rest');
  // behind a proxy the client is the address the proxy reports
  const p = await serve(w, { limits: { default: [1, 3600], offer: [1, 3600] }, trustProxy: true });
  assert.equal((await call(p.base, 'GET', '/health', undefined, { 'x-forwarded-for': '10.0.0.1' })).status, 200);
  assert.equal((await call(p.base, 'GET', '/health', undefined, { 'x-forwarded-for': '10.0.0.1' })).status, 429);
  assert.equal((await call(p.base, 'GET', '/health', undefined, { 'x-forwarded-for': '10.0.0.2, 10.9.9.9' })).status, 200);
  // without trustProxy the header changes nothing
  const q = await serve(w, { limits: { default: [1, 3600], offer: [1, 3600] } });
  assert.equal((await call(q.base, 'GET', '/health', undefined, { 'x-forwarded-for': '10.0.0.1' })).status, 200);
  assert.equal((await call(q.base, 'GET', '/health', undefined, { 'x-forwarded-for': '10.0.0.2' })).status, 429);
  // the counter turns a limit into a retry, not a refusal
  const counter = makeHttpCounter({ base: s.base, fetchImpl: realFetch });
  assert.deepEqual(await counter.sendOffer({ quoteId: 'x'.repeat(32), offer: {} }), { ok: false, retry: true, why: 'the liquidity provider is busy' });
});

// ── a swap through the service ──

test('a swap over HTTP: quote, offer, the pool lock, the claim and the take, the fee kept by the LP', async () => {
  const { w, ref } = httpWorld();
  const net = 5000n - (5000n * 30n) / 10000n - 200n;
  w.lEvm.fund(net, 'net');
  const s = await serve(w, { config: configFor(w, { quote: { feeBps: 30, flatFee: 200 } }) });
  ref.base = s.base;
  const counter = makeHttpCounter({ base: s.base, fetchImpl: realFetch });
  assert.equal((await counter.info()).claimPub, bytesToHex(w.lW.wallet.pub));
  const q = await counter.quote(VALUE);
  assert.equal(q.evmAmount, String(net));
  const rec = await startSwap(w, q);
  await w.run(bothDone(w));
  const lp = await w.lp(), user = await w.user();
  assert.ok(lp.take && (await w.noteOf(lp.take.txid, 0)), 'the LP took the Bitcoin lock and holds a valid note');
  assert.equal(String(lp.offer.btc.value), '5000');
  assert.equal(String(lp.offer.evm.amount), String(net));
  const sec = X.deriveSwapSecrets({ seed: w.uKeys.seed, swapId: hexToBytes(rec.id) });
  const O = pool.commitXY(net, '0x' + bytesToHex(bigintToBytes32(sec.rOut)));
  assert.ok(w.poolHolds(pool.leaf(ASSET, O.cx, O.cy, pool.nkToOwner(w.uKeys.nkOut))), 'the user holds the net amount in the pool');
  assert.equal(user.takenBy, lp.take.txid);
  assert.equal(w.evm.locks.leaves.length, 1);
  assert.equal(w.evm.lockSpent.size, 1);
  // the API tells the same story
  const st = await counter.swapStatus(rec.id);
  assert.equal(st.phase, 'done');
  const offer = await counter.getEvmOffer(rec.id);
  assert.equal(strip(offer.lockLeaf), strip(lp.lock.lockLeaf));
  assert.equal(await counter.getEvmOffer('0'.repeat(72)), null);
  assert.equal(await counter.swapStatus('0'.repeat(72)), null);
  // the same offer posted again is the same swap
  const again = await call(s.base, 'POST', '/offer', { quoteId: q.id, offer: lp.offer });
  assert.equal(again.body.ok, true);
  assert.equal((await w.lpStore.list()).length, 1);
  assert.deepEqual(s.alerts, []);
  assert.equal((await call(s.base, 'GET', '/health')).status, 200);
  assert.ok(s.logs.some((l) => l.msg === 'swap' && l.to === 'done'));
});

test('the service restarts on its files: quotes, swaps and the pool lock\'s offer survive, and the swap finishes', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(VALUE, 'same-size');
  const dir = tmp();
  const swaps = makeFileStore(join(dir, 'swaps')), quoteStore = makeFileStore(join(dir, 'quotes'));
  let s = await serve(w, { swaps, quoteStore });
  ref.base = s.base;
  const q = await makeHttpCounter({ base: s.base, fetchImpl: realFetch }).quote(VALUE);
  const rec = await startSwap(w, q);
  // the LP goes down and comes back before the user's lock has confirmed: the quote is found on disk
  await s.close(); s = await serve(w, { swaps: makeFileStore(join(dir, 'swaps')), quoteStore: makeFileStore(join(dir, 'quotes')) });
  ref.base = s.base;
  await w.run(async () => (await w.lp())?.phase === 'offered');
  const before = await w.lp();
  assert.ok(before.lock.lockLeaf);
  // and again once the pool lock exists: its offer is served from the record
  await s.close(); s = await serve(w, { swaps: makeFileStore(join(dir, 'swaps')), quoteStore: makeFileStore(join(dir, 'quotes')) });
  ref.base = s.base;
  const offer = await call(s.base, 'GET', `/swap/${rec.id}/offer`);
  assert.equal(offer.status, 200);
  assert.equal(strip(offer.body.lockLeaf), strip(before.lock.lockLeaf));
  await w.run(bothDone(w));
  assert.equal(w.evm.locks.leaves.length, 1, 'one lock for the one swap, restarts notwithstanding');
  assert.equal(w.evm.lockSpent.size, 1);
  const files = readdirSync(join(dir, 'swaps'));
  assert.ok(files.includes(`${rec.id}.json`), files.join(','));
});

test('an expired quote ends the swap before anything is locked: the user takes its note back', async () => {
  const { w, ref } = httpWorld();
  const s = await serve(w, { config: configFor(w, { quote: { validSecs: 100 } }) });
  ref.base = s.base;
  const q = await makeHttpCounter({ base: s.base, fetchImpl: realFetch }).quote(VALUE);
  await startSwap(w, q);
  await w.run(async () => (await w.user())?.phase === 'refund-wait');
  assert.match((await w.user()).why, /quote expired/);
  assert.equal(w.evm.locks.leaves.length, 0);
  assert.deepEqual(await w.lpStore.list(), []);
});

test('a swap that stays in the take is reported once an hour, with the reason', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(VALUE, 'same-size');
  const s = await serve(w, { config: configFor(w, { alertSecs: 3600 }) });
  ref.base = s.base;
  const q = await makeHttpCounter({ base: s.base, fetchImpl: realFetch }).quote(VALUE);
  await startSwap(w, q);
  let down = true;
  const send = w.lBtc.broadcast;
  w.lBtc.broadcast = async (...a) => { if (down) throw new Error('explorer down'); return send(...a); };
  await w.run(async () => (await w.lp())?.phase === 'taking');
  for (let i = 0; i < 3; i++) await s.svc.tick();
  assert.deepEqual(s.alerts, [], 'not yet');
  w.clock.advance(3700);
  await s.svc.tick(); await s.svc.tick();
  assert.equal(s.alerts.length, 1, JSON.stringify(s.alerts));
  assert.match(s.alerts[0].msg, /waited long in taking/);
  assert.match(s.alerts[0].error, /explorer down/);
  w.clock.advance(3700);
  await s.svc.tick();
  assert.equal(s.alerts.length, 2, 'again after another hour');
  down = false;
  await w.run(bothDone(w));
  const lp = await w.lp();
  assert.ok(lp.take);
});

// ── the files ──

test('the file store writes atomically, reads a torn file from its backup and reports a record it cannot read', async () => {
  const dir = tmp();
  const st = makeFileStore(dir);
  await st.put({ id: 'a', n: 1 });
  await st.put({ id: 'a', n: 2 });
  assert.deepEqual(await st.get('a'), { id: 'a', n: 2 });
  assert.equal(await st.get('missing'), null);
  assert.ok(readdirSync(dir).includes('a.json.bak'));
  writeFileSync(join(dir, 'a.json'), '{"id":"a","n":');
  assert.deepEqual(await st.get('a'), { id: 'a', n: 1 }, 'the torn file is read from its backup');
  writeFileSync(join(dir, 'b.json'), 'garbage');
  writeFileSync(join(dir, 'c.json.tmp'), '{"id":"c"');
  const all = await st.list();
  assert.deepEqual(all.map((r) => r.id), ['a'], 'the unreadable record and the stray temporary file are left out');
  assert.deepEqual(st.problems().map((p) => p.id), ['b']);
  await assert.rejects(() => st.get('../x'), /bad record id/);
  await assert.rejects(() => st.put({ id: 'a/b' }), /bad record id/);
  await assert.rejects(() => st.put({ id: '' }), /bad record id/);
  await st.put({ id: 'b', n: 3 });
  assert.deepEqual(st.problems(), [], 'writing the record again clears the report');
  assert.deepEqual((await makeFileStore(dir).list()).map((r) => r.id).sort(), ['a', 'b'], 'a new process reads the same files');
});

test('an unreadable swap record is reported once and the other swaps go on', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(VALUE, 'same-size');
  const dir = tmp();
  const swaps = makeFileStore(join(dir, 'swaps'));
  writeFileSync(join(dir, 'swaps', 'deadbeef.json'), '{"id":"deadbee');
  const s = await serve(w, { swaps });
  ref.base = s.base;
  await s.svc.tick(); await s.svc.tick(); await s.svc.tick();
  assert.equal(s.alerts.filter((a) => /cannot be read/.test(a.msg)).length, 1);
  assert.equal(s.alerts[0].id, 'deadbeef');
  const q = await makeHttpCounter({ base: s.base, fetchImpl: realFetch }).quote(VALUE);
  await startSwap(w, q);
  await w.run(bothDone(w));
  assert.equal((await w.user()).phase, 'done');
});

test('the log store and the wallet storage keep what they are given across a restart', async () => {
  const dir = tmp();
  const logs = makeFileLogStore(join(dir, 'logs'));
  assert.equal(await logs.get('k'), null);
  await logs.put('k', { v: 1, logs: [1, 2, 3] });
  assert.deepEqual(await logs.get('k'), { v: 1, logs: [1, 2, 3] });
  assert.deepEqual(await makeFileLogStore(join(dir, 'logs')).get('k'), { v: 1, logs: [1, 2, 3] });
  await logs.del('k'); await logs.del('k');
  assert.equal(await logs.get('k'), null);
  const file = join(dir, 'cache', 'wallet.json');
  const ls = makeFileStorage(file, { delayMs: 5 });
  assert.equal(ls.length, 0);
  ls.setItem('a', '1'); ls.setItem('b', 2); ls.removeItem('zz');
  assert.equal(ls.getItem('a'), '1'); assert.equal(ls.getItem('b'), '2'); assert.equal(ls.getItem('c'), null);
  assert.deepEqual([ls.key(0), ls.key(1), ls.key(2)], ['a', 'b', null]);
  assert.equal(ls.length, 2);
  ls.flush();
  const again = makeFileStorage(file);
  assert.equal(again.getItem('a'), '1'); assert.equal(again.length, 2);
  again.removeItem('a'); again.flush();
  assert.equal(makeFileStorage(file).getItem('a'), null);
  writeFileSync(file, 'not json');
  assert.equal(makeFileStorage(file).length, 0, 'an unreadable cache is a cache that is empty');
});

// ── the explorer adapter ──

function esploraChain(w, bases, extra = {}) {
  return makeNodeBtcChain({
    bases, tacit, prims: w.lW.prims, builder: makeAdaptorBtcTx({ prims: w.lW.prims, kit: tacitKit(tacit) }), pool,
    ethGetStorageAt: async () => ZERO32, poolAddress: '0x' + '22'.repeat(20), binding: '0x' + '11'.repeat(32),
    keccak256: keccak_256, secp: rootSecp, retryMs: 5, timeoutMs: 3000, fetchImpl: realFetch, ...extra,
  });
}
const fakeQuote = (w) => ({ id: 'q1', btcValue: String(VALUE), evmAmount: String(VALUE), evmAsset: ASSET, claimPub: bytesToHex(w.lW.wallet.pub) });
const coin = (value, confirmed = true, n = 0) => ({ txid: bytesToHex(new Uint8Array(32).fill(0xc0 + n)), vout: n, value, status: confirmed ? { confirmed: true, block_height: 799_990 } : { confirmed: false } });

test('the explorer adapter reads the chain: transactions, confirmations, block times, spends, coins and fees', async () => {
  const { w } = httpWorld();
  const addr = w.lW.prims.wallet.address();
  const a = await startEsploraMock({ sim: w.btc, feeEstimates: { 1: 9, 3: 4, 6: 2 }, addressUtxos: (x) => (x === addr ? [coin(200_000), coin(546, true, 1), coin(50_000, false, 2), coin(90_000, true, 3)] : []) });
  closers.push(a.close);
  const b = await startEsploraMock({ sim: w.btc, feeEstimates: { 3: 10, 6: 3 } });
  closers.push(b.close);
  const chain = esploraChain(w, [a.base, b.base]);
  const tx = await chain.fetchTx(w.etch.txid);
  assert.equal(tx.txid, w.etch.txid);
  assert.equal(await chain.fetchTx('f'.repeat(64)), null, 'a transaction no explorer has is null, not an error');
  assert.deepEqual(await chain.status(w.etch.txid), { confirmations: 1, height: 800_000 });
  assert.deepEqual(await chain.status('f'.repeat(64)), { confirmations: 0, height: 0 });
  w.btc.mine(5);
  assert.equal((await chain.status(w.etch.txid)).confirmations, 6);
  assert.equal(await chain.tip(), 800_005);
  assert.equal(await chain.blockTime(800_000), w.btc.blockTimes.get(800_000));
  assert.equal(await chain.blockTime(800_003), w.btc.blockTimes.get(800_003));
  assert.equal(await chain.outspend(w.etch.txid, 0), null);
  w.btc.spends.set(`${w.etch.txid}:0`, 'ab'.repeat(32));
  assert.equal(await chain.outspend(w.etch.txid, 0), 'ab'.repeat(32));
  assert.deepEqual((await chain.satsUtxos()).map((u) => u.value), [200_000, 90_000], 'plain confirmed coins above dust, largest first');
  assert.equal(await chain.feeRate(), 7, 'the median of what the explorers estimate (4 and 10), rounded up');
  assert.equal(chain.address, addr);
  assert.deepEqual(chain.wallet.xonly, w.lW.wallet.pub.slice(1));
  // confirmed transactions are asked for once
  const asked = () => a.state.gets.filter((p) => p === `/tx/${w.etch.txid}`).length + b.state.gets.filter((p) => p === `/tx/${w.etch.txid}`).length;
  const n0 = asked(); await chain.fetchTx(w.etch.txid); await chain.fetchTx(w.etch.txid);
  assert.equal(asked(), n0);
});

test('the explorer adapter goes on to the next explorer when one is down, errors or has not seen a transaction', async () => {
  const { w } = httpWorld();
  const dead = await startEsploraMock({ sim: w.btc });
  dead.state.down = true;
  closers.push(dead.close);
  const sick = await startEsploraMock({ sim: w.btc, fail: () => true });
  closers.push(sick.close);
  const good = await startEsploraMock({ sim: w.btc, feeEstimates: { 3: 5 } });
  closers.push(good.close);
  const chain = esploraChain(w, [dead.base, sick.base, good.base]);
  assert.equal((await chain.fetchTx(w.etch.txid)).txid, w.etch.txid);
  assert.equal((await chain.status(w.etch.txid)).confirmations, 1);
  assert.equal(await chain.feeRate(), 5, 'an explorer that cannot answer does not vote');
  // a transaction only the second explorer has seen is found there
  const lagging = await startEsploraMock({ sim: { ...w.btc, fetchTx: async () => null, txs: w.btc.txs, status: w.btc.status } });
  closers.push(lagging.close);
  const both = esploraChain(w, [lagging.base, good.base]);
  assert.equal((await both.fetchTx(w.etch.txid)).txid, w.etch.txid);
  // all down: an error, not a null
  const none = esploraChain(w, [dead.base, sick.base]);
  await assert.rejects(() => none.fetchTx(w.etch.txid));
  await assert.rejects(() => none.feeRate(), /no explorer answered a fee estimate/);
});

test('the adapter broadcasts the commit and then the reveal, asks again while the commit spreads, and reports a refusal', async () => {
  const { w } = httpWorld();
  await startSwap(w, fakeQuote(w));
  const pair = (await w.user()).lock;                      // a signed commit/reveal pair, as the machines store it
  const mock = await startEsploraMock({ sim: w.btc });
  closers.push(mock.close);
  const chain = esploraChain(w, [mock.base]);
  mock.state.rejectRevealTimes = 2;                         // the node has not yet seen the commit the reveal spends
  await chain.broadcast(pair);
  assert.deepEqual(mock.state.posted.map((p) => p.kind), ['commit', 'reveal']);
  assert.equal(mock.state.posted[1].txid, pair.txid);
  assert.equal(decodeRawTx(pair.revealHex).txid, pair.txid, 'the mock decodes what the builder serialised');
  assert.ok(w.btc.txs.has(pair.txid), 'the simulator holds the reveal');
  await chain.broadcast(pair);                              // a pair already known is not an error
  assert.equal(mock.state.posted.length, 2);

  // a refusal from every explorer is reported with the node's reason
  const w2 = httpWorld().w;
  await startSwap(w2, fakeQuote(w2));
  const pair2 = (await w2.user()).lock;
  const refusing = await startEsploraMock({ sim: w2.btc });
  closers.push(refusing.close);
  refusing.state.rejectRevealTimes = 99;
  await assert.rejects(() => esploraChain(w2, [refusing.base]).broadcast(pair2), /broadcast refused: .*missingorspent/);
  assert.ok(!w2.btc.txs.has(pair2.txid));

  // one explorer down and one taking it is a broadcast
  const dead = await startEsploraMock({ sim: w2.btc });
  dead.state.down = true;
  closers.push(dead.close);
  const live = await startEsploraMock({ sim: w2.btc });
  closers.push(live.close);
  await esploraChain(w2, [dead.base, live.base]).broadcast(pair2);
  assert.ok(w2.btc.txs.has(pair2.txid));
});

test('a whole swap through every layer: the user over HTTP, the LP over an explorer', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(VALUE, 'same-size');
  const mock = await startEsploraMock({ sim: w.btc, addressUtxos: (a) => (a === w.lW.prims.wallet.address() ? [coin(300_000), coin(546, true, 1)] : []), feeEstimates: { 3: 4, 6: 2 } });
  closers.push(mock.close);
  const lpBtc = esploraChain(w, [mock.base]);
  const s = await serve(w, { btc: lpBtc });
  ref.base = s.base;
  const q = await makeHttpCounter({ base: s.base, fetchImpl: realFetch }).quote(VALUE);
  mock.state.rejectRevealTimes = 0;
  await startSwap(w, q);
  // the LP's take is the only transaction it posts; the first attempt at its reveal is turned away as a node would while the commit spreads
  let armed = false;
  const lpTick = w.lpTick;
  w.lpTick = async () => { if (!armed && (await w.lp())?.phase === 'taking') { armed = true; mock.state.rejectRevealTimes = 1; } return lpTick(); };
  await w.run(bothDone(w));
  const lp = await w.lp(), user = await w.user();
  assert.ok(lp.take && (await w.noteOf(lp.take.txid, 0)), 'the LP\'s take, posted through the explorer, is a valid note');
  assert.equal(user.takenBy, lp.take.txid);
  assert.deepEqual(mock.state.posted.map((p) => p.kind), ['commit', 'reveal'], 'one pair: the take');
  assert.equal(mock.state.posted[1].txid, lp.take.txid);
  assert.equal(w.evm.locks.leaves.length, 1);
  assert.deepEqual(s.alerts, []);
});

test('an explorer that shows a spent note makes the LP refuse the lock before it locks anything', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(VALUE, 'same-size');
  const mock = await startEsploraMock({ sim: w.btc, addressUtxos: () => [coin(300_000)] });
  closers.push(mock.close);
  // the pool shows the note's identity as spent on Ethereum
  const lpBtc = esploraChain(w, [mock.base], { ethGetStorageAt: async () => '0x' + '00'.repeat(31) + '01' });
  const s = await serve(w, { btc: lpBtc });
  ref.base = s.base;
  const q = await makeHttpCounter({ base: s.base, fetchImpl: realFetch }).quote(VALUE);
  await startSwap(w, q);
  await w.run(async () => (await w.user())?.phase === 'refund-wait');
  assert.match((await w.user()).why, /already consumed on Ethereum/);
  assert.equal(w.evm.locks.leaves.length, 0);
  assert.deepEqual(await w.lpStore.list(), []);
});

// ── run ──

let passed = 0, ran = 0;
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
for (const [name, fn] of tests) {
  if (ONLY && !ONLY.test(name)) continue;
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
  while (closers.length) { try { await closers.pop()(); } catch { /* already closed */ } }
}
for (const d of dirs) rmSync(d, { recursive: true, force: true });
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${ran} fastbridge LP checks passed`);
process.exit(process.exitCode || 0);
