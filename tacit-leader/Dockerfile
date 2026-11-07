# The tacit chain's leader as one service: leader.mjs and the block node it runs (contracts/sp1/confidential/tacit-block/node), whose
# HTTP API (/spend, /notes, /path, /spent, /address, /state, …) is what wallets use. Built from the repository root (the root
# .dockerignore names everything copied here). The node reads its keys' artifacts from the source paths it was built at, so the runtime
# keeps that layout under /src. No database: on start the leader replays the chain from the landing contract's events into the node.
#
#   docker build -f tacit-leader/Dockerfile -t tacit-chain-leader .
#
# Env (see leader.mjs): RPC_URL, BLOCKS, FROM_BLOCK, LEADER_KEY, PROVER, TACIT_NODE_ADMIN, LEADER_CHAIN_SEED, ARCHIVE_DIR and
# TACIT_NODE_DIRECTORY (on a persistent disk), TACIT_NODE_TRUST_PROXY=1 behind Render's proxy. The node listens on Render's PORT.

FROM rust:1.95-bookworm AS node
WORKDIR /src
COPY contracts/sp1/confidential/btc-pool-halo2 contracts/sp1/confidential/btc-pool-halo2
COPY contracts/sp1/confidential/btc-pool-agg/common contracts/sp1/confidential/btc-pool-agg/common
COPY contracts/sp1/confidential/tacit-block/common contracts/sp1/confidential/tacit-block/common
COPY contracts/sp1/confidential/tacit-block/node contracts/sp1/confidential/tacit-block/node
COPY contracts/sp1/confidential/tacit-block/vendor contracts/sp1/confidential/tacit-block/vendor
COPY contracts/sp1/confidential/tacit-block/artifacts contracts/sp1/confidential/tacit-block/artifacts
RUN cd contracts/sp1/confidential/tacit-block/node && cargo build --release --locked

FROM node:20-bookworm-slim
WORKDIR /src
COPY --from=node /src/contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node contracts/sp1/confidential/tacit-block/node/target/release/tacit-block-node
COPY contracts/sp1/confidential/btc-pool-halo2/artifacts contracts/sp1/confidential/btc-pool-halo2/artifacts
COPY contracts/sp1/confidential/tacit-block/artifacts contracts/sp1/confidential/tacit-block/artifacts
COPY dapp/*.js dapp/
COPY dapp/vendor/*.js dapp/vendor/
COPY tacit-leader tacit-leader
ENV TACIT_NODE_TRUST_PROXY=1
# the node serves on Render's port; the leader reaches it there too
CMD ["sh", "-c", "NODE_ADDR=0.0.0.0:${PORT:-10000} exec node tacit-leader/leader.mjs"]
