import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFileStore, makeMemoryStore } from '../fastbridge-lp/lib/store.mjs';
import { makeStuckPricing, sameNoteInputs } from '../dapp/fastbridge-stuck-pricing.js';
import { makeCounter } from '../dapp/fastbridge-http.js';
import { makeFastBridgeClient, makeFastBridgeMarket } from '../dapp/fastbridge-client.js';
import { configFor, service, startSwap, bothDone } from './lib/lp-harness.mjs';
import { world, VALUE } from './lib/fastbridge-world.mjs';

const a = { txid: 'a'.repeat(64), vout: 0 };
const b = { txid: 'b'.repeat(64), vout: 1 };
const key = (n) => `${n.txid}:${n.vout}`;
const config = { longHaircutBps: 800, shieldedHaircutBps: 1500, longLimit: '250', shieldedLimit: '100', totalLimit: '300', openingLong: '0', openingShielded: '0' };
const pricing = (states) => makeStuckPricing(config, async (notes) => new Map(notes.map((n) => [key(n), states[n.txid[0]]])));

test('near-limit notes and mixed inputs are priced conservatively', async () => {
  const p = pricing({ a: { state: 'traced', hops: 255 }, b: { state: 'unprovable', through: 'shielded' } });
  assert.equal(await p.classify([a]), 'long');
  assert.equal(await p.classify([a, b]), 'shielded');
  assert.equal(await pricing({ a: { state: 'traced', hops: 253 } }).classify([a]), 'clean');
  assert.equal(await pricing({ a: { state: 'traced', hops: 254 } }).classify([a]), 'long');
  assert.equal(await pricing({ a: { state: 'long', hops: 256 } }).classify([a]), 'long');
  assert.equal(p.haircutFee(101n, 'long'), 9n);
});
test('unknown provenance is not treated as a known cheap or expensive class', async () => {
  await assert.rejects(pricing({ a: { state: 'unread' } }).classify([a]), { status: 503 });
  await assert.rejects(pricing({ a: { state: 'unprovable', through: 'other' } }).classify([a]), { status: 422 });
});
test('missing class prices cannot silently turn risky TAC into clean TAC', () => {
  for (const field of ['longHaircutBps', 'shieldedHaircutBps']) {
    const incomplete = { ...config };
    delete incomplete[field];
    assert.throws(() => makeStuckPricing(incomplete, longReader), /positive haircut/);
  }
});
test('an unsupported or unread input blocks a mixed quote in either order', async () => {
  for (const state of [{ state: 'unprovable', through: 'other' }, { state: 'unread' }]) {
    const p = pricing({ a: { state: 'long' }, b: state });
    const status = state.state === 'unread' ? 503 : 422;
    for (const notes of [[a, b], [b, a]]) await assert.rejects(p.classify(notes), { status });
  }
});
test('quote binding checks complete ordered inputs', () => {
  assert(sameNoteInputs([a, b], [a, b]));
  assert(!sameNoteInputs([a, b], [b, a]));
  assert(!sameNoteInputs([a], [a, b]));
  assert(!sameNoteInputs([a, a], [a, a]));
});
test('exposure limits apply per class and in total', () => {
  const p = pricing({});
  assert(p.fits({ long: 200n, shielded: 0n }, 'long', 50n));
  assert(!p.fits({ long: 200n, shielded: 0n }, 'long', 51n));
  assert(!p.fits({ long: 250n, shielded: 0n }, 'shielded', 51n));
});

test('a note is traced once and its class cached by input set', async () => {
  let reads = 0;
  const p = makeStuckPricing(config, async (notes) => { reads++; return new Map(notes.map((n) => [key(n), { state: 'long' }])); });
  assert.equal(await p.classify([a], { background: true }), 'long');
  assert.equal(await p.classify([a], { background: true }), 'long');
  assert.equal(reads, 1, 'the same note is traced once');
  assert.equal(await p.classify([a, b], { background: true }), 'long');
  assert.equal(await p.classify([b, a], { background: true }), 'long');
  assert.equal(reads, 2, 'a set of notes is one key regardless of order');
});

test('an unreadable or unsupported history is not cached', async () => {
  let state = { state: 'unread' }, reads = 0;
  const p = makeStuckPricing(config, async (notes) => { reads++; return new Map(notes.map((n) => [key(n), state])); });
  await assert.rejects(p.classify([a], { background: true }), { status: 503 });
  state = { state: 'long' };
  assert.equal(await p.classify([a], { background: true }), 'long');
  assert.equal(reads, 2, 'a failed read is not cached');
});

test('opening exposure counts against the class and total caps', () => {
  const p = makeStuckPricing({ ...config, openingLong: '100', openingShielded: '50' }, async () => new Map());
  assert(p.fits({ long: 0n, shielded: 0n }, 'long', 150n));
  assert(!p.fits({ long: 0n, shielded: 0n }, 'long', 151n));
  assert(p.fits({ long: 0n, shielded: 0n }, 'shielded', 50n));
  assert(!p.fits({ long: 0n, shielded: 0n }, 'shielded', 51n));
  // the total cap binds before the per-class cap when other exposure sits in it
  assert(p.fits({ long: 0n, shielded: 100n }, 'long', 50n));
  assert(!p.fits({ long: 0n, shielded: 100n }, 'long', 51n));
});

test('an opening exposure already past a cap reports a blocked state, not an error', () => {
  assert.equal(makeStuckPricing(config, async () => new Map()).blocked, null);
  assert.equal(makeStuckPricing({ ...config, openingLong: '250' }, async () => new Map()).blocked, null);
  // each class on its own, and the two together past the total
  assert.match(makeStuckPricing({ ...config, openingLong: '251' }, async () => new Map()).blocked, /opening exposure exceeds/);
  assert.match(makeStuckPricing({ ...config, openingShielded: '101' }, async () => new Map()).blocked, /opening exposure exceeds/);
  assert.match(makeStuckPricing({ ...config, openingLong: '220', openingShielded: '90' }, async () => new Map()).blocked, /opening exposure exceeds/);
});

test('a class over its opening cap does not pause an unrelated class within the total cap', () => {
  const p = makeStuckPricing({ ...config, openingLong: '251' }, async () => new Map());
  assert(!p.fits({ long: 0n, shielded: 0n }, 'long', 1n));
  assert(p.fits({ long: 0n, shielded: 0n }, 'shielded', 49n));
  assert(!p.fits({ long: 0n, shielded: 0n }, 'shielded', 50n));
  assert.match(p.blocked, /independent class and total limits still apply/);
});

const largeConfig = {
  ...config, longLimit: '5000', shieldedLimit: '5000', totalLimit: '5000',
};
const noteRef = ({ txid, vout }) => ({ txid, vout });
const longReader = async (notes) => new Map(notes.map((n) => [key(n), { state: 'long' }]));
const post = (svc, path, body, client) => svc.handle({ method: 'POST', path, body, client });
async function pricedQuote(svc, body) {
  let result = await post(svc, '/quote', body);
  for (let i = 0; result.status === 202 && i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    result = await post(svc, '/quote', { ...body, checkId: result.body.checkId });
  }
  return result;
}

test('nonzero normal and flat fees add to a rounded haircut through settlement and restart', async (t) => {
  let lp;
  const w = world({ funds: 10, userCounter: () => makeCounter((method, path, body) => lp.svc.handle({ method, path, body })) });
  const dir = mkdtempSync(join(tmpdir(), 'tacit-stuck-additive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const boot = () => service(w, {
    config: { ...configFor(w, { quote: { feeBps: 100, flatFee: '10' } }), stuckPricing: makeStuckPricing({ ...largeConfig, longHaircutBps: 801 }, longReader) },
    quoteStore: makeFileStore(join(dir, 'quotes')), swaps: makeFileStore(join(dir, 'swaps')),
  });
  lp = await boot();
  w.lEvm.fund(4539n, 'additive-payout');
  const inputs = [noteRef(w.note)];
  const small = await pricedQuote(lp.svc, { amount: '1001', noteInputs: inputs });
  assert.equal(small.body.evmAmount, '900', '1001 minus normal 10, flat 10 and rounded-up haircut 81');
  const plain = await post(lp.svc, '/quote', { amount: String(VALUE) });
  assert.equal(plain.body.evmAmount, '4940', 'clean/legacy quotes keep the normal 50 and flat 10');
  const q = (await pricedQuote(lp.svc, { amount: String(VALUE), noteInputs: inputs })).body;
  assert.equal(q.evmAmount, '4539', '5000 minus normal 50, flat 10 and rounded-up haircut 401');
  assert.equal((await post(lp.svc, '/reserve', { quoteId: q.id })).body.ok, true);
  await startSwap(w, q);
  lp = await boot();
  await w.run(bothDone(w));
  assert.equal((await w.lp()).offer.evm.amount, '4539');
  assert.deepEqual((await w.lp()).stuckExposure, { kind: 'long', amount: '5000' });
  lp = await boot();
  assert.equal((await pricedQuote(lp.svc, { amount: '1000', noteInputs: [b] })).status, 409,
    'confirmed take remains stuck inventory after restart until verified recovery');
});

test('new quote stays bound through completion and a provider restart', async (t) => {
  let lp;
  const w = world({ funds: 10, userCounter: () => makeCounter((method, path, body) => lp.svc.handle({ method, path, body })) });
  const dir = mkdtempSync(join(tmpdir(), 'tacit-stuck-pricing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const boot = (cfg = largeConfig) => service(w, {
    config: { ...configFor(w), stuckPricing: makeStuckPricing(cfg, longReader) },
    quoteStore: makeFileStore(join(dir, 'quotes')), swaps: makeFileStore(join(dir, 'swaps')),
  });
  lp = await boot();
  w.lEvm.fund(4600n, 'classified-payout');
  const inputs = [noteRef(w.note)];
  const client = makeFastBridgeClient({
    lp: makeCounter((method, path, body) => lp.svc.handle({ method, path, body })),
    btc: w.uBtc, evm: w.uEvmCtx, store: w.userStore, seed: w.uKeys.seed, now: w.clock.now,
  });
  const plain = await client.quote(VALUE);
  assert.equal(plain.lineagePricing, true);
  assert.equal(plain.evmAmount, 5000n);
  const market = makeFastBridgeMarket({ counterFor: () => {}, makeClient: () => client, waitForQuote: () => new Promise((resolve) => setImmediate(resolve)) });
  const priced = (await market.quoteAll([{ ref: null }], VALUE, { selectNoteInputs: () => inputs, timeoutMs: 60 })).quotes[0].quote;
  assert.equal(priced.noteClass, 'long');
  assert.equal(priced.evmAmount, 4600n);
  await assert.rejects(client.start({ quote: priced, notes: [{ ...w.note, txid: b.txid }] }), /notes are no longer available/);
  await client.start({ quote: priced, notes: [w.note] });
  lp = await boot();
  const blocked = await pricedQuote(lp.svc, { amount: '1000', noteInputs: [b] });
  assert.equal(blocked.status, 409, 'an outstanding reservation survives restart');
  await w.run(bothDone(w));
  assert.deepEqual((await w.lp()).stuckExposure, { kind: 'long', amount: '5000' });
  lp = await boot();
  assert.equal((await pricedQuote(lp.svc, { amount: '1000', noteInputs: [b] })).status, 409, 'completed inventory still occupies the cap');
  lp = await boot({ ...largeConfig, recoveredSwaps: [(await w.lp()).id] });
  assert.equal((await pricedQuote(lp.svc, { amount: '1000', noteInputs: [b] })).status, 200, 'operator reconciliation restores capacity');
});

test('one of two concurrent reservations fits, even from different clients', async () => {
  const w = world({ funds: 10 });
  const { svc } = await service(w, { config: { ...configFor(w), stuckPricing: makeStuckPricing(largeConfig, longReader) } });
  const q1 = (await pricedQuote(svc, { amount: '3000', noteInputs: [a] })).body;
  const q2 = (await pricedQuote(svc, { amount: '3000', noteInputs: [b] })).body;
  const results = await Promise.all([post(svc, '/reserve', { quoteId: q1.id }, 'client-a'), post(svc, '/reserve', { quoteId: q2.id }, 'client-b')]);
  assert.deepEqual(results.map((r) => r.body.ok).sort(), [false, true]);
  w.clock.advance(301);
  assert.equal((await post(svc, '/reserve', { quoteId: q2.id }, 'client-b')).body.ok, true);
});

test('on-chain substituted input is refused before any Ethereum settlement', async () => {
  let captured;
  const w = world({ funds: 10, userCounter: () => ({
    sendOffer: async (offer) => { captured = offer; return { ok: true }; },
    getEvmOffer: async () => null,
  }) });
  const { svc, swaps } = await service(w, { config: { ...configFor(w), stuckPricing: makeStuckPricing(largeConfig, longReader) } });
  const q = (await pricedQuote(svc, { amount: String(VALUE), noteInputs: [a] })).body;
  assert.equal((await post(svc, '/reserve', { quoteId: q.id })).body.ok, true);
  const rec = await startSwap(w, q);
  await w.userBl.step(rec);
  w.btc.mine(1, { advance: false });
  await w.userBl.step(rec);
  assert(captured?.offer);
  const r = await post(svc, '/offer', captured);
  assert.equal(r.body.ok, false);
  assert.match(r.body.why, /inputs differ/);
  assert.deepEqual(await swaps.list(), []);
});

test('legacy amount-only quotes work on clean notes without trusting an unpriced risky lock', async () => {
  let captured;
  const w = world({ funds: 10, userCounter: () => ({
    sendOffer: async (offer) => { captured = offer; return { ok: true }; },
    getEvmOffer: async () => null,
  }) });
  let verdict = { state: 'long' };
  const pricing = makeStuckPricing(largeConfig, async (notes) => new Map(notes.map((n) => [key(n), verdict])));
  const { svc } = await service(w, { config: { ...configFor(w), stuckPricing: pricing } });
  const q = (await post(svc, '/quote', { amount: String(VALUE) })).body;
  const rec = await startSwap(w, q);
  await w.userBl.step(rec);
  w.btc.mine(1, { advance: false });
  await w.userBl.step(rec);
  assert(captured?.offer);
  const r = await post(svc, '/offer', captured);
  assert.match(r.body.why, /needs a note-specific quote/);
  verdict = { state: 'traced', hops: 253 };
  assert.equal((await post(svc, '/offer', captured)).body.ok, true);
});

test('an in-flight offer holds its exposure while its lock is read', async () => {
  let captured, markCalled, release;
  const called = new Promise((resolve) => { markCalled = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const w = world({ funds: 10, userCounter: () => ({
    sendOffer: async (offer) => { captured = offer; return { ok: true }; },
    getEvmOffer: async () => null,
  }) });
  const btc = { ...w.lBtc, fetchTx: async (txid) => { markCalled(); await gate; return w.lBtc.fetchTx(txid); } };
  const { svc } = await service(w, { config: { ...configFor(w), stuckPricing: makeStuckPricing(largeConfig, longReader) }, btc });
  const q = (await pricedQuote(svc, { amount: String(VALUE), noteInputs: [noteRef(w.note)] })).body;
  assert.equal((await post(svc, '/reserve', { quoteId: q.id })).body.ok, true);
  const rec = await startSwap(w, q);
  await w.userBl.step(rec);
  w.btc.mine(1, { advance: false });
  await w.userBl.step(rec);
  assert(captured?.offer, 'the offer was made');
  const offerPromise = post(svc, '/offer', captured);
  await called; // the offer reached the lock read, so its exposure is in flight
  w.clock.advance(600); // the reservation lapses; only the in-flight offer still holds the exposure
  assert.equal((await pricedQuote(svc, { amount: '1000', noteInputs: [b] })).status, 409, 'the in-flight offer still occupies the cap');
  release();
  const r = await offerPromise;
  assert.equal(r.body.ok, true);
  assert.equal(r.body.phase, 'accepted');
});

test('a cold quote is polled by the same check ID, while ordinary quotes continue', async () => {
  const w = world({ funds: 10 });
  let finish, reads = 0, report;
  const blocked = new Promise((resolve) => { finish = resolve; });
  const reader = async (notes, { onProgress } = {}) => {
    reads++;
    report = onProgress;
    await blocked;
    return longReader(notes);
  };
  const { svc, quoteStore } = await service(w, { config: { ...configFor(w), stuckPricing: makeStuckPricing(largeConfig, reader) } });
  const body = { amount: '3000', noteInputs: [a] };
  const first = await post(svc, '/quote', body);
  assert.equal(first.status, 202);
  assert.match(first.body.checkId, /^[a-f0-9]{32}$/);
  report(40);
  const resumed = await post(svc, '/quote', { ...body, checkId: first.body.checkId });
  assert.equal(resumed.status, 202);
  assert.equal(resumed.body.transfersRead, 40);
  assert.equal((await post(svc, '/quote', body)).body.checkId, first.body.checkId);
  assert.equal(reads, 1);
  assert.deepEqual(await quoteStore.list(), []);
  assert.equal((await post(svc, '/quote', { ...body, noteInputs: [b], checkId: first.body.checkId })).status, 410);
  assert.equal((await post(svc, '/quote', { amount: body.amount })).status, 200);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  const request = { ...body, checkId: first.body.checkId };
  const [final, repeat] = await Promise.all([post(svc, '/quote', request), post(svc, '/quote', request)]);
  assert.equal(final.status, 200);
  assert.equal(final.body.evmAmount, '2760');
  assert.equal(repeat.body.id, final.body.id);
  assert.equal(reads, 1);
  w.clock.advance(61);
  assert.equal((await post(svc, '/quote', request)).status, 410);

});

test('stuck exposure is released by a refund or an operator-verified recovery, never by an unfinished record', async () => {
  const w = world({ funds: 10 });
  const swaps = makeMemoryStore();
  const id = 'a'.repeat(72), other = 'b'.repeat(72);
  const rec = (phase, amount) => ({ id, v: 1, role: 'el', phase, quoteId: 'c'.repeat(32), lock: null, stuckExposure: { kind: 'long', amount: String(amount) }, created: 1, updated: 1 });
  // a 1000 TAC long quote against a 1500 TAC cap: one 1000 TAC long swap already held blocks a second
  const cfg = (recovered = []) => makeStuckPricing({ ...largeConfig, longLimit: '1500', shieldedLimit: '1500', totalLimit: '1500', recoveredSwaps: recovered }, longReader);
  const boot = (recovered) => service(w, { config: { ...configFor(w), stuckPricing: cfg(recovered) }, swaps, quoteStore: makeMemoryStore() });
  const ask = (svc) => pricedQuote(svc, { amount: '1000', noteInputs: [a] });

  await swaps.put(rec('done', 1000));
  let { svc } = await boot();
  assert.equal((await ask(svc)).status, 409, 'a completed swap occupies the cap until reconciled');

  await swaps.put(rec('refunded', 1000));
  ({ svc } = await boot());
  assert.equal((await ask(svc)).status, 200, 'a refunded swap releases its exposure');

  await swaps.put(rec('lost', 1000));
  ({ svc } = await boot());
  assert.equal((await ask(svc)).status, 200, 'a lost swap holds no stuck TAC and releases its exposure');

  await swaps.put(rec('taking', 1000));
  ({ svc } = await boot([id]));
  assert.equal((await ask(svc)).status, 409, 'the recovery flag only releases a completed swap');

  await swaps.put(rec('done', 1000));
  ({ svc } = await boot([other]));
  assert.equal((await ask(svc)).status, 409, 'an unmatched recovery flag changes nothing');

  ({ svc } = await boot([id]));
  assert.equal((await ask(svc)).status, 200, 'an operator-verified recovery releases the cap');
});

test('unreadable exposure records stop classified quotes but not ordinary ones', async () => {
  const w = world({ funds: 10 });
  const swaps = { ...makeMemoryStore(), problems: () => [{ id: 'broken', error: 'unreadable' }] };
  const { svc } = await service(w, { config: { ...configFor(w), stuckPricing: makeStuckPricing(largeConfig, longReader) }, swaps, quoteStore: makeMemoryStore() });
  assert.equal((await pricedQuote(svc, { amount: '1000', noteInputs: [a] })).status, 503, 'a classified quote cannot be priced from unreadable records');
  assert.equal((await post(svc, '/quote', { amount: '1000' })).status, 200, 'an ordinary amount-only quote still works');
});
