# SPEC §5.24–§5.26 Amendment — cBTC.zk Fractional Shares

> **STATUS: DRAFT** (security-fixed 2026-05-17). Companion to
> `SPEC-CBTC-ZK-AMENDMENT.md`. Adds two new envelope opcodes
> (T_SLOT_FRACTIONALIZE `0x46`, T_SLOT_RECONSOLIDATE `0x47`) and a
> two-key slot variant that lets a slot's `denom_sats` of value
> circulate as standard tacit-asset UTXOs while the backing Bitcoin
> slot remains locked. This is the layer that makes cBTC.zk look and
> behave like any other tacit asset — fungible at arbitrary amounts,
> amount-hidden in transfer, tradeable on AMM, listable on the
> marketplace — without giving up self-custody or adding any new trust
> assumption.
>
> **Activation**: requires slot mints to declare the v2 two-key shape
> (carrying an explicit `k_btc_xonly` field). Legacy single-key slots
> can still burn/rotate but MAY NOT fractionalize — the
> `T_SLOT_FRACTIONALIZE` validator enforces this. New mints SHOULD
> default to v2 going forward.

---

## §5.24.0 Two-key slot variant (security foundation)

The base cBTC.zk amendment derives K_btc directly from the mixer
note's Pedersen commitment: `K_btc = recipient_commit − denom·H =
r_leaf · G` where `r_leaf = Poseidon₂(secret, ν)`. The same scalar
serves as BOTH the Pedersen blinding (revealed at withdraw/fractionalize
for indexer verification) AND the Bitcoin spending key (revealed at
burn). This dual use is what makes burn atomic and trustless: r_leaf
reveal happens simultaneously with BTC spend, so there's nothing for
an observer to race.

**Fractionalization breaks this property.** A naive FRACTIONALIZE
that reveals `r_leaf` while leaving the slot's BTC UTXO unspent on
chain would let any observer construct a plain Bitcoin tx with a
BIP-340 Schnorr key-path spend under `r_leaf` and drain the BTC.
The leaf-state machine doesn't help — Bitcoin doesn't enforce tacit
state.

**Fix**: separate the Pedersen blinding from the BTC spending key.

```
r_pedersen = Poseidon₂(secret, ν)          // identical to legacy r_leaf
r_btc      = Poseidon₂(secret, ν || "btc")  // distinct secp scalar
K_btc      = r_btc · G                      // BTC spending key
recipient_commit = denom · H + r_pedersen · G   // Pedersen commitment

// Both scalars are computed from the same (secret, ν) but with
// different domain inputs, so they're computationally independent
// in practice: from r_pedersen alone, computing r_btc requires
// inverting Poseidon (one-way).
```

The slot's BTC UTXO is locked at `K_btc = r_btc · G` (NOT
`recipient_commit − denom · H` anymore). The mint envelope publishes
`k_btc_xonly` explicitly so indexers can verify the slot script.

**Wire-format change** to `T_SLOT_MINT` (opcode 0x43): append an
optional **32-byte `k_btc_xonly` tail** to the canonical 244-byte
payload. The decoder accepts:
- 244 bytes (legacy v1, single-key): `K_btc` is derived as
  `recipient_commit − denom · H`. Legacy slots cannot fractionalize.
- 244 + 32 = 276 bytes (v2, two-key): `K_btc` is the explicit x-only
  value from the tail. Legacy `recipient_commit − denom · H`
  derivation is NOT used; v2 slots can fractionalize safely.

The minter signs `k_btc_xonly` into `slot_mint_msg_v2`:

```
slot_mint_msg_v2 = SHA256(
  "tacit-slot-mint-v2"   // v2 domain tag (distinct from v1's "tacit-slot-mint-v1")
  || network_tag(1)
  || asset_id(32)
  || denom_sats_LE(8)
  || recipient_commit(33)
  || leaf_hash(32)
  || payment_asset_id(32)
  || payment_amount_LE(8)
  || k_btc_xonly(32)
)
```

The minter knows `r_btc` and publishes its x-only G-multiple. Anyone
who tampers with `k_btc_xonly` invalidates the sig. If a malicious
minter publishes a `k_btc_xonly` whose discrete log they don't know,
the slot's BTC is permanently unspendable — that's the minter's own
loss, not a protocol soundness break.

### 5.24.0.1 Validator algorithm update for v2

```
on T_SLOT_MINT v2:
  decode 276-byte payload (244-byte canonical + 32-byte k_btc_xonly tail)
  require minter_sig verifies under slot_mint_msg_v2
  require tx.vout[0].script_pubkey == OP_PUSHNUM_1 || OP_PUSHBYTES_32 || k_btc_xonly
  // NB: do NOT require K_btc == recipient_commit − denom · H. The
  // explicit k_btc_xonly is independent. recipient_commit binds the
  // mixer leaf to (denom, r_pedersen); k_btc_xonly binds the BTC slot
  // to r_btc. They're separate keys.
  proceed with standard mixer leaf + slot-registry append
```

### 5.24.0.2 Burn/rotate behavior

`T_SLOT_BURN` and `T_SLOT_ROTATE` for v2 slots spend the slot UTXO
under `r_btc` (NOT `r_leaf`). The slot record persists both `r_btc`
and `r_pedersen` (computed from secrets at mint time).

For v1 (legacy) slots, burn/rotate continue to use the single key
`r_leaf = r_pedersen = r_btc` as today.

The dapp's slot-record format (per-network localStorage) gains an
optional `rBtcHex` field. Slots minted v1 omit it (derive from
secrets via legacy Poseidon₂(secret, ν)); slots minted v2 include
it explicitly.

---

## (Original "Pre-merge security review" section — now resolved by §5.24.0 above.)

(Historical context retained for amendment archaeology — the original
text described the fix path that §5.24.0 now implements.)

Recommended: define a dedicated `mixer_fractionalize` circuit that
exposes `(merkle_root, nullifier_hash, recipient_commit, denom_sats)`
as public inputs and proves the same membership statement without
exposing `r_leaf`. Re-uses the existing trusted setup if the circuit
is structurally identical modulo the public-input set.

**Status**: flagged 2026-05-17. Awaiting amendment author's revision
before any implementation work begins against §5.25 / §5.26.

---
>
> **Scope of unchanged behavior.** No existing opcode is reinterpreted;
> no existing trust model changes. T_SLOT_MINT and T_SLOT_BURN keep
> their meaning. The amendment ADDS:
>
> 1. A per-leaf state field (`live` / `fractionalized` / `redeemed`)
>    maintained by the indexer, with state transitions driven by the
>    new opcodes.
> 2. Two new envelopes that move denomination value between the slot
>    layer and the standard tacit-asset layer.
> 3. A precondition on T_SLOT_BURN and T_SLOT_ROTATE: the consumed
>    leaf MUST be in `live` state.
> 4. A normative rule that cBTC.zk variants participate in
>    T_AXFER_VAR and downstream flows (AMM, marketplace, market
>    orders) as standard tacit assets keyed by `(asset_id)`, with
>    supply equal to the sum of fractionalized slot denominations.

---

## Motivation

The base cBTC.zk amendment (`SPEC-CBTC-ZK-AMENDMENT.md`) defines a
self-custody-slot wrapper where each Bitcoin UTXO is locked at a key
derivable only from a single mixer note's commitment. The construction
preserves trustlessness end-to-end but binds **value to a fixed
per-variant denomination**: every cBTC.zk note in a
`(asset_id, denom_sats)` variant represents exactly `denom_sats` of
backing BTC, and the only operations are mint-the-whole-denom,
burn-the-whole-denom, and rotate-the-whole-denom.

This is sufficient for "lock 1 BTC, redeem 1 BTC later" but blocks
three categories of user-visible behavior:

1. **Arbitrary-amount transfers.** A holder of one 1-BTC slot cannot
   send 0.01 of it to someone else without first burning the slot,
   re-minting at smaller denominations, and rotating.
2. **Amount privacy on transfer.** Every slot rotation publishes the
   slot's denomination on chain. Transfer-amount privacy is structurally
   impossible at the slot layer.
3. **Seamless AMM/marketplace participation.** Standard tacit assets
   trade as amount-hidden Pedersen-committed UTXOs. AMM pools, the
   marketplace, and order primitives all consume that representation.
   A slot-only asset cannot participate without integration glue at
   every site that touches asset balances.

The cleanest resolution is to give cBTC.zk a **dual representation**:

- **Slot form** — what exists today. Used for wrap (lock BTC) and
  unwrap (spend BTC). One slot = one fixed denomination = one mixer
  leaf controlling one Bitcoin UTXO.
- **Share form** — a standard tacit-asset UTXO of cBTC.zk, amount-hidden
  via the existing bulletproof construction (SPEC §3.2). Indistinguishable
  from any other tacit asset for transfer, AMM, and marketplace purposes.

A slot can convert to shares (and back) via the new envelopes. The
invariant tying them together is purely arithmetic and enforceable by
the indexer:

> For each cBTC.zk variant, the sum of `denom_sats` across all `live`
> and `fractionalized` slot leaves equals the sum of corresponding
> unspent backing Bitcoin UTXO values; the sum of cBTC.zk share UTXO
> amounts equals the sum of `denom_sats` across `fractionalized` slot
> leaves only.

No new trust party is introduced. The conservation invariant is
enforced by the same indexer rule discipline that already gates every
other tacit opcode.

---

## §5.24 Leaf-state model

Indexers MAINTAIN a per-leaf state for every cBTC.zk slot leaf,
initialized at append time. State transitions are atomic with envelope
processing.

```
state ∈ {live, fractionalized, redeemed}

initial state on T_SLOT_MINT append      → live
initial state on T_SLOT_ROTATE new leaf  → live
T_SLOT_FRACTIONALIZE on a `live` leaf    → fractionalized
T_SLOT_RECONSOLIDATE on a `fractionalized` leaf → live
T_SLOT_BURN on a `live` leaf             → redeemed
T_SLOT_ROTATE on a `live` leaf           → redeemed (replaced by the new leaf)
```

The state is keyed by `(network, asset_id, denom_sats, leaf_hash)`:

```
slot_leaf_state_key = "slot_leaf_state:<network>:<asset_id_hex>:<denom_sats>:<leaf_hash_hex>"
```

Indexers MAY collocate the state with the existing slot-registry
record (`slot:<network>:<asset_id>:<denom_sats>:<k_btc_xonly>`); the
canonical key form above is normative for cross-implementation diffing.

### 5.24.1 Precondition tightening on existing opcodes

This amendment tightens the validator algorithms for two existing
envelopes:

- **T_SLOT_BURN** (§5.22): the consumed leaf MUST be in `live` state.
  A fractionalized slot's BTC cannot be drained without first
  reconsolidating shares totalling exactly `denom_sats`. Indexers
  that observe a T_SLOT_BURN against a non-`live` leaf MUST treat the
  envelope as malformed and refuse to record the nullifier.

- **T_SLOT_ROTATE** (§5.23): the consumed old leaf MUST be in `live`
  state. Rotating a fractionalized slot would orphan the shares.

These tightenings are pre-launch normative — no live slot leaves
exist in non-`live` state under any pre-amendment indexer
configuration, so the constraint is empty until this amendment
activates.

---

## §5.25 T_SLOT_FRACTIONALIZE (`0x46`)

Converts a `live` slot leaf to N standard tacit-asset cBTC.zk share
UTXOs whose amounts sum to the slot's `denom_sats`. The backing
Bitcoin UTXO is unchanged; the slot leaf transitions to
`fractionalized` state.

This is a **tacit-side envelope only** — no Bitcoin transaction is
required. The envelope appears in a standard tacit asset-transfer
container (the same wire envelope used by T_AXFER_VAR) so that the
share UTXOs materialize via the existing asset-output machinery.

### 5.25.1 Wire format (envelope payload)

```
T_SLOT_FRACTIONALIZE
   opcode              1 byte   (0x46)
   network_tag         1 byte
   asset_id            32 bytes (cBTC.zk variant asset_id)
   denom_sats_LE       8 bytes  (u64; the slot's denomination)
   merkle_root         32 bytes (BN254 element; from recent-roots window)
   nullifier_hash      32 bytes (Poseidon₁(ν); proves leaf is unspent)
   recipient_commit    33 bytes (compressed; the leaf's slot commit)
   r_leaf              32 bytes (proves K_btc derivation; not used to spend BTC here)
   bind_hash           32 bytes (per SPEC §5.11 binding formula)
   share_count         1 byte   (N ∈ [1, 16]; number of share UTXOs produced)
   share_commits       N × 33 bytes (compressed secp256k1; one Pedersen commit per share)
   share_amount_proof  VAR bytes (bulletproof proving Σ amounts = denom_sats)
   proof_length        2 bytes  (u16 LE; length of groth16_proof, 1..65535)
   groth16_proof       VAR bytes (Groth16 over the membership + ownership statement)
```

The bind_hash domain-tag is **`tacit-withdraw-bind-v1`** (reused from
SPEC §5.11 — the cryptographic binding statement is identical to a
mixer withdraw). The fractionalize envelope reuses the mixer's existing
withdraw circuit and ceremony.

### 5.25.2 Share commitment semantics

Each `share_commit[i]` is a SEC1-compressed point committing to
`(amount_i, r_i)` under the Pedersen primitive used by all tacit asset
UTXOs:

```
share_commit_i = amount_i · H + r_i · G_secp256k1
```

The sum of all `share_commit_i` MUST equal a publicly-derivable
target commitment:

```
Σ share_commit_i = denom_sats · H + r_total · G_secp256k1
```

where `r_total = Σ r_i` (kept private; only the holder of all `r_i`
knows it). The validator verifies:

1. `Σ share_commit_i − denom_sats · H` is on-curve and non-identity.
   This proves the amount-sum identity without revealing per-share
   amounts.
2. The `share_amount_proof` is a valid bulletproof over the share
   commitments proving each `amount_i ∈ [1, 2^64)` (standard
   range-proof discipline; rules out negative amounts and overflow).
3. Each `share_commit_i` decodes to a valid compressed point.

### 5.25.3 Validator algorithm

```
on T_SLOT_FRACTIONALIZE:
  require envelope.network_tag matches local network identifier
  require envelope.share_count ∈ [1, 16]
  require envelope.share_commits.length == share_count
  require pool_init exists for (asset_id, denom_sats)

  // Membership + ownership (reuses mixer withdraw circuit)
  require envelope.merkle_root ∈ recent-roots window for (asset_id, denom_sats)
  require envelope.nullifier_hash ∉ spent-set for (asset_id, denom_sats)
  require bind_hash == compute_withdraw_bind(envelope.{asset_id, denom_sats,
                          nullifier_hash, recipient_commit, r_leaf})
  require groth16_verify(MIXER_WITHDRAW_VK, envelope.proof,
                          public_signals=[merkle_root, nullifier_hash,
                                          recipient_commit, r_leaf, bind_hash])

  // Locate the source leaf by recipient_commit + denom_sats → leaf_hash.
  // The mixer's leaf-index over recipient_commit is canonical; if multiple
  // leaves share a recipient_commit (negligible probability with proper
  // randomness), the nullifier_hash disambiguates.
  source_leaf := lookup_leaf(asset_id, denom_sats, recipient_commit, nullifier_hash)
  require source_leaf.state == live

  // SECURITY GATE: v1 (legacy single-key) slots cannot fractionalize.
  // Their BTC spending key IS r_leaf; revealing r_leaf here (via the
  // public-input position in the Groth16 proof) lets any observer drain
  // the slot's BTC. v2 (two-key) slots have an independent r_btc; r_leaf
  // reveal is safe.
  require source_leaf.slot_variant == "v2"
  // Equivalently: require the slot-registry record for this leaf has an
  // explicit k_btc_xonly that is NOT equal to (recipient_commit − denom·H).x_only().
  // v1 records lack this field; lookup MUST return v1 → reject.

  // Share conservation
  require Σ envelope.share_commits − denom_sats · H is on-curve and ≠ identity
  require bulletproof_verify(envelope.share_amount_proof, share_commits)

  // Effects
  source_leaf.state := fractionalized
  spent-set[asset_id, denom_sats].add(nullifier_hash)
  for each share_commit_i in envelope.share_commits:
    append new tacit asset UTXO to (asset_id) with commitment share_commit_i
  increment fractionalized_supply[asset_id] by denom_sats
```

The nullifier added here is the SAME spent-set entry that would be
added on T_SLOT_BURN — it prevents double-fractionalization and
prevents fractionalize-then-burn of the same leaf. Reconsolidation
restores the leaf to `live` and (per §5.26) removes the entry,
allowing future operations.

### 5.25.4 Anonymity properties

T_SLOT_FRACTIONALIZE reveals on chain:
- That **some** slot in the (asset_id, denom_sats) pool was
  fractionalized (anonymity-set sized by `live` leaves at proof time).
- The slot's denomination (always public per the wrapper).
- That N new share UTXOs were minted into the (asset_id) tacit-asset
  pool, with amounts hidden but summing to denom_sats.

The originator's slot identity within its pool is hidden by the
Groth16 membership proof. The share amounts are hidden by the
bulletproof. The total is necessarily public because denom_sats is
public.

---

## §5.26 T_SLOT_RECONSOLIDATE (`0x47`)

Consumes N standard tacit-asset cBTC.zk share UTXOs whose amounts
sum to exactly `denom_sats`, and restores a previously-fractionalized
slot leaf to `live` state. The backing Bitcoin UTXO is unchanged.

### 5.26.1 Wire format (envelope payload)

```
T_SLOT_RECONSOLIDATE
   opcode              1 byte   (0x47)
   network_tag         1 byte
   asset_id            32 bytes (cBTC.zk variant asset_id)
   denom_sats_LE       8 bytes  (u64; target slot's denomination)
   target_leaf_hash    32 bytes (the fractionalized leaf to restore)
   share_count         1 byte   (M ∈ [1, 16]; number of share UTXOs consumed)
   share_nullifiers    M × 32 bytes (per SPEC §3.2 nullifier construction)
   share_commits       M × 33 bytes (the consumed UTXO commitments, copied for binding)
   share_balance_proof VAR bytes (bulletproof proving Σ amounts = denom_sats)
   proof_length        2 bytes  (u16 LE; length of groth16_proof, 1..65535)
   groth16_proof       VAR bytes (Groth16 proving knowledge of each share's opening)
```

The Groth16 statement here is the standard tacit asset-spend circuit
(SPEC §3.4) generalized to M inputs: the proof attests that the
prover knows openings `(amount_i, r_i)` for each `share_commit_i`, and
that the sum equals the public target `denom_sats`.

### 5.26.2 Validator algorithm

```
on T_SLOT_RECONSOLIDATE:
  require envelope.network_tag matches local network identifier
  require envelope.share_count ∈ [1, 16]
  require pool_init exists for (asset_id, denom_sats)

  // Target leaf must exist and be fractionalized.
  target_leaf := lookup_leaf_by_hash(asset_id, denom_sats, target_leaf_hash)
  require target_leaf is not None
  require target_leaf.state == fractionalized

  // Per-share unspent + nullifier-fresh check
  for i in 0..share_count:
    require share_commits[i] is a known unspent (asset_id) UTXO commitment
    require share_nullifiers[i] ∉ spent-set[asset_id]

  // Share conservation
  require Σ share_commits − denom_sats · H is on-curve and ≠ identity
  require bulletproof_verify(envelope.share_balance_proof, share_commits)

  // Ownership
  require groth16_verify(ASSET_SPEND_VK_M, envelope.proof,
                          public_signals=[share_commits, denom_sats])

  // Effects
  target_leaf.state := live
  // Remove the fractionalize-time nullifier so the leaf can transition
  // again in the future (re-fractionalize or burn).
  spent-set[asset_id, denom_sats].remove(target_leaf.nullifier_hash)
  for i in 0..share_count:
    spent-set[asset_id].add(share_nullifiers[i])
    mark share UTXO at commitment share_commits[i] as spent
  decrement fractionalized_supply[asset_id] by denom_sats
```

Removing the fractionalize-time nullifier when transitioning back to
`live` is the only place in the protocol where a nullifier is
**rescinded**. The safety argument: that nullifier was added under the
authority of a Groth16-attested fractionalize envelope, and is being
removed under the authority of a Groth16-attested reconsolidate
envelope that proves possession of share UTXOs totalling exactly
`denom_sats`. Net effect on the variant's spent-set: equivalent to
the leaf never having been fractionalized.

Indexers that prefer not to mutate the spent-set MAY instead maintain
two disjoint sets per variant: `slot_nullifiers` (consumed by
burn/rotate, never rescinded) and `frac_nullifiers` (consumed by
fractionalize, rescinded by reconsolidate). The fractionalize rule
checks both; the burn/rotate rule checks `slot_nullifiers` only. This
is the recommended implementation strategy and is observable-
equivalent to the rescind-and-reuse formulation above.

### 5.26.3 Coalescing requirement and routing

A holder seeking to unwrap fractional shares back to BTC must first
acquire shares totalling exactly `denom_sats` for some unspent
fractionalized leaf. Discovery happens through the standard tacit
asset transfer layer — share UTXOs propagate via T_AXFER_VAR, AMM
swaps, marketplace trades, or direct gifts — and through the
fractionalized-leaf registry (publicly enumerable per variant).

If no fractionalized leaf exists matching the holder's accumulated
share total, the holder MAY:

- Trade their share excess (or deficit) on the AMM for the right
  amount to match an available denomination.
- Wait for a counterparty to fractionalize a slot at the matching
  denomination.
- Cooperate with another shareholder to jointly reconsolidate.

The protocol does not mandate a coalescer; routing is a UX concern.

---

## §5.27 cBTC.zk as a standard tacit asset

Once this amendment is active, cBTC.zk variant asset_ids participate
in the standard tacit asset registry alongside TAC, sats, and any
other tacit-native asset. The integration is:

1. **Asset registration.** Each cBTC.zk variant
   `(asset_id, denom_sats)` registers a tacit asset with `asset_id`
   and metadata derived from the variant's `tacit_wrapper` block.
   The asset's ticker SHOULD reflect the denomination (e.g.
   `cBTC.zk[1.000 BTC]`); the dapp MAY aggregate variants under a
   shared display ticker `cBTC.zk` with per-variant denomination
   shown on hover.

2. **Supply tracking.** Total supply of asset_id is reported as
   `fractionalized_supply[asset_id]` (sum of denom_sats across all
   fractionalized leaves). The slot-form-only portion (live leaves
   that have never been fractionalized) is reported separately as
   "wrapped, not in circulation."

3. **T_AXFER_VAR compatibility.** Share UTXOs ARE tacit asset
   UTXOs. They transfer, split, merge, and amount-hide via the
   existing T_AXFER_VAR machinery with no special-case handling.

4. **AMM compatibility.** AMM pools register against
   `(cBTC.zk asset_id, counterparty_asset_id)` and consume share
   UTXOs as a standard liquidity input. The AMM circuits
   (amm_swap_batch, amm_lp_add, amm_lp_remove) are unchanged — they
   operate on Pedersen-committed asset amounts and are
   asset-agnostic. The router (§4.2.6) treats cBTC.zk variants as
   independent assets at the pool level but MAY surface a unified
   `cBTC.zk` ticker in price feeds by aggregating depth across
   variants.

5. **Marketplace compatibility.** The marketplace listing /
   bidding flow operates on tacit asset UTXOs. Share UTXOs list
   and trade with no protocol changes.

6. **Coverage check extension.** The per-leaf SPV verification
   from §4.2.x.2 of the base amendment still applies: each
   `live` OR `fractionalized` leaf must have a matching unspent
   BTC UTXO at its derived K_btc. The variant's coverage ratio
   is:

   ```
   coverage(asset_id, denom_sats) = (matching unspent UTXOs)
                                  / (live + fractionalized leaves)
   ```

   Share UTXOs are NOT directly coverage-checked; they are
   transitively covered by the fractionalized leaves whose
   denominations they sum to (per the conservation invariant).

---

## §5.28 Conservation invariants (normative)

For each cBTC.zk variant `(asset_id, denom_sats)`:

```
INV-1: |unspent BTC UTXOs at slot K_btc addresses|
     = |live slot leaves| + |fractionalized slot leaves|

INV-2: Σ amount over unspent (asset_id) share UTXOs
     = Σ denom_sats over fractionalized slot leaves
     = fractionalized_supply[asset_id]

INV-3: spent-set over (asset_id, denom_sats) at any height contains:
       • all nullifiers from completed T_SLOT_BURN
       • all nullifiers from completed T_SLOT_ROTATE (old leaves)
       • all nullifiers from currently-fractionalized leaves
         (rescinded on T_SLOT_RECONSOLIDATE)
```

INV-1 follows from per-slot SPV verification + leaf-state accounting.
INV-2 follows from conservation enforcement at T_SLOT_FRACTIONALIZE
(creates shares summing to denom_sats) and T_SLOT_RECONSOLIDATE
(consumes shares summing to denom_sats). INV-3 is bookkeeping over
the spent-set transitions.

Indexers MUST refuse to record any envelope that would violate any
invariant. A divergence in any invariant indicates an indexer bug or
a chain reorg; reorg-recovery procedures (§5.29 below) reset and
re-derive state from the canonical chain.

---

## §5.29 Reorg recovery

The leaf-state model and the share-UTXO set both live in indexer
KV state derived from chain observations. A Bitcoin reorg that
invalidates a T_SLOT_MINT, T_SLOT_BURN, T_SLOT_ROTATE,
T_SLOT_FRACTIONALIZE, or T_SLOT_RECONSOLIDATE envelope MUST be
followed by full re-derivation from the canonical chain at depth
≥ the reorg depth.

Implementations MAY incremental-update by:

1. Identifying the highest confirmed pre-reorg block H_pre.
2. Truncating leaf-state, spent-set, and share-UTXO records at H_pre.
3. Replaying every envelope from H_pre + 1 forward.

Replay is deterministic — every state transition is a pure function
of `(prior_state, envelope_payload, chain_observations)` — so
parallel indexers converge.

The mixer's existing reorg-handling for mixer leaves is reused for
slot leaves and share UTXOs; this amendment introduces no new
reorg pathways.

---

## §5.30 Security properties

| Property | Mechanism |
|---|---|
| No federation, no oracle, no co-signer at any layer | Same as base cBTC.zk: K_btc derivable only from r_leaf, no escape path |
| Backing BTC unrecoverable without note | Same as base cBTC.zk; fractionalize does not consume the leaf's r_leaf knowledge |
| Cannot fractionalize the same leaf twice | Nullifier-set entry on fractionalize + leaf state check |
| Cannot burn a fractionalized slot | Burn precondition: leaf.state == live |
| Cannot reconsolidate without exact denom_sats of shares | Bulletproof + Pedersen sum identity check |
| Cannot create shares from thin air | Fractionalize requires Groth16 membership proof on a real slot leaf, with bulletproof-enforced sum |
| Cannot redeem more BTC than was wrapped | INV-1 + INV-2 jointly imply ΣBTC ≥ Σ slot denoms ≥ Σ shares; redemption consumes a slot, which consumes its share-backing |
| Share transfers are amount-hidden | Standard tacit T_AXFER_VAR bulletproof discipline |
| Share transfers are linkability-private | Standard tacit asset transfer privacy (nullifier-based) |
| Slot-form transfers reveal denomination | Unchanged from base cBTC.zk |
| Trust assumptions | Same as base: Groth16 soundness + Pedersen binding + secp256k1 hardness + indexer rule enforcement |

The amendment introduces ZERO new trust assumptions. Every check is
of a form the indexer already performs for the mixer or AMM (Groth16
verify, Pedersen sum, bulletproof verify, spent-set bookkeeping,
chain observation).

---

## §5.31 Not in scope (deferred)

1. **Slot-direct splitting/merging at the Bitcoin layer.** A T_SLOT_SPLIT
   that atomically spends one Bitcoin slot UTXO into N new slot UTXOs
   of smaller denominations. The fractional-share layer subsumes this
   functionality (fractionalize → standard tacit-asset split via
   T_AXFER_VAR → reconsolidate at the desired smaller denom). A direct
   Bitcoin-layer split is more BTC-efficient (one Bitcoin tx instead
   of multiple operations) but adds protocol surface; deferred.

2. **Cross-variant atomic merge.** Combining a fractionalized slot
   of denom A with shares from a different variant of denom B to
   produce a slot of denom A+B in a new variant. Requires
   cross-variant Pedersen-sum proofs; deferred until cross-variant
   AMM routing is mature.

3. **Recipient-discoverable share transfers.** While share UTXOs
   transfer via T_AXFER_VAR (which already supports the standard
   tacit memo encryption), discoverable transfers from a sender to
   a known viewing key are a separate enhancement (see
   `SPEC-CBTC-ZK-AMENDMENT.md` §5.31 deferred list).

4. **Share-direct redemption.** A T_SHARE_BURN that consumes shares
   totalling some denomination and spends the corresponding slot
   atomically (combining T_SLOT_RECONSOLIDATE + T_SLOT_BURN into one
   envelope + one Bitcoin tx). UX-positive but adds wire surface;
   the two-envelope sequence is sufficient for v1.

5. **Multi-leaf fractionalize.** Fractionalize multiple slot leaves
   in one envelope to amortize Groth16 proving cost. Useful for
   batch operations; deferred until proving costs become a routing
   bottleneck.

---

## §5.32 Compatibility and migration

- **Pre-amendment indexers** observe opcodes 0x46 and 0x47 as
  unknown envelopes (forward-compat per SPEC §4.1) and are
  unaffected. They will NOT observe state transitions on leaves and
  WILL accept post-amendment T_SLOT_BURN envelopes that violate the
  new precondition (since they don't track state). Pre-amendment
  and post-amendment indexers therefore DIVERGE on validity of
  fractionalize-related envelopes; pre-amendment indexers MUST be
  upgraded before users begin issuing T_SLOT_FRACTIONALIZE.

- **Post-amendment dapps** SHOULD refuse to construct T_SLOT_BURN or
  T_SLOT_ROTATE envelopes against leaves they know to be
  fractionalized, surfacing the state to the user and offering
  reconsolidate as the next step.

- **Activation.** This amendment activates atomically with the
  upgraded indexer code paths. No flag day on chain; the first
  T_SLOT_FRACTIONALIZE envelope to confirm is the de facto
  activation marker. Pre-amendment T_SLOT_MINT envelopes that
  pre-date activation default to `live` state; their behavior is
  unchanged.

---

## §5.33 Opcode table update

Add to §3 *opcodes table*:

- `0x46` `T_SLOT_FRACTIONALIZE` — slot → standard tacit shares (§5.25)
- `0x47` `T_SLOT_RECONSOLIDATE` — standard tacit shares → slot (§5.26)

---

## Test plan

Implementations of this amendment SHOULD include the following test
coverage before mainnet activation:

1. **Round-trip fractionalize + reconsolidate.** Mint a slot, fractionalize
   to N shares, transfer shares around via T_AXFER_VAR, accumulate N back
   to the same holder, reconsolidate, verify leaf returns to `live`.

2. **Burn-precondition enforcement.** Fractionalize a slot, attempt
   T_SLOT_BURN, verify indexer rejects; reconsolidate, attempt burn,
   verify accepted.

3. **Conservation invariants.** Run a randomized envelope sequence and
   assert INV-1, INV-2, INV-3 after every confirmed block.

4. **Bulletproof share-sum identity.** Construct fractionalize and
   reconsolidate envelopes with deliberately-mismatched share sums
   and verify rejection.

5. **AMM swap of share UTXOs.** Run a full AMM swap with cBTC.zk as
   one side of the pool; verify the swap math (clearing, fee, receipts)
   is bit-identical to a swap of two non-cBTC.zk assets.

6. **Reorg recovery.** Simulate a reorg that invalidates a
   fractionalize envelope and verify the share UTXOs are correctly
   un-minted and the leaf returns to `live`.

7. **Cross-impl indexer determinism.** Dapp and worker indexers MUST
   produce byte-identical leaf-state and spent-set records over the
   same chain observation sequence (per SPEC §5.11.4 three-verifier
   model).

---

## Open questions for review

1. **Maximum share fan-out per envelope.** This draft caps at 16 shares
   per fractionalize and 16 per reconsolidate. Higher caps amortize
   proving cost but inflate envelope size. 16 mirrors the AMM
   N_MAX = 16 swap-batch cap and shares its rationale.

2. **Bulletproof aggregation across shares.** The share_amount_proof
   could be a single aggregate bulletproof over N range proofs (saves
   ~25% of proof bytes vs N separate proofs) or N separate proofs
   (simpler to verify, easier to compose with the standard tacit asset
   bulletproof discipline). Pre-launch decision; either works.

3. **Asset ticker scheme.** Whether each variant gets a distinct
   ticker (`cBTC.zk[1.000 BTC]`, `cBTC.zk[0.100 BTC]`, ...) or all
   share a unified ticker (`cBTC.zk`) with denomination as metadata.
   UX decision; spec is permissive.

4. **Fractionalized-leaf registry visibility.** Whether to expose a
   public list of fractionalized leaves available for reconsolidation
   matching (to ease the coalescing-by-denomination routing problem).
   Privacy-neutral: the leaves are already publicly enumerable via
   the leaf-state map. Recommend exposing.
