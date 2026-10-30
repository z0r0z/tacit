// An order book as a depth chart, for the TAC trade page: resting orders by price on one axis and what they add up to on the other,
// asks climbing to the right of the middle and bids to the left, with the part an amount would fill drawn heavier. SVG only (the page's
// CSP allows no library). Both order books use it: the Bitcoin book's listings and zSwap's boards on Ethereum.
//
// update({ asks, bids, take, priceFmt, sizeFmt, valueFmt, label }):
//   asks / bids: [{ price, size, ...anything }] one entry per order or per level, `size` in TAC (a number), `price` in whatever unit the axis is in
//   take: { side: 'ask' | 'bid', size } the amount an order would fill, highlighted from the best price outward
//   valueFmt: a total in the price's unit (what the orders up to a price come to; default priceFmt)
//   onPick(level, side) is called with the order a click lands on.

import { niceTicks } from '/trade/chart.js?cb=04207026';
import { cumulative } from '/trade/book.js?cb=577d1f94';

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, kids = []) => {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  for (const c of [].concat(kids)) if (c != null) n.append(c);
  return n;
};

export function mountDepth(host, { onPick = null } = {}) {
  let opts = null, size = { w: 0, h: 0 }, tip = null;
  host.classList.add('depth-chart');
  const draw = () => {
    if (!opts || !size.w) return;
    const { asks = [], bids = [], take = null, priceFmt = String, sizeFmt = String, valueFmt = priceFmt, label = 'Order book', empty = 'No orders.' } = opts;
    host.replaceChildren();
    const A = cumulative(asks, 'ask'), B = cumulative(bids, 'bid');
    if (!A.length && !B.length) { host.append(Object.assign(document.createElement('p'), { className: 'chart-empty', textContent: empty })); return; }
    const W = size.w, H = size.h, m = { l: 8, r: 8, t: 10, b: 24 };
    const bestAsk = A[0]?.price ?? null, bestBid = B[0]?.price ?? null;
    const mid = bestAsk != null && bestBid != null ? (bestAsk + bestBid) / 2 : (bestAsk ?? bestBid);
    // The window is where an order is worth looking at: around the middle of the book. A listing at three times the price or a bid at a tenth of it
    // would flatten everything else, so what lies outside is left out of the picture and counted in a line at its corner.
    let lo = mid * 0.6, hi = mid * 1.6;
    if (bestAsk != null && bestBid == null) { lo = bestAsk * 0.85; hi = bestAsk * 1.8; }
    if (bestBid != null && bestAsk == null) { lo = bestBid * 0.55; hi = bestBid * 1.15; }
    lo = Math.min(lo, bestAsk ?? lo, bestBid ?? lo) * 0.97; hi = Math.max(hi, bestAsk ?? hi, bestBid ?? hi) * 1.03;
    const inA = A.filter((s) => s.price <= hi), inB = B.filter((s) => s.price >= lo);
    const far = A.slice(inA.length).reduce((n, s) => n + s.orders.length, 0) + B.slice(inB.length).reduce((n, s) => n + s.orders.length, 0);
    const maxCum = Math.max(1e-9, ...[...inA, ...inB].map((s) => s.cum));
    // One side more than twenty times the other would leave the small side a line on the floor, which hides the orders a seller or buyer
    // would meet first: heights are then a power of the running total, the one that lifts the smaller side to about a fifth of the height (the
    // chart has no height axis; the tooltip gives the figures, and the chart says its heights are not to scale).
    const top = (st) => st.reduce((m, s) => Math.max(m, s.cum), 0), ta = top(inA), tb = top(inB);
    const share = ta > 0 && tb > 0 ? Math.min(ta, tb) / Math.max(ta, tb) : 1;
    const squash = share < 0.05, pow = squash ? Math.max(0.3, Math.log(0.18) / Math.log(share)) : 1;
    // what the picture leaves out or bends is said in a line of its own above the plot, not over it
    const note = [far ? `${far} more beyond range` : '', squash ? 'heights not to scale' : ''].filter(Boolean).join(' · ');
    if (note) m.t = 26;
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const X = (p) => m.l + ((Math.min(Math.max(p, lo), hi) - lo) / (hi - lo)) * pw, Y = (c) => m.t + (1 - Math.pow(Math.min(c, maxCum * 1.05) / (maxCum * 1.05), pow)) * ph;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': label, class: 'chart-svg' });
    for (const v of niceTicks(lo, hi, Math.max(2, Math.round(pw / 120)))) {
      svg.append(el('line', { x1: X(v), x2: X(v), y1: m.t, y2: H - m.b, class: 'grid v' }), el('text', { x: X(v), y: H - 6, class: 'axis mid' }, priceFmt(v)));
    }
    svg.append(el('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'grid' }));
    // each side's staircase as a filled path from the best price outward, to the edge of the window; the part an amount fills is a second,
    // heavier path over it
    const stairs = (steps, side, upto) => {
      const pts = [];
      let prev = 0, k = -1;
      for (const [i, s] of steps.entries()) {
        if (upto != null && prev >= upto) break;
        const c = upto != null ? Math.min(s.cum, upto) : s.cum;
        pts.push([s.price, prev], [s.price, c]);
        prev = c; k = i;
        if (upto != null && c >= upto) break;
      }
      if (!pts.length) return null;
      const first = pts[0], last = pts[pts.length - 1];
      // The shaded part runs on to the next price (the window's edge after the last), as the staircase beneath it does: an amount inside the best
      // order is a band as wide as that order's step, not a line.
      const edge = steps[k + 1]?.price ?? (side === 'ask' ? hi : lo);
      const d = `M${X(first[0])},${Y(0)} ` + pts.map(([p, c]) => `L${X(p)},${Y(c)}`).join(' ') + ` L${X(edge)},${Y(last[1])} L${X(edge)},${Y(0)} Z`;
      return el('path', { d, class: `dep-${side}${upto != null ? ' take' : ''}` });
    };
    if (inA.length) svg.append(stairs(inA, 'ask', null));
    if (inB.length) svg.append(stairs(inB, 'bid', null));
    if (take?.size > 0) { const st = take.side === 'bid' ? inB : inA, f = stairs(st, take.side, take.size); if (f) svg.append(f); }
    if (mid != null) svg.append(el('line', { x1: X(mid), x2: X(mid), y1: m.t, y2: H - m.b, class: 'dep-mid' }));
    if (note) svg.append(el('text', { x: m.l + 4, y: 14, class: 'axis' }, note));
    // hover and click: the order nearest the pointer on the side it is on
    const hit = el('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent', style: 'cursor:pointer' });
    const cross = el('line', { y1: m.t, y2: H - m.b, class: 'cv', visibility: 'hidden', style: 'stroke:var(--mute);stroke-dasharray:3 3' });
    svg.append(cross, hit);
    host.append(svg, tip ||= Object.assign(document.createElement('div'), { className: 'chart-tip', hidden: true }));
    const nearest = (e) => {
      const r = svg.getBoundingClientRect(), p = lo + ((e.clientX - r.left - m.l) / pw) * (hi - lo);
      const side = mid != null && p < mid && B.length ? 'bid' : (A.length ? 'ask' : 'bid'), steps = side === 'ask' ? A : B;
      let best = null;
      for (const s of steps) if (!best || Math.abs(s.price - p) < Math.abs(best.price - p)) best = s;
      return best && { side, step: best };
    };
    hit.addEventListener('pointermove', (e) => {
      const n = nearest(e);
      if (!n) return;
      cross.setAttribute('x1', X(n.step.price)); cross.setAttribute('x2', X(n.step.price)); cross.setAttribute('visibility', 'visible');
      // What a taker gets by going this far into the book: everything from the best price to this one, what it comes to and its average price.
      tip.hidden = false;
      const s = n.step, ask = n.side === 'ask', count = (ask ? A : B).slice(0, (ask ? A : B).indexOf(s) + 1).reduce((k, x) => k + x.orders.length, 0);
      tip.innerHTML = `<b>${ask ? 'Buy' : 'Sell'} ${sizeFmt(s.cum)}</b> ${ask ? 'up' : 'down'} to ${priceFmt(s.price)}${count > 1 ? ` · ${count} orders` : ''}<br><i>${valueFmt(s.value)} in all · average ${priceFmt(s.value / s.cum)}</i>`;
      const tw = tip.offsetWidth || 180;
      tip.style.left = `${Math.max(4, Math.min(W - tw - 4, X(n.step.price) + 10))}px`; tip.style.top = `${m.t + 6}px`;
    });
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; });
    hit.addEventListener('click', (e) => { const n = nearest(e); if (n && onPick) onPick(n.step.orders[0], n.side, n.step); });
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { const r = host.getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height); if (w !== size.w || h !== size.h) { size = { w, h }; draw(); } }) : null;
  ro?.observe(host);
  const r0 = host.getBoundingClientRect(); size = { w: Math.round(r0.width), h: Math.round(r0.height) };
  // The page repaints on every read; a book that has not changed is not drawn again (a pointer over it keeps its place).
  let sig = '';
  const sigOf = (o) => JSON.stringify([o.asks?.map((x) => [x.price, x.size]), o.bids?.map((x) => [x.price, x.size]), o.take, o.empty, o.label, o.priceFmt?.(1), o.sizeFmt?.(1)]);
  return { update(next) { const s = sigOf(next); if (s === sig && opts) return; sig = s; opts = next; draw(); }, destroy() { ro?.disconnect(); host.replaceChildren(); } };
}
