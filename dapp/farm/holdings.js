// What a farm position holds, for the row that names it: its share of the pool and the two coins that share is worth at the pool's reserves as they stand.
// A position is a count of the pool's liquidity shares; the pool holds `totalShares` of them against `reserveA` and `reserveB` (each in the pool's own unit, a hundred-millionth
// of the coin), so the position's part of each reserve is its shares' part of the total. Pure: no reads, no page.

// → { a, b, pct } (a and b in the pool's units, pct in percent), or null when the position or the pool cannot be read as numbers.
export function holdingOf({ shares, reserves } = {}) {
  try {
    // the pool reads of the farm pages name the pool's liquidity shares `lpTotalShares` (the farm's own bonded count is another figure), the pool contract's own read `totalShares`
    const sh = BigInt(shares), tot = BigInt(reserves.lpTotalShares ?? reserves.totalShares), ra = BigInt(reserves.reserveA), rb = BigInt(reserves.reserveB);
    if (!(sh > 0n) || !(tot > 0n) || ra < 0n || rb < 0n) return null;
    const own = sh > tot ? tot : sh;                       // a read of the pool from before the position's own shares were counted never says more than all of it
    return { a: (ra * own) / tot, b: (rb * own) / tot, pct: Number((own * 1_000_000n) / tot) / 10_000 };
  } catch { return null; }
}

// 17.2% · 0.07% · under 0.01%
export const pctText = (pct) => (!(pct > 0) ? '0%' : pct < 0.01 ? 'under 0.01%' : `${pct.toLocaleString('en-US', { maximumFractionDigits: pct < 1 ? 2 : 1 })}%`);

// An amount in the pool's unit (a hundred-millionth of the coin), as a person reads it: 0.5038 · 448.4 · under 0.0001
export const unitsText = (units) => {
  const v = Number(units) / 1e8;
  return v <= 0 ? '0' : v < 0.0001 ? 'under 0.0001' : v.toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 4 : v < 1000 ? 3 : 1 });
};
