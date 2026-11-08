// The bridge page: one tile to pick an asset and a way, the bridges this browser has under way, and the two proofs they wait on.
// Below it, the walk-through of how each way is proven. A bridge is started on the front page (its sheets are linked); this page
// reads the journals (track.js) and the chains, and moves a bridge on only once the holder opens the key here (mover.js).
import { ROUTES, readBridges, liveLine, nextOf, fmtAmount, limitLine, limitsSaid, ethSpan, costLine } from '/bridge/track.js?cb=c4ce3ac0';
import { bodyType } from '/rpc-body.js';
{ const fq = document.getElementById('fq-lim'); if (fq) fq.textContent = limitsSaid(); }   // the FAQ's limits, from the table the page enforces

const API = 'https://api.tacit.finance';
const ESPLORA = 'https://mempool.space/api';
const RPC = 'https://ethereum-rpc.publicnode.com';
const TAC_ERC20 = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const int = (n) => Number(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const within = (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
// A chain is its mark (the page's sprite has both), and a way is two of them with an arrow; the names stay in the labels.
const CHAIN = { btc: ['c-btc', 'Bitcoin'], eth: ['c-eth', 'Ethereum'] };
const mk = (c, size = 'xs') => `<svg class="tk ${size}" aria-hidden="true"><use href="#${CHAIN[c][0]}"/></svg>`;
const ends = (dir) => (dir === 'in' ? ['btc', 'eth'] : ['eth', 'btc']);
const wayName = (dir) => ends(dir).map((c) => CHAIN[c][1]).join(' to ');
const wayInner = (dir, size = 'xs') => { const [a, b] = ends(dir); return `${mk(a, size)}<span aria-hidden="true">→</span>${mk(b, size)}`; };
// A step that names a chain ('Burned on Bitcoin') shows the chain as its mark; the words stay for a screen reader.
const STEP = /^(.+?) ((?:on|for|to) (Bitcoin|Ethereum))$/;
const stepHtml = (s) => { const m = STEP.exec(s); return m ? `${esc(m[1])} <span class="sr">${m[2]}</span>${mk(m[3] === 'Bitcoin' ? 'btc' : 'eth')}` : esc(s); };
async function getJson(url, ms = 15e3) {
  const r = await fetch(url, { signal: within(ms) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1e3);
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

// ── live: the two proofs, and the TAC that has crossed ──────────────────────────────────────────────────────────────────
const COST = { satvb: null, relay: {}, ethUsd: null, btcUsd: null, at: 0 };
const LIVE = { btcAttested: null, btcTip: null, btcTipApi: null, btcConfs: null, ethCovered: null, ethHead: null, burns: null, cadence: null, cadenceAt: 0, txs: new Map(), at: 0 };

async function readProofs() {
  // each reading is drawn as it arrives, so a slow one holds up only its own figure
  const read = (url, use) => getJson(url).then((v) => { use(v); paintProofs(); }).catch(() => {});
  await Promise.all([
    read(`${API}/reflection/status?network=mainnet`, (s) => {
      if (Number.isInteger(s.attestedHeight)) LIVE.btcAttested = s.attestedHeight;
      if (Number.isInteger(s.confirmations)) LIVE.btcConfs = s.confirmations;
      if (Number.isInteger(s.bridgeBurns)) LIVE.burns = s.bridgeBurns;
    }),
    read(`${API}/reflection/eth-state/covers?network=mainnet&block=1`, (c) => { if (Number.isInteger(c.bestBlock)) LIVE.ethCovered = c.bestBlock; }),
    // Ethereum's own head, to say how far behind it that proof is
    rpc('eth_blockNumber', []).then((h) => { LIVE.ethHead = Number(BigInt(h)); paintProofs(); }).catch(() => {}),
    // Bitcoin's own tip (the status's tipHeight is the reflection's view of it)
    read(`${ESPLORA}/blocks/tip/height`, (h) => { if (Number.isInteger(h)) LIVE.btcTip = h; }),
    // how often a proof of Bitcoin lands on Ethereum: the median gap between the day's attestations. It moves slowly and the
    // feed is 15 KB, so it is read every ten minutes, not with each minute's figures.
    // The feed also carries the API's own view of Bitcoin's tip, the stand-in for mempool.space's when that does not answer.
    ...(Date.now() - LIVE.cadenceAt > 10 * 60e3 ? [read(`${API}/flow`, (f) => { LIVE.cadenceAt = Date.now(); const m = medianGapMin(f?.events?.attests); if (m) LIVE.cadence = m; if (Number.isInteger(f?.now?.btc)) LIVE.btcTipApi = f.now.btc; })] : []),
  ]);
  LIVE.at = Date.now();
}

// The median minutes between a list of times (seconds), or null with too few of them.
function medianGapMin(times) {
  const t = (Array.isArray(times) ? times : []).filter(Number.isFinite).sort((a, b) => a - b);
  if (t.length < 4) return null;
  const gaps = t.slice(1).map((v, i) => (v - t[i]) / 60).sort((a, b) => a - b);
  return Math.max(1, Math.round(gaps[Math.floor(gaps.length / 2)]));
}

// How far behind its chain's head each proof is: Bitcoin's in blocks (it is kept `confirmations` deep by design), Ethereum's in time.
// Bitcoin's tip is the higher of what the two sources last said, so one that stops answering cannot hold it back.
const btcLag = () => { const tips = [LIVE.btcTip, LIVE.btcTipApi].filter((t) => t != null); return tips.length && LIVE.btcAttested != null ? Math.max(...tips) - LIVE.btcAttested : null; };
const ethLag = () => (LIVE.ethHead != null && LIVE.ethCovered != null ? Math.max(0, LIVE.ethHead - LIVE.ethCovered) : null);
// Only a lag well past the usual reads as slow: Bitcoin's by 12 blocks (two hours) over its depth, Ethereum's by 1,800 blocks (six hours),
// the figure the front page warns at.
const btcSlow = () => { const l = btcLag(); return l != null && l > (LIVE.btcConfs ?? 24) + 12; };
const ethSlow = () => { const l = ethLag(); return l != null && l > 1800; };

// What the chosen way waits on, and for about how long: 24 Bitcoin blocks, then the next proof; or Ethereum's finality, the proof that
// covers the burn, and the Bitcoin step with its confirmations (the front page says 'a few hours' for the whole way). One proof carries
// both chains, so when it is running late both ways say so.
function paintWait() {
  const el = $('#bt-wait');
  if (!el) return;
  const confs = LIVE.btcConfs ?? 24, hours = Math.round(confs / 6);
  const late = btcSlow() ? `. Right now the proof is about ${Math.round((btcLag() - confs) / 6)} hours behind, so it takes longer` : '';
  el.innerHTML = PICK.dir === 'in'
    ? `About ${hours} hours: <span data-live="confs" class="num">${confs}</span> Bitcoin confirmations, then the next proof (about every ${LIVE.cadence || 30} min)${late}`
    : `A few hours: Ethereum finalizes (about 13 min), the next proof covers it, then you sign the Bitcoin step, paid with a little BTC from your address${late}`;
}

function paintProofs() {
  const set = (sel, v) => $$(sel).forEach((e) => { e.textContent = v; e.classList.remove('sk'); });
  if (LIVE.btcAttested != null) set('[data-live="btc"]', int(LIVE.btcAttested));
  if (LIVE.ethCovered != null) set('[data-live="eth"]', int(LIVE.ethCovered));
  if (LIVE.btcConfs != null) set('[data-live="confs"]', int(LIVE.btcConfs));
  if (LIVE.burns != null) set('[data-live="burns"]', int(LIVE.burns));
  const lag = btcLag(), behind = ethLag();
  const b = $('#pf-btc');
  if (b) b.dataset.state = LIVE.btcAttested == null ? 'off' : btcSlow() ? 'slow' : 'on';
  const e = $('#pf-eth');
  if (e) e.dataset.state = LIVE.ethCovered == null ? 'off' : ethSlow() ? 'slow' : 'on';
  const lagEl = $('#pf-lag');
  if (lagEl && lag != null) lagEl.textContent = lag <= 0 ? ' · at the tip' : ` · ${int(lag)} behind the tip`;
  const eLag = $('#pf-elag');
  if (eLag && behind != null) eLag.textContent = behind < 10 ? ' · at the head' : ` · ${ethSpan(behind)} behind the head`;
  paintWait();
}

async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': bodyType(RPC) }, signal: within(15e3), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await r.json()).result;
}

// What a bridge costs now: Bitcoin's fee rate, the relay's floor for each asset, and the two prices (Chainlink, through the same node as the
// supply). Read every five minutes; a figure that does not come leaves the line without it.
const FEEDS = { ethUsd: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', btcUsd: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c' };
async function readCosts() {
  if (Date.now() - COST.at < 5 * 60e3) return;
  COST.at = Date.now();
  const feed = (k) => rpc('eth_call', [{ to: FEEDS[k], data: '0xfeaf968c' }, 'latest']).then((h) => { const v = Number(BigInt('0x' + h.slice(66, 130))) / 1e8; if (v > 0) COST[k] = v; }).catch(() => {});
  const floor = (asset, k) => getJson(`${API}/confidential/quote?asset=${asset}`).then((q) => { const u = BigInt(q.gasAwareFloorUnits ?? q.staticFloorUnits ?? 0); if (u > 0n) COST.relay[k] = u; }).catch(() => {});
  await Promise.all([
    getJson(`${ESPLORA}/v1/fees/recommended`).then((f) => { if (Number(f.fastestFee) > 0) COST.satvb = Number(f.fastestFee); }).catch(() => {}),
    floor('cETH', 'teth'), floor('cTAC', 'tac'), floor('cBTC', 'cbtc'), floor('cUSD', 'cusd'), floor('cUSDT', 'cusdt'), feed('ethUsd'), feed('btcUsd'),
  ]);
  paintTile();
}

async function readSupply() {
  try {
    const v = BigInt(await rpc('eth_call', [{ to: TAC_ERC20, data: '0x18160ddd' }, 'latest'])) / 10n ** 18n;
    if (v > 0n) $$('[data-live="supply"]').forEach((e) => { e.textContent = int(v); e.classList.remove('sk'); });
  } catch { /* the line keeps its placeholder */ }
}

// The Bitcoin transactions of bridges under way, read for their block (a bridge is followed even with no page moving it on).
// One already in a block keeps it, so it is not asked again.
async function readTxs(rows) {
  const want = rows.filter((r) => r.btcTx && !r.done && !r.back && !(LIVE.txs.get(r.btcTx) || {}).confirmed).map((r) => r.btcTx).slice(0, 8);
  await Promise.all(want.map(async (id) => {
    try {
      const s = await getJson(`${ESPLORA}/tx/${id}/status`, 12e3);
      LIVE.txs.set(id, { confirmed: !!s.confirmed, height: s.block_height ?? null });
    } catch { /* unknown stays unknown */ }
  }));
}

// ── the tile: an asset, a way, its steps, and the door to the sheet that does it ────────────────────────────────────────────
const PICK = { asset: 'tac', dir: 'in' };

function readHash() {
  const [a, d] = location.hash.replace(/^#/, '').toLowerCase().split('/');
  if (Object.hasOwn(ROUTES, a)) PICK.asset = a;                      // a name that is the object's own, not one it inherits (#constructor)
  PICK.dir = d === 'out' && ROUTES[PICK.asset].out ? 'out' : 'in';
}

function paintTile() {
  const a = ROUTES[PICK.asset], route = a[PICK.dir];
  $$('#bt-assets [data-asset]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.asset === PICK.asset)));
  const t = $('#bt');
  t.dataset.dir = PICK.dir;
  t.dataset.asset = PICK.asset;
  $('#bt-flip').disabled = !a.out;
  $('#bt-flip').title = a.out ? 'Switch direction' : `${a.ticker} enters by a lock`;
  $('#bt-from').textContent = PICK.dir === 'in' ? 'Bitcoin' : 'Ethereum';
  $('#bt-to').textContent = PICK.dir === 'in' ? 'Ethereum' : 'Bitcoin';
  $('#bt-from-ic').setAttribute('href', `#${CHAIN[ends(PICK.dir)[0]][0]}`);
  $('#bt-to-ic').setAttribute('href', `#${CHAIN[ends(PICK.dir)[1]][0]}`);
  $$('#bt .bt-tk use').forEach((u) => u.setAttribute('href', `#${a.icon}`));
  const steps = $('#bt-steps'), key = `${PICK.asset}/${PICK.dir}`;
  if (steps.dataset.key !== key) {                // drawn again only when the way changes, so its light keeps running
    steps.dataset.key = key;
    steps.innerHTML = route.steps.map((s, i) => `<li style="--i:${i}"><span class="dot" aria-hidden="true"></span>${stepHtml(s)}</li>`).join('');
  }
  const go = $('#bt-go');
  go.href = route.start;
  go.querySelector('span').textContent = route.go;
  const way = $('#bt-way');
  way.innerHTML = wayInner(PICK.dir, 'sm');
  way.setAttribute('aria-label', wayName(PICK.dir));
  $('.lost a').href = a.in.href;                  // a bridge that cannot be seen is looked for where this asset's sheet is
  paintWait();
  const lim = limitLine(PICK.asset, PICK.dir);
  $('#bt-limit').textContent = lim;
  $('#bt-limit').hidden = !lim;
  const cost = costLine(PICK.asset, PICK.dir, COST);
  $('#bt-cost').textContent = cost;
  $('#bt-cost').hidden = !cost;
  const want = `#${PICK.asset}${PICK.dir === 'out' ? '/out' : ''}`;
  if (location.hash !== want && !(want === '#tac' && !location.hash)) history.replaceState(null, '', want);
}

function wireTile() {
  $('#bt-assets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-asset]');
    if (!b) return;
    PICK.asset = b.dataset.asset;
    if (!ROUTES[PICK.asset].out) PICK.dir = 'in';
    paintTile();
  });
  $('#bt-assets').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const keys = Object.keys(ROUTES), i = keys.indexOf(PICK.asset);
    PICK.asset = keys[(i + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length];
    if (!ROUTES[PICK.asset].out) PICK.dir = 'in';
    paintTile();
    $(`#bt-assets [data-asset="${PICK.asset}"]`).focus();
  });
  $('#bt-flip').addEventListener('click', () => {
    if (!ROUTES[PICK.asset].out) return;
    PICK.dir = PICK.dir === 'in' ? 'out' : 'in';
    paintTile();
  });
  addEventListener('hashchange', () => { readHash(); paintTile(); });
}

// ── your bridges: every bridge this browser has under way, from the front page's journals ───────────────────────────────
let ROWS = [];
// Moving them on from this page (mover.js, loaded when asked): the presses it can make itself
let MV = null, MVP = null;
// What a row waits on its holder for, given the chains' figures; a step the chains say is ready is not put to the holder while the mover has this bridge's key open
// and is free to take it (it takes nothing while a press of its own runs, a mint's wait for the relay lasting minutes)
const nxt = (r) => nextOf(r, LIVE, !!(MV?.open && !MV.pressing && r.pub === MV.pub));

function rowHtml(r) {
  const a = ROUTES[r.asset] || ROUTES.tac;
  const nx = nxt(r), live = liveLine(r, LIVE);
  const to = `<span class="cc" role="img" aria-label="to ${CHAIN[ends(r.dir)[1]][1]}"><span aria-hidden="true">→</span>${mk(ends(r.dir)[1])}</span>`;
  const ticks = r.steps.map((s, i) => `<i class="${i < r.at ? 'y' : i === r.at && !r.done ? 'now' : ''}" title="${esc(s)}"></i>`).join('');
  // the last step it has done (the bar shows the one it is on)
  const where = r.done ? (r.paid ? 'Sent' : 'Arrived') : r.back ? 'Moved back to your Bitcoin address' : r.moving ? 'Moving back to your Bitcoin address' : r.held ? 'Waiting for you' : r.at > 0 ? r.steps[r.at - 1] : 'Started';
  // with the key open here, a bridge of that key offers its presses (track.js `acts`) as buttons; one that goes on by itself says so
  const mine = MV?.open && r.pub === MV.pub && !r.done && !r.back;
  const btn = (x) => `<button type="button" class="${x.main ? 'mb-due' : 'mb-alt'}" data-mv-act="${x.kind}" data-id="${esc(r.id)}">${esc(MV.armed(r.id) && x.kind === 'cancel' ? 'Yes, cancel it' : MV.armed(r.id) && x.kind === 'force' ? 'Yes, send it now' : x.label)}</button>`;
  const act = mine && r.acts?.length ? r.acts.map(btn).join('')
    : mine && r.dir === 'out' && r.stage === 'covered' && nx.due === 'Send to Bitcoin' ? '<span class="mb-self">Goes on by itself</span>'
    : nx.due
    ? `<a class="mb-due" href="${r.href}">${esc(nx.due)} <span aria-hidden="true">→</span></a>`
    : r.done || r.back ? '' : nx.self ? '<span class="mb-self">Goes on by itself</span>'
    : `<a class="mb-open" href="${r.href}">Open to move it on <span aria-hidden="true">→</span></a>`;
  const links = [
    r.btcTx ? `<a href="https://mempool.space/tx/${esc(r.btcTx)}" target="_blank" rel="noopener" title="Bitcoin transaction" aria-label="Bitcoin transaction">${mk('btc')} tx</a>` : '',
    r.ethTx ? `<a href="https://etherscan.io/tx/${esc(r.ethTx)}" target="_blank" rel="noopener" title="Ethereum transaction" aria-label="Ethereum transaction">${mk('eth')} tx</a>` : '',
  ].filter(Boolean).join('');
  return `<li class="mb${r.done ? ' done' : ''}${nx.due ? ' due' : ''}" data-dir="${r.dir}">
    <svg class="tk" aria-hidden="true"><use href="#${a.icon}"/></svg>
    <div class="mb-m">
      <div class="mb-t"><b class="num">${fmtAmount(r.amount, a.dp, a.dec)} ${a.ticker}</b>${to}<small>${r.since ? ago(r.since) : ''}</small></div>
      <div class="mb-r" role="img" aria-label="${esc(where)}">${ticks}</div>
      <div class="mb-w"><span>${stepHtml(where)}</span>${live ? `<span class="mb-live">${esc(live)}</span>` : ''}</div>
      ${r.note ? `<p class="mb-n">${esc(r.note)}</p>` : ''}
    </div>
    <div class="mb-a">${act}${links ? `<span class="mb-x">${links}</span>` : ''}</div>
  </li>`;
}

function paintMine() {
  const box = $('#mine');
  box.hidden = ROWS.length === 0;
  const due = ROWS.filter((r) => nxt(r).due).length;
  document.title = `${due ? `(${due}) ` : ''}${TITLE}`;               // a tab left open says when a bridge needs its holder
  if (!ROWS.length) return;
  // what needs its holder first (the chains' word counts as well as the journal's), then what is on its way, newest first; arrivals last
  const rank = (r) => (nxt(r).due ? 0 : r.done || r.back ? 2 : 1);
  ROWS.sort((a, b) => rank(a) - rank(b) || (b.since || 0) - (a.since || 0));
  const mv = $('#mine-mv');
  if (mv) mv.hidden = !ROWS.some((r) => !r.done && !r.back);
  $('#mine-n').textContent = due ? `${due} need${due === 1 ? 's' : ''} you` : `${ROWS.filter((r) => !r.done && !r.back).length || 'none'} under way`;
  $('#mine-l').innerHTML = ROWS.map(rowHtml).join('');
  notifyChanges();
  paintBell();
}

// ── a tab left open: told when a bridge needs its holder, and when one arrives ───────────────────────────────────────────
// Off until asked for (the browser's own permission prompt comes with the press). A change is announced once, never the state a page opens on.
const TITLE = document.title;
const BELL = 'tacit-bridge-notify-v1';
const canBell = () => { try { return 'Notification' in window; } catch { return false; } };
const bellOn = () => { try { return canBell() && localStorage.getItem(BELL) === '1' && Notification.permission === 'granted'; } catch { return false; } };
let SEEN = null;
function notifyChanges() {
  const now = new Map(ROWS.map((r) => [`${r.dir}:${r.id}`, r.done ? 'done' : nxt(r).due ? 'due' : '']));
  if (SEEN && bellOn()) {
    for (const r of ROWS) {
      const k = `${r.dir}:${r.id}`, was = SEEN.get(k), is = now.get(k);
      if (is !== was && (is === 'due' || (is === 'done' && was !== undefined))) ping(r, is);
    }
  }
  SEEN = now;
}
function ping(r, kind) {
  const a = ROUTES[r.asset] || ROUTES.tac, amt = `${fmtAmount(r.amount, a.dp, a.dec)} ${a.ticker}`, due = nxt(r).due;
  try {
    const n = new Notification(kind === 'due' ? `${amt} bridge needs you` : r.paid ? `${amt} was sent` : `${amt} has arrived`, {
      body: kind === 'due' ? `${due}: open the app to finish it.` : r.paid ? 'It is with the address you paid, to claim as a private payment.' : r.dir === 'in' ? 'It is private on Ethereum now.' : 'It is on your Bitcoin address.', tag: `${r.dir}:${r.id}`,
    });
    n.onclick = () => { window.focus(); location.href = r.href; n.close(); };
  } catch { /* a browser that refuses a notification keeps the tab title */ }
}
function paintBell() {
  const b = $('#mine-bell');
  if (!b) return;
  b.hidden = !canBell() || Notification.permission === 'denied';
  const on = bellOn();
  b.setAttribute('aria-pressed', String(on));
  b.textContent = on ? 'Notifying you' : 'Notify me';
}
function wireBell() {
  const b = $('#mine-bell');
  if (!b || !canBell()) return;
  b.addEventListener('click', async () => {
    try {
      if (bellOn()) { localStorage.setItem(BELL, '0'); paintBell(); return; }
      if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') { paintBell(); return; }
      localStorage.setItem(BELL, '1');
    } catch { /* storage or permission blocked: the title still shows it */ }
    paintBell();
  });
}
// How long ago the chains were last read, so a page left open can be trusted as live.
function paintAge() {
  const t = $('#mine-t');
  if (t && LIVE.at) t.textContent = `checked ${ago(LIVE.at)}`;
}

function mineSay(text, front = false) {
  const el = $('#mine').hidden ? $('#lost-s') : $('#mine-s');           // with no bridge listed there is no list to put it under
  for (const o of [$('#mine-s'), $('#lost-s')]) if (o && o !== el) { o.hidden = true; o.innerHTML = ''; }
  if (!el) return;
  el.hidden = !text;
  el.innerHTML = text ? `${esc(text)}${front ? ` <a href="${esc(typeof front === 'string' ? front : '/#bridge')}">Do it on the front page →</a>` : ''}` : '';
}
const loadMover = () => (MVP ||= import('/bridge/mover.js?cb=fe3674e5').then((m) => {
  const b = $('#mine-mv');
  MV = m.mountMover({ repaint: () => { readMine.sig = null; readMine(); }, say: mineSay,
    onState: (on) => { if (b) { b.setAttribute('aria-pressed', String(on)); b.textContent = on ? 'Moving them on here' : 'Move them on here'; } } });
  return MV;
}).catch((e) => { MVP = null; mineSay(String(e?.message || e).slice(0, 160)); throw e; }));
function wireMove() {
  const b = $('#mine-mv');
  if (!b) return;
  b.addEventListener('click', async () => {
    try { await (await loadMover()).toggle(); } catch { return; }
    readMine.sig = null; readMine();
  });
  // "Can't see a bridge?": the key opened here, a look through its Bitcoin address now, and the way to find a bridge out from its burn
  $('#lost-a')?.addEventListener('click', async (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    try { const m = await loadMover(); if (!m.open && !(await m.toggle())) return; $('#lost-form').hidden = false; await m.find(true); } catch { /* said on the line */ }
    readMine.sig = null; readMine();
  });
  $('#lf-go')?.addEventListener('click', async () => {
    const b = $('#lf-go');
    b.disabled = true;
    try { if (await MV?.findOut($('#lf-tx').value, $('#lf-amt').value)) { $('#lf-tx').value = ''; $('#lf-amt').value = ''; } } finally { b.disabled = false; readMine.sig = null; readMine(); }
  });
  $('#mine-l').addEventListener('click', (e) => {
    const a = e.target.closest('[data-mv-act]');
    if (a && MV) MV.press(a.dataset.mvAct, ROWS.find((r) => r.id === a.dataset.id));
  });
}

function readMine() {
  let rows = [];
  try { rows = readBridges(localStorage); } catch { rows = []; }
  const sig = JSON.stringify(rows.map((r) => [r.id, r.stage, r.due, r.at, nxt(r).due]));
  const changed = sig !== readMine.sig;
  readMine.sig = sig;
  ROWS = rows;
  if (changed) paintMine();
  return changed;
}

// ── the walk-through: steppers that play when they are seen, and a press picks a step ───────────────────────────────────
function wireSteppers() {
  for (const fig of $$('[data-stepper]')) {
    // the list of steps sits beside the drawing, in the same section
    const steps = $$(`.st-l[data-for="${fig.dataset.for}"] [data-step]`, fig.closest('section'));
    const n = steps.length;
    let at = 0, timer = null, held = false;
    const show = (i) => {
      at = (i + n) % n;
      fig.dataset.at = String(at);
      steps.forEach((s, j) => s.setAttribute('aria-current', j === at ? 'step' : 'false'));
      $$('[data-on]', fig).forEach((g) => g.classList.toggle('on', g.dataset.on.split(' ').includes(String(at))));
      $$('[data-upto]', fig).forEach((g) => g.classList.toggle('on', Number(g.dataset.upto) <= at));
    };
    const play = () => { if (reduce || held || timer) return; timer = setInterval(() => show(at + 1), 2600); };
    const stop = () => { clearInterval(timer); timer = null; };
    steps.forEach((s, j) => {
      s.addEventListener('click', () => { held = true; stop(); show(j); });
      s.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); held = true; stop(); show(j); } });
    });
    show(0);
    new IntersectionObserver((es) => es.forEach((e) => (e.isIntersecting ? play() : stop())), { threshold: 0.35 }).observe(fig);
  }
}

// The note: one commitment format on both chains; a bridge burns one note and mints a fresh one of the same value.
function wireNote() {
  const fig = $('#note-fig');
  if (!fig) return;
  const set = (side) => {
    fig.dataset.side = side;
    $$('[data-side]', fig).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.side === side)));
  };
  $$('button[data-side]', fig).forEach((b) => b.addEventListener('click', () => set(b.dataset.side)));
  set('btc');
  if (!reduce) {
    let t = null;
    new IntersectionObserver((es) => es.forEach((e) => {
      clearInterval(t);
      if (e.isIntersecting) t = setInterval(() => { if (!fig.matches(':hover,:focus-within')) set(fig.dataset.side === 'btc' ? 'eth' : 'btc'); }, 3200);
    }), { threshold: 0.4 }).observe(fig);
  }
}

// Burn, prove, mint: one switch turns the drawing and its words to the other way.
function wireMoves() {
  const fig = $('#mv'), caps = $('.mvc');
  if (!fig) return;
  const set = (dir) => {
    fig.dataset.dir = dir;
    if (caps) caps.dataset.dir = dir;
    $('#mv-a').setAttribute('href', `#${CHAIN[ends(dir)[0]][0]}`);
    $('#mv-b').setAttribute('href', `#${CHAIN[ends(dir)[1]][0]}`);
    $$('#mv-dir button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.dir === dir)));
  };
  $$('#mv-dir button').forEach((b) => b.addEventListener('click', () => set(b.dataset.dir)));
  set('in');
}

// Under the hood: one switch shows the way in or the way out, its steps and its drawing.
function wireHood() {
  const box = $('#hood');
  if (!box) return;
  const set = (dir) => {
    $$('[data-hood], [data-hood-fig]', box).forEach((e) => { e.hidden = (e.dataset.hood || e.dataset.for) !== dir; });
    $$('#hood-dir button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.dir === dir)));
  };
  $$('#hood-dir button').forEach((b) => b.addEventListener('click', () => set(b.dataset.dir)));
}

// Who checks what: a press on a hop names who checks it.
function wireChecks() {
  const box = $('#ck');
  if (!box) return;
  const pick = (k) => {
    $$('[data-ck]', box).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ck === k)));
    $$('[data-ckp]', box).forEach((p) => { p.hidden = p.dataset.ckp !== k; });
  };
  box.addEventListener('click', (e) => { const b = e.target.closest('[data-ck]'); if (b) pick(b.dataset.ck); });
  pick($('[data-ck]', box).dataset.ck);
}

function revealOnScroll() {
  const els = $$('.rv');
  if (reduce || !('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -12% 0px' });
  els.forEach((e) => io.observe(e));
}

// The live picture of both chains kept in step, drawn when it comes near.
function mountLive() {
  const host = $('#live-v');
  if (!host || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((es) => {
    if (!es.some((e) => e.isIntersecting)) return;
    io.disconnect();
    import('/weld/flow/viz.js?cb=385547bd').then((m) => m.mountFlow(host, {})).catch(() => { $('#live').hidden = true; });
  }, { rootMargin: '400px' });
  io.observe(host);
}

// ── start ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
readHash();
wireTile();
paintTile();
readMine();
wireSteppers();
wireNote();
wireMoves();
wireHood();
wireChecks();
// On a narrow screen a wide drawing scrolls inside its frame: it opens on its middle, where the proof is.
const centre = () => $$('.fig.big').forEach((f) => { if (f.scrollWidth > f.clientWidth) f.scrollLeft = (f.scrollWidth - f.clientWidth) / 2; });
centre();
addEventListener('resize', centre);
// Motion runs only where it can be seen. The tile, the proof lines, the bridges list and each drawing run their animations (CSS and
// SVG) while they are in view in a visible tab, and hold still otherwise; a reader who asks for less motion gets none of it.
function gateMotion() {
  document.documentElement.classList.add('m');
  const els = $$('.fig, #bt, .pf, #mine'), seen = new Map();
  const apply = (el) => {
    const on = !!seen.get(el) && !document.hidden && !reduce;
    el.dataset.run = on ? '1' : '0';
    for (const s of el.matches('svg') ? [el] : $$('svg', el)) { try { on ? s.unpauseAnimations() : s.pauseAnimations(); } catch { /* not an SVG root */ } }
  };
  if (!('IntersectionObserver' in window)) { els.forEach((el) => { seen.set(el, true); apply(el); }); return; }
  const io = new IntersectionObserver((es) => { for (const e of es) { seen.set(e.target, e.isIntersecting); apply(e.target); } }, { rootMargin: '60px' });
  els.forEach((el) => io.observe(el));
  document.addEventListener('visibilitychange', () => els.forEach(apply));
}
gateMotion();
revealOnScroll();
mountLive();

async function tick() {
  readCosts();
  await readProofs().catch(() => {});
  await readTxs(ROWS);
  paintMine();
  paintTile();
  paintAge();
}
wireBell();
wireMove();
tick();
readSupply();
setInterval(() => { if (!document.hidden) tick(); }, 60e3);
// The front page writes its journals as it moves a bridge on; another tab's write arrives here at once.
addEventListener('storage', (e) => { if (!e.key || /^tacit-(burndep|crossout)-bridge-v1:/.test(e.key)) readMine(); });
setInterval(() => { if (!document.hidden) readMine(); paintAge(); }, 5e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - LIVE.at > 60e3) tick(); });
