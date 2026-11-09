# The Tacit chain bot (tacit-bot/bot.mjs) as a Render background worker. Built from the repository root (the root .dockerignore names
# everything copied here). Node only: the Halo2 prover is the app's wasm, so no Rust build.
#
#   docker build -f tacit-bot/Dockerfile -t tacit-chain-bot .
#
# Env (see bot.mjs): BOT_SEED (secret), BOT_STATE_DIR on a persistent disk, RPC_URL, PORT (health), BOT_* limits.
FROM node:20-bookworm-slim
WORKDIR /src
COPY dapp/package.json dapp/
COPY dapp/*.js dapp/
COPY dapp/vendor/*.js dapp/vendor/
COPY dapp/trade/rpc.js dapp/trade/
COPY dapp/btc-pool/pin.json dapp/btc-pool/vk.bin dapp/btc-pool/params-k13.bin dapp/btc-pool/btc_pool_halo2.js dapp/btc-pool/btc_pool_halo2_bg.wasm dapp/btc-pool/
COPY tacit-bot tacit-bot
ENV BOT_STATE_DIR=/data
CMD ["node", "tacit-bot/bot.mjs", "run"]
