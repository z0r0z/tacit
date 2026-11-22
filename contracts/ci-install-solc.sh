#!/usr/bin/env bash
# CI helper. The pinned foundry release only knows the solc versions that existed when it was built, and the contracts name
# newer ones (0.8.36, 0.8.37). This puts the official builds where foundry keeps the compilers it has installed, each checked
# against the sha256 in the official list.
#   bash contracts/ci-install-solc.sh 0.8.36 0.8.37
# SOLC_PLATFORM names the official list to read (default linux-amd64).
set -euo pipefail

VERSIONS=("$@")
[ ${#VERSIONS[@]} -gt 0 ] || VERSIONS=(0.8.36 0.8.37)
PLATFORM=${SOLC_PLATFORM:-linux-amd64}
BASE=https://binaries.soliditylang.org/$PLATFORM
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

sha256_ok() { # sha256_ok <hex> <file>
  if command -v sha256sum >/dev/null 2>&1; then echo "$1  $2" | sha256sum -c - >/dev/null
  else echo "$1  $2" | shasum -a 256 -c - >/dev/null; fi
}

# Let foundry install one compiler it does know: that creates its compiler directory, and the new ones go beside it.
mkdir -p "$WORK/probe/src"
printf 'pragma solidity =0.8.20;\ncontract Probe {}\n' > "$WORK/probe/src/Probe.sol"
printf '[profile.default]\nsrc = "src"\nout = "out"\nlibs = []\n' > "$WORK/probe/foundry.toml"
forge build --root "$WORK/probe" >/dev/null
DIR=$(find "$HOME" -type d -path '*svm/0.8.20' -print -quit)
[ -n "$DIR" ] || { echo "foundry's compiler directory was not found" >&2; exit 1; }
SVM=$(dirname "$DIR")

LIST=$(curl -fsSL "$BASE/list.json")
for V in "${VERSIONS[@]}"; do
  FILE=$(jq -r --arg v "$V" '.releases[$v] // empty' <<<"$LIST")
  SHA=$(jq -r --arg v "$V" '[.builds[] | select(.version == $v)][0].sha256 // empty' <<<"$LIST")
  { [ -n "$FILE" ] && [ -n "$SHA" ]; } || { echo "solc $V is not in the official $PLATFORM list" >&2; exit 1; }
  curl -fsSL "$BASE/$FILE" -o "$WORK/solc-$V"
  sha256_ok "${SHA#0x}" "$WORK/solc-$V" || { echo "solc $V does not match its published sha256" >&2; exit 1; }
  mkdir -p "$SVM/$V"
  install -m 755 "$WORK/solc-$V" "$SVM/$V/solc-$V"
  echo "installed solc $V in $SVM"
done
