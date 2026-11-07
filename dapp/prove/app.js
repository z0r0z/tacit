// /prove/: the network's blocks as they land, the proofs waiting and the provers making them, and this computer's own prover, started
// and paused from here. The computer's tacit-prover (installed once with the line the page shows) answers on 127.0.0.1; the API's chain
// (GET /prover/blocks) and proof pool, and the points service, say what the network did and what an address has made and been paid.
import { cleanAddress, proveCommand, utcDay, mineLines, capOf } from '/community-prove.js?cb=30714a9f';
import { localState, jobView, headline, isPhone, isWindows, setupText } from '/prove/view.js?cb=80de18a0';
import { invaderSvg, gpuSvg } from '/prove/invader.js?cb=e8a5ec59';
import { short, cells, opsText, tac, rewardWei, ago, took, fresh, blockAgo, kindOf, KINDS, kindText, median, untilDayEnds, cleanBlock, cleanProof, cleanMiner } from '/prove/chain.js?cb=8a988a34';

const API = 'https://api.tacit.finance', POINTS = 'https://tacit-points.onrender.com', LOCAL = 'http://127.0.0.1:47815';
const SAVED_ADDR = 'tacit-prove-address';                          // shared with the keeper page's card
const SHOW = 40, FEW = 5;                                          // blocks on the strip, and how many are read each time once it is drawn
const $ = (s) => document.querySelector(s);
const get = (url, ms = 6000) => fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(ms) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let health = null, mine = null, pool = null, points = null, tally = null, busy = false, copied = false, salts = null, cross = [], misses = 0;
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
const cap = () => capOf(points);
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
  const [m, t] = await Promise.all([get(`${POINTS}/mine${a ? `?address=${a.toLowerCase()}` : ''}`), get(`${API}/prover/pool/credits?day=${utcDay()}`)]);
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
async function readChain() {
  let c = await get(`${API}/prover/blocks?limit=${shownTop == null ? SHOW : FEW}`);
  if (shownTop != null && c?.blocks?.length >= FEW && fresh(c.blocks.map(cleanBlock).filter(Boolean), shownTop).length >= FEW) c = await get(`${API}/prover/blocks?limit=${SHOW}`);
  if (!c?.blocks) { $('#chain').hidden = !blocks.length; return; }
  c.blocks = c.blocks.map(cleanBlock).filter(Boolean);
  // No blocks yet (or none that read as one): the strip stays as it is.
  if (!c.blocks.length) { $('#chain').hidden = !blocks.length; return; }
  if (c.head) c.head.ethHead = Number.isSafeInteger(Number(c.head.ethHead)) ? Number(c.head.ethHead) : null;
  if (c.head?.ethHead != null) ethHead = c.head.ethHead;
  // An API from before the tip carried Ethereum's head: the settle index says it, read at most once a minute.
  else if (Date.now() - headReadAt > 60000) { headReadAt = Date.now(); const hb = Number((await get(`${API}/confidential/index?limit=1`))?.headBlock); if (Number.isSafeInteger(hb)) ethHead = hb; }
  $('#last').textContent = c.blocks[0] ? (blockAgo(c.blocks[0].ethBlock, ethHead) || '—') : '—';
  const xc = (Array.isArray(c.cross) ? c.cross : []).map(cleanCross).filter(Boolean);
  const xcNew = xc.map((x) => x.digest).join() !== cross.map((x) => x.digest).join();
  cross = xc;
  const add = fresh(c.blocks, shownTop);
  if (!add.length && shownTop != null) { if (xcNew) paintChain(new Set()); else paintAges(); return; }
  const first = shownTop == null;
  blocks = [...add, ...blocks].slice(0, SHOW);
  shownTop = blocks[0]?.height ?? shownTop;
  paintChain(first ? new Set() : new Set(add.map((b) => b.height)));
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

function paintChain(landing) {
  const ol = $('#chain');
  ol.hidden = false;
  const oldest = blocks.length ? blocks[blocks.length - 1].ethBlock : Infinity;
  const xs = cross.filter((x) => x.ethBlock >= oldest);
  // Newest first by Ethereum block; a cross-chain block goes before the settles of its own Ethereum block and older.
  const at = (eb) => xs.filter((x) => x.ethBlock >= eb && !x.done);
  ol.innerHTML = `<li class="blk next" aria-label="The next block"><span class="cube ghost"><i></i><i></i><i></i></span><span class="h">next</span><span class="o" id="next-o">${esc(waitingText())}</span></li>` + blocks.map((b) => {
    const before = at(b.ethBlock).map((x) => { x.done = true; return crossTile(x); }).join('');
    return before + settleTile(b, landing);
  }).join('');
  for (const x of xs) delete x.done;
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
  const r = b.prover ? rewardWei(b.points, cap()) : null;
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
  if (f?.proofs) feed = f.proofs.map(cleanProof).filter(Boolean);
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
  const cp = cap(), total = Math.floor(salts?.weight || 0);
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
function paintFeed() {
  paintIdle();
  const rows = [...feed.slice(0, 8).map((p) => ({ ...p, kind: 'proof' })), ...goodSalts().map((f) => ({ ...f, kind: 'salt' }))].sort((a, b) => b.at - a.at).slice(0, 8);
  if (!rows.length) { if (!$('#feed .empty')) $('#feed').innerHTML = '<li class="empty">Nothing yet today.</li>'; return; }
  $('#feed').innerHTML = rows.map((p) => {
    // This address's own proofs are marked by the row (an edge), not a longer name, so every row stays on one line.
    const mine = !p.house && p.miner && String(p.miner).toLowerCase() === me();
    const top = p.kind === 'salt' ? saltTop : feedTop, fresh = top > 0 && p.at > top;
    const award = p.kind === 'salt' ? saltAward(p) : null;
    if (p.kind === 'salt') return `<li class="${['salt', fresh ? 'new' : '', mine ? 'me' : ''].filter(Boolean).join(' ')}"${mine ? ' title="Your node"' : ''}><span class="by">${byOf(p, false)}<small>good salt, ${zeroBytes(p.bits)}</small></span><b${award ? ' title="Its part of today\'s salt pot so far, paid after the day ends"' : ''}>${esc(awardText(award))}</b><small>${esc(ago(p.at))}</small></li>`;
    const r = rewardWei(p.points, cap());
    return `<li class="${[fresh ? 'new' : '', mine ? 'me' : ''].filter(Boolean).join(' ')}"${mine ? ' title="Your node"' : ''}><span class="by">${byOf(p, false)}<small>a deposit, proved in ${esc(took(p.secs))}</small></span><b>${r ? `+${tac(r)} TAC` : ''}</b><small>${esc(ago(p.at))}</small></li>`;
  }).join('');
}

// Who is at work now: everyone with a proof in the last twenty minutes, and every node grinding salts between proofs (the salt pool's
// `live`), Tacit's GPU among them, as their invaders.
const ONLINE_MS = 20 * 60_000;
function paintCrowd() {
  const t = Date.now(), seen = new Map();
  for (const p of feed) if (t - p.at < ONLINE_MS) { const k = p.house ? 'gpu' : p.miner; if (k && !seen.has(k)) seen.set(k, p); }
  for (const m of salts?.live || []) { const k = m.house ? 'gpu' : m.miner; if (k && !seen.has(k)) seen.set(k, m); }
  if (!seen.size) { $('#crowd-n').textContent = 'Online now'; $('#crowd-row').innerHTML = ''; return; }
  const faces = [...seen.keys()].slice(0, 24).map((k, i) => `<span class="pod${k === me() ? ' me' : ''}" style="--i:${i}" title="${k === 'gpu' ? 'Tacit GPU' : esc(short(k))}">${face(k === 'gpu' ? null : k, 28)}</span>`).join('');
  $('#crowd-n').textContent = `${seen.size} online now`;
  $('#crowd-row').innerHTML = faces;
}

// With proofs waiting, what waits; with none, the nodes grinding salts meanwhile.
function waitingText() {
  const n = (pool?.queued || 0) + (pool?.leased || 0);
  return pool ? (n ? `${n} waiting` : salts?.live?.length ? 'mining salts' : 'waiting for work') : '';
}

let poolShown = null;
function paintNet() {
  const q = pool?.queued ?? null, l = pool?.leased ?? null;
  const nx = document.getElementById('next-o');
  if (nx) nx.textContent = waitingText();
  // Nothing queued: the second cell says how fast the nodes grind salts meanwhile (the crowd below counts them).
  const mining = pool && !(q || l) && salts?.live?.length;
  $('#l-lease').textContent = mining ? 'Salts a second' : 'Proving now';
  $('#n-wait').textContent = q == null ? '—' : String(q);
  $('#n-lease').textContent = mining ? (salts.rate ? rateText(salts.rate).replace('/s', '') : '—') : l == null ? '—' : String(l);
  // The last 24 hours (today's alone would drop to nothing at midnight UTC); today's from an API that does not count them yet.
  const provers = pool?.miners24h ?? pool?.minersToday, done = pool?.done24h ?? pool?.doneToday;
  $('#n-provers').textContent = provers == null ? '—' : String(provers);
  $('#n-done').textContent = done == null ? '—' : String(done);
  const n = Math.min(60, (q || 0) + (l || 0));
  const dots = Array.from({ length: n }, (_, k) => `<i class="${k < (l || 0) ? 'on' : ''}" style="--k:${k}"></i>`).join('')
    + ((q || 0) + (l || 0) > n ? `<span>+${(q || 0) + (l || 0) - n}</span>` : '');
  paintIdle();
  if (dots !== poolShown) { poolShown = dots; $('#pool').innerHTML = dots; }   // drawn again only when the counts change, so the lit squares keep their beat
  paintBoard();
}

// Today's provers: their proofs, the TAC those earn and how fast they usually prove (from the newest proofs).
function paintBoard() {
  const top = pool?.top || [], pts = new Map((tally?.miners || []).map((m) => [String(m.miner).toLowerCase(), m.points]));
  if (!top.length) { if (!$('#board .empty')) $('#board').innerHTML = '<li class="empty">Nobody yet. Be first.</li>'; return; }
  const row = (m, i) => {
    const r = rewardWei(pts.get(String(m.miner).toLowerCase()), cap()), s = median(feed.filter((p) => p.miner === m.miner).map((p) => p.secs));
    return `<li${m.miner === me() ? ' class="me"' : ''}><span class="rk num">${i + 1}.</span>${who(m.miner)}<small>${m.proofs} ${m.proofs === 1 ? 'proof' : 'proofs'}</small><b>${r ? `${tac(r)} TAC` : ''}</b><small class="spd">${s ? `${esc(took(s))} each` : '–'}</small></li>`;
  };
  const mine = me() ? top.findIndex((m) => m.miner === me()) : -1;
  $('#board').innerHTML = top.slice(0, 8).map(row).join('') + (mine >= 8 ? `<li class="gap" aria-hidden="true"></li>${row(top[mine], mine)}` : '');
}

// The prover pot (GET /mine pocket): what the campaign has paid and what is left.
function paintPot() {
  // What a computer can expect: how long a proof takes the community (the middle of the newest, Tacit's own left out), and the salt pot's day.
  const secs = median(feed.filter((p) => !p.house && p.secs).map((p) => p.secs)), sp = salts?.pointsPerDay ? rewardWei(salts.pointsPerDay, cap()) : null;
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
  // Once the line is copied, a computer with no prover yet is waiting for it to start.
  $('#title').textContent = state === 'none' && copied ? 'Waiting for tacit-prover…' : h.title;
  $('#state').classList.toggle('copied', state === 'none' && copied);
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
      const r = rewardWei(pool?.terms?.pointsPerProof, cap()), w = $('#win');
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
  paintMe();
  // the setup line also updates a node from before salt mining (its /mine has no `salt`)
  const setup = $('#setup'), words = setupText(os);
  setup.hidden = state !== 'none' && state !== 'old' && !(mine && !('salt' in mine));
  // Windows' first step (installing Ubuntu) is for a computer with no prover yet; one that has it only updates, in Ubuntu
  setup.dataset.os = os;
  setup.toggleAttribute('data-first', state === 'none');
  for (const b of setup.querySelectorAll('[data-os]')) b.setAttribute('aria-pressed', String(b.dataset.os === os));
  $('#copy').textContent = addr() ? words.button : words.need;
  $('#setup-hint').textContent = words.hint;
  $('#cmd').textContent = proveCommand(addr());
  const l = mineLines(pool, points, { tally, address: addr() });
  $('#pays').textContent = l.pays || '—';
  paintPot();
  const mineRow = (tally?.miners || []).find((m) => String(m.miner).toLowerCase() === me());
  const earned = mineRow ? rewardWei(mineRow.points, cap()) : null;
  $('#today').textContent = mineRow ? `${mineRow.proofs} ${mineRow.proofs === 1 ? 'proof' : 'proofs'}${earned ? ` · ${tac(earned)} TAC` : ''}` : (l.today || '—');
  $('#today-row').hidden = !mineRow && !l.today;
  $('#payout-row').hidden = !mineRow;
  if (mineRow) $('#payout').textContent = `after the day ends, in ${untilDayEnds()}`;
  // At this address's rate so far today (from two hours into the day: there are only as many proofs as people press for), never past what
  // this computer's own pace or a count a day allows.
  const mySecs = median(feed.filter((p) => String(p.miner).toLowerCase() === me()).map((p) => p.secs));
  const into = (Date.now() % 86_400_000) / 86_400_000;
  const rate = mineRow && into >= 1 / 12 ? Math.round(mineRow.proofs / into) : 0;
  // What a proof has paid this address today on average (fewer points than the most a proof can earn once the day's pot is shared), else that most.
  const perDay = rate ? Math.min(rate, pool?.terms?.proofsPerMinerDay || Infinity, mySecs ? Math.floor(86400 / mySecs) : Infinity) : null;
  const per = earned && mineRow.proofs ? earned / BigInt(mineRow.proofs) : rewardWei(pool?.terms?.pointsPerProof, cap());
  $('#pace-row').hidden = !(perDay && per);
  if (perDay && per) $('#pace').textContent = `about ${tac(per * BigInt(perDay))} TAC a day (${perDay} proofs)`;
  const credited = points?.account?.creditedWei;
  $('#paid-row').hidden = !/^\d+$/.test(String(credited ?? ''));
  const paid = $('#paid-row').hidden ? paidShown : `${esc(tac(credited))} TAC · <a href="/rewards/">Rewards</a>`;
  if (paid !== paidShown) { paidShown = paid; $('#paid').innerHTML = paid; }
  $('#run').textContent = mine?.proved ? String(mine.proved) : '0';
  $('#run-row').hidden = !mine || typeof mine.on !== 'boolean';
  paintSalt();
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
  if (a) { try { localStorage.setItem(SAVED_ADDR, a); } catch {} }
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

// The GPU card: the command for this address, what a Bitcoin batch pays (the board's points for it, at the most a point is paid today),
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
  const pts = Number(boardPay?.pointsByProgram?.[BTC]), r = Number.isSafeInteger(pts) ? rewardWei(pts, cap()) : null;
  const bpts = Number(boardPay?.pointsByProgram?.[BLOCK]), br = Number.isSafeInteger(bpts) ? rewardWei(bpts, cap()) : null;
  $('#btc-pay').textContent = r && br ? ` · ${tac(r)} TAC a batch, ${tac(br)} a chain block` : r ? ` · ${tac(r)} TAC each` : '';
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
const cleanSalts = (s) => (s && typeof s === 'object' ? {
  minBits: count(s.minBits), maxWeightBits: count(s.maxWeightBits), pointsPerDay: count(s.pointsPerDay), miners: count(s.today?.miners), shares: count(s.today?.shares), weight: Number(s.today?.weight) || 0,
  top: (Array.isArray(s.top) ? s.top : []).map((m) => ({ miner: cleanAddress(m?.miner), weight: Number(m?.weight) || 0, shares: count(m?.shares),
    best: HEX40.test(String(m?.best?.address)) && count(m?.best?.bits) ? { address: m.best.address, bits: m.best.bits } : null })).filter((m) => m.miner),
  bank: (Array.isArray(s.bank) ? s.bank : []).map((b) => ({ address: HEX40.test(String(b?.address)) ? b.address : null, bits: count(b?.bits), miner: cleanAddress(b?.miner), house: b?.house === true, at: count(b?.at) })).filter((b) => b.address),
  // The newest good finds (`recent`, from the API that keeps them); an older API has only the bank, whose finds carry a time too.
  recent: (Array.isArray(s.recent) ? s.recent : Array.isArray(s.bank) ? s.bank : []).map((b) => ({ address: HEX40.test(String(b?.address)) ? b.address : null, bits: count(b?.bits), miner: cleanAddress(b?.miner), house: b?.house === true, at: count(b?.at) }))
    .filter((b) => b.address && b.bits && b.at && (b.house || b.miner)),
  live: (Array.isArray(s.live) ? s.live : []).map((m) => ({ miner: cleanAddress(m?.miner)?.toLowerCase() || null, house: m?.house === true })).filter((m) => m.miner).slice(0, 64),
  rate: Number.isFinite(Number(s.rate)) && Number(s.rate) >= 0 ? Number(s.rate) : 0,
} : null);
let bankShown = null, bestShown = null, bestHtmlShown = null;
// An address's row: its zero bytes picked out, and who found it.
const saltRow = (b, cls = '') => {
  const z = Math.floor((b.bits || 0) / 4);
  return `<li${cls ? ` class="${cls}"` : ''}><code><b>${esc(b.address.slice(0, 2 + z))}</b>${esc(b.address.slice(2 + z, 18))}…</code><small>${b.house ? `<span class="who">${face(null)}Tacit GPU</span>` : b.miner ? who(b.miner) : ''}</small></li>`;
};
function paintSalt() {
  const potWei = salts?.pointsPerDay ? rewardWei(salts.pointsPerDay, cap()) : null;
  // What the day's proofs leave of the daily pot so far (worker/src/salt-pool.js): it shrinks as proofs come in, so "up to".
  $('#salt-pay').textContent = potWei ? ` · up to ${tac(potWei)} TAC today` : '';
  // A node from before salt mining (its /mine has no `salt`) is told how to start: the setup line installs the newest.
  if (mine && !('salt' in mine)) $('#salt-day').textContent = 'Run the setup line again to update tacit-prover: it then mines salts between proofs.';
  else if (salts) $('#salt-day').textContent = `Split by work between ${salts.miners || 0} ${salts.miners === 1 ? 'node' : 'nodes'} today (${(salts.shares || 0).toLocaleString('en-US')} shares). A proof always comes first.`;
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
  const banked = salts?.bank?.length ? salts.bank : null;
  const finds = (banked || (salts?.top || []).filter((m) => m.best).map((m) => ({ ...m.best, miner: m.miner })).sort((a, b) => b.bits - a.bits)).filter((b) => b.address !== best?.address);
  $('#salt-bank-h').hidden = !finds.length;
  $('#salt-bank-h').textContent = banked ? 'Banked for deploys' : 'Best found today';
  const bank = finds.slice(0, 5).map((b) => saltRow(b)).join('');
  if (bank !== bankShown) { bankShown = bank; $('#salt-bank').innerHTML = bank; }   // rows with a picture each: drawn again only when they change
  const rate = Number(mine?.salt?.rate), mineRow = (salts?.top || []).find((m) => m.miner.toLowerCase() === me());
  const part = mineRow && salts.weight && salts.pointsPerDay ? rewardWei(Math.floor((salts.pointsPerDay * mineRow.weight) / salts.weight), cap()) : null;
  const on = mine?.salt?.on === true && Number.isFinite(rate) && rate > 0;
  $('#salt-row').hidden = !(on || mineRow);
  $('#salt').textContent = [mineRow ? `${(mineRow.shares || 0).toLocaleString('en-US')} shares` : null, part ? `${tac(part)} TAC so far` : null, on ? rateText(rate) : null].filter(Boolean).join(' · ') || '—';
}
async function readSalts() {
  const s = await get(`${API}/prover/salt`); if (s) salts = cleanSalts(s);
  paintSalt(); paintNet(); paintCrowd(); paintFeed();
  saltTop = Math.max(saltTop, goodSalts()[0]?.at || 0);
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
// open those tabs, so it loads when one opens, when the wallet chip is pressed, or once the page has settled.
let opsLoad = null;
const loadOps = () => (opsLoad ||= import('/prove/ops.js?cb=58b49702'));
$('#wallet').addEventListener('click', async (e) => {
  if (opsLoad) return;                                             // loaded: ops.js has its own handler on the chip
  e.preventDefault();
  await loadOps().catch(() => {});
  $('#wallet').click();
}, { once: true });
const whenIdle = (fn) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 8000 }) : setTimeout(fn, 4000));
addEventListener('load', () => setTimeout(() => whenIdle(() => loadOps().then((m) => m.startMarket()).catch(() => {})), 2500), { once: true });

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
  // and again once the network strip and the rows above have their height, unless the reader has scrolled meanwhile
  let moved = false;
  addEventListener('wheel', () => { moved = true; }, { once: true, passive: true });
  addEventListener('touchmove', () => { moved = true; }, { once: true, passive: true });
  setTimeout(() => { if (!moved && cardOf()) CARDS.get(cardOf()).scrollIntoView({ block: 'start' }); }, 900);
} else showTab(tabOf(), { write: false });

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
// One read that throws is let go: the next goes on at its time. `ms` may be a function, asked before each wait.
const loop = (fn, ms, idle) => { const run = async () => { try { await fn(); } catch {} setTimeout(run, document.hidden ? idle : typeof ms === 'function' ? ms() : ms); }; run(); };
// The chain every six seconds, the pool and the feed every ten, the points service every half minute.
loop(readChain, 6000, 30000);
loop(readFeed, 10000, 60000);
loop(async () => { const p = await get(`${API}/prover/pool`); if (p) pool = cleanPool(p); paintNet(); }, 10000, 60000);
loop(readRemote, 30000, 120000);
loop(readBoardPay, 60000, 300000);
loop(readSalts, 30000, 120000);
// The day's checkpoint (worker/src/pool-snapshot-job.js): the tacit block, Bitcoin's height as the pool sees it, and the manifest on IPFS
// that holds them, named on Ethereum by snapshot.tacit.wei. Anyone can rebuild every part of it from Ethereum.
const HEX32 = /^0x[0-9a-f]{64}$/i, CID = /^b[a-z2-7]{58}$/;
async function readCheckpoint() {
  const s = await get(`${API}/pool/snapshot`), c = s?.checkpoint, el = $('#checkpoint');
  // Bitcoin's height as far as the pool's verifier has taken it in (the reflection), else as far as the light relay has seen it.
  const height = count(c?.tacit?.height), btc = count(c?.bitcoin?.reflection?.height) ?? count(c?.bitcoin?.relayTip);
  const slot = count(c?.ethereum?.finalizedSlot);
  if (!CID.test(String(s?.cid)) || height == null || !HEX32.test(String(c?.tacit?.hash))) { el.hidden = true; return; }
  el.innerHTML = `Checkpoint: block #${height.toLocaleString('en-US')} <code>${esc(c.tacit.hash.slice(0, 10))}…</code>${btc != null ? ` · Bitcoin ${btc.toLocaleString('en-US')}` : ''}${slot != null ? ` · Ethereum slot ${slot.toLocaleString('en-US')}` : ''} · <a href="https://ipfs.filebase.io/ipfs/${esc(s.cid)}" target="_blank" rel="noopener noreferrer">snapshot.tacit.wei</a>`;
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
  loop(async () => { await readLocal(); misses = health ? 0 : misses + 1; paint(); }, () => (misses > 5 ? 10000 : 2000), 10000);
}
