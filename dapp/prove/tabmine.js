// Salt mining in a browser tab, with nothing installed: grinding threads (salt-worker.js, each a makeGrindLoop below) find shares, and makeTabMiner sends them
// to the API's salt pool for the address the page pays, as tacit-prover does between proofs (salt.rs): the best first, at most 64 in a send, a send about every
// 21 s (the pool takes one every 20 s from a connection), and again when the pool says after a "too soon". Nothing here touches the page: app.js starts and
// stops it and paints what state() says.
import { bestGrinder, nextBatch, utcDay, toHex, SEND_EVERY_MS } from '/prove/saltcore.js?cb=845ff17e';

export const CLIENT = 'tacit-prove-tab/1';   // what the pool lists this miner as
// as gentle as tacit-prover's own grinding by default: a quarter of the cores; the person can raise it to all but one
export const defaultThreads = (cores) => Math.max(1, Math.floor((Number(cores) || 2) / 4));
export const maxThreads = (cores) => Math.max(1, (Number(cores) || 2) - 1);

// ---- a grinding thread. post({ type: 'work', hashes, shares: [{ salt, bits }], wasm }) after each chunk; a chunk is sized to take about a fifth of a second, so
// a stop is heard quickly. A new run of salts (another 5 random bytes) starts with each UTC day and before the 4-byte counter comes round.
export function makeGrindLoop({ post, random = (n) => crypto.getRandomValues(new Uint8Array(n)), now = () => performance.now(), today = () => utcDay(), rest = () => new Promise((r) => setTimeout(r, 0)), grinderOf = bestGrinder }) {
  let minBits = 26, running = false, grinder = null, walked = 0, chunk = 1 << 14;
  async function run() {
    while (running) {
      if (!grinder || grinder.day !== today() || walked > 0xf0000000) { grinder = grinderOf({ day: today(), prefix: random(5) }); walked = 0; }
      const t0 = now(), found = grinder.grind(chunk, minBits), ms = now() - t0;
      walked += chunk;
      post({ type: 'work', hashes: chunk, shares: found.map((f) => ({ salt: '0x' + toHex(grinder.saltOf(f.n)), bits: f.bits })), wasm: grinder.wasm === true });
      if (ms < 120 && chunk < (1 << 20)) chunk *= 2; else if (ms > 400 && chunk > (1 << 10)) chunk >>= 1;
      await rest();
    }
  }
  return {
    message(m) {
      if (!m || typeof m !== 'object') return;
      if (Number.isInteger(m.minBits) && m.minBits >= 8 && m.minBits <= 64) minBits = m.minBits;
      if (m.type === 'start' && !running) { running = true; run(); }
      if (m.type === 'stop') running = false;
    },
    running: () => running,
  };
}

// ---- the miner. makeWorker() -> { postMessage, terminate, onmessage= }; fetchImpl, now and timers can be stood in. onChange() after anything state() would show.
export function makeTabMiner({ api, makeWorker, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) }, jitter = () => Math.floor(Math.random() * 3000), onChange = () => {} }) {
  let workers = [], threads = 1, miner = null, minBits = 26, on = false, paused = null, wasm = null;
  let found = [], marks = [], hashes = 0, timer = null, sending = false, today = null, accepted = 0, error = null;
  const tell = (w, m) => { try { w.postMessage(m); } catch { /* a thread that died: the next start makes a new one */ } };
  const grinding = () => on && !paused;
  function sync() {   // as many threads as asked, grinding or not
    const want = grinding() ? threads : 0;
    while (workers.length > want) { const w = workers.pop(); tell(w, { type: 'stop' }); w.terminate(); }
    while (workers.length < want) {
      const w = makeWorker();
      w.onmessage = (e) => { const m = e.data || {}; if (m.type !== 'work' || !grinding()) return; hashes += m.hashes || 0; marks.push({ t: now(), h: m.hashes || 0 }); if (m.wasm != null) wasm = m.wasm; for (const s of m.shares || []) found.push(s); if ((m.shares || []).length) onChange(); };
      w.onerror = () => { error = 'a grinding thread stopped'; onChange(); };
      tell(w, { type: 'start', minBits }); workers.push(w);
    }
  }
  // salts a second, over the last 15 seconds or so: each thread reports the salts of the chunk it just finished
  function rate() {
    const t = now(); marks = marks.filter((m) => t - m.t < 15_000);
    if (marks.length < 2) return 0;
    const span = (marks[marks.length - 1].t - marks[0].t) / 1000;
    return span >= 0.5 ? marks.slice(1).reduce((a, m) => a + m.h, 0) / span : 0;
  }
  const plan = (ms) => { timers.clear(timer); timer = on ? timers.set(send, ms) : null; };
  async function send({ keepalive = false } = {}) {
    if (sending) return;
    let wait = SEND_EVERY_MS + jitter();
    const { send: batch, rest } = nextBatch(found, utcDay(now()));
    found = rest;
    if (batch.length && miner) {
      sending = true;
      try {
        const r = await fetchImpl(`${api}/prover/salt/share`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ miner, salts: batch.map((s) => s.salt), client: CLIENT }), keepalive });
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
    start({ miner: m, threads: n, minBits: b }) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(m))) return false;
      miner = m.toLowerCase(); if (Number.isInteger(n) && n >= 1) threads = n; if (Number.isInteger(b)) minBits = b;
      if (!on) { on = true; error = null; marks = []; plan(SEND_EVERY_MS + jitter()); }
      sync(); onChange(); return true;
    },
    // what was found and not yet sent goes in one last send, if the pool will take it
    stop({ keepalive = false } = {}) { if (!on) return; on = false; sync(); timers.clear(timer); timer = null; marks = []; if (found.length) send({ keepalive }); onChange(); },
    setThreads(n) { if (Number.isInteger(n) && n >= 1) { threads = n; sync(); onChange(); } },
    setMinBits(b) { if (Number.isInteger(b) && b >= 8 && b <= 64 && b !== minBits) { minBits = b; for (const w of workers) tell(w, { minBits }); } },
    setMiner(m) { if (/^0x[0-9a-fA-F]{40}$/.test(String(m))) miner = m.toLowerCase(); },
    // a reason it should not grind now (on battery), or null: the threads stop and start with it, the shares already found are still sent
    setPaused(why) { const p = why || null; if (p !== paused) { paused = p; marks = []; sync(); onChange(); } },
    state: () => ({ on, paused, threads, grinding: workers.length, rate: grinding() ? rate() : 0, hashes, waiting: found.length, accepted, today: today && today.day === utcDay(now()) ? today : null, wasm, error, miner }),
  };
}
