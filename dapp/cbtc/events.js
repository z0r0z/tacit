// The collateral engine's events that draw cBTC's history, and what is kept of each. No imports: the page, the test and
// tools/cbtc-history-base.mjs (which writes the settled part of this history down, see history-base.js) all use it.
export const ENGINE = '0x000000003f608BDdF0ca45934003ffb9DbDF70DB';
export const FIRST_BLOCK = 25998000;                                   // a little before the engine's first event
export const SPAN = 9999;                                              // the widest range of blocks the public nodes that serve old logs all take
export const TOPIC = { posted: '0x0c008a699968f2a24063b7eb14d9239b2430c502fda280245345c78cbc47b7c1', minted: '0x232c7d098ca44092999087e6ee530a2171f95f9ecb1caa363f6dcf448fb7dd57',
  closed: '0xc0ede5b75ee32986e50a2a39fa32dbf5e8eff1c91a46cd127591edebd91b4db9', liquidated: '0x28d08a2db16236ca56b1223ba30ba49824b860a3e7eb8c5a1c1224697aa3ebd1' };
const KIND = Object.fromEntries(Object.entries(TOPIC).map(([k, v]) => [v, k]));

// The `eth_getLogs` filter for a range of blocks.
export const filterFor = (from, to) => ({ address: ENGINE, topics: [Object.values(TOPIC)], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) });

// Logs with the time of their block. Most nodes put it in each log (`blockTimestamp`); one that does not is asked for the few blocks that carry events.
export async function withTimes(logs, blockTime) {
  const need = [...new Set(logs.filter((l) => l.blockTimestamp == null).map((l) => l.blockNumber))];
  const at = new Map(await Promise.all(need.map(async (b) => [b, await blockTime(b)])));
  return logs.map((l) => (l.blockTimestamp == null ? { ...l, blockTimestamp: at.get(l.blockNumber) } : l));
}

// Logs → what the history needs, in the order they happened: when each lock's bond was first posted ([time, outpoint]) and each change in what is lent
// ([time, cUSD at 8 decimals, negative for a loan closed or liquidated], a string: it is written into a file).
export function eventsOf(logs) {
  const sorted = logs.map((l) => ({ l, b: Number(BigInt(l.blockNumber)), i: Number(BigInt(l.logIndex)), t: l.blockTimestamp == null ? NaN : Number(BigInt(l.blockTimestamp)) })).sort((x, y) => x.b - y.b || x.i - y.i);
  const posted = [], loans = [], seen = new Set();
  for (const { l, t } of sorted) {
    if (!Number.isFinite(t)) throw new Error('an engine event without the time of its block');
    const kind = KIND[l.topics[0]], amount = BigInt(l.data.slice(0, 66));
    if (kind === 'posted') { if (!seen.has(l.topics[1])) { seen.add(l.topics[1]); posted.push([t, l.topics[1]]); } }
    else if (kind === 'minted') loans.push([t, String(amount)]);
    else if (kind === 'closed' || kind === 'liquidated') loans.push([t, String(-amount)]);
  }
  return { posted, loans };
}
