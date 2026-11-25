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
const decimal = (name, v) => {
  const t = String(v).trim();
  if (!/^\d+(\.\d{1,8})?$/.test(t)) throw new Error(`${name} must be a positive decimal amount of TAC with at most 8 places (got "${t.slice(0, 40)}")`);
  const units = tacUnits(t);
  if (units <= 0n) throw new Error(`${name} must be greater than 0 TAC`);
  return { text: t, units };
};
const positiveRate = (name, v) => {
  const t = String(v).trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(t)) throw new Error(`${name} must be a positive fee rate in sat/vB (got "${t.slice(0, 40)}")`);
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive fee rate in sat/vB (got "${t.slice(0, 40)}")`);
  return n;
};
const positiveInt = (name, v, max) => {
  const t = String(v).trim();
  if (!/^\d+$/.test(t)) throw new Error(`${name} must be a positive whole number (got "${t.slice(0, 40)}")`);
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${name} must be 1 to ${max} (got "${t.slice(0, 40)}")`);
  return n;
};

// Rebalance is parsed even while reverse is off: a dry-run sidecar can check its configuration without starting either live service.
export function rebalanceOptions(C) {
  const configured = C.reverse && C.reverse.rebalance;
  if (configured != null && (typeof configured !== 'object' || Array.isArray(configured))) throw new Error('reverse.rebalance must be an object');
  const b = configured || {};
  const dataDir = String(C.dataDir || 'fastbridge-lp/data').replace(/\/+$/, '');
  const leases = b.leases == null ? `${dataDir}/reverse/rebalance-leases.json` : b.leases;
  if (typeof leases !== 'string' || !leases.trim() || leases.includes('\0')) throw new Error('reverse.rebalance.leases must be a non-empty path');
  const maxNote = decimal('reverse.rebalance.maxNoteTac', b.maxNoteTac ?? '250');
  const maxDaily = decimal('reverse.rebalance.maxDailyTac', b.maxDailyTac ?? '1000');
  const maxInventory = decimal('reverse.rebalance.maxInventoryTac', b.maxInventoryTac ?? '2000');
  const maxStuck = b.maxStuckTac == null ? null : decimal('reverse.rebalance.maxStuckTac', b.maxStuckTac);
  return {
    enabled: b.enabled === true, leases: leases.trim(),
    maxNote: maxNote.units, maxDaily: maxDaily.units, maxInventory: maxInventory.units, maxStuck: maxStuck?.units ?? null,
    maxNoteTac: maxNote.text, maxDailyTac: maxDaily.text, maxInventoryTac: maxInventory.text, maxStuckTac: maxStuck?.text ?? null,
    maxFeeRate: positiveRate('reverse.rebalance.maxFeeRate', b.maxFeeRate ?? 25),
    minSourceConfs: positiveInt('reverse.rebalance.minSourceConfs', b.minSourceConfs ?? 1, 1000),
    tickSecs: positiveInt('reverse.rebalance.tickSecs', b.tickSecs ?? 60, 3600),
    stallSecs: positiveInt('reverse.rebalance.stallSecs', b.stallSecs ?? 900, 86400),
  };
}

// null when the reverse side is off. The defaults are the cautious ones: two sends at once, and at most 2,000 TAC out at once whatever is funded.
export function reverseOptions(C) {
  const r = C.reverse;
  const rebalance = rebalanceOptions(C);
  if (!r || r.enabled !== true) return null;
  if (rebalance.enabled && rebalance.maxStuck == null) throw new Error('reverse.rebalance.maxStuckTac is required for enabled live rebalance');
  const ceiling = r.maxTac == null ? 2000n * 10n ** 8n : decimal('reverse.maxTac', r.maxTac).units;
  const minProceedsText = String(r.minProceedsBps ?? 10000).trim();
  const minProceedsBps = Number(minProceedsText);
  if (!/^\d+$/.test(minProceedsText) || !Number.isSafeInteger(minProceedsBps) || minProceedsBps < 10000 || minProceedsBps > 1000000) throw new Error(`reverse.minProceedsBps must be a whole number from 10000 to 1000000 (got "${minProceedsText.slice(0, 40)}")`);
  return {
    quote: { btcAsset: C.btcAsset, evmAsset: C.evmAsset, minAmount: String(r.minAmount ?? '1000000000'), maxAmount: String(r.maxAmount ?? '100000000000'), feeBps: r.feeBps ?? 30, flatFee: String(r.flatFee ?? '10000000'), validSecs: r.validSecs ?? 600 },
    csvBlocks: r.csvBlocks ?? 96, evmWindowSecs: C.policy.evmWindowSecs ?? 4 * 3600, maxOpen: positiveInt('reverse.maxOpen', r.maxOpen ?? 2, 20), maxLocked: ceiling, minConfsFor: confsFor,
    anyTac: r.anyTac !== false, alertSecs: C.alertSecs ?? 3600, refreshSecs: r.refreshSecs ?? 60, minProceedsBps,
    maxFeeRate: r.maxFeeRate == null ? null : positiveRate('reverse.maxFeeRate', r.maxFeeRate), rebalance,
    policy: { minClaimSecs: C.policy.minClaimSecs ?? 3600, offerWaitSecs: 2 * 3600, maxEvmWindowSecs: 6 * 3600 },
  };
}

// Confirmed TAC notes at the reverse address, as the lock takes them. includeUnconfirmed is for the rebalancer's accounting only:
// those notes carry confirmed=false and are never returned to the reverse service's sellable inventory by its default call.
export function makeReverseInventory({ tacit, asset, log = () => {}, includeUnconfirmed = false }) {
  return {
    async notes() {
      let h;
      try { h = await tacit.scanHoldings(); }
      catch (e) { log({ level: 'warn', msg: 'reverse: the notes at the reverse address could not be read', error: String((e && e.message) || e).slice(0, 200) }); throw e; }
      const e = h instanceof Map ? h.get(asset) : null;
      return ((e && e.utxos) || [])
        .filter((x) => x.utxo && x.utxo.status && (includeUnconfirmed || x.utxo.status.confirmed === true) && !x.stealthTweakedSk)
        .map((x) => ({ txid: x.utxo.txid, vout: x.utxo.vout, value: x.utxo.value, amount: BigInt(x.amount), blinding: BigInt(x.blinding), confirmed: x.utxo.status.confirmed === true }));
    },
  };
}

// `/reverse/...` goes to the reverse service, everything else to the one it had
export const routed = (forward, reverse) => (req) => (req && typeof req.path === 'string' && req.path.startsWith('/reverse/') ? reverse(req) : forward(req));
