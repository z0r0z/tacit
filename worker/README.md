# tacit-pin

Cloudflare Worker that proxies image uploads from `tacit.html` to Pinata.
Holds the Pinata JWT as a Cloudflare secret so the dApp never sees it.

## One-time setup

```sh
# 1. Wrangler (Cloudflare's CLI). Skip if already installed.
npm install -g wrangler

# 2. Auth — opens a browser, logs into your Cloudflare account.
wrangler login

# 3. KV namespace for per-IP rate limiting.
cd worker
wrangler kv namespace create UPLOAD_KV
# Output looks like:
#   [[kv_namespaces]]
#   binding = "UPLOAD_KV"
#   id = "abc123def456..."
# Copy the id into wrangler.toml (replace REPLACE_WITH_KV_ID_FROM_WRANGLER_OUTPUT).

# 4. Pinata JWT goes in as a secret. The CLI will prompt you to paste it.
#    Get the JWT from Pinata dashboard → API Keys → New Key (or existing key
#    with pinFileToIPFS scope). Pinata gives you a long base64 JWT string —
#    that's what you paste, NOT the 20-char public key half.
wrangler secret put PINATA_JWT

# 5. Deploy.
wrangler deploy
# Output prints the URL, e.g.
#   https://tacit-pin.YOUR_SUBDOMAIN.workers.dev
```

Send that URL back into the chat and the dApp gets patched to point at it.

## Tightening (optional, after the demo)

- Set `ALLOWED_ORIGINS` in `wrangler.toml` to your dApp's actual origin (e.g.
  `"https://tacit.example.com"`) to lock down CORS.
- Lower `DAILY_LIMIT` if Pinata quota is tight.
- Rotate the JWT periodically: `wrangler secret put PINATA_JWT` overwrites.

## Local test

```sh
wrangler dev
# In another shell:
curl -X POST http://localhost:8787/pin \
  -F file=@/path/to/icon.png
# Expect: { "cid": "bafy...", "size": NNN }
```

## Trust model: the worker is a convenience, not a trust dependency

Every endpoint this worker exposes is either:
- a **dumb cache** in front of public chain data (`/assets`, `/openings`,
  `/disclosures`, `/listings`), or
- a **dumb pass-through** to a third party (`/pin`, `/pin-json` → Pinata), or
- a **dumb message bus** (`/airdrops/:root/claims` — recipients submit
  signed tuples, issuers pull them in batches).

A faulty or hostile worker can withhold data or accept gibberish, but it
cannot forge cryptographic state: every consumer (the dApp, the issuer's
Drops tab, the Claim tab) re-verifies signatures, range proofs, and merkle
inclusion against the chain before trusting any worker output.

Setting `WORKER_BASE = ''` in the dApp disables every worker call and the
protocol still functions — fulfilment becomes manual (paste tuples instead
of pull, manual IPFS pinning, etc).

## Running your own private worker for an airdrop campaign

If you don't trust a third-party operator (or just want to control your own
infrastructure for a campaign), the whole thing is ~3000 lines and deploys
to your own Cloudflare account in minutes:

1. Fork or clone this repo's `worker/` directory.
2. Run the One-time setup above against your own Cloudflare account.
3. (Optional) Lock CORS to your dApp's origin via `ALLOWED_ORIGINS` in
   `wrangler.toml` so only your dApp can write to the queue.
4. In the dApp source (or a hosted fork), set `WORKER_BASE` to your worker's
   URL.
5. Recipients clicking your airdrop's claim link load your dApp build,
   which talks only to your worker. The worker URL is visible in the
   browser's network tab; recipients can audit which infrastructure their
   claim passes through.

You can also point a single dApp build at multiple workers (e.g., one per
campaign) by deploying separate dApp instances with different `WORKER_BASE`
values. The protocol layer is unchanged.

## Airdrop claim queue endpoints

Added in the airdrop tooling iteration. Pure dropbox — no signature
verification on the worker side.

```
POST   /airdrops/:root/claims?network=signet|mainnet
       body: { leaf_index: int, tacit_pubkey: 33-byte hex, eth_sig: 65-byte hex }
       Re-submission for the same (root, leaf_index) overwrites.

GET    /airdrops/:root/claims?network=signet|mainnet
       returns: { root, network, count, claims: [...] }
       (issuer pulls; sorted by leaf_index ascending)

DELETE /airdrops/:root/claims/:leaf_index?network=signet|mainnet
       (issuer fires after a successful broadcast to clean the queue)
```

KV layout: `airdrop:claim:[<network>:]<root>:<padded_leaf_index>`.
