// The eth-state stage against the pool's counts. The pool takes a Bitcoin batch only at its live cross-out and consume counts, which
// only grow, so a candidate behind them can never be folded, and a candidate made while the pool's latest counts are not final yet is
// behind on arrival.
import { pvCounts } from './attest-counts.js';

// The local record of the candidate this stage published; its counts ride along as decimal strings.
export function inflightRecord({ contentHash, publishedAt = null, ethPv }) {
  const c = pvCounts(ethPv);
  return { contentHash, publishedAt, ...(c ? { counts: { crossOuts: String(c.crossOuts), consumed: String(c.consumed) } } : {}) };
}

// -> { crossOuts, consumed }, or null for a record that carries none.
export function inflightCounts(rec) {
  try {
    return rec?.counts ? { crossOuts: BigInt(rec.counts.crossOuts), consumed: BigInt(rec.counts.consumed) } : null;
  } catch { return null; }
}

// A bounded wait for finality to cover the pool's latest counts: called each cycle with the reason the finalized head is behind (or
// null), -> true to wait. The bound runs from the first cycle that saw the head behind and starts over once the stage goes ahead, so a
// pool whose counts keep moving still gets a candidate every `boundMs`.
export function makeCoverWait({ boundMs, now = () => Date.now() }) {
  let since = null;
  return (uncovered) => {
    if (!uncovered) { since = null; return false; }
    const t = now();
    if (since == null) since = t;
    if (t - since < boundMs) return true;
    since = null;
    return false;
  };
}
