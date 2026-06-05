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

Health: `/healthz` (storage probe, harness-level) and the worker's own
`/health`.

Tests: `node tests/server-kv-shim.test.mjs` (set `TEST_DATABASE_URL` to also
run the conformance suite against Postgres) and
`node tests/server-harness.test.mjs`.
