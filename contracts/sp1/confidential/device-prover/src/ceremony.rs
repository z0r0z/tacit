// ceremony.rs: once, this machine adds a contribution to the Tacit Praxis ceremony (ceremony-phase2/README.md), for the ceremony's
// points to the mining address.
//
// While mining is on and the ceremony is open, the prover takes one turn away from the proof pool: it finishes the pool job it has,
// leases no other, and runs the ceremony's own tool (tacit-ceremony contribute, in the pool lane, so it waits behind every person in
// the ceremony's queue), with the mining address as its handle. The tool downloads the head (about 1 GB), adds fresh randomness
// that is dropped when it exits, uploads the result and checks the coordinator's signed receipt; then mining carries on as before.
// A proof of the owner's own comes first: one that starts or waits stops the contribution (the tool gives up its place cleanly),
// and it is tried again later. It needs about 16 GB of memory and 3 GB of free disk, and is skipped on battery.
//
// The tool is fetched from the ceremony's release and checked against the SHA-256 pinned here; the coordinator's key is pinned too
// (the tool checks the receipt against it). Only the coordinator's address is read at run time, from the ceremony's HTTPS window
// (GET /api/coordinator), so the coordinator can move without a new release of this program.
//
// Files (in ~/.tacit-prover): ceremony.json ({on}: absent means on while mining), ceremony/done.json (the receipt once accepted: then
// never again), ceremony/tacit-ceremony (the tool), ceremony/log (its output). Env: TACIT_CEREMONY=0 (never), TACIT_CEREMONY_INFO
// (another https window, for testing).
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const INFO: &str = "https://tacit-praxis-ceremony.onrender.com/api/coordinator";
const KEY: &str = "c22b59ae8acf7a1c2b78c4da8cfd2a3e7a21f2d2809a4d35e3a71e0fd2052eb7";
const RELEASE: &str = "https://github.com/z0r0z/tacit/releases/download/ceremony-v1.0.0";
// SHA256SUMS of the release (built reproducibly by ceremony-phase2/release.sh at 01dae294cbe9)
const TOOLS: &[(&str, &str, &str)] = &[
    ("macos", "aarch64", "66ef7c24c5e3abe2d40033bfb0af5df0cf4ce10aab7263be6520fbc8084dc3a9"),
    ("macos", "x86_64", "cff5220333784e7b1efaa7b94262efca69213ac14266ba8b3ca59fe5b9a2fac1"),
    ("linux", "x86_64", "89026fa99c125017d89f21e99652264134903b505b410d6287381c09f2e26938"),
    ("linux", "aarch64", "1c79e15730bc1f00823c10cacca3829454e7eb65b177d81e24b9831cd50045bd"),
];
const MIN_RAM: u64 = 15 << 30; // a 16 GB machine reports a little under 16 GiB
const MIN_DISK: u64 = 3 << 30;
const RETRY: Duration = Duration::from_secs(3600);

pub struct Ctx {
    pub dir: PathBuf,
    pub miner: Box<dyn Fn() -> Option<String> + Send + Sync>,
    pub owner_busy: Arc<dyn Fn() -> bool + Send + Sync>, // a proof of the owner's own is running or waiting
    pub pool_busy: Arc<dyn Fn() -> bool + Send + Sync>,  // a pool job is being proved
    pub ram: Option<u64>,
}

// The mining loop leases no pool job while this is set: the ceremony is waiting for the current one to end, or running.
static WANTS: AtomicBool = AtomicBool::new(false);
static STATE: Mutex<(&'static str, Option<String>)> = Mutex::new(("idle", None));
pub fn wants_turn() -> bool { WANTS.load(Ordering::Relaxed) }

fn set_state(s: &'static str, err: Option<String>) { *STATE.lock().unwrap() = (s, err); }

fn tool_for(os: &str, arch: &str) -> Option<(String, &'static str)> {
    let (_, _, sha) = TOOLS.iter().find(|(o, a, _)| *o == os && *a == arch)?;
    let name = format!("tacit-ceremony-{}-{}", if os == "macos" { "darwin" } else { "linux" }, if arch == "aarch64" { "arm64" } else { "amd64" });
    Some((name, sha))
}

pub fn enabled(dir: &Path) -> bool {
    if std::env::var("TACIT_CEREMONY").as_deref() == Ok("0") { return false; }
    let s: Value = std::fs::read(dir.join("ceremony.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
    s["on"].as_bool().unwrap_or(true)
}
pub fn set(dir: &Path, on: bool) -> Result<(), String> {
    let _ = std::fs::create_dir_all(dir);
    std::fs::write(dir.join("ceremony.json"), json!({ "on": on }).to_string()).map_err(|e| e.to_string())
}
fn done(dir: &Path) -> Option<Value> {
    std::fs::read(dir.join("ceremony").join("done.json")).ok().and_then(|b| serde_json::from_slice(&b).ok())
}
pub fn status(dir: &Path) -> Value {
    let (state, err) = STATE.lock().unwrap().clone();
    json!({ "on": enabled(dir), "state": if done(dir).is_some() { "done" } else { state }, "receipt": done(dir), "error": err })
}

fn disk_free(dir: &Path) -> Option<u64> {
    let out = Command::new("df").arg("-k").arg(dir).output().ok()?;
    let line = String::from_utf8(out.stdout).ok()?.lines().nth(1)?.to_string();
    Some(line.split_whitespace().nth(3)?.parse::<u64>().ok()? * 1024)
}

// Why the machine should not take its turn now, or None.
pub fn blocked(enabled: bool, done: bool, miner: bool, ram: Option<u64>, disk: Option<u64>, battery: bool) -> Option<&'static str> {
    if !enabled { return Some("switched off") }
    if done { return Some("already contributed") }
    if !miner { return Some("mining is off") }
    if ram.map_or(true, |r| r < MIN_RAM) { return Some("needs about 16 GB of memory") }
    if disk.map_or(true, |d| d < MIN_DISK) { return Some("needs about 3 GB of free disk") }
    if battery { return Some("on battery") }
    None
}

fn info() -> Result<(String, u64), String> {
    let url = std::env::var("TACIT_CEREMONY_INFO").ok().filter(|u| u.starts_with("https://")).unwrap_or_else(|| INFO.into());
    let v: Value = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?
        .get(url).send().map_err(|e| e.to_string())?.json().map_err(|e| e.to_string())?;
    if v["open"].as_bool() != Some(true) { return Err("the ceremony is not open".into()) }
    let c = v["coordinator"].as_str().unwrap_or("").trim_end_matches('/').to_string();
    if !(c.starts_with("http://") || c.starts_with("https://")) || c.contains(char::is_whitespace) { return Err("no coordinator address".into()) }
    Ok((c, v["queue"].as_u64().unwrap_or(0)))
}

// The tool, fetched once and checked against the pinned hash (a file already here is checked again before each use).
fn tool(dir: &Path) -> Result<PathBuf, String> {
    let (name, sha) = tool_for(std::env::consts::OS, std::env::consts::ARCH).ok_or("no ceremony tool for this platform")?;
    let path = dir.join("tacit-ceremony");
    let ok = |p: &Path| std::fs::read(p).map(|b| hex::encode(Sha256::digest(&b)) == sha).unwrap_or(false);
    if !ok(&path) {
        let bytes = reqwest::blocking::Client::builder().timeout(Duration::from_secs(300)).build().map_err(|e| e.to_string())?
            .get(format!("{RELEASE}/{name}")).send().and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?
            .bytes().map_err(|e| e.to_string())?;
        if hex::encode(Sha256::digest(&bytes)) != sha { return Err("the ceremony tool does not match its pinned hash".into()) }
        let tmp = dir.join("tacit-ceremony.tmp");
        std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    }
    if !ok(&path) { return Err("the ceremony tool does not match its pinned hash".into()) }
    Ok(path)
}

fn terminate(pid: u32) {
    // SIGTERM, so the tool gives up its place in the queue and removes its files
    let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
}

// One contribution: Ok(receipt) when accepted, Err(why) otherwise (Err("stopped") when a proof of the owner's came first).
fn contribute(ctx: &Ctx, miner: &str, coordinator: &str) -> Result<Value, String> {
    let dir = ctx.dir.join("ceremony");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    set_state("fetching", None);
    let exe = tool(&dir)?;
    let log = std::fs::File::create(dir.join("log")).map_err(|e| e.to_string())?;
    set_state("contributing", None);
    let mut child = Command::new(&exe)
        .args(["contribute", "--coordinator", coordinator, "--coordinator-key", KEY, "--name", "tacit-prover", "--handle", miner, "--lane", "pool"])
        .arg("--workdir").arg(&dir).arg("--receipt-dir").arg(&dir)
        .stdin(Stdio::null()).stdout(log.try_clone().map_err(|e| e.to_string())?).stderr(log)
        .spawn().map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
            if !st.success() { return Err(format!("the ceremony tool exited with {st}; see ceremony/log")) }
            break;
        }
        if (ctx.owner_busy)() || !enabled(&ctx.dir) || started.elapsed() > Duration::from_secs(4 * 3600) {
            terminate(child.id());
            let _ = child.wait();
            return Err("stopped".into());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    // the receipt the tool saved (it checked the signature, the hash and the head before saving it)
    let receipt = std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("receipt-"))
        .filter_map(|e| std::fs::read(e.path()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()))
        .find(|r| r["handle"].as_str() == Some(miner))
        .ok_or("no receipt was saved")?;
    std::fs::write(dir.join("done.json"), receipt.to_string()).map_err(|e| e.to_string())?;
    Ok(receipt)
}

pub fn start(ctx: Ctx) {
    std::thread::Builder::new().name("ceremony".into()).spawn(move || {
        let mut next_try = Instant::now() + Duration::from_secs(60);
        loop {
            std::thread::sleep(Duration::from_secs(5));
            let miner = (ctx.miner)();
            let why = blocked(enabled(&ctx.dir), done(&ctx.dir).is_some(), miner.is_some(), ctx.ram, disk_free(&ctx.dir), crate::gentle::on_battery());
            if let Some(w) = why {
                WANTS.store(false, Ordering::Relaxed);
                set_state("idle", Some(w.into()));
                continue;
            }
            if Instant::now() < next_try || (ctx.owner_busy)() { WANTS.store(false, Ordering::Relaxed); continue; }
            let (coordinator, _queue) = match info() {
                Ok(i) => i,
                Err(e) => { set_state("idle", Some(e)); next_try = Instant::now() + Duration::from_secs(600); continue; }
            };
            // take the turn: no new pool job; start once the current one is done
            WANTS.store(true, Ordering::Relaxed);
            set_state("waiting for the pool job to finish", None);
            while (ctx.pool_busy)() && !(ctx.owner_busy)() { std::thread::sleep(Duration::from_secs(2)); }
            if (ctx.owner_busy)() { WANTS.store(false, Ordering::Relaxed); continue; }
            let r = contribute(&ctx, miner.as_deref().unwrap_or_default(), &coordinator);
            WANTS.store(false, Ordering::Relaxed);
            match r {
                Ok(rc) => { eprintln!("tacit-prover: ceremony contribution accepted as phase2-{}", rc["index"]); set_state("done", None); }
                Err(e) => {
                    eprintln!("tacit-prover: ceremony contribution not made: {e}");
                    set_state("idle", Some(e.clone()));
                    next_try = Instant::now() + if e == "stopped" { Duration::from_secs(900) } else { RETRY };
                }
            }
        }
    }).expect("ceremony thread");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn eligibility() {
        let gb = |n: u64| Some(n << 30);
        assert_eq!(blocked(true, false, true, gb(16), gb(10), false), None);
        assert_eq!(blocked(false, false, true, gb(16), gb(10), false), Some("switched off"));
        assert_eq!(blocked(true, true, true, gb(16), gb(10), false), Some("already contributed"));
        assert_eq!(blocked(true, false, false, gb(16), gb(10), false), Some("mining is off"));
        assert_eq!(blocked(true, false, true, gb(8), gb(10), false), Some("needs about 16 GB of memory"));
        assert_eq!(blocked(true, false, true, Some(17_179_869_184 - (512 << 20)), gb(10), false), None, "a 16 GB machine qualifies");
        assert_eq!(blocked(true, false, true, gb(16), gb(2), false), Some("needs about 3 GB of free disk"));
        assert_eq!(blocked(true, false, true, gb(16), gb(10), true), Some("on battery"));
        assert_eq!(blocked(true, false, true, None, gb(10), false), Some("needs about 16 GB of memory"));
    }
    #[test]
    fn tools_pinned_per_platform() {
        assert_eq!(tool_for("macos", "aarch64").unwrap().0, "tacit-ceremony-darwin-arm64");
        assert_eq!(tool_for("linux", "x86_64").unwrap().0, "tacit-ceremony-linux-amd64");
        assert!(tool_for("windows", "x86_64").is_none());
        for (_, _, sha) in TOOLS { assert_eq!(sha.len(), 64); }
    }
}
