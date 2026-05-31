use sha2::{Sha256, Digest};

pub fn be_bytes_lte(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in 0..32 {
        if a[i] < b[i] { return true; }
        if a[i] > b[i] { return false; }
    }
    true // equal
}

pub fn double_sha256(data: &[u8]) -> [u8; 32] {
    let first = Sha256::digest(data);
    let second = Sha256::digest(&first);
    second.into()
}

pub fn compute_txid(tx_data: &[u8]) -> [u8; 32] {
    // BIP-141 anti-merkle-collision: a 64-byte serialization can be mistaken
    // for a merkle internal node. Bitcoin Core consensus rejects such txs in
    // blocks. We assert it explicitly here so the guest fails loudly with a
    // clear message rather than silently computing a txid that could collide.
    // Canonical mined blocks never contain a 64-byte non-witness tx; this
    // gate catches the malformed-block case rather than masking it. Audit BTC-1.
    assert!(tx_data.len() != 64 || (tx_data.len() > 5 && tx_data[4] == 0x00 && tx_data[5] == 0x01),
        "BIP141: 64-byte non-witness tx (anti-merkle-collision)");

    let is_segwit = tx_data.len() > 5 && tx_data[4] == 0x00 && tx_data[5] == 0x01;
    if !is_segwit {
        return double_sha256(tx_data);
    }
    // Strip marker+flag, skip witness, hash version+inputs+outputs+locktime.
    let version = &tx_data[0..4];
    let mut pos = 6; // skip version(4) + marker(1) + flag(1)
    let (input_count, vi_len) = read_varint(tx_data, pos);
    let inputs_start = pos;
    pos += vi_len;
    for _ in 0..input_count {
        pos += 36;
        let (script_len, vi_len) = read_varint(tx_data, pos);
        pos += vi_len + script_len + 4;
    }
    let (output_count, vi_len) = read_varint(tx_data, pos);
    pos += vi_len;
    for _ in 0..output_count {
        pos += 8;
        let (script_len, vi_len) = read_varint(tx_data, pos);
        pos += vi_len + script_len;
    }
    let outputs_end = pos;
    // Skip witness data per input.
    for _ in 0..input_count {
        let (wit_count, vi_len) = read_varint(tx_data, pos);
        pos += vi_len;
        for _ in 0..wit_count {
            let (item_len, vi_len) = read_varint(tx_data, pos);
            pos += vi_len + item_len;
        }
    }
    let locktime = &tx_data[pos..pos + 4];

    let mut stripped = Vec::with_capacity(version.len() + (outputs_end - inputs_start) + 4);
    stripped.extend_from_slice(version);
    stripped.extend_from_slice(&tx_data[inputs_start..outputs_end]);
    stripped.extend_from_slice(locktime);
    double_sha256(&stripped)
}

pub fn extract_merkle_root(header: &[u8]) -> [u8; 32] {
    header[36..68].try_into().unwrap()
}

pub fn bits_to_target(header: &[u8]) -> [u8; 32] {
    // Decodes nBits to a 256-bit target and rejects negative/zero-mantissa and
    // out-of-range exponents. Note: the per-network MAX_TARGET (difficulty floor)
    // clamp is intentionally NOT applied here — it is enforced by the on-chain
    // BitcoinLightRelay, which is the canonical chain/difficulty authority, and the
    // guest's committed last_block_hash must equal RELAY.tip(). Replicating a
    // network-specific MAX_TARGET in this generic guest would risk rejecting valid
    // headers (signet's target floor is far easier than mainnet's). exp > 31 yields
    // an all-zero target, which fails the PoW check below — consistent with the
    // relay rejecting any target above MAX_TARGET.
    // bits at offset 72, little-endian u32.
    let bits = u32::from_le_bytes([header[72], header[73], header[74], header[75]]);
    let exp = (bits >> 24) as usize;
    let mantissa = bits & 0x7fffff;

    assert!(bits & 0x00800000 == 0, "negative target");
    assert!(mantissa != 0, "zero mantissa");
    assert!(exp <= 32, "exponent out of range");

    let mut target = [0u8; 32];
    if exp <= 3 {
        let val = mantissa >> (8 * (3 - exp));
        let bytes = val.to_be_bytes();
        target[28..32].copy_from_slice(&bytes);
    } else {
        let shift_bytes = exp - 3;
        let bytes = mantissa.to_be_bytes();
        // Place mantissa bytes at the right position (big-endian, 32-byte).
        if shift_bytes + 4 <= 32 {
            let start = 32 - shift_bytes - 4;
            target[start..start + 4].copy_from_slice(&bytes);
        }
    }
    target
}

pub fn reverse_u256(v: &[u8; 32]) -> [u8; 32] {
    let mut r = [0u8; 32];
    for i in 0..32 {
        r[i] = v[31 - i];
    }
    r
}


pub fn compute_merkle_root(txids: &[[u8; 32]]) -> [u8; 32] {
    if txids.is_empty() { return [0u8; 32]; }
    if txids.len() == 1 { return txids[0]; }
    let mut layer = txids.to_vec();
    while layer.len() > 1 {
        let mut next = Vec::new();
        let mut i = 0;
        while i < layer.len() {
            let left = layer[i];
            let right = if i + 1 < layer.len() { layer[i + 1] } else { layer[i] };
            let mut combined = Vec::with_capacity(64);
            combined.extend_from_slice(&left);
            combined.extend_from_slice(&right);
            next.push(double_sha256(&combined));
            i += 2;
        }
        layer = next;
    }
    layer[0]
}

/// Extract Taproot witness envelope payload from vin[0].witness[1].
/// Returns the concatenated payload bytes if the script matches the
/// Tacit envelope format: PUSH(32) xonly OP_CHECKSIG OP_FALSE OP_IF [pushes] OP_ENDIF
pub fn extract_taproot_envelope(tx_data: &[u8]) -> Option<Vec<u8>> {
    if tx_data.len() < 6 || tx_data[4] != 0x00 || tx_data[5] != 0x01 { return None; }
    let mut pos = 6;
    let (input_count, vi_len) = read_varint(tx_data, pos);
    if input_count == 0 { return None; }
    pos += vi_len;
    for _ in 0..input_count {
        pos += 36;
        let (script_len, vi_len) = read_varint(tx_data, pos);
        pos += vi_len + script_len + 4;
    }
    let (output_count, vi_len) = read_varint(tx_data, pos);
    pos += vi_len;
    for _ in 0..output_count {
        pos += 8;
        let (script_len, vi_len) = read_varint(tx_data, pos);
        pos += vi_len + script_len;
    }
    // Parse witness for first input only.
    let (wit_count, vi_len) = read_varint(tx_data, pos);
    pos += vi_len;
    if wit_count < 2 { return None; }
    // Skip witness item 0 (signature).
    let (item0_len, vi_len) = read_varint(tx_data, pos);
    pos += vi_len + item0_len;
    // Witness item 1 = script.
    let (script_len, vi_len) = read_varint(tx_data, pos);
    pos += vi_len;
    let script = &tx_data[pos..pos + script_len];
    if script.len() < 36 { return None; }
    let mut sp = 0;
    if script[sp] != 32 { return None; } sp += 1; // PUSH(32)
    sp += 32; // skip xonly pubkey
    if sp >= script.len() || script[sp] != 0xac { return None; } sp += 1; // OP_CHECKSIG
    if sp + 1 >= script.len() || script[sp] != 0x00 || script[sp + 1] != 0x63 { return None; } sp += 2; // OP_FALSE OP_IF
    let mut payload = Vec::new();
    while sp < script.len() {
        if script[sp] == 0x68 { break; } // OP_ENDIF
        let op = script[sp]; sp += 1;
        if op >= 1 && op <= 75 {
            if sp + (op as usize) > script.len() { return None; }
            payload.extend_from_slice(&script[sp..sp + op as usize]);
            sp += op as usize;
        } else if op == 0x4c { // OP_PUSHDATA1
            if sp >= script.len() { return None; }
            let ln = script[sp] as usize; sp += 1;
            if sp + ln > script.len() { return None; }
            payload.extend_from_slice(&script[sp..sp + ln]);
            sp += ln;
        } else if op == 0x4d { // OP_PUSHDATA2
            if sp + 1 >= script.len() { return None; }
            let ln = u16::from_le_bytes([script[sp], script[sp + 1]]) as usize; sp += 2;
            if sp + ln > script.len() { return None; }
            payload.extend_from_slice(&script[sp..sp + ln]);
            sp += ln;
        } else {
            return None;
        }
    }
    // The dapp's encodeEnvelopeScript (and the worker's decodeEnvelopeScript)
    // frame every reveal as PUSH("TACIT") PUSH(version) followed by the payload
    // chunks, so the concatenated pushes are "TACIT" || 0x01 || envelope. Strip
    // that 6-byte frame so the opcode lands at index 0 — the bridge / 0x2A
    // dispatch reads tap_env[0] as the opcode and tap_env[1..] as the body.
    const FRAME: [u8; 6] = [0x54, 0x41, 0x43, 0x49, 0x54, 0x01]; // "TACIT" || v1
    if payload.len() <= FRAME.len() || payload[..FRAME.len()] != FRAME { return None; }
    Some(payload[FRAME.len()..].to_vec())
}

/// Extract input outpoints (prev_txid, prev_vout) from a Bitcoin transaction.
pub fn extract_input_outpoints(tx_data: &[u8]) -> Vec<([u8; 32], u32)> {
    let mut results = Vec::new();
    let mut pos = 4;
    if pos + 1 < tx_data.len() && tx_data[pos] == 0x00 && tx_data[pos + 1] == 0x01 { pos += 2; }
    let (input_count, vi_len) = read_varint(tx_data, pos);
    pos += vi_len;
    for _ in 0..input_count {
        if pos + 36 > tx_data.len() { break; }
        let mut prev_txid = [0u8; 32];
        prev_txid.copy_from_slice(&tx_data[pos..pos + 32]);
        let prev_vout = u32::from_le_bytes([tx_data[pos+32], tx_data[pos+33], tx_data[pos+34], tx_data[pos+35]]);
        results.push((prev_txid, prev_vout));
        pos += 36;
        let (script_len, vi_len) = read_varint(tx_data, pos);
        pos += vi_len + script_len + 4;
    }
    results
}

/// Extract ALL OP_RETURN payloads from a Bitcoin transaction.
pub fn extract_all_op_returns(tx_data: &[u8]) -> Vec<Vec<u8>> {
    let mut results = Vec::new();
    let mut pos = 4;
    if pos + 1 < tx_data.len() && tx_data[pos] == 0x00 && tx_data[pos + 1] == 0x01 { pos += 2; }
    let (input_count, vi_len) = read_varint(tx_data, pos);
    pos += vi_len;
    for _ in 0..input_count {
        pos += 36;
        let (script_len, vi_len) = read_varint(tx_data, pos);
        pos += vi_len + script_len + 4;
    }
    let (output_count, vi_len) = read_varint(tx_data, pos);
    pos += vi_len;
    for _ in 0..output_count {
        pos += 8;
        let (script_len, vi_len) = read_varint(tx_data, pos);
        pos += vi_len;
        let script_start = pos;
        if script_len > 2 && tx_data[script_start] == 0x6a {
            let script_end = script_start + script_len;
            let mut ds = script_start + 1;
            if ds >= script_end { pos = script_end; continue; }
            let op = tx_data[ds];
            let dl;
            if op == 0x4d {
                if ds + 3 > script_end { pos = script_end; continue; }
                dl = u16::from_le_bytes([tx_data[ds + 1], tx_data[ds + 2]]) as usize;
                ds += 3;
            } else if op == 0x4c {
                if ds + 2 > script_end { pos = script_end; continue; }
                dl = tx_data[ds + 1] as usize;
                ds += 2;
            } else {
                dl = op as usize;
                ds += 1;
            }
            if ds + dl <= script_end {
                results.push(tx_data[ds..ds + dl].to_vec());
            }
        }
        pos = script_start + script_len;
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    // Build a minimal P2TR script-path reveal tx whose witness item 1
    // (the script) embeds an envelope payload pushed via OP_PUSHDATA2.
    // Mirrors what dapp/tacit.js produces for T_WITHDRAW / CXFER reveals,
    // restricted to the structural fields extract_taproot_envelope reads.
    fn build_reveal_tx(payload: &[u8]) -> Vec<u8> {
        // script = PUSH32 xonly_pk(32) | OP_CHECKSIG | OP_FALSE | OP_IF
        //        | PUSH5 "TACIT" | PUSH1 version(0x01)   <- envelope frame
        //        | OP_PUSHDATA2 len_LE(2) payload | OP_ENDIF
        // The frame mirrors the dapp's encodeEnvelopeScript; the extractor
        // validates + strips it, so the returned envelope starts at the opcode.
        let mut script = Vec::new();
        script.push(0x20); script.extend_from_slice(&[0u8; 32]);
        script.push(0xac);
        script.push(0x00); script.push(0x63);
        script.push(0x05); script.extend_from_slice(b"TACIT");
        script.push(0x01); script.push(0x01);
        script.push(0x4d);
        script.push((payload.len() & 0xff) as u8);
        script.push((payload.len() >> 8) as u8);
        script.extend_from_slice(payload);
        script.push(0x68);

        let mut tx = Vec::new();
        tx.extend_from_slice(&[0x02, 0x00, 0x00, 0x00]); // version 2
        tx.extend_from_slice(&[0x00, 0x01]);             // segwit marker+flag
        tx.push(0x01);                                   // 1 input
        tx.extend_from_slice(&[0u8; 32]);                // prev txid
        tx.extend_from_slice(&[0u8; 4]);                 // prev vout
        tx.push(0x00);                                   // empty scriptSig
        tx.extend_from_slice(&[0xfd, 0xff, 0xff, 0xff]); // sequence
        tx.push(0x01);                                   // 1 output
        tx.extend_from_slice(&[0u8; 8]);                 // 0 value
        tx.push(0x00);                                   // empty scriptPubKey
        tx.push(0x03);                                   // 3 witness items
        tx.push(0x40); tx.extend_from_slice(&[0u8; 0x40]); // signature (64B)
        // script item (varint-len + script)
        let sl = script.len();
        if sl < 0xfd { tx.push(sl as u8); }
        else { tx.push(0xfd); tx.extend_from_slice(&(sl as u16).to_le_bytes()); }
        tx.extend_from_slice(&script);
        // control block (33B)
        tx.push(0x21); tx.extend_from_slice(&[0xc0; 0x21]);
        tx.extend_from_slice(&[0u8; 4]); // locktime
        tx
    }

    #[test]
    fn extracts_taproot_withdraw_envelope() {
        // Synthetic T_WITHDRAW: 0x2A | assetId(32) | denom_LE(8) | merkle_root(32)
        //   | nullifier(32) | recip_commit(33) | r_leaf(32) | bind_hash(32)
        //   | proof_len(2 LE) | proof(0) = 204 bytes (no proof bytes).
        let mut payload = vec![0x2A_u8];
        payload.extend_from_slice(&[0x11u8; 32]); // assetId
        payload.extend_from_slice(&100_000u64.to_le_bytes()); // denom
        payload.extend_from_slice(&[0x22u8; 32]); // pool root
        payload.extend_from_slice(&[0x33u8; 32]); // nullifier
        payload.extend_from_slice(&[0x02u8; 33]); // recip_commit (compressed pk)
        payload.extend_from_slice(&[0x44u8; 32]); // r_leaf
        payload.extend_from_slice(&[0x55u8; 32]); // bind_hash
        payload.extend_from_slice(&0u16.to_le_bytes()); // proof_len = 0

        let tx = build_reveal_tx(&payload);
        let got = extract_taproot_envelope(&tx).expect("extractor returns Some for valid reveal");
        // Confirms the bridge guest's Taproot dispatch sees 0x2A envelopes
        // (the audit gap that the prior OP_RETURN-scoped handler missed).
        assert_eq!(got[0], 0x2A, "first byte = opcode 0x2A");
        assert_eq!(got.len(), payload.len(), "full payload roundtrips");
        assert_eq!(&got[73..105], &[0x33u8; 32], "nullifier bytes intact");
    }

    #[test]
    fn extracts_taproot_cxfer_envelope() {
        // Regression: existing CXFER (0x22) still extractable post-refactor.
        let mut payload = vec![0x22_u8];
        payload.extend_from_slice(&[0xaau8; 32]); // assetId
        payload.extend_from_slice(&[0u8; 64]);    // padding to 97
        payload.push(0x00);                       // count = 0
        let tx = build_reveal_tx(&payload);
        let got = extract_taproot_envelope(&tx).expect("extractor returns Some");
        assert_eq!(got[0], 0x22);
    }
}

fn read_varint(data: &[u8], pos: usize) -> (usize, usize) {
    assert!(pos < data.len(), "varint: pos out of bounds");
    let first = data[pos];
    if first < 0xfd {
        (first as usize, 1)
    } else if first == 0xfd {
        assert!(pos + 2 < data.len(), "varint: short fd");
        let val = u16::from_le_bytes([data[pos + 1], data[pos + 2]]);
        (val as usize, 3)
    } else if first == 0xfe {
        assert!(pos + 4 < data.len(), "varint: short fe");
        let val = u32::from_le_bytes([data[pos + 1], data[pos + 2], data[pos + 3], data[pos + 4]]);
        (val as usize, 5)
    } else {
        assert!(pos + 8 < data.len(), "varint: short ff");
        let val = u64::from_le_bytes([
            data[pos + 1], data[pos + 2], data[pos + 3], data[pos + 4],
            data[pos + 5], data[pos + 6], data[pos + 7], data[pos + 8],
        ]);
        (val as usize, 9)
    }
}
