# DESIGN — atomic exit-and-call (shielded → zRouter → any DeFi, one tx)

Status: **design note, post-launch.** Pure periphery — **no change to ConfidentialPool, the guests, or the
reprove.** Closes the one composability gap vs Railgun's Relay-Adapt: today an exit is payout-only, so
`exit → swap/LP on an external protocol` is two txs (exit to an address, then a separate router tx), which
leaks the exit→action link and exposes an intermediate public balance.

## Why this is pure periphery (no immutable change)
Two facts about the live pool make it work with zero core changes:
- **`settle` is permissionless** (`external nonReentrant`, no `onlyX`) — any contract may call it.
- **`_payout` to the withdrawal recipient is a plain `mint`/`safeTransfer`** (ETH is force-sent) — the
  recipient needs no callback; it simply *receives* the tokens.

So a periphery orchestrator sets itself as the proof's withdrawal recipient, calls `settle`, then composes with
the **pinned** zRouter. This is the exact mirror of the entry-side zaps the router already does
(`swapETHViaZRouter` → `wrap`), and it fits the router's stated model verbatim: *"standing allowance to the
immutable, PINNED targets — the POOL and zRouter … a well-formed call leaves no resting balance."*

**Home: `ConfidentialRouter`.** Measured under the deploy profile (`contracts/foundry.toml`: `via_ir=true,
optimizer_runs=1` — the same size-minimizing setting as the pool), the router is **21,848 / 24,576 B → 2,728 B
of headroom.** `exitAndCall` + the `CREATE2`-recipe binding is ~0.5–1 KB at runs=1, leaving ~1.7–2.2 KB free —
it fits comfortably in the router (its natural home: already pins pool + zRouter, holds no resting balance). The
sibling `ExitRouter` fallback is unnecessary unless future router additions consume that margin.

## Core: self-submitted atomic exit-and-call (the 90% case — trustless, no new crypto)
The user calls the router directly. settle + the external call are **one atomic tx the user controls**, so there
is nothing to bind — the user chose the recipe and the destination.

```solidity
/// @notice Unwrap a note out of the pool and immediately route it through the PINNED zRouter, atomically.
///         The proof's withdrawal recipient MUST be address(this). No funds rest here.
function exitAndCall(
    bytes calldata settleProof,     // pv.withdrawals[0] = { asset, value, recipient = address(this) }
    bytes32 assetId,                // the exited asset (must match the proof's withdrawal)
    bytes calldata zCalldata,       // calldata for the PINNED zRouter (it does the multi-protocol routing)
    address tokenOut,               // asset the user expects back from the route (or address(0)=ETH)
    uint256 minOut,                 // slippage floor on tokenOut delivered to finalRecipient
    address finalRecipient          // where the route's output goes
) external nonReentrant {
    IConfidentialPool(POOL).settle(settleProof);          // pool transfers `value` of `assetId` to this

    address tokenIn = _underlying(assetId);
    uint256 amountIn = _balOf(tokenIn);                    // exact received (snapshot; this contract rests nothing)

    // Only ever touch the PINNED zRouter. The recipe routes WITHIN zRouter, so the router's external-call
    // surface is exactly one trusted, immutable target — not an arbitrary address.
    _approveExact(tokenIn, ZROUTER, amountIn);
    (bool ok, ) = ZROUTER.call(zCalldata);
    require(ok, "zRouter call failed");
    _approveExact(tokenIn, ZROUTER, 0);                   // reset; never leave a standing approval beyond the call

    // Sweep everything to the user — output + any unspent input. No resting balance (the router invariant).
    uint256 out = _sweep(tokenOut, finalRecipient);
    require(out >= minOut, "minOut");
    _sweepDust(tokenIn, finalRecipient);                  // refund unrouted input
}
```

Security of the self-submit path:
- **Atomicity removes the seam.** There is no separate pending `settle` for anyone to front-run — settle and
  the route are in the caller's single tx.
- **One trusted external target.** The router only ever calls/approves the **pinned** zRouter; `zCalldata` is a
  zRouter call, so the multi-protocol fan-out happens inside the audited zRouter, not via an arbitrary
  `target.call`. (Do **not** accept an arbitrary `target` — that reintroduces the approval-drain surface.)
- **No resting balance / scoped approval.** Snapshot the received amount, approve exact, reset to 0, sweep
  everything to `finalRecipient`. The contract custodies nothing across txs.
- **`minOut`** bounds slippage/MEV on the public leg (the exit is public regardless).
- **Reentrancy:** `settle` is `nonReentrant` and returns before the zRouter call (sequential, not nested);
  `exitAndCall` is itself `nonReentrant`; zRouter does not re-enter the pool. A re-wrap-into-pool variant is
  still safe because it's a *sequential* `wrap` after `settle` returns, not nested.
- **Native ETH:** the pool force-sends ETH on an ETH exit — the router needs `receive()` and must treat ETH as
  `tokenIn`/`tokenOut` (wrap to WETH for the zRouter leg if needed), then sweep.

## Gasless variant (relayer submits) — bind the recipe with NO guest change
For a relayer to submit the user's pre-built proof, the recipe must be non-malleable by the relayer (else it
swaps in hostile `zCalldata`/`finalRecipient` and steals the output). The clean trick **without touching the
guest**: make the proof's **withdrawal recipient a recipe-derived `CREATE2` address.**

```
salt          = keccak256(abi.encode(assetId, zCalldata, tokenOut, minOut, finalRecipient, deadline, nullifier))
withdrawalTo  = CREATE2(ExitEscrowFactory, salt, ESCROW_INITCODE)   // deterministic, per-recipe
```

- The user builds the proof unwrapping **to `withdrawalTo`** — i.e. the proof *commits* the recipe by committing
  the address (the user authorized exactly this recipe by spending their note into it).
- The relayer calls `exitAndCall(proof, recipe...)`. The router recomputes `withdrawalTo` from the supplied
  recipe and **requires it equals the proof's withdrawal recipient**. Any change to `zCalldata`, `minOut`,
  `finalRecipient`, or `deadline` ⇒ different address ⇒ revert. The relayer cannot alter the recipe.
- `nullifier` in the salt makes each escrow one-shot and isolates concurrent exits (no balance-collision across
  users). The router deploys the minimal escrow, pulls the tokens, runs the route, sweeps, and self-destructs /
  leaves it empty.
- The relayer is paid from the proof's existing **in-proof fee leg** (the router is the settler, so the
  `FeePayment` lands on the router, which forwards it) — the standard gasless model, unchanged.
- **Privacy:** the recipe is signed/derived under an **ephemeral, per-exit key** (same one-time-key discipline
  as the stealth ops), so binding the recipe does not link a persistent identity.

This keeps the gasless path **fully external** — the relayer-hijack defense is the `CREATE2`-address equality
check against a value the proof already commits, not a new guest field.

> Alternative (cleaner, but NOT free): commit a `recipeHash` in the unwrap public values guest-side, so the
> router checks `keccak(recipe)==pv.recipeHash`. Simpler contract, but it's a **guest change → a future
> reprove** (and the pool stays codesize-bound). Prefer the `CREATE2` binding until a reprove is happening
> anyway, then optionally migrate.

## Threat checklist (the load-bearing review)
- [x] **Arbitrary external call** — disallowed; only the **pinned** zRouter is ever called/approved. No
      caller-supplied `target`.
- [x] **Approval drain** — exact approve + reset to 0 inside the call; no standing allowance to anything but the
      pinned zRouter (the router's existing invariant).
- [x] **Relayer recipe-hijack (gasless)** — defeated by the `CREATE2`-recipe-derived withdrawal address the
      proof commits (or the guest `recipeHash`, later).
- [x] **Output redirection** — `finalRecipient` is inside the recipe → inside the `CREATE2` salt → bound.
- [x] **Slippage / MEV** — `minOut` on the delivered output; the exit is public anyway.
- [x] **Reentrancy** — `nonReentrant` on `exitAndCall`; `settle` returns before the route; zRouter ∤→ pool.
- [x] **Resting funds** — snapshot + full sweep + dust refund; the contract holds nothing across txs.
- [x] **Stuck ETH / non-payable** — `receive()`; WETH-wrap the zRouter leg; force-send sweep.
- [x] **Reorg / replay** — `nullifier` + `deadline` in the salt; settle is already replay-protected by the
      spent-set.
- [x] **Pool/zRouter immutability** — both are pinned, trusted, immutable targets (the router's premise).

## Net
- **Self-submitted atomic exit→zRouter ships with zero immutable change** — a periphery method, low risk,
  standard router-adapter, fully trustless. That alone gives you Railgun-Relay-Adapt parity on the user-driven
  path, plus your cross-chain edge.
- **Gasless atomic** is also fully external via the `CREATE2`-recipe binding; a guest-side `recipeHash` is a
  nicer-but-optional future-reprove refinement.
- **Placement:** measure `ConfidentialRouter` with `--sizes`; add there if it fits (one periphery, mirrors the
  entry zaps), else a sibling `ExitRouter`. Either way it never touches the v1 reprove.
</content>
