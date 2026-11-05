# Fast bridge liquidity provider

One process that sells TAC in the pool for TAC on Bitcoin, one swap at a time, without holding anyone's funds: it answers
quotes, checks each user's Bitcoin lock against the chain, locks a pool note of the same amount under the user's claim,
and takes the Bitcoin once the user's claim shows it the secret. The protocol is in [docs/FAST-BRIDGE.md](../docs/FAST-BRIDGE.md).

The process runs the Ethereum-locker machine (`dapp/fastbridge-el.js`) over a durable store. Everything it decides it
reads from the chains; the HTTP API only carries the user's offer in and the pool lock's offer out.

## What it needs

| | |
|---|---|
| Key | `FB_LP_KEY`, 32 bytes of hex, in the environment only. It is the LP's Bitcoin wallet, its pool identity and the root of its swap secrets. `openssl rand -hex 32` makes one. Keep an offline copy: the funds are only as safe as this key. |
| Bitcoin | Nothing: each user's lock pays the fee of the LP's take to the address printed at start (`takeSats` in the quote, twice the fee rate of the moment), and the take spends that output. Coins sent there are used as well, as a reserve when fees rise. |
| Pool | TAC notes owned by the pool identity printed at start (`poolAccount` is its Ethereum address). Shield TAC from that address, or by any route that ends in notes for this identity; the process finds its notes by scanning the pool with its key. A note of exactly the quoted amount is cut from a larger one when there is none, so a few big notes are enough. |
| Host | Node 22, the repository checked out, `npm ci` in `worker-relay/` (the note validator needs jsdom). One process per key: two would lock the same swap twice. |
| Network | Outbound to the Bitcoin explorers (`btcBases`), the Ethereum RPCs the pool wallet module uses, and the relay at `api.tacit.finance`. Inbound on `port` for the users' pages. |
| Disk | `dataDir`: the swap records (`swaps/`), the quotes (`quotes/`), the wallet's scan cache (`wallet-cache.json`, `logs/`). |

## Running

```
cp fastbridge-lp/config.example.json fastbridge-lp/config.json     # sizes, fees and windows are yours to set
export FB_LP_KEY=<64 hex>
node fastbridge-lp/server.mjs --dry-run      # answers /info and /quote, checks offers, advances nothing, keeps no swap or quote on disk
node fastbridge-lp/server.mjs
```

At start it prints one JSON line with the Bitcoin address, the claim key, the pool account and the data directory. Put the
URL of the process (behind TLS) where the users' pages can read it, and name the pages in `origins`.

To offer it on the bridge page (`/fast/`), add `{ "name": "…", "base": "https://…", "claimPub": "<the claimPub printed at start>" }` to `dapp/fast/lp.json`, and the
origin to the page's `connect-src` if it is not `https://fast.tacit.finance`. The page pins the key: a provider that answers with another one is not offered. A provider
run on the same machine can be tried at `http://localhost:<port>/fast/?lp=<url>&claimPub=<hex>`.

### Config

| field | meaning |
|---|---|
| `network`, `poolAddress`, `btcAsset`, `evmAsset` | the chain, the pool, and the asset on each side (the same 32-byte id for TAC) |
| `btcBases` | esplora bases, asked in order for reads; a broadcast goes to every one |
| `csvBlocks` | the Bitcoin refund timelock the user's lock must carry (at least `policy.minCsv`) |
| `reserve.reserveSecs`, `reserve.extendSecs`, `reserve.maxUnbackedShare` | how long a reservation holds the payout while the user builds and sends its lock (5 min), for how long once the lock is on the network (2 h), and the share of the pool balance that reservations with no transaction behind them may hold together (half; one alone may hold more) |
| `inventory.refreshSecs` | how often the pool wallet's balance and the Bitcoin coins are read again (60 s) |
| `quote.minAmount`, `quote.maxAmount` | amounts in base units, both sides; set `maxAmount` below `minAmount` to stop quoting while open swaps finish |
| `quote.feeBps`, `quote.flatFee` | the LP's fee: a share of the amount plus a flat part in base units. The flat part covers the relay's fee (for cutting a note to size) and a little more: the user already pays the Bitcoin take in sats, inside its lock (`takeSats`), so it is not part of the fee. Keep it small: a page refuses a quote whose fee is over 5% of the amount, so a flat fee of F TAC leaves every bridge under about 20 × F TAC unquoted |
| `quote.validSecs`, `quote.rate` | how long a quote holds; `{num, den}` converts what is left after the fee (1/1 for one asset on both sides) |
| `policy.evmWindowSecs` | the time the user has to claim in the pool, from the Bitcoin block that confirmed its lock (4 h) |
| `policy.minClaimSecs`, `policy.claimSlackSecs` | the least time a claim may be built with (1 h), and the gap between the pool deadline and the opening of the user's refund (2 h) |
| `policy.confs` | `[amountFrom, confirmations]` pairs: how many Bitcoin confirmations the LP waits for, by amount |
| `policy.maxOfferAgeSecs` | an offer for a lock confirmed longer ago than this is not answered |
| `name`, `boards` | the name shown in the LP's ad, and the boards it is on (URLs of `fastbridge-lp/board.mjs`): it posts its ad there every minute and answers the requests left for it, so a user finds it without its own URL |
| `alertSecs`, `tickSecs`, `port`, `origins`, `trustProxy` | alert interval, tick length, the HTTP face; `trustProxy` reads the client from `X-Forwarded-For`, only behind a proxy you control |

## API

| | |
|---|---|
| `GET /health` | 200 while the last tick succeeded, 503 with the error otherwise |
| `GET /info` | the claim key, the asset pair, limits, windows, and `available`: the most it can take now |
| `POST /quote {amount}` | what the user pays on Bitcoin and receives in the pool, fixed for `validSecs`; it holds nothing |
| `POST /reserve {quoteId}` | holds the payout while the user builds and sends its lock |
| `POST /extend {quoteId, txid}` | once the lock is on the network, holds the payout through its confirmation |
| `POST /offer {quoteId, offer}` | the user's lock offer; `{ok}` or `{ok: false, retry, why}`, recomputed from the chain each time |
| `GET /swap/:id`, `GET /swap/:id/offer` | the swap's phase; the pool lock's offer once the lock is made |

Bodies are capped at 64 KB, and each client has a bucket (60 requests a minute, offers 6). `dapp/fastbridge-http.js` is
the user's side of this API.

## The board

`node fastbridge-lp/board.mjs` runs a board: providers post their ads there (they are signed, and a page checks each one), and
users reach a provider through it with requests sealed to the provider, so a provider in a browser tab is found and answered
like a daemon. A user that no provider online can take posts a want there (`PUT /want`: an amount, signed by a key made for it alone,
standing up to a day; amount 0 takes it down), and providers read what is waiting (`GET /wants`). It holds nothing that has to be
trusted and keeps everything in memory: ads and messages for ten minutes, wants for a day. Set `FB_BOARD_PORT`,
`FB_BOARD_ORIGINS` (the pages that may call it, comma separated) and `FB_BOARD_TRUST_PROXY=1` behind a proxy; serve it over TLS.
List it in the page's `dapp/fast/lp.json` under `boards`, and in a daemon's `boards`. Anyone can also provide from the bridge
page (`/fast/`, "Provide liquidity") with the key they bridge with.

## What it can take

A provider takes only what it can lock. The most it can take is the TAC its pool wallet holds, less what is already promised (a
reservation, or a swap whose lock is not made yet), and it needs one Bitcoin coin that pays a take's fee for each swap open at
once. A quote checks that and holds nothing, so a user comparing providers holds nothing at any of them. The reservation holds the
payout when the user commits, before it locks any Bitcoin, so a provider that cannot is found out while the TAC is still in hand.
Keep several coins at the Bitcoin address, or one swap at a time is all it takes.

## Watching it

`/health` for liveness. Alerts go to the log and, if `FB_LP_ALERT_WEBHOOK` is set, are POSTed there as JSON.

| alert | what it means | what to do |
|---|---|---|
| `a swap has waited long in taking` | the user's claim showed the secret, and the LP's Bitcoin take has not landed | check the explorers, the fee coins at the Bitcoin address and the fee rate. The take has to land before the user's timelock opens (about a day after its lock); the process keeps trying every tick |
| `a swap has waited long in refunding` | the LP's lock is past its deadline and the refund has not landed | check the relay and the node's connection; the note is the LP's own and waits safely |
| `a lock was claimed without revealing t` | a claim spent a lock without the signature that opens the Bitcoin | should not happen; stop quoting and look at the claim's settle before anything else |
| `a swap record cannot be read` | a file in `swaps/` is torn or corrupt and has no readable backup | restore it from the backup; the other swaps go on |
| `tick failed` in the log, `/health` 503 | a read of the store failed | the disk; the process retries on the next tick |
| `bridges are waiting for a provider` | a want on a board this process is on, for its asset, that it has not seen before (read every five minutes) | raise `quote.maxAmount` or the TAC in the pool if it is more than this process can take |

The same swap in the log: `swap` lines show each phase change (`accepted`, `locking`, `locked`, `offered`, `taking`,
`done`; or `refunding`, `refunded`, `rejected`, `aborted`).

## Keeping it safe

- **Back up `dataDir/swaps/` continuously.** A swap's record is its safety state: the Ethereum deadline, the lock it sent,
  the take it built. Every write is atomic and keeps the previous version as `.bak`, but a lost disk loses the swaps in
  flight. If a record is lost and the user sends its offer again, the process looks for the lock by its leaf before it
  makes another, which covers every case but a Bitcoin reorganisation of the user's lock in the same window.
- **Restarting is safe.** The process reads its records and goes on from the stored step; a lock that was sent just before
  the stop is found by its leaf, not sent again.
- **Update `config.json` by restarting.** Quotes already given keep the terms they carry; a changed fee or limit applies to
  new quotes. To stop taking swaps, set `quote.maxAmount` below `quote.minAmount` and restart; open swaps finish.
- **Do not run two processes on one key.**
- **Rebalancing is not done here.** Bitcoin TAC builds up as the pool TAC drains. Move it back over the reflection bridge
  from the Bridge tab, signed in with the same key.
- **The claimer's prover** is the one remaining trust assumption (see the design doc): the process never proves the user's
  claim, and the user chooses who does.

## Tests

```
node tests/fastbridge-sim.test.mjs      # both machines against a simulated Bitcoin and pool
node tests/fastbridge-lp.test.mjs       # this service: API, quotes, store, explorer adapter, and swaps through all of it
node tests/fastbridge-fork.mjs          # the Ethereum side against the live pool on a mainnet fork (needs anvil, FORK, EXEC)
```
