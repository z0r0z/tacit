#!/usr/bin/env bash
# mirror-pins.sh — Mirror tacit's canonical IPFS artifacts to an additional
# pinning provider, preserving every CID exactly as referenced on-chain.
#
# Two transports, picked by env:
#
#   S3-CAR (Filebase, works on the free tier):
#     FILEBASE_BUCKET=mybucket ./mirror-pins.sh
#     Fetches each CID as a CAR from a trustless gateway, imports it via
#     S3 PUT + `x-amz-meta-import: car`, and asserts the returned
#     `x-amz-meta-cid` equals the canonical CID — same bytes, same DAG,
#     same CID, with a built-in integrity check per artifact.
#     FILEBASE_KEY / FILEBASE_SECRET read from env or prompted silently.
#
#   PSA (any IPFS Pinning Service API endpoint — 4everland, Pinata /psa,
#   paid Filebase, Kubo `pin remote`):
#     PIN_ENDPOINT=https://api.4everland.dev PIN_TOKEN=... ./mirror-pins.sh
#     Pin-by-CID; the provider fetches the DAG from the network.
#
# Re-runnable: artifacts already mirrored are skipped.
#
# Security pattern matches pin-bundle.sh:
#   - credentials read silently (no terminal echo, no shell history)
#   - credentials never in argv (curl --config tempfile, mode 0600)
#   - tempfiles removed via trap on EXIT
#
# Usage:
#   ./mirror-pins.sh                          # mirror the canonical set
#   ./mirror-pins.sh manifest.txt             # also mirror "cid name" lines
#   ./mirror-pins.sh assets-manifest out.txt  # write a manifest of asset
#                                             # image CIDs from the live API
#   ./mirror-pins.sh audit [manifest.txt]     # reconcile the bucket against
#                                             # the expected set: missing /
#                                             # CID-mismatched / truncated /
#                                             # orphaned objects + totals

set -euo pipefail

WORKER_BASE="${WORKER_BASE:-https://tacit-pin.rosscampbell9.workers.dev}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
POLL_TIMEOUT="${POLL_TIMEOUT:-1800}"
S3_BASE="${S3_BASE:-https://s3.filebase.com}"

# Gateways used to fetch single raw blocks (?format=raw), tried in order.
# Public gateways may truncate large CAR exports mid-DAG while still
# returning 200 (the trustless-gateway spec permits partial CARs), and the
# provider-side import reports the root CID either way — so this script
# never trusts a public-gateway CAR for a multi-block DAG. Multi-block
# artifacts require a local Kubo daemon (`brew install kubo; ipfs daemon`):
# `ipfs pin add` hash-verifies every block and `ipfs dag export` then
# emits a complete CAR. Single-block raw CIDs (bafkrei…) are safe from any
# gateway because the bytes are re-hashed locally against the CID before
# the CAR is built here.
CAR_GATEWAYS="${CAR_GATEWAYS:-
https://ipfs.io/ipfs
https://trustless-gateway.link/ipfs
https://dweb.link/ipfs
https://gateway.pinata.cloud/ipfs
https://4everland.io/ipfs
}"
IPFS_API="${IPFS_API:-http://127.0.0.1:5001}"

# Canonical artifact set. CIDs are the hardcoded protocol constants
# (dapp/tacit.js CANONICAL_*, dapp/circuits/ceremony-genesis-amm/*_cid.txt,
# TETH_ASSET / TETH_DEPLOYMENTS image URIs) plus the TAC etch's on-chain
# image_uri chain (metadata JSON carrying the tacit_attest supply opening,
# and the image it points to).
CANONICAL_PINS="
bafybeidq2ahzte4sfiqjsmhqta62ufenpppzpch5ppry55tzxzlvltxy2u tacit-mixer-ceremony-bundle
bafkreidwbautgstcnl54oszez7yqlc7mr5lrj6ac65h3p5sjw2rgz2jtv4 tacit-mixer-verification-key
bafkreibjpe4xfqtq2ziki4uupydnkeiakqi76m674xtdhmxnfbrn4iomp4 tacit-amm-vk-wrapper
bafybeiheww2ndia2gld4mu7x2h7iwzawv6likpmfpklm6x5kj3btaniuam tacit-amm-ceremony-bundle
bafybeigb43fb66kxs4wlxwsgasr22g7itd6yzotgtu2dosjt7zcegsizri tacit-pot18-ptau
bafybeico2tziscjb2k3pknvyo5tqx652xcby2mcibnmgivav25fnsv72w4 tacit-amm-swap-batch-r1cs
bafybeih4gm7vkrmegm2uxsuoc254bv7cnicpin3in46d6wki7m34grqnsy tacit-amm-swap-batch-zkey0
bafkreig7m5j66zlaewjvo6bipk723udgdhnyl7ve5k2suofuvhi2mmb3ai tacit-tac-metadata
bafkreibwpxssdmoczx75vsqmk5vpdyztwwz3qmykpucn5xow64ku5ht46m tacit-tac-image
bafkreid55b3c2w6swyjl3lec66a23subiolwwsd6tof2wticoj6d7vnv4i tacit-teth-image
bafkreihmbs7c6hg2q5zu3kl65f65irwmleuxdw6jfop44lwtzc4ijta53q tacit-teth-signet-metadata
bafkreihdfl7hi2loonoavvl3y43qfyakwx3mvt6tuafybspfmvvmcc2ua4 tacit-teth-mainnet-metadata
"

for cmd in curl python3 mktemp; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "✗ missing: $cmd"; exit 1
  fi
done

# ---------------------------------------------------------------------------
# assets-manifest mode: pull every etched asset's image CID from the live
# indexer (both networks) into a "cid name" manifest for a second run.
if [ "${1:-}" = "assets-manifest" ]; then
  OUT="${2:?usage: ./mirror-pins.sh assets-manifest out.txt}"
  : > "$OUT"
  for net in mainnet signet; do
    curl -sf --max-time 30 "${WORKER_BASE}/assets?network=${net}" | python3 -c '
import json, re, sys
net = sys.argv[1]
data = json.load(sys.stdin)
for a in data.get("assets", []):
    uri = a.get("image_uri") or ""
    if uri.startswith("ipfs://"):
        cid = uri[7:].split("/")[0].strip()
        ticker = re.sub(r"[^a-z0-9]+", "-", (a.get("ticker") or "unknown").lower()).strip("-")
        if cid:
            # tickers are not unique — suffix the CID tail so two assets
            # sharing a ticker cannot collide on the same object key
            print(cid, "asset-%s-%s-image-%s" % (net, ticker or "unknown", cid[-7:]))
' "$net" >> "$OUT" || echo "  (skipped ${net}: fetch failed)"
  done
  sort -u -o "$OUT" "$OUT"
  echo "wrote $(wc -l < "$OUT" | tr -d ' ') CIDs to $OUT"
  echo "mirror them with: ./mirror-pins.sh $OUT"
  exit 0
fi

AUDIT=0
if [ "${1:-}" = "audit" ]; then AUDIT=1; shift; fi
MANIFEST_FILE="${1:-}"

# Build the worklist: canonical set + optional manifest file.
CIDS=()
NAMES=()
while read -r cid name; do
  [ -n "$cid" ] || continue
  CIDS+=("$cid"); NAMES+=("${name:-$cid}")
done <<< "$CANONICAL_PINS"
if [ -n "$MANIFEST_FILE" ]; then
  if [ ! -f "$MANIFEST_FILE" ]; then echo "✗ manifest not found: $MANIFEST_FILE"; exit 1; fi
  while read -r cid name; do
    [ -n "$cid" ] || continue
    case "$cid" in \#*) continue;; esac
    CIDS+=("$cid"); NAMES+=("${name:-$cid}")
  done < "$MANIFEST_FILE"
fi

CURL_CFG="$(mktemp)"
chmod 0600 "$CURL_CFG"
CAR_TMP="$(mktemp -d)"
trap 'rm -rf "$CURL_CFG" "$CAR_TMP"' EXIT

ipfs_daemon_up() {
  curl -sf --max-time 5 -X POST "${IPFS_API}/api/v0/version" >/dev/null 2>&1
}

# Verify raw block bytes hash to the CID, then wrap them in a CARv1.
# Only CIDv1 raw sha2-256 (bafkrei…) is supported — exactly the profile
# the worker pins for vk/metadata/image files.
build_raw_car() { # build_raw_car <cid> <rawfile> <carfile>
  python3 - "$1" "$2" "$3" <<'PYEOF'
import base64, hashlib, sys
cid_str, raw_path, car_path = sys.argv[1:4]
s = cid_str[1:].upper()
cid_bytes = base64.b32decode(s + "=" * (-len(s) % 8))
if cid_bytes[:4] != bytes([0x01, 0x55, 0x12, 0x20]) or len(cid_bytes) != 36:
    sys.exit("unsupported CID profile (need CIDv1 raw sha2-256)")
data = open(raw_path, "rb").read()
if hashlib.sha256(data).digest() != cid_bytes[4:]:
    sys.exit("block bytes do not hash to CID")
def varint(n):
    out = b""
    while True:
        b7 = n & 0x7F; n >>= 7
        out += bytes([b7 | (0x80 if n else 0)])
        if not n: return out
hdr = (b"\xa2" + b"\x65roots" + b"\x81" + b"\xd8\x2a" + b"\x58\x25" + b"\x00"
       + cid_bytes + b"\x67version" + b"\x01")
with open(car_path, "wb") as f:
    f.write(varint(len(hdr)) + hdr)
    blk = cid_bytes + data
    f.write(varint(len(blk)) + blk)
PYEOF
}

fetch_car() { # fetch_car <cid> <outfile>
  local cid="$1" out="$2" gw raw
  if ipfs_daemon_up; then
    if ipfs pin add "$cid" >/dev/null 2>&1 && ipfs dag export "$cid" > "$out" 2>/dev/null; then
      return 0
    fi
    echo "    (local kubo pin/export failed for ${cid})" >&2
    return 1
  fi
  case "$cid" in
    bafkrei*)
      raw="${out}.raw"
      for gw in $CAR_GATEWAYS; do
        if curl -sfL --max-time 120 -H 'Accept: application/vnd.ipld.raw' \
             "${gw}/${cid}?format=raw" -o "$raw" 2>/dev/null \
           && [ -s "$raw" ] && build_raw_car "$cid" "$raw" "$out"; then
          rm -f "$raw"
          return 0
        fi
      done
      rm -f "$raw"
      return 1
      ;;
    *)
      echo "    (multi-block DAG ${cid} needs a local Kubo daemon — ipfs daemon, then re-run)" >&2
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# S3-CAR transport (Filebase free tier)
if [ -n "${FILEBASE_BUCKET:-}" ]; then
  if [ -z "${FILEBASE_KEY:-}" ]; then
    printf "Filebase access key: " >&2; read -rs FILEBASE_KEY; echo >&2
  fi
  if [ -z "${FILEBASE_SECRET:-}" ]; then
    printf "Filebase secret key: " >&2; read -rs FILEBASE_SECRET; echo >&2
  fi
  if [ -z "$FILEBASE_KEY" ] || [ -z "$FILEBASE_SECRET" ]; then echo "✗ empty credentials"; exit 1; fi
  printf 'user = "%s:%s"\naws-sigv4 = "aws:amz:us-east-1:s3"\n' "$FILEBASE_KEY" "$FILEBASE_SECRET" > "$CURL_CFG"
  unset FILEBASE_KEY FILEBASE_SECRET

  # Single PUTs above ~300 MB die mid-stream on slow uplinks (the server
  # caps connection lifetime), so large CARs go up as S3 multipart: each
  # part is a short-lived connection with its own retries, and the
  # import metadata rides on the initiate call.
  MP_THRESHOLD="${MP_THRESHOLD:-209715200}"   # 200 MB
  MP_PART_SIZE="${MP_PART_SIZE:-50m}"

  s3_upload_car() { # s3_upload_car <carfile> <key> → prints returned meta-cid
    local car="$1" key="$2" base="${S3_BASE}/${FILEBASE_BUCKET}/${2}"
    local sz upload_id parts_xml="" n=0 part etag attempt pdir
    sz=$(stat -f%z "$car" 2>/dev/null || stat -c%s "$car")
    if [ "$sz" -le "$MP_THRESHOLD" ]; then
      curl -sf --max-time 1800 -K "$CURL_CFG" -X PUT -T "$car" \
        -H 'x-amz-meta-import: car' "$base" -D - -o /dev/null 2>/dev/null \
        | tr -d '\r' | awk 'tolower($1)=="x-amz-meta-cid:"{print $2}'
      return 0
    fi
    upload_id="$(curl -sf --max-time 60 -K "$CURL_CFG" -X POST \
        -H 'x-amz-meta-import: car' "${base}?uploads" 2>/dev/null \
      | python3 -c 'import re,sys; m=re.search(r"<UploadId>([^<]+)</UploadId>", sys.stdin.read()); print(m.group(1) if m else "")')"
    if [ -z "$upload_id" ]; then echo "    (multipart initiate failed)" >&2; return 1; fi
    pdir="${CAR_TMP}/mp"
    rm -rf "$pdir"; mkdir -p "$pdir"
    split -b "$MP_PART_SIZE" "$car" "${pdir}/part_"
    for part in "${pdir}"/part_*; do
      n=$((n+1))
      etag=""
      for attempt in 1 2 3; do
        etag="$(curl -sf --max-time 900 -K "$CURL_CFG" -X PUT -T "$part" \
            "${base}?partNumber=${n}&uploadId=${upload_id}" -D - -o /dev/null 2>/dev/null \
          | tr -d '\r' | awk 'tolower($1)=="etag:"{print $2}')"
        [ -n "$etag" ] && break
        echo "    (part ${n} attempt ${attempt} failed)" >&2
      done
      if [ -z "$etag" ]; then
        curl -sf --max-time 60 -K "$CURL_CFG" -X DELETE "${base}?uploadId=${upload_id}" -o /dev/null 2>/dev/null || true
        rm -rf "$pdir"
        return 1
      fi
      echo "    part ${n} uploaded" >&2
      parts_xml="${parts_xml}<Part><PartNumber>${n}</PartNumber><ETag>${etag}</ETag></Part>"
    done
    rm -rf "$pdir"
    if ! curl -sf --max-time 600 -K "$CURL_CFG" -X POST -H 'Content-Type: application/xml' \
           -d "<CompleteMultipartUpload>${parts_xml}</CompleteMultipartUpload>" \
           "${base}?uploadId=${upload_id}" -o /dev/null 2>/dev/null; then
      curl -sf --max-time 60 -K "$CURL_CFG" -X DELETE "${base}?uploadId=${upload_id}" -o /dev/null 2>/dev/null || true
      echo "    (multipart complete failed)" >&2
      return 1
    fi
    curl -sf --max-time 60 -K "$CURL_CFG" -I "$base" 2>/dev/null \
      | tr -d '\r' | awk 'tolower($1)=="x-amz-meta-cid:"{print $2}'
  }

  # -------------------------------------------------------------------------
  # audit: reconcile bucket contents against the expected set. Presence and
  # meta-CID alone don't prove a complete mirror (a truncated CAR import
  # still reports the root CID), so when the local Kubo repo has the DAG
  # the object size is checked against the DAG payload size too.
  if [ "$AUDIT" = "1" ]; then
    echo "==> Auditing bucket '${FILEBASE_BUCKET}' against ${#CIDS[@]} expected CIDs"
    echo
    LISTING="${CAR_TMP}/listing.tsv"
    : > "$LISTING"
    token=""
    while :; do
      url="${S3_BASE}/${FILEBASE_BUCKET}?list-type=2&max-keys=1000"
      if [ -n "$token" ]; then
        enc="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$token")"
        url="${url}&continuation-token=${enc}"
      fi
      page="$(curl -sf --max-time 60 -K "$CURL_CFG" "$url")" || { echo "✗ bucket listing failed"; exit 1; }
      token="$(printf '%s' "$page" | python3 -c '
import re, sys
xml = sys.stdin.read()
for m in re.finditer(r"<Contents>.*?<Key>([^<]+)</Key>.*?<Size>(\d+)</Size>.*?</Contents>", xml, re.S):
    sys.stderr.write("%s\t%s\n" % (m.group(1), m.group(2)))
m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", xml)
print(m.group(1) if m and "<IsTruncated>true</IsTruncated>" in xml else "")
' 2>>"$LISTING")"
      [ -n "$token" ] || break
    done

    BAD=0
    for i in "${!CIDS[@]}"; do
      cid="${CIDS[$i]}"; name="${NAMES[$i]}"; key="${name}.car"
      row="$(grep -m1 "^${key}	" "$LISTING" || true)"
      if [ -z "$row" ]; then
        echo "  ✗ ${name}: MISSING"; BAD=1; continue
      fi
      clen="${row##*	}"
      have="$(curl -sf --max-time 30 -K "$CURL_CFG" -I "${S3_BASE}/${FILEBASE_BUCKET}/${key}" 2>/dev/null \
              | tr -d '\r' | awk 'tolower($1)=="x-amz-meta-cid:"{print $2}' || true)"
      if [ "$have" != "$cid" ]; then
        echo "  ✗ ${name}: CID MISMATCH (object reports '${have:-<none>}')"; BAD=1; continue
      fi
      dagsz="$(ipfs dag stat --offline --progress=false "$cid" 2>/dev/null | awk '/Total Size:/{print $3}' || true)"
      if [ -n "$dagsz" ] && [ "$clen" -lt "$dagsz" ]; then
        echo "  ✗ ${name}: TRUNCATED (${clen} < ${dagsz})"; BAD=1; continue
      fi
      echo "  ✓ ${name}: ok (${clen} bytes${dagsz:+, size-checked})"
    done

    echo
    while IFS=$(printf '\t') read -r key sz; do
      case "$key" in */) continue;; esac
      found=0
      for i in "${!NAMES[@]}"; do
        if [ "$key" = "${NAMES[$i]}.car" ]; then found=1; break; fi
      done
      [ "$found" = "0" ] && echo "  · orphan: ${key} (${sz} bytes — not in expected set)"
    done < "$LISTING"

    total="$(awk -F'\t' '{s+=$2} END {printf "%d", s}' "$LISTING")"
    count="$(wc -l < "$LISTING" | tr -d ' ')"
    echo
    echo "==> ${count} objects, $((total / 1048576)) MB in bucket; ${#CIDS[@]} expected CIDs checked."
    [ "$BAD" = "0" ] && echo "==> Audit clean." || { echo "==> Audit FAILED — re-run the mirror to repair."; exit 1; }
    exit 0
  fi

  echo "==> Mirroring ${#CIDS[@]} CIDs to Filebase bucket '${FILEBASE_BUCKET}' (CAR import)"
  echo

  FAILED=0
  for i in "${!CIDS[@]}"; do
    cid="${CIDS[$i]}"; name="${NAMES[$i]}"; key="${name}.car"
    head_out="$(curl -sf --max-time 30 -K "$CURL_CFG" -I "${S3_BASE}/${FILEBASE_BUCKET}/${key}" 2>/dev/null | tr -d '\r' || true)"
    have="$(printf '%s\n' "$head_out" | awk 'tolower($1)=="x-amz-meta-cid:"{print $2}')"
    if [ "$have" = "$cid" ]; then
      # A CAR is at least as large as its DAG payload; a smaller object is a
      # truncated upload from an earlier partial-CAR fetch.
      clen="$(printf '%s\n' "$head_out" | awk 'tolower($1)=="content-length:"{print $2}')"
      dagsz="$(ipfs dag stat --offline --progress=false "$cid" 2>/dev/null | awk '/Total Size:/{print $3}' || true)"
      if [ -n "$dagsz" ] && [ -n "$clen" ] && [ "$clen" -lt "$dagsz" ]; then
        echo "  ! ${name}: mirrored object is smaller than the DAG (${clen} < ${dagsz}) — re-uploading"
      else
        echo "  ✓ ${name}: already mirrored"
        continue
      fi
    fi
    car="${CAR_TMP}/${name}.car"
    if ! fetch_car "$cid" "$car"; then
      echo "  ✗ ${name}: CAR export failed on all gateways"; FAILED=1; continue
    fi
    sz=$(stat -f%z "$car" 2>/dev/null || stat -c%s "$car")
    printf "  … %s: importing CAR (%d bytes)\n" "$name" "$sz"
    got="$(s3_upload_car "$car" "$key" || true)"
    rm -f "$car"
    if [ "$got" = "$cid" ]; then
      echo "  ✓ ${name}: pinned, CID verified"
    else
      echo "  ✗ ${name}: import returned '${got:-<none>}' (expected ${cid}) — removing object"
      curl -sf --max-time 30 -K "$CURL_CFG" -X DELETE "${S3_BASE}/${FILEBASE_BUCKET}/${key}" -o /dev/null || true
      FAILED=1
    fi
  done

  echo
  if [ "$FAILED" = "0" ]; then
    echo "==> All CIDs mirrored and verified on Filebase."
  else
    echo "==> Completed with failures — re-run to retry."
    exit 1
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# PSA transport (standard IPFS Pinning Service API)
if [ "$AUDIT" = "1" ]; then
  echo "✗ audit requires the S3 transport — set FILEBASE_BUCKET"; exit 1
fi
PIN_ENDPOINT="${PIN_ENDPOINT:-https://api.filebase.io/v1/ipfs}"
PIN_ENDPOINT="${PIN_ENDPOINT%/}"
if [ -z "${PIN_TOKEN:-}" ]; then
  printf "Pinning API token for %s: " "$PIN_ENDPOINT" >&2
  read -rs PIN_TOKEN
  echo >&2
fi
if [ -z "$PIN_TOKEN" ]; then echo "✗ empty token"; exit 1; fi
printf 'header = "Authorization: Bearer %s"\n' "$PIN_TOKEN" > "$CURL_CFG"
unset PIN_TOKEN

api() { # api <method> <path-with-query> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sf --max-time 60 -K "$CURL_CFG" -X "$method" \
      -H 'Content-Type: application/json' -d "$body" \
      "${PIN_ENDPOINT}${path}"
  else
    curl -sf --max-time 60 -K "$CURL_CFG" -X "$method" "${PIN_ENDPOINT}${path}"
  fi
}

count_for() { # count_for <cid> <statuses>
  api GET "/pins?cid=$1&status=$2&limit=1" | python3 -c '
import json, sys
print(json.load(sys.stdin).get("count", 0))
' 2>/dev/null || echo "ERR"
}

echo "==> Mirroring ${#CIDS[@]} CIDs to ${PIN_ENDPOINT} (pin-by-CID)"
echo

PENDING=()
for i in "${!CIDS[@]}"; do
  cid="${CIDS[$i]}"; name="${NAMES[$i]}"
  n="$(count_for "$cid" "queued,pinning,pinned")"
  if [ "$n" = "ERR" ]; then
    echo "  ✗ ${name}: status check failed (endpoint/token?)"; exit 1
  fi
  if [ "$n" != "0" ]; then
    if [ "$(count_for "$cid" pinned)" != "0" ]; then
      echo "  ✓ ${name}: already pinned"
    else
      echo "  … ${name}: already queued/pinning"
      PENDING+=("$cid|$name")
    fi
    continue
  fi
  body="$(python3 -c 'import json,sys; print(json.dumps({"cid": sys.argv[1], "name": sys.argv[2]}))' "$cid" "$name")"
  if api POST "/pins" "$body" >/dev/null; then
    echo "  + ${name}: pin requested"
    PENDING+=("$cid|$name")
  else
    echo "  ✗ ${name}: pin request failed"
  fi
done

if [ "${#PENDING[@]}" -eq 0 ]; then
  echo
  echo "==> Nothing pending — all CIDs pinned."
  exit 0
fi

echo
echo "==> Waiting for ${#PENDING[@]} pins (provider fetches content from the"
echo "    network; large artifacts can take many minutes)…"
START="$(date +%s)"
while [ "${#PENDING[@]}" -gt 0 ]; do
  if [ $(( $(date +%s) - START )) -gt "$POLL_TIMEOUT" ]; then
    echo
    echo "==> Timed out after ${POLL_TIMEOUT}s with ${#PENDING[@]} still pending."
    echo "    Pin requests stay queued provider-side; re-run later to re-check."
    for p in "${PENDING[@]}"; do echo "      … ${p#*|}"; done
    exit 1
  fi
  sleep "$POLL_INTERVAL"
  STILL=()
  for p in "${PENDING[@]}"; do
    cid="${p%%|*}"; name="${p#*|}"
    if [ "$(count_for "$cid" pinned)" != "0" ]; then
      echo "  ✓ ${name}: pinned"
    elif [ "$(count_for "$cid" failed)" != "0" ] && [ "$(count_for "$cid" "queued,pinning")" = "0" ]; then
      echo "  ✗ ${name}: provider reports failed — re-run to retry"
    else
      STILL+=("$p")
    fi
  done
  PENDING=("${STILL[@]+"${STILL[@]}"}")
done

echo
echo "==> All CIDs pinned on ${PIN_ENDPOINT}."
