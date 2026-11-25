// The Tacit Praxis ceremony page: the chain read from this site's copy of the coordinator's transcript (the coordinator speaks plain HTTP,
// which an HTTPS page cannot fetch), each receipt's signature checked against the coordinator's key, the copy buttons and the share link.
import { COORDINATOR, COORDINATOR_KEY, SUCCINCT_CONTRIBUTORS, verifyReceipt, brokenLink, short, when, normalHash, shareUrl, runCommand, waitText, platformGuess } from '/praxis/receipt.js?cb=ea54ef83';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

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
for (const v of document.querySelectorAll('[data-copy]')) v.after(copyButton(() => v.dataset.copy));

let receipts = [];

function drawChain(t) {
  const ours = t.receipts.length;
  const strip = $('strip');
  strip.replaceChildren();
  for (let i = 0; i < SUCCINCT_CONTRIBUTORS; i++) strip.append(el('i', 'dot'));
  for (let i = 0; i < ours; i++) strip.append(el('i', 'dot ours'));
  strip.setAttribute('aria-label', `${SUCCINCT_CONTRIBUTORS} contributions by Succinct's setup, then ${ours} in this ceremony`);
  $('n-total').textContent = String(SUCCINCT_CONTRIBUTORS + ours);
  $('n-ours').textContent = String(ours);
  const head = $('head');
  head.replaceChildren(el('span', null, `phase2-${t.head_index} · `), el('code', null, short(t.head_sha256)), copyButton(() => t.head_sha256));
  $('state').textContent = t.closed ? 'Closed' : 'Open for contributions';
  for (const s of document.querySelectorAll('[data-head]')) s.textContent = String(t.head_index);
  const bad = brokenLink(t);
  $('link').textContent = bad < 0 ? 'Each receipt continues the file before it, from Succinct\'s phase2-17 to the head.' : `Receipt ${bad + 1} does not continue the file before it.`;
  $('link').className = bad < 0 ? 'note' : 'note err';
}

async function drawReceipts(t) {
  const list = $('receipts');
  list.replaceChildren();
  if (!t.receipts.length) { list.append(el('li', 'empty', 'No contributions yet.')); return; }
  for (const r of [...t.receipts].reverse()) {
    const li = el('li', 'rc');
    const top = el('div', 'rc-top');
    const who = el('span', 'who');
    // an address as a name (the tool's handle for the points) is shown once and shortened, whole on hover
    const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ''));
    const label = (s) => (isAddr(s) ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
    const nameEl = el('b', null, label(r.name));
    if (isAddr(r.name)) nameEl.title = r.name;
    who.append(nameEl);
    if (r.handle && r.handle.toLowerCase() !== String(r.name).toLowerCase()) {
      const h = el('span', 'mute', ` ${label(r.handle)}`);
      if (isAddr(r.handle)) h.title = r.handle;
      who.append(h);
    }
    top.append(el('span', 'idx num', `#${r.index}`), who, el('time', 'mute', when(r.at)));
    top.lastChild.dateTime = r.at;
    const hash = el('div', 'rc-hash');
    const code = el('code', null, short(r.contribution_hash));
    code.title = r.contribution_hash;
    const sig = el('span', 'sig mute', 'checking signature…');
    hash.append(el('span', 'k mute', 'contribution'), code, copyButton(() => r.contribution_hash), sig);
    li.append(top, hash);
    list.append(li);
    verifyReceipt(r, COORDINATOR_KEY).then((v) => {
      sig.textContent = v === true ? 'signed by the coordinator' : v === false ? 'signature does not match' : 'signature not checked in this browser';
      sig.className = `sig ${v === true ? 'ok' : v === false ? 'err' : 'mute'}`;
    });
  }
}

function drawShare() {
  const input = $('share-hash'), go = $('share-go'), hint = $('share-hint');
  const paint = () => {
    const h = normalHash(input.value);
    if (h) { go.href = shareUrl(h); go.removeAttribute('aria-disabled'); } else { go.removeAttribute('href'); go.setAttribute('aria-disabled', 'true'); }
    const mine = h && receipts.find((r) => r.contribution_hash === h);
    hint.textContent = !input.value.trim() ? '' : !h ? 'A contribution hash is 64 hex characters.'
      : mine ? `That is contribution #${mine.index}${mine.name ? `, by ${mine.name}` : ''}.` : 'Not in this page\'s copy of the transcript yet. It may be newer than the copy.';
  };
  input.addEventListener('input', paint);
  paint();
  return paint;
}

const repaint = drawShare();

// Take part: the command for this computer, with the address and name typed; the queue and the coordinator's address from the window
let coordinator = COORDINATOR;
function drawCommand() {
  const pre = $('cmd-run');
  if (!pre) return;
  pre.textContent = runCommand({ plat: $('plat').value, addr: $('addr').value, name: $('name').value, coordinator });
}
if ($('plat')) {
  $('plat').value = platformGuess(navigator.userAgent, navigator.platform || '');
  for (const id of ['plat', 'addr', 'name']) $(id).addEventListener('input', drawCommand);
  drawCommand();
}
async function drawQueue() {
  try {
    const r = await fetch('https://tacit-praxis-ceremony.onrender.com/api/coordinator', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
    const v = await r.json();
    if (/^https?:\/\/[^\s"'<>]+$/.test(v.coordinator || '')) { coordinator = v.coordinator; drawCommand(); }
    $('queue').textContent = v.open === false ? 'Closed' : waitText(v.queue);
  } catch { $('queue').textContent = 'Not read just now'; }
}
if ($('queue')) { drawQueue(); setInterval(drawQueue, 30_000); }
// the live transcript through the ceremony's HTTPS window (each receipt's signature is still checked below against the
// coordinator key); this site's copy if the window does not answer
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
try {
  const { t, live } = await readTranscript();
  if (!Array.isArray(t.receipts)) throw new Error('no receipts');
  const src = document.getElementById('src');
  if (src) src.textContent = live ? 'Read live from the coordinator.' : 'A copy of the coordinator\'s transcript.';
  receipts = t.receipts;
  drawChain(t);
  await drawReceipts(t);
  repaint();
} catch {
  $('receipts').replaceChildren(el('li', 'empty err', 'The transcript could not be read here.'));
}
