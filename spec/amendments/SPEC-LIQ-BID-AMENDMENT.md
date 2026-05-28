# SPEC §5.7.13 + §5.38.x Amendment — Asset-Settled Liquidation Bid (`T_PREAUTH_BID_ASSET` `0x5E`)

> **STATUS: DRAFT** (2026-05-28). Adds one envelope opcode and one
> force-close mode:
> - `T_PREAUTH_BID_ASSET` (`0x5E`) — a buyer-offline, partial-fill,
>   walk-away bid that settles **asset-for-asset** (the buyer pays a
>   tacit asset, e.g. cBTC.tac) instead of asset-for-sats. The
>   asset-settled generalization of `T_PREAUTH_BID_VAR` (`0x5C`).
>   Closes the last slot of the preauth/offline-trading family block
>   `0x5B`–`0x5E`.
> - **Force-close liquidation via the bid book** — extends
>   `T_CBTC_TAC_FORCE_CLOSE` (`0x4B`, `SPEC-CBTC-TAC-AMENDMENT.md`
>   §5.38) so a position's seized bond is converted to cBTC.tac by
>   matching against standing `T_PREAUTH_BID_ASSET` bids, rather than
>   either dumping into an AMM (reflexive) or holding the raw,
>   possibly-crashing bond asset in the insurance pool.
>
> Companion to:
> - `SPEC-PREAUTH-BID-VAR-AMENDMENT.md` (§5.7.12 — the sats-settled
>   partial-fill bid this generalizes; the K-pre-signature design is
>   reused with Groth16 proofs in place of `SIGHASH_SINGLE_ACP` sigs)
> - `SPEC-CBTC-TAC-AMENDMENT.md` (§5.38 force-close, §5.39 pooled
>   insurance — the liquidation floor this layers on top of)
> - `SPEC-CBTC-TAC-COLLATERAL-AMENDMENT.md` (mixed collateral — the
>   seized bond is an LP-share of the (TAC, tETH) pool; it liquidates
>   through this venue)
>
> **Trust profile.** No new cryptographic primitive, no covenant, no
> federation. The bid is settled entirely in tacit-asset space
> (asset-spend Groth16 + nullifier + bulletproof), and liquidation
> proceeds rest as **cBTC.tac** — a Pedersen tacit asset escrowable by
> indexer consensus, NOT a raw BTC UTXO. This is precisely why the
> orderbook venue works covenant-free where §5.38's earlier
> AMM-swap-into-a-protocol-BTC-reserve design did not. Inherits the
> conservation-exception pattern from `T_SHARE_SLASH_CLAIM` (§5.39.4).

---

## Motivation

`T_CBTC_TAC_FORCE_CLOSE` v1 (§5.38) does not convert the seized bond
at all: on a `LIQUIDATION_RATIO` breach it moves the bond asset to the
pooled insurance reserve as-is, and holders are made whole via
`T_SHARE_SLASH_CLAIM` (§5.39.4). That is covenant-free and griefing-
free, but it has one weakness: **the insurance reserve is denominated
in the bond asset**, which — when the bond is TAC — is exactly the
reflexive asset that may have crashed at the moment liquidation fires.
The TWAP-implied 2× over-collateral can realize at far less than 2× in
a crash.

The original §5.38.4 design tried to fix this by AMM-swapping the bond
→ BTC and crediting a protocol-owned `redemption_reserve_BTC`. That
required a covenant (a trustless protocol-owned BTC UTXO) and was
shelved: "every covenant-free realisation either reduces to a
federated signer or lets a griefer steal the reserve."

This amendment fixes it without covenants by changing two things:

1. **Convert via standing bids, not an AMM.** Liquidation matches the
   seized bond against a book of pre-committed keeper bids. There is no
   mechanical pool price-impact — the conversion clears at competitive
   keeper prices — so the reflexive force-close→AMM-dump→price-down→
   more-force-closes feedback loop (the reason §5.38.3's cascade rate-
   limit exists) is broken.
2. **Settle in cBTC.tac, not BTC.** Proceeds are a tacit asset, held in
   the insurance escrow as indexer-enforced tacit state. No protocol
   BTC UTXO ⇒ no covenant ⇒ no reserve to grief.

The only new machinery is an asset-for-asset version of the §5.7.12
partial-fill bid. Everything else composes from the asset-spend
circuit, the atomic-intent book, and the §5.38/§5.39 insurance floor.

---

## §5.7.13 `T_PREAUTH_BID_ASSET` (`0x5E`)

### 5.7.13.1 What it is

The asset-settled twin of `T_PREAUTH_BID_VAR` (§5.7.12). A buyer
publishes a standing bid to **buy up to `max_fill` of `bond_asset_id`,
paying `pay_asset_id` at `price_per_unit`**, fillable in
`fill_increment` chunks, then walks away. A seller (or, for
liquidation, the force-close path) delivers any allowed `fill_amount ∈
[min_fill, max_fill]`; the unfilled remainder of the buyer's committed
payment is refunded.

The §5.7.12 mechanism pins each fill ratio with one of K
`SIGHASH_SINGLE_ACP` **Bitcoin** signatures over a pre-funded sats
UTXO. Here the payment is a tacit asset, whose spend is authorized by
a Groth16 asset-spend proof + nullifier + bulletproof — not a Bitcoin
signature on a sats UTXO. So the K pre-signatures become **K
pre-generated asset-spend proofs**, one per allowed fill ratio, each
splitting the buyer's committed `pay_asset` input into
`(payment_to_recipient_i, refund_i)`.

**Cost asymmetry vs §5.7.12.** K Groth16 proofs ≫ K ECDSA signatures
to pre-generate. The keeper generates them once at bid-publish time and
then is offline, but it means this variant favors **coarse
granularity** — small K (5–16 ratios), not the 100+ that the cheap-sig
§5.7.12 tolerates. `MAX_K_ASSET = 32` (vs §5.7.12's `MAX_K = 256`).

### 5.7.13.2 Bid record (off-chain)

```
liq_bid_id              16 bytes
bond_asset_id           32 bytes   (asset being bought — the seized bond's
                                     removed leg: TAC or tETH; see §5.38.x.1)
pay_asset_id            32 bytes   (asset paid in — for liquidation, the
                                     canonical cBTC.tac variant; protocol-fixed)
buyer_recipient_commit  33 bytes   (Pedersen; where the bought bond_asset is
                                     delivered to the buyer)
price_per_unit_LE        8 bytes   (pay_asset base units per SCALED unit of
                                     bond_asset; integer ≥ 1)
min_fill_LE              8 bytes   (scaled units; off-chain only)
max_fill_LE              8 bytes   (scaled units)
fill_increment_LE        8 bytes   (scaled units)
decimals_scale           1 byte    (0 ≤ s ≤ bond_asset.decimals)
pay_input_commit        33 bytes   (the buyer's pay_asset UTXO funding the bid)
pay_input_nullifier     32 bytes
refund_recipient_commit 33 bytes   (Pedersen; buyer's pay_asset change/refund)
--- K legs, one per allowed fill_amount_i = min_fill + i·increment ---
  for i in 0..K-1:
    bid_context_hash_i    32 bytes
    pay_to_recipient_i    33 bytes (pedersen(fill_amount_i × price, blind_i))
    refund_commit_i       33 bytes (pedersen(input − fill_amount_i × price, blind'_i))
    asset_spend_proof_i   VAR      (Groth16 ASSET_SPEND_VK over pay_input_commit →
                                     {pay_to_recipient_i, refund_commit_i})
    rangeproof_i          VAR      (bulletproof: both outputs ≥ 0 and
                                     pay_to_recipient_i + refund_i = pay_input_amount)
```

The K legs are the asset-settled analogue of §5.7.12's K
`buyer_sats_spend_i` signatures. `K = (max_fill − min_fill) /
fill_increment + 1 ≤ MAX_K_ASSET`.

### 5.7.13.3 Bid-context hash (per ratio)

```
bid_context_hash_i = SHA256(
    "tacit-preauth-bid-asset-context-v1"
    || bond_asset_id(32)
    || pay_asset_id(32)
    || liq_bid_id(16)
    || buyer_recipient_commit(33)
    || price_per_unit_LE(8)
    || max_fill_LE(8)
    || fill_increment_LE(8)
    || fill_amount_i_LE(8)
    || refund_recipient_commit(33)
    || decimals_scale(1)
)
```

`bid_context_hash_i` is bound as a public signal of
`asset_spend_proof_i` (the §5.11 bind-squared construction). A settler
who substitutes any field — price, recipient, fill ratio, refund
target — produces a different hash and fails Groth16 verification. This
is the asset-settled equivalent of §5.7.12 pinning the per-ratio
OP_RETURN via the buyer's BIP-143 pre-sig.

### 5.7.13.4 Settlement envelope (`0x5E`)

Delta from the §5.7.12 (`0x5C`) settlement:

- **DROP:** buyer sats pre-fund input (`vin[2]` `SIGHASH_SINGLE_ACP`),
  the seller sats payout (`vout[1]`), the sats refund (`vout[3]`).
- **ADD:** the buyer's `pay_input` tacit-asset UTXO is consumed
  (`pay_input_nullifier` published); `pay_to_recipient_i` credited to
  the seller's payout recipient; `refund_commit_i` credited to the
  buyer.
- **KEEP (analogue):** per-ratio binding via `bid_context_hash_i`,
  enforced through the Groth16 `bind_hash` public signal rather than a
  Bitcoin pre-sig.

```
opcode             = 0x5E
bond_asset_id      = 32 bytes
pay_asset_id       = 32 bytes
liq_bid_id         = 16 bytes
fill_amount_LE     =  8 bytes   (chosen ratio i; = min_fill + i·increment)
price_per_unit_LE  =  8 bytes
max_fill_LE        =  8 bytes
fill_increment_LE  =  8 bytes
decimals_scale     =  1 byte
buyer_recipient_commit   33 bytes
refund_recipient_commit  33 bytes
pay_input_nullifier      32 bytes
seller_recipient_commit  33 bytes  (where the bought bond_asset is delivered to
                                     the seller's payment recipient = pay_to_recipient_i)
bind_hash          = 32 bytes  (= bid_context_hash_i; see §5.7.13.3)
proof_length       =  2 bytes
asset_spend_proof  = VAR       (the chosen ratio's asset_spend_proof_i)
rp_len             =  2 bytes
rangeproof         = VAR       (the chosen ratio's rangeproof_i)
seller_asset_proof = VAR       (Groth16 asset-spend over the seller's bond_asset
                                input — OMITTED in the force-close path, where the
                                bond is protocol-escrow state, see §5.38.x)
```

### 5.7.13.5 Validator rules (general fill)

1. `fill_amount = min_fill + i·fill_increment` for some `i ∈ [0, K−1]`,
   `fill_amount ∈ [min_fill, max_fill]`.
2. `bind_hash == bid_context_hash_i` recomputed from the inline fields.
3. Verify `asset_spend_proof` (ASSET_SPEND_VK) over `pay_input_commit`;
   public signals MUST bind `bind_hash`.
4. Verify `rangeproof`: `pay_to_recipient_i + refund_i =
   pay_input_amount` **and** `pay_to_recipient_i = fill_amount ×
   price_per_unit × 10^decimals_scale` reconciled to base units. (This
   is the protocol-enforced refund rule — the asset-settled analogue of
   §5.7.12 rule §5.)
5. `pay_input_nullifier ∉ spent-set[pay_asset_id]` → add it. Spending
   the input voids the other K−1 legs ⇒ **single-shot partial fill**
   (matches §5.7.12 v1 scope; repeated fills against one input = a
   follow-up).
6. The bought `bond_asset` of size `fill_amount` is delivered to
   `seller_recipient_commit`; the seller's side is authorized either by
   `seller_asset_proof` (general trade) or by the force-close envelope
   (liquidation, §5.38.x).

Position-independence (§5.7.8.1) applies to the asset-leg
input/output pairing as in §5.7.12.

---

## §5.38.x Force-close liquidation via the bid book

This extends `T_CBTC_TAC_FORCE_CLOSE` (§5.38). The trigger is
unchanged (`current_ratio < LIQUIDATION_RATIO`, permissionless,
§5.38.1). What changes is the disposition of the seized bond.

### 5.38.x.1 Matching

On force-close, the seized bond (`position.bond_amount`, asset
`position.bond_asset_id`) is matched against standing
`T_PREAUTH_BID_ASSET` bids whose `bond_asset_id == position bond asset`
and `pay_asset_id == canonical cBTC.tac variant`, **best price first**
(highest `price_per_unit`).

The "seller" is the protocol: the seized bond is the lien-locked UTXO
that force-close moved to the `ctac-claim-pool` (§5.47.4), governed by
indexer consensus via `commitmentForUtxo` (§5.47.3) — no Bitcoin
spending key. The force-close envelope authorizes delivering
`fill_amount` of the seized bond to the matched bid's
`seller_recipient_commit` (= the keeper's `pay_to_recipient_i`). No
seller signature; `seller_asset_proof` is omitted and the indexer
credits the keeper's bond-asset recipient directly.

**LP-share bonds.** The §5.47 bond is an LP-share of the **(TAC, tETH)**
pool (`SPEC-CBTC-TAC-COLLATERAL-AMENDMENT.md` §5.52). Force-close
`T_LP_REMOVE`s it to its **TAC + tETH legs**, and `0x5E` bids both for
cBTC.tac into the claim pool. Neither leg is cBTC.tac, so both are bid
(tETH typically clears at a tighter spread than TAC); thin-book on
either leg degrades to the §5.38 v1 early-slash floor.

### 5.38.x.2 Reserve price

The force-close MUST NOT sell below a floor:

```
require price_per_unit ≥ LIQ_FLOOR_FRAC × oracle_TWAP(bond_asset → cBTC.tac,
                                                       at H − REORG_SAFETY_DEPTH)
```

`LIQ_FLOOR_FRAC` (default 0.90, §5.38.x.6) is the maximum acceptable
liquidation discount. Bids below the floor are skipped; a book that
clears nothing above the floor triggers the fallback (§5.38.x.4).

### 5.38.x.3 Partial fills — walking the book

A single bid rarely covers a whole position. Using §5.7.13's native
partial-fill:

- Fill `fill_amount` against the best eligible bid; the unfilled
  remainder of *that bid* refunds to the keeper (rule §4).
- Walk to the next-best bid for the next chunk, descending in price but
  never below `LIQ_FLOOR_FRAC × oracle_TWAP`.
- Each chunk increments `insurance_pool_cBTCtac` by its
  `pay_to_recipient_i` and decrements `position.bond_amount` by
  `fill_amount`.
- Subject to `MAX_FORCE_CLOSES_PER_BLOCK` (§5.41) as a coarse
  block-level backstop — but since there is no AMM to crash, this is no
  longer load-bearing and may be relaxed by governance per §5.46.2.

### 5.38.x.4 Thin-book fallback (REQUIRED)

This venue is **strictly additive** on top of the §5.38 v1 floor — it
can only improve, never brick:

- **Book liquid** → seized bond converts to cBTC.tac; the insurance
  pool gains BTC-pegged value. Best case.
- **Book thin / no bid clears the reserve** (a crash — exactly when
  keepers flee) → fall back to **§5.38 v1 verbatim**: the unconverted
  bond stays in the pooled insurance reserve as the raw bond asset, and
  holders are made whole via `T_SHARE_SLASH_CLAIM` (§5.39.4) against
  the augmented pool. No new failure mode.
- A position may **partially** convert: the portion the book absorbs
  above the floor becomes cBTC.tac; the remainder stays as bond asset.

Optionally, instead of holding the unconverted remainder statically,
the force-close MAY re-post it as a decaying-price standing
`T_PREAUTH_BID_ASSET`-fillable offer for late keepers to absorb over
subsequent blocks. The "hold as bond asset" floor always applies.

### 5.38.x.5 Effects

```
on T_CBTC_TAC_FORCE_CLOSE (bid-book mode) at block H:
  require position.state == "active"
  require current_ratio(position, H) < LIQUIDATION_RATIO
  require force_closes_this_block < MAX_FORCE_CLOSES_PER_BLOCK

  remaining := position.bond_amount
  for each eligible bid B (best price first):
    require B.price_per_unit ≥ LIQ_FLOOR_FRAC × oracle_TWAP(...)
    chunk := min(remaining, B.max_fill)         // rounded to B.fill_increment
    if chunk < B.min_fill: continue
    settle T_PREAUTH_BID_ASSET(B, fill_amount = chunk):
      - verify B's chosen-ratio asset_spend_proof + rangeproof
      - credit insurance_pool_cBTCtac += chunk × B.price_per_unit
      - credit keeper bond_asset += chunk   (from protocol escrow)
      - credit keeper refund (unfilled pay_asset)
      - consume B.pay_input_nullifier
    remaining -= chunk
    if remaining == 0: break

  // Fallback for the unconverted remainder (§5.38.x.4)
  if remaining > 0:
    insurance_pool_bondAsset += remaining     // v1 early-slash floor

  position.state := "force-closed"
  leaf_state[position.slot_leaf_hash] := "force-closed"
  force_closes_this_block += 1
```

The depositor's `K_btc` is never touched by the protocol (self-custody,
§5.35.2) — same as v1. Outstanding cBTC.tac is not debited; it now has
a pro-rata claim on an insurance pool that holds BTC-pegged cBTC.tac
(for the converted portion) plus raw bond asset (for any remainder).

### 5.38.x.6 Constants

```
LIQ_FLOOR_FRAC   = 0.90    (max liquidation discount; min acceptable
                            price = 0.90 × oracle_TWAP)
MAX_K_ASSET      = 32      (max pre-generated proof legs per asset bid)
```

Both are Tier A governable within safety bands (§5.46.2 extension):
`LIQ_FLOOR_FRAC ∈ [0.75, 0.99]`, `MAX_K_ASSET ∈ [4, 64]`.

---

## Anti-griefing

- **Payment cannot be redirected.** `buyer_recipient_commit`,
  `refund_recipient_commit`, and (for liquidation) the protocol-fixed
  insurance-pool recipient are all pinned inside `bid_context_hash_i`
  and Groth16-bound. A settler cannot redirect the bought asset or the
  refund — the asset-settled analogue of §5.7.12's pinned
  `refund_script_hash`.
- **No dump-to-zero.** `LIQ_FLOOR_FRAC` + the standing book guarantee
  the protocol never converts below the best keeper price above the
  floor.
- **No covenant, no protocol BTC UTXO.** Every state move is in
  cBTC.tac / bond-asset tacit state, enforced by Groth16 + indexer
  rules. The griefing vector that shelved the §5.38.4 BTC reserve does
  not exist here.
- **Single-shot per input** (nullifier) prevents a keeper bid from
  being replayed across positions; a keeper posts multiple bids
  (multiple inputs) to backstop multiple liquidations.

---

## §5.44 opcode table addition

Add to §3 *opcodes table* / `SPEC-CBTC-TAC-AMENDMENT.md` §5.44:

- `0x5E` `T_PREAUTH_BID_ASSET` — asset-settled buyer-offline partial-
  fill bid; liquidation venue for cBTC.tac force-close (§5.7.13,
  §5.38.x). Consumes the last slot of the preauth/offline-trading
  family block `0x5B`–`0x5E`.

---

## Test plan

1. **General asset-for-asset fill**: publish a `0x5E` bid (buy TAC pay
   cBTC.tac), seller fills a mid-range chunk, verify recipient + refund
   commitments + nullifier consumption.
2. **K-leg selection**: settle each allowed ratio against its matching
   pre-generated proof; verify a mismatched ratio/proof fails Groth16.
3. **Refund correctness**: `pay_to_recipient + refund = input`,
   `pay_to_recipient = fill_amount × price`.
4. **Force-close happy path**: position breaches, single liquid bid
   converts the whole bond → cBTC.tac into the insurance pool.
5. **Walk-the-book partial fills**: position larger than the top bid;
   verify descending-price fills across multiple bids, all ≥ floor.
6. **Reserve-price skip**: bids below `LIQ_FLOOR_FRAC × TWAP` are
   skipped.
7. **Thin-book fallback**: empty/sub-floor book → v1 early-slash (raw
   bond to pool); holders claim via `T_SHARE_SLASH_CLAIM`.
8. **Partial conversion**: book absorbs part above floor → mixed pool
   (cBTC.tac + raw bond remainder); per-share fair value reflects both.
9. **Anti-griefing**: attempt to redirect bought asset / refund →
   Groth16 fails; attempt to settle below floor → rejected.
10. **Cascade interaction**: many simultaneous breaches respect
    `MAX_FORCE_CLOSES_PER_BLOCK`; confirm no AMM price-impact.
11. **Reorg stability**: oracle sampled at `H − REORG_SAFETY_DEPTH`;
    reorg ≤ 5 doesn't change the fill decision.

---

## Open questions

1. **Repeated fills against one keeper input.** v1 is single-shot
   (nullifier voids the other legs). A follow-up could let one funded
   bid serve multiple liquidations via a running-balance commitment.
2. **Cross-asset bid books.** Should one bid be able to buy *any*
   accepted bond collateral (TAC or tETH) for cBTC.tac, or one book per
   bond asset? v1: one book per `bond_asset_id`.
3. **Keeper incentive surfacing.** The keeper's profit is the
   `oracle_TWAP − price_per_unit` spread. Whether to also surface an
   explicit reward (cf. retired §5.38 `LIQUIDATOR_REWARD_FRACTION`) or
   leave it implicit in the bid spread. v1: implicit in the spread.

---

## Summary

`T_PREAUTH_BID_ASSET` (`0x5E`) is the asset-settled twin of the §5.7.12
partial-fill bid — K pre-generated asset-spend proofs in place of K
Bitcoin pre-signatures, settling tacit-asset-for-tacit-asset. Wired
into `T_CBTC_TAC_FORCE_CLOSE`, it turns liquidation into a competitive
standing-bid auction whose proceeds rest as cBTC.tac. This fixes
§5.38 v1's "insurance denominated in the crashing bond asset" weakness
**without covenants** (proceeds are a tacit asset, not a protocol BTC
UTXO) and **without reflexivity** (no AMM price-impact), while
degrading gracefully to the v1 early-slash floor when the book is thin.
It is the liquidation engine for the mixed-collateral cBTC.tac of
`SPEC-CBTC-TAC-COLLATERAL-AMENDMENT.md`.
