// The plan for a swap of Bitcoin for ETH that more than one provider fills (dapp/fastbridge-pair.js): which providers, how many sats of the amount to each, and what the user
// gets. Pure: integers (BigInt) only, no clock, no network. The pair client asks it with what the providers' ads say (fees, limits, what they hold) and what their quotes
// give (their rate), and shows what it returns before anything is pressed.
//
//   planSplit({ amount, providers, feeRate, policy }) -> { best, single, options }
//
//   providers  [{ id, min, max, available, feeBps, flatFee, rate }]   sats; `available` null when the ad names none; `rate` the pool units a satoshi buys after the fee,
//              scaled by RATE_ONE (a provider's quote gives it: units paid out / (sats less its fee); an ad names none, and the plan then takes every provider at one rate and
//              is only a guess at who is worth asking, which the quotes then settle)
//   feeRate    sat/vB the one transaction pays: every lock after the first adds an output (OUTPUT_VB) to it, and that is a cost of a split
//   best       the plan to show: { legs: [{ id, amount, get }], pay, get, extraFeeSats, net, split }, `net` being what is got less what the added outputs cost (valued at the rate of
//              the best provider); null when no provider group can fill the amount
//   single     the best plan of one provider, when one can take the whole amount (what a split is shown against), else null
//
// A split is chosen only when no one provider can take the amount, or when it gives more by at least `minGainBps` of what the one gives (the more providers, the more
// quotes held, locks watched and refunds possible: not for a gain that a rounding makes). Legs are at least `minLegSats` (so that a flat fee does not dominate a leg) and
// at most `maxLegs`; a leg is within its provider's [min, max, available].

export const RATE_ONE = 10n ** 18n;
export const OUTPUT_VB = 43;                                     // a Taproot lock output: 8 value + 1 length + 34 script
export const SPLIT_POLICY = { maxLegs: 4, minLegSats: 50_000n, minGainBps: 5, maxProviders: 8 };

const big = (v) => BigInt(v);
// What a provider pays out for `amount` sats, as its quote works it out: the fee (basis points of the amount and a flat fee) comes off first
export const feeOf = (p, amount) => (big(amount) * big(p.feeBps ?? 0)) / 10000n + big(p.flatFee ?? 0);
export function getFrom(p, amount) {
  const a = big(amount), f = feeOf(p, a);
  return a > f ? ((a - f) * big(p.rate ?? RATE_ONE)) / RATE_ONE : 0n;
}
const capOf = (p) => { const m = big(p.max), v = p.available == null ? m : big(p.available); return v < m ? v : m; };
const floorOf = (p, policy) => { const m = big(p.min), l = big(policy.minLegSats); return m > l ? m : l; };

// The best way to share `amount` among exactly these providers, or null: every leg at its smallest, then the rest to the providers that give the most for each further
// sat (the price is a straight line per provider once it is used, so filling the best first is the best there is), each up to its own cap.
function allocate(amount, group, policy) {
  const lo = group.map((p) => floorOf(p, policy)), hi = group.map(capOf);
  if (lo.some((l, i) => l > hi[i])) return null;
  const need = big(amount), floor = lo.reduce((t, x) => t + x, 0n), ceil = hi.reduce((t, x) => t + x, 0n);
  if (need < floor || need > ceil) return null;
  const take = lo.slice();
  let rest = need - floor;
  const slope = (p) => (10000n - big(p.feeBps ?? 0)) * big(p.rate ?? RATE_ONE);
  for (const i of group.map((_, k) => k).sort((a, b) => (slope(group[a]) > slope(group[b]) ? -1 : slope(group[a]) < slope(group[b]) ? 1 : a - b))) {
    const add = hi[i] - take[i] < rest ? hi[i] - take[i] : rest;
    take[i] += add; rest -= add;
  }
  return rest === 0n ? take : null;
}

const subsets = (list, max) => {
  const out = [];
  const go = (from, acc) => { if (acc.length) out.push(acc.slice()); if (acc.length === max) return; for (let i = from; i < list.length; i++) { acc.push(list[i]); go(i + 1, acc); acc.pop(); } };
  go(0, []);
  return out;
};

export function planSplit({ amount, providers, feeRate = 1, policy: policyIn = {} }) {
  const policy = { ...SPLIT_POLICY, ...policyIn }, want = big(amount);
  if (want <= 0n) return { best: null, single: null, options: [] };
  const list = providers.slice(0, policy.maxProviders);
  // the best rate stands for what a sat of the added outputs' fee would have bought
  const bestRate = list.reduce((m, p) => (big(p.rate ?? RATE_ONE) > m ? big(p.rate ?? RATE_ONE) : m), 0n) || RATE_ONE;
  const rate = Math.max(0, Number(feeRate) || 0);
  const options = [];
  for (const group of subsets(list, policy.maxLegs)) {
    const take = allocate(want, group, policy);
    if (!take) continue;
    const legs = group.map((p, i) => ({ id: p.id, amount: take[i], get: getFrom(p, take[i]) }));
    const got = legs.reduce((t, l) => t + l.get, 0n);
    const extraFeeSats = BigInt(Math.ceil((legs.length - 1) * OUTPUT_VB * rate));
    // (a sat of fee is a sat of the amount less: its worth is what the best provider pays for a sat)
    const net = got - (extraFeeSats * bestRate) / RATE_ONE;
    // the legs in the order the providers are given (the order of the lock outputs)
    options.push({ legs, pay: want, get: got, extraFeeSats, net, split: legs.length > 1 });
  }
  // the most net; of equal, the fewest legs, then the order given
  options.sort((a, b) => (a.net > b.net ? -1 : a.net < b.net ? 1 : a.legs.length - b.legs.length));
  const single = options.filter((o) => !o.split)[0] || null;
  let best = options[0] || null;
  if (best && best.split && single) {
    const gain = best.net - single.net;
    if (gain * 10000n < single.net * big(policy.minGainBps)) best = single;
  }
  return { best, single, options };
}
