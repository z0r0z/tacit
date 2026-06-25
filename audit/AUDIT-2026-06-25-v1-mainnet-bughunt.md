# Tacit V1 Mainnet Bug-Hunt — Coalesced Audit Report

**Date:** 2026-06-25
**Scope:** Security & privacy fund-safety review gating a V1 mainnet launch.
**Prompt:** [PROMPT-v1-mainnet-bughunt-2026-06-25.md](PROMPT-v1-mainnet-bughunt-2026-06-25.md)
**Method:** 6 parallel adversarial auditors, one per lane, each working all 8 attack
questions against current source (not comments or test names): pool core; SP1 guest
opening-sigmas; reflection/bridge forgery; engine/farm/AMM conservation;
router/relayer/factory; relay-reorg + privacy.

---

## Verdict: GREEN-LIGHT — no fund-critical code blockers

Across ~17k lines of Solidity + Rust: **zero Critical / High findings.** Every historic
bug class the prompt flagged was re-verified as genuinely fixed in current source. The
single gating item is **operational, not a code defect.**

---

## B-1 (the one blocker) — Live pilot runs the SUPERSEDED vkeys

**Class:** deploy coherence. **Severity:** blocker (ops, not code).

All audited guest fixes are in source, but the deployed Sepolia/E2 pilot pool verifies
against the pre-rebuild vkeys (`program 0x005c8a3d…` / `bitcoin_relay 0x0032a552…`), not
the authoritative pinned set (`program 0x00c3d486…` / `bitcoin_relay 0x0014b726…`). The
audited guarantees are **not live until the coordinated redeploy** uses the new immutable
vkeys. Flagged independently by 3 lanes (pool, reflection, guest).

**Action:** mainnet redeploy must pin both authoritative immutable vkeys.
`DeployConfidentialPool.s.sol:119/134` already enforces the match against
`elf-vkey-pin.json`; confirm the script is not run with `ALLOW_UNPINNED_VKEY`.

---

## Historic bug classes — confirmed FIXED in current source

| Class | Verified at | Status |
|---|---|---|
| OP_UNWRAP recipient+fee binding | `main.rs:687-700` (`recip32` + `[value,fee]` in sigma ctx, `fee≤value`) | present |
| Adaptor-CLAIM output opening sigma | `main.rs:2041-2054` (O opened, recipient leaf-pinned) | present |
| Witness-commitment (BIP141 wtxid swap) | `reflect.rs:467-471` panic on `verify_witness_commitment==false`; extraction gated `:493-497` | enforced |
| Forged prior-consumed root | `reflect.rs:353-362` prior-digest chain anchor + `:429` count assert | enforced |
| Farm unfunded-escrow drain | `ConfidentialPool.sol:1869-1877` treasury debit keyed off guest-bound `legs[0].asset` | closed |
| Nullifier asset-binding / cross-lane | membership uses `leaf(asset,cx,cy,owner)`; ν omits asset by design (load-bearing) | sound |

Opening-sigma coverage was tabulated across **all 26 guest op arms** — no spendable output
lacks a sigma, kernel-conservation, or membership-pinned value. Σ(credits)==Σ(debits)
holds under partial fills, fees, refunds, liquidation, and failure paths. The contracts are
defense-in-depth: they independently re-check k-non-decrease, reserve floors, u64 bounds,
nullifier-count reserve floor, claimId re-derivation, and escrow fail-closed.

---

## Accept-and-document (not blockers)

- **R-1 — Deep-reorg economic finality.** A Bitcoin reorg deeper than confirmation depth
  (mainnet 6 + 6 finality slack) duplicates a bridge-burn↔mint. Standard PoW bound, uniform
  across slow bridge + reflection path. Consider raising mainnet
  `REFLECTION_CONFIRMATIONS`/`CONFIRMATION_DEPTH` toward 12 for the bridge-mint path — an
  immutable ctor arg, so a redeploy-time decision.
- **L1 (guest) — `deadline=0` on non-trading ops** (transfer/unwrap/wrap/bridge/CDP/farm):
  a relayer can submit a held proof arbitrarily late. Griefing/staleness, not theft (effects
  fully determined and value-conserving). Optional: bind a deadline into those sigma contexts.
- **M1 (engine) — orphaned `feeBudgetCusd`.** Fees accrued with no savers become permanently
  dead capital. Conservation-safe (caps mint, never claimable) — cosmetic supply drift only.

---

## Privacy

- **P-1 / P-3** — deposit/withdraw boundary + batch-timing/ordinal metadata: inherent
  public-DeFi leakage, by design (bearer-note model). Not protocol defects.
- **P-2 (Low, protocol-attributable)** — `CrossOutRecorded` / `BitcoinNotesConsumed` publish
  the **raw nullifier in both lanes**, making ETH↔BTC cross-out linkage trivial. ν reuse is
  load-bearing for the cross-lane double-spend gate — do NOT change the on-chain ν. Optional
  follow-up: emit a one-way commitment of ν in the *event* while keeping raw ν in the gate
  set. Document-or-defer, not a blocker.

---

## Hardening suggestions (non-blocking)

- Add a compile-time/test assert pinning `cdpMints` to `PublicValues` field index 22
  (`ConfidentialRouter.sol:1248`, `_requireCdpMintIntent`) so a struct reorder can't silently
  weaken the CDP-intent guard.
- Confirm `settle` freshness handling for the deadline-0 ops (L1).

---

## Bottom line

The value rules are sound on both layers. The only item standing between this audit and a
live-safe launch is **B-1: redeploy against the new pinned vkeys** so the audited guest is
the one actually verified on-chain.
