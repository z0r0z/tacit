# Confidential pool + tETH bridge — production rollout (owned)

Owner-driven roadmap to prod. Status as of 2026-06-12.

## Current state
- **Confidential pool**: live on Sepolia pilot — `0xdd08be04…`, vkey `0x009cb098`, cETH registered. Settle relay works end-to-end (deposit via `wrap` queue type + transfer, both validated on-chain) through `api.tacit.finance` + the vast `cps` loop (durable). See [[project_confidential_pool_sepolia]].
- **tETH bridge**: live on mainnet, capped pilot (0.001 ETH/deposit, 10 ETH backing). Prover loop restarted + credit-stop durable (`onstart`→`durable-start.sh`, tmux `teth`). See [[project_teth_mainnet_live]], [[project_prover_monitoring]].

## Confidential pool → prod (in order)

### GATE 1 — reflection re-prove (resolve the f0970c2 drift) — IMMEDIATE
`f0970c2` changed the reflection guest (`cxfer-core/src/lib.rs` b98ae398, `src/reflect.rs` 39234917) without rebuilding the ELF/pin → the committed source is ahead of the committed `reflection-prover` ELF + pin (`bitcoin_relay_vkey` 0x00afe060). **The single-asset pilot is UNAFFECTED** (deployed pool runs `BITCOIN_RELAY_VKEY=0`). This gates the 2nd Bitcoin-pool asset / cross-lane. Steps:
1. **Pre-flight**: confirm the box's working source vs the committed (`lib.rs` committed = b98ae398; box was `3d995ba7` = stale cruft). Re-prove must build the COMMITTED source, so sync it to a clean box build dir (don't trust the box working copy). Land the EXPECT_VKEY guard into the box harnesses (it lives in committed `exec-prove.rs`/`exec-reflect-prove.rs`).
2. `cargo build` both ELFs from the committed source. Expect: settle vkey **stays `0x009cb098`** (f0970c2 is reflection-only — verify, don't assume); reflection vkey **rotates** from 0x00afe060.
3. EXPECT_VKEY-guarded re-prove (catches drift before the GPU run / on-chain revert). gpu-server fresh per prove (shares the live tETH GPU — keep tETH up).
4. `scripts/confidential-reprove-apply.sh` → bump `elf-vkey-pin.json` (reflection ELF sha + vkey; settle unchanged) + the reflection fixture → `verify-vkey-pin.sh` + the `*ProofReal` forge tests → commit (z0r0z).

### GATE 2 — 2nd-asset / cross-lane enablement (after Gate 1)
Redeploy ConfidentialPool with `BITCOIN_RELAY_VKEY` = the new reflection vkey (it's immutable, so a fresh pool) + `HEADER_RELAY` + genesis anchor; re-index live-set snapshots `livePairs→liveTriples` (the f0970c2 asset-carrying change); allowlist the 2nd asset (TAC-first per [[project_crosslane_rollout]]). Re-register assets on the new pool.

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
