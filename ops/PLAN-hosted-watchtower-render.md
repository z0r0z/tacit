# PLAN — Hosted walk-away bid watchtower on Render

> **Status: design + refactor in progress.** Turns the self-hostable
> single-bid daemon (`fulfiller/buyer-watchtower.mjs`,
> `ops/PLAN-walkaway-bid-watchtower.md`) into a managed, multi-tenant service
> we run on Render, so a buyer can post a limit bid, close the tab, and have
> their fills completed for them. The settlement mechanic is unchanged — a
> party online at settlement time verifies delivery (Pedersen opening to the
> buyer's recipient) before releasing the buyer's sats; this plan is about
> *who runs that party and where*.

## Why hosted (not self-host)

The walk-away promise is "post a bid, close everything, it fills while you're
away." A browser tab can't do that — completing a fill requires signing and
broadcasting a settlement at the moment a seller appears. So the completing
party must be an always-on process. Asking every buyer to run a daemon defeats
the UX, so we run one managed instance. The trust stays bounded (below).

## Topology

```
  dapp (browser)              tacit-api (Render web)            tacit-watchtower (Render bg worker)
  ────────────                ─────────────────────            ───────────────────────────────────
  bid + "complete while       POST   /watchtower/bids   ─────▶  REGISTRY_KV (Postgres)  ◀── reads ──┐
  I'm away" toggle:           GET    /watchtower/bids           (watchtower-bid:<net>:<owner>:<id>)  │
   • derive dedicated key      DELETE /watchtower/bids/:id                                           │
   • fund it from main        (auth: Schnorr sig by buyer main key)                                  │
   • encrypt key to                                                                  per active bid: │
     service pubkey                                                                   poll intents → │
   • register  ───────────────────────────────────────────────────────────────────  claim → verify  │
                                                                                      → take (ALL) →  │
  reclaim (one click) ───────▶ DELETE + buyer sweeps dedicated UTXO                   broadcast       │
                                                                                      chain reads ────┘
                                                                                       via tacit-api
                                                                                      heartbeat → /watchtower-health
```

The watchtower is a **separate** Render Background Worker, not part of
`tacit-api`:

- It holds hot keys → must be isolated from the public HTTP surface (separate
  process, separate secret).
- It is an always-on loop, not request/response — a Background Worker, not a
  web service.
- A crash or compromise in it must not take down the API.

It shares the same Postgres as `tacit-api` (`DATABASE_URL`) so it reads the
registration records the API writes, through the same `driver-pg` + KV shim.

## Components

1. **Registration API** (in `worker/src/index.js`, so both CF and Render serve
   it): `POST/GET/DELETE /watchtower/bids`. Writes/reads the registration
   record in `REGISTRY_KV` under a prefix. No consensus change.
2. **`fulfiller/watchtower-core.mjs`** — the per-bid fill engine, extracted
   from the single-bid daemon so the security-critical verify-before-take +
   settle-time policy re-check live in ONE place. Consumed by both the CLI
   daemon and the hosted orchestrator.
3. **`fulfiller/hosted-watchtower.mjs`** — the hosted orchestrator entry
   (co-located in `fulfiller/` with the dapp deps — jsdom/@noble/@scure; the
   pg driver is imported lazily from `server/` only when `DATABASE_URL` is set,
   so local runs use the in-memory driver). Connects to Postgres, jsdom-imports
   `dapp/tacit.js` (reuses the real crypto/tx code), loops over active
   registrations, decrypts each bid key, runs a tick per bid via
   `watchtower-core`, persists per-bid state back to KV, marks a bid `filled`
   at the cap. Exposes `/watchtower-health`.
4. **`fulfiller/watchtower-crypto.mjs`** — client+server helpers: derive the
   dedicated bid key from the buyer's main key (reclaim-safe), and
   encrypt/decrypt it to the service pubkey (ECDH keystream, same primitive the
   dapp already uses for `enc_recipient_blinding`).
5. **dapp UX** — a "complete while I'm away (watchtower)" toggle on the bid
   form: derive key, fund it, register, show running/remaining + a one-click
   reclaim. Default stays the plain online `bid-intent` (manual take).

## Registration record (KV value)

Key: `watchtower-bid:<network>:<owner_h160>:<bid_id>` in `REGISTRY_KV`.

```jsonc
{
  "bid_id": "…",                 // the online bid-intent id this completes
  "asset_id": "…",
  "network": "signet|mainnet",
  "owner_pubkey": "…",           // buyer main pubkey (auth + reclaim destination hint)
  "bid_pubkey": "…",             // dedicated bid-wallet pubkey (h160 derived from it)
  "enc_bid_privkey": "…",        // dedicated key, ECDH-encrypted to the SERVICE pubkey
  "max_unit_price_sats": 220,    // policy ceiling, per whole token
  "max_total_fill_base": "…",    // cumulative cap, base units
  "decimals": 8,
  "expiry": 1730000000,          // hard stop; record auto-expires via KV TTL
  "funding_outpoint": { "txid": "…", "vout": 0 },
  "status": "active|filled|expired|cancelled",
  "filled_base": "0",
  "processed_intents": { }       // settled intent_id -> { txid, amount, at }
}
```

Note: the watchtower does NOT need the buyer's `recipient_blinding`
pre-registered. It holds the dedicated bid key, so it decrypts the seller's
`enc_recipient_blinding` at fulfilment time exactly as `takeAxferIntent` does,
and verifies the Pedersen opening from that.

## Key custody

Bounded, opt-in, self-reclaimable — the same boundary as the self-host daemon,
plus encryption so the cleartext key never crosses the wire or rests in the DB:

- **Derive** the dedicated bid key client-side from the buyer's MAIN key
  (deterministic, like the bridge import-note fix) so the buyer can always
  re-derive it to reclaim, even after a localStorage wipe. The main key is
  never shared.
- **Encrypt** the dedicated key to the watchtower SERVICE pubkey (ECDH
  keystream + the dapp's existing symmetric primitive) before it leaves the
  browser. The API and KV only ever see ciphertext.
- **Decrypt** in-process in the Render worker with the service private key
  (Render secret env `WATCHTOWER_SERVICE_SK`); the cleartext lives only in
  memory while signing a take.
- **Bound:** worst case if the worker is compromised is the one dedicated bid
  UTXO — the amount the buyer chose to commit. The main wallet is untouchable.
- **Reclaim:** the buyer re-derives the dedicated key and sweeps the unspent
  funding at any time (the daemon's `--reclaim` path, surfaced as a dapp
  button). Unfilled = unspent.

Auth: every `POST`/`DELETE` is signed by the buyer's main key over a domain-
tagged message; the API verifies before writing. A hosted instance only ever
acts on bids a buyer explicitly registered.

## The fill loop (unchanged mechanic, now multi-bid)

Per active registration, one tick:

1. Poll `tacit-api` for atomic-intents on `asset_id` that target the bid
   pubkey (the buyer's recipient).
2. Pre-filter by policy (`evalBidPolicy`: unit price ≤ ceiling, cumulative ≤
   cap, not expired).
3. Claim → wait for the seller's fulfilment → re-fetch the settle record →
   **re-apply the policy gate to the record actually being settled**
   (`fulfiller/bid-policy.mjs`) → `takeAxferIntent` (runs `verifyAxferOffer`:
   delivery to our pubkey + Pedersen binding) and broadcast SIGHASH_ALL.
4. Decrement remaining; persist `filled_base` + `processed_intents` to KV.
5. Stop at fill / cap / expiry.

Chain reads route through `tacit-api`'s indexer, not public esplora — a
multi-bid poller would otherwise hit public rate limits (observed in the signet
e2e: a Blockstream `429` mid-run). Centralizing chain access removes that.

## Render service config (dashboard-managed, mirrors tacit-api)

New Background Worker `tacit-watchtower`:

- Start command: `node server/watchtower.mjs`
- `DATABASE_URL` — same Postgres as tacit-api (shared registration store).
- `WATCHTOWER_SERVICE_SK` — service decryption key (secret).
- `WATCHTOWER_API_BASE` — `https://api.tacit.finance` (chain + intent reads).
- `WATCHTOWER_NETWORK`, `WATCHTOWER_TICK_SEC`, `WATCHTOWER_MAX_BID_SATS`
  (per-bid cap for the pilot).
- No public HTTP port except a minimal `/watchtower-health` heartbeat.

`tacit-api` does not git-autodeploy; the watchtower follows the same manual
deploy discipline.

## Build order

0. **DONE** — Signet e2e green for the single-bid take path (live, block 308462:
   buyer posts a bid, walks away, the daemon claims + verifies + settles a
   300-of-1000 **partial fill** SIGHASH_ALL, buyer offline). Surfaced + fixed a
   real discovery bug (the bid is a limit buy over public asks, not a wait for
   targeted fills) and three headless-shim landmines (toast/renderMarket guards
   + a daemon unhandled-rejection safety net).
1. **DONE** — Registration layer: `POST/GET/DELETE /watchtower/bids` in
   `worker/src/index.js` (BIP-340 auth, KV-backed, flag-gated POST). 10/10 tests.
2. **DONE** — `watchtower-crypto.mjs`: bid-key derivation + encrypt/decrypt to
   the service key. 9/9 tests.
3. **DONE** — `watchtower-core.mjs`: per-bid engine extracted; `buyer-watchtower.mjs`
   rewired onto it (dry-run smoke + e2e). 10/10 tests.
4. **DONE** — `fulfiller/hosted-watchtower.mjs`: the orchestrator (KV-backed
   registration read, per-bid tick, KV state, `/watchtower-health`). Boots
   clean; full hosted signet e2e (register → orchestrator fills) is the next
   gate before flipping the flag.
5. **NEXT** — dapp toggle: derive/fund/register/reclaim UX + the dapp↔worker
   auth-message parity test.
6. **NEXT** — deploy: worker (registration endpoints) to Render; `tacit-watchtower`
   Background Worker; **capped pilot** on signet → mainnet (small per-bid cap,
   mirrors the bridge pilot).

## Out of scope / follow-up

- **v2 P2TR take-only custody.** The dedicated UTXO becomes a P2TR with a
  watchtower take-only branch + a buyer CSV-timeout reclaim branch, so the
  hosted key can only co-sign a valid take, never sweep. This is what makes
  holding keys for users fully defensible; the v1 hot-key model ships behind a
  tight per-bid cap until it lands.
- A fully offline, zero-infrastructure buyer bid for a confidential asset
  remains non-constructible on today's Bitcoin (no covenant introspects a
  Pedersen amount). Revisit on CTV/CSFS/APO.
