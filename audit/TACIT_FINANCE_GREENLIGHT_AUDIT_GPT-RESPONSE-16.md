# Maintainer response — GPT greenlight audit, round 16 (bundle @ `aee0d9f`)

Sixteenth pass. Two fund-impacting findings — **both incomplete versions of my own round-14/15 fixes** (the
auditor caught the remaining branch of each duplicate-vs-fresh fix), plus one Low confirming the round-15
receipt-nullifier note. All addressed.

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| F-01 | A valid cross-out can still be skipped by a *mislabeled-replay* witness (incomplete R15 fix) | Medium (censor/lock) | **Real** | **Fixed** |
| F-02 | Burn-deposit conflates *spent*-replay with *burn*-replay → a fresh burn whose ν is already spent is dropped (incomplete R14 fix) | High (mint lock/censor) | **Real** | **Fixed** |
| Q-01 | Receipt-nullifier insert conflates replay/bad-fresh (atomic, retryable) | Low | **Confirmed non-fund** | **Documented** |

## F-01 — cross-out mislabeled-replay skip — FIXED

The round-15 fix split replay (`c_low_value == claim_id` → membership-gated no-op) from a fresh insert (abort
on a bad witness), but the replay branch itself returned `Err` when the claimed-replay membership proof failed,
and the dispatcher's `let _ = …` swallowed that as a skip. So a prover could take a fresh, ETH-authorized
cross-out, set `c_low_value == claim_id` to force the replay branch, and supply a bogus membership witness →
the confirmed mint is silently omitted (censored) while the digest advances. After ETH membership has passed,
an invalid claimed-replay is no longer tx-controlled semantics — it's a deterministic prover-witness failure.
**Fixed** by converting that `return Err` to an aborting `assert!(imt_membership(...), …)`: a genuine replay
proves membership (no-op); a mislabeled fresh mint aborts the proof. Only the pre-membership non-member check
remains a skip.

## F-02 — burn-deposit spent/burn replay conflation — FIXED

The round-14 burn-deposit fix gated the note-append + `fold_burn` on the **spent** side being fresh (`sv ==
env_nu` → spent-membership no-op, *skip the rest*). But a ν can be present in `spent_root` yet absent from
`burn_root` — a commitment-collision ν, or a ν that was spent normally before this burn-deposit. In that case
the verified burn-deposit took the spent-replay path and never recorded the burn, so its confirmed-on-Bitcoin
burn never reached `bitcoinBurnRoot`; `OP_BRIDGE_MINT` then can't prove `ν → dest` and the Ethereum mint is
permanently blocked. (As the auditor confirmed, the settle contract still requires current-burn-root membership
and one-mint-per-ν, so this is omission/lock, not inflation.) **Fixed** by handling the two sets
**independently**, mirroring the normal reflected-burn replay gate: the spent side is a membership-gated no-op
on `sv == env_nu` else a fresh insert; the burn side **separately** is a membership-gated no-op on `bk ==
env_nu` (`utxo_membership`) else records the burn + appends the note whenever the **burn** is fresh — a bad
fresh witness aborts. The worker (`burn-deposit-assembler.js`) already called `foldSpent` / `foldNoteAppend` /
`foldBurn` independently, so this brings the guest in line with the worker; the burn-deposit fixture
regenerates to a byte-identical digest.

## Q-01 — receipt-nullifier insert — confirmed non-fund, documented

The auditor confirmed the round-15 observation: `receipt_spend_root` returns one `Err` for both a genuine
receipt replay and a bad fresh insert, and harvest/unbond skip on it. But it is **atomic/retryable** — the
receipt spend + new-receipt append are pre-validated before any mutation (harvest), and in unbond the LP-return
append (already an aborting `.expect` since round 15) lands the receipt/farm mutation only after it — so a bad
fresh witness commits nothing, no receipt is consumed, no reward/return is paid, and the user retries with the
still-valid receipt. No fund-stranding path. We keep the atomic-retryable behavior deliberately: converting the
receipt-nullifier to the duplicate-vs-fresh abort would add the same insert-witness surface in a path that
(unlike the cross-out / burn-deposit / note-appends) cannot strand or censor a confirmed authorized output, and
the round-14 precedent shows the over-abort risk of widening these boundaries on a lock-eve outweighs a
non-fund liveness-hygiene gain. Documented as intentional.

## Verification
cxfer-core 154/154 — the crossout test now additionally asserts a **mislabeled-replay with a bad membership
witness aborts** (alongside the round-15 replay-no-op + fresh-bad-witness-abort). The reflection DIGEST_MATCH
gate is green (21 PASS; the burn-deposit + crossout fixtures regenerate byte-identically; only the box-gated
`swapbatch` ceremony zkey is outstanding). Forge unaffected (no contract changes).

## Net
F-01 (the Medium cross-out censor) and F-02 (the High mint-lock) are closed — both were the remaining branch of
an earlier duplicate-vs-fresh fix, now completed; Q-01 confirmed non-fund and documented. The same exploit
template (skip a deterministic post-auth witness failure) is now closed across the cross-out and burn-deposit
folds in *both* their spent/burn and replay/fresh branches. Because this pass again surfaced real fund-impacting
findings (the sixth "final" round to do so), a further confirmatory round is warranted before the re-prove +
immutable lock.
