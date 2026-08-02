// Keeps the API inside its container memory limit.
//
// The platform's only response to an over-limit process is SIGKILL: in-flight
// requests die mid-response, waitUntil writes are lost, and the restart shows
// up as a hard failure rather than a recycle. Everything here exists to reach
// a clean exit before that happens.
//
// Two stages, because the two pools behave differently:
//
//   soft (default 75%) — drop the response cache. Those bodies are Buffers
//     held outside the V8 heap, so they are the largest block of memory that
//     can be returned synchronously, and losing them costs only latency.
//     Also nudges the GC when --expose-gc is on.
//
//   hard (default 90%) — the cache drop didn't hold, so something is growing
//     that we can't reclaim (an unbounded in-memory KV driver, a leak). Ask
//     the process to shut down gracefully: finish in-flight responses, drain
//     background work, exit 0. The platform restarts it as a normal recycle.
//
// RSS is the metric because it is what the cgroup accounts for. Heap-based
// checks miss exactly the Buffer growth that drives these OOMs.
//
// The sample interval has to beat the fastest observed climb, not the average:
// a cron tick here has gone from ~100MB to over 380MB inside 30s, so a slow
// poll can step straight from "fine" to a dead container without ever seeing
// the threshold.

const MB = 1024 * 1024;

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
  let shuttingDown = false;
  // Seeded so /healthz reports a real figure before the first tick lands.
  let last = { rss: process.memoryUsage().rss, at: Date.now() };

  // One relief per minute at most: dropping the cache on every tick while RSS
  // sits just above the soft mark would keep it permanently cold for no gain.
  const RELIEF_COOLDOWN_MS = 60_000;

  const check = () => {
    const { rss } = process.memoryUsage();
    last = { rss, at: Date.now() };
    if (rss < soft || shuttingDown) return;

    const now = Date.now();
    if (rss < hard) {
      if (now - lastRelief < RELIEF_COOLDOWN_MS) return;
      lastRelief = now;
      const freed = cacheStorage?.clear?.() ?? 0;
      console.warn(`[mem-guard] rss ${Math.round(rss / MB)}MB over soft ${Math.round(soft / MB)}MB — dropped ${Math.round(freed / MB)}MB of cache`);
      global.gc?.();
      return;
    }

    shuttingDown = true;
    console.error(`[mem-guard] rss ${Math.round(rss / MB)}MB over hard ${Math.round(hard / MB)}MB of ${Math.round(limitBytes / MB)}MB — recycling before the platform kills us`);
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
      return {
        rss: last.rss,
        rssMb: Math.round(last.rss / MB),
        limitMb: Math.round(limitBytes / MB),
        softMb: Math.round(soft / MB),
        hardMb: Math.round(hard / MB),
        sampledAt: last.at,
      };
    },
  };
}
