#!/usr/bin/env bash
# Pin the amm_swap_batch genesis zkey + r1cs directly to Pinata.
#
# Why: amm_swap_batch's r1cs is ~34 MB and its genesis zkey is ~91 MB.
# Both exceed Cloudflare's 100 MB request body cap (when combined with
# multipart overhead and the form fields) and the worker's 32 MB
# per-file cap. Pre-pinning and passing CIDs to /ceremony/init bypasses
# both limits.
#
# The other two AMM circuits (lp_add ~2.8 MB zkey + ~1 MB r1cs;
# lp_remove ~5.6 MB + ~2 MB) fit comfortably inline and don't need this.
#
# Usage:
#   bash /Users/z/tacit/dapp/circuits/pin-amm-swap-batch.sh
#   PINATA_JWT=... bash /Users/z/tacit/dapp/circuits/pin-amm-swap-batch.sh
#
# Output: CIDs written to
#   ceremony-genesis-amm/amm_swap_batch_zkey0_cid.txt
#   ceremony-genesis-amm/amm_swap_batch_r1cs_cid.txt

set -euo pipefail

CIRCUITS_DIR="/Users/z/tacit/dapp/circuits"
ZKEY_FILE="${CIRCUITS_DIR}/ceremony-genesis-amm/amm_swap_batch_0000.zkey"
R1CS_FILE="${CIRCUITS_DIR}/amm/build/amm_swap_batch.r1cs"
ZKEY_CID_FILE="${CIRCUITS_DIR}/ceremony-genesis-amm/amm_swap_batch_zkey0_cid.txt"
R1CS_CID_FILE="${CIRCUITS_DIR}/ceremony-genesis-amm/amm_swap_batch_r1cs_cid.txt"

for f in "$ZKEY_FILE" "$R1CS_FILE"; do
    if [ ! -f "$f" ]; then
        echo "MISSING: $f" >&2
        echo "Re-run build.sh + groth16 setup and try again." >&2
        exit 1
    fi
done

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

CURL_CONFIG="$(mktemp -t tacit-pinata-swap-XXXXXX)"
chmod 600 "$CURL_CONFIG"
trap 'rm -f "$CURL_CONFIG"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$PINATA_JWT" > "$CURL_CONFIG"
PINATA_JWT=""; unset PINATA_JWT

# Pin one file and write its CID to a state file. Skips re-upload if the
# CID file already exists (Pinata is idempotent on content hash, but
# skipping the upload saves bandwidth + clock time on re-runs).
pin_one() {
    local label="$1"; local file="$2"; local cid_file="$3"; local pin_name="$4"
    if [ -f "$cid_file" ]; then
        local existing
        existing="$(tr -d '[:space:]' < "$cid_file")"
        if [ -n "$existing" ]; then
            echo "==> $label: already pinned in a prior run."
            echo "    CID: $existing"
            return 0
        fi
    fi
    local size_bytes
    size_bytes="$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file")"
    echo
    echo "==> Uploading $label (${size_bytes} bytes) to Pinata…"
    local resp_file
    resp_file="$(mktemp -t tacit-pinata-resp-XXXXXX)"
    local code
    code="$(curl --progress-bar --max-time 1800 --config "$CURL_CONFIG" \
        -o "$resp_file" -w '\n%{http_code}\n' \
        -X POST https://api.pinata.cloud/pinning/pinFileToIPFS \
        -F "file=@${file};filename=${pin_name}" \
        -F 'pinataOptions={"cidVersion":1}' \
        -F "pinataMetadata={\"name\":\"${pin_name}-$(date -u +%Y%m%dT%H%M%SZ)\"}" \
        | tail -1)" || code="000"
    if [ "$code" != "200" ]; then
        echo "✗ Pinata returned HTTP $code for $label" >&2
        head -c 500 "$resp_file" >&2; echo >&2
        rm -f "$resp_file"
        exit 1
    fi
    local cid
    cid="$(python3 -c "import sys,json; print(json.load(open(sys.argv[1])).get('IpfsHash',''))" "$resp_file")"
    rm -f "$resp_file"
    if [ -z "$cid" ]; then
        echo "✗ Pinata returned 200 but no IpfsHash for $label" >&2
        exit 1
    fi
    mkdir -p "$(dirname "$cid_file")"
    echo -n "$cid" > "$cid_file"
    echo "    CID: $cid"
    echo "    Saved to: $cid_file"
}

pin_one "amm_swap_batch zkey0 (~91 MB)" "$ZKEY_FILE" "$ZKEY_CID_FILE" "amm_swap_batch_0000.zkey"
pin_one "amm_swap_batch r1cs  (~34 MB)" "$R1CS_FILE" "$R1CS_CID_FILE" "amm_swap_batch.r1cs"

echo
echo "================================================================"
echo "  ✓ swap_batch artifacts pinned"
echo "================================================================"
echo
echo "  Next: re-run init — it'll skip the already-live lp_add/lp_remove"
echo "  chains (HTTP 409) and only fire the swap_batch POST with all three CIDs:"
echo "    bash ${CIRCUITS_DIR}/amm-ceremony-init.sh"
echo
