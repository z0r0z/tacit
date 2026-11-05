// /mine/: start and pause proving on this computer for TAC. The computer's tacit-prover (installed once with the line the page shows)
// answers on 127.0.0.1; the pool's tally and the points service say what the address has made and been paid.
import { cleanAddress, proveCommand, utcDay, mineLines } from '/community-prove.js?cb=9c90fa04';
import { localState, jobView, headline, isPhone } from '/mine/view.js?cb=2c62fdb8';

const API = 'https://api.tacit.finance', POINTS = 'https://tacit-points.onrender.com', LOCAL = 'http://127.0.0.1:47815';
const SAVED_ADDR = 'tacit-prove-address';                          // shared with the keeper page's card
const $ = (s) => document.querySelector(s);
const get = (url, ms = 4000) => fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(ms) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

let health = null, mine = null, pool = null, points = null, tally = null, busy = false;

const addr = () => cleanAddress($('#addr').value);

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
}

function paint() {
  const state = localState(health, mine), h = headline(state, mine), job = jobView(mine?.job);
  $('#state').dataset.s = state;
  $('#title').textContent = h.title;
  const bar = $('#bar');
  bar.hidden = !job;
  if (job) {
    $('#stage').textContent = `${job.stage} · ${job.left}`;
    bar.querySelector('i').style.width = job.pct == null ? '' : `${(job.pct * 100).toFixed(1)}%`;
    bar.classList.toggle('spin', job.pct == null);
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

if (isPhone(navigator.userAgent)) {
  $('#phone').hidden = false;
  $('#desk').hidden = true;
} else {
  try { const saved = localStorage.getItem(SAVED_ADDR); if (cleanAddress(saved)) $('#addr').value = saved; } catch {}
  $('#addr').addEventListener('input', addressChanged);
  $('#go').addEventListener('click', toggle);
  $('#copy').addEventListener('click', copy);
  paint();
  // The computer is read every two seconds (it is on this machine), the pool and the points service every half minute.
  const local = async () => { await readLocal(); paint(); setTimeout(local, document.hidden ? 10000 : 2000); };
  const remote = async () => { await readRemote(); paint(); setTimeout(remote, 30000); };
  local(); remote();
}
