// The Tacit Praxis ceremony page: the wall of contributors (each receipt's signature checked in the browser against the coordinator's key,
// each face the zOrgz invader its address picks, as on the prover pool page), the stats, the rewards, and the command to take part.
import { COORDINATOR, COORDINATOR_KEY, SUCCINCT_CONTRIBUTORS, verifyReceipt, brokenLink, when, shareUrl, runCommand, waitText, platformGuess, rewardView, tac, POINTS_VIEW, faceKey, nameOf, label, isProver, isHouse, isAddress, ago, findReceipt, pageShareUrl } from '/praxis/receipt.js?cb=73d664fd';
import { invaderSvg } from '/prove/invader.js?cb=e8a5ec59';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── copy buttons
function copyButton(get, label = 'Copy') {
  const b = el('button', 'cp', label);
  b.type = 'button';
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(get()); b.textContent = 'Copied'; } catch { b.textContent = 'Select it'; }
    setTimeout(() => { b.textContent = label; }, 1500);
  });
  return b;
}
for (const box of document.querySelectorAll('.cmd')) {
  const pre = box.querySelector('pre');
  box.append(copyButton(() => pre.textContent.trim()));
}

// ── numbers that count up to their value
function setNum(node, to) {
  const from = Number(node.dataset.v);
  node.dataset.v = String(to);
  if (reduced || !Number.isFinite(from) || from === to) { node.textContent = String(to); return; }
  const t0 = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / 700);
    node.textContent = String(Math.round(from + (to - from) * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── faces: the zOrgz invader of an address (the prover pool page's own drawing), or of the contribution's hash when it has no address
const faces = new Map();
function face(key, px = 68) {
  if (!faces.has(key)) {
    let svg = '';
    try { svg = invaderSvg(key, 128); } catch { /* no face: the tile still reads */ }
    faces.set(key, svg ? `data:image/svg+xml;base64,${btoa(svg)}` : '');
  }
  const img = el('img', 'inv');
  img.width = img.height = px;
  img.alt = '';
  const src = faces.get(key);
  if (src) img.src = src;
  return img;
}

// ── the wall
let receipts = [];
let mine = null;                       // the receipt a visitor found
const seen = new Set();                // indexes already drawn, so only a new one pops in
const sigs = new Map();                // index -> true | false | null, once checked

function tile(r, fresh) {
  const t = el('li');
  const b = el('button', 'tile');
  b.type = 'button';
  b.dataset.index = String(r.index);
  b.title = `contribution ${r.contribution_hash}: click to copy it`;
  if (fresh) b.classList.add('new');
  if (mine && mine.index === r.index) b.classList.add('mine');
  const tick = el('span', 'tick', '…');
  tick.title = 'checking the coordinator’s signature';
  const nm = el('span', 'nm', nameOf(r));
  if (r.handle && String(r.handle).toLowerCase() !== String(r.name).toLowerCase() && !isProver(r)) nm.append(el('span', 'mute', ` ${label(r.handle)}`));
  const meta = el('span', 'meta');
  const time = el('time', null, ago(r.at));
  time.dateTime = r.at;
  time.title = when(r.at);
  meta.append(el('span', 'num', `#${r.index}`), time);
  if (isProver(r)) meta.append(el('span', 'bd', 'prover'));
  if (isHouse(r)) { const h = el('span', 'bd house', 'Tacit'); h.title = 'made by Tacit’s own machines, to test the ceremony'; meta.append(h); }
  b.append(face(faceKey(r)), tick, nm, meta);
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(r.contribution_hash); } catch { return; }
    const f = el('span', 'flash', 'hash copied');
    b.append(f);
    setTimeout(() => f.remove(), 1200);
  });
  t.append(b);
  const paint = (v) => {
    tick.textContent = v === true ? '✓' : v === false ? '✗' : '·';
    tick.className = `tick sig${v === false ? ' bad' : ''}`;
    tick.title = v === true ? 'signed by the coordinator' : v === false ? 'signature does not match' : 'signature not checked in this browser';
    tick.dataset.sig = v === true ? 'ok' : v === false ? 'bad' : 'none';
  };
  if (sigs.has(r.index)) paint(sigs.get(r.index));
  else verifyReceipt(r, COORDINATOR_KEY).then((v) => { sigs.set(r.index, v); paint(v); });
  return t;
}

function slot() {
  const t = el('li');
  const a = el('a', 'tile slot');
  a.href = '#join';
  a.append(el('b', null, 'You?'), el('span', null, `be #${SUCCINCT_CONTRIBUTORS + receipts.length + 1}`));
  t.append(a);
  return t;
}

function drawWall(first) {
  const list = $('tiles');
  list.replaceChildren(slot(), ...[...receipts].reverse().map((r) => tile(r, !first && !seen.has(r.index))));
  for (const r of receipts) seen.add(r.index);
  const strip = $('strip');
  if (!strip.childElementCount) for (let i = 0; i < SUCCINCT_CONTRIBUTORS; i++) strip.append(el('i', 'dot'));
}

function drawChain(t) {
  const ours = t.receipts.length;
  setNum($('n-total'), SUCCINCT_CONTRIBUTORS + ours);
  setNum($('n-ours'), ours);
  const provers = t.receipts.filter(isProver).length;
  setNum($('n-prover'), provers);
  $('n-prover').closest('li').hidden = provers === 0;       // a count that is zero says nothing until a prover has joined
  $('head-line').textContent = t.closed ? `Closed at phase2-${t.head_index}. Succinct's 18 came first.` : `Head: phase2-${t.head_index}. Succinct's 18 came first.`;
  for (const s of document.querySelectorAll('[data-head]')) s.textContent = String(t.head_index);
  const bad = brokenLink(t);
  const link = $('link');
  link.hidden = bad < 0;
  link.textContent = bad < 0 ? '' : `Receipt ${bad + 1} does not continue the file before it: do not trust this list.`;
}

// ── find yours
function drawYou() {
  const box = $('you');
  const q = $('find').value;
  mine = findReceipt(receipts, q) || (isAddress($('addr').value.trim()) ? findReceipt(receipts, $('addr').value) : null);
  for (const b of document.querySelectorAll('.tile.mine')) b.classList.remove('mine');
  box.replaceChildren();
  if (!q.trim() && !mine) { box.hidden = true; return; }
  box.hidden = false;
  if (!mine) { box.append(el('span', null, 'Not on the wall yet. A contribution shows up here once it has been accepted.')); return; }
  document.querySelector(`.tile[data-index="${mine.index}"]`)?.classList.add('mine');
  box.append(el('span', null, `You are #${mine.index}${mine.name && !isAddress(mine.name) ? `, ${mine.name}` : ''}. Thank you.`));
  const a = el('a', 'btn');
  a.textContent = 'Share on X';
  a.href = shareUrl(mine.contribution_hash, mine.index);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  box.append(a);
}
$('find').addEventListener('input', drawYou);

// ── the transcript: live through the ceremony's HTTPS window, this site's copy if it does not answer
const LIVE = 'https://tacit-praxis-ceremony.onrender.com/api/transcript';
async function readTranscript() {
  try {
    const r = await fetch(LIVE, { cache: 'no-cache', signal: AbortSignal.timeout(6000) });
    if (r.ok) { const t = await r.json(); if (Array.isArray(t.receipts) || t.receipts === null) return { t: { ...t, receipts: t.receipts || [] }, live: true }; }
  } catch { /* the copy below */ }
  const res = await fetch('/praxis/transcript.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(String(res.status));
  return { t: await res.json(), live: false };
}
let first = true;
async function refresh() {
  try {
    const { t, live } = await readTranscript();
    if (!Array.isArray(t.receipts)) throw new Error('no receipts');
    $('src').textContent = live ? 'live' : 'saved copy';
    $('live').classList.toggle('off', !live);
    const changed = t.receipts.length !== receipts.length || t.receipts.some((r, i) => receipts[i]?.contribution_hash !== r.contribution_hash);
    receipts = t.receipts;
    drawChain(t);
    if (changed || first) { drawWall(first); drawYou(); }
    first = false;
  } catch {
    if (first) $('tiles').replaceChildren(el('li', 'empty err', 'The chain could not be read here.'));
  }
}

// ── take part: the command for this computer, the queue and the coordinator's address from the window
let coordinator = COORDINATOR;
function drawCommand() {
  $('cmd-run').textContent = runCommand({ plat: $('plat').value, addr: $('addr').value, name: $('name').value, coordinator });
}
$('plat').value = platformGuess(navigator.userAgent, navigator.platform || '');
$('share-page').href = pageShareUrl();
// what was typed is kept in this browser only, so coming back after contributing finds you on the wall, with the share button
const ME = 'tacit-praxis-me-v1';
try { const m = JSON.parse(localStorage.getItem(ME) || '{}'); if (isAddress(m.addr)) $('addr').value = m.addr; if (typeof m.name === 'string') $('name').value = m.name.slice(0, 64); } catch { /* nothing kept */ }
const keep = () => { try { localStorage.setItem(ME, JSON.stringify({ addr: isAddress($('addr').value.trim()) ? $('addr').value.trim() : '', name: $('name').value.trim() })); } catch { /* private window */ } };
for (const id of ['plat', 'addr', 'name']) $(id).addEventListener('input', () => { drawCommand(); keep(); });
$('addr').addEventListener('input', drawYou);
drawCommand();

$('copy-run').addEventListener('click', async () => {
  const b = $('copy-run');
  try { await navigator.clipboard.writeText($('cmd-run').textContent.trim()); b.textContent = 'Copied: paste it in a terminal'; } catch { b.textContent = 'Select the command below and copy it'; }
  setTimeout(() => { b.textContent = 'Copy the command'; }, 2500);
});
$('cta-go').addEventListener('click', (e) => {
  e.preventDefault();
  $('join').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  setTimeout(() => $('addr').focus({ preventScroll: true }), reduced ? 0 : 450);
});

async function drawQueue() {
  try {
    const r = await fetch('https://tacit-praxis-ceremony.onrender.com/api/coordinator', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    const v = await r.json();
    if (/^https?:\/\/[^\s"'<>]+$/.test(v.coordinator || '')) { coordinator = v.coordinator; drawCommand(); }
    $('queue').textContent = v.open === false ? 'Closed.' : waitText(v.queue);
    if (Number.isInteger(v.queue)) setNum($('n-queue'), v.queue);
  } catch { $('queue').textContent = ''; }
}

// ── the rewards: what a contribution pays in TAC, the pot and what is left (the panel stays hidden if the points service cannot be read)
async function drawRewards() {
  const box = $('rewards');
  try {
    const r = await fetch(POINTS_VIEW, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    const v = rewardView(await r.json());
    if (!v) { box.hidden = true; $('cta-reward').hidden = true; return; }
    $('rw-each').textContent = `up to ${tac(v.each)}`;
    $('cta-each').textContent = `up to ${tac(v.each)}`;
    $('rw-left').textContent = `${tac(v.left)} TAC left · about ${v.count.toLocaleString('en-US')} more contribution${v.count === 1n ? '' : 's'}`;
    $('rw-pot').textContent = `of a ${tac(v.total)} TAC pot`;
    $('rw-fill').style.width = `${Math.round(v.paidFrac * 100)}%`;
    $('rw-bar').setAttribute('aria-label', `${Math.round(v.paidFrac * 100)}% of the ${tac(v.total)} TAC pot is paid out`);
    box.hidden = false;
    $('cta-reward').hidden = false;
  } catch { box.hidden = true; $('cta-reward').hidden = true; }
}

await refresh();
drawQueue();
drawRewards();
setInterval(refresh, 20_000);
setInterval(drawQueue, 30_000);
setInterval(drawRewards, 120_000);
setInterval(() => { for (const t of document.querySelectorAll('.tile time')) t.textContent = ago(t.dateTime); }, 30_000);   // "3 min ago" stays true
