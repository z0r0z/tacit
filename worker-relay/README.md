# Tacit relay + reflection backbone (Render, GPU-free)

Production deployment of the ConfidentialPool **data plane** — the piece that today
runs on a self-hosted GPU box (`ops/scripts/*-loop.sh`) — as **Render** services that
prove on the **Succinct network prover** instead of a local GPU. The GPU box remains a
**fallback only** (see below).

This mirrors the existing architecture exactly (`ops/runbooks/PRODUCTION-RELAY-BACKBONE.md`):
the **control plane** stays the Cloudflare Worker (`worker/`) — it never proves and never
holds funds; it queues opaque witnesses and hands back proofs the contract independently
verifies against its pinned vkeys. All safety lives in the contract's vkey verification, so
losing/redeploying any of these services loses no funds and no authority.

On-chain library: **viem** (ESM-native, typed, light).

---

## What runs

| Service | Render type | File | Role |
|---|---|---|---|
| `tacit-reflection` | Background Worker (always-on) | `src/reflection-folder.js` | Incremental Bitcoin-state attest — keeps reflection 1–2 blocks behind tip so the 176-block liveness trap never recurs. |
| `tacit-settle` | Background Worker (always-on) | `src/settle-relay.js` | Confidential settle relay for user ops (transfer/swap/route/lp/…); `feeGate` + per-job timeout. |
| `tacit-replenish` | Cron (`*/30 * * * *`) | `src/replenish.js` | Sweep fee assets → PROVE + ETH via zQuoter/zRouter, deposit PROVE to the Succinct vApp. |
| `tacit-monitor` | Cron (`*/5 * * * *`) | `src/balance-monitor.js` | Alert on low PROVE/ETH and on reflection lag > N blocks. |

Shared libs: `src/lib/config.js` (env + addresses), `src/lib/chain.js` (viem clients + ABIs),
`src/lib/prover.js` (spawn the network-prove binaries), `src/lib/worker-client.js`
(control-plane routes).

### Loop shape (same idempotency as the box)

**Reflection** — `GET /reflection/job?network=` → read `knownReflectionDigest()` (if the
batch's `newDigest` already landed, just re-ack — a re-submit reverts, never double-attest)
→ `bitcoin_prove` groth16 on Succinct → `attestBitcoinStateProven(pv, proof)` (RELAY_KEY) →
`POST /reflection/ack`. The worker advances the un-rewindable attested cursor only on ack, so
a failed prove/submit is a safe retry.

**Settle** — `GET /confidential/job` → `feeGate` (reject unprofitable) → `exec` harness groth16
on Succinct (per-job wall-clock timeout so a poison witness can't wedge the FIFO) →
`settle(pv, proof, memos)` (SETTLE_KEY; the proof-bound fee is paid to `msg.sender` = the relay)
→ `POST /confidential/ack`. A revert (e.g. a lost-ack re-serve of an already-applied op) is
acked failed so the queue advances.

---

## The prebuilt Rust prover binaries

The workers **spawn** two prebuilt binaries — they do **not** compile Rust at runtime:

- `bitcoin_prove` — `contracts/sp1/eth-reflection/prover-host`, built `--bin bitcoin_prove`,
  patched to `.network()`. Reads `REFLECT_FIXTURE` (the assembled reflection input),
  `PROOF_MODE=groth16`, writes `$PROVER_OUT/bitcoin_pv.hex` + `bitcoin_proof_bytes.hex`.
  This worker drives the **forward** (single-ELF, no eth recursion) incremental attest; the
  Mode-B reverse-bridge recursion stays on its dedicated path.
- `exec` — `contracts/sp1/confidential/harnesses`, built `--bin exec`, patched to `.network()`.
  `MODE=groth16`, `OP_TYPE`/`OP_FILE=<op json>`, writes `public_values.hex` + `proof_bytes.hex`
  in its cwd (`$PROVER_OUT`).

The SP1 guest **ELFs are `include_bytes!`'d into these binaries at build time**, so building
them pins the exact vkeys the deployed pool verifies against. **Build them once in CI** on a
machine with the SP1 toolchain + the guest ELFs staged (the box already builds them this way),
publish as a release artifact, and drop the artifacts under `worker-relay/prover/bin/` for the
Docker build to `COPY`. `Dockerfile` stage 1 shows the in-image build path if you prefer it;
the recommended path is the CI-artifact `COPY` (keeps Render builds fast). See the `TODO`s in
`Dockerfile`.

> The binaries read the standard SP1 network env: `SP1_PROVER=network`, `NETWORK_PRIVATE_KEY`,
> `NETWORK_RPC_URL`. The workers fail loud at startup if `SP1_PROVER=network` and
> `NETWORK_PRIVATE_KEY` is unset — there is **no silent local-GPU fallback**.

### Box-as-fallback

The GPU box (`ops/scripts/*-loop.sh` + `sp1-gpu-server`) still works unchanged and is the
fallback if the Succinct network is degraded or PROVE runs dry. To fall back: point
`BITCOIN_PROVE_BIN` / `EXEC_BIN` at box-built local-GPU binaries and unset `SP1_PROVER`
(prove locally). Run **only one** attester at a time against a given `network` — the on-chain
digest-chain makes a double-submit revert, but running both wastes gas/PROVE. The reflection
cursor has a single writer by design (runbook P3).

---

## Environment variables

Set the **secrets** (`sync:false`) in the Render dashboard; the rest are declared in
`render.yaml`'s shared env group.

### Required (all services)
| Var | What | Secret? |
|---|---|---|
| `WORKER_BASE` | Control-plane worker base URL (serves `/reflection/*`, `/confidential/*`, `/prover-health`) | no |
| `BOX_TOKEN` | Bearer token = worker `CONFIDENTIAL_BOX_TOKEN` / `DEBUG_TOKEN` (the box routes are token-gated) | **yes** |
| `RPC_URL` | Ethereum execution RPC for the relay's own tx | **yes** |
| `RELAY_KEY` | Funded signer — pays gas for attest + settle + replenish, collects fees | **yes** |
| `NETWORK_PRIVATE_KEY` | Funded Succinct network-prover key (spends PROVE) | **yes** |

### Addresses (defaulted to mainnet; override for Sepolia rehearsal)
`POOL_ADDR`, `VAPP_DEPOSIT_ADDR`, `PROVE_TOKEN_ADDR`, `ZQUOTER_ADDR`, `ZROUTER_ADDR`,
`CHAIN_ID`, `NETWORK` (`mainnet`|`signet`).

### Succinct / binaries
`SP1_PROVER=network`, `NETWORK_RPC_URL`, `BITCOIN_PROVE_BIN`, `EXEC_BIN`, `PROVER_OUT`,
`FIXTURE_DIR`.

### Fee economics (`PRICING-RELAY-ECONOMICS.md`)
`MIN_FLOOR_USD` (0.5), `OPS_MARGIN` (0.12), `BPS_CAP` (30), `PROVE_PRICE_USD`, `ETH_PRICE_USD`.

### Settle
`SETTLE_KEY` (secret; optional, falls back to `RELAY_KEY`), `SETTLE_POLL_SECS`,
`SETTLE_JOB_TIMEOUT_SECS`.

### Replenish
`FEE_ASSETS` (secret; comma list of confidential fee-asset ERC20s), `PROVE_SPLIT_BPS` (5000),
`SLIPPAGE_BPS` (100), `WETH_ADDR`.

### Monitor
`PROVE_BALANCE_FLOOR` (50), `ETH_GAS_BUFFER_WEI` (0.03 ETH), `REFLECTION_LAG_ALERT_BLOCKS` (6),
`ALERT_WEBHOOK_URL` (secret; optional Slack/Discord-compatible incoming webhook).

---

## Dynamic fee (the quote the dapp shows + the settle `feeGate`)

`quoteRelayFee({ op, tradeSizeUsd, liveGasGwei, provePriceUsd })` in `src/replenish.js`
implements the `PRICING-RELAY-ECONOMICS.md` model:

```
per_op_cost = live_gas_cost(op) + live_PROVE_cost(op)
fee         = max(MIN_FLOOR, per_op_cost * (1 + OPS_MARGIN))
displayed_bps = min(fee / trade_size, BPS_CAP)
```

Gas dominates (~100× PROVE), so the fee is really a **dynamic gas-abstraction fee**; measured
settle gas per op-type is baked into `OP_GAS` (wrap 593k, swap 569k, LP 749k, unwrap 323k).
`belowFloor` flags tiny trades where self-settle is the honest option.

---

## Deploy

```bash
# 1. Build the prover binaries in CI (SP1 toolchain + guest ELFs), publish artifacts.
# 2. Drop them under worker-relay/prover/bin/{bitcoin_prove,exec}.
# 3. Push; in Render: New > Blueprint > point at worker-relay/render.yaml.
# 4. Set the sync:false secrets in the dashboard.
```

Local smoke:
```bash
cd worker-relay && npm install
WORKER_BASE=… BOX_TOKEN=… RPC_URL=… RELAY_KEY=… NETWORK_PRIVATE_KEY=… node src/reflection-folder.js
```

---

## Open TODOs — status (verified against live contracts 2026-07-18)

- ✅ **zQuoter / zRouter ABI — RESOLVED.** Both verified on-chain. `chain.js` now uses the real
  `zQuoter.buildBestSwap(to, exactOut, tokenIn, tokenOut, amount, slippageBps, deadline)` →
  `(best, callData, amountLimit, msgValue)`, and `replenish.js` fires the returned `callData`
  straight at zRouter (`sendTransaction({to: zRouter, data: callData, value: msgValue})`). zRouter
  also exposes `swapV4(...)` (direct V4) + `execute(target,value,data)` + `multicall(bytes[])`.
- ✅ **Pool digest read — RESOLVED (was a latent bug).** `knownReflectionDigest` is an INTERNAL
  var (no getter — calls revert). `chain.js` now reads it by **storage slot 80** via
  `readReflectionDigest()`; `reflection-folder.js` uses it for idempotency.
- ✅ **`exec` op dispatch — RESOLVED.** It's **one binary per op-type** (`exec-wrap`, `exec-lp`,
  `exec-swap`, `exec-unwrap` — each built from its own `exec-<op>.rs` copied to `main.rs`), NOT a
  single `exec` dispatching via `OP_TYPE`. Ship all per-op binaries; `prover.js` picks by op.
- ⏳ **attested-height slot** — `lastRelayHeight` is also an internal var; pin its storage slot
  from the compiled layout for the lag monitor (or use the control-plane `/prover-health` lag field).
- ⏳ **vApp deposited-balance read** — the vApp (`0x5Ad5Bc4B`) is an **ERC1967 proxy**; the balance
  getter lives on the implementation. Read via the impl ABI, or rely on the prover's
  `ResourceExhausted` error (which reports `balance X for cost Y`) + the replenish top-up cadence.
- ⏳ **`op.feeUsd` / `op.tradeSizeUsd`** on the job payload for a hard `feeGate` (dapp-side; until
  wired the relay accepts unpriced jobs). Uses `quoteRelayFee()` in `replenish.js`.
- ⏳ **WETH→ETH unwrap leg** — zRouter has `unwrap(uint256)`; add it after the fee→WETH swap if the
  route lands in WETH rather than native ETH.
