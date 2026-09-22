# Tacit V1 — Pre-Freeze Security Audit (Opus 4.8 Max) — with Tacit responses

This is the external audit report verbatim, with **Tacit responses and positions inlined** (dated 2026-08-24) after the verdict, each finding, and the checklist. Response blocks are marked `▸ Tacit position`.

> ▸ **Tacit position — overall.** We concur with the **GO-conditioned-on-checklist** verdict. This report's conclusions independently corroborate our own internal seven-slice adversarial multi-agent review (2026-08-23) and the external Opus 4.8 report before it: the value- and consensus-critical surface has now had three independent full-depth passes plus box execute-mode validation across ~24 ops, all converging on "no exploitable defect." Two notes: (1) our internal review found and **fixed one additional item this report does not raise** — an eth-reflection `destChain` cross-component coupling, now re-checked on-chain in `ConfidentialPool` (`CrossOutUnsupportedDest`, commit 84f4eeb1); the surface this report reviewed already carries that fix. (2) Every checklist item below is confirmation of something *outside* the frozen source (box KATs, deploy-gate output, governance config) — none reopen a source-correctness question. Our per-item validations and positions follow.

---

## 1. Executive summary

Over an exhaustive, line-by-line review of the full value-critical and consensus-critical surface — roughly 36k lines of Solidity contracts and SP1 zkVM Rust guests — **no path to unbacked value, theft, permanent freeze, false-proof acceptance, or protocol-level deanonymization was found.**

[Full executive summary as delivered; verdict: **GO — conditioned on the Section 8 checklist.**]

> ▸ **Tacit position — verdict.** Accepted. Matches our internal conclusion. The frozen source is clean; the remaining work is confirmation (box KATs + deploy gates + governance docs), not investigation.

---

## 4. Security properties verified

The report verifies, in full: the conservation kernel (`ΣC_in − ΣC_out − net·H = excess·G`), range binding (BP+ / classic), double-spend + cross-lane retirement (fast-lane completeness + full-leaf binding + outpoint double-mint gate), bridge minting + asset preservation, the reflection's validate-then-commit discipline, the Ethereum-lane independent re-check (`evmNullifiersSpent ≤ nextLeafIndex`, k-non-decrease, pro-rata LP bounds, escrow symmetry, no owner/admin/upgrade/drain), ERC20 mint authority (`MINTER == pool`), the Bitcoin light client (heaviest-chain, per-branch retarget, canonical nBits), the beacon Mode-B client (`head > prev_head`, genesis pin, completeness gates), router non-custody (`_recipeSalt` binding), least-privilege message plumbing, and the inert batch/blind path (`OP_SWAP_BLIND` proof-fatal; `T_SWAP_BATCH` folds nothing).

> ▸ **Tacit position — §4.** Independently corroborated by our seven-slice review. In particular §4.12 (batch/blind inertness) matches our own finding: we confirmed `OP_SWAP_BLIND` `panic!`s at dispatch entry (unprovable) and the reflection Track-C `0x2F` handler only drains append paths and never calls `fold_swap_batch`, and we corrected the source comments that had understated this (they previously read "inert until an emitter exists" / "FULLY IMPLEMENTED + WIRED"; now they state the guest-level hard-disable — commit 0c4d9dbd). The §4.3 fast-lane completeness reasoning and §4.6 independent re-check also match our contracts + eth-reflection slices exactly.

---

## 5. Findings — assurance items and accepted trust postures (no code defects)

### A1 — Bulletproofs+ range verifier: exact IPA exponents are box-KAT-gated
The report verified the BP+ verifier's foundation statically (NUMS independence, sound transcript, helper terms for every in-scope aggregation size, top-level combination) but notes the exact inner-product range-shift exponents can't be re-derived by static inspection; a subtle error would most likely break honest proofs (liveness), not admit forgeries, and is gated by the prover-box `*ProofReal` real-vector KATs. Same for the classic-Bulletproofs path.
**Action:** confirm the BP+ and classic range-proof KATs pass on the box against the rotated deploy vkeys.

> ▸ **Tacit position — A1: OPEN, closed by the held reprove.** Agreed and correctly characterized as liveness-not-forgery. This is subsumed by the reprove we are holding: the settle vkey rotated to `0x006d3829` (our lock `refund_pub` fix), so the full `*ProofReal` groth16 suite regenerates and must pass under the new ELF before freeze. We additionally have box **execute-mode** evidence across ~24 ops (including LP/swap value ops whose range legs exercise BP+). We will not freeze until the range-proof KATs are green under the rotated vkeys. Tracked as the top reprove gate.

### A3 — Deploy-time gates must run green at the deploy block
Storage-slot pins (`verify-storage-slots.sh`), one-live-funded-generation (`verify-predecessor-inert.sh`), and ELF/vkey rotation + byte parity. All three reviewed and found correctly designed.
**Action:** run both gates at a pinned pre-deploy block, publish block hash + green output; confirm ELF/vkey reproducibility.

> ▸ **Tacit position — A3: storage-slot half VALIDATED NOW; the rest are deploy-block items.** We re-ran `verify-storage-slots.sh` against the current compiled layout and it is **GREEN** — all nine pins (`77/120/121/165/171/172` + outbox `0/1/2`) match `forge inspect` (captured in `v1-audit/gate-verify-storage-slots.txt`). `verify-predecessor-inert.sh` and the ELF/vkey reproducibility are inherently deploy-block-time (they read live balances / the rotated build), so they run at deploy with published hashes — on the pre-freeze checklist, not resolvable earlier. Note the `destChain` hardening we added strengthens exactly the cross-lane class this gate guards.

### A4 — CollateralEngine (DAO-governed CDP) + oracle: accepted trust posture; value invariants verified correct
No non-governance inflation path; real CDP mints are oracle-priced over-collateralized; `OP_SURPLUS_DRAW` is fully gated (one-shot governance pre-auth, capped at accrued surplus); liquidation burns cUSD and mints nothing. Residual risk is the oracle + DAO keys, within bounded levers.
**Action:** document the owner (timelock/multisig), feed set + deviation bounds, launch ratios + fee rate. Confirm FarmController reward-minting stays double-gated by the pool.

> ▸ **Tacit position — A4: DOCUMENTED + sub-item VALIDATED.** Accepted as the stated trust model. We wrote the trust-boundary record — `v1-audit/collateral-engine-trust-boundary.md` — enumerating the immutable floors (verified in frozen code: `MAX_FEE_PER_SECOND`, `FEED_CHANGE_LIQ_GRACE=6h`, `MIN_ESCROW_GRACE_WINDOW=3d`, the `setParams` ratio bounds, non-disableable `setDeviationBound`, reciprocal `setPool` binding) and the governance levers whose launch values must be filled in and published at deploy, with the owner set to a timelock/multisig. We **verified the FarmController double-gating**: the pool holds `farmTreasury[controller]` and enforces `escrow[asset] == Σ reward notes + Σ farmTreasury` (ConfidentialPool.sol:510-515) — the reward leg is tied pool-side, so a FarmController defect can at worst misallocate among stakers, never inflate. We concur with the report's (and our own contracts review's) recommendation to **arm `maxDeviationBps` before the stability fee is ever enabled**.

### A5 (informational) — Host-serializer ↔ circuit parity is box-KAT-gated
`reflect-stdin` writes fields in the guest's `io::read` order; a mismatch breaks honest proofs (caught by the box KAT), not a forgery. Host-side, not frozen surface.
**Action:** ensure the end-to-end box KAT (JS witnesses → guest → verifier) is in the pre-freeze run.

> ▸ **Tacit position — A5: reprove/box-KAT-gated.** Agreed, liveness-not-forgery, host-side. Folded into the pre-freeze box run alongside A1. Our reflection-fold slice separately verified the guest↔assembler accept/skip parity discipline that the byte-serializer parity KAT confirms end-to-end.

### A6 (informational, lower severity) — Plaintext public-AMM periphery is a separate value pool
`TacitPublicAmm` + the pool's `applyPublic*` functions implement a standard non-confidential AMM over public LP shares/reserves. A defect harms public LPs, not shielded backing or cross-lane value; cannot mint canonical assets or move shielded notes. Received less depth than the primary harm model.
**Action (optional):** focused pass if it will hold material third-party liquidity at launch.

> ▸ **Tacit position — A6: CLOSED, clean.** We took the report's optional recommendation rather than defer it. A dedicated adversarial pass over `TacitPublicAmm` + `applyPublicAddLiquidity/RemoveLiquidity/Swap` and every helper (`_ensurePair`, `_ingestPublic`/`_moveInUnderlying`, `_payout`, `_resolveAsset`, the u64 gates) found **no exploitable defect**:
> - **Gating/reentrancy:** all three applicators are `nonReentrant onlyPublicAmm`; `PUBLIC_AMM` is immutable, the periphery's `POOL` is one-shot deployer-only; every `_payout` is CEI-last behind the shared lock.
> - **Share/curve math floors in the protocol's favor:** founding branch caps `minted² ≤ vLo·vHi` and locks `MINIMUM_LIQUIDITY` (first-depositor inflation blocked); in-ratio mint is pro-rata-or-less backed with excess refunded; `applyPublicSwap` enforces `k`-non-decrease so payout is bounded to the *zero-fee* constant-product output — **LP principal is safe even under a periphery bug**; `applyPublicRemoveLiquidity` is proportional, floored, with an underflow-safe `shares + MINIMUM_LIQUIDITY > totalShares` guard.
> - **Escrow/reserve consistency:** `_ingestPublic` escrows under the passed id and `_payout` debits under the resolved id — consistent because escrowed (non-pool-minted) assets are never shared→local aliased (the same invariant `wrap` relies on); fee-on-transfer/rebasing rejected at the boundary (`FeeOnTransferUnsupported`).
> - **Isolation:** the applicators touch only `pools[]`, `lpShares[]`, and AMM escrow — no path reaches note commitments, nullifiers, Merkle trees, or bridge escrow; a public swap preserves `k` so shielded readers of the shared reserves stay correct. It cannot mint canonical supply beyond re-materializing value it just burned.
>
> Two minor non-exploitable notes, **no code change needed**: (1) off-ratio add-liquidity excess refunds to the caller-chosen share recipient `to`, not the fund payer `msg.sender` — caller-controlled, not theft (doc note only); (2) the applicator k-check permits up to the zero-fee output, with the swap fee enforced solely by the single immutable authorized periphery (intentional per design). **A6 is now covered to the same depth as the shielded surface — clean.**

---

## 8. Pre-freeze checklist — Tacit status

| Item | Report | Tacit status (2026-08-24) |
|---|---|---|
| Range-proof KATs green (BP+ + classic) under rotated vkeys — A1 | required | **OPEN** — in the held reprove (vkey `0x006d3829`) |
| End-to-end box KAT (JS→guest→verifier) + Groth16 `*ProofReal` — A5 | required | **OPEN** — in the held reprove/box run |
| `verify-storage-slots.sh` green, published — A3 | required | **GREEN now** (`v1-audit/gate-verify-storage-slots.txt`); re-publish at deploy commit |
| `verify-predecessor-inert.sh` green at pinned block, published — A3 | required | **DEPLOY-TIME** (reads live balances) |
| ELF/vkey reproducibility + deployed `PROGRAM_VKEY` match — A3 | required | **DEPLOY-TIME** — part of the reprove |
| CollateralEngine governance documented — A4 | required | **DONE** (`v1-audit/collateral-engine-trust-boundary.md`); fill launch values at deploy |
| (Optional) public-AMM focused review — A6 | optional | **DONE — clean** (no exploitable defect; see A6 above) |

> ▸ **Tacit position — §8.** Two checklist items are already satisfied now (storage-slot gate, governance doc), one is in progress (A6), and the rest are the held reprove + deploy-block gates. No item is a source-correctness question. We freeze only when every box is green; any KAT/gate failure is a hard blocker.

## 9. Conclusion — Tacit

We accept the **GO conditioned on the Section 8 checklist**. Combined with our internal seven-slice review (which added the `destChain` hardening) and box validation, the immutable surface has independent, full-depth, converging coverage. Remaining work is the held reprove (A1/A5 KATs under the rotated vkey), the deploy-block gates (A3), and publishing the governance config (A4) — plus the A6 public-AMM pass we are completing now.
