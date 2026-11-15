//! Proof generation and verification logic.

mod fr_snarkjs;
#[allow(clippy::module_inception)]
mod proof;
mod prove;

pub use proof::Proof;
pub use prove::{prove, prove_random};

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ProofError {
    #[error("Invalid witness: {0}")]
    InvalidWitness(ark_bn254::Fr),
    #[error("Invalid coefficient")]
    InvalidCoefficient,
    #[error("Invalid domain")]
    InvalidDomain,
    #[error("Invalid coset")]
    InvalidCoset,
}
