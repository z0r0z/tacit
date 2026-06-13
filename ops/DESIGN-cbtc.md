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

## 2. The peg + fungibility — oracle-free real BTC, made fungible by the aggregate backing

1 cBTC = real BTC, **in aggregate**. `fold_cbtc_lock` proves each confirmed lock of value `v_btc` and that
the cBTC note opens to exactly `v_cbtc == v_btc` (conservation, BP+ range). **No price, no oracle** touches
the peg — it *is* BTC.

**Fungibility is produced by the collateralization, not free.** A raw self-custody lock is non-fungible
(tied to one locker's UTXO, ruggable by them, redeemable only by them). cBTC is fungible because the notes
are the same asset *and* every unit is backed by the **aggregate** pool of all live locks
(`cbtcBackingSats` = Σ live outpoints) **insured by the buffer (§4)** — so no holder is exposed to which
specific, ruggable lock backs their unit. `cbtcBackingSats` + the buffer are therefore **core machinery**,
not a free side-effect of "it's an asset."

**Redemption is an atomic cBTC↔BTC swap**, not a holder unlocking a stranger's lock: a redeeming holder is
matched with an *exiting locker* and the cBTC burn ⇄ BTC unlock are bound by the adaptor primitive — a hard,
trustless, 1:1 peg with no custodian or mediator. See `DESIGN-cbtc-redemption.md` (it reuses the built
adaptor-swap + cross-chain-orderbook stack).

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
- **Coverage:** the locker posts a **tETH over-collateralization buffer** at mint. The buffer is a
  **passive reserve**: its **BTC-equivalent value (Chainlink ETH/BTC-priced) counts toward backing**, so a
  detected shortfall is absorbed by that value (`uncoveredShortfall` stays 0 while the buffer ≥ the gap),
  not by an on-chain buyback. tETH and cBTC are Tacit-native — they trade only in the confidential, async
  AMM, so there is **no synchronous DEX to liquidate into**; the tETH→BTC conversion happens only when a
  holder **redeems**, through the existing async cBTC↔BTC swap. The buffer ≥ the cBTC value still makes
  rugging unprofitable (the locker loses the buffer ≥ what they'd gain).
- **Chainlink (buffer only):** values the tETH against the BTC it insures; a **decentralized quorum, not a
  hot key**, with an optional shielded-pool AMM-TWAP sanity bound. An oracle failure mis-sizes the *buffer*
  (a loss only if a rug *also* happens — second-order), never the peg.

## 5. The contracts (Ethereum — the buffer + liquidation; the `InsuranceVault` evolved)

- **`CbtcBuffer`** (Solady `Ownable` → DAO): a **passive tETH reserve**. It escrows tETH and exposes its
  **BTC-equivalent value** at the validated Chainlink mark (`bufferBtcValueSats`) plus the residual
  `uncoveredShortfall` (= `pegShortfall` − that value) — the true peg-solvency signal. **No synchronous
  swap or router** (Tacit-native assets have no on-chain DEX); conversions ride the async redemption path,
  and tETH is released to honor a redemption by the owner/DAO (or a later authorized redemption module).
  Owner-set, fail-closed feed config: the Chainlink feed + the AMM-TWAP deviation bound + staleness, and the
  buffer ratio (over-collateralization, DAO-tunable within hard bounds). **Bounded:** the owner sizes the
  reserve + the feeds, never mints cBTC, moves the BTC, or breaks the peg. (Evolves `InsuranceVault` to
  tETH + Chainlink, passive — not a (TAC,tETH) buy-and-cover bond.)
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

## 9. Launch seam — cBTC scaffolds onto v1 with no redeploy

cBTC's entire **immutable** footprint lives in the `ConfidentialPool` deployment's **vkeys + public-values
layout** — and it is **already built and proven**, so a v1 pool can carry it dormant and turn cBTC on later
with **zero redeploy**.

**Already in the immutable surface (built + proven):**
- **Reflection guest** (`BITCOIN_RELAY_VKEY 0x005e6adc`): `fold_cbtc_lock` (`0x66` → accrue
  `cbtc_backing_sats`, self-custody), `fold_cbtc_lock_spends` (rug), `cbtcBackingSats` in
  `BitcoinReflectionPublicValues`, bound into the resume digest.
- **Settle guest** (`PROGRAM_VKEY 0x00d5b572`): nothing cBTC-specific — a minted cBTC note is a normal pool note.
- **Contract**: the 10th PV field `cbtcBackingSats`, `knownCbtcBackingSats` + the `cbtcBackingSats()` view,
  `REFLECTION_GENESIS_DIGEST 0x164ac1b2`. It rides the Bitcoin reflection (`HEADER_RELAY`) the pool runs for
  TAC anyway.

**The one finalize decision:** deploy the v1 `ConfidentialPool` on the **cBTC-aware vkeys**
(`0x00d5b572` / `0x005e6adc`) + this contract source. At launch there are no `0x66` locks →
`cbtcBackingSats()` returns 0 → the cBTC path is **inert but present** (nothing to fold, conservation still
enforced, one zero field per proof). Launch with TAC + tETH; cBTC waits in the immutable surface.

**Additive later — no redeploy:** the cBTC canonical asset (pool lock-mint), `CbtcBuffer` (reads
`cbtcBackingSats()` externally), the live lock-fold indexer + worker scan + lock-creation UX (the
digest-state mirror exists; the live fold is the build), the async redemption plumbing.

**The line to hold:** if v1 deploys on a **cBTC-less reflection vkey**, adding cBTC later = a reflection-guest
change → new `BITCOIN_RELAY_VKEY` → full pool redeploy + migration. The vkey is already proven and the seam
already in source, so deploying v1 on the cBTC-aware vkey costs nothing now and saves the redeploy. (Same
discipline as the cUSD `CUsdController` minter-seam.)

**cBTC.tac (synthetic) is separate:** transparent = a CDP vault behind the cUSD minter-controller (pure
Ethereum, anytime); confidential = a future settle re-prove. Neither rides the v1 pool's immutable surface.

## 10. Build plan
- **Reflection guest — DONE + PROVEN** (`BITCOIN_RELAY_VKEY 0x005e6adc`, re-prove `ef0c514`): `fold_cbtc_lock`
  reworked to the **self-custody** binding (no `CBTC_VAULT_SPK`, tracks the lock outpoint) + emits
  **`cbtcBackingSats`**; `fold_cbtc_lock_spends` (rug); `CBTC_ZK_ASSET_ID` pinned. JS digest-state mirror synced.
- **Contract seam — DONE in source:** the `cbtcBackingSats` PV field + `cbtcBackingSats()` view + the genesis
  digest. Activates by deploying v1 on the cBTC-aware vkeys (§9).
- **`CbtcBuffer` — DONE** (passive tETH reserve, Chainlink-valued, 11 forge green): `bufferBtcValueSats` +
  `uncoveredShortfall`; no router (the synchronous-DEX path was retired).
- **Remaining (additive, no re-prove):** the cBTC canonical ERC20 wiring; the live lock-fold indexer + worker
  scan + lock-creation UX (the JS digest state exists, the live fold is the build); the async redemption plumbing.
- **Settle guest:** untouched. The §5/bond guest primitives stay parked (no longer cBTC's path).
