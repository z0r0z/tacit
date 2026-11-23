# Our own Ethereum and Bitcoin nodes

Why: the site and its services read Ethereum through free public RPCs and Bitcoin through public explorers, none of which we control.
They rate-limit, drop connections, cap `eth_getLogs`, and refuse old `eth_getProof`. Running the nodes ourselves puts a reader we control
**in front of** those, so a public outage costs a fallback. Everything below
is built so that nothing depends on the new nodes: each consumer keeps its public fallbacks, and taking our nodes out is deleting one URL.

**Two profiles: light first, full where history is needed.**

- **Light** (`light/`, about a small machine's worth: 8+ cores, 16 GB RAM, 150 GB SSD; hours to sync Ethereum, a day or two for Bitcoin).
  Nethermind's light client (release 1.0.1, still experimental) verifies state itself over P2P and serves balances, `eth_call`,
  `eth_getProof` at the head, blocks, receipts and `eth_getLogs` in 512-block windows, in about 650 MB of RAM. It keeps no history:
  state is 32 blocks deep, logs 512 blocks per query. Bitcoin is a **pruned** bitcoind that validates the whole chain and serves the tip,
  headers, fee estimates, the mempool and broadcast; the gateway puts esplora-shaped paths on it for exactly those, answers 501 for the rest,
  and 503 while it is still syncing. What the light profile does NOT serve: the vault keeper's 8-hour-old `eth_getProof`, the pool/vault/cBTC
  history scans, and anything that needs an old Bitcoin transaction or an address's history. Those keep their current sources, or use the full profile.
- **Full** (the compose files below): a pruned reth (state history ~40 h, receipts from the pool's deploy block) with lighthouse, and an
  unpruned bitcoind with electrs. ~3.84 TB of NVMe per chain, a dedicated machine, and it serves everything the light profile cannot.

Both sit behind the same gateway and are judged by the same `tools/node-check.mjs` (`--light` and `--btc-pruned` score the light profile on what it
can honestly serve, and report the rest as NOT PROVIDED, never as a pass).

```
 browsers / our services ──https──▶ Caddy (TLS) ──▶ gateway.mjs ──▶ reth ◀── lighthouse        (Ethereum, /eth)
                                                       (read allowlists,       bitcoind ──▶ electrs (esplora, /btc/api/…)
                                                        CORS, budgets, no log)
```

## What is here

| file | what |
|---|---|
| `gateway.mjs` + `Dockerfile` | the only thing on the internet: read-method allowlist, CORS for tacit.finance, text/plain bodies, per-visitor budget, getLogs span cap, esplora read paths, **no access log**. Tests: `tests/own-node-gateway.test.mjs` |
| `light/` | the light profile for a host that cannot run Docker: unpacks the light client from the published image by digest (every layer hash-checked), installs the verified bitcoind, the gateway and supervisor config. Scripts 01–04, `onstart.sh` |
| `docker-compose.yml`, `reth.toml`, `Caddyfile`, `env.example` | reth + lighthouse (profile `eth`), bitcoind + electrs (profile `btc`), gateway, Caddy |
| `bitcoind/Dockerfile` | Bitcoin Core built from the release tarball; the build **fails** unless the sha256 matches and ≥5 builder signatures verify (the Docker Hub images are unofficial) |
| `bootstrap.sh` | fresh Ubuntu 24.04 → nodes syncing behind the gateway (Docker, firewall, secrets, directories) |
| `../tools/node-check.mjs` | the acceptance test: is this node fit for each job (below). Tests: `tests/node-check.test.mjs` |

## Hardware and cost (published figures, not ours: measure after sync)

- **Ethereum** (reth with this `reth.toml` + lighthouse): reth documents ≥1.2 TB for a full node; plan 1.5 TB with growth. Receipts are
  kept from the pool's deploy block (~10–15 GB) and state history for ~40 h (the keeper's 8 h plus room).
- **Bitcoin** (bitcoind unpruned + electrs): the esplora index alone is ~0.8 TB on top of the chain; one 2026 guide puts the total near
  2.5 TB. Plan 3 TB. (`electrs --lightmode` halves the index but needs `-txindex=1` and slower lookups: not used.)
- **Machine**: NVMe only, 64 GB RAM or more, 1 Gbit/s. Hetzner's AX102 (2 × 1.92 TB NVMe, 256 GB) lists around €107–124 a month plus a
  setup fee: one per chain, the two disks as one volume (chain data can be re-synced, so no mirror), or one machine with ≥6 TB NVMe.
  Check the provider's page when ordering. Not a metered or shared host: the sync moves hundreds of GB and the node has to stay up.
- **Time**: Ethereum is usable within hours once checkpoint-synced and caught up; Bitcoin takes days (bitcoind, then electrs).

## Light profile: what it serves and who may use it

| Consumer | Light profile | Why |
|---|---|---|
| Relays, keepers: latest-state reads, receipts, recent logs | yes, as an early fallback behind the primary | `eth-reads` PASS |
| Bitcoin lane's `eth_prove` proof at a recent block | yes (`eth-proofs-head`) | the beacon API is not fronted, so `SOURCE_CONSENSUS_RPC` stays public |
| Vault keeper's start check (proof ~8 h back) | **no** | state is 32 blocks deep |
| Pool / vault / cBTC history scans | **no** | logs are 512 blocks per query |
| Header relay (`tools/advance-header-relay.mjs --esplora`) | yes, once `btc-pruned-node` PASSES | tip, block-by-height and headers are exactly what it reads |
| Anything that looks up an old Bitcoin transaction or an address's history | **no** (501) | a pruned node has no index; never put the shim in a list used for that |
| Browsers | not yet | a container host gives plain HTTP on a mapped port; pages need an HTTPS hostname |

```
node tools/node-check.mjs --eth http://<host>:<port>/eth --light
node tools/node-check.mjs --btc-rpc http://tacit:<pass>@127.0.0.1:8332 --btc-pruned     # on the box, once bitcoind has caught up
```

Bring up on a Docker-less host: copy this directory to it and run `bash light/run-all.sh` as root (or the numbered scripts one at a time).
The light client's own trust assumption is a checkpoint from a provider (Sigma Prime by default) and the beacon light-client protocol: say
"checked against consensus from a checkpoint", not "trustless". Sends through it are not enabled (`INTERNAL_SENDS=0`): it relays to its P2P peers directly.

## Bring-up (full profile)

1. Order the machine(s), Ubuntu 24.04, SSH key only. One per chain, or both on one big machine.
2. One DNS A record per machine at the registrar (e.g. `node.tacit.finance`, or `eth-node.` / `btc-node.` with two machines).
3. `git clone` this repo on the machine, then: `cd own-nodes && bash bootstrap.sh` (or `bash bootstrap.sh eth` / `btc`). Set `NODE_HOST`
   in `.env` first if it is not `node.tacit.finance`. On a one-chain machine, empty the other `*_UPSTREAM` in `.env`.
4. Watch it: `docker compose logs -f --tail 50 reth lighthouse` / `bitcoind electrs`; `curl -s https://<host>/health`.
5. When synced, **acceptance** (from any machine with Node 20):
   ```
   node tools/node-check.mjs --eth https://<host>/eth --btc https://<host>/btc/api --broadcast-path
   node tools/node-check.mjs --btc-rpc http://tacit:<BTC_RPC_PASS>@127.0.0.1:8332     # on the Bitcoin machine (8332 is published on loopback only), or through `ssh -L 8332:127.0.0.1:8332`
   ```
   It prints a verdict per role. A role whose public reference did not answer is `UNVERIFIED`, never `PASS`.

| role | the consumer it stands for | needs |
|---|---|---|
| `eth-reads` | relays, keepers, pool/vault readers | in step with the chain, old state, logs, batches |
| `eth-proofs` | vault keeper (`eth_getProof` ~8 h back), the Bitcoin lane's `eth_prove` | proofs 2,400 blocks back |
| `eth-wide-logs` | pool, vault and cBTC history scans | logs from the pool's deploy block, equal to an archive's |
| `eth-browser` | the pages | CORS, text/plain, no admin/debug/txpool, latency |
| `btc-reads` | header relay, BTC pool services, recovery scans | tip in step, history not pruned, address paging, fees |
| `btc-browser` | the pages | CORS |
| `btc-tweak-index` | the mainnet silent-payments tweak index (`worker-relay/render.yaml`, not yet created) | unpruned bitcoind, `getblock` verbosity 3 |

## Turning consumers on (after PASS, in this order; each is one env value, undone by deleting it)

Secrets: `INTERNAL_KEYS` in the machine's `.env` (bootstrap made two). A service puts one in its URL: `https://<host>/k/<KEY>/eth`,
`https://<host>/k/<KEY>/btc/api`. That lifts the per-visitor budget; a wrong key is refused, not demoted to a visitor.

1. **Vault keeper** (`tacit-vault-keeper`): `RPC=https://<host>/k/<KEY>/eth`. It reads through `RPC_FALLBACKS`, so mevblocker/publicnode
   stay behind it. Needs `eth-proofs` PASS (it is the one consumer whose old proofs only mevblocker serves today).
2. **Bitcoin esplora lists**: put `https://<host>/k/<KEY>/btc/api` FIRST in `BTC_POOL_ESPLORA` and in `--esplora` of
   `tools/advance-header-relay.mjs` (both take comma lists and fail over). Needs `btc-reads` PASS.
3. **The relays' reads**: `RPC_URL` in the `tacit-relay-shared` group, but the relays' own wallet sends through that same URL (viem's one
   transport, `worker-relay/src/lib/chain.js`), so first set `INTERNAL_SENDS=1` on the gateway (key holders only; visitors never send
   through us). `RPC_URLS_FALLBACK` keeps the public nodes behind it. Settle sends are unchanged: they use `SETTLE_RPC_URLS` (private relays).
4. **The Bitcoin lane's Ethereum proof** (`tacit-eth-state`): `SOURCE_EXECUTION_RPC` and `SOURCE_PROOF_RPC` (today Tenderly and BlastAPI).
   Needs `eth-proofs` PASS. `SOURCE_CONSENSUS_RPC` stays on the public beacon node for now: the gateway does not front lighthouse's
   beacon API, because what the prover asks of it has not been measured (phase 2).
5. **Mainnet tweak index** (`worker-relay/src/sp-tweak-index.js`, described but not created in `worker-relay/render.yaml`): it needs bitcoind's RPC,
   which is never on the internet, so run it on the Bitcoin machine against `127.0.0.1:8332` rather than on Render. Needs `btc-tweak-index` PASS.
6. **Browsers** (phase 2, a code change, only after 1–5 have run for a few days): add `https://<host>/eth` to `ETH_NODES`,
   `ETH_LOG_NODES`, `ETH_ARCHIVE_NODES` in `dapp/eth-nodes.js` (after publicnode, with `LIMITS` `logs: 50000`), the host to `PLAIN` in
   `dapp/rpc-body.js`, to `connect-src` in the pages' CSP (the build regenerates it), and `https://<host>/btc/api` to the esplora lists
   (`dapp/tacit.js`, `cbtc-lock-mint.js`, `confidential-recovery-btc.js`, `btcswap-page.js`, `burndep-ux.js`, `fastbridge-btc.js`,
   `weld/stats/read.js`). Our node is ONE more candidate, not the primary: public nodes scale with visitors' own IPs, one box does not.
   `ALLOW_BROADCAST=1` only after a test broadcast of one of our transactions shows the node's relay policy accepts it.

Run `tools/node-check.mjs` before and after each change.

## What the nodes see (the privacy line)

A visitor's request carries their IP and, for balance reads, a wallet address: the same exposure as the public nodes they replace, and
the reason this is written down. Here: no access log in Caddy or the gateway; the per-visitor budget holds `sha256(ip + a key made at start)`
in memory for ten idle minutes; `/health` returns counts only; `tests/own-node-gateway.test.mjs` fails if a request writes its address,
method or URL to the process output. The nodes' own logs (`docker compose logs`) record peers and blocks, not RPC requests. Keep it so:
never add an access log, a metrics label with an address, or a request-tracing proxy in front.

## Running it

- **Alerts**: `GET https://<host>/health` is 200 only when the Ethereum head is under two minutes old and the Bitcoin tip answers.
  Point the relay monitor (or any uptime check) at it. Disk: `df -h /srv/chain` weekly until the growth rate is known.
- **Upgrades**: bump the image tag in `docker-compose.yml` (reth, lighthouse, electrs) or the args in `bitcoind/Dockerfile`; `docker compose up -d --build`.
  Upgrade lighthouse and reth together around hard forks. bitcoind and electrs: this pair (Core 30.5 with electrs v3.3.0, the conservative
  one) has not been run together by us; move Core to 31 or 32 only after trying it against electrs on a spare machine.
- **If a node dies**: every consumer falls back to the public list it had. Fix at leisure; do not point consumers at a half-synced node
  (run `node-check` first).
- **Receipts window**: `reth.toml` keeps receipts from block 25,998,000; if a consumer ever scans earlier, lower it (it needs a resync of that
  segment), and `node-check --from-block` tests whatever depth you choose.

## Not verified here

Built and tested in this repo: the gateway (10 tests, each security property mutation-checked), the checker (5 tests against stub nodes broken in the
ways real ones break), the secret generation (the rpcauth hash matches the HMAC-SHA256 that Bitcoin's own rpcauth.py computes), the compose structure (no node RPC port is
published). **Not run**: the images and the sync themselves (no Docker daemon or disk here), so the first `bootstrap.sh` on a real machine is
the first run of reth.toml, the lighthouse/reth pairing, electrs against bitcoind, and the build-time signature check. `node-check` is what
tells you whether they came out right; none of it touches production until a consumer is pointed at the node.
