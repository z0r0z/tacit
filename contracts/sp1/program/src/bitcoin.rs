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

/// Extract input outpoints (prev_txid, prev_vout) from a Bitcoin transaction.
pub fn extract_input_outpoints(tx_data: &[u8]) -> Vec<([u8; 32], u16)> {
    let mut results = Vec::new();
    let mut pos = 4;
    if pos + 1 < tx_data.len() && tx_data[pos] == 0x00 && tx_data[pos + 1] == 0x01 { pos += 2; }
    let (input_count, vi_len) = read_varint(tx_data, pos);
    pos += vi_len;
    for _ in 0..input_count {
        if pos + 36 > tx_data.len() { break; }
        let mut prev_txid = [0u8; 32];
        prev_txid.copy_from_slice(&tx_data[pos..pos + 32]);
        let prev_vout = u32::from_le_bytes([tx_data[pos+32], tx_data[pos+33], tx_data[pos+34], tx_data[pos+35]]) as u16;
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
