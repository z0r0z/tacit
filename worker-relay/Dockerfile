# Render image for the Tacit relay backbone.
#
# The SP1 prover binaries (exec-*, bitcoin_prove, eth_prove) are patched to .network(), so the
# runtime needs NO GPU — only SP1_PROVER=network + a funded NETWORK_PRIVATE_KEY. The guest ELFs are
# include_bytes!'d into them at build time, so each binary carries the program it proves.

# ── Stage 1: placeholder ─────────────────────────────────────────────────────
# The binaries are built out-of-band and fetched in the runtime stage. To build them here:
#   RUN curl -L https://sp1.succinct.xyz | bash && ~/.sp1/bin/sp1up
#   RUN cd eth-reflection/prover-host && cargo build --release --bin bitcoin_prove
#   RUN cd confidential/harnesses     && cargo build --release --bin exec
FROM rust:1.81-bookworm AS prover
WORKDIR /build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# Prover binaries: FETCHED from a public GitHub release at build time (public repo → no Git-LFS
# bandwidth cost, no 135MB in git history). The committed SHA256SUMS pins them, so a tampered
# release fails the build. bitcoin_prove (reflection) ships in the release too, so nothing needs
# staging separately.
#
# The pinned hashes are the second line of defence, not the first: what actually matters is which
# guest ELF each exec-* embeds, because the pool verifies one immutable program_vkey. A binary
# built against a different guest proves fine and is rejected on-chain. Set EXPECT_VKEY on the settle services so a drifted binary fails
# closed at run time, and note the harness crate's build.rs refuses to compile against an
# unpinned guest. Rotating the guest means bumping SHA256SUMS, this release tag, and the on-chain
# program_vkey together.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG PROVER_RELEASE=prover-bins-v8
ARG PROVER_REPO=z0r0z/tacit
COPY prover/bin/SHA256SUMS /app/prover/bin/SHA256SUMS
RUN cd /app/prover/bin \
 && for b in exec-wrap exec-prove exec-batchtransfer exec-wraplp exec-wrapswap exec-swap exec-unwrap exec-lp exec-lpremove exec-wraptransfer exec-sendunwrap exec-otc exec-route exec-bid exec-bridgeburn exec-bridgemint exec-cbtcmint exec-cdpmint exec-cdpclose exec-stealthlock exec-stealthclaim exec-stealthrefund exec-stealthlockbatch exec-bridgestealthmint exec-farmbond exec-farmharvest exec-farmunbond exec-adaptorlock exec-adaptorclaim exec-adaptorrefund exec-cdpliquidate exec-cdptopup exec-lpbond exec-wrapcdpmint bitcoin_prove eth_prove; do curl -fsSL -o "$b" "https://github.com/${PROVER_REPO}/releases/download/${PROVER_RELEASE}/$b"; done \
 && sha256sum -c SHA256SUMS \
 && chmod +x exec-* bitcoin_prove eth_prove

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src/ ./src/

# Default command is overridden per-service by render.yaml (dockerCommand).
CMD ["node", "src/reflection-folder.js"]
