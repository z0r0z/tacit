# Changes since the last review round

This records what changed since the previous bundle so a returning reviewer can focus. Audit the code
independently — this is a map, not a substitute for review. Nothing here is a claim of correctness.

## Findings from the prior round — applied

- **Farm receipt accounting (was H-01, "future-checkpoint farm-budget freeze").** The stopgap exact-live
  `rps_entry` check has been **replaced** by a MasterChef-style execution-stamped entry: the controller
  (`FarmController`, ETH lane) and the reflection fold (BTC lane) stamp `entryRps` onto a **stable receipt
  leaf** at settle. `farm_receipt_leaf` dropped the checkpoint (v3, a stable position id); harvest bounds
  against the stamp and re-stamps in place (a replay pays 0), no consume-and-remint; unbond retires the stamped
  debt exactly and deletes the stamp. `recover`/`notify` reserve the exact
  `(rps·totalShares − totalRewardDebt)/PRECISION`. This structurally eliminates the freeze (entries can no
  longer be future-dated) and, as a side effect, makes farms **stake-anytime**. Mirrored for the cUSD savings
  (TSR) receipts in `CollateralEngine`. **Two implementation notes for reviewers** (see also the farm design):
  - `rateSnapshot` is **overloaded** — the CDP debt accumulator for CDP ops, the **receipt leaf** for
    farm/savings RECEIPT ops (inert in its CDP meaning there). Commented at each site.
  - The controller keys `entryRps` on the guest-supplied receipt leaf (via proof-committed `rateSnapshot`)
    without a pool-side re-derivation: the guest binds it to the receipt it proved membership + owner-signature
    over, so a valid proof already guarantees it is the authorized position. This trades a small amount of
    contract-independence defense-in-depth for zero pool-bytecode cost — **confirm the guest binding.**
- **Native-ETH delivery (was L-01).** `ExitExecutor._sweep` and `CollateralEngine.claimEscrow` use
  `forceSafeTransferETH`, so a non-payable bound recipient can no longer strand ETH.
- **`exitAndExecute` fee-delta (was F-1).** The router now binds every `PublicValues.withdrawals` recipient to
  the recipe escrow before settling, so a settle can only credit the router with its fee leg.
- **btcHomed consume (was F-2).** The pool records the Bitcoin consume for **any** btcHomed spend, not only
  value-bearing ones, so a source is always retired.
- **Nullifier definition (spec/code reconciliation, was B-4).** `ν = keccak(note_leaf ‖ "spent")` over the
  full authenticated leaf is now stated once and the design docs are reconciled to it (see
  `DESIGN-unified-source-identity.md` / `DESIGN-btc-note-authority.md`).
- **In-guest Groth16 verifier (was B-2).** The baked ceremony `batch_vk` now has a committed test vector
  (`fixtures/swapbatch_ceremony_vector.bin`) proving it verifies a **real finalized-ceremony** proof, plus
  tampered-public and G2-limb-swap negatives. `OP_SWAP_BLIND` and the `T_SWAP_BATCH` fold remain **dormant**;
  `groth16.rs` documents the activation gate. (A stake-anytime-farm-style follow-up may arm OP_SWAP_BLIND; it
  is not armed here.)

## Bitcoin light relay — now IN scope, and rewritten (was COV-01 + a new finding)

`BitcoinLightRelay.sol` was absent from the prior bundle; it is now included, and its fork choice was
rewritten in response to a reorg finding:

- **Per-branch retarget (R-1).** The relay previously stored one global `epochTarget[epoch]` and barred any
  non-tip branch from crossing a 2016-block boundary — so a reorg of a boundary-height tip permanently pinned
  the tip to the orphan (a permanent Bitcoin-lane freeze). It now stores the difficulty target **per block**
  (`blockTarget`): each block inherits its parent's target within an epoch and derives a fresh one at each
  boundary crossing from its own branch, and the boundary bar is removed. A boundary reorg is now an ordinary
  heaviest-chain reorg. Validated against the real mainnet 471→472 boundary and fork-choice isolation tests.
- **Reflection deep-reorg posture (R-2).** A reorg deeper than `REFLECTION_CONFIRMATIONS` halts reflection
  **fail-closed** by design — re-anchoring would resume onto already-paid-out orphaned bridge mints (silent
  inflation), so the halt is the correct response. `REFLECTION_CONFIRMATIONS` defaults to 6 (above any
  post-2015 reorg). Documented at `ConfidentialPool` `lastReflectionBlockHash`.
- **Genesis timestamp (R-3).** `genesis(startTimestamp)` is a DEPLOY-CRITICAL trusted input (a 1-second error
  bricks the first retarget); documented as a deploy-checklist item (derive from the real first-block header,
  cross-check two explorers).

## Router entrypoints

The public swap entrypoints were merged (`swapPublicExactIn` / `swapPublicExactOut`) to fit EIP-170 with all
features retained (exact-in, exact-out, ETH via `tokenIn == address(0)`, Permit2, EIP-2612). `ConfidentialPool`
and `ConfidentialRouter` deployed sizes are 24,484 B (+92) and 24,547 B (+29) under the 24,576 B limit.

## Standing (unchanged from the ground rules)

Bytecode/vkey reproducibility and the guest↔dapp mirror are a separate build/reprove step. The farm redesign
and the ν-leaf change rotate the settle **and** reflection ELF/vkeys and the reflection genesis digest; the
pinned artifacts under `pins/` and the fixtures are regenerated in that step, so the source here may be ahead
of any currently-deployed instance. Review the **source**; treat the pinned vkey/bytecode as informational.
