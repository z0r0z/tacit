# AMM Circuit Pre-Ceremony Review Findings

Independent circuit-audit pass against `bjj_pedersen.circom`, `amm_lp_add.circom`,
`amm_lp_remove.circom`, and `amm_swap_batch.circom`. This document tracks
findings, severity, and resolution status. Used as the "what was reviewed
and resolved before locking the ceremony" artifact.

## Summary

| Severity | Count | Resolved | Pending |
|---|---|---|---|
| CRITICAL | 0 | 0 | 0 |
| HIGH (completeness) | 2 | 2 | 0 |
| MEDIUM | 3 | 1 | 2 (deferred — see below) |
| LOW | 2 | 2 | 0 |
| INFORMATIONAL | 6 | n/a | n/a |

**Two HIGH-severity completeness gaps fixed before ceremony.** No soundness bugs
were found. Three MEDIUM-severity hygiene items intentionally retained for
defense-in-depth or accepted as out-of-circuit indexer responsibility.

## Findings

### 1. HIGH — `LessThan(65)` too narrow for worst-case `divisor` ✅ FIXED

**File:** `amm_swap_batch.circom` (pre-fix line ~322)

`divisor` is `P_clear_num` or `P_clear_den`, both of which can reach ≈ 2^68
(N=16 traders × u64 amounts plus a u64 net-delta magnitude). The original
`LessThan(65)` rejects valid small remainders when `divisor > 2^65` because
`Num2Bits(66)` on `rem + 2^65 − divisor` field-wraps for valid inputs.

Not a soundness break — a cheating prover also can't satisfy it — but
legitimate large-volume batches couldn't be proved. Completeness gap.

**Fix:** Bumped to `LessThan(70)` with explicit `Num2Bits(70)` range proofs on
both `rem[i]` and `divisor[i]` before the comparison. Adversarial test
"rem ≥ divisor (forge a high quotient) ⇒ rejected" continues to pass.

### 2. HIGH — `rem[i]` not explicitly range-checked ✅ FIXED

**File:** `amm_swap_batch.circom`

`rem[i]` had no direct bit decomposition; its only bound was implicit via
`LessThan`'s internal `Num2Bits`. Fragile pattern that could fail to constrain
under field-wraparound at scale.

**Fix:** Added `Num2Bits(70)` on `rem[i]` explicitly, alongside the divisor
range proof (same fix as #1).

### 3. MEDIUM — `n_intents` not constrained in-circuit (DEFERRED, out-of-circuit responsibility)

**File:** `amm_swap_batch.circom`

`n_intents` is `Num2Bits(5)`-bounded but otherwise free. Active-vs-padded slot
discrimination is enforced **out-of-circuit** by the indexer matching each
public `C_in_BJJ` against the signed-intent set: padded slots have BJJ
identity `(0, 1)` and zero commitments; active slots require a backing
`intent_sig`. The circuit's per-slot constraints hold trivially for the
padded pattern and tightly for active patterns.

**Resolution:** Retained as informational public input. The indexer (see
`tests/amm-validator.mjs validateSwapBatch`) is the authoritative active-
vs-padded discriminator via signed-intent matching. The reference indexer
should additionally verify `n_intents` equals the count of slots with
non-identity `C_in_BJJ` for envelope-decode hygiene; that's an indexer-
side normative rule, not a circuit constraint.

### 4. MEDIUM — `S_pre` comment overstates its role (DEFERRED, intentional defense-in-depth)

**File:** `amm_swap_batch.circom`

`S_pre` is `Num2Bits(64)`-checked but otherwise inert in swap math (swaps
don't change LP shares). Comment originally claimed it bound the proof to
prevent cross-pool replay; replay protection actually comes from `pool_id_fr`.

**Resolution:** Retained as defense-in-depth — the indexer can cross-check
that `S_pre` matches `pool.lp_total_shares` at proof-generation height,
adding a stale-snapshot detection layer. Updated the inline comment to
reflect that `pool_id_fr` is the actual replay-prevention binding and
`S_pre` is an out-of-circuit indexer cross-reference. Dropping it would
shift the public-input vector layout, which is a ceremony-affecting
decision; keeping it costs ~64 constraints and one Fr in the public
vector.

### 5. MEDIUM — Unused `pool_id_squared` signal (DEFERRED, defensive pattern)

**Files:** `amm_lp_add.circom`, `amm_lp_remove.circom`, `amm_swap_batch.circom`

`pool_id_squared <== pool_id_fr * pool_id_fr` is intended to force
`pool_id_fr` into the proof's polynomial system. Modern circom + snarkjs
preserves all declared public signals without this trick, so the squaring
is unnecessary in current toolchain versions.

**Resolution:** Retained as belt-and-suspenders. The pattern is also used in
the production mixer's `withdraw.circom` (line 102 of `dapp/circuits/withdraw.circom`)
and removing it would diverge from established protocol practice for ~3
constraints' savings across three circuits. Worth keeping for parity with
the mixer's hardening discipline.

### 6. LOW — `fee_bps` cap loose ✅ FIXED

**File:** `amm_swap_batch.circom`

Original `Num2Bits(10)` allowed `fee_bps` up to 1023, while the spec
normative cap is 1000 (10%).

**Fix:** Added explicit `LessThan(11)` against 1001 so the in-circuit cap
matches the spec exactly. Adversarial tests "fee_bps = 1001 ⇒ rejected"
and "fee_bps = 1023 ⇒ rejected" confirm.

### 7. LOW — Spot-batch sign bits non-canonical ✅ FIXED

**File:** `amm_swap_batch.circom`

In a spot batch (both magnitudes 0), `delta_A_net_sign` and `delta_B_net_sign`
were unconstrained, so two distinct proofs could differ only in inert sign
bits. No exploit, but non-canonical public inputs.

**Fix:** Added `is_spot * (delta_A_net_sign + delta_B_net_sign) === 0` so
spot batches canonicalize to `(0, 0)`. Adversarial test "spot batch with
non-canonical signs ⇒ rejected" confirms.

### 8. LOW — `variant` in `amm_lp_add` is bit-bounded but otherwise unused

**File:** `amm_lp_add.circom`

`variant * (variant - 1) === 0` enforces the bit, but no semantic check.
Indexer enforces that variant=0 envelopes use the `lpAddShares` formula
and variant=1 envelopes use `lpInitShares` (see `tests/amm-validator.mjs`).

**Resolution:** Out-of-circuit responsibility, already correctly placed.
The bit constraint prevents the prover from setting `variant` to anything
other than 0 or 1, which is sufficient for circuit correctness.

### 9. INFORMATIONAL — NUMS generator constants verified

H_BJJ and G_BJJ decimal constants in `bjj_pedersen.circom` match the pinned
hex coordinates in `tests/amm-bjj.test.mjs` byte-for-byte. The
`amm-bjj.test.mjs` parity suite (36 tests) verifies this at every test run.

### 10. INFORMATIONAL — Padding exploitation: no in-circuit attack

Per-slot constraints hold independently of "padded" or "active" semantics.
Padded slots use `amount_in_swap=0, amount_out=0, tip=0, direction=0,
C_in_BJJ=(0,1), C_out_BJJ=(0,1)`, all constraints trivially satisfied.
An attempt to "activate" a padded slot puts a real `C_in_BJJ` into the
public signals vector; the indexer then requires a backing `intent_sig`.
The circuit doesn't enable padding-vs-active forgery — the indexer's
intent-set matching does the discrimination. Adversarial tests
"padded slot with non-identity C_in_BJJ" and "padded slot with non-zero
amount_in_swap" confirm rejection.

### 11. INFORMATIONAL — Direction multiplexing sound

`multiplier` and `divisor` are linear combinations of `direction[i] ∈ {0,1}`
with `P_clear_num/P_clear_den`. The bit constraint `direction · (direction−1) = 0`
forces these to equal either `(P_clear_den, P_clear_num)` (A→B) or
`(P_clear_num, P_clear_den)` (B→A) exactly. No third value reachable.

### 12. INFORMATIONAL — Spot vs non-spot discrimination tight

`is_spot = IsZero(Δa_mag) · IsZero(Δb_mag)` — both must be exactly 0 for
`is_spot=1`. `is_A_dom = (1−is_spot)·(1−sign_A)`, `is_B_dom = (1−is_spot)·sign_A`.
Sums and is_spot partition cleanly. `P_clear` is unambiguously one of
`(R_A_pre, R_B_pre)`, `(X_sum, Y_sum + |Δb|)`, or `(X_sum + |Δa|, Y_sum)`.

### 13. INFORMATIONAL — Range bounds complete for Pedersen-opening amounts

`amount_in_swap[i]` and `tip_amount_witness[i]` are each `Num2Bits(64)`-checked,
and their sum is fed to `PedersenBJJ.amount` which internally `Num2Bits(64)`-checks
again. The inner check is the binding one for overflow: if `amount_in_swap +
tip_amount ≥ 2^64`, `PedersenBJJ` rejects, blocking u64-overflow attacks.

### 14. INFORMATIONAL — Tip equality binding sound

`tip_amount_witness[i] === tip_amount[i]` is a direct R1CS equality. Cannot
be satisfied with non-matching values.

### 15. INFORMATIONAL — No R1CS non-quadratic-constraint pitfalls

Every multi-term product is correctly broken into intermediate signals
(`X_per`, `Y_per`, `multiplier_AtoB_arr`, etc.). All `<==` statements are
single multiplications. Auxiliary arrays cost minor constraints but ensure
each constraint emits cleanly.

## Pre-ceremony validation results

After fixes:

| Suite | Tests | Pass | Fail |
|---|---|---|---|
| Witness generation (honest paths) | 9 | 9 | 0 |
| Adversarial witness (attack vectors) | 28 | 28 | 0 |
| Compilation + constraint budget | 3 | 3 | 0 |

Constraint counts after hardening:

| Circuit | Constraints | Budget | Margin |
|---|---|---|---|
| `amm_lp_add` | 5,154 | 30,000 | 5.82× |
| `amm_lp_remove` | 10,370 | 30,000 | 2.89× |
| `amm_swap_batch` | 172,158 | 300,000 | 1.74× |

## Ceremony-ready statement

The four circom files in `dapp/circuits/amm/` are pre-ceremony-ready as of
this review pass. All HIGH-severity completeness gaps are resolved. No
soundness bugs were identified. The three deferred MEDIUM items are
informational public inputs whose semantics are enforced out-of-circuit by
the indexer, intentionally retained for defense-in-depth or protocol
parity with the existing mixer.

Locking these circuits via Phase 2 ceremony commits to:
- The 4 `.circom` source files at their current state
- The 124 public-input vector for `amm_swap_batch` (12 globals + 5×16 per-intent + 2×16 per-receipt)
- The 5 / 8 public-input vectors for `amm_lp_add` / `amm_lp_remove`
- The pinned `H_BJJ` and `G_BJJ` decimal coordinates
- N_MAX = 16 batch size
- u64 amount range, 251-bit BJJ blinding range
- All algorithmic decisions encoded in the constraint set
