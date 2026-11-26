//! Liveness fuzz for the Bitcoin reflection fold: can an honest prover ALWAYS fold every Ethereum-recorded
//! consume (`ScanReflection::fold_consumed`)? In the guest an `Err` there is a hard `.expect`, and the
//! consumed-count freshness gates make one unfoldable consume a permanent brick of attestation.
//!
//! Model. Notes are created through the real fold paths (legacy, generation-bound, burn-deposit append),
//! with deliberate duplicate-leaf notes (same asset/commitment/auth key at two outpoints, which anyone can
//! create). Each cycle mirrors reflect.rs: (1) fold every new Ethereum consume FIRST, in order, (2) then the
//! Bitcoin-block spends with the duplicate-aware spent fold. An Ethereum consume is only eligible for a note
//! whose nu is NOT in the spent set the Ethereum side last saw (the attested root of the previous cycle) and
//! has not already been consumed, which is what the pool enforces (nu non-membership against
//! `bitcoinSpentRoot`, nu unique in `bitcoinConsumed`).
//!
//! Property: every eligible consume folds `Ok`.
//!
//! Lives in tests/ (not src/) on purpose: verify-vkey-pin.sh treats anything under cxfer-core/src as guest source.

use cxfer_core::eth_reflection::{eth_consumed_leaf, EthConsumed};
use cxfer_core::*;
use tiny_keccak::{Hasher, Keccak};

fn kn(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Keccak::v256();
    for p in parts { h.update(p); }
    let mut o = [0u8; 32];
    h.finalize(&mut o);
    o
}
fn keccak_zeros() -> [[u8; 32]; KECCAK_TREE_DEPTH] {
    let mut z = [[0u8; 32]; KECCAK_TREE_DEPTH];
    for i in 1..KECCAK_TREE_DEPTH { z[i] = kn(&[&z[i - 1], &z[i - 1]]); }
    z
}
use std::collections::HashSet;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn b32(&mut self) -> [u8; 32] {
        let mut o = [0u8; 32];
        for c in o.chunks_mut(8) {
            c.copy_from_slice(&self.next().to_le_bytes());
        }
        o
    }
}

fn merkle_path(leaves: &[[u8; 32]], mut index: u64) -> Vec<[u8; 32]> {
    let zeros = keccak_zeros();
    let mut path = Vec::with_capacity(KECCAK_TREE_DEPTH);
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    for i in 0..KECCAK_TREE_DEPTH {
        let sib = (index ^ 1) as usize;
        path.push(if sib < level.len() { level[sib] } else { zeros[i] });
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        let mut k = 0;
        while k * 2 < level.len() {
            let l = level[2 * k];
            let r = if 2 * k + 1 < level.len() { level[2 * k + 1] } else { zeros[i] };
            next.push(kn(&[&l, &r]));
            k += 1;
        }
        level = next;
        index >>= 1;
    }
    path
}

type Wit = ([u8; 32], [u8; 32], u64, Vec<[u8; 32]>, Vec<[u8; 32]>);
fn imt_wit(acc: &ImtAccumulator, key: &[u8; 32]) -> Wit {
    let leaves: Vec<[u8; 32]> = acc.links().iter().map(|(v, n)| imt_leaf(v, n)).collect();
    // A key already present has no straddling low leaf: hand back a dummy so the fold's own checks decide.
    let Some((li, lv, ln)) = acc.non_membership_low(key) else { return ([0u8; 32], [0u8; 32], 0, vec![], vec![]) };
    let low_path = merkle_path(&leaves, li as u64);
    let new_index = leaves.len() as u64;
    let mut interm = leaves.clone();
    interm[li] = imt_leaf(&lv, key);
    let new_path = merkle_path(&interm, new_index);
    (lv, ln, li as u64, low_path, new_path)
}

#[derive(Clone)]
struct Note {
    txid: [u8; 32],
    vout: u32,
    asset: [u8; 32],
    cx: [u8; 32],
    cy: [u8; 32],
    auth: [u8; 32],
    bound: bool,
    leaf: [u8; 32],
    nu: [u8; 32],
    in_live: bool,
}

struct Model {
    st: ScanReflection,
    cb: [u8; 32],
    hist: Vec<[u8; 32]>,
    spent: ImtAccumulator,
    spent_set: HashSet<[u8; 32]>,
    outs: ImtAccumulator,
    eth_consumed: Vec<EthConsumed>,
    notes: Vec<Note>,
    consumed_nus: HashSet<[u8; 32]>,
    folded_consumes: usize,
    folded_btc_spends: usize,
    dup_spends: usize,
    dup_notes: usize,
}

impl Model {
    fn new(cb: [u8; 32]) -> Self {
        let st = ScanReflection::genesis();
        assert_eq!(st.spent_root, ImtAccumulator::new().root());
        Self {
            st, cb, hist: vec![], spent: ImtAccumulator::new(), spent_set: HashSet::new(),
            outs: ImtAccumulator::new(), eth_consumed: vec![], notes: vec![],
            consumed_nus: HashSet::new(), folded_consumes: 0, folded_btc_spends: 0, dup_spends: 0, dup_notes: 0,
        }
    }

    fn append_path(&self) -> Vec<[u8; 32]> {
        merkle_path(&self.hist, self.hist.len() as u64)
    }

    /// kind: 0 legacy, 1 bound, 2 burn-deposit append (never live, spent at once), 3 duplicate of a prior note.
    fn add_note(&mut self, r: &mut Rng, kind: usize) {
        let (asset, cx, cy, auth, bound) = if kind == 3 && !self.notes.is_empty() {
            let src = self.notes[r.below(self.notes.len())].clone();
            self.dup_notes += 1;
            (src.asset, src.cx, src.cy, src.auth, src.bound)
        } else {
            (r.b32(), r.b32(), r.b32(), r.b32(), kind == 1)
        };
        let leaf = if bound { btc_note_leaf_bound(&asset, &cx, &cy, &auth, &self.cb) } else { btc_note_leaf(&asset, &cx, &cy, &auth) };
        let nu = nullifier(&leaf);
        let txid = r.b32();
        let vout = (r.next() % 4) as u32;
        let op = outpoint_key(&txid, vout);
        let path = self.append_path();
        if kind == 2 {
            if self.spent_set.contains(&nu) {
                return; // a burn-deposit of an already-spent leaf is refused upstream
            }
            self.st.fold_note_append(&leaf, &path).expect("append");
            self.hist.push(leaf);
            self.fold_spent_model(&nu);
            self.notes.push(Note { txid, vout, asset, cx, cy, auth, bound, leaf, nu, in_live: false });
            return;
        }
        let ch = commitment_hash(&cx, &cy);
        if bound {
            self.st.fold_output_bound(&leaf, &path, &op, &ch, &asset, &auth).expect("out bound");
        } else {
            self.st.fold_output(&leaf, &path, &op, &ch, &asset, &auth).expect("out");
        }
        self.hist.push(leaf);
        self.notes.push(Note { txid, vout, asset, cx, cy, auth, bound, leaf, nu, in_live: true });
    }

    fn fold_spent_model(&mut self, nu: &[u8; 32]) {
        let (lv, ln, li, lp, np) = imt_wit(&self.spent, nu);
        self.st.fold_spent(nu, &lv, &ln, li, &lp, &np).expect("fold_spent");
        self.spent.insert(nu);
        self.spent_set.insert(*nu);
    }

    /// reflect.rs spent fold: an already-spent nu is a membership-gated no-op, a fresh nu inserts.
    fn bitcoin_spend(&mut self, idx: usize) {
        let n = self.notes[idx].clone();
        let key = outpoint_key(&n.txid, n.vout);
        if self.st.live.get(&key).is_none() {
            return; // already retired (spent or consumed): a scan does not see it
        }
        let _ = self.st.live.remove(&key);
        self.notes[idx].in_live = false;
        self.folded_btc_spends += 1;
        if self.spent_set.contains(&n.nu) {
            self.dup_spends += 1;
        } else {
            self.fold_spent_model(&n.nu);
        }
    }

    /// Fold the pending Ethereum consumes in order. Every one must be Ok.
    fn fold_pending_consumes(&mut self, from: usize, pick: &[(usize, [u8; 32])]) -> Result<(), String> {
        let leaves: Vec<[u8; 32]> = self.eth_consumed.iter().map(eth_consumed_leaf).collect();
        let set_root = keccak_merkle_root(&leaves);
        for (k, (note_idx, spend_root)) in pick.iter().enumerate() {
            let idx = from + k;
            let n = self.notes[*note_idx].clone();
            let co_val = self.eth_consumed[idx].spend_root;
            assert_eq!(self.eth_consumed[idx].nullifier, n.nu);
            let set_path = merkle_path(&leaves, idx as u64);
            let key = outpoint_key(&n.txid, n.vout);
            let (sl, sn, si, sp, snew) = imt_wit(&self.spent, &n.nu);
            let (ol, on, oi, op_, onew) = imt_wit(&self.outs, &key);
            let r = self.st.fold_consumed(
                &n.nu, &co_val, spend_root, &n.cx, &n.cy, &n.txid, n.vout, &self.cb,
                &set_path, &set_root, &sl, &sn, si, &sp, &snew, &ol, &on, oi, &op_, &onew,
            );
            match r {
                Ok(b) => {
                    assert_eq!(b == 1, n.bound, "live bound tag disagrees with the note's domain");
                    self.spent.insert(&n.nu);
                    self.spent_set.insert(n.nu);
                    self.outs.insert(&key);
                    self.notes[*note_idx].in_live = false;
                    self.folded_consumes += 1;
                }
                Err(e) => return Err(format!("note #{note_idx} bound={} consume refused: {e}", n.bound)),
            }
        }
        Ok(())
    }
}

fn run(seed: u64, cycles: usize) -> Model {
    let mut r = Rng(seed | 1);
    let mut m = Model::new(r.b32());
    let mut attested_spent: HashSet<[u8; 32]> = HashSet::new();
    for _ in 0..cycles {
        // Ethereum only sees notes that were in an attested root: those created before this cycle.
        let eligible_upto = m.notes.len();
        for _ in 0..(1 + r.below(5)) {
            let kind = match r.below(10) { 0..=3 => 0, 4..=6 => 1, 7 => 2, _ => 3 };
            m.add_note(&mut r, kind);
        }
        // Ethereum consumes recorded this cycle: eligible = leaf in the tree, nu not spent as last attested, not consumed.
        let mut pick: Vec<(usize, [u8; 32])> = vec![];
        let from = m.eth_consumed.len();
        for _ in 0..r.below(4) {
            if eligible_upto == 0 { break; }
            let i = r.below(eligible_upto);
            let nu = m.notes[i].nu;
            if attested_spent.contains(&nu) || m.consumed_nus.contains(&nu) { continue; }
            // The prover names the source outpoint: some live note with this nu (possibly a duplicate twin).
            let live_same: Vec<usize> = (0..m.notes.len()).filter(|&j| m.notes[j].nu == nu && m.notes[j].in_live).collect();
            let src = if live_same.is_empty() { i } else { live_same[r.below(live_same.len())] };
            let spend_root = r.b32();
            m.consumed_nus.insert(nu);
            m.eth_consumed.push(EthConsumed { nullifier: nu, spend_root: kn(&[&spend_root, &m.notes[i].leaf]) });
            pick.push((src, spend_root));
        }
        // Reflect: consumes first (Ethereum-senior), then the Bitcoin block's spends.
        if let Err(e) = m.fold_pending_consumes(from, &pick) {
            panic!("seed {seed}: LIVENESS BREAK: {e}");
        }
        for _ in 0..r.below(4) {
            if m.notes.is_empty() { break; }
            let i = r.below(m.notes.len());
            m.bitcoin_spend(i);
        }
        attested_spent = m.spent_set.clone();
    }
    m
}

#[test]
fn fold_consumed_never_bricks_under_mixed_lanes() {
    let (mut cons, mut spends, mut dups, mut dnotes) = (0, 0, 0, 0);
    let seeds: u64 = std::env::var("FUZZ_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(150);
    let cycles: usize = std::env::var("FUZZ_CYCLES").ok().and_then(|s| s.parse().ok()).unwrap_or(25);
    for seed in 1..=seeds {
        let m = run(seed.wrapping_mul(0x9E3779B97F4A7C15), cycles);
        cons += m.folded_consumes;
        spends += m.folded_btc_spends;
        dups += m.dup_spends;
        dnotes += m.dup_notes;
    }
    eprintln!("fuzz: {seeds} seeds x {cycles} cycles: {cons} consumes folded, {spends} bitcoin spends, {dups} duplicate-nu spends, {dnotes} duplicate-leaf notes");
    assert!(cons > 50 && dups > 0, "the fuzz must actually exercise consumes and the duplicate-nu path");
}

/// Directed: Ethereum consumes nu while a duplicate-leaf twin is live; the Bitcoin spend of the OTHER twin must
/// neither double-insert nor strand.
#[test]
fn twin_notes_consume_then_spend_other() {
    let mut r = Rng(7);
    let mut m = Model::new(r.b32());
    m.add_note(&mut r, 0);
    m.add_note(&mut r, 3);
    assert_eq!(m.notes[0].nu, m.notes[1].nu);
    let spend_root = r.b32();
    let nu = m.notes[0].nu;
    m.eth_consumed.push(EthConsumed { nullifier: nu, spend_root: kn(&[&spend_root, &m.notes[0].leaf]) });
    m.consumed_nus.insert(nu);
    m.fold_pending_consumes(0, &[(0, spend_root)]).expect("consume folds");
    m.bitcoin_spend(1);
    assert_eq!(m.dup_spends, 1);
}

/// Negative control: a consume whose source outpoint is NOT live is refused (the hard error the guest would
/// `.expect`). Shows the harness can see the failure it hunts.
#[test]
fn negative_control_consume_of_retired_note_is_refused() {
    let mut r = Rng(11);
    let mut m = Model::new(r.b32());
    m.add_note(&mut r, 0);
    let nu = m.notes[0].nu;
    m.bitcoin_spend(0);
    let spend_root = r.b32();
    m.eth_consumed.push(EthConsumed { nullifier: nu, spend_root: kn(&[&spend_root, &m.notes[0].leaf]) });
    let err = m.fold_pending_consumes(0, &[(0, spend_root)]).expect_err("must refuse");
    assert!(err.contains("not a live UTXO"), "{err}");
}
