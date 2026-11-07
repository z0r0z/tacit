//! The leader's core, over HTTP: the chain a node replays, a mempool of spends and settles checked on the way in (the proof natively, the
//! body and the openings and the nullifiers by a trial block), and the next block built from them. Chain I/O (following Ethereum's
//! events, proving, sending `land`) is the caller's: it tells this process what landed (`POST /landed`) and asks for the next block
//! (`POST /build`).
//!
//!   GET  /state                  height, state digest, note root, counts, queue position, chain binding
//!   GET  /notes?from=N&limit=M   leaves and their memos from leaf N on (what a wallet scans)
//!   GET  /path/N                 the note root and the path of leaf N
//!   GET  /spent/0x…              whether a nullifier has entered the tree
//!   GET  /receipt/ID             a submission: queued, or landed in a block
//!   GET  /mempool                what is waiting
//!   POST /address                { address } → { hash }      GET /address/<hash> → { address }   (the chain lane's directory)
//!   POST /spend                  { publics, proof, data, memos[], opMemos[], back? } → { id }   (back: a shield paid to its inbox)
//!   POST /settle                 { settle, memo } → { id }
//!   POST /build                  { time, blobs?: bool, queue?: [payload…], max?: n, exclude?: [id…] } → the block: guest input, public values, lists
//!   POST /landed                 { words[16], leaves[], memos[], nullifiers[] } → replays a landed block and clears what it took
//!
//! `/build` and `/landed` are the leader's own: they need `Authorization: Bearer $TACIT_NODE_ADMIN`, or, with none set, a loopback caller
//! (`/landed` takes the caller's word that a block landed, so the public must never reach it). The rest is open: a wallet's reads and its
//! submissions, which are checked on the way in.

use crate::{blobs, keys::Keys, stdin_file, Node, Published, SpendIn};
use ff::Field;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Read;
use tacit_block_common::{self as blk, lock::Settle, SpendData, MEMO_LEN};

const MAX_BODY: usize = 4 << 20;
const MAX_PENDING: usize = 256;

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

#[derive(Clone)]
struct Entry {
    id: String,
    spend: SpendIn,
    memos: Vec<Vec<u8>>,
    /// For a shield paid to its inbox (TacitBlocks.inbox) rather than deposited: the confidential pool commitment the inbox's
    /// address fixes, which the leader needs to sweep it in.
    back: Option<String>,
}

#[derive(Clone)]
struct SettleEntry {
    id: String,
    settle: Settle,
    memo: Vec<u8>,
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
    /// Full chain addresses by the hash a Tacit address's chain lane carries (content-addressed: a payer checks what it gets).
    directory: Directory,
}

/// Chain addresses by SHA-256("tacit-chain-address-v1" ‖ address), kept in memory and appended to TACIT_NODE_DIRECTORY (one hex
/// address a line) when set, at most DIRECTORY_MAX.
pub struct Directory {
    map: BTreeMap<[u8; 32], Vec<u8>>,
    file: Option<String>,
}
const ADDRESS_LEN: usize = 128 + 33 + 1184;
const DIRECTORY_MAX: usize = 250_000;

impl Directory {
    pub fn open(file: Option<String>) -> Directory {
        let mut d = Directory { map: BTreeMap::new(), file: None };
        if let Some(f) = &file {
            if let Ok(text) = std::fs::read_to_string(f) {
                for line in text.lines() {
                    if let Ok(b) = hex::decode(line.trim()) {
                        let _ = d.add(b);
                    }
                }
            }
        }
        d.file = file;
        d
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

impl Leader {
    pub fn new(chain: [u8; 32], keys: Keys, asset: Option<[u8; 32]>) -> Leader {
        Leader { node: Node::genesis(chain), keys, asset, pending: vec![], settles: vec![], receipts: BTreeMap::new(), built: None, directory: Directory::open(std::env::var("TACIT_NODE_DIRECTORY").ok().filter(|f| !f.is_empty())) }
    }

    fn spends(&self, extra: Option<&Entry>) -> Vec<SpendIn> {
        self.pending.iter().chain(extra).map(|e| e.spend.clone()).collect()
    }

    fn settles_list(&self, extra: Option<&SettleEntry>) -> Vec<Settle> {
        self.settles.iter().chain(extra).map(|e| e.settle.clone()).collect()
    }

    fn state(&self) -> Value {
        let s = &self.node.state;
        json!({
            "height": self.node.height, "state": hx(&s.digest()), "noteRoot": hx(&blk::fr_be(&s.notes.root)), "leaves": self.node.leaves.len(),
            "nullifiers": self.node.nf.records.len() - 1, "queue": { "len": s.queue_len, "hash": hx(&s.queue_hash) }, "chain": hx(&s.chain),
            "pending": self.pending.len(), "settles": self.settles.len(),
        })
    }

    /// A spend handed in: its proof checked natively, its memos matched to its body, and a trial block of the mempool and it taken.
    fn spend(&mut self, b: &Value, now: u64) -> Result<Value, String> {
        if self.pending.len() + self.settles.len() >= MAX_PENDING {
            return Err("the mempool is full".into());
        }
        let publics = hexv(&b["publics"])?;
        let proof = hexv(&b["proof"])?;
        let data = SpendData::from_bytes(&hexv(&b["data"])?).ok_or("spend data does not parse")?;
        let p = tacit_block_agg_publics(&publics)?;
        let hints = self.keys.check(&p, &proof).ok_or("the spend's proof does not verify")?;
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
        let mut id_in = publics.clone();
        id_in.extend(data.to_bytes());
        let id = hex::encode(blk::payload_hash(&id_in));
        if self.receipts.contains_key(&id) {
            return Ok(self.receipts[&id].clone());
        }
        let back = match b["back"].as_str() {
            Some(h) => {
                let v = hexv(&serde_json::Value::String(h.into()))?;
                if v.len() != 32 {
                    return Err("back is a 32-byte commitment".into());
                }
                Some(hx(&v))
            }
            None => None,
        };
        let entry = Entry { id: id.clone(), spend: SpendIn { publics, proof, hints, data }, memos: memos.into_iter().chain(op_memos).collect(), back };
        self.node.build(&self.spends(Some(&entry)), &self.settles_list(None), &[], now, &[]).map_err(|e| format!("not takeable now: {e}"))?;
        self.pending.push(entry);
        let r = json!({ "id": id, "status": "queued" });
        self.receipts.insert(id, r.clone());
        Ok(r)
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
        if self.receipts.contains_key(&id) {
            return Ok(self.receipts[&id].clone());
        }
        if !self.node.roots.contains(&blk::fr_be(&settle.root)) {
            return Err("the settle names a note root no block ended at".into());
        }
        if self.asset.is_some_and(|a| blk::fr_be(&settle.asset) != a) {
            return Err("only TAC moves on this chain".into());
        }
        let entry = SettleEntry { id: id.clone(), settle, memo };
        self.node.build(&self.spends(None), &self.settles_list(Some(&entry)), &[], now, &[]).map_err(|e| format!("not takeable now: {e}"))?;
        self.settles.push(entry);
        let r = json!({ "id": id, "status": "queued" });
        self.receipts.insert(id, r.clone());
        Ok(r)
    }

    /// The next block: the mempool's spends and settles and the queue's next entries, in calldata or blobs.
    fn build(&mut self, b: &Value) -> Result<Value, String> {
        let time = b["time"].as_u64().ok_or("time")?;
        let max = b["max"].as_u64().unwrap_or(64) as usize;
        let want_blobs = b["blobs"].as_bool().unwrap_or(false);
        let exclude: Vec<String> = b["exclude"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
        let queue: Vec<Vec<u8>> = b["queue"].as_array().map(|a| a.iter().map(hexv).collect::<Result<_, _>>()).transpose()?.unwrap_or_default();
        // keep only what is takeable at this time, oldest first
        let mut spends: Vec<Entry> = self.pending.iter().filter(|e| !exclude.contains(&e.id)).cloned().collect();
        spends.truncate(max);
        let mut settles = self.settles.clone();
        settles.truncate(max.saturating_sub(spends.len()));
        let sp: Vec<SpendIn> = spends.iter().map(|e| e.spend.clone()).collect();
        let st: Vec<Settle> = settles.iter().map(|e| e.settle.clone()).collect();
        // a posted spend is taken if its proof verifies; a posted settle's check is the program's own
        let posts: Vec<(Vec<u8>, bool)> = queue
            .iter()
            .map(|p| {
                let ok = blk::forced_parts(p).map(|(pub_, proof, hints, _)| self.keys.check_hinted(&pub_, proof, hints)).unwrap_or(false);
                (p.clone(), ok)
            })
            .collect();
        let (mut bufs, mut out, mut data) = self.node.build(&sp, &st, &posts, time, &[])?;
        let mut openings = vec![];
        let mut raw_blobs = vec![];
        if want_blobs {
            let mut pool: Vec<Vec<u8>> = spends.iter().flat_map(|e| e.memos.clone()).chain(settles.iter().map(|e| e.memo.clone())).collect();
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
            let (buf, raw, op) = blobs::blob_input(&data, &pool)?;
            let rebuilt = self.node.build(&sp, &st, &posts, time, &buf)?;
            bufs = rebuilt.0;
            out = rebuilt.1;
            data = rebuilt.2;
            openings = op;
            raw_blobs = raw;
        }
        // the memos published beside the new notes (calldata mode), found by their hashes
        let mut pool: Vec<Vec<u8>> = spends.iter().flat_map(|e| e.memos.clone()).chain(settles.iter().map(|e| e.memo.clone())).collect();
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
                "blobs": hx(&openings.iter().flat_map(blobs::BlobOpening::to_bytes).collect::<Vec<u8>>()),
            },
            "blobData": hexes(&raw_blobs),
        });
        self.built = Some(Built { ids, out: result.clone() });
        Ok(result)
    }

    /// A block that landed on Ethereum: replayed from what it published, which must reach the state its proof committed.
    fn landed(&mut self, b: &Value) -> Result<Value, String> {
        let words: Vec<[u8; 32]> = b["words"].as_array().ok_or("words")?.iter().map(word32).collect::<Result<_, _>>()?;
        let leaves: Vec<[u8; 32]> = b["leaves"].as_array().ok_or("leaves")?.iter().map(word32).collect::<Result<_, _>>()?;
        let memos: Vec<Vec<u8>> = b["memos"].as_array().ok_or("memos")?.iter().map(hexv).collect::<Result<_, _>>()?;
        let nullifiers: Vec<[u8; 32]> = b["nullifiers"].as_array().ok_or("nullifiers")?.iter().map(word32).collect::<Result<_, _>>()?;
        self.node.land(&Published { words, leaves, memos, nullifiers })?;
        // what the block took leaves the mempool; a spend whose notes it spent another way is dropped
        let height = self.node.height;
        let included: Vec<String> = self.built.take().map(|b| b.out["includes"].as_array().cloned().unwrap_or_default().iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
        for id in &included {
            self.receipts.insert(id.clone(), json!({ "id": id, "status": "landed", "height": height }));
        }
        let node = &self.node;
        self.pending.retain(|e| {
            let spent = tacit_block_agg_publics(&e.spend.publics).map(|p| blk::Spend::from_publics(&p).spent_keys().iter().any(|n| node.spent(&blk::fr_be(n)))).unwrap_or(true);
            !included.contains(&e.id) && !spent
        });
        self.settles.retain(|e| !included.contains(&e.id) && !node.spent(&blk::fr_be(&blk::lock::lock_nullifier(&e.settle.leaf(), e.settle.index))));
        Ok(self.state())
    }

    fn route(&mut self, method: &str, url: &str, body: &Value, now: u64, admin: bool) -> Result<Value, (u16, String)> {
        if method == "POST" && matches!(url, "/build" | "/landed") && !admin {
            return Err((403, "the leader's own".into()));
        }
        let (path, query) = url.split_once('?').unwrap_or((url, ""));
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
            ("GET", p) if p.starts_with("/path/") => {
                let i: u64 = p[6..].parse().map_err(|_| bad("an index".into()))?;
                let (root, path) = self.node.path(i).ok_or((404, "no such leaf".to_string()))?;
                Ok(json!({ "index": i, "root": hx(&blk::fr_be(&root)), "path": path.iter().map(|x| hx(&blk::fr_be(x))).collect::<Vec<_>>() }))
            }
            ("GET", p) if p.starts_with("/spent/") => {
                let nf: [u8; 32] = hex::decode(p[7..].trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok()).ok_or(bad("a 32-byte nullifier".into()))?;
                Ok(json!({ "spent": self.node.spent(&nf) }))
            }
            ("POST", "/address") => {
                let a = hexv(&body["address"]).map_err(bad)?;
                let h = self.directory.add(a).map_err(bad)?;
                Ok(json!({ "hash": hx(&h) }))
            }
            ("GET", p) if p.starts_with("/address/") => {
                let h: [u8; 32] = hex::decode(p[9..].trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok()).ok_or(bad("a 32-byte hash".into()))?;
                self.directory.map.get(&h).map(|a| json!({ "address": hx(a) })).ok_or((404, "no such address".to_string()))
            }
            ("GET", p) if p.starts_with("/receipt/") => self.receipts.get(&p[9..]).cloned().ok_or((404, "no such submission".to_string())),
            ("GET", "/mempool") => Ok(json!({
                "spends": self.pending.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
                "settles": self.settles.iter().map(|e| e.id.clone()).collect::<Vec<_>>(),
                // the deposit each spend takes in, which must be waiting on Ethereum for a block that holds it to land
                "deposits": self.pending.iter().filter_map(|e| {
                    let p = tacit_block_agg_publics(&e.spend.publics).ok()?;
                    blk::deposit_record(&blk::Spend::from_publics(&p), &e.spend.data).map(|d| json!({ "id": e.id, "deposit": hx(&d), "back": e.back }))
                }).collect::<Vec<_>>(),
            })),
            ("POST", "/spend") => self.spend(body, now).map_err(bad),
            ("POST", "/settle") => self.settle(body, now).map_err(bad),
            ("POST", "/build") => self.build(body).map_err(bad),
            ("POST", "/landed") => self.landed(body).map_err(bad),
            _ => Err((404, "not found".into())),
        }
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
    for mut req in server.incoming_requests() {
        let method = req.method().as_str().to_string();
        let url = req.url().to_string();
        if method == "OPTIONS" {
            let _ = req.respond(cors(tiny_http::Response::from_data(vec![]).with_status_code(204)));
            continue;
        }
        let mut raw = vec![];
        let _ = req.as_reader().take(MAX_BODY as u64 + 1).read_to_end(&mut raw);
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
            match leader.route(&method, &url, &body, now, admin) {
                Ok(v) => (200, v),
                Err((c, e)) => (c, json!({ "error": e })),
            }
        };
        let _ = req.respond(cors(tiny_http::Response::from_data(payload.to_string().into_bytes()).with_status_code(code)));
    }
    Ok(())
}
