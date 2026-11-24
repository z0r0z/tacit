#!/bin/sh
# Release binaries of tacit-ceremony, reproducible: the same commit built with this script gives the same SHA-256s.
#
#   ./release.sh              -> dist/tacit-ceremony-<os>-<arch>[.exe] and dist/SHA256SUMS
#
# Go 1.27.4 exactly (GOTOOLCHAIN fetches it if the local go is another version), no cgo, -trimpath, no build id, and
# a clean tree (the commit is stamped into the binary; `tacit-ceremony version` prints it).
set -eu
GO_VERSION=go1.27.4
TARGETS="darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64"

cd "$(dirname "$0")"
if [ -n "$(git status --porcelain -- .)" ] && [ "${ALLOW_DIRTY:-}" != 1 ]; then
  echo "ceremony-phase2 has uncommitted changes; commit them first" >&2
  exit 1
fi
OUT=${OUT:-dist}
rm -rf "$OUT"
mkdir -p "$OUT"
export GOTOOLCHAIN=$GO_VERSION CGO_ENABLED=0 GOFLAGS=-mod=readonly
echo "$(go version), commit $(git rev-parse HEAD)"
for t in $TARGETS; do
  os=${t%/*}
  arch=${t#*/}
  ext=
  [ "$os" = windows ] && ext=.exe
  GOOS=$os GOARCH=$arch go build -trimpath -buildvcs=true -ldflags="-s -w -buildid=" \
    -o "$OUT/tacit-ceremony-$os-$arch$ext" ./cmd/tacit-ceremony
  echo "built $OUT/tacit-ceremony-$os-$arch$ext"
done
cd "$OUT"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum tacit-ceremony-* > SHA256SUMS
else
  shasum -a 256 tacit-ceremony-* > SHA256SUMS
fi
cat SHA256SUMS
