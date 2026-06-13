# RUNBOOK — Deploy ConfidentialPool (turn on Ethereum fast settlement)

Deploying `ConfidentialPool` is the moment **Ethereum fast settlement of
confidential trades goes live** — `settle` *is* the fast layer (~12s on-chain). The
crypto is done and proven; this is the turnkey deploy.

## Sepolia pilot v1 — the current deploy

The v1 launch is the **shielded pool + bidirectional bridge on Sepolia** (TAC + tETH both ways), deployed
on the **re-proven, cBTC-aware vkeys** so cUSD/cBTC iterate additively later with **no core redeploy** (the
launch seam — `DESIGN-cbtc.md §9`; the `CUsdController` minter-seam — `DESIGN-cusd-cdp.md`).

**Gating dependency:** the reflection guest's **Mode B (reverse bridge)** must be final before you freeze +
deploy the bridge posture — that's what fixes `BITCOIN_RELAY_VKEY`. Everything else below is ready.

### Inputs (the immutable core)
| arg | value | note |
|---|---|---|
| `PROGRAM_VKEY` | `0x00d5b572…` (the script `DEFAULT_VKEY`) | settle guest; pinned in `elf-vkey-pin.json` — the script cross-checks + reverts on mismatch |
| `BITCOIN_RELAY_VKEY` | the FINAL reflection vkey (currently `0x005e6adc…`, **Mode-B-gated** — confirm final with the guest session before freeze) | sole Bitcoin-state authority; must == `elf-vkey-pin.json` `bitcoin_relay_vkey` |
| `SP1_VERIFIER` | Succinct's Sepolia Groth16 v6.1.0 leaf | selector `0x4388a21c`; the same family tETH pins |
| `CANONICAL_FACTORY` | deploy `CanonicalAssetFactory` first; pass its address | the cUSD/cBTC.tac mint seam |
| `HEADER_RELAY` | the `BitcoinLightRelay` on Sepolia (deploy if absent) | required when reflection on; anchors every reflection proof |
| `GENESIS_REFLECTION_ANCHOR` | the Bitcoin block hash the first reflection batch resumes from | a zero seed bricks the first attest |
| `REFLECTION_CONFIRMATIONS` | `6` (default) | reorg/finality window |

### Deploy
```
cd contracts
SP1_VERIFIER=<sepolia groth16 leaf> \
BITCOIN_RELAY_VKEY=<final reflection vkey> \
CANONICAL_FACTORY=<factory addr> \
HEADER_RELAY=<BitcoinLightRelay addr> \
GENESIS_REFLECTION_ANCHOR=<btc block hash> \
ACK_REFLECTION_ANCHORED=1 \
  forge script script/DeployConfidentialPool.s.sol \
  --rpc-url $SEPOLIA_RPC --private-key $PK --broadcast --verify
```
`PROGRAM_VKEY` defaults to the pinned `0x00d5b572`; the script reverts if it ≠ `elf-vkey-pin.json`
(`ALLOW_UNPINNED_VKEY=1` only for an intentional guest change). For a forward-only / Ethereum pilot before
Mode B lands, omit `BITCOIN_RELAY_VKEY` (defaults to `0` → cross-lane inert; see Full cross-lane below).

### Post-deploy
1. **Register the launch assets** (permissionless): tETH (the Ethereum bridge asset) + TAC (Bitcoin-homed;
   `crossChainLink` = its Bitcoin id) as confidential assets.
2. **Un-gate the worker reverse-bridge glue:** set
   `CONFIDENTIAL_POOL_DEPLOYMENTS.sepolia = { pool: <deployed pool>, deployBlock: <block> }` in
   `dapp/confidential-crossout-consumer.js` — this turns on the cron `scanOnce` + the `0x65` dispatch (both
   inert until set, zero hot-path cost). Deploy worker + dapp together.
3. **Verify the seams** (read-only): `cbtcBackingSats()` == 0 (cBTC dormant), `REFLECTION_GENESIS_DIGEST()`
   == `0x164ac1b2…`, `PROGRAM_VKEY()` / `BITCOIN_RELAY_VKEY()` == the pinned values, `CANONICAL_FACTORY()`
   set, and a test crossOut writes `crossOutCommitment`.
4. **Both-ways round-trip** (Sepolia + signet): ETH→tETH→pool→withdraw; Bitcoin TAC→reflect→pool→crossOut→
   back-to-Bitcoin (the return leg needs Mode B live).

### Dormant-but-present (no redeploy to turn on)
- **cBTC** — the reflection lock-fold + `cbtcBackingSats` are in the core; turn on via the cBTC canonical
  asset + the passive `CbtcBuffer` + the live lock-fold indexer (`DESIGN-cbtc.md §9`).
- **cUSD / cBTC.tac** — additive Ethereum contracts behind the `CUsdController` minter-seam.
- **Confidential CDP positions** — the ONE thing needing a future settle re-prove (the `P_liq` engine);
  deliberately deferred.

## Prerequisites
- **SP1 Groth16 verifier address** for the target chain — the immutable v6.1.0 leaf
  (the same family the tETH bridge pins). Sepolia + mainnet addresses from Succinct's
  published deployments. The proof selector is `0x4388a21c`; the verifier's
  `VERIFIER_HASH()` must match.
- **Deployer key + RPC** (`--private-key`, `--rpc-url`).
- **Program vkey is frozen + pinned.** The settle guest is re-proven (commit `ef0c514`);
  `DEFAULT_VKEY = 0x00d5b572…` matches `elf-vkey-pin.json` and the deploy script
  cross-checks it (reverts on mismatch). The *reflection* vkey (`BITCOIN_RELAY_VKEY`,
  currently `0x005e6adc…`) is the **Mode-B-gated** one — confirm it's final with the guest
  session before you freeze the bridge posture (see "Sepolia pilot v1" above). The
  `*ProofReal` fixtures already certify these vkeys; refresh them only on a further guest
  change. See "Full cross-lane activation" below.

## Deploy
```
cd contracts
SP1_VERIFIER=<sp1 groth16 verifier on this chain> \
  forge script script/DeployConfidentialPool.s.sol \
  --rpc-url $RPC --private-key $PK --broadcast --verify
```
Optional: `BITCOIN_RELAY_VKEY=<vkey>` is the SP1 vkey of the **reflection prover**;
it is the sole authority for Bitcoin pool/spent-set state (no trusted oracle). Leave
it `0` for an Ethereum-only deploy (cross-lane inert — see the pool→cross-lane staging
below); set it to the frozen reflection-prover vkey to enable full cross-lane.
Optional `SAMPLE_UNDERLYING=<erc20>` registers a first confidential asset inline.

## Post-deploy — register assets
Any ERC-20 becomes a confidential asset, permissionlessly:
```
pool.registerWrapped(underlying, unitScale, crossChainLink, name, symbol, decimals)
```
- **Confidential ETH** works today via **WETH**: `registerWrapped(WETH, 1, 0, "Conf
  ETH", "cETH", 18)`. (A native-ETH payable wrap is optional UX, not required.)
- `crossChainLink` binds an asset to its Bitcoin-side id (for cross-chain assets);
  `0` for Ethereum-native.

## What you have the moment this lands
- **Confidential transfers + matched/atomic swaps settle on Ethereum in ~12s**,
  final on Ethereum (instant client-side soft-finality the moment a recipient
  verifies the BP+ proof; on-chain `settle` is the serialized confirm).
- Seed-only recovery (the worker decodes `LeavesInserted`/`NullifiersSpent`; the
  client `confidential-indexer` reconstructs balances).

## What it does NOT yet do (later layers, not blocking the above)
- **Cheap at scale** = batching (the rollup): the guest already settles many ops per
  proof (`numOps`); an off-chain batcher collects users' ops into one proof →
  per-trade proving + gas amortized. (Phase 2.)
- **Full cross-lane (cross-lane fast lane)** for Bitcoin-homed notes — the reflection
  prover + `BITCOIN_RELAY_VKEY`. See "Full cross-lane activation" below.
- **Pooled confidential swaps** route to the live Bitcoin `T_SWAP_BATCH` via the
  bridge; Ethereum-side trades are transfers + matched swaps.

## Full cross-lane activation (cross-lane fast lane)

The contract ships cross-lane-final: `settle` accepts a Bitcoin-homed spend root and
enforces in-guest Bitcoin spent-set non-membership against the reflected root. Two
deploy postures over the **same contract + guest**:

- **Pool (Ethereum-only).** `BITCOIN_RELAY_VKEY = 0`. No Bitcoin root can be attested
  → `knownBitcoinRoot` stays empty → no spend is ever Bitcoin-homed → cross-lane is
  fully inert. Confidential transfers/swaps settle on Ethereum; this is the safe
  capped pilot.
- **Bridge (cross-lane on).** `BITCOIN_RELAY_VKEY = <reflection prover vkey>`. A
  Bitcoin-homed note can be fast-spent on Ethereum, gated by non-membership against
  the reflected Bitcoin spent set. Requires the pieces below.

### Security invariants (enforced; do not regress)
- **The reflected spent-set root is NEVER zero.** An empty Bitcoin spent set has a
  non-zero empty-IMT sentinel root. `attestBitcoinStateProven` rejects a zero
  `bitcoinSpentRoot`, and `settle` rejects any Bitcoin-homed spend whose
  `bitcoinSpentRoot` is zero or not the current reflected root. A zero root would let
  the guest skip its non-membership check (it keys off `bitcoin_spent_root != 0`) and
  re-spend on Ethereum a note already spent on Bitcoin. The reflection prover MUST
  seed and only ever advance a non-zero spent-set root.
- **Reflect from genesis.** Before the first Bitcoin-homed spend root is usable, the
  relay must have attested the Bitcoin spent set up to a confirmed height — a
  Bitcoin-homed spend can only pin the current root, so the set must already reflect
  every Bitcoin spend that could collide.
- **Monotonic height.** `attestBitcoinStateProven` requires strictly increasing
  height, so a stale reflection cannot roll the spent set backward.
- **In-system value, not amount.** Boundary effects carry the note's `value`; the
  contract scales by the asset's trusted `unitScale`. The deposit id binds `value`
  (forcing `value·unitScale == escrowed amount`); the guest never sees `unitScale`.

### Remaining build to turn cross-lane on (box + infra)
1. **Freeze the guest, prove, pin the vkey** (box). `cargo prove` the gen-1 guest;
   set `PROGRAM_VKEY`; regenerate `confidential_groth16.json` +
   `crosslane_groth16.json`; confirm `ConfidentialProofReal` +
   `ConfidentialCrossLaneProofReal` verify on-chain against the frozen vkey.
2. **Bitcoin-side confidential pool** — the indexer that maintains the canonical
   Bitcoin note tree + spent-nullifier IMT the reflection prover proves over. (New
   subsystem; today the worker indexes cxfer envelopes but not a canonical pool.)
3. **Reflection prover** — an SP1 guest (sibling of the bridge_mint guest, reusing
   `cxfer-core::bitcoin` + the IMT) that proves `(bitcoinPoolRoot, bitcoinSpentRoot,
   height)` from confirmed Bitcoin headers, committed as `BitcoinRelayPublicValues`.
   Its vkey is `BITCOIN_RELAY_VKEY`. Submission toolkit is `confidential-btc-relay.js`
   (`attestBitcoinStateProven`); proving is on the box.
4. **Deploy** with `PROGRAM_VKEY` (frozen guest) + `BITCOIN_RELAY_VKEY` (reflection
   prover). Capped pilot first; cross-lane spends only after the spent set is
   reflected from genesis.

Steps 2–3 are the substantive remaining engineering and step 1/4 are box + key
operations; the contract, guest cross-lane check, gate, relay toolkit, and proof
verification are in place and tested.

## Reflection relay loop (BRIDGE go-live)

The on-chain Bitcoin-state attestation is kept current by a self-hosted loop, the
**box-poll** model (the box is outbound-only, behind vast NAT — it never accepts
inbound; the relay key + RPC stay on the box, no third-party prover):

```
worker (scan)         box (GPU)                          chain
  ingest CXFER  ──▶  GET /reflection/job  ──▶ prove ──▶ attestBitcoinStateProven
  effect log          (exec-reflect-prove,   (cast send,    │
                       groth16)               RELAY_KEY)     ▼
  advance cursor ◀──  POST /reflection/ack ◀── tx mined ─────┘
```

- **Worker side (built):** the scan ingests confirmed CXFERs into the effect log
  (`reflection-attest.js` `ingest`); `GET /reflection/job?network=` serves the next
  assembled batch (`assembleJob`, no prove/advance); `POST /reflection/ack` advances
  the attested cursor after the on-chain attestation lands (`ackJob`, idempotent).
  Config: set `REFLECTION_ATTEST=1` + `REGISTRY_KV` on the worker. (No
  `REFLECTION_PROVE_URL` in this model — that's only the synchronous worker-proves
  variant.)
- **Box side:** `ops/scripts/reflection-relay-loop.sh`. One-time setup: `cp
  exec-reflect-prove.rs → exec/src/main.rs`, `cargo prove build` the guest, start
  `sp1-gpu-server`. Then run the loop with `WORKER_BASE`, `NETWORK`, `POOL_ADDR`,
  `RPC_URL`, `RELAY_KEY` (funded) in a tmux/run-loop. It polls, proves, submits
  `attestBitcoinStateProven`, and acks. Idempotent: before proving it reads
  `knownReflectionDigest` and re-acks (never re-submits) a batch that already landed —
  the digest-chain makes a duplicate submit revert, so the cursor can never skip.
- **Coherence:** the box must run the committed canonical reflection ELF
  (`elf/reflection-prover`, vkey `BITCOIN_RELAY_VKEY = 0x0050d656…`), so the pool is
  deployed with that exact `BITCOIN_RELAY_VKEY`. The pin (`elf-vkey-pin.json`) guards the bytes.

## Confidential settle relay (fast lane: deposit → swap / LP / transfer → withdraw)

The same box also drives the **settle** prover — the user-initiated path that turns the
live pool into a working loop. Architecture mirrors the reflection relay, but it's a
multi-job QUEUE rather than a single cursor (each settle is a user op, not a background tick):

```
 dapp (confidential-relay.js)                worker                         GPU box
   submitOp{type,op,memos} ──▶ POST /confidential/submit ─▶ enqueue
                                GET /confidential/job  ◀── claim (Bearer) ◀── poll
                                                          ─▶ op → harness → groth16
                                                          ─▶ cast send settle(pv,proof,memos)
   waitForSettle(jobId) ──▶ GET /confidential/status      POST /confidential/ack ◀── tx mined
```

- **Worker side (built):** `worker/src/confidential-settle.js` — a KV-backed queue
  (`submitJob`/`nextJob`/`ackJob`/`jobStatus`, FIFO claim with a 10-min stale-claim
  reclaim + submit-dedup). Routes in `index.js`: `POST /confidential/submit` (public,
  permissionless — a bad witness just fails to prove), `GET /confidential/job` +
  `POST /confidential/ack` (box-only, Bearer `CONFIDENTIAL_BOX_TOKEN`/`DEBUG_TOKEN`,
  default-deny 404), `GET /confidential/status` (dapp poll). Config: set
  `CONFIDENTIAL_SETTLE=1` + a KV (`CONFIDENTIAL_KV` or `REGISTRY_KV`) + a
  `CONFIDENTIAL_BOX_TOKEN` on the worker.
- **Box side:** `ops/scripts/confidential-settle-loop.sh`. One-time: stage the op
  harnesses in `$CXFER/harnesses/` (`exec-swap.rs`, `exec-lp.rs`, `exec-prove.rs`),
  build the guest ELF. Run with `WORKER_BASE`, `BOX_TOKEN`, `POOL_ADDR`, `RPC_URL`,
  `SETTLE_KEY` (funded). It claims a job, writes the op JSON to that type's fixture,
  fresh-gpu-server Groth16-proves the matching harness, submits
  `settle(pv, proof, memos)`, and acks. A fresh `sp1-gpu-server` per job (a 2nd
  groth16 on a warm server OOMs). One op per settle (batching = follow-up).
- **Coherence:** the box runs the committed canonical settle ELF (`elf/cxfer-guest`,
  `PROGRAM_VKEY = 0x00d0fb85…`), the same vkey the pool is deployed with — so the proof
  the box produces is the one `settle` verifies. The op JSON the dapp submits must match
  the harness's fixture shape (what `gen-confidential-*-fixture.mjs` emit); the on-chain
  proof enforces that parity.
- **Idempotency (follow-up):** on a lost ack the worker re-serves; the box's re-submit
  reverts (nullifier already spent) and is acked failed. Submit-dedup keeps a resubmit
  from storming. A per-op on-chain pre-check (nullifier-spent → re-ack settled) is the
  clean upgrade.
