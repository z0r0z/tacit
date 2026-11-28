#!/usr/bin/env bash
# A throwaway checkout to run historical tests in. Never touches SRC's working tree: it shares SRC's objects
# (no copy of the history) and checks out into DEST.
#
#   bash tools/yardstick/clone.sh /path/to/tacit /tmp/ys/repo
#
# The big binary folders the node tests never read are left out; SRC's node_modules are linked in rather than
# reinstalled. Delete DEST when done (rm -rf DEST); nothing outside it is changed.
set -euo pipefail
SRC=${1:?source repo}
DEST=${2:?destination}
git clone -q --shared --no-checkout "$SRC" "$DEST"
cd "$DEST"
git fetch -q "$SRC" refs/remotes/origin/main:refs/heads/ys-main
git sparse-checkout init --no-cone
printf '/*\n!/contracts/sp1/\n!/assets/\n!/airdrop/\n' | git sparse-checkout set --no-cone --stdin
git checkout -q --detach ys-main
for d in . tests worker worker-relay server; do
  if [ -d "$SRC/$d/node_modules" ]; then ln -sfn "$SRC/$d/node_modules" "$d/node_modules"; fi
done
echo "ready: $DEST at $(git rev-parse --short HEAD)"
