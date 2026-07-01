# DESIGN — atomic exit-and-execute (shielded → any DeFi batch, one tx)

Status: **shipped, periphery.** Pure periphery — **no change to ConfidentialPool, the guests, or the
reprove.** Closes the composability gap vs Railgun's Relay-Adapt: an exit is no longer payout-only. A single
`exitAndExecute` unwraps a note and runs an arbitrary, proof-bound **batch of calls** (swap, then supply, then
stake — any protocols, in order), delivering one or more outputs to the recipient atomically. No intermediate
public balance, no exit→action link leaked across two txs.

## Why this is pure periphery (no immutable change)
Two facts about the live pool make it work with zero core changes:
- **`settle` is permissionless** (`external nonReentrant`, no `onlyX`) — any contract may call it.
- **`_payout` to the withdrawal recipient is a plain `mint`/`safeTransfer`** (ETH is force-sent) — the
  recipient needs no callback; it simply *receives* the tokens.

So a periphery orchestrator points the proof's withdrawal recipient at a per-recipe escrow, calls `settle`,
and the escrow runs the recipe. **Home: `ConfidentialRouter`** — the batch logic lives in a separate
`ExitExecutor` impl (cloned per exit), so `exitAndExecute` stays thin and the router stays under EIP-170
(measured **23,801 / 24,576 B** at the deploy profile `via_ir=true, optimizer_runs=1`; `ExitExecutor` runtime
~1.4 KB).

## Architecture — the per-recipe, fund-isolated batch executor
`exitAndExecute(publicValues, proofBytes, memos, recipe)`:
1. Guards (`finalRecipient`, `deadline`, `sweepTokens.length == minOuts.length`, asset registered with the pool).
2. Snapshot the fee asset, call `POOL.settle(...)` — the proof withdraws the exit funds to the **recipe-bound
   escrow address**, and the in-proof fee leg lands on the router, which forwards it to `msg.sender` (the
   relayer — gasless).
3. Deploy the escrow: a **solady PUSH0 `CREATE2` clone** of the `ExitExecutor` impl at
   `salt = keccak256(abi.encode(recipe))`, then call `escrow.run(recipe)`.

`ExitExecutor.run(recipe)` (runs in the ephemeral clone, which holds **only this exit's funds**):
- ROUTER-only (`if (msg.sender != ROUTER) revert NotRouter()`).
- For each `ExitCall{target, value, token, amount, push, data}`: reject `target == pool / router / self`
  (`revert BadTarget()`); fund it — `push` ⇒ `safeTransfer` to the target, else `safeApproveWithRetry` (pull);
  then `target.call{value}(data)`, bubbling any revert.
- Sweep each `sweepTokens[i]` to `finalRecipient`, enforcing `minOuts[i]` (`revert ShortOutput()`). Nothing rests.

## SECURITY — why arbitrary batched calls are safe *here* (but not on the router)
The router is **permanent** (standing approvals, a fixed point other flows trust) — so it only ever calls a
**pinned, trusted** target (zRouter, on the entry zaps). The exit escrow is the opposite: **ephemeral,
single-use, recipe-bound, holding only this one exit's funds.** That containment is what lets it run an
**arbitrary** batch:

- **Blast-contained.** An arbitrary/hostile target can only ever touch the funds the user already authorized
  in *this* recipe. The router, the pool, and every other user's funds are untouched — the escrow custodies
  nothing else and dies empty. The trust is exactly "the targets in my own recipe," i.e. standard DeFi.
- **Recipe-bound = front-run defense.** The escrow address *is* `CREATE2(keccak(recipe))`, and the proof
  withdraws there. Any change to a call, a `minOut`, the `finalRecipient`, or the fee asset ⇒ a different
  address ⇒ the funds aren't there ⇒ revert. A relayer cannot alter the recipe. (`nonce` in the recipe makes
  each escrow one-shot and isolates concurrent exits; it also keeps exits unlinkable — no persistent identity.)
- **No reach-back.** `target` may not be the pool, the router, or the escrow itself — the only addresses with
  privileged state to abuse. Combined with the router's `nonReentrant` guard (held across `run`), the batch's
  external calls cannot re-enter any router entrypoint.
- **No resting balance / no standing approval.** Per-call approvals live on an ephemeral escrow that dies the
  same tx; outputs are swept under `minOut`; the router never holds the exit funds at all.

A *fixed/cached* executor (DSProxyFactory-style reuse) would break all of this — it would commingle exits'
funds (recreating the drain surface), drop the per-exit recipe binding, and link a user's exits via a stable
address. The per-recipe ephemeral clone is load-bearing, not overhead.

### Output routing (a recipe-authoring note)
A call cannot name the escrow it runs in (the address is `keccak(recipe)`, which would be circular). To return
an intermediate output to the escrow for a later step, route it to `msg.sender` (the escrow is the caller) via
a conduit/helper that forwards to its caller, or have a protocol credit `finalRecipient` directly (e.g. Aave
`supply(asset, amt, finalRecipient, 0)` — no escrow round-trip, sweep nothing).

## zRouter's role
Not a cage — a **first-class target**. For the swap/routing leg you put zRouter in a call (it aggregates
V2/V3/V4/zAMM, multi-hop, best execution); for everything else the recipe calls the protocol directly, all in
one batch. The **entry-side zaps keep the pinned zRouter** (permanent router ⇒ trusted target only). So
zRouter is used on both ends, appropriately — the exit simply isn't *forced* through it.

## Threat checklist (the load-bearing review)
- [x] **Arbitrary external call** — allowed, but blast-contained to the ephemeral per-exit escrow; reach-back
      into pool/router/self is rejected.
- [x] **Approval drain** — per-call approval on an escrow that dies the same tx; the permanent router holds no
      standing allowance beyond the pinned zRouter (entry side).
- [x] **Relayer recipe-hijack (gasless)** — defeated by the `CREATE2`-recipe-derived withdrawal address the
      proof commits; any recipe field change ⇒ different escrow ⇒ revert.
- [x] **Output redirection** — `finalRecipient` + every call is inside the `CREATE2` salt → bound.
- [x] **Slippage / MEV** — `minOut` per swept output; the exit is public regardless.
- [x] **Reentrancy** — `nonReentrant` on `exitAndExecute` (held across `run`); `run` is ROUTER-only and one-shot.
- [x] **Resting funds** — full sweep under `minOut`; the router never custodies the exit funds; the escrow dies empty.
- [x] **Stuck ETH / non-payable** — `ExitExecutor` is `payable` (`receive()`); native ETH funds calls (`value`)
      and is a valid sweep output.
- [x] **Reorg / replay** — `nonce` + `deadline` in the recipe/salt; settle is replay-protected by the spent-set.
- [x] **Pool immutability** — never called by the executor; the entry side's zRouter/pool targets are pinned.

## Proven
Live mainnet fork (`contracts/test/ConfidentialRouterExitFork.t.sol`): one recipe exits USDC → zRouter
`swapV2` USDC→WETH → Aave V3 `supply` → `finalRecipient` receives **aWETH**, in a single tx — shielded exit
into composed DeFi, end to end. Unit suite (`ConfidentialRouterExit.t.sol`) covers single/pull, conduit/push,
multi-step chained batch, multi-output, native ETH, front-run binding, ROUTER-only, bad-target, in-proof fee,
deadline. JS (`dapp/confidential-router.js`) reproduces the recipe encoding + escrow address (cross-checked in
`tests/exit-recipe-escrow.test.mjs`).

## Net
Railgun-Relay-Adapt parity and beyond on the user-driven *and* gasless paths — arbitrary composed DeFi out of
the shield in one tx — with zero immutable change, plus the cross-chain edge. A future guest-side `recipeHash`
is a nicer-but-optional refinement to fold in only when a reprove is already happening; the `CREATE2` binding
needs none.
