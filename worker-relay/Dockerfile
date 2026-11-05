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
# bitcoin_prove from v14: v12's (v8's with REFLECT_MAX_PRICE_PER_PGU read) with the stdin mode the prover board's lane uses
# (lib/btc-board.js) and BITCOIN_PROVE_MODES, built by build-reflection-prover (run 42098370134) from the same pinned guests and checked to
# execute the reflection fixture exactly as v12's does. The relay asks the binary which modes it has before it uses the board.
ARG PROVER_REFLECT_RELEASE=prover-bins-v14
# eth_prove from its own release: v13, built by build-eth-prover (run 40340478253), with the stdin and finish modes the prover board's
# lane uses (lib/eth-board.js): checked against the network's proof of request 0x9e732826 and against v8's eth_prove on live data (same
# input, same public values). This tag and eth_prove's line in SHA256SUMS move together. The relay asks the binary which
# modes it has before it uses the board (one without them keeps to the network lane).
ARG PROVER_ETH_RELEASE=prover-bins-v13
# Every exec-* comes from v11: the same pinned guest, built so a network request carries its input as a private artifact
# when PRIVATE_STDIN=1 is set and goes only to the provers PROVER_WHITELIST names (with neither set it behaves as v8/v9).
# The reflection provers (public chain data) come from the two releases above.
ARG PROVER_EXEC_RELEASE=prover-bins-v11
ARG PROVER_REPO=z0r0z/tacit
COPY prover/bin/SHA256SUMS /app/prover/bin/SHA256SUMS
RUN cd /app/prover/bin \
 && for b in exec-wrap exec-prove exec-batchtransfer exec-wraplp exec-wrapswap exec-swap exec-unwrap exec-lp exec-lpremove exec-wraptransfer exec-sendunwrap exec-otc exec-route exec-bid exec-bridgeburn exec-bridgemint exec-cbtcmint exec-cdpmint exec-cdpclose exec-stealthlock exec-stealthclaim exec-stealthrefund exec-stealthlockbatch exec-bridgestealthmint exec-farmbond exec-farmharvest exec-farmunbond exec-adaptorlock exec-adaptorclaim exec-adaptorrefund exec-cdpliquidate exec-cdptopup exec-lpbond exec-wrapcdpmint exec-fastlane exec-crosslane exec-balance; do curl -fsSL -o "$b" "https://github.com/${PROVER_REPO}/releases/download/${PROVER_EXEC_RELEASE}/$b"; done \
 && curl -fsSL -o eth_prove "https://github.com/${PROVER_REPO}/releases/download/${PROVER_ETH_RELEASE}/eth_prove" \
 && curl -fsSL -o bitcoin_prove "https://github.com/${PROVER_REPO}/releases/download/${PROVER_REFLECT_RELEASE}/bitcoin_prove" \
 && sha256sum -c SHA256SUMS \
 && chmod +x exec-* bitcoin_prove eth_prove

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3

COPY src/ ./src/

# Default command is overridden per-service by render.yaml (dockerCommand).
CMD ["node", "src/reflection-folder.js"]
