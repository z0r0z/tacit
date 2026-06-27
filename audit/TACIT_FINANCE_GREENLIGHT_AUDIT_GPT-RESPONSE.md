# Maintainer response — GPT greenlight audit (bundle @ `af73a2e`)

Final pre-reprove pass over the immutable surface. Four findings; two real and fixed, two not.

| # | Finding | Severity (claimed) | Verdict | Disposition |
|---|---------|--------------------|---------|-------------|
| 1 | CDP liquidation recipient/fee/seized unbound | Critical | **Not a bug** | Refuted — see below |
| 2 | ETH-reflection storage-slot +2 offset | Critical (needs confirm) | **False positive** | Verified vs compiled layout |
| 3 | `rate_snapshot` unbound in CDP mint / wrap-CDP-mint | High | **Real** | **Fixed** (guest binding) |
| 4 | `rps_entry` unbound in farm/LP bond | Medium | **Real** | **Fixed** (guest binding) |

Commit: `f8cfc40` (guest + JS mirrors + parity tests + fixtures). The two fixes change the settle
guest's signed transcript, so they ride the coordinated re-prove (settle `program_vkey` rotates; the
`*_groth16.json` proofs regenerate from the committed guest on the box).

## #3 — `rate_snapshot` unbound (CDP mint / wrap-CDP-mint) — FIXED

Confirmed: `rate_snapshot` was read from the witness but absent from all four opening-sigma contexts
(`tacit-cdp-mint-collateral-v1`, `tacit-cdp-mint-debt-v1`, `tacit-wrap-cdp-mint-collateral-v1`, and
the shared wrap-CDP-mint debt context). `CollateralEngine.onCdpMint` accepts any
`RAY ≤ rateSnapshot ≤ rate`, and close/liquidate compute `owed = principal·rate/rateSnapshot` — so a
delegated proving box could substitute a stale low snapshot (e.g. `RAY`) and overcharge the borrower
once a stability fee is armed. Dormant today (`rate == RAY`), but the guest is immutable, so it must
be closed before lock. **Fixed:** `rate_snapshot` is now bound into all four contexts as a synthetic
note tuple `(rate_snapshot, nonce, owner)` (mirroring the `controller32` binding). The engine's
`[RAY, rate]` band is intentional drip-tolerance (the box constructs the proof before settle), so we
bind the *user's* signed snapshot rather than tightening the contract to `== rate` — which would break
liveness under an active fee. A box can no longer change the snapshot the borrower authorized.

## #4 — `rps_entry` unbound (farm / LP bond) — FIXED

Confirmed: `rps_entry` (the receipt's reward-per-share entry checkpoint) was read but absent from the
`tacit-farm-bond-leg-v1` and `tacit-lp-bond-v1` contexts; `FarmController` rejects only
`rpsEntry < liveRps`, so an arbitrary *future* `rpsEntry` is accepted. A box could future-date it, and
the receipt then cannot harvest until rps catches up — yield-grief (principal recoverable via unbond).
**Fixed:** `rps_entry` is now bound as `u128` hi/lo (two `u64` amounts) into both contexts. The honest
flow already tolerated build→settle drift the same way, so binding doesn't change liveness — it only
stops a malicious box substituting a far-future value.

## #1 — CDP liquidation recipient/fee/seized-legs unbound — NOT A BUG

The threat model ("a box redirects seized collateral while reusing the user's debt-note
authorization") does not apply. Liquidation is **permissionless**, and the debt notes burned are the
**liquidator's own** — the opening-sigma signer *is* the liquidator. There is no third party whose
authorization is replayed: a box that redirected the seized basket would simply be robbing the
liquidator who hired it, and the liquidator always has the cheaper recourse of self-settling
(`fee = 0`, `liquidator = self`). `fee < first seized leg` is asserted, and the whole-repay / health
intent is bound via `position_leaf` (which commits `basket_root`, `debt_value`, `rate_snapshot`) with
`repaid ≥ debt_value` enforced. Same trust shape as OP_CDP_CLOSE's relay-fee model. No change.

## #2 — ETH-reflection storage-slot +2 offset — FALSE POSITIVE

The auditor flagged this "needs confirmation" because the bundle imports (not vendors) Solady's
`ReentrancyGuardTransient`, so they assumed `nextLeafIndex` sits at slot 0 and derived 74/117/118/161
vs the guest's 76/119/120/163. Against the **compiled** layout
(`forge inspect ConfidentialPool storageLayout`), the guest constants are exactly correct
(`crossOutCommitment` 76, `bitcoinConsumed` 119, `bitcoinConsumedCount` 120, `bitcoinConsumedAt` 163)
— `nextLeafIndex` is at **slot 2** (two persistent slots precede it, exactly the `+2` the auditor
hypothesized). The CI assertion they recommend already exists and runs every build
(`contracts/sp1/confidential/verify-reflection-slots.sh`). No code change.

## Net
No fund-critical issue stands. The two real delegated-proving gaps (#3, #4) are fixed in the guest
with JS mirrors + fixtures regenerated and `cxfer-core` 151/151 green; they fold into the coordinated
re-prove. The surface is greenlight-ready for the re-prove + testnet pending that re-prove.
