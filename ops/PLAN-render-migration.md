# PLAN — API/indexer on Render

Move the dapp's API origin and the chain indexer from Cloudflare Workers to a
Node service on Render, consolidating hosting next to `tacit-verify`. The
worker codebase (`worker/src/index.js`) is unchanged and stays deployable to
Cloudflare — the Node runtime in `server/` is an additional way to run it,
not a fork.

## Topology

| | today | target |
|---|---|---|
| dapp static | tacit.finance (Render) | unchanged |
| API + indexer | `tacit-pin.rosscampbell9.workers.dev` (CF Workers + KV + cron) | `api.tacit.finance` → `tacit-api` (Render Node + Postgres) |
| proof verification | `tacit-verify` (Render docker) | unchanged |
| legacy API origin | — | workers.dev worker demoted to a pass-through proxy (kept indefinitely for clients on cached bundles) |

## What `server/` provides

- `harness.mjs` — node:http ⇄ Web Request/Response bridge; `env` built from
  `wrangler.toml [vars]` defaults + real env; `ctx.waitUntil` as tracked
  floating promises (drained on SIGTERM so deploys don't cut background KV
  writes); wall-clock-aligned 5-minute cron calling the worker's
  `scheduled()`, with a manual `tick()` for unsticking; client IP derived
  from `X-Forwarded-For` (`TRUST_PROXY=1`) with inbound `CF-Connecting-IP`
  always stripped.
- `kv-store.mjs` + `driver-pg.mjs` / `driver-mem.mjs` — Cloudflare-KV-shaped
  namespaces over one Postgres table (`COLLATE "C"` so list order matches
  KV's byte-lex contract) or memory for tests/local.
- `cache-mem.mjs` — `caches.default` as an in-process LRU; the worker's SWR
  `X-Cached-At` convention passes through untouched.
- Conformance tests: `tests/server-kv-shim.test.mjs` (run against both
  drivers; set `TEST_DATABASE_URL` for Postgres),
  `tests/server-harness.test.mjs` (boots the real worker over HTTP).
- Snapshot tooling: `scripts/kv-export-wrangler.mjs` (Cloudflare → NDJSON via
  the local wrangler OAuth login, bulk-paced, resumable; `--refetch-prefixes`
  is the delta-sync knob for mutable state) with `scripts/kv-export.mjs` as
  the API-token variant, and `scripts/kv-import.mjs` (NDJSON → Postgres,
  upsert — rerun with a fresh export as the delta sync).
- Shadow comparator: `scripts/api-shadow-diff.mjs` replays the read
  endpoints (incl. POST `/asset-book` across all sections) against two
  origins and reports structural diffs, volatile fields normalized.

## Render setup (when ready — not yet in render.yaml)

```yaml
  - type: web
    name: tacit-api
    runtime: node
    rootDir: server
    buildCommand: npm install && npm install --prefix ../worker
    startCommand: node index.mjs
    plan: starter            # I/O-bound; bump to standard if CPU shows hot
    healthCheckPath: /healthz
    autoDeploy: true
    envVars:
      - key: TRUST_PROXY
        value: "1"
      - key: DATABASE_URL
        fromDatabase:
          name: tacit-kv
          property: connectionString

databases:
  - name: tacit-kv
    plan: basic-256mb
```

Secrets to set on the service (same names as the Cloudflare secrets):
`PINATA_JWT`, `FAUCET_PRIV`, `VERIFY_SERVICE_URL`, `VERIFY_SERVICE_TOKEN`,
`CEREMONY_INIT_TOKEN`, `DEBUG_TOKEN`, `PROVER_HEARTBEAT_TOKEN`,
`DISCORD_BOT_TOKEN`, `DISCORD_BOT_SECRET`, `DISCORD_PUBLIC_KEY`,
`DISCORD_APPLICATION_ID`, `TAC_ROLE_ID`, plus `PROXY_TRUST_KEY` (shared with
the legacy proxy, below). Non-secret tuning vars inherit from
`wrangler.toml [vars]` automatically; override per-var in Render as needed.

Custom domain: `api.tacit.finance` CNAME at the registrar → the Render
service, so the API origin is never platform-coupled again.

## Cutover sequence

Rollback before step 5 is "do nothing" — production stays on Cloudflare
untouched while everything is rehearsed.

1. Provision `tacit-api` + `tacit-kv`; run the KV-shim conformance suite
   against the Render Postgres (`TEST_DATABASE_URL`, external URL).
2. `kv-export.mjs` → `kv-import.mjs` full snapshot.
3. Shadow bake with `CRON_DISABLED=1`: diff `tacit-api` against workers.dev
   on the read endpoints (`/health`, `/assets`, `/asset-book`, `/market`,
   `/petch-assets`, asset detail) for both networks over several days.
4. Rehearse the indexer: enable cron on a scratch database, `/rescan` from a
   recent height, confirm scan progress and quiet logs.
5. Flip: final export→import delta sync, then deploy the proxy build of the
   Cloudflare worker (below) and disable its cron trigger. From this moment
   the Render service is the single writer; old clients are unaffected. The
   freeze window is the minutes between delta sync and proxy deploy.

   Delta recipe: ~97% of REGISTRY_KV is append-only history (`pmint:` 229k,
   `ceremony:` 200k — both ceremonies finalized; `xferseen:`,
   `trade-event:`). A delta run is: fresh `kv key list --remote`, then
   `kv-export-wrangler.mjs` with the previous NDJSON as resume base —
   fetches new keys of any prefix automatically — plus
   `--refetch-prefixes` covering the mutable tail (everything except the
   four append-only families; ~10k keys, minutes). Upstream deletions
   (fulfilled claims, spent listings) don't propagate through an upsert
   import; the cron's existing phantom sweeps clear them after cutover. If
   an orphan promotion rewrites a `pmint:` record inside the gap window,
   the every-6th-tick counter reconciliation self-heals it.
6. Dapp release: `WORKER_BASE` (dapp/tacit.js) → `https://api.tacit.finance`,
   CSP connect-src updated, `tacit-api` added to `ALLOWED_ORIGINS` if the
   origin list changes. New clients now bypass Cloudflare entirely.
7. Watch `/healthz`, scan progress (`meta:last_scanned`), and mempool.space
   429s for a week before relaxing any scan caps.

## Legacy workers.dev fallback

The classic endpoint stays up indefinitely as a pass-through. The build
lives at `worker/proxy/` (same worker name, so deploying it replaces
tacit-pin in place — cutover step 5 only). It needs no KV, no cron, and ~1ms
CPU per request — comfortably inside the Workers free plan (100k
requests/day); traffic on it only decays after step 6. Its config keeps
`workers_dev = true` (routes deploys silently drop it otherwise — see the
note in worker/wrangler.toml) and `crons = []` to remove the trigger.

The proxy's two `x-tacit-*` headers carry the real client IP through to the
origin's rate-limit buckets; the harness honors them only when the key
matches `PROXY_TRUST_KEY` and strips them from every other caller.

## Running your own indexer

Both runtimes stay first-class, from the same `worker/src/index.js`:

- **Cloudflare (free tier):** `cd worker`, create two KV namespaces
  (`wrangler kv namespace create REGISTRY_KV` / `UPLOAD_KV`), put their ids
  in `wrangler.toml`, `wrangler deploy`, then `/rescan` to build state from
  chain. The Analytics Engine binding is optional (the code no-ops without
  it). Heavy reuse may need the paid plan's CPU budget.
- **Anywhere Node runs:** `node server/index.mjs` with `DATABASE_URL` (or
  the memory driver for ephemeral use).

Point any dapp build at an alternative indexer via
`globalThis.__TACIT_WORKER_BASE__` or `TACIT_WORKER_BASE`. Chain-derived
state (assets, mints, supply) rebuilds from a rescan; user-submitted records
(openings, listings, intents) live with whichever indexer received them.

The KV-shim conformance suite is the compatibility contract between the two
runtimes — a change that breaks either path fails the same test.

## Risks

- **Single egress IP.** mempool.space sees all scans from one Render IP
  where Workers spread them. Keep the existing per-tick scan caps and mirror
  rotation; relax only against observed 429 rates. Self-hosted
  electrs/mempool is the eventual fix and becomes possible on this
  architecture.
- **Deploy restarts** cut in-flight background work — the same failure mode
  as the platform being left, and the handlers are already written
  idempotent for it. SIGTERM draining narrows the window.
- **Snapshot completeness.** Export is resumable and the import upserts;
  step 5's delta sync bounds loss to the freeze window. Counter drift heals
  via the cron's existing reconciliation pass.

## Later (not this migration)

- Relax `SCAN_BLOCKS_MAINNET` / maxOps budgets once 429 behavior is known.
- Serve the brotli-q11 dapp bundle from `tacit-api` (the `handleDappBundle`
  path and KV artifact port as-is; no Cloudflare zone needed).
- Real response headers for the dapp host (today's `dapp/_headers` is inert).
- Self-hosted electrs to retire the mempool.space dependency.

## Kubo pin node (rides along, independent of cutover)

A first-party IPFS node holding everything `ops/mirror-pins.sh` tracks: a
self-hosted replica next to Pinata (origin pins) and the Filebase bucket
(CAR mirror), plus a gateway we control end to end.

```yaml
  - type: web
    name: tacit-ipfs
    runtime: image
    image:
      url: docker.io/ipfs/kubo:latest
    plan: starter
    healthCheckPath: /api/v0/version
    disk:
      name: ipfs-repo
      mountPath: /data/ipfs
      sizeGB: 10
    envVars:
      - key: IPFS_PROFILE
        value: server        # disables local-network discovery on the host
```

Seed + maintenance, from any machine with the canonical manifest:

```sh
ipfs --api /dns4/<render-host>/tcp/5001 pin add <cid>   # per manifest line
```

or run `mirror-pins.sh` against the node's S3-free path by pointing
`IPFS_API` at it (pin add + dag export happen node-side). Notes:

- expose the gateway (8080) via the service URL; the API (5001) must NOT be
  public — bind it to localhost and seed pins via `render ssh`, or front it
  with an auth proxy. Kubo's API has no auth of its own.
- 10 GB disk covers today's ~1 GB pinset with room for asset growth; the
  repo persists across deploys on the mounted disk.
- once live, add the gateway URL to the dapp/worker fallback lists (same
  slot pattern as `ipfs.filebase.io`).
- `Reprovider.Strategy=pinned` keeps DHT announce load proportional to the
  pinset.
