// Offline tests for fastbridge-stuck.js (stuck TAC bounty, entry C): classification of lineage verdicts,
// break-even pricing by class, refusal instead of a silent free take, and the screen shape a provider's
// policy takes. Run: node tests/fastbridge-stuck.test.mjs
import assert from 'node:assert';
import { classOfVerdict, classOfLock, addBpsForClass, termsForClass, screenVerdicts, priceLock, DEFAULT_STUCK_POLICY } from '../dapp/fastbridge-stuck.js';

// feeOf as fastbridge-price.js defines it (the provider's own sum), restated here so this file runs alone.
const feeOf = (terms, amount) => (BigInt(amount) * BigInt(terms.feeBps ?? 0)) / 10000n + BigInt(terms.flatFee ?? 0);

const P = DEFAULT_STUCK_POLICY;
const TAC = 100_000_000n; // base units, 8 places
const TERMS = { feeBps: 30, flatFee: 10_000_000n }; // the defaults of fast/discover.js PROVIDER_DEFAULTS

// ── classOfVerdict: every lineage state, and the through-kinds of an unprovable note ──
assert.equal(classOfVerdict({ state: 'tracked' }), 'clean');
assert.equal(classOfVerdict({ state: 'traced', hops: 12 }), 'clean');
assert.equal(classOfVerdict({ state: 'long', hops: 300, max: 255 }), 'long');
assert.equal(classOfVerdict({ state: 'unprovable', through: 'shielded' }), 'pool-exit');
assert.equal(classOfVerdict({ state: 'unprovable', through: 'pool' }), 'other');
assert.equal(classOfVerdict({ state: 'unprovable', through: 'arrived' }), 'other');
assert.equal(classOfVerdict({ state: 'unprovable', through: 'other' }), 'other');
assert.equal(classOfVerdict({ state: 'unprovable', through: null }), 'other');
assert.equal(classOfVerdict({ state: 'unread', error: 'x' }), 'unread');
// a verdict of any other shape is never guessed at
assert.equal(classOfVerdict(null), 'unread');
assert.equal(classOfVerdict({}), 'unread');
assert.equal(classOfVerdict({ state: 'something-new' }), 'unread');

// ── classOfLock: the worst note prices the lock; one unread note stops it ──
const clean = { state: 'traced', hops: 3 }, long = { state: 'long', hops: 999 }, exit = { state: 'unprovable', through: 'shielded' };
assert.equal(classOfLock([clean, clean], P), 'clean');
assert.equal(classOfLock([clean, long], P), 'long');
assert.equal(classOfLock([long, exit], P), 'pool-exit');
assert.equal(classOfLock([exit, { state: 'unprovable', through: 'pool' }], P), 'other'); // other carries the larger haircut
assert.equal(classOfLock([clean, { state: 'unread' }], P), 'unread');
assert.equal(classOfLock([], P), 'clean');
// verdicts as `lineage` returns them: a Map by note id
assert.equal(classOfLock(new Map([['a:0', clean], ['b:1', long]]), P), 'long');
// worst is by the policy's own haircuts, not by a fixed order: a provider that fears long histories most prices by them
const fearsLong = { haircutBps: { clean: 0, long: 1800, 'pool-exit': 400, other: 900 }, maxAddBps: 2000, refuse: [] };
assert.equal(classOfLock([long, exit], fearsLong), 'long');

// ── addBpsForClass: break-even is the haircut itself; what cannot break even within the cap is refused ──
assert.equal(addBpsForClass(P, 'clean'), 0);
assert.equal(addBpsForClass(P, 'long'), 500);
assert.equal(addBpsForClass(P, 'pool-exit'), 1000);
assert.equal(addBpsForClass(P, 'other'), 1500);
assert.equal(addBpsForClass(P, 'unread'), null);
// a class whose haircut passes the provider's ceiling is refused, not priced at the ceiling
assert.equal(addBpsForClass({ haircutBps: { long: 2500 }, maxAddBps: 2000, refuse: [] }, 'long'), null);
// a class named in refuse is refused however small its haircut
assert.equal(addBpsForClass({ haircutBps: { long: 100 }, maxAddBps: 2000, refuse: ['long'] }, 'long'), null);
// a class the policy names no haircut for is refused, never taken free by omission
assert.equal(addBpsForClass({ haircutBps: { clean: 0 }, maxAddBps: 2000, refuse: [] }, 'long'), null);
// a haircut that is not a sane number refuses the class
assert.equal(addBpsForClass({ haircutBps: { long: -5 }, maxAddBps: 2000, refuse: [] }, 'long'), null);
assert.equal(addBpsForClass({ haircutBps: { long: 10000 }, maxAddBps: 2000, refuse: [] }, 'long'), null);
assert.equal(addBpsForClass(null, 'long'), null);

// ── termsForClass and the fee: the add-on is on the rate only, and it covers the expected haircut ──
const amount = 100n * TAC;
assert.deepEqual(termsForClass(TERMS, P, 'clean'), TERMS);
assert.equal(termsForClass(TERMS, P, 'long').feeBps, 530);
assert.equal(termsForClass(TERMS, P, 'long').flatFee, TERMS.flatFee);
assert.equal(termsForClass(TERMS, { haircutBps: { long: 2500 }, maxAddBps: 2000, refuse: [] }, 'long'), null);
// on 100 TAC at the default terms: clean keeps 0.4 TAC; long keeps 5.4 TAC, of which the add-on is exactly
// the 5% the class is expected to lose — the provider breaks even in expectation, no more taken than that
assert.equal(feeOf(termsForClass(TERMS, P, 'clean'), amount), 40_000_000n);
assert.equal(feeOf(termsForClass(TERMS, P, 'long'), amount), 540_000_000n);
for (const cls of ['long', 'pool-exit', 'other']) {
  const extra = feeOf(termsForClass(TERMS, P, cls), amount) - feeOf(TERMS, amount);
  assert.equal(extra, (amount * BigInt(P.haircutBps[cls])) / 10000n, `${cls}: add-on covers the haircut`);
}
// the flat part alone never carries a haircut: at the smallest bridge (10 TAC) the add-on still scales
const small = 10n * TAC;
assert.equal(feeOf(termsForClass(TERMS, P, 'pool-exit'), small) - feeOf(TERMS, small), (small * 1000n) / 10000n);

// ── screenVerdicts: the shape policy.screen takes — null to go on, { why } to refuse, retry when unread ──
assert.equal(screenVerdicts([clean], P), null);
assert.equal(screenVerdicts([long], P), null); // priced, not refused: the point of the entry
const refused = screenVerdicts([long], { haircutBps: { long: 2500 }, maxAddBps: 2000, refuse: [] });
assert.ok(refused && /does not take long TAC/.test(refused.why) && !refused.retry);
const unread = screenVerdicts([clean, { state: 'unread' }], P);
assert.ok(unread && unread.retry === true);

// ── priceLock: one answer for class, price and refusal, so quote and screen cannot disagree ──
const priced = priceLock([clean, long], P, TERMS);
assert.deepEqual({ ok: priced.ok, cls: priced.cls, addBps: priced.addBps }, { ok: true, cls: 'long', addBps: 500 });
assert.equal(feeOf(priced.terms, amount), 540_000_000n);
const notPriced = priceLock([clean, { state: 'unread' }], P, TERMS);
assert.equal(notPriced.ok, false);
assert.equal(notPriced.retry, true);

console.log('fastbridge-stuck: all tests passed');
