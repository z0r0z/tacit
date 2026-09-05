# Render image for the Tacit relay backbone.
#
# Two stages:
#   1. prover — build the SP1 network-prove binaries (bitcoin_prove, exec) from the repo.
#      These are patched to .network(), so the RUNTIME needs NO GPU — only SP1_PROVER=network
#      + a funded NETWORK_PRIVATE_KEY. Building them here bakes the exact vkeys into the image.
#   2. runtime — Node 20 + the built binaries + this worker's JS.
#
# NOTE: the SP1 guest ELFs are include_bytes!'d into the binaries at build time (see
# bitcoin_prove.rs / the harness bins). The build context must include the guest ELF paths
# those bins reference, or pre-build the binaries out-of-band and COPY them in (fallback below).

# ── Stage 1: build the prover binaries ───────────────────────────────────────
# Prefer building in CI where the SP1 toolchain + guest ELFs are already staged, then
# COPY the artifacts in. If you build here, install the SP1 toolchain first.
FROM rust:1.81-bookworm AS prover
WORKDIR /build
# TODO: copy the prover-host + confidential harness sources + prebuilt guest ELFs, then:
#   RUN curl -L https://sp1.succinct.xyz | bash && ~/.sp1/bin/sp1up
#   RUN cd eth-reflection/prover-host && cargo build --release --bin bitcoin_prove
#   RUN cd confidential/harnesses     && cargo build --release --bin exec
# For now this stage is a placeholder; the runtime COPY below falls back to ./prover/bin
# which you populate from a CI build artifact (recommended — keeps the Render build fast).

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# Prover binaries: FETCHED from a public GitHub release at build time (public repo → no Git-LFS
# bandwidth cost, no 135MB in git history). The committed SHA256SUMS pins them, so a tampered
# release fails the build. bitcoin_prove (reflection) ships in the release too, so nothing needs
# staging separately.
#
# The pinned hashes are the second line of defence, not the first: what actually matters is which
# guest ELF each exec-* embeds, because the pool verifies one immutable program_vkey. v4 shipped
# binaries built against a superseded guest — they proved happily and were rejected on-chain, with
# nothing in the logs to say why. Set EXPECT_VKEY on the settle services so a drifted binary fails
# closed at run time, and note the harness crate's build.rs refuses to compile against an
# unpinned guest. Rotating the guest means bumping SHA256SUMS, this release tag, and the on-chain
# program_vkey together.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG PROVER_RELEASE=prover-bins-v6
ARG PROVER_REPO=z0r0z/tacit
COPY prover/bin/SHA256SUMS /app/prover/bin/SHA256SUMS
RUN cd /app/prover/bin \
 && for b in exec-wrap exec-prove exec-batchtransfer exec-wraplp exec-wrapswap exec-swap exec-unwrap exec-lp exec-lpremove exec-wraptransfer exec-sendunwrap exec-otc exec-route exec-bid exec-bridgeburn exec-bridgemint exec-cbtcmint exec-cdpmint exec-cdpclose exec-stealthlock exec-stealthclaim exec-stealthrefund exec-stealthlockbatch exec-bridgestealthmint bitcoin_prove; do curl -fsSL -o "$b" "https://github.com/${PROVER_REPO}/releases/download/${PROVER_RELEASE}/$b"; done \
 && sha256sum -c SHA256SUMS \
 && chmod +x exec-* bitcoin_prove

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src/ ./src/

# Default command is overridden per-service by render.yaml (dockerCommand).
CMD ["node", "src/reflection-folder.js"]
