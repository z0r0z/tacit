use std::fmt::Debug;

/// Cycle-tracker markers in the zkVM (the executor sums each name); nothing elsewhere.
macro_rules! track {
    ($l:literal) => {
        #[cfg(target_os = "zkvm")]
        println!($l);
    };
}

use super::ChallengeY;
#[cfg(not(target_os = "zkvm"))]
use super::construct_intermediate_sets;
use super::{rotation_sets_for_verifier, ChallengeU, ChallengeV};
use crate::arithmetic::{
    eval_polynomial, evaluate_vanishing_polynomial, lagrange_interpolate, powers,
};
use crate::helpers::SerdeCurveAffine;
use crate::poly::commitment::Verifier;
use crate::poly::commitment::MSM;
use crate::poly::kzg::commitment::{KZGCommitmentScheme, ParamsKZG};
use crate::poly::kzg::msm::DualMSM;
use crate::poly::kzg::msm::{PreMSM, MSMKZG};
use crate::poly::kzg::strategy::GuardKZG;
use crate::poly::query::{CommitmentReference, VerifierQuery};
use crate::poly::Error;
use crate::transcript::{EncodedChallenge, TranscriptRead};
use ff::{BatchInvert, Field};
use halo2curves::pairing::{Engine, MultiMillerLoop};
use halo2curves::CurveExt;
use std::ops::MulAssign;

/// Concrete KZG multiopen verifier with SHPLONK variant
#[derive(Debug)]
pub struct VerifierSHPLONK<'params, E: Engine> {
    params: &'params ParamsKZG<E>,
}

impl<'params, E> Verifier<'params, KZGCommitmentScheme<E>> for VerifierSHPLONK<'params, E>
where
    E: MultiMillerLoop + Debug,
    E::Fr: Ord,
    E::G1Affine: SerdeCurveAffine<ScalarExt = <E as Engine>::Fr, CurveExt = <E as Engine>::G1>,
    E::G1: CurveExt<AffineExt = E::G1Affine>,
    E::G2Affine: SerdeCurveAffine,
{
    type Guard = GuardKZG<'params, E>;
    type MSMAccumulator = DualMSM<'params, E>;

    const QUERY_INSTANCE: bool = false;

    fn new(params: &'params ParamsKZG<E>) -> Self {
        Self { params }
    }

    /// Verify a multi-opening proof
    fn verify_proof<
        'com,
        Ch: EncodedChallenge<E::G1Affine>,
        T: TranscriptRead<E::G1Affine, Ch>,
        I,
    >(
        &self,
        transcript: &mut T,
        queries: I,
        mut msm_accumulator: DualMSM<'params, E>,
    ) -> Result<Self::Guard, Error>
    where
        I: IntoIterator<Item = VerifierQuery<'com, E::G1Affine, MSMKZG<E>>> + Clone,
    {
        // Off the zkVM, every verification also builds the sets the original way and checks they agree.
        #[cfg(not(target_os = "zkvm"))]
        let reference = construct_intermediate_sets(queries.clone());
        track!("cycle-tracker-report-start: v6a-queries-sets");
        let (rotation_sets, super_point_set) = rotation_sets_for_verifier(queries);
        track!("cycle-tracker-report-end: v6a-queries-sets");
        #[cfg(not(target_os = "zkvm"))]
        {
            assert_eq!(rotation_sets.len(), reference.rotation_sets.len());
            assert_eq!(super_point_set.len(), reference.super_point_set.len());
            assert!(super_point_set.iter().all(|x| reference.super_point_set.contains(x)));
            for (set, want) in rotation_sets.iter().zip(&reference.rotation_sets) {
                assert_eq!(set.points.len(), want.points.len());
                assert_eq!(set.commitments.len(), want.commitments.len());
                for (c, w) in set.commitments.iter().zip(&want.commitments) {
                    assert!(c.get() == w.get());
                    for (x, e) in set.points.iter().zip(c.evals()) {
                        let i = want.points.iter().position(|y| y == x).unwrap();
                        assert_eq!(e, w.evals()[i]);
                    }
                }
            }
        }

        let y: ChallengeY<_> = transcript.squeeze_challenge_scalar();
        let v: ChallengeV<_> = transcript.squeeze_challenge_scalar();

        let h1 = transcript.read_point().map_err(|_| Error::SamplingError)?;
        let u: ChallengeU<_> = transcript.squeeze_challenge_scalar();
        let h2 = transcript.read_point().map_err(|_| Error::SamplingError)?;

        track!("cycle-tracker-report-start: v6b-sets-loop");
        let (mut z_0_diff_inverse, mut z_0) = (E::Fr::ZERO, E::Fr::ZERO);
        let (mut outer_msm, mut r_outer_acc) = (PreMSM::<E>::new(), E::Fr::ZERO);
        for (i, (rotation_set, power_of_v)) in rotation_sets.iter().zip(powers(*v)).enumerate() {
            let diffs: Vec<E::Fr> = super_point_set
                .iter()
                .filter(|point| !rotation_set.points.contains(point))
                .copied()
                .collect();
            let mut z_diff_i = evaluate_vanishing_polynomial(&diffs[..], *u);

            // normalize coefficients by the coefficient of the first commitment
            if i == 0 {
                z_0 = evaluate_vanishing_polynomial(&rotation_set.points[..], *u);
                z_0_diff_inverse = z_diff_i.invert().unwrap();
                z_diff_i = E::Fr::ONE;
            } else {
                z_diff_i.mul_assign(z_0_diff_inverse);
            }

            // Every commitment in the set is opened at the set's points, so the low degree equivalent's value
            // at u is Σ_j eval_j · L_j(u) with one Lagrange basis for the whole set.
            let basis = lagrange_basis_at(&rotation_set.points[..], *u);
            let (mut inner_msm, r_inner_acc) = rotation_set
                .commitments
                .iter()
                .zip(powers(*y))
                .map(|(commitment_data, power_of_y)| {
                    let evals = commitment_data.evals();
                    let r_at_u = evals.iter().zip(basis.iter()).fold(E::Fr::ZERO, |acc, (e, l)| acc + *e * *l);
                    // Off the zkVM, every verification also builds the interpolating polynomial and checks
                    // that it agrees.
                    #[cfg(not(target_os = "zkvm"))]
                    assert_eq!(r_at_u, eval_polynomial(&lagrange_interpolate(&rotation_set.points[..], &evals[..])[..], *u));
                    let r_eval = power_of_y * r_at_u;
                    let msm = match commitment_data.get() {
                        CommitmentReference::Commitment(c) => {
                            let mut msm = MSMKZG::<E>::new();
                            msm.append_term(power_of_y, (*c).into());
                            msm
                        }
                        CommitmentReference::MSM(msm) => {
                            let mut msm = msm.clone();
                            msm.scale(power_of_y);
                            msm
                        }
                    };
                    (msm, r_eval)
                })
                .reduce(|(mut msm_acc, r_eval_acc), (msm, r_eval)| {
                    msm_acc.add_msm(&msm);
                    (msm_acc, r_eval_acc + r_eval)
                })
                .unwrap();

            inner_msm.scale(power_of_v * z_diff_i);
            outer_msm.add_msm(inner_msm);
            r_outer_acc += power_of_v * r_inner_acc * z_diff_i;
        }
        track!("cycle-tracker-report-end: v6b-sets-loop");
        track!("cycle-tracker-report-start: v6c-final");
        let mut outer_msm = outer_msm.normalize();
        let g1: E::G1 = self.params.g[0].into();
        outer_msm.append_term(-r_outer_acc, g1);
        outer_msm.append_term(-z_0, h1.into());
        outer_msm.append_term(*u, h2.into());

        msm_accumulator.left.append_term(E::Fr::ONE, h2.into());

        msm_accumulator.right.add_msm(&outer_msm);
        track!("cycle-tracker-report-end: v6c-final");

        Ok(Self::Guard::new(msm_accumulator))
    }
}

/// L_j(u) = Π_{k≠j} (u − p_k) / (p_j − p_k) for each of the distinct points p_j, with one batch inversion.
fn lagrange_basis_at<F: Field>(points: &[F], u: F) -> Vec<F> {
    let n = points.len();
    let mut denoms: Vec<F> = (0..n)
        .map(|j| (0..n).filter(|&k| k != j).fold(F::ONE, |acc, k| acc * (points[j] - points[k])))
        .collect();
    denoms.iter_mut().batch_invert();
    (0..n)
        .map(|j| (0..n).filter(|&k| k != j).fold(denoms[j], |acc, k| acc * (u - points[k])))
        .collect()
}
