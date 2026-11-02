# Fast bridge

A liquidity provider (LP) swaps the same asset across Bitcoin and Ethereum with an adaptor-signature atomic swap, so a
holder of TAC on Bitcoin has TAC in the Ethereum pool in about the time of one Bitcoin block and one Ethereum settle,
instead of waiting for the reflection. The reflection bridge is unchanged: the LP rebalances over it, off the user's
clock.

Neither party holds the other's funds at any point. Each leg is enforced by its own chain: a Taproot script on
Bitcoin, the pool's lock set on Ethereum. The only thing that links them is a secret `t`.

## A swap, Bitcoin to Ethereum

1. The LP publishes its Bitcoin claim key and a quote (amount in, amount out, windows).
2. The user picks a note, derives `t` and `T = t·G` from its key and the note's outpoint, and moves the amount into a
   Taproot output keyed `P_LP + T` with a refund leaf `<csv> OP_CHECKSEQUENCEVERIFY OP_DROP <user> OP_CHECKSIG`. A
   sealed OP_RETURN in the same transaction lets the user find the lock again from its key.
3. The user sends the LP its lock offer. The LP reads the lock from the chain: the transaction and the notes it
   spends, the note the validator derives, its asset and commitment, its confirmations, and whether a spent note is
   already consumed on Ethereum.
4. After the confirmations its policy asks for, the LP moves a pool note of exactly the amount into the pool's lock
   set under `(T, deadline, recipient = the user's claim key)` and sends the user the lock terms and a
   pre-signature of the claim kernel, adapted to `T`.
5. The user finds the lock in the pool, checks the pre-signature, and claims: the kernel completes with `t`, and the
   claim's public values carry the completed signature `z`.
6. The LP reads `z` from the settle, computes `t = z − s̃` and spends the Bitcoin lock by key path with `d_LP + t`.

If a party stops, each side refunds on its own: the LP's lock after the Ethereum deadline, the user's lock after the
Bitcoin timelock. Ethereum to Bitcoin is the same swap with the roles exchanged: the LP holds `t` and locks Bitcoin
first, the user locks the pool note.

## What each side reads from the chain

Nothing in an offer stands in for a chain read. The Ethereum locker takes the swap id from the outpoint the lock
transaction spends, the note and its asset from the validator, the confirmations from the chain, the lock output's
script from the transaction, and whether the spent notes are consumed on Ethereum from the pool. The Bitcoin locker
accepts an Ethereum offer only when the lock leaf is in the pool's lock set, the leaf recomputes from the stated
terms, and the pre-signature verifies against the output it chose. A pre-signature over `(L − O)` exists only if the
locked note holds exactly the quoted amount.

## Rules that keep a swap whole

- The counterparty's Bitcoin claim key is fixed before `t` exists, and the lock is built to that key.
- Each swap has exactly one Ethereum lock, and no two locks share an `L`: the claim kernel is over `(L, O)`. The
  Ethereum locker derives the blinding of `L` from its seed, the swap id and the whole adaptor point. It computes the
  Ethereum deadline once, from the block time at which the Bitcoin lock reached its confirmations, and stores it with the
  swap. A lock that is stored is sent from its stored bytes; a lock that may already be in the pool is looked up by its
  leaf before anything new is built; a lock that is found too late to answer is still watched and refunded. The record
  of an open swap is the safety state of the Ethereum locker and is kept durably and backed up. An offer that reaches
  the Ethereum locker long after its lock confirmed is not answered, which bounds what a lost record can lead to.
- The Ethereum locker takes only what it can lock. A quote checks its inventory and holds nothing; a reservation holds the
  payout when the user commits, before it locks any Bitcoin, and is extended once the lock is on the network and held
  through its confirmation. An offer whose payout is not held is held at that moment or declined. A provider that is out of
  inventory is therefore found out while the user's TAC is still in hand.
- Steps of one swap run one at a time, so overlapping ticks never build the same transaction twice.
- A lock is made from a pool note of exactly the amount. When there is none, one is cut from a larger note, once, and
  the tries that follow are spaced by growing waits, since each reads the wallet's notes.
- No claim is built with less than `minClaimSecs` left before the deadline: a claim that is sent and misses the
  deadline still publishes `t`.
- Time on Ethereum is the latest block's timestamp. The Ethereum locker refunds only after the deadline plus a margin,
  and looks for a claim again before every refund step, so a claim that lands near the deadline still opens the
  Bitcoin lock.
- Once the Bitcoin timelock has run, the Bitcoin locker takes its note back from any waiting phase, so a claim job
  that never answers or an offer that cannot be read does not hold it.
- The Ethereum locker signs its take over the sats value the lock output really carries, read from the transaction.
- Every field of an offer is checked for shape before it is used; a field that does not parse is refused with a reason.
- The pre-signature nonce binds the excess, `(L, O)`, the full compressed `T` and the lock leaf.
- Every record is stored before the step that sends it, and the step is resumed from the stored bytes.

## Windows

| | default |
|---|---|
| Bitcoin refund timelock | 144 blocks |
| Ethereum lock window | 4 h from the block that confirmed the Bitcoin lock, rounded up to 10 min |
| Minimum time left to claim | 1 h |
| Slack between the Ethereum deadline and the opening of the Bitcoin refund | 2 h |
| Confirmations before the LP locks | policy by amount (1 for small, more for large) |

`checkEvmDeadline` and `btcRefundOpensAt` in `dapp/adaptor-xswap.js` hold the arithmetic: the Bitcoin refund must open
at least the slack after the Ethereum deadline, and the Ethereum locker needs time to see `z` and get its Bitcoin
claim mined before then.

## Proving the claim

The claim's proof is made by someone who sees `z` before the claim lands. The claimer therefore chooses its prover:
its own machine, its own credit on a prover network, or a relay that is not the LP. Adaptor jobs are not offered to the
open proof board for the same reason. `adaptorlock` and `adaptorclaim` are expiring job types in the relay, so a relay
that is paused or held skips a job whose deadline has passed instead of sending it.

## Code

| | |
|---|---|
| `dapp/adaptor-signature.js` | pre-signature, completion and extraction of the claim kernel |
| `dapp/adaptor-btc-lock.js` | the Taproot lock, its key-path secret and refund leaf |
| `dapp/adaptor-xswap.js` | swap secrets, offers and their checks, windows, recovery hint |
| `dapp/adaptor-btc-tx.js` | the lock, claim and refund transactions as signed commit/reveal pairs |
| `dapp/confidential-adaptor.js` | the `OP_ADAPTOR_LOCK` / `_CLAIM` / `_REFUND` witnesses |
| `dapp/confidential-lock-scan.js` | `decodePublicValuesAdaptorFields`: what a settle locked, spent and revealed |
| `dapp/fastbridge-bl.js` | the Bitcoin locker's state machine |
| `dapp/fastbridge-el.js` | the Ethereum locker's state machine |
| `dapp/fastbridge-evm.js` | the pool side of both machines on the pool wallet module: time, the lock set, who claimed, the lock, claim and refund ops, sending them through the relay |
| `dapp/fastbridge-http.js` | the user's side of an LP's HTTP API: the terms, a quote, the offer, the pool lock's offer |
| `dapp/fastbridge-btc.js` | the Bitcoin side of either machine on esplora explorers, shared by the page and the LP |
| `dapp/fastbridge-client.js` | the user's side as a whole: terms and quote checked before they are shown, the notes to lock, the machine over a store, the words for each phase, a lock found again from the key |
| `dapp/fast/` | the bridge page at `/fast/`: the wiring to a Tacit key and tacit.js (`wire.js`), the page's logic (`ui.js`), the providers it knows (`lp.json`) |
| `fastbridge-lp/` | the LP as a process: the HTTP API, the Ethereum locker over a durable store, the explorer adapter (see its README) |

Each machine takes its chain access as arguments (`ctx`, documented in its header), keeps one JSON record per swap,
and advances with `step(record)`.

## Tests

```
export PATH=$HOME/.nvm/versions/node/v22.22.3/bin:$PATH
node tests/adaptor-signature.mjs; node tests/adaptor-swap.mjs
node tests/adaptor-xswap.test.mjs          # offers, checks, windows, secrets
node tests/adaptor-btc-lock.test.mjs       # the Bitcoin lock under the real note validator
node tests/adaptor-btc-tx.test.mjs         # the transaction builder: funding, fees, signatures
node tests/fastbridge-sim.test.mjs         # both machines against a simulated Bitcoin and pool: restarts, timeouts, refusals
node tests/fastbridge-lp.test.mjs          # the LP process: API on a socket, quotes, store, explorer adapter, a swap through all of it
node tests/fastbridge-client.test.mjs      # the page's client against the LP service: quotes, a swap, a swap carried on, the refund, recovery from the key
node tests/fastbridge-ui.test.mjs          # the page's logic on a DOM
node tests/fastbridge-wire.test.mjs        # the page's wiring on the real tacit.js
PLAYWRIGHT=<path> node tests/fastbridge-page.mjs   # the page in a browser, under its content-security policy
FORK=<rpc> EXEC=<exec-stdin> node tests/fastbridge-fork.mjs   # the Ethereum side on a mainnet fork of the live pool
HARNESS=contracts/sp1/confidential/harnesses/target/release node tests/fast-lane-e2e.test.mjs   # the real settle guest
```

`HARNESS` is a directory holding `exec-adaptor{lock,claim,refund}` built from `contracts/sp1/confidential/harnesses`
with `cargo build --release --bin exec-adaptorlock --bin exec-adaptorclaim --bin exec-adaptorrefund`. They embed the
pinned `elf/cxfer-guest`, whose verifying key is the one inside the deployed pool, and write the public values to
`PV_OUT`.

## Status

Built and tested: the protocol, the transaction builders, both role machines, a simulated chain, the full swap in both
directions against the real settle guest and the real note validator, the pool adapter, the LP process with its
HTTP API, store and explorer adapter, and the bridge page (`/fast/`) with its client, recovery from the key and browser
check. The page lists no provider yet (`dapp/fast/lp.json`).

Not built: a link to the page from the front page's Bridge tab, the Ethereum to Bitcoin direction of the LP process,
the claim prover's options (the relay that is not the LP, the user's device, a prover network), and a run with real funds.
