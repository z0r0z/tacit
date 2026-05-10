#!/usr/bin/env bash
# pin-bundle.sh — Pin the ceremony-bundle/ directory to IPFS via Pinata
# and return the directory CID.
#
# This is a one-shot operator tool. The ceremony bundle is produced by
# finalize.sh as a local directory (~39 MB for tacit's mixer); Pinata
# needs the whole directory uploaded as one IPFS dir so it gets one
# auditor-friendly CID that resolves to the full set.
#
# Security pattern matches finalize.sh:
#   - JWT read silently (no terminal echo, no shell history)
#   - JWT never in argv (curl --config tempfile, mode 0600)
#   - JWT scrubbed from environment before any child process
#   - Tempfile removed via trap on EXIT
#
# Usage:
#   cd dapp/circuits
#   ./pin-bundle.sh                    # pins ceremony-bundle/
#   ./pin-bundle.sh path/to/dir        # pins a different directory
#   PINATA_JWT=... ./pin-bundle.sh     # JWT from env (skips prompt)

set -euo pipefail

BUNDLE_DIR="${1:-ceremony-bundle}"

if [ ! -d "$BUNDLE_DIR" ]; then
  echo "✗ $BUNDLE_DIR/ not found."
  echo "  Run this from dapp/circuits/ after finalize.sh has produced the bundle,"
  echo "  or pass the bundle path: ./pin-bundle.sh path/to/bundle"
  exit 1
fi

# Strip trailing slash from BUNDLE_DIR for consistent filepath construction.
# `find ceremony-bundle/ -type f` and `find ceremony-bundle -type f` emit
# the same paths, but we'll use the trimmed form for display + multipart
# filename construction below.
BUNDLE_DIR="${BUNDLE_DIR%/}"

# Dependency preflight
for cmd in curl python3 mktemp find xargs printf; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "✗ missing: $cmd"; exit 1
  fi
done

echo "==> Pinning $BUNDLE_DIR/ to IPFS via Pinata"
echo

# Enumerate files. Show user what's about to be uploaded so they can
# verify the bundle is what they expect before paying for storage.
FILES=()
TOTAL_BYTES=0
while IFS= read -r f; do
  FILES+=("$f")
  sz=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
  TOTAL_BYTES=$((TOTAL_BYTES + sz))
  printf "  %-50s %10d bytes\n" "$f" "$sz"
done < <(find "$BUNDLE_DIR" -type f | sort)
TOTAL_MB=$((TOTAL_BYTES / 1048576))
echo
echo "  Total: ${#FILES[@]} files, ~${TOTAL_MB} MB"
echo

# JWT via silent read (or env)
if [ -z "${PINATA_JWT:-}" ]; then
  printf "Paste PINATA_JWT (silent, won't echo): "
  IFS= read -rs PINATA_JWT || true
  echo
fi
if [ -z "${PINATA_JWT:-}" ]; then
  echo "no JWT provided"; exit 1
fi
# Strip any whitespace the paste may have introduced. JWTs are base64url
# segments separated by dots: [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+
# Any whitespace is a paste artifact.
PINATA_JWT="$(printf '%s' "$PINATA_JWT" | xargs)"
# Sanity-check JWT shape (3 dot-separated segments). Don't reveal the
# value in the error message.
if ! [[ "$PINATA_JWT" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]; then
  echo "✗ JWT doesn't look right (expected: 3 dot-separated base64url segments)"
  exit 1
fi
# Scrub from process environment so child processes don't inherit
export -n PINATA_JWT 2>/dev/null || true

# Write JWT to mode-0600 tempfile for curl --config; keeps it out of
# argv and process listings. Trap on EXIT removes it whether the
# script succeeds, errors, or is Ctrl-C'd.
CURL_CONFIG=$(mktemp -t tacit-pinata-XXXXXX)
chmod 600 "$CURL_CONFIG"
trap 'rm -f "$CURL_CONFIG"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$PINATA_JWT" > "$CURL_CONFIG"
# Now clear from shell variable too — file is the only copy until upload
PINATA_JWT=""
unset PINATA_JWT

# Confirm before upload (Pinata counts against your account quota).
printf "Proceed with upload? [y/N] "
read -r CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "aborted by user"
  exit 0
fi

# Build multipart args. Pinata pins multiple files as a single IPFS
# directory when each file's multipart "filename" includes the
# directory path. curl's `-F "file=@local_path;filename=remote_name"`
# syntax sets that filename in the Content-Disposition header.
ARGS=()
for f in "${FILES[@]}"; do
  ARGS+=(-F "file=@$f;filename=$f")
done
# CID v1 (modern base32 multihash) — matches the rest of tacit's CIDs.
ARGS+=(-F 'pinataOptions={"cidVersion":1}')
# Name the pin for your Pinata dashboard so it's findable later.
ARGS+=(-F "pinataMetadata={\"name\":\"tacit-ceremony-$(date -u +%Y%m%dT%H%M%SZ)\"}")

echo
echo "==> Uploading to Pinata (this may take 1-3 min for ~${TOTAL_MB} MB)…"
RESP_FILE=$(mktemp -t tacit-pinata-resp-XXXXXX)
trap 'rm -f "$CURL_CONFIG" "$RESP_FILE"' EXIT

HTTP_CODE=$(curl -s --max-time 900 --config "$CURL_CONFIG" \
  -o "$RESP_FILE" -w "%{http_code}" \
  -X POST https://api.pinata.cloud/pinning/pinFileToIPFS \
  "${ARGS[@]}" || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
  echo "✗ Pinata returned HTTP $HTTP_CODE"
  echo "  Response (first 500 bytes):"
  head -c 500 "$RESP_FILE" | sed 's/^/    /'
  echo
  exit 1
fi

CID=$(python3 -c "import sys,json; print(json.load(open(sys.argv[1])).get('IpfsHash',''))" "$RESP_FILE")
SIZE=$(python3 -c "import sys,json; print(json.load(open(sys.argv[1])).get('PinSize',''))" "$RESP_FILE")

if [ -z "$CID" ]; then
  echo "✗ Pinata returned 200 but no IpfsHash field:"
  head -c 500 "$RESP_FILE" | sed 's/^/    /'
  exit 1
fi

echo
echo "================================================================"
echo "  ✓ Ceremony bundle pinned to IPFS"
echo "================================================================"
echo
echo "  Directory CID:    $CID"
echo "  Pinata pin size:  $SIZE bytes"
echo
echo "  Gateways:"
echo "    https://gateway.pinata.cloud/ipfs/$CID/"
echo "    https://ipfs.io/ipfs/$CID/"
echo "    https://${CID}.ipfs.dweb.link/"
echo
echo "  Paste this CID into the dapp's 'Ceremony CID' field:"
echo
echo "    $CID"
echo
