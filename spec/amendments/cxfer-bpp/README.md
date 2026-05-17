# Bulletproofs+ — verification companion

This folder documents the verification work behind `T_CXFER_BPP` (opcode `0x22`), the Bulletproofs+ confidential-transfer variant specified in [`SPEC-CXFER-BPP-AMENDMENT.md`](../SPEC-CXFER-BPP-AMENDMENT.md).

It exists because Bulletproofs+ is a non-trivial cryptographic upgrade, and the depth of evidence behind a new opcode matters to anyone planning to audit, re-implement, or trust this code. This is the entry point for that scrutiny.

---

## What is `T_CXFER_BPP`?

A parallel confidential-transfer opcode carrying a Bulletproofs+ aggregated range proof in place of standard Bulletproofs. Same Pedersen commitment scheme, same Mimblewimble kernel signature, same ECDH amount encryption, same aggregation cap. **~5% lower fees per confidential transfer** at any fee rate, with zero impact on existing assets, listings, mixer pools, AMM pools, drops, or wallet recovery flows.

The formal byte-level specification lives at [`../SPEC-CXFER-BPP-AMENDMENT.md`](../SPEC-CXFER-BPP-AMENDMENT.md). What follows is the evidence base.

---

## Rollout posture

- **Mainnet**: gate-OFF by default. Existing CXFER continues to be the canonical transfer opcode.
- **Signet**: gate-ON by default. The dapp banner indicates BPP is active on this client.
- **Activation**: a one-line change to the gate default in `dapp/tacit.js` flips the mainnet behavior, with localStorage opt-in available at any time via `tacit-bpp-enable-mainnet-v1`.

The amendment was deliberately structured as a *parallel* opcode rather than a CXFER revision, so every existing CXFER UTXO ever broadcast continues to validate under the unchanged standard-Bulletproofs verifier. Pre-amendment clients treat `0x22` as an unknown-opcode no-op (per the protocol's forward-compatibility rule).

---

## Verification summary

### 1. Algorithmic correctness vs the Monero reference

The implementation at [`dapp/bulletproofs-plus.js`](../../../dapp/bulletproofs-plus.js) is a hand-port of Monero's [`bulletproofs_plus.cc`](https://github.com/monero-project/monero/blob/master/src/ringct/bulletproofs_plus.cc) with two deliberate substitutions:

- **Curve**: ed25519 → secp256k1. Because secp256k1 has cofactor 1, every `INV_EIGHT` / `MINUS_INV_EIGHT` scalar multiplication and every `scalarmult8` in Monero's verifier is omitted in the port. This is the single most error-prone porting trap.
- **Hash**: Keccak (`cn_fast_hash`) → SHA-256 for Fiat-Shamir. Internal-only choice; prover and verifier agree. Proof bytes are not Monero-compatible by design.

A line-by-line algorithmic review against the Monero source confirmed the curve simplification is applied consistently and the WIPA fold equations, d-vector construction, challenges_cache recurrence, and final MSM check all match Monero formula-for-formula.

### 2. NUMS generator byte-identity with `SPEC.md §3.1`

The Pedersen value generator `H` and the BP+ vector generators (`G_vec[i]`, `H_vec[i]`) are reused unchanged from standard Bulletproofs under the same `tacit-bp-G-v1` / `tacit-bp-H-v1` / `tacit-generator-H-v1` domain tags. The derivation procedure (`sha256(domain || idx_LE || counter)` + 0x02 prefix try-and-increment) matches the canonical implementation line-for-line, and three independent code paths now produce the same pinned hex constants:

| Generator | SPEC §3.1 pinned hex |
|---|---|
| `H` | `02bd7bf40fb5db2f7e0a1e8660ca13df55bb0d9f904e36e6297361f00376865e56` |
| `Gvec[0]` | `025cfa02a4913b0b122c4f275ae566e6ba52627d80036e25a43a3fd5d2062f28d4` |
| `Hvec[0]` | `02b78ed462f5c137b05d1e99daeb2619eb890ec4781acf098018628ca0ec0d20e2` |

The extended generator KAT in `tests/bulletproofs-plus-pinned-fixtures.test.mjs` also pins `Gvec[1..3]` and `Hvec[1..3]` to make silent index-encoding drift loud.

### 3. Mechanized paper-↔-code identity check

The Bulletproofs+ paper specifies the verifier as a single multi-scalar-multiplication identity over `G`, `H`, the generator vectors, the input commitments, and the proof's group elements. `tests/bulletproofs-plus-symbolic-identity.test.mjs` independently derives the paper's per-term scalar formulas, then extracts the same scalars from the production JS verifier path, and asserts byte-equality at 200 random instantiations of the challenge variables `(y, z, u_k, e, r1, s1, d1)`.

By the Schwartz-Zippel lemma over the secp256k1 scalar field, agreement at 200 random points implies the polynomials are equal as polynomials. The verifier's MSM check is mechanically confirmed to be the equation the paper specifies, not just empirically tested with positive examples.

### 4. Blind cross-implementation parity

[`python-port-blind.py`](python-port-blind.py) is an independent Python implementation of Bulletproofs+ on secp256k1, hand-written from only:
- The Monero C++ reference
- This repository's SPEC.md §3.1 (for the NUMS domain tags)
- The amendment doc §5.47.3 / §5.47.4 (for wire format and generator reuse)

The author of the Python port never read the JS implementation. Both implementations, given the same `(values, blindings, RNG bytes)` input, produce **byte-identical proofs** at every supported aggregation level:

| m | Proof length (bytes) | JS / Python agreement |
|---|---|---|
| 1 | 591 | byte-identical |
| 2 | 657 | byte-identical |
| 4 | 723 | byte-identical |
| 8 | 789 | byte-identical |

Pinned proof hex for both implementations lives in [`cross-impl-fixtures.md`](cross-impl-fixtures.md). Two independent code paths converging on the same proof bytes is the strongest static-analysis evidence available for a cryptographic port.

### 5. Shaped-attack rejection suite

`tests/bulletproofs-plus-malicious-prover.test.mjs` exercises 11 concrete attacks an adversary would actually try, beyond random byte-flip fuzz:

- Bit-decomposition forgery (prove `v`, swap in `commit(v')`)
- Out-of-range smuggling (`v ≥ 2⁶⁴`)
- Aggregation cross-contamination (swap one of two commitments)
- Blinding-factor substitution
- Transcript-bind violation (order-swap commitments)
- Final-scalar swap (`r1 ↔ s1`, zeroed `d1`)
- G/H swap on the commitment side
- Duplicate commitment slot substitution
- L/R round permutation
- A/B group-element substitution
- m=2 proof bytes against m=4 commitments

All 22 assertions reject. This is the actual attack surface, made concrete.

### 6. Witness-extractability sketch

`tests/bulletproofs-plus-witness-extractor.test.mjs` runs the algebraic relations required by the BP+ soundness proof against our prover's outputs. Final scalars `(r1, s1, d1)` are confirmed to fall in `[1, SECP_N)`, the verifier's MSM identity evaluates to the identity point for every honest proof, and the same identity fails for proofs with tampered `r1`, `s1`, or `d1`. This is the soundness proof's witness step, made executable.

### 7. Property-based and exhaustive boundary coverage

Beyond the targeted attacks:
- `tests/bulletproofs-plus-property-fuzz.test.mjs` — 200 honest random samples verify; 200 random byte-flip tampers reject; 50 commitment-order swaps reject
- `tests/bulletproofs-plus-bounded-exhaustive.test.mjs` — structured boundary sweep at every power of 2 from 2⁰ to 2⁶³, the `(2^k − 1)` and `(2^k − 2)` boundaries, the symmetric `(2^k + 1)` / `(2^k + 2)` values just above, plus 64 random uniform samples; replicated at m=2 (boundary pairs), m=4 (boundary quads, 256 combinations), and m=8 (extreme configurations)
- `tests/bulletproofs-plus-monero-scenarios.test.mjs` — mirrors the test classes Monero exercises on their BP+: boundary values, identity-commitment edge cases, repeated verification (state-leak check), commitment ordering, cross-proof substitution, cross-m wire substitution

---

## Test inventory

A consolidated view of the verification test corpus. All files are at `tests/` at the repository root.

| File | Class | Assertions |
|---|---|---|
| `bulletproofs-plus-prover-smoke.test.mjs` | Generator KAT + prover smoke | 24 |
| `bulletproofs-plus-roundtrip.test.mjs` | Self-consistency prove → verify | 20 |
| `bulletproofs-plus-adversarial.test.mjs` | Bit-flip survey, structural tamper | 39 |
| `bulletproofs-plus-monero-scenarios.test.mjs` | Monero-style attack classes | 22 |
| `bulletproofs-plus-malicious-prover.test.mjs` | Shaped soundness attacks | 22 |
| `bulletproofs-plus-pinned-fixtures.test.mjs` | Deterministic proof hex pin | 27 |
| `bulletproofs-plus-symbolic-identity.test.mjs` | Paper-↔-code MSM identity | 200 |
| `bulletproofs-plus-witness-extractor.test.mjs` | Soundness algebraic relations | 27 |
| `bulletproofs-plus-python-parity.test.mjs` | Cross-impl byte-equality | 16 |
| `bulletproofs-plus-property-fuzz.test.mjs` | Random sample property test | 3 |
| `bulletproofs-plus-bounded-exhaustive.test.mjs` | Structured boundary sweep | varies |
| `cxfer-bpp-wire.test.mjs` | Envelope encode/decode parity | 136 |
| `cxfer-bpp-integration.test.mjs` | Full-pipeline real-proof e2e | 36 |

All wired into `npm test` at `tests/package.json`.

---

## Reproducing the verification

From the repository root:

```sh
cd tests
npm install        # one-time
npm test           # full suite, including BPP tests
```

The blind Python port runs standalone:

```sh
python3 spec/amendments/cxfer-bpp/python-port-blind.py
```

It prints the generator KAT and round-trip status at every `m ∈ {1, 2, 4, 8}`. Confirm the hex matches the pinned values in this README.

The on-chain signet smoke-test harness (CETCH → T_CXFER_BPP send → mixed-ancestry T_CXFER return) lives at `tests/cxfer-bpp-onchain-e2e-signet.mjs`. Generate funded signet wallets via `tests/gen-cxfer-bpp-signet-wallets.mjs`, top them up from a faucet, run the harness.

---

## What is NOT in this folder

- Production-track-record evidence: BPP has not yet executed on mainnet. The signet exercise gathers this as it runs.
- A trained-cryptographer review: optional, not on the activation critical path.
- A bug bounty: an option the project may pursue once signet usage broadens.

The verification artifacts here document what *has* been done. They are not a substitute for adversarial exposure or community scrutiny — they are the foundation that makes scrutiny productive.

---

## Reporting

Issues, questions, or attempted forgeries are welcome at the project's GitHub repository: https://github.com/z0r0z/tacit/issues. For cryptographic concerns specifically, file an issue with the `bp+` label and include the proof bytes + commitments that exercise the behavior.

The amendment, the implementation, and the test corpus are all public and reproducible from the repository alone.
