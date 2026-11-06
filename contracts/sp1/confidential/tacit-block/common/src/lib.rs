//! A Tacit block's state transition, shared by the block guest and its host.
//!
//! A block checks many Halo2 spend proofs (btc-pool-halo2, the Bitcoin pool's spend relation) and moves one
//! state by all of them:
//! - every non-zero nullifier enters the nullifier tree, a sorted list of records in a depth-32 Merkle tree,
//!   so a note spent in this block or in any earlier one cannot be spent again;
//! - the block's new notes join the Poseidon note tree sorted by value, so a note's position does not say
//!   which spend made it.
//!
//! A spend's anchor, the note root its inputs are proven against, is checked against the last `RECENT` roots the
//! state remembers; only an older one is listed in `anchors`, for whoever lands the block to check against the
//! roots it has seen. So the anchors nearly every spend uses never reach a public list that would say when the
//! spend was proven.

use btc_pool_halo2::model::{poseidon, zeros, TREE_DEPTH};
use ff::{Field, PrimeField};
use halo2_proofs::halo2curves::bn256::Fr;
use sha2::digest::generic_array::GenericArray;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

/// Levels of the nullifier tree: room for 2^32 records.
pub const NF_LEVELS: usize = 32;
/// How many of the latest note roots a block accepts as anchors without listing them.
pub const RECENT: usize = 32;
/// `State::to_bytes`: note root, leaf count (u64 BE), the 32 filled nodes, nullifier root, record count, recent roots.
pub const STATE_LEN: usize = 32 + 8 + 32 * TREE_DEPTH + 32 + 8 + 32 * RECENT;
/// `NfWitness::to_bytes`: low value, low next, low index (u64 BE), low path, slot path.
pub const NF_WITNESS_LEN: usize = 32 + 32 + 8 + 2 * 32 * NF_LEVELS;

const STATE_DOMAIN: &[u8] = b"tacit-block-state-v1";
const LIST_DOMAIN: &[u8] = b"tacit-block-list-v1";
const VK_DOMAIN: &[u8] = b"tacit-block-vk-v1";
const SHA256_IV: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/// Cycle-tracker markers in the zkVM (the executor sums each name); nothing elsewhere.
macro_rules! mark {
    ($line:literal) => {
        #[cfg(target_os = "zkvm")]
        println!($line);
    };
}

pub fn fr_be(x: &Fr) -> [u8; 32] {
    let mut b = [0u8; 32];
    b.copy_from_slice(x.to_repr().as_ref());
    b.reverse();
    b
}

/// A canonical (below r) 32-byte big-endian field element.
pub fn fr_from_be(b: &[u8]) -> Option<Fr> {
    if b.len() != 32 {
        return None;
    }
    let mut r = [0u8; 32];
    for i in 0..32 {
        r[i] = b[31 - i];
    }
    Option::from(Fr::from_repr(r))
}

/// The note tree's node hash, Poseidon(a, b) as btc-pool-halo2 computes it. In the zkVM it runs on canonical
/// residues with one uint256_mulmod per product (the field type's Montgomery products take two).
pub fn node_hash(a: &Fr, b: &Fr) -> Fr {
    #[cfg(target_os = "zkvm")]
    {
        return zk::poseidon2(a, b);
    }
    #[allow(unreachable_code)]
    poseidon(&[*a, *b])
}

/// The note tree's constants as `tacit-block pin` writes artifacts/note-tree.bin: Poseidon's t = 3 round
/// constants (round-major) and MDS matrix (row-major), then the empty subtree roots from the leaf level up, each
/// 32 little-endian canonical bytes. The zkVM reads them from the file instead of parsing them.
pub fn note_tree_consts() -> Vec<u8> {
    use btc_pool_halo2::model::{mds, partial_rounds, round_constant, FULL_ROUNDS};
    let mut b = vec![];
    for k in 0..(FULL_ROUNDS + partial_rounds(3)) * 3 {
        b.extend_from_slice(round_constant(3, k / 3, k % 3).to_repr().as_ref());
    }
    for i in 0..3 {
        for j in 0..3 {
            b.extend_from_slice(mds(3, i, j).to_repr().as_ref());
        }
    }
    for z in zeros() {
        b.extend_from_slice(z.to_repr().as_ref());
    }
    b
}

#[cfg(target_os = "zkvm")]
mod zk {
    use super::*;
    use btc_pool_halo2::model::{partial_rounds, FULL_ROUNDS};

    const NOTE_TREE: &[u8] = include_bytes!("../../artifacts/note-tree.bin");

    type U = [u64; 4];
    /// The BN254 scalar field's modulus r, little-endian limbs.
    const P: U = [0x43e1f593f0000001, 0x2833e84879b97091, 0xb85045b68181585d, 0x30644e72e131a029];

    fn at(i: usize) -> U {
        let b = &NOTE_TREE[32 * i..32 * i + 32];
        [0, 1, 2, 3].map(|k| u64::from_le_bytes(b[8 * k..8 * k + 8].try_into().unwrap()))
    }

    fn limbs(x: &Fr) -> U {
        let r = x.to_repr();
        let b = r.as_ref();
        [0, 1, 2, 3].map(|i| u64::from_le_bytes(b[8 * i..8 * i + 8].try_into().unwrap()))
    }

    fn fr(x: &U) -> Fr {
        let mut b = [0u8; 32];
        for i in 0..4 {
            b[8 * i..8 * i + 8].copy_from_slice(&x[i].to_le_bytes());
        }
        Option::from(Fr::from_repr(b)).expect("a residue below r")
    }

    /// a + b mod r for a, b < r < 2^254: the sum fits in 256 bits, and r comes off at most once.
    #[inline(always)]
    fn add(a: &U, b: &U) -> U {
        let mut s = [0u64; 4];
        let mut carry = 0u64;
        for i in 0..4 {
            let (x, c1) = a[i].overflowing_add(b[i]);
            let (y, c2) = x.overflowing_add(carry);
            s[i] = y;
            carry = c1 as u64 + c2 as u64;
        }
        let mut below = false;
        for i in (0..4).rev() {
            if s[i] != P[i] {
                below = s[i] < P[i];
                break;
            }
        }
        if !below {
            let mut borrow = 0u64;
            for i in 0..4 {
                let (x, b1) = s[i].overflowing_sub(P[i]);
                let (y, b2) = x.overflowing_sub(borrow);
                s[i] = y;
                borrow = b1 as u64 + b2 as u64;
            }
        }
        s
    }

    #[inline(always)]
    fn mul(a: &U, b: &U) -> U {
        let mut x = *a;
        let y: [u64; 8] = [b[0], b[1], b[2], b[3], P[0], P[1], P[2], P[3]];
        unsafe { sp1_lib::syscall_uint256_mulmod(&mut x, y.as_ptr() as *const [u64; 4]) };
        x
    }

    fn pow5(x: &U) -> U {
        let x2 = mul(x, x);
        let x4 = mul(&x2, &x2);
        mul(&x4, x)
    }

    struct Tables {
        c: Vec<U>,
        m: [[U; 3]; 3],
        partial: usize,
    }

    fn tables() -> &'static Tables {
        static T: OnceLock<Tables> = OnceLock::new();
        T.get_or_init(|| {
            let partial = partial_rounds(3);
            let n = (FULL_ROUNDS + partial) * 3;
            assert_eq!(NOTE_TREE.len(), 32 * (n + 9 + TREE_DEPTH + 1), "note-tree.bin");
            let c = (0..n).map(at).collect();
            let mut m = [[[0u64; 4]; 3]; 3];
            for (i, row) in m.iter_mut().enumerate() {
                for (j, e) in row.iter_mut().enumerate() {
                    *e = at(n + 3 * i + j);
                }
            }
            Tables { c, m, partial }
        })
    }

    /// circomlib Poseidon(a, b): state [0, a, b], 8 full rounds around 57 partial, output state[0].
    pub fn poseidon2(a: &Fr, b: &Fr) -> Fr {
        let t = tables();
        let half = FULL_ROUNDS / 2;
        let mut s = [[0u64; 4], limbs(a), limbs(b)];
        for r in 0..FULL_ROUNDS + t.partial {
            for j in 0..3 {
                s[j] = add(&s[j], &t.c[r * 3 + j]);
            }
            if r < half || r >= half + t.partial {
                for x in s.iter_mut() {
                    *x = pow5(x);
                }
            } else {
                s[0] = pow5(&s[0]);
            }
            let mut n = [[0u64; 4]; 3];
            for (i, row) in t.m.iter().enumerate() {
                n[i] = add(&add(&mul(&row[0], &s[0]), &mul(&row[1], &s[1])), &mul(&row[2], &s[2]));
            }
            s = n;
        }
        fr(&s[0])
    }

    /// The empty subtree roots from note-tree.bin.
    pub fn zeros() -> [Fr; TREE_DEPTH + 1] {
        let base = (FULL_ROUNDS + partial_rounds(3)) * 3 + 9;
        let mut z = [Fr::ZERO; TREE_DEPTH + 1];
        for (i, x) in z.iter_mut().enumerate() {
            *x = fr(&at(base + i));
        }
        z
    }
}

/// The note tree's empty subtree roots: btc-pool-halo2's `zeros`, read from note-tree.bin in the zkVM.
fn note_zeros() -> &'static [Fr; TREE_DEPTH + 1] {
    static Z: OnceLock<[Fr; TREE_DEPTH + 1]> = OnceLock::new();
    #[cfg(target_os = "zkvm")]
    return Z.get_or_init(zk::zeros);
    #[allow(unreachable_code)]
    Z.get_or_init(|| *zeros())
}

/// The note tree as a block carries it: the node at each level that a later leaf pairs with on its left, the
/// leaf count and the root.
#[derive(Clone, Debug, PartialEq)]
pub struct Notes {
    pub filled: [Fr; TREE_DEPTH],
    pub len: u64,
    pub root: Fr,
}

impl Default for Notes {
    fn default() -> Self {
        Notes { filled: [Fr::ZERO; TREE_DEPTH], len: 0, root: zeros()[TREE_DEPTH] }
    }
}

impl Notes {
    /// Appends `leaves` in order, one pass per level: about k + 32 hashes for k leaves. The tree is the one
    /// btc-pool-halo2's `Tree` builds from every leaf, with the empty subtree's zero where nothing is.
    pub fn append(&mut self, leaves: &[Fr]) -> Result<(), &'static str> {
        if leaves.is_empty() {
            return Ok(());
        }
        let end = self.len.checked_add(leaves.len() as u64).filter(|e| *e <= 1u64 << TREE_DEPTH).ok_or("note tree full")?;
        let z = note_zeros();
        let mut pos = self.len;
        let mut level = leaves.to_vec();
        for d in 0..TREE_DEPTH {
            let mut up = Vec::with_capacity(level.len() / 2 + 1);
            let mut i = 0;
            if pos & 1 == 1 {
                up.push(node_hash(&self.filled[d], &level[0]));
                i = 1;
            }
            while i < level.len() {
                self.filled[d] = level[i];
                up.push(node_hash(&level[i], if i + 1 < level.len() { &level[i + 1] } else { &z[d] }));
                i += 2;
            }
            level = up;
            pos >>= 1;
        }
        self.root = level[0];
        self.len = end;
        Ok(())
    }
}

/// The nullifier tree's hash: SHA-256's compression function on the one 64-byte block a ‖ b, from SHA-256's IV.
pub fn h64(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut block = [0u8; 64];
    block[..32].copy_from_slice(a);
    block[32..].copy_from_slice(b);
    let mut s = SHA256_IV;
    sha2::compress256(&mut s, &[GenericArray::from(block)]);
    let mut out = [0u8; 32];
    for (i, w) in s.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&w.to_be_bytes());
    }
    out
}

/// A record's leaf: its value and the next value up in the list (zero after the largest).
pub fn nf_record(value: &[u8; 32], next: &[u8; 32]) -> [u8; 32] {
    h64(value, next)
}

/// The nullifier tree's empty subtree roots, the empty slot (32 zero bytes) first.
pub fn nf_zeros() -> &'static [[u8; 32]; NF_LEVELS + 1] {
    static Z: OnceLock<[[u8; 32]; NF_LEVELS + 1]> = OnceLock::new();
    Z.get_or_init(|| {
        let mut z = [[0u8; 32]; NF_LEVELS + 1];
        for i in 1..=NF_LEVELS {
            z[i] = h64(&z[i - 1], &z[i - 1]);
        }
        z
    })
}

pub fn nf_root_of(node: &[u8; 32], index: u64, path: &[[u8; 32]]) -> [u8; 32] {
    let mut cur = *node;
    for (d, s) in path.iter().enumerate() {
        cur = if (index >> d) & 1 == 1 { h64(s, &cur) } else { h64(&cur, s) };
    }
    cur
}

/// The tree before any spend: the list's head record (0, 0) at index 0.
pub fn nf_genesis_root() -> [u8; 32] {
    nf_root_of(&nf_record(&[0u8; 32], &[0u8; 32]), 0, &nf_zeros()[..NF_LEVELS])
}

/// What marking one nullifier spent needs: the record just below it in value order, that record's path, and
/// the path of the first free slot once that record points at the new value.
#[derive(Clone, Debug, PartialEq)]
pub struct NfWitness {
    pub low_value: [u8; 32],
    pub low_next: [u8; 32],
    pub low_index: u64,
    pub low_path: Vec<[u8; 32]>,
    pub slot_path: Vec<[u8; 32]>,
}

impl NfWitness {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(NF_WITNESS_LEN);
        b.extend_from_slice(&self.low_value);
        b.extend_from_slice(&self.low_next);
        b.extend_from_slice(&self.low_index.to_be_bytes());
        for s in self.low_path.iter().chain(&self.slot_path) {
            b.extend_from_slice(s);
        }
        b
    }

    pub fn from_bytes(b: &[u8]) -> Option<NfWitness> {
        if b.len() != NF_WITNESS_LEN {
            return None;
        }
        let path = |at: usize| -> Vec<[u8; 32]> { b[at..at + 32 * NF_LEVELS].chunks(32).map(|c| c.try_into().unwrap()).collect() };
        Some(NfWitness {
            low_value: b[..32].try_into().ok()?,
            low_next: b[32..64].try_into().ok()?,
            low_index: u64::from_be_bytes(b[64..72].try_into().ok()?),
            low_path: path(72),
            slot_path: path(72 + 32 * NF_LEVELS),
        })
    }
}

/// Marks `v` spent in the tree with root `root` and `size` records: the record below `v` must point past it,
/// so `v` is not in the list. That record then points at `v`, and `v`'s own record takes slot `size`.
pub fn nf_insert(root: &[u8; 32], size: u64, v: &[u8; 32], w: &NfWitness) -> Result<[u8; 32], &'static str> {
    if *v == [0u8; 32] {
        return Err("zero nullifier");
    }
    if size >= 1u64 << NF_LEVELS {
        return Err("nullifier tree full");
    }
    if w.low_path.len() != NF_LEVELS || w.slot_path.len() != NF_LEVELS {
        return Err("nullifier path length");
    }
    if nf_root_of(&nf_record(&w.low_value, &w.low_next), w.low_index, &w.low_path) != *root {
        return Err("the record below the nullifier is not in the tree");
    }
    if !(w.low_value < *v && (w.low_next == [0u8; 32] || *v < w.low_next)) {
        return Err("nullifier already spent");
    }
    let pointed = nf_root_of(&nf_record(&w.low_value, v), w.low_index, &w.low_path);
    if nf_root_of(&[0u8; 32], size, &w.slot_path) != pointed {
        return Err("the free slot's path is not the tree's");
    }
    Ok(nf_root_of(&nf_record(v, &w.low_next), size, &w.slot_path))
}

/// One spend proof's public inputs, in spend.circom's order: root, bodyHash, asset, nf[2], outLeaf[3],
/// exitC[2], depC[2]. An empty input slot has nullifier 0, an empty output slot leaf 0, and no exit or deposit
/// is the identity point (0, 1).
#[derive(Clone, Debug)]
pub struct Spend {
    pub root: Fr,
    pub body: Fr,
    pub asset: Fr,
    pub nf: [Fr; 2],
    pub out: [Fr; 3],
    pub exit: [Fr; 2],
    pub dep: [Fr; 2],
}

fn is_identity(p: &[Fr; 2]) -> bool {
    bool::from(p[0].is_zero()) && p[1] == Fr::ONE
}

impl Spend {
    pub fn from_publics(p: &[Fr]) -> Spend {
        assert_eq!(p.len(), 12, "twelve publics");
        Spend { root: p[0], body: p[1], asset: p[2], nf: [p[3], p[4]], out: [p[5], p[6], p[7]], exit: [p[8], p[9]], dep: [p[10], p[11]] }
    }

    pub fn live_nullifiers(&self) -> Vec<Fr> {
        self.nf.iter().copied().filter(|x| !bool::from(x.is_zero())).collect()
    }
}

/// What a block moves: the note tree, the nullifier tree's root and record count, and the last `RECENT` note
/// roots, newest last (an unused slot is zero, which no note root is).
#[derive(Clone, Debug, PartialEq)]
pub struct State {
    pub notes: Notes,
    pub nf_root: [u8; 32],
    pub nf_size: u64,
    pub recent: [[u8; 32]; RECENT],
}

impl Default for State {
    fn default() -> Self {
        let mut s = State { notes: Notes::default(), nf_root: nf_genesis_root(), nf_size: 1, recent: [[0u8; 32]; RECENT] };
        s.remember(fr_be(&s.notes.root));
        s
    }
}

impl State {
    /// Keeps `root` as the newest recent root, dropping the oldest (a root already newest is kept once).
    pub fn remember(&mut self, root: [u8; 32]) {
        if self.recent[RECENT - 1] != root {
            self.recent.rotate_left(1);
            self.recent[RECENT - 1] = root;
        }
    }

    pub fn knows(&self, root: &[u8; 32]) -> bool {
        *root != [0u8; 32] && self.recent.contains(root)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(STATE_LEN);
        b.extend_from_slice(&fr_be(&self.notes.root));
        b.extend_from_slice(&self.notes.len.to_be_bytes());
        for f in &self.notes.filled {
            b.extend_from_slice(&fr_be(f));
        }
        b.extend_from_slice(&self.nf_root);
        b.extend_from_slice(&self.nf_size.to_be_bytes());
        for r in &self.recent {
            b.extend_from_slice(r);
        }
        b
    }

    pub fn from_bytes(b: &[u8]) -> Option<State> {
        if b.len() != STATE_LEN {
            return None;
        }
        let root = fr_from_be(&b[..32])?;
        let len = u64::from_be_bytes(b[32..40].try_into().ok()?);
        let mut filled = [Fr::ZERO; TREE_DEPTH];
        for (d, f) in filled.iter_mut().enumerate() {
            *f = fr_from_be(&b[40 + 32 * d..72 + 32 * d])?;
        }
        let at = 40 + 32 * TREE_DEPTH;
        let nf_root = b[at..at + 32].try_into().ok()?;
        let nf_size = u64::from_be_bytes(b[at + 32..at + 40].try_into().ok()?);
        let mut recent = [[0u8; 32]; RECENT];
        for (i, r) in recent.iter_mut().enumerate() {
            r.copy_from_slice(&b[at + 40 + 32 * i..at + 72 + 32 * i]);
        }
        Some(State { notes: Notes { filled, len, root }, nf_root, nf_size, recent })
    }

    pub fn digest(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(STATE_DOMAIN);
        h.update(self.to_bytes());
        h.finalize().into()
    }
}

/// SHA-256(LIST_DOMAIN ‖ tag ‖ count (u64 BE) ‖ items…).
pub fn list_hash<T: AsRef<[u8]>>(tag: u8, items: &[T]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(LIST_DOMAIN);
    h.update([tag]);
    h.update((items.len() as u64).to_be_bytes());
    for x in items {
        h.update(x.as_ref());
    }
    h.finalize().into()
}

/// The spend relation a block takes, by its verifying key's BLAKE2b-512 digest.
pub fn vk_hash(vk_digest: &[u8; 64]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(VK_DOMAIN);
    h.update(vk_digest);
    h.finalize().into()
}

/// What a block proof commits, as twelve 32-byte words (`encode`).
#[derive(Clone, Debug, PartialEq)]
pub struct BlockOut {
    /// State digests before and after.
    pub prev: [u8; 32],
    pub next: [u8; 32],
    /// Note roots before and after: the starting root is every spend's default anchor, and the new root
    /// is the one later spends prove against.
    pub prev_root: [u8; 32],
    pub next_root: [u8; 32],
    pub spends: u64,
    pub leaves: u64,
    pub leaves_hash: [u8; 32],
    pub nullifiers_hash: [u8; 32],
    pub anchors_hash: [u8; 32],
    pub bodies_hash: [u8; 32],
    pub boundary_hash: [u8; 32],
    pub vk: [u8; 32],
}

fn word(n: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&n.to_be_bytes());
    w
}

impl BlockOut {
    pub fn encode(&self) -> Vec<u8> {
        [
            self.prev,
            self.next,
            self.prev_root,
            self.next_root,
            word(self.spends),
            word(self.leaves),
            self.leaves_hash,
            self.nullifiers_hash,
            self.anchors_hash,
            self.bodies_hash,
            self.boundary_hash,
            self.vk,
        ]
        .concat()
    }
}

/// The lists a block's hashes commit, in committed order: what a lander publishes so anyone can rebuild the
/// state and find their notes. Every list is sorted, so none of them says which spend an entry came from.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BlockData {
    /// New note leaves, in the order they join the tree.
    pub leaves: Vec<[u8; 32]>,
    pub nullifiers: Vec<[u8; 32]>,
    /// Distinct anchors older than the state's recent roots.
    pub anchors: Vec<[u8; 32]>,
    pub bodies: Vec<[u8; 32]>,
    /// The spends that cross the pool's boundary: bodyHash ‖ asset ‖ exitC ‖ depC, 192 bytes each.
    pub boundary: Vec<Vec<u8>>,
}

/// Applies a block's spends to `prev`, each spend's proof checked separately (the guest folds them into one
/// pairing). `nfw[j]` is the witness for the j-th non-zero nullifier, in spend order and slot order, against
/// the tree as the nullifiers before it left it.
pub fn apply(prev: &State, spends: &[Spend], nfw: &[NfWitness], vk: [u8; 32]) -> Result<(State, BlockOut, BlockData), String> {
    mark!("cycle-tracker-report-start: block-scan");
    let start = prev.notes.root;
    let mut leaves: Vec<Fr> = vec![];
    let mut spent: Vec<(usize, [u8; 32])> = vec![];
    let mut data = BlockData::default();
    for (i, s) in spends.iter().enumerate() {
        let live = s.live_nullifiers();
        if live.len() == 2 && live[0] == live[1] {
            return Err(format!("spend {i}: one note in both input slots"));
        }
        if live.is_empty() {
            if is_identity(&s.dep) {
                return Err(format!("spend {i}: no input and no deposit"));
            }
        } else if s.root != start && !prev.knows(&fr_be(&s.root)) {
            data.anchors.push(fr_be(&s.root));
        }
        spent.extend(live.iter().map(|nf| (i, fr_be(nf))));
        leaves.extend(s.out.iter().copied().filter(|o| !bool::from(o.is_zero())));
        data.bodies.push(fr_be(&s.body));
        if !is_identity(&s.exit) || !is_identity(&s.dep) {
            data.boundary.push([s.body, s.asset, s.exit[0], s.exit[1], s.dep[0], s.dep[1]].iter().flat_map(fr_be).collect());
        }
    }
    if spent.len() != nfw.len() {
        return Err(format!("{} nullifier witnesses for {} nullifiers", nfw.len(), spent.len()));
    }
    mark!("cycle-tracker-report-end: block-scan");

    mark!("cycle-tracker-report-start: block-nullifiers");
    let (mut nf_root, mut nf_size) = (prev.nf_root, prev.nf_size);
    for ((i, key), w) in spent.iter().zip(nfw) {
        nf_root = nf_insert(&nf_root, nf_size, key, w).map_err(|e| format!("spend {i}: {e}"))?;
        nf_size += 1;
        data.nullifiers.push(*key);
    }
    mark!("cycle-tracker-report-end: block-nullifiers");

    mark!("cycle-tracker-report-start: block-notes");
    leaves.sort_by_key(fr_be);
    let mut notes = prev.notes.clone();
    notes.append(&leaves)?;
    mark!("cycle-tracker-report-end: block-notes");

    mark!("cycle-tracker-report-start: block-commit");
    data.leaves = leaves.iter().map(fr_be).collect();
    data.nullifiers.sort();
    data.anchors.sort();
    data.anchors.dedup();
    data.bodies.sort();
    data.boundary.sort();
    let mut next = State { notes, nf_root, nf_size, recent: prev.recent };
    next.remember(fr_be(&next.notes.root));
    let out = BlockOut {
        prev: prev.digest(),
        next: next.digest(),
        prev_root: fr_be(&start),
        next_root: fr_be(&next.notes.root),
        spends: spends.len() as u64,
        leaves: data.leaves.len() as u64,
        leaves_hash: list_hash(1, &data.leaves),
        nullifiers_hash: list_hash(2, &data.nullifiers),
        anchors_hash: list_hash(3, &data.anchors),
        bodies_hash: list_hash(4, &data.bodies),
        boundary_hash: list_hash(5, &data.boundary),
        vk,
    };
    mark!("cycle-tracker-report-end: block-commit");
    Ok((next, out, data))
}
