# DESIGN — Reverse-lane reflection freshness: correctness + liveness hardening

Status: DESIGN. Lets a fresh pool bootstrap Mode-B before any cross-out/consume has been recorded,
so a recorded cross-out/consume can actually be folded (advancing reflection) instead of being
un-foldable on a fresh pool. Companion to `DESIGN-mode-b-recursion.md`.

## Background
`attestBitcoinStateProven` advances all reflected roots (pool / burn / spent / cBTC / digest)
under two freshness checks tied to on-chain counters:
- `r.consumedCount == bitcoinConsumedCount` (ConfidentialPool.sol:1583)
- `r.crossOutCount == crossOutCount`         (ConfidentialPool.sol:1589)

Forward batches (mode_b=0) commit `crossOutCount = 0`/`consumedCount = 0`, so after the first
cross-out/consume only a Mode-B batch can satisfy the checks — which is CORRECT: both checks are
load-bearing and both are retained exactly.
- The `consumedCount ==` check is a completeness interlock: the block scan advances `bitcoinPoolRoot`
  unconditionally, while `fold_consumed` (which retires a consumed source UTXO, Ethereum-senior) runs
  only under Mode-B, so any batch scanning new Bitcoin blocks must carry the complete consume fold.
- The `crossOutCount ==` check forces a real Bitcoin `0x65` cross-out onto a Mode-B batch: in forward
  mode the `0x65` fold is a skip-not-panic no-op (zero cross-out set root), so if a forward batch could
  attest past a `0x65` block that cross-out mint would be stranded (unfoldable by a later batch that
  only scans newer blocks). The exact check prevents that (a forward batch cannot advance while
  `folded < on-chain crossOutCount`). Both checks stay `==`.

The ONLY real defect: on a fresh pool the counter storage slots are unwritten (value 0), which the
eth-reflection guest requires as inclusion-proven — so the FIRST Mode-B batch (which is exactly what a
recorded cross-out/consume forces) cannot be produced, and reflection cannot advance. That is the fix.
(Committing a folded count + relaxing the cross-out gate was evaluated and REJECTED: it is off-by-one
against the sentinel-seeded `consumed_crossout_count` and it re-opens the `0x65` skip-stranding above.)

## Changes

### B. Bootstrap Mode-B at counter value 0 via a verified absence proof
The eth-reflection guest reads the two counter slots as mandatory inclusion-proven
(eth-reflection/src/main.rs). A never-written slot is genuinely absent from the execution state trie,
so accept a Merkle ABSENCE proof for exactly the two counter keys, verified against the SAME
helios-finalized execution state root the inclusion proofs bind to, yielding value 0. This must prove
absence (not tolerate a failed proof). A monotone `++`-only counter can never be legitimately absent
once non-zero, so this cannot misstate a non-zero count. Lets the first Mode-B batch prove at count 0.

### F. Revive forward batches after a cross-out (two-count cross-out freshness)
Before: a forward batch commits `crossOutCount = 0`, so the gate `crossOutCount == ConfidentialPool.crossOutCount`
forces every attest to be Mode-B once any cross-out exists — a permanent cost on a two-way bridge (ETH→BTC is
half the traffic). The consumed side already avoids this (a forward batch carries `state.consumed_count`), but a
cross-out's `0x65` mint is Bitcoin-driven (folds only when the mint lands), so a single carried folded count,
gated `==`, would freeze Mode-B too across the burn→mint gap.

Fix — track a second count and gate the two batch modes differently:
- `ScanReflection.folded_crossout_count` (new): incremented in `fold_crossout` ONLY on a fresh, member mint
  (never a fake skip or a replay no-op); committed in `digest()` and read back on resume, so a forward batch
  can't forge being caught up.
- The guest commits it as `foldedCrossOutCount` (new public value) alongside the eth-set `crossOutCount`.
- The contract gate splits on mode: Mode-B (`ethPool == this`) stays gated `crossOutCount == crossOutCount`
  (eth-set freshness — keeps Mode-B live through the mint gap, when it does the folding); a forward batch
  (`ethPool == 0`) is gated `foldedCrossOutCount == crossOutCount` — it may advance only when no mint is pending
  an unfolded `0x65`, so its skip-not-panic scan can never drop a real mint.

This is NOT Change A: both freshness gates stay `==`; nothing is relaxed to `<=`. A forward batch is blocked
only across the gap and revives once the mint folds, instead of Mode-B forever. Regression:
ConfidentialForwardLaneFreshness.t.sol (forward blocked during the gap / revives when caught up / Mode-B live
during the gap / stale eth-set reverts). Touches the reflection guest → same `V_btc` rotation + reprove +
fixture regen + genesis-digest change as Change B (one release).

GENESIS DIGEST ROTATION: adding `folded_crossout_count` to `digest()` changes the reflection genesis digest to
`0xe9e59ecbb38bf720371372192107226058653493e3872ee5b289ea46ef8bd8c6` (was `0xddf164…a67c`). Reconciled in the
same edit at every pin: ConfidentialPool.REFLECTION_GENESIS_DIGEST (the deploy seed), the two cxfer-core KATs,
the ConfidentialPool.t.sol test constant, and tests/confidential-reflection-scan.mjs. Rust + JS genesis KATs
green (the JS digest limb was added in lockstep). A genesis-anchored deploy MUST use the new digest.

HEALED-ASSET NATIVE-ETH CHECK: the public-AMM ETH-coverage check read `_assets[assetId].underlying` raw, so a
healed asset queried by its shared id (no direct `_assets[shared]` entry) defaulted to `underlying == address(0)`
and was misclassified as native ETH → EthValueMismatch. Both sites (createPairAndAddLiquidityPublic, swapPublic)
now `_resolveAsset` before the underlying read — consistent with the wrap/_ingestPublic/getter F3 resolution.
Native ETH (registered directly under the tETH shared id) still resolves to itself, so its detection is
unchanged. Contract-only.

### C. Operational: submit attests via a private mempool
The exact `consumedCount` check (retained by design) means an attest can be invalidated by a consume
landing between the eth proof's finalized slot and the attest tx. Submit `attestBitcoinStateProven`
through a private mempool + monitor liveness, rather than weakening the check.

### D. farmEscrow reward-asset pin authorization (independent, contract-only)
`farmEscrow` (ConfidentialPool.sol:1486) pins `farmRewardAsset[controller]` on first call without
binding the caller. Bind the pin to the controller's own immutable `REWARD_ASSET` (read it from the
`FarmController` and require a match), and/or allow the pin to be cleared while `farmTreasury == 0`.

### E. Defense-in-depth (contract-only)
- Mirror `cdpPositionLeafInserted` with a lock-leaf duplicate guard on the lock-set append path.
- Advance `bitcoinConsumedCount` by the count of DISTINCT newly-written entries, not array length.
- Confirm `callId` uniqueness upstream of `BtcCallExecutor`.

## Release + validation
A/B touch the guests → new `ETH_REFLECTION_VKEY` → new `BITCOIN_RELAY_VKEY` → regenerate reflection +
eth-reflection fixtures → redeploy `ConfidentialPool`. C is operational. D/E are contract-only (same
redeploy, no reprove). One atomic release.

Validation: forge (forward batch advances with a pending cross-out; spent-root advance still requires
the complete consume fold; monotone cross-out gate rejects a rolled-back count; farmEscrow pin
requires the controller). Guest KAT (consume completeness preserved; count-0 absence path proves;
monotone). Live: fresh pool → forward bridge + cross-out + Mode-B round-trip, with an interleaved
cross-out from a second party, confirming forward reflection is not stalled.

## Post-audit resolution (2026-07-12)
Two external reviews of the fix. First review removed "Change A" (off-by-one against the sentinel-seeded
folded count + it re-opened the 0x65 skip-stranding) — Change A dropped; Change B alone is the fix; the
strict `==` gates stay. Second review of the corrected code:
- **crossOut fix materially correct** — closes the stale-subset / skipped-0x65 censorship class. The
  eth-reflection guest proves crossOutCount + contiguous crossOutAt[index] + matching commitment slots +
  complete folded count; the contract gates `r.crossOutCount == crossOutCount` (current).
- **farmEscrow squat fix good** — first-fund binds the reward asset to the controller's declared REWARD_ASSET.
- **Operational invariant (intended, documented):** once any crossOut is recorded, every subsequent
  attestation MUST be a Mode-B batch (a forward mode_b=0 batch commits crossOutCount 0 and can no longer
  satisfy the gate). This mirrors the consumed fast-lane (any consume forces Mode-B). Reflection relayers
  must run the eth-reflection recursion continuously once crossOuts exist. Documented at the gate comment
  (ConfidentialPool.sol crossOutCount gate). Not a freeze given Change B makes Mode-B runnable at cold-start.
- **F4 fixed (contract-only):** registerWrapped now rejects a second native-ETH registration when tETH
  occupies the native-ETH slot (TETH_BITCOIN_LINK != 0) — blocks a duplicate wrong-asset native-ETH.
- **F3 FIXED (contract-only, no reprove):** a HEALED/squatted canonical asset is registered under its local
  internal id (localAssetOf[sharedId]=internalId), but `wrap()`, the `assets()` getter, and `_ingestPublic`
  read `_assets[assetId]` RAW — so a wrap/query by the SHARED id (the id the router hands out + notes carry)
  found nothing and reverted NotRegistered. All three now resolve via `_resolveAsset` (identity for a
  directly-registered asset, so a no-op for launch-pinned assets). `wrap`'s depositId stays bound to the
  INPUT (shared) assetId — the id the note carries and the guest reproduces — so the deposit is consumable
  (no guest change needed). Regression: ConfidentialRegisterHeal.t.sol asserts a shared-id query of a healed
  asset resolves (registered + healed scale + pool-minted).
  The router side mirrors this: `ConfidentialRouter._poolAssetId` keys a canonical token (incl. a healed one)
  by its SHARED `ASSET_ID()`, never the `localAssetOf` value — a canonical asset's confidential notes carry
  the shared id (the bridge-mint guest commits the leaf under it), so wrapping under the local id would fork
  the confidential supply. Regression: ConfidentialRouterHealAssetId.t.sol. Native ETH / tETH keys by the
  pinned tETH shared id (the pool re-keys native ETH to TETH_BITCOIN_LINK at construction).
- **Manifests:** elf-vkey-pin.json + verify-vkey-pin.sh + both regenerated Groth16 fixtures agree and PASS.
  deployments/1.json + docs/DEPLOYMENTS.md are updated together WITH the new addresses at redeploy (updating
  vkeys before the new addresses would be more inconsistent, not less).

## Follow-up audit addendum (2026-07-13) — resolutions

A second external review addendum. Dispositions:
- A-01 (reflection can't recover from a >6-conf reorg of a matured reflected block): the standard Bitcoin
  6-confirmation finality assumption, not a code defect. Reflection anchors only to matured blocks and tolerates
  sub-window shallow reorgs; a >6-block mainnet reorg has never occurred and needs sustained >51%. REFLECTION_CONFIRMATIONS
  is a constructor param (≤144) if more margin is wanted. Accepted + documented.
- Mode-B mainnet anchor: VERIFIED the source constants ARE mainnet — reflect.rs ETH_GENESIS_SYNC_COMMITTEE ==
  0x684dc219… and eth-reflection ETH_GENESIS_VALIDATORS_ROOT == 0x4b363db9… @ slot 14,745,600 (== deployments/1.json).
  Only the code COMMENTS were stale ("Sepolia rehearsal"); fixed (comment-only, no ELF/vkey change).
- A-02 (farm recover confiscated accrued-but-unharvested) + A-03 (rollover over-promise): FIXED. FarmController now
  tracks `accrued` (earned-unpaid liability): notify funds `accrued + newRate·duration`, harvest decrements it, and
  the pool's recover reserves it (releases only treasury − accrued). Contract-only. Latent (day-1 farms unseeded).
- A-04 (healed asset reverts in _ensurePair): FIXED. The registration gate resolves shared→local; the poolId keeps
  HASHING the shared id (matches the guest + escrow), so a healed canonical asset can get an AMM pool. Contract-only.
- A-05 (readiness gate exits 0 on BLOCKED): FIXED. READINESS_STRICT=1 (a deploy precondition) makes BLOCKED fail-closed.

Pool codesize: the above + F1/F2/F3 pushed the immutable pool 433 B over EIP-170 (it was at a 17-byte margin). Reclaimed
via an assembly bare-selector revert helper (_rv) on the two most-duplicated zero-arg reverts — 1.28 KB freed → 923 B
under EIP-170 with every fix kept. 791 forge tests green.
