//! Browser / Node bindings. Build: wasm/build.sh (single-thread and, with wasm-threads, a rayon pool over
//! Web Workers via wasm-bindgen-rayon; call initThreadPool(n) first).

use crate::{fixture::Fixture, keygen, model::SpendWitness, publics_to_dec, srs, verify_json, vk_bytes, vk_digest, vk_from_bytes, Params, Pk};
use wasm_bindgen::prelude::*;

#[cfg(feature = "wasm-threads")]
pub use wasm_bindgen_rayon::init_thread_pool;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// Holds the params and the proving key derived from them (deterministic; no key download).
#[wasm_bindgen]
pub struct Prover {
    params: Params,
    pk: Pk,
}

#[wasm_bindgen]
impl Prover {
    /// `params`: the pinned params file (artifacts/params-k13.bin).
    #[wasm_bindgen(constructor)]
    pub fn new(params: &[u8]) -> Result<Prover, JsError> {
        let params = srs::read_params(params).map_err(err)?;
        let pk = keygen(&params).map_err(err)?;
        Ok(Prover { params, pk })
    }

    /// Same key without recomputing the vk commitments: `vk` is the pinned vk file; the proving key is
    /// rebuilt from it (a wrong vk only yields proofs that fail verification against the pinned one).
    #[wasm_bindgen(js_name = withVk)]
    pub fn with_vk(params: &[u8], vk: &[u8]) -> Result<Prover, JsError> {
        let params = srs::read_params(params).map_err(err)?;
        let pk = crate::keygen_with_vk(&params, vk).map_err(err)?;
        Ok(Prover { params, pk })
    }

    /// BLAKE2b-512 of the verifying key, hex.
    #[wasm_bindgen(js_name = vkDigest)]
    pub fn vk_digest(&self) -> String {
        vk_digest(self.pk.get_vk())
    }

    pub fn vk(&self) -> Vec<u8> {
        vk_bytes(self.pk.get_vk())
    }

    /// `input`: the JSON of btc-pool-zk.js buildWitness(...).input. Returns {"proof": hex, "publics": [dec; 12]}.
    pub fn prove(&self, input: &str) -> Result<String, JsError> {
        let v: serde_json::Value = serde_json::from_str(input).map_err(err)?;
        let w = SpendWitness::from_json(&v).map_err(err)?;
        let proof = crate::prove(&self.params, &self.pk, &w).map_err(err)?;
        Ok(serde_json::json!({ "proof": hex::encode(proof), "publics": publics_to_dec(&w.publics()) }).to_string())
    }

    /// `doc`: {"proof": hex, "publics": [dec; 12]}.
    pub fn verify(&self, doc: &str) -> Result<bool, JsError> {
        let v: serde_json::Value = serde_json::from_str(doc).map_err(err)?;
        verify_json(&self.params, self.pk.get_vk(), &v).map_err(err)
    }
}

/// Stand-alone verify against pinned params and vk bytes.
#[wasm_bindgen(js_name = verifySpend)]
pub fn verify_spend(params: &[u8], vk: &[u8], doc: &str) -> Result<bool, JsError> {
    let params = srs::read_params(params).map_err(err)?;
    let vk = vk_from_bytes(vk).map_err(err)?;
    let v: serde_json::Value = serde_json::from_str(doc).map_err(err)?;
    verify_json(&params, &vk, &v).map_err(err)
}

/// Fixture witness (pay | partialExit | shield) in buildWitness input JSON, for benchmarks.
#[wasm_bindgen(js_name = sampleInput)]
pub fn sample_input(name: &str) -> Result<String, JsError> {
    let f = Fixture::new();
    let w = match name {
        "pay" => f.pay(),
        "partialExit" => f.partial_exit(),
        "shield" => f.shield(),
        _ => return Err(err("unknown sample")),
    };
    Ok(w.to_json().to_string())
}

#[wasm_bindgen(js_name = numThreads)]
pub fn num_threads() -> usize {
    rayon::current_num_threads()
}
