// Groth16 proof verification for BN254 inside SP1.
// VK is read from the host; its hash is committed publicly and checked
// against the on-chain GROTH16_VK_HASH immutable.
// Proof bytes use Solidity/snarkjs ABI order:
//   a.x, a.y, b.x.c0, b.x.c1, b.y.c0, b.y.c1, c.x, c.y — all 32-byte BE.

use ark_bn254::{Bn254, Fr, G1Affine, G2Affine};
use ark_ff::PrimeField;
use ark_groth16::{Groth16, PreparedVerifyingKey, Proof, VerifyingKey};
use ark_serialize::CanonicalDeserialize;
use ark_snark::SNARK;

pub fn prepare_vk(vk_bytes: &[u8]) -> Option<PreparedVerifyingKey<Bn254>> {
    let vk = VerifyingKey::<Bn254>::deserialize_uncompressed(vk_bytes).ok()?;
    Some(PreparedVerifyingKey::from(vk))
}

pub fn verify(pvk: &PreparedVerifyingKey<Bn254>, proof_bytes: &[u8], public_inputs: &[[u8; 32]]) -> bool {
    if public_inputs.len() != 5 { return false; }

    let proof = match parse_proof(proof_bytes) {
        Some(p) => p,
        None => return false,
    };

    let modulus = Fr::MODULUS;
    let mut inputs: Vec<Fr> = Vec::new();
    for bytes in public_inputs {
        let mut le = bytes.to_vec();
        le.reverse();
        let big = match <Fr as PrimeField>::BigInt::deserialize_uncompressed(&le[..]) {
            Ok(b) => b,
            Err(_) => return false,
        };
        if big >= modulus { return false; }
        match Fr::from_bigint(big) {
            Some(fr) => inputs.push(fr),
            None => return false,
        }
    }

    Groth16::<Bn254>::verify_with_processed_vk(pvk, &inputs, &proof).unwrap_or(false)
}

fn parse_proof(bytes: &[u8]) -> Option<Proof<Bn254>> {
    if bytes.len() != 256 { return None; }
    let a = parse_g1(&bytes[0..64])?;
    let b = parse_g2(&bytes[64..192])?;
    let c = parse_g1(&bytes[192..256])?;
    Some(Proof { a, b, c })
}

fn parse_g1(bytes: &[u8]) -> Option<G1Affine> {
    let mut x_le = bytes[0..32].to_vec();
    let mut y_le = bytes[32..64].to_vec();
    x_le.reverse();
    y_le.reverse();
    let mut buf = Vec::with_capacity(64);
    buf.extend_from_slice(&x_le);
    buf.extend_from_slice(&y_le);
    G1Affine::deserialize_uncompressed(&buf[..]).ok()
}

fn parse_g2(bytes: &[u8]) -> Option<G2Affine> {
    // Proof bytes from snarkJS fullProve are in native order:
    // [x_c0, x_c1, y_c0, y_c1] — all 32-byte BE.
    // Arkworks expects [c0_LE, c1_LE, c0_LE, c1_LE].
    let mut x_c0 = bytes[0..32].to_vec();
    let mut x_c1 = bytes[32..64].to_vec();
    let mut y_c0 = bytes[64..96].to_vec();
    let mut y_c1 = bytes[96..128].to_vec();
    x_c0.reverse();
    x_c1.reverse();
    y_c0.reverse();
    y_c1.reverse();
    let mut buf = Vec::with_capacity(128);
    buf.extend_from_slice(&x_c0);
    buf.extend_from_slice(&x_c1);
    buf.extend_from_slice(&y_c0);
    buf.extend_from_slice(&y_c1);
    G2Affine::deserialize_uncompressed(&buf[..]).ok()
}
