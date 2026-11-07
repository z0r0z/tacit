//! A block's data in EIP-4844 blobs instead of calldata, the leader's choice per block: blobs once a block is large enough that they
//! cost less.
//!
//! What only the chain's state needs (the new notes' leaves and memos, the nullifiers, the claims' signatures) goes into the blob
//! stream `stream`: each list's count (u32 BE) and items, in the order the block commits them. The stream fills blobs 31 bytes to a
//! field element (each element's top byte zero), 4096 elements to a blob. For blob i with KZG commitment C_i the program derives the
//! point z_i = SHA-256(BLOB_DOMAIN ‖ C_i ‖ SHA-256(stream)) mod r and evaluates the blob's polynomial there itself (y_i, the
//! barycentric formula over the bit-reversed roots of unity, as EIP-4844 lays a blob out), and commits SHA-256 of every (versioned
//! hash, z_i, y_i). The landing contract checks each versioned hash is the transaction's blob and that its commitment opens to y_i at
//! z_i (the point-evaluation precompile): two polynomials of degree under 4096 that agree at a point drawn after both were fixed are
//! the same, so the blobs carry exactly the stream.

use num_bigint::BigUint;
use sha2::{Digest, Sha256};

pub const FIELD_ELEMENTS: usize = 4096;
pub const BYTES_PER_ELEMENT: usize = 31;
pub const BLOB_DATA: usize = FIELD_ELEMENTS * BYTES_PER_ELEMENT;
const BLOB_DOMAIN: &[u8] = b"tacit-block-blob-v1";

/// BLS12-381's scalar field, the field of blob elements: residues as four little-endian u64 limbs.
type U = [u64; 4];
const R: U = [0xffff_ffff_0000_0001, 0x53bd_a402_fffe_5bfe, 0x3339_d808_09a1_d805, 0x73ed_a753_299d_7d48];
const ONE: U = [1, 0, 0, 0];
const ZERO: U = [0; 4];

fn lt(a: &U, b: &U) -> bool {
    for i in (0..4).rev() {
        if a[i] != b[i] {
            return a[i] < b[i];
        }
    }
    false
}

fn add(a: &U, b: &U) -> U {
    // a + b for a, b < r < 2^255 fits in 256 bits; r comes off at most once
    let mut s = [0u64; 4];
    let mut carry = 0u64;
    for i in 0..4 {
        let (x, c1) = a[i].overflowing_add(b[i]);
        let (y, c2) = x.overflowing_add(carry);
        s[i] = y;
        carry = c1 as u64 + c2 as u64;
    }
    if !lt(&s, &R) {
        let mut borrow = 0u64;
        for i in 0..4 {
            let (x, b1) = s[i].overflowing_sub(R[i]);
            let (y, b2) = x.overflowing_sub(borrow);
            s[i] = y;
            borrow = b1 as u64 + b2 as u64;
        }
    }
    s
}

fn sub(a: &U, b: &U) -> U {
    let mut d = [0u64; 4];
    let mut borrow = 0u64;
    for i in 0..4 {
        let (x, b1) = a[i].overflowing_sub(b[i]);
        let (y, b2) = x.overflowing_sub(borrow);
        d[i] = y;
        borrow = b1 as u64 + b2 as u64;
    }
    if borrow != 0 {
        let mut carry = 0u64;
        for i in 0..4 {
            let (x, c1) = d[i].overflowing_add(R[i]);
            let (y, c2) = x.overflowing_add(carry);
            d[i] = y;
            carry = c1 as u64 + c2 as u64;
        }
    }
    d
}

/// a·b mod r: one uint256_mulmod in the zkVM.
#[cfg(target_os = "zkvm")]
fn mul(a: &U, b: &U) -> U {
    let mut x = *a;
    let y: [u64; 8] = [b[0], b[1], b[2], b[3], R[0], R[1], R[2], R[3]];
    unsafe { sp1_lib::syscall_uint256_mulmod(&mut x, y.as_ptr() as *const [u64; 4]) };
    x
}

#[cfg(not(target_os = "zkvm"))]
fn mul(a: &U, b: &U) -> U {
    let big = |x: &U| x.iter().rev().fold(BigUint::from(0u8), |acc, l| (acc << 64u32) | BigUint::from(*l));
    let p = (big(a) * big(b)) % big(&R);
    let mut out = [0u64; 4];
    for (i, d) in p.to_u64_digits().into_iter().enumerate() {
        out[i] = d;
    }
    out
}

fn pow(base: &U, e: &U) -> U {
    let mut acc = ONE;
    for i in (0..256).rev() {
        acc = mul(&acc, &acc);
        if (e[i / 64] >> (i % 64)) & 1 == 1 {
            acc = mul(&acc, base);
        }
    }
    acc
}

fn inv(a: &U) -> U {
    // Fermat: a^(r − 2)
    let mut e = R;
    e[0] -= 2;
    pow(a, &e)
}

fn from_be(b: &[u8]) -> U {
    let mut out = [0u64; 4];
    for k in 0..4 {
        out[3 - k] = u64::from_be_bytes(b[8 * k..8 * k + 8].try_into().unwrap());
    }
    out
}

fn to_be(x: &U) -> [u8; 32] {
    let mut out = [0u8; 32];
    for k in 0..4 {
        out[8 * k..8 * k + 8].copy_from_slice(&x[3 - k].to_be_bytes());
    }
    out
}

/// A 32-byte big-endian value reduced mod r. 2^256 is above 2r (r is about 2^254.9) but below 3r, so up to two subtractions:
/// the point-evaluation precompile refuses any z of r or more.
fn reduce(be: &[u8; 32]) -> U {
    let mut x = from_be(be);
    while !lt(&x, &R) {
        x = sub(&x, &R);
    }
    x
}

/// The stream's data-only lists as one stream: leaves and memos (count, then each leaf ‖ memo), nullifiers, claims.
pub fn stream(outputs: &[([u8; 32], Vec<u8>)], nullifiers: &[[u8; 32]], claims: &[[u8; 64]]) -> Vec<u8> {
    let mut b = (outputs.len() as u32).to_be_bytes().to_vec();
    for (leaf, memo) in outputs {
        b.extend(leaf);
        b.extend(memo);
    }
    b.extend((nullifiers.len() as u32).to_be_bytes());
    for n in nullifiers {
        b.extend(n);
    }
    b.extend((claims.len() as u32).to_be_bytes());
    for c in claims {
        b.extend(c);
    }
    b
}

/// The lists a stream holds (its memos `memo_len` bytes each), when it is one `stream` made; anything after them must be zero.
#[allow(clippy::type_complexity)]
pub fn parse(stream: &[u8], memo_len: usize) -> Option<(Vec<([u8; 32], Vec<u8>)>, Vec<[u8; 32]>, Vec<[u8; 64]>)> {
    let mut at = 0;
    let mut u32_at = |at: &mut usize| -> Option<usize> {
        let v = u32::from_be_bytes(stream.get(*at..*at + 4)?.try_into().ok()?) as usize;
        *at += 4;
        Some(v)
    };
    let n = u32_at(&mut at)?;
    let mut outputs = vec![];
    for _ in 0..n {
        let leaf: [u8; 32] = stream.get(at..at + 32)?.try_into().ok()?;
        outputs.push((leaf, stream.get(at + 32..at + 32 + memo_len)?.to_vec()));
        at += 32 + memo_len;
    }
    let n = u32_at(&mut at)?;
    let mut nullifiers = vec![];
    for _ in 0..n {
        nullifiers.push(stream.get(at..at + 32)?.try_into().ok()?);
        at += 32;
    }
    let n = u32_at(&mut at)?;
    let mut claims = vec![];
    for _ in 0..n {
        claims.push(stream.get(at..at + 64)?.try_into().ok()?);
        at += 64;
    }
    stream[at..].iter().all(|b| *b == 0).then_some((outputs, nullifiers, claims))
}

/// How many blobs a stream fills.
pub fn blobs_for(len: usize) -> usize {
    len.div_ceil(BLOB_DATA).max(1)
}

/// Blob `i` of a stream as EIP-4844 lays it out: 4096 big-endian field elements, each a zero byte and 31 of the stream's.
pub fn blob(stream: &[u8], i: usize) -> Vec<u8> {
    let mut out = vec![0u8; FIELD_ELEMENTS * 32];
    let part = stream.get(i * BLOB_DATA..).unwrap_or(&[]);
    for (k, chunk) in part.chunks(BYTES_PER_ELEMENT).take(FIELD_ELEMENTS).enumerate() {
        out[32 * k + 1..32 * k + 1 + chunk.len()].copy_from_slice(chunk);
    }
    out
}

/// The stream back from blobs (each 4096 × 32 bytes), including the zero padding of the last.
pub fn unblob(blobs: &[Vec<u8>]) -> Vec<u8> {
    let mut out = vec![];
    for b in blobs {
        for k in 0..FIELD_ELEMENTS {
            out.extend_from_slice(&b[32 * k + 1..32 * k + 32]);
        }
    }
    out
}

fn element(blob: &[u8], k: usize) -> U {
    from_be(&blob[32 * k..32 * k + 32])
}

fn bit_reverse(i: usize) -> usize {
    i.reverse_bits() >> (usize::BITS - 12)
}

/// ω, a primitive 4096th root of unity: 7^((r − 1) / 4096) (EIP-4844's primitive root is 7).
fn omega() -> U {
    let mut e = R;
    e[0] -= 1;
    // shift right by 12
    for k in 0..4 {
        e[k] = (e[k] >> 12) | if k + 1 < 4 { e[k + 1] << 52 } else { 0 };
    }
    pow(&[7, 0, 0, 0], &e)
}

/// The blob's polynomial at `z`, from its evaluations over the bit-reversed 4096th roots of unity:
/// Σ y_k ω_k / (z − ω_k) · (z^N − 1) / N, the denominators inverted together.
pub fn evaluate(blob: &[u8], z: &U) -> U {
    let w = omega();
    let mut roots = vec![ONE; FIELD_ELEMENTS];
    for i in 1..FIELD_ELEMENTS {
        roots[i] = mul(&roots[i - 1], &w);
    }
    let domain: Vec<U> = (0..FIELD_ELEMENTS).map(|i| roots[bit_reverse(i)]).collect();
    if let Some(k) = domain.iter().position(|d| d == z) {
        return element(blob, k);
    }
    let mut den: Vec<U> = domain.iter().map(|d| sub(z, d)).collect();
    let mut prefix = Vec::with_capacity(FIELD_ELEMENTS);
    let mut acc = ONE;
    for d in &den {
        prefix.push(acc);
        acc = mul(&acc, d);
    }
    let mut running = inv(&acc);
    for k in (0..FIELD_ELEMENTS).rev() {
        let d = den[k];
        den[k] = mul(&running, &prefix[k]);
        running = mul(&running, &d);
    }
    let mut sum = ZERO;
    for k in 0..FIELD_ELEMENTS {
        let y = element(blob, k);
        if y != ZERO {
            sum = add(&sum, &mul(&mul(&y, &domain[k]), &den[k]));
        }
    }
    let mut zn = *z;
    for _ in 0..12 {
        zn = mul(&zn, &zn);
    }
    mul(&mul(&sum, &sub(&zn, &ONE)), &inv(&[FIELD_ELEMENTS as u64, 0, 0, 0]))
}

/// EIP-4844's versioned hash of a commitment: 0x01 ‖ SHA-256(C)[1..].
pub fn versioned_hash(commitment: &[u8; 48]) -> [u8; 32] {
    let mut h: [u8; 32] = Sha256::digest(commitment).into();
    h[0] = 0x01;
    h
}

/// The point a blob's commitment is opened at: SHA-256(BLOB_DOMAIN ‖ C ‖ SHA-256(stream)) mod r.
pub fn challenge(commitment: &[u8; 48], stream_hash: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(BLOB_DOMAIN);
    h.update(commitment);
    h.update(stream_hash);
    to_be(&reduce(&h.finalize().into()))
}

/// Each blob's (versioned hash, z, y) for a stream carried in blobs with these commitments, and the hash the block commits over them;
/// None when the commitments are not as many as the stream fills.
pub fn claims(stream: &[u8], commitments: &[[u8; 48]]) -> Option<(Vec<[u8; 96]>, [u8; 32])> {
    if commitments.len() != blobs_for(stream.len()) {
        return None;
    }
    let sh: [u8; 32] = Sha256::digest(stream).into();
    let mut all = Vec::with_capacity(commitments.len());
    let mut h = Sha256::new();
    for (i, c) in commitments.iter().enumerate() {
        let z = challenge(c, &sh);
        let y = to_be(&evaluate(&blob(stream, i), &from_be(&z)));
        let mut item = [0u8; 96];
        item[..32].copy_from_slice(&versioned_hash(c));
        item[32..64].copy_from_slice(&z);
        item[64..].copy_from_slice(&y);
        h.update(item);
        all.push(item);
    }
    Some((all, h.finalize().into()))
}

#[cfg(test)]
mod reduce_tests {
    use super::*;

    /// Every 32-byte value comes out below r, including those of 2r or more (about 9.4% of SHA-256 outputs), which one
    /// subtraction left at r or above.
    #[test]
    fn reduces_below_r() {
        for be in [[0xffu8; 32], [0xe8u8; 32], [0x74u8; 32], [0u8; 32]] {
            assert!(lt(&reduce(&be), &R));
        }
    }
}
