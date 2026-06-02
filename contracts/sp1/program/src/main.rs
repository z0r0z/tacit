#![cfg_attr(not(test), no_main)]
#[cfg(not(test))]
sp1_zkvm::entrypoint!(main);

use sp1_zkvm::io;
use sha2::{Sha256, Digest};
use std::collections::BTreeSet;

use teth_tree::merkle;
mod bitcoin;
mod groth16;
mod secp;

const TREE_DEPTH: usize = 20;
/// Mint-only headroom: rotate/import (0x62/0x64) refuse the top POOL_TREE_RESERVE
/// slots so they can't exhaust the capacity the Ethereum deposit gate
/// (TacitBridgeMixer.POOL_TREE_RESERVE) holds for in-flight mints. Must match the
/// mixer's constant. Closes audit F-2 (reserve-bypass griefing/strand). mint
/// (0x60) keeps the full can_insert() since it's the only insert backed by
/// newly-locked ETH with no other exit; burn/export insert no leaf.
const POOL_TREE_RESERVE: usize = 1024;

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
        // A denomination MUST fit in u64: export/import track UTXO amounts as u64
        // (denom_u64s), so the low-64-bit value must faithfully represent the full
        // 32-byte denom — otherwise two denoms colliding in their low 64 bits could
        // let value cross between pools. Reject any high bits.
        assert!(d32[0..24].iter().all(|&b| b == 0), "denomination exceeds u64");
        denom_u64s.push(u64::from_be_bytes(d32[24..32].try_into().unwrap()));
        denom_bytes.push(d32);
    }
    // Denominations must be pairwise distinct (both as full bytes and as the u64
    // amount), so a UTXO of amount D imports into exactly one pool.
    for i in 0..nd {
        for j in (i + 1)..nd {
            assert!(denom_u64s[i] != denom_u64s[j], "duplicate denomination");
        }
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
        let null_set_check = merkle::NullifierSet::from_sorted(prev_nullifiers.clone());
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

        // Slim input: the host feeds the FULL txid set (for the merkle root) but
        // only the coinbase + bridge-carrying txs in full. The merkle root over
        // all txids, checked against the verified header, authenticates the txid
        // set as the block's real + complete tx list — so the host cannot hide,
        // fabricate, or re-order any tx. Each provided full tx is then pinned to
        // its position via compute_txid == txids[tx_idx]. Non-bridge txs are never
        // parsed in-circuit (mainnet blocks carry ~4000 txs; this keeps cycles flat).
        let num_txs: u32 = io::read();
        let mut txids: Vec<[u8; 32]> = Vec::with_capacity(num_txs as usize);
        for _ in 0..num_txs {
            let t: Vec<u8> = io::read();
            txids.push(t[..].try_into().expect("txid must be 32 bytes"));
        }
        assert!(bitcoin::compute_merkle_root(&txids) == block_merkle_root, "tx merkle root mismatch");

        let num_provided: u32 = io::read();
        let mut saw_coinbase = false;
        for _ in 0..num_provided {
            let tx_idx: u32 = io::read();
            let tx_data: Vec<u8> = io::read();
            assert!((tx_idx as usize) < txids.len(), "provided tx_idx out of range");
            let txid = bitcoin::compute_txid(&tx_data);
            assert!(txid == txids[tx_idx as usize], "provided tx not in block at its index");

            // Coinbase invariant (BIP30 / consensus): first tx of every block
            // must be coinbase — vin[0].txid == all-zeros, vout == 0xffffffff.
            // Bitcoin Core consensus enforces this; we assert it so the guest
            // fails loudly on a malformed block rather than silently accepting
            // a header with no coinbase + funded "txs". Audit BTC-2.
            if tx_idx == 0 {
                saw_coinbase = true;
                let inps = bitcoin::extract_input_outpoints(&tx_data);
                assert!(!inps.is_empty(), "tx 0 has no inputs (malformed coinbase)");
                assert!(inps[0].0 == [0u8; 32] && inps[0].1 == 0xffffffff,
                    "tx 0 is not a coinbase (vin[0] != zero/0xffffffff)");
            }

            let op_returns = bitcoin::extract_all_op_returns(&tx_data);
            // T_WITHDRAW (0x2A) ships in the Taproot reveal witness, not an
            // OP_RETURN — dispatch here off extract_taproot_envelope. Closes
            // the bridge-side seam where the same pool note could exit via
            // 0x2A (mixer ledger marks the nullifier) AND later be burned
            // via 0x61 (bridge ledger sees nullifier unspent → fractional
            // reserve). Marks the nullifier in the BRIDGE null_set + registers
            // the emitted stealth UTXO at vout 0 (T_WITHDRAW reveal pattern).
            //
            // T_WITHDRAW: opcode(1) | assetId(32) | denom_LE(8) | merkle_root(32)
            //           | nullifier(32) | recip_commit(33) | r_leaf(32)
            //           | bind_hash(32) | proof_len(2 LE) | proof(proof_len)
            //
            // No chainid/mixer/networkTag (asset-scoped, not bridge-scoped) —
            // so a tETH withdraw on signet looks identical to one on mainnet
            // tacit; the bind_hash uses the WITHDRAW_BIND_DOMAIN constant.
            if let Some(tap_env) = bitcoin::extract_taproot_envelope(&tx_data) {
                if !tap_env.is_empty() && tap_env[0] == 0x2A && tap_env.len() >= 204 {
                    let envelope = &tap_env[..];
                    let env_asset: [u8; 32] = envelope[1..33].try_into().unwrap();
                    if env_asset == asset_id32 {
                        let env_denom_le: [u8; 8] = envelope[33..41].try_into().unwrap();
                        let env_denom_u64 = u64::from_le_bytes(env_denom_le);
                        if let Some(di) = denom_u64s.iter().position(|&d| d == env_denom_u64) {
                            let env_pool_root: [u8; 32] = envelope[41..73].try_into().unwrap();
                            if known_pool_roots[di].contains(&env_pool_root) {
                                let env_nullifier: [u8; 32] = envelope[73..105].try_into().unwrap();
                                let env_recip_commit: [u8; 33] = envelope[105..138].try_into().unwrap();
                                let env_r_leaf: [u8; 32] = envelope[138..170].try_into().unwrap();
                                let env_bind_hash: [u8; 32] = envelope[170..202].try_into().unwrap();
                                let bind_ok = {
                                    let mut h = Sha256::new();
                                    h.update(b"tacit-withdraw-bind-v1");
                                    h.update(&asset_id32);
                                    h.update(&env_denom_le);
                                    h.update(&env_nullifier);
                                    h.update(&env_recip_commit);
                                    h.update(&env_r_leaf);
                                    let computed: [u8; 32] = h.finalize().into();
                                    computed == env_bind_hash
                                };
                                if bind_ok {
                                    let proof_len = u16::from_le_bytes([envelope[202], envelope[203]]) as usize;
                                    if envelope.len() >= 204 + proof_len {
                                        let proof_bytes = envelope[204..204 + proof_len].to_vec();
                                        let mut denom_be32 = [0u8; 32];
                                        denom_be32[24..32].copy_from_slice(&env_denom_u64.to_be_bytes());
                                        let inputs = vec![env_pool_root, env_nullifier, denom_be32, env_r_leaf, env_bind_hash];
                                        if try_verify_groth16(&proof_bytes, &inputs, &prepared_vk) && null_set.insert(env_nullifier) {
                                            utxo_set.push((txid, 0u32, env_recip_commit, denom_u64s[di]));
                                            transition_count += 1;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // Bridge ops (0x60–0x64) ride in the Taproot reveal witness:
                // mainnet Bitcoin Core caps OP_RETURN at 80B but bridge
                // envelopes are 164–537B, so the witness is the only relayable
                // carrier. EXPORT (0x63) registers its stealth UTXO at the
                // reveal's spendable output, vout 0. Audit
                // ops/PLAN-bridge-op-return-standardness.md.
                if !tap_env.is_empty()
                    && matches!(tap_env[0], 0x60 | 0x61 | 0x62 | 0x63 | 0x64)
                    && tap_env.len() >= 66
                    && tap_env[1] == network_tag
                {
                    let envelope = &tap_env[..];
                    let env_asset: [u8; 32] = envelope[2..34].try_into().unwrap();
                    if env_asset == asset_id32 {
                        let env_denom: [u8; 32] = envelope[34..66].try_into().unwrap();
                        if let Some(di) = denom_bytes.iter().position(|d| *d == env_denom) {
                            match envelope[0] {
                                0x60 => 'mint: {
                                    if envelope.len() < 517 { break 'mint; }
                                    let env_eth_root: [u8; 32] = envelope[66..98].try_into().unwrap();
                                    if all_valid_deposit_roots[di].binary_search(&env_eth_root).is_err() { break 'mint; }
                                    let env_nullifier: [u8; 32] = envelope[98..130].try_into().unwrap();
                                    let env_recip_commit: &[u8] = &envelope[130..163];
                                    let env_leaf: [u8; 32] = envelope[163..195].try_into().unwrap();
                                    if !is_canonical_field(&env_leaf) { break 'mint; }
                                    let env_r_leaf: [u8; 32] = envelope[195..227].try_into().unwrap();
                                    let env_bind_hash: [u8; 32] = envelope[227..259].try_into().unwrap();
                                    let computed = compute_bind_hash(
                                        b"tacit-bridge-deposit-v1", chain_id, &mixer_address, network_tag,
                                        &asset_id, &env_denom, &[&env_eth_root, &env_nullifier, env_recip_commit, &env_leaf, &env_r_leaf],
                                    );
                                    if computed != env_bind_hash { break 'mint; }
                                    let proof = match extract_groth16_from_mint_envelope(envelope) { Some(p) => p, None => break 'mint };
                                    let inputs = extract_mint_public_inputs(envelope);
                                    if !try_verify_groth16(&proof, &inputs, &prepared_vk) { break 'mint; }
                                    if !trees[di].can_insert() { break 'mint; }
                                    if !null_set.insert(env_nullifier) { break 'mint; }
                                    trees[di].insert(env_leaf);
                                    known_pool_roots[di].insert(trees[di].root());
                                    transition_count += 1;
                                }
                                0x62 => 'rotate: {
                                    if envelope.len() < 484 { break 'rotate; }
                                    let env_pool_root: [u8; 32] = envelope[66..98].try_into().unwrap();
                                    if !known_pool_roots[di].contains(&env_pool_root) { break 'rotate; }
                                    let env_nullifier: [u8; 32] = envelope[98..130].try_into().unwrap();
                                    let env_new_commit: [u8; 32] = envelope[130..162].try_into().unwrap();
                                    if !is_canonical_field(&env_new_commit) { break 'rotate; }
                                    let env_r_leaf: [u8; 32] = envelope[162..194].try_into().unwrap();
                                    let env_bind_hash: [u8; 32] = envelope[194..226].try_into().unwrap();
                                    let computed = compute_bind_hash(
                                        b"tacit-bridge-rotate-v1", chain_id, &mixer_address, network_tag,
                                        &asset_id, &env_denom, &[&env_pool_root, &env_nullifier, &env_new_commit, &env_r_leaf],
                                    );
                                    if computed != env_bind_hash { break 'rotate; }
                                    let proof = match extract_groth16_from_rotate_envelope(envelope) { Some(p) => p, None => break 'rotate };
                                    let inputs = extract_rotate_public_inputs(envelope);
                                    if !try_verify_groth16(&proof, &inputs, &prepared_vk) { break 'rotate; }
                                    if !trees[di].can_insert_with_reserve(POOL_TREE_RESERVE) { break 'rotate; }
                                    if !null_set.insert(env_nullifier) { break 'rotate; }
                                    trees[di].insert(env_new_commit);
                                    known_pool_roots[di].insert(trees[di].root());
                                    transition_count += 1;
                                }
                                0x61 => 'burn: {
                                    if envelope.len() < 537 { break 'burn; }
                                    let env_pool_root: [u8; 32] = envelope[66..98].try_into().unwrap();
                                    if !known_pool_roots[di].contains(&env_pool_root) { break 'burn; }
                                    let env_nullifier: [u8; 32] = envelope[98..130].try_into().unwrap();
                                    let env_recip_commit: &[u8] = &envelope[130..163];
                                    let env_r_leaf: [u8; 32] = envelope[163..195].try_into().unwrap();
                                    let env_recipient: [u8; 20] = envelope[195..215].try_into().unwrap();
                                    let env_burn_nonce: [u8; 32] = envelope[215..247].try_into().unwrap();
                                    let env_bind_hash: [u8; 32] = envelope[247..279].try_into().unwrap();
                                    let computed = compute_bind_hash(
                                        b"tacit-bridge-burn-v1", chain_id, &mixer_address, network_tag,
                                        &asset_id, &env_denom,
                                        &[&env_pool_root, &env_nullifier, env_recip_commit, &env_r_leaf, &env_recipient, &env_burn_nonce],
                                    );
                                    if computed != env_bind_hash { break 'burn; }
                                    let proof = match extract_groth16_from_burn_envelope(envelope) { Some(p) => p, None => break 'burn };
                                    let inputs = extract_burn_public_inputs(envelope);
                                    if !try_verify_groth16(&proof, &inputs, &prepared_vk) { break 'burn; }
                                    if !null_set.insert(env_nullifier) { break 'burn; }
                                    let mut h = Sha256::new();
                                    h.update(&env_nullifier);
                                    h.update(&env_denom);
                                    h.update(&env_pool_root);
                                    h.update(&env_recipient);
                                    h.update(&env_bind_hash);
                                    burn_nullifiers[di].push(h.finalize().into());
                                    transition_count += 1;
                                }
                                0x63 => 'export: {
                                    if envelope.len() < 485 { break 'export; }
                                    let env_pool_root: [u8; 32] = envelope[66..98].try_into().unwrap();
                                    if !known_pool_roots[di].contains(&env_pool_root) { break 'export; }
                                    let env_nullifier: [u8; 32] = envelope[98..130].try_into().unwrap();
                                    let env_recip_commit: [u8; 33] = envelope[130..163].try_into().unwrap();
                                    let env_r_leaf: [u8; 32] = envelope[163..195].try_into().unwrap();
                                    let env_bind_hash: [u8; 32] = envelope[195..227].try_into().unwrap();
                                    let computed = compute_bind_hash(
                                        b"tacit-bridge-export-v1", chain_id, &mixer_address, network_tag,
                                        &asset_id, &env_denom, &[&env_pool_root, &env_nullifier, &env_recip_commit, &env_r_leaf],
                                    );
                                    if computed != env_bind_hash { break 'export; }
                                    let proof = match extract_groth16_from_export_envelope(envelope) { Some(p) => p, None => break 'export };
                                    let inputs = extract_export_public_inputs(envelope);
                                    if !try_verify_groth16(&proof, &inputs, &prepared_vk) { break 'export; }
                                    if !null_set.insert(env_nullifier) { break 'export; }
                                    // The reveal's spendable stealth output is vout 0;
                                    // register the export UTXO there (matches T_WITHDRAW).
                                    utxo_set.push((txid, 0u32, env_recip_commit, denom_u64s[di]));
                                    transition_count += 1;
                                }
                                0x64 => 'import: {
                                    if envelope.len() < 164 { break 'import; }
                                    let env_new_commit: [u8; 32] = envelope[66..98].try_into().unwrap();
                                    if !is_canonical_field(&env_new_commit) { break 'import; }
                                    let env_bind_hash: [u8; 32] = envelope[98..130].try_into().unwrap();
                                    let env_prev_txid: [u8; 32] = envelope[130..162].try_into().unwrap();
                                    let env_prev_vout: u32 = u16::from_le_bytes([envelope[162], envelope[163]]) as u32;
                                    let computed = compute_bind_hash(
                                        b"tacit-bridge-import-v1", chain_id, &mixer_address, network_tag,
                                        &asset_id, &env_denom, &[&env_new_commit, &env_prev_txid, &envelope[162..164]],
                                    );
                                    if computed != env_bind_hash { break 'import; }
                                    let utxo_idx = match utxo_set.iter().position(|(t, v, _, _)| *t == env_prev_txid && *v == env_prev_vout) {
                                        Some(i) => i, None => break 'import,
                                    };
                                    if utxo_set[utxo_idx].3 != denom_u64s[di] { break 'import; }
                                    let mut found_input = false;
                                    let inp_data = bitcoin::extract_input_outpoints(&tx_data);
                                    for (inp_txid, inp_vout) in &inp_data {
                                        if *inp_txid == env_prev_txid && *inp_vout == env_prev_vout { found_input = true; break; }
                                    }
                                    if !found_input { break 'import; }
                                    if !trees[di].can_insert_with_reserve(POOL_TREE_RESERVE) { break 'import; }
                                    utxo_set.remove(utxo_idx);
                                    trees[di].insert(env_new_commit);
                                    known_pool_roots[di].insert(trees[di].root());
                                    transition_count += 1;
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }

            // CXFER conservation-verified tracking.
            // An untracked input at index 0 is tolerated (a plain Bitcoin fee
            // input): it contributes 0 to tracked_input_sum, and conservation
            // still requires out_sum == tracked_input_sum, so it cannot inject
            // value. An untracked input at index > 0 disables tracking entirely.
            let inp_outpoints = bitcoin::extract_input_outpoints(&tx_data);
            let mut tracked_input_sum: u64 = 0;
            let mut has_tracked = false;
            let mut all_tracked = true;
            for (i, (it, iv)) in inp_outpoints.iter().enumerate() {
                if let Some(idx) = utxo_set.iter().position(|(t, v, _, _)| t == it && *v == *iv) {
                    // checked_add mirrors the output side; a wrap (unreachable with
                    // real value, total tracked << 2^64) disables tracking rather
                    // than silently aliasing a large sum to a small one.
                    match tracked_input_sum.checked_add(utxo_set[idx].3) {
                        Some(s) => { tracked_input_sum = s; has_tracked = true; }
                        None => { all_tracked = false; }
                    }
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

        assert!(saw_coinbase, "coinbase (tx 0) must be among the provided txs");
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

    // ──── Commit submission tail (authenticated, read directly on-chain) ────
    // The 461-byte head carries the compact state/domain hashes. proveStateTransition
    // also needs the raw per-denomination deposit accumulators (to compare against the
    // mixer) and burn claim IDs (to mark accepted burns). Commit them here so the
    // verifier reads them straight from the authenticated public values — no calldata,
    // no re-derivation. Verified against deposit_accs_hash / burns_hash in the head.
    // Layout (after byte 461): deposit_accs[nd*32] | counts[nd*4 BE] | claims[sum*32]
    for a in &deposit_root_accumulators { io::commit_slice(a); }
    for bn in &burn_nullifiers { io::commit_slice(&(bn.len() as u32).to_be_bytes()); }
    for bn in &burn_nullifiers { for c in bn { io::commit_slice(c); } }

    // ──── Incremental-state emission (host-only tail) ────
    // After the on-chain-consumed tail above, emit the full post-cycle state
    // as additional SP1-authenticated public values. The on-chain verifier
    // reads only up to the burn-claims tail; anything past that is ignored
    // by proveStateTransition but still authenticated by the SP1 proof. The
    // prover host parses this tail + saves to STATE_FILE; the next cycle
    // loads it as prev_state. See ops/prover-incremental-state.md (Option B).
    //
    // Format (binary, no length-prefix on the per-pool block since nd is
    // known from the head's denoms_hash + the constructor's NUM_DENOMS):
    //   per pool (nd pools): 32 bytes (root) + 8 bytes BE u64 (next_index)
    //                        + TREE_DEPTH * 32 bytes (frontier)
    //   4 bytes BE u32: null_entries_count
    //   null_entries_count * 32: nullifiers (sorted ascending)
    //   4 bytes BE u32: utxo_entries_count
    //   utxo_entries_count * (32 + 4 + 33 + 8): (txid, vout BE u32, commit 33B, amount BE u64)
    for tree in &trees {
        io::commit_slice(&tree.root());
        io::commit_slice(&(tree.next_index() as u64).to_be_bytes());
        for f in tree.frontier().iter() { io::commit_slice(f); }
    }
    let null_entries = null_set.entries();
    io::commit_slice(&(null_entries.len() as u32).to_be_bytes());
    for n in null_entries { io::commit_slice(n); }
    io::commit_slice(&(utxo_set.len() as u32).to_be_bytes());
    for (txid, vout, commit, amount) in &utxo_set {
        io::commit_slice(txid);
        io::commit_slice(&vout.to_be_bytes());
        io::commit_slice(commit);
        io::commit_slice(&amount.to_be_bytes());
    }
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

#[cfg(test)]
mod dispatch_seam_tests {
    // Pins the bridge double-claim seam (audit Gate A) against regressions.
    //
    // Gate A: a pool note must not be claimable in BOTH the mixer ledger (via
    // 0x2A T_WITHDRAW) AND the bridge ledger (via 0x61 T_BRIDGE_BURN). The guest
    // closes the seam by inserting nullifiers into a single shared null_set —
    // either dispatcher hitting the set first wins; the second is silently
    // skipped. A prior fix that put the 0x2A handler in the OP_RETURN dispatch
    // loop was a silent no-op because dapp emits T_WITHDRAW via Taproot reveal;
    // this test fixes the dispatch path for 0x2A in source code so the
    // regression cannot recur.
    //
    // What's pinned here:
    //   (1) Structural — 0x2A dispatch lives BEFORE the OP_RETURN loop, after
    //       the extract_taproot_envelope call site. If a future refactor moves
    //       0x2A back into the OP_RETURN loop (the prior regression), the
    //       structural assertion fails.
    //   (2) Behavioral — a shared merkle::NullifierSet rejects a duplicate
    //       nullifier insertion. Models exactly what the guest does after a
    //       successful proof+layout validation in either handler.
    //   (3) Layout — synthetic 0x2A and 0x61 envelopes constructed at the
    //       documented offsets each yield the same nullifier bytes, so the
    //       seam can actually be hit by a real pair of envelopes.

    use super::*;

    const T_WITHDRAW: u8 = 0x2A;
    const T_BRIDGE_BURN: u8 = 0x61;

    // 0x2A T_WITHDRAW: opcode(1) | assetId(32) | denom_LE(8) | merkle_root(32)
    //                | nullifier(32) | recip_commit(33) | r_leaf(32)
    //                | bind_hash(32) | proof_len(2 LE) | proof(0)
    // (No chainid/mixer/networkTag — asset-scoped, see main.rs:243-249.)
    const T_WITHDRAW_NULLIFIER_OFF: usize = 1 + 32 + 8 + 32;

    // 0x61 T_BRIDGE_BURN: opcode(1) | network_tag(1) | assetId(32) | denom(32)
    //                   | pool_root(32) | nullifier(32) | recip_commit(33)
    //                   | r_leaf(32) | recipient(20) | burn_nonce(32)
    //                   | bind_hash(32) | proof_len(2 LE) | proof(0)
    const T_BRIDGE_BURN_NULLIFIER_OFF: usize = 1 + 1 + 32 + 32 + 32;

    fn build_t_withdraw_envelope(nullifier: [u8; 32]) -> Vec<u8> {
        let asset_id = [0x11u8; 32];
        let denom_le: [u8; 8] = 100_000u64.to_le_bytes();
        let pool_root = [0x22u8; 32];
        let recip_commit = [0x02u8; 33];
        let r_leaf = [0x44u8; 32];
        let bind_hash = [0x55u8; 32];
        let proof_len_le: [u8; 2] = [0, 0];

        let mut env = Vec::new();
        env.push(T_WITHDRAW);
        env.extend_from_slice(&asset_id);
        env.extend_from_slice(&denom_le);
        env.extend_from_slice(&pool_root);
        env.extend_from_slice(&nullifier);
        env.extend_from_slice(&recip_commit);
        env.extend_from_slice(&r_leaf);
        env.extend_from_slice(&bind_hash);
        env.extend_from_slice(&proof_len_le);
        env
    }

    fn build_bridge_burn_envelope(nullifier: [u8; 32]) -> Vec<u8> {
        let network_tag: u8 = 0x01;
        let asset_id = [0x11u8; 32];
        let denom = [0u8; 32];
        let pool_root = [0x22u8; 32];
        let recip_commit = [0x02u8; 33];
        let r_leaf = [0x44u8; 32];
        let recipient = [0x77u8; 20];
        let burn_nonce = [0x55u8; 32];
        let bind_hash = [0x66u8; 32];
        let proof_len_le: [u8; 2] = [0, 0];

        let mut env = Vec::new();
        env.push(T_BRIDGE_BURN);
        env.push(network_tag);
        env.extend_from_slice(&asset_id);
        env.extend_from_slice(&denom);
        env.extend_from_slice(&pool_root);
        env.extend_from_slice(&nullifier);
        env.extend_from_slice(&recip_commit);
        env.extend_from_slice(&r_leaf);
        env.extend_from_slice(&recipient);
        env.extend_from_slice(&burn_nonce);
        env.extend_from_slice(&bind_hash);
        env.extend_from_slice(&proof_len_le);
        env
    }

    #[test]
    fn t_withdraw_and_bridge_burn_envelopes_carry_nullifier_at_documented_offsets() {
        let nullifier: [u8; 32] = [0x33u8; 32];
        let env_tw = build_t_withdraw_envelope(nullifier);
        let env_bb = build_bridge_burn_envelope(nullifier);

        let tw_n = &env_tw[T_WITHDRAW_NULLIFIER_OFF..T_WITHDRAW_NULLIFIER_OFF + 32];
        let bb_n = &env_bb[T_BRIDGE_BURN_NULLIFIER_OFF..T_BRIDGE_BURN_NULLIFIER_OFF + 32];
        assert_eq!(tw_n, &nullifier, "T_WITHDRAW nullifier at offset 73");
        assert_eq!(bb_n, &nullifier, "T_BRIDGE_BURN nullifier at offset 98");
        assert_eq!(tw_n, bb_n, "envelopes carry the same nullifier — seam can be hit");
    }

    #[test]
    fn null_set_rejects_double_claim_t_withdraw_then_bridge_burn() {
        // The shared null_set semantic: the guest inserts a nullifier after a
        // successful proof + layout validation in EITHER handler. A duplicate
        // insertion of the same nullifier from the OTHER handler returns false,
        // which the dispatch code uses to short-circuit. This is the seam.
        let nullifier: [u8; 32] = [0x33u8; 32];
        let mut null_set = merkle::NullifierSet::new();

        // Step 1: T_WITHDRAW path lands the nullifier (post-proof-verify).
        assert!(null_set.insert(nullifier), "first claim consumes the nullifier");

        // Step 2: T_BRIDGE_BURN path tries the same nullifier — same null_set,
        // insert returns false; the guest's `if null_set.insert(...) { ... }`
        // short-circuits and the burn is silently skipped (no eth payout claim
        // queued, no UTXO emitted). Funds-safe.
        assert!(
            !null_set.insert(nullifier),
            "second claim of same nullifier is rejected by the shared null_set",
        );

        // Reverse direction also holds — first-write-wins is symmetric.
        let nullifier2: [u8; 32] = [0x44u8; 32];
        let mut null_set2 = merkle::NullifierSet::new();
        assert!(null_set2.insert(nullifier2), "burn-first lands nullifier");
        assert!(
            !null_set2.insert(nullifier2),
            "withdraw-after-burn on same nullifier is rejected",
        );
    }

    #[test]
    fn t_withdraw_dispatch_lives_in_taproot_path() {
        // Structural pin (audit Gate A): the 0x2A T_WITHDRAW handler must live
        // in the Taproot reveal dispatch. T_WITHDRAW envelopes ship in the
        // reveal witness, never an OP_RETURN, so a handler scoped anywhere else
        // is a silent no-op and the bridge/mixer double-claim seam re-opens.
        let src = include_str!("main.rs");
        let taproot_extract = src
            .find("bitcoin::extract_taproot_envelope(&tx_data)")
            .expect("guest calls extract_taproot_envelope per-tx");
        let t_withdraw_opcode_check = src
            .find("tap_env[0] == 0x2A")
            .expect("guest dispatches 0x2A off the Taproot envelope opcode");
        assert!(
            t_withdraw_opcode_check > taproot_extract,
            "0x2A check appears AFTER the extract_taproot_envelope call (Taproot path)",
        );
    }

    #[test]
    fn bridge_ops_dispatched_from_taproot_path() {
        // Structural pin: bridge ops 0x60-0x64 are dispatched in the Taproot
        // reveal path. Mainnet Bitcoin Core caps OP_RETURN at 80B; bridge
        // envelopes (164-537B) only relay as Taproot reveals through
        // default-policy nodes. If a refactor drops the Taproot dispatch,
        // mainnet bridge txs would never relay — this catches that.
        let src = include_str!("main.rs");
        let taproot_extract = src
            .find("bitcoin::extract_taproot_envelope(&tx_data)")
            .expect("guest calls extract_taproot_envelope per-tx");
        let bridge_taproot_check = src
            .find("matches!(tap_env[0], 0x60 | 0x61 | 0x62 | 0x63 | 0x64)")
            .expect("guest dispatches 0x60-0x64 off the Taproot envelope opcode");
        assert!(
            bridge_taproot_check > taproot_extract,
            "bridge ops Taproot check appears AFTER extract_taproot_envelope",
        );
    }

    #[test]
    fn bridge_taproot_dispatch_consumes_nullifiers() {
        // The Taproot bridge dispatch must consume each spend's nullifier into
        // the shared null_set (mint/rotate/burn/export — import re-enters a pool
        // without minting a new nullifier). A handler that skips null_set.insert
        // would let the same note be claimed twice. Bound the bridge section
        // from the matches! arm to the CXFER tracking block that follows it.
        let src = include_str!("main.rs");
        let bridge_start = src
            .find("matches!(tap_env[0], 0x60 | 0x61 | 0x62 | 0x63 | 0x64)")
            .expect("guest has Taproot bridge dispatch");
        let bridge_end = src[bridge_start..]
            .find("// CXFER conservation-verified tracking")
            .map(|o| bridge_start + o)
            .expect("CXFER tracking follows the bridge dispatch");
        let section = &src[bridge_start..bridge_end];
        let inserts = section.matches("null_set.insert").count();
        assert!(
            inserts >= 4,
            "Taproot bridge dispatch should insert nullifiers for mint/rotate/burn/export; found {}",
            inserts,
        );
    }
}
