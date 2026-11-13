// What the liquidation keeper says about cUSD loans close to their liquidation line (tools/cdp-liquidation-keeper.mjs, ALERT_ONLY or not).
// Loans are named by the first eight hex digits of their position leaf, which is public on Ethereum and is what the vault page shows beside each
// loan, so a borrower can find theirs without anything linking it to them. Pure: the keeper reads the chain, this decides what to say.
import { fallToLiq, fallText, approaching, loanTag, NEAR_FALL } from '../dapp/btc-borrow.js';

export { loanTag };

const units8 = (v, dp) => {
  const n = BigInt(v), whole = n / 10n ** 8n, frac = (n % 10n ** 8n).toString().padStart(8, '0').slice(0, dp);
  return `${whole.toLocaleString('en-US')}${dp ? `.${frac}` : ''}`;
};
const trim = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

// positions: [{ leaf, debt, sats }]  debt in cUSD base units and sats in cBTC base units (both 8 decimals)
// price: USD per bitcoin, 8 decimals (Chainlink)    liqBps: the engine's liquidation ratio in basis points (13000 = 130%)
// seen: the keys last said, from the plan before; returns { lines, keep } (keep is the next `seen`)
export function boardPlan(positions, { price, liqBps, seen = [] }) {
  const liq = Number(liqBps) / 100, px = BigInt(price);
  const rows = positions.map((p) => {
    const debt = BigInt(p.debt), sats = BigInt(p.sats), usd = sats * px / 10n ** 8n;
    const ratio = debt > 0n ? Number(usd * 10000n / debt) / 100 : null, fall = fallToLiq(ratio, liq);
    return { ...p, debt, sats, ratio, fall, near: fall != null && fall < NEAR_FALL };
  });
  const { tell, keep } = approaching(rows, seen, (x) => String(x.leaf).toLowerCase());
  const at = `$${Math.round(Number(px) / 1e8).toLocaleString('en-US')}`;
  return {
    lines: tell.map((x) => `cUSD loan ${loanTag(x.leaf)}: ${units8(x.debt, 2)} cUSD against ${trim(units8(x.sats, 8))} cBTC, at ${Math.floor(x.ratio)}% against a ${liq}% line. ${x.fall > 0 ? `Bitcoin falling ${fallText(x.fall)} from ${at} liquidates it.` : 'It can be liquidated now.'}`),
    keep,
  };
}
