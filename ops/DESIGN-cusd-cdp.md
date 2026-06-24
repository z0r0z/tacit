# DESIGN — cUSD: a collateral-backed confidential USD stablecoin (concept)

> **STATUS: foundation note, not yet a build.** cUSD is the **collateralized-mint CDP we already
> have** (the cBTC.tac bond machinery) **re-parameterized from a BTC peg to a USD peg**. Almost nothing
> here is new crypto — the position leaf, the relay-attested capacity/health gate, the live-reserve
> binding, the over-collateralization buffer, and the insurance backstop all exist in cxfer-core +
> `contracts/`. What's new is (a) a USD valuation formula, (b) the asset config, and (c) the one genuinely
> open piece: **confidential permissionless liquidation**. Cross-refs: `DESIGN-cbtc-tac-cdp.md` (the
> transparent-Ethereum CDP this mirrors), `DESIGN-cbtc-tac-bond-guest.md` (the in-guest §5 bond gate),
> `DESIGN-cbtc.md` (real-BTC cBTC — cUSD's premier collateral), `project_confidential_token_rollup`.
>
> **Build of record:** the cUSD CDP shipped as the `CollateralEngine` cUSD controller (`DESIGN-confidential-defi-v1.md`),
> which conjoins and supersedes the `CbtcBuffer` / `InsuranceVault` components referenced below — read those
> names here as the conceptual lineage, not live contracts.

## Graceful v1 — start here

**The one insight: a confidential stablecoin does not need confidential CDP positions.** Put the privacy
at the *holding* layer, not the *minting* layer. The CDP that mints cUSD stays transparent and simple
(public troves, like Liquity); the cUSD it emits circulates as a shielded Tacit note. Users get hidden
balances + private transfers — what they actually want — and the one genuinely hard problem (confidential
permissionless liquidation, §6) disappears because there's nothing confidential to liquidate.

So v1 is **Path B (§4) stripped to a single-collateral Liquity-shape**, and nothing else:

- **One collateral: tETH.** Already live on mainnet, exogenous real ETH (breaks Tacit-reflexivity), deepest
  USD feed. One collateral ⇒ no basket valuation. (cBTC is the headline *second* collateral — "a
  Bitcoin-backed dollar" — but it rides the reflection pipeline, so it's not the easy first step.)
- **One oracle: Chainlink ETH/USD**, reusing the fail-closed staleness/deviation/bounds guards already in
  `CbtcBuffer`.
- **One contract, `CUsdVault`** (fork `CbtcTacCdp`, retarget BTC→USD peg): `deposit`/`withdraw` tETH,
  `mint`/`burn` cUSD against `minted · MIN_RATIO ≤ collateralValueUsd`; `liquidate(position)` below
  `LIQ_RATIO` routed through the existing `InsuranceVault` router (no stability pool); `redeem(cUSD)`
  against the lowest-CR position at the oracle price (the hard floor).
- **cUSD = a canonical asset** via the factory; minter = the vault.
- **Privacy for free:** cUSD is a Tacit asset, so depositing it into the shielded pool and moving it as a
  confidential note is zero new code.

**Why it's the easy one:** no guest, no re-prove, no relay attestation, no `OP_BOND_*`, no zk liquidation —
every piece (`CbtcTacCdp`, `CbtcBuffer`, `InsuranceVault`, the asset factory, the shielded pool) is already
designed or built. It's Liquity-minus-stability-pool, single collateral, with a confidential holding layer
bolted on by reusing the pool.

**Deliberately deferred (and safe to defer):** confidential positions (the in-guest bond — public troves
are fine, Liquity's are too; add later on a settle re-prove against the *same* cUSD asset_id);
multi-collateral (add cBTC as a second feed); immutability (keep `Ownable` + per-epoch-bounded params, go
immutable later). The one thing v1 can't strip is the ETH/USD oracle — but it's a single decentralized feed
pricing the *ratio*, fail-closed, never a hot key. That's the floor of the trust budget for any dollar.

The rest of this doc is the full option space behind that recommendation.

## The confidential-CDP engine — the headline (target architecture)

The v1 above hides *balances*. The headline product hides **positions** — collateral size and debt size —
while staying soundly, permissionlessly liquidatable. No production CDP does this (Maker/Liquity/Aave are
fully transparent), because hiding a position from the public also hides it from liquidators, and
permissionless liquidation is what keeps a CDP solvent. The engine clears that wall, and **one
parameterized engine serves both cUSD (USD peg) and cBTC.tac (BTC peg)** — they differ only in peg unit,
collateral, and oracle feed.

### The position object

A position is a hidden note pair plus one public scalar:
- **collateral** committed as a bonded note `C = Pedersen(collateral_amount, r_c)` (the locked
  tETH/cBTC/cTAC), `BOND_POSITION_DOMAIN`-style so it isn't spendable by a plain transfer;
- **debt** committed as `D = Pedersen(debt, r_d)` (the minted cUSD/cBTC.tac attributed to the position);
- a position leaf binding `(peg_id, collateral_asset, C, mint_asset, D, issuer, nonce)` — the
  `bond_position_leaf` extended to carry `D` + the liquidation price;
- **public per position:** the commitments, the peg/oracle id, and `P_liq` (below). Sizes stay hidden.

### The two proof gates — one primitive, applied twice

Both gates are the **same primitive: a BP+ range proof over a homomorphic linear combination of the
position's commitments with public coefficients.** Given the public note commitments `C = collateral·H +
r_c·G` and `D = debt·H + r_d·G`, the verifier (guest or contract) recomputes a derived commitment itself
from public scalars, and the owner supplies a range proof that it commits to a non-negative value — so the
amounts are never revealed and the prover never needs the secrets. No opening of the amounts, no new
assumption.

**Gate 1 — `OP_CDP_OPEN` / `OP_CDP_ADJUST` (mint ratio).** Liquidatable-free requires
`collateral·price ≥ debt·MIN_RATIO`. With `price` and `MIN_RATIO` **public**, the verifier forms

```
M₁ = price·C − MIN_RATIO·D = (collateral·price − debt·MIN_RATIO)·H + (price·r_c − MIN_RATIO·r_d)·G
```

a Pedersen commitment to `collateral·price − debt·MIN_RATIO`; the owner range-proves it is `≥ 0`. (The
transparent `verify_bond_mint` is the public-value analogue; this is the committed-value version.) `price`
must be a fresh attested value — see *Oracle binding* below.

**Gate 2 — the liquidation price `P_liq` (the novelty, and it is NOT a product argument).** I had this
wrong earlier: because the owner **publishes `P_liq`**, the relation is *linear* in the hidden values, so
it's the **same range proof as Gate 1**, not a multiplicative gadget. The boundary price satisfies
`collateral·P_liq ≥ debt·LIQ_RATIO` (the soundness requirement is that the owner can't understate `P_liq`
to dodge). With `P_liq` and `LIQ_RATIO` **public**, the verifier forms

```
M₂ = P_liq·C − LIQ_RATIO·D = (collateral·P_liq − debt·LIQ_RATIO)·H + (P_liq·r_c − LIQ_RATIO·r_d)·G
```

and the owner range-proves `M₂ ≥ 0`. Publishing `P_liq` is exactly what keeps the coefficients public and
the combination linear — that's the whole trick. `P_liq = (debt/collateral)·LIQ_RATIO` is a **ratio,
scale-invariant**, so it leaks the position's *health/CR*, never its *size* (a whale and a minnow at the
same collateralization publish the identical `P_liq`). Re-proved on every open/adjust, so `P_liq` always
reflects the current position (no stale-gaming). Optional: coarsen `P_liq` up to a price grid to blur
health granularity (a privacy dial, at the cost of a slightly-early trigger).

So **there is no net-new cryptographic gadget** — both gates are the BP+ range proof over a homomorphic
combination, a primitive already in the stack. The real engineering is the *execution* below.

### Gate 3 — liquidation: a free trigger, a careful settle

**The trigger is permissionless and relay-free:** anyone can fire when `oracle_price < P_liq` — a public
comparison needing no secret. **The execution is the genuinely hard part**, and it's where this earns its
novelty: settling a liquidation must open the hidden `(collateral, debt)` and move them, but **only the
owner knows the openings** — and they're being liquidated, so they won't cooperate. "De-cloak at death"
hides that question; here are the two known-shape ways to force it (both are systems work, not new crypto):

1. **Challenge-response forced reveal (trust-minimized, recommended).** A challenger posts a bond asserting
   `oracle < P_liq`; the owner must reveal-and-settle within a window (open the position, burn `debt`,
   reclaim the residual collateral) or **forfeit the entire collateral** to the challenger. The owner's own
   self-interest forces the reveal — no committee, no extra trusted party. Cost: an **owner-liveness
   assumption + a watchtower** (you already run watchtowers for walk-away bids and the bridges, so a
   defend-my-position watchtower is the same shape). Shortfalls route through `InsuranceVault`.
2. **Keeper-committee threshold decrypt.** At open, the owner verifiably encrypts the opening to a keeper
   set and proves the ciphertext matches the commitments; on trigger, the keepers threshold-decrypt and
   settle. No owner-liveness requirement, but it adds a committee trust (collusion → early privacy loss,
   never theft).

The owner can't dodge the *trigger* — `P_liq` is bound to the committed values (Gate 2) and over-mint is
blocked (Gate 1) — so a position only becomes liquidatable once it's genuinely underwater; the open
question the execution answers is purely *who forces the showdown*.

### Redemption (the hard peg)

Burn the synthetic → draw collateral at the oracle ref from the position **closest to liquidation**
(highest `P_liq` = lowest CR) — the Liquity arbitrage that pins the peg. v1 redemption runs against the
**transparent vault's** positions (no need to de-cloak healthy confidential positions); redemption directly
against confidential positions (a partial reveal-on-redeem) is a follow-up.

### The shared op set (peg/oracle as parameters)

`OP_CDP_OPEN` / `OP_CDP_ADJUST` (Gates 1+2) · `OP_CDP_REDEEM` · `OP_CDP_LIQUIDATE` (Gate 3). `peg_id`
selects the `mint_asset` + the oracle feed — `{cUSD / ETH-USD}` or `{cBTC.tac / collateral-BTC}` — and
**everything else is identical**. One op set, two products. Per the §5 principle (*freeze the structure,
not the oracle*): `MIN_RATIO`, `LIQ_RATIO`, the liquidation bonus, the oracle id, the staleness window, and
the debt ceiling live in the relay/contract params (governable with **no re-prove**); only the op-set
interface + the two range-proof relations + the liquidation-settle logic freeze into `PROGRAM_VKEY`.

### Leakage profile (stated honestly)

- **Hidden:** collateral size, debt size, absolute position value.
- **Public:** `P_liq` (⇒ health/CR), the position as a trackable opaque commitment over its life, the peg +
  oracle, and that a position exists. At liquidation: full de-cloak.
- **Dial:** coarsen `P_liq` to bands to blur health. **Alternative** (hide `P_liq` too) forces a keeper
  committee / relay to do liquidation — strictly more trust. Public-`P_liq` is the most-trustless point on
  the curve, which is why it's the recommended one.

### Oracle binding (a real care-point)

Gate 1's `price` is a public coefficient the verifier must pin to a **fresh, attested** value, or a
stale/cherry-picked price over-mints. Either verify Gate 1 **on-chain against a live Chainlink read** (the
contract recomputes `M₁` and checks the range proof — heavier gas, fully trustless freshness), or have the
**settle guest verify against a relay-attested recent price** (the §5 interface) that the contract
cross-checks against its own oracle window. Same care every CDP takes, plus binding the price into the
proof's public inputs. Separately, bound the value/coefficient bit-widths so `P_liq·collateral` etc. can't
wrap the field (ordinary BP+ hygiene).

### What it costs

The engine is **primitives you already have + a settle re-prove — no net-new cryptographic gadget.** Both
gates are the BP+ range proof over a homomorphic combination (already in the stack), alongside Pedersen
notes, opening sigmas, the settle guest, oracle attestation, the bond position leaf, and `InsuranceVault`.
**No new cryptographic assumptions.** The real engineering is the **liquidation execution** (Gate 3 —
the challenge-response game or keeper committee), which is systems work, not crypto. Medium lift, highest
differentiation — and it lands cUSD *and* cBTC.tac at once. The execution mechanism is the piece to
prototype first to de-risk.

### On-ramps (how to get here)

1. **Transparent `CUsdVault`** (the graceful v1): ships now, no re-prove — the peg/redemption anchor and
   the liquidation fallback.
2. **Relay-attested confidential positions** (interim): hide positions *now* using the existing
   `verify_bond_slash_health` (the relay signs liquidatability) — semi-trusted liquidation, the simplest
   execution; swap the relay for the permissionless `P_liq` trigger + challenge-response settle when it lands.
3. **Full engine:** the `P_liq` mechanism — permissionless trigger, relay-free, trust-minimized settle.

## Upgrade seam — scaffolding the engine onto v1 (no token migration)

The confidential engine can be added to the v1 deployment **without redeploying anything users touch** —
*if* one decision is made at v1 deploy time. The canonical token (`CanonicalBridgedERC20`) has an
**immutable `MINTER` baked into its CREATE2 address** (`mint`/`burn` revert unless `msg.sender == MINTER`).
One minter, forever. So:

- **The trap:** deploy cUSD with `MINTER = CUsdVault` (the transparent CDP directly) and the token is welded
  to that vault. Adding the confidential engine later as a second minter then forces a **token redeploy +
  liquidity migration** — the one thing to avoid.
- **The seam:** deploy cUSD with `MINTER = CUsdController`, a thin **DAO-owned controller with an
  authorized-minter set + per-minter ceiling** that multiplexes `mint`/`burn`. The token sees one minter
  (the controller, address stable forever); the controller decides which modules may mint.

```
cUSD (canonical ERC20, immutable MINTER = CUsdController)   ← deployed ONCE, address stable
        │
   CUsdController (DAO-owned; authorized-minter set, per-minter ceiling)
        ├── CUsdVault         (transparent CDP)    ← authorized at v1
        └── ConfidentialPool  (confidential CDP)    ← addMinter(pool) later, NO token redeploy
```

**Two more v1 seams (cheap now, painful to retrofit):**
- **Inject the oracle + risk params**, don't hardcode: a standalone `OracleAdapter` (Chainlink, fail-closed,
  reusing `CbtcBuffer` logic) + a `RiskParams`, passed into the vault, so the confidential module shares them.
- **Scope v1 liquidation/redemption to v1's own positions** — no single global trove list — so the
  confidential module coexists as a separate position set (its collateral is shielded notes) under the
  shared token + oracle, rather than needing to retrofit v1's trove book.

**What still rotates later but never touches the token:** the confidential engine needs a settle re-prove
(new `OP_CDP_*` → new `PROGRAM_VKEY`) and rides the current `ConfidentialPool` deployment — but the pool
redeploys on vkey rotations as routine, confidential cUSD lives as a **shielded note** (it becomes ERC20
only on withdrawal, where the pool calls `CUsdController.mint`), so authorizing it is a governance
`addMinter` behind the controller, not a migration. The controller is a bounded, DAO-owned power (same trust
class as the CDP params; can't mint directly; every module ceiling-capped).

**The one irreversible mistake is binding cUSD directly to the v1 vault — hold that line.**

## 1. The model

```
lock collateral (tETH / cTAC / cBTC) ─▶ open a position ─▶ mint cUSD up to collateralValueUsd / MIN_RATIO
        │                                                       │
        │  Chainlink + AMM-TWAP value the collateral in USD     │  cUSD is a Tacit asset (confidential note)
        ▼                                                       ▼
   under-collateralized? ─▶ LIQUIDATION (slash the position)    redeem: burn cUSD ─▶ draw collateral at ref
   (relay-attested in v1; zk-proven in the endgame)             (arbitrage pins cUSD ≈ $1)
```

cUSD holds $1 because every unit is over-collateralized by crypto worth more than $1, and
liquidation + redemption arbitrage keep it pinned — the DAI/Liquity model, retargeted to confidential
Tacit notes. **No real dollars, no custodian, no RWA** — the most trustless cUSD shape available
(delta-neutral needs a CEX, RWA needs a custodian, algorithmic is dead).

## 2. Why the foundation already exists (the op-by-op map)

The cBTC.tac **bond** in cxfer-core *is* a CDP. cUSD is the same ops with a USD valuation:

| cUSD need | Existing primitive (cxfer-core) | Change for cUSD |
|---|---|---|
| A position binds collateral + debt, anti-relabel | `bond_position_leaf(bond_asset, cx, cy, mint_asset, minted_amount, issuer, nonce)` | `mint_asset = cUSD`; collateral note = the bond note |
| Mint bounded by a priced capacity | `verify_bond_mint` + `BondMintAttest` | value collateral in USD, not sats (§5) |
| Capacity can't exceed what LIVE reserves justify | `bond_spot_capacity_ceiling` (guest re-derives the ceiling from on-chain AMM reserves) | swap the `sats_per_tac` rational for a `usd_per_collateral` rational |
| Liquidate an unhealthy position | `verify_bond_slash_health(position_leaf, anchor, sig, oracle_x)` | same gate; the health call values in USD |
| Domain-separated so a bonded note isn't spendable by a plain transfer | `BOND_POSITION_DOMAIN`, `BOND_ATTEST_{MINT,SLASH}_DOMAIN` | reuse (or fork `CUSD_*` domains) |
| Over-collateralization buffer, oracle fail-closed | `CbtcBuffer` (Chainlink stale/deviation/bounds reject) | retarget to a USD feed |
| Liquidation-shortfall backstop | `InsuranceVault` (buy-and-sequester) | reuse |
| On-chain solvency view | the `cbtcBackingSats` reflection seam (Σ backing surfaced on-chain) | a `Σ collateralValueUsd` / `Σ cUSD debt` analogue |
| Deterministic asset, both chains | `CanonicalAssetFactory` / canonical-asset determinism | a cUSD asset_id |
| Hidden per-position stakes | confidential notes + opening sigma (`lp_share_id` pattern) | the differentiator — see §4 |

The mint gate's important property carries over verbatim: `verify_bond_mint` re-derives the spot ceiling
from the **live, visible AMM reserves** at the relay's attested price, so the relay's only unbounded
input is the single exogenous price — it **cannot over-authorize beyond what on-chain reserves justify**
without also moving the visible pool. That trustless-binding is exactly what a CDP's mint cap wants.

## 3. Collateral + valuation

- **tETH (primary):** real ETH, exogenous, breaks Tacit-reflexivity — the safety leg. Priced by a
  Chainlink ETH/USD quorum (decentralized, not a hot key), fail-closed via the `CbtcBuffer` guards.
- **cBTC (premier):** the real-BTC self-custody asset from `DESIGN-cbtc.md`. A trustless, real-BTC-backed
  note is an excellent stablecoin collateral — **cBTC feeds cUSD**: BTC → trustless cBTC → confidential
  USD. Priced by BTC/USD.
- **cTAC (bounded bootstrap):** capped, never sole backing (the death-spiral leg stays removed).
- **Valuation:** `collateralValueUsd = Σ amount_i · usdRef_i`, the refs governance-ratified *and*
  bounded against the on-chain AMM (the trustless ratio), per `DESIGN-cbtc-tac-cdp.md §2`. Mis-sizing a
  ref slightly mis-collateralizes (contained by over-collateralization + liquidation); it can **never
  mint cUSD or seize collateral** — the ratio is contract/guest-enforced.

## 4. Two substrates — pick the trust/privacy point

**Path A — confidential cUSD (in-guest bond).** Positions are Tacit notes; balances **and** position
sizes are hidden. Uses `verify_bond_mint` / `verify_bond_slash_health` as `OP_BOND_*` (today
library-only in cxfer-core — `main.rs` does **not** dispatch them, so this is **gated on a future settle
re-prove**, which the user has already framed as "a clean future settle re-prove"). This is the
Tacit-differentiated product: a private stablecoin nobody else ships.

**Path B — transparent cUSD (Ethereum CDP).** Re-parameterize `CbtcTacCdp` (`DESIGN-cbtc-tac-cdp.md`)
from a BTC peg to a USD peg: `CUsdCdp` (Solady `Ownable`), governance/Chainlink USD refs, `MIN_RATIO`,
permissionless `liquidate`, `redeem`. **Ships now** — no guest, no re-prove, mature contracts — but it's
a standard DAI-shape (no confidentiality). The fast pragmatic launch.

**Recommendation:** ship **Path B** as the liquid, composable launch token and the redemption/peg anchor,
and bring **Path A** in on the next settle re-prove so the *same cUSD asset_id* gains a confidential
position form — transparent and confidential CDPs minting one fungible cUSD. Path B also gives Path A its
hard-peg redemption venue while the confidential-redemption path matures.

## 5. The relay capacity/health formula, retargeted to USD (§5 hybrid)

`bond_spot_capacity_ceiling` today computes the fair-LP value of a bonded share in TAC, prices it to sats,
divides by the ratio, bands for TWAP drift. For cUSD the structure is identical — only the rational and
the unit change:

```
ceiling_usd = collateralValueUsd(position) · (10000 + band_bps) / (MIN_RATIO_bps)
            = Σ amount_i · usd_num_i / usd_den_i · (10000+band) / ratio_bps   (u128-checked, fail-closed)
```

Per `DESIGN-cbtc-tac-bond-guest.md`'s principle — **freeze the structure, not the oracle**: the
`MIN_RATIO`, the dual-TWAP, the liquidation threshold, and the staleness window live in the relay's
`max_mint` / `unhealthy` computation (tunable post-deploy, **no guest change**); only the attestation
*interface* (`BondMintAttest.msg()` field binding + `bond_slash_health_msg`) is frozen into the vkey. So
cUSD parameters are governable without a re-prove once the op set is activated.

## 6. The honest tradeoff

- **A USD peg is intrinsically oracle-soft — it cannot inherit cBTC's oracle-free property.** cBTC's
  elegance is that BTC is the unit, so a real-BTC redemption *is* the peg, no oracle. cUSD pegs to an
  off-chain unit you can't hold trustlessly, so the collateral price **must** come from an oracle and the
  peg is soft (over-collateralization + liquidation + arbitrage), like every crypto stablecoin. The right
  move is to *minimize* it — a Chainlink quorum pricing the **ratio**, never a hot key, never the peg unit
  — not to pretend it away. This is the one place "trustless is the niche" meets a real wall, and it's
  intrinsic to stablecoins, not a gap in the design.
- **Confidential permissionless liquidation is the headline, now specified.** If position sizes are
  hidden, a liquidator can't see which position is underwater — the wall every CDP hits. The
  confidential-CDP engine (above) clears it by publishing the **liquidation price `P_liq`** (a
  scale-invariant ratio that leaks health, not size) so the liquidation *trigger* stays permissionless and
  relay-free, with positions de-cloaking only at death. The proof side needs **no net-new gadget** — both
  gates are the BP+ range proof already in the stack; the real engineering is the *execution* (the
  challenge-response settle or keeper committee). The interim is the relay slash attestation
  (`verify_bond_slash_health`, semi-trusted). This is the differentiator worth building, and it lands
  cUSD + cBTC.tac on one engine.
- **CDP solvency risk** is the usual class: a crash that outruns liquidation. Mitigated by tETH-primary,
  capped cTAC, real-BTC cBTC collateral, conservative ratios, the insurance floor; never zero, as for any CDP.

## 7. Trust ledger

| Concern | Mechanism | Trust |
|---|---|---|
| cUSD is backed | crypto over-collateralization + liquidation | **collateral sufficiency** (economic) |
| No mint-from-nothing | ratio enforced; mint cap bound to live AMM reserves | **none** (contract/guest) |
| Collateral USD price | Chainlink quorum + AMM-TWAP bound, fail-closed | **soft + bounded** (can't mint/seize) |
| Liquidation finds underwater positions | v1 relay attestation → endgame zk proof | **semi-trusted v1, trustless endgame** |
| Peg redemption | burn-for-collateral arbitrage | **none** (contract) |

## 8. Build plan

1. **`CUsdController` + cUSD canonical asset (the upgrade seam — do this first):** deploy cUSD
   (`CanonicalAssetFactory`) with `MINTER = CUsdController`, a thin DAO-owned minter-set controller (NOT the
   vault directly — see *Upgrade seam* above), so the token address is stable for later additive minters.
2. **`CUsdVault` (Path B, Ethereum):** fork `CbtcTacCdp` to a USD peg — positions, `mint`/`burn` against
   `MIN_RATIO` via the controller, an injected `OracleAdapter` (Chainlink, fail-closed) + `RiskParams`,
   permissionless `liquidate` (reuse the router pattern), `redeem` scoped to v1 positions, forge tests.
   Authorized as minter #1 behind the controller. No guest, no re-prove — deployable independently.
3. **Relay-attested confidential positions (interim on-ramp 2):** dispatch `OP_BOND_MINT/REDEEM/SLASH` in
   the settle `main.rs` with the USD valuation, fold into the next coordinated settle re-prove (rotates
   `PROGRAM_VKEY`). Hides positions now with `verify_bond_slash_health` for liquidation (semi-trusted). The
   bond primitives + domains already exist; this is wiring + fixtures, not new gates.
4. **The confidential-CDP engine (the headline):** add the `OP_CDP_*` op set — Gate 1 + Gate 2 (both the
   same BP+ range proof over a homomorphic combination, `M₁`/`M₂ ≥ 0`, no net-new gadget) + Gate 3
   (`OP_CDP_LIQUIDATE`: permissionless `P_liq` trigger + the challenge-response settle or keeper committee)
   — and re-prove. `peg_id` parameterizes cUSD + cBTC.tac on one op set. Prototype the Gate-3 execution
   first to de-risk; it swaps the relay slash from step 3 for the permissionless trigger.
5. **Confidential solvency view:** a `Σ collateralValueUsd` / `Σ debt` analogue of the `cbtcBackingSats`
   reflection seam, so on-chain can gate global solvency.

Steps 1–2 are a self-contained Ethereum stablecoin shippable now; step 3 hides positions on the next
re-prove with interim relay liquidation; step 4 is the novel headline (permissionless confidential
liquidation, cUSD + cBTC.tac on one engine). Nothing here blocks, or is blocked by, the cBTC reflection
re-prove.
