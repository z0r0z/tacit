# Authenticated generational-resume — box execute-mode fixtures

A successor generation resumes the SHARED Bitcoin reflection from a DRAINED predecessor without replaying
Bitcoin history. The reflection guest's FIRST cycle (`rebaseMode=1`, the head of the witness stream) reads the
predecessor's final attested state, drain-gates it against the witnessed on-chain counters, then REBASES:

- PRESERVES every global accumulator — note tree, spent set, bridge-burn set, consumed-outpoint gate,
  consumed-cross-out replay gate, pools, cBTC backing, farms, height.
- RESETS only the generation-local liveness fields — `consumed_count → 0`, `folded_crossout_count → 0`,
  `eth_refl_digest → [0;32]` (the "no Mode-B yet" sentinel, so the successor's first Mode-B cycle re-derives
  the eth genesis for its OWN address).

The successor genesis digest it lands on is what the deploy pins as `reflectionResumeDigest_`; the contract
binds the whole rebase to the predecessor's exposed getters (`attestedReflectionDigest` /
`attestedBitcoinConsumedCount` / `attestedCrossOutCount`) via `rebasedFromDigest`.

Generator: `tests/gen-h02-migration-fixtures.mjs` (writes all three). It seeds a NON-EMPTY predecessor via the
resumable global setters — a C0-backed pool (all `PoolReserveState` fields), a live cBTC.zk lock (654321 sats
backing), and nonzero `consumed_count`/`folded_crossout_count`/`eth_refl_digest` — so preservation-vs-reset is
genuinely exercised. The assembler mirrors the rebase (`dapp/confidential-pool.js`: `ScanReflection.rebase`
mirror + `generationalRebaseAnchor` + `assembleReflectionScanInput({ rebase })`), so the JS `newDigest` equals
the guest's on a correct rebase — that is what makes the positive fixture DIGEST_MATCH.

## Witness-stream shape (reflect-stdin ↔ guest)
`rebaseMode` (u32) is written FIRST (ahead of `read_scan_prior_state`). The prior block is the predecessor's
final state. On a rebase cycle two drained counters — `predecessorConsumedCount`, `predecessorCrossOutCount`
(the predecessor's CURRENT on-chain `bitcoinConsumedCount` / `crossOutCount`) — are written AFTER the prior
block and BEFORE the Mode-B gate, matching `reflect.rs` read order. The guest asserts they equal the prior
state's folded counts (drain gate), rebases, and commits `rebasedFromDigest = keccak(predecessorDigest ‖
consumedCount_be32 ‖ crossOutCount_be32)` = the value the contract re-derives from the predecessor's getters.

## Fixtures

| Fixture | Scenario | rebaseMode | Expected execute outcome |
|---|---|---|---|
| `positive.json` | drained predecessor: nonzero generation-local fields + nonzero preserved globals (pool, cBTC backing + live lock) | 1 | **DIGEST_MATCH** — the guest rebases (locals → 0, `eth_refl_digest`→[0;32], globals preserved), commits `priorDigest` == `reflectionResumeDigest` and the listed `newDigest`. `rebasedFromDigest` == keccak(predDigest ‖ 4 ‖ 3). |
| `undrained.json` | predecessor recorded a fast-lane consume its reflection has NOT folded: witnessed on-chain `consumed=6` ≠ folded `consumed_count=4` | 1 | **guest ABORT** — the in-guest drain assertion (`predecessor not drained: unfolded fast-lane consumes`) rejects. Must NOT DIGEST_MATCH. |
| `mismatch.json` | valid rebase, but with tampered contract-side expectations (`tamperedRebasedFromDigest`, `tamperedResumeDigest`) | 1 | **CONTRACT REJECT** — the guest runs and commits normally; the box asserts the guest's real `rebasedFromDigest` ≠ `tamperedRebasedFromDigest` and its `priorDigest` ≠ `tamperedResumeDigest`, i.e. the contract's `rebasedFromDigest` gate and `priorDigest == knownReflectionDigest` gate reject a fabricated resume. |

## Key digests (from the generator; regenerate to confirm)
- `positive.json`: `predDigest 0xa3336cb2…`, `resumeDigest 0x12f47edb…` (successor genesis, the pin),
  `rebasedFromDigest 0xb3a5bc8b…`, `newDigest 0x7cf72b0b…`. `predDigest != resumeDigest` (reset happened) and an
  independent state carrying the SAME globals with zeroed locals hashes to `resumeDigest` (preservation).

## Contract-side (Solidity attest, not reflect-exec)
The migration attest gate lives in `ConfidentialPool.attestBitcoinStateProven`: on the FIRST attest of a pool
deployed with `predecessor_ != 0`, it requires `r.rebasedFromDigest == keccak256(abi.encodePacked(
predecessor.attestedReflectionDigest(), predecessor.attestedBitcoinConsumedCount(),
predecessor.attestedCrossOutCount()))` and then the existing `r.priorDigest == knownReflectionDigest` (pinned to
`reflectionResumeDigest_`). `mismatch.json` models both rejections. Every non-migration proof must carry a zero
`rebasedFromDigest` (a genesis deploy — `predecessor_ == 0` — never accepts one; V3's path is unchanged).

## What was NOT run locally
Disk-constrained: only `node --check` + generation were run here. The reflect-exec execute-gate (guest ELF) and
the Solidity attest revert-tests are run on the box against the staged ELF.
