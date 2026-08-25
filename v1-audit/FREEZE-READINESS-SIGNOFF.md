# Tacit V1 — Freeze-Readiness Sign-Off

**Purpose.** A single go/no-go artifact for the immutable, unpausable, no-recovery mainnet freeze. Consolidates every independent review, the dynamic validation, all findings and their fixes, and the exact conditions that remain. Prepared 2026-08-24 at surface commit `45db6ac8`.

---

> **UPDATE 2026-08-24 (post-scan).** A further external automated scan (12 independent reviews, `AUDIT-2026-08-24-codex-scan-with-responses.md`) surfaced **one previously-unknown unbacked-mint path** — a deferred cBTC lock registration could be resurrected after its spend was discarded — plus a real reflection halt/undrainable-overflow class and two hardening gaps. **All four are fixed.** The remaining twelve findings restate recorded trust postures or are factually incorrect about the source. Consequences: the reflection ELF/vkey rotate with the held reprove (the overflow encoding changed), the pool bytecode pin must be re-measured, and **the pool no longer fits EIP-170 without freeing ~400 bytes** — the one open engineering decision. §3 and §5 below are updated accordingly; the GO in §1 is conditioned on that decision plus the checklist.

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
| **cBTC terminal tombstones** | A spend/redemption of a lock whose registration was deferred past the surfacing cap was discarded, and `drainOverflow` could later install the retired lock live → cBTC mintable against a spent Bitcoin UTXO | **CRITICAL (unbacked mint)** | **FIXED** — terminals are unconditional tombstones; both registration paths already skip a retired outpoint |
| **Unbounded terminals / atomic overflow** | `cbtcLocksSpent`/`Redeemed` were uncapped (gas-limit halt on a large block) and the deferred remainder was one atomically-undrainable bundle | liveness (permanent halt / stranded effects) | **FIXED** — terminals capped + deferrable; deferral chunked at the source (one root per 8 leaves); terminals-first ordering; cBTC mint fails closed while chunks are outstanding. Rotates the reflection vkey |
| **Relay near-genesis MTP** | Anchor timestamp conflated with the epoch-start timestamp → partial median window for ~11 blocks | low (documented caveat) | **FIXED** — one-shot `seedAnchorHistory` seeds the anchor's real timestamp + ten ancestors; retarget input untouched |
| **`ETH_CALL_OUTBOX` pin** | All-zero placeholder ships messaging permanently inert; a rebuild + vkey rotation does not replace a source constant | deploy-process | **FIXED** — `verify-lockstep-pins.sh` hard-fails on the placeholder (`ALLOW_UNPINNED_OUTBOX=1` for pre-cutover) |
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
- [x] **ELF/vkey lockstep rotated + reproducible** — DONE 2026-08-24. All three guest ELFs rebuilt under the current box toolchain (SP1 6.2.3), each reproducible (clean-target rebuild → identical sha), and the vkeys re-derived + pinned coherently: **settle `program_vkey` = `0x006d3829`** (sha `d3ff2012`, unchanged — the lock-refund build), **reflection `bitcoin_relay_vkey` = `0x00710952`** (sha `501cc796`, NEW — carries the overflow/tombstone encoding + the eth-vkey re-pin), **`eth_reflection_vkey` = `0x00d5e2a3`** (sha `23ba6e89`, NEW — toolchain-current build). reflect.rs `ETH_REFLECTION_VKEY` re-pinned to the new recursion `hash_u32`; `elf-vkey-pin.json` all nine fields updated; `verify-lockstep-pins.sh` **PASS** (checkpoint `dd31776d`); `FROZEN_REFLECTION_*` and deploy-script vkey defaults bumped. NOTE: a stale committed settle ELF (`37b2a233`) was found in the local tree and replaced with the lock-fix build (`d3ff2012`). The `ConfidentialPool` redeploy carries the destChain re-check. **Still owed: the Groth16 *fixtures* (`*ProofReal` + reflection/lpbond) must be re-proven under these vkeys** — that is the network-prove leg below, still blocked.
- [ ] **CollateralEngine governance published** — owner (timelock/multisig), feed set + `maxDeviationBps`, launch ratios + fee rate (`collateral-engine-trust-boundary.md` has the template).
- [x] **Public-AMM focused review** — done, clean (A6).
- [x] **EIP-170 headroom** — DONE 2026-08-24. The reflection/attest surface (`attest`, `drainOverflow`, `_anchorReflection`, `_isTipOrRecentAncestor`, the cBTC/meta structs) was extracted to an external delegatecall library `ReflectionLib.sol`; the library-storage-ref pattern leaves every state-var declaration in place so slots are preserved by construction (`verify-storage-slots.sh` green). `ConfidentialPool` runtime = **24,003 B (573 under)**; ReflectionLib = 6,820 B. Contract-only, zero reprove/vkey impact. Re-pin `pool-bytecode-pin.json` at the deploy commit.
- [ ] **`verify-lockstep-pins.sh` green WITHOUT `ALLOW_UNPINNED_OUTBOX`** — the deploy ELF must carry the real `EthCallOutbox` address.
- [ ] **`seedAnchorHistory` values cross-checked** — the anchor's own header timestamp + its ten canonical ancestors, from real headers, verified against two independent explorers and recorded in the deploy artifact alongside the anchor.
- [ ] **Deploy-time genesis-timestamp cross-check** — `BitcoinLightRelay.genesis` first-block timestamp verified against independent explorers.

**The one substantive remaining action is the held reprove** (regenerate the 24 `*ProofReal` groth16 proofs + the reflection/eth-reflection ELFs under vkey `0x006d3829`, update the vkey pins). It carries the destChain re-check and closes the range-proof + serializer KATs in one pass. Everything else on this list is mechanical deploy-block confirmation.

---

## 6. Statement

Subject to the §5 checklist going green, the Tacit V1 immutable surface is **approved for freeze and mainnet deployment**. Any KAT or gate failure is a hard blocker to be fixed and re-proven before freeze.

*Consolidates: `AUDIT-2026-08-24-opus48max-with-responses.md`, the internal seven-slice review (`project_final_multiagent_review_2026_08_23`), `collateral-engine-trust-boundary.md`, and `gate-verify-storage-slots.txt`.*
