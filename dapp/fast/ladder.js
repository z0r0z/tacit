// The depth of the fast bridge's providers as a ladder: what it costs to bridge each size, the way the page would bridge it now, and who is waiting
// and for what price. No DOM, no network: the providers' terms and the wants are passed in, so the rule runs without a wallet.
//
//   costBySize(providers)   -> { depth, least, rows: [{ amount, fee, parts: [{ provider, amount, fee }] }] }
//   waitLevels(items)       -> [{ maxFeeBps, count, total }] by the price waiting bridges will pay, the highest first (maxFeeBps null: any fee)
//
//   providers  [{ id, name, terms }] as fast/discover.js lists them (terms: feeBps, flatFee, minAmount, maxAmount, available, anyTac)
//   items      [{ amount, maxFeeBps }] the wants on the boards (fast/want.js waiting)
//
// A provider's fee is a rate on the amount and a flat part, so what a size costs is not a price on a line but a curve, and the cheapest provider for a
// small amount is not always the cheapest for a large one. The ladder is that curve at round sizes. It follows what the page does: a size one provider
// takes whole goes to the cheapest of those that do; a size none takes whole is split (fast/sweep.js), and the row says across whom.

import { capOf, takes } from './route.js';
import { splitAmount, sweepRoom, feeAt } from './sweep.js';

const ONE = 10n ** 8n;
// the round sizes a ladder steps through (TAC), between the least a provider takes and the most that can be had
const STEPS = [10, 30, 100, 300, 1000, 3000, 10000, 30000, 100000, 300000, 1000000, 3000000];
const MOST_ROWS = 8;

const room = (p) => { const c = capOf(p.terms); return c >= p.terms.minAmount && c > 0n; };
const ascending = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The best way to bridge `amount` now, or null when nothing takes it: { amount, fee, parts }.
function bestFor(amount, providers) {
  const singles = providers.filter((p) => room(p) && takes(p.terms, amount))
    .map((p) => ({ p, fee: feeAt(p.terms, amount) }))
    .sort((a, b) => ascending(a.fee, b.fee) || (String(a.p.name || a.p.id) < String(b.p.name || b.p.id) ? -1 : 1));
  if (singles.length) return { amount, fee: singles[0].fee, parts: [{ provider: singles[0].p, amount, fee: singles[0].fee }] };
  const [plan] = splitAmount({ amount, providers });
  return plan ? { amount, fee: plan.fee, parts: plan.legs.map((l) => ({ provider: l.provider, amount: l.amount, fee: l.fee })) } : null;
}

export function costBySize(providers, { rows: most = MOST_ROWS } = {}) {
  const live = providers.filter(room);
  if (!live.length) return { depth: 0n, least: null, rows: [] };
  const least = live.reduce((a, p) => (p.terms.minAmount < a ? p.terms.minAmount : a), live[0].terms.minAmount);
  const single = live.reduce((a, p) => (capOf(p.terms) > a ? capOf(p.terms) : a), 0n), together = sweepRoom(providers);
  const depth = together > single ? together : single;
  // the least, the round sizes between, and the most; when that is more than a ladder shows, an even spread of them
  const sizes = new Set([least, depth]);
  for (const s of STEPS) { const u = BigInt(s) * ONE; if (u > least && u < depth) sizes.add(u); }
  let asked = [...sizes].sort(ascending);
  if (asked.length > most) asked = Array.from({ length: most }, (_, i) => asked[Math.round((i * (asked.length - 1)) / (most - 1))]);
  return { depth, least, rows: [...new Set(asked)].map((a) => bestFor(a, providers)).filter(Boolean) };
}

// What is waiting, by the price it will pay: the ones that name none (any fee will do) first, then the highest price down.
export function waitLevels(items) {
  const by = new Map();
  for (const i of items || []) {
    const key = Number.isInteger(i.maxFeeBps) && i.maxFeeBps >= 0 ? i.maxFeeBps : null;
    const lv = by.get(key) || { maxFeeBps: key, count: 0, total: 0n };
    lv.count++; lv.total += BigInt(i.amount);
    by.set(key, lv);
  }
  return [...by.values()].sort((a, b) => (a.maxFeeBps === null ? -1 : b.maxFeeBps === null ? 1 : b.maxFeeBps - a.maxFeeBps));
}
