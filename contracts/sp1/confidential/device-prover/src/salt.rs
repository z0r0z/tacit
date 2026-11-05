// Salt mining between proofs. While mining is on (POST /mine) and nothing is being proved, spare cores grind CreateX CREATE3 salts that
// only Tacit's deployer can use, and the shares go to the API's salt pool (POST /prover/salt/share, worker/src/salt-pool.js) once a minute,
// for the same address the proofs pay. A proof always comes first: the grinding stops while one runs and starts again after it.
//
// A salt is the deployer's address, 0x00 (CreateX guards it as keccak256(pad32(deployer) ‖ salt), so only the deployer can deploy with it,
// at the same address on every chain), the UTC day (2 bytes) and 9 bytes ground here. Its address is CreateX's CREATE3: a proxy at
// CREATE2(CreateX, guarded salt, the proxy's init code hash), which creates the contract at its nonce 1. A share's address starts with at
// least as many zero bits as the pool asks (GET /prover/salt minBits).
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tiny_keccak::{Hasher, Keccak};

const DEPLOYER: [u8; 20] = hex20("68575b073de49a94e3e3acf6f3a0d6e3b66267c7");
const CREATEX: [u8; 20] = hex20("ba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed");
const PROXY_INIT: [u8; 16] = [0x67, 0x36, 0x3d, 0x3d, 0x37, 0x36, 0x3d, 0x34, 0xf0, 0x3d, 0x52, 0x60, 0x08, 0x60, 0x18, 0xf3];

pub static PROVING: AtomicBool = AtomicBool::new(false);
static HASHES: AtomicU64 = AtomicU64::new(0);
static MIN_BITS: AtomicU64 = AtomicU64::new(26);
static FOUND: Mutex<Vec<([u8; 32], u32)>> = Mutex::new(Vec::new());
// What the pool said of this run's shares: { day, shares, weight, best }, and the rate the cores ground at.
static TODAY: Mutex<Option<Value>> = Mutex::new(None);
static RATE: Mutex<(f64, Option<(Instant, u64)>)> = Mutex::new((0.0, None));

const fn hex20(s: &str) -> [u8; 20] {
    let b = s.as_bytes();
    let mut out = [0u8; 20];
    let mut i = 0;
    while i < 20 {
        out[i] = (nib(b[2 * i]) << 4) | nib(b[2 * i + 1]);
        i += 1;
    }
    out
}
const fn nib(c: u8) -> u8 { if c >= b'a' { c - b'a' + 10 } else { c - b'0' } }

fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut k = Keccak::v256();
    for p in parts { k.update(p); }
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}
fn day() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() / 86400).unwrap_or(0) }

// The CREATE3 address of a salt from the deployer, and its leading zero bits.
pub fn address(salt: &[u8; 32], proxy_hash: &[u8; 32]) -> ([u8; 20], u32) {
    let guarded = keccak(&[&[0u8; 12], &DEPLOYER, salt]);
    let proxy = keccak(&[&[0xff], &CREATEX, &guarded, proxy_hash]);
    let a = keccak(&[&[0xd6, 0x94], &proxy[12..32], &[0x01]]);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&a[12..32]);
    let mut bits = 0;
    for b in addr {
        if b == 0 { bits += 8; continue; }
        bits += b.leading_zeros();
        break;
    }
    (addr, bits)
}

fn active() -> bool { crate::pool::miner().is_some() && !PROVING.load(Ordering::Relaxed) }

fn grind(seed: u64) {
    let proxy_hash = keccak(&[&PROXY_INIT]);
    let mut salt = [0u8; 32];
    salt[..20].copy_from_slice(&DEPLOYER);
    let mut n: u64 = seed;
    loop {
        if !active() { std::thread::sleep(Duration::from_secs(5)); continue; }
        let d = day();
        salt[21..23].copy_from_slice(&((d % 65536) as u16).to_be_bytes());
        salt[23] = (seed >> 56) as u8;
        let min = MIN_BITS.load(Ordering::Relaxed) as u32;
        for _ in 0..(1u32 << 18) {
            n = n.wrapping_add(1);
            salt[24..32].copy_from_slice(&n.to_be_bytes());
            let (_, bits) = address(&salt, &proxy_hash);
            if bits >= min { FOUND.lock().unwrap().push((salt, bits)); }
        }
        HASHES.fetch_add(1 << 18, Ordering::Relaxed);
    }
}

fn http() -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder().timeout(Duration::from_secs(20)).build().ok()
}
fn api() -> String { std::env::var("TACIT_API").unwrap_or_else(|_| "https://api.tacit.finance".into()) }

// Once a minute: the share size the pool asks, then the shares found, best first, for the address mining pays.
fn send() {
    let Some(http) = http() else { return };
    loop {
        std::thread::sleep(Duration::from_secs(60));
        {
            let mut r = RATE.lock().unwrap();
            let h = HASHES.load(Ordering::Relaxed);
            if let Some((t, last)) = r.1 { r.0 = (h - last) as f64 / t.elapsed().as_secs_f64().max(1.0); }
            r.1 = Some((Instant::now(), h));
        }
        if let Ok(v) = http.get(format!("{}/prover/salt", api())).send().and_then(|r| r.json::<Value>()) {
            if let Some(b) = v["minBits"].as_u64().filter(|b| (16..=64).contains(b)) { MIN_BITS.store(b, Ordering::Relaxed); }
        }
        let Some(miner) = crate::pool::miner() else { continue };
        let mut found = std::mem::take(&mut *FOUND.lock().unwrap());
        if found.is_empty() { continue; }
        found.sort_by(|a, b| b.1.cmp(&a.1));
        let rest = found.split_off(found.len().min(64));
        FOUND.lock().unwrap().extend(rest);
        let salts: Vec<String> = found.iter().map(|(s, _)| format!("0x{}", hex::encode(s))).collect();
        match http.post(format!("{}/prover/salt/share", api())).json(&json!({ "miner": miner, "salts": salts })).send() {
            Ok(r) if r.status().as_u16() == 429 => FOUND.lock().unwrap().extend(found),
            Ok(r) => {
                if let Ok(v) = r.json::<Value>() {
                    if v["ok"].as_bool() == Some(true) {
                        eprintln!("tacit-prover: {} salt shares counted for {miner}", v["accepted"]);
                        *TODAY.lock().unwrap() = Some(json!({ "day": day(), "today": v["today"] }));
                    }
                }
            }
            Err(_) => FOUND.lock().unwrap().extend(found),
        }
    }
}

// Spare cores (TACIT_SALT_THREADS, else half of them; 0 is off) and the sender.
pub fn start() {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    let threads = std::env::var("TACIT_SALT_THREADS").ok().and_then(|s| s.parse::<usize>().ok()).unwrap_or((cores / 2).max(1));
    if threads == 0 { return; }
    let base: u64 = rand::random();
    for t in 0..threads {
        let seed = (base & 0x00ff_ffff_ffff_ffff) | ((t as u64 & 0xff) << 56);
        std::thread::Builder::new().name(format!("salt-{t}")).spawn(move || grind(seed)).ok();
    }
    std::thread::spawn(send);
    eprintln!("tacit-prover: grinding salts on {threads} of {cores} cores between proofs");
}

// For GET /mine: whether the cores are grinding, how fast, and what the pool counted today.
pub fn status() -> Value {
    let t = TODAY.lock().unwrap().clone().filter(|v| v["day"].as_u64() == Some(day()));
    json!({ "on": active(), "rate": RATE.lock().unwrap().0.round(), "minBits": MIN_BITS.load(Ordering::Relaxed), "today": t.map(|v| v["today"].clone()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    // contracts/deployments/launch-v1-final.env: the EthCallOutbox's salt and where CreateX put it (tests/salt-pool.test.mjs pins the same).
    #[test]
    fn address_is_where_createx_deployed() {
        let mut salt = [0u8; 32];
        salt.copy_from_slice(&hex::decode("68575b073de49a94e3e3acf6f3a0d6e3b66267c7000326fb99fa8e9a005a64b9").unwrap());
        let (a, bits) = address(&salt, &keccak(&[&PROXY_INIT]));
        assert_eq!(hex::encode(a), "00000000a26a6e291972666a9687741dba11af46");
        assert_eq!(bits, 32);
    }
}
