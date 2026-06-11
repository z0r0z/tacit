# RUNBOOK — Hosted walk-away bid watchtower

Operational steps to run the managed watchtower that completes buyers' resting
limit bids while they're away. Design + trust boundary:
[ops/PLAN-hosted-watchtower-render.md](PLAN-hosted-watchtower-render.md).

## Pieces

- **Registration API** — `POST/GET/DELETE /watchtower/bids` in `worker/src/index.js`,
  served by `tacit-api`. POST is gated by `WATCHTOWER_REGISTER_ENABLED=true`.
- **Orchestrator** — `fulfiller/hosted-watchtower.mjs`, a long-running Node
  process (Render Background Worker `tacit-watchtower`). Reads registrations from
  the shared Postgres KV, decrypts each bid key, completes matching asks.
- **Single-bid CLI** — `fulfiller/buyer-watchtower.mjs`, for self-hosting one bid
  (`npm run watchtower -- --config ./watchtower-config.json`).

## One-time setup

1. **Service keypair.** Generate the watchtower's long-term key (used to decrypt
   the bid keys buyers encrypt to it):

   ```
   node -e "const c=require('crypto');const sk=c.randomBytes(32).toString('hex');console.log('WATCHTOWER_SERVICE_SK='+sk)"
   ```

   Put `WATCHTOWER_SERVICE_SK` in the Render service secret. Derive the public
   key to publish in the dapp config (buyers encrypt to it):

   ```
   node -e "import('./fulfiller/watchtower-crypto.mjs').then(m=>console.log(m.servicePubFromSk(process.env.WATCHTOWER_SERVICE_SK)))"
   ```

2. **Orchestrator service (`tacit-watchtower`).** Render Background Worker,
   separate from `tacit-api` (it holds hot keys — keep it off the public HTTP
   surface). Dashboard-managed, manual deploy, mirroring `tacit-api`.

   - Start command: `node fulfiller/hosted-watchtower.mjs`
   - Env:
     - `WATCHTOWER_SERVICE_SK` — secret (above)
     - `DATABASE_URL` — the SAME Postgres as `tacit-api` (shared registration store)
     - `WATCHTOWER_API_BASE` — `https://api.tacit.finance`
     - `WATCHTOWER_NETWORK` — `signet` | `mainnet`
     - `WATCHTOWER_TICK_SEC` — poll interval (default 60)
     - `WATCHTOWER_CLAIM_TIMEOUT_SEC` — wait for a seller to fulfil after claim (default 360)
     - `WATCHTOWER_MIN_BID_SATS` — idle a bid wallet below this (default 1000)
     - `WATCHTOWER_MAX_BID_PRICE_SATS` — pilot per-bid cap; `0` disables. Set this
       small for the initial pilot (mirrors the bridge's capped-deposit pilot).
     - `PORT` — health endpoint port
   - Health: `GET /watchtower-health` → `{ ok, active_bids, last_cycle_at, service_pub }`

3. **Publish the service pubkey in the dapp** so the register flow can encrypt
   bid keys to it.

## Go-live

1. Deploy `tacit-api` with the registration endpoints (manual deploy — `tacit-api`
   does not git-autodeploy).
2. Set `WATCHTOWER_REGISTER_ENABLED=true` on `tacit-api` and redeploy. (Until then
   POST returns 410; GET/DELETE stay open so registrations can always be read /
   cancelled.)
3. Deploy `tacit-watchtower` with the env above and a small
   `WATCHTOWER_MAX_BID_PRICE_SATS` pilot cap.
4. Watch `/watchtower-health` `active_bids` and the orchestrator logs (one JSON
   line per cycle / fill).

## Pause / rollback

- **Stop accepting new bids:** set `WATCHTOWER_REGISTER_ENABLED=false` on
  `tacit-api` and redeploy (POST → 410). Existing registrations still complete.
- **Stop completing fills:** stop the `tacit-watchtower` service. Registered bids
  simply rest unfilled (the funding is unspent); buyers can reclaim any time.
- **Reclaim is always available to the buyer** — the dedicated key is derived from
  their main key, so a buyer can sweep an unspent bid wallet without the
  watchtower (dapp reclaim button, or the CLI `--reclaim <addr>`).

## Trust boundary (operator-facing)

The orchestrator holds only the dedicated bid keys, each bounded to the funding
the buyer chose to commit and self-reclaimable; the main wallet is never shared.
Keys rest as ciphertext (encrypted to `WATCHTOWER_SERVICE_SK`) and are decrypted
only in-process. The take is verify-before-relay and SIGHASH_ALL — it settles
only an ask that delivers the agreed amount to the buyer at ≤ the bid price, and
the signature is bound to that one settlement.
