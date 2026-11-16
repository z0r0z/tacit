// What a deposit's receipt says of a pool thin enough that a trade can land while the deposit is being proved.
//
// A deposit into a pool is proved against the price the pool has at that moment, and a trade that lands first ends that proof (the page proves it again by itself, up to three
// times, and nothing is sent or spent until one goes through). How often that happens follows from how thin the pool is: the page cannot see how often a pool trades without
// reading old blocks from nodes that ask for it dearly, but it does know how far a trade moves it, and a pool that a small trade moves is one that traders find worth moving.
// So the hint is that fact, for a trade of TRADE_ETH, worked out from the pool's size in ETH (both sides, as the page already counts it): constant product, the pool holding
// half its worth on the ETH side. A pool that moves less than SHOW_AT percent for it says nothing.
export const TRADE_ETH = 0.1, SHOW_AT = 0.5;
export const TIP = 'Your deposit goes in at the price the pool has when it is proved, and a trade that lands first ends that proof. It is then proved again by itself, up to three times, and nothing is sent or spent until one goes through.';

const shown = (n) => (n >= 10 ? String(Math.round(n)) : n >= 1 ? String(Math.round(n * 10) / 10) : String(Math.round(n * 100) / 100));

export function smallPool(worthEth) {
  const w = Number(worthEth);
  if (!(w > 0) || !Number.isFinite(w)) return null;
  const move = ((1 + TRADE_ETH / (w / 2)) ** 2 - 1) * 100;
  if (!(move >= SHOW_AT)) return null;
  return { move, row: ['Small pool', `a ${TRADE_ETH} ETH trade moves its price ${shown(move)}%`, '', TIP], time: ', longer if the pool trades meanwhile' };
}
