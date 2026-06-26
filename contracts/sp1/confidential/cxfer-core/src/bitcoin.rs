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
    // checked_add throughout: an attacker-supplied varint length can't wrap `pos` (which would skip a
    // bounds check / make outputs_end < inputs_start → an OOB slice panic). A wrap is a clean None.
    let mut pos = 6usize; // skip version(4) + marker(1) + flag(1)
    let (input_count, vi_len) = read_varint(tx_data, pos)?;
    let inputs_start = pos;
    pos = pos.checked_add(vi_len)?;
    for _ in 0..input_count {
        pos = pos.checked_add(36)?;
        let (script_len, vi_len) = read_varint(tx_data, pos)?;
        pos = pos.checked_add(vi_len)?.checked_add(script_len)?.checked_add(4)?;
    }
    let (output_count, vi_len) = read_varint(tx_data, pos)?;
    pos = pos.checked_add(vi_len)?;
    for _ in 0..output_count {
        pos = pos.checked_add(8)?;
        let (script_len, vi_len) = read_varint(tx_data, pos)?;
        pos = pos.checked_add(vi_len)?.checked_add(script_len)?;
    }
    let outputs_end = pos;
    for _ in 0..input_count {
        let (wit_count, vi_len) = read_varint(tx_data, pos)?;
        pos = pos.checked_add(vi_len)?;
        for _ in 0..wit_count {
            let (item_len, vi_len) = read_varint(tx_data, pos)?;
            pos = pos.checked_add(vi_len)?.checked_add(item_len)?;
        }
    }
    if outputs_end > tx_data.len() || pos.checked_add(4)? > tx_data.len() { return None; }
    let locktime = &tx_data[pos..pos + 4];

    let mut stripped = Vec::with_capacity(version.len() + (outputs_end - inputs_start) + 4);
    stripped.extend_from_slice(version);
    stripped.extend_from_slice(&tx_data[inputs_start..outputs_end]);
    stripped.extend_from_slice(locktime);
    // BTC-1 (audit X-03): consensus applies the 64-byte anti-merkle-collision rejection to the STRIPPED
    // serialization — the bytes the txid is hashed over — so a segwit tx whose stripped form is 64 bytes is
    // rejected here too (the full-length guard above only catches the non-witness case).
    if stripped.len() == 64 {
        return None;
    }
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

/// Like `compute_merkle_root` but rejects a duplicate-tail MUTATION (CVE-2012-2459 class): a supplied
/// `[A,B,C,C]` folds to the SAME root as the real odd-leaf `[A,B,C]`, so without this check a prover could
/// pass a tx set that matches the header root yet is not the exact block. A genuine odd node self-pairs ONLY
/// as the LAST node of its layer (`i + 1 == layer.len()`); an adjacent-equal pair anywhere else is a forged
/// extra leaf (two distinct real txids/wtxids can't collide). Returns `None` on such a tree. Use this
/// wherever the root is consumed as a COMPLETE-block / exact-tx-set proof.
pub fn compute_merkle_root_checked(txids: &[[u8; 32]]) -> Option<[u8; 32]> {
    if txids.is_empty() { return Some([0u8; 32]); }
    if txids.len() == 1 { return Some(txids[0]); }
    let mut layer = txids.to_vec();
    while layer.len() > 1 {
        let mut next = Vec::new();
        let mut i = 0;
        while i < layer.len() {
            let left = layer[i];
            let right = if i + 1 < layer.len() {
                if layer[i] == layer[i + 1] { return None; } // duplicate-tail mutation, not the odd-node fold
                layer[i + 1]
            } else {
                layer[i]
            };
            let mut combined = Vec::with_capacity(64);
            combined.extend_from_slice(&left);
            combined.extend_from_slice(&right);
            next.push(double_sha256(&combined));
            i += 2;
        }
        layer = next;
    }
    Some(layer[0])
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
/// Header layout (shared prefix): `opcode(1) ‖ ticker_len(1, 1..16) ‖ ticker ‖ decimals(1, 0..8) ‖ …`.
/// CETCH=0x21, T_PETCH=0x27. The 32-byte `cid` is NOT inline: it is resolved from the `image_uri` at the
/// END of the reveal envelope (see `cetch_image_cid` / `petch_image_cid`) when that URI is an `ipfs://`
/// raw-CIDv1 — the asset's IPFS metadata content hash (CIDv1 raw sha256 digest → a logo/description JSON);
/// absent / non-raw ⇒ [0;32] (no metadata). The reveal txid binds it exactly like ticker+decimals, so a
/// bridged asset's contractURI is trustless. Returns `(ticker[..len], len, decimals, cid)`; None only if
/// the header is not a well-formed etch (the cid is best-effort and never causes a None).
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
    // Neither etch type carries the cid inline: both reference their metadata blob (`{name, image, …}`
    // JSON) by an `image_uri` at the END of the reveal envelope — CETCH after its supply commitment +
    // mint authority, T_PETCH after its cap/limit/height fair-mint window. Resolve that URI to the same
    // 32-byte raw-CIDv1 digest the Ethereum `contractURI` reconstructs (`ipfs://f01551220‖hex`), so EVERY
    // bridged Tacit asset — a CETCH (e.g. TAC) or a T_PETCH fair-mint — gets an identical, trustless
    // contractURI. Best-effort: a missing / non-`ipfs://` / non-raw-CIDv1 `image_uri` yields 0 (no
    // metadata), never a parse failure — so ticker/decimals and attest liveness are unaffected.
    let cid = match env[0] {
        0x21 => cetch_image_cid(env),
        0x27 => petch_image_cid(env),
        _ => [0u8; 32], // unreachable: env[0] is gated to {0x21, 0x27} above
    };
    Some((ticker, tlen as u8, decimals, cid))
}

/// Walk a CETCH (0x21) reveal envelope to its trailing `image_uri` and return the 32-byte content
/// digest when it is an `ipfs://` raw CIDv1, else `[0;32]`. CETCH references its metadata blob
/// (`{name, description, image, …}`) by URI rather than inline like a T_PETCH cid; this surfaces it
/// into the same `cid` slot so the bridged asset's Ethereum `contractURI` is identical and trustless.
/// Mirrors `parse_cetch`'s walk, then reads `img_len(2 LE) ‖ image_uri`. Fully bounds-checked — any
/// malformed/short envelope returns `[0;32]` rather than panicking (preserves attest liveness).
fn cetch_image_cid(env: &[u8]) -> [u8; 32] {
    let z = [0u8; 32];
    if env.first() != Some(&0x21) {
        return z;
    }
    let tlen = match env.get(1) {
        Some(&t) if (1..=16).contains(&(t as usize)) => t as usize,
        _ => return z,
    };
    // 0x21 ‖ tlen(1) ‖ ticker(tlen) ‖ decimals(1) ‖ commitment(33) ‖ amount_ct(8) ‖ rp_len(2 LE)
    //   ‖ rangeproof(rp_len) ‖ mint_authority(32) ‖ img_len(2 LE) ‖ image_uri(img_len)
    let mut p = 2 + tlen + 1 + 33 + 8; // → rp_len
    let rp_len = match (env.get(p), env.get(p + 1)) {
        (Some(&a), Some(&b)) => (a as usize) | ((b as usize) << 8),
        _ => return z,
    };
    p = match p.checked_add(2 + rp_len + 32) {
        Some(v) => v, // → img_len
        None => return z,
    };
    let img_len = match (env.get(p), env.get(p + 1)) {
        (Some(&a), Some(&b)) => (a as usize) | ((b as usize) << 8),
        _ => return z,
    };
    p += 2;
    match env.get(p..p + img_len).and_then(ipfs_raw_cidv1_digest) {
        Some(d) => d,
        None => z,
    }
}

/// Walk a T_PETCH (0x27) permissionless-mint deployment envelope to its trailing `image_uri` and return
/// the raw-CIDv1 content digest, else `[0;32]`. Like a CETCH, a T_PETCH references its metadata blob by
/// URI rather than inline; the fields between `decimals` and the URI are the fair-mint terms (cap, per-mint
/// limit, height window). Layout: `0x27 ‖ tlen ‖ ticker(tlen) ‖ decimals(1) ‖ cap(8) ‖ limit(8) ‖
/// start_h(4) ‖ end_h(4) ‖ img_len(2 LE) ‖ image_uri(img_len)`. Bounds-checked — short/malformed → `[0;32]`.
fn petch_image_cid(env: &[u8]) -> [u8; 32] {
    let z = [0u8; 32];
    if env.first() != Some(&0x27) {
        return z;
    }
    let tlen = match env.get(1) {
        Some(&t) if (1..=16).contains(&(t as usize)) => t as usize,
        _ => return z,
    };
    let p = 2 + tlen + 1 + 8 + 8 + 4 + 4; // ticker ‖ decimals ‖ cap ‖ limit ‖ start_h ‖ end_h → img_len
    let img_len = match (env.get(p), env.get(p + 1)) {
        (Some(&a), Some(&b)) => (a as usize) | ((b as usize) << 8),
        _ => return z,
    };
    match env.get(p + 2..p + 2 + img_len).and_then(ipfs_raw_cidv1_digest) {
        Some(d) => d,
        None => z,
    }
}

/// Decode an `ipfs://` CIDv1 (multibase base32 `b…`, raw codec `0x55`, sha2-256, 32-byte digest) URI to
/// its 32-byte content digest, or `None` if it is not exactly that shape. The raw codec is required so
/// the digest round-trips to the same CID via the contract's `f01551220‖hex` (base16) reconstruction —
/// a dag-pb (`0x70`) or CIDv0 (`Qm…`) CID would re-encode to a different object, so those return `None`
/// (→ cid 0). Bare CID only: a trailing `/path` decodes to >36 bytes and is rejected.
fn ipfs_raw_cidv1_digest(uri: &[u8]) -> Option<[u8; 32]> {
    const PREFIX: &[u8] = b"ipfs://b"; // `ipfs://` ‖ multibase base32 tag `b`
    let b32 = uri.strip_prefix(PREFIX)?;
    // RFC4648 base32, lowercase, no padding → bytes. CIDv1 raw sha2-256 is exactly 36 bytes:
    // 0x01(v1) ‖ 0x55(raw) ‖ 0x12(sha2-256) ‖ 0x20(len 32) ‖ digest(32).
    let mut out = [0u8; 36];
    let (mut acc, mut bits, mut n) = (0u32, 0u32, 0usize);
    for &c in b32 {
        let v = match c {
            b'a'..=b'z' => c - b'a',
            b'2'..=b'7' => c - b'2' + 26,
            _ => return None, // uppercase / padding / path separator → not a bare lowercase CID
        } as u32;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            if n >= out.len() {
                return None; // decodes to more than 36 bytes → not a bare raw-CIDv1
            }
            out[n] = ((acc >> bits) & 0xff) as u8;
            n += 1;
        }
    }
    if n != 36 || out[0] != 0x01 || out[1] != 0x55 || out[2] != 0x12 || out[3] != 0x20 {
        return None;
    }
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&out[4..]);
    Some(digest)
}

/// Parse a CETCH (0x21) confidential-etch reveal → (supply_commitment `C_0`[33], `mint_authority`[32],
/// decimals). Byte-canonical with the live worker `decodeCEtchPayload`:
///   `0x21 ‖ tlen(1,1..16) ‖ ticker(tlen) ‖ decimals(1,0..8) ‖ commitment(33) ‖ amount_ct(8) ‖`
///   `rp_len(2 LE) ‖ rangeproof(rp_len) ‖ mint_authority(32) ‖ img_len(2 LE) ‖ image_uri`.
/// `commitment` is the FIXED initial-supply Pedersen commitment (`C_0`) — the trustless supply anchor for
/// the burn-and-mint onboarding (read once from the etch block; no full-history scan). Walks the same
/// CETCH envelope as `parse_etch_meta` but surfaces a different slice: this reads the supply commitment +
/// mint authority, while `parse_etch_meta` reads ticker/decimals + the metadata cid (resolved from the
/// trailing `image_uri`). None if malformed.
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
pub fn parse_cmint(env: &[u8]) -> Option<([u8; 32], [u8; 32], [u8; 33], [u8; 8], &[u8], [u8; 64])> {
    if env.is_empty() || env[0] != 0x24 {
        return None;
    }
    let asset_id: [u8; 32] = env.get(1..33)?.try_into().ok()?;
    let etch_txid: [u8; 32] = env.get(33..65)?.try_into().ok()?;
    let commitment: [u8; 33] = env.get(65..98)?.try_into().ok()?;
    let amount_ct: [u8; 8] = env.get(98..106)?.try_into().ok()?; // the issuer-signed encrypted-amount hint
    let rp_len = (*env.get(106)? as usize) | ((*env.get(107)? as usize) << 8);
    let rp_start = 108usize;
    let rp_end = rp_start.checked_add(rp_len)?;
    let range_proof = env.get(rp_start..rp_end)?;
    let issuer_sig: [u8; 64] = env.get(rp_end..rp_end + 64)?.try_into().ok()?;
    if rp_end + 64 != env.len() { return None; } // canonical: no trailing bytes past the last field
    Some((asset_id, etch_txid, commitment, amount_ct, range_proof, issuer_sig))
}

/// Parse a confidential bridge-burn envelope (opcode 0x2B) → (assetId, nullifier,
/// destCommitment). `env` is the payload from `extract_taproot_envelope` (env[0] = opcode).
/// Layout: opcode(1) ‖ assetId(32) ‖ bitcoinPoolRoot(32) ‖ nullifier(32) ‖ destCommitment(32).
/// The reflection prover binds a reflected bridge-out's destCommitment (and ν) to this, so a
/// burn's Ethereum mint cannot be redirected to a different destination. None if malformed.
pub fn parse_burn_envelope(env: &[u8]) -> Option<([u8; 32], [u8; 32], [u8; 32])> {
    if env.len() != 129 || env[0] != 0x2B {
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
    if env.len() != 161 || env[0] != 0x65 {
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

/// Parsed `T_CBTC_LOCK` envelope (opcode 0x66).
pub struct CbtcLockEnvelope {
    pub asset: [u8; 32],
    pub lock_vout: u32,
    pub cx: [u8; 32],
    pub cy: [u8; 32],
    pub sig_rx: [u8; 32],
    pub sig_ry: [u8; 32],
    pub sig_z: [u8; 32],
}

/// cBTC.zk sats-lock envelope (`T_CBTC_LOCK`, opcode 0x66): `asset(32) ‖ lock_vout(4 LE) ‖ Cx(32) ‖ Cy(32) ‖
/// reserved_sig_rx(32) ‖ reserved_sig_ry(32) ‖ reserved_sig_z(32)`. The reflection guest is now
/// TRACK-not-mint: it records only the lock output and the pre-committed cBTC note commitment hash. The
/// note's value-opening proof is checked later by `OP_CBTC_MINT`; these trailing sigma-shaped fields remain
/// only for wire compatibility with existing builders/tests. Fixed 197-byte layout.
pub fn parse_cbtc_lock_envelope(env: &[u8]) -> Option<CbtcLockEnvelope> {
    if env.len() != 197 || env[0] != 0x66 {
        return None;
    }
    Some(CbtcLockEnvelope {
        asset: env[1..33].try_into().ok()?,
        lock_vout: u32::from_le_bytes(env[33..37].try_into().ok()?),
        cx: env[37..69].try_into().ok()?,
        cy: env[69..101].try_into().ok()?,
        sig_rx: env[101..133].try_into().ok()?,
        sig_ry: env[133..165].try_into().ok()?,
        sig_z: env[165..197].try_into().ok()?,
    })
}

/// Parsed `T_BTC_CALL` envelope (opcode 0x68) — a value-free Bitcoin-authorized Ethereum call.
pub struct BtcCallEnvelope {
    pub executor: [u8; 20],
    pub target: [u8; 20],
    pub calldata_hash: [u8; 32],
    pub caller_pubkey: [u8; 32],
    pub call_nonce: [u8; 32],
    pub sig: [u8; 64],
}

/// Value-free Bitcoin call envelope (`T_BTC_CALL`, opcode 0x68): `executor(20) ‖ target(20) ‖
/// calldata_hash(32) ‖ caller_pubkey(32, x-only) ‖ call_nonce(32) ‖ sig(64)` = 201 bytes. `executor` is the
/// specific BtcCallExecutor the caller authorizes — bound into the signed message AND the recordHash so the
/// call can fire on exactly that deployment (chain + pool) and nowhere else (no cross-deployment replay). The
/// BIP-340 `sig` by `caller_pubkey` over `keccak("tacit-btc-call-v1" ‖ executor ‖ target ‖ calldata_hash ‖
/// caller_pubkey ‖ call_nonce)` proves a Bitcoin party authorized exactly this call; the reflection surfaces
/// (callId, recordHash) for the BtcCallExecutor to fire. No value, no note. (SPEC-BITCOIN-HOOK-AMENDMENT §1.4.)
pub fn parse_btc_call_envelope(env: &[u8]) -> Option<BtcCallEnvelope> {
    if env.len() != 201 || env[0] != 0x68 {
        return None;
    }
    Some(BtcCallEnvelope {
        executor: env[1..21].try_into().ok()?,
        target: env[21..41].try_into().ok()?,
        calldata_hash: env[41..73].try_into().ok()?,
        caller_pubkey: env[73..105].try_into().ok()?,
        call_nonce: env[105..137].try_into().ok()?,
        sig: env[137..201].try_into().ok()?,
    })
}

/// Parsed `T_CBTC_REDEEM` envelope (opcode 0x67) — the honest single-tx cBTC↔BTC redemption.
pub struct CbtcRedeemEnvelope {
    pub lock_txid: [u8; 32],
    pub lock_vout: u32,
    pub v_btc: u64,
    pub kernel_sig: [u8; 64],
}

/// cBTC single-tx redemption envelope (`T_CBTC_REDEEM`, opcode 0x67): `lock_txid(32) ‖ lock_vout(4 LE) ‖
/// v_btc(8 LE) ‖ kernel_sig(64)` = 109 bytes. Names the self-custody lock outpoint this tx redeems and the
/// public sats it retires; the SAME tx BURNS exactly `v_btc` of cBTC (its cBTC vins, no cBTC output), proven
/// by `kernel_sig` (the audited CXFER kernel, `Σ C_in = v_btc·H`) against the live-set-resolved input
/// commitments — so supply ↓ and backing ↓ together (the §redemption conservation identity). A redeemed lock
/// leaves the live set WITHOUT entering the slashable spent set, so an honest exit is never a rug.
pub fn parse_cbtc_redeem_envelope(env: &[u8]) -> Option<CbtcRedeemEnvelope> {
    if env.len() != 109 || env[0] != 0x67 {
        return None;
    }
    Some(CbtcRedeemEnvelope {
        lock_txid: env[1..33].try_into().ok()?,
        lock_vout: u32::from_le_bytes(env[33..37].try_into().ok()?),
        v_btc: u64::from_le_bytes(env[37..45].try_into().ok()?),
        kernel_sig: env[45..109].try_into().ok()?,
    })
}

/// Parsed `T_SWAP_VAR` envelope (opcode 0x32) — the public-reserve AMM swap (SPEC §5.16.3 / AMM.md).
/// Reserves + amounts are PUBLIC u64 and the receipt's blinding `r_receipt` is cleartext, so the taker's
/// output note `C_receipt` opens publicly. That is exactly what lets the reflection verify per-asset
/// conservation by ARITHMETIC (no kernel) before onboarding the taker's output as real — Track B in
/// ops/DESIGN-bridge-multiasset-provenance.md. Wire (after opcode): `pool_id(32) ‖ direction(1) ‖
/// R_A_pre(8 LE) ‖ R_B_pre(8) ‖ delta_in(8) ‖ delta_in_min(8) ‖ delta_in_max(8) ‖ delta_out(8) ‖
/// min_out(8) ‖ tip_amount(8) ‖ tip_asset(1) ‖ expiry_height(4 LE) ‖ trader_pubkey(33) ‖ C_in_secp(33) ‖
/// C_change_or_sentinel(33) ‖ C_receipt_secp(33) ‖ r_receipt(32) ‖ rangeproof_len(2 LE) ‖
/// range_proof(VAR) ‖ kernel_sig(64) ‖ intent_sig(64)`.
#[derive(Clone)]
pub struct SwapVarEnvelope {
    pub pool_id: [u8; 32],
    pub direction: u8, // 0 = A→B (taker gives asset_A, receives asset_B); 1 = B→A
    pub r_a_pre: u64,
    pub r_b_pre: u64,
    pub delta_in: u64,            // taker input amount credited to the in-asset reserve
    pub tip_amount: u64,          // settler tip (also drawn from C_in; delta_in_total = delta_in + tip)
    pub delta_out: u64,           // taker output amount drawn from the out-asset reserve — the receipt value
    pub c_in: [u8; 33],           // the taker's spent input note commitment (kernel input side)
    pub c_change_or_sentinel: [u8; 33], // taker's change (or the all-zero sentinel = exact input, no change)
    pub c_receipt: [u8; 33],      // the taker's output note commitment (the bridgeable note)
    pub r_receipt: [u8; 32],      // PUBLIC blinding: C_receipt opens to delta_out under it
    pub kernel_sig: [u8; 64],     // BIP-340 over the input-side conservation (C_in − C_change = delta_in_total·H)
}

/// Parse a `T_SWAP_VAR` envelope. None if not a well-formed 0x32 envelope. Surfaces the public-reserve
/// fields + the kernel input side the reflection's Track-B conservation needs; the unread fields
/// (slippage bounds, trader pubkey, range proof, intent sig) ride for the on-chain validator.
pub fn parse_swap_var_envelope(env: &[u8]) -> Option<SwapVarEnvelope> {
    const PRE_RP: usize = 269; // bytes through rangeproof_len (opcode .. r_receipt .. rp_len)
    if env.len() < PRE_RP || env[0] != 0x32 {
        return None;
    }
    let direction = env[33];
    if direction != 0 && direction != 1 {
        return None;
    }
    let rp_len = u16::from_le_bytes(env[267..269].try_into().ok()?) as usize;
    // kernel_sig + intent_sig follow the range proof — require the full envelope so a truncated one rejects.
    let ks_off = PRE_RP + rp_len;
    if env.len() != ks_off + 64 + 64 {
        return None; // exact: kernel_sig + intent_sig close the envelope, no trailing bytes
    }
    Some(SwapVarEnvelope {
        pool_id: env[1..33].try_into().ok()?,
        direction,
        r_a_pre: u64::from_le_bytes(env[34..42].try_into().ok()?),
        r_b_pre: u64::from_le_bytes(env[42..50].try_into().ok()?),
        delta_in: u64::from_le_bytes(env[50..58].try_into().ok()?),
        tip_amount: u64::from_le_bytes(env[90..98].try_into().ok()?),
        delta_out: u64::from_le_bytes(env[74..82].try_into().ok()?),
        c_in: env[136..169].try_into().ok()?,
        c_change_or_sentinel: env[169..202].try_into().ok()?,
        c_receipt: env[202..235].try_into().ok()?,
        r_receipt: env[235..267].try_into().ok()?,
        kernel_sig: env[ks_off..ks_off + 64].try_into().ok()?,
    })
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
///
/// Also accepts the **atomic-settlement family** — `T_AXFER` (0x26, OTC), `T_AXFER_VAR` (0x37, variable
/// amount), and their BP+ variants `T_AXFER_BPP` (0x3C) / `T_AXFER_VAR_BPP` (0x3D). All are byte-identical
/// to CXFER (worker `decodeAxferPayload` == `decodeCxferPayload`, the variants differing only in opcode +
/// rangeproof flavor) and conserve under the SAME `tacit-kernel-v1` kernel — they're one ancestry family
/// (worker index.js:13282). The Bitcoin tx carries aux NON-tacit (sats) inputs; those aren't pool UTXOs, so
/// `scan_tx_spends` never sees them, and a confirmed atomic settlement's output notes onboard exactly like a
/// CXFER's (no new fold). A variant whose rangeproof/wire doesn't actually match fails the conservation gate
/// (skip-not-panic) — fail-closed, never an over-mint. See ops/DESIGN-bridge-multiasset-provenance.md (Track A).
pub fn parse_cxfer_envelope_full(env: &[u8]) -> Option<([u8; 32], [u8; 64], Vec<[u8; 33]>, Vec<u8>)> {
    let op = env.first().copied()?;
    let known = op == 0x23 || op == 0x22 || op == 0x26 || op == 0x37 || op == 0x3C || op == 0x3D;
    if env.len() < 1 + 32 + 64 + 1 || !known {
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

/// The `T_PREAUTH_BID_VAR` (0x5C) inline section between `asset_input_count` and `kernel_sig`:
/// `bid_id(16) ‖ recipient_pubkey(33) ‖ price_per_unit(8) ‖ max_fill(8) ‖ fill_increment(8) ‖
/// fill_amount(8) ‖ recipient_blinding(32) ‖ refund_script_hash(20) ‖ decimals_scale(1)`.
pub const PREAUTH_BID_VAR_INLINE: usize = 16 + 33 + 8 + 8 + 8 + 8 + 32 + 20 + 1; // 134

/// Parse a `T_PREAUTH_BID_VAR` (0x5C, buyer-offline partial-fill orderbook bid) into the SAME
/// `(asset, kernel_sig, output_commitments, range_proof)` tuple as a CXFER — because the bid IS a CXFER on
/// the tacit-asset side: the seller's asset inputs conserve into the buyer's filled note `output[0]` + the
/// seller's change `output[1]` under `tacit-kernel-v1`, with ONE aggregated BP+ range over all N outputs
/// (dapp/tacit.js: "one aggregated rangeproof covers all N output commitments"). The sats legs (the seller's
/// payment + the buyer's refund) are native-BTC outputs, not pool notes, so they're irrelevant to the tacit
/// kernel. Feeding this tuple to `verify_cxfer_conservation` + the cxfer fold onboards the bid's output notes
/// exactly like a transfer's — orderbook = Track A. See ops/DESIGN-bridge-multiasset-provenance.md.
/// Layout: opcode(1) ‖ asset_id(32) ‖ asset_input_count(1) ‖ INLINE(134) ‖ kernel_sig(64) ‖ N(1, ∈{1,2}) ‖
/// out[0].commitment(33) [‖ out[1].commitment(33) ‖ out[1].amount_ct(8)] ‖ rp_len(2 LE) ‖ rangeproof.
/// (Only `out[1]` carries an 8-byte `amount_ct`; the buyer's `out[0]` does not — its blinding is cleartext.)
pub fn parse_preauth_bid_var_envelope(env: &[u8]) -> Option<([u8; 32], [u8; 64], Vec<[u8; 33]>, Vec<u8>)> {
    parse_preauth_bid_common(env, 0x5C, PREAUTH_BID_VAR_INLINE)
}

/// True iff a `T_PREAUTH_BID_VAR` (0x5C) envelope carries a BUYER REFUND (`fill_amount < max_fill`). A refund
/// adds the buyer's sats-refund output, shifting the seller-CHANGE tacit note from vout 3 (full fill) to
/// vout 4 — `canonical_bid_output_vout` consumes this to key the change note at its REAL outpoint. Mirrors
/// the dapp `decodePreauthBidVarPayload` (max_fill + fill_amount are u64 LE inside the 134-byte inline) and
/// `getParentEnvelopeData`'s `changeVout = hasRefund ? 4 : 3`. `None` if not a well-formed 0x5C envelope.
pub fn preauth_bid_var_has_refund(env: &[u8]) -> Option<bool> {
    if env.first().copied()? != 0x5C { return None; }
    // opcode(1) ‖ asset_id(32) ‖ asset_input_count(1) ‖ INLINE[ bid_id(16) ‖ recipient_pubkey(33) ‖
    // price_per_unit(8) ‖ max_fill(8) ‖ fill_increment(8) ‖ fill_amount(8) ‖ … ].
    let max_fill_off = 1 + 32 + 1 + 16 + 33 + 8; // 91
    let fill_amount_off = max_fill_off + 8 + 8; // 107 (skip max_fill + fill_increment)
    let max_fill = u64::from_le_bytes(env.get(max_fill_off..max_fill_off + 8)?.try_into().ok()?);
    let fill_amount = u64::from_le_bytes(env.get(fill_amount_off..fill_amount_off + 8)?.try_into().ok()?);
    Some(fill_amount < max_fill)
}

/// The `T_PREAUTH_BID` (0x5B) exact-fill inline section (SPEC §5.7.11): `bid_id(16) ‖ recipient_pubkey(33) ‖
/// amount(8) ‖ recipient_blinding(32) ‖ price_sats(8)` — no variable-fill params (so 97 vs the var bid's 134).
pub const PREAUTH_BID_INLINE: usize = 16 + 33 + 8 + 32 + 8; // 97

/// Parse a `T_PREAUTH_BID` (0x5B, the exact-fill / "walk-away only, partial-fill OFF" orderbook bid). Same
/// CXFER-family conservation as the partial-fill bid (the seller's asset inputs → the buyer's filled note +
/// seller change under `tacit-kernel-v1`); only the inline section is shorter. Returns the cxfer-compatible
/// `(asset, kernel_sig, output_commitments, range_proof)` tuple, fed to `verify_cxfer_conservation` + the
/// cxfer fold exactly like the partial-fill bid.
pub fn parse_preauth_bid_envelope(env: &[u8]) -> Option<([u8; 32], [u8; 64], Vec<[u8; 33]>, Vec<u8>)> {
    parse_preauth_bid_common(env, 0x5B, PREAUTH_BID_INLINE)
}

/// Shared parser for the preauth-bid family — exact-fill (0x5B) + partial-fill (0x5C) differ ONLY in opcode
/// + inline length; the kernel_sig / N / output-commitment / rangeproof tail is identical (out[0] cleartext
/// blinding ⇒ no amount_ct; out[1] carries one).
fn parse_preauth_bid_common(env: &[u8], opcode: u8, inline_len: usize) -> Option<([u8; 32], [u8; 64], Vec<[u8; 33]>, Vec<u8>)> {
    let ks_off = 1 + 32 + 1 + inline_len; // start of kernel_sig
    if env.len() < ks_off + 64 + 1 + 33 + 2 || env.first().copied()? != opcode {
        return None;
    }
    let asset: [u8; 32] = env[1..33].try_into().ok()?;
    let kernel_sig: [u8; 64] = env[ks_off..ks_off + 64].try_into().ok()?;
    let n = env[ks_off + 64] as usize;
    if n != 1 && n != 2 {
        return None;
    }
    let mut p = ks_off + 64 + 1; // first output commitment
    let mut commitments = Vec::with_capacity(n);
    for i in 0..n {
        if p + 33 > env.len() {
            return None;
        }
        commitments.push(env[p..p + 33].try_into().ok()?);
        p += 33;
        if i == 1 {
            p += 8; // out[1] carries an 8-byte amount_ct; out[0] does not
        }
    }
    if p + 2 > env.len() {
        return None;
    }
    let rp_len = (env[p] as usize) | ((env[p + 1] as usize) << 8);
    p += 2;
    if p + rp_len != env.len() {
        return None;
    }
    Some((asset, kernel_sig, commitments, env[p..p + rp_len].to_vec()))
}

/// The tacit-amm cross-curve (secp↔BabyJubJub) sigma length in the LP envelopes. The reflection skips
/// past it (it doesn't verify the BJJ side — the secp kernel + public deltas are the Track-B conservation).
const XCURVE_SIGMA_LEN: usize = 169;

/// Parsed `T_LP_ADD` / POOL_INIT envelope (0x2D). Surfaces the fields the reflection's `fold_lp_add` needs
/// (the per-asset secp kernel sides + the public deltas); the BJJ commitment + cross-curve sigma are
/// skipped. `fee_bps` is meaningful only for `variant == 1` (POOL_INIT, which carries it for pool_id
/// derivation); a `variant == 0` LP-add doesn't carry it (the pool is found by canonical-asset enumeration).
pub struct LpAddEnvelope {
    pub variant: u8,
    pub asset_a: [u8; 32],
    pub asset_b: [u8; 32],
    pub delta_a: u64,
    pub delta_b: u64,
    pub share_amount: u64,
    pub share_csecp: [u8; 33],
    pub kernel_sig_a: [u8; 64],
    pub kernel_sig_b: [u8; 64],
    /// PUBLIC blinding of the minted LP-share note: `share_c_secp` opens to the LP's share amount under it.
    /// On-chain (option a) so the relay can fold the mint without an off-chain witness — same model as
    /// SwapVarEnvelope::r_receipt (a key-derived blinding for a public-value reflected note; revealing it
    /// leaks no value (the share amount is public), no key (it is a PRF output), and is not reused downstream).
    pub share_r: [u8; 32],
    pub fee_bps: u16,
    // POOL_INIT (variant 1) pool-identity config — all feed the 6-arg pool_id (a protocol-fee or
    // capability-flagged pool gets a DISTINCT pool_id from the canonical no-skim slot). `protocol_fee_bps`
    // also seeds the lazy-mintFee tier (creator-earned LP-fee skim). `capability_flags` is a Bitcoin-side
    // concept only (the EVM settle/bridge side has no pools). Zero/none for variant 0.
    pub capability_flags: u8,
    pub protocol_fee_address: [u8; 33], // all-zero ⇒ no protocol fee
    pub protocol_fee_bps: u16,          // 0 ⇒ no protocol fee
}

/// Parse a `T_LP_ADD` (0x2D) envelope. Header (worker `decodeTLpAddPayload`): opcode(1) ‖ variant(1) ‖
/// asset_a(32) ‖ asset_b(32) ‖ delta_a(8 LE) ‖ delta_b(8) ‖ share_amount(8) ‖ share_c_secp(33) ‖ share_c_bjj(32)
/// ‖ share_xcurve_sigma(169) ‖ kernel_sig_a(64) ‖ kernel_sig_b(64) ‖ share_r(32, option-a opening blinding).
/// For variant 1 (POOL_INIT) a VARIABLE-LENGTH tail follows share_r: fee_bps(2) ‖ vkLen(1)‖vkCid ‖
/// cerLen(1)‖ceremonyCid ‖ arbCount(1)‖arbM(1)‖arbiterPubkeys(33·n)
/// ‖ lsigCount(1)‖launcherSigs(64·n) ‖ protocol_fee_address(33) ‖ protocol_fee_bps(2) ‖ metaLen(1)‖poolMetaUri ‖
/// capability_flags(1). The reflection WALKS it to surface the four pool-identity fields (vk/ceremony/
/// arbiter/launcher/meta bytes skipped — the arbiter fields are zero-count in v1 but always present in the
/// wire, so the walk skips them regardless). Fails closed on any truncation.
pub fn parse_lp_add_envelope(env: &[u8]) -> Option<LpAddEnvelope> {
    const HEADER: usize = 1 + 1 + 32 + 32 + 8 + 8 + 8 + 33 + 32 + XCURVE_SIGMA_LEN + 64 + 64; // 452
    const TAIL: usize = HEADER + 32; // 484 — share_r(32) sits between the header and the variant-1 tail
    if env.len() < TAIL || env[0] != 0x2D {
        return None;
    }
    let variant = env[1];
    if variant != 0 && variant != 1 {
        return None;
    }
    let (fee_bps, capability_flags, protocol_fee_address, protocol_fee_bps) = if variant == 1 {
        let take = |p: &mut usize, n: usize| -> Option<()> {
            let end = p.checked_add(n)?;
            if end > env.len() {
                return None;
            }
            *p = end;
            Some(())
        };
        let mut p = TAIL; // the variant-1 tail begins AFTER share_r
        let f0 = p;
        take(&mut p, 2)?;
        let fee = u16::from_le_bytes(env[f0..f0 + 2].try_into().ok()?);
        take(&mut p, 1)?;
        { let n = env[p - 1] as usize; take(&mut p, n)?; } // vkLen(1) ‖ vkCid
        take(&mut p, 1)?;
        { let n = env[p - 1] as usize; take(&mut p, n)?; } // cerLen(1) ‖ ceremonyCid
        take(&mut p, 1)?;
        let arb_count = env[p - 1] as usize;
        take(&mut p, 1)?; // arbM (worker-validated; not needed here)
        take(&mut p, arb_count.checked_mul(33)?)?; // arbiter pubkeys (zero-count in v1)
        take(&mut p, 1)?;
        let lsig_count = env[p - 1] as usize;
        take(&mut p, lsig_count.checked_mul(64)?)?; // launcher sigs
        let pa = p;
        take(&mut p, 33)?;
        let addr: [u8; 33] = env[pa..pa + 33].try_into().ok()?;
        let pb = p;
        take(&mut p, 2)?;
        let pf = u16::from_le_bytes(env[pb..pb + 2].try_into().ok()?);
        take(&mut p, 1)?;
        { let n = env[p - 1] as usize; take(&mut p, n)?; } // metaLen(1) ‖ poolMetaUri
        take(&mut p, 1)?;
        let cf = env[p - 1]; // capability_flags
        // POOL_CAP_ARBITER_AUTHORITY (0x04) is reserved (spec/amm/wire-formats.md
        // "Pool ID derivation"): asserting it would require appending the arbiter
        // quorum root to pool_id, which no fold implements yet. Fail closed.
        if cf & 0x04 != 0 {
            return None;
        }
        (fee, cf, addr, pf)
    } else {
        (0, 0, [0u8; 33], 0)
    };
    Some(LpAddEnvelope {
        variant,
        asset_a: env[2..34].try_into().ok()?,
        asset_b: env[34..66].try_into().ok()?,
        delta_a: u64::from_le_bytes(env[66..74].try_into().ok()?),
        delta_b: u64::from_le_bytes(env[74..82].try_into().ok()?),
        share_amount: u64::from_le_bytes(env[82..90].try_into().ok()?),
        share_csecp: env[90..123].try_into().ok()?,
        kernel_sig_a: env[324..388].try_into().ok()?,
        kernel_sig_b: env[388..452].try_into().ok()?,
        share_r: env[HEADER..TAIL].try_into().ok()?, // 452..484
        fee_bps,
        capability_flags,
        protocol_fee_address,
        protocol_fee_bps,
    })
}

/// Parsed `T_LP_REMOVE` envelope (0x2E). Surfaces the secp side `fold_lp_remove` needs; the BJJ commitments
/// + cross-curve sigmas are skipped (the reflection binds each `recv_X_secp` to the public `delta_X` by its
/// on-chain opening blinding `r_recv_X`, not the BJJ machinery — see ops/DESIGN-bridge-multiasset-provenance.md).
pub struct LpRemoveEnvelope {
    pub asset_a: [u8; 32],
    pub asset_b: [u8; 32],
    pub share_amount: u64,
    pub delta_a: u64,
    pub delta_b: u64,
    pub recv_a_secp: [u8; 33],
    pub recv_b_secp: [u8; 33],
    pub kernel_sig: [u8; 64],
    /// PUBLIC blindings of the two withdrawn notes: `recv_a_secp` opens to `delta_a` under `r_recv_a`,
    /// `recv_b_secp` to `delta_b` under `r_recv_b`. On-chain (option a) so the relay folds without an
    /// off-chain witness — same key-derived-blinding model as SwapVarEnvelope::r_receipt (no value/key/link
    /// leak: the deltas are public, the blindings are PRF outputs, not reused downstream).
    pub r_recv_a: [u8; 32],
    pub r_recv_b: [u8; 32],
}

/// Parse a `T_LP_REMOVE` (0x2E) envelope. Layout (worker `decodeTLpRemovePayload`): opcode(1) ‖ asset_a(32) ‖
/// asset_b(32) ‖ share_amount(8 LE) ‖ delta_a(8) ‖ delta_b(8) ‖ recv_a_secp(33) ‖ recv_a_bjj(32) ‖
/// recv_a_xcurve_sigma(169) ‖ recv_b_secp(33) ‖ recv_b_bjj(32) ‖ recv_b_xcurve_sigma(169) ‖ kernel_sig(64) ‖
/// r_recv_a(32) ‖ r_recv_b(32) ‖ proof_len(2) ‖ proof. (The two opening blindings are option-a additions
/// between the kernel sig and the proof.)
pub fn parse_lp_remove_envelope(env: &[u8]) -> Option<LpRemoveEnvelope> {
    const RECV_B_SECP_OFF: usize = 1 + 32 + 32 + 8 + 8 + 8 + 33 + 32 + XCURVE_SIGMA_LEN; // 323
    const KS_OFF: usize = RECV_B_SECP_OFF + 33 + 32 + XCURVE_SIGMA_LEN; // 557
    const R_OFF: usize = KS_OFF + 64; // 621 — r_recv_a, then r_recv_b
    if env.len() < R_OFF + 64 + 2 || env[0] != 0x2E {
        return None;
    }
    Some(LpRemoveEnvelope {
        asset_a: env[1..33].try_into().ok()?,
        asset_b: env[33..65].try_into().ok()?,
        share_amount: u64::from_le_bytes(env[65..73].try_into().ok()?),
        delta_a: u64::from_le_bytes(env[73..81].try_into().ok()?),
        delta_b: u64::from_le_bytes(env[81..89].try_into().ok()?),
        recv_a_secp: env[89..122].try_into().ok()?,
        recv_b_secp: env[RECV_B_SECP_OFF..RECV_B_SECP_OFF + 33].try_into().ok()?,
        kernel_sig: env[KS_OFF..KS_OFF + 64].try_into().ok()?,
        r_recv_a: env[R_OFF..R_OFF + 32].try_into().ok()?,
        r_recv_b: env[R_OFF + 32..R_OFF + 64].try_into().ok()?,
    })
}

/// Parsed `T_FARM_INIT` envelope (0x34) — the fields the reflection's `fold_farm_init` needs (the farm-id
/// components + the treasury-funding kernel side). reward_per_block / heights / range proof / launcher_sig
/// ride for the worker's farm bookkeeping.
pub struct FarmInitEnvelope {
    pub pool_id: [u8; 32],
    pub farm_nonce: [u8; 32],
    pub launcher_pubkey: [u8; 33],
    pub reward_asset: [u8; 32],
    pub reward_total: u64,
    /// Total reward units/block — the farm `rate` the reflection feeds to `FarmRewardState` at init
    /// (SPEC-CONTROLLER-VAULT-AMENDMENT §8.4).
    pub reward_per_block: u64,
    pub c_change_or_sentinel: [u8; 33],
    pub kernel_sig: [u8; 64],
}

/// Parse a `T_FARM_INIT` (0x34) envelope. Layout (worker `decodeTFarmInitPayload`): opcode(1) ‖ pool_id(32) ‖
/// farm_nonce(32) ‖ launcher_pubkey(33) ‖ reward_asset(32) ‖ reward_total(8 LE) ‖ reward_per_block(8) ‖
/// start_height(4) ‖ end_height(4) ‖ c_change_or_sentinel(33) ‖ rp_len(2 LE) ‖ range_proof(VAR) ‖
/// kernel_sig(64) ‖ launcher_sig(64). The kernel proves the launcher funded `reward_total` of `reward_asset`
/// into the treasury (`C_in − C_change = reward_total·H`, same shape as a swap input side).
pub fn parse_farm_init_envelope(env: &[u8]) -> Option<FarmInitEnvelope> {
    const RP_LEN_OFF: usize = 1 + 32 + 32 + 33 + 32 + 8 + 8 + 4 + 4 + 33; // 187
    if env.len() < RP_LEN_OFF + 2 || env[0] != 0x34 {
        return None;
    }
    let rp_len = u16::from_le_bytes(env[RP_LEN_OFF..RP_LEN_OFF + 2].try_into().ok()?) as usize;
    let ks_off = RP_LEN_OFF + 2 + rp_len;
    if env.len() != ks_off + 64 + 64 {
        return None; // exact: kernel_sig + launcher_sig close the envelope, no trailing bytes
    }
    Some(FarmInitEnvelope {
        pool_id: env[1..33].try_into().ok()?,
        farm_nonce: env[33..65].try_into().ok()?,
        launcher_pubkey: env[65..98].try_into().ok()?,
        reward_asset: env[98..130].try_into().ok()?,
        reward_total: u64::from_le_bytes(env[130..138].try_into().ok()?),
        reward_per_block: u64::from_le_bytes(env[138..146].try_into().ok()?),
        c_change_or_sentinel: env[154..187].try_into().ok()?,
        kernel_sig: env[ks_off..ks_off + 64].try_into().ok()?,
    })
}

/// Parse a `T_LP_HARVEST` (0x3B, 226-byte) envelope → `(farm_id, reward_amount, reward_r)`. The reward note
/// is NOT in the envelope — it's minted by decree at the tx's vout[1], and the reflection DERIVES it as
/// `reward_amount·H + reward_r·G` (both public). Layout: opcode(1) ‖ farm_id(32) ‖ bond_id(36) ‖
/// harvester_pubkey(33) ‖ exit_acc_per_share(16) ‖ exit_view_height(4) ‖ reward_amount(8 LE) ‖ reward_r(32) ‖
/// harvester_sig(64).
/// Trustless harvest: the OLD receipt's `(owner_commit, old_nonce, new_nonce, shares, rps_entry)` ride the
/// PUBLIC envelope tail (so any prover reconstructs + nullifies it + appends the advanced receipt). Appended
/// after `reward_r` to keep the legacy offsets stable: `…reward_r(32)[130..162] ‖ owner_commit(32)[162..194] ‖
/// old_nonce(32)[194..226] ‖ new_nonce(32)[226..258] ‖ shares(8 LE)[258..266] ‖ rps_entry(16 LE)[266..282] ‖
/// harvester_sig(64)[282..346]`. `owner_commit` is the receipt owner's ONE-TIME x-only pubkey; `harvester_sig`
/// is its BIP-340 auth over the spend (verified in `fold_lp_harvest`). Mirrors `encodeLpHarvest`.
#[allow(clippy::type_complexity)]
pub fn parse_lp_harvest_envelope(
    env: &[u8],
) -> Option<([u8; 32], u64, [u8; 32], [u8; 32], [u8; 32], [u8; 32], u64, u128, [u8; 64])> {
    if env.len() != 346 || env[0] != 0x3B {
        return None;
    }
    Some((
        env[1..33].try_into().ok()?,                         // farm_id
        u64::from_le_bytes(env[122..130].try_into().ok()?),  // reward_amount
        env[130..162].try_into().ok()?,                      // reward_r
        env[162..194].try_into().ok()?,                      // owner_commit (one-time x-only pubkey)
        env[194..226].try_into().ok()?,                      // old_nonce
        env[226..258].try_into().ok()?,                      // new_nonce
        u64::from_le_bytes(env[258..266].try_into().ok()?),  // shares
        u128::from_le_bytes(env[266..282].try_into().ok()?), // rps_entry
        env[282..346].try_into().ok()?,                      // harvester_sig (owner BIP-340 auth)
    ))
}

/// Extract the fixed-prefix fields of a `T_LP_BOND` (0x35) envelope →
/// `(farm_id, bonder_pubkey, bond_amount, entry_acc_per_share, bond_view_height)`. The bond uses `bond_amount`;
/// the receipt's `rps_entry` is the reflection's live `rps` (the envelope's `entry_acc_per_share` is not
/// trusted). Variable length (a BP+ range-proof tail); only the fixed prefix is parsed. Mirrors `encodeLpBond`.
pub fn parse_lp_bond_fields(env: &[u8]) -> Option<([u8; 32], [u8; 33], u64, u128, u32)> {
    if env.len() < 94 || env[0] != 0x35 {
        return None;
    }
    Some((
        env[1..33].try_into().ok()?,
        env[33..66].try_into().ok()?,
        u64::from_le_bytes(env[66..74].try_into().ok()?),
        u128::from_le_bytes(env[74..90].try_into().ok()?),
        u32::from_le_bytes(env[90..94].try_into().ok()?),
    ))
}

/// Like `parse_lp_bond_fields` but ALSO returns the blinded receipt `owner_commit(32)` + `nonce(32)` (PUBLIC,
/// so ANY prover folds the bond trustlessly into the receipt leaf) and the share-lock `kernel_sig(64)` that
/// binds `bond_amount` to the bonder's spent LP-share notes (`lp_bond_kernel_verify`). Matches `encodeLpBond`:
/// `…view_h(4)[90..94] ‖ owner_commit(32)[94..126] ‖ nonce(32)[126..158] ‖ c_change(33)[158..191] ‖
/// rp_len(2 LE)[191..193] ‖ range_proof(rp_len) ‖ kernel_sig(64) ‖ bonder_sig(64)`. The receipt owner is a
/// blinded `pubkey+b·G` with fresh `b` per bond, so publishing it is trustless yet unlinkable.
pub fn parse_lp_bond_fields_full(
    env: &[u8],
) -> Option<([u8; 32], [u8; 33], u64, u128, u32, [u8; 32], [u8; 32], [u8; 64])> {
    if env.len() < 193 || env[0] != 0x35 {
        return None;
    }
    let rp_len = u16::from_le_bytes(env[191..193].try_into().ok()?) as usize;
    let ks_off = 193usize.checked_add(rp_len)?;
    if env.len() != ks_off.checked_add(128)? {
        return None; // exact close: kernel_sig(64) + bonder_sig(64)
    }
    Some((
        env[1..33].try_into().ok()?,                       // farm_id
        env[33..66].try_into().ok()?,                      // bonder_pubkey
        u64::from_le_bytes(env[66..74].try_into().ok()?),  // bond_amount
        u128::from_le_bytes(env[74..90].try_into().ok()?), // entry_acc_per_share (untrusted)
        u32::from_le_bytes(env[90..94].try_into().ok()?),  // bond_view_height
        env[94..126].try_into().ok()?,                     // owner_commit (blinded receipt owner)
        env[126..158].try_into().ok()?,                    // nonce
        env[ks_off..ks_off + 64].try_into().ok()?,         // kernel_sig
    ))
}

/// Parse a `T_LP_UNBOND` (0x36, 217-byte fixed). TRUSTLESS: the bond's RECEIPT `(owner_commit, nonce, shares,
/// rps_entry)` rides the PUBLIC envelope so any prover reconstructs + nullifies it, drops `shares` from the
/// farm's `total_shares`, AND re-mints the bonded LP-shares as a live `lp_asset` note opening to `shares`
/// under the PUBLIC `lp_return_r` (no reward — harvest first). Layout: opcode(1)=0x36 ‖ farm_id(32)[1..33] ‖
/// owner_commit(32)[33..65] ‖ nonce(32)[65..97] ‖ shares(8 LE)[97..105] ‖ rps_entry(16 LE)[105..121] ‖
/// lp_return_r(32)[121..153] ‖ unbonder_sig(64)[153..217]. `owner_commit` is the receipt owner's ONE-TIME
/// x-only pubkey; `unbonder_sig` is its BIP-340 auth over the spend (verified in `fold_lp_unbond`) — the
/// public preimage gates membership, the sig gates the SPEND. Mirrors `encodeLpUnbond`.
#[allow(clippy::type_complexity)]
pub fn parse_lp_unbond_fields(
    env: &[u8],
) -> Option<([u8; 32], [u8; 32], [u8; 32], u64, u128, [u8; 32], [u8; 64])> {
    if env.len() != 217 || env[0] != 0x36 {
        return None;
    }
    Some((
        env[1..33].try_into().ok()?,                         // farm_id
        env[33..65].try_into().ok()?,                        // owner_commit (one-time x-only pubkey)
        env[65..97].try_into().ok()?,                        // nonce
        u64::from_le_bytes(env[97..105].try_into().ok()?),   // shares
        u128::from_le_bytes(env[105..121].try_into().ok()?), // rps_entry
        env[121..153].try_into().ok()?,                      // lp_return_r
        env[153..217].try_into().ok()?,                      // unbonder_sig (owner BIP-340 auth)
    ))
}

/// Parse a `T_FARM_REFUND` (0x3E, 174-byte fixed) → `(farm_id, refund_amount, refund_r)`. The launcher
/// reclaims unspent treasury post-grace; the refund note opens to `refund_amount` under the PUBLIC `refund_r`
/// — the SAME shape as a harvest reward — so `fold_harvest` onboards it + debits the treasury (no new fold).
/// The launcher authorization (`launcher_sig`, post-grace timing) is the worker's fairness gate, not a
/// bridge-soundness one (the refund is ≤ the real treasury, never minted). Mirrors the worker
/// `decodeTFarmRefundPayload`. Layout: opcode(1)=0x3E ‖ farm_id(32) ‖ launcher_pubkey(33) ‖ refund_amount(8 LE)
/// ‖ refund_view_height(4) ‖ refund_r(32) ‖ launcher_sig(64).
pub fn parse_farm_refund_envelope(env: &[u8]) -> Option<([u8; 32], u64, [u8; 32])> {
    if env.len() != 174 || env[0] != 0x3E {
        return None;
    }
    Some((
        env[1..33].try_into().ok()?,                       // farm_id
        u64::from_le_bytes(env[66..74].try_into().ok()?),  // refund_amount (after farm_id(32) + launcher_pubkey(33))
        env[78..110].try_into().ok()?,                     // refund_r (after refund_amount(8) + refund_view_height(4))
    ))
}

/// Full T_FARM_REFUND parse incl. the launcher authorization the reflection must verify in-guest:
/// `(farm_id, launcher_pubkey(33), refund_amount, refund_view_height, refund_r, launcher_sig(64))`.
/// Layout: opcode(1)=0x3E ‖ farm_id(32) ‖ launcher_pubkey(33) ‖ refund_amount(8 LE) ‖ refund_view_height(4 LE)
/// ‖ refund_r(32) ‖ launcher_sig(64).
#[allow(clippy::type_complexity)]
pub fn parse_farm_refund_envelope_full(
    env: &[u8],
) -> Option<([u8; 32], [u8; 33], u64, u32, [u8; 32], [u8; 64])> {
    if env.len() != 174 || env[0] != 0x3E {
        return None;
    }
    Some((
        env[1..33].try_into().ok()?,                       // farm_id
        env[33..66].try_into().ok()?,                      // launcher_pubkey (compressed)
        u64::from_le_bytes(env[66..74].try_into().ok()?),  // refund_amount
        u32::from_le_bytes(env[74..78].try_into().ok()?),  // refund_view_height
        env[78..110].try_into().ok()?,                     // refund_r
        env[110..174].try_into().ok()?,                    // launcher_sig
    ))
}

/// Parse a `T_PROTOCOL_FEE_CLAIM` (0x31, 202-byte fixed) → `(pool_id, claim_amount, claim_c_secp, claim_blinding)`.
/// The founder-pinned recipient mints the pool's accrued protocol-fee LP-shares: `claim_c_secp` is the minted
/// note (opens to `claim_amount` under the PUBLIC `claim_blinding`), of asset `amm_derive_lp_asset_id(pool_id)`.
/// The reflection's `fold_protocol_fee_claim` crystallizes the pool's protocol fee (`protocol_fee_shares`) and
/// requires `claim_amount == accrued` (no over-mint) before onboarding. Mirrors the worker
/// `decodeTProtocolFeeClaimPayload`. Layout: opcode(1)=0x31 ‖ pool_id(32) ‖ claimer_pubkey_x_only(32) ‖
/// claim_amount(8 LE) ‖ claim_C_secp(33) ‖ claim_blinding(32) ‖ claim_sig(64). (The claimer sig + x-only==fee
/// recipient are the worker's authorization gate, not a bridge-soundness one.)
pub fn parse_protocol_fee_claim_envelope(env: &[u8]) -> Option<([u8; 32], u64, [u8; 33], [u8; 32])> {
    if env.len() != 202 || env[0] != 0x31 {
        return None;
    }
    Some((
        env[1..33].try_into().ok()?,                       // pool_id
        u64::from_le_bytes(env[65..73].try_into().ok()?),  // claim_amount (after pool_id(32) + claimer_x_only(32))
        env[73..106].try_into().ok()?,                     // claim_C_secp
        env[106..138].try_into().ok()?,                    // claim_blinding
    ))
}

/// One intent's reflection-relevant fields from a T_SWAP_BATCH (0x2F) envelope.
pub struct SwapBatchIntent {
    pub direction: u8,       // 0 = A→B, 1 = B→A
    pub c_in_secp: [u8; 33], // the trader's spent input note (secp) — used by the aggregate Pedersen identity
    pub c_in_bjj: [u8; 32],  // compressed BabyJubJub input commitment (circuit C_in_BJJ_u/_v after decompress)
    pub min_out: u64,
    pub tip_amount: u64,
}

/// One receipt's reflection-relevant fields: the secp note to onboard, its BabyJubJub twin, and the
/// cross-curve sigma binding them (so the secp note's value == the Groth16-proven BJJ value).
pub struct SwapBatchReceipt {
    pub c_out_secp: [u8; 33],
    pub c_out_bjj: [u8; 32],
    pub out_xcurve_sigma: [u8; XCURVE_SIGMA_LEN],
}

/// A parsed T_SWAP_BATCH (0x2F) envelope — the fields the reflection needs to (a) re-derive the
/// Groth16 public signals, (b) verify aggregate conservation + advance reserves, and (c) onboard each
/// receipt's secp note. Mirrors the worker `decodeTSwapBatchPayload` wire format (worker/src/index.js
/// §"T_SWAP_BATCH decoder"). The v1 wire format has NO optional block (spec/amm/wire-formats.md: the reserved
/// space is for a future exclusion-claim amendment), so the layout is fixed.
/// `R_net_*`, tip commitments, per-intent secp/auth fields, and the settler meta-URI are validated for
/// length but not surfaced — the pre-reserves come from the registry and intent auth is the settler's job;
/// the reflection only needs conservation + onboarding inputs.
pub struct SwapBatchEnvelope {
    pub asset_a: [u8; 32],
    pub asset_b: [u8; 32],
    pub n_intents: usize,
    pub delta_a_net_sign: u8, // 0 = reserve_a grows by mag, 1 = reserve_a shrinks by mag
    pub delta_a_net_mag: u64,
    pub delta_b_net_sign: u8,
    pub delta_b_net_mag: u64,
    pub r_net_a: [u8; 32], // published net-blinding residue for asset A (the aggregate identity's RHS = R_net_A·G)
    pub r_net_b: [u8; 32],
    pub fee_bps: u16,
    pub tip_a_amount: u64,
    pub tip_b_amount: u64,
    pub tip_a_c_secp: [u8; 33], // per-asset settler-tip commitments (subtracted in the aggregate identity)
    pub tip_b_c_secp: [u8; 33],
    pub r_tip_a: [u8; 32], // openings bind tip_*_c_secp = tip_*_amount·H + r_tip_*·G
    pub r_tip_b: [u8; 32],
    pub intents: Vec<SwapBatchIntent>,
    pub receipts: Vec<SwapBatchReceipt>,
    pub proof: Vec<u8>,
}

const SWAP_BATCH_N_MAX: usize = 16;
const SWAP_BATCH_INTENT_LEN: usize = 1 + 33 + 33 + 32 + XCURVE_SIGMA_LEN + 8 + 8 + 4 + 64; // 352
const SWAP_BATCH_RECEIPT_LEN: usize = 33 + 32 + XCURVE_SIGMA_LEN; // 234

/// Decode a 9-byte signed-u64 (`sign(1) ∈ {0,1} ‖ magnitude LE(8)`); mirrors the worker `_signedU64Decode`.
fn parse_signed_u64(b: &[u8]) -> Option<(u8, u64)> {
    if b.len() < 9 || (b[0] != 0 && b[0] != 1) {
        return None;
    }
    Some((b[0], u64::from_le_bytes(b[1..9].try_into().ok()?)))
}

/// Parse a `T_SWAP_BATCH` (0x2F, batched uniform-clearing settlement). Returns None on any
/// malformed/truncated/over-long envelope (fail-closed). See `SwapBatchEnvelope`.
pub fn parse_swap_batch_envelope(env: &[u8]) -> Option<SwapBatchEnvelope> {
    if env.first().copied()? != 0x2F {
        return None;
    }
    let take = |p: &mut usize, n: usize| -> Option<()> {
        let end = p.checked_add(n)?;
        if end > env.len() {
            return None;
        }
        *p = end;
        Some(())
    };
    let mut p = 1usize;
    let a0 = p;
    take(&mut p, 32)?;
    let asset_a: [u8; 32] = env[a0..a0 + 32].try_into().ok()?;
    let b0 = p;
    take(&mut p, 32)?;
    let asset_b: [u8; 32] = env[b0..b0 + 32].try_into().ok()?;
    let n0 = p;
    take(&mut p, 1)?;
    let n_intents = env[n0] as usize;
    if n_intents < 1 || n_intents > SWAP_BATCH_N_MAX {
        return None;
    }
    let da0 = p;
    take(&mut p, 9)?;
    let (delta_a_net_sign, delta_a_net_mag) = parse_signed_u64(&env[da0..da0 + 9])?;
    let db0 = p;
    take(&mut p, 9)?;
    let (delta_b_net_sign, delta_b_net_mag) = parse_signed_u64(&env[db0..db0 + 9])?;
    let rna = p;
    take(&mut p, 32)?; // R_net_A (the aggregate identity's RHS residue; pre-reserves come from the registry)
    let r_net_a: [u8; 32] = env[rna..rna + 32].try_into().ok()?;
    let rnb = p;
    take(&mut p, 32)?; // R_net_B
    let r_net_b: [u8; 32] = env[rnb..rnb + 32].try_into().ok()?;
    let f0 = p;
    take(&mut p, 2)?;
    let fee_bps = u16::from_le_bytes(env[f0..f0 + 2].try_into().ok()?);
    let ta0 = p;
    take(&mut p, 8)?;
    let tip_a_amount = u64::from_le_bytes(env[ta0..ta0 + 8].try_into().ok()?);
    let tb0 = p;
    take(&mut p, 8)?;
    let tip_b_amount = u64::from_le_bytes(env[tb0..tb0 + 8].try_into().ok()?);
    let tac = p;
    take(&mut p, 33)?;
    let tip_a_c_secp: [u8; 33] = env[tac..tac + 33].try_into().ok()?;
    let tbc = p;
    take(&mut p, 33)?;
    let tip_b_c_secp: [u8; 33] = env[tbc..tbc + 33].try_into().ok()?;
    let rta = p;
    take(&mut p, 32)?;
    let r_tip_a: [u8; 32] = env[rta..rta + 32].try_into().ok()?;
    let rtb = p;
    take(&mut p, 32)?;
    let r_tip_b: [u8; 32] = env[rtb..rtb + 32].try_into().ok()?;
    // No optional block in v1 (spec/amm/wire-formats.md).
    let mut intents = Vec::with_capacity(n_intents);
    for _ in 0..n_intents {
        let s = p;
        take(&mut p, SWAP_BATCH_INTENT_LEN)?;
        let direction = env[s];
        if direction != 0 && direction != 1 {
            return None;
        }
        let c_in_secp: [u8; 33] = env[s + 34..s + 67].try_into().ok()?; // after direction(1), trader_pubkey(33)
        let bjj = s + 1 + 33 + 33; // = s+67, after direction, trader_pubkey, c_in_secp
        let c_in_bjj: [u8; 32] = env[bjj..bjj + 32].try_into().ok()?;
        let mo = bjj + 32 + XCURVE_SIGMA_LEN; // after c_in_bjj, in_xcurve_sigma
        let min_out = u64::from_le_bytes(env[mo..mo + 8].try_into().ok()?);
        let tip_amount = u64::from_le_bytes(env[mo + 8..mo + 16].try_into().ok()?);
        intents.push(SwapBatchIntent { direction, c_in_secp, c_in_bjj, min_out, tip_amount });
    }
    let mut receipts = Vec::with_capacity(n_intents);
    for _ in 0..n_intents {
        let s = p;
        take(&mut p, SWAP_BATCH_RECEIPT_LEN)?;
        receipts.push(SwapBatchReceipt {
            c_out_secp: env[s..s + 33].try_into().ok()?,
            c_out_bjj: env[s + 33..s + 65].try_into().ok()?,
            out_xcurve_sigma: env[s + 65..s + 65 + XCURVE_SIGMA_LEN].try_into().ok()?,
        });
    }
    let pl = p;
    take(&mut p, 2)?;
    let proof_len = u16::from_le_bytes(env[pl..pl + 2].try_into().ok()?) as usize;
    let pr = p;
    take(&mut p, proof_len)?;
    let proof = env[pr..pr + proof_len].to_vec();
    let sl = p;
    take(&mut p, 1)?;
    take(&mut p, env[sl] as usize)?; // settler_meta_uri (informational)
    if p != env.len() {
        return None; // trailing bytes ⇒ malformed
    }
    Some(SwapBatchEnvelope {
        asset_a,
        asset_b,
        n_intents,
        delta_a_net_sign,
        delta_a_net_mag,
        delta_b_net_sign,
        delta_b_net_mag,
        r_net_a,
        r_net_b,
        fee_bps,
        tip_a_amount,
        tip_b_amount,
        tip_a_c_secp,
        tip_b_c_secp,
        r_tip_a,
        r_tip_b,
        intents,
        receipts,
        proof,
    })
}

/// One hop of a `T_SWAP_ROUTE` (0x33): a single-pool leg with PUBLIC pre-reserves + net deltas (no
/// commitments — intermediate assets flow pool-to-pool, never minted as notes). Mirrors the worker
/// 67-byte hop block.
#[derive(Clone)]
pub struct SwapRouteHop {
    pub pool_id: [u8; 32],
    pub direction: u8, // 0 = A→B, 1 = B→A
    pub r_a_pre: u64,
    pub r_b_pre: u64,
    pub delta_a_net_mag: u64,
    pub delta_b_net_mag: u64,
}

/// A parsed `T_SWAP_ROUTE` (0x33) — atomic multi-hop AMM routing. The trader pays one input note into
/// hop 0 and receives ONE receipt note of the final hop's output asset (public `r_receipt`, exactly like
/// `T_SWAP_VAR` — Track B, no circuit). Mirrors the worker `decodeTSwapRoutePayload`. `min_out`, expiry,
/// trader pubkey, the range proof, and intent_sig are validated for length but not surfaced.
#[derive(Clone)]
pub struct SwapRouteEnvelope {
    pub n_hops: usize,
    pub trader_input_asset: [u8; 32],
    pub trader_output_asset: [u8; 32],
    pub hops: Vec<SwapRouteHop>,
    pub c_in: [u8; 33],      // the trader's spent input note (kernel-bound to hop 0's input amount)
    pub c_receipt: [u8; 33], // the final output note to onboard
    pub r_receipt: [u8; 32], // PUBLIC blinding: C_receipt opens to the final output amount under it
    pub kernel_sig: [u8; 64],
}

const SWAP_ROUTE_N_HOPS_MAX: usize = 4;
const SWAP_ROUTE_HOP_LEN: usize = 32 + 1 + 2 + 8 + 8 + 8 + 8; // 67

/// Parse a `T_SWAP_ROUTE` (0x33). Returns None on any malformed/truncated/over-long envelope (fail-closed).
pub fn parse_swap_route_envelope(env: &[u8]) -> Option<SwapRouteEnvelope> {
    if env.first().copied()? != 0x33 {
        return None;
    }
    let take = |p: &mut usize, n: usize| -> Option<()> {
        let end = p.checked_add(n)?;
        if end > env.len() {
            return None;
        }
        *p = end;
        Some(())
    };
    let mut p = 1usize;
    let nh0 = p;
    take(&mut p, 1)?;
    let n_hops = env[nh0] as usize;
    if n_hops < 2 || n_hops > SWAP_ROUTE_N_HOPS_MAX {
        return None;
    }
    let ia = p;
    take(&mut p, 32)?;
    let trader_input_asset: [u8; 32] = env[ia..ia + 32].try_into().ok()?;
    let oa = p;
    take(&mut p, 32)?;
    let trader_output_asset: [u8; 32] = env[oa..oa + 32].try_into().ok()?;
    if trader_input_asset == trader_output_asset {
        return None; // a route must change asset
    }
    take(&mut p, 8 + 4 + 33)?; // min_out, expiry_height, trader_pubkey
    let mut hops = Vec::with_capacity(n_hops);
    for _ in 0..n_hops {
        let s = p;
        take(&mut p, SWAP_ROUTE_HOP_LEN)?;
        let direction = env[s + 32];
        if direction != 0 && direction != 1 {
            return None;
        }
        hops.push(SwapRouteHop {
            pool_id: env[s..s + 32].try_into().ok()?,
            direction,
            // s+33: fee_bps(2) — validated by length, not needed for conservation
            r_a_pre: u64::from_le_bytes(env[s + 35..s + 43].try_into().ok()?),
            r_b_pre: u64::from_le_bytes(env[s + 43..s + 51].try_into().ok()?),
            delta_a_net_mag: u64::from_le_bytes(env[s + 51..s + 59].try_into().ok()?),
            delta_b_net_mag: u64::from_le_bytes(env[s + 59..s + 67].try_into().ok()?),
        });
    }
    take(&mut p, 32 + 4)?; // trader_input_outpoint (txid BE + vout)
    let ci = p;
    take(&mut p, 33)?;
    let c_in: [u8; 33] = env[ci..ci + 33].try_into().ok()?;
    let cr = p;
    take(&mut p, 33)?;
    let c_receipt: [u8; 33] = env[cr..cr + 33].try_into().ok()?;
    let rr = p;
    take(&mut p, 32)?;
    let r_receipt: [u8; 32] = env[rr..rr + 32].try_into().ok()?;
    let pl = p;
    take(&mut p, 2)?;
    let rp_len = u16::from_le_bytes(env[pl..pl + 2].try_into().ok()?) as usize;
    if rp_len == 0 {
        return None;
    }
    take(&mut p, rp_len)?;
    let ks = p;
    take(&mut p, 64)?;
    let kernel_sig: [u8; 64] = env[ks..ks + 64].try_into().ok()?;
    take(&mut p, 64)?; // intent_sig (settler-verified; not a conservation input)
    if p != env.len() {
        return None;
    }
    Some(SwapRouteEnvelope {
        n_hops,
        trader_input_asset,
        trader_output_asset,
        hops,
        c_in,
        c_receipt,
        r_receipt,
        kernel_sig,
    })
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
/// UNANCHORED + TXID-ONLY. Chain-linkage to the relay anchor (canonical chain) + confirmation depth are
/// the caller's relay-anchor layer — this proves "in a PoW-valid block", not "buried in the canonical
/// chain". It commits only the TXID merkle (the stripped serialization): a payload read from the Taproot
/// WITNESS is NOT bound here — the caller must additionally check `verify_witness_commitment`.
pub fn verify_tx_in_block(header: &[u8], tx_data: &[u8], tx_index: u32, txids: &[[u8; 32]]) -> Option<[u8; 32]> {
    if header.len() != 80 {
        return None;
    }
    let block_hash = double_sha256(header);
    let target = bits_to_target(header)?;
    if !be_bytes_lte(&reverse_u256(&block_hash), &target) {
        return None; // PoW
    }
    if compute_merkle_root_checked(txids)? != extract_merkle_root(header) {
        return None; // complete, header-committed tx set (checked: no duplicate-tail alias)
    }
    let txid = compute_txid(tx_data)?;
    let i = tx_index as usize;
    if i >= txids.len() || txids[i] != txid {
        return None; // tx present at the claimed index
    }
    Some(txid)
}

/// BIP141 witness commitment — prove a block's SegWit WITNESS data is consensus-committed, not just the
/// txids. The txid merkle root (verify_tx_in_block / the reflection scan) commits only the stripped
/// serialization (version+ins+outs+locktime), so a Tacit envelope read from the Taproot WITNESS
/// (extract_taproot_envelope) is NOT bound by it — a prover could keep a real txid but swap the witness
/// for a fake envelope. This binds the witness: over the block's full txs, recompute the wtxid merkle
/// root (coinbase wtxid := 0; wtxid := double_sha256(full tx incl. witness)) and check the coinbase's
/// commitment, `double_sha256(witness_root ‖ coinbase_reserved_value) == commitment`. The commitment +
/// reserved value are read from the coinbase, whose OUTPUTS are txid-committed (already proven by the
/// merkle check), so a prover can't fake "no commitment". Returns:
///   Some(true)  — a commitment is present and the provided witnesses match it (witnesses are bound);
///   Some(false) — a commitment is present but the witnesses DON'T match / were stripped (tampered or
///                 legacy-downgraded → caller MUST reject; folding zero envelopes here would silently
///                 censor a SegWit block's Taproot events while still advancing the digest);
///   None        — no commitment output at all (a genuinely non-segwit block: no witness envelopes).
pub fn verify_witness_commitment(txs: &[&[u8]]) -> Option<bool> {
    let coinbase = *txs.first()?;
    // The commitment lives in the coinbase OUTPUTS, which are txid-committed (the merkle check already
    // bound them) and thus serialization-INDEPENDENT. Detect it without trusting the SegWit marker/flag,
    // which is NOT part of the txid: a real SegWit block re-serialized in legacy form (witnesses stripped)
    // yields byte-identical txids, so gating commitment detection on the marker would let such a block pass
    // as "non-segwit" and drop every envelope. Decide segwit-ness from the OUTPUT commitment instead.
    let out_commitment = match parse_coinbase_commitment_output(coinbase) {
        Some(c) => c,
        None => return None, // no commitment output ⇒ genuinely non-segwit ⇒ no witness envelopes to fold
    };
    // A commitment output IS present ⇒ this is a SegWit block. The full witness binding requires the
    // coinbase to be SegWit-serialized with input-0's reserved-value witness; if it is stripped/legacy
    // (parse_coinbase_commitment returns None) the prover downgraded the block — hard reject.
    let (commitment, reserved) = match parse_coinbase_commitment(coinbase) {
        Some(v) => v,
        None => return Some(false), // commitment present but witness stripped/downgraded → reject
    };
    if commitment != out_commitment {
        return Some(false); // inconsistent commitment scan → reject
    }
    let mut wtxids: Vec<[u8; 32]> = Vec::with_capacity(txs.len());
    wtxids.push([0u8; 32]); // coinbase wtxid := 0 (BIP141)
    for &t in txs.iter().skip(1) {
        wtxids.push(double_sha256(t));
    }
    let witness_root = match compute_merkle_root_checked(&wtxids) {
        Some(r) => r,
        None => return Some(false), // mutated witness tree → witnesses don't bind; reject
    };
    let mut preimage = [0u8; 64];
    preimage[..32].copy_from_slice(&witness_root);
    preimage[32..].copy_from_slice(&reserved);
    Some(double_sha256(&preimage) == commitment)
}

/// Read the coinbase's BIP141 witness commitment (`6a24aa21a9ed‖<32B>`, optional trailing bytes allowed,
/// the LAST such output wins) and
/// the 32-byte witness reserved value (input 0's single witness item). Total/non-panicking on hostile
/// input — checked_add throughout, returns None on any truncation.
fn parse_coinbase_commitment(tx: &[u8]) -> Option<([u8; 32], [u8; 32])> {
    if tx.len() < 6 || tx[4] != 0x00 || tx[5] != 0x01 { return None; } // segwit marker/flag
    let mut pos = 6usize;
    let (in_count, vl) = read_varint(tx, pos)?;
    pos = pos.checked_add(vl)?;
    for _ in 0..in_count {
        pos = pos.checked_add(36)?; // prevout (txid + vout)
        let (slen, vl) = read_varint(tx, pos)?;
        pos = pos.checked_add(vl)?.checked_add(slen)?.checked_add(4)?; // scriptSig + sequence
    }
    let (out_count, vl) = read_varint(tx, pos)?;
    pos = pos.checked_add(vl)?;
    let mut commitment: Option<[u8; 32]> = None;
    for _ in 0..out_count {
        pos = pos.checked_add(8)?; // value
        let (slen, vl) = read_varint(tx, pos)?;
        pos = pos.checked_add(vl)?;
        let end = pos.checked_add(slen)?;
        if end > tx.len() { return None; }
        let s = &tx[pos..end];
        if s.len() >= 38 && s[0] == 0x6a && s[1] == 0x24 && s[2] == 0xaa && s[3] == 0x21 && s[4] == 0xa9 && s[5] == 0xed {
            commitment = Some(s[6..38].try_into().ok()?); // LAST commitment output wins (BIP141)
        }
        pos = end;
    }
    let commitment = commitment?;
    // Witness for input 0: BIP-141 mandates EXACTLY one item, the 32-byte reserved value. Rejecting any
    // extra item bars a coinbase that smuggles a Tacit envelope as a second (uncommitted) witness item.
    let (wit_count, vl) = read_varint(tx, pos)?;
    pos = pos.checked_add(vl)?;
    if wit_count != 1 { return None; }
    let (item_len, vl) = read_varint(tx, pos)?;
    pos = pos.checked_add(vl)?;
    if item_len != 32 { return None; }
    let end = pos.checked_add(32)?;
    if end > tx.len() { return None; }
    Some((commitment, tx[pos..end].try_into().ok()?))
}

/// Scan ONLY the coinbase OUTPUTS for the BIP141 witness commitment (`6a24aa21a9ed‖<32B>`, last wins),
/// independent of whether the coinbase is serialized legacy or SegWit. The outputs are identical in both
/// serializations (the witness is appended after locktime), and they are txid-committed — so this answers
/// "is this a SegWit block?" without trusting the non-committed marker/flag. Total/non-panicking; returns
/// None when there is no commitment output (a genuinely non-segwit coinbase).
fn parse_coinbase_commitment_output(tx: &[u8]) -> Option<[u8; 32]> {
    if tx.len() < 4 { return None; }
    let is_segwit = tx.len() > 5 && tx[4] == 0x00 && tx[5] == 0x01;
    let mut pos = if is_segwit { 6usize } else { 4usize }; // skip version (+ marker/flag if present)
    let (in_count, vl) = read_varint(tx, pos)?;
    pos = pos.checked_add(vl)?;
    for _ in 0..in_count {
        pos = pos.checked_add(36)?; // prevout (txid + vout)
        let (slen, vl) = read_varint(tx, pos)?;
        pos = pos.checked_add(vl)?.checked_add(slen)?.checked_add(4)?; // scriptSig + sequence
    }
    let (out_count, vl) = read_varint(tx, pos)?;
    pos = pos.checked_add(vl)?;
    let mut commitment: Option<[u8; 32]> = None;
    for _ in 0..out_count {
        pos = pos.checked_add(8)?; // value
        let (slen, vl) = read_varint(tx, pos)?;
        pos = pos.checked_add(vl)?;
        let end = pos.checked_add(slen)?;
        if end > tx.len() { return None; }
        let s = &tx[pos..end];
        if s.len() >= 38 && s[0] == 0x6a && s[1] == 0x24 && s[2] == 0xaa && s[3] == 0x21 && s[4] == 0xa9 && s[5] == 0xed {
            commitment = Some(s[6..38].try_into().ok()?); // LAST commitment output wins (BIP141)
        }
        pos = end;
    }
    commitment
}

/// Authenticate that `tx`'s WITNESS is consensus-committed in the block its txid sits in (BIP141), using
/// compact merkle PATHS rather than the full block. For the burn-deposit provenance path: the caller has
/// already proven `tx`'s txid into `txid_root` (a canonical block's txid merkle root, ∈ the provenance
/// headers) at `tx_index`. This adds the witness binding:
///   1. the same-block coinbase: its txid (index 0) must prove to the SAME `txid_root` (so the commitment
///      we read belongs to `tx`'s block, not another);
///   2. recompute the witness merkle root from `tx`'s wtxid (= dsha256(full tx)) at `tx_index` (the same
///      index it has in the txid tree; the coinbase's wtxid is 0 in this tree) via `wtxid_siblings`;
///   3. check the coinbase BIP141 commitment: dsha256(witness_root ‖ reserved) == commitment.
/// Without this, a provenance tx's Taproot envelope (CETCH supply note / CMINT) is bound only by txid
/// merkle — which strips witness — so a swapped witness with a fake envelope would pass.
pub fn verify_tx_witness_committed(
    tx: &[u8],
    tx_index: u32,
    wtxid_siblings: &[[u8; 32]],
    coinbase: &[u8],
    coinbase_txid_siblings: &[[u8; 32]],
    txid_root: &[u8; 32],
) -> Option<()> {
    // (1) the coinbase is in the same block as `tx` (its txid at index 0 proves to the same txid root).
    let coinbase_txid = compute_txid(coinbase)?;
    if &verify_merkle_path(&coinbase_txid, coinbase_txid_siblings, 0) != txid_root {
        return None;
    }
    let (commitment, reserved) = match parse_coinbase_commitment(coinbase) {
        Some(v) => v,
        None => {
            // The commitment output is txid-committed (serialization-independent). If it IS present but
            // the coinbase has no SegWit-committed input-0 witness, the prover downgraded a SegWit block
            // to legacy form to strip the witness — which would silently drop THIS tx's envelope
            // (bridge-burn / cmint provenance) via the `?` below while the digest still advances. Hard
            // reject (mirrors `verify_witness_commitment`); a genuinely non-segwit coinbase has no
            // commitment output and legitimately yields None.
            assert!(
                parse_coinbase_commitment_output(coinbase).is_none(),
                "witness-commit: coinbase downgraded (commitment output present but witness stripped)"
            );
            return None;
        }
    };
    // (2) `tx`'s wtxid is committed in the witness tree at the same index.
    let wtxid = double_sha256(tx);
    let witness_root = verify_merkle_path(&wtxid, wtxid_siblings, tx_index);
    // (3) coinbase BIP141 commitment over (witness_root ‖ reserved).
    let mut preimage = [0u8; 64];
    preimage[..32].copy_from_slice(&witness_root);
    preimage[32..].copy_from_slice(&reserved);
    if double_sha256(&preimage) == commitment { Some(()) } else { None }
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
    pos = pos.checked_add(vi_len)?;
    // Vec::new (not with_capacity(input_count)): input_count is an attacker-supplied varint, so
    // with_capacity could panic on a runaway count before the loop even bounds-checks it.
    let mut inputs = Vec::new();
    for _ in 0..input_count {
        let outpoint_end = pos.checked_add(36)?;
        if outpoint_end > tx_data.len() {
            return None;
        }
        let mut txid = [0u8; 32];
        txid.copy_from_slice(&tx_data[pos..pos + 32]);
        let vout = u32::from_le_bytes([tx_data[pos + 32], tx_data[pos + 33], tx_data[pos + 34], tx_data[pos + 35]]);
        inputs.push((txid, vout));
        pos = outpoint_end;
        let (script_len, vi_len2) = read_varint(tx_data, pos)?;
        pos = pos.checked_add(vi_len2)?.checked_add(script_len)?.checked_add(4)?; // input script + sequence(4)
    }
    Some(inputs)
}

pub fn extract_taproot_envelope(tx_data: &[u8]) -> Option<Vec<u8>> {
    if tx_data.len() < 6 || tx_data[4] != 0x00 || tx_data[5] != 0x01 { return None; }
    let mut pos = 6;
    let (input_count, vi_len) = read_varint(tx_data, pos)?;
    if input_count == 0 { return None; }
    pos = pos.checked_add(vi_len)?; // checked_add throughout: an attacker varint can't wrap pos past a bound
    for _ in 0..input_count {
        pos = pos.checked_add(36)?;
        let (script_len, vi_len) = read_varint(tx_data, pos)?;
        pos = pos.checked_add(vi_len)?.checked_add(script_len)?.checked_add(4)?;
    }
    let (output_count, vi_len) = read_varint(tx_data, pos)?;
    pos = pos.checked_add(vi_len)?;
    for _ in 0..output_count {
        pos = pos.checked_add(8)?;
        let (script_len, vi_len) = read_varint(tx_data, pos)?;
        pos = pos.checked_add(vi_len)?.checked_add(script_len)?;
    }
    let (wit_count, vi_len) = read_varint(tx_data, pos)?;
    pos = pos.checked_add(vi_len)?;
    if wit_count < 2 { return None; }
    let (item0_len, vi_len) = read_varint(tx_data, pos)?;
    pos = pos.checked_add(vi_len)?.checked_add(item0_len)?;
    let (script_len, vi_len) = read_varint(tx_data, pos)?;
    pos = pos.checked_add(vi_len)?;
    let script_end = pos.checked_add(script_len)?;
    if script_end > tx_data.len() { return None; }
    let script = &tx_data[pos..script_end];
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
    fn parse_swap_var_envelope_round_trips_and_rejects_malformed() {
        // Build a T_SWAP_VAR payload byte-for-byte per the dapp/worker wire format.
        let pool_id = [0x11u8; 32];
        let c_receipt = [0x02u8; 33];
        let r_receipt = [0x33u8; 32];
        let rp = [0xaau8; 5]; // arbitrary range proof
        let mut env = vec![0x32u8]; // opcode
        env.extend_from_slice(&pool_id);
        env.push(1u8); // direction = B→A
        env.extend_from_slice(&7000u64.to_le_bytes()); // R_A_pre
        env.extend_from_slice(&3000u64.to_le_bytes()); // R_B_pre
        env.extend_from_slice(&500u64.to_le_bytes()); // delta_in
        env.extend_from_slice(&0u64.to_le_bytes()); // delta_in_min
        env.extend_from_slice(&0u64.to_le_bytes()); // delta_in_max
        env.extend_from_slice(&990u64.to_le_bytes()); // delta_out
        env.extend_from_slice(&0u64.to_le_bytes()); // min_out
        env.extend_from_slice(&0u64.to_le_bytes()); // tip_amount
        env.push(0u8); // tip_asset
        env.extend_from_slice(&123u32.to_le_bytes()); // expiry_height
        env.extend_from_slice(&[0x04u8; 33]); // trader_pubkey
        env.extend_from_slice(&[0x05u8; 33]); // C_in_secp
        env.extend_from_slice(&[0x06u8; 33]); // C_change_or_sentinel
        env.extend_from_slice(&c_receipt); // C_receipt_secp
        env.extend_from_slice(&r_receipt); // r_receipt
        env.extend_from_slice(&(rp.len() as u16).to_le_bytes()); // rangeproof_len
        env.extend_from_slice(&rp); // range_proof
        env.extend_from_slice(&[0x07u8; 64]); // kernel_sig
        env.extend_from_slice(&[0x08u8; 64]); // intent_sig

        let p = parse_swap_var_envelope(&env).expect("well-formed swap_var parses");
        assert_eq!(p.pool_id, pool_id);
        assert_eq!(p.direction, 1);
        assert_eq!(p.r_a_pre, 7000);
        assert_eq!(p.r_b_pre, 3000);
        assert_eq!(p.delta_in, 500);
        assert_eq!(p.tip_amount, 0);
        assert_eq!(p.delta_out, 990);
        assert_eq!(p.c_in, [0x05u8; 33]);
        assert_eq!(p.c_change_or_sentinel, [0x06u8; 33]);
        assert_eq!(p.c_receipt, c_receipt);
        assert_eq!(p.r_receipt, r_receipt);
        assert_eq!(p.kernel_sig, [0x07u8; 64]);

        // wrong opcode → None
        let mut bad_op = env.clone();
        bad_op[0] = 0x2b;
        assert!(parse_swap_var_envelope(&bad_op).is_none(), "non-0x32 opcode rejected");
        // bad direction → None
        let mut bad_dir = env.clone();
        bad_dir[33] = 2;
        assert!(parse_swap_var_envelope(&bad_dir).is_none(), "direction not 0 or 1 rejected");
        // truncated before the trailing sigs → None (a swap missing its kernel/intent sig can't fold)
        let truncated = &env[..env.len() - 1];
        assert!(parse_swap_var_envelope(truncated).is_none(), "truncated envelope rejected");
    }

    #[test]
    fn parse_atomic_settlement_variants_accepted_as_cxfer() {
        // The whole atomic-settlement family (T_AXFER 0x26, T_AXFER_VAR 0x37, + BP+ 0x3C/0x3D) is
        // byte-identical to CXFER; the cxfer parser must accept each so the existing fold onboards its
        // tacit output notes (the sats legs are native-BTC, invisible to the kernel).
        let (c0, c1) = ([0x02u8; 33], [0x03u8; 33]);
        for op in [0x26u8, 0x37, 0x3C, 0x3D] {
            let mut env = vec![op];
            env.extend_from_slice(&[0xAAu8; 32]); // asset_id
            env.extend_from_slice(&[0x07u8; 64]); // kernel_sig
            env.push(2u8); // N = 2
            env.extend_from_slice(&c0); env.extend_from_slice(&[0u8; 8]);
            env.extend_from_slice(&c1); env.extend_from_slice(&[0u8; 8]);
            env.extend_from_slice(&4u16.to_le_bytes()); env.extend_from_slice(&[0xbbu8; 4]);
            let (asset, ks, commits, rp) = parse_cxfer_envelope_full(&env).unwrap_or_else(|| panic!("opcode {op:#x} parses as cxfer"));
            assert_eq!(asset, [0xAAu8; 32]);
            assert_eq!(ks, [0x07u8; 64]);
            assert_eq!(commits, vec![c0, c1]);
            assert_eq!(rp, vec![0xbbu8; 4]);
        }
        // a non-family opcode still rejects.
        let mut bad = vec![0x99u8]; bad.extend_from_slice(&[0u8; 200]);
        assert!(parse_cxfer_envelope_full(&bad).is_none(), "unknown opcode rejected");
    }

    #[test]
    fn parse_preauth_bid_exact_0x5b_round_trips() {
        // T_PREAUTH_BID (0x5B exact-fill), inline = 97; same cxfer-compatible tuple as the partial-fill bid.
        let asset = [0xCEu8; 32];
        let ks = [0x0fu8; 64];
        let out0 = [0x02u8; 33];
        let rp = [0xeeu8; 5];
        let mut env = vec![0x5Bu8];
        env.extend_from_slice(&asset);
        env.push(1u8); // asset_input_count
        env.extend_from_slice(&[0x11u8; 16]); // bid_id
        env.extend_from_slice(&[0x12u8; 33]); // recipient_pubkey
        env.extend_from_slice(&500u64.to_le_bytes()); // amount
        env.extend_from_slice(&[0x13u8; 32]); // recipient_blinding (cleartext)
        env.extend_from_slice(&100u64.to_le_bytes()); // price_sats
        env.extend_from_slice(&ks); // kernel_sig
        env.push(1u8); // N = 1 (exact fill, no seller change)
        env.extend_from_slice(&out0);
        env.extend_from_slice(&(rp.len() as u16).to_le_bytes());
        env.extend_from_slice(&rp);
        let (a, k, commits, rpout) = parse_preauth_bid_envelope(&env).expect("exact bid parses");
        assert_eq!(a, asset);
        assert_eq!(k, ks);
        assert_eq!(commits, vec![out0]);
        assert_eq!(rpout, rp.to_vec());
        // 0x5C parser must reject a 0x5B envelope (opcode-bound).
        assert!(parse_preauth_bid_var_envelope(&env).is_none(), "var parser rejects exact bid");
    }

    #[test]
    fn parse_preauth_bid_var_round_trips() {
        // Build a T_PREAUTH_BID_VAR (0x5C) per the dapp encoder, N=2 (seller change present).
        let asset = [0xCCu8; 32];
        let ks = [0x09u8; 64];
        let (out0, out1) = ([0x02u8; 33], [0x03u8; 33]); // buyer's filled note, seller's change
        let rp = [0xddu8; 6];
        let mut env = vec![0x5Cu8];
        env.extend_from_slice(&asset);
        env.push(1u8); // asset_input_count
        env.extend_from_slice(&[0x11u8; 16]); // bid_id
        env.extend_from_slice(&[0x12u8; 33]); // recipient_pubkey
        env.extend_from_slice(&100u64.to_le_bytes()); // price_per_unit
        env.extend_from_slice(&1000u64.to_le_bytes()); // max_fill
        env.extend_from_slice(&10u64.to_le_bytes()); // fill_increment
        env.extend_from_slice(&500u64.to_le_bytes()); // fill_amount
        env.extend_from_slice(&[0x13u8; 32]); // recipient_blinding (cleartext)
        env.extend_from_slice(&[0x14u8; 20]); // refund_script_hash
        env.push(8u8); // decimals_scale
        env.extend_from_slice(&ks); // kernel_sig
        env.push(2u8); // N = 2
        env.extend_from_slice(&out0); // out[0].commitment (no amount_ct)
        env.extend_from_slice(&out1); // out[1].commitment
        env.extend_from_slice(&[0u8; 8]); // out[1].amount_ct
        env.extend_from_slice(&(rp.len() as u16).to_le_bytes());
        env.extend_from_slice(&rp);

        let (a, k, commits, rpout) = parse_preauth_bid_var_envelope(&env).expect("bid parses");
        assert_eq!(a, asset, "asset");
        assert_eq!(k, ks, "kernel_sig");
        assert_eq!(commits, vec![out0, out1], "the bid's two output notes");
        assert_eq!(rpout, rp.to_vec(), "rangeproof");
        // N=1 (no seller change) also parses.
        let mut env1 = env[..233 + 33].to_vec();
        env1[232] = 1; // N = 1
        env1.extend_from_slice(&4u16.to_le_bytes()); env1.extend_from_slice(&[0xeeu8; 4]);
        let (_, _, c1only, _) = parse_preauth_bid_var_envelope(&env1).expect("N=1 bid parses");
        assert_eq!(c1only, vec![out0], "single output");
        // wrong opcode + truncated reject.
        let mut bad = env.clone(); bad[0] = 0x22;
        assert!(parse_preauth_bid_var_envelope(&bad).is_none(), "non-0x5C rejected");
        assert!(parse_preauth_bid_var_envelope(&env[..env.len() - 1]).is_none(), "truncated rejected");
    }

    #[test]
    fn parse_lp_add_round_trips() {
        let asset_a = [0xA1u8; 32];
        let asset_b = [0xB2u8; 32];
        let csc = [0x02u8; 33];
        let (ka, kb) = ([0x0au8; 64], [0x0bu8; 64]);
        let mut env = vec![0x2Du8, 1u8]; // opcode, variant = 1 (POOL_INIT)
        env.extend_from_slice(&asset_a);
        env.extend_from_slice(&asset_b);
        env.extend_from_slice(&1000u64.to_le_bytes()); // delta_a
        env.extend_from_slice(&4000u64.to_le_bytes()); // delta_b
        env.extend_from_slice(&2000u64.to_le_bytes()); // share_amount
        env.extend_from_slice(&csc); // share_c_secp
        env.extend_from_slice(&[0x03u8; 32]); // share_c_bjj
        env.extend_from_slice(&[0xccu8; 169]); // share_xcurve_sigma
        env.extend_from_slice(&ka); // kernel_sig_a
        env.extend_from_slice(&kb); // kernel_sig_b
        env.extend_from_slice(&[0xddu8; 32]); // share_r (option-a opening blinding, between header and the variant-1 tail)
        // variant-1 tail: fee_bps + vkCid + ceremonyCid + arbiter(0) + launcher(0) + pf config + meta(0) + flags.
        env.extend_from_slice(&30u16.to_le_bytes()); // fee_bps
        env.push(3); env.extend_from_slice(&[0x66u8; 3]); // vkLen + vkCid
        env.push(3); env.extend_from_slice(&[0x67u8; 3]); // cerLen + ceremonyCid
        env.push(0); env.push(0); // arbCount, arbM (no arbiter in v1)
        env.push(0); // lsigCount (no launcher sigs)
        env.extend_from_slice(&[0x02u8; 33]); // protocol_fee_address (a creator-fee pool)
        env.extend_from_slice(&25u16.to_le_bytes()); // protocol_fee_bps
        env.push(0); // metaLen (no meta uri)
        env.push(0x02); // capability_flags
        let p = parse_lp_add_envelope(&env).expect("lp_add parses");
        assert_eq!(p.variant, 1);
        assert_eq!(p.asset_a, asset_a);
        assert_eq!(p.asset_b, asset_b);
        assert_eq!((p.delta_a, p.delta_b, p.share_amount), (1000, 4000, 2000));
        assert_eq!(p.share_csecp, csc);
        assert_eq!(p.kernel_sig_a, ka);
        assert_eq!(p.kernel_sig_b, kb);
        assert_eq!(p.share_r, [0xddu8; 32]);
        assert_eq!(p.fee_bps, 30);
        assert_eq!(p.capability_flags, 0x02);
        assert_eq!(p.protocol_fee_address, [0x02u8; 33]);
        assert_eq!(p.protocol_fee_bps, 25);
        assert!(parse_lp_add_envelope(&env[..env.len() - 1]).is_none(), "truncated variant-1 tail rejected");
        // variant 0 (no fee_bps tail) — HEADER + share_r = 484 bytes.
        let mut env0 = env[..484].to_vec();
        env0[1] = 0;
        let p0 = parse_lp_add_envelope(&env0).expect("variant-0 lp_add parses");
        assert_eq!((p0.variant, p0.fee_bps), (0, 0));
        // POOL_CAP_ARBITER_AUTHORITY (0x04) is reserved + unimplemented → fail closed.
        let mut arb = env.clone();
        let last = arb.len() - 1;
        arb[last] = 0x04;
        assert!(parse_lp_add_envelope(&arb).is_none(), "reserved arbiter-authority capability rejected");
        arb[last] = 0x06; // 0x02 | 0x04 — set alongside an implemented bit, still rejected
        assert!(parse_lp_add_envelope(&arb).is_none(), "arbiter-authority bit rejected even with other bits set");
        let mut bad = env.clone(); bad[0] = 0x22;
        assert!(parse_lp_add_envelope(&bad).is_none(), "non-0x2D rejected");
    }

    #[test]
    fn parse_lp_remove_round_trips() {
        let asset_a = [0xA1u8; 32];
        let asset_b = [0xB2u8; 32];
        let (recv_a, recv_b) = ([0x02u8; 33], [0x03u8; 33]);
        let ks = [0x0cu8; 64];
        let mut env = vec![0x2Eu8];
        env.extend_from_slice(&asset_a);
        env.extend_from_slice(&asset_b);
        env.extend_from_slice(&1000u64.to_le_bytes()); // share_amount
        env.extend_from_slice(&500u64.to_le_bytes()); // delta_a
        env.extend_from_slice(&2000u64.to_le_bytes()); // delta_b
        env.extend_from_slice(&recv_a); // recv_a_secp
        env.extend_from_slice(&[0x04u8; 32]); // recv_a_bjj
        env.extend_from_slice(&[0xc1u8; 169]); // recv_a_xcurve_sigma
        env.extend_from_slice(&recv_b); // recv_b_secp
        env.extend_from_slice(&[0x05u8; 32]); // recv_b_bjj
        env.extend_from_slice(&[0xc2u8; 169]); // recv_b_xcurve_sigma
        env.extend_from_slice(&ks); // kernel_sig
        env.extend_from_slice(&[0xe1u8; 32]); // r_recv_a (option-a opening blinding, between kernel sig and proof)
        env.extend_from_slice(&[0xe2u8; 32]); // r_recv_b
        env.extend_from_slice(&4u16.to_le_bytes()); // proof_len
        env.extend_from_slice(&[0xddu8; 4]); // proof
        let p = parse_lp_remove_envelope(&env).expect("lp_remove parses");
        assert_eq!(p.asset_a, asset_a);
        assert_eq!(p.asset_b, asset_b);
        assert_eq!((p.share_amount, p.delta_a, p.delta_b), (1000, 500, 2000));
        assert_eq!(p.recv_a_secp, recv_a);
        assert_eq!(p.recv_b_secp, recv_b);
        assert_eq!(p.kernel_sig, ks);
        assert_eq!(p.r_recv_a, [0xe1u8; 32]);
        assert_eq!(p.r_recv_b, [0xe2u8; 32]);
        let mut bad = env.clone(); bad[0] = 0x22;
        assert!(parse_lp_remove_envelope(&bad).is_none(), "non-0x2E rejected");
    }

    #[test]
    fn parse_farm_init_round_trips() {
        let pool_id = [0x40u8; 32];
        let nonce = [0x41u8; 32];
        let launcher = [0x02u8; 33];
        let reward_asset = [0xAAu8; 32];
        let c_change = [0x06u8; 33];
        let (ks, lsig) = ([0x0au8; 64], [0x0bu8; 64]);
        let rp = [0xccu8; 5];
        let mut env = vec![0x34u8];
        env.extend_from_slice(&pool_id);
        env.extend_from_slice(&nonce);
        env.extend_from_slice(&launcher);
        env.extend_from_slice(&reward_asset);
        env.extend_from_slice(&1_000_000u64.to_le_bytes()); // reward_total
        env.extend_from_slice(&100u64.to_le_bytes()); // reward_per_block
        env.extend_from_slice(&500u32.to_le_bytes()); // start_height
        env.extend_from_slice(&1000u32.to_le_bytes()); // end_height
        env.extend_from_slice(&c_change);
        env.extend_from_slice(&(rp.len() as u16).to_le_bytes());
        env.extend_from_slice(&rp);
        env.extend_from_slice(&ks);
        env.extend_from_slice(&lsig);
        let p = parse_farm_init_envelope(&env).expect("farm_init parses");
        assert_eq!(p.pool_id, pool_id);
        assert_eq!(p.farm_nonce, nonce);
        assert_eq!(p.launcher_pubkey, launcher);
        assert_eq!(p.reward_asset, reward_asset);
        assert_eq!(p.reward_total, 1_000_000);
        assert_eq!(p.reward_per_block, 100);
        assert_eq!(p.c_change_or_sentinel, c_change);
        assert_eq!(p.kernel_sig, ks);
        let mut bad = env.clone(); bad[0] = 0x22;
        assert!(parse_farm_init_envelope(&bad).is_none(), "non-0x34 rejected");
    }

    // SPEC-CONTROLLER-VAULT-AMENDMENT §8.4: the TRUSTLESS fold extracts the accumulator-per-share fields the
    // EXISTING bond/harvest envelopes already carry (the reflection now validates them via FarmRewardState).
    #[test]
    fn parse_lp_bond_and_harvest_fields_round_trip() {
        // T_LP_BOND (0x35) fixed prefix: farm_id ‖ bonder_pubkey(33) ‖ bond_amount(8) ‖ entry_acc(16) ‖ view_h(4)
        let farm = [0x77u8; 32];
        let bonder = [0x03u8; 33];
        let mut bond = vec![0x35u8];
        bond.extend_from_slice(&farm);
        bond.extend_from_slice(&bonder);
        bond.extend_from_slice(&1234u64.to_le_bytes());
        bond.extend_from_slice(&987654321u128.to_le_bytes());
        bond.extend_from_slice(&42u32.to_le_bytes());
        bond.extend_from_slice(&[0u8; 50]); // c_change + rp + sigs tail (ignored by the prefix parser)
        let (f, bp, amt, entry, vh) = parse_lp_bond_fields(&bond).expect("bond fields");
        assert_eq!((f, bp, amt, entry, vh), (farm, bonder, 1234, 987654321u128, 42));

        // T_LP_HARVEST (0x3B, 346): …reward(8) ‖ reward_r(32) ‖ owner(32) ‖ old_nonce(32) ‖ new_nonce(32) ‖ shares(8) ‖ rps_entry(16) ‖ sig(64)
        let reward_r = [0x66u8; 32];
        let owner = [0x71u8; 32];
        let old_nonce = [0x72u8; 32];
        let new_nonce = [0x73u8; 32];
        let hsig = [0x07u8; 64];
        let mut h = vec![0x3Bu8];
        h.extend_from_slice(&farm);
        h.extend_from_slice(&[0x55u8; 36]); // bond_id
        h.extend_from_slice(&[0x04u8; 33]); // harvester_pubkey
        h.extend_from_slice(&555_000u128.to_le_bytes()); // exit_acc_per_share
        h.extend_from_slice(&99u32.to_le_bytes()); // exit_view_height
        h.extend_from_slice(&777u64.to_le_bytes()); // reward_amount
        h.extend_from_slice(&reward_r);
        h.extend_from_slice(&owner);
        h.extend_from_slice(&old_nonce);
        h.extend_from_slice(&new_nonce);
        h.extend_from_slice(&321u64.to_le_bytes()); // shares
        h.extend_from_slice(&555_000u128.to_le_bytes()); // rps_entry
        h.extend_from_slice(&hsig);
        assert_eq!(h.len(), 346);
        let (hf, hrew, hrr, ho, hon, hnn, hsh, hrps, hs) =
            parse_lp_harvest_envelope(&h).expect("harvest fields");
        assert_eq!((hf, hrew, hrr, ho, hon, hnn, hsh, hrps, hs),
            (farm, 777, reward_r, owner, old_nonce, new_nonce, 321, 555_000u128, hsig));

        // T_LP_UNBOND (0x36, 217): farm_id ‖ owner(32) ‖ nonce(32) ‖ shares(8) ‖ rps_entry(16) ‖ lp_return_r(32) ‖ sig(64)
        let unonce = [0x82u8; 32];
        let lp_return_r = [0x83u8; 32];
        let usig = [0x09u8; 64];
        let mut u = vec![0x36u8];
        u.extend_from_slice(&farm);
        u.extend_from_slice(&owner);
        u.extend_from_slice(&unonce);
        u.extend_from_slice(&1234u64.to_le_bytes());
        u.extend_from_slice(&987u128.to_le_bytes()); // rps_entry
        u.extend_from_slice(&lp_return_r);
        u.extend_from_slice(&usig);
        assert_eq!(u.len(), 217);
        let (uf, uo, un, ush, urps, ulr, us) = parse_lp_unbond_fields(&u).expect("unbond fields");
        assert_eq!((uf, uo, un, ush, urps, ulr, us), (farm, owner, unonce, 1234, 987u128, lp_return_r, usig));
        u[0] = 0x37; // wrong opcode folds nothing
        assert!(parse_lp_unbond_fields(&u).is_none());
    }

    #[test]
    fn parse_lp_harvest_round_trips() {
        let farm_id = [0x40u8; 32];
        let reward_r = [0x33u8; 32];
        let mut env = vec![0x3Bu8];
        env.extend_from_slice(&farm_id);
        env.extend_from_slice(&[0x11u8; 36]); // bond_id
        env.extend_from_slice(&[0x02u8; 33]); // harvester_pubkey
        env.extend_from_slice(&[0x12u8; 16]); // exit_acc_per_share
        env.extend_from_slice(&5u32.to_le_bytes()); // exit_view_height
        env.extend_from_slice(&777u64.to_le_bytes()); // reward_amount
        env.extend_from_slice(&reward_r);
        env.extend_from_slice(&[0x71u8; 32]); // owner
        env.extend_from_slice(&[0x72u8; 32]); // old_nonce
        env.extend_from_slice(&[0x73u8; 32]); // new_nonce
        env.extend_from_slice(&321u64.to_le_bytes()); // shares
        env.extend_from_slice(&5u128.to_le_bytes()); // rps_entry
        env.extend_from_slice(&[0x0cu8; 64]); // harvester_sig
        assert_eq!(env.len(), 346);
        let (fid, amt, r, ..) = parse_lp_harvest_envelope(&env).expect("harvest parses");
        assert_eq!(fid, farm_id);
        assert_eq!(amt, 777);
        assert_eq!(r, reward_r);
        assert!(parse_lp_harvest_envelope(&env[..345]).is_none(), "wrong length rejected");
        let mut bad = env.clone(); bad[0] = 0x22;
        assert!(parse_lp_harvest_envelope(&bad).is_none(), "non-0x3B rejected");
    }

    #[test]
    fn parse_farm_refund_round_trips() {
        let farm_id = [0x40u8; 32];
        let refund_r = [0x35u8; 32];
        let mut env = vec![0x3Eu8];
        env.extend_from_slice(&farm_id);
        env.extend_from_slice(&[0x02u8; 33]); // launcher_pubkey
        env.extend_from_slice(&888u64.to_le_bytes()); // refund_amount
        env.extend_from_slice(&7u32.to_le_bytes()); // refund_view_height
        env.extend_from_slice(&refund_r);
        env.extend_from_slice(&[0x0du8; 64]); // launcher_sig
        assert_eq!(env.len(), 174);
        let (fid, amt, r) = parse_farm_refund_envelope(&env).expect("farm_refund parses");
        assert_eq!(fid, farm_id);
        assert_eq!(amt, 888);
        assert_eq!(r, refund_r);
        assert!(parse_farm_refund_envelope(&env[..173]).is_none(), "wrong length rejected");
        let mut bad = env.clone(); bad[0] = 0x3B;
        assert!(parse_farm_refund_envelope(&bad).is_none(), "non-0x3E rejected");
    }

    #[test]
    fn parse_protocol_fee_claim_round_trips() {
        let pool_id = [0x40u8; 32];
        let claim_c = [0x05u8; 33];
        let claim_blinding = [0x44u8; 32];
        let mut env = vec![0x31u8];
        env.extend_from_slice(&pool_id);
        env.extend_from_slice(&[0x02u8; 32]); // claimer_pubkey_x_only
        env.extend_from_slice(&777u64.to_le_bytes()); // claim_amount
        env.extend_from_slice(&claim_c);
        env.extend_from_slice(&claim_blinding);
        env.extend_from_slice(&[0x0cu8; 64]); // claim_sig
        assert_eq!(env.len(), 202);
        let (pid, amt, c, r) = parse_protocol_fee_claim_envelope(&env).expect("claim parses");
        assert_eq!(pid, pool_id);
        assert_eq!(amt, 777);
        assert_eq!(c, claim_c);
        assert_eq!(r, claim_blinding);
        assert!(parse_protocol_fee_claim_envelope(&env[..201]).is_none(), "wrong length rejected");
        let mut bad = env.clone(); bad[0] = 0x3E;
        assert!(parse_protocol_fee_claim_envelope(&bad).is_none(), "non-0x31 rejected");
    }

    #[test]
    fn parse_swap_batch_round_trips_and_fails_closed() {
        // Synthetic T_SWAP_BATCH (0x2F), no arbiter, n_intents = 1 — mirrors the worker wire format.
        let mut env = vec![0x2Fu8];
        env.extend_from_slice(&[0xAAu8; 32]); // assetA
        env.extend_from_slice(&[0xBBu8; 32]); // assetB
        env.push(1); // n_intents
        env.push(0); env.extend_from_slice(&1000u64.to_le_bytes()); // delta_A_net: +1000
        env.push(1); env.extend_from_slice(&1992u64.to_le_bytes()); // delta_B_net: -1992
        env.extend_from_slice(&[0x10u8; 32]); // R_net_A
        env.extend_from_slice(&[0x11u8; 32]); // R_net_B
        env.extend_from_slice(&30u16.to_le_bytes()); // fee_bps
        env.extend_from_slice(&0u64.to_le_bytes()); // tip_A_amount
        env.extend_from_slice(&0u64.to_le_bytes()); // tip_B_amount
        env.extend_from_slice(&[0x21u8; 33]); // tip_A_C_secp
        env.extend_from_slice(&[0x22u8; 33]); // tip_B_C_secp
        env.extend_from_slice(&[0x23u8; 32]); // r_tip_A
        env.extend_from_slice(&[0x24u8; 32]); // r_tip_B
        // intent[0] (352 bytes)
        env.push(0); // direction = A→B
        env.extend_from_slice(&[0x02u8; 33]); // trader_pubkey
        env.extend_from_slice(&[0x03u8; 33]); // c_in_secp
        env.extend_from_slice(&[0x44u8; 32]); // c_in_bjj
        env.extend_from_slice(&[0xc1u8; XCURVE_SIGMA_LEN]); // in_xcurve_sigma
        env.extend_from_slice(&500u64.to_le_bytes()); // min_out
        env.extend_from_slice(&0u64.to_le_bytes()); // tip_amount
        env.extend_from_slice(&100u32.to_le_bytes()); // expiry_height
        env.extend_from_slice(&[0x0cu8; 64]); // intent_sig
        // receipt[0] (234 bytes)
        env.extend_from_slice(&[0x05u8; 33]); // c_out_secp
        env.extend_from_slice(&[0x55u8; 32]); // c_out_bjj
        env.extend_from_slice(&[0xc2u8; XCURVE_SIGMA_LEN]); // out_xcurve_sigma
        env.extend_from_slice(&4u16.to_le_bytes()); // proof_len
        env.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef]); // proof
        env.push(0); // settler_meta_uri_len
        assert_eq!(env.len(), 889, "synthetic 0x2F envelope length");

        let p = parse_swap_batch_envelope(&env).expect("swap_batch parses");
        assert_eq!(p.asset_a, [0xAAu8; 32]);
        assert_eq!(p.asset_b, [0xBBu8; 32]);
        assert_eq!(p.n_intents, 1);
        assert_eq!((p.delta_a_net_sign, p.delta_a_net_mag), (0, 1000));
        assert_eq!((p.delta_b_net_sign, p.delta_b_net_mag), (1, 1992));
        assert_eq!(p.fee_bps, 30);
        assert_eq!((p.tip_a_amount, p.tip_b_amount), (0, 0));
        assert_eq!(p.r_net_a, [0x10u8; 32]);
        assert_eq!(p.r_net_b, [0x11u8; 32]);
        assert_eq!(p.tip_a_c_secp, [0x21u8; 33]);
        assert_eq!(p.tip_b_c_secp, [0x22u8; 33]);
        assert_eq!(p.r_tip_a, [0x23u8; 32]);
        assert_eq!(p.r_tip_b, [0x24u8; 32]);
        assert_eq!(p.intents.len(), 1);
        assert_eq!(p.intents[0].direction, 0);
        assert_eq!(p.intents[0].c_in_secp, [0x03u8; 33]);
        assert_eq!(p.intents[0].c_in_bjj, [0x44u8; 32]);
        assert_eq!(p.intents[0].min_out, 500);
        assert_eq!(p.intents[0].tip_amount, 0);
        assert_eq!(p.receipts.len(), 1);
        assert_eq!(p.receipts[0].c_out_secp, [0x05u8; 33]);
        assert_eq!(p.receipts[0].c_out_bjj, [0x55u8; 32]);
        assert_eq!(p.receipts[0].out_xcurve_sigma, [0xc2u8; XCURVE_SIGMA_LEN]);
        assert_eq!(p.proof, vec![0xde, 0xad, 0xbe, 0xef]);

        // fail-closed: wrong opcode, truncation, trailing byte, bad n.
        let mut bad = env.clone(); bad[0] = 0x22;
        assert!(parse_swap_batch_envelope(&bad).is_none(), "non-0x2F rejected");
        assert!(parse_swap_batch_envelope(&env[..env.len() - 1]).is_none(), "truncation rejected");
        let mut long = env.clone(); long.push(0x00);
        assert!(parse_swap_batch_envelope(&long).is_none(), "trailing byte rejected");
        let mut zero_n = env.clone(); zero_n[65] = 0;
        assert!(parse_swap_batch_envelope(&zero_n).is_none(), "n_intents = 0 rejected");
    }

    #[test]
    fn parse_swap_route_round_trips_and_fails_closed() {
        // Synthetic T_SWAP_ROUTE (0x33), 2 hops — mirrors the worker wire format.
        let mut env = vec![0x33u8];
        env.push(2); // n_hops
        env.extend_from_slice(&[0xAAu8; 32]); // trader_input_asset
        env.extend_from_slice(&[0xBBu8; 32]); // trader_output_asset
        env.extend_from_slice(&100u64.to_le_bytes()); // min_out
        env.extend_from_slice(&50u32.to_le_bytes()); // expiry_height
        env.extend_from_slice(&[0x02u8; 33]); // trader_pubkey
        // hop 0
        env.extend_from_slice(&[0x11u8; 32]); env.push(0); env.extend_from_slice(&30u16.to_le_bytes());
        env.extend_from_slice(&10_000u64.to_le_bytes()); env.extend_from_slice(&5_000u64.to_le_bytes());
        env.extend_from_slice(&1000u64.to_le_bytes()); env.extend_from_slice(&480u64.to_le_bytes());
        // hop 1
        env.extend_from_slice(&[0x22u8; 32]); env.push(0); env.extend_from_slice(&30u16.to_le_bytes());
        env.extend_from_slice(&8_000u64.to_le_bytes()); env.extend_from_slice(&3_000u64.to_le_bytes());
        env.extend_from_slice(&480u64.to_le_bytes()); env.extend_from_slice(&230u64.to_le_bytes());
        env.extend_from_slice(&[0x77u8; 32]); env.extend_from_slice(&1u32.to_le_bytes()); // trader_input_outpoint
        env.extend_from_slice(&[0x03u8; 33]); // c_in_secp
        env.extend_from_slice(&[0x05u8; 33]); // c_receipt_secp
        env.extend_from_slice(&[0x44u8; 32]); // r_receipt
        env.extend_from_slice(&3u16.to_le_bytes()); env.extend_from_slice(&[0xaa, 0xbb, 0xcc]); // rangeProof
        env.extend_from_slice(&[0x0cu8; 64]); // kernel_sig
        env.extend_from_slice(&[0x0du8; 64]); // intent_sig
        assert_eq!(env.len(), 512, "synthetic 0x33 envelope length");

        let p = parse_swap_route_envelope(&env).expect("swap_route parses");
        assert_eq!(p.n_hops, 2);
        assert_eq!(p.trader_input_asset, [0xAAu8; 32]);
        assert_eq!(p.trader_output_asset, [0xBBu8; 32]);
        assert_eq!(p.hops.len(), 2);
        assert_eq!(p.hops[0].pool_id, [0x11u8; 32]);
        assert_eq!(p.hops[0].direction, 0);
        assert_eq!((p.hops[0].r_a_pre, p.hops[0].r_b_pre), (10_000, 5_000));
        assert_eq!((p.hops[0].delta_a_net_mag, p.hops[0].delta_b_net_mag), (1000, 480));
        assert_eq!(p.hops[1].pool_id, [0x22u8; 32]);
        assert_eq!((p.hops[1].delta_a_net_mag, p.hops[1].delta_b_net_mag), (480, 230));
        assert_eq!(p.c_in, [0x03u8; 33]);
        assert_eq!(p.c_receipt, [0x05u8; 33]);
        assert_eq!(p.r_receipt, [0x44u8; 32]);
        assert_eq!(p.kernel_sig, [0x0cu8; 64]);

        // fail-closed: wrong opcode, truncation, trailing byte, n_hops < 2, input==output asset, zero range proof.
        let mut bad = env.clone(); bad[0] = 0x22;
        assert!(parse_swap_route_envelope(&bad).is_none(), "non-0x33 rejected");
        assert!(parse_swap_route_envelope(&env[..env.len() - 1]).is_none(), "truncation rejected");
        let mut long = env.clone(); long.push(0);
        assert!(parse_swap_route_envelope(&long).is_none(), "trailing byte rejected");
        let mut one_hop = env.clone(); one_hop[1] = 1;
        assert!(parse_swap_route_envelope(&one_hop).is_none(), "n_hops < 2 rejected");
        let mut same = env.clone(); same[34..66].copy_from_slice(&[0xAAu8; 32]); // output asset = input asset
        assert!(parse_swap_route_envelope(&same).is_none(), "input==output asset rejected");
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

        let (asset, etch, commitment, amount_ct, rp, isig) = parse_cmint(&env).expect("cmint");
        assert_eq!(asset, [0xAA; 32]);
        assert_eq!(etch, [0xEE; 32]);
        assert_eq!(commitment, comm);
        assert_eq!(amount_ct, [0u8; 8]);
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
        // A T_PETCH (0x27) references its metadata blob by `image_uri` at the envelope TAIL — after the
        // cap/limit/height fair-mint terms — NOT inline (matches the dapp `encodeCPetchPayload` / worker
        // `decodeCPetchPayload` wire format). parse_etch_meta resolves the cid from it via the same
        // raw-CIDv1 path a CETCH uses, so both etch shapes yield an identical Ethereum contractURI.
        let petch_uri = b"ipfs://bafkreig7m5j66zlaewjvo6bipk723udgdhnyl7ve5k2suofuvhi2mmb3ai";
        let mut payload = vec![0x27u8, 0x03, b'T', b'A', b'C', 0x08];
        payload.extend_from_slice(&[0u8; 8]); // cap
        payload.extend_from_slice(&[0u8; 8]); // limit
        payload.extend_from_slice(&[0u8; 4]); // start_h
        payload.extend_from_slice(&[0u8; 4]); // end_h
        payload.extend_from_slice(&[(petch_uri.len() & 0xff) as u8, ((petch_uri.len() >> 8) & 0xff) as u8]); // img_len LE
        payload.extend_from_slice(petch_uri);
        let tx = build_reveal_tx(&payload);
        let env = extract_taproot_envelope(&tx).expect("etch envelope");
        let (ticker, tlen, decimals, cid) = parse_etch_meta(&env).expect("etch meta");
        assert_eq!(&ticker[..tlen as usize], b"TAC", "ticker");
        assert_eq!(decimals, 8, "decimals");
        assert_eq!(
            hex::encode(cid),
            "df6753ef656025935778287abfadd06619db85fea4eab52a38b4a9d1a6303b02",
            "T_PETCH image_uri (raw CIDv1) → its 32-byte content digest"
        );

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

        // CETCH (0x21) carries the supply commitment after decimals, NOT a cid — a SHORT CETCH (no
        // trailing image_uri) must resolve cid = 0, never the commitment bytes (the garbage-cid fix).
        let mut cetch = vec![0x21u8, 0x03, b'T', b'A', b'C', 0x08];
        cetch.extend_from_slice(&[0x99u8; 33]); // supply commitment (must NOT be read as a cid)
        let cenv = extract_taproot_envelope(&build_reveal_tx(&cetch)).expect("cetch envelope");
        let (_, _, _, ccid) = parse_etch_meta(&cenv).expect("CETCH parses via parse_etch_meta");
        assert_eq!(ccid, [0u8; 32], "short CETCH (no image_uri) → cid = 0");

        // A FULL CETCH references its metadata blob by `image_uri`; parse_etch_meta resolves the cid from
        // it (raw CIDv1) so a bridged CETCH (TAC) gets the same trustless contractURI a T_PETCH would.
        // KAT: TAC's live image_uri decodes to this 32-byte digest (mirrored in
        // tests/confidential-canonical-asset-id.mjs; reconstructs to ipfs://f01551220‖hex on Ethereum).
        let build_cetch = |uri: &[u8]| -> Vec<u8> {
            let mut e = vec![0x21u8, 0x03, b'T', b'A', b'C', 0x08];
            e.extend_from_slice(&[0x02u8; 33]); // commitment C_0
            e.extend_from_slice(&[0u8; 8]); // amount_ct
            e.extend_from_slice(&[0u8, 0u8]); // rp_len = 0 (empty rangeproof)
            e.extend_from_slice(&[0u8; 32]); // mint_authority = 0 (fixed supply)
            e.extend_from_slice(&[(uri.len() & 0xff) as u8, ((uri.len() >> 8) & 0xff) as u8]); // img_len LE
            e.extend_from_slice(uri);
            e
        };
        let tac_uri = b"ipfs://bafkreig7m5j66zlaewjvo6bipk723udgdhnyl7ve5k2suofuvhi2mmb3ai";
        let tenv = extract_taproot_envelope(&build_reveal_tx(&build_cetch(tac_uri))).expect("tac cetch env");
        let (_, _, _, tcid) = parse_etch_meta(&tenv).expect("full CETCH parses");
        assert_eq!(
            hex::encode(tcid),
            "df6753ef656025935778287abfadd06619db85fea4eab52a38b4a9d1a6303b02",
            "CETCH image_uri (raw CIDv1) → its 32-byte content digest (TAC live KAT)"
        );

        // Non-raw / non-ipfs image_uris are NOT surfaced (they cannot round-trip the f01551220 form) →
        // cid 0, so the harmonization never mispoints a contractURI to a re-encoded object.
        let dagpb = b"ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"; // dag-pb (0x70)
        let denv = extract_taproot_envelope(&build_reveal_tx(&build_cetch(dagpb))).expect("dagpb cetch env");
        assert_eq!(parse_etch_meta(&denv).unwrap().3, [0u8; 32], "dag-pb CIDv1 → cid 0 (only raw 0x55 surfaced)");
        let https = b"https://example.com/meta.json";
        let henv = extract_taproot_envelope(&build_reveal_tx(&build_cetch(https))).expect("https cetch env");
        assert_eq!(parse_etch_meta(&henv).unwrap().3, [0u8; 32], "non-ipfs image_uri → cid 0");
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

        // X-03: a SEGWIT tx whose STRIPPED serialization is exactly 64 bytes must also be rejected — that is
        // the preimage consensus bars, even though the FULL (witness-bearing) length differs. 1 empty-scriptSig
        // input + 1 output with a 4-byte script: stripped = version(4) + 58 + locktime(4) = 64.
        let mut sw = vec![0x02u8, 0, 0, 0, 0x00, 0x01, 0x01]; // version, marker, flag, in_count=1
        sw.extend_from_slice(&[0u8; 36]); // prevout
        sw.push(0x00); // scriptSig len 0
        sw.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // sequence
        sw.push(0x01); // out_count=1
        sw.extend_from_slice(&[0u8; 8]); // value
        sw.push(0x04);
        sw.extend_from_slice(&[0x51, 0x52, 0x53, 0x54]); // 4-byte script
        sw.push(0x00); // witness: 0 items for the input
        sw.extend_from_slice(&[0, 0, 0, 0]); // locktime
        assert_eq!(sw.len(), 67);
        assert!(compute_txid(&sw).is_none(), "segwit tx with a 64-byte stripped form is rejected (X-03)");
    }

    // CRITICAL (witness commitment): a Tacit envelope lives in the Taproot WITNESS, but the txid merkle
    // strips it — so swapping the witness keeps the txid. verify_witness_commitment must detect the swap
    // (BIP141 wtxid commitment), else a prover could fold a counterfeit envelope into a real block.
    #[test]
    fn witness_commitment_detects_swapped_witness() {
        // A minimal SegWit tx whose only witness item is `wit` (the envelope stand-in).
        fn segwit_tx(wit: &[u8]) -> Vec<u8> {
            let mut t = vec![0x01u8, 0, 0, 0, 0x00, 0x01, 0x01]; // version, marker, flag, 1 input
            t.extend_from_slice(&[0u8; 32]); t.extend_from_slice(&[0, 0, 0, 0]); // prevout
            t.push(0x00); t.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);        // scriptSig len 0, sequence
            t.push(0x01); t.extend_from_slice(&[0u8; 8]); t.push(0x01); t.push(0x51); // 1 output: value 0, OP_1
            t.push(0x01); t.push(wit.len() as u8); t.extend_from_slice(wit);     // witness: 1 item
            t.extend_from_slice(&[0, 0, 0, 0]);                                  // locktime
            t
        }
        let tx1 = segwit_tx(b"real-witness");
        let reserved = [0x07u8; 32];
        let witness_root = compute_merkle_root(&[[0u8; 32], double_sha256(&tx1)]);
        let mut pre = [0u8; 64];
        pre[..32].copy_from_slice(&witness_root); pre[32..].copy_from_slice(&reserved);
        let commitment = double_sha256(&pre);
        // Coinbase carrying the BIP141 commitment output + the reserved-value witness.
        let mut cb = vec![0x01u8, 0, 0, 0, 0x00, 0x01, 0x01]; // version, marker, flag, 1 input
        cb.extend_from_slice(&[0u8; 32]); cb.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // coinbase prevout
        cb.push(0x00); cb.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);                    // scriptSig len 0, sequence
        cb.push(0x01); cb.extend_from_slice(&[0u8; 8]);                                    // 1 output, value 0
        cb.push(0x28); cb.extend_from_slice(&[0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed]); cb.extend_from_slice(&commitment);
        cb.extend_from_slice(&[0x99, 0x42]); // BIP141 permits optional bytes after the 36-byte commitment.
        cb.push(0x01); cb.push(0x20); cb.extend_from_slice(&reserved);                     // witness: the 32-byte reserved value
        cb.extend_from_slice(&[0, 0, 0, 0]);                                               // locktime

        let txs: Vec<&[u8]> = vec![cb.as_slice(), tx1.as_slice()];
        assert_eq!(verify_witness_commitment(&txs), Some(true), "honest witnesses verify");

        // Swap tx1's witness for a fake envelope: the txid is UNCHANGED (the attack premise), but the
        // BIP141 commitment now fails — so the guest rejects the fold.
        let tx1_fake = segwit_tx(b"FAKE-TACIT-envelope-payload");
        assert_eq!(compute_txid(&tx1), compute_txid(&tx1_fake), "swapping the witness keeps the txid");
        let txs_fake: Vec<&[u8]> = vec![cb.as_slice(), tx1_fake.as_slice()];
        assert_eq!(verify_witness_commitment(&txs_fake), Some(false), "a swapped witness breaks the commitment");
    }

    // CRITICAL (coinbase witness, C-01): the coinbase wtxid is fixed to zero by BIP141, so its witness is the
    // ONE witness in a block the commitment never binds. A prover must not be able to smuggle a Tacit envelope
    // as a second coinbase witness item while keeping the txid merkle root + commitment valid. The reserved-
    // value shape (exactly one 32-byte item) is enforced, so such a coinbase fails the commitment parse.
    #[test]
    fn coinbase_extra_witness_item_rejected() {
        let tx1 = {
            let mut t = vec![0x01u8, 0, 0, 0, 0x00, 0x01, 0x01];
            t.extend_from_slice(&[0u8; 32]); t.extend_from_slice(&[0, 0, 0, 0]);
            t.push(0x00); t.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);
            t.push(0x01); t.extend_from_slice(&[0u8; 8]); t.push(0x01); t.push(0x51);
            t.push(0x01); t.push(12); t.extend_from_slice(b"real-witness");
            t.extend_from_slice(&[0, 0, 0, 0]);
            t
        };
        let reserved = [0x07u8; 32];
        let witness_root = compute_merkle_root(&[[0u8; 32], double_sha256(&tx1)]);
        let mut pre = [0u8; 64];
        pre[..32].copy_from_slice(&witness_root); pre[32..].copy_from_slice(&reserved);
        let commitment = double_sha256(&pre);
        // Coinbase outputs unchanged (txid + commitment preserved), but witness carries a SECOND item — a
        // fake Tacit Taproot envelope — alongside the 32-byte reserved value.
        let mut cb = vec![0x01u8, 0, 0, 0, 0x00, 0x01, 0x01];
        cb.extend_from_slice(&[0u8; 32]); cb.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);
        cb.push(0x00); cb.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);
        cb.push(0x01); cb.extend_from_slice(&[0u8; 8]);
        cb.push(0x28); cb.extend_from_slice(&[0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed]); cb.extend_from_slice(&commitment);
        cb.push(0x02); // wit_count = 2 (the forgery)
        cb.push(0x20); cb.extend_from_slice(&reserved);           // item 0: the reserved value
        cb.push(0x05); cb.extend_from_slice(b"TACIT");            // item 1: smuggled (uncommitted) envelope
        cb.extend_from_slice(&[0, 0, 0, 0]);

        assert_eq!(parse_coinbase_commitment(&cb), None, "a >1-item coinbase witness is rejected");
        let txs: Vec<&[u8]> = vec![cb.as_slice(), tx1.as_slice()];
        // The commitment OUTPUT is present (txid-committed) → this IS a SegWit block, so the extra-witness-item
        // forgery must be HARD-REJECTED (Some(false) → the caller panics), NOT silently treated as non-segwit
        // (None), which would drop the block's legitimate envelopes (targeted censorship).
        assert_eq!(verify_witness_commitment(&txs), Some(false), "extra-witness-item forgery on a committed coinbase is rejected");
    }

    // Path-based witness commitment (burn-deposit provenance): the same forgery, authenticated via merkle
    // PATHS instead of a full block. A swapped witness keeps the txid (the txid path still passes) but
    // breaks the wtxid/coinbase-commitment binding.
    #[test]
    fn tx_witness_committed_via_path_detects_swap() {
        fn segwit_tx(wit: &[u8]) -> Vec<u8> {
            let mut t = vec![0x01u8, 0, 0, 0, 0x00, 0x01, 0x01];
            t.extend_from_slice(&[0u8; 32]); t.extend_from_slice(&[0, 0, 0, 0]);
            t.push(0x00); t.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);
            t.push(0x01); t.extend_from_slice(&[0u8; 8]); t.push(0x01); t.push(0x51);
            t.push(0x01); t.push(wit.len() as u8); t.extend_from_slice(wit);
            t.extend_from_slice(&[0, 0, 0, 0]);
            t
        }
        let tx1 = segwit_tx(b"real-witness");
        let reserved = [0x09u8; 32];
        let witness_root = compute_merkle_root(&[[0u8; 32], double_sha256(&tx1)]);
        let mut pre = [0u8; 64];
        pre[..32].copy_from_slice(&witness_root); pre[32..].copy_from_slice(&reserved);
        let commitment = double_sha256(&pre);
        let mut cb = vec![0x01u8, 0, 0, 0, 0x00, 0x01, 0x01];
        cb.extend_from_slice(&[0u8; 32]); cb.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);
        cb.push(0x00); cb.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);
        cb.push(0x01); cb.extend_from_slice(&[0u8; 8]);
        cb.push(0x26); cb.extend_from_slice(&[0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed]); cb.extend_from_slice(&commitment);
        cb.push(0x01); cb.push(0x20); cb.extend_from_slice(&reserved);
        cb.extend_from_slice(&[0, 0, 0, 0]);

        // The block is [coinbase, tx1]; tx1 is at index 1. (coinbase wtxid := 0 in the witness tree.)
        let cb_txid = compute_txid(&cb).unwrap();
        let tx1_txid = compute_txid(&tx1).unwrap();
        let txid_root = compute_merkle_root(&[cb_txid, tx1_txid]);
        assert_eq!(
            verify_tx_witness_committed(&tx1, 1, &[[0u8; 32]], &cb, &[tx1_txid], &txid_root),
            Some(()),
            "honest provenance tx witness is committed",
        );
        // Swap tx1's witness: txid (hence txid_root + the coinbase's same-block proof) is unchanged, but
        // the wtxid no longer matches the coinbase commitment.
        let tx1_fake = segwit_tx(b"FAKE-CETCH-supply-note");
        assert_eq!(compute_txid(&tx1_fake).unwrap(), tx1_txid, "swap keeps the txid");
        assert_eq!(
            verify_tx_witness_committed(&tx1_fake, 1, &[[0u8; 32]], &cb, &[tx1_txid], &txid_root),
            None,
            "a swapped provenance witness fails the commitment",
        );
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

    // M-02: the CHECKED merkle root (used on every consensus-admission path) rejects the duplicate-tail
    // alias, so a `[A,B,C,C]` set can't masquerade as the real odd-leaf `[A,B,C]` block.
    #[test]
    fn merkle_root_checked_rejects_duplicate_tail() {
        let a = [1u8; 32];
        let b = [2u8; 32];
        let c = [3u8; 32]; // distinct leaves (a real block has no duplicate txids)
        let real = compute_merkle_root(&[a, b, c]);
        assert_eq!(compute_merkle_root_checked(&[a, b, c]), Some(real), "honest odd-leaf set accepted");
        assert_eq!(compute_merkle_root(&[a, b, c, c]), real, "the unchecked alias folds to the same root");
        assert_eq!(compute_merkle_root_checked(&[a, b, c, c]), None, "duplicate-tail mutation rejected");
        assert_eq!(compute_merkle_root_checked(&[a, b]), Some(compute_merkle_root(&[a, b])), "even set accepted");
        assert_eq!(compute_merkle_root_checked(&[a]), Some(a), "single leaf accepted");
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
