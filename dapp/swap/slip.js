// How far below its quote a swap through the Tacit pools may settle before it is stopped.
//
// A swap through the pools is proved on the exact reserves it was quoted on, and the pool takes it only on those reserves, so it settles at that quote or not at all: the least the holder takes
// (minOut) does not guard the settle. It bounds the swap built again when the pool moved while this one was proved, which pays what the pool pays then. A thin pool moves a lot under one other
// trade, so a fixed 1% allows one trade against the holder and then stops them, where a deep pool almost never moves that far. The room therefore grows with how thin the pool is for a swap of this
// size: its own price impact, net of the pool's fee. A swap that moves the price by x% has about 2x% of price left to move under it by another swap like it, so the room is 1% and twice the
// impact on top, never past 5% (a swap that moves a pool that far already asks the holder to confirm it).
export const POOL_SLIP_FLOOR_BPS = 100, POOL_SLIP_CEIL_BPS = 500, POOL_SLIP_PER_IMPACT = 2;

// `netImpact` is the swap's price impact without the pool's fee, as a fraction (0.01 is one percent). Whole basis points, between the floor and the ceiling.
export function poolSlipBps(netImpact) {
  const x = Number(netImpact);
  const extra = Number.isFinite(x) && x > 0 ? Math.round(x * 10000 * POOL_SLIP_PER_IMPACT) : 0;
  return Math.min(POOL_SLIP_CEIL_BPS, POOL_SLIP_FLOOR_BPS + extra);
}

// A price impact that includes the pools' fees (the card's), as a fraction, taken net of them: `pools` is the swap's hops, each with its `feeBps`.
export function netOfFees(impact, pools) {
  const fees = (Array.isArray(pools) ? pools : []).reduce((s, p) => s + Number(p?.feeBps ?? 30), 0) / 10000;
  return Math.max(0, Number(impact) - fees) || 0;
}

// The least a swap quoted at `out` takes, at `bps` below it (whole units, rounded down as the pool rounds).
export const floorOf = (out, bps) => (BigInt(out) * BigInt(10000 - Math.round(Number(bps)))) / 10000n;
