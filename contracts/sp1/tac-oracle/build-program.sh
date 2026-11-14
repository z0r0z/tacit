#!/bin/bash
set -euo pipefail

# Reproducibly (re)build the TacProvenOracle program and print the key a TacProvenOracle is deployed with.
#
# A plain `cargo prove build` embeds host paths, so its ELF (and verification key) differ from machine to machine;
# `cargo prove build --docker` builds in SP1's fixed-path container and gives the same bytes anywhere. The ELF is
# committed at contracts/sp1/tac-oracle/elf/tac_oracle and pinned in elf-vkey-pin.json with its key: a prover proves
# with the committed ELF, and the oracle accepts proofs of exactly that program.
#
# Requires Docker and sp1up (cargo-prove). The key comes from tac-oracle-host (built against sp1-sdk 6.2.3).

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/program"
echo "Building the program reproducibly (cargo prove build --docker, SP1 image v6.2.2, linux/amd64)..."
DOCKER_DEFAULT_PLATFORM=linux/amd64 cargo prove build --docker --tag v6.2.2

# cargo-prove writes the ELF under target/elf-compilation (or elf/ in some versions): take the one this build wrote.
ELF=$(find elf target -type f -name tac_oracle -newer Cargo.toml 2>/dev/null | head -1)
[ -n "$ELF" ] || { echo "no tac_oracle ELF was built"; exit 1; }
mkdir -p "$HERE/elf"
cp "$ELF" "$HERE/elf/tac_oracle"
SHA=$(shasum -a 256 "$HERE/elf/tac_oracle" | awk '{print $1}')
VKEY=$("$HERE/host/target/release/tac-oracle-host" vkey --elf "$HERE/elf/tac_oracle" | tail -1)
cat > "$HERE/elf-vkey-pin.json" <<EOF
{
  "_comment": "The committed TacProvenOracle program and the verification key a TacProvenOracle is deployed with (PROGRAM_VKEY). A program change rebuilds both with build-program.sh in the same commit; an oracle deployed with an older key keeps accepting only the older program's proofs.",
  "elf_sha256": "$SHA",
  "program_vkey": "$VKEY"
}
EOF
echo ""
echo "elf:          contracts/sp1/tac-oracle/elf/tac_oracle"
echo "  sha256:     $SHA"
echo "PROGRAM_VKEY: $VKEY"
