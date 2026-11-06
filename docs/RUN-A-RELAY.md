# Running a relay

A relay takes a private action from a page, proves it, and sends the proof to the pool. Anyone can run one.
`ConfidentialPool.settle` is open to any account, and the pool pays every fee bound in the proof to the
account that sends it (`msg.sender`). A relay never holds user funds or spending keys. It can decline a job,
but it cannot change or redirect one: the proof fixes what happens.

tacit.finance tries Tacit's relay first. While that relay is not proving and sending, it gives new jobs to
the first listed relay that is (`relays` in [`dapp/confidential-deployments.js`](../dapp/confidential-deployments.js)).
A job a relay took is followed on that relay until it lands.

If you only want to send proofs that are already made, you do not need any of this: see
[OPEN-RELAYER.md](./OPEN-RELAYER.md).

## What you need

- A server for the API (Node 20). Postgres is optional: without `DATABASE_URL` the queue lives in memory and is lost on restart.
- A second process for the settle relay (`worker-relay/`, Docker, about 2 GB of memory).
- An Ethereum RPC.
- A relayer key: an EOA holding ETH for gas. It receives the relay fees.
- A Succinct prover network key with PROVE deposited ([OPEN-RELAYER.md](./OPEN-RELAYER.md#proving-with-your-own-prover-account)
  shows how to fund one). The settle relay proves on the network, so no GPU is needed.
- An https address for the API.

## 1. The API

```sh
npm ci && (cd server && npm ci)
CONFIDENTIAL_SETTLE=1 \
CONFIDENTIAL_BOX_TOKEN=<a long random string> \
PROVER_HEARTBEAT_TOKEN=<another long random string> \
DATABASE_URL=postgres://… \
PORT=8787 node server/index.mjs
```

- `CONFIDENTIAL_SETTLE=1` turns on the relay routes (`/confidential/submit`, `status`, `relay`, `open`, `landed`, `quote`).
- The two tokens are shared with the settle relay in step 2. The first gates the routes it takes jobs from. The second lets it
  report that it is up, which is what `/confidential/relay` reads.
- `CRON_DISABLED=1` leaves the API's own chain scans off. The relay routes answer without them.
- Behind a reverse proxy, set `TRUST_PROXY=1`.
- The API answers pages from the origins in `ALLOWED_ORIGINS`. Its default (`worker/wrangler.toml`) already includes tacit.finance.

[`server/README.md`](../server/README.md) covers memory limits and health checks.

## 2. The settle relay

```sh
cd worker-relay && docker build -t tacit-relay .
docker run --restart unless-stopped \
  -e WORKER_BASE=https://your-relay.example \
  -e BOX_TOKEN=<CONFIDENTIAL_BOX_TOKEN from step 1> \
  -e PROVER_HEARTBEAT_TOKEN=<the same as step 1> \
  -e RPC_URL=https://… \
  -e RELAY_KEY=0x… \
  -e NETWORK=mainnet -e CHAIN_ID=1 \
  -e POOL_ADDR=0x000000000Ed1eabD231Be41d93b719056F7febFC \
  -e SP1_PROVER=network -e NETWORK_RPC_URL=https://rpc.mainnet.succinct.xyz -e NETWORK_PRIVATE_KEY=0x… \
  -e EXPECT_VKEY=0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3 \
  -e EXEC_BIN=/app/prover/bin/exec \
  tacit-relay node src/settle-relay.js
```

- The image downloads the prover binaries and checks them against `prover/bin/SHA256SUMS`.
- `EXPECT_VKEY` stops the relay at startup if a binary would make proofs the pool refuses.
- The relay checks every job's fee before proving it, and simulates every settle before sending it.
- The fee it asks for is set by `MIN_FLOOR_USD`, `OPS_MARGIN` and `BPS_CAP`.

[`worker-relay/README.md`](../worker-relay/README.md) lists every setting, how the fee is worked out, and the loop the relay runs.

Once the relay is up, `GET https://your-relay.example/confidential/relay` answers `"state":"ok"`.

## 3. Listing it on tacit.finance

Open a pull request that:

- adds your API's origin (for example `https://your-relay.example`, with no path) to `relays` in
  `dapp/confidential-deployments.js`;
- adds the same origin to `connect-src` in the pages that talk to the relay. `node --test tests/relay-list.test.mjs`
  names any page that is missing it.

Any page or wallet built on the same files can list relays the same way.
