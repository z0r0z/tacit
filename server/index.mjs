// Entry point: the tacit worker on plain Node. Storage comes from
// DATABASE_URL (Postgres) when set, otherwise the in-memory driver — enough
// for local runs against live mempool.space without any local services.
//
//   node server/index.mjs
//
// Env knobs: PORT (default 8787), DATABASE_URL, TRUST_PROXY=1 (behind
// Render's proxy), PROXY_TRUST_KEY (legacy workers.dev proxy handshake),
// CACHE_MAX_MB (defaults to 1/8 of the container memory limit, 16-256 MB),
// CRON_DISABLED=1, MEM_GUARD_DISABLED=1, MEM_SOFT_RATIO / MEM_HARD_RATIO /
// MEM_CHECK_MS (memory guard tuning), plus every var/secret the worker reads
// (wrangler.toml [vars] supply the defaults).

import fs from 'node:fs';
import os from 'node:os';
import { createMemDriver } from './driver-mem.mjs';
import { createCacheStorage } from './cache-mem.mjs';
import { buildEnv, createCtxFactory, createTacitServer, startCron } from './harness.mjs';
import { startMemoryGuard } from './memory-guard.mjs';

// Bytes the container is actually allowed, from the cgroup limit rather than
// os.totalmem() — inside a container the latter reports the host's RAM, which
// on a 512 MB instance overstates the budget by an order of magnitude. cgroup
// v2 writes "max" when unlimited; v1 uses a sentinel near 2^63.
function containerMemoryBytes() {
  for (const p of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(p, 'utf8').trim();
      if (raw === 'max') continue;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n < Number.MAX_SAFE_INTEGER) return n;
    } catch { /* not this cgroup version, or not containerized */ }
  }
  return os.totalmem();
}

// The cache holds response bodies as Buffers, which live outside the V8 heap:
// they count fully against the container's memory limit but barely register as
// heap pressure, so V8 will not collect its way out of an over-budget cache —
// the container is OOM-killed first. Hence a share of the real limit, not a
// fixed default that happened to be half of a 512 MB instance.
const CACHE_SHARE = 0.125;
const CACHE_FLOOR_MB = 16;
const CACHE_CEIL_MB = 256;

const driver = process.env.DATABASE_URL
  ? await (await import('./driver-pg.mjs')).createPgDriver(process.env.DATABASE_URL)
  : createMemDriver();
if (!process.env.DATABASE_URL && process.env.RENDER) {
  console.warn('[tacit-api] DATABASE_URL is unset on a Render instance — running on IN-MEMORY storage; all data is lost on restart');
}

// caches.default must exist before the worker module evaluates.
const cacheMaxMb = Number(process.env.CACHE_MAX_MB) > 0
  ? Number(process.env.CACHE_MAX_MB)
  : Math.min(CACHE_CEIL_MB, Math.max(CACHE_FLOOR_MB,
      Math.floor((containerMemoryBytes() * CACHE_SHARE) / (1024 * 1024))));
const cacheStorage = createCacheStorage({ maxBytes: cacheMaxMb * 1024 * 1024 });
globalThis.caches = cacheStorage;

const workerModule = (await import('../worker/src/index.js')).default;

const env = buildEnv(driver);
const ctxFactory = createCtxFactory();
const server = createTacitServer({ workerModule, env, driver, ctxFactory });
const cron = process.env.CRON_DISABLED === '1'
  ? null
  : startCron({ workerModule, env, driver, ctxFactory });

// Reclaim the cache under pressure and recycle cleanly before the container
// limit is hit — the platform's alternative is SIGKILL mid-request.
const memGuard = process.env.MEM_GUARD_DISABLED === '1' ? null : startMemoryGuard({
  limitBytes: containerMemoryBytes(),
  cacheStorage,
  onShutdown: (reason) => shutdown(reason),
});
server.memGuard = memGuard;

const port = Number(process.env.PORT) || 8787;
server.listen(port, () => {
  // The heap ceiling is logged beside the container limit because it, not the
  // container, is usually what binds: V8 aborts the moment old-space is
  // exhausted, however much of the instance is still free.
  const heapMb = memGuard?.snapshot?.().heapLimitMb;
  console.log(`[tacit-api] listening on :${port} (storage: ${process.env.DATABASE_URL ? 'postgres' : 'memory'}, cron: ${cron ? 'on' : 'off'}, cache: ${cacheMaxMb}MB, heap: ${heapMb ?? '?'}MB of ${Math.floor(containerMemoryBytes() / (1024 * 1024))}MB)`);
});

// Render sends SIGTERM on deploy; finish in-flight responses and drain
// waitUntil work so background KV writes aren't cut mid-flight.
async function shutdown(signal) {
  console.log(`[tacit-api] ${signal}, shutting down`);
  cron?.stop();
  memGuard?.stop();
  server.closeIdleConnections?.();
  const closed = new Promise((resolve) => server.close(resolve));
  const left = await ctxFactory.drainAll(Number(process.env.SHUTDOWN_GRACE_MS) || 10_000);
  if (left > 0) console.warn(`[tacit-api] exiting with ${left} background tasks unsettled`);
  // Give in-flight responses a moment to finish, then cut any stragglers so
  // close() can't hold the process past the deploy window.
  await Promise.race([closed, new Promise((r) => setTimeout(r, 2_000))]);
  server.closeAllConnections?.();
  await driver.close();
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
