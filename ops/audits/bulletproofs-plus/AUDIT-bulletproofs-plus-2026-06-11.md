# Audit — Bulletproofs+ range proof (JS + Rust guest)

**Date:** 2026-06-11
**Scope:** `dapp/bulletproofs-plus.js` (prover + verifier), `contracts/sp1/confidential/cxfer-core/src/lib.rs::verify_range` (consensus verifier), all consumer call sites, the CXFER/AXFER BPP spec amendments, and the existing test suite. Cross-checked against the Monero reference (`.local/monero-bpp-ref/bulletproofs_plus.cc`) and the BP+ paper (eprint 2020/735).
**Method:** line-by-line port comparison against Monero; executable cross-impl differential (`cargo test` in cxfer-core); a standalone PoC harness (`ops/audits/bulletproofs-plus/poc-bpp-audit.mjs`) exercising the gaps the suite does not.

---

## 1. Verdict

**SOUND / production-safe.**

The JS verifier (`bppRangeVerify`) and the Rust consensus verifier (`verify_range`) are faithful, term-for-term ports of Monero's BP+ verifier — itself the proven-sound construction from Chung et al. 2020 §6.1. Both substitutions are legitimate: cofactor 8→1 drops every `INV_EIGHT`/`scalarmult8` in matched prover/verifier pairs (all six element classes — A, A1, B, V, L, R — verified paired), and the `weight=1` simplification is sound because a nonzero scalar multiple of an "MSM == identity" check is the same check (the verifier checks exactly one aggregated proof per call; it never batches multiple proofs, so the random batching weight is unnecessary). The prover matches Monero term-for-term as well, so completeness holds by construction.

I could not produce a forgery, and every adversarial probe failed closed. Out-of-range values (including the 2⁶⁴ boundary and "negative" values `≡ n−k`), commitment reordering/substitution, aggregation-count mismatch, crafted zero/non-canonical scalars, and off-curve points in proof fields are all rejected — empirically, by both verifiers. The executable JS↔Rust differential passes (a JS-produced proof verifies under the Rust guest; a JS-forged out-of-range proof is rejected by the Rust guest). Every one of the 13 consumer call sites is fail-closed and binds the range-proved commitment to the same bytes the rest of the transaction settles on. The mainnet feature gate (`bppEnabled()`) defaults off and fails closed for `T_CXFER_BPP`; note that it does **not** cover the two AXFER_BPP opcodes (BPP-9), which is value-safe but worth deciding intentionally.

The findings below are **test-coverage debt and cosmetic hygiene, not code defects** — the code paths they name were verified correct by direct proof (Monero match), by the Rust differential, and by the PoC harness. The five actionable items have since been **landed and verified this session** (see *Resolutions landed* below); none blocked the soundness/completeness verdict.

Residual trust assumptions (inherent to the construction, not defects): the random-oracle model for Fiat–Shamir (SHA-256), the secp256k1 discrete-log assumption, and the correctness of the underlying `@noble/secp256k1` (JS) and `k256` (Rust) point arithmetic.

---

## 2. Findings

| ID | Title | Severity | Location | Status |
|----|-------|----------|----------|--------|
| BPP-1 | No naïve-MSM cross-check test for the Pippenger `msm` | MEDIUM (coverage) | `dapp/bulletproofs-plus.js:182` | **RESOLVED** — `tests/bulletproofs-plus-msm.test.mjs` (5/5) |
| BPP-2 | No crafted-body malformation tests (zero/≥n scalars, off-curve points in named fields) | MEDIUM (coverage) | `dapp/bulletproofs-plus.js:808-824` | **RESOLVED** — `tests/bulletproofs-plus-malformed-body.test.mjs` (17/17) |
| BPP-3 | JS↔Rust differential is fixture-pinned, not regenerated/fuzzed | MEDIUM (coverage) | `cxfer-core/src/lib.rs:1890,1936` | **RESOLVED** — `scripts/bpp-differential-check.mjs` (regen-then-diff) |
| BPP-4 | Dead code in the verifier | LOW | `dapp/bulletproofs-plus.js:906,911` | **RESOLVED** — dead code removed |
| BPP-5 | Two test files weaker than their names imply | INFO | `tests/bulletproofs-plus-{python-parity,symbolic-identity,witness-extractor}.test.mjs` | Framing only |
| BPP-6 | Challenge rehash-on-zero: JS throws on double-zero, Rust returns | INFO | `bulletproofs-plus.js:417` / `lib.rs:268` | ~2⁻⁵¹² event; benign |
| BPP-7 | Verifier trusts caller-supplied commitment points are on-curve | INFO | `dapp/bulletproofs-plus.js:790` | Safe — all callers decode via `bytesToPoint`/`decompress` |
| BPP-8 | Generator derivation could theoretically diverge if a SHA-256 candidate x ≥ p | INFO | `bulletproofs-plus.js:336` / `lib.rs:278` | ~2⁻²¹³; mooted by pinned KAT + differential |
| BPP-9 | `bppEnabled()` mainnet gate covers `T_CXFER_BPP` but not `T_AXFER_BPP` / `T_AXFER_VAR_BPP` (those verify inline on any network) | LOW / INFO | `tacit.js:17924` vs `:18002, :18080` | **RESOLVED** — gated (mirrors CXFER soft-fork) |
| BPP-10 | Proofs are non-deterministic (fresh randomness per proof) — proof bytes must never be used as a uniqueness key / nullifier | INFO | `bulletproofs-plus.js:524,605-606,660-663` | Safe — consumers key on commitments/nullifiers, not proof bytes |
| BPP-11 | Rust `compress(identity)` copies a 1-byte encoding into `[u8;33]` → panic (JS returns clean `false`) | LOW (latent; unreachable in guest) | `cxfer-core/src/lib.rs:39-44`, reached from `:381` | Refines BPP-7 on the Rust side |

No CRITICAL or HIGH findings. No soundness break, no completeness break, no consumer-side fail-open, no JS-accepts/guest-rejects divergence found.

### Resolutions landed (this session)

All five actionable items implemented and verified (changeset: `dapp/bulletproofs-plus.js`, `dapp/tacit.js`, + three new files):

- **BPP-1** — `tests/bulletproofs-plus-msm.test.mjs` (5/5): Pippenger `msm` cross-checked against naïve Σ across sizes 1…1057 (incl. the m=1/m=8 verifier sizes) and edge scalars (0, 1, n−1, bit-255), with repeated/identity points + degenerate inputs.
- **BPP-2** — `tests/bulletproofs-plus-malformed-body.test.mjs` (17/17): crafted zero `r1/s1/d1` (MSM rejects — confirms the algebraic backstop), `≥ n` scalars, off-curve / bad-prefix points in A/A1/B/L, identity-commitment slot, reorder, wrong count.
- **BPP-3** — `scripts/bpp-differential-check.mjs`: regenerates the JS fixtures from current `dapp/bulletproofs-plus.js`, runs the Rust differential (`2 passed; 0 failed`, "no drift"), then restores the fixtures so the tree stays clean. CI-ready; each run also fuzzes (fresh proof randomness per invocation).
- **BPP-4** — dead code (`sum_d`, `z_minus_zSq`) removed from the verifier; `bppRangeVerify` still verifies (malformed-body baseline + differential confirm post-edit).
- **BPP-9** — `bppEnabled()` soft-fork gate added to the `T_AXFER_BPP` and `T_AXFER_VAR_BPP` validators, mirroring `T_CXFER_BPP`, so the BP+ rollout is uniform across opcodes. No-op on signet (BP+ enabled), so `axfer-bpp-wire` stays 85/0; on mainnet-default it now treats AXFER_BPP UTXOs as non-tacit until activation, exactly like CXFER_BPP.

BPP-5/6/7/8/10/11 are INFO/LOW with no code change required (test framing, ~2⁻⁵¹²/2⁻²¹³ edges, defense-in-depth, and the unreachable Rust `compress(identity)` footgun).

---

## 3. Findings detail

### BPP-1 — No naïve-MSM cross-check (MEDIUM, coverage)

`msm()` (`bulletproofs-plus.js:182`) is a windowed Pippenger multi-exp used in both the prover (`A`, `L`, `R`) and the verifier's terminal identity check (`bulletproofs-plus.js:1013`). A Pippenger bucketing bug that produced a wrong point could, in principle, pass the honest round-trip (the *same* buggy `msm` runs in prove and verify, so a matching bug can mask) while corrupting the verification relation — the "wrong-MSM that's exploitable" case the audit prompt flags. The suite never checks `msm` against an independent oracle (`symbolic-identity` checks the *scalars* fed to the MSM, not the summation).

**Assessment — code is correct.** I cross-checked `msm` against a naïve `Σ safeMult(Pᵢ, sᵢ)` over every window-size regime (sizes 1…1057, covering the m=1 verifier size 146 and the m=8 size 1057) and every edge scalar (0, 1, n−1, an explicit bit-255-set scalar, random), with repeated points (bucket stress) and identity points mixed in. All trials produced byte-identical points; degenerate inputs (empty, all-zero scalars) returned `ZERO`. See `ops/audits/bulletproofs-plus/poc-bpp-audit.mjs` section (G) — 35/35 pass.

The Horner accumulation (double `c` times between windows), the index-weighted running-sum (`windowTotal = Σ_v v·buckets[v]`), full 256-bit window coverage (`ceil(256/c)·c ≥ 256` for every `c ∈ {3,4,5,6}`, so bit 255 — set in `n` and in max scalars — is always covered), and the zero-scalar/zero-point skips are all individually correct.

**Fix (add a regression test):**
```js
// tests/bulletproofs-plus-msm.test.mjs (new)
import * as bpp from '../dapp/bulletproofs-plus.js';
const { G, ZERO, SECP_N, modN, safeMult, msm, randomScalar } = bpp;
const naive = (s, p) => p.reduce((a, P, i) => modN(s[i]) === 0n || P.equals(ZERO) ? a : a.add(P.multiply(modN(s[i]))), ZERO);
for (const n of [5, 32, 128, 146, 512, 1057]) {
  const p = Array.from({length:n}, () => G.multiply(randomScalar()));
  const s = Array.from({length:n}, (_,i) => i%7===0 ? 0n : i%11===0 ? SECP_N-1n : randomScalar());
  console.assert(msm(s,p).equals(naive(s,p)), `msm!=naive n=${n}`);
}
```

### BPP-2 — No crafted-body malformation tests (MEDIUM, coverage)

The suite exercises off-curve points and ≥n scalars only *incidentally*, via random bit-flips. There is no test that deliberately constructs a proof with (a) a canonical-but-zero `r1`/`s1`/`d1`, (b) a scalar ≥ n in a scalar field, or (c) an off-curve / bad-prefix point in a *named* field (A/A1/B/L/R), and asserts rejection. The test agent specifically flagged that the verifier has no explicit nonzero check on `r1`/`s1`.

**Assessment — code is correct.** The verifier rejects `r1`/`s1`/`d1` ≥ n explicitly (`bulletproofs-plus.js:816`; Rust `scalar_canonical_be` at `lib.rs:363-367`), and rejects zero `r1`/`s1`/`d1` implicitly — they fail the MSM identity. Off-curve / bad-prefix points fail `bytesToPoint` (`try/catch → return false`, `:808-823`) or, if they happen to decode, change the Fiat–Shamir transcript and fail the MSM. The 33-byte SEC1 form cannot encode the point at infinity, so identity cannot be injected into A/A1/B/L/R. All of this is demonstrated in `poc-bpp-audit.mjs` section (i/j): r1=0, s1=0, d1=0, r1/s1/d1=n, r1=2²⁵⁶−1, off-curve A/A1/B/L[0], and the 0x00…00 prefix are each rejected. The "no explicit nonzero check on r1/s1" is therefore not exploitable — the algebraic check is the backstop, identical in JS and Rust.

**Fix:** fold the section-(i/j) cases from `poc-bpp-audit.mjs` into `tests/bulletproofs-plus-adversarial.test.mjs`.

### BPP-3 — Differential is fixture-pinned, not regenerated/fuzzed (MEDIUM, coverage)

The JS↔Rust agreement — the property whose failure means "JS accepts, guest rejects → stuck funds" or the reverse — is asserted in `cargo test`, not the JS suite, and on a handful of static fixtures:
- `range_accepts_js_proof_and_rejects_tamper` (`lib.rs:1890`): a JS-produced proof verifies under `verify_range`; tamper + wrong-commitment reject.
- `range_rejects_out_of_range_commitment` (`lib.rs:1936`): the Rust verifier accepts honest 2⁶⁴−1 and rejects the JS-forged 2⁶⁴ (`fixtures/bpp_out_of_range.json`).

These **pass** (confirmed: `cargo test --release` → 54 passed, 0 failed). The coupling that catches drift is indirect: the JS `pinned-fixtures` test asserts JS output == pinned hex, and the Rust test asserts Rust accepts the same pinned hex, so a JS change breaks the JS pinned test and forces regeneration. But there is no single harness that generates a *random* proof in JS and asserts `bppRangeVerify == verify_range` on it, so a divergence that only manifests on inputs outside the pinned set (e.g. a specific m, or a challenge pattern) would not be caught until a fixture happened to hit it.

**Fix:** add a CI step that (1) regenerates the JS fixtures from current `dapp/bulletproofs-plus.js`, then (2) runs the Rust differential, failing if either the JS pinned hex or the Rust accept/reject changes. Optionally, a small fuzz differential: generate N random proofs (incl. each m and out-of-range cases) in JS, feed both verifiers, assert identical verdicts.

### BPP-4 — Dead code in the verifier (LOW)

```js
// bulletproofs-plus.js:906
const sum_d = modN((1n << BigInt(N)) - 1n) * 1n;  // unused; real value is sum_d_val (:907)
// bulletproofs-plus.js:911
const z_minus_zSq = modN(z - zSq);                // unused; H_inner1 uses zSq_minus_z (:912)
```
Both are computed and never read. Harmless, but they invite confusion in a file where every scalar matters. Remove:
```diff
- const sum_d = modN((1n << BigInt(N)) - 1n) * 1n;  // 2^N - 1 (will multiply below)
  const sum_d_val = modN(modN((1n << BigInt(N)) - 1n) * _sumOfEvenPowers(z, 2 * m));
@@
- const z_minus_zSq = modN(z - zSq);   // -(z²-z) so flip sign
  const zSq_minus_z = modN(zSq - z);
```

### BPP-5 — Tests weaker than their names imply (INFO)

- `python-parity.test.mjs` compares JS output to **hardcoded `py_proof_hex`** captured 2026-05-18; it does **not** shell out to the Python port (`.local/bpp-python-port/bpp.py`). It's a pinned-regression test, not a live two-implementation diff. If someone edited the pasted hex, nothing catches it.
- `symbolic-identity.test.mjs` validates the paper formulas against a **mirror re-implementation** of the verifier's scalar derivation, not the production `bppRangeVerify` code path — it can drift from the real verifier and still pass.
- `witness-extractor.test.mjs`'s "MSM evaluates to identity" assertions call `bppRangeVerify(...) === true` — a relabeling of round-trip, not an independent algebraic check; and its `r1,s1,d1 ∈ [1,n)` checks are on *honest* output, not enforced verifier rejections.

None of these is a defect; the framing just overstates the guarantee. Recommend a one-line header note on each, and (highest value) make `symbolic-identity` assert against the real verifier's intermediate scalars rather than a mirror.

### BPP-6 — Challenge rehash-on-zero divergence (INFO)

On a zero challenge, JS rehashes with a `0x01` tag and throws if *still* zero (`bulletproofs-plus.js:415-417`); Rust rehashes and returns the (possibly-zero) result (`lib.rs:268-271`). This is a ~2⁻⁵¹² event (two consecutive SHA-256 outputs ≡ 0 mod n) and cannot be reached by any practical input. Both append the *original* hash to the transcript before the check, so the chaining is identical and challenges match. No action required; noted for completeness of the parity claim.

### BPP-7 — Verifier trusts caller-supplied commitment points (INFO)

`bppRangeVerify(commitments, proofBytes)` takes `commitments` as already-decoded `Point` objects and does not itself re-validate they are on-curve. This is safe in practice: every call site decodes commitments from compressed bytes via `bytesToPoint` (JS) / `decompress` (Rust) inside `try/catch → reject` (confirmed across all 13 sites). A bogus point would also throw in `pointToBytes`/the MSM. Defense-in-depth only: an internal guard, or a doc contract that callers must pass validated points, would make the API misuse-resistant.

### BPP-8 — Generator-derivation parity edge (INFO)

JS (`_hashToCurveSecp`) and Rust (`hash_to_curve`) derive `G_vec`/`H_vec`/`H` by the same try-and-increment over `SHA-256(domain ‖ idx_LE ‖ counter)` with a `0x02` prefix. If a candidate x-coordinate were ≥ the field prime p, `@noble` and `k256` would each have to agree on rejecting it; the probability any of the ~1500 candidates is ≥ p is ≈ 2⁻²¹³, and the resulting generators are pinned by KAT (`prover-smoke`/`pinned-fixtures`) and validated end-to-end by the Rust differential (a JS proof only verifies under Rust if the generators match). No action required.

### BPP-9 — `bppEnabled()` does not gate the AXFER_BPP opcodes (LOW / INFO)

The mainnet kill-switch `bppEnabled()` (`tacit.js:6534`, default-off on mainnet / on for signet) is consulted by the `T_CXFER_BPP` validator (`tacit.js:17924` — a BPP envelope while disabled returns `false`, so the UTXO is treated as non-tacit; the correct fail-closed soft-fork behavior), but **not** by the `T_AXFER_BPP` (`:18002`) or `T_AXFER_VAR_BPP` (`:18080`) validators, which decode and verify the BP+ proof inline regardless of network (confirmed: `grep bppEnabled tacit.js` shows the gate at `:17924` and nowhere in the `:18000`-block validators). This is **value-safe** — those two paths still verify the range proof fail-closed — so it is not a soundness/fund issue. The consequence is narrower: the "hold BP+ off mainnet until activation" intent only actually holds for CXFER_BPP; the two AXFER_BPP variants are effectively always active. Decide whether that asymmetry is intended (atomic-OTC settlement may want it live), and if not, extend the gate to the two AXFER variants for consistency.

### BPP-10 — Proofs are non-deterministic; proof bytes are not an identity (INFO)

`bppRangeProve` draws fresh randomness every call (`alpha` `:524`, `dL`/`dR` per round `:605-606`, `r`/`s`/`d_`/`eta` `:660-663`), so the **same** `(value, blinding)` produces a **different** proof byte-string each time, and both verify against the same commitment (PoC malleability probe: "both proofs verify vs that commitment, proof bytes differ"). This is expected for BP+ and is **not** a soundness concern — the commitment binds the value; the proof only attests range. The one thing it forbids: never use the proof bytes as a uniqueness key, dedup key, or nullifier. The call-site trace confirms consumers key on commitments / kernel nullifiers, not proof bytes, so this is safe today — noted so a future change doesn't treat a proof as an identity.

### BPP-11 — Rust `compress(identity)` panic vs JS clean `false` (LOW, latent)

A Rust-side refinement of BPP-7. `compress` (`cxfer-core/src/lib.rs:39-44`) does `out.copy_from_slice(enc.as_bytes())` into a `[u8;33]`; for the identity point k256's compressed encoding is a single `0x00` byte, so `copy_from_slice` panics on the length mismatch (reached from the transcript loop at `:381`). The JS side encodes `ZERO` as 33-byte `02‖00…00` and `bppRangeVerify([ZERO], proof)` returns `false` cleanly (PoC check 11). **Unreachable on the consensus path:** every commitment entering `verify_range` is built by `r_commitment()` → `from_affine_xy(cx,cy).expect(...)` (`src/main.rs:86-90`), and the identity has no `04‖x‖y` affine encoding, so a would-be identity commitment panics earlier, at construction. Proof points A/A1/B/L/R are decompressed from 33-byte inputs and a valid decode is never the identity. It remains a latent footgun for any future caller that hands `verify_range` a raw point set; make `compress` total (guard the identity / reject up front) to match the JS `false`. Non-blocking.

---

## 4. Property checklist (the 13 required properties)

| # | Property | Result | Evidence |
|---|----------|--------|----------|
| 1 | **Soundness** — no accept for out-of-range / negative / aggregated | **PASS** | Verifier eqn matches Monero term-for-term (§5). PoC rejects 2⁶⁴, 2⁶⁴+1, 2⁶⁴+7, n−1, n−2⁶³, 2⁶⁵, 2²⁰⁰, and m=2 with one bad slot. Rust differential rejects JS-forged 2⁶⁴ (`lib.rs:1945`). `malicious-prover` Attack 2 (verifier-side, via `_allowOutOfRangeForTest`). |
| 2 | **Completeness** — honest proofs verify, all m, edge values | **PASS** | `roundtrip` (m∈{1,2,4,8}, 0, 2⁶⁴−1, mixed), `bounded-exhaustive` (~520 values + boundary pairs/quads), PoC section (2). |
| 3 | **Binding / no false aggregation** | **PASS** | `m` bound in transcript (`:829`); proof length pins `logMN`; each `V` absorbed in order. PoC rejects reorder, wrong-count, identity-slot. `adversarial`/`malicious-prover` commitment-swap + agg-mismatch hit `bppRangeVerify` directly. |
| 4 | **Fiat–Shamir / transcript integrity** | **PASS** | Prover (`:517-682`) and verifier (`:827-851`) absorb the identical byte sequence in identical order: domain, M, all V, A → y,z; per round L_k,R_k → u_k; A1,B → e. Rust `Transcript` (`lib.rs:255-273`) is byte-identical (u32-LE length prefix, hash-append-back). |
| 5 | **Challenge / scalar hygiene** | **PASS** | `modInv(0)` throws (`:85`); `batchInv` only ever sees nonzero challenges (all checked `≠0` before inversion, `:836/844`); challenge rehashes off 0; `r1/s1/d1 ≥ n` rejected (`:816`). JS `modN(bytes32ToBigint)` == Rust `scalar_reduce_be`; JS `≥ n` reject == Rust `scalar_canonical_be`. |
| 6 | **Point hygiene / deserialization** | **PASS** | `bytesToPoint`→noble `fromHex` rejects off-curve / non-canonical x / 33-byte infinity; Rust `decompress` likewise. `safeMult`/`msm` zero-skip cannot drop a security-relevant term (every attacker-needed scalar — A,A1,B,V — is nonzero unless e/y/z=0, all rejected). PoC (i/j). |
| 7 | **MSM correctness** | **PASS** | `msm` == naïve over sizes 1…1057, all edge scalars, repeated/identity points (PoC section G, 35/35). Horner + running-sum + full bit coverage verified by inspection. |
| 8 | **INV_EIGHT omission** | **PASS** | Full Monero catalog: 17 prover `8⁻¹` sites + 6 verifier `×8` sites, grouped into the six element pairs (A, A1, B, V, L, R) — every pair dropped together in the port; no unpaired cofactor op, none in the helper math. A broken pair would fail round-trip and the Rust differential; both pass. |
| 9 | **Final verification equation** | **PASS** | Term-for-term vs Monero `bulletproof_plus_VERIFY` (weight=1): G=`d1`; H=`r1·y·s1 + e²·((z²−z)·Σy + y^{MN+1}·z·Σd)`; V[j]=`−e²·y^{MN+1}·z^{2(j+1)}` (Monero's `z^{2j+1}` comment is a typo — its code computes `z^{2(j+1)}`); A=`−e²`, A1=`−e`, B=`−1`; L/R=`−e²u^{±2}`; Gᵢ/Hᵢ with `y^{−i}` iteration + `(~i)&(MN−1)` reverse index. `_sumOfEvenPowers`/`_sumOfScalarPowers`/`d` all match (§5). |
| 10 | **Wire format** | **PASS** | Length gate `99+96+logMN·66` + `off === length` (`:803,824`); Rust identical (`lib.rs:350,375`). Truncate/extend/garbage/cross-m rejected (`adversarial`, `monero-scenarios`, PoC). `logMN` derived from `m`, not attacker-controlled. |
| 11 | **Randomness** | **PASS** | `randomScalar` uses `crypto.getRandomValues`, rejection-samples [1,n), throws if CSPRNG absent (no insecure fallback) (`:111-120`). Fresh `alpha`/`dL`/`dR`/`r`/`s`/`d_`/`eta` per proof+round+retry — no nonce reuse. |
| 12 | **Consumer-side gluing** | **PASS** | All 13 sites fail-closed (JS `if(!…)return false`/`mark(false)`; Rust `assert!`(panic) in settle guest, `&&`/`Err`(skip) in reflection guest). The range-proved commitment is the *same* bytes/object the kernel/conservation check and the note-leaf derivation use (strongest cases reuse the literal object: `outC`, `out_pts`). Decoding matches the prover everywhere. |
| 13 | **JS ↔ Rust parity** | **PASS** | Verifier diffed line-for-line (parse, transcript, inverses, y^MN, d, challenges_cache, Gᵢ/Hᵢ, V/A/A1/B/L/R scalars, final check) — identical modulo Pippenger-vs-naïve MSM (which agree, BPP-1) and the 2⁻⁵¹² rehash edge (BPP-6). Executable differential passes (`cargo test` 54/54). |

---

## 5. The Monero match (soundness backbone)

Soundness is inherited from Monero's proven verifier only if the port is exact. The decisive comparisons (weight=1, cofactor=1):

**Prover** (`_bppRangeProveAttempt` vs `bulletproof_plus_PROVE` `.cc:513-776`): `d` vector (`:536` ≡ `.cc:610-626`); `y_powers` length MN+2 (`:548` ≡ `.cc:628`); `aL1/aR1` incl. `d_y[i]=d[i]·y^{MN−i}` (`:551-557` ≡ `.cc:631-639`); `alpha1` accumulation of `z^{2(j+1)}·y^{MN+1}·γ_j` (`:560-567` ≡ `.cc:641-648`); WIPA `cL/cR` and `compute_LR` with the `y^{∓nprime}` weighting (`:598-627` ≡ `.cc:680-687,184-216`); the four folds `Gprime/Hprime/aprime/bprime` (`:640-649` ≡ `.cc:698-704`); `alpha1 += dL·u²+dR·u⁻²` (`:651-654` ≡ `.cc:710-711`); final `A1 = r·G'+s·H'+d_·G+(r·y·b'+s·y·a')·H`, `B = eta·G+r·y·s·H`, `r1/s1/d1` (`:665-692` ≡ `.cc:722-773`). Every Monero `INV_EIGHT` is dropped at exactly the matching site.

**Verifier** (`bppRangeVerify` vs `bulletproof_plus_VERIFY` `.cc:799-1104`): see property #9 row. The `challenges_cache` in-place doubling (`:883-897`) reproduces Monero's pair-stepped loop (`.cc:1027-1038`) exactly (odd→`·u_j`, even→`·u_j⁻¹`, parent read in decreasing order before overwrite); `(~i)&(MN−1) == (MN−1)^i` for `i<MN`. `_sumOfScalarPowers` uses the general loop, which is what Monero takes for `MN ∈ {64,128,256,512}` (since `MN+1` is never a power of 2) — no divergence; `_sumOfEvenPowers` matches the `S_{2k}=S_k·(1+x^k)` doubling.

---

## 6. Coverage gaps (summary for the test owner)

What the suite **does** cover well: completeness across m and boundary values (`roundtrip`, `bounded-exhaustive`); verifier-side out-of-range rejection at the true boundary (`malicious-prover` Attack 2 + Rust `bpp_out_of_range.json` fixture); commitment swap / reorder / aggregation mismatch in the verifier; bit-flip tamper across every structural field; wire-format malformation.

What it **does not** cover (all code-verified-correct here, so this is test debt):
1. **Pippenger `msm` has no independent oracle** (BPP-1) — add the naïve cross-check.
2. **No crafted-body malformation tests** (BPP-2) — zero/≥n scalars and off-curve points in named fields are only hit incidentally; the verifier notably has no *explicit* nonzero check on `r1/s1` (the MSM is the backstop). Add the PoC's (i/j) cases.
3. **The JS↔Rust differential is fixture-pinned, in `cargo test`, fixture-scale** (BPP-3) — add a regenerate-then-diff CI step (and optionally a random fuzz differential), so a future port/dependency drift can't pass behind a green JS suite.
4. **`python-parity`/`symbolic-identity`/`witness-extractor` over-promise** (BPP-5) — pinned-hex vs live diff; mirror vs real verifier; round-trip relabeled as algebraic check.

---

## 7. Artifacts

- PoC harness: `ops/audits/bulletproofs-plus/poc-bpp-audit.mjs` (35/35 pass, re-run confirmed) — MSM cross-check, out-of-range, boundary completeness, crafted malformations, binding, malleability probe.
- Second PoC: `ops/audits/bulletproofs-plus/poc-soundness-edges.mjs` (11/11 pass) — independent soundness edges: 2⁶⁴ + N−1 out-of-range rejection, commitment swap, non-canonical r1, length tamper, 85-flip bit-flip survey, identity-commitment clean-false.
- Executable differential: `cargo test --release` in `contracts/sp1/confidential/cxfer-core` (54/54 pass) incl. `range_accepts_js_proof_and_rejects_tamper`, `range_rejects_out_of_range_commitment`.
- JS suite: run each file **directly** with `node tests/<name>.test.mjs`. The files use a custom `ok()`/`group()` harness (none import `node:test`), so `node --test` imports and runs the top-level code but registers **0** tests — read the printed `N passed, M failed` line, not the runner summary. **All suites confirmed green** (this audit):
  - `prover-smoke` 24/0 · `roundtrip` 20/0 · `adversarial` 39/0 · `malicious-prover` 26/0 · `monero-scenarios` 22/0 · `bounded-exhaustive` 5/0 · `pinned-fixtures` 27/0 · `property-fuzz` 3/0 · `symbolic-identity` 200/0 · `witness-extractor` 27/0 · `python-parity` 16/0
  - `cxfer-bpp-wire` 136/0 · `axfer-bpp-wire` 85/0 · `cxfer-bpp-integration` 36/0
  - Re-run gotchas: (1) the three `*-bpp-wire`/`-integration` tests bootstrap `dapp/tacit.js` + `worker/src/index.js` under `jsdom` (resolved from `tests/node_modules`; they set `__TACIT_NO_INIT__`), and **node does not auto-exit** afterward — a lingering timer/handle keeps the event loop alive. Redirect output to a file and read the summary; do **not** pipe through `tail` (nothing prints until an exit that never comes) and don't mistake the non-exit for a hang/failure. (2) BP+ proving is slow in pure JS — ~3 s/proof at m=1, ~20 s at m=8 — so `bounded-exhaustive`/`property-fuzz` are multi-minute runs.
