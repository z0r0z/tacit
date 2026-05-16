# SPEC §4.2 + §5.21–§5.23 Amendment — Self-Custody Slot Wrapper (cBTC.zk)

> **STATUS: DRAFT.** Adds `custody.kind = "self_custody_slot"` to the
> §4.2 wrapper convention and three new envelope opcodes
> (T_SLOT_MINT `0x43`, T_SLOT_BURN `0x44`, T_SLOT_ROTATE `0x45`)
> enabling fully trustless wrapped-asset mint / redeem / transfer
> with **no federation, no oracle threshold, no aggregate custody,
> no bonded operator role**. The reference instance is `cBTC.zk` —
> native BTC wrapped 1:1, every unit cryptographically bound to a
> self-custodied Bitcoin UTXO whose spending key is derivable only
> from the mixer note's secrets.
>
> **Scope of unchanged behavior.** No existing opcode, asset, AMM
> pool, or intent semantics change. This amendment ADDS a fourth
> custody-kind alongside `multisig`, `user_dlc`, `burn`, and
> `user_custody`; introduces three new envelope opcodes; and
> extends the wrapper registry's coverage check to handle per-slot
> verification. Pre-amendment indexers see the new opcodes as
> unknown envelopes (forward-compat per SPEC §4.1) and are unaffected.

---

## Motivation

The wrapper convention (§4.2 / `SPEC-WRAPPER-AMENDMENT.md`) defines
metadata for wrapped assets but assumes a custody party holds reserves
at a declared `reserve_address`. cBTC.tac (federated 3-of-5) and the
cUSD-amendment's canonical cBTC (per-user DLC + oracle threshold
co-signer) both narrow trust significantly — but neither is
*structurally trustless*. Both designs rely on at least one
cooperating party (federation, oracle threshold) at redemption time,
with a CSV escape as fallback.

This amendment closes the gap. The cryptographic alignment between
the mixer's secp256k1 Pedersen commit and Bitcoin's Schnorr key-path
spend enables a wrapped-asset construction where **the mixer note's
own `r_leaf` IS the spending key of the backing BTC UTXO**. Mint,
redeem, and transfer become single-Bitcoin-tx atomic operations with
no co-signer of any kind. Trust profile collapses to the same
assumptions tacit already makes (Groth16 soundness, Pedersen binding,
secp256k1 hardness, indexer rule enforcement).

**Comparison with adjacent designs:**

| Property | cBTC.tac | canonical cBTC (§6.2) | cBTC.zk (this amendment) |
|---|---|---|---|
| Custody | 3-of-5 federation | Per-user DLC + oracle threshold | Per-user self-custody slot, no co-signer |
| Redemption co-signer | Federation 3-of-5 | Oracle threshold FROST | None — note-holder alone |
| Escape on co-signer failure | CSV 26280 blocks | CSV 26280 blocks | Not applicable — no co-signer |
| Mixer-shielded by default | No | No | Yes (every op is a mixer note) |
| Lost-key consequence | Reserves recoverable via fed | Sats recoverable via CSV | Sats permanently locked |
| Trust assumption at trade | Federation honest at trade | Oracle threshold honest at trade | secp256k1 + Groth16 + indexer rules |

cBTC.zk is the structurally-most-trustless point on this curve, at
the cost of one property: **lost notes lock corresponding BTC
permanently.** This is the same property native Bitcoin already has
(lost keys = lost coins) and parallels WETH-on-Ethereum (lost ERC-20
balance = unrecoverable ETH).

---

## Cryptographic alignment

Tacit's mixer note carries a **secp256k1 Pedersen commitment** (SPEC
§3.2, §5.11):

```
recipient_commitment = denomination · H + r_leaf · G_secp256k1
```

Where:

- `H` is the protocol's NUMS generator on secp256k1 (SPEC §3.1)
- `G_secp256k1` is the standard secp256k1 generator
- `r_leaf = Poseidon₂(secret, ν)` — a BN254 Fr element (≈ 2⁻²
  smaller than secp256k1's order `n`, so embedding is a no-op; no
  modular reduction needed and no security loss)

The point `r_leaf · G_secp256k1` is — by construction — a valid
**Bitcoin-compatible secp256k1 public key** whose discrete log
(`r_leaf`) is known only to the holder of the mixer note's
`(secret, ν)`. SPEC §5.11 already requires the validator to perform
this Pedersen check at withdraw time and already requires the
withdrawing party to publish `r_leaf` in cleartext on chain.

**The construction:** lock backing BTC at a Taproot P2TR output with
internal key `K_btc = r_leaf · G_secp256k1`, key-path-only. The
slot's spending key is mathematically identical to the mixer note's
Pedersen-commit base point (minus the public `denomination · H`
term). Anyone who can withdraw the note can spend the BTC — and
nobody else can. There is no separate custody party, no co-signer,
no escape path.

`K_btc` is publicly derivable from the leaf's on-chain
`recipient_commitment` by anyone: `K_btc = recipient_commitment −
denomination · H`. Indexers verify the lock matches by recomputing
`K_btc` and checking the corresponding UTXO exists on Bitcoin at
value `denomination`.

---

## §4.2.x Wrapper convention extension

Extend `tacit_wrapper.custody.kind` (§4.2.1) with a new value
`"self_custody_slot"`:

```jsonc
{
  "tacit_wrapper": {
    "version": 1,
    "underlying": {
      "chain": "bitcoin",
      "asset": "native",
      "unit": "satoshi"
    },
    "peg": { "numerator": 1, "denominator": 1, "kind": "fixed" },
    "custody": {
      "kind": "self_custody_slot",        // NEW
      "denom_sats": 100000,                // u64; per-note BTC denomination
      "reserve_address": null,             // structurally null
      "max_supply": null,                  // optional cap
      "threshold_k": null,
      "threshold_n": null,
      "escape": null                       // structurally null
    },
    "redemption": {
      "fee_bps": 0,                        // structural fee 0; Bitcoin fee is separate
      "min_request_units": 1               // structural minimum
    },
    "attestation": null                    // no issuer; cryptographically attested
  }
}
```

### 4.2.x.1 Field semantics under `self_custody_slot`

- **`denom_sats`** (u64, required, > Bitcoin dust threshold for the
  output script type — 330 sats for P2TR): the BTC denomination of
  each note. Each cBTC.zk unit corresponds to one mixer leaf in the
  pool keyed by `(asset_id, denom_sats)`. All notes in the same
  variant share this denomination.

- **`reserve_address`** MUST be `null`. There is no aggregate
  reserve; reserves are the union of unspent slot UTXOs derived
  from individual leaves.

- **`max_supply`** (u64 | null, optional): hard cap on cumulative
  mints. Convenient for fixed-supply variants; null = uncapped.

- **`threshold_k`**, **`threshold_n`**, **`escape`** MUST all be
  `null`. The custody kind has no signing parties to threshold and
  no escape path.

- **`redemption.fee_bps`** MUST be `0`. Self-custody-slot wrappers
  have no issuer who can charge a structural fee; users pay Bitcoin
  miner fees directly on each operation.

- **`attestation`** MUST be `null`. There is no issuer publishing
  attestations; coverage is verifiable cryptographically per §4.2.x.2.

Indexers encountering an unknown combination of fields under
`self_custody_slot` (e.g., a non-null `reserve_address`) MUST treat
the metadata as malformed and refuse to register the wrapper.

### 4.2.x.2 Per-slot coverage check

The aggregate-reserves coverage check from §4.2.3 does not apply.
For `self_custody_slot` wrappers, indexers compute coverage by
per-leaf SPV verification.

For each unspent leaf `L_i` in the mixer pool `(asset_id, denom_sats)`:

1. Read `recipient_commitment_i` from leaf-i's T_DEPOSIT envelope
   (or T_SLOT_MINT — see §5.21 — which is structurally a deposit).
2. Compute `K_btc_i = recipient_commitment_i − denom_sats · H` on
   secp256k1.
3. Compute the slot's bech32m address as the P2TR with internal key
   `K_btc_i` and no script-path branches (i.e., the output script
   is `OP_1 <x_only(K_btc_i)>`).
4. Verify a confirmed Bitcoin UTXO exists at that address with
   value exactly `denom_sats`.

`coverage(asset_id) = (count of leaves with matching unspent UTXO) /
(total unspent leaves in pool)`.

A correctly-operating variant has `coverage = 1.0` modulo Bitcoin
reorgs. Any mismatch indicates either:
- A pending unconfirmed mint (resolves on confirmation), OR
- A protocol violation (indexers MUST flag and downgrade routing).

Indexers MAY cache `K_btc_i → utxo_status` for performance. The
cache invalidates on any Bitcoin reorg affecting the slot's height.

### 4.2.x.3 Routing-score adjustment

For `self_custody_slot` wrappers, the routing-score function (§4.2.6)
substitutes:

- `attestation_freshness_factor = 1.0` always — there is no issuer
  attestation to age.
- `coverage_ratio` is the per-slot coverage from §4.2.x.2.
- `w_liveness` contribution is constant; competition between
  variants is on `coverage`, `fee_bps` (which is structurally 0 for
  self_custody_slot), and `depth`.

In practice, all well-formed `self_custody_slot` variants score
identically on liveness; differentiation is on AMM-pool depth and
denomination choice.

---

## §5.21 T_SLOT_MINT (`0x43`)

Atomic mint envelope. A single Bitcoin transaction performs three
operations simultaneously:

1. LP locks `denom_sats` BTC at the slot address derived from the
   minter's chosen `recipient_commitment`.
2. Minter receives a fresh mixer note for 1 unit of the wrapper asset.
3. LP receives a tacit-asset payment from the minter.

The atomicity is structural — if any operation fails, the entire
Bitcoin tx fails to broadcast.

### 5.21.1 Wire format (envelope payload)

```
T_SLOT_MINT
   envelope_version    0x01
   opcode              0x43
   network_tag         1 byte   (0x00=mainnet, 0x01=signet, 0x02=regtest)
   asset_id            32 bytes (wrapper asset's CETCH-derived asset_id)
   denom_sats_LE       8 bytes  (u64; MUST match metadata.custody.denom_sats)
   recipient_commit    33 bytes (compressed secp256k1; leaf's Pedersen commit)
   leaf_hash           32 bytes (Poseidon₃(secret, ν, denom) — to be appended)
   payment_asset_id    32 bytes (tacit asset_id of LP's payment, e.g., TAC)
   payment_amount_LE   8 bytes  (u64; LP's payment in payment_asset base units)
   minter_pubkey       33 bytes (compressed; minter's BIP-340 pubkey)
   minter_sig          64 bytes (BIP-340 over slot_mint_msg under minter_pubkey)
```

Total payload: **245 bytes** + standard envelope wrapping.

```
slot_mint_msg = SHA256(
    "tacit-slot-mint-v1"
    || network_tag(1)
    || asset_id(32)
    || denom_sats_LE(8)
    || recipient_commit(33)
    || leaf_hash(32)
    || payment_asset_id(32)
    || payment_amount_LE(8)
)
```

### 5.21.2 Bitcoin transaction shape

The reveal tx MUST satisfy:

- **vout[0]**: P2TR output at value `denom_sats`. The output script
  MUST be `OP_1 <32-byte x_only(K_btc)>` where `K_btc =
  recipient_commit − denom_sats · H` (point arithmetic on
  secp256k1). No script-path leaves.
- **vout[1]**: a valid tacit asset UTXO opening to
  `(payment_asset_id, payment_amount, *)` per the standard tacit
  asset wire format (SPEC §5.x for the asset's opcode family).
- **vout[2..]**: optional change UTXOs for either party.

Inputs MAY originate from either the LP or the minter; the
indexer's role is to verify the envelope's claims match the actual
on-chain outputs.

### 5.21.3 Validator algorithm

```
on T_SLOT_MINT:
  require envelope.network_tag matches local network identifier
  
  // Asset + denomination consistency
  require asset_id is registered as a self_custody_slot wrapper
  require envelope.denom_sats == metadata.custody.denom_sats
  
  // Slot derivation + verification
  K_btc = secp256k1_point_sub(envelope.recipient_commit,
                              point_mul(envelope.denom_sats, H_secp256k1))
  K_btc_xonly = x_only(K_btc)
  require tx.vout[0].script_pubkey == OP_PUSHNUM_1 || OP_PUSHBYTES_32 || K_btc_xonly
  require tx.vout[0].value == envelope.denom_sats
  
  // Payment leg consistency
  require tx.vout[1] is a well-formed tacit asset UTXO
  require tx.vout[1].asset_id == envelope.payment_asset_id
  require tx.vout[1].amount_opens_to envelope.payment_amount_LE
  
  // Minter signature
  recompute slot_mint_msg per §5.21.1
  require BIP340_verify(envelope.minter_pubkey, slot_mint_msg, envelope.minter_sig)
  
  // Max supply gate (if set)
  if metadata.custody.max_supply is not null:
    require supply(asset_id) + 1 ≤ metadata.custody.max_supply
  
  // Leaf-hash sanity (full Poseidon₃ check happens at withdraw via Groth16;
  // here we just verify well-formedness)
  require envelope.leaf_hash is a valid BN254 field element
  
  if all checks pass:
    append envelope.leaf_hash to mixer pool for (asset_id, denom_sats)
    record slot K_btc_xonly → leaf_index in slot-registry for asset_id
    supply(asset_id) += 1
    accept envelope
```

### 5.21.4 Soundness

- **Slot binding.** `K_btc` is publicly derivable from
  `recipient_commit` (no secret knowledge required). Indexers all
  arrive at the same `K_btc` for the same leaf, so the slot
  registry is deterministic.

- **Minter signature.** Binds the LP to the terms the minter sees.
  The LP wouldn't sign their vin if the envelope claimed terms
  different from what they negotiated; the minter sig prevents
  silent substitution.

- **No griefing by phantom envelopes.** A malformed or missing
  T_SLOT_MINT envelope causes the validator to reject; the Bitcoin
  tx's BTC output at K_btc still exists on chain but is not
  credited as a slot. Recovery: the LP can spend it back via
  cooperation with whoever holds the corresponding `r_leaf` (which
  in the malformed case is the LP themselves if they hold the
  minter's secret material — but this is an operational pathology,
  not an attack surface).

### 5.21.5 Privacy at mint time

The slot's `K_btc` is publicly linked to the leaf via
`recipient_commit`. An on-chain observer can:

- See the LP's funding input (vin), identifying who provided the BTC
- See the minter's tacit-asset payment input, identifying the minter
- Match this T_SLOT_MINT to a specific leaf in the mixer pool

Subsequent operations (rotates, withdraws) within the mixer break
this link forward via the standard anonymity-set property. The
mint-time link is structurally present and accepted as a trade-off
for fully trustless mechanics. Users wanting depositor anonymity
SHOULD route the funding leg through a coinjoin or fresh wallet —
the same operational discipline the existing mixer documents.

---

## §5.22 T_SLOT_BURN (`0x44`)

Atomic redeem envelope. A single Bitcoin transaction:

1. Spends the slot UTXO at `K_btc`, key-path Schnorr-signed under
   `r_leaf`.
2. Carries a mixer-withdraw payload (equivalent to T_WITHDRAW).
3. Pays `denom_sats − bitcoin_fee` to the redeemer's chosen output.

### 5.22.1 Wire format

```
T_SLOT_BURN
   envelope_version    0x01
   opcode              0x44
   network_tag         1 byte
   asset_id            32 bytes
   denom_sats_LE       8 bytes
   merkle_root         32 bytes (BN254 element; from recent-roots window)
   nullifier_hash      32 bytes (Poseidon₁(ν))
   recipient_commit    33 bytes (compressed; same as the leaf's commit)
   r_leaf              32 bytes (BN254 element / secp256k1 scalar)
   bind_hash           32 bytes (per SPEC §5.11 binding formula)
   groth16_proof       VAR bytes (per SPEC §5.11.x serialization; see note)
```

Groth16 proof serialization follows the existing mixer convention
in SPEC §5.11.x. Total payload ≈ **460 bytes** + standard envelope
wrapping (exact size depends on Groth16 serialization choice;
implementations MUST match the existing T_WITHDRAW format).

Domain tag for `bind_hash`: **`tacit-withdraw-bind-v1`** (reused
from SPEC §5.11 — no new tag needed, since the cryptographic
binding is identical to a mixer withdraw).

### 5.22.2 Bitcoin transaction shape

- **vin[0]**: spends the slot UTXO. The prev_out script is `OP_1
  <x_only(K_btc)>` per §5.21.2; vin[0]'s witness contains a BIP-340
  Schnorr signature under `r_leaf` covering the entire transaction
  with SIGHASH_ALL.
- **vout[0]**: BTC payout to the redeemer's chosen address. Value =
  `denom_sats − bitcoin_fee_at_vin0`.
- **vout[1..]**: optional change for any additional inputs the
  redeemer added (e.g., to pay extra fee).

The redeemer constructs the signature locally — `r_leaf` is in
their possession because they (or their note's chain of predecessors)
have it as part of the note's secret material.

### 5.22.3 Validator algorithm

```
on T_SLOT_BURN:
  require envelope.network_tag matches local network
  require asset_id is registered as a self_custody_slot wrapper
  require envelope.denom_sats == metadata.custody.denom_sats
  
  // Standard mixer-withdraw checks (per SPEC §5.11)
  require envelope.merkle_root ∈ recent-roots window for (asset_id, denom_sats)
  require envelope.nullifier_hash ∉ spent-set for (asset_id, denom_sats)
  
  // Pedersen check (secp256k1)
  expected_commit = denom_sats · H + r_leaf · G_secp256k1
  require expected_commit == envelope.recipient_commit
  
  // Bind hash recompute
  recompute bind_hash per SPEC §5.11.4 over
    (asset_id, denom_sats, nullifier_hash, recipient_commit, r_leaf)
  require envelope.bind_hash == recomputed bind_hash
  
  // Groth16 verification (dapp-authoritative per SPEC §5.11.4 three-verifier model;
  // worker performs the structural check and rejects malformed proofs)
  require snarkjs.groth16.verify(
    vk_mixer,
    public_inputs = [merkle_root, nullifier_hash, denom_sats, r_leaf, bind_hash],
    proof = envelope.groth16_proof
  )
  
  // Slot consistency — the BTC slot must be the one being spent
  K_btc = recipient_commit - denom_sats · H
  K_btc_xonly = x_only(K_btc)
  require tx.vin[0].prevout.script_pubkey == OP_PUSHNUM_1 || OP_PUSHBYTES_32 || K_btc_xonly
  require tx.vin[0].prevout.value == envelope.denom_sats
  // (Bitcoin consensus verifies the Schnorr key-path sig; indexer does not re-verify)
  
  if all checks pass:
    insert nullifier_hash into spent-set
    mark slot K_btc_xonly as REDEEMED in slot-registry
    supply(asset_id) -= 1
    accept envelope
```

### 5.22.4 Front-running discussion

When the redeem tx hits mempool, `r_leaf` is exposed in the
envelope payload. A theoretical adversary could:

1. Observe `r_leaf` in mempool
2. Construct a competing tx spending the same slot to their own address
3. Sign under `r_leaf` (now publicly known)
4. Try to win miner inclusion via fee bump

Mitigations (defense in depth):

- **Non-RBF signaling.** Redeemer sets all `nSequence` values to a
  non-RBF value (e.g., `0xFFFFFFFE` or higher). Standard mempools
  refuse to replace non-RBF txs even with higher-fee competitors.
- **Aggressive initial fee.** Pay above current mempool median —
  miners won't pass it up for a marginal-fee replacement.
- **Package / direct-to-miner submission.** Use a Stratum relay or
  similar direct submission channel so the tx is in a block before
  any public-mempool observer sees it. Tooling: same packages
  Lightning HTLC claim transactions already use.
- **Confirmation gating in dapp.** Surface the front-running risk
  to users explicitly; recommend direct-miner submission for
  high-value redemptions.

This is the same hygiene Lightning HTLC claim transactions need.
It is real but well-understood, and tooling exists.

### 5.22.5 Soundness

- **Atomic combination.** The Schnorr sig under `r_leaf` and the
  Groth16 proof are bound to the same `r_leaf` via the Pedersen
  check, so a valid envelope implies both note ownership and slot
  spending power.
- **Conservation.** A successful T_SLOT_BURN consumes one
  nullifier and decrements supply by 1; the slot UTXO is spent on
  Bitcoin. Coverage stays exactly 1.0.
- **No double-spend.** The mixer's nullifier set prevents the same
  note from being burned twice. Bitcoin's UTXO model prevents the
  same slot from being spent twice. Both protections are
  independently enforced.

---

## §5.23 T_SLOT_ROTATE (`0x45`)

Atomic transfer envelope. A single Bitcoin transaction:

1. Spends the old slot at `K_btc_old`, key-path Schnorr-signed
   under `r_leaf_old`.
2. Creates a new slot at `K_btc_new` derived from a fresh
   `recipient_commit_new`.
3. Consumes the old note's nullifier and appends the new leaf.
4. Optionally transfers payment from the new owner to the old owner.

The point of this opcode is **trustless transfer of cBTC.zk
ownership without requiring the new owner to trust the old owner
not to rug** (the unavoidable risk of plain Tornado-style note
handoff). Supply is conserved.

### 5.23.1 Wire format

```
T_SLOT_ROTATE
   envelope_version       0x01
   opcode                 0x45
   network_tag            1 byte
   asset_id               32 bytes
   denom_sats_LE          8 bytes
   
   // OLD note (consumed — analogous to T_SLOT_BURN's withdraw fields)
   old_merkle_root        32 bytes
   old_nullifier_hash     32 bytes
   old_recipient_commit   33 bytes
   old_r_leaf             32 bytes
   old_bind_hash          32 bytes
   old_groth16_proof      VAR bytes (per SPEC §5.11.x; see T_SLOT_BURN note)
   
   // NEW note (created — analogous to T_SLOT_MINT's deposit fields)
   new_recipient_commit   33 bytes
   new_leaf_hash          32 bytes
   
   // OPTIONAL payment leg
   payment_asset_id       32 bytes (or 0x00..00 if no payment)
   payment_amount_LE      8 bytes  (0 if no payment)
   
   // BINDING signature from the old owner
   old_owner_pubkey       33 bytes (compressed)
   old_owner_sig          64 bytes (BIP-340 over slot_rotate_msg)
```

Total payload ≈ **720 bytes** + standard envelope wrapping.

Domain tag: **`tacit-slot-rotate-v1`**.

```
slot_rotate_msg = SHA256(
    "tacit-slot-rotate-v1"
    || network_tag(1)
    || asset_id(32)
    || denom_sats_LE(8)
    || old_nullifier_hash(32)
    || new_recipient_commit(33)
    || new_leaf_hash(32)
    || payment_asset_id(32)
    || payment_amount_LE(8)
)
```

### 5.23.2 Bitcoin transaction shape

- **vin[0]**: spends old slot at `K_btc_old`, key-path Schnorr under
  `old_r_leaf`, SIGHASH_ALL.
- **vin[1]** (optional): new owner's payment input.
- **vout[0]**: new slot at `K_btc_new = new_recipient_commit −
  denom_sats · H`, value `denom_sats`.
- **vout[1]** (optional, present iff `payment_amount > 0`):
  tacit-asset UTXO opening to `(payment_asset_id, payment_amount, *)`
  paying the old owner.
- **vout[2..]**: change.

### 5.23.3 Validator algorithm

```
on T_SLOT_ROTATE:
  // OLD note: full T_SLOT_BURN-equivalent validation
  perform §5.22.3 validator on (old_merkle_root, old_nullifier_hash,
                                old_recipient_commit, old_r_leaf,
                                old_bind_hash, old_groth16_proof)
    EXCEPT do not decrement supply — supply is conserved across rotation
  
  // NEW slot: full T_SLOT_MINT-equivalent slot verification
  K_btc_new = new_recipient_commit - denom_sats · H
  K_btc_new_xonly = x_only(K_btc_new)
  require tx.vout[0].script_pubkey == OP_PUSHNUM_1 || OP_PUSHBYTES_32 || K_btc_new_xonly
  require tx.vout[0].value == denom_sats
  
  // OPTIONAL payment leg
  if envelope.payment_amount_LE > 0:
    require envelope.payment_asset_id != 0x00..00
    require tx.vout[1] is a well-formed tacit asset UTXO opening to
      (payment_asset_id, payment_amount, *)
  
  // OLD owner sig binds the rotation to new note's terms
  recompute slot_rotate_msg per §5.23.1
  require BIP340_verify(old_owner_pubkey, slot_rotate_msg, old_owner_sig)
  
  if all checks pass:
    insert old_nullifier_hash into spent-set
    append new_leaf_hash to mixer pool for (asset_id, denom_sats)
    slot-registry: mark K_btc_old as REDEEMED; record K_btc_new → new leaf_index
    supply(asset_id) UNCHANGED — conservation
    accept envelope
```

### 5.23.4 Soundness

- **Supply conservation.** One nullifier consumed, one new leaf
  appended. Supply count never changes on rotation.
- **Old owner cannot rug.** After the rotation tx confirms,
  `old_nullifier_hash` is in the spent-set — any subsequent attempt
  to withdraw the same note is rejected. The BTC at `K_btc_old` is
  spent on Bitcoin. The old owner retains knowledge of
  `old_r_leaf`, but it controls nothing further.
- **New owner gets fresh control.** `K_btc_new` is bound to
  `new_r_leaf`, which only the new owner knows (they generated
  `(new_secret, new_ν)` locally).
- **Payment atomicity.** If the payment leg is malformed, the
  envelope is rejected and the entire Bitcoin tx fails to validate
  protocol-side. Bitcoin-side, both parties' signatures are
  required on their respective inputs, so neither side can settle
  without the other.

### 5.23.5 Use cases

- **Trustless OTC sale.** Alice sells a cBTC.zk note to Bob. Bob
  generates new secrets and computes `new_recipient_commit`. Both
  parties construct the rotation tx jointly; Alice signs vin[0],
  Bob signs vin[1] (the payment). Atomic on confirmation.

- **AMM-side trade.** When cBTC.zk is sold into the virtual-AMM
  orderbook (see Trading section below), the maker-taker pair
  composes a T_SLOT_ROTATE rather than a plain T_AXFER_VAR. The
  rotation cost is borne in the trade price.

- **Re-keying for security.** A user worried that their note
  secrets were exposed can rotate to themselves (no payment leg)
  with fresh secrets. Costs one Bitcoin tx; restores fresh
  cryptographic isolation.

### 5.23.6 Free off-chain alternative

T_SLOT_ROTATE is for **trustless** transfers. For low-stakes or
high-trust handoffs, users can simply export `(secret, ν)` to the
recipient out-of-band — same UX as Tornado note handoff. The
recipient can then redeem or rotate at their convenience. This is
free (no Bitcoin tx) but carries the standard seller-trust caveat:
the seller still knows `(secret, ν)` and could race to redeem.
Acceptable for OTC between known parties; not acceptable for
trustless settings.

The dapp surfaces both options at transfer time and warns about
the trust trade-off.

---

## Asset identity

Self-custody-slot wrappers are CETCH-derived assets (§4.1 path 1).
There is **no protocol-canonical cBTC.zk** in this amendment — the
asset is permissionless like any other CETCH. Any party can publish
a wrapper-tagged CETCH with `custody.kind = "self_custody_slot"`
and bootstrap their own variant. The convention pinned in this
amendment guarantees that all such variants behave identically at
the protocol layer.

Conventional tickers:
- `cBTC.zk` — native BTC, 1:1 peg, `denom_sats = 100_000` (≈$50)
- `cBTC.zk.k` — same, `denom_sats = 1_000_000` (≈$500); larger
  denomination for fee efficiency
- `cBTC.zk.m` — same, `denom_sats = 10_000_000` (≈$5000); largest
  tier

Each denomination tier is a distinct CETCH and a distinct mixer
pool with its own anonymity set. The dapp surfaces all tiers and
routes user mints to whichever tier matches their amount.

Future amendments could promote a specific variant to canonical
(protocol-derived asset_id, fourth origin path alongside §6.2's
canonical cBTC) if a single instance becomes dominant.

---

## Trading

For v1, cBTC.zk trades via the existing **direct atomic-intents
machinery** (T_AXFER_VAR — SPEC §5.7.6.1). A holder posts a sell
intent ("I will swap 1 cBTC.zk for X TAC"); a TAC holder fulfills.
The atomic-swap settles in one Bitcoin tx, with the cBTC.zk note
transferred via embedded T_SLOT_ROTATE semantics (rather than
plain UTXO transfer).

**No native AMM-pool integration in v1.** A real `cBTC.zk / TAC`
AMM pool would require the pool to custody cBTC.zk reserves, which
means owning a key over BTC slots, which reintroduces the
federation/operator we just removed. Specifically:

- If the pool's slots are locked under a pool-managed key (single
  party or threshold), that party can drain reserves → reintroduces
  trust.
- If the pool's slots are locked under publicly-derivable keys
  (derived from indexer state), anyone running an indexer can
  derive the private key and drain reserves → no trust at all but
  also no security.
- If the pool's slots are locked under user-LP keys (each user
  retains their own key), the pool is conceptually an aggregation
  of standing intents rather than a constant-function AMM — which
  is exactly the **virtual-AMM-over-orderbook** approach the dapp
  presents.

**Dapp-side virtual AMM.** The dapp aggregates standing intents
into an AMM-shaped UI:

- Bid side: holders' sell intents for cBTC.zk → TAC
- Ask side: LPs' mint intents (BTC + TAC payment ↔ cBTC.zk note)
- The aggregator presents a synthetic order book + virtual mid-price
- On user click, the dapp constructs and broadcasts the matching
  atomic-intent transaction

This delivers AMM-shaped UX without requiring AMM-pool primitives.
Liquidity depth is bounded by standing intent volume — which is
the v1 trade-off for trustlessness.

**Future v1.1 amendment** can specify true AMM-pool integration
with explicit trust trade-offs, allowing users to choose between
trustless-via-orderbook and trust-some-for-deeper-AMM.

---

## Trust model

| Component | Trust assumption |
|---|---|
| Slot binding (K_btc derivation) | secp256k1 discrete log hardness |
| Note ownership (Groth16) | Per SPEC §5.11 — ceremony + circuit soundness |
| Amount binding (Pedersen) | secp256k1 Pedersen binding |
| Pool-state determinism | Per SPEC §11 — indexer rule enforcement |
| Slot consistency | Public chain data; anyone can re-derive |
| Bitcoin chain | Standard Bitcoin consensus |

**Zero issuer trust. Zero co-signer trust. Zero operator trust.**

The single failure mode unique to cBTC.zk: **lost notes lock the
corresponding BTC permanently.** The protocol has no recovery path
because there is no party with the authority to release the slot.
This parallels native Bitcoin (lost keys = lost coins) and is the
structural price of full trustlessness.

Mitigations are operational, not protocol-level:
- Note backup via standard mixer note-export (already shipped)
- Multi-device note replication (dapp UX)
- Note inheritance via shamir-split or social recovery (future)

---

## Privacy model

cBTC.zk inherits the mixer's anonymity-set property and adds two
operational characteristics:

- **Every operation is a mixer op.** Unlike cBTC.tac (which is
  transparent by default), every cBTC.zk mint/redeem/rotate is
  inside the mixer pool. The anonymity set is structurally large.
- **Mint-time link is public.** The slot's `K_btc` is derivable
  from the leaf's `recipient_commit`, so an observer at mint time
  can link the leaf to a specific Bitcoin UTXO and the LP funding
  it. This link does not extend forward through rotations (the
  rotation creates a new leaf with a new `recipient_commit` for a
  new slot).
- **Self-mix discipline.** Users wanting depositor anonymity should
  route the LP-payment leg through fresh wallets / coinjoin —
  same operational hygiene the existing mixer documents.

Compared to cBTC.tac:
- cBTC.zk: every op shielded by the mixer; mint-time link to LP is public
- cBTC.tac: every op transparent on chain; full chain-graph link

Compared to canonical cBTC (§6.2):
- cBTC.zk: mixer-shielded; lost-key risk; no oracle dependency
- §6.2 cBTC: DLC-transparent; user can CSV-rescue; oracle threshold dependency

---

## Bitcoin fee handling

Each protocol operation is a Bitcoin transaction with associated
miner fees:

| Operation | Approx vbytes | Fee @ 10 sat/vB | Fee at denom = 100k sats | Fee at denom = 1M sats |
|---|---|---|---|---|
| T_SLOT_MINT | ~600 vbytes | 6_000 sats | **6.0%** of slot | 0.6% of slot |
| T_SLOT_BURN | ~700 vbytes | 7_000 sats | **7.0%** of slot | 0.7% of slot |
| T_SLOT_ROTATE | ~900 vbytes | 9_000 sats | **9.0%** of slot | 0.9% of slot |

**Implication: pick denomination tiers carefully.** A denom of
100_000 sats (~$50) is uneconomic for repeated trustless rotation;
fee dominates. A denom of 1_000_000 sats (~$500) is workable
(<1% per op). 10_000_000 sats (~$5_000) is the high-tier choice
for low-cost ops.

Variants SHOULD publish at least three tiers so users can choose
their fee-vs-granularity trade-off. Smaller tiers MAY exist for
specific use cases (e.g., dust-level mixing) with documented fee
caveats.

Fee payer per operation:
- **T_SLOT_MINT**: LP funds vin[0]; fee comes from LP's BTC; the
  minter compensates via the tacit-asset payment leg.
- **T_SLOT_BURN**: redeemer's payout (`denom_sats − fee`) absorbs the
  fee directly.
- **T_SLOT_ROTATE**: new owner's payment input typically pays fee;
  details depend on the negotiated rotation terms.

---

## Backwards-compatibility

This amendment does NOT modify any existing wire format, opcode,
domain tag, validator rule, asset_id derivation, or transaction
shape. Specifically:

- **Existing CETCH envelopes unmodified.** A CETCH without
  `tacit_wrapper.custody.kind = "self_custody_slot"` validates
  exactly as before.
- **Existing wrapper instances unaffected.** `cBTC.tac` and other
  federated wrappers behave identically — they use
  `kind = "multisig"`, not the new value.
- **Existing canonical cBTC unaffected.** SPEC §6.2's canonical
  cBTC has its own asset_id origin path; cBTC.zk is CETCH-derived.
  Both coexist.
- **Pre-amendment indexers** see opcodes 0x43–0x45 as unknown
  envelopes (per §4.1 forward-compat); the cBTC.zk asset becomes
  invisible to them but they remain consistent with non-cBTC.zk
  state. Indexers MUST upgrade to recognize the new custody kind +
  opcodes to surface cBTC.zk variants in their wrapper registry.

A daily mainnet canary continues to verify no existing asset's
behavior drifts.

---

## Domain tag additions

Add to §3 *BIP-340 Schnorr signature-message tags*:

- `tacit-slot-mint-v1` — minter's commitment to mint terms (§5.21)
- `tacit-slot-rotate-v1` — old owner's commitment to rotation terms (§5.23)

(`tacit-withdraw-bind-v1` is reused unchanged for T_SLOT_BURN's
bind_hash; it covers the same public-input tuple as a mixer withdraw.)

Add to §3 *opcodes table*:

- `0x43` `T_SLOT_MINT` — atomic mint into self-custody slot (§5.21)
- `0x44` `T_SLOT_BURN` — atomic redeem from self-custody slot (§5.22)
- `0x45` `T_SLOT_ROTATE` — atomic transfer of self-custody slot (§5.23)

Add to §4.2.1 *Custody kinds*:

- `"self_custody_slot"` — per-note BTC UTXO at `K_btc = recipient_commit − denom · H`; no aggregate reserve; no co-signer

---

## Test plan (informative — non-normative)

Implementation PRs landing this amendment MUST include:

1. **Cryptographic alignment test.** Generate random `(secret, ν)`;
   compute `r_leaf = Poseidon₂(secret, ν)`; verify
   `K_btc = r_leaf · G_secp256k1` is a valid secp256k1 point AND
   matches `recipient_commit − denom · H`. At least 100 random
   fixtures with pinned byte-level test vectors.

2. **T_SLOT_MINT validator round-trip.** Construct mint txs across
   denominations (100k, 1M, 10M sats), with and without max_supply
   caps, with valid and intentionally-malformed minter signatures.
   Validator accepts valid; rejects each malformation distinctly.

3. **T_SLOT_BURN validator round-trip.** Construct burn txs with
   valid and invalid Groth16 proofs, valid and invalid Pedersen
   openings, recent vs stale merkle roots, fresh vs replayed
   nullifiers. Validator behaves correctly in each case.

4. **T_SLOT_ROTATE validator round-trip.** With and without payment
   leg, valid and invalid old-owner sigs, supply conservation
   checks before/after.

5. **End-to-end signet flow.** Mint → 3× rotation → redeem on
   signet. Verify chain state matches expected indexer outputs at
   every step. Compare against `axintent-onchain-e2e-signet.mjs`
   harness shape.

6. **Per-slot coverage check.** Wrapper registry queries return
   coverage = 1.0 when all slots present; coverage < 1.0 when a
   slot is missing or has wrong value; coverage "unknown" if
   indexer lacks Bitcoin SPV capability for the slot's height.

7. **Front-running resistance.** Simulate mempool race: legitimate
   tx submitted non-RBF with high fee; attacker tries to substitute
   recipient — verify attacker fails when miners follow standard
   mempool replacement rules.

8. **Reorg safety.** Slot UTXO confirmed at depth < confirmation
   depth (per existing MIXER_DEPOSIT_CONFIRMATION_DEPTH); indexer
   does NOT credit cBTC.zk supply until confirmation depth reached.

9. **Backwards-compat replay.** Snapshot 50 historical mainnet
   CETCH transactions; verdicts before/after the amendment are
   byte-identical. (Same shape as existing replay tests.)

10. **TAC canary.** Existing mainnet canary passes before and after.

---

## What this amendment does NOT specify

Out of scope, deferred to future amendments:

1. **AMM-pool integration with cBTC.zk reserves.** A true
   `cBTC.zk / TAC` AMM pool requires explicit trust trade-offs
   (custody key holder, or accepting weaker security). v1 ships
   virtual-AMM via orderbook of atomic-intents. Future amendment
   can add structured trade-off.

2. **Rune / Ordinal wrappers.** Same primitives apply but `K_btc`
   becomes "the slot key for a rune/ordinal UTXO." Indexers need
   rune-protocol awareness for coverage checks.

3. **Cross-asset slot binding.** A single BTC UTXO backing multiple
   wrapped assets simultaneously (e.g., the same sats backing both
   cBTC.zk and a derivative). Adds protocol surface for marginal
   benefit; not in v1.

4. **Slot migration between denominations.** Splitting a 1M-sat slot
   into 10× 100k-sat slots or merging in reverse. Useful for
   fungibility flexibility; adds protocol surface; deferred.

5. **Fee-subsidized redemption.** Third-party fee payers for redeem
   txs to improve UX (anchor outputs, package relay, miner-direct
   submission). Operational concern, not protocol.

6. **Cooperative-rescue paths.** Mechanisms to recover lost notes
   via threshold of other holders or governance vote. Adds trust
   surface; deferred.

7. **Promotion to canonical asset_id.** If a specific cBTC.zk
   variant achieves dominant network share, a future amendment
   could promote it to protocol-canonical (asset_id origin path
   like §6.2's canonical cBTC).

---

## Open questions for review

1. **Denomination strategy.** Single global denom per `cBTC.zk`
   variant (clean, fragments anonymity set across variants) vs.
   multiple denoms per variant (less fragmentation, more pool
   bookkeeping). Reference recommendation: one CETCH per
   denomination tier (`cBTC.zk`, `cBTC.zk.k`, `cBTC.zk.m`).

2. **Mixer-pool fragmentation.** Each denomination tier creates a
   separate mixer pool — anonymity sets per tier are smaller than
   a unified pool. Mitigation: tier consolidation via dapp routing
   (users prefer the tier matching their amount, building set size
   per tier organically). Open to alternative designs.

3. **Front-running on T_SLOT_BURN.** SPEC mandates non-RBF +
   high-fee broadcast as the v1 mitigation. Should the protocol
   require this explicitly (validator rule: only non-RBF txs are
   indexer-accepted)? Trade-off: stronger guarantee but blocks
   legitimate users who'd accept the front-running risk for fee
   flexibility. Current recommendation: leave as dapp UX nudge,
   not protocol requirement.

4. **Free off-chain rotation vs. T_SLOT_ROTATE.** Free handoff has
   seller-rug risk; rotation costs Bitcoin fees. Some interfaces
   might want to hide the cost by default and warn about the
   trade-off. Where should the default sit? Recommendation: dapp
   defaults to T_SLOT_ROTATE for AMM/orderbook trades, free
   handoff for explicit OTC transfers between known parties.

5. **AMM-pool integration trust trade-off.** Three candidate
   approaches for v1.1: (a) bonded pool operator with slashable
   bond; (b) FROST threshold with rotating set drawn from LP
   bond pool; (c) per-trade ephemeral 2-of-2 between AMM and
   counterparty. Need design comparison.

6. **Slot consolidation / merge.** If a user accumulates many small
   notes through repeated mints, they might want to consolidate
   into fewer larger notes. T_SLOT_ROTATE handles 1:1 transfer but
   not N:1 consolidation. Worth adding T_SLOT_MERGE? Or compose
   via multiple rotations? Recommendation: defer until usage
   patterns inform.

---

## Sign-off checklist for landing

- [x] Initial author draft (this file)
- [ ] Peer-agent review — cryptographic alignment audit
  (r_leaf ↔ K_btc derivation soundness, no security loss from
  embedding BN254 Fr into secp256k1 scalar field)
- [ ] Peer-agent review — front-running attack surface
  characterization
- [ ] Peer-agent review — privacy implications of mint-time
  slot↔leaf link
- [ ] Confirm opcodes `0x43`, `0x44`, `0x45` collision-free against
  the live opcode list (including cUSD amendment's `0x39`–`0x42`
  block)
- [ ] Confirm `tacit-slot-mint-v1` + `tacit-slot-rotate-v1`
  domain tags collision-free against the live §3 list
- [ ] Confirm `"self_custody_slot"` custody-kind value
  collision-free against §4.2 enum
- [ ] Worker indexer-rule implementation PR (separate)
- [ ] Dapp mint/redeem/rotate UX implementation PR (separate)
- [ ] Dapp virtual-AMM trading UX implementation PR (separate)
- [ ] Test fixtures + signet rehearsal PR (separate)
- [ ] First reference `cBTC.zk` CETCH published on signet for
  testing
- [ ] First end-to-end mint → rotate → redeem cycle exercised on
  signet
- [ ] First mainnet `cBTC.zk` CETCH at production denom tier
- [ ] Mainnet canary updated

---

*End of amendment draft.*
