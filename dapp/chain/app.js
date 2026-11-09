// /chain/: the Tacit chain, live, for anyone (no key): whether it is working, what it holds and what a share is worth, its blocks, and what it
// rests on. Read from Ethereum (TacitBlocks, one Multicall3 call), the leader's API and tacit-api's prover board as the page opens, then every 30 s
// while it shows. Each source paints its own part as it answers; nothing waits for the slowest.
import { ETH_NODES } from '/eth-nodes.js';
import { hedgedRpc } from '/trade/rpc.js?cb=e47e943a';
import { MULTICALL3, encodeBatch, decodeBatch } from '/trade/batch.js';
import { tacitChain } from '/tacit-chain-config.js?cb=803c3298';

// a link made for the chain's page before it was this one (a move, #card=…) goes on to TAC's page, where every move is; a link that only
// carries a campaign's tags stays
const TAGS = /^(utm_|fbclid$|gclid$|ref$|s$|t$|cb$)/;
const old = () => location.hash.length > 1 || [...new URLSearchParams(location.search).keys()].some((k) => !TAGS.test(k));
const forward = () => { if (old()) location.replace('/tac/' + location.search + location.hash); };
forward();
addEventListener('hashchange', forward);

const API = 'https://api.tacit.finance';
const SEATS = '0x00000000001f703eae70de3b528213e4802790fb';
const PROVER_SEEN_S = 600, STALL_S = 180, EVERY_MS = 30e3, BEAT_MS = 5e3, SHOWN = 25, UNIT = 100000000n, FLOOR = 200000n;
const cfg = tacitChain();
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rpc = (method, params) => hedgedRpc(ETH_NODES, method, params, { hedgeMs: 1500, timeoutMs: 15e3 });
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const call = async (sel, arg = '') => BigInt(await rpc('eth_call', [{ to: cfg.blocks, data: '0x' + sel + arg }, 'latest']));
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
const addr = (a) => `<a href="https://etherscan.io/address/${esc(a)}#code" target="_blank" rel="noopener noreferrer"><code>${esc(short(a))}</code> ↗</a>`;
// a share's worth in TAC: (pool + 1e8) / (shares + 1e8), the chain's own rate
const price = (pool, shares) => Number((BigInt(pool) + UNIT) * 10n ** 9n / (BigInt(shares) + UNIT)) / 1e9;
const put = (sel, html) => { const el = $(sel); if (el && el.__h !== html) { el.__h = html; el.innerHTML = html; } };   // drawn again only when it changed

// TacitBlocks' selectors: height() lastLanded() pool() shares() queued() queueDone() FORCE_DELAY() WINDOW(), then queuedAt(uint256);
// Multicall3's getBlockNumber() and getCurrentBlockTimestamp() ride in the same call, so every figure is one block's
const SEL = ['0ef26743', '2fb9bbfd', '16f0115b', '03314efa', '16049ddf', '67e41467', 'fbdc9a29', 'a53e5412'];
async function onchain() {
  const calls = [...SEL.map((s) => ({ to: cfg.blocks, data: '0x' + s })), { to: MULTICALL3, data: '0x42cbb15c' }, { to: MULTICALL3, data: '0x0f28c97d' }];
  let v = null;
  try {
    const got = decodeBatch(await rpc('eth_call', [{ to: MULTICALL3, data: encodeBatch(calls) }, 'latest']), calls.length);
    if (got.every(Boolean)) v = got.map(BigInt);
  } catch {}
  if (!v) {                                                         // a node set without Multicall3 (a local fork): one call each
    const head = await rpc('eth_getBlockByNumber', ['latest', false]);
    v = [...(await Promise.all(SEL.map((s) => call(s)))), BigInt(head.number), BigInt(head.timestamp)];
  }
  const [height, last, pool, shares, queued, done, forceDelay, win, n, t] = v;
  const oldest = queued > done ? await call('9ac498de', word(done)).then(Number, () => null) : null;
  return { height: Number(height), last: Number(last), pool, shares, queued: Number(queued), done: Number(done), forceDelay: Number(forceDelay), window: Number(win), oldest, n: Number(n), t: Number(t), at: Date.now() };
}
// The chain's blocks the page has, one per height: the newest twenty /prover/blocks gives on every read, and older ones /prover/rollup gives when asked
// (once in the background when the twenty are not the whole chain, so the chart reaches back, then a page at a time from "Show older blocks").
const HAVE = new Map();
const okBlock = (x) => Number.isInteger(x?.height) && Number.isInteger(x.ethBlock) && /^\d+$/.test(String(x.pool ?? '')) && /^\d+$/.test(String(x.shares ?? ''));
const take = (list) => { for (const x of Array.isArray(list) ? list : []) if (okBlock(x)) HAVE.set(x.height, x); };
const history = () => [...HAVE.values()].sort((a, b) => b.height - a.height);                   // newest first
const lowest = () => { let m = null; for (const h of HAVE.keys()) if (m == null || h < m) m = h; return m; };
// the lowest height the API keeps (null until it has said); older blocks may be asked for while the page's lowest is above it, and above block 1
let floor = null, olderBusy = false, olderErr = false, filled = false;
const mayHaveOlder = () => { const low = lowest(); return low != null && low > 1 && (floor == null || low > floor); };
async function older(n = 100) {
  if (olderBusy || !mayHaveOlder()) return;
  olderBusy = true; olderErr = false; mark();
  const low = lowest();
  try {
    const r = await fetch(`${API}/prover/rollup?before=${low}&limit=${n}`, { signal: AbortSignal.timeout(10e3) });
    if (r.status === 404) floor = low;                                                           // an API without the route: these are the blocks it can show
    else {
      const j = r.ok ? await r.json() : null;
      if (!Array.isArray(j?.rollup) || !Number.isInteger(j.first)) olderErr = true;               // (first null: its store could not be read, which says nothing of what is older)
      else { take(j.rollup); floor = j.rollup.length ? j.first : low; }
    }
  } catch { olderErr = true; }
  olderBusy = false; mark();
}

// what each source last answered: absent while it is unread, null when it could not be read
const R = {}, P = { h: null, since: 0 };
let shown = SHOWN, dirty = false, busy = false, said = null, stale = false;
const mark = () => { if (!dirty) { dirty = true; queueMicrotask(draw); } };
// the chain's own clock: the head's time, moved on by the time since it was read
const nowS = () => (R.chain ? R.chain.t + (Date.now() - R.chain.at) / 1000 : Date.now() / 1000);
// payments waiting are timed by this page (the leader makes a block only when there is one to make, so the quiet since the last block says nothing)
function waiting(state) {
  const p = Number(state?.pending || 0), h = Number(state?.height);
  if (!p) P.since = 0;
  else if (!P.since || h !== P.h) P.since = Date.now();
  P.h = h;
}

const cell = (cls, title, small) => ({ cls, title, small });
function health({ state, board, chain }, now) {
  const out = [], SK = cell('sk', '', '');
  // the leader: answering, and at the contract's height
  if (state === undefined) out.push(SK);
  else if (!state) out.push(cell('bad', 'Leader not answering', chain ? `Anyone may land once ${mins(chain.window)} pass with no block` : 'Read again shortly'));
  else if (chain && Number(state.height) < chain.height) out.push(cell('busy', 'Leader catching up', `at block ${int(state.height)} of ${int(chain.height)}`));
  else out.push(cell('ok', 'Leader answering', `block ${int(state.height)}`));
  const pending = Number(state?.pending || 0), forced = chain ? chain.queued - chain.done : 0;
  // a GPU that proves blocks
  if (board === undefined) out.push(SK);
  else if (!board) out.push(cell('', 'Provers unread', 'Read again shortly'));
  else {
    const n = (board.workers || []).filter((w) => (w.programs || []).includes('tacit-block') && Number(w.lastSeenSeconds) < PROVER_SEEN_S).length;
    out.push(n ? cell('ok', 'Provers ready', `${n} GPU${n === 1 ? '' : 's'} proving blocks, about 35 s a block`) : cell(pending || forced ? 'bad' : 'busy', 'No prover online', '<a href="/prove/">Prove blocks on your GPU</a>'));
  }
  // what waits for the next block
  if (state === undefined) out.push(SK);
  else if (!state) out.push(cell('', 'Payments unread', '—'));
  else if (!pending) out.push(cell('ok', 'Nothing waiting', 'A payment lands in the next block, usually within a minute'));
  else {
    const age = P.since ? (Date.now() - P.since) / 1000 : 0;
    out.push(cell(age > STALL_S ? 'bad' : 'busy', `${pending} payment${pending === 1 ? '' : 's'} waiting`, age > STALL_S ? `waiting ${mins(age)}, no block yet` : 'in the next block'));
  }
  // spends posted to the contract itself, which every block must take in
  if (chain === undefined) out.push(SK);
  else if (!chain) out.push(cell('', 'Queue unread', '—'));
  else if (!forced) out.push(cell('ok', 'Forced queue empty', `Anything posted is taken in within ${mins(chain.forceDelay)}`));
  else {
    const age = chain.oldest != null ? now - chain.oldest : null, by = `taken in within ${mins(chain.forceDelay)}`;
    out.push(cell(age != null && age > chain.forceDelay * 0.75 ? 'bad' : 'busy', `${forced} forced entr${forced === 1 ? 'y' : 'ies'}`, age != null ? `oldest ${mins(age)}, ${by}` : by));
  }
  return out;
}
// the page's one line: the first thing that is not well, else that all is
function verdict(cells) {
  const bad = cells.find((c) => c.cls === 'bad'), busy = cells.find((c) => c.cls === 'busy');
  if (bad) return { s: 'bad', t: bad.title };
  if (busy) return { s: 'busy', t: busy.title };
  if (cells.some((c) => c.cls === 'sk')) return { s: '', t: 'Reading…' };
  if (cells.some((c) => !c.cls)) return { s: '', t: 'Partly read' };
  return { s: 'ok', t: 'Working normally' };
}

function strip({ fee, chain }, now) {
  const rd = (x, f, w) => { if (x === undefined) return sk(w); try { return x === null ? '—' : f(x); } catch { return '—'; } };
  const p = chain ? price(chain.pool, chain.shares) : null;
  const up = p != null && p > 1 ? `+${((p - 1) * 100).toFixed(2)}% since it started` : 'since it started';
  const c = (v, k) => `<div><span class="v num">${v}</span><span class="k">${k}</span></div>`;
  const cu = (key, v, dp, text) => `<span data-k="${key}" data-v="${v}" data-dp="${dp}">${text}</span>`;
  return [
    c(rd(chain, (x) => cu('h', x.height, 0, int(x.height)), '3ch'), 'blocks'),
    c(rd(chain, (x) => (x.height > 0 && x.last > 0 ? `<span data-at="${x.last}">${ago(now - x.last)}</span>` : '—'), '5ch'), 'last block'),
    c(rd(chain, (x) => `${cu('pool', Number(x.pool) / 1e8, 2, tac(x.pool))}<small>TAC</small>`, '6ch'), 'private on the chain'),
    c(rd(chain, () => `${cu('px', p, 5, p.toFixed(5))}<small>TAC</small>`, '6ch'), `1 share · <span class="${p > 1 ? 'ok' : ''}">${up}</span>`),
    c(rd(fee, (x) => (x.fee != null ? `${cu('fee', Number(BigInt(x.fee) + FLOOR) / 1e8, 4, tac(BigInt(x.fee) + FLOOR, 4))}<small>TAC</small>` : '—'), '5ch'), 'a payment now, fees in TAC'),
  ].join('');
}

// what a share was worth after each block, its floor at 1, where every share started; the dots are the blocks, the line is read by pointer
let CH = null, introAt = 0;
const W = 600, H = 150, PAD = 10;
const intro = () => { if (!introAt) introAt = Date.now(); return Date.now() - introAt < 1500 ? ' in' : ''; };   // (the class stays through the animation, so a redraw does not cut it)
function chart(rollup) {
  CH = null;
  if (rollup === undefined) return '<div class="plot sk-plot"></div>';
  const pts = [...rollup].reverse().map((b) => [b.height, price(b.pool, b.shares)]);
  if (pts.length < 2) return '';
  const x0 = pts[0][0], x1 = pts.at(-1)[0], ys = pts.map((q) => q[1]), lo = Math.min(1, ...ys), hi = Math.max(...ys), span = hi - lo || 1e-9;
  const X = (x) => ((x - x0) / (x1 - x0 || 1)) * W, Y = (y) => H - PAD - ((y - lo) / span) * (H - 2 * PAD);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`).join(' ');
  CH = { pts, xs: pts.map(([x]) => X(x) / W), ys: pts.map(([, y]) => Y(y) / H) };
  const dots = pts.length <= 40 ? pts.map((q, i) => `<i class="pt" style="--i:${i};left:${(CH.xs[i] * 100).toFixed(2)}%;top:${(CH.ys[i] * 100).toFixed(2)}%"></i>`).join('') : '';
  return `<figure class="chart"><div class="plot${intro()}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="A share's worth from block ${x0} to block ${x1}, ${pts[0][1].toFixed(5)} to ${pts.at(-1)[1].toFixed(5)} TAC">
    <line class="gd" x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}"/><path class="ar" d="${d} L${W} ${H} L0 ${H} Z"/><path class="ln" d="${d}"/></svg>${dots}
    <span class="yl num">${lo.toFixed(5)}</span><i class="xh" hidden></i><span class="tip num" hidden></span></div>
    <figcaption><span>block ${int(x0)} · ${pts[0][1].toFixed(5)}</span><span>block ${int(x1)} · ${pts.at(-1)[1].toFixed(5)} TAC</span></figcaption></figure>`;
}
function scrub(e) {
  const pl = $('#chart .plot');
  if (!pl || !CH) return;
  const r = pl.getBoundingClientRect(), f = (e.clientX - r.left) / (r.width || 1);
  let i = 0;
  CH.xs.forEach((x, j) => { if (Math.abs(x - f) < Math.abs(CH.xs[i] - f)) i = j; });
  const xh = pl.querySelector('.xh'), tip = pl.querySelector('.tip'), pt = pl.querySelectorAll('.pt');
  xh.hidden = tip.hidden = false;
  xh.style.left = `${(CH.xs[i] * 100).toFixed(2)}%`;
  tip.style.left = `clamp(14%, ${(CH.xs[i] * 100).toFixed(2)}%, 86%)`;
  tip.textContent = `#${int(CH.pts[i][0])} · ${CH.pts[i][1].toFixed(5)}`;
  pt.forEach((p, j) => p.classList.toggle('on', j === i));
}
function unscrub() {
  const pl = $('#chart .plot');
  if (!pl) return;
  pl.querySelectorAll('.xh, .tip').forEach((e) => { e.hidden = true; });
  pl.querySelectorAll('.pt.on').forEach((p) => p.classList.remove('on'));
}

function blocks({ blocks: b, chain }, rollup) {
  if (b === undefined && !rollup.length) return [1, 2, 3].map(() => `<li class="sl">${sk('100%')}</li>`).join('');
  if (b === null && !rollup.length) return '<li class="none"><span class="m">Could not read the blocks. Trying again shortly.</span></li>';
  if (!rollup.length) return '<li class="none"><span class="m">No blocks yet.</span></li>';
  // an Ethereum block's time from the head's, at 12 s a block (the head the contract was read at, else the API's, at this clock)
  const head = chain ? { n: chain.n, t: chain.t + (Date.now() - chain.at) / 1000 } : Number.isInteger(b?.head?.ethHead) ? { n: b.head.ethHead, t: Date.now() / 1000 } : null;
  if (FRESH.h != null && !FRESH.at && rollup[0].height >= FRESH.h) { FRESH.at = Date.now(); setTimeout(mark, 2900); }
  const hd = '<li class="hd" aria-hidden="true"><span>Block</span><span>Landed</span><span class="r">1 share</span><span class="r">Private TAC</span><span></span></li>';
  const rows = rollup.slice(0, shown).map((x) => {
    const at = head ? head.t - Math.max(0, head.n - x.ethBlock) * 12 : null;
    return `<li${fresh(x.height)}><b class="n">#${int(x.height)}</b><span class="a">${at != null ? `<span data-at="${Math.round(at)}">${ago(nowS() - at)}</span>` : '—'}</span><span class="s num" data-l="1 share">${price(x.pool, x.shares).toFixed(5)}</span><span class="p num">${tac(x.pool)} <small>TAC</small></span><span class="x">${tx(x.tx)}</span></li>`;
  });
  return hd + rows.join('');
}

function facts(chain) {
  const w = chain ? mins(chain.window) : '10 min', f = chain ? mins(chain.forceDelay) : '60 min';
  const li = (k, v) => `<li><span>${k}</span><span>${v}</span></li>`;
  return [
    li('Contract', `${addr(cfg.blocks)} verified · no owner, no upgrade key`),
    li('Leader seats', `${addr(SEATS)} · no owner`),
    li('Proofs', 'Ethereum checks each block\'s proof before it lands, so a landed block is final'),
    li('Data', 'Every block\'s data is on Ethereum: anyone can rebuild the chain'),
    li('If the leader stops', `With no block for ${w}, anyone may land the next one`),
    li('If it leaves you out', `Post your payment to the contract: every block must take it in within ${f}`),
  ].join('');
}

// under the table: more of what the page has, or a page of older blocks; and, when the API keeps no older, where the rest is
function more(hist) {
  const low = hist.length ? hist.at(-1).height : null, can = mayHaveOlder(), out = [];
  if (hist.length > shown || can) out.push(`<button class="linkbtn" type="button" data-more${olderBusy ? ' disabled' : ''}>${olderBusy ? 'Loading…' : 'Show older blocks'}</button>`);
  if (olderErr) out.push('<span class="err">Could not load older blocks. Try again.</span>');
  if (!can && floor != null && low != null && low > 1) out.push(`<span class="m">Before #${int(low)}: <a href="https://etherscan.io/address/${esc(cfg.blocks)}#events" target="_blank" rel="noopener noreferrer">the contract's events ↗</a></span>`);
  return out.join('');
}

// The four cells as the path a payment takes: it waits, the leader batches it, a GPU proves the block, Ethereum checks the proof and lands it. A wire between
// two stages carries dots while that hop is moving (quick with a payment on its way, slow when all is quiet) and is dashed while it cannot.
const STAGES = [['Payments', 2], ['Leader', 0], ['Provers', 1], ['Ethereum', 3]];            // [its name, its place in health()'s answer]
const ICON = {
  Payments: '<svg class="tk" aria-hidden="true"><use href="#tk-tac"/></svg>',
  Leader: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
  Provers: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/></svg>',
  Ethereum: '<svg class="tk" aria-hidden="true"><use href="#tk-eth"/></svg>',
};
// 'off': cannot move (down, not read, no prover); 'live': work is in it; 'on': well and quiet
const flowOf = (name, c, pending) => (c.cls === 'sk' || !c.cls || c.cls === 'bad' ? 'off'
  : name === 'Provers' ? (c.cls === 'ok' ? (pending ? 'live' : 'on') : 'off')
  : c.cls === 'busy' ? 'live' : 'on');
const wireOf = (a, b) => (a === 'off' || b === 'off' ? 'off' : a === 'live' || b === 'live' ? 'live' : 'on');
function pipeline(cells, pending) {
  const st = STAGES.map(([name, i]) => ({ name, c: cells[i], f: flowOf(name, cells[i], pending) }));
  return st.map((x, i) => {
    const eb = `<i class="eb">${ICON[x.name]}${x.name}</i>`;
    const card = x.c.cls === 'sk' ? `<div class="st">${eb}<b><span class="sk" style="--w:12ch"></span></b><small><span class="sk" style="--w:16ch"></span></small></div>`
      : `<div class="st ${x.c.cls}${x.name === 'Ethereum' && landedNow() ? ' landed' : ''}">${eb}<b><span class="dot ${x.c.cls}"></span>${x.c.title}</b><small>${x.c.small}</small></div>`;
    return (i ? `<span class="wire ${wireOf(st[i - 1].f, x.f)}" aria-hidden="true"></span>` : '') + card;
  }).join('');
}
// a block has landed: the Ethereum stage glows once, the block's row is lit once, and the page says so
const LAND = { h: null, at: 0 }, FRESH = { h: null, at: 0 };
const landedNow = () => Date.now() - LAND.at < 2600;
const fresh = (h) => (FRESH.at && Date.now() - FRESH.at < 2800 && h === FRESH.h ? ' class="fresh"' : '');
function landing(h) {
  if (LAND.h != null && h > LAND.h) { LAND.at = Date.now(); FRESH.h = h; FRESH.at = 0; setTimeout(mark, 2700); $('#live').textContent = `Block ${int(h)} landed`; }
  LAND.h = h;
}
// the figures count up to what they are, once a read changes them (from nothing, the first time)
const SEEN_N = new Map();
function countUp() {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('#strip [data-k]').forEach((e) => {
    const k = e.dataset.k, to = Number(e.dataset.v), from = SEEN_N.has(k) ? SEEN_N.get(k) : 0, dp = Number(e.dataset.dp);
    SEEN_N.set(k, to);
    if (calm || from === to || !Number.isFinite(to)) return;
    const t0 = performance.now(), f = (v) => v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    const step = (t) => { const p = Math.min(1, (t - t0) / 700); e.textContent = f(from + (to - from) * (1 - (1 - p) ** 3)); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}

// each part is drawn on its own, so one that cannot be (a figure the leader sent wrongly) leaves the rest as they are
const part = (f) => { try { f(); } catch (e) { console.warn('chain page:', e?.message); } };
function draw() {
  dirty = false;
  const now = nowS();
  part(() => {
    const cells = health(R, now), v = verdict(cells), el = $('#verdict');
    put('#health', pipeline(cells, Number(R.state?.pending || 0) > 0));
    el.dataset.s = v.s; el.lastElementChild.textContent = v.t; el.firstElementChild.className = `dot ${v.s}`;
    if (said !== v.t) { said = v.t; if (v.t !== 'Reading…') $('#live').textContent = v.t; }
  });
  part(() => { put('#strip', strip(R, now)); countUp(); });
  const hist = history();
  part(() => put('#chart', chart(R.blocks === undefined && !hist.length ? undefined : hist)));
  part(() => {
    put('#blocks', blocks(R, hist));
    put('#more', more(hist));
    put('#bn', R.chain?.height ? `${int(R.chain.height)} landed` : '');
  });
  part(() => put('#facts', facts(R.chain)));
  tick();
}
// the times and the line saying when it was read move on without another read
function tick() {
  if (document.hidden) return;
  const now = nowS();
  document.querySelectorAll('[data-at]').forEach((e) => { const t = ago(now - Number(e.dataset.at)); if (e.textContent !== t) e.textContent = t; });
  const u = $('#upd');
  if (u && R.at) {
    const s = (Date.now() - R.at) / 1000;
    u.textContent = `Updated ${ago(s)}`;
    u.classList.toggle('stale', s > 2 * EVERY_MS / 1000 + 30 && !document.hidden);
  }
}

// The leader's /state is a few hundred bytes: read every few seconds, so a payment arriving, and the block that takes it, show as they happen; a new block
// brings the full read at once (after the one under way, if there is one).
async function beat() {
  if (document.hidden) return;
  const s = await once(cfg.leader + '/state');
  if (!s) return;                                   // (only a good answer moves anything: the full read is what says the leader is down)
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
  };
  try {
    await Promise.all(Object.entries(src).map(async ([k, f]) => {
      R[k] = await f().catch(() => null);
      if (k === 'state') waiting(R.state);
      if (k === 'chain' && R.chain) landing(R.chain.height);
      if (k === 'blocks') { take(R.blocks?.rollup); if (!filled && HAVE.size >= 20 && mayHaveOlder()) { filled = true; older(); } }   // (twenty is all /prover/blocks gives: a full feed may have more behind it)
      mark();
    }));
    R.at = Date.now();
  } finally { busy = false; mark(); if (stale) { stale = false; refresh(); } }
}

if (!cfg) {
  $('#health').innerHTML = '<div class="st" style="grid-column:1/-1"><b><span class="dot"></span>Not live yet</b><small>The Tacit chain is not deployed here.</small></div>';
  document.querySelectorAll('.grid > section:not(:first-child), #verdict, #upd').forEach((e) => { e.hidden = true; });
} else {
  draw();
  refresh();
  setInterval(refresh, EVERY_MS);
  setInterval(beat, BEAT_MS);
  setInterval(tick, 5e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (R.at || 0) > 20e3) refresh(); });
  $('#chart').addEventListener('pointermove', scrub);
  $('#chart').addEventListener('pointerleave', unscrub);
  $('#more').addEventListener('click', async (e) => {
    if (!e.target.closest('[data-more]')) return;
    shown += SHOWN;
    mark();
    if (HAVE.size < shown) await older();
  });
}
