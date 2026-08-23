# CollateralEngine — accepted trust boundary (audit response A4)

The cUSD CDP/savings engine is **DAO-governed** by design (Solady `Ownable`, `onlyOwner`). This document records the accepted trust surface and the immutable floors that bound it, per audit finding A4. The audit verified there is **no non-governance inflation path**; the residual risk is the oracle feeds and the governance key operating *within* the levers below.

## Immutable floors (cannot be changed by governance — frozen in the contract)
| Constant | Value | Purpose |
|---|---|---|
| `MAX_FEE_PER_SECOND` | `RAY + 1e19` (~37%/yr cap) | a fat-finger stability-fee rate can't explode `rate` |
| `FEED_CHANGE_LIQ_GRACE` | 6 hours | liquidations freeze after any `setFeeds` so a feed swap can't insta-liquidate |
| `MIN_ESCROW_GRACE_WINDOW` | 3 days | the floor on the escrow-health grace window (lockers always get a non-instant exit) |
| `cdpRatioBps` bounds (`setParams`) | `_liqRatioBps ≥ 11000`, `_liqRatioBps < _cdpRatioBps`, `_cdpRatioBps ≤ 100000` | liquidation ratio ≥ 110%, always below the mint ratio; mint ratio ≤ 10× |
| `setDeviationBound` | `bps ≤ 10000`, non-disableable once armed (`maxDeviationBps != 0 && bps == 0` reverts) | once a deviation bound is set it can't be silently turned off |
| `setEscrowHealthParams.graceWindow` | `∈ [MIN_ESCROW_GRACE_WINDOW, 30 days]` | grace window can't be set below 3 days |
| Reciprocal binding | pool's `COLLATERAL_ENGINE()` is immutable; `setPool` requires `COLLATERAL_ENGINE()==this` | engine↔pool wiring is one-time and can't be re-pointed |

## Governance levers (onlyOwner = the DAO) — record the launch configuration
Fill these in at deploy and publish alongside the deploy block:

- **Owner** = `____________` (MUST be a timelock/multisig, not an EOA). This is the trusted party.
- `setFeeds(ethBtc, btcUsd, ethBtcTwap, btcUsdTwap)` — the price feed set. Record each feed address + provider. BTC/USD is peg-load-bearing.
- `setDeviationBound(bps)` — `maxDeviationBps`. **Launch value = `____` bps.** Note: it is 0 (skip) by default; the audit (and our own contracts review) recommends **arming it before enabling the stability fee**, since a single manipulated valid oracle round is otherwise unbounded (the engine fails *closed* on stale/zero/negative, but not on a manipulated-but-fresh round).
- `setParams(maxStaleness, escrowRatioBps, cdpRatioBps, liqRatioBps)` — launch ratios. Defaults: `cdpRatioBps = 15000` (1.5×). Record launch values.
- `setStabilityFee(perSecondRay)` — DORMANT until governance activates. Bounded by `MAX_FEE_PER_SECOND`.
- `setEscrowHealthParams`, `setEscrowEnforcementModule` — escrow health config.

## FarmController double-gating (A4 sub-item) — VERIFIED
The reward mint is tied pool-side, not controller-side: `ConfidentialPool` holds `farmTreasury[controller]` and enforces the invariant `escrow[asset] == Σ outstanding reward notes + Σ farmTreasury holds` (ConfidentialPool.sol:510-515, drain at 1637-1656). The pool — not the FarmController — ties the reward leg to the treasury check, so a FarmController defect can at worst misallocate among stakers, never mint unbacked reward value. Confirmed correct.

## Position
Accepted as the stated trust model. The immutable floors are enforced in frozen code (verified). The launch configuration above must be documented and the owner set to a timelock/multisig before freeze; arm `maxDeviationBps` before the stability fee is ever enabled.
