// The Tacit Praxis ceremony page: the wall of contributors (each receipt's signature checked in the browser against the coordinator's key,
// each face the zOrgz invader its address picks, as on the prover pool page), the stats, the rewards, and the command to take part.
import { cleanName, hasName, addressOf, rewardProgress, COORDINATOR, COORDINATOR_KEY, SUCCINCT_CONTRIBUTORS, verifyReceipt, brokenLink, when, shareUrl, runCommand, waitText, platformGuess, rewardView, tac, POINTS_VIEW, faceKey, nameOf, label, isProver, isHouse, isAddress, ago, findReceipt, pageShareUrl, SUCCINCT_LINKS } from '/praxis/receipt.js?cb=e43d425d';
import { invaderSvg } from '/prove/invader.js?cb=e8a5ec59';
import { chime } from '/reward-pop.js?cb=88973dac';

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
  if (hasName(r) && r.handle && String(r.handle).toLowerCase() !== String(r.name).toLowerCase() && !isProver(r)) nm.append(el('span', 'mute', ` ${label(r.handle)}`));
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
  const newest = receipts.length ? receipts[receipts.length - 1].index : -1;
  list.replaceChildren(slot(), ...[...receipts].reverse().map((r, i) => {
    const t = tile(r, !first && !seen.has(r.index));
    t.style.setProperty('--i', String(Math.min(i + 1, 24)));             // the cascade on the first draw
    if (r.index === newest) t.firstElementChild.classList.add('latest');
    return t;
  }));
  if (first && !reduced) { list.classList.add('first'); setTimeout(() => list.classList.remove('first'), 2200); }
  for (const r of receipts) seen.add(r.index);
  const strip = $('strip');
  if (!strip.childElementCount) for (let i = 0; i < SUCCINCT_CONTRIBUTORS; i++) strip.append(el('i', 'dot'));
}

// the whole chain as masks: Succinct's 18 first (small, greyed), then every contribution here; a click copies the file's hash
let chainDrawn = false;
function drawStrip() {
  const strip = $('chain');
  let n = 0;
  const link = (key, cls, title, hash, index) => {
    const b = el('button', `lk ${cls}`);
    b.style.setProperty('--i', String(Math.min(n, 90)));         // the cascade on the first draw
    b.style.setProperty('--w', String(n++ % 45));                // the light along the connectors
    b.type = 'button';
    b.setAttribute('role', 'listitem');
    b.title = title;
    if (index) b.dataset.index = String(index);
    b.append(face(key, cls === 'sg' ? 34 : 46));
    b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(hash); b.title = `${title}: hash copied`; } catch { /* not copied */ } });
    return b;
  };
  strip.replaceChildren(
    ...SUCCINCT_LINKS.map((h, i) => link(`0x${h}`, 'sg', `Succinct's contribution ${i + 1} of ${SUCCINCT_CONTRIBUTORS} (phase2-${i})`, h)),
    ...receipts.map((r) => link(faceKey(r), `ours${mine && mine.index === r.index ? ' mine' : ''}`, `#${r.index}, ${nameOf(r)}, ${ago(r.at)}`, r.contribution_hash, r.index)),
  );
  strip.lastElementChild?.classList.add('last');
  if (!chainDrawn && !reduced) { strip.classList.add('first'); setTimeout(() => strip.classList.remove('first'), 3500); }
  chainDrawn = true;
  strip.scrollLeft = strip.scrollWidth;      // the newest end
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

// ── the moment a contribution has landed: once for each contribution this browser has seen land, with the TAC coins, the chime and the post to share
const CELE = 'tacit-praxis-celebrated-v1';
let celebrated = new Set();
try { celebrated = new Set(JSON.parse(localStorage.getItem(CELE) || '[]')); } catch { /* nothing kept */ }
let eachWei = null;                    // what a contribution pays, once the points service has been read
function coins() {
  const box = $('cele-coin');
  for (let i = 0; i < 9; i++) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    c.setAttribute('class', 'tk fly');
    c.innerHTML = '<use href="#tk-tac"/>';
    box.append(c);
    const dx = (Math.random() - 0.5) * 260, dy = -(90 + Math.random() * 90);
    const run = c.animate([
      { transform: 'translate(0,0) scale(.5)', opacity: 0 },
      { transform: `translate(${dx * 0.7}px,${dy}px) scale(1.1)`, opacity: 1, offset: 0.45, easing: 'cubic-bezier(.2,.8,.2,1)' },
      { transform: `translate(${dx}px,${dy + 70}px) scale(.8)`, opacity: 0 },
    ], { duration: 1200 + i * 70, delay: i * 40, easing: 'cubic-bezier(.2,.8,.2,1)' });
    run.onfinish = () => c.remove();
  }
}
function celebrate(r) {
  const dlg = $('cele');
  if (celebrated.has(r.index) || dlg.open || typeof dlg.showModal !== 'function') return;
  celebrated.add(r.index);
  try { localStorage.setItem(CELE, JSON.stringify([...celebrated])); } catch { /* private window: it can show again */ }
  $('cele-h').textContent = `You are #${r.index}`;
  $('cele-share').href = shareUrl(r.contribution_hash, r.index);
  $('cele-amt').hidden = eachWei === null;
  if (eachWei !== null) $('cele-n').textContent = tac(eachWei);
  dlg.showModal();
  chime();
  if (!reduced) coins();
}
for (const b of document.querySelectorAll('#cele [data-close]')) b.addEventListener('click', () => $('cele').close());
$('cele').addEventListener('click', (e) => { if (e.target === $('cele')) $('cele').close(); });   // a click on the dimmed page behind it

// ── find yours
function drawYou() {
  const box = $('you');
  const q = $('find').value;
  mine = findReceipt(receipts, q) || (isAddress($('addr').value.trim()) ? findReceipt(receipts, $('addr').value) : null);
  for (const b of document.querySelectorAll('.tile.mine, .lk.mine')) b.classList.remove('mine');
  box.replaceChildren();
  if (!q.trim() && !mine) { box.hidden = true; return; }
  box.hidden = false;
  if (!mine) { box.append(el('span', null, 'Not on the wall yet. A contribution shows up here once it has been accepted.')); return; }
  document.querySelector(`.tile[data-index="${mine.index}"]`)?.classList.add('mine');
  document.querySelector(`.lk[data-index="${mine.index}"]`)?.classList.add('mine');
  // the address typed in the form (not a search of someone else's) marks a contribution as the visitor's own: once, if it is recent
  const own = isAddress($('addr').value.trim()) ? findReceipt(receipts, $('addr').value) : null;
  if (own && own.index === mine.index && Date.now() - new Date(own.at).getTime() < 48 * 3600e3) celebrate(own);
  box.append(el('span', null, `You are #${mine.index}${hasName(mine) && !isAddress(mine.name) ? `, ${mine.name}` : ''}. Thank you.`));
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
    if (changed || first) { drawWall(first); drawStrip(); drawYou(); }
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

// ── contribute in this browser: one big button; the run shows four plain steps
let webRun = null;
async function startWeb() {
  const handleRaw = $('addr').value.trim();
  if (handleRaw && !isAddress(handleRaw) && !confirm('That does not look like a 0x address (0x and 40 letters or digits), so no TAC could be sent to it. Continue without one?')) { $('addr').focus(); return; }
  const handle = isAddress(handleRaw) ? handleRaw : '';
  const name = (cleanName($('name').value) || (handle ? '' : 'a browser')) || handle;
  const web = await import('/praxis/web.js?cb=7f2a329d');
  web.resetClock();
  const ac = new AbortController();
  webRun = ac;
  keep();
  $('web-go').hidden = true; $('web-hint').hidden = true; $('web-prog').hidden = false; $('web-stop').hidden = false;
  for (const id of ['addr', 'name']) $(id).disabled = true;
  $('web-msg').textContent = 'Joining the line…';
  const mark = (s) => {
    const i = web.stepOf(s.phase);
    document.querySelectorAll('#track li').forEach((li, k) => { li.classList.toggle('on', k === i); li.classList.toggle('past', k < i); });
    $('web-msg').textContent = web.statusText(s);
    $('web-fill').style.width = `${Math.round(100 * web.fraction(s))}%`;
  };
  // keep the screen on while it works (a laptop that sleeps stops the work); best effort
  let lock = null;
  const hold = async () => { try { lock = await navigator.wakeLock?.request('screen'); } catch { /* not available */ } };
  const again = () => { if (webRun && document.visibilityState === 'visible') hold(); };
  document.addEventListener('visibilitychange', again);
  hold();
  const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
  addEventListener('beforeunload', warn);
  try {
    const r = await web.contributeHere({ name, handle, signal: ac.signal, onStatus: mark });
    mark({ phase: 'done' });
    $('web-msg').textContent = 'Accepted. You are in the chain.';
    await refresh();
    celebrate(r);
  } catch (e) {
    const said = String(e.message || e);
    $('web-msg').textContent = ac.signal.aborted ? 'Stopped. Nothing was lost; you can start again any time.'
      : /already contributed|may not join/.test(said) ? `${said.charAt(0).toUpperCase()}${said.slice(1)}.`
      : /already holds a place/.test(said) ? 'An earlier attempt from this address still holds a place in the line. Give it a minute to clear, then press the button again.'
      : /dropped this place/.test(said) ? 'You were dropped from the line because this tab stopped checking in. Press the button to rejoin; keep the tab open while you wait.'
      : /queue is full/.test(said) ? 'The line is full right now. Try again in a few minutes.'
      : `Something interrupted it (${said}). Nothing was lost on our side. Press the button to try again.`;
    $('web-go').textContent = 'Try again'; $('web-go').hidden = false;
    $('web-stop').hidden = true;
  } finally {
    removeEventListener('beforeunload', warn);
    document.removeEventListener('visibilitychange', again);
    try { await lock?.release(); } catch { /* already released */ }
    webRun = null;
    for (const id of ['addr', 'name']) $(id).disabled = false;
  }
}
$('web-go').addEventListener('click', startWeb);
$('web-stop').addEventListener('click', () => webRun?.abort());

async function drawQueue() {
  try {
    const r = await fetch('https://tacit-praxis-ceremony.onrender.com/api/coordinator', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    const v = await r.json();
    if (/^https?:\/\/[A-Za-z0-9.\-]+(:\d{1,5})?$/.test(v.coordinator || '') || /^https?:\/\/\[[0-9A-Fa-f:]+\](:\d{1,5})?$/.test(v.coordinator || '')) { coordinator = v.coordinator; drawCommand(); }
    $('queue').textContent = v.open === false ? 'Closed.' : waitText(v.queue);
    if (Number.isInteger(v.queue)) setNum($('n-queue'), v.queue);
    if (v.browser === true && v.open !== false) { const web = await import('/praxis/web.js?cb=7f2a329d'); const can = web.capable(); $('web').hidden = !can; if (can && !webRun) $('cmd-alt').open = false; }
  } catch { $('queue').textContent = ''; }
}

// ── the rewards: what a contribution pays in TAC, the pot and what is left (the panel stays hidden if the points service cannot be read)
async function drawRewards() {
  const box = $('rewards');
  try {
    const r = await fetch(POINTS_VIEW, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    const v = rewardView(await r.json());
    if (!v) { box.hidden = true; $('cta-reward').hidden = true; return; }
    eachWei = v.each;
    $('rw-each').textContent = `up to ${tac(v.each)}`;
    $('cta-each').textContent = `up to ${tac(v.each)}`;
    const addrs = new Set(receipts.map(addressOf).filter(Boolean)).size;
    const pr = rewardProgress(v, addrs);
    $('rw-left').textContent = `${tac(pr.leftAfter)} TAC left · about ${pr.count.toLocaleString('en-US')} more contribution${pr.count === 1n ? '' : 's'}`;
    $('rw-pend').style.width = `${Math.round(pr.pendFrac * 100)}%`;
    $('rw-earned').hidden = pr.pending === 0n;
    $('rw-earned').textContent = `${addrs.toLocaleString('en-US')} contributor${addrs === 1 ? '' : 's'} earned ${tac(pr.pending)} TAC so far, paid once the UTC day is over.`;
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
