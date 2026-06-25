# Mainnet launch checklist

A single go/no-go that ties the per-surface readiness docs together with the
exact gate flags. Each surface keeps its own detailed runbook (linked); this is
the unified sequence and the one place the gates are listed.

**Posture (2026-06-16):** every fund-critical surface is sound for the gated
pilot. What remains is launch decisions plus the staged confidential re-prove —
not defect-fixing. The four mainnet gates are independent: the bridge, AMM,
mixer, and confidential pool can each launch on their own timeline. The only
shared prerequisite is the confidential re-prove (§A), which the cross-chain
features depend on.

## The gates (all OFF today)

| Surface | Flag | Location | Today |
|---|---|---|---|
| AMM pools | `AMM_DEPLOYMENTS.mainnet.pools` | `dapp/tacit.js` (~317) | `false` |
| Mixer pool ops | `AMM_DEPLOYMENTS.mainnet.mixerPoolOps` | `dapp/tacit.js` (~317) | `false` |
| tETH bridge | `TETH_DEPLOYMENTS … live` | `dapp/tacit.js` (~9913) | `false` |
| Canonical TAC asset | `live` | `dapp/tacit.js` (~9948) | `false` |

Flipping a gate is the **last** step for that surface — only after its
prerequisites below pass. The dapp auto-deploys from `main`; the worker
(`tacit-api`) is a **manual** deploy from `main` — see §Cross-cutting.

## A. Confidential pool — the mainnet re-prove bundle *(shared prereq for cross-chain)*

The settle and reflection guest **sources may be ahead of the committed ELFs** by
new mainnet features. They re-prove together and rotate both vkeys. The current
Sepolia testing vkeys are the top-level authoritative fields in
`contracts/sp1/confidential/elf-vkey-pin.json`; treat those pins as valid for the
Sepolia bundle only. Mainnet gets its own re-anchored bundle.

- [ ] Re-prove **both** ELFs on the prover host — `CHECKLIST-mainnet-reprove.md`, `PLAN-unified-twochain-rollout.md`
- [ ] In **one commit**: reconcile `elf-vkey-pin.json` (both sha256 + both vkeys), the `FROZEN_*` drift guards, the `*ProofReal` fixtures, the readiness-gate allowlist, and `DeployConfidentialPool` `DEFAULT_VKEY` — plus the matching `ConfidentialPool` PublicValues / lock-set fields
- [ ] `readiness-gate.sh` → GOLD (vkey↔ELF coherence, real proofs, cross-impl parity)
- [ ] Deploy `ConfidentialPool` with the new immutable vkeys — `RUNBOOK-confidential-mainnet-deploy.md`
- [ ] Set `REFLECTION_CONFIRMATIONS` for the deploy — the immutable Bitcoin burial depth the reflection anchor enforces before a bridge_mint can act (default 6 = pilot / BTC finality, same as the mixer's `CONFIRMATION_DEPTH`). Raise it toward the 144 max as backing scales — it's a pure deploy knob (no logic redeploy), and the relay's epoch targets aren't branch-specific, so deeper burial is the lever for the reorg posture acknowledged in `ACK_REFLECTION_ANCHORED`
- [ ] Wire `HEADER_RELAY` to a mainnet Bitcoin relay + the mainnet eth genesis sync-committee anchor
  - At genesis the relay rejects a non-canonical `BTC_GENESIS_TARGET` (must equal the decode of its own nBits) and `BTC_GENESIS_TIMESTAMP` must be the epoch-START block's ts even if the tip is anchored mid-epoch — both are loud-fail guards now, but verify the values against an explorer before the one-shot genesis
- [ ] Confirm a forward bridge prove accepts on-chain at the new vkeys
- [ ] **Fast-lane coherence gate** — `ConfidentialPool`'s relaxed `btcHomed` bar (a Bitcoin-homed note spent directly on Ethereum, writing `bitcoinConsumed`) is **only safe if the deployed reflection guest folds the consumed-ν set into the Bitcoin spent set** (`PLAN-fast-lane-shared-nullifier.md`). With a non-folding reflection vkey it is a guaranteed double-spend. So: deploy the relaxed-bar contract **only** once the consumed-ν fold is in the pinned `BITCOIN_RELAY_VKEY` (its `REFLECTION_GENESIS_DIGEST` carries `consumed_count`). The contract + ABI are landed; the guest fold is one atomic re-proven bundle still pending — until it ships, the relaxed bar must not reach a live deploy
- [ ] **Fast-lane FRESHNESS gate** (built in code, re-prove pending) — completeness against the contract's *recorded* consume set, enforced at TWO points: (1) the eth-reflection guest reads `ConfidentialPool.bitcoinConsumedCount` (slot 120) from the same finalized state and asserts its folded `consumedNuCount == bitcoinConsumedCount` AT THAT finalized block; (2) the reflection commits `consumedCount` in `BitcoinRelayPublicValues` and `attestBitcoinStateProven` requires `consumedCount == bitcoinConsumedCount` (NOW). The guest assert alone was insufficient — it forces folding everything up to the eth proof's *finalized slot*, but the slot is worker-chosen, so a worker could attest a racing Bitcoin spend with a deliberately-stale eth proof (slot before a recent consume) and double-credit + brick reflection. The contract gate ties the count to the live counter, forcing the finalized slot recent enough to cover every consume (a consume landing in the proof→attest window just makes attest revert → re-attest with a fresher eth proof — a liveness retry, not a safety gap). Landed: contract counter + the `consumedCount` public-values field + the `ConsumedCountStale` gate + forge tests (`test_fast_lane_consumed_count_*`, `test_fast_lane_freshness_gate_rejects_stale_attest`) + the guest assert + commit. Box step: add slot 120 to the eth-reflection `eth_getProof` witness; the re-prove that rotates `ETH_REFLECTION_VKEY` + `BITCOIN_RELAY_VKEY` (the public-values layout changed) folds this into the SAME atomic bundle as the coherence gate

## B. tETH bridge — un-gate from the capped pilot

Live on mainnet but capped (0.001 ETH/deposit, 10 ETH backing) with the dapp
gate `live:false`. Detail: `RUNBOOK-teth-bridge-mainnet.md`,
`AUDIT-teth-bridge-mainnet-readiness-2026-05-29.md`.

- [ ] Complete the documented un-gate items before raising value (the backlog-aware deposit gate + denom-bound nullifier land in the next ELF)
- [ ] Raise / remove `BRIDGE_MAINNET_MAX_DENOM_WEI` + the aggregate cap to the launch level
- [ ] Confirm the relay retarget cadence is current (2016-block boundaries) — `project_teth_relay_retarget_cadence`
- [ ] Flip `TETH_DEPLOYMENTS … live` → `true`

## C. AMM — activate pools

Trustless layer proven on signet (replay engine + production `/ops` discovery +
the pre-action gate, all live + verified with a real swap). Detail:
`AMM-mainnet-activation.md`, `AMM.md`.

- [ ] Reorg-gate decision (accept-and-document for pilot, or build it)
- [ ] Confirm the proving artifacts resolve on mainnet (ceremony-head zkeys + the vendor wasms — the same path proven on signet)
- [ ] Flip `AMM_DEPLOYMENTS.mainnet.pools` → `true`
  - The trustless pre-action gate protects **every** post-flip mainnet pool from op #1 — pools created after the `recordAmmOp` deploy have a complete `/ops` index, so the gate verifies them (no backfill needed for fresh pools)

## D. Mixer — activate pools

No-inflation invariant proven by three independent layers; ceremony finalized +
pinned. Detail: `MIXER.md`, `RUNBOOK-mainnet-deploy.md`.

- [ ] Anonymity-set bootstrap decision (seed liquidity / pool vetting — the thresholds are operational, not protocol)
- [ ] Confirm the ceremony VK pin matches the deployed verifier
- [ ] Flip `AMM_DEPLOYMENTS.mainnet.mixerPoolOps` → `true`

## E. Canonical assets

- [ ] Flip the canonical TAC asset `live` → `true` (`dapp/tacit.js` ~9948) when its issuance path is launch-ready — `CHECKLIST-v1-multi-asset-readiness.md`

## Cross-cutting (every surface)

- [ ] **Trust register**: review `TRUST-REGISTER-production.md`; confirm the CollateralEngine owner is the
  production multisig/timelock, the relay genesis ceremony is archived, launch assets are allowlisted, and any
  Bitcoin hook target authenticates the canonical executor + caller pubkey.
- [ ] **Worker deploy**: `tacit-api` does NOT auto-deploy — manually deploy it from `main` so the worker code (indexer, `/ops`, validators) matches the dapp. The dapp (`tacit.finance`) auto-deploys from `main`.
- [ ] **Reorg posture**: accept-and-document is the pilot stance across bridge / confidential / mixer; record the chosen cadence per surface before un-gating high value.
- [ ] **Liveness**: the worker is discovery-only for soundness (the client reconstructs + verifies state from chain), but it is a single availability dependency — confirm the prover-host run-loop and the relay retarget loop are durable.
- [ ] **Monitoring**: `/prover-health`, the relay tip, and the cron scan are live.

## Go / no-go

A surface is **GO** when its section's boxes are checked and its detailed
readiness doc passes. The gates are independent — launch on separate timelines.
§A (the confidential re-prove) is the only shared prerequisite, and only for the
cross-chain features (the Ethereum-only confidential pool, the AMM, the mixer,
and the existing bridge pilot do not depend on it).
