#!/usr/bin/env bash
# Pin pot18_final.ptau directly to Pinata (bypassing the tacit worker).
#
# Why: the worker's /pin endpoint and /ceremony/init endpoint are both
# behind Cloudflare's 100 MB request body cap, and the worker itself
# enforces a 32 MB per-file limit on /ceremony/init. pot18 is ~288 MB,
# so the only path to get it into IPFS is a direct Pinata multipart
# upload. After this script returns a CID, /ceremony/init can accept
# `ptau_cid=<this CID>` instead of a `ptau` file.
#
# Runtime: ~3–8 min depending on upstream bandwidth. Pinata charges this
# upload against your account quota (288 MB).
#
# Usage:
#   bash /Users/z/tacit/dapp/circuits/pin-pot18.sh
#   PINATA_JWT=... bash /Users/z/tacit/dapp/circuits/pin-pot18.sh   # JWT from env
#
# Output: the CID, also written to ceremony-genesis-amm/pot18_cid.txt
# so amm-ceremony-init.sh can pick it up automatically.

set -euo pipefail

CIRCUITS_DIR="/Users/z/tacit/dapp/circuits"
PTAU_FILE="${CIRCUITS_DIR}/pot18_final.ptau"
CID_FILE="${CIRCUITS_DIR}/ceremony-genesis-amm/pot18_cid.txt"

if [ ! -f "$PTAU_FILE" ]; then
    echo "MISSING: $PTAU_FILE" >&2
    echo "Fetch pot18 first (see ops/runbooks/AMM-CEREMONY-RUNBOOK.md Step 1)." >&2
    exit 1
fi

# Skip re-upload if we've already pinned this exact ptau in a prior run.
# Pinata is idempotent on content hash but re-uploading wastes bandwidth.
if [ -f "$CID_FILE" ]; then
    EXISTING_CID="$(tr -d '[:space:]' < "$CID_FILE")"
    if [ -n "$EXISTING_CID" ]; then
        echo "==> pot18 already pinned in a prior run."
        echo "    CID: $EXISTING_CID"
        echo "    (delete $CID_FILE to force a fresh pin)"
        exit 0
    fi
fi

# Cross-check BLAKE2b against runbook pin before paying 288 MB of upload.
# A corrupt ptau here would propagate to every contributor's verify step.
EXPECTED_BLAKE2B="7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e"
echo "==> Computing BLAKE2b-512 of $PTAU_FILE (~30s)…"
ACTUAL_BLAKE2B="$(openssl dgst -blake2b512 "$PTAU_FILE" 2>/dev/null | sed 's/.*= //')"
if [ "$ACTUAL_BLAKE2B" != "$EXPECTED_BLAKE2B" ]; then
    echo "✗ BLAKE2b mismatch — refusing to upload a non-canonical pot18." >&2
    echo "  expected: $EXPECTED_BLAKE2B" >&2
    echo "  actual:   $ACTUAL_BLAKE2B" >&2
    exit 1
fi
echo "    BLAKE2b matches the runbook pin."

# JWT (silent read or env).
if [ -z "${PINATA_JWT:-}" ]; then
    printf "Paste PINATA_JWT (silent, won't echo): "
    IFS= read -rs PINATA_JWT || true
    printf "\n"
fi
if [ -z "${PINATA_JWT:-}" ]; then
    echo "no JWT provided" >&2; exit 1
fi
PINATA_JWT="$(printf '%s' "$PINATA_JWT" | xargs)"
if ! [[ "$PINATA_JWT" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]; then
    echo "✗ JWT doesn't look right (expected: 3 dot-separated base64url segments)" >&2
    exit 1
fi
export -n PINATA_JWT 2>/dev/null || true

CURL_CONFIG="$(mktemp -t tacit-pinata-pot18-XXXXXX)"
RESP_FILE="$(mktemp -t tacit-pinata-pot18-resp-XXXXXX)"
chmod 600 "$CURL_CONFIG"
trap 'rm -f "$CURL_CONFIG" "$RESP_FILE"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$PINATA_JWT" > "$CURL_CONFIG"
PINATA_JWT=""; unset PINATA_JWT

echo
echo "==> Uploading pot18 (~288 MB) to Pinata. This typically takes 3–8 minutes."
SIZE_BYTES="$(stat -f%z "$PTAU_FILE" 2>/dev/null || stat -c%s "$PTAU_FILE")"
echo "    file size: ${SIZE_BYTES} bytes"
echo

# CIDv1 (base32 multihash) — matches the rest of tacit's CIDs.
HTTP_CODE="$(curl --progress-bar --max-time 1800 --config "$CURL_CONFIG" \
    -o "$RESP_FILE" -w '\n%{http_code}\n' \
    -X POST https://api.pinata.cloud/pinning/pinFileToIPFS \
    -F "file=@${PTAU_FILE};filename=pot18_final.ptau" \
    -F 'pinataOptions={"cidVersion":1}' \
    -F "pinataMetadata={\"name\":\"tacit-amm-pot18-$(date -u +%Y%m%dT%H%M%SZ)\"}" \
    | tail -1)" || HTTP_CODE="000"

if [ "$HTTP_CODE" != "200" ]; then
    echo "✗ Pinata returned HTTP $HTTP_CODE" >&2
    echo "  Response (first 500 bytes):" >&2
    head -c 500 "$RESP_FILE" >&2; echo >&2
    exit 1
fi

CID="$(python3 -c "import sys,json; print(json.load(open(sys.argv[1])).get('IpfsHash',''))" "$RESP_FILE")"
if [ -z "$CID" ]; then
    echo "✗ Pinata returned 200 but no IpfsHash field:" >&2
    head -c 500 "$RESP_FILE" >&2; echo >&2
    exit 1
fi

mkdir -p "$(dirname "$CID_FILE")"
echo -n "$CID" > "$CID_FILE"

echo
echo "================================================================"
echo "  ✓ pot18 pinned to IPFS"
echo "================================================================"
echo
echo "  CID:        $CID"
echo "  Saved to:   $CID_FILE"
echo
echo "  Verify:"
echo "    curl -I https://gateway.pinata.cloud/ipfs/$CID"
echo
echo "  Next: bash $CIRCUITS_DIR/amm-ceremony-init.sh"
echo
