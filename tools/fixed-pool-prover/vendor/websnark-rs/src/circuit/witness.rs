use std::ops::Deref;

use ark_bn254::Fr;
use crate::serde::FieldElement;

#[serde_with::serde_as]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Witness(#[serde_as(as = "Vec<FieldElement>")] Vec<Fr>);

impl Witness {
    #[must_use]
    pub fn new(witness: Vec<Fr>) -> Self {
        Witness(witness)
    }
}

impl Deref for Witness {
    type Target = Vec<Fr>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn witness_postcard_roundtrip() {
        let witness = Witness::new(vec![Fr::from(0u64), Fr::from(1u64), Fr::from(u64::MAX)]);

        let bytes = postcard::to_stdvec(&witness).unwrap();
        let roundtripped: Witness = postcard::from_bytes(&bytes).unwrap();

        assert_eq!(witness, roundtripped);
    }
}
