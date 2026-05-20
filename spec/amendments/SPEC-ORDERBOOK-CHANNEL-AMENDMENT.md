# SPEC Amendment — Orderbook Preconfirmation Channel (orderbook scope schemas for `T_INTENT_ATTEST`)

> Status: 📝 Draft (round-1)
> Depends on: `SPEC-VARIABLE-AMOUNT-AMENDMENT.md` (`T_AXFER_VAR`
> `0x37`) and `SPEC-BID-VARIABLE-AMOUNT-AMENDMENT.md` (variable-fill
> bid intents §5.7.7) — the orderbook DEX layer this channel
> attests to. Both dependencies are already shipped to dapp + worker
> and signet-validated.
>
> Defines **scope schemas + usage conventions** for applying the
> protocol's scope-generic preconfirmation primitive `T_INTENT_ATTEST`
> (`0x30`, SPEC.md §5.17) to orderbook intents. **No new opcode**,
> **no new domain tag**, **no new cryptographic primitive** — this
> amendment is a thin layer on top of the existing
> `T_INTENT_ATTEST` envelope.

---

## Motivation

The protocol ships a single scope-generic preconfirmation opcode
(`T_INTENT_ATTEST`, `0x30`) — see SPEC.md §5.17 for the normative
spec and AMM.md §"Preconfirmation layer" for the architectural
rationale. The opcode commits a worker's signed hash of its open
intent set at a given height; the indexer detects per-worker
equivocation; traders verify their intent is included via SHA-256
over the worker's published sorted intent-id list.

The opcode is **scope-generic**: the `scope_id` field carries a
32-byte canonical identifier of the attested intent set, treated as
opaque by the indexer. The same opcode serves AMM intents (scope =
pool_id) and orderbook intents (this amendment) and any future
intent surface.

The orderbook DEX (variable-amount T_AXFER + variable-fill bids) is
already in production: traders post bids and asks to the worker's
intent-pool relay; takers fill via `T_AXFER_VAR` (`0x37`) atomic
settlements. Today the relay's "your intent is in the pool" status
is just the worker's word. A trader has no cryptographic
accountability mechanism against a worker that silently drops
intents, equivocates between clients, or backdates inclusion
timestamps. The worker can't steal (the orderbook is non-custodial
by construction) but it CAN censor or mislead about what intents
are in flight.

This amendment closes that gap by **defining canonical orderbook
scope schemas for `T_INTENT_ATTEST`**. The worker periodically
broadcasts a `T_INTENT_ATTEST` envelope on chain with `scope_id`
set per one of the schemas below; traders verify inclusion via the
standard verification flow in SPEC.md §5.17. Soft-confirm status
for orderbook intents becomes cryptographically accountable within
~30 s of intent post.

The construction works **today, independent of the AMM ceremony**:
`T_INTENT_ATTEST` has no Groth16, no Pedersen, no sigma proof —
just a SHA-256 hash + BIP-340 signature. No trusted setup required.
The worker + indexer dispatch can ship as soon as the validator
branch is implemented; nothing in the AMM critical path blocks it.

---

## §5.7.10 Orderbook scope schemas for `T_INTENT_ATTEST`

(SPEC.md section number tentative; lands as §5.7.10 after the
existing §5.7.7 variable-fill bids and §5.7.9 T_AXFER_VAR blocks.)

### Scope schemas (normative)

A worker attesting to orderbook intents MUST use one of the
following canonical `scope_id` derivations:

**Per asset-pair scope:**

```
scope_id = SHA256("tacit-orderbook-pair-v1" || asset_id_min || asset_id_max)
```

where `asset_id_min < asset_id_max` byte-lex ascending. Each
attestation covers all open orderbook intents (both bid-side per
§5.7.7 and ask-side per §5.7.6.1) for that specific asset pair.
Workers serving many pairs broadcast one attestation per pair per
epoch.

**Per-worker global scope:**

```
scope_id = SHA256("tacit-orderbook-global-v1" || worker_pubkey)
```

Each attestation covers all open orderbook intents the worker is
tracking across all asset pairs. One attestation per worker per
epoch covers the entire orderbook surface.

The two schemas are complementary; a worker MAY use one, both, or
neither (and traders MAY watch attestations from multiple workers
to compose their own trust model). The indexer treats each scope_id
independently — equivocation is per `(scope_id, worker_pubkey,
observed_height)`.

### Intent-id derivation for orderbook intents

The 32-byte `intent_id` for each orderbook intent is the
SHA-256 of the canonical intent message:

- **Variable-fill ask intent** (§5.7.6.1): `intent_id =
  SHA256("tacit-axintent-id-v1" || canonical_intent_record)` per
  the variable-amount amendment's intent_id derivation.
- **Variable-fill bid intent** (§5.7.7): `intent_id =
  SHA256("tacit-bid-intent-id-v1" || canonical_bid_record)` per
  the variable-fill bid amendment's bid_id derivation.

The worker's open intent set for a given scope is the union of all
non-expired, non-fully-filled intents whose scope matches (asset
pair for per-pair schema, all of the worker's intents for global
schema). The sorted list `sorted_intent_ids[] =
sort_lex_ascending(intent_id for each open intent)` is fed to
SPEC.md §5.17's `intent_pool_hash` construction.

### Trader-side verification (per SPEC.md §5.17 step 5)

A trader who posted an orderbook intent fetches the worker's
published `sorted_intent_ids[]` for the scope, verifies the
on-chain `T_INTENT_ATTEST.intent_pool_hash` matches
`SHA256(sorted_intent_ids[0] || … || sorted_intent_ids[N-1])`,
verifies their own `intent_id` is in the sorted list (binary
search), and checks `worker_sig`. All pass ⇒ `soft_confirmed`.

The verification flow is **byte-identical to AMM intent
verification** at SPEC.md §5.17; only the scope-id schema differs.
Dapp implementations can share most code between the two surfaces.

### Worker behaviour (informative)

A worker offering orderbook preconfirmation:

1. Accepts orderbook intents (bids and asks) via the existing
   `tacit-axintent-publish-v1` / `tacit-bid-{intent,claim,cancel}-v1`
   RPC endpoints (see §5.7.6.1 and §5.7.7 for the on-chain
   primitives, §8 for the off-chain worker endpoints).
2. Maintains the open intent set per scope. Expires intents past
   their declared `expiry_height` and removes them on full
   fulfilment.
3. Publishes the sorted intent-id list per scope over RPC at
   `snapshot_uri` (worker's choice of URL).
4. Periodically broadcasts a `T_INTENT_ATTEST` envelope per scope.
   Default cadence: one attestation per Bitcoin block per
   non-empty scope. Workers MAY attest more or less frequently
   based on operational priorities (high-throughput pairs warrant
   per-block attestation; quiet pairs may be batched every several
   blocks).

### Unilateral exit (informative — channel-style property)

Like the AMM channel, orderbook channel has an unconditional
unilateral-exit mechanism: a taker observing an open maker UTXO on
chain (via the maker's declared `asset_input_outpoint` in the bid
or ask record) can complete the fill via `T_AXFER_VAR` directly,
bypassing the worker entirely. The worker is needed only for
intent-pool discovery, not for settlement. This is even cleaner
than the AMM's exit story because:

- Every orderbook maker intent already references a specific
  on-chain UTXO (the maker's listed UTXO outpoint).
- Any taker can scan the chain for these UTXOs without worker
  cooperation.
- The taker's `T_AXFER_VAR` fill is atomic and self-contained;
  no further worker interaction needed.

The channel framing therefore applies orderbook-side with
particularly strong unilateral-exit guarantees.

### Composing AMM channel + orderbook channel

A worker can operate both channels simultaneously: one
`T_INTENT_ATTEST` stream per AMM pool (scope = pool_id), one per
orderbook scope. A trader interacting with both surfaces verifies
each independently. There is no on-chain interaction between scope
types — they share only the worker_pubkey identity if the trader
chooses the same worker for both. The indexer dispatches every
`T_INTENT_ATTEST` envelope identically regardless of scope_id
contents.

A trader's swap-tile UX (dapp's fill-then-bid routing) typically
spans orderbook + AMM surfaces in one logical action: orderbook
asks first, AMM fallback for residual, variable-fill bid for any
remainder. Such a trader posts intents to BOTH surfaces and
benefits from the unified `T_INTENT_ATTEST` scheme — one worker's
attestation stream covers all their open intents (multiple
scope_ids, same worker_pubkey).

---

## Backwards-compatibility statement

This amendment is **purely additive at the protocol layer**. It
defines scope-schema conventions for an opcode (`T_INTENT_ATTEST`
`0x30`) that already exists in SPEC.md §5.17. No new opcode, no
new domain tag, no new wire-format byte, no new cryptographic
primitive.

Indexers that already support `T_INTENT_ATTEST` accept orderbook
attestations transparently — the scope_id is opaque, only used as
the equivocation-detection key. Indexers that don't yet support
`T_INTENT_ATTEST` treat any such envelope as unknown opcode and
ignore it (failing the channel-layer attestation index, but not
corrupting orderbook state — orderbook fills via `T_AXFER_VAR` are
unchanged and never reference attestations).

This amendment does NOT modify:
- `T_AXFER_VAR`'s wire format or validator (§5.7.9 unchanged)
- The variable-fill bid intent record (§5.7.7 unchanged)
- The §5.7.6.1 atomic-intent coordination layer
- `T_INTENT_ATTEST`'s wire format or validator (§5.17 unchanged)

It DOES require:
- Worker support for tracking open orderbook intents per scope
  and signing periodic `T_INTENT_ATTEST` envelopes with orderbook
  scope_ids.
- Dapp UX surfacing soft-confirm status with the standard
  `soft_confirmed` / `stale` / `forged` / `equivocator` /
  `untrusted_worker` / `intent_missing` status discrimination
  (same UX as AMM channel; the dapp can ship one shared UI
  component for both).

---

## Test plan (informative — non-normative)

End-to-end signet rehearsal:

1. Worker accepts an open orderbook intent (bid or ask), records
   it in its per-scope intent pool.
2. Worker publishes `sorted_intent_ids[]` over RPC at the
   advertised `snapshot_uri`.
3. Worker broadcasts a `T_INTENT_ATTEST` envelope with a canonical
   orderbook scope_id and the corresponding `intent_pool_hash`.
4. Indexer accepts the envelope, indexes it by `(scope_id,
   worker_pubkey, observed_height)`.
5. Trader fetches `sorted_intent_ids[]`, verifies hash, checks
   their `intent_id` is present, accepts soft-confirm status.

Equivocation:

6. Worker broadcasts two `T_INTENT_ATTEST` envelopes at the same
   `(scope_id, observed_height)` with different
   `intent_pool_hash`. Indexer flags the worker; second envelope
   rejected.

Multi-scope from one worker:

7. One worker attests to two different orderbook scopes (pair-A
   and pair-B) at the same height. Indexer indexes them
   independently; no cross-scope equivocation check.

Mixed AMM + orderbook from one worker:

8. One worker attests to one AMM pool (scope = pool_id) and one
   orderbook scope at the same height. Both envelopes accepted;
   independent state in the indexer.

Multi-worker:

9. Two workers attest to the same scope at the same height with
   different hashes (each tracking a different intent subset).
   Indexer accepts both — no equivocation across `worker_pubkey`.

Cross-impl parity:

10. Dapp builds a `T_INTENT_ATTEST` envelope with an orderbook
    scope_id; worker validates.
11. Worker builds an envelope; dapp validates.
12. Byte-parity check for the canonical hash pre-image between
    dapp and worker for identical inputs.

Adversarial:

13. Replay: rebroadcast a confirmed attestation. Bitcoin rejects
    (duplicate tx); indexer never re-processes.
14. Wrong list: worker publishes a list at `snapshot_uri` whose
    hash doesn't match the chain's `intent_pool_hash`. Dapp marks
    `forged`.
15. Stale: trader receives a 1-hour-old attestation. Dapp marks
    `stale` (TTL 300 s default).

---

## What this amendment explicitly does NOT specify

Out of scope, left for future amendments or operational practice:

- **Attestation cadence.** Workers choose when to broadcast. Not
  normative.
- **Trusted-worker set discovery.** How traders find workers and
  decide which to trust is a dapp UX concern.
- **Vector-commitment upgrade.** For very-large-N scopes (>10K
  intents), the full-list rehash becomes the bottleneck. A future
  amendment can swap in KZG or FRI without changing the on-chain
  wire format.
- **Cross-scope attestation aggregation.** A worker covering many
  scopes could aggregate them into one envelope to save chain
  space. Future bandwidth optimisation if attestation traffic
  becomes load-bearing.
- **On-chain slashing.** This amendment defines the *attestation*
  semantics; the *consequence* of detected equivocation is
  specified in `SPEC-WORKER-BOND-AMENDMENT.md`. Together they
  give the orderbook channel a bonded-worker accountability
  layer: orderbook intents attested by a bonded worker carry
  automated slash risk for the worker on cryptographic
  equivocation evidence, payable to the slash submitter as a
  bounty and burning the remainder. See
  `spec/design/META-PROTOCOL-CONSENSUS.md` for the layered
  architecture overview.

---

## Open questions for round-2 review

1. **Default scope schema.** Per-pair gives per-market granularity
   at the cost of more envelopes per worker per epoch. Per-worker-
   global is one envelope per epoch covering everything. Should
   one of these be promoted to MUST status for V1, or stay
   SHOULD?

2. **Mixed-scope attestation aggregation.** A future amendment
   could let a single `T_INTENT_ATTEST` envelope commit to
   multiple scopes via a Merkle root or polynomial commitment. Not
   in V1 scope but worth tracking as a future bandwidth
   optimisation if multi-scope workers become common.

---

## Integration checklist for landing in `SPEC.md`

- [ ] §5.7.10 "Orderbook scope schemas for T_INTENT_ATTEST" added
      after the existing orderbook block (§5.7.7, §5.7.9).
- [ ] Worker implementation:
      - Per-scope intent-pool tracking with sorted-id index for
        efficient hash recomputation on update.
      - Periodic broadcast of `T_INTENT_ATTEST` envelopes per
        active orderbook scope.
      - Snapshot RPC endpoint exposing `sorted_intent_ids[]`.
- [ ] Dapp implementation:
      - Watcher for `T_INTENT_ATTEST` envelopes matching scopes
        the dapp cares about (typically the asset pairs the user
        has open intents in).
      - Soft-confirm status surface for each open orderbook intent
        (shared UI component with AMM channel).
- [ ] Cross-impl parity tests: 5 canonical envelopes shared
      between dapp and worker (canonical hash pre-image byte
      parity).
- [ ] Signet rehearsal: items (1)–(15) from the test plan, all
      green.

---

## Sign-off checklist

- [ ] Round-1 peer review
- [ ] Round-2 peer review
- [ ] Reference dapp implementation
- [ ] Reference worker / indexer implementation
- [ ] Signet e2e validation
- [ ] Cross-impl parity tests
- [ ] Merge into `SPEC.md` as §5.7.10 and mark `✅ Merged` in
      `AMENDMENTS.md`
