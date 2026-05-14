# SPEC §5.7.7 — Variable-Amount Bid Intents

> Extends §5.7.7 bids so a single signed buy offer is partial-fillable
> by multiple sellers. The on-chain settlement opcode is unchanged
> from §5.7.9 — every partial fulfilment is a standard `T_AXFER_VAR`
> (`0x37`) reveal. Only the off-chain coordination layer (the bid
> record + the fulfilment matching rules) gains the partial-fill
> shape, mirroring §5.7.6.1 on the ask side.
>
> **Framing.** Tacit launched this week; the SPEC is the canonical
> form, not a versioned migration path. The whole-bid behavior
> stays available as the natural case `min_fill_amount == amount`
> (or `min_fill_amount` omitted); the variable case is what this
> amendment specifies.

---

## Motivation

§5.7.6.1 made the ask side continuous: one seller listing can be
partial-filled by many takers, each picking how much to take.
Bids stay whole-or-nothing today — a buyer's bid for `X` TAC is
matched by exactly one seller delivering all `X`, or no one.

That asymmetry strands liquidity. A buyer with 100,000 sats at
100 sats/TAC can post a bid for 1000 TAC, but the three sellers
holding 333 TAC each can't split the fill — they each need to
either skip the bid or post their own listing, fragmenting depth.

This amendment closes the asymmetry. One signed bid; multiple
sellers each contribute a chunk; each fill settles atomically on
Bitcoin via `T_AXFER_VAR` (existing opcode). Net result: any
buyer's order is fillable by any combination of sellers, single-
block or over time, without re-signing.

Combined with §5.7.6.1 this completes the orderbook UX — any
party can partially match any other party's open order — without
needing an AMM as the matching engine. The two amendments together
are the pure-form Bitcoin orderbook DEX.

---

## §5.7.7 bid record

```
bid {
  bid_id            16 bytes
  asset_id          32 bytes
  buyer_pubkey      33 bytes (compressed)
  buyer_address     bech32 (sats payment receiver if the bid settled)
  amount            u64 — total amount of asset the bid covers (max fill)
  price_sats        u64 — total sats price for the full `amount`
                          (scales linearly per partial fill: a fill of
                          `x` units pays `floor(x × price_sats / amount)`)
  min_fill_amount   u64 — OPTIONAL.
                          Absence  ⇒ whole-bid fill only.
                          Presence ⇒ any `fill_amount ∈ [min_fill_amount,
                                       remaining_amount]` is acceptable.
  expiry            u64 — unix-seconds. Worker closes the bid after this.
  bid_sig           64 bytes — BIP-340 over bid_msg
  // Worker-maintained, not signed by buyer:
  remaining_amount  u64 — starts at `amount`; decremented as fills settle.
                          Bid closes when remaining < min_fill OR on expiry.
}
```

The buyer signs the bid once for the full `amount` + `price_sats`.
Partial fulfilments do not require additional buyer signatures —
the proportional scaling is computed deterministically.

Validation at publish:

1. If `min_fill_amount` is absent ⇒ whole-bid behavior. Same as the
   §5.7.7 path that's been in production: one seller fulfils the
   entire `amount` or no settlement happens.
2. If `min_fill_amount` is present:
   - `1 ≤ min_fill_amount ≤ amount`.
   - `min_fill_amount < amount` (the degenerate case
     `min_fill_amount == amount` is equivalent to a whole-bid; the
     dapp should hide the variable toggle or treat the bid as whole).
3. The reference dApp warns when the smallest scaled payment
   `floor(price_sats × min_fill_amount / amount) < DUST` — that
   smallest fill would yield sub-dust BTC and never settle.

### Bid claim message

When a seller fulfils (partially or wholly), they sign a claim
binding the bid_id + their chosen fill_amount:

```
bid_claim_msg = SHA256("tacit-bid-claim"
                     || asset_id || bid_id || seller_pubkey
                     || axintent_id(32)
                     || fill_amount_LE(8))
```

For whole-bid fulfilment, `fill_amount` equals the bid's full
`amount`. For partial fulfilment, `fill_amount` is in
`[min_fill_amount, remaining_amount]`. The `fill_amount` is bound
into every claim signature so a worker or relay cannot silently
substitute a different chunk.

A bid without `min_fill_amount` is fulfilled with `fill_amount =
amount` exactly; sellers signing a smaller value are rejected by
the worker.

### Fulfilment flow

The seller creates an **atomic-intent linked to the bid** as the
on-chain settlement vehicle. The shape mirrors §5.7.6.1:

1. Seller picks `fill_amount` within the bid's bounds.
2. Seller's atomic-intent is a `T_AXFER_VAR` (opcode 0x37) intent
   with:
   - `amount` = `fill_amount` (the chunk the seller is selling).
   - `min_take_amount` = `fill_amount` (single-shot: this
     atomic-intent isn't itself further partial-fillable on the
     taker side, since the bid already drove the chunking).
   - `asset_utxo` = a seller-owned tacit UTXO of value `fill_amount`
     (auto-split from a larger UTXO if needed, same as legacy).
   - `price_sats` = `floor(fill_amount × bid.price_sats / bid.amount)`.
   - `maker_address` = the seller's BTC payment receiver.
3. Seller POSTs the atomic-intent with `bid_id` set, signing
   `bid_claim_msg` to attest the link.
4. Worker:
   - Verifies seller's `bid_claim_msg` signature.
   - Atomic-CAS decrements `bid.remaining_amount` by `fill_amount`
     under the bid_id KV key. If decrement would underflow (race
     loss to another seller), rejects with `bid remaining
     insufficient` — seller retries with a smaller chunk or skips.
   - Records the atomic-intent under
     `bid_intent_axintents:{bid_id}` for traversal.
5. Buyer (or the buyer's auto-fulfil daemon) sees the atomic-intent
   linked to their bid, claims it, takes it. Settlement is one
   Bitcoin tx per chunk. Multiple chunks can settle in the same
   block.

Buyer-side claim of a bid-linked atomic-intent uses the existing
§5.7.6.1 take flow (`claimAxferVarIntent` then `finalizeAxferVarTake`).
The atomic-intent's `min_take_amount == amount` collapses the
variable-amount take to whole-UTXO from the buyer's perspective —
they claim the whole chunk the seller offered.

### Worker state machine

```
OPEN (remaining = amount)
  ↓ seller POSTs linked atomic-intent with fill_amount
PARTIALLY_RESERVED (remaining decremented by fill_amount)
  ↓ buyer claims, seller fulfils, settles on chain
PARTIALLY_SETTLED (linked atomic-intent reaches REVEAL_BROADCAST)
  ↓ if remaining ≥ min_fill, bid stays OPEN for more sellers; else CLOSED
CLOSED (remaining < min_fill_amount OR expiry passed OR buyer cancelled)
```

Concurrency: at any moment, the sum of `fill_amount` across
in-flight linked atomic-intents (NOT YET settled) PLUS the
settled subtractions MUST NOT exceed the original `amount`. The
worker enforces this via the atomic CAS at step 4 above.

### Re-credit on abandonment

If a seller posts a linked atomic-intent but the buyer never
claims it (or claims but the seller doesn't fulfil within the
claim TTL), the atomic-intent expires. When the worker cron sees
an expired bid-linked atomic-intent that never settled:

- Re-credit `bid.remaining_amount += fill_amount` (provided
  `bid.expiry` hasn't passed and the bid isn't cancelled).
- Mark the abandoned atomic-intent CLOSED in its own state machine.

Without re-credit, an attacker could drain a bid's remaining by
posting fake atomic-intents and never settling. The cron sweep
makes the bid self-heal.

### Wallet-availability check

The buyer's sats aren't escrowed at bid-publish time — they live
in the wallet, and must be available when the seller's atomic-
intent gets claimed + taken. This is exactly the same property as
0x v4 / CoW Swap pre-signed orders: the order is binding for the
maker / taker, but the underlying funds are wallet-held, not
vault-held.

For a variable-fill bid, the buyer's wallet must hold ≥
`payment_sats = floor(fill_amount × price_sats / amount)` for
each partial fulfilment at the time of take. The reference dApp's
swap tile validates wallet balance at the take moment, not at
bid-publish; a bid with multiple in-flight partial claims requires
the buyer to keep cumulative-payments-worth of sats in their
wallet.

### Cancel flow

Buyer's `bid_cancel_msg` is unchanged. Cancelling closes the bid
record at the worker; any in-flight linked atomic-intents not yet
settled become stranded (the seller can spend their asset UTXO
back to themselves to invalidate, matching §5.7.6 *Recovery*).

---

## Comparison with §5.7.6.1

| Property                       | §5.7.6.1 (variable seller listing) | §5.7.7 variable-fill bid               |
|--------------------------------|------------------------------------|----------------------------------------|
| Initiator                      | Seller                             | Buyer                                  |
| Variable side                  | Take amount (one taker picks)      | Fill amount (each seller picks)        |
| Settlement opcode              | T_AXFER_VAR (0x37)                 | T_AXFER_VAR (0x37) — same opcode       |
| Concurrent counterparties      | Many takers vs one listing         | Many sellers vs one bid                |
| Coordination record            | One intent per listing             | One atomic-intent per partial fulfil   |
| Re-credit on abandonment       | N/A (intent is one-shot per take)  | Yes — remaining restored on expiry    |
| Order persistence              | One intent until taker takes whole | One bid until remaining < min_fill    |

The two amendments are complementary: combined, they enable a
fully two-sided continuous orderbook where any partial match
happens in one Bitcoin settlement, atomically, with no AMM pool.

---

## Backwards-compatibility statement

- Bids without `min_fill_amount` validate identically to the
  §5.7.7 path that's in production. Same bid_msg, same cancel_msg,
  same atomic-intent whole-fill settlement.
- Variable-fill bids are opt-in per bid (the buyer's publishing
  client decides whether to set `min_fill_amount`).
- Indexers / clients that don't know `min_fill_amount` see it as
  an unknown field and ignore it; they'll treat the bid as
  whole-fill, which is safe — only the bid record's
  `remaining_amount` field would surprise them, and it's never
  used by a whole-fill consumer.
- Live TAC, every existing bid, every existing settlement, and
  the §5.7.6.1 variable-amount intents are all unchanged.

---

## Domain tag additions

Add to §3 *BIP-340 Schnorr signature-message tags*:

- `tacit-bid-claim` — bid-fulfilment claim message. Replaces the
  existing whole-bid claim in §5.7.7 by absorbing the
  `fill_amount` field; whole-bid usage sets `fill_amount = amount`.

The publish + cancel domains (`tacit-bid-intent`,
`tacit-bid-cancel`) are unchanged.

---

## Implementation plan

Following the §5.7.6.1 rollout pattern:

1. **Worker PR1** — pure-function message helpers
   (`bidClaimMsg`, validation), no handler changes. ~50 lines + tests.
2. **Worker PR2** — bid record schema additions
   (`min_fill_amount`, `remaining_amount`, linked atomic-intent
   index) + dispatch in bid POST + atomic-intent POST
   (when `bid_id` is set + bid has min_fill_amount, validate
   `fill_amount` + atomic-CAS remaining). ~250 lines + tests.
3. **Worker PR3** — re-credit cron pass (abandoned linked
   atomic-intents restore remaining), bid state machine
   transitions, expiry-driven close. ~100 lines + tests.
4. **Dapp builder**:
   - `publishBidIntent` extended with optional `minFillAmount`.
   - `fulfilBidIntentVar` — seller picks chunk and posts a linked
     variable-amount atomic-intent.
   - Auto-fulfil daemon dispatch on bid's `min_fill_amount`.
5. **Dapp UI**:
   - Swap tile: residual-bid posts a variable-fill bid by default
     (so a normie's swap order can be partial-matched by multiple
     sellers without the buyer thinking about it).
   - Maker-side fulfilment UI: when a maker holding TAC wants to
     fulfil a bid, they pick `fill_amount` from a slider in
     [min_fill, remaining].
6. **Signet e2e harness** — drives publish-variable-bid → three
   concurrent partial fulfilments → all settle in adjacent blocks
   → bid auto-closes.

Live TAC + every legacy whole-bid + every variable-amount ask
unaffected throughout the rollout. The variable-fill default in
the swap tile is one line we can flip once the harness proves out.
