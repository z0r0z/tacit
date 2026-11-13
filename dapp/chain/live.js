// The Tacit chain, live, on TAC's page (anyone, no key): the path a payment takes and whether each step of it works, what the chain holds and what a share
// is worth, its blocks and what it rests on. Read from Ethereum (TacitBlocks and Multicall3's clock, one call), the leader's API and tacit-api; the leader's
// small /state every few seconds while it shows (a payment arriving, the block that takes it), the rest every 30 s and at once when a block lands.
//
//   const live = mountChainLive({ top, rest });   top: the path and the figures, over the card; rest: the chart, the blocks and the facts, under it
//   live.start(); live.stop();                     reads only between the two, and never while the tab is hidden
import { ETH_NODES } from '/eth-nodes.js';
import { hedgedRpc } from '/trade/rpc.js';
import { MULTICALL3, encodeBatch, decodeBatch } from '/trade/batch.js';
import { tacitChain } from '/tacit-chain-config.js?cb=74171404';
import { addrFlat } from '/address-view.js?cb=58dd4914';

const API = 'https://api.tacit.finance';
const SEATS = '0x00000000001f703eae70de3b528213e4802790fb';
// what the deployed contract was made with (immutable there), for the facts a reader checks it against
const VERIFIER = '0xb69f2584cbcff99a58c4e7002e8b89af54a6f4e2', LEADER = '0x841d93ae315e3d9af5fd98c09299ca62148ff65d';
const BLOCK_VKEY = '0x00610fb0fa1b5d800e548c3cdcdf98ceb4288828be1cec1fb81e39004bad6ed6', SPEND_VK = '0xc85febd5ed7a2b00819d90960a17bf686b15d28183c7a207499204bd369bdfe4';
const GH = 'https://github.com/src-company/tacit/';
const TAC_TOKEN = '0xa1313eb9f3a445606d9583bcac3ebeb56a858279';
const PROVER_SEEN_S = 600, STALL_S = 180, EVERY_MS = 30e3, BEAT_MS = 5e3, SHOWN = 10, MORE = 20, UNIT = 100000000n, FLOOR = 200000n;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rpc = (method, params) => hedgedRpc(ETH_NODES, method, params, { hedgeMs: 1500, timeoutMs: 15e3 });
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
// a read that failed is asked once more, so one dropped request is not a red light
const once = (url) => fetch(url, { signal: AbortSignal.timeout(10e3) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const getJson = async (url) => (await once(url)) ?? (await new Promise((r) => setTimeout(r, 1500)), once(url));
const sk = (w) => `<span class="sk" style="--w:${w}"></span>`;
const int = (n) => Number(n).toLocaleString('en-US');
const tac = (units, dp = 2) => (Number(units) / 1e8).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const ago = (s) => (s < 10 ? 'just now' : s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`);
const mins = (s) => `${Math.max(1, Math.round(s / 60))} min`;
const short = (a) => `${a.slice(0, 18)}…`;                       // the contracts' addresses are mined: their start is what tells them apart
const tx = (h) => (/^0x[0-9a-fA-F]{64}$/.test(String(h)) ? `<a href="https://etherscan.io/tx/${h}" target="_blank" rel="noopener noreferrer">tx ↗</a>` : '');
const addr = (a) => `<a href="https://etherscan.io/address/${esc(a)}#code" target="_blank" rel="noopener noreferrer"><code>${addrFlat(a, 0, 18)}</code> ↗</a>`;
const plain = (h) => String(h).replace(/<[^>]*>/g, '');
// a share's worth in TAC: (pool + 1e8) / (shares + 1e8), the chain's own rate
const price = (pool, shares) => Number((BigInt(pool) + UNIT) * 10n ** 9n / (BigInt(shares) + UNIT)) / 1e9;
const okBlock = (x) => Number.isInteger(x?.height) && Number.isInteger(x.ethBlock) && /^\d+$/.test(String(x.pool ?? '')) && /^\d+$/.test(String(x.shares ?? ''));

// The path a payment takes: it waits, the leader batches it, a GPU proves the block, Ethereum checks the proof and lands it
const ICON = {
  Payments: '<svg class="tk" aria-hidden="true"><use href="#tk-tac"/></svg>',
  Leader: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
  Provers: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/></svg>',
  Ethereum: '<svg class="tk" aria-hidden="true"><use href="#tk-eth"/></svg>',
};
// 'off': cannot move (down, not read, no prover); 'live': work is in it; 'on': well and quiet
const flowOf = (c, pending) => (c.cls === 'sk' || !c.cls || c.cls === 'bad' ? 'off' : c.name === 'Provers' ? (c.cls === 'ok' ? (pending ? 'live' : 'on') : 'off') : c.cls === 'busy' ? 'live' : 'on');
const wireOf = (a, b) => (a === 'off' || b === 'off' ? 'off' : a === 'live' || b === 'live' ? 'live' : 'on');

export function mountChainLive({ top, rest }) {
  const cfg = tacitChain();
  top.innerHTML = `<div class="cl-h"><h2 class="cl-name">tacit <em>chain</em></h2><span class="cl-v" data-r="verdict" data-s=""><span class="dot"></span><span>Reading…</span></span><span class="cl-sub" data-r="sub"></span></div>
    <ol class="cl-chain" data-r="chain" aria-label="Latest blocks"></ol><div class="cl-cm"><span data-r="bn"></span><span class="cl-more" data-r="more"></span></div><div class="cl-flow" data-r="flow" aria-live="polite"></div><p class="cl-note" data-r="note"></p><div class="cl-stats" data-r="stats"></div><div class="sr" data-r="live" role="status" aria-live="polite"></div>`;
  rest.innerHTML = `<section class="tpg-panel"><h2 class="tpg-h">A share's worth, block by block</h2><div class="cl-chart" data-r="chart"></div></section>
    <section class="tpg-panel"><h2 class="tpg-h">What it rests on</h2><ul class="cl-facts" data-r="facts"></ul>
      ${cfg && !cfg.dev ? '<details class="tpg-fold cl-tech"><summary>Chain facts</summary><div><ul class="cl-facts" data-r="tech"></ul></div></details><details class="tpg-fold cl-tech"><summary>Lead blocks</summary><div><ul class="cl-facts" data-r="lead"></ul></div></details>' : ''}</section>`;
  const el = (k) => top.querySelector(`[data-r="${k}"]`) || rest.querySelector(`[data-r="${k}"]`);
  const put = (k, html) => { const e = el(k); if (e && e.__h !== html) { e.__h = html; e.innerHTML = html; } };   // drawn again only when it changed
  if (!cfg) { put('flow', '<p class="cl-off">The Tacit chain is not deployed here.</p>'); top.classList.remove('cl-hold'); return { start() {}, stop() {} }; }

  const call = async (sel, arg = '') => BigInt(await rpc('eth_call', [{ to: cfg.blocks, data: '0x' + sel + arg }, 'latest']));
  // TacitBlocks' height() lastLanded() pool() shares() queued() queueDone() FORCE_DELAY() WINDOW(), and Multicall3's getBlockNumber() and getCurrentBlockTimestamp()
  // in the same call, so every figure is one block's; then queuedAt(uint256) when something is queued
  const SEL = ['0ef26743', '2fb9bbfd', '16f0115b', '03314efa', '16049ddf', '67e41467', 'fbdc9a29', 'a53e5412'];
  async function onchain() {
    const calls = [...SEL.map((s) => ({ to: cfg.blocks, data: '0x' + s })), { to: MULTICALL3, data: '0x42cbb15c' }, { to: MULTICALL3, data: '0x0f28c97d' }];
    let v = null;
    try { const got = decodeBatch(await rpc('eth_call', [{ to: MULTICALL3, data: encodeBatch(calls) }, 'latest']), calls.length); if (got.every(Boolean)) v = got.map(BigInt); } catch {}
    if (!v) {                                                     // a node set without Multicall3 (a local fork): one call each
      const head = await rpc('eth_getBlockByNumber', ['latest', false]);
      v = [...(await Promise.all(SEL.map((s) => call(s)))), BigInt(head.number), BigInt(head.timestamp)];
    }
    const [height, last, pool, shares, queued, done, forceDelay, win, n, t] = v;
    const oldest = queued > done ? await call('9ac498de', word(done)).then(Number, () => null) : null;
    return { height: Number(height), last: Number(last), pool, shares, queued: Number(queued), done: Number(done), forceDelay: Number(forceDelay), window: Number(win), oldest, n: Number(n), t: Number(t), at: Date.now() };
  }

  // what each source last answered: absent while unread, null when it could not be read
  const R = {}, P = { h: null, since: 0 }, HAVE = new Map(), LAND = { h: null, at: 0 }, FRESH = { h: null, at: 0 }, SEEN_N = new Map();
  let shown = SHOWN, dirty = false, busy = false, stale = false, said = null, floor = null, olderBusy = false, olderErr = false, filled = false, introAt = 0, CH = null, timers = [];
  const mark = () => { if (!dirty) { dirty = true; queueMicrotask(draw); } };
  const nowS = () => (R.chain ? R.chain.t + (Date.now() - R.chain.at) / 1000 : Date.now() / 1000);   // the chain's clock, moved on since it was read
  const say = (t) => { el('live').textContent = t; };
  // payments waiting are timed here (the leader makes a block only when there is one to make: the quiet since the last block says nothing)
  function waiting(state) {
    const p = Number(state?.pending || 0), h = Number(state?.height);
    if (!p) P.since = 0; else if (!P.since || h !== P.h) P.since = Date.now();
    P.h = h;
  }
  // the blocks the page has, one per height: the newest twenty /prover/blocks gives, and older ones /prover/rollup gives when asked
  const take = (list) => { for (const x of Array.isArray(list) ? list : []) if (okBlock(x)) HAVE.set(x.height, x); };
  const history = () => [...HAVE.values()].sort((a, b) => b.height - a.height);
  const lowest = () => { let m = null; for (const h of HAVE.keys()) if (m == null || h < m) m = h; return m; };
  const mayHaveOlder = () => { const low = lowest(); return low != null && low > 1 && (floor == null || low > floor); };
  async function older(n = 100) {
    if (olderBusy || !mayHaveOlder()) return;
    olderBusy = true; olderErr = false; mark();
    const low = lowest();
    try {
      const r = await fetch(`${API}/prover/rollup?before=${low}&limit=${n}`, { signal: AbortSignal.timeout(10e3) });
      if (r.status === 404) floor = low;                         // an API without the route: these are the blocks it can show
      else { const j = r.ok ? await r.json() : null; if (!Array.isArray(j?.rollup) || !Number.isInteger(j.first)) olderErr = true; else { take(j.rollup); floor = j.rollup.length ? j.first : low; } }
    } catch { olderErr = true; }
    olderBusy = false; mark();
  }
  // the chart wants the chain from its first block: older pages (the API gives a hundred at a time), a few of them, until none is left
  async function fill() { for (let k = 0; k < 3 && mayHaveOlder(); k++) { const had = HAVE.size; await older(); if (olderErr || HAVE.size === had) break; } }
  // a block has landed: Ethereum's step glows once, its row lights once, and the page says so
  const landedNow = () => Date.now() - LAND.at < 2600;
  function landing(h) {
    if (LAND.h != null && h > LAND.h) { LAND.at = Date.now(); FRESH.h = h; FRESH.at = 0; setTimeout(mark, 2700); say(`Block ${int(h)} landed`); }
    LAND.h = h;
  }

  const cell = (name, cls, title, small, brief) => ({ name, cls, title, small, brief });
  function health({ state, board, chain }, now) {
    const pending = Number(state?.pending || 0), forced = chain ? chain.queued - chain.done : 0, SK = (name) => cell(name, 'sk', '', '', '');
    const out = [];
    // what waits for the next block
    if (state === undefined) out.push(SK('Payments'));
    else if (!state) out.push(cell('Payments', '', 'Payments unread', 'Read again shortly', 'unread'));
    else if (!pending) out.push(cell('Payments', 'ok', 'Open for payments', 'Nothing waiting. The next one goes into the next block, usually within a minute', 'open'));
    else {
      const age = P.since ? (Date.now() - P.since) / 1000 : 0, n = `${pending} payment${pending === 1 ? '' : 's'}`;
      out.push(cell('Payments', age > STALL_S ? 'bad' : 'busy', `${n} waiting`, age > STALL_S ? `waiting ${mins(age)}, no block yet` : 'in the next block', age > STALL_S ? `${pending} waiting ${mins(age)}` : `${pending} waiting`));
    }
    // the leader: answering, and at the contract's height
    if (state === undefined) out.push(SK('Leader'));
    else if (!state) out.push(cell('Leader', 'bad', 'Leader not answering', chain ? `Anyone may land once ${mins(chain.window)} pass with no block` : 'Read again shortly', 'not answering'));
    else if (chain && Number(state.height) < chain.height) out.push(cell('Leader', 'busy', 'Leader catching up', `at block ${int(state.height)} of ${int(chain.height)}`, 'catching up'));
    else out.push(cell('Leader', 'ok', 'Leader answering', `block ${int(state.height)}`, 'online'));
    // a GPU that proves blocks
    if (board === undefined) out.push(SK('Provers'));
    else if (!board) out.push(cell('Provers', '', 'Provers unread', 'Read again shortly', 'unread'));
    else {
      const n = (board.workers || []).filter((w) => (w.programs || []).includes('tacit-block') && Number(w.lastSeenSeconds) < PROVER_SEEN_S).length;
      out.push(n ? cell('Provers', 'ok', 'Provers ready', `${n} GPU${n === 1 ? '' : 's'} proving blocks, about 35 s a block`, `${n} GPU${n === 1 ? '' : 's'}`)
        : cell('Provers', pending || forced ? 'bad' : 'busy', 'No prover online', '<a href="/prove/">Prove blocks on your GPU</a>', 'none online'));
    }
    // Ethereum: the last block it took, and anything posted to the contract itself, which every block must take in
    if (chain === undefined) out.push(SK('Ethereum'));
    else if (!chain) out.push(cell('Ethereum', '', 'Ethereum unread', 'Read again shortly', 'unread'));
    else if (!forced) {
      const last = chain.height > 0 && chain.last > 0 ? ago(now - chain.last).replace(' ago', '') : 'no block yet';
      out.push(cell('Ethereum', 'ok', 'Forced queue empty', `${chain.height > 0 && chain.last > 0 ? (last === 'just now' ? 'Last block just now. ' : `Last block ${last} ago. `) : ''}Anything posted is taken in within ${mins(chain.forceDelay)}`, 'verified'));
    } else {
      const age = chain.oldest != null ? now - chain.oldest : null, by = `taken in within ${mins(chain.forceDelay)}`;
      out.push(cell('Ethereum', age != null && age > chain.forceDelay * 0.75 ? 'bad' : 'busy', `${forced} forced entr${forced === 1 ? 'y' : 'ies'}`, age != null ? `oldest ${mins(age)}, ${by}` : by, `${forced} forced`));
    }
    return out;
  }
  // the page's one line: the first thing that is not well, else that all is
  function verdict(cells) {
    const bad = cells.find((c) => c.cls === 'bad'), busyc = cells.find((c) => c.cls === 'busy');
    if (bad) return { s: 'bad', t: bad.title };
    if (busyc) return { s: 'busy', t: busyc.title };
    if (cells.some((c) => c.cls === 'sk')) return { s: '', t: 'Reading…' };
    if (cells.some((c) => !c.cls)) return { s: '', t: 'Partly read' };
    return { s: 'ok', t: 'Working' };
  }
  function flow(cells, pending) {
    const f = cells.map((c) => flowOf(c, pending));
    return cells.map((c, i) => {
      const k = `<i class="cl-ic">${ICON[c.name]}</i><span class="cl-k">${c.name}</span>`;
      const node = c.cls === 'sk' ? `<div class="cl-n">${k}<b>${sk('9ch')}</b></div>`
        : `<div class="cl-n ${c.cls}${c.name === 'Ethereum' && landedNow() ? ' landed' : ''}" title="${esc(`${c.title}. ${plain(c.small)}`)}">${k}<b><span class="dot ${c.cls}"></span><span>${c.brief}</span></b><span class="sr">${esc(c.title)}. ${c.small}</span></div>`;
      return (i ? `<span class="cl-w ${wireOf(f[i - 1], f[i])}" aria-hidden="true"></span>` : '') + node;
    }).join('');
  }
  // what the path says in a line: the first thing that is not well, else that it is ready
  function note(cells) {
    if (cells.some((c) => c.cls === 'sk' || !c.cls)) return '';
    const c = cells.find((x) => x.cls === 'bad') || cells.find((x) => x.cls === 'busy');
    if (c) return `${esc(c.title)} · ${c.small}`;
    return 'Ready for the next payment. It goes into the next block, usually within a minute.';
  }
  function stats({ fee, chain, state }) {
    const rd = (x, f, w) => { if (x === undefined) return sk(w); try { return x === null ? '—' : f(x); } catch { return '—'; } };
    const p = chain ? price(chain.pool, chain.shares) : null;
    const up = p != null && p > 1 ? `<span class="ok">+${((p - 1) * 100).toFixed(2)}%</span>` : 'since block 1';
    const cu = (key, v, dp, text) => `<span data-k="${key}" data-v="${v}" data-dp="${dp}">${text}</span>`;
    const c = (v, k, t = '') => `<div${t ? ` title="${esc(t)}"` : ''}><span class="v num">${v}</span><span class="k">${k}</span></div>`;
    // the notes the pool has made (the leader's own count; amounts and owners are not in it)
    const notes = (x) => (Number.isSafeInteger(x.leaves) && x.leaves >= 0 ? cu('notes', x.leaves, 0, int(x.leaves)) : '—');
    return [
      c(rd(chain, (x) => `${cu('pool', Number(x.pool) / 1e8, 2, tac(x.pool))}<small>TAC</small>`, '6ch'), 'held privately'),
      c(rd(state, notes, '4ch'), 'notes in the pool', 'Notes the pool has made. What each holds, and who, is not shown'),
      c(rd(chain, () => `${cu('px', p, 5, p.toFixed(5))}<small>TAC</small>`, '6ch'), `1 share · ${up}`),
      c(rd(fee, (x) => (x.fee != null ? `${cu('fee', Number(BigInt(x.fee) + FLOOR) / 1e8, 4, tac(BigInt(x.fee) + FLOOR, 4))}<small>TAC</small>` : '—'), '5ch'), 'fee per payment'),
    ].join('');
  }
  // the figures count up to what they are, once a read changes them (from nothing, the first time)
  function countUp() {
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    top.querySelectorAll('[data-k]').forEach((e) => {
      const k = e.dataset.k, to = Number(e.dataset.v), from = SEEN_N.has(k) ? SEEN_N.get(k) : 0, dp = Number(e.dataset.dp);
      SEEN_N.set(k, to);
      if (calm || from === to || !Number.isFinite(to)) return;
      const t0 = performance.now(), f = (v) => v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
      const step = (t) => { const q = Math.min(1, (t - t0) / 700); e.textContent = f(from + (to - from) * (1 - (1 - q) ** 3)); if (q < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  }

  // what a share was worth after each block, its floor at 1; the line is drawn in once, the dots are the blocks, the pointer reads it
  const W = 600, H = 140, PAD = 10;
  const intro = () => { if (!introAt) introAt = Date.now(); return Date.now() - introAt < 1500 ? ' in' : ''; };
  function chart(rollup) {
    CH = null;
    if (rollup === undefined) return '<figure><div class="cl-plot cl-skp"></div><figcaption>&nbsp;</figcaption></figure>';
    const pts = [...rollup].reverse().map((b) => [b.height, price(b.pool, b.shares)]);
    if (pts.length < 2) return pts.length ? `<p class="cl-off">After block ${int(pts[0][0])}, 1 share = ${pts[0][1].toFixed(5)} TAC. It started at 1.</p>` : '';
    const x0 = pts[0][0], x1 = pts.at(-1)[0], ys = pts.map((q) => q[1]), lo = Math.min(1, ...ys), hi = Math.max(...ys), span = hi - lo || 1e-9;
    const X = (x) => ((x - x0) / (x1 - x0 || 1)) * W, Y = (y) => H - PAD - ((y - lo) / span) * (H - 2 * PAD);
    const d = pts.map(([x, y], i) => (i ? `H${X(x).toFixed(1)} V${Y(y).toFixed(1)}` : `M${X(x).toFixed(1)} ${Y(y).toFixed(1)}`)).join(' ');   // a share's worth holds until the next block moves it
    CH = { pts, xs: pts.map(([x]) => X(x) / W), ys: pts.map(([, y]) => Y(y) / H) };
    const few = pts.length <= 40, from = few ? 0 : pts.length - 1;       // a dot for every block while they are few, else only the newest
    const dots = pts.slice(from).map((q, k) => { const i = from + k; return `<i class="pt${i === pts.length - 1 ? ' last' : ''}" data-i="${i}" style="--i:${few ? i : 0};left:${(CH.xs[i] * 100).toFixed(2)}%;top:${(CH.ys[i] * 100).toFixed(2)}%"></i>`; }).join('');
    return `<figure><div class="cl-plot${intro()}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="A share's worth from block ${x0} to block ${x1}, ${pts[0][1].toFixed(5)} to ${pts.at(-1)[1].toFixed(5)} TAC">
      <line class="gd" x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}"/><path class="ar" d="${d} L${W} ${H} L0 ${H} Z"/><path class="ln" d="${d}"/></svg>${dots}
      <span class="yl num">${lo.toFixed(5)}</span><i class="xh" hidden></i><span class="tip num" hidden></span></div>
      <figcaption><span>block ${int(x0)} · ${pts[0][1].toFixed(5)}</span><span>block ${int(x1)} · ${pts.at(-1)[1].toFixed(5)} TAC</span></figcaption></figure>`;
  }
  function scrub(e) {
    const pl = rest.querySelector('.cl-plot');
    if (!pl || !CH) return;
    const r = pl.getBoundingClientRect(), f = (e.clientX - r.left) / (r.width || 1);
    let i = 0;
    CH.xs.forEach((x, j) => { if (Math.abs(x - f) < Math.abs(CH.xs[i] - f)) i = j; });
    const xh = pl.querySelector('.xh'), tip = pl.querySelector('.tip');
    xh.hidden = tip.hidden = false;
    xh.style.left = `${(CH.xs[i] * 100).toFixed(2)}%`;
    tip.style.left = `clamp(14%, ${(CH.xs[i] * 100).toFixed(2)}%, 86%)`;
    tip.textContent = `#${int(CH.pts[i][0])} · ${CH.pts[i][1].toFixed(5)}`;
    pl.querySelectorAll('.pt').forEach((p) => p.classList.toggle('on', Number(p.dataset.i) === i));
  }
  function unscrub() {
    const pl = rest.querySelector('.cl-plot');
    if (!pl) return;
    pl.querySelectorAll('.xh, .tip').forEach((x) => { x.hidden = true; });
    pl.querySelectorAll('.pt.on').forEach((p) => p.classList.remove('on'));
  }


  // the newest blocks as a chain, newest first in the markup and drawn right to left, so a narrow screen keeps the newest in view; a block that just landed slides in
  function links({ chain, state }, hist) {
    if (FRESH.h != null && !FRESH.at && hist.length && hist[0].height >= FRESH.h) { FRESH.at = Date.now(); setTimeout(mark, 2900); }
    if (!hist.length) return [1, 2, 3, 4, 5, 6].map(() => '<li class="sl"><span></span></li>').join('');
    const head = chain ? { n: chain.n, t: chain.t + (Date.now() - chain.at) / 1000 } : null, lit = FRESH.h != null && LAND.at && Date.now() - LAND.at < 2600;
    // payments waiting: the next block, forming, dashed at the right until it lands
    const top = Math.max(hist[0].height, chain?.height || 0), next = Number(state?.pending || 0) > 0 && Number(state?.height) <= top
      ? `<li class="nx" title="Block ${int(top + 1)}, forming"><span><b class="num">#${int(top + 1)}</b><small>forming</small></span></li>` : '';
    return next + hist.slice(0, shown).map((x, i) => {
      const at = head ? head.t - Math.max(0, head.n - x.ethBlock) * 12 : null, cls = (i ? '' : 'hd') + (!i && lit && x.height === FRESH.h ? ' in' : '');
      const age = at != null ? `<small data-at="${Math.round(at)}">${ago(nowS() - at)}</small>` : '';
      const ok = /^0x[0-9a-fA-F]{64}$/.test(String(x.tx));
      const body = `<b class="num">#${int(x.height)}</b>${i ? '' : age}`;
      return `<li${cls ? ` class="${cls.trim()}"` : ''}>${ok ? `<a href="https://etherscan.io/tx/${x.tx}" target="_blank" rel="noopener noreferrer" title="Block ${int(x.height)} on Etherscan">${body}</a>` : `<span>${body}</span>`}</li>`;
    }).join('');
  }
  // beside the block row: more of what the page has, or a page of older blocks; and, when the API keeps no older, where the rest is
  function more(hist) {
    const low = hist.length ? hist.at(-1).height : null, can = mayHaveOlder(), out = [];
    if (hist.length > shown || can) out.push(`<button class="link" type="button" data-more${olderBusy ? ' disabled' : ''}>${olderBusy ? 'Loading…' : 'Show older blocks'}</button>`);
    if (olderErr) out.push('<span class="err">Could not load older blocks. Try again.</span>');
    if (!can && floor != null && low != null && low > 1) out.push(`<span>Before #${int(low)}: <a href="https://etherscan.io/address/${esc(cfg.blocks)}#events" target="_blank" rel="noopener noreferrer">the contract's events ↗</a></span>`);
    return out.join('');
  }
  function facts(chain) {
    const w = chain ? mins(chain.window) : '10 min', f = chain ? mins(chain.forceDelay) : '60 min';
    const li = (k, v) => `<li><span>${k}</span><span>${v}</span></li>`;
    return [
      li('Contract', `${addr(cfg.blocks)} · verified, no owner, no upgrade key`),
      li('Leader seats', `${addr(SEATS)} · no owner`),
      li('Proofs', 'Every block proven on Ethereum'),
      li('Data', 'On Ethereum: anyone can rebuild'),
      li('Leader stops', `${w} → anyone may land`),
      li('If you\'re left out', `Forced inclusion within ${f}`),
      li('Docs', '<a href="/docs/chain/">How it works</a>'),
    ].join('');
  }

  // who may lead and what it takes: the seat's price, the seats held, who leads now, the steps (the seats contract's own calls, on Etherscan)
  async function leadRead() {
    const calls = ['d1b17078', 'd4005c4a', '9c5655d6', '40eedabb'].map((s) => ({ to: SEATS, data: '0x' + s }));
    let got = null;
    try { got = decodeBatch(await rpc('eth_call', [{ to: MULTICALL3, data: encodeBatch(calls) }, 'latest']), calls.length); } catch {}
    const [seat, slot, held, lead] = got?.every(Boolean) ? got : await Promise.all(calls.map((c) => rpc('eth_call', [c, 'latest'])));
    return { seat: BigInt(seat), slot: Number(BigInt(slot)), held: Number(BigInt(held)), leader: '0x' + String(lead).slice(26) };
  }
  function lead(d) {
    if (!d) return '';
    const li = (k, v) => `<li><span>${k}</span><span>${v}</span></li>`;
    const w = (a, t) => `<a href="https://etherscan.io/address/${a}#writeContract" target="_blank" rel="noopener noreferrer">${t} ↗</a>`;
    const seat = `${(Number(d.seat / 10n ** 15n) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} TAC`;
    return [
      li('Seat', `${seat} locked, back 7 days after you leave`),
      li('Held', d.held ? `${int(d.held)} seat${d.held === 1 ? '' : 's'}` : 'None yet: open'),
      li('Leads now', `${addr(d.leader)}${d.held ? '' : ' · leads while no seat is held'}`),
      li('Slots', `${int(d.slot)} blocks (about ${Math.max(1, Math.round(d.slot * 12 / 60))} min), 16 to an epoch. Each seat leads its share`),
      li('Take one', `${w(TAC_TOKEN, 'Approve TAC')} to the seats contract, then ${w(SEATS, 'join()')}. ${w(SEATS, 'leave(i)')} and claim() give it back`),
      li('Then', `Run the node and leader (<a href="${GH}tree/main/tacit-leader" target="_blank" rel="noopener noreferrer">the guide ↗</a>) and call announce(url) with where your node takes spends`),
    ].join('');
  }

  // what a reader checks the chain against: its verifier and keys, where its data is, how to rebuild it, who may land and prove, how to leave
  function tech(chain) {
    const a = (path, t) => `<a href="${GH}${path}" target="_blank" rel="noopener noreferrer">${t} ↗</a>`;
    const li = (k, v) => `<li><span>${k}</span><span>${v}</span></li>`;
    return [
      li('Verifier', `${addr(VERIFIER)} · fixed, checks each block's proof`),
      li('Keys', `<code>${BLOCK_VKEY}</code> block program<br><code>${SPEND_VK}</code> spend`),
      li('Published', 'Each block\'s notes, memos and nullifiers are in its call data, checked against hashes its proof commits'),
      li('Rebuild', `${a('blob/main/docs/TACIT-BLOCKS.md', 'The spec')} · ${a('tree/main/contracts/sp1/confidential/tacit-block/node', 'The node')} · ${a('tree/main/tacit-leader', 'The leader')}`),
      li('Landing', `${addr(LEADER)} leads while no seat is held. Seats are open to anyone who locks TAC`),
      li('Provers', 'Open to any machine: the verifier checks the proof, not who made it. The Tacit board runs one today'),
      li('Exits', 'A withdrawal is paid out by the contract, and anyone may send the payout. A deposit no block takes in returns after 7 days'),
    ].join('');
  }

  // each part is drawn on its own, so one that cannot be (a figure the leader sent wrongly) leaves the rest as they are
  const part = (f) => { try { f(); } catch (e) { console.warn('chain live:', e?.message); } };
  function draw() {
    dirty = false;
    const now = nowS();
    part(() => {
      const hc = health(R, now), v = verdict(hc), e = el('verdict');
      put('flow', flow(hc, Number(R.state?.pending || 0) > 0));
      e.dataset.s = v.s; e.lastElementChild.textContent = v.t; e.firstElementChild.className = `dot ${v.s}`;
      if (said !== v.t) { said = v.t; if (v.t !== 'Reading…') say(v.t); }
    });
    part(() => put('sub', R.chain ? `block ${int(R.chain.height)}` : ''));
    part(() => put('note', note(health(R, now))));
    part(() => { put('stats', stats(R)); countUp(); });
    const hist = history();
    part(() => put('chart', chart(R.blocks === undefined && !hist.length ? undefined : hist)));
    part(() => { put('more', more(hist)); put('bn', R.chain?.height ? `${int(R.chain.height)} blocks, each proven` : ''); });
    part(() => put('facts', facts(R.chain)));
    part(() => { if (el('tech')) put('tech', tech(R.chain)); });
    part(() => { if (el('lead')) put('lead', lead(R.lead)); });
    part(() => put('chain', links(R, hist)));
    tick();
  }
  // the times move on without another read; a page whose reads have stopped says so
  function tick() {
    if (document.hidden) return;
    const now = nowS();
    for (const root of [top, rest]) root.querySelectorAll('[data-at]').forEach((e) => { const t = ago(now - Number(e.dataset.at)); if (e.textContent !== t) e.textContent = t; });
    el('sub').classList.toggle('stale', !!R.at && Date.now() - R.at > 2 * EVERY_MS + 30e3);
  }
  // the leader's /state is a few hundred bytes: read every few seconds; a new block brings the full read at once (after the one under way, if any)
  async function beat() {
    if (document.hidden) return;
    const s = await once(cfg.leader + '/state');
    if (!s) return;                                     // (only a good answer moves anything: the full read is what says the leader is down)
    const was = Number(R.state?.height);
    R.state = s; waiting(s); mark();
    if (Number(s.height) > was) { if (busy) stale = true; else refresh(); }
  }
  async function refresh() {
    if (busy || document.hidden) return;
    busy = true;
    const src = {
      state: () => getJson(cfg.leader + '/state'), fee: () => getJson(cfg.leader + '/fee'),
      blocks: () => getJson(API + '/prover/blocks'), board: () => getJson(API + '/prover/board'), chain: () => onchain(),
      ...(cfg.dev ? {} : { lead: () => leadRead() }),
    };
    try {
      await Promise.all(Object.entries(src).map(async ([k, f]) => {
        R[k] = await f().catch(() => null);
        if (k === 'state') waiting(R.state);
        if (k === 'chain' && R.chain) landing(R.chain.height);
        if (k === 'blocks') { take(R.blocks?.rollup); if (!filled && HAVE.size >= 20 && mayHaveOlder()) { filled = true; fill(); } }   // (twenty is all /prover/blocks gives)
        mark();
      }));
      R.at = Date.now();
    } finally { busy = false; if (R.at) top.classList.remove('cl-hold'); mark(); if (stale) { stale = false; refresh(); } }
  }
  const onVis = () => { if (!document.hidden && Date.now() - (R.at || 0) > 20e3) refresh(); };
  rest.addEventListener('pointermove', (e) => { if (e.target.closest?.('.cl-plot')) scrub(e); });
  rest.addEventListener('pointerleave', unscrub);
  rest.addEventListener('pointerout', (e) => { if (e.target.closest?.('.cl-plot') && !e.relatedTarget?.closest?.('.cl-plot')) unscrub(); });
  top.addEventListener('click', async (e) => { if (!e.target.closest?.('[data-more]')) return; shown += MORE; mark(); if (HAVE.size < shown) await older(); });
  draw();
  return {
    start() {
      if (timers.length) return;
      timers = [setInterval(refresh, EVERY_MS), setInterval(beat, BEAT_MS), setInterval(tick, 5e3)];
      document.addEventListener('visibilitychange', onVis);
      if (Date.now() - (R.at || 0) > 20e3) refresh(); else mark();
    },
    stop() { timers.forEach(clearInterval); timers = []; document.removeEventListener('visibilitychange', onVis); },
  };
}
