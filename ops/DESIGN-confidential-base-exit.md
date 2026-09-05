# Confidential ETH → Base exit — ops tooling, not new contracts

Base is an OP-Stack rollup that already posts state to L1, so `L1StandardBridge` is trustless on its
own — there is no light client to build here, unlike the Bitcoin↔Ethereum bridge. What Base's bridge
does not give you is privacy: a deposit publicly links the L1 funder to the L2 recipient. The
confidential pool is the missing half. This doc covers the ops script (`scripts/confidential-exit-base.mjs`)
that chains them: wrap into the pool (join the anonymity set) → dwell → unwrap straight into a
recipe-bound escrow → the escrow atomically calls Base's own bridge.

Every on-chain primitive used here — `ConfidentialRouter.exitAndExecute` / `activateExit` /
`reclaimExit` / `escrowAddressFor` — is already live on the immutable mainnet suite
(`contracts/src/ConfidentialRouter.sol:944-1120`). This is tooling and policy, not new Solidity.

## The flow

```
wrap ──(dwell)──> exit ──(relay settle)──> activate ──> Base credit
        │                     │
        └─ pool anonymity set └─ escrow-bound unwrap, recipient = escrowAddressFor(recipe)
```

1. **`wrap`** — deposit ETH into the pool via `router.wrapETH` (one tx), then settle the `OP_WRAP` proof
   through the relay. The note's secret/blinding are deterministic from `(WALLET_PRIV, index)`
   (`pool.deriveNote`), so nothing about the note itself needs to be persisted.
2. **dwell** — time between wrap and exit. Bought for free by not rushing; enforced as a UX nudge, not
   a contract constraint.
3. **`exit`** — build an `ExitRecipe` whose sole call is `L1StandardBridge.depositETHTo(l2Recipient, …)`,
   compute its escrow (`exitRecipeEscrow`, cross-checked against the live `escrowAddressFor` before
   anything is signed), then settle an `OP_UNWRAP` with `recipient = escrow` — by default through the
   relay (`mode: 'settle'`), so the depositor's own EOA never appears in the exit.
4. **`activate`** — permissionless: fire `activateExit(recipe)`, which deploys the recipe-bound escrow
   clone and runs the pinned batch (the Base deposit + a zero-cost residue sweep).

## Privacy levers, and why

- **Flat, gas-derived relay fee (`feeBps: 0`)** — a percentage fee would encode the note's size into a
  public number independent of the (already-public) payout; a flat fee only leaks the gas regime at
  settle time, identically across every note size. See `dapp/confidential-pool-ux.js:1405-1411` for the
  same reasoning applied to transfers.
- **Relay-settled exit, not self-submitted** — `pool.settle()` is called by the relay's own key
  (`worker-relay/src/settle-relay.js`), so the only address anyone sees at exit time is the recipe-bound
  escrow, never the depositor's wallet. `--self-submit` exists as a fallback (atomic
  `exitAndExecute`, fee-free) for when the relay is unavailable, at the cost of the caller's EOA
  appearing.
- **Tranches are advisory, not enforced** — the script prints the nearest of 0.01 / 0.1 / 1 / 10 ETH and
  a warning when the amount isn't one, but does not block on it. Enforcing exact denominations needs a
  populated pool to matter; see the caveat below.
- **A dedicated, per-exit L1 dust address** — `ExitRecipe.finalRecipient` is derived fresh per exit
  index (`tacit-exit-dust-v1:<network>:<index>`), never equal to `l2Recipient` (an L1 vs. L2 address)
  and never reused across exits (reuse would itself be a cross-exit correlation key). This deliberately
  does **not** follow `buildBridgeExit`'s own default of `finalRecipient = l2Recipient`
  (`dapp/confidential-router.js:801`) — that default is also where the entire principal lands on the
  `reclaimExit` rescue path, and `forceSafeTransferETH` means a wrong address swallows funds silently
  rather than reverting.
- **Seed-derived, not raw-random, recipe nonce** — `activateExit`/`reclaimExit` both need the exact
  recipe struct to reach a funded escrow. A raw-random nonce that only lives in the state file turns a
  lost file, after settlement, into permanently stranded funds. Deriving it from
  `(walletFingerprint, index)` costs nothing and removes that failure mode.

## The honest privacy boundary

Same boundary `buildBridgeExit` already documents (`dapp/confidential-router.js:755-756`): the exit
amount, `l2Recipient`, and the exit's timing are all public on L1 the moment `activateExit` lands. This
is "shielded accumulation, then exit anywhere" — never present it as a private cross-chain transfer.
All the privacy the flow has comes from the size and composition of the pool's anonymity set at the
moment of exit, not from anything at the exit step itself.

## The caveat that matters right now

As of 2026-09-05, live mainnet reads: `pool.nextLeafIndex() == 1`, pool ETH balance `== 0`. There has
never been a real ETH wrap into this pool. **An exit today is trivially linkable by elimination — it is
the only deposit that could be the source.** None of the levers above change that; they only matter
once the pool has real, concurrent volume. `scripts/confidential-exit-base.mjs exit` gates on this
(`nextLeafIndex < 20` requires `--i-understand-low-anonymity`) and any run before the pool has volume
must be treated as a **functional smoke test**, not a privacy demonstration.

## Rescue matrix

| Situation | Mechanism |
|---|---|
| Relay settles, `activateExit` reverts transiently | Escrow already holds the funds; `activateExit` is re-runnable by anyone (`ConfidentialRouter.sol:1046-1058`) |
| Batch becomes permanently unexecutable (bridge paused, stale quote) | After `recipe.deadline`, `reclaimExit(recipe, [])` sweeps the escrow to `finalRecipient` on L1 without running the batch (`:1089-1103`) |
| Relay never settles | Nothing was spent — the note is untouched; retry, or fall back to `--self-submit` |
| Someone else settles the proof first | Harmless by design: the escrow address is a pure function of the recipe, so funds land there regardless of who submitted; `activateExit` finishes it |
| Wrong `l2Recipient` | **Unrecoverable** — Base credits whoever was named. The `exit` subcommand prints the recipe for review before any proof is built; there is no on-chain undo |
| State file lost after a recipe is pinned but before settlement | Fully recoverable: `WALLET_PRIV` + the `index` reconstruct the note, the nonce, and the dust address deterministically |
| State file lost after settlement | The escrow's funds are still reachable — the recipe struct is deterministic from `(WALLET_PRIV, index, l2Recipient, deadline)`, all of which are either persisted or re-derivable; only a manually-typed `l2Recipient`/custom deadline that was never saved anywhere is at risk |

## Not in scope

`crossOut` / the Bitcoin lane. `ops/INTEGRATION-simple-wrap-send-claim-eth.md:258-268` documents that a
`crossOut` while `bitcoinConsumedCount == 0` permanently freezes the reflection fold for this pool. This
flow never touches that counter and must not grow a path that does.
