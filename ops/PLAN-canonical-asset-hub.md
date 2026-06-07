# PLAN — Canonical asset hub (mint/burn ERC20 factory ⇄ confidential pool ⇄ Bitcoin)

The endgame of asset abstraction: **every asset has one canonical Ethereum ERC20
and one confidential form, on both chains.** A CREATE2 factory mints/burns canonical
ERC20s for Tacit-native (and synthetic) assets; the `ConfidentialPool` makes any
ERC20 confidential; the bridge + reflection span Bitcoin. Public *or* private,
Ethereum *or* Bitcoin — same asset, one canonical representation.

This **supersedes the Tier-A factory** (`TacitConfidentialFactory` +
`TacitConfidentialERC20`/`Etched`): those are per-token *confidential* tokens on the
denominated ladder, conflating ERC20 + confidentiality + denominations. The Tier-B
split is cleaner — the factory makes **plain public ERC20s**, the singleton pool adds
confidentiality, and arbitrary amounts retire the ladder.

## The two faces of one canonical asset

```
                 ┌──────────── canonical ERC20 (CREATE2) ───────────┐
   mint/burn ◄───┤  plain ERC20: address = f(assetId), no fragments │
   (bridge or    │  • PUBLIC: trade on Uniswap / any DEX            │
    collateral)  │  • CONFIDENTIAL: wrap → ConfidentialPool note    │
                 └──────────────────────────────────────────────────┘
```

- **Public face:** the canonical ERC20 trades normally (Uniswap, etc.).
- **Confidential face:** `pool.wrap(canonicalErc20, …)` → a hidden-amount note in the
  singleton multi-asset pool; `unwrap` returns the ERC20. The wrap/unwrap boundary is
  public (standard shielded-pool entry/exit); holdings + transfers inside are private.

Separation of concerns: the factory owns **canonical issuance**; the pool owns
**confidentiality**. One asset, two faces, no fragmentation.

## Direction 1 — Tacit-native assets onto Ethereum (TAC, etc.)

A Tacit-native token (TAC) has no Ethereum ERC20. The factory deploys its canonical
ERC20 at a deterministic CREATE2 address (`salt = assetId`, fixed initcode → the
address *is* the asset id), with **mint/burn gated by the bridge**:
- **mint** requires a proof that the matching TAC was locked/burned on Bitcoin (the
  SP1 + `BitcoinLightRelay` stack already live for tETH, reversed direction).
- **burn** releases the Bitcoin-side TAC.
The factory is the *only* minter → supply ≤ Bitcoin-locked TAC (the tETH mint-only
reserve discipline). Then: trade public, or wrap confidential.

## Direction 2 — Ethereum-origin assets spanning Bitcoin (USDC, etc.)

An existing ERC20 needs no factory: `pool.registerWrapped(usdc, …)` makes it a
confidential pool asset today. To *span Bitcoin*, **etch** a Bitcoin Tacit metatoken
bound to it; the binding is **consensus-by-derivation**, not a trusted registry — the
CREATE2 address is `f(assetId)` and `crossChainLink` is deterministic, so every
indexer computes the identical Ethereum↔Bitcoin binding. (The "indexer consensus" is
just agreement on a derivation, no vote.)

## Direction 3 — BTC on Ethereum via Tacit-native collateral (cBTC)

*(the follow-up: "escrow using TAC or tETH collateral for BTC → confidential BTC
settlement on Ethereum + export as ERC20")*

A canonical **cBTC ERC20** minted against **TAC/tETH collateral** (the cBTC.tac
strategy: a risk-priced (TAC, tETH) LP bond, governable IL-aware ratio) gives BTC an
Ethereum presence **without real-BTC custody on Ethereum**:
- **Confidential BTC settlement on Ethereum:** wrap cBTC into the pool → hidden-amount
  BTC notes, transfer/swap privately.
- **Public BTC liquidity:** trade the cBTC ERC20 on Uniswap.
- Backed by Tacit-native collateral, not a custodial BTC bridge — the peg is the
  collateral + the governable ratio.

Two cBTC flavors, both canonical ERC20s in this hub:
- **cBTC.tac** — collateralized/synthetic (TAC/tETH). Peg = collateral health
  (a governable DeFi risk). Permissionless, no real-BTC custody.
- **cBTC.zk** — real-BTC-backed (the bridge holds BTC). Stronger backing, custodial.

So BTC becomes confidentially settleable + publicly tradeable on Ethereum, the
collateralized path needing no BTC bridge at all.

## Soundness (honest flags)

- **Mint is bridge/collateral-gated; the factory is the sole minter** → no inflation.
  Canonical ERC20 supply ≤ backing (Bitcoin-locked, or collateral value × ratio).
- **Public↔confidential boundary leaks** (wrap/unwrap are public txs with public
  amounts). Privacy is for in-pool holdings/transfers; entry/exit are observable —
  standard shielded-pool property.
- **cBTC.tac is collateralized** (peg risk under collateral stress, governable) —
  distinct from real-BTC cBTC.zk. Label clearly; don't conflate.
- **CREATE2 canonicality** needs a fixed ERC20 initcode + `salt = assetId`; the
  template is immutable so the address is purely the asset's identity.
- Reuses the live bridge stack (`BitcoinLightRelay`, SP1 verification, mint-only
  reserve) for mint gating — no new ceremony, no new trust root.

## Build sketch

1. **`CanonicalAssetFactory`** (CREATE2): `deployCanonical(assetId, meta) → erc20` at
   `f(assetId)`; `predict(assetId)`; one canonical ERC20 per asset, dedup-guarded.
2. **`CanonicalBridgedERC20`** (the template): a plain ERC20 whose `mint`/`burn` are
   gated by a `minter` = the bridge/collateral module (SP1 lock-proof for TAC; the
   cBTC collateral vault for cBTC.tac; the real-BTC bridge for cBTC.zk).
3. **Pool integration:** `registerWrapped(canonicalErc20, unitScale, crossChainLink,
   …)` (exists) → wrap/unwrap for the confidential face (exists).
4. **Etch + binding** for Ethereum-origin assets (Direction 2): the deterministic
   crossChainLink + the Bitcoin etch; indexer derives, doesn't vote.

Net: the `ConfidentialPool` + a canonical mint/burn factory = the asset hub. The
pool (built) is the confidential face; the factory (to build) is the canonical public
face; the bridge/reflection (built/in progress) span Bitcoin. The Tier-A factory is
retired in favor of this split.
