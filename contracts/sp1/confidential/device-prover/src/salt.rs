// Salt mining between proofs. While mining is on (POST /mine), nothing is being proved and the computer is on the charger, a few cores (gentle.rs: a quarter by
// default, at the lowest priority) grind CreateX CREATE3 salts that
// only Tacit's deployer can use, and the shares go to the API's salt pool (POST /prover/salt/share, worker/src/salt-pool.js), the best first,
// as often as the pool takes them, for the same address the proofs pay. A proof always comes first: the grinding stops while one runs and starts again after it.
//
// A salt is the deployer's address, 0x00 (CreateX guards it as keccak256(pad32(deployer) ‖ salt), so only the deployer can deploy with it,
// at the same address on every chain), the UTC day (2 bytes) and 9 bytes ground here. Its address is CreateX's CREATE3: a proxy at
// CREATE2(CreateX, guarded salt, the proxy's init code hash), which creates the contract at its nonce 1. A share's address starts with at
// least as many zero bits as the pool asks (GET /prover/salt minBits).
//
// The pool can ask for another kind of salt (GET /prover/salt `schemes`, the first the one to grind): one for the vanity-address market, the same layout
// with the shop's address (`shop`) in place of the deployer's. The market (`market`) fixes its address as the contract its deploy proxy, CREATE2(market, id,
// the proxy's init code hash), creates at transaction `nonce + 1`; the token's nonce is free, so each id is tried at the first NONCES of them (one more hash
// each, the proxy's address being the same) and the best is the share, sent as `0x<id>:<nonce>`. Without a `schemes` that starts with `market` and the
// addresses of its shop and market, the grinding is CreateX's as before.
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tiny_keccak::{Hasher, Keccak};
use crate::gentle;

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

pub static PROVING: AtomicBool = AtomicBool::new(false);
static HASHES: AtomicU64 = AtomicU64::new(0);
static THREADS: AtomicUsize = AtomicUsize::new(0);
static MIN_BITS: AtomicU64 = AtomicU64::new(26);
static FOUND: Mutex<Vec<Share>> = Mutex::new(Vec::new());
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

fn parse_addr(v: &Value) -> Option<[u8; 20]> {
    let s = v.as_str()?.strip_prefix("0x")?;
    let b = hex::decode(s).ok()?;
    b.try_into().ok()
}

// The terms the pool's GET /prover/salt gives: market salts only when its first scheme is `market` and it names both addresses, else CreateX's.
pub fn terms_from(v: &Value) -> Terms {
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

fn active() -> bool { gentle::grind_allowed(crate::pool::miner().is_some(), PROVING.load(Ordering::Relaxed), gentle::on_battery(), gentle::allow_battery()) }

fn grind(seed: u64) {
    if gentle::background_wanted() { gentle::lower_priority(); }   // this thread only: proving keeps its priority
    let hashes = (keccak(&[&PROXY_INIT]), keccak(&[&MARKET_PROXY_INIT]));
    let mut salt = [0u8; 32];
    let mut n: u64 = seed;
    loop {
        if !active() { std::thread::sleep(Duration::from_secs(5)); continue; }
        let d = day();
        let kind = terms();
        salt[..20].copy_from_slice(&prefix(&kind));
        salt[20] = 0;
        salt[21..23].copy_from_slice(&((d % 65536) as u16).to_be_bytes());
        salt[23] = (seed >> 56) as u8;
        let min = MIN_BITS.load(Ordering::Relaxed) as u32;
        for _ in 0..(1u32 << 18) {
            n = n.wrapping_add(1);
            salt[24..32].copy_from_slice(&n.to_be_bytes());
            if let Some(share) = attempt(&kind, &salt, &hashes, min) { FOUND.lock().unwrap().push(share); }
        }
        HASHES.fetch_add((1u64 << 18) * if matches!(kind, Terms::Market { .. }) { NONCES as u64 } else { 1 }, Ordering::Relaxed);
    }
}

// The name this miner goes by in the salt pool: the prover and the release it was built as (the release workflow sets TACIT_RELEASE, a build of anything else says
// `dev`). Sent with every share and as the User-Agent, so the pool can tell which programs are mining; it is what the program says of itself, nothing more.
fn client_label(release: Option<&str>) -> String {
    let r = release.unwrap_or("dev").trim().trim_start_matches("tacit-prover-");
    let clean: String = r.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+')).take(24).collect();
    format!("tacit-prover/{}", if clean.is_empty() { "dev" } else { &clean })
}
fn client_name() -> &'static str {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| client_label(option_env!("TACIT_RELEASE")))
}

fn http() -> Option<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder().timeout(Duration::from_secs(20)).user_agent(client_name()).build().ok()
}
fn api() -> String { std::env::var("TACIT_API").unwrap_or_else(|_| "https://api.tacit.finance".into()) }

// The pool takes up to SEND_MAX salts in one send, and one send every 20 s from a connection: sending every SEND_EVERY uses all of it. Every
// extra zero bit doubles a share's weight, so when more are found than one send carries, the best go first and the weakest wait. At most
// KEEP_MAX wait (the weakest beyond that are dropped), and only from today or yesterday, the two days the pool still counts.
const SEND_MAX: usize = 64;
const KEEP_MAX: usize = 640;
const SEND_EVERY: Duration = Duration::from_secs(21);

// A share: the salt, its zero bits, and for a market salt the nonce its address is at.
type Share = ([u8; 32], u32, Option<u8>);

// The pool's spelling of a share: the salt, and for a market salt `:<nonce>`.
fn share_str(sh: &Share) -> String { format!("0x{}{}", hex::encode(sh.0), sh.2.map(|n| format!(":{n}")).unwrap_or_default()) }

// The next send from what has been found (best first), and what waits for the sends after it.
fn next_batch(mut found: Vec<Share>, today: u64) -> (Vec<Share>, Vec<Share>) {
    let (d0, d1) = ((today % 65536) as u16, ((today + 65535) % 65536) as u16);
    found.retain(|(s, _, _)| { let d = u16::from_be_bytes([s[21], s[22]]); d == d0 || d == d1 });
    found.sort_by(|a, b| b.1.cmp(&a.1));
    found.truncate(SEND_MAX + KEEP_MAX);
    let rest = found.split_off(found.len().min(SEND_MAX));
    (found, rest)
}

// Up to 3 s more than `d`, at random: two provers behind one connection drift apart instead of meeting on every send.
fn jitter(d: Duration) -> Duration { d + Duration::from_millis(rand::random::<u64>() % 3000) }

// About every SEND_EVERY: the shares found, best first, for the address mining pays; about once a minute, the share size the pool asks.
fn send() {
    let Some(http) = http() else { return };
    let mut round: u64 = 0;
    let mut wait = jitter(SEND_EVERY);
    loop {
        std::thread::sleep(wait);
        wait = jitter(SEND_EVERY);
        round += 1;
        gentle::set_on_battery(!crate::helpdesk::on_ac());   // the grinding threads read this, so a pmset or /sys read is not on their path
        {
            let mut r = RATE.lock().unwrap();
            let h = HASHES.load(Ordering::Relaxed);
            if let Some((t, last)) = r.1 { r.0 = (h - last) as f64 / t.elapsed().as_secs_f64().max(1.0); }
            r.1 = Some((Instant::now(), h));
        }
        if round % 3 == 1 {
            if let Ok(v) = http.get(format!("{}/prover/salt", api())).send().and_then(|r| r.json::<Value>()) {
                if let Some(b) = v["minBits"].as_u64().filter(|b| (16..=64).contains(b)) { MIN_BITS.store(b, Ordering::Relaxed); }
                // The kind of salt the pool asks for now: what was found for another kind is of no use to it, so it is dropped when the kind changes.
                let t = terms_from(&v);
                let mut cur = TERMS.lock().unwrap();
                if *cur != t { *cur = t; FOUND.lock().unwrap().clear(); }
            }
        }
        let Some(miner) = crate::pool::miner() else { continue };
        let all = std::mem::take(&mut *FOUND.lock().unwrap());
        if all.is_empty() { continue; }
        let (found, rest) = next_batch(all, day());
        FOUND.lock().unwrap().extend(rest);
        if found.is_empty() { continue; }
        let salts: Vec<String> = found.iter().map(share_str).collect();
        match http.post(format!("{}/prover/salt/share", api())).json(&json!({ "miner": miner, "salts": salts, "client": client_name() })).send() {
            Ok(r) if r.status().as_u16() == 429 => {
                // the connection sent less than 20 s ago (another prover behind it, say): the shares wait, and the next try is when the pool says
                let ms = r.json::<Value>().ok().and_then(|v| v["retryMs"].as_u64()).unwrap_or(5000).min(60_000);
                wait = jitter(Duration::from_millis(ms));
                FOUND.lock().unwrap().extend(found);
            }
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

// A few cores (TACIT_SALT_THREADS, else a quarter of them; 0 is off) and the sender.
pub fn start() {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    let threads = std::env::var("TACIT_SALT_THREADS").ok().and_then(|s| s.parse::<usize>().ok()).unwrap_or(gentle::default_threads(cores));
    THREADS.store(threads, Ordering::Relaxed);
    if threads == 0 { return; }
    gentle::set_on_battery(!crate::helpdesk::on_ac());
    let base: u64 = rand::random();
    for t in 0..threads {
        let seed = (base & 0x00ff_ffff_ffff_ffff) | ((t as u64 & 0xff) << 56);
        std::thread::Builder::new().name(format!("salt-{t}")).spawn(move || grind(seed)).ok();
    }
    std::thread::spawn(send);
    eprintln!("tacit-prover: grinding salts on {threads} of {cores} cores between proofs, {}{}",
        if gentle::background_wanted() { "at the lowest priority" } else { "at normal priority" }, if gentle::allow_battery() { "" } else { ", only on the charger" });
}

// For GET /mine: whether the cores are grinding, how fast, and what the pool counted today.
pub fn status() -> Value {
    let t = TODAY.lock().unwrap().clone().filter(|v| v["day"].as_u64() == Some(day()));
    let paused = gentle::paused_for(crate::pool::miner().is_some(), PROVING.load(Ordering::Relaxed), gentle::on_battery(), gentle::allow_battery());
    json!({ "on": active(), "rate": RATE.lock().unwrap().0.round(), "minBits": MIN_BITS.load(Ordering::Relaxed), "scheme": if matches!(terms(), Terms::Market { .. }) { "market" } else { "createx" }, "today": t.map(|v| v["today"].clone()),
        "threads": THREADS.load(Ordering::Relaxed), "background": gentle::background_wanted(), "pausedFor": paused })
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

    const MARKET: &str = "000000000000b361194cfe6312ee3210d53c15aa";
    fn addr20(h: &str) -> [u8; 20] { hex::decode(h.trim_start_matches("0x")).unwrap().try_into().unwrap() }
    fn salt32(h: &str) -> [u8; 32] { hex::decode(h.trim_start_matches("0x")).unwrap().try_into().unwrap() }

    // VanityMarket.DEPLOY_PROXY_INITHASH, read from the market on mainnet.
    #[test]
    fn the_market_proxy_is_the_one_the_market_hashes() {
        assert_eq!(hex::encode(keccak(&[&MARKET_PROXY_INIT])), "1decbcf04b355d500cbc3bd83c892545b4df34bd5b2c9d91b9f7f8165e2095c3");
    }

    // VanityMarket.computeAddress(id, nonce) on mainnet (tests/fixtures/vanity-market-vectors.txt holds more, and tests/salt-pool.test.mjs checks the pool's side).
    #[test]
    fn an_ids_addresses_are_the_ones_the_market_computes_at_every_nonce_tried() {
        let want = ["62fef3591b14074dde1dd2e1ddf1ec03a149a9af", "204d0c8327f70a3f2ec772ee2e45bceee6c876f2", "cd458f61f97f335ace31401f1fc5e0a6fa0ae75c", "6b3949315dbcd71972dba79bcaaf174dbd068bd6",
            "4bffe1ad0b6511680cff68fd0ccd63d6fceb0159", "f91a79421a3475a58bd897c922a4e1c713ab14d8", "1ae1f3363f8dddbb6aeebf4e6cb48cdee3f492bf", "5dbda460edd27aa7a005b7e5d3bebb986c0e6909"];
        let got = market_addrs(&salt32("68575b073de49a94e3e3acf6f3a0d6e3b66267c70051200123456789abcdef01"), &addr20(MARKET), &keccak(&[&MARKET_PROXY_INIT]));
        assert_eq!(NONCES as usize, want.len());
        for (n, w) in want.iter().enumerate() { assert_eq!(hex::encode(got[n]), *w, "nonce {n}"); }
        // another id and nonces 0 and 1 (mainnet: 0x…ff → 7bb5fe00…, bcf48320…)
        let b = market_addrs(&salt32("00000000000000000000000000000000000000000000000000000000000000ff"), &addr20(MARKET), &keccak(&[&MARKET_PROXY_INIT]));
        assert_eq!(hex::encode(b[0]), "7bb5fe004ab6521f5d2a4ab08fd5f29383a50a95");
        assert_eq!(hex::encode(b[1]), "bcf483208db5ef92a7ed6f8dda1dbf90e0766525");
    }

    #[test]
    fn the_best_nonce_is_the_one_with_most_zero_bits_and_the_lowest_among_equals() {
        let (market, hash) = (addr20(MARKET), keccak(&[&MARKET_PROXY_INIT]));
        let mut s = salt32("68575b073de49a94e3e3acf6f3a0d6e3b66267c7005120000000000000000000");
        let mut checked = 0;
        for n in 0..2000u32 {
            s[28..32].copy_from_slice(&n.to_be_bytes());
            let all = market_addrs(&s, &market, &hash);
            let top = all.iter().map(zero_bits).max().unwrap();
            let first = all.iter().position(|a| zero_bits(a) == top).unwrap();
            let (addr, bits, nonce) = market_best(&s, &market, &hash);
            assert_eq!((bits, nonce as usize, addr), (top, first, all[first]));
            checked += 1;
        }
        assert_eq!(checked, 2000);
    }

    #[test]
    fn the_pool_chooses_the_kind_to_grind_by_the_first_scheme_it_names() {
        let shop = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let market = format!("0x{MARKET}");
        let t = |v: Value| terms_from(&v);
        assert_eq!(t(json!({ "minBits": 26 })), Terms::CreateX, "a pool that says nothing of kinds is CreateX's");
        assert_eq!(t(json!({ "schemes": ["createx"] })), Terms::CreateX);
        assert_eq!(t(json!({ "schemes": ["market", "createx"], "shop": shop, "market": market })), Terms::Market { shop: addr20(shop), market: addr20(MARKET) });
        assert_eq!(t(json!({ "schemes": ["market"], "shop": shop, "market": market })), Terms::Market { shop: addr20(shop), market: addr20(MARKET) });
        assert_eq!(t(json!({ "schemes": ["createx", "market"], "shop": shop, "market": market })), Terms::CreateX, "the first one is the one to grind");
        assert_eq!(t(json!({ "schemes": ["market"], "market": market })), Terms::CreateX, "no shop");
        assert_eq!(t(json!({ "schemes": ["market"], "shop": shop })), Terms::CreateX, "no market");
        assert_eq!(t(json!({ "schemes": ["market"], "shop": "0x12", "market": market })), Terms::CreateX, "a shop that is not an address");
        assert_eq!(t(json!({ "schemes": ["market"], "shop": "zz".repeat(20), "market": market })), Terms::CreateX);
        assert_eq!(t(json!({ "schemes": ["nonsense"], "shop": shop, "market": market })), Terms::CreateX);
        assert_eq!(t(json!({ "schemes": [], "shop": shop, "market": market })), Terms::CreateX);
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
        assert_eq!(share_str(&(s, 30, Some(0))), format!("0x{}:0", hex::encode(s)));
        assert_eq!(share_str(&(s, 30, Some(7))), format!("0x{}:7", hex::encode(s)));
    }

    #[test]
    fn a_nonce_share_keeps_its_nonce_through_the_queue() {
        let today = 20767;
        let mut a = share(today, 1, 30);
        a.2 = Some(5);
        let (send, wait) = next_batch(vec![share(today, 2, 26), a, share(today, 3, 28)], today);
        assert!(wait.is_empty());
        assert_eq!(send[0].2, Some(5), "the best goes first with its nonce");
    }

    fn share(day: u64, n: u32, bits: u32) -> Share {
        let mut s = [0u8; 32];
        s[21..23].copy_from_slice(&((day % 65536) as u16).to_be_bytes());
        s[28..32].copy_from_slice(&n.to_be_bytes());
        (s, bits, None)
    }

    #[test]
    fn a_send_carries_the_best_and_the_rest_wait() {
        let today = 20767;
        let found: Vec<Share> = (0..200).map(|n| share(today, n, 26 + n % 9)).collect();
        let (send, wait) = next_batch(found, today);
        assert_eq!(send.len(), SEND_MAX);
        assert_eq!(wait.len(), 200 - SEND_MAX);
        assert!(send.windows(2).all(|w| w[0].1 >= w[1].1), "best first");
        assert!(send.last().unwrap().1 >= wait.first().unwrap().1, "nothing waiting beats what is sent");
    }

    #[test]
    fn the_backlog_is_capped_and_keeps_only_days_the_pool_counts() {
        let today = 20767;
        let mut found: Vec<Share> = (0..2000).map(|n| share(today, n, 26)).collect();
        found.push(share(today - 1, 1, 40)); // yesterday still counts
        found.push(share(today - 2, 2, 50)); // two days back is refused by the pool
        let (send, wait) = next_batch(found, today);
        assert_eq!(send[0].1, 40, "yesterday's best goes first");
        assert!(send.iter().chain(wait.iter()).all(|(_, b, _)| *b != 50), "an old day is dropped, however good");
        assert_eq!(wait.len(), KEEP_MAX);
        let (send, _) = next_batch(vec![share(65536, 1, 30), share(65535, 2, 29)], 65536);
        assert_eq!(send.len(), 2, "yesterday across the two-byte wrap");
    }

    #[test]
    fn the_miner_names_itself_after_its_release() {
        assert_eq!(client_label(Some("tacit-prover-v0.6.4")), "tacit-prover/v0.6.4");
        assert_eq!(client_label(Some("v0.7.0")), "tacit-prover/v0.7.0");
        assert_eq!(client_label(None), "tacit-prover/dev", "a build that is not a release says dev");
        assert_eq!(client_label(Some("")), "tacit-prover/dev");
        assert_eq!(client_label(Some("tacit-prover-")), "tacit-prover/dev");
        assert_eq!(client_label(Some("v1 <b>x</b>\n")), "tacit-prover/v1bxb", "only letters, digits and . - _ + are kept");
        assert!(client_label(Some(&"9".repeat(200))).len() <= "tacit-prover/".len() + 24, "and it is cut short");
    }

    #[test]
    fn sends_keep_inside_the_pool_window() {
        for _ in 0..1000 {
            let w = jitter(SEND_EVERY);
            assert!(w >= Duration::from_secs(21) && w < Duration::from_secs(24), "never sooner than the pool's 20 s, never much later");
        }
    }
}
