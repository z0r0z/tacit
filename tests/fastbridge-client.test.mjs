// The page's client (dapp/fastbridge-client.js) against the LP service on a socket and the simulated Bitcoin and pool: the
// terms and quotes it accepts and refuses, the notes it picks, a whole swap, a swap carried on by a new instance, a swap that
// ends in the refund, a lock found again from the key alone, and the words for each phase.
//   node tests/fastbridge-client.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { realFetch } from './lib/real-fetch.mjs';
import { bigintToBytes32 } from '../dapp/bulletproofs.js';
import { bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import * as X from '../dapp/adaptor-xswap.js';
import { makeHttpCounter } from '../dapp/fastbridge-http.js';
import { makeFastBridgeClient, makeFastBridgeMarket, makeLocalStore, describe, termsOf, QUOTE_WAIT_MS, fairTakeAt, TAKE_FLAG, TAKE_FAIR, noWorse } from '../dapp/fastbridge-client.js';
import { takeSatsAt } from '../dapp/fastbridge-provider.js';
import { fetched } from './lib/btc-sim.mjs';
import { pool, ASSET } from './lib/chain-sim.mjs';
import { VALUE, memStore } from './lib/fastbridge-world.mjs';
import { closers, configFor, serve, httpWorld, bothDone } from './lib/lp-harness.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const pinsOf = (w) => ({ claimPub: bytesToHex(w.lW.wallet.pub), btcAsset: bytesToHex(w.etch.asset), evmAsset: ASSET });
function clientFor(w, lp, over = {}) {
  return makeFastBridgeClient({ lp, btc: w.uBtc, evm: w.uEvmCtx, store: w.userStore, seed: w.uKeys.seed, now: w.clock.now, pins: pinsOf(w), ...over });
}
const counterAt = (base) => makeHttpCounter({ base, fetchImpl: realFetch });
const NET = VALUE - (VALUE * 30n) / 10000n - 200n;
const feeConfig = (w) => configFor(w, { quote: { feeBps: 30, flatFee: 200 } });

// a provider that answers what a test says, for the quotes a real one would not give
function fakeLp(w, over = {}) {
  const good = { id: 'a'.repeat(32), btcAsset: bytesToHex(w.etch.asset), btcValue: String(VALUE), evmAsset: ASSET, evmAmount: String(NET), claimPub: bytesToHex(w.lW.wallet.pub), csvBlocks: 144, evmWindowSecs: 14400, minConfs: 1, created: w.clock.now(), validUntil: w.clock.now() + 600 };
  return { info: async () => ({ claimPub: good.claimPub, btcAsset: good.btcAsset, evmAsset: good.evmAsset, minAmount: '1000', maxAmount: '1000000', feeBps: 30, flatFee: '200', csvBlocks: 144, evmWindowSecs: 14400 }), quote: async () => ({ ...good, ...over }), sendOffer: async () => ({ ok: true }), getEvmOffer: async () => null };
}

test('terms and quote: the provider\'s numbers, the fee in base units, and a refusal for a key or asset the page did not pin', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(NET, 'net');
  const s = await serve(w, { config: feeConfig(w) });
  const fb = clientFor(w, counterAt(s.base));
  const t = await fb.terms();
  assert.equal(t.claimPub, bytesToHex(w.lW.wallet.pub));
  assert.deepEqual([t.minAmount, t.maxAmount, t.feeBps, t.flatFee, t.csvBlocks], [1000n, 1_000_000n, 30, 200n, 144]);
  const q = await fb.quote(VALUE);
  assert.deepEqual([q.btcValue, q.evmAmount, q.fee, q.csvBlocks], [VALUE, NET, VALUE - NET, 144]);
  const other = (k, v) => clientFor(w, counterAt(s.base), { pins: { ...pinsOf(w), [k]: v } });
  await assert.rejects(() => other('claimPub', '02' + 'ab'.repeat(32)).terms(), /key is not the one this page expects/);
  await assert.rejects(() => other('claimPub', '02' + 'ab'.repeat(32)).quote(VALUE), /key is not the one this page expects/);
  await assert.rejects(() => other('btcAsset', 'cd'.repeat(32)).terms(), /asset is not the one this page expects/);
  await assert.rejects(() => other('evmAsset', 'cd'.repeat(32)).quote(VALUE), /asset is not the one this page expects/);
  assert.equal((await clientFor(w, counterAt(s.base), { pins: {} }).terms()).claimPub, bytesToHex(w.lW.wallet.pub), 'with nothing pinned the provider\'s own terms stand');
});

test('a quote the page will not show: unreadable, for another amount, a payout above the amount, a fee over the limit, a timelock out of range, too little time', async () => {
  const { w } = httpWorld();
  const cases = [
    [{ id: 7 }, /not readable/], [{ id: 'q'.repeat(200) }, /not readable/], [{ claimPub: 'zz' }, /not readable/], [{ btcValue: String(VALUE + 1n) }, /different amount/],
    [{ evmAmount: String(VALUE + 1n) }, /payout is out of range/], [{ evmAmount: '0' }, /payout is out of range/], [{ evmAmount: '12' }, /fee is above the limit/],
    [{ csvBlocks: 10 }, /timelock is out of range/], [{ csvBlocks: 5000 }, /timelock is out of range/], [{ validUntil: w.clock.now() + 30 }, /expires too soon/],
    [{ btcValue: 'ten' }, /not a number/],
  ];
  for (const [over, re] of cases) await assert.rejects(() => clientFor(w, fakeLp(w, over)).quote(VALUE), re, JSON.stringify(over));
  const ok = await clientFor(w, fakeLp(w)).quote(VALUE);
  assert.equal(ok.evmAmount, NET);
  const loose = await clientFor(w, fakeLp(w, { evmAmount: '12' }), { policy: { maxFeeBps: 10000 } }).quote(VALUE);
  assert.equal(loose.evmAmount, 12n, 'the fee limit is the page\'s to set');
  // a provider prices as it likes: a fee over 5% is quoted and flagged for the page to say so, one over 90% is not quoted
  assert.equal(ok.highFee, false);
  const dear = await clientFor(w, fakeLp(w, { evmAmount: String(VALUE - (VALUE * 8n) / 100n) })).quote(VALUE);
  assert.deepEqual([dear.highFee, dear.evmAmount], [true, VALUE - (VALUE * 8n) / 100n]);
  const edge = await clientFor(w, fakeLp(w, { evmAmount: String(VALUE - (VALUE * 5n) / 100n) })).quote(VALUE);
  assert.equal(edge.highFee, false, 'exactly 5% is not high');
  await assert.rejects(() => clientFor(w, fakeLp(w, { evmAmount: String(VALUE / 10n - 1n) })).quote(VALUE), /fee is above the limit/);
});

test('a take far above its cost at the page\'s own fee rate is flagged and sorts last, and the page\'s formula is the providers\'', async () => {
  for (const r of [1, 2, 5, 13, 60, 400]) assert.equal(fairTakeAt(r), takeSatsAt(r), `the same take at ${r} sat/vB`);
  const { w } = httpWorld();
  const rate = await w.uBtc.feeRate(), fair = fairTakeAt(rate);
  const at = async (take) => (await clientFor(w, fakeLp(w, { takeSats: take }), { policy: { maxTakeSats: 10_000_000 } }).quote(VALUE)).highTake;
  assert.equal(await at(fair), false, 'a take at its cost is not flagged');
  assert.equal(await at(fair * TAKE_FLAG), false, 'twice its cost is not');
  assert.equal(await at(fair * TAKE_FLAG + 1), true, 'more than twice its cost is');
  assert.equal(await at(0), false, 'no take is not');
  assert.equal(await at(30_000), 30_000 > fair * TAKE_FLAG, 'the most a page pays by default is judged by the same rule');
  // with no fee rate to compare with nothing is flagged
  const blind = await clientFor(w, fakeLp(w, { takeSats: 30_000 }), { btc: { ...w.uBtc, feeRate: async () => { throw new Error('no rate'); } } }).quote(VALUE);
  assert.equal(blind.highTake, false, 'with no rate to compare with, nothing is flagged');
  // an open market: every provider is quoted; the one asking a take far above its cost is last whatever it pays
  const fakes = {
    greedy: { quote: async (a) => ({ id: 'q-greedy', evmAmount: BigInt(a) - 1n, highTake: true }) },
    fair: { quote: async (a) => ({ id: 'q-fair', evmAmount: BigInt(a) - 80n, highTake: false }) },
    fairer: { quote: async (a) => ({ id: 'q-fairer', evmAmount: BigInt(a) - 50n }) },
  };
  const market = makeFastBridgeMarket({ btc: {}, evm: {}, store: memStore(), seed: new Uint8Array(32), counterFor: () => null, makeClient: ({ provider }) => fakes[provider.id] });
  const providers = Object.keys(fakes).map((id) => ({ id, name: id, ref: { kind: 'http', id, claimPub: id } }));
  const got = await market.quoteAll(providers, 1000n, { timeoutMs: 30 });
  assert.deepEqual(got.quotes.map((x) => x.provider.id), ['fairer', 'fair', 'greedy'], 'none is dropped, and the flagged one is last although it pays most');
});

test('a take above fair is ranked after every fair one, a fee above the provider\'s own terms or the want\'s price likewise, and a rate read before stands in for one that cannot be read', async () => {
  const { w } = httpWorld();
  const rate = await w.uBtc.feeRate(), fair = fairTakeAt(rate);
  const q = async (take, btc = w.uBtc) => clientFor(w, fakeLp(w, { takeSats: take }), { btc, policy: { maxTakeSats: 10_000_000 } }).quote(VALUE);
  assert.equal((await q(fair)).takeAbove, false);
  assert.equal((await q(Math.floor(fair * TAKE_FAIR))).takeAbove, false, 'up to the tolerance is fair');
  assert.equal((await q(Math.floor(fair * TAKE_FAIR) + 1)).takeAbove, true, 'above it is not');
  // the same reader, its rate gone for a moment: the last rate read is used
  let up = true; const flaky = { ...w.uBtc, feeRate: async () => { if (up) return w.uBtc.feeRate(); throw new Error('no rate'); } };
  await q(fair, flaky); up = false;
  const later = await q(Math.floor(fair * TAKE_FAIR) + 1, flaky);
  assert.deepEqual([later.takeAbove, later.takeUnjudged], [true, false], 'judged at the rate read before');
  const never = await q(30_000, { ...w.uBtc, feeRate: async () => { throw new Error('no rate'); } });
  assert.deepEqual([never.highTake, never.takeAbove, never.takeUnjudged], [false, false, true], 'never read: not judged, only ranked after');
  // ranking: fair takes first, then terms kept, then the payout
  const fakes = {
    bait: { quote: async (a) => ({ id: 'q-bait', btcValue: BigInt(a), evmAmount: BigInt(a) - 1n, fee: 1n, btcAsset: 'aa', evmAsset: 'aa', takeAbove: true }) },
    over: { quote: async (a) => ({ id: 'q-over', btcValue: BigInt(a), evmAmount: BigInt(a) - 40n, fee: 40n, btcAsset: 'aa', evmAsset: 'aa' }) },
    fair: { quote: async (a) => ({ id: 'q-fair', btcValue: BigInt(a), evmAmount: BigInt(a) - 50n, fee: 50n, btcAsset: 'aa', evmAsset: 'aa' }) },
  };
  const market = makeFastBridgeMarket({ btc: {}, evm: {}, store: memStore(), seed: new Uint8Array(32), counterFor: () => null, makeClient: ({ provider }) => fakes[provider.id] });
  const terms = { over: { feeBps: 0, flatFee: 10n }, fair: { feeBps: 500, flatFee: 0n }, bait: { feeBps: 10, flatFee: 0n } };
  const providers = Object.keys(fakes).map((id) => ({ id, name: id, ref: { kind: 'http', id, claimPub: id }, terms: terms[id] }));
  const got = await market.quoteAll(providers, 1000n, { timeoutMs: 30 });
  assert.deepEqual(got.quotes.map((x) => x.provider.id), ['fair', 'over', 'bait']);
  assert.deepEqual(got.quotes.map((x) => x.quote.aboveTerms), [false, true, false], 'a fee above the listed terms is marked');
  const noTerms = await market.quoteAll(providers.map(({ terms: _, ...p }) => p), 1000n, { timeoutMs: 30 });
  assert.ok(noTerms.quotes.every((x) => !x.quote.aboveTerms), 'a provider that lists no terms is judged as before');
  const priced = await market.quoteAll(providers, 1000n, { timeoutMs: 30, maxFeeBps: 450 });
  assert.deepEqual(priced.quotes.map((x) => [x.provider.id, x.quote.aboveWant]), [['over', false], ['fair', true], ['bait', false]], 'a want\'s price ranks the quote above it after');
});

test('a press starts only what was confirmed: a fallback that pays less, keeps more on Bitcoin, has a longer timelock or a new warning is not started', async () => {
  const base = { evmAmount: 990n, takeSats: 3000, csvBlocks: 144 };
  assert.ok(noWorse({ ...base }, base));
  assert.ok(noWorse({ ...base, evmAmount: 995n, takeSats: 2000 }, base), 'better on both is fine');
  assert.ok(!noWorse({ ...base, evmAmount: 989n }, base));
  assert.ok(!noWorse({ ...base, takeSats: 3001 }, base));
  assert.ok(!noWorse({ ...base, csvBlocks: 288 }, base));
  assert.ok(!noWorse({ ...base, highFee: true }, base));
  assert.ok(noWorse({ ...base, highFee: true }, { ...base, highFee: true }), 'a warning the holder already saw');
  const log = [];
  const fakes = {
    bait: { start: async () => { log.push('bait'); throw new Error('the provider cannot hold that amount'); } },
    dear: { start: async () => { log.push('dear'); return { id: 'swap-dear' }; } },
    same: { start: async () => { log.push('same'); return { id: 'swap-same' }; } },
  };
  const market = makeFastBridgeMarket({ btc: {}, evm: {}, store: memStore(), seed: new Uint8Array(32), counterFor: () => null, makeClient: ({ provider }) => fakes[provider.id] });
  const P = (id) => ({ id, name: id, ref: { kind: 'http', id, claimPub: id } });
  const confirmed = { id: 'q-bait', ...base };
  const dear = { provider: P('dear'), quote: { id: 'q-dear', ...base, evmAmount: 950n } };
  await assert.rejects(() => market.start({ quotes: [{ provider: P('bait'), quote: confirmed }, dear], notes: [], confirmed }), /cannot hold that amount/);
  assert.deepEqual(log, ['bait'], 'the dearer fallback is not started');
  await assert.rejects(() => market.start({ quotes: [dear], notes: [], confirmed }), (e) => e.code === 'quote-changed');
  log.length = 0;
  const same = { provider: P('same'), quote: { id: 'q-same', ...base } };
  const r = await market.start({ quotes: [{ provider: P('bait'), quote: confirmed }, dear, same], notes: [], confirmed });
  assert.deepEqual([log, r.provider.id], [['bait', 'same'], 'same'], 'one that is no worse is started');
});

test('a provider has 12 seconds to quote when the page does not say otherwise: room over the slowest quotes seen through a board, and one that never answers is given up on then', async () => {
  assert.equal(QUOTE_WAIT_MS, 12000);
  const waits = [], realSet = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => { if (ms >= 1000) waits.push(ms); return realSet(fn, ms, ...a); };
  try {
    const market = makeFastBridgeMarket({ btc: {}, evm: {}, store: memStore(), seed: new Uint8Array(32), counterFor: () => null, makeClient: () => ({ quote: async () => ({ id: 'q', btcValue: 1000n, evmAmount: 990n, fee: 10n, validUntil: 9e9 }) }) });
    await market.quoteAll([{ id: 'a', name: 'a', ref: { kind: 'http', claimPub: 'a' } }], 1000n);
  } finally { globalThis.setTimeout = realSet; }
  assert.ok(waits.includes(12000), `the wait asked of the timer is 12 s (${waits})`);
  assert.ok(!waits.includes(8000), 'and not the 8 s it was');
});

test('notes to lock: the smallest one that covers the amount, else the largest first, and none when they do not cover it', async () => {
  const { w } = httpWorld();
  const fb = clientFor(w, fakeLp(w));
  const n = (amount, i) => ({ txid: String(i).repeat(64), vout: 0, value: 546, amount, blinding: 1n });
  const pick = fb.pickNotes([n(900n, 1), n(5000n, 2), n(7000n, 3), n(20n, 4)], 5000n);
  assert.deepEqual([pick.notes.length, pick.notes[0].amount, pick.change], [1, 5000n, 0n]);
  const some = fb.pickNotes([n(900n, 1), n(3000n, 2), n(2500n, 3), n(20n, 4)], 5000n);
  assert.deepEqual([some.notes.map((x) => x.amount), some.change], [[3000n, 2500n], 500n]);
  assert.equal(fb.pickNotes([n(900n, 1), n(20n, 2)], 5000n), null);
  assert.equal(fb.pickNotes([], 5000n), null);
  const many = Array.from({ length: 9 }, (_, i) => n(100n, i + 1));
  assert.equal(fb.pickNotes(many, 800n), null, 'more inputs than one lock takes');
  assert.deepEqual(fb.pickNotes(many, 600n).notes.length, 6);
});

test('a whole swap through the client: quote, start, the steps in words, the pool note in the user\'s hands', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(NET, 'net');
  const s = await serve(w, { config: feeConfig(w) });
  ref.base = s.base;
  const fb = clientFor(w, counterAt(s.base));
  w.userTick = () => fb.tick();
  const q = await fb.quote(VALUE);
  const rec = await fb.start({ quote: q, notes: [w.note] });
  // the lock goes out at the press, while the quote and the provider's hold stand
  assert.equal((await fb.records())[0].title, 'Waiting for Bitcoin');
  const titles = new Set();
  await w.run(async () => { const r = (await fb.records())[0]; if (r) titles.add(r.title); return r?.phase === 'done' && (await w.lp())?.phase === 'done'; });
  const last = (await fb.records())[0];
  assert.deepEqual([last.title, last.ended, last.at, last.receive, last.returned], ['Done', true, 3, String(NET), false]);
  for (const t of ['Waiting for Bitcoin', 'Waiting for the pool lock', 'Claiming in the pool']) assert.ok(titles.has(t), `${t} was shown (${[...titles].join(', ')})`);
  const sec = X.deriveSwapSecrets({ seed: w.uKeys.seed, swapId: hexToBytes(rec.id) });
  const O = pool.commitXY(NET, '0x' + bytesToHex(bigintToBytes32(sec.rOut)));
  assert.ok(w.poolHolds(pool.leaf(ASSET, O.cx, O.cy, pool.nkToOwner(w.uKeys.nkOut))), 'the net amount is in the pool for the user');
  assert.deepEqual((await fb.tick()).map((r) => r.phase), ['done'], 'a finished swap is left alone');
  // the same note cannot start a second swap
  await assert.rejects(() => fb.start({ quote: q, notes: [w.note] }), /already part of a swap/);
});

test('the cost of a lock is read before anything is sent: its fee in sats, nothing stored, nothing broadcast, and a shortfall said with the figures', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(NET, 'net');
  const s = await serve(w, { config: feeConfig(w) });
  ref.base = s.base;
  const fb = clientFor(w, counterAt(s.base));
  const q = await fb.quote(VALUE);
  const c = await fb.cost({ quote: q, notes: [w.note] });
  assert.equal(c.short, false);
  assert.ok(c.fee > 0 && c.total === c.fee + (q.takeSats || 0), `a fee and the take make the total (${JSON.stringify(c)})`);
  assert.deepEqual(await w.userStore.list(), [], 'a dry run stores nothing');
  // the same address with no plain sats: the figures it lacks
  const poor = clientFor(w, counterAt(s.base), {});
  const real = w.uBtc.satsUtxos;
  w.uBtc.satsUtxos = async () => [];
  const c2 = await poor.cost({ quote: q, notes: [w.note] });
  w.uBtc.satsUtxos = real;
  assert.equal(c2.short, true); assert.equal(c2.have, 0); assert.ok(c2.need > 0);
  assert.deepEqual(await w.userStore.list(), [], 'and still nothing stored');
});

test('a note held by a swap that is not over is not offered to another: the second press says so, and it is free again when the swap ends', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(NET, 'net');
  const s = await serve(w, { config: feeConfig(w) });
  ref.base = s.base;
  const fb = clientFor(w, counterAt(s.base));
  const q = await fb.quote(VALUE);
  await fb.start({ quote: q, notes: [w.note] });
  await assert.rejects(() => fb.start({ quote: q, notes: [w.note] }), /already part of a swap/);
  assert.deepEqual(await fb.cost({ quote: q, notes: [w.note] }), { short: false, noNotes: true }, 'nothing to price while the note is held');
});

test('two tabs pressing the same note at once: one starts it, the other waits and finds the first one\'s swap', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(NET, 'net');
  const s = await serve(w, { config: feeConfig(w) });
  ref.base = s.base;
  const tails = new Map();
  const locks = { request: (name, fn) => { const run = (tails.get(name) || Promise.resolve()).then(fn); tails.set(name, run.catch(() => {})); return run; } };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true, writable: true });
  try {
    // both starts have the provider's answer to their reserve before either goes on (a start waiting for the lock is not there to meet, so that one is let through after a moment)
    let arrived = 0, meet; const both = new Promise((r) => { meet = r; });
    const slow = (c) => ({ ...c, reserve: async (a) => { const r = await c.reserve(a); if (++arrived === 2) meet(); await Promise.race([both, new Promise((x) => setTimeout(x, 80))]); return r; } });
    const one = clientFor(w, slow(counterAt(s.base))), two = clientFor(w, slow(counterAt(s.base)));
    const q = await one.quote(VALUE);
    const [a, b] = await Promise.allSettled([one.start({ quote: q, notes: [w.note] }), two.start({ quote: q, notes: [w.note] })]);
    assert.equal([a, b].filter((x) => x.status === 'fulfilled').length, 1, 'one of the two started it');
    assert.match(String([a, b].find((x) => x.status === 'rejected').reason.message), /already part of a swap/);
    assert.equal((await w.userStore.list()).length, 1, 'and there is one record of it');
  } finally { if (had) Object.defineProperty(globalThis, 'navigator', had); else delete globalThis.navigator; }
});

test('a new instance on the same store carries a swap on: the page closed and opened again mid-swap', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(NET, 'net');
  const s = await serve(w, { config: feeConfig(w) });
  ref.base = s.base;
  const first = clientFor(w, counterAt(s.base));
  w.userTick = () => first.tick();
  await first.start({ quote: await first.quote(VALUE), notes: [w.note] });
  await w.run(async () => (await w.user())?.phase === 'offered');
  const second = clientFor(w, counterAt(s.base));
  w.userTick = () => second.tick();
  await w.run(async () => (await w.user())?.phase === 'done' && (await w.lp())?.phase === 'done');
  assert.equal((await second.records())[0].title, 'Done');
  assert.equal(w.evm.locks.leaves.length, 1);
});

test('a provider that goes away: the lock returns on its timelock, said as such, and the note is valid', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(NET, 'net');
  const s = await serve(w, { config: feeConfig(w) });
  ref.base = s.base;
  const fb = clientFor(w, counterAt(s.base));
  w.userTick = () => fb.tick();
  const q = await fb.quote(VALUE);
  await fb.start({ quote: q, notes: [w.note] });
  await s.close(); w.lpOnline = false;
  await w.run(async () => (await w.user())?.phase === 'refund-wait');
  const wait = (await fb.records())[0];
  assert.deepEqual([wait.title, wait.returned, wait.ended], ['Did not go through', true, false]);
  assert.match(wait.detail, /The provider did not answer\. Your TAC is safe\./);
  w.btc.mine(143);
  await w.run(async () => (await w.user())?.phase === 'refunded');
  const done = (await fb.records())[0];
  assert.deepEqual([done.title, done.returned, done.ended], ['Returned', true, true]);
  assert.ok(await w.noteOf((await w.user()).refund.txid, 0), 'the refund is a valid note');
});

test('a lock the browser has no record of is found again from the key, and taken back on its timelock', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(NET, 'net');
  const s = await serve(w, { config: feeConfig(w) });
  ref.base = s.base;
  const fb = clientFor(w, counterAt(s.base));
  w.userTick = () => fb.tick();
  const q = await fb.quote(VALUE);
  const rec = await fb.start({ quote: q, notes: [w.note] });
  await s.close(); w.lpOnline = false;
  await w.run(async () => !!(await w.user())?.confirmedAt);

  // a new browser: no records, the same key
  const store2 = memStore();
  const fb2 = clientFor(w, counterAt(s.base), { store: store2 });
  assert.deepEqual(await fb2.records(), []);
  const found = await fb2.recover();
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].id, found[0].title, found[0].recovered, found[0].amount], [rec.id, 'Returning to Bitcoin', true, String(VALUE)]);
  assert.equal((await fb2.recover()).length, 0, 'the second look finds nothing new');
  assert.equal((await fb.recover()).length, 0, 'a browser that holds the record is not given a second one');

  w.btc.mine(143);
  for (let i = 0; i < 40 && (await fb2.records())[0].phase !== 'refunded'; i++) { await fb2.tick(); w.btc.mine(1); w.clock.advance(60); }
  const back = (await fb2.records())[0];
  assert.deepEqual([back.title, back.ended], ['Returned', true]);
  assert.ok(await w.noteOf((await store2.get(rec.id)).refund.txid, 0), 'the note came back to the key');
});

test('a provider that cannot hold the payout is found out before anything is locked, and one that can holds it through the confirmation', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(NET, 'net');
  w.lBtc.satsUtxos = async () => Array.from({ length: 4 }, (_, i) => ({ txid: String(i).repeat(64), vout: 0, value: 200_000 }));
  const s = await serve(w, { config: feeConfig(w) });
  ref.base = s.base;
  const counter = counterAt(s.base);
  const fb = clientFor(w, counter);
  assert.equal((await fb.terms()).available, VALUE, 'what the provider can take now, in the amount the user pays');
  const q = await fb.quote(VALUE);
  // another user's reservation takes the inventory between the quote and the press
  const other = await counter.quote(VALUE);
  assert.equal((await counter.reserve({ quoteId: other.id })).ok, true);
  await assert.rejects(() => fb.start({ quote: q, notes: [w.note] }), /cannot hold that amount: the provider cannot take that amount right now/);
  assert.deepEqual(await w.userStore.list(), [], 'no lock was built');
  assert.deepEqual(w.btc.broadcasts, [], 'and nothing was sent to Bitcoin');
  // the reservation lapses; the same quote can be taken, and the lock's broadcast extends it
  w.clock.advance(901);
  const rec = await fb.start({ quote: q, notes: [w.note] });
  assert.ok(s.svc.reservations.get(q.id), 'the payout is held');
  w.userTick = () => fb.tick();
  await w.step(); await w.step();
  assert.equal(s.svc.reservations.get(q.id).txid, rec.lock.txid, 'held for the lock that went out');
  assert.equal(s.svc.reservations.get(q.id).until > w.clock.now() + 3600, true);
});

test('several providers: a quote from each, the best first, one that is slow or down left out, and the press goes to the next best when one cannot hold', async () => {
  const log = [];
  const fakes = {
    cheap: { quote: async (a) => ({ id: 'q-cheap', evmAmount: BigInt(a) - 5n }), start: async () => { log.push('cheap'); throw new Error('the provider cannot hold that amount: the provider cannot take that amount right now'); } },
    fair: { quote: async (a) => ({ id: 'q-fair', evmAmount: BigInt(a) - 20n }), start: async ({ quote }) => { log.push('fair'); return { id: 'swap-' + quote.id }; } },
    dear: { quote: async (a) => ({ id: 'q-dear', evmAmount: BigInt(a) - 90n }), start: async () => { log.push('dear'); throw new Error('the lock could not be built'); } },
    slow: { quote: () => new Promise(() => {}) },
    down: { quote: async () => { throw new Error('no quote: 503'); } },
  };
  const market = makeFastBridgeMarket({ btc: {}, evm: {}, store: memStore(), seed: new Uint8Array(32), counterFor: () => null, makeClient: ({ provider }) => fakes[provider.id] });
  const providers = Object.keys(fakes).map((id) => ({ id, name: id, ref: { kind: 'http', id, claimPub: id } }));
  const r = await market.quoteAll(providers, 1000n, { timeoutMs: 30 });
  assert.deepEqual(r.quotes.map((x) => x.provider.id), ['cheap', 'fair', 'dear']);
  assert.deepEqual(r.failed.map((x) => x.provider.id).sort(), ['down', 'slow']);
  assert.match(r.failed.find((x) => x.provider.id === 'slow').error.message, /did not answer in time/);
  const started = await market.start({ quotes: r.quotes, notes: [] });
  assert.deepEqual(log, ['cheap', 'fair'], 'the cheapest could not hold, the next was asked');
  assert.deepEqual([started.provider.id, started.rec.id], ['fair', 'swap-q-fair']);
  // an error that is not about holding the amount is not tried on another provider
  log.length = 0;
  await assert.rejects(() => market.start({ quotes: [r.quotes[2], r.quotes[1]], notes: [] }), /could not be built/);
  assert.deepEqual(log, ['dear']);
  await assert.rejects(() => market.start({ quotes: [r.quotes[0]], notes: [] }), /cannot hold that amount/);
  await assert.rejects(() => market.start({ quotes: [], notes: [] }), /cannot hold that amount/);
});

test('a swap through the market: the provider is kept with the swap, and a record is carried on with it', async () => {
  const { w, ref } = httpWorld();
  w.lEvm.fund(NET, 'net');
  const s = await serve(w, { config: feeConfig(w) });
  ref.base = s.base;
  const provider = { id: bytesToHex(w.lW.wallet.pub), name: 'Tacit', ref: { kind: 'http', base: s.base, claimPub: bytesToHex(w.lW.wallet.pub) }, terms: termsOf(await counterAt(s.base).info()) };
  const market = makeFastBridgeMarket({ btc: w.uBtc, evm: w.uEvmCtx, store: w.userStore, seed: w.uKeys.seed, now: w.clock.now, pins: { btcAsset: bytesToHex(w.etch.asset), evmAsset: ASSET }, counterFor: (r) => (r && r.kind === 'http' ? counterAt(r.base) : null) });
  w.userTick = () => market.tick();
  const { quotes } = await market.quoteAll([provider], VALUE);
  assert.equal(quotes.length, 1);
  const { rec } = await market.start({ quotes, notes: [w.note] });
  assert.deepEqual((await w.userStore.get(rec.id)).provider, provider.ref, 'kept with the swap');
  await w.run(bothDone(w));
  assert.equal((await market.records())[0].title, 'Done');
  assert.equal(w.evm.locks.leaves.length, 1);
  // a record made before providers were kept is carried on by the client that has no provider, which here is no provider at all
  const gone = makeFastBridgeMarket({ btc: w.uBtc, evm: w.uEvmCtx, store: memStore(), seed: w.uKeys.seed, now: w.clock.now, counterFor: () => null });
  assert.deepEqual(await gone.tick(), []);
});

test('a lock that has confirmed and not been answered yet says the provider is checking it, and what the provider said', () => {
  const rec = { id: 'a', phase: 'broadcast', amount: '1', evmAmount: '1', created: 1, lock: { txid: 'bb'.repeat(32) } };
  assert.equal(describe(rec).title, 'Waiting for Bitcoin', 'before a confirmation it waits for Bitcoin');
  const checking = describe({ ...rec, confirmedAt: 5 });
  assert.deepEqual([checking.title, checking.at, checking.ended], ['The provider is checking your lock', 1, false]);
  assert.match(checking.detail, /reads it from Bitcoin before it locks TAC for you/);
  const said = describe({ ...rec, confirmedAt: 5, offerWhy: 'the lock is still being checked: ask again in a few seconds' });
  assert.match(said.detail, /The provider says: the lock is still being checked: ask again in a few seconds\.$/);
});

test('the words for each phase, and for one the page does not know', () => {
  const phases = ['built', 'broadcast', 'offered', 'claiming', 'claimed', 'done', 'refund-wait', 'refunded', 'counter-took'];
  const d = phases.map((phase) => describe({ id: 'x', phase, amount: '5', evmAmount: '4', created: 1 }));
  assert.deepEqual(d.map((x) => x.at), [0, 0, 1, 2, 2, 3, 0, 3, 3]);
  assert.deepEqual(d.map((x) => x.ended), [false, false, false, false, false, true, false, true, true]);
  assert.ok(d.every((x) => x.title && x.detail && x.steps.length === 4));
  assert.equal(describe({ id: 'x', phase: 'mystery', created: 1 }).title, 'mystery');
  assert.match(describe({ id: 'x', phase: 'refund-wait', why: 'the counterparty declined: quote expired', created: 1 }).detail, /quote ran out before your lock was confirmed/);
  assert.equal(describe({ id: 'x', phase: 'refund-wait', created: 1, lastError: 'explorer down' }).error, 'explorer down');
});

test('a bridge that did not go through says what went wrong, that the Bitcoin is safe and when it is due back, in sentences and not the log\'s words', () => {
  const HOUR = 3600, T0 = 1_000_000, rec = { id: 'x', phase: 'refund-wait', amount: '100000000000', evmAmount: '99690000000', created: T0, confirmedAt: T0, csvBlocks: 144, lock: { txid: 'cc'.repeat(32) } };
  const at = (secs, over = {}) => describe({ ...rec, ...over }, () => T0 + secs);
  const d = at(2 * HOUR, { why: 'the counterparty declined: quote expired' });
  assert.equal(d.title, 'Did not go through');
  assert.equal(d.detail, 'The provider’s quote ran out before your lock was confirmed. Your TAC is safe. The lock comes back to your address in about 22 hours: open the app then and it is sent back.');
  assert.ok(!/counterparty|timelock|\(/.test(d.detail), 'no log words, no parenthesis of the raw reason');
  assert.equal(d.receive, '0', 'what it would have paid is not shown for a bridge that did not happen');
  assert.deepEqual([d.returned, d.ended], [true, false]);
  assert.match(at(23 * HOUR - 1800).detail, /within the hour|in about an hour/);
  assert.match(at(143 * 600 + 5).detail, /due back now\. Open Tacit signed in with the same wallet and it is sent back to your address/, 'once the timelock has run it says so');
  assert.match(describe({ ...rec, confirmedAt: undefined }, () => T0).detail, /when its timelock ends, about a day after it confirmed/, 'with no confirmation time it still says it is safe and roughly when');
  for (const [why, re] of [
    ['the counterparty could not be reached', /^The provider did not answer\./], ['the provider did not answer', /^The provider did not answer\./],
    ['the counterparty declined: the provider cannot lock right now (the relay is not sending settles)', /^The provider is not taking bridges at the moment\./],
    ['the counterparty declined: the provider cannot take that amount right now', /^The provider no longer had room/],
    ['the counterparty declined: the lock could not be checked now: boom', /^The provider could not check your lock in time\./],
    ['the offered lock never showed in the pool', /^The provider did not put the TAC in the pool in time\./], ['no Ethereum lock arrived', /^The provider did not put the TAC in the pool/],
    ['too little time left to claim safely', /^There was too little time left/], ['the claim did not land before the deadline', /^The claim did not go through before its deadline\./],
    ['offer: the deadline is further out than this side accepts', /^The provider’s offer did not pass your safety checks/], ['the timelock has run', /^It was not finished before the lock’s time ran out\./],
    ['the counterparty declined: something new', /^The provider declined it: something new\. Your TAC is safe/], ['an odd reason', /^An odd reason\. Your TAC is safe/],
  ]) assert.match(at(HOUR, { why }).detail, re, why);
  assert.ok(at(HOUR, { why: '' }).detail.startsWith('Your TAC is safe.'), 'no reason recorded: nothing invented');
  // a lock this page lost and found again from the key did not fail: it is on its way back
  const found = at(HOUR, { why: 'found from the key', recovered: true });
  assert.equal(found.title, 'Returning to Bitcoin'); assert.ok(!/provider/.test(found.detail.split('Your TAC is safe')[0]));
  // the last failed read of the provider is not shown while the lock waits for its timelock, and is once it is due, when the app is sending it
  assert.equal(at(HOUR, { lastError: 'the provider did not answer' }).error, null);
  assert.equal(at(24 * HOUR, { lastError: 'broadcast refused' }).error, 'broadcast refused');
  assert.equal(describe({ ...rec, phase: 'broadcast', lastError: 'explorer down' }, () => T0).error, 'explorer down', 'a bridge still under way keeps its error');
  // describe handed to a map is given an index, which is not a clock
  assert.doesNotThrow(() => [rec].map(describe));
  assert.equal(describe({ ...rec, phase: 'refunded' }).receive, '0');
});

test('swaps kept in localStorage: one entry each, other keys left alone, an entry that is not a swap skipped', async () => {
  const m = new Map();
  const storage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
  m.set('other', 'x'); m.set('tacit-fb:junk', '{not json');
  const st = makeLocalStore('tacit-fb:', storage);
  await st.put({ id: 'a1', phase: 'built' }); await st.put({ id: 'b2', phase: 'done' });
  assert.deepEqual(await st.get('a1'), { id: 'a1', phase: 'built' });
  assert.equal(await st.get('nope'), null);
  assert.deepEqual((await st.list()).map((r) => r.id).sort(), ['a1', 'b2']);
  await st.put({ id: 'a1', phase: 'broadcast' });
  assert.equal((await st.get('a1')).phase, 'broadcast');
});

test('run(): a pass now and one every interval, handed to onChange, until stopped', async () => {
  const { w } = httpWorld();
  const store = memStore();
  await store.put({ v: 1, role: 'bl', id: 'ab'.repeat(36), phase: 'done', created: 5, amount: '1', evmAmount: '1' });
  const fb = clientFor(w, fakeLp(w), { store });
  const seen = [];
  const stop = fb.run({ everyMs: 5, onChange: (list) => seen.push(list.map((r) => r.title)) });
  await new Promise((r) => setTimeout(r, 60));
  stop();
  const n = seen.length;
  assert.ok(n >= 3, `${n} passes`);
  assert.deepEqual(seen[0], ['Done']);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(seen.length, n, 'no pass after stop');
});

test('a part of a split bridge on the real lock: it leaves the coins it is told to alone, keeps its place in the split, and records the coins that paid for it', async () => {
  const { w } = httpWorld();
  w.lEvm.fund(NET, 'net');
  const s = await serve(w, { config: feeConfig(w) });
  const fb = clientFor(w, counterAt(s.base));
  const q = await fb.quote(VALUE);
  // two plain-sat coins at the key's address, the larger first as the explorer lists them
  const c1 = { txid: 'c1'.repeat(32), vout: 0, value: 200_000 }, c2 = { txid: 'c2'.repeat(32), vout: 1, value: 150_000 };
  w.uBtc.satsUtxos = async () => [c1, c2];
  const mine = new Set([`${w.note.txid}:${w.note.vout}`]);
  const key = (c) => `${c.txid}:${c.vout}`;
  assert.deepEqual((await fb.cost({ quote: q, notes: [w.note] })).coins, [{ txid: c1.txid, vout: 0 }], 'the largest coin pays when nothing is to be left alone');
  assert.deepEqual((await fb.cost({ quote: q, notes: [w.note], avoid: new Set([...mine, key(c1)]) })).coins, [{ txid: c2.txid, vout: 1 }], 'a coin an earlier part spent is not spent again');
  const short = await fb.cost({ quote: q, notes: [w.note], avoid: new Set([...mine, key(c1), key(c2)]) });
  assert.equal(short.short, true, 'with both coins spoken for, the address cannot pay');
  // started with its payout already held, and its place in the split
  await fb.reserve(q);
  const rec = await fb.start({ quote: q, notes: [w.note], avoid: new Set([...mine, key(c1)]), reserved: true, meta: { sweep: { id: 'sw9', part: 2, of: 3 } } });
  assert.deepEqual(rec.sweep, { id: 'sw9', part: 2, of: 3 });
  assert.deepEqual(rec.feeInputs, [{ txid: c2.txid, vout: 1 }], 'the record names the coin that paid for the lock');
  const kept = await w.userStore.get(rec.id);
  assert.deepEqual([kept.sweep, kept.feeInputs], [rec.sweep, rec.feeInputs], 'kept with the swap');
  assert.deepEqual((await fb.records())[0].sweep, { id: 'sw9', part: 2, of: 3 }, 'and said by the page\'s list');
  // a lock that is not part of a split carries no place
  assert.equal(describe({ phase: 'done' }).sweep, null);
  // the notes it spent are held: a second part cannot start on them
  await assert.rejects(() => fb.start({ quote: q, notes: [w.note], reserved: true }), /already part of a swap/);
});

// ── a bridge split across providers: the parts are held, then locked one at a time ──

// providers that log what they are asked, in order; `legs` are the parts [{ provider, quote, notes }]
function splitWorld({ holdFails = new Set(), startFails = new Set(), stored = false, short = null, valid = 5000 } = {}) {
  const log = [], seen = {}, store = memStore();
  const note = (n) => ({ txid: String(n).repeat(64), vout: 0, amount: 100n });
  const all = [note(1), note(2), note(3), note(4)];
  const fakes = {};
  for (const id of ['a', 'b', 'c']) {
    fakes[id] = {
      reserve: async (q) => { log.push('reserve:' + id); if (holdFails.has(id)) throw new Error('the provider cannot hold that amount: the provider cannot take that amount right now'); return q; },
      cost: async ({ quote, avoid }) => { log.push('cost:' + id); seen['cost:' + id] = [...avoid]; return short === id ? { short: true, need: 9000, have: 100 } : { short: false, total: 1200, coins: [{ txid: id.repeat(64), vout: 7 }] }; },
      start: async (a) => {
        log.push('start:' + id); seen[id] = a;
        const rec = { id: 'swap-' + id, feeInputs: [{ txid: id.repeat(64), vout: 7 }], sweep: a.meta.sweep };
        if (startFails.has(id)) { if (stored) await store.put(rec); throw new Error('the lock could not be built'); }
        await store.put(rec);
        return rec;
      },
    };
  }
  const market = makeFastBridgeMarket({ btc: {}, evm: {}, store, seed: new Uint8Array(32), now: () => 1000, counterFor: () => null, makeClient: ({ provider }) => fakes[provider.id] });
  const leg = (id, i) => ({ provider: { id, name: id.toUpperCase(), ref: { kind: 'http', id, claimPub: id } }, quote: { id: 'q' + id, btcValue: 100n, evmAmount: 99n, validUntil: valid }, notes: [all[i]] });
  return { market, log, seen, all, store, legs: ['a', 'b', 'c'].map(leg), leg };
}

test('a split bridge holds every part\'s payout before it locks anything, then locks the parts one at a time, each with notes of its own', async () => {
  const w = splitWorld();
  const r = await w.market.sweep({ legs: w.legs, notes: w.all, id: 'sw1' });
  assert.deepEqual(w.log, ['reserve:a', 'reserve:b', 'reserve:c', 'start:a', 'start:b', 'start:c'], 'all held first, then locked in turn');
  assert.deepEqual(r.started.map((s) => [s.provider.id, s.rec.id, s.leg]), [['a', 'swap-a', 0], ['b', 'swap-b', 1], ['c', 'swap-c', 2]]);
  assert.equal(r.failed.length, 0); assert.equal(r.id, 'sw1');
  for (const [i, id] of ['a', 'b', 'c'].entries()) {
    assert.equal(w.seen[id].reserved, true, 'a part does not ask the provider to hold again');
    assert.deepEqual(w.seen[id].meta, { sweep: { id: 'sw1', part: i + 1, of: 3 } }, 'kept with the swap, so the page can say which part it is');
    assert.deepEqual(w.seen[id].notes.map((n) => n.txid), [w.all[i].txid], 'only the part\'s own notes');
  }
  // a part's lock must not fund itself from a note of the key, nor from the coins an earlier part paid its fee with
  const key = (n) => `${n.txid}:${n.vout}`, notesAll = w.all.map(key);
  assert.deepEqual([...w.seen.a.avoid].sort(), notesAll.slice().sort());
  assert.deepEqual([...w.seen.b.avoid].sort(), [...notesAll, 'a'.repeat(64) + ':7'].sort());
  assert.deepEqual([...w.seen.c.avoid].sort(), [...notesAll, 'a'.repeat(64) + ':7', 'b'.repeat(64) + ':7'].sort());
});

test('a provider that cannot hold its part stops the bridge before any lock is built: nothing is sent, and the answer names the provider', async () => {
  const w = splitWorld({ holdFails: new Set(['b']) });
  const e = await w.market.sweep({ legs: w.legs, notes: w.all }).catch((x) => x);
  assert.equal(e.code, 'sweep-hold'); assert.equal(e.leg, 1); assert.equal(e.provider.id, 'b');
  assert.match(e.message, /^B cannot hold its part of the bridge: the provider cannot take that amount right now$/);
  assert.ok(!w.log.some((l) => l.startsWith('start:')), 'no lock was built');
  assert.deepEqual((await w.store.list()), [], 'and nothing was kept');
  // a quote that is about to run out is refused before anything is held
  const late = splitWorld({ valid: 1050 });
  await assert.rejects(() => late.market.sweep({ legs: late.legs, notes: late.all }), /the quote expired/);
  assert.deepEqual(late.log, [], 'not even a hold was asked');
  await assert.rejects(() => w.market.sweep({ legs: [], notes: w.all }), /no part to start/);
});

test('a part that cannot be started after another has been leaves that one under way, and says which parts were not started; if the first cannot, it is an error and nothing started', async () => {
  const w = splitWorld({ startFails: new Set(['b']) });
  const r = await w.market.sweep({ legs: w.legs, notes: w.all, id: 'sw2' });
  assert.deepEqual(r.started.map((s) => s.provider.id), ['a'], 'the first part is under way');
  assert.deepEqual(r.failed.map((f) => [f.provider.id, f.leg, f.amount]), [['b', 1, 100n], ['c', 2, 100n]], 'the second, and the third that went after it, were not started');
  assert.match(r.failed[0].error.message, /the lock could not be built/);
  assert.match(r.failed[1].error.message, /not started: the part before it could not be/);
  assert.ok(!w.log.includes('start:c'), 'the third was not tried');
  const first = splitWorld({ startFails: new Set(['a']) });
  await assert.rejects(() => first.market.sweep({ legs: first.legs, notes: first.all }), /the lock could not be built/);
  assert.deepEqual(first.log.filter((l) => l.startsWith('start:')), ['start:a'], 'and the others were never started');
});

test('a part whose lock was stored but could not be sent is kept as started, and the parts after it still go, without its fee coins', async () => {
  const w = splitWorld({ startFails: new Set(['b']), stored: true });
  const r = await w.market.sweep({ legs: w.legs, notes: w.all, id: 'sw3' });
  assert.deepEqual(r.started.map((s) => [s.provider.id, !!s.unsent]), [['a', false], ['b', true], ['c', false]]);
  assert.equal(r.failed.length, 0);
  assert.ok(w.seen.c.avoid.has('b'.repeat(64) + ':7'), 'the third leaves the coins the second paid with alone, though its send failed');
});

test('what a split bridge costs on Bitcoin is priced as the parts are locked, each without the coins the one before it spent; the first part the address cannot pay for is named', async () => {
  const w = splitWorld();
  const c = await w.market.sweepCost({ legs: w.legs, notes: w.all });
  assert.equal(c.ok, true); assert.equal(c.legs.length, 3);
  assert.deepEqual(w.seen['cost:a'].length, 4); assert.deepEqual(w.seen['cost:b'].length, 5); assert.deepEqual(w.seen['cost:c'].length, 6);
  const s = splitWorld({ short: 'b' });
  const d = await s.market.sweepCost({ legs: s.legs, notes: s.all });
  assert.deepEqual([d.ok, d.at, d.legs.length], [false, 1, 2], 'the second part is the first that cannot be paid for, and the third is not priced');
  assert.equal(d.legs[1].short, true);
});

let passed = 0, ran = 0;
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
for (const [name, fn] of tests) {
  if (ONLY && !ONLY.test(name)) continue;
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
  while (closers.length) { try { await closers.pop()(); } catch { /* already closed */ } }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${ran} fastbridge client checks passed`);
process.exit(process.exitCode || 0);
