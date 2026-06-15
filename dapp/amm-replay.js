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
// envelope-declared values the caller decoded — see replayOpFromDecoded):
//   pool_init : { deltaA, deltaB, shareAmount?, feeBps }  shareAmount = founder shares
//   lp_add    : { deltaA, deltaB, shareAmount? }
//   swap_var  : { direction, deltaIn, minOut }            re-priced at actual reserves
//   lp_remove : { sharesBurned, outA?, outB? }
//   fee_claim : { claimAmount }                           not yet wired (throws)
//   swap_batch: requires Groth16 verification — not yet wired (throws).
export function replayAmmPoolState(ops, deps) {
  const { curveDeltaOut, lpAddShares, removeOutputs, MINIMUM_LIQUIDITY } = deps || {};
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('replay: no ops');
  if (typeof curveDeltaOut !== 'function' || typeof lpAddShares !== 'function' || typeof removeOutputs !== 'function') {
    throw new Error('replay: missing pool math (curveDeltaOut / lpAddShares / removeOutputs)');
  }
  const MIN_LIQ = BigInt(MINIMUM_LIQUIDITY);
  let reserveA = 0n, reserveB = 0n, totalShares = 0n, initialized = false;
  // The fee is the POOL's, fixed at POOL_INIT — swaps don't carry it. Carrying
  // it here means a swap can't claim a different fee than its pool's.
  let poolFeeBps = 0;

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
      poolFeeBps = Number(op.feeBps || 0);
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
      // SPEC §5.20 outcome taxonomy: re-price the cleartext delta_in at the
      // ACTUAL (replayed) reserves and the pool's fee — the swap's own declared
      // R_A_pre/R_B_pre/delta_out are ADVISORY quote context, never trusted.
      // EXECUTE (advance reserves) iff delta_out_actual >= max(1, min_out);
      // otherwise PASS-THROUGH (reserves unchanged, the trader is refunded). The
      // outcome is a deterministic function of the replayed reserves, so the
      // client computes the same execute/pass the worker did — no per-swap
      // continuity check is possible (the receipt is the trader's hidden
      // commitment), but a divergent replay is caught at the next LP_ADD/REMOVE,
      // whose declared derived values ARE checked against the replayed reserves.
      const deltaIn = BigInt(op.deltaIn);
      if (deltaIn <= 0n) throw new Error(`replay[${i}]: swap non-positive deltaIn`);
      const dir = op.direction | 0;
      const r = curveDeltaOut(dir, reserveA, reserveB, deltaIn, poolFeeBps);
      const deltaOut = BigInt(r.deltaOut);
      const floor = (op.minOut != null && BigInt(op.minOut) > 1n) ? BigInt(op.minOut) : 1n;
      if (deltaOut < floor) {
        // PASS-THROUGH: pool state unchanged.
        continue;
      }
      // EXECUTE: advance to the canonical post-reserves.
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

    if (op.kind === 'fee_claim') {
      // T_PROTOCOL_FEE_CLAIM mints protocol-fee shares crystallized from k growth
      // since the last claim (a function of k_last + the pool's protocol_fee_bps,
      // via ammComputeProtocolShares). Trustless replay of it needs k + fee-bps
      // tracking through every prior op; not yet wired — fail closed rather than
      // trust the declared claim amount.
      throw new Error(`replay[${i}]: fee_claim replay not yet wired (protocol-fee crystallization)`);
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

// Phase 2 — envelope → replay-op adapter. Maps a DECODED AMM envelope (from
// decodeLpAdd / decodeTSwapVarPayload / decodeLpRemove / decodeProtocolFeeClaim)
// into the op shape replayAmmPoolState consumes. Pure: the caller decodes (and,
// in Phase 3, on-chain-verifies + canonically orders) the envelopes; this just
// renames fields. Opcode constants are passed in so this module stays free of
// the dapp's giant constant table. Returns null for a non-pool-op opcode.
export function replayOpFromDecoded(opcode, dec, opcodes) {
  if (!dec || !opcodes) return null;
  const { T_LP_ADD, T_SWAP_VAR, T_LP_REMOVE, T_PROTOCOL_FEE_CLAIM } = opcodes;

  if (opcode === T_LP_ADD) {
    // variant 1 = POOL_INIT (carries the pool fee tier), variant 0 = standard add.
    if (dec.variant === 1) {
      return { kind: 'pool_init', deltaA: dec.deltaA, deltaB: dec.deltaB, shareAmount: dec.shareAmount, feeBps: dec.feeBps || 0 };
    }
    if (dec.variant === 0) {
      return { kind: 'lp_add', deltaA: dec.deltaA, deltaB: dec.deltaB, shareAmount: dec.shareAmount };
    }
    return null;
  }
  if (opcode === T_SWAP_VAR) {
    return { kind: 'swap_var', direction: dec.direction, deltaIn: dec.deltaIn, minOut: dec.minOut };
  }
  if (opcode === T_LP_REMOVE) {
    // decodeLpRemove returns shareAmount (burned) + deltaA/deltaB (the payouts).
    return { kind: 'lp_remove', sharesBurned: dec.shareAmount, outA: dec.deltaA, outB: dec.deltaB };
  }
  if (opcode === T_PROTOCOL_FEE_CLAIM) {
    return { kind: 'fee_claim', claimAmount: dec.claimAmount };
  }
  return null;
}

// Phase 3 — derive a pool's trustless state from chain.
//
// deriveAmmPoolState reconstructs { reserveA, reserveB, totalShares } for a pool
// without trusting the worker for any value. All chain access + decoding is
// injected so this stays pure/testable; in production the dapp wires its own
// fetchTx + decoders. The worker is consulted ONLY for `discover` (the op-txid
// list) — discovery is liveness: every entry is re-fetched from chain, depth-
// gated, decoded, pool-bound, and value-verified by the replay, so a worker that
// lies about an op's values or injects a foreign op causes a THROW (halt), never
// an inflated credit. Withholding an op makes the next op fail its check or the
// list incomplete — also a halt. So: a malicious/incomplete worker = liveness
// failure; soundness is the client's.
//
// env = {
//   discover(poolIdHex) -> [{ txid, height, txIndex }]   (any order; re-sorted)
//   fetchTx(txid) -> tx { status:{confirmed,block_height}, vin:[{witness:[...]}] }
//   decodeEnvelope(witnessEntry) -> { opcode, payload } | null
//   decodeForOpcode(opcode, payload) -> decoded fields | null
//   poolIdForOp(opcode, decoded) -> poolIdHex   (binds an op to its pool)
//   opcodes, deps (replay math), tipHeight, confirmations? = 3
// }
export async function deriveAmmPoolState(poolIdHex, env) {
  const {
    discover, fetchTx, decodeEnvelope, decodeForOpcode, poolIdForOp,
    opcodes, deps, tipHeight, confirmations = 3,
  } = env || {};
  for (const [name, fn] of [['discover', discover], ['fetchTx', fetchTx], ['decodeEnvelope', decodeEnvelope], ['decodeForOpcode', decodeForOpcode], ['poolIdForOp', poolIdForOp]]) {
    if (typeof fn !== 'function') throw new Error(`deriveAmmPoolState: missing ${name}()`);
  }
  if (!Number.isInteger(tipHeight)) throw new Error('deriveAmmPoolState: integer tipHeight required (depth gate)');

  const list = await discover(poolIdHex);
  if (!Array.isArray(list)) throw new Error('deriveAmmPoolState: discover() did not return an array');
  // Canonical (height, tx_index) order — never trust the discovery's ordering.
  const sorted = [...list].sort((a, b) => (a.height - b.height) || (a.txIndex - b.txIndex));

  const ops = [];
  for (const item of sorted) {
    const txid = item && item.txid;
    if (typeof txid !== 'string') throw new Error('deriveAmmPoolState: op-list item missing txid');
    const tx = await fetchTx(txid);
    if (!tx) throw new Error(`deriveAmmPoolState: op ${txid} unfetchable (halt — set incomplete)`);
    if (!tx.status || tx.status.confirmed !== true) throw new Error(`deriveAmmPoolState: op ${txid} unconfirmed`);
    const h = Number(tx.status.block_height);
    if (!Number.isInteger(h)) throw new Error(`deriveAmmPoolState: op ${txid} has no block height`);
    // Reorg safety: only ops buried at depth >= confirmations count.
    if ((tipHeight - h + 1) < confirmations) {
      throw new Error(`deriveAmmPoolState: op ${txid} below confirmation depth ${confirmations}`);
    }
    const wit = tx.vin && tx.vin[0] && tx.vin[0].witness;
    if (!Array.isArray(wit) || wit.length < 3) throw new Error(`deriveAmmPoolState: op ${txid} carries no envelope`);
    const decodedEnv = decodeEnvelope(wit[1]);
    if (!decodedEnv || decodedEnv.opcode == null) throw new Error(`deriveAmmPoolState: op ${txid} envelope decode failed`);
    const dec = decodeForOpcode(decodedEnv.opcode, decodedEnv.payload);
    if (!dec) throw new Error(`deriveAmmPoolState: op ${txid} payload decode failed`);
    // Pool binding: the op must belong to THIS pool, so a worker can't slip a
    // foreign pool's (individually valid) op into the list and corrupt reserves.
    const opPool = poolIdForOp(decodedEnv.opcode, dec);
    if (opPool !== poolIdHex) throw new Error(`deriveAmmPoolState: op ${txid} is for pool ${opPool}, not ${poolIdHex}`);
    const replayOp = replayOpFromDecoded(decodedEnv.opcode, dec, opcodes);
    if (!replayOp) throw new Error(`deriveAmmPoolState: op ${txid} is not a pool op (opcode ${decodedEnv.opcode})`);
    ops.push(replayOp);
  }
  return replayAmmPoolState(ops, deps);
}
