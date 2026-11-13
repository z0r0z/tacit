// Code review and help desk answers on this machine's GPU while it has no proof to make (community mode, HELPDESK=1 by default).
//
// The community help desk (helpdesk/, tacit-helpdesk.onrender.com) hands out jobs: a visitor's question with Tacit's documentation, or a window of
// Tacit's code to review or a finding to check. This leases one, runs it on a small local model (llama.cpp's llama-server and the 2.7 GB
// Qwen3.5-4B file, on this GPU) and sends the answer back; the help desk checks nodes with questions whose answers it knows and pays the
// address checked work earns from the same daily pot as proofs. The model sees the job's text and nothing else.
//
// A proof always comes first. Before any proof starts, the worker calls `hold()`, which stops the model and waits for it to be gone, so the GPU's
// memory is the prover's again; the model starts again for the next job once the proof is done, and is unloaded after a while without work.
// The model is started only with enough of the GPU's memory free beside SP1's GPU server (HELPDESK_MIN_FREE_MB, 4096).
//
// Files (HELPDESK_DIR, ~/.tacit-gpu by default): helpdesk/llama-server and helpdesk/model.gguf, fetched the first time by dapp/helpdesk-fetch.sh,
// which is built into this program (the same pinned downloads, checked against their SHA-256), helpdesk/fetch.log and helpdesk/llama.log.
// Env: HELPDESK=0 (off), HELPDESK_API (the help desk's https:// address), HELPDESK_DIR, HELPDESK_MIN_FREE_MB, HELPDESK_UNLOAD_SECS (900),
// HELPDESK_CTX (4096), GPU_DEVICE (the card the model runs on, as for proofs).
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub static PROVING: AtomicBool = AtomicBool::new(false);
pub static DONE: AtomicU64 = AtomicU64::new(0);
static LLM: Mutex<Option<Child>> = Mutex::new(None);

const MODEL_ID: &str = "qwen3.5-4b-q4_k_m"; // what this node says it runs; the help desk hands out only jobs a model like this can do
const MAX_JOB: usize = 24_000;              // bytes of messages accepted
const MAX_REPLY: usize = 16_000;            // bytes of answer sent back
const API_HOSTS: [&str; 2] = ["tacit-helpdesk.onrender.com", "help.tacit.finance"];
const FETCH_SH: &str = include_str!("../../../../../dapp/helpdesk-fetch.sh");

pub struct Cfg {
    pub miner: String,  // the address the points go to
    pub gpu: String,    // the card, as GPU_DEVICE numbers it
    pub dir: PathBuf,   // where the model's files live
    pub api: String,    // the help desk
}

fn env_or(k: &str, d: &str) -> String {
    std::env::var(k).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| d.to_string())
}

// The help desk's address must be one of its own hosts: a setting cannot point this machine's idle time at another server.
pub fn api_ok(u: &str) -> bool {
    let Some(rest) = u.strip_prefix("https://") else { return false };
    let host = rest.split('/').next().unwrap_or("").to_ascii_lowercase();
    API_HOSTS.contains(&host.as_str())
}

// While a proof is made: the model is stopped before this returns, and `PROVING` stays set until the guard is dropped.
pub struct Hold;
impl Drop for Hold {
    fn drop(&mut self) { PROVING.store(false, Ordering::SeqCst); }
}
pub fn hold() -> Hold {
    PROVING.store(true, Ordering::SeqCst);
    stop_llm("a proof is starting");
    Hold
}

fn stop_llm(why: &str) {
    if let Some(mut c) = LLM.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
        println!("[helpdesk] stopped the model ({why})");
    }
}

// `nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits -i <n>` -> MiB (the first whole number), None if it says nothing usable.
pub fn parse_mib(s: &str) -> Option<u64> {
    s.lines().find_map(|l| l.trim().parse::<u64>().ok())
}
fn smi(query: &str, gpu: &str) -> Option<u64> {
    let o = Command::new("nvidia-smi").args([&format!("--query-gpu={query}"), "--format=csv,noheader,nounits", "-i", gpu]).stderr(Stdio::null()).output().ok()?;
    if !o.status.success() { return None; }
    parse_mib(&String::from_utf8_lossy(&o.stdout))
}
// `MemTotal:       32768000 kB` -> GB, rounded
pub fn parse_meminfo_gb(s: &str) -> Option<u64> {
    let kb: u64 = s.lines().find(|l| l.starts_with("MemTotal:"))?.split_whitespace().nth(1)?.parse().ok()?;
    Some(((kb as f64) / 1_048_576.0).round() as u64)
}
// What this machine has, for the help desk to size its jobs by: memory, GPU memory, cores, system (numbers and two words, nothing that names it).
fn hardware(gpu: &str) -> Value {
    let ram = std::fs::read_to_string("/proc/meminfo").ok().and_then(|s| parse_meminfo_gb(&s)).unwrap_or(0);
    let vram = smi("memory.total", gpu).map(|m| ((m as f64) / 1024.0).round() as u64).unwrap_or(0);
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    json!({ "ram": ram, "vram": vram, "cores": cores, "os": "linux", "arch": "x64", "unified": false })
}

// Cap what a job may ask of this machine: a hostile or broken help desk cannot make the model run for ever or write a book.
pub fn clamp_job(job: &Value) -> Option<(String, Value, u64, f64)> {
    let id = job["id"].as_str().filter(|s| !s.is_empty() && s.len() <= 64)?.to_string();
    let messages = job["messages"].as_array().filter(|m| !m.is_empty() && m.len() <= 4)?;
    if Value::Array(messages.clone()).to_string().len() > MAX_JOB { return None; }
    if !messages.iter().all(|m| m["role"].is_string() && m["content"].is_string()) { return None; }
    let max_tokens = job["max_tokens"].as_u64().unwrap_or(300).clamp(16, 500);
    let temperature = job["temperature"].as_f64().unwrap_or(0.2).clamp(0.0, 1.0);
    Some((id, Value::Array(messages.clone()), max_tokens, temperature))
}

fn resources(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let hd = dir.join("helpdesk");
    let (bin, model) = (hd.join("llama-server"), hd.join("model.gguf"));
    (bin.is_file() && model.is_file()).then_some((bin, model))
}
// Fetch the files with the built-in script, in a process group of its own, while no proof is being made. -> whether they are now in place.
fn fetch(dir: &Path) -> bool {
    use std::io::Write;
    use std::os::unix::process::CommandExt;
    let hd = dir.join("helpdesk");
    if std::fs::create_dir_all(&hd).is_err() { return false; }
    let Ok(log) = std::fs::File::create(hd.join("fetch.log")) else { return false };
    let Ok(err) = log.try_clone() else { return false };
    println!("[helpdesk] getting the model (2.7 GB, once): see {}", hd.join("fetch.log").display());
    let Ok(mut child) = Command::new("bash").arg("-s").env("TACIT_PROVER_DIR", dir).process_group(0)
        .stdin(Stdio::piped()).stdout(log).stderr(err).spawn() else { println!("[helpdesk] bash is needed to get the model"); return false };
    if let Some(mut stdin) = child.stdin.take() { let _ = stdin.write_all(FETCH_SH.as_bytes()); }
    let ok = child.wait().map(|s| s.success()).unwrap_or(false) && resources(dir).is_some();
    if !ok {
        let said = std::fs::read_to_string(hd.join("fetch.log")).unwrap_or_default();
        let why = said.lines().rev().find_map(|l| l.trim().strip_prefix("error: ").map(str::to_string)).unwrap_or_else(|| "the download stopped".into());
        println!("[helpdesk] could not get the model: {why}");
    }
    ok
}

fn start_llm(cfg: &Cfg, bin: &Path, model: &Path) -> Option<u16> {
    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?.local_addr().ok()?.port();
    let libdir = std::fs::canonicalize(bin).ok().and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned())).unwrap_or_default();
    let ld = format!("{libdir}:{}", std::env::var("LD_LIBRARY_PATH").unwrap_or_default());
    let log = std::fs::File::create(cfg.dir.join("helpdesk").join("llama.log")).ok().map(Stdio::from).unwrap_or_else(Stdio::null);
    let ctx = env_or("HELPDESK_CTX", "4096");
    let child = Command::new(bin).env("LD_LIBRARY_PATH", ld).env("CUDA_VISIBLE_DEVICES", &cfg.gpu).env("CUDA_DEVICE_ORDER", "PCI_BUS_ID")
        .args(["-m", &model.to_string_lossy(), "-c", &ctx, "-np", "1", "-ngl", "99", "--host", "127.0.0.1", "--port", &port.to_string(), "--reasoning", "off"])
        .stdout(Stdio::null()).stderr(log).spawn().ok()?;
    {
        let mut slot = LLM.lock().unwrap();
        // a proof began while it was being spawned: it goes at once
        if PROVING.load(Ordering::SeqCst) { let mut c = child; let _ = c.kill(); let _ = c.wait(); return None; }
        *slot = Some(child);
    }
    println!("[helpdesk] starting the model on GPU {}", cfg.gpu);
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(3)).build();
    for _ in 0..120 {
        {
            let mut slot = LLM.lock().unwrap();
            match slot.as_mut().map(|c| c.try_wait()) {
                None => return None,                                                     // stopped for a proof
                Some(Ok(Some(_))) | Some(Err(_)) => { slot.take(); println!("[helpdesk] the model stopped at start (see helpdesk/llama.log)"); return None; }
                _ => {}
            }
        }
        if agent.get(&format!("http://127.0.0.1:{port}/health")).call().map(|r| r.status() == 200).unwrap_or(false) {
            println!("[helpdesk] model ready");
            return Some(port);
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    stop_llm("it did not become ready");
    None
}
fn llm_up() -> bool { LLM.lock().unwrap().as_mut().map(|c| matches!(c.try_wait(), Ok(None))).unwrap_or(false) }

enum Outcome { Worked, Empty, Failed }

fn post(agent: &ureq::Agent, url: &str, body: &Value) -> Option<(u16, Value)> {
    match agent.post(url).send_json(body.clone()) {
        Ok(r) => { let code = r.status(); Some((code, if code == 204 { Value::Null } else { r.into_json::<Value>().unwrap_or(Value::Null) })) }
        Err(ureq::Error::Status(code, r)) => Some((code, r.into_json::<Value>().unwrap_or(Value::Null))),
        Err(_) => None,
    }
}

fn lease_one(cfg: &Cfg, hw: &Value, port: &mut Option<u16>) -> Outcome {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(45)).build();
    let url = |p: &str| format!("{}/helpdesk/{p}", cfg.api);
    let Some((code, job)) = post(&agent, &url("lease"), &json!({ "miner": cfg.miner, "model": MODEL_ID, "kinds": ["answer", "scan"], "hw": hw })) else { return Outcome::Failed };
    if code == 204 { return Outcome::Empty; }
    if code != 200 { return Outcome::Failed; }
    let Some(lease) = job["lease"].as_str().map(str::to_string) else { return Outcome::Failed };
    let give_up = |id: &str, why: &str| { let _ = post(&agent, &url("submit"), &json!({ "id": id, "lease": lease, "miner": cfg.miner, "error": why })); Outcome::Failed };
    let Some((id, messages, max_tokens, temperature)) = clamp_job(&job) else {
        return job["id"].as_str().map(|id| give_up(id, "a job this node will not run")).unwrap_or(Outcome::Failed);
    };
    if PROVING.load(Ordering::SeqCst) { return give_up(&id, "a proof is running"); }
    if port.is_none() || !llm_up() {
        let Some((bin, model)) = resources(&cfg.dir) else { return give_up(&id, "no model installed") };
        *port = start_llm(cfg, &bin, &model);
    }
    let Some(p) = *port else { return give_up(&id, "the model did not start") };
    let t0 = Instant::now();
    let reply = ureq::AgentBuilder::new().timeout(Duration::from_secs(120)).build()
        .post(&format!("http://127.0.0.1:{p}/v1/chat/completions"))
        .send_json(json!({ "model": "local", "temperature": temperature, "max_tokens": max_tokens, "chat_template_kwargs": { "enable_thinking": false }, "messages": messages }))
        .ok().and_then(|r| r.into_json::<Value>().ok());
    // a proof started meanwhile stopped the model: its answer is not trusted to be whole
    if PROVING.load(Ordering::SeqCst) || !llm_up() { *port = None; return give_up(&id, "a proof started"); }
    let text: String = reply.as_ref().and_then(|v| v["choices"][0]["message"]["content"].as_str()).unwrap_or("").trim().chars().take(MAX_REPLY).collect();
    if text.is_empty() { return give_up(&id, "the model gave no answer"); }
    let body = json!({ "id": id, "lease": lease, "miner": cfg.miner, "text": text, "ms": t0.elapsed().as_millis() as u64 });
    for _ in 0..3 {
        match post(&agent, &url("submit"), &body) {
            Some((200, _)) => { DONE.fetch_add(1, Ordering::Relaxed); return Outcome::Worked; }
            Some((code, _)) if code != 503 => break,
            _ => std::thread::sleep(Duration::from_secs(5)),
        }
    }
    Outcome::Failed
}

pub fn start(cfg: Cfg) {
    std::thread::Builder::new().name("helpdesk".into()).spawn(move || run(cfg)).ok();
    // a guard beside the explicit hold(): the model never runs while a proof is in hand
    std::thread::Builder::new().name("helpdesk-guard".into()).spawn(|| loop {
        std::thread::sleep(Duration::from_millis(250));
        if PROVING.load(Ordering::SeqCst) && LLM.lock().unwrap().is_some() { stop_llm("a proof is running"); }
    }).ok();
}

fn run(cfg: Cfg) {
    let hw = hardware(&cfg.gpu);
    let min_free: u64 = env_or("HELPDESK_MIN_FREE_MB", "4096").parse().unwrap_or(4096);
    let unload = Duration::from_secs(env_or("HELPDESK_UNLOAD_SECS", "900").parse().unwrap_or(900));
    let mut next_fetch = Instant::now();
    let (mut port, mut last_work) = (None::<u16>, Instant::now());
    println!("[helpdesk] reviewing for {} between proofs ({}), model {MODEL_ID}", cfg.miner, cfg.api);
    loop {
        if PROVING.load(Ordering::SeqCst) { port = None; std::thread::sleep(Duration::from_secs(1)); continue; }
        if resources(&cfg.dir).is_none() {
            if Instant::now() >= next_fetch && !fetch(&cfg.dir) { next_fetch = Instant::now() + Duration::from_secs(3600); }
            if resources(&cfg.dir).is_none() { std::thread::sleep(Duration::from_secs(30)); continue; }
        }
        // the model starts only with room for it beside the prover; one already running keeps going
        if !llm_up() {
            port = None;
            if smi("memory.free", &cfg.gpu).map_or(true, |free| free < min_free) { std::thread::sleep(Duration::from_secs(60)); continue; }
        }
        if llm_up() && last_work.elapsed() > unload { stop_llm("no work for a while"); port = None; }
        match lease_one(&cfg, &hw, &mut port) {
            Outcome::Worked => last_work = Instant::now(),
            Outcome::Empty => {}                                         // the help desk holds a lease request open for a while: not a busy loop
            Outcome::Failed => std::thread::sleep(Duration::from_secs(10)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_help_desks_own_hosts_only() {
        assert!(api_ok("https://tacit-helpdesk.onrender.com") && api_ok("https://help.tacit.finance/") && api_ok("https://TACIT-HELPDESK.onrender.com"));
        assert!(!api_ok("http://tacit-helpdesk.onrender.com") && !api_ok("https://evil.example") && !api_ok("https://tacit-helpdesk.onrender.com.evil.example") && !api_ok(""));
    }
    #[test]
    fn gpu_memory_and_ram_are_read() {
        assert_eq!(parse_mib("15360\n"), Some(15360));
        assert_eq!(parse_mib("[N/A]\n 8000 \n"), Some(8000));
        assert_eq!(parse_mib(""), None);
        assert_eq!(parse_meminfo_gb("MemTotal:       32768000 kB\n"), Some(31));
        assert_eq!(parse_meminfo_gb("MemFree: 1 kB\n"), None);
    }
    #[test]
    fn jobs_are_capped() {
        let ok = json!({ "id": "j1", "messages": [{ "role": "user", "content": "hi" }], "max_tokens": 9999, "temperature": 3.0 });
        let (id, _, max, t) = clamp_job(&ok).unwrap();
        assert_eq!((id.as_str(), max, t), ("j1", 500, 1.0));
        assert!(clamp_job(&json!({ "id": "", "messages": [{ "role": "user", "content": "x" }] })).is_none());
        assert!(clamp_job(&json!({ "id": "j", "messages": [] })).is_none());
        assert!(clamp_job(&json!({ "id": "j", "messages": [{ "role": "user", "content": "x".repeat(MAX_JOB) }] })).is_none());
        assert!(clamp_job(&json!({ "id": "j", "messages": [{ "role": "user" }] })).is_none());
        assert!(clamp_job(&json!({ "id": "j", "messages": vec![json!({ "role": "user", "content": "x" }); 5] })).is_none());
    }
    #[test]
    fn a_hold_stops_the_model_and_lasts_while_held() {
        // a stand-in for llama-server: a process that would run for a minute
        let child = Command::new("sleep").arg("60").spawn().unwrap();
        let pid = child.id();
        *LLM.lock().unwrap() = Some(child);
        {
            let _h = hold();
            assert!(PROVING.load(Ordering::SeqCst), "proving while held");
            assert!(LLM.lock().unwrap().is_none(), "the model is gone before hold() returns");
            let alive = Command::new("kill").args(["-0", &pid.to_string()]).status().map(|s| s.success()).unwrap_or(false);
            assert!(!alive, "and its process has ended");
        }
        assert!(!PROVING.load(Ordering::SeqCst), "and free again once the hold is dropped");
    }
    #[test]
    fn the_fetch_script_is_built_in() {
        assert!(FETCH_SH.starts_with("#!/bin/bash") && FETCH_SH.contains("MODEL_SHA") && FETCH_SH.contains("install_llama"));
    }
}
