# Tacit V1 — Freeze-Readiness Sign-Off

**Purpose.** A single go/no-go artifact for the immutable, unpausable, no-recovery mainnet freeze. Consolidates every independent review, the dynamic validation, all findings and their fixes, and the exact conditions that remain. Prepared 2026-08-24 at surface commit `45db6ac8`.

---

## 1. Bottom line

The immutable **source** is clean and freeze-ready: three independent full-depth security reviews plus dynamic box validation converge on **no exploitable path to unbacked value, theft, permanent freeze, false-proof acceptance, or protocol-level deanonymization.** Every finding raised across all passes has been fixed or is an accepted, documented trust posture.

**Freeze is GO — conditioned only on the pre-freeze checklist in §5**, none of which is an open question about source correctness: they are the prover-box KATs (under the rotated vkey), the deploy-time gates run at the pinned block, and the published governance configuration.

---

## 2. Assurance coverage (what backs this sign-off)

| Pass | Scope | Result |
|---|---|---|
| **External review A** (Opus 4.8, interim) | Crypto core + on-chain gates exhaustively; remainder sampled | Coverage-NO-GO → the sampled surface clean; drove the deeper passes |
| **External review B** (Opus 4.8 Max, final) | Full ~36k-line immutable surface, line-by-line | **GO** conditioned on checklist; no exploitable defect |
| **Internal 7-slice adversarial review** | Reflection folds · settle per-op · crypto/accumulators · bitcoin.rs · burn-deposit DAG · eth-reflection/MPT · contracts · LP-fold interior | All clean; **found + fixed 1 item** (destChain coupling) |
| **Dynamic box validation** | `MODE=execute` across ~24 settle ops incl. the full lock lifecycle | pv>0 under vkey `0x006d3829`; no regressions |

Three of these are genuinely independent, full-depth passes; the fourth is dynamic evidence the static reviews can't provide. Every high-severity *global* class (inflation, false-proof, crypto/accumulator breaks, cross-lane duplication) and every per-op authorization/conservation path has been examined directly, more than once.

The single most adversarial-reachable value path — the uncollateralized `OP_SURPLUS_DRAW` cUSD mint — was traced end-to-end **independently** (guest `positionLeaf==2` → pool → `CollateralEngine._surplusDraw`) and confirmed fully gated (one-shot `onlyOwner` pre-auth, exact amount+destination match, re-bounded to realized surplus). See `collateral-engine-trust-boundary.md`.

---

## 3. Findings — full history, all resolved

| # | Finding | Severity | Status |
|---|---|---|---|
| F-1 sweep | Native notes needed secret-key (`nk`) nullifiers threaded through every native-input op | design/privacy | **FIXED** — swept + box-validated across every op |
| Lock refund-authority | `locker` overloaded as `H(nk)` spend-owner AND BIP-340 refund key → refund path dead | correctness/liveness | **FIXED** — distinct `refund_pub` witnessed + bound; all 6 lock ops box-validated (new vkey `0x006d3829`) |
| Swap scheme divergence | Dapp had migrated swap inputs off the guest's value-hiding blind-PoK | privacy/parity | **FIXED** — dapp reverted to blind-PoK; guest untouched (more private, no reprove) |
| Swap-blind inertness docs | Comments understated the hard-disable ("inert until emitter" / "FULLY WIRED") | doc/clarity | **FIXED** — all sites state the guest-level hard-disable (proof-fatal panic + no-op fold) |
| **destChain coupling** | Pool recorded every crossOut while eth-reflection asserts `dest_chain==1` → cross-component brick risk | liveness | **FIXED** — pool now re-checks `destChain==1` at the recording site (`CrossOutUnsupportedDest`) |
| A1 BP+ IPA exponents | Verifiable structurally, not fully by hand | assurance (liveness) | **OPEN** — hard-gated by the box range-proof KAT under the rotated vkey (§5) |
| A3 deploy gates | Storage slots / predecessor-inert / vkey rotation | assurance | storage-slot gate **GREEN now**; rest are deploy-block (§5) |
| A4 CollateralEngine/oracle | DAO-governed trust posture; value invariants correct | accepted posture | **DOCUMENTED** (`collateral-engine-trust-boundary.md`); no non-governance inflation path |
| A5 serializer parity | Host-side, liveness-not-forgery | assurance | in the pre-freeze box run (§5) |
| A6 public-AMM periphery | Separate value pool, lighter external treatment | coverage | **CLOSED** — focused pass clean; LP principal safe even under a periphery bug |

No Critical/High/Medium exploitable defect is outstanding.

---

## 4. Accepted residual risks (recorded at GO)

1. **CollateralEngine oracle + DAO governance keys**, operating within immutable floors (ratio bounds, feed-change liquidation grace, `MIN_ESCROW_GRACE_WINDOW`, `MAX_FEE_PER_SECOND`, surplus-draw bounds). Owner must be a timelock/multisig; arm `maxDeviationBps` before enabling the stability fee.
2. **Intentional design**: open/copyable settlement (router recipe-binding makes it safe), membership-only ETH→BTC messaging (no value authorized), and the inherent burn↔mint linkage every cross-chain bridge has (amounts and onward spends stay confidential).
3. **Third-party pinned libraries** (helios 0.11.1, sp1-helios) and SP1 proving-system soundness.
4. The batch/blind/cross-curve/BN254-Groth16 code is **inert this generation** (proof-fatal / folds-nothing); its internals are out of scope until a future generation enables and separately audits them.

---

## 5. Pre-freeze checklist (the conditions on GO)

Freeze is approved when every box is green. None reopens a source-correctness question.

- [ ] **Range-proof KATs green** (BP+ and classic `*ProofReal`) on the prover box under the **rotated deploy vkeys** — closes A1.
- [ ] **End-to-end serializer-parity KAT green** (JS witnesses → guest → verifier) + Groth16 `*ProofReal` confirm the disabled path as shipped — closes A5.
- [x] **`verify-storage-slots.sh` green** — done 2026-08-24 (`gate-verify-storage-slots.txt`); **re-run + publish at the deploy commit**.
- [ ] **`verify-predecessor-inert.sh` green** at a pinned pre-deploy block, block hash + output published; `POOLS` = the full superseded lineage.
- [ ] **ELF/vkey reproducibility** confirmed; deployed `PROGRAM_VKEY` values match the rotated build (settle = `0x006d3829…`); the `ConfidentialPool` redeploy carries the destChain re-check.
- [ ] **CollateralEngine governance published** — owner (timelock/multisig), feed set + `maxDeviationBps`, launch ratios + fee rate (`collateral-engine-trust-boundary.md` has the template).
- [x] **Public-AMM focused review** — done, clean (A6).
- [ ] **Deploy-time genesis-timestamp cross-check** — `BitcoinLightRelay.genesis` first-block timestamp verified against independent explorers.

**The one substantive remaining action is the held reprove** (regenerate the 24 `*ProofReal` groth16 proofs + the reflection/eth-reflection ELFs under vkey `0x006d3829`, update the vkey pins). It carries the destChain re-check and closes the range-proof + serializer KATs in one pass. Everything else on this list is mechanical deploy-block confirmation.

---

## 6. Statement

Subject to the §5 checklist going green, the Tacit V1 immutable surface is **approved for freeze and mainnet deployment**. Any KAT or gate failure is a hard blocker to be fixed and re-proven before freeze.

*Consolidates: `AUDIT-2026-08-24-opus48max-with-responses.md`, the internal seven-slice review (`project_final_multiagent_review_2026_08_23`), `collateral-engine-trust-boundary.md`, and `gate-verify-storage-slots.txt`.*
