# Confidential Pool — Production-Readiness Suite & Gate

Operational companion to the runnable gate
`contracts/sp1/confidential/readiness-gate.sh`. Defines what "ready" means for the
ConfidentialPool + cross-chain stack, maps every soundness/liveness property to the
layer and test that confirms it, and tracks the open items per layer.

This document is the *what to verify and where*. The gate is the *run it now*. Keep
them in sync: when a new property gains (or needs) a test, add a row here and a check
there.

## Layers

| Layer | Surface | Relay config |
|------|---------|--------------|
| **POOL** | Ethereum-only confidential pool: wrap / transfer / unwrap / fees, multi-asset escrow + pool-minted canonical ERC20s, seed-only recovery. | `BITCOIN_RELAY_VKEY = 0` (cross-chain attestation inert) |
| **BRIDGE** | Adds the Bitcoin↔Ethereum cross-lane: relay-attested Bitcoin state, `bridge_mint` / `bridge_burn`, cross-lane non-membership, trustless first-mint metadata. | `BITCOIN_RELAY_VKEY` set to the reflection prover's vkey |

A layer is **ready** only when every gate at that layer (BRIDGE inherits all of POOL)
is green. A `BLOCKED` gate is an expected-pending milestone, not a pass.

## Run

```
bash contracts/sp1/confidential/readiness-gate.sh        # full
READINESS_FAST=1 bash contracts/sp1/confidential/readiness-gate.sh   # skip slow invariant fuzzing
```

The gate runs every layer below, prints per-gate PASS/FAIL/BLOCKED, and a layered
verdict. It exits non-zero only on a FAIL (a regression); BLOCKED gates do not fail
the exit (they are tracked milestones).

## Verification layers

| Layer | What it proves | Harness |
|-------|----------------|---------|
| L1 Contract state machine | Escrow accounting, tree/nullifier/deposit integrity, domain/replay gates, relay monotonicity, payout scaling — *given a valid proof*. | `forge` — `ConfidentialPool.t.sol`, `ConfidentialPoolInvariant.t.sol`, `ConfidentialPoolFuzz.t.sol`, `ConfidentialTacWalkthrough.t.sol` |
| L2 Guest verification core | The secp/keccak primitives the guest delegates to: conservation kernel, BP+ range, Pedersen opening, IMT membership/non-membership, the reflection accumulators, Bitcoin header/tx/PoW. | `cargo test` — `cxfer-core` (native, against JS fixtures) |
| L3 Cross-impl KAT | The byte layouts (leaf / nullifier / depositId / claimId / destCommitment / tree root) agree across JS prover ↔ Solidity contract ↔ Rust guest. | `forge` `ConfidentialPoolKAT.t.sol` + `cargo` KATs + the `tests/*.mjs` that emit the fixtures |
| L4 Off-chain dapp/prover | Memo seal/open, seed-only recovery, indexer fold + gap detection, transfer/bridge prover round-trips, relay submission encoding. | `node tests/confidential-*.mjs` |
| L5 Real proof on-chain | A real SP1 Groth16 proof of the guest verifies through the genuine SP1 verifier (no mock). | `forge` `ConfidentialProofReal.t.sol`, `ConfidentialCrossLaneProofReal.t.sol` |
| L6 Deployment coherence | The deployed guest is the proven guest (vkey), the ELF is pinned, and the live config matches. | gate checks (vkey diff, ELF pin) |
| L7 Live | Real round-trip on a public network (Sepolia → mainnet), capped pilot. | manual, per `RUNBOOK-confidential-pool-deploy.md` |

## Property → test matrix

Soundness (the load-bearing invariants):

| Property | Layer | Confirmed by |
|----------|-------|--------------|
| Escrow solvency: pool holds exactly what it owes, per asset | L1 | `invariant_escrowSolvency` |
| No payout exceeds escrow / value·unitScale exactness | L1 | `testFuzz_payout_scales_exactly`, `test_settle_withdraw_over_escrow_reverts` |
| Wrap binds in-system **value** (not amount); u64 + alignment guards | L1 | `testFuzz_wrap_binds_value_not_amount`, `testFuzz_wrap_value_over_u64_reverts`, `testFuzz_wrap_unaligned_reverts` |
| Pool-minted supply conserved; never escrows | L1 | `testFuzz_poolminted_supply_conserved`, `test_pool_minted_asset_exit_and_reenter` |
| Tree append-only; root always in accepted history | L1 | `invariant_leafCount`, `invariant_rootAlwaysKnown` |
| Nullifier spends once (no double-spend) | L1 | `testFuzz_nullifier_spends_once`, `test_settle_nullifier_reuse_reverts` |
| Relay height strictly increases; spent/burn roots never zero | L1 | `invariant_relayMonotonic`, `test_stale_relay_proof_rejected`, `test_attest_zero_spent_root_rejected` |
| Per-output range `[0, 2⁶⁴)` (B1/B7) | L2 | `verify_range` KAT (`range_accepts_js_proof_and_rejects_tamper`) |
| Per-asset conservation kernel (no inflation) | L2 | `kernel_accepts_js_proof_and_rejects_tamper` |
| Note-bound nullifier ν = keccak(Cx‖Cy‖"spent") (B3) | L2/L3/L4 | `keccak_primitives_and_opening_match_js_and_contract`; `confidential-bridge-{mint,burn}.mjs` B3 pins |
| Cross-lane non-membership: unspent proves absent, spent cannot (B4) | L2 | `imt_accumulator_matches_js`, `imt_non_membership_matches_js` |
| Bridge-mint burn authority: member proves present, non-member rejects (B5) | L2 | `imt_membership_round_trips` |
| Empty spent/burn set has a **non-zero** sentinel root | L2 | `reflection_state_commits_relay_public_values`, `imt_accumulator_matches_js` |
| claimId / destCommitment non-malleable, guest-matching | L1/L2/L3 | `testFuzz_crossout_claimid_binding`, `test_crossout_claimid_matches_js`, `claim_id_and_dest_commitment_match_js_and_contract` |
| Bridge-mint one-mint-per-burn; root must be relay-attested | L1 | `test_bridge_mint_double_claim_reverts`, `test_bridge_mint_requires_attested_root` |
| Cross-domain replay blocked (chainBinding, PV version) | L1 | `test_settle_chain_mismatch_reverts`, `test_settle_bad_version_reverts` |
| Trustless first-mint metadata is confirmation-gated (B6) | L1 | `test_settle_attest_meta_requires_attested_pool_root` |
| Seed-only recovery; dropped-event fail-loud | L4 | `confidential-indexer.mjs`, `confidential-memo.mjs` |

## Open items by layer

**POOL**
- **vkey coherence** — the deploy default (`PROGRAM_VKEY`) must equal the vkey that has a real on-chain proof (`confidential_groth16.json`). When they differ, the deployed/intended guest has no L5 evidence. *Resolution: re-prove the current guest on the box, refresh the fixture, re-pin the default.*
- **Guest ELF pin** — the confidential guest has no `elf-vkey-pin.json` (the discipline the tETH guest uses: committed canonical ELF + pinned vkey + CI sha check). Adopt it so the proven ELF can never drift from the committed source silently.
- **Guest↔contract ABI parity** — the guest's emitted `PublicValues` layout must match the contract's `abi.decode` layout exactly. After any contract `PublicValues` change, the guest is re-frozen and re-proven in the same change.

**BRIDGE** (all POOL items, plus)
- **Bridge-mint authority = dedicated burn set — DONE.** `bridge_mint` proves the burned note's membership in the bridge-burn root (`bitcoinBurnRoot`), not the general spent-nullifier root, so only an explicit burn — not a normal Bitcoin spend — can mint on Ethereum. Enforced on both sides: `settle` requires a current non-zero `bitcoinBurnRoot` whenever `bitcoinBurnsConsumed` is non-empty, and the guest proves burn-set membership + emits `bitcoinBurnRoot` (re-proven guest vkey `0x00f02859`).
- **Reflection prover (`BITCOIN_RELAY_VKEY`) — DONE (on-chain proven).** The SP1 reflection guest (`src/reflect.rs`) re-derives `(poolRoot, spentRoot, burnRoot, height)` + a chained state digest from confirmed Bitcoin headers; a real GPU Groth16 proof of it folding a real signet T_CXFER_BPP verifies on-chain (`ConfidentialReflectionProofReal.t.sol`, fixture `reflection_groth16.json`), vkey `0x00be458f` (the canonical reflection ELF is committed + pinned in `elf-vkey-pin.json`; verify-vkey-pin.sh checks its sha256). Remaining: flip `BITCOIN_RELAY_VKEY` on at deploy once the worker attests continuously (deploy default is still `0`).
- **Bitcoin-side confidential-pool indexer — DONE.** `dapp/confidential-reflection-indexer.js` + `worker/src/reflection-attest.js` resolve confirmed effects, assemble batches, and drive the attestation cycle (`tests/confidential-reflection-*.mjs`, `reflection-attest.mjs`).
- **Bridge cross-lane settle proof (L5) — pending.** A real settle proof exercising the cross-lane non-membership gate must verify on-chain (`crosslane_groth16.json`); the test is fixture-gated and lands automatically when the box drops the fixture.

## Adding to the suite

- New contract property → a `testFuzz_`/`invariant_` in `ConfidentialPoolFuzz.t.sol` / `ConfidentialPoolInvariant.t.sol`, plus a matrix row.
- New guest primitive → a `cxfer-core` native KAT against a JS-emitted fixture (the `tests/gen-*-fixture.mjs` pipeline), plus L3 lock if it crosses the JS↔Sol↔Rust boundary.
- New op semantics → a `tests/confidential-*.mjs` round-trip that emits the fixture both the Solidity and Rust KATs consume, so all three implementations are locked to one vector.
