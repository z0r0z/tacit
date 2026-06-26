# SPEC §5.52 Amendment — cBTC.tac Bond = (TAC, tETH) LP, Risk-Priced by a Governable Ratio (SUPERSEDED for V1)

> **STATUS: SUPERSEDED for V1 — RESERVED (Bitcoin-native / covenant-era).** This refines the
> §5.47 cBTC.tac *lien* bond, which V1 does not ship — V1's fungible cBTC is the real-BTC,
> oracle-free conservation peg (`ops/DESIGN-cbtc-tac.md`; `OP_CBTC_MINT`). Retained as part of the
> reserved Bitcoin-native lien design (`SPEC.md` §1.1 `0x49`–`0x4F`/`0x57`–`0x5A`); no live V1
> implementation. Original draft follows.
>
> **(original) STATUS: DRAFT** (2026-05-28). Redefines the §5.47 lien bond's pool
> from `(BTC-pegged, TAC)` to the canonical **(TAC, tETH)** AMM pool,
> and prices all of its risk through **one governable, IL-aware-floored
> over-collateralization ratio**. No new opcode; the §5.47 lien
> *mechanism* is unchanged. The cBTC.zk slot remains the self-custodied
> BTC *backing* — the bond is a separate, exogenous-leaning insurance
> overlay. **Supersedes the bond *composition* of §5.47 / §5.48 / §5.49**
> (which is foundation-only, not live).
>
> Companion to:
> - `SPEC-CBTC-TAC-AMENDMENT.md` §5.47 (lien mechanism — reused
>   verbatim) and §5.34–§5.46
> - `SPEC-LIQ-BID-AMENDMENT.md` (`0x5E` — liquidates the seized bond LP)
> - `SPEC-TETH-BRIDGE-AMENDMENT.md` (tETH; ships in V1 with the AMM)
>
> **The idea in one line.** The bond is a single, fungible, fee-bearing
> **(TAC, tETH) LP share** under lien; the market prices its *value*
> continuously, and a **governable over-collateralization ratio** prices
> its *risk* — collapsing weighting, segmentation, and BTC-anchoring
> into one tunable knob. This solves "TAC alone is weak BTC backing":
> TAC becomes a market-priced, ratio-governed, **half-exogenous** slice
> of the insurance overlay, on top of real-BTC slot backing — and gains
> a second value leg (governance) on top of being a bond component.
>
> **Trust profile.** Economic (MakerDAO-class), not cryptographic, on
> the bond leg — the same trust the base amendment already declares.
> The primary backing (the slot) is cryptographic; the bond is the
> over-collateralized rug-insurance.

---

## Motivation

§5.47 shipped the right bond *form* — a lien-locked, fee-bearing
LP-share — but composed it as `(BTC-pegged, TAC)`, which carried two
problems: a circular BTC-pegged leg (cBTC.tac backing cBTC.tac) and a
reflexive native-token leg (TAC). This amendment recomposes the bond as
**(TAC, tETH)**:

- **Non-circular** — no cBTC.tac in the bond.
- **Half-exogenous** — tETH (deep, BTC-correlated, unaffected by a
  Tacit-specific crisis) replaces the BTC-pegged leg; TAC remains for
  alignment + bootstrap demand.
- **Single homogeneous instrument** — one LP token, self-pricing,
  fee-bearing; no weighted pool, no value-weighted basket, no per-asset
  segmentation.
- **Simpler genesis** — no cBTC.tac is needed to form the bond, so the
  chicken-and-egg of "need cBTC.tac to mint the first cBTC.tac"
  disappears (§5.52.8).

The cost — impermanent loss in a one-sided TAC crash, and a fixed ~50%
TAC value-share — is priced entirely by the over-collateralization
ratio (§5.52.4), which governance tunes within a hard-bounded,
IL-aware band.

## §5.52.1 Relationship to §5.47 (what changes, what doesn't)

**Unchanged (reused verbatim):** the lien mechanism — the bond is an
LP-share UTXO in the depositor's wallet under a `commitmentForUtxo`
lien (§5.47.3); force-close / rug moves the lien to `ctac-claim-pool`
(§5.47.4); holders claim via `T_CTAC_LIEN_CLAIM` (`0x4C`, §5.47.5);
`T_CTAC_LIEN_SPLIT` (`0x4F`); fee yield accrues while bonded. No
covenant, no federation.

**Changed (supersedes §5.47/§5.48/§5.49 composition):**
- The bond pool is **(TAC, tETH)**, not `(BTC-pegged, TAC)`. **Neither
  leg is a BTC asset.**
- **BTC-anchoring drops from the bond.** §5.47.1's "the BTC-pegged half
  retains BTC value" rationale no longer applies — and doesn't need to:
  the **cBTC.zk slot is the real BTC backing** (§5.35.2). The bond is
  pure over-collateralized insurance, valued in BTC via oracle, with
  the ratio (not a BTC leg) covering its volatility.
- The shipped worker assumes the bond pool's non-TAC leg is the
  BTC-pegged value provider (`index.js:22156`); under this amendment it
  is tETH, valued via dual TWAP (§5.52.3). That is the implementation
  follow-up (§5.52.11).

## §5.52.2 The bond

The bond is an LP-share UTXO of the **canonical (TAC, tETH) AMM pool**,
held in the depositor's wallet under the §5.47 lien. It is fungible,
fee-bearing (earns the pool's swap fees as carry to the depositor while
bonded), and deepens the (TAC, tETH) pool by construction.

`T_CBTC_TAC_DEPOSIT` (§5.36) / `T_CBTC_TAC_DEPOSIT_ATOMIC` (§5.48) carry
`bond_pool_id` pointing at the canonical (TAC, tETH) pool. cBTC.tac
itself remains **one fungible asset** regardless of the bond
(§5.52.9).

## §5.52.3 Valuation — dual-TWAP fair-LP (reflects market, manipulation-resistant)

The bond LP's value, in BTC, is the manipulation-resistant fair-LP
value computed from **TWAP prices**, not spot reserves:

```
V_bond_BTC = 2 · √( R_TAC · R_tETH · P_TAC/BTC · P_tETH/BTC ) / S
```

where `R_*` are pool reserves, `S` is LP supply, and `P_TAC/BTC`,
`P_tETH/BTC` are TWAP prices. **Both come from existing data — no
dedicated tETH/BTC market is needed.** `P_TAC/BTC` is the canonical TAC
oracle (§5.40, blending the TAC/sats orderbook + AMM); `P_tETH/BTC` is
**triangulated through TAC**:

```
P_tETH/BTC  =  P_TAC/BTC      ×  P_(TAC per tETH)
               (TAC oracle)       ((TAC, tETH) pool's TWAP ratio)
```

A standard constant-product (TAC, tETH) pool plus the existing TAC
oracle suffice — no weighted pool, no separate tETH venue.

**Soundness.** Only the TAC/tETH ratio comes from the pool being
valued; the TAC/BTC anchor is independent. Substituting the pool ratio,
the fair-LP value reduces toward `2 × (TAC-leg priced by the external
TAC/BTC oracle)` — the independent oracle does the anchoring, and the
pool only asserts the two legs are ~equal value, which the TWAP window
+ CV gate + arbitrage make costly to fake. The §5.40 median-band /
CV>0.30 / stale gates apply to **both** legs; the AMM provides the
always-available price (liveness), orderbook fills a complementary
real-trade signal.

## §5.52.4 Risk-pricing — one governable, IL-aware-floored ratio

All bond risk is priced by a single over-collateralization ratio:

```
require V_bond_BTC ≥ BOND_RATIO × slot_denom_sats
```

`BOND_RATIO` is governable (Tier A) within a hard-bounded band. Because
a 50/50 (TAC, tETH) LP is (a) ~50% TAC by value and (b) subject to
impermanent loss in a one-sided TAC crash — the LP value scales as
`√(P_TAC · P_tETH)`, so a 99% TAC drop leaves ~10% of LP value vs ~50%
for a static basket — the ratio's **floor must be IL-aware**: high
enough that even after a severe IL drawdown the bond still covers the
insured BTC.

```
BOND_RATIO   default 2.5×   band [2.0×, 5.0×]   Tier A, governable
```

> **HARD RULES (extend §5.46.5):**
> - The band **floor is IL-aware** (≥ 2.0×) — governance may tune up
>   freely, down only to the floor. This is what converts the LP's
>   short-volatility (IL) profile into a safe insurance buffer.
> - **No price-keyed ratio.** `BOND_RATIO` keys on observed *risk*
>   (TWAP volatility, pool depth, realized IL), **never** on price
>   level — loosening the ratio because TAC/tETH is high is
>   pro-cyclical and is prohibited.

The market prices the bond's *value* (§5.52.3); `BOND_RATIO` prices its
*risk*. Together they make a 50% TAC, IL-exposed instrument into sound
insurance.

## §5.52.5 Caps — aggregate exposure vs pool depth

```
Σ bonded_BTC × P_TAC/BTC-equivalent ≤ MAX_POOL_FRAC × (TAC, tETH) pool depth
```

`MAX_POOL_FRAC` (default 0.10, band [0.05, 0.20]) caps total bonded BTC
as a fraction of the (TAC, tETH) pool's observable depth — dynamic, so
capacity grows as the pool deepens, and auto-pauses new deposits if the
cap would be exceeded (per §5.41.3). This replaces the earlier
per-asset / `MAX_TAC_LEG_FRAC` framing: there is now **one bond pool**,
so a single depth-keyed cap suffices.

## §5.52.6 Why this solves "TAC alone is weak BTC backing"

Four layers, in order of load:

1. **Primary backing = the cBTC.zk slot (real BTC, cryptographic).**
   TAC was never the BTC backing.
2. **The bond is only rug-insurance**, and it is now **half exogenous
   tETH** — a Tacit crisis no longer wipes 100% of it.
3. **The market prices TAC dynamically** inside the LP — TAC weakness
   shows up as lower LP value, which the ratio over-collateralizes for.
4. **`BOND_RATIO` (IL-aware floor) absorbs the residual** — whatever
   weakness/volatility/IL TAC contributes, the over-collateralization
   covers it, and governance can raise it as risk is observed.

So TAC's job shrinks from "back BTC" to "be a market-priced,
ratio-governed half of an over-collateralized insurance overlay on top
of real-BTC backing." That is a categorical de-risking.

## §5.52.7 TAC value accrual (now multi-legged)

TAC gains value from several roles, none of which require it to be the
sole/weak BTC backing:

- **Bond component** — every bond holds TAC (structural demand).
- **Governance** — TAC DAO tunes `BOND_RATIO` + caps within bands
  (§5.52.10); a real utility leg on top of the bond role.
- **AMM base pair + fees** — TAC is the canonical pairing/oracle asset
  (§5.40); the (TAC, tETH) bond pool itself accrues TAC fees.
- **Backstop reserve** — a pre-funded + fee-grown TAC reserve backstops
  aggregate shortfall (MKR-style; pre-funded, not dilution).

## §5.52.8 Genesis bootstrap (no circularity)

Unlike a `(cBTC.tac, *)` bond, a (TAC, tETH) bond contains **no
cBTC.tac**, so there is no "need cBTC.tac to mint the first cBTC.tac"
chicken-and-egg. Bootstrap only requires the **(TAC, tETH) pool to
exist** — seeded with protocol-owned TAC + bridged tETH at the V1 AMM
launch. The first depositor LPs (TAC, tETH), liens it, and mints
cBTC.tac immediately. Conservative launch params (high `BOND_RATIO`,
small `MAX_POOL_FRAC`) tighten as the pool deepens.

## §5.52.9 Insurance + liquidation

One mutualized `ctac-claim-pool` (§5.47.2) holds seized (TAC, tETH) LP
shares (and, per `SPEC-LIQ-BID-AMENDMENT.md`, converted cBTC.tac);
`T_CTAC_LIEN_CLAIM` (`0x4C`) pays a pro-rata slice. Since there is one
homogeneous bond, there is **no segmentation / cross-subsidy** problem.

On force-close, `T_LP_REMOVE` splits the seized bond into its **TAC +
tETH legs**, and `SPEC-LIQ-BID-AMENDMENT.md`'s `0x5E` venue bids both
for cBTC.tac into the claim pool (competitive standing bids, non-
reflexive, covenant-free), degrading to early-slash when the bid book
is thin.

## §5.52.10 Constants and governance

```
BOND_RATIO        default 2.5×   band [2.0×, 5.0×]   Tier A (IL-aware floor)
MAX_POOL_FRAC     default 0.10   band [0.05, 0.20]   Tier A (vs (TAC,tETH) depth)
LIQUIDATION_RATIO default 1.2×   band [1.1×, 2.0×]   Tier A
```

Replaces the per-asset `INITIAL_BOND_RATIO[*]` / `MAX_TAC_LEG_FRAC`
entries from earlier drafts (there is now one bond pool). Add to
`SPEC-CBTC-TAC-AMENDMENT.md` §5.46.2 Tier A table.

### Hard limits (extend §5.46.5)
- IL-aware ratio floor (§5.52.4) and the no-price-keyed-ratio rule.
- The bond pool is **(TAC, tETH)**; changing its assets is amendment-
  level, not a vote.
- One fungible cBTC.tac; governance cannot segment it.
- All base §5.46.5 hard limits carry over (primitives, conservation,
  slashing, atomic settlement, retroactivity, lien-enforcement point).

## §5.52.11 Implementation reconciliation (worker — follow-up)

The shipped foundation expects the bond pool's non-TAC leg to be the
BTC-pegged value provider and values the LP accordingly
(`index.js:22146-22219`). To realize this amendment:

1. **Point `bond_pool_id` at the canonical (TAC, tETH) pool**; accept a
   pool where both legs are non-BTC (the "predictable BTC value" now
   comes from dual-TWAP valuation, not a BTC-pegged leg).
2. **Value the bond via dual-TWAP fair-LP** (§5.52.3) — derive
   `P_tETH/BTC` by **triangulation**: `twapSatsPerUnit(TAC)` (already
   shipped — the asset-agnostic TWAP extracted from `ctacTwapSatsPerTac`)
   × the (TAC, tETH) pool's TAC/tETH TWAP. **No dedicated tETH/BTC oracle
   is needed.** Replace the single-leg `btcSideReserve`-is-sats
   assumption in `ctacLpShareValueSats` (`index.js:1251-1279`) with both
   legs converted via their TWAPs. Plumbing note: the TAC/tETH pool
   quotes tETH in TAC, so TWAP the TAC-denominated price and multiply by
   sats/TAC.
3. **Apply `BOND_RATIO` with its IL-aware floor** + the §5.52.5 cap.
4. Rename `cbtc_zk_*` deposit fields → `bond_*` (cosmetic; byte layout
   unchanged).

Tracked as a worker follow-up; not performed by this spec amendment.
The deposit flow is foundation-only (not live), so there is no live UX
to migrate.

---

## §5.52.12 Activation / rollout sequence

The bond design above activates in a dependency-forced order. Each
phase's prerequisite is the prior phase's output; nothing here can be
reordered.

**Phase 0 — already live.** `cBTC.zk` (the BTC *backing* / slot wrapper,
`SPEC-CBTC-ZK-AMENDMENT.md`) and the **TAC/sats orderbook** (gives
sats-per-TAC, the independent TAC/BTC anchor).

**Phase 1 — tETH bridge** (`SPEC-TETH-BRIDGE-AMENDMENT.md`). Brings the
exogenous bond leg (tETH) onto Tacit.

**Phase 2 — canonical (TAC, tETH) AMM pool.** Seeded with protocol-owned
TAC + early-bridged tETH; both are Tacit coins. As it trades it builds a
TAC/tETH TWAP. **The bond oracle is complete here, before cBTC.tac
exists:** `tETH/BTC = (sats/TAC orderbook) × (TAC/tETH pool)` (§5.52.3).
The pool is thus battle-tested as a market *before* it is relied on as
bond collateral.

**Phase 3 — activate cBTC.tac minting.** Wire the dual-TWAP bond
valuation (the §5.52.11 worker change; `twapSatsPerUnit` already
shipped) and turn on the deposit flow. A user locks a cBTC.zk slot +
posts a (TAC, tETH) LP bond → mints cBTC.tac. **No pre-existing cBTC.tac
is required (no circularity).** Governance is *optional* — the default
`BOND_RATIO` works without a vote (§5.41.4); the DAO only tunes it
later. Gate minting on the Phase-2 TWAP having a sufficient warm-up
window + a conservative initial `BOND_RATIO`; the oracle fails closed
(stale/empty → refuse) until then.

**Phase 4 — BTC-denominated AMM ecosystem.** With cBTC.tac live, open
**cBTC.tac/TAC**, **cBTC.tac/tETH**, **cBTC.tac/cUSD.tac** pools.
Reinforcement: the **cBTC.tac/TAC pool becomes a direct TAC/BTC AMM
oracle** (cBTC.tac ≈ 1 BTC), cross-checking the Phase-2 triangulation
and strengthening the oracle over time.

Critical-path summary:

```
cBTC.zk + TAC/sats orderbook (live)
  → tETH bridge
    → (TAC, tETH) AMM pool  → [bond oracle ready via triangulation]
      → dual-TWAP valuation wired + cBTC.tac mint activated
        → cBTC.tac/{TAC, tETH, cUSD.tac} BTC-denominated pools
```

Two operational dependencies that are easy to miss: the Phase-2 pool
**seed** (genesis liquidity the whole bond layer rests on), and the
**TWAP warm-up** before Phase 3 minting is safe.

---

## Test plan

1. **(TAC, tETH) bond lifecycle**: deposit, mint cBTC.tac, transfer,
   withdraw, recover slot + bond LP + accrued fees.
2. **Dual-TWAP valuation**: bond BTC-value tracks both TWAPs; resists
   reserve flash-manipulation.
3. **IL-aware floor**: simulate a 90–99% TAC crash; verify the bond at
   `BOND_RATIO` floor still covers the insured BTC after IL.
4. **Pro-cyclical prohibition**: `BOND_RATIO` invariant to price level;
   responds only to volatility/depth.
5. **Depth cap**: bonded BTC approaching `MAX_POOL_FRAC × depth` pauses
   new deposits; resumes as the pool deepens.
6. **Force-close**: `T_LP_REMOVE` → bid TAC + tETH legs via `0x5E` into
   the claim pool; thin-book → early-slash.
7. **Genesis**: seed (TAC, tETH) pool; first deposit mints cBTC.tac
   with no pre-existing cBTC.tac.
8. **Governance**: ratio/cap changes apply prospectively, within bands;
   sub-floor or price-keyed proposals rejected.

---

## Open questions

1. **Default ratio calibration** — is 2.5× the right IL-aware default,
   or should it be derived formulaically from observed TAC/tETH TWAP
   volatility? (Formulaic would auto-tighten in turbulence.)
2. **Fee carry vs IL** — surface the bonder's expected net carry
   (fees − expected IL) in the dapp so depositors price it.
3. **Backstop reserve sizing** — how large a pre-funded TAC backstop to
   seed at launch (§5.52.7).
4. **Genesis pool seed** — TAC + tETH amounts for the initial
   protocol-owned (TAC, tETH) LP.

---

## Summary

The cBTC.tac bond becomes a single, fungible, fee-bearing **(TAC, tETH)
LP share** under the existing §5.47 lien. The market prices its
*value* (dual-TWAP fair-LP); a **governable, IL-aware-floored
`BOND_RATIO`** prices its *risk*. This collapses weighting,
segmentation, and BTC-anchoring into one tunable knob; removes the
circularity and the genesis chicken-and-egg; makes the bond
half-exogenous (tETH); and gives TAC value through bonding **and**
governance — while the real BTC backing remains the cBTC.zk slot. It
solves "TAC alone is weak BTC backing" by relegating TAC to a
market-priced, ratio-governed half of an over-collateralized insurance
overlay. The §5.47 lien mechanism is reused unchanged; the worker
dual-TWAP valuation + (TAC, tETH) pool acceptance is a tracked,
low-risk follow-up (foundation-only, not live). Ships alongside tETH in
V1.
