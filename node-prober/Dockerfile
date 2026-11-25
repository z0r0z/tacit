# node-prober: probes registered community nodes, signs the results, serves the signed list and status. No dependencies beyond Node and the
# dapp's own vendored crypto bundle. Build context is the repo root:
#   docker build -f node-prober/Dockerfile .
#   docker run -p 10000:10000 -e PROBER_KEY=<32-byte hex> -v prober:/data -e STATE_PATH=/data/state.json <image>
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY dapp/package.json /app/dapp/package.json
COPY dapp/vendor/tacit-deps.min.js /app/dapp/vendor/tacit-deps.min.js
COPY dapp/bulletproofs.js dapp/bulletproofs-plus.js dapp/nodes-list.js /app/dapp/
COPY node-prober/src /app/node-prober/src
RUN node -e "import('/app/node-prober/src/service.mjs').then((m) => { if (typeof m.makeService !== 'function') process.exit(1); console.log('node-prober ok'); })"
ENV NODE_ENV=production PORT=10000 POINTS_ENABLED=0
EXPOSE 10000
USER node
CMD ["node", "node-prober/src/index.mjs"]
