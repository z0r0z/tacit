# Authenticated generational resume (H-02)

Implementation-ready spec. Build-heavy (rotates the reflection guest) — hold until disk is freed. Dormant at
the V3 launch (predecessor V2 is provably empty: `nextLeafIndex=0`, zero counters, empty burn set), so V3 is
sound today; this mechanism makes any *future* generation that resumes a non-empty predecessor safe.

## Problem (verified against code)
- Constructor sets `knownReflectionDigest = reflectionResumeDigest_` (arbitrary caller-supplied) and the
  generation-local counters `bitcoinConsumedCount` / `crossOutCount` default to 0 (ConfidentialPool.sol:416,494).
- A resumed digest commits the predecessor's NONZERO `consumed_count` / `folded_crossout_count` and an
  ADDRESS-BOUND `eth_refl_digest` (keccak over the 20-byte pool address).
- The attest gate `if (r.consumedCount != bitcoinConsumedCount) revert ConsumedCountStale()`
  (ConfidentialPool.sol:1704) reverts (successor 0 ≠ resumed nonzero); the successor can't continue the
  predecessor-address-bound Mode-B digest; and the resume is unauthenticated (an operator could hand a
  fabricated self-consistent state that omits pending burns/consumes).

## Key constraint
`knownReflectionDigest` and the counters are `internal` (ConfidentialPool.sol:328,416,494) — NOT readable from a
deployed predecessor. So a successor cannot authenticate by reading its predecessor's on-chain attested state
unless the predecessor exposes it. V2 has no getter → V2→V3 can't be authenticated by reading V2; safe only
because V2 is empty. Fix exposes the state in THIS generation so future successors can authenticate against it.

## Design — three parts

### 1. Expose the attested reflection state (contract, small)
Add public getters (or make public) for `knownReflectionDigest`, `bitcoinConsumedCount`, `crossOutCount` (and
whatever the rebase must pin — the eth-set roots the digest commits). Lets any future successor read this
generation's real attested state as the authentication anchor. No logic change; view-only.

### 2. Authenticated-resume constructor path (contract, moderate)
Constructor optionally takes a `predecessor` address. If nonzero:
- Read `predecessor.knownReflectionDigest()` + counters (via the getters from part 1).
- Require the resume to be a PROVEN rebase of that predecessor state (see part 3) — not an arbitrary digest.
- Drain-gate: require the predecessor is drained (escrow zero, no pending burns/consumes/cross-outs — check its
  exposed counters + backing) so the reset in part 3 drops nothing.
- Seed the successor's `bitcoinConsumedCount` / `crossOutCount` to the REBASED (zero) values so attestation
  passes from its own genesis.
If `predecessor == 0` (genesis) or the predecessor is provably empty, the current path stands.

### 3. Generational rebase in the reflection guest (the subtle part)
A first-cycle rebase: given the predecessor's final attested state as prior, produce a successor-genesis digest
that
- PRESERVES the global Bitcoin accumulators: note root, spent-set IMT, burn set, consumed-outpoints IMT,
  consumed-cross-out replay IMT, pools, cBTC backing, farms, height;
- RESETS the generation-local liveness fields: `consumed_count → 0`, `folded_crossout_count → 0`,
  `eth_refl_digest → [0;32]`;
- commits the successor genesis digest, which the constructor pins.
Drain-gated so the reset is sound. This is the piece to implement carefully with its own fixtures + re-audit.

## As-built mechanism (supersedes the sketch above where they differ)
The spec's "constructor verifies the rebase" is not literally possible — the predecessor's exposed digest is a
keccak hash, so the constructor cannot invert it to recompute the rebased successor genesis. Verification is
therefore a MIGRATION PROOF (the guest's first cycle), authenticated on-chain. Concretely:

- **Rebase reset target.** `eth_refl_digest → [0;32]` (the "no Mode-B yet" sentinel), NOT
  `eth_genesis(successor_address)`. The existing `state.eth_refl_digest == [0;32]` branch in the Mode-B gate
  re-derives `eth_refl_genesis_digest(successor_address)` on the successor's FIRST Mode-B cycle, so the eth
  accumulator binds to the new pool address by reusing proven logic. `cxfer_core::ScanReflection::rebase()`
  performs exactly the three resets; everything else is preserved (mirrored in `dapp/confidential-pool.js`
  `rebase()`).

- **Both replay roots are PRESERVED** (`consumed_crossout_root`/count and `consumed_outpoints_root`/count) —
  strictly safer, so an already-minted cross-out claim or an already-fast-consumed outpoint can never replay
  across a generation boundary.

- **One new public value: `rebasedFromDigest`** — appended LAST to `BitcoinReflectionPublicValues` (guest) and
  `BitcoinRelayPublicValues` (contract). Zero on every non-migration cycle. On the migration cycle it is
  `generational_rebase_anchor(predecessorDigest, consumedCount, crossOutCount) =
  keccak(predDigest ‖ consumed_be32 ‖ crossout_be32)`. The struct is decoded only by
  `attestBitcoinStateProven` (never the router), so the append shifts no other consumer's offset.

- **Drain gate is IN-GUEST against witnessed on-chain counters.** The guest reads the predecessor's CURRENT
  on-chain `bitcoinConsumedCount` / `crossOutCount` (written by `reflect-stdin` right after the prior block,
  before the Mode-B gate) and asserts `state.consumed_count == oc_consumed` and
  `state.folded_crossout_count == oc_crossout`. The prior state (hence its folded counts) is bound by
  `predecessorDigest`, and the SAME anchor binds the witnessed counters to the predecessor's exposed getters,
  so a lying counter fails the contract's re-derivation. If a consume/cross-out was recorded but not folded
  (un-drained), the assertion rejects — the reset can never abandon an unfolded consume (source note live AND
  already value-spent on Ethereum) or a pending cross-out mint. The BRIDGE-BURN set is PRESERVED across the
  rebase, so an outstanding bridge-out stays mintable in the successor and needs NO drain assertion.

- **Escrow drain is an OPERATIONAL precondition, not an on-chain gate.** A reflection rebase does not move
  escrow (it stays in the predecessor contract), and the constructor cannot enumerate per-asset `escrow`. The
  predecessor MUST be quiesced (no further attests / fast-lane activity, escrow settled) before the successor is
  deployed — the successor's `reflectionResumeDigest_` is computed against a specific predecessor state, so a
  later predecessor attest just makes the migration re-derivation move and the operator re-proves (fail-closed).

- **Contract attest gate.** On the FIRST attest of a pool with `predecessor_ != 0`
  (`!generationalRebaseSettled`): require `r.rebasedFromDigest == keccak256(abi.encodePacked(
  predecessor.attestedReflectionDigest(), predecessor.attestedBitcoinConsumedCount(),
  predecessor.attestedCrossOutCount()))` (live reads), then the existing `r.priorDigest == knownReflectionDigest`
  forces the rebased successor genesis to equal the pinned `reflectionResumeDigest_`. Set the one-shot flag.
  Every other proof (and every `predecessor_ == 0` deploy, i.e. V3) must carry `rebasedFromDigest == 0`.

- **Constructor signature (final):** `ConfidentialPool(sp1Verifier_, programVKey_, bitcoinRelayVKey_,
  canonicalFactory_, headerRelay_, genesisReflectionAnchor_, reflectionConfirmations_, reflectionResumeDigest_,
  tethBitcoinLink_, collateralEngine_, predecessor_)` — `predecessor_` appended last. `predecessor_ != 0`
  requires it be a deployed contract, a non-zero relay vkey, and a non-zero `reflectionResumeDigest_`. The
  generation-local counters seed to their default 0 (the rebased values), so the first attest's
  `r.consumedCount == bitcoinConsumedCount` (0 == 0) passes.

- **New views (part 1):** `attestedReflectionDigest()`, `attestedBitcoinConsumedCount()`,
  `attestedCrossOutCount()` (cBTC backing is already the public `cbtcBackingSats`).

## Files
- `contracts/src/ConfidentialPool.sol` — the three getters (part 1); `IPredecessorPool` interface; constructor
  `predecessor_` param + `PREDECESSOR` immutable + `generationalRebaseSettled` one-shot; the migration attest
  gate; `rebasedFromDigest` in `BitcoinRelayPublicValues` (part 2).
- `contracts/sp1/confidential/cxfer-core/src/lib.rs` — `ScanReflection::rebase()` + `generational_rebase_anchor`.
- `contracts/sp1/confidential/src/reflect.rs` — the `rebaseMode` first-read, the drain gate, and
  `rebasedFromDigest` in the public values. Rotates the reflection `bitcoin_relay_vkey`.
- `contracts/sp1/reflect-stdin/src/lib.rs` — writes `rebaseMode` first + the two drained counters in read order.
- `dapp/confidential-pool.js` — `rebase()` mirror + `generationalRebaseAnchor` + `assembleReflectionScanInput({
  rebase })` (predecessor snapshot, post-rebase digests, surfaced `rebasedFromDigest` / `reflectionResumeDigest`).
- Emitter/worker — supply `predecessor_` + the rebase witness at a generational deploy.

## Fixtures / verification
`ops/box-artifacts/h02-migration-fixtures/` (generator `tests/gen-h02-migration-fixtures.mjs`):
- `positive.json` — resume from a NON-EMPTY drained predecessor (nonzero generation-local fields + a pool + cBTC
  backing + a live lock) → DIGEST_MATCH: zeroed generation-local fields, preserved globals, successor genesis ==
  the pinned resume digest.
- `undrained.json` — un-drained predecessor (witnessed on-chain consume count > folded count) → guest ABORT.
- `mismatch.json` — fabricated resume (tampered `rebasedFromDigest` / resume digest) → the contract's gates
  reject. (Contract-side, modeled for the Solidity attest revert-test.)

## Scope / sequencing
Folds into the held reprove (guest rotation) + the V3 redeploy. Re-audit the rebase seam specifically. Not
launch-blocking for V3 (dormant), so it can land in the same reprove cycle as C-01 without gating the launch.
