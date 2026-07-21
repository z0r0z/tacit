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
# release fails the build. bitcoin_prove (reflection) added to the release when rebuilt — until
# then the reflection cron needs it staged separately; the settle crons work with these five.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG PROVER_RELEASE=prover-bins-v1
ARG PROVER_REPO=z0r0z/tacit
COPY prover/bin/SHA256SUMS /app/prover/bin/SHA256SUMS
RUN cd /app/prover/bin \
 && for b in exec-wrap exec-prove exec-swap exec-unwrap exec-lp exec-lpremove exec-wraptransfer exec-sendunwrap exec-otc exec-route exec-bid exec-bridgeburn exec-bridgemint exec-cbtcmint exec-cdpmint exec-cdpclose bitcoin_prove; do curl -fsSL -o "$b" "https://github.com/${PROVER_REPO}/releases/download/${PROVER_RELEASE}/$b"; done \
 && sha256sum -c SHA256SUMS \
 && chmod +x exec-* bitcoin_prove

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src/ ./src/

# Default command is overridden per-service by render.yaml (dockerCommand).
CMD ["node", "src/reflection-folder.js"]
