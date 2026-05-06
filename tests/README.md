# tacit tests

Offline test + benchmark harness for tacit's confidential-transaction crypto.

## Files

- `bulletproofs.mjs` — implementation library, mirrored byte-for-byte from `tacit.html`'s in-page module. Anything that passes here passes in the dApp.
- `bulletproofs.test.mjs` — correctness suite. Single proofs, aggregated proofs, tampering rejection, batch verification.
- `bulletproofs.bench.mjs` — performance microbenchmarks. Prove / verify / batch-verify timings on Node; in-browser performance is comparable.
- `package.json` — installs `@noble/secp256k1`, `@noble/hashes`, `@scure/base` so the harness can run without the worker's `node_modules`.

## Running

```sh
cd tests
npm install        # one-time
npm test           # correctness suite
npm run bench      # microbenchmarks
```

Generator derivation is the slow startup step (~500ms on a modern laptop). Subsequent operations are amortised over the cached vectors.

## What the suite verifies

- Pedersen commitments + bulletproof verifier agree end-to-end at n=64 bits, m=1/2/4 aggregation.
- Out-of-range values, malformed `m`, and zero-/negative-amount inputs are rejected at prove time.
- Tampered proofs (any byte flip) fail verification.
- Swapped or forged commitments fail verification.
- Batch verification:
  - All-valid → accept
  - Any-invalid → reject
  - Empty batch → vacuously true
  - Mixed `m` sizes (m=1+2+4 in one batch) → accept

## Sync with `tacit.html`

If you change crypto in `tacit.html`, mirror the change into `tests/bulletproofs.mjs` and re-run `npm test`. The two should stay in lock-step. The library file's header comment notes this contract.
