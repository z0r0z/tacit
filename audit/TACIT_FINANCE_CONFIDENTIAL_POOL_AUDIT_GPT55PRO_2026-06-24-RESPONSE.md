# Maintainer response — GPT-5.5 Pro confidential-pool audit (2026-06-24)

Companion to `TACIT_FINANCE_CONFIDENTIAL_POOL_AUDIT_GPT55PRO_2026-06-24.md` (report
SHA-256 `af36e05954dbf59707066614121a5ebe31fc650b450a0e7d2a240316a3cb3f7f`, verified
against the local copy). Each finding was independently re-verified against the live
source tree before responding; line citations below are the live-tree lines.

## Summary

| ID | Severity (reported) | Maintainer verdict | Status |
|----|---------------------|--------------------|--------|
| H-01 | High | Accurate facts; domain is bound in-guest via the pinned genesis sync-committee + recursion vkey. Residual is the testnet→production re-anchor, already tracked. | Deploy-gated; no code change |
| M-01 | Medium | Valid; practical severity low (verifier already rejects a zero vkey). | Fixed |
| M-02 | Medium | Valid; realistically low (governance-set feeds only). | Fixed |
| M-03 | Medium | Valid; bounded, dormant at launch, no theft path. | Accepted; deferred hardening |
| L-01 | Low | Valid. | Fixed |
| L-02 | Low | Valid; liveness/UX only, operator-gated. | Accepted; deferred hardening |

Three findings fixed in this pass (M-01, M-02, L-01). Two accepted with documented
rationale and a deferred hardening (M-03, L-02). H-01 needs no source change — the
binding the report asks for already exists; the remaining item is the production
re-anchor that was already on the deploy checklist.

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
configuration) still forwarded the zero key to the external verifier. The external
verifier already rejects it, so this was fail-closed clarity rather than an exploitable
gap. Added an internal guard at the top of `attestBitcoinStateProven`
(`ConfidentialPool.sol:1485`) reusing the existing `ZeroVKey()` error:

```solidity
if (BITCOIN_RELAY_VKEY == bytes32(0)) revert ZeroVKey();
```

No re-prove. Reflection-enabled deploys are unaffected (the constructor couples a
non-zero relay vkey to a relay + anchor + maturity, so no passing fixture relies on the
zero path). Pool runtime size 24,554 bytes — fits under the 24,576 ceiling.

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

## M-03 — cBTC margin enforcement trusts caller-supplied `vBtc` — ACCEPTED, deferred

Verified accurate: `cbtcLockVBtc` is `internal` with no getter, the
`IConfidentialPoolCollateral` interface exposes no per-lock value, and the engine's
`checkEscrowHealth` / `flagEscrowUnhealthy` / `enforceEscrowToReserve` take `vBtc` from
the caller (the enforcement module).

Bounding context: the path is doubly dormant at launch — it reverts unless governance
both sets a non-zero maintenance ratio **and** sets an enforcement module
(`escrowMaintenanceBps == 0` and `escrowEnforcementModule == address(0)` by default).
Enforcement is one-shot, gated by a flag plus an elapsed grace window (top-up
permissionless throughout), only touches a live lock, and moves escrow to the protocol
reserve — funds never leave to an external address. There is no theft path; the
residual is operator-correctness risk in a future, governance-armed module.

**Resolution:** accepted for v1 as a dormant, operator-gated path. The clean fix —
expose an authoritative `cbtcLockValue(outpoint)` pool view, add it to the interface,
and have the engine read it (or assert equality) — is the right shape but adds pool
bytecode, and the immutable pool is at the codesize ceiling (24,554 / 24,576). Deferred
to the same window that budgets the pool's bytecode (re-measure with any reclaim), so
the authoritative value is wired in before the enforcement module is ever armed. The
engine is mutable, so the engine-side read is a free change once the view exists.

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

## L-02 — Escrow-mode farm campaigns can be notified before funding — ACCEPTED, deferred

Verified accurate: `notifyRewardAmount` (gov-only) sets an emission rate without
confirming the per-controller pool treasury backs it; the backing is enforced only at
harvest (`ConfidentialPool.sol:1872`, fails closed with `InsufficientEscrow` — no
unbacked mint, no cross-farm reach). The asymmetry is real but strictly a
liveness/UX issue, and the at-risk actor is the farm operator misconfiguring their own
campaign.

A pure-Solidity preflight is not feasible today: `FarmController` cannot read
`farmTreasury` (internal mapping, no getter, not on `IFarmPool`). The clean fix (a pool
view + `IFarmPool` extension, or an atomic `fundAndNotify`) again adds pool bytecode
against the codesize ceiling.

**Resolution:** accepted for v1. Funding remains an operator runbook invariant (fund
`pool.farmEscrow` before `notifyRewardAmount`); harvest already fails closed so no value
is at risk. Deferred to the codesize-budgeted follow-up alongside M-03.

---

## Positive checks

The report's positive-checks table (settle ABI parity, chain/pool binding, EVM
no-inflation floor, one-time bridge-mint gate, cross-out source consumption, cBTC mint
gate, AMM reserve safety, reflected slot constants, canonical asset-id binding, minter
gating, Bitcoin-authorized call execution, relay anchoring) matches our own prior
review and remains accurate against the live tree. We concur with the recommendation to
add storage-layout CI that generates the guest slot constants from the compiler layout.

## Verification

- `forge build --skip test` — clean, no errors.
- Router + collateral-engine + public-AMM suites — 127 passed, 0 failed.
- Pool/invariant suites incl. attest fuzz — passed.
- ConfidentialPool runtime size 24,554 / 24,576.
