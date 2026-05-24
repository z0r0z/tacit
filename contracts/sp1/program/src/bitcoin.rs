// Bitcoin primitives for the SP1 guest program.
// Uses sp1_zkvm's SHA256 precompile for efficient hashing.

use sha2::{Sha256, Digest};

pub fn le_bytes_lte(a: &[u8; 32], b: &[u8; 32]) -> bool {
    // Compare as big-endian (MSB first) since both are 32-byte BE representations.
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
            let mut ds = script_start + 1;
            let op = tx_data[ds];
            let dl;
            if op == 0x4d {
                dl = u16::from_le_bytes([tx_data[ds + 1], tx_data[ds + 2]]) as usize;
                ds += 3;
            } else if op == 0x4c {
                dl = tx_data[ds + 1] as usize;
                ds += 2;
            } else {
                dl = op as usize;
                ds += 1;
            }
            if ds + dl <= script_start + script_len {
                results.push(tx_data[ds..ds + dl].to_vec());
            }
        }
        pos = script_start + script_len;
    }
    results
}

fn read_varint(data: &[u8], pos: usize) -> (usize, usize) {
    let first = data[pos];
    if first < 0xfd {
        (first as usize, 1)
    } else if first == 0xfd {
        let val = u16::from_le_bytes([data[pos + 1], data[pos + 2]]);
        (val as usize, 3)
    } else {
        panic!("varint too large");
    }
}
