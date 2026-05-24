// Groth16 proof verification for BN254 inside SP1.
//
// Uses ark-groth16 with SP1-patched ark-bn254 — the field arithmetic
// is accelerated by SP1's BN254 syscalls automatically.
//
// The verifying key is read from the host (committed by the prover).
// In production, the vk should be hardcoded or derived from a known CID.

use ark_bn254::{Bn254, Fr, G1Affine, G2Affine};
use ark_ff::PrimeField;
use ark_groth16::{Groth16, PreparedVerifyingKey, Proof, VerifyingKey};
use ark_serialize::CanonicalDeserialize;
use ark_snark::SNARK;

/// Verify a Groth16 proof over BN254.
///
/// proof_bytes: 256 bytes [a(64) + b(128) + c(64)]
///   a = G1 uncompressed (32 x, 32 y)
///   b = G2 uncompressed (64 x, 64 y)  — x and y are Fp2 (32 + 32 each)
///   c = G1 uncompressed (32 x, 32 y)
///
/// public_inputs: 5 BN254 Fr elements (32 bytes each, big-endian)
///
/// vk_bytes: serialized VerifyingKey<Bn254> (read from host)
pub fn verify(proof_bytes: &[u8], public_inputs: &[[u8; 32]], vk_bytes: &[u8]) -> bool {
    // Deserialize verifying key.
    let vk = match VerifyingKey::<Bn254>::deserialize_uncompressed(&vk_bytes[..]) {
        Ok(vk) => vk,
        Err(_) => return false,
    };
    let pvk = PreparedVerifyingKey::from(vk);

    // Parse proof points from the 256-byte proof.
    let proof = match parse_proof(proof_bytes) {
        Some(p) => p,
        None => return false,
    };

    // Convert public inputs to Fr elements.
    let inputs: Vec<Fr> = public_inputs
        .iter()
        .filter_map(|bytes| Fr::from_be_bytes_mod_order(bytes).into())
        .collect();

    if inputs.len() != public_inputs.len() {
        return false;
    }

    // Verify the proof.
    Groth16::<Bn254>::verify_with_processed_vk(&pvk, &inputs, &proof).unwrap_or(false)
}

fn parse_proof(bytes: &[u8]) -> Option<Proof<Bn254>> {
    if bytes.len() != 256 {
        return None;
    }

    // a: G1 point (bytes 0..64)
    let a = parse_g1(&bytes[0..64])?;
    // b: G2 point (bytes 64..192)
    let b = parse_g2(&bytes[64..192])?;
    // c: G1 point (bytes 192..256)
    let c = parse_g1(&bytes[192..256])?;

    Some(Proof { a, b, c })
}

fn parse_g1(bytes: &[u8]) -> Option<G1Affine> {
    // The proof format is big-endian x(32) + y(32).
    // ark-bn254 expects little-endian for deserialization.
    let mut x_le = bytes[0..32].to_vec();
    let mut y_le = bytes[32..64].to_vec();
    x_le.reverse();
    y_le.reverse();

    let mut buf = Vec::with_capacity(65);
    buf.extend_from_slice(&x_le);
    buf.extend_from_slice(&y_le);
    buf.push(0); // infinity flag

    G1Affine::deserialize_uncompressed(&buf[..]).ok()
}

fn parse_g2(bytes: &[u8]) -> Option<G2Affine> {
    // G2 point: x is Fp2 (c0: 32 bytes, c1: 32 bytes), y is Fp2 (c0: 32, c1: 32).
    // Total 128 bytes big-endian. Convert each component to LE.
    let mut x_c0 = bytes[0..32].to_vec();
    let mut x_c1 = bytes[32..64].to_vec();
    let mut y_c0 = bytes[64..96].to_vec();
    let mut y_c1 = bytes[96..128].to_vec();
    x_c0.reverse();
    x_c1.reverse();
    y_c0.reverse();
    y_c1.reverse();

    // ark-bn254 Fp2 ordering: c0 then c1 for each coordinate.
    let mut buf = Vec::with_capacity(129);
    buf.extend_from_slice(&x_c0);
    buf.extend_from_slice(&x_c1);
    buf.extend_from_slice(&y_c0);
    buf.extend_from_slice(&y_c1);
    buf.push(0); // infinity flag

    G2Affine::deserialize_uncompressed(&buf[..]).ok()
}
