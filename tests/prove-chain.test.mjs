// node tests/prove-chain.test.mjs -- the prove page's day figures: an address's work across the proof pool and the board, and how long a proof takes
import { dayTotals, proofSpan, cleanMiner, payPoints } from '../dapp/prove/chain.js';
let fails = 0; const check = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };

const A = '0x66f5A1225e6ac772c461f2b4d8028bf9568f3db5', B = '0x9194efdf03174a804f3552f4f7b7a4bb74badb7f', a = A.toLowerCase();

// --- an address's day: the pool's tally and the board's together, each kept apart too
{
  const pool = [{ miner: A, proofs: 78, points: 1520 }, { miner: B, proofs: 4, points: 80 }].map(cleanMiner);
  const board = [{ miner: A, proofs: 91, points: 2620 }].map(cleanMiner);
  const d = dayTotals(pool, board);
  check('both tallies are added for an address that has work in each', d.get(a).proofs === 169 && d.get(a).points === 4140);
  check('and each part is kept', d.get(a).pool.proofs === 78 && d.get(a).pool.points === 1520 && d.get(a).board.proofs === 91 && d.get(a).board.points === 2620);
  check('an address with pool work only has an empty board part', d.get(B).proofs === 4 && d.get(B).board.proofs === 0 && d.get(B).board.points === 0);
  check('addresses are looked up in lower case', d.has(a) && !d.has(A));
  check('one address written two ways is one row', (() => { const m = dayTotals([{ miner: A, proofs: 1, points: 20 }], [{ miner: a, proofs: 1, points: 100 }]); return m.size === 1 && m.get(a).proofs === 2 && m.get(a).points === 120; })());
  check('an address with board work only is there too', dayTotals([], board).get(a).proofs === 91 && dayTotals([], board).get(a).pool.proofs === 0);
  check('nothing read is an empty day, and rows without an address are passed over', dayTotals().size === 0 && dayTotals(null, undefined).size === 0 && dayTotals([null, {}], [{ proofs: 3 }]).size === 0);
}

// --- how long a proof takes: a range from the quicker quarter to the slow tenth, since GPUs and laptops both prove
{
  const live = [4, 4, 4, 8, 8, 8, 8, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 83, 83, 129, 129, 129, 129, 172, 172, 172];
  check('a feed of GPUs and laptops reads as a range, not the middle figure', proofSpan(live) === '9 s to 3 min');
  check('a range that rounds to one figure is said once', proofSpan([540, 545, 560]) === '9 min');
  check('one proof is its own figure', proofSpan([31]) === '31 s');
  check('nothing to go on is nothing', proofSpan([]) === null && proofSpan([0, -1]) === null);
  check('zero and negative times are not proofs', proofSpan([0, 0, 0, 120]) === '2 min');
}

console.log(fails ? `prove chain: ${fails} failed` : 'prove chain: all tests passed');

// --- what a pool proof earns for the time it took, from the pool's own terms (the same sum the pool does: payFor in worker/src/proof-pool.js)
{
  const pay = { fullSecs: 60, floorSecs: 600, floorPct: 50 };
  check('a quick proof earns the most', payPoints(20, 8, pay) === 20 && payPoints(20, 60, pay) === 20);
  check('a slower one earns less, in a line down to half at ten minutes', payPoints(20, 330, pay) === 15 && payPoints(20, 480, pay) === 12 && payPoints(20, 600, pay) === 10);
  check('and half beyond: a laptop still earns', payPoints(20, 900, pay) === 10 && payPoints(20, 86_400, pay) === 10);
  check('with no time known it is the most', payPoints(20, null, pay) === 20 && payPoints(20, undefined, pay) === 20);
  check('an older pool that sends no terms pays the most', payPoints(20, 900, undefined) === 20 && payPoints(20, 900, { fullSecs: null, floorSecs: null, floorPct: null }) === 20);
  check('a floor of 100 pays every proof the same', payPoints(20, 900, { ...pay, floorPct: 100 }) === 20);
  check('nothing is paid when no points are', payPoints(0, 900, pay) === null && payPoints(null, 900, pay) === null);
}
process.exit(fails ? 1 : 0);
