#!/bin/bash
set -euo pipefail

# Reproducibly (re)build the canonical tETH guest ELF.
#
# SP1 guest builds embed absolute host paths, so a plain `cargo prove build`
# yields a different ELF — and program verification key — on every machine. That
# breaks a permissionless prover: each operator would derive a vkey the on-chain
# verifier rejects. `cargo prove build --docker` builds in a fixed-path container,
# producing a byte-identical ELF (and vkey) anywhere.
#
# The resulting ELF is committed at contracts/sp1/program/elf/teth-pool-prover and
# embedded by the prover host (see contracts/sp1/script/src/main.rs), so operators
# never rebuild the guest — they embed the committed canonical bytes.
#
# Requires: Docker + sp1up (cargo-prove). Run when the guest source changes.
# If the printed vkey differs from the deployed SP1PoolRootVerifier, redeploy the
# verifier with the new vkey and commit the updated ELF together.

cd "$(dirname "$0")/program"
echo "Building guest reproducibly (cargo prove build --docker)..."
cargo prove build --docker

ELF=target/elf-compilation/riscv64im-succinct-zkvm-elf/release/teth-pool-prover
mkdir -p elf
cp "$ELF" elf/teth-pool-prover
SHA=$(shasum -a 256 elf/teth-pool-prover 2>/dev/null | awk '{print $1}' || sha256sum elf/teth-pool-prover | awk '{print $1}')
echo ""
echo "Canonical ELF -> contracts/sp1/program/elf/teth-pool-prover"
echo "  sha256:       $SHA"
echo "  PROGRAM_VKEY: $(cargo prove vkey --elf elf/teth-pool-prover | tail -1)"
echo ""
echo "Commit the ELF; deploy SP1PoolRootVerifier with the PROGRAM_VKEY above."
