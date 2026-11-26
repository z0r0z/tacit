#!/usr/bin/env node
// dapp/fast/stuck-terms.js: the priced rule for TAC the regular bridge cannot carry home (docs/STUCK-TAC-BOUNTY.md, option C).
// The classifier over the lineage vet's verdicts, the expected-haircut fee math (including the break-even edge: a class is
// not quoted at an amount whose fee the amount cannot pay), the priced screen's decisions per class, the stuck-share cap,
// the unread -> retry behaviour, and the backwards-compat proof: with no stuck terms the priced screen decides exactly as
// lineageScreen (dapp/fast/wire.js) does on the same verdicts, word for word. The quoter is exercised where the fee binds:
// a quote named at a class is priced at that class's fee and keeps the class; an unnamed quote is priced and sealed as before.
//   node tests/stuck-terms.test.mjs        (Node 22)

import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

import assert from 'node:assert/strict';
import { classOf, worstClass, haircutBps, expectedFlat, takesClass, classTerms, classFee, minAmountFor, stuckShareOk, pricedScreen, stuckSchedule, STUCK_CLASSES } from '../dapp/fast/stuck-terms.js';
import { makeQuoter } from '../dapp/fastbridge-provider.js';
const { lineageScreen } = await import('../dapp/fast/wire.js');

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };
const TAC = 10n ** 8n;
const U = (tac) => BigInt(tac) * TAC;

// ── the classifier: every verdict shape the vet (dapp/burndep-ux.js) hands back ──
ok(classOf({ state: 'tracked' }) === 'clean', 'tracked is clean');
ok(classOf({ state: 'traced', hops: 12 }) === 'clean', 'traced is clean');
ok(classOf({ state: 'long', hops: 300, max: 255 }) === 'long', 'long is long');
ok(classOf({ state: 'unprovable', through: 'shielded' }) === 'pool-exit', 'unprovable through a shielded-pool leaf (opcode 0x6c/0x6d) is pool-exit');
ok(classOf({ state: 'unprovable', through: 'pool' }) === 'unprovable', 'unprovable through a pool or farm trade is unprovable, not pool-exit');
ok(classOf({ state: 'unprovable', through: 'arrived' }) === 'unprovable', 'unprovable through a cross-out mint is unprovable, not pool-exit');
ok(classOf({ state: 'unprovable', through: 'other' }) === 'unprovable', 'unprovable through anything else is unprovable');
ok(classOf({ state: 'unprovable' }) === 'unprovable', 'unprovable with no through named is unprovable');
ok(classOf({ state: 'unread' }) === 'unread', 'unread is unread');
ok(classOf(undefined) === 'unread', 'a verdict the vet has not got is unread');
ok(classOf(null) === 'unread', 'a null verdict is unread');
ok(classOf({ state: 'something-new' }) === 'unread', 'an unrecognised state is unread, never taken on a guess');
ok(worstClass(['clean', 'long', 'clean']) === 'long', 'the worst class of a lock is its dearest note');
ok(worstClass(['long', 'pool-exit']) === 'pool-exit', 'pool-exit is worse than long');
ok(worstClass(['pool-exit', 'unprovable']) === 'unprovable', 'unprovable is the worst class');
ok(worstClass(['unread', 'clean']) === 'clean', 'unread is not weighed as a class');
ok(worstClass([]) === 'clean', 'an empty lock weighs clean');
ok(STUCK_CLASSES.join() === 'clean,long,pool-exit,unprovable', 'the classes stand in fee order');

// ── the haircut math, against the assumptions worked by hand ──
// defaults: unsticking costs 30 bps + a flat 1 TAC a note; a long note never unsticks a tenth of the time, a pool exit a
// fifth, an unprovable note half; nothing is recovered of one that never unsticks.
ok(haircutBps('clean') === 0, 'clean has no haircut');
ok(haircutBps('long') === 1027, 'long: 1000 of loss + 9000 x 30 bps of cost = 1027 bps');
ok(haircutBps('pool-exit') === 2024, 'pool-exit: 2000 of loss + 8000 x 30 bps of cost = 2024 bps');
ok(haircutBps('unprovable') === 5015, 'unprovable: 5000 of loss + 5000 x 30 bps of cost = 5015 bps');
ok(haircutBps('long', { classes: { long: { neverBps: 1, costBps: 1, recoveryBps: 0 } } }) === 2, 'the haircut rounds up: (1 x 10000 + 9999 x 1) / 10000 = 1.9999 -> 2');
ok(haircutBps('long', { classes: { long: { neverBps: 1000, costBps: 30, recoveryBps: 10000 } } }) === 27, 'a class recovered in full when it never unsticks loses only the cost: 9000 x 30 / 10000 = 27');
ok(expectedFlat('clean') === 0n, 'clean has no expected flat cost');
ok(expectedFlat('long') === 90_000_000n, 'long: the flat 1 TAC, paid by the nine tenths that unstick = 0.9 TAC');
ok(expectedFlat('pool-exit') === 80_000_000n, 'pool-exit: the flat 1 TAC, paid by the four fifths that unstick = 0.8 TAC');
ok(expectedFlat('unprovable') === 50_000_000n, 'unprovable: the flat 1 TAC, paid by the half that unstick = 0.5 TAC');

// the fee a class is taken at: the standing fee plus exactly the expected haircut (at an amount the bps divide evenly)
{
  const a = U(100), base = { feeBps: 30, flatFee: 10_000_000n };
  for (const cls of ['long', 'pool-exit', 'unprovable']) {
    const uplift = classFee(a, cls, { base }) - classFee(a, 'clean', { base });
    ok(uplift === (a * BigInt(haircutBps(cls, { base }))) / 10000n + expectedFlat(cls, { base }), `${cls}: the uplift over the standing fee is the expected haircut, no more and no less`);
  }
  ok(classFee(a, 'long', { base }) === 1_157_000_000n, 'a 100 TAC long bridge at the defaults pays 11.57 TAC (10.27 of haircut bps, 0.9 of expected flat, 0.4 standing)');
  const raised = classTerms('long', { base, classes: { long: { upliftBps: 1 } } });
  ok(raised.feeBps === 30 + 1027, 'an uplift under the haircut is raised to it: the fee never falls below the floor the config gives');
  const higher = classTerms('long', { base, classes: { long: { upliftBps: 3000 } } });
  ok(higher.feeBps === 30 + 3000, 'an uplift over the haircut stands: a provider may charge more than the floor');
}

// ── the break-even edge: the least amount a class can be quoted at ──
{
  const cfg = { base: { feeBps: 30, flatFee: 10_000_000n } };
  for (const cls of ['long', 'pool-exit', 'unprovable']) {
    const min = minAmountFor(cls, cfg);
    ok(min > 0n && classFee(min, cls, cfg) < min, `${cls}: at its least amount (${min} units) the fee is less than the amount`);
    ok(classFee(min - 1n, cls, cfg) >= min - 1n, `${cls}: one unit under its least amount, the fee swallows the amount`);
  }
  ok(minAmountFor('clean', cfg) === 0n, 'clean has no least amount of its own');
  ok(minAmountFor('long', { base: { feeBps: 0, flatFee: 0n }, classes: { long: { upliftBps: 10000 } } }) === null, 'a fee of the whole amount pays at no amount');
}

// ── who takes what ──
ok(takesClass('clean', null) === true && takesClass('long', null) === true, 'with no terms, clean and long are taken (as the lineage screen passes them)');
ok(takesClass('pool-exit', null) === false && takesClass('unprovable', null) === false, 'with no terms, the unprovable classes are not taken');
ok(takesClass('pool-exit', { classes: {} }) === true, 'with terms written, pool-exit is taken priced unless the entry says not');
ok(takesClass('unprovable', { classes: {} }) === false, 'with terms written, unprovable is not taken unless the entry says so');
ok(takesClass('unprovable', { classes: { unprovable: { take: true } } }) === true, 'a provider may price even unprovable TAC, on purpose');

// ── the stuck-share cap, as a predicate ──
ok(stuckShareOk(U(1500), U(10000), U(100), U(100), { maxStuckShareBps: 2000 }) === true, 'a lock that keeps the stuck share under the cap passes (1600 of 10100)');
ok(stuckShareOk(U(1950), U(10000), U(100), U(100), { maxStuckShareBps: 2000 }) === false, 'a lock that takes the stuck share past the cap fails (2050 of 10100)');
ok(stuckShareOk(0n, 0n, U(100), U(100), {}) === false, 'nothing held yet: one stuck lock is the whole of what is held, past any share cap');
ok(stuckShareOk(0n, 0n, 0n, U(100), {}) === true, 'nothing held yet: a clean lock adds nothing stuck and passes');

// ── the screens ──
const note = (i) => ({ txid: String(i).repeat(64), vout: 0 });
const vetOf = (byIndex) => async (inputs) => new Map(inputs.map((inp) => [`${inp.txid}:${inp.vout}`, byIndex[Number(inp.txid[0])]]));
const TRACKED = { state: 'tracked' }, LONG = { state: 'long', hops: 300, max: 255 }, EXIT = { state: 'unprovable', through: 'shielded' }, POOL = { state: 'unprovable', through: 'pool' }, UNREAD = { state: 'unread' };

// backwards compat: no terms, the priced screen is the lineage screen on the same verdicts, word for word
{
  const cases = [
    ['no notes', [], {}], ['all tracked', [note(1)], { 1: TRACKED }], ['a traced and a long note', [note(1), note(2)], { 1: { state: 'traced', hops: 3 }, 2: LONG }],
    ['a long note alone', [note(1)], { 1: LONG }], ['a pool exit', [note(1)], { 1: EXIT }], ['a pool trade', [note(1)], { 1: POOL }], ['an unread note', [note(1)], { 1: UNREAD }],
    ['a note with no verdict', [note(1), note(2)], { 1: TRACKED }], ['an unprovable and an unread note', [note(1), note(2)], { 1: EXIT, 2: UNREAD }], ['a long and an unread note', [note(1), note(2)], { 1: LONG, 2: UNREAD }],
  ];
  for (const [name, inputs, byIndex] of cases) {
    const vet = vetOf(byIndex);
    const [a, b] = [await lineageScreen(vet)(inputs), await pricedScreen(vet, null)(inputs)];
    ok(JSON.stringify(a) === JSON.stringify(b), `no terms, ${name}: priced screen = lineage screen (${JSON.stringify(a)})`);
    const c = await pricedScreen(vet, {})(inputs);
    ok(JSON.stringify(a) === JSON.stringify(c), `empty terms, ${name}: priced screen = lineage screen`);
  }
}

// with terms: the class decisions
{
  const cfg = { base: { feeBps: 30, flatFee: 10_000_000n }, classes: { long: { take: true }, 'pool-exit': { take: true }, unprovable: { take: false } } };
  const screen = pricedScreen(vetOf({ 1: LONG }), cfg);
  ok((await screen([note(1)]))?.why.includes('long'), 'a long lock under no quote is refused: its quote was priced as clean');
  ok((await screen([note(1)], { cls: 'clean' }))?.why.includes('long'), 'a long lock under a clean quote is refused, naming the class');
  ok((await screen([note(1)], { cls: 'long' })) === null, 'a long lock under a long quote goes on');
  ok((await screen([note(1)], { cls: 'pool-exit' })) === null, 'a long lock under a dearer quote goes on');
  const exitScreen = pricedScreen(vetOf({ 1: EXIT }), cfg);
  ok((await exitScreen([note(1)], { cls: 'long' }))?.why.includes('pool-exit'), 'a pool-exit lock under a long quote is refused, naming both classes');
  ok((await exitScreen([note(1)], { cls: 'pool-exit' })) === null, 'a pool-exit lock under a pool-exit quote goes on');
  const poolScreen = pricedScreen(vetOf({ 1: POOL }), cfg);
  ok((await poolScreen([note(1)], { cls: 'unprovable' }))?.why.includes('does not take'), 'a class the provider does not take is refused at any quote');
  const unreadScreen = pricedScreen(vetOf({ 1: UNREAD }), cfg);
  const r = await unreadScreen([note(1)], { cls: 'long' });
  ok(r && r.retry === true, 'an unread history retries, under terms as without');
  const cleanScreen = pricedScreen(vetOf({ 1: TRACKED }), cfg);
  ok((await cleanScreen([note(1)])) === null, 'a clean lock goes on under terms');
  // the cap, wired through a held the host tracks
  const capped = { ...cfg, maxStuckShareBps: 2000, held: async () => ({ stuck: U(1950), total: U(10000) }) };
  ok((await pricedScreen(vetOf({ 1: LONG }), capped)([note(1)], { cls: 'long', btcValue: String(U(100)) }))?.why.includes('past the limit'), 'a lock past the stuck-share cap is refused');
  const roomy = { ...cfg, maxStuckShareBps: 2000, held: async () => ({ stuck: U(1500), total: U(10000) }) };
  ok((await pricedScreen(vetOf({ 1: LONG }), roomy)([note(1)], { cls: 'long', btcValue: String(U(100)) })) === null, 'a lock within the stuck-share cap goes on');
}

// ── the quoter, where the fee binds ──
{
  const kept = new Map();
  const store = { put: async (q) => kept.set(q.id, q), get: async (id) => kept.get(id) || null };
  const params = { minAmount: '1000000000', maxAmount: '100000000000', feeBps: 30, flatFee: 10_000_000n, claimPub: 'ab'.repeat(33), btcAsset: 'btc', evmAsset: 'evm', csvBlocks: 144, evmWindowSecs: 14400, minConfsFor: () => 1, validSecs: 600 };
  const macKey = new Uint8Array(32).fill(3);
  const plain = makeQuoter({ store, now: () => 1000, params, macKey });
  const p0 = plain.price(U(100));
  ok(p0.fee === 40_000_000n && p0.evmAmount === U(100) - 40_000_000n, 'no stuck terms: a quote is priced as it always was (0.4 TAC of 100)');
  const q0 = await plain.quote(U(100));
  ok(!q0.cls && /^[0-9a-f]{122}$/.test(q0.id), 'no stuck terms: the quote is sealed and carries no class');
  const p0c = plain.price(U(100), 'long');
  ok(p0c.fee === p0.fee, 'no stuck terms: a class named in the request is ignored, as an old provider ignores it');

  const stuck = { classes: { long: { take: true }, 'pool-exit': { take: true }, unprovable: { take: false } } };
  const priced = makeQuoter({ store, now: () => 1000, params: { ...params, stuck }, macKey });
  const pl = priced.price(U(100), 'long');
  ok(pl.fee === 1_157_000_000n, 'a long quote is priced at the class fee (11.57 TAC of 100)');
  const ql = await priced.quote(U(100), 'long');
  ok(ql.cls === 'long' && /^[0-9a-f]{32}$/.test(ql.id), 'a class quote carries its class and is stored, not sealed');
  ok((await priced.get(ql.id))?.cls === 'long', 'a stored class quote reads back with its class');
  const qc = await priced.quote(U(100));
  ok(!qc.cls && /^[0-9a-f]{122}$/.test(qc.id), 'an unnamed quote from a priced provider is sealed and classless, as before');
  let refused = null;
  try { priced.price(U(100), 'unprovable'); } catch (e) { refused = e; }
  ok(refused && refused.status === 400 && /does not take/.test(refused.message), 'a class the provider does not take is not quoted');
  let unknown = null;
  try { priced.price(U(100), 'bogus'); } catch (e) { unknown = e; }
  ok(unknown && unknown.status === 400, 'an unknown class is not quoted');
  let swallowed = null;
  const low = makeQuoter({ store, now: () => 1000, params: { ...params, minAmount: '1', stuck }, macKey });
  try { low.price(100_000_000n, 'long'); } catch (e) { swallowed = e; }
  ok(swallowed && /does not cover the fee/.test(swallowed.message), 'a long quote under its least amount is refused: the amount does not cover the fee');
  ok(low.price(minAmountFor('long', { base: { feeBps: 30, flatFee: 10_000_000n } }), 'long').fee >= 0n, 'a long quote at its least amount is given');
}

// ── the advertised schedule ──
{
  const s = stuckSchedule({ classes: { long: { take: true }, 'pool-exit': { take: true }, unprovable: { take: false } } }, { feeBps: 30, flatFee: 10_000_000n });
  ok(s.long.take === true && s.long.feeBps === 1057 && s.long.flatFee === '100000000', 'the schedule carries the long fee (1057 bps, 1 TAC flat)');
  ok(s['pool-exit'].feeBps === 2054 && s.unprovable.take === false, 'the schedule carries the pool-exit fee and the unprovable refusal');
  ok(BigInt(s.long.minAmount) > 0n && classFee(BigInt(s.long.minAmount), 'long', { base: { feeBps: 30, flatFee: 10_000_000n } }) < BigInt(s.long.minAmount), 'the schedule\'s least amount pays its own fee');
}

console.log(failures ? `\n${failures} FAILURES (${n} passed)` : `\nall ${n} stuck-terms checks passed`);
process.exit(failures ? 1 : 0);
