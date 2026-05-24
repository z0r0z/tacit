use crate::poseidon;

const TREE_DEPTH: usize = 20;
const MAX_LEAVES: usize = 1 << TREE_DEPTH;

/// Incremental append-only Poseidon merkle tree with frontier.
/// Mirrors the Ethereum contract's incremental tree exactly.
/// The root is updated on every insert — no need to recompute from scratch.
pub struct PoseidonTree {
    next_index: usize,
    filled_subtrees: [[u8; 32]; TREE_DEPTH],
    current_root: [u8; 32],
    zeros: [[u8; 32]; TREE_DEPTH + 1],
}

pub struct NullifierTree {
    next_index: usize,
    filled_subtrees: [[u8; 32]; TREE_DEPTH],
    current_root: [u8; 32],
    zeros: [[u8; 32]; TREE_DEPTH + 1],
    seen: Vec<[u8; 32]>,
}

fn compute_zeros() -> [[u8; 32]; TREE_DEPTH + 1] {
    let mut z = [[0u8; 32]; TREE_DEPTH + 1];
    for i in 1..=TREE_DEPTH { z[i] = poseidon::hash2(&z[i-1], &z[i-1]); }
    z
}

impl PoseidonTree {
    pub fn new() -> Self {
        let z = compute_zeros();
        let mut fs = [[0u8; 32]; TREE_DEPTH];
        for i in 0..TREE_DEPTH { fs[i] = z[i]; }
        PoseidonTree { next_index: 0, filled_subtrees: fs, current_root: z[TREE_DEPTH], zeros: z }
    }

    pub fn from_frontier(frontier: [[u8; 32]; TREE_DEPTH], next_index: usize, root: [u8; 32]) -> Self {
        let z = compute_zeros();
        PoseidonTree { next_index, filled_subtrees: frontier, current_root: root, zeros: z }
    }

    pub fn insert(&mut self, leaf: [u8; 32]) {
        assert!(self.next_index < MAX_LEAVES, "tree full");
        let mut current = leaf;
        let mut idx = self.next_index;
        for i in 0..TREE_DEPTH {
            if idx & 1 == 0 {
                self.filled_subtrees[i] = current;
                current = poseidon::hash2(&current, &self.zeros[i]);
            } else {
                current = poseidon::hash2(&self.filled_subtrees[i], &current);
            }
            idx >>= 1;
        }
        self.current_root = current;
        self.next_index += 1;
    }

    pub fn root(&self) -> [u8; 32] { self.current_root }
    pub fn next_index(&self) -> usize { self.next_index }
    pub fn frontier(&self) -> [[u8; 32]; TREE_DEPTH] { self.filled_subtrees }
}

impl NullifierTree {
    pub fn new() -> Self {
        let z = compute_zeros();
        let mut fs = [[0u8; 32]; TREE_DEPTH];
        for i in 0..TREE_DEPTH { fs[i] = z[i]; }
        NullifierTree { next_index: 0, filled_subtrees: fs, current_root: z[TREE_DEPTH], zeros: z, seen: Vec::new() }
    }

    pub fn from_frontier(frontier: [[u8; 32]; TREE_DEPTH], next_index: usize, root: [u8; 32]) -> Self {
        let z = compute_zeros();
        NullifierTree { next_index, filled_subtrees: frontier, current_root: root, zeros: z, seen: Vec::new() }
    }

    pub fn insert(&mut self, nullifier: [u8; 32]) {
        assert!(!self.seen.contains(&nullifier), "duplicate nullifier");
        self.seen.push(nullifier);
        assert!(self.next_index < MAX_LEAVES, "tree full");
        let mut current = nullifier;
        let mut idx = self.next_index;
        for i in 0..TREE_DEPTH {
            if idx & 1 == 0 {
                self.filled_subtrees[i] = current;
                current = poseidon::hash2(&current, &self.zeros[i]);
            } else {
                current = poseidon::hash2(&self.filled_subtrees[i], &current);
            }
            idx >>= 1;
        }
        self.current_root = current;
        self.next_index += 1;
    }

    pub fn root(&self) -> [u8; 32] { self.current_root }
    pub fn next_index(&self) -> usize { self.next_index }
    pub fn frontier(&self) -> [[u8; 32]; TREE_DEPTH] { self.filled_subtrees }
}
