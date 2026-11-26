#!/usr/bin/env bash
# Pin the finalized bundle ($OUT/final, written by finalize.sh) under the same CIDs everywhere: the local Kubo
# node, Filebase, and optionally a remote Kubo node. Each copy is checked to report the bundle's root CID.
#
#   bash pin-final.sh                       # needs a running local Kubo daemon
#
# Env: REMOTE_IPFS_API (optional: a remote Kubo /api/v0 to pin on too) with REMOTE_IPFS_TOKEN or the keychain item
# tacit-ipfs-api-token; FILEBASE_BUCKET (default tacit) with FILEBASE_KEY / FILEBASE_SECRET or the keychain items
# tacit-filebase-key / tacit-filebase-secret. SKIP_REMOTE=1 or SKIP_FILEBASE=1 leave a target out.
set -euo pipefail
source "$(dirname "$0")/ceremony-env.sh"

REMOTE_IPFS_API=${REMOTE_IPFS_API:-}
FILEBASE_BUCKET=${FILEBASE_BUCKET:-tacit}
keychain() { security find-generic-password -s "$1" -w 2>/dev/null | tr -d '\n' || true; }

command -v ipfs >/dev/null 2>&1 || die "needs the ipfs CLI and a running local daemon"
ipfs id >/dev/null 2>&1 || die "the local Kubo daemon is not running"
[ -f "$FINAL/pin.json" ] || die "$FINAL/pin.json not found; run finalize.sh first"

echo "==> [1/3] Local Kubo"
ROOT=$(ipfs add -r -Q --cid-version 1 --pin "$FINAL")
echo "    bundle $ROOT"
zf_cid=$(ipfs add -Q --cid-version 1 --only-hash "$FINAL/transact_final.zkey")
want_zf=$(jq -r .zkey_cid "$FINAL/pin.json")
[ "$zf_cid" = "$want_zf" ] || die "transact_final.zkey is $zf_cid here, pin.json says $want_zf"
for f in transact_final.zkey transact_vk.json transact.wasm pin.json; do
  echo "    $f $(ipfs add -Q --cid-version 1 --only-hash "$FINAL/$f")"
done

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
ipfs dag export "$ROOT" > "$TMP/bundle.car"

if [ "${SKIP_REMOTE:-0}" != 1 ] && [ -n "$REMOTE_IPFS_API" ]; then
  echo "==> [2/3] Remote node"
  TOKEN=${REMOTE_IPFS_TOKEN:-$(keychain tacit-ipfs-api-token)}
  [ -n "$TOKEN" ] || die "no REMOTE_IPFS_TOKEN (keychain tacit-ipfs-api-token)"
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$TMP/remote.cfg"; chmod 600 "$TMP/remote.cfg"
  out=$(curl -sf --max-time 900 -K "$TMP/remote.cfg" -X POST -F "file=@$TMP/bundle.car" "$REMOTE_IPFS_API/dag/import?pin-roots=true") \
    || die "remote node dag/import failed"
  got=$(printf '%s' "$out" | jq -r 'select(.Root) | .Root.Cid["/"]' | head -1)
  [ "$got" = "$ROOT" ] || die "remote node imported $got, expected $ROOT"
  echo "    pinned $got"
fi

if [ "${SKIP_FILEBASE:-0}" != 1 ]; then
  echo "==> [3/3] Filebase"
  FB_KEY=${FILEBASE_KEY:-$(keychain tacit-filebase-key)}
  FB_SECRET=${FILEBASE_SECRET:-$(keychain tacit-filebase-secret)}
  [ -n "$FB_KEY" ] && [ -n "$FB_SECRET" ] || die "no Filebase credentials (keychain tacit-filebase-key / tacit-filebase-secret)"
  printf 'user = "%s:%s"\naws-sigv4 = "aws:amz:us-east-1:s3"\n' "$FB_KEY" "$FB_SECRET" > "$TMP/fb.cfg"; chmod 600 "$TMP/fb.cfg"
  unset FB_KEY FB_SECRET
  got=$(curl -sf --max-time 1800 -K "$TMP/fb.cfg" -X PUT -T "$TMP/bundle.car" -H 'x-amz-meta-import: car' \
      "https://s3.filebase.com/$FILEBASE_BUCKET/evm-pool-transact-final-$ROOT.car" -D - -o /dev/null \
    | tr -d '\r' | awk 'tolower($1)=="x-amz-meta-cid:"{print $2}') || die "Filebase upload failed"
  [ "$got" = "$ROOT" ] || die "Filebase imported ${got:-nothing}, expected $ROOT"
  echo "    pinned $got"
fi

echo
echo "Bundle $ROOT pinned. Final zkey $zf_cid; seal the chain with it (finalize.sh step 2)."
