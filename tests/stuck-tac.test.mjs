// Stuck TAC: the classes of TAC the regular bridge cannot carry home (dapp/fast/stuck.js), what a provider charges for each, and the screen that
// holds a lock to the quote it was priced for. The classes are read from the bridge's own verdict (`lineage` in dapp/burndep-ux.js), the fees
// from the provider's own config, and the last checks are the numbers a provider is left with after N bridges, with the rule and without it.
//   node tests/stuck-tac.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { CLASSES, classOf, classRank, classesOf, makeStuck, quotedClass, stuckScreen } from '../dapp/fast/stuck.js';
import { makeQuoter } from '../dapp/fastbridge-provider.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const TAC = 10n ** 8n;
const note = (id, amount = 100n * TAC) => ({ txid: String(id).repeat(64).slice(0, 64), vout: 0, amount });
const verdicts = (table) => async (ns) => new Map(ns.map((n) => [`${n.txid}:${n.vout}`, table[n.txid[0]] || { state: 'unread', error: 'down' }]));
const quote = (over = {}) => ({ btcValue: '10000000000', evmAmount: '9900000000', ...over });
const schedule = { take: ['clean', 'long', 'poolExit'], haircutBps: { long: 900, poolExit: 2500 }, marginBps: 100 };
const policy = (over = {}) => makeStuck({ quote: { feeBps: 30, flatFee: String(TAC / 10n) }, stuck: { ...schedule, ...over } });

// ── the classes ──
test('a verdict is named: followed is clean, past the proof\'s bound is long, unfollowable is poolExit, unread is neither', () => {
  assert.equal(classOf({ state: 'tracked' }), 'clean', 'a note the reflection tracks from birth');
  assert.equal(classOf({ state: 'traced', hops: 12 }), 'clean', 'a history read back to the etch in 12 transfers');
  assert.equal(classOf({ state: 'traced', hops: 255 }), 'clean', 'the last history the proof folds');
  assert.equal(classOf({ state: 'long', hops: 256, max: 255 }), 'long');
  assert.equal(classOf({ state: 'unprovable', through: 'shielded' }), 'poolExit', 'an exit from the shielded pool');
  assert.equal(classOf({ state: 'unprovable', through: 'pool' }), 'poolExit', 'a pool or farm trade');
  assert.equal(classOf({ state: 'unprovable', through: 'arrived' }), 'poolExit', 'TAC that came over from Ethereum');
  for (const v of [{ state: 'unread', error: 'busy' }, null, undefined, {}, { state: 'something-new' }]) assert.equal(classOf(v), null, 'no class is not clean');
  assert.deepEqual(CLASSES, ['clean', 'long', 'poolExit'], 'worst last');
  assert.ok(classRank('poolExit') > classRank('long') && classRank('long') > classRank('clean'));
});

test('a lock is the worst class among the notes it spends, and is not classed at all while one of them is unread', async () => {
  const a = note('a', 60n * TAC), b = note('b', 40n * TAC);
  const clean = classesOf(await verdicts({ a: { state: 'traced', hops: 3 }, b: { state: 'tracked' } })([a, b]), [a, b]);
  assert.equal(clean.klass, 'clean'); assert.equal(clean.known, true); assert.equal(clean.unknown.length, 0);
  const mixed = classesOf(await verdicts({ a: { state: 'unprovable', through: 'shielded' }, b: { state: 'long', hops: 300 } })([a, b]), [a, b]);
  assert.equal(mixed.klass, 'poolExit', 'the worst of the two wins'); assert.equal(mixed.at.txid, a.txid, 'and it says which note carried it');
  const half = classesOf(await verdicts({ a: { state: 'long', hops: 300 } })([a, b]), [a, b]);
  assert.equal(half.known, false, 'one unread note and the lock has no class yet');
  assert.deepEqual(half.unknown, [`${b.txid}:${b.vout}`]);
});

// ── the schedule ──
test('a schedule is the provider\'s own floor, and one that would take a class at the clean price is refused at start', () => {
  assert.equal(makeStuck({ quote: {}, stuck: null }), null, 'no schedule is the provider it was');
  for (const [bad, why] of [
    [{ take: ['long'], haircutBps: { long: 900 } }, /still takes clean/],
    [{ take: ['clean', 'long'] }, /needs haircutBps\.long/],
    [{ take: ['clean', 'sideways'], haircutBps: { sideways: 100 } }, /take must name classes/],
    [{ haircutBps: { long: -1 } }, /whole basis points/],
    [{ haircutBps: { long: 10000 } }, /whole basis points/],
    [{ take: ['clean', 'poolExit'], haircutBps: { poolExit: 9980 } }, /leaves the holder nothing/],
  ]) assert.throws(() => makeStuck({ quote: { feeBps: 30, flatFee: '0' }, stuck: bad }), why, JSON.stringify(bad));
  assert.throws(() => makeStuck({ quote: { feeBps: 30 }, stuck: { marginBps: 12000 } }), /marginBps/);
});

test('the price of a class is the base price plus its haircut plus the margin, and the clean price is the price it was', () => {
  const s = policy();
  assert.equal(s.feeBpsFor('clean'), 30, 'nothing is added to TAC the bridge can carry');
  assert.equal(s.feeBpsFor('long'), 30 + 900 + 100);
  assert.equal(s.feeBpsFor('poolExit'), 30 + 2500 + 100);
  // clean is floored to the base unit exactly as makeQuoter floors it, so a quote with no class is the quote it was
  const amount = 1234n * TAC + 7n;
  assert.equal(s.feeFor(amount, 'clean'), (amount * 30n) / 10000n + TAC / 10n);
  // a stuck price is rounded up: it is a floor, and half a base unit under it is under it
  assert.equal(s.feeFor(amount, 'long'), (amount * 1030n + 9999n) / 10000n + TAC / 10n);
  // and it grows with the amount and with the class
  assert.ok(s.feeFor(1000n * TAC, 'long') > s.feeFor(100n * TAC, 'long'));
  assert.ok(s.feeFor(1000n * TAC, 'clean') < s.feeFor(1000n * TAC, 'long') && s.feeFor(1000n * TAC, 'long') < s.feeFor(1000n * TAC, 'poolExit'));
  const taken = makeStuck({ quote: { feeBps: 30, flatFee: '0' }, stuck: { take: ['clean', 'long'], haircutBps: { long: 900 }, marginBps: 100 } });
  assert.equal(taken.takes('long'), true); assert.equal(taken.takes('poolExit'), false, 'priced but not taken');
  assert.throws(() => taken.feeFor(1000n * TAC, 'poolExit'), /does not take/);
  assert.equal(taken.take.includes('poolExit'), false);
  assert.throws(() => taken.feeFor(1n, 'long'), /does not cover the fee/, 'a fee that is the whole amount is no quote');
  assert.throws(() => s.feeFor(1n, 'clean'), /does not cover the fee/);
});

test('a quote pays for a lock only when it was priced for a class at least as bad, and a quote with no class is the clean one', () => {
  const s = policy();
  assert.equal(quotedClass({}), 'clean', 'every page that predates this asks for the clean class');
  assert.equal(quotedClass(null), 'clean');
  assert.equal(quotedClass({ class: 'long' }), 'long');
  assert.equal(quotedClass({ class: 'nonsense' }), 'clean');
  assert.equal(s.covers('clean', 'clean'), true);
  assert.equal(s.covers('clean', 'long'), false, 'a clean quote does not pay for a long history');
  assert.equal(s.covers('clean', 'poolExit'), false);
  assert.equal(s.covers('long', 'clean'), true, 'a long quote pays for a clean lock: the provider was paid more than it needed');
  assert.equal(s.covers('long', 'poolExit'), false);
  assert.equal(s.covers('poolExit', 'poolExit'), true);
  assert.equal(s.covers('poolExit', 'nonsense'), false, 'no class is not a class');
});

// ── the screen the machine calls ──
test('without a schedule the screen is the screen it was: unprovable refuses, unread retries, long is taken', async () => {
  const a = note('a'), b = note('b');
  const screen = stuckScreen(verdicts({ a: { state: 'unprovable', through: 'shielded' }, b: { state: 'long', hops: 300 } }));
  assert.match((await screen([a], { quote: quote() })).why, /history the bridge's proof does not follow/);
  assert.equal((await screen([a], { quote: quote() })).retry, undefined, 'a refusal is final');
  assert.equal((await screen([b], { quote: quote() })), null, 'a long history is not a refusal');
  const unread = note('c');
  assert.deepEqual(await screen([unread], { quote: quote() }), { why: 'the history of a note could not be read just now', retry: true });
  assert.equal((await screen([a, unread], { quote: quote() })).retry, undefined, 'the refusal is dealt with first, as it was');
});

test('with a schedule the screen is the floor: it names the class, takes only the classes it takes, and holds the lock to its quote', async () => {
  const long = note('d'), exit = note('f'), clean = note('e');
  const vet = verdicts({ d: { state: 'long', hops: 300 }, f: { state: 'unprovable', through: 'shielded' }, e: { state: 'traced', hops: 4 } });
  const s = policy();
  const screen = stuckScreen(vet, { stuck: s });
  assert.equal(await screen([clean], { quote: quote({ class: 'clean' }) }), null);
  assert.match((await screen([long], { quote: quote({ class: 'clean' }) })).why, /more than 255 transfers behind it.*priced for TAC the bridge can carry home/, 'a clean quote does not pay for it');
  assert.equal(await screen([long], { quote: quote({ class: 'long' }) }), null, 'a quote priced for it is taken');
  assert.equal(await screen([exit], { quote: quote({ class: 'poolExit' }) }), null);
  assert.match((await screen([exit], { quote: quote({ class: 'long' }) })).why, /does not follow.*priced for/);
  assert.equal((await screen([long], { quote: quote() })).why !== undefined, true, 'a quote that names no class is clean');
  const onlyClean = stuckScreen(vet, { stuck: makeStuck({ quote: { feeBps: 30 }, stuck: { take: ['clean'], haircutBps: {} } }) });
  assert.match((await onlyClean([long], { quote: quote({ class: 'long' }) })).why, /which this provider does not take/);
  const half = stuckScreen(verdicts({ d: { state: 'long', hops: 300 } }), { stuck: s });
  const mixed = await half([long, note('9')], { quote: quote({ class: 'long' }) });
  assert.equal(mixed.retry, true, 'a note with no verdict is a retry, not a class');
  assert.deepEqual(mixed.unknown, [`${note('9').txid}:0`]);
});

// ── the quoter both a page and the daemon run ──
test('the quoter prices the class it is asked for and names it; a provider with no schedule prices as it did, and names no class', async () => {
  const store = { put: async () => {}, get: async () => null };
  const params = (over = {}) => ({
    btcAsset: 'ab'.repeat(32), evmAsset: 'ab'.repeat(32), minAmount: String(10n * TAC), maxAmount: String(10000n * TAC),
    feeBps: 30, flatFee: String(TAC / 10n), claimPub: '02' + 'cd'.repeat(32), csvBlocks: 144, evmWindowSecs: 14400, minConfsFor: () => 1, validSecs: 600, ...over,
  });
  const plain = makeQuoter({ store, now: () => 1000, params: params() });
  const before = await plain.quote(1000n * TAC);
  assert.equal(before.class, undefined, 'a provider with no schedule names no class');
  assert.equal(before.evmAmount, String(1000n * TAC - ((1000n * TAC * 30n) / 10000n + TAC / 10n)), 'the clean fee is the fee it was');
  assert.equal((await plain.quote(1000n * TAC, 'poolExit')).evmAmount, before.evmAmount, 'it prices as it always did whatever it is asked');

  const priced = makeQuoter({ store, now: () => 1000, params: params({ stuck: schedule }) });
  const clean = await priced.quote(1000n * TAC);
  assert.equal(clean.class, 'clean');
  assert.equal(clean.evmAmount, before.evmAmount, 'TAC the bridge can carry costs what it cost');
  const long = await priced.quote(1000n * TAC, 'long');
  assert.equal(long.class, 'long');
  assert.equal(String(1000n * TAC - BigInt(long.evmAmount)), String(priced.stuck.feeFor(1000n * TAC, 'long')));
  assert.ok(BigInt(long.evmAmount) < BigInt(clean.evmAmount));
  const exit = await priced.quote(1000n * TAC, 'poolExit');
  assert.equal(exit.class, 'poolExit');
  assert.ok(BigInt(exit.evmAmount) < BigInt(long.evmAmount));
  await assert.rejects(() => priced.quote(1000n * TAC, 'sideways'), /no such class/);
  assert.deepEqual(priced.terms().take, ['clean', 'long', 'poolExit']);
  assert.equal(priced.terms().haircutBps.poolExit, 2500);
  const narrow = makeQuoter({ store, now: () => 1000, params: params({ stuck: { ...schedule, take: ['clean'] } }) });
  await assert.rejects(() => narrow.quote(1000n * TAC, 'long'), /does not take TAC with more than 255 transfers/);
  assert.equal(narrow.terms().take.length, 1);
});

// ── the numbers: what a provider is left with after N bridges ──
// A provider starts with private TAC on Ethereum and is paid TAC on Bitcoin. Each bridge lends what it pays out and hands it a Bitcoin note of
// the amount: a clean note comes home over the regular bridge and is lent again; a long or poolExit note stays on Bitcoin, worth its Bitcoin
// price, `1 - haircut`. What is left after N bridges is the value it holds less the value it lent. One model, run with the rule and without it.
const HAIRCUT = { clean: 0, long: 900, poolExit: 2500 };
function afterBridges({ mix, amount, rule }) {
  let lent = 0n, received = 0n;
  for (const [klass, count] of Object.entries(mix)) {
    const a = BigInt(amount) * TAC, fee = rule ? rule.feeFor(a, klass) : (a * 30n) / 10000n + TAC / 10n;
    lent += (a - fee) * BigInt(count);
    received += (a * BigInt(10000 - HAIRCUT[klass]) / 10000n) * BigInt(count);   // the note's value once it is home, or sold on Bitcoin
  }
  return { lent, received, net: received - lent };
}
test('after 200 bridges of 100 TAC, one in twenty stuck: without the rule the provider is down 74 TAC, with it up 90', () => {
  const mix = { clean: 190, long: 6, poolExit: 4 };
  const rule = makeStuck({ quote: { feeBps: 30, flatFee: String(TAC / 10n) }, stuck: schedule });
  const off = afterBridges({ mix, amount: 100, rule: null }), on = afterBridges({ mix, amount: 100, rule });
  const fmt = (v) => `${(Number(v) / 1e8).toFixed(2)} TAC`;
  console.log(`      without the rule: lent ${fmt(off.lent)}, received ${fmt(off.received)}, net ${fmt(off.net)}`);
  console.log(`      with it:          lent ${fmt(on.lent)}, received ${fmt(on.received)}, net ${fmt(on.net)}`);
  assert.equal(off.net, -(74n * TAC + 0n), 'the fee does not cover the haircut it took on');
  assert.equal(on.net, 90n * TAC, 'the stuck price does, and the margin is the provider\'s');
  // a clean-only book is the same under both: the rule adds nothing where it is not needed
  const cleanOnly = { clean: 200, long: 0, poolExit: 0 };
  assert.equal(afterBridges({ mix: cleanOnly, amount: 100, rule: null }).net, afterBridges({ mix: cleanOnly, amount: 100, rule }).net);
  // and more stuck TAC in the book costs the provider more without the rule, and nothing with it
  const worse = { clean: 150, long: 20, poolExit: 30 };
  assert.ok(afterBridges({ mix: worse, amount: 100, rule: null }).net < off.net);
  assert.ok(afterBridges({ mix: worse, amount: 100, rule }).net > 0n);
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} stuck TAC checks passed`);
process.exit(process.exitCode || 0);
