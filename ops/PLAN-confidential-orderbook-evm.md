# Confidential partial-fill orderbook for the Ethereum shielded pool (`OP_BID`)

Bring the Ethereum side to parity with the Bitcoin orderbook's **buyer-offline partial-fill bid**
(`T_PREAUTH_BID_VAR`, SPEC §5.7.12): a buyer posts one bid to buy *up to* `max_fill` of `asset_a`
at `price` per unit (paid in `asset_b`), walks away, and a seller fills any allowed `fill ∈
[min_fill, max_fill]` on the `increment` grid — the unfilled remainder is refunded to the buyer.
Functionally a confidential limit order, settled trustlessly with no buyer round-trip per fill.

## The offline-recipient problem and the K-presig answer

The pool is a **bearer model** — spend authorization is opening-secrecy `(v, r)`, the owner never
gates it (`SPEC-CONFIDENTIAL-POOL.md` §2). So whoever picks a note's blinding can spend it: the
seller/matcher must NOT create the buyer's received notes, or they could steal them back. But the
buyer is offline when the seller chooses `fill`, so the buyer can't sign the specific output then.

**Resolution (mirrors Bitcoin's K pre-signature):** the buyer pre-computes, for **each** allowed
fill `f_i` on the grid (`K = (max_fill − min_fill)/increment + 1` of them), the two received-note
openings — the filled `f_i` of `asset_a` and the refund `(max_fill − f_i)·price` of `asset_b` —
with blindings `r = PRF(bid_secret, f_i, tag)` only the buyer can reproduce. The buyer publishes
these K opening sigmas (+ one funding-note opening sigma) as the bid and walks away. A seller picks
`f_i`, attaches the matching pre-signed openings, and fills. **The K lives off-chain**; the on-chain
witness carries only the chosen `f_i`'s openings — so the guest op is ~OTC-complexity. The seller
can only fill at a pre-signed `f_i` (it can't forge the buyer's openings for any other amount), and
the buyer recovers the received notes by recomputing `r = PRF(bid_secret, f_i)` after scanning the
fill (no memo needed — deterministic derivation).

## Economics (integer price; per asset)

`price` = `asset_b` per unit `asset_a` (integer; `decimals_scale` granularity is a follow-up, as on
Bitcoin). The buyer pre-funds `V_fund = max_fill · price` of `asset_b` in one note.

- **asset_b:** `V_fund` → `pay = f·price` (to seller) + `refund = (max_fill − f)·price` (to buyer).
  `V_fund = pay + refund` always holds.
- **asset_a:** `seller_in` → `f` (to buyer) + `seller_change` (to seller).

## `OP_BID` (guest, opcode 10) — io::read order

```
asset_a[32], asset_b[32]
min_fill u64, max_fill u64, price u64, increment u64, buyer_owner[32]
fund   : (cx,cy)[64], leaf_index u64, path[32×32], sig(R,z)   // asset_b, value V_fund=max_fill·price; buyer pre-signed; membership + ν
chosen_f u64
buyer_recv_a  : (cx,cy)[64], sig(R,z)                          // asset_a, value chosen_f          (buyer pre-signed)
buyer_refund_b: (cx,cy)[64], sig(R,z)                          // asset_b, value (max_fill−f)·price (buyer pre-signed)
seller_in : (cx,cy)[64], owner[32], leaf_index u64, path[32×32], amount u64, sig(R,z)   // asset_a; membership + ν + cross-lane gate
seller_has_change u8 ; if 1 { seller_change: (cx,cy)[64], sig(R,z) }                     // asset_a, value seller_in−f
seller_recv_b : (cx,cy)[64], sig(R,z)                          // asset_b, value pay=chosen_f·price (seller-created)
```

### Asserts

- `min_fill > 0`, `max_fill ≥ min_fill`, `price > 0`, `increment > 0`, `asset_a ≠ asset_b`.
- Grid: `min_fill ≤ chosen_f ≤ max_fill` and `(chosen_f − min_fill) % increment == 0` and
  `(max_fill − min_fill) % increment == 0` (well-formed grid).
- `V_fund = max_fill · price`, `pay = chosen_f · price`, `refund = V_fund − pay` (u128, no overflow).
- Shared **bid context** (binds the funding + the buyer's two received notes + owners + the *chosen*
  `f`/`pay`/`refund` + terms) feeds every opening sigma — so a seller can only attach the buyer's
  opening that was pre-signed for *this* `f` (replay to another `f` fails the context).
- Openings: `fund`→`V_fund` (buyer), `buyer_recv_a`→`chosen_f` (buyer), `buyer_refund_b`→`refund`
  (buyer), `seller_in`→`amount` (seller), `seller_recv_b`→`pay` (seller), `seller_change`→`amount−f`.
- Conservation: `V_fund == pay + refund` (asset_b), `amount == chosen_f + seller_change` (asset_a).
- Membership of `fund` (asset_b, buyer) + `seller_in` (asset_a, seller) in `spend_root`; ν for both;
  cross-lane non-membership gate on each spent ν.

Emits `nullifiers += [ν(fund), ν(seller_in)]` and `leaves += [buyer_recv_a(asset_a,buyer),
seller_recv_b(asset_b,seller), buyer_refund_b(asset_b,buyer), seller_change(asset_a,seller)?]` — the
existing `settle` applies them; **no contract / PublicValues change** (like `OP_OTC`).

## Soundness

- **No theft of the fill:** the buyer's received notes use buyer-only blindings (`PRF(bid_secret,·)`)
  — the seller never learns them, so can't re-spend them. The buyer recovers by recomputing.
- **No over/under-fill:** `chosen_f` is grid-bounded and the buyer's opening for that exact `f` must
  verify (only pre-signed grid points exist). `pay`/`refund`/`f` are formula-derived + opening-bound.
- **No re-price / redirect:** every owner + amount is in the bid context; the seller can't change the
  recipient or the rate (the buyer's pre-signed openings fail under any other context).
- **Atomic + refund-enforced:** one op = one proof; the refund leg is a guest assert, not a
  convention (the analog of Bitcoin's consensus-enforced refund vout).

## Build sequence (mirrors `OP_OTC`)

1. **Guest** — `OP_BID` in `main.rs` (reuse `verify_opening_sigma`, `intent_context`, membership/ν/
   cross-lane). No contract change.
2. **Client** — `dapp/confidential-bid.js`: `buildBid` pre-signs the K grid openings (`PRF`
   blindings) + the funding sigma; `fillBid` selects `f` + builds the seller legs; `verifyBid`
   mirrors every guest assert.
3. **Tests** — `tests/confidential-bid-op.mjs` round-trip (exact/partial/refund + grid/replay/redirect
   rejects), an in-zkVM execute (`reflect-exec` `bid-execute`), and a box harness `exec-bid.rs` +
   `gen-confidential-bid-fixture.mjs`; add to `node_suite`.
4. **Re-prove (folded)** — `OP_BID` ships in the settle ELF re-prove (new settle vkey + a
   `bid_groth16.json` + `ConfidentialBidProofReal`).

v1 = **single-shot** partial fill (one seller consumes the bid; remainder refunded), matching Bitcoin
§5.7.12 v1. **Repeated fills** against one live bid (cumulative `fill` until `max_fill`/expiry) and a
`decimals_scale` price granularity are the follow-ups. `OP_OTC` stays the fully-matched direct trade;
`OP_BID` is its maker/taker limit-order generalization.
