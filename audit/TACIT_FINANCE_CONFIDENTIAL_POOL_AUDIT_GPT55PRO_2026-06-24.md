# Tacit Finance Confidential Cryptographic Asset Pool — Production Readiness Accounting & Security Audit

**Audit date:** 2026-06-24  
**Auditor / model:** GPT-5.5 Pro  
**Audit type:** Static source review of the supplied confidential-pool audit bundle.  
**Bundle reviewed:** `/mnt/data/tacit-audit-bundle.zip`  
**Bundle SHA-256:** `14511596f7dc102e71ac1524f6fe436678da42c9ca6cac4e30d90689697bfe3f`  
**Extracted root reviewed:** `/mnt/data/tacit-audit-work/extracted/tacit-audit-bundle.cARz`  
**Report status:** Codebase-ready, open findings pending maintainer response.

## Verdict

**Do not ship the production/mainnet cross-chain reflection path until H-01 is fixed.** The core EVM settlement loop shows strong accounting structure: the Solidity and SP1 settle `PublicValues` layouts match, `settle` binds proofs to `block.chainid` and the pool address, bridge burns are one-time, EVM-homed spends are reserve-floor checked, and public AMM reserve transitions are revalidated on-chain. The main fund-critical release blocker is at the Bitcoin reflection Mode-B seam: the reflected Ethereum source is pinned to a Sepolia weak-subjectivity checkpoint and is only pool-address-gated on-chain, not Ethereum-chain/domain-gated. For an immutable production deployment, that is sufficient to reject the current Mode-B configuration.

## Severity summary

| Severity | Count | Findings |
|---|---:|---|
| Critical | 0 | None assigned. |
| High | 1 | H-01 |
| Medium | 3 | M-01, M-02, M-03 |
| Low | 2 | L-01, L-02 |
| Informational | 0 | Positive checks and non-findings are listed separately. |

## Scope reviewed

The scope was taken from `README.md` in the bundle and applied to the related files therein:

| Area | Files reviewed |
|---|---|
| Solidity immutable pool and periphery | `contracts/ConfidentialPool.sol`, `CollateralEngine.sol`, `FarmController.sol`, `CanonicalAssetFactory.sol`, `BitcoinLightRelay.sol`, `ConfidentialRouter.sol`, `CanonicalBridgedERC20.sol`, `CanonicalMinters.sol`, `BtcCallExecutor.sol` |
| SP1 guest and cryptographic/accounting core | `guest/main.rs`, `guest/reflect.rs`, `guest/cxfer-core/lib.rs`, `eth_reflection.rs`, `sigma.rs`, `elf-vkey-pin.json` |

The off-repo `SP1VerifierGroth16` verifier was treated as trusted/out of scope, per the README. The audit focused on whether the guest computes sound public values and whether the contracts trust exactly what the proof constrains.

## Methodology and limitations

This was a static audit of the uploaded bundle. I reviewed the Solidity↔Rust ABI seams, root/nullifier accounting, bridge-burn and bridge-mint gates, Bitcoin reflection anchoring, cBTC/CDP/farm hooks, periphery Permit2 flows, canonical token/factory controls, and file/vkey pin metadata.

No dynamic compilation, Foundry tests, Rust/SP1 tests, proof generation, or storage-layout compiler artifact verification was possible from the bundle because the local environment did not include `forge`, `solc`, `cargo`, SP1 tooling, or the imported dependency tree. Where compiler output would further harden an assumption, the report says so explicitly.

---

# Fund-critical finding

## H-01 — Mode-B Ethereum reflection is not source-chain/domain bound and is still Sepolia-anchored

**Severity:** High  
**Status:** Open  
**Files / lines:**

- `guest/reflect.rs:277-285`
- `guest/reflect.rs:327-355`
- `guest/cxfer-core/eth_reflection.rs:17-30`
- `guest/cxfer-core/eth_reflection.rs:159-166`
- `contracts/ConfidentialPool.sol:1455-1465`
- `contracts/ConfidentialPool.sol:1482-1494`
- `guest/elf-vkey-pin.json:15-34`

**One-line claim:** Mode-B proofs can be bound to the correct 20-byte pool address while still reflecting the wrong Ethereum chain/domain; the shipped reflection guest explicitly pins a Sepolia finalized checkpoint and the pool-side gate does not check a chain id or source-domain digest.

**Precise seam:**

- The Bitcoin reflection public values include `ethPoolReflected` but no Ethereum chain id/domain field in `contracts/ConfidentialPool.sol:1455-1465`.
- `attestBitcoinStateProven` verifies a reflection proof, decodes public values, and gates the reflected Ethereum state only by `address(this)` or zero in `contracts/ConfidentialPool.sol:1482-1494`.
- The Mode-B Bitcoin guest verifies an inner ETH reflection proof using a hard-coded `ETH_REFLECTION_VKEY` and a hard-coded genesis sync-committee root described as a Sepolia finalized checkpoint in `guest/reflect.rs:277-285`.
- The inner ETH reflection public-values layout has `ethPool`, roots, counts, finalized slot/state root, and sync-committee roots, but no `sourceChainId`, fork/domain id, genesis validators root, or deployment-domain field in `guest/cxfer-core/eth_reflection.rs:17-30`.
- The ETH reflection digest is `keccak(pool || roots || counts)` and asserts only that `pool` is a 20-byte address in `guest/cxfer-core/eth_reflection.rs:159-166`.
- The first Mode-B cycle computes its expected ETH reflection genesis digest from only the low 20 bytes of the pool address in `guest/reflect.rs:353-355`.

**Exploit walkthrough / impact:**

1. A production pool is deployed on an Ethereum domain other than Sepolia, or the production environment otherwise should not trust Sepolia finalized storage as its source of truth.
2. The Mode-B reflection guest still accepts an inner ETH reflection proof chained to the Sepolia sync-committee checkpoint embedded in `guest/reflect.rs:280-285`.
3. The on-chain pool checks only that `ethPoolReflected` equals `address(this)`, not that the reflected chain/domain equals the production domain.
4. If an attacker or operator can deploy a same-address pool/contract on Sepolia, or otherwise produce Sepolia finalized storage under the same 20-byte address, the inner proof can reflect Sepolia `crossOutCommitment`, `bitcoinConsumed`, or `bitcoinConsumedCount` storage while the production pool treats the resulting Bitcoin reflection proof as authoritative for the production system.
5. That can admit false or wrong-domain Ethereum→Bitcoin cross-outs into the Bitcoin reflection set, poison the fast-lane consumed set, or later authorize bridge-mint roots that production Ethereum should never have accepted.

The comment in `guest/elf-vkey-pin.json:34` also states that mainnet re-anchor/re-prove remains separate, confirming this is a production readiness gap rather than only a theoretical domain-design issue.

**Minimal recommended fix:**

- Add a source-chain/domain commitment to `EthReflectionPublicValues` and to `eth_refl_digest`, for example `sourceChainId`, execution-chain genesis/hash domain, beacon genesis validators root, and/or an explicit immutable `ETH_REFLECTION_DOMAIN`.
- Have the ETH reflection guest assert the expected production domain.
- Have the Bitcoin reflection guest carry and commit the same domain through Mode-B.
- Add an immutable pool-side expected domain, or include the domain in `BitcoinRelayPublicValues`, and reject mismatches in `attestBitcoinStateProven` before anchoring roots.
- Re-anchor the ETH reflection guest to the intended production network and regenerate the reflection ELF/vkey. Do not deploy production Mode-B with the Sepolia-pinned vkey.

**Check to confirm fix:**

- Add a test vector with a valid Sepolia ETH reflection proof for the same 20-byte pool address and submit it to a production-configured reflection proof path. The proof or `attestBitcoinStateProven` must reject it.
- Add a positive production-domain proof fixture and confirm it is accepted only when the source domain, pool address, roots, and counts all match.
- Add a CI assertion that the production deploy script refuses the Sepolia weak-subjectivity anchor/vkey pair.

**Suggested maintainer response field:** Accepted / disputed / mitigated by disabling Mode-B. Include the target chain/domain and new vkey commit hash when fixed.

---

# Production-readiness / defensive findings

## M-01 — Reflection-disabled deployments still expose `attestBitcoinStateProven` with a zero relay vkey

**Severity:** Medium  
**Status:** Open  
**Files / lines:**

- `contracts/ConfidentialPool.sol:705-719`
- `contracts/ConfidentialPool.sol:1482-1484`

**One-line claim:** A deployment with `BITCOIN_RELAY_VKEY == 0` is intended to disable reflection, but `attestBitcoinStateProven` still calls the external verifier with the zero vkey instead of failing closed internally.

**Precise seam:** The constructor only enforces relay/anchor/maturity requirements when `bitcoinRelayVKey_ != bytes32(0)` in `contracts/ConfidentialPool.sol:705-715`, then stores the vkey in `contracts/ConfidentialPool.sol:719`. Later, `attestBitcoinStateProven` unconditionally calls `SP1_VERIFIER.verifyProof(BITCOIN_RELAY_VKEY, publicValues, proofBytes)` in `contracts/ConfidentialPool.sol:1482-1484`.

**Exploit walkthrough / impact:**

The current design delegates zero-vkey behavior to the external SP1 verifier. If the verifier always rejects a zero program vkey, this is only a defense-in-depth issue. If a verifier wrapper, mock, misconfigured deployment, or future verifier version accepts/mishandles the zero key, an attacker can submit arbitrary reflection public values and mark Bitcoin roots/burn roots/spent roots as canonical. That would directly threaten bridge-mint and cross-lane accounting.

Because the contracts are immutable and the verifier is out of scope, the pool should enforce “reflection disabled means no attestation path” itself.

**Minimal recommended fix:**

Add an explicit guard at the top of `attestBitcoinStateProven`:

```solidity
if (BITCOIN_RELAY_VKEY == bytes32(0)) revert ReflectionDisabled();
```

Optionally also require `address(HEADER_RELAY) != address(0)` in the same branch for clarity, even though the constructor already couples a nonzero relay vkey to a relay.

**Check to confirm fix:**

- Deploy with `bitcoinRelayVKey_ == bytes32(0)` and assert `attestBitcoinStateProven` reverts before calling the verifier.
- Deploy with a nonzero vkey and assert existing positive reflection fixtures still pass.

**Suggested maintainer response field:** Accepted / mitigated by deploy policy. If mitigated by policy, include the deploy-script guard proving zero relay vkeys are never accepted for production.

---

## M-02 — Collateral oracle decimal exponents are unchecked and can brick or distort priced paths

**Severity:** Medium  
**Status:** Open  
**Files / lines:**

- `contracts/CollateralEngine.sol:281-295`
- `contracts/CollateralEngine.sol:416-449`
- `contracts/CollateralEngine.sol:462-467`

**One-line claim:** Owner-configured Chainlink/TWAP feeds are checked for address/code, but their decimals are not bounded before exponentiation in pricing functions used by cBTC escrow and CDP accounting.

**Precise seam:**

- `setFeeds` checks nonzero/code and stores feed/TWAP addresses in `contracts/CollateralEngine.sol:281-295`.
- `_price` reads `feed.decimals()` and, when TWAP checking is enabled, computes `10 ** uint256(dec)` and `10 ** uint256(ammDec)` in `contracts/CollateralEngine.sol:416-432`.
- `ethWeiForBtc` and `btcToUsd` also exponentiate feed decimals in `contracts/CollateralEngine.sol:439-449`.
- `escrowSufficient` calls `requiredEscrow`, which uses the priced path to gate cBTC minting in `contracts/CollateralEngine.sol:462-467`.

**Exploit walkthrough / impact:**

This is governance/configuration-driven rather than permissionless. A malicious, compromised, or misconfigured feed/TWAP returning extreme decimals can cause exponentiation overflow or severe scaling distortion. That can make cBTC mint checks revert, block CDP mint/close/liquidation/topup paths that rely on pricing, or accept an unintended collateralization ratio if decimals are wrong but not overflowing.

In an immutable production deployment, the feed layer should fail during configuration, not during user settlement.

**Minimal recommended fix:**

- In `setFeeds`, read and validate feed decimals immediately. For common Chainlink-style feeds, require `decimals <= 18` or another explicitly supported upper bound.
- If TWAPs are configured, validate their decimals through a configuration-time probe or typed adapter.
- Use `FixedPointMathLib.fullMulDiv` / `fullMulDivUp` for price scaling to avoid intermediate multiplication overflow.
- Consider caching approved decimals in storage so priced paths do not trust mutable feed decimal metadata on every call.

**Check to confirm fix:**

- Add a mock feed with `decimals() == 255`; `setFeeds` must revert.
- Add a mock TWAP with extreme decimals; enabling deviation checks must revert or reject configuration.
- Existing 8-decimal and 18-decimal price fixtures should continue to pass and produce identical rounded results.

**Suggested maintainer response field:** Accepted / mitigated by governance runbook. If runbook-only, attach the exact feed adapter allowlist and decimals table.

---

## M-03 — cBTC margin enforcement trusts caller-supplied `vBtc` instead of an authoritative pool value

**Severity:** Medium  
**Status:** Open  
**Files / lines:**

- `contracts/ConfidentialPool.sol:394-401`
- `contracts/CollateralEngine.sol:349-355`
- `contracts/CollateralEngine.sol:475-484`
- `contracts/CollateralEngine.sol:560-603`

**One-line claim:** The margin-call module can flag and slash a live cBTC escrow using a caller-supplied `vBtc`; the engine does not read the authoritative lock amount recorded by the reflection-backed pool.

**Precise seam:**

- The pool records the actual reflection-proven cBTC lock amount in `cbtcLockVBtc` at `contracts/ConfidentialPool.sol:394`, but that mapping is `internal` and not exposed through the `IConfidentialPoolCollateral` interface.
- `CollateralEngine` comments state that the enforcement module judges health using its own view of the lock’s `vBtc` in `contracts/CollateralEngine.sol:349-355`.
- `checkEscrowHealth`, `flagEscrowUnhealthy`, and `enforceEscrowToReserve` all accept `vBtc` from the caller/module in `contracts/CollateralEngine.sol:475-484` and `contracts/CollateralEngine.sol:560-603`.

**Exploit walkthrough / impact:**

This path is dormant until governance sets both a maintenance ratio and an enforcement module. Once armed, a buggy, stale, or compromised module can pass an inflated `vBtc` for a live lock. The engine will compute a higher required escrow, flag the position unhealthy, and after the grace window slash the escrow to the protocol reserve even if the lock is healthy at its true reflection-proven amount. The funds do not go directly to the module, but they are removed from the locker/funders and become owner/DAO-managed reserve capital.

This is not a permissionless attacker path, but it is a production-readiness issue because the engine already has a trustless source of the true lock value in the pool; relying on a side module reintroduces avoidable operator correctness risk.

**Minimal recommended fix:**

- Expose an authoritative pool view such as `cbtcLockValue(bytes32 outpoint) returns (uint64)` or include it in the existing pool interface.
- Have `CollateralEngine` call the pool for the lock’s recorded `vBtc` inside `checkEscrowHealth`, `flagEscrowUnhealthy`, and `enforceEscrowToReserve` rather than accepting it from the module.
- If module-supplied values are retained for gas reasons, require equality against the pool view before flagging/enforcing.

**Check to confirm fix:**

- Create a live lock with true value `v` and sufficient escrow for `v`.
- Have a mock enforcement module call `flagEscrowUnhealthy(outpoint, 2*v)` or equivalent. The call must revert after the fix.
- Confirm the same lock becomes enforceable only when the pool-recorded `v` is actually under the configured maintenance threshold.

**Suggested maintainer response field:** Accepted / accepted-risk. If accepted-risk, state the exact module audit and operational controls that make caller-supplied `vBtc` acceptable.

---

## L-01 — Permit2 pulls are not bound to the token/spender/amount the router actually transfers

**Severity:** Low  
**Status:** Open  
**Files / lines:**

- `contracts/ConfidentialRouter.sol:248-260`
- `contracts/ConfidentialRouter.sol:365-378`
- `contracts/ConfidentialRouter.sol:571-588`
- `contracts/ConfidentialRouter.sol:601-612`
- `contracts/ConfidentialRouter.sol:930-939`

**One-line claim:** The router accepts Permit2 calldata but does not require the permit details to match the explicit token/spender/amount that the router transfers, so stale or mismatched Permit2 allowances can be consumed contrary to wallet-display intent.

**Precise seam:**

`_pullPermit2` best-effort calls `PERMIT2.permit(msg.sender, permitSingle, signature)` and then transfers `token` using `PERMIT2.transferFrom(msg.sender, address(this), uint160(amount), token)` in `contracts/ConfidentialRouter.sol:930-939`. It does not require:

- `permitSingle.details.token == token`
- `permitSingle.spender == address(this)`
- `permitSingle.details.amount >= amount`
- `permitSingle.sigDeadline >= block.timestamp`
- an intended expiration policy

The same pattern appears in the batch Permit2 liquidity path in `contracts/ConfidentialRouter.sol:571-588`, which calls a Permit2 batch permit and then transfers `tokenA` and `tokenB` without binding the batch details to those tokens/amounts.

**Exploit walkthrough / impact:**

This is not a core pool accounting break because the user must call the router and Permit2 still enforces an existing allowance. The risk is periphery phishing/integration mismatch:

1. A user signs or submits a transaction whose visible Permit2 payload appears to approve token A or a smaller amount.
2. The router calldata separately supplies token B or a larger `amount`, and the permit call is best-effort/ignored if already used or mismatched.
3. If the user has an older Permit2 allowance to the router for token B, the router can pull token B even though the current signature did not authorize token B.

The user’s old allowance is still the root authority, so severity is Low, but production periphery should bind signed intent to transferred assets.

**Minimal recommended fix:**

- In `_pullPermit2`, require the `PermitSingle` fields to match the transfer:

```solidity
if (permitSingle.details.token != token) revert BadPermit2Token();
if (permitSingle.spender != address(this)) revert BadPermit2Spender();
if (permitSingle.details.amount < amount) revert BadPermit2Amount();
if (permitSingle.sigDeadline < block.timestamp) revert BadPermit2Deadline();
```

- For `PermitBatch`, validate that the batch contains exactly `tokenA`/`tokenB` with sufficient amounts before calling `transferFrom`.
- Consider deriving the transfer token from the permit payload rather than duplicating it in function arguments where possible.

**Check to confirm fix:**

- Unit test mismatched `permitSingle.details.token` and router `token`: transaction must revert before `transferFrom`.
- Unit test mismatched spender: transaction must revert.
- Unit test insufficient `details.amount`: transaction must revert.
- Existing valid Permit2 wrap/swap/LP flows should remain green.

**Suggested maintainer response field:** Accepted / accepted-risk. If accepted-risk, explicitly document that router calls may consume pre-existing Permit2 allowances independent of the presented signature.

---

## L-02 — Escrow-mode farm campaigns can be announced without proving the reward treasury is funded

**Severity:** Low  
**Status:** Open  
**Files / lines:**

- `contracts/FarmController.sol:124-149`
- `contracts/ConfidentialPool.sol:1869-1876`

**One-line claim:** `notifyRewardAmount` can set an escrow-mode emission schedule without confirming that the pool-side per-farm treasury currently backs the advertised rewards; harvest later fails closed at settlement time.

**Precise seam:**

`FarmController.notifyRewardAmount` computes and sets a rate/period in `contracts/FarmController.sol:124-149`. Its comment says escrow farms must be funded through `pool.farmEscrow`, and harvest fails closed if underfunded. The actual escrow-backed reward debit occurs later in the pool settle path at `contracts/ConfidentialPool.sol:1869-1876`, where the pool checks `farmTreasury[m.controller] < m.debtValue` and reverts if insufficient.

**Exploit walkthrough / impact:**

A governance operator can announce a campaign and users can bond against the advertised schedule, but the pool treasury may not actually contain enough reward backing. When users later submit valid harvest proofs, the pool reverts with `InsufficientEscrow`. This does not steal funds and the pool check protects other escrow, but it creates a production liveness/UX failure and can strand users in a reward program until governance funds or changes the campaign.

**Minimal recommended fix:**

- Add a pool view exposing per-controller `farmTreasury` and `farmRewardAsset`, or add a controller-side funding callback.
- For escrow-mode controllers, make `notifyRewardAmount` validate that `reward + leftover` is backed by uncommitted treasury before updating `rate` and `periodFinish`.
- Prefer an atomic `fundAndNotify` flow that funds the pool treasury and updates the farm in one transaction.

**Check to confirm fix:**

- In escrow mode, call `notifyRewardAmount` without funding. It should revert or explicitly enter an underfunded state that prevents bonding.
- Fund exactly the reward budget, notify, bond, and harvest through the full period. All valid harvest proofs should settle.
- Attempt to over-notify relative to remaining treasury. It should revert.

**Suggested maintainer response field:** Accepted / accepted-risk. If accepted-risk, document the operational funding invariant and add deploy/runbook checks.

---

# Positive accounting and security checks

The following high-value checks appeared sound under static review:

| Area | Observation |
|---|---|
| Solidity↔guest settle ABI | `contracts/ConfidentialPool.sol:555-586` and `guest/main.rs:125-155` define the same `PublicValues` field order, including the cross-chain, adaptor, CDP, and cBTC tail fields. |
| Chain/pool binding for normal settle | `ConfidentialPool._settle` verifies the SP1 proof, decodes public values, checks `pv.version`, and enforces `pv.chainBinding == keccak256(block.chainid, address(this))` in `contracts/ConfidentialPool.sol:1643-1648`. |
| EVM no-inflation floor | EVM-homed nullifier count is incremented excluding bridge-burn nullifiers and then checked against `nextLeafIndex` in `contracts/ConfidentialPool.sol:1942-1994`. This provides defense-in-depth if a proof tried to spend more EVM notes than were ever created in the tree. |
| Bridge mint one-time gate | `contracts/ConfidentialPool.sol:1963-1975` requires each Bitcoin burn to be in `pv.nullifiers`, gates `bridgeMinted[burnNullifier]`, and requires each used Bitcoin root to be known. |
| Cross-out source consumption | `contracts/ConfidentialPool.sol:2013-2023` recomputes `claimId` and requires the cross-out nullifier to be spent in the same batch before recording `crossOutCommitment`. |
| cBTC mint gate | `contracts/ConfidentialPool.sol:1916-1930` requires the reflection-recorded lock value and commitment to match, rejects spent/redeemed/already-minted locks, and requires `COLLATERAL_ENGINE.escrowSufficient`. |
| AMM reserve safety | `contracts/ConfidentialPool.sol:2032-2054` checks live pre-reserves, nonzero post-reserves, `u64` bounds, and non-decreasing constant product for confidential swaps. |
| Reflected storage slot constants | Manual counting of persistent `ConfidentialPool` state, including `lastReflectionBlockHash` and `lastRelayHeight` before the note tree, reconciles the guest constants: `crossOutCommitment` slot 76, `bitcoinConsumed` slot 119, `bitcoinConsumedCount` slot 120, and `bitcoinConsumedAt` slot 163. Still add compiler-layout CI because this is a critical guest/contract seam. |
| Canonical asset id binding | `CanonicalAssetFactory.deriveAssetId` includes chain id, factory address, salt, etcher, and metadata hash in `contracts/CanonicalAssetFactory.sol:110-121`. |
| Canonical token minter gating | `CanonicalBridgedERC20.mint` and `burn` are `MINTER`-gated in `contracts/CanonicalBridgedERC20.sol:101-112`. |
| Bitcoin-authorized call execution | `BtcCallExecutor.executeBtcCall` rechecks the pool-recorded hash over executor, target, calldata hash, and caller pubkey, sets `fired` before the external call, and rejects non-code targets in `contracts/BtcCallExecutor.sol:52-66`. |
| Bitcoin relay anchoring | `BitcoinLightRelay` validates PoW, canonical compact targets, MTP/future timestamp, heaviest-chain fork choice, retarget boundaries, and recent-tip anchoring. No production-blocking issue was identified in static review. |
| Bitcoin reflection full-scan discipline | `guest/reflect.rs` links the Mode-B proof to a committed ETH accumulator digest and separately checks Bitcoin header-chain anchoring and completeness of folded consumed nullifiers. The source-domain issue in H-01 must still be fixed. |

---

# Release punch-list, in fix priority order

1. **Fix H-01:** Add Ethereum source-domain binding to Mode-B, re-anchor to the intended production chain, regenerate reflection ELF/vkey, and reject Sepolia proofs in production.
2. **Fix M-01:** Add a fail-closed `BITCOIN_RELAY_VKEY != 0` guard to `attestBitcoinStateProven`.
3. **Fix M-02:** Bound and cache oracle/TWAP decimals at feed configuration time; use full-mul-div scaling.
4. **Fix M-03:** Make cBTC margin enforcement read the pool-recorded lock value rather than accepting module-supplied `vBtc`.
5. **Fix L-01:** Bind Permit2 permit payloads to the actual token/spender/amount transferred by the router.
6. **Fix L-02:** Add an escrow-farm treasury preflight or atomic `fundAndNotify` flow.
7. **Add storage-layout CI:** Even though the manual slot count reconciles, generate guest slot constants from compiler storage layout and fail CI on drift.
8. **Run full verification:** Execute Foundry tests, Rust unit tests, SP1 proof fixtures, storage-layout CI, and deploy-script vkey pin checks against the exact production dependency set.
9. **Only then freeze immutables:** Deploy `PROGRAM_VKEY` and `BITCOIN_RELAY_VKEY` that exactly match the committed ELFs and report the deployed addresses/vkeys in the codebase.

---

# File hashes reviewed

| SHA-256 | Lines | File |
|---|---:|---|
| `91545f04525c5e5d1b4e10a87236aaa34178ab3588bdd9375b538267b8104889` | 61 | `README.md` |
| `ff957d80fb24c8f657ab03f9b326a5bde82f1b12665c96a8f86438f78606e948` | 2319 | `contracts/ConfidentialPool.sol` |
| `f8d63fc3244dde2c6961cf09cb675bc59146956fbb0d33725b84041fbd5b40bd` | 853 | `contracts/CollateralEngine.sol` |
| `4523b524cbc14f034f5aad462a544fbdddd9b6b99c924c5800ae6b35ea6f6d46` | 282 | `contracts/FarmController.sol` |
| `7e267ce3def4c6ab718f8323229d67d50d5a7140a3137b07f4295f7e766728e4` | 234 | `contracts/CanonicalAssetFactory.sol` |
| `e0fd0ff8f59fffa0aea8540bbfebf20ae027cee665ee5fe95711a1f59130d377` | 547 | `contracts/BitcoinLightRelay.sol` |
| `33af00504a11f6416bf00a42bc4c12461b401cf93858b9f1b49f576e20dcf665` | 1299 | `contracts/ConfidentialRouter.sol` |
| `3f80eb81c3f41828e7325473d47e23f0e219ab862ce9c9697a9a3f5a35bdaef1` | 114 | `contracts/CanonicalBridgedERC20.sol` |
| `916dbf5608ee4f7d7f858388fef03e026c3138370e19429aaa3fcf0de65bf69b` | 145 | `contracts/CanonicalMinters.sol` |
| `0bf2b4c8e32fa7866d647870b62945a63aa08e9dd55f1a79e58f69cbfb13b3f4` | 68 | `contracts/BtcCallExecutor.sol` |
| `2b189b7fc4c1dfef1ce07c641213820376fab7e7c1ddf9acf563ebd559beaf20` | 3284 | `guest/main.rs` |
| `56a40534d24f7d7745b8d10116f2a769d3461b2f036ad7803182797ff4961edb` | 1576 | `guest/reflect.rs` |
| `94fc8eb335ef7d815a16e19791d4fcf1111cfc424889fd045e25089c23518c78` | 7072 | `guest/cxfer-core/lib.rs` |
| `0421f65d866595fcf55bf5b7fc60ce0a5693d004000093dadb94109e4e584c10` | 335 | `guest/cxfer-core/eth_reflection.rs` |
| `0ccced2b6310c63ed599e47402cacf4536ded3a69370a76a680a7d19671dd0e0` | 138 | `guest/cxfer-core/sigma.rs` |
| `dec2659733c60b439e341669d6b59fb2fe4fd9362688d2a190d08b22507721ee` | 36 | `guest/elf-vkey-pin.json` |

---

# Proof-of-audit / model signature

**Audit ID:** `tacit-confidential-pool-static-audit/2026-06-24/GPT-5.5-Pro/14511596f7dc102e71ac1524f6fe436678da42c9ca6cac4e30d90689697bfe3f`  
**Signed-off-by:** GPT-5.5 Pro, OpenAI reasoning model  
**Signature type:** Model attestation over the uploaded bundle hash, file hashes, reviewed scope, findings, and timestamp above. This is not a cryptographic private-key signature.  
**Primary release verdict:** Do not ship production cross-chain reflection until H-01 is fixed.  
**Generated for:** Tacit Finance confidential cryptographic asset pool codebase inclusion.
