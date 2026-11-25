# Fast bridge liquidity provider

One process that sells TAC in the pool for TAC on Bitcoin, one swap at a time, without holding anyone's funds: it answers
quotes, checks each user's Bitcoin lock against the chain, locks a pool note of the same amount under the user's claim,
and takes the Bitcoin once the user's claim shows it the secret. The protocol is in [docs/FAST-BRIDGE.md](../docs/FAST-BRIDGE.md).

The process runs the Ethereum-locker machine (`dapp/fastbridge-el.js`) over a durable store. Everything it decides it
reads from the chains; the HTTP API only carries the user's offer in and the pool lock's offer out.

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

`FB_LP_MAX_AMOUNT=0` stops new swaps and finishes the open ones; to stop for good, wait for those to finish, then stop the process. Never run two forward swap services or two reverse swap services on one key; one LP process can host one of each. When rebalancing is enabled, run one lease-bound rebalancer only: it is the only authorised funding sidecar and must not be duplicated.
Try it first with `--dry-run`: it answers `/info` and `/quote`, takes nothing and shields nothing.

## What it needs

| | |
|---|---|
| Key | `FB_LP_KEY`, 32 bytes of hex, in the environment only. It is the LP's Bitcoin wallet, its pool identity and the root of its swap secrets. `openssl rand -hex 32` makes one. Keep an offline copy: the funds are only as safe as this key. |
| Bitcoin | Nothing: each user's lock pays the fee of the LP's take to the address printed at start (`takeSats` in the quote, twice the fee rate of the moment), and the take spends that output. Coins sent there are used as well, as a reserve when fees rise. |
| Pool | TAC notes owned by the pool identity printed at start (`poolAccount` is its Ethereum address). Shield TAC from that address, or by any route that ends in notes for this identity; the process finds its notes by scanning the pool with its key. A note of exactly the quoted amount is cut from a larger one when there is none, so a few big notes are enough. |
| Host | Node 22, the repository checked out, and its packages installed in both `worker-relay/` (the note validator needs jsdom) and `worker/` (the noble libraries it imports): `npm ci --omit=dev --ignore-scripts` in each, as the image does. Never run two forward or two reverse swap services on one key: duplicates can lock the same swap twice. The single lease-bound rebalancer is the only authorised funding sidecar and must not be duplicated. |
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
| `reserve.perClient`, `reserve.perBoard` | how many reservations with no lock named yet one client address holds at once (2), and the requests that come through a board together (4, as they name no address). A new one past that lets go of that client's oldest, so a user asking again is always answered; 0 for no limit |
| `inventory.refreshSecs` | how often the pool wallet's balance and the Bitcoin coins are read again (60 s) |
| `quote.minAmount`, `quote.maxAmount` | amounts in base units, both sides; set `maxAmount` below `minAmount` to stop quoting while open swaps finish |
| `quote.feeBps`, `quote.flatFee` | the LP's fee: a share of the amount plus a flat part in base units. The flat part covers the relay's fee (for cutting a note to size) and a little more: the user already pays the Bitcoin take in sats, inside its lock (`takeSats`), so it is not part of the fee. Keep it small: a fee over 5% of the amount is quoted by the fast page with a plain warning, and the front page's Bridge tab does not prefer it, so a flat fee of F TAC keeps every bridge under about 20 × F TAC out of the tab (a fee over 90% is not quoted at all) |
| `quote.validSecs`, `quote.rate` | how long a quote holds; `{num, den}` converts what is left after the fee (1/1 for one asset on both sides) |
| `quote.graceSecs`, `quote.lateSecs`, `quote.lateMoveBps` | how long after `validSecs` an offer is still answered at the quote. With a fixed `rate` (the TAC provider) the grace is all there is. A provider priced from the market answers after the grace only an offer whose lock it saw before the quote ran out (named to `/extend` in time, or confirmed in a block by then), up to `lateSecs` after it (6 h), and only while the price of the moment pays no more than `lateMoveBps` over the quote (100) |
| `traceRpcs` | the Ethereum nodes asked for a transaction's trace (`debug_traceTransaction` or `trace_transaction`), to read a claim settled through a contract other than the pool or its relayer; `FB_LP_TRACE_RPCS` (comma separated) wins. An own node goes first (the public ones that answer are the default) |
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
7. **Return ordinary receipts by hand.** Bitcoin TAC builds up as the pool TAC drains; move back what the ordinary bridge can carry from the Bridge tab, signed in with the same key, when the pool balance runs low (see "Keeping it safe": not all of it can go). The optional reverse-rebalance sidecar handles only leased long-history and shielded-pool-exit notes. It is standalone, is not started by the Render service, and needs its own command and persistent `dataDir`; see "Recovering stuck TAC with the reverse rebalancer". Until inventory returns, the provider shows "full right now" and the page falls back to another provider.

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
| `FB_LP_REVERSE_MAX_TAC` | the most TAC out at once whatever is funded, up to 8 places (2000); the service calls this cap `maxLocked` |
| `FB_LP_REVERSE_MIN_PROCEEDS_BPS` | least gross pool proceeds `E` against Bitcoin note `B`, enforced as `E*10000 >= B*minProceedsBps` at quote and first start: a whole number from 10000 to 1000000 (10000). The current client rejects `B > E`, so below-par sales cannot be accepted |
| `FB_LP_REVERSE_MAX_FEE_RATE` | optional positive sat/vB ceiling for new reverse quotes and first starts. An unavailable estimate or a rate above the ceiling refuses them; ticks that finish existing swaps do not consult it (unset) |

The same keys under `reverse` in the config file work too (`enabled`, `feeBps`, `flatFee`, `minAmount`, `maxAmount`, `maxOpen`, `maxTac`, `minProceedsBps`, `maxFeeRate`, `csvBlocks`, `anyTac`,
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

## Recovering stuck TAC with the reverse rebalancer

Ordinary clean receipts still return manually over the ordinary bridge, using the Bridge tab or `tools/fastbridge-lp-bridge-home.mjs` as described under "Keeping it safe". Long-history notes and exits from Bitcoin's shielded pool cannot use that route. The opt-in sidecar moves only leased whole notes of those classes to the derived reverse address, then the existing reverse service can sell them through the direct reverse atomic market for private Ethereum TAC. It does not use the literal sats order book. See [the Track B submission](../docs/STUCK-TAC-REVERSE-REBALANCE.md) for the accounting and validation boundary.

The submission's N table reports **gross private Ethereum TAC**, not quotable LP capacity. Native Bitcoin sats costs, pool exact-note cut fees and reserve requirements are excluded. Actual quotable capacity is lower and depends on those costs and outstanding reservations. Reverse `E-B` is gross spread, not net profit.

`fastbridge-lp/rebalance.mjs` is standalone. The LP server does not start it, and the local review UI controls neither process. Run at most one rebalancer for a key. Never run two forward swap services or two reverse swap services on one key. The lease-bound rebalancer is the only authorised funding sidecar; its process lock does not make a second copy with another `dataDir` safe.

### Configuration and leases

Merge this shape into `config.json`. Both `enabled` fields are required for live use. `FB_LP_REVERSE=on` and `FB_LP_REBALANCE=on` are their environment equivalents, and neither switch enables the other. Keep the existing top-level `dataDir`, `btcAsset`, `evmAsset`, `policy` and explorer settings.

```json
{
  "reverse": {
    "enabled": true,
    "feeBps": 30,
    "flatFee": "10000000",
    "minAmount": "1000000000",
    "maxAmount": "100000000000",
    "maxOpen": 2,
    "maxTac": "2000",
    "minProceedsBps": 10000,
    "maxFeeRate": 25,
    "rebalance": {
      "enabled": true,
      "leases": "fastbridge-lp/data/reverse/rebalance-leases.json",
      "maxNoteTac": "250",
      "maxDailyTac": "1000",
      "maxInventoryTac": "2000",
      "maxStuckTac": "2000",
      "maxFeeRate": 25,
      "minSourceConfs": 1,
      "tickSecs": 60,
      "stallSecs": 900
    }
  }
}
```

Create the manifest from `fastbridge-lp/rebalance-leases.example.json` and replace every placeholder outpoint. Its exact fields are:

```json
{
  "version": 1,
  "notes": [
    { "txid": "<64 hex>", "vout": 0, "amount": "2500000000" }
  ],
  "feeCoins": [
    { "txid": "<64 hex>", "vout": 2 }
  ]
}
```

`amount` is the note's exact TAC base-unit amount as a positive decimal string, not its small Bitcoin carrier value. Notes and fee coins must be confirmed, unspent outputs of the main Bitcoin address. A note output must be note-sized; a fee coin must contain 3,000 to 20,000 sats. `minSourceConfs` sets the required confirmations. Unknown fields, duplicate outpoints, a note also leased as a fee coin, and an amount that differs from the wallet's note are refused.

The manifest is the spending authority and the measurement boundary. Only its named note and fee-coin outpoints are exposed to the production funder. Unleased house notes cannot be selected and are not counted in `measuredStuckTac`. Do not lease an outpoint listed or reserved by another system. Each source and fee coin is checked before planning and again during outpoint exposure. That second read must return valid confirmation heights and the required source confirmations before planning can continue. The destination is always the derived reverse key, never an address from the manifest.

Lease authority is checked on selection, when a saved plan resumes, again before its broadcast and immediately before wallet execution. Removing a note or fee coin, or changing the leased note amount, halts a resumed selection without another broadcast. Restricted wallet views are serialised so concurrent runner instances cannot expose different outpoint sets to the shared wallet module.

The selector picks the smallest eligible whole note, with outpoint order as the tie-breaker. Only lineage `long` and `unprovable` with `through: "shielded"` pass. `tracked`, `traced`, other unprovable histories and unread lineage do not. The funding move uses plain mode, transfers the exact whole note and allows no TAC change. The production reverse service may combine notes and return change. New reverse swap records persist `amount: String(n.amount)` on every `noteInputs` entry, so partial-sale residuals can be reconstructed. Whole-note sales belong only to the economics fixture, not to that service's spending rules.

Run from the repository root with the same `FB_LP_CONFIG`, `FB_LP_DATA_DIR` and key for both live processes:

```sh
mkdir -p fastbridge-lp/data/reverse
cp fastbridge-lp/rebalance-leases.example.json fastbridge-lp/data/reverse/rebalance-leases.json
# Edit the manifest and config first. The example outpoints are placeholders.
export FB_LP_KEY=<64 hex>
export FB_LP_REVERSE=on
export FB_LP_REBALANCE=on
node fastbridge-lp/rebalance.mjs --dry-run
```

The dry run reads the configured wallet and chain services and reports any exact plan it finds, but sends nothing and writes no move journal, alert record or `status.json`. A failed dry-run tick returns a nonzero exit status. Start the live sidecar with the same environment:

```sh
node fastbridge-lp/rebalance.mjs
```

Then run the LP server in a separate terminal, also with both switches and the same key and config:

```sh
node fastbridge-lp/server.mjs
```

Starting the sidecar first gives the server's forward intake gate a status file to read. The server's own `--dry-run` still leaves the reverse service off; it does not substitute for the sidecar dry run.

### Floors, caps, journal and intake gate

For same-asset TAC sales, `E` is the buyer's gross private Ethereum amount and `B` is the Bitcoin TAC note value. The provider checks `E*10000 >= B*minProceedsBps` when pricing and again at first start. `minProceedsBps` is an integer from 10000 through 1000000, default 10000. Current reverse clients reject `B > E`, so v1 has no discount-sale route. At the default fee, `B = E - floor(E*30/10000) - 0.1`.

Production chooses the **greatest exact `E`** on the fee plateau, following the binary-search `maxInFor` convention. For `B = 100`, that plateau has one element, `E = 100.40120361`, so the N-table figures are unchanged. For `B = 996.9`, both `E = 999.99999999` and `E = 1000` produce exactly `B`; production chooses `1000`.

The sidecar solves the exact whole-note quote before admission. Malformed, inverted or nonpositive reverse terms, an amount with no exact quote and a proceeds floor that quote cannot reach all fail closed and leave the note out of eligible measured stock. Funding fee estimates require a live source, never the wallet's fallback. The exact accepted rate and `reverse.rebalance.maxFeeRate` travel in the persisted plan into `executeFund`; the real builder rejects an invalid or above-cap rate before a commit or reveal can be broadcast.

Capped reverse quotes and first starts independently call the production fee adapter with `allowStale: false`. A cached or stale answer cannot open a sale. On start, the exact accepted `feeRate` and `maxFeeRate` are passed into `bl.start`. The locker uses that supplied rate once, with no second estimate, and refuses an above-ceiling direct start before storing or broadcasting a lock. The same `reverse.maxFeeRate` setting reaches BTC-ETH pair reverse options; no same-asset TAC proceeds floor is mapped onto sats/ETH units. Existing reverse swaps continue ticking regardless of these new-sale fee gates.

The environment variables for the sidecar are:

| variable | meaning |
|---|---|
| `FB_LP_REBALANCE` | `on` or `off` (off). Live moves and the forward gate also require `FB_LP_REVERSE=on` |
| `FB_LP_REBALANCE_LEASES` | path to the version 1 lease manifest; required by the enabled sidecar |
| `FB_LP_REBALANCE_MAX_NOTE_TAC` | largest whole note one funding move may select |
| `FB_LP_REBALANCE_MAX_DAILY_TAC` | most TAC in funding-selection commitments by `selectedAt` in one UTC day, including pending, done and ambiguous halted journals. A move consumes this allowance even if it never finds a buyer |
| `FB_LP_REBALANCE_MAX_INVENTORY_TAC` | most unsold reverse stock, unresolved funding amounts and active-sale exposure after adding the candidate; this is a move-admission cap, not the forward circuit |
| `FB_LP_REBALANCE_MAX_STUCK_TAC` | forward circuit ceiling, required for live use. Measured stuck TAC is eligible leased main candidates plus unsold reverse stock, unresolved funding and active-sale exposure. Unleased house notes and unread-lineage candidates are excluded |
| `FB_LP_REBALANCE_MAX_FEE_RATE` | positive sat/vB ceiling for a funding move. An unavailable estimate or a higher rate selects nothing |
| `FB_LP_REBALANCE_MIN_SOURCE_CONFS` | confirmations required for leased sources and for reconciling the destination, 1 to 1000 (1) |
| `FB_LP_REBALANCE_STALL_SECS` | no-completed-recovery interval used by status, 1 to 86400 seconds; the example sets 900 |

All TAC cap values are positive decimal TAC strings with at most eight places. `reverse.rebalance.tickSecs` sets the sidecar period and the gate freshness window, `max(3*tickSecs, 60)` seconds; it has no `FB_LP_REBALANCE_TICK_SECS` environment variable. The top-level `alertSecs` throttles sidecar alerts (3600 by default). Reverse `maxOpen` limits active sales and `maxLocked`, set through `maxTac`, limits their combined Bitcoin TAC. Reverse `maxFeeRate` and rebalancer `maxFeeRate` are independent ceilings.

Live records are under `dataDir/rebalance/`. The funding journal uses strict primary-only storage: it never restores a move state from `.bak`. A torn or missing primary, an unreadable journal or an orphaned backup fails the tick closed. The sidecar also reads `dataDir/reverse/swaps` through a strict primary-only store. The reverse service itself retains the ordinary store, whose backup reads remain available, but any reported problem closes new sales. Every tick reads reverse inventory before reading the reverse journal, so a sale written after the inventory snapshot is still represented by its journal.

Each move follows `selected -> broadcasting -> moved -> done`, or `halted`:

- `selected` persists the exact source, fee coin, amount and derived destination before execution and can be resumed after a stop before broadcast, subject to the lease rechecks above.
- `broadcasting` records the attempt before entering the wallet. An execution error, or finding this state on a later tick or restart, makes the outpoint `halted` because the outcome is uncertain.
- `moved` records the returned reveal transaction id. It becomes `done` when that transaction spent the source, has the required confirmations, and produced the exact whole note. Evidence can be the visible reverse note or a reverse swap record that already consumed it, so an early sale does not strand funding reconciliation. Funding `done` is not a completed recovery.
- A `done` record is monitored. Contradictory source, confirmation, destination or amount evidence makes it `halted` with exposure restored for manual reconciliation. A transient or unreadable monitor result leaves it `done` and retries on a later tick instead of permanently halting it.
- `halted` is not retried automatically, even if the destination later becomes visible. Any ambiguous halt with `broadcastAttempted: true` blocks **all** new funding selections, not only that outpoint, and closes forward intake. Existing `moved` records still reconcile.

For a halted broadcast, reconcile the source outspend, reveal transaction, reverse swap journal and reverse wallet by hand using chain and wallet evidence. Preserve the journal and verify the transaction id, destination and amount before considering any offline journal repair. This entry has no reconciliation CLI and no automatic transition out of `halted`. Do not delete the record or broadcast the note again to clear the circuit.

`dataDir/rebalance/status.json` reports `measuredStuckTac`, `maxStuckTac`, `intakeAllowed`, `intakeReason`, `stalled`, `stallReason`, `newFundingAllowed`, `haltedOutpoints`, `activeReverseSwapTac`, `lastSaleAt`, `watchSince`, `exposureItems`, `exposureUnknown`, `unknownExposure`, `unconfirmedReverseStockBaseUnits` and `buyerDemandGuaranteed: false`. `unconfirmedReverseStockBaseUnits` is the unconfirmed subset already included in reverse stock, not an additional amount. The stuck ceiling trips strictly above the configured value. A dry run writes none of this state.

Status reads reverse inventory before `dataDir/reverse/swaps`. Visible unsold notes, unresolved funding amounts and active-sale amounts are allocated once. A partial sale leaves its residual in pending exposure until visible change represents it. Unconfirmed change remains in exposure and is reported by `unconfirmedReverseStockBaseUnits`. `includeUnconfirmed` is for this accounting only: it never makes a note sellable or sufficient to complete `moved` reconciliation. The reverse service's ordinary inventory call still requires confirmed notes.

Completed-sale inputs leave visible stock. An exact refund at its new outpoint is stock rather than another active exposure, while a missing or mismatched refund remains exposure. Reuse follows the follow-on lifecycle: once another swap consumes that refund outpoint, the later active, done or refunded record represents the value instead of the old refund. Unread lineage remains residual operational risk but is excluded from eligible measured stock.

Historical reverse records can lack input amounts. A funding-journal link or current inventory can supply the amount; an unlinked input with no learnable amount is a fail-closed compatibility boundary, not zero change. Status sets `exposureUnknown: true`, lists each input in `unknownExposure` with `reason: "reverse_input_amount_unknown"`, sets `intakeAllowed: false` and `newFundingAllowed: false`, and reports `intakeReason` and `stallReason` as `reverse_input_amount_unknown`. Selection refuses admission with `reverse_exposure_unknown`, and the pre-broadcast recheck refuses it again with the latest inventory and journals. Existing reverse swaps can still finish under the reverse service.

Known unlinked residuals appear as `unlinked:` entries in `pendingItems`. Unknown inputs appear as `unknown:` entries, never as evidence of zero exposure. To reconcile, stop the sidecar and inspect the listed `swapId`, `inputIndex` and outpoint. Establish the original private TAC amount from the lock transaction and wallet evidence, not the dust carrier value or sale amount. With a backup made, add that exact base-unit decimal string as `amount` on the correct historical `noteInputs[index]` in the primary reverse journal. Do not delete the record, invent zero change or force the intake flags open. Resume and verify `exposureUnknown: false`, the residual counted once, and fresh status before relying on intake. There is no reconciliation CLI.

Only a completed reverse sale resets the recovery clock through `lastSaleAt`. Funding completion and refunds do not count as sales. New exposure receives a full `stallSecs` watch interval, even after an older sale. The `measurementScope` string remains `eligible_leased_main_candidates_plus_reverse_stock_and_pending`; here `pending` includes active-sale exposure, although the status fields `pendingTac` and `activeReverseSwapTac` report it separately.

With both switches enabled on the live, non-pair server, every new forward quote and availability calculation reads this status. The gate requires `kind: "status"`, `id: "status"`, `enabled: true`, `dryRun: false`, a supported measurement scope when present, exact agreement between each TAC text field and its base-unit duplicate, and a `maxStuckTac` ceiling that matches the server's configured value. Missing, unreadable, malformed, wrong-version, non-live, mismatched, future, stale or denied status returns zero availability and a retryable 503. The same happens when measured stuck TAC exceeds its ceiling or the sidecar reports a stall. The gate affects new quotes only: existing reservations, offers, ticks and claims never read it, so existing swaps can finish. If the sidecar stops, its status becomes stale and forward intake closes. Without the opt-in gate, existing provider behaviour is unchanged.

The sidecar has no HTTP health endpoint. Monitor its process, logs and `status.json`. `/health` remains the forward service's tick health; `/reverse/info` exposes reverse-service blockers under `health`. Sidecar and reverse alerts use the existing log and `FB_LP_ALERT_WEBHOOK` route. A stuck-ceiling or no-progress decision is visible in status and enforced by the gate; it is not a separate webhook alert.

### Backup and safe shutdown

Back up the lease manifest, `dataDir/rebalance/` and `dataDir/rebalance-wallet-cache.json` continuously, along with `dataDir/swaps/` and `dataDir/reverse/swaps/`. Both store types write atomically and keep the previous record as `.bak`, but that does not protect against a lost disk. The sidecar's funding and reverse-journal readers are strict and reserve backups for manual recovery; neither restores them automatically. The reverse service can read an ordinary-store backup, but any remaining problem closes new sales.

`rebalance/` contains move journals, alert throttle records and `status.json`; `rebalance.pid` is only the single-process lock. **Every pre-existing `rebalance.pid` blocks startup.** There is no automatic stale reclaim, including for a valid dead PID or an empty, partial or invalid file. Verify that no sidecar is running, then remove the file manually before restarting.

To stop the whole provider, first set `FB_LP_MAX_AMOUNT=0` and `FB_LP_REVERSE_MAX_AMOUNT=0` and restart the server, with both enable switches left on and the sidecar still running. This refuses new forward and reverse sales while existing swaps finish. After those swaps finish, restart only the sidecar with `FB_LP_REBALANCE=off` and the same key, config and `FB_LP_REVERSE=on`. Leave the server's switches unchanged. The disabled sidecar makes no new selection and does not broadcast a saved `selected` plan, but still reconciles `moved` records. Its denied status also keeps gated forward intake closed.

Wait for a completed sidecar tick with no `broadcasting` or `moved` record and an empty `haltedOutpoints` list. A `selected` record has not been broadcast and can remain for a later, explicitly enabled run. Stop the sidecar, then the server.

The sidecar's signal handler does not drain an active funding tick. Do not signal it during one. If a stop leaves `broadcasting`, the next sidecar tick marks it `halted` for manual reconciliation rather than risking a second broadcast. Operational downtime can therefore delay recovery and, while the gate is enabled, pause new forward quotes.

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
  `reverse.maxFeeRate` or `FB_LP_REVERSE_MAX_FEE_RATE` also applies to pair reverse quotes and first starts, which require a fresh fee estimate with no stale fallback. The TAC-only `minProceedsBps` comparison is not applied to these different units.
- **The price** is not a number in the config. Both directions price from ETH per BTC, read every `rate.everySecs` from Chainlink's ETH / BTC aggregator (through the pool's
  RPC) and public exchange tickers, which must agree within `rate.maxSpreadBps`; the fee is on top. With no price (sources down or disagreeing) the provider quotes
  nothing and alerts, and a page checks every quote against its own reading of the market, so a mispriced provider is blocked by the page as well.
- A swap's take comes out of the lock itself, and a take that is slow is replaced by one that pays more (`policy.takeFeeFactor`, `takeBumpSecs`, `takeMaxFeeShare`).
- `--dry-run` answers `/info` and `/quote` and checks offers, sends nothing.

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
| `a reverse swap record cannot be read; new sales are paused` | a reverse record is unreadable, while readable swaps keep ticking | restore the record from backup; new quotes and first starts resume after a clean read |
| `a reverse tick failed; new sales are paused` | the reverse service reports `tickOk: false` in its health summary; the daemon uses the same failure path without duplicating the service alert | inspect the logged error. A clean summary reopens sales, and the daemon emits `reverse tick recovered` after a failed state |
| `new reverse sales are paused because the Bitcoin fee rate cannot be read`, or `by the Bitcoin fee ceiling` | the reverse fee estimate is unavailable or above `reverse.maxFeeRate` | restore the fee source or wait for a rate within the ceiling. Existing swaps keep ticking |
| `reverse: the notes at the reverse address could not be read` in the log, or `the reverse inventory cannot be read` | (reverse side) the scan of that address failed, so `/reverse/info` answers `available: null` and quotes are refused | the explorers; it is tried again after ten seconds |
| `reverse rebalance source check:` or `fee-coin check:` | a leased source or fee coin needs operator attention, such as an unread transaction or wrong address | inspect the named outpoint and explorers. Spent, unconfirmed and ineligible outputs are not moved, though ordinary spent or unconfirmed exclusions do not raise this alert |
| `reverse rebalance cannot read note lineage`, or `lineage read failed` | lineage could not be established, so the affected note is skipped | restore the lineage source; the note remains excluded until its verdict is eligible |
| `leased note amount does not match the wallet note or would create change` | the lease amount is not the exact spendable whole-note amount | correct or remove the bad lease. The sidecar skips it rather than making a partial move |
| `reverse rebalance halted this outpoint`, or `found a broadcasting journal after restart` | a funding broadcast has an uncertain outcome and the outpoint is permanently halted pending manual work | follow the reconciliation steps in "Recovering stuck TAC with the reverse rebalancer"; never rebroadcast it automatically. Every new funding selection is blocked |
| `reverse rebalance lease revoked for a selected plan` | a saved note or fee coin is no longer authorised, or its amount changed | restore the intended lease only after reviewing the plan. The halted selection was not broadcast again |
| `a completed funding record lost or changed its chain evidence` | a `done` source spend, confirmation or destination changed, potentially after a reorganisation | reconcile manually. Exposure is restored and all new funding stops; the original source is not rebroadcast |
| `a completed funding record cannot be read just now; it remains done and will be checked again` | a done-monitor read is temporarily unavailable or malformed | the record stays `done` and retries. It becomes a manual halt only on contradictory chain evidence, not on this transient alert |
| `reverse rebalance cannot reconcile a moved note yet` | a returned transaction id cannot yet be matched to the source spend, confirmed destination and exact reverse inventory or swap record | inspect the explorers, reverse swap journal and reverse wallet. The record stays `moved`, with no second send |
| `reverse rebalance tick failed` in the log | the standalone sidecar tick threw before completing its status update | inspect the sidecar process and log. With the forward gate enabled, stale or missing status soon closes new forward quotes while existing swaps continue |
| `the provider is running out of private TAC to lend` | the TAC held free is under `lowFreeTac` | shield more TAC to the pool account, or set up `refill` (above) |
| `the provider is running low on ETH for the settles it sends itself` | the ETH at the pool account is under `lowEth` | send ETH to `poolAccount`; if the relay keeps not sending settles, look at its settle wallet and its limits as well |
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
- **Do not duplicate swap services or the funding sidecar on one key.** Never run two forward swap services or two reverse swap services on one key; one LP process can host one of each. The single lease-bound rebalancer is the only authorised funding sidecar and must not be duplicated.
- **Ordinary returns are manual; reverse recovery is opt in.** Bitcoin TAC builds up as the pool TAC drains. Move clean receipts back over the reflection bridge
  from the Bridge tab, signed in with the same key. Not all of it can go: the bridge's proof cannot follow a note whose history passes
  through the Bitcoin shielded pool. `tools/fastbridge-lp-inventory.mjs` (read only; the key in `FB_LP_KEY`, never printed) opens the key's notes
  from the chain and asks the bridge's trace about each, so you can see how much of the Bitcoin TAC could come home and how much cannot.
  `tools/fastbridge-lp-bridge-home.mjs` then brings the notes the bridge can carry home over the regular bridge, note by note (`plan` checks and prices
  them and sends nothing; `start --send` begins them; `tick` moves them on until each is minted into the pool). For eligible stuck notes, the standalone sidecar in "Recovering stuck TAC with the reverse rebalancer" is the alternative. It moves only leased whole notes to the reverse wallet and never starts from the LP server itself.
- **The claimer's prover** is the one remaining trust assumption (see the design doc): the process never proves the user's
  claim, and the user chooses who does.

## Tests

```
node tests/fastbridge-sim.test.mjs      # both machines against a simulated Bitcoin and pool
node tests/fastbridge-lp.test.mjs       # API, quotes, store, explorer adapter, and swaps through all of it
node tests/fastbridge-reverse.test.mjs  # reverse end to end over the real state machines and simulated chains
node tests/fastbridge-reverse-service.test.mjs   # reverse service and user client over the same machines
node tests/fastbridge-lp-reverse.test.mjs      # key, options, notes, routing and daemon wiring
node tests/fastbridge-lp-reverse-fund.test.mjs   # restricted funder planning and builder fee arguments
node tests/fastbridge-lp-reverse-rebalance.test.mjs   # sidecar, strict journal, sales and real funder functions
node tests/fastbridge-lp-rebalance-gate.test.mjs      # fail-closed forward intake while existing swaps finish
node tests/tacit-rebalance-fee.test.mjs               # live-source fee reads and real builder ceiling preflight
node tests/fastbridge-reverse-fee-adapter.test.mjs    # production adapter freshness with a mock esplora
node tests/fastbridge-lp-pair.test.mjs                # pair options, including the reverse fee ceiling
node tests/stuck-tac-scenarios.test.mjs               # deterministic economics suites
node tests/stuck-tac-production-parity.test.mjs       # production quoter, greatest-E plateau and full reverse B/E parity
node tests/stuck-tac-page.test.mjs                    # real browser UI, keyboard access and responsive layouts
node tests/fastbridge-lp-env.test.mjs                  # environment overrides and validation
node tests/fastbridge-fork.mjs          # the Ethereum side against the live pool on a mainnet fork (needs anvil, FORK, EXEC)
```

The rebalancer suite executes its real state machine and the production funder's `planFund` and `executeFund` against fake chains and wallets, including strict storage, lease revocation, builder caps, inventory/journal ordering, follow-on refunds, monitor retries, partial-sale residuals, unlinked amounts and fail-closed unknown historical exposure. The reverse end-to-end and service suites run the real swap state machines, provider and client over simulated chains, including exact input amounts, legacy records without them, and the exact accepted start fee with no second estimate. Production parity checks the actual forward quoter, greatest-`E` plateau convention and the published `B = 100`, `E = 100.40120361` reverse swap through the full service. The fee suites exercise the real builder preflight and production esplora adapter without a funded wallet. No funded mainnet or signet TAC reverse sale, live sidecar CLI run or real reorganisation test is claimed.

The local review UI is a separate, memory-only economics simulation:

```
npm run serve
# open http://127.0.0.1:8787/stuck-tac-review/
# if occupied, choose a free port, for example: PORT=8788 npm run serve
# then open http://127.0.0.1:8788/stuck-tac-review/
```

It loads no keys, chain connections, persistent storage or production modules. It neither starts nor controls the server or sidecar, and its buyers, quotes and outcomes are not live demand evidence. The fixture excludes lease admission and revocation, `maxNoteTac`, `maxInventoryTac`, `maxOpen`, `maxLocked`, pool exact-note cut costs, reservations and native sats. Whole-note sales are an economics assumption only. `B-06` is a time-driven, sale-aware simulation, not evidence for a production three-poll mechanism.

`node tests/stuck-tac-page.test.mjs` starts its own loopback server on an ephemeral port, so it needs neither `npm run serve` nor `PORT`. `PLAYWRIGHT` overrides the module passed to `require` (default `playwright-core`). `CHROME` and then `CHROME_PATH` select the first existing browser executable. Without them, the test tries the existing macOS Chrome and Chromium application paths, then falls back to Playwright's default browser. The browser test checks the UI, keyboard access, validation and responsive layouts, and refuses remote requests or page errors.

## TAC out of the Bitcoin shielded pool

The daemon takes any TAC the note validator accepts, a note made by an exit from the Bitcoin shielded pool included, and says so in its terms
and ad (`anyTac: true`), so bridgers send it such notes. That TAC cannot be bridged home afterwards, only traded on Bitcoin. The daemon has no
option to refuse it; a provider run from the page's "Provide liquidity" panel has one.
