# SPEC §3.X Amendment — Tacit Range-Proof Primitive

> Status: ✅ Reference impl shipped (`tests/range-proof.mjs`, 39 tests passing).
> SPEC.md merge pending — this file is the normative form once landed.
>
> Defines a composable cryptographic primitive for proving public
> predicates over Pedersen-committed hidden u64 amounts. **No new opcode,
> no new domain tag, no new cryptographic assumption** — pure composition
> of tacit's existing 64-bit aggregate bulletproof
> (`bpRangeAggProve` / `bpRangeAggVerify`, SPEC.md §3.5) with Pedersen
> homomorphism (SPEC.md §3.3).
>
> Backwards-compatibility: purely additive, drops in without modifying
> existing tacit assets, UTXOs, opcodes, or ceremonies. Consumers
> embed range-proof attestation bytes inside their own envelopes.

---

## Motivation

Tacit already enforces `0 ≤ a < 2^64` on every confidential UTXO via the
standard 64-bit bulletproof attached at UTXO creation, and per-context
inequality bounds inside specific opcodes (AMM `min_out`, fee caps,
variable-fill `min_fill_amount`). What's missing is a **standalone,
composable** way for a holder to prove a richer public predicate about
their hidden amount — `≥ X`, `≤ X`, `∈ [X, Y]`, `> b` (hidden vs hidden),
or `= X` — to a third party without revealing the amount itself.

Direct consumers anticipated:

- **cUSD CDP collateralization**: prove `collateral_value ≥ debt · ratio`
  to authorize a draw or unlock.
- **Permissioned LP gates**: a pool can require provers to attest
  `balance ≥ K` before accepting LP_ADD from non-founder accounts.
- **Tiered fees**: prove `lifetime_volume ≥ tier_threshold` for a fee
  discount without revealing exact volume.
- **Anti-sybil holder gates**: "I've held ≥ X of asset Y for ≥ N blocks"
  proofs without privacy collapse.
- **Sealed-bid auctions**: prove `bid ≥ reserve_price` without revealing
  the bid until reveal time.
- **Privacy-preserving leaderboards**: tiered membership proofs without
  exact-balance disclosure.

The primitive is **opcode-free**: range-proof attestations live inside
other envelopes (cUSD CDP envelope, LP gate metadata, future bid records).
A future amendment may add a dedicated `T_RANGE_ATTEST` opcode for
publishing standalone attestations on chain, but it is not required for
the primitive itself.

---

## Predicate types

Each attestation embeds a `predicate_type` discriminator byte:

| Tag | Predicate | Bulletproof? | Cost |
|---|---|---|---|
| `0x00` `PRED_GE` | `a ≥ X` (X public) | 1× 64-bit BP | ~700 B |
| `0x01` `PRED_LE` | `a ≤ X` (X public) | 1× 64-bit BP | ~700 B |
| `0x02` `PRED_IN_RANGE` | `a ∈ [X, Y]` | 1× 2-element aggregated BP | ~750 B |
| `0x03` `PRED_GT_HIDDEN` | `a > b` (both hidden; `C_b` public) | 1× 64-bit BP | ~700 B |
| `0x04` `PRED_EQ` | `a = X` (X public; reveals blinding) | None (opening) | 41 B |

Equality (`PRED_EQ`) uses Pedersen opening rather than a bulletproof: the
prover reveals the blinding `r`, and the verifier checks
`C == X·H + r·G` directly. This reveals `a` to the verifier (who already
knows `X`) but cryptographically certifies the equality.

---

## Construction

All four bulletproof-based predicates reduce to a single
`bpRangeAggProve` call on a shifted commitment, leveraging Pedersen
homomorphism. The prover computes a derived value, calls the standard
aggregate-bulletproof producer, and emits the proof. The verifier
reconstructs the same shifted commitment deterministically from public
components and feeds it to `bpRangeAggVerify`.

```
PRED_GE        (a ≥ X):    prove (a − X) ∈ [0, 2^64)  against  C_a − X·H
PRED_LE        (a ≤ X):    prove (X − a) ∈ [0, 2^64)  against  X·H − C_a
PRED_IN_RANGE  (a ∈ [X,Y]): prove (a−X, Y−a) each ∈ [0, 2^64)
                            against  (C_a − X·H, Y·H − C_a)   [aggregated]
PRED_GT_HIDDEN (a > b):    prove (a − b − 1) ∈ [0, 2^64)
                            against  C_a − C_b − H
PRED_EQ        (a = X):    reveal r; verifier checks C_a == X·H + r·G
```

Soundness: identical to the underlying 64-bit aggregate bulletproof
(~128-bit DLP security under standard assumptions; same as every other
tacit bulletproof). Zero-knowledge: hides `a` against any verifier who
doesn't know `r`; for `PRED_EQ` the verifier learns `a = X` from the
opening, which is the predicate's whole point.

---

## Wire format

Each attestation is a self-describing byte sequence:

```
predicate_type(1)         — one of 0x00..0x04
predicate_params(*)       — type-dependent:
                              PRED_GE / PRED_LE:        X_LE(8)
                              PRED_IN_RANGE:            X_LE(8) || Y_LE(8)
                              PRED_GT_HIDDEN:           C_b(33)
                              PRED_EQ:                  X_LE(8) || r_revealed(32)
proof_len_LE(2) + proof(*) — bulletproof bytes (omitted for PRED_EQ)
```

Total sizes:

- `PRED_GE` / `PRED_LE`: 1 + 8 + 2 + ~672 = ~683 B
- `PRED_IN_RANGE`: 1 + 16 + 2 + ~736 = ~755 B (aggregated 2-element BP)
- `PRED_GT_HIDDEN`: 1 + 33 + 2 + ~672 = ~708 B
- `PRED_EQ`: 1 + 8 + 32 = 41 B (no bulletproof, fixed size)

---

## Aggregate-over-UTXOs

To prove a predicate over the **sum** of N hidden amounts (e.g., "total
of all my UTXOs of asset_A is ≥ K"):

```
sum_value    = Σ a_i
sum_blinding = Σ r_i  (mod n_secp)
sum_C        = Σ C_i  (computed publicly by verifier)
```

The prover calls `proveRange({ value: sum_value, blinding: sum_blinding },
predicate)` on the aggregated pair; the verifier reconstructs `sum_C`
from public commitments and calls `verifyRange(sum_C, attestation)`.
Works because Pedersen commitments are additively homomorphic:
`Σ (a_i·H + r_i·G) = (Σ a_i)·H + (Σ r_i)·G`. A single bulletproof
suffices regardless of N.

---

## Reference implementation

`tests/range-proof.mjs` provides:

- `proveRange({ value, blinding, otherValue?, otherBlinding? }, predicate)`
  → attestation bytes
- `verifyRange(commitmentA, attestationBytes, { commitmentB? })`
  → `{ ok, predicate?, reason? }`
- `aggregateCommitments(pairs)` → `{ value, blinding }` (sum helper)
- `sumCommitmentBytes(commitmentBytesList)` → 33-byte sum-commitment

The verifier returns the predicate parameters extracted from the
attestation bytes so callers can compare against their expected values
(prevents accidental reuse of an attestation under a different bound).

Test coverage at `tests/range-proof.test.mjs` (39 tests): every predicate
× honest path, boundary values, tampered bytes, wrong commitments, missing
context, multi-UTXO aggregation, u64-boundary overflows, truncated bytes,
unknown predicate tags.

---

## Integration guidance (for consumer surfaces)

A surface that wants to consume range proofs:

1. Defines the predicate(s) it requires (e.g., cUSD CDP: collateral_C ≥
   debt × ratio·H).
2. Embeds the attestation bytes in its envelope's wire format (e.g., a
   variable-length field).
3. At validation time, extracts the commitment(s) to attest from envelope
   context (typically existing UTXO commitments), calls `verifyRange`,
   matches `result.predicate` to its expected parameters, and rejects on
   mismatch.

Integration adds no new circuit, no new ceremony, no new domain tag —
just calls into the existing primitive.

---

## Backwards-compatibility statement

This amendment is **purely additive at the protocol layer**. It defines
a cryptographic primitive composable from tacit's existing bulletproof
infrastructure. No new opcode, no new domain tag, no new wire-format
byte at the protocol layer, no new cryptographic assumption. Existing
UTXOs, opcodes, and ceremonies are unaffected; pre-amendment indexers
see no change in their dispatch. Consumer surfaces that embed range-proof
attestations are themselves new features documented in their own
amendment files.

A future `T_RANGE_ATTEST` opcode for standalone on-chain publication of
range attestations (with `scope_id` discriminator, expiry, holder
signature) is a separate amendment, not part of this primitive.
