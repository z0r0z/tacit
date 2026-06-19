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

- [x] **A1. Opening sigmas for `OP_WRAP` / `OP_CDP_MINT` / `OP_CDP_CLOSE` / `OP_CBTC_MINT`.**
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

- [x] **A2. `OP_ATTEST_META` witness authentication.**
  The op derives the asset id from the etch txid and parses ticker/decimals/cid from the etch tx WITNESS, but
  proves only note-membership — the metadata envelope itself is not block-committed (wrong decimals would
  mis-set `unitScale`). Bind it with `bitcoin::verify_tx_witness_committed` (helper already in cxfer-core), and
  push the etch block's txid root to `bitcoinRootsUsed` so the contract validates it as confirmed.
  - Guest: `contracts/sp1/confidential/src/main.rs` `OP_ATTEST_META` + the witness-stream fields (wtxid path +
    coinbase + coinbase txid path + etch block root).
  - Dapp/assembler: provide the new fields.

- [x] **A3. `OP_UNWRAP` box witness serializer.**
  The guest is staged and the dapp emits `sigR/sigZ`; the box's unwrap witness serializer must emit
  `sigR(33) / sigZ(32)` in place of `blinding` (witness order: …value, recipient, fee, sigR, sigZ).

---

## B. Assembler chain — liveness (host code; gates burn-deposit + the witness gate)

- [x] **B1. `reflect-stdin` + worker assembler for the new burn-deposit witness format.**
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

- [x] **C1. End-to-end snarkjs proof-vector KAT.**
  A real ceremony-zkey proof through `swap_batch_public_signals → groth16_bn254_verify → verify_xcurve`:
  verifies true; mutating each of the 123 public signals fails; mutating each proof point class fails; confirm
  the snarkjs G2 Fp2 limb order against the verifier. This is the documented remaining step for swap_batch;
  the component primitives + the aggregate identity are already KAT'd.
  - Ceremony artifact FOUND + CID-verified: final `amm_swap_batch` zkey CID
    `bafybeieb5hafaix2xwvnmsodby4vkvcpdv4bpt4ny3etza4lpy2rxefwqm`, SHA-256
    `6ed30983a1c2faf287f3d2fc95fae08cc926aa563b2df2dc752c01f46ee03031`. Exporting its VK is byte-identical
    to canonical VK CID `bafkreidc35fn7w3pxa4u7phjulzgrgm3js5ifmgqil7liedkqb2bdgdtp4`; the local R1CS
    SHA-256 is the pinned `2d9db81d…495f4`.
  - `tests/gen-swapbatch-prove.mjs` now full-proves with that zkey and checks: exact 123-signal derivation,
    valid proof, native snarkjs G2 `[c0,c1]` round-trip, every one of the 123 public-signal mutations rejects,
    and mutations of proof classes A/B/C reject. All pass.
  - The real vector also passed the Rust in-guest `groth16_bn254_verify` with `Fq2::new(c0,c1)` (execution
    proceeded to the later aggregate gate), confirming the verifier's G2 limb order. That run exposed and
    fixed two integration bugs: the synth lacked a BIP141 coinbase witness commitment, and the guest discarded
    `r_tip_A/B` while the worker aggregate includes the bound tip commitments.
  - Full assembled-fold box KAT PASSED on the isolated Vast.ai workspace
    `/root/work/swapbatch-kat`: fixture SHA-256
    `8c420d42a6923b7c4e2ffd43f4b9163e5eb37c91788fe9123b3ddc8420238cb3`,
    `EXECUTE_OK cycles=5358273975`, and
    `DIGEST_MATCH` at `0x658cad1f0e9de708804da9abcf3eea1cf7163f6f2543442fda4351dcfb3e2def`.
    This exercises the real ceremony proof through the Rust
    `swap_batch_public_signals → groth16_bn254_verify → aggregate/tip-opening → verify_xcurve → receipt fold`
    path.

- [x] **C2. G2 subgroup behaviour.**
  Confirm the SP1 `bn` crate's `AffineG2::new` (and `AffineG1::new`) reject non-prime-subgroup points for the
  adversarial proof elements (`proof.a/b/c`); if not, add explicit subgroup checks.
  - `contracts/sp1/confidential/src/groth16.rs`
  - Confirmed against pinned `substrate-bn-succinct-rs 0.6.0`: `G2Params::check_order() = true`, so the
    checked `AffineG2::new` returns `NotInSubgroup`; BN254 G1 has cofactor 1.

---

## D. Hardening follow-ups (recommended; reviewed as sound today)

- [x] **D1. Enumerable `bitcoinConsumedAt[index]` for eth-reflection consumed-ν.**
  Consumed-ν completeness is enforced today (the Bitcoin guest's `fold_consumed` requires a live source per
  entry), but the eth guest proves "these slots exist," not "these are all consumed slots up to the count."
  Add `mapping(uint64 => bytes32) bitcoinConsumedAt` written on each consume, and have the eth guest prove the
  index range `[prior_count, count)` — makes the eth guest self-contained rather than leaning on the cross-guest
  interaction. Pin the new slot in `scripts/verify-reflection-slots.sh`.
  - `contracts/src/ConfidentialPool.sol`, `contracts/sp1/eth-reflection/src/main.rs`

- [x] **D2. Burn-deposit stream-synchronized-but-invalid KATs.**
  The DAG-level adversarial cases are covered; add full-stream cases (bad etch / bad cmint / non-conserving
  provenance / witness-commitment mismatch) — now runnable on the host via `reflect-exec`.
  - Landed in `tests/reflection-burn-deposit-stream-kat.sh` and the mandatory parity workflow.

- [x] **D3. Minor parser/arith ergonomics.**
  `solve_clearing` → `Option` (currently fail-closed via panic); the per-array caps the settle review suggested
  beyond `MAX_OPS` (e.g. nullifier/leaf/withdrawal counts).

---

## E. Operational

- [x] **E1. `ConfidentialPool` codesize (EIP-170) + clean compile.**
  Runtime is back under the 24,576-byte deploy cap without splitting the public AMM/router surface:
  `forge inspect src/ConfidentialPool.sol:ConfidentialPool deployedBytecode` measures **24,320 bytes**.
  `forge build` compiles cleanly. Main cuts: shared Merkle tree insertion helper, compact asset metadata
  storage with a compatibility `assets()` getter, trimmed immutable/diagnostic getters, removed duplicate
  public periphery events, low-run optimizer/no-CBOR config, and exact-packed assembly for the LP-share id and
  shared asset-id SHA-256 precompile call. Integration-critical getters remain, including `cbtcMinted()` for
  `CollateralEngine`.

- [x] **E2. Coordinated Sepolia/pilot re-prove + re-pin.**
  Completed on the Vast prover box from the synced current source, then applied as one local pin/fixture
  update. Canonical ELFs:
  - Settle `cxfer-guest`: `PROGRAM_VKEY = 0x005c8a3dc76fdb1df8540736b73d893e5cff55c403442ef0f01a945a41775406`,
    sha256 `4438a10b67f4c878a6144dcfa8976e30393cb32d59815db43d27705f518ce97c`, 859,024 bytes.
  - Reflection `reflection-prover`: `BITCOIN_RELAY_VKEY = 0x0032a552d82143745ed675a217822187e15118060dcea1514589ce47c2ec3c02`,
    sha256 `36224f90d603510d464ba3bfbfbee641ea96e13d6d1fa254a9aa509b044d32a5`, 1,016,856 bytes
    after the follow-up burn-envelope hardening rotation (multi-live-spend / mismatched-ν burns are
    skip-not-panic and read no burn-deposit witnesses).
  - Regenerated and locally verified real Groth16 fixtures for transfer, swap, LP, OTC, BID, crosslane,
    reflection, and reflection burn-deposit. `scripts/confidential-reprove-apply.sh` now matches the current
    artifact layout and includes the burn-deposit fixture.
  - Live Sepolia/signet pilot status: source-side wrap + bridge-burn + signet `0x65` reveal succeeded on the
    pre-fix pilot pool, and the Sepolia relay was advanced to signet height 309,525. Because the BIP141/Mode-B
    fix deliberately rotated `BITCOIN_RELAY_VKEY`, final attest/bridge-mint/fast-lane validation must be
    repeated against a freshly deployed pool that uses the pinned vkey above.
  - Pilot harnesses preserved: CI now runs the Mode-B indexer regression for non-member `0x65` skip witnesses,
    and `scripts/advance-relay-raw.mjs` is the cast-free relay-advance fallback used when local Foundry RPC
    transport setup is flaky.
  - Scope note: this clears the Sepolia/pilot E2 hardening item. The mainnet re-anchor/re-prove remains a
    separate network-specific checklist (`ops/CHECKLIST-mainnet-reprove.md`).

---

## F. Process / CI

- [x] **F1. Make `reflect-exec` parity a mandatory CI gate for every fixture / schema change.**
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
