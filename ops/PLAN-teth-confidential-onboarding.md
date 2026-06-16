# PLAN — Onboard tETH onto the confidential pool, preserving its asset id

Goal: bring tETH onto the confidential pool / bidirectional bridge as the **next generation**, keeping
its existing asset id so holders see one continuous asset across the old mixer and the new pool. The old
tETH mixer is being deprecated; this is the migration target, not a new asset.

## The id we preserve
`tETH asset id = 3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34`

This id is **already stable across mixer generations** — `TETH_GENERATIONS` (worker/src/index.js) carries
it for both `pilot` (mixer `0x6929acf0`) and `alpha`/g1 (mixer `0x1e8baed5`), same `chainId 1`. The mixer
address rotates per generation; the asset id does not. The confidential pool is simply the next generation
under the same id. So "same etch id" is the established pattern, not a new mechanism.

## How the id carries over (the contract model)
The pool holds two ids:
- **shared id** = `crossChainLink` (the Bitcoin-side asset id, `3cba71e1…`) — the cross-chain handle the
  dapp/registry/bridge key on. `localAssetOf[crossChainLink] = localAssetId` resolves it on the pool.
- **local EVM id** = `sha256("tacit-evm-token-v1", chainId, underlying)` — the pool's internal handle
  (chain-specific; identical to a prior deploy only on the same chain + same underlying).

`crossChainLink` is set **only** by the guest-proven `attest_meta` path (`_autoRegisterFromMeta`) — never
by a manual `registerMinted`/`registerWrapped` (the ctor leaves the link 0; `registerWrapped` with a link
reverts `CrossChainEscrow`). The guest proves the etch metadata against the attested Bitcoin state, then
the pool lazily deploys the canonical ERC20 (committed to `ASSET_ID() == 3cba71e1…`) via
`CanonicalAssetFactory` and binds `localAssetOf[3cba71e1…]`. First-write-wins per pool, so a fresh pool
claims the id cleanly.

## Prerequisites
1. **Network match.** The etch's Bitcoin network must equal the pool's reflected Bitcoin network. tETH is
   on Bitcoin **mainnet** (relay genesis BTC 952127, `chainId 1`), so onboarding the real `3cba71e1…`
   needs the **mainnet confidential pool reflecting Bitcoin mainnet**. The Sepolia/signet pilot reflects
   signet and cannot reflect the mainnet etch — on the pilot, tETH would be a separate signet-test etch
   (or simply omitted; cETH stands alone there).
2. **`CANONICAL_FACTORY` wired** (the pilot already uses `0x631c77ce…`); `_autoRegisterFromMeta` no-ops on a
   zero factory.
3. **The tETH etch reflected** into `knownBitcoinRoot` — the reflection batch must cover the etch's block,
   confirmation-gated (B6), before `attest_meta` will accept it.

## Steps (for the mainnet confidential deployment)
1. Deploy the mainnet confidential pool reflecting Bitcoin mainnet — near-tip genesis anchor + continuous
   attest (the launch rule in `RUNBOOK-confidential-pool-deploy.md`), `CANONICAL_FACTORY` wired, same frozen
   vkeys.
2. Stand up the mainnet reflection loop (eth_prove → bitcoin_prove → attest) so the Bitcoin pool root is
   canonical and current.
3. Reflect the block carrying the tETH etch (so it lands in `knownBitcoinRoot`).
4. Run `OP_ATTEST_META` for tETH → `_autoRegisterFromMeta` registers it, lazy-deploys the canonical tETH
   ERC20 (`ASSET_ID == 3cba71e1…`), and sets `localAssetOf[3cba71e1…]`. tETH is now a confidential asset
   under its original id.
5. Wrap/bridge tETH into the confidential lane; holders migrate from the old mixer at their own pace.

## Migration / deprecation
The old mixer (`0x6929acf0` / `0x1e8baed5`) keeps minting/holding under `3cba71e1…` until drained; the
confidential pool serves the same id going forward. No new etch, no id break. The mixer's relay is off the
advance schedule (manual-dispatch only) — it doesn't need liveness once deprecated.

## Pilot note (now)
The Sepolia pilot stays cETH-only. tETH onboarding is a mainnet-confidential-deployment task — staged here
so the id (`3cba71e1…`) and the `attest_meta` path are ready when that deploy happens.
