use crate::serde::{G1, G2};
use ark_bn254::{G1Affine, G2Affine};
use serde::{Deserialize, Serialize};

/// CircomV1-compatible verifying key
#[serde_with::serde_as]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifyingKey {
    #[serde(rename = "vk_alfa_1")]
    #[serde_as(as = "G1")]
    pub alpha: G1Affine,
    #[serde(rename = "vk_beta_2")]
    #[serde_as(as = "G2")]
    pub beta: G2Affine,
    #[serde(rename = "vk_gamma_2")]
    #[serde_as(as = "G2")]
    pub gamma: G2Affine,
    #[serde(rename = "vk_delta_2")]
    #[serde_as(as = "G2")]
    pub delta: G2Affine,
    #[serde(rename = "IC")]
    #[serde_as(as = "Vec<G1>")]
    pub ic: Vec<G1Affine>,
}
