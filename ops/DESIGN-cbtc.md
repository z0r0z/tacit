# DESIGN — cBTC: real-BTC primary + native-ETH escrow + Chainlink (the architecture of record)

> **STATUS: the cBTC architecture of record.** cBTC tokenizes **real Bitcoin** — backed primarily by
> **self-custody BTC locks** (reflection-proven, no custodian), with a **per-lock native-ETH escrow**
> (Chainlink ETH/BTC-priced) as the rug-insurance. The peg is **oracle-free** (1 cBTC = real
> locked BTC, conservation); Chainlink prices only the **escrow**, so an oracle failure can mis-size the
> insurance but **cannot de-peg the asset.** Covenant-upgradeable to zero-escrow, zero-oracle, 1× trustless.
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
> reflection), and demotes the oracle from "the peg" to "the escrow" (second-order risk).

## What cBTC.zk is — and is not

cBTC.zk is a **trustless cross-chain bridge / tokenization primitive** — the only mechanism that turns
real, self-custodied BTC into a fungible confidential-DeFi asset (cBTC) without a custodian, federation, or
price oracle. Its job is the **commitment + proof**: a Bitcoin Taproot lock (`K_btc = r_leaf·G`, `0x66`
envelope), proven to Ethereum by SP1 reflection (header PoW + merkle inclusion via `BitcoinLightRelay` +
Taproot-witness parse), minting cBTC 1:1 under one canonical asset id, conservation-pegged (oracle-free).

It is **not** a privacy primitive and **not** a payment primitive:

- **Not a privacy primitive.** The lock is *transparent and attributable*: public amount, publicly tagged a
  cBTC lock, funded by visible wallet inputs (normal Bitcoin traceability). The fresh output key only avoids
  address reuse; it hides neither the amount nor the funding wallet. **All amount privacy / unlinkability
  lives in the shielded pool note** — free to any pool asset, not specific to cBTC. Privacy begins *after*
  the mint, exactly like a Zcash t→z deposit.
- **Not a payment primitive.** L1 recipient privacy is **silent payments**; L1 unlinkable fixed-denom
  payments are the **mixer** (zk membership + nullifier). A pure-L1 "lock + share `r_leaf` + sweep" scheme
  is *not* a payment: the sweep spends the lock UTXO (an explicit on-chain link — no anon set), and the
  sender retains `r_leaf` (can reclaim/race). Value is transferred by moving the **cBTC note** in the pool,
  not by sharing the lock secret (a bare lock spend is a *rug*, not a transfer).

What cBTC delivers once minted: one fungible asset usable across the **single unified AMM** (Ethereum
directly; the "Bitcoin AMM" is the same pool reached by reflection, not a second AMM), as **CDP collateral**
(mint cUSD), in farms, and as a confidential transfer/payment unit — with amounts hidden by the pool. The
public ERC20 form (`cBTC.tac`/tacBTC) is the same asset for transparent composability, minted by the pool on
exit. **Privacy = the pool; payments = silent payments / mixer; cBTC.zk = the trustless real-BTC bridge.**
Cutting it costs no privacy and no payments — its sole, non-overlapping value is *trustless real BTC in
confidential DeFi*.

## 1. The model

```
locker self-custodies BTC  ──lock + 0x66 commit (their own tx)──▶  reflection proves it (fold_cbtc_lock)
        │                                                                   │  conservation: v_cbtc == v_btc
        │  + posts a native-ETH escrow (Chainlink-priced, per-lock)         ▼
        └────────────────────────────────────────────────────▶  mint cBTC 1:1 (confidential, in the pool)
                                                                            │
   redeem: burn cBTC ─▶ unlock BTC 1:1 + reclaim escrow                     │  cBTC = a Tacit asset:
   RUG: locker spends the lock ─▶ reflection proves it ─▶ escrow            │   confidential / bridge to BTC /
        slashed to the reserve ─▶ async buy-and-burn of the cBTC            ▼   export as canonical ERC20
```

## 2. The peg + fungibility — oracle-free real BTC, made fungible by the aggregate backing

1 cBTC = real BTC, **in aggregate**. `fold_cbtc_lock` proves each confirmed lock of value `v_btc` and that
the cBTC note opens to exactly `v_cbtc == v_btc` (conservation, BP+ range). **No price, no oracle** touches
the peg — it *is* BTC.

**Fungibility is produced by the collateralization, not free.** A raw self-custody lock is non-fungible
(tied to one locker's UTXO, ruggable by them, redeemable only by them). cBTC is fungible because the notes
are the same asset *and* every unit is backed by the **aggregate** pool of all live locks
(`cbtcBackingSats` = Σ live outpoints) **insured by the per-lock escrow (§4)** — so no holder is exposed to
which specific, ruggable lock backs their unit. `cbtcBackingSats` + the escrow are therefore **core
machinery**, not a free side-effect of "it's an asset."

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

## 4. The rug + the native-ETH escrow (where ETH/Chainlink earn their place)

Because the locker self-custodies, they can spend the lock and reclaim the BTC after minting/selling cBTC —
a rug. Detected and covered, not prevented (pre-covenant):
- **Detection:** the reflection tracks the lock outpoint; a spend without a matching cBTC burn surfaces as
  **`cbtcLockSpent`** (an honest in-tx redeem surfaces as `cbtcLockRedeemed` instead — mutually exclusive),
  and the attested `cbtcBackingSats` drops below the cBTC supply.
- **Escrow (per-lock, native ETH):** at mint the locker posts a refundable native-ETH escrow keyed by the
  Bitcoin lock outpoint, `≥ escrowRatio · ETH(v_btc)` (Chainlink ETH/BTC-priced; 1.5× default). It is **rug
  insurance, not backing** — it does **not** count toward `cbtcBackingSats`; the real BTC is the backing.
- **Coverage on a rug:** on a proven `cbtcLockSpent` (∧ minted), **anyone permissionlessly `slash`es the
  whole escrow to the shared `insuranceReserve`** — no owner in the path. The reserve then funds an **async
  cBTC buy-and-burn** to retire the orphaned cBTC (owner/DAO `drawInsuranceFor`; async because a Tacit-native
  asset has no synchronous DEX to buy on). Escrow ≥ 1.5× makes rugging unprofitable (the locker forfeits
  escrow worth more than the BTC they'd reclaim).
- **Honest redeem:** each funder **permissionlessly reclaims** its escrow share (`claimEscrow`) once the
  reflection proves the redemption.
- **Chainlink (escrow only):** sizes the escrow against the BTC it insures, at mint; a **decentralized
  quorum, not a hot key**, with an optional shielded-pool AMM-TWAP deviation bound. An oracle failure
  mis-sizes the *escrow* (a loss only if a rug *also* happens — second-order), never the peg.
- **Margin call (dormant seam):** the escrow is sized once at mint and not re-margined, so a sustained
  ETH/BTC move can erode coverage on an open lock. A governance-gated escrow-health margin call ships
  **dormant** in the engine (activate post-launch); see `DESIGN-cbtc-escrow-health-module.md`.

## 5. The contracts (Ethereum — `CollateralEngine`: escrow + reserve + cUSD controller)

- **`CollateralEngine`** (Solady `Ownable` → DAO): the unified escrow + reserve + cUSD CDP controller
  (supersedes the `CbtcBuffer` / `InsuranceVault` exploration). For cBTC it:
  - holds the **per-lock native-ETH escrow** (`escrowOf` / `escrowTotal`, per-funder shares) and answers the
    pool's mint gate via `escrowSufficient(outpoint, v_btc)` (read-only — the engine never moves backing);
  - lets each funder **permissionlessly `claimEscrow`** on a proven honest redeem (or before any mint), and
    **anyone permissionlessly `slash`** a proven rug's escrow to the shared `insuranceReserve` — no owner in
    either path;
  - lets the owner/DAO draw the reserve (`drawInsurance` / `drawInsuranceFor`) to fund the async rug
    buy-and-burn or a recognized CDP bad-debt shortfall;
  - carries the **dormant escrow-health margin-call seam** (`setEscrowHealthParams` /
    `setEscrowEnforcementModule`, inert at launch — see `DESIGN-cbtc-escrow-health-module.md`);
  - is **also the cUSD CDP controller** (Chainlink BTC/USD) — the same engine, one shared reserve.

  Owner-set, fail-closed feed config (Chainlink + AMM-TWAP deviation bound + staleness) and DAO-tunable
  ratios within hard bounds. **Bounded:** the owner sizes the escrow/reserve + feeds, never mints cBTC,
  moves the BTC, or breaks the peg.
- **`cBTC`:** a canonical Tacit asset, minted only against a proven lock (the pool, gated on
  `escrowSufficient`), confidential in the shielded pool, bridgeable to Bitcoin, exportable as a public
  ERC20 (`cBTC.tac`) — chain-abstracted like any asset.
- The core `ConfidentialPool` stays immutable + admin-free; the cBTC additions are the read-only
  `cbtcBackingSats()` view the reflection feeds and the mint gate's `escrowSufficient` call into the engine.

## 6. Trust ledger
| Concern | Mechanism | Trust |
|---|---|---|
| cBTC = real BTC (peg) | `fold_cbtc_lock` conservation, 1:1 | **none** (proof) — no oracle |
| No double-mint | lock single-use + conservation | **none** (proof) |
| No custodian holds the BTC | self-custody (locker's keys) | **none** |
| Rug (locker reclaims) | reflection-detected + native-ETH escrow slashed to reserve → async buy-and-burn | **economic, bounded** (escrow ≥ 1.5× BTC) |
| Escrow sizing | Chainlink ETH/BTC (quorum) + AMM-TWAP bound | **soft, 2nd-order** (mis-size ≠ de-peg) |

**No Bitcoin custodial key. No hot oracle key. No novel Bitcoin crypto in the launch path.** The peg is real
BTC; the only trust is a bounded escrow + a decentralized oracle, both on mature, auditable Ethereum.

## 7. Honest tradeoffs
- **Capital:** real BTC **and** a native-ETH escrow → over-collateralized (>1×). The price of trustless-ish
  real BTC pre-covenant: you post collateral to deter/cover the self-custody rug.
- **Second-order oracle + basis risk:** a Chainlink failure *and* a simultaneous rug → under-covered; and
  because the escrow is sized once at mint (not re-margined), a sustained ETH/BTC decline on an open lock can
  erode coverage. Mitigated by a conservative escrow ratio, the AMM-TWAP bound, per-epoch governance bounds,
  the shared reserve backstop, and the dormant escrow-health margin call (`DESIGN-cbtc-escrow-health-module.md`).
- **Rug-detection latency:** the reflection must see a spent lock promptly; size the escrow + reserve for the
  detection window.

## 8. Covenant endgame
A covenant (CTV/OP_VAULT) makes the self-custody lock **spend-only-into-redemption** → the rug becomes
impossible → **the escrow + Chainlink fall away** → cBTC is 1× real BTC, fully trustless, zero oracle. The
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

**Additive later — no redeploy:** the cBTC canonical asset (pool lock-mint), the `CollateralEngine` (the
per-lock escrow gate + shared reserve + cUSD controller, deployed alongside the pool), the live lock-fold
indexer + worker scan + lock-creation UX (the digest-state mirror exists; the live fold is the build), the
async redemption plumbing.

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
- **`CollateralEngine` — DONE** (per-lock native-ETH escrow + shared reserve + cUSD CDP controller,
  Chainlink-priced, 56 forge green): the `escrowSufficient` mint gate, permissionless `claimEscrow` /
  `slash`→reserve, owner `drawInsurance` for the async buy-and-burn, and the dormant escrow-health
  margin-call seam (`DESIGN-cbtc-escrow-health-module.md`).
- **Remaining (additive, no re-prove):** the cBTC canonical ERC20 wiring; the live lock-fold indexer + worker
  scan + lock-creation UX (the JS digest state exists, the live fold is the build); the async redemption plumbing.
- **Settle guest:** untouched. The §5/bond guest primitives stay parked (no longer cBTC's path).
