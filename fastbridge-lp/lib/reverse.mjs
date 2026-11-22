// The daemon's reverse side (Ethereum -> Bitcoin; dapp/fastbridge-reverse-provider.js): what it needs around the service. A Bitcoin address of its own,
// derived from the provider's key, which holds the TAC it sells and its fee coins and nothing the other direction or the market maker touches; the notes
// at that address; the options; and the routing of `/reverse/...` to the service. Off unless switched on.
//
// WHY AN ADDRESS OF ITS OWN. The provider's main Bitcoin address holds its earnings, its take fee coins and (on the house provider) the stock that a
// market maker lists from, by outpoint, in a state the daemon cannot see. A lock picks the smallest note that covers it and funds itself from the largest
// coins, so on a shared address it would spend a listed note and a maker's proceeds coin; and that address has so many outputs that explorers refuse to list
// it, which a lock needs (it funds from the provider's own coins). A fresh address has none of that, and the most a stream of requests can tie up is what was
// put there on purpose.

import { hmac, sha256 } from '../../dapp/vendor/tacit-deps.min.js';
import { SECP_N } from '../../dapp/bulletproofs.js';

const te = new TextEncoder();
const big = (b) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

// The key of the reverse address: HMAC(key, tag). A scalar outside the curve's order (a chance of 2^-128) takes the next counter.
export function reverseKeyOf(key) {
  for (let i = 0; i < 8; i++) {
    const k = hmac(sha256, key, te.encode(i ? `tacit-fastbridge-reverse-btc-v1:${i}` : 'tacit-fastbridge-reverse-btc-v1'));
    const n = big(k);
    if (n > 0n && n < SECP_N) return k;
  }
  throw new Error('no key could be derived');
}
// the secrets of its swaps, apart from the other direction's
export const reverseSeedOf = (key) => hmac(sha256, key, te.encode('tacit-fastbridge-reverse-seed-v1'));

const tacUnits = (t) => { const [whole, frac = ''] = String(t).split('.'); return BigInt(whole) * 10n ** 8n + BigInt(frac.padEnd(8, '0').slice(0, 8)); };
const confsFor = (v) => (BigInt(v) >= 10_000n * 10n ** 8n ? 3 : BigInt(v) >= 1_000n * 10n ** 8n ? 2 : 1);

// null when the reverse side is off. The defaults are the cautious ones: two sends at once, and at most 2,000 TAC out at once whatever is funded.
export function reverseOptions(C) {
  const r = C.reverse;
  if (!r || r.enabled !== true) return null;
  const ceiling = r.maxTac == null ? 2000n * 10n ** 8n : tacUnits(r.maxTac);
  return {
    quote: { btcAsset: C.btcAsset, evmAsset: C.evmAsset, minAmount: String(r.minAmount ?? '1000000000'), maxAmount: String(r.maxAmount ?? '100000000000'), feeBps: r.feeBps ?? 30, flatFee: String(r.flatFee ?? '10000000'), validSecs: r.validSecs ?? 600 },
    csvBlocks: r.csvBlocks ?? 72, evmWindowSecs: C.policy.evmWindowSecs ?? 4 * 3600, maxOpen: r.maxOpen ?? 2, maxLocked: ceiling, minConfsFor: confsFor,
    anyTac: r.anyTac !== false, alertSecs: C.alertSecs ?? 3600, refreshSecs: r.refreshSecs ?? 60,
    policy: { minClaimSecs: C.policy.minClaimSecs ?? 3600, offerWaitSecs: 2 * 3600, maxEvmWindowSecs: 6 * 3600 },
  };
}

// The confirmed TAC notes at the reverse address, as the lock takes them: the ones at its own address (the wallet the module reads must be the reverse key's).
// `tacit` is the namespace the daemon loads; its wallet is set to the reverse key by the caller.
// A scan that fails is logged and thrown (the service then answers "not available", never an empty address that reads as no TAC).
export function makeReverseInventory({ tacit, asset, log = () => {} }) {
  return {
    async notes() {
      let h;
      try { h = await tacit.scanHoldings(); }
      catch (e) { log({ level: 'warn', msg: 'reverse: the notes at the reverse address could not be read', error: String((e && e.message) || e).slice(0, 200) }); throw e; }
      const e = h instanceof Map ? h.get(asset) : null;
      return ((e && e.utxos) || [])
        .filter((x) => x.utxo && x.utxo.status && x.utxo.status.confirmed && !x.stealthTweakedSk)
        .map((x) => ({ txid: x.utxo.txid, vout: x.utxo.vout, value: x.utxo.value, amount: BigInt(x.amount), blinding: BigInt(x.blinding) }));
    },
  };
}

// `/reverse/...` goes to the reverse service, everything else to the one it had
export const routed = (forward, reverse) => (req) => (req && typeof req.path === 'string' && req.path.startsWith('/reverse/') ? reverse(req) : forward(req));
