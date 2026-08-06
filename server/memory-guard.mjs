// Keeps the API inside whichever memory ceiling it will hit first.
//
// Running out of memory is never a clean stop: over the container limit the
// platform sends SIGKILL, and over the V8 heap limit the process aborts
// outright. Either way in-flight requests die mid-response and waitUntil
// writes are lost. Everything here exists to reach a graceful exit instead.
//
// Two ceilings are watched, because either one ends the process on its own
// and they are reached by different growth:
//
//   RSS against the cgroup limit — what the platform accounts for, and the
//     only figure that sees off-heap Buffer growth (the response cache).
//
//   V8's old space against its own cap — the one that aborts with FATAL
//     "Reached heap limit". That cap defaults to about half the instance, so
//     it is normally the nearer of the two: the heap can be exhausted while
//     more than half the container is still free, which an RSS-only check
//     reports as healthy right up to the abort.
//
// Pressure is the higher of the two ratios, so the nearer ceiling governs,
// and each stage names the ceiling it acted on:
//
//   soft (default 75%) — drop the response cache. Those bodies are Buffers
//     held outside the V8 heap, so they are the largest block of memory that
//     can be returned synchronously, and losing them costs only latency.
//     Also nudges the GC when --expose-gc is on.
//
//   hard (default 90%) — reclaiming didn't hold, so something is growing that
//     we can't recover (an unbounded in-memory KV driver, a leak). Shut down
//     gracefully: finish in-flight responses, drain background work, exit 0.
//     The platform restarts it as a normal recycle.
//
// The sample interval has to beat the fastest observed climb, not the average:
// a cron tick here has gone from ~100MB to over 380MB inside 30s, so a slow
// poll can step straight from "fine" to a dead process without ever seeing
// the threshold.

import v8 from 'node:v8';

const MB = 1024 * 1024;

// The ceiling that actually aborts the process is the old-space cap, and
// `heap_size_limit` is not it: it covers every space at once, so under
// --max-old-space-size=120 it reads 168MB and old-space dies at 120 having
// never passed 75% of that figure. When the flag is set it is the authority,
// measured against the spaces it governs; only when it is absent does
// heap_size_limit describe the real ceiling.
const oldSpaceCap = () => {
  const args = [...process.execArgv, ...(process.env.NODE_OPTIONS || '').split(/\s+/)];
  for (const a of args) {
    const m = /^--max[-_]old[-_]space[-_]size=(\d+)$/.exec(a);
    if (m) return Number(m[1]) * MB;
  }
  return null;
};

const CAPPED_SPACES = new Set(['old_space', 'large_object_space']);

const heapStats = () => {
  try {
    const cap = oldSpaceCap();
    if (cap) {
      const used = v8.getHeapSpaceStatistics()
        .filter((s) => CAPPED_SPACES.has(s.space_name))
        .reduce((n, s) => n + s.space_used_size, 0);
      return { limit: cap, used };
    }
    const { heap_size_limit: limit, used_heap_size: used } = v8.getHeapStatistics();
    return Number.isFinite(limit) && limit > 0 ? { limit, used } : null;
  } catch { return null; }
};

export function startMemoryGuard({
  limitBytes,
  cacheStorage,
  onShutdown,
  intervalMs = Number(process.env.MEM_CHECK_MS) || 5_000,
  softRatio = Number(process.env.MEM_SOFT_RATIO) || 0.75,
  hardRatio = Number(process.env.MEM_HARD_RATIO) || 0.90,
} = {}) {
  if (!limitBytes || !Number.isFinite(limitBytes)) return null;

  const soft = limitBytes * softRatio;
  const hard = limitBytes * hardRatio;
  let lastRelief = 0;
  let heapHardStreak = 0;
  let shuttingDown = false;
  // Seeded so /healthz reports a real figure before the first tick lands.
  let last = { rss: process.memoryUsage().rss, heap: heapStats(), at: Date.now() };

  // One relief per minute at most: dropping the cache on every tick while RSS
  // sits just above the soft mark would keep it permanently cold for no gain.
  const RELIEF_COOLDOWN_MS = 60_000;

  const check = () => {
    const { rss } = process.memoryUsage();
    const heap = heapStats();
    last = { rss, heap, at: Date.now() };
    if (shuttingDown) return;

    // Whichever ceiling is nearer decides, and names itself in the log so the
    // remedy is unambiguous: a bigger instance, or a bigger heap.
    const ceiling = heap && heap.used / heap.limit > rss / limitBytes
      ? { what: 'heap', used: heap.used, limit: heap.limit }
      : { what: 'rss', used: rss, limit: limitBytes };
    const ratio = ceiling.used / ceiling.limit;
    if (ratio < hardRatio) heapHardStreak = 0;
    if (ratio < softRatio) return;

    const mb = (n) => Math.round(n / MB);
    const where = `${ceiling.what} ${mb(ceiling.used)}MB of ${mb(ceiling.limit)}MB`;
    const now = Date.now();
    if (ratio < hardRatio) {
      if (now - lastRelief < RELIEF_COOLDOWN_MS) return;
      lastRelief = now;
      // The cache is off-heap, so dropping it relieves rss only; under heap
      // pressure the collection below is the whole of the relief.
      const freed = cacheStorage?.clear?.() ?? 0;
      console.warn(`[mem-guard] ${where} over soft ${Math.round(softRatio * 100)}% — dropped ${mb(freed)}MB of cache`);
      global.gc?.();
      return;
    }

    // A heap reading is a snapshot of uncollected memory, not of live data:
    // old-space routinely touches its ceiling and is then handed most of it
    // back by the next mark-compact. Only recycle once a second sample shows
    // the collector could not, so a normal allocation peak costs a GC pause
    // rather than a restart. RSS gets no such grace — nothing reclaims it on
    // its own, and the headroom above the hard mark is thinner.
    if (ceiling.what === 'heap' && ++heapHardStreak < 2) {
      console.warn(`[mem-guard] ${where} over hard ${Math.round(hardRatio * 100)}% — collecting and resampling`);
      global.gc?.();
      return;
    }

    shuttingDown = true;
    console.error(`[mem-guard] ${where} over hard ${Math.round(hardRatio * 100)}% — recycling before we are killed`);
    Promise.resolve(onShutdown?.('mem-guard')).catch((e) => {
      console.error('[mem-guard] graceful shutdown failed:', e?.stack || e);
      process.exit(1);
    });
  };

  const timer = setInterval(check, intervalMs);
  timer.unref?.();

  return {
    stop() { clearInterval(timer); },
    snapshot() {
      const heapMb = last.heap ? Math.round(last.heap.limit / MB) : null;
      return {
        rss: last.rss,
        rssMb: Math.round(last.rss / MB),
        heapUsedMb: last.heap ? Math.round(last.heap.used / MB) : null,
        heapLimitMb: heapMb,
        heapCapped: heapMb == null ? null : heapMb <= Math.round(limitBytes / MB),
        limitMb: Math.round(limitBytes / MB),
        softMb: Math.round(soft / MB),
        hardMb: Math.round(hard / MB),
        sampledAt: last.at,
      };
    },
  };
}
