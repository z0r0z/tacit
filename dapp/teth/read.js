// What the tETH page reads, and how each figure on it is worked out: the Tacit pool's totals and its ETH history (the API's stats reading), the
// private farms and the prices in the pools that pair tETH (the farming program's reading), the dollar rates (Chainlink) and TAC's price (the
// Precision pool), and the relay's quote for a wrap. The arithmetic is plain functions of what was read, so tests can pin it.
import { MULTICALL3, PRECISION_POOL, _internal } from '/evm-trade-venues.js?cb=10858cc2';
import { api, ethCall, wordAt, now, E10 } from '/trade/util.js?cb=dcf3a4f2';
import { poolWorthEth, shieldedApr } from '/trade/farm-read.js?cb=112a01b9';

export const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';              // the Tacit pool (one contract): it holds the ETH behind every tETH
export const WRAP_TIP = '0x000000D218B03db5837943b0b05DeA2965AE956e';           // wraps and pays the relay's tip in one transaction
export const WRAP_WITH_TIP = '0xfc24c435';                                     // wrapWithTip(bytes32 commit, uint256 amount, address tipTo)
export const CETH_ID = '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const CHAINLINK = { ethUsd: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', btcUsd: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c' };   // 8 decimals

const big = (x) => BigInt(x != null && typeof x === 'object' && '$n' in x ? x.$n : x ?? 0);
const eth = (wei) => Number(wei) / 1e18;

// ── the pool's totals and its ETH history ──
// `j` is the API's /stats reading (amounts come as { $n: "…" }). The short view (?view=front) has no `flows`; the pool's own view (?view=eth, about 6 KB, where the whole reading is 176 KB) has every movement.
export function poolOf(j) {
  const e = j?.eth;
  if (!e) return null;
  const flows = Array.isArray(e.series?.flows) ? e.series.flows.map(([t, v]) => [Number(t), big(v)]).filter(([t]) => Number.isFinite(t) && t > 0).sort((a, b) => a[0] - b[0]) : null;
  return { held: big(e.held), inWei: big(e.inWei), outWei: big(e.outWei), deposits: Number(e.deposits) || 0, wallets: Number(e.wallets) || 0, lastAt: Number(e.lastAt) || null, flows };
}
export const readPool = async (whole = false) => poolOf(await api(`/stats?network=mainnet&view=${whole ? 'eth' : 'front'}`));

// The ETH the pool has held at the end of each movement: the running sum of the flows. The reading's own total (`held`) is the pool's balance now,
// so a history that does not end on it (a movement the reading missed) is said not to, and its last point is the balance.
export function heldHistory(flows, heldNow) {
  let sum = 0n;
  const pts = (flows || []).map(([t, v]) => { sum += v; return { t, held: sum, move: v }; });
  return { pts, exact: heldNow == null || sum === heldNow };
}

// Bars of what is held (ETH unless `scale` says otherwise: 1e8 for sats or cUSD), `tf` seconds each, from `since` on: a bar closes at what the pool held at its end, a quiet one holds the figure before it,
// the range opens at what was held then (`seed`), and the last bar closes at the balance now (`spot`). `vol` is the ETH that moved in the bar.
export function heldBars(pts, { tf, since = 0, spot = null, at = now(), scale = 1e18 }) {
  if (!pts.length) return [];
  const from = Math.floor((since || pts[0].t) / tf) * tf, end = Math.floor(at / tf) * tf;
  if (end < from || (end - from) / tf > 2000) return [];
  const eth = (x) => Number(x) / scale;                                                        // ETH by default; a series in sats or cUSD says its own scale
  let i = 0, held = 0n;
  while (i < pts.length && pts[i].t < from) held = pts[i++].held;
  const out = [];
  for (let t = from, prev = eth(held); t <= end; t += tf) {
    let hi = prev, lo = prev, close = prev, vol = 0, n = 0;
    for (; i < pts.length && pts[i].t < t + tf; i++) { close = eth(pts[i].held); hi = Math.max(hi, close); lo = Math.min(lo, close); vol += Math.abs(eth(pts[i].move)); n++; }
    out.push({ t, open: prev, high: hi, low: lo, close, vol, n, ...(n ? {} : { held: true }) });
    prev = close;
  }
  if (spot != null && out.length) { const l = out.at(-1), s = eth(spot); out[out.length - 1] = { ...l, close: s, high: Math.max(l.high, s), low: Math.min(l.low, s), live: true }; }
  return out;
}

// The ranges worth offering for a history `span` days long: only those that draw something other than the whole of it, and All.
const RANGE_SET = [['1D', 1], ['1W', 7], ['1M', 30], ['3M', 90]];
export const rangesFor = (span) => [...(span ? RANGE_SET.filter(([, d]) => d < span) : RANGE_SET.slice(0, 2)), ['All', 0]];
export const barSize = (range, span) => (range === 1 ? 3600 : range === 7 ? 14400 : (range || span) <= 45 ? 14400 : 86400);

// The newest movements, each as ETH in or out of the pool.
export const recentMoves = (pts, n = 10) => pts.slice(-n).reverse().map((p) => ({ t: p.t, wei: p.move }));
// What moved in the last `secs`: { in, out } in wei.
export function movedSince(pts, secs, at = now()) {
  let inn = 0n, out = 0n;
  for (const p of pts) if (p.t >= at - secs) { if (p.move > 0n) inn += p.move; else out -= p.move; }
  return { in: inn, out };
}

// ── the dollar rates and TAC's price ──
export async function readRates() {
  const calls = [{ to: CHAINLINK.ethUsd, data: '0xfeaf968c' }, { to: CHAINLINK.btcUsd, data: '0xfeaf968c' }, { to: PRECISION_POOL, data: '0x2af1f249' }];
  const r = _internal.decAggregate3(await ethCall(MULTICALL3, _internal.encAggregate3(calls)), calls.length);
  const fresh = (x) => (x && wordAt(x, 3) > BigInt(now() - 6 * 3600) && wordAt(x, 1) > 0n ? Number(wordAt(x, 1)) / 1e8 : null);   // a feed that has not answered in six hours is not a price
  const root = r[2] ? Number(wordAt(r[2], 0)) / 1e18 : 0;
  return { ethUsd: fresh(r[0]), btcUsd: fresh(r[1]), tacEth: root > 0 ? 1 / (root * root) : null };                              // the pool's price is a square root of TAC per ETH
}

// ── the private farms and the pools that pair tETH ──
export const readProgram = () => api('/farm/program?network=mainnet');
const OTHER = { TAC: { dec: 8 }, cUSD: { dec: 8 }, cBTC: { dec: 8 } };
export const shown = (t) => (t === 'cETH' ? 'tETH' : t);
// Each pool of the program that pairs tETH, with what it pays, what that earns on what is bonded, how deep it is and what one tETH costs in it.
// Notes carry 8 decimals, so the reserves' ratio is the price. What a pool holds and what its APR is over are worked out once, by farm-read.js
// (what both sides are worth, each at its own price), so the front page, the rewards and swap pages and this one read the same. `usd` is what
// the pool says a tETH is worth, with cUSD counted as a dollar; `gap` how far that is from ETH's price. `bondedPct` is the share of the pool's
// liquidity that is in the farm. `worthUsd` is what both sides are worth now and `depthEth` the same in ETH.
export function poolRows(program, { tacEth = null, ethUsd = null, btcUsd = null } = {}) {
  const live = !!program?.epoch?.active;
  return (program?.pools || []).map((p) => {
    const r = p.reserves || {}, [a, b] = String(p.pair || '').split('/'), other = a === 'cETH' ? b : a;
    if (!OTHER[other] || String(r.assetA).toLowerCase() !== CETH_ID) return null;
    const rA = Number(r.reserveA), rB = Number(r.reserveB), total = Number(r.lpTotalShares);
    const per = rA > 0 ? rB / rA : null;                                                                       // OTHER per tETH
    const perDay = live ? Number(p.tacPerDayForPool) || 0 : 0;
    const unit = other === 'TAC' ? (tacEth && ethUsd ? tacEth * ethUsd : null) : other === 'cUSD' ? 1 : (btcUsd || null);                  // dollars in one of the other side
    const usd = per == null || unit == null ? null : per * unit;
    const worthEth = poolWorthEth(p, tacEth, { ethUsd, btcUsd });
    return { pid: Number(p.pid), other, name: `tETH / ${other}`, perDay, apr: perDay > 0 ? shieldedApr(p, tacEth, { ethUsd, btcUsd }) : null,
      worthUsd: ethUsd ? worthEth * ethUsd : null, depthEth: worthEth, tethSide: rA / 1e8, otherSide: rB / 1e8, bondedPct: total > 0 ? Number(p.totalShares) / total : null, per, usd, gap: usd != null && ethUsd ? usd / ethUsd - 1 : null,
      shares: Number(p.totalShares) || 0, lpTotal: total, rA, rB };
  }).filter(Boolean).sort((x, y) => x.pid - y.pid);
}
// What a key's farm positions (from its scan: pid, shares, pendingTac, unlockAt) are worth and earn in each row's pool: the two sides they
// are a share of, the TAC waiting to be harvested, and about what they earn a day. Positions of a pool this page does not list are left out.
export function positionsIn(rows, positions) {
  const by = new Map();
  for (const pos of positions || []) {
    const row = rows.find((r) => r.pid === Number(pos.pid));
    if (!row || !(row.lpTotal > 0)) continue;
    const sh = Number(pos.shares), cur = by.get(row.pid) || { n: 0, teth: 0, other: 0, earned: 0, perDay: 0, locked: 0 };
    cur.n++; cur.teth += sh * row.rA / row.lpTotal / 1e8; cur.other += sh * row.rB / row.lpTotal / 1e8; cur.earned += Number(pos.pendingTac) || 0;
    cur.perDay += row.shares > 0 ? row.perDay * sh / row.shares : 0;
    cur.locked = Math.max(cur.locked, Number(pos.unlockAt) || 0);
    by.set(row.pid, cur);
  }
  return by;
}
export const programEnds = (program) => (program?.epoch?.active ? Number(program.epoch.periodFinish) || null : null);

// ── a wrap's quote ──
// The relay's tip for a wrap (paid in the same transaction), whom it goes to, and the floor fee a later send or unwrap of a note costs. The API
// is not trusted with the money: the tip goes only to Tacit's ops address (the one the quote has always named, and the one an integrator is told
// to hold it to), a quote with no tip is not a tip of nothing, and one that asks for more than a twentieth of the deposit is refused (the API's
// own ceiling is 3%).
export const RELAY_TIP_TO = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
// The splitter that forwards tips on to the wallets that run the relay and to the buyback; the quote names it as `tipSplitter`, and only this
// address is accepted for it. Anything else the API names is refused, as before.
export const RELAY_TIP_SPLITTER = '0xf5eBBE5Db610F64D29A0dC5e9534074Af12834F9';
export const TIP_CEILING_BPS = 500n;
export async function wrapQuote(wei) {
  const j = await api(`/confidential/quote?asset=cETH&amountWei=${wei}`);
  if (!j) throw new Error('The relay could not quote. Try again in a moment.');
  if (!/^\d+$/.test(String(j.recommendedWrapTipWei ?? ''))) throw new Error('The relay did not give a tip for this deposit. Try again in a moment.');
  const to = j.tipSplitter || j.recommendedTipRecipient, tip = BigInt(j.recommendedWrapTipWei);
  const known = [RELAY_TIP_TO, RELAY_TIP_SPLITTER].find((a) => a.toLowerCase() === String(to || '').toLowerCase());
  if (!known) throw new Error('The relay named a tip address this page does not know, so nothing will be sent. Try again, or use tacit.finance.');
  if (tip * 10000n > BigInt(wei) * TIP_CEILING_BPS) throw new Error('The relay asked for more than 5% of this deposit as its tip, so nothing will be sent. A larger deposit pays a smaller share.');
  // What the relay asks for a proof alone (the wallet then sends the settle): never more than the full tip, which it stands in for.
  const proveTip = /^\d+$/.test(String(j.recommendedProveTipWei ?? '')) && BigInt(j.recommendedProveTipWei) <= tip ? BigInt(j.recommendedProveTipWei) : tip;
  return { tip, proveTip, to: known, floor: BigInt(j.gasAwareFloorUnits || j.staticFloorUnits || 0) * E10 };
}
