# Confidential pool + tETH bridge — production rollout (owned)

Owner-driven roadmap to prod. Status as of 2026-06-12.

## Current state
- **Confidential pool**: live on Sepolia pilot — `0xdd08be04…`, vkey `0x009cb098`, cETH registered. Settle relay works end-to-end (deposit via `wrap` queue type + transfer, both validated on-chain) through `api.tacit.finance` + the vast `cps` loop (durable). See [[project_confidential_pool_sepolia]].
- **tETH bridge**: live on mainnet, capped pilot (0.001 ETH/deposit, 10 ETH backing). Prover loop restarted + credit-stop durable (`onstart`→`durable-start.sh`, tmux `teth`). See [[project_teth_mainnet_live]], [[project_prover_monitoring]].

## Confidential pool → prod (in order)

### GATE 1 — full re-prove + fresh deploy + multi-asset (greenlit 2026-06-12) — IMMEDIATE
**VERIFIED FINDING:** rebuilding from the committed `f0970c2` source rotates BOTH vkeys — settle `0x009cb098 → 0x00b9cddb` AND reflection from `0x00afe060`. The settle rotation is **INCIDENTAL**: f0970c2's `lib.rs` change is `LiveUtxoSet`-only (the reflection live set; `from_sorted`/`get`/`insert`/`remove` went 2-tuple→3-tuple to carry the note asset), and the settle guest (`main.rs`) does **not** use `LiveUtxoSet` — so the settle behavior is byte-equivalent; the vkey moved only because that unused reflection code is compiled into `cxfer-guest` (DCE didn't strip it). **User greenlit the redeploy + wants multi-asset tested**, so we do the FULL re-prove + fresh deploy (no isolate-cleanup needed to preserve the old pilot). FOLLOW-UP cleanliness: feature-gate `LiveUtxoSet`/`ScanReflection`/reflection accumulators in `cxfer-core` behind a `reflection` feature so future reflection edits stop churning the settle vkey.

**Sequence (run as one clean unit; box already coherent — source synced, deployed ELFs restored, cps idle):**
1. Pause cps. `cd guest && cargo prove build` from the synced source → cxfer-guest `916c892c` (vkey `0x00b9cddb`), reflection-prover `a5a9c829` (vkey TBD — extract).
2. `drive-fee-reprove.sh` → re-prove all 7 settle ops (new vkey `0x00b9cddb`) + reflection (new vkey). ~15 min GPU; gpu-server fresh per prove (keep tETH up).
3. `scripts/confidential-reprove-apply.sh` → bump `elf-vkey-pin.json` (BOTH vkeys + BOTH ELF shas) + all 7 fixtures → `verify-vkey-pin.sh` + `*ProofReal` forge → commit (z0r0z).
4. **Redeploy ConfidentialPool**: `SP1_VERIFIER=0x6F9a1D26`, `PROGRAM_VKEY=0x00b9cddb`, `EXPECTED_CHAIN_ID=11155111`. For cross-lane multi-asset: `BITCOIN_RELAY_VKEY`=<new reflection vkey> + `HEADER_RELAY` + `GENESIS_REFLECTION_ANCHOR` + `ACK_REFLECTION_ANCHORED=1` (needs the reflection relay running); else `=0` for EVM-only first.
5. Register **cETH + a 2nd asset**. Repoint the box cps loop (`run-cps.sh` `POOL=`) to the new pool + restart. Re-index live-set `livePairs→liveTriples`.
6. **Test multi-asset**: (a) EVM-only — register 2 assets, confidential swap cETH↔asset2 + cross-asset transfers (works standalone, no relay); (b) full cross-lane Bitcoin-pool multi-asset (the asset-carrying reflection) — needs the reflection relay operational.

### GATE 3 — dapp UI (user-facing)
Build the standalone confidential-pool UI per `ops/PLAN-confidential-pool-ui.md` (deposit/transfer/withdraw/swap + EVM-wallet + Sepolia note indexer). Backend is done.

### GATE 4 — mainnet
Close the PLATINUM readiness checklist (relay + indexer), deploy to mainnet with `EXPECTED_VERIFIER_CODEHASH` (the script enforces it on chainid 1), capped pilot. Security residual (value-unbounded inflation for poolMinted assets under a full guest compromise — escrow assets ARE bounded) is a trust-doc, not a contract check.

## tETH bridge → prod (in order)
1. **Retarget cadence** — the relay `retarget()` at each 2016-block boundary (the ~953568 boundary mid-June is MANUAL); schedule/automate it (liveness-critical, else the tip stalls).
2. **Deferred audit items** (ops/reviews/AUDIT-teth-bridge-mainnet-2026-06-03.md) — LOCK-2 backlog-aware deposit gate, LOCK-3 denom-bound nullifierHash, QUAL-1 64-byte/depth guard, TRUST-1 on-chain nullifier set.
3. **Prover durability** — fold the heartbeat into `run-loop.sh` for full restart-durability (currently a separate `start-heartbeat.sh`).
4. **Raise caps** — after N validated round-trips beyond the current 0.001 ETH / 10 ETH pilot.
5. **Fold into the confidential pool** — the cross-lane endgame (depends on Gate 1+2).

## Immediate next action
Gate 1 (the reflection re-prove). It's a ~15-min GPU sequence + a coherence-critical pin/commit — run it as a clean, focused unit (the box artifacts persist if interrupted; `confidential-reprove-apply.sh` is idempotent). Pilot + live bridge stay stable throughout.
