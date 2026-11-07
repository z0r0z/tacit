// Tacit's prover worker. It claims jobs from the prover board, proves each on this machine's GPU with the pinned guest and
// posts the proof back; the relay checks every proof against the pool before using it, and a job nobody proves in time goes
// to the prover network, so a worker that stops only stops helping.
//
//   POST {BOARD_URL}/prover/claim   { worker, classes }      → { job: { jobId, stdin (base64 bincode SP1Stdin), cycleLimit, deadline } } | {}
//   POST {BOARD_URL}/prover/result  { jobId, publicValues, proof } | { jobId, error }
//
// Env: BOARD_URL, WORKER_TOKEN (the bearer the API knows this worker by), WORKER_NAME (for the log), CLASSES
// ("private,public"; the API gives only what the token allows), POLL_MS (default 3000), EXPECT_VKEY (the pool's PROGRAM_VKEY;
// the worker refuses to start on another), WARM=0 to skip the warm-up proof at start.
// BENCH=<dir>: no board; every `*.bin` in the directory (a bincode SP1Stdin, as tests/fixtures/sp1-stdin holds them) is
// proved BENCH_RUNS times (default 3) and the times are printed, cold first. This is how a machine is measured.
// POOL (default 1): with nothing from the board, the worker proves the API's proof pool (wraps pages keep ready, whose inputs hold
// no secret). Tacit's own box leases with its token, which the API credits nothing, and only a job that has waited POOL_MIN_AGE_SECS
// (default 600, so the people mining it for points get it first); a community worker leases in its miner's name, as a miner, for the
// pool's points (until the pool pays the address nothing more that UTC day, unless POOL_UNPAID=1). A lease is asked for at most every
// POOL_EVERY_SECS (default 30), and the lease in hand is kept in POOL_LEASE_FILE (default /workspace/pool-lease.json) until its proof is
// sent, so a worker that restarts proves it again instead of letting it run out.
//   POST {BOARD_URL}/prover/pool/lease  { minAgeMs } (token) | { miner } (community)  → { id, stdin (0x bincode SP1Stdin), lease, points } | 204
//   POST {BOARD_URL}/prover/pool/submit { id, lease, publicValues, proof } | { id, lease, error }
// ETH_STATE (default 1): the worker also proves the Ethereum-state input eth_prove posts (program 'eth-state', class 'eth-state',
// which the API offers only to a token trusted with 'private' or 'eth-state' work): the eth-reflection guest (pinned in build.rs),
// proved compressed (the form the Bitcoin reflection guest verifies inside itself) and sent back as the base64 of the bincode
// SP1ProofWithPublicValues, which eth_prove's finish mode checks before it is used. Its proving key is set up on the first such
// job and refused (and the program dropped from the claims) unless its recursion digest is ETH_REFLECTION_VKEY.
// BTC_STATE (default 0): the worker also proves the Bitcoin-state input bitcoin_prove posts (program 'btc-state', public work: its
// input is Bitcoin's blocks and a public Ethereum proof): the Bitcoin reflection guest (elf/reflection-prover, pinned in build.rs),
// proved groth16 and sent back as the hex of the proof bytes attestBitcoinStateProven takes. Its key is set up on the first such
// job and refused (and the program dropped from the claims) unless it is the pool's BITCOIN_RELAY_VKEY. A batch is billions of
// cycles, tens of minutes on one GPU, and a proof cannot be stopped once it starts, so it is off by default: on a box that also
// proves users' settles, a settle that comes in meanwhile waits for it. BTC_JOB_TIMEOUT_SECS (default 7200) is its watchdog limit.
// COMMUNITY_MINER=0x<address> (community mode): no token. The worker takes its turn at the board's public Bitcoin-state batches (the board
// gives each batch to one machine, in turn) through the open community routes (POST /prover/community/claim { miner, programs: ["btc-state"] }
// and /prover/community/result { miner, jobId, ... }),
// and each batch the relay takes earns that address the board's points for it (TAC from the points service). BTC_STATE=0 takes no
// turns: a card under 24 GB, which the installer gives a smaller GPU server, proves the pool's wraps alone. The warm-up pings, which are
// for Tacit's own tokens, are off. Between jobs its spare CPU cores grind deploy salts for the same address (salt.rs; SALT_THREADS, half
// the cores by default, 0 is off). Tacit's own box grinds too, earning nothing (the pool gives the house no weight), when SALT_MINER
// names the house address (the deployer).
// GPU_DEVICE (default 0): the card to prove on, as nvidia-smi numbers them (with CUDA_DEVICE_ORDER=PCI_BUS_ID, CUDA numbers them the same
// way); prove-gpu.sh names the card with the most memory, so a machine whose first card drives its display proves on the bigger one.
// RELOAD_FLAG (default /workspace/worker.reload): when that file exists and no job is in hand, the worker removes it and
// exits 0, so the loop around it starts a fresh worker (and GPU server) with whatever binary and env are now in place,
// never in the middle of a proof.
//
// The prover client and the proving key are built once: the cost of a proof on a warm GPU is the proof, not the start-up.

mod salt;
use std::time::{Duration, Instant};

use aes_gcm::{aead::{Aead, KeyInit, Payload}, Aes256Gcm, Nonce};
use base64::Engine;
use k256::{ecdh::diffie_hellman, elliptic_curve::sec1::ToEncodedPoint, PublicKey, SecretKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    Elf, HashableKey, ProvingKey, SP1Stdin,
};

const ELF: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../elf/cxfer-guest"));
const ETH_ELF: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../eth-reflection/elf/eth_reflection"));
const BTC_ELF: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../elf/reflection-prover"));
// The tacit chain's block program (contracts/sp1/confidential/tacit-block), and the key its landing contract verifies under
// (TacitBlocks.BLOCK_VKEY): a block proof is public work, any machine that proves it may race for it.
const BLOCK_ELF: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../tacit-block/elf/tacit-block"));
const TACIT_BLOCK_VKEY: &str = "0x000ffc78504d1d7d2a42562db9d683d5f94c11a7feae3c14beaf37fc76ed5880";
// The pool's BITCOIN_RELAY_VKEY (contracts/deployments/1.json, elf-vkey-pin.json): the key a Bitcoin-state proof must verify under.
const BITCOIN_RELAY_VKEY: &str = "0x00bb158ba04f18a100f998af0e3b074b5368771f22b8b6e4fd1d66823a074bc5";
// The recursion digest of the eth-reflection guest's key, as the Bitcoin reflection guest checks it (reflect.rs).
const ETH_REFLECTION_VKEY: [u32; 8] =
    [1698740370, 761725306, 1843717690, 1218893588, 786585592, 423901230, 1310805602, 795535986];

#[derive(Deserialize)]
struct Claim {
    job: Option<Job>,
}
#[derive(Deserialize)]
struct Job {
    #[serde(rename = "jobId")]
    job_id: String,
    stdin: Option<String>,
    sealed: Option<Sealed>,
    #[serde(rename = "cycleLimit")]
    cycle_limit: Option<f64>,
    deadline: Option<f64>,
    label: Option<String>,
    // 'confidential' (absent from an older API), 'eth-state' or 'btc-state'.
    program: Option<String>,
}

// An input the page encrypted to this worker alone (dapp/sealed-input.js): `epk` the page's one-time secp256k1 public key
// (33 bytes, hex), `iv` 12 bytes and `ct` the AES-256-GCM ciphertext with its tag (base64). The key is
// SHA-256("tacit-sealed-input-v1" ‖ ECDH x-coordinate ‖ this worker's public key ‖ epk); the plaintext is the bincode
// SP1Stdin. Nothing but this worker's key opens it: the API and the relay only ever hold the ciphertext.
#[derive(Deserialize)]
struct Sealed {
    epk: String,
    iv: String,
    ct: String,
}
const SEALED_DOMAIN: &[u8] = b"tacit-sealed-input-v1";

fn env_or(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

// This worker's long-lived key, kept at WORKER_KEY_FILE (default /workspace/worker.key, 32 bytes hex) and made on first use.
fn worker_key() -> SecretKey {
    let path = env_or("WORKER_KEY_FILE", "/workspace/worker.key");
    if let Ok(h) = std::fs::read_to_string(&path) {
        let b = hex::decode(h.trim().trim_start_matches("0x")).expect("WORKER_KEY_FILE holds hex");
        return SecretKey::from_slice(&b).expect("WORKER_KEY_FILE holds a secp256k1 key");
    }
    let sk = SecretKey::random(&mut rand::thread_rng());
    std::fs::write(&path, hex::encode(sk.to_bytes())).expect("write WORKER_KEY_FILE");
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)); }
    sk
}

fn unseal(sk: &SecretKey, my_pub: &[u8], s: &Sealed) -> Result<Vec<u8>, String> {
    let epk_bytes = hex::decode(s.epk.trim_start_matches("0x")).map_err(|e| format!("sealed.epk is not hex: {e}"))?;
    let epk = PublicKey::from_sec1_bytes(&epk_bytes).map_err(|e| format!("sealed.epk is not a secp256k1 point: {e}"))?;
    let shared = diffie_hellman(sk.to_nonzero_scalar(), epk.as_affine());
    let mut h = Sha256::new();
    h.update(SEALED_DOMAIN);
    h.update(shared.raw_secret_bytes());
    h.update(my_pub);
    h.update(&epk_bytes);
    let key = h.finalize();
    let iv = base64::engine::general_purpose::STANDARD.decode(&s.iv).map_err(|e| format!("sealed.iv is not base64: {e}"))?;
    let ct = base64::engine::general_purpose::STANDARD.decode(&s.ct).map_err(|e| format!("sealed.ct is not base64: {e}"))?;
    if iv.len() != 12 { return Err("sealed.iv must be 12 bytes".into()); }
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    cipher.decrypt(Nonce::from_slice(&iv), Payload { msg: &ct, aad: SEALED_DOMAIN }).map_err(|_| "the sealed input does not open with this worker's key".to_string())
}

fn main() {
    // UNSEAL_TEST=<file>: open a sealed input ({ epk, iv, ct } as JSON) with this worker's key, print the SHA-256 of what is
    // inside, and exit: how the page's sealing (dapp/sealed-input.js) is checked against this side without a GPU.
    if let Ok(path) = std::env::var("UNSEAL_TEST") {
        let sk = worker_key();
        let my_pub = sk.public_key().to_encoded_point(true).as_bytes().to_vec();
        let s: Sealed = serde_json::from_str(&std::fs::read_to_string(&path).expect("read UNSEAL_TEST")).expect("UNSEAL_TEST is { epk, iv, ct }");
        match unseal(&sk, &my_pub, &s) {
            Ok(pt) => { println!("UNSEAL_OK bytes={} sha256={}", pt.len(), hex::encode(Sha256::digest(&pt))); return; }
            Err(e) => { println!("UNSEAL_FAILED {e}"); std::process::exit(1); }
        }
    }
    let bench = std::env::var("BENCH").ok();
    let base = env_or("BOARD_URL", "https://api.tacit.finance").trim_end_matches('/').to_string();
    // Community mode: an address to be paid, no token.
    let community = std::env::var("COMMUNITY_MINER").ok().map(|a| a.trim().to_lowercase());
    if let Some(a) = &community {
        assert!(a.len() == 42 && a.starts_with("0x") && a[2..].chars().all(|c| c.is_ascii_hexdigit()), "COMMUNITY_MINER must be the 0x address the points go to");
    }
    let token = if bench.is_some() || community.is_some() { String::new() } else { std::env::var("WORKER_TOKEN").expect("WORKER_TOKEN is the bearer the API knows this worker by") };
    let name = env_or("WORKER_NAME", "worker");
    let classes: Vec<String> = env_or("CLASSES", "private,public").split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let poll = Duration::from_millis(env_or("POLL_MS", "1000").parse().expect("POLL_MS"));
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(60)).build();

    // While it starts (the prover built, the GPU warmed: about a minute) the worker tells the board it is coming, every ten seconds, so
    // the relay keeps sending jobs here and they wait the minute instead of going to the network. PAUSE_FLAG (default
    // /workspace/worker.pause) silences it: the worker neither claims nor pings while the file exists, and the relay then sends its jobs to
    // the network, which is how the fallback is tested on purpose.
    let pause_flag = env_or("PAUSE_FLAG", "/workspace/worker.pause");
    let warming = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    {
        let warming = warming.clone();
        let (base, token, name, pause_flag) = (base.clone(), token.clone(), name.clone(), pause_flag.clone());
        std::thread::spawn(move || {
            let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(20)).build();
            while warming.load(std::sync::atomic::Ordering::Relaxed) {
                if !token.is_empty() && !std::path::Path::new(&pause_flag).exists() {
                    let _ = agent.post(&format!("{base}/prover/claim")).set("Authorization", &format!("Bearer {token}"))
                        .send_json(serde_json::json!({ "worker": name, "classes": ["private"], "warming": true }));
                }
                std::thread::sleep(Duration::from_secs(10));
            }
        });
    }
    println!("[{name}] building the CUDA prover and the proving key (once)...");
    let t0 = Instant::now();
    let device: u32 = env_or("GPU_DEVICE", "0").trim().parse().expect("GPU_DEVICE is a card's number, as nvidia-smi gives it");
    let client = ProverClient::builder().cuda().with_device_id(device).build();
    let pk = client.setup(Elf::Static(ELF)).expect("setup failed");
    let vk = pk.verifying_key().bytes32();
    println!("[{name}] VKEY={vk} ({:.1} s)", t0.elapsed().as_secs_f64());
    if let Ok(expect) = std::env::var("EXPECT_VKEY") {
        assert_eq!(
            vk.trim().trim_start_matches("0x").to_lowercase(),
            expect.trim().trim_start_matches("0x").to_lowercase(),
            "EXPECT_VKEY mismatch: this guest is not the pool's program"
        );
    }
    if let Some(dir) = bench {
        let runs: usize = env_or("BENCH_RUNS", "3").parse().expect("BENCH_RUNS");
        let mut files: Vec<_> = std::fs::read_dir(&dir).expect("BENCH dir").filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().map(|x| x == "bin").unwrap_or(false)).collect();
        files.sort();
        for f in files {
            let bytes = std::fs::read(&f).expect("read");
            let stdin: SP1Stdin = match bincode::deserialize(&bytes) { Ok(s) => s, Err(e) => { println!("BENCH {} skipped: {e}", f.display()); continue; } };
            for i in 0..runs {
                let t = Instant::now();
                match client.prove(&pk, stdin.clone()).groth16().cycle_limit(512_000_000).run() {
                    Ok(p) => println!("BENCH {} run {} {:.1} s pv={} proof={}", f.file_name().unwrap().to_string_lossy(), i + 1, t.elapsed().as_secs_f64(), p.public_values.as_slice().len(), p.bytes().len()),
                    Err(e) => println!("BENCH {} run {} FAILED after {:.1} s: {e}", f.file_name().unwrap().to_string_lossy(), i + 1, t.elapsed().as_secs_f64()),
                }
            }
        }
        return;
    }
    if env_or("WARM", "1") == "1" {
        // A first proof builds the recursion and wrap provers and loads the Groth16 artifacts; done now, not on a user's job.
        // The guest is run on an input it stops on at once, so the warm-up proves nothing about the pool; stopping is
        // enough for the stages that need warming.
        let t = Instant::now();
        let mut s = SP1Stdin::new();
        for _ in 0..6 { s.write(&vec![0u8; 32]); }
        s.write(&0u32); // num_ops = 0: no ops, no memo hashes
        match client.prove(&pk, s).groth16().run() {
            Ok(_) => println!("[{name}] warm ({:.1} s)", t.elapsed().as_secs_f64()),
            Err(e) => println!("[{name}] warm-up did not prove ({e}); the first job pays the start-up"),
        }
    }

    warming.store(false, std::sync::atomic::Ordering::Relaxed);
    let reload_flag = env_or("RELOAD_FLAG", "/workspace/worker.reload");
    let reload_due = || std::path::Path::new(&reload_flag).exists();
    let (claim_url, result_url) = if community.is_some() {
        (format!("{base}/prover/community/claim"), format!("{base}/prover/community/result"))
    } else {
        (format!("{base}/prover/claim"), format!("{base}/prover/result"))
    };
    let auth = format!("Bearer {token}");
    let sk = worker_key();
    let my_pub = sk.public_key().to_encoded_point(true).as_bytes().to_vec();
    let my_pub_hex = format!("0x{}", hex::encode(&my_pub));
    println!("[{name}] sealed inputs may be encrypted to {my_pub_hex}");
    let mut quiet = 0u32;
    // A GPU server that died (the client then reports a lost connection) or a run of failed jobs is not something this
    // process can mend: it exits, and the loop around it starts a fresh worker and server. Three in a row, so one bad
    // input does not restart a healthy worker.
    let mut failed_in_a_row = 0u32;
    // A GPU server is not kept for ever. Measured 2026-10-17: a fresh server makes the Groth16 proof in 6-8 s; after a while it falls into
    // a regime where every proof takes 100 s (the GPU's part done on the CPU, by the look of the constant time) and stays there until it is
    // restarted, and once it hung there. So the worker exits, and the loop starts a fresh server, when two proofs in a row took longer than
    // SLOW_PROOF_SECS (at once: the next job would be slow too), and after JOBS_PER_SERVER jobs at the first moment it has nothing in hand,
    // so the planned restart (about a minute) falls between jobs and not in front of one; 2 x JOBS_PER_SERVER is the most it waits for that.
    // The slow regime's warning (below) restarts a server that is going slow, so the planned one is only a backstop: measured 2026-10-27, 121 of
    // 224 servers warned (after 18 jobs, the median) and 73 reached 40 jobs with no warning at all, each then restarted for nothing.
    let jobs_per_server = env_or("JOBS_PER_SERVER", "100").parse::<u32>().unwrap_or(100);
    let slow_secs = env_or("SLOW_PROOF_SECS", "90").parse::<f64>().unwrap_or(90.0);
    let mut jobs_done = 0u32;
    let mut slow_in_a_row = 0u32;
    // The warning stage: before a server falls into the 100 s regime its Groth16 step runs 16-31 s for two or three proofs (ICICLE chunks the
    // G2 multiplication as free GPU memory shrinks). run-worker.sh watches the server's log for that and creates RECYCLE_FLAG; the worker then
    // restarts at the first moment it has nothing in hand, and after at most RECYCLE_MAX_JOBS more jobs, so users meet one restart and not
    // two slow proofs.
    let recycle_flag = env_or("RECYCLE_FLAG", "/workspace/worker.recycle");
    let recycle_max = env_or("RECYCLE_MAX_JOBS", "2").parse::<u32>().unwrap_or(2);
    let mut recycle_from: Option<u32> = None;
    // A board job that comes in while a pool wrap is proved waits that one proof (under a minute here), well inside the relay's
    // PROVER_BOARD_WAIT_SECS before it would go to the prover network.
    let pool_on = env_or("POOL", "1") == "1";
    let pool_lease_file = env_or("POOL_LEASE_FILE", "/workspace/pool-lease.json");
    let pool_unpaid = env_or("POOL_UNPAID", "0") == "1";
    // the UTC day on which the pool will lease this worker nothing more (or pay its address nothing more)
    let mut pool_rest_day: Option<u64> = None;
    let pool_min_age_ms = env_or("POOL_MIN_AGE_SECS", "600").parse::<u64>().unwrap_or(600) * 1000;
    let pool_every = Duration::from_secs(env_or("POOL_EVERY_SECS", "30").parse::<u64>().unwrap_or(30));
    let mut pool_last: Option<Instant> = None;
    // Users first on a single box. A proof cannot be stopped once it starts, so a user's job that arrives while a pool wrap runs waits
    // for it (measured 2026-10-26: 41 of 247 user jobs started the moment a pool wrap ended). So pool wraps fill quiet stretches only:
    // a lease is asked for after POOL_IDLE_SECS (default 20) with no board job claimed or in hand, and at most POOL_MAX_PER_HOUR
    // (default 60) an hour, so the kept-ready wraps people's first deposits use still fill the quiet stretches. The pool's wraps are kept-ready vouchers, never on a user's path, and miners still lease them first.
    let pool_idle = Duration::from_secs(env_or("POOL_IDLE_SECS", "20").parse::<u64>().unwrap_or(20));
    let pool_max_hour = env_or("POOL_MAX_PER_HOUR", "60").parse::<usize>().unwrap_or(60);
    let mut board_last = Instant::now();
    let mut pool_hour: std::collections::VecDeque<Instant> = std::collections::VecDeque::new();
    // The Ethereum-state program: claimed while ETH_STATE is on and its key has not been refused (set up on the first job).
    let eth_on = env_or("ETH_STATE", "1") == "1";
    let mut eth_key: Option<Result<_, String>> = None;
    // The Bitcoin-state program: claimed only while BTC_STATE is on and its key has not been refused.
    let btc_on = env_or("BTC_STATE", if community.is_some() { "1" } else { "0" }) == "1";
    let mut btc_key: Option<Result<_, String>> = None;
    let btc_limit = env_or("BTC_JOB_TIMEOUT_SECS", "7200").parse::<u64>().unwrap_or(7200);
    // The tacit chain's blocks (TACIT_BLOCK, on by default): a few million cycles each, raced like any public job.
    let block_on = env_or("TACIT_BLOCK", "1") == "1";
    let mut block_key: Option<Result<_, String>> = None;
    // A proof that never ends (a GPU kernel that hangs leaves the server alive and silent, and the client waiting on it for ever) is
    // ended from outside: a watchdog thread sees a job in hand for longer than JOB_TIMEOUT_SECS (15 minutes by default, three times a
    // long op) and exits the process, so the loop around it starts a fresh worker and GPU server and the job goes back to the board.
    let job_since = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    // Salts between jobs: a community worker for its address; Tacit's own box for the bank alone, when SALT_MINER names the house address.
    if let Some(m) = &community { salt::start(&base, m, &name, job_since.clone(), false); }
    else if let Some(m) = std::env::var("SALT_MINER").ok().map(|a| a.trim().to_lowercase()).filter(|a| a.len() == 42 && a.starts_with("0x")) { salt::start(&base, &m, &name, job_since.clone(), true); }
    // The limit for the job in hand: JOB_TIMEOUT_SECS, or BTC_JOB_TIMEOUT_SECS while a Bitcoin-state batch is proved.
    let default_limit = env_or("JOB_TIMEOUT_SECS", "900").parse::<u64>().unwrap_or(900);
    let job_limit = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(default_limit));
    {
        let job_since = job_since.clone();
        let job_limit = job_limit.clone();
        let name = name.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(15));
            let since = job_since.load(std::sync::atomic::Ordering::Relaxed);
            if since == 0 { continue; }
            let limit = job_limit.load(std::sync::atomic::Ordering::Relaxed);
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            if now.saturating_sub(since) > limit {
                println!("[{name}] a job has been in hand for {} s (limit {limit}); exiting so the loop starts a fresh worker and GPU server", now - since);
                std::process::exit(3);
            }
        });
    }
    // A pool lease left from before a restart is proved first: letting it run out would count against this place for the day.
    if pool_on {
        let fresh = std::fs::metadata(&pool_lease_file).ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).map_or(false, |a| a < Duration::from_secs(40 * 60));
        match std::fs::read(&pool_lease_file).ok().and_then(|b| serde_json::from_slice::<PoolLease>(&b).ok()) {
            Some(l) if fresh => {
                println!("[{name}] pool wrap {} was in hand before the restart: proving it", &l.id[..l.id.len().min(12)]);
                match pool_prove(&agent, &base, &l, &pool_lease_file, &job_since, |stdin| {
                    let p = client.prove(&pk, stdin).groth16().cycle_limit(512_000_000).run().map_err(|e| format!("groth16 proof failed: {e}"))?;
                    Ok((p.public_values.as_slice().to_vec(), p.bytes()))
                }) {
                    Ok(secs) => println!("[{name}] pool wrap: proved in {secs:.1} s"),
                    Err(e) if gpu_gone(&e) => {
                        println!("[{name}] pool wrap: the GPU server went ({e}); exiting so the loop starts a fresh one, which proves it again");
                        std::process::exit(2);
                    }
                    Err(e) => println!("[{name}] pool wrap: failed: {e}"),
                }
            }
            _ => { let _ = std::fs::remove_file(&pool_lease_file); }
        }
    }
    loop {
        if std::path::Path::new(&pause_flag).exists() {
            if quiet % 30 == 0 { println!("[{name}] paused ({pause_flag} exists): not taking jobs"); }
            quiet += 1;
            std::thread::sleep(Duration::from_secs(2));
            continue;
        }
        if reload_due() {
            let _ = std::fs::remove_file(&reload_flag);
            println!("[{name}] reload asked for; exiting between jobs");
            return;
        }
        let eth_claims = eth_on && !matches!(eth_key, Some(Err(_)));
        let btc_claims = btc_on && !matches!(btc_key, Some(Err(_)));
        let block_claims = block_on && !matches!(block_key, Some(Err(_)));
        let (claim_classes, programs) = if community.is_some() {
            let mut p = vec![];
            if btc_claims { p.push("btc-state"); }
            if block_claims { p.push("tacit-block"); }
            (vec!["public".to_string()], p)
        } else {
            claim_scope(&classes, eth_claims, btc_claims, block_claims)
        };
        // a community worker that proves neither Bitcoin batches nor blocks has nothing to claim at the board
        let claimed: Result<Claim, String> = if community.is_some() && programs.is_empty() {
            Ok(Claim { job: None })
        } else {
            agent
                .post(&claim_url)
                .set("Authorization", &auth)
                .send_json(serde_json::json!({ "worker": name, "classes": claim_classes, "programs": programs, "pubkey": my_pub_hex, "miner": community }))
                .map_err(|e| e.to_string())
                .and_then(|r| r.into_json::<Claim>().map_err(|e| e.to_string()))
        };
        let job = match claimed {
            Ok(Claim { job: Some(j) }) => j,
            Ok(Claim { job: None }) => {
                if std::path::Path::new(&recycle_flag).exists() {
                    let _ = std::fs::remove_file(&recycle_flag);
                    println!("[{name}] the GPU server's Groth16 step has slowed and nothing is waiting; exiting so the loop starts a fresh worker and GPU server");
                    std::process::exit(4);
                }
                if jobs_done >= jobs_per_server {
                    println!("[{name}] {jobs_done} jobs on this GPU server and nothing waiting; exiting so the loop starts a fresh worker and GPU server");
                    std::process::exit(4);
                }
                while pool_hour.front().map_or(false, |t| t.elapsed() >= Duration::from_secs(3600)) { pool_hour.pop_front(); }
                let today = now_secs() / 86_400;
                if pool_on && pool_rest_day != Some(today) && board_last.elapsed() >= pool_idle && pool_hour.len() < pool_max_hour && pool_last.map_or(true, |t| t.elapsed() >= pool_every) {
                    pool_last = Some(Instant::now());
                    match pool_lease(&agent, &base, &auth, community.as_deref(), pool_min_age_ms) {
                        Leased::Job(l) => {
                            // past the day's paid proofs the pool pays the address nothing: the one leased is proved, then no more today
                            if community.is_some() && l.points <= 0 && !pool_unpaid {
                                pool_rest_day = Some(today);
                                println!("[{name}] the pool pays this address nothing more today: proving the wrap in hand, then none until 00:00 UTC");
                            }
                            let outcome = pool_prove(&agent, &base, &l, &pool_lease_file, &job_since, |stdin| {
                                let p = client.prove(&pk, stdin).groth16().cycle_limit(512_000_000).run().map_err(|e| format!("groth16 proof failed: {e}"))?;
                                Ok((p.public_values.as_slice().to_vec(), p.bytes()))
                            });
                            quiet = 0;
                            jobs_done += 1;
                            pool_hour.push_back(Instant::now());
                            match outcome {
                                Ok(secs) => { failed_in_a_row = 0; println!("[{name}] pool wrap: proved in {secs:.1} s"); }
                                Err(e) => {
                                    println!("[{name}] pool wrap: failed: {e}");
                                    failed_in_a_row += 1;
                                    if gpu_gone(&e) || failed_in_a_row >= 3 {
                                        println!("[{name}] exiting so the loop starts a fresh worker and GPU server");
                                        std::process::exit(2);
                                    }
                                }
                            }
                            continue;
                        }
                        Leased::DoneForToday(why) => {
                            pool_rest_day = Some(today);
                            println!("[{name}] the pool leases nothing more here today: {why}");
                        }
                        Leased::Nothing => {}
                    }
                }
                quiet += 1;
                if quiet % 100 == 1 { println!("[{name}] waiting for work"); }
                std::thread::sleep(poll);
                continue;
            }
            Err(e) => {
                println!("[{name}] claim failed: {e}");
                std::thread::sleep(poll.max(Duration::from_secs(10)));
                continue;
            }
        };
        quiet = 0;
        let label = job.label.clone().unwrap_or_default();
        println!("[{name}] job {} {label}: proving", &job.job_id[..job.job_id.len().min(12)]);
        let t = Instant::now();
        let is_btc = job.program.as_deref() == Some("btc-state");
        job_limit.store(if is_btc { btc_limit } else { default_limit }, std::sync::atomic::Ordering::Relaxed);
        job_since.store(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(1).max(1), std::sync::atomic::Ordering::Relaxed);
        // The job: its input decoded, proved within its cycle limit → (public values, the proof as the board takes it: the hex of the
        // bytes settle() takes for the pool's guest, the base64 of the saved compressed proof for the Ethereum-state guest).
        let outcome: Result<(Vec<u8>, String), String> = (|| {
            let bytes = match (&job.sealed, &job.stdin) {
                (Some(s), _) => unseal(&sk, &my_pub, s)?,
                (None, Some(b)) => base64::engine::general_purpose::STANDARD.decode(b).map_err(|e| format!("stdin is not base64: {e}"))?,
                (None, None) => return Err("the job carries neither stdin nor a sealed input".to_string()),
            };
            let stdin: SP1Stdin = bincode::deserialize(&bytes).map_err(|e| format!("stdin is not a bincode SP1Stdin: {e}"))?;
            if let Some(dl) = job.deadline {
                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
                if now > dl { return Err("the job's deadline has passed".to_string()); }
            }
            let cycles = job.cycle_limit.map(|c| c as u64).filter(|c| *c > 0).unwrap_or(512_000_000);
            match job.program.as_deref() {
                None | Some("confidential") => {}
                Some("eth-state") => return eth_state_proof(&client, &mut eth_key, stdin, cycles),
                Some("btc-state") if btc_on => return btc_state_proof(&client, &mut btc_key, stdin, cycles),
                Some("tacit-block") if block_on => return tacit_block_proof(&client, &mut block_key, stdin, cycles),
                Some(other) => return Err(format!("this worker does not prove the {other} program")),
            }
            let proof = client.prove(&pk, stdin).groth16().cycle_limit(cycles).run().map_err(|e| format!("groth16 proof failed: {e}"))?;
            Ok((proof.public_values.as_slice().to_vec(), format!("0x{}", hex::encode(proof.bytes()))))
        })();
        job_since.store(0, std::sync::atomic::Ordering::Relaxed);
        board_last = Instant::now();
        let body = match &outcome {
            Ok((pv, proof)) => {
                println!("[{name}] job {} {label}: proved in {:.1} s", &job.job_id[..job.job_id.len().min(12)], t.elapsed().as_secs_f64());
                serde_json::json!({ "jobId": job.job_id, "publicValues": format!("0x{}", hex::encode(pv)), "proof": proof, "miner": community })
            }
            Err(e) => {
                println!("[{name}] job {} {label}: failed after {:.1} s: {e}", &job.job_id[..job.job_id.len().min(12)], t.elapsed().as_secs_f64());
                serde_json::json!({ "jobId": job.job_id, "error": e.chars().take(300).collect::<String>(), "miner": community })
            }
        };
        let transport_dead = matches!(&outcome, Err(e) if gpu_gone(e));
        failed_in_a_row = if outcome.is_ok() { 0 } else { failed_in_a_row + 1 };
        // The answer is worth a few tries: the proof is made, and a lost answer would send the relay to the network for nothing.
        for attempt in 0..5 {
            match agent.post(&result_url).set("Authorization", &auth).send_json(body.clone()) {
                Ok(_) => break,
                Err(e) => {
                    println!("[{name}] result not delivered (try {}): {e}", attempt + 1);
                    std::thread::sleep(Duration::from_secs(3));
                }
            }
        }
        if transport_dead || failed_in_a_row >= 3 {
            println!("[{name}] {}; exiting so the loop starts a fresh worker and GPU server", if transport_dead { "the GPU server is gone".to_string() } else { format!("{failed_in_a_row} jobs failed in a row") });
            std::process::exit(2);
        }
        jobs_done += 1;
        // A Bitcoin-state batch is slow by its nature, not a sign of a slowing server: it leaves the count as it was.
        if !is_btc { slow_in_a_row = if outcome.is_ok() && t.elapsed().as_secs_f64() > slow_secs { slow_in_a_row + 1 } else { 0 }; }
        if std::path::Path::new(&recycle_flag).exists() {
            let from = *recycle_from.get_or_insert(jobs_done);
            if jobs_done - from >= recycle_max {
                let _ = std::fs::remove_file(&recycle_flag);
                println!("[{name}] the GPU server's Groth16 step has slowed; exiting after {recycle_max} more jobs so the loop starts a fresh worker and GPU server");
                std::process::exit(4);
            }
        }
        if jobs_done >= 2 * jobs_per_server || slow_in_a_row >= 2 {
            println!("[{name}] {}; exiting so the loop starts a fresh worker and GPU server", if slow_in_a_row >= 2 { format!("two proofs in a row took over {slow_secs} s") } else { format!("{jobs_done} jobs on this GPU server") });
            std::process::exit(4);
        }
    }
}

// The classes and programs a claim asks for: with the Ethereum-state program on, its class and program are added to the
// configured ones (CLASSES), so a worker.env written before it needs no change; the Bitcoin-state program is public work, so it
// adds that class and the program.
fn claim_scope(classes: &[String], eth: bool, btc: bool, block: bool) -> (Vec<String>, Vec<&'static str>) {
    let mut cls = classes.to_vec();
    if eth && !cls.iter().any(|c| c == "eth-state") {
        cls.push("eth-state".to_string());
    }
    if (btc || block) && !cls.iter().any(|c| c == "public") {
        cls.push("public".to_string());
    }
    let mut programs = vec!["confidential"];
    if eth { programs.push("eth-state"); }
    if btc { programs.push("btc-state"); }
    if block { programs.push("tacit-block"); }
    (cls, programs)
}

// One tacit chain block: the block program proved groth16, the proof the landing contract's `land` takes. Its key is set up on the
// first job and kept; one that is not TACIT_BLOCK_VKEY is refused for good, which drops the program from the claims.
fn tacit_block_proof<P: Prover>(
    client: &P,
    block_key: &mut Option<Result<P::ProvingKey, String>>,
    stdin: SP1Stdin,
    cycles: u64,
) -> Result<(Vec<u8>, String), String> {
    if block_key.is_none() {
        let t = Instant::now();
        let k = client.setup(Elf::Static(BLOCK_ELF)).map_err(|e| format!("tacit-block setup failed: {e}"))?;
        let vk = k.verifying_key().bytes32();
        *block_key = Some(if vk.to_lowercase() == TACIT_BLOCK_VKEY {
            println!("tacit-block key set up in {:.1} s ({vk})", t.elapsed().as_secs_f64());
            Ok(k)
        } else {
            Err(format!("the tacit-block guest's key {vk} is not TACIT_BLOCK_VKEY; tacit-block jobs are off"))
        });
    }
    let pk = match block_key.as_ref() {
        Some(Ok(k)) => k,
        Some(Err(why)) => return Err(why.clone()),
        None => unreachable!(),
    };
    let proof = client.prove(pk, stdin).groth16().cycle_limit(cycles).run().map_err(|e| format!("groth16 proof failed: {e}"))?;
    Ok((proof.public_values.as_slice().to_vec(), format!("0x{}", hex::encode(proof.bytes()))))
}

// One Bitcoin-state job: the Bitcoin reflection guest proved groth16 on the same GPU server. Its key is set up on the first job and
// kept; a key that is not the pool's BITCOIN_RELAY_VKEY is refused for good, and `btc_key` then keeps the reason, which drops the
// program from the claims. → (public values, the hex of the proof bytes attestBitcoinStateProven takes)
fn btc_state_proof<P: Prover>(
    client: &P,
    btc_key: &mut Option<Result<P::ProvingKey, String>>,
    stdin: SP1Stdin,
    cycles: u64,
) -> Result<(Vec<u8>, String), String> {
    if btc_key.is_none() {
        let t = Instant::now();
        let k = client.setup(Elf::Static(BTC_ELF)).map_err(|e| format!("btc-state setup failed: {e}"))?;
        let vk = k.verifying_key().bytes32();
        *btc_key = Some(if vk.to_lowercase() == BITCOIN_RELAY_VKEY {
            println!("btc-state key set up in {:.1} s ({vk})", t.elapsed().as_secs_f64());
            Ok(k)
        } else {
            Err(format!("the btc-state guest's key {vk} is not the pool's BITCOIN_RELAY_VKEY; btc-state jobs are off"))
        });
    }
    let pk = match btc_key.as_ref() {
        Some(Ok(k)) => k,
        Some(Err(why)) => return Err(why.clone()),
        None => unreachable!(),
    };
    let proof = client.prove(pk, stdin).groth16().cycle_limit(cycles).run().map_err(|e| format!("groth16 proof failed: {e}"))?;
    Ok((proof.public_values.as_slice().to_vec(), format!("0x{}", hex::encode(proof.bytes()))))
}

// One Ethereum-state job: the eth-reflection guest proved compressed on the same GPU server as the pool's guest. Its key is set up
// on the first job (about as long as the pool guest's at start) and kept; a key whose recursion digest is not the one the Bitcoin
// guest verifies is refused for good, and `eth_key` then keeps the reason, which drops the program from the claims.
// → (public values, base64 of the bincode SP1ProofWithPublicValues)
fn eth_state_proof<P: Prover>(
    client: &P,
    eth_key: &mut Option<Result<P::ProvingKey, String>>,
    stdin: SP1Stdin,
    cycles: u64,
) -> Result<(Vec<u8>, String), String> {
    if eth_key.is_none() {
        let t = Instant::now();
        let k = client.setup(Elf::Static(ETH_ELF)).map_err(|e| format!("eth-state setup failed: {e}"))?;
        let digest = k.verifying_key().hash_u32();
        *eth_key = Some(if digest == ETH_REFLECTION_VKEY {
            println!("eth-state key set up in {:.1} s ({})", t.elapsed().as_secs_f64(), k.verifying_key().bytes32());
            Ok(k)
        } else {
            Err(format!("the eth-state guest's key digest {digest:?} is not the one the Bitcoin reflection verifies; eth-state jobs are off"))
        });
    }
    let pk = match eth_key.as_ref() {
        Some(Ok(k)) => k,
        Some(Err(why)) => return Err(why.clone()),
        None => unreachable!(),
    };
    let proof = client.prove(pk, stdin).compressed().cycle_limit(cycles).run().map_err(|e| format!("compressed proof failed: {e}"))?;
    let pv = proof.public_values.as_slice().to_vec();
    let bytes = bincode::serialize(&proof).map_err(|e| format!("the proof did not serialize: {e}"))?;
    Ok((pv, base64::engine::general_purpose::STANDARD.encode(bytes)))
}

// The client's errors when the GPU server is gone rather than one input failing.
fn gpu_gone(e: &str) -> bool {
    e.contains("early eof") || e.contains("Could not connect") || e.contains("Connection reset") || e.contains("Broken pipe")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(1).max(1)
}

// A proof-pool lease as the API hands it out (`points`: what its proof earns the miner, 0 for Tacit's own box), kept in POOL_LEASE_FILE
// while it is proved.
#[derive(Serialize, Deserialize)]
struct PoolLease {
    id: String,
    lease: String,
    stdin: String,
    #[serde(default)]
    points: i64,
}

enum Leased {
    Job(PoolLease),
    // nothing waiting (204), a lease already open from here (429), or no answer
    Nothing,
    // this place may lease nothing more today (403: proofs that did not pass, or leases let run out)
    DoneForToday(String),
}

// A lease from the proof pool: a community worker asks as a miner, in its address's name; Tacit's own box with its token, for a job that
// has waited `min_age_ms`.
fn pool_lease(agent: &ureq::Agent, base: &str, auth: &str, miner: Option<&str>, min_age_ms: u64) -> Leased {
    let req = agent.post(&format!("{base}/prover/pool/lease"));
    let r = match miner {
        Some(m) => req.send_json(serde_json::json!({ "miner": m })),
        None => req.set("Authorization", auth).send_json(serde_json::json!({ "minAgeMs": min_age_ms })),
    };
    match r {
        Ok(r) if r.status() == 200 => r.into_json::<PoolLease>().map_or(Leased::Nothing, Leased::Job),
        Ok(_) => Leased::Nothing,
        Err(ureq::Error::Status(403, r)) => Leased::DoneForToday(r.into_string().unwrap_or_default().chars().take(200).collect()),
        Err(_) => Leased::Nothing,
    }
}

// A leased pool job proved with `prove` and its proof (or why it could not be made) sent back, the lease kept in `file` until then.
// → how long the proof took, or why it failed. The job watchdog sees it as a job.
fn pool_prove(
    agent: &ureq::Agent,
    base: &str,
    l: &PoolLease,
    file: &str,
    job_since: &std::sync::atomic::AtomicU64,
    prove: impl FnOnce(SP1Stdin) -> Result<(Vec<u8>, Vec<u8>), String>,
) -> Result<f64, String> {
    if let Ok(b) = serde_json::to_vec(l) { let _ = std::fs::write(file, b); }
    let t = Instant::now();
    job_since.store(now_secs(), std::sync::atomic::Ordering::Relaxed);
    let outcome = hex::decode(l.stdin.trim_start_matches("0x"))
        .map_err(|e| format!("stdin is not hex: {e}"))
        .and_then(|b| bincode::deserialize::<SP1Stdin>(&b).map_err(|e| format!("stdin is not a bincode SP1Stdin: {e}")))
        .and_then(prove);
    job_since.store(0, std::sync::atomic::Ordering::Relaxed);
    // A GPU server that died mid-proof is this machine's trouble, not the job's: nothing is sent (handing it back would count against
    // this place), and the lease stays in its file for the restarted worker to prove.
    if let Err(e) = &outcome {
        if gpu_gone(e) {
            return Err(e.clone());
        }
    }
    let body = match &outcome {
        Ok((pv, proof)) => serde_json::json!({ "id": l.id, "lease": l.lease, "publicValues": format!("0x{}", hex::encode(pv)), "proof": format!("0x{}", hex::encode(proof)) }),
        Err(e) => serde_json::json!({ "id": l.id, "lease": l.lease, "error": e.chars().take(300).collect::<String>() }),
    };
    // The API asks Ethereum's verifier before it keeps a proof; while no node answers (503) the lease holds and the proof is sent again.
    for _ in 0..6 {
        match agent.post(&format!("{base}/prover/pool/submit")).send_json(body.clone()) {
            Ok(_) => break,
            Err(ureq::Error::Status(503, _)) | Err(ureq::Error::Transport(_)) => std::thread::sleep(Duration::from_secs(20)),
            Err(ureq::Error::Status(code, r)) => {
                println!("pool job {}: not taken ({code}): {}", l.id, r.into_string().unwrap_or_default().chars().take(200).collect::<String>());
                break;
            }
        }
    }
    let _ = std::fs::remove_file(file);
    outcome.map(|_| t.elapsed().as_secs_f64())
}
