// The Tacit Praxis ceremony page: the chain read from this site's copy of the coordinator's transcript (the coordinator speaks plain HTTP,
// which an HTTPS page cannot fetch), each receipt's signature checked against the coordinator's key, the copy buttons and the share link.
import { COORDINATOR_KEY, SUCCINCT_CONTRIBUTORS, verifyReceipt, brokenLink, short, when, normalHash, shareUrl } from '/praxis/receipt.js?cb=53d90e6b';

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
    who.append(el('b', null, r.name), r.handle ? el('span', 'mute', ` ${r.handle}`) : '');
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
try {
  const res = await fetch('/praxis/transcript.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(String(res.status));
  const t = await res.json();
  if (!Array.isArray(t.receipts)) throw new Error('no receipts');
  receipts = t.receipts;
  drawChain(t);
  await drawReceipts(t);
  repaint();
} catch {
  $('receipts').replaceChildren(el('li', 'empty err', 'The transcript could not be read here.'));
}
