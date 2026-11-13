# The private swap: the demo, and the checks behind it

The Swap tab's **Swap privately** (the Pay pool hop): a deposit now into the private ETH pool, and later the pool's relay swaps it out on public
liquidity to any address. Nothing on chain ties the deposit to that address. This page is what the demo shows, what each part of it costs and who pays
it, and how to run the same flow end to end on a mainnet fork.

## Who pays what

| Step | What happens | Gas |
|---|---|---|
| Deposit, from ETH | The wallet sends one transaction with a proof made on its device | ETH from the wallet, always: ETH moves only in a transaction its holder sends |
| Deposit, from USDC, TAC or any token the gas relay takes a fee in | The wallet signs one order and sends nothing: the relay sells the token for ETH straight into a deposit box of the ETH pool for the wallet's key, the pool's keeper completes the box | The token (or TAC), no ETH at all. The card picks it itself when the wallet holds no ETH; with ETH it offers a choice, each with its cost |
| Swap out | The pool's relay sends the withdrawal and the swap, at the price the person confirmed | Nothing from the wallet. The relay's fee comes out of the deposit |

Paying the deposit's gas in a token costs about three times what paying it in ETH does: two transactions are paid for (the relay's, and the keeper's
completion of the box), each with its margin. The card says what each way costs before anything is pressed (the receipt's *Deposit gas* row, and the
pills in the Swap privately box).

## The runs (`tests/swap-demo-run.mjs`)

| Run | Wallet | What it shows |
|---|---|---|
| `eth` | Alice: ETH | ETH → USDC to a fresh address. The hop is on by itself, the deposit is one transaction she sends, the keeper sends the swap out, she signs nothing more |
| `usdc` | Bob: 1,000 USDC, no ETH, ever | USDC → DAI to a fresh address. The relay pays the deposit's gas in USDC through one signed order; his wallet sends no transaction and never holds ETH |
| `tac` | Carol: TAC, no ETH | The same, in TAC |
| `pick` | Erin: ETH, USDC and TAC | The card pays in ETH by itself, the cheaper way, and offers the token and TAC; she picks TAC, no ETH leaves her wallet, the order takes its fee in TAC |
| `zap` | Frank: USDC and ETH | The unchanged way in: his own transaction to the zap, no relay order |
| `priv` | Gina: USDC, no ETH | USDC → TAC into her private balance: the relay's way pays an address only, so it is not offered and the button says what is missing (ETH) |

Each checks the chain after it: the fresh address received at least the price shown, the swap out was sent by the keeper and does not name the depositing
wallet, the no-ETH wallets still hold no ETH and sent nothing, and the Done step reads what arrived.

## What was measured

On a mainnet fork with the real keeper (an idle machine; a loaded one takes several times as long, and a fork read through a rate-limited node can take minutes):

| | Time |
|---|---|
| ETH deposit, press to the plan waiting (key sign-in, proof on the device, one transaction) | 27 to 71 s |
| Deposit through the relay and the keeper's box, press to the plan waiting | 41 to 50 s |
| Swap out, Confirm to Swapped (proof on the device, 10 to 28 s of it, then the relay) | 10 to 43 s |

Gas: the relay's order about 287,000, the keeper's completion of the box about 408,000, a swap out about 604,000. The keeper takes 1.5 times its quote for the box, and
what the sale pays above the box is 0.45% of it. The keeper's `/quote` gives the box's fee at the current gas price (`depositGas`, `depositFee`); the page falls
back to a quote at 500,000 gas for a keeper that does not say. The live keeper polls every 15 s and its nodes answer in a fraction of a second, so a live run is
not the fork's time.

## Running it

```
node build/build.mjs                      # restamps the page's CSP hash and cache-busts
# the free archive nodes each refuse part of what a fork reads: tools/fork-proxy.mjs puts eight of them behind one caching URL (http://127.0.0.1:8590)
node tools/fork-proxy.mjs &
FORK=http://127.0.0.1:8590 QUOTE_RPC=http://127.0.0.1:8590 FORK_BLOCK=<a block a little back> \
  SHOTS=<dir> VIDEO=<dir> node tests/swap-demo-run.mjs [eth,usdc,tac,pick,zap,priv]
```

It needs Foundry's `anvil` on the `PATH`.

`SHOTS` saves a screenshot at each stage, `VIDEO` records the browser, `SLOW=<ms>` pauses between stages for narrating over, `HEADED=1` shows the browser.
It runs the page as it is on disk, the keeper as the real process (`worker-relay/src/evm-pool-keeper.js`, with the pool's ceremony key), and stands in for
two things only: the relay's order board (`api.tacit.finance/gas/order`: each order is checked as the board checks it and sent as the settle relay sends
it) and the chain (an anvil fork). A fork run's first pass over the pool's history is slow on a cold cache; pin `FORK_BLOCK` so a second run asks the same
questions and the proxy answers them.
A pinned block keeps its own time: the harness sets the fork's clock to the wall clock (the keeper judges a call's deadline by it) and has the two Chainlink feeds answer
their block's price as updated now (the card drops a price older than six hours, and without one it cannot price a token's gas, so offers none of the relay's ways).
A scenario that fails ends the run: start them one at a time (`node tests/swap-demo-run.mjs pick`).

The unit and fork tests under it: `tests/swap-boxed.test.mjs` (the sizing and the plan's states), `tests/swap-later-boxed-fork.mjs` (the relay-paid deposit
and the swap out with the real keeper and the live relay and router contracts).

## Notes on the flow

- The run stands in for the live settle relay and runs the keeper locally, so the live services' own times are not in the table above.
- **Points.** A box funded by a gas-relay order credits the order's payer, not the settle relay that sent the funding transaction
  (`worker-relay/src/lib/evm-pool-points.js`).
- **The surplus.** What the sale pays above the box (about 0.45% of it) stays in the box, and the router lets anyone send a box's whole balance to the intent's
  refund address (a fresh receive box of the key) once its deadline has passed; a box that is already completed is no obstacle (checked on a mainnet fork against
  the live router: a second reclaim of a box that already has code paid its leftover to the refund, and one with nothing left reverts NothingToReclaim). With
  `EVM_POOL_KEEPER_RECLAIM=1` the keeper does that for a completed box too, but only when the leftover is worth the send: ETH, three times what the send's gas
  costs (about 44,000 gas on the live router, 0.00013 ETH at 1 gwei). A box under about 0.03 ETH at 1 gwei, or 0.009 ETH at 0.3 gwei, leaves less than that:
  it is left where it is, and is the price of this way in. Reclaim is off unless that is set.
- **A box the keeper never completes** (down past its deadline, a gas rise above the keeper's 1.5 times margin) is sent back whole by the same reclaim, to the
  refund address, when that keeper is up again with its store. The plan in the browser keeps the box's intent too (`boxIntent`, `boxDeadline`), which is all
  the router's `reclaimDeposit` needs from anyone after the deadline: a stopped swap's card offers it (later.js `reclaimBox`, sent from the connected wallet, which pays the gas). With the keeper's store and the browser's plan both lost, the
  ETH stays in the box: the intent's nonce is random, so the key alone does not rebuild it.
- The relay's way pays an address. A swap into TAC that ends in the key's own private balance or at a Tacit address is still the wallet's own deposit (it hands the
  key's account its gas), so a wallet with no ETH is told what is missing.
- The keeper calls a swap out a revert only when its node answers execution reverted. Any other failure of its estimate (a node's JSON-RPC "internal error",
  which a fork gives when its upstream times out) is a 503 saying a node could not be reached, and nothing is sent.
- The pools of USDC and USDT are thin (tens of leaves against the ETH pool's hundreds): the relay's way in therefore goes through the ETH pool.
