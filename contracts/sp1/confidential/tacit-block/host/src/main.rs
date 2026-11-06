//! tacit-block: builds blocks of real Halo2 spends over a test chain, runs the block guest on them in SP1's
//! executor, and checks what it commits against an independent replay (the note tree rebuilt from every leaf,
//! the nullifier tree kept in full).
//!
//! tacit-block measure N...   per N: one block of N spends (two inputs, three outputs each); prints the block
//!                            guest's cycles, its cycles by section, and btc-pool-agg's for the same proofs, as
//!                            JSON lines
//! tacit-block test           a two-block chain, where a note received in block 1 is spent in block 2 and an
//!                            older root is listed as an anchor, then the blocks the guest must refuse: a note
//!                            spent twice in one block, a note spent again in a later block, a tampered proof
//! tacit-block dump N FILE    one block of N spends as the guest's stdin, for tacit-block-gpu
//! tacit-block pin [--check]  write the guest's artifacts, or check the committed ones (exit 1 on a mismatch): the
//!                            spend key's digest, transcript representative and verifier params (as btc-pool-agg
//!                            derives them), verifier-cs.bin, the spend circuit's finished constraint system the
//!                            guest reads the key with, and note-tree.bin, the note tree's Poseidon constants and
//!                            empty subtrees
//!
//! The guest ELF is TACIT_BLOCK_ELF (default ../elf/tacit-block), btc-pool-agg's is BTC_POOL_AGG_ELF (default
//! ../../elf/btc-pool-agg).

use btc_pool_agg_common as agg;
use btc_pool_halo2 as h2;
use btc_pool_halo2::model::{
    asset_field, body_hash, build_witness, fr_u64, leaf_of, output_keys, owned_keys, sign, wallet_keys, InNote, OutNote, SpendWitness, Tree, Wallet,
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
use tacit_block_common::{self as blk, fr_be, h64, nf_record, nf_zeros, BlockData, BlockOut, NfWitness, State, NF_LEVELS, RECENT};

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

/// The test chain: every leaf in tree order, the state as the guest carries it, the nullifier tree replayed
/// by the host, and the note roots the chain has had.
#[derive(Clone)]
struct Chain {
    wallets: Rc<Vec<Wallet>>,
    asset_f: Fr,
    leaves: Vec<Fr>,
    state: State,
    nf: NfTree,
    roots: Vec<Fr>,
}

/// A spend ready for the guest, with the outputs it makes (wallet, secret, value, leaf).
#[derive(Clone)]
struct Prepared {
    publics: Vec<u8>,
    proof: Vec<u8>,
    hints: Vec<u8>,
    spend: blk::Spend,
    outs: Vec<(usize, [u8; 33], u64, Fr)>,
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
}

impl Chain {
    fn new(wallets: usize) -> Chain {
        let wallets = Rc::new((0..wallets).map(|i| wallet_keys(&[i as u8 + 1; 32], "signet")).collect());
        let state = State::default();
        let nf = NfTree::new();
        if nf.root() != state.nf_root {
            fail("the replayed nullifier tree does not start where the state does");
        }
        let roots = vec![state.notes.root];
        Chain { wallets, asset_f: asset_field(&[0xabu8; 32]), leaves: vec![], state, nf, roots }
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
    fn spend(&self, k: &Keys, ins: &[&Note], outs: &[(usize, [u8; 33], u64)], body: &str, at: usize) -> Prepared {
        let tree = Tree::new(&self.leaves[..at]);
        let bh = body_hash(body.as_bytes());
        let mut inputs: [Option<InNote>; 2] = [None, None];
        for (i, n) in ins.iter().enumerate() {
            let o = owned_keys(&self.wallets[n.owner], &n.s);
            inputs[i] = Some(InNote { v: n.v, rho: o.rho, nk: o.nk.clone(), ak: o.ak, index: n.index, path: tree.path(n.index as usize), sig: sign(&o.sk, &bh) });
        }
        let mut outputs: [Option<OutNote>; 3] = [None, None, None];
        let mut made = vec![];
        for (j, (w, s, v)) in outs.iter().enumerate() {
            let o = output_keys(&self.wallets[*w].a_pub, &self.wallets[*w].n_pub, s);
            if owned_keys(&self.wallets[*w], s).npk != o.npk {
                fail("an output's owner cannot derive its keys");
            }
            made.push((*w, *s, *v, leaf_of(&self.asset_f, &fr_u64(*v), &o.npk, &o.rho)));
            outputs[j] = Some(OutNote { v: *v, npk: o.npk, rho: o.rho });
        }
        let w = build_witness(tree.root, bh, self.asset_f, &inputs, &outputs, None, None).unwrap_or_else(|e| fail(&e));
        prove(k, &w, made)
    }

    /// The guest's input for a block of `spends` on this chain, and the nullifier witnesses it carries; the
    /// host's nullifier tree takes the block's nullifiers as it goes.
    fn block_input(&mut self, spends: &[Prepared]) -> (Vec<Vec<u8>>, Vec<NfWitness>) {
        let mut bufs = vec![self.state.to_bytes(), (spends.len() as u32).to_le_bytes().to_vec()];
        let mut nfw = vec![];
        for p in spends {
            bufs.push(p.publics.clone());
            bufs.push(p.proof.clone());
            bufs.push(p.hints.clone());
            let mut wb = vec![];
            for nf in p.spend.live_nullifiers() {
                let w = self.nf.insert(&fr_be(&nf));
                wb.extend(w.to_bytes());
                nfw.push(w);
            }
            bufs.push(wb);
        }
        (bufs, nfw)
    }

    /// Runs a block through the guest and lands it on the chain if the guest takes it; checks the guest's
    /// public values against `apply` and the new state against the independent replay.
    fn land(&mut self, elf: &[u8], k: &Keys, spends: &[Prepared]) -> Result<Landed, String> {
        let before = self.clone();
        let (bufs, nfw) = self.block_input(spends);
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
        let (next, out, data) = blk::apply(&self.state, &list, &nfw, blk::vk_hash(&k.digest)).unwrap_or_else(|e| fail(&format!("the guest took a block apply refuses: {e}")));
        if pv != out.encode() {
            fail("the guest committed other public values than apply");
        }
        let prev_len = self.leaves.len() as u64;
        for l in &data.leaves {
            self.leaves.push(blk::fr_from_be(l).unwrap());
        }
        if Tree::new(&self.leaves).root != next.notes.root {
            fail("the block's note root differs from the tree built from every leaf");
        }
        if self.nf.root() != next.nf_root || self.nf.records.len() as u64 != next.nf_size {
            fail("the block's nullifier tree differs from the replayed one");
        }
        let mut notes = vec![];
        for p in spends {
            for (w, s, v, leaf) in &p.outs {
                let pos = data.leaves.iter().position(|l| *l == fr_be(leaf)).ok_or("an output is not among the block's leaves")?;
                notes.push(Note { owner: *w, s: *s, v: *v, index: prev_len + pos as u64 });
            }
        }
        self.state = next;
        self.roots.push(self.state.notes.root);
        Ok(Landed { out, data, notes, cycles, sections, secs, stdin_bytes })
    }
}

fn prove(k: &Keys, w: &SpendWitness, outs: Vec<(usize, [u8; 33], u64, Fr)>) -> Prepared {
    let proof = h2::prove(&k.params, &k.pk, w).unwrap_or_else(|e| fail(&e));
    let publics = w.publics();
    if !h2::verify(&k.params, k.pk.get_vk(), &publics, &proof) {
        fail("a spend proof does not verify natively");
    }
    let (hints, _) = agg::record_hints(&k.vparams, k.pk.get_vk(), &publics, &proof).unwrap_or_else(|e| fail(&format!("hints: {e:?}")));
    Prepared { publics: publics.iter().flat_map(fr_be).collect(), proof, hints, spend: blk::Spend::from_publics(&publics), outs }
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
                "sections": l.sections, "leaves": l.out.leaves, "nullifiers": l.data.nullifiers.len(),
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
    let (bufs, _) = c.clone().block_input(&spends);
    let mut file = (bufs.len() as u32).to_le_bytes().to_vec();
    for b in &bufs {
        file.extend((b.len() as u32).to_le_bytes());
        file.extend(b);
    }
    let l = c.land(&elf("TACIT_BLOCK_ELF", BLOCK_ELF), &k, &spends).unwrap_or_else(|e| fail(&e));
    std::fs::write(path, &file).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
    println!("{}", json!({ "spends": n, "file": path, "bytes": file.len(), "cycles": l.cycles, "public_values": hex::encode(l.out.encode()) }));
}

/// The guest's constraint-system blob from the pinned key: the system the circuit configures, selectors
/// compressed, and the degree the domain is built for. The key read with the decoded blob must pin exactly what
/// the key read through `configure` pins (the representation halo2 hashes into every transcript).
fn verifier_cs() -> Vec<u8> {
    use halo2_proofs::plonk::{Circuit, ConstraintSystem};
    use halo2_proofs::SerdeFormat;
    let vk_bytes = read(&format!("{H2_ARTIFACTS}/vk.bin"));
    let vk = h2::vk_from_bytes(&vk_bytes).unwrap_or_else(|e| fail(&e));
    let mut configured = ConstraintSystem::<Fr>::default();
    let _ = <h2::SpendCircuit as Circuit<Fr>>::configure(&mut configured);
    let blob = vk.cs().to_compact(configured.degree());
    let (cs, degree) = ConstraintSystem::<Fr>::from_compact(&blob).unwrap_or_else(|| fail("the blob does not decode"));
    if format!("{cs:?}") != format!("{:?}", vk.cs()) {
        fail("the decoded constraint system differs from the key's");
    }
    let repr = vk.transcript_repr();
    let read = h2::Vk::read_with_cs(&mut &vk_bytes[..], SerdeFormat::RawBytes, cs, degree, repr).unwrap_or_else(|e| fail(&format!("read_with_cs: {e}")));
    if format!("{:?}", read.pinned()) != format!("{:?}", vk.pinned()) {
        fail("the key read with the blob pins something other than the key read through configure");
    }
    blob
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
    let files = [digest, repr, vparams, ("verifier-cs.bin", verifier_cs()), ("note-tree.bin", blk::note_tree_consts())];
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
    if !l1.data.anchors.is_empty() || l1.out.leaves != 12 || l1.data.nullifiers.len() != 8 {
        fail("block 1 committed other lists than expected");
    }
    println!("{}", json!({ "block": 1, "spends": 4, "leaves": l1.out.leaves, "cycles": l1.cycles, "next_root": hex::encode(l1.out.next_root) }));

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

    // Refused: one note spent twice in one block (two spends, two bodies, the same nullifier).
    let fresh = c.mint(&[(2, secret(60, 0, 0), 10)]);
    let at = c.leaves.len();
    let twice_a = c.spend(&k, &[&fresh[0]], &[(4, secret(61, 0, 0), 10)], "tacit-block twice a", at);
    let twice_b = c.spend(&k, &[&fresh[0]], &[(5, secret(61, 0, 1), 10)], "tacit-block twice b", at);
    expect_refused(&mut c, &elf, &k, &[twice_a.clone(), twice_b], "a note spent twice in one block");

    // Refused: the note spent in block 2 spent again in a later block.
    let again = c.spend(&k, &[&received], &[(6, secret(62, 0, 0), 900)], "tacit-block spent again", at1);
    expect_refused(&mut c, &elf, &k, &[again], "a note spent again in a later block");

    // Refused: a tampered proof.
    let mut bad = twice_a.clone();
    bad.proof[100] ^= 1;
    expect_refused(&mut c, &elf, &k, &[bad], "a tampered proof");

    // And one spend of that note, alone, still lands.
    c.land(&elf, &k, &[twice_a]).unwrap_or_else(|e| fail(&format!("one spend of the twice-spent note: {e}")));
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
        Some("dump") if args.len() == 3 => dump(args[1].parse().unwrap_or_else(|_| fail("N is a number")), &args[2]),
        _ => fail("usage: tacit-block measure N... | test | dump N FILE | pin [--check]"),
    }
}
