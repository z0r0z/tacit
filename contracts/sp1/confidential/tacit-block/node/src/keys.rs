//! The spend relation's keys, loaded from the pinned artifacts: what a leader checks a submitted spend's proof against natively, and the
//! transcript hints the block program takes beside each proof.

use btc_pool_agg_common as agg;
use btc_pool_halo2 as h2;
use halo2_proofs::halo2curves::bn256::{Bn256, Fr, G2Affine};
use halo2_proofs::poly::kzg::commitment::ParamsKZG;

const H2_ARTIFACTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../btc-pool-halo2/artifacts");
const ARTIFACTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../artifacts");

pub struct Keys {
    params: h2::Params,
    pk: h2::Pk,
    vparams: ParamsKZG<Bn256>,
    /// The pairing check's G2 points, as the block program reads them from the same file.
    g2: G2Affine,
    s_g2: G2Affine,
}

fn read(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("{path}: {e}"))
}

impl Keys {
    /// Loads the key the artifacts pin, refusing a `vk.bin` that is not the one `vk-digest.bin` names.
    pub fn load() -> Result<Keys, String> {
        use blake2::{Blake2b512, Digest};
        let vk_bytes = read(&format!("{H2_ARTIFACTS}/vk.bin"))?;
        let digest = read(&format!("{ARTIFACTS}/vk-digest.bin"))?;
        if Blake2b512::digest(&vk_bytes).as_slice() != digest.as_slice() {
            return Err("vk.bin is not the key the pinned digest names".into());
        }
        let params = h2::srs::read_params(&read(&format!("{H2_ARTIFACTS}/params-k{}.bin", h2::K))?)?;
        let pk = h2::keygen_with_vk(&params, &vk_bytes)?;
        let verifier = read(&format!("{ARTIFACTS}/verifier-params.bin"))?;
        let vparams = agg::verifier_params(&verifier).ok_or("verifier params")?;
        let (_, _, g2, s_g2) = agg::decode_params(&verifier).ok_or("verifier params")?;
        Ok(Keys { params, pk, vparams, g2, s_g2 })
    }

    /// Whether `proof` verifies for `publics` (12 field elements), and its transcript hints when it does: hints the block program reads
    /// the proof with, so a spend this returns for is one a block can hold.
    pub fn check(&self, publics: &[Fr], proof: &[u8]) -> Option<Vec<u8>> {
        let fixed = <[Fr; 12]>::try_from(publics).ok()?;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if !h2::verify(&self.params, self.pk.get_vk(), &fixed, proof) {
                return None;
            }
            agg::record_hints(&self.vparams, self.pk.get_vk(), publics, proof).ok().map(|(h, _)| h)
        }))
        .unwrap_or(None)
        .filter(|h| self.check_hinted(publics, proof, h))
    }

    /// Whether the block program finds a posted spend's pairing check holding when it reads `proof` against `hints`: the program's own
    /// decision for the entry, taken the way the program takes it (its transcript reader in hint mode, then one pairing), so that an
    /// entry the program passes joins the block's batched pairing and one it does not is passed over, whatever the proof holds.
    pub fn check_hinted(&self, publics: &[Fr], proof: &[u8], hints: &[u8]) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut tr = agg::HintRead::new(proof, agg::Mode::Hint(hints, 0));
            let Ok(dm) = agg::to_dual_msm(&self.vparams, self.pk.get_vk(), publics, &mut tr) else { return false };
            if !(tr.consumed() && tr.hints_used() == agg::PROOF_POINTS) {
                return false;
            }
            let mut one = agg::Batch::default();
            one.add(&dm, None);
            agg::native_check(&one, &self.g2, &self.s_g2)
        }))
        .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ff::Field;
    use halo2_proofs::halo2curves::bn256::Fq;
    use halo2_proofs::transcript::TranscriptRead;
    use std::sync::OnceLock;

    struct Case {
        keys: Keys,
        publics: [Fr; 12],
        proof: Vec<u8>,
        hints: Vec<u8>,
    }

    /// A real spend proof under the pinned key, with the hints the block program takes beside it.
    fn case() -> &'static Case {
        static C: OnceLock<Case> = OnceLock::new();
        C.get_or_init(|| {
            let keys = Keys::load().expect("the pinned keys load");
            let w = h2::fixture::Fixture::new().pay();
            let publics = w.publics();
            let proof = h2::prove(&keys.params, &keys.pk, &w).expect("a proof");
            let hints = keys.check(&publics, &proof).expect("a proof of a satisfied witness verifies");
            Case { keys, publics, proof, hints }
        })
    }

    /// What the node said of an entry before it followed the block program: stock verification, then the hints it records.
    fn stock(c: &Case, publics: &[Fr], proof: &[u8], hints: &[u8]) -> bool {
        c.keys.check(publics, proof).is_some_and(|h| h.as_slice() == hints)
    }

    #[test]
    fn the_two_readers_differ_on_the_origin_and_its_flagged_encoding() {
        let zero = [0u8; 32];
        let mut hint = agg::HintRead::new(&zero, agg::Mode::Hint(&[0u8; 64], 0));
        let p = hint.read_point().expect("hint mode takes it");
        assert!(p.x == Fq::ZERO && p.y == Fq::ZERO);
        assert!(agg::HintRead::new(&zero, agg::Mode::Record(vec![])).read_point().is_err());
        // the encoding halo2 writes for the point at infinity is the other way round
        let mut flagged = [0u8; 32];
        flagged[31] = 0x80;
        assert!(agg::HintRead::new(&flagged, agg::Mode::Hint(&[0u8; 64], 0)).read_point().is_err());
        assert!(agg::HintRead::new(&flagged, agg::Mode::Record(vec![])).read_point().is_ok());
    }

    #[test]
    fn a_real_proof_with_its_hints_is_taken() {
        let c = case();
        assert_eq!(c.proof.len(), agg::PROOF_LEN);
        assert_eq!(c.hints.len(), agg::HINTS_LEN);
        assert!(c.keys.check_hinted(&c.publics, &c.proof, &c.hints));
        assert!(stock(c, &c.publics, &c.proof, &c.hints));
    }

    #[test]
    fn other_hints_publics_or_proofs_are_passed_over() {
        let c = case();
        let mut cases: Vec<(Vec<Fr>, Vec<u8>, Vec<u8>)> = vec![];
        for at in [0, 31, 40, c.hints.len() / 2, c.hints.len() - 1] {
            let mut h = c.hints.clone();
            h[at] ^= 1;
            cases.push((c.publics.to_vec(), c.proof.clone(), h));
        }
        cases.push((c.publics.to_vec(), c.proof.clone(), c.hints[..c.hints.len() - 1].to_vec()));
        cases.push((c.publics.to_vec(), c.proof.clone(), vec![]));
        for at in [0, 5, 40, 1000, c.proof.len() / 2, c.proof.len() - 1] {
            let mut p = c.proof.clone();
            p[at] ^= 1;
            cases.push((c.publics.to_vec(), p, c.hints.clone()));
        }
        cases.push((c.publics.to_vec(), c.proof[..c.proof.len() - 32].to_vec(), c.hints.clone()));
        for i in [0, 5, 11] {
            let mut q = c.publics.to_vec();
            q[i] += Fr::ONE;
            cases.push((q, c.proof.clone(), c.hints.clone()));
        }
        for (publics, proof, hints) in &cases {
            assert!(!c.keys.check_hinted(publics, proof, hints));
            assert!(!stock(c, publics, proof, hints));
        }
    }

    #[test]
    fn a_point_at_the_origin_in_a_proof_that_does_not_hold_is_passed_over() {
        let c = case();
        for k in [0usize, 5, 13, 14] {
            let mut proof = c.proof.clone();
            let mut hints = c.hints.clone();
            // the k-th point read is the first 32 bytes of the proof's k-th point (a point is read before any scalar)
            proof[32 * k..32 * k + 32].fill(0);
            hints[64 * k..64 * k + 64].fill(0);
            assert!(!c.keys.check_hinted(&c.publics, &proof, &hints));
            assert!(!stock(c, &c.publics, &proof, &hints));
        }
    }
}
