// tacit-prover: proves Tacit V1 settle ops on this machine for the dapp, so they need no outside prover. One CPU prover
// stays warm (the recursion programs and the Groth16 key are loaded once), takes a program input the page built with
// dapp/sp1-stdin.js, and returns the Groth16 proof the pool verifies. Listens on 127.0.0.1 only.
//
//   tacit-prover [serve]          GET /health, POST /prove {stdin}, GET /job?id= (its stage and an ETA while it proves),
//                                 GET /mine, POST /mine {miner?, on} (tacit.finance/prove/ starts and pauses mining)
//                                 GET /helpdesk, POST /helpdesk {on, api?} (lend idle time to the community help desk, helpdesk.rs)
//   tacit-prover prove <stdin>    one proof to <stdin>.proof.json
//   tacit-prover check            every faster path against the code it replaces, then exit
//   tacit-prover install          start at login and stay ready (launchd on macOS, a systemd user unit on Linux)
//   tacit-prover uninstall        stop that
//   tacit-prover mine 0xADDR      prove wraps people asked to have ready (the API's proof pool) for TAC points to 0xADDR
//
// While mining, a few cores that a proof is not using grind deploy salts for TAC points too (salt.rs, gentle.rs): a proof always comes first, and the grinding runs at
// the lowest priority and only on the charger.
// With the help desk switched on (helpdesk.rs), an idle, plugged-in computer also answers the community help desk's questions
// with a small local model; the model is stopped the moment a proof starts or waits.
//
// Env: TACIT_PROVER_PORT (47815), TACIT_PROVER_ORIGINS (comma list, default tacit.finance and www.tacit.finance; a local page
// under development adds its own),
// TACIT_PROVER_DIR (~/.tacit-prover: finished proofs), TACIT_METAL=0 (CPU leaf hashing), TACIT_MINE=0xADDR (serve mines the
// proof pool while it has nothing of its own to prove), TACIT_POOL_API (https://api.tacit.finance), and the SDK's
// SP1_WORKER_NUM_*_WORKERS (one per stage by default below 16 GB of RAM), TACIT_SALT_THREADS (cores that grind salts; a quarter by default, 0 is off), TACIT_SALT_BATTERY=1 (grind on battery too: by default it waits for the charger), TACIT_SALT_PRIORITY=normal (grind at normal priority: by default the lowest, so the person's own work comes first).
mod gentle;
mod helpdesk;
mod hw;
mod salt;
use sha2::{Digest, Sha256};
use sp1_sdk::{blocking::{ProveRequest, Prover, ProverClient}, Elf, HashableKey, ProvingKey, SP1Stdin};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

const ELF: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../elf/cxfer-guest"));
// The live pool's PROGRAM_VKEY: a guest that derives anything else is refused at start.
const POOL_VKEY: &str = "0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3";
const MAX_INPUT: usize = 1 << 20;
// Proofs waiting at once from this machine's pages: one proof takes minutes, so more would only wait.
const MAX_QUEUED: usize = 8;

#[derive(Clone, Default)]
struct Job {
    status: &'static str,
    started: Option<Instant>,
    secs: f64,
    cycles: u64,
    public_values: String,
    proof: String,
    error: String,
}

struct State {
    jobs: HashMap<String, Job>,
    queue: VecDeque<(String, SP1Stdin)>,
    kick: bool,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("serve");
    if cmd == "check" {
        std::process::exit(if check() { 0 } else { 1 });
    }
    if cmd == "install" || cmd == "uninstall" {
        std::process::exit(match service(cmd == "install") { Ok(m) => { println!("{m}"); 0 } Err(e) => { eprintln!("{e}"); 1 } });
    }
    lean_workers();
    logger();
    let t = Instant::now();
    let client = ProverClient::builder().cpu().build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    let vkey = pk.verifying_key().bytes32();
    assert_eq!(vkey.to_lowercase(), POOL_VKEY, "this guest's vkey is not the pool's");
    eprintln!("tacit-prover: ready in {:.0} s, vkey {vkey}, leaf hashing on {}", t.elapsed().as_secs_f64(), tacit_leafhash::device().unwrap_or("the CPU"));

    match cmd {
        "prove" => {
            let path = args.get(2).expect("usage: tacit-prover prove <stdin.bin>");
            let stdin = read_stdin(&std::fs::read(path).expect("read input")).expect("not a bincode SP1Stdin");
            let mut job = Job::default();
            run(&client, &pk, stdin, &mut job);
            let out = format!("{path}.proof.json");
            std::fs::write(&out, job_json(&job).to_string()).expect("write proof");
            eprintln!("tacit-prover: {} in {:.0} s -> {out}", job.status, job.secs);
            std::process::exit(if job.status == "done" { 0 } else { 1 });
        }
        "serve" => serve(client, pk, vkey),
        "mine" => {
            let miner = args.get(2).cloned().unwrap_or_default();
            if !pool::is_address(&miner) {
                eprintln!("usage: tacit-prover mine 0x<your address, 40 hex digits>: the address the TAC points go to");
                std::process::exit(2);
            }
            eprintln!("tacit-prover: mining the proof pool for {miner}");
            std::env::set_var("TACIT_MINE", &miner);
            salt::start();
            loop {
                salt::PROVING.store(true, std::sync::atomic::Ordering::Relaxed);
                let mined = pool::mine_one(&client, &pk, &miner);
                salt::PROVING.store(false, std::sync::atomic::Ordering::Relaxed);
                if !mined {
                    std::thread::sleep(std::time::Duration::from_secs(60));
                }
            }
        }
        other => {
            eprintln!("unknown command {other}; use serve, prove <stdin> or check");
            std::process::exit(2);
        }
    }
}

// The SDK verifies each shard and recursion proof as it goes; `run` verifies the final proof, which no wrong step survives,
// so the checks along the way only cost time. Below 16 GB the SDK's default concurrency (several shards and recursion proofs
// at once) pages; one per stage is faster.
fn lean_workers() {
    if std::env::var_os("SP1_WORKER_VERIFY_INTERMEDIATES").is_none() {
        std::env::set_var("SP1_WORKER_VERIFY_INTERMEDIATES", "false");
    }
    if ram_bytes().map_or(true, |b| b >= 16 << 30) {
        return;
    }
    for k in ["CORE", "RECURSION_PROVER", "RECURSION_EXECUTOR", "DEFERRED", "SETUP", "PREPARE_REDUCE", "SPLICING"] {
        let var = format!("SP1_WORKER_NUM_{k}_WORKERS");
        if std::env::var_os(&var).is_none() {
            std::env::set_var(var, "1");
        }
    }
}

fn ram_bytes() -> Option<u64> {
    if cfg!(target_os = "macos") {
        let out = std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output().ok()?;
        String::from_utf8(out.stdout).ok()?.trim().parse().ok()
    } else {
        let info = std::fs::read_to_string("/proc/meminfo").ok()?;
        let kb: u64 = info.lines().find(|l| l.starts_with("MemTotal:"))?.split_whitespace().nth(1)?.parse().ok()?;
        Some(kb * 1024)
    }
}

fn read_stdin(raw: &[u8]) -> Option<SP1Stdin> {
    bincode::deserialize(raw).ok()
}

fn run(client: &sp1_sdk::blocking::CpuProver, pk: &sp1_sdk::SP1ProvingKey, stdin: SP1Stdin, job: &mut Job) {
    let t = Instant::now();
    progress::start();
    // Execute first: an input the guest rejects fails in a second, not after the whole proof.
    match client.execute(Elf::Static(ELF), stdin.clone()).run() {
        Err(e) => {
            job.status = "failed";
            job.error = format!("the guest rejects this input: {e}");
            return;
        }
        Ok((_, report)) => job.cycles = report.total_instruction_count(),
    }
    let res = client.prove(pk, stdin).groth16().run().map_err(|e| e.to_string()).and_then(|proof| {
        client.verify(&proof, pk.verifying_key(), None).map_err(|e| format!("the proof made here does not verify: {e}"))?;
        Ok(proof)
    });
    job.secs = t.elapsed().as_secs_f64();
    if res.is_ok() {
        progress::finish(&store_dir());
    }
    match res {
        Ok(p) => {
            job.status = "done";
            job.public_values = format!("0x{}", hex::encode(p.public_values.as_slice()));
            job.proof = format!("0x{}", hex::encode(p.bytes()));
        }
        Err(e) => {
            job.status = "failed";
            job.error = e;
        }
    }
}

fn job_json(j: &Job) -> serde_json::Value {
    let secs = match (j.status, j.started) {
        ("done" | "failed", _) | (_, None) => j.secs,
        (_, Some(t)) => t.elapsed().as_secs_f64(),
    };
    let mut o = serde_json::json!({"status": j.status, "secs": secs.round(), "cycles": j.cycles});
    if j.status == "done" {
        o["publicValues"] = j.public_values.clone().into();
        o["proof"] = j.proof.clone().into();
    }
    if j.status == "failed" {
        o["error"] = j.error.clone().into();
    }
    if j.status == "proving" {
        if let Some((stage, eta)) = progress::now(&store_dir()) {
            o["stage"] = stage.into();
            if let Some(eta) = eta {
                o["eta"] = eta.round().into();
            }
        }
    }
    o
}

// Proof mining: wraps people asked to have ready (the API's proof pool, /prover/pool/*), leased one at a time, proved here and handed
// back for TAC points to the miner's address. A wrap's input carries no secret (the asset, the amount and a note's commitment, made
// public by the deposit anyway), and the API checks each proof against the pool's verifier and the note it was asked for before it
// credits anything.
mod pool {
    use super::{run, store_dir, Job};
    use serde_json::{json, Value};
    use std::time::Duration;

    pub fn is_address(a: &str) -> bool {
        a.len() == 42 && a.starts_with("0x") && a[2..].chars().all(|c| c.is_ascii_hexdigit())
    }
    pub fn env_miner() -> Option<String> {
        std::env::var("TACIT_MINE").ok().filter(|a| is_address(a))
    }
    // What the page last set (POST /mine, kept in mine.json) decides; with nothing set, TACIT_MINE does.
    pub fn setting() -> Option<Value> {
        serde_json::from_slice(&std::fs::read(store_dir().join("mine.json")).ok()?).ok()
    }
    pub fn miner() -> Option<String> {
        match setting() {
            Some(s) => s["on"].as_bool().filter(|on| *on).and(s["miner"].as_str()).filter(|a| is_address(a)).map(str::to_string),
            None => env_miner(),
        }
    }
    pub fn set(miner: Option<&str>, on: bool) -> Result<Value, String> {
        let miner = miner.map(str::to_string).or_else(|| setting().and_then(|s| s["miner"].as_str().map(str::to_string))).or_else(env_miner);
        let Some(miner) = miner.filter(|a| is_address(a)) else { return Err("an address (0x and 40 hex digits) is needed to mine".into()) };
        let v = json!({ "miner": miner, "on": on });
        let _ = std::fs::create_dir_all(store_dir());
        std::fs::write(store_dir().join("mine.json"), v.to_string()).map_err(|e| e.to_string())?;
        Ok(v)
    }

    // The pool job being proved now and what this run has proved, for GET /mine.
    pub static NOW: std::sync::Mutex<Option<(String, std::time::Instant)>> = std::sync::Mutex::new(None);
    pub static DONE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn api() -> String {
        std::env::var("TACIT_POOL_API").unwrap_or_else(|_| "https://api.tacit.finance".into()).trim_end_matches('/').to_string()
    }
    fn http() -> Option<reqwest::blocking::Client> {
        reqwest::blocking::Client::builder().timeout(Duration::from_secs(60)).build().ok()
    }
    // → the status and the JSON answer (Null for none), or None when the API did not answer.
    fn post(http: &reqwest::blocking::Client, path: &str, body: &Value) -> Option<(u16, Value)> {
        let r = http.post(format!("{}/prover/pool/{path}", api())).json(body).send().ok()?;
        let code = r.status().as_u16();
        Some((code, r.json().unwrap_or(Value::Null)))
    }
    // The lease held, kept on disk until its proof is sent or it is handed back: the API gives a lease's token only once, so
    // after a restart the job is handed back at once rather than the next lease waiting out the old one.
    fn held() -> std::path::PathBuf {
        store_dir().join("pool-lease.json")
    }
    fn hand_back(http: &reqwest::blocking::Client, id: &str, token: &str, why: &str) {
        let why = if why.is_empty() { "could not prove it" } else { why };
        let _ = post(http, "submit", &json!({ "id": id, "lease": token, "error": why }));
        let _ = std::fs::remove_file(held());
    }

    // One job leased, proved and handed back. → whether there was a job (false: the pool was empty or unreachable).
    pub fn mine_one(client: &sp1_sdk::blocking::CpuProver, pk: &sp1_sdk::SP1ProvingKey, miner: &str) -> bool {
        let Some(http) = http() else { return false };
        if let Some(l) = std::fs::read(held()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
            if let (Some(id), Some(token)) = (l["id"].as_str(), l["lease"].as_str()) {
                hand_back(&http, id, token, "the prover restarted");
            }
            let _ = std::fs::remove_file(held());
        }
        let Some((code, lease)) = post(&http, "lease", &json!({ "miner": miner })) else { return false };
        if code != 200 {
            if code != 204 {
                eprintln!("tacit-prover: the pool leases nothing just now: {}", lease["error"].as_str().unwrap_or("no reason given"));
            }
            return false;
        }
        let (Some(id), Some(token), Some(stdin)) = (lease["id"].as_str(), lease["lease"].as_str(), lease["stdin"].as_str()) else { return false };
        let _ = std::fs::create_dir_all(store_dir());
        let _ = std::fs::write(held(), json!({ "id": id, "lease": token }).to_string());
        let Some(input) = hex::decode(stdin.trim_start_matches("0x")).ok().filter(|b| b.len() <= super::MAX_INPUT).and_then(|b| super::read_stdin(&b)) else {
            eprintln!("tacit-prover: pool job {id} has an input this prover cannot read; handed back");
            hand_back(&http, id, token, "an input this prover cannot read");
            return true;
        };
        eprintln!("tacit-prover: proving pool job {id} for {miner}");
        let mut job = Job::default();
        *NOW.lock().unwrap() = Some((id.to_string(), std::time::Instant::now()));
        run(client, pk, input, &mut job);
        *NOW.lock().unwrap() = None;
        if job.status != "done" {
            eprintln!("tacit-prover: pool job {id} {}: {}; handed back", job.status, job.error);
            hand_back(&http, id, token, &job.error);
            return true;
        }
        // The API asks Ethereum's verifier before it takes a proof: while no node answers it keeps the lease, so the proof is sent
        // again a few times before it is left to run out.
        let body = json!({ "id": id, "lease": token, "publicValues": job.public_values, "proof": job.proof });
        for _ in 0..6 {
            match post(&http, "submit", &body) {
                Some((200, v)) => {
                    DONE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    eprintln!("tacit-prover: pool job {id} proved in {:.0} s, {} points to {miner}", job.secs, v["points"]);
                    break;
                }
                Some((503, _)) | None => std::thread::sleep(Duration::from_secs(30)),
                Some((_, v)) => {
                    eprintln!("tacit-prover: pool job {id} not taken: {}", v["error"].as_str().or(v["code"].as_str()).unwrap_or("no reason given"));
                    break;
                }
            }
        }
        let _ = std::fs::remove_file(held());
        true
    }
}

// Where the running proof is (core, shrink, wrap, groth16), from the SDK's own tracing spans, and how long the rest took on
// this machine the last time: each finished proof's stage times are kept beside its proofs.
mod progress {
    use std::path::Path;
    use std::sync::Mutex;
    use std::time::Instant;

    pub const STAGES: [&str; 4] = ["core", "shrink", "wrap", "groth16"];
    static MARKS: Mutex<Vec<(&'static str, Instant)>> = Mutex::new(Vec::new());

    pub fn start() {
        *MARKS.lock().unwrap() = vec![("core", Instant::now())];
    }
    pub fn mark(stage: &'static str) {
        let mut m = MARKS.lock().unwrap();
        if !m.is_empty() && m.last().map(|x| x.0) != Some(stage) {
            m.push((stage, Instant::now()));
        }
    }
    fn last(dir: &Path) -> Option<serde_json::Value> {
        serde_json::from_slice(&std::fs::read(dir.join("timing.json")).ok()?).ok()
    }
    pub fn now(dir: &Path) -> Option<(&'static str, Option<f64>)> {
        let m = MARKS.lock().unwrap();
        let (stage, since) = *m.last()?;
        let eta = last(dir).map(|t| {
            let at = STAGES.iter().position(|s| *s == stage).unwrap_or(0);
            let of = |s: &str| t[s].as_f64().unwrap_or(0.0);
            (of(stage) - since.elapsed().as_secs_f64()).max(0.0) + STAGES[at + 1..].iter().map(|s| of(s)).sum::<f64>()
        });
        Some((stage, eta))
    }
    pub fn finish(dir: &Path) {
        let m = MARKS.lock().unwrap();
        if m.len() != STAGES.len() {
            return;
        }
        let end = Instant::now();
        let mut t = serde_json::Map::new();
        for (i, (stage, at)) in m.iter().enumerate() {
            let next = m.get(i + 1).map_or(end, |x| x.1);
            t.insert(stage.to_string(), (next - *at).as_secs_f64().round().into());
        }
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(dir.join("timing.json"), serde_json::Value::Object(t).to_string());
    }

    pub struct Stages;
    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Stages {
        fn on_new_span(&self, attrs: &tracing::span::Attributes<'_>, _: &tracing::span::Id, _: tracing_subscriber::layer::Context<'_, S>) {
            match attrs.metadata().name() {
                "prove shrink" => mark("shrink"),
                "prove wrap" => mark("wrap"),
                "prove groth16" => mark("groth16"),
                _ => {}
            }
        }
    }
}

// The SDK's flat logger (RUST_LOG, quiet by default, the GPU paths' notes shown), with the stage watcher beside it.
fn logger() {
    use tracing_subscriber::{filter::LevelFilter, fmt::format::FmtSpan, prelude::*, EnvFilter};
    let env = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn,p3_merkle_tree=info,p3_challenger=info"));
    let fmt = tracing_subscriber::fmt::layer().compact().with_target(false).with_span_events(FmtSpan::CLOSE).with_filter(env);
    tracing_subscriber::registry().with(fmt).with(progress::Stages.with_filter(LevelFilter::INFO)).init();
}

// Starts the prover at login and keeps it running, so its keys stay loaded and a page finds it ready. TACIT_MINE set when installing
// is kept, so the installed prover mines the proof pool while idle.
fn service(on: bool) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("no HOME")?);
    let sh = |cmd: &str, args: &[&str]| std::process::Command::new(cmd).args(args).status().map(|s| s.success()).unwrap_or(false);
    let log = store_dir().join("daemon.log");
    let _ = std::fs::create_dir_all(store_dir());
    // Installing for an address mines for it, whatever the page set before.
    if on && pool::env_miner().is_some() {
        let _ = std::fs::remove_file(store_dir().join("mine.json"));
    }
    if cfg!(target_os = "macos") {
        let uid = String::from_utf8(std::process::Command::new("id").arg("-u").output().map_err(|e| e.to_string())?.stdout).unwrap_or_default();
        let domain = format!("gui/{}", uid.trim());
        let plist = home.join("Library/LaunchAgents/finance.tacit.prover.plist");
        sh("launchctl", &["bootout", &format!("{domain}/finance.tacit.prover")]);
        if !on {
            let _ = std::fs::remove_file(&plist);
            return Ok("tacit-prover no longer starts at login".into());
        }
        let _ = std::fs::create_dir_all(plist.parent().unwrap());
        std::fs::write(&plist, format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
             <plist version=\"1.0\"><dict><key>Label</key><string>finance.tacit.prover</string>\
             <key>ProgramArguments</key><array><string>{}</string><string>serve</string></array>\
             <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>{}\
             <key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string></dict></plist>\n",
            exe.display(), pool::env_miner().map(|m| format!("<key>EnvironmentVariables</key><dict><key>TACIT_MINE</key><string>{m}</string></dict>")).unwrap_or_default(),
            log.display(), log.display())).map_err(|e| e.to_string())?;
        if !sh("launchctl", &["bootstrap", &domain, &plist.to_string_lossy()]) {
            return Err(format!("launchctl could not load {}", plist.display()));
        }
        Ok(format!("tacit-prover starts at login now and is starting ({}); its log is {}", plist.display(), log.display()))
    } else {
        let unit = home.join(".config/systemd/user/tacit-prover.service");
        if !on {
            sh("systemctl", &["--user", "disable", "--now", "tacit-prover"]);
            let _ = std::fs::remove_file(&unit);
            return Ok("tacit-prover no longer starts at login".into());
        }
        let _ = std::fs::create_dir_all(unit.parent().unwrap());
        let mine = pool::env_miner().map(|m| format!("Environment=TACIT_MINE={m}\n")).unwrap_or_default();
        std::fs::write(&unit, format!("[Unit]\nDescription=tacit-prover\n\n[Service]\nExecStart={} serve\n{mine}Restart=always\n\n[Install]\nWantedBy=default.target\n", exe.display()))
            .map_err(|e| e.to_string())?;
        if !(sh("systemctl", &["--user", "daemon-reload"]) && sh("systemctl", &["--user", "enable", "--now", "tacit-prover"])) {
            return Err(format!("systemctl could not start {}", unit.display()));
        }
        Ok(format!("tacit-prover starts at login now and is running ({})", unit.display()))
    }
}

fn store_dir() -> PathBuf {
    std::env::var_os("TACIT_PROVER_DIR").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".tacit-prover")
    })
}

fn serve(client: sp1_sdk::blocking::CpuProver, pk: sp1_sdk::SP1ProvingKey, vkey: String) {
    let port: u16 = std::env::var("TACIT_PROVER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(47815);
    let origins: Vec<String> = std::env::var("TACIT_PROVER_ORIGINS")
        .unwrap_or_else(|_| "https://tacit.finance,https://www.tacit.finance".into())
        .split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let dir = store_dir().join("proofs");
    let _ = std::fs::create_dir_all(&dir);

    // Proofs finished before a restart are still answered; a job's id is the hash of its input.
    let mut jobs = HashMap::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Some(id) = name.strip_suffix(".json") else { continue };
            let Ok(v) = serde_json::from_slice::<serde_json::Value>(&std::fs::read(e.path()).unwrap_or_default()) else { continue };
            jobs.insert(id.to_string(), Job {
                status: "done",
                secs: v["secs"].as_f64().unwrap_or(0.0),
                cycles: v["cycles"].as_u64().unwrap_or(0),
                public_values: v["publicValues"].as_str().unwrap_or_default().to_string(),
                proof: v["proof"].as_str().unwrap_or_default().to_string(),
                ..Default::default()
            });
        }
    }
    let state = Arc::new((Mutex::new(State { jobs, queue: VecDeque::new(), kick: false }), Condvar::new()));
    salt::start();
    // The help desk lends idle time only while no proof is running or waiting, and gives the memory back the moment one is.
    {
        let st = state.clone();
        helpdesk::start(helpdesk::Ctx {
            dir: store_dir(),
            miner: Box::new(pool::miner),
            busy: Arc::new(move || salt::PROVING.load(std::sync::atomic::Ordering::Relaxed) || !st.0.lock().unwrap().queue.is_empty()),
        });
    }

    // One proof at a time: a second would double the memory and halve each one's speed.
    {
        let state = state.clone();
        std::thread::spawn(move || loop {
            let (id, stdin) = {
                let (m, cv) = &*state;
                let mut s = m.lock().unwrap();
                // While mining, a minute with nothing of its own to prove is spent on the proof pool, one job at a time, and the
                // next job is leased as soon as one is proved; a proof asked for meanwhile waits for that one to finish. Mining
                // switched on from the page starts at once.
                let mut mined = false;
                while s.queue.is_empty() {
                    let wait = if mined || std::mem::take(&mut s.kick) { 1 } else { 60 };
                    let (g, t) = cv.wait_timeout(s, std::time::Duration::from_secs(wait)).unwrap();
                    s = g;
                    let kick = std::mem::take(&mut s.kick);
                    mined = false;
                    if (t.timed_out() || kick) && s.queue.is_empty() {
                        if let Some(miner) = pool::miner() {
                            drop(s);
                            salt::PROVING.store(true, std::sync::atomic::Ordering::Relaxed);
                            mined = pool::mine_one(&client, &pk, &miner);
                            salt::PROVING.store(false, std::sync::atomic::Ordering::Relaxed);
                            s = m.lock().unwrap();
                        }
                    }
                }
                let (id, stdin) = s.queue.pop_front().unwrap();
                if let Some(j) = s.jobs.get_mut(&id) {
                    j.status = "proving";
                    j.started = Some(Instant::now());
                }
                (id, stdin)
            };
            let mut job = Job { status: "proving", started: Some(Instant::now()), ..Default::default() };
            salt::PROVING.store(true, std::sync::atomic::Ordering::Relaxed);
            run(&client, &pk, stdin, &mut job);
            salt::PROVING.store(false, std::sync::atomic::Ordering::Relaxed);
            if job.status == "done" {
                let _ = std::fs::write(dir.join(format!("{id}.json")), job_json(&job).to_string());
            }
            eprintln!("tacit-prover: job {id} {} in {:.0} s", job.status, job.secs);
            state.0.lock().unwrap().jobs.insert(id, job);
        });
    }

    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind");
    eprintln!("tacit-prover: listening on 127.0.0.1:{port}");
    for conn in listener.incoming().flatten() {
        // A request that stalls (a header never finished, a body shorter than it said) is dropped rather than held for ever.
        let _ = conn.set_read_timeout(Some(std::time::Duration::from_secs(10)));
        let _ = conn.set_write_timeout(Some(std::time::Duration::from_secs(10)));
        let state = state.clone();
        let origins = origins.clone();
        let vkey = vkey.clone();
        std::thread::spawn(move || {
            let _ = handle(conn, &state, &origins, &vkey);
        });
    }
}

// A request line or header of at most this many bytes, and at most this many headers: enough for any browser, and a request
// that sends more is refused rather than read without end.
const MAX_LINE: u64 = 8 * 1024;
const MAX_HEADERS: usize = 64;

fn handle(mut conn: TcpStream, state: &Arc<(Mutex<State>, Condvar)>, origins: &[String], vkey: &str) -> std::io::Result<()> {
    let mut r = BufReader::new(conn.try_clone()?);
    let mut line = String::new();
    (&mut r).take(MAX_LINE).read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
    let (mut origin, mut host, mut len) = (String::new(), String::new(), 0usize);
    let mut headers = 0usize;
    loop {
        let mut h = String::new();
        if (&mut r).take(MAX_LINE).read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        headers += 1;
        if headers > MAX_HEADERS || !h.ends_with('\n') {
            return conn.write_all(b"HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
        if let Some((k, v)) = h.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "origin" => origin = v.trim().to_string(),
                "host" => host = v.trim().to_ascii_lowercase(),
                "content-length" => len = v.trim().parse().unwrap_or(0),
                _ => {}
            }
        }
    }
    // Only a request addressed to this machine by name is answered: a page on another site that has its name pointed at 127.0.0.1
    // (DNS rebinding) sends its own name as Host, and its same-site reads carry no Origin.
    let port = conn.local_addr().map(|a| a.port()).unwrap_or(0);
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return conn.write_all(b"HTTP/1.1 421 Misdirected Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
    // A page may use the prover only from an allowed origin; programs on this machine can reach 127.0.0.1 anyway.
    let allowed = origin.is_empty() || origins.iter().any(|o| o == &origin);
    let cors = if allowed && !origin.is_empty() {
        format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\nAccess-Control-Allow-Private-Network: true\r\n")
    } else {
        String::new()
    };
    let reply = |conn: &mut TcpStream, code: &str, body: String| -> std::io::Result<()> {
        write!(conn, "HTTP/1.1 {code}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{cors}Cache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len())
    };
    if !allowed {
        return reply(&mut conn, "403 Forbidden", r#"{"error":"origin not allowed"}"#.into());
    }
    if method == "OPTIONS" {
        let pre = format!("HTTP/1.1 204 No Content\r\n{cors}Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Max-Age: 600\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return conn.write_all(pre.as_bytes());
    }
    if len > 2 * MAX_INPUT + 1024 {
        return reply(&mut conn, "413 Payload Too Large", r#"{"error":"input over 1 MiB"}"#.into());
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
    match (method.as_str(), path) {
        ("GET", "/health") => {
            let s = state.0.lock().unwrap();
            let busy = s.jobs.values().any(|j| j.status == "proving") || pool::NOW.lock().unwrap().is_some();
            let gpu = tacit_leafhash::device();
            reply(&mut conn, "200 OK", serde_json::json!({"ok": true, "vkey": vkey, "busy": busy, "queued": s.queue.len(), "gpu": gpu}).to_string())
        }
        ("POST", "/prove") => {
            let raw: Option<Vec<u8>> = serde_json::from_slice::<serde_json::Value>(&body).ok()
                .and_then(|v| v.get("stdin").and_then(|s| s.as_str()).map(|s| s.trim_start_matches("0x").to_string()))
                .and_then(|h| hex::decode(h).ok())
                .filter(|b| b.len() <= MAX_INPUT);
            let Some(raw) = raw else {
                return reply(&mut conn, "400 Bad Request", r#"{"error":"stdin must be the 0x-hex of a bincode SP1Stdin"}"#.into());
            };
            let Some(stdin) = read_stdin(&raw) else {
                return reply(&mut conn, "400 Bad Request", r#"{"error":"stdin must be the 0x-hex of a bincode SP1Stdin"}"#.into());
            };
            let id = hex::encode(&Sha256::digest(&raw)[..16]);
            let (m, cv) = &**state;
            let mut s = m.lock().unwrap();
            // The same input asked for again (a page reloaded mid-proof) is the same job.
            let again = s.jobs.get(&id).is_some_and(|j| j.status != "failed");
            if !again && s.queue.len() >= MAX_QUEUED {
                return reply(&mut conn, "503 Service Unavailable", r#"{"error":"the prover has as many proofs waiting as it takes; ask again shortly"}"#.into());
            }
            if !again {
                s.jobs.insert(id.clone(), Job { status: "queued", ..Default::default() });
                s.queue.push_back((id.clone(), stdin));
                cv.notify_one();
            }
            reply(&mut conn, "200 OK", serde_json::json!({"id": id}).to_string())
        }
        ("GET", "/job") => {
            let id = query.split('&').find_map(|kv| kv.strip_prefix("id=")).unwrap_or("");
            let s = state.0.lock().unwrap();
            match s.jobs.get(id) {
                None => reply(&mut conn, "404 Not Found", r#"{"error":"no such job"}"#.into()),
                Some(j) => {
                    let mut o = job_json(j);
                    o["id"] = id.into();
                    reply(&mut conn, "200 OK", o.to_string())
                }
            }
        }
        // Mining as the page sees it: the address, on or off, the pool job being proved (its stage and an ETA) and how many
        // this run has proved. POST {miner?, on} switches it, kept across restarts.
        ("GET", "/mine") => reply(&mut conn, "200 OK", mine_json().to_string()),
        ("POST", "/mine") => {
            let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
            let Some(on) = v["on"].as_bool() else {
                return reply(&mut conn, "400 Bad Request", r#"{"error":"on must be true or false"}"#.into());
            };
            if let Err(e) = pool::set(v["miner"].as_str(), on) {
                return reply(&mut conn, "400 Bad Request", serde_json::json!({ "error": e }).to_string());
            }
            if on {
                let (m, cv) = &**state;
                m.lock().unwrap().kick = true;
                cv.notify_one();
            }
            reply(&mut conn, "200 OK", mine_json().to_string())
        }
        // The community help desk: on or off, where its API is, whether the model is installed and running, how many answers this
        // run has given. POST {on, api?} switches it, kept across restarts.
        ("GET", "/helpdesk") => reply(&mut conn, "200 OK", helpdesk::status(&store_dir(), pool::miner()).to_string()),
        ("POST", "/helpdesk") => {
            let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
            let Some(on) = v["on"].as_bool() else {
                return reply(&mut conn, "400 Bad Request", r#"{"error":"on must be true or false"}"#.into());
            };
            if let Err(e) = helpdesk::set(&store_dir(), on, v["api"].as_str()) {
                return reply(&mut conn, "400 Bad Request", serde_json::json!({ "error": e }).to_string());
            }
            reply(&mut conn, "200 OK", helpdesk::status(&store_dir(), pool::miner()).to_string())
        }
        _ => reply(&mut conn, "404 Not Found", r#"{"error":"not found"}"#.into()),
    }
}

fn mine_json() -> serde_json::Value {
    let set = pool::setting();
    let miner = set.as_ref().and_then(|s| s["miner"].as_str().map(str::to_string)).or_else(pool::env_miner);
    let job = pool::NOW.lock().unwrap().clone().map(|(id, t)| {
        let mut o = serde_json::json!({ "id": id, "secs": t.elapsed().as_secs_f64().round() });
        if let Some((stage, eta)) = progress::now(&store_dir()) {
            o["stage"] = stage.into();
            if let Some(eta) = eta {
                o["eta"] = eta.round().into();
            }
        }
        o
    });
    serde_json::json!({ "miner": miner, "on": pool::miner().is_some(), "job": job, "proved": pool::DONE.load(std::sync::atomic::Ordering::Relaxed), "salt": salt::status() })
}

// The GPU leaf hash against SP1's own outer hasher on random rows of several widths, with timings.
fn check() -> bool {
    let ext = check_ext_mul();
    let cpu = check_inner_perm() && ext;
    let gpu = check_gpu();
    let g16 = check_groth16();
    check_grind() && gpu && cpu && g16
}

// The quartic extension's product (p3-koala-bear's binomial_mul_4, through p3-field's BinomialExtensionField Mul) against
// the schoolbook it replaces, on random elements and on 0, 1 and p - 1 in every coefficient, and the two timed.
fn check_ext_mul() -> bool {
    use rand::Rng;
    use slop_algebra::extension::{BinomialExtensionField, BinomiallyExtendable};
    use slop_algebra::{AbstractExtensionField, AbstractField};
    use slop_koala_bear::{generic_binomial_mul_4, KoalaBear};
    type E = BinomialExtensionField<KoalaBear, 4>;
    let w = <KoalaBear as BinomiallyExtendable<4>>::w();
    let mut rng = rand::thread_rng();
    let edge = [0u32, 1, 0x7f000000];
    let mut pairs: Vec<([KoalaBear; 4], [KoalaBear; 4])> = (0..1 << 20)
        .map(|_| {
            let f = |rng: &mut rand::rngs::ThreadRng| core::array::from_fn(|_| KoalaBear::from_canonical_u32(rng.gen_range(0..0x7f000001)));
            (f(&mut rng), f(&mut rng))
        })
        .collect();
    for x in edge {
        for y in edge {
            pairs.push(([KoalaBear::from_canonical_u32(x); 4], [KoalaBear::from_canonical_u32(y); 4]));
        }
    }
    let t = Instant::now();
    let slow: Vec<[KoalaBear; 4]> = pairs.iter().map(|(a, b)| generic_binomial_mul_4(a, b, w)).collect();
    let ts = t.elapsed();
    let t = Instant::now();
    let fast: Vec<[KoalaBear; 4]> = pairs.iter().map(|(a, b)| KoalaBear::binomial_mul_4(a, b, w)).collect();
    let tf = t.elapsed();
    let ext = |v: &[KoalaBear; 4]| <E as AbstractExtensionField<KoalaBear>>::from_base_slice(v);
    let via_mul: Vec<E> = pairs.iter().map(|(a, b)| ext(a) * ext(b)).collect();
    let ok = fast == slow && via_mul.iter().zip(&slow).all(|(e, s)| <E as AbstractExtensionField<KoalaBear>>::as_base_slice(e) == &s[..]);
    let n = pairs.len() as f64;
    println!(
        "KoalaBear quartic extension product, {} pairs: {}  schoolbook {:.1} ns, this one {:.1} ns",
        pairs.len(),
        if ok { "equal" } else { "DIFFERENT" },
        ts.as_nanos() as f64 / n,
        tf.as_nanos() as f64 / n
    );
    ok
}

// The Groth16 step's lean prover (patches/sp1-recursion-gnark-ffi go/sp1/prove_lean.go): a circuit with a commitment
// proved with its multi-exponentiations in blocks (and its G1 ones on the GPU, on a Mac) and verified, a changed proof
// refused, and blocked multi-exponentiations on G1 and G2, and the GPU's G1 one, equal to gnark's whole ones.
fn check_groth16() -> bool {
    let t = Instant::now();
    match sp1_recursion_gnark_ffi::ffi::check_lean_groth16_bn254() {
        Ok(()) => {
            println!("Groth16 lean prover: proofs in blocks of 0, 1, 7 and 64 bases (with the GPU's G1 sums, on a Mac) verify, a changed one does not, and blocked G1/G2 sums and the GPU's G1 sum equal whole ones ({:.1} s)", t.elapsed().as_secs_f64());
            true
        }
        Err(e) => {
            println!("Groth16 lean prover: FAILED: {e}");
            false
        }
    }
}

// The wrap stage's proof-of-work: for buffered inputs of several lengths, the GPU's nonce must be the least one the
// challenger itself accepts (every smaller nonce refused), then a 22-bit search is timed as the wrap stage runs it.
fn check_grind() -> bool {
    use rand::Rng;
    use slop_algebra::{AbstractField, PrimeField32};
    use slop_bn254::{outer_perm, Bn254Fr, OuterPerm};
    use slop_challenger::{CanObserve, GrindingChallenger, MultiField32Challenger};
    use slop_koala_bear::KoalaBear;
    type C = MultiField32Challenger<KoalaBear, Bn254Fr, OuterPerm, 3, 2>;
    if tacit_leafhash::device().is_none() {
        return true;
    }
    let mut rng = rand::thread_rng();
    let mut ok = true;
    for plen in [0usize, 1, 7, 8, 15] {
        let mut c = C::new(outer_perm()).unwrap();
        for _ in 0..16 + plen {
            c.observe(KoalaBear::from_canonical_u32(rng.gen_range(0..0x7f000001)));
        }
        let mut g = c.clone();
        let w = g.grind(10);
        let least = (0..w.as_canonical_u32()).all(|x| !c.clone().check_witness(10, KoalaBear::from_canonical_u32(x)));
        let same = least && c.clone().check_witness(10, w);
        ok &= same;
        println!("proof-of-work, {plen:2} inputs buffered: nonce {} {}", w.as_canonical_u32(), if same { "is the least the challenger accepts" } else { "DIFFERS" });
    }
    let mut c = C::new(outer_perm()).unwrap();
    c.observe(KoalaBear::from_canonical_u32(rng.gen_range(0..0x7f000001)));
    let t = Instant::now();
    let w = c.clone().grind(22);
    println!("22-bit proof-of-work on the GPU: nonce {} in {:.2} s", w.as_canonical_u32(), t.elapsed().as_secs_f64());
    ok
}

// The core and recursion stages' Poseidon2 (KoalaBear, width 16): the patched NEON permutation against the scalar one, which
// p3-koala-bear computes by a separate route (shifts instead of a diagonal product).
fn check_inner_perm() -> bool {
    use rand::Rng;
    use slop_algebra::AbstractField;
    use slop_koala_bear::{my_kb_16_perm, KoalaBear};
    use slop_symmetric::Permutation;
    let perm = my_kb_16_perm();
    let mut rng = rand::thread_rng();
    let n = 1 << 16;
    let states: Vec<[KoalaBear; 16]> = (0..n).map(|_| core::array::from_fn(|_| KoalaBear::from_canonical_u32(rng.gen_range(0..0x7f000001)))).collect();
    let t = Instant::now();
    let scalar: Vec<[KoalaBear; 16]> = states.iter().map(|s| perm.permute(*s)).collect();
    let ts = t.elapsed();
    #[cfg(all(target_arch = "aarch64", target_feature = "neon"))]
    {
        use slop_koala_bear::PackedKoalaBearNeon as P;
        let t = Instant::now();
        let mut same = true;
        for (q, want) in states.chunks(4).zip(scalar.chunks(4)) {
            let out = perm.permute(core::array::from_fn::<P, 16, _>(|j| P(core::array::from_fn(|l| q[l][j]))));
            same &= (0..4).all(|l| (0..16).all(|j| out[j].0[l] == want[l][j]));
        }
        let tp = t.elapsed();
        println!("{n} KoalaBear Poseidon2 states: NEON {} the scalar permutation; scalar {:.2} us, NEON {:.2} us per state (one thread)",
            if same { "equals" } else { "DIFFERS FROM" }, ts.as_secs_f64() * 1e6 / n as f64, tp.as_secs_f64() * 1e6 / n as f64);
        same
    }
    #[cfg(not(all(target_arch = "aarch64", target_feature = "neon")))]
    {
        let _ = (scalar, ts);
        true
    }
}

fn check_gpu() -> bool {
    use rand::Rng;
    use slop_algebra::{AbstractField, PrimeField32};
    use slop_bn254::{outer_perm, Bn254Fr, OuterPerm};
    use slop_koala_bear::KoalaBear;
    use slop_symmetric::{CryptographicHasher, Hash, MultiField32PaddingFreeSponge};
    type H = MultiField32PaddingFreeSponge<KoalaBear, Bn254Fr, OuterPerm, 3, 16, 1>;
    let Some(dev) = tacit_leafhash::device() else {
        println!("no GPU leaf hashing here (macOS with Metal only, and TACIT_METAL unset); proofs hash on the CPU");
        return true;
    };
    let h = H::new(outer_perm()).unwrap();
    let mut rng = rand::thread_rng();
    let mut ok = true;
    for (n, width) in [(4096usize, 1usize), (8192, 7), (16384, 16), (16384, 17), (8192, 136)] {
        let rows: Vec<KoalaBear> = (0..n * width).map(|_| KoalaBear::from_canonical_u32(rng.gen_range(0..0x7f000001))).collect();
        let t = Instant::now();
        let cpu: Vec<[u64; 4]> = rows.chunks(width).map(|r| {
            let d: Hash<KoalaBear, Bn254Fr, 1> = h.hash_iter(r.iter().copied());
            let d: [Bn254Fr; 1] = d.into();
            unsafe { std::mem::transmute::<Bn254Fr, [u64; 4]>(d[0]) }
        }).collect();
        let tc = t.elapsed();
        let monty: Vec<u32> = rows.iter().map(|v| unsafe { std::mem::transmute::<KoalaBear, u32>(*v) }).collect();
        let canonical: Vec<u32> = rows.iter().map(|v| v.as_canonical_u32()).collect();
        let mut g1 = vec![[0u64; 4]; n];
        let mut g2 = vec![[0u64; 4]; n];
        let t = Instant::now();
        let ran = tacit_leafhash::hash_rows(&monty, width, true, &mut g1) && tacit_leafhash::hash_rows(&canonical, width, false, &mut g2);
        let tg = t.elapsed() / 2;
        let same = ran && g1 == cpu && g2 == cpu;
        ok &= same;
        println!("{n:6} rows x {width:3}: {}  CPU (one thread) {:.1} us/row, GPU ({dev}) {:.2} us/row",
            if same { "equal" } else { "DIFFERENT" }, tc.as_secs_f64() * 1e6 / n as f64, tg.as_secs_f64() * 1e6 / n as f64);
    }
    // The tree's layers above the leaves: each node Poseidon2([left, right, 0])[0], as p3's TruncatedPermutation<_, 2, 1, 3>.
    use slop_symmetric::{PseudoCompressionFunction, TruncatedPermutation};
    let c = TruncatedPermutation::<OuterPerm, 2, 1, 3>::new(outer_perm());
    for n in [4096usize, 1 << 16] {
        let prev: Vec<[Bn254Fr; 1]> = (0..2 * n).map(|_| [Bn254Fr::from_canonical_u64(rng.gen()) * Bn254Fr::from_canonical_u64(rng.gen())]).collect();
        let t = Instant::now();
        let cpu: Vec<[u64; 4]> = prev.chunks(2).map(|p| unsafe { std::mem::transmute::<Bn254Fr, [u64; 4]>(c.compress([p[0], p[1]])[0]) }).collect();
        let tc = t.elapsed();
        let mut gpu = vec![[0u64; 4]; n];
        let t = Instant::now();
        let ran = tacit_leafhash::compress_pairs(unsafe { std::slice::from_raw_parts(prev.as_ptr() as *const [u64; 4], 2 * n) }, &mut gpu);
        let tg = t.elapsed();
        let same = ran && gpu == cpu;
        ok &= same;
        println!("{n:6} nodes:       {}  CPU (one thread) {:.1} us/node, GPU ({dev}) {:.2} us/node",
            if same { "equal" } else { "DIFFERENT" }, tc.as_secs_f64() * 1e6 / n as f64, tg.as_secs_f64() * 1e6 / n as f64);
    }
    // The core and recursion stages' trees: KoalaBear rows and nodes against slop's own sponge and compressor.
    {
        use slop_koala_bear::{my_kb_16_perm, KoalaBear, KoalaPerm};
        use slop_symmetric::{PaddingFreeSponge, PseudoCompressionFunction, TruncatedPermutation};
        let h = PaddingFreeSponge::<KoalaPerm, 16, 8, 8>::new(my_kb_16_perm());
        let c = TruncatedPermutation::<KoalaPerm, 2, 8, 16>::new(my_kb_16_perm());
        let raw = |v: &KoalaBear| unsafe { std::mem::transmute::<KoalaBear, u32>(*v) };
        for (n, width) in [(4096usize, 1usize), (8192, 7), (8192, 8), (8192, 9), (16384, 16), (8192, 33), (4096, 136)] {
            let rows: Vec<KoalaBear> = (0..n * width).map(|_| KoalaBear::from_canonical_u32(rng.gen_range(0..0x7f000001))).collect();
            let t = Instant::now();
            let cpu: Vec<[u32; 8]> = rows.chunks(width).map(|r| h.hash_iter(r.iter().copied()).map(|x| raw(&x))).collect();
            let tc = t.elapsed();
            let words: Vec<u32> = rows.iter().map(raw).collect();
            let mut gpu = vec![[0u32; 8]; n];
            let t = Instant::now();
            let same = tacit_leafhash::kb_hash_rows(&words, width, &mut gpu) && gpu == cpu;
            let tg = t.elapsed();
            ok &= same;
            println!("KoalaBear {n:6} rows x {width:3}: {}  CPU (one thread) {:.2} us/row, GPU {:.3} us/row",
                if same { "equal" } else { "DIFFERENT" }, tc.as_secs_f64() * 1e6 / n as f64, tg.as_secs_f64() * 1e6 / n as f64);
        }
        let n = 1 << 16;
        let prev: Vec<[KoalaBear; 8]> = (0..2 * n).map(|_| core::array::from_fn(|_| KoalaBear::from_canonical_u32(rng.gen_range(0..0x7f000001)))).collect();
        let t = Instant::now();
        let cpu: Vec<[u32; 8]> = prev.chunks(2).map(|p| c.compress([p[0], p[1]]).map(|x| raw(&x))).collect();
        let tc = t.elapsed();
        let words: Vec<[u32; 8]> = prev.iter().map(|d| d.map(|x| raw(&x))).collect();
        let mut gpu = vec![[0u32; 8]; n];
        let t = Instant::now();
        let same = tacit_leafhash::kb_compress_pairs(&words, &mut gpu) && gpu == cpu;
        let tg = t.elapsed();
        ok &= same;
        println!("KoalaBear {n:6} nodes:      {}  CPU (one thread) {:.2} us/node, GPU {:.3} us/node",
            if same { "equal" } else { "DIFFERENT" }, tc.as_secs_f64() * 1e6 / n as f64, tg.as_secs_f64() * 1e6 / n as f64);
    }
    ok
}
