const POINTS = 'https://tacit-points.onrender.com';
const KEY = 'tacit-tasks-live-v1';
const FRESH = 300e3;
const WAD = 10n ** 18n;

const get = (url) => fetch(url, { signal: AbortSignal.timeout(8e3) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

export function liveJobs(jobs, api, now = Date.now() / 1000, deployed = new Set()) {
  if (!api?.enabled || !Array.isArray(api.jobs) || !Array.isArray(jobs)) return [];
  if (api.endSec && now >= api.endSec) return [];
  let room = null;
  try { if (api.budget?.remainingWei != null) room = BigInt(api.budget.remainingWei); } catch { return []; }
  if (room !== null && room <= 0n) return [];
  const out = [];
  for (const j of api.jobs) {
    const meta = jobs.find((x) => x.id === j.id);
    if (!meta?.opensAt || meta.retired || now < meta.opensAt || !Array.isArray(j.steps)) continue;
    const left = j.steps.filter((s) => !s.claim && !deployed.has(`${j.id}:${s.id}`));
    if (!left.length) continue;
    let wei = null;
    try { if (left.every((s) => s.estimateWei != null)) wei = left.reduce((n, s) => n + BigInt(s.estimateWei), 0n); } catch { wei = null; }
    out.push({ id: j.id, title: String(meta.title || ''), wei: wei === null ? null : String(room !== null && wei > room ? room : wei) });
  }
  return out;
}

// A contract that is already on Ethereum has nothing left to send, whether or not its reward has been named to the service yet.
async function deployedSteps(jobs, api, live) {
  const asks = [];
  for (const j of api.jobs) {
    const meta = live.some((l) => l.id === j.id) ? jobs.find((x) => x.id === j.id) : null;
    for (const s of j.steps || []) {
      const at = meta && !s.claim ? meta.steps?.find((x) => x.id === s.id) : null;
      if (at?.kind === 'createx' && (at.chainId ?? meta.chainId) === 1) asks.push([`${j.id}:${s.id}`, at.expected]);
    }
  }
  if (!asks.length) return new Set();
  const { rpc } = await import('/trade/util.js?cb=e53086bb');
  const code = await Promise.all(asks.map(([, to]) => rpc('eth_getCode', [to, 'latest']).catch(() => '0x')));
  return new Set(asks.filter((_, i) => code[i] !== '0x').map(([key]) => key));
}

export function pill(live) {
  const sum = live.every((j) => j.wei !== null) ? live.reduce((n, j) => n + BigInt(j.wei), 0n) : null;
  const tac = sum === null ? 0n : (sum + WAD / 2n) / WAD;
  const prize = tac > 0n ? `Earn ${live.length > 1 ? 'up to ' : ''}${tac.toLocaleString('en-US')} TAC` : 'Earn TAC';
  return { head: live.length === 1 ? 'Task' : `${live.length} tasks`, tail: prize, title: live.length === 1 ? live[0].title : live.map((j) => j.title).join(', ') };
}

function show(live) {
  const a = document.getElementById('task-news');
  if (!a) return;
  if (!live.length) { a.hidden = true; return; }
  const p = pill(live);
  a.querySelector('b').textContent = p.head;
  a.querySelector('[data-task-t]').textContent = p.tail;
  if (p.title) a.title = p.title; else a.removeAttribute('title');
  a.hidden = false;
}

function remembered() {
  try {
    const c = JSON.parse(localStorage.getItem(KEY));
    if (c && Array.isArray(c.live) && Date.now() - c.at < FRESH) return c.live;
  } catch { }
  return null;
}

async function run() {
  const kept = remembered();
  if (kept) return show(kept);
  const [jobs, api] = await Promise.all([get('/tasks/jobs.json'), get(`${POINTS}/tasks`)]);
  if (!jobs || !api) return;
  let live = liveJobs(jobs.jobs, api);
  if (live.length) {
    const deployed = await deployedSteps(jobs.jobs, api, live).catch(() => new Set());
    if (deployed.size) live = liveJobs(jobs.jobs, api, undefined, deployed);
  }
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), live })); } catch { }
  show(live);
}

if (typeof document !== 'undefined' && document.getElementById('task-news')) {
  const idle = window.requestIdleCallback ? (f) => window.requestIdleCallback(f, { timeout: 4000 }) : (f) => setTimeout(f, 1500);
  const go = () => idle(() => { run().catch(() => {}); });
  if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
}
