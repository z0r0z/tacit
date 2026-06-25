# Maintainer response — Claude Opus 4.8 cross-chain audit (bundle 2, 2026-06-25)

Companion to `TACIT_FINANCE_CROSSCHAIN_AUDIT_CLAUDE_OPUS_2026-06-25.md` (bundle hash
`af33083a…9076`, distinct from bundle 1). Every finding re-verified against the live guest
source before responding.

This audit largely **confirms** the prior work: it independently verifies the C-01
witness-commitment fix is sound and wired before any envelope parse in all three provenance
paths, that the burn→mint provenance DAG is rigorous, that the inner ETH reflection proves
against the finalized state root with a sound cross-cycle anchor, and — by computation — that
the pinned BabyJubJub generators are genuine NUMS. No new Critical or High exploitable
single-component bug.

## Summary

| ID | Severity | Disposition |
|----|----------|-------------|
| H-01 | High | Deploy-gated mainnet re-anchor (refined: domain binding is sound; residual is the Sepolia anchor). In the checklist. |
| X-01 | Medium | Box-validation gate (the batch path in-zkVM). Verifier *logic* now has a native test; in-zkVM + cross-curve end-to-end remain the box step. |
| X-02 | Low | Hardening-only (auditor: not required for soundness); folds into the H-01 eth-guest rebuild. In the checklist. |
| X-03 | Low | **Fixed** (guest; re-prove) — not exploitable, but a clean consensus-faithfulness fix. |
| X-04 | Info | Lockstep-pin-rotation CI/checklist item. Added to the checklist. |

One guest fix landed (X-03). H-01/X-01/X-02/X-04 are deploy/box/CI gates already tracked.

## H-01 — ETH reflection Sepolia-anchored — DEPLOY-GATED (refined)

The auditor refines this usefully: the domain binding is **sound and transitive** — the pinned
genesis sync-committee only ever signed under the real beacon domain (which mixes in
`genesis_validators_root` + fork version), so a foreign-domain proof breaks the first
`verify_update` signature check. There is no domain-collision hole; the residual exploitable
risk is specifically that the pinned committee/vkey are **Sepolia's**. Closed by the mainnet
re-anchor (re-pin `ETH_GENESIS_SYNC_COMMITTEE` + `ETH_REFLECTION_VKEY`, regenerate the outer
ELF) — already the H-01/N-01 close-out in `ops/CHECKLIST-mainnet-reprove.md`. No source change.

## X-01 — Batch path unvalidated in-zkVM — BOX GATE (verifier logic now tested)

The static read is clean; the residual is execution. The verifier **logic** is now covered by
the native test `swapbatch_verifier_accepts_real_and_rejects_forgeries` (`groth16.rs`, committed
this round) — it runs the real in-guest `groth16_bn254_verify` against a real bn128 proof and
asserts accept + public-input-tamper-reject + G2-limb-swap-reject. What remains is exactly the
box execution the auditor (and README) solicit: on the SP1 box, (1) verify a real
**ceremony-zkey** proof against `groth16.rs` (the native test uses the dev VK; `delta2` differs),
(2) confirm `bn` resolves to the SP1-accelerated build, (3) validate `babyjubjub::verify_xcurve`
against real cross-curve vectors, (4) run a full envelope+proof `swap_batch` end-to-end. Keep the
batch lane disabled until green. (As established: `fold_swap_batch` is reachable on-chain via the
in-guest dispatch, so this gate is mandatory before arming — but enabling later needs no re-prove
and no contract change.)

## X-02 — No explicit source-domain field — HARDENING (deferred to re-anchor)

Auditor: defense-in-depth, **not required for soundness** (binding is transitive via the genesis
committee). The explicit `compute_fork_digest(fork_version, genesis_validators_root)` /
`sourceChainId` field touches the eth-reflection guest, which is rebuilt at the H-01 mainnet
re-anchor — so it belongs there, not a second eth-vkey rotation now. Captured as the H-2 item in
`ops/CHECKLIST-mainnet-reprove.md`.

## X-03 — `compute_txid` 64-byte guard checked full, not stripped, length — FIXED

Confirmed and not exploitable (every txid merkle path is proven into a real PoW-anchored block
root; a crafted 64-byte-stripped tx can't be mined at the needed position or collide a
`double_sha256` internal node). Fixed for consensus-faithfulness anyway: `compute_txid` now also
rejects when the **stripped** serialization is 64 bytes (a segwit tx whose stripped form is 64B
but whose full form differs previously slipped the full-length guard). Regression added to
`compute_txid_rejects_64byte_nonwitness` (a segwit tx with a 64-byte stripped form returns
`None`). Guest change — folds into this re-prove. cxfer-core 149/149.

## X-04 — Lockstep pin rotation — CHECKLIST/CI

The production cutover moves several pins together (eth vkey, genesis committee, batch VK
SHA-256, outer ELF/vkey); a partial rotation is fail-closed but should be an explicit gate. Added
to `ops/CHECKLIST-mainnet-reprove.md` as a lockstep assertion. Doc/CI item, no source change.

## Positive checks

The audit's §C confirmations (witness-commitment binding sound + wired before parse; Bitcoin
primitives hardened; retarget-in-guest safe; burn→mint DAG rigorous; inner ETH reflection sound;
batch path cannot inflate; Groth16 verifier sound on read; cross-curve binding unforgeable + NUMS
generators verified; parsers safe-by-construction) match our own review. The C-01 inflation class
is confirmed closed, and the bundle-1 N-01 Mode-B mechanism is confirmed soundly implemented
(cross-cycle anchor), gated on the H-01 re-anchor.

## Re-prove impact

X-03 is a guest (`bitcoin.rs`) change → folds into the coordinated re-prove (alongside the C-01 /
M-02 / L-01 / swap_batch work). No contract change. H-01/X-02 ride the separate mainnet re-anchor;
X-01/X-04 are box/CI gates.

## Verification

- `cargo test -p cxfer-core --lib` — 149/149 (incl. the X-03 regression).
- `cargo check` — both guest binaries compile; non-test build unaffected by the test-only gate.
