# tacit-verify-service

Standalone HTTP service that runs `snarkjs.zKey.verifyFromR1cs` on a ceremony
contribution: is this zkey a valid extension of (r1cs, ptau)? It runs outside
the API because the check holds the 288 MB pot18 ptau plus the zkey in memory,
and takes up to several minutes for the heaviest circuit.

## How the API uses it

When `VERIFY_SERVICE_URL` is set, the API's scheduled tick
(`runCeremonyHeadVerifyPass` in `worker/src/index.js`) asks this service
whether each ceremony's new head extends the last verified head. On `ok` it
advances the verified marker; on a structural failure it rolls the head back to
the verified marker so the next contributor extends a known-good head. Requests
use `{async: true}`, so the first tick starts the verify and later ticks read
the cached result. `/contribute` never waits on it. With `VERIFY_SERVICE_URL`
unset the sweep is skipped.

Trust role: the service holds no keys. Every contribution stays independently
verifiable from its pinned r1cs, ptau and zkey CIDs; this service only automates
that check for the API.

## Endpoint

```
POST /verify
Authorization: Bearer $VERIFY_SERVICE_TOKEN   (if VERIFY_SERVICE_TOKEN is set)
Content-Type: application/json

{ "r1cs_cid": "bafy…", "ptau_cid": "bafy…", "new_cid": "bafy…", "async": true }
```

Response: `{ ok: true, ms }`, `{ ok: false, error, ms }`, or `{ pending: true }`
while an async verify runs. Verifies run one at a time. `GET /healthz` is the
liveness probe.

## Hosting

Needs at least 1 GB RAM (288 MB ptau + zkey + Node overhead). The repo's root
`render.yaml` deploys it as `tacit-verify` (Docker, this directory) and
generates `VERIFY_SERVICE_TOKEN`. Any Docker host works:

```sh
docker build -t verify . && docker run -p 8080:8080 \
  -e VERIFY_SERVICE_TOKEN=$(head -c 32 /dev/urandom | base64) verify
```

Then set `VERIFY_SERVICE_URL` and `VERIFY_SERVICE_TOKEN` (same value) in the
API's environment.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `VERIFY_SERVICE_TOKEN` | (none) | If set, requires `Authorization: Bearer <token>` |
| `MAX_BYTES` | 500 MB | Per-blob cap before refusing to download |
| `FETCH_TIMEOUT_MS` | 180000 | Per-gateway HTTP timeout |
| `IPFS_GATEWAYS` | wrappr, ipfs.io, w3s.link, dweb.link | Comma-separated, tried in order |
