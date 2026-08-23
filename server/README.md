# tacit-api — the worker on plain Node

Runs `worker/src/index.js` unmodified outside Cloudflare. Three shims supply
the platform pieces the worker expects:

| Cloudflare | Here |
|---|---|
| `env.REGISTRY_KV` / `env.UPLOAD_KV` | `kv-store.mjs` over `driver-pg.mjs` (production, `DATABASE_URL`) or `driver-mem.mjs` (local/tests) |
| `caches.default` | `cache-mem.mjs` — in-process LRU; SWR `X-Cached-At` headers pass through untouched |
| `ctx.waitUntil` / cron triggers | `harness.mjs` — tracked floating promises + a wall-clock-aligned 5-minute tick calling the worker's `scheduled()` |

## Run

```sh
node server/index.mjs                      # memory storage, cron on, :8787
DATABASE_URL=postgres://… node server/index.mjs
CRON_DISABLED=1 node server/index.mjs      # serve only, no chain scanning
```

Config defaults come from `worker/wrangler.toml` `[vars]`; any real env var
overrides them. Secrets (`PINATA_JWT`, `FAUCET_PRIV`, `VERIFY_SERVICE_TOKEN`,
`DISCORD_*`, …) come from env, same names as the Cloudflare secrets.

Behind Render set `TRUST_PROXY=1` so client IPs derive from
`X-Forwarded-For`; inbound `CF-Connecting-IP` is always stripped and
re-derived (`harness.mjs` `clientIpFrom`). The legacy workers.dev
pass-through proxy authenticates its forwarded client IP with
`PROXY_TRUST_KEY`.

Memory: two ceilings bind, and `/healthz` reports both under `mem`. The
container limit is read from the cgroup and governs the response cache
(`CACHE_MAX_MB`, else 1/8 of the limit). V8's old-space ceiling is separate
and defaults to roughly half the instance — on a 512MB plan that is ~227MB,
so the heap is exhausted, and the process fatally aborts, while more than
half the instance is still free. Start the service with
`--max-old-space-size` (the `start` script passes 320 for a 512MB plan; a
`NODE_OPTIONS` env var does the same if the start command bypasses npm) and
keep `heapLimitMb` well above the working set. `memory-guard.mjs` watches
whichever ceiling is nearer, dropping the cache at 75% and recycling
gracefully at 90%; knobs are `MEM_GUARD_DISABLED=1`, `MEM_SOFT_RATIO`,
`MEM_HARD_RATIO`, `MEM_CHECK_MS`.

Health: `/healthz` (storage probe, harness-level) and the worker's own
`/health`.

Tests: `node tests/server-kv-shim.test.mjs` (set `TEST_DATABASE_URL` to also
run the conformance suite against Postgres) and
`node tests/server-harness.test.mjs`.
