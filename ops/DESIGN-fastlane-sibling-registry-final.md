# Fast-lane cross-generation guard — sibling registry + same-block storage proofs

**Supersedes** `DESIGN-cross-gen-bitcoin-homed-replay-guard.md` and `DESIGN-fastlane-optimistic-finality.md`.
Both prior drafts traded away something real (a pending-state UX delay, or a fixed/incomplete
predecessor list). This is the version that keeps fast-lane instant AND closes the gap with code,
not memory or waiting. Read this one; the other two are kept only as the record of how we got here.

## The mechanism

1. **`SiblingRegistry`** — one small, standalone, immutable contract, deployed once, shared by every
   generation from gen1 forward:
   ```solidity
   contract SiblingRegistry {
       address[] public siblings;
       mapping(address => bool) public isRegistered;

       event SiblingRegistered(address indexed pool, uint256 index);

       /// @notice Permissionless. Registers `pool` iff it has ever emitted BitcoinNotesConsumed or
       ///         CrossOutRecorded — i.e., iff it has ever actually written to a bitcoinConsumed-style
       ///         mapping, which is the only case a sibling check ever needs to cover. Verified via a
       ///         log-existence check is NOT possible in pure EVM (logs aren't queryable on-chain), so
       ///         registration instead requires the caller to supply a block + tx inclusion proof of
       ///         one such event from `pool` — same MPT-proof primitive as the sibling check itself,
       ///         reused, not a second new mechanism. See "open question" below for the alternative.
       function register(address pool, /* event-inclusion proof */ bytes calldata proof) external {
           require(!isRegistered[pool]);
           _verifyEventInclusion(pool, proof); // reverts if pool never emitted the qualifying event
           isRegistered[pool] = true;
           siblings.push(pool);
           emit SiblingRegistered(pool, siblings.length - 1);
       }

       function count() external view returns (uint256) { return siblings.length; }
   }
   ```

2. **`ConfidentialPool`'s fast-lane path** (`_settle`, at `bitcoinConsumed[nu] = ...`, `:1897`)
   requires, in the same call, a storage-exclusion proof against a recent `blockhash()` for
   `bitcoinConsumed[nu]` on **every address `SiblingRegistry` currently lists**:
   ```solidity
   function _requireNoSiblingConsumed(bytes32 nu, SiblingProof[] calldata proofs) internal view {
       uint256 n = SIBLING_REGISTRY.count();
       require(proofs.length == n, "must cover every registered sibling");
       for (uint256 i; i < n; ++i) {
           address sib = SIBLING_REGISTRY.siblings(i);
           require(proofs[i].pool == sib, "wrong sibling order"); // deterministic order = siblings() order
           require(
               _verifyStorageExclusion(sib, _bitcoinConsumedSlot(nu), blockhash(proofs[i].blockNum), proofs[i].mpt),
               "sibling already consumed this nu"
           );
       }
   }
   ```
   `SIBLING_REGISTRY` is a normal immutable constructor arg on `ConfidentialPool` — a plain `address`,
   not a `address[]`, so **this does not touch the existing 12-argument layout's ordering or count in
   a way that breaks the arity check** — it slots in as arg 13, and `DeployV1SuiteCreateX.s.sol`'s
   `poolArgs.length == 12*32` guard needs updating to `13*32` in the same commit, deliberately, not
   silently.

## Properties, stated precisely, not oversold

- **Instant.** No pending state, no window, no wait. Same transaction, same block, exactly like
  today's fast lane.
- **Complete by construction, not by memory.** The contract itself refuses a fast-lane spend that
  doesn't cover every currently-registered sibling — `proofs.length == n` is checked in Solidity, not
  hoped for by an off-chain assembler. A missed sibling is a revert, not a silent gap.
- **No fixed list baked into immutable bytecode.** `SiblingRegistry` grows after gen1 deploys — a
  sibling discovered next year still gets covered, because the check reads the registry's *current*
  count at call time, not a constructor-time snapshot.
- **Griefing-bounded, not griefing-free.** Anyone can register a real (qualifying) address — this
  only makes future proofs more numerous, never blocks a legitimate spend and never fabricates a false
  "already consumed," since the check is `!consumed`, and a spurious registrant that never consumed
  anything trivially produces a valid exclusion proof. Worst case: linearly more gas per fast-lane
  transaction as more generations accumulate. Real cost, not a vulnerability — needs a gas number
  before shipping, not an assumption.
- **`SiblingRegistry` deploys once, referenced forever.** gen2, gen3, ... all point at the SAME
  registry instance (a genuinely permanent piece of shared infrastructure, unlike a per-generation
  predecessor list) — register once, protected everywhere, forever.

## Open question — registration proof, not yet resolved

`register()`'s event-inclusion proof is real cryptography (a transaction-receipt MPT proof, a
different proof shape than the storage-exclusion proof used for the actual sibling check) — this is
additional, distinct verifier logic, not a reuse of the same code path. **Simpler alternative worth
weighing before building the harder version:** skip cryptographic registration entirely and make
`register()` take no proof at all, just `require(pool.code.length > 0)` — since a spuriously
registered address can't hurt correctness (per the griefing-bounded property above), the ONLY reason
to gate registration cryptographically is to bound gas growth from spam registrations, which a small
registration fee (refundable, or simply nominal) achieves far more cheaply than a second MPT verifier.
**Recommend the simple version** (any contract address, small anti-spam fee) unless a concrete spam
scenario makes that insufficient — do not build the harder cryptographic version speculatively.

## What has to happen before this ships (real scope, not hand-waved)

1. Pick and integrate an audited Solidity MPT verifier (storage-exclusion proofs) — the one genuinely
   new cryptographic dependency in this whole design. Do not hand-roll it.
2. `SiblingRegistry.sol` — small enough to audit completely in isolation; write it first, alone.
3. `ConfidentialPool.sol`: add `SIBLING_REGISTRY` as constructor arg 13, wire `_requireNoSiblingConsumed`
   into `_settle`'s fast-lane path, add `SiblingProof[]` to the calldata a fast-lane settle needs to
   supply (assembler-side change: `dapp/confidential-pool.js` or wherever settle calldata is built).
4. `DeployV1SuiteCreateX.s.sol`: deploy `SiblingRegistry` first, thread its address into `ConfidentialPool`'s
   constructor call, update the `13*32` arity guard.
5. Gas measurement at 0, 1, 5 registered siblings — decide if a per-batch nullifier count practically
   caps how large this can grow before it needs a cheaper aggregate proof (e.g., proving a single
   Merkle root over N siblings' states instead of N separate proofs — a real future optimization, not
   needed for gen1 with a small sibling count).
6. Test: two pools sharing one `SiblingRegistry`, same ν fast-laned on both — second one must revert,
   in the same block, no waiting, no pending state.

## Status

This is the design to build from. Real, bounded, complete scope — a small registry contract, one MPT
verifier integration, one new constructor arg, one new calldata field, one gas measurement, one test.
Not a research project. Build order: registry alone first (smallest, most auditable), then the pool
wiring, then the deploy script, then the test that actually proves the fix, then reprove/re-gate
exactly like everything else fixed tonight.
