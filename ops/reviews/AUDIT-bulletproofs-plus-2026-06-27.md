# Audit — Bulletproofs+ range proof (JS prover/verifier + Rust guest verifier)

Date: 2026-06-27
Scope: `dapp/bulletproofs-plus.js` (live prover + attester verifier), `contracts/sp1/confidential/cxfer-core/src/lib.rs::verify_range` (on-chain-enforced verifier), all consumer call sites, against the Monero reference (`.local/monero-bpp-ref/bulletproofs_plus.cc`) and Bulletproofs+ eprint 2020/735.
Type: read-only soundness + completeness review. No production files modified. PoC at `/private/tmp/.../scratchpad/poc.mjs`.

## Verdict

The Bulletproofs+ port is **sound for deployment**. No fund-critical or high-severity findings. The JS file is a faithful line-by-line port of Monero's `bulletproof_plus_PROVE` / `bulletproof_plus_VERIFY` with the only curve adaptation handled correctly: secp256k1 has cofactor 1, so every Monero `INV_EIGHT`/`scalarmult8` is omitted (`dapp/bulletproofs-plus.js:11-17, 491-492`), which is the single most dangerous porting trap and it is dealt with consistently across commit, prover, and verifier. The Rust guest verifier (`lib.rs:918-1080`) matches the JS term-for-term (transcript bytes, scalar formulas, MSM membership), and a JS-produced proof is accepted by the Rust verifier in-tree (`lib.rs:5266-5279`). The verifier reduces to a single MSM `== identity` check with all terms present; the value bound is genuinely enforced — a forged proof committing an out-of-range value (V opens to ≥ 2^64) is rejected by both verifiers (proven, BPP-1; `lib.rs:5459-5469`, PoC across every `m`). The residual items are coverage and robustness, not exploitable soundness: chiefly the **absence of a randomized JS↔Rust differential harness** (the cross-check is a handful of pinned m=1/m=2 fixtures), and a benign fail-closed behavioral divergence on an (unreachable) identity commitment (JS returns `false`, Rust panics). The 13-property checklist is 12 PASS / 1 PARTIAL (parity coverage). No re-prove or artifact rotation is required by any finding.

Note: this is the complete 13-property review (no focus override supplied).

## Findings

| ID | Severity | One-line | Evidence |
|----|----------|----------|----------|
| BPP-A | low — **RESOLVED 2026-06-27** | No randomized JS↔Rust differential verify harness; cross-check was a few pinned m=1/m=2 fixtures — a future port/dependency drift hitting only m=4/8 or a challenge-dependent path could pass the green suite. **Closed: added a deterministic 28-case (m∈{1,2,4,8} × honest / out-of-range / tamper / wrong-commitment) corpus driven through both verifiers — see Resolution log.** | theoretical (coverage gap) |
| BPP-B | info | Identity-commitment behavior diverges: JS `bppRangeVerify` returns `false`, Rust `verify_range` panics in `compress(identity)`. Both fail-closed; unreachable in the guest (`from_affine_xy` rejects identity before verify) | proven (PoC + `lib.rs:5317-5328`) |
| BPP-C | info | `_allowOutOfRangeForTest` test escape-hatch lives in the production prover module; default off, no consumer sets it, verifier rejects its output regardless | proven (PoC BPP-1) |
| BPP-D | info | Rust transcript zero-challenge fallback returns a possibly-zero `h2` with no second guard; JS throws on the same path. P ≈ 2^-512, transcript-unreachable | code read (`lib.rs:737-740` vs `bulletproofs-plus.js:412-418`) |
| BPP-E | info | `bppRangeVerify` can throw (not return `false`) if an internal challenge were zero (`batchInv`→`modInv(0)`); unreachable given the transcript guarantees, and most consumers wrap in try/catch — `confidential-transfer.js:97` does not | code read |

No proven exploit produces an accepting forged/out-of-range proof on either verifier.

---

## Per-finding detail

### BPP-A (low) — no randomized JS↔Rust differential harness

**Evidence.** The on-chain authority is `verify_range` (`lib.rs:918`). The only automated cross-checks against the JS are:
- `range_accepts_js_proof_and_rejects_tamper` (`lib.rs:5266`) — one JS m=2 fixture (`fixtures/cxfer.json`) accepted; byte-flip + wrong-commitment rejected.
- `range_adversarial_edge_cases` (`lib.rs:5286`) — structural gates (m∈{1,2,4,8}, exact length, parse, non-canonical r1) on the same m=2 fixture.
- `range_rejects_out_of_range_commitment` (BPP-1, `lib.rs:5459`) — one JS-generated honest m=1 (2^64−1) accepted; one JS-generated forged out-of-range m=1 rejected.

So the JS→Rust accept/reject agreement is pinned for **m=1 and m=2 only**, on a literal handful of proofs. There is no m=4/m=8 honest fixture cross-checked against Rust, and no randomized differential that feeds N random proofs (all `m`, edge values, both honest and tampered) through *both* verifiers and asserts identical verdicts. `bulletproofs-plus-python-parity.test.mjs` is a third independent port but checks **prover byte-equality** (JS proof bytes == Python proof bytes), not the Rust verifier.

**Impact.** Not exploitable today — the code is a faithful port and the algebra is cross-checked symbolically (`bulletproofs-plus-symbolic-identity.test.mjs`, 200 instantiations vs an independent paper re-derivation). The risk is *latent*: a dependency bump (noble/k256), a refactor, or a future op that drives m=4/8 could introduce a JS↔Rust divergence that the green suite would not catch. Attester-blesses-but-guest-rejects ⇒ settle reverts (brick); the reverse ⇒ soundness gap. A differential harness is the cheapest insurance against both.

**Fix (add a test; no production change).** Add `tests/bulletproofs-plus-rust-differential.test.mjs` that generates K random proofs per `m∈{1,2,4,8}` (honest + tampered + out-of-range via the existing hatch), serializes `{commitmentsHex[], proofHex, expect}`, and a Rust `#[test]` in `cxfer-core` that reads them and asserts `verify_range` agrees with `expect` for every case:

```diff
+ // tests/bulletproofs-plus-rust-differential.test.mjs  (NEW)
+ // Emits fixtures/bpp_differential.json: for each m in {1,2,4,8}, K honest +
+ // K tampered + K out-of-range cases, each {m, commitments:[hex], proof:hex, accept:bool}
+ // where `accept` is bppRangeVerify's verdict. Pin the file; CI regenerates + diffs.

+ // cxfer-core/src/lib.rs  (NEW #[test])
+ #[test]
+ fn range_matches_js_across_random_corpus() {
+     let f: serde_json::Value =
+         serde_json::from_str(include_str!("../../fixtures/bpp_differential.json")).unwrap();
+     for case in f["cases"].as_array().unwrap() {
+         let cs: Vec<_> = case["commitments"].as_array().unwrap()
+             .iter().map(|v| pt(v.as_str().unwrap())).collect();
+         let p = hex::decode(strip(case["proof"].as_str().unwrap())).unwrap();
+         let want = case["accept"].as_bool().unwrap();
+         assert_eq!(verify_range(&cs, &p), want, "JS<->Rust verdict divergence: {case}");
+     }
+ }
```

Artifacts rotated: none (test-only). Should land before mainnet activation of BP+ (currently default-off on mainnet, on for signet — `bulletproofs-plus.js:38-42`).

### BPP-B (info) — identity-commitment parity divergence (fail-closed both sides)

**Evidence (proven).** PoC: `bppRangeVerify([ZERO], <valid proof>)` returns `false`; `pointToBytes(ZERO)` returns a 33-byte `0x02‖00…00` (noble’s encoding of the point at infinity) which the verifier hashes into the transcript and then rejects via the MSM. The Rust side: `compress(identity)` SEC1-compresses the point at infinity to a single `0x00` byte, not 33, and panics inside the transcript V-append (documented and asserted in `lib.rs:5317-5328`). Both outcomes are fail-closed (neither blesses the proof).

**Impact.** None in production: output commitments in the guest are reconstructed by `from_affine_xy(cx,cy)` which has no encoding for the identity and returns `None`, so the guest `.expect()`-panics before `verify_range` is reached (`lib.rs:5318-5320`). The divergence (graceful `false` vs panic) only manifests if an identity point were fed directly. Worth a one-line guard for behavioral parity, but no fund or brick risk.

**Fix (optional, parity hygiene).** Reject identity commitments explicitly at the top of both verifiers so behavior is identical:
```diff
  // dapp/bulletproofs-plus.js  bppRangeVerify, after the m-set check
+ for (const C of commitments) { if (!C || C.equals(ZERO)) return false; }
```
```diff
  // lib.rs  verify_range, after the m check
+ if commitments.iter().any(|c| *c == ProjectivePoint::identity()) { return false; }
```
Artifacts rotated if applied: JS mirror + guest ELF + vkey (because the transcript-reachable code changes). Given it is unreachable, applying it is optional and should be batched with an unrelated re-prove, not done for its own sake.

### BPP-C (info) — test hatch in the production prover module

**Evidence.** `bppRangeProve(values, blindings, _allowOutOfRangeForTest = false)` (`bulletproofs-plus.js:463`) skips the `[0,2^64)` input guard when the 3rd arg is true (`:483`). All consumers call with two args (`confidential-transfer.js:74,128`, `tacit.js:27744`), so it defaults off. It is prover-side only; the verifier has no such hatch, and BPP-1 proves the verifier rejects any out-of-range artifact the hatch can produce.

**Impact.** None — verifier-irrelevant. Listed for completeness; the hatch is what makes the BPP-1 negative test possible, which is a net positive for coverage.

### BPP-D (info) — Rust zero-challenge fallback lacks the JS second guard

**Evidence.** JS `challenge()` rehashes a zero challenge with a `0x01` tag and throws if the rehash is also zero (`bulletproofs-plus.js:412-418`). Rust `challenge()` rehashes but returns `scalar_reduce_be(&h2)` unconditionally — if `h2` also reduces to zero it returns zero (`lib.rs:737-740`). Probability ≈ 2^-512 and the transcript state is identical up to that point, so it is unreachable. Both append only the first hash `h` to the running transcript, so the transcript evolution matches regardless.

**Impact.** None reachable. If ever hit, JS aborts and Rust proceeds with a 0 challenge (which then fails the MSM / invert). Documented for parity completeness.

### BPP-E (info) — `bppRangeVerify` may throw instead of returning false on an (unreachable) zero internal challenge

**Evidence.** Point parses are wrapped in try/catch → `false` (`:808-823`); scalar canonicality returns `false` (`:816`). But `batchInv([...challenges, y])` (`:855`) calls `modInv` which throws on 0 (`:85`). This is unreachable because the transcript never emits 0 and the code explicitly checks `y,z,u,e ≠ 0` before that point (`:836,844,850`). The doc comment states exceptions are reserved for malformed bytes (`:747-749`). Most consumers wrap the call in try/catch (`confidential-pool.js:1331`, `burn-deposit-bitcoin.js:628`); `confidential-transfer.js:97` does not, but the throw is unreachable.

**Impact.** None reachable. Defensive note only.

---

## 13-property checklist

| # | Property | Verdict | Evidence |
|---|----------|---------|----------|
| 1 | Transcript / Fiat-Shamir soundness (absorb-before-squeeze, ordering, domain sep) | **PASS** | Prover absorbs V (`:521`) and A (`:526`) before y/z (`:529,532`); L,R (`:632-633`) before u (`:634`); A1,B (`:680-681`) before e (`:682`). Verifier replays identically (`:828-849`). Domain `tacit-bpp-v1` (`:76`) + per-message labels + `M`. Rust transcript byte-identical (`lib.rs:719-743`, `:951-969`); JS proof verifies under Rust (`lib.rs:5270`). |
| 2 | Challenge non-zero / invertibility | **PASS** | Transcript rehashes a 0 challenge (`:412-418`, `lib.rs:737-740`); verifier guards `y,z,u,e≠0` (`:836,844,850`); `y^-1`/`u^-1` via `batchInv`/`invert` on guaranteed-nonzero (`:855`, `lib.rs:973-977`). |
| 3 | Scalar canonicality (reduced < n, non-canonical rejected) | **PASS** | r1,s1,d1 rejected if ≥ n (`:816`; Rust `scalar_canonical_be`/`from_repr` `lib.rs:937-941,61-67`). PoC: r1=0xFF…FF rejects; `lib.rs:5330-5334`, malformed-body test (`:38-42`). |
| 4 | Point validation / subgroup / cofactor (the INV_EIGHT trap) | **PASS** | secp256k1 cofactor 1 ⇒ all `scalarmult8`/`INV_EIGHT` correctly omitted (`:11-17,491-492,523`); points validated on-curve by `fromHex`/`from_encoded_point`; off-curve & x≥p rejected (malformed-body `:44-48`); identity not 33-byte-encodable in proof. (See BPP-B for the identity-commitment edge.) |
| 5 | Range bit-length n exact (no short/extra L,R rounds) | **PASS** | N=64 fixed (`:70`); `logMN` from `m=commitments.length`; exact length `99+96+logMN·66` (`:802-803`, `lib.rs:924`) + `off==len` (`:824`, `lib.rs:949`). PoC: +1 round rejects; truncated/over-length/m-mismatch reject (`lib.rs:5303-5310`). |
| 6 | Aggregation m correct (z powers, m rejected if malformed, pow-2 padding) | **PASS** | m∈{1,2,4,8} (`:793`, `lib.rs:920`); per-commitment z^(2(j+1)) (prover `:560-567`, verifier `:917-925`); MN pow-2. PoC m=1..8 honest accept + one-slot-OOR reject; m=0/m=3 reject (`lib.rs:5294-5298`). |
| 7 | Final MSM == identity (single check, all terms) | **PASS** | One accumulation, one `acc.equals(ZERO)` (`:992-1012`, `lib.rs:1063-1079`). All ten term-classes present (G,H,Gvec,Hvec,V,A,A1,B,L,R). Symbolic-identity test validates every scalar vs paper (`bulletproofs-plus-symbolic-identity.test.mjs`). |
| 8 | Generator / NUMS correctness (same H for commit + proof) | **PASS** | try-and-increment hash-to-curve, tags `tacit-bp-G/H-v1`, H from `tacit-generator-H-v1` (`:336-373`, `lib.rs:747-779`). KAT-pinned hex (`prover-smoke:32-40`). Same H in `pedersenCommit` (`:377-380`) and verifier H-term. Rust derivation identical, confirmed transitively (JS proof verifies under Rust). |
| 9 | Inner-product / WIP reduction (fold, y-weighting) | **PASS** | `weightedInnerProduct` y-weighted (`:305-314`), `hadamardFold` (`:318-326`), fold factors `yInvNp,u,uInv` (`:640-649`) match Monero compute_LR/fold (`.cc:184-216,698-704`); verifier `challengesCache` (`:883-897`, `lib.rs:994-1009`) matches Monero pair-unroll (`.cc:1030-1038`) and the explicit bit-decomposition oracle in the symbolic test. |
| 10 | e (last challenge) binds A1,B | **PASS** | A1,B appended before e squeezed (prover `:680-682`; verifier `:847-849`); r1,s1,d1 linear in e (`:690-692`); A1/B carry r,s,d_,eta,rys (`:665-678`). Swap r1↔s1 / A↔B / zero-d1 all reject (malicious-prover Attacks 6,10). |
| 11 | Blinding / value-commitment binding (real note commitment, integer range) | **PASS** | V=v·H+γ·G (`:377-380`); consumers pass REAL on-chain commitments (`confidential-transfer.js:73-75,97`; guest `main.rs:374-384,452,538,622,929`; `burn_deposit.rs:368`; `pool` `lib.rs:2262-2270`); conservation kernel uses the same points. alpha1↔V G-component cancellation verified by hand. PoC: high-bit smuggle v=2^64+5 (≡5 mod 2^64) rejects; OOR-commitment − honest-5-commitment == 2^64·H. |
| 12 | Degenerate inputs rejected | **PASS** | empty/all-zero/n=0/m=0/identity-slot/zero-scalar all reject (`lib.rs:5294-5334`; malformed-body `:32-61`; msm degenerate test). No silent accept. |
| 13 | JS ↔ Rust parity | **PASS** (was PARTIAL) | Faithful line-by-line port; transcript, helpers (`scalar_canonical_be`, `decompress`, `hash_to_curve`, `gen_h`), challenges_cache, and all MSM scalars match. Cross-check is now a randomized all-m differential: the deterministic 28-case corpus (`fixtures/bpp_differential.json`) is driven through the JS verifier (`tests/bulletproofs-plus-rust-differential.test.mjs`, 2/2) AND the on-chain `verify_range` (`lib.rs::range_matches_js_across_random_corpus`, ok), both agreeing case-for-case over m∈{1,2,4,8} × honest/OOR/tamper/wrong-commitment (BPP-A RESOLVED). Residual: identity-commitment behavior diverges fail-closed (BPP-B, info, guest-unreachable). Python-parity additionally covers prover bytes. |

---

## Green baseline (tests read for what they assert, not just pass/fail)

JS suite (all pass):
- `bulletproofs-plus-roundtrip` — 20/20: honest prove→verify m=1/2/4/8, value 0, 2^64−1, mixed; tamper r1/A, wrong/empty/wrong-length, cross-witness reject. (~123 s)
- `bulletproofs-plus-adversarial` + `-malicious-prover` + `-msm` + `-malformed-body` + `-symbolic-identity` + `-witness-extractor` — 200 + 27 + … all pass. Highlights: out-of-range smuggling rejected by the *verifier* (malicious Attack 2, the no-inflation root); msm Pippenger cross-checked vs a naive oracle across every window regime + the verifier's real sizes (146, 1057) with identity/repeated points and edge scalars (0,1,n−1,2^255|1); symbolic-identity asserts every verifier scalar equals an independent paper re-derivation across 200 random instantiations.
- `bulletproofs-plus-prover-smoke` — KAT-pins Gvec[0]/Hvec[0]/H to SPEC §3.1 hex (generator integrity), proof lengths per m.
- `bulletproofs-plus-python-parity` — JS proof bytes == an independent Python port (prover-side cross-impl).
- (remaining: `-monero-scenarios`, `-property-fuzz`, `-bounded-exhaustive`, `cxfer-bpp-integration`, `cxfer-bpp-wire` — run as part of the baseline.)

Rust guest (`cargo test --lib range`): `range_accepts_js_proof_and_rejects_tamper`, `range_adversarial_edge_cases`, `range_rejects_out_of_range_commitment` — 3/3 pass in 0.97 s. This is the on-chain authority verifying JS-produced proofs and rejecting JS-produced forgeries.

Independent PoC (`scratchpad/poc.mjs`, all probes pass): honest accept + one-slot out-of-range reject for every m∈{1,2,4,8}; all-slots 2^64−1 accept; high-bit smuggle (2^64+5) reject with commitment-difference == 2^64·H; non-canonical r1 reject; extra-round length reject; identity-commitment → JS `false`, `pointToBytes(ZERO)` → 33-byte `0x02‖00…00`.

## Coverage gaps + tests that would close them

1. ~~**JS↔Rust differential (BPP-A)** — the headline gap.~~ **CLOSED 2026-06-27** by the deterministic differential harness (see Resolution log).
2. **m=4/m=8 honest acceptance cross-checked against Rust** — currently only m=1/m=2 fixtures hit the Rust verifier. Subsumed by (1).
3. **Witness-extractor is an honest-prover sanity check, not a rewinding extractor** (the file says so, `:30-34`). It does not establish special-soundness empirically; it confirms the algebraic structure. Soundness rests on the Monero proof + the symbolic-identity equivalence. A true two-transcript rewinding extractor (branch at a fixed first message, extract aL/aR) would upgrade this from "structure intact" to "witness extractable in our impl," but is not required for deployment.
4. **Identity-point parity (BPP-B)** — add the identity-commitment reject to both verifiers (or a Rust test asserting the JS-style `false`) if behavioral parity is wanted; unreachable in the guest today.

## Out of scope (flagged, not audited here)

The AMM `swap_batch` cross-curve (secp256k1 ↔ BabyJubJub) sigma (`lib.rs:805` `xcurve_secp_check`, `swap_batch_aggregate_identity:838`) proves mod-order equality of hidden amounts across curves; its integer range-bounding is a separate primitive from this BP+ proof (BP+ here bounds cxfer/transfer/bridge/wrap outputs to [0,2^64)). Whether every amount feeding the cross-curve sigma is independently range-bounded belongs to the AMM/swap_batch review, not this one.

---

## Resolution log

### BPP-A — RESOLVED 2026-06-27 (randomized JS↔Rust differential harness)

Test-only change; **no production file modified, no ELF/vkey/contract rotation** (the new Rust function is `#[cfg(test)]`, so it does not compile into the guest ELF).

Added:
- `tests/gen-bpp-differential-fixture.mjs` — deterministic corpus generator. Replaces `globalThis.crypto.getRandomValues` (the seam `bulletproofs-plus.js::randomScalar` draws from at `:524,605-606,660-663`) with a seeded SHA256 keystream, so every proof is reproducible and the fixture is byte-stable / git-diffable. Emits 28 cases = m∈{1,2,4,8} × {honest_zero, honest_max, honest_mixed, oor_2pow64, oor_smuggle (2^64+5 high-bit smuggle), tamper (flipped final-scalar byte), wrongc (commitment[0] + 3·G)} and pins each case's JS verdict (`accept`). The generator self-asserts every verdict while building (honest→accept, the rest→reject), so it cannot emit a corpus the JS verifier disagrees with.
- `contracts/sp1/confidential/fixtures/bpp_differential.json` — the committed corpus (28 cases, 12 accept / 16 reject). Regenerate with `node tests/gen-bpp-differential-fixture.mjs > contracts/sp1/confidential/fixtures/bpp_differential.json`.
- `tests/bulletproofs-plus-rust-differential.test.mjs` — JS half. (1) drives every committed case through `bppRangeVerify` and asserts the pinned verdict; (2) re-runs the deterministic generator in-memory and asserts it reproduces the committed bytes exactly — a port/@noble drift that changes proof bytes or flips a verdict fails here and tells you to regenerate.
- `cxfer-core/src/lib.rs::range_matches_js_across_random_corpus` (`#[cfg(test)]`) — Rust half. Reads the same committed fixture via `include_str!` and asserts the on-chain `verify_range` returns the pinned verdict for every case, requiring both an accept and a reject case to be present.

Result: JS `node --test` 2/2 pass (~128 s, dominated by re-proving the corpus); Rust `cargo test --release range_matches_js_across_random_corpus` ok (1.35 s). Both verifiers now agree case-for-case across all m and all four families on identical bytes; future divergence (incl. m=4/8-only or challenge-dependent drift) fails one side loudly instead of silently bricking settle or opening a soundness gap.

Property 13 (JS↔Rust parity) upgraded PARTIAL → PASS. Remaining BP+ items (BPP-B identity-commitment fail-closed divergence, BPP-C test hatch, BPP-D/E unreachable robustness) are info-level and non-exploitable; left as documented.
