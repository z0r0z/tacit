// What the swap card's Route row says for the routes that had no row of their own. A public swap's row names the pool that pays (the pools are listed when several are
// asked); a private swap, which crosses Tacit's own pools, and the way out of them said nothing, so "Chain sees: a swap, not whose" had no route beside it, and a swap
// through the Pay pool (Swap privately) read like a public one.
//   privateRoute: the coins a private swap passes through, under the pool's name; an exit adds the way out, and the sale that pays a token
//   hopRoute: the Pay pool, then the pool the ETH is sold on when it leaves it
// pools: [{ a, b }] as the quote carries them (a to b, in the order crossed); `symOf` names a pool's coin; `sale` is the pool an exit sells its ETH on (none: it pays ETH).

export function privateRoute({ pools, pout, sale }, symOf) {
  const steps = [];
  if (pools?.length) steps.push(`Tacit pool · ${[symOf(pools[0].a), ...pools.map((p) => symOf(p.b))].join(' → ')}`);
  if (pout) steps.push(sale ? `out of the pool → ${sale}` : 'out of the pool');
  const s = steps.join(', ');
  return s && s[0].toUpperCase() + s.slice(1);
}
export const hopRoute = (name) => `Pay pool → ${name}`;

// What each says when it is pointed at. The hop's says what it gives up: it asks no outside solver (one would be told the trade, and the card keeps the quote
// from anything that could join the deposit to where the token goes), so its rate can sit a little under the best public one.
export const ROUTE_TIPS = {
  private: 'A swap inside Tacit’s pool, at the pool’s own price. What you get lands as a private note.',
  out: 'The note is taken out of the pool and paid to the address as ETH.',
  sale: 'The note is taken out of the pool as ETH, which is sold for the token on the best onchain route and paid to the address.',
  hop: 'The ETH waits in the Pay pool and is swapped out of it a little later, on the best onchain route then. No outside solver is asked, since it would learn the wallet and the address together, so the rate can sit a little under the best public one.',
};

// { text, tip } for the Route row of the quote row `r`, or null where the row's own name already says it: `hop` when it is ETH going through the Pay pool
export function routeLine({ r, pools, hop }, symOf) {
  if (hop) return { text: hopRoute(r.name), tip: ROUTE_TIPS.hop };
  const text = r.priv && privateRoute({ pools, pout: r.pout, sale: r.sale }, symOf);
  return text ? { text, tip: ROUTE_TIPS[r.pout ? (r.sale ? 'sale' : 'out') : 'private'] } : null;
}
