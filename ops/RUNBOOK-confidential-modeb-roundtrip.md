# RUNBOOK — Mode B live round-trip (ETH→BTC→ETH) on the confidential pilot

> **Status note (2026-06-21):** historical pilot runbook. Refresh pool address, note fixtures, and
> vkeys from `contracts/sp1/confidential/elf-vkey-pin.json` before using it for the new Sepolia
> full-suite generation.

The deepest pilot validation (#10's bridge check): move a cETH note **ETH→BTC→ETH**, live, proving both
bridge directions and that the asset id is preserved across both boundaries. Budget ~2–3 hr (a hard
~1 hr signet-maturity wait + three settle/prove builds + one Bitcoin broadcast + several groth16 cycles).

**Why this is the only live bridge_mint test:** fresh Bitcoin value (`cmint`) is NOT reflected
(conservation-closed model; cmint-deposit deferred, SPEC-BITCOIN-REFLECTION-AMENDMENT §6.1). So the
reflected Bitcoin pool is seeded only by `crossout_mint`s (value that came FROM Ethereum). A cETH note
must therefore crossOut to Bitcoin first, then bridge_mint back.

## Prerequisites
- Box 40707240 (cuda) up; committed ELFs staged — **verify BOTH** guest vkeys vs the authoritative
  top-level fields in `contracts/sp1/confidential/elf-vkey-pin.json`; a drifted ELF LOCAL_VERIFY_OKs
  but reverts on-chain.
- A cETH note in pilot pool `0x991726A5` (have one: value 1e15, recovered seed-only; opening from
  `scripts/build-ceth-wrap.mjs`).
- Signet wallet funded (`~/.tacit-signet-test.key`, ~76803 sats) for the 0x65 broadcast.
- Deployer key (settle/attest relay), funded Sepolia.

## Steps

### 1. crossOut settle (ETH→BTC)  — BUILD GAP: no CLI today
- Witness: `ct.buildBridgeBurn({ inputs:[cETH note {value,blinding,secret}], outputs:[{value, blinding:new, owner:BTC_OWNER}], assetId:cETH, destChain:1(BITCOIN), bindNullifier:nullifier(cx,cy) })`
  (`dapp/confidential-transfer.js:103`). Yields conservation + `crossOuts[0]={destChain, destCommitment=pool.leaf(asset,cx,cy,owner), nullifier, assetId, claimId}`.
- TO BUILD: the full **settle** witness = the above + the cETH note's **tree-membership path**
  (`confidential-indexer` merkle path for leaf 0 vs currentRoot `0xa510ab28`) + spent-set
  non-membership; mapped to the box harness op-JSON. Confirm WHICH harness proves bridge_burn-with-crossOut
  (candidates: a bridge-burn variant / `exec-prove.rs`) and its io::read order. Add `chainBinding`
  (pool CHAIN_BINDING `0x270fcd8e…`) to the op JSON.
- Prove groth16 (box) → `settle(pv, proof, memos)` on `0x991726A5` → `crossOutCommitment[claimId]` set +
  `CrossOutRecorded`.

### 2. eth_prove (Mode B stage-i, now non-empty crossOut set)
- `/root/run-eth-prove.sh` with `POOL=0x991726A5` → `out/eth_compressed.bin`. The eth-reflection now proves
  the populated `crossOutCommitment` storage; the crossOutSet includes `claimId`. ~50 s.

### 3. Broadcast T_CROSSOUT_MINT (0x65) on signet
- `encodeCrossoutMint({assetId:cETH, claimId, cx, cy, owner})` (`dapp/confidential-crossout-consumer.js`)
  → 161-byte 0x65 envelope. The Bitcoin note (cx,cy,owner) MUST equal the crossOut's `destCommitment` leaf.
- Broadcast via `makeCrossoutBroadcaster` (`dapp/crossout-broadcast.js`), injecting
  `buildAndBroadcastEnvelope` — the signet Taproot commit/reveal + postHint (same path tETH deposit uses).
  BUILD GAP: a CLI `buildAndBroadcastEnvelope` over the signet wallet.

### 4. Reflect (non-empty fold_crossout) + attest  — ~1 hr maturity
- Wait 6+ signet confs on the 0x65 tx (REFLECTION_CONFIRMATIONS).
- Fixture: extend `scripts/build-reflection-bootstrap-fixture.mjs` to mark the 0x65 tx's `env` as a
  `crossout_mint` (decode 0x65 → the note) so `assembleReflectionScanInput` folds it via `fold_crossout`
  (gated on eth crossOutSet membership). BUILD GAP: today the builder sets `env:null`.
- `bitcoin_prove` groth16 (feeds the stage-i eth proof) → folds the crossout_mint → non-empty
  `bitcoinPoolRoot`. `attestBitcoinStateProven` → `knownBitcoinRoot[root]=true`.

### 5. bridge_mint (BTC→ETH)  — BUILD GAP: no CLI today
- `exec-bridgemint.rs` (box) proves the Bitcoin note's membership in `knownBitcoinRoot` → mints the cETH
  note on the EVM pool. TO BUILD: the bridge_mint op-JSON (the Bitcoin note opening + the membership path
  vs the attested root) + prove + `settle(pv, proof, [memo])` → cETH re-minted.
- Recover the re-minted note seed-only → **same asset (cETH), value conserved**. Round-trip complete.

## Verification
The asset id stays `cETH 0x2a0f3cb4…` at every hop (crossOut destCommitment → the Bitcoin note →
bridge_mint output); value conserved across both boundaries. This is the live proof of the
asset-identity answer (the round-trip preserves the original asset).

## Gotchas (learned 2026-06-14)
- Verify BOTH guest vkeys vs the pin before any prove (the box's settle ELF had drifted to `0x009cb098`).
- Op JSON needs `chainBinding` (the pool's CHAIN_BINDING); the cps loop stamps it — add it for a manual run.
- exec-*.rs write to `/root/work/cxfer/exec/` (mkdir first); `rc=134` cuda-teardown SIGABRT is benign —
  judge by the `.hex` artifacts.
- Run proves via tmux + a fixed run script (NO `| tail` buffering, which swallows the log); fresh
  `sp1-gpu-server` per prove.

## The three build gaps to close first (the real work)
1. **crossOut-settle CLI** — settle witness (buildBridgeBurn + membership path + nullifier) + the box op-JSON.
2. **signet `buildAndBroadcastEnvelope` CLI** — for the 0x65 Taproot broadcast.
3. **bridge_mint-settle CLI** — the membership-vs-attested-root witness + the box op-JSON.

Once those three CLIs exist, the round-trip is a scripted sequence plus the maturity wait. The
crossOut-settle CLI is the keystone (reusable for any ETH→BTC bridge op).
