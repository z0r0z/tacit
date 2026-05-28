use light_poseidon::{Poseidon, PoseidonHasher};
use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};

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
