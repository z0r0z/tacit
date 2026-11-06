//! tacit-block: builds blocks of real Halo2 spends over a test chain, runs the block guest on them in SP1's
//! executor, and checks what it commits against an independent replay (the note tree rebuilt from every leaf,
//! the nullifier tree kept in full).
//!
//! tacit-block measure N...   per N: one block of N spends (two inputs, three outputs each); prints the block
//!                            guest's cycles, its cycles by section, and btc-pool-agg's for the same proofs, as
//!                            JSON lines
//! tacit-block test           a chain where a note received in block 1 is spent in block 2 and an older root is
//!                            listed as an anchor, a shield and an exit, each block's next state rebuilt from what
//!                            it publishes alone, then the blocks the guest must refuse: openings, addresses and
//!                            memos the bodies do not name, a deposit of nothing, a note spent twice in one block
//!                            or again in a later one, a proof with a commitment, an evaluation or a point's hint
//!                            changed
//! tacit-block dump N FILE    one block of N spends as the guest's stdin, for tacit-block-gpu
//! tacit-block fixture FILE [CHAIN_ID LANDER]   a three-block chain of ETH notes as the landing contract's test replays it,
//!                            bound to the contract at LANDER on CHAIN_ID (default: where the test puts it, on chain 31337): the
//!                            genesis state, a shield of 500 units (and the deposit that precedes it on L1), a spend that keeps 380
//!                            and exits 120, and a block that takes only the queue, a forced spend of the 380 posted on L1; each
//!                            block's public values and everything it publishes, and its guest input beside FILE as FILE.b<i>.stdin
//! tacit-block pin [--check]  write the guest's artifacts, or check the committed ones (exit 1 on a mismatch): the
//!                            spend key's digest, transcript representative and verifier params (as btc-pool-agg
//!                            derives them), verifier-cs.bin, the spend circuit's finished constraint system the
//!                            guest reads the key with (its custom gates left out), verifier-gates.bin, those gates as
//!                            one flat program with the system's degree, pedersen.bin, the deposit and exit generators'
//!                            fixed-base tables, and note-tree.bin, the note tree's Poseidon constants (partial rounds sparse) and
//!                            empty subtrees
//!
//! The guest ELF is TACIT_BLOCK_ELF (default ../elf/tacit-block), btc-pool-agg's is BTC_POOL_AGG_ELF (default
//! ../../elf/btc-pool-agg).

use btc_pool_agg_common as agg;
use btc_pool_halo2 as h2;
use btc_pool_halo2::model::{
    asset_field, be32, body_hash, build_witness, fr_u64, hs_l, leaf_of, output_keys, owned_keys, sign, wallet_keys, InNote, OutNote, SpendWitness, Tree,
    Wallet,
};
use halo2_proofs::halo2curves::bn256::{Bn256, Fr};
use halo2_proofs::poly::kzg::commitment::ParamsKZG;
use serde_json::{json, Map, Value};
use sp1_core_executor::{MinimalExecutorEnum, Program};
use std::collections::BTreeMap;
use std::process::exit;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Instant;
use tacit_block_common::{self as blk, ops, fr_be, h64, nf_record, nf_zeros, Answers, BlockData, BlockOut, NfMember, NfWitness, Posted, SpendData, State, MEMO_LEN, NF_LEVELS, RECENT};

const H2_ARTIFACTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../btc-pool-halo2/artifacts");

const ARTIFACTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../artifacts");
const BLOCK_ELF: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../elf/tacit-block");
const AGG_ELF: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../elf/btc-pool-agg");

fn fail(msg: &str) -> ! {
    eprintln!("tacit-block: {msg}");
    exit(2)
}

fn read(path: &str) -> Vec<u8> {
    std::fs::read(path).unwrap_or_else(|e| fail(&format!("{path}: {e}")))
}

struct Keys {
    params: h2::Params,
    pk: h2::Pk,
    vparams: ParamsKZG<Bn256>,
    digest: [u8; 64],
}

fn keys() -> Keys {
    use blake2::{Blake2b512, Digest};
    let vk_bytes = read(&format!("{H2_ARTIFACTS}/vk.bin"));
    let digest: [u8; 64] = read(&format!("{ARTIFACTS}/vk-digest.bin")).try_into().unwrap_or_else(|_| fail("vk-digest.bin"));
    if <[u8; 64]>::from(Blake2b512::digest(&vk_bytes)) != digest {
        fail("vk.bin is not the key the pinned digest names");
    }
    let params = h2::srs::read_params(&read(&format!("{H2_ARTIFACTS}/params-k{}.bin", h2::K))).unwrap_or_else(|e| fail(&e));
    let pk = h2::keygen_with_vk(&params, &vk_bytes).unwrap_or_else(|e| fail(&e));
    let vparams = agg::verifier_params(&read(&format!("{ARTIFACTS}/verifier-params.bin"))).unwrap_or_else(|| fail("verifier params"));
    Keys { params, pk, vparams, digest }
}

/// The nullifier tree kept in full: every record (value, next value), the records by value, every level's
/// nodes (a missing node is that level's empty subtree).
#[derive(Clone)]
struct NfTree {
    records: Vec<([u8; 32], [u8; 32])>,
    by_value: BTreeMap<[u8; 32], u64>,
    levels: Vec<Vec<[u8; 32]>>,
}

impl NfTree {
    fn new() -> NfTree {
        let mut t = NfTree { records: vec![], by_value: BTreeMap::new(), levels: vec![vec![]; NF_LEVELS + 1] };
        t.put(0, [0u8; 32], [0u8; 32]);
        t
    }

    fn node(&self, d: usize, i: u64) -> [u8; 32] {
        self.levels[d].get(i as usize).copied().unwrap_or(nf_zeros()[d])
    }

    fn root(&self) -> [u8; 32] {
        self.node(NF_LEVELS, 0)
    }

    fn path(&self, i: u64) -> Vec<[u8; 32]> {
        (0..NF_LEVELS).map(|d| self.node(d, (i >> d) ^ 1)).collect()
    }

    /// Sets record `i` (the next free index, or an existing one) and every node above it.
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

    /// Spends `v` here and returns the witness a block carries for it. A value already in the list gets the
    /// witness an honest prover would build, which the guest refuses.
    fn insert(&mut self, v: &[u8; 32]) -> NfWitness {
        let (&low_value, &low_index) = self.by_value.range(..*v).next_back().expect("the head record is below every nullifier");
        let low_next = self.records[low_index as usize].1;
        let low_path = self.path(low_index);
        self.put(low_index, low_value, *v);
        let size = self.records.len() as u64;
        let slot_path = self.path(size);
        self.put(size, *v, low_next);
        NfWitness { low_value, low_next, low_index, low_path, slot_path }
    }
}

/// A note whose secrets the test holds.
#[derive(Clone)]
struct Note {
    owner: usize,
    s: [u8; 33],
    v: u64,
    index: u64,
}

fn secret(tag: u8, a: u32, b: u8) -> [u8; 33] {
    let mut s = [0x5au8; 33];
    s[0] = 2;
    s[1] = tag;
    s[2..6].copy_from_slice(&a.to_be_bytes());
    s[6] = b;
    s
}

/// The binding the test chain's spends carry in their bodies.
const TEST_CHAIN: [u8; 32] = [0x7a; 32];
/// Where the landing contract's test deploys it (on Foundry's chain 31337), so the fixture's spends carry the
/// binding that contract derives for itself.
const FIXTURE_LANDER: [u8; 20] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0b, 0x10, 0xc5];
const FIXTURE_CHAIN_ID: u64 = 31337;

/// The test chain: every leaf in tree order, the state as the guest carries it, the nullifier tree replayed
/// by the host as the guest takes the nullifiers, another replayed only from the lists blocks publish, and the
/// note roots the chain has had.
#[derive(Clone)]
struct Chain {
    wallets: Rc<Vec<Wallet>>,
    asset_f: Fr,
    leaves: Vec<Fr>,
    state: State,
    nf: NfTree,
    public_nf: NfTree,
    roots: Vec<Fr>,
}

/// A spend ready for the guest: its proof, the rest of its body and its openings, and the outputs it makes
/// (wallet, secret, value, leaf).
#[derive(Clone)]
struct Prepared {
    publics: Vec<u8>,
    proof: Vec<u8>,
    hints: Vec<u8>,
    spend: blk::Spend,
    data: SpendData,
    outs: Vec<(usize, [u8; 33], u64, Fr)>,
    memos: Vec<Vec<u8>>,
    /// The memos of the receivers its operation names, in their order.
    op_memos: Vec<Vec<u8>>,
}

/// A spend posted to the landing contract's queue: the bytes as posted, and the outputs it makes if a block takes it.
#[derive(Clone)]
struct Post {
    payload: Vec<u8>,
    outs: Vec<(usize, [u8; 33], u64, Fr)>,
}

/// A prepared spend as `force` takes it: publics ‖ proof ‖ hints ‖ a memo per output slot (zeros for an empty one) ‖ the rest
/// of its body and openings after the memo hashes.
fn post(p: &Prepared) -> Post {
    let memos: Vec<u8> = (0..3).flat_map(|j| p.memos.get(j).cloned().unwrap_or_else(|| vec![0u8; MEMO_LEN])).collect();
    Post { payload: [p.publics.clone(), p.proof.clone(), p.hints.clone(), memos, p.data.to_bytes()[96..].to_vec(), p.op_memos.concat()].concat(), outs: p.outs.clone() }
}

/// The memos posted with a spend, slot by slot, then its operation's: what the lander publishes for the notes a block takes from it.
fn posted_memos(payload: &[u8]) -> Vec<Vec<u8>> {
    let mut m: Vec<Vec<u8>> = (0..3).map(|i| blk::forced_memo(payload, i).to_vec()).collect();
    m.extend(blk::forced_op_memos(payload).into_iter().map(<[u8]>::to_vec));
    m
}

/// Bytes posted to the queue that are no spend a block can take.
fn junk(payload: Vec<u8>) -> Post {
    Post { payload, outs: vec![] }
}

/// A sound spend of a fresh note posted with one memo byte changed: no block can take it, and the program finds that out before looking
/// at its proof.
fn bad_memo_like(c: &Chain, k: &Keys) -> Post {
    let mut c = c.clone();
    let n = c.mint(&[(1, secret(106, 0, 0), 2)]);
    let mut p = post(&c.spend(k, &[&n[0]], &[(2, secret(106, 0, 1), 2)], "forced junk memo", c.leaves.len()));
    p.payload[blk::FORCED_HEAD_LEN] ^= 1;
    junk(p.payload)
}

/// A block the guest took.
struct Landed {
    out: BlockOut,
    data: BlockData,
    notes: Vec<Note>,
    cycles: u64,
    sections: Value,
    secs: f64,
    stdin_bytes: usize,
    /// The guest's input for the block, buffer by buffer.
    stdin: Vec<Vec<u8>>,
}

/// Buffers as one file: u32 LE count, then each as a u32 LE length and its bytes (what tacit-block-gpu reads).
fn stdin_file(bufs: &[Vec<u8>]) -> Vec<u8> {
    let mut file = (bufs.len() as u32).to_le_bytes().to_vec();
    for b in bufs {
        file.extend((b.len() as u32).to_le_bytes());
        file.extend(b);
    }
    file
}

impl Chain {
    fn new(wallets: usize) -> Chain {
        Chain::bound(wallets, TEST_CHAIN)
    }

    fn bound(wallets: usize, chain: [u8; 32]) -> Chain {
        let wallets = Rc::new((0..wallets).map(|i| wallet_keys(&[i as u8 + 1; 32], "signet")).collect());
        let state = State::genesis(chain);
        let nf = NfTree::new();
        if nf.root() != state.nf_root {
            fail("the replayed nullifier tree does not start where the state does");
        }
        let roots = vec![state.notes.root];
        Chain { wallets, asset_f: asset_field(&[0xabu8; 32]), leaves: vec![], state, public_nf: nf.clone(), nf, roots }
    }

    /// Notes that enter the tree without a spend (the test's genesis), appended as a block appends them.
    fn mint(&mut self, notes: &[(usize, [u8; 33], u64)]) -> Vec<Note> {
        let mut out = vec![];
        let mut leaves = vec![];
        for (owner, s, v) in notes {
            let k = owned_keys(&self.wallets[*owner], s);
            leaves.push(leaf_of(&self.asset_f, &fr_u64(*v), &k.npk, &k.rho));
            out.push(Note { owner: *owner, s: *s, v: *v, index: (self.leaves.len() + leaves.len() - 1) as u64 });
        }
        self.state.notes.append(&leaves).unwrap_or_else(|e| fail(e));
        self.state.remember(fr_be(&self.state.notes.root));
        self.leaves.extend(&leaves);
        self.roots.push(self.state.notes.root);
        if Tree::new(&self.leaves).root != self.state.notes.root {
            fail("batch append differs from the tree built from every leaf");
        }
        out
    }

    /// A spend of `ins`, proven against the tree as it was with `at` leaves, paying `outs` (wallet, secret,
    /// value).
    fn spend(&self, k: &Keys, ins: &[&Note], outs: &[(usize, [u8; 33], u64)], tag: &str, at: usize) -> Prepared {
        self.spend_with(k, ins, outs, None, None, tag, at)
    }

    /// As `spend`, with an exit of `exit` (value, address) and a deposit of `dep` (value); a deposit with no
    /// inputs is a shield. Its body is the tacit chain's: this chain's binding, the output leaves, their memo
    /// hashes and the exit's address. `tag` keeps memos and blindings distinct.
    #[allow(clippy::too_many_arguments)]
    fn spend_with(&self, k: &Keys, ins: &[&Note], outs: &[(usize, [u8; 33], u64)], exit: Option<(u64, [u8; 20])>, dep: Option<u64>, tag: &str, at: usize) -> Prepared {
        self.spend_full(k, ins, outs, exit, dep, None, tag, at)
    }

    /// The keys and memo of a note an operation makes for wallet `w` with secret `s`.
    fn note_to(&self, w: usize, s: &[u8; 33], tag: &str) -> (ops::NoteTo, Vec<u8>) {
        let o = output_keys(&self.wallets[w].a_pub, &self.wallets[w].n_pub, s);
        let mut memo = format!("tacit-block op memo {tag}").into_bytes();
        memo.resize(MEMO_LEN, 0);
        (ops::NoteTo { npk: o.npk, rho: o.rho, memo: blk::memo_hash(&memo) }, memo)
    }

    /// As `spend_with`, with `op` = (the value it takes, the operation, its receivers' memos): the exit's value goes into the
    /// operation, and the body is the operation's.
    #[allow(clippy::too_many_arguments)]
    fn spend_full(&self, k: &Keys, ins: &[&Note], outs: &[(usize, [u8; 33], u64)], exit: Option<(u64, [u8; 20])>, dep: Option<u64>, op: Option<(u64, ops::Op, Vec<Vec<u8>>)>, tag: &str, at: usize) -> Prepared {
        let tree = Tree::new(&self.leaves[..at]);
        let mut out = [Fr::from(0u64); 3];
        let mut memo_hashes = [[0u8; 32]; 3];
        let mut outputs: [Option<OutNote>; 3] = [None, None, None];
        let mut made = vec![];
        let mut memos = vec![];
        for (j, (w, s, v)) in outs.iter().enumerate() {
            let o = output_keys(&self.wallets[*w].a_pub, &self.wallets[*w].n_pub, s);
            if owned_keys(&self.wallets[*w], s).npk != o.npk {
                fail("an output's owner cannot derive its keys");
            }
            out[j] = leaf_of(&self.asset_f, &fr_u64(*v), &o.npk, &o.rho);
            let mut memo = format!("tacit-block memo {tag} {j}").into_bytes();
            memo.resize(MEMO_LEN, 0);
            memo_hashes[j] = blk::memo_hash(&memo);
            memos.push(memo);
            made.push((*w, *s, *v, out[j]));
            outputs[j] = Some(OutNote { v: *v, npk: o.npk, rho: o.rho });
        }
        let exit_to = exit.map(|(_, a)| a).unwrap_or([0u8; 20]);
        // a wallet's would come from its own secret and the spend; the test's from the tag
        let salt = blk::memo_hash(format!("tacit-block test salt {tag}").as_bytes());
        let bh = match &op {
            None => body_hash(&blk::body_bytes(&self.state.chain, &out, &memo_hashes, &exit_to, &salt)),
            Some((_, o, _)) => body_hash(&blk::op_body_bytes(&self.state.chain, &out, &memo_hashes, o, &salt)),
        };
        let mut inputs: [Option<InNote>; 2] = [None, None];
        for (i, n) in ins.iter().enumerate() {
            let o = owned_keys(&self.wallets[n.owner], &n.s);
            inputs[i] = Some(InNote { v: n.v, rho: o.rho, nk: o.nk.clone(), ak: o.ak, index: n.index, path: tree.path(n.index as usize), sig: sign(&o.sk, &bh) });
        }
        let opening = |v: u64, what: &str| btc_pool_halo2::model::Opening { v, r: hs_l(&format!("tacit-block test {what}"), &[tag.as_bytes()]) };
        let exit_open = exit.map(|(v, _)| opening(v, "exit")).or(op.as_ref().map(|(v, _, _)| opening(*v, "exit")));
        let dep_open = dep.map(|v| opening(v, "deposit"));
        let plain = |o: &btc_pool_halo2::model::Opening| blk::Opening { v: o.v, r: be32(&o.r) };
        let data = SpendData { memo_hashes, exit_to, salt, dep: dep_open.as_ref().map(plain), exit: exit_open.as_ref().map(plain), op: op.as_ref().map(|(_, o, _)| o.clone()) };
        let w = build_witness(tree.root, bh, self.asset_f, &inputs, &outputs, exit_open, dep_open).unwrap_or_else(|e| fail(&e));
        let mut p = prove(k, &w, made, data);
        p.memos = memos;
        p.op_memos = op.map(|(_, _, m)| m).unwrap_or_default();
        p
    }

    /// Wallet `owner`'s note at `leaf` (made by an operation), of value `v` and secret `s`, found in the tree.
    fn made_note(&self, leaf: &Fr, owner: usize, s: &[u8; 33], v: u64) -> Note {
        let index = self.leaves.iter().position(|l| l == leaf).unwrap_or_else(|| fail("an operation's note is not in the tree")) as u64;
        Note { owner, s: *s, v, index }
    }

    /// A posted spend as the block's program sees it before its proof, and the builder's answers: whether its proof verifies (checked here
    /// as the guest checks it: it verifies, and its hints are the ones its points make, a point having one hint the guest takes) and, for
    /// each live nullifier, nothing or the record that shows it spent before the block.
    fn forced_view(&self, k: &Keys, payload: &[u8]) -> (Posted, Answers) {
        let parts = blk::forced_parts(payload);
        let verifies = parts.as_ref().is_some_and(|(publics, proof, hints, _)| {
            let Ok(fixed) = <[Fr; 12]>::try_from(publics.as_slice()) else { return false };
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                h2::verify(&k.params, k.pk.get_vk(), &fixed, proof)
                    && agg::record_hints(&k.vparams, k.pk.get_vk(), publics, proof).map(|(h, _)| h.as_slice() == *hints).unwrap_or(false)
            }))
            .unwrap_or(false)
        });
        let members: Vec<Option<NfMember>> = parts
            .map(|(p, _, _, _)| blk::Spend::from_publics(&p).live_nullifiers())
            .unwrap_or_default()
            .iter()
            .map(|nf| self.nf.by_value.get(&fr_be(nf)).map(|&i| NfMember { next: self.nf.records[i as usize].1, index: i, path: self.nf.path(i) }))
            .collect();
        let posted = blk::posted(&self.state, payload, &members).unwrap_or_else(|e| fail(&format!("the host's own answers: {e}")));
        (posted, Answers { verifies, members })
    }

    /// The guest's input for a block of `spends` and the next `posts` of the queue on this chain, the nullifier witnesses it
    /// carries (the nullifiers of every spend it takes, smallest first, as they enter the tree), and the posted spends as the
    /// program sees them with which of them it takes; the host's nullifier tree takes the nullifiers as it goes.
    fn block_input(&mut self, k: &Keys, spends: &[Prepared], posts: &[Post]) -> (Vec<Vec<u8>>, Vec<NfWitness>, Vec<Posted>, Vec<bool>) {
        let mut bufs = vec![self.state.to_bytes(), (spends.len() as u32).to_le_bytes().to_vec()];
        for p in spends {
            bufs.push(p.publics.clone());
            bufs.push(p.proof.clone());
            bufs.push(p.hints.clone());
            bufs.push(p.data.to_bytes());
        }
        bufs.push((posts.len() as u32).to_le_bytes().to_vec());
        let (mut posted, mut verifies) = (vec![], vec![]);
        for p in posts {
            let (f, answers) = self.forced_view(k, &p.payload);
            bufs.push(p.payload.clone());
            bufs.push(answers.to_bytes());
            verifies.push(answers.verifies);
            posted.push(f);
        }
        let list: Vec<blk::Spend> = spends.iter().map(|p| p.spend.clone()).collect();
        let taken = blk::take(&list, &posted, |j, _| verifies[j]);
        let keys = blk::block_nullifiers(&list, &posted, &taken);
        let nfw: Vec<NfWitness> = keys.iter().map(|k| self.nf.insert(k)).collect();
        bufs.push(nfw.iter().flat_map(NfWitness::to_bytes).collect());
        (bufs, nfw, posted, taken)
    }

    /// Runs a block through the guest and lands it on the chain if the guest takes it; checks the guest's
    /// public values against `apply` and the new state against the independent replay.
    fn land(&mut self, elf: &[u8], k: &Keys, spends: &[Prepared]) -> Result<Landed, String> {
        self.land_with(elf, k, spends, &[])
    }

    /// As `land`, with the next `posts` of the landing contract's queue.
    fn land_with(&mut self, elf: &[u8], k: &Keys, spends: &[Prepared], posts: &[Post]) -> Result<Landed, String> {
        let before = self.clone();
        let (bufs, nfw, posted, taken) = self.block_input(k, spends, posts);
        let stdin_bytes = bufs.iter().map(Vec::len).sum();
        let t = Instant::now();
        let run = execute(elf, &bufs);
        let secs = t.elapsed().as_secs_f64();
        let (pv, cycles, sections) = match run {
            Ok(x) => x,
            Err(e) => {
                *self = before;
                return Err(e);
            }
        };
        let list: Vec<blk::Spend> = spends.iter().map(|p| p.spend.clone()).collect();
        let extra: Vec<SpendData> = spends.iter().map(|p| p.data.clone()).collect();
        let (next, out, data) = blk::apply(&self.state, &list, &extra, &posted, &taken, &nfw, blk::vk_hash(&k.digest)).unwrap_or_else(|e| fail(&format!("the guest took a block apply refuses: {e}")));
        if pv != out.encode() {
            fail("the guest committed other public values than apply");
        }
        let prev_len = self.leaves.len() as u64;
        for o in &data.outputs {
            self.leaves.push(blk::fr_from_be(&o[..32]).unwrap());
        }
        if Tree::new(&self.leaves).root != next.notes.root {
            fail("the block's note root differs from the tree built from every leaf");
        }
        if self.nf.root() != next.nf_root || self.nf.records.len() as u64 != next.nf_size {
            fail("the block's nullifier tree differs from the replayed one");
        }
        // Anyone holding the state before can rebuild the one after from what the block publishes alone: its
        // outputs into the note tree and its nullifiers into the nullifier tree, each in list order.
        let mut public = self.public_nf.clone();
        for n in &data.nullifiers {
            public.insert(n);
        }
        let mut rebuilt = self.state.clone();
        let leaves: Vec<Fr> = data.outputs.iter().map(|o| blk::fr_from_be(&o[..32]).unwrap()).collect();
        rebuilt.notes.append(&leaves).map_err(String::from)?;
        rebuilt.nf_root = public.root();
        rebuilt.nf_size = public.records.len() as u64;
        rebuilt.remember(fr_be(&rebuilt.notes.root));
        // and the pools, from the changes the block publishes
        for c in &data.pools {
            let p = ops::Pool::from_bytes(&c[..ops::POOL_LEN]).ok_or("a published pool does not decode")?;
            match rebuilt.pools.iter().position(|q| q.x == p.x && q.y == p.y) {
                Some(i) => rebuilt.pools[i] = p,
                None => {
                    let at = rebuilt.pools.iter().position(|q| (fr_be(&q.x), fr_be(&q.y)) > (fr_be(&p.x), fr_be(&p.y))).unwrap_or(rebuilt.pools.len());
                    rebuilt.pools.insert(at, p);
                }
            }
        }
        // and the queue's position from what was posted to it
        for p in posts {
            rebuilt.queue_len += 1;
            rebuilt.queue_hash = blk::queue_step(&rebuilt.queue_hash, &blk::payload_hash(&p.payload));
        }
        if rebuilt.digest() != out.next {
            fail("the next state cannot be rebuilt from the lists the block publishes");
        }
        self.public_nf = public;
        let mut notes = vec![];
        for p in spends {
            for (w, s, v, leaf) in &p.outs {
                let pos = data.outputs.iter().position(|o| o[..32] == fr_be(leaf)).ok_or("an output is not among the block's outputs")?;
                notes.push(Note { owner: *w, s: *s, v: *v, index: prev_len + pos as u64 });
            }
        }
        // a forced spend's outputs, when the block took it
        for p in posts {
            for (w, s, v, leaf) in &p.outs {
                if let Some(pos) = data.outputs.iter().position(|o| o[..32] == fr_be(leaf)) {
                    notes.push(Note { owner: *w, s: *s, v: *v, index: prev_len + pos as u64 });
                }
            }
        }
        self.state = next;
        self.roots.push(self.state.notes.root);
        Ok(Landed { out, data, notes, cycles, sections, secs, stdin_bytes, stdin: bufs })
    }
}

fn prove(k: &Keys, w: &SpendWitness, outs: Vec<(usize, [u8; 33], u64, Fr)>, data: SpendData) -> Prepared {
    let proof = h2::prove(&k.params, &k.pk, w).unwrap_or_else(|e| fail(&e));
    let publics = w.publics();
    if !h2::verify(&k.params, k.pk.get_vk(), &publics, &proof) {
        fail("a spend proof does not verify natively");
    }
    let (hints, _) = agg::record_hints(&k.vparams, k.pk.get_vk(), &publics, &proof).unwrap_or_else(|e| fail(&format!("hints: {e:?}")));
    Prepared { publics: publics.iter().flat_map(fr_be).collect(), proof, hints, spend: blk::Spend::from_publics(&publics), data, outs, memos: vec![], op_memos: vec![] }
}

/// Runs a guest to completion: its public values, cycle count and cycles by tracked section, or why it stopped.
fn execute(elf: &[u8], bufs: &[Vec<u8>]) -> Result<(Vec<u8>, u64, Value), String> {
    let program = Arc::new(Program::from(elf).map_err(|e| format!("elf: {e:?}"))?);
    let mut ex = MinimalExecutorEnum::new(program, false, None);
    for b in bufs {
        ex.with_input(b);
    }
    while ex.try_execute_chunk().map_err(|e| format!("execution: {e:?}"))?.is_some() {}
    if !ex.is_done() || ex.exit_code() != 0 {
        return Err(format!("guest stopped with exit code {}", ex.exit_code()));
    }
    let cycles = ex.global_clk();
    let mut sections: Vec<(String, u64)> = ex.take_cycle_tracker_totals().into_iter().collect();
    sections.sort();
    let sections = Value::Object(sections.into_iter().map(|(k, v)| (k, json!(v))).collect::<Map<String, Value>>());
    Ok((ex.into_public_values_stream(), cycles, sections))
}

/// A value as a 32-byte big-endian word.
fn word32(v: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    w
}

fn elf(var: &str, default: &str) -> Vec<u8> {
    read(&std::env::var(var).unwrap_or_else(|_| default.into()))
}

/// N spends over 2N fresh notes: spend i takes notes 2i and 2i+1 (1,000 and 234) of wallet i mod 8 and pays
/// 900, 300 and 34 to three wallets.
fn spends_of(c: &mut Chain, k: &Keys, n: usize, tag: u8) -> Vec<Prepared> {
    let notes: Vec<(usize, [u8; 33], u64)> = (0..n).flat_map(|i| [(i % 8, secret(tag, i as u32, 0), 1000), (i % 8, secret(tag, i as u32, 1), 234)]).collect();
    let made = c.mint(&notes);
    let at = c.leaves.len();
    (0..n)
        .map(|i| {
            let outs = [((i + 1) % 8, secret(tag + 1, i as u32, 0), 900), (i % 8, secret(tag + 1, i as u32, 1), 300), ((i + 2) % 8, secret(tag + 1, i as u32, 2), 34)];
            c.spend(k, &[&made[2 * i], &made[2 * i + 1]], &outs, &format!("tacit-block spend {tag} {i}"), at)
        })
        .collect()
}

fn measure(sizes: &[usize]) {
    let k = keys();
    let block_elf = elf("TACIT_BLOCK_ELF", BLOCK_ELF);
    let agg_elf = elf("BTC_POOL_AGG_ELF", AGG_ELF);
    for &n in sizes {
        let mut c = Chain::new(8);
        let t = Instant::now();
        let spends = spends_of(&mut c, &k, n, 10);
        let prove_secs = t.elapsed().as_secs_f64();
        let mut agg_bufs = vec![(n as u32).to_le_bytes().to_vec()];
        for p in &spends {
            agg_bufs.extend([p.publics.clone(), p.proof.clone(), p.hints.clone()]);
        }
        let (_, agg_cycles, _) = execute(&agg_elf, &agg_bufs).unwrap_or_else(|e| fail(&format!("btc-pool-agg: {e}")));
        let l = c.land(&block_elf, &k, &spends).unwrap_or_else(|e| fail(&e));
        println!(
            "{}",
            json!({
                "spends": n, "cycles": l.cycles, "cycles_per_spend": l.cycles / n as u64, "agg_cycles": agg_cycles,
                "sections": l.sections, "outputs": l.data.outputs.len(), "nullifiers": l.data.nullifiers.len(),
                "stdin_bytes": l.stdin_bytes, "execute_secs": l.secs, "client_proofs_secs": prove_secs,
            })
        );
    }
}

/// Writes one block of N spends as the guest's stdin (u32 LE count, then each buffer as a u32 LE length and its
/// bytes) for tacit-block-gpu, after checking here that the guest takes it.
fn dump(n: usize, path: &str) {
    let k = keys();
    let mut c = Chain::new(8);
    let spends = spends_of(&mut c, &k, n, 10);
    let (bufs, _, _, _) = c.clone().block_input(&k, &spends, &[]);
    let file = stdin_file(&bufs);
    let l = c.land(&elf("TACIT_BLOCK_ELF", BLOCK_ELF), &k, &spends).unwrap_or_else(|e| fail(&e));
    std::fs::write(path, &file).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
    println!("{}", json!({ "spends": n, "file": path, "bytes": file.len(), "cycles": l.cycles, "public_values": hex::encode(l.out.encode()) }));
}

/// The guest's constraint-system blob and gate program from the pinned key: the system the circuit configures, selectors compressed,
/// without its custom gates, with the degree the domain is built for; and the gates as one flat program with the finished system's
/// degree (`gate_program_bytes`), which the guest reads instead of decoding the gates' expression trees. The key read the guest's way
/// must be the key read through `configure`: the same system bar the gates, commitments, permutation, degree and transcript
/// representative, and the same gate program, which `GateProgram::new` builds from the key's own gates.
fn verifier_cs() -> (Vec<u8>, Vec<u8>) {
    use halo2_proofs::plonk::{Circuit, ConstraintSystem};
    use halo2_proofs::SerdeFormat;
    let vk_bytes = read(&format!("{H2_ARTIFACTS}/vk.bin"));
    let vk = h2::vk_from_bytes(&vk_bytes).unwrap_or_else(|e| fail(&e));
    let mut configured = ConstraintSystem::<Fr>::default();
    let _ = <h2::SpendCircuit as Circuit<Fr>>::configure(&mut configured);
    let full = vk.cs().to_compact(configured.degree());
    let (cs, degree) = ConstraintSystem::<Fr>::from_compact(&full).unwrap_or_else(|| fail("the blob does not decode"));
    if format!("{cs:?}") != format!("{:?}", vk.cs()) {
        fail("the decoded constraint system differs from the key's");
    }
    let repr = vk.transcript_repr();
    let read = h2::Vk::read_with_cs(&mut &vk_bytes[..], SerdeFormat::RawBytes, cs, degree, repr).unwrap_or_else(|e| fail(&format!("read_with_cs: {e}")));
    if format!("{:?}", read.pinned()) != format!("{:?}", vk.pinned()) {
        fail("the key read with the blob pins something other than the key read through configure");
    }
    let blob = vk.cs().to_compact_without_gates(configured.degree());
    let program = vk.gate_program_bytes();
    let (bare, d) = ConstraintSystem::<Fr>::from_compact(&blob).unwrap_or_else(|| fail("the gate-less blob does not decode"));
    if d != degree || format!("{bare:?}") != format!("{:?}", vk.cs().without_gates()) {
        fail("the decoded gate-less system differs from the key's");
    }
    let lean = h2::Vk::read_with_program(&mut &vk_bytes[..], SerdeFormat::RawBytes, bare, degree, repr, &program).unwrap_or_else(|e| fail(&format!("read_with_program: {e}")));
    let same = format!("{:?}", lean.fixed_commitments()) == format!("{:?}", vk.fixed_commitments())
        && format!("{:?}", lean.permutation()) == format!("{:?}", vk.permutation())
        && format!("{:?}", lean.get_domain()) == format!("{:?}", vk.get_domain())
        && lean.cs_degree() == vk.cs_degree()
        && lean.transcript_repr() == repr
        && lean.gate_program_bytes() == program;
    if !same {
        fail("the key read with its gate program differs from the key read through configure");
    }
    (blob, program)
}

/// The spend key's BLAKE2b-512 digest, its transcript representative and the verifier params (g[0], g2, τ·g2, k),
/// as btc-pool-agg derives them.
fn key_artifacts() -> [(&'static str, Vec<u8>); 3] {
    use blake2::{Blake2b512, Digest};
    use halo2_proofs::halo2curves::ff::PrimeField;
    use halo2_proofs::poly::commitment::{Params as _, ParamsProver as _};
    let vk_bytes = read(&format!("{H2_ARTIFACTS}/vk.bin"));
    let vk = h2::vk_from_bytes(&vk_bytes).unwrap_or_else(|e| fail(&e));
    let params = h2::srs::read_params(&read(&format!("{H2_ARTIFACTS}/params-k{}.bin", h2::K))).unwrap_or_else(|e| fail(&e));
    [
        ("vk-digest.bin", Blake2b512::digest(&vk_bytes).to_vec()),
        ("vk-repr.bin", vk.transcript_repr().to_repr().as_ref().to_vec()),
        ("verifier-params.bin", agg::encode_params(params.k(), &params.get_g()[0], &params.g2(), &params.s_g2())),
    ]
}

fn pin(check: bool) {
    let [digest, repr, vparams] = key_artifacts();
    let (cs, gates) = verifier_cs();
    // the zkVM's Poseidon and openings run from these: held to the reference functions before they are written or checked
    let tables = blk::fast::pedersen_tables();
    blk::fast::check(&blk::fast::poseidon_consts(), &tables).unwrap_or_else(|e| fail(&format!("the fast forms: {e}")));
    let files = [digest, repr, vparams, ("verifier-cs.bin", cs), ("verifier-gates.bin", gates), ("note-tree.bin", blk::note_tree_consts()), ("pedersen.bin", tables)];
    for (name, bytes) in &files {
        let path = format!("{ARTIFACTS}/{name}");
        if check {
            if std::fs::read(&path).ok().as_ref() != Some(bytes) {
                eprintln!("{name}: committed bytes differ from the derived ones");
                exit(1);
            }
        } else {
            std::fs::write(&path, bytes).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
        }
    }
    println!("{}", json!({ "files": files.iter().map(|(n, b)| json!({ "name": n, "bytes": b.len() })).collect::<Vec<_>>(), "check": check, "ok": true }));
}

/// A landed block as the landing contract's test reads it: its public values and every list as the contract takes
/// it, the leaves and the memos (MEMO_LEN bytes each, in the order of the outputs, found among `memos`) packed.
fn block_json(l: &Landed, memos: &[Vec<u8>]) -> Value {
    let hx = |b: &[u8]| format!("0x{}", hex::encode(b));
    let memo_of = |h: &[u8]| -> Vec<u8> { memos.iter().find(|m| blk::memo_hash(m)[..] == *h).cloned().unwrap_or_else(|| fail("an output without its memo")) };
    json!({
        "publicValues": hx(&l.out.encode()),
        "leaves": hx(&l.data.outputs.iter().flat_map(|o| o[..32].to_vec()).collect::<Vec<u8>>()),
        "memos": hx(&l.data.outputs.iter().flat_map(|o| memo_of(&o[32..])).collect::<Vec<u8>>()),
        "nullifiers": l.data.nullifiers.iter().map(|n| hx(n)).collect::<Vec<_>>(),
        "anchors": l.data.anchors.iter().map(|a| hx(a)).collect::<Vec<_>>(),
        "deposits": hx(&l.data.deposits.concat()),
        "exits": hx(&l.data.exits.concat()),
        "pools": hx(&l.data.pools.concat()),
    })
}

/// The token the fixture's pool pairs with ETH: the landing contract's test deploys an 18-decimal token here.
const FIXTURE_TOKEN: [u8; 20] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x7a, 0xc1, 0x70];

/// A deposit as the landing contract's test makes it: the token (zero for ETH), the value and the commitment and body its shield names.
fn deposit_json(token: &[u8; 20], value: u64, p: &Prepared) -> Value {
    let hx = |b: &[u8]| format!("0x{}", hex::encode(b));
    json!({ "token": hx(token), "value": value, "cx": hx(&fr_be(&p.spend.dep[0])), "cy": hx(&fr_be(&p.spend.dep[1])), "body": hx(&fr_be(&p.spend.body)) })
}

/// The fixture for a landing contract at `lander` on `chain_id`; each block's guest input is kept beside it as
/// FILE.b<i>.stdin, for tacit-block-gpu to prove.
fn fixture(path: &str, chain_id: u64, lander: [u8; 20]) {
    let k = keys();
    let elf = elf("TACIT_BLOCK_ELF", BLOCK_ELF);
    let chain = blk::chain_binding(chain_id, &lander);
    let mut c = Chain::bound(8, chain);
    c.asset_f = asset_field(&[0u8; 32]);
    let genesis = c.state.clone();
    let shield = c.spend_with(&k, &[], &[(2, secret(80, 0, 0), 500)], None, Some(500), "fixture shield", 0);
    let l1 = c.land(&elf, &k, &[shield.clone()]).unwrap_or_else(|e| fail(&format!("fixture shield: {e}")));
    let to = [0xab; 20];
    let pay_out = c.spend_with(&k, &[&l1.notes[0].clone()], &[(2, secret(81, 0, 0), 380)], Some((120, to)), None, "fixture exit", c.leaves.len());
    let l2 = c.land(&elf, &k, &[pay_out.clone()]).unwrap_or_else(|e| fail(&format!("fixture exit: {e}")));
    // Block 2 takes only the queue: the 380 kept in block 1, spent by a forced spend posted on L1 (`force`).
    let forced = c.spend(&k, &[&l2.notes[0].clone()], &[(3, secret(82, 0, 0), 380)], "fixture forced", c.leaves.len());
    let posted = post(&forced);
    let l3 = c.land_with(&elf, &k, &[], &[posted.clone()]).unwrap_or_else(|e| fail(&format!("fixture forced: {e}")));
    if l3.data.nullifiers.len() != 1 || l3.out.queue_len != 1 {
        fail("the fixture's forced spend was not taken");
    }

    // Blocks 3 to 5, the chain's pools. Block 3 makes a pool of ETH and the token from two deposits that go straight into it.
    let eth = c.asset_f;
    let mut padded = [0u8; 32];
    padded[12..].copy_from_slice(&FIXTURE_TOKEN);
    let tok = asset_field(&padded);
    let x_first = fr_be(&eth) < fr_be(&tok);
    let lp = ops::lp_asset(&eth, &tok);
    let group = [9u8; 32];
    let s_lp = secret(83, 0, 0);
    let (lp_to, lp_memo) = c.note_to(4, &s_lp, "fixture lp");
    let (back_e, back_e_memo) = c.note_to(4, &secret(83, 0, 1), "fixture lp back eth");
    let (back_t, back_t_memo) = c.note_to(4, &secret(83, 0, 2), "fixture lp back token");
    let add_e = c.spend_full(&k, &[], &[], None, Some(1_000_000), Some((1_000_000, ops::Op::Add { other: tok, group, min: 1, to: lp_to, back: back_e }, vec![lp_memo.clone(), back_e_memo])), "fixture add eth", c.leaves.len());
    let add_t = of_asset(&c, tok).spend_full(&k, &[], &[], None, Some(4_000_000), Some((4_000_000, ops::Op::Add { other: eth, group, min: 1, to: lp_to, back: back_t }, vec![lp_memo, back_t_memo])), "fixture add token", c.leaves.len());
    let l4 = c.land(&elf, &k, &[add_e.clone(), add_t.clone()]).unwrap_or_else(|e| fail(&format!("fixture pool: {e}")));
    let shares = 2_000_000 - ops::LOCKED_LIQUIDITY as u64;
    let lp_leaf = ops::Made { asset: lp, value: shares, to: lp_to }.leaf();
    if c.state.pools.len() != 1 || l4.data.pools.len() != 1 || l4.data.outputs.len() != 1 || l4.data.outputs[0][..32] != fr_be(&lp_leaf) {
        fail("the fixture's pool was not made");
    }
    // Block 4: swaps from deposits, ETH for the token and the token for ETH, and one whose limit the price misses.
    let (to_c, m_c) = c.note_to(5, &secret(84, 0, 0), "fixture swap eth");
    let (to_d, m_d) = c.note_to(6, &secret(84, 0, 1), "fixture swap token");
    let (to_e, m_e) = c.note_to(7, &secret(84, 0, 2), "fixture swap missed");
    let sw_c = c.spend_full(&k, &[], &[], None, Some(10_000), Some((10_000, ops::Op::Swap { want: tok, min: 1, to: to_c }, vec![m_c])), "fixture swap eth", c.leaves.len());
    let sw_d = of_asset(&c, tok).spend_full(&k, &[], &[], None, Some(30_000), Some((30_000, ops::Op::Swap { want: eth, min: 1, to: to_d }, vec![m_d])), "fixture swap token", c.leaves.len());
    let sw_e = c.spend_full(&k, &[], &[], None, Some(5_000), Some((5_000, ops::Op::Swap { want: tok, min: 1_000_000_000_000, to: to_e }, vec![m_e])), "fixture swap missed", c.leaves.len());
    let l5 = c.land(&elf, &k, &[sw_c.clone(), sw_d.clone(), sw_e.clone()]).unwrap_or_else(|e| fail(&format!("fixture swaps: {e}")));
    let (num, den) = change_price(&l5.data.pools[0]);
    let got_c = u64::try_from(if x_first { num_bigint::BigUint::from(10_000u64) * &num / &den } else { num_bigint::BigUint::from(10_000u64) * &den / &num }).unwrap();
    let c_leaf = ops::Made { asset: tok, value: got_c, to: to_c }.leaf();
    let e_leaf = ops::Made { asset: eth, value: 5_000, to: to_e }.leaf();
    if l5.data.outputs.len() != 3 || !l5.data.outputs.iter().any(|o| o[..32] == fr_be(&c_leaf)) || !l5.data.outputs.iter().any(|o| o[..32] == fr_be(&e_leaf)) {
        fail("the fixture's swaps did not make the notes expected");
    }
    // Block 5: half the pool's shares taken out by a spend posted to the queue, beside a spend that exits what the ETH bought.
    let lp_note = c.made_note(&lp_leaf, 4, &s_lp, shares);
    let half = shares / 2;
    let (to_x, m_x) = c.note_to(4, &secret(85, 0, 0), "fixture remove x");
    let (to_y, m_y) = c.note_to(4, &secret(85, 0, 1), "fixture remove y");
    let (to_b, m_b) = c.note_to(4, &secret(85, 0, 2), "fixture remove back");
    let rm = of_asset(&c, lp).spend_full(&k, &[&lp_note], &[(4, secret(85, 0, 3), shares - half)], None, None, Some((half, ops::Op::Remove { min_x: 1, min_y: 1, to_x, to_y, back: to_b }, vec![m_x, m_y, m_b])), "fixture remove", c.leaves.len());
    let posted_rm = post(&rm);
    let c_note = c.made_note(&c_leaf, 5, &secret(84, 0, 0), got_c);
    let tok_to = [0xcd; 20];
    let tok_exit = of_asset(&c, tok).spend_with(&k, &[&c_note], &[], Some((got_c, tok_to)), None, "fixture token exit", c.leaves.len());
    let pool_before = c.state.pools[0].clone();
    let l6 = c.land_with(&elf, &k, &[tok_exit.clone()], &[posted_rm.clone()]).unwrap_or_else(|e| fail(&format!("fixture removal: {e}")));
    if l6.data.nullifiers.len() != 2 || l6.data.exits.len() != 1 || c.state.pools[0].supply != pool_before.supply - half as u128 || l6.out.queue_len != 2 {
        fail("the fixture's removal or exit was not taken");
    }
    let mut op_memos: Vec<Vec<u8>> = [&add_e, &add_t, &sw_c, &sw_d, &sw_e].iter().flat_map(|p| p.op_memos.clone()).collect();
    op_memos.extend(posted_memos(&posted_rm.payload));
    let hx = |b: &[u8]| format!("0x{}", hex::encode(b));
    let zero = [0u8; 20];
    let doc = json!({
        "chainId": chain_id,
        "lander": hx(&lander),
        "chain": hx(&chain),
        "genesisState": hx(&genesis.digest()),
        "genesisRoot": hx(&fr_be(&genesis.notes.root)),
        "nullifierGenesisRoot": hx(&genesis.nf_root),
        "spendVk": hx(&blk::vk_hash(&k.digest)),
        "deposit": { "value": 500, "cx": hx(&fr_be(&shield.spend.dep[0])), "cy": hx(&fr_be(&shield.spend.dep[1])), "body": hx(&fr_be(&shield.spend.body)) },
        "exit": { "value": 120, "to": hx(&to) },
        "forced": hx(&posted.payload),
        "token": hx(&FIXTURE_TOKEN),
        "opDeposits": [
            deposit_json(&zero, 1_000_000, &add_e),
            deposit_json(&FIXTURE_TOKEN, 4_000_000, &add_t),
            deposit_json(&zero, 10_000, &sw_c),
            deposit_json(&FIXTURE_TOKEN, 30_000, &sw_d),
            deposit_json(&zero, 5_000, &sw_e),
        ],
        "forcedRemove": hx(&posted_rm.payload),
        "tokenExit": { "value": got_c, "to": hx(&tok_to) },
        "blocks": [
            block_json(&l1, &shield.memos),
            block_json(&l2, &pay_out.memos),
            block_json(&l3, &posted_memos(&posted.payload)),
            block_json(&l4, &op_memos),
            block_json(&l5, &op_memos),
            block_json(&l6, &op_memos),
        ],
    });
    std::fs::write(path, serde_json::to_string_pretty(&doc).unwrap()).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
    for (i, l) in [&l1, &l2, &l3, &l4, &l5, &l6].iter().enumerate() {
        let f = format!("{path}.b{i}.stdin");
        std::fs::write(&f, stdin_file(&l.stdin)).unwrap_or_else(|e| fail(&format!("{f}: {e}")));
    }
    let p = &c.state.pools[0];
    println!("{}", json!({ "fixture": path, "blocks": 6, "pool": [p.rx.to_string(), p.ry.to_string(), p.supply.to_string()], "token_bought": got_c, "cycles": [l1.cycles, l2.cycles, l3.cycles, l4.cycles, l5.cycles, l6.cycles] }));
}

/// Runs a block whose input `tamper` changed, expecting the guest to refuse it; the chain is left as it was.
fn expect_refused_input(c: &Chain, elf: &[u8], k: &Keys, spends: &[Prepared], posts: &[Post], tamper: impl FnOnce(&mut Vec<Vec<u8>>), what: &str) {
    let (mut bufs, _, _, _) = c.clone().block_input(k, spends, posts);
    tamper(&mut bufs);
    match execute(elf, &bufs) {
        Ok(_) => fail(&format!("the guest took {what}")),
        Err(e) => println!("{}", json!({ "refused": what, "why": e })),
    }
}

fn expect_refused(c: &mut Chain, elf: &[u8], k: &Keys, spends: &[Prepared], what: &str) {
    match c.land(elf, k, spends) {
        Ok(_) => fail(&format!("the guest took {what}")),
        Err(e) => println!("{}", json!({ "refused": what, "why": e })),
    }
}

fn test() {
    pin(true);
    let k = keys();
    let elf = elf("TACIT_BLOCK_ELF", BLOCK_ELF);
    let mut c = Chain::new(8);

    // Block 1: four spends of fresh notes, all against the root the block starts from.
    let b1 = spends_of(&mut c, &k, 4, 10);
    let l1 = c.land(&elf, &k, &b1).unwrap_or_else(|e| fail(&format!("block 1: {e}")));
    if !l1.data.anchors.is_empty() || l1.data.outputs.len() != 12 || l1.data.nullifiers.len() != 8 {
        fail("block 1 committed other lists than expected");
    }
    println!("{}", json!({ "block": 1, "spends": 4, "outputs": l1.data.outputs.len(), "cycles": l1.cycles, "next_root": hex::encode(l1.out.next_root) }));

    // Block 2: wallet 1 spends the 900 it received in block 1, against block 1's root.
    let received = l1.notes.iter().find(|n| n.owner == 1 && n.v == 900).cloned().unwrap_or_else(|| fail("no note for wallet 1"));
    let at1 = c.leaves.len();
    let pay = c.spend(&k, &[&received], &[(3, secret(30, 0, 0), 500), (1, secret(30, 0, 1), 400)], "tacit-block block 2 pay", at1);
    let l2 = c.land(&elf, &k, &[pay]).unwrap_or_else(|e| fail(&format!("block 2: {e}")));
    if !l2.data.anchors.is_empty() || l2.data.nullifiers.len() != 1 {
        fail("block 2 committed other lists than expected");
    }
    println!("{}", json!({ "block": 2, "spent_note_from_block_1": received.index, "cycles": l2.cycles, "next_root": hex::encode(l2.out.next_root) }));

    // A spend proven against a root from before the last block lands without its anchor on any public list,
    // the root being among the state's recent ones; once that root has aged out, the block lists it.
    let old = c.mint(&[(5, secret(40, 0, 0), 70), (5, secret(40, 0, 1), 30), (5, secret(40, 0, 2), 9)]);
    let old_at = c.leaves.len();
    let old_root = c.state.notes.root;
    let filler = spends_of(&mut c, &k, 1, 50);
    c.land(&elf, &k, &filler).unwrap_or_else(|e| fail(&format!("filler block: {e}")));
    let late = c.spend(&k, &[&old[0], &old[1]], &[(6, secret(41, 0, 0), 100)], "tacit-block recent anchor", old_at);
    let l3 = c.land(&elf, &k, &[late]).unwrap_or_else(|e| fail(&format!("recent anchor: {e}")));
    if !l3.data.anchors.is_empty() {
        fail("a recent anchor was listed");
    }
    let mut aged = c.clone();
    let newest = aged.state.recent[RECENT - 1];
    aged.state.recent = [[0u8; 32]; RECENT];
    aged.state.recent[RECENT - 1] = newest;
    let older = aged.spend(&k, &[&old[2]], &[(6, secret(42, 0, 0), 9)], "tacit-block aged anchor", old_at);
    let l4 = aged.land(&elf, &k, &[older]).unwrap_or_else(|e| fail(&format!("aged anchor: {e}")));
    if l4.data.anchors != vec![fr_be(&old_root)] {
        fail("an anchor older than the recent roots is not listed");
    }
    println!("{}", json!({ "recent_anchor_unlisted": hex::encode(fr_be(&old_root)), "aged_anchor_listed": true }));

    // A deposit: a shield of 500 into a note of wallet 2. The block commits the record the landing contract matches
    // with the deposit made on L1: asset, value, commitment and the body the depositor named.
    let shield = c.spend_with(&k, &[], &[(2, secret(70, 0, 0), 500)], None, Some(500), "shield", c.leaves.len());
    let l5 = c.land(&elf, &k, &[shield.clone()]).unwrap_or_else(|e| fail(&format!("shield: {e}")));
    let want_dep = [fr_be(&c.asset_f), word32(500), fr_be(&shield.spend.dep[0]), fr_be(&shield.spend.dep[1]), fr_be(&shield.spend.body)].concat();
    if l5.data.deposits != vec![want_dep] || !l5.data.exits.is_empty() {
        fail("the shield's deposit record is not the one expected");
    }
    // An exit: wallet 2 spends that note, keeps 380 and pays 120 out to an address its body names.
    let deposited = l5.notes[0].clone();
    let to = [0xab; 20];
    let pay_out = c.spend_with(&k, &[&deposited], &[(2, secret(71, 0, 0), 380)], Some((120, to)), None, "exit", c.leaves.len());
    let l6 = c.land(&elf, &k, &[pay_out]).unwrap_or_else(|e| fail(&format!("exit: {e}")));
    let mut to_word = [0u8; 32];
    to_word[12..].copy_from_slice(&to);
    if l6.data.exits != vec![[fr_be(&c.asset_f), word32(120), to_word].concat()] || !l6.data.deposits.is_empty() {
        fail("the exit's record is not the one expected");
    }
    println!("{}", json!({ "deposit_record": true, "exit_record": true }));

    // Refused: a deposit opened to another value, an exit to an address its body does not name, a memo its body
    // does not name.
    let mut bad_dep = c.spend_with(&k, &[], &[(3, secret(72, 0, 0), 50)], None, Some(50), "bad deposit", c.leaves.len());
    bad_dep.data.dep.as_mut().unwrap().v = 51;
    expect_refused(&mut c, &elf, &k, &[bad_dep], "a deposit opened to another value");
    let held = c.mint(&[(4, secret(73, 0, 0), 60), (4, secret(73, 0, 1), 70)]);
    let mut bad_to = c.spend_with(&k, &[&held[0]], &[(4, secret(74, 0, 0), 40)], Some((20, [0xcd; 20])), None, "bad exit", c.leaves.len());
    bad_to.data.exit_to = [0xee; 20];
    expect_refused(&mut c, &elf, &k, &[bad_to], "an exit to an address its body does not name");
    let mut bad_memo = c.spend(&k, &[&held[1]], &[(5, secret(75, 0, 0), 70)], "bad memo", c.leaves.len());
    bad_memo.data.memo_hashes[0][0] ^= 1;
    expect_refused(&mut c, &elf, &k, &[bad_memo], "a memo its body does not name");
    let mut bad_salt = c.spend(&k, &[&held[1]], &[(5, secret(75, 0, 1), 70)], "bad salt", c.leaves.len());
    bad_salt.data.salt[31] ^= 1;
    expect_refused(&mut c, &elf, &k, &[bad_salt], "a salt its body does not name");
    // A shield of nothing: a sound proof, but a deposit of 0 could never be made on L1, so the block could never land.
    let nothing = c.spend_with(&k, &[], &[(3, secret(76, 0, 0), 0)], None, Some(0), "deposit of nothing", c.leaves.len());
    expect_refused(&mut c, &elf, &k, &[nothing], "a deposit of nothing");

    // Refused: one note spent twice in one block (two spends, two bodies, the same nullifier).
    let fresh = c.mint(&[(2, secret(60, 0, 0), 10)]);
    let at = c.leaves.len();
    let twice_a = c.spend(&k, &[&fresh[0]], &[(4, secret(61, 0, 0), 10)], "tacit-block twice a", at);
    let twice_b = c.spend(&k, &[&fresh[0]], &[(5, secret(61, 0, 1), 10)], "tacit-block twice b", at);
    expect_refused(&mut c, &elf, &k, &[twice_a.clone(), twice_b], "a note spent twice in one block");

    // Refused: the note spent in block 2 spent again in a later block.
    let again = c.spend(&k, &[&received], &[(6, secret(62, 0, 0), 900)], "tacit-block spent again", at1);
    expect_refused(&mut c, &elf, &k, &[again], "a note spent again in a later block");

    // Refused: a tampered proof, in a commitment (its first 576 bytes are the points read before the evaluations),
    // in an evaluation (the lowest byte of the fourteenth scalar, which stays canonical), and a point's hint
    // negated (y → q − y, still on the curve, so only the check against the compressed point stands in the way).
    let mut bad = twice_a.clone();
    bad.proof[100] ^= 1;
    expect_refused(&mut c, &elf, &k, &[bad], "a tampered proof");
    let mut bad_eval = twice_a.clone();
    bad_eval.proof[576 + 13 * 32] ^= 1;
    expect_refused(&mut c, &elf, &k, &[bad_eval], "a proof with an evaluation changed");
    {
        use halo2_proofs::halo2curves::bn256::Fq;
        use halo2_proofs::halo2curves::ff::PrimeField;
        let mut bad_hint = twice_a.clone();
        let mut yb = [0u8; 32];
        yb.copy_from_slice(&bad_hint.hints[32..64]);
        let y: Fq = Option::from(Fq::from_repr(yb)).unwrap_or_else(|| fail("hint y"));
        bad_hint.hints[32..64].copy_from_slice((-y).to_repr().as_ref());
        expect_refused(&mut c, &elf, &k, &[bad_hint], "a proof whose first point's hint is its negation");
    }

    // And one spend of that note, alone, still lands.
    c.land(&elf, &k, &[twice_a]).unwrap_or_else(|e| fail(&format!("one spend of the twice-spent note: {e}")));

    // Forced spends: what anyone posts to the landing contract's queue, which every block takes in order. A sound one is taken, even
    // by a block with no spends of its own.
    let ql = c.state.queue_len;
    let fnotes = c.mint(&[(6, secret(90, 0, 0), 25), (6, secret(90, 0, 1), 15), (7, secret(90, 0, 2), 5)]);
    let good = c.spend(&k, &[&fnotes[0]], &[(7, secret(91, 0, 0), 25)], "forced good", c.leaves.len());
    let lf = c.land_with(&elf, &k, &[], &[post(&good)]).unwrap_or_else(|e| fail(&format!("a forced spend alone: {e}")));
    if lf.out.queue_len != ql + 1 || lf.data.nullifiers != vec![fr_be(&good.spend.live_nullifiers()[0])] || lf.notes.len() != 1 {
        fail("a sound forced spend was not taken");
    }
    // Passed over, the queue moving past each: a proof that fails, a memo other than the one its body names, bytes that are no
    // spend (short, a non-canonical public, a body that does not decode, an all-zero proof with zero hints), and a note spent
    // before this block.
    let mut bad_f = c.spend(&k, &[&fnotes[1]], &[(7, secret(92, 0, 0), 15)], "forced bad proof", c.leaves.len());
    bad_f.proof[576 + 13 * 32] ^= 1;
    let mut bad_memo_f = post(&c.spend(&k, &[&fnotes[1]], &[(7, secret(92, 0, 1), 15)], "forced bad memo", c.leaves.len()));
    bad_memo_f.payload[blk::FORCED_HEAD_LEN] ^= 1;
    let mut noncanon = post(&good).payload;
    noncanon[..32].fill(0xff);
    let zeros = [vec![0u8; blk::FORCED_REST_AT], SpendData::default().to_bytes()[96..].to_vec()].concat();
    let own = c.spend(&k, &[&fnotes[2]], &[(6, secret(93, 0, 0), 5)], "own beside forced", c.leaves.len());
    let posts = [post(&bad_f), bad_memo_f, junk(vec![0xab; 77]), junk(noncanon), junk(vec![0; blk::FORCED_REST_AT + 3]), junk(zeros), post(&good)];
    let lp = c.land_with(&elf, &k, &[own.clone()], &posts).unwrap_or_else(|e| fail(&format!("forced spends passed over: {e}")));
    if lp.out.queue_len != ql + 1 + posts.len() as u64 || lp.data.nullifiers != vec![fr_be(&own.spend.live_nullifiers()[0])] {
        fail("a forced spend that should be passed over was taken, or the queue did not move past it");
    }
    // A forced spend of the note one of the block's own spends: the block's own is taken, the forced one passed over.
    let x = c.mint(&[(5, secret(94, 0, 0), 9)]);
    let xa = c.spend(&k, &[&x[0]], &[(4, secret(95, 0, 0), 9)], "own of x", c.leaves.len());
    let xb = c.spend(&k, &[&x[0]], &[(3, secret(95, 0, 1), 9)], "forced of x", c.leaves.len());
    let lx = c.land_with(&elf, &k, &[xa], &[post(&xb)]).unwrap_or_else(|e| fail(&format!("own and forced of one note: {e}")));
    if lx.data.nullifiers.len() != 1 || lx.notes.len() != 1 || lx.out.queue_len != ql + 2 + posts.len() as u64 {
        fail("the block's own spend and a forced one of the same note were not resolved for the block's own");
    }
    // A forced shield: taken, its deposit record listed for the landing contract to match with the deposit made on L1.
    let fs = c.spend_with(&k, &[], &[(4, secret(98, 0, 0), 77)], None, Some(77), "forced shield", c.leaves.len());
    let ls = c.land_with(&elf, &k, &[], &[post(&fs)]).unwrap_or_else(|e| fail(&format!("a forced shield: {e}")));
    let want_fs = [fr_be(&c.asset_f), word32(77), fr_be(&fs.spend.dep[0]), fr_be(&fs.spend.dep[1]), fr_be(&fs.spend.body)].concat();
    if ls.data.deposits != vec![want_fs] || ls.notes.len() != 1 {
        fail("a forced shield was not taken with its deposit record");
    }
    // A forced exit: taken, its exit record listed for the landing contract to credit.
    let ex = c.mint(&[(3, secret(99, 0, 0), 40)]);
    let fe = c.spend_with(&k, &[&ex[0]], &[(3, secret(99, 0, 1), 30)], Some((10, [0xee; 20])), None, "forced exit", c.leaves.len());
    let le = c.land_with(&elf, &k, &[], &[post(&fe)]).unwrap_or_else(|e| fail(&format!("a forced exit: {e}")));
    let mut ee = [0u8; 32];
    ee[12..].copy_from_slice(&[0xee; 20]);
    if le.data.exits != vec![[fr_be(&c.asset_f), word32(10), ee].concat()] || le.notes.len() != 1 {
        fail("a forced exit was not taken with its exit record");
    }
    // Two forced spends of one note in one block: the first taken, the second passed over, the queue past both.
    let tw = c.mint(&[(2, secret(100, 0, 0), 12)]);
    let ta = c.spend(&k, &[&tw[0]], &[(4, secret(100, 0, 1), 12)], "forced twice a", c.leaves.len());
    let tb = c.spend(&k, &[&tw[0]], &[(5, secret(100, 0, 2), 12)], "forced twice b", c.leaves.len());
    let q0 = c.state.queue_len;
    let lt = c.land_with(&elf, &k, &[], &[post(&ta), post(&tb)]).unwrap_or_else(|e| fail(&format!("two forced of one note: {e}")));
    if lt.data.nullifiers.len() != 1 || lt.notes.len() != 1 || lt.notes[0].owner != 4 || lt.out.queue_len != q0 + 2 {
        fail("of two forced spends of one note, not the first alone was taken");
    }
    // A forced spend proven against a root older than the state's recent ones: taken, its anchor listed for the contract to check.
    let anc = c.mint(&[(6, secret(101, 0, 0), 21)]);
    let anc_at = c.leaves.len();
    let anc_root = c.state.notes.root;
    let filler2 = spends_of(&mut c, &k, 1, 102);
    c.land(&elf, &k, &filler2).unwrap_or_else(|e| fail(&format!("filler block: {e}")));
    let mut aged2 = c.clone();
    let newest2 = aged2.state.recent[RECENT - 1];
    aged2.state.recent = [[0u8; 32]; RECENT];
    aged2.state.recent[RECENT - 1] = newest2;
    let fa = aged2.spend(&k, &[&anc[0]], &[(6, secret(103, 0, 0), 21)], "forced aged anchor", anc_at);
    let la = aged2.land_with(&elf, &k, &[], &[post(&fa)]).unwrap_or_else(|e| fail(&format!("a forced spend with an aged anchor: {e}")));
    if la.data.anchors != vec![fr_be(&anc_root)] || la.data.nullifiers.len() != 1 {
        fail("a forced spend proven against an aged root was not taken with its anchor listed");
    }
    // What a forced spend costs a block: alone, and beside another (the second joins the block's one pairing).
    let pair = c.mint(&[(2, secret(104, 0, 0), 3), (2, secret(104, 0, 1), 4)]);
    let p1 = c.spend(&k, &[&pair[0]], &[(3, secret(105, 0, 0), 3)], "forced pair 1", c.leaves.len());
    let p2 = c.spend(&k, &[&pair[1]], &[(3, secret(105, 0, 1), 4)], "forced pair 2", c.leaves.len());
    let l2f = c.land_with(&elf, &k, &[], &[post(&p1), post(&p2)]).unwrap_or_else(|e| fail(&format!("two forced spends: {e}")));
    let junk_only = c.land_with(&elf, &k, &[], &[bad_memo_like(&c, &k)]).map(|l| l.cycles).unwrap_or_else(|e| fail(&format!("a block of junk: {e}")));
    println!("{}", json!({ "forced_taken": true, "forced_passed_over": posts.len(), "forced_shield": true, "forced_exit": true, "forced_twice": true, "forced_aged_anchor": true,
        "forced_alone_cycles": lf.cycles, "two_forced_cycles": l2f.cycles, "junk_alone_cycles": junk_only, "queue_len": c.state.queue_len }));
    // Whoever builds the block cannot say a note is spent when it is not, nor leave out that it is, nor say a sound proof fails or a
    // failing one verifies: the guest refuses the block.
    let y = c.mint(&[(5, secret(96, 0, 0), 8), (5, secret(96, 0, 1), 6)]);
    let yf = post(&c.spend(&k, &[&y[0]], &[(4, secret(97, 0, 0), 8)], "forced y", c.leaves.len()));
    let head = NfMember { next: [0u8; 32], index: 0, path: c.nf.path(0) };
    expect_refused_input(&c, &elf, &k, &[], &[yf.clone()], |b| { b[4] = [vec![1u8, 1u8], head.to_bytes()].concat(); }, "a forced spend said to be spent when it is not");
    expect_refused_input(&c, &elf, &k, &[], &[post(&good)], |b| { b[4] = vec![1u8, 0u8]; }, "a forced spend of a spent note said to be unspent");
    expect_refused_input(&c, &elf, &k, &[], &[yf], |b| { b[4] = vec![0u8, 0u8]; }, "a sound forced proof said not to verify");
    let mut yb = c.spend(&k, &[&y[1]], &[(4, secret(97, 0, 1), 6)], "forced y bad", c.leaves.len());
    yb.proof[576 + 13 * 32] ^= 1;
    expect_refused_input(&c, &elf, &k, &[], &[post(&yb)], |b| { b[4] = vec![1u8, 0u8]; }, "a failing forced proof said to verify");
    ops_test(&mut c, &elf, &k);
    println!("{}", json!({ "test": "ok", "note_roots": c.roots.len() }));
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("measure") => {
            let sizes: Vec<usize> = args[1..].iter().map(|s| s.parse().unwrap_or_else(|_| fail("sizes are numbers"))).collect();
            measure(if sizes.is_empty() { &[10] } else { &sizes });
        }
        Some("test") => test(),
        Some("pin") => pin(args.iter().any(|a| a == "--check")),
        Some("fixture") if args.len() == 2 => fixture(&args[1], FIXTURE_CHAIN_ID, FIXTURE_LANDER),
        Some("fixture") if args.len() == 4 => {
            let id: u64 = args[2].parse().unwrap_or_else(|_| fail("the chain id is a number"));
            let lander: [u8; 20] = hex::decode(args[3].trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok()).unwrap_or_else(|| fail("the lander is a 20-byte address"));
            fixture(&args[1], id, lander)
        }
        Some("dump") if args.len() == 3 => dump(args[1].parse().unwrap_or_else(|_| fail("N is a number")), &args[2]),
        _ => fail("usage: tacit-block measure N... | test | dump N FILE | fixture FILE | pin [--check]"),
    }
}


/// A published pool change's reserves and shares as the swaps left it (before any zap went in).
fn change_mid(c: &[u8]) -> (u128, u128, u128) {
    let u = |i: usize| u128::from_be_bytes(c[i..i + 16].try_into().unwrap());
    let at = ops::POOL_LEN + 64;
    (u(at), u(at + 16), u(at + 32))
}

/// A published pool change's clearing price (numerator, denominator), as a wallet reads it.
fn change_price(c: &[u8]) -> (num_bigint::BigUint, num_bigint::BigUint) {
    use num_bigint::BigUint;
    (BigUint::from_bytes_be(&c[ops::POOL_LEN..ops::POOL_LEN + 32]), BigUint::from_bytes_be(&c[ops::POOL_LEN + 32..ops::POOL_LEN + 64]))
}

/// The same chain, spending notes of `asset`.
fn of_asset(c: &Chain, asset: Fr) -> Chain {
    let mut d = c.clone();
    d.asset_f = asset;
    d
}

/// Operations: a pool of two assets made by an addition, swaps both ways cleared at one price (a limit the price misses coming back),
/// liquidity taken out, a deposit swapped as it comes in and a forced swap, each note an operation makes found as a wallet finds it
/// (from the published pool change and price, and its own keys); and refused, an exit of pool shares to L1 and an operation changed
/// after its owners signed it.
fn ops_test(c: &mut Chain, elf: &[u8], k: &Keys) {
    use num_bigint::BigUint;
    use ops::Op;
    let ax = c.asset_f;
    let ay = asset_field(&[0xcd; 32]);
    let lp = ops::lp_asset(&ax, &ay);
    let x_first = fr_be(&ax) < fr_be(&ay);
    let mint_y = |c: &mut Chain, notes: &[(usize, [u8; 33], u64)]| -> Vec<Note> {
        c.asset_f = ay;
        let n = c.mint(notes);
        c.asset_f = ax;
        n
    };
    let leaf = |asset: &Fr, v: u64, to: &ops::NoteTo| ops::Made { asset: *asset, value: v, to: *to }.leaf();
    let has = |l: &Landed, f: &Fr| l.data.outputs.iter().any(|o| o[..32] == fr_be(f));

    // a pool: 1,000,000 x and 4,000,000 y from wallet 1, two spends naming one group
    let nx = c.mint(&[(1, secret(110, 0, 0), 1_000_000)]);
    let ny = mint_y(c, &[(1, secret(110, 0, 1), 4_000_000)]);
    let s_lp = secret(111, 0, 0);
    let (lp_to, lp_memo) = c.note_to(1, &s_lp, "lp shares");
    let (bx, bx_memo) = c.note_to(1, &secret(111, 0, 1), "lp back x");
    let (by, by_memo) = c.note_to(1, &secret(111, 0, 2), "lp back y");
    let group = [7u8; 32];
    let add_x = c.spend_full(k, &[&nx[0]], &[], None, None, Some((1_000_000, Op::Add { other: ay, group, min: 1, to: lp_to, back: bx }, vec![lp_memo.clone(), bx_memo])), "add x", c.leaves.len());
    let add_y = of_asset(c, ay).spend_full(k, &[&ny[0]], &[], None, None, Some((4_000_000, Op::Add { other: ax, group, min: 1, to: lp_to, back: by }, vec![lp_memo, by_memo])), "add y", c.leaves.len());
    let la = c.land(elf, k, &[add_x, add_y]).unwrap_or_else(|e| fail(&format!("a pool made by an addition: {e}")));
    let pool = c.state.pools.first().cloned().unwrap_or_else(|| fail("no pool"));
    let (rx, ry) = if x_first { (1_000_000u128, 4_000_000u128) } else { (4_000_000, 1_000_000) };
    if c.state.pools.len() != 1 || (pool.rx, pool.ry, pool.supply) != (rx, ry, 2_000_000) || la.data.pools.len() != 1 {
        fail("the addition did not make the pool expected");
    }
    let shares = 2_000_000 - ops::LOCKED_LIQUIDITY as u64;
    let lp_leaf = leaf(&lp, shares, &lp_to);
    if !has(&la, &lp_leaf) {
        fail("the pool's shares are not among the block's notes");
    }

    // swaps both ways, and one whose limit the price misses
    let sx = c.mint(&[(2, secret(112, 0, 0), 10_000), (4, secret(112, 0, 2), 5_000)]);
    let sy = mint_y(c, &[(3, secret(112, 0, 1), 30_000)]);
    let (to2, m2) = c.note_to(2, &secret(113, 0, 0), "swap 2");
    let (to3, m3) = c.note_to(3, &secret(113, 0, 1), "swap 3");
    let (to4, m4) = c.note_to(4, &secret(113, 0, 2), "swap 4");
    let w2 = c.spend_full(k, &[&sx[0]], &[], None, None, Some((10_000, Op::Swap { want: ay, min: 1, to: to2 }, vec![m2])), "swap 2", c.leaves.len());
    let w3 = of_asset(c, ay).spend_full(k, &[&sy[0]], &[], None, None, Some((30_000, Op::Swap { want: ax, min: 1, to: to3 }, vec![m3])), "swap 3", c.leaves.len());
    let w4 = c.spend_full(k, &[&sx[1]], &[], None, None, Some((5_000, Op::Swap { want: ay, min: 1_000_000, to: to4 }, vec![m4])), "swap 4", c.leaves.len());
    let before = c.state.pools[0].clone();
    let ls = c.land(elf, k, &[w2, w3, w4]).unwrap_or_else(|e| fail(&format!("swaps: {e}")));
    let after = c.state.pools[0].clone();
    let (num, den) = change_price(&ls.data.pools[0]);
    // a wallet's payout at the published price: x sold for y at num/den, y sold for x at den/num
    let px = |a: u64| -> u64 { u64::try_from(BigUint::from(a) * &num / &den).unwrap() };
    let py = |a: u64| -> u64 { u64::try_from(BigUint::from(a) * &den / &num).unwrap() };
    let (out2, out3) = if x_first { (px(10_000), py(30_000)) } else { (py(10_000), px(30_000)) };
    if !has(&ls, &leaf(&ay, out2, &to2)) || !has(&ls, &leaf(&ax, out3, &to3)) || !has(&ls, &leaf(&ax, 5_000, &to4)) || out2 == 0 || out3 == 0 {
        fail("a swap's proceeds, or a missed limit's refund, are not among the block's notes");
    }
    if BigUint::from(after.rx) * BigUint::from(after.ry) < BigUint::from(before.rx) * BigUint::from(before.ry) {
        fail("a clearing shrank the pool's product");
    }
    println!("{}", json!({ "pool": [after.rx.to_string(), after.ry.to_string()], "swap_2_x_for_y": out2, "swap_3_y_for_x": out3, "refund_4": 5_000, "cycles": ls.cycles }));

    // liquidity taken out: half the shares, at the pool as the block finds it
    let lp_note = c.made_note(&lp_leaf, 1, &s_lp, shares);
    let half = shares / 2;
    let (tx_, mx) = c.note_to(1, &secret(114, 0, 0), "remove x");
    let (ty_, my) = c.note_to(1, &secret(114, 0, 1), "remove y");
    let (tb_, mb) = c.note_to(1, &secret(114, 0, 2), "remove back");
    let (lo, hi) = (to_note(&tx_, &ty_, x_first).0, to_note(&tx_, &ty_, x_first).1);
    let rm = of_asset(c, lp).spend_full(k, &[&lp_note], &[(1, secret(114, 0, 3), shares - half)], None, None, Some((half, Op::Remove { min_x: 1, min_y: 1, to_x: lo, to_y: hi, back: tb_ }, vec![if x_first { mx.clone() } else { my.clone() }, if x_first { my } else { mx }, mb])), "remove", c.leaves.len());
    let p0 = c.state.pools[0].clone();
    let lr = c.land(elf, k, &[rm]).unwrap_or_else(|e| fail(&format!("liquidity taken out: {e}")));
    let ox = u64::try_from(BigUint::from(half) * BigUint::from(p0.rx) / BigUint::from(p0.supply)).unwrap();
    let oy = u64::try_from(BigUint::from(half) * BigUint::from(p0.ry) / BigUint::from(p0.supply)).unwrap();
    if !has(&lr, &leaf(&p0.x, ox, &lo)) || !has(&lr, &leaf(&p0.y, oy, &hi)) || c.state.pools[0].supply != p0.supply - half as u128 {
        fail("taking liquidity out did not make the notes expected");
    }

    // a deposit swapped as it comes in: a shield whose whole deposit goes into a swap
    let (td, md) = c.note_to(5, &secret(115, 0, 0), "deposit swap");
    let ds = c.spend_full(k, &[], &[], None, Some(7_000), Some((7_000, Op::Swap { want: ay, min: 1, to: td }, vec![md])), "deposit swap", c.leaves.len());
    let p1 = c.state.pools[0].clone();
    let ld = c.land(elf, k, &[ds]).unwrap_or_else(|e| fail(&format!("a deposit swapped: {e}")));
    let (n1, d1) = change_price(&ld.data.pools[0]);
    let got = u64::try_from(if x_first { BigUint::from(7_000u64) * &n1 / &d1 } else { BigUint::from(7_000u64) * &d1 / &n1 }).unwrap();
    if ld.data.deposits.len() != 1 || !has(&ld, &leaf(&ay, got, &td)) || ld.data.exits.len() != 0 || p1 == c.state.pools[0] {
        fail("a deposit swapped as it came in did not make its note");
    }

    // a forced swap, taken from the queue with its receiver's memo
    let fx = c.mint(&[(6, secret(116, 0, 0), 2_000)]);
    let (tf, mf) = c.note_to(6, &secret(116, 0, 1), "forced swap");
    let fsw = c.spend_full(k, &[&fx[0]], &[], None, None, Some((2_000, Op::Swap { want: ay, min: 1, to: tf }, vec![mf])), "forced swap", c.leaves.len());
    let lf = c.land_with(elf, k, &[], &[post(&fsw)]).unwrap_or_else(|e| fail(&format!("a forced swap: {e}")));
    if lf.data.nullifiers.len() != 1 || lf.data.pools.len() != 1 {
        fail("a forced swap was not taken");
    }

    // zaps: x alone (one of 20,000 and the same split in two), y alone, one whose limit the price misses, and liquidity taken out into
    // one asset, in one block; every note as a wallet works it out from the pool as the block found it and what the block publishes
    let lp_left = lr.notes[0].clone();
    let zx = c.mint(&[(2, secret(118, 0, 0), 20_000), (3, secret(118, 0, 1), 10_000), (3, secret(118, 0, 2), 10_000), (4, secret(118, 0, 3), 3_000)]);
    let zy = mint_y(c, &[(5, secret(118, 0, 4), 50_000)]);
    let zap = |c: &Chain, n: &Note, asset: Fr, other: Fr, min: u64, w: usize, t: u8, tag: &str| -> (Prepared, ops::NoteTo, ops::NoteTo) {
        let (to, tm) = c.note_to(w, &secret(119, 0, t), tag);
        let (back, bm) = c.note_to(w, &secret(119, 0, t + 1), tag);
        (of_asset(c, asset).spend_full(k, &[n], &[], None, None, Some((n.v, Op::Zap { other, min, to, back }, vec![tm, bm])), tag, c.leaves.len()), to, back)
    };
    let (z1, z1to, z1back) = zap(c, &zx[0], ax, ay, 1, 2, 0, "zap 20000");
    let (z2, z2to, z2back) = zap(c, &zx[1], ax, ay, 1, 3, 2, "zap 10000 a");
    let (z3, z3to, z3back) = zap(c, &zx[2], ax, ay, 1, 3, 4, "zap 10000 b");
    let (z4, _, z4back) = zap(c, &zx[3], ax, ay, 1_000_000_000, 4, 6, "zap missed");
    let (z5, z5to, z5back) = zap(c, &zy[0], ay, ax, 1, 5, 8, "zap y");
    let (out_to, out_m) = c.note_to(1, &secret(119, 0, 10), "out to x");
    let (out_back, out_bm) = c.note_to(1, &secret(119, 0, 11), "out back");
    let rt = of_asset(c, lp).spend_full(k, &[&lp_left], &[], None, None, Some((lp_left.v, Op::RemoveTo { want: ax, min: 1, to: out_to, back: out_back }, vec![out_m, out_bm])), "remove to x", c.leaves.len());
    let p0 = c.state.pools[0].clone();
    let lz = c.land(elf, k, &[z1, z2, z3, z4, z5, rt]).unwrap_or_else(|e| fail(&format!("zaps: {e}")));
    let ch = &lz.data.pools[0];
    let (num, den) = change_price(ch);
    let mid = change_mid(ch);
    let end = c.state.pools[0].clone();
    // x is sold for y at num/den, y for x at den/num
    let buy = |sells_x: bool, a: u64| -> u64 { u64::try_from(if sells_x { BigUint::from(a) * &num / &den } else { BigUint::from(a) * &den / &num }).unwrap() };
    // what a zap of `a` (selling x or not) makes, as its wallet works it out: (shares, x back, y back)
    let zapped = |a: u64, sells_x: bool| -> (u64, u64, u64) {
        let sold = ops::zap_part(a, if sells_x { p0.rx } else { p0.ry });
        let bought = buy(sells_x == x_first, sold);
        let (ex, ey) = if sells_x == x_first { ((a - sold) as u128, bought as u128) } else { (bought as u128, (a - sold) as u128) };
        let (rx, ry, sup) = mid;
        let s = (BigUint::from(ex) * BigUint::from(sup) / BigUint::from(rx)).min(BigUint::from(ey) * BigUint::from(sup) / BigUint::from(ry));
        let up = |r: u128| u128::try_from((&s * BigUint::from(r) + BigUint::from(sup) - 1u8) / BigUint::from(sup)).unwrap();
        (u64::try_from(&s).unwrap(), (ex - up(rx)) as u64, (ey - up(ry)) as u64)
    };
    let (px, py) = (if x_first { p0.x } else { p0.y }, if x_first { p0.y } else { p0.x });
    let _ = (px, py);
    let check = |what: &str, zap_leaves: Vec<(Fr, u64, ops::NoteTo)>| {
        for (asset, v, to) in zap_leaves {
            if v > 0 && !has(&lz, &leaf(&asset, v, &to)) {
                fail(&format!("{what}: a note its wallet expects ({v}) is not among the block's notes"));
            }
        }
    };
    let (pool_x, pool_y) = (p0.x, p0.y);
    let (s1, x1, y1) = zapped(20_000, true);
    check("the zap of 20,000", vec![(lp, s1, z1to), (pool_x, x1, z1back), (pool_y, y1, z1back)]);
    let (s2, x2, y2) = zapped(10_000, true);
    check("the split zaps", vec![(lp, s2, z2to), (pool_x, x2, z2back), (pool_y, y2, z2back), (lp, s2, z3to), (pool_x, x2, z3back), (pool_y, y2, z3back)]);
    check("the missed zap", vec![(ax, 3_000, z4back)]);
    let (s5, x5, y5) = zapped(50_000, false);
    check("the zap of y", vec![(lp, s5, z5to), (pool_x, x5, z5back), (pool_y, y5, z5back)]);
    let e = BigUint::from(lp_left.v);
    let (ox, oy) = (u64::try_from(&e * BigUint::from(p0.rx) / BigUint::from(p0.supply)).unwrap(), u64::try_from(&e * BigUint::from(p0.ry) / BigUint::from(p0.supply)).unwrap());
    let (o_want, o_other) = if x_first { (ox, oy) } else { (oy, ox) };
    check("liquidity taken out into x", vec![(ax, o_want + buy(!x_first, o_other), out_to)]);
    // the pool's reserves a share never shrink for a zap: the shares' value only grows from `mid` to the end
    let sq = |r: (u128, u128, u128)| BigUint::from(r.0) * BigUint::from(r.1) * BigUint::from(end.supply) * BigUint::from(end.supply) <= BigUint::from(end.rx) * BigUint::from(end.ry) * BigUint::from(r.2) * BigUint::from(r.2);
    if !sq(mid) || s1 == 0 || s5 == 0 {
        fail("zaps made no shares, or their shares are worth more than they put in");
    }
    println!("{}", json!({ "zap_20000_shares": s1, "zap_10000_shares_each": s2, "zap_y_shares": s5, "out_to_x": o_want + buy(!x_first, o_other), "cycles": lz.cycles }));

    // refused: an operation changed after its owners signed it
    let more = c.mint(&[(2, secret(117, 0, 0), 900)]);
    let (tm, mm) = c.note_to(2, &secret(117, 0, 1), "changed");
    let mut changed = c.spend_full(k, &[&more[0]], &[], None, None, Some((900, Op::Swap { want: ay, min: 1, to: tm }, vec![mm])), "changed", c.leaves.len());
    changed.data.op = Some(Op::Swap { want: ay, min: 2, to: tm });
    expect_refused(c, elf, k, &[changed], "an operation changed after its owners signed it");
    println!("{}", json!({ "ops": "ok", "pools": c.state.pools.len(), "remove_cycles": lr.cycles, "deposit_swap_cycles": ld.cycles, "forced_swap_cycles": lf.cycles }));
}

/// A remove's two receivers in the pool's order (smaller asset first).
fn to_note(a: &ops::NoteTo, b: &ops::NoteTo, x_first: bool) -> (ops::NoteTo, ops::NoteTo) {
    if x_first {
        (*a, *b)
    } else {
        (*b, *a)
    }
}
