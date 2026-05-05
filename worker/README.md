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
