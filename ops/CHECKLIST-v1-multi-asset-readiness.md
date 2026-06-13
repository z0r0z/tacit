# CHECKLIST — v1 multi-asset bidirectional readiness

> Goal for v1: **TAC and other Bitcoin-etched Tacit assets move to Ethereum and back; tETH and
> Ethereum ERC20s move to Bitcoin and back** — all under one asset identity, recognizable on either
> chain. This is the code-level gate. App-layer pieces are mostly built (below); the guest/contract
> pieces ride the parallel-session v1 re-prove + deploy and are flagged ⚠️. Companion to
> [`ARCH-tacit-chain-abstraction.md`](./ARCH-tacit-chain-abstraction.md).

## The asset-identity model (the thing that makes "one asset, both chains" hold)

A single **shared `asset_id`** is the universal key, in one of two namespaces:
- **Bitcoin-etched** (TAC, tETH, any CETCH/PETCH asset): `asset_id = sha256(reveal_txid_BE ‖ vout_LE)`.
  Its Ethereum face is the canonical ERC20 at `f(asset_id)`; `localAssetOf[shared_id]` resolves it.
- **EVM-issued** (a wrapped ERC20): `asset_id = sha256("tacit-evm-token-v1" ‖ chainid_be8 ‖ underlying)`.
  Crossing to Bitcoin carries **this** id, so the Bitcoin side must recognize the EVM namespace.

The **cross-chain resolver** (`dapp/cross-chain-asset-resolver.js`) ports both EVM derivations +
`metaHash` + `unitScale` faithfully (KAT-parity verified) and merges asset descriptors from both
origins keyed by the shared id, so **either chain resolves any asset regardless of where it was
issued**. That is the foundation everything else consumes.

## App layer (this session)

- ✅ **Cross-chain asset resolver** — `dapp/cross-chain-asset-resolver.js`: both EVM asset_id
  namespaces + the etch `metaHash` (byte-identical to the canonical-asset-id KAT / Solidity),
  `unitScaleFor` / `normalizeEvmBalance` (18↔base-unit harmonization), and a registry that merges a
  Bitcoin entry + a cross-lane EVM entry of the same shared id into one descriptor with both lanes.
  `tests/cross-chain-asset-resolver.mjs` 5/5.
- ✅ **Unified holdings** — `dapp/unified-holdings.js`: merges by shared `asset_id`, per-lane split.
  Asset-generic. `tests/unified-holdings.mjs` 6/6.
- ✅ **Mode B cross-out glue (worker)** — `worker/src/crossout-consumer.js` + `index.js` (`0x65`
  dispatch + cron): keyed by `asset` (`crossout-minted:{net}:{asset}:{claimId}`, `crossoutMintLeaf`
  carries asset), so it is **already multi-asset**. Inert until a pool deploys.
  `tests/worker-crossout-consumer.mjs` 3/3.
- ✅ **EVM-lane balance reader** — `dapp/evm-lane-reader.js`: per asset, `canonicalTokenFor(assetId)`
  → `balanceOf(evmAddress)` over RPC, normalized to base units (`normalizeEvmBalance`); confidential
  notes / tETH plug in as `extraReaders`; inert until pool + address are set. `tests/evm-lane-reader.mjs`
  3/3. (No off-chain CREATE2 `predict` — a non-deployed token holds no balance.)
- ✅ **`tacit.js` seam wired (additive)** — `scanHoldingsCrossChain()` seeds `makeCrossChainAssets` from
  `loadRegistry` (Bitcoin) + `CROSSLANE_DEPLOYMENTS` (EVM) and feeds `scanHoldingsUnified(scanHoldings,
  reader)`. So a crossed asset is recognizable on either chain. Inert (= Bitcoin-only) until the pool
  deploys; `tacit.js` parses clean.
  ⏳ **Remaining (gated on pool deploy):** wire `evmAddress` (Tacit-derived account vs connected
  provider — a v1-activation decision); add the confidential-note + tETH `extraReaders`; consume
  `scanHoldingsCrossChain` in `renderHoldings` / the portfolio bar (the UI step, shows nothing until
  the eth lane is non-empty).
- ✅ **Dapp `0x65` broadcast seam** — `dapp/crossout-broadcast.js` (`makeCrossoutBroadcaster`):
  `encodeCrossoutMint` → injected Taproot commit/reveal `buildAndBroadcastEnvelope` → `postHint`.
  `tests/crossout-broadcast.mjs` 2/2. ⏳ **Remaining (gated, #5):** provide `buildAndBroadcastEnvelope`
  in `tacit.js` (extract the bridge commit/reveal flow) + the bridge-burn caller (needs the burn UI).

## Guest / contract layer (parallel session — required in the v1 re-prove + deploy)

- ⚠️ **Asset-preservation in the PROVEN bytes.** Source committed (`f0970c2`: carry note asset in
  `LiveUtxoSet` + `fold_cxfer` asset gate) but `elf-vkey-pin.json:_pending_reprove` flags the deployed
  ELFs predate it — the v1 re-prove must rebuild from current source. **Without it, only one
  Bitcoin-pool asset is safe** (the cross-asset relabel needs a 2nd asset). Non-negotiable for v1.
- ⚠️ **cmint-deposit reflection value-entry (`SPEC-BITCOIN-REFLECTION-AMENDMENT §6.1`) — THE key
  decision.** The full-scan reflection is conservation-closed: it can only *move* notes, not enter new
  value, until this path is built. So a newly-etched Bitcoin asset can't get value onto Ethereum at
  all. **For multi Bitcoin assets in v1, build it into the v1 reflection guest** (recommended, given
  multi-asset is the headline); else it's a fast-follow redeploy and v1 ships single-Bitcoin-asset.
  (`cBTC.zk` real-BTC-backed wrap-entry stays deferred regardless.)
- ⚠️ **JS reflection scan indexer carries asset.** The dapp reflection mirror
  (`confidential-reflection-scan-indexer.js` / `makeScanReflectionState`) must carry the note asset
  to mirror the `LiveUtxoSet` asset-carry, or the worker produces an un-provable witness for a
  multi-asset block. Coordinate (reflection territory).
- ⚠️ **Mode B (the return direction).** eth-reflection guest + recursion + the `crossOutCommitment`
  anchor (in tree) + the new `BITCOIN_RELAY_VKEY`, so ERC20s/tETH on Ethereum return to Bitcoin.
- ⚠️ **Immutable anchors correct at deploy.** `HEADER_RELAY`, the reflection genesis anchor, and the
  eth-reflection genesis sync-committee anchor — wrong/late = a forced redeploy.

## Already-supported on-chain (no change needed)

- ✅ **Lazy per-asset canonical ERC20** — `_autoRegisterFromMeta` (B6) deploys + registers a canonical
  ERC20 with SP1-proven metadata for any confirmed Bitcoin etch; `registerWrappedAuto` /
  `registerMintedAuto` for ERC20 / Tacit-native. So the contract is already multi-asset; the gap was
  the reflection value-entry, not the contract.
- ✅ **Shared-id resolution** — `localAssetOf` maps a shared id to the local EVM entry on unwrap of a
  bridged note (first-write-wins, can't be squatted).

## The two decisions to make before locking the v1 re-prove

1. **Build cmint-deposit reflection value-entry for v1?** → yes if v1 should bridge *arbitrary*
   Bitcoin-issued assets (the multi-asset headline), no if v1 is intentionally scoped to a seeded set.
2. **Confirm the asset-preservation rebuild + the multi-asset JS scan-indexer ride the same v1
   re-prove** (they must, to onboard a 2nd Bitcoin-pool asset safely).

Everything else for multi-asset is app-layer and additive (resolver done; the `tacit.js` wiring + EVM
reader are gated on the pool deploy, no re-prove).
