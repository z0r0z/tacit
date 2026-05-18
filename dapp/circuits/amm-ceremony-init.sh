#!/usr/bin/env bash
# One-shot kickoff for the AMM Phase 2 ceremony.
#
# Posts the three genesis zkeys + r1cs + pot18 to the worker's
# /ceremony/init endpoint, once per circuit, so the three chains
# (amm_lp_add, amm_lp_remove, amm_swap_batch) open for public
# contributions.
#
# Run from anywhere:
#   bash /Users/z/tacit/dapp/circuits/amm-ceremony-init.sh
#
# Token: read silently from your terminal (no argv, no shell history,
# no echo). The script unsets it before exit.

set -euo pipefail

# Pin paths to absolute so the script can be run from any cwd.
CIRCUITS_DIR="/Users/z/tacit/dapp/circuits"
PTAU_CID_FILE="${CIRCUITS_DIR}/ceremony-genesis-amm/pot18_cid.txt"
WORKER="${WORKER:-https://tacit-pin.rosscampbell9.workers.dev}"

# Preflight: zkeys + r1cs must exist locally; pot18 must be pre-pinned to
# IPFS via pin-pot18.sh (~288 MB exceeds Cloudflare's 100 MB body cap, so
# the worker accepts ptau_cid instead of an inline ptau upload).
for f in \
    "${CIRCUITS_DIR}/amm/build/amm_lp_add.r1cs" \
    "${CIRCUITS_DIR}/amm/build/amm_lp_remove.r1cs" \
    "${CIRCUITS_DIR}/amm/build/amm_swap_batch.r1cs" \
    "${CIRCUITS_DIR}/ceremony-genesis-amm/amm_lp_add_0000.zkey" \
    "${CIRCUITS_DIR}/ceremony-genesis-amm/amm_lp_remove_0000.zkey" \
    "${CIRCUITS_DIR}/ceremony-genesis-amm/amm_swap_batch_0000.zkey"
do
    if [ ! -f "$f" ]; then
        echo "MISSING: $f" >&2
        echo "Re-run the build + genesis steps and try again." >&2
        exit 1
    fi
done

if [ ! -f "$PTAU_CID_FILE" ]; then
    echo "MISSING: $PTAU_CID_FILE" >&2
    echo "" >&2
    echo "pot18 must be pre-pinned to IPFS before init. Run:" >&2
    echo "  bash ${CIRCUITS_DIR}/pin-pot18.sh" >&2
    echo "" >&2
    echo "(This is a one-time ~288 MB upload to Pinata; the resulting CID" >&2
    echo "gets written to $PTAU_CID_FILE and reused for all 3 circuits.)" >&2
    exit 1
fi
PTAU_CID="$(tr -d '[:space:]' < "$PTAU_CID_FILE")"
if ! [[ "$PTAU_CID" =~ ^[A-Za-z0-9]{46,80}$ ]]; then
    echo "INVALID CID in $PTAU_CID_FILE: '$PTAU_CID'" >&2
    exit 1
fi
echo "==> pot18 CID: $PTAU_CID"

# Token: silent read, scrubbed from environment after the loop.
if [ -z "${CEREMONY_INIT_TOKEN:-}" ]; then
    printf "Paste CEREMONY_INIT_TOKEN: "
    IFS= read -rs CEREMONY_INIT_TOKEN
    printf "\n"
fi
if [ -z "${CEREMONY_INIT_TOKEN:-}" ]; then
    echo "no token provided" >&2
    exit 1
fi
CEREMONY_INIT_TOKEN="$(printf '%s' "$CEREMONY_INIT_TOKEN" | xargs)"

# curl --config tempfile so the token never appears in argv / ps output.
CURL_CONFIG="$(mktemp -t tacit-amm-init-XXXXXX)"
chmod 600 "$CURL_CONFIG"
trap 'rm -f "$CURL_CONFIG"; unset CEREMONY_INIT_TOKEN' EXIT
printf 'header = "X-Tacit-Init-Token: %s"\n' "$CEREMONY_INIT_TOKEN" > "$CURL_CONFIG"

for c in amm_lp_add amm_lp_remove amm_swap_batch; do
    R1CS="${CIRCUITS_DIR}/amm/build/${c}.r1cs"
    Z0="${CIRCUITS_DIR}/ceremony-genesis-amm/${c}_0000.zkey"
    CHASH="$(shasum -a 256 "$R1CS" | cut -d' ' -f1)"
    # Per-circuit pre-pinned CID files. swap_batch's zkey (~91 MB) and r1cs
    # (~34 MB) exceed the worker's 32 MB per-file cap, so we pre-pin them
    # via pin-amm-swap-batch.sh and pass CIDs. lp_add / lp_remove fit
    # inline and skip this.
    Z0_CID_FILE="${CIRCUITS_DIR}/ceremony-genesis-amm/${c}_zkey0_cid.txt"
    R1CS_CID_FILE="${CIRCUITS_DIR}/ceremony-genesis-amm/${c}_r1cs_cid.txt"
    USE_Z0_CID=""; USE_R1CS_CID=""
    if [ -f "$Z0_CID_FILE" ]; then
        USE_Z0_CID="$(tr -d '[:space:]' < "$Z0_CID_FILE")"
    fi
    if [ -f "$R1CS_CID_FILE" ]; then
        USE_R1CS_CID="$(tr -d '[:space:]' < "$R1CS_CID_FILE")"
    fi
    echo
    echo ">>> POST /ceremony/init  ${c}  hash=${CHASH}"
    # Build curl args: each artifact uses either inline file or pre-pinned CID.
    INIT_ARGS=(
        -X POST
        -F "circuit_hash=${CHASH}"
        -F "ptau_cid=${PTAU_CID}"
        -F "initiator_name=tacit-amm-coordinator"
    )
    if [ -n "$USE_Z0_CID" ]; then
        INIT_ARGS+=(-F "zkey0_cid=${USE_Z0_CID}")
        echo "    zkey0_cid=${USE_Z0_CID}"
    else
        INIT_ARGS+=(-F "zkey0=@${Z0}")
    fi
    if [ -n "$USE_R1CS_CID" ]; then
        INIT_ARGS+=(-F "r1cs_cid=${USE_R1CS_CID}")
        echo "    r1cs_cid=${USE_R1CS_CID}"
    else
        INIT_ARGS+=(-F "r1cs=@${R1CS}")
    fi
    HTTP_CODE="$(curl --config "$CURL_CONFIG" \
        -sS -o /tmp/tacit-amm-init-${c}.out -w '%{http_code}' \
        "${INIT_ARGS[@]}" \
        "${WORKER}/ceremony/init")"
    BODY="$(cat /tmp/tacit-amm-init-${c}.out 2>/dev/null || echo '')"
    if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
        echo "  OK (HTTP ${HTTP_CODE})"
        echo "  ${BODY}" | head -c 400
        echo
    elif [ "$HTTP_CODE" = "409" ]; then
        # 409 means this chain was already initialized in a previous run —
        # don't re-init, don't abort. The chain is already live and accepting
        # contributions; the existing state is unchanged.
        echo "  SKIP (HTTP 409 — chain already initialized in a prior run)"
        echo "  ${BODY}" | head -c 400
        echo
    else
        echo "  FAIL (HTTP ${HTTP_CODE})"
        echo "  ${BODY}"
        exit 1
    fi
done

echo
echo "All three AMM ceremony chains are live."
echo "Verify: bash ${CIRCUITS_DIR}/amm-ceremony-verify.sh"
