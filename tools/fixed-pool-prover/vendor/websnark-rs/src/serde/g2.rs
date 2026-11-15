use ark_bn254::{Fq, Fq2, G2Affine};
use ark_ec::AffineRepr;
use serde::{Deserializer, Serializer};
use serde_with::{DeserializeAs, SerializeAs};

use super::field::FieldElement;

/// Serde adapter for a G2 point.
pub struct G2;

/// `z` is `(1, 0)` for a real point, `(0, 0)` for the point at infinity (snarkjs projective form).
type Coords = [[Fq; 2]; 3];

impl SerializeAs<G2Affine> for G2 {
    fn serialize_as<S: Serializer>(value: &G2Affine, serializer: S) -> Result<S::Ok, S::Error> {
        <Option<[[FieldElement; 2]; 3]> as SerializeAs<Option<Coords>>>::serialize_as(
            &Some(to_coords(*value)),
            serializer,
        )
    }
}

impl<'de> DeserializeAs<'de, G2Affine> for G2 {
    fn deserialize_as<D: Deserializer<'de>>(deserializer: D) -> Result<G2Affine, D::Error> {
        let coords =
            <Option<[[FieldElement; 2]; 3]> as DeserializeAs<'de, Option<Coords>>>::deserialize_as(
                deserializer,
            )?;
        Ok(coords.map_or_else(G2Affine::zero, from_coords))
    }
}

fn to_coords(value: G2Affine) -> Coords {
    match value.xy() {
        Some((x, y)) => [[x.c0, x.c1], [y.c0, y.c1], [Fq::from(1u8), Fq::from(0u8)]],
        None => [[Fq::from(0u8); 2]; 3],
    }
}

fn from_coords(coords: Coords) -> G2Affine {
    if coords[2] == [Fq::from(0u8); 2] {
        return G2Affine::zero();
    }

    let point = G2Affine::new_unchecked(
        Fq2::new(coords[0][0], coords[0][1]),
        Fq2::new(coords[1][0], coords[1][1]),
    );
    debug_assert!(point.is_on_curve(), "G2 point not on curve: {point:?}");
    debug_assert!(
        point.is_in_correct_subgroup_assuming_on_curve(),
        "G2 point not in correct subgroup: {point:?}"
    );
    point
}

#[cfg(test)]
mod tests {
    use super::*;

    #[serde_with::serde_as]
    #[derive(serde::Serialize, serde::Deserialize)]
    struct Wrapper(#[serde_as(as = "G2")] G2Affine);

    #[test]
    fn json_roundtrip() {
        let point = G2Affine::generator();
        let json = serde_json::to_string(&Wrapper(point)).unwrap();

        let back: Wrapper = serde_json::from_str(&json).unwrap();
        assert_eq!(back.0, point);
    }

    #[test]
    fn json_zero_roundtrip() {
        let json = serde_json::to_string(&Wrapper(G2Affine::zero())).unwrap();
        assert_eq!(json, "[[\"0\",\"0\"],[\"0\",\"0\"],[\"0\",\"0\"]]");

        let back: Wrapper = serde_json::from_str(&json).unwrap();
        assert!(back.0.is_zero());
    }

    #[test]
    fn postcard_roundtrip() {
        let point = G2Affine::generator();
        let bytes = postcard::to_stdvec(&Wrapper(point)).unwrap();

        let back: Wrapper = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(back.0, point);
    }

    #[test]
    fn postcard_zero_roundtrip() {
        let bytes = postcard::to_stdvec(&Wrapper(G2Affine::zero())).unwrap();

        let back: Wrapper = postcard::from_bytes(&bytes).unwrap();
        assert!(back.0.is_zero());
    }
}
