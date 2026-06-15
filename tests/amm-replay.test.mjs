// Trustless AMM pool-state replay (dapp/amm-replay.js). Verifies that a client
// can reconstruct {reserveA, reserveB, totalShares} from the pool's confirmed
// ops alone (SPEC AMM.md: "anyone can reconstruct exactly what every reserve is
// at every height by replaying confirmed envelopes"), and — the soundness
// property — that a forged/tampered op (a declared derived value that doesn't
// match the formula recomputed from the replayed reserves) is REJECTED, so a
// lying/omitting worker can only halt the client (liveness), never make it
// credit an inflated amount.
//
// The replay is fed the SAME canonical pool math the worker + builders use
// (imported here), so it's parity-by-construction, not a second implementation.
//
// Run: `node amm-replay.test.mjs`

import {
  ammCurveDeltaOut, ammLpAddShares, ammLpRemoveOutputs, AMM_MINIMUM_LIQUIDITY,
} from '../worker/src/index.js';
import { replayAmmPoolState, isqrtBig } from '../dapp/amm-replay.js';

const DEPS = {
  curveDeltaOut: ammCurveDeltaOut,
  lpAddShares: ammLpAddShares,
  removeOutputs: ammLpRemoveOutputs,
  MINIMUM_LIQUIDITY: AMM_MINIMUM_LIQUIDITY,
};

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; }
}
function throws(label, fn, match) {
  try { fn(); ok(label, false, 'did not throw'); }
  catch (e) { ok(label, !match || match.test(e.message), e.message); }
}

// Build a correct op sequence, declaring each derived value via the canonical math.
const initA = 2000n, initB = 2000n;
const initTotal = isqrtBig(initA * initB);            // 2000
const initFounder = initTotal - BigInt(AMM_MINIMUM_LIQUIDITY); // 1000

const addA = 1000n, addB = 1000n;
// reserves before the add are (2000, 2000), shares 2000.
const addShares = BigInt(ammLpAddShares(addA, addB, initA, initB, initTotal)); // 1000

// after add: reserves (3000, 3000), shares 3000.
const rA1 = initA + addA, rB1 = initB + addB, S1 = initTotal + addShares;
const swapIn = 300n, swapFee = 30;
const sw = ammCurveDeltaOut(0, rA1, rB1, swapIn, swapFee); // A->B
const swapOut = BigInt(sw.deltaOut);
// after swap: the canonical post-reserves the worker computes.
const rA2 = BigInt(sw.raPost), rB2 = BigInt(sw.rbPost);
const burn = 500n;
const { deltaA: remA, deltaB: remB } = ammLpRemoveOutputs(burn, rA2, rB2, S1);

const SEQ = [
  { kind: 'pool_init', deltaA: initA, deltaB: initB, shareAmount: initFounder },
  { kind: 'lp_add', deltaA: addA, deltaB: addB, shareAmount: addShares },
  { kind: 'swap_var', direction: 0, deltaIn: swapIn, feeBps: swapFee, expectDeltaOut: swapOut },
  { kind: 'lp_remove', sharesBurned: burn, outA: remA, outB: remB },
];

console.log('Trustless AMM pool-state replay:');

// 1. Correct sequence reconstructs the right state. The expected final reserves
//    are tracked independently above (rA2/rB2 after the swap, minus the
//    proportional remove), so this checks the replay's bookkeeping, not a
//    re-derivation by the same code.
{
  const st = replayAmmPoolState(SEQ, DEPS);
  ok('final reserveA after remove', st.reserveA === rA2 - remA);
  ok('final reserveB after remove', st.reserveB === rB2 - remB);
  ok('totalShares reduced by exactly the burned shares', st.totalShares === S1 - burn);
}

// 2. Constant-product non-decrease across the swap (fee keeps k growing).
{
  ok('swap preserves k (x·y non-decreasing with fee)', rA2 * rB2 >= rA1 * rB1);
  ok('swap credited reserveA by exactly deltaIn', rA2 - rA1 === swapIn);
}

// 3. Determinism — re-replay yields the identical state.
{
  const a = replayAmmPoolState(SEQ, DEPS);
  const b = replayAmmPoolState(SEQ, DEPS);
  ok('replay is deterministic', a.reserveA === b.reserveA && a.reserveB === b.reserveB && a.totalShares === b.totalShares);
}

console.log('\nSoundness — forged/tampered ops are rejected:');

// 4. A pool_init declaring inflated founder shares.
throws('pool_init with inflated founder shares → reject', () =>
  replayAmmPoolState([{ ...SEQ[0], shareAmount: initFounder + 1n }], DEPS), /founder-share mismatch/);

// 5. An LP_ADD claiming more shares than the formula yields.
throws('lp_add over-claiming shares → reject', () =>
  replayAmmPoolState([SEQ[0], { ...SEQ[1], shareAmount: addShares + 1n }], DEPS), /share mismatch/);

// 6. A swap whose declared output exceeds the curve (over-draining the pool).
throws('swap over-stating output → reject', () =>
  replayAmmPoolState([SEQ[0], SEQ[1], { ...SEQ[2], expectDeltaOut: swapOut + 1n }], DEPS), /out mismatch/);

// 7. An LP_REMOVE claiming a larger payout than proportional.
throws('lp_remove over-stating outA → reject', () =>
  replayAmmPoolState([SEQ[0], SEQ[1], SEQ[2], { ...SEQ[3], outA: remA + 1n }], DEPS), /outA mismatch/);

// 8. swap_batch must be proof-verified, not replayed by deltas (fail closed).
throws('swap_batch without Groth16 → reject (fail closed)', () =>
  replayAmmPoolState([SEQ[0], { kind: 'swap_batch' }], DEPS), /swap_batch requires Groth16/);

// 9. Structural guards.
throws('lp_add before pool_init → reject', () =>
  replayAmmPoolState([{ kind: 'lp_add', deltaA: 1n, deltaB: 1n }], DEPS), /before pool_init/);
throws('second pool_init → reject', () =>
  replayAmmPoolState([SEQ[0], { kind: 'pool_init', deltaA: 1n, deltaB: 1n }], DEPS), /already initialized/);
throws('sub-floor pool_init (total <= MINIMUM_LIQUIDITY) → reject', () =>
  replayAmmPoolState([{ kind: 'pool_init', deltaA: 10n, deltaB: 10n }], DEPS), /MINIMUM_LIQUIDITY/);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
