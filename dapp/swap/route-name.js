
export function privateRoute({ pools, pout, sale }, symOf) {
  const steps = [];
  if (pools?.length) steps.push(`Tacit pool · ${[symOf(pools[0].a), ...pools.map((p) => symOf(p.b))].join(' → ')}`);
  if (pout) steps.push(sale ? `out of the pool → ${sale}` : 'out of the pool');
  const s = steps.join(', ');
  return s && s[0].toUpperCase() + s.slice(1);
}
export const hopRoute = (name) => `Pay pool → ${name}`;

export const ROUTE_TIPS = {
  private: 'A swap inside Tacit’s pool, at the pool’s own price. What you get lands as a private note.',
  out: 'The note is taken out of the pool and paid to the address as ETH.',
  sale: 'The note is taken out of the pool as ETH, which is sold for the token on the best onchain route and paid to the address.',
  hop: 'The ETH waits in the Pay pool and is swapped out of it a little later, on the best onchain route then. No outside solver is asked, since it would learn the wallet and the address together, so the rate can sit a little under the best public one.',
};

export function routeLine({ r, pools, hop }, symOf) {
  if (hop) return { text: hopRoute(r.name), tip: ROUTE_TIPS.hop };
  const text = r.priv && privateRoute({ pools, pout: r.pout, sale: r.sale }, symOf);
  return text ? { text, tip: ROUTE_TIPS[r.pout ? (r.sale ? 'sale' : 'out') : 'private'] } : null;
}
