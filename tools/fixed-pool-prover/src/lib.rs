//! A fixed-denomination pool withdrawal, proved in the browser.
//!
//! The page hands in the pool's commitments in leaf order, builds the tree once, reads its root to check the
//! chain knows it, and then proves a withdrawal of one note to one recipient. The proof is made against the
//! circuit and proving key that ship inside the pool crate, so nothing is downloaded and nothing is compiled
//! at run time. What comes back is the pool call, ready to send.

use alloy_primitives::{Address, B256, U256};
use kohaku_tornadocash::{
    merkle_tree::{MerkleTree, MerkleTreeExt},
    Field, Note, Payer, Pool, Withdrawal,
};
use wasm_bindgen::prelude::*;

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

// A field element as the 32 big-endian bytes the pool contract takes.
fn word(f: Field) -> String {
    let w: B256 = f.into();
    format!("0x{}", hex::encode(w.0))
}

/// A pool's tree, held in wasm memory until freed.
#[wasm_bindgen]
pub struct Tree {
    inner: MerkleTree,
    leaves: u32,
}

#[wasm_bindgen]
impl Tree {
    /// `leaves` is the commitments back to back, 32 bytes each, in leaf order from index 0.
    #[wasm_bindgen(constructor)]
    pub fn new(leaves: &[u8]) -> Result<Tree, JsError> {
        if leaves.len() % 32 != 0 {
            return Err(err("leaves must be whole 32-byte words"));
        }
        let fields = leaves
            .chunks_exact(32)
            .map(|c| Field::try_from(B256::from_slice(c)))
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        let inner = MerkleTree::from_leaves(&fields).map_err(err)?;
        Ok(Tree { inner, leaves: fields.len() as u32 })
    }

    /// The root, as 0x-prefixed lowercase hex.
    pub fn root(&self) -> String {
        word(self.inner.root())
    }

    /// How many leaves the tree holds.
    pub fn leaves(&self) -> u32 {
        self.leaves
    }

    /// Proves the withdrawal of the note whose 62-byte preimage is `preimage_hex` from the pool at `pool` on
    /// `chain_id`, to `recipient`, with no relayer and no fee. Returns JSON:
    /// `{"root","nullifierHash","target","input","proof"}`, where `target` and `input` are the call to send.
    pub fn prove(&self, chain_id: u32, pool: &str, preimage_hex: &str, recipient: &str) -> Result<String, JsError> {
        self.prove_with(chain_id, pool, preimage_hex, recipient, Payer::default())
    }

    /// The same, with `relayer` named in the proof and `fee` (wei, decimal or 0x hex) taken from the note for it.
    /// The proof is good only with that relayer and that fee.
    pub fn prove_relayed(
        &self,
        chain_id: u32,
        pool: &str,
        preimage_hex: &str,
        recipient: &str,
        relayer: &str,
        fee: &str,
    ) -> Result<String, JsError> {
        let payer = Payer {
            address: relayer.parse().map_err(err)?,
            fee: fee.parse::<U256>().map_err(err)?,
            refund: U256::ZERO,
        };
        self.prove_with(chain_id, pool, preimage_hex, recipient, payer)
    }
}

impl Tree {
    fn prove_with(
        &self,
        chain_id: u32,
        pool: &str,
        preimage_hex: &str,
        recipient: &str,
        payer: Payer,
    ) -> Result<String, JsError> {
        let pool_address: Address = pool.parse().map_err(err)?;
        let recipient: Address = recipient.parse().map_err(err)?;
        let pool = Pool::POOLS
            .iter()
            .find(|p| p.chain_id == u64::from(chain_id) && p.address == pool_address)
            .ok_or_else(|| err("that address is not a known pool on this network"))?;

        let bytes = hex::decode(preimage_hex.trim_start_matches("0x")).map_err(err)?;
        if bytes.len() != 62 {
            return Err(err("a note is 62 bytes"));
        }
        let mut nullifier = [0u8; 31];
        let mut secret = [0u8; 31];
        nullifier.copy_from_slice(&bytes[..31]);
        secret.copy_from_slice(&bytes[31..]);
        let note = Note::new(nullifier, secret);

        let proof = self.inner.note_proof(&note).map_err(err)?;
        let withdrawal = Withdrawal::new(pool, note, recipient)
            .with_payer(payer)
            .prove(&proof, &mut rand::rng())
            .map_err(err)?;
        let call = withdrawal.call();
        Ok(serde_json::json!({
            "root": word(withdrawal.root()),
            "nullifierHash": word(withdrawal.note().nullifier_hash()),
            "target": format!("{:#x}", call.target),
            "input": format!("0x{}", hex::encode(&call.input)),
            "proof": format!("0x{}", hex::encode(withdrawal.solidity_proof())),
        })
        .to_string())
    }
}
