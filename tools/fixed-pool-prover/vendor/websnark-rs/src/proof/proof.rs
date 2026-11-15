use ark_bn254::{G1Affine, G2Affine};
use serde::{Deserialize, Serialize};
use crate::serde::{G1, G2};

/// CircomV1-compatible zk-SNARK proof
#[serde_with::serde_as]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proof {
    #[serde(rename = "pi_a")]
    #[serde_as(as = "G1")]
    pub a: G1Affine,
    #[serde(rename = "pi_b")]
    #[serde_as(as = "G2")]
    pub b: G2Affine,
    #[serde(rename = "pi_c")]
    #[serde_as(as = "G1")]
    pub c: G1Affine,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_postcard_roundtrip() {
        let proof_data = include_str!("../testdata/proof.json");
        let proof: Proof = serde_json::from_str(proof_data).unwrap();

        let bytes = postcard::to_stdvec(&proof).unwrap();
        let roundtripped: Proof = postcard::from_bytes(&bytes).unwrap();

        assert_eq!(proof, roundtripped);
    }
}
