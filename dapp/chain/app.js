// /chain/: the Tacit chain, live, for anyone (no key): whether it is working, what it holds and what a share is worth, its blocks, and what it
// rests on. Read from Ethereum (TacitBlocks), the leader's API and tacit-api's prover board as the page opens, then every 30 s while it shows.
import { ETH_NODES } from '/eth-nodes.js?cb=1769d5d4';
import { hedgedRpc } from '/trade/rpc.js?cb=e47e943a';
import { tacitChain } from '/tacit-chain-config.js?cb=803c3298';

// a link made for the chain's page before it was this one (a move, #card=…) goes on to TAC's page, where every move is
const forward = () => { if (location.hash.length > 1 || location.search) location.replace('/tac/' + location.search + location.hash); };
forward();
addEventListener('hashchange', forward);

const API = 'https://api.tacit.finance';
const SEATS = '0x00000000001f703eae70de3b528213e4802790fb';
const PROVER_SEEN_S = 600, STALL_S = 180, UNIT = 100000000n, FLOOR = 200000n;
const cfg = tacitChain();
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rpc = (method, params) => hedgedRpc(ETH_NODES, method, params, { hedgeMs: 1500, timeoutMs: 15e3 });
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const call = async (sel, arg = '') => BigInt(await rpc('eth_call', [{ to: cfg.blocks, data: '0x' + sel + arg }, 'latest']));
const getJson = (url) => fetch(url, { signal: AbortSignal.timeout(15e3) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const sk = (w) => `<span class="sk" style="--w:${w}"></span>`;
const tac = (units, dp = 2) => (Number(units) / 1e8).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const ago = (s) => (s < 90 ? `${Math.max(1, Math.round(s))} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`);
const mins = (s) => `${Math.max(1, Math.round(s / 60))} min`;
const short = (a) => `${a.slice(0, 18)}…`;                       // the contracts' addresses are mined: their start is what tells them apart
const tx = (h) => `<a href="https://etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener noreferrer">tx ↗</a>`;
const addr = (a) => `<a href="https://etherscan.io/address/${esc(a)}#code" target="_blank" rel="noopener noreferrer"><code>${esc(short(a))}</code> ↗</a>`;
// a share's worth in TAC: (pool + 1e8) / (shares + 1e8), the chain's own rate
const price = (pool, shares) => Number((BigInt(pool) + UNIT) * 10n ** 9n / (BigInt(shares) + UNIT)) / 1e9;

// TacitBlocks' selectors: height() lastLanded() pool() shares() queued() queueDone() FORCE_DELAY() WINDOW(), then queuedAt(uint256)
const SEL = ['0ef26743', '2fb9bbfd', '16f0115b', '03314efa', '16049ddf', '67e41467', 'fbdc9a29', 'a53e5412'];
async function onchain() {
  const [height, last, pool, shares, queued, done, forceDelay, window] = await Promise.all(SEL.map((s) => call(s)));
  const oldest = queued > done ? Number(await call('9ac498de', word(done))) : null;
  return { height: Number(height), last: Number(last), pool, shares, queued: Number(queued), done: Number(done), forceDelay: Number(forceDelay), window: Number(window), oldest };
}
async function read() {
  const [state, fee, blocks, board, chain, head] = await Promise.all([
    getJson(cfg.leader + '/state'), getJson(cfg.leader + '/fee'), getJson(API + '/prover/blocks'), getJson(API + '/prover/board'),
    onchain().catch(() => null),
    rpc('eth_getBlockByNumber', ['latest', false]).then((b) => ({ n: Number(b.number), t: Number(b.timestamp) })).catch(() => null),
  ]);
  const rollup = (Array.isArray(blocks?.rollup) ? blocks.rollup : []).filter((b) => Number.isInteger(b.height) && /^\d+$/.test(String(b.pool ?? '')) && /^\d+$/.test(String(b.shares ?? '')));
  return { state, fee, rollup, board, chain, head, now: head?.t ?? Math.floor(Date.now() / 1000) };
}

const cell = (cls, title, small) => `<div><b><span class="dot ${cls}"></span>${title}</b><small>${small}</small></div>`;
function health({ state, board, chain, now }) {
  const out = [];
  // the leader: answering, and at the contract's height
  if (!state) out.push(cell('bad', 'Leader not answering', chain ? `Anyone may land once ${mins(chain.window)} pass with no block` : 'Read again shortly'));
  else if (chain && Number(state.height) < chain.height) out.push(cell('busy', 'Leader catching up', `at block ${Number(state.height).toLocaleString('en-US')} of ${chain.height.toLocaleString('en-US')}`));
  else out.push(cell('ok', 'Leader answering', `block ${Number(state.height).toLocaleString('en-US')}`));
  // a GPU that proves blocks
  if (!board) out.push(cell('', 'Provers unread', 'Read again shortly'));
  else {
    const n = (board.workers || []).filter((w) => (w.programs || []).includes('tacit-block') && Number(w.lastSeenSeconds) < PROVER_SEEN_S).length;
    out.push(n ? cell('ok', 'Provers ready', `${n} GPU${n === 1 ? '' : 's'} proving blocks, about 35 s a block`) : cell('bad', 'No prover online', '<a href="/prove/">Prove blocks on your GPU</a>'));
  }
  // what waits for the next block
  const pending = Number(state?.pending || 0), quiet = chain ? now - chain.last : 0;
  if (!state) out.push(cell('', 'Payments unread', '—'));
  else if (!pending) out.push(cell('ok', 'Nothing waiting', 'A payment lands in the next block, usually within a minute'));
  else out.push(cell(quiet > STALL_S ? 'bad' : 'busy', `${pending} payment${pending === 1 ? '' : 's'} waiting`, quiet > STALL_S ? `no block for ${mins(quiet)}` : 'in the next block'));
  // spends posted to the contract itself, which every block must take in
  if (!chain) out.push(cell('', 'Queue unread', '—'));
  else if (chain.queued === chain.done) out.push(cell('ok', 'Forced queue empty', `Anything posted is taken in within ${mins(chain.forceDelay)}`));
  else {
    const n = chain.queued - chain.done, age = now - chain.oldest;
    out.push(cell(age > chain.forceDelay * 0.75 ? 'bad' : 'busy', `${n} forced entr${n === 1 ? 'y' : 'ies'}`, `oldest ${mins(age)}, taken in within ${mins(chain.forceDelay)}`));
  }
  return out.join('');
}

function strip({ fee, chain, now }) {
  const p = chain ? price(chain.pool, chain.shares) : null, up = p != null && p > 1 ? `+${((p - 1) * 100).toFixed(2)}% since it started` : 'since it started';
  const f = fee?.fee != null ? BigInt(fee.fee) + FLOOR : null;
  const c = (v, k) => `<div><span class="v num">${v}</span><span class="k">${k}</span></div>`;
  return [
    c(chain ? chain.height.toLocaleString('en-US') : sk('3ch'), 'blocks'),
    c(chain ? (chain.last ? ago(now - chain.last) : '—') : sk('5ch'), 'last block'),
    c(chain ? `${tac(chain.pool)}<small>TAC</small>` : sk('6ch'), 'private on the chain'),
    c(p != null ? `${p.toFixed(5)}<small>TAC</small>` : sk('6ch'), `1 share · ${up}`),
    c(f != null ? `${tac(f, 4)}<small>TAC</small>` : sk('5ch'), 'a payment now, fees in TAC'),
  ].join('');
}

// what a share was worth after each block, its floor at 1, where every share started
function chart(rollup) {
  const pts = [...rollup].sort((a, b) => a.height - b.height).map((b) => [b.height, price(b.pool, b.shares)]);
  if (pts.length < 2) return '';
  const W = 600, H = 140, x0 = pts[0][0], x1 = pts.at(-1)[0], ys = pts.map((q) => q[1]), lo = Math.min(1, ...ys), hi = Math.max(...ys), span = hi - lo || 1e-9;
  const X = (x) => ((x - x0) / (x1 - x0 || 1)) * W, Y = (y) => H - 8 - ((y - lo) / span) * (H - 16);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`).join(' ');
  return `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="A share's worth from block ${x0} to block ${x1}, ${pts[0][1].toFixed(5)} to ${pts.at(-1)[1].toFixed(5)} TAC">
    <line class="gd" x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}"/><path class="ar" d="${d} L${W} ${H} L0 ${H} Z"/><path class="ln" d="${d}"/></svg>
    <figcaption><span>block ${x0} · ${pts[0][1].toFixed(5)}</span><span>block ${x1} · ${pts.at(-1)[1].toFixed(5)} TAC</span></figcaption></figure>`;
}

function blocks({ rollup, head }) {
  if (!rollup.length) return '<li><span class="m">No blocks read yet.</span></li>';
  // an Ethereum block's time from the head's, at 12 s a block
  const when = (n) => (head ? ago(Math.max(1, (head.n - n) * 12)) : '');
  return [...rollup].sort((a, b) => b.height - a.height).slice(0, 25).map((b) =>
    `<li><b>#${b.height.toLocaleString('en-US')}</b><span class="m">${when(b.ethBlock)} · 1 share = ${price(b.pool, b.shares).toFixed(5)} · ${tac(b.pool)} TAC private</span>${tx(b.tx)}</li>`).join('');
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

let busy = false;
async function paint() {
  if (busy || document.hidden) return;
  busy = true;
  try {
    const r = await read();
    $('#health').innerHTML = health(r);
    $('#strip').innerHTML = strip(r);
    $('#chart').innerHTML = chart(r.rollup);
    $('#blocks').innerHTML = blocks(r);
    $('#facts').innerHTML = facts(r.chain);
  } finally { busy = false; }
}

if (!cfg) $('#health').innerHTML = cell('', 'Not live yet', 'The Tacit chain is not deployed here.');
else {
  $('#health').innerHTML = [1, 2, 3, 4].map(() => `<div><b>${sk('12ch')}</b><small>${sk('16ch')}</small></div>`).join('');
  $('#strip').innerHTML = strip({ fee: null, chain: null, rollup: [], now: 0 });
  $('#facts').innerHTML = facts(null);
  paint();
  setInterval(paint, 30e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) paint(); });
}
