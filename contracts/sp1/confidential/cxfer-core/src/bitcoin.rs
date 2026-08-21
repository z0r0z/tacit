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
// Structural validity of a NON-witness tx serialization that consumes EXACTLY its length:
// version(4) ‖ in_count ‖ [prevout(36) ‖ script ‖ seq(4)]… ‖ out_count ‖ [value(8) ‖ script]… ‖ locktime(4),
// with in_count ≥ 1 and out_count ≥ 1 (Bitcoin `CheckTransaction` rejects empty vin/vout). This admits a
// genuine consensus-valid 64-byte tx so a real one in a block does not stall the forward-only reflection
// scan. It is NOT, by itself, the soundness defense against the 64-byte merkle-merge:
// the attacker may MINE the block and grind the coinbase so C = txid_L‖txid_R parses, so the
// merge is blocked by the FULL-SCAN BLOCK-BODY AUTHENTICATION in reflect.rs — tx[0] must be a real coinbase
// (a 64-byte `C` masquerading as the sole coinbase fails `is_coinbase`), no later tx may be a coinbase, and
// the BIP-141 witness commitment + duplicate-tail-checked merkle reconstruction reject any kept-coinbase
// leaf-collapse. This parse only governs WHICH 64-byte blobs are hashable; it does not stand alone.
fn nonwitness_tx_exact_len(tx: &[u8]) -> bool {
    if tx.len() < 4 {
        return false;
    }
    let mut pos = 4usize;
    let (in_count, vi) = match read_varint(tx, pos) { Some(x) => x, None => return false };
    if in_count == 0 {
        return false;
    }
    pos = match pos.checked_add(vi) { Some(p) => p, None => return false };
    for _ in 0..in_count {
        pos = match pos.checked_add(36) { Some(p) => p, None => return false };
        let (sl, vi) = match read_varint(tx, pos) { Some(x) => x, None => return false };
        pos = match pos.checked_add(vi).and_then(|p| p.checked_add(sl)).and_then(|p| p.checked_add(4)) {
            Some(p) => p,
            None => return false,
        };
    }
    let (out_count, vi) = match read_varint(tx, pos) { Some(x) => x, None => return false };
    if out_count == 0 {
        return false;
    }
    pos = match pos.checked_add(vi) { Some(p) => p, None => return false };
    for _ in 0..out_count {
        pos = match pos.checked_add(8) { Some(p) => p, None => return false };
        let (sl, vi) = match read_varint(tx, pos) { Some(x) => x, None => return false };
        pos = match pos.checked_add(vi).and_then(|p| p.checked_add(sl)) { Some(p) => p, None => return false };
    }
    pos = match pos.checked_add(4) { Some(p) => p, None => return false }; // locktime
    pos == tx.len()
}

pub fn compute_txid(tx_data: &[u8]) -> Option<[u8; 32]> {
    // BIP-141 anti-merkle-collision: a 64-byte blob could be a merkle internal
    // node (txid_L ‖ txid_R) masquerading as a tx — a "merge" prover could swap it for the real [L,R] subtree
    // to hide txs from the full-scan completeness check. But a BLANKET 64-byte reject panics the reflection
    // full-scan on a REAL consensus-valid 64-byte tx (a miner can mine one → permanent forward-chain stall).
    // So reject a 64-byte NON-witness blob ONLY if it does NOT parse as a complete, well-formed tx: real
    // 64-byte txs are admitted (liveness), the collision blob is still rejected (soundness).
    if tx_data.len() == 64
        && !(tx_data.len() > 5 && tx_data[4] == 0x00 && tx_data[5] == 0x01)
        && !nonwitness_tx_exact_len(tx_data)
    {
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
    if input_count == 0 {
        return None; // a segwit tx has ≥ 1 input (matches Bitcoin CheckTransaction)
    }
    let inputs_start = pos;
    pos = pos.checked_add(vi_len)?;
    for _ in 0..input_count {
        pos = pos.checked_add(36)?;
        let (script_len, vi_len) = read_varint(tx_data, pos)?;
        pos = pos.checked_add(vi_len)?.checked_add(script_len)?.checked_add(4)?;
    }
    let (output_count, vi_len) = read_varint(tx_data, pos)?;
    if output_count == 0 {
        return None; // a tx has ≥ 1 output (matches Bitcoin CheckTransaction)
    }
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
    // Exact consumption: locktime is the FINAL 4 bytes — `pos + 4 == len` rejects a
    // trailing-byte segwit-shaped serialization (a real confirmed tx consumes exactly; a non-exact form is
    // also caught downstream by the txid-merkle/wtxid-commitment checks, but reject it canonically here).
    if outputs_end > tx_data.len() || pos.checked_add(4)? != tx_data.len() { return None; }
    let locktime = &tx_data[pos..pos + 4];

    let mut stripped = Vec::with_capacity(version.len() + (outputs_end - inputs_start) + 4);
    stripped.extend_from_slice(version);
    stripped.extend_from_slice(&tx_data[inputs_start..outputs_end]);
    stripped.extend_from_slice(locktime);
    // The 64-byte anti-merkle-collision check applies to the STRIPPED
    // serialization (the bytes the txid is hashed over). The stripped form was just walked from a real segwit
    // tx, so it is well-formed by construction — admit it iff it parses (a genuine segwit tx with a 64-byte
    // stripped form flows; the belt-and-suspenders parse still rejects a degenerate collision-shaped form).
    if stripped.len() == 64 && !nonwitness_tx_exact_len(&stripped) {
        return None;
    }
    Some(double_sha256(&stripped))
}

/// True iff `tx_data` is a coinbase: exactly one input whose prevout is the null outpoint (txid = 32 zero
/// bytes, vout = 0xffffffff). The reflection full-scan requires tx[0] to satisfy this: the
/// 64-byte merkle-merge attack presents a fake one-tx block where the sole "tx" `C = txid_L ‖ txid_R`
/// masquerades as the coinbase to hide the real spend `R`. `C` is ≈random hash bytes, so its first input's
/// prevout is not the null outpoint (forcing it to be would need ~2^216 grind) — this rejects the fake while
/// every real coinbase passes. (An n_tx≥2 merge must keep the real coinbase to match the root, which pins its
/// committed wtxid root; collapsing any subtree into one 64-byte leaf changes the wtxid tree shape, so the
/// BIP-141 witness commitment then fails — independent of whether the hidden tx is segwit or legacy.)
pub fn is_coinbase(tx_data: &[u8]) -> bool {
    if tx_data.len() < 4 {
        return false;
    }
    let mut pos = 4usize;
    if tx_data.len() > 5 && tx_data[4] == 0x00 && tx_data[5] == 0x01 {
        pos = 6; // skip segwit marker+flag
    }
    let (in_count, vi) = match read_varint(tx_data, pos) {
        Some(x) => x,
        None => return false,
    };
    if in_count != 1 {
        return false;
    }
    pos = match pos.checked_add(vi) {
        Some(p) => p,
        None => return false,
    };
    let end = match pos.checked_add(36) {
        Some(e) => e,
        None => return false,
    };
    if end > tx_data.len() {
        return false;
    }
    tx_data[pos..pos + 32].iter().all(|&b| b == 0)
        && tx_data[pos + 32..pos + 36] == [0xff, 0xff, 0xff, 0xff]
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
pub fn parse_cetch(env: &[u8]) -> Option<([u8; 33], [u8; 32], u8, Vec<u8>)> {
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
    let rp_start = p;
    p = p.checked_add(rp_len)?; // range proof: retained (verified by verify_etch_anchor), no longer discarded
    let range_proof = env.get(rp_start..p)?.to_vec();
    let mint_authority: [u8; 32] = env.get(p..p + 32)?.try_into().ok()?;
    Some((commitment, mint_authority, decimals, range_proof))
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
    let (commitment, mint_authority, decimals, range_proof) = parse_cetch(&env)?;
    // Range-bound the supply anchor C_0, exactly as verify_cmint_authorized does for a mint. Without this
    // an issuer could anchor C_0 = 2^65·H+rG (a valid curve point, not a valid unsigned note) and split it
    // into in-range descendants totalling more than any single note-domain value. Fail-closed on a bad C_0
    // or a missing/invalid proof so the anchor can never enter the supply set unbounded.
    let c0 = crate::decompress(&commitment)?;
    if !crate::verify_range(&[c0], &range_proof) {
        return None;
    }
    Some((commitment, mint_authority, decimals))
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

/// Parse a confidential bridge-burn envelope (opcode 0x2B) → (assetId, nullifier, destCommitment,
/// targetChainBinding). `env` is the payload from `extract_taproot_envelope` (env[0] = opcode).
/// Layout: opcode(1) ‖ assetId(32) ‖ bitcoinPoolRoot(32) ‖ nullifier(32) ‖ destCommitment(32) ‖
/// targetChainBinding(32) = 161 bytes.
/// `targetChainBinding` is the CHAIN_BINDING (keccak(chainid, poolAddress)) of the deployment the
/// burn targets; it is folded into `bridge_burn_id`, so a burn is redeemable in EXACTLY ONE generation and a
/// successor that resumes the shared burn set can never pay a historical burn.
/// V3 launches with an EMPTY predecessor (no legacy 129-byte burns to grandfather), so the 161-byte
/// target-bound format is REQUIRED unconditionally. None if malformed.
/// The reflection prover binds a reflected bridge-out's destCommitment (and ν + target) to this, so a
/// burn's Ethereum mint cannot be redirected to a different destination or paid in the wrong generation.
pub fn parse_burn_envelope(env: &[u8]) -> Option<([u8; 32], [u8; 32], [u8; 32], [u8; 32])> {
    // A reflected bridge-burn is exactly 161 bytes; a scan-free burn-deposit appends its provenance blob after
    // these 161 (read from the wtxid-authenticated witness, so the burn-deposit path slices env[161..]).
    if env.len() < 161 || env[0] != 0x2B {
        return None;
    }
    let asset: [u8; 32] = env[1..33].try_into().ok()?;
    let nullifier: [u8; 32] = env[65..97].try_into().ok()?;
    let dest: [u8; 32] = env[97..129].try_into().ok()?;
    let target: [u8; 32] = env[129..161].try_into().ok()?;
    Some((asset, nullifier, dest, target))
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

/// Parsed `T_ETH_CALL` envelope (opcode 0x69) — an Ethereum-authorized message honored on Bitcoin.
pub struct EthCallEnvelope {
    pub msg_id: [u8; 32],
    pub ns: [u8; 32],
    pub sender: [u8; 20],
    pub dest_chain: u16,
    pub payload_hash: [u8; 32],
    pub payload: Vec<u8>,
}

/// Ethereum→Bitcoin message envelope (`T_ETH_CALL`, opcode 0x69): `msg_id(32) ‖ ns(32) ‖ sender(20) ‖
/// dest_chain(2 BE) ‖ payload_hash(32) ‖ payload_len(2 LE) ‖ payload(N)` — a 121-byte header plus the
/// payload. Variable-length, so it is witness-carried like `T_BTC_CALL` rather than squeezed into an
/// `OP_RETURN`.
///
/// The mirror of `T_BTC_CALL` in the other direction: there, a BIP-340 signature proves a Bitcoin party
/// authorized the call; here, authorization is `sender` having called `EthCallOutbox.send` — proven by the
/// message's membership in the eth-reflection message set, which the fold checks. So this parser carries no
/// signature: the authority is the Ethereum state proof, not a key held by whoever broadcasts the envelope.
///
/// `payload_hash` is re-checked against `keccak(payload)` at fold time, not here — a parser stays pure —
/// but the length cap IS enforced here so a malformed envelope can never reach the fold with an unbounded
/// payload. `MAX_ETH_MESSAGE_PAYLOAD` mirrors `EthCallOutbox.MAX_PAYLOAD`; the CONTRACT is the binding side
/// (it refuses longer payloads), so this can only reject what Ethereum would never have recorded.
/// None if malformed. (ops/DESIGN-eth-call-outbox.md)
pub fn parse_eth_call_envelope(env: &[u8]) -> Option<EthCallEnvelope> {
    const HEADER: usize = 121;
    if env.len() < HEADER || env[0] != 0x69 {
        return None;
    }
    let payload_len = u16::from_le_bytes(env[119..121].try_into().ok()?) as usize;
    // Exact length: trailing bytes after the declared payload would let two distinct envelopes carry the
    // same message, so require the envelope to be exactly its header plus its declared payload.
    if env.len() != HEADER.checked_add(payload_len)? {
        return None;
    }
    if payload_len > crate::eth_reflection::MAX_ETH_MESSAGE_PAYLOAD {
        return None;
    }
    Some(EthCallEnvelope {
        msg_id: env[1..33].try_into().ok()?,
        ns: env[33..65].try_into().ok()?,
        sender: env[65..85].try_into().ok()?,
        dest_chain: u16::from_be_bytes(env[85..87].try_into().ok()?),
        payload_hash: env[87..119].try_into().ok()?,
        payload: env[HEADER..].to_vec(),
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
/// by `kernel_sig` (the CXFER kernel, `Σ C_in = v_btc·H`) against the live-set-resolved input
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
    pub delta_in_min: u64,        // slippage floor the trader signed (part of intent_msg)
    pub delta_in_max: u64,        // slippage ceiling the trader signed (part of intent_msg)
    pub min_out: u64,             // minimum acceptable output the trader signed
    pub tip_amount: u64,          // settler tip (also drawn from C_in; delta_in_total = delta_in + tip)
    pub tip_asset: u8,            // which asset the tip is in (== direction per AMM.md)
    pub expiry_height: u32,       // the intent expires after this Bitcoin height
    pub delta_out: u64,           // taker output amount drawn from the out-asset reserve — the receipt value
    pub trader_pubkey: [u8; 33],  // the trader's key; intent_sig is a BIP-340 sig under its x-only form
    pub c_in: [u8; 33],           // the taker's spent input note commitment (kernel input side)
    pub c_change_or_sentinel: [u8; 33], // taker's change (or the all-zero sentinel = exact input, no change)
    pub c_receipt: [u8; 33],      // the taker's output note commitment (the bridgeable note)
    pub r_receipt: [u8; 32],      // PUBLIC blinding: C_receipt opens to delta_out under it
    pub kernel_sig: [u8; 64],     // BIP-340 over the input-side conservation (C_in − C_change = delta_in_total·H)
    pub intent_sig: [u8; 64],     // BIP-340 over swap_var_intent_msg — the trader's authorization of all terms
    pub range_proof: Vec<u8>,     // m=2 BP+ aggregate over [C_change_or_sentinel, C_receipt]; bounds the change
}

/// Parse a `T_SWAP_VAR` envelope. None if not a well-formed 0x32 envelope. Surfaces the public-reserve
/// fields + the kernel input side the reflection's Track-B conservation needs, and the range proof the
/// fold verifies over [C_change, C_receipt]; the still-unread fields (slippage bounds, trader pubkey,
/// intent sig) ride for the on-chain validator.
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
        delta_in_min: u64::from_le_bytes(env[58..66].try_into().ok()?),
        delta_in_max: u64::from_le_bytes(env[66..74].try_into().ok()?),
        min_out: u64::from_le_bytes(env[82..90].try_into().ok()?),
        tip_amount: u64::from_le_bytes(env[90..98].try_into().ok()?),
        tip_asset: env[98],
        expiry_height: u32::from_le_bytes(env[99..103].try_into().ok()?),
        delta_out: u64::from_le_bytes(env[74..82].try_into().ok()?),
        trader_pubkey: env[103..136].try_into().ok()?,
        c_in: env[136..169].try_into().ok()?,
        c_change_or_sentinel: env[169..202].try_into().ok()?,
        c_receipt: env[202..235].try_into().ok()?,
        r_receipt: env[235..267].try_into().ok()?,
        kernel_sig: env[ks_off..ks_off + 64].try_into().ok()?,
        intent_sig: env[ks_off + 64..ks_off + 128].try_into().ok()?,
        range_proof: env.get(PRE_RP..ks_off)?.to_vec(),
    })
}

/// Reconstruct the trader's canonical `T_SWAP_VAR` intent message (the 32-byte BIP-340 message the trader
/// signed with `intent_sig`). MUST stay byte-identical to the worker/dapp `ammSwapVarIntentMsg`
/// (domain `tacit-amm-swap-var-v1`) — a KAT pins the two together (`swap_var_intent_msg_kat`). The reflection
/// fold rebuilds this from the confirmed tx (the input outpoint it spent, the receipt's scriptPubKey at vout 1
/// and the change's at vout 2, both read verbatim) + the envelope, then `bip340_verify`s it against
/// `trader_pubkey`, so a coordinator cannot alter the min-out, tip, expiry, receipt, or EITHER onboarded note's
/// destination without breaking the signature.
#[allow(clippy::too_many_arguments)]
pub fn swap_var_intent_msg(
    pool_id: &[u8; 32],
    direction: u8,
    delta_in: u64,
    delta_in_min: u64,
    delta_in_max: u64,
    min_out: u64,
    tip_amount: u64,
    tip_asset: u8,
    expiry_height: u32,
    trader_pubkey: &[u8; 33],
    input_txid: &[u8; 32], // internal (little-endian) byte order, as it appears in tx serialization
    input_vout: u32,
    receive_spk: &[u8], // the receipt output's scriptPubKey (P2TR: 0x51 0x20 ‖ x-only)
    // PUBLIC blinding of the receipt the GUEST forms (`C_receipt' = delta_out'·H + r_receipt·G`). Signed
    // because the trader no longer supplies the receipt commitment: with `delta_out'` recomputed in-guest, an
    // unsigned `r_receipt` would let a coordinator choose the onboarded receipt's blinding.
    r_receipt: &[u8; 32],
    c_change_or_sentinel: &[u8; 33],
    // The CHANGE output's scriptPubKey (confirmed tx, vout 2), bound exactly like the receipt's. Empty when
    // `c_change_or_sentinel` is the sentinel (whole-input swap, no change note onboarded) — the fold derives
    // this from the sentinel, so a settler cannot choose which of the two shapes the message takes.
    change_spk: &[u8],
    // The REFUND output's scriptPubKey (confirmed tx, vout 3) — where the fold homes a refund note worth the
    // trader's exact input when the recomputed clearing misses `min_out`. Bound for the same reason the receipt
    // and change destinations are: the refund is an onboarded note, so an unbound destination would let a
    // coordinator point a stale swap's returned principal at its own key.
    refund_spk: &[u8],
) -> [u8; 32] {
    let mut m: Vec<u8> = Vec::with_capacity(256);
    m.extend_from_slice(b"tacit-amm-swap-var-v1");
    m.extend_from_slice(pool_id);
    m.push(direction);
    m.extend_from_slice(&delta_in.to_le_bytes());
    m.extend_from_slice(&delta_in_min.to_le_bytes());
    m.extend_from_slice(&delta_in_max.to_le_bytes());
    m.extend_from_slice(&min_out.to_le_bytes());
    m.extend_from_slice(&tip_amount.to_le_bytes());
    m.push(tip_asset);
    m.extend_from_slice(&expiry_height.to_le_bytes());
    m.extend_from_slice(trader_pubkey);
    m.extend_from_slice(input_txid);
    m.extend_from_slice(&input_vout.to_le_bytes());
    m.extend_from_slice(&(receive_spk.len() as u16).to_le_bytes());
    m.extend_from_slice(receive_spk);
    m.extend_from_slice(r_receipt);
    m.extend_from_slice(c_change_or_sentinel);
    m.extend_from_slice(&(change_spk.len() as u16).to_le_bytes());
    m.extend_from_slice(change_spk);
    m.extend_from_slice(&(refund_spk.len() as u16).to_le_bytes());
    m.extend_from_slice(refund_spk);
    sha256_once(&m)
}

/// Reconstruct the trader's canonical `T_SWAP_ROUTE` intent message (the 32-byte BIP-340 message signed with
/// `intent_sig`). MUST stay byte-identical to the worker/dapp `ammSwapRouteIntentMsg` (domain
/// `tacit-swap-route-v1`) — pinned by `swap_route_intent_msg_kat`. The message binds the receipt's DESTINATION
/// (`receive_spk`, the receipt output's REAL scriptPubKey, length-prefixed exactly as VAR/BATCH bind theirs)
/// alongside the terms, so a coordinator cannot redirect the routed output to its own script. The guest passes
/// the bytes read from the confirmed tx, so a redirected receipt reconstructs a different message and the
/// signature fails. Binding the script itself (not a derived key) keeps this correct for every output type the
/// emitter uses — receipts are P2WPKH today, from which no x-only key is recoverable.
pub fn swap_route_intent_msg(env: &SwapRouteEnvelope, receive_spk: &[u8], refund_spk: &[u8]) -> [u8; 32] {
    let mut m: Vec<u8> = Vec::with_capacity(256);
    m.extend_from_slice(b"tacit-swap-route-v1");
    m.extend_from_slice(&env.trader_pubkey);
    m.extend_from_slice(&env.trader_input_asset);
    m.extend_from_slice(&env.trader_output_asset);
    // The ROUTE INPUT amount, taken from hop 0's in-side declared magnitude. Bound explicitly so the amount the
    // fold feeds into the first pool is authorized on its own, not merely implied by the kernel's excess key.
    m.extend_from_slice(&route_delta_in(env).to_le_bytes());
    m.extend_from_slice(&env.min_out.to_le_bytes());
    m.extend_from_slice(&env.expiry_height.to_le_bytes());
    m.push(env.n_hops as u8);
    // Each hop binds only its POOL and DIRECTION — the route's shape. Its fee tier, pre-reserves, and output
    // magnitudes are deliberately NOT authorized: the fold re-clears every hop against the reserves as they
    // stand when it runs, at each pool's REGISTRY fee tier, so signing a snapshot of them would only recreate
    // stale-snapshot stranding (and signing a fee tier would let a route declare 0 and take the LPs' fee).
    for h in &env.hops {
        m.extend_from_slice(&h.pool_id);
        m.push(h.direction);
    }
    m.extend_from_slice(&env.c_in);
    // The receipt's BLINDING, not its commitment: the final output amount is only known once every hop has been
    // re-cleared, so the guest forms C_receipt' = out'·H + r_receipt·G itself.
    m.extend_from_slice(&env.r_receipt);
    m.extend_from_slice(&(receive_spk.len() as u16).to_le_bytes());
    m.extend_from_slice(receive_spk);
    m.extend_from_slice(&(refund_spk.len() as u16).to_le_bytes());
    m.extend_from_slice(refund_spk);
    sha256_once(&m)
}

/// The route's INPUT amount: hop 0's in-side declared magnitude, selected by hop 0's direction. This is the one
/// declared magnitude the fold still uses — it is what the trader's kernel binds to their real spent note, and
/// it is authorized in `swap_route_intent_msg`. Every LATER hop's amount is recomputed from the previous hop's
/// clearing, never read from the wire. Returns 0 for a hopless envelope (rejected upstream).
pub fn route_delta_in(env: &SwapRouteEnvelope) -> u64 {
    match env.hops.first() {
        Some(h) if h.direction == 0 => h.delta_a_net_mag,
        Some(h) => h.delta_b_net_mag,
        None => 0,
    }
}

/// Reconstruct a `T_SWAP_BATCH` per-intent authorization message (the 32-byte BIP-340 message the trader
/// signed with `intent_sig`). MUST stay byte-identical to the worker/dapp `ammBuildIntentMsg`
/// (domain `tacit-amm-intent-v1`) — pinned by `swap_batch_intent_msg_kat`. Unlike VAR/ROUTE, a batch intent
/// binds the input cross-curve (`c_in_bjj`) and its receipt destination (`receive_spk`, the P2TR scriptPubKey
/// of the trader's receipt output), so the fold must verify this per intent AND the `verify_xcurve` over
/// (c_in_secp, c_in_bjj, in_xcurve_sigma).
#[allow(clippy::too_many_arguments)]
pub fn swap_batch_intent_msg(
    pool_id: &[u8; 32],
    direction: u8,
    input_outpoints: &[([u8; 32], u32)], // internal (little-endian) txid ‖ vout, in signed order
    c_in_secp: &[u8; 33],
    c_in_bjj: &[u8; 32],
    in_xcurve_sigma: &[u8], // 169 bytes
    receive_spk: &[u8],     // the receipt output's scriptPubKey (P2TR: 0x51 0x20 ‖ x-only)
    min_out: u64,
    tip_amount: u64,
    tip_asset: u8,
    expiry_height: u32,
    trader_pubkey: &[u8; 33],
    // This intent's REFUND output scriptPubKey (receipt i sits at vout i+1, its refund at vout n+1+i). A batch
    // proof is pinned to the reserves it was generated against and cannot be re-cleared in-guest, so a batch
    // that loses the race returns each trader's exact input here instead of being skipped — which means the
    // destination must be bound per intent, or a coordinator could collect them.
    refund_spk: &[u8],
) -> [u8; 32] {
    let mut m: Vec<u8> = Vec::with_capacity(400);
    m.extend_from_slice(b"tacit-amm-intent-v1");
    m.extend_from_slice(pool_id);
    m.push(direction);
    m.push(input_outpoints.len() as u8);
    for (txid, vout) in input_outpoints {
        m.extend_from_slice(txid);
        m.extend_from_slice(&vout.to_le_bytes());
    }
    m.extend_from_slice(c_in_secp);
    m.extend_from_slice(c_in_bjj);
    m.extend_from_slice(in_xcurve_sigma);
    m.extend_from_slice(&(receive_spk.len() as u16).to_le_bytes());
    m.extend_from_slice(receive_spk);
    m.extend_from_slice(&min_out.to_le_bytes());
    m.extend_from_slice(&tip_amount.to_le_bytes());
    m.push(tip_asset);
    m.extend_from_slice(&expiry_height.to_le_bytes());
    m.extend_from_slice(trader_pubkey);
    m.extend_from_slice(&(refund_spk.len() as u16).to_le_bytes());
    m.extend_from_slice(refund_spk);
    sha256_once(&m)
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
/// Also accepts the **fixed-amount atomic-settlement family** — `T_AXFER` (0x26, OTC) and its BP+ variant
/// `T_AXFER_BPP` (0x3C). Both are byte-identical to CXFER (worker `decodeAxferPayload` == `decodeCxferPayload`,
/// differing only in opcode + rangeproof flavor) and conserve under the SAME `tacit-kernel-v1` kernel — they're
/// one ancestry family. The Bitcoin tx carries aux NON-tacit (sats) inputs; those aren't pool UTXOs, so
/// `scan_tx_spends` never sees them, and a confirmed atomic settlement's output notes onboard exactly like a
/// CXFER's (no new fold). A variant whose rangeproof/wire doesn't actually match fails the conservation gate
/// (skip-not-panic) — fail-closed, never an over-mint. See ops/DESIGN-bridge-multiasset-provenance.md (Track A).
///
/// The variable-amount variants `T_AXFER_VAR` (0x37) / `T_AXFER_VAR_BPP` (0x3D) are NOT accepted: their
/// interleaved maker-change destination (vout 2) is not bound by any maker signature, so a taker could re-key
/// or destroy the maker's already-nullified change. They are rejected here (parse → None ⇒ the reflection skips
/// them as an unsupported envelope; the vin-scan still retires their inputs, a self-burn for whoever crafts one).
pub fn parse_cxfer_envelope_full(env: &[u8]) -> Option<([u8; 32], [u8; 64], Vec<[u8; 33]>, Vec<u8>)> {
    let op = env.first().copied()?;
    let known = op == 0x23 || op == 0x22 || op == 0x26 || op == 0x3C;
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

/// The generation-bound CXFER opcode (`T_CXFER_BOUND`). Same conservation shape as `T_CXFER`, with a 32-byte
/// `target_chain_binding` prepended: an onboarded output note is homed to exactly one deployment.
pub const T_CXFER_BOUND: u8 = 0x39;

/// Parse a `T_CXFER_BOUND` (0x39) envelope → `(target_chain_binding[32], asset[32], kernel_sig[64],
/// output_commitments, range_proof)`. Layout:
///   `0x39 ‖ target_chain_binding(32) ‖ assetId(32) ‖ kernel_sig(64) ‖ N(1 ∈ {1,2,4,8}) ‖
///     N×( commitment(33) ‖ amount_ct(8) ) ‖ rp_len(2 LE) ‖ rangeproof`.
/// Mirrors `parse_cxfer_envelope_full` with the extra leading binding; feeds the SAME
/// `verify_cxfer_conservation` (the kernel/range are binding-independent) plus the bound onboarding fold.
pub fn parse_cxfer_bound_envelope(env: &[u8]) -> Option<([u8; 32], [u8; 32], [u8; 64], Vec<[u8; 33]>, Vec<u8>)> {
    if env.first().copied()? != T_CXFER_BOUND || env.len() < 1 + 32 + 32 + 64 + 1 {
        return None;
    }
    let target: [u8; 32] = env[1..33].try_into().ok()?;
    let asset: [u8; 32] = env[33..65].try_into().ok()?;
    let kernel_sig: [u8; 64] = env[65..129].try_into().ok()?;
    let mut p = 1 + 32 + 32 + 64;
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
    Some((target, asset, kernel_sig, commitments, range_proof))
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
    // Refund tail carried by BOTH variants. `expiry_height` is the add's / init's deadline; one confirmed past
    // it refunds rather than absorbing at a stale price (0 is a rejected sentinel, like the swap envelopes). The
    // two blindings publicly open the refund notes (option-a, mirroring share_r / r_recv_*): on the refund path
    // a note worth delta_a / delta_b is FORMED at the refund output under these. Variant 0 refunds at vout 1 / 2;
    // POOL_INIT (variant 1) refunds a front-run / stale / malformed seed at vout 2 / 3 (vout 1 is the min-liq lock).
    pub expiry_height: u32,
    pub refund_a_blinding: [u8; 32],
    pub refund_b_blinding: [u8; 32],
}

/// Parse a `T_LP_ADD` (0x2D) envelope. Header (worker `decodeTLpAddPayload`): opcode(1) ‖ variant(1) ‖
/// asset_a(32) ‖ asset_b(32) ‖ delta_a(8 LE) ‖ delta_b(8) ‖ share_amount(8) ‖ share_c_secp(33) ‖ share_c_bjj(32)
/// ‖ share_xcurve_sigma(169) ‖ kernel_sig_a(64) ‖ kernel_sig_b(64) ‖ share_r(32, option-a opening blinding).
/// For variant 1 (POOL_INIT) a VARIABLE-LENGTH tail follows share_r: fee_bps(2) ‖ vkLen(1)‖vkCid ‖
/// cerLen(1)‖ceremonyCid ‖ arbCount(1)‖arbM(1)‖arbiterPubkeys(33·n)
/// ‖ lsigCount(1)‖launcherSigs(64·n) ‖ protocol_fee_address(33) ‖ protocol_fee_bps(2) ‖ metaLen(1)‖poolMetaUri ‖
/// capability_flags(1) ‖ expiry_height(4 LE) ‖ refund_a_blinding(32) ‖ refund_b_blinding(32). The reflection
/// WALKS it to surface the four pool-identity fields + the founder-refund tail (vk/ceremony/
/// arbiter/launcher/meta bytes skipped — the arbiter fields are zero-count in v1 but always present in the
/// wire, so the walk skips them regardless). Fails closed on any truncation.
pub fn parse_lp_add_envelope(env: &[u8]) -> Option<LpAddEnvelope> {
    const HEADER: usize = 1 + 1 + 32 + 32 + 8 + 8 + 8 + 33 + 32 + XCURVE_SIGMA_LEN + 64 + 64; // 452
    const TAIL: usize = HEADER + 32; // 484 — share_r(32) sits between the header and the variant-1 tail
    if env.len() < TAIL || env[0] != 0x2D {
        return None;
    }
    // Variant-0 refund tail: expiry_height(4 LE) ‖ refund_a_blinding(32) ‖ refund_b_blinding(32) sits after
    // share_r; the tail begins at TAIL (484) and the envelope ends at V0_LEN (552).
    const V0_LEN: usize = TAIL + 4 + 32 + 32; // 552
    let variant = env[1];
    if variant != 0 && variant != 1 {
        return None;
    }
    let (mut expiry_height, mut refund_a_blinding, mut refund_b_blinding) = if variant == 0 {
        if env.len() != V0_LEN {
            return None;
        }
        (
            u32::from_le_bytes(env[TAIL..TAIL + 4].try_into().ok()?),
            env[TAIL + 4..TAIL + 36].try_into().ok()?,
            env[TAIL + 36..TAIL + 68].try_into().ok()?,
        )
    } else {
        (0u32, [0u8; 32], [0u8; 32])
    };
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
        // Founder-refund tail (mirrors the variant-0 refund binding, extended to BOTH funded sides): a POOL_INIT
        // that loses the deterministic pool_id to a front-run (or is otherwise stale/malformed post-kernel)
        // returns the seeded delta_a / delta_b to owner-bound refund notes at the tx's vout 2 / vout 3 instead
        // of self-burning the seed. `expiry_height` bounds the init; the two blindings publicly open the refund
        // notes (option-a, like share_r); the refund destinations are read from the confirmed tx outputs.
        let e0 = p;
        take(&mut p, 4)?;
        expiry_height = u32::from_le_bytes(env[e0..e0 + 4].try_into().ok()?);
        let a0 = p;
        take(&mut p, 32)?;
        refund_a_blinding = env[a0..a0 + 32].try_into().ok()?;
        let b0 = p;
        take(&mut p, 32)?;
        refund_b_blinding = env[b0..b0 + 32].try_into().ok()?;
        // Canonical wire: the variant-1 tail must consume the envelope EXACTLY (no trailing bytes), so two
        // byte-distinct txs can't decode to the same LP-init action (guest↔JS determinism).
        if p != env.len() {
            return None;
        }
        (fee, cf, addr, pf)
    } else {
        // Variant 0's pool-identity fields are absent (its length is fixed to V0_LEN, checked above).
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
        expiry_height,
        refund_a_blinding,
        refund_b_blinding,
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
    // Canonical wire: the declared proof_len must account for EXACTLY the trailing bytes, so a
    // padded tx can't decode to the same LP-remove action (guest↔JS determinism).
    let proof_len = u16::from_le_bytes(env[R_OFF + 64..R_OFF + 66].try_into().ok()?) as usize;
    if env.len() != R_OFF + 66 + proof_len {
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
    /// Campaign window the reflection clamps accrual to (parity with EVM periodStart/periodFinish).
    /// end_height == 0 ⇒ perpetual; start_height == 0 ⇒ from genesis.
    pub start_height: u32,
    pub end_height: u32,
    pub c_change_or_sentinel: [u8; 33],
    pub kernel_sig: [u8; 64],
    pub launcher_sig: [u8; 64], // BIP-340 over farm_init_msg — the launcher's authorization of the campaign
    /// Founder-refund tail (bound into farm_init_msg). A farm-init that loses its deterministic farm_id to a
    /// front-run (or is stale/malformed post-kernel) returns the seeded `reward_total` to an owner-bound refund
    /// note instead of self-burning it (the vin scan already nullified the treasury funding note). `expiry`
    /// bounds the init; `refund_dest_xonly` owns the refund note; `refund_blinding` publicly opens it.
    pub refund_expiry: u32,
    pub refund_dest_xonly: [u8; 32],
    pub refund_blinding: [u8; 32],
}

/// The launcher's canonical `T_FARM_INIT` authorization message (the 32-byte BIP-340 message signed with
/// `launcher_sig`). MUST stay byte-identical to the worker/dapp init message (domain `tacit-amm-farm-init-v1`).
/// The conservation kernel proves the treasury was funded but binds NONE of the campaign identity/terms; this
/// signature binds them, so a coordinator cannot reuse a victim's funding kernel under an attacker launcher or
/// altered terms. `farm_id` = amm_derive_farm_id(pool_id, launcher_pubkey, reward_asset, farm_nonce), so pool,
/// launcher, asset, and nonce are all bound through it.
pub fn farm_init_msg(
    farm_id: &[u8; 32],
    launcher_pubkey: &[u8; 33],
    reward_total: u64,
    reward_per_block: u64,
    start_height: u32,
    end_height: u32,
    funding_hash: &[u8; 32],
    // Founder-refund binding: expiry ‖ refund_dest_xonly ‖ refund_blinding. Signed together with
    // funding_hash so the launcher_sig is valid only for this exact funding and this exact refund destination.
    refund_expiry: u32,
    refund_dest_xonly: &[u8; 32],
    refund_blinding: &[u8; 32],
) -> [u8; 32] {
    let mut m: Vec<u8> = Vec::with_capacity(160);
    m.extend_from_slice(b"tacit-amm-farm-init-v1");
    m.extend_from_slice(farm_id);
    m.extend_from_slice(launcher_pubkey);
    m.extend_from_slice(&reward_total.to_le_bytes());
    m.extend_from_slice(&reward_per_block.to_le_bytes());
    m.extend_from_slice(&start_height.to_le_bytes());
    m.extend_from_slice(&end_height.to_le_bytes());
    m.extend_from_slice(funding_hash);
    m.extend_from_slice(&refund_expiry.to_le_bytes());
    m.extend_from_slice(refund_dest_xonly);
    m.extend_from_slice(refund_blinding);
    sha256_once(&m)
}

/// Bind the funding of an AMM object (farm treasury / bonded LP shares) to its authorization signature.
/// `funding_hash = sha256( (prev_txid(32) ‖ prev_vout(4 LE))* ‖ sha256(kernel_sig) )` over the funding
/// outpoints in the SAME order the object's conservation kernel commits them (farm-init: the single
/// treasury spend; lp-bond: all lp_asset spends in kernel order). Folded into farm_init_msg / lp_bond_msg
/// so the launcher_sig / bonder_sig is valid only for this exact funding — the signature binds the specific
/// outpoints + kernel_sig that fund the object, tying the authorization to the funding it actually paid for.
pub fn amm_funding_hash(outpoints: &[([u8; 32], u32)], kernel_sig: &[u8; 64]) -> [u8; 32] {
    let mut h: Vec<u8> = Vec::with_capacity(outpoints.len() * 36 + 32);
    for (txid, vout) in outpoints {
        h.extend_from_slice(txid);
        h.extend_from_slice(&vout.to_le_bytes());
    }
    h.extend_from_slice(&sha256_once(kernel_sig));
    sha256_once(&h)
}

/// Parse a `T_FARM_INIT` (0x34) envelope. Layout (worker `decodeTFarmInitPayload`): opcode(1) ‖ pool_id(32) ‖
/// farm_nonce(32) ‖ launcher_pubkey(33) ‖ reward_asset(32) ‖ reward_total(8 LE) ‖ reward_per_block(8) ‖
/// start_height(4) ‖ end_height(4) ‖ c_change_or_sentinel(33) ‖ rp_len(2 LE) ‖ range_proof(VAR) ‖
/// kernel_sig(64) ‖ launcher_sig(64) ‖ refund_expiry(4 LE) ‖ refund_dest_xonly(32) ‖ refund_blinding(32).
/// The kernel proves the launcher funded `reward_total` of `reward_asset` into the treasury
/// (`C_in − C_change = reward_total·H`, same shape as a swap input side). The refund tail is the founder-refund
/// binding folded into farm_init_msg.
pub fn parse_farm_init_envelope(env: &[u8]) -> Option<FarmInitEnvelope> {
    const RP_LEN_OFF: usize = 1 + 32 + 32 + 33 + 32 + 8 + 8 + 4 + 4 + 33; // 187
    if env.len() < RP_LEN_OFF + 2 || env[0] != 0x34 {
        return None;
    }
    let rp_len = u16::from_le_bytes(env[RP_LEN_OFF..RP_LEN_OFF + 2].try_into().ok()?) as usize;
    let ks_off = RP_LEN_OFF + 2 + rp_len;
    let rt_off = ks_off + 64 + 64; // refund tail sits after kernel_sig + launcher_sig
    if env.len() != rt_off + 4 + 32 + 32 {
        return None; // exact: kernel_sig + launcher_sig + refund tail close the envelope, no trailing bytes
    }
    Some(FarmInitEnvelope {
        pool_id: env[1..33].try_into().ok()?,
        farm_nonce: env[33..65].try_into().ok()?,
        launcher_pubkey: env[65..98].try_into().ok()?,
        reward_asset: env[98..130].try_into().ok()?,
        reward_total: u64::from_le_bytes(env[130..138].try_into().ok()?),
        reward_per_block: u64::from_le_bytes(env[138..146].try_into().ok()?),
        // The campaign window the reflection clamps accrual to (was parsed-over before — dropping it let a
        // bonder earn outside the advertised [start, end]). end == 0 ⇒ perpetual.
        start_height: u32::from_le_bytes(env[146..150].try_into().ok()?),
        end_height: u32::from_le_bytes(env[150..154].try_into().ok()?),
        c_change_or_sentinel: env[154..187].try_into().ok()?,
        kernel_sig: env[ks_off..ks_off + 64].try_into().ok()?,
        launcher_sig: env[ks_off + 64..ks_off + 128].try_into().ok()?,
        refund_expiry: u32::from_le_bytes(env[rt_off..rt_off + 4].try_into().ok()?),
        refund_dest_xonly: env[rt_off + 4..rt_off + 36].try_into().ok()?,
        refund_blinding: env[rt_off + 36..rt_off + 68].try_into().ok()?,
    })
}

/// Parse a `T_LP_HARVEST` (0x3B, 226-byte) envelope → `(farm_id, reward_amount, reward_r)`. The reward note
/// is NOT in the envelope — it's minted by decree at the tx's vout[1], and the reflection DERIVES it as
/// `reward_amount·H + reward_r·G` (both public). Layout: opcode(1) ‖ farm_id(32) ‖ bond_id(36) ‖
/// harvester_pubkey(33) ‖ exit_acc_per_share(16) ‖ exit_view_height(4) ‖ reward_amount(8 LE) ‖ reward_r(32) ‖
/// harvester_sig(64).
/// Trustless harvest: the receipt's `(owner_commit, nonce, shares)` ride the (the trailing new_nonce/rps_entry
/// fields are VESTIGIAL — the position id is stable and its checkpoint is fold-stamped state — but the wire
/// layout is unchanged so existing builders/indexers keep parsing)
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
/// the receipt's entry stamp is the reflection's live `rps` (the envelope's `entry_acc_per_share` is not
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
/// rp_len(2 LE)[191..193] ‖ range_proof(rp_len) ‖ kernel_sig(64) ‖ bonder_sig(64) ‖ refund_expiry(4 LE) ‖
/// refund_dest_xonly(32) ‖ refund_blinding(32)`. The receipt owner is a blinded `pubkey+b·G` with fresh `b`
/// per bond, so publishing it is trustless yet unlinkable. The refund tail is the bonder-refund binding folded
/// into lp_bond_msg (a bond that loses the receipt-leaf race returns its bonded amount to it).
#[allow(clippy::type_complexity)]
pub fn parse_lp_bond_fields_full(
    env: &[u8],
) -> Option<(
    [u8; 32], [u8; 33], u64, u128, u32, [u8; 32], [u8; 32], [u8; 64], [u8; 64], u32, [u8; 32], [u8; 32],
)> {
    if env.len() < 193 || env[0] != 0x35 {
        return None;
    }
    let rp_len = u16::from_le_bytes(env[191..193].try_into().ok()?) as usize;
    let ks_off = 193usize.checked_add(rp_len)?;
    let rt_off = ks_off.checked_add(128)?; // refund tail after kernel_sig(64) + bonder_sig(64)
    if env.len() != rt_off.checked_add(4 + 32 + 32)? {
        return None; // exact close: kernel_sig(64) + bonder_sig(64) + refund tail (4 ‖ 32 ‖ 32)
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
        env[ks_off + 64..ks_off + 128].try_into().ok()?,   // bonder_sig
        u32::from_le_bytes(env[rt_off..rt_off + 4].try_into().ok()?), // refund_expiry
        env[rt_off + 4..rt_off + 36].try_into().ok()?,     // refund_dest_xonly
        env[rt_off + 36..rt_off + 68].try_into().ok()?,    // refund_blinding
    ))
}

/// The bonder's canonical `T_LP_BOND` authorization message (BIP-340 message signed with `bonder_sig`). MUST
/// stay byte-identical to the worker/dapp bond message (domain `tacit-amm-farm-bond-v1`). The conservation
/// kernel proves the LP shares were funded but does NOT bind who owns the resulting receipt; this signature
/// binds the receipt `owner_commit` + `nonce` (as well as farm, bonder, amount, entry, view height), so a
/// coordinator cannot keep a victim's bond while redirecting the receipt's ownership to itself.
#[allow(clippy::too_many_arguments)]
pub fn lp_bond_msg(
    farm_id: &[u8; 32],
    bonder_pubkey: &[u8; 33],
    bond_amount: u64,
    entry_acc_per_share: u128,
    bond_view_height: u32,
    owner_commit: &[u8; 32],
    nonce: &[u8; 32],
    funding_hash: &[u8; 32],
    // Bonder-refund binding: expiry ‖ refund_dest_xonly ‖ refund_blinding. Signed together with
    // funding_hash so the bonder_sig is valid only for this exact funding and this exact refund destination.
    refund_expiry: u32,
    refund_dest_xonly: &[u8; 32],
    refund_blinding: &[u8; 32],
) -> [u8; 32] {
    let mut m: Vec<u8> = Vec::with_capacity(224);
    m.extend_from_slice(b"tacit-amm-farm-bond-v1");
    m.extend_from_slice(farm_id);
    m.extend_from_slice(bonder_pubkey);
    m.extend_from_slice(&bond_amount.to_le_bytes());
    m.extend_from_slice(&entry_acc_per_share.to_le_bytes());
    m.extend_from_slice(&bond_view_height.to_le_bytes());
    m.extend_from_slice(owner_commit);
    m.extend_from_slice(nonce);
    m.extend_from_slice(funding_hash);
    m.extend_from_slice(&refund_expiry.to_le_bytes());
    m.extend_from_slice(refund_dest_xonly);
    m.extend_from_slice(refund_blinding);
    sha256_once(&m)
}

/// Parse a `T_LP_UNBOND` (0x36, 217-byte fixed). TRUSTLESS: the bond's RECEIPT `(owner_commit, nonce, shares,
/// rps_entry — vestigial)` rides the PUBLIC envelope so any prover reconstructs + nullifies it, drops `shares` from the
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
// Layout (207B): op(1) ‖ pool_id(32) ‖ claimer_pubkey(33) ‖ fee_bps(4 LE) ‖ claim_amount(8 LE) ‖
// claim_C_secp(33) ‖ claim_blinding(32) ‖ claim_sig(64). The claimer pubkey + the LP fee tier let the fold
// re-derive pool_id and prove the claimer IS the pool's bound fee recipient; claim_sig (BIP-340 under the
// claimer) binds the claim + the vout-0 destination so anyone can't materialize the accrued skim to their
// own note.
pub fn parse_protocol_fee_claim_envelope(
    env: &[u8],
) -> Option<([u8; 32], [u8; 33], u32, u64, [u8; 33], [u8; 32], [u8; 64])> {
    if env.len() != 207 || env[0] != 0x31 {
        return None;
    }
    Some((
        env[1..33].try_into().ok()?,                        // pool_id
        env[33..66].try_into().ok()?,                       // claimer_pubkey (compressed, the bound recipient)
        u32::from_le_bytes(env[66..70].try_into().ok()?),   // fee_bps (LP tier — pool_id preimage)
        u64::from_le_bytes(env[70..78].try_into().ok()?),   // claim_amount
        env[78..111].try_into().ok()?,                      // claim_C_secp
        env[111..143].try_into().ok()?,                     // claim_blinding
        env[143..207].try_into().ok()?,                     // claim_sig
    ))
}

/// One intent's reflection-relevant fields from a T_SWAP_BATCH (0x2F) envelope.
pub struct SwapBatchIntent {
    pub direction: u8,       // 0 = A→B, 1 = B→A
    pub trader_pubkey: [u8; 33], // the trader's key; intent_sig is a BIP-340 sig under its x-only form
    pub c_in_secp: [u8; 33], // the trader's spent input note (secp) — used by the aggregate Pedersen identity
    pub c_in_bjj: [u8; 32],  // compressed BabyJubJub input commitment (circuit C_in_BJJ_u/_v after decompress)
    pub in_xcurve_sigma: [u8; XCURVE_SIGMA_LEN], // binds c_in_bjj to c_in_secp (the input twin)
    pub min_out: u64,
    pub tip_amount: u64,
    pub expiry_height: u32,  // the intent expires after this Bitcoin height
    pub intent_sig: [u8; 64], // BIP-340 over swap_batch_intent_msg — the trader's authorization
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
        let trader_pubkey: [u8; 33] = env[s + 1..s + 34].try_into().ok()?;
        let c_in_secp: [u8; 33] = env[s + 34..s + 67].try_into().ok()?; // after direction(1), trader_pubkey(33)
        let bjj = s + 1 + 33 + 33; // = s+67, after direction, trader_pubkey, c_in_secp
        let c_in_bjj: [u8; 32] = env[bjj..bjj + 32].try_into().ok()?;
        let xc = bjj + 32; // in_xcurve_sigma start
        let in_xcurve_sigma: [u8; XCURVE_SIGMA_LEN] = env[xc..xc + XCURVE_SIGMA_LEN].try_into().ok()?;
        let mo = xc + XCURVE_SIGMA_LEN; // after c_in_bjj, in_xcurve_sigma
        let min_out = u64::from_le_bytes(env[mo..mo + 8].try_into().ok()?);
        let tip_amount = u64::from_le_bytes(env[mo + 8..mo + 16].try_into().ok()?);
        let expiry_height = u32::from_le_bytes(env[mo + 16..mo + 20].try_into().ok()?);
        let intent_sig: [u8; 64] = env[mo + 20..mo + 84].try_into().ok()?;
        intents.push(SwapBatchIntent { direction, trader_pubkey, c_in_secp, c_in_bjj, in_xcurve_sigma, min_out, tip_amount, expiry_height, intent_sig });
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
    pub fee_bps: u16,  // hop fee tier (part of the signed intent hop block)
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
    pub min_out: u64,             // minimum acceptable final output the trader signed
    pub expiry_height: u32,       // the intent expires after this Bitcoin height
    pub trader_pubkey: [u8; 33],  // intent_sig is a BIP-340 sig under its x-only form
    pub hops: Vec<SwapRouteHop>,
    pub c_in: [u8; 33],      // the trader's spent input note (kernel-bound to hop 0's input amount)
    pub c_receipt: [u8; 33], // the final output note to onboard
    pub r_receipt: [u8; 32], // PUBLIC blinding: C_receipt opens to the final output amount under it
    pub kernel_sig: [u8; 64],
    pub intent_sig: [u8; 64], // BIP-340 over swap_route_intent_msg — the trader's authorization of terms
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
    let mo = p;
    take(&mut p, 8 + 4 + 33)?; // min_out, expiry_height, trader_pubkey
    let min_out = u64::from_le_bytes(env[mo..mo + 8].try_into().ok()?);
    let expiry_height = u32::from_le_bytes(env[mo + 8..mo + 12].try_into().ok()?);
    let trader_pubkey: [u8; 33] = env[mo + 12..mo + 45].try_into().ok()?;
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
            fee_bps: u16::from_le_bytes(env[s + 33..s + 35].try_into().ok()?),
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
    let isig = p;
    take(&mut p, 64)?; // intent_sig — the trader's authorization of the route terms
    let intent_sig: [u8; 64] = env[isig..isig + 64].try_into().ok()?;
    if p != env.len() {
        return None;
    }
    Some(SwapRouteEnvelope {
        n_hops,
        trader_input_asset,
        trader_output_asset,
        min_out,
        expiry_height,
        trader_pubkey,
        hops,
        c_in,
        c_receipt,
        r_receipt,
        kernel_sig,
        intent_sig,
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
            // (bridge-burn / cmint provenance) via the `?` below while the digest still advances.
            // This `assert!` is a DELIBERATE proof-rejection boundary (mirrors the block-level
            // `verify_witness_commitment` Some(false) → panic): a downgraded coinbase is prover-supplied
            // tampering, never present in an honestly-supplied real coinbase, so aborting is a hard reject of
            // that one (malicious) proof — NOT reachable by an honest prover over a real block, hence not a
            // forward-scan stall. A genuinely non-segwit coinbase has no commitment output and yields None.
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

/// Parse a confirmed tx's outputs as `(value_sats, scriptPubKey)`. Mirrors the output walk in
/// `extract_taproot_envelope` (and the JS `parseTxOutputs` in dapp/burn-deposit-bitcoin.js). The
/// trustless-farm spends (harvest 0x3B / unbond 0x36 / refund 0x3E) materialize their value note at
/// vout[1]; the owner/launcher authorization MUST bind that output's scriptPubKey (the DESTINATION),
/// because the note is a pure bearer note keyed only by its outpoint — whoever controls the vout[1]
/// UTXO controls the note, and the blinding rides the PUBLIC envelope. Binding only the blinding (the
/// pre-fix state) let a mempool front-runner replay the public envelope into their own vout[1] and steal
/// the materialized reward/principal/treasury. The txid can't be signed (it commits sha256(envelope),
/// which contains the sig), but the vout[1] scriptPubKey is chosen at sign time and is NOT circular.
pub fn extract_outputs(tx_data: &[u8]) -> Option<Vec<(u64, Vec<u8>)>> {
    if tx_data.len() < 5 {
        return None;
    }
    let mut pos = 4;
    if tx_data[4] == 0x00 && tx_data.len() >= 6 && tx_data[5] == 0x01 {
        pos = 6; // skip the segwit marker + flag
    }
    let (input_count, vi_len) = read_varint(tx_data, pos)?;
    if input_count == 0 {
        return None;
    }
    pos = pos.checked_add(vi_len)?;
    for _ in 0..input_count {
        pos = pos.checked_add(36)?;
        let (script_len, vi_len2) = read_varint(tx_data, pos)?;
        pos = pos.checked_add(vi_len2)?.checked_add(script_len)?.checked_add(4)?;
    }
    let (output_count, vi_len) = read_varint(tx_data, pos)?;
    pos = pos.checked_add(vi_len)?;
    let mut outs = Vec::new();
    for _ in 0..output_count {
        let val_end = pos.checked_add(8)?;
        if val_end > tx_data.len() {
            return None;
        }
        let value = u64::from_le_bytes(tx_data[pos..val_end].try_into().ok()?);
        pos = val_end;
        let (script_len, vi_len2) = read_varint(tx_data, pos)?;
        pos = pos.checked_add(vi_len2)?;
        let spk_end = pos.checked_add(script_len)?;
        if spk_end > tx_data.len() {
            return None;
        }
        outs.push((value, tx_data[pos..spk_end].to_vec()));
        pos = spk_end;
    }
    Some(outs)
}

/// The scriptPubKey of a confirmed tx's `vout`-th output, or an empty vec if it has no such output.
/// The empty fallback is deliberately fail-closed for the farm dest binding: a tx missing vout[1] hashes
/// to a destination no honest owner ever signed, so the authorization fails (no fold, no theft).
pub fn output_scriptpubkey(tx_data: &[u8], vout: usize) -> Vec<u8> {
    extract_outputs(tx_data)
        .and_then(|outs| outs.get(vout).map(|(_v, spk)| spk.clone()))
        .unwrap_or_default()
}

/// The scriptPubKey of a confirmed tx's `vout`-th output as an explicit Option — None when the output is
/// absent. The AMM intent-authorization folds bind the receipt's REAL output script with this (the exact
/// bytes the trader signed over), rather than reconstructing an assumed script shape: the emitters pay
/// receipts to P2WPKH, so synthesizing a P2TR program would never reproduce the signed message.
pub fn output_spk(tx_data: &[u8], vout: usize) -> Option<Vec<u8>> {
    extract_outputs(tx_data).and_then(|outs| outs.get(vout).map(|(_v, spk)| spk.clone()))
}

/// The x-only Taproot output key of a P2TR scriptPubKey (`OP_1 ‖ push32 ‖ <32-byte x-only>` = 0x51 0x20 ..).
/// This is the canonical Bitcoin spend authority for a confidential note materialized to a P2TR UTXO: the
/// reflection derives it from the confirmed output's script (never a witness) and commits it into the note's
/// reflected leaf, so an ETH-lane spend of that note must BIP-340-sign under this key. None if the script is
/// not exactly a 34-byte P2TR program — a non-P2TR output cannot home a spendable confidential note.
pub fn p2tr_xonly(spk: &[u8]) -> Option<[u8; 32]> {
    if spk.len() != 34 || spk[0] != 0x51 || spk[1] != 0x20 {
        return None;
    }
    spk[2..34].try_into().ok()
}

/// The P2TR x-only authority of a confirmed tx's `vout`-th output, or None if that output is absent or not
/// P2TR. Fail-closed like `output_scriptpubkey`: a note whose materializing output is not P2TR gets no
/// spendable reflected leaf.
pub fn output_p2tr_xonly(tx_data: &[u8], vout: usize) -> Option<[u8; 32]> {
    extract_outputs(tx_data).and_then(|outs| outs.get(vout).and_then(|(_v, spk)| p2tr_xonly(spk)))
}

/// The FIRST witness stack item of input `vin_index` in a SegWit tx — the signature slot for both a
/// P2WPKH spend (`[sig‖sighash, pubkey]`) and a Taproot key-/script-path spend (`[sig, …]`). Total /
/// non-panicking on hostile input: None on a legacy (no-witness) tx, an out-of-range index, an empty
/// stack, or any truncated varint. Walks the same version/marker/inputs/outputs prefix as
/// `extract_inputs`, then the per-input witness stacks (one per input, in input order).
pub fn input_first_witness_item(tx_data: &[u8], vin_index: usize) -> Option<Vec<u8>> {
    if tx_data.len() < 6 || tx_data[4] != 0x00 || tx_data[5] != 0x01 {
        return None; // legacy serialization → no witness section
    }
    let mut pos = 6;
    let (input_count, vi) = read_varint(tx_data, pos)?;
    if input_count == 0 || vin_index >= input_count {
        return None;
    }
    pos = pos.checked_add(vi)?;
    for _ in 0..input_count {
        pos = pos.checked_add(36)?;
        let (sl, vl) = read_varint(tx_data, pos)?;
        pos = pos.checked_add(vl)?.checked_add(sl)?.checked_add(4)?;
    }
    let (output_count, vo) = read_varint(tx_data, pos)?;
    pos = pos.checked_add(vo)?;
    for _ in 0..output_count {
        pos = pos.checked_add(8)?;
        let (sl, vl) = read_varint(tx_data, pos)?;
        pos = pos.checked_add(vl)?.checked_add(sl)?;
    }
    for i in 0..input_count {
        let (item_count, vc) = read_varint(tx_data, pos)?;
        pos = pos.checked_add(vc)?;
        if i == vin_index {
            // Require a KEY-PATH Taproot witness — exactly one stack item (the Schnorr signature). A
            // script-path spend has >=2 items (script inputs, script, control block) whose first item is
            // arbitrary, so reading its last byte as a sighash flag is meaningless: this is the sole
            // destination binding for a reflected note (note_spends_bind_outputs), and pool notes are P2TR
            // key-path spends, so anything else is rejected rather than trusted.
            if item_count != 1 {
                return None;
            }
            let (ilen, il) = read_varint(tx_data, pos)?;
            pos = pos.checked_add(il)?;
            let end = pos.checked_add(ilen)?;
            if end > tx_data.len() {
                return None;
            }
            return Some(tx_data[pos..end].to_vec());
        }
        for _ in 0..item_count {
            let (ilen, il) = read_varint(tx_data, pos)?;
            pos = pos.checked_add(il)?.checked_add(ilen)?;
        }
    }
    None
}

/// True iff a witness signature's sighash flag commits to ALL of the tx's outputs — i.e. the spender's
/// Bitcoin signature binds every output destination. A 64-byte Schnorr item is SIGHASH_DEFAULT (implicit
/// ALL). Otherwise the last byte is the explicit sighash flag: masking off the ANYONECANPAY bit (0x80) leaves
/// the base type, so both SIGHASH_ALL (0x01) and SIGHASH_ALL|ANYONECANPAY (0x81) bind every output. SINGLE / NONE
/// (0x02 / 0x03, and their 0x82 / 0x83 ANYONECANPAY variants — e.g. the atomic-settlement adaptor's 0x83)
/// do NOT, and are rejected.
pub fn sig_binds_all_outputs(sig: &[u8]) -> bool {
    match sig.len() {
        0 => false,
        64 => true,                    // Taproot key-path, SIGHASH_DEFAULT (implicit ALL)
        n => sig[n - 1] & 0x7f == 0x01, // SIGHASH_ALL, with or without ANYONECANPAY (0x01 / 0x81)
    }
}

/// Defense-in-depth destination binding for the pool-note inputs a reflection fold consumes (pure CXFER,
/// LP-add, LP-remove). Requires EVERY listed note-spend input's witness signature to commit to ALL of the
/// tx's outputs (SIGHASH_DEFAULT/ALL), so the reflected notes' destinations — read from the confirmed tx
/// outputs (`output_p2tr_xonly`) — are Bitcoin-consensus-bound by the spender rather than trusted from
/// emitter wallet policy. Scoped to the passed note outpoints only: the atomic-settlement family (T_AXFER
/// and its variants) legitimately spends the maker's asset with SIGHASH_SINGLE|ANYONECANPAY (0x83), and the
/// caller MUST NOT invoke this for those opcodes (its outputs are consensus-bound by the taker's own
/// SIGHASH_ALL funding input). False if any note outpoint is absent from the vin, carries no witness, or its
/// signature does not bind every output.
pub fn note_spends_bind_outputs(tx_data: &[u8], note_outpoints: &[([u8; 32], u32)]) -> bool {
    let inputs = match extract_inputs(tx_data) {
        Some(v) => v,
        None => return false,
    };
    for op in note_outpoints {
        // Outpoints are unique within a tx, so position is the note spend's unambiguous vin index.
        let idx = match inputs.iter().position(|i| i == op) {
            Some(i) => i,
            None => return false,
        };
        match input_first_witness_item(tx_data, idx) {
            Some(sig) if sig_binds_all_outputs(&sig) => {}
            _ => return false,
        }
    }
    true
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
        } else if op == 0x4e { // OP_PUSHDATA4 (consensus-valid in a Taproot script; checked len arithmetic)
            if sp + 3 >= script.len() { return None; }
            let ln = u32::from_le_bytes([script[sp], script[sp + 1], script[sp + 2], script[sp + 3]]) as usize;
            sp += 4;
            let end = sp.checked_add(ln)?;
            if end > script.len() { return None; }
            payload.extend_from_slice(&script[sp..end]);
            sp = end;
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
        // `usize` is 32-bit on the RV32 zkVM target, so `val as usize` would silently truncate a varint
        // above u32::MAX. Reject it explicitly — no real Bitcoin count/length approaches this, so it's pure
        // hardening that keeps the parse identical on 32- and 64-bit targets rather than target-dependent.
        if val > u32::MAX as u64 { return None; }
        Some((val as usize, 9))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn eth_call_env(payload: &[u8]) -> Vec<u8> {
        let mut e = vec![0x69u8];
        e.extend_from_slice(&[1u8; 32]); // msg_id
        e.extend_from_slice(&[2u8; 32]); // ns
        e.extend_from_slice(&[3u8; 20]); // sender
        e.extend_from_slice(&1u16.to_be_bytes()); // dest_chain = bitcoin
        e.extend_from_slice(&[4u8; 32]); // payload_hash
        e.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        e.extend_from_slice(payload);
        e
    }

    #[test]
    fn eth_call_envelope_round_trips() {
        let payload = b"hello world";
        let parsed = parse_eth_call_envelope(&eth_call_env(payload)).expect("valid envelope");
        assert_eq!(parsed.msg_id, [1u8; 32]);
        assert_eq!(parsed.ns, [2u8; 32]);
        assert_eq!(parsed.sender, [3u8; 20]);
        assert_eq!(parsed.dest_chain, 1);
        assert_eq!(parsed.payload_hash, [4u8; 32]);
        assert_eq!(parsed.payload, payload);
    }

    #[test]
    fn eth_call_envelope_accepts_empty_payload() {
        let parsed = parse_eth_call_envelope(&eth_call_env(b"")).expect("empty payload is valid");
        assert!(parsed.payload.is_empty());
    }

    #[test]
    fn eth_call_envelope_rejects_malformed() {
        let mut wrong_op = eth_call_env(b"x");
        wrong_op[0] = 0x68;
        assert!(parse_eth_call_envelope(&wrong_op).is_none(), "non-0x69 opcode rejected");

        let short = eth_call_env(b"x");
        assert!(parse_eth_call_envelope(&short[..120]).is_none(), "truncated header rejected");

        // Trailing bytes past the declared payload would let two distinct envelopes carry one message.
        let mut trailing = eth_call_env(b"x");
        trailing.push(0xff);
        assert!(parse_eth_call_envelope(&trailing).is_none(), "trailing byte rejected");

        // A declared length longer than the body must not over-read.
        let mut lying = eth_call_env(b"x");
        lying[119..121].copy_from_slice(&9u16.to_le_bytes());
        assert!(parse_eth_call_envelope(&lying).is_none(), "over-declared payload rejected");
    }

    #[test]
    fn eth_call_envelope_enforces_the_payload_cap() {
        let max = crate::eth_reflection::MAX_ETH_MESSAGE_PAYLOAD;
        assert!(parse_eth_call_envelope(&eth_call_env(&vec![7u8; max])).is_some(), "cap boundary is valid");
        // One over the cap is rejected here even though the CONTRACT would never have recorded it — the
        // parser is the fold's bound, so it must not depend on Ethereum having been well-behaved.
        assert!(parse_eth_call_envelope(&eth_call_env(&vec![7u8; max + 1])).is_none(), "over-cap rejected");
    }


    // KAT: the guest's swap_var_intent_msg must be byte-identical to the worker/dapp ammSwapVarIntentMsg.
    //
    // The reference digests in this module were produced by RUNNING the real `worker/src/index.js` and
    // `dapp/tacit.js` builders on these exact vectors — not by a replica of them. `tests/amm-intent-msg-pin
    // .test.mjs` re-runs those real functions against the digests parsed out of this file, so neither side
    // can drift silently; re-run it after touching any intent-message layout, and re-pin from its output.
    // The vectors use a P2WPKH receipt script because that is what the emitters actually pay receipts to.
    #[test]
    fn swap_var_intent_msg_kat() {
        let pool_id = [0x01u8; 32];
        let mut trader_pubkey = [0x03u8; 33];
        trader_pubkey[0] = 0x02;
        let input_txid = [0xAAu8; 32];
        // P2WPKH — the emitter's real receipt script shape (dapp `p2wpkhScript(recipientPub)`).
        let mut receive_spk = vec![0x00u8, 0x14];
        receive_spk.extend_from_slice(&[0xBBu8; 20]);
        let r_receipt = [0xCCu8; 32];
        let c_change = [0x00u8; 33];
        let mut refund_spk = vec![0x00u8, 0x14];
        refund_spk.extend_from_slice(&[0xEEu8; 20]);
        // Sentinel change ⇒ no change output ⇒ the bound change script is empty.
        let got = swap_var_intent_msg(
            &pool_id, 0, 1000, 990, 1010, 495, 5, 0, 800000, &trader_pubkey, &input_txid, 4,
            &receive_spk, &r_receipt, &c_change, &[], &refund_spk,
        );
        assert_eq!(
            hex::encode(got),
            "6f75d0649dc6560a4eb3cd49fe0e08c66bcdca823a34867dede923ef62483ada",
            "swap_var intent_msg drifted from the worker ammSwapVarIntentMsg layout"
        );
    }

    // KAT: the change-bearing form of the same message. The taker's change is onboarded as a real reflected
    // note, so its DESTINATION is bound alongside its commitment — without that, a settler could pay the
    // leftover to its own script and still reproduce the signed message. Pinned against the same real
    // worker/dapp builders (`tests/amm-intent-msg-pin.test.mjs` re-runs them against this digest).
    #[test]
    fn swap_var_intent_msg_change_dest_kat() {
        let pool_id = [0x01u8; 32];
        let mut trader_pubkey = [0x03u8; 33];
        trader_pubkey[0] = 0x02;
        let input_txid = [0xAAu8; 32];
        let mut receive_spk = vec![0x00u8, 0x14];
        receive_spk.extend_from_slice(&[0xBBu8; 20]);
        let mut change_spk = vec![0x00u8, 0x14];
        change_spk.extend_from_slice(&[0xCDu8; 20]);
        let r_receipt = [0xCCu8; 32];
        let mut c_change = [0xDDu8; 33];
        c_change[0] = 0x03;
        let mut refund_spk = vec![0x00u8, 0x14];
        refund_spk.extend_from_slice(&[0xEEu8; 20]);
        let got = swap_var_intent_msg(
            &pool_id, 0, 1000, 990, 1010, 495, 5, 0, 800000, &trader_pubkey, &input_txid, 4,
            &receive_spk, &r_receipt, &c_change, &change_spk, &refund_spk,
        );
        assert_eq!(
            hex::encode(got),
            "0bd60a033711d8b332e1a5d7d7be853c6f91955465a69508c0d13e4befab0dbb",
            "swap_var intent_msg change-destination binding drifted from the worker layout"
        );
        // Non-degeneracy: redirecting the change must move the message, and an empty bound change script
        // (the sentinel shape) must never collide with a present one.
        let redirected: Vec<u8> = {
            let mut s = change_spk.clone();
            s[21] ^= 0xff;
            s
        };
        assert_ne!(
            swap_var_intent_msg(
                &pool_id, 0, 1000, 990, 1010, 495, 5, 0, 800000, &trader_pubkey, &input_txid, 4,
                &receive_spk, &r_receipt, &c_change, &redirected, &refund_spk,
            ),
            got,
            "change destination must be load-bearing"
        );
        assert_ne!(
            swap_var_intent_msg(
                &pool_id, 0, 1000, 990, 1010, 495, 5, 0, 800000, &trader_pubkey, &input_txid, 4,
                &receive_spk, &r_receipt, &c_change, &[], &refund_spk,
            ),
            got,
            "empty change script must not collide with a bound one"
        );
        let refund_redirected: Vec<u8> = {
            let mut s = refund_spk.clone();
            s[21] ^= 0xff;
            s
        };
        assert_ne!(
            swap_var_intent_msg(
                &pool_id, 0, 1000, 990, 1010, 495, 5, 0, 800000, &trader_pubkey, &input_txid, 4,
                &receive_spk, &r_receipt, &c_change, &change_spk, &refund_redirected,
            ),
            got,
            "refund destination must be load-bearing"
        );
    }

    // KAT: lp_bond_msg must be byte-identical to the worker/dapp bond authorization message (owner-bound).
    #[test]
    fn lp_bond_msg_kat() {
        let mut bonder = [0x03u8; 33];
        bonder[0] = 0x02;
        let fh = amm_funding_hash(&[([0x01u8; 32], 0), ([0x02u8; 32], 7)], &[0xCCu8; 64]);
        let got = lp_bond_msg(&[0x11u8; 32], &bonder, 5000, 12345, 800_000, &[0xAAu8; 32], &[0xBBu8; 32], &fh, 810_000, &[0xEEu8; 32], &[0xEFu8; 32]);
        assert_eq!(
            hex::encode(got),
            "d6644350a23f554f05150eba5546f705f7eb00c3ca03d5ac23ccd4fa4125b544",
            "lp_bond_msg drifted from the worker bond message layout"
        );
    }

    // KAT: farm_init_msg must be byte-identical to the worker/dapp farm-init authorization message.
    #[test]
    fn farm_init_msg_kat() {
        let mut launcher = [0x03u8; 33];
        launcher[0] = 0x02;
        let fh = amm_funding_hash(&[([0x09u8; 32], 3)], &[0xDDu8; 64]);
        let got = farm_init_msg(&[0x11u8; 32], &launcher, 1_000_000, 500, 800_000, 900_000, &fh, 850_000, &[0xEEu8; 32], &[0xEFu8; 32]);
        assert_eq!(
            hex::encode(got),
            "03e4986d06206247b489d591a5195cd0674b5374fc05f9b3b4eda68adf4b237c",
            "farm_init_msg drifted from the worker init message layout"
        );
    }

    // KAT: swap_batch_intent_msg must be byte-identical to the worker/dapp ammBuildIntentMsg (single intent).
    #[test]
    fn swap_batch_intent_msg_kat() {
        let mut trader_pubkey = [0x03u8; 33];
        trader_pubkey[0] = 0x02;
        let mut c_in_secp = [0xC1u8; 33];
        c_in_secp[0] = 0x02;
        let c_in_bjj = [0xB1u8; 32];
        let xcurve = [0x5au8; 169];
        let mut receive_spk = vec![0x00u8, 0x14];
        receive_spk.extend_from_slice(&[0xEEu8; 20]);
        // This intent's refund destination (receipt i at vout i+1, refund i at vout n+1+i).
        let mut refund_spk = vec![0x00u8, 0x14];
        refund_spk.extend_from_slice(&[0xEDu8; 20]);
        let got = swap_batch_intent_msg(
            &[0x10u8; 32], 0, &[([0x77u8; 32], 1)], &c_in_secp, &c_in_bjj, &xcurve, &receive_spk,
            495, 5, 0, 800000, &trader_pubkey, &refund_spk,
        );
        assert_eq!(
            hex::encode(got),
            "6f98d1095467a7c00a7082d5a3097c01a7f25766588b89c44f5ed57025d3ab13",
            "swap_batch intent_msg drifted from the worker ammBuildIntentMsg layout"
        );
        // The refund destination must be load-bearing per intent: a batch that loses the race returns every
        // trader's input, so a coordinator able to redirect one would collect it.
        assert_ne!(
            swap_batch_intent_msg(
                &[0x10u8; 32], 0, &[([0x77u8; 32], 1)], &c_in_secp, &c_in_bjj, &xcurve, &receive_spk,
                495, 5, 0, 800000, &trader_pubkey, &{ let mut r = refund_spk.clone(); r[21] ^= 0xff; r },
            ),
            got,
            "batch refund destination must be load-bearing",
        );
    }

    // The BATCH refund note's derivation, unit-tested here because `fold_swap_batch` links `bn` (Groth16 +
    // BabyJubJub) and is box-only — it cannot be cargo-tested. A stale batch cannot be re-cleared in-guest (its
    // proof is pinned to the reserves it was generated against), so each intent's exact input is returned
    // instead. What must hold: the note commits the intent's input commitment VERBATIM (value conserved), rides
    // the intent's INPUT asset, and is authorized by that intent's own signed refund destination key.
    #[test]
    fn swap_batch_refund_note_commits_the_intent_input() {
        use crate::{btc_note_leaf, pedersen_commit_compressed, reflected_note_leaf};
        // A REAL commitment (an arbitrary 33-byte string is not a curve point), standing in for the intent's
        // spent input note: 1500 units under some blinding.
        let c_in = pedersen_commit_compressed(1500, &[0x31u8; 32]);
        let asset_in = [0xAAu8; 32];
        let refund_auth = [0x9Au8; 32];
        let leaf = reflected_note_leaf(&asset_in, &c_in, &refund_auth).expect("refund leaf");
        // Exactly btc_note_leaf over the INPUT commitment's (Cx, Cy) at the refund key — no re-derivation.
        let pt = crate::decompress(&c_in).expect("c_in on curve");
        let enc = {
            use k256::elliptic_curve::sec1::ToEncodedPoint;
            pt.to_affine().to_encoded_point(false)
        };
        let b = enc.as_bytes();
        let (cx, cy): ([u8; 32], [u8; 32]) = (b[1..33].try_into().unwrap(), b[33..65].try_into().unwrap());
        assert_eq!(leaf, btc_note_leaf(&asset_in, &cx, &cy, &refund_auth), "refund commits the input verbatim");
        // Per-intent isolation: a different intent's refund key, or a different input asset, is a different note.
        assert_ne!(leaf, reflected_note_leaf(&asset_in, &c_in, &[0x9Bu8; 32]).unwrap(), "refund key is load-bearing");
        assert_ne!(leaf, reflected_note_leaf(&[0xBBu8; 32], &c_in, &refund_auth).unwrap(), "input asset is load-bearing");
    }

    // KAT: swap_route_intent_msg must be byte-identical to the worker/dapp ammSwapRouteIntentMsg.
    #[test]
    fn swap_route_intent_msg_kat() {
        let mut trader_pubkey = [0x03u8; 33];
        trader_pubkey[0] = 0x02;
        let mut c_in = [0xCCu8; 33];
        c_in[0] = 0x02;
        let mut c_receipt = [0xDDu8; 33];
        c_receipt[0] = 0x02;
        let env = SwapRouteEnvelope {
            n_hops: 2,
            trader_input_asset: [0xA1u8; 32],
            trader_output_asset: [0xB2u8; 32],
            min_out: 400,
            expiry_height: 900000,
            trader_pubkey,
            hops: vec![
                SwapRouteHop { pool_id: [0x11u8; 32], direction: 0, fee_bps: 30, r_a_pre: 10000, r_b_pre: 5000, delta_a_net_mag: 1000, delta_b_net_mag: 450 },
                SwapRouteHop { pool_id: [0x22u8; 32], direction: 1, fee_bps: 30, r_a_pre: 8000, r_b_pre: 8000, delta_a_net_mag: 440, delta_b_net_mag: 450 },
            ],
            c_in,
            c_receipt,
            r_receipt: [0xC7u8; 32],
            kernel_sig: [0u8; 64],
            intent_sig: [0u8; 64],
        };
        // A P2WPKH receipt script — the shape the emitter really pays route receipts to.
        let mut receive_spk = vec![0x00u8, 0x14];
        receive_spk.extend_from_slice(&[0xEEu8; 20]);
        // The refund output's script (vout 2 — a route has no change output), bound on every route.
        let mut refund_spk = vec![0x00u8, 0x14];
        refund_spk.extend_from_slice(&[0xEFu8; 20]);
        let got = swap_route_intent_msg(&env, &receive_spk, &refund_spk);
        assert_eq!(
            hex::encode(got),
            "7d47dbcb0b115f09a35d9c7f42f0d1a470c76e6bf5f399038f545abc9f083f55",
            "swap_route intent_msg drifted from the worker ammSwapRouteIntentMsg layout"
        );
        // Non-degeneracy: the refund destination must move the message, and the per-hop terms the fold now
        // RECOMPUTES must NOT — a hop's stale reserve snapshot or declared output is no longer authorized, so
        // re-signing is not required when the pool moves (that is precisely what keeps a route from stranding).
        assert_ne!(swap_route_intent_msg(&env, &receive_spk, &{ let mut r = refund_spk.clone(); r[21] ^= 0xff; r }), got, "refund destination must be load-bearing");
        let mut moved = env.clone();
        moved.hops[0].r_a_pre = 999_999;
        moved.hops[0].delta_b_net_mag = 1;
        moved.hops[0].fee_bps = 100;
        assert_eq!(swap_route_intent_msg(&moved, &receive_spk, &refund_spk), got, "hop reserves/outputs/fee are not authorized (recomputed in-guest)");
        // But the route's SHAPE and its input amount are.
        let mut repointed = env.clone();
        repointed.hops[1].pool_id = [0x23u8; 32];
        assert_ne!(swap_route_intent_msg(&repointed, &receive_spk, &refund_spk), got, "hop pool_id must be load-bearing");
        let mut redirected_amount = env.clone();
        redirected_amount.hops[0].delta_a_net_mag = 999;
        assert_ne!(swap_route_intent_msg(&redirected_amount, &receive_spk, &refund_spk), got, "the route input amount must be load-bearing");
    }

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
        // The FIXED-amount atomic-settlement family (T_AXFER 0x26, + BP+ 0x3C) is byte-identical to CXFER;
        // the cxfer parser must accept each so the existing fold onboards its tacit output notes (the sats
        // legs are native-BTC, invisible to the kernel).
        let (c0, c1) = ([0x02u8; 33], [0x03u8; 33]);
        let mk = |op: u8| {
            let mut env = vec![op];
            env.extend_from_slice(&[0xAAu8; 32]); // asset_id
            env.extend_from_slice(&[0x07u8; 64]); // kernel_sig
            env.push(2u8); // N = 2
            env.extend_from_slice(&c0); env.extend_from_slice(&[0u8; 8]);
            env.extend_from_slice(&c1); env.extend_from_slice(&[0u8; 8]);
            env.extend_from_slice(&4u16.to_le_bytes()); env.extend_from_slice(&[0xbbu8; 4]);
            env
        };
        for op in [0x26u8, 0x3C] {
            let (asset, ks, commits, rp) = parse_cxfer_envelope_full(&mk(op)).unwrap_or_else(|| panic!("opcode {op:#x} parses as cxfer"));
            assert_eq!(asset, [0xAAu8; 32]);
            assert_eq!(ks, [0x07u8; 64]);
            assert_eq!(commits, vec![c0, c1]);
            assert_eq!(rp, vec![0xbbu8; 4]);
        }
        // The variable-amount variants (T_AXFER_VAR 0x37 / T_AXFER_VAR_BPP 0x3D) are DISABLED — rejected here
        // (unbindable maker-change destination); the reflection then skips them as unsupported.
        for op in [0x37u8, 0x3D] {
            assert!(parse_cxfer_envelope_full(&mk(op)).is_none(), "variable AXFER opcode {op:#x} rejected");
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
        // variant-1 founder-refund tail: expiry_height(4) ‖ refund_a_blinding(32) ‖ refund_b_blinding(32).
        env.extend_from_slice(&123u32.to_le_bytes()); // expiry_height
        env.extend_from_slice(&[0xe1u8; 32]); // refund_a_blinding
        env.extend_from_slice(&[0xe2u8; 32]); // refund_b_blinding
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
        assert_eq!(p.expiry_height, 123);
        assert_eq!(p.refund_a_blinding, [0xe1u8; 32]);
        assert_eq!(p.refund_b_blinding, [0xe2u8; 32]);
        assert!(parse_lp_add_envelope(&env[..env.len() - 1]).is_none(), "truncated variant-1 tail rejected");
        // variant 0 — HEADER + share_r (484) + refund tail (expiry 4 ‖ blinding 32 ‖ blinding 32) = 552 bytes.
        let mut env0 = env[..484].to_vec();
        env0[1] = 0;
        env0.extend_from_slice(&777u32.to_le_bytes()); // expiry_height
        env0.extend_from_slice(&[0xa1u8; 32]);         // refund_a_blinding
        env0.extend_from_slice(&[0xb2u8; 32]);         // refund_b_blinding
        let p0 = parse_lp_add_envelope(&env0).expect("variant-0 lp_add parses");
        assert_eq!((p0.variant, p0.fee_bps), (0, 0));
        assert_eq!(p0.expiry_height, 777);
        assert_eq!(p0.refund_a_blinding, [0xa1u8; 32]);
        assert_eq!(p0.refund_b_blinding, [0xb2u8; 32]);
        assert!(parse_lp_add_envelope(&env0[..551]).is_none(), "truncated variant-0 refund tail rejected");
        // POOL_CAP_ARBITER_AUTHORITY (0x04) is reserved + unimplemented → fail closed.
        let mut arb = env.clone();
        let last = arb.len() - 1 - 4 - 32 - 32; // capability_flags sits before the refund tail (expiry ‖ 2·blinding)
        arb[last] = 0x04;
        assert!(parse_lp_add_envelope(&arb).is_none(), "reserved arbiter-authority capability rejected");
        arb[last] = 0x06; // 0x02 | 0x04 — set alongside an implemented bit, still rejected
        assert!(parse_lp_add_envelope(&arb).is_none(), "arbiter-authority bit rejected even with other bits set");
        let mut bad = env.clone(); bad[0] = 0x22;
        assert!(parse_lp_add_envelope(&bad).is_none(), "non-0x2D rejected");
        // Canonical wire: a trailing byte is rejected for both variants (no two byte-distinct txs → same action).
        let mut t1 = env.clone(); t1.push(0u8);
        assert!(parse_lp_add_envelope(&t1).is_none(), "variant-1 trailing byte rejected");
        let mut t0 = env0.clone(); t0.push(0u8);
        assert!(parse_lp_add_envelope(&t0).is_none(), "variant-0 trailing byte rejected");
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
        // Canonical wire: a trailing byte beyond the declared proof_len is rejected.
        let mut t = env.clone(); t.push(0u8);
        assert!(parse_lp_remove_envelope(&t).is_none(), "trailing byte beyond proof_len rejected");
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
        env.extend_from_slice(&123u32.to_le_bytes()); // refund_expiry
        env.extend_from_slice(&[0xE1u8; 32]); // refund_dest_xonly
        env.extend_from_slice(&[0xE2u8; 32]); // refund_blinding
        let p = parse_farm_init_envelope(&env).expect("farm_init parses");
        assert_eq!(p.pool_id, pool_id);
        assert_eq!(p.farm_nonce, nonce);
        assert_eq!(p.launcher_pubkey, launcher);
        assert_eq!(p.reward_asset, reward_asset);
        assert_eq!(p.reward_total, 1_000_000);
        assert_eq!(p.reward_per_block, 100);
        assert_eq!(p.c_change_or_sentinel, c_change);
        assert_eq!(p.kernel_sig, ks);
        assert_eq!(p.refund_expiry, 123);
        assert_eq!(p.refund_dest_xonly, [0xE1u8; 32]);
        assert_eq!(p.refund_blinding, [0xE2u8; 32]);
        assert!(parse_farm_init_envelope(&env[..env.len() - 1]).is_none(), "truncated refund tail rejected");
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
        let claimer = [0x02u8; 33];
        let claim_sig = [0x0cu8; 64];
        let mut env = vec![0x31u8];
        env.extend_from_slice(&pool_id);
        env.extend_from_slice(&claimer); // claimer_pubkey (33, the bound recipient)
        env.extend_from_slice(&30u32.to_le_bytes()); // fee_bps
        env.extend_from_slice(&777u64.to_le_bytes()); // claim_amount
        env.extend_from_slice(&claim_c);
        env.extend_from_slice(&claim_blinding);
        env.extend_from_slice(&claim_sig);
        assert_eq!(env.len(), 207);
        let (pid, ck, fb, amt, c, r, sg) = parse_protocol_fee_claim_envelope(&env).expect("claim parses");
        assert_eq!(pid, pool_id);
        assert_eq!(ck, claimer);
        assert_eq!(fb, 30);
        assert_eq!(amt, 777);
        assert_eq!(c, claim_c);
        assert_eq!(r, claim_blinding);
        assert_eq!(sg, claim_sig);
        assert!(parse_protocol_fee_claim_envelope(&env[..206]).is_none(), "wrong length rejected");
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
    fn disabled_swap_batch_folds_to_a_noop() {
        // A crafted inscription-style T_SWAP_BATCH (0x2F) that parse_swap_batch_envelope accepts, spending no
        // pool UTXO and carrying a junk proof — exactly what an attacker can reveal in a cheap Taproot
        // inscription. The op is disabled this generation: the guest parses it, consumes one receipt append path
        // per intent off the witness stream (n_intents total), and folds NOTHING. This pins that a block
        // containing such a tx is a pure no-op — no note onboarded, digest unchanged — instead of a halt.
        let mut env = vec![0x2Fu8];
        env.extend_from_slice(&[0xAAu8; 32]); // assetA
        env.extend_from_slice(&[0xBBu8; 32]); // assetB
        env.push(2); // n_intents
        env.push(0); env.extend_from_slice(&1000u64.to_le_bytes()); // delta_A_net
        env.push(1); env.extend_from_slice(&1992u64.to_le_bytes()); // delta_B_net
        env.extend_from_slice(&[0x10u8; 32]); // R_net_A
        env.extend_from_slice(&[0x11u8; 32]); // R_net_B
        env.extend_from_slice(&30u16.to_le_bytes()); // fee_bps
        env.extend_from_slice(&0u64.to_le_bytes()); // tip_A_amount
        env.extend_from_slice(&0u64.to_le_bytes()); // tip_B_amount
        env.extend_from_slice(&[0x21u8; 33]); // tip_A_C_secp
        env.extend_from_slice(&[0x22u8; 33]); // tip_B_C_secp
        env.extend_from_slice(&[0x23u8; 32]); // r_tip_A
        env.extend_from_slice(&[0x24u8; 32]); // r_tip_B
        for _ in 0..2 {
            // intent (352 bytes) — junk fields; the disabled path never validates them.
            env.push(0); // direction
            env.extend_from_slice(&[0x02u8; 33]); // trader_pubkey
            env.extend_from_slice(&[0x03u8; 33]); // c_in_secp
            env.extend_from_slice(&[0x44u8; 32]); // c_in_bjj
            env.extend_from_slice(&[0xc1u8; XCURVE_SIGMA_LEN]); // in_xcurve_sigma
            env.extend_from_slice(&500u64.to_le_bytes()); // min_out
            env.extend_from_slice(&0u64.to_le_bytes()); // tip_amount
            env.extend_from_slice(&100u32.to_le_bytes()); // expiry_height
            env.extend_from_slice(&[0x0cu8; 64]); // intent_sig
        }
        for _ in 0..2 {
            // receipt (234 bytes)
            env.extend_from_slice(&[0x05u8; 33]); // c_out_secp
            env.extend_from_slice(&[0x55u8; 32]); // c_out_bjj
            env.extend_from_slice(&[0xc2u8; XCURVE_SIGMA_LEN]); // out_xcurve_sigma
        }
        env.extend_from_slice(&4u16.to_le_bytes()); // proof_len
        env.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef]); // proof (junk)
        env.push(0); // settler_meta_uri_len

        // The attacker's envelope parses (the freeze trigger is reachable with attacker-only data).
        let sb = parse_swap_batch_envelope(&env).expect("crafted 0x2F parses");
        assert_eq!(sb.n_intents, 2);

        // The guest consumes exactly one receipt append path per intent (n_intents), matching what reflect-stdin
        // serializes for a 0x2F (`swapBatch.receiptPaths`, length n_intents), then folds nothing. Model that
        // no-op against a genesis reflection state: the digest is unchanged and no note is onboarded.
        let before = crate::ScanReflection::genesis();
        let before_digest = before.digest();
        let after = crate::ScanReflection::genesis();
        // Disabled arm: no fold call, no note append. Only the deterministic path reads happen (state-free).
        assert_eq!(after.note_count, before.note_count, "no receipt onboarded");
        assert_eq!(after.digest(), before_digest, "reflection digest unchanged by a disabled 0x2F");
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

        let (commitment, mint_authority, decimals, _rp) = parse_cetch(&env).expect("cetch");
        assert_eq!(commitment, c0, "supply commitment C_0");
        assert_eq!(decimals, 8, "decimals");
        assert!(is_fixed_supply(&mint_authority), "all-zero authority ⇒ fixed-supply (TAC)");

        // a non-zero mint_authority ⇒ mintable (the cmint-deposit path, not the burn path)
        let mut env_mint = env.clone();
        env_mint[auth_off] = 0x07;
        let (_, ma, _, _) = parse_cetch(&env_mint).expect("cetch mintable");
        assert!(!is_fixed_supply(&ma), "non-zero authority ⇒ mintable");

        // gating: wrong opcode (T_PETCH) rejected; truncation within mint_authority rejected
        assert!(parse_cetch(&[0x27u8, 0x02, b'H', b'I', 0x00]).is_none(), "T_PETCH opcode rejected");
        assert!(parse_cetch(&env[..auth_off + 10]).is_none(), "truncated within mint_authority → None");
    }

    #[test]
    fn verify_etch_anchor_binds_asset_and_extracts_c0() {
        // Real m=1 classic-BP range proof over C_0 (fixtures/classic_bp/valid_m1_case0.json, value 0):
        // the anchor must range-verify C_0, so a synthetic non-point/empty-proof C_0 no longer anchors.
        let hx = |s: &str| hex::decode(s.trim().trim_start_matches("0x")).unwrap();
        let vj: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/classic_bp/valid_m1_case0.json")).unwrap();
        let c0: [u8; 33] = hx(vj["commitments"][0].as_str().unwrap()).try_into().unwrap();
        let rp = hx(vj["proof"].as_str().unwrap());

        let mut payload = vec![0x21u8, 0x03, b'T', b'A', b'C', 0x08];
        payload.extend_from_slice(&c0); // C_0
        payload.extend_from_slice(&[0u8; 8]); // amount_ct
        payload.extend_from_slice(&(rp.len() as u16).to_le_bytes()); // rp_len (LE)
        payload.extend_from_slice(&rp); // range proof over [C_0]
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

        // a tampered C_0 range proof no longer anchors.
        let mut bad = payload.clone();
        let rp_off = 6 + 33 + 8 + 2; // opcode..decimals(6) + C_0(33) + amount_ct(8) + rp_len(2)
        bad[rp_off + 40] ^= 0x01;
        let bad_tx = build_reveal_tx(&bad);
        let bad_id = asset_id_from_etch(&bad_tx).unwrap();
        assert!(verify_etch_anchor(&bad_tx, &bad_id).is_none(), "tampered C_0 range proof rejected");
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
    fn is_coinbase_rejects_merge_blob_as_fake_coinbase() {
        // A real coinbase (1 input, null prevout, 0xffffffff vout) is recognized; a structurally
        // valid 64-byte NON-coinbase tx and a raw 64-byte merge blob are both rejected as coinbases.
        let mut cb = vec![0x01u8, 0, 0, 0]; // version
        cb.push(0x01); // in_count = 1
        cb.extend_from_slice(&[0u8; 32]); // null prevout txid
        cb.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // prevout vout = 0xffffffff
        cb.push(0x00); // scriptSig len 0
        cb.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // sequence
        cb.push(0x01); cb.extend_from_slice(&[0u8; 8]); cb.push(0x00); // 1 output, value 0, empty script
        cb.extend_from_slice(&[0, 0, 0, 0]); // locktime
        assert!(is_coinbase(&cb), "a real coinbase is recognized");

        // a valid 64-byte non-witness tx with a zero (but NOT 0xffffffff) prevout vout — parses, not a coinbase.
        let mut tx64 = vec![0x02u8, 0, 0, 0];
        tx64.push(0x01);
        tx64.extend_from_slice(&[0u8; 36]); // prevout txid=0, vout=0x00000000 (not 0xffffffff)
        tx64.push(0x00);
        tx64.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);
        tx64.push(0x01);
        tx64.extend_from_slice(&[0u8; 8]);
        tx64.push(0x04);
        tx64.extend_from_slice(&[0x51, 0x52, 0x53, 0x54]);
        tx64.extend_from_slice(&[0, 0, 0, 0]);
        assert_eq!(tx64.len(), 64);
        assert!(compute_txid(&tx64).is_some(), "the 64-byte tx still parses (liveness)");
        assert!(!is_coinbase(&tx64), "a valid 64-byte non-coinbase tx is NOT a coinbase (vout != 0xffffffff)");

        // a raw merge-blob shape (random bytes) is not a coinbase (its prevout is not the null outpoint).
        assert!(!is_coinbase(&[0xeeu8; 64]), "a 64-byte merge blob is not a coinbase");
    }

    #[test]
    fn extract_taproot_envelope_supports_pushdata4() {
        // A Tacit reveal whose payload is pushed via OP_PUSHDATA4 (consensus-valid in a Taproot script)
        // must extract identically — else a valid user action is silently ignored by reflection.
        let inner = vec![0x2Bu8; 300]; // payload after the "TACIT\x01" frame (content irrelevant to extraction)
        let mut script = Vec::new();
        script.push(0x20); script.extend_from_slice(&[0u8; 32]); // PUSH(32) x-only pubkey
        script.push(0xac); // OP_CHECKSIG
        script.push(0x00); script.push(0x63); // OP_FALSE OP_IF
        script.push(0x05); script.extend_from_slice(b"TACIT");
        script.push(0x01); script.push(0x01); // frame: "TACIT" ‖ 0x01
        script.push(0x4e); // OP_PUSHDATA4
        script.extend_from_slice(&(inner.len() as u32).to_le_bytes());
        script.extend_from_slice(&inner);
        script.push(0x68); // OP_ENDIF
        // wrap as a reveal tx (same shape as build_reveal_tx)
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
        if sl < 0xfd { tx.push(sl as u8); } else { tx.push(0xfd); tx.extend_from_slice(&(sl as u16).to_le_bytes()); }
        tx.extend_from_slice(&script);
        tx.push(0x21); tx.extend_from_slice(&[0xc0; 0x21]);
        tx.extend_from_slice(&[0u8; 4]);
        let env = extract_taproot_envelope(&tx).expect("PUSHDATA4 reveal extracts");
        assert_eq!(env, inner, "extracted envelope (after frame) == the PUSHDATA4 payload");
    }

    #[test]
    fn extracts_confidential_burn_envelope() {
        // 0x2B = confidential bridge-burn envelope (BTC→ETH), opcode at index 0.
        let mut payload = vec![0x2B_u8];
        payload.extend_from_slice(&[0x11u8; 32]); // assetId
        payload.extend_from_slice(&[0x22u8; 32]); // bitcoin pool root
        payload.extend_from_slice(&[0x33u8; 32]); // nullifier
        payload.extend_from_slice(&[0x44u8; 32]); // dest commitment (ETH leaf)
        payload.extend_from_slice(&[0x7cu8; 32]); // target chain binding
        let tx = build_reveal_tx(&payload);
        let got = extract_taproot_envelope(&tx).expect("Some for valid reveal");
        assert_eq!(got[0], 0x2B, "opcode preserved at index 0");
        assert_eq!(got.len(), payload.len(), "payload round-trips");
        assert_eq!(&got[65..97], &[0x33u8; 32], "nullifier intact");

        // the reflection prover parses (assetId, ν, destCommitment, target) out of it
        let (asset, nu, dest, target) = parse_burn_envelope(&got).expect("burn parse");
        assert_eq!(asset, [0x11u8; 32], "assetId");
        assert_eq!(nu, [0x33u8; 32], "nullifier");
        assert_eq!(dest, [0x44u8; 32], "destCommitment");
        assert_eq!(target, [0x7cu8; 32], "targetChainBinding");
        // wrong opcode / short payload reject
        assert!(parse_burn_envelope(&[0x23u8; 161]).is_none(), "non-burn opcode rejected");
        assert!(parse_burn_envelope(&got[..160]).is_none(), "truncated payload rejected");
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

    // T_CXFER_BOUND (0x39): the generation-bound CXFER wire shape — target(32) prepended to the T_CXFER body.
    #[test]
    fn parse_cxfer_bound_envelope_roundtrip() {
        // 0x39 ‖ target(32) ‖ asset(32) ‖ kernel_sig(64) ‖ N ‖ N×(commitment33 ‖ amount8) ‖ rpLen ‖ rp
        let mut env = vec![0x39u8];
        env.extend_from_slice(&[0x7Cu8; 32]); // target_chain_binding
        env.extend_from_slice(&[0xAAu8; 32]); // assetId
        env.extend_from_slice(&[0xBBu8; 64]); // kernel_sig
        env.push(2); // N = 2
        let c0 = [0x02u8; 33];
        let c1 = [0x03u8; 33];
        env.extend_from_slice(&c0); env.extend_from_slice(&[0u8; 8]);
        env.extend_from_slice(&c1); env.extend_from_slice(&[0u8; 8]);
        let rp = [0x77u8; 5];
        env.extend_from_slice(&(rp.len() as u16).to_le_bytes());
        env.extend_from_slice(&rp);

        let (target, asset, ks, comms, rpo) = parse_cxfer_bound_envelope(&env).expect("bound cxfer parse");
        assert_eq!(target, [0x7Cu8; 32], "target_chain_binding");
        assert_eq!(asset, [0xAAu8; 32], "assetId");
        assert_eq!(ks, [0xBBu8; 64], "kernel_sig");
        assert_eq!(comms, vec![c0, c1], "the two output commitments");
        assert_eq!(rpo, rp.to_vec(), "range proof");
        // 0x39 is NOT a v1 cxfer (parse_cxfer_envelope_full rejects it) — disjoint opcode spaces, no ambiguity.
        assert!(parse_cxfer_envelope_full(&env).is_none(), "0x39 is not a v1 cxfer");
        // wrong opcode / invalid N reject
        let mut bad = env.clone(); bad[0] = 0x23;
        assert!(parse_cxfer_bound_envelope(&bad).is_none(), "non-bound opcode rejected");
        let mut badn = env.clone(); badn[129] = 3;
        assert!(parse_cxfer_bound_envelope(&badn).is_none(), "invalid output count");
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

    // BIP-141 anti-merkle-collision + liveness. A merkle internal node is
    // H(left)‖H(right) = 64 bytes, so a 64-byte blob could masquerade as a tx to merge a subtree away. The
    // mitigation must NOT blanket-reject all 64-byte txs (that panics the reflection full-scan on a REAL
    // consensus-valid 64-byte tx → permanent forward-chain stall); instead it admits a 64-byte blob iff it
    // parses as a complete, well-formed tx — real txs flow, the ≈random internal-node blob is still rejected.
    #[test]
    fn compute_txid_64byte_disambiguation() {
        // A non-parseable 64-byte blob (the collision case — random hash-like bytes) is rejected.
        let collision64 = vec![0xeeu8; 64]; // [4]/[5] != marker/flag; does not parse as a tx of length 64
        assert!(compute_txid(&collision64).is_none(), "non-parseable 64-byte blob rejected (anti-merkle-collision)");

        // A STRUCTURALLY-VALID 64-byte non-witness tx is now ADMITTED: 1 empty-scriptSig input + 1
        // output with a 4-byte script. version(4)+in_count(1)+prevout(36)+sslen(1)+seq(4)+out_count(1)+value(8)
        // +pklen(1)+script(4)+locktime(4) = 64. byte[4]=0x01 (in_count) ⇒ not segwit.
        let mut tx64 = vec![0x02u8, 0, 0, 0]; // version
        tx64.push(0x01); // in_count = 1
        tx64.extend_from_slice(&[0u8; 36]); // prevout
        tx64.push(0x00); // scriptSig len 0
        tx64.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // sequence
        tx64.push(0x01); // out_count = 1
        tx64.extend_from_slice(&[0u8; 8]); // value
        tx64.push(0x04); // scriptPubKey len 4
        tx64.extend_from_slice(&[0x51, 0x52, 0x53, 0x54]); // 4-byte script
        tx64.extend_from_slice(&[0, 0, 0, 0]); // locktime
        assert_eq!(tx64.len(), 64);
        assert!(compute_txid(&tx64).is_some(), "structurally-valid 64-byte non-witness tx is admitted");

        // a 64-byte buffer that *looks* segwit (marker+flag at [4],[5]) but has a 0x00 input_count is malformed
        // (≥1 input required) — exactness rejects it, like Bitcoin's empty-vin rule.
        let mut fake_segwit64 = vec![0x02u8, 0, 0, 0, 0x00, 0x01];
        fake_segwit64.extend_from_slice(&[0u8; 58]);
        assert_eq!(fake_segwit64.len(), 64);
        assert!(compute_txid(&fake_segwit64).is_none(), "0-input segwit-shaped buffer rejected");

        // A SEGWIT tx whose STRIPPED serialization is exactly 64 bytes is also admitted: the stripped
        // form is a real, well-formed tx (we just walked it). Full length 67, stripped = version(4)+58+locktime(4).
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
        assert!(compute_txid(&sw).is_some(), "segwit tx with a well-formed 64-byte stripped form is admitted");
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

    // Coinbase witness: the coinbase wtxid is fixed to zero by BIP141, so its witness is the
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

    // Panic-freedom over EVERY attacker-facing envelope/tx parser. The reflection guest runs these on tx and
    // witness bytes lifted verbatim from confirmed Bitcoin blocks — bytes an adversary authors for free. A
    // single reachable panic in any of them is a permanent, unrecoverable halt of an unpausable chain, so the
    // contract is: on ANY input, return None/Err — never panic, never index out of bounds, never overflow.
    // This feeds each parser empty input, every truncation prefix of a structured buffer, opcode-tagged
    // runaway-length envelopes, and a large deterministic pseudo-random corpus. A panic here fails the test;
    // if one ever fires it is a real halt finding, not a test bug.
    #[test]
    fn every_parser_is_panic_free_on_adversarial_bytes() {
        // Deterministic corpus — no rand/clock (they would break replay). A splitmix64-style LCG.
        let mut st: u64 = 0x9E3779B97F4A7C15;
        let mut next = || { st = st.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); st };
        let mut corpus: Vec<Vec<u8>> = Vec::new();
        corpus.push(Vec::new()); // empty
        // Every truncation prefix of a pseudo-random 600-byte buffer (catches off-by-one length reads).
        let long: Vec<u8> = (0..600).map(|_| (next() >> 33) as u8).collect();
        for n in 0..=long.len() { corpus.push(long[..n].to_vec()); }
        // Opcode-tagged runaway-length envelopes: each known leading tag byte, then a varint claiming a huge
        // length, then a short/absent tail — the classic "length says 4GB, buffer has 8 bytes" slice trap.
        for tag in [0x22u8, 0x23, 0x2B, 0x2F, 0x33, 0x37, 0x3D, 0x39, 0x65, 0x69, 0x00, 0xff] {
            for pre in [vec![0xffu8], vec![0xfe], vec![0xfd], vec![0x80]] {
                let mut b = vec![tag]; b.extend_from_slice(&pre);
                b.extend_from_slice(&0xffff_ffff_ffff_ffffu64.to_le_bytes());
                b.extend_from_slice(&[0xAB; 8]);
                corpus.push(b);
            }
        }
        // 6000 random buffers of random length ≤ 800.
        for _ in 0..6000 {
            let len = (next() % 801) as usize;
            corpus.push((0..len).map(|_| (next() >> 33) as u8).collect());
        }

        // Every parser, uniformly wrapped so a panic in any of them fails this test.
        type P<'a> = (&'a str, Box<dyn Fn(&[u8])>);
        let parsers: Vec<P> = vec![
            ("compute_txid", Box::new(|b| { let _ = compute_txid(b); })),
            ("extract_taproot_envelope", Box::new(|b| { let _ = extract_taproot_envelope(b); })),
            ("extract_inputs", Box::new(|b| { let _ = extract_inputs(b); })),
            ("extract_outputs", Box::new(|b| { let _ = extract_outputs(b); })),
            ("parse_tx_output", Box::new(|b| { let _ = parse_tx_output(b, 0); let _ = parse_tx_output(b, 1); })),
            ("asset_id_from_etch", Box::new(|b| { let _ = asset_id_from_etch(b); })),
            ("parse_etch_meta", Box::new(|b| { let _ = parse_etch_meta(b); })),
            ("parse_cetch", Box::new(|b| { let _ = parse_cetch(b); })),
            ("parse_cmint", Box::new(|b| { let _ = parse_cmint(b); })),
            ("parse_burn_envelope", Box::new(|b| { let _ = parse_burn_envelope(b); })),
            ("parse_crossout_mint_envelope", Box::new(|b| { let _ = parse_crossout_mint_envelope(b); })),
            ("parse_cbtc_lock_envelope", Box::new(|b| { let _ = parse_cbtc_lock_envelope(b); })),
            ("parse_btc_call_envelope", Box::new(|b| { let _ = parse_btc_call_envelope(b); })),
            ("parse_eth_call_envelope", Box::new(|b| { let _ = parse_eth_call_envelope(b); })),
            ("parse_cbtc_redeem_envelope", Box::new(|b| { let _ = parse_cbtc_redeem_envelope(b); })),
            ("parse_swap_var_envelope", Box::new(|b| { let _ = parse_swap_var_envelope(b); })),
            ("parse_cxfer_envelope", Box::new(|b| { let _ = parse_cxfer_envelope(b); })),
            ("parse_cxfer_envelope_full", Box::new(|b| { let _ = parse_cxfer_envelope_full(b); })),
            ("parse_cxfer_bound_envelope", Box::new(|b| { let _ = parse_cxfer_bound_envelope(b); })),
            ("parse_preauth_bid_var_envelope", Box::new(|b| { let _ = parse_preauth_bid_var_envelope(b); })),
            ("parse_preauth_bid_envelope", Box::new(|b| { let _ = parse_preauth_bid_envelope(b); })),
            ("parse_lp_add_envelope", Box::new(|b| { let _ = parse_lp_add_envelope(b); })),
            ("parse_lp_remove_envelope", Box::new(|b| { let _ = parse_lp_remove_envelope(b); })),
            ("parse_farm_init_envelope", Box::new(|b| { let _ = parse_farm_init_envelope(b); })),
            ("parse_lp_harvest_envelope", Box::new(|b| { let _ = parse_lp_harvest_envelope(b); })),
            ("parse_lp_bond_fields", Box::new(|b| { let _ = parse_lp_bond_fields(b); })),
            ("parse_lp_bond_fields_full", Box::new(|b| { let _ = parse_lp_bond_fields_full(b); })),
            ("parse_lp_unbond_fields", Box::new(|b| { let _ = parse_lp_unbond_fields(b); })),
            ("parse_farm_refund_envelope", Box::new(|b| { let _ = parse_farm_refund_envelope(b); })),
            ("parse_farm_refund_envelope_full", Box::new(|b| { let _ = parse_farm_refund_envelope_full(b); })),
            ("parse_protocol_fee_claim_envelope", Box::new(|b| { let _ = parse_protocol_fee_claim_envelope(b); })),
            ("parse_swap_batch_envelope", Box::new(|b| { let _ = parse_swap_batch_envelope(b); })),
            ("parse_swap_route_envelope", Box::new(|b| { let _ = parse_swap_route_envelope(b); })),
        ];

        for (_name, run) in &parsers {
            for input in &corpus {
                run(input); // any panic / OOB / overflow here fails the test with a backtrace naming the input
            }
        }
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

    // The CHECKED merkle root (used on every consensus-admission path) rejects the duplicate-tail
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

    // Destination binding: per-input witness sighash inspection over a multi-input SegWit tx.
    // Builds a tx whose vin[i] spends outpoint (txid=i, vout=i) and carries `sigs[i]` as its first
    // (only) witness item; one output. Exercises note_spends_bind_outputs' scoping + sig_binds_all_outputs.
    #[test]
    fn note_spends_sighash_binding() {
        fn build(sigs: &[&[u8]]) -> (Vec<u8>, Vec<([u8; 32], u32)>) {
            let n = sigs.len();
            let mut t = vec![0x02u8, 0, 0, 0, 0x00, 0x01]; // version, marker, flag
            t.push(n as u8); // input_count
            let mut ops = Vec::new();
            for i in 0..n {
                let mut txid = [0u8; 32];
                txid[0] = i as u8;
                t.extend_from_slice(&txid);
                t.extend_from_slice(&(i as u32).to_le_bytes()); // vout = i
                t.push(0x00); // scriptSig len 0
                t.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]); // sequence
                ops.push((txid, i as u32));
            }
            t.push(0x01); // output_count = 1
            t.extend_from_slice(&[0u8; 8]); // value 0
            t.push(0x01); t.push(0x51); // OP_1
            for s in sigs {
                t.push(0x01); // 1 witness item
                t.push(s.len() as u8);
                t.extend_from_slice(s);
            }
            t.extend_from_slice(&[0, 0, 0, 0]); // locktime
            (t, ops)
        }

        let default_sig = [0xABu8; 64]; // Taproot SIGHASH_DEFAULT (implicit ALL)
        let all_sig = [&[0xABu8; 64][..], &[0x01]].concat(); // Taproot 65-byte SIGHASH_ALL
        let all_acp = [&[0xABu8; 64][..], &[0x81]].concat(); // SIGHASH_ALL|ANYONECANPAY
        let mut der_all = vec![0x30u8; 71];
        *der_all.last_mut().unwrap() = 0x01; // ECDSA DER‖SIGHASH_ALL
        let single_acp = [&[0xABu8; 64][..], &[0x83]].concat(); // adaptor SIGHASH_SINGLE|ANYONECANPAY
        let none_acp = [&[0xABu8; 64][..], &[0x82]].concat(); // SIGHASH_NONE|ANYONECANPAY
        let single = [&[0xABu8; 64][..], &[0x03]].concat(); // SIGHASH_SINGLE
        let none = [&[0xABu8; 64][..], &[0x02]].concat(); // SIGHASH_NONE

        assert!(sig_binds_all_outputs(&default_sig), "64-byte Schnorr = DEFAULT binds all");
        assert!(sig_binds_all_outputs(&all_sig), "0x01 = SIGHASH_ALL binds all");
        assert!(sig_binds_all_outputs(&all_acp), "0x81 = SIGHASH_ALL|ANYONECANPAY binds all");
        assert!(sig_binds_all_outputs(&der_all), "ECDSA DER‖0x01 binds all");
        assert!(!sig_binds_all_outputs(&single_acp), "0x83 does NOT bind all");
        assert!(!sig_binds_all_outputs(&none_acp), "0x82 does NOT bind all");
        assert!(!sig_binds_all_outputs(&single), "0x03 SINGLE does NOT bind all");
        assert!(!sig_binds_all_outputs(&none), "0x02 NONE does NOT bind all");
        assert!(!sig_binds_all_outputs(&[]), "empty sig does NOT bind all");

        // All-conforming note spends → bound.
        let (tx, ops) = build(&[&default_sig, &der_all]);
        assert!(note_spends_bind_outputs(&tx, &ops), "DEFAULT + DER-ALL note spends are bound");

        // A pure-CXFER-style tx with a bad-sighash note input → REJECTED (would skip the fold).
        let (tx, ops) = build(&[&default_sig, &single]);
        assert!(!note_spends_bind_outputs(&tx, &ops), "a SIGHASH_SINGLE note input fails the bind gate");

        // SCOPING proof: a tx carrying a 0x83 adaptor spend at vin[1] is UNAFFECTED when only vin[0]
        // (the note the fold consumes) is passed — the 0x83 input is never inspected. This is the
        // adaptor lane the caller excludes by opcode; even if inspected here, only listed outpoints gate.
        let (tx, all_ops) = build(&[&default_sig, &single_acp]);
        assert!(note_spends_bind_outputs(&tx, &all_ops[..1]), "adaptor 0x83 input at vin[1] does not fire when unlisted");
        assert!(!note_spends_bind_outputs(&tx, &all_ops), "listing the 0x83 input would reject it");

        // An outpoint absent from the vin → fail-closed.
        assert!(!note_spends_bind_outputs(&tx, &[([0x99u8; 32], 7)]), "unknown outpoint is not bound");

        // Legacy (non-segwit) tx → no witness → fail-closed.
        let legacy = {
            let mut t = vec![0x02u8, 0, 0, 0, 0x01]; // version, input_count=1 (no marker/flag)
            t.extend_from_slice(&[0u8; 36]); // prevout (txid=0, vout=0)
            t.push(0x00); t.extend_from_slice(&[0xff, 0xff, 0xff, 0xff]);
            t.push(0x01); t.extend_from_slice(&[0u8; 8]); t.push(0x01); t.push(0x51);
            t.extend_from_slice(&[0, 0, 0, 0]);
            t
        };
        assert!(!note_spends_bind_outputs(&legacy, &[([0u8; 32], 0)]), "legacy note spend has no witness sighash");
    }
}
