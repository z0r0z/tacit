# SPEC §5.7.12 — T_PREAUTH_BID_VAR (`0x5C`) — Buyer-Offline Partial-Fill Preauth Bid

> **Status: ✅ Shipped.** Variable-amount variant of §5.7.11
> `T_PREAUTH_BID`. Opcode `0x5C` in the preauth/offline-trading
> family block (`0x5B`–`0x5E`). Wire format, worker endpoints, buyer
> + seller flows, indexer-enforced refund-vout rule, and chain-only
> recovery all signet-validated end-to-end
> (`tests/preauth-bid-var-onchain-e2e-signet.mjs` and
> `tests/preauth-bid-var-8dec-onchain-e2e-signet.mjs`).
>
> The "holy grail" buyer UX: post one bid for *up to* a target
> amount at a per-unit price, walk away, sellers fill in chunks
> until the order is filled or expires. Functionally analogous to
> a limit order on a centralized exchange — but settled trustlessly
> on Bitcoin with no maker bond, no orderbook operator trust, and
> no buyer round-trip per fill.
>
> The inline section carries a `decimals_scale` byte so quantities
> in `max_fill` / `fill_amount` / `fill_increment` are denominated in
> **scaled units** of `10^decimals_scale` base units. This lets
> typical-priced high-decimal tokens (e.g. an 8-decimal TAC at 200
> sats/whole) fit the per-unit pricing model that would otherwise
> floor to zero under u64 sats-per-base-unit arithmetic.

---

## Motivation

§5.7.11 `T_PREAUTH_BID` made the bid side offline-capable but only
for *exact-fill* trades: the buyer commits to a single amount and
the seller either delivers all of it or doesn't fill. This works
for OTC blocks but it's not how most users place buy orders. The
expected UX is "I want to accumulate up to X tokens at Y price per
unit; fill it however you can." That requires partial-fill
semantics with the buyer staying offline.

Per-fill range trading needs three properties that §5.7.11 does
not provide:

1. **Variable fill amount.** Buyer publishes `(min_fill, max_fill,
   price_per_unit)`; seller picks any allowed `fill_amount ∈
   [min_fill, max_fill]` at `fill_increment` granularity.
2. **Refund of unfilled portion.** When seller fills `fill_amount
   < max_fill`, the buyer gets back `(max_fill - fill_amount) ×
   price_per_unit` sats. This MUST be enforced by Bitcoin
   consensus (not just by tacit indexers), otherwise sellers
   could grief by pocketing the entire pre-funded UTXO.
3. **Repeated fills against the same bid.** Each settlement
   consumes some portion of the bid; the bid is "live" until
   `fill_amount` cumulatively reaches `max_fill` or expiry hits.
   (v1 of this amendment ships single-shot partial fills only;
   repeated fills is a follow-up — see §"Follow-up primitives".)

The crypto difficulty: Bitcoin's `SIGHASH_SINGLE | ANYONECANPAY`
flag only binds the buyer's pre-signed input to **one** same-index
output. For partial fill, two outputs need to be pinned (the
canonical OP_RETURN binding + the buyer's refund vout). No single
SIGHASH flag combination supports binding multiple specific
outputs while leaving room for the seller to add their own.

This amendment resolves the difficulty via the **K pre-signature**
pattern: the buyer pre-signs `K = (max_fill - min_fill) /
fill_increment + 1` independent `SIGHASH_SINGLE_ACP` signatures
on the same funding outpoint, each binding a *different*
OP_RETURN whose hash commits to a *specific* `fill_amount_i` +
the canonical refund parameters. The seller picks one ratio,
attaches the corresponding pre-sig, and the on-chain validator +
Bitcoin consensus jointly enforce that the refund vout matches.

### Why a new opcode

§5.7.11's `T_PREAUTH_BID` validator dispatch hardcodes the inline
`(amount, blinding)` fields and the single-OP_RETURN binding
rule. `T_PREAUTH_BID_VAR` needs:

- A variable-amount inline section (fill_amount chosen at
  settlement time, not bid-publish time).
- A refund-vout protocol enforcement rule (the validator checks a
  vout with `value = (max_fill - fill_amount) × price_per_unit`
  to the canonical refund script exists somewhere in the tx).
- A new OP_RETURN binding domain (`tacit-preauth-bid-var-context-v1`)
  that hashes per-ratio canonical content.

These changes don't belong in the §5.7.11 validator (they'd
break every existing exact-fill settlement). They belong in a
dedicated opcode that signals "this envelope is a partial-fill
preauth-bid settlement and the per-ratio binding + refund-vout
rules apply."

---

## Load-bearing primitive: K SIGHASH_SINGLE_ACP pre-signatures

§5.7.8 (preauth-sale) and §5.7.11 (preauth-bid) each rely on a
**single** `SIGHASH_SINGLE_ACP` (`0x83`) signature. The buyer's
pre-sig binds one outpoint → one same-index vout.

§5.7.12 generalizes to **K signatures over the same outpoint**,
each binding to a *different* OP_RETURN content. The buyer
computes K canonical hashes `bid_context_hash_i` (one per
allowed `fill_amount_i`), signs K BIP-143 preimages — each with
its own `hashOutputs(canonical_OP_RETURN_i)` — and publishes all
K signatures in the off-chain bid record.

The seller:

1. Picks a `fill_amount_i ∈ {min_fill, min_fill + increment, …,
   max_fill}` they're willing to deliver.
2. Looks up `bid_context_hash_i` (recomputable from bid params).
3. Looks up the corresponding pre-signature `buyer_sats_spend_i`
   (one of K in the bid record).
4. Builds the settlement tx with:
   - `vin[k1]` = buyer's funding outpoint, witness includes
     `buyer_sats_spend_i`
   - `vout[k1]` = canonical OP_RETURN containing
     `bid_context_hash_i`
   - The other vouts (asset recipient, refund, seller payout)
     per the canonical layout for ratio `i`
5. Broadcasts. Bitcoin consensus enforces:
   - `buyer_sats_spend_i` is a valid signature on the BIP-143
     preimage with `hashOutputs(OP_RETURN_i)` → forces OP_RETURN
     content to match the per-ratio hash exactly.

Tacit indexer additionally enforces:
   - A vout exists with `script == refund_script` and `value ==
     (max_fill - fill_amount_i) × price_per_unit` (refund-vout
     rule, see "Indexer validation" below).
   - All §5.7.11 chain-only validation rules (Pedersen
     consistency, recipient script match, etc.).

### Size of K

`K = (max_fill - min_fill) / fill_increment + 1`. Practical
ranges:

| Use case | min_fill | max_fill | fill_increment | K |
|---|---|---|---|---|
| Tight bid (10% granularity) | 1k | 10k | 1k | 10 |
| Wide bid (5% granularity) | 5k | 100k | 5k | 20 |
| Power-user (1% granularity) | 100 | 10k | 100 | 100 |

Each pre-signature is ~71 bytes (DER-encoded ECDSA + sighash
byte). K=10 → 710 bytes in the bid record. K=100 → 7.1 KB. The
worker-side bid book stores these as part of the record; no
on-chain cost (signatures only appear on-chain when a seller
fills, and only the chosen-ratio's signature is broadcast).

`MAX_K = 256` per bid (validator-enforced cap on the bid record).
At 1% granularity that's a 256× range — wider ranges should
publish multiple bids, not one huge K.

---

## Quantity denomination — scaled units

All four fill-quantity fields (`max_fill`, `min_fill` off-chain,
`fill_amount`, `fill_increment`) are denominated in **scaled units**,
where one scaled unit equals `10^decimals_scale` base units of the
asset. The on-chain `decimals_scale` byte (see envelope layout below)
fixes this exponent.

For a 0-decimal token, `decimals_scale = 0` and quantities are raw base
units. For an 8-decimal token like
TAC at a typical 200 sats/whole price, the dapp picks the smallest
`decimals_scale` such that `price_per_unit ≥ 1` (i.e., the per-scaled-
unit price fits in u64). For TAC at 200 sats/whole the natural choice
is `decimals_scale = 8` (1 scaled unit = 1 whole TAC, 1 unit = 200
sats), but any `0 ≤ decimals_scale ≤ asset.decimals` is valid and gives
finer-grained tick sizes.

**Pedersen consistency** (validator rule 1, below) opens output[0] to
`fill_amount × 10^decimals_scale` base units paired with
`recipient_blinding`. The Pedersen commitment itself is always over
base units (the protocol-wide invariant for asset amounts); the
scaling reconciles the inline `fill_amount` field with that
invariant.

**Refund-vout math** (validator rule 7) stays in sats: refund value =
`(max_fill - fill_amount) × price_per_unit`. Both factors are u64;
result is u64 sats. No additional scaling enters the refund check.

## Bid-context OP_RETURN binding (per-ratio)

For each allowed fill amount `fill_amount_i`, the canonical hash:

```
bid_context_hash_i = SHA256(
    "tacit-preauth-bid-var-context-v1"
    || asset_id(32)
    || bid_id(16)
    || recipient_pubkey(33)
    || price_per_unit_LE(8)
    || max_fill_LE(8)
    || fill_increment_LE(8)
    || fill_amount_i_LE(8)
    || refund_script_hash(20)   ← hash160(refund_pubkey), pinning the buyer's reclaim P2WPKH
    || decimals_scale(1)        ← scaled-unit exponent (see "Quantity denomination" above)
)
```

The trailing `decimals_scale` byte is an input to the SHA256, so a
settlement tx that uses a different scale than the buyer pre-signed
produces a different `bid_context_hash` and fails Bitcoin's BIP-143
signature verification at relay. The scale choice is therefore
Bitcoin-consensus enforced via the K-sig preimage, not just
indexer-enforced.

`refund_script_hash` is `hash160(refund_pubkey)` matching the
P2WPKH the buyer wants the refund paid to. Pinning this in the
hash means the seller cannot redirect the refund — the validator
checks `vout[?].script == OP_0 || OP_PUSHBYTES_20 ||
refund_script_hash` and reads `refund_pubkey` indirectly.

The on-chain OP_RETURN follows the same `OP_RETURN || OP_PUSHBYTES_32
|| hash_i` shape as §5.7.11 — domain-tagged inside the SHA256
input, opaque 32 bytes on chain.

---

## `T_PREAUTH_BID_VAR` envelope (`0x5C`)

```
opcode             = 0x5C (T_PREAUTH_BID_VAR, 1 byte)
asset_id           = 32 bytes
asset_input_count  = N ≥ 1     (single-seller fill; multi-seller fan reserved
                                for follow-up `T_PREAUTH_BID_BATCH` 0x5D)

--- inline bid-context for the chosen fill ratio (134 bytes, +1 vs v1) ---
bid_id             = 16 bytes
recipient_pubkey   = 33 bytes
price_per_unit_LE  = 8 bytes   (sats per SCALED unit; integer ≥ 1)
max_fill_LE        = 8 bytes   (in scaled units)
fill_increment_LE  = 8 bytes   (in scaled units)
fill_amount_LE     = 8 bytes   (seller's chosen ratio, ∈ allowed set;
                                 = min_fill + i × fill_increment for some
                                 i ∈ [0, K-1]; in scaled units)
recipient_blinding = 32 bytes  (recipient lot blinding; cleartext, same
                                 disclosure tradeoff as §5.7.11)
refund_script_hash = 20 bytes  (hash160(refund_pubkey); pins the buyer's
                                 reclaim P2WPKH)
decimals_scale     = 1 byte    (log10 of base_units per scaled unit;
                                 0 ≤ decimals_scale ≤ 32, typically =
                                 asset.decimals so 1 scaled unit = 1 whole
                                 token)
---

kernel_sig         = 64 bytes (BIP-340 over kernel_msg, seller-signed)
N_outputs          = 1 or 2   (1 = exact-amount fill chunk, no seller change;
                                2 = seller has asset change)
output[0]:                                          ← buyer's tacit recipient
  commitment       = pedersen(fill_amount × 10^decimals_scale, recipient_blinding)
                     — MUST verify against the inline (fill_amount,
                     recipient_blinding) after scaling fill_amount to
                     base units
output[1]:                                          ← seller's asset change (OPTIONAL)
  commitment       = 33 bytes
  encryptedAmount  = 8 bytes  (seller self-keystream, per §5.7.6)
rp_len             = 2 bytes (LE)
rangeproof         = aggregated bulletproof for {output[0]} or {output[0], output[1]}
```

Total inline overhead vs §5.7.11: +24 bytes per settlement
(`price_per_unit + max_fill + fill_increment - blinding alignment` net
delta; `min_fill` is derivable as `fill_amount_min_in_record`
off-chain). At 10 sat/vB mainnet ≈ +$0.02 per fill.

Settlement tx layout (canonical):

```
vin[0]       seller's commit P2TR (script-path spend, reveals envelope)
vin[1]       seller's asset UTXO (SIGHASH_ALL, contributes to kernel_msg)
vin[2]       buyer's pre-funded sats UTXO — SIGHASH_SINGLE_ACP (0x83)
                                            using pre-sig_i for fill_amount_i

vout[0]      buyer's tacit recipient (DUST P2WPKH to recipient_pubkey)
vout[1]      seller's BTC payout                — value ≥ fill_amount × price_per_unit
                                                  (NOT protocol-enforced; the
                                                  buyer's funding cap implicitly
                                                  bounds the seller's take)
vout[2]      OP_RETURN(bid_context_hash_i)      — 34-byte scriptPubKey, value=0,
                                                  bound by buyer's vin[2] pre-sig
vout[3]      buyer's refund                     — P2WPKH(refund_pubkey), value =
                                                  (max_fill - fill_amount) × price_per_unit;
                                                  PROTOCOL-ENFORCED (validator rule §5)
[vout[4]]    seller's asset change tacit dust (OPTIONAL, iff N_outputs == 2)
```

Position-independence (per §5.7.8.1) applies to the
`(vin[2], vout[2])` pair: the seller MAY shift the buyer-input /
OP_RETURN pair to any matching `(vin[k], vout[k])` slot. The
refund vout (`vout[3]` in the canonical layout) is found by
*script + value match*, not by index — the validator scans all
vouts looking for the canonical refund.

---

## Buyer pre-fund step

The buyer's pre-signed sats UTXO has value:

```
buyer_funding_value = max_fill × price_per_unit + DUST_LIMIT + max_fee_budget
```

Where:
- `DUST_LIMIT = 546 sats` (P2WPKH dust threshold for `vout[0]`)
- `max_fee_budget ≤ 10_000 sats` (capped)

Single UTXO, sized to cover the *maximum* fill. Partial fills
refund the unspent portion via `vout[3]`. Bitcoin consensus
enforces the refund because the buyer's per-ratio pre-sig binds
`OP_RETURN_i` which the validator checks against the canonical
hash — and the canonical hash includes `refund_script_hash`.

If the buyer doesn't already have a P2WPKH UTXO of the exact
required value, the bid-publish flow MUST first broadcast a
one-time pre-fund split tx. Identical mechanic to §5.7.11.

---

## Bid record (off-chain)

```
preauth_bid_var {
  bid_id                 16 bytes / 32 hex chars (sha256(
                           "tacit-preauth-bid-var-id-v1"
                           || asset_id || buyer_pubkey || nonce)[:16])
  asset_id               32 bytes
  buyer_pubkey           33 bytes (compressed) — owner of the funding UTXO
  recipient_pubkey       33 bytes (compressed) — where the asset is delivered
  refund_pubkey          33 bytes (compressed) — where unfilled sats refund
                                                  (MAY equal buyer_pubkey)
  price_per_unit         u64 — sats per unit of asset
  min_fill               u64 — smallest acceptable fill amount
  max_fill               u64 — largest acceptable fill amount; MUST satisfy
                                 (max_fill - min_fill) % fill_increment == 0
  fill_increment         u64 — granularity between min_fill and max_fill;
                                 K = (max_fill - min_fill) / fill_increment + 1;
                                 MUST satisfy K ≤ MAX_K (256)
  recipient_blinding     32 bytes — cleartext; same blinding used for ALL
                                     fill ratios (so output[0].commitment
                                     varies only with fill_amount)
  funding_outpoint       { txid: 32B BE, vout: u32, value: u64 } — exact size
                                                                    per formula above
  expiry                 unix-seconds (≤ 30 days from publish)
  nonce                  16 bytes, deterministically derived:
                           nonce = HMAC-SHA256(buyer_priv,
                                     "tacit-preauth-bid-var-nonce-v1"
                                     || funding_outpoint_txid_BE(32)
                                     || funding_outpoint_vout_LE(4)).first16
  buyer_sats_spend_K     array of K { signature_hex: ECDSA(low-S) || 0x83 byte }
                           one per fill_amount_i = min_fill + i × fill_increment,
                           ordered by i
  auth_sig               BIP-340 over bid_auth_msg, under buyer_pubkey
  status                 'live' | 'taken' | 'cancelled' | 'expired' | 'stale_spent'
}
```

`bid_auth_msg`:

```
bid_auth_msg = SHA256(
    "tacit-preauth-bid-var-v1"
    || asset_id(32) || bid_id(16) || buyer_pubkey(33)
    || recipient_pubkey(33) || refund_pubkey(33)
    || price_per_unit_LE(8) || min_fill_LE(8) || max_fill_LE(8) || fill_increment_LE(8)
    || recipient_blinding(32)
    || funding_outpoint_txid_BE(32) || funding_outpoint_vout_LE(4) || funding_outpoint_value_LE(8)
    || expiry_LE(8)
    || varslice(concat_all_K_signatures)
    || nonce(16)
)

bid_cancel_msg = SHA256("tacit-preauth-bid-var-cancel-v1" || asset_id || bid_id)
```

---

## Indexer validation

The `T_PREAUTH_BID_VAR` validator MUST enforce, in addition to
the standard `T_AXFER` checks (Pedersen conservation, bulletproof
range, kernel-sig verification, opcode-byte dispatch). All checks
are chain-only:

1. **Inline opening consistency.** `output[0].commitment` MUST
   equal `pedersen(fill_amount, recipient_blinding)` where
   `(fill_amount, recipient_blinding)` are read from the inline
   section.
2. **Recipient script match.** `vout[0].script` MUST equal
   `P2WPKH(hash160(recipient_pubkey))` where `recipient_pubkey`
   is the 33-byte compressed key from the inline section.
3. **Fill ratio validity.** `fill_amount` MUST satisfy `(fill_amount
   - min_fill) % fill_increment == 0` and `min_fill ≤ fill_amount
   ≤ max_fill`. (`min_fill` is recoverable from `bid_id` via the
   bid record OR — for indexers ingesting chain-only — the
   bid_context_hash binding implicitly proves it, because only
   pre-signed ratios produce a matching OP_RETURN.)
4. **OP_RETURN presence + position.** Some `vout[k]` MUST match
   the canonical pattern `OP_RETURN OP_PUSHBYTES_32 || hash32`
   (34-byte scriptPubKey, value = 0).
5. **Buyer-input position match.** Some `vin[k]` MUST share the
   same `k` as the OP_RETURN vout. Its witness MUST contain a
   valid ECDSA signature with trailing byte `0x83` (SIGHASH_SINGLE
   | ANYONECANPAY) over the BIP-143 preimage of that input pinning
   `vout[k]` to the canonical OP_RETURN bytes.
6. **Bid-context hash binding.** The 32-byte hash embedded in the
   OP_RETURN MUST equal:
   ```
   SHA256(
       "tacit-preauth-bid-var-context-v1"
       || asset_id(32)              ← envelope's asset_id field
       || bid_id(16)                ← inline section
       || recipient_pubkey(33)      ← inline section
       || price_per_unit_LE(8)      ← inline section
       || max_fill_LE(8)            ← inline section
       || fill_increment_LE(8)      ← inline section
       || fill_amount_LE(8)         ← inline section (seller's chosen ratio)
       || refund_script_hash(20)    ← inline section
   )
   ```
7. **Refund-vout enforcement.** Compute `refund_value = (max_fill -
   fill_amount) × price_per_unit`. Some `vout[k']` (for any k')
   MUST satisfy:
   - `vout[k'].script == OP_0 || OP_PUSHBYTES_20 ||
     refund_script_hash` (canonical P2WPKH)
   - `vout[k'].value == refund_value`
   If `fill_amount == max_fill` (full fill), `refund_value == 0`
   and this rule is skipped (no refund vout required).
8. **Sats-input payout floor.** The vin at position `k` MUST be a
   P2WPKH spend of an outpoint with `value ≥ max_fill ×
   price_per_unit + DUST_LIMIT`. The seller's payout (some other
   vout with `value ≥ fill_amount × price_per_unit` to any
   P2WPKH script the seller chooses) is **not** protocol-enforced —
   the buyer's funding-UTXO sizing + the refund-vout enforcement
   jointly bound the seller's take.

Indexers that don't know `T_PREAUTH_BID_VAR` (`0x5C` not yet
deployed) treat it as an unknown opcode per §5.5 forward-compat —
soft-fork-additive.

---

## Recovery semantics

Identical to §5.7.11 — chain-only via the inline section:

1. Wallet scans recent blocks for `T_PREAUTH_BID_VAR` envelopes.
2. For each envelope, reads inline `recipient_pubkey`. If matches
   wallet's pubkey (or owned stealth address), envelope is theirs.
3. Reads `(fill_amount, recipient_blinding)` from inline. Verifies
   `pedersen(fill_amount, recipient_blinding) ==
   output[0].commitment`.
4. Credits new UTXO at `vout[0]` into holdings.

No bid record cache, no worker round-trip, no ECDH. Same recovery
profile as §5.7.11. The buyer's wallet may ALSO want to recognize
the refund at `vout[3]` (a normal P2WPKH spend back to the
buyer's refund_pubkey) but that's a vanilla BTC credit handled
by the wallet's standard UTXO scanning, not by tacit.

The seller's asset-change UTXO (if `N_outputs == 2`) recovers via
§6 path 4 same as any `T_AXFER` self-blinded change.

---

## Failure semantics

### Pre-broadcast (buyer cancels, funding outpoint spent)

Identical to §5.7.11: signed cancel → worker marks cancelled;
buyer reclaims funding via SIGHASH_ALL self-spend; spent
funding outpoint → marked stale.

### Post-broadcast (settlement fails to confirm)

If the seller's broadcast settles into mempool but is reorg-ed
out or RBF-replaced, the envelope re-enters the scanner queue.
The bid record stays `live` — the seller may re-broadcast or
another seller may take a different ratio. (v1 of this amendment
ships **single fill per bid** — once a settlement confirms at
depth 3, the bid is `taken` and subsequent fill attempts double-
spend the funding outpoint and fail. Repeated-fill same-bid is a
follow-up; see §"Follow-up primitives".)

### Seller-side griefing

Same shape as §5.7.11. The bigger funding UTXO (sized for
`max_fill × price_per_unit`) means the worst-case grief is
larger: a malicious seller who broadcasts a tacit-invalid tx
keeps the buyer's full pre-funded value. The refund-vout
enforcement rule (validator check #7) is INDEXER-enforced, not
Bitcoin-enforced; a determined seller can omit the refund vout
to grief the buyer.

The mitigation hierarchy:
- OP_RETURN content is Bitcoin-enforced (forces canonical hash
  per ratio) — seller cannot fake the ratio.
- Refund-vout presence is INDEXER-enforced — seller CAN omit it
  but then the asset isn't credited (tacit-invalid settlement)
  and the seller has burned their own asset for the buyer's BTC.
- The grief is profitable for sellers only when (max_fill ×
  price_per_unit - fill_amount × price_per_unit) > (asset_market_value).
  For typical OTC trades this is a tight margin; the user-facing
  UI should warn buyers if `(max_fill - min_fill) ×
  price_per_unit` exceeds a configurable safety threshold.

Future amendment may add a buyer-bond output the seller forfeits
on cancel / griefing detected via worker outspend monitoring.

### Worker downtime

Same as §5.7.11: worker is a coordination cache; chain-only
validation works without it.

---

## Comparison with §5.7.11 (exact-fill T_PREAUTH_BID)

|  | §5.7.11 T_PREAUTH_BID | §5.7.12 T_PREAUTH_BID_VAR (this amendment) |
|---|---|---|
| Opcode | `0x5B` | `0x5C` |
| Fill granularity | exact fill (single amount) | range `[min_fill, max_fill]` at `fill_increment` steps |
| Pre-signatures | 1 SIGHASH_SINGLE_ACP | K = (max - min)/inc + 1 SIGHASH_SINGLE_ACP signatures |
| Bid record size | ~250 bytes | ~250 + 71 × K bytes (e.g., 710 extra at K=10) |
| Inline section | 97 bytes | ~138 bytes (+41 vs §5.7.11) |
| Validator checks | 6 rules | 8 rules (+ fill-ratio validity + refund-vout enforcement) |
| Refund vout | none (exact fill, no leftover) | required when fill < max_fill |
| Recovery | chain-only via inline section | chain-only via inline section (identical) |
| Repeat-fill same bid | n/a (single fill) | single fill per bid in v1; repeated-fill is follow-up |

---

## Worker endpoints

```
POST   /assets/:asset_id/preauth-bids-var
GET    /assets/:asset_id/preauth-bids-var
GET    /assets/:asset_id/preauth-bids-var/:bid_id
DELETE /assets/:asset_id/preauth-bids-var/:bid_id          (signed cancel)
```

Worker validation on POST:

```
verify auth_sig under buyer_pubkey over bid_auth_msg
verify funding_outpoint exists, is unspent, is P2WPKH(buyer_pubkey),
  and has value == max_fill × price_per_unit + DUST_LIMIT + max_fee_budget
verify max_fee_budget ≤ 10_000
verify recipient_pubkey + refund_pubkey are valid compressed secp256k1 points
verify (max_fill - min_fill) % fill_increment == 0 AND K ≤ MAX_K (256)
for each i in [0, K-1]:
    fill_amount_i = min_fill + i × fill_increment
    reconstruct buyer_sats_spend_i sighash preimage (BIP-143, 0x83 flag,
      hashOutputs = dSHA256(canonical_OP_RETURN_i bytes for fill_amount_i)) — k is irrelevant per §5.7.8.1 position-independence
    verify ecdsa(sighash_i, signature_i[:-1], buyer_pubkey) succeeds
      and signature_i[-1] == 0x83
reject if a live preauth-bid-var already exists for the same funding_outpoint
enforce expiry ≤ 30 days from now
```

---

## Implementation plan

1. **Wire-format encoder/decoder** — `dapp/tacit.js` +
   `worker/src/index.js` gain `encodePreauthBidVarPayload` /
   `decodePreauthBidVarPayload`; both extend the §5.7.11
   wire-format pair with the variable inline section.
2. **Indexer validator** — new dispatch branch for `0x5C` that
   runs the 8 validation rules above (extends §5.7.11's 6 rules
   with fill-ratio validity + refund-vout enforcement).
3. **Buyer-side builder** (dapp) — `publishPreauthBidVar`:
   - Compute K bid_context_hash values (one per fill ratio).
   - Build K BIP-143 preimages, ECDSA-sign each.
   - Pre-fund split tx if needed (sized for max_fill).
   - POST to worker; cache locally for recovery.
4. **Seller-side taker** (dapp) — `takePreauthBidVar`:
   - GET bid record, pick a `fill_amount_i` to deliver.
   - Recompute `bid_context_hash_i`, fetch `buyer_sats_spend_i`.
   - Build envelope (inline section with the chosen
     fill_amount + canonical refund_script_hash) + kernel sig +
     bulletproof.
   - Assemble settlement tx with buyer's pre-signed input at
     `vin[k]` and canonical OP_RETURN at `vout[k]` + refund vout.
   - Broadcast; POST hint.
5. **Worker endpoints** — pure-function bid-var validation
   following the §5.7.11 handler shape; add K-sig batch verify
   on POST.
6. **Wallet recovery** — `scanHoldings` learns the
   `T_PREAUTH_BID_VAR` opcode + the same chain-only inline
   recovery path as §5.7.11.
7. **Composition path (interim)** — until `T_PREAUTH_BID_VAR`
   lands, the dapp can offer "set-and-forget partial-fill bid"
   UX via K parallel §5.7.11 exact-fill bids under the same
   recipient pubkey. Worker GET endpoints group them in the
   listing. Bridges the UX gap while the protocol primitive
   bakes.
8. **Signet e2e harness** —
   `tests/preauth-bid-var-onchain-e2e-signet.mjs` drives
   publish-bid → seller-fill-at-i → refund-vout-check exercised
   across multiple ratios.
9. **Cross-impl parity** — `tests/cross-impl-vectors-gen.mjs`
   gains fixtures pinning `OPCODE_T_PREAUTH_BID_VAR == 0x5C`
   and the new domain tags.

---

## Test-item checklist

- [ ] K-signature batch verify on bid POST (worker rejects bid
      if any of K signatures is malformed)
- [ ] `bid_context_hash_i` derivation parity dapp ↔ worker for
      K distinct fill ratios
- [ ] OP_RETURN bytes for each ratio (32-byte hash data push)
- [ ] Recipient binding check rejects tampering with envelope
      `output[0].commitment`
- [ ] Refund-vout enforcement (validator rejects tx with missing
      or wrong-value refund vout)
- [ ] Refund-vout enforcement at `fill_amount == max_fill`
      correctly skips the check
- [ ] Fill-ratio validity: validator rejects out-of-range
      `fill_amount` or non-aligned to `fill_increment`
- [ ] Sats-input payout floor (`buyer_funding_value` correctly
      sized for `max_fill × price_per_unit + DUST + max_fee_budget`)
- [ ] Position-independence: place the buyer's input + OP_RETURN
      at vin[2]/vout[2], vin[3]/vout[3], vin[5]/vout[5]
- [ ] Cancel flow — funding outpoint reclaimable via SIGHASH_ALL
      after cancel
- [ ] Stale-spent detection
- [ ] Chain-only recovery (no bid record cache)
- [ ] Unknown-opcode forward-compat
- [ ] K=1 degenerate case (single ratio = exact fill, structurally
      a `T_PREAUTH_BID` with extra inline bytes; validator accepts)
- [ ] K=MAX_K boundary
- [ ] Fee-spike unfillability: bid with `max_fee_budget = 1000`
      and simulated mempool minfee = 5000 — sellers correctly skip

---

## Dependencies

- **§5.7.11 `T_PREAUTH_BID`** — wire-format encoder/decoder
  pair, validator dispatch shape, chain-only-recovery pattern,
  `recipient_pubkey` script-match rule. `T_PREAUTH_BID_VAR`
  extends each of these without breaking the parent opcode.
- **§5.7 `T_AXFER`** — envelope kernel-sig construction,
  Pedersen + bulletproof stack reused verbatim.
- **§5.7.8 preauth-sale + §5.7.8.1 batched-take** —
  `SIGHASH_SINGLE_ACP` (`0x83`) usage precedent;
  position-independence invariant for the (vin[k], vout[k])
  pair.

No dependency on AMM ceremony / mixer / cBTC.zk / cBTC.tac.
Ships independent of the AMM ceremony — same as §5.7.11.

---

## Follow-up primitives

Out of scope for this amendment, deliberately deferred:

- **Repeated fills against the same bid.** Currently a bid is
  consumed by the first settlement (the funding outpoint is
  spent). A repeated-fill variant could let the seller fill
  `chunk_size` of the order and emit a child UTXO that's still
  valid for the remaining `max_fill - chunk_size`. Requires a
  recursive funding-outpoint structure or a covenant-style
  enforcement that splits the buyer's funding into per-chunk
  UTXOs at settlement. Substantial design work; defer to
  follow-up.
- **`T_PREAUTH_BID_BATCH` (reserved `0x5D`)** — one seller fills
  N preauth-bid-var orders in one settlement. Each buyer's
  pre-sig + canonical OP_RETURN at matching index; per-fill
  refund vouts. Pure flow-level optimization; substantial fee
  savings symmetric to §5.7.8.1.
- **`T_PREAUTH_MATCH` (reserved `0x5E`)** — third-party fulfiller
  cross-matches a §5.7.8 preauth-sale and a §5.7.12 preauth-bid-var
  into a single settlement. Both parties fully offline; fulfiller
  takes a small bounty from the implicit fee budget.

---

## Tracker notes

Drafted 2026-05-21 as the "holy grail UX" protocol primitive: a
single bid envelope where the buyer goes offline, the seller(s)
fill in chunks, and the chain enforces both the asset transfer
and the unfilled-portion refund. Builds directly on §5.7.11
exact-fill T_PREAUTH_BID (which is the K=1 degenerate case of
this amendment) with two structural additions: per-ratio
pre-signature set + protocol-enforced refund vout.

The K-pre-sig design avoids any new BIP-340 primitive, any new
covenant requirement, and any new ceremony coupling. Bid record
size scales linearly with K (~71 bytes per pre-sig); on-chain
overhead per settlement is +24 bytes vs §5.7.11. Implementation
mirrors §5.7.11 line-by-line with the K-sig batch verification
and refund-vout rule layered on top.
