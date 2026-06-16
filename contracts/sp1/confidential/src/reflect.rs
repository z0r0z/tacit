//! Reflection prover — proves the Bitcoin confidential-pool roots that
//! ConfidentialPool.attestBitcoinStateProven pins as the cross-lane / bridge_mint authority.
//!
//! FULL SCAN (F4 closed): the prover is HANDED the live pool UTXO set, re-derives the resume
//! digest from it (so the contract's `priorDigest == knownReflectionDigest` chain pins the handed
//! set — a wrong handoff fails the digest), then walks EVERY tx of EVERY block in the batch and
//! resolves each tx's vins against that set. Because no tx is skipped (the provided txs must
//! re-hash to the header's merkle root) and no vin is skipped, a relayer can no longer OMIT a
//! Bitcoin spend of a pool note — even a plain, non-protocol spend of a pool UTXO is nullified.
//! That is the completeness the earlier witnessed-effects model (relayer-chosen txs) could not
//! guarantee, so the cross-lane non-membership gate is now sound, not caveated.
//!
//! The note tree, spent-set, and bridge-burn set stay HEADLESS (roots + counts + witnessed
//! transitions, O(Δ)/cycle); only the UTXO set is full in-memory (`LiveUtxoSet`, the vin-lookup
//! source, O(live) to verify once per batch). Per batch: O(live) set-verify + O(block) vin-scan +
//! O(Δ) witnessed spent/note/burn — see the reflection prover memo for the scale envelope.
//!
//! ANCHOR (F1/F2/F3 closed): the guest commits `bitcoinPrevHash` (headers[0]'s prev field) +
//! `bitcoinTipHash` (the last header's hash); ConfidentialPool pins the tip to the canonical
//! BitcoinLightRelay (`RELAY.tip()` within FINALITY_WINDOW) and the prev to the prior attested tip,
//! forcing the whole proven chain to be canonical Bitcoin (self-declared difficulty moot; the
//! finality window gives confirmation/reorg tolerance). The ctor binds them: a non-zero
//! BITCOIN_RELAY_VKEY requires a non-zero HEADER_RELAY.
#![no_main]
sp1_zkvm::entrypoint!(main);

use alloy_sol_types::sol;
use alloy_sol_types::private::U256;
use alloy_sol_types::SolType;
use cxfer_core::{
    amm_canonical_pair, amm_derive_farm_id, amm_derive_pool_id_full, amm_derive_pool_id_v1, bitcoin, burn_deposit, commitment_hash,
    commitment_hash_compressed, compress, decompress, from_affine_xy, leaf, nullifier, outpoint_key,
    reflected_note_leaf, scan_tx_spends, verify_cxfer_conservation, LiveUtxoSet, Point, PoolReserveSet,
    PoolReserveState, ScanReflection,
};
use sp1_zkvm::io;

// The in-guest BN254 Groth16 verifier for T_SWAP_BATCH (reflection-only; pulls the SP1-precompile `bn`
// crate into this ELF, not the settle one). `groth16_bn254_verify` is ready; the remaining `fold_swap_batch`
// glue (parse the 0x2F envelope → re-derive the 123 public signals from it → verify against the baked
// BATCH_VK → per-receipt witnessed-opening onboarding) needs the circuit's public-signal layout + the baked
// vk. See ops/DESIGN-in-guest-groth16-verifier.md.
#[allow(dead_code)]
mod groth16;
mod babyjubjub;
mod swap_batch;

sol! {
    struct BitcoinReflectionPublicValues {
        bytes32 priorDigest;       // the reflected state this cycle continues from
        bytes32 bitcoinPoolRoot;   // note-tree root after the batch
        bytes32 bitcoinSpentRoot;  // spent-set IMT root after the batch
        bytes32 bitcoinBurnRoot;   // bridge-burn set root after the batch
        uint64  bitcoinHeight;     // confirmed Bitcoin height the batch advanced to
        bytes32 newDigest;         // the reflected state after the batch (next cycle's prior)
        bytes32 bitcoinPrevHash;   // headers[0]'s prev-block field — the anchor this batch resumes from
        bytes32 bitcoinTipHash;    // double-SHA256 of the last header — the batch's new tip
        bytes32 ethPoolReflected;  // Mode B: the eth-reflection's ethPool — attest gates it == address(this)
        uint256 cbtcBackingSats;   // cBTC: Σ live self-custody cBTC.zk lock sats (the off-pool buffer reads it)
    }
}

fn r_n<const N: usize>() -> [u8; N] {
    let v: Vec<u8> = io::read();
    v.try_into().expect("witness field length")
}
fn r32() -> [u8; 32] { r_n::<32>() }
fn r_path() -> Vec<[u8; 32]> { (0..32).map(|_| r32()).collect() }

/// Resume anchor: the headless roots + counts, the HANDED live UTXO set (sorted (key,value)
/// pairs), and the height. `from_sorted` rejects an unsorted/duplicate handoff; the digest
/// re-derivation pins the set's root + size (the contract chains it), so this IS the O(live)
/// verify-once step — no separate root check needed.
fn read_scan_prior_state() -> ScanReflection {
    let pool_root = r32();
    let note_count: u64 = io::read();
    let spent_root = r32();
    let spent_count: u64 = io::read();
    let n_live: u32 = io::read();
    // Each live entry is (outpoint key, commitment_hash, asset_id): the asset is carried so the
    // CXFER fold can re-impose asset preservation on a spend (the digest commits all three).
    let live_triples: Vec<([u8; 32], [u8; 32], [u8; 32])> = (0..n_live).map(|_| (r32(), r32(), r32())).collect();
    let live = LiveUtxoSet::from_sorted(live_triples).expect("handed live UTXO set not sorted/unique");
    let burn_root = r32();
    let burn_count: u64 = io::read();
    let height: u64 = io::read();
    // cBTC.zk resume state: the live self-custody lock set (key, sats-as-32B, asset) + the running
    // Σ backing sats. Both ride digest() (cxfer-core), so a wrong handoff fails the priorDigest chain.
    // Empty for a no-lock batch (n=0, sats=0); the assembler/indexer emit the prior set for live locks.
    let n_cbtc_locks: u32 = io::read();
    let cbtc_lock_triples: Vec<([u8; 32], [u8; 32], [u8; 32])> = (0..n_cbtc_locks).map(|_| (r32(), r32(), r32())).collect();
    let cbtc_locks = LiveUtxoSet::from_sorted(cbtc_lock_triples).expect("handed cBTC lock set not sorted/unique");
    let cbtc_backing_sats: u64 = io::read();
    // Track B resume state: the per-pool reserve registry — (pool_id, asset_a, asset_b, reserve_a,
    // reserve_b, c0_backed). Rides digest() (cxfer-core), so a wrong handoff (forged reserve / flipped
    // backing flag) fails the priorDigest chain. Empty for a no-AMM-pool batch (n=0).
    let n_pools: u32 = io::read();
    let pool_entries: Vec<([u8; 32], PoolReserveState)> = (0..n_pools).map(|_| {
        let pool_id = r32();
        let asset_a = r32();
        let asset_b = r32();
        let reserve_a: u64 = io::read();
        let reserve_b: u64 = io::read();
        let total_shares: u64 = io::read();
        let c0_backed: u32 = io::read();
        (pool_id, PoolReserveState { asset_a, asset_b, reserve_a, reserve_b, total_shares, c0_backed: c0_backed != 0 })
    }).collect();
    let pools = PoolReserveSet::from_sorted(pool_entries).expect("handed pool reserve set not sorted/unique");
    ScanReflection {
        pool_root, note_count, spent_root, spent_count, live, burn_root, burn_count, height,
        cbtc_locks, cbtc_backing_sats, pools,
    }
}

/// One spent-set IMT insert witness (the low leaf + the two paths). ν comes from the scan.
fn read_spent_insert() -> ([u8; 32], [u8; 32], u64, Vec<[u8; 32]>, Vec<[u8; 32]>) {
    let low_value = r32();
    let low_next = r32();
    let low_index: u64 = io::read();
    let low_path = r_path();
    let new_path = r_path();
    (low_value, low_next, low_index, low_path, new_path)
}

/// One bridge-burn set insert witness (ν → destCommitment; the low node + the two paths).
fn read_burn_insert() -> ([u8; 32], [u8; 32], [u8; 32], u64, Vec<[u8; 32]>, Vec<[u8; 32]>) {
    let low_key = r32();
    let low_next = r32();
    let low_value = r32();
    let low_index: u64 = io::read();
    let low_path = r_path();
    let new_path = r_path();
    (low_key, low_next, low_value, low_index, low_path, new_path)
}

pub fn main() {
    let mut state = read_scan_prior_state();
    let prior_digest = state.digest();

    // ── Mode B reverse reflection: recursively verify the eth-reflection proof, then admit its
    // attested cross-out set. The eth-reflection guest (helios light-client + a crossOutCommitment
    // storage proof against finalized Ethereum) commits `EthReflectionPublicValues`;
    // `verify_sp1_proof` binds these bytes to THAT program (the inner Compressed proof is supplied to
    // the prover via SP1Stdin::write_proof), so a `fold_crossout` below trusts a cross-out finalized on
    // Ethereum — not the worker. See ops/PLAN-eth-reflection-modeB.md + ops/DESIGN-mode-b-recursion.md.
    // The eth-reflection guest's RECURSION vk_digest (vk.hash_u32(), the Poseidon digest verify_sp1_proof
    // checks — NOT the on-chain bytes32 0x00726774…). Rebuilding that ELF rotates this; recompute via
    // prover-host/eth_vkey and keep in lockstep.
    const ETH_REFLECTION_VKEY: [u32; 8] =
        [959691297, 1573580327, 461851140, 794766140, 2109164942, 1629874690, 166258058, 1674560259];
    // Genesis sync-committee anchor (beacon weak-subjectivity bootstrap — NOT circular with the pool),
    // pinned at re-prove time to the chosen Sepolia finalized checkpoint. The pool address is NOT pinned
    // here: it's passed through as `ethPoolReflected` and gated on-chain == address(this), which breaks
    // the pool↔vkey circularity with the vkey still immutable in the constructor (D1).
    // Sepolia genesis sync-committee anchor, captured from the stage-i eth compressed proof
    // (prevSyncCommitteeRoot @ finalizedSlot 10462624). Re-anchor for a production deploy.
    const ETH_GENESIS_SYNC_COMMITTEE: [u8; 32] = [
        0x8a, 0x83, 0x30, 0x01, 0x19, 0xac, 0x1e, 0x64, 0xa2, 0x31, 0x8d, 0x3d, 0xb3, 0x30, 0xed, 0x49,
        0x6c, 0x51, 0x27, 0x6c, 0x63, 0x6a, 0x93, 0x63, 0x3b, 0x2d, 0x5c, 0xfd, 0x28, 0x3c, 0x2d, 0x44,
    ];

    // Mode-B gate. `verify_sp1_proof` (the eth-reflection recursion) is needed ONLY to trust a
    // `fold_crossout` below (reverse-bridge ETH→BTC). A forward-only batch (burn-deposit / cmint / CXFER
    // scan) folds no crossout, so it skips the recursion entirely — no deferred-proof obligation, no
    // eth-reflection inner proof required. mode_b == 0 ⇒ SENTINEL eth state: crossout_set_root = 0 makes
    // every 0x65 `fold_crossout` fail set-membership (skip-not-panic), so a forward batch can never mint a
    // crossout without verification; ethPoolReflected = 0 is the "no eth-state attested" sentinel the
    // contract accepts (otherwise it must == address(this)). A reverse-bridge batch sets mode_b = 1 and
    // proves exactly as before. This is what lets the forward bridge re-prove without standing up the
    // eth-reflection guest (it decouples the onboarding re-prove from Mode-B becoming operational).
    let mode_b: u32 = io::read();
    let (eth_pool_word, crossout_set_root): ([u8; 32], [u8; 32]) = if mode_b != 0 {
        let eth_pv: Vec<u8> = io::read();
        assert!(eth_pv.len() >= 288, "eth-reflection public values too short");
        sp1_lib::verify::verify_sp1_proof(&ETH_REFLECTION_VKEY, &bitcoin::sha256_once(&eth_pv));
        // EthReflectionPublicValues is 9 static ABI words; read by offset. Order: priorDigest, newDigest,
        // ethPool, crossOutSetRoot, crossOutCount, finalizedSlot, finalizedExecStateRoot, syncCommitteeRoot,
        // prevSyncCommitteeRoot. The batch chained FROM the genesis committee (gated once here; the
        // prev==last-current chaining across sync-committee periods rides the resume-digest — follow-up).
        assert_eq!(&eth_pv[8 * 32..9 * 32], &ETH_GENESIS_SYNC_COMMITTEE, "eth-reflection: wrong genesis sync-committee");
        let ep: [u8; 32] = eth_pv[2 * 32..3 * 32].try_into().expect("ethPool word"); // gated on-chain == address(this)
        let cr: [u8; 32] = eth_pv[3 * 32..4 * 32].try_into().expect("crossOutSetRoot word");
        (ep, cr)
    } else {
        ([0u8; 32], [0u8; 32]) // sentinel: forward-only batch — no eth recursion, no crossout fold
    };

    // Header chain: non-empty, links (prev_hash) + carries valid PoW, and EXPOSES its anchor
    // (headers[0]'s prev) + tip so the CONTRACT can pin them to the canonical relay — forcing the
    // whole batch to be canonical Bitcoin (F1/F2/F3).
    let anchor_height: u64 = io::read();
    let num_headers: u32 = io::read();
    let headers: Vec<Vec<u8>> = (0..num_headers).map(|_| io::read()).collect();
    assert!(num_headers > 0, "reflection batch needs >=1 header to anchor");
    let refs: Vec<&[u8]> = headers.iter().map(|h| h.as_slice()).collect();
    let tip_hash = bitcoin::verify_header_chain(&refs).expect("invalid Bitcoin header chain");
    let prev_hash: [u8; 32] = headers[0][4..36].try_into().expect("header prev field");

    // FULL SCAN: every tx of every block, in order.
    for block_index in 0..(num_headers as usize) {
        let merkle_root = bitcoin::extract_merkle_root(&headers[block_index]);
        let n_tx: u32 = io::read();
        let txs: Vec<Vec<u8>> = (0..n_tx).map(|_| io::read()).collect();
        // Completeness of the tx set: the provided txs ARE the whole block — their txid merkle
        // root equals the header's. So no tx (hence no pool spend) can be silently omitted.
        let txids: Vec<[u8; 32]> =
            txs.iter().map(|t| bitcoin::compute_txid(t)).collect::<Option<_>>().expect("malformed tx in block");
        assert_eq!(bitcoin::compute_merkle_root(&txids), merkle_root, "provided txs are not the complete block");
        let height = anchor_height + block_index as u64;
        assert!(height >= state.height, "reflection height must not decrease");

        for (ti, tx) in txs.iter().enumerate() {
            let txid = txids[ti];

            // Vin-scan: every input that hits a live pool UTXO is a spend that MUST be folded. The
            // opening (Cx,Cy) for each is read in vin order and bound to the outpoint's stored
            // commitment inside scan_tx_spends (a forged opening is a hard reject).
            let spends = scan_tx_spends(tx, &mut state.live, || (r32(), r32()))
                .expect("vin scan / opening bind");

            // cBTC: a SELF-CUSTODY rug — any input that spends a tracked cBTC.zk lock outpoint drops its
            // sats from the backing total (the lock is gone; the off-pool buffer covers the shortfall). A
            // plain Bitcoin spend (no Tacit ν), independent of the pool-UTXO scan above, and BEFORE the
            // 0x66 mint below so an in-block create-then-spend nets correctly.
            state.fold_cbtc_lock_spends(tx);

            // Classify by envelope: most txs have none (their spends are plain pool-UTXO spends,
            // still nullified). A burn envelope marks a bridge-out; a cxfer envelope declares
            // output notes.
            let env = bitcoin::extract_taproot_envelope(tx);
            let burn = env.as_ref().and_then(|e| bitcoin::parse_burn_envelope(e));
            // CXFER surfaces the kernel sig + range proof too, so the fold can RE-VERIFY value
            // conservation (Σ C_in = Σ C_out) + output range before injecting any note (REFLECT-1).
            let cxfer = env.as_ref().and_then(|e| bitcoin::parse_cxfer_envelope_full(e));

            // Fold the detected spends into the spent-set (witnessed IMT insert, in scan order).
            for s in &spends {
                let (sv, sn, si, sp, snew) = read_spent_insert();
                state.fold_spent(&s.nu, &sv, &sn, si, &sp, &snew).expect("spent-set fold");
            }

            // A bridge-out records ν → destCommitment in the burn set (the burned note is the
            // tx's single detected spend, bound to the envelope's nullifier).
            if let Some((b_asset, env_nu, env_dest)) = &burn {
                if spends.len() == 1 && &spends[0].nu == env_nu {
                    // Reflected-note bridge-out: the burned note is in the live set (this near-tip
                    // reflection saw it created), already nullified above by `fold_spent`. Record ν → dest.
                    let (bk, bn, bv, bi, bp, bnew) = read_burn_insert();
                    state.fold_burn(env_nu, env_dest, &bk, &bn, &bv, bi, &bp, &bnew).expect("burn-set fold");
                } else {
                    // BURN-DEPOSIT (scan-free onboarding): the burned note is a PRE-existing, never-reflected
                    // note (no live-set spend). Admit it ONLY if the witness proves it descends from the
                    // asset's etch supply note C_0 through confirmed, conserving CXFERs. The provenance
                    // blocks are pre-anchor, so their canonicity is a header chain whose tip == this batch's
                    // relay-pinned anchor (prev_hash). See ops/DESIGN-trustless-asset-onboarding.md.
                    assert!(spends.is_empty(), "burn envelope: neither a reflected-note spend nor a burn-deposit");
                    // ── witnesses (read UNCONDITIONALLY so the io stream stays in sync; fold only if valid) ──
                    let etch_tx: Vec<u8> = io::read();
                    let etch_index: u32 = io::read();
                    let n_etch_sib: u32 = io::read();
                    let etch_siblings: Vec<[u8; 32]> = (0..n_etch_sib).map(|_| r32()).collect();
                    let n_prov_headers: u32 = io::read();
                    let prov_headers: Vec<Vec<u8>> = (0..n_prov_headers).map(|_| io::read()).collect();
                    let n_cxfers: u32 = io::read();
                    let mut prov: Vec<burn_deposit::ProvenanceWitness> = Vec::with_capacity(n_cxfers as usize);
                    for _ in 0..n_cxfers {
                        let txid = r32();
                        let n_in: u32 = io::read();
                        let mut input_outpoints = Vec::with_capacity(n_in as usize);
                        let mut input_commitments = Vec::with_capacity(n_in as usize);
                        for _ in 0..n_in {
                            let pt = r32();
                            let pv: u32 = io::read();
                            input_outpoints.push((pt, pv));
                            input_commitments.push(r_n::<33>());
                        }
                        let n_out: u32 = io::read();
                        let mut output_commitments = Vec::with_capacity(n_out as usize);
                        let mut output_vouts = Vec::with_capacity(n_out as usize);
                        for _ in 0..n_out {
                            output_commitments.push(r_n::<33>());
                            let v: u32 = io::read();
                            output_vouts.push(v);
                        }
                        // 0 for a pure CXFER transfer; > 0 for a CBURN step (its change outputs descend
                        // from the inputs minus this public burn). Bound into the kernel message.
                        let burned_amount: u64 = io::read();
                        let range_proof: Vec<u8> = io::read();
                        let kernel_sig = r_n::<64>();
                        let n_sib: u32 = io::read();
                        let merkle_siblings: Vec<[u8; 32]> = (0..n_sib).map(|_| r32()).collect();
                        let merkle_index: u32 = io::read();
                        let confirmed_block_root = r32();
                        prov.push(burn_deposit::ProvenanceWitness {
                            txid, input_outpoints, input_commitments, output_commitments, output_vouts,
                            burned_amount, range_proof, kernel_sig, merkle_siblings, merkle_index, confirmed_block_root,
                        });
                    }
                    // mintable: issuer-authorized cmint witnesses (each: the T_MINT reveal tx + the commit tx
                    // + the reveal's merkle inclusion). Empty (n=0) for a fixed-supply asset.
                    let n_cmints: u32 = io::read();
                    let mut cmints: Vec<(Vec<u8>, Vec<u8>, Vec<[u8; 32]>, u32)> = Vec::with_capacity(n_cmints as usize);
                    for _ in 0..n_cmints {
                        let reveal_tx: Vec<u8> = io::read();
                        let commit_tx: Vec<u8> = io::read();
                        let n_msib: u32 = io::read();
                        let msib: Vec<[u8; 32]> = (0..n_msib).map(|_| r32()).collect();
                        let midx: u32 = io::read();
                        cmints.push((reveal_tx, commit_tx, msib, midx));
                    }
                    let burned_cx = r32();
                    let burned_cy = r32();
                    let (sv, sn, si, sp, snew) = read_spent_insert();
                    let (bk, bn, bv, bi, bp, bnew) = read_burn_insert();
                    // the proven-real burned note is onboarded as a pool member (so the Ethereum mint binds
                    // v_mint == v_burn via pool-membership + kernel); its note-tree append path is witnessed.
                    let note_path = r_path();

                    // ── verify (all required; any miss → skip, fold nothing) ──
                    let verified = (|| -> Option<()> {
                        // (1) the pre-anchor chain is canonical Bitcoin: valid PoW + tip == this batch's anchor.
                        let refs: Vec<&[u8]> = prov_headers.iter().map(|h| h.as_slice()).collect();
                        if refs.is_empty() || bitcoin::verify_header_chain(&refs)? != prev_hash {
                            return None;
                        }
                        // (2) the etch is a valid CETCH in a canonical block, asset-bound (fixed OR mintable;
                        //     the mint_authority gates the cmints below). C_0 is its supply note.
                        let etch_txid = bitcoin::compute_txid(&etch_tx)?;
                        let (c0_compressed, mint_authority, _dec) = bitcoin::verify_etch_anchor(&etch_tx, b_asset)?;
                        let etch_root = bitcoin::verify_merkle_path(&etch_txid, &etch_siblings, etch_index);
                        if !prov_headers.iter().any(|h| bitcoin::extract_merkle_root(h) == etch_root) {
                            return None;
                        }
                        // (3) every provenance CXFER's confirmed block root is one of the canonical chain's roots.
                        if !prov.iter().all(|c| prov_headers.iter().any(|h| bitcoin::extract_merkle_root(h) == c.confirmed_block_root)) {
                            return None;
                        }
                        // (3b) valid supply leaves = C_0 + each issuer-authorized cmint output, the cmint reveal
                        //      confirmed in the canonical chain. A fixed-supply asset has mint_authority = 0, so
                        //      verify_cmint_authorized rejects every cmint → leaves = [C_0] (criterion self-enforces).
                        let c0_outpoint = outpoint_key(&etch_txid, 0);
                        let c0_ch = commitment_hash_compressed(&c0_compressed)?;
                        let mut valid_leaves: Vec<([u8; 32], [u8; 32])> = Vec::with_capacity(1 + cmints.len());
                        valid_leaves.push((c0_outpoint, c0_ch));
                        for (reveal_tx, commit_tx, msib, midx) in &cmints {
                            let reveal_txid = bitcoin::compute_txid(reveal_tx)?;
                            let root = bitcoin::verify_merkle_path(&reveal_txid, msib, *midx);
                            if !prov_headers.iter().any(|h| bitcoin::extract_merkle_root(h) == root) {
                                return None;
                            }
                            valid_leaves.push(burn_deposit::verify_cmint_authorized(b_asset, &mint_authority, reveal_tx, commit_tx)?);
                        }
                        // (4) burned note: outpoint = the burn tx's spent input; env ν is the note's REAL ν.
                        let inputs = bitcoin::extract_inputs(tx)?;
                        let (bt, bvo) = inputs.first()?;
                        let burned_outpoint = outpoint_key(bt, *bvo);
                        if &nullifier(&burned_cx, &burned_cy) != env_nu {
                            return None;
                        }
                        let burned_ch = commitment_hash(&burned_cx, &burned_cy);
                        // (5) the burned note descends from a valid supply leaf (C_0 ∪ authorized cmints).
                        burn_deposit::verify_provenance_leaves(b_asset, &valid_leaves, &burned_outpoint, &burned_ch, &prov).ok()
                    })();
                    if verified.is_some() {
                        // nullify the burned note in the shared set (no double-use) + onboard it as a pool member
                        // + authorize bridge_mint → dest. skip-not-panic (like the cxfer/crossout/cbtc folds): a ν
                        // already in the shared set — a re-presented bridge or an in-pool spend of the same note —
                        // folds nothing rather than wedging the prover (a griefer can't stall reflection with a
                        // double-bridge tx). The note-append + fold_burn can't fail once fold_spent succeeds: a ν
                        // absent from the spent set is absent from the burn set too (every bridge-out adds to both).
                        if state.fold_spent(env_nu, &sv, &sn, si, &sp, &snew).is_ok() {
                            // Append the burned note to the pool tree with the SAME leaf shape a reflected note
                            // uses — leaf(asset, Cx, Cy, 0) — so OP_BRIDGE_MINT proves its membership and the
                            // kernel binds v_mint == v_burn (the burned value is REAL: verify_provenance_leaves
                            // proved it descends from supply). Append-only (never live): the note is spent now,
                            // not in-pool-spendable. This makes a burn-deposit mint identical to a reflected one.
                            let note_leaf = leaf(b_asset, &burned_cx, &burned_cy, &[0u8; 32]);
                            state.fold_note_append(&note_leaf, &note_path).expect("burn-deposit note append");
                            state.fold_burn(env_nu, env_dest, &bk, &bn, &bv, bi, &bp, &bnew).expect("burn-deposit burn fold");
                        }
                    }
                }
            }

            // A cxfer tx's outputs are new pool notes — but ONLY if the tx CONSERVES value. fold_cxfer
            // re-verifies the BIP-340 kernel + the BP+ range over the detected pool-note inputs (Σ C_in,
            // from the scan) and the envelope's outputs BEFORE appending any note, so a confirmed-but-
            // non-conserving tx (Bitcoin never checks the Tacit kernel) cannot inject unbacked, cross-
            // lane-spendable pool value (REFLECT-1). Each output note leaf is DERIVED from the envelope
            // (never a free witness), its outpoint added to the live set for later spends in the batch.
            if let Some((asset, kernel_sig, commitments, range_proof)) = &cxfer {
                let in_outpoints: Vec<([u8; 32], u32)> = spends.iter().map(|s| (s.prev_txid, s.prev_vout)).collect();
                let in_points: Vec<Point> = spends.iter()
                    .map(|s| from_affine_xy(&s.cx, &s.cy).expect("input commitment xy"))
                    .collect();
                let in_assets: Vec<[u8; 32]> = spends.iter().map(|s| s.asset).collect();
                // Asset preservation: every spent note must be of the envelope's declared asset. A
                // value-only conserving CXFER that RELABELS a cheap-asset note as a dear one is junk
                // here, exactly like a non-conserving one — it injects no notes and carries NO output
                // witnesses in the stream, so we read none and skip it (its spends are still nullified
                // above; the relabel just burns the attacker's input). The JS assembler gates on the
                // SAME predicate, so the witness stream stays in sync.
                let asset_preserving = in_assets.iter().all(|a| a == asset);
                // Conservation gate (REFLECT-1): a confirmed-but-non-conserving CXFER injects no notes
                // and carries no output witnesses — read none, skip (a SKIP, not a panic, so a griefed
                // envelope can't wedge the prover). Conserving + asset-preserving cxfers read their
                // witnesses and fold; a fold error there is a real witness bug (panics).
                if asset_preserving && verify_cxfer_conservation(asset, &in_outpoints, &in_points, commitments, range_proof, kernel_sig) {
                    // Derive each output's vout from its index: the i-th envelope commitment is the
                    // tx's i-th confidential output (the convention commitmentForUtxo resolves by). A
                    // witnessed vout let a prover key a note at a bogus outpoint, so its later real
                    // Bitcoin spend would miss the live set (an undetected spend). Only the note-tree
                    // append path stays witnessed.
                    let mut paths: Vec<Vec<[u8; 32]>> = Vec::with_capacity(commitments.len());
                    let mut vouts: Vec<u32> = Vec::with_capacity(commitments.len());
                    for i in 0..commitments.len() {
                        paths.push(r_path());
                        vouts.push(i as u32);
                    }
                    state.fold_cxfer(asset, &in_outpoints, &in_points, &in_assets, &txid, commitments, &paths, &vouts, range_proof, kernel_sig)
                        .expect("cxfer fold");
                }
            }

            // Mode B: an Ethereum→Bitcoin cross-out mint (T_CROSSOUT_MINT, 0x65). Fold the minted note
            // ONLY if it's a member of the eth-reflection crossOutSet (verified at the top of main). A
            // spend-less mint (no pool inputs to nullify). Witnesses are read for EVERY 0x65 tx (the
            // assembler provides a set per 0x65, bogus for non-members) so the stream stays in sync; a
            // non-member folds nothing (skip-not-panic, like a non-conserving cxfer).
            if let Some((co_asset, claim_id, cx, cy, _owner)) =
                env.as_ref().and_then(|e| bitcoin::parse_crossout_mint_envelope(e))
            {
                let set_index: u64 = io::read();
                let set_path = r_path();
                let note_path = r_path();
                // vout 0 = the mint's single confidential output (the dapp's T_CROSSOUT_MINT layout).
                let _ = state.fold_crossout(
                    &co_asset, &claim_id, &cx, &cy, set_index, &set_path, &crossout_set_root, &txid, 0, &note_path,
                );
            }

            // cBTC.zk: a real-BTC sats-lock mint (T_CBTC_LOCK, 0x66). Fold the minted cBTC note ONLY if
            // the envelope tx has, at lock_vout, a confirmed self-custody lock output (the locker's OWN
            // output, any scriptPubKey) of value v_btc AND the note commits to exactly v_btc (opening
            // sigma). Spend-less mint (the lock is the backing); a later spend of the lock is a rug caught
            // by fold_cbtc_lock_spends. Witnesses are read for EVERY 0x66 tx (the assembler MUST emit
            // note_path + the opening sigma per 0x66) so the stream stays in sync; an over-mint /
            // wrong-asset lock folds nothing (skip-not-panic). See
            // ops/DESIGN-cbtc-sats-lock-reflection.md. cf. cxfer-core::ScanReflection::fold_cbtc_lock.
            if let Some((cb_asset, lock_vout, cx, cy)) =
                env.as_ref().and_then(|e| bitcoin::parse_cbtc_lock_envelope(e))
            {
                let note_path = r_path();
                let sig_rx = r32();
                let sig_ry = r32();
                let sig_z = r32();
                let _ = state.fold_cbtc_lock(
                    &cb_asset, &cx, &cy, tx, lock_vout, &txid, &note_path, &sig_rx, &sig_ry, &sig_z,
                );
            }

            // Track A: an orderbook bid fill (T_PREAUTH_BID_VAR, 0x5C) is a CXFER on the tacit-asset side —
            // the seller's asset inputs (the only pool-UTXO spends; the buyer pre-funds in native sats)
            // conserve into the buyer's filled note + the seller's change under tacit-kernel-v1, with one
            // aggregated BP+ range over all outputs. So fold it EXACTLY like a cxfer: re-verify Σ C_in =
            // Σ C_out + range BEFORE onboarding any output note (REFLECT-1 discipline). This onboards the
            // buyer's filled note (the bridgeable one) + the seller's change. Handles BOTH the partial-fill
            // (T_PREAUTH_BID_VAR 0x5C) and the exact-fill (T_PREAUTH_BID 0x5B) walk-away bids — same
            // CXFER-family conservation, only the inline differs. OTC + the other atomic-settlement variants
            // (T_AXFER 0x26 / 0x37 / 0x3C / 0x3D) need NO branch here — parse_cxfer_envelope_full accepts
            // them, so the cxfer fold above handles them.
            if let Some((bid_asset, bid_kernel_sig, bid_commitments, bid_range_proof)) = env.as_ref().and_then(|e| {
                bitcoin::parse_preauth_bid_var_envelope(e).or_else(|| bitcoin::parse_preauth_bid_envelope(e))
            }) {
                let in_outpoints: Vec<([u8; 32], u32)> = spends.iter().map(|s| (s.prev_txid, s.prev_vout)).collect();
                let in_points: Vec<Point> = spends.iter()
                    .map(|s| from_affine_xy(&s.cx, &s.cy).expect("bid input commitment xy"))
                    .collect();
                let in_assets: Vec<[u8; 32]> = spends.iter().map(|s| s.asset).collect();
                let asset_preserving = in_assets.iter().all(|a| a == &bid_asset);
                if asset_preserving
                    && verify_cxfer_conservation(&bid_asset, &in_outpoints, &in_points, &bid_commitments, &bid_range_proof, &bid_kernel_sig)
                {
                    // Note-tree append paths are witnessed; vouts are DERIVED (a witnessed vout could key a
                    // note at a bogus outpoint → its later real spend misses the live set). The bid tx carries
                    // the envelope_hash at vout[0] (OP_RETURN), so its confidential output notes begin at
                    // vout[1]; confirm the exact bid-tx output ordering on the box when wiring the assembler
                    // (a wrong vout is fail-closed — the note onboards unspendable, never over-mints).
                    let mut paths: Vec<Vec<[u8; 32]>> = Vec::with_capacity(bid_commitments.len());
                    let mut vouts: Vec<u32> = Vec::with_capacity(bid_commitments.len());
                    for i in 0..bid_commitments.len() {
                        paths.push(r_path());
                        vouts.push(1 + i as u32);
                    }
                    state.fold_cxfer(&bid_asset, &in_outpoints, &in_points, &in_assets, &txid, &bid_commitments, &paths, &vouts, &bid_range_proof, &bid_kernel_sig)
                        .expect("bid fold");
                }
            }

            // Track B: a T_SWAP_VAR (0x32) onboards the taker's RECEIPT (+ change) as real, bridgeable notes
            // against a c0_backed pool whose tracked reserves match the swap's declared R_pre. fold_swap_var
            // re-verifies the input-side kernel + the receipt opening + the out-reserve floor BEFORE onboarding
            // (skip-not-panic). The pool reserve is registry state (not a live UTXO), so the taker's c_in is
            // the only detected pool-UTXO spend.
            if let Some(sv) = env.as_ref().and_then(|e| bitcoin::parse_swap_var_envelope(e)) {
                let is_sentinel = sv.c_change_or_sentinel.iter().all(|&b| b == 0);
                // Witnesses read UNCONDITIONALLY per 0x32 (stream sync): the receipt's append path (vout 1) +
                // the change's (vout 2), the latter only when non-sentinel — both deterministic from the envelope.
                let receipt_path = r_path();
                let change_path = if !is_sentinel { Some(r_path()) } else { None };
                if spends.len() == 1 {
                    let s = &spends[0];
                    // c_in must be the REAL spent note (so delta_in is backed by the real input value).
                    let c_in_real = matches!(
                        (from_affine_xy(&s.cx, &s.cy), decompress(&sv.c_in)),
                        (Some(x), Some(y)) if x == y
                    );
                    if c_in_real {
                        if let Some(mut pool) = state.pools.get(&sv.pool_id) {
                            let asset_in = if sv.direction == 0 { pool.asset_a } else { pool.asset_b };
                            if state.fold_swap_var(&mut pool, &sv, (s.prev_txid, s.prev_vout), &s.asset, &outpoint_key(&txid, 1), &receipt_path).is_ok() {
                                state.pools.update(&sv.pool_id, pool);
                                // Onboard the taker's change (leftover of c_in, kernel-bound) so it isn't stranded.
                                if let Some(cp) = change_path.as_ref() {
                                    if let (Some(lf), Some(ch)) = (
                                        reflected_note_leaf(&asset_in, &sv.c_change_or_sentinel),
                                        commitment_hash_compressed(&sv.c_change_or_sentinel),
                                    ) {
                                        let _ = state.fold_output(&lf, cp, &outpoint_key(&txid, 2), &ch, &asset_in);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Track B: a T_SWAP_ROUTE (0x33) is the multi-hop sibling of T_SWAP_VAR — the trader's single
            // real input note flows through up to 4 pools and lands as ONE receipt note (public r_receipt, no
            // circuit). fold_swap_route validates the whole value chain + every hop's reserve floor BEFORE
            // onboarding the receipt + advancing reserves (all-or-nothing, skip-not-panic). The trader's c_in is
            // the only detected pool-UTXO spend (pool reserves are registry state).
            if let Some(rt) = env.as_ref().and_then(|e| bitcoin::parse_swap_route_envelope(e)) {
                let receipt_path = r_path(); // witnessed per 0x33 (the receipt note's append path; vout 1)
                if spends.len() == 1 {
                    let s = &spends[0];
                    let c_in_real = matches!(
                        (from_affine_xy(&s.cx, &s.cy), decompress(&rt.c_in)),
                        (Some(x), Some(y)) if x == y
                    );
                    if c_in_real {
                        let _ = state.fold_swap_route(&rt, (s.prev_txid, s.prev_vout), &s.asset, &outpoint_key(&txid, 1), &receipt_path);
                    }
                }
            }

            // Track C: a T_SWAP_BATCH (0x2F) onboards every receipt of a confidential uniform-clearing batch as
            // a real, bridgeable note — gated by the BN254 Groth16 (per-receipt split), the aggregate Pedersen
            // identity (the receipts' total vs the traders' real inputs + the c0-backed reserve), and the
            // per-receipt cross-curve sigma (secp note ↔ Groth16-proven BabyJubJub value). The v1 wire format
            // has no optional block (the arbiter concept is deprecated), so the layout is fixed.
            if let Some(sb) = env.as_ref().and_then(|e| bitcoin::parse_swap_batch_envelope(e)) {
                // Witnessed per 0x2F (stream sync): one append path per receipt (the notes at vouts 1..=n).
                let receipt_paths: Vec<Vec<[u8; 32]>> = (0..sb.n_intents).map(|_| r_path()).collect();
                let _ = swap_batch::fold_swap_batch(&mut state, &sb, &txid, &spends, &receipt_paths);
            }

            // Track B: a T_LP_ADD / POOL_INIT (0x2D) establishes or grows a pool's c0_backed reserves. The
            // LP's per-asset inputs are detected live spends; fold_lp_add verifies both per-asset kernels +
            // (for POOL_INIT) inserts the pool / (for LP-add) grows its reserves + shares. Everything is mapped
            // to CANONICAL asset order — pools + pool_id derivation are canonical (worker convention). NB the
            // per-asset kernel must be the one the dapp signed in canonical order; confirm on the box.
            if let Some(la) = env.as_ref().and_then(|e| bitcoin::parse_lp_add_envelope(e)) {
                // Witnesses per 0x2D (stream sync): the minted LP-share note's blinding + its append path.
                let share_r = r32();
                let share_path = r_path();
                if let Some((ca, cb)) = amm_canonical_pair(&la.asset_a, &la.asset_b) {
                    let swapped = la.asset_a != ca;
                    let (da_c, db_c) = if swapped { (la.delta_b, la.delta_a) } else { (la.delta_a, la.delta_b) };
                    let (ka_c, kb_c) = if swapped { (la.kernel_sig_b, la.kernel_sig_a) } else { (la.kernel_sig_a, la.kernel_sig_b) };
                    let pool_id = if la.variant == 1 {
                        // 6-arg pool_id: a protocol-fee / capability-flagged pool gets a DISTINCT pool_id from
                        // the canonical no-skim slot (matching the worker), so it's findable for swaps + claims.
                        amm_derive_pool_id_full(&ca, &cb, la.fee_bps, la.capability_flags, &la.protocol_fee_address, la.protocol_fee_bps)
                    } else {
                        state.pools.pool_ids_for_assets(&ca, &cb).first().copied()
                    };
                    if let Some(pid) = pool_id {
                        // Group the detected live spends by canonical asset side.
                        let coll = |asset: &[u8; 32]| -> (Vec<([u8; 32], u32)>, Vec<Point>) {
                            let mut ops = Vec::new();
                            let mut pts = Vec::new();
                            for s in spends.iter().filter(|s| &s.asset == asset) {
                                ops.push((s.prev_txid, s.prev_vout));
                                pts.push(from_affine_xy(&s.cx, &s.cy).expect("lp_add input xy"));
                            }
                            (ops, pts)
                        };
                        let (a_ops, a_pts) = coll(&ca);
                        let (b_ops, b_pts) = coll(&cb);
                        let pre_shares = state.pools.get(&pid).map(|p| p.total_shares).unwrap_or(0);
                        // inputs_c0_backed: every contribution is a detected live (real) spend → C0-backed.
                        if state.fold_lp_add(
                            la.variant, &pid, &ca, &cb, da_c, db_c, la.share_amount, &la.share_csecp,
                            &a_ops, &a_pts, &ka_c, &b_ops, &b_pts, &kb_c, true, la.protocol_fee_bps,
                        ).is_ok() {
                            // Onboard the LP's minted share note so LP-remove can later burn it AND it bridges.
                            // The LP's shares = the total_shares delta this op produced (founder's isqrt−ML at
                            // POOL_INIT; minted at LP-add). The share note is at the LP-add tx's share output —
                            // confirm the exact share vout on the box (a wrong vout is fail-closed: LP-remove
                            // can't detect the share, never an over-mint).
                            if let Some(p) = state.pools.get(&pid) {
                                let lp_shares = if la.variant == 1 {
                                    p.total_shares.saturating_sub(cxfer_core::AMM_MINIMUM_LIQUIDITY)
                                } else {
                                    p.total_shares.saturating_sub(pre_shares)
                                };
                                let _ = state.fold_lp_share_mint(&pid, lp_shares, &la.share_csecp, &share_r, &share_path, &outpoint_key(&txid, 1));
                            }
                        }
                    }
                }
            }

            // Track B: a T_LP_REMOVE (0x2E) — the LP burns LP-shares (the detected lp_asset spends) and
            // withdraws the proportional (delta_a, delta_b); fold_lp_remove onboards the withdrawn notes
            // (each bound to its PUBLIC delta_X by a witnessed blinding) + draws down reserves/shares. The
            // envelope carries no fee_bps, so the pool is found by canonical-asset enumeration + disambiguated
            // by which candidate's pool_id makes the share-burn kernel verify.
            if let Some(lr) = env.as_ref().and_then(|e| bitcoin::parse_lp_remove_envelope(e)) {
                // Witnesses read UNCONDITIONALLY per 0x2E (stream sync): the two recv blindings + append paths.
                let r_recv_a = r32();
                let r_recv_b = r32();
                let recv_a_path = r_path();
                let recv_b_path = r_path();
                if let Some((ca, cb)) = amm_canonical_pair(&lr.asset_a, &lr.asset_b) {
                    let swapped = lr.asset_a != ca;
                    let (da_c, db_c) = if swapped { (lr.delta_b, lr.delta_a) } else { (lr.delta_a, lr.delta_b) };
                    let (recv_ca, recv_cb) = if swapped { (lr.recv_b_secp, lr.recv_a_secp) } else { (lr.recv_a_secp, lr.recv_b_secp) };
                    let (rca, rcb) = if swapped { (r_recv_b, r_recv_a) } else { (r_recv_a, r_recv_b) };
                    let mut lp_ops = Vec::new();
                    let mut lp_pts = Vec::new();
                    for s in &spends {
                        lp_ops.push((s.prev_txid, s.prev_vout));
                        lp_pts.push(from_affine_xy(&s.cx, &s.cy).expect("lp_remove input xy"));
                    }
                    // Find the pool whose pool_id makes the share-burn kernel verify (one V1 candidate per pair).
                    for pid in state.pools.pool_ids_for_assets(&ca, &cb) {
                        if cxfer_core::lp_remove_kernel_verify(&pid, lr.share_amount, da_c, db_c, &recv_ca, &recv_cb, &lp_ops, &lp_pts, &lr.kernel_sig) {
                            let _ = state.fold_lp_remove(
                                &pid, lr.share_amount, da_c, db_c, &recv_ca, &rca, &recv_cb, &rcb,
                                &lp_ops, &lp_pts, &lr.kernel_sig, &recv_a_path, &outpoint_key(&txid, 1), &recv_b_path, &outpoint_key(&txid, 2),
                            );
                            break;
                        }
                    }
                }
            }

            // Track B: a T_FARM_INIT (0x34) establishes a farm treasury as a C0-backed reserve. The launcher's
            // reward-asset input (the single detected spend) funds reward_total into the (virtual) treasury
            // under the swap-shape kernel; fold_farm_init registers it keyed by farm_id. A later T_LP_HARVEST
            // draws reward notes from it.
            if let Some(fi) = env.as_ref().and_then(|e| bitcoin::parse_farm_init_envelope(e)) {
                if spends.len() == 1 {
                    let s = &spends[0];
                    if s.asset == fi.reward_asset {
                        if let Some(c_in_pt) = from_affine_xy(&s.cx, &s.cy) {
                            let c_in = compress(&c_in_pt);
                            let farm_id = amm_derive_farm_id(&fi.pool_id, &fi.launcher_pubkey, &fi.reward_asset, &fi.farm_nonce);
                            // inputs_c0_backed: the launcher's funding input is a detected live (real) spend.
                            let _ = state.fold_farm_init(
                                &farm_id, &fi.reward_asset, fi.reward_total, (s.prev_txid, s.prev_vout),
                                &c_in, &fi.c_change_or_sentinel, &fi.kernel_sig, true,
                            );
                        }
                    }
                }
            }

            // Track B: a T_LP_HARVEST (0x3B) onboards a farmer's reward note (minted by decree at vout[1]) as
            // real + bridgeable. fold_harvest derives the reward note from the PUBLIC (reward_amount, reward_r),
            // checks it ≤ the C0-backed treasury, onboards it, and debits the treasury. (The accrual fairness
            // is the worker's; the bridge only needs reward ≤ treasury ⇒ no inflation.)
            if let Some((farm_id, reward_amount, reward_r)) = env.as_ref().and_then(|e| bitcoin::parse_lp_harvest_envelope(e)) {
                let reward_path = r_path(); // witnessed per 0x3B (the reward note's append path; vout[1])
                let _ = state.fold_harvest(&farm_id, reward_amount, &reward_r, &outpoint_key(&txid, 1), &reward_path);
            }

            // Track B: a T_FARM_REFUND (0x3E) — the launcher reclaims unspent treasury post-grace. Same shape as
            // a harvest (a public-r note drawn from the treasury reserve), so fold_harvest onboards it + debits
            // the treasury — NO new fold (the generalized "draw a reserve + onboard a public-r note" pattern).
            if let Some((farm_id, refund_amount, refund_r)) = env.as_ref().and_then(|e| bitcoin::parse_farm_refund_envelope(e)) {
                let refund_path = r_path(); // witnessed per 0x3E (the refund note's append path; vout[1])
                let _ = state.fold_harvest(&farm_id, refund_amount, &refund_r, &outpoint_key(&txid, 1), &refund_path);
            }

            // Track B: a T_PROTOCOL_FEE_CLAIM (0x31) — the pool's fee recipient claims the CREATOR-earned
            // protocol-fee LP-share skim as a real, bridgeable note. fold_protocol_fee_claim crystallizes the
            // swap-driven accrual, requires claim == accrued (exact), and onboards the claim note (vout[1]).
            if let Some((cl_pool_id, cl_amount, cl_c_secp, cl_blinding)) = env.as_ref().and_then(|e| bitcoin::parse_protocol_fee_claim_envelope(e)) {
                let claim_path = r_path(); // witnessed per 0x31 (the claim note's append path; vout[1])
                let _ = state.fold_protocol_fee_claim(&cl_pool_id, cl_amount, &cl_c_secp, &cl_blinding, &outpoint_key(&txid, 1), &claim_path);
            }
        }
        state.height = height;
    }

    let pv = BitcoinReflectionPublicValues {
        priorDigest: prior_digest.into(),
        bitcoinPoolRoot: state.pool_root.into(),
        bitcoinSpentRoot: state.spent_root.into(),
        bitcoinBurnRoot: state.burn_root.into(),
        bitcoinHeight: state.height,
        newDigest: state.digest().into(),
        bitcoinPrevHash: prev_hash.into(),
        bitcoinTipHash: tip_hash.into(),
        ethPoolReflected: eth_pool_word.into(),
        cbtcBackingSats: U256::from(state.cbtc_backing_sats), // reflection-attested cBTC backing
    };
    io::commit_slice(&BitcoinReflectionPublicValues::abi_encode(&pv));
}
