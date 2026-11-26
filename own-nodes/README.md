# Our own Ethereum and Bitcoin nodes

Why: the site and its services read Ethereum through free public RPCs and Bitcoin through public explorers, none of which we control.
They rate-limit, drop connections, cap `eth_getLogs`, refuse old `eth_getProof`, and some refuse to trace. Running the nodes ourselves puts a
reader we control **in front of** those, so a public outage costs a fallback. Nothing depends on our nodes alone: every consumer keeps its
public fallbacks, and taking our nodes out is deleting one URL.

**One box, both chains** (this directory): reth (a full node cut to what we read, not an archive) + lighthouse, bitcoind (unpruned, txindex) +
romanz/electrs (a light address index), behind one read-only gateway with TLS. ~1.6 TB of NVMe today on a 64 GB machine.
The older **light profile** (`light/`: Nethermind's light client + a pruned bitcoind on a container host) runs today behind
`tacit-node-gw.onrender.com`; it serves latest-state reads only and is retired once the box passes `node-check` (see Cut-over).

```
 browsers ──https──▶ tacit-node-gw.onrender.com (gateway.mjs, per-visitor budgets) ─┐
 our services ─https /k/<KEY>/…─────────────────────────────────────────────────────┤
                                                                                    ▼
                        node.tacit.finance: Caddy (TLS) ──▶ gateway.mjs ──▶ reth ◀── lighthouse          /eth (+ keyed traces)
                                                            (allowlists,     bitcoind ◀── electrs        /btc/api/… (esplora reads)
                                                             budgets, no log)
```

## What is here

| file | what |
|---|---|
| `gateway.mjs` + `Dockerfile` | the only thing on the internet: read-method allowlist, CORS for tacit.finance, text/plain bodies, per-visitor budget, getLogs span cap, **no access log**; `/k/<KEY>/…` for our services; keyed traces (`INTERNAL_TRACE`). Tests: `tests/own-node-gateway.test.mjs`, `tests/own-node-trace.test.mjs` |
| `btc-index.mjs` | esplora's read paths from bitcoind + electrs (loaded only when `ELECTRUM_URL` is set). Tests: `tests/own-node-btc-index.test.mjs` |
| `docker-compose.yml` | reth (+ a one-shot `reth-snapshot`), lighthouse, bitcoind, electrs, gateway, Caddy; images pinned by digest; memory ceilings and CPU weights |
| `reth.toml` | what reth keeps (and why, with sizes) |
| `bitcoin.conf`, `bitcoind/Dockerfile` | bitcoind unpruned with txindex; Bitcoin Core built from the release tarball, the build **fails** unless the sha256 matches and ≥5 builder signatures verify |
| `electrs/Dockerfile`, `electrs/config.toml` | romanz/electrs v0.12.1 built from its tag, **fails** unless the tag is the pinned commit; per-request log lines off |
| `Caddyfile` | TLS for `NODE_HOST` (Let's Encrypt), access log discarded |
| `bootstrap.sh`, `env.example` | fresh Debian/Ubuntu → everything running (Docker from Docker's repo, firewall, keys-only SSH, automatic security updates, secrets) |
| `../tools/node-check.mjs` | the acceptance test, per consumer role. Tests: `tests/node-check.test.mjs`; deploy files: `tests/own-node-deploy.test.mjs` |
| `light/` | the light profile (container host, no Docker) |

## The design, and its budget

**Ethereum: reth full node, history cut to our window** (`reth.toml`). Sizes are the decompressed sizes in reth's own snapshot manifest at block
26,486,073 (2026-11-24):

| kept | why | disk |
|---|---|---|
| state + trie | every node | ~271 GB |
| all headers | every node | ~15 GB |
| block bodies + tx-hash lookup from block 25,998,000 | log scans from the pool's deploy block (25,998,736) name transactions by hash; any of our txs by hash | ~42 GB |
| receipts from block 25,998,000 | `eth_getLogs` back to the deploy block, 50,000-block spans | ~28 GB |
| state history, last **100,800 blocks (~14 days)** | `debug_traceTransaction` of a claim needs the state before its block; claims are read hours to ~2 days after landing, so 14 days is 7x the need. It costs ~3.6 GB per 50,000 blocks (28 days would be ~20 GB). Also covers the vault keeper's `eth_getProof` ~8 h back | ~10 GB |
| indices rebuilt for the above | tx lookup, history | ~10–20 GB |
| lighthouse (checkpoint sync, back-fill to the weak-subjectivity period, blobs pruned) | consensus | ~150–250 GB |

reth ≈ **390 GB** today (an archive is ~1.9 TB compressed), growing ~1 GB/day (~350 GB/yr: bodies and receipts since a fixed block).
Lighthouse adds ~0.2 TB. **Ethereum ≈ 0.6 TB.**

Tracing: reth v2.11.0 answers all three forms `dapp/fastbridge-evm.js` `makeTxTracer` sends, verified on a `reth --dev` node with the compose
flags and this `reth.toml`: the pool-calls **JavaScript tracer** (keeps only the plain CALLs into the pool that ran; a reverted frame drops its
calls), `callTracer` with `tracerConfig`, and `trace_transaction`. The node's `debug`/`trace` APIs are on the compose network only; the gateway
passes them **only** on the keyed path, only for one transaction, only those three forms (the JavaScript tracer only for a pool in
`TRACE_POOLS`; any other JavaScript is code run inside the node and is refused), timeout capped at 20 s, answer capped at 4 MB, two at a time.

**Bitcoin: bitcoind (no prune, txindex=1) + romanz/electrs**, not Blockstream's esplora index (~1 TB more). ~0.82 TB of blocks (incl. undo),
~70 GB txindex, ~12 GB chainstate, electrs ~60 GB: **≈ 0.96 TB**, growing ~70–90 GB/yr.

The gateway serves esplora's paths from these two (`btc-index.mjs`). Every path the pages and services use:

| esplora path | from | notes |
|---|---|---|
| `/blocks/tip/height`, `/blocks/tip/hash`, `/block-height/<h>` | bitcoind | tip cached 5 s |
| `/tx/<id>` | bitcoind `getrawtransaction 2` (prevouts + fee from undo data) | esplora's JSON; `*_asm` fields left out (nothing of ours reads them) |
| `/tx/<id>/hex`, `/raw`, `/status`, `/merkleblock-proof` | bitcoind | |
| `/tx/<id>/outspend/<n>`, `/outspends` | bitcoind `gettxout` (unspent?) + the spender from the history of the output's own script (electrs) | gone but no spender indexed yet ⇒ 503, never "unspent" |
| `/tx/<id>/merkle-proof` | electrs `get_merkle` | esplora's own shape |
| `/address/<a>/utxo`, `/scripthash/<h>/utxo` | electrs `listunspent` | |
| `/address/<a>/txs`, `/txs/chain[/<last>]`, `/txs/mempool` (and `/scripthash/…`) | electrs history + bitcoind | 50 mempool + 25 confirmed, newest first; pages of 25 |
| `/address/<a>`, `/scripthash/<h>` (stats) | electrs history + bitcoind | computed from the history; **501** above 300 transactions |
| `/block/<hash>`, `/header`, `/status`, `/raw`, `/txids`, `/txid/<i>`, `/blocks[/<h>]` | bitcoind | |
| `/fee-estimates`, `/v1/fees/recommended` | bitcoind `estimatesmartfee`, `getmempoolinfo` | the second in mempool.space's shape (whole sat/vB, never under 1) |
| `/mempool`, `/mempool/txids` | bitcoind + electrs fee histogram | |
| `POST /tx` | bitcoind `sendrawtransaction` | only with `ALLOW_BROADCAST=1` |
| `/mempool/recent`, `/block/<hash>/txs[/<i>]`, addresses with >10,000 txs (electrs' lookup limit) | — | **501**. Cheapest fallback: none needed, the pages keep mempool.space / blockstream.info after us in their lists. mempool.space's own `/v1/blocks` (fee-floor.js) is not esplora and stays on mempool.space |

**Total ≈ 1.6 TB today, ≈ 2 TB in a year**, on 3.84 TB of NVMe.

**Memory (64 GB)**: reth 24 GB ceiling, lighthouse 8, bitcoind 14 (dbcache 10 GB for the first sync, 2 GB after), electrs 4, gateway 0.5,
Caddy 0.25: ~51 GB of ceilings. reth's database is memory-mapped; its file pages count against its ceiling and are reclaimed, not killed.
CPU is shared by weight (reth 2048, lighthouse/bitcoind/gateway 1024, electrs 512), not capped, so whatever is syncing gets the idle cores.

**Disks: RAID0 across the two NVMe drives** (one ~3.5 TiB volume). Chain data is re-downloadable, the config is this repo plus one `.env`, and
every consumer falls back to public nodes, so a failed disk costs a day of resync, not data. RAID1 (the Hetzner default) would leave 1.92 TB:
~1.6 TB used on day one, full within a year. Two separate volumes (Ethereum on one, Bitcoin on the other) also work but each fills on its own
schedule; not worth the extra steps.

## Hardware and cost

- **Hetzner Server Auction** (robot.hetzner.com, "Server Auction"): filters **RAM ≥ 64 GB**, **drives: NVMe, ≥ 2 × 1.92 TB** (or 2 × 3.84 TB),
  CPU: a recent Ryzen (5000/7000) or Xeon E-2200+/Core i9 (reth executes blocks single-threaded at the tip: prefer high clock over core count;
  skip i7-6700/7700, Xeon E3 and EPYC 7001-era parts), location FSN/NBG/HEL (all fine; Frankfurt-adjacent for the Render gateway), 1 Gbit/s
  unmetered (Hetzner's default). Typical asking price ~€50–90/mo, no setup fee on auction servers.
- **Fallback: AX102** (Ryzen 9 7950X3D, 128 GB DDR5 ECC, 2 × 1.92 TB NVMe), listed around €110–130/mo plus a one-time setup fee. Check the page.
- Not Vast/RunPod (container hosts: no Docker, no 80/443, per-GB storage pricing: ~$1,400/mo at this disk size) and not Render disks.

**Monthly, today vs after**: today the light profile costs the Vast box `tacit-light-nodes` 62117599 (~$97/mo) + `tacit-node-gw` on Render
(~$7/mo) ≈ **$104/mo** and serves latest-state reads only. After: auction box **~€50–90/mo** (AX102 ~€110–130) + the same Render gateway
($7) ≈ the same money, with full log history from the pool's deploy block, 14 days of state history, traces, and Bitcoin history.

## The owner's steps

1. **Order.** Auction server with the filters above (or an AX102). Add your SSH public key in robot ("Key management") and select it at order.
2. **Install the OS** (auction servers come up in the rescue system). In robot → Rescue, log in with the key, run `installimage`, pick
   **Ubuntu 24.04** (Debian 12/13 also work), and in the config editor set:
   ```
   SWRAID 1
   SWRAIDLEVEL 0
   HOSTNAME tacit-node
   PART /boot ext3 1024M
   PART /     ext4 all
   ```
   Save (F10), let it finish, `reboot`.
3. **DNS** (Namecheap → tacit.finance → Advanced DNS → Add new record): **Type `A Record`, Host `node`, Value `<the box's IPv4>`, TTL Automatic.**
   That is `node.tacit.finance`. (Optional: an `AAAA Record`, Host `node`, Value the box's IPv6 `…::2`.) Wait until `dig +short node.tacit.finance`
   prints the IP: Caddy asks Let's Encrypt for the certificate as soon as it starts, over port 80.
4. **Bootstrap** (as root on the box, in `tmux` so a dropped SSH session does not stop it):
   ```
   tmux new -s nodes
   curl -fsSL https://raw.githubusercontent.com/z0r0z/tacit/main/own-nodes/bootstrap.sh | NODE_HOST=node.tacit.finance bash
   ```
   It clones the repo to `/opt/tacit`, installs Docker, the firewall (22, 80, 443 + the P2P ports), keys-only SSH (only if a key is installed),
   daily security updates, writes `/opt/tacit/own-nodes/.env` with fresh secrets, builds the images, starts Bitcoin, the gateway and TLS,
   downloads reth's snapshot (resumable: run the same command again if interrupted), then starts Ethereum.
5. **Keep the secrets**: copy `/opt/tacit/own-nodes/.env` into the password manager (`INTERNAL_KEYS` are the service keys; `BTC_RPC_PASS`
   is local only). Nothing else on the box needs a backup: chain data re-syncs, the TLS certificate re-issues, the jwt secret is regenerated.
6. **After bitcoind's first sync** (`docker compose logs bitcoind | tail` shows `progress=1.000000`): set `BTC_DBCACHE=2000` in `.env` and
   `cd /opt/tacit/own-nodes && docker compose --profile btc up -d bitcoind`.

## Sync time

| | how | estimate |
|---|---|---|
| reth | snapshot (snapshots.reth.rs, reth's own): state + headers + bodies/receipts since the deploy block + 100,800 blocks of state history, **~212 GB download** | 0.5–2 h download, ~1 h unpack, 1–3 h rebuilding tx lookup and history indices, <1 h catching up from the snapshot's day: **~3–6 h** |
| reth (no snapshot, `RETH_FROM_SCRATCH=1`) | execute all 26.5M blocks | 2–4 days, and more disk at the peak (bodies and changesets are written before they are pruned) |
| lighthouse | checkpoint sync | minutes; back-fill continues in the background |
| bitcoind | IBD, `assumevalid` (Core's default), dbcache 10 GB | download-bound, ~800 GB: **~12–24 h**; txindex builds alongside |
| electrs | index from bitcoind's blocks | ~2–4 h after bitcoind (its docs: ~2 h for 800 GB on 6 cores) |

The snapshot's state is trusted only until the next block: reth recomputes the state root of every block after it, so a bad snapshot stops the
node instead of serving wrong answers. Box ready: Ethereum within the first day, Bitcoin in ~1–1.5 days.

## Acceptance (node-check, from any machine with Node 22)

```
node tools/node-check.mjs --eth https://node.tacit.finance/eth --eth-key https://node.tacit.finance/k/<KEY>/eth \
     --btc https://node.tacit.finance/btc/api --btc-index --broadcast-path
node tools/node-check.mjs --btc-rpc http://tacit:<BTC_RPC_PASS>@127.0.0.1:8332     # through `ssh -L 8332:127.0.0.1:8332 root@<box>`
curl -s https://node.tacit.finance/health      # 200 only when the Ethereum head is <2 min old, bitcoind is synced and electrs is ≤2 blocks behind
```

Roles: `eth-reads`, `eth-proofs` (proof 2,400 blocks back), `eth-wide-logs` (logs from the deploy block equal an archive's), `eth-browser`
(CORS, text/plain, no admin/debug/txpool, tracing refused to visitors), **`eth-trace`** (a recent pool transaction and one ~2 days old traced with
the dapp's own tracer through the keyed path, pool calls equal to public tracers'), `btc-reads`, **`btc-index`** (a transaction whole, its
outspends and merkle proof, an address's stats, utxo and every history page compared with mempool.space/blockstream), `btc-browser`,
`btc-tweak-index`. A role whose public references did not answer is `UNVERIFIED`, never `PASS`. The key is masked in the output.

## Cut-over (only after every role PASSES; each step is env values, undone by restoring them)

**(a) The browser gateway → the box** (Render `tacit-node-gw`, srv-dc1v5slg1s2s73ega06g). Note the current `ETH_UPSTREAM` (the Vast URL) first. Set:
```
ETH_UPSTREAM=https://node.tacit.finance/k/<KEY1>/eth
BTC_ESPLORA_UPSTREAM=https://node.tacit.finance/k/<KEY1>/btc/api
LOGS_MAX_SPAN=50000
```
then trigger a deploy (an env change alone does not deploy on Render). The Render gateway keeps the per-visitor budgets (`cf-connecting-ip`);
the box sees it as one keyed client. Check: `node tools/node-check.mjs --eth https://tacit-node-gw.onrender.com/eth --btc https://tacit-node-gw.onrender.com/btc/api --btc-index`
(no `--light` any more). Keep the Vast box a day; then the owner destroys **Vast instance 62117599** (~$97/mo saved).

**(b) Fast-bridge providers** (the pair and house provider services, `fastbridge-lp/server.mjs`):
```
FB_LP_TRACE_RPCS=https://node.tacit.finance/k/<KEY2>/eth,https://eth.drpc.org
FB_LP_AGREE_RPCS=https://node.tacit.finance/k/<KEY2>/eth,https://rpc.mevblocker.io,https://eth.drpc.org,https://eth-mainnet.public.blastapi.io
```
The trace list keeps one public tracer so a claim is taken from two traces that agree. The agree list must be separate operators: once (a) is
done `tacit-node-gw.onrender.com` IS the box, so it is not listed next to it.

**(c) Pages** (a code change, after (a) has run a few days): in `dapp/eth-nodes.js` set `LIMITS['tacit-node-gw.onrender.com/eth']` to
`{ logs: 50000, state: true }` (this also ends the light-first promotion of that host in `dapp/trade/rpc.js`, which keys on a 512-block span:
decide whether shallow reads should still prefer it) and raise its `eth_getLogs` pace in `dapp/rpc-pace.js`; add
`https://tacit-node-gw.onrender.com/btc/api` after mempool.space in the esplora lists (`dapp/tacit.js`, `cbtc-lock-mint.js`,
`confidential-recovery-btc.js`, `btcswap-page.js`, `burndep-ux.js`, `fastbridge-btc.js`, `weld/stats/read.js`). Same host, so the CSP does not
change. `ALLOW_BROADCAST=1` only after a test broadcast of one of our transactions relays.

Services that read through the box directly use `https://node.tacit.finance/k/<KEY>/…` (README of each: vault keeper `RPC`, `BTC_POOL_ESPLORA`,
header relay `--esplora`, `SOURCE_EXECUTION_RPC`/`SOURCE_PROOF_RPC`). The relays' `RPC_URL` only with `INTERNAL_SENDS=1` (they send through it).

**Rollback**: restore `ETH_UPSTREAM` to the noted Vast URL (while the Vast box exists; after that, delete `ETH_UPSTREAM`/`BTC_ESPLORA_UPSTREAM`
so the Render gateway answers 404 and the pages use the next node in their lists) and deploy; drop the box from `FB_LP_*`; revert (c)'s commit.
On the box, `docker compose down` stops everything without touching chain data.

## Running it

- **Alerts**: point the relay monitor (or any uptime check) at `https://node.tacit.finance/health`. Disk: `df -h /srv/chain` weekly.
- **Upgrades**: bump the tag *and* digest in `docker-compose.yml` (reth, lighthouse, Caddy), the args in `bitcoind/Dockerfile` or
  `electrs/Dockerfile`; `docker compose --profile eth --profile btc up -d --build`. Upgrade lighthouse and reth together around hard forks.
- **If a node dies**: every consumer falls back to the public list it had. Fix at leisure; do not point consumers at a half-synced node.
- **Older history** (earlier logs, older traces): lower the `before`/`distance` values in `reth.toml` and resync that part (`reth download`
  with the matching `--with-*` flags, or from scratch).

## What the nodes see (the privacy line)

A visitor's request carries their IP and, for balance reads, a wallet address: the same exposure as the public nodes they replace, and the
reason this is written down. Here: no access log in Caddy or the gateway; electrs' per-request log lines are off; the per-visitor budget holds
`sha256(ip + a key made at start)` in memory for ten idle minutes; caches hold chain facts (blocks, confirmed transactions, an address's history
for 5 s while it is paged) with nothing about who asked; `/health` returns counts only. `tests/own-node-gateway.test.mjs` and
`tests/own-node-btc-index.test.mjs` fail if a request writes its address, method or URL to the process output. Never add an access log, a
metrics label with an address, or a request-tracing proxy in front.

## Verified here, and not

Verified on the laptop: the gateway, trace path and esplora index against stub nodes (tests above, each guard mutation-checked); the trace path
end to end through the gateway against a real `reth v2.11.0 --dev` node with the compose RPC flags and this `reth.toml` (pool tracer, callTracer,
a reverted subframe dropped, visitors refused); `reth config` parses `reth.toml`; the snapshot `--with-*` flags exist in v2.11.0 and match
`reth.toml` (test); every image digest was read from its registry. **Not run here** (no Docker daemon or disk): the images, the snapshot download,
the sync, lighthouse↔reth, electrs v0.12.1 against Core 30.5, the build-time signature checks. `node-check` on the box is what says whether they
came out right; nothing in production changes until a consumer is pointed at the box.
