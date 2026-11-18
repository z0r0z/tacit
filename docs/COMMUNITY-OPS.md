# Community ops

Bitcoin's state reaches Ethereum through calls anyone can make: block headers into the header relay, proofs of
each batch into the pool, and the open board's settles into the pool for the fees their proofs pay. Tacit's own
services make every one of them. So can you, from a browser wallet on
[tacit.finance/prove](https://tacit.finance/prove/) (its Relay and Bitcoin tabs), or from your own machine with one key and the
**community runner**, [`tools/community-runner.mjs`](../tools/community-runner.mjs).

The page and the runner build the same calls from the same modules:
[`dapp/header-relay-advance.js`](../dapp/header-relay-advance.js) for headers and
[`dapp/community-ops.js`](../dapp/community-ops.js) for proofs and the board.

## Run it

Node 22 or later. Node 20 runs everything but the Nostr board unless started with `--experimental-websocket`.

```sh
git clone https://github.com/src-company/tacit
cd tacit && npm ci --omit=dev
DRY_RUN=1 ONCE=1 node tools/community-runner.mjs           # what it would send now; no key needed
RUNNER_KEY=0x… node tools/community-runner.mjs             # all three modes, each on its own loop
RUNNER_KEY=0x… node tools/community-runner.mjs settles     # one mode: headers, attest or settles
node tools/community-runner.mjs mirror                       # keep the board public on Nostr; no key, no gas
FORWARD_URL=https://your.host node tools/community-runner.mjs forward   # carry private requests; no key, no gas (needs a public https address)
```

Use a fresh key that holds only ETH for gas. The board pays its fees to the sending account, and an account with
code (an EIP-7702 delegation) runs that code on them; the runner says so at start when the key has code.

| env | default | |
|---|---|---|
| `RUNNER_KEY` | | The account that signs, pays the gas and is paid the board's fees. Not needed with `DRY_RUN=1`. |
| `RPC_URL` | `https://ethereum-rpc.publicnode.com` | Reads and simulation. |
| `SEND_RPC_URL` | `https://rpc.flashbots.net/fast?hint=hash` | Where signed transactions go. Flashbots Protect does not include a transaction that would revert, and keeps it out of the public mempool. |
| `API_BASE` | `https://api.tacit.finance` | Published proofs, the board, landings. |
| `ESPLORA_URL` | `https://blockstream.info/api` | Bitcoin's headers. |
| `DRY_RUN=1` | | Simulate and print what would be sent; send nothing. |
| `ONCE=1` | | One pass of each mode, then exit (status 1 if a pass failed). |
| `HEADERS_SECS` `ATTEST_SECS` `SETTLES_SECS` | 300, 60, 15 | Each mode's cadence. A pass that sent something, or passed over a job the pool refused, runs again at once. |
| `HEADERS_MIN_BEHIND` | 3 | See *headers*. |
| `HEADERS_NEED` | | A Bitcoin height to carry the relay to, whatever the pacing: a cBTC lock's or bridge deposit's block + 24. |
| `ATTEST_AFTER_SECS` | 120 | See *attest*. |
| `MARGIN_BPS` | 2000 | See *settles*. |
| `NOSTR` | 1 | Read and copy the board on public Nostr relays (see *settles*). 0: the API's board alone. |
| `NOSTR_RELAYS` | `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`, `wss://offchain.pub` | Comma separated. |
| `MAX_GAS_GWEI` | 5 | Headers, attests and ancestry calls wait while the base fee is above this. 0 turns the ceiling off. |
| `PRIORITY_GWEI` | 0.1 | The tip each transaction offers. |

Every transaction is run against the latest block from the runner's own address before it is signed, and its gas
limit comes from the node's estimate. Transactions go one at a time; each is waited for (up to 3 minutes) before
the next. Work someone else finished meanwhile is passed over: a header batch already on the relay, a proof the
pool has moved past, a settle another sender landed.

## Modes

### headers

Sends Bitcoin's block headers, read from the explorer, to `BitcoinLightRelay.advanceTip`, at most 40 a
transaction. The relay checks each header's proof of work, and the runner refuses to extend a relay whose tip is
not the explorer's block at that height (a fork needs an operator).

- **When.** The next proof is waiting on the relay (the relay has not confirmed past the proven block) and the relay
  is at least `HEADERS_MIN_BEHIND` blocks behind Bitcoin's tip less 2. Tacit's own relay usually keeps within a
  block or two, so the runner sends when it falls behind. It advances as far as the reflection can use soon:
  Bitcoin's tip less 2, or the proven block + 24 + 110, whichever is lower.
- **Costs.** About 92,000 gas a transaction plus 172,000 a header (15 headers estimated 2.68 million gas).
- **Earns.** Nothing on chain. It keeps bridge deposits and cBTC locks moving.

### attest

Lands a proof of Bitcoin's state that Tacit's prover has published (`GET /reflection/proof`) and not landed, with
`ConfidentialPool.attestBitcoinStateProven(publicValues, proof)`.

- **When.** The proof still builds on the pool's attested digest, and it was published at least
  `ATTEST_AFTER_SECS` ago. Tacit's prover lands its own proofs, usually within that time.
- **Ancestry.** While the proofs are more than 2,016 blocks behind the relay's confirmed tip, no batch can reach
  them, so this mode calls `advanceReflectionAncestry()` first: each call walks up to 2,016 of the relay's blocks
  toward a checkpoint the next batch can build on, and the runner calls it until the gap closes.
- **Costs.** An attest uses about 0.4 to 0.6 million gas (a recent one used 419,593). An ancestry call walks up to
  2,016 relay blocks and costs more; its estimate is logged before it is sent.
- **Earns.** Nothing on chain. Bridge deposits up to the proven block can mint once it lands.

### settles

Sends the open board's settles with `ConfidentialPool.settle(publicValues, proof, memos)`. The board is read from
two places, and either one alone is enough:

- Tacit's API (`GET /confidential/open`, see [OPEN-RELAYER.md](./OPEN-RELAYER.md)). A landing is reported back
  (`POST /confidential/landed`).
- Public Nostr relays: proofs that holders, /prove/ tabs and other runners posted there
  ([`dapp/nostr-board.js`](../dapp/nostr-board.js)). Each pass also copies the API's open jobs that no relay carries
  yet, so the board stays public if the API stops answering. A job read from Nostr alone needs no report: the chain
  is its record.

- **When.** A job is open (no other sender has taken it), whole, and more than two minutes from its deadline, by
  the latest block's time. Of those, the runner takes the oldest whose fee pays its gas with `MARGIN_BPS` to
  spare: first at 600,000 gas, then again at the job's own estimate. A job the pool refuses in simulation is passed
  over for ten minutes.
- **What a fee is worth.** tETH legs at their face value in ETH. TAC legs at 80% of the TAC/tETH pool's spot price,
  read from the pool's reserves at most once a minute. The discount covers the price risk of being paid in TAC.
  Moving that price far enough to fool a sender costs more than the gas a sender could lose.
- **Costs.** A recent transfer's settle used 348,054 gas; the runner prices a job at 600,000 before its own estimate.
- **Earns.** Each fee leg the proof binds, paid to the sending account inside the same transaction: tETH legs as
  ETH, TAC legs as TAC. A fork of mainnet replaying a real settle paid the runner its 0.0062 ETH fee less 0.000084 ETH
  of gas. Legs in other assets are paid too but are not counted when choosing what to send. Jobs reach the board when
  Tacit's relay has proved a settle it is not sending yet, or when a holder posts a proof made with their own prover
  (tacit.finance offers this when its relay is not proving: the holder's computer proves the action with a fee for
  its sender). Tacit's relay sends its own as soon as it can, so the first sender is paid.
- The board API allows a burst of 30 reads and one every 2 seconds after that, per IP address.

### mirror (opt-in, not part of `all`)

Copies the API's open jobs to the Nostr relays, as *settles* does on each pass, and sends nothing. It needs no key
and no gas, so anyone can keep the board public. Up to four jobs a minute, each posted once an hour.

### forward (opt-in, not part of `all`)

A forwarder for the EVM pool's private route (docs/EVM-POOL.md, "Private route"). A wallet seals each request to a keeper's gateway key and sends
it to a forwarder; the forwarder hands it to the keeper's `POST /sealed` and returns the sealed answer. It sees the sender's address and the size and
time of each envelope, never what is in one; it holds no key, forwards nothing of the sender's and keeps nothing. It needs no key and no ETH.

- **Needs:** a public **https** address that reaches this machine: a VPS, or a machine behind a tunnel you run. A home connection with no way in cannot
  carry one. `PORT` (default 10000) is where it listens; put TLS in front of it.
- **Run:** `PORT=10000 FORWARD_URL=https://your.host node tools/community-runner.mjs forward`. With `FORWARD_URL` set it sends a sealed read to the keepers
  through that address, now and every fifteen minutes, and says whether it came back (and whether the browser's CORS check will pass).
- **Check it from outside:** `node tools/private-route-check.mjs --service https://tacit-evm-pool-keepers.onrender.com --gateway <the public key `GET /1/evm-pool/keeper/info` shows as `sealed.key`> --forwarder https://your.host` runs the checks a listing needs: health, the browser's CORS preflight, a burst of sealed reads that match the direct answers, and what the route refuses.
- **Join the list:** a page lists the forwarders it uses, so send the address to Tacit. A forwarder run by the keepers' own operator hides nothing from it,
  which is why the list should be independent operators.
- **Limits:** 60 requests a minute per sender (`FORWARDER_RATE_PER_MIN`). The keeper counts everything behind one forwarder as that forwarder's, so a
  forwarder that carries many people should be named in the keepers' `EVM_POOL_KEEPER_FORWARDERS`.

### relay-check (opt-in, not part of `all`)

`node tools/community-runner.mjs relay-check https://relay.example/1/evm-pool/keeper` checks a Pay relay you run, the way a wallet reaches it: its quote names an
address, it shows a private route key signed for by that address, the relay registry lists it there, and a sealed quote comes back through Tacit's forwarders. It
needs no key and no ETH, says which step fails and what to do about it, and exits 1 if any does. How to run and list a relay: [RUN-A-PAY-RELAY.md](./RUN-A-PAY-RELAY.md).
A forwarder that also carries the relays the registry lists runs with `FORWARDER_RPC_URL` set (docs/EVM-POOL.md, "Relays from the registry").

### board (opt-in, not part of `all`)

Race Tacit's own prover for the prover board's public jobs. These are plain wraps, whose program input holds no one's secret and tells a prover nothing the chain does not already show: the settle consumes one deposit and inserts that depositor's own note in the same transaction, for an amount the underlying transfer reveals. Ops that pay someone else are not raced, even though their inputs hold no secret either: an input carries the commitment and owner behind each leaf the pool publishes only as a hash, so whoever proves one would learn which inserted leaf is the recipient's and could follow it to the moment it is spent. Those are proved on a machine trusted with a witness, or by the payer ([Prove it yourself](#prove-for-the-wrap-pool)). `board` claims one at a time (`POST /prover/community/claim` with your address), proves it with `tacit-prover` beside it and hands the proof back. Claiming takes the job from no one: Tacit's worker goes on with it, the relay checks each proof that comes back as it checks its own (a simulated settle) and uses the first that passes. A proof that does not pass costs nothing but a mark on the board's summary against the address.

- **Needs:** `tacit-prover` running, and `MINER=0x…`, the address the board credits. No key and no ETH: nothing is sent on chain.
- **Who wins:** a press waits a few minutes at most, so a machine that proves in under a minute (a desktop GPU) wins races; a laptop's 10 to 15 minutes does not. After its first proof the runner passes over a job due sooner than its last proof took. Laptops earn more from [Prove for the wrap pool](#prove-for-the-wrap-pool), whose wraps wait.
- **Tacit chain blocks, by draw:** in an open race the fastest machine wins every block. With `PROVER_BOARD_BLOCK_DRAW_PCT` set (0, off, by default), that share of blocks is first offered to one machine picked by lottery, as a Bitcoin block goes to a miner with odds by hashpower. A place's odds are its speed: 1 ÷ its usual seconds per block, from the blocks the relay has taken from it, shown as `blocks`, `blockSecs` (proving) and `blockFelt` (the whole wait: the block posted, or opened to the race when the machine was not the one drawn, to its answer arriving) on `GET /prover/board`. The odds use the whole wait, so a machine that is slow to ask for work, or busy with another proof when a block is posted, weighs less than one with the same GPU that is not; a block drawn for a machine and taken from another counts its wait against that machine. Its proving time still sets the lease and when the race joins it. Only a machine that asked for work in the last 6 s (`PROVER_BOARD_BLOCK_DRAW_FRESH_MS`) is drawn: a machine busy with another proof, or asking less often than that, would not see the block inside its 15 s offer, and the user would wait the whole offer; it is drawn at the moments it happens to have asked just before. `PROVER_BOARD_BLOCK_DRAW_NEW` (15 by default) is the share of the odds kept for places with no record yet, so new machines can earn one, as long as the board has taken at least one proof of any kind from them. Those places take turns: `PROVER_BOARD_BLOCK_DRAW_SEATS` (3 by default) of them, the ones that have waited longest, hold a ticket at a time and split that share, and a place that is drawn goes to the back of the line (a block taken gives it a record, which sets its odds by speed from then on). A machine reads its place in the line as `line` on `GET /prover/board?address=…`. One ticket per place: more addresses on one connection buy no more odds. The block waits 15 s for the drawn machine to take it. Once the drawn machine passes 1.5 times its usual time (10 s at least, 30 s for a machine with no record), the race joins it: it keeps its claim and is still paid if it answers first, and being slow does not count against it. A lapse (three times its usual time: 20 s at least, 45 s with no record), a block given back or a wrong proof opens the block to the race, and that place goes after the others for a while. The fastest machine still wins most blocks, and the rest win their share and stay ready.
- **Points:** each proof the relay takes earns the address `POINTS_BOARD_PER_PROOF` points (20 by default; a Bitcoin-state batch earns 1,000 and a Tacit chain block 100), with no daily count unless `POINTS_BOARD_DAILY_CAP` sets one; a refused or unchecked proof earns nothing. The day's tally is at `GET /prover/board/credits?day=<n>`, the proof pool's shape. The points service's proof-mining campaign reads it beside the pool's and sums each address's points from both for the day.
- **Off:** `PROVER_BOARD_COMMUNITY=0` on the API closes the routes.

### Not included: overflow drains

`drainOverflow` and `drainOverflowRoots` apply effects a batch deferred past its per-attest cap. Their inputs are
the deferred items themselves (lock spends and redemptions, locks, asset metadata, calls) in the guest's committed
order, but an attest publishes only each chunk's running-keccak root. The items exist only inside the reflection
guest's run over that batch's Bitcoin blocks, which neither the chain nor the API publishes, so a runner cannot
build the call from public data. `pendingOverflowChunks()` on the pool reads 0 today.

## Prove for the wrap pool

A page with a Tacit account open asks the proof pool to keep wraps of a few sizes proved ahead, so the deposit that follows needs no wait for a proof. Any
computer can make those proofs. `tacit-prover` leases one wrap at a time from the pool (`GET /prover/pool`), proves it and sends the proof back; the API
keeps it only if its public values are the wrap's and the live SP1 verifier takes it, and credits the address you named with points. Tacit's own GPU
prover leaves a wrap to community provers first (up to ten minutes by default, and only while one has asked in the last five), so a computer that asks gets first pick.

```sh
curl -fsSL https://tacit.finance/prove.sh | sh -s -- 0xYourAddress    # install it and start it at login
curl -fsSL https://tacit.finance/prove.sh | sh -s -- --status         # running? what waits in the pool? what has the address earned?
curl -fsSL https://tacit.finance/prove.sh | sh -s -- --uninstall      # stop it and remove it
```

[tacit prove](https://tacit.finance/prove/) gives the same command with your address filled in, then starts and pauses the installed prover and shows the
proof under way and what the address has earned (it talks to `tacit-prover` on 127.0.0.1: `GET /mine`, `POST /mine {miner, on}`, kept in
`~/.tacit-prover/mine.json`). [`dapp/prove.sh`](../dapp/prove.sh) picks the build
for the machine (an Apple-silicon Mac or x86-64 Linux; on Windows, run it inside WSL 2, see [On Windows](../contracts/sp1/confidential/device-prover/README.md#on-windows)), downloads the release it pins and runs nothing from it unless the
archive's sha256 is the pinned one, puts the program in `~/.tacit-prover/bin`, and sets it to start at login (a launchd agent, or a systemd user unit). Run
again, it updates the program and keeps the address. Cutting a new release means `node tools/prove-pins.mjs tacit-prover-vX.Y.Z`, which writes its sums into the script.

- **Needs:** about 8 GB of memory. The first proof downloads SP1's Groth16 circuit once, 6.2 GB (8.4 GB unpacked). A proof takes about 5 to 10 minutes on a Mac
  with 16 GB or more (13 minutes measured on an 8 GB MacBook Air) and uses the processor while it runs, so a laptop does best plugged in. The program makes one proof
  at a time and asks the pool for the next as soon as one is done (once a minute while the pool is empty).
- **Costs:** nothing else. No key and no ETH are involved and nothing is signed; the address only receives points. A proof it cannot make is handed back, unpaid.
- **Earns:** up to 20 points a proof, with no daily count: a proof that comes back within a minute of its lease earns all 20, and one that takes longer earns less, in a straight line down to half (10 points) at ten minutes and beyond, so a laptop's proof still earns and a fast one earns more (`POOL_PAY_FULL_SECS` 60, `POOL_PAY_FLOOR_SECS` 600, `POOL_PAY_FLOOR_PCT` 50; 100 pays every proof the same; `GET /prover/pool` shows them as `terms.pay`). A job that came back (a lease ran out or was handed back) is timed by its age from the page's request instead, so taking up a job after a long wait earns at the floor. A lease held for 25 minutes (`POOL_HOUSE_TAKEOVER_MS`, 0 turns it off; `terms.takeoverSecs`) without a proof can be taken over by Tacit's own prover once it is free: the late proof is not taken, and the lapse counts against that place (a place is shut out for the UTC day at 4 lapses, `POOL_LAPSES_PER_DAY`; `GET /prover/pool` shows `lapsedToday`). A new job is held for 30 seconds for the place whose turn it is, a place's turn being one draw whatever addresses it asks under, an address's turns counting at most three of its places at once (`POOL_TICKETS_PER_ADDRESS`; `terms.ticketsPerAddress`), and a place with a lapse today going last. Once the day is over, the points service shares that day's TAC between the provers by points, no point
  paid more than a cap, so a proof pays up to 20 times the cap. [`GET https://tacit-points.onrender.com/mine`](https://tacit-points.onrender.com/mine) gives the
  terms, when they end and what is left in the pocket; add `?address=0x…` for what an address has been credited. [tacit prove](https://tacit.finance/prove/) and `--status` read it.

## On your device

The runner makes no proofs; it lands proofs others publish. Proving an op with your own hardware is
[`contracts/sp1/confidential/device-prover/`](../contracts/sp1/confidential/device-prover/); proving with your own
Succinct account is in [OPEN-RELAYER.md](./OPEN-RELAYER.md#proving-with-your-own-prover-account).

A machine with an NVIDIA GPU runs the prover board's community worker with
`curl -fsSL https://tacit.finance/prove-gpu.sh | sh -s -- 0xYourAddress` ([tacit prove](https://tacit.finance/prove/) gives it with
your address filled in). It races the Tacit chain's blocks on the board ([`TACIT-BLOCKS.md`](./TACIT-BLOCKS.md)), proves the
proof pool's wraps between jobs, and on a card of 24 GB or more takes its turn at the board's Bitcoin-state batches. Each proof the
relay or the pool takes earns the address its points.

`curl -fsSL https://tacit.finance/prove-gpu.sh | sh -s -- --status` says whether it is running and where it stands: the proofs the board
has taken from it, its Tacit chain block record (blocks taken, its usual time per block), how often it was drawn, and whether it is in
the [block draw](#board-opt-in-not-part-of-all) now with its odds, or, if not, why (not asking for work, or last asked more than 6 s ago, blocks switched off, no accepted
proof yet, a missed turn it is waiting out, a usual block time over 60 s, another machine on the same connection holding its one
ticket, or a place in the line of machines with no block record yet, with how many must be drawn before it holds a ticket). The same answer is `GET /prover/board?address=0x…` (JSON, or plain text with `&format=text`): the facts on the board's own
public summary, put in one place. A new machine needs one accepted proof of any kind, a wrap for the pool counts, before it holds a
ticket, and its odds start low and rise as its block record forms.

## Tests

```sh
node --test tests/community-ops.test.mjs tests/community-runner.test.mjs   # the shared module and the runner, stubbed
node tests/community-runner-fork.mjs        # each mode against the real contracts on mainnet forks (anvil; FORK_URL=<archive RPC>)
node tools/keeper-check.mjs                 # the page in a browser, chain and API stubbed (PLAYWRIGHT=<playwright-core>)
```
