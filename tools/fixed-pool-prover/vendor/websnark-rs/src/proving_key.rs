use std::collections::HashMap;

use crate::serde::{FieldElement, G1, G2};
use ark_bn254::{Fr, G1Affine, G2Affine};
use serde::{Deserialize, Serialize};

/// CircomV1-compatible proving key
#[serde_with::serde_as]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvingKey {
    #[serde(rename = "A")]
    #[serde_as(as = "Vec<G1>")]
    pub a: Vec<G1Affine>,
    #[serde(rename = "B1")]
    #[serde_as(as = "Vec<G1>")]
    pub b_g1: Vec<G1Affine>,
    #[serde(rename = "B2")]
    #[serde_as(as = "Vec<G2>")]
    pub b_g2: Vec<G2Affine>,
    #[serde(rename = "C")]
    #[serde_as(as = "Vec<G1>")]
    pub c: Vec<G1Affine>,
    #[serde(rename = "nVars")]
    pub n_vars: usize,
    #[serde(rename = "nPublic")]
    pub n_public: usize,
    #[serde(rename = "vk_alfa_1")]
    #[serde_as(as = "G1")]
    pub vk_alpha_g1: G1Affine,
    #[serde(rename = "vk_beta_1")]
    #[serde_as(as = "G1")]
    pub vk_beta_g1: G1Affine,
    #[serde(rename = "vk_beta_2")]
    #[serde_as(as = "G2")]
    pub vk_beta_g2: G2Affine,
    #[serde(rename = "vk_delta_1")]
    #[serde_as(as = "G1")]
    pub vk_delta_g1: G1Affine,
    #[serde(rename = "vk_delta_2")]
    #[serde_as(as = "G2")]
    pub vk_delta_g2: G2Affine,
    #[serde(rename = "hExps")]
    #[serde_as(as = "Vec<G1>")]
    pub h_exps: Vec<G1Affine>,
    #[serde(rename = "domainSize")]
    pub domain_size: usize,
    #[serde(rename = "polsA")]
    #[serde_as(as = "Vec<HashMap<_, FieldElement>>")]
    pub pols_a: Vec<HashMap<usize, Fr>>,
    #[serde(rename = "polsB")]
    #[serde_as(as = "Vec<HashMap<_, FieldElement>>")]
    pub pols_b: Vec<HashMap<usize, Fr>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkey_roundtrip() {
        let pk_data = include_str!("./testdata/withdraw_proving_key.json");
        serde_json::from_str::<ProvingKey>(pk_data).unwrap();
    }

    #[test]
    fn pkey_postcard_roundtrip() {
        let pk_data = include_str!("./testdata/withdraw_proving_key.json");
        let pk: ProvingKey = serde_json::from_str(pk_data).unwrap();

        let bytes = postcard::to_stdvec(&pk).unwrap();
        let roundtripped: ProvingKey = postcard::from_bytes(&bytes).unwrap();

        assert_eq!(pk, roundtripped);
    }
}
