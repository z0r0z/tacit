# SPEC Amendment — `T_RANGE_ATTEST` (`0x44`) opcode

> Status: ✅ Reference impl shipped (`tests/range-attest.mjs`, 23 tests).
> SPEC.md §5.21 merge pending.
>
> Depends on: [`SPEC-RANGE-PROOF-PRIMITIVE.md`](./SPEC-RANGE-PROOF-PRIMITIVE.md)
> — defines the cryptographic primitive this opcode anchors on chain.
>
> Adds a standalone on-chain anchor for range-proof attestations: a
> holder publishes a signed envelope claiming that one or more existing
> UTXO commitments satisfy a public predicate (≥ X, ≤ X, ∈ [X, Y],
> > b, = X). The indexer validates and records the attestation, making
> it queryable by holder, by scope_id, or by commitment outpoint.
> Consumers (cUSD CDP authorizations, permissioned LP gates, tiered-fee
> discounts, sealed-bid auction commitments) reference attestations by
> their on-chain id.

---

## Relationship to the primitive

This opcode wraps `proveRange()` / `verifyRange()` from
`SPEC-RANGE-PROOF-PRIMITIVE.md` in a **publish-able envelope** with
holder identity, expiry, and scope binding. **The primitive remains
usable in its own right** for embedded use — when a consumer envelope
verifies a range-proof attestation as part of its own atomic operation
(e.g., a cUSD CDP draw embeds the attestation inline), the primitive
suffices without going through this opcode.

| Layer | Module | Use when |
|---|---|---|
| Cryptographic primitive | `tests/range-proof.mjs` | The attestation is verified atomically inside a consumer envelope (CDP draw, gated LP_ADD, single-shot proof) and doesn't need on-chain persistence. |
| On-chain opcode | `tests/range-attest.mjs` + `T_RANGE_ATTEST 0x44` | The attestation should be published as a standalone, persistent, cross-op-referenceable claim with expiry windowing and holder identity binding. |

The two layers are **complementary**: the primitive does the math; the
opcode publishes a signed wrapper of the math output on chain.

---

## Wire format (normative)

```
opcode(1)                  = 0x44
scope_id(32)               opaque scope discriminator — binds the
                            attestation to a use context (e.g., pool_id,
                            CDP claim_id, or SHA256(domain || context));
                            indexer treats as bytes only
asset_id(32)               asset_id the holder's commitments are
                            denominated in. ALL referenced UTXOs MUST
                            resolve to this asset_id at indexer time.
                            Defeats cross-asset replay where an attestation
                            about (e.g.) low-value-token X is reused as if
                            it were about high-value-token Y.
expiry_height_LE(4)        u32 — attestation expires after this height
commitment_count(1)        u8, 1..16 UTXO commitments being attested
commitment_outpoints(36 * count)  [txid_BE(32) || vout_LE(4)] each;
                            references the on-chain UTXOs whose Pedersen
                            commitments are the inputs to the proof
attestation_len_LE(2) + attestation_bytes(*)  output of `proveRange()` —
                            predicate type tag + params + bulletproof bytes
holder_pubkey(33)          compressed secp256k1 of the attester
holder_sig(64)             BIP-340 over SHA256("tacit-range-attest-v1"
                                                || all preceding fields)
```

Envelope size: 1 + 32 + 4 + 1 + 36·N + 2 + ~700 + 33 + 64 = ~837 + 36·N
bytes (single-UTXO attestation: ~873 B; 4-UTXO aggregate: ~981 B).

---

## Indexer dispatch

Extends SPEC.md §5 with the following branch:

```
if envelope.opcode == T_RANGE_ATTEST:
    1. Decode envelope. Reject on structural error.
    2. Verify holder_sig against the preceding bytes
       (SHA256("tacit-range-attest-v1" || preceding)).
    3. Reject if expiry_height < envelopeHeight.
    4. Resolve each commitment_outpoint to its on-chain Pedersen
       commitment from current UTXO state. Reject if any outpoint is
       not a confirmed UTXO at envelope_height − AMM_OP_CONFIRMATION_DEPTH.
    5. For multi-commitment attestations (count > 1), sum the resolved
       commitments to get the aggregate primary commitment.
    6. For PRED_GT_HIDDEN: the attestation_bytes embed C_b inline;
       extract and pass to verifyRange as `commitmentB`.
    7. Call verifyRange(primary_commitment, attestation_bytes, {commitmentB?}).
       Reject on verify failure.
    8. Record (attestation_id = SHA256(envelope_payload), holder_pubkey,
       scope_id, expiry_height, predicate, commitment_outpoints) in the
       indexer's attestation registry.
    accept envelope.
```

Indexer state additions:

```
attestations: Map<attestation_id_hex, {
    scope_id: bytes(32),
    holder_pubkey: bytes(33),
    expiry_height: u32,
    predicate: { type, X?, Y? },
    commitment_outpoints: [{ txid, vout }],
    observed_height: u32,
}>
```

Query interface (informative — dapps and consumer surfaces use these):

- `getAttestationById(id)` → attestation or null
- `getAttestationsByScope(scope_id)` → list of valid attestations
- `getAttestationsByHolder(pubkey)` → list of valid attestations
- `isAttestationValid(id, currentHeight)` → bool (checks expiry +
  whether referenced commitments are still UTXOs)

---

## Revocation and stalenesss

An attestation references specific `commitment_outpoints`. If any of
those outpoints is spent, the attestation becomes **stale** (its
referenced UTXOs no longer exist, so the predicate is no longer about
on-chain reality). Consumers SHOULD check:

```
isAttestationValid = currentHeight ≤ expiry_height
                  AND every commitment_outpoint is still a UTXO
                  AND attestation was originally accepted
```

before relying on an attestation. The indexer MAY mark stale
attestations automatically when UTXOs are spent; this is an indexer
optimization, not a consensus rule.

---

## Spam economics

Attestation envelopes pay Bitcoin tx fees like any other envelope.
Spam is bounded by tx-fee economics — no protocol-level rate limit.
For deployments that want stricter rate limiting (e.g., per-holder
caps on attestation count), it's a dapp/indexer policy not a
consensus rule.

---

## Use cases

| Surface | How it uses T_RANGE_ATTEST |
|---|---|
| cUSD CDP authorization | Holder publishes attestation "collateral commitments sum to ≥ debt·ratio". CDP draw op references attestation_id; CDP validator checks attestation is valid before authorizing draw. |
| Permissioned LP pool gate | Pool's POOL_INIT metadata declares "LP_ADD requires valid attestation against scope_id=pool_id with predicate ≥ K of asset X". Indexer rejects LP_ADD without matching attestation. |
| Tiered fee discount | Trader publishes "lifetime volume ≥ tier3_threshold". Settler matches attestation_id to trader_pubkey, applies tier-3 discount. |
| Sealed-bid auction | Bidder pre-publishes attestation "my bid is ≥ reserve_price" before reveal phase. Anyone can verify the bidder is in the auction without seeing the bid. |
| Anti-sybil holder gate | Surface requires recent attestation "I held ≥ K of asset for ≥ N blocks" before allowing some op. |
| Reputation / KYC tier | Holder publishes durable attestations for off-chain reputation systems (with on-chain auditability). |

Each consumer surface defines its own `scope_id` derivation rule so
attestations don't accidentally cross-apply.

---

## Security considerations

**Holder ownership**: the attestation's holder_sig proves the publisher
knows the (value, blinding) opening of the referenced commitments. It
does NOT prove the publisher CONTROLS those UTXOs (e.g., can spend
them). For consumer surfaces that require spend control (CDP
collateral, gated LP), the consumer's own envelope SHOULD include a
separate spend authorization (intent_sig, kernel_sig) against the
same commitments.

**Replay across scopes**: scope_id is signed into the envelope. An
attestation made for `scope_id_A` cannot be reused for `scope_id_B`
because the signature wouldn't verify under the different preceding
bytes.

**Replay across heights**: expiry_height limits the temporal window.
Consumer surfaces SHOULD also check whether referenced UTXOs are still
unspent at consumer-op time.

**Privacy**: PRED_EQ reveals the value to the verifier (which is the
whole point of equality). Other predicates hide the value (Pedersen
hiding + bulletproof zero-knowledge). The set of referenced
`commitment_outpoints` is public on chain — this links the
attestation to specific UTXOs (linkability of the holder's UTXOs to
the attestation publisher). Holders who want unlinkable attestations
should mix UTXOs first, then attest against fresh outpoints.

---

## Backwards-compatibility statement

This amendment is **purely additive at the protocol layer**. It introduces
one new opcode (`T_RANGE_ATTEST 0x44`) and one new domain tag
(`tacit-range-attest-v1`). No existing UTXO, opcode, ceremony, or
envelope is affected. Pre-amendment indexers happily ignore unknown
opcodes per SPEC.md §5.0. Existing tacit assets and orders remain
fully valid; the new opcode is opt-in for holders who want to publish
range attestations and for consumer surfaces that want to reference
them.
