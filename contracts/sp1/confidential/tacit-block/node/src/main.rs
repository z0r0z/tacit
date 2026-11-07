//! tacit-block-node replay FIXTURE   replays a fixture chain (`tacit-block fixture`) from what each block publishes alone, checking
//!                                   every block reaches the state its proof committed, and rebuilds each block's guest input
//!                                   (FIXTURE.b<i>.stdin) from the replayed state and the block's own spends, byte for byte.

use serde_json::{json, Value};
use std::process::exit;
use tacit_block_common::{lock::Settle, SpendData};
use tacit_block_node::{read_stdin_file, Node, Published, SpendIn};

fn fail(msg: &str) -> ! {
    eprintln!("tacit-block-node: {msg}");
    exit(2)
}

fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap_or_else(|| fail("a hex field")).trim_start_matches("0x")).unwrap_or_else(|_| fail("hex"))
}

fn words32(b: &[u8]) -> Vec<[u8; 32]> {
    b.chunks(32).map(|c| c.try_into().unwrap()).collect()
}

/// The block's own inputs, as its guest input carries them: spends, settles, time and the queue's entries with whether each verifies.
fn inputs(bufs: &[Vec<u8>]) -> (Vec<SpendIn>, Vec<Settle>, u64, Vec<u8>, Vec<(Vec<u8>, bool)>) {
    let u32_at = |i: usize| u32::from_le_bytes(bufs[i].clone().try_into().unwrap_or_else(|_| fail("a count"))) as usize;
    let n = u32_at(1);
    let mut at = 2;
    let mut spends = vec![];
    for _ in 0..n {
        let data = SpendData::from_bytes(&bufs[at + 3]).unwrap_or_else(|| fail("spend data"));
        spends.push(SpendIn { publics: bufs[at].clone(), proof: bufs[at + 1].clone(), hints: bufs[at + 2].clone(), data });
        at += 4;
    }
    let k = u32_at(at);
    at += 1;
    let settles: Vec<Settle> = (0..k).map(|i| Settle::from_bytes(&bufs[at + i]).unwrap_or_else(|| fail("settle"))).collect();
    at += k;
    let time = u64::from_le_bytes(bufs[at].clone().try_into().unwrap_or_else(|_| fail("time")));
    at += 1;
    let blobs = bufs[at].clone();
    at += 1;
    let m = u32_at(at);
    at += 1;
    let posts = (0..m).map(|j| (bufs[at + 2 * j].clone(), bufs[at + 2 * j + 1].first() == Some(&1))).collect();
    (spends, settles, time, blobs, posts)
}

fn replay(path: &str) {
    let fx: Value = serde_json::from_slice(&std::fs::read(path).unwrap_or_else(|e| fail(&format!("{path}: {e}")))).unwrap_or_else(|_| fail("fixture json"));
    let chain: [u8; 32] = bytes(&fx["chain"]).try_into().unwrap_or_else(|_| fail("chain"));
    let mut node = Node::genesis(chain);
    if node.state.digest().to_vec() != bytes(&fx["genesisState"]) {
        fail("the node's genesis is not the fixture's");
    }
    let blocks = fx["blocks"].as_array().unwrap_or_else(|| fail("blocks"));
    for (i, b) in blocks.iter().enumerate() {
        let stdin = std::fs::read(format!("{path}.b{i}.stdin")).unwrap_or_else(|e| fail(&format!("{path}.b{i}.stdin: {e}")));
        let bufs = read_stdin_file(&stdin).unwrap_or_else(|| fail("a guest input file"));
        let (spends, settles, time, blobs, posts) = inputs(&bufs);
        let (built, out, _) = node.build(&spends, &settles, &posts, time, &blobs).unwrap_or_else(|e| fail(&format!("block {i}: {e}")));
        if built != bufs {
            fail(&format!("block {i}: the node's guest input differs from the host's"));
        }
        if out.encode() != bytes(&b["publicValues"]) {
            fail(&format!("block {i}: the node expects other public values"));
        }
        let published = Published {
            words: words32(&bytes(&b["publicValues"])),
            leaves: words32(&bytes(&b["leaves"])),
            memos: bytes(&b["memos"]).chunks(tacit_block_common::MEMO_LEN).map(<[u8]>::to_vec).collect(),
            nullifiers: b["nullifiers"].as_array().unwrap_or_else(|| fail("nullifiers")).iter().map(|n| bytes(n).try_into().unwrap()).collect(),
        };
        node.land(&published).unwrap_or_else(|e| fail(&format!("block {i}: {e}")));
    }
    println!("{}", json!({ "replayed": blocks.len(), "height": node.height, "leaves": node.leaves.len(), "nullifiers": node.nf.records.len() - 1, "state": hex::encode(node.state.digest()) }));
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("replay") if args.len() == 2 => replay(&args[1]),
        Some("serve") if args.len() == 3 => {
            let chain_id: u64 = args[1].parse().unwrap_or_else(|_| fail("the chain id is a number"));
            let (lander, addr) = args[2].split_once('@').unwrap_or_else(|| fail("serve CHAINID LANDER@HOST:PORT"));
            let lander: [u8; 20] = hex::decode(lander.trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok()).unwrap_or_else(|| fail("the lander is a 20-byte address"));
            let keys = tacit_block_node::keys::Keys::load().unwrap_or_else(|e| fail(&e));
            // TACIT_NODE_ASSET: TAC's asset field (the contract's TAC_ASSET), the only asset a spend may move
            let asset: Option<[u8; 32]> = std::env::var("TACIT_NODE_ASSET").ok().filter(|a| !a.is_empty()).map(|a| hex::decode(a.trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok()).unwrap_or_else(|| fail("TACIT_NODE_ASSET is a 32-byte word")));
            let leader = tacit_block_node::serve::Leader::new(tacit_block_common::chain_binding(chain_id, &lander), keys, asset);
            tacit_block_node::serve::serve(addr, leader).unwrap_or_else(|e| fail(&e));
        }
        _ => fail("usage: tacit-block-node replay FIXTURE | serve CHAINID LANDER@HOST:PORT"),
    }
}
