# Tacit — cBTC / cUSD / CDP Focused Review (Claude Opus 5)

**Model / mode:** Claude **Opus 5**, single reviewer, continuous session. Companion to
[`AUDIT-2026-09-19-public-release-review.md`](./AUDIT-2026-09-19-public-release-review.md), which cleared the
pool's immutable surface for publication. That review deliberately deferred the collateral layer, because its
trust model is different and deserves its own pass.
**Date:** 2026-09-19 · **Branch:** `main` at `f3917087` · **Posture:** live on Ethereum mainnet; scoped to *will
this work properly under adversarial conditions once the door is open*.

## Scope

- `CollateralEngine.sol` (1245 lines) in full — the mutable, owner-governed policy contract that is
  simultaneously the cBTC escrow gate and the cUSD CDP controller.
- `CbtcEscrowHelper.sol`, `ChainlinkWstEthBtcAdapter.sol`.
- The cBTC lock lifecycle in the reflection guest: `fold_cbtc_lock`, `fold_cbtc_redeem`,
  `fold_cbtc_lock_spends`, and the pool-side registry (`cbtcLockVBtc` / `cbtcLockCommitment` /
  `cbtcLockSpent` / `cbtcLockRedeemed` / `cbtcMinted`).
- The settle guest's `OP_CBTC_MINT` and the CDP family (`OP_CDP_MINT` / `CLOSE` / `LIQUIDATE` / `TOPUP`,
  `OP_WRAP_CDP_MINT`, `OP_SURPLUS_DRAW`) and their pool-side gates.
- **The live mainnet configuration** — every governance parameter, both oracle legs, and the actual state of
  the one cBTC lock currently tracked.

**Second pass (same session).** Three coverage gaps this review initially left open were closed before
publication, and are recorded as such rather than quietly folded in:
- the TSR savings accounting (`drip` / `_accrueFee` / `_bookSurplusFee` / `_retirePosition` / `_savingsReceipt`
  / `_surplusDraw`) and its `feeBudgetCusd` invariant — the path where an accounting error mints unbacked cUSD;
- `fold_cbtc_lock`, the lock-registration fold (the redeem and rug folds were covered in the first pass);
- the keeper-side liquidation tooling, end to end from position discovery to a deployed prover binary.
Findings 2, 9 and 10 are the result.

## Verdict

**The mechanism design is sound. The launch configuration is not yet ready for adversarial public release.**

Almost every gap found is an economic parameter, a bootstrapping dependency, or an operational precondition —
the contracts do what they claim, and what is missing is the capital and market structure that make the claims
hold under stress.

**Finding 9** is the one item that is structural rather than configurational: an unliquidatable position keeps
accruing stability fee into the TSR's mint authorization, because bad debt can only be retired by actually
liquidating it. That is a deliberate consequence of confidentiality (the engine cannot enumerate positions, so
there is nothing to write off *on paper*), and the intended remedy — a reserve-funded liquidation via
`drawInsuranceFor(CDP_BAD_DEBT)` — is already designed in. It reduces to Finding 3: the remedy needs capital
the reserve does not yet hold. Fully inert while the stability fee is dormant.

Two properties need stating plainly in any public material, because neither is what a reader will assume:

- **cBTC is economically secured, not custodially guaranteed.** The locker self-custodies the Bitcoin and *can*
  spend it. The wstETH escrow is a deterrent sized to make that irrational — not a lock that makes it
  impossible. The system detects a rug reliably; it cannot prevent one.
- **cUSD's peg is genuinely oracle-dependent.** Unlike cBTC, whose peg is conservation (burn ⇄ backing),
  BTC/USD is load-bearing for cUSD in the Maker sense.

## Method

Read the engine and the cBTC fold path adversarially, then **read the live deployment** rather than the defaults
— several findings below exist only in the configuration, and would be invisible in a source-only review.
Priced paths were exercised against mainnet to confirm the oracle composition actually works end to end.

## Live state observed (mainnet, 2026-09-19)

| Parameter | Value | Note |
|---|---|---|
| `owner` | `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` | the 2-of-4 ops multisig; also `LINEAGE_STEWARD` |
| `btcUsdFeed` | `0xF403…E88c` | the canonical Chainlink BTC/USD mainnet feed |
| `wstEthBtcFeed` | `0x0000…d62c` | `ChainlinkWstEthBtcAdapter` (wstETH/USD ÷ BTC/USD) |
| `wstEthBtcTwap` / `btcUsdTwap` | `0x0` / `0x0` | **no second source wired** |
| `maxDeviationBps` | `0` | **deviation bound skipped** |
| `maxStaleness` | `3900` | 65 min, above Chainlink's 3600 s heartbeat — correct headroom |
| `escrowRatioBps` | `15000` | 1.5× |
| `cdpRatioBps` | `15000` | 1.5× mint floor |
| `liqRatioBps` | `13000` | 1.3× — **raised** from the 1.25× default, widening the liquidator margin |
| `escrowMaintenanceBps` / `escrowEnforcementModule` | `0` / `0x0` | margin call **dormant**, as designed |
| `stabilityFeePerSecond` | `0` | fee **dormant** |
| `outstandingCusd` | `0` | **no CDP has ever been opened** |
| `insuranceReserve` | `0` | **the backstop is empty** |
| `cbtcBackingSats` (pool) | `3400` | one real Bitcoin lock is tracked |
| tacBTC / tacUSD `totalSupply` | `0` / `0` | neither has been exited to its public ERC-20 |

Priced paths exercised live: `btcToUsd(1e8)` → **$81,090.12/BTC**; `wstEthForBtc(1e8)` → **24.605 wstETH**;
`requiredEscrow(1e8)` → **36.908 wstETH** (exactly 1.5×). Adapter round 31 minutes old against the 65-minute
bound. **The oracle composition works.**

**One live observation worth recording.** For the single tracked lock (3400 sats):

```
requiredEscrow(3400)  = 1,254,874,943,100,033 wei wstETH   (1.5×)
wstEthForBtc(3400)    =   836,583,295,400,022 wei wstETH   (1.0×)
engine wstETH balance =   803,645,480,791,482 wei          (insuranceReserve == 0, so all of it is escrow)
```

That lock currently sits at **64% of its required escrow, and 96% of the locked BTC's value**. Two things follow,
and they are the finding in miniature:

1. **The mint gate works, fail-closed.** `escrowSufficient` returns false, so no cBTC can be minted against that
   lock at the current mark. Correct behaviour, observable on-chain.
2. **Nothing on-chain moves it back.** Whether the cause is a deliberate partial post or adverse wstETH/BTC
   drift, the escrow has fallen below 1× the locked BTC value and there is no armed mechanism that notices or
   corrects it. That is exactly the exposure of Finding 4, visible on mainnet today.

## What the design gets right

**The rug/redeem discrimination is sound and race-free.** `fold_cbtc_redeem` requires the lock outpoint to be a
**vin of the very transaction** that burns cBTC, requires the lock be tracked at exactly `v_btc`, and
kernel-verifies that the cBTC inputs sum to exactly `v_btc` with no cBTC output. The redeem is folded **before**
the rug scan and removes the lock from the live set, so `fold_cbtc_lock_spends` never sees it and an honest
redeemer can never be slashed. Symmetrically, a rugger cannot spoof a redeem without genuinely burning the
cBTC — at which point backing and supply fall together and it is not a rug. There is no ordering window here.

**Governance restraint is real, not decorative.** Every owner move that could hurt a borrower gives public
notice: a feed swap arms `FEED_CHANGE_LIQ_GRACE`; *raising* `liqRatio` arms it too; `MIN_ESCROW_GRACE_WINDOW`
is a 3-day floor the owner cannot shorten. And re-submitting identical feed addresses deliberately does **not**
reset the grace clock — closing the otherwise-obvious trick of freezing liquidations indefinitely while bad
debt accrues.

**Health is measured against accrued debt, never principal** — at mint, at close, at liquidation and at top-up —
so a position becomes seizable as the fee erodes it, and a dust top-up cannot roll an underwater position out
of range.

**The subtle case is closed.** A stale rate snapshot can make normalized debt floor to zero, which would mint
real principal while adding nothing to the accumulator — and at close would book the whole principal as
recyclable, unbacked fee surplus. Rejected on both the engine and guest sides.

**The TSR accounting itself is correct**, which is worth stating because Finding 9 sits next to it. The
invariant `feeBudgetCusd == outstandingSavingsReward() + surplusFeeCusd` is preserved across all six mutation
paths (surplus booking, fee accrual with and without savers, bond, harvest, unbond, surplus draw), and it has
an on-chain checker. The non-obvious part is right: because `floor(sum) >= sum(floor)`, booking the surplus from
a *per-event* floor would place the same base unit in both the surplus and the saver entitlement, so both
`_accrueFee` and the harvest branch book it from the **change in the aggregate** instead — which is what makes
the invariant hold exactly rather than approximately. `shares` is bound to the receipt leaf by note-tree
membership in both bond and harvest, so it cannot be inflated; harvest replay is double-gated (the pool's
one-shot `harvestActionIds` and the engine's re-stamp driving the window to zero); and the
`_tsrSavingsBondedThisTx` guard is unreachable by construction, since `drip()` no-ops after its first call in a
block — correctly exempting `_bookSurplusFee`, which bumps no rps.

Also correct: `MAX_LIQ_RATIO_BPS` caps how much equity a liquidation can take; the escrow is per-funder so
"anyone may fund" creates no claim race; `_basketUsd` hard-restricts collateral to cBTC; the fee-budget
invariant `feeBudgetCusd == outstandingSavingsReward() + surplusFeeCusd` has an on-chain checker; and
`CbtcEscrowHelper` correctly solves the funder-of-record problem with its own per-depositor share accounting
and a stated solvency invariant.

## Findings

None is a code defect. Severity is stated against *public launch*, not against the source.

### 1. No cUSD debt ceiling — and one can never be added *(launch-blocking)*

Nothing bounds `outstandingCusd`; it is accounting only. This matters more than the usual missing-parameter
finding because the pool pins `COLLATERAL_ENGINE` **immutably**, so introducing a ceiling later would require a
whole new pool generation and a migration of all escrow and CDP state.

The only throttle available is `cdpRatioBps` (bounded at 10×), which makes minting capital-inefficient rather
than capped. Blunt, but it is the lever — and it should be used deliberately from day one rather than
discovered later.

### 2. Liquidation tooling is complete but unoperated, and blocked on cUSD inventory *(launch-blocking)*

`onCdpLiquidate` requires burning cUSD notes summing to the **full** accrued `owed`. There is no partial
liquidation and no auction — it is all-or-nothing per position.

**The tooling is not the gap.** `tools/cdp-liquidation-keeper.mjs` does the whole job: enumerate
`CdpPositionInserted`, decode each settle's `cdpMints` (owner is published and the nonce is pinned to 0, so
every leaf is keeper-reconstructable), drop positions whose nullifier appears in a later close or liquidation,
price BTC/USD against Chainlink with the same staleness gate the engine uses, and compare to the live
`liqRatioBps`. The path behind it is fully wired — `cdpliquidate` is in the worker's submit allowlist and the
relay's `PEROP` map, and **`exec-cdpliquidate` is among the 37 prover binaries actually deployed**. It even
supports gasless relayed liquidation, carving the relay fee from the first seized leg so a keeper needs no ETH.

Three things stop it working at launch:

- **Nobody runs it.** `worker-relay/render.yaml` deploys seven services; none is a keeper. The script also
  defaults to `NETWORK=signet`.
- **A keeper must hold cUSD.** At launch the only cUSD in existence is what borrowers minted, and the
  confidential AMM pools on gen5 are deliberately unseeded — so the liquidator set is a subset of the borrower
  set, and a keeper without inventory must open their own CDP purely to obtain ammunition.
- **A borrower holding the only cUSD cannot be liquidated by anyone.**

This is a sequencing problem, not a design one: cUSD secondary liquidity must exist, and a keeper must be
running, before cUSD supply is allowed to matter.

### 3. `insuranceReserve` is empty *(launch-blocking)*

It is the declared backstop for both cBTC rug shortfall and cUSD bad debt, and it currently holds nothing.
`fundInsurance` is permissionless. Fund it before launch and publish the figure — an advertised backstop that
is empty is worse than one that is absent.

### 4. The cBTC rug deterrent decays with wstETH/BTC, and the margin call is dormant *(high)*

A locker who rugs keeps `v` BTC and `v` cBTC and forfeits escrow `E`, so **rugging becomes profitable once
`E < v`**. Escrow is 1.5× at post time, so the deterrent survives roughly a **33% depreciation of wstETH
against BTC** and no more. `escrowMaintenanceBps == 0` with no enforcement module means nothing currently
notices or corrects the drift.

Compounding it: wstETH carries stETH depeg risk *on top of* ETH/BTC price risk, and a depeg is precisely the
regime in which ETH/BTC is also falling — the two risks are correlated, not independent.

Acceptable for short locks; genuinely exposed for long-dated ones. The live lock above already sits at 0.96×.

### 5. Single-source oracle, with a correlated coupling *(medium)*

`maxDeviationBps == 0` and no TWAPs, so one Chainlink round sets the mark for both escrow sizing and the cUSD
peg. The second-source seam exists and `setDeviationBound` is correctly one-way once armed, but it is not
wired.

Worth being explicit about the composition: `wstETH/BTC = wstETH/USD ÷ BTC/USD`, and BTC/USD is *also* the cUSD
peg feed. The directions differ usefully — a BTC/USD print that is too high inflates cUSD collateral value
(over-mint) while simultaneously *raising* the cBTC escrow requirement (conservative there). So the dangerous
direction is unambiguous and singular: **BTC/USD marked too high is a cUSD over-mint.**

### 6. Bad-debt band below par *(medium, inherent)*

Liquidation is profitable between 1.3× and 1.0× and irrational below par. With no partial liquidation and no
auction, a fast drawdown exceeding ~30% between liquidation opportunities leaves positions no keeper will
touch, and the shortfall lands on the reserve — currently empty (Finding 3). Raising `liqRatio` to 1.3×
already widened this band; the residual is inherent to whole-basket liquidation.

### 7. cBTC peg repair after a rug is a governance action, not code *(medium)*

A rug slashes the escrow to the reserve **in wstETH**, while the now-unbacked cBTC remains in circulation.
`cbtcBackingSats` is surfaced on the pool but nothing on-chain consumes it. The repair is a manual
`drawInsuranceFor` buy-and-burn at a size and speed nobody is bound to. That is a governance promise and should
be described as one rather than as a mechanism.

### 8. The engine is permanently owned *(low, deliberate)*

`renounceOwnership` is disabled — correctly, since a deprecated Chainlink feed would otherwise freeze every
priced path forever with no way to repoint it. The consequence is that cUSD/cBTC governance can never be fully
dissolved, and `drawInsurance` carries no timelock. Publish the 2-of-4 signer set alongside the claim.

### 9. Bad debt must be retired with capital, not accounting — and the reserve that funds it is empty *(medium; a precondition on arming the stability fee, not a live defect)*

`normalizedDebtRay` — the aggregate normalized debt `drip()` accrues the fee against — is decremented in
exactly one place, `_retirePosition`, reachable only from `onCdpClose` / `onCdpLiquidate`, both of which
require `repaid >= owed`. **There is no write-off path.** A position that becomes bad debt and is never
retired keeps its `art` in the aggregate permanently, and every `drip()` keeps crediting
`art · Δrate / RAY` into `feeBudgetCusd`.

That budget is the mint authorization the TSR draws on: a saver harvests up to
`min(shares · window / PRECISION, feeBudgetCusd)` and the pool mints that cUSD fresh. So an unliquidatable
position causes savers to mint cUSD against interest **nobody will ever burn**, indefinitely and compounding.
At the `MAX_FEE_PER_SECOND` ceiling (~37%/yr) a stuck $100k position authorizes on the order of $37k/yr of
unbacked saver mint. The only cure is for someone to liquidate it voluntarily at a loss — precisely the thing
nobody is incentivised to do below par (Finding 6).

To be precise about what is *not* wrong here: crediting the budget as interest accrues, ahead of collection, is
sound on its own. While a position is live, circulating cUSD (borrower principal + saver mint) equals the total
accrued debt, and that debt is collateralized at >= 1.5x. The defect is only in the terminal case — a position
that never retires — where the accrual has no counterparty obligation behind it and nothing removes it.

**Why there is no write-off — the design reason, which is a good one.** The engine cannot enumerate CDP
positions. It never holds a `positions[]` mapping; it learns a position exists only when a *proof* presents
one, and `normalizedDebtRay` is an aggregate it maintains blindly. That is the confidentiality property, not an
oversight. So "write off position X" is not expressible on the contract side at all: retiring a position
requires consuming its nullifier, which requires a guest op. A paper write-off would also double-count, since
the position's leaf is still live and a later liquidation would decrement `normalizedDebtRay` a second time.

**And the intended remedy is already there.** `drawInsuranceFor` names `keccak256("CDP_BAD_DEBT")` as an
example purpose tag: the DAO draws wstETH from the reserve, obtains cUSD, and **liquidates the bad position
itself at a loss**. That runs `_retirePosition` through the normal path, so `art` leaves the aggregate and the
phantom accrual stops. It is self-contained — the DAO can open its own overcollateralized CDP to source the
cUSD if no market exists — and it is more honest than a paper write-off, because the shortfall is realized in
capital rather than erased in accounting.

So the correct statement of this finding is not "a write-off is missing and unfixable." It is: **bad debt is
retired with capital, and the capital is currently zero** (Finding 3). Until the reserve is funded and someone
is watching, a stuck position's accrual runs unchecked.

Inert today regardless: `stabilityFeePerSecond == 0`, so `drip()` returns before `_accrueFee` and `savingsRps`
never moves — and with `outstandingCusd == 0` there are no positions at all. The path is unreachable, not
merely unlikely. Treat `setStabilityFee` as the single gate it is: arm it only after liquidation has fired
live, the reserve is funded, and a written bad-debt runbook exists.

### 10. `fold_cbtc_lock` accepts any scriptPubKey *(low, disclosure)*

The lock fold is otherwise clean — asset pinned to `CBTC_ZK_ASSET_ID`, the pre-committed commitment must be a
real curve point, `v_btc` read from the confirmed transaction output, zero value and `vout == 0` rejected
(the latter keeping lock outpoints disjoint from note outpoints), duplicate outpoints skipped rather than
panicking, and the returned `commitment_hash` binding the mint to exactly the locker's pre-committed note.

But the lock output may carry **any** scriptPubKey — the code says so explicitly: *"the LOCKER'S OWN output
(self-custody, ANY scriptPubKey — no vault, no custodial key)"*. The protocol never verifies that whoever
marked the output controls it. Marking an output you do not control is a footgun rather than an attack (you
forfeit your own escrow when the real owner spends it, and a griefer would have to fund the escrow themselves),
but it confirms the property that matters for disclosure: **a cBTC lock is an ordinary spendable UTXO
distinguished only by an envelope, not a covenant.** That is what makes the accidental-spend hazard real, and
what the reserved `OP_COVENANT_MINT` opcode is held open to fix once CTV/CCV/CSFS activate.

### 11. `CbtcEscrowHelper` is trusted by its own users *(low, disclosure)*

Because the engine keys `escrowOf` by `msg.sender`, any escrow funded through the helper makes the **helper**
the engine's funder-of-record. Depositors then depend on the helper's own share accounting for their refund
path — the engine cannot return it to them directly. The helper handles this correctly and states its solvency
invariant, but users funding through it are trusting a second contract that users funding the engine directly
are not. Worth one line in the docs.

## Launch gates

1. **Seed a cUSD pool with real depth.** Everything about cUSD's safety is downstream of this.
2. **Fund `insuranceReserve`**, and publish the amount.
3. **Set `cdpRatioBps` conservatively high** as a soft debt ceiling until a liquidation has been demonstrated
   live, then relax it.
4. **Arm `setDeviationBound` with a TWAP** once a pool is deep enough to bound rather than to be manipulated —
   in that order, never before.
5. **Exercise both paths on mainnet**: one full cBTC lock → mint → redeem cycle, and one deliberate
   liquidation, before advertising either.
6. **Document cBTC as economically secured**, with the ~33% figure in the text.
7. **Do not arm the stability fee** until (4) has happened and a bad-debt write-off path exists — see
   Finding 9. Arming it before then converts any unliquidatable position into a permanent, compounding
   authorization to mint unbacked cUSD.

## Design decisions recorded, not findings

- **Whole-basket liquidation with no auction.** Simpler and atomic (the debt is burned inside the proof before
  collateral can leave), at the cost of the sub-par band in Finding 6 and the ammunition requirement in
  Finding 2. A partial-liquidation path would need a guest change, so it is a next-generation decision.
- **Escrow denominated in wstETH rather than the collateral asset.** Yield-bearing and liquid, but it makes the
  deterrent's strength a price ratio rather than a constant (Finding 4).
- **Stability fee and TSR ship dormant.** Correct sequencing: the accumulator, the savings vault and the
  surplus-draw authorization are all live in code and provably inert at `rate == RAY`.
- **cUSD collateral is cBTC-only** (`_basketUsd` reverts otherwise). Conservative and right for v1; it also
  means cUSD inherits every cBTC risk above, in full.

## Evidence

- All parameters, balances and priced paths read live from mainnet via `ethereum-rpc.publicnode.com` against
  engine `0x000000003f608BDdF0ca45934003ffb9DbDF70DB` and pool `0x000000000Ed1eabD231Be41d93b719056F7febFC`.
- Liquidation path traced end to end: `tools/cdp-liquidation-keeper.mjs` -> `buildCdpLiquidateOp` ->
  `liquidateCdp` -> worker submit allowlist -> relay `PEROP` -> `worker-relay/prover/bin/exec-cdpliquidate`
  (present among 37 deployed binaries). `worker-relay/render.yaml` confirmed to deploy no keeper service.
- `forge test`: 884/884 across 88 suites, including `CollateralEngine.t.sol`, `ConfidentialCdpCbtcSettle.t.sol`,
  `ConfidentialCbtcLink.t.sol`, `CbtcEscrowHelper.t.sol`, `ChainlinkWstEthBtcAdapter.t.sol` and the
  `ConfidentialWrapCdpMintProofReal` / `ConfidentialCdp*ProofReal` real-Groth16 fixtures.

## Files changed by this review

None. This pass produced no code change.
