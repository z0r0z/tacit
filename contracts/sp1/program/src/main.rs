#![no_main]
sp1_zkvm::entrypoint!(main);

use sp1_zkvm::io;
use sha2::{Sha256, Digest};
use std::collections::BTreeSet;

mod poseidon;
mod bitcoin;
mod merkle;
mod groth16;
mod secp;

const TREE_DEPTH: usize = 20;

pub fn main() {
    // ──── Denomination config ────
    let num_denoms: u32 = io::read();
    assert!(num_denoms > 0 && num_denoms <= 16, "1-16 denominations");
    let nd = num_denoms as usize;
    let mut denom_bytes: Vec<[u8; 32]> = Vec::with_capacity(nd);
    let mut denom_u64s: Vec<u64> = Vec::with_capacity(nd);
    for _ in 0..nd {
        let d: Vec<u8> = io::read();
        let d32: [u8; 32] = d.try_into().expect("denom 32");
        denom_u64s.push(u64::from_be_bytes(d32[24..32].try_into().unwrap()));
        denom_bytes.push(d32);
    }

    // ──── Per-denomination previous pool state ────
    let mut prev_pool_roots: Vec<[u8; 32]> = Vec::with_capacity(nd);
    let mut prev_pool_indices: Vec<u64> = Vec::with_capacity(nd);
    let mut prev_pool_frontiers: Vec<[[u8; 32]; TREE_DEPTH]> = Vec::with_capacity(nd);
    for _ in 0..nd {
        let r: Vec<u8> = io::read();
        prev_pool_roots.push(r.try_into().expect("root 32"));
        prev_pool_indices.push(io::read());
        let mut frontier = [[0u8; 32]; TREE_DEPTH];
        for j in 0..TREE_DEPTH {
            let f: Vec<u8> = io::read();
            frontier[j] = f.try_into().expect("frontier 32");
        }
        prev_pool_frontiers.push(frontier);
    }

    // ──── Shared previous state ────
    let prev_null_set_hash: Vec<u8> = io::read();
    let prev_null_hash32: [u8; 32] = prev_null_set_hash.try_into().expect("null hash 32");
    let prev_state_height: u64 = io::read();

    let prev_null_count: u64 = io::read();
    let mut prev_nullifiers: Vec<[u8; 32]> = Vec::new();
    for _ in 0..prev_null_count {
        let n: Vec<u8> = io::read();
        prev_nullifiers.push(n.try_into().expect("nullifier 32"));
    }

    let prev_utxo_count: u64 = io::read();
    let mut utxo_set: Vec<([u8; 32], u32, [u8; 33], u64)> = Vec::new();
    for _ in 0..prev_utxo_count {
        let txid: Vec<u8> = io::read();
        let vout: u32 = io::read();
        let commit: Vec<u8> = io::read();
        let amount: u64 = io::read();
        utxo_set.push((
            txid.try_into().expect("utxo txid 32"),
            vout,
            commit.try_into().expect("utxo commit 33"),
            amount,
        ));
    }

    // ──── Initialize state ────
    let is_genesis = prev_pool_roots.iter().all(|r| *r == [0u8; 32])
        && prev_null_hash32 == [0u8; 32];

    let mut trees: Vec<merkle::PoseidonTree> = Vec::with_capacity(nd);
    let mut known_pool_roots: Vec<BTreeSet<[u8; 32]>> = Vec::with_capacity(nd);
    let prev_state_commitment: [u8; 32];

    if is_genesis {
        assert!(prev_state_height == 0);
        assert!(prev_null_count == 0);
        assert!(prev_utxo_count == 0);
        for i in 0..nd {
            assert!(prev_pool_indices[i] == 0);
            trees.push(merkle::PoseidonTree::new());
            let mut s = BTreeSet::new();
            s.insert(trees[i].root());
            known_pool_roots.push(s);
        }
        prev_state_commitment = [0u8; 32];
    } else {
        let prev_utxo_set_hash = compute_utxo_set_hash(&utxo_set);
        for i in 0..nd {
            trees.push(merkle::PoseidonTree::from_frontier(
                prev_pool_frontiers[i], prev_pool_indices[i] as usize, prev_pool_roots[i],
            ));
            let mut s = BTreeSet::new();
            s.insert(trees[i].root());
            known_pool_roots.push(s);
        }
        let mut null_set_check = merkle::NullifierSet::from_sorted(prev_nullifiers.clone());
        assert!(null_set_check.hash() == prev_null_hash32, "nullifier set hash mismatch");
        prev_state_commitment = compute_state_commitment_multi(
            &trees, &prev_null_hash32, prev_state_height,
            null_set_check.count(), &prev_utxo_set_hash,
        );
    }
    let mut null_set = if is_genesis {
        merkle::NullifierSet::new()
    } else {
        merkle::NullifierSet::from_sorted(prev_nullifiers)
    };

    // ──── Per-denomination deposit roots ────
    let mut deposit_root_accumulators: Vec<[u8; 32]> = Vec::with_capacity(nd);
    let mut all_valid_deposit_roots: Vec<Vec<[u8; 32]>> = Vec::with_capacity(nd);
    for _ in 0..nd {
        let num_roots: u32 = io::read();
        let mut roots: Vec<[u8; 32]> = Vec::new();
        for _ in 0..num_roots {
            let r: Vec<u8> = io::read();
            roots.push(r.try_into().expect("dep root 32"));
        }
        let acc = {
            let mut a = [0u8; 32];
            for r in &roots {
                let mut h = Sha256::new();
                h.update(&a);
                h.update(r);
                a = h.finalize().into();
            }
            roots.sort();
            a
        };
        deposit_root_accumulators.push(acc);
        all_valid_deposit_roots.push(roots);
    }

    // ──── VK + domain binding ────
    let vk_bytes: Vec<u8> = io::read();
    let vk_hash: [u8; 32] = Sha256::digest(&vk_bytes).into();
    let prepared_vk = groth16::prepare_vk(&vk_bytes);

    let asset_id: Vec<u8> = io::read();
    let network_tag: u8 = io::read();
    let chain_id: u64 = io::read();
    let mixer_address: Vec<u8> = io::read();
    assert!(mixer_address.len() == 20, "mixer address must be 20 bytes");
    let asset_id32: [u8; 32] = asset_id.clone().try_into().expect("asset 32");

    let pedersen_h = secp::pedersen_h();

    // ──── CXFER witnesses ────
    let num_cxfer_witnesses: u32 = io::read();
    let mut cxfer_witnesses: Vec<(u32, u32, Vec<(u64, [u8; 32])>)> = Vec::new();
    for _ in 0..num_cxfer_witnesses {
        let block_idx: u32 = io::read();
        let tx_idx: u32 = io::read();
        let n_outs: u32 = io::read();
        let mut openings = Vec::new();
        for _ in 0..n_outs {
            let amount: u64 = io::read();
            let blinding: Vec<u8> = io::read();
            openings.push((amount, blinding.try_into().expect("blinding 32")));
        }
        cxfer_witnesses.push((block_idx, tx_idx, openings));
    }

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
    let mut burn_nullifiers: Vec<Vec<[u8; 32]>> = vec![Vec::new(); nd];
    let mut transition_count: u64 = 0;

    for block_idx in 0..num_blocks {
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

        for tx_idx in 0..num_txs {
            let tx_data: Vec<u8> = io::read();
            let txid = bitcoin::compute_txid(&tx_data);
            txids.push(txid);

            let op_returns = bitcoin::extract_all_op_returns(&tx_data);
            let mut seen_burn_in_tx = false;
            for envelope in &op_returns {
            if envelope.is_empty() { continue; }
            let opcode = envelope[0];
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
            let di = match denom_bytes.iter().position(|d| *d == env_denom) {
                Some(i) => i, None => continue,
            };

            match opcode {
                0x60 => {
                    if envelope.len() < 517 { continue; }
                    let env_eth_root: [u8; 32] = envelope[66..98].try_into().unwrap();
                    if all_valid_deposit_roots[di].binary_search(&env_eth_root).is_err() { continue; }
                    let env_nullifier: [u8; 32] = envelope[98..130].try_into().unwrap();
                    let env_recip_commit: &[u8] = &envelope[130..163];
                    let env_leaf: [u8; 32] = envelope[163..195].try_into().unwrap();
                    if !is_canonical_field(&env_leaf) { continue; }
                    let env_r_leaf: [u8; 32] = envelope[195..227].try_into().unwrap();
                    let env_bind_hash: [u8; 32] = envelope[227..259].try_into().unwrap();
                    {
                        let computed = compute_bind_hash(
                            b"tacit-bridge-deposit-v1", chain_id, &mixer_address, network_tag,
                            &asset_id, &env_denom, &[&env_eth_root, &env_nullifier, env_recip_commit, &env_leaf, &env_r_leaf],
                        );
                        if computed != env_bind_hash { continue; }
                    }
                    let proof = match extract_groth16_from_mint_envelope(envelope) { Some(p) => p, None => continue };
                    let inputs = extract_mint_public_inputs(envelope);
                    if !try_verify_groth16(&proof, &inputs, &prepared_vk) { continue; }
                    if !trees[di].can_insert() { continue; }
                    if !null_set.insert(env_nullifier) { continue; }
                    trees[di].insert(env_leaf);
                    known_pool_roots[di].insert(trees[di].root());
                    transition_count += 1;
                }
                0x62 => {
                    if envelope.len() < 484 { continue; }
                    let env_pool_root: [u8; 32] = envelope[66..98].try_into().unwrap();
                    if !known_pool_roots[di].contains(&env_pool_root) { continue; }
                    let env_nullifier: [u8; 32] = envelope[98..130].try_into().unwrap();
                    let env_new_commit: [u8; 32] = envelope[130..162].try_into().unwrap();
                    if !is_canonical_field(&env_new_commit) { continue; }
                    let env_r_leaf: [u8; 32] = envelope[162..194].try_into().unwrap();
                    let env_bind_hash: [u8; 32] = envelope[194..226].try_into().unwrap();
                    {
                        let computed = compute_bind_hash(
                            b"tacit-bridge-rotate-v1", chain_id, &mixer_address, network_tag,
                            &asset_id, &env_denom, &[&env_pool_root, &env_nullifier, &env_new_commit, &env_r_leaf],
                        );
                        if computed != env_bind_hash { continue; }
                    }
                    let proof = match extract_groth16_from_rotate_envelope(envelope) { Some(p) => p, None => continue };
                    let inputs = extract_rotate_public_inputs(envelope);
                    if !try_verify_groth16(&proof, &inputs, &prepared_vk) { continue; }
                    if !trees[di].can_insert() { continue; }
                    if !null_set.insert(env_nullifier) { continue; }
                    trees[di].insert(env_new_commit);
                    known_pool_roots[di].insert(trees[di].root());
                    transition_count += 1;
                }
                0x61 => {
                    if envelope.len() < 537 { continue; }
                    let env_pool_root: [u8; 32] = envelope[66..98].try_into().unwrap();
                    if !known_pool_roots[di].contains(&env_pool_root) { continue; }
                    let env_nullifier: [u8; 32] = envelope[98..130].try_into().unwrap();
                    let env_recip_commit: &[u8] = &envelope[130..163];
                    let env_r_leaf: [u8; 32] = envelope[163..195].try_into().unwrap();
                    let env_recipient: [u8; 20] = envelope[195..215].try_into().unwrap();
                    let env_burn_nonce: [u8; 32] = envelope[215..247].try_into().unwrap();
                    let env_bind_hash: [u8; 32] = envelope[247..279].try_into().unwrap();
                    {
                        let computed = compute_bind_hash(
                            b"tacit-bridge-burn-v1", chain_id, &mixer_address, network_tag,
                            &asset_id, &env_denom,
                            &[&env_pool_root, &env_nullifier, env_recip_commit, &env_r_leaf, &env_recipient, &env_burn_nonce],
                        );
                        if computed != env_bind_hash { continue; }
                    }
                    let proof = match extract_groth16_from_burn_envelope(envelope) { Some(p) => p, None => continue };
                    let inputs = extract_burn_public_inputs(envelope);
                    if !try_verify_groth16(&proof, &inputs, &prepared_vk) { continue; }
                    if !null_set.insert(env_nullifier) { continue; }
                    {
                        let mut h = Sha256::new();
                        h.update(&env_nullifier);
                        h.update(&env_denom);
                        h.update(&env_pool_root);
                        h.update(&env_recipient);
                        h.update(&env_bind_hash);
                        burn_nullifiers[di].push(h.finalize().into());
                    }
                    transition_count += 1;
                }
                0x63 => {
                    if envelope.len() < 485 { continue; }
                    let env_pool_root: [u8; 32] = envelope[66..98].try_into().unwrap();
                    if !known_pool_roots[di].contains(&env_pool_root) { continue; }
                    let env_nullifier: [u8; 32] = envelope[98..130].try_into().unwrap();
                    let env_recip_commit: [u8; 33] = envelope[130..163].try_into().unwrap();
                    let env_r_leaf: [u8; 32] = envelope[163..195].try_into().unwrap();
                    let env_bind_hash: [u8; 32] = envelope[195..227].try_into().unwrap();
                    {
                        let computed = compute_bind_hash(
                            b"tacit-bridge-export-v1", chain_id, &mixer_address, network_tag,
                            &asset_id, &env_denom, &[&env_pool_root, &env_nullifier, &env_recip_commit, &env_r_leaf],
                        );
                        if computed != env_bind_hash { continue; }
                    }
                    let proof = match extract_groth16_from_export_envelope(envelope) { Some(p) => p, None => continue };
                    let inputs = extract_export_public_inputs(envelope);
                    if !try_verify_groth16(&proof, &inputs, &prepared_vk) { continue; }
                    if !null_set.insert(env_nullifier) { continue; }
                    utxo_set.push((txid, 1u32, env_recip_commit, denom_u64s[di]));
                    transition_count += 1;
                }
                0x64 => {
                    if envelope.len() < 164 { continue; }
                    let env_new_commit: [u8; 32] = envelope[66..98].try_into().unwrap();
                    if !is_canonical_field(&env_new_commit) { continue; }
                    let env_bind_hash: [u8; 32] = envelope[98..130].try_into().unwrap();
                    let env_prev_txid: [u8; 32] = envelope[130..162].try_into().unwrap();
                    let env_prev_vout: u32 = u16::from_le_bytes([envelope[162], envelope[163]]) as u32;
                    {
                        let computed = compute_bind_hash(
                            b"tacit-bridge-import-v1", chain_id, &mixer_address, network_tag,
                            &asset_id, &env_denom, &[&env_new_commit, &env_prev_txid, &envelope[162..164]],
                        );
                        if computed != env_bind_hash { continue; }
                    }
                    let utxo_idx = utxo_set.iter().position(|(t, v, _, _)| *t == env_prev_txid && *v == env_prev_vout);
                    let utxo_idx = match utxo_idx { Some(i) => i, None => continue };
                    if utxo_set[utxo_idx].3 != denom_u64s[di] { continue; }
                    let mut found_input = false;
                    let inp_data = bitcoin::extract_input_outpoints(&tx_data);
                    for (inp_txid, inp_vout) in &inp_data {
                        if *inp_txid == env_prev_txid && *inp_vout == env_prev_vout { found_input = true; break; }
                    }
                    if !found_input { continue; }
                    if !trees[di].can_insert() { continue; }
                    utxo_set.remove(utxo_idx);
                    trees[di].insert(env_new_commit);
                    known_pool_roots[di].insert(trees[di].root());
                    transition_count += 1;
                }
                _ => {}
            }
            }

            // CXFER conservation-verified tracking
            let inp_outpoints = bitcoin::extract_input_outpoints(&tx_data);
            let mut tracked_input_sum: u64 = 0;
            let mut has_tracked = false;
            let mut all_tracked = true;
            for (i, (it, iv)) in inp_outpoints.iter().enumerate() {
                if let Some(idx) = utxo_set.iter().position(|(t, v, _, _)| t == it && *v == *iv) {
                    tracked_input_sum += utxo_set[idx].3;
                    has_tracked = true;
                } else if i > 0 {
                    all_tracked = false;
                }
            }
            if has_tracked && all_tracked {
                let cxfer_result = parse_cxfer_commitments(&op_returns, &tx_data, &asset_id32);
                if let Some((commits, vout_base)) = cxfer_result {
                    if let Some((_, _, openings)) = cxfer_witnesses.iter().find(|(bi, ti, _)| *bi == block_idx && *ti == tx_idx) {
                        if openings.len() == commits.len() {
                            let mut out_sum: u64 = 0;
                            let mut ok = true;
                            for (k, (amt, bl)) in openings.iter().enumerate() {
                                if !secp::verify_pedersen_opening(&pedersen_h, &commits[k], *amt, bl) { ok = false; break; }
                                out_sum = match out_sum.checked_add(*amt) { Some(s) => s, None => { ok = false; break; } };
                            }
                            if ok && out_sum == tracked_input_sum {
                                for (k, (amt, _)) in openings.iter().enumerate() {
                                    utxo_set.push((txid, vout_base + k as u32, commits[k], *amt));
                                }
                            }
                        }
                    }
                }
            }
            for (it, iv) in &inp_outpoints {
                if let Some(idx) = utxo_set.iter().position(|(t, v, _, _)| t == it && *v == *iv) {
                    utxo_set.remove(idx);
                }
            }
        }

        let computed_root = bitcoin::compute_merkle_root(&txids);
        assert!(computed_root == block_merkle_root, "tx merkle root mismatch");
    }

    // ──── Finalize ────
    let new_state_height = prev_state_height + transition_count;
    null_set.finalize();
    let new_null_set_hash = null_set.hash();
    utxo_set.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let new_utxo_set_hash = compute_utxo_set_hash(&utxo_set);

    let prev_pools_hash = hash_bytes32s(&prev_pool_roots);
    let new_pool_roots: Vec<[u8; 32]> = trees.iter().map(|t| t.root()).collect();
    let new_pools_hash = hash_bytes32s(&new_pool_roots);
    let deposit_accs_hash = hash_bytes32s(&deposit_root_accumulators);
    let denoms_hash = hash_bytes32s(&denom_bytes);

    let burn_batch_hashes: Vec<[u8; 32]> = burn_nullifiers.iter().map(|bn| {
        if bn.is_empty() { [0u8; 32] }
        else { let mut h = Sha256::new(); for n in bn { h.update(n); } h.finalize().into() }
    }).collect();
    let burns_hash = hash_bytes32s(&burn_batch_hashes);

    let new_state_commitment = compute_state_commitment_multi(
        &trees, &new_null_set_hash, new_state_height,
        null_set.count(), &new_utxo_set_hash,
    );

    // ──── Commit public outputs (461 bytes) ────
    io::commit_slice(&prev_pools_hash);
    io::commit_slice(&prev_null_hash32);
    io::commit_slice(&prev_state_height.to_be_bytes());
    io::commit_slice(&prev_block32);
    io::commit_slice(&new_pools_hash);
    io::commit_slice(&new_null_set_hash);
    io::commit_slice(&new_state_height.to_be_bytes());
    io::commit_slice(&deposit_accs_hash);
    io::commit_slice(&burns_hash);
    io::commit_slice(&vk_hash);
    io::commit_slice(&asset_id);
    io::commit_slice(&[network_tag]);
    io::commit_slice(&chain_id.to_be_bytes());
    io::commit_slice(&mixer_address);
    io::commit_slice(&last_block_hash);
    io::commit_slice(&denoms_hash);
    io::commit_slice(&prev_state_commitment);
    io::commit_slice(&new_state_commitment);
}

// ──── Helpers ────

fn compute_bind_hash(
    domain: &[u8], chain_id: u64, mixer: &[u8], net_tag: u8,
    asset_id: &[u8], denom: &[u8], fields: &[&[u8]],
) -> [u8; 32] {
    let mut bh = Sha256::new();
    bh.update(domain);
    let mut cid = [0u8; 32];
    cid[24..32].copy_from_slice(&chain_id.to_be_bytes());
    bh.update(&cid);
    bh.update(mixer);
    bh.update(&[net_tag]);
    bh.update(asset_id);
    bh.update(denom);
    for f in fields { bh.update(f); }
    let raw: [u8; 32] = bh.finalize().into();
    let v = u256_from_be(&raw);
    let reduced = u256_mod_field(&v);
    u256_to_be(&reduced)
}

fn parse_cxfer_commitments(op_returns: &[Vec<u8>], tx_data: &[u8], asset_id: &[u8; 32]) -> Option<(Vec<[u8; 33]>, u32)> {
    for env in op_returns {
        if env.len() >= 98 && (env[0] == 0x22 || env[0] == 0x23) {
            let ea: Result<[u8; 32], _> = env[1..33].try_into();
            if let Ok(ea) = ea {
                if ea == *asset_id {
                    let mut commits = Vec::new();
                    let n = env[97] as usize;
                    let mut off = 98;
                    for _ in 0..n {
                        if off + 33 > env.len() { break; }
                        commits.push(env[off..off+33].try_into().unwrap());
                        off += 33 + 8;
                    }
                    if !commits.is_empty() { return Some((commits, 1)); }
                }
            }
        }
    }
    if let Some(tap) = bitcoin::extract_taproot_envelope(tx_data) {
        if tap.len() >= 98 && (tap[0] == 0x22 || tap[0] == 0x23) {
            let ea: Result<[u8; 32], _> = tap[1..33].try_into();
            if let Ok(ea) = ea {
                if ea == *asset_id {
                    let mut commits = Vec::new();
                    let n = tap[97] as usize;
                    let mut off = 98;
                    for _ in 0..n {
                        if off + 33 > tap.len() { break; }
                        commits.push(tap[off..off+33].try_into().unwrap());
                        off += 33 + 8;
                    }
                    if !commits.is_empty() { return Some((commits, 0)); }
                }
            }
        }
    }
    None
}

fn hash_bytes32s(items: &[[u8; 32]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for i in items { h.update(i); }
    h.finalize().into()
}

fn compute_state_commitment_multi(
    trees: &[merkle::PoseidonTree], null_set_hash: &[u8; 32], height: u64,
    null_count: u64, utxo_set_hash: &[u8; 32],
) -> [u8; 32] {
    let mut h = Sha256::new();
    for t in trees {
        h.update(&t.root());
        h.update(&(t.next_index() as u64).to_be_bytes());
        for f in &t.frontier() { h.update(f); }
    }
    h.update(null_set_hash);
    h.update(&height.to_be_bytes());
    h.update(&null_count.to_be_bytes());
    h.update(utxo_set_hash);
    h.finalize().into()
}

fn compute_utxo_set_hash(set: &[([u8; 32], u32, [u8; 33], u64)]) -> [u8; 32] {
    if set.is_empty() { return [0u8; 32]; }
    let mut h = Sha256::new();
    for (txid, vout, commit, amount) in set {
        h.update(txid);
        h.update(&vout.to_le_bytes());
        h.update(commit);
        h.update(&amount.to_le_bytes());
    }
    h.finalize().into()
}

fn extract_groth16_from_mint_envelope(env: &[u8]) -> Option<Vec<u8>> {
    if env.len() < 261 { return None; }
    let pl = u16::from_le_bytes([env[259], env[260]]) as usize;
    if env.len() < 261 + pl { return None; }
    Some(env[261..261 + pl].to_vec())
}
fn extract_groth16_from_burn_envelope(env: &[u8]) -> Option<Vec<u8>> {
    if env.len() < 281 { return None; }
    let pl = u16::from_le_bytes([env[279], env[280]]) as usize;
    if env.len() < 281 + pl { return None; }
    Some(env[281..281 + pl].to_vec())
}
fn extract_groth16_from_rotate_envelope(env: &[u8]) -> Option<Vec<u8>> {
    if env.len() < 228 { return None; }
    let pl = u16::from_le_bytes([env[226], env[227]]) as usize;
    if env.len() < 228 + pl { return None; }
    Some(env[228..228 + pl].to_vec())
}
fn extract_groth16_from_export_envelope(env: &[u8]) -> Option<Vec<u8>> {
    if env.len() < 229 { return None; }
    let pl = u16::from_le_bytes([env[227], env[228]]) as usize;
    if env.len() < 229 + pl { return None; }
    Some(env[229..229 + pl].to_vec())
}

fn extract_mint_public_inputs(env: &[u8]) -> Vec<[u8; 32]> {
    vec![env[66..98].try_into().unwrap(), env[98..130].try_into().unwrap(),
         env[34..66].try_into().unwrap(), env[195..227].try_into().unwrap(),
         env[227..259].try_into().unwrap()]
}
fn extract_burn_public_inputs(env: &[u8]) -> Vec<[u8; 32]> {
    vec![env[66..98].try_into().unwrap(), env[98..130].try_into().unwrap(),
         env[34..66].try_into().unwrap(), env[163..195].try_into().unwrap(),
         env[247..279].try_into().unwrap()]
}
fn extract_rotate_public_inputs(env: &[u8]) -> Vec<[u8; 32]> {
    vec![env[66..98].try_into().unwrap(), env[98..130].try_into().unwrap(),
         env[34..66].try_into().unwrap(), env[162..194].try_into().unwrap(),
         env[194..226].try_into().unwrap()]
}
fn extract_export_public_inputs(env: &[u8]) -> Vec<[u8; 32]> {
    vec![env[66..98].try_into().unwrap(), env[98..130].try_into().unwrap(),
         env[34..66].try_into().unwrap(), env[163..195].try_into().unwrap(),
         env[195..227].try_into().unwrap()]
}

fn try_verify_groth16(proof_bytes: &[u8], public_inputs: &[[u8; 32]], pvk: &Option<ark_groth16::PreparedVerifyingKey<ark_bn254::Bn254>>) -> bool {
    if proof_bytes.len() != 256 { return false; }
    match pvk { Some(pvk) => groth16::verify(pvk, proof_bytes, public_inputs), None => false }
}

fn is_canonical_field(bytes: &[u8; 32]) -> bool { *bytes < BN254_FIELD_SIZE }

const BN254_FIELD_SIZE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
    0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

fn u256_from_be(bytes: &[u8; 32]) -> [u64; 4] {
    [u64::from_be_bytes(bytes[24..32].try_into().unwrap()),
     u64::from_be_bytes(bytes[16..24].try_into().unwrap()),
     u64::from_be_bytes(bytes[8..16].try_into().unwrap()),
     u64::from_be_bytes(bytes[0..8].try_into().unwrap())]
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
    for i in (0..4).rev() { if a[i] < b[i] { return true; } if a[i] > b[i] { return false; } }
    false
}
fn u256_sub(a: &[u64; 4], b: &[u64; 4]) -> [u64; 4] {
    let mut r = [0u64; 4]; let mut borrow: u64 = 0;
    for i in 0..4 {
        let (d, b1) = a[i].overflowing_sub(b[i]);
        let (d2, b2) = d.overflowing_sub(borrow);
        r[i] = d2; borrow = (b1 as u64) + (b2 as u64);
    }
    r
}
