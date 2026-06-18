# Confidential pool — hardening follow-ups

Punch-list of outstanding items from the guest/contract review pass. The bulk of the pass is already
landed (witness commitments, burn-deposit provenance binding, DAG reachability, cmint dedup, swap_batch
aggregate identity, strict-append height, LP-remove asset/min-liquidity, mode_b pool guard, fee/protocol-fee/
zero-value guards, parser checked_add + exact-length, Groth16 VK-digest pin + proof-infinity reject,
eth-reflection zero/dedup guards, the relay epoch-start/nBits/checkpoint fixes); this tracks what is left.

Status legend: `[ ]` open · `[~]` in progress · `[x]` done. Most guest items ride the **one coordinated
re-prove** (rotates the settle / `BITCOIN_RELAY_VKEY`, then re-pin) — they do not need separate ceremonies.

Host-side validation: the reflection guest can be exercised end-to-end without the box via
`reflect-exec` (SP1 execute mode) + `reflect-stdin`, and the vkey derived with `vkey-derive`. Use these to
confirm each guest change before the re-prove (`EXECUTE_OK` + `DIGEST_MATCH`).

---

## A. Re-prove bundle — guest + dapp (land together with the coordinated re-prove)

- [ ] **A1. Opening sigmas for `OP_WRAP` / `OP_CDP_MINT` / `OP_CDP_CLOSE` / `OP_CBTC_MINT`.**
  These ops verify the note opening by reading the raw blinding (`scalar_reduce_be(&r32())` →
  `verify_pedersen_opening`), unlike every other value op (swap/LP/OTC/BID/route/unwrap), which binds via an
  opening sigma so the prover verifies the amount without learning the blinding. Bring these four ops onto the
  same model so the box-untrusted proving property holds uniformly (cBTC notes are owner-free, so the blinding
  is the bearer secret — that op especially).
  - Guest: `contracts/sp1/confidential/src/main.rs` — replace the raw read with `verify_opening_sigma(&c,
    value, &R, &z, &ctx)`, `ctx` binding (op type, chain, asset, controller/outpoint/deposit-id, owner, value,
    nonce/position-leaf/destination), mirroring the `OP_UNWRAP` intent-context pattern.
  - Dapp: construct the sigmas (`pool.intentContext` / `deriveOpeningNonce` / `openingSigma`); emit `sigR/sigZ`,
    never `blinding`.
  - This is the single largest remaining soundness-model item.

- [ ] **A2. `OP_ATTEST_META` witness authentication.**
  The op derives the asset id from the etch txid and parses ticker/decimals/cid from the etch tx WITNESS, but
  proves only note-membership — the metadata envelope itself is not block-committed (wrong decimals would
  mis-set `unitScale`). Bind it with `bitcoin::verify_tx_witness_committed` (helper already in cxfer-core), and
  push the etch block's txid root to `bitcoinRootsUsed` so the contract validates it as confirmed.
  - Guest: `contracts/sp1/confidential/src/main.rs` `OP_ATTEST_META` + the witness-stream fields (wtxid path +
    coinbase + coinbase txid path + etch block root).
  - Dapp/assembler: provide the new fields.

- [ ] **A3. `OP_UNWRAP` box witness serializer.**
  The guest is staged and the dapp emits `sigR/sigZ`; the box's unwrap witness serializer must emit
  `sigR(33) / sigZ(32)` in place of `blinding` (witness order: …value, recipient, fee, sigR, sigZ).

---

## B. Assembler chain — liveness (host code; gates burn-deposit + the witness gate)

- [ ] **B1. `reflect-stdin` + worker assembler for the new burn-deposit witness format.**
  The burn-deposit provenance witness now carries full tx bytes (+ wtxid path + coinbase + coinbase txid path)
  instead of a free txid plus separately-witnessed fields. Update `write_burn_deposit` + the JS mirror + the
  worker tracer to emit the new shape. Burn-deposit onboarding stays disabled until this lands.
  - `contracts/sp1/reflect-stdin/src/lib.rs` `write_burn_deposit`
  - `dapp/burn-deposit-assembler.js` (format documented there), `dapp/burn-deposit-tracer.js` (must fetch each
    provenance block's coinbase + wtxids), and `foldBurnDepositTx` in `dapp/confidential-pool.js`.
  - Verify via `reflect-exec` once the stream matches.
  - NOTE: general `reflect-stdin` field-discipline hardening is **landed** (path/r32 lengths, u32/u16 bounds,
    ethPv == 352, consumed-count delta assert, cbtcBackingSats string-or-number, farm-refund convention). This
    burn-deposit format change is the one remaining `reflect-stdin` edit.

- [x] **B2. Coinbase-commitment helper — reproducible template landed (`gen-reflection-cxfer-synth.mjs`).**
  The witness-commitment gate requires a real coinbase BIP141 commitment before any Taproot envelope folds.
  The cxfer-synth builder now prepends a valid coinbase + re-mines the header, and reflect-exec confirms
  `EXECUTE_OK` + `DIGEST_MATCH`. REMAINING: roll the same helper out to the other `gen-reflection-*-synth.mjs`
  builders (lp/swap/farm/bid/crossout/protofee/harvest/swapbatch/…) and the live indexer
  (`dapp/confidential-reflection-scan-indexer.js`) so the worker prepends the block's real coinbase + wtxids.

---

## C. swap_batch / Groth16 — before `T_SWAP_BATCH` is live-classified (box / pipeline)

- [ ] **C1. End-to-end snarkjs proof-vector KAT.**
  A real ceremony-zkey proof through `swap_batch_public_signals → groth16_bn254_verify → verify_xcurve`:
  verifies true; mutating each of the 123 public signals fails; mutating each proof point class fails; confirm
  the snarkjs G2 Fp2 limb order against the verifier. This is the documented remaining step for swap_batch;
  the component primitives + the aggregate identity are already KAT'd.

- [ ] **C2. G2 subgroup behaviour.**
  Confirm the SP1 `bn` crate's `AffineG2::new` (and `AffineG1::new`) reject non-prime-subgroup points for the
  adversarial proof elements (`proof.a/b/c`); if not, add explicit subgroup checks.
  - `contracts/sp1/confidential/src/groth16.rs`

---

## D. Hardening follow-ups (recommended; reviewed as sound today)

- [ ] **D1. Enumerable `bitcoinConsumedAt[index]` for eth-reflection consumed-ν.**
  Consumed-ν completeness is enforced today (the Bitcoin guest's `fold_consumed` requires a live source per
  entry), but the eth guest proves "these slots exist," not "these are all consumed slots up to the count."
  Add `mapping(uint64 => bytes32) bitcoinConsumedAt` written on each consume, and have the eth guest prove the
  index range `[prior_count, count)` — makes the eth guest self-contained rather than leaning on the cross-guest
  interaction. Pin the new slot in `scripts/verify-reflection-slots.sh`.
  - `contracts/src/ConfidentialPool.sol`, `contracts/sp1/eth-reflection/src/main.rs`

- [ ] **D2. Burn-deposit stream-synchronized-but-invalid KATs.**
  The DAG-level adversarial cases are covered; add full-stream cases (bad etch / bad cmint / non-conserving
  provenance / witness-commitment mismatch) — now runnable on the host via `reflect-exec`.

- [ ] **D3. Minor parser/arith ergonomics.**
  `solve_clearing` → `Option` (currently fail-closed via panic); the per-array caps the settle review suggested
  beyond `MAX_OPS` (e.g. nullifier/leaf/withdrawal counts).

---

## E. Operational

- [ ] **E1. `ConfidentialPool` codesize (EIP-170) + clean compile.**
  The cBTC/CDP additions pushed the contract over the size limit and it does not currently compile cleanly —
  which also blocks `scripts/verify-reflection-slots.sh` (needs `forge inspect`). Factor it back under limit
  before deploy. See `project_confidential_pool_codesize` for the size-fix approach (cut redundant getters that
  duplicate public mappings; `--skip test` / pre-cache the verifier to dodge the build OOM).

- [ ] **E2. Coordinated re-prove + re-pin.**
  One box step bundles every guest change above (the A-items, plus the witness commitments / swap_batch /
  strict-append / mode_b / eth-reflection guards already landed in source): rebuild the canonical ELF on the
  box (never a native rebuild — ELF drift → ProofInvalid), derive the vkey, re-pin
  `BITCOIN_RELAY_VKEY` / the settle vkey. See `scripts/confidential-reprove-apply.sh`.

- [ ] **E3. Reclaim disk.** Local `/private/tmp` / build targets near full; intermittently breaks tooling.

---

## F. Process / CI

- [ ] **F1. Make `reflect-exec` parity a mandatory CI gate for every fixture / schema change.**
  `reflect-stdin` derives stream *writes* from JSON keys while the guest derives *reads* from tx parsing +
  state, so they only stay in lockstep if every fixture is executed against the guest. The base-order and
  width/count asserts are landed, but the per-tx conditional reads (openings == detected spends,
  `swapBatch.receiptPaths == n_intents`, output paths only when the envelope folds) can't be self-derived in
  the serializer — `reflect-exec` (`EXECUTE_OK` + `DIGEST_MATCH`) is the guard. It's a cheap **host** run (SP1
  execute mode, no box), so wire it into CI over the committed reflection fixtures + a freshly built ELF, and
  run it on any `reflect.rs` / `reflect-stdin` / builder change.

```
# build the reflection guest ELF (host)
cd contracts/sp1/confidential && cargo prove build --bin reflection-prover
# execute-validate against a fixture (host, no box): EXECUTE_OK + DIGEST_MATCH
cd ../reflect-exec && REFLECT_ELF=../confidential/target/elf-compilation/*/release/reflection-prover \
  cargo run --release --bin reflect-execute -- ../confidential/fixtures/reflection_input.json
# derive the guest vkey for the on-chain pin
cargo run --release --bin vkey-derive
# storage-slot interface guard (needs the contract to compile)
bash scripts/verify-reflection-slots.sh
```
