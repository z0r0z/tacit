// Sizing and venue choice for one TacBuyback buy (src/buyback-keeper.js). Pure, so it is tested without a chain.
//
// The contract enforces its own bounds whatever the keeper passes; this mirrors them so the keeper only ever
// sends a buy that will pass, and picks the venue that gives the most TAC per ETH at the size each allows.

export const VENUE_TACIT = 0;
export const VENUE_PRECISION = 1;

// Largest buy a venue allows right now: the contract's per-buy cap, the ETH it holds, and MAX_IMPACT_BPS of that
// venue's ETH reserve, rounded down to the pool unit (the contract rounds the same way).
export function maxBuyFor({ balance, maxPerBuy, unit, maxImpactBps, ethReserveWei }) {
  let amt = balance < maxPerBuy ? balance : maxPerBuy;
  const impactCap = (ethReserveWei * BigInt(maxImpactBps)) / 10000n;
  if (impactCap < amt) amt = impactCap;
  return amt - (amt % unit);
}

// quotes: [{ venue, amountIn, tacOut }] for venues that could be quoted. Returns the buy to send, or null.
// Best rate wins (TAC per ETH, compared exactly by cross-multiplying); a tie goes to the larger buy.
export function chooseBuy(quotes, { minBuyWei, slippageBps }) {
  const usable = quotes.filter((q) => q.amountIn >= minBuyWei && q.amountIn > 0n && q.tacOut > 0n);
  if (!usable.length) return null;
  usable.sort((a, b) => {
    const l = a.tacOut * b.amountIn, r = b.tacOut * a.amountIn;
    if (l !== r) return l > r ? -1 : 1;
    return a.amountIn > b.amountIn ? -1 : a.amountIn < b.amountIn ? 1 : 0;
  });
  const best = usable[0];
  const minTacOut = (best.tacOut * BigInt(10000 - slippageBps)) / 10000n;
  return minTacOut > 0n ? { ...best, minTacOut } : null;
}

export function cooldownLeft({ lastBuyAt, cooldown, now }) {
  const next = Number(lastBuyAt) + Number(cooldown);
  return next > now ? next - now : 0;
}

// ETH per TAC (1e18-scaled) a quote implies.
export const ethPerTac = (q) => (q.amountIn * 10n ** 18n) / q.tacOut;

// Whether the quotes are fit to buy on: the venues stand within `maxGapBps` of one another, and the dearest-to-buy rate is within
// `maxDevBps` of a reference price (ETH per TAC, 0 when none is readable, which skips that check).
export function quotesFit(quotes, { refEthPerTac = 0n, maxDevBps = 1000, maxGapBps = 1000 } = {}) {
  const prices = quotes.filter((q) => q.amountIn > 0n && q.tacOut > 0n).map(ethPerTac);
  if (!prices.length) return { ok: true };
  const lo = prices.reduce((a, b) => (b < a ? b : a)), hi = prices.reduce((a, b) => (b > a ? b : a));
  if (prices.length > 1 && lo > 0n && ((hi - lo) * 10_000n) / lo > BigInt(maxGapBps)) return { ok: false, why: `the venues price TAC ${((hi - lo) * 10_000n) / lo} bps apart` };
  if (refEthPerTac > 0n && lo > (refEthPerTac * BigInt(10_000 + maxDevBps)) / 10_000n) return { ok: false, why: `TAC costs more here than the reference price by over ${maxDevBps} bps` };
  return { ok: true };
}
