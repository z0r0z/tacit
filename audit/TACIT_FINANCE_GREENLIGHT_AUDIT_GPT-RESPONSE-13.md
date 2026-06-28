# Maintainer response — GPT greenlight audit, round 13 (bundle @ `10c02ae`)

Thirteenth pass. It did not stay clean: it found one **High fund-impacting** issue — the reflection
fold-atomicity class (round 4's class), broadened from the round-12 positional-selection finding to
witness-append atomicity. Fixed + the class swept. No other finding; the round-10/12 fixes and the
cross-chain/relayer/cBTC surfaces were re-confirmed.

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| H-01 | Bitcoin reflection strands Track-B AMM spends by skipping witness-only post-spend folds | High (user lock/loss) | **Real** | **Fixed** (class swept) |

## H-01 — witness-append atomicity in the scan_tx_spends-based AMM ops — FIXED

Confirmed. For `T_SWAP_VAR`, `T_SWAP_ROUTE`, `T_LP_ADD`, `T_LP_REMOVE`, `T_LP_BOND`, the per-tx scan nullifies
the victim's input note in `scan_tx_spends` and commits it to `bitcoinSpentRoot` (the upstream spent fold)
**before** the op-fold onboards the output (receipt / LP-share / withdrawn note / bond receipt). The op-folds
are atomic *within themselves* (they stage the note append before mutating), but the dispatcher consumed a
witness-append failure with `.is_ok()` / `let _ =` (LP-add additionally restored only the pool registry, the
round-4 half-apply). So a malicious prover could attest a real canonical block, let the guest nullify the
victim's already-live input, then supply a **bad append path**, and the fold would silently skip — input spent,
output never onboarded, and the contract chains the poisoned digest → permanent user lock/loss. This is the
same "pre-fold mutation stranded after the selected candidate fails" class as round 12, broadened to witness
atomicity.

**Fixed** by splitting "invalid tx → skip (liveness)" from "valid tx, bad prover witness → abort": once an
op's in-fold authorization (input-side kernel / receipt opening / reserve floor, or the dispatcher's
kernel-bound pool selection) has verified, the remaining note-tree append is a **deterministic** witness an
honest prover always derives correctly — so a failure there is a malicious/buggy proof and now **aborts**
(panic-reject) rather than skips. Concretely, the post-auth `keccak_tree_append_transition` / `fold_output` /
`fold_lp_share_mint` / `fold_note_append` calls in the five folds changed from skippable `Err`/restore to
hard abort. An honest prover's proof of the same block onboards the output atomically (no liveness loss); a
bad-path proof is rejected, so the input is never stranded. The LP-add round-4 partial-restore (which left the
input nullified) is replaced by the abort.

**Class swept.** The five affected ops are exactly those that consume their input via the upstream
`scan_tx_spends` + spent-root commit and then onboard. The sibling note-onboarding folds — farm
harvest/unbond/refund, protocol-fee claim, cross-out — consume their input **atomically inside the fold**
(membership / `receipt_spend_root` / consumed-set insert, committed together with the append), so a bad append
returns `Err` with nothing committed and cannot strand. cBTC redeem unlocks (no onboard). So no sibling
instance remains.

## Verification
cxfer-core 154/154 (the farm-fold test's bad-append assertion updated: a bad append after a valid bond now
aborts, asserted via `catch_unwind`); the reflection DIGEST_MATCH gate is green (fixtures have valid append
paths → the folds onboard exactly as before; only bad-path inputs, which fixtures don't contain, now abort);
forge unaffected (no contract changes). The auditor re-confirmed the round-10 block-auth, round-12 LP-add
disambiguation, cross-chain consumed-freshness/ETH-recursion, and relayer surfaces all hold.

## Net
H-01 (the High strand/loss) is closed and the witness-atomicity class swept. Because this pass again surfaced
a real fund-impacting finding (the third "final" round to do so: r10 Critical, r12 Medium, r13 High), a
further confirmatory round on the H-01-fixed commit is warranted before the re-prove + immutable lock.
