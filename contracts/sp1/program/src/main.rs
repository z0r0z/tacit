#![no_main]
sp1_zkvm::entrypoint!(main);

use sp1_zkvm::io;

mod poseidon;
mod bitcoin;
mod merkle;
mod groth16;

/// SP1 guest program: Tacit tETH pool state prover.
///
/// Processes COMPLETE Bitcoin blocks — the prover supplies all transactions
/// per block and the guest recomputes each block's merkle root from all txids.
/// Any omitted or fabricated transaction causes a merkle root mismatch. This
/// is Bitcoin's own block validity rule applied inside the zkVM.
///
/// Verifies every Groth16 proof inside each Tacit envelope using ark-groth16
/// with an immutable VK (hash committed publicly, checked on-chain).
///
/// Tracks consumed nullifiers in a Poseidon tree. Burns are recorded as
/// exact claim IDs (SHA256 of nullifier + denom + poolRoot + recipient + bindHash)
/// so the Ethereum contract can verify each withdrawal matches a specific
/// SP1-accepted burn, not just any burn with the same nullifier.
///
/// Canonical Bitcoin guarantee: the guest verifies header linkage + per-header
/// PoW as defense-in-depth. The on-chain SP1 verifier enforces that the
/// proven state's lastBlockHash equals the BitcoinLightRelay's canonical tip.
/// The relay validates the full Bitcoin difficulty schedule, heaviest-chain
/// fork choice, and cumulative work — the guest relies on the relay for
/// these properties rather than reimplementing Bitcoin consensus.
///
/// V1 constraint: each proof batch processes ALL state transitions from genesis
/// (the Poseidon tree rebuilds from scratch). This is correct but not scalable
/// for large pools. Incremental state (carrying forward leaf lists / Merkle
/// frontiers between batches) is a follow-up optimization. The state continuity
/// checks (prev_pool_root, prev_nullifier_root, prev_state_height,
/// prev_last_block_hash) ensure the verifier rejects discontinuous proofs.
pub fn main() {
    // ──── State continuity ────
    let prev_pool_root: Vec<u8> = io::read();
    let prev_nullifier_root: Vec<u8> = io::read();
    let prev_state_height: u64 = io::read();

    // Accept deposits referencing ANY of these Ethereum deposit roots.
    // The prover supplies the set of valid roots from the mixer's root history.
    let num_deposit_roots: u32 = io::read();
    let mut valid_deposit_roots: Vec<[u8; 32]> = Vec::new();
    for _ in 0..num_deposit_roots {
        let r: Vec<u8> = io::read();
        valid_deposit_roots.push(r.try_into().expect("dep root 32"));
    }
    // Commit the deposit root set hash so the mixer can verify these are real.
    let deposit_roots_hash: [u8; 32] = {
        use sha2::{Sha256, Digest};
        let mut h = Sha256::new();
        for r in &valid_deposit_roots { h.update(r); }
        h.finalize().into()
    };

    let prev_root32: [u8; 32] = prev_pool_root.try_into().expect("root 32");
    let prev_null_root32: [u8; 32] = prev_nullifier_root.try_into().expect("null root 32");

    let vk_bytes: Vec<u8> = io::read();
    let vk_hash = poseidon::hash_bytes(&vk_bytes);

    // ──── Domain binding ────
    let asset_id: Vec<u8> = io::read();
    let network_tag: u8 = io::read();
    let chain_id: u64 = io::read();
    let mixer_address: Vec<u8> = io::read();
    let asset_id32: [u8; 32] = asset_id.clone().try_into().expect("asset 32");

    // ──── Initialize state ────
    // V1: genesis replay — start from empty trees.
    // prev_root32 and prev_null_root32 must be zeros (enforced by Solidity verifier).
    assert!(prev_root32 == [0u8; 32], "v1: prev pool root must be genesis");
    assert!(prev_null_root32 == [0u8; 32], "v1: prev null root must be genesis");

    let mut tree = merkle::PoseidonTree::new();
    let mut null_tree = merkle::NullifierTree::new();
    let mut burn_nullifiers: Vec<[u8; 32]> = Vec::new();
    let mut transition_count: u64 = 0;

    // ──── Process complete Bitcoin blocks ────
    let num_blocks: u32 = io::read();
    assert!(num_blocks > 0 || prev_state_height == 0, "blocks required for non-genesis");

    // Previous proven Bitcoin block — first header must extend it.
    let prev_last_block_hash: Vec<u8> = io::read();
    let prev_block32: [u8; 32] = prev_last_block_hash.try_into().expect("prev block 32");

    let mut prev_header_hash: Option<[u8; 32]> = if prev_block32 != [0u8; 32] {
        Some(prev_block32)
    } else {
        None
    };
    let mut last_block_hash = [0u8; 32];

    for _ in 0..num_blocks {
        let header: Vec<u8> = io::read();
        assert!(header.len() == 80, "header 80 bytes");

        // Verify PoW.
        let block_hash = bitcoin::double_sha256(&header);
        let target = bitcoin::bits_to_target(&header);
        assert!(bitcoin::le_bytes_lte(&bitcoin::reverse_u256(&block_hash), &target), "invalid PoW");

        // Verify chain linkage.
        if let Some(prev) = prev_header_hash {
            let prev_block: [u8; 32] = header[4..36].try_into().unwrap();
            assert!(prev_block == prev, "broken header chain");
        }
        let block_merkle_root = bitcoin::extract_merkle_root(&header);
        prev_header_hash = Some(block_hash);
        last_block_hash = block_hash;

        // Read ALL transactions in this block.
        let num_txs: u32 = io::read();
        // Verify all txs hash to the block's merkle root.
        let mut txids: Vec<[u8; 32]> = Vec::new();

        for _ in 0..num_txs {
            let tx_data: Vec<u8> = io::read();
            let txid = bitcoin::double_sha256(&tx_data);
            txids.push(txid);

            // Scan ALL OP_RETURN outputs for Tacit envelopes.
            let op_returns = bitcoin::extract_all_op_returns(&tx_data);
            for envelope in op_returns {
            if envelope.is_empty() { continue; }

            let opcode = envelope[0];
            if envelope.len() < 34 { continue; }
            if envelope[1] != network_tag { continue; }
            let env_asset: [u8; 32] = match envelope[2..34].try_into() {
                Ok(a) => a,
                Err(_) => continue,
            };
            if env_asset != asset_id32 { continue; }

            match opcode {
                0x60 => {
                    // T_BRIDGE_DEPOSIT
                    if envelope.len() < 517 { continue; }
                    let env_eth_root: [u8; 32] = envelope[66..98].try_into().unwrap();
                    if !valid_deposit_roots.contains(&env_eth_root) { continue; }

                    let env_leaf: [u8; 32] = envelope[163..195].try_into().unwrap();
                    let env_nullifier: [u8; 32] = envelope[98..130].try_into().unwrap();

                    let proof = extract_groth16_from_mint_envelope(&envelope);
                    let inputs = extract_mint_public_inputs(&envelope);
                    verify_groth16(&proof, &inputs, &vk_bytes);

                    null_tree.insert(env_nullifier);
                    tree.insert(env_leaf);
                    transition_count += 1;
                }
                0x62 => {
                    // T_BRIDGE_ROTATE
                    if envelope.len() < 537 { continue; }
                    let env_nullifier: [u8; 32] = envelope[98..130].try_into().unwrap();

                    // New leaf commitment is in the rotate envelope at the same
                    // offset as the deposit leaf (offset 163, after recipient_commit).
                    let new_leaf32: [u8; 32] = envelope[163..195].try_into().unwrap();

                    let proof = extract_groth16_from_burn_envelope(&envelope);
                    let inputs = extract_burn_public_inputs(&envelope);
                    verify_groth16(&proof, &inputs, &vk_bytes);

                    null_tree.insert(env_nullifier);
                    tree.insert(new_leaf32);
                    transition_count += 1;
                }
                0x61 => {
                    // T_BRIDGE_BURN
                    if envelope.len() < 537 { continue; }
                    let env_nullifier: [u8; 32] = envelope[98..130].try_into().unwrap();
                    let env_denom: [u8; 32] = envelope[34..66].try_into().unwrap();
                    let env_pool_root: [u8; 32] = envelope[66..98].try_into().unwrap();
                    let env_recipient: [u8; 20] = envelope[195..215].try_into().unwrap();
                    let env_bind_hash: [u8; 32] = envelope[247..279].try_into().unwrap();

                    let proof = extract_groth16_from_burn_envelope(&envelope);
                    let inputs = extract_burn_public_inputs(&envelope);
                    verify_groth16(&proof, &inputs, &vk_bytes);

                    null_tree.insert(env_nullifier);

                    // Commit exact burn claim ID = SHA256(nullifier || denom || poolRoot || recipient || bindHash)
                    {
                        use sha2::{Sha256, Digest};
                        let mut h = Sha256::new();
                        h.update(&env_nullifier);
                        h.update(&env_denom);
                        h.update(&env_pool_root);
                        h.update(&env_recipient);
                        h.update(&env_bind_hash);
                        let claim_id: [u8; 32] = h.finalize().into();
                        burn_nullifiers.push(claim_id);
                    }
                    transition_count += 1;
                }
                _ => {}
            }
            } // end for envelope in op_returns
        } // end for tx in block

        // Verify block tx completeness: all txids must hash to the block merkle root.
        let computed_root = bitcoin::compute_merkle_root(&txids);
        assert!(computed_root == block_merkle_root, "tx merkle root mismatch");
    }

    // Compute burn batch hash.
    let burn_batch_hash: [u8; 32] = if burn_nullifiers.is_empty() {
        [0u8; 32]
    } else {
        use sha2::{Sha256, Digest};
        let mut h = Sha256::new();
        for n in &burn_nullifiers { h.update(n); }
        h.finalize().into()
    };

    let new_state_height = prev_state_height + transition_count;
    let new_pool_root = tree.root();
    let new_nullifier_root = null_tree.root();

    // ──── Commit public outputs ────
    io::commit_slice(&prev_root32);
    io::commit_slice(&prev_null_root32);
    io::commit_slice(&prev_state_height.to_be_bytes());
    io::commit_slice(&prev_block32);
    io::commit_slice(&new_pool_root);
    io::commit_slice(&new_nullifier_root);
    io::commit_slice(&new_state_height.to_be_bytes());
    io::commit_slice(&deposit_roots_hash);
    io::commit_slice(&vk_hash);
    io::commit_slice(&burn_batch_hash);
    io::commit_slice(&asset_id);
    io::commit_slice(&[network_tag]);
    io::commit_slice(&chain_id.to_be_bytes());
    io::commit_slice(&mixer_address);
    io::commit_slice(&last_block_hash);
}

fn extract_groth16_from_mint_envelope(env: &[u8]) -> Vec<u8> {
    let proof_len = u16::from_le_bytes([env[259], env[260]]) as usize;
    env[261..261 + proof_len].to_vec()
}

fn extract_groth16_from_burn_envelope(env: &[u8]) -> Vec<u8> {
    let proof_len = u16::from_le_bytes([env[279], env[280]]) as usize;
    env[281..281 + proof_len].to_vec()
}

fn extract_mint_public_inputs(env: &[u8]) -> Vec<[u8; 32]> {
    vec![
        env[66..98].try_into().unwrap(),
        env[98..130].try_into().unwrap(),
        env[34..66].try_into().unwrap(),
        env[195..227].try_into().unwrap(),
        env[227..259].try_into().unwrap(),
    ]
}

fn extract_burn_public_inputs(env: &[u8]) -> Vec<[u8; 32]> {
    vec![
        env[66..98].try_into().unwrap(),
        env[98..130].try_into().unwrap(),
        env[34..66].try_into().unwrap(),
        env[163..195].try_into().unwrap(),
        env[247..279].try_into().unwrap(),
    ]
}

fn verify_groth16(proof_bytes: &[u8], public_inputs: &[[u8; 32]], vk_bytes: &[u8]) {
    assert!(proof_bytes.len() == 256, "invalid proof size");
    assert!(groth16::verify(proof_bytes, public_inputs, vk_bytes), "groth16 verification failed");
}
