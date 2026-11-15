//! Circuit definition and witness generation.

#[allow(clippy::module_inception)]
mod circuit;
mod interpreter;
mod rt_ctx;
pub(crate) mod value;
mod witness;

pub use circuit::Circuit;
pub use value::{Value, ValueError};
pub use witness::Witness;

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum CircuitError {
    #[error("parse error in function {function}: {source}")]
    ParseError {
        #[source]
        source: crate::circom::ParseError,
        function: String,
    },
    #[error("value error: {0}")]
    ValueError(#[from] crate::circuit::value::ValueError),
    #[error("assertion failed: {0} != {1}: {2}")]
    AssertionFailed(Box<ark_bn254::Fr>, Box<ark_bn254::Fr>, String),
    #[error("input index out of bounds: {0} >= {1}")]
    InputIndexOutOfBounds(usize, usize),
    #[error("signal not assigned: {0}")]
    SignalNotAssigned(String),
    #[error("invalid inverse: base is zero")]
    InvalidInverse,
    #[error("runtime error: {0}")]
    RuntimeError(String),
}
