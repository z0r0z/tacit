// The flat part of a pair provider's fee, optionally following what a swap costs the provider (README "A flat fee that follows costs").
//
// Off (the default), each direction keeps its configured flat fee, as before. On, each is a share (`subsidy`, 0 to 1: 1 recovers the whole cost) of the
// provider's current estimate of its network cost per swap, in that direction's units:
//   forward (sats):               takeVb x feerate  +  the relay's fee for the pool note, valued in sats at the current rate
//   reverse (pool units, 1e-8 ETH): lockVb x feerate valued in pool units at the current rate  +  the relay's fee for the pool claim
// The estimate is smoothed (an exponential average of the readings), the figure shown moves only when it is 10% off the one in use, and it is clamped to
// [min, max]; max is also never over `capBps` of the direction's smallest amount (150 = 1.5%) and never leaves the smallest swap past `guardBps` (250) of fee
// with the rate part, so the pages' 3% guard against a quote under the market is not met by a minimum swap. A reading that cannot be had (no fee estimate,
// no price) leaves the figure where it was for `staleSecs`, then falls back to the configured fee. A quote already given is sealed with its amounts
// (dapp/fastbridge-provider.js), so a move here never changes one.
//
// Pure: `read()` is given by the daemon and returns { feeRate (sat/vB), relayEth (pool units), rate: { num, den } (pool units per sat) } or null.

import { satsToEth, ethToSats } from './stats.mjs';

export const TAKE_VB = 160;       // a claim of a Taproot lock of plain sats: one input, one output
export const LOCK_VB = 160;       // the reverse side's lock: a coin of its own in, the lock and the change out
const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };
const clampN = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// the ceiling of a direction's flat part: its explicit max, the cap on its smallest amount, and the guard less the rate part
export function flatCeiling({ minAmount, feeBps, max = null, capBps = 150, guardBps = 250 }) {
  const m = big(minAmount);
  let c = (m * BigInt(capBps)) / 10000n;
  const g = (m * BigInt(Math.max(0, guardBps - Number(feeBps || 0)))) / 10000n;
  if (g < c) c = g;
  if (max != null && big(max) < c) c = big(max);
  return c;
}

export function makeFlatFee({ dynamic = false, subsidy = 0.5, subsidyUntil = null, fwd, rev = null, read, now = () => Math.floor(Date.now() / 1000), alpha = 0.3, hysteresis = 0.1, staleSecs = 1800, takeVb = TAKE_VB, lockVb = LOCK_VB, capBps = 150, guardBps = 250 }) {
  // fwd / rev: { flat (the configured one), min, max, minAmount, feeBps }
  const side = (t) => (t ? { ...t, flat: big(t.flat), hi: flatCeiling({ minAmount: t.minAmount, feeBps: t.feeBps, max: t.max, capBps, guardBps }), cur: null, avg: null } : null);
  const S = { fwd: side(fwd), rev: side(rev) };
  for (const s of [S.fwd, S.rev]) if (s) s.lo = big(s.min ?? 0) < s.hi ? big(s.min ?? 0) : s.hi;      // (a floor never passes the ceiling)
  let last = null, at = -Infinity, cost = { sats: null, eth: null };
  const share = () => (subsidyUntil != null && now() >= Number(subsidyUntil) ? 1 : Math.min(1, Math.max(0, Number(subsidy))));

  function move(s, costNow) {
    s.avg = s.avg == null ? costNow : s.avg + alpha * (costNow - s.avg);
    const want = clampN(BigInt(Math.round(s.avg * share())), s.lo, s.hi);
    if (s.cur == null) { s.cur = want; return; }
    const diff = want > s.cur ? want - s.cur : s.cur - want;
    // hysteresis: moves only when 10% off the figure in use, or when the clamp or the subsidy says so (the want is at an edge)
    if (Number(diff) > hysteresis * Number(s.cur) || want === s.lo || want === s.hi) s.cur = want;
  }

  // one reading: call every few tens of seconds. A reading that is not whole leaves things as they are.
  function update() {
    if (!dynamic) return false;
    let r = null;
    try { r = read(); } catch { r = null; }
    if (!r || !(Number(r.feeRate) > 0) || !r.rate || !(big(r.rate.num) > 0n) || !(big(r.rate.den) > 0n) || r.relayEth == null) return false;
    const relay = big(r.relayEth), rate = { num: big(r.rate.num), den: big(r.rate.den) };
    const costSats = Number(takeVb) * Number(r.feeRate) + Number(ethToSats(relay, rate));
    const costEth = Number(satsToEth(BigInt(Math.ceil(Number(lockVb) * Number(r.feeRate))), rate)) + Number(relay);
    if (!Number.isFinite(costSats) || !Number.isFinite(costEth)) return false;
    cost = { sats: Math.round(costSats), eth: Math.round(costEth) };
    if (S.fwd) move(S.fwd, costSats);
    if (S.rev) move(S.rev, costEth);
    last = r; at = now();
    return true;
  }

  const fresh = () => dynamic && last != null && now() - at <= staleSecs;
  const flatOf = (s) => (s ? (fresh() && s.cur != null ? s.cur : s.flat) : 0n);
  const view = () => ({
    dynamic: !!dynamic, live: fresh(), subsidy: share(), ...(subsidyUntil != null ? { subsidyUntil: Number(subsidyUntil) } : {}),
    costSats: cost.sats, costEthUnits: cost.eth, feeRate: last ? Number(last.feeRate) : null, readAt: last ? at : null,
    flatFeeSats: String(flatOf(S.fwd)), ...(S.rev ? { reverseFlatFeeUnits: String(flatOf(S.rev)) } : {}),
    limits: { fwd: S.fwd ? [String(S.fwd.lo), String(S.fwd.hi)] : null, rev: S.rev ? [String(S.rev.lo), String(S.rev.hi)] : null },
  });
  return { update, fwd: () => flatOf(S.fwd), rev: () => flatOf(S.rev), view };
}
