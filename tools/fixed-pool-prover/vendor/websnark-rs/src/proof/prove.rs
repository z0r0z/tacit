use ark_bn254::{Fr, G1Projective, G2Projective};
use ark_ec::{CurveGroup, VariableBaseMSM};
use ark_ff::{AdditiveGroup, PrimeField};
use ark_poly::{EvaluationDomain, Radix2EvaluationDomain};
use rand::CryptoRng;
use tracing::instrument;

use crate::{
    circuit::Witness,
    proof::{ProofError, fr_snarkjs::FrSnarkjs, proof::Proof},
    proving_key::ProvingKey,
};

/// Generate a zk-SNARK groth16 proof for a given proving key and witness.
///
/// # Errors
/// Returns an error if the witness is invalid, or the proof cannot be generated.
pub fn prove_random(
    pk: &ProvingKey,
    w: &Witness,
    rng: &mut impl CryptoRng,
) -> Result<(Proof, Vec<Fr>), ProofError> {
    let mut bytes = [0u8; 32];

    rng.fill_bytes(&mut bytes);
    let r = Fr::from_le_bytes_mod_order(&bytes);

    rng.fill_bytes(&mut bytes);
    let s = Fr::from_le_bytes_mod_order(&bytes);
    prove(pk, w, r, s)
}

/// Generate a zk-SNARK groth16 proof for a given proving key, witness, and scalars `r` and `s`.
///
/// # Errors
/// Returns an error if the witness is invalid, or the proof cannot be generated.
#[instrument(skip_all)]
pub fn prove(pk: &ProvingKey, w: &Witness, r: Fr, s: Fr) -> Result<(Proof, Vec<Fr>), ProofError> {
    let mut proof_a = G1Projective::msm_unchecked(&pk.a, w);
    let mut proof_b_g1 = G1Projective::msm_unchecked(&pk.b_g1, w);
    let mut proof_b_g2 = G2Projective::msm_unchecked(&pk.b_g2, w);

    let start = pk.n_public + 1;
    let mut proof_c = G1Projective::msm_unchecked(&pk.c[start..pk.n_vars], &w[start..pk.n_vars]);

    let h = calculate_h(pk, w)?;
    let proof_c_h = G1Projective::msm_unchecked(&pk.h_exps, &h);

    // A = α + Σ wᵢAᵢ + r·δ
    proof_a += pk.vk_alpha_g1;
    proof_a += pk.vk_delta_g1 * r;

    // B (G2) = β + Σ wᵢBᵢ + s·δ
    proof_b_g2 += pk.vk_beta_g2;
    proof_b_g2 += pk.vk_delta_g2 * s;

    // B (G1) — same scalars, G1 bases, needed for the C term
    proof_b_g1 += pk.vk_beta_g1;
    proof_b_g1 += pk.vk_delta_g1 * s;

    // C = Σ wᵢCᵢ + Σ hⱼ·HExpⱼ + s·A + r·B₁ - rs·δ
    proof_c += proof_c_h;
    proof_c += proof_a * s;
    proof_c += proof_b_g1 * r;
    proof_c -= pk.vk_delta_g1 * (r * s);

    let proof = Proof {
        a: proof_a.into_affine(),
        b: proof_b_g2.into_affine(),
        c: proof_c.into_affine(),
    };

    let pub_signals = w[1..start].to_vec();

    Ok((proof, pub_signals))
}

// snarkjs/websnark proving keys order polsA/polsB around ω_7 (7^((R-1)/2^28)), not
// ark-bn254's ω_5 — so the FFT runs over `FrSnarkjs` and we convert at the boundary.
#[expect(clippy::similar_names)]
fn calculate_h(pk: &ProvingKey, w: &[Fr]) -> Result<Vec<Fr>, ProofError> {
    let m = pk.domain_size;

    let to_s = |x: Fr| FrSnarkjs::from_bigint(x.into_bigint());

    let mut pol_at = vec![FrSnarkjs::ZERO; m];
    let mut pol_bt = vec![FrSnarkjs::ZERO; m];
    for (i, w_i) in w.iter().enumerate().take(pk.n_vars) {
        let w_i = to_s(*w_i).ok_or(ProofError::InvalidWitness(*w_i))?;
        for (&j, coeff) in &pk.pols_a[i] {
            pol_at[j] += w_i * to_s(*coeff).ok_or(ProofError::InvalidCoefficient)?;
        }
        for (&j, coeff) in &pk.pols_b[i] {
            pol_bt[j] += w_i * to_s(*coeff).ok_or(ProofError::InvalidCoefficient)?;
        }
    }

    let domain_m = Radix2EvaluationDomain::<FrSnarkjs>::new(m).ok_or(ProofError::InvalidDomain)?;
    let domain_2m =
        Radix2EvaluationDomain::<FrSnarkjs>::new(2 * m).ok_or(ProofError::InvalidDomain)?;
    let coset_m = domain_m
        .get_coset(domain_2m.group_gen())
        .ok_or(ProofError::InvalidCoset)?;

    let subgroup_a = pol_at.clone();
    let subgroup_b = pol_bt.clone();

    let mut coset_a = pol_at;
    let mut coset_b = pol_bt;
    domain_m.ifft_in_place(&mut coset_a);
    domain_m.ifft_in_place(&mut coset_b);
    coset_m.fft_in_place(&mut coset_a);
    coset_m.fft_in_place(&mut coset_b);

    let mut pol_ab = vec![FrSnarkjs::ZERO; 2 * m];
    for i in 0..m {
        pol_ab[2 * i] = subgroup_a[i] * subgroup_b[i];
        pol_ab[2 * i + 1] = coset_a[i] * coset_b[i];
    }

    domain_2m.ifft_in_place(&mut pol_ab);

    pol_ab
        .split_off(m)
        .into_iter()
        .map(|x| Fr::from_bigint(x.into_bigint()).ok_or(ProofError::InvalidCoefficient))
        .collect::<Result<_, ProofError>>()
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use crate::proof::Proof;

    use super::*;

    #[test]
    #[tracing_test::traced_test]
    fn test_calculate_h() {
        let pk_data = include_str!("../testdata/withdraw_proving_key.json");
        let pk: ProvingKey = serde_json::from_str(pk_data).unwrap();

        let witness_data = include_str!("../testdata/witness.json");
        let witness: Witness = serde_json::from_str(witness_data).unwrap();

        let h_data = include_str!("../testdata/h.json");
        let expected_h: Vec<String> = serde_json::from_str(h_data).unwrap();
        let expected_h: Vec<Fr> = expected_h
            .into_iter()
            .map(|x| Fr::from_str(&x).unwrap())
            .collect();

        let h = calculate_h(&pk, &witness).unwrap();
        assert_eq!(h.len(), expected_h.len());
        for (h_i, expected_h_i) in h.iter().zip(expected_h.iter()) {
            assert_eq!(h_i, expected_h_i);
        }
    }

    #[test]
    #[tracing_test::traced_test]
    fn test_prove() {
        let pk_data = include_str!("../testdata/withdraw_proving_key.json");
        let pk: ProvingKey = serde_json::from_str(pk_data).unwrap();

        let witness_data = include_str!("../testdata/witness.json");
        let witness: Witness = serde_json::from_str(witness_data).unwrap();

        let proof_data = include_str!("../testdata/proof.json");
        let expected_proof: Proof = serde_json::from_str(proof_data).unwrap();

        let r = Fr::ZERO;
        let s = Fr::ZERO;

        let (proof, _) = prove(&pk, &witness, r, s).unwrap();

        assert_eq!(proof, expected_proof);
    }
}
