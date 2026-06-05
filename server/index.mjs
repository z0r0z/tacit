// Entry point: the tacit worker on plain Node. Storage comes from
// DATABASE_URL (Postgres) when set, otherwise the in-memory driver — enough
// for local runs against live mempool.space without any local services.
//
//   node server/index.mjs
//
// Env knobs: PORT (default 8787), DATABASE_URL, TRUST_PROXY=1 (behind
// Render's proxy), PROXY_TRUST_KEY (legacy workers.dev proxy handshake),
// CACHE_MAX_MB (default 256), CRON_DISABLED=1, plus every var/secret the
// worker reads (wrangler.toml [vars] supply the defaults).

import { createMemDriver } from './driver-mem.mjs';
import { createCacheStorage } from './cache-mem.mjs';
import { buildEnv, createCtxFactory, createTacitServer, startCron } from './harness.mjs';

const driver = process.env.DATABASE_URL
  ? await (await import('./driver-pg.mjs')).createPgDriver(process.env.DATABASE_URL)
  : createMemDriver();

// caches.default must exist before the worker module evaluates.
globalThis.caches = createCacheStorage({
  maxBytes: (Number(process.env.CACHE_MAX_MB) || 256) * 1024 * 1024,
});

const workerModule = (await import('../worker/src/index.js')).default;

const env = buildEnv(driver);
const ctxFactory = createCtxFactory();
const server = createTacitServer({ workerModule, env, driver, ctxFactory });
const cron = process.env.CRON_DISABLED === '1'
  ? null
  : startCron({ workerModule, env, driver, ctxFactory });

const port = Number(process.env.PORT) || 8787;
server.listen(port, () => {
  console.log(`[tacit-api] listening on :${port} (storage: ${process.env.DATABASE_URL ? 'postgres' : 'memory'}, cron: ${cron ? 'on' : 'off'})`);
});

// Render sends SIGTERM on deploy; finish in-flight responses and drain
// waitUntil work so background KV writes aren't cut mid-flight.
async function shutdown(signal) {
  console.log(`[tacit-api] ${signal}, shutting down`);
  cron?.stop();
  server.close();
  const left = await ctxFactory.drainAll(Number(process.env.SHUTDOWN_GRACE_MS) || 10_000);
  if (left > 0) console.warn(`[tacit-api] exiting with ${left} background tasks unsettled`);
  await driver.close();
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
