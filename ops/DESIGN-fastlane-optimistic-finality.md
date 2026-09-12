# Fast-lane optimistic finality — cross-generation double-spend, closed by mechanism

Supersedes the MPT-storage-proof and "keep every pool attested forever" ideas explored earlier
tonight — both were trying to *prevent* the cross-generation race. This design applies the
already-shipped philosophy from `PLAN-fast-lane-shared-nullifier.md` §"the one insight that makes
this tractable" to the pool-vs-pool case instead of only the Bitcoin-vs-Ethereum case: **do not
prevent the race. Let the shared, already-existing reflection be the single arbiter that credits
the value at most once and voids the loser.**

## The state machine

A Bitcoin-homed fast-lane spend produces a **pending claim**, not a live asset, until one reflection
cycle confirms no conflicting claim exists on another generation.

```
PENDING  --[reflection confirms sole claim]-->  FINAL   (asset becomes live/transferable)
PENDING  --[reflection finds a same-ν claim elsewhere, this one loses]-->  VOID  (claim discarded, nothing to unwind)
```

Losing is decided by the same seniority rule already in `PLAN-fast-lane-shared-nullifier.md` §4:
whichever claim the reflection folds first wins; the other is void. No new tie-break rule needed —
reuse it verbatim.

### Contract changes

`ConfidentialPool.sol`, at the exact point `bitcoinConsumed[nu]` is written (`:1897`, inside `_settle`):

```solidity
// Existing:
bitcoinConsumed[nu] = _hash(pv.spendRoot, pv.bitcoinConsumedSources[i]);

// New: the value-bearing output for THIS nu is recorded as pending, not live.
pendingClaim[nu] = PendingClaim({
    outputLeafOrEscrowRef: pv.pendingOutputs[i],   // whichever the op produced: a leaf, or an escrow-release ref
    claimant: pv.pendingOwners[i],                 // who receives it on finality
    submittedAtHeight: block.number,
    finalized: false
});
emit FastLaneClaimPending(nu, pv.pendingOutputs[i]);
```

The output (leaf insertion into the note tree, or escrow release) does **not** happen here anymore
— it happens in `finalizeFastLaneClaim`, gated on reflection confirmation:

```solidity
/// @notice Anyone may finalize a pending fast-lane claim once the reflection has confirmed this pool's
///         consume was the senior (first-folded) one for its ν. Permissionless — the claimant doesn't
///         have to call it themselves; matches attestBitcoinStateProven's own permissionless-submit model.
function finalizeFastLaneClaim(bytes32 nu) external {
    PendingClaim storage c = pendingClaim[nu];
    if (c.finalized) revert AlreadyFinalized();
    if (c.claimant == address(0)) revert NoSuchClaim();
    // The reflection's own consumed-set membership IS the confirmation: fold_consumed only inserts a ν
    // once (guest .expect() panics on a double-insert — PLAN-fast-lane-shared-nullifier.md §3), and it
    // only inserts for a fold sourced from an eth-reflection proof of THIS pool's storage. So "this pool's
    // bitcoinConsumed[nu] survived into the reflected consumed-set" is exactly "this pool's claim was
    // senior." A losing pool's claim is never folded (the note was already removed from `live` by the
    // winner), so this check can never pass for the loser — no separate voiding transaction needed, the
    // loser's claim simply never becomes finalizable, forever, which is the "void" state.
    if (!_reflectedConsumedSetContains(nu)) revert NotYetConfirmedSenior();
    c.finalized = true;
    _releaseClaim(c); // mint the leaf / release the escrow, now that seniority is proven, not assumed
}
```

**This is the key simplification over the earlier drafts**: there is no explicit "void" transaction,
no clawback, no frozen-then-unfrozen balance. A losing claim simply never satisfies
`_reflectedConsumedSetContains`, because the reflection guest's own completeness discipline
(`fold_consumed`'s panic-on-double-insert, already shipped) guarantees only the senior claim is ever
in that set. The loser's `PendingClaim` sits inert forever — no fund ever moved, so nothing to reverse.

### What "confirmed senior" costs the user, honestly

The window is exactly one reflection cycle for the relevant Bitcoin-side height — not one Bitcoin
confirmation, not the full bridge_burn/bridge_mint round trip. If reflection runs on a tight cadence
(minutes), this is a materially better UX than the slow bridge path, while being a real, honest wait
compared to today's (unsound) instant finality. State this plainly in the dapp UI — "pending, ~N
minutes" — never claim instant finality again for this path.

### Why this needs no predecessor list and no forever-running ops commitment

`_reflectedConsumedSetContains` only needs the reflection to know about *this pool's* consumed set —
the same thing it already needs for the Bitcoin-vs-Ethereum race today. It does not need to have
enumerated every possible sibling pool in advance, and it does not depend on anyone remembering to
keep attesting an old, forgotten deployment: if an old pool's claim is never reflected, it simply
never finalizes on that pool either — which is exactly correct, since an un-reflected claim has no
business becoming live. The "did we miss a pool" question from earlier tonight stops being a question
this design depends on answering.

## What has to change, concretely (scope, not a guess)

1. **`ConfidentialPool.sol`**: `PendingClaim` struct + mapping, `pendingOutputs`/`pendingOwners` fields
   added to `PublicValues` (appended last, per the existing field-ordering discipline —
   `ConfidentialPool.sol:716-723` shows the pattern to follow), `finalizeFastLaneClaim`,
   `_reflectedConsumedSetContains`, `_releaseClaim`. This rotates `PROGRAM_VKEY` (new public-values
   fields) — folds into the same re-prove cycle as any other guest change, not a separate one.
2. **Settle guest (`main.rs`)**: emit `pendingOutputs`/`pendingOwners` instead of directly inserting
   the leaf/releasing escrow for a btcHomed value-exit. The conservation/authorization logic already
   proven doesn't change — only *when* the output becomes live changes.
3. **`_reflectedConsumedSetContains`**: reads the reflection's own consumed-set membership for this
   pool — needs the exact accessor shape decided against `reflect.rs`'s actual committed-set structure
   (an IMT membership check, mirroring how `check_btc_nonmembership` already works, called from
   Solidity instead of the guest — needs a membership witness passed to `finalizeFastLaneClaim`, not a
   bare boolean read).
4. **Dapp**: surface pending vs. final state; a "finalize" prompt/auto-call once the window passes.

## Test plan (the one that actually proves the fix)

`test_cross_generation_fastlane_race`: deploy two pools sharing one reflection fixture. Submit the
same ν's fast-lane consume on both. Run reflection folding once (senior wins per existing seniority
rule). Assert: the senior pool's `finalizeFastLaneClaim` succeeds and releases real value exactly
once; the loser's `finalizeFastLaneClaim` reverts `NotYetConfirmedSenior` **forever** (re-check after
advancing many blocks — it must never become finalizable, not just "not yet"). This is the test that
would have caught tonight's entire multi-hour discussion in under a second, which is the actual bar
for calling this closed.

## Status

Designed, not built. This is real contract + guest work — new PublicValues fields rotate the vkey,
which means a re-prove, which means this cannot land in the same commit as tonight's readiness-gate
fixes. It has to happen before gen1's constructor is finalized, since `PendingClaim`/`finalizeFastLaneClaim`
need to exist in the immutable bytecode from birth. This is the one piece of tonight's work that
actually blocks broadcast — not because the current numbers are unsafe (they're verified negligible),
but because this is the true, complete fix, and it can never be added after the fact.
