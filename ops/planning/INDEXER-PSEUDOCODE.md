# Indexer Reference Pseudocode

> Status: 🛠️ Implementation-grade pseudocode for tacit V1
> indexer dispatch. Maps line-by-line to concrete code.
>
> Scope: per-opcode validator algorithms + state transitions for
> all V1 AMM opcodes + channel layer + future T_TRADE_BATCH.
> More detailed than the snippets embedded in
> `IMPLEMENTATION-ROADMAP.md`; engineers translate this directly
> to their target language (Rust, Go, Python, JS).
>
> Spec authority for correctness: SPEC.md + AMM.md + amendment
> files. This doc is the translation layer; if it diverges from
> spec, spec wins.

---

## Common indexer state

```
IndexerState {
    pools:                Map<pool_id, PoolState>
    intent_records:       Map<intent_id, IntentRecord>
    attestation_chain:    Map<(scope_id, worker_pubkey, observed_height), Attestation>
    equivocation_flags:   Set<worker_pubkey>
    consumed_outpoints:   Set<(txid_BE, vout)>      // double-spend nullifier
    consumed_nullifiers:  Set<bytes32>               // mixer-style
    lp_share_supply:      Map<lp_asset_id, u64>
    fulfilment_registers: Map<intent_id, FulfilmentRecord>  // partial-fill tracking
    chain_tip:            (block_height, block_hash)
    asset_utxos:          Map<outpoint, AssetUtxo>
}

PoolState {
    asset_A:               bytes32
    asset_B:               bytes32
    fee_bps:               u16
    R_A:                   u64
    R_B:                   u64
    S:                     u64
    k_last:                u256     // for protocol fee lazy mintFee
    protocol_fee_accrued:  u64
    protocol_fee_address:  bytes33 (or zeros if disabled)
    protocol_fee_bps:      u16
    vk_cid:                string
    ceremony_cid:          string
    min_liquidity:         u64
    inclusion_arbiter_pubkeys: Set<bytes33> (optional)
    init_height:           u32
}
```

## Error codes (canonical)

Every rejection MUST return one of these codes. Cross-impl parity
testing checks that both impls reject with the same code for the
same input.

```
enum RejectionReason {
    // Structural
    INVALID_OPCODE,
    MALFORMED_ENVELOPE,
    INVALID_FIELD_LENGTH,
    INVALID_SCRIPT_PUBKEY,

    // Crypto
    INVALID_SIGNATURE,
    INVALID_BULLETPROOF,
    INVALID_GROTH16_PROOF,
    INVALID_SIGMA_PROOF,
    INVALID_PEDERSEN_COMMIT,
    INVALID_KERNEL_SIG,
    INVALID_INTENT_SIG,
    INVALID_KERNEL_MSG,
    INVALID_INTENT_MSG,

    // Consensus / state
    UNKNOWN_POOL,
    UNKNOWN_INTENT,
    INVALID_RESERVES,
    STALE_RESERVES,
    EQUIVOCATION_DETECTED,
    DUPLICATE_OUTPOINT,
    DUPLICATE_NULLIFIER,
    POOL_ALREADY_EXISTS,
    INSUFFICIENT_LIQUIDITY,
    EXPIRED,

    // AMM math
    SLIPPAGE_VIOLATION,
    RANGE_VIOLATION,
    CURVE_MISMATCH,
    RECEIPT_BINDING_VIOLATION,
    CLEARING_SOLVE_MISMATCH,
    MIN_OUT_VIOLATION,
    CHAIN_AGGREGATE_VIOLATION,

    // Tip mechanics
    TIP_OPENING_MISMATCH,
    TIP_AMOUNT_MISMATCH,

    // Reorg
    REORG_INVALIDATION,

    // Authorization
    UNAUTHORIZED_CLAIM,
    UNAUTHORIZED_DELETE,

    // Misc
    FUTURE_HEIGHT,
    EXPIRY_OVERLAP,
}
```

## Common helpers

```
function verify_schnorr_bip340(sig: bytes64, msg: bytes32, pubkey_xonly: bytes32) -> bool
function sha256(bytes: Buffer) -> bytes32
function hmac_sha256(key: Buffer, data: Buffer) -> bytes32
function point_add(P: SecpPoint, Q: SecpPoint) -> SecpPoint
function point_mul(s: Scalar, P: SecpPoint) -> SecpPoint
function H_secp(): SecpPoint                       // NUMS generator per SPEC.md §3.1
function G_secp(): SecpPoint                       // standard secp generator
function bulletproof_verify(proof: bytes, commits: SecpPoint[], n_bits: u32) -> bool
function groth16_verify(proof: bytes, public_inputs: Scalar[], vk: VerifierKey) -> bool
function sigma_xcurve_verify(proof: bytes157, C_secp: SecpPoint, C_bjj: BJJPoint) -> bool
function get_running_pool_state(pool_id, before_tx_index_in_block) -> PoolState
```

---

## Opcode `0x30`: T_INTENT_ATTEST

**Spec:** SPEC.md §5.17.

```
function validate_intent_attest(env: Envelope, tx: BitcoinTx, state: IndexerState)
    -> ValidationResult:

    # Step 1: Structural decoding
    if env.opcode != 0x30: return reject(INVALID_OPCODE)
    if env.envelope_version != 0x01: return reject(MALFORMED_ENVELOPE)

    fields = decode_payload(env.bytes)
    if fields is null: return reject(MALFORMED_ENVELOPE)

    let scope_id          = fields.scope_id            # 32 bytes
    let intent_pool_hash  = fields.intent_pool_hash    # 32 bytes
    let observed_height   = fields.observed_height_LE  # u32
    let timestamp         = fields.timestamp_LE        # u64
    let intent_count      = fields.intent_count_LE     # u16
    let snapshot_uri      = fields.snapshot_uri        # variable UTF-8
    let worker_pubkey     = fields.worker_pubkey       # 33 bytes compressed
    let worker_sig        = fields.worker_sig          # 64 bytes BIP-340

    if length(scope_id) != 32: return reject(INVALID_FIELD_LENGTH)
    if length(worker_pubkey) != 33: return reject(INVALID_FIELD_LENGTH)
    if length(worker_sig) != 64: return reject(INVALID_FIELD_LENGTH)

    # Step 2: Worker sig verification
    let preceding_fields = encode_preceding(fields)  # everything before worker_sig
    let canonical_msg = sha256("tacit-intent-attest-v1" || preceding_fields)
    let worker_pubkey_xonly = worker_pubkey[1:33]  # strip y-parity byte
    if not verify_schnorr_bip340(worker_sig, canonical_msg, worker_pubkey_xonly):
        return reject(INVALID_SIGNATURE)

    # Step 3: Future-height check
    if observed_height > tx.block_height:
        return reject(FUTURE_HEIGHT)

    # Step 4: Equivocation detection
    let key = (scope_id, worker_pubkey, observed_height)
    let existing = state.attestation_chain.get(key)
    if existing is not null:
        if existing.intent_pool_hash != intent_pool_hash:
            state.equivocation_flags.add(worker_pubkey)
            return reject(EQUIVOCATION_DETECTED)
        else:
            # Idempotent re-attestation of same hash; accept silently
            return accept(state_delta = null)

    # Step 5: Accept + record
    let new_attestation = Attestation {
        intent_pool_hash,
        observed_height,
        timestamp,
        snapshot_uri,
        intent_count,
    }
    return accept(state_delta = {
        attestation_chain.insert(key, new_attestation)
    })
```

**State transition on accept:**
```
state.attestation_chain[scope_id, worker_pubkey, observed_height] = new_attestation
```

**No mutation of:** pool state, asset UTXOs, intent records. Pure
commitment-only opcode.

---

## Opcode `0x32`: T_SWAP_VAR

**Spec:** SPEC-SWAP-VAR-AMENDMENT.md.

```
function validate_swap_var(env: Envelope, tx: BitcoinTx, state: IndexerState)
    -> ValidationResult:

    # Step 1: Structural decoding
    if env.opcode != 0x32: return reject(INVALID_OPCODE)

    fields = decode_swap_var_payload(env.bytes)
    if fields is null: return reject(MALFORMED_ENVELOPE)

    let pool_id              = fields.pool_id              # 32 bytes
    let direction            = fields.direction            # 0 or 1
    let R_A_pre              = fields.R_A_pre              # u64 (trader-observed)
    let R_B_pre              = fields.R_B_pre              # u64
    let delta_in             = fields.delta_in             # u64
    let delta_in_min         = fields.delta_in_min         # u64
    let delta_in_max         = fields.delta_in_max         # u64
    let delta_out            = fields.delta_out            # u64
    let min_out              = fields.min_out              # u64
    let tip_amount           = fields.tip_amount           # u64
    let tip_asset            = fields.tip_asset            # 0 or 1
    let expiry_height        = fields.expiry_height        # u32
    let trader_pubkey        = fields.trader_pubkey        # 33 bytes
    let C_in_secp            = fields.C_in_secp            # 33 bytes
    let C_change_or_sentinel = fields.C_change_secp        # 33 bytes (may be 33×0x00 sentinel)
    let C_receipt_secp       = fields.C_receipt_secp       # 33 bytes
    let r_receipt            = fields.r_receipt            # 32 bytes scalar
    let range_proof          = fields.range_proof          # ~700 bytes m=2 BP
    let kernel_sig           = fields.kernel_sig           # 64 bytes
    let intent_sig           = fields.intent_sig           # 64 bytes

    # Step 2: Basic field checks
    if direction not in {0, 1}: return reject(MALFORMED_ENVELOPE)
    if tip_asset not in {0, 1}: return reject(MALFORMED_ENVELOPE)
    if tip_asset != direction:
        # Per amendment: tip_asset MUST equal direction.input_asset
        return reject(MALFORMED_ENVELOPE)

    # Step 3: Pool exists
    let pool = state.pools.get(pool_id)
    if pool is null: return reject(UNKNOWN_POOL)

    # Step 4: Expiry check
    if tx.block_height > expiry_height: return reject(EXPIRED)

    # Step 5: Range bounds
    if delta_in < delta_in_min: return reject(RANGE_VIOLATION)
    if delta_in > delta_in_max: return reject(RANGE_VIOLATION)
    if delta_in == 0: return reject(MALFORMED_ENVELOPE)

    # Step 6: Reserves freshness gate (against running pool state)
    let running_state = get_running_pool_state(pool_id, immediately_before = (tx.block_height, tx.tx_index))
    if running_state.R_A != R_A_pre: return reject(STALE_RESERVES)
    if running_state.R_B != R_B_pre: return reject(STALE_RESERVES)

    # Step 7: Curve recompute (deterministic)
    let γ_num = 10000 - pool.fee_bps
    let γ_den = 10000

    let (delta_out_expected, R_A_post, R_B_post) =
        if direction == 0:  # A → B
            num = (u256) R_B_pre * γ_num * delta_in
            den = (u256) R_A_pre * γ_den + (u256) γ_num * delta_in
            d_out = (u64)(num / den)
            (d_out, R_A_pre + delta_in, R_B_pre - d_out)
        else:               # B → A
            num = (u256) R_A_pre * γ_num * delta_in
            den = (u256) R_B_pre * γ_den + (u256) γ_num * delta_in
            d_out = (u64)(num / den)
            (d_out, R_A_pre - d_out, R_B_pre + delta_in)

    if delta_out != delta_out_expected: return reject(CURVE_MISMATCH)
    if delta_out < min_out: return reject(MIN_OUT_VIOLATION)
    if R_A_post <= 0 or R_B_post <= 0: return reject(INSUFFICIENT_LIQUIDITY)

    # Step 8: Receipt-binding check (CRITICAL — defends against inflation attack)
    let C_receipt_expected = point_add(
        point_mul(delta_out, H_secp()),
        point_mul(r_receipt, G_secp())
    )
    if C_receipt_secp != C_receipt_expected:
        return reject(RECEIPT_BINDING_VIOLATION)

    # Step 9: Identity-point sentinel handling
    let C_change_point =
        if C_change_or_sentinel == [0x00; 33]:
            point_at_infinity()  # special-case BEFORE secp decoder
        else:
            decode_secp_point(C_change_or_sentinel)
            if decode failed: return reject(INVALID_PEDERSEN_COMMIT)

    # Step 10: Asset-input outpoint verification
    let asset_input = tx.vin[1]
    if asset_input.outpoint != fields.asset_input_outpoint:
        return reject(MALFORMED_ENVELOPE)
    if state.asset_utxos.get(asset_input.outpoint) is null:
        return reject(MALFORMED_ENVELOPE)
    if state.asset_utxos[asset_input.outpoint].asset_id != (direction == 0 ? pool.asset_A : pool.asset_B):
        return reject(MALFORMED_ENVELOPE)

    # Step 11: Verify intent_sig
    let intent_msg = sha256(
        "tacit-amm-swap-var-v1" ||
        pool_id || direction || delta_in_LE || delta_in_min_LE || delta_in_max_LE ||
        delta_out_LE || min_out_LE || tip_amount_LE || tip_asset ||
        expiry_height_LE || trader_pubkey || asset_input_outpoint ||
        receipt_scriptPubKey || C_receipt_secp || C_change_or_sentinel
    )
    let trader_pubkey_xonly = trader_pubkey[1:33]
    if not verify_schnorr_bip340(intent_sig, intent_msg, trader_pubkey_xonly):
        return reject(INVALID_INTENT_SIG)

    # Step 12: Verify kernel_sig (asset-A balance closure)
    let delta_in_total = delta_in + tip_amount
    let C_in_point = decode_secp_point(C_in_secp)
    if C_in_point is null: return reject(INVALID_PEDERSEN_COMMIT)

    let P = point_add(
        C_change_point,
        point_add(
            point_negate(C_in_point),
            point_mul(delta_in_total, H_secp())
        )
    )  # P = C_change_or_sentinel − C_in + delta_in_total · H_secp
    let P_xonly = P.x_only()

    let asset_id_in = (direction == 0 ? pool.asset_A : pool.asset_B)
    let kernel_msg = sha256(
        "tacit-kernel-v1" ||
        asset_id_in || u8(0x01) ||
        asset_input_outpoint ||
        C_change_or_sentinel ||
        delta_in_total_LE
    )
    if not verify_schnorr_bip340(kernel_sig, kernel_msg, P_xonly):
        return reject(INVALID_KERNEL_SIG)

    # Step 13: Verify m=2 bulletproof
    if not bulletproof_verify(range_proof, [C_change_point, decode_secp_point(C_receipt_secp)], 64):
        return reject(INVALID_BULLETPROOF)

    # Step 14: Tip mechanic
    if tip_amount > 0:
        if length(tx.vout) < 4: return reject(MALFORMED_ENVELOPE)
        let tip_vout = tx.vout[3]
        let tip_commit = extract_tip_commit_from_vout(tip_vout)
        let r_tip = fields.r_tip   # published in envelope
        let expected_tip_commit = point_add(
            point_mul(tip_amount, H_secp()),
            point_mul(r_tip, G_secp())
        )
        if tip_commit != expected_tip_commit:
            return reject(TIP_OPENING_MISMATCH)

    # Step 15: OP_RETURN binding (envelope_hash check)
    if tx.vout[0].is_op_return == false: return reject(MALFORMED_ENVELOPE)
    let envelope_hash = sha256(env.bytes)
    if tx.vout[0].data != envelope_hash:
        return reject(MALFORMED_ENVELOPE)

    # Step 16: Apply state transition
    return accept(state_delta = {
        pool.R_A = R_A_post
        pool.R_B = R_B_post
        pool.k_last = R_A_post * R_B_post     # for lazy mintFee
        consumed_outpoints.add(asset_input.outpoint)
        emit_asset_utxo(tx.vout[1], asset_id = (direction == 0 ? pool.asset_B : pool.asset_A),
                        commit = C_receipt_secp)
        if C_change_or_sentinel != [0x00; 33]:
            emit_asset_utxo(tx.vout[2], asset_id = asset_id_in, commit = C_change_or_sentinel)
        if tip_amount > 0:
            emit_asset_utxo(tx.vout[3], asset_id = (tip_asset == 0 ? pool.asset_A : pool.asset_B),
                            commit = tip_commit)
    })
```

**Critical security checks** (do NOT skip in implementation):
- Step 8 (receipt-binding): closes the inflation attack
- Step 6 (freshness gate): closes the same-block double-dip attack
- Step 9 (identity-point sentinel): SEC1 decoder bypass for the canonical sentinel

---

## Opcode `0x2F`: T_SWAP_BATCH

**Spec:** AMM.md + SPEC.md §5.16.

This is the most complex validator. Pseudocode below covers the
core flow; field-level decoding details are in SPEC.md.

```
function validate_swap_batch(env: Envelope, tx: BitcoinTx, state: IndexerState)
    -> ValidationResult:

    # Step 1: Structural decoding
    if env.opcode != 0x2F: return reject(INVALID_OPCODE)

    fields = decode_swap_batch_payload(env.bytes)
    if fields is null: return reject(MALFORMED_ENVELOPE)

    let asset_A         = fields.asset_A
    let asset_B         = fields.asset_B
    let n_intents       = fields.n_intents       # 1..16
    let delta_A_net     = fields.delta_A_net_signed  # (sign, magnitude)
    let delta_B_net     = fields.delta_B_net_signed
    let R_net_A         = fields.R_net_A         # secp scalar
    let R_net_B         = fields.R_net_B
    let fee_bps         = fields.fee_bps_at_settle_LE
    let tip_A_amount    = fields.tip_A_amount_LE
    let tip_B_amount    = fields.tip_B_amount_LE
    let tip_A_C_secp    = fields.tip_A_C_secp
    let tip_B_C_secp    = fields.tip_B_C_secp
    let r_tip_A         = fields.r_tip_A_LE
    let r_tip_B         = fields.r_tip_B_LE
    let arbiter_block   = fields.arbiter_block   # optional
    let per_intent      = fields.per_intent_blocks  # array of N intents
    let per_receipt     = fields.per_receipt_blocks # array of N receipts
    let groth16_proof   = fields.proof

    # Step 2: Pool exists + matches asset pair
    let pool_id = sha256("tacit-amm-pool-v1" || asset_A || asset_B)
    let pool = state.pools.get(pool_id)
    if pool is null: return reject(UNKNOWN_POOL)
    if pool.fee_bps != fee_bps: return reject(MALFORMED_ENVELOPE)

    # Step 3: Within-block ordering rule (per AMM.md §"Indexer determinism rules")
    let running_state = get_running_pool_state(pool_id, immediately_before = (tx.block_height, tx.tx_index))
    let R_A_pre = running_state.R_A
    let R_B_pre = running_state.R_B

    # Step 4: Per-intent validation (loop over N intents)
    for i in 0..n_intents:
        let intent_block = per_intent[i]
        let intent_id    = sha256(intent_msg_canonical(intent_block))

        # 4a: Verify intent_sig
        let intent_msg = build_intent_msg(intent_block)
        if not verify_schnorr_bip340(intent_block.intent_sig, intent_msg, intent_block.trader_pubkey[1:33]):
            return reject(INVALID_INTENT_SIG)

        # 4b: Verify sigma cross-curve proof
        if not sigma_xcurve_verify(intent_block.xcurve_sigma,
                                    intent_block.C_in_secp,
                                    intent_block.C_in_BJJ):
            return reject(INVALID_SIGMA_PROOF)

        # 4c: Verify per-trader Bitcoin sig (SIGHASH_ALL over envelope_hash; see Track 5 in roadmap)
        let envelope_hash = sha256(env.bytes)
        let vin_index = 1 + i  # trader's input at vin[1+i]
        if not verify_bitcoin_sighash_all(tx.vin[vin_index].witness, envelope_hash, intent_block.trader_pubkey):
            return reject(INVALID_SIGNATURE)

        # 4d: Verify intent's outpoint exists as asset_id_in UTXO
        let asset_id_in = (intent_block.direction == 0 ? asset_A : asset_B)
        let utxo = state.asset_utxos.get(tx.vin[vin_index].outpoint)
        if utxo is null or utxo.asset_id != asset_id_in:
            return reject(MALFORMED_ENVELOPE)

        # 4e: Expiry
        if tx.block_height > intent_block.expiry_height:
            return reject(EXPIRED)

    # Step 5: Per-receipt sigma verification
    for j in 0..n_intents:
        let receipt_block = per_receipt[j]
        if not sigma_xcurve_verify(receipt_block.out_xcurve_sigma,
                                    receipt_block.C_out_secp,
                                    receipt_block.C_out_BJJ):
            return reject(INVALID_SIGMA_PROOF)

    # Step 6: Verify Groth16 proof against pool's vk
    let public_signals = build_public_signals(
        pool_id, R_A_pre, R_B_pre,
        delta_A_net, delta_B_net,
        per_intent, per_receipt,
        fee_bps, tip_A_amount, tip_B_amount
    )  # 123 signals total
    if not groth16_verify(groth16_proof, public_signals, pool.vk):
        return reject(INVALID_GROTH16_PROOF)

    # Step 7: Deterministic clearing-solve consistency
    let (X, Y) = compute_X_Y(per_intent)  # X = Σ A-side input, Y = Σ B-side input
    let (delta_A_net_expected, delta_B_net_expected, P_clear_num_expected, P_clear_den_expected) =
        SOLVE_CLEARING(X, Y, R_A_pre, R_B_pre, fee_bps)

    if delta_A_net != delta_A_net_expected: return reject(CLEARING_SOLVE_MISMATCH)
    if delta_B_net != delta_B_net_expected: return reject(CLEARING_SOLVE_MISMATCH)

    # Step 8: Per-trader min_out check (in-circuit but indexer verifies via public signals)
    for i in 0..n_intents:
        let amount_out_i = compute_amount_out(per_intent[i], P_clear_num_expected, P_clear_den_expected)
        if amount_out_i < per_intent[i].min_out:
            return reject(MIN_OUT_VIOLATION)

    # Step 9: Chain-side aggregate Pedersen check per asset
    for asset_X in [asset_A, asset_B]:
        let sum_C_in_X = sum of per_intent[i].C_in_secp where intent.direction matches asset_X
        let sum_C_out_X = sum of per_receipt[j].C_out_secp where receipt asset matches asset_X
        let delta_X_net_signed = (asset_X == asset_A ? delta_A_net : delta_B_net)
        let delta_X = delta_X_net_signed.magnitude * (delta_X_net_signed.sign == 0 ? 1 : -1)
        let tip_X_amount = (asset_X == asset_A ? tip_A_amount : tip_B_amount)
        let tip_X_C_secp = (asset_X == asset_A ? tip_A_C_secp : tip_B_C_secp)

        let lhs = point_add(
            point_subtract(sum_C_in_X, sum_C_out_X),
            point_mul(-delta_X, H_secp())  # subtract net delta
        )
        # Tip is published in cleartext; subtract from aggregate
        lhs = point_subtract(lhs, tip_X_C_secp)

        let rhs = point_mul((asset_X == asset_A ? R_net_A : R_net_B), G_secp())
        if lhs != rhs:
            return reject(CHAIN_AGGREGATE_VIOLATION)

    # Step 10: Tip-output openings (per asset)
    for asset_X in [A, B]:
        let tip_amount_X = (asset_X == A ? tip_A_amount : tip_B_amount)
        if tip_amount_X > 0:
            let r_tip_X = (asset_X == A ? r_tip_A : r_tip_B)
            let tip_C_X = (asset_X == A ? tip_A_C_secp : tip_B_C_secp)
            let expected = point_add(point_mul(tip_amount_X, H_secp()), point_mul(r_tip_X, G_secp()))
            if tip_C_X != expected: return reject(TIP_OPENING_MISMATCH)

    # Step 11: OP_RETURN(envelope_hash) binding
    if tx.vout[0].data != sha256(env.bytes): return reject(MALFORMED_ENVELOPE)

    # Step 12: Arbiter check (if pool has inclusion_arbiter_pubkeys)
    if pool.inclusion_arbiter_pubkeys is non-empty:
        if arbiter_block is null: return reject(MALFORMED_ENVELOPE)
        if arbiter_block.expected_height != tx.block_height: return reject(MALFORMED_ENVELOPE)
        let qualifying_set_hash_expected = compute_qualifying_set_hash(pool, tx.block_height)
        if arbiter_block.qualifying_set_hash != qualifying_set_hash_expected:
            return reject(MALFORMED_ENVELOPE)
        if arbiter_block.arbiter_pubkey not in pool.inclusion_arbiter_pubkeys:
            return reject(MALFORMED_ENVELOPE)
        let arbiter_msg = sha256("tacit-amm-qset-v1" || arbiter_block.qualifying_set_hash || arbiter_block.expected_height)
        if not verify_schnorr_bip340(arbiter_block.arbiter_sig, arbiter_msg, arbiter_block.arbiter_pubkey[1:33]):
            return reject(INVALID_SIGNATURE)

    # Step 13: Apply state transition
    return accept(state_delta = {
        pool.R_A += delta_A_net (signed)
        pool.R_B += delta_B_net (signed)
        pool.k_last = pool.R_A * pool.R_B
        for i in 0..n_intents:
            consumed_outpoints.add(tx.vin[1+i].outpoint)
            emit_asset_utxo(tx.vout[1+i],
                            asset_id = (per_intent[i].direction == 0 ? asset_B : asset_A),
                            commit = per_receipt[i].C_out_secp)
        if tip_A_amount > 0: emit_asset_utxo(tip_A_vout, asset_id = asset_A, commit = tip_A_C_secp)
        if tip_B_amount > 0: emit_asset_utxo(tip_B_vout, asset_id = asset_B, commit = tip_B_C_secp)
    })
```

**Public signals vector** (123 signals; full spec in AMM.md §"6. Groth16 public-input vector"). Layout is BY-ARRAY (snarkjs flattens public arrays in
`signal input` declaration order — each array's elements are contiguous, NOT interleaved per intent):

```
publicSignals[0]    = pool_id_fr                     # SHA256(pool_id) mod p_Fr
publicSignals[1]    = R_A_pre
publicSignals[2]    = R_B_pre
publicSignals[3]    = delta_A_net_sign
publicSignals[4]    = delta_A_net_magnitude
publicSignals[5]    = delta_B_net_sign
publicSignals[6]    = delta_B_net_magnitude
publicSignals[7]    = tip_A_amount
publicSignals[8]    = tip_B_amount
publicSignals[9]    = fee_bps                        # 0..1000 (in-circuit cap)
publicSignals[10]   = n_intents                      # 0..16, public hint
# Per-array contiguous, N_MAX = 16:
publicSignals[11  + i] = direction[i]                # i ∈ [0, 16)
publicSignals[27  + i] = C_in_BJJ_u[i]
publicSignals[43  + i] = C_in_BJJ_v[i]
publicSignals[59  + i] = min_out[i]
publicSignals[75  + i] = tip_amount[i]
publicSignals[91  + i] = C_out_BJJ_u[i]
publicSignals[107 + i] = C_out_BJJ_v[i]
```

Note: `amount_in_swap`, `amount_out`, and `intent_id_fr` are NOT public —
they live in the private witness. The indexer binds public intents to
on-chain envelope intent slots via the canonical `intent_id_fr` derived
from the signed intent payload (per AMM.md §5), not from a public-signal
slot.

---

## Opcode `0x2D`: T_LP_ADD

**Spec:** AMM.md + SPEC.md §5.14.

Abbreviated; structurally similar to T_SWAP_BATCH but with single LP (no batch).

```
function validate_lp_add(env: Envelope, tx: BitcoinTx, state: IndexerState):
    fields = decode_lp_add_payload(env.bytes)
    if fields is null: return reject(MALFORMED_ENVELOPE)

    let variant = fields.variant   # 0 = LP_ADD post-init, 1 = POOL_INIT

    if variant == 1:
        # POOL_INIT path
        if state.pools.contains(fields.pool_id): return reject(POOL_ALREADY_EXISTS)
        # Verify asset_A < asset_B strictly (canonical ordering)
        if not (fields.asset_A < fields.asset_B): return reject(MALFORMED_ENVELOPE)
        # Initialize pool: register vk_cid, ceremony_cid, fee_bps, min_liquidity
        # Verify two per-asset kernel sigs (asset A + asset B inputs)
        # Verify Groth16 proof
        # Lock MINIMUM_LIQUIDITY share at the NUMS_recipient
        # ... full spec in AMM.md §"POOL_INIT" + §"MINIMUM_LIQUIDITY burn-output construction"
        ...
        return accept(state_delta = { register new pool, mint S - min_liquidity shares to founder, lock min_liquidity })
    else:
        # LP_ADD post-init
        let pool = state.pools.get(fields.pool_id)
        if pool is null: return reject(UNKNOWN_POOL)

        # Verify two per-asset kernel sigs
        # Verify Groth16 proof (different witness from T_SWAP_BATCH but same pool vk)
        # Verify share_amount == floor(min(delta_A · S / R_A, delta_B · S / R_B))
        # Apply: pool.R_A += delta_A, pool.R_B += delta_B, pool.S += share_amount
        # Emit lp_asset_id UTXO to LP

        return accept(state_delta = { pool reserves grow; S grows; LP-share UTXO emitted })
```

## Opcode `0x2E`: T_LP_REMOVE

```
function validate_lp_remove(env: Envelope, tx: BitcoinTx, state: IndexerState):
    fields = decode_lp_remove_payload(env.bytes)

    let pool = state.pools.get(fields.pool_id)
    if pool is null: return reject(UNKNOWN_POOL)

    # Verify share_amount being burned doesn't drop pool.S below pool.min_liquidity
    if pool.S - fields.share_amount < pool.min_liquidity:
        return reject(INSUFFICIENT_LIQUIDITY)

    # Verify Groth16 proof under pool.vk (different circuit slot)
    # Verify share UTXO at vin[1] exists with the correct lp_asset_id
    # Compute proportional withdrawal:
    #   delta_A = floor(share_amount · R_A / S)
    #   delta_B = floor(share_amount · R_B / S)
    # Verify per-asset kernel sigs binding two receipts

    return accept(state_delta = {
        pool.R_A -= delta_A
        pool.R_B -= delta_B
        pool.S   -= share_amount
        consumed_outpoints.add(lp_share_input.outpoint)
        emit two asset receipts at vout[0..1]
    })
```

---

## Opcode `0x31`: T_PROTOCOL_FEE_CLAIM

**Spec:** AMM.md §"Protocol fee mechanism" + SPEC.md §5.18.

```
function validate_protocol_fee_claim(env: Envelope, tx: BitcoinTx, state: IndexerState):
    fields = decode_protocol_fee_claim_payload(env.bytes)

    let pool = state.pools.get(fields.pool_id)
    if pool is null: return reject(UNKNOWN_POOL)
    if pool.protocol_fee_address == [0x00; 33]: return reject(MALFORMED_ENVELOPE)  # disabled

    # Step 1: Verify claimer_pubkey matches pool's protocol_fee_address
    if fields.claimer_pubkey_xonly != pool.protocol_fee_address[1:33]:
        return reject(UNAUTHORIZED_CLAIM)

    # Step 2: Crystallize lazy-mintFee (per Uniswap V2 formula)
    let k_now = pool.R_A * pool.R_B  # u256
    let new_shares = compute_lazy_mint_fee_shares(k_now, pool.k_last, pool.S, pool.protocol_fee_bps)
    let claim_amount_expected = pool.protocol_fee_accrued + new_shares

    if fields.claim_amount != claim_amount_expected: return reject(MALFORMED_ENVELOPE)

    # Step 3: Verify Pedersen opening: claim_C_secp = claim_amount · H + claim_blinding · G
    let expected_C = point_add(
        point_mul(fields.claim_amount, H_secp()),
        point_mul(fields.claim_blinding, G_secp())
    )
    if fields.claim_C_secp != expected_C: return reject(INVALID_PEDERSEN_COMMIT)

    # Step 4: Verify claim_sig
    let claim_msg = sha256(
        "tacit-amm-protocol-fee-claim-v1" ||
        fields.pool_id || fields.claimer_pubkey_xonly ||
        fields.claim_amount_LE || fields.claim_C_secp
    )
    if not verify_schnorr_bip340(fields.claim_sig, claim_msg, fields.claimer_pubkey_xonly):
        return reject(INVALID_SIGNATURE)

    # Step 5: Apply state
    return accept(state_delta = {
        pool.protocol_fee_accrued = 0
        pool.S += new_shares
        pool.k_last = k_now
        emit_asset_utxo(tx.vout[0], asset_id = pool.lp_asset_id, commit = claim_C_secp)
    })
```

---

## Opcode `0x43`: T_TRADE_BATCH (deferred impl; spec'd in V1)

**Spec:** SPEC-TRADE-BATCH-AMENDMENT.md.

```
function validate_trade_batch(env: Envelope, tx: BitcoinTx, state: IndexerState):
    fields = decode_trade_batch_payload(env.bytes)

    if fields.opcode != 0x43: return reject(INVALID_OPCODE)

    let n_amm = fields.n_amm_intents
    let n_ob  = fields.n_orderbook_pairs

    if n_amm + n_ob == 0: return reject(MALFORMED_ENVELOPE)
    if n_amm > 16 or n_ob > 16: return reject(MALFORMED_ENVELOPE)

    # Step 1: Validate AMM sub-batch (delegate to T_SWAP_BATCH validator)
    if n_amm > 0:
        let amm_validation = validate_amm_sub_batch(fields.amm_sub_batch, tx, state)
        if amm_validation is reject: return amm_validation

    # Step 2: Validate orderbook sub-batch (per pair)
    if n_ob > 0:
        for k in 0..n_ob:
            let pair = fields.orderbook_pairs[k]
            let validation = validate_orderbook_pair(pair, tx, state)
            if validation is reject: return validation

    # Step 3: COMBINED CHAIN-AGGREGATE PEDERSEN CHECK (critical cross-surface conservation)
    for asset_id in fields.assets_touched:
        let lhs = compute_combined_lhs(asset_id, fields, tx)  # spans AMM + orderbook flows
        let rhs = point_mul(fields.R_net[asset_id], G_secp())
        if lhs != rhs: return reject(CHAIN_AGGREGATE_VIOLATION)

    # Step 4: Outer settler_sig
    let outer_msg = sha256("tacit-trade-batch-v1" || preceding_fields(fields))
    if not verify_schnorr_bip340(fields.settler_sig, outer_msg, fields.settler_pubkey[1:33]):
        return reject(INVALID_SIGNATURE)

    # Step 5: Apply combined state transition
    return accept(state_delta = {
        # AMM sub-batch effects: pool.R_A, pool.R_B advance per amm_validation
        # Orderbook sub-batch effects: per-pair maker UTXO consumption, taker receipts, BTC payments
        # All applied atomically — either all succeed or none
    })


function compute_combined_lhs(asset_id, fields, tx):
    # Σ_AMM_inputs_asset_id + Σ_OB_inputs_asset_id
    #   − Σ_AMM_outputs_asset_id − Σ_OB_outputs_asset_id
    #   − Δ_AMM_pool_asset_id · H_secp
    #   − tip_total_asset_id · H_secp

    let sum_in = sum of all C_in commits whose asset matches (AMM + orderbook)
    let sum_out = sum of all C_out commits whose asset matches (AMM receipts + orderbook receipts + orderbook changes)
    let delta_pool = sum of AMM pool deltas touching asset_id (cleartext, signed)
    let tip_total = sum of tip outputs whose asset matches

    return point_subtract(
        point_subtract(sum_in, sum_out),
        point_add(
            point_mul(delta_pool, H_secp()),
            point_mul(tip_total, H_secp())
        )
    )
```

---

## Helper: `SOLVE_CLEARING` (AMM clearing-solve algorithm)

Pseudocode from AMM.md §"4. Deterministic clearing-solve algorithm":

```
function SOLVE_CLEARING(X: u64, Y: u64, R_A: u64, R_B: u64, fee_bps: u16):
    # Arithmetic widths are normative; u128 / u256 annotations MUST be honored
    require fee_bps <= 1000
    let γ_num = (u16)(10000 - fee_bps)
    let γ_den = 10000

    # (X, Y) = (0, 0) is rejected upstream as degenerate-empty (N = 0 forbidden);
    # no branch needed here

    let lhs = (u128) X * (u128) R_B
    let rhs = (u128) Y * (u128) R_A
    if lhs > rhs: return SOLVE_A_TO_B_DOMINANT(X, Y, R_A, R_B, γ_num, γ_den)
    if lhs < rhs: return SOLVE_B_TO_A_DOMINANT(X, Y, R_A, R_B, γ_num, γ_den)
    return SPOT_CLEARING(X, Y, R_A, R_B)


function SOLVE_A_TO_B_DOMINANT(X, Y, R_A, R_B, γ_num, γ_den):
    let lo = 1
    let hi = X
    let best = lo
    for iter in 0..64:
        if lo > hi: break
        let mid = lo + (hi - lo) / 2  # integer floor, prevents overflow

        let num_db = (u256) R_B * γ_num * mid
        let den_db = (u256) R_A * γ_den + (u256) γ_num * mid
        let Δb_net = (u64)(num_db / den_db)  # floor

        let denom = (u128)(Y + Δb_net)
        let Δa_net_implied = if denom == 0:
            X
        else:
            let yx = (u128) Y * (u128) X
            X - (u64)(yx / denom)

        if Δa_net_implied == mid:
            return (mid, Δb_net, P_clear_num = X, P_clear_den = Y + Δb_net)
        if Δa_net_implied < mid:
            hi = mid - 1
        else:
            best = mid
            lo = mid + 1

    # No exact integer fixed point — return largest 'too-small' mid (best)
    let Δb_net_best = floor((u256) R_B * γ_num * best / ((u256) R_A * γ_den + (u256) γ_num * best))
    return (best, Δb_net_best, X, Y + Δb_net_best)


function SOLVE_B_TO_A_DOMINANT(X, Y, R_A, R_B, γ_num, γ_den):
    # Symmetric: swap (X,Y) ↔ (Y,X), (R_A,R_B) ↔ (R_B,R_A)
    let (Δb_net, Δa_net, num, den) = SOLVE_A_TO_B_DOMINANT(Y, X, R_B, R_A, γ_num, γ_den)
    return (Δa_net, Δb_net, P_clear_num = den, P_clear_den = num)


function SPOT_CLEARING(X, Y, R_A, R_B):
    return (Δa_net = 0, Δb_net = 0, P_clear_num = R_A, P_clear_den = R_B)
```

---

## Reorg handling

Per AMM.md §"Reorg safety" + the depth-3 canonical pool-state
advance rule:

```
function on_new_block(block: BitcoinBlock, state: IndexerState):
    # Step 1: process all envelope opcodes in tx_index ascending order
    for tx in block.txs in (tx_index ASC):
        for op in tacit_envelopes(tx):
            validate_and_apply(op, tx, state)

    # Step 2: depth-3 canonical advance for AMM pool state
    let depth_3_block = state.chain_tip - 2  # block 3 confirmations ago
    advance_canonical_pool_state(depth_3_block, state)


function on_reorg(orphaned_blocks: BitcoinBlock[], state: IndexerState):
    # Roll back all state changes from orphaned blocks
    for block in orphaned_blocks reversed:
        rollback_state_at_block(block, state)
    # Then process new chain tip
    on_new_block(new_tip, state)


function advance_canonical_pool_state(block_height, state):
    # Pool state changes from txs at this height become "final" (depth ≥ 3 confirmed)
    # Indexer-canonical pool reserves freeze at this depth; client UX can show
    # "settled (final)" status to traders whose txs landed at or before this height
    for pool in state.pools:
        pool.canonical_R_A = pool.R_A_at_height(block_height)
        pool.canonical_R_B = pool.R_B_at_height(block_height)
```

---

## Cross-impl parity contract

For each opcode, two conformant indexers (e.g., dapp and worker)
MUST produce:
1. Byte-identical envelope construction for identical inputs
2. Identical accept/reject decisions for any envelope
3. Identical RejectionReason enum values for rejections
4. Identical state-delta JSON for accepted envelopes
5. Identical chain-side aggregate values (R_net, sums, etc.)

If any of these diverge between implementations, it's a parity
bug. Run `tests/parity-runner.mjs` against the test vectors
in `tests/vectors/` to catch divergence in CI.

---

End of indexer pseudocode. Translates 1:1 to Rust / Go / Python /
JS. Engineers: implement each opcode against the validator above,
run against the canonical test vectors, fix any parity divergence
before merging.
