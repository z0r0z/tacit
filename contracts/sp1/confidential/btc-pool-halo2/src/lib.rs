//! Halo2-KZG (BN254, SHPLONK, BLAKE2b transcript) prover and verifier for the Bitcoin shielded pool spend
//! relation of dapp/circuits/btc-pool/spend.circom, with the same 12 public inputs in the same order.
//! SRS: the pinned Hermez pot18 (src/srs.rs). Keys are derived deterministically from the SRS and circuit.

pub mod circuit;
pub mod fixture;
pub mod model;
pub mod srs;
#[cfg(feature = "wasm")]
pub mod wasm;

pub use circuit::{SpendCircuit, K};
pub use model::{SpendWitness, N_PUBLIC};

use blake2::{Blake2b512, Digest};
use ff::Field;
use halo2_proofs::{
    dev::MockProver,
    halo2curves::bn256::{Bn256, Fr, G1Affine},
    plonk::{create_proof, keygen_pk, keygen_vk, verify_proof, ProvingKey, VerifyingKey},
    poly::{
        commitment::ParamsProver,
        kzg::{
            commitment::{KZGCommitmentScheme, ParamsKZG},
            multiopen::{ProverSHPLONK, VerifierSHPLONK},
            strategy::SingleStrategy,
        },
    },
    transcript::{Blake2bRead, Blake2bWrite, Challenge255, TranscriptReadBuffer, TranscriptWriterBuffer},
    SerdeFormat,
};
use rand_core::OsRng;

pub type Params = ParamsKZG<Bn256>;
pub type Pk = ProvingKey<G1Affine>;
pub type Vk = VerifyingKey<G1Affine>;

pub fn keygen(params: &Params) -> Result<Pk, String> {
    let empty = SpendCircuit::default();
    let vk = keygen_vk(params, &empty).map_err(|e| format!("keygen_vk: {e:?}"))?;
    keygen_pk(params, vk, &empty).map_err(|e| format!("keygen_pk: {e:?}"))
}

/// Proving key from a serialized vk (skips the vk's fixed and permutation commitments).
pub fn keygen_with_vk(params: &Params, vk: &[u8]) -> Result<Pk, String> {
    let vk = vk_from_bytes(vk)?;
    keygen_pk(params, vk, &SpendCircuit::default()).map_err(|e| format!("keygen_pk: {e:?}"))
}

pub fn vk_bytes(vk: &Vk) -> Vec<u8> {
    vk.to_bytes(SerdeFormat::RawBytes)
}
pub fn vk_from_bytes(b: &[u8]) -> Result<Vk, String> {
    Vk::from_bytes::<SpendCircuit>(b, SerdeFormat::RawBytes).map_err(|e| e.to_string())
}
/// BLAKE2b-512 of the serialized verifying key (the value an indexer pins).
pub fn vk_digest(vk: &Vk) -> String {
    hex::encode(Blake2b512::digest(vk_bytes(vk)))
}

pub fn prove(params: &Params, pk: &Pk, w: &SpendWitness) -> Result<Vec<u8>, String> {
    let inst = w.publics();
    let circuit = SpendCircuit { w: Some(w.clone()) };
    let mut tr = Blake2bWrite::<_, G1Affine, Challenge255<_>>::init(vec![]);
    create_proof::<KZGCommitmentScheme<Bn256>, ProverSHPLONK<'_, Bn256>, _, _, _, _>(params, pk, &[circuit], &[&[&inst]], OsRng, &mut tr)
        .map_err(|e| format!("create_proof: {e:?}"))?;
    Ok(tr.finalize())
}

pub fn verify(params: &Params, vk: &Vk, publics: &[Fr; N_PUBLIC], proof: &[u8]) -> bool {
    let mut tr = Blake2bRead::<_, G1Affine, Challenge255<_>>::init(proof);
    let strategy = SingleStrategy::new(params);
    verify_proof::<KZGCommitmentScheme<Bn256>, VerifierSHPLONK<'_, Bn256>, _, _, _>(params.verifier_params(), vk, strategy, &[&[publics]], &mut tr).is_ok()
}

/// Constraint check without a proof (the analogue of snarkjs wtns check).
pub fn satisfies(w: &SpendWitness) -> Result<(), String> {
    let f = failures(w);
    if f.is_empty() {
        Ok(())
    } else {
        Err(format!("{} failed constraints, first: {}", f.len(), f[0]))
    }
}

/// Every failed constraint for a witness, as MockProver reports them (region names locate the check).
pub fn failures(w: &SpendWitness) -> Vec<String> {
    let circuit = SpendCircuit { w: Some(w.clone()) };
    match MockProver::run(K, &circuit, vec![w.publics().to_vec()]) {
        Err(e) => vec![format!("synthesis: {e:?}")],
        Ok(p) => match p.verify() {
            Ok(()) => vec![],
            Err(fs) => fs.iter().map(|f| f.to_string()).collect(),
        },
    }
}

/// Public signals as snarkjs prints them: decimal strings.
pub fn publics_to_dec(p: &[Fr; N_PUBLIC]) -> Vec<String> {
    p.iter().map(model::to_dec).collect()
}

/// Strict parse: 12 canonical decimal field elements (no reduction).
pub fn publics_from_dec(xs: &[String]) -> Result<[Fr; N_PUBLIC], String> {
    if xs.len() != N_PUBLIC {
        return Err(format!("expected {N_PUBLIC} public signals"));
    }
    let mut out = [Fr::ZERO; N_PUBLIC];
    for (i, s) in xs.iter().enumerate() {
        if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
            return Err(format!("public {i}: not a decimal"));
        }
        let b = model::big(s);
        if &b >= model::p_big() {
            return Err(format!("public {i}: not in the field"));
        }
        out[i] = model::fr(&b);
    }
    Ok(out)
}

/// {proof: hex, publics: [dec; 12]} → bool.
pub fn verify_json(params: &Params, vk: &Vk, doc: &serde_json::Value) -> Result<bool, String> {
    let proof = doc.get("proof").and_then(|p| p.as_str()).ok_or("missing proof")?;
    let proof = hex::decode(proof.trim_start_matches("0x")).map_err(|_| "proof: bad hex")?;
    let pubs: Vec<String> = doc
        .get("publics")
        .and_then(|p| p.as_array())
        .ok_or("missing publics")?
        .iter()
        .map(|x| x.as_str().map(str::to_string).or_else(|| x.as_u64().map(|n| n.to_string())).ok_or("publics: expected strings"))
        .collect::<Result<_, _>>()?;
    Ok(verify(params, vk, &publics_from_dec(&pubs)?, &proof))
}

/// Indexer rules outside the circuit (btc-pool-zk.js publicsAcceptable): non-zero nullifiers pairwise
/// distinct; a spend has at least one, a shield none.
pub fn publics_acceptable(nf: &[Fr], shield: bool) -> bool {
    let live: Vec<&Fr> = nf.iter().filter(|x| !bool::from(x.is_zero())).collect();
    for (i, a) in live.iter().enumerate() {
        if live[i + 1..].contains(a) {
            return false;
        }
    }
    if shield {
        live.is_empty()
    } else {
        !live.is_empty()
    }
}
