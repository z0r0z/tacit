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
| gas runway (days of the wallet's real burn) | `RUNWAY_DAYS_CRITICAL` (3) / `RUNWAY_DAYS_WARN` (7) | critical / warning |
| ETH absolute floor | `ETH_GAS_BUFFER_WEI` (0.03) | critical if runway unavailable, else warning |
| undeposited PROVE | `PROVE_BALANCE_FLOOR` (50) | warning (a proxy that reads ~0 by design — see below) |
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

A fixed wei floor says "low"; it does not say *when*. The monitor computes **days of the wallet's actual burn**
at the live gas price: maintenance runs/day x measured maintenance gas if it carries the relay role, plus expected
ops/day x measured settle gas if it carries the settle role (`lib/runway.js`). Days, not "settles left": the
merged wallet pays for both jobs, and reporting settles alone said "635 settles" for a wallet that really had
~6 days (and under one at 10x gas).

### Which wallets it sees

There is one signing key now (see "One wallet" below), so the monitor watches one wallet carrying both roles.
`watchedWallets` in `lib/chain.js` still honours an optional `SETTLE_ADDRESS` (a public address, for watching a
wallet whose key this service does not hold) — it is unset today, and should stay unset unless a second key is
ever reintroduced. The monitor originally saw only one wallet because `SETTLE_KEY` lived on the settle service
alone and fell back to `RELAY_KEY` everywhere else; that is the reason the option exists.

A healthy run reads: one wallet with its runway in **days**, snapshot counts matching `tools/capacity-report.mjs`,
and `0 criticals`. The cron should be green — if it is red, that now means something.

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
   `RELAY_KEY`, so the wallet paying for settles was not watched at all. Both now iterate `fundedWallets`
   (and the monitor, which has no `SETTLE_KEY`, used `SETTLE_ADDRESS` — since retired, see §3). **Identify the settle
   wallet from the service's own logs (`replenish` prints `earner 0x…`), never from who sends pool settles:**
   prove-mode jobs are settled by the *user's* transaction, so other addresses appear as `msg.sender` too.
   (Initially misread from settle senders as `0xfd1fa372…`; the real earner is `0xB2DA…59Dd`.)
3. **The fee gate accepted any op without a priced fee for free**, which was every op. The gate now logs
   `UNPAID:` per job and counts them; `RELAY_REQUIRE_PRICED_FEE=1` refuses them outright. **Default off**:
   cETH, cUSD, cBTC and cTAC can be priced server-side, but not cUSDC/cUSDT (not registered in the deployment
   data) or any unregistered asset, and cTAC only when its reference is configured — so turning it on would
   refuse every relayed op in those.
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

### One wallet (merged 2026-09-20)

There is now a single signing key. The settle service used to hold its own `SETTLE_KEY`, which put fee income
on a wallet that could not fund proving; that key was retired and the service signs with `RELAY_KEY`
(`0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7`) — the maintenance wallet, the vApp depositor, and the account
behind the network prover key. **This is the direction that works:** moving the relay key instead would orphan
the vApp prover balance, so the settle key went, not the relay key.

It was done without stranding anything, from inside the service that held the old key (so the key value was
never read or copied): `drainToSink` (`REPLENISH_DRAIN_TO_SINK=1`) moved every fee asset and then the ETH to
`0x68…`, leaving only a gas reserve; the old wallet was confirmed empty on-chain before `SETTLE_KEY` was
deleted. Moved: 0.01297 ETH + 0.81 USDT. The monitor's `SETTLE_ADDRESS` was removed with it — there is one
wallet to watch, carrying both roles.

The earner -> sink description below still describes how `replenishOnce` works; with one wallet the earner *is*
the sink and every "to the sink" step collapses into the ordinary single-wallet case. If a second key is ever
introduced again, that logic is what keeps fees flowing to the account that can use them.

**What one key costs — and it is not hypothetical.** The settle service, header, reflection and eth-state all sign
from `0x68…`, so nonces can collide. Within hours of the merge it happened: a relayed wrap was signed at nonce
2715, and another sender's transaction took 2715 first, so nothing the relay broadcast under it could ever land.
The relay waited out two full receipt timeouts (re-broadcasting at the same, dead nonce) before noticing — 6.5
minutes for a settle that then landed in 13 seconds.

The sender was not a service. **`0x68…` is also the raw `WALLET_PRIV` EOA that test sessions use**, so anything
run with that key in its environment signs as the production relayer. Two mitigations, one code and one process:

- *Code:* `awaitInclusion` polls both "did one of ours land" and "has this nonce been consumed", so a dead
  nonce is noticed within seconds and the settle is re-sent at a fresh one (receipts are re-checked before
  declaring the nonce taken, so our own transaction with a lagging receipt is never re-sent).
- *Process:* tests should sign from a derived signer, never from `0x68…`. Anything held there (test dust, rETH)
  should be moved out in one batched transaction at a quiet moment. Longer term, a relayer key that is not also a
  development key removes the class of problem — but the prover balance is tied to this address
  (`NETWORK_PRIVATE_KEY`), so that is a migration, not a config change.

It still replaces the alternative of splitting fees away from the account that pays for proving, which was the
worse trade.

### Where fee income goes: earner -> sink

Two wallets, two jobs, and the money has to move between them:

- **Earner = the settle wallet.** It is `msg.sender` on every settle, so the pool's `_payout` credits the fee
  there, and it burns the settle gas.
- **Sink = the relay wallet (`0x68…`, `RELAY_KEY`).** It pays the maintenance lane (header attestation,
  reflection) and earns nothing — **and it is the account whose vApp deposit funds proving**, because a
  deposit credits whoever sends it. PROVE that lands on the settle wallet cannot pay for a proof.

So `replenishOnce` delivers straight to the sink (swaps take a recipient, so no second hop): exact-out ETH for
the earner, exact-out ETH for the sink, PROVE to the sink, native-ETH surplus forwarded to the sink; then the
**sink deposits once**, after every earner has delivered. Gas legs clear before PROVE, because a wallet that
cannot pay for a transaction cannot buy PROVE either. With consolidated keys the earner *is* the sink and
every sink step collapses into the ordinary single-wallet case — no change needed for that migration.

**It runs inside `tacit-settle`, not as a cron**, in the loop's idle time (`REPLENISH_IN_SETTLE=1`). Running only
where the loop would otherwise sleep serialises it with settles on the same nonce. A failure is logged and never
stops settling. The `tacit-replenish` cron is **retired**: still defined in the blueprint but inert (its command
is a no-op and it is suspended), because a resumed cron would be a second replenisher racing the settle service
for the same wallet's nonces.

The sink's approve + deposit share the relayer key with header/reflection/eth-state, so a collision is possible;
they retry a lost nonce race (it fails before broadcast, so retrying is safe).

Verified by running the real `replenishOnce` against a stub RPC and asserting on the signed transactions
(`tests/replenish-flow.test.mjs`) — who signed, where each swap was delivered, who deposited — not by matching
source text. Enabling it needs `REPLENISH_IN_SETTLE=1`, `FEE_ASSETS`, and a deploy of `tacit-settle`.

### What the gates refuse (and what they deliberately do not)

Two gates, one rule each:

- **Worker, at submit:** a priced fee (cETH, cUSD, cBTC, cTAC) must clear the published gas-aware floor. Refusal is
  immediate and says so, before anything is queued.
- **Relay, at claim:** a priced fee must cover the op's **marginal cost** — gas + PROVE. An op that loses money on
  its own is refused; one that merely under-contributes to fixed overhead is not. Maintenance stays in the
  *quoted* price (`costUsd`) but is not a per-op admission test. `RELAY_GATE_INCLUDE_MAINTENANCE=1` restores the
  strict rule. (Counting maintenance per op refused the dapp's standard ~$0.257 cETH fee from ~0.06 gwei up —
  after the job had queued. Found 2026-09-20; only test traffic was hit, 3 relayed jobs in 3.5h.)

**No fee is unpriced, never $0.** Ops fee-less by design (wrap, cbtcmint, bridgemint, adaptor/stealth locks,
cdptopup) are relayed as a deliberate subsidy. The pricer used to report them as $0, which the relay then
compared against cost and refused. They now arrive unpriced and are accepted as logged `UNPAID` work, bounded by
`FREE_RELAY_DAILY_CAP` (default 300/day, spent only on an accepted non-deduped job, so junk cannot drain it).
A relayed op that *carries* a fee leg but pays too little is still refused — that is a different case.

### Guards on every swap

Fee income is small and the aggregator is not always right, so replenish refuses to act on what it cannot
trust. **Found in production on the first pass:** the earner held 0.81 USDT and the router quoted 417 PROVE
for it (~$0.002 each) — while quoting 416 PROVE for 100 USDT (~$0.24). One of those is wrong by ~100x. The swap
reverted at simulation so nothing was lost, but the code should not depend on that.

- **Dust floor** (`SWEEP_MIN_USD`, default $5): a fee asset below it is held and accumulates. Tiny swaps cost
  gas out of proportion and are exactly where the quotes go bad. The log says `holding to accumulate`.
- **Quote sanity** (`QUOTE_SANITY_BAND`, default 2x): every PROVE quote, and every stablecoin gas top-up, is
  checked against an independent price and refused with `REFUSING … implausible` when outside the band. The
  band is wide on purpose — it catches a 100x error, not ordinary slippage.
- **Operator float** (`ETH_SWEEP_ABOVE_WEI`, default 0.1 ETH): native ETH is only converted to PROVE above
  this, so a deliberate gas top-up is never swept into PROVE.
- **Nonce races** on the sink's approve/deposit are retried; they fail before broadcast so retrying is safe.

### Proving is not free for the user — and prove-mode is unpaid

**Bounded, as of this change:** a global daily ceiling (`PROVE_MODE_DAILY_CAP`, default 400) is spent only
when a job is actually accepted — never on a submit that fails validation, so junk cannot drain everyone's
allowance — and refusal points at proving locally, the free path where the witness never reaches us. So the
worst case is a number we chose. Original finding:

Live logs show real users already using the relay in `mode=prove` (wraptransfer, bridgeburn, lpremove), each
proved on our PROVE (~$0.07) with **no fee at all**: prove-only jobs skip the fee gate, and the fee could not be
collected anyway — the user sends the settle tx themselves, so a bound fee is paid to the user. It is bounded
by per-IP metering (5 burst, 1 per 40s), so this is a small, capped subsidy, but it is real and it is the
largest unpaid path. Charging for it means a fee outside the settle tx (or accepting it as the cost of
self-settle). A decision, not a bug.

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

**State today (2026-09-21):** `RELAY_FEE_FLOOR=1` is set and live; replenish runs inside `tacit-settle`
(`REPLENISH_IN_SETTLE=1`); `tacit-replenish` is retired — **do not resume it**. `RELAY_REQUIRE_PRICED_FEE` is
still off, and should only be turned on once every asset a user can pay in is priceable, since it refuses the
rest outright. The order that got here, for a fresh deployment: fund the relayer wallet → deploy worker +
worker-relay → set `REPLENISH_IN_SETTLE` + `FEE_ASSETS` on the settle service → watch `UNPAID:` fall as ops start
pricing → set `RELAY_FEE_FLOOR=1` → `RELAY_REQUIRE_PRICED_FEE=1` last.

### Is anyone waiting on a relay that has stopped?

An empty queue says nothing — the relay may just be idle. The signature of a dead or hung `tacit-settle` is a
queue whose **oldest pending job keeps aging**. `GET /confidential/queue` (box-token gated; counts and ages only,
never job contents) reports `{ pending, proving, oldestPendingSec, oldestProvingSec }`, and the monitor turns it
into an alert (`lib/queue-health.js`): a warning when the oldest pending job is `QUEUE_PENDING_WARN_SEC` (300s)
old, critical at `QUEUE_PENDING_CRITICAL_SEC` (900s), and a warning for a job "proving" past the prove timeout.
A relayed job is normally picked up in seconds, so any of these means a user is waiting.

Transfer batches go through the same fee gate as single jobs: each member is checked individually and an
underpaying one is refused on its own without sinking the rest. (They used to skip it.)

### Alerting without a webhook

`ALERT_WEBHOOK_URL` is deliberately left unset. Render already has **email enabled for failures** at the
account level (`emailEnabled: true`, `notificationsToSend: "failure"`) and the monitor inherits it, so a
critical — which exits non-zero — fails the run and Render emails the owner with no configuration. Set a
webhook only if you want a second channel (Slack/Discord); it needs a URL from you. (Settings verified via the
API; delivery of an actual failure email has not been exercised.)

## 3b. Running the maintenance lane lean (available, not active)

The maintenance lane is the header feeder plus the reflection attests. Nobody pays a fee for it, and the bridge stops
without it, so it is the fixed daily cost of keeping the Bitcoin side current. Measured on-chain from the relay
wallet over 24 hours ending 2026-09-22 (gas averaged about 0.35 gwei that day, well above the 0.05 to 0.15 the
earlier tables assumed):

| lane | txs/day | avg gas | ETH/day |
|---|---|---|---|
| header feeder (`advanceTip`) | 136 | 286k | 0.0135 |
| reflection attests | 54 | 409k | 0.0065 |
| user settles (relayed, fee-earning) | 24 | 583k | 0.0060 |

The header feeder sends about one header per transaction, at roughly 250k gas each. Multi-header transactions in the
same sample cost about 106k to 124k gas per header, so batching roughly halves that lane. The attests fire about every
27 minutes; each is dominated by a fixed proof-verification cost, so going from about 54 a day to 4 to 6 cuts that
lane's gas by close to 90%, provided per-attest gas stays near today's.
What cannot be cut is one header per Bitcoin block: about 144 a day at the batched rate.

Two knobs, both off by default (the feeder behaves exactly as before until they are set):

| env (tacit-header) | default | lean value | effect |
|---|---|---|---|
| `HEADER_RELAY_MIN_BATCH` | 1 | 24 | wait for this many pending headers, then send them in one transaction (about every 4 hours) |
| `HEADER_RELAY_MAX_STALE_BLOCKS` | 0 (off) | 48 | at this many pending headers, send even while `MAX_GAS_GWEI` would hold it, and even below the minimum batch |
| `MAX_GAS_GWEI` | 0 (off) | 0.2 | otherwise wait for cheap gas; the bound above stops this from leaving the relay far behind |

`tacit-header` can keep its `*/3` schedule: a run that finds fewer than the minimum pending headers sends nothing, so
the cadence comes from the batch size, not the cron. Fork recovery is unaffected: restoring the canonical chain skips
the batching wait. Keep the bound small. The pool measures its confirmation depth from the relay's tip, so the relay
should stay close to the real tip; 48 blocks is the largest bound worth running with, and it should shrink as the
value held through the bridge grows.

On the reflection side (owned with the reflection files, not changed here): raise `REFLECTION_BATCH_SIZE` on tacit-api
to about 36 and run `tacit-reflection` every few hours instead of every 5 minutes, keeping batches well under the
sizes that have needed extra memory. Set `REFLECTION_STALL_HOURS` on the monitor above the new cadence (for a 4-hour
schedule, 9), or the stall check will page on a healthy lane. `REFLECTION_LAG_ALERT_BLOCKS` (200) already sits above the
lag this produces.

Expected effect at the measured gas: header lane 0.0135 to about 0.003 to 0.007 ETH/day, attests 0.0065 to about
0.0006, so maintenance falls from roughly 0.020 to 0.004 to 0.008 ETH/day; at 0.1 gwei, divide by about 3.5. PROVE
spend is separate and is read from the Succinct account; proving cost follows the number of blocks folded, so it
falls by less than the gas does.

Switch on in this order, and only when no bridge burn is waiting on the fold, because the fold needs the relay to
follow the tip: set the two header knobs (one env write, then redeploy `tacit-header`); watch `batching:` lines for a
day; then change the reflection schedule and monitor threshold together. To revert, unset the knobs.

**Live since 2026-09-22**, tuned to where each knob's marginal gas saving stops being worth its added latency
(cBTC locks feed live farming, so turnaround matters): `tacit-header` runs `HEADER_RELAY_MIN_BATCH=6`,
`HEADER_RELAY_MAX_STALE_BLOCKS=12`, `MAX_GAS_GWEI=0.2` (per-header gas mostly plateaus by a batch of ~6, so a
larger minimum buys little beyond this); `tacit-api` runs `REFLECTION_BATCH_SIZE=12`; `tacit-reflection`'s
schedule is `17 * * * *` (hourly — a 55% cut in attest count versus the original 5-minute cadence, without the
multi-hour tail an even leaner schedule would add); `tacit-monitor`'s `REFLECTION_STALL_HOURS` is 3. Net effect on
a cBTC lock's own turnaround: still bound mostly by the unavoidable 24-confirmation maturity floor
(~4h), with roughly 30 minutes to 2 hours of cadence tax on top, versus a couple of minutes under the
original always-submit settings. (A more aggressive setting — batch 24 / stale 48 / every 4h — was live briefly
the same day and added several more hours of tail latency for not much extra gas savings; reverted in favor of
the above once cBTC locks were confirmed to be a real user-facing path, not just occasional ops bridging.)
Revert any of these by unsetting the var or restoring the old schedule (`*/5 * * * *`).

Both entrypoints a locker can use to skip the wait entirely are already permissionless: `advanceTip` on the header
relay and `attestBitcoinStateProven` on the pool take a call from any address, so a locker who wants their specific
lock to mature faster than the shared background cadence can push the header relay's tip and submit their own
attest, paying only the marginal gas — without the shared infrastructure needing to detect or predict demand. No
packaged tool for this exists yet; it would read the same way `tools/crossout-rehearsal-preflight.mjs` and
`ops/RUNBOOK-crossout-rehearsal.md` do for a cross-out.

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
