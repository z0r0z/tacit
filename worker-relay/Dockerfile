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

# Prover binaries: either COPY --from=prover, or ship prebuilt artifacts committed/uploaded
# under ./prover/bin (bitcoin_prove, exec). The latter is the recommended path — build them
# once in CI on a machine with the SP1 toolchain + guest ELFs, publish as a release artifact.
COPY prover/ /app/prover/
RUN chmod +x /app/prover/bin/* || true

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src/ ./src/

# Default command is overridden per-service by render.yaml (dockerCommand).
CMD ["node", "src/reflection-folder.js"]
