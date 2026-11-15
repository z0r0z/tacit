use ark_bn254::Fr;
use num_bigint::BigInt;
use serde::{Deserialize, Deserializer, Serialize, Serializer, ser::SerializeSeq};

use crate::circuit::{Value, value::bigint_to_fr};
use crate::serde::FieldElement;

/// Shadow of [`Value`] so `#[derive]` can generate a tagged binary encoding; `Value` can't derive
/// directly since its human-readable format is hand-written below (untagged, no `#[derive]` for that).
#[serde_with::serde_as]
#[derive(Serialize, Deserialize)]
#[serde(remote = "Value")]
enum BinaryValue {
    Fr(#[serde_as(as = "FieldElement")] Fr),
    Array(Vec<Value>),
}

struct ValueVisitor;

impl Serialize for Value {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if !s.is_human_readable() {
            return BinaryValue::serialize(self, s);
        }

        match self {
            Value::Fr(fr) => fr.to_string().serialize(s),
            Value::Array(items) => {
                let mut seq = s.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        if !d.is_human_readable() {
            return BinaryValue::deserialize(d);
        }

        d.deserialize_any(ValueVisitor)
    }
}

impl<'de> serde::de::Visitor<'de> for ValueVisitor {
    type Value = Value;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("number, decimal string, or array")
    }

    fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
        Ok(Value::Fr(Fr::from(v)))
    }

    fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
        Ok(Value::Fr(Fr::from(v)))
    }

    fn visit_u128<E: serde::de::Error>(self, v: u128) -> Result<Self::Value, E> {
        Ok(Value::Fr(Fr::from(v)))
    }

    fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
        let n = v.parse::<BigInt>().map_err(|e| E::custom(e))?;
        Ok(Value::Fr(bigint_to_fr(&n)))
    }

    fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Self::Value, E> {
        self.visit_str(&v)
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element::<Value>()? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn de(s: &str) -> Value {
        serde_json::from_str(s).expect("deserialization failed")
    }

    #[test]
    fn test_single_number() {
        let v = de("42");
        assert_eq!(v, Value::from(42));
    }

    #[test]
    fn test_negative_number() {
        let v = de("-7");
        assert_eq!(v, Value::from(-7));
    }

    #[test]
    fn test_flat_array() {
        let v = de("[1, 2, 3]");
        assert_eq!(
            v,
            Value::Array(vec![Value::from(1), Value::from(2), Value::from(3),])
        );
    }

    #[test]
    fn test_mixed_nesting() {
        let v = de("[1, [2, 3]]");
        assert_eq!(
            v,
            Value::Array(vec![
                Value::from(1),
                Value::Array(vec![Value::from(2), Value::from(3)]),
            ])
        );
    }

    #[test]
    fn test_empty_array() {
        let v = de("[]");
        assert_eq!(v, Value::Array(vec![]));
    }

    #[test]
    fn test_invalid_input_fails() {
        assert!(serde_json::from_str::<Value>("\"not a number\"").is_err());
        assert!(serde_json::from_str::<Value>("true").is_err());
        assert!(serde_json::from_str::<Value>("null").is_err());
    }

    #[test]
    fn test_postcard_scalar() {
        let v = Value::Fr(bigint_to_fr(&BigInt::from(42)));

        let bytes = postcard::to_stdvec(&v).expect("serialization failed");
        let back: Value = postcard::from_bytes(&bytes).expect("deserialization failed");

        assert_eq!(back, v);
    }

    #[test]
    fn test_postcard_nested_array() {
        let v = Value::Array(vec![
            Value::from(1),
            Value::Array(vec![Value::from(2), Value::from(3)]),
        ]);

        let bytes = postcard::to_stdvec(&v).expect("serialization failed");
        let back: Value = postcard::from_bytes(&bytes).expect("deserialization failed");

        assert_eq!(back, v);
    }
}
