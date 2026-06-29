# Maintainer response — GPT greenlight audit, round 19 (bundle @ `53ed18d`)

Nineteenth pass — the cleanest yet. The auditor confirmed **no regression and no incomplete fix** in the three
round-18 prover-supplied-witness fixes (duplicate-claimId brick, cross-out membership/non-membership, and
witness-bound burn-deposit provenance), and **no new fund-impacting issue** in the whole-system sweep. The lone
"Critical" is explicitly *needs-confirmation* and is the documented mainnet re-anchor, not a code defect; two
Low hardenings were taken.

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| 1 | Mode-B eth-reflection pinned to the Sepolia rehearsal anchor | Critical *iff* mainnet | **Not a code defect — deploy-time re-anchor** | Confirmed (rehearsal); closed by the production re-anchor |
| 2 | Stale comments describe the cross-out set as an append-tree | Low | **Real** | **Fixed** |
| 3 | eth public-values length check allows trailing bytes | Low | **Real** | **Fixed** |

## #1 — Sepolia anchor — confirmed rehearsal; closed by the deploy re-anchor (not a code change)

The eth-reflection guest pins `ETH_GENESIS_SYNC_COMMITTEE` / `ETH_GENESIS_SLOT` to the **Sepolia rehearsal**
weak-subjectivity anchor (the constants are commented as such, "re-anchor for production"). The auditor's
question — "if this locks for mainnet, Mode-B proves Sepolia" — is answered by the vkey binding the auditor did
not connect: the chain is bound NOT by a Solidity chain-id check but by the **immutable `ETH_REFLECTION_VKEY`**
the pool pins in its constructor. The eth-reflection vkey is a function of the guest program *including* its
genesis anchor, so a Sepolia-anchored proof simply does not verify under a mainnet-anchored vkey
(`SP1_VERIFIER.verifyProof(BITCOIN_RELAY_VKEY, …)` → the inner `verify_sp1_proof(&ETH_REFLECTION_VKEY, …)`
fails). The production lock therefore re-anchors `ETH_GENESIS_*` to mainnet, re-proves the eth-reflection guest,
and pins the resulting **mainnet** `ETH_REFLECTION_VKEY` — a step already tracked in the deploy gates alongside
the mainnet Bitcoin genesis anchor. The current commit is the Sepolia-valued **rehearsal** tree (the v1
rehearsal is on Sepolia), so this is correct for it and not a defect; for the mainnet lock it is the standing
re-anchor. (Defense-in-depth worth adding *at* the re-anchor: a `mainnet` build profile that const-asserts the
genesis anchor is not the rehearsal sentinel, so a mainnet build can't ship Sepolia constants by mistake.)

The freshness gate the auditor cites (`r.crossOutCount == crossOutCount`) is exactly the consumed-ν "current"
gate generalized to cross-outs; once the production vkey is pinned, an honest mainnet Mode-B proof reads the
mainnet pool's counters and passes — there is no stall under the correct (mainnet) vkey.

## #2 — stale cross-out comments — FIXED

The cross-out set comments in `eth-reflection/src/main.rs` and `cxfer-core/src/eth_reflection.rs` still
described `crossOutSetRoot` as an append-only `KeccakTreeAccumulator`. Updated to state the present behavior:
an **indexed-Merkle-tree root keyed by the `EthCrossOut` leaf** (membership/non-membership target), the
consumed-ν set remaining a separate keccak append set. (Also removed the lingering change-history phrasing in
those comments.)

## #3 — eth public-values exact length — FIXED

The Bitcoin guest read the recursive `eth_pv` with `len() >= 11 * 32`. `EthReflectionPublicValues` is exactly
11 static ABI words, so this is now `len() == 11 * 32` — no trailing bytes (or a future appended field) can be
silently ignored by the by-offset reads.

## Round-18 fixes — re-confirmed by the auditor (no regression)
- Duplicate-claimId brick: the settle guest's distinct-destination check holds; multi-burn/multi-batch reuse
  requires reusing a nullifier, which `_settle` marks before appending cross-outs (reverts first).
- Cross-out membership/non-membership: the four IMT cases (present+membership fold, present+non-membership
  abort, absent+non-membership skip, absent+membership abort) and the full-range `crossOutAt` completeness all
  hold under the IMT root + the `r.crossOutCount` gate.
- Burn-deposit provenance: read from the burn tx's wtxid-authenticated witness; a mutated DAG fails the witness
  commitment; the `ProvenanceBlob` parser is bounded + exact-consumption.

## Verification
cxfer-core 155/155; all three guests build; the pool is unchanged (no contract change this round, stays
24,566 / +10 under EIP-170).

## Net
The three round-18 fund-impacting fixes are confirmed complete and not regressed; this is the first pass with
no new fund-impacting *code* finding. The remaining gate to a mainnet lock is operational — the documented
`ETH_GENESIS_*` / `ETH_REFLECTION_VKEY` re-anchor (the immutable vkey binds the chain) — plus the worker (JS)
DIGEST-mirror migration for the cross-out IMT + burn-deposit witness. A further confirmatory round on the
mainnet-re-anchored tree (or on the JS-mirror-complete tree) is the path to lock.
