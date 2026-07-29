# Solvent confidential cUSD stability fee (H-01)

Design for sign-off. Fixes the insolvency GPT-H-01 found: today the fee is **realized on close**
(`_accrueFee(repaid − principal)` in `onCdpClose`), so the fee cUSD a borrower must burn to close never exists
until *after* a close creates it — circular, so the last fee-bearing position can't close or be liquidated.

The fix is structural, not a patch: **mint the fee into the fee budget as it ACCRUES (on `drip`), not after
repayment**, so the accrued fee cUSD is injectable into circulation (via saver harvests / surplus draws)
*before* any borrower needs to acquire it to repay. This is MakerDAO's stability-fee structure adapted to
Tacit's proof-minted cUSD.

## Root cause (verified against code)

- `onCdpMint`: `outstandingCusd += debtValue` (principal only). Position stores `rateSnapshot ∈ [RAY, rate]`.
- `drip`: compounds `rate` (`rate *= (fee/RAY)^dt`). Mints nothing.
- `_owed(principal, snap) = principal·rate/snap` (rounded up) — grows with the fee.
- `onCdpClose`: requires `repaid ∈ [owed, owed·1.01]`, then `outstandingCusd -= principal` and
  `_accrueFee(repaid − principal)` credits `feeBudgetCusd` + distributes to savers.

So system-wide `Σ cUSD minted = Σ principal`, but `Σ debt = Σ owed = Σ principal + Σ fee`. The deficit is the
outstanding unrealized fee, and it always lands on the last open position.

## Target invariant (what "solvent" means)

Let `P = outstandingCusd` (principal in circulation), `D = aggregate debt`, `A = D − P` (accrued fee).
The redesign maintains, at all times:

> **`feeBudgetCusd` (accrued-but-not-yet-minted fee) + (fee cUSD already minted out and not yet burned) == A**,
> and **`A` is injectable into circulation without requiring any position to close.**

That second clause is the whole fix: the fee cUSD is *mintable on accrual* (through the existing saver-harvest
and `OP_SURPLUS_DRAW` paths), so a borrower can always acquire the `fee` cUSD needed to reach `owed` — the
circularity is broken.

## Mechanism

### 1. Track aggregate normalized debt `Art` (RAY-scaled)
A position's normalized debt is `art_i = principal_i · RAY / snap_i` (so `owed_i = art_i · rate / RAY`).
- `onCdpMint`: `Art += debtValue · RAY / rateSnapshot`.
- `onCdpClose` / `onCdpLiquidate`: `Art -= principal · RAY / snap` (the same `art_i`, recomputed from the
  position's `principal` + `snap`, both already passed in).

Aggregate debt `D = Art · rate / RAY = Σ owed_i` (modulo per-position round-up, see Rounding below).

### 2. Accrue the fee on `drip` (the core change)
`drip` currently just compounds `rate`. Change it to, on every compound `rate_old → rate_new`:
```
Δfee = Art · (rate_new − rate_old) / RAY        // aggregate interest accrued this drip
accrueFeeBudget(Δfee)                           // credit feeBudgetCusd + distribute to savers + book surplus
```
`accrueFeeBudget` is the CURRENT `_accrueFee` body (feeBudgetCusd += Δfee; saver rps bump; surplus = the exact
aggregate-delta remainder — the L-01 fix). It is unchanged; only its *call site* moves from close to drip.

### 3. Stop realizing the fee on close
`onCdpClose` no longer calls `_accrueFee(repaid − principal)` — that fee is already accrued via drips. On close:
- `outstandingCusd -= principal`
- `Art -= art_i`
- `feeBudgetCusd -= fee_i` where `fee_i = owed_i − principal` — the position's fee obligation is discharged; the
  `fee_i` cUSD the borrower burned was previously minted OUT of the budget (by a saver/surplus draw), so the
  budget must drop by exactly `fee_i` to conserve. (Deriving this decrement so the target invariant holds on
  every path is the delicate part — see Open items.)
- Over-burn `repaid − owed_i` (the ≤1% band): route to `surplusFeeCusd` as a donation, or tighten the band to
  exact `owed_i`. **Recommend tightening to exact `owed_i`** (no over-burn) to keep the ledger clean.
- `onCdpLiquidate`: same `Art`/`feeBudget` treatment; the seized collateral covers `owed_i`.

### 4. Injection paths (already exist, now load-bearing)
- **Saver harvest** (TSR): savers claim their rps share of `feeBudgetCusd`, minting fee cUSD notes into
  circulation. This is the primary path the accrued fee reaches borrowers.
- **`OP_SURPLUS_DRAW`**: governance mints the un-savered surplus as cUSD notes. This is the fallback that
  guarantees injectability even with zero savers, so the last position can always be closed.

## Why this is solvent (single-borrower wind-down, the failing case)
Alice mints 100; fee accrues to `owed = 101`. Drips credit `feeBudgetCusd += 1` as it accrues. With a saver, the
saver harvests 1 cUSD (minted); Alice buys it and closes (burns 101): `outstandingCusd 100→0`,
`feeBudgetCusd 1→0` (saver already harvested it), `Art→0`. With no saver, the 1 becomes surplus and governance
`OP_SURPLUS_DRAW`s it into circulation; Alice acquires it and closes. Either way the fee cUSD exists before Alice
must burn it. Solvent.

## Open items to nail in implementation (each needs a test)
1. **Exact `feeBudgetCusd` ledger.** Derive the credit (drip) / decrement (close, liquidate) so the target
   invariant `feeBudgetCusd + minted-out-fee == A` holds on EVERY path, including: partial saver
   harvest between drips, a close before any drip, over-collateralized vs underwater liquidation, and a fee
   toggled on then back off. This supersedes the L-01 proof (which was for the accrue-on-close model), so the
   surplus-accounting invariant must be re-proven for the accrue-on-drip model.
2. **Rounding.** `_owed` rounds up per position; `Art·rate` is an aggregate. `Σ ceil(owed_i) ≥ D_aggregate`, so
   the per-position fee a borrower burns can slightly exceed the aggregate accrued. Decide who eats the dust
   (protocol-favouring: borrower pays the ceil, the extra books to surplus) and prove no underflow of
   `feeBudgetCusd`.
3. **Drip cost / liveness.** `drip` now does a mint-accrual on every CDP hook. Confirm it stays O(1) (it is —
   `Art` is a single aggregate) and that a long dormant→active→dormant cycle can't overflow `Art·Δrate`.
4. **Guest coupling.** Does the settle guest need to surface anything new (it computes `owed` at prove time)?
   The accrual is contract-side on `drip`; the guest already binds `owed`/`principal`/`snap`. Confirm the guest
   needs no change → no settle-vkey rotation from H-01 (the C-01 eth-reflection fix already rotates the
   reflection side). If the close decrement needs a guest-surfaced `fee_i`, note the settle-vkey rotation.
5. **Economic audit.** Per GPT, a fee redesign needs its own economic review — the accrue-on-drip invariant,
   the saver/surplus injection, and the wind-down are the surfaces to model against a reference ledger.

## Scope / sequencing
Contract-side (`CollateralEngine`), likely no guest change (confirm item 4). Folds into the held reprove only if
item 4 needs a guest-surfaced field. It replaces the current dormant-and-broken fee with a dormant-and-solvent
fee — still ships fee-off (`stabilityFeePerSecond = 0`), but now safe for governance to activate. Re-run the
CollateralEngine invariant/fuzz suite against the accrue-on-drip model (the L-01 fuzz must be rewritten).
