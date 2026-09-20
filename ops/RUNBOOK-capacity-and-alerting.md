# RUNBOOK — capacity and alerting

What runs out over the life of gen5, what watches it, and what to do when something fires.

Measurements are from 2026-09-20 against live mainnet state. Re-derive them any time with:

```
node tools/capacity-report.mjs
```

It reads only public endpoints, so it needs no credentials and anyone can check our numbers.

---

## 1. What does NOT run out

Worth stating plainly, because it is the part people assume is a problem and it is not. Nothing on the
immutable surface gets more expensive as notes accumulate:

- **The note tree** is `TREE_LEVELS = 32` — 4,294,967,296 leaves, of which 54 are used. Inserts use
  `filledSubtrees[32]`, so an insert costs 32 hashes whether the tree holds fifty leaves or four billion.
  **Cost does not grow with fill.** At 100,000 notes/day the tree lasts 118 years.
- **Roots and nullifiers** are `mapping(bytes32 => bool)` — one fixed SSTORE each, O(1) lookup, never
  iterated. No operation walks accumulated state. Root history never expires, so old membership proofs
  never go stale.
- **The guest** reaches accumulated state only through witnessed proofs (`imt_membership`,
  `imt_non_membership`, `imt_insert_transition`), each O(depth 32). It is stateless per proof, and
  `MAX_OPS` / `MAX_ITEMS_PER_OP` (256 each) are per-batch caps, not lifetime ones. **Guest cycle cost
  tracks batch size, not ledger size.**
- **Value headroom** is u64: 184,467,440,737 units at 8 decimals per note and per reserve.

So there is no TVL ceiling and no note-count ceiling to manage on-chain.

## 2. What DOES run out: the reflection snapshot

The one cumulative resource. `noteLeaves` and `spentLinks` are append-only and never compacted.

| field | count | bytes/elem | lifetime |
|---|---|---|---|
| `noteLeaves` | 7,494 | 69 | **append-only** |
| `spentLinks` | 3,692 | 140 | **append-only** |
| `liveTriples` | 3,803 | 280 | freed on spend |
| `coords` | 3,805 | 221 | freed on spend |

Total 2.81 MiB. Permanent cost is **209 B per note-lifecycle**; the live-set fields add ~501 B while a
note is unspent.

The assembler has been measured peaking **+58–216 MB above the snapshot against a 1280 MB heap**, so the
snapshot wants to stay well under a fifth of that. **64 MiB is the trigger to schedule frontier
compaction** — roughly 138,000 more notes at today's mix. That is a planning horizon, not an incident.

**The fix is off-chain.** The guest verifies against roots it is handed, so compacting the host's
bookkeeping needs no redeploy, no re-prove and no vkey rotation.

## 3. What watches it

`worker-relay/src/balance-monitor.js`, a Render cron (every 5–10 min). Four checks:

| check | threshold (env) | level |
|---|---|---|
| settle runway | `SETTLE_RUNWAY_ALERT` (25 settles) | critical |
| ETH absolute floor | `ETH_GAS_BUFFER_WEI` (0.03) | critical if runway unavailable, else warning |
| undeposited PROVE | `PROVE_BALANCE_FLOOR` (50) | critical |
| reflection lag | `REFLECTION_LAG_ALERT_BLOCKS` (200) | warning |
| snapshot size | `SNAPSHOT_BYTES_WARN` (64 MiB) | warning |

Two things about how it reports:

- **A critical exits the process non-zero.** `ALERT_WEBHOOK_URL` is optional and has historically been
  unset, which turned every critical into a log line inside a cron run nobody reads. A failing exit code
  is the one channel that always exists — Render marks the run failed with no configuration at all. Set
  the webhook anyway; this is the floor beneath it, not a replacement.
- **A check that throws is an unknown, not a critical.** Transient RPC failures are logged and do not fail
  the run, because a monitor that pages on every blip stops being read.

### Runway, not a floor

A fixed wei floor says "low"; it does not say *when*. 0.03 ETH is weeks at 0.15 gwei and under a day at
30 gwei. The monitor prices a real settle (`OP_GAS.transfer`, 600k, measured) at the live gas price and
alerts on settles remaining, which is the number you can act on.

### What the PROVE check is not

It reads the relay wallet's **undeposited** PROVE — what `replenish` has bought but not yet deposited. It
is **not** the vApp prover balance, which is what proving actually spends.

That gap cannot be closed on-chain. Probed 2026-09-20 against `0x5Ad5Bc4B…951F`: `balances`, `balanceOf`,
`deposits`, `accountBalance` and `proverBalance` all revert, and the vApp ABI carries only
`deposit(uint256)`. The deposited balance lives off-chain in Succinct's rollup. Closing it properly means
the Succinct API with a key — a credential decision, not a code one. **Do not re-derive this.**

## 3a. Paying for itself

The relay is meant to be self-funding: charge a fee per op, sweep the fees to ETH and PROVE through
zQuoter/zRouter, deposit the PROVE to the Succinct vApp. That loop is fully built in `replenish.js`. On
2026-09-20 it had never produced anything, for four independent reasons — each invisible on its own:

1. **`tacit-replenish` was SUSPENDED.** The flywheel had never run. Operator action.
2. **`SETTLE_KEY` is split from `RELAY_KEY`.** The settle wallet is `msg.sender` on every settle, so it
   both earns the fee (`_payout`) and burns the gas. The monitor and replenish both looked only at
   `RELAY_KEY`. Measured that day: relay `0x68575B…` held 0.0109 ETH and looked fine, while settle
   `0xfd1fa372…` held 0.00098 — about ten settles — and nothing alerted. Both now iterate `fundedWallets`.
3. **The fee gate accepted any op without `op.feeUsd` for free**, which was every op. That is why every
   fee balance was flat zero. The gate now logs `UNPAID:` per job and counts them;
   `RELAY_REQUIRE_PRICED_FEE=1` refuses them outright. **Default off** — nothing populates `op.feeUsd`
   yet, so turning it on before the producer is wired would refuse every job.
4. **The maintenance lane was missing from the cost model.** Header attestation is 264,241 gas (measured,
   three consecutive receipts) at ~111 runs/day, and nobody pays a fee for it — but the bridge stops in
   both directions without it. It is now amortised across `EXPECTED_OPS_PER_DAY`.

All-in cost per op at ETH $1840 and 50 ops/day (settle gas + PROVE $0.074 + maintenance share):

| gas | settle | maintenance | **all-in** |
|---|---|---|---|
| 0.05 gwei | $0.055 | $0.054 | **$0.18** |
| 0.1 gwei | $0.110 | $0.108 | **$0.29** |
| 0.5 gwei | $0.552 | $0.539 | **$1.17** |
| 1 gwei | $1.104 | $1.078 | **$2.26** |

Mainnet has been sitting around 0.05–0.15 gwei, so the realistic operating point is the top of that table
and the $0.50 `MIN_FLOOR_USD` covers it with room. The floor only stops covering cost somewhere above
~0.2 gwei, at which point the dynamic quote takes over — which is the whole point of pricing off live gas
rather than a constant.

Two things follow. Maintenance is roughly **as expensive as the settles themselves** at any gas price,
because it is a fixed ~111 runs/day regardless of volume — so the single biggest lever on unit cost is
serving more ops per day, not shaving per-op gas. And batching helps on the settle half only: it splits one
settle's gas across its members while the maintenance overhead stays flat.

### The fee is derived, never declared

`op.feeUsd` was the obvious way to wire this, and it is the wrong one: `/confidential/submit` takes a
client-supplied op, so any field on it is attacker-controlled. A hostile integrator could have declared any
fee it liked and had the gate believe it — the bypass was unreachable only because nothing populated the
field, and wiring the producer is precisely what would have made it reachable.

So the worker derives the fee from the op's own legs (`totalFee`/`feeAssetOf` — the same witness fields the
guest enforces), stores it as `job.feeUsd`, and **strips any caller-supplied `op.feeUsd` before `jobIdOf`
hashes the op** (stripping it later would leave a caller able to vary an ignored field to mint a fresh job
id for the same op and walk past dedup). The relay reads `job.feeUsd` only.

Only cETH is priceable server-side today — `unitScale` is wei-per-unit, so units × scale × ETH/USD is exact
with no oracle beyond the Chainlink ETH price. Every other asset yields `feeUsd: null`, which the relay
logs as unpaid work rather than treating as permission to relay for free. Widening that means a per-asset
USD oracle, not a guess.

### What batching can and cannot do

Job batching is **already on** (`SETTLE_BATCH_MAX=8` on `tacit-settle`) and it is **transfers only** — not
a conservative default, a hard limit. The relay proves a claimed batch as `batchtransfer`, a
transfer-specific guest op; there is no heterogeneous batch type, so widening the claimed types would feed
non-transfers into a circuit that does not understand them. That coupling used to live implicitly in a
default argument on one side of an HTTP boundary and a hardcoded string on the other; it is now a named
`BATCHABLE_TYPES` in the worker and a re-check in the relay, which releases a mismatched batch back to the
single-op path rather than folding it.

Swaps have their own answer and it is a different mechanism: **intent** batching through `OP_SWAP`, which
amortises the *proof* (one Groth16 verify across up to 16 traders) rather than the gas. That coordinator is
mounted in the dapp (`ux.swapBatched`) but not the default path. See
[DESIGN-swap-batch-queue.md](DESIGN-swap-batch-queue.md).

### Metering no longer depends on the fee floor

`RELAY_FEE_FLOOR=1` used to skip per-IP metering entirely, on the theory that a fee floor makes flooding
self-limiting. But the gate only prices a cETH fee leg and passes every other asset through ungated, so
lifting the meter would have re-opened zero-fee floods for every non-cETH asset. **That coupling is why the
floor could never safely be switched on.**

The flag now only selects a bucket: fee-paying relayed submits get their own, more generous allowance
(`PAID_RL_BURST` / `PAID_RL_REFILL_MS`), everything else keeps the strict one, and the bucket name is part
of the rate-limit key so the two cannot collide. Metering is no longer something the floor can turn off.

**Order to switch on:** fund both wallets → deploy worker + worker-relay → resume `tacit-replenish` →
watch `UNPAID:` fall as cETH-fee ops start pricing → set `RELAY_FEE_FLOOR=1` (now safe) →
set `RELAY_REQUIRE_PRICED_FEE=1` last.

## 4. Responding

**Settle runway low** — fund the relay wallet. Read the current address from a recent pool settle rather
than from any note; it changes with the generation. The burn rate is worth re-reading at the same time,
since it moves with both gas and volume.

**Reflection lag high** — read the target from the **header relay's** `tipHeight()`, not from
mempool.space. The header relay lags live Bitcoin by ~110 blocks by design, and reflection sits
`reflectionConfirmations` (24) behind that. A lag of 31 against the relay tip is effectively caught up.

**Snapshot over threshold** — schedule frontier compaction. Nothing is broken; this is the signal to do
it deliberately rather than during a catch-up.

## 5. Deploying these

- `worker/src/index.js` → **`tacit-api` only autodeploys on changes inside `server/`**, so a worker change
  needs a manual deploy.
- `worker-relay/src/` → those Render services are `autoDeploy=no`. Nothing ships until you deploy it.

Until the worker is deployed, `checkSnapshotCapacity` finds no `capacity` field, logs that the worker
predates it, and returns — the other checks are unaffected.

## 6. Lifecycle

The immutable surface cannot be patched, so every fix is a new generation. That is the maintenance model
and it has been exercised across five generations: drain-first via `createNextGen`, resuming reflected
state by digest — gen4→gen5 landed with zero catch-up gap.

So the servicing question is not whether the protocol can be maintained at modest usage; it is whether
the off-chain lane keeps up, which is what section 3 watches.
