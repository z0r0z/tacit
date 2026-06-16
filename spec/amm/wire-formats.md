# tacit AMM — wire formats and per-circuit detail

This document collects the byte-level wire formats, kernel-message
construction, tip encoding, Groth16 public-input vector, and the
`SPEC.md` cross-reference index for the AMM. It is the implementer
companion to [`AMM.md`](../../AMM.md) (architecture) and
[`SPEC.md`](../../SPEC.md) (canonical wire-format authority).

Where this file and `SPEC.md` differ, `SPEC.md` is canonical.

## Envelope byte layouts

All AMM envelopes ride in `vin[0].witness[1]` as taproot script-path
leaf data, per SPEC §5 (`OP_FALSE OP_IF "TACIT" 0x01 <payload>
OP_ENDIF` wrapping; the payload is what's specified below). Integer
fields are little-endian; secp256k1 / SHA256 byte fields are
big-endian network order; BabyJubJub points are compressed-Edwards
(32 bytes encoding the v-coordinate with the sign of u in the high
bit of the last byte, matching circomlib's `packPoint`).

**T_LP_ADD (`0x2D`), standard variant (variant=0):**
```
opcode(1)                  = 0x2D
variant(1)                 = 0x00
asset_A(32)                # the lexicographically smaller asset_id;
                           # "smaller" = unsigned big-endian byte compare
asset_B(32)                # the larger asset_id
delta_A_LE(8)              # u64, > 0 — public amount of asset A added
delta_B_LE(8)              # u64, > 0 — public amount of asset B added
share_amount_LE(8)         # u64, > 0 — public LP shares minted
share_C_secp(33)           # compressed Pedersen on secp256k1
share_C_BJJ(32)            # compressed BabyJubJub Pedersen
share_xcurve_sigma(169)    # cross-curve binding (§hybrid commitments — 169 B post 128-bit FS upgrade)
kernel_sig_A(64)           # BIP-340 over kernel_msg_A
kernel_sig_B(64)           # BIP-340 over kernel_msg_B
proof_len_LE(2)            # u16
proof(proof_len)           # Groth16 batch proof
```

Fixed-size prefix is `1+1+32+32+8+8+8+33+32+169+64+64+2 = 454` bytes
plus the proof bytes (~256 B Groth16 ⇒ ~710 B total).

**T_LP_ADD (`0x2D`), POOL_INIT variant (variant=1):**
Standard layout above, plus appended at the end (before proof):
```
fee_bps_LE(2)              # u16, 0..1000 (capped at 10%)
vk_cid_len(1)              # u8, 1..64
vk_cid(vk_cid_len)         # IPFS CID, UTF-8 — CIDv1 raw codec, sha2-256.
                           # Resolves to a JSON wrapper bundling the three
                           # circuit vks: {"lp_add", "lp_remove", "swap_batch"}.
                           # Indexers pick the entry matching the opcode and
                           # verify against the integrity-checked wrapper
                           # bytes. Normative in SPEC.md §5.14 + §5.16 step 8.
ceremony_cid_len(1)        # u8, 1..64
ceremony_cid(ceremony_cid_len)  # IPFS CID, UTF-8 — directory CID for the
                                # public ceremony audit bundle (attestation
                                # chains, ptau, pre/post-beacon zkeys).
reserved_count(1)          # u8 — MUST be 0 at v1 (validator rejects
                            #      non-zero). Wire-format slot reserved for
                            #      a follow-up amendment's per-pool payload
                            #      (e.g., T_EXCLUSION_CLAIM slashing-target
                            #      metadata, time-lock-encryption public-key
                            #      reference). At v1 the value is structurally
                            #      not present (the variable-length payload
                            #      below is zero bytes).
reserved_threshold(1)      # u8 — MUST be 0 at v1. Reserved for the same
                            #      follow-up amendment.
reserved_payload(33 * reserved_count)  # variable-length payload — empty at
                                        # v1 since reserved_count==0.
launcher_sig_count(1)      # u8, 0..2 — number of launcher-gate sigs
launcher_sigs(64 * launcher_sig_count)  # BIP-340 each, ordered by
                                        # asset_A's pubkey first
protocol_fee_address(33)   # compressed secp256k1; all-zeros = disabled
protocol_fee_bps_LE(2)     # u16, 0..1000 (= 0..10% of LP-fee growth)
pool_meta_uri_len(1)       # u8, 0..255 (0 = no URI)
pool_meta_uri(pool_meta_uri_len)  # UTF-8 — informational dapp metadata pointer
                                   # (description, logo, IPFS CID, website).
                                   # NEVER consensus-bound; indexer never
                                   # dereferences. Pure dapp UX.
pool_capability_flags(1)   # u8 bitmap of opt-in pool behaviors.
                            # bit 0 (0x01) — LP_ADD requires T_RANGE_ATTEST
                            #                under scope=pool_id (gated mode)
                            # bit 1 (0x02) — POOL_CAP_SOLO_INTENT_ALLOWED:
                            #                permits N=1 SWAP_BATCH. Default
                            #                (bit clear) rejects N=1 to
                            #                preserve amount confidentiality
                            #                (see AMM_MIN_BATCH_SIZE below).
                            # bits 2-7   — reserved for future amendments.
                            # The closest tacit can get to Uniswap V4 hooks:
                            # protocol-defined feature flags, NOT pluggable
                            # executable code.
```
`protocol_fee_address` and `protocol_fee_bps` are founder-set and
immutable. All-zeros address with bps=0 disables the protocol fee
(default); the decoder rejects mismatched (zero address with non-zero
bps, or non-zero address with zero bps). See "Protocol fee mechanism".
The MINIMUM_LIQUIDITY locked LP-share is at `vout[k_min_liq]` where
`k_min_liq = 1` (POOL_INIT's `vout[0]` is the LP-share output for
the founder, `vout[1]` is the MINIMUM_LIQUIDITY lock). The founder's
share at `vout[0]` and the locked share at `vout[1]` are both tacit
UTXOs of `lp_asset_id`; the locked one's recipient is the NUMS
P2WPKH per "MINIMUM_LIQUIDITY burn-output construction".

**T_LP_REMOVE (`0x2E`):**
```
opcode(1)                  = 0x2E
asset_A(32)
asset_B(32)
share_amount_LE(8)         # u64, > 0 — public LP shares burned
delta_A_LE(8)              # u64, public — receipt amount of asset A
delta_B_LE(8)              # u64, public — receipt amount of asset B
recv_A_C_secp(33)
recv_A_C_BJJ(32)
recv_A_xcurve_sigma(169)
recv_B_C_secp(33)
recv_B_C_BJJ(32)
recv_B_xcurve_sigma(169)
kernel_sig_LP(64)          # BIP-340 over kernel_msg_LP
proof_len_LE(2)
proof(proof_len)
```
Fixed prefix: `1+32+32+8+8+8+33+32+169+33+32+169+64+2 = 623` bytes
plus proof. `vout[0]` is the asset-A receipt, `vout[1]` is the
asset-B receipt.

**T_SWAP_BATCH (`0x2F`):**
```
opcode(1)                  = 0x2F
asset_A(32)
asset_B(32)
n_intents(1)               # u8, 1..16
delta_A_net_signed(9)      # 1-byte sign (0=positive A-in, 1=negative)
                           # || 8-byte u64 LE magnitude
delta_B_net_signed(9)      # same encoding
R_net_A(32)                # secp256k1 scalar (BE), aggregate r residual
R_net_B(32)
fee_bps_at_settle_LE(2)    # u16, captured pool.fee_bps at settle height
tip_A_amount_LE(8)         # u64, aggregate asset-A tip
tip_B_amount_LE(8)         # u64, aggregate asset-B tip
tip_A_C_secp(33)           # aggregate asset-A tip commitment
tip_B_C_secp(33)
r_tip_A_LE(32)             # secp256k1 scalar — opening for tip_A_C_secp
r_tip_B_LE(32)             # opening for tip_B_C_secp
# (No optional block at v1. Wire format reserved by AMM.md
# §"Curation-MEV mitigation" — a follow-up amendment that ships
# T_EXCLUSION_CLAIM or time-lock-encrypted intents may add an
# optional appended block here without breaking v1 envelopes.)
# per-intent block, repeated n_intents times in STRICTLY ascending
# intent_id byte-order (duplicates rejected — Bitcoin's UTXO model already
# prevents same-outpoint reuse, but the indexer rejects defensively):
direction(1)               # 0 = A→B (input asset A), 1 = B→A
trader_pubkey(33)
C_in_secp(33)
C_in_BJJ(32)
in_xcurve_sigma(169)
min_out_LE(8)
tip_amount_LE(8)
expiry_height_LE(4)
intent_sig(64)
# per-receipt block, repeated n_intents times in same intent_id order:
C_out_secp(33)
C_out_BJJ(32)
out_xcurve_sigma(169)
# tail:
proof_len_LE(2)
proof(proof_len)           # Groth16 (BN254 / snarkjs) batch proof — NORMATIVE
                           # 256-byte serialization, big-endian field elements:
                           #   pi_a.x(32) || pi_a.y(32)
                           #   pi_b.x_c0(32) || pi_b.x_c1(32) || pi_b.y_c0(32) || pi_b.y_c1(32)
                           #   pi_c.x(32) || pi_c.y(32)
                           # (snarkjs Fp2 limb order [c0, c1].) Verified against the
                           # ceremony vk BOTH browser-side (snarkjs) AND in the
                           # reflection guest (cxfer-core BN254 verifier, over public
                           # signals the guest re-derives from this envelope). A wrong
                           # serialization fails the pairing check — fail-closed, never
                           # an unbacked mint; so this layout is a compatibility
                           # convention between builder + verifier, not a trust root
                           # (the trust roots are the ceremony vk + the in-guest verify).
settler_meta_uri_len(1)    # u8, 0..255 (0 = no URI)
settler_meta_uri(settler_meta_uri_len)  # UTF-8 — informational settler
                                         # metadata pointer (version, identity,
                                         # analytics URL). NEVER consensus-
                                         # bound; indexer does not dereference.
```

Per-intent block is `1+33+33+32+169+8+8+4+64 = 352` bytes; per-receipt
block is `33+32+169 = 234` bytes. For N=16, the per-trader portion
is `(352+234)*16 = 9376` bytes; plus global prefix of ~270 bytes and
proof (~256 bytes) ⇒ ~9.5 KB envelope. Standard tx allows up to
~100 KB, so N up to ~150 fits at the tx layer — the N≤16 cap is
purely a UX-latency choice.

**Bitcoin-tx layout for T_SWAP_BATCH** (normative, indexers reject
deviations):

| Index | Role |
|---|---|
| `vin[0]` | Settler's envelope-bearing input (Taproot script-path) |
| `vin[1+i]` | Trader inputs in `intent_id` ascending byte-order, `i ∈ [0,N)` |
| `vin[N+1..]` | Optional settler BTC funding inputs |
| `vout[0]` | `OP_RETURN(envelope_hash)` — 0 sat, 32-byte data; `envelope_hash = SHA256(payload)` where `payload` is the bytes from the opcode byte through the final byte of `proof` (i.e., the entire payload table above, **excluding** the OP_FALSE/OP_IF/TACIT/0x01 script-wrapping that lives in `witness[1]`'s script bytes) |
| `vout[1+i]` | Trader receipt: dust P2WPKH paying the trader's pre-declared `receive_scriptPubKey` |
| `vout[N+1]` | Aggregate asset-A tip output (dust P2WPKH paying settler) — present iff `tip_A_amount > 0` |
| `vout[N+2]` | Aggregate asset-B tip output (dust P2WPKH paying settler) — present iff `tip_B_amount > 0`. Each tip output is per-side independent: tipA > 0 with tipB = 0 ⇒ only `vout[N+1]` present; both = 0 ⇒ both omitted. |
| `vout[N+3..]` | Optional settler BTC change |

Indexers MUST reject any `T_SWAP_BATCH` whose tx layout deviates,
whose `vout[0]` OP_RETURN data ≠ recomputed `envelope_hash`, or whose
per-intent / per-receipt ordering ≠ `intent_id` ascending byte-order.

## Kernel-msg construction

For T_LP_ADD's two per-asset kernel sigs (one for asset A, one for
asset B). The sig for asset X (X ∈ {A,B}) verifies under
`(Σᵢ C_in_secp,X,i − delta_X · H_secp).x_only()`:

```
kernel_msg_X = SHA256(
    "tacit-amm-lp-add-v1"
    || variant(1)
    || pool_id(32)                          # derived: SHA256("tacit-amm-pool-v1" || asset_A || asset_B || fee_bps_LE || capability_flags)
    || asset_X(32)
    || delta_X_LE(8)
    || share_amount_LE(8)
    || share_C_secp(33)
    || in_count_X(1)                        # number of asset-X UTXOs being consumed
    || (in_txid_BE(32) || in_vout_LE(4))*in_count_X
)
```
Sign with `excess_X = Σᵢ r_in_secp,X,i`. The `variant` byte
distinguishes regular `LP_ADD` (variant=0) sigs from `POOL_INIT`
(variant=1) sigs, so the same bytes can't be replayed across modes.

For T_LP_REMOVE's single kernel sig (one consumed LP-share UTXO
side). Verifies under
`(Σᵢ C_in_secp,LP,i − share_amount · H_secp).x_only()`:

```
kernel_msg_LP = SHA256(
    "tacit-amm-lp-remove-v1"
    || pool_id(32)
    || share_amount_LE(8)
    || delta_A_LE(8)
    || delta_B_LE(8)
    || recv_A_C_secp(33)
    || recv_B_C_secp(33)
    || lp_in_count(1)
    || (lp_in_txid_BE(32) || lp_in_vout_LE(4))*lp_in_count
)
```
Sign with `excess_LP = Σᵢ r_in_secp,LP,i`.

`T_SWAP_BATCH` has no per-`vin` tacit kernel sig — see "Per-`vin`
Bitcoin-layer signature" under Cross-asset authorization for swaps.

## Tip mechanics

Tips flow **from the trader's input side** in v1. The trader's
input UTXO's Pedersen commitment commits to
`a_in_total = amount_in_swap + tip_amount`, where both summands are
> 0. The `tip_asset` field in `intent_msg` MUST equal the trader's
direction.input (asset A for A→B, asset B for B→A); indexers reject
mismatches. The pool's clearing math operates only on
`amount_in_swap`; the `tip_amount` portion of the trader's input
flows directly to the per-asset aggregate tip output.

Concrete encoding:

- **Trader private witness for the Groth16 batch proof:**
  `(amount_in_swap_i, tip_amount_i, r_in_BJJ_i)` per intent. The
  circuit asserts:
  - `C_in_BJJ_i = (amount_in_swap_i + tip_amount_i) · H_BJJ
                  + r_in_BJJ_i · G_BJJ` (BJJ Pedersen opening)
  - `0 ≤ amount_in_swap_i < 2^64`, `0 ≤ tip_amount_i < 2^64`,
    `amount_in_swap_i + tip_amount_i < 2^64` (three range proofs
    per intent at ~3K constraints each)
  - `tip_amount_i == intent_msg.tip_amount` (public input matches
    private witness)
  - The chain-recorded `intent_msg.direction` matches the trader's
    A→B or B→A side, and the public `intent_msg.tip_asset` equals
    direction.input.

- **Settler-published tip output for asset X:**
  - `tip_X_amount = Σ tip_amount_i over traders with direction.input == X`
  - `r_tip_X` is a deterministic scalar derived as
    `HMAC-SHA256(settler_privkey,
                  "tacit-amm-tip-blind-v1"
                  || pool_id
                  || asset_X
                  || envelope_anchor) mod n_secp`,
    where `envelope_anchor = SHA256(opcode_byte || asset_A || asset_B
    || n_intents || sorted intent_ids concatenated)`.
    The settler can recover and spend the tip output from privkey
    alone. Indexers don't need to verify the settler's privkey
    knowledge; the soundness of the tip output (it commits to the
    cleartext `tip_X_amount`) is enforced by publishing both
    `tip_X_amount_LE` and `r_tip_X_LE` in the envelope and
    verifying `pedersenCommit(tip_X_amount, r_tip_X) == tip_X_C_secp`
    out-of-circuit.

- **Chain-side aggregate Pedersen check (per asset X):**

  ```
  Σ_{X→Y traders} C_in_secp,i
      − Σ_{Y→X traders} C_out_secp,i
      − tip_X_C_secp
      − delta_X_net_signed · H_secp
  ==  R_net_X · G_secp
  ```

  where `delta_X_net_signed = (Σ amount_in_swap_X) − (Σ amount_out_X)`,
  positive when X flows into the pool. Tips never enter `delta_X_net`
  — they're explicitly subtracted as a separate term. `R_net_X` is
  the corresponding aggregate-blinding residual the settler reveals.

This keeps the tip mechanism honest: the trader's `intent_sig`
commits to `tip_amount`, the circuit binds the input commitment to
`amount_in_swap + tip_amount`, the chain check subtracts the tip
output, and the settler can't pocket more than the declared tip
without invalidating the Pedersen balance.

## Groth16 public-input vector

The batch circuit's `vk` is fixed at compile time for a maximum
batch size `N_MAX = 16`. Batches with `n_intents < N_MAX` pad
unused slots with the BabyJubJub identity `(0, 1)` and zero
amounts/tips/directions/min_outs — all in-circuit constraints
hold trivially for that exact pattern, so the circuit always
evaluates all 16 slots. The public-signals array (decimal-string
BN254 Fr elements, passed to `snarkjs.groth16.verify`) is **123
signals** total, ordered exactly as circom emits them: scalar
globals first, then each declared `signal input` array flattened
contiguously in the order it appears in the template's signal
declarations (`direction → C_in_BJJ_u → C_in_BJJ_v → min_out →
tip_amount → C_out_BJJ_u → C_out_BJJ_v`):

```
publicSignals[0]   = pool_id_fr                     # SHA256(pool_id) mod p_Fr
publicSignals[1]   = R_A_pre
publicSignals[2]   = R_B_pre
publicSignals[3]   = delta_A_net_sign               # 0 = positive (A-dom or spot), 1 = negative (B-dom)
publicSignals[4]   = delta_A_net_magnitude          # u64
publicSignals[5]   = delta_B_net_sign
publicSignals[6]   = delta_B_net_magnitude          # u64
publicSignals[7]   = tip_A_amount
publicSignals[8]   = tip_B_amount
publicSignals[9]   = fee_bps                        # 0..1000 (in-circuit cap via LessThan(11) vs 1001)
publicSignals[10]  = n_intents                      # 0..31, public hint; indexer matches signed intents
# Per-array flattening (16 elements each, i ∈ [0, N_MAX=16)):
publicSignals[11  + i] = direction_i                # 0 = A→B, 1 = B→A
publicSignals[27  + i] = C_in_BJJ_u_i
publicSignals[43  + i] = C_in_BJJ_v_i
publicSignals[59  + i] = min_out_i
publicSignals[75  + i] = tip_amount_i               # binds in-circuit tip_amount_witness to intent_msg.tip_amount
publicSignals[91  + i] = C_out_BJJ_u_i
publicSignals[107 + i] = C_out_BJJ_v_i
```

For N_MAX=16: `11 + 7·16 = 123` public signals. (Dropped
`S_pre` in the optimization pass — it was a range-checked public
input that didn't bind to any pool state in-circuit; cross-pool
replay protection comes from `pool_id_fr`. The indexer can still
cross-check `pool.lp_total_shares` against chain state separately.) Padded
intents (i ≥ n_intents) use `direction=0, C_in_BJJ=(0,1),
min_out=0, tip_amount=0` (BJJ identity is the only valid u/v pair
for an inactive opening — `(0, 0)` is off-curve and would fail
the in-circuit constraint). Padded receipts use `C_out_BJJ=(0,1)`
similarly. All in-circuit constraints (range checks, Pedersen
openings, division-with-remainder, min_out, aggregate tip sum)
hold trivially under this padding convention.

The by-array ordering matches the witness-index layout that
circom 2.1.6 emits (see `dapp/circuits/amm/build/amm_swap_batch.sym`),
so `snarkjs.groth16.verify(vk, buildPublicSignalsSwapBatch(env,
pool), proof)` lines up byte-for-byte with the prover's
`public.json`. Reference impl: `buildPublicSignalsSwapBatch` in
`tests/amm-validator.mjs`.

Reference impl: `dapp/circuits/amm/amm_swap_batch.circom`. Witness
generation + adversarial tests in `dapp/circuits/amm/witness-test.mjs`
and `dapp/circuits/amm/adversarial-test.mjs` (32 cases). Pre-ceremony
review at `dapp/circuits/amm/REVIEW.md`. Drift guard (catches any
post-ceremony source change) at `dapp/circuits/amm/drift-guard.test.mjs`.

For LP_ADD / LP_REMOVE the circuit and `vk` are different
(per-op circuit, not shared with swap). Their public-input
vectors are smaller and pool-op-specific; spec the same way at
implementation time.

## SPEC.md cross-reference

| Topic | SPEC.md section |
|---|---|
| BabyJubJub primitives + NUMS generators | §3.9 |
| Sigma cross-curve binding (Camenisch-Stadler, 169 B, 128-bit FS) | §3.10 |
| LP-share asset-id origin path | §4.1 |
| Validator dispatcher branches for all six AMM opcodes | §5.5 |
| `T_LP_ADD` (`0x2D`) wire format + validator | §5.14 |
| `T_LP_REMOVE` (`0x2E`) wire format + validator | §5.15 |
| `T_SWAP_BATCH` (`0x2F`) wire format + validator | §5.16 |
| `T_INTENT_ATTEST` (`0x30`) preconfirmation channel attestation | §5.17 |
| `T_PROTOCOL_FEE_CLAIM` (`0x31`) protocol-fee mint | §5.18 |
| `T_SWAP_VAR` (`0x32`) per-trade variable-amount swap | §5.20 |
| AMM determinism rules (rounding, clearing solve, reorg, JCS) | §11.4 |
| AMM receipt-recovery HMAC seeds (per asset, per receipt) | §6 path 10 |
