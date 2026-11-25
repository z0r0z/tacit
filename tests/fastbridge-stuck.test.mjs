// The pricing and policy rule for TAC that cannot go home (dapp/fastbridge-stuck.js): a provider that takes a note the burn proof
// cannot carry — out of the shielded pool, or past the 255-transfer fold — at its ordinary fee is left holding Bitcoin TAC worth less
// than the TAC it lent. These tests hold the rule to its claims offline: classes come from the trace's own verdicts, a stuck class is
// charged a premium that covers its expected haircut plus a margin, a lock that cannot be read is not priced on a guess, stuck
// holdings are bounded by a stated share, and a clean lock costs exactly what it costs today. The last test is the brief's numbers: a
// provider's holdings after N bridges, with and without the rule.
//   node tests/fastbridge-stuck.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { classOfState, lockClass, premiumBps, advertisedStuckFees, premiumFor, feeOfClass, coversHaircut, judgeStuck, stuckScreen, DEFAULT_STUCK_POLICY } from '../dapp/fastbridge-stuck.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const TERMS = { feeBps: 30, flatFee: 0 };
const feeOf = (terms, amount) => (BigInt(amount) * BigInt(terms.feeBps ?? 0)) / 10000n + BigInt(terms.flatFee ?? 0);

test('classes come from the trace\u2019s verdicts: tracked and traced are clean, long is long, unprovable is pool, unread has no class', () => {
  assert.equal(classOfState('tracked'), 'clean');
  assert.equal(classOfState('traced'), 'clean');
  assert.equal(classOfState('long'), 'long');
  assert.equal(classOfState('unprovable'), 'pool');
  assert.equal(classOfState('unread'), null);
  assert.equal(classOfState(undefined), null);
  assert.equal(classOfState('something new'), null, 'a verdict this rule does not know is not priced as clean');
});

test('a lock is priced by its worst note, and one unread note leaves the whole lock unpriced', () => {
  assert.equal(lockClass(['tracked', 'traced']), 'clean');
  assert.equal(lockClass(['tracked', 'long']), 'long');
  assert.equal(lockClass(['long', 'unprovable']), 'pool');
  assert.equal(lockClass(['tracked', 'unread']), null);
  assert.equal(lockClass([]), 'clean', 'a lock of no notes (plain sats) is clean');
});

test('the premium is the expected haircut plus the margin; clean adds none; the policy is the provider\u2019s own', () => {
  assert.equal(premiumBps('clean'), 0);
  assert.equal(premiumBps('long'), 700, 'default: 5 in 100 haircut + 2 in 100 margin');
  assert.equal(premiumBps('pool'), 1200, 'default: 10 in 100 haircut + 2 in 100 margin');
  assert.equal(premiumBps('long', { haircutBps: { long: 900 }, marginBps: 100 }), 1000);
  assert.deepEqual(advertisedStuckFees(), { long: 700, pool: 1200 });
  assert.equal(DEFAULT_STUCK_POLICY.maxStuckBps, 2000);
});

test('the fee of a class is the ordinary fee plus the premium, rounded down as the fee is; clean is unchanged', () => {
  for (const amount of [0n, 1n, 9999n, 10000n, 123456789n]) {
    assert.equal(feeOfClass(TERMS, amount, 'clean'), feeOf(TERMS, amount), 'a clean lock costs what it costs today');
  }
  assert.equal(premiumFor(10000n, 'long'), 700n);
  assert.equal(premiumFor(9999n, 'long'), 699n, 'rounded down, like the fee itself');
  assert.equal(feeOfClass(TERMS, 10000n, 'long'), 30n + 700n, 'the ordinary fee of 10,000 at 30 bps is 30, plus the 700 premium');
  assert.equal(feeOfClass({ feeBps: 30, flatFee: 50 }, 10000n, 'pool'), 30n + 50n + 1200n, 'the flat part stands, the premium is on the amount');
});

test('at the defaults the premium covers the haircut; a policy that prices under its own haircut says so', () => {
  assert.equal(coversHaircut(TERMS, 100000n, 'long'), true);
  assert.equal(coversHaircut(TERMS, 100000n, 'pool'), true);
  assert.equal(coversHaircut(TERMS, 100000n, 'long', { marginBps: -300 }), false, 'a premium of 2 in 100 against a 5 in 100 haircut does not cover it');
});

test('judgeStuck: a take is priced, an unread lock is retried, a class the provider does not take is refused', () => {
  const ok = judgeStuck({ states: ['tracked', 'long'], amount: 10000n, terms: TERMS });
  assert.equal(ok.ok, true);
  assert.equal(ok.cls, 'long');
  assert.equal(ok.fee, feeOfClass(TERMS, 10000n, 'long'));
  const unread = judgeStuck({ states: ['unread'], amount: 10000n, terms: TERMS });
  assert.equal(unread.ok, false);
  assert.equal(unread.retry, true);
  const off = judgeStuck({ states: ['unprovable'], amount: 10000n, terms: TERMS, policy: { take: { pool: false } } });
  assert.equal(off.ok, false);
  assert.match(off.why, /does not take/);
});

test('judgeStuck: the stuck limit refuses the take that crosses it, and only stuck takes', () => {
  const held = { stuck: 1900n, total: 10000n }; // 19 in 100 stuck, limit a fifth
  const over = judgeStuck({ states: ['long'], amount: 1000n, terms: TERMS, held });
  assert.equal(over.ok, false, '1900 + 1000 of 11,000 is past a fifth');
  assert.match(over.why, /limit/);
  const under = judgeStuck({ states: ['long'], amount: 100n, terms: TERMS, held });
  assert.equal(under.ok, true, '1900 + 100 of 10,100 is still under a fifth');
  const clean = judgeStuck({ states: ['tracked'], amount: 1000n, terms: TERMS, held: { stuck: 9000n, total: 10000n } });
  assert.equal(clean.ok, true, 'clean TAC is lent however much stuck TAC is held: it goes home');
});

test('stuckScreen is a policy.screen: null to go on, { why, retry } to refuse, in lineageScreen\u2019s shape', async () => {
  const vetOf = (states) => async (inputs) => new Map(inputs.map((n, i) => [`${n.txid}:${n.vout}`, { state: states[i] }]));
  const notes = [{ txid: 'a', vout: 0 }, { txid: 'b', vout: 1 }];
  assert.equal(await stuckScreen(vetOf(['tracked', 'traced']))(notes), null);
  assert.equal(await stuckScreen(vetOf(['tracked', 'long']))(notes), null, 'long is priced, not refused, at the defaults');
  const unread = await stuckScreen(vetOf(['tracked', 'unread']))(notes);
  assert.equal(unread.retry, true);
  const off = await stuckScreen(vetOf(['unprovable', 'tracked']), { policy: { take: { pool: false } } })(notes);
  assert.match(off.why, /does not take/);
  assert.equal(off.retry, undefined);
  const capped = await stuckScreen(vetOf(['long', 'tracked']), { held: async () => ({ stuck: 9900n, total: 10000n, amount: 1000n }) })(notes);
  assert.match(capped.why, /limit/, 'with held amounts the screen holds the limit too');
});

// The brief's numbers. A provider starts with 1,000,000 units of Ethereum-side inventory and no Bitcoin TAC, and is offered 2,000
// bridges of 10,000. The mix is the brief's count made plain: of every 100 locks, 93 are clean, 5 are long (230 of 4,546 notes were
// past the fold on 2026-11-22, about 5 in 100), 2 are pool exits (not counted there; 2 in 100 is stated as an assumption). A clean
// note takes ten bridges to come home over the regular bridge (a burn and the reflection take hours) and is then lent again; a stuck
// note stays on Bitcoin and is worth its face less its class's haircut when sold there. Fees are kept as value. Three providers: one
// that takes any TAC at its ordinary fee, one that prices by this rule, one that prices and also holds the stuck limit against what
// its Bitcoin wallet holds (stuck face over wallet face, judged before each take).
test('after N bridges: unpriced stuck TAC runs the provider out of lendable TAC and leaves its haircut to be paid from its clean fees, the premium keeps it whole, the limit bounds what is stranded', () => {
  const SIZE = 10000n, START = 1000000n, OFFERED = 2000, HOME_TRIP = 10;
  const clsOf = (i) => (i % 100 < 93 ? 'clean' : i % 100 < 98 ? 'long' : 'pool');
  const stateOf = (cls) => (cls === 'clean' ? 'tracked' : cls === 'long' ? 'long' : 'unprovable');
  const recoverable = (stuck) => (stuck.long * 9500n) / 10000n + (stuck.pool * 9000n) / 10000n;
  const run = (mode) => {
    let evm = START, fees = 0n, baseFees = 0n, served = 0, refused = 0, maxShareBps = 0n;
    const stuck = { long: 0n, pool: 0n };
    const transit = []; // clean TAC on its way home: { left, amount }
    for (let i = 0; i < OFFERED; i++) {
      for (const t of transit) t.left--;
      for (let k = transit.length - 1; k >= 0; k--) if (transit[k].left <= 0) { evm += transit[k].amount; transit.splice(k, 1); }
      const cls = clsOf(i);
      const stuckFace = stuck.long + stuck.pool;
      const wallet = stuckFace + transit.reduce((s, t) => s + t.amount, 0n);
      if (cls !== 'clean' && mode === 'capped') {
        const j = judgeStuck({ states: [stateOf(cls)], amount: SIZE, terms: TERMS, held: { stuck: stuckFace, total: wallet } });
        if (!j.ok) { refused++; continue; }
      }
      const fee = mode === 'plain' ? feeOf(TERMS, SIZE) : feeOfClass(TERMS, SIZE, cls);
      if (evm < SIZE - fee) break;
      evm -= SIZE - fee; fees += fee; baseFees += feeOf(TERMS, SIZE); served++;
      if (cls === 'clean') transit.push({ left: HOME_TRIP, amount: SIZE });
      else {
        stuck[cls] += SIZE;
        const share = ((stuck.long + stuck.pool) * 10000n) / (stuck.long + stuck.pool + transit.reduce((s, t) => s + t.amount, 0n));
        if (share > maxShareBps) maxShareBps = share;
      }
    }
    evm += transit.reduce((s, t) => s + t.amount, 0n);
    const stuckFace = stuck.long + stuck.pool;
    return { served, refused, stuckFace, recoverable: recoverable(stuck), fees, baseFees, maxShareBps, net: evm - START + recoverable(stuck) + fees };
  };
  const a = run('plain'), b = run('priced'), c = run('capped');
  console.log(`    after ${OFFERED} offered bridges of 10,000 (start 1,000,000):`);
  console.log(`      takes any TAC, ordinary fee: served ${a.served}, stuck ${a.stuckFace} (worth ${a.recoverable}), fees ${a.fees}, net ${a.net}`);
  console.log(`      prices stuck TAC by class:   served ${b.served}, stuck ${b.stuckFace} (worth ${b.recoverable}), fees ${b.fees}, net ${b.net}`);
  console.log(`      prices and holds the limit:  served ${c.served} (${c.refused} stuck refused), stuck ${c.stuckFace} (worth ${c.recoverable}), fees ${c.fees}, net ${c.net}`);
  assert.ok(a.served < OFFERED, 'the unpriced provider runs out of Ethereum-side TAC before the offers do');
  assert.ok(a.stuckFace > a.recoverable, 'it carries a real haircut loss on the stuck TAC it holds, paid out of the fees its clean bridges earned');
  assert.ok(b.net > a.net, 'the priced provider ends ahead of the unpriced one on the same offers');
  assert.ok(b.served > a.served, 'and is still lending after the unpriced one has stopped: the premiums replenish what it lends');
  assert.ok(b.fees - b.baseFees >= b.stuckFace - b.recoverable, 'the premium income alone covers the haircut on what it holds');
  assert.equal(c.served + c.refused, OFFERED, 'the capped provider is still answering at the end: clean capacity never drained');
  assert.ok(c.maxShareBps <= 2000n, 'what it holds stuck never passes its stated share of its Bitcoin wallet');
  assert.ok(c.stuckFace < b.stuckFace, 'and it holds far less stuck TAC than the provider without the limit');
  assert.ok(c.net > 0n, 'and it ends ahead too, having risked the least');
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}\n  ${e.message}`); process.exitCode = 1; }
}
console.log(`${passed}/${tests.length} passed`);
