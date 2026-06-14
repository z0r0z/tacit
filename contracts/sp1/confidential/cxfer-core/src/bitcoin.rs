// Bitcoin block/tx primitives for confidential bridge_mint (BTC → ETH). Pure
// functions, no SP1 deps, native-testable. Ported faithfully from the live tETH
// bridge guest (contracts/sp1/program/src/bitcoin.rs) so the confidential guest
// can verify a Bitcoin burn is confirmed (header PoW + chain, tx-in-block via the
// merkle root, txid, and the Tacit Taproot envelope) WITHOUT importing or
// refactoring the live prover's crate. Kept byte-identical to that battle-tested
// code; if the tETH version changes, re-sync.

use sha2::{Digest, Sha256};

pub fn be_bytes_lte(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in 0..32 {
        if a[i] < b[i] { return true; }
        if a[i] > b[i] { return false; }
    }
    true // equal
}

pub fn double_sha256(data: &[u8]) -> [u8; 32] {
    let first = Sha256::digest(data);
    let second = Sha256::digest(&first);
    second.into()
}

// Total (never panics): returns None on a malformed/truncated tx instead of slice/varint panics, so
// an attacker-supplied tx is a clean reject. Every well-formed tx hashes byte-identically to before
// (the guards only short-circuit out-of-bounds reads; the stripped serialization is unchanged).
pub fn compute_txid(tx_data: &[u8]) -> Option<[u8; 32]> {
    // BIP-141 anti-merkle-collision (audit BTC-1): a 64-byte non-witness tx could be mistaken for a
    // merkle internal node; consensus rejects it, so do we (clean reject, not a hashable txid).
    if tx_data.len() == 64 && !(tx_data.len() > 5 && tx_data[4] == 0x00 && tx_data[5] == 0x01) {
        return None;
    }
    let is_segwit = tx_data.len() > 5 && tx_data[4] == 0x00 && tx_data[5] == 0x01;
    if !is_segwit {
        return Some(double_sha256(tx_data));
    }
    let version = &tx_data[0..4]; // is_segwit ⇒ len > 5
    let mut pos = 6; // skip version(4) + marker(1) + flag(1)
    let (input_count, vi_len) = read_varint(tx_data, pos)?;
    let inputs_start = pos;
    pos += vi_len;
    for _ in 0..input_count {
        pos += 36;
        let (script_len, vi_len) = read_varint(tx_data, pos)?;
        pos += vi_len + script_len + 4;
    }
    let (output_count, vi_len) = read_varint(tx_data, pos)?;
    pos += vi_len;
    for _ in 0..output_count {
        pos += 8;
        let (script_len, vi_len) = read_varint(tx_data, pos)?;
        pos += vi_len + script_len;
    }
    let outputs_end = pos;
    for _ in 0..input_count {
        let (wit_count, vi_len) = read_varint(tx_data, pos)?;
        pos += vi_len;
        for _ in 0..wit_count {
            let (item_len, vi_len) = read_varint(tx_data, pos)?;
            pos += vi_len + item_len;
        }
    }
    if outputs_end > tx_data.len() || pos + 4 > tx_data.len() { return None; }
    let locktime = &tx_data[pos..pos + 4];

    let mut stripped = Vec::with_capacity(version.len() + (outputs_end - inputs_start) + 4);
    stripped.extend_from_slice(version);
    stripped.extend_from_slice(&tx_data[inputs_start..outputs_end]);
    stripped.extend_from_slice(locktime);
    Some(double_sha256(&stripped))
}

pub fn extract_merkle_root(header: &[u8]) -> [u8; 32] {
    header[36..68].try_into().unwrap()
}

// Total (never panics): a malformed difficulty field (negative / zero-mantissa / out-of-range
// exponent) or a short header is a clean None rather than a panic, so an attacker-supplied header
// is rejected, not a guest panic. A well-formed nBits decodes to the identical target as before.
pub fn bits_to_target(header: &[u8]) -> Option<[u8; 32]> {
    // Decode nBits → 256-bit target; reject negative/zero-mantissa/out-of-range
    // exponent. Per-network MAX_TARGET clamp is the relay's job (the guest's
    // committed last_block_hash must equal the relay tip), not this generic decoder.
    if header.len() < 76 { return None; }
    let bits = u32::from_le_bytes([header[72], header[73], header[74], header[75]]);
    let exp = (bits >> 24) as usize;
    let mantissa = bits & 0x7fffff;

    if bits & 0x00800000 != 0 { return None; } // negative target
    if mantissa == 0 { return None; }          // zero mantissa
    if exp > 32 { return None; }               // exponent out of range

    let mut target = [0u8; 32];
    if exp <= 3 {
        let val = mantissa >> (8 * (3 - exp));
        let bytes = val.to_be_bytes();
        target[28..32].copy_from_slice(&bytes);
    } else {
        let shift_bytes = exp - 3;
        let bytes = mantissa.to_be_bytes();
        if shift_bytes + 4 <= 32 {
            let start = 32 - shift_bytes - 4;
            target[start..start + 4].copy_from_slice(&bytes);
        }
    }
    Some(target)
}

pub fn reverse_u256(v: &[u8; 32]) -> [u8; 32] {
    let mut r = [0u8; 32];
    for i in 0..32 { r[i] = v[31 - i]; }
    r
}

pub fn compute_merkle_root(txids: &[[u8; 32]]) -> [u8; 32] {
    if txids.is_empty() { return [0u8; 32]; }
    if txids.len() == 1 { return txids[0]; }
    let mut layer = txids.to_vec();
    while layer.len() > 1 {
        let mut next = Vec::new();
        let mut i = 0;
        while i < layer.len() {
            let left = layer[i];
            let right = if i + 1 < layer.len() { layer[i + 1] } else { layer[i] };
            let mut combined = Vec::with_capacity(64);
            combined.extend_from_slice(&left);
            combined.extend_from_slice(&right);
            next.push(double_sha256(&combined));
            i += 2;
        }
        layer = next;
    }
    layer[0]
}

/// Verify a Bitcoin merkle inclusion PATH: fold `txid` (internal order) with its `siblings` bottom-up,
/// choosing left/right by each level's index bit, returning the resulting merkle root. Byte-identical to
/// `compute_merkle_root` (double-SHA256 of `left ‖ right`, internal order). The caller asserts the returned
/// root == a block's merkle root whose header chains to the relay anchor (`verify_header_chain`) — that is a
/// CONFIRMED-tx proof WITHOUT a full block scan, which the per-bridge provenance needs (a tx is real iff it
/// sits in a PoW-buried block). `index` is the tx's 0-based position in the block; odd-node duplication is
/// implicit in the witnessed siblings (a last odd node's sibling is itself).
pub fn verify_merkle_path(txid: &[u8; 32], siblings: &[[u8; 32]], mut index: u32) -> [u8; 32] {
    let mut acc = *txid;
    for sib in siblings {
        let mut combined = Vec::with_capacity(64);
        if index & 1 == 0 {
            combined.extend_from_slice(&acc);
            combined.extend_from_slice(sib);
        } else {
            combined.extend_from_slice(sib);
            combined.extend_from_slice(&acc);
        }
        acc = double_sha256(&combined);
        index >>= 1;
    }
    acc
}

/// Single SHA-256 (the Tacit asset-id / domain hash — distinct from the double-SHA txid). Also the
/// SP1 public-values commit hash the reflection guest feeds `verify_sp1_proof` (Mode B recursion).
pub fn sha256_once(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// Tacit `asset_id` for a CETCH / T_PETCH reveal tx: `SHA256(reveal_txid ‖ vout_LE)` with
/// vout = 0. `compute_txid` returns the internal-order txid, which is exactly what the
/// dapp (`deriveAssetIdFromReveal`) and worker (`assetIdFor`) feed after reversing the
/// display txid — so this is byte-identical to both.
pub fn asset_id_from_etch(tx_data: &[u8]) -> Option<[u8; 32]> {
    let txid = compute_txid(tx_data)?;
    let mut pre = [0u8; 36]; // txid(32) ‖ vout_LE(4) = 0
    pre[..32].copy_from_slice(&txid);
    Some(sha256_once(&pre))
}

/// Parse the `(ticker, decimals, cid)` an etch reveal envelope declares ON-CHAIN. `env` is the
/// payload from `extract_taproot_envelope` (`env[0]` = opcode). Per SPEC §5.1/§5.8:
/// `opcode(1) ‖ ticker_len(1, 1..16) ‖ ticker ‖ decimals(1, 0..8) ‖ [cid(32)] ‖ …`. CETCH=0x21,
/// T_PETCH=0x27. The optional 32-byte `cid` (immediately after decimals) is the asset's IPFS
/// metadata content hash (the CIDv1 raw sha256 digest → a logo/description JSON); absent ⇒
/// [0;32] (no metadata). The reveal txid binds it exactly like ticker+decimals, so a bridged
/// asset's contractURI is trustless. Returns `(ticker[..len], len, decimals, cid)`; None if not a
/// well-formed etch.
pub fn parse_etch_meta(env: &[u8]) -> Option<([u8; 16], u8, u8, [u8; 32])> {
    if env.len() < 3 || (env[0] != 0x21 && env[0] != 0x27) {
        return None;
    }
    let tlen = env[1] as usize;
    if tlen < 1 || tlen > 16 || env.len() < 3 + tlen {
        return None;
    }
    let decimals = env[2 + tlen];
    if decimals > 8 {
        return None;
    }
    let mut ticker = [0u8; 16];
    ticker[..tlen].copy_from_slice(&env[2..2 + tlen]);
    let mut cid = [0u8; 32];
    let cid_off = 3 + tlen;
    // ONLY T_PETCH (0x27) carries a 32-byte content cid immediately after decimals. CETCH (0x21) carries
    // the supply commitment(33) there (its metadata is `image_uri`, not a content cid) — so for a CETCH,
    // leave cid = 0 and NEVER misread the commitment as a cid. (Fixes the cross-impl discrepancy where the
    // worker's canonical CETCH layout `…decimals‖commitment(33)‖…‖mint_authority(32)‖img_len‖image_uri`
    // disagreed with a cid-after-decimals read — OP_ATTEST_META would otherwise register a garbage cid for
    // a CETCH-etched asset like TAC. Capturing the CETCH image_uri as a contractURI is a follow-up.)
    if env[0] == 0x27 && env.len() >= cid_off + 32 {
        cid.copy_from_slice(&env[cid_off..cid_off + 32]);
    }
    Some((ticker, tlen as u8, decimals, cid))
}

/// Parse a CETCH (0x21) confidential-etch reveal → (supply_commitment `C_0`[33], `mint_authority`[32],
/// decimals). Byte-canonical with the live worker `decodeCEtchPayload`:
///   `0x21 ‖ tlen(1,1..16) ‖ ticker(tlen) ‖ decimals(1,0..8) ‖ commitment(33) ‖ amount_ct(8) ‖`
///   `rp_len(2 LE) ‖ rangeproof(rp_len) ‖ mint_authority(32) ‖ img_len(2 LE) ‖ image_uri`.
/// `commitment` is the FIXED initial-supply Pedersen commitment (`C_0`) — the trustless supply anchor for
/// the burn-and-mint onboarding (read once from the etch block; no full-history scan). NOTE: distinct from
/// `parse_etch_meta`, whose cid-after-decimals shape is the T_PETCH(0x27) form; CETCH carries the supply
/// commitment there, not a cid. None if malformed.
pub fn parse_cetch(env: &[u8]) -> Option<([u8; 33], [u8; 32], u8)> {
    if env.is_empty() || env[0] != 0x21 {
        return None;
    }
    let mut p = 1usize;
    let tlen = *env.get(p)? as usize;
    p += 1;
    if tlen < 1 || tlen > 16 {
        return None;
    }
    p += tlen; // ticker
    let decimals = *env.get(p)?;
    p += 1;
    if decimals > 8 {
        return None;
    }
    let commitment: [u8; 33] = env.get(p..p + 33)?.try_into().ok()?;
    p += 33;
    p += 8; // amount_ct
    let rp_len = (*env.get(p)? as usize) | ((*env.get(p + 1)? as usize) << 8);
    p += 2;
    p = p.checked_add(rp_len)?; // skip rangeproof
    let mint_authority: [u8; 32] = env.get(p..p + 32)?.try_into().ok()?;
    Some((commitment, mint_authority, decimals))
}

/// `MINT_AUTH_NONE` (all-zero) ⇒ a FIXED-SUPPLY asset (no issuer minting). The criterion — not an
/// allowlist — gating the burn-and-mint onboarding path: a fixed-supply asset is eligible (its burn must
/// then prove realness against the etch-anchored supply `C_0`); a non-zero authority is a mintable asset
/// (the `cmint`-deposit path instead). cBTC.zk's real-BTC peg is its own concept (`fold_cbtc_lock`).
pub fn is_fixed_supply(mint_authority: &[u8; 32]) -> bool {
    mint_authority.iter().all(|&b| b == 0)
}

/// Bind an `asset_id` to its CETCH reveal tx and extract the supply anchor → `(C_0[33],
/// mint_authority[32], decimals)`. Succeeds iff `asset_id == asset_id_from_etch(etch_tx)` (so a different
/// etch can't be substituted) and the tx carries a well-formed CETCH. The CALLER must separately confirm
/// `etch_tx` is a real, CONFIRMED Bitcoin tx (full-scan its block, or a header+merkle inclusion proof to
/// the relay anchor) — without confirmation, `asset_id` is attacker-chosen via a fabricated etch (they'd be
/// their own authority over a made-up id, never a real one whose `asset_id` is pinned to the real etch's
/// txid). This is the trustless supply anchor for the burn-and-mint onboarding: `C_0` is read ONCE from the
/// etch, no full-history scan.
pub fn verify_etch_anchor(etch_tx: &[u8], asset_id: &[u8; 32]) -> Option<([u8; 33], [u8; 32], u8)> {
    if &asset_id_from_etch(etch_tx)? != asset_id {
        return None;
    }
    let env = extract_taproot_envelope(etch_tx)?;
    parse_cetch(&env)
}

/// Parse a T_MINT (0x24) issuer-authorized mint reveal envelope → `(assetId[32], etchTxid[32],
/// commitment[33], range_proof, issuer_sig[64])`. Byte-canonical with the worker `decodeCMintPayload`:
///   `0x24 ‖ assetId(32) ‖ etchTxid(32) ‖ commitment(33) ‖ amount_ct(8) ‖ rp_len(2 LE) ‖ rangeproof ‖ issuer_sig(64)`.
/// `commitment` is the newly-minted note (additional supply); the issuer signature (verified against the
/// etch's `mint_authority`) authorizes it. None if malformed.
pub fn parse_cmint(env: &[u8]) -> Option<([u8; 32], [u8; 32], [u8; 33], &[u8], [u8; 64])> {
    if env.is_empty() || env[0] != 0x24 {
        return None;
    }
    let asset_id: [u8; 32] = env.get(1..33)?.try_into().ok()?;
    let etch_txid: [u8; 32] = env.get(33..65)?.try_into().ok()?;
    let commitment: [u8; 33] = env.get(65..98)?.try_into().ok()?;
    // env[98..106] = amount_ct (skip)
    let rp_len = (*env.get(106)? as usize) | ((*env.get(107)? as usize) << 8);
    let rp_start = 108usize;
    let rp_end = rp_start.checked_add(rp_len)?;
    let range_proof = env.get(rp_start..rp_end)?;
    let issuer_sig: [u8; 64] = env.get(rp_end..rp_end + 64)?.try_into().ok()?;
    Some((asset_id, etch_txid, commitment, range_proof, issuer_sig))
}

/// Parse a confidential bridge-burn envelope (opcode 0x2B) → (assetId, nullifier,
/// destCommitment). `env` is the payload from `extract_taproot_envelope` (env[0] = opcode).
/// Layout: opcode(1) ‖ assetId(32) ‖ bitcoinPoolRoot(32) ‖ nullifier(32) ‖ destCommitment(32).
/// The reflection prover binds a reflected bridge-out's destCommitment (and ν) to this, so a
/// burn's Ethereum mint cannot be redirected to a different destination. None if malformed.
pub fn parse_burn_envelope(env: &[u8]) -> Option<([u8; 32], [u8; 32], [u8; 32])> {
    if env.len() < 129 || env[0] != 0x2B {
        return None;
    }
    let asset: [u8; 32] = env[1..33].try_into().ok()?;
    let nullifier: [u8; 32] = env[65..97].try_into().ok()?;
    let dest: [u8; 32] = env[97..129].try_into().ok()?;
    Some((asset, nullifier, dest))
}

/// Parse a T_CROSSOUT_MINT envelope (opcode 0x65) → (assetId, claimId, Cx, Cy, owner). Layout:
/// opcode(1) ‖ assetId(32) ‖ claimId(32) ‖ Cx(32) ‖ Cy(32) ‖ owner(32) = 161 bytes (the dapp's
/// `encodeCrossoutMint`). The Ethereum→Bitcoin cross-out: a note burned for Bitcoin on the
/// ConfidentialPool, re-minted here as a Bitcoin pool note. The reflection prover folds it ONLY if
/// the cross-out is a member of the eth-reflection crossOutSet (Mode B), so a fabricated mint enters
/// no value. `owner` is carried for completeness; a Bitcoin-destined cross-out's reflected leaf uses
/// the zero owner sentinel (see `ScanReflection::fold_crossout`). None if malformed.
pub fn parse_crossout_mint_envelope(env: &[u8]) -> Option<([u8; 32], [u8; 32], [u8; 32], [u8; 32], [u8; 32])> {
    if env.len() < 161 || env[0] != 0x65 {
        return None;
    }
    let asset: [u8; 32] = env[1..33].try_into().ok()?;
    let claim_id: [u8; 32] = env[33..65].try_into().ok()?;
    let cx: [u8; 32] = env[65..97].try_into().ok()?;
    let cy: [u8; 32] = env[97..129].try_into().ok()?;
    let owner: [u8; 32] = env[129..161].try_into().ok()?;
    Some((asset, claim_id, cx, cy, owner))
}

/// Read output `vout` of a (segwit or legacy) Bitcoin tx → `(value_sats, scriptPubKey)`. Mirrors
/// `compute_txid`'s walk; fully bounds-checked. `None` on a malformed tx or an out-of-range vout.
/// Used by the cBTC.zk sats-lock value-entry to read the locked output's value + vault script.
pub fn parse_tx_output(tx_data: &[u8], vout: u32) -> Option<(u64, Vec<u8>)> {
    if tx_data.len() < 4 {
        return None;
    }
    let is_segwit = tx_data.len() > 5 && tx_data[4] == 0x00 && tx_data[5] == 0x01;
    let mut pos = if is_segwit { 6 } else { 4 };
    let (input_count, vi_len) = read_varint(tx_data, pos)?;
    pos = pos.checked_add(vi_len)?;
    for _ in 0..input_count {
        pos = pos.checked_add(36)?; // prev outpoint (txid 32 + vout 4)
        let (script_len, vi_len) = read_varint(tx_data, pos)?;
        pos = pos.checked_add(vi_len)?.checked_add(script_len)?.checked_add(4)?; // scriptSig + sequence
    }
    let (output_count, vi_len) = read_varint(tx_data, pos)?;
    pos = pos.checked_add(vi_len)?;
    if (vout as usize) >= output_count {
        return None;
    }
    for i in 0..output_count {
        let val_end = pos.checked_add(8)?;
        if val_end > tx_data.len() {
            return None;
        }
        let value = u64::from_le_bytes(tx_data[pos..val_end].try_into().ok()?);
        pos = val_end;
        let (script_len, vi_len) = read_varint(tx_data, pos)?;
        pos = pos.checked_add(vi_len)?;
        let script_end = pos.checked_add(script_len)?;
        if script_end > tx_data.len() {
            return None;
        }
        if i == vout as usize {
            return Some((value, tx_data[pos..script_end].to_vec()));
        }
        pos = script_end;
    }
    None
}

/// cBTC.zk sats-lock envelope (`T_CBTC_LOCK`, opcode 0x66): `asset(32) ‖ lock_vout(4 LE) ‖ Cx(32) ‖
/// Cy(32)` — the asset, which output of THIS tx is the sats-lock, and the minted cBTC note commitment.
/// The opening sigma (proving the note opens to the lock's value) rides the witness, not the envelope.
pub fn parse_cbtc_lock_envelope(env: &[u8]) -> Option<([u8; 32], u32, [u8; 32], [u8; 32])> {
    if env.len() < 101 || env[0] != 0x66 {
        return None;
    }
    let asset: [u8; 32] = env[1..33].try_into().ok()?;
    let lock_vout = u32::from_le_bytes(env[33..37].try_into().ok()?);
    let cx: [u8; 32] = env[37..69].try_into().ok()?;
    let cy: [u8; 32] = env[69..101].try_into().ok()?;
    Some((asset, lock_vout, cx, cy))
}

/// Parse a confidential-transfer envelope → (assetId, the N output commitments as compressed
/// secp256k1 points). Accepts T_CXFER (0x23) AND its BP+ variant T_CXFER_BPP (0x22) — identical
/// wire shape (SPEC §5.47); real confidential transfers use 0x22. Layout: opcode(1) ‖
/// assetId(32) ‖ kernel_sig(64) ‖ N(1, ∈ {1,2,4,8}) ‖ N×(commitment(33) ‖ amount_ct(8)) ‖
/// rpLen(2 LE) ‖ rangeProof. The reflection prover binds each reflected output's stored
/// commitment to one of these, so a note the confirmed tx never declared can't enter the pool.
pub fn parse_cxfer_envelope(env: &[u8]) -> Option<([u8; 32], Vec<[u8; 33]>)> {
    parse_cxfer_envelope_full(env).map(|(asset, _sig, commitments, _rp)| (asset, commitments))
}

/// Like `parse_cxfer_envelope`, but also surfaces the kernel SIGNATURE and the BP+ RANGE PROOF the
/// envelope carries. The reflection prover needs both to re-verify a confirmed CXFER tx's value
/// conservation (`cxfer_kernel_verify`: Σ C_in = Σ C_out) and output range (`verify_range`) BEFORE
/// folding its outputs into `bitcoinPoolRoot`: Bitcoin consensus never checks the Tacit kernel (the
/// envelope is just witness bytes), so a confirmed tx can declare an inflated output commitment, and
/// the leaf-SHAPE binding (`reflected_note_leaf`) cannot catch it — an inflated commitment is still a
/// valid curve point. Returns `(asset, kernel_sig, output_commitments, range_proof)`; None if not a
/// well-formed CXFER envelope.
pub fn parse_cxfer_envelope_full(env: &[u8]) -> Option<([u8; 32], [u8; 64], Vec<[u8; 33]>, Vec<u8>)> {
    if env.len() < 1 + 32 + 64 + 1 || (env[0] != 0x23 && env[0] != 0x22) {
        return None;
    }
    let asset: [u8; 32] = env[1..33].try_into().ok()?;
    let kernel_sig: [u8; 64] = env[33..97].try_into().ok()?;
    let mut p = 1 + 32 + 64;
    let n = env[p] as usize;
    p += 1;
    if ![1usize, 2, 4, 8].contains(&n) || p + n * (33 + 8) + 2 > env.len() {
        return None;
    }
    let mut commitments = Vec::with_capacity(n);
    for _ in 0..n {
        commitments.push(env[p..p + 33].try_into().ok()?);
        p += 33 + 8; // commitment + amount_ct
    }
    let rp_len = (env[p] as usize) | ((env[p + 1] as usize) << 8);
    p += 2;
    if p + rp_len != env.len() {
        return None;
    }
    let range_proof = env[p..p + rp_len].to_vec();
    Some((asset, kernel_sig, commitments, range_proof))
}

/// Extract the Tacit Taproot envelope payload from vin[0].witness[1].
/// Matches the format PUSH(32) xonly OP_CHECKSIG OP_FALSE OP_IF [pushes] OP_ENDIF,
/// strips the "TACIT"||v1 frame, returns the payload starting at the opcode byte.
/// Verify a transaction is included in a Bitcoin block that has valid proof-of-work:
/// the 80-byte header's PoW holds (double-SHA256 ≤ target), the block's merkle root is
/// rebuilt from the full `txids` set (so the tx set is complete + header-committed), and
/// `tx_data`'s txid sits at `tx_index`. Returns the txid on success, None otherwise.
///
/// This is the per-event confirmation the bridge_mint guest does inline; the reflection
/// prover reuses it for each deposit/spend before folding it into the pool/spent roots.
/// Chain-linkage to the relay anchor (canonical chain) + confirmation depth are the
/// caller's relay-anchor layer — this proves "in a PoW-valid block", not "buried in the
/// canonical chain".
pub fn verify_tx_in_block(header: &[u8], tx_data: &[u8], tx_index: u32, txids: &[[u8; 32]]) -> Option<[u8; 32]> {
    if header.len() != 80 {
        return None;
    }
    let block_hash = double_sha256(header);
    let target = bits_to_target(header)?;
    if !be_bytes_lte(&reverse_u256(&block_hash), &target) {
        return None; // PoW
    }
    if compute_merkle_root(txids) != extract_merkle_root(header) {
        return None; // complete, header-committed tx set
    }
    let txid = compute_txid(tx_data)?;
    let i = tx_index as usize;
    if i >= txids.len() || txids[i] != txid {
        return None; // tx present at the claimed index
    }
    Some(txid)
}

/// Verify a chain of consecutive 80-byte headers: each header links to its predecessor
/// (its prev-block-hash field == the predecessor's double-SHA256) and has valid PoW.
/// Returns the chain tip's block hash (internal byte order) on success. The reflection
/// prover links an event's block forward to the relay-anchored tip and counts the
/// confirmations (chain length past the event), so a reflected spend is buried ≥ K.
/// (The anchor's identity — that `headers[0]` is the relay tip — is checked by the
/// caller against the on-chain BitcoinLightRelay.)
pub fn verify_header_chain(headers: &[&[u8]]) -> Option<[u8; 32]> {
    if headers.is_empty() {
        return None;
    }
    let mut prev_hash: Option<[u8; 32]> = None;
    for h in headers {
        if h.len() != 80 {
            return None;
        }
        let bh = double_sha256(h);
        let target = bits_to_target(h)?;
        if !be_bytes_lte(&reverse_u256(&bh), &target) {
            return None; // PoW on every header
        }
        if let Some(ph) = prev_hash {
            let prev_field: [u8; 32] = h[4..36].try_into().ok()?;
            if prev_field != ph {
                return None; // linkage: this header extends the previous one
            }
        }
        prev_hash = Some(bh);
    }
    prev_hash
}

/// Parse a segwit transaction's inputs — each spent outpoint `(prev_txid, prev_vout)`.
/// The reflection prover reads these as the pool notes a confidential transfer consumes
/// (the UTXO model: a tx's vin are the prior pool outputs it spends). Returns None on a
/// malformed / non-segwit tx.
pub fn extract_inputs(tx_data: &[u8]) -> Option<Vec<([u8; 32], u32)>> {
    if tx_data.len() < 5 {
        return None;
    }
    // After the 4-byte version: a segwit tx carries the marker(0x00)+flag(0x01) before the input
    // count; a legacy tx carries the input-count varint directly (its first byte can't be 0x00 —
    // that would be zero inputs). Both serialize the inputs (outpoint + scriptSig + sequence)
    // identically; the witness (segwit-only) trails the outputs and is irrelevant to the vin
    // outpoints. Pool UTXOs are P2TR, so a CONFIRMED legacy tx can never spend one — but it must
    // still be WALKED, not rejected: returning None here makes the reflection scan
    // (`scan_tx_spends`) abort on the first legacy tx in a block (a cheap liveness DoS).
    let mut pos = 4;
    if tx_data[4] == 0x00 && tx_data.len() >= 6 && tx_data[5] == 0x01 {
        pos = 6; // skip the segwit marker + flag
    }
    let (input_count, vi_len) = read_varint(tx_data, pos)?;
    if input_count == 0 {
        return None;
    }
    pos += vi_len;
    let mut inputs = Vec::with_capacity(input_count);
    for _ in 0..input_count {
        if pos + 36 > tx_data.len() {
            return None;
        }
        let mut txid = [0u8; 32];
        txid.copy_from_slice(&tx_data[pos..pos + 32]);
        let vout = u32::from_le_bytes([tx_data[pos + 32], tx_data[pos + 33], tx_data[pos + 34], tx_data[pos + 35]]);
        inputs.push((txid, vout));
        pos += 36;
        let (script_len, vi_len2) = read_varint(tx_data, pos)?;
        pos += vi_len2 + script_len + 4; // input script + sequence(4)
    }
    Some(inputs)
}

pub fn extract_taproot_envelope(tx_data: &[u8]) -> Option<Vec<u8>> {
    if tx_data.len() < 6 || tx_data[4] != 0x00 || tx_data[5] != 0x01 { return None; }
    let mut pos = 6;
    let (input_count, vi_len) = read_varint(tx_data, pos)?;
    if input_count == 0 { return None; }
    pos += vi_len;
    for _ in 0..input_count {
        pos += 36;
        let (script_len, vi_len) = read_varint(tx_data, pos)?;
        pos += vi_len + script_len + 4;
    }
    let (output_count, vi_len) = read_varint(tx_data, pos)?;
    pos += vi_len;
    for _ in 0..output_count {
        pos += 8;
        let (script_len, vi_len) = read_varint(tx_data, pos)?;
        pos += vi_len + script_len;
    }
    let (wit_count, vi_len) = read_varint(tx_data, pos)?;
    pos += vi_len;
    if wit_count < 2 { return None; }
    let (item0_len, vi_len) = read_varint(tx_data, pos)?;
    pos += vi_len + item0_len;
    let (script_len, vi_len) = read_varint(tx_data, pos)?;
    pos += vi_len;
    if pos + script_len > tx_data.len() { return None; }
    let script = &tx_data[pos..pos + script_len];
    if script.len() < 36 { return None; }
    let mut sp = 0;
    if script[sp] != 32 { return None; } sp += 1; // PUSH(32)
    sp += 32; // skip xonly pubkey
    if sp >= script.len() || script[sp] != 0xac { return None; } sp += 1; // OP_CHECKSIG
    if sp + 1 >= script.len() || script[sp] != 0x00 || script[sp + 1] != 0x63 { return None; } sp += 2; // OP_FALSE OP_IF
    let mut payload = Vec::new();
    while sp < script.len() {
        if script[sp] == 0x68 { break; } // OP_ENDIF
        let op = script[sp]; sp += 1;
        if op >= 1 && op <= 75 {
            if sp + (op as usize) > script.len() { return None; }
            payload.extend_from_slice(&script[sp..sp + op as usize]);
            sp += op as usize;
        } else if op == 0x4c { // OP_PUSHDATA1
            if sp >= script.len() { return None; }
            let ln = script[sp] as usize; sp += 1;
            if sp + ln > script.len() { return None; }
            payload.extend_from_slice(&script[sp..sp + ln]);
            sp += ln;
        } else if op == 0x4d { // OP_PUSHDATA2
            if sp + 1 >= script.len() { return None; }
            let ln = u16::from_le_bytes([script[sp], script[sp + 1]]) as usize; sp += 2;
            if sp + ln > script.len() { return None; }
            payload.extend_from_slice(&script[sp..sp + ln]);
            sp += ln;
        } else {
            return None;
        }
    }
    const FRAME: [u8; 6] = [0x54, 0x41, 0x43, 0x49, 0x54, 0x01]; // "TACIT" || v1
    if payload.len() <= FRAME.len() || payload[..FRAME.len()] != FRAME { return None; }
    Some(payload[FRAME.len()..].to_vec())
}

// Total (never panics): returns None on a truncated varint instead of asserting, so a malformed
// (attacker-supplied) tx is a clean reject rather than a guest panic. Bounds are byte-for-byte the
// old asserts, so every well-formed varint parses to the identical (value, len).
fn read_varint(data: &[u8], pos: usize) -> Option<(usize, usize)> {
    if pos >= data.len() { return None; }
    let first = data[pos];
    if first < 0xfd {
        Some((first as usize, 1))
    } else if first == 0xfd {
        if pos + 2 >= data.len() { return None; }
        Some((u16::from_le_bytes([data[pos + 1], data[pos + 2]]) as usize, 3))
    } else if first == 0xfe {
        if pos + 4 >= data.len() { return None; }
        Some((u32::from_le_bytes([data[pos + 1], data[pos + 2], data[pos + 3], data[pos + 4]]) as usize, 5))
    } else {
        if pos + 8 >= data.len() { return None; }
        let val = u64::from_le_bytes([
            data[pos + 1], data[pos + 2], data[pos + 3], data[pos + 4],
            data[pos + 5], data[pos + 6], data[pos + 7], data[pos + 8],
        ]);
        Some((val as usize, 9))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merkle_path_verifies_inclusion() {
        let t: Vec<[u8; 32]> = (0u8..4).map(|i| [i; 32]).collect();
        let root = compute_merkle_root(&t);
        let h = |a: &[u8; 32], b: &[u8; 32]| {
            let mut c = Vec::with_capacity(64);
            c.extend_from_slice(a);
            c.extend_from_slice(b);
            double_sha256(&c)
        };
        let h23 = h(&t[2], &t[3]);
        // each leaf's path reproduces the root
        assert_eq!(verify_merkle_path(&t[0], &[t[1], h23], 0), root, "index-0 path → root");
        assert_eq!(verify_merkle_path(&t[1], &[t[0], h23], 1), root, "index-1 path → root");
        // a wrong sibling does NOT reproduce the root (forged inclusion rejected)
        assert_ne!(verify_merkle_path(&t[1], &[t[2], h23], 1), root, "wrong sibling rejected");
        // single-tx block: empty path → the txid itself
        assert_eq!(verify_merkle_path(&t[0], &[], 0), t[0], "single-tx path = txid");
    }

    #[test]
    fn parse_cetch_extracts_supply_commitment_and_authority() {
        // synthetic CETCH per the CANONICAL (worker decodeCEtchPayload) layout:
        // 0x21 ‖ tlen ‖ ticker ‖ decimals ‖ commitment(33) ‖ amount_ct(8) ‖ rp_len(2 LE) ‖
        // rangeproof(rp_len) ‖ mint_authority(32) ‖ img_len(2 LE) ‖ image_uri
        let mut env = vec![0x21u8, 0x03, b'T', b'A', b'C', 0x08]; // opcode, tlen=3, "TAC", decimals=8
        let c0 = [0xc0u8; 33];
        env.extend_from_slice(&c0); // supply commitment C_0
        env.extend_from_slice(&[0u8; 8]); // amount_ct
        env.extend_from_slice(&[0x03, 0x00]); // rp_len = 3 (LE)
        env.extend_from_slice(&[0xaa, 0xbb, 0xcc]); // rangeproof (3 bytes)
        env.extend_from_slice(&[0u8; 32]); // mint_authority = NONE (fixed-supply)
        env.extend_from_slice(&[0x00, 0x00]); // img_len = 0
        let auth_off = 6 + 33 + 8 + 2 + 3; // opcode..decimals(6) + C_0(33) + amount_ct(8) + rp_len(2) + rp(3)

        let (commitment, mint_authority, decimals) = parse_cetch(&env).expect("cetch");
        assert_eq!(commitment, c0, "supply commitment C_0");
        assert_eq!(decimals, 8, "decimals");
        assert!(is_fixed_supply(&mint_authority), "all-zero authority ⇒ fixed-supply (TAC)");

        // a non-zero mint_authority ⇒ mintable (the cmint-deposit path, not the burn path)
        let mut env_mint = env.clone();
        env_mint[auth_off] = 0x07;
        let (_, ma, _) = parse_cetch(&env_mint).expect("cetch mintable");
        assert!(!is_fixed_supply(&ma), "non-zero authority ⇒ mintable");

        // gating: wrong opcode (T_PETCH) rejected; truncation within mint_authority rejected
        assert!(parse_cetch(&[0x27u8, 0x02, b'H', b'I', 0x00]).is_none(), "T_PETCH opcode rejected");
        assert!(parse_cetch(&env[..auth_off + 10]).is_none(), "truncated within mint_authority → None");
    }

    #[test]
    fn verify_etch_anchor_binds_asset_and_extracts_c0() {
        let mut payload = vec![0x21u8, 0x03, b'T', b'A', b'C', 0x08];
        let c0 = [0xc0u8; 33];
        payload.extend_from_slice(&c0); // C_0
        payload.extend_from_slice(&[0u8; 8]); // amount_ct
        payload.extend_from_slice(&[0x00, 0x00]); // rp_len = 0
        payload.extend_from_slice(&[0u8; 32]); // mint_authority NONE
        payload.extend_from_slice(&[0x00, 0x00]); // img_len = 0
        let tx = build_reveal_tx(&payload);
        let asset_id = asset_id_from_etch(&tx).unwrap();

        let (commitment, ma, decimals) = verify_etch_anchor(&tx, &asset_id).expect("anchor");
        assert_eq!(commitment, c0, "C_0 anchored from the etch");
        assert_eq!(decimals, 8);
        assert!(is_fixed_supply(&ma), "fixed-supply TAC");

        // a different asset_id cannot bind to this etch (no etch substitution)
        assert!(verify_etch_anchor(&tx, &[0x99u8; 32]).is_none(), "wrong asset_id rejected");
    }

    #[test]
    fn parse_cmint_extracts_fields() {
        // T_MINT: 0x24 ‖ assetId(32) ‖ etchTxid(32) ‖ commitment(33) ‖ amount_ct(8) ‖ rp_len(2) ‖ rp ‖ sig(64)
        let mut env = vec![0x24u8];
        env.extend_from_slice(&[0xAA; 32]); // assetId
        env.extend_from_slice(&[0xEE; 32]); // etchTxid
        let comm = [0xC1u8; 33];
        env.extend_from_slice(&comm); // commitment
        env.extend_from_slice(&[0u8; 8]); // amount_ct
        env.extend_from_slice(&[0x02, 0x00]); // rp_len = 2 (LE)
        env.extend_from_slice(&[0xab, 0xcd]); // rangeproof
        let sig = [0x77u8; 64];
        env.extend_from_slice(&sig); // issuer_sig

        let (asset, etch, commitment, rp, isig) = parse_cmint(&env).expect("cmint");
        assert_eq!(asset, [0xAA; 32]);
        assert_eq!(etch, [0xEE; 32]);
        assert_eq!(commitment, comm);
        assert_eq!(rp, &[0xab, 0xcd]);
        assert_eq!(isig, sig);
        assert!(parse_cmint(&[0x21u8, 0, 0]).is_none(), "wrong opcode rejected");
        assert!(parse_cmint(&env[..env.len() - 1]).is_none(), "truncated sig rejected");
    }

    fn build_reveal_tx(payload: &[u8]) -> Vec<u8> {
        let mut script = Vec::new();
        script.push(0x20); script.extend_from_slice(&[0u8; 32]);
        script.push(0xac);
        script.push(0x00); script.push(0x63);
        script.push(0x05); script.extend_from_slice(b"TACIT");
        script.push(0x01); script.push(0x01);
        script.push(0x4d);
        script.push((payload.len() & 0xff) as u8);
        script.push((payload.len() >> 8) as u8);
        script.extend_from_slice(payload);
        script.push(0x68);

        let mut tx = Vec::new();
        tx.extend_from_slice(&[0x02, 0x00, 0x00, 0x00]);
        tx.extend_from_slice(&[0x00, 0x01]);
        tx.push(0x01);
        tx.extend_from_slice(&[0u8; 32]);
        tx.extend_from_slice(&[0u8; 4]);
        tx.push(0x00);
        tx.extend_from_slice(&[0xfd, 0xff, 0xff, 0xff]);
        tx.push(0x01);
        tx.extend_from_slice(&[0u8; 8]);
        tx.push(0x00);
        tx.push(0x03);
        tx.push(0x40); tx.extend_from_slice(&[0u8; 0x40]);
        let sl = script.len();
        if sl < 0xfd { tx.push(sl as u8); }
        else { tx.push(0xfd); tx.extend_from_slice(&(sl as u16).to_le_bytes()); }
        tx.extend_from_slice(&script);
        tx.push(0x21); tx.extend_from_slice(&[0xc0; 0x21]);
        tx.extend_from_slice(&[0u8; 4]);
        tx
    }

    #[test]
    fn extracts_confidential_burn_envelope() {
        // 0x2B = confidential bridge-burn envelope (BTC→ETH), opcode at index 0.
        let mut payload = vec![0x2B_u8];
        payload.extend_from_slice(&[0x11u8; 32]); // assetId
        payload.extend_from_slice(&[0x22u8; 32]); // bitcoin pool root
        payload.extend_from_slice(&[0x33u8; 32]); // nullifier
        payload.extend_from_slice(&[0x44u8; 32]); // dest commitment (ETH leaf)
        let tx = build_reveal_tx(&payload);
        let got = extract_taproot_envelope(&tx).expect("Some for valid reveal");
        assert_eq!(got[0], 0x2B, "opcode preserved at index 0");
        assert_eq!(got.len(), payload.len(), "payload round-trips");
        assert_eq!(&got[65..97], &[0x33u8; 32], "nullifier intact");

        // the reflection prover parses (assetId, ν, destCommitment) out of it
        let (asset, nu, dest) = parse_burn_envelope(&got).expect("burn parse");
        assert_eq!(asset, [0x11u8; 32], "assetId");
        assert_eq!(nu, [0x33u8; 32], "nullifier");
        assert_eq!(dest, [0x44u8; 32], "destCommitment");
        // wrong opcode / short payload reject
        assert!(parse_burn_envelope(&[0x23u8; 129]).is_none(), "non-burn opcode rejected");
        assert!(parse_burn_envelope(&got[..128]).is_none(), "truncated payload rejected");
    }

    #[test]
    fn extract_inputs_handles_legacy_and_segwit() {
        // Segwit tx (build_reveal_tx): marker+flag present, one input with the zero outpoint.
        let segwit = build_reveal_tx(&[0xAAu8; 8]);
        assert_eq!(extract_inputs(&segwit).expect("segwit inputs"), vec![([0u8; 32], 0u32)], "segwit vin");

        // Legacy tx (no marker/flag): version, 1 input (txid 0xAB.., vout 7, empty scriptSig), sequence.
        // A pure-legacy tx must PARSE (return its vins), not return None — else the reflection
        // full-scan aborts on the first legacy tx in a block (F-LIVENESS DoS). It carries no pool
        // spend (pool UTXOs are P2TR), so the scan simply finds no live-set hit.
        let mut legacy = vec![0x02, 0x00, 0x00, 0x00, 0x01]; // version + 1 input
        legacy.extend_from_slice(&[0xABu8; 32]);             // prev txid
        legacy.extend_from_slice(&[0x07, 0x00, 0x00, 0x00]); // vout = 7 (LE)
        legacy.push(0x00);                                   // empty scriptSig
        legacy.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // sequence
        assert_eq!(extract_inputs(&legacy).expect("legacy tx must parse, not abort the scan"),
            vec![([0xABu8; 32], 7u32)], "legacy vin");
        assert!(extract_inputs(&legacy[..5]).is_none(), "truncated rejected");
    }

    #[test]
    fn parses_cxfer_envelope_outputs() {
        // opcode ‖ assetId(32) ‖ kernel_sig(64) ‖ N ‖ N×(commitment33 ‖ amount8) ‖ rpLen ‖ rp
        let mut env = vec![0x23u8];
        env.extend_from_slice(&[0xAAu8; 32]);
        env.extend_from_slice(&[0xBBu8; 64]);
        env.push(2); // N = 2
        let c0 = [0x02u8; 33];
        let c1 = [0x03u8; 33];
        env.extend_from_slice(&c0); env.extend_from_slice(&[0u8; 8]);
        env.extend_from_slice(&c1); env.extend_from_slice(&[0u8; 8]);
        let rp = [0x77u8; 5];
        env.extend_from_slice(&(rp.len() as u16).to_le_bytes());
        env.extend_from_slice(&rp);

        let (asset, comms) = parse_cxfer_envelope(&env).expect("cxfer parse");
        assert_eq!(asset, [0xAAu8; 32], "assetId");
        assert_eq!(comms, vec![c0, c1], "the two output commitments");
        // wrong opcode / invalid N / wrong length reject
        let mut bad = env.clone(); bad[0] = 0x2B;
        assert!(parse_cxfer_envelope(&bad).is_none(), "non-cxfer opcode");
        let mut badn = env.clone(); badn[97] = 3;
        assert!(parse_cxfer_envelope(&badn).is_none(), "invalid output count");
    }

    // The reflection prover's confirmation + envelope binding on a REAL signet confidential
    // transfer (T_CXFER_BPP 0x22, block 307547): the tx confirms in its block (PoW + merkle +
    // tx-at-index), its vins are the spent pool outpoints, and its envelope parses to the output
    // commitments. esplora returns txids in display order, so they reverse to internal.
    #[test]
    fn real_signet_cxfer_confirms_and_parses() {
        let f: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/signet_cxfer.json")).unwrap();
        let hx = |s: &str| hex::decode(s.trim_start_matches("0x")).unwrap();
        let header = hx(f["header"].as_str().unwrap());
        let tx = hx(f["tx"].as_str().unwrap());
        let tx_index = f["txIndex"].as_u64().unwrap() as u32;
        let txids: Vec<[u8; 32]> = f["txids"].as_array().unwrap().iter()
            .map(|v| { let mut b = hx(v.as_str().unwrap()); b.reverse(); b.try_into().unwrap() }).collect();

        // 1. confirmed in its block — REAL PoW + merkle proof
        let txid = verify_tx_in_block(&header, &tx, tx_index, &txids).expect("real CXFER confirms in block 307547");
        assert_eq!(txid, compute_txid(&tx).unwrap(), "returns the confirmed txid");

        // 2. its vins are the spent pool outpoints (this transfer spends 2 notes)
        let vins = extract_inputs(&tx).expect("vins");
        assert_eq!(vins.len(), 2, "2 spent pool notes");

        // 3. the envelope parses as a confidential transfer, asset = the indexed aid
        let env = extract_taproot_envelope(&tx).expect("envelope");
        assert_eq!(env[0], 0x22, "T_CXFER_BPP opcode");
        let (asset, commitments) = parse_cxfer_envelope(&env).expect("cxfer envelope parses");
        assert_eq!(hex::encode(asset), "879cf8e6f26b733497ca1d154ed22c80b2266a5702ed55476a8cd4a3c5e9c4ea", "assetId == the recent-cxfers aid");
        assert!(!commitments.is_empty() && [1usize, 2, 4, 8].contains(&commitments.len()), "valid output count");
    }

    #[test]
    fn etch_meta_and_asset_id() {
        // synthetic T_PETCH (0x27): ticker "TAC", decimals 8, then a 32-byte content cid + filler.
        // (T_PETCH carries the cid right after decimals; CETCH 0x21 carries the supply commitment there —
        // covered by parse_cetch's test + the CETCH-cid=0 regression assert below.)
        let mut payload = vec![0x27u8, 0x03, b'T', b'A', b'C', 0x08];
        let want_cid = [0x42u8; 32];
        payload.extend_from_slice(&want_cid);
        payload.extend_from_slice(&[0u8; 1]);
        let tx = build_reveal_tx(&payload);
        let env = extract_taproot_envelope(&tx).expect("etch envelope");
        let (ticker, tlen, decimals, cid) = parse_etch_meta(&env).expect("etch meta");
        assert_eq!(&ticker[..tlen as usize], b"TAC", "ticker");
        assert_eq!(decimals, 8, "decimals");
        assert_eq!(cid, want_cid, "metadata cid");

        // asset_id = sha256(compute_txid ‖ vout0), bound to the tx.
        let id = asset_id_from_etch(&tx).unwrap();
        assert_ne!(id, [0u8; 32], "non-zero asset_id");
        let txid = compute_txid(&tx).unwrap();
        let mut pre = [0u8; 36];
        pre[..32].copy_from_slice(&txid);
        let recomputed: [u8; 32] = Sha256::digest(&pre).into();
        assert_eq!(id, recomputed, "asset_id = sha256(txid ‖ vout0)");

        // opcode gating: T_PETCH parses; the burn opcode does not.
        let mut petch = vec![0x27u8, 0x02, b'H', b'I', 0x00];
        petch.extend_from_slice(&[0u8; 5]);
        assert!(parse_etch_meta(&petch).is_some(), "T_PETCH parses");
        assert!(parse_etch_meta(&[0x2Bu8, 3, 1, 2, 3]).is_none(), "burn opcode rejected");

        // CETCH (0x21) carries the supply commitment after decimals, NOT a cid — parse_etch_meta must
        // return cid = 0 there, never the commitment bytes (the OP_ATTEST_META garbage-cid fix).
        let mut cetch = vec![0x21u8, 0x03, b'T', b'A', b'C', 0x08];
        cetch.extend_from_slice(&[0x99u8; 33]); // supply commitment (must NOT be read as a cid)
        let cenv = extract_taproot_envelope(&build_reveal_tx(&cetch)).expect("cetch envelope");
        let (_, _, _, ccid) = parse_etch_meta(&cenv).expect("CETCH parses via parse_etch_meta");
        assert_eq!(ccid, [0u8; 32], "CETCH cid = 0 (commitment never misread as cid)");
    }

    #[test]
    fn txid_and_merkle_root_single_tx() {
        // For a one-tx block, the merkle root equals that tx's txid.
        let tx = build_reveal_tx(&[0x2B, 0x00, 0x01, 0x02]);
        let txid = compute_txid(&tx).unwrap();
        assert_eq!(compute_merkle_root(&[txid]), txid, "single-tx merkle root = txid");
        // Two identical txids fold deterministically (Bitcoin duplicates the odd leaf).
        let r = compute_merkle_root(&[txid, txid]);
        assert_ne!(r, txid, "paired root differs from leaf");
    }

    // BIP-141 anti-merkle-collision guard (BTC-1): compute_txid MUST reject a 64-byte
    // non-witness tx — its double-SHA256 preimage is exactly 64 bytes, the size of a
    // merkle internal node H(left)‖H(right), so without this a forged 64-byte tx could be
    // passed off as an interior node and let the reflection scan accept a tx set that is
    // not the real block (F4 completeness break). A 64-byte SEGWIT tx is fine (its txid is
    // over the witness-stripped form, which is < 64 bytes) and must still parse.
    #[test]
    fn compute_txid_rejects_64byte_nonwitness() {
        let legacy64 = vec![0x01u8; 64]; // tx_data[4]/[5] != marker/flag → non-segwit
        assert!(compute_txid(&legacy64).is_none(), "64-byte non-witness tx is rejected (anti-merkle-collision)");

        // a 64-byte buffer that *looks* segwit (marker+flag at [4],[5]) is permitted —
        // its txid preimage is the stripped form, not 64 bytes, so no node-collision.
        let mut fake_segwit64 = vec![0x02u8, 0, 0, 0, 0x00, 0x01];
        fake_segwit64.extend_from_slice(&[0u8; 58]);
        assert_eq!(fake_segwit64.len(), 64);
        assert!(compute_txid(&fake_segwit64).is_some(), "64-byte segwit-shaped tx is not the collision case");
    }

    // Hardening (total parsers): malformed / truncated tx bytes are a clean reject (None), never a
    // guest panic. A well-formed tx still parses to the identical txid (covered by the real-signet
    // tests above) — these pin that the failure path is graceful.
    #[test]
    fn malformed_tx_parsers_reject_cleanly_no_panic() {
        // truncated segwit txs at every prefix length: never panic, always None (or a valid parse).
        let real = build_reveal_tx(&[0x22, 0x00, 0x01, 0x02, 0x03]);
        for n in 0..real.len() {
            let _ = compute_txid(&real[..n]);          // must not panic
            let _ = extract_taproot_envelope(&real[..n]);
            let _ = extract_inputs(&real[..n]);
            let _ = asset_id_from_etch(&real[..n]);
        }
        // a varint claiming a huge script_len past the buffer → None, not a slice panic.
        let mut runaway = vec![0x02u8, 0, 0, 0, 0x00, 0x01, 0x01]; // ver, marker/flag, 1 input
        runaway.extend_from_slice(&[0u8; 36]);                      // outpoint
        runaway.push(0xfe);                                         // scriptSig len = u32 varint…
        runaway.extend_from_slice(&0xffff_ffffu32.to_le_bytes());   // …4GB, well past the buffer
        assert!(compute_txid(&runaway).is_none(), "runaway script length is a clean reject");
        assert!(extract_taproot_envelope(&runaway).is_none(), "runaway script length is a clean reject");
        let _ = extract_inputs(&runaway); // returns the (valid) outpoint; the runaway script is skipped — must not panic
    }

    // CVE-2012-2459 (odd-leaf duplication) does not let a relayer OMIT a tx from a
    // relay-anchored block. The merkle root is pinned to the header; the only way to
    // produce the same root with a *different* tx set is to ADD a duplicated trailing
    // branch (a larger set), never to DROP a leaf. So a tx set that omits the last tx of
    // the real block can never re-hash to the real root — the reflection scan's
    // completeness assert (reflect.rs) rejects it. This pins that omission is detected.
    #[test]
    fn merkle_omission_changes_root() {
        let leaf = |b: u8| compute_txid(&build_reveal_tx(&[0x2B, b])).unwrap();
        let t0 = leaf(0x00);
        let t1 = leaf(0x01);
        let t2 = leaf(0x02); // the "spend" tx — last, on an odd-length layer
        let real = compute_merkle_root(&[t0, t1, t2]);
        // dropping t2 (omission) yields a different root → caught by the header-pinned check
        assert_ne!(compute_merkle_root(&[t0, t1]), real, "omitting the spend tx changes the root");
        // the CVE-2012-2459 duplication (t2 self-paired) is the SAME real root — it adds no
        // new leaf the scan could mistake for an omission; the duplicate is the canonical
        // odd-leaf fold, not a second pre-image that drops a tx.
        assert_eq!(compute_merkle_root(&[t0, t1, t2, t2]), real,
            "explicit odd-leaf duplication equals the canonical root (forward malleability only)");
    }

    // Mine an 80-byte header at easy regtest difficulty (nBits 0x1f7fffff → target
    // 0x007fffff00…0) linking to `prev`, grinding the nonce until PoW holds.
    fn mine_header(prev: [u8; 32], merkle_seed: u8) -> [u8; 80] {
        let mut h = [0u8; 80];
        h[0..4].copy_from_slice(&1u32.to_le_bytes()); // version
        h[4..36].copy_from_slice(&prev); // prev block hash
        h[36] = merkle_seed; // a distinguishing "merkle root"
        h[68..72].copy_from_slice(&1_700_000_000u32.to_le_bytes()); // time
        h[72..76].copy_from_slice(&0x1f7fffffu32.to_le_bytes()); // easy bits
        let target = bits_to_target(&h).unwrap();
        for nonce in 0u32..2_000_000 {
            h[76..80].copy_from_slice(&nonce.to_le_bytes());
            if be_bytes_lte(&reverse_u256(&double_sha256(&h)), &target) {
                return h;
            }
        }
        panic!("no PoW nonce found");
    }

    #[test]
    fn header_chain_links_and_rejects_breaks() {
        let h0 = mine_header([0u8; 32], 1);
        let bh0 = double_sha256(&h0);
        let h1 = mine_header(bh0, 2); // extends h0
        let bh1 = double_sha256(&h1);
        let h2 = mine_header(bh1, 3); // extends h1
        let bh2 = double_sha256(&h2);

        // a valid 3-header chain returns the tip hash
        assert_eq!(verify_header_chain(&[&h0, &h1, &h2]), Some(bh2), "linked chain → tip");
        // a single header is a 1-length chain (its own hash)
        assert_eq!(verify_header_chain(&[&h0]), Some(bh0), "single header");

        // a broken link is rejected: h2 does not extend h0
        assert!(verify_header_chain(&[&h0, &h2]).is_none(), "non-consecutive link rejected");
        // an out-of-order chain is rejected
        assert!(verify_header_chain(&[&h1, &h0]).is_none(), "reversed order rejected");
        // a header that fails PoW is rejected (zero the nonce/merkle so the hash is large)
        let mut bad = h1;
        bad[72..76].copy_from_slice(&0x03000001u32.to_le_bytes()); // tiny target → PoW fails
        assert!(verify_header_chain(&[&bad]).is_none(), "PoW failure rejected");
    }

    #[test]
    fn bits_to_target_decodes() {
        // nBits 0x1d00ffff (Bitcoin genesis difficulty) → the canonical target.
        let mut header = [0u8; 80];
        header[72..76].copy_from_slice(&0x1d00ffffu32.to_le_bytes());
        let t = bits_to_target(&header).unwrap();
        assert!(t != [0u8; 32], "target nonzero");
        // target = 0x00000000ffff0000...0 — the well-known genesis target.
        assert_eq!(&t[0..6], &[0x00, 0x00, 0x00, 0x00, 0xff, 0xff], "genesis target prefix");
        // A max hash exceeds the target → fails PoW (be_bytes_lte false).
        assert!(!be_bytes_lte(&[0xffu8; 32], &t), "max hash exceeds target");
        // A hash of all-zero is below target → passes PoW sense.
        assert!(be_bytes_lte(&[0u8; 32], &t), "zero hash below target");
    }
}
