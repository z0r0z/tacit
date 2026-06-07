# RUNBOOK — Deploy ConfidentialPool (turn on Ethereum fast settlement)

Deploying `ConfidentialPool` is the moment **Ethereum fast settlement of
confidential trades goes live** — `settle` *is* the fast layer (~12s on-chain). The
crypto is done and proven; this is the turnkey deploy.

## Prerequisites
- **SP1 Groth16 verifier address** for the target chain — the immutable v6.1.0 leaf
  (the same family the tETH bridge pins). Sepolia + mainnet addresses from Succinct's
  published deployments. The proof selector is `0x4388a21c`; the verifier's
  `VERIFIER_HASH()` must match.
- **Deployer key + RPC** (`--private-key`, `--rpc-url`).
- Program vkey is baked as the default (`0x0063293d…`, the complete gen-1 guest:
  wrap/transfer/unwrap/bridge_burn/bridge_mint + the cross-lane gate). Override with
  `PROGRAM_VKEY` only if the guest changes.

## Deploy
```
cd contracts
SP1_VERIFIER=<sp1 groth16 verifier on this chain> \
  forge script script/DeployConfidentialPool.s.sol \
  --rpc-url $RPC --private-key $PK --broadcast --verify
```
Optional: `BITCOIN_ROOT_ORACLE=<addr>` to enable cross-chain mint / the dual-lane
reflection later (default `address(0)` = cross-chain off, Ethereum-only at first).
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
- **Finalize-to-Bitcoin (the dual-lane fast lane)** for Bitcoin-sovereign assets =
  the anchor relay + the reflection prover (`reflectBitcoinSpentRoot`), built on the
  same gen-1 rails. (Improved platinum; §9/§10 of `PLAN-confidential-cross-chain.md`.)
- **Pooled confidential swaps** route to the live Bitcoin `T_SWAP_BATCH` via the
  bridge; Ethereum-side trades are transfers + matched swaps.
