// Poseidon hash over BN254 scalar field.
// Matches circomlib parameters: t=3 (2 inputs), Grassi 2020 rounds, x^5 S-box.
//
// This is a minimal implementation for the SP1 guest program. It produces
// identical outputs to poseidon-lite (JS) and PoseidonT3.sol (Solidity),
// which are already cross-verified in the test suite.
//
// Uses the poseidon-rs crate for BN254-compatible Poseidon.

// For SP1, we use the light-poseidon crate which supports BN254.
// The SP1 prover will optimize the field arithmetic via its precompiles.

use light_poseidon::{Poseidon, PoseidonHasher};
use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};

pub fn hash_bytes(data: &[u8]) -> [u8; 32] {
    use sha2::{Sha256, Digest};
    let h = Sha256::digest(data);
    h.into()
}

pub fn hash2(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let l = Fr::from_be_bytes_mod_order(left);
    let r = Fr::from_be_bytes_mod_order(right);

    let mut hasher = Poseidon::<Fr>::new_circom(2).unwrap();
    let result = hasher.hash(&[l, r]).unwrap();

    let mut out = [0u8; 32];
    let bytes = result.into_bigint().to_bytes_be();
    out.copy_from_slice(&bytes);
    out
}
