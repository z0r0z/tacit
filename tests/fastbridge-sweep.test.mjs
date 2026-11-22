// The rule for splitting a bridge across providers (dapp/fast/sweep.js): who can take a part, the cheapest split, and sharing the key's notes out
// among the parts. No wallet and no network: the providers' terms and the notes are made up.
//   node tests/fastbridge-sweep.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { sweepRoom, splitAmount, assignNotes, takers, feeAt, MAX_LEGS, LEG_PENALTY } from '../dapp/fast/sweep.js';
import { pickNotes } from '../dapp/fastbridge-client.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const TAC = 10n ** 8n;
const prov = (id, { min = 10, max = 1000, available = null, bps = 30, flat = 0, any = true } = {}) => ({
  id, name: id, ref: { kind: 'http', claimPub: id },
  terms: { feeBps: bps, flatFee: BigInt(flat) * TAC, minAmount: BigInt(min) * TAC, maxAmount: BigInt(max) * TAC, available: available == null ? null : BigInt(available) * TAC, anyTac: any },
});
const note = (n, amount) => ({ txid: String(n).repeat(64), vout: 0, amount: BigInt(amount) * TAC, value: 546 });
const sum = (xs) => xs.reduce((s, x) => s + x, 0n);

test('who a part can go to: providers that take any TAC and have room; the room is what they take now, not the most they ever would', () => {
  const ps = [prov('a', { available: 500 }), prov('b', { available: 0 }), prov('c', { any: false, available: 900 }), prov('d', { min: 50, available: 30 }), prov('e', { max: 400 })];
  assert.deepEqual(takers(ps).map((p) => p.id), ['a', 'e'], 'a screening provider, a full one, and one whose room is under its least are left out');
  assert.equal(sweepRoom(ps), 900n * TAC, '500 + 400');
  assert.equal(sweepRoom([prov('x', { available: 0 })]), 0n);
  assert.equal(sweepRoom([]), 0n);
  // only the MAX_LEGS with the most room count: more than that cannot be split across
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => prov(id, { available: 100 + i * 10 }));
  assert.equal(MAX_LEGS, 4);
  assert.equal(sweepRoom(many), (150n + 140n + 130n + 120n) * TAC);
});

test('the fee of a part is the provider\'s own sum: a rate on the amount, rounded down, and a flat part', () => {
  const t = prov('a', { bps: 150, flat: 5 }).terms;
  assert.equal(feeAt(t, 1000n * TAC), 15n * TAC + 5n * TAC);
  assert.equal(feeAt(prov('b', { bps: 30 }).terms, 333n), 0n, 'rounded down, as the quote is');
  assert.equal(feeAt(prov('b', { bps: 30 }).terms, 33400n), 100n);
});

test('a split gives each part its provider\'s least, then fills the cheapest rate first, and no part is over what its provider can take', () => {
  const ps = [prov('dear', { available: 500, bps: 400 }), prov('cheap', { available: 300, bps: 100 }), prov('mid', { available: 400, bps: 200 })];
  const [best] = splitAmount({ amount: 1000n * TAC, providers: ps });
  const by = Object.fromEntries(best.legs.map((l) => [l.provider.id, l.amount / TAC]));
  assert.equal(sum(best.legs.map((l) => l.amount)), 1000n * TAC, 'the parts add up to the amount');
  assert.deepEqual(by, { dear: 300n, cheap: 300n, mid: 400n }, 'cheap and mid are filled to their room, dear takes only what is left');
  for (const l of best.legs) assert.ok(l.amount >= l.provider.terms.minAmount && l.amount <= l.provider.terms.available);
  assert.equal(best.fee, sum(best.legs.map((l) => l.fee)));
  assert.equal(best.receive, 1000n * TAC - best.fee);
  assert.deepEqual(best.legs.map((l) => l.amount), best.legs.map((l) => l.amount).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)), 'the largest part first');
});

test('what cannot be split: more than the providers hold, less than their leasts together, a provider that cannot clear its own fee, and providers asked to be left out', () => {
  const ps = [prov('a', { available: 500 }), prov('b', { available: 400 })];
  assert.equal(splitAmount({ amount: 901n * TAC, providers: ps }).length, 0, 'over what the two hold');
  assert.equal(splitAmount({ amount: 900n * TAC, providers: ps }).length, 1);
  assert.equal(splitAmount({ amount: 15n * TAC, providers: [prov('a', { min: 10 }), prov('b', { min: 10 })] }).length, 0, 'each part is at least its provider\'s least');
  assert.equal(splitAmount({ amount: 100n * TAC, providers: [prov('a', { min: 10, flat: 60 }), prov('b', { min: 10, flat: 60 })] }).length, 0, 'a part of 50 does not clear a flat fee of 60');
  assert.equal(splitAmount({ amount: 900n * TAC, providers: ps, exclude: new Set(['b']) }).length, 0, 'left out');
  assert.equal(splitAmount({ amount: 900n * TAC, providers: [prov('a', { available: 500 })] }).length, 0, 'one provider is not a split');
  assert.equal(splitAmount({ amount: 900n * TAC, providers: [prov('a', { available: 500 }), prov('b', { available: 400, any: false })] }).length, 0, 'a screening provider is not asked');
});

test('at most four parts, and a plan with fewer parts wins when it costs almost the same: each extra part has its own Bitcoin fee', () => {
  const five = ['a', 'b', 'c', 'd', 'e'].map((id) => prov(id, { available: 200, bps: 100 }));
  assert.equal(splitAmount({ amount: 900n * TAC, providers: five }).length, 0, 'five parts of 200 would be needed, and four are the most');
  assert.ok(splitAmount({ amount: 800n * TAC, providers: five }).every((p) => p.legs.length <= 4));
  // 600 over cheap-but-small ones (3 parts at 1%) or over two bigger ones at 1.05%: the difference in fee is under the price of the extra part
  const ps = [prov('s1', { available: 200, bps: 100 }), prov('s2', { available: 200, bps: 100 }), prov('s3', { available: 200, bps: 100 }), prov('b1', { available: 300, bps: 105 }), prov('b2', { available: 300, bps: 105 })];
  const [best] = splitAmount({ amount: 600n * TAC, providers: ps });
  assert.equal(best.legs.length, 2, 'two parts at a hair more, not three');
  assert.ok(LEG_PENALTY > 0n);
  // but a plan that costs a lot less with more parts still wins
  const cheap3 = [prov('s1', { available: 200, bps: 50 }), prov('s2', { available: 200, bps: 50 }), prov('s3', { available: 200, bps: 50 }), prov('b1', { available: 300, bps: 400 }), prov('b2', { available: 300, bps: 400 })];
  assert.equal(splitAmount({ amount: 600n * TAC, providers: cheap3 })[0].legs.length, 3);
});

test('the cheapest split found equals the cheapest there is: every way to share amounts out among every set of providers, tried', () => {
  // amounts in whole hundreds so the rates divide exactly and the comparison is exact
  let seed = 7, compared = 0;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const rates = [100, 200, 500, 1000];
  for (let round = 0; round < 40; round++) {
    const n = 2 + rnd(4);
    const ps = Array.from({ length: n }, (_, i) => prov('p' + i, { min: 100 * (1 + rnd(2)), max: 800, available: 100 * (2 + rnd(5)), bps: rates[rnd(4)], flat: 100 * rnd(2) }));
    const A = 100n * BigInt(3 + rnd(12)) * TAC / 100n * 100n;
    const plans = splitAmount({ amount: A, providers: ps });
    // brute force: every subset of 2 to 4, every allocation in steps of 100
    let bestScore = null;
    const step = 100n * TAC;
    for (let mask = 0; mask < 1 << n; mask++) {
      const set = ps.filter((_, i) => mask & (1 << i));
      if (set.length < 2 || set.length > 4) continue;
      const go = (i, left, picked) => {
        if (i === set.length) { if (left === 0n) { const fee = sum(picked.map((a, k) => feeAt(set[k].terms, a))); if (picked.every((a, k) => a > feeAt(set[k].terms, a))) { const score = fee + LEG_PENALTY * BigInt(set.length); if (bestScore == null || score < bestScore) bestScore = score; } } return; }
        const t = set[i].terms, cap = t.available < t.maxAmount ? t.available : t.maxAmount;
        for (let a = t.minAmount; a <= cap && a <= left; a += step) go(i + 1, left - a, [...picked, a]);
      };
      go(0, A, []);
    }
    if (bestScore == null) { assert.equal(plans.length, 0, `round ${round}: nothing to find`); continue; }
    assert.ok(plans.length > 0, `round ${round}: a plan exists`);
    assert.equal(plans[0].score, bestScore, `round ${round}: the best plan is the cheapest (${plans[0].score} vs ${bestScore})`);
    compared++;
  }
  assert.ok(compared >= 15, `the check compared ${compared} instances: too few for it to mean anything`);
});

test('sharing the notes out: each part gets notes of its own, none in two parts, and what a part is given is what its lock will spend', () => {
  const notes = [note(1, 900), note(2, 300), note(3, 250), note(4, 100)];
  const got = assignNotes([800n * TAC, 400n * TAC], notes, pickNotes);
  assert.deepEqual(got.map((g) => g.notes.map((n) => n.amount / TAC)), [[900n], [300n, 250n]], 'one big note for the big part, two for the other');
  const used = got.flatMap((g) => g.notes.map((n) => n.txid));
  assert.equal(new Set(used).size, used.length, 'no note is in two parts');
  assert.deepEqual(got.map((g) => g.change / TAC), [100n, 150n]);
  // what each part is given covers it and is what the client picks from it
  got.forEach((g, i) => assert.deepEqual(pickNotes(g.notes, [800n, 400n][i] * TAC).notes.map((n) => n.txid), g.notes.map((n) => n.txid)));
  // the order matters: 600 first takes a 400 and a 300 and leaves 300, short of 400; 400 first takes the 400 and leaves two 300s for the 600
  const tight = [note(5, 400), note(6, 300), note(7, 300)];
  const ok = assignNotes([600n * TAC, 400n * TAC], tight, pickNotes);
  assert.ok(ok, 'found by trying the other order');
  assert.deepEqual(ok.map((g) => g.notes.map((n) => n.amount / TAC)), [[300n, 300n], [400n]]);
  // answers keep the order of the amounts asked for
  assert.deepEqual(assignNotes([400n * TAC, 600n * TAC], tight, pickNotes).map((g) => sum(g.notes.map((n) => n.amount)) / TAC), [400n, 600n]);
});

test('notes that cannot be shared out: they do not add up, or one part would need more inputs than a lock takes; one note is one part', () => {
  assert.equal(assignNotes([300n * TAC, 600n * TAC], [note(1, 500), note(2, 450)], pickNotes), null, '950 in two notes cannot make 300 and 600');
  assert.equal(assignNotes([500n * TAC, 500n * TAC], [note(1, 1000)], pickNotes), null, 'one note of 1,000 funds one lock: its change is not confirmed for a second');
  const dust = Array.from({ length: 8 }, (_, i) => note(i + 1, 100));
  assert.equal(assignNotes([700n * TAC, 100n * TAC], dust, pickNotes), null, 'seven inputs is over the six a lock takes');
  assert.ok(assignNotes([300n * TAC, 400n * TAC], dust, pickNotes), 'three and four inputs are fine');
  assert.equal(assignNotes([100n * TAC], [], pickNotes), null);
});

let passed = 0, ran = 0;
for (const [name, fn] of tests) {
  ran++;
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`  ok - ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${ran} split-bridge checks passed`);
process.exit(process.exitCode || 0);
