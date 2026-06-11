# Audit prompt — Bulletproofs+ range proof (JS implementation)

You are a cryptography-focused code auditor. Your job is to review Tacit's
Bulletproofs+ (BP+) aggregated range-proof implementation and the logic that
consumes it, and to determine whether it is **sound, complete, and safe to run
in production**. This is the only known JavaScript implementation of BP+; it was
hand-ported from Monero's C++. There is no second JS implementation to diff
against, so the review must reason from the math and the reference, not from a
sibling port. Treat every assumption as guilty until proven correct.

A bug here is fund-critical: the verifier gates whether confidential amounts are
in range. A soundness break lets a prover commit to an out-of-range / negative
value and mint or move value out of thin air. A completeness break locks honest
users out. Either is a launch blocker.

---

## What the code is

A hand-port of Monero's `src/ringct/bulletproofs_plus.{cc,h}` with three
deliberate substitutions. The file header (`dapp/bulletproofs-plus.js`, top of
file) documents them — read it first. Summary:

1. **Curve: ed25519 → secp256k1.** Cofactor 8 → cofactor 1. Every Monero
   `INV_EIGHT` / `MINUS_INV_EIGHT` multiply and every `scalarmult8` in the
   verifier is *omitted* in this port. The header flags this as "the single most
   dangerous porting trap." Verify each omission is correct and complete — a
   missed `8^-1` (or a spurious one) silently corrupts a commitment.
2. **Hash: Keccak (`cn_fast_hash`) → SHA-256.** Internal-only; prover and
   verifier must agree everywhere. Proofs are intentionally NOT Monero-compatible.
3. **Generators:** try-and-increment NUMS under tacit domain tags
   (`tacit-bp-G-v1`, `tacit-bp-H-v1`, `tacit-generator-H-v1`), per
   `spec/amendments/SPEC-CXFER-BPP-AMENDMENT.md §5.47.4` and `spec/SPEC...§3.1`.
   No `Q` generator (matches Monero BP+).

Reference C++ is cached at `.local/monero-bpp-ref/`. The paper is Chung, Han,
Lai, Maller, Mohnblatt, Sarkar, Sharma, *Bulletproofs+* (eprint 2020/735).

---

## Scope — files to review

**Primary (the proof system itself):**
- `dapp/bulletproofs-plus.js` — prover + verifier + curve/scalar/point helpers,
  generators, transcript. This is the core. Read every line.
  - Prover: `bppRangeProve` (~L463), `_bppRangeProveAttempt` (~L516–750)
  - Verifier: `bppRangeVerify` (~L790–1015)
  - Scalar: `modN`, `modInv`, `batchInv`, `randomScalar` (~L80–120)
  - Point/MSM: `safeMult`, `msm` (Pippenger, ~L182–249), `hadamardFold`
  - Vectors: `weightedInnerProduct` (~L305), `vecPow`, `vecHadamard`
  - Generators: `_hashToCurveSecp` (~L336), `bppGens` (~L352), `pedersenCommit`
  - Transcript: `bppTranscript` (~L387–422)
  - Sums: `_sumOfScalarPowers` (~L755), `_sumOfEvenPowers` (~L776)

**Reference implementation to cross-check against (must match byte-for-byte at
the protocol level):**
- `contracts/sp1/confidential/cxfer-core/src/lib.rs` — Rust/k256 port.
  `verify_range` (~L344–502), `bpp_gens`, `sum_of_scalar_powers`,
  `sum_of_even_powers`, `decompress`/`compress`, `scalar_reduce_be`,
  `scalar_canonical_be`. This runs inside the SP1 zkVM guest and is the
  consensus verifier. **The JS verifier and this Rust verifier must accept
  exactly the same set of proofs.** Any divergence is a finding (a proof that JS
  accepts but the guest rejects = stuck funds; the reverse = a JS-side bypass).

**Consumers / integration (where a verifier mistake becomes a money bug):**
- `dapp/confidential-pool.js` — `cxferKernelVerify`, `verifyCxferConservation`
  (~L524–549), `bppRangeVerify` call (~L548)
- `dapp/confidential-transfer.js` — `bppRangeProve` (~L64), `verifyTransfer` /
  `bppRangeVerify` (~L82)
- `dapp/tacit.js` — `bppRangeVerify` call sites (~L17952, 18027, 18119),
  `bppEnabled()` mainnet gate, prover selection (~L30534)
- Other callers: `dapp/confidential-swap.js`, `dapp/confidential-memo.js`,
  `dapp/amm-kernel.js` (grep `bppRangeVerify`, `bppRangeProve`)

**Spec (the intended protocol — flag any code/spec divergence):**
- `spec/amendments/SPEC-CXFER-BPP-AMENDMENT.md`,
  `spec/amendments/SPEC-AXFER-BPP-AMENDMENT.md`,
  `spec/SPEC-CONFIDENTIAL-POOL.md`

**Existing tests (read to learn what's already covered — and what isn't):**
- `tests/bulletproofs-plus-*.test.mjs` (smoke/KAT, roundtrip, adversarial,
  pinned-fixtures, monero-scenarios, python-parity, symbolic-identity,
  witness-extractor, malicious-prover, bounded-exhaustive, property-fuzz)
- `tests/cxfer-bpp-wire.test.mjs`, `tests/cxfer-bpp-integration.test.mjs`,
  `tests/axfer-bpp-wire.test.mjs`

---

## What "production safe" means here — the properties to prove

Verify each. For each property either argue why it holds (citing exact lines) or
produce a concrete counterexample.

1. **Soundness (the one that matters most).** A prover cannot produce a proof
   that `bppRangeVerify` accepts for a commitment whose opening is outside
   `[0, 2^64)` — including negative values (i.e. `value mod n` that exceeds
   2^64), and including the aggregated case (m ∈ {1,2,4,8}). The whole point is
   "no value forged out of range." Try to break it.
2. **Completeness.** Every honestly-generated proof (`bppRangeProve`) verifies,
   for all supported aggregation counts and all values in range, including edge
   values 0 and 2^64−1, and across the prover's retry/rejection-sampling paths.
3. **Binding / no false aggregation.** The proof binds to the exact set and
   order of commitments `V` passed to the verifier. A proof valid for one
   commitment set must not verify against a different set, a reordering, or a
   different m. (Adversarial test claims to cover commitment-swap and
   aggregation-mismatch — confirm the coverage is real and the checks live in
   the verifier, not just the test.)
4. **Fiat–Shamir / transcript integrity.** Every value that the soundness of the
   proof depends on is absorbed into the transcript *before* the challenge that
   depends on it is drawn. Specifically check: domain tag, m, all of `V`, `A`,
   then `y`; `z` after the right inputs; each WIPA-round `u[k]` after that
   round's `L_k`/`R_k`; final `e` after `A1`,`B`. A challenge drawn over
   too-little transcript = forgeable. Confirm the prover and verifier absorb the
   *identical* byte sequence in the *identical* order (the classic break is the
   verifier hashing something the prover didn't, or vice-versa).
5. **Challenge/scalar hygiene.** Challenges and the zero-challenge rehash
   (`bppTranscript().challenge`) reduce correctly mod n and reject 0 (and any
   other degenerate value the math can't tolerate, e.g. where an inverse is
   taken). `modInv` never silently returns garbage for 0. `batchInv` handles a 0
   element. Scalar parse is canonical (`scalar_canonical_be` in Rust — does JS
   match? a non-canonical or `>= n` scalar acceptance is a malleability vector).
6. **Point hygiene / deserialization.** `bytesToPoint` rejects non-curve points,
   the point at infinity where it must, and non-canonical encodings. The
   identity element appearing where a real generator is expected must not pass.
   Confirm `safeMult` zero-handling can't be abused to drop a term from the MSM.
7. **MSM correctness.** The Pippenger `msm` computes Σ sᵢ·Pᵢ correctly for the
   windowing/bucket logic, including empty buckets, scalar 0, scalar 1, and the
   largest scalars. A wrong MSM that happens to pass the honest roundtrip but is
   exploitable is the nightmare case — sanity-check it against naive
   double-and-add on random inputs.
8. **The INV_EIGHT omission audit.** Walk the Monero reference
   (`.local/monero-bpp-ref/`) line by line for every `INV_EIGHT`,
   `MINUS_INV_EIGHT`, `scalarmult8`, and `8·` and confirm the JS port's
   corresponding line correctly drops it (cofactor-1) — and that no place needs
   it that the port also dropped. This is the single highest-risk class.
9. **Final verification equation.** The verifier's terminal check (Σ scalarᵢ·
   pointᵢ == identity / `ZERO`) uses the correct coefficients — confirm
   `_sumOfScalarPowers` / `_sumOfEvenPowers`, the `y`/`z` powers, the `e`/`e²`
   placements, and the generator-vector folding coefficients match the paper and
   the Rust verifier exactly.
10. **Wire format.** Proof encode/decode (`A‖A1‖B‖r1‖s1‖d1‖L_vec‖R_vec`, lengths
    591/657/723/789 for m=1/2/4/8) rejects truncated, over-long, and trailing-
    garbage inputs; logMN is derived from length safely (no
    attacker-controlled loop count / DoS); a malformed length can't be coerced
    into a valid-looking parse.
11. **Randomness.** Prover blinding/`randomScalar` uses a CSPRNG with adequate
    entropy and no reuse of nonces across proofs/rounds that would leak the
    blinding (a repeated mask = opening leak).
12. **Consumer-side gluing.** In `verifyCxferConservation` /
    `cxferKernelVerify` and every `bppRangeVerify` call site: the commitments
    handed to the verifier are exactly the ones bound by the rest of the
    transaction (no substitution between "the commitment we range-proved" and
    "the commitment we settle"); a verify failure fails closed (rejects), never
    falls through to accept; the result is actually checked (not a dangling
    promise / ignored boolean). Confirm the secp point decoding used at call
    sites (`bytesToPoint`) matches the prover's encoding.
13. **JS ↔ Rust parity.** Diff the two verifiers for any behavioral gap:
    challenge byte layout, scalar reduction (`scalar_reduce_be` vs JS), canonical
    checks, generator derivation, rejection conditions. Enumerate every input a
    differential test could be built on. A proof accepted by one and rejected by
    the other is a finding regardless of which is "more correct."

---

## How to work

- **Read the math against the paper and the Monero reference.** Don't trust
  comments; trust the code and 2020/735. Where the port comment claims an
  omission/substitution is safe, independently verify it.
- **Run the existing suite** and read what it actually asserts:
  `node --test tests/bulletproofs-plus-*.test.mjs tests/cxfer-bpp-*.test.mjs`
  (and the `.mjs` confidential tests). Note coverage gaps — e.g. is there a
  *differential* test JS-vs-Rust on random proofs? Is out-of-range rejection
  tested for negative (high) values and at the 2^64 boundary, not just a token
  out-of-range value? Is the transcript tested for under-absorption?
- **For any suspected break, write a minimal proof-of-concept** (a standalone
  `.mjs` that constructs the malicious proof/commitment and shows
  `bppRangeVerify` returning `true`, or an honest proof returning `false`).
  An unexploitable theoretical concern and a working PoC are different severities
  — label which you have.
- **Cross-check, don't assume.** When you cite a line, open it. When you claim
  parity, show the two snippets side by side.

---

## Deliverable

Write a report (`ops/reviews/AUDIT-bulletproofs-plus-<date>.md`) with:

1. **Verdict:** one of `SOUND / production-safe`, `SOUND with required fixes`,
   `NOT production-safe`. One paragraph of justification.
2. **Findings table:** ID, title, severity, file:line, status. Severity rubric:
   - **CRITICAL** — soundness break: a verifier accepts an out-of-range/forged
     proof, or a JS-accepts / guest-rejects divergence that locks or mints funds.
     Must have a PoC or a tight argument.
   - **HIGH** — completeness break (honest proofs rejected), malleability,
     transcript under-absorption with a plausible (even if unproven) forgery,
     consumer-side fail-open.
   - **MEDIUM** — defense-in-depth gap, missing canonical/point check with no
     demonstrated exploit, DoS via malformed input, coverage gap in tests for a
     soundness-relevant property.
   - **LOW / INFO** — hygiene, clarity, spec/code drift with no security impact.
3. **Per finding:** what's wrong, why it's exploitable (or why not), the PoC or
   the precise reasoning, and a concrete fix.
4. **Property checklist results:** for each of the 13 properties above, PASS /
   FAIL / NEEDS-WORK with the evidence (lines) behind the call.
5. **Coverage gaps:** what the existing tests do NOT exercise that they should,
   especially the differential JS↔Rust test and boundary/out-of-range cases.

## Constraints

- **Do not modify production files.** Read-only review. You may create
  standalone PoC scripts and your report. Propose fixes as diffs in the report;
  do not apply them.
- Keep the writeup technical and neutral. Report what you can demonstrate;
  distinguish proven exploits from theoretical concerns; don't dramatize and
  don't pad. If something is correct, say so plainly with the reason.
- If you cannot reach a confident verdict on a property within scope, say so and
  state exactly what additional artifact (a differential harness, a Monero KAT,
  a guest re-run) would settle it.
