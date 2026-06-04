# AMM — Mainnet Activation Review

**Scope:** the AMM only (POOL_INIT / T_LP_ADD / T_LP_REMOVE / T_SWAP_VAR / T_SWAP_ROUTE / T_SWAP_BATCH worker validation, the dapp receipt-credit validator, the Groth16 verification split, the ceremony artifacts, and the tETH/TAC first-pool specifics). Not the bridge, mixer, or orderbook except where they intersect.
**Target:** mainnet activation of the (TAC, tETH) pool. Reviewed 2026-06-05 against committed source at `ffa8944` plus the same-day gate restructure (`AMM_DEPLOYMENTS` split in `dapp/tacit.js`).
**Method:** 4-dimension parallel review (pool lifecycle, swap path, proof split + circuits, tETH/TAC specifics), each pass instructed to refute its own findings before reporting; load-bearing findings re-verified by hand against the code afterward.

---

## 1. Bottom line

The worker's out-of-circuit validation (kernel sigs with amount-bound keys, XCurve sigma, exact curve recompute, BP+ range proofs, fee crystallization) is thorough for what it governs — pool reserves cannot be seeded, inflated, or drained without consuming matching on-chain value, and the share/fee math survived adversarial walks at realistic tETH/TAC magnitudes. The ceremony is mainnet-grade (universal 3-circuit, content-addressed VK, finalized with a Bitcoin-block beacon).

The activation is blocked by one fund-critical defect and two normative-MUST gaps, all fixable without redeploying anything on-chain:

- **SWAP-1 (fund-critical):** the dapp credits swap receipts on the range proof alone. In this architecture the dapp is the sole enforcer of asset conservation for receipts — the worker's 13-gate swap validation only governs pool-reserve advancement, and the transfer branch never re-validates producing ops. A self-made T_SWAP_VAR envelope with an arbitrary `delta_out` and an honestly-generated bulletproof yields a receipt that recipient wallets accept: unbounded minting of any pooled asset, including tETH and TAC. Exists on signet today; must be closed before any mainnet pool carries value.
- **POOL-1:** no reorg handling / confirmation-depth gate on AMM state mutations (spec mandates depth-3; worker commits at 0-conf with no rollback).
- **POOL-2:** the canonical-vk_cid pinning rule (`spec/amm/ceremony.md` MUST) is not enforced — the canonical (TAC, tETH) pool slot can be squatted with an attacker-chosen VK.

Everything else is medium-or-below, and the placeholder-proof launch trap (GATE-1) was fixed in this pass.

---

## Resolution status (updated 2026-06-05)

**Resolved in this pass (dapp + worker, uncommitted at review time):**
- **GATE-1** — provers re-keyed from the per-network unlock to ceremony finality (`_isAmmCeremonyFinalized()`), so pre-activation broadcasts can no longer embed placeholder proofs that would permanently fail `validateOutpoint` after the network's gate opens. Gate itself restructured into `AMM_DEPLOYMENTS` (`pools` / `mixerPoolOps` per network) so mainnet pool activation no longer drags the cBTC.tac / slot-ops / farms surfaces along.
- **SWAP-1** — the dapp holdings validator now gates T_SWAP_VAR / T_SWAP_ROUTE receipt + change credit on the worker's canonical accepted-swap set, mirroring the T_PMINT / T_DCLAIM posture. Worker records accepted swap txids (`ammSwapAcceptedPut`, written only after the full 13-gate pass advances pool reserves) and exposes `GET /amm/swap-accepted`; the dapp `_fetchSwapAccepted` gate refuses credit when the worker is online and the swap isn't in the set (tagged `fetch-failed` so a user's own not-yet-indexed swap shows as pending, not inflation), and falls back to optimistic credit offline. Reserve-freshness is irreducibly global, so a forged swap (valid bulletproof, fabricated R_pre) is caught by absence from the worker set rather than by local re-derivation. Both credit paths (incoming receipt via ancestry walk; the wallet's own recovered receipts at the scanHoldings `validateOutpoint` call) flow through the gate. **Note:** offline still credits optimistically — mainnet must run against a live worker; the residual offline window is the same one T_PMINT / T_DCLAIM accept.

**Open — blockers before mainnet pool value:**
- **POOL-1** (depth-3 gate), **POOL-2** (vk_cid pin).

**Open — should ship with or shortly after the blockers:**
- **POOL-3 / SWAP-2** (scan-concurrency lost-updates), **UX-1** (pool-form decimals), **REC-1** (worker-independent canonical-pool recovery fallback), **SIG-1** (network byte in AMM signed messages), **VK-1** (VK↔r1cs CI assert).

**Phase-3 gates (bond wiring, not pool launch):** **TWAP-1**, **CFG-1**.

---

## 2. Findings

### SWAP-1 — Swap receipts credited on bulletproof alone → unbounded mint of pooled assets
**Fund-critical. Confidence: high (re-verified by hand).**
`dapp/tacit.js:18342` (T_SWAP_VAR) and `:18375` (T_SWAP_ROUTE) in `_validateOutpointSingle` gate receipt spendability on exactly: vout index, payload decode, the sentinel rule, and the m=2 aggregated bulletproof over `[change, receipt]`. Missing relative to the normative validator (AMM.md §"Validator algorithm"): the curve recompute (`delta_out == ammCurveDeltaOut(...)`), intent sig, kernel sig, reserve freshness, `min_out`, the `c_in_secp` ↔ on-chain-input binding, and any pool lookup at all. The Pass-1 BFS enumerator also never walks the swap's asset input, so the swap is a terminal node in the validation DAG.

Scenario: attacker crafts a T_SWAP_VAR referencing the real (TAC, tETH) `pool_id`, sets `delta_out = 10^18` on the tETH side, commits to it honestly, and attaches a valid range proof. The worker rejects it (pool not debited — correct) but nothing blacklists the output. The attacker spends the receipt to a victim via T_CXFER; the victim's wallet validates the ancestry — swap node returns true on the BP alone — and credits 10^18 phantom tETH. T_SWAP_ROUTE is easier still (`trader_output_asset_id` and `c_receipt` are read verbatim from the attacker's envelope).

The worker is not a backstop: its transfer branch (`worker/src/index.js:20599`) bumps stat counters and resolves commitments via `commitmentForUtxo` without re-validating the producing op. This is almost certainly the concrete content of the orderbook audit's "swap/AMM harmonization" remaining item.

**Fix direction:** implement the normative gates in both swap branches — recompute the curve from the envelope's `R_*_pre` and require exact `delta_out` equality, verify intent + kernel sigs (worker mirrors exist at `:2250`/`:2288`), require `c_in_secp` to match a BFS-walked validated input, open the receipt against `delta_out`, and check `R_*_pre` against the pool's known reserve history (worker `/amm/pool` + local replay). Add the swap's asset input to the Pass-1 enumerator.

### POOL-1 — No reorg handling / confirmation-depth gate on AMM state
**High (state-corruption that prices into swaps/removes). Confidence: high.**
`scanForEtches` (`worker/src/index.js:20351`) is forward-only, scans to tip (`endHeight = min(tip, …)`, `:20368`), never records block hashes for reorg detection, and has no rollback path for pool records. The mutating `ammPoolPut` calls (`:22950`, `:23100`, `:23198`, swap paths) commit at 0-conf. AMM.md `:1735` normatively requires `AMM_OP_CONFIRMATION_DEPTH = 3`; the worker defines no such constant (grep: comment-only) while the analogous gates exist for pmint (`PMINT_CONFIRMATION_DEPTH`, `:13356`) and mixer deposits (`:13369`). Pools are virtual — KV reserves ARE the settlement authority — so a reorged-out LP add leaves phantom reserves that every subsequent swap and remove prices against, permanently.
**Fix direction:** process AMM ops only in blocks ≤ tip−3 (mirror the pmint gate). This also shrinks the POOL-3/SWAP-2 race windows.

### POOL-2 — vk_cid pinning rule not enforced → canonical-pool squatting
**High (griefing/DoS now; trapdoor risk once per-pool Groth16 activates). Confidence: high.**
`spec/amm/ceremony.md:165–172` requires indexers to reject any V1 POOL_INIT whose `vk_cid ≠ CANONICAL_AMM_VK_CID` (mirroring the mixer's `CANONICAL_VK_CID` enforcement). The worker never checks it: the decoder (`:3552–3555`) bounds length only, dispatch stores it verbatim (`:22961`), and `vk_cid` is not part of the `ammDerivePoolId` preimage (`:1906`). First-confirmed-wins (`:22844`) + unchecked vk_cid = an attacker can occupy the canonical (TAC, tETH, 30bps, no-skim) pool_id forever with a garbage or trapdoored VK. The conformance test (`tests/amm-spec-conformance.test.mjs:313`) checks vk_cid format, never rejection.
**Fix direction:** one constant + equality check in POOL_INIT validation; deploy before the canonical POOL_INIT broadcast.

### POOL-3 / SWAP-2 — Scan-concurrency lost-updates on pool records
**Medium. Confidence: medium (needs overlapping scan invocations or intra-tick KV staleness).**
Pool records are read-modify-write with no CAS (CF KV has none) and, unlike every other hot record in the scan loop (`_petchCache:20384`, `_holderBumpedThisScan:20398`, `_bridgeInitCache:20427`), have no in-isolate cache. Two hazards: (a) cron tick overlapping a manual `/scan` (the documented unstick procedure) double-reads the same baseline and drops one delta; (b) intra-tick KV read-after-write staleness lets a second same-pool swap pass the reserve-freshness gate against the pre-swap baseline — both receipts mint, the pool debits once, and a re-scan diverges.
**Fix direction:** in-tick read/write-through pool cache keyed by pool_id (mirror `_bridgeInitCache`), plus a scan mutex or fold AMM writes behind the POOL-1 depth-3 canonical re-derivation.

### GATE-1 — Placeholder-proof launch trap (RESOLVED this pass)
**Medium (operational/liveness). Confidence: high.**
`_ammProveLpAdd`/`_ammProveLpRemove` returned 256-byte placeholders whenever the per-network gate was closed — so any pre-activation mainnet POOL_INIT/LP broadcast would embed a placeholder that `validateOutpoint` rejects forever once the gate opens (`pi_a=[0,0,1]` is not a curve point), routing the UTXO to `inflated`/`unverified` and out of spendable holdings, with no re-prove path for an on-chain envelope. Fixed: provers now key on `_isAmmCeremonyFinalized()` — real proofs from the moment the VK is pinned, on every network. Residual (signet-only): LP envelopes from before the 2026-05-28 finalization carry placeholders and remain bricked-in-wallet. Funds are recoverable at the protocol layer (the remove-time kernel still works); the worker reserve state was never wrong.

### UX-1 — Pool forms parse raw base units, display no price
**High (funds-misentry), UI-only. Confidence: high.**
LP-add, auto-balance, and pool-swap inputs all call `parseAssetAmount(value, 0)` (`dapp/tacit.js:47049`, `:47018`, `:47272`) — decimals hardcoded to 0, fractional input rejected, previews render raw integers. A user meaning "10 tETH" who types `10` contributes 10 base units (1e-7 tETH); meaning 0.5 tETH they cannot type it at all. There is also no human-readable price (TAC-per-tETH) anywhere in the pool/swap forms. Must be fixed before mainnet users touch the pool; the rest of the app already has the decimals plumbing.

### REC-1 — Variant-0 LP / swap-receipt recovery hard-depends on the worker registry
**Medium (recoverability; not permanent loss). Confidence: high.**
`_lpAssetIdLookup` is populated only from `fetchAmmPools` (`:46791`); variant-0 T_LP_ADD, T_LP_REMOVE, and swap-receipt recovery resolve pool_id through it (`:15368–15392`, `:19841`). Variant-0 envelopes carry only (assetA, assetB) — not the fee/flag discriminators — so pool_id is not derivable from the envelope alone, and a worker outage (cf. the signet cron-freeze pattern) makes these UTXOs unrecoverable-from-privkey until it returns. POOL_INIT founder shares are chain-recoverable (variant-1 carries full discriminators). **Fix direction:** hardcode the canonical pool's discriminators as a worker-independent fallback.

### SIG-1 — AMM signed messages omit the network byte
**Info / hardening. Confidence: high (omission); low (exploitability).**
`ammLpAddKernelMsg` (`:2403`), `ammLpRemoveKernelMsg` (`:2463`), and `ammLauncherGateMsg` (`:1941`) bind no network identifier, against house style (`_networkByte:4233`, slot-op `networkTag`). The kernel sigs are saved incidentally (they bind outpoints that can't co-exist cross-chain); the launcher-gate sig covers only `pool_id‖vk_cid‖fee_bps` and is byte-replayable across networks. Cheap fix, do it before mainnet.

### VK-1 — No CI bind between the pinned VK CID and the current r1cs
**Low. Confidence: medium.**
The drift-guard pins source/r1cs hashes, but nothing asserts the IPFS-pinned VK wrapper (nPublic / IC length) matches the current circuits before a network flips `pools: true`. A one-time CI assert closes the vkey↔circuit drift class (the same class as the bridge's ELF-drift lesson).

### TWAP-1 — No data source for the TAC-per-tETH TWAP leg; LP-share valuation treats the tETH leg as sats
**Phase-3 blocker (bond wiring), not a pool-launch blocker. Confidence: high.**
The dual-TWAP (`P_tETH/BTC = P_TAC/BTC × P_TAC-per-tETH`, §5.52.3) has no implementation and no feed: `twapSatsPerUnit` reads only the orderbook `trade-event:` journal; the T_SWAP_VAR/ROUTE indexers update reserves but emit no price observations; the pool record has no accumulator fields. Separately, `ctacLpShareValueSats` (`:1310–1328`) sums `reserve_b` directly as sats — wrong by the entire tETH/BTC price for a (TAC, tETH) pool. Both are the already-tracked §5.52.11 deferral; flagged here because even the data plumbing (AMM swaps → price observations) is absent, not just the formula. The canonical pool itself can be created now — the bond path resolves the pool by lp_asset_id + TAC-paired, with no discriminator requirements, so no second pool will be needed.

### CFG-1 — Worker bond-ratio default diverges from spec
**Low.** `CTAC_INITIAL_BOND_RATIO_THOUSANDTHS = 2000` (2.0×, the band floor) vs the amendment's 2.5× default (§5.52.10). Reconcile before Phase 3.

### BATCH-1 — T_SWAP_BATCH is dead code on the client path
**Info.** Circuit finalized, worker indexer branch exists (`:23208`), zero dapp builders/encoders/validators. The live swap surface is T_SWAP_VAR/ROUTE (cleartext deltas, fully worker-validated, no Groth16 dependency). Defer as a post-launch follow-up; ensure no UI surfaces it prematurely.

---

## 3. Cleared (checked and solid)

- **Reserve value-binding:** kernel keys of the form `Σ C_in − Δ·H` make reserves unseedable and shares unredeemable without consuming real on-chain value; both POOL_INIT sides and the LP_REMOVE side verified. Forged/placeholder Groth16 proofs cannot inflate LP shares — an over-committed share UTXO is unspendable via T_LP_REMOVE (the key would carry an unknown H-component) and never over-credits reserves.
- **Canonical ordering & discriminators:** lex-sorted asset pair (one pool per pair config); the no-skim pool_id is un-squattable via the protocol-fee discriminator (fee-enabled inits hash to a different pool_id). vk_cid is the exception (POOL-2).
- **Share & fee math:** isqrt founder shares (u128-safe BigInt), MINIMUM_LIQUIDITY locked at a NUMS key, floor rounding always pool-favoring (no free-mint, no add/remove drain cycle), zero-share adds rejected on-chain, lazy protocol-fee crystallization ordered correctly (Uniswap-V2-mintFee-equivalent).
- **Curve & swap math (worker):** exact-equality floor recompute (swapper cannot pick rounding), input-side fee with pool-favoring truncation, fee_bps ≤ 1000 enforced, stale-quote gate (`R_*_pre` must match stored reserves), route hop continuity/atomicity with per-hop floors and terminal min_out.
- **Proof split is not load-bearing for reserves:** pool reserves derive entirely from worker-validated public deltas; the Groth16 layer adds hidden↔public amount binding that the remove-time kernel already enforces on the value path. Users cannot be tricked into swapping against mis-stated reserves via the proof split.
- **VK integrity:** `_ipfsCidMatches` re-derives the multihash and fails closed — a malicious gateway cannot substitute the VK or wrapper.
- **tETH/TAC magnitudes:** both assets are 8-decimal (the 18→8 scaling never leaves the bridge); all value-path arithmetic is BigInt with u64 gates; realistic seeds can't fail the isqrt floor or lock meaningful MINIMUM_LIQUIDITY fractions; asymmetric reserves don't starve proportional joins (geometric-mean share supply keeps both floors ≈ √(R_A/R_B)).
- **Genesis mechanics:** POOL_INIT founder shares are recoverable from chain alone; `AMM_INITIAL_LP_LOCK_BLOCKS = 6` rejects variant-0 joins for ~1h post-init (plan the seeding flow around it).
- **Ceremony:** universal (not per-pool), multi-party Phase 2 chains over Hermez pot18, Bitcoin-block beacon, pinned drift-guard, reproducible audit walk.

---

## 4. Activation checklist (revised by this review)

1. **SWAP-1** — dapp swap-receipt validator gates (blocker; also fixes the signet exposure).
2. **POOL-1 + POOL-2** — depth-3 AMM gate + vk_cid pin in the worker; deploy before any canonical POOL_INIT exists. Fold POOL-3/SWAP-2 (in-tick pool cache) into the same worker change.
3. **UX-1** — decimals + price display on the pool forms. **SIG-1**, **VK-1**, **REC-1** ride along.
4. Decide genesis parameters (seed amounts — open question #4 in the collateral amendment — fee_bps, fee address, founder-share custody); accumulate the tETH side (pilot cap permitting).
5. Broadcast the canonical (TAC, tETH) POOL_INIT + seed (real proofs are now guaranteed pre-flip by the GATE-1 fix); mind the 6-block LP lock.
6. Flip `AMM_DEPLOYMENTS.mainnet.pools = true`; small LP_ADD → T_SWAP_VAR → LP_REMOVE round-trip as smoke. `mixerPoolOps` stays false until cBTC.tac's phase.
7. Phase 3 (bond) separately gated on TWAP-1 + §5.52.11 + CFG-1.
