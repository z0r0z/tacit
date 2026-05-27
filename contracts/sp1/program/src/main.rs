#![no_main]
sp1_zkvm::entrypoint!(main);

use sp1_zkvm::io;
use sha2::{Sha256, Digest};

mod poseidon;
mod bitcoin;
mod merkle;
mod groth16;

const TREE_DEPTH: usize = 20;

pub fn main() {
    // ──── Previous state ────
    let prev_pool_root: Vec<u8> = io::read();
    let prev_null_set_hash: Vec<u8> = io::read();
    let prev_state_height: u64 = io::read();

    let prev_root32: [u8; 32] = prev_pool_root.try_into().expect("root 32");
    let prev_null_hash32: [u8; 32] = prev_null_set_hash.try_into().expect("null hash 32");

    // ──── Pool tree frontier (private witness) ────
    let prev_pool_next_index: u64 = io::read();
    let mut prev_pool_frontier = [[0u8; 32]; TREE_DEPTH];
    for i in 0..TREE_DEPTH {
        let f: Vec<u8> = io::read();
        prev_pool_frontier[i] = f.try_into().expect("pool frontier 32");
    }

    // ──── Nullifier set (private witness — full historical list) ────
    let prev_null_count: u64 = io::read();
    let mut prev_nullifiers: Vec<[u8; 32]> = Vec::new();
    for _ in 0..prev_null_count {
        let n: Vec<u8> = io::read();
        prev_nullifiers.push(n.try_into().expect("nullifier 32"));
    }

    // ──── tETH UTXO set (private witness) ────
    let prev_utxo_count: u64 = io::read();
    let mut utxo_set: Vec<([u8; 32], u16, [u8; 33])> = Vec::new();
    for _ in 0..prev_utxo_count {
        let txid: Vec<u8> = io::read();
        let vout: u16 = io::read();
        let commit: Vec<u8> = io::read();
        utxo_set.push((
            txid.try_into().expect("utxo txid 32"),
            vout,
            commit.try_into().expect("utxo commit 33"),
        ));
    }

    // ──── Initialize state ────
    let is_genesis = prev_root32 == [0u8; 32] && prev_null_hash32 == [0u8; 32];
    let prev_state_commitment: [u8; 32];

    let mut tree;
    let mut null_set;
    if is_genesis {
        assert!(prev_state_height == 0, "genesis: height must be 0");
        assert!(prev_pool_next_index == 0, "genesis: pool index must be 0");
        assert!(prev_null_count == 0, "genesis: null count must be 0");
        assert!(prev_utxo_count == 0, "genesis: utxo count must be 0");
        for i in 0..TREE_DEPTH {
            assert!(prev_pool_frontier[i] == [0u8; 32], "genesis: pool frontier must be 0");
        }
        tree = merkle::PoseidonTree::new();
        null_set = merkle::NullifierSet::new();
        prev_state_commitment = [0u8; 32];
    } else {
        let prev_utxo_set_hash = compute_utxo_set_hash(&utxo_set);
        tree = merkle::PoseidonTree::from_frontier(
            prev_pool_frontier, prev_pool_next_index as usize, prev_root32,
        );
        null_set = merkle::NullifierSet::from_sorted(prev_nullifiers);
        assert!(null_set.hash() == prev_null_hash32, "nullifier set hash mismatch");
        prev_state_commitment = compute_state_commitment(
            &prev_root32, &prev_null_hash32, prev_state_height,
            prev_pool_next_index, &prev_pool_frontier,
            null_set.count(), &prev_utxo_set_hash,
        );
    }

    let mut known_pool_roots: Vec<[u8; 32]> = vec![tree.root()];

    // ──── Deposit roots ────
    let num_deposit_roots: u32 = io::read();
    let mut valid_deposit_roots: Vec<[u8; 32]> = Vec::new();
    for _ in 0..num_deposit_roots {
        let r: Vec<u8> = io::read();
        valid_deposit_roots.push(r.try_into().expect("dep root 32"));
    }
    // Compute accumulator in insertion order (matches mixer), then sort for O(log n) lookups.
    let deposit_roots_accumulator: [u8; 32] = {
        let mut acc = [0u8; 32];
        for r in &valid_deposit_roots {
            let mut h = Sha256::new();
            h.update(&acc);
            h.update(r);
            acc = h.finalize().into();
        }
        valid_deposit_roots.sort();
        acc
    };

    let vk_bytes: Vec<u8> = io::read();
    let vk_hash: [u8; 32] = Sha256::digest(&vk_bytes).into();
    let prepared_vk = groth16::prepare_vk(&vk_bytes);

    // ──── Domain binding ────
    let asset_id: Vec<u8> = io::read();
    let network_tag: u8 = io::read();
    let chain_id: u64 = io::read();
    let mixer_address: Vec<u8> = io::read();
    assert!(mixer_address.len() == 20, "mixer address must be 20 bytes");
    let target_denomination: Vec<u8> = io::read();
    let asset_id32: [u8; 32] = asset_id.clone().try_into().expect("asset 32");
    let denom32: [u8; 32] = target_denomination.clone().try_into().expect("denom 32");

    // ──── Process Bitcoin blocks ────
    let num_blocks: u32 = io::read();
    assert!(num_blocks > 0, "must process at least one block");
    let prev_last_block_hash: Vec<u8> = io::read();
    let prev_block32: [u8; 32] = prev_last_block_hash.try_into().expect("prev block 32");

    let mut prev_header_hash: Option<[u8; 32]> = if prev_block32 != [0u8; 32] {
        Some(prev_block32)
    } else {
        None
    };
    let mut last_block_hash = [0u8; 32];
    let mut burn_nullifiers: Vec<[u8; 32]> = Vec::new();
    let mut transition_count: u64 = 0;

    for _ in 0..num_blocks {
        let header: Vec<u8> = io::read();
        assert!(header.len() == 80, "header 80 bytes");

        let block_hash = bitcoin::double_sha256(&header);
        let target = bitcoin::bits_to_target(&header);
        assert!(bitcoin::be_bytes_lte(&bitcoin::reverse_u256(&block_hash), &target), "invalid PoW");

        if let Some(prev) = prev_header_hash {
            let prev_block: [u8; 32] = header[4..36].try_into().unwrap();
            assert!(prev_block == prev, "broken header chain");
        }
        let block_merkle_root = bitcoin::extract_merkle_root(&header);
        prev_header_hash = Some(block_hash);
        last_block_hash = block_hash;

        let num_txs: u32 = io::read();
        let mut txids: Vec<[u8; 32]> = Vec::new();

        for _ in 0..num_txs {
            let tx_data: Vec<u8> = io::read();
            let txid = bitcoin::compute_txid(&tx_data);
            txids.push(txid);

            let op_returns = bitcoin::extract_all_op_returns(&tx_data);
            let mut seen_burn_in_tx = false;
            for envelope in &op_returns {
            if envelope.is_empty() { continue; }
            let opcode = envelope[0];
            // Match Solidity first-match: any 0x61 payload of sufficient length
            // marks the burn slot as taken, regardless of domain.
            if opcode == 0x61 && envelope.len() >= 281 {
                if seen_burn_in_tx { continue; }
                seen_burn_in_tx = true;
            }
            if envelope.len() < 66 { continue; }
            if envelope[1] != network_tag { continue; }
            let env_asset: [u8; 32] = match envelope[2..34].try_into() {
                Ok(a) => a, Err(_) => continue,
            };
            if env_asset != asset_id32 { continue; }
            let env_denom: [u8; 32] = match envelope[34..66].try_into() {
                Ok(d) => d, Err(_) => continue,
            };
            if env_denom != denom32 { continue; }

            match opcode {
                0x60 => {
                    if envelope.len() < 517 { continue; }
                    let env_eth_root: [u8; 32] = envelope[66..98].try_into().unwrap();
                    if valid_deposit_roots.binary_search(&env_eth_root).is_err() { continue; }
                    let env_nullifier: [u8; 32] = envelope[98..130].try_into().unwrap();
                    let env_recip_commit: &[u8] = &envelope[130..163];
                    let env_leaf: [u8; 32] = envelope[163..195].try_into().unwrap();
                    if !is_canonical_field(&env_leaf) { continue; }
                    let env_r_leaf: [u8; 32] = envelope[195..227].try_into().unwrap();
                    let env_bind_hash: [u8; 32] = envelope[227..259].try_into().unwrap();
                    {
                        let mut bh = Sha256::new();
                        bh.update(b"tacit-bridge-deposit-v1");
                        let mut chain_id_32 = [0u8; 32];
                        chain_id_32[24..32].copy_from_slice(&chain_id.to_be_bytes());
                        bh.update(&chain_id_32);
                        bh.update(&mixer_address);
                        bh.update(&[network_tag]);
                        bh.update(&asset_id);
                        bh.update(&denom32);
                        bh.update(&env_eth_root);
                        bh.update(&env_nullifier);
                        bh.update(env_recip_commit);
                        bh.update(&env_leaf);
                        bh.update(&env_r_leaf);
                        let raw: [u8; 32] = bh.finalize().into();
                        let raw_u256 = u256_from_be(&raw);
                        let reduced = u256_mod_field(&raw_u256);
                        let computed = u256_to_be(&reduced);
                        if computed != env_bind_hash { continue; }
                    }
                    let proof = match extract_groth16_from_mint_envelope(&envelope) {
                        Some(p) => p, None => continue,
                    };
                    let inputs = extract_mint_public_inputs(&envelope);
                    if !try_verify_groth16(&proof, &inputs, &prepared_vk) { continue; }
                    if !tree.can_insert() { continue; }
                    if !null_set.insert(env_nullifier) { continue; }
                    tree.insert(env_leaf);
                    known_pool_roots.push(tree.root());
                    transition_count += 1;
                }
                0x62 => {
                    if envelope.len() < 484 { continue; }
                    let env_pool_root: [u8; 32] = envelope[66..98].try_into().unwrap();
                    if !known_pool_roots.contains(&env_pool_root) { continue; }
                    let env_nullifier: [u8; 32] = envelope[98..130].try_into().unwrap();
                    let env_new_commit: [u8; 32] = envelope[130..162].try_into().unwrap();
                    if !is_canonical_field(&env_new_commit) { continue; }
                    let env_r_leaf: [u8; 32] = envelope[162..194].try_into().unwrap();
                    let env_bind_hash: [u8; 32] = envelope[194..226].try_into().unwrap();
                    {
                        let mut bh = Sha256::new();
                        bh.update(b"tacit-bridge-rotate-v1");
                        let mut chain_id_32 = [0u8; 32];
                        chain_id_32[24..32].copy_from_slice(&chain_id.to_be_bytes());
                        bh.update(&chain_id_32);
                        bh.update(&mixer_address);
                        bh.update(&[network_tag]);
                        bh.update(&asset_id);
                        bh.update(&denom32);
                        bh.update(&env_pool_root);
                        bh.update(&env_nullifier);
                        bh.update(&env_new_commit);
                        bh.update(&env_r_leaf);
                        let raw: [u8; 32] = bh.finalize().into();
                        let raw_u256 = u256_from_be(&raw);
                        let reduced = u256_mod_field(&raw_u256);
                        let computed = u256_to_be(&reduced);
                        if computed != env_bind_hash { continue; }
                    }
                    let proof = match extract_groth16_from_rotate_envelope(&envelope) {
                        Some(p) => p, None => continue,
                    };
                    let inputs = extract_rotate_public_inputs(&envelope);
                    if !try_verify_groth16(&proof, &inputs, &prepared_vk) { continue; }
                    if !null_set.insert(env_nullifier) { continue; }
                    if !tree.can_insert() { continue; }
                    tree.insert(env_new_commit);
                    known_pool_roots.push(tree.root());
                    transition_count += 1;
                }
                0x61 => {
                    if envelope.len() < 537 { continue; }
                    let env_pool_root: [u8; 32] = envelope[66..98].try_into().unwrap();
                    if !known_pool_roots.contains(&env_pool_root) { continue; }
                    let env_nullifier: [u8; 32] = envelope[98..130].try_into().unwrap();
                    let env_recip_commit: &[u8] = &envelope[130..163];
                    let env_r_leaf: [u8; 32] = envelope[163..195].try_into().unwrap();
                    let env_recipient: [u8; 20] = envelope[195..215].try_into().unwrap();
                    let env_burn_nonce: [u8; 32] = envelope[215..247].try_into().unwrap();
                    let env_bind_hash: [u8; 32] = envelope[247..279].try_into().unwrap();
                    {
                        let mut bh = Sha256::new();
                        bh.update(b"tacit-bridge-burn-v1");
                        let mut chain_id_32 = [0u8; 32];
                        chain_id_32[24..32].copy_from_slice(&chain_id.to_be_bytes());
                        bh.update(&chain_id_32);
                        bh.update(&mixer_address);
                        bh.update(&[network_tag]);
                        bh.update(&asset_id);
                        bh.update(&denom32);
                        bh.update(&env_pool_root);
                        bh.update(&env_nullifier);
                        bh.update(env_recip_commit);
                        bh.update(&env_r_leaf);
                        bh.update(&env_recipient);
                        bh.update(&env_burn_nonce);
                        let raw: [u8; 32] = bh.finalize().into();
                        let raw_u256 = u256_from_be(&raw);
                        let reduced = u256_mod_field(&raw_u256);
                        let computed = u256_to_be(&reduced);
                        if computed != env_bind_hash { continue; }
                    }
                    let proof = match extract_groth16_from_burn_envelope(&envelope) {
                        Some(p) => p, None => continue,
                    };
                    let inputs = extract_burn_public_inputs(&envelope);
                    if !try_verify_groth16(&proof, &inputs, &prepared_vk) { continue; }
                    if !null_set.insert(env_nullifier) { continue; }
                    {
                        let mut h = Sha256::new();
                        h.update(&env_nullifier);
                        h.update(&denom32);
                        h.update(&env_pool_root);
                        h.update(&env_recipient);
                        h.update(&env_bind_hash);
                        burn_nullifiers.push(h.finalize().into());
                    }
                    transition_count += 1;
                }
                0x63 => {
                    // T_BRIDGE_EXPORT: pool note → tETH UTXO.
                    // Same Groth16 validation as burn (proves pool note membership),
                    // but instead of recording a burn claim, records a UTXO in the set.
                    if envelope.len() < 484 { continue; }
                    let env_pool_root: [u8; 32] = envelope[66..98].try_into().unwrap();
                    if !known_pool_roots.contains(&env_pool_root) { continue; }
                    let env_nullifier: [u8; 32] = envelope[98..130].try_into().unwrap();
                    let env_recip_commit: [u8; 33] = envelope[130..163].try_into().unwrap();
                    let env_r_leaf: [u8; 32] = envelope[163..195].try_into().unwrap();
                    let env_bind_hash: [u8; 32] = envelope[195..227].try_into().unwrap();
                    {
                        let mut bh = Sha256::new();
                        bh.update(b"tacit-bridge-export-v1");
                        let mut chain_id_32 = [0u8; 32];
                        chain_id_32[24..32].copy_from_slice(&chain_id.to_be_bytes());
                        bh.update(&chain_id_32);
                        bh.update(&mixer_address);
                        bh.update(&[network_tag]);
                        bh.update(&asset_id);
                        bh.update(&denom32);
                        bh.update(&env_pool_root);
                        bh.update(&env_nullifier);
                        bh.update(&env_recip_commit);
                        bh.update(&env_r_leaf);
                        let raw: [u8; 32] = bh.finalize().into();
                        let raw_u256 = u256_from_be(&raw);
                        let reduced = u256_mod_field(&raw_u256);
                        let computed = u256_to_be(&reduced);
                        if computed != env_bind_hash { continue; }
                    }
                    let proof = match extract_groth16_from_export_envelope(&envelope) {
                        Some(p) => p, None => continue,
                    };
                    let inputs = extract_export_public_inputs(&envelope);
                    if !try_verify_groth16(&proof, &inputs, &prepared_vk) { continue; }
                    if !null_set.insert(env_nullifier) { continue; }
                    utxo_set.push((txid, 1, env_recip_commit));
                    transition_count += 1;
                }
                0x64 => {
                    // T_BRIDGE_IMPORT: tETH UTXO → pool note.
                    // No Groth16 — validated by UTXO set membership.
                    if envelope.len() < 164 { continue; }
                    let env_new_commit: [u8; 32] = envelope[66..98].try_into().unwrap();
                    if !is_canonical_field(&env_new_commit) { continue; }
                    let env_bind_hash: [u8; 32] = envelope[98..130].try_into().unwrap();
                    let env_prev_txid: [u8; 32] = envelope[130..162].try_into().unwrap();
                    let env_prev_vout: u16 = u16::from_le_bytes([envelope[162], envelope[163]]);
                    {
                        let mut bh = Sha256::new();
                        bh.update(b"tacit-bridge-import-v1");
                        let mut chain_id_32 = [0u8; 32];
                        chain_id_32[24..32].copy_from_slice(&chain_id.to_be_bytes());
                        bh.update(&chain_id_32);
                        bh.update(&mixer_address);
                        bh.update(&[network_tag]);
                        bh.update(&asset_id);
                        bh.update(&denom32);
                        bh.update(&env_new_commit);
                        bh.update(&env_prev_txid);
                        bh.update(&env_prev_vout.to_le_bytes());
                        let raw: [u8; 32] = bh.finalize().into();
                        let raw_u256 = u256_from_be(&raw);
                        let reduced = u256_mod_field(&raw_u256);
                        let computed = u256_to_be(&reduced);
                        if computed != env_bind_hash { continue; }
                    }
                    let utxo_idx = utxo_set.iter().position(|(t, v, _)| *t == env_prev_txid && *v == env_prev_vout);
                    let utxo_idx = match utxo_idx { Some(i) => i, None => continue };
                    // Verify the Bitcoin tx actually consumes this UTXO as an input.
                    let mut found_input = false;
                    let inp_data = bitcoin::extract_input_outpoints(&tx_data);
                    for (inp_txid, inp_vout) in &inp_data {
                        if *inp_txid == env_prev_txid && *inp_vout == env_prev_vout { found_input = true; break; }
                    }
                    if !found_input { continue; }
                    utxo_set.remove(utxo_idx);
                    if !tree.can_insert() { continue; }
                    tree.insert(env_new_commit);
                    known_pool_roots.push(tree.root());
                    transition_count += 1;
                }
                _ => {}
            }
            }

            // After processing envelopes, scan for tETH UTXO consumption by
            // non-bridge opcodes (CXFER, swap, etc.). If any input matches a
            // tracked UTXO, remove it. If the envelope is a tETH CXFER/swap,
            // add the new output commitments.
            let inp_outpoints = bitcoin::extract_input_outpoints(&tx_data);
            for (inp_txid, inp_vout) in &inp_outpoints {
                if let Some(idx) = utxo_set.iter().position(|(t, v, _)| t == inp_txid && *v == *inp_vout) {
                    utxo_set.remove(idx);
                }
            }

            // Parse tETH CXFER outputs from both OP_RETURN and Taproot envelopes.
            let mut cxfer_sources: Vec<&[u8]> = Vec::new();
            for env in &op_returns {
                if env.len() >= 98 && (env[0] == 0x22 || env[0] == 0x23) {
                    cxfer_sources.push(env);
                }
            }
            if let Some(tap_env) = bitcoin::extract_taproot_envelope(&tx_data) {
                if tap_env.len() >= 98 && (tap_env[0] == 0x22 || tap_env[0] == 0x23) {
                    // Taproot: vout[0] is asset output (no OP_RETURN in outputs)
                    let env_asset: Result<[u8; 32], _> = tap_env[1..33].try_into();
                    if let Ok(ea) = env_asset {
                        if ea == asset_id32 {
                            let n_outputs = tap_env[97] as usize;
                            let mut off = 98;
                            for out_idx in 0..n_outputs {
                                if off + 33 > tap_env.len() { break; }
                                let commit: [u8; 33] = tap_env[off..off+33].try_into().unwrap();
                                utxo_set.push((txid, out_idx as u16, commit));
                                off += 33 + 8;
                            }
                        }
                    }
                }
            }
            for cxfer_env in &cxfer_sources {
                let env_asset: Result<[u8; 32], _> = cxfer_env[1..33].try_into();
                if let Ok(ea) = env_asset {
                    if ea == asset_id32 {
                        let n_outputs = cxfer_env[97] as usize;
                        let mut off = 98;
                        for out_idx in 0..n_outputs {
                            if off + 33 > cxfer_env.len() { break; }
                            let commit: [u8; 33] = cxfer_env[off..off+33].try_into().unwrap();
                            utxo_set.push((txid, (out_idx + 1) as u16, commit));
                            off += 33 + 8;
                        }
                    }
                }
            }
        }

        let computed_root = bitcoin::compute_merkle_root(&txids);
        assert!(computed_root == block_merkle_root, "tx merkle root mismatch");
    }

    let burn_batch_hash: [u8; 32] = if burn_nullifiers.is_empty() {
        [0u8; 32]
    } else {
        let mut h = Sha256::new();
        for n in &burn_nullifiers { h.update(n); }
        h.finalize().into()
    };

    let new_state_height = prev_state_height + transition_count;
    let new_pool_root = tree.root();
    null_set.finalize();
    let new_null_set_hash = null_set.hash();
    utxo_set.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let new_utxo_set_hash = compute_utxo_set_hash(&utxo_set);
    let new_state_commitment = compute_state_commitment(
        &new_pool_root, &new_null_set_hash, new_state_height,
        tree.next_index() as u64, &tree.frontier(),
        null_set.count(), &new_utxo_set_hash,
    );

    // ──── Commit public outputs (461 bytes) ────
    io::commit_slice(&prev_root32);
    io::commit_slice(&prev_null_hash32);
    io::commit_slice(&prev_state_height.to_be_bytes());
    io::commit_slice(&prev_block32);
    io::commit_slice(&new_pool_root);
    io::commit_slice(&new_null_set_hash);
    io::commit_slice(&new_state_height.to_be_bytes());
    io::commit_slice(&deposit_roots_accumulator);
    io::commit_slice(&vk_hash);
    io::commit_slice(&burn_batch_hash);
    io::commit_slice(&asset_id);
    io::commit_slice(&[network_tag]);
    io::commit_slice(&chain_id.to_be_bytes());
    io::commit_slice(&mixer_address);
    io::commit_slice(&last_block_hash);
    io::commit_slice(&denom32);
    io::commit_slice(&prev_state_commitment);
    io::commit_slice(&new_state_commitment);
}

fn compute_state_commitment(
    pool_root: &[u8; 32], null_set_hash: &[u8; 32], height: u64,
    pool_next: u64, pool_frontier: &[[u8; 32]; 20],
    null_count: u64, utxo_set_hash: &[u8; 32],
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(pool_root);
    h.update(null_set_hash);
    h.update(&height.to_be_bytes());
    h.update(&pool_next.to_be_bytes());
    for f in pool_frontier { h.update(f); }
    h.update(&null_count.to_be_bytes());
    h.update(utxo_set_hash);
    h.finalize().into()
}

fn compute_utxo_set_hash(set: &[([u8; 32], u16, [u8; 33])]) -> [u8; 32] {
    if set.is_empty() { return [0u8; 32]; }
    let mut h = Sha256::new();
    for (txid, vout, commit) in set {
        h.update(txid);
        h.update(&vout.to_le_bytes());
        h.update(commit);
    }
    h.finalize().into()
}

fn extract_groth16_from_mint_envelope(env: &[u8]) -> Option<Vec<u8>> {
    if env.len() < 261 { return None; }
    let proof_len = u16::from_le_bytes([env[259], env[260]]) as usize;
    if env.len() < 261 + proof_len { return None; }
    Some(env[261..261 + proof_len].to_vec())
}

fn extract_groth16_from_burn_envelope(env: &[u8]) -> Option<Vec<u8>> {
    if env.len() < 281 { return None; }
    let proof_len = u16::from_le_bytes([env[279], env[280]]) as usize;
    if env.len() < 281 + proof_len { return None; }
    Some(env[281..281 + proof_len].to_vec())
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

fn extract_groth16_from_rotate_envelope(env: &[u8]) -> Option<Vec<u8>> {
    if env.len() < 228 { return None; }
    let proof_len = u16::from_le_bytes([env[226], env[227]]) as usize;
    if env.len() < 228 + proof_len { return None; }
    Some(env[228..228 + proof_len].to_vec())
}

fn extract_rotate_public_inputs(env: &[u8]) -> Vec<[u8; 32]> {
    vec![
        env[66..98].try_into().unwrap(),    // root
        env[98..130].try_into().unwrap(),   // nullifier_hash
        env[34..66].try_into().unwrap(),    // denomination
        env[162..194].try_into().unwrap(),  // r_leaf
        env[194..226].try_into().unwrap(),  // bind_hash
    ]
}

fn extract_groth16_from_export_envelope(env: &[u8]) -> Option<Vec<u8>> {
    if env.len() < 229 { return None; }
    let proof_len = u16::from_le_bytes([env[227], env[228]]) as usize;
    if env.len() < 229 + proof_len { return None; }
    Some(env[229..229 + proof_len].to_vec())
}

fn extract_export_public_inputs(env: &[u8]) -> Vec<[u8; 32]> {
    vec![
        env[66..98].try_into().unwrap(),    // poolRoot
        env[98..130].try_into().unwrap(),   // nullifierHash
        env[34..66].try_into().unwrap(),    // denomination
        env[163..195].try_into().unwrap(),  // rLeaf
        env[195..227].try_into().unwrap(),  // bindHash
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

fn try_verify_groth16(
    proof_bytes: &[u8],
    public_inputs: &[[u8; 32]],
    pvk: &Option<ark_groth16::PreparedVerifyingKey<ark_bn254::Bn254>>,
) -> bool {
    if proof_bytes.len() != 256 { return false; }
    match pvk {
        Some(pvk) => groth16::verify(pvk, proof_bytes, public_inputs),
        None => false,
    }
}

fn is_canonical_field(bytes: &[u8; 32]) -> bool {
    *bytes < BN254_FIELD_SIZE
}

const BN254_FIELD_SIZE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
    0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

fn u256_from_be(bytes: &[u8; 32]) -> [u64; 4] {
    [
        u64::from_be_bytes(bytes[24..32].try_into().unwrap()),
        u64::from_be_bytes(bytes[16..24].try_into().unwrap()),
        u64::from_be_bytes(bytes[8..16].try_into().unwrap()),
        u64::from_be_bytes(bytes[0..8].try_into().unwrap()),
    ]
}

fn u256_to_be(v: &[u64; 4]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[0..8].copy_from_slice(&v[3].to_be_bytes());
    out[8..16].copy_from_slice(&v[2].to_be_bytes());
    out[16..24].copy_from_slice(&v[1].to_be_bytes());
    out[24..32].copy_from_slice(&v[0].to_be_bytes());
    out
}

fn u256_mod_field(v: &[u64; 4]) -> [u64; 4] {
    let field = u256_from_be(&BN254_FIELD_SIZE);
    let mut r = *v;
    while !u256_lt(&r, &field) { r = u256_sub(&r, &field); }
    r
}

fn u256_lt(a: &[u64; 4], b: &[u64; 4]) -> bool {
    for i in (0..4).rev() {
        if a[i] < b[i] { return true; }
        if a[i] > b[i] { return false; }
    }
    false
}

fn u256_sub(a: &[u64; 4], b: &[u64; 4]) -> [u64; 4] {
    let mut result = [0u64; 4];
    let mut borrow: u64 = 0;
    for i in 0..4 {
        let (diff, b1) = a[i].overflowing_sub(b[i]);
        let (diff2, b2) = diff.overflowing_sub(borrow);
        result[i] = diff2;
        borrow = (b1 as u64) + (b2 as u64);
    }
    result
}
