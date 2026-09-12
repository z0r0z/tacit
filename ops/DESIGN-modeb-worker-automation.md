# DESIGN — Mode-B worker automation (eth_prove sidecar)

> Since gen4's `crossOutCount >= 1` on mainnet, every future Bitcoin-side reflection
> attestation must be Mode-B (fold a recursive SP1 proof of Ethereum's crossOut/consumed
> state into the Bitcoin reflection guest). Today this is a fully manual, by-hand process
> run over SSH against a RunPod GPU box — see `scratchpad/MODEB-RECIPE.md` for the
> verified-working recipe this design automates. This doc proposes a concrete "eth_prove
> sidecar" so the production `tacit-reflection` Render cron can keep attesting without a
> human running the recipe every cycle.
>
> Companion reading: `ops/DESIGN-mode-b-recursion.md` (in-guest recursion mechanics),
> `ops/DESIGN-reflection-liveness-batch.md` (F-10/F-11/F-13 freshness-gate design — the
> ==NOW consume gate and the crossout `<=` relaxation this sidecar's cadence has to live
> with).

## 0. Two deployment surfaces — do not conflate them

The production reflection pipeline spans two separately-deployed services, and the
env-var plan in this doc routes each var to the right one:

- **Cloudflare Worker** (`worker/`, deployed via `wrangler`, config = `worker/wrangler.toml`
  `[vars]` **plus dashboard-only vars/secrets that are not in the repo at all** —
  confirmed by grep: `REFLECTION_ATTEST`, `REFLECTION_GENESIS_HEIGHT`,
  `REFLECTION_CHAIN_BINDING`, `CONFIDENTIAL_BOX_TOKEN`/`DEBUG_TOKEN` appear nowhere in
  `wrangler.toml`, only as dashboard-managed vars/secrets, same as `ALLOWED_ORIGINS`
  etc. are for the ones that *are* committed). This process owns `REGISTRY_KV`, serves
  `/reflection/job` + `/reflection/ack` (`worker/src/index.js:736,897`), and is where
  `buildScanReflectionAttester` (`worker/src/reflection-attest.js:214`) actually runs.
- **Render relay** (`worker-relay/`, `worker-relay/render.yaml`) — Node cron/worker
  processes (`tacit-reflection`, `tacit-header`, `tacit-settle`, `tacit-replenish`,
  `tacit-monitor`) that poll the Cloudflare Worker over HTTP
  (`worker-relay/src/lib/worker-client.js`) and shell out to **prebuilt Rust prover
  binaries baked into the Docker image from a GitHub release**
  (`worker-relay/Dockerfile:43-49`: `curl` of `z0r0z/tacit` release `prover-bins-v7`,
  checked against a committed `SHA256SUMS`). This process has no knowledge of Mode-B,
  eth beacon state, or `eth_prove` at all today.

So: `SOURCE_CONSENSUS_RPC` / `SOURCE_EXECUTION_RPC` / `SOURCE_PROOF_RPC` /
`ETH_CALL_OUTBOX` / `DEPLOY_BLOCK` / `GENESIS_SLOT` / `NETWORK_PRIVATE_KEY` are
`eth_prove`'s own env — they belong on whatever **new** Render service runs the sidecar,
not on `tacit-reflection`. `REFLECTION_CHAIN_BINDING` is consumed inside the Cloudflare
Worker (`reflection-attest.js:386`) — it needs to be added as a **Cloudflare dashboard
var**, not a `render.yaml` entry. Getting this wrong is exactly how the current gap
happened (the recipe's own "Known remaining gap" section conflates them).

## 1. Current manual process (as-is), grounded in the actual files

1. **`eth_prove`** (`contracts/sp1/eth-reflection/prover-host/src/bin/eth_prove.rs`) runs
   by hand on the RunPod box with the full env block documented in
   `scratchpad/MODEB-RECIPE.md` §1. It resumes cumulative crossout/consumed state from
   `/root/work/prover-host/out/eth_set_state.json` (`eth_prove.rs:44,308-317`), does
   `eth_getLogs`/`eth_getProof` against the finalized execution block
   (`eth_prove.rs:396-562`), produces a **compressed** SP1 proof
   (`eth_prove.rs:637-666`), and writes three artifacts:
   `out/eth_compressed.bin`, `out/eth_pv.hex`, and **`out/eth_set.json`** — the
   `{ ethPv, crossouts:[{claimId,destCommitment,asset}], consumeds:[{nu,consumedVal,spendRoot}] }`
   bundle the JS side consumes (`eth_prove.rs:210-234,700-724`). It also writes
   `out/eth_set_state.pending.json` (`eth_prove.rs:45,699`) — the CANDIDATE cumulative
   state, deliberately not yet committed.
2. **Assemble the Bitcoin-side Mode-B batch**: `scratchpad/gen4-modeb-assemble.mjs`
   copies `eth_set.json` locally, builds `ethBundleSource` as a closure that just returns
   the static bundle (line 29), and calls the REAL production
   `buildScanReflectionAttester` (`worker/src/reflection-attest.js:214`) with a
   file-based KV shim standing in for `REGISTRY_KV`, and **critically** sets
   `env.REFLECTION_CHAIN_BINDING` (recipe §2) — omitting it produces a fixture that
   passes the guest but reverts on-chain with `ChainMismatch()`.
3. **`bitcoin_prove`** on the box, with the ELF-hygiene discipline in recipe §3 (a
   `cargo prove build` after any `reflect.rs` debug edit silently re-embeds a
   non-canonical ELF whose vkey diverges from the deployed `BITCOIN_RELAY_VKEY` — this
   is the same failure class the sidecar must never risk automating carelessly).
4. **Submit** `attestBitcoinStateProven(bytes,bytes)` by hand via `cast`.
5. **After it lands**: commit `eth_set_state.pending.json → eth_set_state.json` on the
   box (recipe explicitly warns: only after confirmation, else "cycle-2-without-cycle-1
   desync"), then hand-POST `/reflection/seed` so the worker's own Bitcoin-side cursor
   isn't stale relative to what just landed on-chain.

## 2. The concrete gap in the JS wiring

`worker/src/index.js:719-727`:

```js
function scanReflectionAttesterFor(env, network) {
  return buildScanReflectionAttester(env, {
    deps: { secp, keccak256: keccak_256, sha256 },
    api: apiText,
    apiRawBytes,
    network,
    classifyTx: ({ rawHex }) => classifyConfidentialTx(rawHex),
  });
}
```

No `ethBundleSource` is passed. This is the ONE function both `handleReflectionJob`
(`:736`, called by every `GET /reflection/job` the Render `tacit-reflection` cron issues
via `worker-relay/src/reflection-folder.js` → `worker-relay/src/lib/worker-client.js:25`)
and `handleReflectionAck` (`:897`) use to build the attester. Per
`reflection-attest.js:154`: `ethBundleSource ? await ethBundleSource(...) : null` — with
it absent, `assembleJob()` always builds a `mode_b=0` forward batch, which (per the
crossOutCount≥1 invariant this doc starts from) cannot land on gen4 anymore. This is why
every batch since gen4 went live has needed the full by-hand recipe instead of the
5-minute cron just working.

## 3. Proposed architecture

### 3.1 New KV state (Cloudflare `REGISTRY_KV`, owned by `worker/src/index.js`)

Two keys per network, mirroring the existing `reflection:scan:{net}` /
`reflection:tip:{net}` split (`reflection-attest.js:222-231`) — separate the
cheap-to-write cursor from the expensive-to-rebuild state:

- `reflection:ethstate:confirmed:{network}` — the last cumulative eth-side state that a
  **landed** Mode-B batch was built from: `{ ethPv, crossouts, consumeds, lastBlock,
  execBlock, finalizedSlot, contentHash }`. `contentHash` = e.g. `keccak256(ethPv)`, used
  to correlate a pending candidate with the ack that confirms it.
- `reflection:ethstate:pending:{network}` — the sidecar's latest unconfirmed candidate,
  same shape. At most one live pending per network — see the serialization rule below.

Reusing a `confirmed` bundle across several Bitcoin batches is intentionally safe and
expected: `DESIGN-mode-b-recursion.md` §3 already establishes that re-folding the same
`crossOutSetRoot` is idempotent, so the sidecar does not need to keep pace with the
5-minute Bitcoin cron — it only needs to refresh often enough that the eth-side freshness
gate (the `bitcoinConsumedCount`/`crossOutCount` slot proofs `eth_prove.rs` always
re-proves, `:507-508`) doesn't go stale relative to what a Bitcoin batch needs. See §6 for
why the exact required cadence is still an open question.

### 3.2 New Cloudflare Worker endpoints (box-token gated, same pattern as `/reflection/job`)

- **`GET /reflection/eth-state?network=`** — sidecar reads `confirmed` (what to build the
  next increment's `prior_set_root`/`prior_count`/`prior_consumed_root`/
  `prior_consumed_count` on top of, mirroring `eth_prove.rs:469-484`) plus whether a
  `pending` already exists.
- **`POST /reflection/eth-state`** — sidecar publishes a new pending candidate. The
  handler REFUSES (409) to overwrite an existing, not-yet-confirmed `pending` unless it
  has aged past a ceiling (e.g. `ETH_STATE_PENDING_STALE_SECS`, default a few hours) —
  this serializes the sidecar against itself so two unconfirmed candidates can never
  race for the same `prior_count`.
- **`scanReflectionAttesterFor` gains `ethBundleSource`**:
  ```js
  ethBundleSource: async ({ from, to, blocks }) => {
    const raw = await env.REGISTRY_KV.get(`reflection:ethstate:pending:${network}`);
    if (!raw) return null;
    const st = JSON.parse(raw);
    return { ethBundle: { ethPv: st.ethPv, crossouts: st.crossouts, consumeds: st.consumeds }, consumedSources: st.consumedSources || [] };
  }
  ```
  Note it reads **pending**, not confirmed: feeding the pending candidate into a Bitcoin
  batch is precisely the act that, once the batch lands, makes it worth confirming (see
  §3.4). Reading confirmed here would mean the sidecar's freshest work is never used.
- **New fail-loud guard in `handleReflectionJob`**: today, `att.assembleJob()` with no
  `ethBundleSource` silently builds a doomed `mode_b=0` batch. Once `ethBundleSource` is
  wired, the equivalent failure mode is "no pending eth-state exists yet" (e.g. sidecar
  not deployed yet, or just fell behind) returning `null` from the callback — which
  currently degrades to `mode_b=0` (`reflection-attest.js:154`, `modeB && modeB.ethBundle`
  short-circuits to `undefined`). Add an explicit check mirroring the existing
  "unmirrored guest-folded envelope" refuse-gate style (`reflection-attest.js:166-169`):
  when the pool's on-chain `crossOutCount` (or a cheap `REFLECTION_MODEB_REQUIRED=1` flag)
  says Mode-B is mandatory and no eth-state bundle is available, `handleReflectionJob`
  should return the *existing* "reflection attest not configured"-style 404/503 rather
  than serve a job that can only revert — this is a liveness stall, never a soundness
  issue, same framing the existing refuse-gate uses.

### 3.3 Promotion: pending → confirmed, tied to the EXISTING ack path

`handleReflectionAck` (`worker/src/index.js:897-913`) is already the one place that
knows, with certainty, that a specific `jobId`/`newDigest` landed on-chain (it's called
by `worker-relay/src/reflection-folder.js:106` only after `ATTEST_CONFIRMATIONS` blocks
**and** an independent-RPC digest cross-check, `reflection-folder.js:97-103`). Extend it:

1. At job-serve time (`handleReflectionJob`, `:748`), alongside stashing `newSnapshot`
   under `reflectionPendingKey`, also stash which `ethstate` `contentHash` this job's
   `ethBundleSource` call returned (read once, cached for the ack).
2. In `handleReflectionAck`, after `att.ackJob(...)` succeeds, read
   `reflection:ethstate:pending:{network}`; if its `contentHash` matches what this job
   used, copy it to `reflection:ethstate:confirmed:{network}` and delete `pending`. If it
   doesn't match (a newer pending was published in between — rare, since §3.2's
   staleness-gated 409 discourages it), leave `pending` alone; the sidecar's next `GET`
   will retry against the still-current `confirmed`.

This closes the loop with **zero new coordination logic in the Rust sidecar** — the
sidecar only ever publishes candidates and polls whether they were promoted; the Worker
(which already does the on-chain confirmation work for the Bitcoin side) is the single
source of truth for "did this eth-state actually get used by a batch that landed,"
exactly mirroring the recipe's own "commit `eth_set_state.pending.json` only after the
on-chain attest actually succeeds" rule (recipe §1) — just moved from a human's SSH
session into the existing ack handler.

### 3.4 New sidecar binary + service

A new Rust binary derived from `eth_prove.rs`'s logic (reuse the module, don't fork it —
the helios fetch, `eth_getLogs`/`eth_getProof` scan, and IMT-witness building are the
part that's fragile and already hardened; only the state I/O boundary changes):

- **ELF path**: `eth_prove.rs:41-43` currently does
  `include_bytes!("/root/sp1-helios/target/elf-compilation/.../eth_reflection")` — a
  RunPod-absolute path. The sidecar binary needs this swapped for an image-relative path
  (`/app/prover/elf/eth_reflection` or similar), built once on the box and shipped the
  **same way `bitcoin_prove`/`exec-*` already are**: staged via
  `worker-relay/scripts/stage-prover-bins.sh`-style tooling, uploaded to a new
  `z0r0z/tacit` GitHub release tag (e.g. `prover-bins-v8`), added to the `SHA256SUMS` +
  the `curl` loop in `worker-relay/Dockerfile:47`. This preserves the existing "one pinned
  release, one `SHA256SUMS` gate" security model instead of inventing a second one.
- **State I/O**: instead of the local `eth_set_state.json`/`.pending.json` files
  (`eth_prove.rs:44-45`), the sidecar's `main()` does one `GET
  /reflection/eth-state?network=mainnet` at start (feeding `prior_set_root`/`prior_count`/
  `prior_consumed_root`/`prior_consumed_count` exactly as `eth_prove.rs:469-484` derives
  them today, just from the HTTP response instead of a re-read local file) and one `POST
  /reflection/eth-state` with the `EthSetBundle` (`eth_prove.rs:212-234`) plus
  `lastBlock`/`execBlock`/`finalizedSlot`/`contentHash` at the end. Local
  `out/eth_set.json` etc. stay as a debug dump only (same role
  `/root/tacfold/ethprove-lc.cbor` already plays, `eth_prove.rs:602-604`).
- **Skip-if-nothing-to-do**: before spending a real network prove, the sidecar's driver
  should first check whether a `pending` already exists and is unconfirmed (skip this run
  entirely — §3.2's serialization) — and, per the recipe's own step 1 ("run `eth_prove`
  twice... `SP1_PROVER=execute` first"), always execute-mode dry-run before the real
  `SP1_PROVER=network` spend, aborting the cycle loudly on a mismatched `pv_bytes`/
  `crossOutCount` rather than buying a proof for a bad witness.
- **New Render service** `tacit-eth-prove` (Cron, not always-on worker — the eth side
  moves far slower than Bitcoin's 10-minute blocks): schedule e.g. `0 * * * *` (hourly) to
  start, tunable once real cadence data exists (§6). `dockerCommand: eth_prove_sidecar`
  (or a thin Node driver script that shells out to the Rust binary, matching how
  `reflection-folder.js` already shells out to `bitcoin_prove`/`exec` via
  `worker-relay/src/lib/prover.js`).

## 4. Exact config/env changes

### 4.1 Cloudflare Worker (dashboard vars — NOT `wrangler.toml`, per §0)

- `REFLECTION_CHAIN_BINDING` = `0x7083f5e31481456a1b9b320cf10988ae8192e13f3d98e6596ea0317ae7a9cd8d`
  (gen4's value, per `MODEB-RECIPE.md` §2) — **currently entirely unset**, confirmed by
  grep of both `wrangler.toml` and `worker/src/index.js`; this is the single highest-value
  fix, since without it every Mode-B batch (even a correctly-assembled one) reverts
  on-chain with `ChainMismatch()`.
- (No other CF Worker var changes needed — `REFLECTION_ATTEST`/`REFLECTION_GENESIS_HEIGHT`
  are presumably already set, since forward-mode reflection has been live since well
  before gen4.)

### 4.2 New Render Cron service `tacit-eth-prove` (`worker-relay/render.yaml`)

```yaml
  - type: cron
    name: tacit-eth-prove
    runtime: docker
    rootDir: worker-relay
    dockerfilePath: ./Dockerfile
    plan: standard
    schedule: "0 * * * *"        # hourly to start — see §6 open question on real cadence
    dockerCommand: node src/eth-prove-sidecar.js   # thin driver; shells to the Rust binary
    autoDeploy: false
    envVars:
      - fromGroup: tacit-relay-shared     # reuses NETWORK_PRIVATE_KEY, BOX_TOKEN, SP1_PROVER, NETWORK_RPC_URL
      - key: RUN_MODE
        value: cron
      - key: ETH_PROVE_BIN
        value: /app/prover/bin/eth_prove
      - key: SOURCE_CONSENSUS_RPC
        value: https://ethereum-beacon-api.publicnode.com
      - key: SOURCE_CHAIN_ID
        value: "1"
      - key: SOURCE_EXECUTION_RPC
        value: https://mainnet.gateway.tenderly.co
      - key: SOURCE_PROOF_RPC
        value: https://eth-mainnet.public.blastapi.io
      - key: ETH_CALL_OUTBOX
        value: "0x00000000002c40c367ed873136e17151652de080"
      - key: DEPLOY_BLOCK
        value: "25926840"
      - key: GENESIS_SLOT
        value: "14745600"
      - key: SCAN_CHUNK
        value: "300"
      - key: SCAN_DELAY_MS
        value: "600"
      - key: ETHPROVE_CYCLE_LIMIT
        value: "3000000000"
      - key: ETHPROVE_GAS_LIMIT
        value: "3000000000"
```

`POOL_ADDR` is already inherited from `tacit-relay-shared` and doubles as `eth_prove`'s
`POOL` env (rename/alias in the driver). `DEPLOY_BLOCK`/`GENESIS_SLOT`/`ETH_CALL_OUTBOX`
are gen4-pinned constants — they need the SAME per-generation override discipline
`render.yaml` already documents for `tacit-settle`'s `POOL_ADDR` override
(`worker-relay/render.yaml:122-129`): re-pin on every future gen bump, in lockstep with
the reflection ELF's compiled-in `ETH_REFLECTION_VKEY`.

### 4.3 Docker image changes

- `worker-relay/Dockerfile:47` — add `eth_prove` to the binary `curl` loop and
  `worker-relay/prover/bin/SHA256SUMS`; bump the `PROVER_RELEASE` tag once it's staged
  (mirrors exactly how `bitcoin_prove` and the `exec-*` family are already added).
- This binary also needs the pinned eth-reflection ELF shipped alongside it (currently
  `include_bytes!`'d at Rust compile time from the RunPod box's `sp1-helios` checkout —
  §3.4) — treat the ELF pin with the same paranoia as `elf-vkey-pin.json` /
  `verify-vkey-pin.sh` already apply to the confidential-pool ELFs
  (`ops/DESIGN-mode-b-recursion.md` §5's "vkey-coupling cascade" risk applies identically
  here: a locally-rebuilt eth-reflection ELF that diverges from the one compiled into the
  live `BITCOIN_RELAY_VKEY`'s `ETH_REFLECTION_VKEY` const produces proofs that verify
  fine locally and fail silently on-chain).

## 5. Migration / rollout plan (no mid-stream disruption)

**Phase 0 (today)**: fully manual, as documented in §1. Keep this working as the
emergency fallback through every phase below — do not delete `MODEB-RECIPE.md` or the
scratchpad harness.

**Phase 1 — ship the Worker-side plumbing only, proving stays manual.**
Add `REFLECTION_CHAIN_BINDING` to the CF dashboard (§4.1 — do this FIRST, independently,
it fixes nothing by itself but is a zero-risk prerequisite). Add the
`reflection:ethstate:{confirmed,pending}` KV keys, the two new endpoints, the
`ethBundleSource` wiring, and the ack-side promotion logic (§3.2–3.3), but no automated
sidecar yet. The human recipe changes only at the hand-off point: instead of running
`gen4-modeb-assemble.mjs` with a local file-based KV shim, run `eth_prove` on the RunPod
box exactly as today, then `curl -X POST .../reflection/eth-state` with the resulting
`eth_set.json` (bearer box-token). The Render `tacit-reflection` cron then picks up the
job automatically via the now-wired `ethBundleSource` — validating the entire Worker-side
change against the SAME manual proving step, before touching the proving automation
itself. This phase alone removes steps 2 and 5 of the current recipe (no more file-based
KV shim, no more manual `/reflection/seed` POST — the ack-triggered promotion replaces
it).

**Phase 2 — deploy the sidecar, retire the manual `eth_prove` run.**
Ship `tacit-eth-prove` (§3.4/§4.2) once Phase 1 has run cleanly for a few real cycles.
Start the cron conservatively (hourly or slower — §6) and watch `NETWORK_PRIVATE_KEY`'s
PROVE balance burn rate before tightening. Cross-check the sidecar's first several
candidates against the recipe's own validation habits (decode `pv_bytes`, confirm
`crossOutCount`/`bitcoinConsumedCount`, run `SP1_PROVER=execute` before `network`) before
trusting it unattended.

**Phase 3 — decommission the manual path as default, keep it documented as a fallback.**
Once the sidecar has run unattended through a full crossout+consume cycle successfully,
downgrade `MODEB-RECIPE.md` from "the process" to "the escape hatch for when the sidecar
is wedged or its RPC providers are down" — same posture the box-driven catch-up already
has relative to the worker's streaming assembler (`reflection-attest.js:100-104`).

## 6. Open questions / risks

- **Real proving cadence vs. freshness-gate cost.** `DESIGN-reflection-liveness-batch.md`
  keeps the fast-lane consume gate at a strict `==NOW` (`consumedCount ==
  bitcoinConsumedCount`, ConfidentialPool.sol:1794) by deliberate final decision — so ANY
  Bitcoin batch that needs to fold a fast-lane consume needs an eth proof fresh enough to
  hit that exact count at attest time, not just "recent." The crossout gate is relaxed to
  `<=`/skip-but-retryable (H-1(b)), which is far more forgiving of a stale bundle. Net: if
  gen4 sees real fast-lane consume traffic, an hourly sidecar cadence may be too slow and
  cause avoidable job failures (wasted `SP1_PROVER=execute` dry-runs are cheap, but a
  submitted-and-reverted `network` proof is not); if it doesn't, hourly is probably
  wasteful. This needs empirical measurement against real gen4 traffic before locking a
  schedule — start conservative (§5 Phase 2) and tighten from observed failure rate, not
  from a guess.
- **SP1 network prover cost per `eth_prove` cycle.** The recipe's
  `ETHPROVE_CYCLE_LIMIT=3000000000` is 6x `worker-relay`'s existing PROVE-per-op economics
  reference point (`worker-relay/src/lib/config.js:171-175`, `OP_PROVE = 0.39` PROVE for
  the heaviest confidential op at ~8.4M cycles) — the eth-reflection guest's real cycle
  count (helios BLS12-381 pairings + STARK recursion) has not been measured against actual
  $ cost per automated cycle. Get a real number from the first several sidecar runs before
  committing to an unattended cadence; this directly bounds how aggressively §6's first
  bullet can be resolved.
- **`NETWORK_PRIVATE_KEY` reuse.** Reusing the existing `tacit-relay-shared` env group's
  key (already shared between `tacit-reflection` and `tacit-settle`) is the simplest
  option and adds no NEW class of exposure — it's a Succinct-network PROVE-balance key,
  not a fund-custody key — but it does mean `tacit-eth-prove`'s hourly draw comes out of
  the same balance the monitored-by-`tacit-monitor` `PROVE_BALANCE_FLOOR` (currently 50)
  already watches. Confirm that floor still gives enough runway once a third consumer
  draws from it, or split a dedicated funded key for the sidecar.
- **ELF hygiene is the sharpest edge, not the proving logic.** Both hazards documented in
  the recipe (bitcoin_prove's silent ELF-overwrite footgun, §1's recipe step 3; and the
  vkey-coupling cascade in `DESIGN-mode-b-recursion.md` §5) apply with equal force to
  whatever pipeline stages the new `eth_prove` binary. Automating the PROVING does not
  automate away the requirement that the ELF baked into that binary is byte-identical to
  the one whose vkey is compiled into the live `reflect.rs`'s `ETH_REFLECTION_VKEY` const
  — get this into the SHA256SUMS-gated release pipeline (§4.3) with the same rigor as the
  confidential-pool ELFs, not as an afterthought.
- **Batch-size cap is unrelated but adjacent.** `worker/src/reflection-attest.js:378`
  hard-caps `MAX_BATCH = 6` Bitcoin blocks per `assembleJob()` call regardless of Mode-B
  status. This sidecar doesn't touch that cap, but a large eth-side backlog (e.g. sidecar
  down for a while, several crossouts queued) combines with it: the Bitcoin side will
  still only advance 6 blocks per cron cycle, so a burst of crossouts folds gradually
  across several cycles even after the eth-state catches up in one sidecar run — expected,
  not a bug, but worth knowing when validating a catch-up after an outage.
- **The T_CROSSOUT_MINT vout-0 footgun is out of scope here.** The recipe's "wasted mint"
  bug (a dust-back P2WPKH at vout 0 instead of a real P2TR encoding the crossOut's `owner`
  causing a silent non-member skip, `MODEB-RECIPE.md` "T_CROSSOUT_MINT" section) is a
  Bitcoin-side wallet/tooling correctness requirement for whoever constructs the 0x65
  reveal tx, not something this sidecar causes or can detect from the Ethereum side —
  flagging it here only so it isn't mistaken for something this automation fixes.
- **First deploy / cold-start ordering.** `handleReflectionJob`'s new refuse-gate (§3.2)
  means that if `tacit-eth-prove` is deployed AFTER the Worker-side wiring lands but
  before it produces a first confirmed bundle, `tacit-reflection` cleanly idles (no wasted
  proofs) rather than reverting — verify this idle path is distinguishable in
  `/prover-health`/heartbeat output from a genuine outage, so `tacit-monitor`'s pager
  doesn't fire on an expected transient gap during Phase 2's rollout.
