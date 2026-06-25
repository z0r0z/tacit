# Maintainer response — GPT-5.5 Pro cross-chain reflection audit (bundle 2, 2026-06-24)

Companion to `TACIT_FINANCE_CROSSCHAIN_REFLECTION_AUDIT_GPT55PRO_2026-06-24.md` (report
SHA-256 `73e85409b17859753125c9e6958d18a4ff9ebaf2a9526fd1b25fc196cec480e7`, verified). Every
finding was independently re-verified against the live guest source before responding.

This bundle covered the cross-chain trust path the first audit did not (Bitcoin data
parsing, the inner ETH reflection guest, the box-assembled batch path). Unlike the bundle-1
fixes, **C-01 / M-02 / L-01 are guest changes (`bitcoin.rs`, `reflect.rs`) and therefore
require the coordinated re-prove** — they fold into the re-prove already in flight.

## Summary

| ID | Severity | Disposition |
|----|----------|-------------|
| C-01 | Critical | **Fixed** (guest; re-prove) |
| H-01 | High | Deploy-gated mainnet re-anchor (unchanged from bundle 1; in the checklist) |
| M-01 | Medium / High-if-enabled | Bundle omission + ops gate; not a code bug |
| M-02 | Medium | **Fixed** (guest; re-prove) |
| L-01 | Low | **Fixed** (guest; re-prove) |
| I-01 | Info (positive) | No action — confirmed |
| I-02 | Info (positive/seam) | No action — freshness gate already on-chain |
| N-01 | Info (seam) | Captured in the mainnet checklist |

Three guest fixes (C-01, M-02, L-01) landed and folded into the re-prove. H-01/N-01 ride
the mainnet re-anchor. M-01 is non-blocking with `T_SWAP_BATCH` gated off.

---

## C-01 — Coinbase witness can carry forged Tacit envelopes — FIXED

Confirmed real. The full-block scan extracted Taproot envelopes from **every** transaction
including `txs[0]`, but BIP-141 fixes the coinbase wtxid to zero, so the coinbase witness is
the one witness in a block the commitment never binds. A prover could attach a forged
envelope as a second coinbase witness item while keeping the txid merkle root **and** the
witness commitment valid — surfacing a fake `T_CBTC_LOCK` / `T_BTC_CALL` / `T_CROSSOUT_MINT`
as a confirmed Bitcoin event. (Distinct from the already-closed REFLECT-1 non-coinbase
witness-swap; `T_CBTC_LOCK` and `T_BTC_CALL` were highest-risk — no independent membership
gate.)

Fixed two ways (defense in depth):
- **Primary** — `reflect.rs`: the coinbase is never an envelope source. Envelope extraction
  is gated `witness_committed && ti != 0`.
- **Shape** — `bitcoin.rs::parse_coinbase_commitment`: require **exactly one** coinbase
  witness item of exactly 32 bytes (`wit_count != 1` → reject), per BIP-141. A coinbase
  carrying an extra (envelope) item now fails the commitment parse, so no envelope is folded
  for the whole block.

Regression: `coinbase_extra_witness_item_rejected` (a 2-item coinbase is rejected by both
`parse_coinbase_commitment` and `verify_witness_commitment`); the non-coinbase swap test
still passes. cxfer-core 149/149.

## H-01 — Mode-B reflection Sepolia-anchored / no explicit source-domain — DEPLOY-GATED

Same finding as bundle-1 H-01. The domain is bound in-guest via the pinned genesis
sync-committee anchor + recursion vkey; the residual is the mainnet re-anchor (+ optional
explicit `sourceChainId`/fork-digest field). Captured as a hard pre-mainnet gate in
`ops/CHECKLIST-mainnet-reprove.md` (the H-01/N-01 close-out section). Cross-chain only;
correctly Sepolia-anchored for a testnet run.

## M-01 — Batch Groth16 VK / proof vectors absent — BUNDLE OMISSION + OPS GATE

Not a code bug. `batch_vk.bin` **exists** in the repo
(`src/batch_vk.bin`, sha256 `31fd05cc…a16bbc7c` matching the `BATCH_VK_SHA256` pin in
`groth16.rs`); it was simply not copied into the audit bundle. `T_SWAP_BATCH` is gated off in
the live path — the indexer attaches the Groth16 fold hook only when a VK is supplied and the
attester refuses without it. Posture: keep `T_SWAP_BATCH` disabled until the in-zkVM BN254
verifier is box-validated against a real ceremony-zkey vector (known-good + known-bad). No
V1 blocker while disabled.

## M-02 — Merkle routines accept duplicate-tail mutated blocks — FIXED

Confirmed: `compute_merkle_root` folds `[A,B,C,C]` to the same root as the real odd-leaf
`[A,B,C]`, so the "these txs ARE the exact block" claim was false (CVE-2012-2459 class).
Downstream already failed closed (live-set removal + IMT panic-on-duplicate make it
griefing/liveness, not a double-spend), but the over-claim is fixed at the source.

Added `compute_merkle_root_checked` (rejects a non-synthetic adjacent-equal pair — a genuine
odd node self-pairs only as the **last** node of its layer) and routed every
consensus-admission site to it: `verify_tx_in_block`, `verify_witness_commitment` (mutated
witness tree → `Some(false)` → no envelope folded), and the full-block scan in `reflect.rs`
(mutation → the completeness assert fails). Regression:
`merkle_root_checked_rejects_duplicate_tail`. The compact-path `verify_merkle_path`
(single-inclusion) is left as-is — adding tx-count awareness there is a larger interface
change and the single-inclusion vector is lower-risk; tracked as a follow-up.

## L-01 — Fixed-layout parsers accept trailing bytes — FIXED

Confirmed parser-drift only (the witness is BIP-141 committed, so trailing bytes can't change
consensus meaning or create value). Added exact-length checks to `parse_cmint`,
`parse_swap_var_envelope`, and `parse_farm_init_envelope` (reject any bytes past the final
signature field). Left the intentionally-extensible parsers (`parse_lp_add_envelope` variant
tail, `parse_lp_bond_fields` BP+ tail) untouched. All parser round-trip tests still pass.

## I-01 / I-02 / N-01 — positives & seams

- **I-01** (non-coinbase witness binding present and correct) — confirmed; C-01 was the
  coinbase exception, now closed.
- **I-02** (consumed-nullifier completeness closes the cross-lane double-spend) — confirmed.
  The required on-chain freshness gate (`ConsumedCountStale`, `ConfidentialPool.sol`) is
  present and active, so a stale eth-reflection proof with a lower `consumedNuCount` is
  rejected before acceptance. No action.
- **N-01** (enable-ordering / freshness seams) — captured in the mainnet checklist (relay
  canonicality, production source-domain constants, `ethPoolReflected == address(this)`,
  current consumed-count gate, batch path disabled).

## Re-prove impact

**C-01, M-02, L-01 change the guest (`bitcoin.rs` + `reflect.rs`), so they alter the
cxfer-core / reflection ELFs and rotate their vkeys — they REQUIRE the coordinated
re-prove.** They are exactly the kind of fix the in-flight re-prove should carry; the box must
build the committed source so `program_vkey` / `bitcoin_relay_vkey` reflect them, and
`ConfidentialPool` deploys with the new immutable vkeys. (This differs from the bundle-1
fixes, which were Solidity-only and re-prove-independent.) H-01's production re-anchor is the
separate mainnet step in the checklist.

## Verification

- `cargo test -p cxfer-core --lib` — 149/149 (incl. the two new regression tests).
- `cargo check` — both guest binaries (`confidential-pool-prover`, `reflection-prover`) compile.
