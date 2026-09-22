# Tacit API worker

`src/index.js` is the Tacit API: the Bitcoin-side indexer and the off-chain services the dapp
calls. In production it runs as `tacit-api` on Render at `https://api.tacit.finance`, on plain
Node through the shims in `../server/` (Postgres-backed KV, in-process cache, a 5-minute cron tick).
The same file also deploys unchanged as a Cloudflare Worker with `wrangler.toml`, so anyone can run
their own indexer.

## What it serves

- **Bitcoin indexer**: a cron scan of signet and mainnet for Tacit envelopes (SPEC §3), feeding
  `/assets`, `/petch-assets`, `/market`, `/asset-book`, `/holdings`, AMM pools, farms, drops,
  wrapper attestations and cBTC.zk slot logs. `/assets/hint` lets a client index its own fresh
  broadcast before the cron sees it.
- **Orderbook and claim mailboxes**: listings, atomic intents, preauth bids and sales, the airdrop
  claim queue and drop announcements, and watchtower bid registration.
- **Confidential settle queue**: `/confidential/submit`, `/status` and `/quote` for the dapp;
  `/confidential/job` and `/ack` for the relayer (`../worker-relay/`).
- **Reflection**: assembles the next Bitcoin-state batch for the reflection relayer
  (`/reflection/job`, `/ack`), stores eth-state candidates and burn bundles, and publishes the
  reflected state (`/reflection/dump`, `/status`, `/note-witness`).
- **Proxies and utilities**: `/chain/*` (Esplora reads), `/ipfs/*` (gateway race), `/pin*` (IPFS
  pinning with the operator's key), ceremony coordination, off-chain governance, `/farm/program`,
  `/prover-health`, the signet faucet (`/drip`) and the Discord holder gate.

## Trust role

The worker is a convenience, not a trust dependency. Every endpoint is a cache of public chain
data, a pass-through to a third party, or a mailbox for signed messages. It can withhold data or
serve stale data, but it cannot forge state: the dapp and the other tools re-verify signatures,
range proofs, openings and Merkle inclusion against the chain, and the confidential pool verifies
every proof on-chain. Reflection and settle routes only hand out work; the relayer that proves it
can decline a job but cannot change what the proof commits to.

Setting `WORKER_BASE = ''` in the dapp disables every worker call; the protocol still works, with
manual steps in place of the mailboxes.

## Run

On Node (production and local), see `../server/README.md`:

```sh
node server/index.mjs                        # in-memory storage, :8787
DATABASE_URL=postgres://… node server/index.mjs
```

On Cloudflare:

```sh
cd worker
npx wrangler kv namespace create UPLOAD_KV      # and REGISTRY_KV; put the ids in wrangler.toml
npx wrangler secret put PINATA_JWT              # plus any other secrets you use
npx wrangler deploy
```

`wrangler.toml` `[vars]` holds the non-secret defaults (CORS allowlist, rate limits, API
sources); the Node server reads the same file for its defaults. `ALLOWED_ORIGINS` gates every route
except the permissionless ones in `OPEN_ORIGIN_PATHS`.

`proxy/` is a separate pass-through worker deployed at the `tacit-pin` workers.dev URL, which older
dapp builds still call; it forwards every request to `api.tacit.finance`.

## Airdrop claim queue

A mailbox: the worker stores claims without verifying them, and the issuer's fulfiller re-verifies
each one before paying.

```
POST   /airdrops/:root/claims?network=signet|mainnet
       body: { leaf_index, tacit_pubkey (33-byte hex), eth_sig (65-byte hex), funding_txids? }
       Re-submission for the same (root, leaf_index) overwrites.

GET    /airdrops/:root/claims?network=signet|mainnet
       returns: { root, network, count, claims: [...] } sorted by leaf_index

DELETE /airdrops/:root/claims/:leaf_index?network=signet|mainnet
       signed by the drop announcement's issuer_pubkey, with a fresh timestamp
```

KV layout: `airdrop:claim:[<network>:]<root>:<padded_leaf_index>` (signet keys carry no network
segment).
