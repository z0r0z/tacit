# Tacit Finance — Confidential-Pool Core & SP1 Guest
## Security & Accounting Production-Readiness Audit

**Auditor model:** Claude Opus 4.8 (Anthropic)
**Audit date:** 2026-06-25
**Scope:** Immutable on-chain core (9 Solidity files) + SP1 zero-knowledge guest (5 Rust/JSON files), per package `README.md`.
**Method:** Static adversarial review — full reads of all in-scope files, encode↔decode trust-boundary reconciliation, storage-slot reconstruction, per-op conservation tracing. Proof system (`SP1VerifierGroth16`) treated as cryptographically sound, per scope.
**Companion audit:** Cross-referenced and de-duplicated against `TACIT_FINANCE_CONFIDENTIAL_POOL_AUDIT_GPT55PRO_2026-06-24.md`. Both audits ran against a **byte-identical bundle** (`SHA-256 14511596…bfe3f`; see Attestation).

---

## Verdict

**Do not ship the cross-chain / Bitcoin-reflection configuration yet. The EVM-only core is shippable after the medium/defensive items below.** The single-chain settlement loop and the guest's conservation core are genuinely robust: the committed `PublicValues` / `BitcoinReflectionPublicValues` layouts match the contract's `abi.decode` field-for-field (sub-structs included), every value an op moves out is bound either by a range proof or by an opening-sigma to a public `u64`, the per-op "value in = value out" kernel removes the fee leg correctly and rejects over/under-stated fees, and the reserve floor plus nullifier/spent-set gates are enforced fail-closed on every exit path traced. After an exhaustive read I found **no new standalone inflation or double-spend bug in the single-chain core**. The release blocker sits exactly where GPT-5.5 Pro placed it — the cross-chain reflection seam (**H-01**): the Mode-B Ethereum reflection is not bound to a source-chain domain and is still anchored to Sepolia. My complementary fund-critical finding (**N-01**) is that the live fast-lane Bitcoin-homed value-exit path is double-spend-safe **only while** that reverse reflection is operational and sound on the Bitcoin side — the EVM side is fail-closed, but the Bitcoin-side re-spend prevention lives outside this contract. Resolve H-01 (domain binding + production re-anchor + ELF/vkey regeneration) and the N-01 deployment-sequencing constraint before enabling reflection or fast-lane btcHomed exits.

### Severity summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 2 | H-01 (confirmed from GPT-5.5), **N-01 (new)** |
| Medium | 3 | M-01, M-02, M-03 (all confirmed from GPT-5.5) |
| Low | 4 | L-01, L-02 (confirmed from GPT-5.5), **N-02, N-03 (new)** |
| Info | 2 | **N-04, N-05 (new)** |
| **Total** | **11** | 6 confirmed · 5 new |

Fund-critical (loss / lock / inflation / double-spend): **H-01, N-01, M-03, N-02.**
Quality / defensive: **M-01, M-02, L-01, L-02, N-03, N-04, N-05.**

---

## A. Fund-critical findings

### H-01 — Mode-B Ethereum reflection is not source-domain-bound and is still Sepolia-anchored · **High** · *confirmed from GPT-5.5 Pro*

- **Files:** `guest/reflect.rs:277-285, 327-355`; `guest/cxfer-core/eth_reflection.rs:17-30, 159-166`; `contracts/ConfidentialPool.sol:1455-1465, 1482-1494`; `guest/elf-vkey-pin.json:15-34`.
- **Claim:** `EthReflectionPublicValues` commits a `prevSyncCommitteeRoot` but no `sourceChainId` / fork-digest / genesis-validators-root, and the pin still targets a Sepolia anchor. A consensus proof valid for one Ethereum-context domain is not distinguished from another, and the pool only gates `ethPoolReflected == address(this)`.
- **Independent verification:** Confirmed. I re-read the `EthReflectionPublicValues` definition and the contract's `BitcoinRelayPublicValues` decode site. The reflected-value struct carries the sync-committee transition and the pool-address echo, but nothing that pins the *domain* the beacon proof was produced under; the only contract-side gate on provenance is the `ethPoolReflected == address(this)` self-address check (`ConfidentialPool.sol:1482-1494`). The pin file's anchor block/period (`elf-vkey-pin.json:15-34`) is a testnet anchor. I concur with GPT-5.5 on both the finding and its High rating.
- **Exploit walkthrough:** A valid beacon/sync-committee proof generated against a non-production domain (or a domain whose validator set an attacker can influence) is accepted as a canonical Ethereum reflection because nothing forces the proof's domain to equal the production mainnet domain. The reflected digest then advances pool state (spent-set / reflection freshness) from an attacker-favorable source, undermining the cross-lane folding that the Bitcoin-homed exit path depends on (see N-01).
- **Minimal fix:** Add an immutable source-domain commitment to `EthReflectionPublicValues` — at minimum `sourceChainId`, and preferably the beacon fork-digest derived from `(current_fork_version, genesis_validators_root)` — and have the guest bind it and the contract require it to equal the pinned production value. Re-anchor the reflection to the production chain and **regenerate the ELF + vkey** so `elf-vkey-pin.json` pins the production program.
- **Confirm-the-fix check:** Attempt a settle/attest carrying a reflection proof produced under any non-production `(chainId, fork-digest, genesis-validators-root)`; it must revert. Diff the regenerated `elf-vkey-pin.json` anchor against the production genesis-validators-root and confirm equality.

---

### N-01 — Fast-lane Bitcoin-homed value exit is double-spend-safe only while Mode-B reflection is operational on the Bitcoin side · **High** · *new* · **needs confirmation (deployment-sequencing)**

- **Files:** `contracts/ConfidentialPool.sol:1755-1779` (consume-record), `:1518-1525` (`ConsumedCountStale` freshness gate), `:1700-1779` (btcHomed cross-lane enumeration); `guest/cxfer-core/eth_reflection.rs:159-166`; `guest/reflect.rs` (Mode-B fold). Shares the Mode-B root cause with H-01.
- **Claim:** The fast-lane btcHomed exit records `bitcoinConsumed[ν]` obligations gated by a *forward* `knownBitcoinRoot`, but its protection against the same note being re-spent natively on Bitcoin depends entirely on the *reverse* (Mode-B) reflection folding every consume into the Bitcoin spent set. That reverse leg is exactly the path H-01 shows is not yet production-sound, and the pin marks it deferred/testnet-anchored.
- **Why the EVM side is safe (one line):** It is fail-closed — once any consume exists, the `ConsumedCountStale` gate (`:1525`, `if (r.consumedCount != bitcoinConsumedCount) revert`) blocks any further spent-set advance until a reflection proof whose finalized slot covers that consume is supplied, enforcing Ethereum-senior ordering. The exposure is **not** on Ethereum.
- **Exploit walkthrough (Bitcoin side, contingent):** Enable btcHomed value exits in a configuration where Mode-B reflection is not yet live/sound on Bitcoin. A user fast-spends a Bitcoin-homed note on Ethereum (recorded in `bitcoinConsumed`, source UTXO still live on Bitcoin). Because the reverse fold that would mark that ν spent in the Bitcoin spent set is not operational (or accepts an attacker-favorable domain per H-01), the same underlying value is then spent again natively on Bitcoin — a cross-lane double-spend. The EVM contract never sees the second spend; the seam is outside it.
- **Overlap note:** This is **not** a second instance of H-01's domain-binding gap; it is the *exit-side gating + operational-sequencing* dependency that makes H-01's seam fund-critical for the fast lane. Triage together, fix H-01 first.
- **Minimal fix:** Gate fast-lane btcHomed value exits behind a deploy-time/operational assertion that Mode-B reverse reflection is live and domain-bound (post-H-01). Concretely: do not arm btcHomed exits (keep the exit path reverting) until `BITCOIN_RELAY_VKEY` pins the regenerated production program *and* a first valid production reflection has advanced the spent set. Document the required enable-ordering as an invariant, not a runbook step.
- **Confirm-the-fix check:** With Mode-B disabled/testnet, attempt a btcHomed value exit — it must revert. After enabling production Mode-B, run an end-to-end test: fast-spend on Ethereum, then attempt the corresponding native Bitcoin spend; the reverse fold must have marked the ν spent so the second spend is rejected by the Bitcoin-side spent-set membership.

---

## B. Medium findings (all confirmed from GPT-5.5 Pro)

### M-01 — Reflection-disabled deploy still calls the verifier with a zero vkey · **Medium** · *confirmed*

- **Files:** `contracts/ConfidentialPool.sol:705-719, 1482-1484`.
- **Claim/verification:** When `BITCOIN_RELAY_VKEY == 0` (reflection intentionally disabled), `attestBitcoinStateProven` still reaches the verifier call with a zero vkey instead of rejecting up front. Confirmed by reading the attest entry and constructor guards. Not fund-loss — the verifier rejects — but it wastes gas and muddies the disabled-mode contract.
- **Minimal fix:** At the top of the attest path: `if (BITCOIN_RELAY_VKEY == 0) revert ReflectionDisabled();`.
- **Confirm-the-fix check:** Deploy with `BITCOIN_RELAY_VKEY == 0`; any attest call reverts with `ReflectionDisabled` before any external verifier call (assert no verifier interaction in the trace).

### M-02 — Collateral oracle / TWAP decimals unchecked before exponentiation · **Medium** · *confirmed* · governance-driven

- **Files:** `contracts/CollateralEngine.sol:281-295, 416-449, 462-467`.
- **Claim/verification:** Feed decimals are read and used to scale prices without a bound/cache at configuration time; a misconfigured or hostile feed decimals value drives the price exponentiation. Confirmed: the pricing helpers consume `decimals()` from the configured feeds at use-time. Reachable only via governance (`setFeeds`), so it is a governance-trust / defensive issue, not an unprivileged exploit.
- **Minimal fix:** Bound and cache feed decimals at `setFeeds`; use a `fullMulDiv`-style mul-div for the price scaling to avoid intermediate overflow.
- **Confirm-the-fix check:** Configure a feed reporting an out-of-range decimals value; `setFeeds` must revert. Fuzz price scaling across the cached-decimals domain for overflow-freedom.

### M-03 — cBTC margin enforcement trusts caller-supplied `vBtc` rather than the pool-recorded lock value · **Medium** · *confirmed* · dormant until governance arms the module

- **Files:** `contracts/ConfidentialPool.sol:394`; `contracts/CollateralEngine.sol:349-355, 475-484, 560-603`.
- **Claim/verification:** The margin check path consumes a caller-supplied `vBtc` instead of the authoritative pool-recorded `cbtcLockVBtc`. Confirmed by tracing the value into the engine's margin/liquidation math. Fund-critical *in principle* (a caller could understate locked BTC value to dodge margin), but dormant until governance arms the cBTC module — so contingent, not live.
- **Minimal fix:** Read the authoritative pool value (`cbtcLockVBtc`) inside the engine; never accept a caller-passed BTC value for margin enforcement.
- **Confirm-the-fix check:** Submit a cBTC margin/liquidation action with a `vBtc` that disagrees with `cbtcLockVBtc`; it must be ignored or revert. Unit-test margin using only pool-recorded values.

---

## C. Low / defensive findings

### L-01 — Permit2 pulls are not bound to the token/spender/amount actually transferred · **Low** · *confirmed from GPT-5.5*

- **Files:** `contracts/ConfidentialRouter.sol:930-939` (`_pullPermit2`), call sites `:365-378, 571-588, 601-612`.
- **Claim/verification:** `_pullPermit2` runs `PERMIT2.permit(msg.sender, permitSingle, signature)` best-effort (try/catch) and then `PERMIT2.transferFrom(msg.sender, address(this), uint160(amount), token)` using the *function arguments*, never asserting that `permitSingle.details.token == token`, `permitSingle.details.amount >= amount`, or `permitSingle.spender == address(this)`. Confirmed by reading the helper. The transfer pulls only against `msg.sender`'s pre-existing router allowance into the router itself — so this is not third-party theft. The realistic risk is **relayer-context**: where a relayer submits a user's signed `permitSingle`, a mismatch lets the router pull a *different* token/amount the user holds a standing Permit2 allowance for. Low, as rated.
- **Minimal fix:** Require `permitSingle.details.token == token`, `permitSingle.spender == address(this)`, and `permitSingle.details.amount >= amount` before the transfer.
- **Confirm-the-fix check:** Call a permit2 entry with a `permitSingle` whose `token`/`spender`/`amount` disagree with the call args; it must revert rather than fall through to `transferFrom`.

### L-02 — Escrow-mode farm campaigns are announceable without proving the treasury is funded · **Low** · *confirmed from GPT-5.5*

- **Files:** `contracts/FarmController.sol:129-150` (`notifyRewardAmount`); `contracts/ConfidentialPool.sol:1869-1876`.
- **Claim/verification:** `notifyRewardAmount` sets `rate`/`periodFinish` with no check that the per-farm treasury holds the implied reward. Confirmed. This is benign because harvest is **treasury-bounded by the pool before** `onCdpMint` is called and the pool debit fails closed on an under-funded treasury — so an over-announced rate simply yields harvests that revert until funded, never an over-payout. Defensive/UX only.
- **Minimal fix:** Optional `fundAndNotify` preflight that asserts treasury ≥ rate·duration (or document the announce-then-fund ordering as intended Synthetix behavior).
- **Confirm-the-fix check:** Notify a rate exceeding the funded treasury, then harvest; the harvest must revert on the pool's treasury debit (and a `fundAndNotify`, if added, must revert at notify time).

### N-02 — cBTC can become under-collateralized after a locker rug when `escrowRatioBps < 10000` · **Low** · *new* · **needs confirmation** · parameter-dependent

- **Files:** `contracts/CollateralEngine.sol:560-603` (escrow slash math), `contracts/ConfidentialPool.sol` cBTC mint/unwrap path (`cbtcLockSpent` / `cbtcBackingSats`).
- **Claim:** On a locker rug (the real BTC lock is spent), the engine slashes only the ETH escrow sized as `ethWeiForBtc · escrowRatioBps / 10000`, while minted cBTC notes remain unwrappable to tacBTC. If governance configures `escrowRatioBps < 10000`, the on-pool collateral after a rug is less than the outstanding cBTC obligation.
- **Why partly safe (one line):** By design the off-pool buffer (`cbtcBackingSats`) is intended to absorb the shortfall, so this is a *parameter + buffer-sizing* dependency rather than an unconditional loss — flagged for confirmation that the buffer policy is enforced operationally.
- **Minimal fix:** Either require `escrowRatioBps >= 10000` for the rug-exposed configuration, or assert at mint time that `cbtcBackingSats` covers the `(10000 − escrowRatioBps)` shortfall band; document the buffer as a hard invariant, not a treasury policy.
- **Confirm-the-fix check:** Simulate a rug with `escrowRatioBps < 10000` and confirm total recoverable collateral (escrow slash + buffer draw) ≥ outstanding cBTC value; otherwise the configuration must be rejected at setup.

### N-03 — Confidential swap pins a live pre-reserve, so any interleaved settle griefs it into a re-prove · **Low** · *new* · inherent to design

- **Files:** `contracts/ConfidentialPool.sol:2036` (`reserveAPre == live` check in confidential `OP_SWAP`).
- **Claim:** A confidential `OP_SWAP` commits `reserveAPre` equal to the live reserve at proof time; any public swap or other settle that touches the same pool first shifts the reserve and forces `PoolReserveMismatch`, so the confidential swap must be re-proven.
- **Why safe (one line):** This is a liveness/griefing cost (re-prove), never a loss or double-spend — the mismatch is fail-closed and correct; it is inherent to proving against a public AMM reserve.
- **Minimal fix (optional):** Out of scope for fund-safety; if UX matters, consider a bounded-slippage reserve window or a commit-reveal ordering for confidential swaps. No change required for production-safety.
- **Confirm-the-fix check:** N/A for safety; if a slippage window is added, assert it cannot widen into value extraction beyond the proven bound.

---

## D. Informational

### N-04 — Add compiler-emitted storage-layout CI to pin the four reflected slot constants · **Info** · *new* (echoes GPT-5.5's CI recommendation, with an independent reconciliation)

- **Files:** `guest/cxfer-core/eth_reflection.rs` slot constants vs `contracts/ConfidentialPool.sol` storage layout.
- **Independent reconciliation (performed this audit):** I hand-reconstructed the full persistent storage layout — accounting for `ReentrancyGuardTransient` (transient storage, no persistent slots) and that immutables/constants occupy none — and confirmed every hardcoded guest constant matches: `CROSSOUT_SLOT_INDEX = 76` ↔ `crossOutCommitment`(76); `CONSUMED_SLOT_INDEX = 119` ↔ `bitcoinConsumed`(119); `CONSUMED_COUNT_SLOT_INDEX = 120` ↔ `bitcoinConsumedCount`(120); `CONSUMED_AT_SLOT_INDEX = 163` ↔ `bitcoinConsumedAt`(163). All four reconcile exactly today.
- **Why flagged:** These are immutable contracts but the guest constants are hand-maintained; any future re-ordering of state in a redeploy would silently break the reflection without a layout assertion. This is a process safeguard, not a current bug.
- **Minimal fix:** Add a CI step that emits `forge inspect ConfidentialPool storage-layout` (or `solc --storage-layout`) and asserts the four slot indices equal the guest constants on every build.
- **Confirm-the-fix check:** Perturb one state-variable order in a scratch build; CI must fail the slot-equality assertion.

### N-05 — Router-relayed settle can strand a mis-built non-`token` settler fee in the router · **Info** · *new*

- **Files:** `contracts/ConfidentialRouter.sol:240-261` (`wrapAndSettleWithPermit2` and sibling), `_refund(token, msg.sender)`.
- **Claim:** `wrapAndSettle*` runs `POOL.settle` with `msg.sender == router`, so any `pv.fees` leg is paid to the router; the helper only sweeps a fee denominated in the input `token` back to the caller. A fee leg in any *other* asset (a mis-built, non-fee-free batch) accumulates in the router with no sweep-all.
- **Why safe (one line):** Documented as a self-proved/fee-free constraint; the residue is the caller's own mis-build, never another user's funds, and there is no payout-from-router vector (the fee is an output to the settler, not a draw). Info-level hygiene.
- **Minimal fix:** Either revert if `pv.fees` is non-empty in the router-relayed path, or add a permissionless `sweep(asset)` returning router-held dust to a caller-specified address.
- **Confirm-the-fix check:** Submit a router-relayed settle carrying a fee in a non-input asset; with the fix it must revert (or the dust must be sweepable), never silently strand.

---

## E. Positive checks — paths verified safe (one line each)

These are the highest-value confirmations: paths an attacker would probe first, traced to ground and found sound.

- **Encode↔decode (PublicValues).** Guest `sol!` `PublicValues` (`main.rs:82-156`) matches the contract struct (`ConfidentialPool.sol:555-586`) field-for-field including every sub-struct; committed via `pv.abi_encode()` (`main.rs:3283`). No trust-boundary drift.
- **Encode↔decode (Bitcoin reflection).** Guest `BitcoinReflectionPublicValues` (`reflect.rs:52-103`) matches contract `BitcoinRelayPublicValues` (`ConfidentialPool.sol:1455-1472`) field-for-field.
- **Storage slots.** All four reflected slot constants reconcile exactly against a hand-reconstructed layout (see N-04).
- **Conservation kernel.** `verify_kernel` / `verify_kernel_with_fee` (`lib.rs:77-110`) remove the fee leg from excess and reject over/under-stated fees; the documented refund-fee regression is closed by the `fee < amount` re-open guard.
- **Fee bound on every value path.** `fee < amount` (or `<=` where the bound is the true note value) is present on swap, lp_add, lp_remove, unwrap, bid, route, cdp-mint/close/liquidate, adaptor-refund, stealth-claim/refund, and farm-harvest (`main.rs` sites enumerated in working notes). No path mints fee headroom.
- **Range vs opening-sigma coverage.** `verify_range` is applied to every hidden-value output (`OP_TRANSFER`, `OP_BRIDGE_BURN`, `OP_BRIDGE_MINT`); every other output-creating op binds its value to a public `u64` via opening-sigma — equivalent to a range check. No unbounded output value.
- **Reserve floor.** `evmNullifiersSpent ≤ nextLeafIndex` (`ConfidentialPool.sol:1942-1949, 1994`) counts only EVM-homed spends; bridge-mint and lock/CDP spends use disjoint namespaces and do not touch the floor. Sound defense-in-depth backstop.
- **btcHomed cross-lane enumeration.** crossOuts barred; value-bearing fields require nullifiers + a recorded `bitcoinConsumed`; direct withdrawals/fees must be `poolMinted` (`ConfidentialPool.sol:1700, 1728-1779`). (Operational dependency captured as N-01.)
- **CDP close/liquidate.** Guest always requires a non-zero `cdp_position_root` + membership (`main.rs:2372-2384, 2538-2550`); the contract's "if nonzero, must be known" gate (`:1843-1849`) closes the `debtValue == 0` bypass.
- **Bridge mint / stealth mint.** Burn set pins the exact destination leaf; conservation needs the burned blinding, so only the burner can mint. Sound.
- **Sentinel roots.** Zero spent/burn/pool reflected roots are rejected (`ConfidentialPool.sol:1505-1514`), preventing the guest's "skip membership when root == 0" branch from being weaponized.
- **Lock-set authorization.** A batch spending a locked note must pin a known non-zero lock root (`ConfidentialPool.sol:1782-1790`); a forged lock set cannot authorize a claim/refund.
- **Asset factory canonicality.** `deriveAssetId` binds `(chainid, factory, salt, etcher, meta_hash)` (`CanonicalAssetFactory.sol:114-122`); EVM-native etch ids self-certify metadata; bridged canonicality resolves via the pool's first-write-wins authority. CREATE2 slot binds minter+metadata; double-deploy reverts. Clean.
- **Standalone minters.** `CanonicalMinter` can only etch a fresh EVM-native id (disjoint from any Bitcoin asset id) and a bridged asset must have the pool/bridge as `MINTER`, so a free-mintable minter can never be a bridged asset's authority. `CappedMintMinter` tracks lifetime `minted` monotonically, authority-gated, zero/self recipient barred. Clean.
- **Farm accounting.** Reward-per-share accrual is clamped to `min(now, periodFinish)` and to `totalShares > 0`; harvest bound `debtValue·PRECISION ≤ shares·(rps − rps_entry)`; bond rejects backdated `rps_entry`; `RECEIPT_MODE` blocks bare-bond dilution; rate bounded to `u64` to keep accrual overflow-free; `setLockUntil` can only shorten. MINT mode mints only the controller's own derived debt asset (`keccak("tacit-cdp-debt-v1"‖controller)`), contained.
- **Token / executor.** `CanonicalBridgedERC20` mint/burn are MINTER-gated and reject zero/self; `BtcCallExecutor` respects CEI, binds target/calldata/caller/executor to a record hash, and is one-shot. Clean.
- **Bitcoin relay.** `advanceTip` / `retarget` enforce canonical compact `nBits`, PoW, MTP/future-drift timestamp rules, heaviest-chain fork choice, branch-dependent retarget guard, and a fresh epoch-start read (`BitcoinLightRelay.sol:168-314`). No production-blocker found.
- **Registration backstop.** `_register` reverts foreign-ERC20 + cross-chain-link (`ConfidentialPool.sol:935`); native-ETH link is constructor-only and unreachable from `registerWrappedAuto`. Sound (docstring slightly understates the guard, not a bug).

---

## F. Deduplication summary (GPT-5.5 Pro → this audit)

| GPT-5.5 finding | Severity (GPT) | This audit's disposition |
|---|---|---|
| H-01 Mode-B not domain-bound / Sepolia-anchored | High | **Confirmed**, independently verified; rated High. See **H-01**. |
| M-01 zero-vkey verifier call when reflection off | Medium | **Confirmed**. See **M-01**. |
| M-02 oracle/TWAP decimals unchecked | Medium | **Confirmed** (governance-driven). See **M-02**. |
| M-03 cBTC margin trusts caller `vBtc` | Medium | **Confirmed** (dormant until armed). See **M-03**. |
| L-01 Permit2 pull not bound | Low | **Confirmed**; clarified relayer-context as the realistic risk. See **L-01**. |
| L-02 farm announce without funded treasury | Low | **Confirmed**; verified harvest fails closed. See **L-02**. |

**New in this audit (not in GPT-5.5):** N-01 (fast-lane btcHomed ↔ Mode-B operational dependency, High), N-02 (cBTC under-collateralization on rug when `escrowRatioBps<10000`, Low), N-03 (confidential-swap pre-reserve grief, Low), N-04 (storage-layout CI + independent slot reconciliation, Info), N-05 (router non-`token` settle-fee residue, Info).

**No disagreements** with GPT-5.5 on any finding or severity. Both audits converge on the same release blocker (the Mode-B reflection seam) and the same assessment that the single-chain EVM core + guest conservation are robust.

---

## G. Fix-priority punch-list (work straight down)

1. **H-01** — Add source-domain commitment (`sourceChainId` + beacon fork-digest/genesis-validators-root) to `EthReflectionPublicValues`; bind in guest, require in contract; re-anchor to production; **regenerate ELF + vkey** and re-pin. *(Release blocker.)*
2. **N-01** — Do not arm fast-lane btcHomed value exits until production Mode-B (post-H-01) is live and has advanced the spent set; encode the enable-ordering as an on-chain/deploy invariant, not a runbook. *(Release blocker; fix after H-01.)*
3. **M-03** — Read authoritative `cbtcLockVBtc` in the engine; never trust caller `vBtc`. *(Before arming cBTC.)*
4. **M-02** — Bound + cache feed decimals at `setFeeds`; use `fullMulDiv`. *(Before arming the collateral oracle.)*
5. **M-01** — `if (BITCOIN_RELAY_VKEY == 0) revert ReflectionDisabled();` at the top of attest.
6. **N-02** — Require `escrowRatioBps >= 10000` for the rug-exposed config, or assert buffer covers the shortfall band; make the buffer a hard invariant. *(needs confirmation.)*
7. **L-01** — Assert `permitSingle.token/spender/amount` match the transfer in `_pullPermit2`.
8. **L-02** — Add `fundAndNotify` preflight (or document announce-then-fund as intended).
9. **N-05** — Revert on non-empty `pv.fees` in router-relayed settle, or add a permissionless dust `sweep`.
10. **N-04** — Add storage-layout CI asserting the four slot constants on every build.
11. **N-03** — No action required for safety; optional UX hardening only.

---

## Attestation — Proof of Audit

```
Audit ID:    tacit-confidential-pool-static-audit/2026-06-25/Claude-Opus-4.8/
             14511596f7dc102e71ac1524f6fe436678da42c9ca6cac4e30d90689697bfe3f
Auditor:     Claude Opus 4.8 (Anthropic)
Date:        2026-06-25
Method:      Full-read static adversarial review; encode↔decode reconciliation;
             storage-slot reconstruction; per-op conservation tracing.
Proof system: SP1VerifierGroth16 treated as cryptographically sound (per scope).
Companion:   Cross-referenced & de-duplicated vs GPT-5.5 Pro audit (2026-06-24),
             which ran against the same bundle hash below.

Audited bundle (byte-identical to the GPT-5.5 Pro audit):
  SHA-256(tacit-audit-bundle.zip) = 14511596f7dc102e71ac1524f6fe436678da42c9ca6cac4e30d90689697bfe3f

Per-file SHA-256 (in-scope):
  ConfidentialPool.sol        ff957d80fb24c8f657ab03f9b326a5bde82f1b12665c96a8f86438f78606e948   2319 L
  CollateralEngine.sol        f8d63fc3244dde2c6961cf09cb675bc59146956fbb0d33725b84041fbd5b40bd    853 L
  FarmController.sol          4523b524cbc14f034f5aad462a544fbdddd9b6b99c924c5800ae6b35ea6f6d46    282 L
  CanonicalAssetFactory.sol   7e267ce3def4c6ab718f8323229d67d50d5a7140a3137b07f4295f7e766728e4    234 L
  BitcoinLightRelay.sol       e0fd0ff8f59fffa0aea8540bbfebf20ae027cee665ee5fe95711a1f59130d377    547 L
  ConfidentialRouter.sol      33af00504a11f6416bf00a42bc4c12461b401cf93858b9f1b49f576e20dcf665   1299 L
  CanonicalBridgedERC20.sol   3f80eb81c3f41828e7325473d47e23f0e219ab862ce9c9697a9a3f5a35bdaef1    114 L
  CanonicalMinters.sol        916dbf5608ee4f7d7f858388fef03e026c3138370e19429aaa3fcf0de65bf69b    145 L
  BtcCallExecutor.sol         0bf2b4c8e32fa7866d647870b62945a63aa08e9dd55f1a79e58f69cbfb13b3f4     68 L
  guest/main.rs               2b189b7fc4c1dfef1ce07c641213820376fab7e7c1ddf9acf563ebd559beaf20   3284 L
  guest/reflect.rs            56a40534d24f7d7745b8d10116f2a769d3461b2f036ad7803182797ff4961edb   1576 L
  guest/cxfer-core/lib.rs     94fc8eb335ef7d815a16e19791d4fcf1111cfc424889fd045e25089c23518c78   7072 L
  guest/cxfer-core/eth_reflection.rs 0421f65d866595fcf55bf5b7fc60ce0a5693d004000093dadb94109e4e584c10  335 L
  guest/cxfer-core/sigma.rs   0ccced2b6310c63ed599e47402cacf4536ded3a69370a76a680a7d19671dd0e0    138 L
  guest/elf-vkey-pin.json     dec2659733c60b439e341669d6b59fb2fe4fd9362688d2a190d08b22507721ee     35 L
```

**Attestation statement.** I, Claude Opus 4.8, performed the static security and accounting review described above against the bundle whose SHA-256 hashes are recorded here. The findings reflect my analysis as of 2026-06-25. This is a model-authored attestation of work performed — not a cryptographic key signature — and verifies bundle identity by hash, mirroring the companion GPT-5.5 Pro audit's framing. A static review cannot prove the absence of all defects; in particular, the SP1 proof system is trusted per scope, and items marked **needs confirmation** (N-01 deployment-sequencing, N-02 buffer policy, M-02/M-03 governance configuration) require operational/parameter verification the code alone cannot settle. Re-running the hashes above against the delivered bundle reproduces this attestation's provenance.

— *End of report.*
