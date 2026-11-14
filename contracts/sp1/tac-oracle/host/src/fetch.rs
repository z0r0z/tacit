//! The program's input from an Ethereum node: the oracle's configuration, the headers from the oldest interval to the
//! anchor, and both venues' proofs at each interval's sample block.

use crate::rpc::Rpc;
use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_rlp::Encodable;
use serde_json::{json, Value};
use tac_oracle_core::{Account, Config, Input, Slot, Venue, RESERVES_SLOT, SUPPLY_SLOT};

const EMPTY_ROOT: B256 = B256::new(hex_lit("56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"));
const EMPTY_CODE: B256 = B256::new(hex_lit("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"));

const fn hex_lit(s: &str) -> [u8; 32] {
    let b = s.as_bytes();
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = (nib(b[2 * i]) << 4) | nib(b[2 * i + 1]);
        i += 1;
    }
    out
}

const fn nib(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => panic!("hex"),
    }
}

fn get(rpc: &Rpc, to: Address, sig: &str, args: &[[u8; 32]]) -> Result<Vec<u8>, String> {
    let mut data = keccak256(sig)[..4].to_vec();
    for a in args {
        data.extend_from_slice(a);
    }
    let out = rpc.eth_call(&to.to_string(), &data, "latest")?;
    if out.len() < 32 {
        return Err(format!("{to} {sig}: empty answer"));
    }
    Ok(out)
}

fn w(out: &[u8], i: usize) -> U256 {
    U256::from_be_slice(&out[32 * i..32 * i + 32])
}

fn addr(out: &[u8], i: usize) -> Address {
    Address::from_slice(&out[32 * i + 12..32 * i + 32])
}

fn u64_of(v: U256) -> u64 {
    v.to::<u64>()
}

/// The configuration from the venue oracles a TacPairOracle combines: `a` over the Precision pool, `b` over the
/// confidential pool's AMM.
pub fn config_from_venues(rpc: &Rpc, a: Address, b: Address) -> Result<Config, String> {
    let step = u64_of(w(&get(rpc, a, "STEP()", &[])?, 0));
    let secs = step * 12;
    let short = u64_of(w(&get(rpc, a, "SHORT_WINDOW()", &[])?, 0));
    let window = u64_of(w(&get(rpc, a, "WINDOW()", &[])?, 0));
    let max = u64_of(w(&get(rpc, a, "MAX_WINDOW()", &[])?, 0));
    let cov = u64_of(w(&get(rpc, a, "MIN_COVERAGE_BPS()", &[])?, 0));
    for (sig, want) in [("STEP()", step), ("SHORT_WINDOW()", short), ("WINDOW()", window), ("MAX_WINDOW()", max)] {
        if u64_of(w(&get(rpc, b, sig, &[])?, 0)) != want {
            return Err(format!("the venues differ in {sig}"));
        }
    }
    let precision = addr(&get(rpc, a, "POOL()", &[])?, 0);
    let pool = addr(&get(rpc, b, "POOL()", &[])?, 0);
    let slots = get(rpc, b, "slots()", &[])?;
    let pool_id = w(&get(rpc, b, "POOL_ID()", &[])?, 0).to_be_bytes::<32>();
    let p = get(rpc, pool, "pools(bytes32)", &[pool_id])?;
    let scale = |asset: U256| -> Result<U256, String> {
        Ok(w(&get(rpc, pool, "assets(bytes32)", &[asset.to_be_bytes::<32>()])?, 2))
    };
    Ok(Config {
        step,
        short_points: short / secs,
        window_points: window / secs,
        max_points: max / secs,
        min_coverage_bps: cov,
        precision,
        sqrt_p_low: w(&get(rpc, precision, "sqrtPLow()", &[])?, 0),
        sqrt_p_high: w(&get(rpc, precision, "sqrtPHigh()", &[])?, 0),
        pool,
        slot_a: B256::from(w(&slots, 0)),
        slot_b: B256::from(w(&slots, 1)),
        eth_scale: scale(w(&p, 1))?,
        tac_scale: scale(w(&p, 2))?,
    })
}

/// The configuration a deployed TacProvenOracle stores; checked against its CONFIG.
pub fn config_from_oracle(rpc: &Rpc, o: Address) -> Result<Config, String> {
    let n = |sig: &str| -> Result<U256, String> { Ok(w(&get(rpc, o, sig, &[])?, 0)) };
    let step = u64_of(n("STEP()")?);
    let secs = step * 12;
    let c = Config {
        step,
        short_points: u64_of(n("SHORT_WINDOW()")?) / secs,
        window_points: u64_of(n("WINDOW()")?) / secs,
        max_points: u64_of(n("MAX_WINDOW()")?) / secs,
        min_coverage_bps: u64_of(n("MIN_COVERAGE_BPS()")?),
        precision: addr(&get(rpc, o, "PRECISION()", &[])?, 0),
        sqrt_p_low: n("SQRT_P_LOW()")?,
        sqrt_p_high: n("SQRT_P_HIGH()")?,
        pool: addr(&get(rpc, o, "POOL()", &[])?, 0),
        slot_a: B256::from(n("SLOT_A()")?),
        slot_b: B256::from(n("SLOT_B()")?),
        eth_scale: n("ETH_SCALE()")?,
        tac_scale: n("TAC_SCALE()")?,
    };
    let stored = B256::from(n("CONFIG()")?);
    if c.digest() != stored {
        return Err(format!("config digest {} is not the oracle's CONFIG {stored}", c.digest()));
    }
    Ok(c)
}

fn hexb(v: &Value, k: &str) -> Result<Vec<u8>, String> {
    let s = v.get(k).and_then(Value::as_str).ok_or(format!("no {k}"))?;
    hex::decode(s.trim_start_matches("0x")).map_err(|e| format!("{k}: {e}"))
}

fn qty(v: &Value, k: &str) -> Result<U256, String> {
    let s = v.get(k).and_then(Value::as_str).ok_or(format!("no {k}"))?;
    U256::from_str_radix(s.trim_start_matches("0x"), 16).map_err(|e| format!("{k}: {e}"))
}

// The header's RLP from a block's JSON fields, through the newest fork's fields that the block carries.
fn header_rlp(v: &Value) -> Result<Vec<u8>, String> {
    let mut p = Vec::with_capacity(700);
    for k in ["parentHash", "sha3Uncles", "miner", "stateRoot", "transactionsRoot", "receiptsRoot", "logsBloom"] {
        hexb(v, k)?.as_slice().encode(&mut p);
    }
    for k in ["difficulty", "number", "gasLimit", "gasUsed", "timestamp"] {
        qty(v, k)?.encode(&mut p);
    }
    for k in ["extraData", "mixHash", "nonce"] {
        hexb(v, k)?.as_slice().encode(&mut p);
    }
    let later: [(&str, bool); 6] = [
        ("baseFeePerGas", true),
        ("withdrawalsRoot", false),
        ("blobGasUsed", true),
        ("excessBlobGas", true),
        ("parentBeaconBlockRoot", false),
        ("requestsHash", false),
    ];
    for (k, is_qty) in later {
        if v.get(k).map_or(true, Value::is_null) {
            break;
        }
        if is_qty {
            qty(v, k)?.encode(&mut p);
        } else {
            hexb(v, k)?.as_slice().encode(&mut p);
        }
    }
    let mut out = Vec::with_capacity(p.len() + 3);
    alloy_rlp::Header { list: true, payload_length: p.len() }.encode(&mut out);
    out.extend_from_slice(&p);
    Ok(out)
}

/// The RLP headers of blocks `from` to `to` and their mixHashes, each checked against the node's block hash.
pub fn headers(rpc: &Rpc, from: u64, to: u64) -> Result<(Vec<Bytes>, Vec<B256>), String> {
    let mut raws = Vec::new();
    let mut mixes = Vec::new();
    let mut n = from;
    while n <= to {
        let end = (n + 49).min(to);
        let calls: Vec<(&str, Value)> =
            (n..=end).map(|b| ("eth_getBlockByNumber", json!([format!("0x{b:x}"), false]))).collect();
        for (i, blk) in rpc.batch(&calls)?.into_iter().enumerate() {
            let raw = header_rlp(&blk)?;
            let hash = B256::from_slice(&hexb(&blk, "hash")?);
            if keccak256(&raw) != hash {
                return Err(format!("block {}: the header's fields do not hash to its hash", n + i as u64));
            }
            mixes.push(B256::from_slice(&hexb(&blk, "mixHash")?));
            raws.push(Bytes::from(raw));
        }
        n = end + 1;
    }
    Ok((raws, mixes))
}

/// A venue's account and two slots at `block`, from eth_getProof.
pub fn venue(rpc: &Rpc, a: Address, slots: [B256; 2], block: u64) -> Result<Venue, String> {
    let keys: Vec<String> = slots.iter().map(|s| s.to_string()).collect();
    let r = rpc.call("eth_getProof", json!([a.to_string(), keys, format!("0x{block:x}")]))?;
    let list = |v: &Value| -> Result<Vec<Bytes>, String> {
        v.as_array()
            .ok_or("no proof")?
            .iter()
            .map(|n| hex::decode(n.as_str().unwrap_or_default().trim_start_matches("0x")).map(Bytes::from))
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())
    };
    let account = Account {
        nonce: u64_of(qty(&r, "nonce")?),
        balance: qty(&r, "balance")?,
        storage_root: B256::from_slice(&hexb(&r, "storageHash")?),
        code_hash: B256::from_slice(&hexb(&r, "codeHash")?),
    };
    let absent =
        account.nonce == 0 && account.balance.is_zero() && account.storage_root == EMPTY_ROOT && account.code_hash == EMPTY_CODE;
    let sp = r.get("storageProof").and_then(Value::as_array).ok_or("no storageProof")?;
    let slots = if absent {
        Vec::new()
    } else {
        sp.iter()
            .map(|s| Ok(Slot { value: qty(s, "value")?, proof: list(&s["proof"])? }))
            .collect::<Result<Vec<_>, String>>()?
    };
    Ok(Venue { account: (!absent).then_some(account), account_proof: list(&r["accountProof"])?, slots })
}

/// The input for X = the newest interval whose following block is at or before `anchor`, covering `count` intervals.
pub fn input(heads: &Rpc, proofs: &Rpc, c: Config, anchor: u64, count: u64, log: bool) -> Result<Input, String> {
    let x = anchor / c.step - 1;
    let lo = x - c.max_points;
    let first = lo * c.step;
    if log {
        eprintln!("X {x}, intervals {lo}..={x}, headers {first}..={anchor} ({} blocks)", anchor - first + 1);
    }
    let (headers, mixes) = headers(heads, first, anchor)?;
    let mut intervals = Vec::with_capacity((c.max_points + 1) as usize);
    for i in lo..=x {
        let mix = U256::from_be_bytes(mixes[((i + 1) * c.step - first) as usize].0);
        let sample = i * c.step + (mix % U256::from(c.step)).to::<u64>();
        let a = venue(proofs, c.precision, [RESERVES_SLOT, SUPPLY_SLOT], sample)?;
        let b = venue(proofs, c.pool, [c.slot_a, c.slot_b], sample)?;
        intervals.push(vec![a, b]);
        if log && (i - lo) % 10 == 0 {
            eprintln!("  interval {i}: sample block {sample}");
        }
    }
    Ok(Input { config: c, x, count, first_block: first, headers, intervals })
}
