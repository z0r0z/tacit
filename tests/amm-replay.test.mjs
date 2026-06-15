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
import { replayAmmPoolState, replayOpFromDecoded, isqrtBig } from '../dapp/amm-replay.js';

// Opcode constants (dapp/tacit.js).
const OPCODES = { T_LP_ADD: 0x2D, T_LP_REMOVE: 0x2E, T_PROTOCOL_FEE_CLAIM: 0x31, T_SWAP_VAR: 0x32 };

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
  { kind: 'pool_init', deltaA: initA, deltaB: initB, shareAmount: initFounder, feeBps: swapFee },
  { kind: 'lp_add', deltaA: addA, deltaB: addB, shareAmount: addShares },
  // minOut 0 → executes (re-priced output >= floor 1).
  { kind: 'swap_var', direction: 0, deltaIn: swapIn, minOut: 0n },
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

// 6. §5.20 pass-through: a swap whose re-priced output is below min_out leaves
//    the pool state UNCHANGED (the trader is refunded). The replay must model
//    this, not unconditionally execute.
{
  const passthrough = { kind: 'swap_var', direction: 0, deltaIn: 100n, minOut: 1_000_000_000n };
  const st = replayAmmPoolState([SEQ[0], SEQ[1], passthrough], DEPS);
  ok('pass-through swap leaves reserveA unchanged', st.reserveA === rA1);
  ok('pass-through swap leaves reserveB unchanged', st.reserveB === rB1);
  ok('pass-through swap leaves totalShares unchanged', st.totalShares === S1);
}

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

console.log('\nPhase 2 — envelope → op adapter (decoded → replay op):');
{
  // Synthetic decoded envelopes mirroring decodeLpAdd / decodeTSwapVarPayload /
  // decodeLpRemove / decodeProtocolFeeClaim field names.
  const initDec = { variant: 1, deltaA: initA, deltaB: initB, shareAmount: initFounder, feeBps: swapFee };
  const addDec = { variant: 0, deltaA: addA, deltaB: addB, shareAmount: addShares };
  const swapDec = { direction: 0, deltaIn: swapIn, minOut: 0n, R_A_pre: 999n, deltaOut: 777n }; // advisory fields present + ignored
  const remDec = { shareAmount: burn, deltaA: remA, deltaB: remB };
  const feeDec = { claimAmount: 123n };

  const op0 = replayOpFromDecoded(OPCODES.T_LP_ADD, initDec, OPCODES);
  ok('LP_ADD variant 1 → pool_init (carries fee)', op0.kind === 'pool_init' && op0.feeBps === swapFee && op0.deltaA === initA);
  const op1 = replayOpFromDecoded(OPCODES.T_LP_ADD, addDec, OPCODES);
  ok('LP_ADD variant 0 → lp_add', op1.kind === 'lp_add' && op1.shareAmount === addShares);
  const op2 = replayOpFromDecoded(OPCODES.T_SWAP_VAR, swapDec, OPCODES);
  ok('SWAP_VAR → swap_var (direction/deltaIn/minOut, advisory dropped)', op2.kind === 'swap_var' && op2.direction === 0 && op2.deltaIn === swapIn && op2.minOut === 0n && op2.R_A_pre === undefined);
  const op3 = replayOpFromDecoded(OPCODES.T_LP_REMOVE, remDec, OPCODES);
  ok('LP_REMOVE → lp_remove (shareAmount→sharesBurned, deltaA/B→outA/B)', op3.kind === 'lp_remove' && op3.sharesBurned === burn && op3.outA === remA && op3.outB === remB);
  const op4 = replayOpFromDecoded(OPCODES.T_PROTOCOL_FEE_CLAIM, feeDec, OPCODES);
  ok('PROTOCOL_FEE_CLAIM → fee_claim', op4.kind === 'fee_claim' && op4.claimAmount === 123n);
  ok('non-pool opcode → null', replayOpFromDecoded(0x21, {}, OPCODES) === null);

  // End-to-end: decoded → adapter → replay reproduces the same state as feeding
  // the op shapes directly (SEQ). This is the Phase-2 → Phase-1 seam.
  const adapted = [
    replayOpFromDecoded(OPCODES.T_LP_ADD, initDec, OPCODES),
    replayOpFromDecoded(OPCODES.T_LP_ADD, addDec, OPCODES),
    replayOpFromDecoded(OPCODES.T_SWAP_VAR, swapDec, OPCODES),
    replayOpFromDecoded(OPCODES.T_LP_REMOVE, remDec, OPCODES),
  ];
  const viaAdapter = replayAmmPoolState(adapted, DEPS);
  const viaDirect = replayAmmPoolState(SEQ, DEPS);
  ok('adapter→replay reproduces direct-op replay', viaAdapter.reserveA === viaDirect.reserveA && viaAdapter.reserveB === viaDirect.reserveB && viaAdapter.totalShares === viaDirect.totalShares);

  // fee_claim through the replay fails closed (crystallization not yet wired).
  throws('fee_claim op → reject (fail closed)', () =>
    replayAmmPoolState([SEQ[0], op4], DEPS), /fee_claim replay not yet wired/);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
