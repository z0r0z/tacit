//! The spend relation's keys, loaded from the pinned artifacts: what a leader checks a submitted spend's proof against natively, and the
//! transcript hints the block program takes beside each proof.

use btc_pool_agg_common as agg;
use btc_pool_halo2 as h2;
use halo2_proofs::halo2curves::bn256::{Bn256, Fr};
use halo2_proofs::poly::kzg::commitment::ParamsKZG;

const H2_ARTIFACTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../btc-pool-halo2/artifacts");
const ARTIFACTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../artifacts");

pub struct Keys {
    params: h2::Params,
    pk: h2::Pk,
    vparams: ParamsKZG<Bn256>,
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
        let vparams = agg::verifier_params(&read(&format!("{ARTIFACTS}/verifier-params.bin"))?).ok_or("verifier params")?;
        Ok(Keys { params, pk, vparams })
    }

    /// Whether `proof` verifies for `publics` (12 field elements), and its transcript hints when it does.
    pub fn check(&self, publics: &[Fr], proof: &[u8]) -> Option<Vec<u8>> {
        let fixed = <[Fr; 12]>::try_from(publics).ok()?;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if !h2::verify(&self.params, self.pk.get_vk(), &fixed, proof) {
                return None;
            }
            agg::record_hints(&self.vparams, self.pk.get_vk(), publics, proof).ok().map(|(h, _)| h)
        }))
        .unwrap_or(None)
    }

    /// Whether a proof and the hints beside it are a pair the block program takes (what a posted spend's builder claims).
    pub fn check_hinted(&self, publics: &[Fr], proof: &[u8], hints: &[u8]) -> bool {
        self.check(publics, proof).is_some_and(|h| h.as_slice() == hints)
    }
}
