// What a pair provider earns and spends, swap by swap, and where the difference goes. Kept in the provider's own store, shown in /info.
//
// Per finished swap:
//   - the fee earned: the spread over the market at the time of the quote (the quote is kept with the market rate it was priced from, `mkt`). BTC -> ETH earns
//     in sats (the sats taken less the market value of the ETH paid); ETH -> BTC earns in pool ETH (the ETH taken less the market value of the sats paid)
//   - the network costs: the Bitcoin fees of its transactions as the explorers report them (the take, the reverse side's lock, a refund), and the pool ETH
//     the provider paid the relay (an estimate where the relay's fee is not on the record: a note cut, a refund)
//   - a swap that ends with the provider paid nothing for what it gave (`lost`, or its Bitcoin lock taken with no claim) is a loss, kept apart
// The net of a swap (fee less costs, in pool ETH at the rate of the moment) is REINVESTED (it stays as capacity) while the provider is under its target or
// buybacks are off, and OWED to buybacks while it is at its target with buybacks on (lib/buyback.mjs pays what is owed).
//
// Amounts: sats; pool ETH in its units of 1e-8 ETH. Kept as decimal strings.

const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };
const s = (v) => String(v);
const FWD_END = new Set(['done', 'refunded', 'lost']);
const REV_END = new Set(['done', 'refunded', 'counter-took']);
const DAY = 86400;

export function emptyStats(now) {
  return {
    v: 1, since: now, swaps: 0, swapsForward: 0, swapsReverse: 0, refunds: 0,
    feesEarnedSats: '0', feesEarnedEth: '0', networkCostSats: '0', networkCostEth: '0', lossesSats: '0', lossesEth: '0',
    netEth: '0', reinvestedEth: '0', owedEth: '0', counted: {}, capacity: { first: null, last: null, daily: [] },
    buyback: { routedEth: '0', feesEth: '0', sends: 0, tacBought: '0', lastTx: null, lastAt: null, day: null, dayRouted: '0', pending: null, attributed: '0', fromBlock: null, log: [] },
  };
}

// The fee a quote earned over the market it was priced from: { sats } for BTC -> ETH, { eth } for ETH -> BTC; null when the quote carries no market rate
export function feeOverMarket(q, dir) {
  if (!q || !q.mkt || !(big(q.mkt.num) > 0n) || !(big(q.mkt.den) > 0n)) return null;
  const num = big(q.mkt.num), den = big(q.mkt.den), btc = big(q.btcValue), eth = big(q.evmAmount);
  if (dir === 'fwd') return { sats: btc - (eth * den + num - 1n) / num };      // the sats taken, less what the ETH paid is worth (rounded up: never overstated)
  return { eth: eth - (btc * num + den - 1n) / den };                          // the ETH taken, less what the sats paid are worth
}

// pool ETH worth `sats` at { num, den } (pool units per sat)
export const satsToEth = (sats, rate) => (rate && big(rate.den) > 0n ? (big(sats) * big(rate.num)) / big(rate.den) : 0n);
export const ethToSats = (eth, rate) => (rate && big(rate.num) > 0n ? (big(eth) * big(rate.den)) / big(rate.num) : 0n);

// One finished swap into the totals. `e` = { id, dir: 'fwd'|'rev', end: 'done'|'refunded'|'lost', feeSats, feeEth, costSats, costEth, lossSats, lossEth }.
// `rate` (pool units per sat, now) turns the sats into pool ETH for the net; `owe` says where the net goes (buybacks on, at the target).
export function addSwap(st, e, { rate, owe = false }) {
  if (st.counted[e.id]) return st;
  const fs = big(e.feeSats), fe = big(e.feeEth), cs = big(e.costSats), ce = big(e.costEth), ls = big(e.lossSats), le = big(e.lossEth);
  st.counted[e.id] = e.end;
  st.swaps += 1;
  if (e.dir === 'fwd') st.swapsForward += 1; else st.swapsReverse += 1;
  if (e.end === 'refunded') st.refunds += 1;
  st.feesEarnedSats = s(big(st.feesEarnedSats) + fs); st.feesEarnedEth = s(big(st.feesEarnedEth) + fe);
  st.networkCostSats = s(big(st.networkCostSats) + cs); st.networkCostEth = s(big(st.networkCostEth) + ce);
  st.lossesSats = s(big(st.lossesSats) + ls); st.lossesEth = s(big(st.lossesEth) + le);
  const net = fe - ce - le + satsToEth(fs - cs - ls, rate);
  st.netEth = s(big(st.netEth) + net);
  // a net loss is never owed: it comes out of what is reinvested
  if (owe && net > 0n) st.owedEth = s(big(st.owedEth) + net); else st.reinvestedEth = s(big(st.reinvestedEth) + net);
  return st;
}

// A cost outside a swap (a recycle move's Bitcoin fee, a consolidation's relay fee): it lowers what is reinvested
export function addCost(st, { sats = 0, eth = 0 }, { rate }) {
  st.networkCostSats = s(big(st.networkCostSats) + big(sats)); st.networkCostEth = s(big(st.networkCostEth) + big(eth));
  const c = big(eth) + satsToEth(sats, rate);
  st.netEth = s(big(st.netEth) - c); st.reinvestedEth = s(big(st.reinvestedEth) - c);
  return st;
}

// A sample of what the provider holds: the first is kept, the last replaced, one a day kept for a year
export function sampleCapacity(st, c, now) {
  const x = { at: now, eth: s(c.eth), sats: s(c.sats), valueEth: s(c.valueEth) };
  st.capacity.first ||= x;
  st.capacity.last = x;
  const d = st.capacity.daily, last = d[d.length - 1];
  if (!last || Math.floor(last.at / DAY) !== Math.floor(now / DAY)) d.push(x); else d[d.length - 1] = x;
  if (d.length > 366) d.splice(0, d.length - 366);
  return st;
}

// What a finished forward record and its quote come to, with the Bitcoin fees read by txid (`txFee(txid)` -> sats or null) and the relay fee estimated (`relayFee()`)
export async function forwardEntry(rec, q, { txFee, relayFee }) {
  if (!FWD_END.has(rec.phase)) return null;
  const e = { id: 'f:' + rec.id, dir: 'fwd', end: rec.phase, feeSats: 0n, feeEth: 0n, costSats: 0n, costEth: 0n, lossSats: 0n, lossEth: 0n };
  const amount = big(rec.offer && rec.offer.evm && rec.offer.evm.amount);
  if (rec.phase === 'done') {
    const f = feeOverMarket(q, 'fwd');
    if (f) e.feeSats = f.sats > 0n ? f.sats : 0n;
    for (const t of [...new Set([rec.takenBy, rec.take && rec.take.txid, ...(rec.takes || [])].filter(Boolean))]) { const fee = await txFee(t); if (fee != null) { e.costSats += big(fee); break; } }
    if (rec.prepared) e.costEth += big(await relayFee());
  } else if (rec.phase === 'refunded') {
    if (rec.lock) e.costEth += big(await relayFee());          // the lock came back, less the relay's fee for the refund
    if (rec.prepared) e.costEth += big(await relayFee());
  } else if (rec.phase === 'lost') e.lossEth = amount;
  return e;
}
export async function reverseEntry(rec, q, { txFee }) {
  if (!REV_END.has(rec.phase)) return null;
  const paid = rec.phase === 'done' || (rec.phase === 'counter-took' && rec.claimedAt);
  const e = { id: 'r:' + rec.id, dir: 'rev', end: paid ? 'done' : rec.phase === 'refunded' ? 'refunded' : 'lost', feeSats: 0n, feeEth: 0n, costSats: 0n, costEth: 0n, lossSats: 0n, lossEth: 0n };
  for (const t of [rec.lock && rec.lock.commitTxid, rec.lock && rec.lock.txid, rec.refund && rec.refund.txid, rec.takeRefund && rec.takeRefund.txid].filter(Boolean)) { const fee = await txFee(t); if (fee != null) e.costSats += big(fee); }
  if (paid) { const f = feeOverMarket(q, 'rev'); if (f) e.feeEth = f.eth > 0n ? f.eth : 0n; }
  else if (e.end === 'lost') e.lossSats = big(rec.amount);
  return e;
}

// The part of /info: totals, and the capacity against the target
export function statsView(st, extra = {}) {
  const first = st.capacity.first, last = st.capacity.last;
  return {
    since: st.since, swaps: st.swaps, swapsForward: st.swapsForward, swapsReverse: st.swapsReverse, refunds: st.refunds,
    feesEarnedSats: st.feesEarnedSats, feesEarnedEth: st.feesEarnedEth, networkCostSats: st.networkCostSats, networkCostEth: st.networkCostEth,
    lossesSats: st.lossesSats, lossesEth: st.lossesEth, netEth: st.netEth, reinvestedEth: st.reinvestedEth, owedEth: st.owedEth,
    capacity: last ? { eth: last.eth, sats: last.sats, valueEth: last.valueEth, at: last.at, firstValueEth: first.valueEth, firstAt: first.at } : null,
    units: { eth: '1e-8 ETH', sats: 'sats' },
    ...extra,
  };
}
