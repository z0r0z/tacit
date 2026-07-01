# Maintainer response — GPT greenlight audit, round 14 (bundle @ `74ec0e1`)

Fourteenth pass. Three fund-impacting findings — one a **regression of the round-13 fix** (the abort boundary
was drawn too wide), one a broadened round-13-class strand, one a farm-init change-handling loss. All fixed.

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| F-01 | A malformed `T_LP_ADD` share note makes honest reflection proofs panic forever | Critical (forward-stall) | **Real (round-13 regression)** | **Fixed** |
| F-02 | A verified scan-free burn-deposit can be silently omitted by a bad spent-set witness | High (lock/loss) | **Real** | **Fixed** |
| F-03 | `T_FARM_INIT` accepts non-sentinel change but never onboards it | Medium (launcher loss) | **Real** | **Fixed** |

## F-01 — LP-add share-mint abort was too wide (round-13 regression) — FIXED

The round-13 H-01 fix made the LP-share onboard `.expect()` (abort) on the premise that, after the funding
kernels verify, only the deterministic append path can fail. But `fold_lp_share_mint` also enforces
**tx-controlled semantic** checks — `lp_shares > 0`, `share_csecp` on-curve, and `share_csecp` opening to the
reflection-computed `lp_shares` — and the LP-add kernel binds `share_csecp` but does NOT prove it opens to
`lp_shares`. So a griefer can confirm an LP-add with valid A/B funding kernels and a mismatched share
commitment; every honest prover then hits the `.expect` and aborts → permanent Bitcoin-reflection stall under
the immutable vkey. The abort boundary caught semantic invalidity, not just witness invalidity.

**Fixed** by splitting the two: the dispatcher now validates the share semantics (`lp_shares > 0`,
`decompress(share_csecp)`, `verify_pedersen_opening(share_csecp, lp_shares, share_r)`) BEFORE the abort. A
malformed share is the LP's own bad tx → restore the pool registry + **skip** (the malformed input is forfeit,
but the block reflects — no stall). Only AFTER the semantics pass is the remaining note-append a deterministic
witness, so a failure there still **aborts** (round-13 H-01 — never strand a valid op's nullified input).
Mirrored in the JS attester (validate-before-mutate, restoring the pool on a bad share). The round-13 lesson
holds in the other direction: abort only after EVERY tx-controlled check has passed.

## F-02 — scan-free burn-deposit silent-omit — FIXED

A verified burn-deposit's commit was gated by `if state.fold_spent(env_nu, …).is_ok()`, so a malicious prover
supplying a bad FRESH spent-set insert witness made `fold_spent` return `Err`, the branch silently skipped the
note append + `fold_burn`, and the proof still advanced the digest — leaving the confirmed Bitcoin burn out of
`bitcoinBurnRoot`/the pool tree and permanently blocking `OP_BRIDGE_MINT`. **Fixed** by adopting the main
spent loop's duplicate-vs-fresh discipline: a FRESH ν whose insert witness fails now **aborts** (a verified
burn-deposit must be recorded or the proof rejected); a genuine duplicate ν (re-presented bridge / ν-collision)
is a membership-gated no-op (already in both spent + burn).

## F-03 — farm-init non-sentinel change loss — FIXED

`fold_farm_init` reuses the swap-shape kernel, which permits a non-sentinel change (`C_in − C_change =
reward_total·H`), but — unlike `fold_swap_var` — it never onboards a change note. So a launcher funding with an
overfunded note has the whole input nullified, only `reward_total` credited to the treasury, and the residual
change stranded. Farm-init is **exactly funded by design** (the gen + the launcher flow use the sentinel), so
**fixed** by enforcing it: `fold_farm_init` rejects a non-sentinel `c_change_or_sentinel` (mirrored in the JS
attester). Rejecting (rather than onboarding) is the safe, design-consistent choice — onboarding a change note
in farm-init would add a witness-stream/atomicity surface in the area that just produced two regressions, for
a path the worker never uses. The worker funds the treasury with a note worth exactly `reward_total`.

## Verification
cxfer-core 154/154 (farm-init test now funds with the sentinel + asserts a non-sentinel reject; the lp_bond
bad-append `catch_unwind` from round 13 stands). The reflection DIGEST_MATCH gate is green — the three affected
fixtures (`lp_poolinit`, `lp_add`, `farminit`) regenerate to byte-identical digests, confirming the guest +
JS-attester changes are no-ops on valid inputs. Forge unaffected (no contract changes).

## Net
F-01 (the reintroduced Critical stall), F-02 (the High silent-omit), and F-03 (the Medium launcher loss) are
closed; the JS attester mirrors the guest. The round-13 over-abort is corrected (skip on tx-controlled
semantic invalidity, abort only on a post-validation deterministic-witness failure). A further confirmatory
round is warranted before the re-prove + immutable lock.
