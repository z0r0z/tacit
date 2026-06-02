use crate::poseidon;
use sha2::{Sha256, Digest};

pub const TREE_DEPTH: usize = 20;
const MAX_LEAVES: usize = 1 << TREE_DEPTH;

pub struct PoseidonTree {
    next_index: usize,
    filled_subtrees: [[u8; 32]; TREE_DEPTH],
    current_root: [u8; 32],
    zeros: [[u8; 32]; TREE_DEPTH + 1],
}

/// Hash-committed nullifier set with cross-batch uniqueness.
/// The prover supplies the full historical nullifier list as private witness.
/// The guest verifies the list's hash matches the previous state commitment,
/// checks non-membership for each new nullifier, then appends and recomputes.
pub struct NullifierSet {
    sorted: Vec<[u8; 32]>,
    pending: Vec<[u8; 32]>,
}

fn verify_root_from_frontier(
    frontier: &[[u8; 32]; TREE_DEPTH],
    next_index: usize,
    zeros: &[[u8; 32]; TREE_DEPTH + 1],
) -> [u8; 32] {
    let mut hash = zeros[0];
    let mut ni = next_index;
    for i in 0..TREE_DEPTH {
        if ni & 1 == 1 {
            hash = poseidon::hash2(&frontier[i], &hash);
        } else {
            hash = poseidon::hash2(&hash, &zeros[i]);
        }
        ni >>= 1;
    }
    hash
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
        if next_index == 0 {
            for i in 0..TREE_DEPTH {
                assert!(frontier[i] == z[i], "empty frontier mismatch");
            }
            assert!(root == z[TREE_DEPTH], "empty root mismatch");
        } else {
            let verified_root = verify_root_from_frontier(&frontier, next_index, &z);
            assert!(verified_root == root, "frontier does not match claimed root");
        }
        PoseidonTree { next_index, filled_subtrees: frontier, current_root: root, zeros: z }
    }

    pub fn insert(&mut self, leaf: [u8; 32]) -> bool {
        if self.next_index >= MAX_LEAVES { return false; }
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
        true
    }

    pub fn can_insert(&self) -> bool { self.next_index < MAX_LEAVES }
    /// Insert allowed only when at least `reserve` slots remain above this one.
    /// Keeps the top slots mint-only so rotate/import (0x62/0x64) can't exhaust
    /// the headroom the Ethereum deposit gate reserves for in-flight mints —
    /// closes the F-2 reserve-bypass. Mints keep the full can_insert().
    pub fn can_insert_with_reserve(&self, reserve: usize) -> bool {
        self.next_index + reserve < MAX_LEAVES
    }
    pub fn root(&self) -> [u8; 32] { self.current_root }
    pub fn next_index(&self) -> usize { self.next_index }
    pub fn frontier(&self) -> [[u8; 32]; TREE_DEPTH] { self.filled_subtrees }
}

impl NullifierSet {
    pub fn new() -> Self {
        NullifierSet { sorted: Vec::new(), pending: Vec::new() }
    }

    pub fn from_sorted(nullifiers: Vec<[u8; 32]>) -> Self {
        for i in 1..nullifiers.len() {
            assert!(nullifiers[i] > nullifiers[i - 1], "historical nullifier list must be sorted and unique");
        }
        NullifierSet { sorted: nullifiers, pending: Vec::new() }
    }

    pub fn insert(&mut self, nullifier: [u8; 32]) -> bool {
        if self.sorted.binary_search(&nullifier).is_ok() { return false; }
        if self.pending.contains(&nullifier) { return false; }
        self.pending.push(nullifier);
        true
    }

    pub fn finalize(&mut self) {
        if self.pending.is_empty() { return; }
        self.pending.sort();
        for i in 1..self.pending.len() {
            assert!(self.pending[i] != self.pending[i - 1], "duplicate nullifier (in-batch)");
        }
        let mut merged = Vec::with_capacity(self.sorted.len() + self.pending.len());
        let (mut i, mut j) = (0, 0);
        while i < self.sorted.len() && j < self.pending.len() {
            assert!(self.sorted[i] != self.pending[j], "duplicate nullifier in merge");
            if self.sorted[i] < self.pending[j] {
                merged.push(self.sorted[i]); i += 1;
            } else {
                merged.push(self.pending[j]); j += 1;
            }
        }
        while i < self.sorted.len() { merged.push(self.sorted[i]); i += 1; }
        while j < self.pending.len() { merged.push(self.pending[j]); j += 1; }
        self.sorted = merged;
        self.pending.clear();
    }

    pub fn hash(&self) -> [u8; 32] {
        assert!(self.pending.is_empty(), "must finalize before hashing");
        if self.sorted.is_empty() {
            return [0u8; 32];
        }
        let mut h = Sha256::new();
        for n in &self.sorted { h.update(n); }
        h.finalize().into()
    }

    pub fn count(&self) -> u64 {
        assert!(self.pending.is_empty(), "must finalize before counting");
        self.sorted.len() as u64
    }

    /// Sorted nullifier entries — exposed so the SP1 host can persist the
    /// post-cycle state (`ops/prover-incremental-state.md` Option B). Must
    /// only be called after `finalize`; assertion mirrors `count`/`hash`.
    pub fn entries(&self) -> &[[u8; 32]] {
        assert!(self.pending.is_empty(), "must finalize before reading entries");
        &self.sorted
    }
}

#[cfg(test)]
mod f2_reserve_tests {
    use super::*;

    // F-2: rotate/import must not consume the top POOL_TREE_RESERVE slots the
    // deposit gate keeps for in-flight mints. Inserting 2^20 leaves isn't
    // feasible in a unit test, so we drive the boundary via the `reserve` arg
    // on an empty tree: a reserve spanning the whole tree blocks the
    // reserve-aware insert (rotate/import) while plain can_insert (mint) stays
    // open — i.e. the top slots are mint-only.
    #[test]
    fn reserve_keeps_top_slots_for_mint() {
        let t = PoseidonTree::new();
        assert!(t.can_insert(), "fresh tree: mint can insert");
        assert!(t.can_insert_with_reserve(1024), "fresh tree: rotate/import ok far from full");
        // reserve == capacity ⇒ no non-mint insert even when empty
        assert!(!t.can_insert_with_reserve(1 << TREE_DEPTH));
        // exactly one slot above the reserve ⇒ a single non-mint insert allowed
        assert!(t.can_insert_with_reserve((1 << TREE_DEPTH) - 1));
        // mint never gated by the reserve — only by absolute fullness
        assert!(t.can_insert());
    }
}
