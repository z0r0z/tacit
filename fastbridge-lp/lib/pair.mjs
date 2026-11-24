// The daemon's BTC-ETH pair mode ("pair": "btc-eth" in the config, or FB_LP_PAIR=btc-eth): a provider that sells pool ETH for sats (the forward side) and, when the
// reverse side is on, sats for pool ETH. A provider of this pair is a process of its own with a key of its own (the house TAC provider is never changed by it): its
// ad names the sats asset and the pool's ETH, which is how a page finds it (dapp/fastbridge-pair.js).
//
// What differs from the TAC provider, and is set here:
//   - the assets (X.SATS_ASSET against the pool's ETH), and no refill from a treasury (there is no TAC to lend)
//   - amounts: the forward terms are in SATS (the least and most it takes, the flat part of its fee); the reverse terms are in pool ETH UNITS (1e-8 ETH), the amount a user
//     locks. Confirmations are a schedule in sats
//   - the PRICE: not a constant. Both directions price from one feed of ETH per BTC (dapp/fastbridge-rate.js) read from Chainlink's ETH / BTC aggregator through the pool's
//     RPC and from public exchange tickers, which must agree; with no price a provider quotes nothing, and says so
//   - the reverse side's inventory is the plain coins at its dedicated address (no note scan), capped by `maxSats` out at once
//
// Pure: nothing here reads a network. The daemon (server.mjs) calls these and wires the results.

import { SATS_ASSET, ETH_ASSET, confsForSats } from '../../dapp/fastbridge-pair.js';
import { makeRateFeed, chainlinkEthBtc, coinbaseEthBtc, krakenEthBtc } from '../../dapp/fastbridge-rate.js';

export const PAIR = 'btc-eth';
export const isPair = (C) => !!C && C.pair === PAIR;

const MIN_SATS = 20_000n;                                         // below this a take or a refund at a busy fee would leave dust (dapp/adaptor-btc-tx.js)
const uint = (name, v, { min = 0n, max = null } = {}) => {
  if (!/^\d{1,30}$/.test(String(v))) throw new Error(`${name} must be a whole number (got "${v}")`);
  const b = BigInt(v);
  if (b < min) throw new Error(`${name} must be at least ${min} (got ${v})`);
  if (max != null && b > max) throw new Error(`${name} must be at most ${max} (got ${v})`);
  return b;
};
const SATS_CONFS = [['0', 1], ['1000000', 2], ['10000000', 3], ['100000000', 6]];

// The config of a pair provider, checked and filled in: throws a plain sentence for a value that is not valid (the process does not start on a guess).
export function pairConfig(C) {
  const q = C.quote || {};
  const min = uint('quote.minAmount (sats)', q.minAmount ?? '50000', { min: MIN_SATS }), max = uint('quote.maxAmount (sats)', q.maxAmount ?? '5000000');
  // (a maximum under the minimum is the daemon's way to stop taking new swaps and finish the open ones, as for the TAC provider)
  const fee = Number(q.feeBps ?? 30);
  if (!Number.isInteger(fee) || fee < 0 || fee > 500) throw new Error(`quote.feeBps must be 0 to 500 (got "${q.feeBps}")`);
  const flat = uint('quote.flatFee (sats)', q.flatFee ?? '1000');
  const out = {
    ...C, btcAsset: SATS_ASSET, evmAsset: ETH_ASSET, refill: false,
    quote: { ...q, minAmount: String(min), maxAmount: String(max), feeBps: fee, flatFee: String(flat), validSecs: q.validSecs ?? 300 },
    policy: { ...(C.policy || {}), confs: (C.policy && C.policy.confs) || SATS_CONFS },
  };
  if (C.reverse && C.reverse.enabled === true) {
    const r = C.reverse;
    const rmin = uint('reverse.minAmount (pool ETH units)', r.minAmount ?? '1000000'), rmax = uint('reverse.maxAmount (pool ETH units)', r.maxAmount ?? '100000000');
    const rfee = Number(r.feeBps ?? 30);
    if (!Number.isInteger(rfee) || rfee < 0 || rfee > 500) throw new Error(`reverse.feeBps must be 0 to 500 (got "${r.feeBps}")`);
    out.reverse = {
      ...r, minAmount: String(rmin), maxAmount: String(rmax), feeBps: rfee, flatFee: String(uint('reverse.flatFee (pool ETH units)', r.flatFee ?? '20000')),
      maxSats: String(uint('reverse.maxSats', r.maxSats ?? '5000000', { min: MIN_SATS })), maxOpen: r.maxOpen ?? 2, lockFeeReserve: String(uint('reverse.lockFeeReserve (sats)', r.lockFeeReserve ?? '20000')),
    };
  }
  return out;
}

// The price feed: Chainlink through the pool's RPC (`call(to, data)` -> hex) and the exchange tickers, as many as the config names (`rate.sources`, default all three).
// Two must answer and agree within `rate.maxSpreadBps` (100); a read stands for `rate.maxAgeSecs` (180).
export function pairFeed({ call, fetchImpl, now, log, C }) {
  const rc = C.rate || {}, names = rc.sources || ['chainlink', 'coinbase', 'kraken'];
  const make = { chainlink: () => chainlinkEthBtc({ call, ...(now ? { now } : {}) }), coinbase: () => coinbaseEthBtc({ fetchImpl }), kraken: () => krakenEthBtc({ fetchImpl }) };
  const bad = names.filter((n) => !make[n]);
  if (bad.length) throw new Error(`rate.sources names ${bad.join(', ')}, which is not one of chainlink, coinbase, kraken`);
  return makeRateFeed({ sources: names.map((n) => make[n]()), ...(now ? { now } : {}), minSources: rc.minSources ?? 2, maxSpreadBps: rc.maxSpreadBps ?? 100, maxAgeSecs: rc.maxAgeSecs ?? 180, log });
}

// The confirmations the forward side waits for on a user's lock, from the schedule [[sats, n], ...]
export const satsConfsFor = (list) => {
  const confs = (list || SATS_CONFS).map(([from, n]) => [BigInt(from), n]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return (v) => confs.reduce((n, [from, c]) => (BigInt(v) >= from ? c : n), confs[0][1]);
};

// The options of the reverse service for a pair provider (dapp/fastbridge-reverse-provider.js), or null when it is off
export function pairReverseOptions(C, feed) {
  const r = C.reverse;
  if (!r || r.enabled !== true) return null;
  return {
    quote: { btcAsset: SATS_ASSET, evmAsset: ETH_ASSET, minAmount: String(r.minAmount), maxAmount: String(r.maxAmount), feeBps: r.feeBps, flatFee: String(r.flatFee), validSecs: r.validSecs ?? 300, rate: () => feed.rate() },
    csvBlocks: r.csvBlocks ?? 96, evmWindowSecs: C.policy.evmWindowSecs ?? 4 * 3600, maxOpen: r.maxOpen, maxOpenPerKey: r.maxOpenPerKey ?? 1, maxLocked: BigInt(r.maxSats), minConfsFor: (v) => confsForSats(v), lockFeeReserve: String(r.lockFeeReserve),
    alertSecs: C.alertSecs ?? 3600, refreshSecs: r.refreshSecs ?? 60, policy: { minClaimSecs: C.policy.minClaimSecs ?? 3600, offerWaitSecs: 2 * 3600, maxEvmWindowSecs: 6 * 3600 },
  };
}

// The plain coins at the reverse address as the service takes its inventory: a coin's `amount` is its value in sats
export const satsInventory = (btc) => ({ notes: async () => (await btc.satsUtxos()).map((c) => ({ ...c, amount: BigInt(c.value) })) });
