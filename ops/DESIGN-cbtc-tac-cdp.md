# DESIGN — cBTC.tac: (TAC, tETH)-collateralized synthetic CDP on Ethereum (DEPRECATED)

> **STATUS: DEPRECATED 2026-06-15.** The canonical cBTC.tac design is the real-BTC oracle-free peg in
> [`DESIGN-cbtc-tac.md`](./DESIGN-cbtc-tac.md) — cBTC.tac is a claim on **real BTC** locked via cBTC.zk
> (the backing), with the **tETH buffer (Chainlink-sized) as insurance, not the backing**. This
> (TAC, tETH) synthetic-CDP variant is **not the direction** — retained for reference / the covenant-era
> discussion only; do not build against it. Its "architecture of record / supersedes the real-BTC
> lock-claim" claims below are **reversed** by this decision. What follows describes the DEPRECATED design.
>
> cBTC.tac is a **synthetic BTC-pegged token**, minted
> against **(TAC, tETH) collateral** in a Maker-style CDP on **Ethereum** — mature, auditable contracts.
> **No Bitcoin custody key, no signing-key oracle, no novel Bitcoin crypto.** Supersedes the real-BTC
> lock-claim (`DESIGN-cbtc-tac.md`), which **parks for the covenant era**: pre-covenant there is no
> trustless way to custody real BTC (a custodial key is rejected; the adaptor-vault carries its own
> novel-crypto risk), so a synthetic that holds *no* BTC is the lower-trust choice now. `fold_cbtc_lock` +
> the cBTC.zk constants remain in cxfer-core for the future covenant-era trustless real-BTC variant.
>
> **The peg:** held by over-collateralization + liquidation + redemption arbitrage — the DAI/Maker model,
> retargeted from USD to BTC and collateralized by (TAC, tETH). This is the *prior* cBTC.tac bond design
> (`project_cbtc_tac_collateral_strategy`), realized as a clean Ethereum contract with governance-set
> parameters instead of a guest oracle.

## 1. The model

```
deposit (TAC, tETH) collateral ─▶ open a CDP position ─▶ mint cBTC.tac up to collateralValueBtc / MIN_RATIO
        │                                                         │
        │  governance-set refs value the collateral in BTC        │  cBTC.tac is a normal ERC20 (+ Tacit asset)
        ▼                                                         ▼
   under-collateralized? ─▶ permissionless LIQUIDATION            redeem: burn cBTC.tac ─▶ draw collateral at ref
   (sell collateral, cover the cBTC.tac, liquidator bonus)        (arbitrage pins cBTC.tac ≈ BTC)
```

**No reserves of real BTC. No custody.** The token tracks BTC because every unit is over-collateralized by
(TAC, tETH) worth more than 1 BTC, and liquidation + redemption arbitrage keep it pinned.

## 2. Collateral + valuation (where the "oracle" is, and why it's safe)

- **Collateral:** the canonical **cTAC** + **tETH** ERC20s (or their LP). **tETH is exogenous** (real ETH,
  breaks TAC-reflexivity, the primary safety leg); **TAC is capped** (a bounded bootstrap leg, never the
  sole backing — the death-spiral the prior design removed stays removed).
- **Valuation:** `collateralValueBtc = tac·satsPerTac + teth·satsPerTeth`, where `satsPerTac` / `satsPerTeth`
  are **TAC-governance-set, on-chain, periodic, per-epoch-bounded** parameters — **not a hot signing key**.
  Governance is slow, transparent, and **bounded**: it can mis-size the refs (→ slightly mis-collateralized,
  contained by the over-collateralization + liquidation) but **cannot mint cBTC.tac or seize collateral**
  (the contract logic forbids it). This is the governance mechanism already endorsed.
- **Optional hardening (no contract change):** governance ratifies a ref that the contract *also* bounds
  against the on-chain (TAC, tETH) AMM reserves (the trustless ratio) — so a governance error can't deviate
  far from market. A later, fully-trustless option folds the AMM-TWAP in directly.

## 3. The contracts (Ethereum, Solady, governance-owned)

- **`CbtcTacCdp`** — the vault: `open` / `deposit` / `mint` / `burn` / `withdraw` per position; enforces
  `minted · MIN_RATIO ≤ collateralValueBtc` on mint/withdraw. Mints/burns the cBTC.tac ERC20 (it is the
  minter). `Ownable` → DAO; owner-set `satsPerTac`, `satsPerTeth`, `MIN_RATIO`, `LIQ_RATIO`, per-epoch move
  caps, debt ceiling.
- **Liquidation:** permissionless `liquidate(position)` when `collateralValueBtc < minted · LIQ_RATIO` —
  routes the collateral through an injected router (the `IInsuranceRouter` pattern, reused) to acquire +
  burn the position's cBTC.tac, paying the liquidator a bonus; closes/decrements the position. Asset-settled
  to avoid AMM dumping where possible.
- **Redemption:** `redeem(cBTC.tac)` draws collateral from the *least*-collateralized positions at the ref
  price — the arbitrage that hard-pins cBTC.tac to BTC. (Maker-style; can ship after the mint/liquidate core.)
- **`cBTC.tac` ERC20:** a canonical/Tacit asset, minted only by `CbtcTacCdp`. Tradeable on Ethereum AND
  bridgeable/usable as any Tacit asset (chain-abstracted) — the synthetic is fungible by construction.

## 4. Trust ledger
| Concern | Mechanism | Trust |
|---|---|---|
| cBTC.tac is backed | (TAC, tETH) over-collateralization + liquidation | **collateral sufficiency** (economic) |
| No mint-from-nothing | CDP ratio enforced on-chain | **none** (contract) |
| Collateral valuation | governance-set refs, periodic, per-epoch-bounded | **soft + bounded** (can't mint/seize) |
| No real-BTC custody | there is none — synthetic | **n/a** |

**No custodial key. No hot oracle key. No novel Bitcoin crypto.** The residual trust is *economic*
(is the collateral worth enough — bounded by over-collateralization + liquidation) + *bounded governance*
(the refs/ratios) — both well-understood, both on mature Ethereum contracts.

## 5. The honest tradeoff + the endgame
- **Tradeoff:** cBTC.tac is a **synthetic** — it tracks BTC via collateral + peg mechanics, it is **not
  redeemable for real BTC**. Its solvency is economic (a sharp crash that outruns liquidation is the CDP
  risk class — mitigated by tETH-primary, capped TAC, conservative ratios, bounded governance, an insurance
  floor; never fully eliminated, as for any CDP).
- **Endgame:** when Bitcoin gets **covenants**, the trustless real-BTC **cBTC.zk** (lock-claim, no custody
  key) ships alongside — and cBTC.tac can be backed by it, or users pick real-BTC (cBTC.zk) vs
  synthetic-fungible (cBTC.tac). The parked lock-claim work (`fold_cbtc_lock`, the cBTC.zk constants) is
  exactly that future path.

## 6. Build plan
1. **`CbtcTacCdp` contract** (Solady `Ownable`): positions, `mint`/`burn` against the ratio, governance-set
   refs/ratios with per-epoch caps, `liquidate` (reuse the router pattern), + forge tests. **No re-prove,
   no guest, no Bitcoin custody** — pure Ethereum, deployable independently.
2. The cBTC.tac canonical ERC20 (exists for any asset) wired with the CDP as minter.
3. `redeem` (the hard-peg arbitrage) — after the mint/liquidate core.
4. DAO: `Ownable` → Governor (cTAC) later.
Nothing here touches the settle/reflection guests or the immutable `ConfidentialPool`. cBTC.tac becomes a
self-contained Ethereum CDP, governance-managed, with cBTC.zk (real BTC) as the covenant-era complement.
