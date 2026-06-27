# Tacit — Ultracode Hardening Run (Opus 4.8)

**Model / mode:** Claude **Opus 4.8**, **Ultracode** mode — multi-agent fan-out orchestration
(parallel finder → adversarial verifier → synthesizer workflows, ~75 sub-agents across two passes).
**Date:** 2026-06-27 · **Branch:** `confidential-relay-fees` · **Posture:** pre-lock hardening follow-up.

This run is a **follow-up hardening pass** to the conclusive GPT-5.5 Pro and Opus 4.8 (Max) reviews
([`AUDITS.md`](./AUDITS.md)). Its purpose was narrower and complementary: a fresh, adversarial,
*fanned-out* sweep over the newest immutable work — the **trustless Bitcoin-lane farm** (LP_BOND /
HARVEST / UNBOND), the **cross-chain feature parity** of OTC/AMM/LP/farm on both lanes, and the
**relay-fee** surface — to close gaps that a single-pass review would not surface. It found and fixed
**two lock-blockers introduced by the in-flight farm work**, plus several guest↔mirror parity gaps.

## Method

Two background workflows, each `find → adversarially-verify → synthesize`:

1. **Cross-chain feature-parity sweep** — one agent per primitive × lane (OTC, AMM-swap, LP-add,
   LP-remove, farm-bond, farm-harvest/unbond), checking each works end-to-end on *both* the EVM
   (settle) and Bitcoin (reflection) lanes so a die-hard on either chain is self-sufficient.
2. **Final pre-lock safety sweep** — every changed surface re-verified against `HEAD`, hunting any
   *new* gap the farm/relay-fee batch introduced, plus a fund-safety/soundness sweep.

Each candidate finding was handed to an independent skeptic agent prompted to **refute** it before it
was accepted. Every accepted finding below was then fixed and re-verified (guest `cargo check` /
`cargo test`, `node --check`, and the relevant parity test).

## Findings → fixes

| # | Severity | Finding | Resolution | Commit |
|---|---|---|---|---|
| 1 | **Critical** | **Farm-receipt spend theft.** Lifting the receipt preimage (`owner`/`nonce`/`shares`/`rps_entry`) into the *public* envelope made membership-of-the-leaf the only gate — any observer could reconstruct a victim's receipt and broadcast a harvest/unbond redirecting the reward/principal to their own note (the `harvester_sig`/`unbonder_sig` already in the envelopes were being dropped). | The receipt `owner` is now a **one-time x-only pubkey**; `fold_lp_harvest`/`fold_lp_unbond` verify a **BIP-340 signature over the materialized output** (`reward_r`/`lp_return_r` + outpoint), mirrored in the JS attester. Public preimage gates *membership*; the signature gates the *spend*. | `02fce0d` |
| 2 | **Critical** | **Farm-resume stream desync.** The guest reads 7 fields/farm on resume (`launcher_pubkey` + `lp_asset`), but the sole witness serializer wrote only 5 — the first reflection resume after any `FARM_INIT` would frame-desync and **brick the forward-only digest** (which gates all confidential settlement). Latent only because no fixture carried non-empty prior farm state. | Serializer now emits `launcher_pubkey(33)` + `lp_asset(32)` in the exact guest read order. | `02fce0d` |
| 3 | High | **Guest test suite did not compile** (stale tuple destructures of the new envelope parsers) → the genesis-digest pin and all JS-mirror parity tests were unrunnable on the re-prove path. | Parsers/folds + the farm lifecycle KAT rewritten to the new signatures, now signing with real keypairs. **150/150 cxfer-core green.** | `02fce0d` |
| 4 | High | **`T_FARM_REFUND` (0x3E) guest↔JS divergence.** The guest requires the launcher's pubkey binding + BIP-340 sig; the JS mirror folded the treasury draw *unconditionally* → a bad refund diverges the attester digest. | `foldFarmRefund` now binds the launcher pubkey + verifies the sig before the draw, mirroring the guest; classifier returns the launcher fields. | `b08079a` |
| 5 | High | **LP-add first-mint floor missing on the Bitcoin lane.** The EVM `OP_LP_ADD` asserts `isqrt(Δa·Δb) > MINIMUM_LIQUIDITY`; the Bitcoin `fold_lp_add` did not, so a thin first seed mints ~zero founder shares and burns the deposit. | Added the matching `> MINIMUM_LIQUIDITY` floor to the Bitcoin fold + JS mirror. | `02fce0d` |
| 6 | Medium (day-1) | **cBTC mint opening-sigma context mismatch.** The guest binds the opening over `[v_btc, fee]` opening to `v_btc − fee` (the gasless **zap-into-cBTC** relay), but the dapp bound a single amount → the 1:1-peg mint was un-provable. | Dapp sigma aligned to bind `[v_btc, fee]` and commit the bearer note to the net (`fee = 0` ⇒ self-mint = `v_btc`). Fee-carrying parity case added. | `b0955d8` |
| 7 | Low | swap_route KAT carried pre-k-floor test data (couldn't run while the suite didn't compile). | Refreshed to k-preserving values. | `02fce0d` |
| — | Info | **OTC is EVM-only on the confidential lane** (two-distinct-asset atomic swap); the Bitcoin cxfer fold is single-asset. Acceptable as an EVM-only primitive (like CDP/cBTC/cUSD, which require Bitcoin covenants), but copy should not imply a Bitcoin OTC path. | Dispositioned: by-design EVM-only; align UI copy in the dapp layer. | — |
| — | Info | Bitcoin `swap_batch` resolves only the canonical (no-skim) pool id; single-swap / route handle protocol-fee pools. | Dispositioned: single/route cover it; batch parity is a follow-up. | — |

The **non-farm batch** the sweep also re-verified — constant-product k-floor, saturating rps accrual,
the LP_BOND share-lock kernel, the duplicate-nullifier dedup, and the owner-authorized CDP-close —
were independently confirmed **correct**.

## Residual (not lock-blocking)

- **Covering resume fixture** — finding #2 is fixed but latent; a reflection fixture with non-empty
  `farmRewards` prior state must exercise the `n_farms ≥ 1` resume path through the digest-match
  harness *before* the box re-prove, so the gate can't silently re-open.
- **Box re-prove** — the new envelope formats + owner-auth domains are part of the reflection vkey.
- **Dapp wallet layer** (not immutable) — the Bitcoin-lane farm builders + recovery decoders need the
  receipt fields + one-time-key signing threaded through to be usable in the UI.

---

## Hand-off prompt for a fresh independent audit round

The most valuable next step before lock is **another fresh-context adversarial pass over the immutable
surface from a different agent**. The copy-pasteable, self-contained prompt naming every immutable file
follows below.

The prompt below was itself synthesized by the inventory pass of this run (8 agents enumerating every
immutable layer). It is self-contained — paste it into a fresh agent in a clean context.

```
You are a senior smart-contract + zero-knowledge security auditor performing a FUND-CRITICAL pre-deployment review of "Tacit", a confidential cross-chain DeFi protocol (a multi-asset shielded pool on Ethereum whose state is folded forward from real Bitcoin blocks by an SP1 zkVM reflection proof). The repo root is /Users/z/tacit. This review gates a deployment that will hold REAL USER FUNDS on Ethereum mainnet and Bitcoin.

THREAT MODEL (rank findings by this):
- FUND-CRITICAL = any path that lets an attacker STEAL value, INFLATE/mint value with no backing, double-spend value ACROSS the Bitcoin<->Ethereum lanes, permanently LOCK user funds, or BRICK the chain (a wedged attester halts ALL settlement and bridge withdrawals — treat a brick as fund-critical because matured positions/liquidations cannot execute).
- The reflection digest gates ALL settlement: the on-chain ConfidentialPool pins bitcoinPoolRoot/bitcoinSpentRoot/bitcoinBurnRoot and a chained priorDigest that are the OUTPUT of the SP1 reflection guest, re-derived byte-for-byte by an off-chain JS mirror before submission. A divergence between guest and JS mirror fail-stops the chain; a soundness flaw in the guest (or a wrong pinned vkey) lets a forged Bitcoin state mint or unlock value on Ethereum.
- The SP1 verifier and proving keys are the on-chain trust boundary: the Solidity gates `SP1_VERIFIER.verifyProof(PROGRAM_VKEY, ...)` for settle and `verifyProof(BITCOIN_RELAY_VKEY, ...)` for attest. If a pinned vkey does not correspond to the committed guest ELF, or a witness serializer disagrees with the guest's io::read order, proofs are either unprovable (brick) or prove a different program than intended (soundness gap).

THE IMMUTABLE SURFACE TO AUDIT (every path below is "immutable": once deployed/proven it cannot change without a redeploy or a new proving key — read the actual files, do not assume):

A) Solidity (the value authority + the vkey/address pins). ConfidentialPool.sol is the ONLY contract with no admin/upgrade and is the value authority:
- contracts/src/ConfidentialPool.sol (settle + attestBitcoinStateProven; note tree, nullifier set, escrow, AMM/CDP/cBTC state, bridge mint/burn gates)
- contracts/src/CollateralEngine.sol (mutable Ownable->DAO CDP controller + cBTC escrow + reserve + TSR; onlyPool; holds price/ratio policy; cannot mint confidential assets or move backing)
- contracts/src/FarmController.sol, CanonicalAssetFactory.sol, CanonicalBridgedERC20.sol, CanonicalMinters.sol
- contracts/src/lib/BitcoinLightRelay.sol (maturity root of trust for reflection AND the tETH bridge), SP1PoolRootVerifier.sol (bridge state-transition verifier), TacitBridgeMixer.sol, Groth16Verifier.sol, lib/PoseidonT3.sol
- contracts/src/TacitRelayer.sol, ConfidentialRouter.sol (periphery, replaceable), BtcCallExecutor.sol, ChainlinkEthBtcAdapter.sol, MerkleDistributor.sol
- contracts/script/DeployV1Suite.s.sol + DeployV1SuiteCreateX.s.sol (VKEY/codehash/address PIN POINT), contracts/foundry.toml (via_ir=true, optimizer_runs=1 — the ONLY EIP-170 fit for the pool)

B) SP1 SETTLE guest (ops 0-30; the proof I/O ABI the contract decodes):
- contracts/sp1/confidential/src/main.rs (3829 lines; witness header + per-op io::read, op dispatch, all confidential invariants, io::commit_slice(PublicValues)) and contracts/sp1/confidential/Cargo.toml

C) SP1 REFLECTION guest (forward-only Bitcoin-state fold; highest blast radius):
- contracts/sp1/confidential/src/reflect.rs (1661 lines), src/swap_batch.rs, src/groth16.rs, src/babyjubjub.rs (the LIVE cross-curve verifier)

D) SP1 shared verification core (cxfer-core — audit jointly with B and C; this is the most load-bearing crate):
- contracts/sp1/confidential/cxfer-core/src/lib.rs (kernels verify_kernel/_with_fee/_with_fee_bound @L77-112, verify_opening_sigma @L325, bip340_verify @L394, verify_range @L918, nullifier @L1183, cdp_debt_asset_id @L1303, ScanReflection genesis() @L2971 / digest() @L2998, genesis-pin test @L4984)
- cxfer-core/src/bitcoin.rs (txid/merkle/witness-commitment/envelope parsers), eth_reflection.rs, burn_deposit.rs, sigma.rs (TEST-ONLY mirror — confirm it is NEVER wired into the proving build), bjj.rs

E) Prover host + witness serializers + vkey pins (the proof I/O byte contract + the pinned keys):
- contracts/sp1/reflect-stdin/src/lib.rs (THE single source-of-truth reflection SP1Stdin producer; shared by all three reflection provers)
- contracts/sp1/confidential/elf-vkey-pin.json (AUTHORITATIVE top-level program_vkey=0x00f36e4c / bitcoin_relay_vkey=0x00a01b68; the guest_state + deployed_* blocks are descriptive prose that HAS LAGGED — the live Sepolia pool runs a different generation 0x00d5b572/0x005e6adc; treat prose as UNTRUSTED), verify-vkey-pin.sh, verify-reflection-slots.sh
- contracts/sp1/elf-vkey-pin.json + verify-vkey-pin.sh (bridge-guest pin for SP1PoolRootVerifier)
- contracts/sp1/confidential/exec-reflect-prove.rs, exec-reflect-fixture.rs, harnesses/exec-prove.rs (read exemplar) + the 31 other harnesses/exec-*.rs (per-op box settle provers with inline serializers) + harnesses/Cargo.toml
- contracts/sp1/reflect-exec/src/main.rs (DIGEST_MATCH off-GPU parity), vkey_derive.rs, the *_execute.rs laptop validators
- contracts/sp1/eth-reflection/prover-host/src/bin/{bitcoin_prove,eth_prove,eth_vkey}.rs (Mode-B recursion + cross-cycle anchor + ETH_REFLECTION_VKEY coherence)

F) Crypto primitives:
- contracts/sp1/program/src/secp.rs (bridge-guest Pedersen NUMS), contracts/sp1/tree/src/poseidon.rs (bridge/mixer Merkle hash). (BP+/Pedersen/BIP-340/cross-curve live in cxfer-core lib.rs + babyjubjub.rs, layer D.)

G) JS attester mirror (effectively immutable — its output IS the pinned on-chain roots; a divergence fail-stops the chain):
- dapp/confidential-reflection-scan-indexer.js (digest recompute), dapp/confidential-pool.js (assembler + state engine + all fold mirrors + kernel verifiers + AMM math), dapp/burn-deposit-bitcoin.js (classifier + Bitcoin wire parsers + canonical-vout map), dapp/confidential-reflection-indexer.js, dapp/amm-kernel.js, dapp/amm-envelope.js, dapp/confidential-cdp.js, dapp/bulletproofs.js, dapp/bulletproofs-plus.js, dapp/amm-sigma.js, dapp/amm-bjj.js, worker/src/reflection-attest.js

PRIORITISED HUNT LIST (spend most effort here — these are the historical bug classes):
1. CROSS-LANE VALUE DUPLICATION: In ConfidentialPool._settle's btcHomed branch, the two field-enumeration reverts (BtcHomedValueExitMustBridge) must cover EVERY value-bearing PublicValues field; a btcHomed value-exit must record source ν in bitcoinConsumed and advance bitcoinConsumedCount by exactly the distinct ν count, and withdrawals/fees must be pool-minted-only. Find any value-bearing field that escapes to Ethereum without being recorded. Mirror this against the reflection guest's spent-IMT fold and the EVM cross-lane non-membership check (same ν=nullifier(Cx,Cy)).
2. INFLATION GATES: (a) bridge_mint must require the burned ν ∈ knownBitcoinBurnRoot (NOT the generic spent set), one-mint-per-ν (bridgeMinted), all bitcoinRootsUsed ∈ knownBitcoinRoot, and the burn must pin the destination leaf. (b) The evmNullifiersSpent<=nextLeafIndex reserve floor and its by-identity exclusion of consumed bridge-burns. These are the only things bounding a compromised guest/vkey to real value.
3. CONSERVATION / KERNEL / OPENING-SIGMA COVERAGE PER OP (settle guest + cxfer-core): every spent input membership-verified AND value-bound; every minted output opens to a value the guest DERIVED (not freely witnessed); conservation holds with the fee removed exactly once. Hunt: an output leaf pushed without an opening sigma; an op using verify_kernel_with_fee where _with_fee_bound is required (delegated prover flips an output owner -> fund-lock); the ADAPTOR_CLAIM (zero-value plain kernel reveals s) vs ADAPTOR_REFUND/STEALTH_REFUND (must re-open L to bound locked value before paying a fee) distinction; AMM integer math (u128 accumulators, isqrt, rem<den, MINIMUM_LIQUIDITY floor, post-protocol-fee-carve k-non-decrease ordering, uniform-price clearing).
4. CROSS-OP SIGMA REPLAY / DOMAIN SEPARATION: enumerate every intent_context domain tag and the tuple it binds; confirm no two ops/legs collide so a sigma or owner-sig signed for one purpose authorizes another. Highest risk: OP_WRAP vs OP_WRAP_CDP_MINT vs OP_WRAP_TRANSFER (all consume a pending deposit; wrap-cdp-mint MUST use tacit-wrap-cdp-mint-collateral-v1, the C-2 fix) and the CDP collateral/debt/release contexts. Confirm the context binds chain_binding + ALL touched (cx,cy,owner) tuples + every public scalar (amounts, fee, deadline, index).
5. WITNESS-ABI ⇄ HOST/MIRROR PARITY (brick + soundness): read reflect.rs io::read, reflect-stdin/src/lib.rs write_stdin, and dapp/confidential-reflection-scan-indexer.js / confidential-pool.js side-by-side ARM BY ARM. Many arms read witnesses UNCONDITIONALLY for stream sync then fold conditionally — a predicate that gates folding but NOT reading must be identical on all three sides (same predicate: asset_preserving, conservation, canon_vouts.is_some, is_sentinel, mode_b). Confirm each settle exec-*.rs / *_execute.rs inline serializer matches its main.rs op arm, and that the sol! PublicValues field order/types in main.rs are byte-identical to ConfidentialPool.PublicValues.
6. CANONICAL-VOUT vs WITNESSED-VOUT for EVERY reflection onboarding arm: each fold must key the output note at canonical_*_output_vout of the REAL tx layout, never the loop index (AXFER_VAR {0->0,1->2}, LP_ADD share@0, LP_REMOVE recvA@0/recvB@1, FEE_CLAIM@0, swap_var receipt@1/change@2, harvest/unbond/refund@1). A wrong vout drops a note from the live set -> its later Bitcoin spend is undetected (cross-lane double-spend). This is the single most-repeated historical bug.
7. MODE-B / FAST-LANE CROSS-CYCLE ANCHOR + COUNT FRESHNESS: trace that eth-reflection priorDigest==state.eth_refl_digest, consumed_count==consumed_nu_count, and the contract's consumedCount==bitcoinConsumedCount(now) jointly close the stale-eth-proof double-credit and the forged-empty-prior bypass. Confirm the ETH_REFLECTION_VKEY [u32;8] recursion constant in bitcoin_prove.rs matches reflect.rs:169-170 AND the actual stage-i ELF (eth_vkey.rs), and that the EthReflectionPublicValues word offsets (8/9/10) match verify-reflection-slots.sh. A vkey/offset drift silently mis-binds the whole reverse bridge.
8. VKEY / GENESIS / CODESIZE PIN COHERENCE: confirm elf-vkey-pin.json's four authoritative fields (program_vkey, bitcoin_relay_vkey, two elf_sha256) are mutually consistent with the committed ELFs, with DeployV1Suite/DeployConfidentialPool's DEFAULT_VKEY, and with every committed *_groth16.json fixture; treat guest_state/deployed_* prose as UNTRUSTED. Confirm ScanReflection::genesis().digest() == ConfidentialPool.REFLECTION_GENESIS_DIGEST (0x7b058378...ef41 at ConfidentialPool.sol:309-310; any field added to ScanReflection rotates it). Confirm verify-vkey-pin.sh's strict gate (VERIFY_VKEY_STRICT=1) and the ELF->vkey derivation leg actually run on the deploy/readiness path (default is WARN), and that SKIP_VKEY_ASSERT cannot reach a deploy path. Confirm foundry.toml optimizer_runs=1 still fits the pool under EIP-170 if the pool source changed.
9. CDP / FARM CONTROLLER AUTHORITY: debtAsset==cdp_debt_asset_id(controller)=keccak('tacit-cdp-debt-v1'|controller) so a hostile ICdpController can ONLY mint its OWN debt asset; the farm unbacked-mint check must key off the GUEST-bound leg, not controller state; verify over-repay band, permissionless-liquidation health veto, nonce-0 reconstruction, and CDP-CLOSE BIP-340 owner_sig (anti equity-theft). Confirm CollateralEngine Chainlink fail-closed (staleness, answeredInRound, deviation vs TWAP, decimals bounds) for the cUSD peg.
10. CRYPTO SOUNDNESS: cross-curve sigma proves amount-equality MOD EACH GROUP ORDER at 128-bit challenge soundness — confirm EVERY production caller (swap_batch.rs) independently range-bounds both the secp and BJJ amounts via the Groth16 circuit so integer equality holds; the LIVE verifier is src/babyjubjub.rs (pinned NUMS literals must equal deriveBJJGenerator output), cxfer-core sigma.rs is test-only. Confirm the three NUMS-H derivations agree, BP+ verify_range is a sound complete range check (exact-length guard, canonical-scalar rejects, single final MSM==identity, INV_EIGHT/scalarmult8 trap), and BIP-340 rejects non-canonical s>=n / identity R. There is an /audit-bpp skill dedicated to the BP+ JS review — use it for layer F/G BP+.

BITCOIN LIGHT RELAY: audit genesis trust + retarget/fork-choice edge cases (canonical-nBits enforcement, fresh epoch-start read vs cache, median-time-past near genesis, _anchorChain burial) — it is the maturity root of trust for BOTH the pool reflection and the tETH bridge.

METHOD + OUTPUT REQUIREMENTS:
- VERIFY BEFORE REPORTING. Read the actual file:line; do not trust comments, memory notes, or the pin file's prose. For any cross-file invariant (guest<->serializer<->JS mirror, guest<->contract decode, vkey<->ELF, genesis<->constant) read BOTH/ALL sides and quote each. Run existing tests where cheap (forge test for Solidity, cargo test -p cxfer-core for the core/genesis-digest pin, the dapp tests/ corpus for the JS mirrors, reflect-exec DIGEST_MATCH for guest<->JS parity). Do not report a vulnerability you have not traced end to end to a concrete exploit.
- For EACH finding produce: (1) a SEVERITY (fund-critical / high / medium / low / informational) tied to the threat model; (2) file:line EVIDENCE on every load-bearing line (all sides of a cross-file invariant); (3) a concrete EXPLOIT PATH or brick scenario — the exact attacker inputs / proof / batch and the resulting theft, inflation, lock, cross-lane double-spend, or wedge; (4) a minimal FIX naming the file and the guard to add/change, and which immutable artifacts (guest ELF + vkey, contract redeploy, JS mirror) the fix forces to rotate; (5) a one-line note on how you VERIFIED it (test run, side-by-side read).
- Explicitly distinguish a GUEST invariant that silently depends on an UN-IMPLEMENTED contract check (the most dangerous class: the guest is immutable and the contract is the only place left to fix it) — for each op confirm the contract actually enforces what the guest assumes (root==stored, reserve_pre==live, positionNullifier dedup, bridgeMinted one-shot, deadline/refundNotBefore vs block.timestamp, debt asset==cdp_debt_asset_id(controller), router-settle fee==0).
- If you find NO issue in a prioritised area after tracing it, say so explicitly with the evidence that closes it (this is a pre-deployment sign-off, not just a bug list).
- Deliver a SCOPE table (the file list above, grouped A-G), then findings ordered by severity, then a residual-risk / sign-off section. Be exhaustive on scope; be precise and evidence-backed on every claim.
```

