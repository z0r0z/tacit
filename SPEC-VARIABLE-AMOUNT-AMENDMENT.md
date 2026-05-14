# SPEC §5.7 Amendment — Variable-Amount Atomic Intents

> Adds continuous-amount partial-fill semantics to tacit's atomic-
> intent flow via a new opcode `T_AXFER_VAR` (`0x37`). Reuses the
> existing CXFER N=2 cryptography (Pedersen + bulletproofs + kernel
> sig) already in production.
>
> **Scope of unchanged behavior.** This amendment does not change:
> the existing `T_AXFER` opcode (`0x26`), its N=1 semantics, the
> §5.7.3 targeted-recipient flow, the §5.7.6 atomic-intent flow at
> whole-UTXO fill, or any previously confirmed transaction. Every
> existing asset validates identically before and after.

---

## Motivation

`T_AXFER` (§5.7) settles in **one Bitcoin transaction**: maker's asset
input is consumed atomically with the taker's BTC payment. The maker
pre-signs `SIGHASH_SINGLE | ANYONECANPAY` so the taker can complete
without coordination. v1 constrains this settlement to **whole-UTXO
take**: the maker's listed asset UTXO of amount `X` is sold for the
full price `P`; the taker receives `X` tacit; no change output.

For order-book partial fills, the dApp currently uses
**chunked preauth** (§5.7.8 + reference implementation): the maker
pre-splits their UTXO into K equal lots, publishes K listings as a
group, the taker fills any subset. This is the offline-maker partial-
fill path. It works but costs `K × fee` for `K` fills.

What is missing: **online-maker continuous partial fill**. A maker
posts one intent for "up to `X_max` tacit at unit price `P`, minimum
`X_min`"; a taker claims with `requested_amount A ∈ [X_min, X_max]`;
the maker fulfils a single settlement transaction that delivers
exactly `A` to the taker and returns `(X_max − A)` to the maker as
change — all in one Bitcoin transaction, one fee.

This amendment specifies that path.

The cryptographic primitives are not novel. `CXFER` (§5.4) already
produces N=2 outputs (recipient + change) with bulletproof
aggregation over `m=2`, Pedersen commitments closed by a kernel
signature. The same primitives apply here; the new opcode rebrands
the N=2 envelope shape for use with the atomic-intent flow's
fulfilment partial reveal.


## §5.7.9 T_AXFER_VAR (`0x37`) — variable-amount atomic settlement

### Wire format

```
T_AXFER_VAR(2)
   envelope_version  0x01
   opcode            0x37
   asset_id          32 bytes
   asset_input_count 1 byte (= 1 EXACTLY — tightened from T_AXFER's 1..255;
                              see "Why exactly one asset input" below)
   outputs           N=2 (recipient_commit, maker_change_commit)
                     - each: 33-byte compressed Pedersen point (full compressed secp256k1 point,
                       not BIP-340 x-only)
                     - each: 8-byte encrypted-amount ciphertext (HMAC keystream-encrypted u64)
   range_proof       aggregated bulletproof over m=2 commitments
                     (same format as CXFER §3.3.4 with m=2)
   kernel_sig        BIP-340 over kernel_msg, signing key = excess·G's x-only form
                     (same construction as CXFER §5.4.3, parameters m=2)

   On-chain layout (mandatory — different from T_AXFER):
   - vin[0]              = commit P2TR (envelope-bearing taproot script-path spend)
   - vin[1]              = maker's single tacit asset input (signed SIGHASH_SINGLE_ACP)
                           Variable-amount intents are single-UTXO operations;
                           multi-input fulfilment is excluded by the
                           asset_input_count = 1 constraint.
   - vin[2..]            = taker's BTC funding inputs (signed SIGHASH_ALL by
                           taker at completion)
   - vout[0]             = recipient tacit  (DUST P2WPKH(taker_pubkey))
   - vout[1]             = maker BTC payment (sats to maker_address)
                           ← bound to vin[1] by SIGHASH_SINGLE same-index rule.
                           Amount fixed at fulfil time as
                              floor(requested_amount × price_total / amount)
                              where `amount` is the listed UTXO's amount (the
                              implicit max take); see "Intent record additions" below.
   - vout[2]             = maker change tacit (DUST P2WPKH(maker_pubkey))
   - vout[3..3+N_OP]     = OP_RETURN recovery output(s) (§5.7.6.1 *Recovery*)
   - vout[3+N_OP..]      = taker BTC change (added by taker at completion;
                           unbound by maker's sig)

   Validators MUST locate tacit outputs at indices {0, 2}. Any output at
   index 1 is the BTC payment and is NOT a tacit UTXO. This interleaved
   layout is the load-bearing difference vs. T_AXFER, where tacit outputs
   are contiguous from vout[0]. A T_AXFER_VAR envelope under opcode 0x37
   declares this layout unambiguously; an envelope using a different
   layout is invalid under this opcode.
```

### Validator algorithm extension

```
if envelope.opcode == T_AXFER_VAR:
    require envelope.asset_id is well-formed (32 bytes)
    require N == 2 (recipient + maker_change)
    require asset_input_count == 1   // exact; see "Why exactly one asset input"
    require tx.vin.length >= 2        // commit input + asset input minimum
    let asset_input = tx.vin[1]
    let aux_inputs  = tx.vin[2 ..]    // taker's BTC funding; ungoverned

    require asset_input is itself a validateOutpoint() ⇒ true asset UTXO of envelope.asset_id

    require bulletproof verifies over the N=2 output commitments
    require kernel_msg = SHA256(
        "tacit-kernel-v1"
        || asset_id(32)
        || asset_input_count_LE(1)                   // value = 0x01
        || asset_input_outpoint (txid_BE(32) || vout_LE(4))
        || output_commitments_concat(2 × 33B)        // C_recip || C_change
        || burned_amount_LE(8) = 0
    )
    require kernel_sig verifies under (C_recip + C_change − C_listed).x_only

    // Same domain tag and same kernel-msg shape as CXFER (§5.4) and T_AXFER (§5.7.1).
    // The opcode byte is a presentation choice — what aux inputs are allowed and
    // what the off-chain coordination layer looks like — not a cryptographic
    // invariant. A signature for one opcode does NOT verify under another
    // because the asset_input_count and output count differ in the kernel msg.

    // Vouts beyond N-1 are not tacit UTXOs (same rule as T_AXFER §5.7.1).
    // validateOutpoint(reveal_txid, vout >= N) → false.
```

### Why exactly one asset input

`T_AXFER_VAR` constrains `asset_input_count = 1` because:

1. **Variable-amount fills are inherently single-UTXO operations.**
   A maker is partially filling one listed UTXO; consuming multiple
   UTXOs in one settlement doesn't fit the intent shape (the intent
   record pins one `asset_outpoint`).
2. **SIGHASH_SINGLE binding only makes sense at one index.** The
   maker's BTC-payment binding works because `vin[1]` ↔ `vout[1]`
   under SIGHASH_SINGLE's same-index rule. With multiple asset
   inputs, `vin[2]`'s SIGHASH_SINGLE would bind `vout[2]` — which is
   the maker's tacit change output, not a BTC payment. That binding
   is harmless (the kernel sig over output commitments already pins
   `C_change`) but adds spec surface area for no behavioral gain.
3. **Multi-input fulfilment is achievable via pre-consolidation.**
   A maker holding multiple small UTXOs that they want to use for a
   single variable-amount listing can self-CXFER them into one UTXO
   first, then publish the intent against the consolidated UTXO.

This is a deliberate tightening from parent opcodes (`T_AXFER` allows
1..255). Future amendments MAY relax this constraint if a clear use
case emerges, but the current spec keeps the surface minimal.

### Soundness

The N=2 partial reveal inherits CXFER's soundness invariants verbatim
(§5.4.4): the kernel signature binds `(asset_id, asset_inputs,
output_commitments, burned=0)`; the aggregated bulletproof bounds
each output to `[0, 2^64)`; balance equation
`C_recip + C_change − Σ C_in = excess · G` is the same closure as
CXFER. Tampering with any output commitment breaks the kernel sig.
Tampering with any rangeproof element breaks bulletproof verification.

The aux inputs at `vin[1 + asset_input_count..]` are Bitcoin-only and
do not enter the kernel msg. They cannot affect the asset-side
balance equation — identical reasoning to §5.7.1 for `T_AXFER`.

### Comparison with existing opcodes

|                              | CXFER (`0x23`)            | T_AXFER (`0x26`)                                     | T_AXFER_VAR (`0x37`)  |
|------------------------------|---------------------------|------------------------------------------------------|-----------------------|
| Outputs per envelope         | N ∈ {1, 2, 4, 8} (§5.4)   | N ∈ {1, 2, 4, 8} (opcode); N=1 (§5.7.6 intents)     | N = 2 (fixed)         |
| asset_input_count            | 1..255                    | 1..255                                               | = 1 exactly (tightened) |
| Aux non-tacit inputs allowed | no                        | yes                                                  | yes                   |
| Tacit-output vout indices    | [0..N-1] contiguous       | [0..N-1] contiguous                                  | {0, 2} (BTC at vout[1]) |
| Maker pre-signs?             | n/a                       | yes (whole-UTXO at intent-publish)                   | no — signs at fulfil  |
| Change output                | yes (self)                | no                                                   | yes (maker)           |
| Fill semantics               | bilateral                 | whole-UTXO                                           | continuous partial    |
| Cryptography                 | std m-output BP (m≤8)     | std m-output BP (m≤8)                                | std m=2 BP            |

The `T_AXFER_VAR` opcode is not strictly needed for cryptographic
reasons — `T_AXFER`'s wire format already permits `N ∈ {1, 2, 4, 8}`,
so an N=2 envelope under opcode `0x26` would parse and validate. The
new opcode is justified by **layout semantics**: `T_AXFER_VAR` places
the BTC payment output at `vout[1]` (between the recipient tacit at
`vout[0]` and the maker change tacit at `vout[2]`) so that the maker's
`SIGHASH_SINGLE | ANYONECANPAY` signature on `vin[1]` binds the BTC
payment amount under SIGHASH_SINGLE's same-index rule. With contiguous
tacit outputs the BTC payment couldn't be bound by the maker's
asset-side signature, and a malicious taker could redirect the
payment. The new opcode declares this interleaved layout
unambiguously, removes any guesswork on the validator's part, and
keeps the §5.7.6 coordination layer's whole-UTXO semantics under
`T_AXFER` unchanged. **`asset_input_count` is tightened to exactly
`1`** in `T_AXFER_VAR` (vs. `1..255` in parent opcodes) — see
*"Why exactly one asset input"* below for rationale.

`T_AXFER_VAR` reuses every cryptographic primitive already shipped
for CXFER and T_AXFER. No new bulletproof variant, no new kernel-sig
construction, no new domain tag.

---

## §5.7.6.1 Variable-amount atomic intents (coordination layer)

Extends §5.7.6 atomic intents with maker-online continuous partial
fills. The on-chain envelope is `T_AXFER_VAR` (§5.7.9). The
off-chain coordination layer differs from §5.7.6 in three load-
bearing ways:

1. **Commit phase is deferred to fulfilment** (see *Commit-phase
   timing* below). A variable-amount intent record is an
   authenticated off-chain offer; it does not anchor an on-chain
   commit tx at publish time.
2. **Claim carries `requested_amount`** (see *Claim message bump*).
3. **Fulfilment exchanges an unbroadcast commit + a partial
   reveal**; the worker performs the sequential broadcast (see
   *Worker state machine and broadcast policy*).

### Intent record

```
intent {
  intent_id          16 bytes = SHA256("tacit-axintent-id-v1"
                                       || maker_pubkey(33)
                                       || asset_utxo_txid_BE(32)
                                       || asset_utxo_vout_LE(4))[0..16]
                                — deterministic from intent terms;
                                derivable both at publish (worker handle)
                                and from chain data at recovery
                                (vin[1] reveals the asset_utxo outpoint).
  network            "mainnet" | "signet" | "regtest"
  opcode             0x37  (declares T_AXFER_VAR settlement; legacy whole-UTXO
                            intents use 0x26 per §5.7.6 and the existing record
                            shape)
  asset_id           32 bytes
  asset_utxo         { txid, vout, value }  — the maker's listed tacit UTXO
  amount             u64 — listed UTXO's amount in base units (cleartext).
                          Serves as the IMPLICIT max_take_amount for variable
                          fills — a taker can request any amount up to but not
                          exceeding `amount`.
  min_take_amount    u64 — OPTIONAL.
                          Absence  ⇒ whole-UTXO fill (legacy §5.7.6 semantics);
                                     intent uses opcode 0x26 and the record
                                     shape from §5.7.6 (which includes
                                     publish-time commit_txid / envelope_script).
                          Presence ⇒ variable fill; opcode 0x37; commit
                                     deferred per *Commit-phase timing*.
  price_sats         u64 — total price for the full listed `amount`. Per-base-
                          unit pricing scales linearly per *Bounded recipient
                          amount*.
  expiry             u64 — unix-seconds. Worker drops claims after this.
  maker_pubkey       33 bytes (compressed)
  maker_address      string — bech32 BTC payment address for vout[1]
  intent_sig         64 bytes — BIP-340 over intent_msg (see below)
}
```

`intent_msg` binds every field a taker quotes against:

```
intent_msg = SHA256("tacit-axintent-publish-v1"
                   || asset_id || intent_id
                   || asset_utxo_txid_BE(32) || asset_utxo_vout_LE(4)
                                              || asset_utxo_value_LE(8)
                   || amount_LE(8) || price_sats_LE(8)
                   || min_take_amount_LE(8)  // 0x00…00 if absent
                   || expiry_LE(8)
                   || maker_pubkey(33) || H(maker_address)(32)
                   || network_tag(1))
```

Workers MUST verify `intent_sig` under `maker_pubkey` before
accepting the publish. Without the on-chain commit tx as an
anchoring artefact, `intent_sig` is the only binding the worker
holds; a taker downloading the intent record validates the signature
client-side before quoting against it.

The maximum take is **always** the listed UTXO's amount; there is no
separate `max_take_amount` field. A maker who wants to expose only
part of a UTXO for variable fills MUST pre-split via a self-CXFER
first (carving the listed amount out of a larger UTXO), then publish
the intent against the smaller UTXO. This keeps the conservation
invariant trivially consistent — `requested + change == listed` is
the same equation CXFER already enforces.

Validation rules at intent-publish time:

1. If `min_take_amount` absent ⇒ intent is whole-UTXO (legacy §5.7.6).
   On-chain settlement uses `T_AXFER` (`0x26`). Claim format is
   `claim_msg_v2`. Commit tx is broadcast at publish per §5.7.6.
2. If `min_take_amount` present:
   - `1 ≤ min_take_amount ≤ amount` (must be at least 1 base unit;
     must not exceed the listed UTXO's amount).
   - On-chain settlement uses `T_AXFER_VAR` (`0x37`). Claim format
     is `claim_msg_v3` (carries `requested_amount`).
   - **No commit tx is broadcast at publish.** See *Commit-phase
     timing*.

Wire-format observation: an intent record with `min_take_amount ==
amount` is semantically equivalent to a legacy whole-UTXO intent and
SHOULD use `T_AXFER` (`0x26`) on chain rather than `T_AXFER_VAR`.
Implementations MAY refuse to publish variable-amount intents where
`min_take_amount == amount` (degenerate case).

### Commit-phase timing

`T_AXFER` commits the envelope script bytes via a P2TR script-tree
at intent publish time, because the recipient commitment,
ciphertext, kernel sig, and rangeproof are fully determined by the
listed `amount` and the recipient pubkey — both known at publish.

`T_AXFER_VAR` payloads commit to `C_recip` and `C_change`, which
depend on `requested_amount`. The aggregated bulletproof and the
kernel sig (signing under `(r_recip + r_change − r_listed) · G`'s
x-only form) likewise depend on the take split. None of these are
knowable at intent publish — `requested_amount` is taker-chosen at
claim time.

Therefore: **a variable-amount intent's commit tx is constructed
and broadcast at fulfilment, not at publish.** The publish record
is an authenticated off-chain offer; the on-chain commit is created
only after a taker's claim fixes `requested_amount`.

Three invariants survive the timing shift:

1. The taproot-committed envelope bytes remain the canonical
   settlement object. Validators and indexers read one self-
   contained envelope from the script-path reveal — no cross-output
   reconstruction, no aux-OP_RETURN soundness extension.
2. The P2TR commit still commits to the exact settlement bytes; it
   just does so after those bytes become well-defined.
3. The maker's BTC-payment binding via `vin[1]` SIGHASH_SINGLE_ACP
   on `vout[1]` is unchanged.

The maker holds the unbroadcast commit tx until the taker signs the
completed reveal (see *Worker state machine and broadcast policy*),
so an abandoned claim costs the maker no on-chain fee.

A maker chooses between paths based on which trade-offs fit their
posting style. Both paths are first-class and remain available;
omitting `min_take_amount` selects whole-UTXO, supplying it selects
variable-amount:

| Property                              | Whole-UTXO path (§5.7.6, `0x26`) | Variable-amount path (§5.7.6.1, `0x37`) |
|---------------------------------------|----------------------------------|------------------------------------------|
| On-chain advertising of the intent    | Yes (commit_tx visible)          | No (worker record only)                  |
| Maker sunk cost at publish            | ~1700 sats (commit fee + DUST)   | Zero                                     |
| Discoverability via chain alone       | Yes                              | Worker-mediated                          |
| Maker can back out before take        | Only by reclaiming commit P2TR   | Trivially (just don't fulfil)            |
| Settlement tx ancestry                | Reveal references confirmed commit | Reveal references mempool commit       |
| Atomicity                             | Preserved                        | Preserved                                |
| Settlement latency at fulfilment      | One new tx                       | Adds one block of ancestry depth         |
| Continuous partial fills              | No (whole-UTXO only)             | Yes (any `requested ∈ [min, amount]`)    |

### Claim message bump

```
// LEGACY: §5.7.6 whole-UTXO claim
claim_msg_v2 = SHA256("tacit-axintent-claim-v2"
                     || asset_id || intent_id || taker_pubkey
                     || taker_utxo_txid_BE(32) || taker_utxo_vout_LE(4))

// NEW: variable-amount claim
claim_msg_v3 = SHA256("tacit-axintent-claim-v3"
                     || asset_id || intent_id || taker_pubkey
                     || taker_utxo_txid_BE(32) || taker_utxo_vout_LE(4)
                     || requested_amount_LE(8))
```

`requested_amount` MUST satisfy `min_take ≤ requested ≤ max_take`. The
worker rejects claims that violate this bound. Domain version `v3`
distinguishes the new message shape from legacy `v2` claims; a `v2`
signature does not verify as a `v3` message and vice versa.

Legacy intents (no `min_take`) continue to accept `claim_msg_v2`
only. New variable-amount intents accept only `claim_msg_v3`.

### Fulfilment message and partial reveal

```
fulfilment_msg = SHA256("tacit-axintent-fulfilment-v2"
                       || asset_id || intent_id || taker_pubkey
                       || requested_amount_LE(8)
                       || SHA256(partial_reveal_json))
```

The `v2` domain bumps from §5.7.6's `v1` for two reasons: the
partial_reveal payload carries an N=2 `T_AXFER_VAR` envelope
(not the legacy N=1 `T_AXFER` envelope), and `requested_amount` is
explicitly bound into the signature so a worker or taker cannot
silently substitute a different amount even if `partial_reveal_json`
parsing diverges between implementations.

Fulfilment is a four-leg exchange (maker → worker → taker → worker)
followed by sequential broadcast. The legs:

#### 1. Maker prepares (after reading the claim's `requested_amount`)

The maker derives blindings, builds the envelope, and constructs
**both** the commit tx (unbroadcast) and the partial reveal tx
(maker-signed but missing taker funding):

1. **Blindings.**
   - Recipient: `r_recip := r XOR HMAC-SHA256(SHA256(ECDH(maker_priv,
     taker_pub)), "tacit-axintent-blinding-v1" || intent_id ||
     asset_id)` (the per-intent secret `r` is held privately since
     publish — unchanged from §5.7.6).
   - Maker change: `r_change := HMAC-SHA256(maker_priv,
     "tacit-axintent-change-v1" || intent_id || asset_id)`. Self-
     derivable from seed + intent_id at any future time (load-
     bearing for §5.7.6.1 *On-chain recovery*).
2. **Output commitments.**
   - `C_recip  = requested_amount · H + r_recip · G`
   - `C_change = (amount − requested_amount) · H + r_change · G`
     Conservation closure: `requested + (amount − requested) =
     amount` is trivially consistent with the listed-UTXO amount.
3. **Aggregated bulletproof** over `{C_recip, C_change}` per §5.7.9.
4. **Kernel.**
   - `excess = r_recip + r_change − r_listed (mod n)`
   - `kernel_msg = computeKernelMsg(asset_id, [asset_utxo], [C_recip,
     C_change], burned=0)` per §5.4.3.
   - `kernel_sig = SignSchnorr(kernel_msg, excess)` under
     `(excess · G)`'s x-only form.
5. **Envelope.** Encode the `T_AXFER_VAR` payload (opcode 0x37,
   asset_id, asset_input_count=1, kernel_sig, both output records,
   rangeproof) per §5.7.9 *Wire format*. Wrap in the standard
   envelope script under maker's `xonly` internal key.
6. **Commit tx (unbroadcast).** Single-output tx paying
   `DUST + estimated_reveal_fee` to the P2TR address derived from
   the envelope script's leaf hash.
7. **vout layout** — must match the §5.7.9 wire-format block:
   - `vout[0]`: DUST P2WPKH(taker_pub) — recipient tacit UTXO.
   - `vout[1]`: `floor(requested_amount × price_sats / amount)` sats
     to `maker_address` — the maker's BTC payment, scaling linearly
     with the take fraction.
   - `vout[2]`: DUST P2WPKH(maker_pub) — maker's change tacit UTXO.
   - `vout[3]`: `OP_RETURN(0x6a) || OP_PUSHBYTES_80(0x50) ||
     payload_80` — MANDATORY 80-byte dual-recovery payload per
     *On-chain recovery*.
   - `vout[4+]`: taker BTC change (added by taker at completion).
8. **Maker signs the partial reveal.**
   - `vin[0]` (commit P2TR script-path): SIGHASH_SINGLE_ACP, binds
     `vout[0]` (recipient tacit).
   - `vin[1]` (asset UTXO P2WPKH): SIGHASH_SINGLE_ACP, binds
     `vout[1]` (BTC payment to maker_address). A taker cannot
     increase or redirect the BTC payment without invalidating
     this signature.

The maker's change at `vout[2]` is bound by the kernel sig over
`output_commitments` (not by any vin-side sig); tampering with
`C_change` breaks the kernel sig. The OP_RETURN at `vout[3]` is
unbound by the maker's vin[1] sig but is bound by the maker's
SIGHASH_ALL signature over the full partial reveal carried in
`fulfilment_msg_v2`.

#### 2. Maker POSTs the fulfilment to the worker

```
POST /atomic-intents/{asset_id}/{intent_id}/fulfilment

{
  taker_pubkey,
  requested_amount,
  commit_tx_hex,                // unbroadcast
  envelope_script_hex,
  control_block_hex,
  p2tr_spk_hex,                  // derived; redundant but easier for worker
  partial_reveal,                // JSON: inputs[0..1], outputs[0..3], witnesses
  enc_recipient_blinding,        // for legacy takers without OP_RETURN path
  fulfilment_sig                 // BIP-340 over fulfilment_msg
}
```

The worker validates (see *Worker state machine and broadcast
policy*) and transitions the claim to `COMMIT_READY`. **No on-chain
activity has occurred.**

#### 3. Taker downloads, verifies, completes the reveal

The taker fetches the fulfilment, then independently verifies:

- `commit_tx_hex` pays exactly one output to the P2TR address
  derived from `envelope_script_hex` + `control_block_hex` (so the
  maker cannot substitute a different envelope at broadcast).
- The partial reveal's `vin[0]` references `commit_tx_hex`'s
  `txid:0`.
- Maker's SIGHASH_SINGLE_ACP signatures on `vin[0]` and `vin[1]`
  verify.
- Bulletproof + kernel sig verify against the envelope.
- `requested_amount` matches the taker's claim; `C_recip` opens
  correctly under `(requested_amount, r_recip)`.
- `vout[1]` value equals `floor(requested_amount × price_sats /
  amount)`.
- `vout[3]` is the mandatory `OP_RETURN(80)` recovery payload.
- `fulfilment_sig` verifies under `maker_pubkey`.

The taker then appends BTC funding inputs (`vin[2..]`) and any BTC
change output (`vout[4+]`), signs SIGHASH_ALL, and submits the
completed reveal back to the worker.

#### 4. Worker performs sequential broadcast

Once the completed reveal arrives, the worker broadcasts:

1. `commit_tx`. Polls for mempool visibility (≤ ~30s on healthy
   nodes).
2. The completed reveal tx. Spends the unconfirmed commit output
   (CPFP-style); miners package them by ancestor feerate.

The worker rejects the fulfilment at step 2 above if the
**ancestor package feerate** falls below the relay floor plus
safety margin:

```
effective_feerate(commit + reveal)
  = (fee(commit) + fee(reveal)) / (vbytes(commit) + vbytes(reveal))
  ≥ relay_floor + safety_margin
```

The reference implementation samples `mempool.space`'s
`/v1/fees/recommended` at fulfilment time and pads by 10%.

Implementations MAY use BIP-431 package relay (TRUC v3) where
supported to broadcast `(commit, reveal)` atomically; sequential
broadcast remains the mandatory fallback.

### Worker state machine and broadcast policy

Each variable-amount intent transitions through:

```
OPEN
  ↓ taker claim arrives, requested_amount in [min_take, amount]
CLAIMED(taker, requested_amount, ttl)
  ↓ maker POSTs fulfilment (commit_tx + partial_reveal); worker validates
COMMIT_READY
  ↓ taker downloads, completes the reveal, submits to worker
REVEAL_READY
  ↓ worker broadcasts commit_tx
COMMIT_BROADCAST
  ↓ commit_tx visible in mempool
REVEAL_BROADCAST
  ↓ reveal confirmed on chain
SETTLED
```

While `CLAIMED` or any later state, the worker MUST NOT offer the
same `intent_id` to another taker. After `SETTLED`, the asset_utxo
is spent and the intent record is closed.

Time-outs:

| Transition                            | TTL     | On expiry                                  |
|--------------------------------------|---------|---------------------------------------------|
| CLAIMED → COMMIT_READY               | ~5 min  | Revert to OPEN. No on-chain activity yet.   |
| COMMIT_READY → REVEAL_READY          | ~5 min  | Revert to OPEN. No on-chain activity yet.   |
| REVEAL_READY → COMMIT_BROADCAST      | seconds | Worker-internal, near-instant.              |
| COMMIT_BROADCAST → REVEAL_BROADCAST  | ~30s    | Worker logs; commit becomes maker-only UTXO. |

Worker validation at `COMMIT_READY`:

- `intent_sig` was verified at publish; `fulfilment_sig` verifies
  now under `maker_pubkey`.
- `commit_tx_hex` is a well-formed Bitcoin tx with exactly one
  output paying to the P2TR address derived from
  `envelope_script_hex` + `control_block_hex`.
- Partial reveal's `vin[0]` references the commit's `txid:0`.
- Partial reveal's `vin[1]` references `intent.asset_utxo`.
- The reveal's `vout` layout matches §5.7.9 exactly (count, scripts,
  values for `vout[1]`).
- Envelope payload's kernel sig, bulletproof, and commitments
  re-verify under `tacit-bp-v1` + `tacit-kernel-v1`.
- Ancestor package feerate clears the relay floor.

A failed validation at `COMMIT_READY` rejects the POST with a
specific error; the maker re-fulfils. The claim remains valid.

### Anti-griefing properties

A′ broadcast ordering eliminates the worst griefing vector and
bounds the rest:

1. **Taker claims, refuses to complete.** No commit tx is broadcast.
   Maker loses no fee. Claim TTL reverts to `OPEN`.
2. **Maker submits a malformed `commit_tx_hex`.** Worker rejects at
   `COMMIT_READY` validation. No on-chain activity.
3. **Maker submits a commit_tx referring to a phantom outpoint.**
   The taker verifies `commit_tx_hex` bytes hash to the claimed
   `txid` and that the P2TR address derives from `envelope_script`.
   A maker who lies about either is caught client-side before the
   taker signs.
4. **Taker completes the reveal, then RBFs a funding input** between
   worker broadcast of commit and reveal. Identical to `T_AXFER`'s
   exposure today; mitigated by the maker's SIGHASH_SINGLE_ACP
   binding on `vin[1]` to `vout[1]` — the maker's BTC payment cannot
   be redirected, only delayed.

### Garbage collection

If the reveal fails to broadcast after the commit has been broadcast
(network partition, miner policy reject, taker fund double-spend),
the maker is left with a maker-only-spendable P2TR UTXO. This is
identical to `T_AXFER`'s unfulfilled-intent path: the maker spends
the UTXO via the script-path with the maker's recovery leaf per
§5.7.6 *recovery*.

Workers SHOULD log the transition `COMMIT_BROADCAST → ABANDONED`
with the commit outpoint so the maker's UI can surface a "reclaim"
action on the orphaned commit UTXO.

### Claim-term binding

The revealed envelope commits to every term a maker must not be able
to substitute:

| Term                       | Bound via                                                       |
|----------------------------|-----------------------------------------------------------------|
| `requested_amount`         | `C_recip` opening + `fulfilment_msg_v2` domain bind             |
| `r_recip` (recipient blnd) | `C_recip` opening                                               |
| `r_change` (maker blnd)    | `C_change` opening                                              |
| `asset_input` outpoint     | `kernel_msg` + vin[1] SIGHASH_SINGLE_ACP                        |
| BTC payment amount         | `vout[1]` value, bound by vin[1] SIGHASH_SINGLE_ACP             |
| Maker payment output index | `vout[1]` per §5.7.9 wire format                                |
| Recipient pubkey           | `vout[0]` P2WPKH script bytes                                   |
| Protocol version/domain    | `tacit-bp-v1`, `tacit-kernel-v1`, opcode `0x37`                 |
| Expiry / validity          | Intent record's `expiry` field; worker-enforced                 |

### Bounded recipient amount

`requested_amount` ranges over `[min_take_amount, amount]`, where
`amount` is the listed UTXO's amount (the implicit max take; there
is no separate `max_take_amount` field). The maker's BTC payment
scales linearly:

```
payment_sats = floor(requested_amount × price_total / amount)
```

Rounding mode: floor (the taker pays at most one sat less than the
proportional amount; the maker explicitly accepts this rounding loss
when posting the intent — for typical sats-denominated prices and
non-pathological asset decimals the loss is sub-sat).

A maker who refuses sub-unit fills SHOULD set `min_take_amount`
high enough that all valid takes price cleanly. The reference dApp
warns when `floor(price_total × min_take_amount / amount) < DUST`
(i.e., the resulting BTC payment would itself be sub-dust at the
minimum permitted take).

### Privacy considerations

`requested_amount` appears in **plaintext** in `claim_msg_v3` and in
the worker's claim record. This is a deliberate design choice, not
an oversight:

- The recipient commitment (`vout[0]`) remains Pedersen-hidden on
  chain. The maker change commitment (`vout[2]`) likewise.
- The taker's `P2WPKH(taker_pubkey)` address at `vout[0]` is already
  public on chain at settlement time. Any observer can correlate
  "address X received from intent Z" by walking the chain — plaintext
  in the claim leaks no information that isn't otherwise leakable
  post-settlement.
- The worker is already trust-required for claim/fulfilment
  coordination (it gates the claim → fulfilment dance, enforces
  one-claim-at-a-time, GCs stale claims). Encrypting `requested_amount`
  to the maker would not reduce the worker's existing trust surface.
- Adding encryption would force every claim to carry an extra ECDH
  derivation + ciphertext, with no concrete threat-model improvement.

Encrypting `requested_amount` is therefore not mandated. Implementers
who want to add per-claim amount privacy beyond what's already in the
Pedersen-committed outputs MAY layer an additional encrypted-amount
field on top of `claim_msg_v3`, but the canonical wire format and
worker contract do not include one.

The `requested_amount` field is also **bound into `fulfilment_msg_v2`
under domain `tacit-axintent-fulfilment-v2`**, separately from the
`partial_reveal_json` hash. This is defense-in-depth: even though
`requested_amount` is transitively encoded inside the partial reveal,
binding it explicitly in the signature domain makes the maker's
signature harder to misuse if `partial_reveal_json` parsing diverges
between implementations. The v2 domain bump is therefore strictly
preferred over reusing the v1 fulfilment domain.

### On-chain recovery (dual-party, seed-only)

§5.7.6 settled the recipient-side recovery problem with a 40-byte
`OP_RETURN` carrying the encrypted `(amount, r)` opening so the taker
can re-derive their opening from `(taker_priv, chain)` alone after
losing local state. `T_AXFER_VAR` introduces a maker-side recovery
problem that §5.7.6 didn't have: the maker's change opening is
`(listed_amount − requested_amount, r_change)`, and while the maker
can self-derive `r_change` via HMAC under their own privkey, they
**cannot self-derive `requested_amount`** — it's taker-chosen at
claim time, lives only in:

- The taker-encrypted `OP_RETURN` for recipient recovery (maker
  cannot decrypt).
- The worker's `claim_msg_v3` record (24-hour TTL).
- The maker's local cache (lost on wipe).

If the maker loses local state AND the worker has GC'd the claim,
the maker cannot determine the change amount without brute-forcing
the commitment — intractable for u64 amounts. This would re-introduce
the seed-only-recovery exception §5.7.6 just closed for the recipient.

**Resolution: `T_AXFER_VAR` settlements MUST carry an 80-byte
recovery payload split into two 40-byte halves — one ECDH-encrypted
to the taker, one keystream-encrypted to the maker under their own
privkey.** Wire encoding (matches §5.7.6's `script_42` convention):

```
script_82 = OP_RETURN(0x6a) || OP_PUSHBYTES_80(0x50) || payload_80
payload_80 layout:
  bytes[ 0..40]   taker_payload  (recipient recovery — same encoding as §5.7.6)
  bytes[40..80]   maker_payload  (maker change recovery — new for §5.7.6.1)
```

The OP_RETURN output is **mandatory** for every `T_AXFER_VAR`
settlement. A `T_AXFER_VAR` reveal tx without an 80-byte recovery
output at `vout[3]` is invalid: validators MUST reject. (Compare to
§5.7.6 where the 40-byte `OP_RETURN` is optional because the
worker's fulfilment record can supplement; for variable-amount
settlements both parties' recovery depends on the on-chain
payload, so optionality would re-introduce the seed-only-recovery
exception this amendment closes.)

An equivalent split into two separate `OP_RETURN(0x6a) ||
OP_PUSHBYTES_40(0x28) || payload_40` outputs (at `vout[3]` and
`vout[4]`) is **also valid** — Bitcoin standardness allows multiple
data carriers per tx — but the canonical form is the single
`OP_RETURN(80)` above. Indexers MUST accept both forms; payload
ordering (taker first, maker second) is fixed in both.

**Taker payload** (unchanged from §5.7.6):

```
ks_taker_amt   = HMAC-SHA256(SHA256(ECDH(maker_priv, taker_pub)),
                            "tacit-axintent-onchain-amount-v1" || intent_id || asset_id)
ks_taker_blnd  = HMAC-SHA256(SHA256(ECDH(maker_priv, taker_pub)),
                            "tacit-axintent-onchain-blinding-v1" || intent_id || asset_id)
taker_payload  = (requested_amount     XOR ks_taker_amt[0..8])     (8 bytes)
              || (r_recipient_LE32     XOR ks_taker_blnd[0..32])   (32 bytes)
```

**Maker payload** (new):

```
ks_maker_amt   = HMAC-SHA256(maker_priv,
                            "tacit-axintent-onchain-maker-amount-v1" || intent_id || asset_id)
ks_maker_blnd  = HMAC-SHA256(maker_priv,
                            "tacit-axintent-onchain-maker-blinding-v1" || intent_id || asset_id)
maker_payload  = (change_amount_LE     XOR ks_maker_amt[0..8])     (8 bytes)
              || (r_change_LE32        XOR ks_maker_blnd[0..32])   (32 bytes)
where change_amount = listed_amount − requested_amount.
```

The maker's keystream is derived from `maker_priv` alone — no ECDH
needed since the maker is decrypting their own data. The
keystream binds `intent_id` and `asset_id` so a maker_payload from
one settlement cannot be replayed as another.

**External-observer privacy:** both payloads are keystream-encrypted,
so a passive chain observer learns neither `requested_amount` nor
`change_amount` from the `OP_RETURN` alone. They learn no more than
they already learn from the underlying Pedersen commitments.

**Maker recovery flow** (from seed alone, no local state):

1. Maker reimports `maker_priv` on a fresh device.
2. Scans chain for txs where `vin[1].witness[1] == maker_pub`
   (the maker's P2WPKH pubkey on the asset input) **and**
   `vin[0].witness[1]` decodes as a `T_AXFER_VAR` envelope (opcode
   `0x37`) under the commit P2TR script-path leaf.
3. For each such tx: re-derives `intent_id = SHA256("tacit-axintent-
   id-v1" || maker_pubkey || asset_utxo_txid_BE || asset_utxo_vout_LE
   )[:16]` from `vin[1]`'s outpoint (the consumed asset UTXO).
4. Re-derives `ks_maker_amt`, `ks_maker_blnd` per above.
5. Extracts `OP_RETURN(80)`; decrypts the second 40 bytes.
6. Verifies `pedersen_commit(change_amount, r_change) == C_change`
   (the `vout[2]` tacit commitment).
7. If verified, records the change UTXO as spendable.

**On-chain cost.** The 80-byte recovery output is a full vout: 8 B
value + 1 B scriptPubKey length prefix + 82 B scriptPubKey =
**91 bytes / 91 vbytes**. OP_RETURN is non-witness data so the
SegWit ÷4 discount does NOT apply. §5.7.6's single-party 40-byte
recovery output is similarly **51 vbytes** (8 + 1 + 42). Delta vs.
legacy: **~40 vbytes (~400 sats at 10 sat/vB)** — roughly the cost
of one extra typical output. Material for sub-dollar fills,
negligible for typical OTC sizes. The maker bears this cost as part
of the settlement fee; it is paid out of the settlement tx's fee
budget, not deducted from the maker's BTC payment. The recovery
output is mandatory for `T_AXFER_VAR` (no optional-omission path)
because the maker's seed-only recovery depends on it — see
*Resolution* above.

---

## Backwards-compatibility statement

This amendment **does not modify any existing wire format, opcode,
domain tag, message format, or validator rule.** Specifically:

- **Existing CETCH (`0x21`), CXFER (`0x23`), T_MINT, T_BURN, T_AXFER
  (`0x26`), T_PETCH, T_PMINT, T_DEPOSIT, T_WITHDRAW, T_DROP, T_DCLAIM
  envelopes validate identically before and after.** A historical
  replay of every confirmed transaction on mainnet produces the
  same verdict under the amended spec as under the current spec.
- **Existing atomic intents (§5.7.6 whole-UTXO) continue to work
  unchanged.** They use `T_AXFER` (`0x26`) on chain, `claim_msg_v2`
  in the worker, no `min_take` / `max_take` fields. Old dApps and old
  indexers handle them identically to today.
- **Existing preauth sales (§5.7.8) are unaffected.** This amendment
  does not propose variable-amount preauth — that would require
  pre-signing under unknown amounts, which is genuinely novel
  cryptography and is **explicitly out of scope** for this
  amendment.
- **The TAC asset (`f0bbe868…`) is unaffected.** Its CETCH commitment,
  IPFS-pinned attestation, holder UTXOs, transfer history, and
  active listings/intents/bids all retain valid status under the
  amended spec without any code change. Protection is enforced by
  the mainnet canary (`tests/canary-asset-tac-mainnet.test.mjs`).

### Indexer handling of unknown opcodes

Indexers running pre-amendment code encountering a `T_AXFER_VAR`
envelope (opcode `0x37`) MUST treat the transaction's vout outputs
as non-tacit (same rule as for any other unknown opcode per §4.1
*unknown envelopes*). The asset UTXOs flowing through such a
transaction become invisible to the unupgraded indexer; they remain
fully valid under the amended spec and visible to upgraded indexers.

This is the same forward-compatibility model used for `T_PETCH`,
`T_DEPOSIT`, and `T_DROP` when those were introduced. A new opcode
is opaque to old code; behavior degrades gracefully (subset of
transactions are invisible) rather than catastrophically (chain
rejected, asset state corrupted).

### Coordinated rollout

Implementations adopting this amendment MUST:

1. Implement the new validator path for `T_AXFER_VAR` envelopes.
2. Continue accepting all legacy envelope variants without behavioral
   change.
3. Refuse to broadcast `T_AXFER_VAR` settlements until the dApp,
   worker, and reference indexer have all confirmed support.

The reference implementation MUST ship `T_AXFER_VAR` behind a feature
flag (`ENABLE_T_AXFER_VARIABLE`, default `false`) so adopters can
deploy code without observable on-chain effect. The flag SHOULD
remain off until coordinated parser parity is confirmed across:

- Reference dApp.
- Reference worker.
- `tacitscan.io` (or any production third-party indexer).

A daily mainnet canary (`tests/canary-asset-tac-mainnet.test.mjs`)
ensures no upgrade silently drifts the live state of the TAC asset
or any other pinned asset. Crypto-replay canary extensions (planned
for the same test file) will pin per-asset transfer verdicts before
this amendment's code lands.

---

## Test plan (informative — non-normative)

The implementation PR landing this amendment MUST include:

1. **Round-trip envelope encoder/decoder tests** for `T_AXFER_VAR`
   with at least 100 random `(asset_id, requested_amount,
   max_amount)` triples. Pinned byte-level test vectors prevent
   silent encoding drift.

2. **Crypto correctness tests:**
   - Build a `T_AXFER_VAR` envelope with `requested_amount = A`,
     change `= X - A`, for `A` sampled across `{min, min+1, max/2,
     max-1, max}`.
   - Verify bulletproof aggregation over m=2 verifies.
   - Verify kernel sig closes under `excess · G`.
   - Verify `C_recip + C_change − C_listed = excess · G` holds.
   - Negative tests: tampered amounts, mismatched commitments, wrong
     sighash byte each fail validation.

3. **Conservation property test:** for `N` random
   `(amount, requested) where 0 < requested < amount`, the equation
   `requested + (amount - requested) = amount` holds in the
   committed values.

4. **Backwards-compat replay:**
   - Snapshot 50 historical `T_AXFER (0x26)` transactions from
     mainnet.
   - Replay validation under amended spec.
   - Verdicts MUST be byte-identical to pre-amendment.

5. **TAC asset canary:** the existing mainnet canary
   (`tests/canary-asset-tac-mainnet.test.mjs`) passes both before
   and after this amendment lands.

6. **End-to-end signet flow:**
   - Publish a variable-amount intent (`min=100, max=10000`).
   - Claim with three different `requested_amount` values
     (`100`, `5000`, `10000`).
   - Each settles correctly.
   - Maker change UTXO is recoverable from `maker_priv` alone.
   - Recipient UTXO is recoverable from `taker_priv` + chain alone
     (via OP_RETURN(40) recovery payload).

7. **Cross-version compatibility:**
   - Old dApp + new worker: old dApp posts whole-UTXO intent
     (`min_take` absent); worker accepts and stores; old indexer
     validates settlement.
   - New dApp + old worker: new dApp posts variable-amount intent;
     old worker rejects with a clean error code (no silent acceptance
     into legacy whole-UTXO semantics).

---

## Domain tag additions

Add to §3 *Domain labels*:

- `tacit-axintent-id-v1` — content-addressed `intent_id` derivation
  for variable-amount intents (§5.7.6.1 *Intent record*).
- `tacit-axintent-change-v1` — HMAC keystream domain for the maker's
  self-change blinding scalar at fulfilment time (off-chain).
- `tacit-axintent-onchain-maker-amount-v1` — HMAC keystream domain
  for the maker's change-amount ciphertext in the §5.7.6.1
  `OP_RETURN(80)` recovery payload.
- `tacit-axintent-onchain-maker-blinding-v1` — HMAC keystream domain
  for the maker's change-blinding ciphertext in the §5.7.6.1
  `OP_RETURN(80)` recovery payload.

Add to §3 *BIP-340 Schnorr signature-message tags*:

- `tacit-axintent-publish-v1` — maker-signed intent record domain
  for variable-amount publishes (§5.7.6.1 *Intent record*).
- `tacit-axintent-claim-v3` — variable-amount claim message (§5.7.6.1).
- `tacit-axintent-fulfilment-v2` — variable-amount fulfilment message
  (§5.7.6.1).

Add to §3 *opcodes table*:

- `0x37` `T_AXFER_VAR` — variable-amount atomic settlement (§5.7.9).
  First-free opcode after the V2-AMM reservation range (`0x32`–`0x36`,
  reserved by AMM.md for range-LP opcodes); does not collide with
  `T_AMM_ATTEST` (`0x30`) or `T_PROTOCOL_FEE_CLAIM` (`0x31`).

---

## What this amendment explicitly does NOT specify

Out of scope, left for future amendments:

1. **Variable-amount preauth.** Maker-offline continuous partial
   fills require pre-signing under unknown amounts. Possible via
   fan-signing (discrete options) or adaptor signatures (research-
   grade), neither of which is currently in tacit's primitives.
2. **Cross-amount batching.** Settling multiple variable-amount
   claims in a single tx. Possible but requires multi-recipient N>2
   variant; out of scope.
3. **AMM-mediated variable amounts.** The AMM (§5.14–§5.16) already
   has continuous-amount semantics by design — different mechanism,
   different envelope, addressed by AMM.md.

---

## Integration checklist for landing in `SPEC.md`

The following are normative changes downstream of this amendment.

- [ ] Add opcode `0x37` (`T_AXFER_VAR`) to the §1 preamble opcode
  list.
- [ ] Add the new domain tags listed under *Domain tag additions*
  to the §3 canonical domain list.
- [ ] Add `tacit-axintent-claim-v3`, `tacit-axintent-fulfilment-v2`,
  and `tacit-axintent-publish-v1` (the maker-signed intent record
  domain) to §3 BIP-340 signature-message tags.
- [ ] Confirm the new domain tags do not collide with the live §3
  list before merging.
- [ ] Update §4.1 *unknown envelopes* if validator behavior changes
  (this amendment does not change it — unknown opcodes remain
  ignored).
- [ ] Independent crypto review of §5.7.9 kernel-sig + bulletproof
  reuse for `m=2` envelope shape, plus the dual-`OP_RETURN(80)`
  recovery payload encoding.

Implementation milestones (tracked separately from the SPEC merge):

- [ ] Indexer / worker / dApp implementation.
- [ ] Crypto-replay canary extension for `T_AXFER_VAR` envelopes.
- [ ] tacitscan parser parity confirmation.
