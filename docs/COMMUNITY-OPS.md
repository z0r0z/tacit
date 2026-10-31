# Community ops

Bitcoin's state reaches Ethereum through calls anyone can make: block headers into the header relay, proofs of
each batch into the pool, and the open board's settles into the pool for the fees their proofs pay. Tacit's own
services make every one of them. So can you, from a browser wallet on
[tacit.finance/weld/keeper](https://tacit.finance/weld/keeper/), or from your own machine with one key and the
**community runner**, [`tools/community-runner.mjs`](../tools/community-runner.mjs).

The page and the runner build the same calls from the same modules:
[`dapp/header-relay-advance.js`](../dapp/header-relay-advance.js) for headers and
[`dapp/community-ops.js`](../dapp/community-ops.js) for proofs and the board.

## Run it

Node 20 or later.

```sh
git clone https://github.com/src-company/tacit
cd tacit && npm ci --omit=dev
DRY_RUN=1 ONCE=1 node tools/community-runner.mjs           # what it would send now; no key needed
RUNNER_KEY=0x… node tools/community-runner.mjs             # all three modes, each on its own loop
RUNNER_KEY=0x… node tools/community-runner.mjs settles     # one mode: headers, attest or settles
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

Sends the open board's settles (`GET /confidential/open`, see [OPEN-RELAYER.md](./OPEN-RELAYER.md)) with
`ConfidentialPool.settle(publicValues, proof, memos)`, and reports each landing (`POST /confidential/landed`).

- **When.** A job is open (no other sender has taken it), whole, and more than two minutes from its deadline, by
  the latest block's time. Of those, the runner takes the oldest whose tETH fee pays its gas with `MARGIN_BPS` to
  spare: first at 600,000 gas, then again at the job's own estimate. A job the pool refuses in simulation is passed
  over for ten minutes.
- **Costs.** A recent transfer's settle used 348,054 gas; the runner prices a job at 600,000 before its own estimate.
- **Earns.** Each fee leg the proof binds, paid to the sending account inside the same transaction: tETH legs as
  ETH. A fork of mainnet replaying a real settle paid the runner its 0.0062 ETH fee less 0.000084 ETH of gas. Legs in
  other assets are paid too but are not counted when choosing what to send. Jobs reach the board when Tacit's relay
  has proved a settle it is not sending yet, or when a holder posts a proof made with their own prover; Tacit's
  relay sends its own as soon as it can, so the first sender is paid.
- The board API allows a burst of 30 reads and one every 2 seconds after that, per IP address.

### prove (opt-in, not part of `all`)

Prove wraps for the proof market and be paid in TAC. A holder who wants a proof fast signs a fee in TAC (a price that rises from a floor to a most they chose) and a permit for that most; the order waits on the board (`GET /market/orders`). `prove` takes one order a pass: it claims it on chain (`ProofMarket.claim`, which excludes other provers for 60 seconds), proves the order's program input on this machine with `tacit-prover` (127.0.0.1:47815, `DEVICE_PROVER` to change), and fulfils it. The market contract settles the holder's wrap through the pool and pays this key from the holder's permit in the same transaction, so if the pool does not take the proof nothing moves and only the gas of the failed call is lost.

- **Needs:** `tacit-prover` running, and a key with a little ETH for gas. Set `SEND_RPC_URL` to a private endpoint (the default is Flashbots Protect): the proof is in the fulfil's calldata, and the pool's settle is open to anyone, so a copier in the public mempool could settle first.
- **Earns:** the order's price at the moment you claim it, in TAC, to the key. `MIN_TAC_WEI` sets the least you will work for.
- **Competes with Tacit's own relay,** which takes orders first when it is idle. The orders worth your time are the ones it leaves, or ones priced for a faster machine than its board.
- **Cost of a miss:** a claim that lapses before you fulfil costs the gas of the claim (and the bond, none to start; the owner can set one up to 0.1 ETH). Claim only what your machine proves inside the minute.

`MARKET_ADDR` names the market (default `0x0000000033Dd45B1686Ba37e5F6e4ABDdaC17609`). `PROVE_SECS` is the poll cadence (default 10).

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

The [keeper page](https://tacit.finance/weld/keeper/) has the same command with your address filled in. [`dapp/prove.sh`](../dapp/prove.sh) picks the build
for the machine (an Apple-silicon Mac or x86-64 Linux; on Windows, run it inside WSL), downloads the release it pins and runs nothing from it unless the
archive's sha256 is the pinned one, puts the program in `~/.tacit-prover/bin`, and sets it to start at login (a launchd agent, or a systemd user unit). Run
again, it updates the program and keeps the address. Cutting a new release means `node tools/prove-pins.mjs tacit-prover-vX.Y.Z`, which writes its sums into the script.

- **Needs:** about 8 GB of memory. The first proof downloads SP1's Groth16 circuit once, 6.2 GB (8.4 GB unpacked). A proof takes about 5 to 10 minutes on a Mac
  with 16 GB or more (13 minutes measured on an 8 GB MacBook Air) and uses the processor while it runs, so a laptop does best plugged in. The program asks the pool
  once a minute and makes one proof at a time.
- **Costs:** nothing else. No key and no ETH are involved and nothing is signed; the address only receives points. A proof it cannot make is handed back, unpaid.
- **Earns:** 20 points a proof, the first 30 of a day. Once the day is over, the points service shares that day's TAC between the provers by points, no point
  paid more than a cap, so a proof pays up to 20 times the cap. [`GET https://tacit-points.onrender.com/mine`](https://tacit-points.onrender.com/mine) gives the
  terms, when they end and what is left in the pocket; add `?address=0x…` for what an address has been credited. The keeper page and `--status` read it.

## On your device

The runner makes no proofs; it lands proofs others publish. Proving an op with your own hardware is
[`contracts/sp1/confidential/device-prover/`](../contracts/sp1/confidential/device-prover/); proving with your own
Succinct account is in [OPEN-RELAYER.md](./OPEN-RELAYER.md#proving-with-your-own-prover-account).

## Tests

```sh
node --test tests/community-ops.test.mjs tests/community-runner.test.mjs   # the shared module and the runner, stubbed
node tests/community-runner-fork.mjs        # each mode against the real contracts on mainnet forks (anvil; FORK_URL=<archive RPC>)
node tools/keeper-check.mjs                 # the page in a browser, chain and API stubbed (PLAYWRIGHT=<playwright-core>)
```
