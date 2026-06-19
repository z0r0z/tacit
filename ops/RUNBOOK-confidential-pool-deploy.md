# RUNBOOK — Deploy ConfidentialPool (turn on Ethereum fast settlement)

Deploying `ConfidentialPool` is the moment **Ethereum fast settlement of
confidential trades goes live** — `settle` *is* the fast layer (~12s on-chain). The
crypto is done and proven; this is the turnkey deploy.

## Sepolia pilot v1 — the current deploy

The v1 launch is the **shielded pool + bidirectional bridge on Sepolia** (TAC + tETH both ways), deployed
on the **re-proven, cBTC-aware vkeys** so cUSD/cBTC iterate additively later with **no core redeploy** (the
launch seam — `DESIGN-cbtc.md §9`; the `CUsdController` minter-seam — `DESIGN-cusd-cdp.md`).

The standalone tETH mixer is legacy alpha. For ETH, the forward path is this `ConfidentialPool` deployment
(native-ETH/tETH as a registered pool asset); the old mixer should be treated as existing-note redemption /
migration infrastructure, not the target for new public-facing ETH ops.

**Both vkeys are now Sepolia E2-pinned** (settle `0x005c8a3d`, reflection `0x008c9fa6`; ELF hashes and
full ProofReal fixtures are in `sp1/confidential/elf-vkey-pin.json`), so the immutable core is ready to
deploy/redeploy at the current guest pins. Older live-pilot addresses below are historical until they are
re-broadcast at these E2 pins.

**✅ LIVE (2026-06-14) — the bidirectional bridge is proven on-chain.**
- **Settle:** pool `0x32e46B09…` settled a cETH wrap end-to-end (OP_WRAP groth16 → `settle` → seed-only note recovery verified).
- **Reflection (Bitcoin→ETH):** near-tip pool **`0x991726A547DCdB57ba660E395D9c7D7C3FcAdF79`** completed the **first live `attestBitcoinStateProven`** (tx `0xf6940dd4…`, block 11057363): `knownReflectionDigest` advanced genesis→`0x1ac6919e…`, `lastRelayHeight` 308796, the Bitcoin pool root is canonical (a `bridge_mint` can now prove membership). **This is the live pilot** — the dapp config (`confidential-pool-ux.js`, `confidential-crossout-consumer.js`) + the box repoint/settle scripts are pointed here (commit `8992bf2`).

> ### ⚠ LAUNCH RULE — near-tip genesis anchor + continuous attest
> The first reflection batch is LOCKED to start at `GENESIS_REFLECTION_ANCHOR` (its `headers[0].prev`) and its tip must reach `RELAY.tip() − REFLECTION_CONFIRMATIONS` (within `REFLECTION_FINALITY_WINDOW`; both = 6). **So set the genesis anchor at the live matured relay tip and attest continuously** — 1–6 block batches prove in ~2 min on the standard RTX 4090 box. If the anchor sits far below the relay tip (an idle gap), the first batch spans the *entire* gap as one full-scan — e.g. a 73-block gap on a busy signet = ~15k txs → **OOMs a 24 GB GPU** (it's the recursion circuit, not shard size; an 80 GB GPU or a fresh near-tip redeploy is the only out). The OOM is a deploy-time artifact, NOT a design limit. Proven both ways 2026-06-14: anchor 308723 (relay raced to 308802) OOM'd the 4090; anchor 308795 (matured−1) → a 1-block first attest sailed through in ~2 min.

### Inputs (the immutable core)
| arg | value | note |
|---|---|---|
| `PROGRAM_VKEY` | `0x005c8a3d…` (the script `DEFAULT_VKEY`) | settle guest; pinned in `elf-vkey-pin.json` — the script cross-checks + reverts on mismatch |
| `BITCOIN_RELAY_VKEY` | `0x008c9fa6…` — Sepolia E2-pinned | sole Bitcoin-state authority; must == `elf-vkey-pin.json` `bitcoin_relay_vkey` |
| `SP1_VERIFIER` | Succinct's Sepolia Groth16 v6.1.0 leaf | selector `0x4388a21c`; the same family tETH pins |
| `CANONICAL_FACTORY` | deploy `CanonicalAssetFactory` first; pass its address | the cUSD/cBTC.tac mint seam |
| `HEADER_RELAY` | the `BitcoinLightRelay` on Sepolia (deploy if absent) | required when reflection on; anchors every reflection proof |
| `GENESIS_REFLECTION_ANCHOR` | the Bitcoin block hash the first batch resumes from — **set it at the live matured relay tip** | zero bricks the first attest; an anchor far below the relay tip = a huge first batch (see Launch rule). Internal-LE byte order = the NEXT block header's `prev` field (bytes 4–36); = `reverse(mempool display hash)` |
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
`PROGRAM_VKEY` defaults to the pinned `0x005c8a3d`; the script reverts if it ≠ `elf-vkey-pin.json`
(`ALLOW_UNPINNED_VKEY=1` only for an intentional guest change). For a forward-only / Ethereum pilot before
Mode B lands, omit `BITCOIN_RELAY_VKEY` (defaults to `0` → cross-lane inert; see Full cross-lane below).

### Post-deploy
1. **Register the launch assets** (permissionless): tETH (the Ethereum bridge asset) + TAC (Bitcoin-homed;
   `crossChainLink` = its Bitcoin id) as confidential assets.
2. **Un-gate the worker reverse-bridge glue:** set
   `CONFIDENTIAL_POOL_DEPLOYMENTS.signet = { pool: <deployed pool>, deployBlock: <block> }` in
   `dapp/confidential-crossout-consumer.js` (keyed by the BITCOIN network it bridges to; the value is the
   Sepolia pool address) — this turns on the cron `scanOnce` + the `0x65` dispatch (both inert until set,
   zero hot-path cost). Deploy worker + dapp together. *(Done for the pilot at `0x991726A5`, commit `8992bf2`.)*
3. **Verify the seams** (read-only): `cbtcBackingSats()` == 0 (cBTC dormant), deployment args/broadcast show
   `PROGRAM_VKEY` / `BITCOIN_RELAY_VKEY` equal the pin file and non-zero `CANONICAL_FACTORY` / `HEADER_RELAY`
   were passed, `knownReflectionDigest()` starts at the genesis/resume digest and advances after the first
   attest, and a test crossOut writes `crossOutCommitment`.
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
- **Program vkey is frozen + pinned for this Sepolia E2 deploy.**
  `DEFAULT_VKEY = 0x005c8a3d…` matches `elf-vkey-pin.json` and the deploy script
  cross-checks it (reverts on mismatch). The *reflection* vkey (`BITCOIN_RELAY_VKEY`,
  currently `0x008c9fa6…`) is the Sepolia E2-pinned relay authority; the
  `*ProofReal` fixtures certify these vkeys, and readiness-gate layer 9 must allowlist the
  exact reflection vkey after the REFLECT-1 negative conservation KAT. Refresh the fixtures only on a
  further guest change. See "Full cross-lane activation" below.

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
  (`elf/reflection-prover`, vkey `BITCOIN_RELAY_VKEY = 0x008c9fa6…` — Sepolia E2-pinned), so the pool is
  deployed with that exact `BITCOIN_RELAY_VKEY`. The pin (`elf-vkey-pin.json`) guards the bytes.

### Proven manual pipeline (Mode B, 2026-06-14) — the actual go-live path
Mode B couples forward reflection to an eth-reflection recursion, so the attest is a **two-stage**
prove, not a single `exec-reflect-prove`. The path that produced the first live attest (box = RTX 4090,
cuda; `cast` runs from local — it's not on the box):
1. **Assemble the batch fixture** (local): `node scripts/build-reflection-bootstrap-fixture.mjs <from> <to> out.json` — fetches each signet block raw from mempool.space/signet, segwit-splits every tx, and runs the dapp `assembleReflectionScanInput` over the genesis `ScanReflection` state (raw-block fetch = ~1 call/block, not per-tx). Keep `<from>..<to>` small (near-tip; see Launch rule). `scp` it to `/root/work/confidential/fixtures/reflection_input.json`.
2. **Stage-i `eth_prove`** (box): `/root/run-eth-prove.sh` (set `POOL=<pool>`) — helios light-client → compressed eth-reflection proof committing `ethPool==pool` + the genesis sync-committee anchor `0x8a83…`. ~50 s. Writes `out/eth_compressed.bin`.
3. **Stage-iii `bitcoin_prove groth16`** (box): `/root/run-bitcoin-prove.sh` — recursively `verify_sp1_proof`s the eth proof + full-scans the batch → groth16. Writes `out/bitcoin_pv.hex` (320 B / 10 words) + `out/bitcoin_proof_bytes.hex`. A near-tip 1-block batch is ~2 min.
4. **Attest** (local): `cast send <pool> "attestBitcoinStateProven(bytes,bytes)" 0x<pv> 0x<proof> --private-key <relay/deployer> --rpc-url <sepolia>`.
- **GPU gotcha:** both run-scripts kill + restart `sp1-gpu-server` fresh first — a warm server holds stale VRAM from a prior crash → `allocation failed` / `early eof` at eth setup. `pkill -9 sp1-gpu-server; rm /tmp/sp1-cuda-0.sock` if a run aborts in <30 s.
- **Box is on-demand:** stop it when idle (artifacts persist on the stopped instance), restart for the next attest. Advance the relay (`scripts/advance-relay.sh`) so the matured tip stays ahead of your batch tip; don't advance past `your-tip + FINALITY_WINDOW` or the anchor check expires before you attest.

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
