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

### Waiting for gas

The header feeder and the attest wait for a cheaper block, and both are bounded (`src/lib/gas-pace.js`; tests `tests/gas-pace.test.mjs`).
A header costs the same gas whenever it is sent, so waiting only helps if the price falls, and a wait that never ends is a bridge that
never lands.

| What | Rule | Knobs |
|---|---|---|
| Headers, the bar | Hold while the next block's base fee is over `HEADER_MAX_GAS_GWEI`, or over the last day's `HEADER_FOLLOW_PCT` (30th) percentile when that is higher, so gas that settles above the ceiling for good does not freeze the relay | `HEADER_MAX_GAS_GWEI`, `HEADER_FOLLOW_PCT` |
| Headers, the bound | The oldest pending header goes after `HEADER_MAX_WAIT_MIN` (8 h) whatever the bar says, unless gas is a spike (over `PACE_SPIKE_GWEI` and `PACE_SPIKE_MULT` x the last day's median); `HEADER_RELAY_MAX_STALE_BLOCKS` stays the last resort at any price | `HEADER_MAX_WAIT_MIN`, `PACE_SPIKE_GWEI`, `PACE_SPIKE_MULT`, `HEADER_RELAY_MAX_STALE_BLOCKS` |
| Headers, small batches | While gas is cheap (under `HEADER_CHEAP_GWEI`, or the last day's `HEADER_CHEAP_PCT` percentile if higher) the relay advances every `HEADER_CHEAP_MIN_BATCH` headers | `HEADER_CHEAP_GWEI`, `HEADER_CHEAP_PCT`, `HEADER_CHEAP_MIN_BATCH` |
| Attest | While gas is dear a few matured blocks wait for company: the attest goes at `REFLECT_MIN_BLOCKS` (6) matured blocks, or `REFLECT_MAX_WAIT_MIN` (60) after the first, or at once while gas is cheap. It costs the same gas and PROVE base fee whatever its block count | `REFLECT_MIN_BLOCKS`, `REFLECT_MAX_WAIT_MIN` |
| Funds | An attest needs 1.35x the base fee times its gas limit in the relay wallet (what the node checks), not twice the base fee; a header batch is sent with a 1.5x cap and raised to 2x if it is not taken | `HEADER_FEE_CAP_MULT` |

With no history (the node will not serve it) only the fixed numbers apply. A wait is logged once and again every ten minutes while it
stays the same, with the latest the stage will go, and the relay wallet's balance against the cost when it is the headers waiting.
Replayed on 21 days of real base fees: the same cost and lag as the fixed ceiling in a usual market; with every price six times higher,
about two hours behind on average instead of ten, and 20% cheaper.

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
`eth_prove`) from the GitHub releases the `Dockerfile` names (`PROVER_EXEC_RELEASE`, `PROVER_REFLECT_RELEASE`,
`PROVER_ETH_RELEASE`) and checks them against `prover/bin/SHA256SUMS`. They are patched to `.network()` and embed their guest
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

## Pool maker (`src/pool-maker.js`)

Buys TAC out of the Bitcoin shielded pool for sats, so a payment to a bitcoin address settles in the next block instead
of waiting for a buyer. Declared in `render.yaml` as `tacit-pool-maker`, with small starting limits; set `MAKER_KEY` in the
dashboard, then fund the coin address `/maker/status` names. It quotes only while that address holds coins.

The payer proves a pool spend (`btc-pool-zap.js` `exitToSats`) that exits TAC to the maker's key and wants `sats` paid to
a script they name, the recipient's among them. The want is part of the proved body and the pool's replay checks it, so
the maker cannot take the exit without paying; it checks the spend natively (terms, anchor, root, nullifiers, proof)
before any sats move, then posts one carrier from its own coins.

| Route | |
|---|---|
| `GET /maker/quote?sats=N` (or `?units=N`) | The TAC taken for N sats to the payee; reserves a coin to bind the carrier to. |
| `POST /maker/fill` `{ quoteId, payload, offer }` | Checks the spend and posts the carrier. |
| `GET /maker/status` | Whether it is quoting, the reference price, caps left, float, recent fills, inventory. |

Price: a trade of the asset within `MAKER_MARK_MAX_AGE_SECS`, or the cheapest live ask when that is lower, less
`MAKER_SPREAD_BPS`. With no recent trade it does not quote. Limits: sats per fill, sats and TAC per rolling day, fills
per client per day, one quote lifetime. The exit notes it buys pay `MAKER_KEY`'s own wallet key (inventory, listed or
sold like any holder's); the sats it pays come from coins on a key derived from `MAKER_KEY`, whose address
`/maker/status` names. Fund that address with coins larger than the biggest fill; a quote reserves one coin and the
rest must cover the payment and the fees.

Defaults and every variable are in the header of `src/pool-maker.js`. Tests: `node --test tests/pool-maker.test.mjs`.
Image: `docker build -f worker-relay/Dockerfile.pool-maker .` from the repo root.

Local run:

```bash
cd worker-relay && npm ci
WORKER_BASE=… BOX_TOKEN=… RPC_URL=… RELAY_KEY=… NETWORK_PRIVATE_KEY=… node src/reflection-folder.js
```
