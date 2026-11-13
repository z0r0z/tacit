// /prove/: the network's blocks as they land, the proofs waiting and the provers making them, and this computer's own prover, started
// and paused from here. The computer's tacit-prover (installed once with the line the page shows) answers on 127.0.0.1; the API's chain
// (GET /prover/blocks) and proof pool, and the points service, say what the network did and what an address has made and been paid.
import { cleanAddress, proveCommand, utcDay, mineLines, capOf, perPoint } from '/community-prove.js?cb=e2a65259';
import { localState, jobView, headline, isPhone, isWindows, setupText, proverUpdate, updateText } from '/prove/view.js?cb=f0f73815';
import { invaderSvg, gpuSvg } from '/prove/invader.js?cb=e8a5ec59';
import { makeTabMiner, defaultThreads, maxThreads, GPU_LEVELS, dayShare } from '/prove/tabmine.js?cb=a9294239';
import { HELPDESK, FETCH_CMD, cleanDesk, cleanStats, reviewView } from '/prove/review.js?cb=a8c503cf';
import { short, cells, opsText, tac, rewardWei, ago, took, fresh, blockAgo, kindOf, KINDS, kindText, median, untilDayEnds, cleanBlock, cleanProof, cleanMiner } from '/prove/chain.js?cb=a282e227';

const API = 'https://api.tacit.finance', POINTS = 'https://tacit-points.onrender.com', LOCAL = 'http://127.0.0.1:47815';
const SAVED_ADDR = 'tacit-prove-address';                          // shared with the keeper page's card
const SHOW = 40, FEW = 5;                                          // blocks on the strip, and how many are read each time once it is drawn
const $ = (s) => document.querySelector(s);
const get = (url, ms = 6000) => fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(ms) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let desk = null, deskStats = null, reviewBusy = false;   // the code-review card: the prover's help desk job, and the help desk's stats
let health = null, mine = null, pool = null, points = null, tally = null, boardDay = null, busy = false, copied = false, salts = null, cross = [], rollup = [], misses = 0;
// The setup line's kind of computer, from the browser; the switch above the line changes it (setting up another computer).
let os = isWindows(navigator.userAgent) ? 'win' : 'unix';
const rateText = (r) => (r >= 1e6 ? `${(r / 1e6).toFixed(1)} M/s` : `${Math.round(r / 1e3)} k/s`);
let blocks = [], ethHead = null, headReadAt = 0, shownTop = null, picked = null, feed = [], feedTop = 0, saltTop = 0, lastProved = null;

const BASE_TITLE = document.title;
const addr = () => cleanAddress($('#addr').value);
const count = (x) => (Number.isSafeInteger(Number(x)) && Number(x) >= 0 ? Number(x) : null);
const cleanPool = (p) => (p ? { queued: count(p.queued), leased: count(p.leased), doneToday: count(p.doneToday), minersToday: count(p.minersToday),
  done24h: count(p.done24h), miners24h: count(p.miners24h),
  top: (p.top || []).map(cleanMiner).filter(Boolean), terms: { pointsPerProof: count(p.terms?.pointsPerProof), proofsPerMinerDay: count(p.terms?.proofsPerMinerDay) } } : null);
const me = () => addr()?.toLowerCase() || null;
// What a point earned today is paid so far (perPoint): the day's amount over today's proof points, the pool's tally and the board's, never
// more than the cap. Unknown until the pool's tally of today is read; a board tally not read yet counts nothing.
const sumPoints = (ms) => ms.reduce((s, m) => s + m.points, 0);
const dayPoints = () => (tally && Number(tally.day) === utcDay() ? sumPoints(tally.miners) + (boardDay?.day === utcDay() ? boardDay.points : 0) : null);
const pointRate = () => perPoint(points, dayPoints());
// A node's face: the zOrgz invader its address picks (invader.js), or Tacit's GPU's own. An image, so each picture keeps its own gradient.
const faces = new Map();
const face = (a, px = 18) => {
  const k = a || 'gpu';
  if (!faces.has(k)) faces.set(k, `data:image/svg+xml;base64,${btoa(a ? invaderSvg(a, 64) : gpuSvg(64))}`);
  return `<img class="inv" src="${faces.get(k)}" width="${px}" height="${px}" alt="">`;
};
const who = (a, you = true) => `<span class="who">${face(a)}${esc(short(a))}${you && a === me() ? ' · you' : ''}</span>`;
const GPU = `<span class="who gpu">${face(null)}Tacit GPU</span>`;
const byOf = (x, you = true) => (x.house ? GPU : x.prover || x.miner ? who(x.prover || x.miner, you) : null);

// Chrome asks before a public page reaches a program on this computer, and a "Block" there leaves tacit-prover looking absent. Where the
// browser names that permission, a denial is told apart from a prover that is not installed.
let blocked = false;
async function readBlocked() {
  for (const name of ['loopback-network', 'local-network-access']) {
    try { if ((await navigator.permissions.query({ name })).state === 'denied') return true; } catch {}
  }
  return false;
}
async function readLocal() {
  health = await get(`${LOCAL}/health`, 2500);
  blocked = health ? false : await readBlocked();
  mine = health?.ok ? await get(`${LOCAL}/mine`, 2500) : null;
  desk = health?.ok ? cleanDesk(await get(`${LOCAL}/helpdesk`, 2500)) : null;
  hearProver();
  // The prover's own address fills an empty field: it is where this computer's proofs already pay.
  if (mine?.miner && !$('#addr').value) { $('#addr').value = mine.miner; addressChanged(); }
}

// A wallet connected on this page (ops.js) fills an empty field: its account is the likeliest place the TAC is meant to go.
addEventListener('tacit:prove-wallet', (e) => {
  const a = cleanAddress(e.detail);
  if (a && !$('#desk').hidden && !$('#addr').value.trim()) { $('#addr').value = a; addressChanged(); }
});

let pointsFor = null;
async function readRemote() {
  const a = addr();
  const d = utcDay();
  const [m, t, b] = await Promise.all([get(`${POINTS}/mine${a ? `?address=${a.toLowerCase()}` : ''}`), get(`${API}/prover/pool/credits?day=${d}`), get(`${API}/prover/board/credits?day=${d}`)]);
  if (b && Array.isArray(b.miners)) boardDay = { day: d, points: sumPoints(b.miners.map(cleanMiner).filter(Boolean)) };
  if (a !== addr()) return;
  // A read that fails keeps what the last one said for the same address, so one missed answer does not blank the TAC figures.
  const same = a === pointsFor;
  pointsFor = a;
  points = m || (same ? points : null);
  tally = t ? { ...t, miners: (t.miners || []).map(cleanMiner).filter(Boolean) } : same ? tally : null;
  paintNet(); paintFeed(); paintDetail(); paintGpu(); paintPot();
}

// The chain, read often: a new block lands at the front of the strip. Once the strip is drawn only the newest few are asked for, and the
// whole window again when every one of those is new (the API's `cross` list comes whole either way).
let chainAt = 0;
async function readChain() {
  // after a long gap (a hidden tab shown again) the blocks that landed meanwhile are drawn in place, not as just landed
  const late = Date.now() - chainAt > NEW_MS;
  chainAt = Date.now();
  let c = await get(`${API}/prover/blocks?limit=${shownTop == null ? SHOW : FEW}`);
  if (shownTop != null && c?.blocks?.length >= FEW && fresh(c.blocks.map(cleanBlock).filter(Boolean), shownTop).length >= FEW) c = await get(`${API}/prover/blocks?limit=${SHOW}`);
  // No answer: the strip keeps its place and what it showed (it is not taken away, so nothing under it moves), and the stage says so once it has
  // gone unanswered twice with nothing read yet.
  if (!c?.blocks) { chainMisses++; paintNow(); return; }
  chainMisses = 0;
  beat();
  c.blocks = c.blocks.map(cleanBlock).filter(Boolean);
  // No blocks yet (or none that read as one): the strip stays as it is.
  if (!c.blocks.length) return;
  if (c.head) c.head.ethHead = Number.isSafeInteger(Number(c.head.ethHead)) ? Number(c.head.ethHead) : null;
  if (c.head?.ethHead != null) ethHead = c.head.ethHead;
  // An API from before the tip carried Ethereum's head: the settle index says it, read at most once a minute.
  else if (Date.now() - headReadAt > 60000) { headReadAt = Date.now(); const hb = Number((await get(`${API}/confidential/index?limit=1`))?.headBlock); if (Number.isSafeInteger(hb)) ethHead = hb; }
  $('#last').textContent = c.blocks[0] ? (blockAgo(c.blocks[0].ethBlock, ethHead) || '—') : '—';
  const xc = (Array.isArray(c.cross) ? c.cross : []).map(cleanCross).filter(Boolean);
  const xcNew = xc.map((x) => x.digest).join() !== cross.map((x) => x.digest).join();
  cross = xc;
  const rb = (Array.isArray(c.rollup) ? c.rollup : []).map(cleanRollup).filter(Boolean);
  const rbNew = rb.map((x) => x.height).join() !== rollup.map((x) => x.height).join();
  rollup = rb;
  const add = fresh(c.blocks, shownTop);
  if (!add.length && shownTop != null) { if (xcNew || rbNew) paintChain(new Set()); else paintAges(); return; }
  const first = shownTop == null || late;
  blocks = [...add, ...blocks].slice(0, SHOW);
  shownTop = blocks[0]?.height ?? shownTop;
  if (!first) landed = { b: blocks[0], at: Date.now() };
  paintChain(first ? new Set() : new Set(add.map((b) => b.height)));
  paintNow();
  const h = $('#height');
  h.textContent = `#${shownTop.toLocaleString('en-US')}`;
  if (!first) { h.classList.remove('bump'); void h.offsetWidth; h.classList.add('bump'); }
}

// A cross-chain block (GET /prover/blocks `cross`): a landed reflection batch, Bitcoin's tacit state taken into the pool up to `bitcoin`,
// with the eth-state proof it folds for the Bitcoin side (its slot). Each is placed among the settles by the Ethereum block it landed in.
const HEX32B = /^0x[0-9a-f]{64}$/i;
const cleanCross = (x) => (x && HEX32B.test(String(x.digest)) && count(x.bitcoin) && count(x.ethBlock)
  ? { digest: String(x.digest).toLowerCase(), bitcoin: count(x.bitcoin), ethBlock: count(x.ethBlock), tx: HEX32B.test(String(x.tx)) ? x.tx : null, slot: count(x.ethereum?.slot),
    house: x.by?.house === true, miner: cleanAddress(x.by?.miner)?.toLowerCase() || null } : null);
function crossTile(x) {
  const what = `Bitcoin to ${x.bitcoin.toLocaleString('en-US')}${x.slot ? `, Ethereum slot ${x.slot.toLocaleString('en-US')}` : ''}`;
  const body = `<span class="cube"><span class="glyph" aria-hidden="true">₿</span></span><span class="h num">₿ ${x.bitcoin.toLocaleString('en-US')}</span><span class="o"><span class="k k-xc">Cross-chain</span>${byOf(x) || ''}</span><span class="t" data-eb="${x.ethBlock}">${esc(blockAgo(x.ethBlock, ethHead) || '')}</span>`;
  return `<li class="blk xc" title="${esc(what)}">${x.tx ? `<a href="https://etherscan.io/tx/${esc(x.tx)}" target="_blank" rel="noopener noreferrer" aria-label="Cross-chain block: ${esc(what)}">${body}</a>` : body}</li>`;
}

// A tacit chain block (GET /prover/blocks `rollup`): a block of TAC payments the chain's leader landed on Ethereum, proved by a GPU on the
// board. Placed among the settles by the Ethereum block it landed in, as a cross-chain block is.
const cleanRollup = (x) => (x && count(x.height) && count(x.ethBlock) ? { height: count(x.height), ethBlock: count(x.ethBlock), tx: HEX32B.test(String(x.tx)) ? x.tx : null } : null);
const LINK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3.1-3.1a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M14 10a4 4 0 0 0-5.7 0l-3.1 3.1a4 4 0 0 0 5.7 5.7l1.2-1.2"/></svg>';
function rollupTile(x) {
  const what = `Tacit chain block ${x.height.toLocaleString('en-US')}`;
  const body = `<span class="cube"><span class="glyph">${LINK_ICON}</span></span><span class="h num">#${x.height.toLocaleString('en-US')}</span><span class="o"><span class="k k-tc">Tacit chain</span></span><span class="t" data-eb="${x.ethBlock}">${esc(blockAgo(x.ethBlock, ethHead) || '')}</span>`;
  return `<li class="blk xc tc" title="${esc(what)}">${x.tx ? `<a href="https://etherscan.io/tx/${esc(x.tx)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(what)}">${body}</a>` : body}</li>`;
}

function paintChain(landing) {
  const ol = $('#chain');
  ol.hidden = false;
  const oldest = blocks.length ? blocks[blocks.length - 1].ethBlock : Infinity;
  // the cross-chain and tacit chain blocks in the window, newest first by Ethereum block: each goes before the settles of its own Ethereum
  // block and older
  const extra = [...cross.filter((x) => x.ethBlock >= oldest).map((x) => ({ eb: x.ethBlock, tile: () => crossTile(x) })),
    ...rollup.filter((x) => x.ethBlock >= oldest).map((x) => ({ eb: x.ethBlock, tile: () => rollupTile(x) }))].sort((a, b) => b.eb - a.eb);
  const at = (eb) => extra.filter((e) => e.eb >= eb && !e.done);
  ol.innerHTML = `<li class="blk next${pool?.leased ? ' busy' : ''}" aria-label="The next block"><span class="cube ghost">${nextShown = nextCells()}</span><span class="h">next</span><span class="o" id="next-o">${esc(waitingText())}</span></li>` + blocks.map((b) => {
    const before = at(b.ethBlock).map((e) => { e.done = true; return e.tile(); }).join('');
    return before + settleTile(b, landing);
  }).join('');
  paintDetail();
}

function settleTile(b, landing) {
  {
    const c = cells(b), mineB = b.prover && b.prover === me();
    return `<li class="blk${b.prover ? ' won' : ''}${b.house ? ' gpu' : ''}${mineB ? ' mine' : ''}${landing.has(b.height) ? ' new' : ''}" data-h="${b.height}" aria-current="${picked === b.height}">
      <button type="button" aria-label="Block ${b.height}, ${esc(kindText(b))}, ${esc(opsText(b))}"><span class="cube">${c.cells.map((k) => `<i class="${k}"></i>`).join('')}${b.house || b.prover ? `<span class="badge">${face(b.house ? null : b.prover, 26)}</span>` : ''}</span>
      <span class="h num">#${b.height.toLocaleString('en-US')}</span><span class="o"><span class="k k-${kindOf(b)}">${esc(kindText(b))}</span>${byOf(b) || ''}</span><span class="t" data-eb="${b.ethBlock}">${esc(blockAgo(b.ethBlock, ethHead) || '')}</span></button></li>`;
  }
}

// Between new blocks the tiles' ages move on with Ethereum's head, written in place (the strip is not drawn again).
function paintAges() {
  for (const t of $('#chain').querySelectorAll('.t[data-eb]')) {
    const s = blockAgo(Number(t.dataset.eb), ethHead) || '';
    if (t.textContent !== s) t.textContent = s;
  }
}

function paintDetail() {
  const d = $('#detail'), b = blocks.find((x) => x.height === picked);
  d.hidden = !b;
  if (!b) return;
  // A block of today's at today's rate; one from an earlier day by its points (its day's rate is not read here).
  const r = b.prover && ethHead != null && b.ethBlock && Date.now() - (ethHead - b.ethBlock) * 12_000 >= utcStart() ? rewardWei(b.points, pointRate()) : null;
  d.innerHTML = `<div class="rows flat num">
    <div class="kv"><span>Block</span><b>#${b.height.toLocaleString('en-US')}</b></div>
    <div class="kv"><span>What it did</span><b>${esc(kindText(b))}<small>${esc(opsText(b))}${KINDS[kindOf(b)].href ? ` · <a href="${KINDS[kindOf(b)].href}">${esc(KINDS[kindOf(b)].act)}</a>` : ''}</small></b></div>
    <div class="kv"><span>Proved by</span><b>${byOf(b) || '—'}</b></div>
    ${b.prover ? `<div class="kv"><span>Won</span><b>${r ? `${tac(r)} TAC` : `${b.points} points`}</b></div>` : ''}
    <div class="kv"><span>Hash</span><b>${esc(short(b.hash))}</b></div>
    <div class="kv"><span>Ethereum</span><b><a href="https://etherscan.io/tx/${esc(b.tx)}" target="_blank" rel="noopener noreferrer">block ${b.ethBlock.toLocaleString('en-US')}</a>${blockAgo(b.ethBlock, ethHead) ? `<small>${esc(blockAgo(b.ethBlock, ethHead))}</small>` : ''}</b></div>
  </div>`;
}

// The waiting proofs as little squares (the leased ones lit), the day's numbers, the newest community proofs and the day's provers.
async function readFeed() {
  const f = await get(`${API}/prover/pool/recent`);
  if (f?.proofs) { feed = f.proofs.map(cleanProof).filter(Boolean); feedOk = true; }
  feedTried = true;
  paintFeed(); paintBoard(); paintCrowd();
  feedTop = Math.max(feedTop, feed[0]?.at || 0);
}

// The feed: the community's proofs, and the good salts the nodes mined (`recent`, which the salt pool keeps: finds of four zero bytes or more; one
// row for a send's best, at most SALTS_SHOWN of them so a run of finds never pushes every proof off), newest first.
const SALTS_SHOWN = 4, SALT_FRESH_MS = 24 * 3600_000;
// A find's quality as its address starts: whole zero bytes (a byte is 8 bits).
const zeroBytes = (bits) => { const n = Math.floor(bits / 8); return `${n} leading zero byte${n === 1 ? '' : 's'}`; };
// What a find is worth so far: the day's salt pot is shared by weight (a find weighs 2^(bits - minBits), up to the cap) and paid after the day ends, so
// this is its part of the pot at the weight the day has now, and it shrinks as the day's weight grows. Tacit's own earn nothing; a find from an earlier
// UTC day is already paid (its day's weight is not known here).
const utcStart = () => Date.now() - (Date.now() % 86400000);
function saltAward(f) {
  const cp = pointRate(), total = Math.floor(salts?.weight || 0);
  if (f.house || !cp || !total || !salts?.pointsPerDay || (f.at != null && f.at < utcStart())) return null;
  const w = 2 ** Math.min(f.bits - (salts.minBits ?? 26), salts.maxWeightBits ?? 20);
  return w >= 1 ? (BigInt(salts.pointsPerDay) * BigInt(Math.round(w)) * BigInt(cp)) / BigInt(total) : null;
}
const awardText = (wei) => { if (wei == null) return ''; const t = tac(wei, 2); return t === '0' ? '< 0.01 TAC' : `≈ +${t} TAC`; };
function goodSalts() {
  const seen = new Set(), t = Date.now();
  return (salts?.recent || []).filter((f) => t - f.at < SALT_FRESH_MS && f.at <= t + 60_000)
    .sort((a, b) => b.at - a.at || b.bits - a.bits)
    .filter((f) => { const k = `${f.house ? 'gpu' : f.miner}:${f.at}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, SALTS_SHOWN);
}
// With nothing waiting and no proof for ten minutes, the feed says why it is still, and where the next proof comes from.
const IDLE_MS = 10 * 60_000;
function paintIdle() {
  paintPot();
  $('#feed-idle').hidden = !(pool && !(pool.queued || pool.leased) && !(feed[0]?.at && Date.now() - feed[0].at < IDLE_MS));
}
// The newest proofs as marks along a line of time, the latest at the right: how the proving has gone lately, at a glance. The line runs from the
// oldest of them to now, so the room left at its right end is how long ago the last one was. The API lists the newest few dozen, and the words under
// the line say how many there are and how far back they go.
function paintTape() {
  const now = Date.now(), ps = feed.filter((p) => p.at > 0 && p.at <= now + 60_000);
  const from = ps.length ? Math.min(...ps.map((p) => p.at)) : now, span = now - from;
  const on = ps.length >= 2 && span > 0;
  $('#tape-l').innerHTML = on ? ps.map((p) => `<i class="${[p.house ? 'gpu' : p.miner === me() ? 'me' : '', feedTop > 0 && p.at > feedTop ? 'new' : ''].filter(Boolean).join(' ')}" style="left:${(Math.min(1, Math.max(0, (p.at - from) / span)) * 100).toFixed(2)}%"></i>`).join('') : '';
  $('#tape-a').textContent = on ? ago(from, now) : '';
  $('#tape-n').textContent = on ? `newest ${ps.length} proofs` : '';
  $('#tape').setAttribute('aria-label', on ? `The newest ${ps.length} proofs, from ${ago(from, now)} to now` : 'The newest proofs along a line of time');
}
function paintFeed() {
  paintIdle(); paintTape();
  const rows = [...feed.slice(0, 8).map((p) => ({ ...p, kind: 'proof' })), ...goodSalts().map((f) => ({ ...f, kind: 'salt' }))].sort((a, b) => b.at - a.at).slice(0, 8);
  if (!rows.length) { if (!$('#feed .empty')) $('#feed').innerHTML = '<li class="empty">Nothing yet today.</li>'; return; }
  $('#feed').innerHTML = rows.map((p) => {
    // This address's own proofs are marked by the row (an edge), not a longer name, so every row stays on one line.
    const mine = !p.house && p.miner && String(p.miner).toLowerCase() === me();
    const top = p.kind === 'salt' ? saltTop : feedTop, fresh = top > 0 && p.at > top;
    const award = p.kind === 'salt' ? saltAward(p) : null;
    if (p.kind === 'salt') return `<li class="${['salt', fresh ? 'new' : '', mine ? 'me' : ''].filter(Boolean).join(' ')}"${mine ? ' title="Your node"' : ''}><span class="by">${byOf(p, false)}<small>good salt, ${Math.floor(p.bits / 8)} zero bytes</small></span><b${award ? ' title="Its part of today\'s salt pot so far, paid after the day ends"' : ''}>${esc(awardText(award))}</b><small>${esc(ago(p.at))}</small></li>`;
    // A proof of today's at today's rate so far; one from an earlier UTC day is already paid, at its day's rate (not read here).
    const r = p.at >= utcStart() ? rewardWei(p.points, pointRate()) : null;
    return `<li class="${[fresh ? 'new' : '', mine ? 'me' : ''].filter(Boolean).join(' ')}"${mine ? ' title="Your node"' : ''}><span class="by">${byOf(p, false)}<small>a deposit, proved in ${esc(took(p.secs))}</small></span><b>${r ? `+${tac(r)} TAC` : ''}</b><small>${esc(ago(p.at))}</small></li>`;
  }).join('');
}

// Who is at work now: everyone with a proof in the last twenty minutes, and every node grinding salts between proofs (the salt pool's
// `live`), Tacit's GPU among them, as their invaders. All of them are drawn: the row keeps one height, and the faces take the largest size that
// fits them in it, so a busier floor is a denser one (past the smallest size the rest are counted). This address comes first, then the
// nodes whose proof landed in the last few minutes, which are ringed.
const ONLINE_MS = 20 * 60_000, HOT_MS = 3 * 60_000, FACE_PX = [28, 24, 20, 16], FACE_GAP = 6;
function crowdFit(n, width, height) {
  const room = (px) => Math.max(1, Math.floor((width + FACE_GAP) / (px + FACE_GAP))) * Math.max(1, Math.floor((height + FACE_GAP) / (px + FACE_GAP)));
  for (const px of FACE_PX) if (n <= room(px)) return { px, show: n };
  const px = FACE_PX[FACE_PX.length - 1];
  return { px, show: Math.max(1, room(px) - 2) };                  // the last places hold the count of the rest
}
let crowdShown = null, feedTried = false, saltsTried = false, feedOk = false;   // the floor as drawn; whether each of its two readings has been tried, and whether the proofs' has answered
function paintCrowd() {
  const t = Date.now(), seen = new Map(), row = $('#crowd-row');
  for (const p of feed) if (t - p.at < ONLINE_MS) { const k = p.house ? 'gpu' : p.miner; if (k && !seen.has(k)) seen.set(k, p); }
  for (const m of salts?.live || []) { const k = m.house ? 'gpu' : m.miner; if (k && !seen.has(k)) seen.set(k, m); }
  // The floor is drawn once both of its readings have been tried (the newest proofs and the salt pool), so its count does not start at a part of
  // the nodes and jump; until then, and while neither has answered, the stand-ins stay. Answered, and no one at work: an empty floor.
  if (!(feedTried && saltsTried) || !(feedOk || salts)) return;
  if (!seen.size) { $('#crowd-n').textContent = 'Nodes online'; $('#crowd-r').textContent = ''; if (crowdShown !== '') { crowdShown = ''; row.innerHTML = ''; row.removeAttribute('data-sk'); } return; }
  const hot = new Set(feed.filter((p) => t - p.at < HOT_MS).map((p) => (p.house ? 'gpu' : p.miner)));
  const rank = (k) => (k === me() ? 0 : hot.has(k) ? 1 : 2), keys = [...seen.keys()].sort((a, b) => rank(a) - rank(b));
  const fit = crowdFit(keys.length, (row.clientWidth || 606) - 6, (row.clientHeight || 68) - 6), rest = keys.length - fit.show;   // less the row's own 3px of room all round
  const html = keys.slice(0, fit.show).map((k, i) => `<span class="pod${k === me() ? ' me' : ''}${hot.has(k) ? ' hot' : ''}" style="--i:${i}" title="${k === 'gpu' ? 'Tacit GPU' : esc(short(k))}${hot.has(k) ? ' · a proof in the last few minutes' : ''}">${face(k === 'gpu' ? null : k, fit.px)}</span>`).join('')
    + (rest > 0 ? `<span class="more-n" style="--px:${fit.px}px" title="${rest} more">+${rest}</span>` : '');
  $('#crowd-n').textContent = `${seen.size} ${seen.size === 1 ? 'node' : 'nodes'} online`;
  // how fast the nodes grind salts between proofs (the pool's estimate from the last hour's shares)
  $('#crowd-r').textContent = salts?.rate ? `${rateText(salts.rate).replace('/s', '')} salts a second` : '';
  if (html !== crowdShown) { crowdShown = html; row.innerHTML = html; row.removeAttribute('data-sk'); }   // drawn again only when it changes, so the invaders keep their step
}
let crowdTimer = 0;
addEventListener('resize', () => { clearTimeout(crowdTimer); crowdTimer = setTimeout(paintCrowd, 150); });

// What is happening now, in one sentence on the stage: a block that has just landed (for most of a minute), else the proofs being made or
// waiting, else the nodes mining salts meanwhile. It says only what the last readings say. Its dot beats each time the chain answers.
let landed = null, nowShown = null, chainMisses = 0;                 // the newest block seen landing and when; the sentence as drawn; chain reads unanswered in a row
const NEW_MS = 50_000;
const many = (n, one, more = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : more}`;
const KIND_SAID = { deposit: 'a deposit', transfer: 'a private transfer', withdrawal: 'a withdrawal', other: 'a settle' };
const kindSaid = (b) => (kindOf(b) === 'batch' ? `a batch of ${(b.notes || 0) + (b.spent || 0)} operations` : KIND_SAID[kindOf(b)]);
function paintNow() {
  const q = pool?.queued || 0, l = pool?.leased || 0;
  let state = '', html = 'Reading the network…';
  if (landed && Date.now() - landed.at < NEW_MS) {
    const b = landed.b, by = byOf(b, false);
    state = 'landed'; html = `Block <b>#${b.height.toLocaleString('en-US')}</b> just landed: ${esc(kindSaid(b))}${by ? `, proved by ${by}` : ''}.`;
  } else if (pool && l) { state = 'busy'; html = `<b>${many(l, 'proof')}</b> ${l === 1 ? 'is' : 'are'} being made right now${q ? `, ${q.toLocaleString('en-US')} more waiting` : ''}.`; }
  else if (pool && q) { state = 'busy'; html = `<b>${many(q, 'proof')}</b> ${q === 1 ? 'waits' : 'wait'} for a prover.`; }
  else if (pool && salts?.live?.length) { state = 'quiet'; html = `No proof is waiting. The nodes mine salts meanwhile${salts.rate ? `, ${esc(rateText(salts.rate))}` : ''}.`; }
  else if (pool) { state = 'quiet'; html = 'Quiet right now. A private deposit starts the next proof.'; }
  else if (chainMisses >= 2 && !blocks.length) html = 'The network is not answering. Trying again…';
  if (html !== nowShown) { nowShown = html; $('#net-say-t').innerHTML = html; }
  $('#net-say').dataset.s = state;
}
const beat = () => { const b = $('#net-beat'); b.classList.remove('ping'); void b.offsetWidth; b.classList.add('ping'); };
// A figure on the stage: written only when it changes, and lit for a moment when it does (not on its first reading).
function setNum(sel, text) {
  const el = $(sel);
  if (el.textContent === text) return;
  const first = el.textContent === '—';
  el.textContent = text;
  if (!first) { el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick'); }
}
// What a proof pays, on the stage's button: its points at what a point is paid today so far, said as today's figure once that is under the most a point
// may be paid (the day's points have outgrown the day's amount); the most while it is not, or while the day's points are unread.
function paintOffer() {
  const pts = pool?.terms?.pointsPerProof, most = rewardWei(pts, capOf(points)), now = rewardWei(pts, pointRate());
  $('#net-join-pay').textContent = now != null && most != null && now < most ? `${tac(now)} TAC a proof today` : most ? `up to ${tac(most)} TAC a proof` : '';
}

// With proofs waiting, what waits; with none, the nodes grinding salts meanwhile.
function waitingText() {
  const n = (pool?.queued || 0) + (pool?.leased || 0);
  return pool ? (n ? `${n} pending` : salts?.live?.length ? 'mining salts' : 'waiting for work') : '';
}

// The next block's tile: a square for each proof waiting in it (up to nine), the ones being proved lit; three slow ones while nothing waits.
function nextCells() {
  const q = pool?.queued || 0, l = pool?.leased || 0, n = Math.min(9, q + l);
  return n ? Array.from({ length: n }, (_, k) => `<i class="${k < l ? 'on' : 'q'}"></i>`).join('') : '<i></i><i></i><i></i>';
}
let nextShown = null;
function paintNet() {
  const q = pool?.queued ?? null, l = pool?.leased ?? null;
  const nx = document.getElementById('next-o');
  if (nx) nx.textContent = waitingText();
  // Nothing queued: the second cell says how fast the nodes grind salts meanwhile (the crowd below counts them).
  const mining = pool && !(q || l) && salts?.live?.length;
  $('#l-lease').textContent = mining ? 'Salts a second' : 'Proving now';
  setNum('#n-wait', q == null ? '—' : String(q));
  setNum('#n-lease', mining ? (salts.rate ? rateText(salts.rate).replace('/s', '') : '—') : l == null ? '—' : String(l));
  $('#s-lease').classList.toggle('hot', !mining && l > 0);
  $('#chain .blk.next')?.classList.toggle('busy', l > 0);
  // The last 24 hours (today's alone would drop to nothing at midnight UTC); today's from an API that does not count them yet.
  const provers = pool?.miners24h ?? pool?.minersToday, done = pool?.done24h ?? pool?.doneToday;
  setNum('#n-provers', provers == null ? '—' : provers.toLocaleString('en-US'));
  setNum('#n-done', done == null ? '—' : done.toLocaleString('en-US'));
  paintIdle(); paintNow(); paintOffer();
  const cells = nextCells(), ghost = $('#chain .cube.ghost');
  if (cells !== nextShown && ghost) { nextShown = cells; ghost.innerHTML = cells; }   // drawn again only when the counts change, so the lit squares keep their beat
  paintBoard();
}

// Today's provers: their proofs, the TAC those earn at today's rate so far and how fast they usually prove (from the newest proofs), and
// under them how the day's TAC is shared.
function paintBoard() {
  const top = pool?.top || [], pts = new Map((tally?.miners || []).map((m) => [String(m.miner).toLowerCase(), m.points]));
  const per = pointRate(), daily = points?.terms?.dailyWei, said = per && /^[1-9]\d*$/.test(String(daily ?? ''));
  $('#board-rate').hidden = !said;
  if (said) $('#board-rate').textContent = `${Number(tac(daily, 0)).toLocaleString('en-US')} TAC a day, shared by points: ${tac(per, 4)} TAC a point so far`;
  const lead = Math.max(1, ...top.map((m) => m.proofs || 0));
  if (!top.length) { if (!$('#board .empty')) $('#board').innerHTML = '<li class="empty">Nobody yet. Be first.</li>'; return; }
  const row = (m, i) => {
    const r = rewardWei(pts.get(String(m.miner).toLowerCase()), per), s = median(feed.filter((p) => p.miner === m.miner).map((p) => p.secs));
    return `<li${m.miner === me() ? ' class="me"' : ''} style="--w:${Math.max(3, Math.round((m.proofs / lead) * 100))}%"><span class="rk num">${i + 1}.</span>${who(m.miner)}<small>${m.proofs} ${m.proofs === 1 ? 'proof' : 'proofs'}</small><b>${r ? `${tac(r)} TAC` : ''}</b><small class="spd">${s ? `${esc(took(s))} each` : '–'}</small></li>`;
  };
  const mine = me() ? top.findIndex((m) => m.miner === me()) : -1;
  $('#board').innerHTML = top.slice(0, 8).map(row).join('') + (mine >= 8 ? `<li class="gap" aria-hidden="true"></li>${row(top[mine], mine)}` : '');
}

// The prover pot (GET /mine pocket): what the campaign has paid and what is left.
function paintPot() {
  // What a computer can expect: how long a proof takes the community (the middle of the newest, Tacit's own left out), and the salt pot's day.
  const secs = median(feed.filter((p) => !p.house && p.secs).map((p) => p.secs)), sp = salts?.pointsPerDay ? rewardWei(salts.pointsPerDay, pointRate()) : null;
  $('#typ-row').hidden = !secs; if (secs) $('#typ').textContent = took(secs);
  $('#saltpot-row').hidden = !sp; if (sp) $('#saltpot').textContent = `up to ${tac(sp)} TAC, shared by work`;
  const k = points?.pocket, ok = k && /^\d+$/.test(String(k.remainingWei)) && /^\d+$/.test(String(k.creditedWei));
  $('#pot-row').hidden = !ok;
  if (ok) $('#pot').textContent = `${Number(tac(k.remainingWei, 0)).toLocaleString('en-US')} TAC left · ${Number(tac(k.creditedWei, 0)).toLocaleString('en-US')} paid`;
}

let paidShown = null;
function paint() {
  const state = localState(health, mine), h = headline(state, mine), job = jobView(mine?.job);
  $('#state').dataset.s = state;
  // the stage's button says what this computer is doing once its node is on (it still goes to the node's card)
  const jt = state === 'proving' && mine?.on ? 'Your node is proving' : state === 'waiting' ? 'Your node is on' : 'Start proving', js = $('#net-join span');
  if (js.textContent !== jt) js.textContent = jt;
  // Once the line is copied, a computer with no prover yet is waiting for it to start.
  const tabOn = tab.state().on;
  $('#title').textContent = state === 'none' && tabOn ? 'Mining in this tab' : state === 'none' && copied ? 'Waiting for tacit-prover…' : h.title;
  $('#state').classList.toggle('copied', state === 'none' && copied && !tabOn);
  $('#state').classList.toggle('tab', state === 'none' && tabOn);
  // A tab left open shows what the node is doing; a browser that blocks the page from the computer's prover says so.
  document.title = state === 'proving' ? `Proving · ${BASE_TITLE}` : BASE_TITLE;
  $('#blocked').hidden = !(blocked && state === 'none');
  const forge = $('#forge');
  forge.hidden = !job;
  if (job) {
    $('#stage').textContent = `${job.stage} · ${job.left}`;
    forge.querySelectorAll('li').forEach((li, i) => {
      li.className = i < job.step ? 'done' : i === job.step ? 'now spin' : '';
    });
  }
  // A proof this computer just had taken: the reward it won, for a moment.
  if (mine && typeof mine.proved === 'number') {
    if (lastProved != null && mine.proved > lastProved) {
      const r = rewardWei(pool?.terms?.pointsPerProof, pointRate()), w = $('#win');
      w.textContent = r ? `+${tac(r)} TAC` : 'Proved';
      w.classList.remove('go'); void w.offsetWidth; w.classList.add('go');
      readRemote(); readFeed();
    }
    lastProved = mine.proved;
  }
  const go = $('#go');
  go.hidden = !h.button;
  go.textContent = other() ? 'Pay to this address' : h.button || '';
  go.disabled = busy;
  go.classList.toggle('ghost', h.button === 'Pause' && !other());
  paintMe();
  // the setup line also updates a node from before salt mining, or before gentle mining (view.js proverUpdate: a prover never updates itself)
  const setup = $('#setup'), words = setupText(os);
  setup.hidden = state !== 'none' && state !== 'old' && !proverUpdate(mine);
  // Windows' first step (installing Ubuntu) is for a computer with no prover yet; one that has it only updates, in Ubuntu
  setup.dataset.os = os;
  setup.toggleAttribute('data-first', state === 'none');
  // With no prover on this computer the first step is the tab (nothing to install); the setup line is the step after it, so its button steps back.
  $('#setup-more').hidden = state !== 'none' || isPhone(navigator.userAgent);
  $('#copy').classList.toggle('ghost', state === 'none');
  for (const b of setup.querySelectorAll('[data-os]')) b.setAttribute('aria-pressed', String(b.dataset.os === os));
  $('#copy').textContent = addr() ? words.button : words.need;
  $('#setup-hint').textContent = words.hint;
  $('#cmd').textContent = proveCommand(addr());
  const l = mineLines(pool, points, { tally, address: addr(), dayPoints: dayPoints() });
  $('#pays').textContent = l.pays || '—';
  paintPot();
  const mineRow = (tally?.miners || []).find((m) => String(m.miner).toLowerCase() === me());
  const earned = mineRow ? rewardWei(mineRow.points, pointRate()) : null;
  $('#today').textContent = mineRow ? `${mineRow.proofs} ${mineRow.proofs === 1 ? 'proof' : 'proofs'}${earned ? ` · ${tac(earned)} TAC` : ''}` : (l.today || '—');
  $('#today-row').hidden = !mineRow && !l.today;
  $('#payout-row').hidden = !mineRow;
  if (mineRow) $('#payout').textContent = `after the day ends, in ${untilDayEnds()}`;
  // At this address's rate so far today (from two hours into the day: there are only as many proofs as people press for), never past what
  // this computer's own pace or a count a day allows.
  const mySecs = median(feed.filter((p) => String(p.miner).toLowerCase() === me()).map((p) => p.secs));
  const into = (Date.now() % 86_400_000) / 86_400_000;
  const rate = mineRow && into >= 1 / 12 ? Math.round(mineRow.proofs / into) : 0;
  // What a proof has paid this address today on average, at today's rate so far, else what one proof pays at that rate.
  const perDay = rate ? Math.min(rate, pool?.terms?.proofsPerMinerDay || Infinity, mySecs ? Math.floor(86400 / mySecs) : Infinity) : null;
  const per = earned && mineRow.proofs ? earned / BigInt(mineRow.proofs) : rewardWei(pool?.terms?.pointsPerProof, pointRate());
  $('#pace-row').hidden = !(perDay && per);
  if (perDay && per) $('#pace').textContent = `about ${tac(per * BigInt(perDay))} TAC a day (${perDay} proofs)`;
  const credited = points?.account?.creditedWei;
  $('#paid-row').hidden = !/^\d+$/.test(String(credited ?? ''));
  const paid = $('#paid-row').hidden ? paidShown : `${esc(tac(credited))} TAC · <a href="/rewards/">Rewards</a>`;
  if (paid !== paidShown) { paidShown = paid; $('#paid').innerHTML = paid; }
  $('#run').textContent = mine?.proved ? String(mine.proved) : '0';
  $('#run-row').hidden = !mine || typeof mine.on !== 'boolean';
  paintSalt();
  paintReview();
}

// The address this computer's prover pays while it is on, when that is not the one in the field: the node says so, and its button moves it.
const other = () => { const m = mine?.on ? cleanAddress(mine.miner) : null; return m && me() && m.toLowerCase() !== me() ? m : null; };
let meShown = null;
function paintMe() {
  const a = addr(), o = other(), el = $('#me');
  if (meShown === `${a}|${o}`) return;                             // drawn again only when it changes, so the invader keeps marching
  meShown = `${a}|${o}`;
  el.innerHTML = o ? `${face(o, 40)}<span>This computer pays ${esc(short(o))}</span>` : a ? `${face(a, 40)}<span>${esc(short(a))}</span>` : '';
}

let remoteTimer = 0, markedFor = null;
function addressChanged() {
  const a = addr();
  paintMe();
  const typed = $('#addr').value.trim();
  $('#addr').setAttribute('aria-invalid', typed && !a ? 'true' : 'false');
  $('#addr-bad').textContent = typed && !a ? (/\.eth$/i.test(typed) ? 'Use the 0x address, not the name.' : 'That is not an address: 0x and 40 letters or digits.') : '';
  if (a) { try { localStorage.setItem(SAVED_ADDR, a); } catch {} if (!proverMining) tab.setMiner(a); }   // the tab's shares follow the address in the field (beside the prover, the prover's)
  misses = 0;
  paint();
  // The strip, the feed, the crowd and the GPU card mark this address: drawn again when it is another one, not on every keystroke; the
  // points service is asked once the typing pauses.
  if (markedFor !== me()) { markedFor = me(); if (blocks.length) paintChain(new Set()); paintFeed(); paintCrowd(); paintGpu(); }
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(() => readRemote().then(paint), 300);
}

async function toggle() {
  // Paying another address, the button moves this computer to the field's: a Start with that address.
  const sw = !!other(), on = sw || !mine?.on, a = addr();
  if (on && !a) { $('#addr').focus(); say('Enter the address the TAC goes to.', true); return; }
  busy = true; paint();
  try {
    const r = await fetch(`${LOCAL}/mine`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(on ? { miner: a, on } : { on }) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(j?.error || `tacit-prover answered ${r.status}`);
    mine = j;
    say(sw ? `This computer now pays ${short(a)}.` : on ? 'Started. The first proof downloads 6.2 GB before it begins.' : (mine.job ? 'Pausing after the proof under way.' : 'Paused.'));
  } catch (e) { say(e.message || 'tacit-prover did not answer.', true); }
  busy = false; paint();
}

function say(text, bad = false) {
  const s = $('#say');
  s.textContent = text;
  s.classList.toggle('err', bad);
}

// The GPU card: the command for this address, what a Bitcoin batch pays (the board's points for it, at what a point is paid today so far),
// how many GPUs are on the board (asked for work in the last two minutes, or proving a batch: one asks for nothing while it proves), and
// this address's own GPU (its board name is c-<address>).
let boardPay = null, gpus = null, houseGpu = null;
// A GPU proves Bitcoin batches and, once the board offers them, the Tacit chain's blocks (program 'tacit-block'): both are public work.
const BTC = 'btc-state', BLOCK = 'tacit-block', GPU_NAME = /^c-(0x[0-9a-f]{40})$/;
const cleanGpus = (ws) => (Array.isArray(ws) ? ws.filter((w) => w && w.community === true && GPU_NAME.test(String(w.name)) && Array.isArray(w.programs) && (w.programs.includes(BTC) || w.programs.includes(BLOCK)))
  .map((w) => ({ miner: GPU_NAME.exec(w.name)[1], proved: count(w.proved) || 0, seen: count(w.lastSeenSeconds), proving: w.racing === BTC ? 'a batch' : w.racing === BLOCK ? 'a block' : null, blocks: w.programs.includes(BLOCK) })) : null);
// Tacit's own GPU is on the board under its own name (not a community `c-` one): on when it asked for work in the last two minutes.
const houseOn = (ws) => (Array.isArray(ws) ? ws.some((w) => w && w.community !== true && count(w.lastSeenSeconds) != null && w.lastSeenSeconds < 120) : null);
const gpuOn = (g) => g.proving || (g.seen != null && g.seen < 120);
const gpuCommand = () => `curl -fsSL https://tacit.finance/prove-gpu.sh | sh -s -- ${addr() || '0xYourAddress'}`;
function paintGpu() {
  $('#gpu-cmd').textContent = gpuCommand();
  $('#gpu-copy').textContent = gpuCopied ? 'Copied' : addr() || $('#desk').hidden ? 'Copy' : 'Add address';
  const pts = Number(boardPay?.pointsByProgram?.[BTC]), r = Number.isSafeInteger(pts) ? rewardWei(pts, pointRate()) : null;
  const bpts = Number(boardPay?.pointsByProgram?.[BLOCK]), br = Number.isSafeInteger(bpts) ? rewardWei(bpts, pointRate()) : null;
  $('#btc-pay').textContent = r && br ? `${tac(r)} TAC a batch, ${tac(br)} a chain block` : r ? `${tac(r)} TAC each` : '';
  $('#gpu-n').textContent = gpus ? (houseGpu ? `${gpus.filter(gpuOn).length + 1} · Tacit's ${gpus.filter(gpuOn).length ? 'included' : 'own'}` : String(gpus.filter(gpuOn).length)) : '—';
  const g = gpus && me() ? gpus.find((x) => x.miner === me()) : null;
  $('#gpu-me-row').hidden = !g;
  const unit = g?.blocks ? ['proof', 'proofs'] : ['batch', 'batches'];
  if (g) $('#gpu-me').textContent = `${g.proving ? `proving ${g.proving}` : gpuOn(g) ? 'waiting for its turn' : `seen ${ago(Date.now() - (g.seen || 0) * 1000)}`} · ${g.proved} ${g.proved === 1 ? unit[0] : unit[1]}`;
}
async function readBoardPay() { const s = await get(`${API}/prover/board`); if (s?.pay) boardPay = s.pay; if (s) { gpus = cleanGpus(s.workers); houseGpu = houseOn(s.workers); } paintGpu(); }
let gpuCopied = false;
$('#gpu-copy').addEventListener('click', async () => {
  if (!addr() && !$('#desk').hidden) { askAddress(); return; }
  try { await navigator.clipboard.writeText(gpuCommand()); gpuCopied = true; paintGpu(); setTimeout(() => { gpuCopied = false; paintGpu(); }, 1500); } catch {}
});
// The code-review card (review.js): this computer's help desk job, switched on and off here, the line that gets its model, and the address's review record.
function paintReview() {
  const v = reviewView({ proverUp: !!health?.ok, desk, stats: deskStats, me: me() });
  $('#review-state').textContent = v.state; $('#review-n').textContent = v.online;
  $('#review-get').hidden = !v.cmd; $('#review-cmd').textContent = FETCH_CMD;
  const go = $('#review-go'); go.hidden = !v.button; if (v.button) go.textContent = reviewBusy ? '…' : v.button; go.disabled = reviewBusy;
  $('#review-me-row').hidden = !v.record; if (v.record) $('#review-me').textContent = v.record;
}
function reviewSay(text, bad = false) { const s = $('#review-say'); s.textContent = text; s.hidden = !text; s.classList.toggle('err', bad); }
async function toggleReview() {
  if (!desk) return;
  reviewBusy = true; paintReview();
  try {
    const r = await fetch(`${LOCAL}/helpdesk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: !desk.on, api: HELPDESK }) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(j?.error || `tacit-prover answered ${r.status}`);
    desk = cleanDesk(j); reviewSay('');   // the status row says what it does now; the note is for what went wrong
  } catch (e) { reviewSay(e.message || 'tacit-prover did not answer.', true); }
  reviewBusy = false; paintReview();
}
async function readReview() { deskStats = cleanStats(await get(`${HELPDESK}/stats`, 8000)); paintReview(); }
$('#review-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(FETCH_CMD); $('#review-copy').textContent = 'Copied'; setTimeout(() => { $('#review-copy').textContent = 'Copy'; }, 1500); } catch {}
});
$('#review-go').addEventListener('click', toggleReview);
// A copy button with no address to put in its line takes the reader to the field.
function askAddress() {
  const f = $('#addr');
  f.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  f.focus();
  say('Enter the address the TAC goes to.', true);
}

// Salt mining (worker/src/salt-pool.js): the day's points shared by work, this address's part of them so far, what this computer grinds
// (tacit-prover's GET /mine `salt`), and the best addresses banked for Tacit's next contracts.
const HEX40 = /^0x[0-9a-f]{40}$/;
const cleanFind = (b) => ({ address: HEX40.test(String(b?.address)) ? b.address : null, bits: count(b?.bits), miner: cleanAddress(b?.miner), house: b?.house === true, at: count(b?.at) });
const cleanSalts = (s) => (s && typeof s === 'object' ? {
  minBits: count(s.minBits), maxWeightBits: count(s.maxWeightBits), pointsPerDay: count(s.pointsPerDay), miners: count(s.today?.miners), shares: count(s.today?.shares), weight: Number(s.today?.weight) || 0,
  top: (Array.isArray(s.top) ? s.top : []).map((m) => ({ miner: cleanAddress(m?.miner), weight: Number(m?.weight) || 0, shares: count(m?.shares),
    best: HEX40.test(String(m?.best?.address)) && count(m?.best?.bits) ? { address: m.best.address, bits: m.best.bits } : null })).filter((m) => m.miner),
  bank: (Array.isArray(s.bank) ? s.bank : []).map(cleanFind).filter((b) => b.address), banked: count(s.banked) || 0,
  // The newest good finds (`recent`, from the API that keeps them); an older API has only the bank, whose finds carry a time too.
  recent: (Array.isArray(s.recent) ? s.recent : Array.isArray(s.bank) ? s.bank : []).map(cleanFind)
    .filter((b) => b.address && b.bits && b.at && (b.house || b.miner)),
  // every node the pool lists as grinding now: the floor counts them all and draws as many as fit its row (the limit is only against an answer of absurd length)
  live: (Array.isArray(s.live) ? s.live : []).map((m) => ({ miner: cleanAddress(m?.miner)?.toLowerCase() || null, house: m?.house === true })).filter((m) => m.miner).slice(0, 2000),
  rate: Number.isFinite(Number(s.rate)) && Number(s.rate) >= 0 ? Number(s.rate) : 0,
} : null);
let bankShown = null, bestShown = null, bestHtmlShown = null;
// Every banked address (GET /prover/salt/bank: the summary lists only the best ten), and which of them hold a contract now. A banked salt
// can only be used by Tacit's deployer, so code at its address means it was spent: that deploy is how the work gets used.
let fullBank = null, bankReadAt = 0;
const deployed = new Set(), codeChecked = new Map();
const ETH_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'], RECHECK_MS = 10 * 60_000;
// An address's row: its zero bytes picked out, who found it, and a link to the contract if it was spent.
const saltRow = (b, cls = '') => {
  const z = Math.floor((b.bits || 0) / 4), used = deployed.has(b.address), c = [cls, used ? 'used' : ''].filter(Boolean).join(' ');
  return `<li${c ? ` class="${c}"` : ''}><code title="${esc(b.address)}"><b>${esc(b.address.slice(0, 2 + z))}</b>${esc(b.address.slice(2 + z, 18))}…</code><small>${used ? `<a class="dep" href="https://etherscan.io/address/${esc(b.address)}" target="_blank" rel="noopener noreferrer">Deployed</a>` : ''}${b.house ? `<span class="who">${face(null)}Tacit GPU</span>` : b.miner ? who(b.miner) : ''}</small></li>`;
};
function paintSalt() {
  const potWei = salts?.pointsPerDay ? rewardWei(salts.pointsPerDay, pointRate()) : null;
  // What the day's proofs leave of the daily pot so far (worker/src/salt-pool.js): it shrinks as proofs come in, so "up to".
  $('#salt-pay').textContent = potWei ? ` · up to ${tac(potWei)} TAC today` : '';
  // A node from before salt mining, or before gentle mining, is told to run the setup line again: it installs the newest.
  if (proverUpdate(mine)) $('#salt-day').textContent = updateText(proverUpdate(mine));
  else if (salts) $('#salt-day').textContent = `Shared by work across ${salts.miners || 0} ${salts.miners === 1 ? 'node' : 'nodes'}. Proofs come first.`;
  // The day's best find, on its own line (the bank's own stars below it): from the nodes' bests today and any find the pool lists as made today.
  const t0 = utcStart();
  const best = [...(salts?.top || []).filter((m) => m.best).map((m) => ({ ...m.best, miner: m.miner })), ...(salts?.bank || []).filter((b) => b.at >= t0), ...(salts?.recent || []).filter((b) => b.at >= t0)]
    .reduce((a, b) => (!a || b.bits > a.bits ? b : a), null);
  $('#salt-best-h').hidden = !best;
  if (best) {
    const aw = saltAward(best);
    $('#salt-best-h').textContent = `Best today · ${zeroBytes(best.bits)}${aw ? ` · ${awardText(aw)}` : ''}`;
  }
  const bestHtml = best ? saltRow(best, bestShown != null && bestShown !== best.address ? 'new' : '') : '';
  if (bestHtml !== bestHtmlShown) { bestHtmlShown = bestHtml; bestShown = best?.address ?? bestShown; $('#salt-best').innerHTML = bestHtml; }
  // The bank's best (five zero bytes and better); until it has one, the best addresses ground today, so the panel shows the hunt.
  const apiBank = salts?.bank?.length ? salts.bank : null;
  const banked = fullBank?.length && fullBank.length >= (apiBank?.length || 0) ? fullBank : apiBank;
  const finds = (banked || (salts?.top || []).filter((m) => m.best).map((m) => ({ ...m.best, miner: m.miner })).sort((a, b) => b.bits - a.bits)).filter((b) => b.address !== best?.address);
  $('#salt-bank-h').hidden = !finds.length;
  // How many are banked and how many of those have been deployed to; the list below scrolls through all of them.
  const spent = banked ? banked.filter((b) => deployed.has(b.address)).length : 0;
  $('#salt-bank-h').textContent = banked ? `Banked for deploys · ${Math.max(banked.length, salts?.banked || 0)}${spent ? ` · ${spent} deployed` : ''}` : 'Best found today';
  const bank = finds.map((b) => saltRow(b)).join(''), box = $('#salt-bank');
  if (bank !== bankShown) { bankShown = bank; const at = box.scrollTop; box.innerHTML = bank; box.scrollTop = at; }   // rows with a picture each: drawn again only when they change, where the reader had scrolled to
  moreBelow();
  const rate = Number(mine?.salt?.rate), mineRow = (salts?.top || []).find((m) => m.miner.toLowerCase() === me());
  const part = mineRow && salts.weight && salts.pointsPerDay ? rewardWei(Math.floor((salts.pointsPerDay * mineRow.weight) / salts.weight), pointRate()) : null;
  const on = mine?.salt?.on === true && Number.isFinite(rate) && rate > 0;
  $('#salt-row').hidden = !(on || mineRow);
  $('#salt').textContent = [mineRow ? `${(mineRow.shares || 0).toLocaleString('en-US')} shares` : null, part ? `${tac(part)} TAC so far` : null, on ? rateText(rate) : null].filter(Boolean).join(' · ') || '—';
  if (salts?.minBits) tab.setMinBits(salts.minBits);
  paintTab();
}
// Whether this computer's tacit-prover is mining, as last heard, and the address it pays. A read that gets no answer (a busy computer can be slow to say) is not
// a pause: the prover is taken as stopped when it says so, or after three reads in a row with no answer. The tab's miner goes by this, so one slow read does not
// send it to the cores and the field's address and back.
let proverMining = false, proverMiner = null, proverSilent = 0, proverHeard = false;
function hearProver() {
  if (mine && typeof mine.on === 'boolean') { proverMining = mine.on; proverMiner = cleanAddress(mine.miner) || proverMiner; proverSilent = 0; proverHeard = true; }
  else if (++proverSilent >= 3) { proverMining = false; proverHeard = false; }
}
// Salt mining in this tab (tabmine.js), for a visitor with nothing installed: threads of this page grind the same salts tacit-prover grinds between proofs and
// send their shares for the address in the field. A quarter of the cores unless the person asks for more; not on battery; not while this computer's tacit-prover
// is mining on the cores: then the tab adds the GPU alone, for the address the prover pays (the prover grinds on cores only); in one tab at a time. Where the browser has WebGPU the GPU grinds too
// (saltgpu.js), many times what the cores do: at half by default (it rests as long as it works, so the screen stays smooth), full or off as the person picks.
const CORES = navigator.hardwareConcurrency || 2, SAVED_THREADS = 'tacit-prove-tab-threads';
const savedThreads = () => { try { const n = Number(localStorage.getItem(SAVED_THREADS)); return Number.isInteger(n) && n >= 1 && n <= maxThreads(CORES) ? n : null; } catch { return null; } };
const SAVED_GPU = 'tacit-prove-tab-gpu';
const savedGpu = () => { try { const g = localStorage.getItem(SAVED_GPU); return GPU_LEVELS.includes(g) ? g : null; } catch { return null; } };
let tabThreads = savedThreads() ?? defaultThreads(CORES), tabLock = null, tabNote = '', onBattery = false, batteryOk = false, gpuAble = false, tabGpu = savedGpu() ?? 'half';
const tab = makeTabMiner({ api: API, makeWorker: () => new Worker('/prove/salt-worker.js?cb=6df5c0ae', { type: 'module' }), onChange: () => paintTab() });
const holdTab = () => (navigator.locks ? new Promise((res) => { navigator.locks.request('tacit-prove-tab-miner', { ifAvailable: true }, (lock) => { if (!lock) { res(false); return undefined; } res(true); return new Promise((r) => { tabLock = r; }); }).catch(() => res(true)); }) : Promise.resolve(true));
async function tabStart() {
  const beside = proverMining, a = beside ? proverMiner || addr() : addr();   // beside the prover: its address, and the GPU alone
  if (!a) { askAddress(); return; }
  if (tab.state().on || (beside && !gpuAble)) return;
  if (!(await holdTab())) { tabNote = 'Another tab is mining already.'; paintTab(); return; }
  tabNote = ''; say('');   // an earlier "enter the address" is answered
  if (beside && tabGpu === 'off') tabGpu = 'half';
  tab.start({ miner: a, threads: beside ? 0 : tabThreads, minBits: salts?.minBits || 26, gpu: gpuAble ? tabGpu : 'off' });
  paint();
}
function tabStop(o) { tab.stop(o); tabLock?.(); tabLock = null; paint(); }
function tabStep(d) {
  tabThreads = Math.min(maxThreads(CORES), Math.max(1, tabThreads + d));
  try { localStorage.setItem(SAVED_THREADS, String(tabThreads)); } catch {}
  if (!proverMining) tab.setThreads(tabThreads);
  paintTab();
}
function paintTab() {
  const s = tab.state(), go = $('#tab-go'), beside = proverMining, phone = isPhone(navigator.userAgent);
  // tacit-prover has the cores while it mines: the tab keeps the GPU alone, for the prover's address, or stops if it has none; the cores come back when it pauses
  if (s.on && beside && s.threads !== 0) { if (s.gpu.on) { tab.setThreads(0); tab.setMiner(proverMiner || s.miner); } else tabStop(); return; }
  if (s.on && !beside && s.threads === 0) { tab.setThreads(tabThreads); if (addr()) tab.setMiner(addr()); return; }
  if (s.on && s.threads === 0 && !s.gpu.on && !s.paused) { tabNote = s.gpu.failed ? 'The GPU could not be used here.' : ''; tabStop(); return; }   // nothing left to grind on
  go.hidden = phone || (beside && !gpuAble);
  go.textContent = s.on ? (beside ? 'Stop the GPU in this tab' : 'Stop mining in this tab') : beside ? 'Add this computer\'s GPU' : addr() ? 'Mine in this tab' : 'Enter your address first';
  go.classList.toggle('ghost', s.on);
  $('#tab-rows').hidden = !s.on;
  const note = s.error || tabNote || (s.on && s.gpu.failed ? 'The GPU could not be used here: mining on the cores.' : ''); $('#tab-say').textContent = note; $('#tab-say').hidden = !note; $('#tab-say').classList.toggle('err', !!s.error);
  $('#tab-battery').hidden = !(s.on && s.paused === 'battery');
  // what this pace can expect in a day: its part of the day's salt points by weight (tabmine.js dayShare), at what a point is paid today so far
  const share = dayShare({ rate: s.rate, minBits: salts?.minBits || 26, maxWeightBits: salts?.maxWeightBits ?? 20, netWeight: salts?.weight || 0, netRate: salts?.rate || 0, dayFrac: (Date.now() % 86_400_000) / 86_400_000 });
  const paceWei = share && salts?.pointsPerDay ? rewardWei(Math.floor(salts.pointsPerDay * share), pointRate()) : null;
  const pace = paceWei ? `about ${tac(paceWei) === '0' ? 'under 0.01' : tac(paceWei)} TAC a day` : '';
  // the node card's own button and line, for a computer with no prover: the tab is its first step
  const main = $('#tab-main'), first = localState(health, mine) === 'none' && !proverHeard && !phone;   // not for a prover that only missed a read
  main.hidden = !first; main.textContent = s.on ? 'Stop' : addr() ? 'Start in this tab' : 'Enter your address first'; main.classList.toggle('ghost', s.on);
  const mainSay = $('#tab-main-say'); mainSay.hidden = !first;
  mainSay.textContent = !s.on ? `Nothing to install. ${gpuAble ? 'This computer\'s GPU and a few of its cores mine' : 'A few of this computer\'s cores mine'} contract addresses while this tab is open.`
    : s.paused === 'battery' ? 'Paused on battery.' : [s.rate ? rateText(s.rate) : 'Starting…', pace].filter(Boolean).join(' · ');
  if (!s.on) return;
  $('#tab-rate').textContent = s.paused === 'battery' ? 'Paused on battery' : s.rate ? rateText(s.rate) : 'Starting…';
  $('#tab-cores-row').hidden = beside;
  $('#tab-n').textContent = `${tabThreads} of ${CORES}`;
  $('#tab-less').disabled = tabThreads <= 1; $('#tab-more').disabled = tabThreads >= maxThreads(CORES);
  $('#tab-gpu-row').hidden = !gpuAble;
  for (const b of document.querySelectorAll('#tab-gpu-row [data-gpu]')) b.setAttribute('aria-pressed', String(b.dataset.gpu === (s.gpu.failed ? 'off' : tabGpu)));
  // what the pool has counted for the address today, and its part of the day's salt points so far; before the first share, about how long one takes
  const part = s.today && salts?.weight && salts.pointsPerDay ? rewardWei(Math.floor((salts.pointsPerDay * s.today.weight) / Math.max(salts.weight, s.today.weight)), pointRate()) : null;
  const eta = s.rate ? Math.max(1, Math.round(2 ** (salts?.minBits || 26) / s.rate / 60)) : null;
  $('#tab-today').textContent = s.today?.shares ? [`${s.today.shares.toLocaleString('en-US')} ${s.today.shares === 1 ? 'share' : 'shares'}`, part ? `${tac(part) === '0' ? '< 0.01' : tac(part)} TAC so far` : null].filter(Boolean).join(' · ')
    : s.waiting ? 'First share found, sending' : s.paused ? '—' : eta ? `First share in about ${eta} min` : '—';
  $('#tab-pace-row').hidden = !pace; $('#tab-pace').textContent = pace;
}
$('#tab-go').addEventListener('click', () => (tab.state().on ? tabStop() : tabStart()));
$('#tab-less').addEventListener('click', () => tabStep(-1));
$('#tab-more').addEventListener('click', () => tabStep(1));
$('#tab-main').addEventListener('click', () => (tab.state().on ? tabStop() : tabStart()));
for (const b of document.querySelectorAll('#tab-gpu-row [data-gpu]')) b.addEventListener('click', () => {
  tabGpu = b.dataset.gpu; try { localStorage.setItem(SAVED_GPU, tabGpu); } catch {}
  if (tabGpu === 'off' && proverMining) { tabStop(); return; }   // beside the prover the GPU is all the tab does
  tab.setGpu(tabGpu); paintTab();
});
// whether this browser has a GPU the page may use: asked once, without asking for the fast one (the grinding thread does, when it starts); a miner already running takes it up
Promise.resolve(navigator.gpu?.requestAdapter?.()).then((a) => { gpuAble = !!a; if (gpuAble && tab.state().on) tab.setGpu(tabGpu); paintTab(); }).catch(() => {});
// On battery it waits for the charger, as tacit-prover does, unless the person says to go on (for this visit).
const batteryPause = () => tab.setPaused(onBattery && !batteryOk ? 'battery' : null);
navigator.getBattery?.().then((b) => { const set = () => { onBattery = !b.charging; batteryPause(); }; b.addEventListener('chargingchange', set); set(); }).catch(() => {});
$('#tab-battery').addEventListener('click', () => { batteryOk = true; batteryPause(); paintTab(); });
addEventListener('pagehide', () => { if (tab.state().on) tabStop({ keepalive: true }); });
setInterval(() => { if (tab.state().on) paintTab(); }, 1000);
// A long list fades at its foot while there is more below it.
const moreBelow = () => { const b = $('#salt-bank'); b.classList.toggle('more', b.scrollTop + b.clientHeight < b.scrollHeight - 2); };
$('#salt-bank').addEventListener('scroll', moreBelow, { passive: true });
// Every banked address, about once a minute (the API caches it that long).
async function readBank() {
  if (Date.now() - bankReadAt < 55_000) return;
  bankReadAt = Date.now();
  const b = await get(`${API}/prover/salt/bank`);
  if (Array.isArray(b?.bank)) fullBank = b.bank.map(cleanFind).filter((x) => x.address);
}
// Which of the banked addresses hold code (one batched eth_getCode): a spent one stays spent, the rest are asked again every ten minutes.
async function readDeployed() {
  const now = Date.now(), due = [...new Set((fullBank || salts?.bank || []).map((b) => b.address))].filter((a) => !deployed.has(a) && now - (codeChecked.get(a) || 0) > RECHECK_MS);
  if (!due.length) return;
  for (const a of due) codeChecked.set(a, now - RECHECK_MS + 60_000);   // an RPC that fails is tried again in a minute, not every poll
  const body = JSON.stringify(due.map((a, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_getCode', params: [a, 'latest'] })));
  for (const url of ETH_RPCS) {
    try {
      const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(8000) })).json();
      if (!Array.isArray(j)) continue;
      for (const x of j) {
        const a = Number.isInteger(x?.id) ? due[x.id] : null;
        if (!a || typeof x.result !== 'string' || !/^0x[0-9a-f]*$/i.test(x.result)) continue;
        codeChecked.set(a, now);
        if (x.result.length > 2) deployed.add(a);
      }
      return;
    } catch {}
  }
}
async function readSalts() {
  const bank = readBank();                                          // asked beside the summary, not after it
  const s = await get(`${API}/prover/salt`); if (s) salts = cleanSalts(s);
  saltsTried = true;
  paintCrowd();                                                     // the floor does not wait for the bank's reading below
  await bank;
  paintSalt(); paintNet(); paintCrowd(); paintFeed();
  saltTop = Math.max(saltTop, goodSalts()[0]?.at || 0);
  const had = deployed.size;
  await readDeployed();
  if (deployed.size !== had) paintSalt();                           // a spent address is marked as soon as the chain says so
}

async function copy() {
  const a = addr();
  if (!a) { askAddress(); return; }
  try { await navigator.clipboard.writeText(proveCommand(a)); copied = true; misses = 0; paint(); say(setupText(os).copied); }
  catch {
    const sel = getSelection(), range = document.createRange();
    range.selectNodeContents($('#cmd')); sel.removeAllRanges(); sel.addRange(range);
    say('Press Cmd+C or Ctrl+C to copy it.');
  }
}

// The Relay and Bitcoin tabs' code (the wallet, the header relay, the board's settles) is most of the page's weight and most visitors never
// open those tabs, so it loads when one opens, when the wallet chip is pressed, or when either is pointed at. A browser with a wallet to
// connect again or a relay account (whose settles are sent or seen home from any tab) has it once the page has settled; a wallet connected
// in another tab loads it here too.
let opsLoad = null, opsReady = false;
const loadOps = () => (opsLoad ||= import('/prove/ops.js?cb=a0dbfd2b').then((m) => { opsReady = true; return m; }));
$('#wallet').title = 'Connect an Ethereum wallet to pay the network fee';
$('#wallet').addEventListener('click', async (e) => {
  if (opsReady) return;                                            // loaded: ops.js has its own handler on the chip
  e.preventDefault();
  await loadOps().catch(() => {});
  $('#wallet').click();
}, { once: true });
for (const el of [$('#wallet'), $('#tb-relay'), $('#tb-bitcoin')]) for (const ev of ['pointerenter', 'focus']) el.addEventListener(ev, () => { loadOps().catch(() => {}); }, { once: true });
const OPS_KEYS = ['tacit-trade-wallet', 'tacit-relay-account-v1'];   // evm-wallet.js's remembered wallet, ops.js's relay account
const opsWanted = () => { try { return OPS_KEYS.some((k) => localStorage.getItem(k)); } catch { return false; } };
const whenIdle = (fn) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 8000 }) : setTimeout(fn, 4000));
addEventListener('load', () => setTimeout(() => whenIdle(() => { if (opsWanted()) loadOps().catch(() => {}); }), 2500), { once: true });
addEventListener('storage', (e) => { if (e.storageArea === localStorage && e.key === OPS_KEYS[0] && e.newValue) loadOps().catch(() => {}); });

// The node's jobs as tabs: #tab=relay or #tab=bitcoin opens one (a link from a waiting lock carries need= and why= beside it), and the
// other jobs' reads start the first time one of their tabs opens. Each card has its own link too, /prove/#<its data-card>: that opens
// its tab, brings it into view and marks it for a moment; each card's Link copies that address.
const TABS = ['prove', 'relay', 'bitcoin'];
const CARDS = new Map([...document.querySelectorAll('[data-card]')].map((el) => [el.dataset.card, el]));
const cardOf = () => (CARDS.has(location.hash.slice(1)) ? location.hash.slice(1) : null);
function showTab(name, { write = true } = {}) {
  const t = TABS.includes(name) ? name : 'prove';
  for (const n of TABS) {
    $(`#t-${n}`).hidden = n !== t;
    $(`#tb-${n}`).setAttribute('aria-selected', String(n === t));
    $(`#tb-${n}`).tabIndex = n === t ? 0 : -1;
  }
  if (t !== 'prove') loadOps().then((m) => m.startOps()).catch(() => {});
  if (write) {
    const h = new URLSearchParams(cardOf() ? '' : location.hash.slice(1));
    if (t === 'prove') h.delete('tab'); else h.set('tab', t);
    history.replaceState(null, '', `${location.pathname}${location.search}${[...h].length ? `#${h}` : ''}`);
  }
}
const tabFor = (el) => el.closest('[role="tabpanel"]')?.id.slice(2) || 'prove';
const tabOf = () => (cardOf() ? tabFor(CARDS.get(cardOf())) : new URLSearchParams(location.hash.slice(1)).get('tab') || 'prove');
function showCard(name, behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth') {
  const el = CARDS.get(name);
  showTab(tabFor(el), { write: false });
  el.scrollIntoView({ block: 'start', behavior });
  mark(el);
}
const mark = (el) => { el.classList.remove('lit'); void el.offsetWidth; el.classList.add('lit'); };
const LINK_MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>';
for (const [name, el] of CARDS) {
  const a = document.createElement('a');
  a.className = 'card-link'; a.href = `#${name}`; a.title = 'Copy a link to this card'; a.setAttribute('aria-label', 'Copy a link to this card');
  a.innerHTML = `${LINK_MARK}<span>Link</span>`;
  a.addEventListener('click', async (e) => {
    e.preventDefault();
    history.replaceState(null, '', `${location.pathname}${location.search}#${name}`);
    mark(el);
    let said = 'In the address bar';
    try { await navigator.clipboard.writeText(`https://tacit.finance/prove/#${name}`); said = 'Copied'; } catch {}
    a.classList.add('done'); a.lastChild.textContent = said; $('#live').textContent = said === 'Copied' ? 'Link copied' : '';
    clearTimeout(a.t); a.t = setTimeout(() => { a.classList.remove('done'); a.lastChild.textContent = 'Link'; }, 1600);
  });
  (el.querySelector('.eyebrow') || el.querySelector('h2'))?.append(a);
}
for (const n of TABS) $(`#tb-${n}`).addEventListener('click', () => showTab(n));
$('.tabs').addEventListener('keydown', (e) => {
  const i = TABS.indexOf(tabOf()), d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!d) return;
  const n = TABS[(i + d + TABS.length) % TABS.length];
  showTab(n); $(`#tb-${n}`).focus();
});
window.addEventListener('hashchange', () => (cardOf() ? showCard(cardOf()) : showTab(tabOf(), { write: false })));
if (cardOf()) {
  showCard(cardOf(), 'auto');
  // The network strip and the rows above get their height as the network answers, sooner or later. Until the reader scrolls, presses something, or eight seconds
  // have passed, the card is kept where the link put it: each frame, if it is not where a scroll to it would leave it, it is scrolled to again.
  const linked = CARDS.get(cardOf()); let held = true;
  const margin = parseFloat(getComputedStyle(linked).scrollMarginTop) || 0;
  const keep = () => {
    if (!held) return;
    const want = Math.max(0, Math.min(linked.getBoundingClientRect().top + scrollY - margin, document.documentElement.scrollHeight - innerHeight));
    if (Math.abs(scrollY - want) > 2) linked.scrollIntoView({ block: 'start', behavior: 'instant' });
    requestAnimationFrame(keep);
  };
  const letGo = () => { held = false; };
  for (const ev of ['wheel', 'touchmove', 'keydown', 'mousedown']) addEventListener(ev, letGo, { once: true, passive: true });
  requestAnimationFrame(keep); setTimeout(letGo, 8000);
} else showTab(tabOf(), { write: false });

// The stage's button goes to where proving starts: the node's card and its address field; on a phone, the card that sends the page to a computer.
$('#net-join').addEventListener('click', () => {
  if ($('#desk').hidden) {
    showTab('prove');
    $('#phone').scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    mark($('#phone'));
    return;
  }
  showCard('node');
  if (!addr()) $('#addr').focus({ preventScroll: true });
});

$('#chain').addEventListener('click', (e) => {
  const li = e.target.closest('.blk');
  if (!li || li.classList.contains('next')) return;
  const h = Number(li.dataset.h);
  picked = picked === h ? null : h;
  $('#chain').querySelectorAll('.blk').forEach((x) => x.setAttribute('aria-current', String(Number(x.dataset.h) === picked)));
  paintDetail();
});

try { const saved = localStorage.getItem(SAVED_ADDR); if (cleanAddress(saved)) $('#addr').value = saved; } catch {}
paintMe();
// One read that throws is let go: the next goes on at its time. `ms` may be a function, asked before each wait. In a hidden tab a read after
// the first waits, unless `always` says it is needed there too, and every read that waited runs as soon as the tab is shown again.
const waiting = new Set();
const loop = (fn, ms, idle, always) => {
  let timer = 0, ran = false;
  const run = async () => {
    clearTimeout(timer); waiting.delete(run);
    if (ran && document.hidden && !always?.()) waiting.add(run);
    else { ran = true; try { await fn(); } catch {} }
    timer = setTimeout(run, document.hidden ? idle : typeof ms === 'function' ? ms() : ms);
  };
  run();
};
document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const run of [...waiting]) run(); });
// The chain every six seconds, the pool and the feed every ten, the points service every half minute.
loop(readChain, 6000, 30000);
loop(readFeed, 10000, 60000);
loop(async () => { const p = await get(`${API}/prover/pool`); if (p) pool = cleanPool(p); paintNet(); }, 10000, 60000);
loop(readRemote, 30000, 120000);
loop(readBoardPay, 60000, 300000);
loop(readSalts, 30000, 120000, () => tab.state().on);              // a miner in this tab takes the pool's share threshold from it
// The help desk is asked for its figures only once the code-review card is in view or about to be: a visit that never reaches the card says nothing to it.
{
  let started = false;
  const start = () => { if (started) return; started = true; loop(readReview, 60000, 300000); };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); start(); } }, { rootMargin: '200px' });
    io.observe($('#review'));
  } else start();
}
// The day's checkpoint (worker/src/pool-snapshot-job.js): the tacit block, Bitcoin's height as the pool sees it, and the manifest on IPFS
// that holds them, named on Ethereum by snapshot.tacit.wei. Anyone can rebuild every part of it from Ethereum.
const HEX32 = /^0x[0-9a-f]{64}$/i, CID = /^b[a-z2-7]{58}$/;
async function readCheckpoint() {
  const s = await get(`${API}/pool/snapshot`), c = s?.checkpoint, el = $('#checkpoint');
  // Bitcoin's height as far as the pool's verifier has taken it in (the reflection), else as far as the light relay has seen it.
  const height = count(c?.tacit?.height), btc = count(c?.bitcoin?.reflection?.height) ?? count(c?.bitcoin?.relayTip);
  const slot = count(c?.ethereum?.finalizedSlot);
  if (!CID.test(String(s?.cid)) || height == null || !HEX32.test(String(c?.tacit?.hash))) { el.hidden = true; return; }
  el.innerHTML = `Block #${height.toLocaleString('en-US')} <code>${esc(c.tacit.hash.slice(0, 10))}…</code>${btc != null ? ` · Bitcoin ${btc.toLocaleString('en-US')}` : ''}${slot != null ? ` · Ethereum slot ${slot.toLocaleString('en-US')}` : ''} · <a href="https://ipfs.filebase.io/ipfs/${esc(s.cid)}" target="_blank" rel="noopener noreferrer">snapshot.tacit.wei</a>`;
  el.hidden = false;
}
loop(readCheckpoint, 300000, 900000);
$('#send-page').addEventListener('click', async (e) => {
  const url = 'https://tacit.finance/prove/', b = e.currentTarget;
  try { if (navigator.share) { await navigator.share({ title: 'tacit prove', url }); return; } } catch (x) { if (x?.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); b.textContent = 'Link copied'; setTimeout(() => { b.textContent = 'Send this page to my computer'; }, 1800); } catch {}
});
if (isPhone(navigator.userAgent)) {
  $('#phone').hidden = false;
  $('#desk').hidden = true;
  $('#review').hidden = true;   // a phone runs no prover
} else {
  $('#addr').addEventListener('input', addressChanged);
  $('#go').addEventListener('click', toggle);
  $('#copy').addEventListener('click', copy);
  for (const b of $('#setup').querySelectorAll('[data-os]')) b.addEventListener('click', () => { os = b.dataset.os; say(''); paint(); });
  $('#wsl-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText('wsl --install'); $('#wsl-copy').textContent = 'Copied'; setTimeout(() => { $('#wsl-copy').textContent = 'Copy'; }, 1500); } catch {}
  });
  paint();
  // The computer is read every two seconds: it is on this machine. With nothing answering after a few tries it is read every ten, and every
  // two again once the line is copied or the address changes (a prover may be about to start).
  loop(async () => { await readLocal(); misses = health ? 0 : misses + 1; paint(); }, () => (misses > 5 ? 10000 : 2000), 10000, () => true);
}
