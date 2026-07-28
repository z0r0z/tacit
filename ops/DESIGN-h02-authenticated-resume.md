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
A first-cycle rebase: given the predecessor's final attested digest as prior, produce a successor-genesis digest
that
- PRESERVES the global Bitcoin accumulators: note root, spent-set IMT, burn set, consumed-outpoints IMT, pools,
  cBTC backing;
- RESETS the generation-local fields: `consumed_count → 0`, `folded_crossout_count → 0`,
  `eth_refl_digest → eth_genesis(successor_address)`;
- commits the successor genesis digest, which the constructor pins.
Drain-gated so the reset is sound. This is the piece to implement carefully with its own fixtures + re-audit.

## Files
- `contracts/src/ConfidentialPool.sol` — getters (part 1); constructor `predecessor` param + drain-gate + counter
  seeding + resume-digest pin (part 2).
- `contracts/sp1/confidential/src/reflect.rs` + `cxfer-core` — the generational-rebase first cycle (part 3);
  the digest/eth_refl_digest reset. Rotates the reflection `bitcoin_relay_vkey`.
- Assembler (`dapp/confidential-pool.js`) — mirror the rebase in the JS reflection assembler.
- Emitter/worker — supply the predecessor address + the rebase witness at a generational deploy.

## Fixtures / verification
- A reflect-exec fixture: resume from a NON-EMPTY predecessor state (nonzero counters + a burn) → the rebase
  produces a successor genesis with zeroed generation-local fields + preserved global accumulators; the
  successor's first attest passes with its seeded (zero) counters.
- Negative: an un-drained predecessor (pending consume/burn) → rebase/construction rejected.
- Negative: a fabricated resume not matching the predecessor's exposed digest → rejected.

## Scope / sequencing
Folds into the held reprove (guest rotation) + the V3 redeploy. Re-audit the rebase seam specifically. Not
launch-blocking for V3 (dormant), so it can land in the same reprove cycle as C-01 without gating the launch.
