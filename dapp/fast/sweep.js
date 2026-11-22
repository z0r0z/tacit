// A bridge too big for any one provider, split across several: which providers take which part, and which of the key's notes fund each part.
// No DOM, no network, and one import (the sum a provider keeps): the providers' terms and the key's notes are passed in, so the rule runs without a wallet. Each part is a whole
// bridge on its own (fastbridge-client.js `sweep`), with its own lock on Bitcoin and its own refund; a part that goes wrong costs the others nothing.
//
//   sweepRoom(providers)                      the most that can be split now
//   splitAmount({ amount, providers })        -> [{ legs: [{ provider, amount, fee }], fee, receive }], the best first
//   assignNotes(amounts, notes, pick)         -> [{ notes, change }] for each amount (no note in two), or null when the notes cannot be shared out
//
//   providers  [{ id, name, ref, terms }] as fast/discover.js lists them (terms: feeBps, flatFee, minAmount, maxAmount, available, anyTac)

import { feeOf } from '../fastbridge-price.js';

export const MAX_LEGS = 4;
// A rough price, in base units of TAC (1 TAC), for each part: its lock has a Bitcoin fee of its own, and one more part is one more thing that can stop.
// It only moves a plan that costs almost the same toward fewer parts.
export const LEG_PENALTY = 100_000_000n;
// the providers weighed against each other: the ones with the most room (every way to choose up to MAX_LEGS of them is tried)
const POOL = 10;

const capOf = (t) => (t.available != null && t.available < t.maxAmount ? t.available : t.maxAmount);
// what a provider keeps of an amount: its quote's own sum (fastbridge-price.js, the one definition of it)
export const feeAt = (t, a) => feeOf(t, a);
const room = (p) => { const c = capOf(p.terms); return c >= p.terms.minAmount && c > 0n; };
const byCap = (a, b) => (capOf(a.terms) > capOf(b.terms) ? -1 : capOf(a.terms) < capOf(b.terms) ? 1 : String(a.id) < String(b.id) ? -1 : 1);

// The providers a part can go to: they take any TAC (a part is not looked at one by one for a history the bridge's proof follows, so a provider
// that screens is left to the single bridge, which does that) and have room now.
export const takers = (providers, exclude = new Set()) => providers.filter((p) => p.terms.anyTac && room(p) && !exclude.has(p.id));

// The most that can be split now: the room of the MAX_LEGS providers with the most.
export function sweepRoom(providers) {
  return takers(providers).map((p) => capOf(p.terms)).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)).slice(0, MAX_LEGS).reduce((s, c) => s + c, 0n);
}

// Every way to split `amount` over two to `maxLegs` providers, the cheapest first (the fee kept, plus LEG_PENALTY for each part, fewer parts on a tie).
// For a set of providers the cheapest split is the one that gives each its least and fills the cheapest rate first: a provider's fee is a rate on
// the amount and a flat sum, and the flat sums are the same whatever the split.
export function splitAmount({ amount, providers, maxLegs = MAX_LEGS, exclude = new Set() }) {
  const A = BigInt(amount), pool = takers(providers, exclude).sort(byCap).slice(0, POOL), plans = [];
  const consider = (set) => {
    const caps = set.map((p) => capOf(p.terms)), mins = set.map((p) => p.terms.minAmount);
    const sumCap = caps.reduce((s, c) => s + c, 0n), sumMin = mins.reduce((s, c) => s + c, 0n);
    if (sumCap < A || sumMin > A) return;
    const give = mins.slice();
    let rest = A - sumMin;
    const cheapest = set.map((_, i) => i).sort((i, j) => set[i].terms.feeBps - set[j].terms.feeBps || (caps[i] > caps[j] ? -1 : 1));
    for (const i of cheapest) { const add = rest < caps[i] - give[i] ? rest : caps[i] - give[i]; give[i] += add; rest -= add; }
    if (rest !== 0n || set.some((p, i) => give[i] <= feeAt(p.terms, give[i]))) return;          // a part must clear its own fee
    const legs = set.map((provider, i) => ({ provider, amount: give[i], fee: feeAt(provider.terms, give[i]) })).sort((x, y) => (x.amount > y.amount ? -1 : x.amount < y.amount ? 1 : 0));
    const fee = legs.reduce((s, l) => s + l.fee, 0n);
    plans.push({ legs, fee, receive: A - fee, score: fee + LEG_PENALTY * BigInt(legs.length) });
  };
  const walk = (from, chosen) => {
    if (chosen.length >= 2) consider(chosen);
    if (chosen.length === maxLegs) return;
    for (let i = from; i < pool.length; i++) walk(i + 1, [...chosen, pool[i]]);
  };
  walk(0, []);
  const ids = (p) => p.legs.map((l) => String(l.provider.id)).sort().join(',');
  return plans.sort((x, y) => (x.score < y.score ? -1 : x.score > y.score ? 1 : x.legs.length - y.legs.length || (ids(x) < ids(y) ? -1 : 1)));
}

const noteKey = (n) => `${n.txid}:${n.vout}`;
const orders = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((o) => [x, ...o])));

// Shares the key's notes out among the parts, none in two: a note is spent whole by one lock, and what is left of it comes back as a note that is
// not confirmed yet, so no second part can draw on it. `pick(notes, amount)` is the client's own choice of the notes a lock spends
// (fastbridge-client.js pickNotes), so each part gets exactly what its lock will take. The largest part first; when that leaves a part short, every other
// order is tried. Resolves to null when the notes cannot be shared out.
export function assignNotes(amounts, notes, pick) {
  const index = amounts.map((_, i) => i);
  const attempt = (order) => {
    let left = notes;
    const out = new Array(amounts.length);
    for (const i of order) {
      const p = pick(left, amounts[i]);
      if (!p) return null;
      out[i] = { notes: p.notes, change: p.change };
      const used = new Set(p.notes.map(noteKey));
      left = left.filter((n) => !used.has(noteKey(n)));
    }
    return out;
  };
  const largestFirst = index.slice().sort((x, y) => (amounts[x] > amounts[y] ? -1 : amounts[x] < amounts[y] ? 1 : 0));
  return attempt(largestFirst) || orders(index).map(attempt).find(Boolean) || null;
}
