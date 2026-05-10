#!/usr/bin/env bash
# Finalize the tacit mixer ceremony in one shot.
#
# Usage:
#   ./finalize.sh <bitcoin_block_height> [circuit_hash]
#
# What it does (no manual steps in the middle):
#   1. Reads CEREMONY_INIT_TOKEN from env or stdin (required for /finalize)
#   2. Resolves the worker's current head zkey CID
#   3. Downloads the head zkey from IPFS gateway
#   4. Fetches the chosen BTC block's hash from mempool.space
#   5. Applies snarkjs's beacon (10 iterations of MiMC)
#   6. POSTs the beacon-applied zkey to /ceremony/<hash>/finalize
#   7. Exports the finalized verifying key
#   8. Stages the ceremony bundle for IPFS pinning (you pin via Pinata / w3up
#      / ipfs add -r — see printed instructions at the end)
#
# The whole thing takes ~30 seconds + the time it takes to pin the bundle.

set -euo pipefail

# --- args ---
BLOCK_HEIGHT="${1:-}"
CIRCUIT_HASH="${2:-1373a3bc34153c291d057b44edaba11d5a4aa779d0998e0d0c0e400dfc89129d}"
WORKER="${WORKER:-https://tacit-pin.rosscampbell9.workers.dev}"
GATEWAY="${GATEWAY:-https://content.wrappr.wtf/ipfs}"
# Pinned snarkjs version. Audit reproducibility depends on contributors
# and finalizer agreeing on the exact CLI release — different versions
# can produce structurally-different (but cryptographically-equivalent)
# zkey files, and verifyFromR1cs serialization has changed between
# minor releases. The version below MUST match what the dapp's vendored
# snarkjs bundle was built from (currently 0.7.6). Override via env
# only if you've verified the new version produces identical output.
SNARKJS="${SNARKJS:-npx --yes snarkjs@0.7.6}"

# Auto-pick a beacon block if none was provided. Defaults to (current
# tip - 12) so the chosen block is comfortably past the 6-confirmation
# reorg-safety threshold (Bitcoin reorgs >6 deep are essentially
# unprecedented; 12 leaves a wide margin). Pre-announcing a specific
# block is a transparency-max practice for very small ceremonies; at
# scale (1000+ contributors) the coordinator's beacon choice is one of
# thousands of independent inputs and pre-announcement adds negligible
# auditability beyond what's verifiable from chain after the fact.
if [ -z "$BLOCK_HEIGHT" ]; then
  echo "==> No block height provided — auto-picking (tip - 12) for ≥12 confirmations"
  TIP=$(curl -sf --max-time 30 "https://mempool.space/api/blocks/tip/height" || echo "")
  if ! [[ "$TIP" =~ ^[0-9]+$ ]]; then
    echo "    ERROR: failed to fetch tip height from mempool.space"
    echo "    Pass an explicit block height: $0 <height>"
    exit 1
  fi
  BLOCK_HEIGHT=$((TIP - 12))
  echo "    tip=$TIP  →  beacon block height: $BLOCK_HEIGHT"
fi
if ! [[ "$BLOCK_HEIGHT" =~ ^[0-9]+$ ]]; then
  echo "block height must be a positive integer"; exit 1
fi
if ! [[ "$CIRCUIT_HASH" =~ ^[0-9a-f]{64}$ ]]; then
  echo "circuit_hash must be 64 lowercase hex chars"; exit 1
fi

cd "$(dirname "$0")"

# --- token ---
if [ -z "${CEREMONY_INIT_TOKEN:-}" ]; then
  printf "Paste CEREMONY_INIT_TOKEN (from your password manager): "
  # IFS= prevents bash from trimming leading/trailing whitespace inside
  # the read. -r disables backslash escape processing. -s silences echo
  # so the paste doesn't appear on screen or in shell history.
  # || true so a closed-stdin (CI / piped invocation) doesn't trip set -e
  # before the explicit empty-token check below.
  IFS= read -rs CEREMONY_INIT_TOKEN || true
  echo
fi
if [ -z "${CEREMONY_INIT_TOKEN:-}" ]; then
  echo "no token provided"; exit 1
fi
# Defensively strip a stray trailing newline some password managers
# include in their copy buffer. Token chars are URL-safe alnum + dashes;
# whitespace would always be a paste artifact, never a real token char.
CEREMONY_INIT_TOKEN="${CEREMONY_INIT_TOKEN%$'\n'}"
CEREMONY_INIT_TOKEN="${CEREMONY_INIT_TOKEN%$'\r'}"
# Scrub the var from the EXPORTED environment so child processes (npx,
# python3, curl helpers etc.) don't inherit it. The shell variable is
# still readable inside this script; only the process-env inheritance
# is broken. Cheap defense even on a personal laptop.
export -n CEREMONY_INIT_TOKEN 2>/dev/null || true

mkdir -p build artifacts ceremony-bundle

echo
echo "==> [1/8] Fetching ceremony state"
STATE=$(curl -sf --max-time 30 "$WORKER/ceremony/$CIRCUIT_HASH")
HEAD_CID=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['state']['head_cid'])")
PTAU_CID=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['state']['ptau_cid'])")
R1CS_CID=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['state']['r1cs_cid'])")
COUNT=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['state']['contribution_count'])")
FINALIZED=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['state'].get('finalized', False))")
echo "    contributions: $COUNT"
echo "    head zkey:     $HEAD_CID"
echo "    finalized:     $FINALIZED"

if [ "$FINALIZED" = "True" ]; then
  echo "    Already finalized. Aborting."
  exit 1
fi
# Hard floor on contribution count. SPEC §5.11.3 minimum is ≥5 disjoint
# trust roots; production target per MIXER.md is "ideally 100s"; gold-tier
# (Tornado-class) is 1100. Default to 1100 so a tired coordinator can't
# accidentally finalize at, say, 200 contributions in the middle of an
# active push. Override via MIN_CONTRIBUTIONS=N in env if you legitimately
# want to finalize a small ceremony (e.g., asset with low expected volume).
MIN_CONTRIBUTIONS="${MIN_CONTRIBUTIONS:-1100}"
if ! [[ "$COUNT" =~ ^[0-9]+$ ]]; then
  echo "    ERROR: contribution_count is not numeric: '$COUNT'"
  exit 1
fi
if (( COUNT < MIN_CONTRIBUTIONS )); then
  echo "    ERROR: contribution_count=$COUNT is below MIN_CONTRIBUTIONS=$MIN_CONTRIBUTIONS"
  echo "    If you genuinely want to finalize at this depth, override via:"
  echo "      MIN_CONTRIBUTIONS=$COUNT $0 ..."
  exit 1
fi
if [ "$COUNT" = "0" ]; then
  echo "    Warning: ceremony has 0 contributions (only the genesis). Are you sure?"
  printf "    Continue anyway? [y/N] "
  # || yn="" so closed-stdin (non-interactive run) defaults to N rather
  # than tripping set -e and exiting with a confusing error.
  read -r yn || yn=""
  [ "$yn" = "y" ] || [ "$yn" = "Y" ] || exit 0
fi

echo
echo "==> [2/8] Downloading head zkey from IPFS"
curl -sLf --max-time 120 "$GATEWAY/$HEAD_CID" -o build/withdraw_pre_beacon.zkey
# Magic-byte check on the downloaded blob — some IPFS gateways return
# 200 + HTML on missing CIDs, which curl -f can't catch. Reject anything
# that doesn't start with the snarkjs zkey signature.
if [ "$(head -c 4 build/withdraw_pre_beacon.zkey | xxd -p)" != "7a6b6579" ]; then
  echo "    ERROR: downloaded head zkey does not start with 'zkey' magic bytes."
  echo "    The gateway may have returned an error page. Inspect:"
  echo "      head -c 200 build/withdraw_pre_beacon.zkey"
  exit 1
fi
echo "    $(wc -c < build/withdraw_pre_beacon.zkey) bytes (zkey magic OK)"

echo
echo "==> [3/8] Fetching + cross-checking Bitcoin block $BLOCK_HEIGHT hash"
# Cross-check against TWO independent block explorers. A single API
# serving a wrong/hostile hash would otherwise pass through to finalize
# unnoticed (snarkjs treats the beacon hash as opaque random bytes —
# it doesn't verify the hash actually corresponds to a real block).
# Two-explorer agreement closes that audit hole at the cost of one
# extra curl.
H_MEMPOOL=$(curl -sf --max-time 30 "https://mempool.space/api/block-height/$BLOCK_HEIGHT" || echo "")
H_BLOCKSTREAM=$(curl -sf --max-time 30 "https://blockstream.info/api/block-height/$BLOCK_HEIGHT" || echo "")
if ! [[ "$H_MEMPOOL" =~ ^[0-9a-f]{64}$ ]]; then
  echo "    ERROR: mempool.space returned invalid hash: '$H_MEMPOOL'"
  echo "    Has block $BLOCK_HEIGHT confirmed yet? Check https://mempool.space/block/$BLOCK_HEIGHT"
  exit 1
fi
if ! [[ "$H_BLOCKSTREAM" =~ ^[0-9a-f]{64}$ ]]; then
  echo "    ERROR: blockstream.info returned invalid hash: '$H_BLOCKSTREAM'"
  echo "    Cross-check failed. Check https://blockstream.info/block-height/$BLOCK_HEIGHT"
  exit 1
fi
if [ "$H_MEMPOOL" != "$H_BLOCKSTREAM" ]; then
  echo "    ERROR: block hash mismatch between explorers!"
  echo "      mempool.space:    $H_MEMPOOL"
  echo "      blockstream.info: $H_BLOCKSTREAM"
  echo "    One of these is wrong or compromised. Refusing to use either."
  exit 1
fi
BTC_BLOCK_HASH="$H_MEMPOOL"
# Confirmation-depth gate. Auto-pick uses (tip-12) so this is satisfied
# by construction in that path, but if a user passes an explicit block
# height we need to verify it's still deep enough at finalize time. A
# block with <12 confirmations could in principle reorg out, leaving
# the audit trail pointing at a non-canonical hash. Refuse anything
# shallower than 12.
TIP_NOW=$(curl -sf --max-time 30 "https://mempool.space/api/blocks/tip/height" || echo "")
if ! [[ "$TIP_NOW" =~ ^[0-9]+$ ]]; then
  echo "    ERROR: failed to fetch current tip for confirmation-depth check"
  exit 1
fi
DEPTH=$((TIP_NOW - BLOCK_HEIGHT + 1))
if (( DEPTH < 12 )); then
  echo "    ERROR: beacon block has only $DEPTH confirmations; minimum required is 12"
  echo "      tip:           $TIP_NOW"
  echo "      beacon block:  $BLOCK_HEIGHT"
  echo "      Wait for $((12 - DEPTH)) more block(s) and re-run, or pick an older block."
  exit 1
fi
echo "    block $BLOCK_HEIGHT: $BTC_BLOCK_HASH"
echo "    confirmations: $DEPTH (≥12 required ✓; mempool.space ≡ blockstream.info ✓)"

echo
echo "==> [4/8] Applying beacon (numIterationsExp=10 → 1024 actual iterations)"
# Capture beacon output to a log instead of /dev/null so a beacon
# failure leaves diagnostics behind. Explicit non-empty output check
# also handles the case where snarkjs's CLI swallows beacon() errors
# (its zkeyBeacon command in cli.cjs ignores beacon's return value).
rm -f build/withdraw_final.zkey
# CEREMONY_INIT_TOKEN= prefixes scrub the token from snarkjs's
# child-process env. snarkjs itself doesn't log env, but defensively
# clearing it ensures no transitive npm dep can ever see the token via
# process.env. Subshell scope means the outer script still has the
# token for the POST in step 6.
#
# Check both: (a) snarkjs's exit code, (b) the output file is non-empty.
# snarkjs's CLI for `zkey beacon` historically didn't propagate beacon()
# return values through exit code; checking both is defense-in-depth.
if ! ( CEREMONY_INIT_TOKEN= $SNARKJS zkey beacon \
    build/withdraw_pre_beacon.zkey \
    build/withdraw_final.zkey \
    "$BTC_BLOCK_HASH" 10 \
    -n "bitcoin block $BLOCK_HEIGHT beacon" \
    > build/beacon.log 2>&1 ); then
  echo "    ✗ snarkjs zkey beacon exited nonzero. See build/beacon.log."
  exit 1
fi
if [ ! -s build/withdraw_final.zkey ]; then
  echo "    ✗ beacon application produced no output."
  echo "      See build/beacon.log for the snarkjs error trail."
  echo "      Common causes:"
  echo "      • beacon block hash format wrong (must be 64 lowercase hex)"
  echo "      • build/withdraw_pre_beacon.zkey is corrupt (re-run from step 2)"
  echo "      • snarkjs CLI version mismatch"
  exit 1
fi
# Magic-byte sanity check on the beacon output.
if [ "$(head -c 4 build/withdraw_final.zkey | xxd -p)" != "7a6b6579" ]; then
  echo "    ✗ beacon output does not start with 'zkey' magic bytes — corrupt."
  echo "      See build/beacon.log."
  exit 1
fi
echo "    wrote build/withdraw_final.zkey ($(wc -c < build/withdraw_final.zkey) bytes)"

# CRITICAL safety gate. Once we POST a malformed zkey to /finalize the
# ceremony locks against further contributes and the only recovery is
# /reset (which nukes ALL contributions). So we run snarkjs's full
# r1cs+ptau+zkey verify locally BEFORE the POST and abort if it doesn't
# pass. Downloads r1cs + ptau from IPFS rather than reading local
# build/ files so this works on a fresh checkout and verifies against
# the EXACT artifacts the chain was built on (not a potentially-stale
# local rebuild).
echo
echo "==> [5/8] Pre-flight: verifying beacon-applied zkey vs chain artifacts"
echo "    Downloading r1cs ($R1CS_CID)…"
curl -sLf --max-time 60 "$GATEWAY/$R1CS_CID" -o build/withdraw_chain.r1cs
if [ "$(head -c 4 build/withdraw_chain.r1cs | xxd -p)" != "72316373" ]; then
  echo "    ERROR: downloaded r1cs does not start with 'r1cs' magic bytes (gateway returned wrong content)."
  exit 1
fi
echo "    Downloading ptau ($PTAU_CID)…"
curl -sLf --max-time 180 "$GATEWAY/$PTAU_CID" -o build/pot14_chain.ptau
if [ "$(head -c 4 build/pot14_chain.ptau | xxd -p)" != "70746175" ]; then
  echo "    ERROR: downloaded ptau does not start with 'ptau' magic bytes (gateway returned wrong content)."
  exit 1
fi
echo "    Running snarkjs zkey verify (this can take ~30-60s)…"
# Rely on snarkjs's exit code (0 = ZKey Ok!, 1 = verification failed) per
# its cli.js wrapper rather than parsing output text. Output text has
# changed between minor versions ("ZKey OK!" → "ZKey Ok!"); the exit code
# contract is stable. Output captured to build/verify.log for diagnostics
# on failure.
if ! ( CEREMONY_INIT_TOKEN= $SNARKJS zkey verify \
    build/withdraw_chain.r1cs \
    build/pot14_chain.ptau \
    build/withdraw_final.zkey \
    > build/verify.log 2>&1 ); then
  echo
  echo "    ✗ LOCAL VERIFY FAILED. Beacon-applied zkey is NOT a valid extension"
  echo "      of the chain. Aborting before POST so the ceremony stays open."
  echo
  echo "    See build/verify.log for the snarkjs error trail."
  echo "    Common causes:"
  echo "      • build/withdraw_pre_beacon.zkey is corrupt or partial (re-run from step 2)"
  echo "      • beacon block hash format wrong (must be 64 lowercase hex)"
  echo "      • snarkjs version mismatch between contributors and finalizer"
  exit 1
fi
echo "    ✓ ZKey Ok — beacon-applied zkey verified against chain r1cs+ptau"

echo
echo "==> [6/8] POSTing to /finalize"
# expected_head_cid pins the CAS check on the worker side: if a
# contribute lands during the IPFS pin window, the worker rejects this
# finalize POST instead of silently overwriting. The script then exits
# cleanly so the user can re-run (which picks up the new head). Uses
# --max-time 600 because the worker pins to Pinata which can be slow on
# congested days.
HTTP_CODE=$(curl -s -o build/finalize_response.json -w "%{http_code}" \
  --max-time 600 \
  -X POST \
  -H "X-Tacit-Init-Token: $CEREMONY_INIT_TOKEN" \
  -F "zkey=@build/withdraw_final.zkey" \
  -F "beacon_block_hash=$BTC_BLOCK_HASH" \
  -F "beacon_block_height=$BLOCK_HEIGHT" \
  -F "beacon_iterations=10" \
  -F "expected_head_cid=$HEAD_CID" \
  "$WORKER/ceremony/$CIRCUIT_HASH/finalize")
if [ "$HTTP_CODE" = "409" ]; then
  echo "    ✗ Finalize race lost: a contribute landed during the IPFS pin"
  echo "      window. The chain advanced past the head we beaconed."
  echo "      The ceremony is UNCHANGED; just re-run this script to pick"
  echo "      up the new head + re-beacon + re-POST."
  echo
  echo "      TIP: wait ~60 seconds before retrying so contribute rate"
  echo "      can settle below the pin-window race threshold. If 409"
  echo "      fires twice in a row, pause public promotion (e.g., tweet"
  echo "      'closing contributions in 5 min') before retrying."
  echo
  echo "    Worker response:"
  cat build/finalize_response.json 2>/dev/null
  echo
  exit 1
fi
if [ "$HTTP_CODE" != "200" ]; then
  echo "    ✗ Finalize POST failed with HTTP $HTTP_CODE"
  echo "      Worker response:"
  cat build/finalize_response.json 2>/dev/null
  echo
  exit 1
fi
RESP=$(cat build/finalize_response.json)
FINAL_CID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['state']['head_cid'])")
echo "    finalized head_cid: $FINAL_CID"
echo "    state: $(echo "$RESP" | python3 -c "import sys,json; s=json.load(sys.stdin)['state']; print(f\"contributions={s['contribution_count']} finalized={s.get('finalized',False)} beacon={s.get('beacon_block_hash','?')[:16]}…\")")"

echo
echo "==> [7/8] Exporting verifying key"
if ! ( CEREMONY_INIT_TOKEN= $SNARKJS zkey export verificationkey \
    build/withdraw_final.zkey \
    artifacts/verification_key_final.json \
    > build/export_vk.log 2>&1 ); then
  echo "    ✗ snarkjs zkey export verificationkey failed. See build/export_vk.log."
  exit 1
fi
N_PUBLIC=$(python3 -c "import json; print(json.load(open('artifacts/verification_key_final.json'))['nPublic'])")
echo "    artifacts/verification_key_final.json (nPublic=$N_PUBLIC)"

echo
echo "==> [8/8] Staging ceremony bundle"
# Use the chain-downloaded artifacts (build/withdraw_chain.r1cs +
# build/pot14_chain.ptau) so the bundle reflects exactly what the
# ceremony was built on, not a potentially-stale local rebuild from
# build.sh. Renamed in the bundle to match snarkjs's expected filenames.
cp build/withdraw_chain.r1cs ceremony-bundle/withdraw.r1cs
cp build/pot14_chain.ptau ceremony-bundle/pot14_final.ptau
cp build/withdraw_pre_beacon.zkey ceremony-bundle/withdraw_pre_beacon.zkey
cp build/withdraw_final.zkey ceremony-bundle/withdraw_final.zkey
cp artifacts/verification_key_final.json ceremony-bundle/verification_key_final.json
cp artifacts/verification_key_final.json ceremony-bundle/verification_key.json

# Paginate attestations through cursor mode so the bundle ships EVERY
# record, not just the latest 100. /attestations (no cursor key) is
# recent-mode and capped at the limit param; for an audit bundle we want
# the entire chain. Walk via ?cursor= until list_complete.
#
# Uses curl for the network (Python's urllib is occasionally blocked by
# Cloudflare on default User-Agent) and python for JSON merge + sort.
# Output is a single JSON file with all attestations sorted by idx.
echo "    Paginating attestations through cursor mode…"
> build/attest_pages.jsonl
cursor=""
pages=0
total=0
while [ $pages -lt 200 ]; do
  pages=$((pages + 1))
  page=$(curl -sf --max-time 120 -A "tacit-finalize/1.0" \
    "${WORKER}/ceremony/${CIRCUIT_HASH}/attestations?limit=1000&cursor=${cursor}")
  if [ -z "$page" ]; then
    echo "    ERROR: empty response on page $pages"
    exit 1
  fi
  # Append this page's body as one line of JSON to the JSONL file.
  echo "$page" >> build/attest_pages.jsonl
  page_count=$(echo "$page" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('attestations',[])))")
  total=$((total + page_count))
  list_complete=$(echo "$page" | python3 -c "import json,sys; print(json.load(sys.stdin).get('list_complete', True))")
  if [ "$list_complete" = "True" ]; then break; fi
  next_cursor=$(echo "$page" | python3 -c "import json,sys; print(json.load(sys.stdin).get('cursor', ''))")
  if [ -z "$next_cursor" ]; then break; fi
  # URL-encode the cursor (it's opaque base64-ish, may contain + / =).
  cursor=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$next_cursor")
done
# Merge all pages, sort by index for deterministic audit-friendly output.
ATTEST_COUNT=$(python3 <<'PY'
import json, sys
out = []
with open("build/attest_pages.jsonl") as f:
    for line in f:
        body = json.loads(line)
        out.extend(body.get("attestations", []))
out.sort(key=lambda a: (a.get("index", 0), a.get("cid", "")))
with open("ceremony-bundle/attestations.json", "w") as g:
    json.dump({"attestations": out, "count": len(out), "list_complete": True}, g, indent=2)
print(len(out))
PY
)
echo "    bundled $ATTEST_COUNT attestation records (paginated across $pages page(s))"

# Compute audit-relevant hashes ONCE for use in the bundle README.
PTAU_SHA256=$(shasum -a 256 ceremony-bundle/pot14_final.ptau | cut -d' ' -f1)
# LibreSSL on some macOS builds doesn't support -blake2b512. Fall back
# silently — the sha256 is the load-bearing audit hash; blake2b is
# an extra cross-check. With set -euo pipefail, a missing blake2b
# command would otherwise abort the script *after* finalize succeeded
# but before the bundle is written, which is the worst-case timing.
PTAU_BLAKE2B=$(openssl dgst -blake2b512 ceremony-bundle/pot14_final.ptau 2>/dev/null | awk '{print $NF}' || true)
FINAL_SHA256=$(shasum -a 256 ceremony-bundle/withdraw_final.zkey | cut -d' ' -f1)
PRE_BEACON_SHA256=$(shasum -a 256 ceremony-bundle/withdraw_pre_beacon.zkey | cut -d' ' -f1)
R1CS_SHA256=$(shasum -a 256 ceremony-bundle/withdraw.r1cs | cut -d' ' -f1)
VK_SHA256=$(shasum -a 256 ceremony-bundle/verification_key.json | cut -d' ' -f1)

{
  echo "# Tacit mixer ceremony — circuit $CIRCUIT_HASH"
  echo
  echo "## Phase 1 (Powers of Tau)"
  echo
  echo "Polygon Hermez ceremony output \`powersOfTau28_hez_final_14.ptau\`:"
  echo "- 71-contributor public Phase 1 ceremony (2020–2022)"
  echo "- Bitcoin-block-hash beacon-finalized at the end"
  echo "- Cross-check against snarkjs/README.md row 14:"
  echo "  https://github.com/iden3/snarkjs#7-prepare-phase-2"
  echo
  echo "File hashes (this bundle's \`pot14_final.ptau\`):"
  echo "- sha256:  $PTAU_SHA256"
  if [ -n "$PTAU_BLAKE2B" ]; then
    echo "- blake2b: $PTAU_BLAKE2B"
  fi
  echo
  echo "## Phase 2 (per-circuit MPC)"
  echo
  echo "- $COUNT contributions across $ATTEST_COUNT total attestation records (see \`attestations.json\`)"
  echo "- Beacon-finalized: Bitcoin block $BLOCK_HEIGHT, hash \`$BTC_BLOCK_HASH\`, 10 iterations (= 1024 actual MiMC iterations)"
  echo "- Cross-checked at finalize time against blockstream.info (matched mempool.space)"
  echo
  echo "## Files in this bundle"
  echo
  echo "| File | Purpose | sha256 |"
  echo "| --- | --- | --- |"
  echo "| \`withdraw.r1cs\`               | Circuit constraint system        | \`$R1CS_SHA256\` |"
  echo "| \`pot14_final.ptau\`            | Phase 1 powers-of-tau (Hermez)   | \`$PTAU_SHA256\` |"
  echo "| \`withdraw_pre_beacon.zkey\`    | Last contribution before beacon  | \`$PRE_BEACON_SHA256\` |"
  echo "| \`withdraw_final.zkey\`         | Beacon-applied production zkey   | \`$FINAL_SHA256\` |"
  echo "| \`verification_key.json\`       | Production verifying key         | \`$VK_SHA256\` |"
  echo "| \`attestations.json\`           | Full Phase 2 contribution chain  | (count: $ATTEST_COUNT) |"
  echo
  echo "## Verify locally"
  echo
  echo "Confirm the beacon-applied zkey is a valid extension of the chain:"
  echo
  echo '    npx snarkjs zkey verify withdraw.r1cs pot14_final.ptau withdraw_final.zkey'
  echo
  echo "Should print \`ZKey Ok!\` on success."
} > ceremony-bundle/README.md

echo "    ceremony-bundle/ ready ($(du -sh ceremony-bundle | cut -f1))"

echo
echo "================================================================"
echo "  ✓ Ceremony finalized."
echo "================================================================"
echo
echo "  Next steps (~5 min):"
echo
echo "  1. Pin the bundle to IPFS as a directory and grab its CID:"
echo "       w3 up ceremony-bundle/                     # web3.storage"
echo "       # OR drag the folder into Pinata's web UI"
echo "       # OR ipfs add -r ceremony-bundle/"
echo
echo "  2. Open https://tacit.finance/  → Mixer tab → 'Initialize a new pool':"
echo "       Asset:           [pick from dropdown]"
echo "       Denomination:    [pool size in base units]"
echo "       vk JSON:         dapp/circuits/artifacts/verification_key_final.json"
echo "                        (auto-pins via worker, fills vk CID)"
echo "       Ceremony CID:    [the directory CID from step 1]"
echo
echo "  3. Click 'Initialize pool & broadcast'. Sign commit + reveal."
echo
echo "================================================================"
