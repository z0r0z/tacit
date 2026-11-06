// Bringing a market whose price has left its band back to the peg, as anyone may. A Precision pool takes only trades that end inside its band, and a deposit
// into a pool outside it only when the price does not move further out; burned down to its permanent minimum (1,000 shares) a pool can sit outside its band with
// one side all but empty, where no trade fits. The way back is the one the pool leaves open: a deposit small enough to keep the price where it is, which gives
// the empty side something to pay out, then a swap that lands the price at the peg. Both are dust. After them the market takes ordinary deposits and trades.
//
// The arithmetic below is the pool's own (zFi src/pools/PrecisionPool.sol: _virtual0/_virtual1, _ratio, _bandMiss, _priceInRange, _proportional, the deposit's
// band and liveness checks, _executable/_tradeable and _transitionAt), on a pool with no hook, so a plan made here is what the pool will do.
const WAD = 10n ** 18n, WAD2 = WAD * WAD, FEE_DENOM = 1_000_000n, BPS = 10_000n;
const divUp = (a, b) => (a + b - 1n) / b;

// `t`: the market ({ sqrtPLow, sqrtPHigh, fee, creatorFeeBps }); `s`: the pool now ({ supply, r0, r1 }).
export const v0 = (t, L) => L * WAD / t.sqrtPHigh;
export const v1 = (t, L) => L * t.sqrtPLow / WAD;
export const ratioOf = (x, y) => (x === 0n ? 0n : y * WAD2 / x);
const floorSq = (t) => t.sqrtPLow * t.sqrtPLow, ceilSq = (t) => (t.sqrtPHigh + 1n) * (t.sqrtPHigh + 1n);
export const inBand = (t, x, y) => { if (x === 0n) return false; const r = ratioOf(x, y); return r >= floorSq(t) && r < ceilSq(t); };
export function bandMiss(t, r) {
  if (r < floorSq(t)) return floorSq(t) - r;
  if (r >= ceilSq(t)) return r - ceilSq(t) + 1n;
  return 0n;
}
const aug = (t, s) => [v0(t, s.supply) + s.r0, v1(t, s.supply) + s.r1];

// The smallest trade either way, replayed as the pool does: whether any trade can go through now.
function executable(t, augIn, augOut, rOut, zeroForOne) {
  if (augOut <= 1n) return false;
  let need = divUp(augIn, augOut - 1n);
  if (need === 0n) need = 1n;
  const net = divUp(need * FEE_DENOM, FEE_DENOM - t.fee), priced = net * (FEE_DENOM - t.fee) / FEE_DENOM;
  if (priced === 0n) return false;
  const kept = net - (t.creatorFeeBps ? divUp((net - priced) * t.creatorFeeBps, BPS) : 0n);
  const out = priced * augOut / (augIn + priced);
  if (out === 0n || out > rOut) return false;
  return zeroForOne ? inBand(t, augIn + kept, augOut - out) : inBand(t, augOut - out, augIn + kept);
}
export function tradeable(t, s) {
  const [x, y] = aug(t, s);
  return (s.r1 !== 0n && executable(t, x, y, s.r1, true)) || (s.r0 !== 0n && executable(t, y, x, s.r0, false));
}

// A deposit of `lp` shares at the pool's own ratio, as the pool takes it: { used0, used1, after } or null when the pool would refuse it.
export function depositOf(t, s, lp) {
  if (!(s.supply > 0n) || !(lp > 0n)) return null;
  const used0 = s.r0 === 0n ? 0n : divUp(lp * s.r0, s.supply), used1 = s.r1 === 0n ? 0n : divUp(lp * s.r1, s.supply);
  const after = { supply: s.supply + lp, r0: s.r0 + used0, r1: s.r1 + used1 };
  const [x, y] = aug(t, after);
  if (!inBand(t, x, y)) {
    const pre = bandMiss(t, ratioOf(...aug(t, s)));
    if (pre === 0n || bandMiss(t, ratioOf(x, y)) > pre) return null;
  }
  if (tradeable(t, s) && !tradeable(t, after)) return null;
  return { lp, used0, used1, after };
}

// A swap of `amountIn` into the pool, as the pool prices it: { out, ok, ratio, after }. `ok` is whether the pool would take it (something comes out, and the
// price ends inside the band).
export function swapOf(t, s, zeroForOne, amountIn) {
  const [x, y] = aug(t, s), [rIn, rOut, augIn, augOut] = zeroForOne ? [s.r0, s.r1, x, y] : [s.r1, s.r0, y, x];
  const fee = amountIn - amountIn * (FEE_DENOM - t.fee) / FEE_DENOM, priced = amountIn - fee;
  const kept = amountIn - (t.creatorFeeBps ? divUp(fee * t.creatorFeeBps, BPS) : 0n);
  const out = priced === 0n ? 0n : priced * augOut / (augIn + priced);
  const nIn = augIn + kept, nOut = augOut - (out > rOut ? rOut : out), [nx, ny] = zeroForOne ? [nIn, nOut] : [nOut, nIn];
  const ok = out > 0n && out <= rOut && inBand(t, nx, ny);
  const after = zeroForOne ? { supply: s.supply, r0: s.r0 + kept, r1: s.r1 - out } : { supply: s.supply, r0: s.r0 - out, r1: s.r1 + kept };
  return { out, ok, ratio: ratioOf(nx, ny), after };
}

// The price a pool settles at once ordinary deposits have grown it: both virtual reserves are floored functions of its shares, so a pool this small reads
// its price with one of them rounded away, and the deposits that follow (at its ratio, which keeps reserves and shares in step) bring that term back. As
// they grow it the price tends to this, the reserves' ratio with the unrounded virtual reserves, in the same units as `ratioOf`.
export const grownRatio = (t, s) => (s.supply * t.sqrtPLow * t.sqrtPHigh + s.r1 * WAD * t.sqrtPHigh) * WAD2 / (s.supply * WAD2 + s.r0 * WAD * t.sqrtPHigh);

// The swap that takes the pool from outside its band to the price `target` (a sqrt price, as the pool keeps it): the price it lands at must be inside the band,
// and among the amounts that do that, the one whose grown price (above) is nearest `target`, so that the deposits after it open the market at the peg.
// { zeroForOne, amountIn, out, ratio, grown, after } or null when no trade lands inside the band. Below the band the token1 side is short, so token1 goes in.
export function swapToPeg(t, s, target) {
  const want = target * target, zeroForOne = ratioOf(...aug(t, s)) >= ceilSq(t);
  // the first amount at which `f` (rising with the amount when token1 goes in, falling when token0 does) has reached `v`
  const reach = (f, v) => {
    const past = (a) => (zeroForOne ? f(a) <= v : f(a) >= v);
    let lo = 0n, hi = 1n;
    while (!past(hi)) { hi *= 2n; if (hi > 1n << 200n) return null; }
    while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (past(mid)) hi = mid; else lo = mid; }
    return hi;
  };
  const now = (a) => swapOf(t, s, zeroForOne, a).ratio, grown = (a) => grownRatio(t, swapOf(t, s, zeroForOne, a).after);
  // the amounts that land inside the band: from where the price first enters it to just before it leaves
  const enter = reach(now, zeroForOne ? ceilSq(t) - 1n : floorSq(t)), leave = reach(now, zeroForOne ? floorSq(t) - 1n : ceilSq(t));
  const at = reach(grown, want);
  if (enter == null || at == null) return null;
  const last = leave == null ? at + 1n : leave - 1n, clamp = (a) => (a < enter ? enter : a > last ? last : a);
  const off = (q) => { const g = grownRatio(t, q.after); return g > want ? g - want : want - g; };
  const best = [...new Set([at - 1n, at, at + 1n, enter, last].map(clamp))].map((a) => ({ a, q: swapOf(t, s, zeroForOne, a) })).filter((c) => c.a > 0n && c.q.ok)
    .sort((p, q) => { const x = off(p.q), y = off(q.q); return x < y ? -1 : x > y ? 1 : 0; })[0];
  return best ? { zeroForOne, amountIn: best.a, out: best.q.out, ratio: best.q.ratio, grown: grownRatio(t, best.q.after), after: best.q.after } : null;
}

// The plan for a pool outside its band: a swap alone when one lands it inside, else a deposit (a whole multiple of the shares there are, so it holds the
// pool's ratio exactly) that the pool takes and after which the swap does, within `cap0` and `cap1` of each token. A pool this small holds its emptied side
// in a few dozen raw units, so the grown price moves in steps of a few percent with the swap; deposits of other sizes put those steps elsewhere, and the
// one whose swap lands nearest the peg is taken (the search stops once one is within a thousandth of it). Null when there is nothing to do (the pool is inside
// its band) or nothing within the caps works.
export const K_MAX = 4096n;
export function planReopen(t, s, target, { cap0 = 0n, cap1 = 0n } = {}) {
  if (!(s.supply > 0n) || inBand(t, ...aug(t, s))) return null;
  const direct = swapToPeg(t, s, target);
  if (direct) return { deposit: null, swap: direct };
  const want = target * target, off = (p) => (p.swap.grown > want ? p.swap.grown - want : want - p.swap.grown);
  let best = null;
  for (let k = K_MAX; k >= 1n; k--) {
    const d = depositOf(t, s, k * s.supply);
    if (!d || d.used0 > cap0 || d.used1 > cap1) continue;
    const sw = swapToPeg(t, d.after, target);
    if (!sw) continue;
    const p = { deposit: d, swap: sw };
    if (!best || off(p) < off(best)) best = p;
    if (off(best) * 1000n <= want) break;
  }
  return best;
}
