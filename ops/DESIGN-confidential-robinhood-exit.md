# Confidential ETH → Robinhood Chain exit — ops tooling, not new contracts

Companion to `ops/DESIGN-confidential-base-exit.md`. Same underlying insight — Robinhood Chain is a live
(July 2026) Arbitrum Orbit chain, chain id `4663`, settling to Ethereum, with its own already-trustless
canonical bridge — so no light client is needed here either. What differs is the bridge mechanism itself:
Arbitrum's deposit path is a different, and more dangerous, shape than OP-Stack's, and that shape drives
most of what's actually new in `scripts/confidential-exit-robinhood.mjs`.

Every on-chain primitive this still uses (`ConfidentialRouter.exitAndExecute` / `activateExit` /
`reclaimExit` / `escrowAddressFor`) is the same immutable, already-audited surface the Base exit uses.
This adds one new router-side calldata builder (`buildArbitrumBridgeExit`,
`dapp/confidential-router.js`) and a parallel ops script — no new Solidity.

## The flow

Identical shape to the Base exit: wrap → dwell → unwrap to a recipe-bound escrow → the escrow
atomically bridges out. The only change is what the escrow's single batched call does.

## The gotcha that matters — worse than Base's

Base's contract-caller trap just **reverts** (`onlyEOA`) — safe, if annoying. Arbitrum's does not:
`Inbox.depositEth()` from a contract caller **succeeds** and silently credits the contract's **L2 alias**
(`L1_addr + 0x1111000000000000000000000000000000001111`) — an address nobody holds a key for. Since our
escrow is a one-shot CREATE2 contract, naively reusing the Base pattern here would **permanently
misdeliver funds** instead of reverting. The fix, verified live against the real Inbox
(`0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D`, selector `0x679b6ded`), is to always go through
`Inbox.createRetryableTicket(to, l2CallValue, maxSubmissionCost, excessFeeRefundAddress,
callValueRefundAddress, gasLimit, maxFeePerGas, data)`, which lets the escrow name `to` explicitly.

## Who pays L2 gas, and where refunds land

OP-Stack deposits don't require the L1 depositor to prepay L2 execution gas. Arbitrum retryables do:
`msg.value` must cover `l2CallValue + maxSubmissionCost + gasLimit*maxFeePerGas`, and any unused budget
refunds **on L2**, to `excessFeeRefundAddress`/`callValueRefundAddress` — never back to the L1 escrow.
Arbitrum auto-aliases those refund addresses if they're L1 contracts (its own guard against exactly this
bug class), but an aliased address is still one nobody holds an L2 key for. So both refund addresses are
always set to `l2Recipient` itself — never the escrow, never an L1-only address.

Practical consequence: **the amount that lands on Robinhood Chain is smaller than what's unwrapped**, by
that prepaid gas budget. The Base exit delivered ~100% of the unwrapped amount; this one doesn't. The
script computes `l2CallValue = noteNet - (maxSubmissionCost + gasLimit*maxFeePerGas)` and refuses to
proceed if the overhead would exceed the note's value entirely.

## Gas parameters are live-quoted, never guessed

- `gasLimit`: from Robinhood Chain's own `NodeInterface` precompile (`0x00…00C8`, the standard virtual
  contract every Arbitrum/Orbit chain exposes) via `estimateRetryableTicket(...)`, called through
  `eth_estimateGas` against the L2 RPC — the returned gas number *is* the answer, this function has no
  return value via a normal `eth_call`. Verified live: a plain ETH-credit ticket (empty `data`) estimates
  to ~21k gas.
- `maxSubmissionCost`: from the Inbox's own `calculateRetryableSubmissionFee(dataLength, l1BaseFee)`
  (verified callable live), using 2x the current L1 base fee as margin.
- `maxFeePerGas`: 2x Robinhood Chain's own current `eth_gasPrice`.

## Verification, before any proof is built

Same ladder as the Base exit, plus two new pins:
1. `Inbox.bridge()` cross-checked against the known Bridge address, live, every run.
2. Robinhood Chain's `eth_chainId` cross-checked against `4663`, live, every run.
3. The state-override `eth_call` dry-run of `activateExit` (same zero-cost mechanism that caught real
   bugs on the Base exit) additionally gets an explicit assertion that
   `l2CallValue + maxSubmissionCost + gasLimit*maxFeePerGas` equals the recipe's call value exactly,
   before a proof is ever requested.

## Privacy boundary

Identical to the Base exit's: the exit amount (well, the *unwrapped* amount — the L2CallValue is
slightly less, but both figures are public), `l2Recipient`, and timing are all public on L1 the moment
`activateExit` lands. Shielded accumulation, then exit anywhere — not a private cross-chain transfer.

## Confirmed live (2026-09-05 mainnet smoke test)

0.003 ETH wrapped → self-submitted `exitAndExecute` → `Inbox.createRetryableTicket` → Robinhood Chain
balance increased by **exactly** the computed `l2CallValue` (0.0029750853372112 ETH), auto-redeemed
within a few minutes of L1 confirmation.

The refund-aliasing risk above is not hypothetical: this run's `l2Recipient` turned out to have 23 bytes
of L1 contract code (very likely an EIP-7702 delegation), so the Inbox aliased both refund addresses as
documented. The small unused slice of the prepaid gas budget (0.0000169840967888 ETH, out of a
~0.000282 ETH total budget) landed at the *aliased* address, not at the recipient directly — confirmed by
checking that address's balance on Robinhood Chain post-redemption. Nothing was lost (the address is a
deterministic function of `l2Recipient`, recoverable in principle), but it isn't trivially spendable
either unless the recipient controls whatever lands at that exact L2 address. **Follow-up worth doing**:
have the script warn (via `eth_getCode` on L1) when `l2Recipient` has contract code, so this is surfaced
before proving rather than discovered after the fact.

## Rescue matrix

Same as the Base exit's (escrow-bound recipe, `activateExit` re-runnable, `reclaimExit` after deadline),
with one addition:

| Situation | Mechanism |
|---|---|
| Retryable ticket's L2 execution runs out of the prepaid gas budget | Doesn't strand funds the way an OP-Stack revert would — Arbitrum holds it as a **failed, manually-redeemable retryable** for ~7 days on L2. This is an independent recovery path Arbitrum provides for free; nothing in this tooling needs to reimplement it. |
| Wrong `l2Recipient` | **Unrecoverable**, same as Base — it's also the refund destination for both retryable legs, so a wrong address loses everything the ticket touches, not just the deposit. The `exit` subcommand prints the recipe for review before any proof is built. |

## Not in scope

Same as the Base doc: `crossOut` / the Bitcoin lane is untouched by this flow.
