// helpdesk.rs: lends this computer's idle time to the community help desk.
//
// While the prover has nothing to prove and the computer is idle, plugged in and its owner away, a small local model (llama.cpp's
// llama-server) answers the questions and code-check windows the help desk hands out, one at a time. It follows the proof pool's
// pattern: lease a job over HTTPS, do it, submit the result; the API knows who answered, so it can check nodes with questions
// whose answers it knows and credit the address with points.
//
// A proof always comes first. The model is started only when there is work, and is stopped the moment a proof starts or waits
// (its memory is wanted), when the owner comes back, or after 15 minutes without work. It is off unless switched on
// (POST /helpdesk {on, api}, or TACIT_HELPDESK=1 with TACIT_HELPDESK_API), and it needs the address that mining uses: the points
// go there. Prompts and answers are public documentation text and a visitor's question; the model sees nothing else.
//
// Files (in the prover's directory, ~/.tacit-prover): helpdesk.json (on, api), helpdesk/llama-server and helpdesk/model.gguf
// (put there by dapp/helpdesk-fetch.sh, or point TACIT_HELPDESK_LLAMA and TACIT_HELPDESK_MODEL at them), helpdesk/llama.pid.
//
// Env: TACIT_HELPDESK=1, TACIT_HELPDESK_API (the help desk's https:// address, or http://127.0.0.1 for testing), TACIT_HELPDESK_APIS (more hosts allowed), TACIT_HELPDESK_IDLE_SECS (300: no keyboard
// or mouse for this long), TACIT_HELPDESK_ALWAYS=1 (ignore the idle and power checks), TACIT_HELPDESK_CTX (4096),
// TACIT_HELPDESK_UNLOAD_SECS (900).
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct Ctx {
    pub dir: PathBuf,                                         // the prover's directory
    pub miner: Box<dyn Fn() -> Option<String> + Send + Sync>, // the address the points go to; None: not taking part
    pub busy: Arc<dyn Fn() -> bool + Send + Sync>,            // a proof is running or waiting
}

pub static DONE: AtomicU64 = AtomicU64::new(0);
pub static NOW: Mutex<Option<(String, Instant)>> = Mutex::new(None);
static LLM_UP: AtomicBool = AtomicBool::new(false);
// The model's process id while it runs. The guard thread (below) kills it the moment a proof starts or waits, whatever the main loop is doing
// (it can sit in a long poll for 20 s), and clears this; the main loop notices the process is gone.
static LLM_PID: Mutex<Option<u32>> = Mutex::new(None);

const MODEL_ID: &str = "qwen3.5-4b-q4_k_m";   // what this node says it runs; the API only hands out jobs a model like this can do
const MAX_JOB: usize = 24_000;                  // bytes of messages accepted
const MAX_REPLY: usize = 16_000;                // bytes of answer sent back

// ---- settings
fn setting(dir: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(dir.join("helpdesk.json")).ok()?).ok()
}
// The help desk's address is set by the page (tacit.finance/prove/), so it is held to the help desk's own hosts: a page, or a program that can call
// this machine's API, cannot point the idle time at another server. TACIT_HELPDESK_APIS adds hosts (a comma list, for a help desk of your own);
// http is for this machine only, to test against one.
const API_HOSTS: &[&str] = &["tacit-helpdesk.onrender.com", "help.tacit.finance"];
fn api_ok_with(u: &str, extra: &[String]) -> bool {
    let u = u.trim();
    let Some((scheme, rest)) = u.split_once("://") else { return false };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    let host = match authority.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => h,
        Some(_) => return false,
        None => authority,
    };
    let host = host.to_ascii_lowercase();
    match scheme.to_ascii_lowercase().as_str() {
        "https" => API_HOSTS.contains(&host.as_str()) || extra.iter().any(|e| e == &host),
        "http" => host == "127.0.0.1" || host == "localhost",
        _ => false,
    }
}
pub fn api_ok(u: &str) -> bool {
    let extra: Vec<String> = std::env::var("TACIT_HELPDESK_APIS").unwrap_or_default().split(',').map(|h| h.trim().to_ascii_lowercase()).filter(|h| !h.is_empty()).collect();
    api_ok_with(u, &extra)
}
pub fn api(dir: &Path) -> Option<String> {
    let from_file = setting(dir).and_then(|s| s["api"].as_str().map(str::to_string));
    from_file.or_else(|| std::env::var("TACIT_HELPDESK_API").ok()).filter(|a| api_ok(a)).map(|a| a.trim().trim_end_matches('/').to_string())
}
pub fn enabled(dir: &Path) -> bool {
    match setting(dir) {
        Some(s) => s["on"].as_bool().unwrap_or(false),
        None => std::env::var("TACIT_HELPDESK").map(|v| v == "1").unwrap_or(false),
    }
}
pub fn set(dir: &Path, on: bool, api_url: Option<&str>) -> Result<Value, String> {
    if let Some(a) = api_url {
        if !api_ok(a) {
            return Err("api must be the help desk's https:// address".into());
        }
    }
    let cur = setting(dir).unwrap_or_default();
    let api_final = api_url.map(str::to_string).or_else(|| cur["api"].as_str().map(str::to_string));
    let v = json!({ "on": on, "api": api_final });
    let _ = std::fs::create_dir_all(dir);
    std::fs::write(dir.join("helpdesk.json"), v.to_string()).map_err(|e| e.to_string())?;
    Ok(v)
}
fn resources(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let hd = dir.join("helpdesk");
    let bin = std::env::var_os("TACIT_HELPDESK_LLAMA").map(PathBuf::from).unwrap_or_else(|| hd.join("llama-server"));
    let model = std::env::var_os("TACIT_HELPDESK_MODEL").map(PathBuf::from).unwrap_or_else(|| hd.join("model.gguf"));
    (bin.is_file() && model.is_file()).then_some((bin, model))
}
pub fn status(dir: &Path, miner: Option<String>) -> Value {
    let job = NOW.lock().unwrap().clone().map(|(id, t)| json!({ "id": id, "secs": t.elapsed().as_secs_f64().round() }));
    json!({ "on": enabled(dir), "api": api(dir), "miner": miner, "installed": resources(dir).is_some(), "model_running": LLM_UP.load(Ordering::Relaxed),
            "served": DONE.load(Ordering::Relaxed), "job": job, "idle_secs_needed": idle_min() })
}

// ---- is the computer free to lend? (plugged in, owner away). Shell tools only, no new dependencies.
fn cmd_out(c: &str, args: &[&str]) -> Option<String> {
    let o = Command::new(c).args(args).output().ok()?;
    Some(String::from_utf8_lossy(&o.stdout).into_owned())
}
pub fn parse_hid_idle(line: &str) -> Option<u64> {
    // `    | |   "HIDIdleTime" = 4299868`  (nanoseconds)
    if !line.contains("HIDIdleTime") {
        return None;
    }
    line.rsplit('=').next()?.trim().parse::<u64>().ok().map(|ns| ns / 1_000_000_000)
}
fn on_ac() -> bool {
    if cfg!(target_os = "macos") {
        cmd_out("pmset", &["-g", "batt"]).map(|s| s.lines().next().unwrap_or("").contains("AC Power")).unwrap_or(true)
    } else {
        std::fs::read_dir("/sys/class/power_supply").ok()
            .and_then(|rd| rd.flatten().filter(|e| e.file_name().to_string_lossy().starts_with('A')).find_map(|e| std::fs::read_to_string(e.path().join("online")).ok()))
            .map(|s| s.trim() == "1").unwrap_or(true)
    }
}
fn idle_secs() -> u64 {
    if cfg!(target_os = "macos") {
        cmd_out("ioreg", &["-c", "IOHIDSystem"]).and_then(|s| s.lines().find_map(parse_hid_idle)).unwrap_or(0)
    } else if std::env::var_os("DISPLAY").is_some() {
        cmd_out("xprintidle", &[]).and_then(|s| s.trim().parse::<u64>().ok()).map(|ms| ms / 1000).unwrap_or(u64::MAX)
    } else {
        u64::MAX // no screen: a server
    }
}
fn idle_min() -> u64 {
    std::env::var("TACIT_HELPDESK_IDLE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(300)
}
fn free_to_lend() -> bool {
    std::env::var("TACIT_HELPDESK_ALWAYS").map(|v| v == "1").unwrap_or(false) || (on_ac() && idle_secs() >= idle_min())
}

// ---- the local model: llama-server on a free loopback port, started when there is work and stopped when it is not wanted
struct Llm {
    child: Child,
    port: u16,
}
fn kill_pid(pid: u32) {
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
}
fn pid_file(dir: &Path) -> PathBuf {
    dir.join("helpdesk").join("llama.pid")
}
// A model left running by a prover that was killed is stopped when the next one starts.
fn reap_stale(dir: &Path) {
    if let Some(pid) = std::fs::read_to_string(pid_file(dir)).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        if cmd_out("ps", &["-p", &pid, "-o", "comm="]).map(|s| s.contains("llama-server")).unwrap_or(false) {
            if let Ok(p) = pid.parse() {
                kill_pid(p);
            }
        }
    }
    let _ = std::fs::remove_file(pid_file(dir));
}
fn start_llm(dir: &Path, bin: &Path, model: &Path) -> Option<Llm> {
    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?.local_addr().ok()?.port();
    let ctx = std::env::var("TACIT_HELPDESK_CTX").unwrap_or_else(|_| "4096".into());
    let _ = std::fs::create_dir_all(dir.join("helpdesk"));
    let log = std::fs::File::create(dir.join("helpdesk").join("llama.log")).ok().map(Stdio::from).unwrap_or_else(Stdio::null);
    eprintln!("tacit-prover: help desk: starting the model");
    // llama-server's own libraries (and the CUDA runtime on Linux) sit beside it, possibly behind a symlink
    let libdir = std::fs::canonicalize(bin).ok().and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned())).unwrap_or_default();
    let with = |var: &str| format!("{libdir}:{}", std::env::var(var).unwrap_or_default());
    let mut child = Command::new(bin)
        .env("LD_LIBRARY_PATH", with("LD_LIBRARY_PATH")).env("DYLD_LIBRARY_PATH", with("DYLD_LIBRARY_PATH"))
        .args(["-m", &model.to_string_lossy(), "-c", &ctx, "-np", "1", "--host", "127.0.0.1", "--port", &port.to_string(), "--reasoning", "off"])
        .stdout(Stdio::null()).stderr(log).spawn().ok()?;
    let _ = std::fs::write(pid_file(dir), child.id().to_string());
    *LLM_PID.lock().unwrap() = Some(child.id());
    let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(3)).build().ok()?;
    for _ in 0..120 {
        if child.try_wait().ok().flatten().is_some() {
            eprintln!("tacit-prover: help desk: the model stopped at start (see helpdesk/llama.log)");
            return None;
        }
        if http.get(format!("http://127.0.0.1:{port}/health")).send().map(|r| r.status().is_success()).unwrap_or(false) {
            LLM_UP.store(true, Ordering::Relaxed);
            eprintln!("tacit-prover: help desk: model ready");
            return Some(Llm { child, port });
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    let _ = child.kill();
    let _ = child.wait();
    *LLM_PID.lock().unwrap() = None;
    None
}
fn stop_llm(dir: &Path, mut l: Llm, why: &str) {
    eprintln!("tacit-prover: help desk: stopping the model ({why})");
    let _ = l.child.kill();
    let _ = l.child.wait();
    *LLM_PID.lock().unwrap() = None;
    LLM_UP.store(false, Ordering::Relaxed);
    let _ = std::fs::remove_file(pid_file(dir));
}
// The model's process died or was killed by the guard: collect it.
fn reap_dead(dir: &Path, llm: &mut Option<Llm>) {
    if llm.as_mut().map(|l| l.child.try_wait().ok().flatten().is_some()).unwrap_or(false) {
        if let Some(mut l) = llm.take() {
            let _ = l.child.wait();
        }
        *LLM_PID.lock().unwrap() = None;
        LLM_UP.store(false, Ordering::Relaxed);
        let _ = std::fs::remove_file(pid_file(dir));
    }
}

// ---- jobs
pub enum Outcome {
    Worked,
    Empty,
    Failed,
}
// Cap what a job may ask of this machine: a hostile or broken API cannot make the model run for ever or write a book.
pub fn clamp_job(job: &Value) -> Option<(String, Value, u64, f64)> {
    let id = job["id"].as_str().filter(|s| !s.is_empty() && s.len() <= 64)?.to_string();
    let messages = job["messages"].as_array().filter(|m| !m.is_empty() && m.len() <= 4)?;
    if Value::Array(messages.clone()).to_string().len() > MAX_JOB {
        return None;
    }
    if !messages.iter().all(|m| m["role"].is_string() && m["content"].is_string()) {
        return None;
    }
    let max_tokens = job["max_tokens"].as_u64().unwrap_or(300).clamp(16, 500);
    let temperature = job["temperature"].as_f64().unwrap_or(0.2).clamp(0.0, 1.0);
    Some((id, Value::Array(messages.clone()), max_tokens, temperature))
}

fn run(ctx: Ctx) {
    reap_stale(&ctx.dir);
    let mut llm: Option<Llm> = None;
    let mut last_work = Instant::now();
    let unload = Duration::from_secs(std::env::var("TACIT_HELPDESK_UNLOAD_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(900));
    loop {
        reap_dead(&ctx.dir, &mut llm);
        let api = api(&ctx.dir);
        let miner = (ctx.miner)();
        let wanted = enabled(&ctx.dir) && api.is_some() && miner.is_some() && resources(&ctx.dir).is_some() && !(*ctx.busy)() && free_to_lend();
        if !wanted {
            if let Some(l) = llm.take() {
                stop_llm(&ctx.dir, l, "a proof is running or waiting, the owner is back, or it was switched off");
            }
            std::thread::sleep(Duration::from_secs(5));
            continue;
        }
        if llm.is_some() && last_work.elapsed() > unload {
            if let Some(l) = llm.take() {
                stop_llm(&ctx.dir, l, "no work for a while");
            }
        }
        match lease_one(&ctx, api.as_deref().unwrap_or_default(), miner.as_deref().unwrap_or_default(), &mut llm) {
            Outcome::Worked => last_work = Instant::now(),
            Outcome::Empty => {}                                           // the API holds a lease request open for a while, so this is not a busy loop
            Outcome::Failed => std::thread::sleep(Duration::from_secs(10)),
        }
    }
}

fn lease_one(ctx: &Ctx, api: &str, miner: &str, llm: &mut Option<Llm>) -> Outcome {
    let Ok(http) = reqwest::blocking::Client::builder().timeout(Duration::from_secs(45)).build() else { return Outcome::Failed };
    let post = |path: &str, body: &Value| http.post(format!("{api}/helpdesk/{path}")).json(body).send().ok().map(|r| (r.status().as_u16(), r.json::<Value>().unwrap_or(Value::Null)));
    let Some((code, job)) = post("lease", &json!({ "miner": miner, "model": MODEL_ID, "kinds": ["answer", "scan"], "hw": crate::hw::cached() })) else { return Outcome::Failed };
    if code == 204 {
        return Outcome::Empty;
    }
    if code != 200 {
        return Outcome::Failed;
    }
    let Some(lease) = job["lease"].as_str().map(str::to_string) else { return Outcome::Failed };
    let Some((id, messages, max_tokens, temperature)) = clamp_job(&job) else {
        if let Some(id) = job["id"].as_str() {
            let _ = post("submit", &json!({ "id": id, "lease": lease, "miner": miner, "error": "a job this node will not run" }));
        }
        return Outcome::Failed;
    };
    let give_up = |why: &str| {
        let _ = post("submit", &json!({ "id": id, "lease": lease, "miner": miner, "error": why }));
        *NOW.lock().unwrap() = None;
        Outcome::Failed
    };
    *NOW.lock().unwrap() = Some((id.clone(), Instant::now()));
    if (*ctx.busy)() {
        return give_up("a proof is running");
    }
    if llm.is_none() {
        let Some((bin, model)) = resources(&ctx.dir) else { return give_up("no model installed") };
        *llm = start_llm(&ctx.dir, &bin, &model);
    }
    let Some(l) = llm.as_ref() else { return give_up("the model did not start") };
    let port = l.port;

    let t0 = Instant::now();
    let reply = reqwest::blocking::Client::builder().timeout(Duration::from_secs(120)).build().ok().and_then(|c| {
        c.post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .json(&json!({ "model": "local", "temperature": temperature, "max_tokens": max_tokens, "chat_template_kwargs": { "enable_thinking": false }, "messages": messages }))
            .send().ok()?.json::<Value>().ok()
    });
    // The guard kills the model when a proof starts or waits or the owner is back, and clears LLM_PID: a failed request with no pid is that.
    if LLM_PID.lock().unwrap().is_none() {
        reap_dead(&ctx.dir, llm);
        return give_up("a proof started or the owner came back");
    }
    let text = reply.as_ref().and_then(|v| v["choices"][0]["message"]["content"].as_str()).unwrap_or("").trim().to_string();
    if text.is_empty() {
        return give_up("the model gave no answer");
    }
    let text: String = text.chars().take(MAX_REPLY).collect();
    let body = json!({ "id": id, "lease": lease, "miner": miner, "text": text, "ms": t0.elapsed().as_millis() as u64 });
    for _ in 0..3 {
        match post("submit", &body) {
            Some((200, _)) => {
                DONE.fetch_add(1, Ordering::Relaxed);
                *NOW.lock().unwrap() = None;
                eprintln!("tacit-prover: help desk: answered {id} in {:.1} s", t0.elapsed().as_secs_f64());
                return Outcome::Worked;
            }
            Some((code, _)) if code != 503 => break,
            _ => std::thread::sleep(Duration::from_secs(5)),
        }
    }
    *NOW.lock().unwrap() = None;
    Outcome::Failed
}

pub fn start(ctx: Ctx) {
    // The guard: a proof comes first. Every half second, if a proof is running or waiting the model is killed on the spot; every five
    // seconds, so is a model whose owner has come back or whose help desk was switched off.
    let (busy, dir) = (ctx.busy.clone(), ctx.dir.clone());
    std::thread::Builder::new().name("helpdesk-guard".into()).spawn(move || {
        let mut tick = 0u32;
        loop {
            std::thread::sleep(Duration::from_millis(500));
            tick = tick.wrapping_add(1);
            let Some(pid) = *LLM_PID.lock().unwrap() else { continue };
            let why = if (*busy)() { Some("a proof is running or waiting") } else if tick % 10 == 0 && (!enabled(&dir) || !free_to_lend()) { Some("the owner is back, or it was switched off") } else { None };
            if let Some(why) = why {
                kill_pid(pid);
                *LLM_PID.lock().unwrap() = None;
                LLM_UP.store(false, Ordering::Relaxed);
                eprintln!("tacit-prover: help desk: stopped the model ({why})");
            }
        }
    }).ok();
    std::thread::Builder::new().name("helpdesk".into()).spawn(move || run(ctx)).ok();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn api_must_be_https_or_loopback() {
        let none: Vec<String> = vec![];
        for ok in ["https://tacit-helpdesk.onrender.com", "https://tacit-helpdesk.onrender.com/", "https://HELP.tacit.finance/path?x=1", "http://127.0.0.1:8788", "http://localhost:3000/x", " https://help.tacit.finance "] {
            assert!(api_ok_with(ok, &none), "{ok}");
        }
        for bad in ["http://example.com", "https://example.com", "ftp://x", "", "help.tacit.finance", "https://", "https://tacit-helpdesk.onrender.com.evil.com", "https://evil.com/tacit-helpdesk.onrender.com",
            "https://evil.com#@tacit-helpdesk.onrender.com", "https://user@tacit-helpdesk.onrender.com", "https://tacit-helpdesk.onrender.com:evil", "http://127.0.0.1.evil.com", "http://localhost.evil.com",
            "http://tacit-helpdesk.onrender.com", "https://api.tacit.finance", "https://127.0.0.1"] {
            assert!(!api_ok_with(bad, &none), "{bad}");
        }
        let mine = vec!["help.example.org".to_string()];
        assert!(api_ok_with("https://help.example.org", &mine) && !api_ok_with("http://help.example.org", &mine) && !api_ok_with("https://other.example.org", &mine));
    }
    #[test]
    fn hid_idle_is_parsed_in_seconds() {
        assert_eq!(parse_hid_idle("    | |   \"HIDIdleTime\" = 4299868000"), Some(4));
        assert_eq!(parse_hid_idle("nothing here"), None);
    }
    #[test]
    fn jobs_are_capped() {
        let ok = json!({ "id": "a", "messages": [{ "role": "user", "content": "hi" }], "max_tokens": 99999, "temperature": 7 });
        let (_, _, mt, t) = clamp_job(&ok).unwrap();
        assert_eq!((mt, t), (500, 1.0));
        assert!(clamp_job(&json!({ "id": "a", "messages": [] })).is_none());
        assert!(clamp_job(&json!({ "id": "a", "messages": [{ "role": "user", "content": "x".repeat(30_000) }] })).is_none());
        assert!(clamp_job(&json!({ "id": "a", "messages": [{ "role": "user" }] })).is_none());
        assert!(clamp_job(&json!({ "messages": [{ "role": "user", "content": "x" }] })).is_none());
    }
    #[test]
    fn settings_round_trip() {
        let d = std::env::temp_dir().join(format!("hd-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        assert!(!enabled(&d));
        assert!(set(&d, true, Some("http://nope.example")).is_err());
        assert!(set(&d, true, Some("https://example.com")).is_err());
        set(&d, true, Some("https://tacit-helpdesk.onrender.com/")).unwrap();
        assert!(enabled(&d));
        assert_eq!(api(&d).as_deref(), Some("https://tacit-helpdesk.onrender.com"));
        set(&d, false, None).unwrap();
        assert!(!enabled(&d));
        assert_eq!(api(&d).as_deref(), Some("https://tacit-helpdesk.onrender.com"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
