// The pool takes an attest only while its accounting equals the pool's live counts: the consumes and the cross-outs the proof says it folded
// (ReflectionLib: r.consumedCount == bitcoinConsumedCount, and the cross-out count == crossOutCount, else ConsumedCountStale). A cross-out
// recorded on Ethereum after the batch's eth-state candidate was taken leaves the batch behind for good: its proof can never land. On
// 2026-11-05 the lane bought two proofs for batches carrying 11 cross-outs while the pool held 14, and sent the held one again every cycle.
// These read the counts a batch and a proof carry, so the lane can wait for a fresh candidate instead of buying, and drop a held proof the
// pool has moved past.

const word = (hex, i) => {
  const h = String(hex || '').replace(/^0x/, '');
  const w = h.slice(i * 64, i * 64 + 64);
  return w.length === 64 ? BigInt('0x' + w) : null;
};

// The counts a Mode-B batch will commit: its eth-state proof's public values, word 4 the cumulative cross-outs and word 10 the cumulative
// consumes (dapp/confidential-pool.js buildEthPv). Null for a forward batch, or a job that does not carry them.
export function jobCounts(job) {
  const pv = job?.input?.modeB?.ethPv;
  if (!pv) return null;
  const crossOuts = word(pv, 4), consumed = word(pv, 10);
  return crossOuts == null || consumed == null ? null : { crossOuts, consumed };
}

// The counts a bought Bitcoin proof commits (ReflectionLib BitcoinRelayPublicValues, ABI-encoded as one tuple: word 0 its offset, then the
// fields): consumedCount is field 13; the cross-out count the pool checks is crossOutCount (field 14) when the proof reflects this pool, else
// foldedCrossOutCount (field 15). Null when the bytes are too short to hold them.
export function proofCounts(publicValues, pool) {
  const f = (i) => word(publicValues, 1 + i);
  const ethPool = f(8), consumed = f(13), co = f(14), folded = f(15);
  if (ethPool == null || consumed == null || co == null || folded == null) return null;
  const self = pool != null && ethPool === BigInt(pool);
  return { crossOuts: self ? co : folded, consumed };
}

// Why `have` cannot land against the pool's `live` counts, or null when it can (or either is unknown).
export function countsBehind(have, live) {
  if (!have || !live) return null;
  if (have.crossOuts === live.crossOuts && have.consumed === live.consumed) return null;
  return `${have.crossOuts} cross-out(s)/${have.consumed} consumed against the pool's ${live.crossOuts}/${live.consumed}`;
}
