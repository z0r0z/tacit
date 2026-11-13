// Salt mining in a browser tab, with nothing installed: grinding threads (salt-worker.js, each a makeGrindLoop below) find shares, and makeTabMiner sends them
// to the API's salt pool for the address the page pays, as tacit-prover does between proofs (salt.rs): the best first, at most 64 in a send, a send about every
// 21 s (the pool takes one every 20 s from a connection), and again when the pool says after a "too soon". Nothing here touches the page: app.js starts and
// stops it and paints what state() says.
import { bestGrinder, nextBatch, utcDay, toHex, SEND_EVERY_MS } from '/prove/saltcore.js?cb=87770f39';

export const CLIENT = 'tacit-prove-tab/1';   // what the pool lists this miner as (with +gpu while its GPU thread runs)
// as gentle as tacit-prover's own grinding by default: a quarter of the cores; the person can raise it to all but one
export const defaultThreads = (cores) => Math.max(1, Math.floor((Number(cores) || 2) / 4));
export const maxThreads = (cores) => Math.max(1, (Number(cores) || 2) - 1);

// What part of a day's salt points a miner grinding `rate` salts a second can expect. The pool shares the points by weight, and a share's weight doubles with
// every zero bit past the smallest (up to maxWeightBits), so most of a day's weight is in its few best shares: a miner with more shares in the day finds better
// ones, and gets more than its part of the salts ground. So this is not rate over the network's rate. It takes the weight a miner with that many shares
// typically ends a day with (each further zero bit as far as its share count reaches, or as far as the pool's cap lets a share weigh), against the network's weight in a day: today's so far carried to the
// whole day (netWeight over dayFrac, once two hours in), or what its rate would make at a share's mean weight, whichever is more.
export function dayShare({ rate, minBits = 26, maxWeightBits = 20, netWeight = 0, netRate = 0, dayFrac = 1 }) {
  if (!(rate > 0)) return 0;
  const perShare = 2 ** minBits, shares = (rate * 86400) / perShare;
  // half its shares have no bit to spare, a quarter one, and so on: each level its count reaches adds half a share's weight a share, and with the cap inside
  // that reach everything past it weighs the cap (at a cap of none, one a share)
  const reach = Math.log2(Math.max(shares, 2));
  const mine = (shares * (maxWeightBits < reach ? maxWeightBits + 2 : reach + 1)) / 2;
  const byWeight = dayFrac >= 1 / 12 && netWeight > 0 ? netWeight / Math.min(1, dayFrac) : 0;
  const byRate = netRate > 0 ? (((maxWeightBits + 2) / 2) * netRate * 86400) / perShare : 0;
  const net = Math.max(byWeight, byRate);
  return net > 0 ? mine / (net + mine) : 0;
}

// ---- a grinding thread. post({ type: 'work', hashes, shares: [{ salt, bits }], wasm, gpu }) after each chunk; a chunk is sized to take about a fifth of a second
// (a twentieth on the GPU, which the screen shares), so a stop is heard quickly. A new run of salts (another 5 random bytes) starts with each UTC day and before
// the 4-byte counter comes round. Started with gpu, the thread grinds on the GPU (gpuGrinderOf, saltgpu.js) and nothing else: where that cannot be had, or is lost,
// it says so (post({ type: 'gpu', ok: false })) and stops. `duty` under 1 rests the thread after each chunk for that share of the time (0.5: as long as it worked).
export function makeGrindLoop({ post, random = (n) => crypto.getRandomValues(new Uint8Array(n)), now = () => performance.now(), today = () => utcDay(), rest = () => new Promise((r) => setTimeout(r, 0)),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), grinderOf = bestGrinder, gpuGrinderOf = null }) {
  let minBits = 26, running = false, grinder = null, walked = 0, chunk = 1 << 14, gpu = false, duty = 1;
  const drop = () => { try { grinder?.close?.(); } catch { /* gone already */ } grinder = null; };
  const noGpu = () => { drop(); running = false; post({ type: 'gpu', ok: false }); };
  async function run() {
    while (running) {
      if (!grinder || grinder.day !== today() || walked > 0xf0000000) {
        drop();
        const o = { day: today(), prefix: random(5) };
        if (gpu) { let g = null; try { g = gpuGrinderOf ? await gpuGrinderOf(o) : null; } catch { g = null; } if (!g) { noGpu(); return; } grinder = g; chunk = 1 << 18; }
        else grinder = grinderOf(o);
        walked = 0;
      }
      const from = grinder.at ? grinder.at() : 0, t0 = now();
      let found; try { found = await grinder.grind(chunk, minBits); } catch (e) { if (gpu) { noGpu(); return; } throw e; }
      const ms = now() - t0, did = grinder.at ? (grinder.at() - from) >>> 0 : chunk;
      walked += did;
      post({ type: 'work', hashes: did, shares: found.map((f) => ({ salt: '0x' + toHex(grinder.saltOf(f.n)), bits: f.bits })), wasm: grinder.wasm === true, gpu: grinder.gpu === true });
      const target = gpu ? 50 : 200, top = grinder.maxChunk || (1 << 20);
      if (ms < target * 0.6 && chunk * 2 <= top) chunk *= 2; else if (ms > target * 2 && chunk > (1 << 10)) chunk >>= 1;
      if (duty < 1 && ms > 0) await sleep(ms * (1 / duty - 1));
      await rest();
    }
    drop();
  }
  return {
    message(m) {
      if (!m || typeof m !== 'object') return;
      if (Number.isInteger(m.minBits) && m.minBits >= 8 && m.minBits <= 64) minBits = m.minBits;
      if (typeof m.duty === 'number' && m.duty > 0 && m.duty <= 1) duty = m.duty;
      if (m.type === 'start' && !running) { gpu = m.gpu === true; running = true; run(); }
      if (m.type === 'stop') running = false;
    },
    running: () => running,
  };
}

// How hard the GPU is worked: half rests it as long as it works (the screen stays smooth); full rests it a tenth of the time, which is what lets the browser
// still draw the page between its bursts.
export const GPU_LEVELS = ['off', 'half', 'full'];
const DUTY = { half: 0.5, full: 0.9 };

// ---- the miner. makeWorker() -> { postMessage, terminate, onmessage= }; fetchImpl, now and timers can be stood in. onChange() after anything state() would show.
// Beside the threads on the cores it runs one more on the GPU when asked (gpu: 'half' or 'full'); a GPU that cannot be had is noted and the cores go on alone.
export function makeTabMiner({ api, makeWorker, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) }, jitter = () => Math.floor(Math.random() * 3000), onChange = () => {} }) {
  let workers = [], threads = 1, miner = null, minBits = 26, on = false, paused = null, wasm = null;
  let gpuLevel = 'off', gpuWorker = null, gpuFailed = false, gpuMarks = [];
  let found = [], marks = [], hashes = 0, timer = null, sending = false, today = null, accepted = 0, error = null;
  const tell = (w, m) => { try { w.postMessage(m); } catch { /* a thread that died: the next start makes a new one */ } };
  const grinding = () => on && !paused;
  const endGpu = () => { if (!gpuWorker) return; tell(gpuWorker, { type: 'stop' }); gpuWorker.terminate(); gpuWorker = null; gpuMarks = []; };
  const hear = (w, onGpu) => (e) => {
    const m = e.data || {};
    if (m.type === 'gpu' && m.ok === false) { if (w === gpuWorker) { gpuFailed = true; endGpu(); onChange(); } return; }
    if (m.type !== 'work' || !grinding()) return;
    hashes += m.hashes || 0; (onGpu ? gpuMarks : marks).push({ t: now(), h: m.hashes || 0 });
    if (!onGpu && m.wasm != null) wasm = m.wasm;
    for (const s of m.shares || []) found.push(s);
    if ((m.shares || []).length) onChange();
  };
  function sync() {   // as many threads as asked, grinding or not; and the GPU's
    const want = grinding() ? threads : 0;
    while (workers.length > want) { const w = workers.pop(); tell(w, { type: 'stop' }); w.terminate(); }
    while (workers.length < want) {
      const w = makeWorker();
      w.onmessage = hear(w, false);
      w.onerror = () => { error = 'a grinding thread stopped'; onChange(); };
      tell(w, { type: 'start', minBits }); workers.push(w);
    }
    const wantGpu = grinding() && gpuLevel !== 'off' && !gpuFailed;
    if (gpuWorker && !wantGpu) endGpu();
    if (!gpuWorker && wantGpu) {
      const w = makeWorker(); gpuWorker = w;
      w.onmessage = hear(w, true);
      w.onerror = () => { if (w === gpuWorker) { gpuFailed = true; endGpu(); onChange(); } };
      tell(w, { type: 'start', minBits, gpu: true, duty: DUTY[gpuLevel] });
    }
  }
  // salts a second, over the last 15 seconds or so: each thread reports the salts of the chunk it just finished
  function rateOf(list) {
    const t = now(), live = list.filter((m) => t - m.t < 15_000);
    if (live.length < 2) return { live, rate: 0 };
    const span = (live[live.length - 1].t - live[0].t) / 1000;
    return { live, rate: span >= 0.5 ? live.slice(1).reduce((a, m) => a + m.h, 0) / span : 0 };
  }
  function rate() { const c = rateOf(marks), g = rateOf(gpuMarks); marks = c.live; gpuMarks = g.live; return { cores: c.rate, gpu: g.rate }; }
  const plan = (ms) => { timers.clear(timer); timer = on ? timers.set(send, ms) : null; };
  async function send({ keepalive = false } = {}) {
    if (sending) return;
    let wait = SEND_EVERY_MS + jitter();
    const { send: batch, rest } = nextBatch(found, utcDay(now()));
    found = rest;
    if (batch.length && miner) {
      sending = true;
      try {
        const r = await fetchImpl(`${api}/prover/salt/share`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ miner, salts: batch.map((s) => s.salt), client: gpuWorker ? `${CLIENT}+gpu` : CLIENT }), keepalive });
        const j = await r.json().catch(() => null);
        if (r.status === 429) { found.push(...batch); wait = Math.min(60_000, Number(j?.retryMs) || 5000) + jitter(); }     // another miner behind this connection sent first: these wait
        else if (r.ok && j?.ok) { accepted += Number(j.accepted) || 0; if (j.today) today = { day: utcDay(now()), ...j.today }; error = null; }
        else if (r.status >= 500) { found.push(...batch); error = 'the salt pool did not answer'; }
        else error = String(j?.error || `the salt pool answered ${r.status}`).slice(0, 120);                                // refused: sending them again would be refused again
      } catch { found.push(...batch); error = 'the salt pool could not be reached'; }
      sending = false; onChange();
    }
    plan(wait);
  }
  return {
    // -> true if it started. An address is needed: it is where the points go.
    start({ miner: m, threads: n, minBits: b, gpu }) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(m))) return false;
      miner = m.toLowerCase(); if (Number.isInteger(n) && n >= 0) threads = n; if (Number.isInteger(b)) minBits = b;
      if (GPU_LEVELS.includes(gpu)) { gpuLevel = gpu; gpuFailed = false; }
      if (!on) { on = true; error = null; marks = []; gpuMarks = []; plan(SEND_EVERY_MS + jitter()); }
      sync(); onChange(); return true;
    },
    // what was found and not yet sent goes in one last send, if the pool will take it
    stop({ keepalive = false } = {}) { if (!on) return; on = false; sync(); timers.clear(timer); timer = null; marks = []; if (found.length) send({ keepalive }); onChange(); },
    // none is allowed: the GPU alone, while tacit-prover has the cores
    setThreads(n) { if (Number.isInteger(n) && n >= 0) { threads = n; sync(); onChange(); } },
    // off, half or full; choosing one again after the GPU could not be had tries it again
    setGpu(level) { if (!GPU_LEVELS.includes(level)) return; gpuLevel = level; gpuFailed = false; if (gpuWorker && level !== 'off') tell(gpuWorker, { duty: DUTY[level] }); sync(); onChange(); },
    setMinBits(b) { if (Number.isInteger(b) && b >= 8 && b <= 64 && b !== minBits) { minBits = b; for (const w of [...workers, ...(gpuWorker ? [gpuWorker] : [])]) tell(w, { minBits }); } },
    setMiner(m) { if (/^0x[0-9a-fA-F]{40}$/.test(String(m))) miner = m.toLowerCase(); },
    // a reason it should not grind now (on battery), or null: the threads stop and start with it, the shares already found are still sent
    setPaused(why) { const p = why || null; if (p !== paused) { paused = p; marks = []; gpuMarks = []; sync(); onChange(); } },
    state: () => { const r = grinding() ? rate() : { cores: 0, gpu: 0 }; return { on, paused, threads, grinding: workers.length, rate: r.cores + r.gpu, hashes, waiting: found.length, accepted, today: today && today.day === utcDay(now()) ? today : null, wasm, error, miner,
      gpu: { level: gpuLevel, on: !!gpuWorker, rate: r.gpu, failed: gpuFailed } }; },
  };
}
