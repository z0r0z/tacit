# SPEC §5.7.11 — T_PREAUTH_BID (`0x5B`) — Buyer-Offline Preauth Bid

> **Status: 📝 Reserved.** Opcode `0x5B` is reserved; the active
> walk-away-bid path is the watchtower (`ops/PLAN-walkaway-bid-watchtower.md`),
> which completes a buyer's fill online and signs the full settlement. The
> pre-signed construction below is kept as a reserved reference — it targets
> the symmetric gap in the
> §5.7 trading matrix: today the **seller** can go offline
> (preauth-sale, §5.7.8) but the **buyer** cannot — every existing
> bid path (§5.7.7 bid intents, §5.7.7 variable-fill bids) requires
> the buyer to be online during the take window. This amendment
> introduces `T_PREAUTH_BID` (`0x5B`), the buyer-offline counterpart
> to §5.7.8 preauth-sale, using `SIGHASH_SINGLE | ANYONECANPAY`
> semantics that Bitcoin already supports natively.
>
> **Framing.** Tacit hasn't shipped a buyer-pre-signed primitive
> yet; this is the gap the user-facing "sells just work" UX
> requires. The protocol's existing `T_AXFER` (`0x26`) handles the
> two halves of preauth-sale (seller pre-signs asset input, buyer
> assembles and broadcasts) but offers no envelope for the mirrored
> direction (buyer pre-signs sats input, seller assembles and
> broadcasts). Adding a single new opcode + canonical OP_RETURN
> binding closes that gap without touching `T_AXFER`'s validator.

---

## Motivation

The seller-side preauth (§5.7.8) made one-click listings work the
way marketplace users already expect from OpenSea / UniSat: post a
listing, walk away, get notified when someone buys. The bid side is
asymmetric — every bid primitive shipped to date requires the
**buyer** to be online during the take window:

| Path | Buyer-online required? | Reason |
|---|---|---|
| §5.7.7 bid intents (whole) | ✅ yes | Seller posts a §5.7.6 atomic-intent; buyer must take it within the 5-min claim window. |
| §5.7.7 variable-fill bids | ✅ yes | Each partial fulfilment seller posts a §5.7.9 `T_AXFER_VAR` atomic-intent; buyer must take each one. |
| §5.7.8 preauth-sale (taken by a bidder) | ✅ yes | Bidder is the buyer in this flow — they are by definition online assembling the take. |

This forces every bidding user into "wait online and refresh until
a seller appears" UX, which is unworkable for normie flows. A buyer
who wants to bid 100,000 sats for X TAC and step away can't —
they'd miss the take window and the seller's claim would expire.

The protocol-level fix is the symmetric primitive: the buyer
pre-signs **their sats input + the canonical bid binding** with
`SIGHASH_SINGLE | ANYONECANPAY`, and any seller can append their
asset UTXO + payout output and broadcast the settlement. Bitcoin
already supports this signature flag natively; tacit just needs to
carve out the envelope opcode that enforces the buyer's protections
(asset actually delivered, correct recipient, correct amount).

### Why a new opcode

§5.7.8 preauth-sale needed no new opcode because Bitcoin consensus
alone protects the seller — their pre-signed input invalidates any
tx that doesn't deliver the signed payout output. The settlement
is wire-indistinguishable from a normal §5.7.3 targeted `T_AXFER`.

The buyer's protection is harder. The buyer's pre-signed sats
input commits them to spending those sats; the question is what
they get in return. The asset commitment lives in the envelope
payload, not in a vout — Bitcoin's `SIGHASH_SINGLE` can't bind it
directly. A malicious seller using a vanilla `T_AXFER` could spend
the buyer's pre-signed sats input, build an envelope whose
recipient is the seller themselves, and walk away with both the
sats and the asset.

Closing that gap requires a tacit-protocol-level validator rule
that ties the buyer's pre-signed sats input to a canonical
**bid-context OP_RETURN** committing to `(asset_id, recipient,
amount, blinding)`. That rule doesn't belong in `T_AXFER` (it
would break every existing settlement); it belongs in a dedicated
opcode that signals "this envelope is a preauth-bid fulfilment and
the buyer's protections apply."

Hence `T_PREAUTH_BID` (`0x5B`). Wire-format and crypto reuse
`T_AXFER`'s kernel-sig + Pedersen + bulletproof stack verbatim;
the only delta is the OP_RETURN binding rule.

---

## The load-bearing primitive: `SIGHASH_SINGLE | ANYONECANPAY` on the buyer's sats input

§5.7.8 already canonicalized `0x83` (`SIGHASH_SINGLE |
SIGHASH_ANYONECANPAY`) for seller preauth on the asset input.
Preauth-bid uses the same flag byte on the **buyer's sats input**.
The BIP-143 preimage shape is identical to §5.7.8.1 with the
roles transposed:

```
nVersion          (4)
hashPrevouts      = 0x00..00      ← ANYONECANPAY zeros this
hashSequence      = 0x00..00      ← ANYONECANPAY (and SIGHASH_SINGLE) zero this
this.outpoint     (36)            ← buyer's sats UTXO outpoint
this.scriptCode   (varslice)      ← P2WPKH(buyer_pubkey)
this.value        (8)             ← buyer's sats UTXO value = price_sats + DUST + fee_budget
this.nSequence    (4)             ← 0xfffffffd
hashOutputs       = dSHA256(serialize(outputs[input_index]))
                                  ← SIGHASH_SINGLE hashes ONLY same-index output
nLocktime         (4)             ← 0
nHashType         (4)             ← 0x83
```

The buyer signs assuming their sats input lands at `vin[k]` and the
canonical bid-context OP_RETURN at `vout[k]`. Position-independence
(per §5.7.8.1) carries through identically: the seller may place
the pair at any `k ∈ [1, 255]` as long as both shift together.

---

## Bid-context OP_RETURN binding

The canonical output the buyer's sig commits to is a 34-byte
`OP_RETURN(32)` carrying the full bid-context hash with no
on-chain tag prefix:

```
vout[k] = {
  value:    0,
  script:   OP_RETURN(0x6a) || OP_PUSHBYTES_32(0x20) || bid_context_hash(32)
}

bid_context_hash = SHA256(
    "tacit-preauth-bid-context-v1"
    || asset_id(32)
    || bid_id(16)
    || recipient_pubkey(33)
    || amount_LE(8)
    || blinding(32)
    || price_sats_LE(8)
)
```

This matches the **envelope-hash commit** pattern tacit already
uses for `T_SWAP_BATCH` (§5.16) `vout[0] =
OP_RETURN(SHA256(payload))` and `T_WRAPPER_ATTEST` (§5.19)
`vout[0] = OP_RETURN(envelope_hash)`. Domain-tagging lives in the
hash construction (the `tacit-preauth-bid-context-v1` ASCII prefix
inside the SHA256 input), not in the on-chain bytes — same
convention as every existing tacit HMAC keystream and every shipped
envelope-hash binding.

### Why no on-chain ASCII tag

Comparison with the four other on-chain OP_RETURN forms tacit
already uses:

| Surface | Shape | Length | Domain tag bytes on chain? | Purpose |
|---|---|---|---|---|
| `T_AXFER` recovery (§5.7.6) | `OP_RETURN(0x6a) \|\| OP_PUSHBYTES_40 \|\| ciphertext_40` | 42 B | none — keystream HMAC is domain-tagged | encrypted `(amount, r)` recovery payload |
| `T_AXFER_VAR` recovery (§5.7.6.1) | `OP_RETURN(0x6a) \|\| OP_PUSHDATA1 \|\| 0x50 \|\| ciphertext_80` | 83 B | none — both keystream HMACs are domain-tagged | dual-party encrypted recovery |
| `T_SWAP_BATCH` envelope commit (§5.16) | `OP_RETURN(0x6a) \|\| OP_PUSHBYTES_32 \|\| SHA256(payload)` | 34 B | none — full 32-byte hash | binds trader `SIGHASH_ALL` to envelope content |
| `T_WRAPPER_ATTEST` envelope commit (§5.19) | `OP_RETURN(0x6a) \|\| OP_PUSHBYTES_32 \|\| envelope_hash` | 34 B | none — full 32-byte hash | binds 159-byte attestation payload via commit-reveal |
| **`T_PREAUTH_BID` bid-context commit (this amendment)** | `OP_RETURN(0x6a) \|\| OP_PUSHBYTES_32 \|\| bid_context_hash` | 34 B | none — full 32-byte hash | binds buyer's `SIGHASH_SINGLE_ACP` sig to envelope recipient + amount |

Tacit's existing on-chain OP_RETURN bytes are either **opaque
ciphertext** (recovery payloads) or **raw 32-byte hashes**
(envelope commits). None carry an ASCII tag in the wire bytes.
Adding one here would be a one-off departure with no payoff:

- **Dispatch is opcode-driven, not OP_RETURN-prefix-driven.** The
  validator already knows the tx is a preauth-bid because the
  envelope at `vin[0].witness` decodes to opcode `0x5B`. The
  OP_RETURN at `vout[k]` is found by position (matching the
  buyer's pre-signed `vin[k]`), not by ASCII scanning.
- **Greppability is at the envelope opcode layer.** Chain explorers
  index tacit envelopes by their decoded opcode (the existing
  worker scanner already enumerates `0x21`–`0x4F` and the dapp UI
  surfaces them by name). The OP_RETURN bytes carrying a 32-byte
  hash are not human-meaningful regardless of prefix.
- **32-byte hash gives 256-bit binding security**, vs ~152 bits
  for a 19-byte truncation. The full hash is the safer default.
- **Saves 8 bytes on-chain** (~80 sats at 10 sat/vB) per
  settlement vs the 40-byte tagged form. Pure win.
- **Forward-compatible.** Future preauth-bid variants (variable
  amount, batched fill) can reuse the same `OP_RETURN(32)` shape
  with different hash-input layouts — same as how `T_SWAP_BATCH`
  and `T_WRAPPER_ATTEST` share the `OP_RETURN(SHA256(payload))`
  shape with different payload schemas.

The encrypted-recovery OP_RETURNs (§5.7.6, §5.7.6.1) **are** tagged
in their HMAC keystream construction — see the
`tacit-axintent-onchain-{amount,blinding}-v1` and
`tacit-axintent-onchain-maker-{amount,blinding}-v1` keystream
domains in §3. The on-chain bytes themselves carry no tag.
`T_PREAUTH_BID` follows the same pattern: tagged in the hash
input (`tacit-preauth-bid-context-v1` inside the SHA256), opaque
in the on-chain bytes.

---

## `T_PREAUTH_BID` envelope (`0x5B`)

The envelope is structurally a `T_AXFER` (single asset, N=1
recipient) with the preauth-bid opcode byte **and an inline
bid-context section** carrying the recipient's `(amount, blinding)`
opening + `(recipient_pubkey, bid_id, price_sats)` in cleartext.
Inlining lets the validator verify the OP_RETURN binding chain-only
without ingesting the off-chain bid record (symmetric to §5.7.8
preauth-sale, where the buyer's recipient blinding is recoverable
via ECDH from chain alone). The lot-level opening was already public
in the bid record — putting it on chain does not add any new
disclosure.

```
opcode             = 0x5B (T_PREAUTH_BID, 1 byte)
asset_id           = 32 bytes
asset_input_count  = N ≥ 1     (single-seller fill: N=1; multi-seller fan is reserved
                                for a future amendment, position-independent under
                                the same SIGHASH_SINGLE_ACP invariant as §5.7.8.1.
                                Counts SELLER asset inputs only — the buyer's sats
                                input is auxiliary BTC, NOT part of the tacit
                                kernel_msg input_outpoints list)

--- inline bid-context (97 bytes, validator-readable in cleartext) ---
bid_id             = 16 bytes  (matches the off-chain bid record's bid_id)
recipient_pubkey   = 33 bytes  (compressed secp256k1; where the asset is delivered)
amount_LE          = 8 bytes   (recipient lot amount; opens output[0].commitment with blinding)
blinding           = 32 bytes  (recipient lot blinding; opens output[0].commitment with amount)
price_sats_LE      = 8 bytes   (buyer-committed sats payment; matches bid record)
---

kernel_sig         = 64 bytes (BIP-340 over kernel_msg, signed by seller with `excess`)
N_outputs          = 1 or 2   (∈ {1, 2} — 1 = exact-amount fill, 2 = seller has asset change)
output[0]:                                          ← buyer's tacit recipient
  commitment       = 33 bytes — pedersen(amount, blinding); MUST verify against the
                                inline (amount, blinding) above
  (no encryptedAmount — amount is in the inline cleartext section above; saves 8 bytes
   vs the early-draft self-keystream payload and removes the buyer-priv recovery dependency)
output[1]:                                          ← seller's asset change (OPTIONAL)
  commitment       = 33 bytes — pedersen(seller_change_amount, seller_change_blinding)
  encryptedAmount  = 8 bytes  — encrypted under seller's self-recovery keystream (§5.7.6
                                pattern; recoverable by seller alone)
rp_len             = 2 bytes (LE)
rangeproof         = aggregated bulletproof for {output[0]} or {output[0], output[1]}
```

Net on-chain cost vs the early draft: +89 bytes (inline section) − 8
bytes (output[0] encryptedAmount removed) = **+81 bytes per
settlement**. At 10 sat/vB mainnet this is ~$0.10 per fill — a
trivial premium for chain-only validation and chain-only recovery.

### Kernel signature

Standard `T_AXFER` kernel sig, signed by the seller using `excess`:

```
excess = (blinding - Σ_i seller_blinding_i) mod n
       (if N_outputs == 1, no seller change; just buyer's r_out)

  -- OR --

excess = (blinding + seller_change_blinding - Σ_i seller_blinding_i) mod n
       (if N_outputs == 2, with seller-self change)
```

`kernel_msg` reuses the shared `tacit-kernel-v1` domain from §5.4
/ §5.7.9 / §5.20 verbatim. The buyer's `blinding` is public (in
the bid record); the seller's blindings remain private under their
wallet. The seller signs the kernel sig — they have both pieces.

---

## Settlement tx layout (single-seller fill)

The seller is the assembler, so the seller broadcasts **two** Bitcoin
txs (commit + reveal), mirroring the buyer's role in §5.7.8.1:

**Commit tx** (seller broadcasts first):

```
vin[*]       seller's BTC funding (P2WPKH, SIGHASH_ALL)
vout[0]      P2TR address whose script-path leaf carries the T_PREAUTH_BID envelope
vout[*]      seller change (OPTIONAL)
```

**Reveal tx** (seller broadcasts after commit relays):

```
vin[0]       seller's commit P2TR                              — script-path spend
                                                                  revealing the envelope
vin[1]       seller's asset UTXO                               — kernel-sig consumed,
                                                                  seller SIGHASH_ALL sig
                                                                  on the P2WPKH spend
vin[2]       buyer's sats UTXO                                 — SIGHASH_SINGLE|ACP (0x83),
                                                                  pre-signed at bid time

vout[0]      buyer's tacit recipient (DUST P2WPKH to recipient_pubkey)
vout[1]      seller's sats payout                              — value ≥ price_sats,
                                                                  P2WPKH(seller_chosen_script)
vout[2]      OP_RETURN(bid_context_hash)                       — 34-byte scriptPubKey,
                                                                  bound by buyer's vin[2] sig
[vout[3]]    seller's asset change tacit dust (OPTIONAL)        — present iff N_outputs == 2;
                                                                  P2WPKH(seller_pubkey) DUST
```

The buyer's recipient sits at `vout[0]` — the standard `T_AXFER`
slot, so the recovery scanner finds the output without a schema
change. The OP_RETURN binding is **not** at `vout[0]` (which is
the tacit-recipient slot); it lands at `vout[2]` matching the
buyer's `vin[2]`. Position-independence (per §5.7.8.1) means the
seller MAY shift the buyer-input/OP_RETURN pair to any matching
`(vin[k], vout[k])` — both indices must move together.

---

## Buyer pre-fund step

The buyer's pre-signed sats input must be a P2WPKH UTXO of value:

```
buyer_funding_value = price_sats + DUST_LIMIT + max_fee_budget
                    where DUST_LIMIT       = 546 sats (P2WPKH dust threshold)
                          max_fee_budget   = bid.max_fee_budget (default 1000 sats,
                                              bounded ≤ 10_000 sats per bid)
```

`SIGHASH_SINGLE | ANYONECANPAY` only binds the input → same-index
output pair, not the rest of the tx. To prevent a malicious seller
from taking unbounded surplus (e.g., overpaying themselves), the
buyer sizes the funding UTXO exactly. Any sats above
`price_sats + DUST + actual_fee` go to the seller as an implicit
tip; bounding `max_fee_budget` caps the tip leakage.

If the buyer doesn't already have a P2WPKH UTXO of the exact
required value, the bid-publish flow MUST first broadcast a
one-time pre-fund tx splitting `buyer_funding_value` off the
buyer's wallet into a dedicated outpoint. This is one extra Bitcoin
tx per bid publication (~150 vB, ~$0.30 mainnet at minfee). The
buyer can reclaim the dedicated UTXO via a normal `SIGHASH_ALL`
spend if the bid expires unfilled — the `SIGHASH_SINGLE_ACP`
signature does not lock the UTXO; it only authorizes one specific
spend pattern that any settlement tx may use.

The bid record carries the funding outpoint cleartext (txid + vout
+ value) so the seller can fetch it from a node and assemble the
settlement without an additional buyer round-trip.

**Fee-spike unfillability.** `max_fee_budget` is capped at 10_000
sats per bid (≈ a 30-day mainnet ceiling at typical conditions).
If network fees spike above the bid's budget mid-window, the
settlement becomes uneconomical and sellers will skip the bid until
fees relax (or the bid expires and the buyer reclaims). Buyers
exposed to long-duration high-fee regimes should either size
`max_fee_budget` toward the cap, accept reduced fill probability,
or fall back to the §5.7.7 online-buyer bid path.

---

## Bid record (off-chain)

The off-chain bid book stores one record per active preauth-bid:

```
preauth_bid {
  bid_id                 16 bytes / 32 hex chars (sha256(
                           "tacit-preauth-bid-id-v1"
                           || asset_id || buyer_pubkey || nonce)[:16])
  asset_id               32 bytes
  buyer_pubkey           33 bytes (compressed) — owner of the funding UTXO,
                                                  signs auth + sats input
  recipient_pubkey       33 bytes (compressed) — where the asset is delivered
                                                  (MAY equal buyer_pubkey)
  amount                 u64 — bid amount, cleartext (matches envelope opening)
  blinding               32 bytes — recipient lot blinding, cleartext (matches envelope opening)
  price_sats             u64 — total sats payment
  max_fee_budget         u64 (≤ 10_000) — cap on implicit fee/tip
  funding_outpoint       { txid: 32B BE, vout: u32, value: u64 } — buyer's pre-funded P2WPKH UTXO
  expiry                 unix-seconds (≤ 30 days from publish — short window
                                       because the funding UTXO is locked
                                       opportunity-cost-wise during the bid)
  nonce                  16 bytes, deterministically derived:
                           nonce = HMAC-SHA256(buyer_priv,
                                     "tacit-preauth-bid-nonce-v1"
                                     || funding_outpoint_txid_BE(32)
                                     || funding_outpoint_vout_LE(4)).first16
                           Reproducible from privkey + funding outpoint, so a wallet
                           with no local bid cache can regenerate the bid record
                           byte-for-byte for cancel/re-publish flows.
  buyer_sats_spend       { signature_hex: ECDSA(low-S) || 0x83 byte }
                                       — pre-signature over the SIGHASH_SINGLE|ACP
                                         preimage of the funding outpoint binding to
                                         the canonical OP_RETURN vout
  auth_sig               BIP-340 over bid_auth_msg, under buyer_pubkey
  status                 'live' | 'taken' | 'cancelled' | 'expired' | 'stale_spent'
}
```

The `(amount, blinding)` opening of the **recipient** lot is public
in the bid record — symmetric to §5.7.8 publishing the **seller**'s
listed-UTXO opening. The trade-off is identical: pre-disclosure of
one lot in exchange for the ability to go offline. A buyer who
values lot-level privacy more than the offline UX should route
through §5.7.7 bid intents instead.

### Canonical messages

```
bid_auth_msg = SHA256(
    "tacit-preauth-bid-v1"
    || asset_id(32) || bid_id(16) || buyer_pubkey(33) || recipient_pubkey(33)
    || amount_LE(8) || blinding(32)
    || price_sats_LE(8) || max_fee_budget_LE(8)
    || funding_outpoint_txid_BE(32) || funding_outpoint_vout_LE(4) || funding_outpoint_value_LE(8)
    || expiry_LE(8)
    || varslice(buyer_sats_spend_signature)        // DER || 0x83
    || nonce(16)
)

bid_cancel_msg = SHA256("tacit-preauth-bid-cancel-v1" || asset_id || bid_id)
```

The `bid_context_hash` (which the OP_RETURN binds) is derived
deterministically from a subset of these fields per the formula in
the §"Bid-context OP_RETURN binding" section above — the worker
recomputes it on each fill and verifies the broadcast tx's
OP_RETURN matches.

### Lifecycle

```
[pre-fund]  buyer:   (if needed) broadcast 1 tx to create funding UTXO of value
                     price_sats + DUST + max_fee_budget at buyer's P2WPKH
[publish]   buyer:   build bid record + buyer_sats_spend signature → POST /preauth-bids
[browse]    anyone:  GET /preauth-bids → discover open bids
[take]      seller:  GET /preauth-bids/:bid_id → build T_PREAUTH_BID envelope
                     + kernel sig + bulletproof, broadcast COMMIT tx funding a
                     P2TR(envelope-script-leaf), then broadcast REVEAL tx with
                     vin[0]=commit P2TR (script-path), vin[1]=seller asset UTXO,
                     vin[2]=buyer's pre-signed sats input, vouts per the canonical
                     layout including the OP_RETURN at vout[2] matching vin[2]
[settled]   anyone:  on-chain T_PREAUTH_BID indexes; buyer's wallet finds the new lot at
                     vout[0] via the published (amount, blinding)
[cancel]    buyer:   POST /preauth-bids/:bid_id/cancel (signed) → status = 'cancelled';
                     funding UTXO becomes reclaimable via SIGHASH_ALL self-spend
            anyone:  funding outpoint spent in any non-fulfillment tx → 'stale_spent'
                     expiry passes → 'expired' on read
```

---

## Indexer validation

The `T_PREAUTH_BID` validator MUST enforce, in addition to the
standard `T_AXFER` checks (Pedersen conservation, bulletproof
range, kernel-sig verification, opcode-byte dispatch). All checks
are chain-only — the inline bid-context section provides every
field the validator needs without ingesting the off-chain bid
record.

1. **Inline opening consistency.** `output[0].commitment` MUST
   equal `pedersen(amount, blinding)` where `(amount, blinding)`
   are read from the envelope's inline bid-context section.
2. **Recipient script match.** `vout[0].script` MUST equal
   `P2WPKH(hash160(recipient_pubkey))` where `recipient_pubkey` is
   the 33-byte compressed key from the inline section. This binds
   the on-chain recipient to the cleartext pubkey the OP_RETURN
   hashes.
3. **OP_RETURN presence.** Some `vout[k]` in the broadcast tx MUST
   match the canonical pattern `OP_RETURN OP_PUSHBYTES_32 || hash32`
   (34-byte scriptPubKey, value = 0).
4. **Buyer-input position match.** Some `vin[k]` MUST share the
   same `k` as the OP_RETURN vout. Its witness MUST contain a
   valid ECDSA signature with trailing byte `0x83` (SIGHASH_SINGLE
   | ANYONECANPAY) over the BIP-143 preimage of that input pinning
   `vout[k]` to the canonical OP_RETURN.
5. **Bid-context hash binding.** The 32-byte hash embedded in the
   OP_RETURN MUST equal:
   ```
   SHA256(
       "tacit-preauth-bid-context-v1"
       || asset_id(32)              ← from envelope's asset_id field
       || bid_id(16)                ← from inline section
       || recipient_pubkey(33)      ← from inline section
       || amount_LE(8)              ← from inline section
       || blinding(32)              ← from inline section
       || price_sats_LE(8)          ← from inline section
   )
   ```
   Every input is now on-chain in cleartext (either in the envelope
   payload or derived from `vout[0].script`), so the validator
   recomputes this hash without any off-chain dependency.
6. **Sats-input payout floor.** The vin at position `k` MUST be a
   P2WPKH spend of an outpoint with `value ≥ price_sats +
   DUST_LIMIT` (using `price_sats` from the inline section). The
   seller's payout (some other vout with `value ≥ price_sats` to
   any P2WPKH script the seller chooses) is **not** protocol-
   enforced — the buyer's funding-UTXO sizing implicitly bounds the
   seller's take.

Indexers that don't know `T_PREAUTH_BID` (`0x5B` not yet
deployed) treat it as an unknown opcode per §5.5 forward-compat
and the envelope is a no-op at the asset and pool-state level —
soft-fork-additive, same posture as every shipped post-launch
amendment.

---

## Recovery semantics

With inline bid-context, recovery is **chain-only** — no bid
record needed at all. The buyer's wallet:

1. Scans recent blocks for `T_PREAUTH_BID` envelopes.
2. For each envelope, reads the inline section's
   `recipient_pubkey`. If `recipient_pubkey == buyer_pubkey` (or
   matches any stealth address the wallet owns the spend key for),
   the envelope is theirs.
3. Reads `(amount, blinding)` from the inline section to derive
   the recipient lot's opening. Verifies
   `pedersen(amount, blinding) == output[0].commitment` as a sanity
   check.
4. Credits the new UTXO at `vout[0]` into the wallet's holdings.

No bid record cache, no worker round-trip, no
`(buyer_priv, funding_outpoint, nonce)` re-derivation needed. This
is the strongest recovery profile in the §5.7 trading family —
even §5.7.8 preauth-sale needs an ECDH compute against the seller's
pubkey from the witness; preauth-bid just reads the inline cleartext.

The bid record's `nonce` (16 bytes) is still deterministically
derived from the buyer's privkey + funding outpoint to keep
bid-publish reproducible and so a wallet that's lost its local bid
cache can regenerate the bid record byte-for-byte if it needs to
re-publish or cancel:

```
nonce = HMAC-SHA256(
    buyer_priv,
    "tacit-preauth-bid-nonce-v1"
    || funding_outpoint_txid_BE(32)
    || funding_outpoint_vout_LE(4)
).first16
```

The seller's asset-change UTXO (if `N_outputs == 2`) recovers via
§6 path 4 same as any `T_AXFER` self-blinded change.

---

## Failure semantics

### Pre-broadcast (buyer cancels or funding outpoint spent)

If the buyer cancels via signed `bid_cancel_msg`, the worker marks
the bid `cancelled` and stops serving it. The buyer reclaims the
funding UTXO via a normal `SIGHASH_ALL` self-spend (the
`SIGHASH_SINGLE_ACP` signature is non-exclusive — any spending
authority over the P2WPKH outpoint can spend it).

If the buyer simply spends the funding outpoint in any other
context, the next worker outspend scan marks the bid `stale_spent`
and stops serving it. Settlement attempts that race against the
spend are rejected by Bitcoin consensus (double-spend) at relay
time.

### Post-broadcast (settlement fails to confirm)

If the seller's broadcast settles into the mempool but is reorg-ed
out or RBF-replaced before depth 3, the envelope re-enters the
scanner queue. The bid record stays `live` (the worker dedupes by
`(bid_id, settlement_txid)`) and the seller may re-broadcast or
another seller may take. The buyer's pre-signature carries through
unchanged — it's not bound to any specific `settlement_txid`.

### Seller-side griefing risk (commit-tx fee loss)

The seller's commit-reveal flow exposes them to the same griefing
shape as §5.7.8 preauth-sale: between the seller's commit-tx
broadcast and the reveal-tx confirmation, a malicious buyer can
double-spend the funding outpoint via a SIGHASH_ALL self-spend.
The seller's reveal tx then fails Bitcoin consensus (the buyer's
pre-signed input no longer exists), and the seller loses the
commit-tx fee (~150-300 sats at mainnet minfee on a typical P2TR
commit). This is **not** a value-extraction griefing (the buyer
gains nothing beyond the funding-outpoint's sats), so the threat
profile is identical to §5.7.8 preauth-sale and identical to every
Bitcoin OTC marketplace: a worker-side outspend pre-check
immediately before the seller's commit broadcast minimizes the
window, and sellers SHOULD treat unexpired bids with recent
funding-outpoint activity as elevated risk. No protocol-level
griefing mitigation in this round-1 amendment; a follow-up could
add a buyer bond output the seller forfeits on cancel.

### Worker downtime

The worker is a coordination cache; if the worker is offline,
sellers cannot discover open bids but cannot mis-settle either.
A seller who already cached a bid record off-worker (via, e.g.,
the bid's pubsub broadcast) can still assemble and broadcast
without the worker being present — the on-chain validator path
needs only the inline bid-context section + Bitcoin consensus, no
off-chain bid record required.

---

## Comparison with §5.7.8 (preauth-sale)

|  | §5.7.8 preauth-sale | §5.7.11 preauth-bid (this amendment) |
|---|---|---|
| Initiator | seller | buyer |
| Goes offline | seller | buyer |
| Pre-signs | asset input → sats payout (SIGHASH_SINGLE_ACP) | sats input → OP_RETURN bid-context (SIGHASH_SINGLE_ACP) |
| Assembles tx | buyer | seller |
| Pre-fund step | none (uses existing asset UTXO) | one tx (sizes funding UTXO exactly) |
| Lot-level disclosure | seller's listed UTXO opening | buyer's recipient lot opening |
| Envelope opcode | `T_AXFER` (`0x26`) — no validator change | `T_PREAUTH_BID` (`0x5B`) — OP_RETURN binding rule |
| Recovery anchor | ECDH(buyer.priv, seller.pub, seller.outpoint, 0) — chain only, decode `vin[1].witness[1]` to learn seller_pubkey | inline bid-context section in the envelope — chain only, read `recipient_pubkey, amount, blinding` from the cleartext payload (no ECDH, no bid record) |
| Position-independence | yes (§5.7.8.1) | yes (BIP-143 SIGHASH_SINGLE_ACP preimage is k-invariant for matched input/output pairs — same invariant as §5.7.8.1) |

Both flows can coexist on the same asset, alongside §5.7.6
atomic intents and §5.7.7 bid intents — the four primitives form
a symmetric matrix:

|  | seller-online (private lot) | seller-offline (public lot) |
|---|---|---|
| **buyer-online (private lot)** | §5.7.6 atomic intent | §5.7.8 preauth-sale |
| **buyer-offline (public lot)** | §5.7.11 preauth-bid (this amendment) | both pre-sign — *follow-up* primitive (see *Follow-up* below) |

---

## Backwards-compatibility

This amendment introduces **no breaking changes**:

1. **No `T_AXFER` change.** `T_PREAUTH_BID` is a new opcode at
   `0x5B`. The §5.7.8 preauth-sale flow continues to use
   `T_AXFER` (`0x26`) unchanged.
2. **No §5.7.7 change.** Existing off-chain bid-intent records
   continue to work. A dapp may surface preauth-bid as a new
   option alongside the existing online-buyer bid path.
3. **Soft-fork-additive.** Indexers that don't know `0x5B` see it
   as an unknown opcode per §5.5 and ignore it — the asset and
   pool state are unaffected. They DO miss the recipient credit,
   so the receiving wallet sees the asset only after upgrading to
   a `0x5B`-aware indexer (or by manually rescanning).
4. **No wallet-scanner change for sellers.** Sellers' fulfilment
   settlement records as `T_PREAUTH_BID` events; existing seller
   wallets that recognize `T_AXFER` events generalize trivially
   (same vout[0] = recipient, same vout[N] = change layout).

---

## Domain tag additions

Add to §3 *BIP-340 Schnorr signature-message tags*:

- `tacit-preauth-bid-v1` — bid auth message domain.
- `tacit-preauth-bid-cancel-v1` — bid cancel message domain.
- `tacit-preauth-bid-id-v1` — `bid_id` derivation domain.
- `tacit-preauth-bid-context-v1` — OP_RETURN binding hash domain
  (the canonical hash the buyer's `SIGHASH_SINGLE_ACP` signature
  pins to vout).

Add to §3 *HMAC keystream domains*:

- `tacit-preauth-bid-nonce-v1` — deterministic `nonce` derivation
  from `(buyer_priv, funding_outpoint)`, so the bid record is
  reproducible from privkey + chain alone.

No new on-chain ASCII tags. The OP_RETURN payload is the raw
32-byte `bid_context_hash` — same shape as `T_SWAP_BATCH` (§5.16)
and `T_WRAPPER_ATTEST` (§5.19) envelope-hash commits. Domain
tagging lives in the hash-input prefix
(`tacit-preauth-bid-context-v1`), not on chain.

The recipient blinding is **not** self-derived in this amendment —
it is published in cleartext via the inline bid-context section
(symmetric to §5.7.8 publishing the seller's listed-UTXO opening).
The buyer chooses any random 32-byte blinding at bid-publish time;
recovery does not require re-deriving it.

No new BIP-340 cryptographic primitive — the buyer's
`buyer_sats_spend` is a standard ECDSA(low-S) P2WPKH signature
with the existing `0x83` flag byte.

---

## Worker endpoints (reference)

```
POST   /assets/:asset_id/preauth-bids
GET    /assets/:asset_id/preauth-bids
GET    /assets/:asset_id/preauth-bids/:bid_id
DELETE /assets/:asset_id/preauth-bids/:bid_id          (signed cancel)
```

Worker validation on POST:

```
verify auth_sig under buyer_pubkey over bid_auth_msg
verify funding_outpoint exists, is unspent, is P2WPKH(buyer_pubkey),
  and has value == price_sats + DUST_LIMIT + max_fee_budget
verify max_fee_budget ≤ 10_000
verify recipient_pubkey is a valid compressed secp256k1 point
reconstruct buyer_sats_spend sighash preimage (BIP-143, 0x83 flag,
  this.outpoint = funding_outpoint, this.scriptCode = P2WPKH(buyer_pubkey),
  this.value = funding_outpoint.value, this.nSequence = 0xfffffffd,
  hashOutputs = dSHA256(serialize(canonical_op_return_vout))) — the index k
  is irrelevant since the canonical OP_RETURN bytes fix hashOutputs k-invariantly
  (position-independence per §5.7.8.1).
verify ecdsa(sighash, signature[:-1], buyer_pubkey) succeeds
  and signature[-1] == 0x83
reject if a live preauth-bid already exists for the same funding_outpoint
enforce expiry ≤ 30 days from now
```

Worker validation on take (advisory only — Bitcoin + indexer
consensus enforces the binding):

```
verify funding_outpoint still unspent
verify a seller-side asset UTXO of value ≥ amount exists
recompute bid_context_hash and verify it matches the take request's
  planned OP_RETURN bytes
```

---

## Implementation plan

1. **Wire-format encoder/decoder** — `dapp/tacit.js` + `worker/src/index.js`
   gain `encodePreauthBid` / `decodePreauthBid`; both reuse the
   `T_AXFER` opcode-byte dispatch table extended with `0x5B`.
2. **Indexer validator** — new dispatch branch in §5.5 that runs
   the four OP_RETURN-binding checks above on top of the existing
   `T_AXFER` validator path.
3. **Buyer-side builder** (dapp) — `publishPreauthBid`:
   - Compute `bid_context_hash`, build BIP-143 preimage, ECDSA-sign.
   - Pre-fund step: if no exact-value UTXO exists, broadcast a one-tx split.
   - POST to worker; cache locally for recovery.
4. **Seller-side taker** (dapp) — `takePreauthBid`:
   - GET bid record, validate fields, recompute hash.
   - Build envelope + kernel sig + bulletproof.
   - Assemble settlement tx with buyer's pre-signed input at
     `vin[k]` and canonical OP_RETURN at `vout[k]`.
   - Broadcast; POST hint.
5. **Worker endpoints** — pure-function bid validation following
   the §5.7.8 preauth-sale handler shape; add per-bid CAS lock on
   take to prevent racing.
6. **Wallet recovery** — `scanHoldings` learns the
   `T_PREAUTH_BID` opcode and the bid-record-anchored recovery
   path. Falls back to self-derived blinding from buyer.priv +
   funding_outpoint + nonce if the bid record isn't cached.
7. **Signet e2e harness** — `tests/preauth-bid-onchain-e2e-signet.mjs`
   drives publish-bid → seller-fill → bid-context-hash binding
   exercised under all three failure modes (cancel pre-fill,
   funding-outpoint double-spend, settlement reorg).
8. **Cross-impl parity** — `tests/cross-impl-vectors-gen.mjs`
   gains fixtures pinning `OPCODE_T_PREAUTH_BID == 0x5B` and the
   four new domain tags.

---

## Test-item checklist (round-1)

- [ ] BIP-143 preimage construction parity dapp ↔ worker (4 fixture
      vectors: amount=1, amount=2^32, amount=2^63-1, blinding= all-zero)
- [ ] `bid_context_hash` derivation parity dapp ↔ worker
- [ ] OP_RETURN bytes pinning (32-byte hash data push; total
      scriptPubKey = 34 bytes: `0x6a 0x20 || hash32`)
- [ ] Recipient binding check rejects tampering with envelope
      `output[0].commitment`
- [ ] Recipient binding check rejects tampering with `vout[0].script`
- [ ] Sats-input payout floor enforcement (input value ≥
      price_sats + DUST)
- [ ] `SIGHASH_SINGLE_ACP` position-independence test (place the
      buyer's input + OP_RETURN at vin[2]/vout[2], vin[3]/vout[3],
      vin[5]/vout[5]; sig validates at all three slots)
- [ ] Funding-UTXO sizing reject path (worker rejects POST if
      `funding_outpoint.value != price_sats + DUST + max_fee_budget`)
- [ ] Cancel flow — funding outpoint becomes self-spendable via
      SIGHASH_ALL after cancel
- [ ] Stale-spent detection — funding outpoint spent in unrelated
      tx → worker marks bid stale on next outspend scan
- [ ] Recovery from bid record alone (cached)
- [ ] Recovery from funding_outpoint + buyer.priv + nonce alone
      (no cache; re-derive blinding via self-blinding HMAC)
- [ ] Unknown-opcode forward-compat: pre-amendment indexer treats
      `0x5B` as no-op (no asset credit, no state error)
- [ ] `encryptedAmount` self-keystream parity dapp ↔ worker
      (buyer recovers amount from privkey + chain alone, no bid-record
      dependency)
- [ ] Fee-spike unfillability: bid with `max_fee_budget = 1000` and
      simulated mempool minfee = 5000 — sellers correctly skip,
      bid expires cleanly, funding outpoint reclaimable

---

## Dependencies

- **§5.7 `T_AXFER`** — envelope wire format, kernel-sig
  construction, Pedersen + bulletproof stack reused verbatim
  (only the opcode byte + OP_RETURN binding rule differ).
- **§5.7.8 preauth-sale** — `SIGHASH_SINGLE_ACP` (`0x83`) usage
  precedent; the BIP-143 preimage construction in this amendment is
  the mirror-image of the seller's signature defined there.
- **§3.5 / §6 path 4 self-blinding HMAC** — used to derive the
  buyer's recipient `blinding` from `(buyer.priv, funding_outpoint,
  nonce)` when wallet recovery has no cached bid record.

No dependency on any AMM / mixer / cBTC.zk / cBTC.tac surface.
Ships independent of the AMM ceremony.

---

## Follow-up primitives

Out of scope for this amendment, deliberately deferred to
follow-ups. SPEC.md reserves the contiguous block `0x5C`–`0x5E`
adjacent to `T_PREAUTH_BID` (`0x5B`) for these three variants so
the **preauth/offline-trading family** stays clustered as it
grows:

- **`T_PREAUTH_BID_VAR` (reserved `0x5C`) — variable-amount
  preauth-bid.** Buyer publishes `(min_fill, max_fill)` and a
  per-unit price. Seller picks a fill chunk; the buyer's pre-sig
  validates across fill ratios via an aggregated commitment trick.
  Mirrors §5.7.6.1 on the buyer side. Substantial crypto
  extension — the OP_RETURN binding has to commit to the fill
  ratio without fixing the absolute amount.
- **`T_PREAUTH_BID_BATCH` (reserved `0x5D`) — batched-fill
  preauth-bid.** One seller fills N buyer preauth-bids in one
  settlement tx. The position-independence invariant from §5.7.8.1
  carries through — each buyer's pre-sig validates at the slot the
  seller chooses, provided the OP_RETURN at matching index decodes
  to that buyer's bid. Pure flow-level optimization once per-fill
  basics ship; ~70% fee reduction symmetric to §5.7.8.1.
- **`T_PREAUTH_MATCH` (reserved `0x5E`) — both-sides preauth /
  fully-offline market.** Seller posts a preauth-sale + buyer
  posts a preauth-bid that matches the same `(asset_id, amount,
  price_sats)` quadrant. A third-party fulfiller (anyone)
  assembles the cross-spend in one tx and takes a small bounty
  from the implicit fee budget. Mechanically the most powerful
  primitive — both parties can be offline indefinitely — but
  requires careful spec work on the bounty output. Reserved for a
  follow-up after the basic preauth-bid bakes.

---

## Tracker notes

Drafted 2026-05-20 in response to the "sells just work" UX
observation that today's bid paths all require the buyer to be
online during the take window. Symmetric closure of the trading
matrix: §5.7.8 made the **ask** side offline-capable for the
seller; this amendment makes the **bid** side offline-capable for
the buyer.

**Round-1 open question — resolved.** The original draft proposed
a 20-byte ASCII tag (`"tacit-preauth-bid-v1"`) prepended to a
19-byte truncated hash inside a 40-byte OP_RETURN data push.
Survey of the four existing on-chain OP_RETURN forms (§5.7.6
recovery, §5.7.6.1 dual-party recovery, §5.16 T_SWAP_BATCH
envelope commit, §5.19 T_WRAPPER_ATTEST envelope commit) showed
that **none** carry an ASCII tag in their on-chain bytes —
recovery payloads are opaque ciphertext, envelope commits are raw
32-byte SHA256 hashes. The amendment now follows the
envelope-commit convention: `OP_RETURN(32)` carrying the full
`bid_context_hash`, with domain-tagging inside the SHA256 input
(`tacit-preauth-bid-context-v1`) per tacit's existing HMAC and
hash-derivation pattern. Saves 8 bytes per settlement, doubles the
binding security (256-bit vs 152-bit), removes the dispatch
complexity, and stays consistent with the rest of the protocol.
See the *Why no on-chain ASCII tag* subsection above for the full
comparison table.
