# Confidential orderbook: repeated fills + decimals_scale pricing

Enhances OP_BID (the buyer-offline partial-fill limit order) from **single-shot** (one fill consumes
the order, remainder refunds) to a **resting order** that multiple sellers fill over time, plus a
**fractional price** (`decimals_scale`) so high/low-decimal pairs price without overflow or coarse rounding.

## TL;DR — effort split (the important finding)

- **Repeated fills = DAPP-ONLY. No guest change, no re-prove.** Each fill is *already* a standard
  OP_BID; the guest re-derives `V_fund = max_fill·price` and checks `chosen_f ≤ max_fill` + the refund,
  so a second fill against the refund is just a standard OP_BID with a smaller `max_fill`. "Resting" is
  a client/protocol pattern: re-key the buyer's notes so fills don't collide, publish the grid of
  openings, and chain the refund as the next funding. The guest (`contracts/sp1/confidential/src/main.rs`
  OP_BID) is untouched.
- **`decimals_scale` = a SMALL guest change → re-prove.** The pay/conservation math gains a denominator.
  Bundle it into the next coordinated re-prove (e.g. with the parked ZAMM first-mint WIP).

So we can ship repeated fills independently on the dapp, and fold `decimals_scale` into a guest re-prove.

---

## Background — current OP_BID (single-shot)

Guest (main.rs OP_BID) per fill: buyer funding note (asset_b, `V_fund = max_fill·price`) spent by
membership + nullifier + the buyer's opening sigma; seller delivers `chosen_f` of asset_a (grid-aligned,
`min_fill ≤ chosen_f ≤ max_fill`); emits the buyer's received note (`chosen_f` of asset_a), the seller's
pay (`chosen_f·price` of asset_b) + change, and — on a partial fill — the buyer's refund
(`(max_fill−chosen_f)·price` of asset_b). The buyer is offline: its note blindings are
`deriveNote(bidSecret, asset, chosenF)` and it pre-publishes the K grid openings (one per `chosen_f`).
Today the refund is **consumed** (the order ends after one fill).

---

## Part 1 — repeated fills (dapp-only)

### Model: the refund IS the next funding

A resting order is a **chain of standard OP_BID states**. State = the current funding note
(asset_b, `remaining = (max_fill − cumulative)·price`). Each fill:
- spends the current funding note (the previous fill's refund),
- delivers a grid amount of asset_a → the buyer's received note,
- pays the seller `f·price` of asset_b,
- emits the **new funding note** (`remaining − f·price`) — which the *next* fill spends.

Each of these is a standard OP_BID op with `max_fill' = max_fill − cumulative`. The guest verifies it
unchanged. Fills are **sequential settles** (a refund must land in the tree before the next fill can
prove membership against it) — which is exactly how a resting on-chain order fills.

### The one real change: re-key the buyer's notes (collision fix)

Today the received/refund blindings are keyed by `chosen_f`. Two fills of the same amount would derive
the **same** commitment → leaf/nullifier collision. Fix: key by the **cumulative-filled** state, which
is monotonic, so every fill's notes are unique:
- received note (fill advancing cumulative `C → C+f`): `deriveNote(bidSecret, asset_a, "recv", C)`
- funding/refund note at cumulative `C`: `deriveNote(bidSecret, asset_b, "fund", C)`

`bidSecret` stays the buyer's; the seller uses the **published** commitments + openings (can't forge them).

### Fixed-increment to keep the grid linear (avoid K²)

If sellers may fill any grid amount per fill, the buyer must pre-publish a received-note opening for
every `(state, fill-size)` pair → **K² openings**. Constrain each fill to exactly `increment` (a seller
wanting N lots does N sequential fills); then there is one opening per **state** → **K openings**
(`K = max_fill/increment`). Set `min_fill = increment` for resting orders. (The dapp can still let a
seller submit several lots back-to-back; they're separate settles.)

### What the buyer publishes (the resting bid)

For each cumulative state `C ∈ {0, inc, 2·inc, …, max_fill}`: the funding-note commitment + its buyer
opening sigma (so the next fill can spend it), and the received-note commitment + opening (so a fill can
mint it). ~2K openings total, all `deriveNote`-derived from `bidSecret`, published once. The seller of a
lot at state `C` uses `funding[C]` (spend) + `received[C]` (mint) + `funding[C+inc]` (the new remaining).

### Cancellation

The buyer knows every funding note's `deriveNote` blinding, so it cancels by spending the current
funding note (a plain transfer/withdraw) to reclaim the remaining asset_b. Any in-flight seller fill
against that state then reverts on the spent nullifier and re-quotes against the new head.

### Accumulation

The buyer accrues up to K received notes of `increment` each; it consolidates them with one `cxfer`
(multi-in → 1-out). Minor dust UX, not a soundness issue.

### Why it's sound (no guest change needed)

- **No over-fill:** the funding chain strictly decreases by `f·price` per fill; it can't go negative
  (the guest's existing refund non-negativity), so cumulative ≤ max_fill.
- **No collision:** cumulative-keyed notes are unique per fill.
- **No theft:** the buyer's received/funding notes are bound by the buyer's pre-published openings (the
  seller can't redirect/relabel); the seller's notes by the seller's online context. Both are exactly
  the existing OP_BID guarantees.
- **Serialized fills:** two sellers racing the same state both spend the same funding nullifier → the
  second reverts `NullifierAlreadySpent` and re-quotes. Natural orderbook serialization.

### Dapp work

`dapp/confidential-bid.js`: `buildRestingBid` (publish the grid, cumulative-keyed), `fillRestingLot`
(seller fills one increment against the current head), `verifyRestingFill` (mirror — still a standard
OP_BID verify), `cancelBid`. Plus the head-tracking (which funding note is current) in the
worker/indexer. No `contracts/` or guest changes.

---

## Part 2 — decimals_scale pricing (small guest change → re-prove)

Today `price` is one u64 and `pay = chosen_f · price`. For a high-decimal/low-decimal pair this either
overflows u64 or is too coarse. Make price a **ratio** `price_num / price_den` (`price_den` =
`decimals_scale`), mirroring the Bitcoin OP_BID:
- `pay = floor(chosen_f · price_num / price_den)` (u128 intermediate; floors toward the seller so the
  buyer keeps the rounding dust),
- `V_fund = floor(max_fill · price_num / price_den)`,
- `refund = V_fund − pay`,
- `price_den` (and `price_num`) bound in the buyer's bid sigma context, so the box can't re-scale.

Guest (OP_BID): read `price_den`, replace the two `·price` computations, add `price_den > 0`, bind it in
`tacit-bid-buyer-v1` / `tacit-bid-seller-v1` contexts. Dapp `confidential-bid.js`: same ratio + context.
This rides the next coordinated re-prove (rotates both vkeys) — fold it in with the parked ZAMM WIP.

---

## Rollout

1. **Repeated fills** — dapp-only. Build `buildRestingBid`/`fillRestingLot`/`cancelBid` + the head-track
   + node tests (multi-fill round-trip, cancel, race-revert). Ships without a re-prove.
2. **decimals_scale** — fold the OP_BID ratio into the next guest re-prove (with the ZAMM first-mint
   WIP); update `confidential-bid.js` + `tests/confidential-bid-op.mjs`.

## Open items
- Confirm `deriveNote` exposes a domain/role param (the re-key uses `"recv"`/`"fund"` tags); if not, add it.
- Worker/indexer head-tracking for a resting order (which funding note is the live head) — a scan concern,
  not consensus.
- `min_fill = increment` policy for resting orders (vs a larger min) — UX choice.
