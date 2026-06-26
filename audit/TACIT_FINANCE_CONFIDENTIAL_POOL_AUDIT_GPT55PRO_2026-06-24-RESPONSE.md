# Maintainer response — GPT-5.5 Pro confidential-pool audit (2026-06-24)

Companion to `TACIT_FINANCE_CONFIDENTIAL_POOL_AUDIT_GPT55PRO_2026-06-24.md` (report
SHA-256 `af36e05954dbf59707066614121a5ebe31fc650b450a0e7d2a240316a3cb3f7f`, verified
against the local copy). Each finding was independently re-verified against the live
source tree before responding; line citations below are the live-tree lines.

## Summary

| ID | Severity (reported) | Maintainer verdict | Status |
|----|---------------------|--------------------|--------|
| H-01 | High | Accurate facts; domain is bound in-guest via the pinned genesis sync-committee + recursion vkey. Residual is the testnet→production re-anchor, already tracked. | Deploy-gated; no code change |
| M-01 | Medium | Valid fail-closed guard; not strictly redundant (removes reliance on the trusted external verifier for a supported reflection-disabled deploy). | Fixed |
| M-02 | Medium | Valid; realistically low (governance-set feeds only). | Fixed |
| M-03 | Medium | Valid; bounded, dormant at launch, no theft path. | Fixed |
| L-01 | Low | Valid. | Fixed |
| L-02 | Low | Valid; liveness/UX only, operator-gated. | Fixed |

Five findings fixed in source (M-01, M-02, M-03, L-01, L-02). H-01 needs no source
change — the binding the report asks for already exists; the remaining item is the
production re-anchor already on the deploy checklist. None of the fixes touch the SP1
guest or any proof public-values layout, so the in-progress coordinated re-prove is
unaffected.

**Codesize note.** M-03 and L-02 add two pool view getters (`cbtcLockVBtc`,
`farmTreasury`) to the immutable pool, which was at its EIP-170 ceiling. Reclaimed the
space by internalizing two getters with zero on-chain readers (`lpShares`,
`knownReflectionDigest` — read only off-chain/in tests, now read in tests via the
existing `PoolStateReader` vm.load helper). Final `ConfidentialPool` runtime size
24,550 / 24,576.

---

## H-01 — Mode-B Ethereum reflection source binding

**Verdict: accurate facts, reclassified to a deploy/configuration gate.** The report
is correct that `EthReflectionPublicValues` carries no `sourceChainId` / fork-domain /
genesis-validators-root field, that `eth_refl_digest` hashes only `pool ‖ roots ‖
counts`, and that the on-chain `attestBitcoinStateProven` gate
(`ConfidentialPool.sol:1493-1494`) checks only `ethPool == address(this) || 0`.

What the report does not credit: the Ethereum source domain **is** bound, inside the
guest, not in the struct. The Mode-B guest hard-asserts the inner proof's
`prevSyncCommitteeRoot` against a pinned genesis anchor (`reflect.rs:322-326`) and
verifies it under a pinned recursion vkey (`reflect.rs:313`, `ETH_REFLECTION_VKEY`). A
different Ethereum domain has a different sync-committee anchor, so a foreign-domain
proof cannot satisfy the assert regardless of pool address — the address gate exists
only to break the pool↔vkey circularity, not to be the domain binding. So this is not
an open inflation vector at the reported severity.

The genuine residual is exactly what the pinned anchor and the pin file already flag:
the committed anchor is the **testnet** checkpoint (`reflect.rs:285` "Re-anchor for a
production deploy"; `elf-vkey-pin.json` notes the mainnet re-anchor/re-prove is a
separate, tracked step). Shipping a production pool against the current ELF would bind
the wrong source network — a wrong-anchor deploy error, caught by the existing mainnet
re-anchor + re-prove + redeploy step, not a code defect.

**Resolution:** no source change. Re-anchor the ETH reflection guest to the production
network, regenerate the reflection ELF/vkey, rebuild the Bitcoin reflection guest, and
deploy the pool with the resulting immutable relay vkey — the existing coordinated
re-prove/redeploy. Optional future defense-in-depth: add an explicit `sourceChainId` /
fork-domain field to `EthReflectionPublicValues` and assert it in both the guest and
(redundantly) on-chain. Belt-and-suspenders given the sync-committee anchor already
domain-separates; not required to close H-01.

## M-01 — Zero relay vkey on a reflection-disabled deploy — FIXED

A deploy with `BITCOIN_RELAY_VKEY == 0` (reflection disabled, a supported
configuration — it is the deploy-script default) still forwarded the zero key to the
external verifier. This is **not strictly redundant**: an immutable pool should not rely
on the trusted, out-of-scope external verifier to reject a zero program key on a config
it explicitly supports. Added an internal fail-closed guard at the top of
`attestBitcoinStateProven` reusing the existing `ZeroVKey()` error:

```solidity
if (BITCOIN_RELAY_VKEY == bytes32(0)) revert ZeroVKey();
```

No re-prove (pure EVM control flow before `verifyProof`). Reflection-*enabled* deploys
are unaffected. The guard correctly makes a reflection-*disabled* pool reject `attest`,
which surfaced four test suites that had used a zero-vkey + accept-all-mock shortcut to
drive `attest` without a relay; those were updated to deploy reflection-enabled with a
seeded mock relay (the realistic configuration). Full suite green apart from the
pre-existing box-prove-pending `*ProofReal*` fixtures.

## M-02 — Unbounded oracle decimals — FIXED

`setFeeds` validated address/code but not `feed.decimals()`, which then feeds an
unbounded `10 ** dec` in the priced paths (`_price`, `ethWeiForBtc`, `btcToUsd`). A
governance-set feed reporting extreme decimals could overflow (revert/brick priced
paths) or mis-scale. Real Chainlink BTC/USD is 8 dp; every sane feed is ≤ 18. Added a
configuration-time bound (`CollateralEngine.sol`, in `setFeeds`):

```solidity
if (IAggregatorV3(ethBtc).decimals() > 18 || IAggregatorV3(btcUsd).decimals() > 18) revert BadFeed();
```

This moves the failure to owner-visible configuration time and is a no-op for all
normal 8-/18-decimal feeds. Caching decimals and `fullMulDiv` scaling are optional
further hardening, not required to close the finding.

## M-03 — cBTC margin enforcement trusts caller-supplied `vBtc` — FIXED

`cbtcLockVBtc` was `internal` with no getter, so the engine's margin-call path took the
per-lock `vBtc` from the caller (the enforcement module). Made `cbtcLockVBtc` a `public`
getter, added it to `IConfidentialPoolCollateral`, and rewired the engine to read the
authoritative pool value:

- `checkEscrowHealth(bytes32 outpoint)` now computes `want` from
  `POOL.cbtcLockVBtc(outpoint)` instead of a `vBtc` parameter.
- `flagEscrowUnhealthy` / `enforceEscrowToReserve` drop the `vBtc` parameter entirely —
  a module can no longer supply a figure. (Safe ABI change: the enforcement module is
  unset/dormant at launch, so there is no live caller.)

The path was already doubly dormant (reverts unless governance arms both a non-zero
maintenance ratio and an enforcement module) and reserve-only (no theft), but the fix
removes the operator-correctness risk outright rather than relying on a future module's
honesty. Engine is mutable; pool getter cost absorbed by the reclaim above. No re-prove.

## L-01 — Permit2 pulls not bound to the transfer — FIXED

`_pullPermit2` and the batch liquidity path passed the signed permit straight through
without binding it to the token/spender/amount/window actually transferred, so a stale
or mismatched permit could be steered onto a different asset (the user's pre-existing
allowance remains the root authority, hence Low). Added binding checks to both paths
(`ConfidentialRouter.sol`), new error `BadPermit2()`:

- single (`_pullPermit2`): require `details.token == token`, `spender == address(this)`,
  `details.amount >= amount`, `sigDeadline >= block.timestamp`.
- batch (`addLiquidityPublicWithPermit2`): require `spender == address(this)`,
  `sigDeadline >= block.timestamp`, exactly two details entries covering `tokenA`/`tokenB`
  (either ordering) with sufficient amounts.

Native-ETH legs never use Permit2 and multi-token uses the batch struct (one entry per
token), so no legitimate flow mismatches. All 127 router/engine/AMM tests pass,
including every wrap/zap Permit2 path.

## L-02 — Escrow-mode farm campaigns can be notified before funding — FIXED

`notifyRewardAmount` (gov-only) set an emission rate without confirming the
per-controller pool treasury backs it; backing was enforced only later at harvest
(fails closed with `InsufficientEscrow`). Added a pool `farmTreasury(address)` getter
(to `IFarmPool` too) and a preflight in `FarmController.notifyRewardAmount`: for
escrow-mode farms, the full re-committed emission must be backed —

```solidity
if (ESCROW_MODE && IFarmPool(POOL).farmTreasury(address(this)) < newRate * duration) {
    revert UnfundedRate();
}
```

so stakers can no longer bond against a campaign whose harvests would later fail closed.
MINT-mode farms coin the reward fresh and skip the check. Controller is mutable; pool
getter cost absorbed by the reclaim above. No re-prove.

---

## Positive checks

The report's positive-checks table (settle ABI parity, chain/pool binding, EVM
no-inflation floor, one-time bridge-mint gate, cross-out source consumption, cBTC mint
gate, AMM reserve safety, reflected slot constants, canonical asset-id binding, minter
gating, Bitcoin-authorized call execution, relay anchoring) matches our own prior
review and remains accurate against the live tree. We concur with the recommendation to
add storage-layout CI that generates the guest slot constants from the compiler layout.

## Verification

- `forge build` — clean, no errors.
- Full `forge test` — the only failures are the 9 pre-existing `*ProofReal*` suites
  (stale Groth16 fixtures / vkey pins awaiting the coordinated box re-prove); every
  other suite passes. Zero regressions in any file touched by these fixes.
- New/updated coverage: `test_notify_rejects_unbacked_rate` (L-02); engine margin tests
  now read the authoritative pool `vBtc` (M-03); router Permit2 binding paths (L-01);
  `ConfidentialCdpCbtcSettle` / `ConfidentialPoolInvariant` / `ConfidentialRegisterHeal`
  / `ConfidentialTacWalkthrough` updated to deploy reflection-enabled (M-01).
- ConfidentialPool runtime size 24,550 / 24,576.

---

# Addendum — Claude Opus 4.8 parallel audit (2026-06-25)

A second independent audit (`TACIT_FINANCE_CONFIDENTIAL_POOL_AUDIT_CLAUDE_OPUS_2026-06-25.md`,
same byte-identical bundle, hash `14511596…bfe3f`) confirmed all six GPT-5.5 findings with
no severity disagreement and added five new ones (N-01…N-05). Dispositions:

| ID | Severity | Disposition |
|----|----------|-------------|
| N-01 | High | Deploy-gated with H-01 (no standalone code defect) |
| N-02 | Low | Not a bug — guard already present |
| N-03 | Low | By design; no action (auditor concurs) |
| N-04 | Info | Already implemented (`verify-reflection-slots.sh`) |
| N-05 | Info | Fixed |

## N-01 — Fast-lane btcHomed exit depends on Mode-B being operational on the Bitcoin side — DEPLOY-GATED

Verified: the EVM side is already fail-closed — once any consume exists, the
`ConsumedCountStale` gate (`ConfidentialPool.sol:1525`) blocks any spent-set advance until
a reflection proof whose finalized slot covers that consume is supplied (Ethereum-senior
ordering). The residual is a *deployment-sequencing* dependency on the reverse (Mode-B)
reflection, which is exactly the H-01 seam. No standalone contract change: fast-lane
btcHomed value exits are gated by the same production re-anchor + redeploy as H-01 (pin the
regenerated production `BITCOIN_RELAY_VKEY`; do not arm btcHomed exits until a first
production reflection has advanced the spent set). Tracked as an enable-ordering invariant
on the H-01 redeploy, not a runbook step.

## N-02 — cBTC under-collateralization when `escrowRatioBps < 10000` — NOT A BUG

Premise unreachable: `setParams` already rejects `escrowRatioBps < 10_000`
(`CollateralEngine.sol:325`; default 15000 / 1.5×), and `_slashToReserve` captures the
**full** posted escrow (gated `>= requiredEscrow >= 1×` BTC value at mint), not a fraction.
Post-rug reserve is therefore `>=` the outstanding cBTC value under every permitted config.
cBTC is additionally doubly dormant at launch (engine unset → mint reverts; margin module +
maintenance ratio both zero). No change.

## N-03 — Confidential-swap pre-reserve pin can be griefed into a re-prove — BY DESIGN

The `reserveAPre == live` check is fail-closed and correct; an interleaved settle that
shifts the reserve forces a re-prove (liveness cost), never a loss or double-spend. Inherent
to proving against a public AMM reserve. The auditor rates it "no action required for
safety." No change.

## N-04 — Storage-layout CI for the four reflected slot constants — ALREADY IMPLEMENTED

`contracts/sp1/confidential/verify-reflection-slots.sh` already emits
`forge inspect ConfidentialPool storageLayout --json` and asserts the guest
`*_SLOT_INDEX` constants (`crossOutCommitment`=76, `bitcoinConsumed`=119,
`bitcoinConsumedCount`=120, `bitcoinConsumedAt`=163) equal the live compiled layout,
failing loudly on any relayout drift — exactly the compiler-emitted check both auditors
recommend (they saw only the forge tests, not this guard). Re-verified against the current
tree post-fixes: all four slots still reconcile (the visibility changes for the reclaim and
the two new getters added no state variables, so no slot moved).

## N-05 — Router-relayed settle can strand a non-input-asset settler fee — FIXED

Every router-relayed settle runs with `msg.sender == this router`, so a `pv.fees` leg pays
the router; a fee in a non-input asset would strand with no sweep. The router settle paths
are fee-free by construction (already documented, previously unchecked). Routed all 13
`POOL.settle` call sites through a new `_relaySettle` helper that fails closed on a
non-empty fees leg (`PublicValues` field 7), reusing the existing `_requireCdpMintIntent`
calldata-offset reader pattern and the `BadProofIntent` error. Consolidating the call sites
net-*reduced* router bytecode (22,038 / 24,576). New negative test
`test_wrapAndSettle_rejectsNonEmptySettlerFee`; all 60 router tests pass.

## Re-prove impact

None of the fixes in this response or addendum touch the SP1 guest, the proving artifacts,
or any committed storage slot the guest reads (verified: slots 76/119/120/163 unchanged).
The in-progress coordinated re-prove is independent and need not be restarted on account of
this work; it will refresh the stale `*ProofReal*` fixtures (the only remaining forge
failures) on its own. The H-01/N-01 production re-anchor is a separate, future guest change
+ re-prove.
