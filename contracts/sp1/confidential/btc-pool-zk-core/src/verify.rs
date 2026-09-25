//! Native Groth16 check of spend.circom for indexers and relayers, on the guest's `groth16_bn254_verify`.
//!
//! Public inputs, in circuit order: root, bodyHash, asset, nf[2], outLeaf[3], exitC.x, exitC.y, depC.x,
//! depC.y. The indexer derives every one of them itself: root from `h_anchor`, bodyHash and asset from
//! the body bytes, nf / outLeaf from the body (0 for an absent slot), exitC / depC from a verified
//! boundary (identity (0, 1) when absent).

use crate::groth16::groth16_bn254_verify;
use crate::{fr_to_be, Pt, N_IN, N_OUT, N_PUBLIC};
use bn::Fr;
use cxfer_core::{dec_to_be32, G16Proof, G16Vk, G1Aff, G2Aff};
use sha2::{Digest, Sha256};

pub const PROOF_WIRE_LEN: usize = 256;

pub struct SpendPublic {
    pub root: Fr,
    pub body_hash: Fr,
    pub asset: Fr,
    pub nf: [Fr; N_IN],
    pub out_leaf: [Fr; N_OUT],
    pub exit_c: Pt,
    pub dep_c: Pt,
}

impl SpendPublic {
    pub fn inputs(&self) -> Vec<[u8; 32]> {
        let mut v = Vec::with_capacity(N_PUBLIC);
        v.push(fr_to_be(&self.root));
        v.push(fr_to_be(&self.body_hash));
        v.push(fr_to_be(&self.asset));
        v.extend(self.nf.iter().map(fr_to_be));
        v.extend(self.out_leaf.iter().map(fr_to_be));
        v.push(fr_to_be(&self.exit_c.0));
        v.push(fr_to_be(&self.exit_c.1));
        v.push(fr_to_be(&self.dep_c.0));
        v.push(fr_to_be(&self.dep_c.1));
        v
    }
}

fn rd32(b: &[u8], o: usize) -> [u8; 32] {
    b[o..o + 32].try_into().unwrap()
}

/// A(64) ‖ B(128) ‖ C(64), big-endian limbs, G2 as (x_c0, x_c1, y_c0, y_c1).
pub fn proof_from_wire(b: &[u8]) -> Option<G16Proof> {
    if b.len() != PROOF_WIRE_LEN {
        return None;
    }
    Some(G16Proof {
        a: (rd32(b, 0), rd32(b, 32)),
        b: (rd32(b, 64), rd32(b, 96), rd32(b, 128), rd32(b, 160)),
        c: (rd32(b, 192), rd32(b, 224)),
    })
}

/// Parse a snarkjs `verification_key.json` (groth16, bn128) with exactly N_PUBLIC public inputs.
pub fn vk_from_snarkjs_json(json: &str) -> Option<G16Vk> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    if v["protocol"] != "groth16" || v["curve"] != "bn128" || v["nPublic"].as_u64()? as usize != N_PUBLIC {
        return None;
    }
    let s = |x: &serde_json::Value| dec_to_be32(x.as_str()?);
    let g1 = |p: &serde_json::Value| -> Option<G1Aff> { Some((s(&p[0])?, s(&p[1])?)) };
    let g2 = |p: &serde_json::Value| -> Option<G2Aff> {
        Some((s(&p[0][0])?, s(&p[0][1])?, s(&p[1][0])?, s(&p[1][1])?))
    };
    let ic = v["IC"].as_array()?.iter().map(g1).collect::<Option<Vec<_>>>()?;
    if ic.len() != N_PUBLIC + 1 {
        return None;
    }
    Some(G16Vk {
        alpha1: g1(&v["vk_alpha_1"])?,
        beta2: g2(&v["vk_beta_2"])?,
        gamma2: g2(&v["vk_gamma_2"])?,
        delta2: g2(&v["vk_delta_2"])?,
        ic,
    })
}

/// SHA-256 over alpha1 ‖ beta2 ‖ gamma2 ‖ delta2 ‖ IC, the byte layout groth16.rs bakes. Pin this.
pub fn vk_hash(vk: &G16Vk) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(vk.alpha1.0);
    h.update(vk.alpha1.1);
    for g in [&vk.beta2, &vk.gamma2, &vk.delta2] {
        h.update(g.0);
        h.update(g.1);
        h.update(g.2);
        h.update(g.3);
    }
    for p in &vk.ic {
        h.update(p.0);
        h.update(p.1);
    }
    h.finalize().into()
}

pub fn verify_spend(vk: &G16Vk, proof_wire: &[u8], public: &SpendPublic) -> bool {
    match proof_from_wire(proof_wire) {
        Some(p) => groth16_bn254_verify(vk, &p, &public.inputs()),
        None => false,
    }
}
