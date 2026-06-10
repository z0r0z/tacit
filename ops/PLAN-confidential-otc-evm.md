# Confidential OTC for the Ethereum shielded pool (`OP_OTC`)

Bring the Ethereum side to parity with the Bitcoin orderbook's direct trades: a **2-party
atomic swap of shielded notes** — maker gives `v_a` of `asset_a` and receives `v_b` of
`asset_b`, taker mirrors — with both sizes and identities hidden. No pool, no price curve,
no slippage: a fixed agreed `(v_a, v_b)` cleared peer-to-peer. This is the direct-trade
counterpart to `OP_SWAP` (AMM) and reuses the same machinery.

## Why it needs nothing new on-chain

An OTC trade is just notes in → notes out: it consumes two input notes (one per party) and
emits the received + change notes. The contract already applies `pv.nullifiers` (spends) and
`pv.leaves` (inserts) generically in `settle` — exactly as `OP_TRANSFER` does — so **`OP_OTC`
adds no `PublicValues` field and no contract logic**. It is purely a guest op (`OP_OTC = 9`)
plus the client assembler.

## Soundness — the same binding `OP_SWAP` uses

The settle prover (the box / matcher) sees the cleartext amounts (it coordinates the match),
so each note is bound to its amount by an **opening sigma** (`verify_opening_sigma`: a Schnorr
PoK of the note blinding for the public amount) — never the raw blinding — so the prover can
neither spend an input elsewhere nor redirect/relabel an output. Every sigma's challenge is
the **shared OTC intent context** (`intent_context`, tag `tacit-otc-intent-v1`):

```
ctx = intent_context("tacit-otc-intent-v1", chainBinding, asset_a, asset_b,
        notes = [ (maker_in), (maker_change?), (maker_recv),
                  (taker_in), (taker_change?), (taker_recv) ]   // each (cx, cy, owner)
        amounts = [ v_a, v_b ])
```

Because **every output note's owner is in `ctx`**, the box cannot redirect the maker's
asset_b, the taker's asset_a, or either party's change to itself; because `v_a`/`v_b` are in
`ctx`, it cannot re-price. The trade is **atomic** by construction: one `OP_OTC` is one op in
one proof, so both legs' nullifiers + leaves apply together or not at all. The box can play
"counterparty" (supply asset_b itself) but can never make a party receive less than they
signed for — no theft, no griefing.

## Conservation (per asset, in-guest integer math)

- **asset_a:** `maker_in_amount == v_a + change_a` (taker receives `v_a`; maker keeps `change_a`).
- **asset_b:** `taker_in_amount == v_b + change_b` (maker receives `v_b`; taker keeps `change_b`).

The typed-`u64` amounts + the opening sigmas ARE the range check (as in `OP_SWAP`) — no BP+
proof. `u128` sums guard the equality. `v_a, v_b > 0`; `asset_a != asset_b`. Canonical form:
`has_change == 0 ⇒ input == give` (no dust 0-change); `has_change == 1 ⇒ input > give`.

## Guest layout (`OP_OTC`, io::read order)

```
asset_a[32], asset_b[32], v_a u64, v_b u64, maker_owner[32], taker_owner[32]
maker_in : (cx,cy)[64], leaf_index u64, path[32×32], amount u64, sig(R[33], z[32])   // asset_a; membership + ν + cross-lane gate
maker_has_change u8 ; if 1 { maker_change : (cx,cy)[64], sig(R,z) }                    // asset_a
maker_recv : (cx,cy)[64], sig(R,z)                                                     // asset_b, value v_b
taker_in : (cx,cy)[64], leaf_index u64, path[32×32], amount u64, sig(R,z)              // asset_b; membership + ν + cross-lane gate
taker_has_change u8 ; if 1 { taker_change : (cx,cy)[64], sig(R,z) }                    // asset_b
taker_recv : (cx,cy)[64], sig(R,z)                                                     // asset_a, value v_a
```

Emitted: `nullifiers += [ν(maker_in), ν(taker_in)]`; `leaves += [taker_recv(asset_a,taker),
maker_recv(asset_b,maker), maker_change(asset_a,maker)?, taker_change(asset_b,taker)?]` (this
fixed order; the client + memos mirror it).

## Build sequence (mirrors `OP_SWAP`)

1. **Guest** — `OP_OTC` in `main.rs` (reuse `verify_opening_sigma`, `intent_context`,
   membership/nullifier/cross-lane). No contract change. [this change]
2. **Client** — `dapp/confidential-otc.js`: build the two-leg witness + a `verify()` mirroring
   every guest assert; reuse `openingSigma`/`intentContext` from `confidential-pool.js`.
3. **Tests** — `tests/confidential-otc-op.mjs` round-trip (exact + change cases, tamper
   rejects); add to the readiness `node_suite`.
4. **Re-prove (folded with F4)** — `OP_OTC` ships in the next guest generation; a real
   `otc_groth16.json` + `ConfidentialOtcProofReal` land with that re-prove (fixture-gated like
   the others). No new ceremony — `OP_OTC` is just another op under the same SP1 stack.

Reuses: the shielded-pool notes, the secp opening sigma + intent context (from `OP_SWAP`/LP),
the membership/nullifier/cross-lane gate, the generic `settle` leaf/nullifier application.
Multi-input legs and a maker/taker **orderbook** (partial fill, `T_PREAUTH_BID_VAR` parity)
are the follow-up; this is the fully-matched, single-input-per-party direct trade.
