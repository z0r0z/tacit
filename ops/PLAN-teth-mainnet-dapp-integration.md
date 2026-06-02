# tETH mainnet → dapp integration plan

Goal: let public dapp users bridge ETH ↔ tETH on **Ethereum mainnet + mainnet
Bitcoin**, safely, behind a conservative cap. Everything below is sequenced so
nothing user-facing turns on until its backend prerequisite is real.

## Current state (done)

- Contracts live + Etherscan-verified (MTP-fix redeploy): mixer
  `0x82eb12463560E91A8B1D2312223E77c7C490cC37`, verifier
  `0x42Ab3d9dF0D5077ECfBD95Adf3f99b3bEa2a3CCb`, relay (MTP)
  `0x363582956488ff615ecF75783FEDc5ADB18Ca6D0`, genesis anchor BTC block 952014.
- Both round-trips validated on-chain: happy-path (3a) + Alice→Bob fractional
  (3b: export/cxfer/import, different recipient, tree growth).
- MTP fix proven on-chain (relay crossed non-monotonic block 952068).
- Retarget tooling built + validated against real mainnet data (won't brick at
  the 953568 boundary). `scripts/retarget-relay.sh` + advance-relay boundary cap.
- Incremental-state-save proven (3b continued from height 2→6) — but as a
  standalone parser, not yet host-integrated (Track A).
- GPU proving works token-free (~19 min / 66 blocks, 19 GB).
- dapp: `TETH_DEPLOYMENTS.mainnet` repointed to the live mixer, **gated**
  (`live:false` → `configureTethBridge` skipped → all bridge paths disabled),
  per-deposit cap `BRIDGE_MAINNET_MAX_DENOM_WEI = 1e15` (0.001 ETH).

---

## Track A — Production prover-loop (operational backbone) — DO FIRST

The continuous loop already exists (`scripts/sp1-prover-loop.sh`: each cycle
advances the relay a bounded `BLOCKS_PER_PROOF` range, proves the pool-state
transition over exactly those blocks, submits). It assumes a persisted prev
state between cycles (`STATE_DIR`). The **load** half is wired in the host; the
**save** half is missing — so cycle 2 can't continue once cycle 1 grows the pool
tree / null set past empty. That's the only gap.

Steps:
- **A1 (host save).** Port the validated tail-parser (was `build-state.mjs`)
  into the host (`contracts/sp1/script/src/main.rs`): after a successful
  `--onchain` cycle, parse the proof's own committed public-values tail (461-byte
  head, then nd×32 deposit_accs, nd×4 burn counts, claims, then per-pool
  `[root(32)|next_index(8)|frontier(20×32)]`, then `null_count(4)|nullifiers`,
  then `utxo_count(4)|utxos[77 each]`) into a `ProverState` and call the existing
  `save_prover_state(STATE_FILE)`. No guest/ELF change → **no vkey change, no
  redeploy.**
- **A2 (load guard already exists).** Host already loads `STATE_FILE` iff it
  matches the verifier's committed `(poolsHash,nullRoot,height,lastBlockHash)`;
  keep that as the staleness guard.
- **A3 (loop bounds).** Keep `BLOCKS_PER_PROOF` bounded so the GPU proof fits
  (66 blocks fit in 19 GB; default 10 is very safe). Loop advances relay → caps
  at epoch boundary (now handled) → proves → submits → saves.
- **A4 (gpu-server lifecycle).** The cuda server leaks GPU memory across many
  proofs (hit an AllocError on a stale server). Loop must (re)start
  `sp1-gpu-server` fresh periodically (e.g. every N cycles) and confirm the
  socket before proving. Start: `CUDA_VISIBLE_DEVICES=0 setsid nohup
  ~/.sp1/bin/sp1-gpu-server &`.
- **A5 (validate).** On the box: deposit → prove cycle 1 (genesis→t1) → submit;
  second deposit → prove cycle 2 (t1→t2) loading cycle 1's saved state → submit.
  Confirm cycle 2 continuity passes and never reconstructs from genesis.
- **A6 (hosting).** Decide the prover host for 24/7: the current vast.ai box vs a
  dedicated GPU box. Document recovery (restart loop + gpu-server, state file
  re-derivable from chain via A1 if lost).

Owner: prover/backend. No on-chain deploy. Exit criterion: loop runs ≥2
consecutive cycles unattended on mainnet.

---

## Track B — dapp un-gate + mainnet UI flow

Steps:
- **B1.** Confirm `TETH_DEPLOYMENTS.mainnet` (done: mixer + deployBlock 0x180e67f
  + assetId). Relay/verifier are derived on-chain (`HEADER_RELAY()`), no hardcode.
- **B2 (deposit).** Verify the UI deposit path (`bridgeDepositETH` →
  `deposit(bytes32,uint256)`, selector `1de26e16`) enforces the 0.001 cap on
  chainId 1, and the commitment derivation matches the guest. Smoke-test one
  real 0.001 deposit through the actual UI (not the headless harness).
- **B3 (mint/burn/withdraw).** Confirm the UI's Groth16 mint + burn builders and
  `withdrawFromBurn` call match the harness paths that round-tripped today
  (same zkey, same envelope layout, same Taproot reveal broadcast w/ retry).
- **B4 (CXFER variant).** dapp policy is BPP(0x22) on signet, regular BP(0x23) on
  mainnet (`T_CXFER_BPP` gating); guest accepts both. Confirm mainnet sends emit
  0x23 so the fungible-transfer UI matches what the guest verifies.
- **B5 (prove UX).** A user's deposit is proven by the operator's loop (Track A),
  not the user. UI must show "awaiting proof" with the expected latency (one loop
  cycle, ~minutes–tens of minutes) so users don't think it's stuck.
- **B6 (un-gate).** Flip the mainnet entry `live:false` → remove it (or true),
  keep the cap. This is the one outward-facing switch — do it only after A + C.

Owner: dapp. Depends on A (real hands-off proving) and C (cap/guardrails).

---

## Track C — user-protecting guardrails ("unlikely" risks, handled in advance)

- **C1 (caps).** Per-deposit cap already 0.001 ETH (bounds any single user's
  exposure). Add a **pilot total-value ceiling** (watch mixer `totalBalance`;
  pause new deposits in the UI past e.g. a few ETH) so aggregate exposure is
  bounded during the pilot. Pool-tree exhaustion needs ~1M deposits per
  denom — a non-issue at pilot scale, fully covered by the cap.
- **C2 (reorg).** Withdraw requires `CONFIRMATION_DEPTH=6`; relay does
  heaviest-chain fork choice. Deepest historical mainnet reorg = 4 blocks, so 6
  is comfortable. Add operator monitoring for a >2-block reorg near a pending
  burn; no contract change (depth is immutable). Document that escrowed funds are
  safe under reorg (only timing shifts).
- **C3 (monitoring + retarget).** Operator dashboard/alerts: relay tip vs BTC tip
  (advance cadence), prover-loop liveness, mixer balance vs supply, the 953568
  retarget window (schedule `retarget-relay.sh` for ~mid-June — see
  [[project_teth_relay_retarget_cadence]]).

Owner: ops/dapp. Mostly operational + a UI total-cap check.

---

## Dapp ↔ tETH API surface (the integration interface)

What the dapp already touches / must touch:
- **Mixer** (`0x82eb1246…`): `deposit(bytes32 commitment, uint256 denomWei)`
  payable (user); `withdrawFromBurn(bytes,bytes,uint256,bytes32[],uint256)`
  (user, after the burn is SP1-accepted + 6-conf). `getRootAccumulator`,
  `getNextLeafIndex` for tree state. **User-facing.**
- **Relay** (`0x363582…`): `advanceTip`/`retarget` (operator only),
  `tipHeight`/`tip`/`blockParent` (read). **Operator + read.**
- **Verifier** (`0x42Ab3d…`): `proveStateTransition` (operator only),
  `isAcceptedBurn`, `currentState` (read). **Operator + read.**
- **Worker** (`tacit-pin…workers.dev`): asset metadata pin + Bitcoin op scan /
  depth-3 confirmation gate. Confirm the mainnet scan path is live for tETH
  (signet cron-freeze caveat — see [[project_signet_cron_freeze]] — mainnet
  unaffected, but verify).
- **Prover-loop** (operator service, Track A): the off-chain backend that turns
  user deposits/burns into accepted on-chain state. The dapp does NOT call it;
  it just waits on `isAcceptedBurn` / leaf availability.
- **BTC envelope builders** (in `dapp/tacit.js`): mint/burn/cxfer Taproot reveal
  construction + broadcast (user-side, client builds the Groth16 mint/burn proof
  in-browser via snarkjs + the head zkey).

## Sequencing

1. **A** (prover-loop state-save) — backend, no deploy, validate 2 cycles.
2. **C1+C2+C3** (caps + monitoring) — operational, parallel with A.
3. **B1–B5** (verify dapp mainnet flow) — can start in parallel; B6 (un-gate)
   last, gated on A + C.
4. **Pilot**: un-gate behind the cap, operator-monitored, small total ceiling →
   widen as confidence grows.

## Open decisions (need user input)

- Prover host for 24/7 (vast.ai vs dedicated GPU) + who runs/monitors it.
- Pilot total-value ceiling (per-deposit is 0.001; aggregate cap?).
- Un-gate timing: after full A, or a tiny operator-manually-proven pilot first.
- Retarget: manual at the boundary vs a scheduled cron (~mid-June, block 953568).
- Whether to keep the standalone parser as a fallback recovery tool after A lands.
