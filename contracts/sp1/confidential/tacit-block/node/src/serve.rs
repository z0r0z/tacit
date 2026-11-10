//! The leader's core, over HTTP: the chain a node replays, a mempool of spends and settles checked on the way in (the proof natively, the
//! body and the openings and the nullifiers by a trial block), and the next block built from them. Chain I/O (following Ethereum's
//! events, proving, sending `land`) is the caller's: it tells this process what landed (`POST /landed`) and asks for the next block
//! (`POST /build`).
//!
//!   GET  /state                  height, state digest, note root, counts, queue position, chain binding
//!   GET  /notes?from=N&limit=M   leaves and their memos from leaf N on (what a wallet scans)
//!   GET  /pending-notes          the new notes of the payments this leader holds, before their block lands: { leaves, memos }, sorted by leaf
//!                                (a wallet opens them with its key, as it does /notes, to show what is coming to it)
//!   GET  /path/N                 the note root and the path of leaf N
//!   GET  /spent/0x…              whether a nullifier has entered the tree
//!   GET  /leaf/0x…               where a leaf is in the note tree (a spend landed once its notes are there)
//!   GET  /receipt/ID             a submission: queued, landed in a block, or refused (with why)
//!   GET  /mempool                the ids of what is waiting
//!   GET  /fee                    the leader's terms, as its leader posted them: { address (its chain address), fee (units of 1e-8 TAC a
//!                                spend), sweepFee (TAC wei a permitted shield adds), shieldCap (units), at, window }, fee "0" when it asks none
//!   POST /address                { address, key?, sig? } → { hash }      GET /address/<hash> → { address }   (the chain lane's directory)
//!                                With `key` (a Tacit key's compressed secp256k1 public key, 33 bytes) and `sig` (its 64-byte signature over
//!                                SHA-256("tacit-chain-key-v1" ‖ key ‖ address)), the address is also kept under the key, checked here:
//!   GET  /address/key/<key>      → { address, sig }: the chain address a Tacit address from before the chain (which carries the key, not the
//!                                chain lane) is paid at. A payer checks the signature again.
//!   POST /spend                  { publics, proof, data, memos[], opMemos[], back?, permit? } → { id }   (back: a shield paid to its inbox;
//!                                permit: { owner, fee, deadline, v, r, s, back } a holder's permit for it, TacitBlocks.sweepWithPermit)
//!   POST /settle                 { settle, memo } → { id }
//!   POST /forced                 a spend as /spend takes it → { payload }: the bytes TacitBlocks.force takes for it (its hints worked out
//!                                here), for a spend no leader takes. Any node serves it; it is checked as /spend checks a spend.
//!
//! The leader's own (`Authorization: Bearer $TACIT_NODE_ADMIN`, or, with none set, a loopback caller; `/landed` takes the caller's word
//! that a block landed, so the public must never reach these):
//!   POST /build                  { time, blobs?: bool, queue?: [payload…], max?: n, exclude?: [id…], only?: [id…] } → the block: guest
//!                                input, public values, lists. Only spends in `only` are taken when it is given.
//!   POST /landed                 { words[19], leaves[], memos[], nullifiers[] } → replays a landed block and clears what it took
//!   POST /pending                { memos?: [id…] } → each waiting spend's deposit, ways back, permit and output leaves, and the memos
//!                                of the spends named (what the leader opens to find its fee)
//!   POST /drop                   { ids, reason? } → spends given up on; with a reason they are refused for good, the receipt saying why
//!   POST /fee                    { address, fee, at, … } → what GET /fee serves
//!   POST /restore                → { restored, refused }: what waited when the node last stopped (TACIT_NODE_MEMPOOL, written after every
//!                                change), admitted again as if just submitted; the leader asks once its first sync has replayed the chain
//!
//! Every waiting spend and settle stays one a block could take on its own: each is checked alone against the chain at admission, when a
//! block is built and after each block lands, and one that no longer passes leaves the mempool with its reason on its receipt (a shield
//! whose margin the rate has passed, a claim past its deadline, a note spent another way). So no one entry can stop blocks being built.

use crate::{blobs, keys::Keys, stdin_file, Node, Published, SpendIn};
use ff::Field;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use tacit_block_common::{self as blk, lock::Settle, SpendData, FORCED_HINTS_LEN, FORCED_PROOF_LEN, FORCED_PUBLICS_LEN, FORCED_REST_AT, MEMO_LEN};

const MAX_BODY: usize = 4 << 20;
const MAX_PENDING: usize = 256;
/// Shields wait on a deposit only Ethereum shows: at most this many, so spends of notes always find room.
const MAX_SHIELDS: usize = 128;
/// How many request bodies are read at once (each on its own thread, so a slow sender holds up only itself).
const MAX_READERS: usize = 64;
/// Directory writes allowed per client address per hour.
const DIRECTORY_PER_HOUR: u32 = 30;
/// Spends refused for good (no valid proof, bad memos, another asset), remembered so a resend costs nothing: at most this many.
const MAX_REFUSED: usize = 4096;
/// How many ways back one inbox shield may carry (the first sent could be wrong; every one is tried).
const MAX_BACKS: usize = 4;
/// The sizes TacitBlocks.force takes a posted spend in (its FORCED_MIN and FORCED_MAX): no operation and no openings, up to both
/// openings, the longest operation and one receiver's memo.
const FORCED_MIN: usize = FORCED_REST_AT + 20 + 32 + 1 + 1;
const FORCED_MAX: usize = FORCED_MIN + 2 * (8 + 32 + 8) + 1 + 265 + MEMO_LEN;
/// What GET /fee holds at most (a chain address and a few numbers).
const MAX_FEE_QUOTE: usize = 8 << 10;

/// A holder's permit as a spend carries it, read and written out in one form: the leader hands each field to the chain's ABI as it is, so
/// one that does not read (a word that is not hex, a number that is not digits) is refused here, where it can do no more than refuse its own spend.
fn clean_permit(p: &Value) -> Result<Value, String> {
    let bad = || "the permit does not read".to_string();
    let o = p.as_object().ok_or_else(bad)?;
    let word = |k: &str, n: usize| -> Result<String, String> {
        let s = o.get(k).and_then(|v| v.as_str()).ok_or_else(bad)?;
        let b = hex::decode(s.trim_start_matches("0x")).map_err(|_| bad())?;
        if b.len() != n {
            return Err(bad());
        }
        Ok(hx(&b))
    };
    let digits = |k: &str, max: usize| -> Result<String, String> {
        let s = match o.get(k).ok_or_else(bad)? {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => return Err(bad()),
        };
        if s.is_empty() || s.len() > max || !s.bytes().all(|c| c.is_ascii_digit()) {
            return Err(bad());
        }
        let t = s.trim_start_matches('0');
        Ok(if t.is_empty() { "0".into() } else { t.into() })
    };
    let v: u64 = digits("v", 3)?.parse().map_err(|_| bad())?;
    if v > 255 {
        return Err(bad());
    }
    Ok(json!({ "owner": word("owner", 20)?, "fee": digits("fee", 30)?, "deadline": digits("deadline", 20)?, "v": v, "r": word("r", 32)?, "s": word("s", 32)?, "back": word("back", 32)? }))
}

fn hexv(v: &Value) -> Result<Vec<u8>, String> {
    let s = v.as_str().ok_or("a hex string")?;
    hex::decode(s.trim_start_matches("0x")).map_err(|_| "bad hex".to_string())
}

fn hx(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

fn word32(v: &Value) -> Result<[u8; 32], String> {
    hexv(v)?.try_into().map_err(|_| "a 32-byte word".to_string())
}

fn ids_of(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// A spend's three output leaves from its publics (words 5 to 7), zero for an empty slot.
fn out_leaves(publics: &[u8]) -> [[u8; 32]; 3] {
    std::array::from_fn(|i| publics[32 * (5 + i)..32 * (6 + i)].try_into().unwrap())
}

#[derive(Clone)]
struct Entry {
    id: String,
    spend: SpendIn,
    /// The memo of each new note, in slot order (empty slots have none), and of each note its operation makes.
    memos: Vec<Vec<u8>>,
    op_memos: Vec<Vec<u8>>,
    /// What taking it enters the nullifier tree: its notes' nullifiers and its deposit's.
    keys: Vec<[u8; 32]>,
    /// For a shield paid to its inbox (TacitBlocks.inbox) rather than deposited: the confidential pool commitment the inbox's
    /// address fixes, which the leader needs to sweep it in.
    back: Vec<String>,
    /// A holder's permit for the shield's inbox (`TacitBlocks.sweepWithPermit`): { owner, fee, deadline, v, r, s, back }.
    permit: Option<Value>,
    /// What was submitted (POST /spend's body), kept so a restart can admit it again.
    raw: Value,
}

impl Entry {
    fn shield(&self) -> bool {
        self.spend.data.dep.is_some() && self.keys.len() == 1
    }
}

#[derive(Clone)]
struct SettleEntry {
    id: String,
    settle: Settle,
    memo: Vec<u8>,
    key: [u8; 32],
    raw: Value,
}

/// A block built and waiting for its proof and its landing.
struct Built {
    ids: Vec<String>,
    out: Value,
}

pub struct Leader {
    node: Node,
    keys: Keys,
    /// The asset field of TAC: a spend of any other could never be landed (the contract takes only TAC in, out and on), so none is admitted.
    asset: Option<[u8; 32]>,
    pending: Vec<Entry>,
    settles: Vec<SettleEntry>,
    receipts: BTreeMap<String, Value>,
    built: Option<Built>,
    /// How many spends and settles the landed blocks held (GET /state `spends`): counted from the block this node built, or from what the leader says of a
    /// block it replays (its own record of the block), so a restart that replays them counts the same.
    spends: u64,
    /// The note tree of the leaves so far, with how many that was (GET /path/N reads paths from it).
    tree: Option<(usize, btc_pool_halo2::model::Tree)>,
    /// The ids of what was last written to the mempool file (a write is made only when they change).
    written: Vec<String>,
    /// Full chain addresses by the hash a Tacit address's chain lane carries (content-addressed: a payer checks what it gets).
    directory: Directory,
    refused: BTreeMap<String, String>,
    writes: BTreeMap<std::net::IpAddr, (u64, u32)>,
    /// What GET /fee serves: the leader's chain address and its fee, set by the leader (POST /fee).
    fee: Value,
    /// Where what waits is written after every change (TACIT_NODE_MEMPOOL), and what was there at start, admitted again on POST /restore.
    mempool_file: Option<String>,
    saved: Vec<Value>,
}

/// Chain addresses by SHA-256("tacit-chain-address-v1" ‖ address), kept in memory and appended to TACIT_NODE_DIRECTORY (one hex
/// address a line) when set, at most DIRECTORY_MAX.
pub struct Directory {
    map: BTreeMap<[u8; 32], Vec<u8>>,
    file: Option<String>,
    /// Chain addresses by the Tacit key that signed for them (key → (signature, the address's hash)): how a Tacit address from before the
    /// chain is paid on it. Only a signature by the key itself puts an entry here, so no one else can name another address for a key.
    keys: BTreeMap<[u8; 33], ([u8; 64], [u8; 32])>,
}
const ADDRESS_LEN: usize = 128 + 33 + 1184;
const DIRECTORY_MAX: usize = 50_000;

impl Directory {
    pub fn open(file: Option<String>) -> Directory {
        let mut d = Directory { map: BTreeMap::new(), file: None, keys: BTreeMap::new() };
        if let Some(f) = &file {
            if let Ok(text) = std::fs::read_to_string(f) {
                for line in text.lines() {
                    if let Ok(b) = hex::decode(line.trim()) {
                        let _ = d.add(b);
                    }
                }
            }
            // the keyed entries, each checked again as it is read
            if let Ok(text) = std::fs::read_to_string(format!("{f}.keys")) {
                for line in text.lines() {
                    let p: Vec<&str> = line.split_whitespace().collect();
                    if p.len() != 3 {
                        continue;
                    }
                    let (Ok(k), Ok(s), Ok(h)) = (hex::decode(p[0]), hex::decode(p[1]), hex::decode(p[2])) else { continue };
                    let Ok(h) = <[u8; 32]>::try_from(h.as_slice()) else { continue };
                    if let Some(addr) = d.map.get(&h).cloned() {
                        let _ = d.add_key(&k, &s, &addr);
                    }
                }
            }
        }
        d.file = file;
        d
    }
    /// What a key signs to name its chain address: SHA-256("tacit-chain-key-v1" ‖ key ‖ address).
    pub fn key_message(key: &[u8], address: &[u8]) -> [u8; 32] {
        use sha2::{Digest, Sha256};
        Sha256::new().chain_update(b"tacit-chain-key-v1").chain_update(key).chain_update(address).finalize().into()
    }
    /// Keeps `address` (already in the directory) under `key`, if `sig` is the key's signature for it; the entry a key signed last stands.
    pub fn add_key(&mut self, key: &[u8], sig: &[u8], address: &[u8]) -> Result<(), String> {
        use k256::ecdsa::{signature::hazmat::PrehashVerifier, Signature, VerifyingKey};
        let k: [u8; 33] = key.try_into().map_err(|_| "a key is a 33-byte compressed public key".to_string())?;
        let s: [u8; 64] = sig.try_into().map_err(|_| "a signature is 64 bytes".to_string())?;
        let vk = VerifyingKey::from_sec1_bytes(&k).map_err(|_| "not a secp256k1 public key".to_string())?;
        let sg = Signature::from_slice(&s).map_err(|_| "not a signature".to_string())?;
        vk.verify_prehash(&Self::key_message(&k, address), &sg).map_err(|_| "the signature is not the key's for this address".to_string())?;
        let h = Self::hash(address);
        if !self.map.contains_key(&h) {
            return Err("that address is not in the directory".into());
        }
        if self.keys.get(&k) == Some(&(s, h)) {
            return Ok(());
        }
        if !self.keys.contains_key(&k) && self.keys.len() >= DIRECTORY_MAX {
            return Err("the directory is full".into());
        }
        if let Some(f) = &self.file {
            use std::io::Write;
            let mut out = std::fs::OpenOptions::new().create(true).append(true).open(format!("{f}.keys")).map_err(|e| e.to_string())?;
            writeln!(out, "{} {} {}", hex::encode(k), hex::encode(s), hex::encode(h)).map_err(|e| e.to_string())?;
        }
        self.keys.insert(k, (s, h));
        Ok(())
    }
    /// The chain address a key signed for, with its signature.
    pub fn by_key(&self, key: &[u8; 33]) -> Option<(Vec<u8>, [u8; 64])> {
        let (s, h) = self.keys.get(key)?;
        Some((self.map.get(h)?.clone(), *s))
    }
    pub fn hash(address: &[u8]) -> [u8; 32] {
        use sha2::{Digest, Sha256};
        Sha256::new().chain_update(b"tacit-chain-address-v1").chain_update(address).finalize().into()
    }
    pub fn add(&mut self, address: Vec<u8>) -> Result<[u8; 32], String> {
        if address.len() != ADDRESS_LEN {
            return Err(format!("a chain address is {ADDRESS_LEN} bytes"));
        }
        let h = Self::hash(&address);
        if self.map.contains_key(&h) {
            return Ok(h);
        }
        if self.map.len() >= DIRECTORY_MAX {
            return Err("the directory is full".into());
        }
        if let Some(f) = &self.file {
            use std::io::Write;
            let mut out = std::fs::OpenOptions::new().create(true).append(true).open(f).map_err(|e| e.to_string())?;
            writeln!(out, "{}", hex::encode(&address)).map_err(|e| e.to_string())?;
        }
        self.map.insert(h, address);
        Ok(h)
    }
}

/// The bytes TacitBlocks.force takes for a spend (tacit-block-common `forced_parts`): publics ‖ proof ‖ hints ‖ a memo per output slot
/// (zeros for an empty one) ‖ the rest of its body and openings ‖ the memos of the notes its operation makes. Checked to parse back to
/// this very spend and to be a size the contract takes.
pub fn forced_payload(publics: &[u8], proof: &[u8], hints: &[u8], data: &SpendData, memos: &[Vec<u8>], op_memos: &[Vec<u8>]) -> Result<Vec<u8>, String> {
    if publics.len() != FORCED_PUBLICS_LEN || proof.len() != FORCED_PROOF_LEN || hints.len() != FORCED_HINTS_LEN {
        return Err("a spend whose publics, proof or hints are not the sizes a posted spend has".into());
    }
    let mut p = Vec::with_capacity(FORCED_MAX);
    p.extend_from_slice(publics);
    p.extend_from_slice(proof);
    p.extend_from_slice(hints);
    let mut slot_memos = memos.iter();
    for leaf in out_leaves(publics) {
        if leaf == [0u8; 32] {
            p.extend_from_slice(&[0u8; MEMO_LEN]);
        } else {
            p.extend_from_slice(slot_memos.next().ok_or("a memo for each new note")?);
        }
    }
    p.extend_from_slice(&data.to_bytes()[96..]);
    for m in op_memos {
        p.extend_from_slice(m);
    }
    let fields = tacit_block_agg_publics(publics)?;
    let (pp, pr, ph, pd) = blk::forced_parts(&p).ok_or("the posting does not parse as a spend")?;
    if pp != fields || pr != proof || ph != hints || pd != *data {
        return Err("the posting parses as another spend (a memo hash named for an empty output?)".into());
    }
    if p.len() < FORCED_MIN || p.len() > FORCED_MAX {
        return Err(format!("a posting of {} bytes, which the landing contract does not take", p.len()));
    }
    Ok(p)
}

impl Leader {
    pub fn new(chain: [u8; 32], keys: Keys, asset: Option<[u8; 32]>) -> Leader {
        Leader {
            node: Node::genesis(chain),
            keys,
            asset,
            pending: vec![],
            settles: vec![],
            receipts: BTreeMap::new(),
            built: None,
            spends: 0,
            tree: None,
            directory: Directory::open(std::env::var("TACIT_NODE_DIRECTORY").ok().filter(|f| !f.is_empty())),
            refused: BTreeMap::new(),
            writes: BTreeMap::new(),
            fee: json!({ "fee": "0" }),
            mempool_file: std::env::var("TACIT_NODE_MEMPOOL").ok().filter(|f| !f.is_empty()),
            written: vec![],
            saved: std::env::var("TACIT_NODE_MEMPOOL")
                .ok()
                .filter(|f| !f.is_empty())
                .and_then(|f| std::fs::read(f).ok())
                .and_then(|b| serde_json::from_slice::<Vec<Value>>(&b).ok())
                .unwrap_or_default(),
        }
    }

    /// Writes what waits (each spend's and settle's submission) to TACIT_NODE_MEMPOOL, whole and atomically; a write that fails is said and
    /// the node goes on (what waits is then only as safe as the wallets' own copies).
    fn persist(&mut self) {
        let Some(f) = self.mempool_file.clone() else { return };
        // what was read at start is not yet admitted again (POST /restore does that once the chain is replayed): writing now would erase it
        if !self.saved.is_empty() {
            return;
        }
        let ids: Vec<String> = self.pending.iter().map(|e| e.id.clone()).chain(self.settles.iter().map(|s| s.id.clone())).collect();
        if ids == self.written {
            return;
        }
        let all: Vec<Value> = self
            .pending
            .iter()
            .map(|e| json!({ "kind": "spend", "body": e.raw }))
            .chain(self.settles.iter().map(|s| json!({ "kind": "settle", "body": s.raw })))
            .collect();
        let tmp = format!("{f}.tmp");
        match std::fs::write(&tmp, serde_json::to_vec(&all).unwrap_or_default()).and_then(|_| std::fs::rename(&tmp, &f)) {
            Ok(()) => self.written = ids,
            Err(e) => eprintln!("tacit-block-node: could not write {f}: {e}"),
        }
    }

    /// What waited when the node last stopped, admitted again now that the chain is replayed: each checked as a new submission is.
    fn restore(&mut self, now: u64) -> Value {
        let (mut restored, mut refused) = (0u32, vec![]);
        for e in std::mem::take(&mut self.saved) {
            let r = if e["kind"] == "settle" { self.settle(&e["body"], now) } else { self.spend(&e["body"], now) };
            match r {
                Ok(_) => restored += 1,
                Err(why) => refused.push(why),
            }
        }
        json!({ "restored": restored, "refused": refused })
    }

    fn state(&self) -> Value {
        let s = &self.node.state;
        json!({
            "height": self.node.height, "state": hx(&s.digest()), "noteRoot": hx(&blk::fr_be(&s.notes.root)), "leaves": self.node.leaves.len(),
            "nullifiers": self.node.nf.records.len() - 1, "queue": { "len": s.queue_len, "hash": hx(&s.queue_hash) }, "chain": hx(&s.chain),
            "pending": self.pending.len(), "settles": self.settles.len(), "spends": self.spends,
            // a share is worth pool / shares units of 1e-8 TAC (each counted with the program's virtual units)
            "pool": s.pool.to_string(), "shares": s.shares.to_string(),
        })
    }

    /// Whether a block of this spend alone could be built at `time`: its body, openings and the rate, its notes and deposit unspent.
    fn takeable(&self, e: &Entry, time: u64) -> Result<(), String> {
        self.node.build(std::slice::from_ref(&e.spend), &[], &[], time, &[]).map(|_| ())
    }

    fn settle_takeable(&self, s: &SettleEntry, time: u64) -> Result<(), String> {
        self.node.build(&[], std::slice::from_ref(&s.settle), &[], time, &[]).map(|_| ())
    }

    fn refuse(&mut self, id: &str, why: String) {
        if self.refused.len() >= MAX_REFUSED {
            self.refused.clear();
        }
        self.refused.insert(id.to_string(), why.clone());
        self.receipts.insert(id.to_string(), json!({ "id": id, "status": "refused", "error": why }));
    }

    /// Takes out of the mempool every spend (and with `settles`, every settle) that no block could take at `time` on its own, each refused
    /// with its reason; one whose notes are among `landed` (a block's new leaves: it went in another way, posted to the queue) reads as
    /// landed at `height`. Settles are judged by the clock of a block that landed, never a block's proposed time, which may run behind.
    fn prune(&mut self, time: u64, landed: &BTreeSet<[u8; 32]>, height: u64, settles: bool) -> usize {
        let mut gone = 0;
        for e in std::mem::take(&mut self.pending) {
            match self.takeable(&e, time) {
                Ok(()) => self.pending.push(e),
                Err(why) => {
                    gone += 1;
                    if out_leaves(&e.spend.publics).iter().any(|l| *l != [0u8; 32] && landed.contains(l)) {
                        self.receipts.insert(e.id.clone(), json!({ "id": e.id, "status": "landed", "height": height }));
                    } else {
                        self.refuse(&e.id, format!("no longer takeable: {why}"));
                    }
                }
            }
        }
        if !settles {
            return gone;
        }
        for s in std::mem::take(&mut self.settles) {
            match self.settle_takeable(&s, time) {
                Ok(()) => self.settles.push(s),
                Err(why) => {
                    gone += 1;
                    self.refuse(&s.id, format!("no longer takeable: {why}"));
                }
            }
        }
        gone
    }

    /// A spend handed in: its proof checked natively, its memos matched to its body, and it checked alone against the chain and against
    /// the notes the waiting spends spend.
    fn spend(&mut self, b: &Value, now: u64) -> Result<Value, String> {
        if self.pending.len() + self.settles.len() >= MAX_PENDING {
            return Err("the mempool is full".into());
        }
        let publics = hexv(&b["publics"])?;
        let proof = hexv(&b["proof"])?;
        let data = SpendData::from_bytes(&hexv(&b["data"])?).ok_or("spend data does not parse")?;
        let mut id_in = publics.clone();
        id_in.extend(data.to_bytes());
        let id = hex::encode(blk::payload_hash(&id_in));
        let mut backs = vec![];
        if let Some(h) = b["back"].as_str() {
            let v = hexv(&serde_json::Value::String(h.into()))?;
            if v.len() != 32 {
                return Err("back is a 32-byte commitment".into());
            }
            backs.push(hx(&v));
        }
        if let Some(e) = self.pending.iter_mut().find(|e| e.id == id) {
            for x in backs {
                if !e.back.contains(&x) && e.back.len() < MAX_BACKS {
                    e.back.push(x);
                }
            }
            return Ok(self.receipts[&id].clone());
        }
        if let Some(e) = self.refused.get(&id) {
            return Err(e.clone());
        }
        if self.receipts.contains_key(&id) {
            return Ok(self.receipts[&id].clone());
        }
        // (before the proof is checked: a permit that does not read costs nothing to refuse)
        let permit = match b.get("permit") {
            Some(p) if !p.is_null() => Some(clean_permit(p)?),
            _ => None,
        };
        let (hints, memos, op_memos) = match self.check_spend(&publics, &proof, &data, b) {
            Ok(x) => x,
            Err(e) => {
                if self.refused.len() >= MAX_REFUSED {
                    self.refused.clear();
                }
                self.refused.insert(id.clone(), e.clone());
                return Err(e);
            }
        };
        let keys: Vec<[u8; 32]> = blk::Spend::from_publics(&tacit_block_agg_publics(&publics)?).spent_keys().iter().map(blk::fr_be).collect();
        // what is kept to admit it again is the submission's own fields and no more (a body can carry up to MAX_BODY of anything else)
        let raw = json!({ "publics": b["publics"], "proof": b["proof"], "data": b["data"], "memos": b["memos"], "opMemos": b["opMemos"], "back": b["back"], "permit": permit });
        let entry = Entry { id: id.clone(), spend: SpendIn { publics, proof, hints, data }, memos, op_memos, keys, back: backs, permit, raw };
        if entry.shield() && self.pending.iter().filter(|e| e.shield()).count() >= MAX_SHIELDS {
            return Err("too many shields wait on their deposits".into());
        }
        if self.pending.iter().any(|e| e.keys.iter().any(|k| entry.keys.contains(k))) {
            return Err("a note it spends is being spent by a spend already waiting".into());
        }
        self.takeable(&entry, now).map_err(|e| format!("not takeable now: {e}"))?;
        self.pending.push(entry);
        let r = json!({ "id": id, "status": "queued" });
        self.receipts.insert(id, r.clone());
        Ok(r)
    }

    /// What can be checked of a spend on its own, whose failure is for good: its proof, asset, root, and memos. → its hints, the memo of
    /// each new note in slot order, and the memos of the notes its operation makes.
    #[allow(clippy::type_complexity)]
    fn check_spend(&self, publics: &[u8], proof: &[u8], data: &SpendData, b: &Value) -> Result<(Vec<u8>, Vec<Vec<u8>>, Vec<Vec<u8>>), String> {
        let p = tacit_block_agg_publics(publics)?;
        let hints = self.keys.check(&p, proof).ok_or("the spend's proof does not verify")?;
        let memos: Vec<Vec<u8>> = b["memos"].as_array().ok_or("memos")?.iter().map(hexv).collect::<Result<_, _>>()?;
        let op_memos: Vec<Vec<u8>> = b["opMemos"].as_array().map(|a| a.iter().map(hexv).collect::<Result<_, _>>()).transpose()?.unwrap_or_default();
        let spend = blk::Spend::from_publics(&p);
        if self.asset.is_some_and(|a| blk::fr_be(&spend.asset) != a) {
            return Err("only TAC moves on this chain".into());
        }
        // a spend of notes names a root a block ended at: the landing contract refuses any other, and a block holding one could not land
        if !spend.live_nullifiers().is_empty() && !self.node.roots.contains(&blk::fr_be(&spend.root)) {
            return Err("the spend names a note root no block ended at".into());
        }
        let slots: Vec<usize> = (0..3).filter(|i| !bool::from(spend.out[*i].is_zero())).collect();
        if memos.len() != slots.len() || memos.iter().zip(&slots).any(|(m, i)| m.len() != MEMO_LEN || blk::memo_hash(m) != data.memo_hashes[*i]) {
            return Err("a memo for each new note, each the one its body names".into());
        }
        let receivers = data.op.as_ref().map(|o| o.receivers()).unwrap_or_default();
        if op_memos.len() != receivers.len() || op_memos.iter().zip(&receivers).any(|(m, r)| m.len() != MEMO_LEN || blk::memo_hash(m) != r.memo) {
            return Err("a memo for each note the operation makes".into());
        }
        Ok((hints, memos, op_memos))
    }

    /// The bytes TacitBlocks.force takes for a spend as POST /spend takes it, checked as a submitted spend is.
    fn forced(&self, b: &Value) -> Result<Value, String> {
        let publics = hexv(&b["publics"])?;
        let proof = hexv(&b["proof"])?;
        let data = SpendData::from_bytes(&hexv(&b["data"])?).ok_or("spend data does not parse")?;
        let (hints, memos, op_memos) = self.check_spend(&publics, &proof, &data, b)?;
        let p = forced_payload(&publics, &proof, &hints, &data, &memos, &op_memos)?;
        Ok(json!({ "payload": hx(&p), "hash": hx(&blk::payload_hash(&p)) }))
    }

    fn settle(&mut self, b: &Value, now: u64) -> Result<Value, String> {
        if self.pending.len() + self.settles.len() >= MAX_PENDING {
            return Err("the mempool is full".into());
        }
        let raw = hexv(&b["settle"])?;
        let settle = Settle::from_bytes(&raw).ok_or("settle does not parse")?;
        let memo = hexv(&b["memo"])?;
        if memo.len() != MEMO_LEN || blk::memo_hash(&memo) != settle.to().memo {
            return Err("the memo of the note a settle makes".into());
        }
        let id = hex::encode(blk::payload_hash(&raw));
        if let Some(e) = self.refused.get(&id) {
            return Err(e.clone());
        }
        if self.receipts.contains_key(&id) {
            return Ok(self.receipts[&id].clone());
        }
        if !self.node.roots.contains(&blk::fr_be(&settle.root)) {
            return Err("the settle names a note root no block ended at".into());
        }
        if self.asset.is_some_and(|a| blk::fr_be(&settle.asset) != a) {
            return Err("only TAC moves on this chain".into());
        }
        let key = blk::fr_be(&blk::lock::lock_nullifier(&settle.leaf(), settle.index));
        let entry = SettleEntry { id: id.clone(), settle, memo, key, raw: json!({ "settle": b["settle"], "memo": b["memo"] }) };
        if self.settles.iter().any(|s| s.key == key) {
            return Err("that lock is being settled by a settle already waiting".into());
        }
        self.settle_takeable(&entry, now).map_err(|e| format!("not takeable now: {e}"))?;
        self.settles.push(entry);
        let r = json!({ "id": id, "status": "queued" });
        self.receipts.insert(id, r.clone());
        Ok(r)
    }

    /// Of these spends and settles (oldest first, none spending what an earlier one spends), the ones a block with the queue's entries
    /// takes: all of them when they build together, else each in turn that still lets the block build.
    fn select(&self, spends: Vec<Entry>, settles: Vec<SettleEntry>, posts: &[(Vec<u8>, bool)], time: u64) -> (Vec<Entry>, Vec<SettleEntry>) {
        let try_build = |sp: &[Entry], st: &[SettleEntry]| {
            let sp: Vec<SpendIn> = sp.iter().map(|e| e.spend.clone()).collect();
            let st: Vec<Settle> = st.iter().map(|e| e.settle.clone()).collect();
            self.node.build(&sp, &st, posts, time, &[]).is_ok()
        };
        if try_build(&spends, &settles) {
            return (spends, settles);
        }
        let (mut sp, mut st) = (vec![], vec![]);
        for e in spends {
            sp.push(e);
            if !try_build(&sp, &st) {
                sp.pop();
            }
        }
        for s in settles {
            st.push(s);
            if !try_build(&sp, &st) {
                st.pop();
            }
        }
        (sp, st)
    }

    /// The next block: the mempool's spends and settles and the queue's next entries, in calldata or blobs.
    fn build(&mut self, b: &Value) -> Result<Value, String> {
        let time = b["time"].as_u64().ok_or("time")?;
        let max = b["max"].as_u64().unwrap_or(64) as usize;
        let want_blobs = b["blobs"].as_bool().unwrap_or(false);
        let exclude = ids_of(&b["exclude"]);
        let only = b.get("only").filter(|v| v.is_array()).map(ids_of);
        let queue: Vec<Vec<u8>> = b["queue"].as_array().map(|a| a.iter().map(hexv).collect::<Result<_, _>>()).transpose()?.unwrap_or_default();
        // what no block could take at this time leaves the mempool first, so no one entry holds the rest back
        self.prune(time, &BTreeSet::new(), self.node.height, false);
        // oldest first, none spending what an earlier one spends
        let mut used = BTreeSet::new();
        let mut spends = vec![];
        for e in &self.pending {
            if spends.len() >= max || exclude.contains(&e.id) || only.as_ref().is_some_and(|o| !o.contains(&e.id)) || e.keys.iter().any(|k| used.contains(k)) {
                continue;
            }
            used.extend(e.keys.iter().copied());
            spends.push(e.clone());
        }
        let mut settles = vec![];
        for s in &self.settles {
            if spends.len() + settles.len() >= max || exclude.contains(&s.id) || used.contains(&s.key) {
                continue;
            }
            used.insert(s.key);
            settles.push(s.clone());
        }
        // a posted spend is taken if its proof verifies; a posted settle's check is the program's own
        let posts: Vec<(Vec<u8>, bool)> = queue
            .iter()
            .map(|p| {
                let ok = blk::forced_parts(p).map(|(pub_, proof, hints, _)| self.keys.check_hinted(&pub_, proof, hints)).unwrap_or(false);
                (p.clone(), ok)
            })
            .collect();
        let (spends, settles) = self.select(spends, settles, &posts, time);
        let sp: Vec<SpendIn> = spends.iter().map(|e| e.spend.clone()).collect();
        let st: Vec<Settle> = settles.iter().map(|e| e.settle.clone()).collect();
        let (mut bufs, mut out, mut data) = self.node.build(&sp, &st, &posts, time, &[])?;
        // the memos published beside the new notes, found by their hashes
        let mut pool: Vec<Vec<u8>> = spends.iter().flat_map(|e| e.memos.iter().chain(&e.op_memos).cloned()).chain(settles.iter().map(|e| e.memo.clone())).collect();
        for (p, _) in &posts {
            if let Some((_, memo)) = blk::lock::forced_settle(p, MEMO_LEN) {
                pool.push(memo.to_vec());
            } else if blk::forced_parts(p).is_some() {
                for i in 0..3 {
                    pool.push(blk::forced_memo(p, i).to_vec());
                }
                pool.extend(blk::forced_op_memos(p).into_iter().map(<[u8]>::to_vec));
            }
        }
        let mut openings = vec![];
        let mut raw_blobs = vec![];
        if want_blobs {
            let (buf, raw, op) = blobs::blob_input(&data, &pool)?;
            let rebuilt = self.node.build(&sp, &st, &posts, time, &buf)?;
            bufs = rebuilt.0;
            out = rebuilt.1;
            data = rebuilt.2;
            openings = op;
            raw_blobs = raw;
        }
        let mut memos = vec![];
        for o in &data.outputs {
            memos.push(pool.iter().find(|m| blk::memo_hash(m)[..] == o[32..]).cloned().ok_or("a new note without its memo")?);
        }
        let ids: Vec<String> = spends.iter().map(|e| e.id.clone()).chain(settles.iter().map(|e| e.id.clone())).collect();
        let hexes = |v: &[Vec<u8>]| v.iter().map(|x| hx(x)).collect::<Vec<_>>();
        let result = json!({
            "stdin": hx(&stdin_file(&bufs)),
            "publicValues": hx(&out.encode()),
            "time": time,
            "includes": ids,
            "queueTaken": out.queue_len - self.node.state.queue_len,
            "lists": {
                "leaves": hx(&data.outputs.iter().flat_map(|o| o[..32].to_vec()).collect::<Vec<u8>>()),
                "memos": hx(&memos.concat()),
                "nullifiers": data.nullifiers.iter().map(|n| hx(n)).collect::<Vec<_>>(),
                "anchors": data.anchors.iter().map(|n| hx(n)).collect::<Vec<_>>(),
                "deposits": hx(&data.deposits.concat()),
                "exits": hx(&data.exits.concat()),
                "hops": hx(&data.hops.concat()),
                "claims": hx(&data.claims.concat()),
                "migrations": hx(&data.migrations.concat()),
                "migrationTotals": hx(&data.migration_totals.concat()),
                "blobs": hx(&openings.iter().flat_map(blobs::BlobOpening::to_bytes).collect::<Vec<u8>>()),
            },
            "blobData": hexes(&raw_blobs),
        });
        self.built = Some(Built { ids, out: result.clone() });
        Ok(result)
    }

    /// A block that landed on Ethereum: replayed from what it published, which must reach the state its proof committed. What it took
    /// leaves the mempool, and every spend and settle left is checked again against the new state.
    fn landed(&mut self, b: &Value, now: u64) -> Result<Value, String> {
        let words: Vec<[u8; 32]> = b["words"].as_array().ok_or("words")?.iter().map(word32).collect::<Result<_, _>>()?;
        let leaves: Vec<[u8; 32]> = b["leaves"].as_array().ok_or("leaves")?.iter().map(word32).collect::<Result<_, _>>()?;
        let memos: Vec<Vec<u8>> = b["memos"].as_array().ok_or("memos")?.iter().map(hexv).collect::<Result<_, _>>()?;
        let nullifiers: Vec<[u8; 32]> = b["nullifiers"].as_array().ok_or("nullifiers")?.iter().map(word32).collect::<Result<_, _>>()?;
        let published: BTreeSet<[u8; 32]> = leaves.iter().copied().collect();
        let (leaves_cat, nullifiers_land) = (leaves.concat(), nullifiers.clone());
        self.node.land(&Published { words, leaves, memos, nullifiers })?;
        let height = self.node.height;
        // (the block built here, if that is the one that landed: another's landing must not mark this one's spends landed)
        let ours = self.built.as_ref().is_some_and(|bt| {
            let bl = bt.out["lists"]["leaves"].as_str().and_then(|s| hex::decode(s.trim_start_matches("0x")).ok());
            let bn: Option<Vec<[u8; 32]>> = bt.out["lists"]["nullifiers"].as_array().map(|a| a.iter().filter_map(|x| word32(x).ok()).collect());
            bl.as_deref() == Some(leaves_cat.as_slice()) && bn.as_deref() == Some(nullifiers_land.as_slice())
        });
        let included = if ours { self.built.take().map(|b| ids_of(&b.out["includes"])).unwrap_or_default() } else { self.built = None; vec![] };
        self.spends += if ours { included.len() as u64 } else { b["spends"].as_u64().unwrap_or(0) };
        for id in &included {
            self.receipts.insert(id.clone(), json!({ "id": id, "status": "landed", "height": height }));
        }
        self.pending.retain(|e| !included.contains(&e.id));
        self.settles.retain(|e| !included.contains(&e.id));
        self.prune(now, &published, height, true);
        Ok(self.state())
    }

    /// The waiting spends as the leader needs them: each one's deposit, ways back and permit (what sweeping it in takes) and output leaves,
    /// and for those `memos_for` names, the memo of each output slot (null for an empty one).
    fn pending_detail(&self, memos_for: &[String]) -> Value {
        let spends: Vec<Value> = self
            .pending
            .iter()
            .map(|e| {
                let p = tacit_block_agg_publics(&e.spend.publics).ok();
                let deposit = p.and_then(|p| blk::deposit_record(&blk::Spend::from_publics(&p), &e.spend.data)).map(|d| hx(&d));
                let leaves = out_leaves(&e.spend.publics);
                let mut v = json!({ "id": e.id, "deposit": deposit, "backs": e.back, "permit": e.permit, "leaves": leaves.iter().map(|l| hx(l)).collect::<Vec<_>>() });
                if memos_for.contains(&e.id) {
                    let mut slot = e.memos.iter();
                    v["memos"] = json!(leaves.iter().map(|l| if *l == [0u8; 32] { Value::Null } else { slot.next().map(|m| Value::String(hx(m))).unwrap_or(Value::Null) }).collect::<Vec<_>>());
                }
                v
            })
            .collect();
        json!({ "spends": spends, "settles": self.settles.iter().map(|e| e.id.clone()).collect::<Vec<_>>() })
    }

    fn route(&mut self, method: &str, url: &str, body: &Value, now: u64, admin: bool, ip: Option<std::net::IpAddr>) -> Result<Value, (u16, String)> {
        let (path, query) = url.split_once('?').unwrap_or((url, ""));
        if method == "POST" && matches!(path, "/build" | "/landed" | "/drop" | "/pending" | "/fee" | "/restore") && !admin {
            return Err((403, "the leader's own".into()));
        }
        let q = |k: &str| query.split('&').find_map(|kv| kv.split_once('=').filter(|(a, _)| *a == k).map(|(_, v)| v.to_string()));
        let bad = |e: String| (400u16, e);
        match (method, path) {
            ("GET", "/state") => Ok(self.state()),
            ("GET", "/notes") => {
                let from = q("from").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0).min(self.node.leaves.len());
                let limit = q("limit").and_then(|v| v.parse::<usize>().ok()).unwrap_or(200).min(500);
                let to = (from + limit).min(self.node.leaves.len());
                Ok(json!({
                    "from": from, "next": to, "total": self.node.leaves.len(),
                    "leaves": self.node.leaves[from..to].iter().map(|l| hx(&blk::fr_be(l))).collect::<Vec<_>>(),
                    "memos": self.node.memos[from..to].iter().map(|m| hx(m)).collect::<Vec<_>>(),
                }))
            }
            ("GET", "/pending-notes") => {
                // the new notes of the payments held (shields, which wait on their deposits, are their shielder's own): one list sorted by
                // leaf, as a block lists them, so it says no more of which spend made which than the block will
                let mut out: Vec<([u8; 32], Vec<u8>)> = vec![];
                for e in self.pending.iter().filter(|e| e.spend.data.dep.is_none()) {
                    let Ok(p) = tacit_block_agg_publics(&e.spend.publics) else { continue };
                    let sp = blk::Spend::from_publics(&p);
                    let slots: Vec<usize> = (0..3).filter(|i| !bool::from(sp.out[*i].is_zero())).collect();
                    for (i, m) in slots.iter().zip(&e.memos) {
                        out.push((blk::fr_be(&sp.out[*i]), m.clone()));
                    }
                }
                out.sort_by(|a, b| a.0.cmp(&b.0));
                Ok(json!({ "leaves": out.iter().map(|(l, _)| hx(l)).collect::<Vec<_>>(), "memos": out.iter().map(|(_, m)| hx(m)).collect::<Vec<_>>() }))
            }
            ("GET", p) if p.starts_with("/path/") => {
                let i: u64 = p[6..].parse().map_err(|_| bad("an index".into()))?;
                let n = self.node.leaves.len();
                if (i as usize) >= n {
                    return Err((404, "no such leaf".to_string()));
                }
                // (built once for these leaves: it is a hash for every leaf, and a wallet asks twice for each spend)
                if self.tree.as_ref().map(|(k, _)| *k) != Some(n) {
                    self.tree = Some((n, self.node.tree()));
                }
                let (_, t) = self.tree.as_ref().unwrap();
                let (root, path) = (t.root, t.path(i as usize));
                Ok(json!({ "index": i, "root": hx(&blk::fr_be(&root)), "path": path.iter().map(|x| hx(&blk::fr_be(x))).collect::<Vec<_>>() }))
            }
            ("GET", p) if p.starts_with("/spent/") => {
                let nf: [u8; 32] = hex::decode(p[7..].trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok()).ok_or(bad("a 32-byte nullifier".into()))?;
                Ok(json!({ "spent": self.node.spent(&nf) }))
            }
            ("GET", p) if p.starts_with("/leaf/") => {
                let leaf: [u8; 32] = hex::decode(p[6..].trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok()).ok_or(bad("a 32-byte leaf".into()))?;
                let at = self.node.leaves.iter().rposition(|l| blk::fr_be(l) == leaf).ok_or((404, "no such leaf".to_string()))?;
                Ok(json!({ "index": at }))
            }
            ("POST", "/drop") => {
                // the leader's: spends it gave up on (a shield whose deposit never came), or refuses (one that pays it no fee)
                let ids = ids_of(&body["ids"]);
                let reason = body["reason"].as_str().filter(|r| !r.is_empty()).map(|r| r.chars().take(200).collect::<String>());
                let before = self.pending.len();
                self.pending.retain(|e| !ids.contains(&e.id));
                for id in &ids {
                    match &reason {
                        Some(r) => self.refuse(id, r.clone()),
                        None => {
                            self.receipts.remove(id);
                        }
                    }
                }
                Ok(json!({ "dropped": before - self.pending.len() }))
            }
            ("POST", "/pending") => Ok(self.pending_detail(&ids_of(&body["memos"]))),
            ("GET", "/fee") => Ok(self.fee.clone()),
            ("POST", "/fee") => {
                if !body.is_object() || body.to_string().len() > MAX_FEE_QUOTE {
                    return Err(bad("a fee quote".into()));
                }
                self.fee = body.clone();
                Ok(self.fee.clone())
            }
            ("POST", "/address") => {
                if let Some(ip) = ip.filter(|_| !admin) {
                    let w = self.writes.entry(ip).or_insert((now, 0));
                    if now >= w.0 + 3600 {
                        *w = (now, 0);
                    }
                    if w.1 >= DIRECTORY_PER_HOUR {
                        return Err((429, "too many addresses from here this hour".into()));
                    }
                    w.1 += 1;
                    if self.writes.len() > 100_000 {
                        self.writes.retain(|_, w| now < w.0 + 3600);
                    }
                }
                let a = hexv(&body["address"]).map_err(bad)?;
                let h = self.directory.add(a.clone()).map_err(bad)?;
                if body.get("key").is_some_and(|k| !k.is_null()) {
                    let (k, s) = (hexv(&body["key"]).map_err(bad)?, hexv(&body["sig"]).map_err(bad)?);
                    self.directory.add_key(&k, &s, &a).map_err(bad)?;
                }
                Ok(json!({ "hash": hx(&h) }))
            }
            ("GET", p) if p.starts_with("/address/key/") => {
                let k: [u8; 33] = hex::decode(p[13..].trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok()).ok_or(bad("a 33-byte key".into()))?;
                self.directory.by_key(&k).map(|(a, s)| json!({ "address": hx(&a), "sig": hx(&s) })).ok_or((404, "no chain address for that key".to_string()))
            }
            ("GET", p) if p.starts_with("/address/") => {
                let h: [u8; 32] = hex::decode(p[9..].trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok()).ok_or(bad("a 32-byte hash".into()))?;
                self.directory.map.get(&h).map(|a| json!({ "address": hx(a) })).ok_or((404, "no such address".to_string()))
            }
            ("GET", p) if p.starts_with("/receipt/") => self.receipts.get(&p[9..]).cloned().ok_or((404, "no such submission".to_string())),
            ("GET", "/mempool") => Ok(json!({
                "spends": self.pending.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
                "settles": self.settles.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
            })),
            ("POST", "/spend") => self.spend(body, now).map_err(bad),
            ("POST", "/settle") => self.settle(body, now).map_err(bad),
            ("POST", "/forced") => self.forced(body).map_err(bad),
            ("POST", "/build") => self.build(body).map_err(bad),
            ("POST", "/landed") => self.landed(body, now).map_err(bad),
            ("POST", "/restore") => Ok(self.restore(now)),
            _ => Err((404, "not found".into())),
        }
    }

    /// `route`, with what waits written down after anything that can change it.
    fn handle(&mut self, method: &str, url: &str, body: &Value, now: u64, admin: bool, ip: Option<std::net::IpAddr>) -> Result<Value, (u16, String)> {
        let r = self.route(method, url, body, now, admin, ip);
        let path = url.split_once('?').map_or(url, |(p, _)| p);
        if method == "POST" && matches!(path, "/spend" | "/settle" | "/landed" | "/drop" | "/build" | "/restore") {
            self.persist();
        }
        r
    }
}

/// A spend's twelve publics from their 384 bytes.
fn tacit_block_agg_publics(b: &[u8]) -> Result<Vec<halo2_proofs::halo2curves::bn256::Fr>, String> {
    btc_pool_agg_common::publics_from_be(b).ok_or_else(|| "a spend's publics are twelve canonical field elements".to_string())
}

/// Serves the leader on `addr` until the process ends.
pub fn serve(addr: &str, mut leader: Leader) -> Result<(), String> {
    let server = tiny_http::Server::http(addr).map_err(|e| format!("listen on {addr}: {e}"))?;
    eprintln!("tacit-block-node: serving on {addr}");
    let cors = |r: tiny_http::Response<std::io::Cursor<Vec<u8>>>| {
        r.with_header(tiny_http::Header::from_bytes(&b"Access-Control-Allow-Origin"[..], &b"*"[..]).unwrap())
            .with_header(tiny_http::Header::from_bytes(&b"Access-Control-Allow-Headers"[..], &b"content-type"[..]).unwrap())
            .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
    };
    // bodies are read on their own threads and handed here whole: a sender that never finishes its body holds up only its thread
    let (tx, rx) = std::sync::mpsc::channel::<(tiny_http::Request, Vec<u8>)>();
    let readers = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            if req.method().as_str() == "OPTIONS" {
                let _ = req.respond(cors(tiny_http::Response::from_data(vec![]).with_status_code(204)));
                continue;
            }
            if readers.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= MAX_READERS {
                readers.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                let _ = req.respond(cors(tiny_http::Response::from_data(b"{\"error\":\"busy\"}".to_vec()).with_status_code(503)));
                continue;
            }
            let (tx, readers) = (tx.clone(), readers.clone());
            std::thread::spawn(move || {
                let mut raw = vec![];
                let _ = req.as_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut raw);
                readers.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                let _ = tx.send((req, raw));
            });
        }
    });
    let trust_proxy = std::env::var("TACIT_NODE_TRUST_PROXY").is_ok_and(|v| v == "1");
    for (req, raw) in rx {
        let method = req.method().as_str().to_string();
        let url = req.url().to_string();
        // the client's address: the socket's, or behind a proxy that sets it, the first X-Forwarded-For
        let forwarded = trust_proxy
            .then(|| req.headers().iter().find(|h| h.field.equiv("X-Forwarded-For")).and_then(|h| h.value.as_str().split(',').next()?.trim().parse().ok()))
            .flatten();
        let ip = forwarded.or_else(|| req.remote_addr().map(|a| a.ip()));
        let (code, payload) = if raw.len() > MAX_BODY {
            (413, json!({ "error": "too large" }))
        } else {
            let body: Value = if raw.is_empty() { Value::Null } else { serde_json::from_slice(&raw).unwrap_or(Value::Null) };
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            let token = std::env::var("TACIT_NODE_ADMIN").ok().filter(|t| !t.is_empty());
            let bearer = req.headers().iter().find(|h| h.field.equiv("Authorization")).map(|h| h.value.as_str().to_string());
            let admin = match &token {
                Some(t) => bearer.as_deref() == Some(&format!("Bearer {t}")),
                None => req.remote_addr().is_some_and(|a| a.ip().is_loopback()),
            };
            match leader.handle(&method, &url, &body, now, admin, ip) {
                Ok(v) => (200, v),
                Err((c, e)) => (c, json!({ "error": e })),
            }
        };
        let _ = req.respond(cors(tiny_http::Response::from_data(payload.to_string().into_bytes()).with_status_code(code)));
    }
    Ok(())
}
