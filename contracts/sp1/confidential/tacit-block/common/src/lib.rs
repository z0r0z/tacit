//! A Tacit block's state transition, shared by the block guest and its host.
//!
//! A block checks many Halo2 spend proofs (btc-pool-halo2, the Bitcoin pool's spend relation) and moves one
//! state by all of them:
//! - every non-zero nullifier enters the nullifier tree, a sorted list of records in a depth-32 Merkle tree, in
//!   ascending order, so a note spent in this block or in any earlier one cannot be spent again and the tree is
//!   the same whoever builds it from the published nullifiers;
//! - the block's new notes join the Poseidon note tree sorted by value, so a note's position does not say
//!   which spend made it.
//!
//! Each spend's body hash (which its inputs' owners sign) is checked against the tacit chain's body: the chain's
//! binding, the output leaves, their memo hashes, the address an exit pays and a salt the spender keeps. Deposits
//! and exits are opened here and committed as plain records (asset, value, and the body hash a depositor named or
//! the address an exit pays) for the contract that lands the block to match and pay. A body is never published;
//! a depositor's body hash is, and its salt keeps anyone from matching it to the outputs it names.
//!
//! A spend's anchor, the note root its inputs are proven against, is checked against the last `RECENT` roots the
//! state remembers; only an older one is listed in `anchors`, for whoever lands the block to check against the
//! roots it has seen. So the anchors nearly every spend uses never reach a public list that would say when the
//! spend was proven.
//!
//! What the lists cannot hide from whoever proves the block: which nullifiers, outputs, deposit and exit came
//! from the same spend, and each deposit's and exit's opening. A block proof before its final wrap is not
//! zero-knowledge, so it is never published.

use btc_pool_halo2::model::{body_hash, pedersen_bjj, poseidon, zeros, TREE_DEPTH};
use num_bigint::BigUint;
use ff::{Field, PrimeField};
use halo2_proofs::halo2curves::bn256::Fr;
use sha2::digest::generic_array::GenericArray;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::sync::OnceLock;

pub mod blob;
pub mod fast;
pub mod lock;
pub mod ops;

/// Levels of the nullifier tree: room for 2^32 records.
pub const NF_LEVELS: usize = 32;
/// How many of the latest note roots a block accepts as anchors without listing them.
pub const RECENT: usize = 32;
/// `State::to_bytes`: note root, leaf count (u64 BE), the 32 filled nodes, nullifier root, record count, recent roots, chain binding,
/// and the queue's position (u64 BE) and its hash there.
pub const STATE_LEN: usize = 32 + 8 + 32 * TREE_DEPTH + 32 + 8 + 32 * RECENT + 32 + 8 + 32;
/// `NfWitness::to_bytes`: low value, low next, low index (u64 BE), low path, slot path.
pub const NF_WITNESS_LEN: usize = 32 + 32 + 8 + 2 * 32 * NF_LEVELS;
/// `NfMember::to_bytes`: the record's next value, its index (u64 BE) and its path.
pub const NF_MEMBER_LEN: usize = 32 + 8 + 32 * NF_LEVELS;
/// A forced spend as posted to the landing contract's queue: its publics (12 × 32-byte big-endian field elements), its proof, the
/// proof's hints (20 × 64 bytes), a memo for each output slot (MEMO_LEN bytes, an empty output's ignored), then the rest of
/// `SpendData::to_bytes` after the memo hashes, which the memos give. The memos ride along so that whoever lands the block can
/// publish them: a block lists every output's memo, and a hash alone could not be published.
pub const FORCED_PUBLICS_LEN: usize = 12 * 32;
pub const FORCED_PROOF_LEN: usize = 2080;
pub const FORCED_HINTS_LEN: usize = 20 * 64;
pub const FORCED_HEAD_LEN: usize = FORCED_PUBLICS_LEN + FORCED_PROOF_LEN + FORCED_HINTS_LEN;
pub const FORCED_REST_AT: usize = FORCED_HEAD_LEN + 3 * MEMO_LEN;
/// Every memo's length, so a memo's size says nothing of what wrote it (the landing contract refuses others).
/// Every memo's length: an ML-KEM-768 ciphertext (1,088) ‖ a secp256k1 ephemeral key (33) ‖ the value (8) ‖ a tag (16), padded to a multiple
/// of 128: what a hybrid post-quantum memo needs (the program never reads inside one; only its hash and size are fixed).
pub const MEMO_LEN: usize = 1152;
/// btc-pool-halo2's partial rounds for Poseidon with t = 3 (`partial_rounds(3)`, which parses constants to say so;
/// `note_tree_consts` checks it).
pub const NOTE_PARTIAL_ROUNDS: usize = 57;

const STATE_DOMAIN: &[u8] = b"tacit-block-state-v1";
const LIST_DOMAIN: &[u8] = b"tacit-block-list-v1";
const VK_DOMAIN: &[u8] = b"tacit-block-vk-v1";
const CHAIN_DOMAIN: &[u8] = b"tacit-block-chain-v1";
const QUEUE_DOMAIN: &[u8] = b"tacit-block-queue-v1";
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

/// The note tree's constants as `tacit-block pin` writes artifacts/note-tree.bin: Poseidon's t = 3 constants in the shape
/// `fast::poseidon_consts` lays them out (partial rounds made sparse), then the empty subtree roots from the leaf level up,
/// each 32 little-endian canonical bytes. The zkVM reads them from the file instead of deriving them.
pub fn note_tree_consts() -> Vec<u8> {
    let mut b = vec![];
    for f in fast::poseidon_consts().iter().chain(zeros().iter()) {
        b.extend_from_slice(f.to_repr().as_ref());
    }
    b
}

#[cfg(target_os = "zkvm")]
mod zk {
    use super::*;
    use btc_pool_halo2::model::FULL_ROUNDS;

    use crate::fast::{self, Fe};

    const NOTE_TREE: &[u8] = include_bytes!("../../artifacts/note-tree.bin");
    const PEDERSEN: &[u8] = include_bytes!("../../artifacts/pedersen.bin");

    /// One message schedule for the whole run: h64 writes its first sixteen words, the extend precompile the rest.
    static mut SCHEDULE: [u64; 64] = [0; 64];

    /// h64 on SHA-256's precompiles (each word in a u64, as SP1's take them).
    pub fn h64(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
        let mut s: [u64; 8] = SHA256_IV.map(|x| x as u64);
        unsafe {
            let w = &mut *core::ptr::addr_of_mut!(SCHEDULE);
            for i in 0..8 {
                w[i] = u32::from_be_bytes([a[4 * i], a[4 * i + 1], a[4 * i + 2], a[4 * i + 3]]) as u64;
                w[8 + i] = u32::from_be_bytes([b[4 * i], b[4 * i + 1], b[4 * i + 2], b[4 * i + 3]]) as u64;
            }
            sp1_lib::syscall_sha256_extend(w);
            sp1_lib::syscall_sha256_compress(w, &mut s);
        }
        let mut out = [0u8; 32];
        for i in 0..8 {
            out[4 * i..4 * i + 4].copy_from_slice(&(s[i] as u32).to_be_bytes());
        }
        out
    }

    type U = [u64; 4];
    /// The BN254 scalar field's modulus r, little-endian limbs.
    const P: U = [0x43e1f593f0000001, 0x2833e84879b97091, 0xb85045b68181585d, 0x30644e72e131a029];

    fn le(b: &[u8]) -> U {
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

    /// a - b mod r for a, b < r.
    #[inline(always)]
    fn sub(a: &U, b: &U) -> U {
        let mut d = [0u64; 4];
        let mut borrow = 0u64;
        for i in 0..4 {
            let (x, b1) = a[i].overflowing_sub(b[i]);
            let (y, b2) = x.overflowing_sub(borrow);
            d[i] = y;
            borrow = b1 as u64 + b2 as u64;
        }
        if borrow != 0 {
            let mut carry = 0u64;
            for i in 0..4 {
                let (x, c1) = d[i].overflowing_add(P[i]);
                let (y, c2) = x.overflowing_add(carry);
                d[i] = y;
                carry = c1 as u64 + c2 as u64;
            }
        }
        d
    }

    impl Fe for U {
        fn zero() -> Self {
            [0; 4]
        }
        fn one() -> Self {
            [1, 0, 0, 0]
        }
        fn from_u64(v: u64) -> Self {
            [v, 0, 0, 0]
        }
        fn add(&self, o: &Self) -> Self {
            add(self, o)
        }
        fn sub(&self, o: &Self) -> Self {
            sub(self, o)
        }
        fn mul(&self, o: &Self) -> Self {
            mul(self, o)
        }
        fn same(&self, o: &Self) -> bool {
            self == o
        }
    }

    fn consts() -> &'static Vec<U> {
        static C: OnceLock<Vec<U>> = OnceLock::new();
        C.get_or_init(|| {
            assert_eq!(NOTE_TREE.len(), 32 * (fast::POSEIDON_CONSTS + TREE_DEPTH + 1), "note-tree.bin");
            (0..fast::POSEIDON_CONSTS).map(|i| le(&NOTE_TREE[32 * i..32 * i + 32])).collect()
        })
    }

    /// circomlib Poseidon(a, b) on canonical limbs, its partial rounds sparse (`fast::poseidon2`).
    pub fn poseidon2(a: &Fr, b: &Fr) -> Fr {
        let k = consts();
        fr(&fast::poseidon2(&|i| k[i], &limbs(a), &limbs(b)))
    }

    /// The empty subtree roots from note-tree.bin.
    pub fn zeros() -> [Fr; TREE_DEPTH + 1] {
        let mut z = [Fr::ZERO; TREE_DEPTH + 1];
        for (i, x) in z.iter_mut().enumerate() {
            let at = 32 * (fast::POSEIDON_CONSTS + i);
            *x = fr(&le(&NOTE_TREE[at..at + 32]));
        }
        z
    }

    /// Whether `o` opens `c`, from the fixed-base tables in pedersen.bin (`fast::pedersen`).
    pub fn commits(o: &Opening, c: &[Fr; 2]) -> bool {
        assert_eq!(PEDERSEN.len(), 96 * fast::TABLE_POINTS, "pedersen.bin");
        let p = fast::pedersen(&|i| le(&PEDERSEN[32 * i..32 * i + 32]), o.v, &fast::blinding(&o.r));
        fast::is(&p, &[limbs(&c[0]), limbs(&c[1])])
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
/// A record and an inner node hash alike; every path is NF_LEVELS long, so a record is only ever read at a leaf.
pub fn h64(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    #[cfg(target_os = "zkvm")]
    {
        return zk::h64(a, b);
    }
    #[allow(unreachable_code)]
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
    if w.low_index >= size || nf_root_of(&nf_record(&w.low_value, &w.low_next), w.low_index, &w.low_path) != *root {
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

/// That a value is already in the nullifier tree: its own record's next value, index and path.
#[derive(Clone, Debug, PartialEq)]
pub struct NfMember {
    pub next: [u8; 32],
    pub index: u64,
    pub path: Vec<[u8; 32]>,
}

impl NfMember {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(NF_MEMBER_LEN);
        b.extend_from_slice(&self.next);
        b.extend_from_slice(&self.index.to_be_bytes());
        for s in &self.path {
            b.extend_from_slice(s);
        }
        b
    }

    pub fn from_bytes(b: &[u8]) -> Option<NfMember> {
        if b.len() != NF_MEMBER_LEN {
            return None;
        }
        Some(NfMember { next: b[..32].try_into().ok()?, index: u64::from_be_bytes(b[32..40].try_into().ok()?), path: b[40..].chunks(32).map(|c| c.try_into().unwrap()).collect() })
    }
}

/// Whether `v` is one of the values of the tree with root `root` and `size` records.
pub fn nf_member(root: &[u8; 32], size: u64, v: &[u8; 32], w: &NfMember) -> bool {
    *v != [0u8; 32] && w.index < size && w.path.len() == NF_LEVELS && nf_root_of(&nf_record(v, &w.next), w.index, &w.path) == *root
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

/// A Pedersen commitment's opening: the value and the blinding (32 bytes, big-endian).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Opening {
    pub v: u64,
    pub r: [u8; 32],
}

/// What a block takes about a spend besides its proof: the rest of its body (its outputs' memo hashes, zero for an
/// empty output, the address an exit pays, zero for none, and the spender's salt) and the openings of its deposit
/// and exit. A wallet derives the salt from its own secret and the spend, so it is found again from the keys alone.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SpendData {
    pub memo_hashes: [[u8; 32]; 3],
    pub exit_to: [u8; 20],
    pub salt: [u8; 32],
    pub dep: Option<Opening>,
    pub exit: Option<Opening>,
    /// The operation the exit's value goes into instead of an address (`ops`): with one, the body is `op_body_bytes`.
    pub op: Option<ops::Op>,
}

impl SpendData {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = vec![];
        for m in &self.memo_hashes {
            b.extend_from_slice(m);
        }
        b.extend_from_slice(&self.exit_to);
        b.extend_from_slice(&self.salt);
        for o in [self.dep, self.exit] {
            match o {
                None => b.push(0),
                Some(o) => {
                    b.push(1);
                    b.extend_from_slice(&o.v.to_be_bytes());
                    b.extend_from_slice(&o.r);
                }
            }
        }
        // a payment's bytes end there; an operation follows a 1
        if let Some(op) = &self.op {
            b.push(1);
            b.extend(op.to_bytes());
        }
        b
    }

    pub fn from_bytes(b: &[u8]) -> Option<SpendData> {
        let (d, n) = SpendData::from_prefix(b)?;
        (n == b.len()).then_some(d)
    }

    /// The data `to_bytes` wrote at the start of `b` (an operation there if a 1 follows the openings), and how many bytes it took.
    pub fn from_prefix(b: &[u8]) -> Option<(SpendData, usize)> {
        let mut d = SpendData::default();
        for (i, m) in d.memo_hashes.iter_mut().enumerate() {
            m.copy_from_slice(b.get(32 * i..32 * i + 32)?);
        }
        d.exit_to.copy_from_slice(b.get(96..116)?);
        d.salt.copy_from_slice(b.get(116..148)?);
        let mut at = 148;
        let mut opening = || -> Option<Option<Opening>> {
            let flag = *b.get(at)?;
            at += 1;
            match flag {
                0 => Some(None),
                1 => {
                    let v = u64::from_be_bytes(b.get(at..at + 8)?.try_into().ok()?);
                    let r = b.get(at + 8..at + 40)?.try_into().ok()?;
                    at += 40;
                    Some(Some(Opening { v, r }))
                }
                _ => None,
            }
        };
        d.dep = opening()?;
        d.exit = opening()?;
        if b.get(at) == Some(&1) {
            let (op, n) = ops::Op::from_prefix(&b[at + 1..])?;
            d.op = Some(op);
            at += 1 + n;
        }
        Some((d, at))
    }
}

const BODY_DOMAIN: &[u8] = b"tacit-block-body-v1";
const MEMO_DOMAIN: &[u8] = b"tacit-block-memo-v1";

/// A tacit-chain spend's body, which the owners of its inputs sign (the circuit checks their signatures over its
/// hash): the chain's binding, the output leaves, their memo hashes, the address an exit pays and the spender's
/// salt. A block checks each spend's body hash against these, so whoever proves the block can change none of them;
/// the salt keeps a body hash that is published (a depositor's) from being matched to the outputs it names.
pub fn body_bytes(chain: &[u8; 32], out: &[Fr; 3], memo_hashes: &[[u8; 32]; 3], exit_to: &[u8; 20], salt: &[u8; 32]) -> Vec<u8> {
    let mut b = BODY_DOMAIN.to_vec();
    b.extend_from_slice(chain);
    for o in out {
        b.extend_from_slice(&fr_be(o));
    }
    for m in memo_hashes {
        b.extend_from_slice(m);
    }
    b.extend_from_slice(exit_to);
    b.extend_from_slice(salt);
    b
}

const OP_BODY_DOMAIN: &[u8] = b"tacit-block-op-body-v1";

/// The body of a spend that sends its exit's value into an operation: the chain's binding, the output leaves, their memo hashes, the
/// operation and the spender's salt, signed as a payment's body is.
pub fn op_body_bytes(chain: &[u8; 32], out: &[Fr; 3], memo_hashes: &[[u8; 32]; 3], op: &ops::Op, salt: &[u8; 32]) -> Vec<u8> {
    let mut b = OP_BODY_DOMAIN.to_vec();
    b.extend_from_slice(chain);
    for o in out {
        b.extend_from_slice(&fr_be(o));
    }
    for m in memo_hashes {
        b.extend_from_slice(m);
    }
    b.extend(op.to_bytes());
    b.extend_from_slice(salt);
    b
}

/// The binding a deployment's spends carry: SHA-256(CHAIN_DOMAIN ‖ chain id (32-byte BE) ‖ the landing contract),
/// which the contract derives for itself, so no two deployments share one.
pub fn chain_binding(chain_id: u64, lander: &[u8; 20]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(CHAIN_DOMAIN);
    h.update(word(chain_id));
    h.update(lander);
    h.finalize().into()
}

/// The hash a body carries for an output's memo.
pub fn memo_hash(memo: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(MEMO_DOMAIN);
    h.update(memo);
    h.finalize().into()
}

/// Whether `o` opens the BabyJubJub Pedersen commitment `c`, as btc-pool-halo2 commits (in the zkVM from fixed-base tables,
/// `fast::pedersen`, which `fast::check` holds to the reference).
fn commits(o: &Opening, c: &[Fr; 2]) -> bool {
    #[cfg(target_os = "zkvm")]
    {
        return zk::commits(o, c);
    }
    #[allow(unreachable_code)]
    {
        pedersen_bjj(&BigUint::from(o.v), &BigUint::from_bytes_be(&o.r)) == *c
    }
}

/// What a block moves: the note tree, the nullifier tree's root and record count, the last `RECENT` note roots,
/// newest last (an unused slot is zero, which no note root is), and the chain's binding, which every spend's
/// body carries so a spend made for one deployment is void on another.
#[derive(Clone, Debug, PartialEq)]
pub struct State {
    pub notes: Notes,
    pub nf_root: [u8; 32],
    pub nf_size: u64,
    pub recent: [[u8; 32]; RECENT],
    pub chain: [u8; 32],
    /// How many of the landing contract's forced spends the chain has taken or passed over, and the queue's hash after them.
    pub queue_len: u64,
    pub queue_hash: [u8; 32],
}

impl State {
    /// The state before any block, for a chain bound to `chain`.
    pub fn genesis(chain: [u8; 32]) -> State {
        let mut s = State { notes: Notes::default(), nf_root: nf_genesis_root(), nf_size: 1, recent: [[0u8; 32]; RECENT], chain, queue_len: 0, queue_hash: [0u8; 32] };
        s.remember(fr_be(&s.notes.root));
        s
    }

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
        b.extend_from_slice(&self.chain);
        b.extend_from_slice(&self.queue_len.to_be_bytes());
        b.extend_from_slice(&self.queue_hash);
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
        let chain = b[STATE_LEN - 72..STATE_LEN - 40].try_into().ok()?;
        let queue_len = u64::from_be_bytes(b[STATE_LEN - 40..STATE_LEN - 32].try_into().ok()?);
        let queue_hash = b[STATE_LEN - 32..].try_into().ok()?;
        Some(State { notes: Notes { filled, len, root }, nf_root, nf_size, recent, chain, queue_len, queue_hash })
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

/// What a block proof commits, as thirteen 32-byte words (`encode`). How many spends a block holds is not among them,
/// and each list's length is in its hash.
#[derive(Clone, Debug, PartialEq)]
pub struct BlockOut {
    /// State digests before and after.
    pub prev: [u8; 32],
    pub next: [u8; 32],
    /// Note roots before and after.
    pub prev_root: [u8; 32],
    pub next_root: [u8; 32],
    pub outputs_hash: [u8; 32],
    pub nullifiers_hash: [u8; 32],
    pub anchors_hash: [u8; 32],
    pub deposits_hash: [u8; 32],
    pub exits_hash: [u8; 32],
    pub vk: [u8; 32],
    /// How far through the landing contract's queue of forced spends the chain is after the block, and the queue's hash there:
    /// the contract checks the hash against its own and that nothing left in the queue is overdue.
    pub queue_len: u64,
    pub queue_hash: [u8; 32],
    /// The hash of the hops the block sends into the confidential pool (`BlockData::hops`).
    pub hops_hash: [u8; 32],
    /// The hash of the claim signatures the block publishes (`BlockData::claims`).
    pub claims_hash: [u8; 32],
    /// The time the block names (unix seconds): it lands only from it to `lock::TIME_WINDOW` after, and its claims and refunds are
    /// decided by it.
    pub time: u64,
    /// For a block whose data-only lists travel in blobs, SHA-256 of each blob's (versioned hash, z, y) (`blob::claims`); zero for
    /// one whose lists are in its calldata.
    pub blobs_hash: [u8; 32],
}

fn word(n: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&n.to_be_bytes());
    w
}

fn address_word(a: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

impl BlockOut {
    pub fn encode(&self) -> Vec<u8> {
        [
            self.prev,
            self.next,
            self.prev_root,
            self.next_root,
            self.outputs_hash,
            self.nullifiers_hash,
            self.anchors_hash,
            self.deposits_hash,
            self.exits_hash,
            self.vk,
            word(self.queue_len),
            self.queue_hash,
            self.hops_hash,
            self.claims_hash,
            word(self.time),
            self.blobs_hash,
        ]
        .concat()
    }
}

/// The lists a block's hashes commit, in committed order: what a lander publishes so anyone can rebuild the
/// state (outputs join the note tree in this order, nullifiers the nullifier tree in this order) and find their
/// notes. Every list is sorted, so its order says nothing of which spend an entry came from.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BlockData {
    /// New notes in the order they join the tree: leaf ‖ the hash of its memo (the memo itself, which the
    /// recipient decrypts, is published beside it).
    pub outputs: Vec<[u8; 64]>,
    pub nullifiers: Vec<[u8; 32]>,
    /// Distinct anchors older than the state's recent roots.
    pub anchors: Vec<[u8; 32]>,
    /// Deposits a spend took in: asset ‖ value ‖ commitment (x ‖ y) ‖ the spend's body hash, which the depositor
    /// named when depositing, 160 bytes each.
    pub deposits: Vec<Vec<u8>>,
    /// Exits to pay: asset ‖ value ‖ address (left-padded), 96 bytes each.
    pub exits: Vec<Vec<u8>>,
    /// Hops into the confidential pool on Ethereum: asset ‖ value ‖ the pool's commitment (`ops::hop_bytes`), 96 bytes each, sorted.
    pub hops: Vec<Vec<u8>>,
    /// The recipients' signatures of the locks the block's claims settle (R.x ‖ s, 64 bytes each), sorted: where a swap's
    /// counterparty reads its secret.
    pub claims: Vec<[u8; 64]>,
}

/// The queue's hash after one more posted spend: SHA-256(QUEUE_DOMAIN ‖ the hash before ‖ SHA-256(what was posted)), as the
/// landing contract chains it.
pub fn queue_step(before: &[u8; 32], payload_hash: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(QUEUE_DOMAIN);
    h.update(before);
    h.update(payload_hash);
    h.finalize().into()
}

/// SHA-256 of what was posted to the queue.
pub fn payload_hash(p: &[u8]) -> [u8; 32] {
    Sha256::digest(p).into()
}

/// The parts of a posted spend, when the bytes are one: its publics, proof, hints and the rest of its body and openings, each
/// output's memo hash taken from the memo posted for it (zero for an empty output, as a body names it). A spend that carries an
/// operation is followed by a memo for each receiver the operation names (`ops::Op::receivers`), each the one its hash names, so a
/// block that takes it can publish them.
pub fn forced_parts(p: &[u8]) -> Option<(Vec<Fr>, &[u8], &[u8], SpendData)> {
    if p.len() < FORCED_REST_AT {
        return None;
    }
    let publics: Vec<Fr> = p[..FORCED_PUBLICS_LEN].chunks(32).map(fr_from_be).collect::<Option<_>>()?;
    let mut rest = Vec::with_capacity(96 + p.len() - FORCED_REST_AT);
    for (i, leaf) in publics[5..8].iter().enumerate() {
        rest.extend(if bool::from(leaf.is_zero()) { [0u8; 32] } else { memo_hash(forced_memo(p, i)) });
    }
    rest.extend_from_slice(&p[FORCED_REST_AT..]);
    let (data, used) = SpendData::from_prefix(&rest)?;
    let receivers = data.op.as_ref().map(|op| op.receivers()).unwrap_or_default();
    let memos = &rest[used..];
    if memos.len() != MEMO_LEN * receivers.len() || receivers.iter().zip(memos.chunks(MEMO_LEN)).any(|(r, m)| memo_hash(m) != r.memo) {
        return None;
    }
    Some((publics, &p[FORCED_PUBLICS_LEN..FORCED_PUBLICS_LEN + FORCED_PROOF_LEN], &p[FORCED_PUBLICS_LEN + FORCED_PROOF_LEN..FORCED_HEAD_LEN], data))
}

/// The memos posted after a forced spend's operation, in its receivers' order (empty for a payment): what a block that takes it
/// publishes for the notes the operation makes. `p` must be one `forced_parts` takes.
pub fn forced_op_memos(p: &[u8]) -> Vec<&[u8]> {
    let Some((_, _, _, d)) = forced_parts(p) else { return vec![] };
    let n = d.op.map(|op| op.receivers().len()).unwrap_or(0);
    p[p.len() - MEMO_LEN * n..].chunks(MEMO_LEN).collect()
}

/// The memo posted for output slot `i` of a posted spend at least FORCED_REST_AT bytes long: what the block publishes for that
/// output when it takes the spend.
pub fn forced_memo(p: &[u8], i: usize) -> &[u8] {
    &p[FORCED_HEAD_LEN + MEMO_LEN * i..FORCED_HEAD_LEN + MEMO_LEN * (i + 1)]
}

/// The proof and hints of a posted spend at least FORCED_HEAD_LEN bytes long.
pub fn forced_proof(p: &[u8]) -> (&[u8], &[u8]) {
    (&p[FORCED_PUBLICS_LEN..FORCED_PUBLICS_LEN + FORCED_PROOF_LEN], &p[FORCED_PUBLICS_LEN + FORCED_PROOF_LEN..FORCED_HEAD_LEN])
}

/// A posted spend's answers, as whoever builds the block gives them: whether its proof verifies, then for each live nullifier 0, or 1
/// and the record that shows the note spent before the block. The program holds the builder to each: a proof said to verify joins the
/// block's one pairing, and one said not to is checked on its own and must fail; a record must be in the tree, and a note said to be
/// unspent must go into it.
#[derive(Clone, Debug, PartialEq)]
pub struct Answers {
    pub verifies: bool,
    pub members: Vec<Option<NfMember>>,
}

impl Answers {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = vec![self.verifies as u8];
        for m in &self.members {
            match m {
                None => b.push(0),
                Some(m) => {
                    b.push(1);
                    b.extend(m.to_bytes());
                }
            }
        }
        b
    }

    pub fn from_bytes(b: &[u8]) -> Option<Answers> {
        let (&v, mut rest) = b.split_first()?;
        if v > 1 {
            return None;
        }
        let mut members = vec![];
        while let Some((&tag, after)) = rest.split_first() {
            match tag {
                0 => {
                    members.push(None);
                    rest = after;
                }
                1 => {
                    members.push(Some(NfMember::from_bytes(after.get(..NF_MEMBER_LEN)?)?));
                    rest = &after[NF_MEMBER_LEN..];
                }
                _ => return None,
            }
        }
        Some(Answers { verifies: v == 1, members })
    }
}

/// A spend from the landing contract's queue (`force`), as a block sees it before looking at its proof: the hash of what was posted,
/// and the spend when the bytes are one none of whose notes the tree shows spent and whose body and openings check out.
#[derive(Clone, Debug)]
pub struct Posted {
    pub payload_hash: [u8; 32],
    pub candidate: Option<Candidate>,
}

/// A posted spend that only its proof and the spends before it in the block decide on: its publics, and what taking it does.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub publics: Vec<Fr>,
    /// Whether a proof decides it (a spend) or it is decided already (a claim or refund, checked here).
    pub needs_proof: bool,
    effects: Effects,
}

/// What a block learns of posted bytes before the proof in them, the cheap checks first, so that bytes no block could take cost a block
/// next to nothing: that they are a spend, that none of its notes is in the tree (`members`: the builder's answers, each checked), and
/// that its body and openings check out. Err: a wrong answer (a record not in the tree, or answers for another number of notes), which
/// refuses the block.
pub fn posted(prev: &State, payload: &[u8], members: &[Option<NfMember>], time: u64) -> Result<Posted, String> {
    let payload_hash = payload_hash(payload);
    let none = Posted { payload_hash, candidate: None };
    if let Some((settle, memo)) = lock::forced_settle(payload, MEMO_LEN) {
        if members.len() != 1 {
            return Err(format!("{} answers for one lock", members.len()));
        }
        if let Some(m) = &members[0] {
            if !nf_member(&prev.nf_root, prev.nf_size, &fr_be(&lock::lock_nullifier(&settle.leaf(), settle.index)), m) {
                return Err("a lock said to be settled is not in the tree".into());
            }
            return Ok(none);
        }
        return Ok(match settle_effects(prev, &settle, time) {
            Ok(effects) if memo_hash(memo) == settle.to().memo => Posted { payload_hash, candidate: Some(Candidate { publics: vec![], needs_proof: false, effects }) },
            _ => none,
        });
    }
    if payload.get(..32) == Some(&lock::SETTLE_MARK[..]) {
        // marked bytes that are no settle are no spend either
        return if members.is_empty() { Ok(none) } else { Err("answers for bytes that are no spend".into()) };
    }
    let Some((publics, _, _, data)) = forced_parts(payload) else { return Ok(none) };
    let spend = Spend::from_publics(&publics);
    let live = spend.live_nullifiers();
    if members.len() != live.len() {
        return Err(format!("{} answers for {} notes", members.len(), live.len()));
    }
    let mut spent = false;
    for (nf, m) in live.iter().zip(members) {
        if let Some(m) = m {
            if !nf_member(&prev.nf_root, prev.nf_size, &fr_be(nf), m) {
                return Err("a note said to be spent is not in the tree".into());
            }
            spent = true;
        }
    }
    if spent {
        return Ok(none);
    }
    Ok(match effects(prev, &spend, &data) {
        Ok(effects) => Posted { payload_hash, candidate: Some(Candidate { publics, needs_proof: true, effects }) },
        Err(_) => none,
    })
}

/// Which posted spends a block takes, in queue order: a candidate none of whose notes a spend before it in the block spends (the block's
/// own come first) and whose proof verifies, which `verifies(j, candidate)` says and is asked only of those.
pub fn take(spends: &[Spend], settles: &[lock::Settle], posted: &[Posted], mut verifies: impl FnMut(usize, &Candidate) -> bool) -> Vec<bool> {
    let mut used: BTreeSet<[u8; 32]> = spends.iter().flat_map(|s| s.live_nullifiers()).map(|x| fr_be(&x)).collect();
    used.extend(settles.iter().map(|s| fr_be(&lock::lock_nullifier(&s.leaf(), s.index))));
    posted
        .iter()
        .enumerate()
        .map(|(j, p)| {
            let Some(c) = &p.candidate else { return false };
            if c.effects.nullifiers.iter().any(|x| used.contains(x)) || (c.needs_proof && !verifies(j, c)) {
                return false;
            }
            used.extend(c.effects.nullifiers.iter().copied());
            true
        })
        .collect()
}

/// What a spend does to a block once its body and openings check out: the anchor it lists (one older than the recent roots), its
/// outputs (leaf, memo hash), its deposit and exit records and its live nullifiers. The nullifier tree is not consulted here.
#[derive(Clone, Debug)]
struct Effects {
    anchor: Option<[u8; 32]>,
    outputs: Vec<(Fr, [u8; 32])>,
    deposit: Option<Vec<u8>>,
    exit: Option<Vec<u8>>,
    nullifiers: Vec<[u8; 32]>,
    /// A hop into the confidential pool (`ops::hop_bytes`), when the body sends the exit's value there.
    hop: Option<Vec<u8>>,
    /// A claim's signature, published.
    claim: Option<[u8; 64]>,
}

/// What a claim or refund does to a block, when the block's time allows it: the anchor its path leads to (one older than the recent
/// roots), the lock's nullifier, and the note it makes.
fn settle_effects(prev: &State, s: &lock::Settle, time: u64) -> Result<Effects, &'static str> {
    if s.value == 0 || !s.allowed(&prev.chain, time) {
        return Err("a lock not at the root it names, a claim not signed by its recipient or not before its deadline, or a refund before its deadline");
    }
    let root = fr_be(&s.root);
    let anchor = (root != fr_be(&prev.notes.root) && !prev.knows(&root)).then_some(root);
    let to = s.to();
    Ok(Effects {
        anchor,
        outputs: vec![(poseidon(&[s.asset, Fr::from(s.value), to.npk, to.rho]), to.memo)],
        deposit: None,
        exit: None,
        nullifiers: vec![fr_be(&lock::lock_nullifier(&s.leaf(), s.index))],
        hop: None,
        claim: s.sig,
    })
}

/// The deposit a spend takes in, as a block publishes and the landing contract looks it up: asset ‖ value ‖ commitment (x ‖ y) ‖ body hash.
pub fn deposit_record(s: &Spend, d: &SpendData) -> Option<Vec<u8>> {
    if is_identity(&s.dep) {
        return None;
    }
    d.dep.map(|o| [fr_be(&s.asset), word(o.v), fr_be(&s.dep[0]), fr_be(&s.dep[1]), fr_be(&s.body)].concat())
}

fn effects(prev: &State, s: &Spend, d: &SpendData) -> Result<Effects, &'static str> {
    let live = s.live_nullifiers();
    if live.len() == 2 && live[0] == live[1] {
        return Err("one note in both input slots");
    }
    let mut e = Effects { anchor: None, outputs: Vec::with_capacity(3), deposit: None, exit: None, nullifiers: live.iter().map(fr_be).collect(), hop: None, claim: None };
    if live.is_empty() {
        if is_identity(&s.dep) {
            return Err("no input and no deposit");
        }
    } else if s.root != prev.notes.root && !prev.knows(&fr_be(&s.root)) {
        e.anchor = Some(fr_be(&s.root));
    }
    let body = match &d.op {
        None => body_bytes(&prev.chain, &s.out, &d.memo_hashes, &d.exit_to, &d.salt),
        Some(op) => op_body_bytes(&prev.chain, &s.out, &d.memo_hashes, op, &d.salt),
    };
    if body_hash(&body) != s.body {
        return Err("the body is not this chain's, or not its outputs, memos, exit or operation, and salt");
    }
    for (o, m) in s.out.iter().zip(&d.memo_hashes) {
        if bool::from(o.is_zero()) {
            if *m != [0u8; 32] {
                return Err("a memo for an empty output");
            }
        } else {
            e.outputs.push((*o, *m));
        }
    }
    // a deposit or exit of nothing could never be made or paid on L1: refused here, not left to the lander
    match (is_identity(&s.dep), &d.dep) {
        (true, None) => {}
        (false, Some(o)) if o.v > 0 && commits(o, &s.dep) => {
            e.deposit = Some([fr_be(&s.asset), word(o.v), fr_be(&s.dep[0]), fr_be(&s.dep[1]), fr_be(&s.body)].concat())
        }
        _ => return Err("the deposit's opening is missing, wrong or of nothing"),
    }
    match (is_identity(&s.exit), &d.exit, &d.op) {
        (true, None, None) if d.exit_to == [0u8; 20] => {}
        (false, Some(o), None) if o.v > 0 && d.exit_to != [0u8; 20] && commits(o, &s.exit) => {
            e.exit = Some([fr_be(&s.asset), word(o.v), address_word(&d.exit_to)].concat())
        }
        (false, Some(o), Some(ops::Op::Hop { commit })) if o.v > 0 && d.exit_to == [0u8; 20] && commits(o, &s.exit) => {
            e.hop = Some(ops::hop_bytes(&s.asset, o.v, commit))
        }
        (false, Some(o), Some(ops::Op::Lock { lock, memo })) if o.v > 0 && d.exit_to == [0u8; 20] && commits(o, &s.exit) => {
            e.outputs.push((lock.leaf(&s.asset, o.v), *memo))
        }
        _ => return Err("the exit's opening, address or operation is missing, wrong or of nothing"),
    }
    Ok(e)
}

/// The non-zero nullifiers a block will enter into the tree, smallest first: those of its own spends and of the posted spends it takes,
/// for whoever builds the block to make their witnesses.
pub fn block_nullifiers(spends: &[Spend], settles: &[lock::Settle], posted: &[Posted], taken: &[bool]) -> Vec<[u8; 32]> {
    let mut all: Vec<[u8; 32]> = spends.iter().flat_map(|s| s.live_nullifiers()).map(|x| fr_be(&x)).collect();
    all.extend(settles.iter().map(|s| fr_be(&lock::lock_nullifier(&s.leaf(), s.index))));
    for (p, t) in posted.iter().zip(taken) {
        if let (true, Some(c)) = (*t, &p.candidate) {
            all.extend(c.effects.nullifiers.iter().copied());
        }
    }
    all.sort();
    all
}

/// Applies a block to `prev`: its own spends (each proof checked separately; the guest folds them into one pairing), then the next
/// `posted.len()` spends of the landing contract's queue in queue order, those `taken` (as `take` decides, so that whoever builds the
/// block cannot keep a sound one out) joining it; the queue moves past every one. A spend of the block's own that does not check out
/// refuses the block. `nfw[j]` is the witness for the j-th smallest non-zero nullifier of every spend taken, against the tree as the
/// smaller ones left it: nullifiers enter in ascending order, so the tree is a function of the published list alone.
#[allow(clippy::too_many_arguments)]
pub fn apply(prev: &State, spends: &[Spend], data: &[SpendData], settles: &[lock::Settle], posted: &[Posted], taken: &[bool], nfw: &[NfWitness], vk: [u8; 32], time: u64, blobs: &[u8]) -> Result<(State, BlockOut, BlockData), String> {
    mark!("cycle-tracker-report-start: block-scan");
    if data.len() != spends.len() || taken.len() != posted.len() {
        return Err(format!("{} spend data for {} spends, {} choices for {} posted", data.len(), spends.len(), taken.len(), posted.len()));
    }
    let n = spends.len();
    let k = settles.len();
    let who = |i: usize| {
        if i < n {
            format!("spend {i}")
        } else if i < n + k {
            format!("settle {}", i - n)
        } else {
            format!("forced spend {}", i - n - k)
        }
    };
    let mut chosen: Vec<(usize, Effects)> = Vec::with_capacity(n + k + posted.len());
    for (i, (s, d)) in spends.iter().zip(data).enumerate() {
        chosen.push((i, effects(prev, s, d).map_err(|e| format!("spend {i}: {e}"))?));
    }
    for (i, s) in settles.iter().enumerate() {
        chosen.push((n + i, settle_effects(prev, s, time).map_err(|e| format!("settle {i}: {e}"))?));
    }
    let (mut queue_len, mut queue_hash) = (prev.queue_len, prev.queue_hash);
    for (j, (p, t)) in posted.iter().zip(taken).enumerate() {
        queue_len += 1;
        queue_hash = queue_step(&queue_hash, &p.payload_hash);
        if *t {
            let c = p.candidate.as_ref().ok_or_else(|| format!("forced spend {j}: taken, but no spend"))?;
            chosen.push((n + k + j, c.effects.clone()));
        }
    }
    let mut outputs: Vec<(Fr, [u8; 32])> = vec![];
    let mut spent: Vec<(usize, [u8; 32])> = vec![];
    let mut lists = BlockData::default();
    for (i, e) in chosen {
        lists.anchors.extend(e.anchor);
        lists.deposits.extend(e.deposit);
        lists.exits.extend(e.exit);
        outputs.extend(e.outputs);
        lists.hops.extend(e.hop);
        lists.claims.extend(e.claim);
        spent.extend(e.nullifiers.into_iter().map(|x| (i, x)));
    }
    if spent.len() != nfw.len() {
        return Err(format!("{} nullifier witnesses for {} nullifiers", nfw.len(), spent.len()));
    }
    mark!("cycle-tracker-report-end: block-scan");

    mark!("cycle-tracker-report-start: block-nullifiers");
    spent.sort_by(|a, b| a.1.cmp(&b.1));
    if let Some(w) = spent.windows(2).find(|w| w[0].1 == w[1].1) {
        return Err(format!("{} and {}: one note spent twice", who(w[0].0), who(w[1].0)));
    }
    let (mut nf_root, mut nf_size) = (prev.nf_root, prev.nf_size);
    for ((i, key), w) in spent.iter().zip(nfw) {
        nf_root = nf_insert(&nf_root, nf_size, key, w).map_err(|e| format!("{}: {e}", who(*i)))?;
        nf_size += 1;
        lists.nullifiers.push(*key);
    }
    mark!("cycle-tracker-report-end: block-nullifiers");

    mark!("cycle-tracker-report-start: block-notes");
    outputs.sort_by_key(|(o, _)| fr_be(o));
    let leaves: Vec<Fr> = outputs.iter().map(|(o, _)| *o).collect();
    let mut notes = prev.notes.clone();
    notes.append(&leaves)?;
    mark!("cycle-tracker-report-end: block-notes");

    mark!("cycle-tracker-report-start: block-commit");
    lists.outputs = outputs.iter().map(|(o, m)| [fr_be(o), *m].concat().try_into().unwrap()).collect();
    lists.anchors.sort();
    lists.anchors.dedup();
    lists.deposits.sort();
    lists.exits.sort();
    lists.hops.sort();
    lists.claims.sort();
    let mut next = State { notes, nf_root, nf_size, recent: prev.recent, chain: prev.chain, queue_len, queue_hash };
    next.remember(fr_be(&next.notes.root));
    let out = BlockOut {
        prev: prev.digest(),
        next: next.digest(),
        prev_root: fr_be(&prev.notes.root),
        next_root: fr_be(&next.notes.root),
        outputs_hash: list_hash(1, &lists.outputs),
        nullifiers_hash: list_hash(2, &lists.nullifiers),
        anchors_hash: list_hash(3, &lists.anchors),
        deposits_hash: list_hash(4, &lists.deposits),
        exits_hash: list_hash(5, &lists.exits),
        vk,
        queue_len,
        queue_hash,
        hops_hash: list_hash(6, &lists.hops),
        claims_hash: list_hash(7, &lists.claims),
        time,
        blobs_hash: blobs_hash(&lists, blobs)?,
    };
    mark!("cycle-tracker-report-end: block-commit");
    Ok((next, out, lists))
}

/// The blob claims' hash for a block whose lists travel in blobs: `blobs` is empty for one whose lists are in calldata, else the blob
/// count (u32 BE), each blob's KZG commitment (48 bytes) and every new note's memo in the block's output order, each checked against
/// the hash the block commits for it.
fn blobs_hash(lists: &BlockData, blobs: &[u8]) -> Result<[u8; 32], String> {
    if blobs.is_empty() {
        return Ok([0u8; 32]);
    }
    let n = u32::from_be_bytes(blobs.get(..4).ok_or("blob input")?.try_into().unwrap()) as usize;
    let at = 4 + 48 * n;
    let commitments: Vec<[u8; 48]> = blobs.get(4..at).ok_or("blob commitments")?.chunks(48).map(|c| c.try_into().unwrap()).collect();
    let memos = &blobs[at..];
    if n == 0 || memos.len() != MEMO_LEN * lists.outputs.len() {
        return Err("a blob block names its blobs and every new note's memo".into());
    }
    let mut outputs = Vec::with_capacity(lists.outputs.len());
    for (o, m) in lists.outputs.iter().zip(memos.chunks(MEMO_LEN)) {
        if memo_hash(m)[..] != o[32..] {
            return Err("a memo is not the one its note commits".into());
        }
        outputs.push((o[..32].try_into().unwrap(), m.to_vec()));
    }
    let stream = blob::stream(&outputs, &lists.nullifiers, &lists.claims);
    blob::claims(&stream, &commitments).map(|(_, h)| h).ok_or_else(|| "the blobs are not as many as the block's data fills".into())
}

