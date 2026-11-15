#![allow(unexpected_cfgs)]

use ark_ff::fields::{Fp256, MontBackend, MontConfig};

#[derive(MontConfig)]
#[modulus = "21888242871839275222246405745257275088548364400416034343698204186575808495617"]
#[generator = "7"]
pub struct FrSnarkjsConfig;

/// SnarkJS-compatible field element with generator = 7, so `TWO_ADIC_ROOT_OF_UNITY`
/// matches snarkjs/websnark's convention.
pub type FrSnarkjs = Fp256<MontBackend<FrSnarkjsConfig, 4>>;
