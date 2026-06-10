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
- **vkey coherence — enforced.** Gate layer 4 cross-checks the pin (`elf-vkey-pin.json program_vkey`) == deploy `DEFAULT_VKEY` == EVERY settle fixture (`confidential`/`swap`/`lp`/`crosslane`), and `DeployConfidentialPool.s.sol` reverts a deploy whose `PROGRAM_VKEY` ≠ the pin (override only via `ALLOW_UNPINNED_VKEY=1`). Currently coherent at settle `0x00d0fb85…` / reflection `0x0050d656…`. **Redeploy pending:** the live Sepolia pool (`0x445031c4…`) was deployed at the pre-opening-sigma `0x00cc4e72…`, so the current guest's proofs revert there until the pool is redeployed at `0x00d0fb85…` (a deploy op, `RUNBOOK-confidential-pool-deploy.md`).
- **Guest ELF pin — DONE.** `elf-vkey-pin.json` commits both ELF sha256s + vkeys; `verify-vkey-pin.sh` (CI) and gate layer 5 (now a real check, not a file-exists no-op) assert the committed ELF matches the pin, so the proven ELF can't drift from source silently.
- **Swap/LP output binding — CLOSED (opening sigma, Parity F1).** The OP_SWAP/OP_LP witness binds amounts with an *opening sigma* — a Schnorr proof of knowledge of the note blinding for the public amount, whose challenge binds the whole intent (`out_owner`/`min_out`/reserves) — instead of exposing the raw blinding `r`. So the settle prover verifies the openings WITHOUT learning `r` and can neither spend the input nor redirect the output (the swap/LP analog of the kernel hiding transfer blindings). Proven on-chain: `ConfidentialSwapProofReal` + `ConfidentialLpProofReal` at vkey `0x00d0fb85…`; client parity in `tests/confidential-{swap,lp}-op.mjs` + `confidential-opening-sigma.mjs`.
- **Guest↔contract ABI parity** — the guest's emitted `PublicValues` layout must match the contract's `abi.decode` layout exactly. After any contract `PublicValues` change, the guest is re-frozen and re-proven in the same change.
- **OP_OTC (confidential 2-party swap) — implemented + validated, pending the settle re-prove.** A direct maker↔taker swap of shielded notes (`asset_a`↔`asset_b`, opening-sigma intent binding, per-asset conservation) — emits leaves + nullifiers the existing `settle` already applies, so NO contract/`PublicValues` change. Validated three ways: client round-trip (`tests/confidential-otc-op.mjs`, in `node_suite`), the guest compiles, and an in-zkVM execute of the real witness accepts it (`sp1/reflect-exec` `otc-execute`, ~1.08M cycles; box harness `exec-otc.rs` + fixture `tests/gen-confidential-otc-fixture.mjs`). Since `OP_OTC` is in the same settle ELF, it lands at the next settle re-prove — which produces a NEW settle vkey (replaces `0x00d0fb85`) and re-proves ALL settle fixtures (`confidential`/`swap`/`lp`/`crosslane` + a new `otc_groth16.json` + `ConfidentialOtcProofReal`, then added to the gate's vkey-coherence list). Design: `ops/PLAN-confidential-otc-evm.md`.
- **OP_BID (confidential partial-fill bid) — implemented + validated, pending the settle re-prove.** Buyer-offline limit order (Bitcoin `T_PREAUTH_BID_VAR` parity): the buyer pre-funds `max_fill·price` of `asset_b` and pre-signs, per grid fill, the openings of its received notes (blindings only it can reproduce, `deriveNote(bid_secret, asset, f)`); a seller fills a grid amount, the unfilled remainder is refunded. The K presignature lives OFF-CHAIN (the published bid) — the witness carries only the chosen fill, so the guest is OTC-complexity + a grid/refund check; no contract change. Validated three ways: client round-trip (`tests/confidential-bid-op.mjs`, in `node_suite`, incl. grid/range/refund-shorting rejects), the guest compiles, and an in-zkVM execute accepts the real witness (`sp1/reflect-exec` `bid-execute`, ~1.19M cycles; `exec-bid.rs` + `tests/gen-confidential-bid-fixture.mjs`). Ships at the same settle re-prove (+ a `bid_groth16.json` + `ConfidentialBidProofReal`). v1 = single-shot partial fill; repeated fills + `decimals_scale` price granularity are follow-ups. Design: `ops/PLAN-confidential-orderbook-evm.md`.

**BRIDGE** (all POOL items, plus)
- **Bridge-mint authority = dedicated burn set — DONE.** `bridge_mint` proves the burned note's membership in the bridge-burn root (`bitcoinBurnRoot`), not the general spent-nullifier root, so only an explicit burn — not a normal Bitcoin spend — can mint on Ethereum. Enforced on both sides: `settle` requires a current non-zero `bitcoinBurnRoot` whenever `bitcoinBurnsConsumed` is non-empty, and the guest proves burn-set membership + emits `bitcoinBurnRoot` (settle guest pinned at `0x00d0fb85`).
- **Reflection prover (`BITCOIN_RELAY_VKEY`) — F1/F2/F3 closed + proven; F4 built, re-prove pending.** The SP1 reflection guest re-derives `(poolRoot, spentRoot, burnRoot, height)` + a chained state digest from confirmed Bitcoin headers; a real GPU Groth16 proof of the **relay-anchor** guest (folding a real signet block 307547 effect) verifies on-chain (`ConfidentialReflectionProofReal.t.sol`, fixture `reflection_groth16.json`), vkey `0x0050d656…` (committed + pinned; verify-vkey-pin.sh checks its sha256).
  - **Header anchor + difficulty + confirmation (F1/F2/F3) — CLOSED + proven.** The guest commits `bitcoinPrevHash` (headers[0]'s prev) + `bitcoinTipHash` (the batch tip); `attestBitcoinStateProven` pins the tip to `HEADER_RELAY.tip()` and the prev to the prior attested tip, each within `REFLECTION_FINALITY_WINDOW=6` (mirrors `SP1PoolRootVerifier`). Forcing the whole proven chain to be canonical Bitcoin makes self-declared difficulty moot and the finality window is the confirmation guard. This is the model in the pinned `0x0050d656` proof.
  - **Completeness (F4) — implemented in source, GPU re-prove PENDING.** The full-scan guest (walks EVERY tx of EVERY block — the provided txs must re-hash to the header's merkle root, so none is omitted — and EVERY vin against the handed live UTXO set via `scan_tx_spends`/`LiveUtxoSet`/`ScanReflection`, so no pool-note spend can be silently omitted; full-scan genesis digest `0xec719b81` three-way pinned Rust==JS==contract) is built in `src/reflect.rs` + the JS scan indexer + the real signet-307547 input fixture (`reflection_input.json`) + the local execute harness (`sp1/reflect-exec`). What remains is the box step: GPU-prove the full-scan guest → a NEW reflection vkey (replaces `0x0050d656`) → refresh `reflection_groth16.json` + re-pin → drop the deploy `ACK_REFLECTION_ANCHORED` F4 caveat. Until then the cross-lane gate carries the F4 witnessed-omission caveat (bridge_mint is anchor-trustless regardless — burns are tx-confirmed).
  **Beyond F4, the residual is operational only:** a Bitcoin reorg deeper than the finality window (accept-and-document for the pilot, as on the tETH bridge / AMM) and the relay running (liveness). `BITCOIN_RELAY_VKEY` stays 0 on the Ethereum-only deploy until the relay is wired + cross-chain activated.
- **Bitcoin-side confidential-pool indexer — DONE (full scan).** The shipped indexer is `dapp/confidential-reflection-scan-indexer.js` (+ `worker/src/reflection-attest.js`): it assembles the full-scan batch (every tx of every block + the live UTXO set) and drives the attestation cycle. Covered by `tests/confidential-reflection-scan*.mjs` (the witnessed-model `confidential-reflection-{state,witness,indexer}.mjs` stay as the superseded-model cross-check oracle); gate layer 8 runs both.
- **Bridge cross-lane settle proof (L5) — DONE.** A real settle proof exercising the cross-lane non-membership gate verifies on-chain (`ConfidentialCrossLaneProofReal`, fixture `crosslane_groth16.json`, vkey `0x00d0fb85…`).

## Adding to the suite

- New contract property → a `testFuzz_`/`invariant_` in `ConfidentialPoolFuzz.t.sol` / `ConfidentialPoolInvariant.t.sol`, plus a matrix row.
- New guest primitive → a `cxfer-core` native KAT against a JS-emitted fixture (the `tests/gen-*-fixture.mjs` pipeline), plus L3 lock if it crosses the JS↔Sol↔Rust boundary.
- New op semantics → a `tests/confidential-*.mjs` round-trip that emits the fixture both the Solidity and Rust KATs consume, so all three implementations are locked to one vector.
