// The Bitcoin side of the borrow page (/vault/#btc): cUSD borrowed against cBTC. Its status board reads the collateral engine in one Multicall3
// call: the collateral a loan needs, the line it is liquidated below, the cUSD lent now and the engine's price of a bitcoin. It imports nothing: the
// page hands it its own batch reader, so nothing more is fetched to show it. The loans themselves are vault/mine.js's, loaded on the holder's press.
export const ENGINE = '0x000000003f608BDdF0ca45934003ffb9DbDF70DB';                 // the collateral engine: prices bitcoin, holds the bonds, lends cUSD
const SEL = { cdpRatioBps: '0x4827ecb3', liqRatioBps: '0x1432d93f', outstandingCusd: '0xa42542c0', btcToUsd: '0xd5901347' };
const BTC1 = (10n ** 8n).toString(16).padStart(64, '0');
const CUSD_DP = 8;

export const engineCalls = () => [{ to: ENGINE, data: SEL.cdpRatioBps }, { to: ENGINE, data: SEL.liqRatioBps }, { to: ENGINE, data: SEL.outstandingCusd }, { to: ENGINE, data: SEL.btcToUsd + BTC1 }];
const word = (h) => (h == null || !/^0x[0-9a-f]{64}/i.test(h) ? null : BigInt(h.slice(0, 66)));
// The ratios in percent, the cUSD out in its smallest unit, a bitcoin's price in dollars; null where a read failed (a price of 0 is none).
export function parseEngine(res) {
  const [r, l, o, u] = (res || []).map(word);
  return { ratio: r == null ? null : Number(r) / 100, liq: l == null ? null : Number(l) / 100, out: o, usdBtc: u ? Number(u) / 1e8 : null };
}
const pct = (x) => (x == null ? '—' : `${x.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`);
const cusd = (v) => (v == null ? '—' : `${(Number(v) / 10 ** CUSD_DP).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} cUSD`);
const usd = (x) => (x == null ? '—' : `$${x.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
// The rows the board shows, in order: [id, text]. `max` is what one bitcoin can borrow at the floor.
export const figures = (e) => [['out', cusd(e.out)], ['ratio', pct(e.ratio)], ['liq', pct(e.liq)], ['px', usd(e.usdBtc)],
  ['max', e.usdBtc != null && e.ratio ? `${Math.floor(e.usdBtc / (e.ratio / 100)).toLocaleString('en-US')} cUSD` : '—']];
// The board's headline: open once the engine answers with its floor and a price, otherwise that it could not be read.
export const verdictOf = (e) => (e.ratio && e.usdBtc ? { on: true, text: 'Borrowing is open' } : { on: false, text: 'Could not read the loans' });

// Fills the board's rows (they are in the page already, so nothing moves when the figures arrive). A failed read leaves a dash and says so in the eyebrow.
export async function loadBtc(root, { batch }) {
  let e;
  try { e = parseEngine(await batch(engineCalls())); } catch { e = parseEngine([]); }
  for (const [k, t] of figures(e)) { const b = root.querySelector(`[data-bf="${k}"]`); if (b) b.textContent = t; }
  const who = root.querySelector('[data-bf-who]');
  if (who) who.textContent = e.out == null && e.ratio == null && e.liq == null ? 'could not be read' : '';
  const v = verdictOf(e);
  const head = root.querySelector('[data-bf-verdict]');
  if (head) { head.className = `verdict ${v.on ? 'on' : 'off'}`; const t = head.querySelector('span'); if (t) t.textContent = v.text; }
  root.querySelectorAll?.('[data-bf-st]').forEach((s) => { s.className = `st${v.on ? ' s-open' : ''}`; const t = s.querySelector('span'); if (t) t.textContent = v.on ? 'Open' : 'Not read'; });
  return e;
}
