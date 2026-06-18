# DESIGN — Confidential DeFi v1: cBTC + cUSD on a generic, programmable collateral core

> **STATUS: the confidential-DeFi architecture of record (2026-06-18).** v1 ships three things together:
> **(1) cBTC** — tokenized real Bitcoin (self-custody lock + native-ETH slashable escrow); **(2) cUSD** —
> a cBTC-collateralized confidential stablecoin; **(3) a unified collateral/insurance engine** (the
> conjoined buffer + insurance + escrow). All three sit on a **minimal, generic, immutable core** (the
> two SP1 vkeys + the immutable `ConfidentialPool`); **all policy lives in mutable Ethereum contracts**
> that plug into the core.
>
> **Supersedes:** `DESIGN-cbtc.md` §4 (the *aggregate passive buffer* — the economically-unsound "free
> rug option") and every `DESIGN-cbtc-tac*.md` / bond-guest framing. **Builds on:**
> `DESIGN-cbtc-sats-lock-reflection.md` (`fold_cbtc_lock`, reworked below to track-not-mint),
> `DESIGN-cbtc-redemption.md` (atomic cBTC↔BTC redemption), `project_canonical_asset_determinism`
> (derived asset ids).

## 0. The gold-star principle — minimal immutable core, maximal mutable programmability

The two things we cannot change after launch are the **SP1 guest vkeys** (`PROGRAM_VKEY` settle,
`BITCOIN_RELAY_VKEY` reflection) and the deployed **`ConfidentialPool`**. Everything else is a
deployable Ethereum contract. So the design rule is:

- **Immutable core = generic primitives + conservation only.** No prices, no ratios, no oracle keys, no
  asset-specific policy, no registry of who-may-do-what. The core proves *structure* ("a collateral note
  was locked into a controller-bound position; a controller-derived debt note was minted; value is
  conserved") and nothing about whether that was *wise*.
- **Mutable Ethereum contracts = all policy + programmability.** Pricing (Chainlink), collateral ratios,
  liquidation venues, insurance sizing, new collateral types — all in contracts that can be deployed,
  tuned by a DAO, and added later **without a re-prove or a pool redeploy**.

This is what lets new DeFi primitives (lending, leverage, other stablecoins, structured positions on
Tacit *or* Bitcoin assets) ship as **just a new Ethereum controller** on top of the same frozen core.

## 1. Scope — what is ACTIVE in v1

| Primitive | Real-BTC? | Peg | Oracle role | Status |
|---|---|---|---|---|
| **cBTC** | yes (self-custody lock) | conservation (1 cBTC = locked sats) | Chainlink ETH/BTC sizes the **escrow only**, never the peg | active |
| **cUSD** | via cBTC collateral | CDP over-collateralization + liquidation | Chainlink BTC/USD is **load-bearing** (CDP stablecoin, like DAI) | active |
| **generic CDP primitive** | any | n/a (a mechanism) | per-controller | active (cUSD is its first instance) |
| **unified collateral/insurance engine** | n/a | n/a | ETH/BTC + BTC/USD | active |

## 2. The immutable / mutable split

**IMMUTABLE (this re-prove + this deploy):**
- **Reflection guest** — proves Bitcoin facts: which cBTC locks are *live* and which got *spent*. Exposes
  generic per-lock roots + the aggregate backing. No cBTC policy.
- **Settle guest** — the generic confidential-CDP ops (mint / close / liquidate) + the existing ops. No
  asset/price policy.
- **`ConfidentialPool`** — verifier-shell + state machine + the **controller-callback seam** + the
  **cBTC escrow-mint/slash seam** + the extended public-values layout. No policy.

**MUTABLE (deployable, DAO-tunable, pluggable — no re-prove):**
- **`CollateralEngine`** (the conjoined buffer + insurance + escrow): native-ETH cBTC escrows, the cUSD
  CDP controller, the shared insurance reserve, all Chainlink feeds. All ratios/prices/venues here.
- **Future controllers** — any new collateral primitive: deploy a controller, it mints its own
  controller-derived asset, it plugs into the same guest CDP ops + the same pool callback.

## 3. cBTC — real-BTC lock + native-ETH slashable escrow (ACTIVE)

**Why real-BTC and why it's necessary (not just nice):** Tacit has **no native-satoshi asset**, and
`bridge_mint` requires a note that already exists in the Bitcoin-side pool — so the dual bridge alone
*cannot* tokenize someone's external BTC. `fold_cbtc_lock` is the **only on-ramp** that turns real BTC
into a Tacit note; the dual bridge then transports cBTC across chains like any asset. The lock gives the
**oracle-free peg** (conservation), which a pure-ETH synthetic structurally cannot.

### 3.1 Reflection — per-lock surfacing (the re-prove delta)

Today the reflection commits only the scalar `cbtcBackingSats` and keeps `cbtc_locks` as a
`LiveUtxoSet` (no per-lock proofs). For **per-locker slashing** the contract must act on *individual*
locks, so the reflection surfaces the per-cycle lock deltas as **proven public-value arrays** — the same
pattern the settle guest uses for `leaves` / `bitcoinBurnsConsumed`, which the contract records into
mappings (as it already does for `bridgeMinted`):

- `fold_cbtc_lock` becomes **track-not-mint**: it records the lock into `cbtc_locks` (the existing
  `LiveUtxoSet` — the lookup index + aggregate backing) and emits a **`cbtcLocksFolded`** entry
  `(outpoint, v_btc, commitment_hash)`; the `commitment_hash` is the locker's pre-committed cBTC note
  (from the `0x66` envelope), so only that note can later be minted (anti-griefing). It does **not**
  append a cBTC note and no longer needs the opening sigma — the mint + the value-opening move to the
  contract (§3.2).
- `fold_cbtc_lock_spends` emits a **`cbtcLocksSpent`** entry `(outpoint)` for every tracked lock spent
  this cycle (rug *or* redemption — the guest does not classify; the contract does, §3.3) and drops its
  sats from the backing.
- **Public values gain** the `cbtcLocksFolded[]` + `cbtcLocksSpent[]` arrays (alongside the existing
  scalar `cbtcBackingSats`). The persistent `cbtc_locks` root + `cbtcBackingSats` stay bound into the
  resume `digest()` exactly as today, so the deltas can't be forged across cycles — and because no new
  *persistent* accumulator is added, **`REFLECTION_GENESIS_DIGEST` is unchanged** (only the ELF/vkey
  rotates from the behavior change).

### 3.2 Mint — reflection lock-membership + native-ETH escrow

A dedicated contract path (bridge_mint-shaped, but gated on the *lock* registry + an escrow):

1. Locker creates a self-custody BTC lock (their own output, `vout ≠ 0`, `0x66` commit, pre-committing
   the cBTC note). Reflection folds it → a `cbtcLocksFolded(outpoint, v_btc, commitment_hash)` entry,
   which `attestBitcoinStateProven` records into `cbtcLock[outpoint] = {v_btc, commitment_hash}`.
2. Locker posts **native ETH** to the `CollateralEngine`, keyed by the lock outpoint, sized
   `≥ ratio · Chainlink_ETHperBTC · v_btc`.
3. `ConfidentialPool.mintCbtc(outpoint, noteCommitment, openingProof)` mints the cBTC note **iff** (a)
   `cbtcLock[outpoint]` exists (relay-proven) and `keccak(noteCommitment) == its commitment_hash`, (b)
   the note opens to exactly `v_btc` (the opening proof — conservation, value-binding moved here from the
   guest), and (c) `CollateralEngine.escrowOf(outpoint) ≥ ratio · v_btc` (the engine's Chainlink check).
   One-mint-per-lock via `cbtcMinted[outpoint]`. cBTC's asset id is the fixed `CBTC_ZK_ASSET_ID` (the one
   canonical real-BTC asset, not controller-derived).

### 3.3 Slash / redeem — the contract classifies

- **Redeem (honest):** an atomic cBTC↔BTC swap (an exiting locker unlocks BTC to a redeeming holder, the
  cBTC burn reveals the adaptor secret — `DESIGN-cbtc-redemption.md`). The engine marks
  `escrowReleased[outpoint]` when the redemption is proven, and returns the ETH.
- **Slash (rug):** `attestBitcoinStateProven` records each `cbtcLocksSpent(outpoint)` into
  `cbtcLockSpent[outpoint] = true`. The engine's `slash(outpoint)` fires iff `cbtcLockSpent[outpoint]`
  **and** `escrowReleased[outpoint]` is false ⇒ a rug ⇒ it **slashes** the native ETH. The slashed ETH
  backs the now-unbacked cBTC (held / used to buy+burn cBTC over the async redemption rail). The guest
  never decides rug-vs-redeem; the engine does, from the proven spend flag + its own release ledger.

### 3.4 Trust ledger (cBTC)
| Concern | Mechanism | Trust |
|---|---|---|
| cBTC = real BTC (peg) | `fold_cbtc_lock` conservation, 1:1 | **none** (proof), no oracle |
| no double-mint | lock single-use + `cbtcMinted` | **none** (proof) |
| no custodian holds BTC | self-custody | **none** |
| rug coverage | spent-lock proof + slash native ETH | **economic, bounded** (escrow ≥ ratio·v_btc) |
| escrow sizing | Chainlink ETH/BTC (quorum) | **soft, 2nd-order** (mis-size ≠ de-peg) |

Honest caveat (memory-only): the self-custody lock is *economically* secured pre-covenant — the escrow
is the hard security floor, the real BTC is the honest-case backing + the 1:1-redemption arbitrage floor.
Covenant endgame (CTV/OP_VAULT) ⇒ lock is spend-only-into-redemption ⇒ escrow falls away ⇒ 1× trustless.

## 4. The generic confidential-CDP primitive (the programmable core)

Three new settle ops (codes 15/16/17), asset-agnostic and policy-free. They are the reusable substrate
for cUSD and every future collateral primitive.

### 4.1 Controller-derived debt asset — sole minter, no registry, no admin

```
debt_asset_id = sha256( "tacit-cdp-debt-v1" ‖ controller_addr )
```

Derived from the **controller alone** (not the collateral), so one controller mints one debt asset
regardless of how many collateral legs back it — which is what makes **multi-asset baskets** fall out for
free (§4.2). A controller can mint **only** its own derived asset. So: permissionless (anyone deploys a
controller and gets a unique asset), **no inflation of existing assets** (a rogue controller can only
inflate its own token, worthless unless actually collateralized), and **no allowlist/DAO registry** (which
would be an admin hole in an immutable pool). This is the canonical-asset-determinism pattern extended to
CDP debt.

### 4.2 The position leaf — a **basket** of collateral legs (multi-asset from day one)

A position is backed by a **set of collateral legs** `{ (asset_i, c_i_x, c_i_y, value_i) }`. The guest
commits the basket as a deterministic root and binds it into the position leaf:

```
basket_root      = keccak_merkle([ keccak(asset_i ‖ c_i_x ‖ c_i_y ‖ value_i) for each leg i ])
cdp_position_leaf = keccak( CDP_POSITION_DOMAIN ‖ controller_addr ‖ debt_asset
                            ‖ basket_root ‖ debt_value ‖ owner ‖ nonce )
```

`CDP_POSITION_DOMAIN = "tacit-cdp-position-v1"` — disjoint from the note tree, the adaptor lock set, and
the cBTC lock set, so collateral locked in a position is **never** spendable by a normal transfer. **v1
cUSD uses a single-leg basket (cBTC)** — the same structure, `n=1` — so the multi-asset capability is
frozen into the immutable core now and activated later by a controller that simply accepts `n>1`. The
guest never interprets the legs' *meaning* (which mix, what ratios) — that's the controller's policy.

### 4.3 The ops

- **`OP_CDP_MINT` (15):** spend the `n` collateral notes (each asset_i, **confidential owner**); recompute
  `basket_root`; append the `cdp_position_leaf`; mint a debt note (asset D=`derive(controller)`,
  confidential owner) of `debt_value`. **Boundary amounts (each `value_i`, `debt_value`) are public** (so
  the contract can enforce capacity); **owner stays confidential** — same privacy boundary as
  wrap/withdraw. Conservation: each spent collateral note opens to its `value_i`; the debt note opens to
  `debt_value`.
- **`OP_CDP_CLOSE` (16):** prove `cdp_position_leaf` membership; spend debt notes (asset D) summing to
  `≥ debt_value`; release the basket (mint each leg's asset-`i` note with its commitment back to the
  owner). Pure conservation — **no oracle, no controller policy** (you can always repay and reclaim).
- **`OP_CDP_LIQUIDATE` (17):** prove `cdp_position_leaf` membership; seize the basket to the controller /
  its auction (mint each leg to the controller's address). The *authority* to liquidate is the contract's
  (§4.4) — the guest only enforces the structural seizure + that the debt is retired against the controller.

### 4.4 The pool ↔ controller seam (policy via a mutable contract)

This is the gold-star hinge. When `ConfidentialPool._settle` processes a CDP op it **calls out** to the
controller named by the position (and checks `debt_asset == derive(controller)`):

- `OP_CDP_MINT` → `controller.onCdpMint(legs[], debt_value, positionLeaf)` where `legs[]` carries every
  `(asset_i, value_i)`. The controller applies **any** policy — per-asset Chainlink prices, **smart-
  contract-governed per-asset ratios**, basket eligibility, debt ceilings — and **reverts to deny**. The
  pool proceeds only if the controller approves. This is where a MakerDAO-style multi-collateral basket
  with governed weights lives, entirely in mutable code.
- `OP_CDP_LIQUIDATE` → `controller.onCdpLiquidate(positionLeaf, legs[], debt_value)`. The controller
  proves (via its oracles) the position is unhealthy and routes the seizure/auction + covers the debt from
  the position/insurance. Reverts if healthy.
- `OP_CDP_CLOSE` → optional `controller.onCdpClose(...)` for accounting; never a veto (repaying is
  unconditional).

The callout is `nonReentrant`-guarded and CEI-ordered. A controller can only **deny** or **approve +
account for its own asset** — it can never mint another asset, move pool backing, or break a conservation
invariant (those are all proof-enforced in the immutable core). So a buggy/rogue controller bounds its
blast radius to **its own** token's holders, exactly the desired property.

### 4.5 What the immutable core freezes vs leaves mutable
- **Frozen (structure):** the three op shapes, the **basket** `cdp_position_leaf` + `basket_root`, the
  `derive(controller)` asset rule, the conservation arithmetic, the controller-callback interface
  (`onCdpMint/Liquidate/Close` carrying the legs).
- **Mutable (policy, in the controller):** which assets are eligible basket legs and their governed
  **per-asset ratios/weights**, the oracle(s), the liquidation threshold + venue + penalty, the debt
  ceiling, the insurance backstop, fees. All tunable post-deploy, all per-controller — a single-asset
  cUSD vault and a MakerDAO-style multi-collateral basket are both *just controllers* on the same core.

## 5. cUSD — the first CDP controller (cBTC collateral, Chainlink BTC/USD)

cUSD is **one instantiation** of §4: a `CdpController` whose debt asset is `derive(cUSD_controller)` and
whose v1 basket is a **single leg, cBTC**, and whose `onCdpMint` reads **Chainlink BTC/USD** to enforce
`debt_value_usd ≤ collateral_value_btc · price_btc_usd / ratio`. Liquidation triggers when the
collateralization ratio falls below the liquidation threshold; the seized cBTC is auctioned (over the
async confidential venue) to cover the cUSD debt, with the insurance reserve covering any shortfall.
Because the position is already basket-shaped, a later cUSD-v2 (or a separate stablecoin) can accept a
governed multi-asset basket — cBTC + Tacit LP shares + Tacit/bridged assets + ERC20s — with **no
re-prove**, just a new/upgraded controller.

cUSD's peg is a **CDP-stablecoin peg** (over-collateralization + liquidation + redemption arbitrage),
so — unlike cBTC — **Chainlink BTC/USD is first-order load-bearing** for cUSD. This is inherent to a CDP
stablecoin (DAI is identical) and is the honest, accepted trade for a simple v1 stablecoin. cUSD inherits
cBTC's pre-covenant risk profile (its collateral is economically-secured real BTC); sized conservatively
for a pilot.

## 6. The unified collateral/insurance engine (conjoin buffer + insurance + escrow)

`CollateralEngine` (Solady `Ownable` → DAO) replaces and conjoins `CbtcBuffer` + `InsuranceVault` + the
per-locker escrow into **one** contract — the protocol's DeFi-safety core:
- **cBTC escrows:** per-lock native-ETH balances; `postEscrow` (Chainlink ETH/BTC sized), `release` (on
  proven redeem), `slash` (on proven rug, §3.3).
- **cUSD CDP backstop:** the `onCdpMint/Liquidate` policy for the cUSD controller (Chainlink BTC/USD,
  ratio, liquidation routing).
- **Shared insurance reserve:** absorbs the tail (rug-recovery shortfall, liquidation bad debt); funded
  by slashing surplus + liquidation penalties, never by honest users.
- **Feeds:** ETH/BTC + BTC/USD Chainlink, each with staleness + AMM-TWAP-deviation fail-closed bounds.

**Bounded by construction:** the engine can size escrows, price collateral, and route liquidations, but it
can **never** mint a confidential asset, move cBTC backing, or break a peg — those are all proof-enforced
in the immutable core. Owner = deployer → `transferOwnership(dao)`.

## 7. Immutable surfaces touched by this re-prove + deploy

- **Reflection guest / `BITCOIN_RELAY_VKEY`:** `fold_cbtc_lock` → track-not-mint (no note append, no
  opening sigma); PV gains the proven `cbtcLocksFolded[]` + `cbtcLocksSpent[]` arrays (alongside
  `cbtcBackingSats`). The persistent `cbtc_locks` root stays in `digest()` as today, so
  **`REFLECTION_GENESIS_DIGEST` is unchanged** — only the vkey rotates.
- **Settle guest / `PROGRAM_VKEY`:** `OP_CDP_MINT/CLOSE/LIQUIDATE` (15/16/17); `cdp_position_leaf` +
  `CDP_POSITION_DOMAIN`; `derive(controller)` debt-asset rule; PV gains the CDP position/mint/liquidation
  arrays. (The existing 15 ops unchanged.)
- **`ConfidentialPool`:** extend `BitcoinRelayPublicValues` (the two lock roots); the cBTC escrow-mint +
  slash seam (immutable pointer to the engine); the CDP controller-callback seam (`onCdpMint/Liquidate/
  Close`); the `derive(controller)` mint-authority check; the `cdpPositionRoot` accumulator. Deploy with
  the new vkeys + genesis digest + the `CollateralEngine` pointer.

## 8. Trust ledger (honest, whole-system)
- **cBTC peg:** none/oracle-free (conservation). **cBTC rug coverage:** economic (escrow), Chainlink
  2nd-order. **cBTC custody:** self-custody, none.
- **cUSD peg:** CDP over-collateralization; **Chainlink BTC/USD 1st-order** (stablecoin, by design).
- **Inflation:** none — every mint is conservation- or membership-proof-gated; controllers mint only
  their own derived asset.
- **Controller blast radius:** bounded to its own asset's holders.
- **Admin:** the immutable core has none; the engine/controllers are DAO-tunable within bounds and can
  only deny/size/route, never mint or move backing.

## 9. Build plan + the re-prove gate

1. **Reflection per-lock surfacing** (cxfer-core + reflect.rs + JS mirror + KATs) — §3.1. Rotates the
   genesis digest.
2. **Generic CDP ops** in the settle guest (cxfer-core leaf/primitives + main.rs dispatch + KATs) — §4.
3. **`ConfidentialPool`** seams (PV, cBTC mint/slash, CDP callback, derive-mint-authority) + the new
   `CollateralEngine` + `CdpController` (cUSD) — §§3,4,5,6. Retire `CbtcBuffer`/`InsuranceVault`.
4. **Forge + cxfer-core + JS suites green** against the new layout (fixtures regenerated).
5. **Box re-prove** (vast.ai, committed canonical ELFs) → new `PROGRAM_VKEY` + `BITCOIN_RELAY_VKEY` →
   pin in `elf-vkey-pin.json` → update `REFLECTION_GENESIS_DIGEST` + `DeployConfidentialPool` defaults.
6. **Deploy** on the new vkeys + genesis + engine pointer; `readiness-gate.sh`.

The re-prove is the irreversible gate: §§1–8 are the immutable surface, frozen at step 5. Steps 1–4 are
fully local + testable; step 5 needs the box; step 6 is the launch.

## 10. What this deliberately does NOT foreclose (mutable programmability)
- **Multi-asset / MakerDAO-style baskets** — a controller that accepts `n>1` legs (cBTC + Tacit LP shares
  + Tacit/bridged assets + arbitrary ERC20s) with **smart-contract-governed per-asset ratios**. The
  basket position + leg-carrying callback are frozen into v1; only the controller is new. **No re-prove.**
- New stablecoins / lending / leverage = a new `CdpController` (own derived asset, own oracles/ratios) —
  no re-prove.
- Collateral can be **any** confidential note (any Tacit or bridged-Bitcoin asset), so Bitcoin-homed
  assets gain CDP programmability through the same ops.
- Richer policy (dynamic ratios, interest, partial liquidation, stability fees) = controller logic, mutable.
- Full amount-privacy for CDP positions (hide the boundary amounts via a committed-capacity attestation)
  = a later, additive controller+guest option; the v1 boundary-public model is the simple, sound start.
