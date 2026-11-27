// The front page's "Both" add to a farm (dapp/index.html): notes already cut for an add are used again when the pool's price has moved a little since, instead of being
// cut again at the relay's fee. The real source is cut out of the page and run with stand-ins for the private balance (the technique of tests/zap-page-flows.test.mjs):
//   noteNear / noteFits   the nearest free note within the cut's cost and 0.4% of itself serves; with none near, a note of exactly the size does (so a fresh cut is found)
//   joinPairPlan          the quote charges no cut for a side whose note is near, and charges it for one that is not
//   the bond's own rule   every note noteNear takes passes assertLpInRatio (dapp/confidential-pool-ux.js), the refusal the bond makes at more than 0.5% of a side off the ratio
//   joinNow               takes the B note by noteFits and carries its real value on
//   node --test tests/farm-pair-reuse.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { frontPage } from './lib/front-page.mjs';

const html = frontPage(new URL('../dapp/index.html', import.meta.url));
const ux = readFileSync(new URL('../dapp/confidential-pool-ux.js', import.meta.url), 'utf8');
const ops = readFileSync(new URL('../dapp/farm-ops.js', import.meta.url), 'utf8');
const cut = (text, a, b) => { const s = text.indexOf(a), e = text.indexOf(b, s + a.length); assert.ok(s >= 0 && e > s, `has ${a}`); return text.slice(s, e); };
const line = (text, a) => { const s = text.indexOf(a); assert.ok(s >= 0, `has ${a}`); return text.slice(s, text.indexOf('\n', s)); };

const E8 = 100000000n;
const lpAddShares = (S, a, b, rA, rB) => { const x = BigInt(S) * BigInt(a) / BigInt(rA), y = BigInt(S) * BigInt(b) / BigInt(rB); return x < y ? x : y; };
const bFor = (a, res) => (BigInt(a) * BigInt(res.reserveB) + BigInt(res.reserveA) - 1n) / BigInt(res.reserveA);

// the page's helpers over a private balance we control
function page(notes) {
  const P = { scan: { eth: { notes: notes.eth }, tac: { notes: notes.tac } } };
  const freeNotes = (ns) => (ns || []).filter((n) => !n.used), kNote = (n) => n.id;
  const spendable = (k) => freeNotes(P.scan[k].notes).reduce((s, n) => s + BigInt(n.value), 0n);
  const src = `${line(html, 'const noteExact = ')}\n${cut(html, 'const noteNear = ', 'function joinFresh(')}\n${cut(html, 'function joinPairPlan(', '\nfunction joinMax(')}`;
  const made = new Function('P', 'freeNotes', 'kNote', 'spendable', 'bFor', `${src}\nreturn { noteNear, noteFits, joinPairPlan };`)(P, freeNotes, kNote, spendable, bFor);
  return { P, ...made };
}
const note = (id, value) => ({ id, value: String(value) });
const t = { pool: { lpAddShares } };
const sd = { kA: 'eth', kB: 'tac' };
const FEE_ETH = 29185n, FEE_TAC = 2n * E8;
const terms = (res) => ({ res, feeA: FEE_ETH, feeB: FEE_TAC, gas: 0n });
// TAC per tETH about 3,000: 40 tETH against 120,000 TAC
const pool0 = { reserveA: 40n * E8, reserveB: 120000n * E8, totalShares: 1000n * E8 };
// a trade of `bp` basis points of the pool's TAC side (price of tETH in TAC moves the other way)
const moved = (res, bp) => ({ ...res, reserveB: res.reserveB - res.reserveB * BigInt(bp) / 10000n, reserveA: res.reserveA + res.reserveA * BigInt(bp) / 10000n });

const a = 2n * E8 / 100n;                 // the user adds 0.02 tETH
const b0 = bFor(a, pool0);                // and the TAC that goes with it: 60 TAC

test('with the pool unmoved, notes of the exact sizes cost no cut (as before)', () => {
  const w = page({ eth: [note('e1', a), note('e2', 3n * E8 / 100n)], tac: [note('t1', b0), note('t2', 50n * E8)] });
  const p = w.joinPairPlan(t, {}, terms(pool0), sd, a);
  assert.deepEqual([p.fA, p.fB], [0n, 0n]);
});

test('a TAC note cut for the old price is used after the pool moves a little, with no new cut', () => {
  const w = page({ eth: [note('e1', a)], tac: [note('t1', b0), note('t2', 50n * E8)] });
  for (const bp of [1, 3, 5, -5, -3]) {
    const res = moved(pool0, bp), need = bFor(a, res);
    assert.notEqual(need, b0, `the pool moved ${bp} bp, so the exact size changed`);
    const p = w.joinPairPlan(t, {}, terms(res), sd, a);
    assert.equal(p.fB, 0n, `no TAC cut is charged at ${bp} bp`);
    assert.equal(w.noteNear('tac', need, FEE_TAC)?.id, 't1');
  }
});

test('a move past 0.4% of the note, or past what a cut costs, still cuts', () => {
  const w = page({ eth: [note('e1', a)], tac: [note('t1', b0), note('t2', 50n * E8)] });
  const far = w.joinPairPlan(t, {}, terms(moved(pool0, 60)), sd, a);          // 0.6% off: a refusal by the bond is possible, so it is cut
  assert.equal(far.fB, FEE_TAC, 'the cut is charged');
  const dear = w.joinPairPlan(t, {}, terms(moved(pool0, 5)), sd, a);
  const cheap = w.joinPairPlan(t, {}, { ...terms(moved(pool0, 5)), feeB: 1n }, sd, a);
  assert.equal(dear.fB, 0n);
  assert.equal(cheap.fB, 1n, 'when a cut costs less than the sliver, the cut is what is cheaper');
});

test('a relay fee of 0 (an own prover, or a free cut) reuses exact notes only', () => {
  const w = page({ eth: [note('e1', a)], tac: [note('t1', b0 + 1n)] });
  assert.equal(w.noteNear('tac', b0, 0n), null);
  assert.equal(w.joinPairPlan(t, {}, { ...terms(pool0), feeB: 0n }, sd, a).fB, 0n, 'a free cut is charged nothing either way');
});

test('the tETH side stays exact: only the TAC note is taken near', () => {
  const w = page({ eth: [note('e1', a + 1n)], tac: [note('t1', b0)] });
  const p = w.joinPairPlan(t, {}, terms(pool0), sd, a);
  assert.equal(p.fA, FEE_ETH, 'a tETH note that is not the size typed is cut');
});

test('the nearest note is taken, a used one is not, and with none near an exact one is what fits', () => {
  const w = page({ eth: [], tac: [note('far', b0 + 20_000_000n), note('near', b0 + 3n), note('used', b0 + 1n)] });
  w.P.scan.tac.notes[2].used = true;
  assert.equal(w.noteNear('tac', b0, FEE_TAC)?.id, 'near');
  const fits = w.noteFits('tac', b0, FEE_TAC);
  assert.deepEqual(w.P.scan.tac.notes.filter(fits).map((n) => n.id), ['near'], 'one note fits, so noteFor takes it and not a larger');
  const bare = page({ eth: [], tac: [note('other', 7n * E8), note('exact', b0)] });
  bare.P.scan.tac.notes[1].value = String(b0);
  const f2 = bare.noteFits('tac', b0 + 50_000_000n, FEE_TAC);
  assert.deepEqual(bare.P.scan.tac.notes.filter(f2).map((n) => n.id), [], 'a note that is not near and not exact does not fit: a cut follows');
  const fresh = bare.noteFits('tac', 7n * E8, FEE_TAC);
  assert.deepEqual(bare.P.scan.tac.notes.filter(fresh).map((n) => n.id), ['other'], 'and the note a cut makes is found by its exact size');
});

test('every note noteNear takes passes the bond’s own ratio check, whichever way the pool moved', () => {
  const src = `${cut(ux, 'const LP_MAX_DONATION_BPS', '\n  async function quoteLpAdd')}`;
  const assertLpInRatio = new Function('pool', `${src}\nreturn assertLpInRatio;`)(t.pool);
  const w = page({ eth: [note('e1', a)], tac: [] });
  let taken = 0;
  for (let bp = -80; bp <= 80; bp++) {
    const res = moved(pool0, bp), need = bFor(a, res);
    for (let off = -60; off <= 60; off += 3) {                                  // a note off the exact size by -0.6% ... +0.6% of it
      const v = b0 + b0 * BigInt(off) / 10000n;
      w.P.scan.tac.notes = [note('t', v)];
      if (!w.noteNear('tac', need, FEE_TAC)) continue;
      taken++;
      assert.doesNotThrow(() => assertLpInRatio('lp-bond', { addA: a, addB: v, reserveA: res.reserveA, reserveB: res.reserveB, sharesPre: res.totalShares }), `moved ${bp} bp, note off by ${off} bp`);
    }
  }
  assert.ok(taken > 100, 'the sweep covered many accepted cases');
});

test('joinNow takes the TAC note by what fits it and carries the note’s own value on', () => {
  const now = cut(html, 'async function joinNow(', '\nconst LOCK = {');
  assert.match(now, /nB = await noteFor\(run, t, priv, b, noteFits\(kB, b, j\.feeB\), line\(\), kB\);\s*\n\s*b = BigInt\(nB\.value\);/);
  assert.match(now, /nA = await noteFor\(run, t, priv, a, \(n\) => BigInt\(n\.value\) === a, line\(\), kA\);/, 'the tETH side is still the exact size');
});
