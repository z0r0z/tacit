
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const b32 = (h) => String(h).toLowerCase().replace(/^0x/, '').padStart(64, '0');
const bytes = (h) => { const s = String(h).replace(/^0x/, ''); return word(s.length / 2) + s.padEnd(Math.ceil(s.length / 64) * 64, '0'); };
const ceil = (x, y) => (x + y - 1n) / y;
function isqrt(n) { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }

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

export function zapPlanFor({ shares, ra, rb, total, feeBps = 30n, unitA = 10n ** 10n, unitB = 10n ** 10n, maxEth = null }) {
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
