# Fast bridge liquidity provider

One process that sells TAC in the pool for TAC on Bitcoin, one swap at a time, without holding anyone's funds: it answers
quotes, checks each user's Bitcoin lock against the chain, locks a pool note of the same amount under the user's claim,
and takes the Bitcoin once the user's claim shows it the secret. The protocol is in [docs/FAST-BRIDGE.md](../docs/FAST-BRIDGE.md).

The process runs the Ethereum-locker machine (`dapp/fastbridge-el.js`) over a durable store. Everything it decides it
reads from the chains; the HTTP API only carries the user's offer in and the pool lock's offer out.

## Quick start: a Bitcoin-for-ETH provider

Node 22 and a machine that stays on. From a checkout of this repository, with the packages installed (`(cd worker-relay && npm ci --omit=dev --ignore-scripts) && (cd worker && npm ci --omit=dev --ignore-scripts)`):

```
node fastbridge-lp/setup.mjs
```

1. **Set up.** It asks for a name and your fee (each has a default; `--name`, `--fee-bps`, `--flat-fee`, `--size`, `--yes` skip the questions). It makes your key
   in `fastbridge-lp/data-btc-eth/provider.key` (mode 600) and prints it once: **copy it somewhere offline**, the funds are only as safe as it (`setup show-key` prints it again on request).
   Then it prints the provider's two public addresses, an Ethereum pool account and a Bitcoin address, and how much to send for a small, medium or large start.
2. **Send the funds.** ETH to the pool account (Ethereum mainnet). It sees it, shields it into private notes of the key, and sets the swap limits from what arrived. Bitcoin
   to the Bitcoin address is optional and turns on ETH to BTC; one confirmation counts, and running setup again after sending it switches the direction on.
3. **It checks and goes live.** It tries the Ethereum nodes, the Bitcoin explorers, the price, the board, a dry run of the quote path and the CORS answer for tacit.finance, then starts the
   daemon, which posts its signed ad. It shows under "Providers online" at https://tacit.finance/btc/ within a few minutes (the first read of the pool takes about two).

Stop it with Ctrl-C at any point and run the same command again: the key is made once, a deposit is written down before it is sent, and a run first finds out what the last one finished. A
deposit whose settle reverted (the relay busy, or its settle racing ours) is settled again, from this account when the relay is not sending, and counted done as soon as the notes are in the pool: it is never deposited twice.
`node fastbridge-lp/setup.mjs run` starts the daemon later (a restart), `status` reads its health and its ad and says what they mean.

**Starter sizes** (the most one swap takes; the least is 50,000 sats; ETH is for two swaps at the most at once, at today's price, plus 0.01 ETH that stays for gas):

| size | most per swap | send ETH | send BTC (optional) |
|---|---|---|---|
| small | 100,000 sats (0.001 BTC) | about 0.07 ETH (at 31 ETH per BTC) | the swap's most plus 40,000 sats |
| medium | 500,000 sats (0.005 BTC) | about 0.32 ETH | same |
| large | 2,500,000 sats (0.025 BTC) | about 1.56 ETH | same |

Setup prints the exact figures for the day's price. Start small: the limits come from what is funded, and a later run after a top-up raises them.

**What you earn, what you risk.** You earn the fee on every swap: a share of the amount (30 means 0.30%) plus a flat number of sats that covers the Bitcoin network fees. Pages ask the providers with the lowest fees first. You risk:
capacity tied up while a swap is open (up to about 16 hours if a user disappears, after which it comes back to you), network fees on both chains, and the price moving in that time. All of it is bounded by your maximum per swap. Tacit never
holds your funds: the key is yours, and each swap locks both sides. Nothing here is a promise of income.

**Watching it.** `curl localhost:8788/health` is liveness; `/info` shows what it quotes (`minAmount`, `maxAmount`, `feeBps`, `flatFee`), `available` (the most it can lend now; 0 or under the minimum shows as "full right now"; add ETH) and,
once a swap has ended, `stats` (swaps, fees earned, capacity held). Alerts go to the log and to `FB_LP_ALERT_WEBHOOK` (see "Watching it" below).

**Docker.** `docker build -f worker-relay/Dockerfile.fastbridge-lp -t tacit-lp .`, then `docker run -it -v tacit-lp:/var/lib/tacit-fastbridge-lp tacit-lp setup` (once; it stops when the checks pass), then
`docker run -d --restart unless-stopped -v tacit-lp:/var/lib/tacit-fastbridge-lp tacit-lp run`. Without `-it` it takes `FB_LP_NAME`, `FB_LP_FEE_BPS`, `FB_LP_FLAT_FEE`, `FB_LP_SIZE` and `FB_LP_KEY` from the environment.
`docker-compose.example.yml` is the same with a volume; `render.example.yaml` is a Render service (a template, not deployed) with the disk and variables. One instance per key.

The sections below are the full reference.

## Run one that stays on

Anyone can provide: from the bridge page (`/fast/`, "Provide liquidity", while the page is open), or with this process, which stays on by itself and
needs nothing from you but TAC. It is found through the boards, so it needs no public address and no domain. It does have to be on: it takes the Bitcoin of each bridge within about
a day of the bridger's lock, before their refund opens, and a bridge it does not finish in time is a bridge it has paid for and not been paid for. So run it on a machine that stays up
(a home server or a small host, not a laptop that sleeps), and before turning it off set `FB_LP_MAX_AMOUNT=0` and wait for the open swaps to finish.

```
git clone https://github.com/src-company/tacit && cd tacit
(cd worker-relay && npm ci --omit=dev --ignore-scripts) && (cd worker && npm ci --omit=dev --ignore-scripts)
cp fastbridge-lp/config.example.json fastbridge-lp/config.json     # fee and sizes are yours to set; add "name": "…" to be called something
export FB_LP_KEY=$(openssl rand -hex 32)                           # keep an offline copy: the funds are only as safe as this key
node fastbridge-lp/server.mjs                                      # prints the address to fund
```

1. **Send it TAC.** The start line shows `poolAccount`: send TAC (the ERC-20, on Ethereum) there, and about 0.01 ETH for gas. It notices within a minute and
   shields the TAC into private notes, which takes a little while, and lends it once they are in; send more at any time and it does the same. No other step, no tool to run.
2. **It takes bridges.** It posts its ad on the board, so `/fast/` and the front page's Bridge tab find it. Each bridge pays you the fee in TAC on Bitcoin
   (at the Bitcoin address of the key). **Check that it shows up:** on a first start with an empty `dataDir` the first read of the pool takes about two minutes, and the ad is
   posted after it, so give it three. Then `/fast/` lists it under "Providers online" with your `name` (or `Provider` and the first six hex digits of the claim key, when you
   named it nothing), and "full right now" until the TAC is private. The board shows it too: `curl https://tacit-fast-board.onrender.com/ads` has an ad with your `claimPub`.
   Not there after five minutes: the log says `the ad was not posted` and why (usually an unreachable board or a wrong `boards` URL).
3. **Know what comes home.** Bitcoin TAC builds up as the private TAC drains. You can trade it on Bitcoin, or bring home what the regular bridge can carry (the front
   page's Bridge tab with the same key, or `tools/fastbridge-lp-bridge-home.mjs` from a terminal) and lend it again. The bridge cannot follow TAC whose history passes through
   Bitcoin's shielded pool, a pool or farm trade, or a very long chain of transfers, and a provider that takes every note is often paid in such TAC: it stays on
   Bitcoin. The page's "Provide liquidity" panel can refuse it; the daemon takes it (see the last section). Until the private TAC is topped up the provider shows "full right now" and bridgers use another.
4. **Be told.** Set `FB_LP_ALERT_WEBHOOK` (a Slack or Discord webhook works as it is) and it says when it runs low on TAC or ETH, or a swap waits long.

`FB_LP_MAX_AMOUNT=0` stops new swaps and finishes the open ones; to stop for good, wait for those to finish, then stop the process. One process per key.
Try it first with `--dry-run`: it answers `/info` and `/quote`, takes nothing and shields nothing.

## What it needs

| | |
|---|---|
| Key | `FB_LP_KEY`, 32 bytes of hex, in the environment only. It is the LP's Bitcoin wallet, its pool identity and the root of its swap secrets. `openssl rand -hex 32` makes one. Keep an offline copy: the funds are only as safe as this key. |
| Bitcoin | Nothing: each user's lock pays the fee of the LP's take to the address printed at start (`takeSats` in the quote, twice the fee rate of the moment), and the take spends that output. Coins sent there are used as well, as a reserve when fees rise. |
| Pool | TAC notes owned by the pool identity printed at start (`poolAccount` is its Ethereum address). Shield TAC from that address, or by any route that ends in notes for this identity; the process finds its notes by scanning the pool with its key. A note of exactly the quoted amount is cut from a larger one when there is none, so a few big notes are enough. |
| Host | Node 22, the repository checked out, and its packages installed in both `worker-relay/` (the note validator needs jsdom) and `worker/` (the noble libraries it imports): `npm ci --omit=dev --ignore-scripts` in each, as the image does. One process per key: two would lock the same swap twice. |
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
| `btcFeeTarget`, `btcMinFeeRate` | the explorers' estimate the provider's Bitcoin transactions pay (a block target, `'1'` for a pair provider, `'3'` otherwise) and the least sat/vB they pay (2 for a pair provider, else 1). A pair provider's lock that a block goes by without is bumped from its change, child pays for parent, up to 1% of the amount |
| `csvBlocks` | the Bitcoin refund timelock the user's lock must carry (at least `policy.minCsv`) |
| `reserve.reserveSecs`, `reserve.extendSecs`, `reserve.maxUnbackedShare` | how long a reservation holds the payout while the user builds and sends its lock (5 min), for how long once the lock is on the network (2 h), and the share of the pool balance that reservations with no transaction behind them may hold together (half; one alone may hold more) |
| `reserve.perClient`, `reserve.perBoard` | how many reservations with no lock named yet one client address holds at once (2), and the requests that come through a board together (4, as they name no address). A new one past that lets go of that client's oldest, so a user asking again is always answered; 0 for no limit |
| `inventory.refreshSecs` | how often the pool wallet's balance and the Bitcoin coins are read again (60 s) |
| `quote.minAmount`, `quote.maxAmount` | amounts in base units, both sides; set `maxAmount` below `minAmount` to stop quoting while open swaps finish |
| `quote.feeBps`, `quote.flatFee` | the LP's fee: a share of the amount plus a flat part in base units. The flat part covers the relay's fee (for cutting a note to size) and a little more: the user already pays the Bitcoin take in sats, inside its lock (`takeSats`), so it is not part of the fee. Keep it small: a fee over 5% of the amount is quoted by the fast page with a plain warning, and the front page's Bridge tab does not prefer it, so a flat fee of F TAC keeps every bridge under about 20 × F TAC out of the tab (a fee over 90% is not quoted at all) |
| `quote.validSecs`, `quote.rate` | how long a quote holds; `{num, den}` converts what is left after the fee (1/1 for one asset on both sides) |
| `quote.graceSecs`, `quote.lateSecs`, `quote.lateMoveBps` | how long after `validSecs` an offer is still answered at the quote. With a fixed `rate` (the TAC provider) the grace is all there is. A provider priced from the market answers after the grace only an offer whose lock it saw before the quote ran out (named to `/extend` in time, or confirmed in a block by then), up to `lateSecs` after it (6 h), and only while the price of the moment pays no more than `lateMoveBps` over the quote (100) |
| `traceRpcs` | the Ethereum nodes asked for a transaction's trace (`debug_traceTransaction` or `trace_transaction`), to read a claim settled through a contract other than the pool or its relayer; `FB_LP_TRACE_RPCS` (comma separated) wins. An own node goes first (the public ones that answer are the default). Each node is asked first with a tracer that keeps only the calls made to the pool, then with `callTracer`, then with `trace_transaction`; a transaction no node traced is asked again later (from 15 s, doubling, to 10 minutes) and alerted with its hash. The pool records no claim's kernel apart from the call that carried it, so a claim sent through a contract of the claimer's in a form of its own is read only from a trace, and a public node may refuse a transaction made costly to trace: until the pool records claims, a node of your own that keeps state and traces without limits (an archive node) is what reads every claim. Run one and put it first |
| `agreeRpcs` | the Ethereum nodes, of separate operators, that must agree before a swap is taken as claimed, refunded or lost: every one is asked at one block, two or more must answer and all that answer must say the same (else the read is made again and the swap waits; refunds still go out at their time). `FB_LP_AGREE_RPCS` (comma separated) wins; at least two. Default: public nodes that serve the pool's state at a block number. `traceRpcs` should name two or more as well, since a claim read from a trace is taken only once two nodes trace it alike |
| `policy.evmWindowSecs` | the time the user has to claim in the pool, from the Bitcoin block that confirmed its lock (4 h) |
| `policy.minClaimSecs`, `policy.claimSlackSecs` | the least time a claim may be built with (1 h), and the gap between the pool deadline and the opening of the user's refund (2 h) |
| `policy.confs` | `[amountFrom, confirmations]` pairs: how many Bitcoin confirmations the LP waits for, by amount |
| `policy.maxOfferAgeSecs` | an offer for a lock whose first confirmation is older than this is not answered (2 h in `config.render.json`; 1 h when unset). It is counted from the first confirmation, and a bridge of 1,000 TAC waits for three: with the blocks coming slowly the third can come after an hour, and an offer turned away then costs the user a day of locked Bitcoin. The pool deadline is four hours from the block that reached the confirmations, so an offer inside two hours leaves the user at least an hour and a half to claim |
| `policy.holdAgeSecs` | a hold for a lock older than this is let go to free the room (`maxOfferAgeSecs` when unset; 1 h in `config.render.json`). A later offer is still answered if the room is there when it comes |
| `lowFreeTac` | the provider tells its operator (an alert, below) when the TAC it holds free is under this, again each `alertSecs` while it stays low; unset for no alert |
| `lowEth` | the same for the ETH of its own address, in ETH (`"0.002"`): when the relay is not sending settles each one this address sends costs about 0.0002 ETH, and with none left the provider stops taking bridges. Unset for no alert |
| `mailboxPollSecs` | how often the board is read for requests left for this provider (3 s unless set; `config.render.json` sets 1): a request waits for the next read |
| `name`, `boards` | the name shown in the LP's ad (`Provider` and the first six hex digits of the claim key when there is none: two providers never share a name by default), and the boards it is on (URLs of `fastbridge-lp/board.mjs`): it posts its ad there every minute and answers the requests left for it, so a user finds it without its own URL |
| `alertSecs`, `tickSecs`, `port`, `origins` | alert interval, tick length, the HTTP face. `origins` names the pages that may call it (`https://tacit.finance`); never `["*"]` on a public provider |
| `trustProxy`, `clientIp` | where the client's address (its request allowance, below) is read. Off, it is the address that connected. Behind a proxy, `clientIp` says where the proxy puts it (`trustProxy` alone is the rule for Render, below) |

#### The client's address behind a proxy

Each proxy in front of the provider adds the address that connected to it to the end of `X-Forwarded-For`; anything before those entries is what the
client sent, and is not read. `clientIp: { "header": "x-forwarded-for", "hops": N, "proxies": … }` takes the entry `N` from the right, and with `proxies`
(`"cloudflare"`, or a list of address ranges such as `["10.0.0.0/8"]`) passes over an entry only when it is one of those proxies' addresses, so a request that
reached the server some other way is counted by the address that connected.

- **Render** (behind Cloudflare): Cloudflare adds the address it accepted, then Render adds the Cloudflare address it came from, so the client is 2 from the
  right: `{ "header": "x-forwarded-for", "hops": 2, "proxies": "cloudflare" }`, which is also what `trustProxy: true` alone means. The `config.*.json` files set it.
- **Your own proxy** (nginx, Caddy, a load balancer): it must add the connecting address to `X-Forwarded-For` (nginx `proxy_set_header X-Forwarded-For
  $proxy_add_x_forwarded_for;`, Caddy does by default) or replace it outright; the provider must not be reachable except through it. One proxy is `hops: 1`;
  the Render rule above gives the same answer behind one proxy that is not Cloudflare.
- **One header**: `{ "header": "cf-connecting-ip" }` reads a single address from a header the proxy always sets itself, replacing any a client sent. Name one
  only when that holds for every path to the server. `True-Client-IP` and `X-Real-IP` are not read unless named.

`GET /health` sixty-one times in a minute from one machine answers 429 on the last, whatever headers the requests carry; a provider that never answers 429 is
reading the wrong entry.

## Running it on Render

`worker-relay/Dockerfile.fastbridge-lp` builds the image and `worker-relay/render.yaml` has the service as a template (not created). The image runs
`fastbridge-lp/config.render.json`, and the knobs an operator turns are environment variables (`fastbridge-lp/lib/env-config.mjs`), so a change is a
restart, not a new image.

1. **The key.** `openssl rand -hex 32`, set as `FB_LP_KEY` in the dashboard. It is the provider's Bitcoin wallet and pool identity; keep an offline copy, and never put it in a repository, a chat or a log.
2. **First start.** Run the image once with `node fastbridge-lp/server.mjs --dry-run` as the Docker command (or the same on a machine): it answers `/info` and `/quote`, joins no board and advances no swap, and prints the Bitcoin address, the claim key and the pool account. On an empty disk the first read of the pool takes about two minutes (110 to 147 s measured), and the provider answers `/info` and posts its ad only after it; the scan is kept in `dataDir`, so a restart with the same disk reads in a few seconds (4 s measured). `/health` answers throughout.
3. **Fund it.** Send TAC (the ERC-20, on Ethereum) and a little ETH for gas to the pool account it printed. Once it is live (step 4) it shields the TAC by itself, a chunk at a time (see "Keeping it filled"), so the same goes for every top-up. To put TAC into the pool by hand instead (`"refill": false`), use `FB_LP_KEY=<key> node tools/fastbridge-lp-shield.mjs <TAC> --index 0 --send` (without `--send` it only checks, and `EXPECT_ADDRESS=<pool account>` stops a wrong key; a key's deposits are numbered from 0). What the provider holds in the pool is what it can lend. It needs no Bitcoin: each user's lock pays the fee of its take.
4. **Go live.** Remove `--dry-run`. It posts its ad on the boards in `config.render.json`, so `/fast/` finds it, and it takes any TAC the validator accepts, TAC out of the Bitcoin shielded pool included (see the last section).
5. **Watch it.** `/health` is the health check; set `FB_LP_ALERT_WEBHOOK` to be told of a swap that waits long, a failed tick or a lost claim (the alerts are listed under "Watching it").
6. **Tune it.** `FB_LP_TAKE_IN_LOCK=on` has the fee of your take locked with the user's lock (yours when the swap is done, theirs when it is not; off by default), `FB_LP_MIN_AMOUNT`, `FB_LP_MAX_AMOUNT`, `FB_LP_FEE_BPS`, `FB_LP_FLAT_FEE`, `FB_LP_NAME`, `FB_LP_BOARDS` (base units; 8 places for TAC), and `FB_LP_MAILBOX_POLL_SECS` (how often it reads the board for requests left for it; a user's quote waits for the next read, so 1 s answers sooner than the default 3 s; not under 1, the board takes 120 reads a minute from one address). `FB_LP_BTC_BASES` replaces the Bitcoin explorers (https esplora base URLs, comma separated, asked in order; one with a key or run by you goes first). `FB_LP_MAX_AMOUNT=0` stops new swaps and finishes the open ones.
7. **Rebalance by hand.** Bitcoin TAC builds up as the pool TAC drains; move back what the bridge can carry from the Bridge tab, signed in with the same key, when the pool balance runs low (see "Keeping it safe": not all of it can go). Until then the provider shows "full right now" and the page falls back to another provider.

## API

| | |
|---|---|
| `GET /health` | 200 while the last tick succeeded, 503 with the error otherwise |
| `GET /info` | the claim key, the asset pair, limits, windows, and `available`: the most it can take now |
| `POST /quote {amount}` | (`amount` a whole number of base units, as a decimal string) what the user pays on Bitcoin and receives in the pool, fixed for `validSecs`; it holds nothing |
| `POST /reserve {quoteId}` | holds the payout while the user builds and sends its lock (`reserve.perClient` at once for one client) |
| `POST /extend {quoteId, txid, lock}` | once the lock is on the network, holds the payout through its confirmation; for a lock of sats `lock` is `{T, lockerXonly}`, and the transaction must pay the quoted amount to the output those terms make |
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

## Keeping it filled

Each bridge a provider takes moves TAC out of its private pool balance, so it runs out. It says so (the `capacity` line in the log, an alert under
`lowFreeTac`, and a bridge too big for it waits on the board), and it brings in more itself, in two ways. The first is on unless the config says
`"refill": false`; the second needs a treasury in the config:

```json
"refill": { "treasury": "0x…", "lowWaterTac": 3000, "chunkTac": 5000, "maxPerDayTac": 20000 }
```

1. TAC that reaches its own address, from anyone, is shielded whatever it holds free: a chunk at a time, not less than `minShieldTac` (default 100),
   a minute apart until it is all in. TAC at the address lends nothing, and an operator who sent some and went to bed should find it working in
   the morning (40,000 TAC once sat at the address for twelve hours with nobody to shield it). Topping up is sending TAC to the address.
2. When the TAC it holds free (its pool balance less what is promised) falls under `lowWaterTac` and there is none at the address, a chunk is
   pulled from `treasury` with `transferFrom` and shielded. The treasury has to have approved the provider's address (`poolAccount`, printed at
   start) for an amount of TAC first; the provider can pull nothing beyond it, beyond what the treasury holds, beyond `chunkTac`, or beyond
   `maxPerDayTac` in a day. The treasury takes the permission back at any time with an approval of 0.

It needs ETH at its address for the pull, the deposit and a settle sent from it when the relay is not sending them (enough for about 1.5 million gas at twice the gas price of the moment; `minEth` sets a floor under that). Its sends take turns with the settles the provider sends itself from the same
address (one send at a time, each reading the nonce the one before left), so it does not wait for a quiet hour. An attempt that shielded is followed by the next after `afterShieldSecs` (default 60); one that failed, or found nothing to bring in, after `minIntervalSecs` (default 1800). Neither runs in a dry run, and the second needs a treasury in the config. A deposit whose settle fails stops it for good, with the deposit named in an alert: the TAC is
in the pool's hands until it is settled. Try it first with a small `chunkTac` (100) and a small approval.

## Selling the other way (off unless switched on)

Everything above takes TAC on Bitcoin and pays TAC in the pool. With `FB_LP_REVERSE=on` the same process also sells the other way: a user sends private
pool TAC and gets a TAC note on Bitcoin. The machines are the same ones turned around (`dapp/fastbridge-reverse-provider.js`, with `dapp/fastbridge-reverse-client.js`
as the user's side): the provider holds the secret, so it locks its Bitcoin note first; the user then locks pool TAC against the same secret; the provider's
claim of that lock shows the secret, and the user takes the Bitcoin note with it. A user that never locks costs the provider the note's time under the timelock (`csvBlocks`,
96 blocks by default, about 16 hours) and the fees of the lock and of taking the note back (96 and not fewer: the user's client wants the Bitcoin refund to open at least two hours after the Ethereum deadline it locks to, which is 72 blocks and not one more at five-minute blocks, so a lock of 72 had no margin when it confirmed and the user's lock waited for it); there is no bond, so what bounds it is `maxOpen` and `maxTac` (below). The pool TAC it is paid lands at its pool account, where the other direction lends from.

**It sells from a Bitcoin address of its own**, derived from `FB_LP_KEY` and printed at start (`reverseAddress`), and from nothing else. The main address holds
earnings, take-fee coins and, on a house provider, stock that a market maker lists by outpoint; a lock picks the smallest note that covers it and funds itself
from the largest plain-sat coins, so on that address it would spend a listed note or a proceeds coin (and the address has so many outputs that explorers refuse to
list it). The new address has what was put there on purpose and nothing else, so **to fund it, send a few plain sats to the reverse address (an ordinary Bitcoin send; they pay the locks' fees) and the TAC to either of its two TAC addresses (the
status tool below prints both)**. The reverse `tacit1` address takes TAC on Bitcoin as a plain transfer to the key's own address: the reverse side can sell it as it arrives.
The reverse `tcs1` address is a shielded (silent) address: TAC sent to it lands at a one-time address of the key, which the lock does not sign for and the reverse side does
not count, and once it has confirmed `tools/lp-run.sh normalize --txid <the id of that payment>` (`tools/fastbridge-lp-reverse-normalize.mjs`) moves it onto the reverse
address as a plain note (it says what it would move and sends nothing until it is run again with `--send` and the token it printed). Neither is a payment from the Pay
page, whose TAC goes into the shielded pool and comes out as pool-exit TAC, which cannot be bridged home. The reverse side refuses to start if the derived address were the
main one. What it can sell is the confirmed, plainly received TAC at that address.
The key is derived, so the address comes back from the same `FB_LP_KEY`, and so does the seed of its swaps (apart from the other direction's).
`tools/fastbridge-lp-reverse-status.mjs` (read only; the key in `FB_LP_KEY`, never printed) prints that address and the TAC notes and plain-sat coins at it, before
anything is switched on anywhere.

| variable | meaning (default) |
|---|---|
| `FB_LP_REVERSE` | `on` or `off` (off) |
| `FB_LP_REVERSE_FEE_BPS`, `_FLAT_FEE` | what it takes from the pool TAC sent, as the forward terms: a rate (0 to 500) and a flat part in base units (30 and 10000000) |
| `FB_LP_REVERSE_MIN_AMOUNT`, `_MAX_AMOUNT` | the pool TAC a user may send, base units (1000000000 and 100000000000) |
| `FB_LP_REVERSE_MAX_OPEN` | sends under way at once, 1 to 20 (2) |
| `FB_LP_REVERSE_MAX_TAC` | the most TAC out at once whatever is funded, up to 8 places (2000) |

The same keys under `reverse` in the config file work too (`enabled`, `feeBps`, `flatFee`, `minAmount`, `maxAmount`, `maxOpen`, `maxTac`, `csvBlocks`, `anyTac`,
`refreshSecs`, `validSecs`), and a value in the environment wins. The most a stream of requests can tie up is `maxOpen` sends, within `maxTac`, of what is at the
address: a quote holds nothing, a start takes the note out of what is offered, and a note in a swap is never lent twice. The records are in `dataDir/reverse/`
(`swaps`, `quotes`, `offers`, `evm-offers`); back up `reverse/swaps` as `swaps`.

| | |
|---|---|
| `GET /reverse/info` | the provider's key for the Bitcoin lock, the terms, `available` (the most pool TAC it can take now; `null` when it could not read its notes) and `open` |
| `POST /reverse/quote {amount, claimPub}` | what the user sends and the Bitcoin note it gets, fixed for `validSecs`; holds nothing |
| `POST /reverse/start {quoteId}` | locks the provider's Bitcoin note for the user |
| `GET /reverse/swap/:id`, `/offer` | the phase; the provider's lock offer once it is made |
| `POST /reverse/swap/:id/evm-offer {evmOffer}` | the user's pool lock, kept once it is in the pool and checked against the swap |

The provider's ad on the board carries a `reverse` member with the terms of this direction (`minAmount`, `maxAmount`, `available`, `feeBps`, `flatFee`, `csvBlocks`,
`evmWindowSecs`, read from `/reverse/info` every time the ad is posted; a provider with the side off posts the ad it always did), and the /fast/ page shows a "Send TAC to
Bitcoin" panel only when a provider's ad has one. Requests for it reach the provider through the board like the others. The TAC it sells is what sits at that address, so TAC
that came out of the Bitcoin shielded pool and could not be bridged home is sold on as it is (`anyTac`, as in the forward terms); the panel says so.
`--dry-run` leaves it off (the log says so).

## A provider of Bitcoin for ETH (pair mode)

`"pair": "btc-eth"` in the config (or `FB_LP_PAIR=btc-eth`) makes the process a provider of plain Bitcoin against private ETH in the pool, and nothing else: its ad
names the sats asset and the pool's ETH, which is how the swap tile finds it (`config.btc-eth.example.json`). Run it as a process of its own with a key of its
own; the TAC provider is not changed by it.

- **Forward, ETH for sats** (always on): a user locks sats in one ordinary transaction, the provider locks pool ETH for it, the user claims, the provider takes the
  sats. Its terms are in SATS (`quote.minAmount`, `maxAmount`, `flatFee`; `feeBps` of the amount). What it lends is its private ETH in the pool: send ETH to the `poolAccount` it prints, then
  `FB_LP_KEY=<key> node tools/fastbridge-lp-shield.mjs <ETH> --eth --index 0 --send` puts it into the pool as notes of the key (a little ETH stays at the address for gas;
  the first deposit of a key is index 0), and that is the inventory (`lowFreeEth` alerts before it runs short). A lock waits for the confirmations in `policy.confs`, a schedule in sats.
- **Reverse, sats for ETH** (`reverse.enabled`, off until switched on): the provider locks sats first from an address of its own, derived from the key, and the user
  locks pool ETH. Its terms are in pool ETH units (1e-8 ETH): the amount a user locks. Fund the address it prints with the plain coins it may sell
  (`maxSats` caps what is out at once, `maxOpen` the sends under way, `lockFeeReserve` what its coins must hold beyond an amount for the lock's fee).
- **The price** is not a number in the config. Both directions price from ETH per BTC, read every `rate.everySecs` from Chainlink's ETH / BTC aggregator (through the pool's
  RPC) and public exchange tickers, which must agree within `rate.maxSpreadBps`; the fee is on top. With no price (sources down or disagreeing) the provider quotes
  nothing and alerts, and a page checks every quote against its own reading of the market, so a mispriced provider is blocked by the page as well.
- A swap's take comes out of the lock itself, and a take that is slow is replaced by one that pays more (`policy.takeFeeFactor`, `takeBumpSecs`, `takeMaxFeeShare`).
- **A flat fee that follows costs** (`FB_LP_DYNAMIC_FEE=on`, off unless set; `lib/flatfee.mjs`). Off, each direction's flat part is its configured number
  (`FB_LP_FLAT_FEE`, `FB_LP_REVERSE_FLAT_FEE`). On, each is `FB_LP_FEE_SUBSIDY` (0 to 1, 0.5 unless set; 1 recovers the whole cost) of the provider's own estimated
  network cost per swap, read every 30 s: forward (sats) = 160 vB x the fee estimate (sat/vB) the provider already warms + the relay's fee for a pool note valued
  in sats at the current rate; reverse (pool units) = 160 vB x the fee estimate valued in pool units + the relay's fee for the claim. `FB_LP_FEE_SUBSIDY_UNTIL`
  (unix seconds or a date) ends the intro: from then the share is 1. The cost is smoothed (an exponential average) and the figure moves only when it is 10% off the one in
  use, then is held to `FB_LP_FLAT_FEE_MIN` / `_MAX` (`FB_LP_REVERSE_FLAT_FEE_MIN` / `_MAX`; 100 sats and 2000 units unless set) and never over 1.5% of the
  direction's least amount (nor over the 2.5% less the rate part), so the least swap stays under the page's 3% guard. With no fee estimate, relay fee or price for
  half an hour the configured flat fees apply again. A quote given is sealed with its amounts and never changes. `/info` carries `feeModel` (`dynamic`, `live`,
  `subsidy`, `costSats`, `costEthUnits`, `feeRate`, `flatFeeSats`, `reverseFlatFeeUnits`, `limits`), and `flatFee` in `/info` and on the board's ad is the figure in use.
- `--dry-run` answers `/info` and `/quote` and checks offers, sends nothing.

### Upkeep (pair mode)

A pair provider looks after its own inventory every `upkeep.tickSecs` (120): `lib/automation.mjs`, wired by `lib/automation-wire.mjs`. Each part has its own switch, and
everything it does is logged; a failure is alerted (at most hourly per kind).

- **Take coins to the reverse address** (`recycle`, on when the reverse side is on; `FB_LP_RECYCLE=off` stops it). The sats a BTC -> ETH take pays to the main address
  are moved to the reverse address, so they back ETH -> BTC swaps. Only coins that a take of this provider's finished swaps paid (read by the take's txid, never by listing
  the main address), plain P2WPKH outputs of the main key, confirmed, unspent, `minCoin`..`maxCoin` sats; never a coin a swap under way names. Several in one transaction to
  the reverse key's own address, at a fee rate two or more explorers agree on (`maxFeeRate` 25 sat/vB: above it, it waits), at least `minBatchSats` (150,000) with a fee of
  at most `maxFeeShareBps` (0.5%), at most `maxPerTickSats` (3,000,000) a move and `maxPerDaySats` (10,000,000) a day. RBF, replaced at a higher rate after `bumpSecs`.
  `keepSats` keeps that much of the coins at the main address. The first move after a start is only logged (a dry run).
- **The lean** (`skew`, on when the reverse side is on; `FB_LP_SKEW=off`). Holding much more ETH than its target share (`targetEthShare` 0.5, outside a `deadBand`
  of 0.1), the provider raises its one rate a few basis points (a user bringing BTC gets a little more ETH, one bringing ETH a little fewer sats), and lowers it the other
  way: at most `maxBps` (15), and never so far that a quote at the minimum, with its fee, stands more than `guardBps` (250) under the market (pages block 3%). `/info`
  says the lean of the moment (`skewBps`).
- **ETH notes** (`notes`; `FB_LP_NOTES_MERGE=off`). `/info` reports the free notes, their total and what one lock can draw (`usable`: the largest 16, less a cut). When
  there are `minNotes` (8) or more, or any under `dustEth` (0.002), the smallest 16 are merged into one note of the same key, when the relay's fee is at most `maxFeeBps`
  (0.25%), at most `maxPerDay` (3) a day, and only while no BTC -> ETH swap is under way.
- **Accounting.** Each quote keeps the market rate it was priced from; each finished swap adds its fee over that market (sats for BTC -> ETH, pool ETH for ETH -> BTC),
  its network costs (the Bitcoin fees of its take, lock or refund as the explorers report them; the relay's fee for a note cut or refund, estimated) and any loss.
  Swaps that ended before the accounting began are not counted. Kept in `dataDir/upkeep/stats.json`, shown in `/info`:
  `stats: { since, swaps, feesEarnedSats, feesEarnedEth, networkCostSats, networkCostEth, lossesSats, lossesEth, netEth, reinvestedEth, owedEth, capacity: { eth, sats, valueEth, firstValueEth, firstAt }, notes }`
  (ETH in pool units of 1e-8 ETH), with `target` and `buyback` beside it.
- **The target and buybacks** (`target`, `buyback`; `FB_LP_BUYBACK=on` to start, off unless set; `FB_LP_TARGET_ETH`). Under the target (`target.eth` of pool ETH, 10, and
  Bitcoin worth `target.btcAsEth`, 10, at the market) every swap's net stays as capacity (`reinvestedEth`). At the target with buybacks on, a swap's net is owed
  (`owedEth`) and sent to TacBuyback (`contracts/deployments/1.json`; no other address is accepted) as an unwrap of the provider's own pool ETH, only from what is over
  the target, at least `minSendEth` (0.01), at most `maxPerSendEth` (0.25) a send and `maxPerDayEth` (0.5) a day, and only while no BTC -> ETH swap is under way. The
  contract's keeper buys TAC with it for the reserve in its own small, spaced buys. `/info` `buyback: { on, to, startedAt, owedEth, routedEth, feesEth, sends, tacBought, lastTx, lastAt }`:
  `routedEth` is what reached the contract, `tacBought` (TAC wei) the provider's share of the contract's buys since its first send, pro rata to its part of the
  contract's ETH at each buy.
- **Rebalancing its two sides** (`lib/rebalance.mjs`; off unless `FB_LP_REBALANCE=dry` or `on`). Every ETH-for-BTC swap drains Bitcoin and every BTC-for-ETH swap drains ETH, so one side accrues. When the ETH share of what it holds (private notes, public ETH above the gas reserve, and its Bitcoin at the market) leaves a band around half (`FB_LP_REBALANCE_BAND_BPS`, 1500: outside 35 to 65 percent), it swaps the surplus toward the middle on the cheaper of THORChain and MAYAChain (native ETH and BTC, no wrapped tokens): it unshields the ETH it needs from its own notes, sends it from its own address to the venue's vault with the quote's memo, and the BTC lands at its own reverse address. A swap pays a fixed outbound fee, so small ones are dear: it swaps at least `FB_LP_REBALANCE_MIN_ETH` (0.15), at most `FB_LP_REBALANCE_MAX_ETH` (0.3) at a time and `FB_LP_REBALANCE_MAX_DAY_ETH` (0.6) a day, and takes no quote that costs over `FB_LP_REBALANCE_MAX_COST_BPS` (120) against the market. Nothing is sent to an address one source gave: Ethereum must vouch for the vault (the venue's router, pinned in the code, has paid out of it at least three times in the last ~30 hours, and the router the node names must be that one), and where two or more nodes answer they must agree on it; with nothing to vouch for the vault, two must agree (`FB_LP_REBALANCE_NODES_THORCHAIN` / `_MAYACHAIN` set the lists), trading on both chains open, and the memo a plain swap to its own address. With `FB_LP_REBALANCE_FRESH=on` (off unless set) the ETH it sells goes out of an address used for that swap only: unshielded from its own notes to a key derived from the provider's key and a counter (`fresh.next` in its state; always found again from the key and the count), which holds the swap and `FB_LP_REBALANCE_FRESH_GAS_ETH` (0.0015) for gas, so the venue never sees the pool account and the pool sees withdrawals to many addresses; what is left of the gas stays at that address. The ETH it buys comes to such an address too (its memo names it), is waited for there, and is shielded from it by the auto-shield through the same wrap counter and pending record as the pool account's own deposits (`shieldFrom` in lib/shield.mjs; the pool does not tie a native-ETH deposit to who sends it), keeping what a deposit's gas needs. A Bitcoin send that has not confirmed after `FB_LP_REBALANCE_BUMP_SECS` (1800) is replaced by the same transaction (the same inputs, so the two cannot both be paid) at a quarter over the market fee, up to `FB_LP_REBALANCE_MAX_BUMPS` (4) times and `FB_LP_REBALANCE_MAX_FEE_RATE` (25 sat/vB); whichever of them confirms closes the swap. A swap is closed only when the venue says it has paid out (its status API: the outbound signed, and whether it was a refund), the next waits `FB_LP_REBALANCE_COOLDOWN_SECS` (7200) after that, and nothing is planned while the auto-shield has a deposit on its way into the pool: until then what it bought is in neither the balances nor the notes, and the sides read lopsided (a second swap was made that way on 11-27, an hour after the first). A swap is made only when two looks in a row (`FB_LP_REBALANCE_CONFIRM_LOOKS`, 2) call for it, and the Bitcoin it counts includes coins on their way between its own addresses, so one odd reading of a balance is never acted on. One swap at a time, each step kept before it is done; a restart never sends twice, and one that may have gone out stops it and alerts. A venue that is halted (THORChain halts a chain while its blocks stall) is skipped and the other is used. Start with `dry`: it logs and alerts what it would do. Selling BTC for ETH works the same way the other direction does: the sats are spent from the reverse address only (its confirmed plain coins that no swap names, never leaving under `FB_LP_REBALANCE_KEEP_SATS`, 150000, for the ETH-for-BTC side), in one transaction to the venue's vault with the memo in an OP_RETURN, change back to the reverse address, at a fee of at most 1% of the send; the vault must show recent outbound payments (OUT: or REFUND: memos spending from it) on Bitcoin; the ETH lands at the pool account, where the auto-shield takes it. The signed transaction is kept before it is sent, and sent again as the same bytes after a restart.
- **Shielding its own ETH** (`lib/shield.mjs`; off unless `FB_LP_AUTO_SHIELD=on`). ETH sent to the pool account (`poolAccount`, the Ethereum address of the key) is plain
  ETH until it is deposited into the pool as private notes; with this on the provider does that itself, the step `tools/fastbridge-lp-shield.mjs <ETH> --eth --send` is by
  hand (the tool and the daemon share `lib/shield-core.mjs`). `FB_LP_SHIELD_RESERVE_ETH` (0.02, at least 0.0005) is the public ETH it never touches, for gas;
  `FB_LP_SHIELD_MIN_ETH` (0.02) the smallest deposit; `FB_LP_SHIELD_EVERY_SECS` (600) the least gap between deposits. It deposits the balance less the reserve (whole 1e-8 units),
  only while nothing is under way on the forward side (no open swap, hold or promise), one deposit at a time. Its state is `dataDir/upkeep/shield.json`
  (`nextIndex`, and `pending` with the index, amount, account nonce and transaction): the pending deposit is written before it is sent, so a restart waits for it and settles it, and
  never sends it again. The key's next wrap index is kept there; it is read from the pool's history (minutes) only when none is kept, once. Each deposit is first run as a call:
  one that would revert is not sent, and a used index (`DepositExists`) stops auto-shield with an alert, to read the history again at the next start. A deposit whose settle fails, or
  that reverted, also stops it with an alert (the deposit is on the chain, the restart settles it). ETH that falls by 0.01 or more with nothing of the provider's under way is alerted
  and skipped. One log line per action (`auto-shield: ...`); `/info` `refill.autoShield: { on, halted, pending, shielded }`.
- **Low-balance alerts** (always on; `lib/refill-watch.mjs`). Each goes through the alert (webhook, below), is said when it begins and again every four hours while it lasts, and
  once more, as an info, when it ends:
  `private ETH to lend is low` (free pool ETH under `FB_LP_ALERT_LOW_ETH`, 0.05: send ETH to `poolAccount`), `Bitcoin is low` (sats at the main and reverse addresses under
  `FB_LP_ALERT_LOW_SATS`, 100000: send BTC to the address named), `the pool account is under its gas reserve` (public ETH under the reserve: send ETH to `poolAccount`) and
  `ETH ... has sat unshielded` (public ETH over the reserve and the smallest deposit for 30 minutes with auto-shield off: run the tool or switch it on). `/info` shows the same
  as `refill: { poolAccount, btcAddresses, freeEth, lowEth, sats, lowSats, publicEth, gasReserveEth, minChunkEth, alerting, autoShield }` (ETH in ETH, no secrets).

To turn it on, the owner sets `FB_LP_AUTO_SHIELD=on` and `FB_LP_ALERT_WEBHOOK=<a Slack or Discord incoming-webhook URL>` in the service's environment on Render (a redeploy
applies them). With no webhook the alerts are in the log only.

## Watching it

`/health` for liveness. Alerts go to the log and, if `FB_LP_ALERT_WEBHOOK` is set, are POSTed there as JSON: the alert's own fields, and `text` and `content`, one readable
line for Slack and Discord incoming webhooks, so one of those can be the webhook as it is.

| alert | what it means | what to do |
|---|---|---|
| `a swap has waited long in taking` | the user's claim showed the secret, and the LP's Bitcoin take has not landed | check the explorers, the fee coins at the Bitcoin address and the fee rate. The take has to land before the user's timelock opens (about a day after its lock); the process keeps trying every tick, and a take that has confirmed ends the swap on the next one, so an alert means the take has not confirmed. `tools/fastbridge-lp-report.mjs` (run it yourself; it reads the Render logs) lists each swap not over with its last error |
| `a swap has waited long in refunding` | the LP's lock is past its deadline and the refund has not landed | check the relay and the node's connection; the note is the LP's own and waits safely |
| `a lock was claimed without revealing t` | a claim spent a lock without the signature that opens the Bitcoin | should not happen; stop quoting and look at the claim's settle before anything else |
| `a swap record cannot be read` | a file in `swaps/` is torn or corrupt and has no readable backup | restore it from the backup; the other swaps go on |
| `tick failed` in the log, `/health` 503 | a read of the store failed | the disk; the process retries on the next tick |
| `a reverse swap is waiting out its timelock to take its Bitcoin note back` | (reverse side) a user did not lock pool TAC for the note the provider locked | nothing: the note comes back to the reverse address after `csvBlocks`; the process takes it |
| `a reverse swap has waited long in claiming` (or `claimed`) | (reverse side) the user's pool lock is made and the provider's claim of it has not settled | check the relay and the pool account's ETH; the claim must land before the lock's deadline |
| `reverse: the notes at the reverse address could not be read` in the log | (reverse side) the scan of that address failed, so `/reverse/info` answers `available: null` and quotes are refused | the explorers; it is tried again after ten seconds |
| `the provider is running out of private TAC to lend` | the TAC held free is under `lowFreeTac` | shield more TAC to the pool account, or set up `refill` (above) |
| `the provider is running low on ETH for the settles it sends itself` | the ETH at the pool account is under `lowEth` | send ETH to `poolAccount`; if the relay keeps not sending settles, look at its settle wallet and its limits as well |
| `recycle: a coin of a move was spent by another transaction` | (pair upkeep) a take coin the provider was moving to its reverse address was spent elsewhere | only the main key signs for it: check what else runs on the key |
| `stats: ... ended with nothing received` | (pair upkeep) a swap ended with the provider paid nothing for what it gave | read the swap's record and its claim or lock before anything else |
| `buyback: a send that did not finish ... spent its note` | (pair upkeep) a buyback send was cut short and its note is spent | check the TacBuyback balance and the relay job; it was counted as sent |
| `bridges are waiting for a provider` | a want on a board this process is on, for its asset, that it has not seen before (read every five minutes). `largest` is the biggest; when any names a price, `payUpTo` is the highest and `atYourFee` how many of them (one that names none counts) this provider's fee already meets; `amounts` and `prices` (hundredths of a percent, or null) are in the JSON | raise `quote.maxAmount` or the TAC in the pool if it is more than this process can take; if `atYourFee` is under the count, a lower `feeBps` or flat fee meets the rest |

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
  from the Bridge tab, signed in with the same key. Not all of it can go: the bridge's proof cannot follow a note whose history passes
  through the Bitcoin shielded pool. `tools/fastbridge-lp-inventory.mjs` (read only; the key in `FB_LP_KEY`, never printed) opens the key's notes
  from the chain and asks the bridge's trace about each, so you can see how much of the Bitcoin TAC could come home and how much cannot.
  `tools/fastbridge-lp-bridge-home.mjs` then brings the notes the bridge can carry home over the regular bridge, note by note (`plan` checks and prices
  them and sends nothing; `start --send` begins them; `tick` moves them on until each is minted into the pool).
- **The claimer's prover** is the one remaining trust assumption (see the design doc): the process never proves the user's
  claim, and the user chooses who does.

## Tests

```
node tests/fastbridge-sim.test.mjs      # both machines against a simulated Bitcoin and pool
node tests/fastbridge-lp.test.mjs       # this service: API, quotes, store, explorer adapter, and swaps through all of it
node tests/fastbridge-reverse-service.test.mjs   # the reverse side: its service and the user's client over the same machines
node tests/fastbridge-lp-reverse.test.mjs      # what the process puts around it: its key, options, notes and routing
node tests/fastbridge-lp-upkeep.test.mjs       # a pair provider's upkeep: coin moves, accounting, the lean, note merges, buybacks
node tests/fastbridge-lp-rebalance.test.mjs    # the rebalancing: when it swaps, which venue, and that nothing goes to an address the nodes do not agree on
node tests/fastbridge-lp-wire.test.mjs         # the upkeep wired together starts (rebalancing, fresh addresses, auto-shield) with its dependencies stood in for
node tests/fastbridge-fork.mjs          # the Ethereum side against the live pool on a mainnet fork (needs anvil, FORK, EXEC)
```

## TAC out of the Bitcoin shielded pool

The daemon takes any TAC the note validator accepts, a note made by an exit from the Bitcoin shielded pool included, and says so in its terms
and ad (`anyTac: true`), so bridgers send it such notes. That TAC cannot be bridged home afterwards, only traded on Bitcoin. The daemon has no
option to refuse it; a provider run from the page's "Provide liquidity" panel has one.
