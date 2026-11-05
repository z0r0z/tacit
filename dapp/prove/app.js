// /prove/: the network's blocks as they land, the proofs waiting and the provers making them, and this computer's own prover, started
// and paused from here. The computer's tacit-prover (installed once with the line the page shows) answers on 127.0.0.1; the API's chain
// (GET /prover/blocks) and proof pool, and the points service, say what the network did and what an address has made and been paid.
import { cleanAddress, proveCommand, utcDay, mineLines } from '/community-prove.js?cb=9c90fa04';
import { localState, jobView, headline, isPhone } from '/prove/view.js?cb=f6efbcdd';
import { short, hueOf, cells, opsText, tac, rewardWei, ago, took, fresh } from '/prove/chain.js?cb=045857de';

const API = 'https://api.tacit.finance', POINTS = 'https://tacit-points.onrender.com', LOCAL = 'http://127.0.0.1:47815';
const SAVED_ADDR = 'tacit-prove-address';                          // shared with the keeper page's card
const SHOW = 40;
const $ = (s) => document.querySelector(s);
const get = (url, ms = 6000) => fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(ms) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let health = null, mine = null, pool = null, points = null, tally = null, busy = false;
let blocks = [], shownTop = null, picked = null, feed = [], feedTop = 0, lastProved = null;

const addr = () => cleanAddress($('#addr').value);
const me = () => addr()?.toLowerCase() || null;
const cap = () => (points?.enabled && points?.terms && !points.terms.off ? points.terms.capWeiPerPoint : null);
const who = (a) => `<span class="who"><i style="--c:hsl(${hueOf(a)} 70% 50%)"></i>${esc(short(a))}${a === me() ? ' · you' : ''}</span>`;
// Tacit's own GPU, drawn apart from the community: no address, no TAC.
const GPU = '<span class="who gpu"><i></i>Tacit GPU</span>';
const byOf = (x) => (x.house ? GPU : x.prover || x.miner ? who(x.prover || x.miner) : null);

async function readLocal() {
  health = await get(`${LOCAL}/health`, 2500);
  mine = health?.ok ? await get(`${LOCAL}/mine`, 2500) : null;
  // The prover's own address fills an empty field: it is where this computer's proofs already pay.
  if (mine?.miner && !$('#addr').value) { $('#addr').value = mine.miner; addressChanged(); }
}

async function readRemote() {
  const a = addr();
  const [p, m, t] = await Promise.all([get(`${API}/prover/pool`), get(`${POINTS}/mine${a ? `?address=${a.toLowerCase()}` : ''}`), a ? get(`${API}/prover/pool/credits?day=${utcDay()}`) : null]);
  if (a !== addr()) return;
  pool = p; points = m; tally = t;
  paintNet(); paintFeed(); paintDetail();
}

// The chain, read often: a new block lands at the front of the strip.
async function readChain() {
  const c = await get(`${API}/prover/blocks?limit=${SHOW}`);
  if (!c?.blocks) { $('#chain').hidden = !blocks.length; return; }
  const add = fresh(c.blocks, shownTop);
  if (!add.length && shownTop != null) return;
  const first = shownTop == null;
  blocks = [...add, ...blocks].slice(0, SHOW);
  shownTop = blocks[0]?.height ?? shownTop;
  paintChain(first ? new Set() : new Set(add.map((b) => b.height)));
  const h = $('#height');
  h.textContent = `#${shownTop.toLocaleString('en-US')}`;
  if (!first) { h.classList.remove('bump'); void h.offsetWidth; h.classList.add('bump'); }
}

function paintChain(landing) {
  const ol = $('#chain');
  ol.hidden = false;
  ol.innerHTML = blocks.map((b) => {
    const c = cells(b), mineB = b.prover && b.prover === me();
    return `<li class="blk${b.prover ? ' won' : ''}${b.house ? ' gpu' : ''}${mineB ? ' mine' : ''}${landing.has(b.height) ? ' new' : ''}" data-h="${b.height}" aria-current="${picked === b.height}">
      <button type="button" aria-label="Block ${b.height}, ${esc(opsText(b))}"><span class="cube">${c.cells.map((k) => `<i class="${k}"></i>`).join('')}</span>
      <span class="h num">#${b.height.toLocaleString('en-US')}</span><span class="o">${byOf(b) || esc(opsText(b))}</span></button></li>`;
  }).join('');
  paintDetail();
}

function paintDetail() {
  const d = $('#detail'), b = blocks.find((x) => x.height === picked);
  d.hidden = !b;
  if (!b) return;
  const r = b.prover ? rewardWei(b.points, cap()) : null;
  d.innerHTML = `<div class="rows flat num">
    <div class="kv"><span>Block</span><b>#${b.height.toLocaleString('en-US')}</b></div>
    <div class="kv"><span>Holds</span><b>${esc(opsText(b))}</b></div>
    <div class="kv"><span>Proved by</span><b>${byOf(b) || '—'}</b></div>
    ${b.prover ? `<div class="kv"><span>Won</span><b>${r ? `${tac(r)} TAC` : `${b.points} points`}</b></div>` : ''}
    <div class="kv"><span>Hash</span><b>${esc(short(b.hash))}</b></div>
    <div class="kv"><span>Ethereum</span><b><a href="https://etherscan.io/tx/${esc(b.tx)}" target="_blank" rel="noopener noreferrer">block ${b.ethBlock.toLocaleString('en-US')}</a></b></div>
  </div>`;
}

// The waiting proofs as little squares (the leased ones lit), the day's numbers, the newest community proofs and the day's provers.
async function readFeed() {
  const f = await get(`${API}/prover/pool/recent`);
  if (f?.proofs) feed = f.proofs;
  paintFeed();
  feedTop = Math.max(feedTop, feed[0]?.at || 0);
}

function paintFeed() {
  if (!feed.length) return;
  $('#feed').innerHTML = feed.slice(0, 8).map((p) => {
    const r = rewardWei(p.points, cap());
    return `<li class="${p.at > feedTop && feedTop ? 'new' : ''}"><span>${byOf(p)} <small>${esc(took(p.secs))}</small></span>${r ? `<b>+${tac(r)} TAC</b>` : ''}<small>${esc(ago(p.at))}</small></li>`;
  }).join('');
}

function paintNet() {
  const q = pool?.queued ?? null, l = pool?.leased ?? null;
  $('#n-wait').textContent = q == null ? '—' : String(q);
  $('#n-lease').textContent = l == null ? '—' : String(l);
  $('#n-provers').textContent = pool?.minersToday == null ? '—' : String(pool.minersToday);
  $('#n-done').textContent = pool?.doneToday == null ? '—' : String(pool.doneToday);
  const n = Math.min(60, (q || 0) + (l || 0));
  $('#pool').innerHTML = Array.from({ length: n }, (_, k) => `<i class="${k < (l || 0) ? 'on' : ''}" style="--k:${k}"></i>`).join('')
    + ((q || 0) + (l || 0) > n ? `<span>+${(q || 0) + (l || 0) - n}</span>` : '');
  const top = pool?.top || [];
  if (top.length) $('#board').innerHTML = top.slice(0, 8).map((m, i) => `<li><span>${i + 1}. ${who(m.miner)}</span><small>${m.proofs} ${m.proofs === 1 ? 'proof' : 'proofs'}</small></li>`).join('');
}

function paint() {
  const state = localState(health, mine), h = headline(state, mine), job = jobView(mine?.job);
  $('#state').dataset.s = state;
  $('#title').textContent = h.title;
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
  go.textContent = h.button || '';
  go.disabled = busy;
  $('#setup').hidden = state !== 'none' && state !== 'old';
  $('#cmd').textContent = proveCommand(addr());
  const l = mineLines(pool, points, { tally, address: addr() });
  $('#pays').textContent = l.pays || '—';
  $('#today').textContent = l.today || '—';
  $('#paid').textContent = l.credited || '—';
  $('#run').textContent = mine?.proved ? String(mine.proved) : '0';
  $('#run-row').hidden = !mine || typeof mine.on !== 'boolean';
}

function addressChanged() {
  const a = addr();
  $('#addr').setAttribute('aria-invalid', $('#addr').value.trim() && !a ? 'true' : 'false');
  if (a) { try { localStorage.setItem(SAVED_ADDR, a); } catch {} }
  paint();
  if (blocks.length) paintChain(new Set());
  paintFeed();
  readRemote().then(paint);
}

async function toggle() {
  const on = !mine?.on, a = addr();
  if (on && !a) { $('#addr').focus(); say('Enter the address the TAC goes to.', true); return; }
  busy = true; paint();
  try {
    const r = await fetch(`${LOCAL}/mine`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(on ? { miner: a, on } : { on }) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(j?.error || `tacit-prover answered ${r.status}`);
    mine = j;
    say(on ? 'Started. The first proof on this computer downloads 6.2 GB first.' : (mine.job ? 'Pausing after the proof under way.' : 'Paused.'));
  } catch (e) { say(e.message || 'tacit-prover did not answer.', true); }
  busy = false; paint();
}

function say(text, bad = false) {
  const s = $('#say');
  s.textContent = text;
  s.classList.toggle('err', bad);
}

async function copy() {
  const a = addr();
  if (!a) { $('#addr').focus(); say('Enter the address the TAC goes to.', true); return; }
  try { await navigator.clipboard.writeText(proveCommand(a)); say('Copied. Paste it in Terminal; this page sees it start.'); }
  catch {
    const sel = getSelection(), range = document.createRange();
    range.selectNodeContents($('#cmd')); sel.removeAllRanges(); sel.addRange(range);
    say('Press Cmd+C or Ctrl+C to copy it.');
  }
}

$('#chain').addEventListener('click', (e) => {
  const li = e.target.closest('.blk');
  if (!li) return;
  const h = Number(li.dataset.h);
  picked = picked === h ? null : h;
  $('#chain').querySelectorAll('.blk').forEach((x) => x.setAttribute('aria-current', String(Number(x.dataset.h) === picked)));
  paintDetail();
});

try { const saved = localStorage.getItem(SAVED_ADDR); if (cleanAddress(saved)) $('#addr').value = saved; } catch {}
const loop = (fn, ms, idle) => { const run = async () => { await fn(); setTimeout(run, document.hidden ? idle : ms); }; run(); };
// The chain every six seconds, the pool and the feed every ten, the points service every half minute.
loop(readChain, 6000, 30000);
loop(readFeed, 10000, 60000);
loop(async () => { pool = (await get(`${API}/prover/pool`)) ?? pool; paintNet(); }, 10000, 60000);
loop(readRemote, 30000, 120000);
if (isPhone(navigator.userAgent)) {
  $('#phone').hidden = false;
  $('#desk').hidden = true;
} else {
  $('#addr').addEventListener('input', addressChanged);
  $('#go').addEventListener('click', toggle);
  $('#copy').addEventListener('click', copy);
  paint();
  // The computer is read every two seconds: it is on this machine.
  loop(async () => { await readLocal(); paint(); }, 2000, 10000);
}
