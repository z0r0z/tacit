
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const b32 = (h) => String(h).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const bytes = (h) => { const s = String(h).replace(/^0x/, ''); return word(s.length / 2) + s.padEnd(Math.ceil(s.length / 64) * 64, '0'); };
const ceil = (x, y) => (x + y - 1n) / y;
function isqrt(n) { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }

// The legs that found a tETH pool for a token at the rate an outside swap of `swapIn` wei quotes (amountOut, at least amountLimit after
// slippage): the token leg is what the swap surely brings, cut to whole pool units (`unitB`); the ETH leg matches it at the quoted rate. The
// founding add mints isqrt(vA·vB) shares and keeps 1000 of them locked, so the share note is for the rest. Reserves and shares fit a u64.
export function foundingPlan({ swapIn, amountOut, amountLimit, unitA = 10n ** 10n, unitB }) {
  swapIn = BigInt(swapIn); amountOut = BigInt(amountOut); amountLimit = BigInt(amountLimit); unitA = BigInt(unitA); unitB = BigInt(unitB);
  if (!(swapIn > 0n && amountOut > 0n && amountLimit > 0n && amountLimit <= amountOut && unitB > 0n)) return null;
  const bLeg = (amountLimit / unitB) * unitB, ethLeg = ((swapIn * bLeg) / amountOut / unitA) * unitA, vA = ethLeg / unitA, vB = bLeg / unitB, total = isqrt(vA * vB);
  if (total <= 1000n || vA >= 2n ** 64n || vB >= 2n ** 64n) return null;
  return { swapIn, ethLeg, bLeg, shares: total - 1000n, value: swapIn + ethLeg, total };
}

// Which way an ETH add buys the token's half: `inPool` (the swap half inside the pool: zapPlan) or `ext` (on the open market, the deposit then going in at the pool's own ratio:
// zapPlanExt). The market's plan is the one when the pool is thin: the swap inside it moves the pool's price by more than `maxImpact` (a pool left off the market is traded back by
// whoever sees it, at the liquidity providers' cost, however little the add saved), or when it gives more shares per ETH by more than its extra gas (`gasWei`, times `gasMult`).
// 'pool' when the market has no plan.
export function addRoute({ inPool, ext, wei, gasWei, maxImpact = 0.02, gasMult = 1.5 }) {
  if (!ext) return 'pool';
  if (!inPool) return 'ext';
  if (Number(inPool.impact) > maxImpact) return 'ext';
  const per = (p) => Number(p.shares) / Number(p.value);
  return (per(ext) - per(inPool)) / per(inPool) * Number(wei) > Number(gasWei) * gasMult ? 'ext' : 'pool';
}

export function ammOut(rIn, rOut, vIn, feeBps) {
  const g = vIn * (10000n - BigInt(feeBps));
  const out = (rOut * g) / (rIn * 10000n + g);
  return out > 0n && out < rOut ? out : 0n;
}

export function addShares(a, b, ra, rb, t) {
  const sA = (a * t) / ra, sB = (b * t) / rb, s = sA < sB ? sA : sB;
  return { s, sA, sB, takeA: s ? ceil(s * ra, t) : 0n, takeB: s ? ceil(s * rb, t) : 0n };
}

export function exactLegs(aMax, bMax, ra, rb, t) {
  const coarseA = ra < rb;
  const [cMax, fMax, rc, rf] = coarseA ? [aMax, bMax, ra, rb] : [bMax, aMax, rb, ra];
  const sCap = (fMax * t) / rf, cCap = ((sCap + 1n) * rc - 1n) / t;
  for (let i = 0n, top = cMax < cCap ? cMax : cCap; i < 4096n && top - i > 0n; i++) {
    const c = top - i, s = coarseA ? (c * t) / ra : (c * t) / rb;
    if (s <= 0n) return null;
    const f = coarseA ? ceil(s * rb, t) : ceil(s * ra, t);
    if (f > (coarseA ? bMax : aMax)) continue;
    const a = coarseA ? c : f, b = coarseA ? f : c;
    if ((a * t) / ra === s && (b * t) / rb === s) return { a, b, s };
  }
  return null;
}

export function zapPlan({ eth, ra, rb, total, feeBps = 30n, unitA = 10n ** 10n, unitB = 10n ** 10n }) {
  ra = BigInt(ra); rb = BigInt(rb); total = BigInt(total);
  const E = BigInt(eth) / BigInt(unitA), f = BigInt(feeBps);
  if (E < 2n || !(ra > 0n && rb > 0n && total > 0n)) return null;
  const g = 10000n - f, two = 20000n - f;
  const disc = ra * ra * two * two + 4n * g * E * ra * 10000n;
  let x0 = (isqrt(disc) - ra * two) / (2n * g);
  if (x0 < 1n) x0 = 1n;
  let best = null;
  const tryX = (x) => {
    if (x < 1n || x >= E) return;
    const out = ammOut(ra, rb, x, f);
    if (out < 2n) return;
    const ra2 = ra + x, rb2 = rb - out, legs = exactLegs(E - x, out - 1n, ra2, rb2, total);
    if (legs && (!best || legs.s > best.s || (legs.s === best.s && legs.a + x < best.a + best.x))) best = { x, out, ra2, rb2, ...legs };
  };
  for (let d = -48n; d <= 48n; d++) tryX(x0 + d);
  return best && planShape({ ra, rb, total, f, unitA, unitB }, best, eth);
}

function planShape({ ra, rb, total, f, unitA, unitB }, { x, out, a, b, s }, cap) {
  const uA = BigInt(unitA), uB = BigInt(unitB), value = (x + a) * uA, mid = (Number(rb) * Number(x) * Number(10000n - f)) / (Number(ra) * 10000);
  return {
    swapIn: x * uA, ethLeg: a * uA, bLeg: b * uB, floor: (b + 1n) * uB, value, shares: s,
    out: out * uB, spare: (out - b) * uB, left: cap == null ? 0n : BigInt(cap) - value,
    impact: mid > 0 ? Math.max(0, 1 - Number(out) / mid) : 0, reservesAfter: { ra: ra + x, rb: rb - out }, shareOfPool: Number(s) / Number(total + s),
  };
}

function legFit(S, t, r, up) {
  let v = up ? ceil(S * r, t) : (r * (S + 1n) - 1n) / t;
  for (let i = 0; i < 65536 && v > 0n; i++, v += up ? 1n : -1n) {
    const lo = (v * t) / (S + 1n) + 1n, hi = (v * t) / S, at = up ? (r > lo ? r : lo) : (r < hi ? r : hi);
    if (lo <= at && at <= hi) return at;
  }
  return null;
}

// The legs and the swap for exactly `shares` at these reserves. By default the legs are exact: each floors to `shares` and is the least that does,
// so a trade, add or remove landing first can only make the add mint fewer (never more), and with minShares set the transaction mints exactly
// `shares` or reverts. For a share count in the finer units of the pool (a deposit small beside it) such legs exist only at scattered swap sizes,
// often none within what a deposit can spare: `settles` is for a transaction that also settles the proof that names `shares` (zapETHIntoFarm),
// where a mint of any other count leaves no pending deposit for that proof to spend, so the settle and the whole transaction revert and
// nothing is stranded. If there are no exact legs it then falls back to the least legs that mint `shares`: see zapPlanSettling.
export function zapPlanFor({ shares, ra, rb, total, feeBps = 30n, unitA = 10n ** 10n, unitB = 10n ** 10n, maxEth = null, settles = false }) {
  const exact = zapPlanExact({ shares, ra, rb, total, feeBps, unitA, unitB, maxEth });
  return exact || !settles ? exact : zapPlanSettling({ shares, ra, rb, total, feeBps, unitA, unitB, maxEth });
}

// The least swap that brings the B leg (the least that mints `shares`, with a unit of the swap's output over it, which the router refunds and the
// deposit's recovery is found by) and the A leg (the least ETH that mints them: the pool takes exactly it) at the reserves the swap leaves. The pool
// mints the smaller of what the legs give, so the leg that floors to `shares` fixes the count; one always does on the side whose reserve is at least
// the pool's shares, and the other leg's surplus is refunded. The count is checked before a plan is returned, not assumed. Unlike the exact legs these
// carry no guarantee that a trade landing first mints no more than `shares` (a search over small pools and every trade size found none that did:
// the least swap leaves the B leg tight and the swap's own floor stops the trades that could), which is why they are for a settling send only.
function zapPlanSettling({ shares, ra, rb, total, feeBps = 30n, unitA = 10n ** 10n, unitB = 10n ** 10n, maxEth = null }) {
  ra = BigInt(ra); rb = BigInt(rb);
  const t = BigInt(total), S = BigInt(shares), f = BigInt(feeBps);
  if (S < 1n || !(ra > 0n && rb > 0n && t > 0n)) return null;
  const cap = maxEth == null ? null : BigInt(maxEth), uA = BigInt(unitA);
  const at = (x) => {
    const out = ammOut(ra, rb, x, f);
    if (!out) return null;
    const ra2 = ra + x, rb2 = rb - out, a = ceil(S * ra2, t), b = ceil(S * rb2, t);
    return { x, out, ra2, rb2, a, b, fits: out >= b + 1n };
  };
  // out rises and the B leg falls as the swap grows: the least swap that leaves a unit over is found by doubling, then halving
  let hi = 1n;
  for (let i = 0; i < 80 && !at(hi)?.fits; i++) hi *= 2n;
  if (!at(hi)?.fits) return null;
  let lo = hi / 2n;
  while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (at(mid)?.fits) hi = mid; else lo = mid; }
  for (let x = at(lo)?.fits ? lo : hi, i = 0; i < 4096; i++, x++) {
    const p = at(x);
    if (!p?.fits) continue;
    if (cap != null && (p.x + p.a) * uA > cap) return null;
    const sA = (p.a * t) / p.ra2, sB = (p.b * t) / p.rb2;
    if ((sA < sB ? sA : sB) === S) return planShape({ ra, rb, total: t, f, unitA, unitB }, { x: p.x, out: p.out, a: p.a, b: p.b, s: S }, maxEth);
  }
  return null;
}

function zapPlanExact({ shares, ra, rb, total, feeBps = 30n, unitA = 10n ** 10n, unitB = 10n ** 10n, maxEth = null }) {
  ra = BigInt(ra); rb = BigInt(rb);
  const t = BigInt(total), S = BigInt(shares), f = BigInt(feeBps), g = 10000n - f;
  if (S < 1n || !(ra > 0n && rb > 0n && t > 0n)) return null;
  const swapFor = (o) => (o < rb ? ceil(o * ra * 10000n, g * (rb - o)) : null);
  let x = swapFor(ceil(S * rb + t, t + S));
  for (let i = 0; i < 4096 && x !== null; i++) {
    if (x < 1n) x = 1n;
    const out = ammOut(ra, rb, x, f), ra2 = ra + x, rb2 = rb - out, a = ceil(S * ra2, t);
    if (!out || (maxEth != null && (x + a) * BigInt(unitA) > BigInt(maxEth))) return null;
    const r = legFit(S, t, ra2, true);
    if (r === null) return null;
    if (r > ra2) { x = r - ra; continue; }
    const y = legFit(S, t, rb2, false);
    if (y === null) return null;
    if (y < rb2) { x = swapFor(rb - y); continue; }
    return planShape({ ra, rb, total: t, f, unitA, unitB }, { x, out, a, b: ceil(S * rb2, t), s: S }, maxEth);
  }
  return null;
}

export function zapSplitPlan({ eth, ra, rb, total, feeBps = 30n, ammIn, extIn, extMin, unitA = 10n ** 10n, unitB = 10n ** 10n }) {
  ra = BigInt(ra); rb = BigInt(rb); total = BigInt(total); ammIn = BigInt(ammIn); extIn = BigInt(extIn); extMin = BigInt(extMin);
  const uA = BigInt(unitA), uB = BigInt(unitB), x = ammIn / uA, f = BigInt(feeBps), swapWei = ammIn + extIn;
  if (ammIn % uA !== 0n || x < 1n || extIn < 0n || extMin < 0n || swapWei >= BigInt(eth) || !(ra > 0n && rb > 0n && total > 0n)) return null;
  const out = ammOut(ra, rb, x, f), least = out + extMin / uB;
  if (!out || least < 2n) return null;
  const ra2 = ra + x, rb2 = rb - out, legs = exactLegs((BigInt(eth) - swapWei) / uA, least - 1n, ra2, rb2, total);
  if (!legs) return null;
  const mid = (Number(rb) * (Number(swapWei) / Number(uA)) * Number(10000n - f)) / (Number(ra) * 10000);
  return {
    swapIn: swapWei, ammIn, extIn, ethLeg: legs.a * uA, bLeg: legs.b * uB, floor: (legs.b + 1n) * uB, value: swapWei + legs.a * uA, shares: legs.s,
    out: out * uB + extMin, ammOut: out * uB, spare: out * uB + extMin - legs.b * uB, left: BigInt(eth) - swapWei - legs.a * uA,
    impact: mid > 0 ? Math.max(0, 1 - Number(least) / mid) : 0, reservesAfter: { ra: ra2, rb: rb2 }, shareOfPool: Number(legs.s) / Number(total + legs.s),
  };
}

// Entering a pool with the swap half bought OUTSIDE (a deep market) instead of inside the pool, so the pool's own price is not moved: the deposit then goes
// in at the pool's ratio. `quote(wei)` is the outside swap's answer, { amountLimit, callData } (what it surely brings, and the call that pays the router).
// The swap is sized so the token it surely brings and the ETH left make the pool's ratio; the legs are then the exact ones (see exactLegs), and the router
// refunds what the swap brings above the floor. Returns null when there is no quote, no exact legs, or the deposit is too small.
export async function zapPlanExt({ eth, ra, rb, total, unitA = 10n ** 10n, unitB = 10n ** 10n, quote }) {
  ra = BigInt(ra); rb = BigInt(rb); total = BigInt(total);
  const W = BigInt(eth), uA = BigInt(unitA), uB = BigInt(unitB), probe = (W / 2n / uA) * uA;
  if (probe < uA || !(ra > 0n && rb > 0n && total > 0n)) return null;
  const q0 = await quote(probe);
  if (!q0 || !(BigInt(q0.amountLimit) > 0n)) return null;
  const pn = rb * uB, pd = ra * uA;
  const X = (((W * pn * probe) / (pn * probe + BigInt(q0.amountLimit) * pd)) / uA) * uA;
  if (X < uA || X >= W) return null;
  const q = await quote(X);
  if (!q || !(BigInt(q.amountLimit) > 0n)) return null;
  const legs = exactLegs((W - X) / uA, BigInt(q.amountLimit) / uB, ra, rb, total);
  if (!legs) return null;
  const value = X + legs.a * uA;
  return { ext: true, swapIn: X, ethLeg: legs.a * uA, bLeg: legs.b * uB, shares: legs.s, value, left: W - value, out: BigInt(q.amountOut ?? q.amountLimit), floor: BigInt(q.amountLimit), callData: q.callData, q,
    impact: 0, shareOfPool: Number(legs.s) / Number(total + legs.s) };
}
// The same plan for exactly `shares` (the count a proof was made for) at the reserves now, with the outside swap asked for again: `quote(wei)` answers as it did for zapPlanExt.
// The proof fixes the share count, so the pool moving while it was made (a trade, someone else's add: the proof takes minutes) must not cost the proof. The least legs for that
// count are taken at the pool as it stands (the pool mints the smaller side, so the count is minted when the smaller side floors to it: the token side moves in whole units
// of the pool's shares, the ETH side jumps by a few, and only the smaller side has to land on it), and the swap is sized again to bring the token leg at its floor, the way it was
// first sized. Null when no such legs mint exactly that count, when the swap cannot bring the leg, or when it would cost more than `maxEth` (the pool moved too far).
export async function zapPlanExtFor({ shares, prev, quote = null, q = null, ra, rb, total, unitA = 10n ** 10n, unitB = 10n ** 10n, maxEth = null }) {
  ra = BigInt(ra); rb = BigInt(rb); total = BigInt(total);
  const S = BigInt(shares), uA = BigInt(unitA), uB = BigInt(unitB);
  const ask = quote || (q ? async () => q : null);
  if (S < 1n || !ask || !(ra > 0n && rb > 0n && total > 0n)) return null;
  const a = ceil(S * ra, total), b = ceil(S * rb, total), sA = (a * total) / ra, sB = (b * total) / rb;
  if ((sA < sB ? sA : sB) !== S) return null;
  const need = b * uB, up = (x) => ((x + uA - 1n) / uA) * uA;
  let X = BigInt(prev.swapIn), got = await ask(X);
  for (let i = 0; i < 4; i++) {
    const lim = got ? BigInt(got.amountLimit) : 0n;
    if (!(lim > 0n)) return null;
    if (lim >= need && lim - need <= need / 500n) break;                 // brings the leg, and no more than 0.2% over it
    const next = up((X * need * 10005n) / (lim * 10000n));               // the floor is near linear in what is spent: what brings the leg, a hair over for the rate's small move with size
    X = next === X ? X + uA : next;
    if (maxEth != null && X > BigInt(maxEth)) return null;
    got = await ask(X);
  }
  const lim = got ? BigInt(got.amountLimit) : 0n;
  const value = X + a * uA;
  if (lim < need || X < uA || (maxEth != null && value > BigInt(maxEth))) return null;
  return { ...prev, swapIn: X, ethLeg: a * uA, bLeg: b * uB, shares: S, value, left: prev.value + prev.left - value, floor: lim, out: BigInt(got.amountOut ?? lim), callData: got.callData, q: got };
}

export function zapCalldata({ plan, router, amm, tokenB, assetA, assetB, feeBps = 30, deadline, commit, swapData = null }) {
  return '0xf9d1fa01' + addr(tokenB) + word(feeBps) + word(plan.ethLeg) + word(plan.bLeg) + word(plan.shares) + word(deadline) + b32(commit) + word(8 * 32)
    + bytes(zapSwap({ plan, router, amm, tokenB, assetA, assetB, feeBps, deadline, swapData }));
}
function zapSwap({ plan, router, amm, tokenB, assetA, assetB, feeBps, deadline, swapData }) {
  if (swapData) return String(swapData).replace(/^0x/, '');
  const swap = 'cfdf9dcc' + b32(assetA) + b32(assetB) + word(feeBps) + word(plan.swapIn) + word(plan.floor) + word(deadline) + addr(router);
  return '5f3bd1c8' + addr('0x0') + word(0) + addr(router) + addr(tokenB) + word(plan.floor) + addr(amm) + word(7 * 32) + bytes(swap);
}
export function zapSettleCalldata({ plan, router, amm, tokenB, assetA, assetB, feeBps = 30, deadline, commit, swapData = null, publicValues, proof, memos = [] }) {
  const tails = [bytes(zapSwap({ plan, router, amm, tokenB, assetA, assetB, feeBps, deadline, swapData })), bytes(publicValues), bytes(proof), bytesArray(memos)];
  let off = 11 * 32;
  const heads = tails.map((t) => { const h = word(off); off += t.length / 2; return h; });
  return '0x' + ZAP_FARM_SEL + addr(tokenB) + word(feeBps) + word(plan.ethLeg) + word(plan.bLeg) + word(plan.shares) + word(deadline) + b32(commit) + heads.join('') + tails.join('');
}
export const ZAP_FARM_SEL = 'c4294fac';
const bytesArray = (xs) => {
  const items = xs.map((x) => bytes(x));
  let off = xs.length * 32;
  const heads = items.map((t) => { const h = word(off); off += t.length / 2; return h; });
  return word(xs.length) + heads.join('') + items.join('');
};

export function zapWorth({ ra, rb, total }, plan, unitA = 10n ** 10n, unitB = 10n ** 10n, backPrice = null) {
  ra = BigInt(ra); rb = BigInt(rb); total = BigInt(total);
  const uA = BigInt(unitA), uB = BigInt(unitB), x = (plan.ammIn ?? plan.swapIn) / uA, outU = (plan.ammOut ?? plan.out) / uB;
  const ra2 = ra + x, rb2 = rb - outU, S = plan.shares, takeA = (S * ra2 + total - 1n) / total, takeB = (S * rb2 + total - 1n) / total;
  const price = Number(ra) / Number(rb), pos = (Number(S) / Number(total + S)) * (Number(ra2 + takeA) + Number(rb2 + takeB) * price);
  const back = Number(plan.ethLeg / uA - takeA) + (Number(plan.paid ?? plan.out) / Number(uB) - Number(takeB)) * (backPrice ?? price);
  const sent = Number(plan.value) / Number(uA);
  return { worth: pos + back, sent, perSent: (pos + back) / sent, left: Number(plan.left) / Number(uA) };
}

export async function zapSplitSearch({ eth, ra, rb, total, feeBps = 30n, x0, quote, slipBps = 50n, maxBackBps = 100n, unitA = 10n ** 10n, unitB = 10n ** 10n }) {
  const st = { ra: BigInt(ra), rb: BigInt(rb), total: BigInt(total) }, uA = BigInt(unitA), uB = BigInt(unitB), E = Number(BigInt(eth)), slip = BigInt(slipBps);
  const planOf = (q) => {
    if (!q) return null;
    const extMin = (q.extOut * (10000n - slip)) / 10000n, p = zapSplitPlan({ eth, ...st, feeBps, ammIn: q.ammIn, extIn: q.extIn, extMin, unitA, unitB });
    if (!p) return null;
    const paid = p.ammOut + q.extOut;
    return { ...p, paid, q, backA: (Number(paid - p.bLeg - (q.extOut - extMin)) * Number(p.swapIn)) / Number(paid) };
  };
  const gap = (p) => (Number(p.left) > E / 10000 ? -Number(p.left) : p.backA);
  const at = (k) => (BigInt(x0) * BigInt(k)) / 1000n, tried = [];
  const ask = (X) => Promise.resolve().then(() => quote((X / uA) * uA)).then(planOf, () => null).then((p) => { if (p) tried.push(p); return p; });
  let [lo, hi] = await Promise.all([ask(at(1000)), ask(at(1150))]);
  if (lo && gap(lo) > 0) { const p = await ask(at(850)); if (p && gap(p) < 0) { hi = lo; lo = p; } }
  else if (hi && gap(hi) < 0) { const p = await ask(at(1350)); if (p && gap(p) > 0) { lo = hi; hi = p; } }
  for (let i = 0; i < 2 && lo && hi && gap(lo) < 0 && gap(hi) > 0; i++) {
    const X = lo.swapIn + ((hi.swapIn - lo.swapIn) * BigInt(Math.round((-gap(lo) / (gap(hi) - gap(lo))) * 1e6))) / 1000000n, p = await ask(X);
    if (!p || Math.abs(gap(p)) <= E * 0.002) break;
    if (gap(p) < 0) lo = p; else hi = p;
  }
  const fit = tried.filter((p) => Number(p.left) <= E * 0.005 && p.backA <= (E * Number(maxBackBps)) / 10000);
  if (!fit.length) return null;
  const scored = fit.map((p) => ({ plan: p, worth: zapWorth(st, p, unitA, unitB, Number(p.swapIn) / Number(uA) / (Number(p.paid) / Number(uB))) }));
  return scored.reduce((a, b) => (b.worth.perSent > a.worth.perSent ? b : a));
}

// What entering a pool by swapping half of a deposit costs. `d` is the swap's price move, a fraction on the half swapped; `ratio` is the pool's
// price for the other coin over the market's (above 1 where the pool prices it dear), or null when no market price is known.
//   impact  the larger of the swap's price move and what the deposit gives up against the market: the figure that says a pool is thin or
//           badly priced (a pool under 5% is calm)
//   loss    what the deposit gives up in all, as a share of the deposit: the swap moves the price on half of it, so d/2, or against the
//           market the whole shortfall of the half swapped (the price move included) over the deposit
export function zapEntry(d, ratio = null) {
  if (!(ratio > 0)) return { impact: d, loss: d / 2 };
  const shortfall = 0.5 * (1 - (1 - d) / ratio);
  return { impact: Math.max(d, shortfall), loss: Math.max(0, shortfall) };
}

// The pool a deposit goes in best: of the calm ones (`impact` under 5%) the one that pays most TAC over a week once its way in is paid (`loss`
// of the deposit `amt`, in ETH, or in TAC when the deposit is TAC), else the pool that gives up least of the deposit. Rows carry `apr`, `day`
// (TAC a day for this deposit), `impact` and `loss`; `tacEth` prices a loss in TAC. With no amount it is the best APR of the calm ones.
export function farmPick(rows, { amt = 0, tacEth = 0, tacSrc = false } = {}) {
  const net = (r) => (!amt ? r.apr : r.day * 7 - (tacSrc ? r.loss * amt : tacEth ? r.loss * amt / tacEth : 0));
  const best = (list, score) => list.reduce((a, r) => (!a || score(r) > score(a) ? r : a), null);
  return best(rows.filter((r) => r.impact < 0.05), net) || best(rows, (r) => -r.loss);
}
