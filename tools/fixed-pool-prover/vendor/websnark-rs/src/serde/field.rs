use std::array::TryFromSliceError;

use ark_ff::{BigInt, PrimeField};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_with::{DeserializeAs, SerializeAs};

/// Serde adapter for the `PrimeField` trait.
pub struct FieldElement;

impl<F: PrimeField<BigInt = BigInt<4>>> SerializeAs<F> for FieldElement {
    fn serialize_as<S: Serializer>(value: &F, serializer: S) -> Result<S::Ok, S::Error> {
        if serializer.is_human_readable() {
            value.to_string().serialize(serializer)
        } else {
            field_to_bytes(*value).serialize(serializer)
        }
    }
}

impl<'de, F: PrimeField<BigInt = BigInt<4>>> DeserializeAs<'de, F> for FieldElement {
    fn deserialize_as<D: Deserializer<'de>>(deserializer: D) -> Result<F, D::Error> {
        if deserializer.is_human_readable() {
            let s = String::deserialize(deserializer)?;
            F::from_str(&s)
                .map_err(|_| serde::de::Error::custom(format!("invalid field element: {s}")))
        } else {
            let bytes = <[u8; 32]>::deserialize(deserializer)?;
            field_from_bytes(bytes).map_err(serde::de::Error::custom)
        }
    }
}

pub fn field_to_bytes<F: PrimeField<BigInt = BigInt<4>>>(f: F) -> [u8; 32] {
    let limbs = f.into_bigint().0;
    let mut bytes = [0u8; 32];
    for (i, limb) in limbs.iter().enumerate() {
        bytes[i * 8..(i + 1) * 8].copy_from_slice(&limb.to_le_bytes());
    }
    bytes
}

pub fn field_from_bytes<F: PrimeField<BigInt = BigInt<4>>>(
    bytes: [u8; 32],
) -> Result<F, TryFromSliceError> {
    let mut limbs = [0u64; 4];
    for (i, limb) in limbs.iter_mut().enumerate() {
        *limb = u64::from_le_bytes(bytes[i * 8..(i + 1) * 8].try_into()?);
    }
    Ok(F::from(BigInt(limbs)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_bn254::Fr;

    #[serde_with::serde_as]
    #[derive(serde::Serialize, serde::Deserialize)]
    struct Wrapper(#[serde_as(as = "FieldElement")] Fr);

    #[test]
    fn bytes_roundtrip() {
        let fr = Fr::from(u64::MAX);
        let back: Fr = field_from_bytes(field_to_bytes(fr)).unwrap();
        assert_eq!(back, fr);
    }

    #[test]
    fn json_roundtrip() {
        let fr = Fr::from(42u64);
        let json = serde_json::to_string(&Wrapper(fr)).unwrap();
        assert_eq!(json, "\"42\"");

        let back: Wrapper = serde_json::from_str(&json).unwrap();
        assert_eq!(back.0, fr);
    }

    #[test]
    fn postcard_roundtrip() {
        let fr = Fr::from(u64::MAX);
        let bytes = postcard::to_stdvec(&Wrapper(fr)).unwrap();
        let back: Wrapper = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(back.0, fr);
    }
}
