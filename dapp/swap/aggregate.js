// zQuoter's onchain routes for any token to any token, read the way zSwap reads them: the best single swap or two-hop chain through ETH
// (buildBestSwapViaETHMulticall), a split of the input across two pools (buildSplitSwap) and a mix of a direct swap beside a two-hop one
// (buildHybridSplit), with every pool's own quote (getQuotes) for the summary under the card. (Three hops, build3HopMulticall, takes more
// gas to find than a public node allows a call.) Each answer is held to the terms asked by zrouter-guard (it takes the asked token, pays
// the asked recipient, spends exactly the amount and pays at least its claimed output less the slippage) before it may be offered; the best
// that passes is the route. All of it is views on the chain: nothing here leaves the page.
// by the same paths the page imports them by, so the page holds one copy of each
import { decodeZRouterCall, ZROUTER } from '/zrouter-guard.js?cb=2841d896';
import { ZQUOTER, ZERO, SOURCES, checkRoute } from '/swap/route.js?cb=45fd31f8';

const SEL = { viaEth: 'e453166e', split: '892af013', hybrid: '85f86a90', quotes: 'e1fd10bc' };
const HEAVY = '0x11E1A300';                                          // 300M gas: a split's scan of every pool is far over a default call
const lc = (s) => String(s || '').toLowerCase();
const strip = (h) => String(h || '').replace(/^0x/, '');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addr = (a) => lc(a).replace(/^0x/, '').padStart(64, '0');
const at = (h, i) => BigInt('0x' + (h.slice(i * 64, (i + 1) * 64) || '0'));
const quoteAt = (h, i) => ({ source: Number(at(h, i)), feeBps: at(h, i + 1), amountIn: at(h, i + 2), amountOut: at(h, i + 3) });
const bytesAt = (h, w) => { const o = Number(at(h, w)) / 32, len = Number(at(h, o)); return '0x' + h.slice((o + 1) * 64, (o + 1) * 64 + len * 2); };
const nameOf = (q) => `${SOURCES[q.source] || 'a pool'}${q.feeBps ? ` ${Number(q.feeBps) / 100}%` : ''}`;

// The raw calls inside a zRouter multicall (or the one call that is not), so a permit can go before them in one transaction.
export function legsOf(callData) {
  const h = strip(callData);
  if (h.slice(0, 8) !== 'ac9650d8') return ['0x' + h];
  const b = h.slice(8), o = Number(at(b, 0)) / 32, n = Number(at(b, o)), out = [];
  for (let i = 0; i < n; i++) {
    const rel = Number(at(b, o + 1 + i)) / 32, lenAt = o + 1 + rel, len = Number(at(b, lenAt));
    out.push('0x' + b.slice((lenAt + 1) * 64, (lenAt + 1) * 64 + len * 2));
  }
  return out;
}

const CURVE_UNKNOWN = 'the curve route uses a pool that is not allowed';
const randomAddr = () => '0x' + Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, '0')).join('');
// The one swap run as a call from a fresh address the node is told holds the ETH: what zRouter returns it paid, against the route's floor.
async function paysFloor(ethCall, c, block) {
  const from = randomAddr();
  try {
    let r = strip(await ethCall(ZROUTER, c.callData, block, { from, value: c.value, gas: '0x7A1200', state: { [from]: { balance: '0x' + (c.value + 10n ** 18n).toString(16) } } }));
    if (strip(c.callData).startsWith('ac9650d8')) r = strip(legsOf('0xac9650d8' + r).pop());       // a multicall returns each call's result: the swap's is the last
    return r.length >= 128 && at(r, 1) >= c.min && c.min > 0n;
  } catch { return false; }
}

// One zQuoter answer: null when it reverts (no route of that shape) or cannot be read; `fail` keeps a read that failed, so a quote can say so
// when every read failed rather than that no pool trades the pair.
async function read(ethCall, data, block, fail) {
  try { const r = strip(await ethCall(ZQUOTER, '0x' + data, block, { gas: HEAVY })); return r.length >= 640 ? r : null; }
  catch (e) { if (!(e?.revert || /revert|out of gas|gas required/i.test(e?.message || ''))) fail.push(e); return null; }
}

// The routes the answers hold, each held to the terms: the asked tokens and recipient, exactly the amount, sent exactly the ETH it spends, and paying at least
// what it claims less its slippage. `ok` pass the guard; `unknown` are the single-pool Curve routes it refuses only for a pool it does not list.
function judged({ v, sp, hy }, { to, tokenIn, tokenOut, amt, dl, slip, ethIn }) {
  const cands = [];
  if (v) {
    const a = quoteAt(v, 0), b = quoteAt(v, 4), two = b.amountOut > 0n;
    cands.push({ kind: two ? 'twohop' : 'single', out: two ? b.amountOut : a.amountOut, callData: bytesAt(v, 9), value: at(v, 10), slip, name: two ? `${nameOf(a)} → ${nameOf(b)}` : nameOf(a), legs: [a, ...(two ? [b] : [])] });
  }
  for (const [h, kind] of [[sp, 'split'], [hy, 'hybrid']]) {
    if (!h) continue;
    const l0 = quoteAt(h, 0), l1 = quoteAt(h, 4), both = l0.amountOut > 0n && l1.amountOut > 0n;
    const legs = [l0, l1].filter((l) => l.amountOut > 0n), share = (l) => Number((l.amountIn * 100n) / amt);
    cands.push({ kind: both ? kind : 'single', out: l0.amountOut + l1.amountOut, callData: bytesAt(h, 8), value: at(h, 9), slip, legs,
      name: both ? legs.map((l, i) => `${nameOf(l)}${kind === 'hybrid' && i === 1 ? ' via a hub' : ''} ${share(l)}%`).join(' + ') : nameOf(legs[0] || l0) });
  }
  const ok = [], unknown = [];
  for (const c of cands) {
    if (c.out <= 0n || c.value !== (ethIn ? amt : 0n)) continue;
    let legs;
    try { legs = decodeZRouterCall(c.callData); } catch { continue; }
    // the least it pays: the limits of the swaps that pay the recipient (the one swap, a split's swaps, a chain's last, a mix's direct and last)
    c.min = legs.filter((l) => lc(l.to) === lc(to)).reduce((s, l) => s + l.limit, 0n);
    const want = { to, tokenIn, tokenOut, exactOut: false, amount: amt, maxIn: amt, minOut: (c.out * (10000n - c.slip - 1n)) / 10000n, deadline: dl };
    const why = checkRoute(c.callData, want);
    if (why === null) ok.push(c);
    else if (why === CURVE_UNKNOWN && ethIn && legs.length === 1) unknown.push({ c, want: { ...want, curvePools: legs[0].pools } });
  }
  return { ok, unknown };
}
const bestOf = (routes) => (routes.length ? routes.reduce((x, y) => (y.out > x.out ? y : x)) : null);

// → { out, min, callData, value, name, kind, legs, quotes } for the best route that passes the guard, or null when none does.
//   `to` is paid; `refundTo` gets what a two-hop chain leaves (the payer); `slippageBps` is each leg's own bound, a split's too, so every
//   route's floor is its output less the same slippage and the best output is also the best floor.
//   `onRoute(route)` is told of the best route so far as the scans answer (the scans take 0.3 s to 0.9 s, a split's and a mix's the longest), so a page can show a
//   price at once and the better one when it comes; the route it is told is held to the same terms, and what is returned is still the best of all.
export async function bestRoute({ ethCall, to, refundTo = to, tokenIn, tokenOut, amountIn, slippageBps = 50, deadline, block = 'latest', onRoute = null }) {
  const slip = BigInt(slippageBps);
  const amt = BigInt(amountIn), dl = BigInt(deadline), ethIn = lc(tokenIn) === ZERO;
  const terms = (s) => [addr(to), addr(tokenIn), addr(tokenOut), word(amt), word(s), word(dl)].join('');
  const fail = [], got = {}, T = { to, tokenIn, tokenOut, amt, dl, slip, ethIn };
  const result = (best, quotes) => ({ out: best.out, min: best.min, callData: best.callData, value: best.value, name: best.name, kind: best.kind, legs: best.legs, quotes, tokenIn, tokenOut, amountIn: amt, to, refundTo, deadline: dl, slippageBps: Number(slippageBps), curvePools: best.curvePools || [] });
  let shown = null;
  const early = () => {
    const best = onRoute && bestOf(judged(got, T).ok);
    if (!best || (shown && best.out <= shown.out)) return;
    shown = best;
    try { onRoute(result(best, [])); } catch { }
  };
  const ask = (k, data) => read(ethCall, data, block, fail).then((r) => { got[k] = r; early(); return r; });
  const [v, sp, hy, qs] = await Promise.all([
    ask('v', SEL.viaEth + addr(to) + addr(refundTo) + word(0) + addr(tokenIn) + addr(tokenOut) + word(amt) + word(slip) + word(dl)),
    ask('sp', SEL.split + terms(slip)),
    ask('hy', SEL.hybrid + terms(slip)),
    read(ethCall, SEL.quotes + word(0) + addr(tokenIn) + addr(tokenOut) + word(amt), block, []),
  ]);
  if (!v && !sp && !hy && fail.length >= 3) throw fail[0];
  const { ok, unknown } = judged({ v, sp, hy }, T);
  // a Curve pool the guard does not list is taken as anon.wei takes a route it cannot cross-check: only when the route, run as it stands
  // from an address given the ETH, pays the recipient at least its floor (and only when it beats every route the guard knows)
  const known = ok.reduce((m, c) => (c.out > m ? c.out : m), 0n);
  for (const { c, want } of unknown) if (c.out > known && !ok.some((x) => x.callData === c.callData) && checkRoute(c.callData, want) === null && await paysFloor(ethCall, c, block)) { c.curvePools = want.curvePools; ok.push(c); }
  if (!ok.length) return null;
  const best = bestOf(ok);
  const quotes = [];
  if (qs) {
    const o = Number(at(qs, 4)) / 32, n = Math.min(Number(at(qs, o)), 24);
    for (let i = 0; i < n; i++) { const q = quoteAt(qs, o + 1 + i * 4); if (q.amountOut > 0n) quotes.push({ name: nameOf(q), out: q.amountOut }); }
    quotes.sort((x, y) => (y.out > x.out ? 1 : y.out < x.out ? -1 : 0));
  }
  // `curvePools`: the unlisted Curve pools a simulation let through, for a caller that checks the route again (later.js writes another recipient in)
  return result(best, quotes);
}
