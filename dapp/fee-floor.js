// The lowest fee rate the network is taking, and a priority rate that may be under 1 sat/vB, for pages that do not load tacit.js (getFeeRate there holds the same rules).
//
// mempool.space's recommended fees never say less than 1 sat/vB, and 1 sat/vB was the min-relay fee of the day. On 2026-11-16 every block took transactions at 0.12 sat/vB while
// the recommended fee said 1, so a quote built on it was several times what the same transaction costs. The floor follows the blocks instead, and a lower fractional estimate
// from Bitcoin Core is used only when the recommended fee is at its floor.
export const NET_MIN_FLOOR = 0.2;

// blocks: mempool.space /v1/blocks. Twice the worst "lowest rate included" of the last six blocks, never above 1 and never under NET_MIN_FLOOR; unreadable ⇒ 1, as it always was.
export function floorFromBlocks(blocks) {
  const lows = (Array.isArray(blocks) ? blocks : []).slice(0, 6).map((x) => Number(x?.extras?.feeRange?.[0]));
  if (lows.length !== 6 || !lows.every((n) => Number.isFinite(n) && n > 0)) return 1;
  return Math.min(1, Math.max(NET_MIN_FLOOR, Math.round(Math.max(...lows) * 2 * 1000) / 1000));
}

// recommended: mempool.space /v1/fees/recommended; estimates: esplora /fee-estimates ('1' is the next block). The recommended fastestFee stands as it is read today, unless it is at
// its floor of 1 and Core's next-block estimate is lower: then that, never under `floor`. null when there is no recommended fee to start from.
export function priorityRate({ recommended, estimates, floor = 1 } = {}) {
  const fast = Number(recommended?.fastestFee);
  if (!(fast > 0)) return null;
  const frac = Number(estimates?.['1'] ?? estimates?.['2']);
  const rate = fast <= 1 && frac > 0 && frac < fast ? frac : fast;
  return Math.max(floor, Math.round(rate * 1000) / 1000);
}
