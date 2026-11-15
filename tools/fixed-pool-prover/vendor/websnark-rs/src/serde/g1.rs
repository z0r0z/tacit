use ark_bn254::{Fq, G1Affine};
use ark_ec::AffineRepr;
use serde::{Deserializer, Serializer};
use serde_with::{DeserializeAs, SerializeAs};

use super::field::FieldElement;

/// Serde adapter for a G1 point.
pub struct G1;

/// `z` is `1` for a real point, `0` for the point at infinity (snarkjs projective form).
type Coords = [Fq; 3];

impl SerializeAs<G1Affine> for G1 {
    fn serialize_as<S: Serializer>(value: &G1Affine, serializer: S) -> Result<S::Ok, S::Error> {
        <Option<[FieldElement; 3]> as SerializeAs<Option<Coords>>>::serialize_as(
            &Some(to_coords(*value)),
            serializer,
        )
    }
}

impl<'de> DeserializeAs<'de, G1Affine> for G1 {
    fn deserialize_as<D: Deserializer<'de>>(deserializer: D) -> Result<G1Affine, D::Error> {
        let coords =
            <Option<[FieldElement; 3]> as DeserializeAs<'de, Option<Coords>>>::deserialize_as(
                deserializer,
            )?;
        Ok(coords.map_or_else(G1Affine::zero, from_coords))
    }
}

fn to_coords(value: G1Affine) -> Coords {
    match value.xy() {
        Some((x, y)) => [x, y, Fq::from(1u8)],
        None => [Fq::from(0u8); 3],
    }
}

fn from_coords(coords: Coords) -> G1Affine {
    if coords[2] == Fq::from(0u8) {
        return G1Affine::zero();
    }

    let point = G1Affine::new_unchecked(coords[0], coords[1]);
    debug_assert!(point.is_on_curve(), "G1 point not on curve: {point:?}");
    debug_assert!(
        point.is_in_correct_subgroup_assuming_on_curve(),
        "G1 point not in correct subgroup: {point:?}"
    );
    point
}

#[cfg(test)]
mod tests {
    use super::*;

    #[serde_with::serde_as]
    #[derive(serde::Serialize, serde::Deserialize)]
    struct Wrapper(#[serde_as(as = "G1")] G1Affine);

    #[test]
    fn json_roundtrip() {
        let point = G1Affine::generator();
        let json = serde_json::to_string(&Wrapper(point)).unwrap();

        let back: Wrapper = serde_json::from_str(&json).unwrap();
        assert_eq!(back.0, point);
    }

    #[test]
    fn json_zero_roundtrip() {
        let json = serde_json::to_string(&Wrapper(G1Affine::zero())).unwrap();
        assert_eq!(json, "[\"0\",\"0\",\"0\"]");

        let back: Wrapper = serde_json::from_str(&json).unwrap();
        assert!(back.0.is_zero());
    }

    #[test]
    fn json_null_is_zero() {
        let back: Wrapper = serde_json::from_str("null").unwrap();
        assert!(back.0.is_zero());
    }

    #[test]
    fn postcard_roundtrip() {
        let point = G1Affine::generator();
        let bytes = postcard::to_stdvec(&Wrapper(point)).unwrap();

        let back: Wrapper = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(back.0, point);
    }

    #[test]
    fn postcard_zero_roundtrip() {
        let bytes = postcard::to_stdvec(&Wrapper(G1Affine::zero())).unwrap();

        let back: Wrapper = postcard::from_bytes(&bytes).unwrap();
        assert!(back.0.is_zero());
    }
}
