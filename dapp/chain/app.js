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
const PROVER_SEEN_S = 600, STALL_S = 180, EVERY_MS = 30e3, SHOWN = 25, UNIT = 100000000n, FLOOR = 200000n;
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
// the rollup's blocks, newest first, one per height, each with what the page draws from it
const rollupOf = (b) => {
  const m = new Map();
  for (const x of Array.isArray(b?.rollup) ? b.rollup : []) if (Number.isInteger(x?.height) && Number.isInteger(x.ethBlock) && /^\d+$/.test(String(x.pool ?? '')) && /^\d+$/.test(String(x.shares ?? ''))) m.set(x.height, x);
  return [...m.values()].sort((a, b) => b.height - a.height);
};

// what each source last answered: absent while it is unread, null when it could not be read
const R = {}, P = { h: null, since: 0 };
let shown = SHOWN, dirty = false, busy = false, said = null;
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
  return [
    c(rd(chain, (x) => int(x.height), '3ch'), 'blocks'),
    c(rd(chain, (x) => (x.height > 0 && x.last > 0 ? `<span data-at="${x.last}">${ago(now - x.last)}</span>` : '—'), '5ch'), 'last block'),
    c(rd(chain, (x) => `${tac(x.pool)}<small>TAC</small>`, '6ch'), 'private on the chain'),
    c(rd(chain, () => `${p.toFixed(5)}<small>TAC</small>`, '6ch'), `1 share · <span class="${p > 1 ? 'ok' : ''}">${up}</span>`),
    c(rd(fee, (x) => (x.fee != null ? `${tac(BigInt(x.fee) + FLOOR, 4)}<small>TAC</small>` : '—'), '5ch'), 'a payment now, fees in TAC'),
  ].join('');
}

// what a share was worth after each block, its floor at 1, where every share started; the dots are the blocks, the line is read by pointer
let CH = null;
const W = 600, H = 150, PAD = 10;
function chart(rollup) {
  CH = null;
  if (rollup === undefined) return '<div class="plot sk-plot"></div>';
  const pts = [...rollup].reverse().map((b) => [b.height, price(b.pool, b.shares)]);
  if (pts.length < 2) return '';
  const x0 = pts[0][0], x1 = pts.at(-1)[0], ys = pts.map((q) => q[1]), lo = Math.min(1, ...ys), hi = Math.max(...ys), span = hi - lo || 1e-9;
  const X = (x) => ((x - x0) / (x1 - x0 || 1)) * W, Y = (y) => H - PAD - ((y - lo) / span) * (H - 2 * PAD);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`).join(' ');
  CH = { pts, xs: pts.map(([x]) => X(x) / W), ys: pts.map(([, y]) => Y(y) / H) };
  const dots = pts.length <= 40 ? pts.map((q, i) => `<i class="pt" style="left:${(CH.xs[i] * 100).toFixed(2)}%;top:${(CH.ys[i] * 100).toFixed(2)}%"></i>`).join('') : '';
  return `<figure class="chart"><div class="plot"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="A share's worth from block ${x0} to block ${x1}, ${pts[0][1].toFixed(5)} to ${pts.at(-1)[1].toFixed(5)} TAC">
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

function blocks({ blocks: b, chain }) {
  if (b === undefined) return [1, 2, 3].map(() => `<li class="sl">${sk('100%')}</li>`).join('');
  if (b === null) return '<li class="none"><span class="m">Could not read the blocks. Trying again shortly.</span></li>';
  const rollup = rollupOf(b);
  if (!rollup.length) return '<li class="none"><span class="m">No blocks yet.</span></li>';
  // an Ethereum block's time from the head's, at 12 s a block (the head the contract was read at, else the API's, at this clock)
  const head = chain ? { n: chain.n, t: chain.t + (Date.now() - chain.at) / 1000 } : Number.isInteger(b?.head?.ethHead) ? { n: b.head.ethHead, t: Date.now() / 1000 } : null;
  const hd = '<li class="hd" aria-hidden="true"><span>Block</span><span>Landed</span><span class="r">1 share</span><span class="r">Private TAC</span><span></span></li>';
  const rows = rollup.slice(0, shown).map((x) => {
    const at = head ? head.t - Math.max(0, head.n - x.ethBlock) * 12 : null;
    return `<li><b class="n">#${int(x.height)}</b><span class="a">${at != null ? `<span data-at="${Math.round(at)}">${ago(nowS() - at)}</span>` : '—'}</span><span class="s num" data-l="1 share">${price(x.pool, x.shares).toFixed(5)}</span><span class="p num">${tac(x.pool)} <small>TAC</small></span><span class="x">${tx(x.tx)}</span></li>`;
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

// each part is drawn on its own, so one that cannot be (a figure the leader sent wrongly) leaves the rest as they are
const part = (f) => { try { f(); } catch (e) { console.warn('chain page:', e?.message); } };
function draw() {
  dirty = false;
  const now = nowS();
  part(() => {
    const cells = health(R, now), v = verdict(cells), el = $('#verdict');
    put('#health', cells.map((c) => (c.cls === 'sk' ? '<div><b><span class="sk" style="--w:12ch"></span></b><small><span class="sk" style="--w:16ch"></span></small></div>'
      : `<div class="${c.cls}"><b><span class="dot ${c.cls}"></span>${c.title}</b><small>${c.small}</small></div>`)).join(''));
    el.dataset.s = v.s; el.lastElementChild.textContent = v.t; el.firstElementChild.className = `dot ${v.s}`;
    if (said !== v.t) { said = v.t; if (v.t !== 'Reading…') $('#live').textContent = v.t; }
  });
  part(() => put('#strip', strip(R, now)));
  part(() => put('#chart', chart(R.blocks === undefined ? undefined : rollupOf(R.blocks))));
  part(() => {
    put('#blocks', blocks(R));
    const n = R.blocks ? rollupOf(R.blocks).length : 0;
    put('#more', n > shown ? `<button class="linkbtn" type="button" data-all>Show all ${int(n)} blocks</button>` : '');
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
      mark();
    }));
    R.at = Date.now();
  } finally { busy = false; mark(); }
}

if (!cfg) {
  $('#health').innerHTML = '<div><b><span class="dot"></span>Not live yet</b><small>The Tacit chain is not deployed here.</small></div>';
  document.querySelectorAll('.grid > section:not(:first-child), #verdict, #upd').forEach((e) => { e.hidden = true; });
} else {
  draw();
  refresh();
  setInterval(refresh, EVERY_MS);
  setInterval(tick, 5e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (R.at || 0) > 20e3) refresh(); });
  $('#chart').addEventListener('pointermove', scrub);
  $('#chart').addEventListener('pointerleave', unscrub);
  $('#more').addEventListener('click', (e) => { if (e.target.closest('[data-all]')) { shown = Infinity; mark(); } });
}
