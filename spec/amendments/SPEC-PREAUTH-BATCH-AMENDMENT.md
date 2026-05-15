# SPEC §5.7.8 — Batched Preauth-Take

> Extends §5.7.8 preauth-take so a single buyer can settle N preauth
> sales by N distinct sellers in **one** Bitcoin (commit, reveal)
> pair instead of N independent pairs. The on-chain settlement
> opcode is unchanged — every batched take is a standard `T_AXFER`
> (`0x26`) reveal with `asset_input_count = N` (already permitted
> by the wire format). No new opcode, no listing-schema migration,
> no seller re-signing.
>
> **Framing.** This amendment formalizes a property of the existing
> protocol that was non-obvious enough to warrant explicit
> documentation: BIP-143 `SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`
> preimages are position-independent for matching payout content.
> Future implementers reading §5.7.8 may otherwise re-derive (or
> miss) the batching opportunity.

---

## Motivation

§5.7.8 establishes preauth sales: the seller pre-signs their asset
UTXO once at listing time using `SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`
(`0x83`), and any buyer can later complete settlement without a live
seller — atomic Bitcoin tx, no escrow, no live counterparty.

In practice, buyers routing across multiple preauth listings in a
single swap (e.g. a $10 buy that sweeps the five cheapest dust asks)
pay the full per-fill `(commit, reveal)` cost N times. For a
five-fill route at minfee that's ~4,750 vBytes of on-chain weight —
the envelope, taproot script-path overhead, and recipient outputs
all duplicated per fill.

This amendment formalizes a single observation: those five fills
share **the same buyer**, and the buyer controls the entire reveal
tx. The envelope, range proof, kernel signature, and recipient
output can be amortized into one reveal that consumes all N seller
UTXOs. Each seller's existing pre-signature carries through unchanged.

Empirical savings (N=5, minfee):

| Component | Per-fill loop | Batched | Δ |
|---|---|---|---|
| Commit txs | 5 × ~150 vB | 1 × ~150 vB | -600 vB |
| Reveal txs | 5 × ~800 vB | 1 × ~1,400 vB | -2,600 vB |
| **Total** | **~4,750 vB** | **~1,550 vB** | **~67% off** |

The savings scale with `N`: N=10 routes drop ~80%.

---

## The load-bearing invariant: position-independent `SIGHASH_SINGLE_ACP`

§5.7.8 specifies the seller's pre-signature uses
`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY` (`0x83`). The BIP-143 preimage
for this flag set has the following structure (with `ZERO32` =
`0x00…00` × 32):

```
nVersion         (4 bytes)
hashPrevouts     = ZERO32             ← ANYONECANPAY: skip other inputs
hashSequence     = ZERO32             ← ANYONECANPAY: skip other sequences
outpoint         = seller's asset UTXO outpoint (36 bytes)
scriptCode       = P2WPKH(seller_pubkey) (25 bytes)
amount           = seller's asset UTXO value (8 bytes)
nSequence        = 0xfffffffd (4 bytes)
hashOutputs      = HASH256(serialize(tx.outputs[input_index]))
                                       ← SIGHASH_SINGLE: only same-idx output
nLockTime        (4 bytes)
sighashType      = 0x83 (4 bytes)
```

**Key property:** the only `input_index`-dependent term is
`hashOutputs`. Every other field is a constant of the seller's UTXO
+ listing terms. If the buyer places the seller's payout (`value =
min_price_sats`, `script = seller_payout_script`) at `vout[k]`, then
`hashOutputs` evaluates to `HASH256(serialize(seller_payout_output))`
*regardless* of `k`. The preimage is bit-identical; the signature
validates at any `vin` position.

**Consequence:** A seller's single-slot pre-signature (signed
assuming `vin[1]` and `vout[1]`) validates as `vin[k].witness` for
any `k ∈ {1, 2, …}` as long as:

1. `tx.inputs[k].outpoint` is the seller's asset UTXO, and
2. `tx.inputs[k].sequence == 0xfffffffd`, and
3. `tx.outputs[k] == { value: min_price_sats, script: seller_payout_script }`.

The buyer can therefore batch N preauth takes with no protocol
change. Listings published before this amendment is implemented
remain compatible — they pre-signed for "slot 1," but the same
bytes validate at any slot. There is no migration step.

---

## Batched reveal layout (N sellers)

```
vin[0]      buyer's commit P2TR              — script-path with envelope
vin[1..N]   seller_i asset UTXOs             — each carries its pre-signed
                                               SIGHASH_SINGLE_ACP witness
                                               at this position
vin[N+1..]  buyer P2WPKH funding             — SIGHASH_ALL, buyer-signed

vout[0]     DUST P2WPKH buyer recipient      — combined receipt
                                               (Σ amounts, Σ blindings → r_out)
vout[1..N]  seller_i payouts                 — each locked by SIGHASH_SINGLE_ACP
                                               on vin[1+i]; vout[1+i].value
                                               MUST equal seller_i.min_price_sats
                                               and vout[1+i].script MUST equal
                                               seller_i.seller_payout_script
vout[N+1]   buyer change (P2WPKH)            — OPTIONAL, present if ≥ DUST
```

Each seller's payout sits at the vout index matching their vin slot
(seller_i at vin[1+i] → payout at vout[1+i]), per the
position-independence invariant above. The buyer's recipient output
is at vout[0] — out of the seller-locked range, so the buyer chooses
its script + value freely (DUST P2WPKH, per §5.7.8 single-take).

---

## AXFER envelope payload (N=N inputs, N=1 outputs)

The reveal envelope is a standard `T_AXFER` (`0x26`) with:

```
opcode             = T_AXFER (1 byte)
asset_id           = 32 bytes (same as each seller's listed asset)
asset_input_count  = N        (∈ [2, 255] for batched; N=1 is single-take)
kernel_sig         = 64 bytes (BIP-340 over kernel_msg, signed with `excess`)
N_outputs          = 1        (∈ {1, 2, 4, 8} per §5.4; batched uses 1)
output[0]:
  commitment       = 33 bytes — Pedersen commitment for the combined
                                 recipient amount (Σ amounts)
  encryptedAmount  = 8 bytes  — Σ amounts encrypted under
                                 deriveAmountKeystreamECDH(buyer.priv,
                                   seller_0.pub, seller_0.anchor, 0)
rp_len             = 2 bytes (LE)
rangeproof         = aggregated single-output bulletproof for Σ amounts
```

### Pedersen conservation (kernel signature)

Let:

```
amount_i      = seller_i's asset_opening.amount  (BigInt)
blinding_i    = seller_i's asset_opening.blinding (scalar)
total_amount  = Σ_i amount_i  mod 2⁶⁴
total_blinding_sum = Σ_i blinding_i  mod n     (curve order)
r_out         = deriveBlinding(buyer.priv, seller_0.pub, seller_0.anchor, 0)
excess        = (r_out - total_blinding_sum)   mod n
```

The kernel sig binds:

```
Σ_i pedersen(amount_i, blinding_i) - pedersen(total_amount, r_out) = excess·G
```

Computed via the existing `computeKernelMsg` helper with:

- `asset_id` = the (single) asset_id all N sellers list,
- `input_outpoints` = `[seller_0.outpoint, …, seller_{N-1}.outpoint]` (in vin[1..N] order),
- `output_commitments` = `[pedersen(total_amount, r_out)]`.

The single aggregated bulletproof proves `total_amount ∈ [0, 2⁶⁴)`.
Proof size is unchanged from single-take (~688 bytes for m=1) since
we aggregate INPUTS, not OUTPUTS.

### Recipient ECDH anchor — first-seller convention

The wallet-recovery scanner (`scanHoldings`) anchors ECDH on
`firstIn = tx.vin[1]`. The batched reveal MUST place `seller_0`
(the first seller in the envelope's `input_outpoints` list) at
`vin[1]` so the receiving wallet's existing recovery loop finds
the keystream + blinding without a scanner schema change.

Specifically: `r_out` and the encrypted-amount keystream are
derived from `(buyer.priv, seller_0.pubkey, seller_0.outpoint, vout=0)`,
matching the single-take derivation at the buyer-anchor seller. The
remaining N-1 sellers do not need to be derivable to keystream — the
combined receipt's amount + blinding live entirely under seller_0's
ECDH partner.

---

## Worker-side accounting: aggregated volume hint

The §5.7.8 single-take flow POSTs a `/assets/hint` after the reveal
broadcasts, carrying `(reveal_txid, price_sats, amount)` for the
worker's daily-volume bucket + recent-trades ring buffer.

For batched takes, the worker dedupes by `(asset_id, reveal_txid)`
via `bumpTransferCount`. Only the **first** hint POST per
`reveal_txid` lands in the volume bucket — subsequent hints with the
same `reveal_txid` are no-ops. A naive emission of N per-fill hints
(each carrying ONE fill's `price_sats`) would record only the first
fill's price as the trade value and undercount 24h volume by
`~(N-1)/N`.

**Rule:** A batched reveal MUST emit EXACTLY ONE hint per asset,
with:

- `price_sats = Σ_i min_price_sats_i` (sum of all sellers' listed prices)
- `amount    = String(Σ_i amount_i)` (sum of all asset amounts)
- `listing_kind = "instant-batch"` (distinguishable from single-take's
  `"instant"`; downstream consumers may use this to render batched
  trades distinctly)

Per-fill activity records (the user's local swap-history rows) are
emitted as N entries — that's a local UI concern, not a chain
accounting one. Users still see N rows for an N-fill route.

---

## Failure semantics

### Pre-broadcast (atomic abort)

The buyer's pre-flight check (`getOutspend` for each of the N asset
outpoints, parallel) runs before the commit broadcasts. If ANY of
the N outpoints is already spent (race with another taker, seller
cancel), the buyer aborts the batch and pays zero on-chain fees.

This is more conservative than the single-take loop's behavior:
single-take loop breaks at the first failed fill and leaves the
preceding fills settled. The batch is all-or-nothing on the
pre-flight path.

### Post-commit (recovery)

If the commit tx broadcasts successfully but the reveal fails
(insufficient funding for reveal, indexer issue, etc.), the buyer's
commit-locked sats are recoverable via script-path-spend of the
commit P2TR using the persisted envelope script + control block.
The recovery record schema for a batched commit extends the
single-take record with a `batch[]` array carrying each seller's
`{ sale_id, seller_pubkey, asset_outpoint, amount, blinding,
min_price_sats, seller_payout_script }`. Storage key is shared
with single-take (`tacit-preauth-take-pending-v1:<network>`); the
record type is inferred from the presence of the `batch[]` field.

---

## Backwards-compatibility statement

This amendment introduces **no breaking changes**:

1. **Listing schema unchanged.** Existing preauth listings published
   before this amendment is implemented carry exactly one
   `seller_asset_spend_sig`. That signature is valid at any vin slot
   per the position-independence invariant above, so it can
   participate in a batched reveal as-is.

2. **Worker decoder unchanged.** `decodeAxferPayload` accepts
   `asset_input_count ∈ [1, 255]` already (§5.4 + the
   `worker-decoder.test.mjs` regression suite). The cron's T_AXFER
   recipient-discovery loop maps `output_i → vout[i]` — for the
   batched layout's `outputs.length == 1`, this targets vout[0]
   (the buyer's recipient) and ignores the N seller payouts at
   vout[1..N], which are plain P2WPKH outputs invisible to the tacit
   indexer.

3. **Wallet recovery unchanged.** `scanHoldings`'s ECDH anchor on
   `tx.vin[1]` continues to work because the batched layout places
   seller_0 there by construction.

4. **Single-take path untouched.** The N=1 case of the batched
   entrypoint MUST delegate to the single-take function (no
   behavior change). The single-take function itself is unchanged.

5. **Mixed routes fall back.** Buyer routes that mix preauth fills
   with §5.7.6 atomic intent fills (which have a separate
   claim → wait → finalize protocol) MUST use the per-fill loop —
   the batched reveal can only consume preauth-kind asks.

---

## Implementation status

Shipped to `tacit.finance` mainnet at:

- `dc7a48e` — buyer-side `takePreauthSaleBatch` + swap-tile wireup
- `79763f5` — aggregated-hint volume-bucket fix
- Reference: `dapp/tacit.js` `takePreauthSaleBatch`,
  `tests/preauth-take.test.mjs` 34/34 (16 single-take + 18 batched)

No worker redeploy required (verified at `8378db5`).

---

## Sell-side parallel

A symmetric construction exists on the sell side for bid fulfilment
sweeps:

- **Phase 1 (shipped at `1400214`):** batched CXFER auto-split — one
  multi-recipient `T_CXFER` (`0x21`) produces N matching child UTXOs
  in a single tx, replacing N independent splits. Uses the existing
  `outputs ∈ {1, 2, 4, 8}` multi-output format.
- **Phase 2 (deferred):** batched atomic-intent commits — one
  Bitcoin tx with N P2TR outputs, each carrying an independent
  envelope targeting a different bidder. Each bidder's reveal stays
  independent (each owns their own settlement tx). Requires a
  worker storage tweak to permit N atomic intents at the same
  commit_txid with distinct vouts.

Both halves are pure flow-level wins over existing opcodes;
neither introduces protocol-level changes.
