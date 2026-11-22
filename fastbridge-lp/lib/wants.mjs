// The alert for bridges waiting for a provider (fastbridge-lp/server.mjs): what is waiting, what the ones that name a price will pay, and how many of
// them this provider's own fee already meets. The fields that are scalars reach the one readable line a chat webhook shows (lib/alert.mjs leaves
// arrays out of it); the arrays are in the JSON body and the log.

import { meetsPrice } from '../../dapp/fastbridge-price.js';

// TAC in base units (8 places) for a line: whole TAC with thousands, and two places when there are some
const tac = (units) => {
  const u = BigInt(units), whole = u / 10n ** 8n, frac = (u % 10n ** 8n) / 10n ** 6n;
  return `${whole.toLocaleString('en-US')}${frac ? `.${String(frac).padStart(2, '0').replace(/0$/, '')}` : ''} TAC`;
};
const pct = (bps) => `${(bps / 100).toFixed(2)}%`;

// `fresh`: the wants not seen before, [{ amount (base units, a string or a number), maxFeeBps (a whole number, or null for none) }].
// `quote`: this provider's terms, { feeBps, flatFee }.
export function waitingFields(fresh, quote) {
  const terms = { feeBps: Number(quote.feeBps) || 0, flatFee: BigInt(quote.flatFee ?? 0) };
  const priced = fresh.filter((w) => w.maxFeeBps != null);
  const met = fresh.filter((w) => meetsPrice(terms, { amount: BigInt(w.amount), maxFeeBps: w.maxFeeBps })).length;
  const largest = fresh.reduce((a, w) => (BigInt(w.amount) > a ? BigInt(w.amount) : a), 0n);
  return {
    count: fresh.length,
    amounts: fresh.map((w) => String(w.amount)),
    prices: fresh.map((w) => (w.maxFeeBps == null ? null : w.maxFeeBps)),
    largest: tac(largest),
    // what the ones that name a price will pay at most, and how many of all of them this provider's fee meets (one that names none is met by any)
    ...(priced.length ? { payUpTo: pct(Math.max(...priced.map((w) => w.maxFeeBps))), atYourFee: `${met} of ${fresh.length}` } : {}),
  };
}
