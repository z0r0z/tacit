# tacit-verify-service

Standalone HTTP service that runs `snarkjs.zKey.verifyFromR1cs` on a ceremony
contribution. Exists because Cloudflare Workers can't fit the 288 MB pot18
ptau in their 128 MB memory budget, so the chain's "is this contribution a
valid extension of (r1cs, ptau)?" check has to live outside the worker.

When wired up via `VERIFY_SERVICE_URL` in the worker's environment, every
`/contribute` call blocks on a verify result before advancing `state.head_cid`.
If the verify service is unreachable, the worker soft-fails open by default
(set `VERIFY_SERVICE_FAIL_CLOSED=1` to flip).

## Endpoint

```
POST /verify
Authorization: Bearer $VERIFY_SERVICE_TOKEN   (if AUTH_TOKEN env set)
Content-Type: application/json

{ "r1cs_cid": "bafy…", "ptau_cid": "bafy…", "new_cid": "bafy…" }
```

Response: `{ ok: true, ms: 12345 }` or `{ ok: false, error: "...", ms: 12345 }`.

Also exposes `GET /healthz` for the host's liveness probe.

## Hosting

Needs ≥ 1 GB RAM (288 MB ptau + 90 MB swap_batch zkey + node overhead).

- **Render** (basic plan, $25/mo) — `docker build` and deploy from this dir,
  set env vars in the dashboard.
- **Fly.io** (shared 1x with 1 GB volume, ~$3/mo) — `fly launch` from this dir.
- **Any VM with Docker** — `docker build -t verify . && docker run -p 8080:8080
  -e VERIFY_SERVICE_TOKEN=$(head -c 32 /dev/urandom | base64) verify`.

Then set on the worker:

```
wrangler secret put VERIFY_SERVICE_URL    # e.g. https://verify.tacit.finance
wrangler secret put VERIFY_SERVICE_TOKEN  # same value as above
```

When `VERIFY_SERVICE_URL` is unset the worker skips the verify step entirely
(same behaviour as before this service existed) — deploying this code is a
no-op until the env var is configured.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `VERIFY_SERVICE_TOKEN` | (none) | If set, requires `Authorization: Bearer <token>` |
| `MAX_BYTES` | 157 MB | Per-blob cap before refusing to download |
| `FETCH_TIMEOUT_MS` | 60000 | Per-gateway HTTP timeout |
| `IPFS_GATEWAYS` | wrappr,ipfs.io,w3s.link,dweb.link | Comma-separated, tried in order |
