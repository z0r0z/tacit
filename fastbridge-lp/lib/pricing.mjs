// What the LP quotes. A quote fixes the amounts for a short time: the user pays `btcValue` on Bitcoin and receives
// `evmAmount` in the pool, the difference being the LP's fee (a share of the amount plus a flat part that covers its
// Bitcoin and settle costs). Quotes are stored, so an offer that arrives after a restart still finds its quote.

import { randomBytes } from 'node:crypto';

export function makeQuoter({ store, now, params }) {
  const p = params;
  const min = BigInt(p.minAmount), max = BigInt(p.maxAmount), flat = BigInt(p.flatFee ?? 0), bps = BigInt(p.feeBps ?? 0);
  const num = BigInt(p.rate?.num ?? 1), den = BigInt(p.rate?.den ?? 1);

  function price(amount) {
    const a = BigInt(amount);
    if (a < min || a > max) throw Object.assign(new Error(`the amount must be between ${min} and ${max}`), { status: 400 });
    const fee = (a * bps) / 10000n + flat;
    const out = ((a - fee) * num) / den;
    if (a <= fee || out <= 0n) throw Object.assign(new Error('the amount does not cover the fee'), { status: 400 });
    return { btcValue: a, evmAmount: out, fee };
  }

  async function quote(amount) {
    const { btcValue, evmAmount } = price(amount);
    const q = {
      id: randomBytes(16).toString('hex'), btcAsset: p.btcAsset, btcValue: String(btcValue), evmAsset: p.evmAsset, evmAmount: String(evmAmount),
      claimPub: p.claimPub, csvBlocks: p.csvBlocks, evmWindowSecs: p.evmWindowSecs, minConfs: p.minConfsFor(btcValue),
      created: now(), validUntil: now() + (p.validSecs ?? 600),
    };
    await store.put(q);
    return q;
  }
  // the form the Ethereum locker checks an offer against
  const get = async (id) => (/^[0-9a-f]{32}$/.test(String(id)) ? store.get(id) : null);
  return { price, quote, get };
}
