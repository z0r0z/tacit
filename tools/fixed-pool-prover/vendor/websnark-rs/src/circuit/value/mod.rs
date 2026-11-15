use std::fmt::Display;

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use num_bigint::BigInt;
use num_traits::ToPrimitive;

mod serde;

/// Circuit value, representing either a field element or an array of values.
///
/// Supports deserialization from untagged JSON (numbers, decimal strings, or arrays)
/// to retain compatibility with snarkjs circuit artifacts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Fr(Fr),
    Array(Vec<Value>),
}

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ValueError {
    #[error("expected number")]
    ExpectedNumber,
    #[error("expected array")]
    ExpectedArray,
    #[error("invalid number: {0}")]
    InvalidNumber(String),
    #[error("value out of range")]
    ValueOutOfRange,
}

impl Value {
    pub(crate) fn into_fr(self) -> Result<Fr, ValueError> {
        match self {
            Value::Fr(f) => Ok(f),
            Value::Array(_) => Err(ValueError::ExpectedNumber),
        }
    }
}

impl From<bool> for Value {
    fn from(value: bool) -> Self {
        Value::Fr(Fr::from(u64::from(value)))
    }
}

impl From<u32> for Value {
    fn from(value: u32) -> Self {
        Value::Fr(Fr::from(value))
    }
}

impl From<i32> for Value {
    fn from(value: i32) -> Self {
        Value::Fr(Fr::from(value))
    }
}

impl From<u64> for Value {
    fn from(value: u64) -> Self {
        Value::Fr(Fr::from(value))
    }
}

impl From<Fr> for Value {
    fn from(value: Fr) -> Self {
        Value::Fr(value)
    }
}

impl Display for Value {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Value::Fr(fr) => write!(f, "{fr}"),
            Value::Array(arr) => {
                write!(f, "[")?;
                for (i, item) in arr.iter().enumerate() {
                    if i > 0 {
                        write!(f, ", ")?;
                    }
                    write!(f, "{item}")?;
                }
                write!(f, "]")
            }
        }
    }
}

pub fn bigint_to_fr(n: &BigInt) -> Fr {
    if let Some(u) = n.to_u64() {
        return Fr::from(u);
    }
    if let Some(i) = n.to_i64() {
        return -Fr::from(i.unsigned_abs());
    }
    let bytes = n.to_signed_bytes_le();
    Fr::from_le_bytes_mod_order(&bytes)
}

pub fn fr_to_bigint(f: Fr) -> BigInt {
    let bytes = f.into_bigint().to_bytes_le();
    BigInt::from_bytes_le(num_bigint::Sign::Plus, &bytes)
}

pub fn fr_to_u32(f: Fr) -> Result<u32, ValueError> {
    f.into_bigint().as_ref()[0]
        .to_u32()
        .ok_or_else(|| ValueError::InvalidNumber(f.to_string()))
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_fr_to_bigint() {
        let big = BigInt::parse_bytes(b"123456789012345678901234567890", 10).unwrap();
        let fr = bigint_to_fr(&big);
        let big_back = fr_to_bigint(fr);
        assert_eq!(big, big_back);
    }

    #[test]
    fn test_fr_to_u32() {
        let f = Fr::from(42u64);
        let u32_value = fr_to_u32(f).unwrap();
        assert_eq!(u32_value, 42);

        let f_large = Fr::from(u64::MAX);
        assert!(fr_to_u32(f_large).is_err());
    }
}
