# SPEC §5.24–§5.26 Amendment — cBTC.zk Fungibility

> **STATUS: DESIGN DRAFT.** Adds three opcodes to the
> `SPEC-CBTC-ZK-AMENDMENT` envelope family:
> - `T_SLOT_SPLIT` (`0x46`) — atomically split one slot into N smaller
>   slots, ΣD_i = D_old (modulo Bitcoin miner fee).
> - `T_SLOT_MERGE` (`0x47`) — atomically merge N slots into one,
>   D_new = ΣD_i (modulo Bitcoin miner fee).
> - `T_SLOT_NOTE` (`0x48`) — encrypted recipient-detection memo
>   attached to `T_SLOT_ROTATE` (or carried standalone as a memo).
>   Allows the sender to encrypt the new slot's `(secret', ν')` to the
>   recipient's viewing key so their dapp can scan and recognise
>   "this slot is mine" without out-of-band coordination.
>
> The amendment is **structurally additive**: existing T_SLOT_MINT /
> BURN / ROTATE shapes are unchanged. The new opcodes share the same
> trust profile as their predecessors — Groth16 soundness + Pedersen
> binding + secp256k1 hardness + indexer rules. No federation, no
> co-signer, no escape path is introduced at any layer.
>
> **Scope.** Closes the three fungibility gaps surfaced after
> SPEC-CBTC-ZK-AMENDMENT shipped:
>
> 1. Denomination flexibility — users could only mint at the variant's
>    fixed `denom_sats`. SPLIT/MERGE let them move between tier
>    multiples atomically.
> 2. Recipient detection — "Alice rotates to Bob" required out-of-band
>    transmission of `(secret', ν')`. The encrypted note delivery is
>    Sapling-style sender→viewing-key ECDH; recipient scans every
>    rotation and decrypts the ones addressed to them.
> 3. Send-to-specific-recipient UX — without recipient detection, the
>    dapp can't surface "an incoming cBTC.zk transfer is yours". With
>    it, the standard inbound-asset surface (Holdings tab, Activity
>    feed) extends cleanly.
>
> Amount-private partial transfers (sub-denomination transfers with
> bulletproof-hidden amounts) are **out of scope** of this amendment —
> deferred to a separate research-grade amendment (SPEC-CBTC-ZK-SHARES).
> v1.x ships with Tornado-style amount-public, linkability-private
> transfers as the privacy bar.

---

## Motivation

After SPEC-CBTC-ZK-AMENDMENT shipped (T_SLOT_MINT / BURN / ROTATE),
three usability gaps remained:

**Tier rigidity.** Each slot's denomination is fixed at mint time.
A user who mints a 1-BTC slot cannot send 0.01 BTC of it; they'd have
to burn the whole slot and re-mint a smaller tier. Mint+burn each
cost a Bitcoin tx fee, so this is fee-uneconomic for fractional sends.

**No recipient detection.** The sender of a T_SLOT_ROTATE has to
deliver `(secret', ν')` to the recipient out-of-band (Signal, email,
paper). The recipient's dapp can't auto-detect inbound rotations.
Standard tacit assets (T_AXFER_VAR) already solve this with
ephemeral-key ECDH memos; cBTC.zk should do the same.

**No "send to Bob" UX flow.** Without recipient detection, the dapp
can't render a Send form for cBTC.zk that takes a recipient pubkey
and produces a discoverable rotation. The asset effectively only
moves via direct out-of-band coordination — far below the bar set
by every other tacit asset.

This amendment closes these gaps. Together they make cBTC.zk usable
as a transferable, addressable asset in the standard tacit UX, at
the cost of three new opcodes (each cryptographically composable
from existing T_SLOT_MINT / BURN / ROTATE primitives).

---

## §5.24 T_SLOT_SPLIT (`0x46`)

Atomically consume one slot of denomination `D_old` and produce N new
slots whose denominations satisfy `ΣD_new_i = D_old − bitcoin_fee_split`.

### 5.24.1 Wire format (envelope payload)

```
T_SLOT_SPLIT
   opcode              1 byte   (0x46)
   network_tag         1 byte   (0x00=mainnet, 0x01=signet, 0x02=regtest)
   asset_id_old        32 bytes (old slot's wrapper asset_id)
   denom_old_LE        8 bytes  (u64; old slot's denom_sats)
   old_merkle_root     32 bytes (BN254 element; recent root)
   old_nullifier_hash  32 bytes (Poseidon₁(ν_old))
   old_recipient_commit 33 bytes (compressed; old leaf's Pedersen commit)
   old_r_leaf          32 bytes (secp256k1 scalar; revealed in clear)
   old_bind_hash       32 bytes (per SPEC §5.11 — same domain tag as withdraw)
   old_proof_length    2 bytes  (u16 LE; Groth16 proof byte length)
   old_proof           VAR bytes
   n_outputs           1 byte   (u8; 2..16 inclusive — max 16 outputs per split)
   outputs[n_outputs]: each output is
       asset_id_new        32 bytes (NEW slot's wrapper asset_id —
                                     same wrapper family, different
                                     denom variant)
       denom_new_LE        8 bytes  (u64; new slot's denom_sats)
       new_recipient_commit 33 bytes (compressed; new leaf's commit)
       new_leaf_hash       32 bytes (Poseidon₃(secret_i, ν_i, denom_new_i))
   old_owner_pubkey    33 bytes (compressed; binding sig pubkey)
   old_owner_sig       64 bytes (BIP-340 over slot_split_msg)
```

Total payload (n outputs, p bytes proof): **162 + p + n·105** bytes.

```
slot_split_msg = SHA256(
    "tacit-slot-split-v1"
    || network_tag(1)
    || asset_id_old(32)
    || denom_old_LE(8)
    || old_nullifier_hash(32)
    || n_outputs(1)
    || ∥_i (asset_id_new_i || denom_new_LE_i || new_recipient_commit_i || new_leaf_hash_i)
)
```

### 5.24.2 Bitcoin transaction shape

- **vin[0]**: spends the old slot UTXO at `K_btc_old`. Witness is a
  BIP-340 Schnorr key-path sig under `old_r_leaf`, SIGHASH_ALL.
- **vin[1..]** (optional): additional inputs for fee top-up.
- **vout[0..n-1]**: N P2TR outputs, one per new slot. Each output at
  `K_btc_new_i = new_recipient_commit_i − denom_new_i · H` with value
  `denom_new_i`.
- **vout[n..]**: optional change outputs.

**Bitcoin fee budget.** The user must arrange:
`denom_old ≥ ΣD_new_i + bitcoin_fee`. The amendment doesn't specify
WHERE the fee comes from; the user MAY draw it from the slot's value
(losing a tiny amount to fee), or fund it from a separate `vin[1+]`
input.

### 5.24.3 Validator algorithm

```
on T_SLOT_SPLIT:
  require envelope.network_tag matches local network identifier
  require asset_id_old is registered as a self_custody_slot wrapper
  require envelope.denom_old == metadata(asset_id_old).custody.denom_sats
  require n_outputs in [2, 16]

  // Old leaf: full T_SLOT_BURN-equivalent validation
  perform §5.22.3 validator on (old_merkle_root, old_nullifier_hash,
                                old_recipient_commit, old_r_leaf,
                                old_bind_hash, old_proof) — EXCEPT
    do not credit any payout (the value flows into new slots, not user-side BTC).

  // New slots: full T_SLOT_MINT-equivalent slot verification, one per output
  for each i in [0, n_outputs):
    require asset_id_new_i is registered as a self_custody_slot wrapper
    require denom_new_i == metadata(asset_id_new_i).custody.denom_sats
    K_btc_new_i = new_recipient_commit_i − denom_new_i · H
    K_btc_new_i_xonly = x_only(K_btc_new_i)
    require tx.vout[i].script_pubkey == OP_PUSHNUM_1 || OP_PUSHBYTES_32 || K_btc_new_i_xonly
    require tx.vout[i].value == denom_new_i

  // Conservation
  require denom_old ≥ Σ denom_new_i  (Bitcoin pays its own fee)

  // Old owner sig binds split terms
  recompute slot_split_msg per §5.24.1
  require BIP340_verify(old_owner_pubkey, slot_split_msg, old_owner_sig)

  if all checks pass:
    insert old_nullifier_hash into spent-set for (asset_id_old, denom_old)
    for each i: append new_leaf_hash_i to pool (asset_id_new_i, denom_new_i)
    supply conservation: -1 leaf on old pool, +n leaves across new pools
    slot-registry: mark K_btc_old as REDEEMED; record K_btc_new_i → new leaf indices
    accept envelope
```

### 5.24.4 Soundness

- **Conservation.** One old slot consumed (nullifier), N new slots
  appended (leaves). Bitcoin-side: `denom_old ≥ ΣD_new + fee`; the
  difference (if any) is paid as miner fee.
- **Owner cannot reuse.** After the split tx confirms, `old_nullifier_hash`
  is in the spent-set — any subsequent withdraw or rotate of the same
  note is rejected. The BTC at `K_btc_old` is spent on Bitcoin. Old
  `r_leaf` is now public; it controls nothing further.
- **N new owners are self-sovereign.** Each `(secret_i, ν_i)` is
  generated by whoever sets up the split. If the splitter generates all
  new secrets themselves, they hold all N new slots (self-split for
  fungibility). If the splitter generates only some new secrets and
  receives others from intended recipients (or encrypts them via §5.26
  notes), the result is a paid distribution.

### 5.24.5 Use cases

- **Self-fungibility.** A user with a 1M-sat slot who wants to spend
  0.01 BTC creates a 10:1 split into 10× 100k-sat slots. Each new
  100k slot is independently transferable / burnable.
- **Atomic OTC distribution.** Splitter creates N slots, encrypts N
  new secrets to N recipients' viewing keys via §5.26 notes, broadcasts
  one tx. Equivalent to a CXFER multi-recipient transfer but at the
  slot layer.

### 5.24.6 Cross-asset-id rule

`asset_id_new_i` MAY differ from `asset_id_old` ONLY if both wrappers
declare the SAME `underlying` + `peg` (i.e., they wrap the same
underlying chain/asset at the same exchange ratio). This permits
splitting across denomination-tier variants of the same wrapper
family (cBTC.zk-1M → 10× cBTC.zk-100k) but rejects fraudulent
cross-wrapper splits (cBTC.zk → some-other-wrapper).

---

## §5.25 T_SLOT_MERGE (`0x47`)

Atomically consume N slots and produce one new slot. Dual of SPLIT.

### 5.25.1 Wire format (envelope payload)

```
T_SLOT_MERGE
   opcode              1 byte   (0x47)
   network_tag         1 byte
   n_inputs            1 byte   (u8; 2..16 inclusive)
   inputs[n_inputs]: each input is
       asset_id_old        32 bytes
       denom_old_LE        8 bytes
       old_merkle_root     32 bytes
       old_nullifier_hash  32 bytes
       old_recipient_commit 33 bytes
       old_r_leaf          32 bytes
       old_bind_hash       32 bytes
       old_proof_length    2 bytes
       old_proof           VAR bytes
   asset_id_new        32 bytes
   denom_new_LE        8 bytes
   new_recipient_commit 33 bytes
   new_leaf_hash       32 bytes
   new_owner_pubkey    33 bytes (compressed; binds the merge result)
   new_owner_sig       64 bytes (BIP-340 over slot_merge_msg)
```

### 5.25.2 Bitcoin transaction shape

- **vin[0..n-1]**: spends N old slot UTXOs in canonical (txid, vout)
  order. Each input signed by its respective `old_r_leaf_i` under
  SIGHASH_ALL.
- **vout[0]**: new slot P2TR at `K_btc_new = new_recipient_commit −
  denom_new · H` with value `denom_new`.
- **vout[1..]**: optional change.

`Σ denom_old_i ≥ denom_new + bitcoin_fee`. Reverse of split.

### 5.25.3 Validator algorithm

```
on T_SLOT_MERGE:
  require envelope.network_tag matches local network
  require n_inputs in [2, 16]

  for each i in [0, n_inputs):
    require asset_id_old_i registered as self_custody_slot wrapper
    require denom_old_i == metadata.custody.denom_sats
    perform §5.22.3 validator on input i (burn-side)

  require asset_id_new registered as self_custody_slot wrapper
  require denom_new == metadata(asset_id_new).custody.denom_sats
  K_btc_new = new_recipient_commit − denom_new · H
  require tx.vout[0].script_pubkey == OP_PUSHNUM_1 || OP_PUSHBYTES_32 || x_only(K_btc_new)
  require tx.vout[0].value == denom_new
  require Σ denom_old_i ≥ denom_new

  require BIP340_verify(new_owner_pubkey, slot_merge_msg, new_owner_sig)

  if all checks pass:
    for each i: insert old_nullifier_hash_i into spent-set
    append new_leaf_hash to pool (asset_id_new, denom_new)
    supply conservation: -n leaves total across old pools, +1 leaf in new pool
    accept envelope
```

### 5.25.4 Multi-owner merges

When the n old slots have different owners (multi-party merge), each
owner signs their own `vin[i]` under SIGHASH_ALL. The `new_owner_sig`
binds the destination terms; the receiving owner is whoever generated
`(secret_new, ν_new)`.

For trustless OTC merging (e.g., a pooled mint), the receiving party
constructs the envelope, sends each contributor a partially-signed
tx, contributors verify the merge_msg terms + add their signatures,
receiver broadcasts.

---

## §5.26 T_SLOT_NOTE — encrypted recipient detection

Standard Sapling-style sender→receiver ECDH for delivering slot
secrets `(secret', ν')` without out-of-band coordination. Recipients
publish a viewing key once; senders attach an encrypted note to each
T_SLOT_ROTATE (or any T_SLOT_MINT/SPLIT/MERGE that produces a new
slot intended for a different party).

### 5.26.1 Viewing-key model

Recipients derive `sk_view` deterministically from their wallet
privkey via HKDF, so users don't manage a separate viewing key
explicitly:

```
sk_view ← HKDF-Extract(salt = "tacit-slot-note-v1", IKM = wallet.priv)
        ↳ HKDF-Expand(PRK, info = "view" || 0x01, L = 32)
        ↳ reduce mod n_secp256k1 (non-zero)
V       ← sk_view · G   (33-byte compressed)
```

Tradeoff: compromise of `wallet.priv` also compromises `sk_view`. A
v1.x extension can introduce viewer/spender compartmentalisation
(separate `sk_view` managed independently of the spending key); v1
ships with the implicit derivation.

Recipients MAY publish `V` on a per-asset-family basis, or use one
viewing key across all slot wrappers. Standard practice mirrors
Zcash sapling Incoming Viewing Keys.

### 5.26.2 Note encoding

```
encrypted_note (122 bytes fixed):
   ephemeral_pubkey    33 bytes (compressed secp256k1; sender's per-note key)
   ciphertext          89 bytes (AES-256-GCM ciphertext including 16-byte tag)
       plaintext (73 bytes):
           note_kind   1 byte   (0x01 = slot rotate, 0x02 = split output,
                                  0x03 = merge result. Future: 0x04+ reserved.)
           secret      32 bytes
           nullifier_preimage  32 bytes  (= ν')
           amount_hint 8 bytes  (u64 LE; = denom_sats of the target slot —
                                 redundant with chain data but lets the
                                 recipient verify against expected value)
```

Total: **122 bytes**.

### 5.26.3 ECDH + AEAD construction

```
sender side:
  e ← random 32-byte scalar (mod n_secp256k1, non-zero)
  ephemeral_pubkey ← e · G  (compressed, 33 bytes)
  shared_x ← (e · V).x_only()  (32 bytes; the x-coordinate)
  key_material ← SHA256("tacit-slot-note-v1" || shared_x)  (32 bytes)
  iv ← all zeros (12 bytes; ephemeral_pubkey provides per-key uniqueness)
  ciphertext ← AES-256-GCM_encrypt(key=key_material, iv, plaintext, ad="")

recipient side (scan every T_SLOT_ROTATE / SPLIT / MERGE):
  shared_x ← (sk_view · ephemeral_pubkey).x_only()
  key_material ← SHA256("tacit-slot-note-v1" || shared_x)
  plaintext ← AES-256-GCM_decrypt(key_material, iv=zeros, ciphertext, ad="")
  on auth-tag fail: not addressed to me; skip
  on success: recipient now holds (secret, ν, expected_amount). Derive
              r_leaf, recipient_commit, K_btc; verify on-chain UTXO at
              K_btc exists with value = expected_amount.
```

**AES-256-GCM selection.** v1.0 spec'd ChaCha20Poly1305, but
WebCrypto ships AES-GCM in every browser and Node release without a
vendor-bundle dependency. ChaCha20Poly1305 has no WebCrypto entry
and would require a vendor rebuild (`@noble/ciphers` ~30 KB minified).
Both AEADs offer the same security properties (128-bit authenticity,
sub-microsecond per-note decrypt on modern hardware); AES-GCM wins
on cross-platform availability. Reference implementation tested at
`tests/slot-note-encryption.test.mjs` (28 checks: round-trip, tamper
resistance, recipient-mismatch null-return, determinism, u64
amount-hint boundary values, domain separation).

The 12-byte IV is all zeros. Per-note IV uniqueness is required only
*per-key*; since each note has a fresh `key_material` derived from a
fresh `ephemeral_pubkey`, no IV collision is possible across notes
even with a constant IV.

### 5.26.4 Embedding rule

`T_SLOT_NOTE` is **not a standalone opcode**; it's a payload extension
attached to slot-creating envelopes (T_SLOT_ROTATE / T_SLOT_SPLIT /
T_SLOT_MERGE / T_SLOT_MINT-with-recipient). The on-chain encoding adds
a single byte `has_note: 0 | 1` to the host envelope. If `has_note ==
1`, the 122-byte `encrypted_note` blob immediately follows the original
envelope's last byte.

When a single host envelope produces multiple new slots (T_SLOT_SPLIT
with n_outputs > 1), the encoding allows ONE note per output, encoded
as:

```
has_note_per_output    n_outputs bits, packed into ⌈n/8⌉ bytes (LSB first)
encrypted_note[k]      122 bytes, one per output with has_note bit set
```

The host envelope's signed message (`slot_split_msg`, etc.) does NOT
cover the notes' bytes — notes are unauthenticated by the host signer.
This is acceptable because:
- The note's authenticity is established by the AEAD tag (only the
  recipient with `sk_view` can decrypt and recover usable secrets).
- A malicious sender who provides bogus notes can't cause harm beyond
  "recipient cannot find their slot" — which is identical to the
  worst-case in the no-note baseline (out-of-band failure).
- An indexer encountering a malformed note tail simply skips it; the
  host envelope's validation is unaffected.

### 5.26.5 Recipient scanning cost

Each T_SLOT_ROTATE / SPLIT / MERGE confirmed on chain triggers one
attempted decrypt per recipient viewing key. ChaCha20Poly1305_decrypt
on 63 ciphertext bytes is ~0.4 μs on modern hardware; full-chain scan
of ~10⁶ envelopes/year completes in well under a second.

Recipients with multiple viewing keys (compartmentalisation) attempt
each viewing key in turn; cost scales linearly. Browser-based scanning
fits inside a Web Worker, runs in the background between active dapp
sessions.

### 5.26.6 Privacy properties

- **Sender → recipient unlinkability.** The encrypted note reveals
  nothing externally — `ephemeral_pubkey` is random, ciphertext is
  indistinguishable from random bytes. An on-chain observer cannot
  determine which T_SLOT_ROTATE was sent to which recipient.
- **Recipient set is private.** Recipients don't publish their viewing
  keys on chain; they share `V` only with intended senders (or globally
  if they want any party to be able to send to them).
- **Forward secrecy.** Compromise of `sk_view` lets the attacker decrypt
  HISTORICAL notes addressed to that viewing key, but doesn't
  retroactively compromise other recipients' notes or expose the
  underlying `r_leaf` for any slot (which is held by the recipient
  separately).

---

## §5.27 Implementation phases

Stage-gate plan; each phase is independently shippable + compatible
with the next:

| Phase | Deliverable | Depends on | Approx scope |
|---|---|---|---|
| 1 | **Burn flow + reorg recovery** (existing spec, just unwritten code) | none | dapp builder + worker rescan paths |
| 2 | **§5.26 encrypted notes + ROTATE dapp flow** | phase 1 | ~150 LOC dapp, ~30 LOC worker decoder, viewing-key UX |
| 3 | **§5.24 + §5.25 SPLIT/MERGE** | phase 1 | new opcodes, validator extensions, ~400 LOC dapp+worker, ~1 new circuit (or reuse withdraw+mint composed) |
| 4 | **AMM cross-denom pools** (cBTC.zk-100k ↔ cBTC.zk-1M) | AMM launch, phase 3 | LP capital + pool init; no new protocol surface |
| 5 (**deferred**) | **Amount-private sub-denomination transfers** | research amendment | new opcodes + new ZK circuits |

After phase 3, cBTC.zk is a usable transferable wrapped Bitcoin asset
with denomination flexibility, recipient detection, and trustless
self-custody. Phase 4 adds market depth across tiers. Phase 5, if it
ships, completes the "drop-in private BTC token" picture; phase 4
provides most of what most users will care about without it.

## Trust profile

Identical to SPEC-CBTC-ZK-AMENDMENT:

| Component | Trust assumption |
|---|---|
| Slot binding (K_btc derivation) | secp256k1 discrete log hardness |
| Note ownership (Groth16) | Per SPEC §5.11 |
| Amount binding (Pedersen) | secp256k1 Pedersen binding |
| Pool determinism | Indexer rule enforcement |
| Slot consistency | Public chain data |
| Bitcoin chain | Standard Bitcoin consensus |
| **§5.26 note authenticity** | **AEAD soundness (ChaCha20Poly1305)** |

No federation, no oracle threshold, no co-signer at any layer. The
single failure mode shared across all phases remains: **lost notes
lock the corresponding BTC permanently.**

---

## Backwards-compatibility statement

Pre-amendment indexers encountering T_SLOT_SPLIT / MERGE see unknown
opcodes and skip them (SPEC §4.1 forward-compat). Skipping doesn't
corrupt the indexer's state — the slots referenced in the skipped
envelopes remain visible at their pre-split/merge state. When the
indexer upgrades, it re-scans and catches up.

Pre-amendment recipients without viewing keys can still receive slots
via the existing out-of-band `(secret, ν)` handoff path; §5.26 is
strictly opt-in.

The existing T_SLOT_MINT / BURN / ROTATE wire formats are unchanged.
The only legacy-affecting change is the optional `has_note` byte and
trailing encrypted_note bytes when senders opt in to §5.26; decoders
MUST accept envelopes both with and without this trailing data.
