// Trustless AMM pool-state replay.
//
// SPEC AMM.md: "Public reserves and supply are how the protocol stays purely
// indexer-validated — anyone can reconstruct exactly what every reserve is at
// every height by replaying confirmed envelopes." This is that reconstruction,
// moved into the client so the dapp never trusts the worker for pool state.
//
// `replayAmmPoolState` is a pure, deterministic state machine. Given the pool's
// ops in canonical (height, tx_index) order — each ALREADY decoded and verified
// on chain at confirmation depth >= 3 by the caller — it replays them to compute
// the authoritative { reserveA, reserveB, totalShares }. Crucially it does not
// just accumulate: every op that DECLARES a derived value (the LP_ADD share
// amount, the LP_REMOVE outputs, optionally a swap output) is RE-CHECKED against
// the formula recomputed from the replayed reserves. A mismatch means a forged
// or tampered op and the replay THROWS — so it can never advance to a wrong
// state. The worker therefore drops to discovery-only: it can stall the client
// (withhold an op → the next op fails its check → replay halts = liveness), but
// it can never make the client credit an inflated amount (soundness).
//
// The pool math is injected (`curveDeltaOut`, `lpAddShares`, `removeOutputs`,
// `MINIMUM_LIQUIDITY`) so the replay uses the SAME canonical functions the
// worker and the envelope builders use — parity by construction, not a second
// implementation that could drift.

// Floor integer sqrt (BigInt) — matches the POOL_INIT first-mint basis
// totalShares = isqrt(deltaA·deltaB) (the worker's n.isqrt()). Newton's method.
export function isqrtBig(n) {
  const v = BigInt(n);
  if (v < 0n) throw new Error('isqrt of negative');
  if (v < 2n) return v;
  let x = v, y = (x + 1n) >> 1n;
  while (y < x) { x = y; y = (x + v / x) >> 1n; }
  return x;
}

// ops: [{ kind, ... }] in canonical order. Op shapes (fields are the on-chain /
// envelope-declared values the caller decoded):
//   pool_init : { deltaA, deltaB, shareAmount? }   shareAmount = founder shares
//   lp_add    : { deltaA, deltaB, shareAmount? }
//   swap_var  : { direction, deltaIn, feeBps, expectDeltaOut? }
//   lp_remove : { sharesBurned, outA?, outB? }
//   swap_batch: requires Groth16 verification — not yet wired (throws).
export function replayAmmPoolState(ops, deps) {
  const { curveDeltaOut, lpAddShares, removeOutputs, MINIMUM_LIQUIDITY } = deps || {};
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('replay: no ops');
  if (typeof curveDeltaOut !== 'function' || typeof lpAddShares !== 'function' || typeof removeOutputs !== 'function') {
    throw new Error('replay: missing pool math (curveDeltaOut / lpAddShares / removeOutputs)');
  }
  const MIN_LIQ = BigInt(MINIMUM_LIQUIDITY);
  let reserveA = 0n, reserveB = 0n, totalShares = 0n, initialized = false;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op || typeof op.kind !== 'string') throw new Error(`replay[${i}]: malformed op`);

    if (op.kind === 'pool_init') {
      if (initialized) throw new Error(`replay[${i}]: pool_init after pool already initialized`);
      const da = BigInt(op.deltaA), db = BigInt(op.deltaB);
      if (da <= 0n || db <= 0n) throw new Error(`replay[${i}]: pool_init non-positive deltas`);
      const total = isqrtBig(da * db);
      // The locked MINIMUM_LIQUIDITY is part of totalShares; the founder gets the
      // remainder. total <= MIN_LIQ would mean a sub-floor seed — rejected (the
      // first-LP donation-inflation guard, mirrored from the builders/worker).
      if (total <= MIN_LIQ) throw new Error(`replay[${i}]: pool_init total ${total} <= MINIMUM_LIQUIDITY`);
      const founder = total - MIN_LIQ;
      if (op.shareAmount != null && BigInt(op.shareAmount) !== founder) {
        throw new Error(`replay[${i}]: pool_init founder-share mismatch (declared ${op.shareAmount}, formula ${founder})`);
      }
      reserveA = da; reserveB = db; totalShares = total; initialized = true;
      continue;
    }

    if (!initialized) throw new Error(`replay[${i}]: ${op.kind} before pool_init`);

    if (op.kind === 'lp_add') {
      const da = BigInt(op.deltaA), db = BigInt(op.deltaB);
      if (da <= 0n || db <= 0n) throw new Error(`replay[${i}]: lp_add non-positive deltas`);
      const shares = BigInt(lpAddShares(da, db, reserveA, reserveB, totalShares));
      if (shares <= 0n) throw new Error(`replay[${i}]: lp_add yields zero shares (dust add)`);
      if (op.shareAmount != null && BigInt(op.shareAmount) !== shares) {
        throw new Error(`replay[${i}]: lp_add share mismatch (declared ${op.shareAmount}, formula ${shares})`);
      }
      reserveA += da; reserveB += db; totalShares += shares;
      continue;
    }

    if (op.kind === 'swap_var') {
      const deltaIn = BigInt(op.deltaIn);
      if (deltaIn <= 0n) throw new Error(`replay[${i}]: swap non-positive deltaIn`);
      const dir = op.direction | 0;
      // curveDeltaOut returns { deltaOut, raPost, rbPost } — the canonical
      // post-reserves the worker/builder use, so the replay advances to exactly
      // that state (no second reserve-update arithmetic to drift).
      const r = curveDeltaOut(dir, reserveA, reserveB, deltaIn, op.feeBps | 0);
      const deltaOut = BigInt(r.deltaOut);
      if (deltaOut <= 0n) throw new Error(`replay[${i}]: swap yields zero out`);
      if (op.expectDeltaOut != null && BigInt(op.expectDeltaOut) !== deltaOut) {
        throw new Error(`replay[${i}]: swap out mismatch (declared ${op.expectDeltaOut}, curve ${deltaOut})`);
      }
      reserveA = BigInt(r.raPost);
      reserveB = BigInt(r.rbPost);
      continue;
    }

    if (op.kind === 'lp_remove') {
      const burned = BigInt(op.sharesBurned);
      // Cannot burn the locked MINIMUM_LIQUIDITY floor (no note holds it).
      if (burned <= 0n || burned > totalShares - MIN_LIQ) {
        throw new Error(`replay[${i}]: lp_remove invalid burn ${burned} (totalShares ${totalShares})`);
      }
      const { deltaA: outA, deltaB: outB } = removeOutputs(burned, reserveA, reserveB, totalShares);
      const oA = BigInt(outA), oB = BigInt(outB);
      if (op.outA != null && BigInt(op.outA) !== oA) throw new Error(`replay[${i}]: lp_remove outA mismatch (declared ${op.outA}, formula ${oA})`);
      if (op.outB != null && BigInt(op.outB) !== oB) throw new Error(`replay[${i}]: lp_remove outB mismatch (declared ${op.outB}, formula ${oB})`);
      reserveA -= oA; reserveB -= oB; totalShares -= burned;
      continue;
    }

    if (op.kind === 'swap_batch') {
      // SPEC §5.16 (drafted / not yet emitted). The batch hides per-trader
      // amounts and carries ONE Groth16. Trustless replay verifies that proof
      // against the replayed reserves_before (a public input) and advances to
      // reserves_after — see spec/design/TRUST-TIERS-AND-CONVERGENCE.md. Until
      // that proof verification is wired, refuse to advance (fail closed) rather
      // than trust an unverified net flow.
      throw new Error(`replay[${i}]: swap_batch requires Groth16 verification against reserves_before (not yet wired)`);
    }

    throw new Error(`replay[${i}]: unknown op kind '${op.kind}'`);
  }

  return { reserveA, reserveB, totalShares };
}
