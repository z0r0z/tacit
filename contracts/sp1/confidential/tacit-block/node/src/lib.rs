//! A tacit chain node: the chain's state rebuilt from what blocks publish on Ethereum alone, and the input of the next block.
//!
//! A leader runs one to build blocks; a wallet's indexer runs one to serve note paths and the memos it scans; anyone runs one to check
//! that each landed block moved the state the way its proof says. `Node::land` takes a landed block's public words and the lists its
//! calldata carries (`Published`), replays them (the leaves into the note tree in order, the nullifiers into the nullifier tree in
//! order, the root into the recent roots, the queue's position from the words) and refuses a block whose replay does not reach the
//! digest its proof committed. `Node::build` makes the block program's input for the next block from spends, claims and refunds, and
//! the queue's next entries.

pub mod blobs;
pub mod keys;
pub mod serve;

use btc_pool_agg_common as agg;
use btc_pool_halo2::model::Tree;
use halo2_proofs::halo2curves::bn256::Fr;
use std::collections::BTreeMap;
use tacit_block_common::{self as blk, fr_be, fr_from_be, h64, lock::Settle, nf_record, nf_zeros, Answers, BlockData, BlockOut, NfMember, NfWitness, SpendData, State, MEMO_LEN, NF_LEVELS};

/// The nullifier tree kept in full: every record (value, next value), the records by value, every level's nodes (a missing node is that
/// level's empty subtree).
#[derive(Clone)]
pub struct NfTree {
    pub records: Vec<([u8; 32], [u8; 32])>,
    pub by_value: BTreeMap<[u8; 32], u64>,
    levels: Vec<Vec<[u8; 32]>>,
}

impl Default for NfTree {
    fn default() -> Self {
        let mut t = NfTree { records: vec![], by_value: BTreeMap::new(), levels: vec![vec![]; NF_LEVELS + 1] };
        t.put(0, [0u8; 32], [0u8; 32]);
        t
    }
}

impl NfTree {
    fn node(&self, d: usize, i: u64) -> [u8; 32] {
        self.levels[d].get(i as usize).copied().unwrap_or(nf_zeros()[d])
    }

    pub fn root(&self) -> [u8; 32] {
        self.node(NF_LEVELS, 0)
    }

    pub fn path(&self, i: u64) -> Vec<[u8; 32]> {
        (0..NF_LEVELS).map(|d| self.node(d, (i >> d) ^ 1)).collect()
    }

    fn put(&mut self, i: u64, value: [u8; 32], next: [u8; 32]) {
        if i as usize == self.records.len() {
            self.records.push((value, next));
        } else {
            self.records[i as usize] = (value, next);
        }
        self.by_value.insert(value, i);
        let mut cur = nf_record(&value, &next);
        let mut idx = i;
        for d in 0..=NF_LEVELS {
            {
                let level = &mut self.levels[d];
                if level.len() <= idx as usize {
                    level.resize(idx as usize + 1, nf_zeros()[d]);
                }
                level[idx as usize] = cur;
            }
            if d == NF_LEVELS {
                break;
            }
            let sib = self.node(d, idx ^ 1);
            cur = if idx & 1 == 1 { h64(&sib, &cur) } else { h64(&cur, &sib) };
            idx >>= 1;
        }
    }

    /// Enters `v` and returns the witness a block carries for it.
    pub fn insert(&mut self, v: &[u8; 32]) -> NfWitness {
        let (&low_value, &low_index) = self.by_value.range(..*v).next_back().expect("the head record is below every nullifier");
        let low_next = self.records[low_index as usize].1;
        let low_path = self.path(low_index);
        self.put(low_index, low_value, *v);
        let size = self.records.len() as u64;
        let slot_path = self.path(size);
        self.put(size, *v, low_next);
        NfWitness { low_value, low_next, low_index, low_path, slot_path }
    }

    /// The record that shows `v` entered, when it has.
    pub fn member(&self, v: &[u8; 32]) -> Option<NfMember> {
        self.by_value.get(v).map(|&i| NfMember { next: self.records[i as usize].1, index: i, path: self.path(i) })
    }
}

/// What a landed block publishes: its public words and the lists its calldata carries, in the landing contract's order.
#[derive(Clone, Debug, Default)]
pub struct Published {
    pub words: Vec<[u8; 32]>,
    pub leaves: Vec<[u8; 32]>,
    pub memos: Vec<Vec<u8>>,
    pub nullifiers: Vec<[u8; 32]>,
}

/// A spend handed to a leader: its publics, proof, hints and the rest of its body and openings.
#[derive(Clone, Debug)]
pub struct SpendIn {
    pub publics: Vec<u8>,
    pub proof: Vec<u8>,
    pub hints: Vec<u8>,
    pub data: SpendData,
}

/// The chain as its landed blocks left it.
#[derive(Clone)]
pub struct Node {
    pub state: State,
    /// Every note root a block has ended at: what the landing contract takes an old anchor to be.
    pub roots: std::collections::BTreeSet<[u8; 32]>,
    /// Every leaf in tree order, and the memo published with each.
    pub leaves: Vec<Fr>,
    pub memos: Vec<Vec<u8>>,
    pub nf: NfTree,
    pub height: u64,
}

impl Node {
    /// The chain before any block, bound to `chain`.
    pub fn genesis(chain: [u8; 32]) -> Node {
        let state = State::genesis(chain);
        let nf = NfTree::default();
        assert_eq!(nf.root(), state.nf_root, "the nullifier tree starts where the state does");
        let roots = std::collections::BTreeSet::from([fr_be(&state.notes.root)]);
        Node { state, roots, leaves: vec![], memos: vec![], nf, height: 0 }
    }

    /// Replays a landed block from what it publishes, refusing one whose replay does not reach the state its proof committed.
    pub fn land(&mut self, b: &Published) -> Result<(), String> {
        if b.words.len() != 18 {
            return Err(format!("{} public words", b.words.len()));
        }
        if b.words[0] != self.state.digest() || b.words[2] != fr_be(&self.state.notes.root) {
            return Err("the block is not on top of this node's state".into());
        }
        if b.memos.len() != b.leaves.len() || b.memos.iter().any(|m| m.len() != MEMO_LEN) {
            return Err("a memo for every leaf".into());
        }
        let mut next = self.state.clone();
        let leaves: Vec<Fr> = b.leaves.iter().map(|l| fr_from_be(l).ok_or("a leaf is not a field element")).collect::<Result<_, _>>()?;
        next.notes.append(&leaves).map_err(String::from)?;
        let mut nf = self.nf.clone();
        for n in &b.nullifiers {
            nf.insert(n);
        }
        next.nf_root = nf.root();
        next.nf_size = nf.records.len() as u64;
        next.remember(fr_be(&next.notes.root));
        next.queue_len = u64::from_be_bytes(b.words[10][24..].try_into().unwrap());
        next.queue_hash = b.words[11];
        if next.digest() != b.words[1] || fr_be(&next.notes.root) != b.words[3] {
            return Err("the block's lists do not lead to the state its proof committed".into());
        }
        self.roots.insert(fr_be(&next.notes.root));
        self.state = next;
        self.leaves.extend(leaves);
        self.memos.extend(b.memos.iter().cloned());
        self.nf = nf;
        self.height += 1;
        Ok(())
    }

    /// The note tree's root and the path from leaf `index`, as a wallet's spend or a lock's settle names them.
    pub fn path(&self, index: u64) -> Option<(Fr, [Fr; 32])> {
        ((index as usize) < self.leaves.len()).then(|| {
            let t = Tree::new(&self.leaves);
            (t.root, t.path(index as usize))
        })
    }

    /// Whether a nullifier has entered the tree.
    pub fn spent(&self, nf: &[u8; 32]) -> bool {
        self.nf.by_value.contains_key(nf)
    }

    /// The block program's input for the next block of `spends`, `settles` and the queue's next entries `posts` (each with whether
    /// its proof verifies, which the caller checks natively), naming `time`; and what the program will commit and publish for it.
    pub fn build(&self, spends: &[SpendIn], settles: &[Settle], posts: &[(Vec<u8>, bool)], time: u64, blobs: &[u8]) -> Result<(Vec<Vec<u8>>, BlockOut, BlockData), String> {
        let mut bufs = vec![self.state.to_bytes(), (spends.len() as u32).to_le_bytes().to_vec()];
        let mut list = vec![];
        let mut data = vec![];
        for s in spends {
            bufs.push(s.publics.clone());
            bufs.push(s.proof.clone());
            bufs.push(s.hints.clone());
            bufs.push(s.data.to_bytes());
            let p = agg::publics_from_be(&s.publics).ok_or("a spend's publics are not canonical")?;
            list.push(blk::Spend::from_publics(&p));
            data.push(s.data.clone());
        }
        bufs.push((settles.len() as u32).to_le_bytes().to_vec());
        for s in settles {
            bufs.push(s.to_bytes());
        }
        bufs.push(time.to_le_bytes().to_vec());
        bufs.push(blobs.to_vec());
        bufs.push((posts.len() as u32).to_le_bytes().to_vec());
        let mut posted = vec![];
        let mut verifies = vec![];
        for (payload, v) in posts {
            let members: Vec<Option<NfMember>> = match blk::lock::forced_settle(payload, MEMO_LEN) {
                Some((s, _)) => vec![self.nf.member(&fr_be(&blk::lock::lock_nullifier(&s.leaf(), s.index)))],
                None => blk::forced_parts(payload)
                    .map(|(p, _, _, _)| blk::Spend::from_publics(&p).spent_keys())
                    .unwrap_or_default()
                    .iter()
                    .map(|n| self.nf.member(&fr_be(n)))
                    .collect(),
            };
            posted.push(blk::posted(&self.state, payload, &members, time)?);
            let answers = Answers { verifies: *v && blk::lock::forced_settle(payload, MEMO_LEN).is_none(), members };
            bufs.push(payload.clone());
            bufs.push(answers.to_bytes());
            verifies.push(answers.verifies);
        }
        let taken = blk::take(&list, settles, &posted, |j, _| verifies[j]);
        let keys = blk::block_nullifiers(&list, settles, &posted, &taken);
        let mut nf = self.nf.clone();
        let nfw: Vec<NfWitness> = keys.iter().map(|k| nf.insert(k)).collect();
        bufs.push(nfw.iter().flat_map(NfWitness::to_bytes).collect());
        let (_, out, published) = blk::apply(&self.state, &list, &data, settles, &posted, &taken, &nfw, blk::vk_hash(&vk_digest()), time, blobs)?;
        Ok((bufs, out, published))
    }
}

/// The spend key's digest the block program pins (artifacts/vk-digest.bin).
pub fn vk_digest() -> [u8; 64] {
    include_bytes!("../../artifacts/vk-digest.bin").to_owned()
}

/// A guest input as one file: u32 LE count, then each buffer as a u32 LE length and its bytes (what tacit-block-gpu reads).
pub fn stdin_file(bufs: &[Vec<u8>]) -> Vec<u8> {
    let mut file = (bufs.len() as u32).to_le_bytes().to_vec();
    for b in bufs {
        file.extend((b.len() as u32).to_le_bytes());
        file.extend(b);
    }
    file
}

/// The buffers of a guest input file.
pub fn read_stdin_file(f: &[u8]) -> Option<Vec<Vec<u8>>> {
    let n = u32::from_le_bytes(f.get(..4)?.try_into().ok()?) as usize;
    let mut at = 4;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let len = u32::from_le_bytes(f.get(at..at + 4)?.try_into().ok()?) as usize;
        out.push(f.get(at + 4..at + 4 + len)?.to_vec());
        at += 4 + len;
    }
    (at == f.len()).then_some(out)
}
