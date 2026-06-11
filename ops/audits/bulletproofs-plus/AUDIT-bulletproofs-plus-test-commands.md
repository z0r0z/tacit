# BP+ audit — exact test commands

Companion to `ops/AUDIT-PROMPT-bulletproofs-plus.md`. Run these first to
establish a green baseline, then read what each actually asserts (a passing
suite proves completeness/self-consistency, NOT soundness — see the prompt).

- Node: v20.10.0. Run from repo root (`/Users/z/tacit`). No install step needed
  beyond `node_modules` already present (`@noble/secp256k1`, `@noble/hashes`).
- Two kinds of tests:
  - `*.test.mjs` → node's built-in runner: `node --test <paths…>`
  - plain `*.mjs` → standalone scripts: `node tests/<file>.mjs` (each prints its
    own PASS/FAIL and exits non-zero on failure)
- **BP+ proving is slow** (the roundtrip is ~100 s for a single proof). Give heavy
  runs a long timeout and prefer running the slow ones individually.

---

## 1. Core BP+ proof system (`*.test.mjs`)

```bash
# Full BP+ unit + adversarial + property suite (slow — several minutes).
node --test \
  tests/bulletproofs-plus-prover-smoke.test.mjs \
  tests/bulletproofs-plus-roundtrip.test.mjs \
  tests/bulletproofs-plus-adversarial.test.mjs \
  tests/bulletproofs-plus-pinned-fixtures.test.mjs \
  tests/bulletproofs-plus-monero-scenarios.test.mjs \
  tests/bulletproofs-plus-python-parity.test.mjs \
  tests/bulletproofs-plus-symbolic-identity.test.mjs \
  tests/bulletproofs-plus-witness-extractor.test.mjs \
  tests/bulletproofs-plus-malicious-prover.test.mjs \
  tests/bulletproofs-plus-bounded-exhaustive.test.mjs \
  tests/bulletproofs-plus-property-fuzz.test.mjs
```

Or the whole glob in one go (shell expands the paths):

```bash
node --test tests/bulletproofs-plus-*.test.mjs
```

The ones most worth reading line-by-line for the audit:
- `…-roundtrip` — the critical completeness check (prove→verify must be true).
- `…-adversarial` — bit-flip survey, commitment swap, cross-proof substitution,
  aggregation-factor mismatch, length tamper. **Confirm the rejections come from
  the verifier, not from the test setup.**
- `…-malicious-prover` — out-of-range value rejection. **Check it covers the
  2^64 boundary AND negative (high `value mod n`) values, not just one token
  out-of-range input.**
- `…-pinned-fixtures` / `…-monero-scenarios` / `…-python-parity` — KAT pins and
  cross-reference vectors (regression + external-reference agreement).

## 2. Wire format + CXFER/AXFER integration (`*.test.mjs`)

```bash
node --test \
  tests/cxfer-bpp-wire.test.mjs \
  tests/cxfer-bpp-integration.test.mjs \
  tests/axfer-bpp-wire.test.mjs
```

## 3. Consumer-level (BP+ flowing through the confidential pool) — standalone `.mjs`

These exercise `bppRangeProve` / `bppRangeVerify` through the real
envelope/kernel/conservation paths. Run individually:

```bash
node tests/confidential-reflection-conservation.mjs   # JS mirror == guest verdict (kernel+range)
node tests/confidential-transfer-roundtrip.mjs
node tests/confidential-opening-sigma.mjs
node tests/confidential-settle.mjs
node tests/confidential-swap-op.mjs
node tests/confidential-lp-op.mjs
node tests/confidential-otc-op.mjs
node tests/confidential-bid-op.mjs
```

## 4. Rust / SP1 guest reference verifier (the consensus check)

The guest verifier (`contracts/sp1/confidential/cxfer-core/src/lib.rs`,
`verify_range`) must accept exactly the proofs the JS verifier accepts. Run its
unit tests (needs the Rust toolchain):

```bash
cargo test --manifest-path contracts/sp1/confidential/cxfer-core/Cargo.toml
```

Look in particular for `bpp_out_of_range` / `cxfer_kernel_verify_*` tests and
confirm the fixtures they use are the same hex the JS side pins.

## 5. Fixture / differential generators (not tests — regenerate KATs / build a differential corpus)

```bash
node tests/gen-bpp-out-of-range-fixture.mjs
node tests/gen-cxfer-conservation-differential.mjs
```

---

## The gap to call out

There is **no automated differential test that feeds the same random proof
corpus to the JS verifier and the Rust guest verifier and asserts identical
accept/reject**. That is the single highest-value missing artifact (a JS-accepts
/ guest-rejects divergence locks or mints funds). If the audit builds one thing,
build that harness — generators in step 5 can seed it.
