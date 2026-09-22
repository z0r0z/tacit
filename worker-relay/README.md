# Tacit relay and reflection services (Render)

The operational services behind the confidential pool: the settle relayer, the Bitcoin
reflection attester, the header relay feeder, the Mode-B eth-state producer and the monitor.
They run on Render and prove on the **Succinct network prover**, so no GPU is needed.

## Trust role

None of these services can change what is valid. Every settle and every reflection attest
carries an SP1 proof that the pool verifies against its immutable vkeys, and `settle` is
permissionless. The relayer never holds user funds or spending keys; the relay fee is bound
in the proof and paid to `msg.sender`. The relayer can decline a job, but it cannot redirect
or change one. Users can always self-settle or prove locally instead (SPEC §5.4).

The control plane is the API worker (`worker/`, run as `tacit-api` via `server/`). It queues
opaque witnesses and serves reflection jobs; it never proves and never holds funds.

## What runs

Declared in `render.yaml`:

| Service | Render type | File | Role |
|---|---|---|---|
| `tacit-reflection` | Cron (`*/5`) | `src/reflection-folder.js` | Incremental Bitcoin-state attest: fetch the next batch, prove it, `attestBitcoinStateProven`, ack. |
| `tacit-header` | Cron (`*/3`) | `src/header-relay.js` | Feeds Bitcoin headers to `BitcoinLightRelay.advanceTip`, paced to stay about `HEADER_RELAY_LEAD` blocks ahead of reflection. No proving. |
| `tacit-eth-state` | Background Worker + disk | `src/eth-state-sidecar.js` | Runs `eth_prove` and publishes the Ethereum-side candidate every Mode-B attest needs. See the file header for why the trigger is "is a candidate live", not "did `crossOutCount` change". |
| `tacit-settle` | Background Worker | `src/settle-relay.js` | Settle relayer for user ops: `feeGate`, prove, `settle(pv, proof, memos)`, ack; batches queued transfers; activates relayed L2 exits; runs replenish in idle time. |
| `tacit-monitor` | Cron (`*/5`) | `src/balance-monitor.js` | Alerts on gas runway, undeposited PROVE, reflection lag and stalls, snapshot size, queue age and farm health. A critical exits non-zero. |

`tacit-replenish` is defined but inert: replenish (sweep fee assets to ETH gas and PROVE via
zQuoter/zRouter, deposit PROVE to the Succinct vApp) runs inside `tacit-settle`
(`REPLENISH_IN_SETTLE=1`) so it shares the relayer key's nonce with settles.

Shared libraries live in `src/lib/`: `config.js` (env and addresses), `chain.js` (viem clients
and ABIs), `prover.js` (spawns the prover binaries), `worker-client.js` (API routes).

### Loop shape

**Reflection**: `GET /reflection/job` → compare the batch's `priorDigest` and `newDigest` with the
pool (re-ack if it already landed, stop if the pool is on a different prior) → `bitcoin_prove`
groth16 on Succinct → `attestBitcoinStateProven` → wait for confirmations and cross-check the
digest on an independent RPC → `POST /reflection/ack`. The API advances its cursor only on ack,
so a failed prove or submit is a safe retry.

**Settle**: `GET /confidential/job` → `feeGate` → skip inputs already spent on chain → prove with
the per-op `exec-<type>` binary (per-job wall-clock timeout) → check the memos match the proof's
memo root → `settle` over the private submission endpoints → `POST /confidential/ack`.

## Prover binaries

The image fetches the prebuilt binaries (`exec-<op>` for each confidential op, `bitcoin_prove`,
`eth_prove`) from the GitHub release named by `PROVER_RELEASE` in the `Dockerfile` and checks
them against `prover/bin/SHA256SUMS`. They are patched to `.network()` and embed their guest
ELFs, so each proves exactly one program. Set `EXPECT_VKEY` so a binary built against a
different guest fails at startup rather than producing proofs the pool rejects. Rotating a guest
means bumping `SHA256SUMS`, the release tag and the on-chain vkey together.

The binaries read the standard SP1 network env (`SP1_PROVER=network`, `NETWORK_PRIVATE_KEY`,
`NETWORK_RPC_URL`). The services refuse to start if `SP1_PROVER=network` and
`NETWORK_PRIVATE_KEY` is unset. To prove locally instead, point `BITCOIN_PROVE_BIN` / `EXEC_BIN`
at locally built binaries and unset `SP1_PROVER`. Run only one attester per network.

## Environment

Secrets are `sync: false` in `render.yaml` and set in the Render dashboard; everything else is in
the `tacit-relay-shared` env group or on the service. `src/lib/config.js` is the full list with
defaults.

| Var | What | Secret |
|---|---|---|
| `WORKER_BASE` | API base URL (`/reflection/*`, `/confidential/*`, `/prover-health`) | no |
| `BOX_TOKEN` | Bearer token for the token-gated prover routes | yes |
| `PROVER_HEARTBEAT_TOKEN` | Must equal the API's value, or `/prover-health` shows the services down | yes |
| `RPC_URL` | Ethereum RPC for reads and maintenance transactions | yes |
| `RELAY_KEY` | Relayer key: pays gas, receives relay fees, funds the Succinct deposit | yes |
| `NETWORK_PRIVATE_KEY` | Succinct network prover key | yes |
| `ALERT_WEBHOOK_URL` | Optional incoming webhook for the monitor | yes |

Addresses default to mainnet (`POOL_ADDR`, `ROUTER_ADDR`, `HEADER_RELAY_ADDR`,
`VAPP_DEPOSIT_ADDR`, `PROVE_TOKEN_ADDR`, `ZQUOTER_ADDR`, `ZROUTER_ADDR`); set `POOL_ADDR`
explicitly so every service points at the same deployment. The `tacit-eth-state` block pins
per-deployment constants (`SOURCE_*_RPC`, `ETH_CALL_OUTBOX`, `DEPLOY_BLOCK`, `GENESIS_SLOT`);
re-pin them for a successor deployment and start with `DRY_RUN=1` for one cycle.

## Relay fee

`quoteRelayFee` in `src/replenish.js` is the fee the dapp shows and `feeGate` enforces:

```
per_op_cost   = live_gas_cost(op) + PROVE_cost(op)
fee           = max(MIN_FLOOR_USD, per_op_cost * (1 + OPS_MARGIN))
displayed_bps = min(fee / trade_size, BPS_CAP)
```

Gas dominates, so this is mostly a gas-abstraction fee. Measured settle gas per op type is in
`OP_GAS` (`src/lib/config.js`). By default the gate holds a fee to the op's marginal cost;
`RELAY_REQUIRE_PRICED_FEE=1` refuses ops that carry no priced fee. The fee is paid to the relayer
as the underlying asset by the pool's `_payout`, so replenish swaps it directly; native ETH is
kept as gas up to `ETH_SWEEP_ABOVE_WEI`.

## Deploy

1. In Render: New → Blueprint → `worker-relay/render.yaml`.
2. Set the `sync: false` secrets in the dashboard.
3. Fund the relayer key with ETH for gas and PROVE for the Succinct deposit.

Services have `autoDeploy: false`; deploy from the dashboard.

Local run:

```bash
cd worker-relay && npm install
WORKER_BASE=… BOX_TOKEN=… RPC_URL=… RELAY_KEY=… NETWORK_PRIVATE_KEY=… node src/reflection-folder.js
```
