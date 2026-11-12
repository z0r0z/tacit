// The LP service (fastbridge-lp/) end to end on the simulated Bitcoin and pool of the machine tests: the HTTP API on a real
// socket, quotes, the durable store, the explorer adapter against an esplora-shaped server, and a whole swap through all of
// it. The user's side speaks to the service with dapp/fastbridge-http.js, as the page will.
//   node tests/fastbridge-lp.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import net from 'node:net';
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
import { VALUE, world } from './lib/fastbridge-world.mjs';
import { closers, configFor, serve, service, call, httpWorld, startSwap, bothDone } from './lib/lp-harness.mjs';
import { takeSatsAt } from '../dapp/fastbridge-provider.js';
import { makeFileStore, makeFileLogStore } from '../fastbridge-lp/lib/store.mjs';
import { makeFileStorage } from '../fastbridge-lp/lib/storage.mjs';
import { makeNodeBtcChain } from '../fastbridge-lp/lib/btc-chain.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ZERO32 = '0x' + '00'.repeat(32);
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'fb-lp-')); dirs.push(d); return d; };


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
  w.lEvm.fund(100_000n, 'inv');
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
  w.lEvm.fund(100_000n, 'inv');
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
  w.lEvm.fund(VALUE, 'same-size');
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

// ── what the LP can take ──

// the simulated wallet pays a take from one coin; more coins let more swaps be open at once
const manyCoins = (w, n = 5, value = 200_000) => { w.lBtc.satsUtxos = async () => Array.from({ length: n }, (_, i) => ({ txid: String(i).repeat(64), vout: 0, value })); };
const post = (s, path, body) => call(s.base, 'POST', path, body);
const infoOf = async (s) => (await call(s.base, 'GET', '/info')).body;

test('what can be taken: /info says it, a quote beyond it is refused, and a quote holds nothing', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(6000n, 'inv'); manyCoins(w);
  const s = await serve(w);
  assert.equal((await infoOf(s)).available, '6000');
  const over = await post(s, '/quote', { amount: '6001' });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /cannot take that amount right now/);
  const [a, b] = [await post(s, '/quote', { amount: '5000' }), await post(s, '/quote', { amount: '5000' })];
  assert.deepEqual([a.status, b.status], [200, 200], 'two users comparing providers hold nothing');
  assert.equal((await infoOf(s)).available, '6000');
  // a provider that cannot say what it holds says so, and quotes as before
  const blind = await serve(w, { config: configFor(w) });
  delete w.lEvmCtx.available;
  assert.equal((await infoOf(blind)).available, null);
  assert.equal((await post(blind, '/quote', { amount: '999999' })).status, 200);
});

test('a provider that cannot get a lock into the pool says so: nothing to take in /info, a quote, a reservation and a new offer are turned away with the reason, the one who runs it is told once, a swap it holds goes on, and it takes bridges again when it can', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(6000n, 'inv'); manyCoins(w);
  let state = { ok: true };
  w.lEvmCtx.ready = async () => state;
  const s = await serve(w);
  assert.equal((await infoOf(s)).available, '6000');
  const q = (await post(s, '/quote', { amount: '5000' })).body;
  state = { ok: false, why: 'the relay is not sending settles' };
  assert.equal((await infoOf(s)).available, '0', 'the ad shows nothing to take, so a page goes to the regular bridge');
  const no = await post(s, '/quote', { amount: '1000' });
  assert.equal(no.status, 503);
  assert.match(no.body.error, /cannot lock right now \(the relay is not sending settles\)/);
  const res = await post(s, '/reserve', { quoteId: q.id });
  assert.deepEqual([res.body.ok, /cannot lock right now/.test(res.body.why)], [false, true]);
  const offer = await post(s, '/offer', { quoteId: q.id, offer: { swapId: 'a'.repeat(72) } });
  assert.deepEqual([offer.body.ok, offer.body.retry], [false, true], 'a new offer is declined, and may be tried again: the relay may be back');
  assert.match(offer.body.why, /cannot lock right now/);
  const tell = () => new Promise((r) => setTimeout(r, 5));
  await s.svc.tick(); await tell(); await s.svc.tick(); await tell();
  assert.deepEqual(s.alerts.map((a) => [a.level, a.msg, a.why]), [['alert', 'the provider is not taking bridges', 'the relay is not sending settles']], 'told once, not on every tick');
  state = { ok: true };
  assert.equal((await infoOf(s)).available, '6000');
  assert.equal((await post(s, '/quote', { amount: '1000' })).status, 200);
  await s.svc.tick(); await tell();
  assert.deepEqual(s.alerts.map((a) => a.msg), ['the provider is not taking bridges', 'the provider can lock again']);

  // a swap that is already held is not stopped by it
  const h = httpWorld(); h.w.lEvm.fund(VALUE, 'same-size');
  let ok = true; h.w.lEvmCtx.ready = async () => (ok ? { ok: true } : { ok: false, why: 'the relay is not sending settles' });
  const t = await serve(h.w); h.ref.base = t.base;
  await startSwap(h.w, await makeHttpCounter({ base: t.base, fetchImpl: realFetch }).quote(VALUE));
  await h.w.run(async () => !!(await h.w.lp()));
  ok = false;
  await h.w.run(bothDone(h.w));
  assert.equal((await h.w.lp()).phase, 'done');
});

test('a reservation holds the payout: the next quote and reservation see less, and it lets go when it runs out', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(6000n, 'inv'); manyCoins(w);
  const s = await serve(w);
  const q = (await post(s, '/quote', { amount: '4000' })).body;
  const r1 = await post(s, '/reserve', { quoteId: q.id });
  assert.deepEqual([r1.status, r1.body.ok, r1.body.until], [200, true, w.clock.now() + 300]);
  assert.equal((await infoOf(s)).available, '2000');
  assert.equal((await post(s, '/quote', { amount: '3000' })).status, 400, 'what is left does not cover it');
  assert.equal((await post(s, '/quote', { amount: '2000' })).status, 200);
  assert.deepEqual((await post(s, '/reserve', { quoteId: q.id })).body, r1.body, 'the same reservation again is the same reservation');
  assert.deepEqual((await post(s, '/reserve', { quoteId: '0'.repeat(32) })).body, { ok: false, retry: false, why: 'unknown quote' });
  assert.equal((await post(s, '/reserve', { quoteId: 'nope' })).status, 400);
  w.clock.advance(301);
  assert.equal((await infoOf(s)).available, '6000', 'the payout is free again');
  assert.equal((await post(s, '/reserve', { quoteId: q.id })).body.ok, true, 'a quote still valid can be reserved again');
});

test('reservations are made one at a time: two users asking for the same inventory at once get one reservation between them', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(6000n, 'inv'); manyCoins(w);
  const s = await serve(w);
  const q1 = (await post(s, '/quote', { amount: '4000' })).body, q2 = (await post(s, '/quote', { amount: '4000' })).body;
  const got = await Promise.all([post(s, '/reserve', { quoteId: q1.id }), post(s, '/reserve', { quoteId: q2.id })]);
  assert.deepEqual(got.map((r) => r.body.ok).sort(), [false, true]);
  assert.match(got.find((r) => !r.body.ok).body.why, /cannot take that amount right now/);
});

test('reservations with no transaction behind them hold only a share of the pool balance together, one alone may hold more, and a transaction makes one count as real', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(6000n, 'inv'); manyCoins(w);
  const s = await serve(w);
  ref.base = s.base;
  const quote = async (a) => (await post(s, '/quote', { amount: String(a) })).body;
  const a = await quote(5000);
  assert.equal((await post(s, '/reserve', { quoteId: a.id })).body.ok, true, 'a reservation alone may hold most of it');
  const b = await quote(1000);
  assert.deepEqual((await post(s, '/reserve', { quoteId: b.id })).body.ok, false, 'a second with nothing behind it does not fit under half');
  // the first goes out as a lock: its transaction is on the network, and the held payout is real
  s.svc.reservations.get(a.id).txid = 'e'.repeat(64);
  assert.equal((await post(s, '/reserve', { quoteId: b.id })).body.ok, true, 'once the first has a transaction behind it, the second fits');
  const tight = await serve(w, { config: configFor(w, { reserve: { maxUnbackedShare: 0.25 } }) });
  const q1 = (await post(tight, '/quote', { amount: '1000' })).body, q2 = (await post(tight, '/quote', { amount: '1000' })).body;
  assert.equal((await post(tight, '/reserve', { quoteId: q1.id })).body.ok, true);
  assert.equal((await post(tight, '/reserve', { quoteId: q2.id })).body.ok, false, 'a quarter of 6,000 is 1,500: two thousand do not fit');
});

test('an offer whose checks take long is answered "ask again" within the budget while they go on, and asked again it joins them: one check, not one for every try', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(1500n, 'inv'); manyCoins(w);
  const s = await serve(w, { config: { ...configFor(w), offerBudgetMs: 40 } });
  const q = (await post(s, '/quote', { amount: '1000' })).body;
  let checks = 0;
  s.svc.el.receive = async ({ quoteId, offer }) => { checks++; const known = await s.swaps.get(offer.swapId); if (known) return { ok: true, rec: known }; await new Promise((r) => setTimeout(r, 250)); await s.swaps.put({ id: offer.swapId, role: 'el', phase: 'accepted', quoteId, offer: { evm: { amount: '1000' } }, created: w.clock.now() }); return { ok: true, rec: { phase: 'accepted' } }; };
  const offer = { quoteId: q.id, offer: { swapId: 'a'.repeat(72) } };
  const t0 = Date.now();
  const first = await post(s, '/offer', offer);
  assert.deepEqual([first.status, first.body.ok, first.body.retry], [200, false, true]);
  assert.match(first.body.why, /still being checked/); assert.ok(Date.now() - t0 < 200, 'answered within the budget, not when the checks end');
  const joined = await post(s, '/offer', offer);
  assert.deepEqual([joined.body.ok, joined.body.retry], [false, true], 'asked again while they go on, it is told the same');
  await new Promise((r) => setTimeout(r, 300));
  const done = await post(s, '/offer', offer);
  assert.deepEqual([done.body.ok, done.body.phase], [true, 'accepted']);
  assert.equal(checks, 1, 'three requests, one check');
  assert.equal((await post(s, '/offer', offer)).body.ok, true, 'a swap already held is answered with its record');
  assert.equal(checks, 2, 'and a swap that is stored is answered at once by the machine');
});

test('an offer whose checks fail for a reason of their own is answered to try again, with the reason, and logged: not a bare 500', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(1500n, 'inv'); manyCoins(w);
  const s = await serve(w);
  const q = (await post(s, '/quote', { amount: '1000' })).body;
  s.svc.el.receive = async () => { throw new Error('Buffer is not defined'); };
  const r = await post(s, '/offer', { quoteId: q.id, offer: { swapId: 'b'.repeat(72) } });
  assert.deepEqual([r.status, r.body.ok, r.body.retry], [200, false, true]);
  assert.match(r.body.why, /the lock could not be checked now: Buffer is not defined/);
  const log = s.logs.find((l) => l.msg === 'an offer could not be checked');
  assert.ok(log && log.level === 'error' && /Buffer is not defined/.test(log.error), 'the provider is told');
  // the same offer asked again is checked again, not remembered as failed
  s.svc.el.receive = async ({ quoteId, offer }) => { await s.swaps.put({ id: offer.swapId, role: 'el', phase: 'accepted', quoteId, offer: { evm: { amount: '1000' } }, created: w.clock.now() }); return { ok: true, rec: { phase: 'accepted' } }; };
  assert.equal((await post(s, '/offer', { quoteId: q.id, offer: { swapId: 'b'.repeat(72) } })).body.ok, true);
});

test('a request that fails inside the service is logged with its path, and is still answered 500 without the reason', async () => {
  const { w } = httpWorld();
  const s = await serve(w);
  s.swaps.get = async () => { throw new Error('the disk is full'); };
  const r = await call(s.base, 'GET', '/swap/' + 'c'.repeat(72));
  assert.deepEqual([r.status, r.body.error], [500, 'the service could not answer']);
  assert.ok(s.logs.some((l) => l.msg === 'a request failed' && l.path.startsWith('/swap/') && /disk is full/.test(l.error)), JSON.stringify(s.logs));
});

test('the pre-signature is given while the user\'s lock stands: a lock that has fallen under its confirmations gets no offer until it is back', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(VALUE, 'inv');
  const s = await serve(w);
  ref.base = s.base;
  const counter = makeHttpCounter({ base: s.base, fetchImpl: realFetch });
  const q = await counter.quote(VALUE);
  const rec = await startSwap(w, q);
  await w.run(async () => (await w.lp())?.phase === 'offered');
  assert.ok(await counter.getEvmOffer(rec.id), 'with the lock confirmed the offer is given');
  const real = w.lBtc.status;
  w.lBtc.status = async (t) => (t === rec.lock.txid ? { confirmations: 0, height: 0 } : real(t));
  assert.equal(await counter.getEvmOffer(rec.id), null, 'a lock that has been reorganised away is not paid for');
  w.lBtc.status = async () => { throw new Error('explorer down'); };
  assert.ok(await counter.getEvmOffer(rec.id), 'an explorer that cannot answer does not stop the user');
  w.lBtc.status = real;
  assert.ok(await counter.getEvmOffer(rec.id), 'and when the lock is back the offer is too');
});

test('a request line the URL parser refuses is answered 400 and the server stays up; the first address of a proxy header does not choose the bucket', async () => {
  const { w } = httpWorld();
  const s = await serve(w, { trustProxy: true, limits: { default: [3, 3600], offer: [3, 3600] } });
  const port = s.server.address().port;
  for (const line of ['GET // HTTP/1.1', 'GET //a:b HTTP/1.1']) {
    const answer = await new Promise((res, rej) => { const c = net.connect(port, '127.0.0.1', () => c.write(`${line}\r\nHost: x\r\nConnection: close\r\n\r\n`)); let d = ''; c.on('data', (x) => { d += x; }); c.on('close', () => res(d)); c.on('error', rej); });
    assert.match(answer, /^HTTP\/1\.1 400/, line);
  }
  assert.equal((await call(s.base, 'GET', '/health', undefined, { 'x-forwarded-for': '198.51.100.1' })).status, 200, 'the server is still answering');
  // a client that writes its own first hop is still counted under the address the proxy added
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call(s.base, 'GET', '/info', undefined, { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.9` })).status);
  assert.ok(codes.filter((c) => c === 429).length >= 3, `spoofed first hops did not give a bucket each (${codes})`);
});

test('extending a reservation needs a transaction that pays the take: not just any lock-shaped one, one transaction holds one quote, and a hold does not start over', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(10_000n, 'inv'); manyCoins(w);
  const own = bytesToHex(w.lBtc.prims.p2wpkhScript(w.lW.wallet.pub));
  const txs = new Map();
  const btc = { ...w.lBtc, fetchTx: async (t) => txs.get(t) || w.lBtc.fetchTx(t) };
  const s = await serve(w, { btc, config: configFor(w, { reserve: { reserveSecs: 900, extendSecs: 7200 } }) });
  const q1 = (await post(s, '/quote', { amount: '1000' })).body, q2 = (await post(s, '/quote', { amount: '1000' })).body;
  assert.ok(q1.takeSats > 0, 'a take fee is asked');
  await post(s, '/reserve', { quoteId: q1.id }); await post(s, '/reserve', { quoteId: q2.id });
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
  txs.set(A, { vin: [{}, {}], vout: [{ scriptpubkey: '0014' + '11'.repeat(20), value: 1_000_000 }], status: { confirmed: false } });
  assert.match((await post(s, '/extend', { quoteId: q1.id, txid: A })).body.why, /does not pay the fee of the take/, 'any two-input transaction is not a lock');
  assert.equal(s.svc.reservations.get(q1.id).txid, null);
  txs.set(A, { vin: [{}, {}], vout: [{ scriptpubkey: own, value: q1.takeSats - 1 }], status: { confirmed: false } });
  assert.match((await post(s, '/extend', { quoteId: q1.id, txid: A })).body.why, /does not pay the fee of the take/, 'a payment under the take is not enough');
  txs.set(A, { vin: [{}, {}], vout: [{ scriptpubkey: own, value: q1.takeSats }], status: { confirmed: false } });
  const first = await post(s, '/extend', { quoteId: q1.id, txid: A });
  assert.equal(first.body.ok, true);
  w.clock.advance(100);
  assert.equal((await post(s, '/extend', { quoteId: q1.id, txid: A })).body.until, first.body.until, 'asking again does not hold it longer');
  assert.match((await post(s, '/extend', { quoteId: q2.id, txid: A })).body.why, /already holds another reservation/, 'one transaction stands for one quote');
  txs.set(B, { vin: [{}, {}], vout: [{ scriptpubkey: own, value: q2.takeSats }], status: { confirmed: false } });
  assert.equal((await post(s, '/extend', { quoteId: q2.id, txid: B })).body.ok, true, 'its own transaction holds the other');
  w.clock.advance(7200);
  assert.equal(s.svc.reservations.size, 2, 'the holds are still there until they run out');
  assert.equal((await infoOf(s)).available, '10000', 'and then the payout is free again');
});

test('a slow explorer behind /extend does not hold the other requests: the transaction is read before the capacity lock is taken', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(10_000n, 'inv'); manyCoins(w);
  let release;
  const gate = new Promise((r) => { release = r; });
  const btc = { ...w.lBtc, fetchTx: async () => { await gate; return null; } };
  const s = await serve(w, { btc });
  const q = (await post(s, '/quote', { amount: '1000' })).body;
  await post(s, '/reserve', { quoteId: q.id });
  const slow = post(s, '/extend', { quoteId: q.id, txid: 'cc'.repeat(32) });
  const t0 = Date.now();
  assert.equal((await post(s, '/quote', { amount: '2000' })).status, 200, 'a quote is answered while an extension waits on the explorer');
  assert.ok(Date.now() - t0 < 1000);
  release();
  assert.equal((await slow).body.retry, true);
});

test('two offers that arrive together are not both given what is left for one', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(1500n, 'inv'); manyCoins(w);
  const s = await serve(w);
  const q1 = (await post(s, '/quote', { amount: '1000' })).body, q2 = (await post(s, '/quote', { amount: '1000' })).body;
  // the checks of a real offer take a few explorer reads; the answer is a stored swap, as the real one
  s.svc.el.receive = async ({ quoteId, offer }) => { await new Promise((r) => setTimeout(r, 40)); await s.swaps.put({ id: offer.swapId, role: 'el', phase: 'accepted', quoteId, offer: { evm: { amount: '1000' } }, created: w.clock.now() }); return { ok: true, rec: { phase: 'accepted' } }; };
  const got = await Promise.all([post(s, '/offer', { quoteId: q1.id, offer: { swapId: 'a'.repeat(72) } }), post(s, '/offer', { quoteId: q2.id, offer: { swapId: 'b'.repeat(72) } })]);
  assert.deepEqual(got.map((r) => r.body.ok).sort(), [false, true], 'one of them is declined, with its Bitcoin still in hand');
  assert.match(got.find((r) => !r.body.ok).body.why, /cannot take that amount right now/);
  // the hold of an offer is gone once it is answered: the swap itself holds the payout now
  assert.equal(s.svc.reservations.size, 0);
});

test('every offer is said once in the log with its reason, so a lock turned away is never silent: a decline for good, one to ask again, and an acceptance', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(6000n, 'inv'); manyCoins(w);
  const s = await serve(w);
  const q = (await post(s, '/quote', { amount: '1000' })).body;
  const A = 'a'.repeat(72), B = 'b'.repeat(72), C = 'c'.repeat(72);
  s.svc.el.receive = async () => ({ ok: false, retry: false, why: 'the opening does not match the note' });
  await post(s, '/offer', { quoteId: q.id, offer: { swapId: A } });
  const declined = s.logs.filter((l) => l.msg === 'offer declined');
  assert.equal(declined.length, 1);
  assert.deepEqual([declined[0].level, declined[0].id, declined[0].retry, declined[0].why], ['warn', A, false, 'the opening does not match the note']);
  s.svc.el.receive = async () => { throw Object.assign(new Error('the note could not be read just now'), { transient: true }); };
  await post(s, '/offer', { quoteId: q.id, offer: { swapId: B } });
  const again = s.logs.filter((l) => l.msg === 'offer declined').at(-1);
  assert.deepEqual([again.id, again.retry], [B, true]);
  assert.match(again.why, /could not be checked now: the note could not be read just now/, 'a read that failed is logged as one to try again, with why');
  s.svc.el.receive = async ({ offer }) => { await s.swaps.put({ id: offer.swapId, role: 'el', phase: 'accepted', quoteId: q.id, offer: { evm: { amount: '1000' } }, created: w.clock.now() }); return { ok: true, rec: { phase: 'accepted' } }; };
  await post(s, '/offer', { quoteId: q.id, offer: { swapId: C } });
  assert.equal(s.logs.filter((l) => l.msg === 'offer accepted' && l.id === C).length, 1, 'an acceptance is said as well');
  assert.equal(s.logs.filter((l) => l.msg === 'offer declined').length, 2, 'and nothing else is said as a decline');
});

test('a reservation belongs to the swap that first uses it: a second swap on the same quote asks for room of its own', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(1500n, 'inv'); manyCoins(w);
  const s = await serve(w);
  const q = (await post(s, '/quote', { amount: '1000' })).body;
  await post(s, '/reserve', { quoteId: q.id });
  s.svc.el.receive = async ({ quoteId, offer }) => { await new Promise((r) => setTimeout(r, 30)); await s.swaps.put({ id: offer.swapId, role: 'el', phase: 'accepted', quoteId, offer: { evm: { amount: '1000' } }, created: w.clock.now() }); return { ok: true, rec: { phase: 'accepted' } }; };
  const got = await Promise.all([post(s, '/offer', { quoteId: q.id, offer: { swapId: 'a'.repeat(72) } }), post(s, '/offer', { quoteId: q.id, offer: { swapId: 'b'.repeat(72) } })]);
  assert.deepEqual(got.map((r) => r.body.ok).sort(), [false, true], 'the reservation covers one swap, and the room left covers no second');
});

test('an offer for a lock that is only in the mempool is not answered and stores nothing; a lock that never gets its confirmations ends the swap', async () => {
  let captured = null;
  const w = world({ lpConfs: 3, userCounter: () => ({ sendOffer: async (m) => { captured = m; return { ok: true }; }, getEvmOffer: async () => null }) });
  const rec = await w.start();
  await w.userBl.step(rec);
  w.btc.mine(1, { advance: false });
  await w.userBl.step(rec);
  assert.ok(captured, 'the user made its offer once the lock confirmed');
  const real = w.lBtc.status;
  w.lBtc.status = async (t) => (t === rec.lock.txid ? { confirmations: 0, height: 0 } : real(t));
  const r = await w.lp_.receive(captured);
  assert.deepEqual([r.ok, r.retry], [false, true]); assert.match(r.why, /no confirmation yet/);
  assert.deepEqual(await w.lpStore.list(), [], 'nothing is held for a lock that can still be replaced');
  w.lBtc.status = async (t) => (t === rec.lock.txid ? { confirmations: 1, height: (await real(t)).height } : real(t));
  assert.equal((await w.lp_.receive(captured)).ok, true);
  const accepted = await w.lp();
  assert.equal((await w.lp_.step(accepted)).phase, 'accepted', 'three are asked for and one is there');
  w.clock.advance(43201);
  const ended = await w.lp_.step(await w.lp());
  assert.deepEqual([ended.phase, /did not reach its confirmations/.test(ended.why)], ['aborted', true]);
});

test('an offer whose lock outpoint is not an outpoint is refused before any chain read', async () => {
  const w = world();
  let reads = 0;
  for (const k of ['fetchTx', 'status', 'resolveNote']) { const f = w.lBtc[k]; w.lBtc[k] = async (...a) => { reads++; return f(...a); }; }
  const rec = await w.start();
  await w.userBl.step(rec);
  const base = { swapId: rec.id, btc: { value: String(VALUE), asset: rec.asset, vout: 0 }, evm: { amount: String(VALUE) } };
  for (const txid of ['../mempool/txids', 'zz', 'aa'.repeat(31), 7, undefined]) {
    const r = await w.lp_.receive({ quoteId: 'q1', offer: { ...base, btc: { ...base.btc, txid } } });
    assert.equal(r.ok, false, String(txid)); assert.match(r.why, /malformed offer: the lock outpoint/);
  }
  const r2 = await w.lp_.receive({ quoteId: 'q1', offer: { ...base, btc: { ...base.btc, txid: 'aa'.repeat(32), vout: -1 } } });
  assert.match(r2.why, /lock outpoint/);
  const r3 = await w.lp_.receive({ quoteId: 'q1', offer: { ...base, btc: { ...base.btc, txid: 'aa'.repeat(32) }, evm: { amount: String(VALUE + 1n) } } });
  assert.match(r3.why, /amounts differ from the quote/);
  assert.equal(reads, 0, 'no explorer was asked');
});

test('holds kept for a lock too old to answer, or several for one lock, are let go: on a restart and on a tick, and the room comes back', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(VALUE, 'inv'); manyCoins(w);
  const s = await serve(w);
  ref.base = s.base;
  const counter = makeHttpCounter({ base: s.base, fetchImpl: realFetch });
  const q = await counter.quote(VALUE);
  await counter.reserve({ quoteId: q.id });
  const rec = await startSwap(w, q);
  await w.userBl.step(rec); await w.userBl.step(rec);                      // the lock goes out and the hold is extended for it
  w.btc.mine(1, { advance: false });
  assert.equal(s.svc.reservations.get(q.id).txid, rec.lock.txid);
  // as an earlier version left a provider's browser: more holds saved for the same lock, under quotes of their own
  for (const id of ['1'.repeat(32), '2'.repeat(32)]) await s.quoteStore.put({ ...(await s.quoteStore.get(q.id)), id, created: w.clock.now() + 1, reservedUntil: w.clock.now() + 7200, reservedTxid: rec.lock.txid });
  const again = await serve(w, { quoteStore: s.quoteStore, swaps: s.swaps });
  assert.equal(again.svc.reservations.size, 1, 'a restart keeps one hold for one lock');
  assert.equal((await again.quoteStore.get('1'.repeat(32))).reservedUntil, 0, 'and the others are let go for good');
  assert.equal((await call(again.base, 'GET', '/info')).body.available, '0', 'while the lock may still be answered, its hold stands');
  w.clock.advance(3601);
  await again.svc.tick();
  assert.equal(again.svc.reservations.size, 0, 'once the lock is too old to answer, its hold goes');
  assert.ok(again.logs.some((l) => l.msg === 'holds for locks too old to answer were let go'));
  assert.equal((await call(again.base, 'GET', '/info')).body.available, String(VALUE), 'and the room is back');
  const third = await serve(w, { quoteStore: s.quoteStore, swaps: s.swaps });
  assert.equal(third.svc.reservations.size, 0, 'nothing comes back on the next restart');
});

test('a provider with no Bitcoin of its own: each quote names the fee of the take, the lock pays it to the provider, and the take spends it', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(100_000n, 'inv');
  const s = await serve(w);
  ref.base = s.base;
  // the provider's coins are what the chain holds at its address: none until a lock pays it
  const own = bytesToHex(w.lW.prims.p2wpkhScript(w.lW.wallet.pub));
  const seen = [];
  w.lBtc.satsUtxos = async () => { const c = await chainCoins(); seen.push(...c); return c; };
  const chainCoins = async () => [...w.btc.txs].flatMap(([txid, e]) => (e.height == null ? [] : e.esplora.vout.map((o, vout) => ({ txid, vout, value: o.value, spk: o.scriptpubkey }))))
    .filter((c) => c.spk === own && c.value > 546 && !w.btc.spends.has(`${c.txid}:${c.vout}`)).map(({ txid, vout, value }) => ({ txid, vout, value }));
  assert.deepEqual(await chainCoins(), [], 'no coins');
  const q = (await post(s, '/quote', { amount: '2000' })).body;
  assert.equal(q.takeSats, 546 + Math.ceil(750 * 3 * 2), 'the take priced at twice the rate, with its dust');
  w.lEvm.fund(BigInt(q.evmAmount), 'exact');
  assert.equal((await post(s, '/reserve', { quoteId: q.id })).body.ok, true, 'held with no coin');
  const rec = await startSwap(w, q);
  await w.run(bothDone(w));
  assert.ok(w.btc.txs.get(rec.lock.txid).esplora.vout.some((o) => o.scriptpubkey === own && o.value === q.takeSats), 'the lock pays the fee to the provider');
  assert.ok((await w.lp()).take, 'taken');
  assert.ok(seen.length && seen.every((c) => c.txid === rec.lock.txid && c.value === q.takeSats), 'the only coin the take could spend was the lock\'s fee output');
});

test('a lock that does not pay the fee of the take is refused', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(100_000n, 'inv');
  const s = await serve(w);
  ref.base = s.base;
  const q = (await post(s, '/quote', { amount: '2000' })).body;
  assert.ok(q.takeSats > 0);
  await startSwap(w, { ...q, takeSats: 0 });
  await w.run(async () => ['rejected', 'refund-wait', 'refunded'].includes((await w.user())?.phase));
  const u = await w.user();
  assert.match(String(u.why || u.lastError || ''), /does not pay the fee of the take/, `refused for the fee: ${JSON.stringify({ ...u, lock: undefined, noteInputs: undefined }).slice(0, 700)}`);
});

test('extending a reservation: held through the confirmation, for the transaction it was made for', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(VALUE, 'inv'); manyCoins(w);
  const s = await serve(w, { config: configFor(w, { reserve: { reserveSecs: 900, extendSecs: 7200 } }) });
  ref.base = s.base;
  const counter = makeHttpCounter({ base: s.base, fetchImpl: realFetch });
  const q = await counter.quote(VALUE);
  assert.deepEqual((await post(s, '/extend', { quoteId: q.id, txid: 'f'.repeat(64) })).body, { ok: false, retry: false, why: 'no reservation' });
  await counter.reserve({ quoteId: q.id });
  assert.deepEqual((await post(s, '/extend', { quoteId: q.id, txid: 'f'.repeat(64) })).body, { ok: false, retry: true, why: 'the lock transaction is not visible yet' });
  assert.equal((await post(s, '/extend', { quoteId: q.id, txid: 'zz' })).status, 400);
  const rec = await startSwap(w, q);
  await w.userBl.step(rec);                                    // the lock goes out
  await w.userBl.step(rec);                                    // and the machine asks for the extension itself
  const held = s.svc.reservations.get(q.id);
  assert.equal(held.txid, rec.lock.txid);
  assert.equal(held.until, w.clock.now() + 7200);
  assert.equal((await w.user()).extended, true);
  assert.match((await post(s, '/extend', { quoteId: q.id, txid: 'e'.repeat(64) })).body.why, /another transaction/);
  assert.equal((await post(s, '/extend', { quoteId: q.id, txid: rec.lock.txid })).body.ok, true, 'the same transaction again is fine');
});

test('a swap whose lock confirms after its quote ran out still goes through: the reservation was extended', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(VALUE, 'inv'); manyCoins(w);
  const s = await serve(w, { config: configFor(w, { quote: { validSecs: 100 } }) });
  ref.base = s.base;
  const counter = makeHttpCounter({ base: s.base, fetchImpl: realFetch });
  const q = await counter.quote(VALUE);
  assert.equal((await counter.reserve({ quoteId: q.id })).ok, true);
  await startSwap(w, q);
  await w.run(bothDone(w));
  assert.equal((await w.user()).phase, 'done');
  assert.ok(w.clock.now() > q.created + 100, 'the offer came after the quote\'s own time');
  assert.equal(s.svc.reservations.size, 0, 'the swap carries the payout from here');
});

test('an offer that holds nothing and finds nothing left is declined before anything is checked of it', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(VALUE, 'inv'); manyCoins(w);
  const s = await serve(w, { config: configFor(w, { reserve: { reserveSecs: 100000, extendSecs: 7200, maxUnbackedShare: 1 } }) });
  ref.base = s.base;
  const counter = makeHttpCounter({ base: s.base, fetchImpl: realFetch });
  const mine = await counter.quote(VALUE), theirs = await counter.quote(VALUE);
  assert.equal((await counter.reserve({ quoteId: theirs.id })).ok, true);
  assert.deepEqual(await counter.reserve({ quoteId: mine.id }), { ok: false, retry: false, why: 'the provider cannot take that amount right now' });
  // a user who locks anyway is answered no, and takes the note back
  await startSwap(w, mine);
  await w.run(async () => (await w.user())?.phase === 'refund-wait');
  assert.match((await w.user()).why, /cannot take that amount right now/);
  assert.equal(w.evm.locks.leaves.length, 0);
  assert.deepEqual(await w.lpStore.list(), []);
});

test('reservations survive a restart of the service, and quotes never used are forgotten after two days', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(6000n, 'inv'); manyCoins(w);
  const dir = tmp();
  const quoteStore = makeFileStore(join(dir, 'quotes'));
  let s = await serve(w, { quoteStore });
  const q = (await post(s, '/quote', { amount: '4000' })).body, unused = (await post(s, '/quote', { amount: '1000' })).body;
  await post(s, '/reserve', { quoteId: q.id });
  await s.close();
  s = await serve(w, { quoteStore: makeFileStore(join(dir, 'quotes')) });
  assert.equal((await infoOf(s)).available, '2000', 'the reservation was kept');
  assert.equal(s.svc.reservations.get(q.id).amount, 4000n);
  w.clock.advance(3 * 86400);
  await s.svc.tick();
  assert.equal(await quoteStore.get(unused.id), null, 'an unused quote is forgotten');
  assert.equal((await s.svc.quoter.get(q.id)), null, 'and so is a reserved one whose time is long past');
  const fresh = (await post(s, '/quote', { amount: '1000' })).body;
  await s.svc.tick();
  assert.ok(await s.svc.quoter.get(fresh.id), 'a quote that is not old is kept');
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

test('a fee estimate is reused for a minute, read once for callers together, and an older one stands in while no explorer answers', async () => {
  const { w } = httpWorld();
  const est = { 3: 4 };
  let broken = false;
  const a = await startEsploraMock({ sim: w.btc, feeEstimates: est, fail: (p) => broken && p === '/fee-estimates' });
  closers.push(a.close);
  const clock = { t: 1_000_000 };
  const chain = esploraChain(w, [a.base], { nowMs: () => clock.t });
  const reads = () => a.state.gets.filter((p) => p === '/fee-estimates').length;
  assert.deepEqual(await Promise.all([1, 2, 3, 4, 5].map(() => chain.feeRate())), [4, 4, 4, 4, 4]);
  assert.equal(reads(), 1, 'callers at the same moment share one read');
  clock.t += 30_000;
  assert.equal(await chain.feeRate(), 4);
  assert.equal(reads(), 1, 'a minute has not passed');
  est[3] = 9;
  clock.t += 40_000;
  broken = true;
  assert.equal(await chain.feeRate(), 4, 'the explorers fail: the last estimate stands in');
  assert.equal(reads(), 2);
  assert.equal(await chain.feeRate(), 4);
  assert.equal(reads(), 2, 'a read that just failed is not repeated for every caller');
  clock.t += 20_000;
  assert.equal(await chain.feeRate(), 4);
  assert.equal(reads(), 3, 'it is tried again after 15 seconds');
  broken = false;
  clock.t += 20_000;
  assert.equal(await chain.feeRate(), 9, 'an explorer that answers again is believed at once');
  broken = true;
  clock.t += 3 * 3600_000;
  await assert.rejects(() => chain.feeRate(), /no explorer answered a fee estimate \(127\.0\.0\.1:\d+ 500\)/, 'an estimate more than two hours old is not used, and the error says what the explorer said');
  broken = false;
  clock.t += 20_000;
  assert.equal(await chain.feeRate(), 9);
});

test('the error for a missing fee estimate says what each explorer answered', async () => {
  const { w } = httpWorld();
  const dead = await startEsploraMock({ sim: w.btc });
  dead.state.down = true;
  closers.push(dead.close);
  const limited = await startEsploraMock({ sim: w.btc, fail: () => true });
  closers.push(limited.close);
  const bare = await startEsploraMock({ sim: w.btc, feeEstimates: {} });
  closers.push(bare.close);
  const chain = esploraChain(w, [dead.base, limited.base, bare.base]);
  await assert.rejects(() => chain.feeRate(), (e) => /no explorer answered a fee estimate/.test(e.message) && /was unreachable/.test(e.message) && / 500/.test(e.message) && /gave no estimate/.test(e.message));
});

test('a quote rides out an explorer outage on the last fee estimate and says so when there is none', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(100_000n, 'inv');
  let broken = false;
  const ex = await startEsploraMock({ sim: w.btc, feeEstimates: { 3: 4 }, fail: (p) => broken && p === '/fee-estimates' });
  closers.push(ex.close);
  const clock = { t: 5_000_000 };
  const chain = esploraChain(w, [ex.base], { nowMs: () => clock.t });
  const s = await serve(w, { btc: { ...w.lBtc, feeRate: chain.feeRate } });
  const ask = async () => call(s.base, 'POST', '/quote', { amount: '5000' });
  const first = await ask();
  assert.equal(first.status, 200);
  assert.equal(first.body.takeSats, takeSatsAt(4));
  broken = true;
  clock.t += 10 * 60_000;
  const during = await ask();
  assert.equal(during.status, 200, 'the explorers are down: the quote is made on the estimate of ten minutes ago');
  assert.equal(during.body.takeSats, takeSatsAt(4));
  clock.t += 3 * 3600_000;
  assert.equal((await ask()).status, 500, 'with nothing recent to go on there is no quote');
  assert.ok(s.logs.some((l) => l.msg === 'a request failed' && /no explorer answered a fee estimate \(.* 500\)/.test(l.error)), 'and the log names the cause');
  broken = false;
  clock.t += 20_000;
  assert.equal((await ask()).status, 200);
});

test('a tick keeps the fee estimate warm without waiting for it, and a failure to read one is logged once', async () => {
  const { w } = httpWorld();
  const calls = [];
  let mode = 'hang';
  const feeRate = () => { calls.push(mode); return mode === 'hang' ? new Promise(() => {}) : mode === 'fail' ? Promise.reject(new Error('no explorer answered a fee estimate (x 429)')) : Promise.resolve(3); };
  const s = await service(w, { btc: { ...w.lBtc, feeRate } });
  const t0 = Date.now();
  await s.svc.tick();
  assert.ok(Date.now() - t0 < 2000, 'a tick does not wait for the explorers');
  assert.deepEqual(calls, ['hang']);
  mode = 'fail';
  await s.svc.tick(); await s.svc.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.logs.filter((l) => l.msg === 'no fee estimate').length, 1, 'one line however many ticks fail');
  assert.match(s.logs.find((l) => l.msg === 'no fee estimate').error, /x 429/);
  mode = 'ok';
  await s.svc.tick();
  await new Promise((r) => setTimeout(r, 20));
  mode = 'fail';
  await s.svc.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.logs.filter((l) => l.msg === 'no fee estimate').length, 2, 'and again when it fails after having worked');
});

test('a caller that wants the fee estimate newer than a quote needs it can have a read started early', async () => {
  const { w } = httpWorld();
  const est = { 3: 4 };
  const a = await startEsploraMock({ sim: w.btc, feeEstimates: est });
  closers.push(a.close);
  const clock = { t: 2_000_000 };
  const chain = esploraChain(w, [a.base], { nowMs: () => clock.t });
  const reads = () => a.state.gets.filter((p) => p === '/fee-estimates').length;
  assert.equal(await chain.feeRate(), 4);
  clock.t += 35_000;
  est[3] = 6;
  assert.equal(await chain.feeRate(), 4);
  assert.equal(reads(), 1, 'a quote is content with an estimate of 35 seconds ago');
  assert.equal(await chain.feeRate(30_000), 6, 'a caller that wants it under 30 seconds old reads again');
  assert.equal(reads(), 2);
  assert.equal(await chain.feeRate(), 6);
  assert.equal(reads(), 2);
});

test('a tick reads the pool inventory again before it is too old, and a quote meanwhile goes on the one it has', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(100_000n, 'inv');
  let calls = 0, gate = null;
  const evm = { ...w.lEvmCtx, available: async () => { calls++; if (gate) await gate; return w.lEvmCtx.available(); } };
  const s = await serve(w, { evm });
  const ask = () => Promise.race([call(s.base, 'POST', '/quote', { amount: '5000' }), new Promise((_, no) => setTimeout(() => no(new Error('the quote waited for the inventory read')), 3000))]);
  assert.equal((await ask()).status, 200);
  const first = calls;
  assert.ok(first >= 1);
  w.clock.advance(20);
  await s.svc.tick();
  assert.equal(calls, first, 'twenty seconds old is young enough: no new read');
  w.clock.advance(20);
  let release;
  gate = new Promise((r) => { release = r; });
  await s.svc.tick();
  assert.equal(calls, first + 1, 'forty seconds is past half of the minute a quote accepts: the tick starts a read');
  assert.equal((await ask()).status, 200, 'a quote does not wait for that read');
  assert.equal(calls, first + 1, 'and starts none of its own');
  release(); gate = null;
  await new Promise((r) => setTimeout(r, 30));
  w.clock.advance(25);
  assert.equal((await ask()).status, 200);
  assert.equal(calls, first + 1, 'the read made in the background is the one a quote finds, 25 seconds on');
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

// ── a provider that does not take TAC the bridge's proof cannot follow ──

test('a provider with a screen looks at the notes a lock spends: one it refuses ends the swap before anything is locked in the pool, one it passes goes through', async () => {
  // refused: the user's lock waits out its timelock and nothing is stored or locked by the provider
  {
    const { w, ref } = httpWorld();
    w.lEvm.fund(VALUE, 'same-size');
    const seen = [];
    const screen = async (notes) => { seen.push(notes); return { why: 'a note this lock spends has a history the bridge\'s proof does not follow, which this provider does not take' }; };
    const s = await serve(w, { config: configFor(w, { policy: { screen } }) });
    ref.base = s.base;
    const q = await makeHttpCounter({ base: s.base, fetchImpl: realFetch }).quote(VALUE);
    await startSwap(w, q);
    await w.run(async () => (await w.user())?.phase === 'refund-wait');
    assert.match((await w.user()).why, /history the bridge's proof does not follow/);
    assert.equal(w.evm.locks.leaves.length, 0, 'no lock in the pool');
    assert.deepEqual(await w.lpStore.list(), [], 'and the provider kept nothing');
    assert.ok(seen.length && seen[0].length >= 1 && seen[0].every((n) => /^[0-9a-f]{64}$/.test(n.txid) && Number.isInteger(n.vout)), 'it was handed the notes the lock spends (not the commit)');
  }
  // passed: the swap goes through as it does with no screen
  {
    const { w, ref } = httpWorld();
    w.lEvm.fund(VALUE, 'same-size-2');
    let asked = 0;
    const s = await serve(w, { config: configFor(w, { policy: { screen: async () => { asked++; return null; } } }) });
    ref.base = s.base;
    const q = await makeHttpCounter({ base: s.base, fetchImpl: realFetch }).quote(VALUE);
    await startSwap(w, q);
    await w.run(bothDone(w));
    assert.ok(asked >= 1);
    assert.equal(w.evm.locks.leaves.length, 1);
    assert.ok((await w.lp()).take, 'the provider took the Bitcoin lock');
  }
});

test('a screen that cannot look (the service is down) is asked again and does not end the swap: the lock goes on once it can', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(VALUE, 'same-size-3');
  let up = false, asked = 0;
  const screen = async () => { asked++; if (!up) throw new Error('down'); return null; };
  const s = await serve(w, { config: configFor(w, { policy: { screen } }) });
  ref.base = s.base;
  const q = await makeHttpCounter({ base: s.base, fetchImpl: realFetch }).quote(VALUE);
  await startSwap(w, q);
  await w.run(async () => asked >= 2);
  assert.notEqual((await w.user()).phase, 'refund-wait', 'not given up on');
  assert.equal(w.evm.locks.leaves.length, 0, 'nothing locked while the notes cannot be looked at');
  up = true;
  await w.run(bothDone(w));
  assert.equal(w.evm.locks.leaves.length, 1);
});

test('a provider says in its terms whether it takes any TAC: it does unless it is set not to', async () => {
  const { w } = httpWorld();
  const a = await serve(w, { config: configFor(w) });
  assert.equal((await makeHttpCounter({ base: a.base, fetchImpl: realFetch }).info()).anyTac, true);
  const b = await serve(w, { config: { ...configFor(w), anyTac: false } });
  assert.equal((await makeHttpCounter({ base: b.base, fetchImpl: realFetch }).info()).anyTac, false);
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
