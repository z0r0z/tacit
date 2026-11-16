// Salt mining between Bitcoin batches, in community mode only (COMMUNITY_MINER): while no job is in hand, spare CPU cores grind CreateX
// CREATE3 salts that only Tacit's deployer can use, and the shares go to the API's salt pool (POST /prover/salt/share,
// worker/src/salt-pool.js) once a minute for the community address. A job always comes first: the grinding stops while one is in hand.
// The same as tacit-prover's (device-prover/src/salt.rs), with this worker's HTTP client; the address is checked against the same deploy.
//
// A salt is the deployer's address, 0x00 (CreateX guards it as keccak256(pad32(deployer) ‖ salt)), the UTC day (2 bytes) and 9 bytes
// ground here; its address is CreateX's CREATE3 (a proxy at CREATE2(CreateX, guarded salt, the proxy's init code hash), the contract at
// the proxy's nonce 1). A share's address starts with at least as many zero bits as the pool asks (GET /prover/salt minBits).
//
// The pool can ask for another kind of salt (GET /prover/salt `schemes`, the first the one to grind): one for the vanity-address market, the same layout with
// the shop's address in place of the deployer's. The market fixes its address as the contract its deploy proxy creates at transaction `nonce + 1`; the nonce is
// free, so each id is tried at the first NONCES of them and the best is the share, sent as `0x<id>:<nonce>`. Without a `schemes` that starts with `market`
// and the addresses of its shop and market, the grinding is CreateX's as before (the same as tacit-prover's, device-prover/src/salt.rs).
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tiny_keccak::{Hasher, Keccak};

const DEPLOYER: [u8; 20] = hex20("68575b073de49a94e3e3acf6f3a0d6e3b66267c7");
const CREATEX: [u8; 20] = hex20("ba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed");
const PROXY_INIT: [u8; 16] = [0x67, 0x36, 0x3d, 0x3d, 0x37, 0x36, 0x3d, 0x34, 0xf0, 0x3d, 0x52, 0x60, 0x08, 0x60, 0x18, 0xf3];

// The market's deploy proxy (VanityMarket DEPLOY_PROXY_INITHASH is its hash), and how many of a token's nonces one id is tried at: 0 to 7, so that
// nonce + 1 is the one byte RLP leaves as it is.
const MARKET_PROXY_INIT: [u8; 49] = [
    0x60, 0x28, 0x80, 0x60, 0x09, 0x3d, 0x39, 0x3d, 0xf3, 0x60, 0x01, 0x60, 0x05, 0x81, 0x36, 0x03, 0x34, 0x34, 0x84, 0x34, 0x36, 0x34, 0x34, 0x37, 0x6d, 0x01, 0xe4,
    0xa8, 0x2b, 0x33, 0x37, 0x3d, 0xe1, 0x33, 0x4e, 0x7d, 0x8f, 0x48, 0x79, 0x5a, 0xf4, 0x92, 0x47, 0xf0, 0x34, 0x52, 0x1b, 0x34, 0xf3,
];
const NONCES: u8 = 8;

// What the pool asks to be ground: CreateX salts for Tacit's deployer, or the vanity market's for its shop.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Terms {
    CreateX,
    Market { shop: [u8; 20], market: [u8; 20] },
}
static TERMS: Mutex<Terms> = Mutex::new(Terms::CreateX);
fn terms() -> Terms { *TERMS.lock().unwrap() }

// A share: the salt, its zero bits, and for a market salt the nonce its address is at.
type Share = ([u8; 32], u32, Option<u8>);
// The pool's spelling of a share: the salt, and for a market salt `:<nonce>`.
fn share_str(sh: &Share) -> String { format!("0x{}{}", hex::encode(sh.0), sh.2.map(|n| format!(":{n}")).unwrap_or_default()) }

static MIN_BITS: AtomicU64 = AtomicU64::new(26);
static FOUND: Mutex<Vec<Share>> = Mutex::new(Vec::new());
static BUSY: OnceLock<Arc<AtomicU64>> = OnceLock::new();

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

fn parse_addr(v: &serde_json::Value) -> Option<[u8; 20]> {
    let s = v.as_str()?.strip_prefix("0x")?;
    let b = hex::decode(s).ok()?;
    b.try_into().ok()
}

// The terms the pool's GET /prover/salt gives: market salts only when its first scheme is `market` and it names both addresses, else CreateX's.
pub fn terms_from(v: &serde_json::Value) -> Terms {
    let first = v["schemes"].as_array().and_then(|a| a.first()).and_then(|s| s.as_str());
    match (first, parse_addr(&v["shop"]), parse_addr(&v["market"])) {
        (Some("market"), Some(shop), Some(market)) => Terms::Market { shop, market },
        _ => Terms::CreateX,
    }
}

fn zero_bits(addr: &[u8; 20]) -> u32 {
    let mut bits = 0;
    for b in addr {
        if *b == 0 { bits += 8; continue; }
        bits += b.leading_zeros();
        break;
    }
    bits
}

// An id's addresses at its first NONCES nonces. The deploy proxy's address is one hash for them all; each nonce is one more.
pub fn market_addrs(salt: &[u8; 32], market: &[u8; 20], proxy_hash: &[u8; 32]) -> [[u8; 20]; NONCES as usize] {
    let proxy = keccak(&[&[0xff], market, salt, proxy_hash]);
    let mut out = [[0u8; 20]; NONCES as usize];
    for nonce in 0..NONCES {
        let a = keccak(&[&[0xd6, 0x94], &proxy[12..32], &[nonce + 1]]);
        out[nonce as usize].copy_from_slice(&a[12..32]);
    }
    out
}

// The best of those, as (address, zero bits, nonce): the lowest nonce among equals.
pub fn market_best(salt: &[u8; 32], market: &[u8; 20], proxy_hash: &[u8; 32]) -> ([u8; 20], u32, u8) {
    let mut best = ([0u8; 20], 0u32, 0u8);
    for (nonce, addr) in market_addrs(salt, market, proxy_hash).iter().enumerate() {
        let bits = zero_bits(addr);
        if nonce == 0 || bits > best.1 { best = (*addr, bits, nonce as u8); }
    }
    best
}

// The first 20 bytes of a salt of the kind being ground: Tacit's deployer, or the vanity market's shop.
fn prefix(kind: &Terms) -> [u8; 20] {
    match kind { Terms::CreateX => DEPLOYER, Terms::Market { shop, .. } => *shop }
}

// One salt tried: a share when its address has at least `min` zero bits (a market salt at its best nonce). `hashes`: the init code hashes of CreateX's proxy and
// the market's.
fn attempt(kind: &Terms, salt: &[u8; 32], hashes: &([u8; 32], [u8; 32]), min: u32) -> Option<Share> {
    match kind {
        Terms::CreateX => { let (_, bits) = address(salt, &hashes.0); (bits >= min).then(|| (*salt, bits, None)) }
        Terms::Market { market, .. } => { let (_, bits, nonce) = market_best(salt, market, &hashes.1); (bits >= min).then(|| (*salt, bits, Some(nonce))) }
    }
}

// No job in hand (the main loop's `job_since` is 0 between jobs).
fn idle() -> bool { BUSY.get().map_or(false, |b| b.load(Ordering::Relaxed) == 0) }

fn grind(seed: u64) {
    let hashes = (keccak(&[&PROXY_INIT]), keccak(&[&MARKET_PROXY_INIT]));
    let mut salt = [0u8; 32];
    let mut n: u64 = seed;
    loop {
        if !idle() { std::thread::sleep(Duration::from_secs(5)); continue; }
        let kind = terms();
        salt[..20].copy_from_slice(&prefix(&kind));
        salt[20] = 0;
        salt[21..23].copy_from_slice(&((day() % 65536) as u16).to_be_bytes());
        salt[23] = (seed >> 56) as u8;
        let min = MIN_BITS.load(Ordering::Relaxed) as u32;
        for _ in 0..(1u32 << 18) {
            n = n.wrapping_add(1);
            salt[24..32].copy_from_slice(&n.to_be_bytes());
            if let Some(share) = attempt(&kind, &salt, &hashes, min) { FOUND.lock().unwrap().push(share); }
        }
    }
}

// Once a minute: the share size the pool asks, then the shares found, best first. Tacit's own box sends the same shares: the pool gives
// them no weight (it earns nothing) but counts it among the nodes grinding now.
fn send(base: String, miner: String, name: String) {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).build();
    loop {
        std::thread::sleep(Duration::from_secs(60));
        if let Ok(v) = agent.get(&format!("{base}/prover/salt")).call().map_err(|e| e.to_string()).and_then(|r| r.into_json::<serde_json::Value>().map_err(|e| e.to_string())) {
            if let Some(b) = v["minBits"].as_u64().filter(|b| (16..=64).contains(b)) { MIN_BITS.store(b, Ordering::Relaxed); }
            // The kind of salt the pool asks for now: what was found for another kind is of no use to it, so it is dropped when the kind changes.
            let t = terms_from(&v);
            let mut cur = TERMS.lock().unwrap();
            if *cur != t { *cur = t; FOUND.lock().unwrap().clear(); }
        }
        let mut found = std::mem::take(&mut *FOUND.lock().unwrap());
        if found.is_empty() { continue; }
        found.sort_by(|a, b| b.1.cmp(&a.1));
        let rest = found.split_off(found.len().min(64));
        FOUND.lock().unwrap().extend(rest);
        let salts: Vec<String> = found.iter().map(share_str).collect();
        match agent.post(&format!("{base}/prover/salt/share")).send_json(serde_json::json!({ "miner": miner, "salts": salts })) {
            Ok(r) => {
                if let Ok(v) = r.into_json::<serde_json::Value>() { println!("[{name}] salts: {} shares counted", v["accepted"]); }
            }
            Err(ureq::Error::Status(429, _)) | Err(ureq::Error::Transport(_)) => FOUND.lock().unwrap().extend(found),
            Err(_) => {}
        }
    }
}

// Spare cores (SALT_THREADS, else half of them; 0 is off) and the sender. `busy`: the main loop's job-in-hand marker. `house`: Tacit's
// own box (the pool banks its salts and gives them no weight).
pub fn start(base: &str, miner: &str, name: &str, busy: Arc<AtomicU64>, house: bool) {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    let threads = std::env::var("SALT_THREADS").ok().and_then(|s| s.parse::<usize>().ok()).unwrap_or((cores / 2).max(1));
    if threads == 0 || BUSY.set(busy).is_err() { return; }
    let base_seed: u64 = rand::random();
    for t in 0..threads {
        let seed = (base_seed & 0x00ff_ffff_ffff_ffff) | ((t as u64 & 0xff) << 56);
        std::thread::Builder::new().name(format!("salt-{t}")).spawn(move || grind(seed)).ok();
    }
    let (base, miner, name) = (base.to_string(), miner.to_string(), name.to_string());
    std::thread::spawn(move || send(base, miner, name));
    println!("grinding salts on {threads} of {cores} cores between jobs{}", if house { ", for the bank" } else { "" });
}

#[cfg(test)]
mod tests {
    use super::*;
    const MARKET: &str = "000000000000b361194cfe6312ee3210d53c15aa";
    fn addr20(h: &str) -> [u8; 20] { hex::decode(h.trim_start_matches("0x")).unwrap().try_into().unwrap() }
    fn salt32(h: &str) -> [u8; 32] { hex::decode(h.trim_start_matches("0x")).unwrap().try_into().unwrap() }

    // VanityMarket.DEPLOY_PROXY_INITHASH, read from the market on mainnet.
    #[test]
    fn the_market_proxy_is_the_one_the_market_hashes() {
        assert_eq!(hex::encode(keccak(&[&MARKET_PROXY_INIT])), "1decbcf04b355d500cbc3bd83c892545b4df34bd5b2c9d91b9f7f8165e2095c3");
    }

    // VanityMarket.computeAddress(id, nonce) on mainnet.
    #[test]
    fn an_ids_addresses_are_the_ones_the_market_computes_at_every_nonce_tried() {
        let want = ["62fef3591b14074dde1dd2e1ddf1ec03a149a9af", "204d0c8327f70a3f2ec772ee2e45bceee6c876f2", "cd458f61f97f335ace31401f1fc5e0a6fa0ae75c", "6b3949315dbcd71972dba79bcaaf174dbd068bd6",
            "4bffe1ad0b6511680cff68fd0ccd63d6fceb0159", "f91a79421a3475a58bd897c922a4e1c713ab14d8", "1ae1f3363f8dddbb6aeebf4e6cb48cdee3f492bf", "5dbda460edd27aa7a005b7e5d3bebb986c0e6909"];
        let got = market_addrs(&salt32("68575b073de49a94e3e3acf6f3a0d6e3b66267c70051200123456789abcdef01"), &addr20(MARKET), &keccak(&[&MARKET_PROXY_INIT]));
        assert_eq!(NONCES as usize, want.len());
        for (n, w) in want.iter().enumerate() { assert_eq!(hex::encode(got[n]), *w, "nonce {n}"); }
    }

    #[test]
    fn the_best_nonce_is_the_one_with_most_zero_bits_and_the_lowest_among_equals() {
        let (market, hash) = (addr20(MARKET), keccak(&[&MARKET_PROXY_INIT]));
        let mut s = salt32(&format!("68575b073de49a94e3e3acf6f3a0d6e3b66267c7005120{}", "0".repeat(18)));
        for n in 0..2000u32 {
            s[28..32].copy_from_slice(&n.to_be_bytes());
            let all = market_addrs(&s, &market, &hash);
            let top = all.iter().map(zero_bits).max().unwrap();
            let first = all.iter().position(|a| zero_bits(a) == top).unwrap();
            assert_eq!(market_best(&s, &market, &hash), (all[first], top, first as u8));
        }
    }

    #[test]
    fn the_pool_chooses_the_kind_to_grind_by_the_first_scheme_it_names() {
        let shop = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let market = format!("0x{MARKET}");
        let t = |v: serde_json::Value| terms_from(&v);
        assert_eq!(t(serde_json::json!({ "minBits": 26 })), Terms::CreateX);
        assert_eq!(t(serde_json::json!({ "schemes": ["market", "createx"], "shop": shop, "market": market })), Terms::Market { shop: addr20(shop), market: addr20(MARKET) });
        assert_eq!(t(serde_json::json!({ "schemes": ["createx", "market"], "shop": shop, "market": market })), Terms::CreateX, "the first one is the one to grind");
        assert_eq!(t(serde_json::json!({ "schemes": ["market"], "market": market })), Terms::CreateX, "no shop");
        assert_eq!(t(serde_json::json!({ "schemes": ["market"], "shop": "0x12", "market": market })), Terms::CreateX, "a shop that is not an address");
        assert_eq!(t(serde_json::json!({ "schemes": [], "shop": shop, "market": market })), Terms::CreateX);
    }

    #[test]
    fn a_salt_leads_with_the_deployer_or_with_the_shop_by_the_kind_ground() {
        let shop = addr20("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        assert_eq!(prefix(&Terms::CreateX), addr20("68575b073de49a94e3e3acf6f3a0d6e3b66267c7"));
        assert_eq!(prefix(&Terms::Market { shop, market: addr20(MARKET) }), shop);
    }

    #[test]
    fn an_attempt_is_a_share_of_the_kind_ground_when_it_has_the_bits_and_not_otherwise() {
        let hashes = (keccak(&[&PROXY_INIT]), keccak(&[&MARKET_PROXY_INIT]));
        let shop = addr20("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let kind = Terms::Market { shop, market: addr20(MARKET) };
        let mut s = [0u8; 32];
        s[..20].copy_from_slice(&shop);
        s[24..32].copy_from_slice(&7u64.to_be_bytes());
        let (_, bits, nonce) = market_best(&s, &addr20(MARKET), &hashes.1);
        assert_eq!(attempt(&kind, &s, &hashes, bits), Some((s, bits, Some(nonce))), "a market salt carries its nonce");
        assert_eq!(attempt(&kind, &s, &hashes, bits + 1), None, "and one under the bar is nothing");
        s[..20].copy_from_slice(&prefix(&Terms::CreateX));
        let (_, cbits) = address(&s, &hashes.0);
        assert_eq!(attempt(&Terms::CreateX, &s, &hashes, cbits), Some((s, cbits, None)), "a CreateX salt carries none");
        assert_eq!(attempt(&Terms::CreateX, &s, &hashes, cbits + 1), None);
    }

    #[test]
    fn a_share_is_spelled_as_the_pool_reads_it() {
        let s = salt32("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa00012c0000000000000001ab");
        assert_eq!(share_str(&(s, 30, None)), format!("0x{}", hex::encode(s)));
        assert_eq!(share_str(&(s, 30, Some(7))), format!("0x{}:7", hex::encode(s)));
    }

    // contracts/deployments/launch-v1-final.env: the EthCallOutbox's salt and where CreateX put it.
    #[test]
    fn address_is_where_createx_deployed() {
        let mut salt = [0u8; 32];
        salt.copy_from_slice(&hex::decode("68575b073de49a94e3e3acf6f3a0d6e3b66267c7000326fb99fa8e9a005a64b9").unwrap());
        let (a, bits) = address(&salt, &keccak(&[&PROXY_INIT]));
        assert_eq!(hex::encode(a), "00000000a26a6e291972666a9687741dba11af46");
        assert_eq!(bits, 32);
    }
}
