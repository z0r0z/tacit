# DESIGN — cBTC: real-BTC primary + tETH buffer + Chainlink (the architecture of record)

> **STATUS: the cBTC architecture of record.** cBTC tokenizes **real Bitcoin** — backed primarily by
> **self-custody BTC locks** (reflection-proven, no custodian), with a **tETH over-collateralization
> buffer** (Chainlink ETH/BTC-priced) as the rug-insurance. The peg is **oracle-free** (1 cBTC = real
> locked BTC, conservation); Chainlink prices only the **buffer**, so an oracle failure can mis-size the
> insurance but **cannot de-peg the asset.** Covenant-upgradeable to zero-buffer, zero-oracle, 1× trustless.
>
> **Supersedes** the cBTC.tac exploration: `DESIGN-cbtc-tac.md` (lock-claim + insurance), `DESIGN-cbtc-tac-cdp.md`
> (pure ETH synthetic — rejected: no BTC = doesn't tokenize Bitcoin + discards Tacit's moat), and the §5/bond
> guest layer in `DESIGN-cbtc-tac-bond-guest.md`. **Builds on** `DESIGN-cbtc-sats-lock-reflection.md`
> (`fold_cbtc_lock`, reworked to self-custody below). The adaptor-vault in `DESIGN-cbtc-vault-custody.md`
> remains the documented covenant-era / fully-trustless redemption option.
>
> **Why this and not the ETH-only synthetic:** an ETH-collateralized BTC-pegged token holds **zero BTC** —
> it's price exposure, a commodity Maker-vault anyone can build, and the oracle *is* the peg (first-order
> de-peg risk). Real-BTC backing is the goal, is Tacit's unique capability (trustless tokenization via
> reflection), and demotes the oracle from "the peg" to "the buffer" (second-order risk).

## 1. The model

```
locker self-custodies BTC  ──lock + 0x66 commit (their own tx)──▶  reflection proves it (fold_cbtc_lock)
        │                                                                   │  conservation: v_cbtc == v_btc
        │  + posts a tETH buffer (Chainlink-priced over-collateralization)  ▼
        └────────────────────────────────────────────────────▶  mint cBTC 1:1 (confidential, in the pool)
                                                                            │
   redeem: burn cBTC ─▶ unlock BTC 1:1 + reclaim buffer                     │  cBTC = a Tacit asset:
   RUG: locker spends the lock ─▶ reflection sees backing drop ─▶ buffer    │   confidential / bridge to BTC /
        liquidated (Chainlink-priced) to buy+cover the cBTC                 ▼   export as canonical ERC20
```

## 2. The peg — oracle-free, real BTC

1 cBTC = the real BTC locked behind it. The reflection's `fold_cbtc_lock` proves a confirmed lock of value
`v_btc` and that the cBTC note opens to exactly `v_cbtc == v_btc` (conservation, BP+ range). Redemption
burns the cBTC and unlocks the sats 1:1. **No price, no oracle** touches the peg — it *is* BTC.

## 3. Self-custody (no custodian, no vault key)

The lock is the **locker's own output**, created in the same tx as the `0x66` commitment — so the locker
controls it (no protocol vault, **no `CBTC_VAULT_SPK` to pin or trust**). `fold_cbtc_lock` is reworked:
drop the `spk == CBTC_VAULT_SPK` check; keep the confirmed-output value, the conservation, and the
single-use outpoint, and bind the note to the lock outpoint so the reflection can **track** it. The locker
*can* reclaim their own BTC (it's their key) — that's the rug, handled by §4. No one but the locker ever
holds the coins.

## 4. The rug + the tETH buffer (where ETH/Chainlink earn their place)

Because the locker self-custodies, they can spend the lock and reclaim the BTC after minting/selling cBTC —
a rug. Detected and covered, not prevented (pre-covenant):
- **Detection:** the reflection tracks the lock outpoint; when it's spent without a matching cBTC burn, the
  attested **`cbtcBackingSats`** drops below the cBTC supply.
- **Coverage:** the locker posts a **tETH over-collateralization buffer** at mint. On a detected shortfall,
  the buffer is **liquidated** (sold, **Chainlink ETH/BTC-priced**) to buy + cover the now-unbacked cBTC,
  restoring supply ≤ backing. The buffer ≥ the cBTC value makes rugging unprofitable (the locker loses the
  buffer ≥ what they'd gain).
- **Chainlink (buffer only):** values the tETH against the BTC it insures; a **decentralized quorum, not a
  hot key**, with an optional shielded-pool AMM-TWAP sanity bound. An oracle failure mis-sizes the *buffer*
  (a loss only if a rug *also* happens — second-order), never the peg.

## 5. The contracts (Ethereum — the buffer + liquidation; the `InsuranceVault` evolved)

- **`CbtcBuffer`** (Solady `Ownable` → DAO): escrows the per-position **tETH** buffer; reads the
  reflection-attested `cbtcBackingSats` vs the cBTC supply; on a shortfall, **liquidates the buffer**
  (Chainlink-priced) via an injected router to buy + sequester/cover the cBTC. Owner-set, per-epoch-bounded
  params: the **buffer ratio** (over-collateralization, e.g. ≥100% of the insured value, a conservative
  market std, DAO-tunable within hard bounds), the Chainlink feed + the AMM-TWAP deviation bound, per-claim
  caps. **Bounded:** the owner sizes the buffer + the feed config, never mints cBTC, moves the BTC, or
  breaks the peg. (This is the `InsuranceVault` buy-and-cover, now tETH + Chainlink instead of a (TAC,tETH)
  bond.)
- **`cBTC` ERC20:** a canonical/Tacit asset, minted only against a proven lock (the pool), confidential in
  the shielded pool, bridgeable to Bitcoin, exportable as a public ERC20 — chain-abstracted like any asset.
- The core `ConfidentialPool` stays immutable + admin-free; the only addition is the read-only
  `cbtcBackingSats()` view the reflection feeds.

## 6. Trust ledger
| Concern | Mechanism | Trust |
|---|---|---|
| cBTC = real BTC (peg) | `fold_cbtc_lock` conservation, 1:1 | **none** (proof) — no oracle |
| No double-mint | lock single-use + conservation | **none** (proof) |
| No custodian holds the BTC | self-custody (locker's keys) | **none** |
| Rug (locker reclaims) | reflection-detected + tETH buffer covers it | **economic, bounded** (buffer ≥ cBTC) |
| Buffer valuation | Chainlink ETH/BTC (quorum) + AMM-TWAP bound | **soft, 2nd-order** (mis-size ≠ de-peg) |

**No Bitcoin custodial key. No hot oracle key. No novel Bitcoin crypto in the launch path.** The peg is real
BTC; the only trust is a bounded buffer + a decentralized oracle, both on mature, auditable Ethereum.

## 7. Honest tradeoffs
- **Capital:** real BTC **and** a tETH buffer → over-collateralized (>1×). The price of trustless-ish real
  BTC pre-covenant: you post collateral to deter/cover the self-custody rug.
- **Second-order oracle + crash risk:** a Chainlink failure *and* a simultaneous rug → under-covered; a
  crash faster than buffer liquidation → the standard CDP tail. Mitigated by conservative buffer ratios,
  the AMM-TWAP bound, per-epoch governance bounds, an insurance floor.
- **Rug-detection latency:** the reflection must see a spent lock promptly; size the buffer for the
  detection window.

## 8. Covenant endgame
A covenant (CTV/OP_VAULT) makes the self-custody lock **spend-only-into-redemption** → the rug becomes
impossible → **the buffer + Chainlink fall away** → cBTC is 1× real BTC, fully trustless, zero oracle. The
adaptor-vault (`DESIGN-cbtc-vault-custody.md`) is the pre-covenant trustless bridge if/when its crypto risk
is acceptable. This design is forward-compatible with both.

## 9. Build plan
- **Reflection guest (rides a re-prove — fine):** rework `fold_cbtc_lock` to the **self-custody** binding
  (drop `CBTC_VAULT_SPK`, track the lock outpoint) + emit **`cbtcBackingSats`** (sum of live cBTC.zk
  outpoints). `CBTC_ZK_ASSET_ID` already pinned.
- **Contracts (Ethereum, no re-prove, no core change):** `CbtcBuffer` (the evolved `InsuranceVault`: tETH
  buffer + Chainlink + liquidation) + the `cbtcBackingSats()` view + the cBTC canonical ERC20 wiring.
- **Done already / reused:** `fold_cbtc_lock` (to be reworked), `CBTC_ZK_ASSET_ID`, the `InsuranceVault`
  buy-and-cover pattern.
- **Settle guest:** untouched. The §5/bond guest primitives stay parked (no longer cBTC's path).
