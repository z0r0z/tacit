// What this computer has, for the help desk to size its jobs by: memory, GPU memory, cores, system and chip family, as numbers and two words
// (nothing that names the machine). Sent with each lease request; the help desk sorts nodes by the size of model each can hold whole.
// Asked once: it does not change while the prover runs, and a command that hangs (nvidia-smi on a broken driver) must not hold up the job loop.
use serde_json::{json, Value};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

// `MemTotal:       32768000 kB` -> GB, rounded
pub fn parse_meminfo_gb(s: &str) -> Option<u64> {
    let kb: u64 = s.lines().find(|l| l.starts_with("MemTotal:"))?.split_whitespace().nth(1)?.parse().ok()?;
    Some(((kb as f64) / 1_048_576.0).round() as u64)
}
// `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`: one MiB figure per GPU per line -> GB over all of them, rounded.
// Lines that are not a whole number (N/A, [Not Supported]) add nothing.
pub fn parse_nvidia_gb(s: &str) -> u64 {
    let mib: u64 = s.lines().filter_map(|l| l.trim().parse::<u64>().ok()).sum();
    ((mib as f64) / 1024.0).round() as u64
}
pub fn os_name(os: &str) -> &'static str { match os { "macos" => "darwin", "linux" => "linux", "windows" => "windows", _ => "" } }
pub fn arch_name(a: &str) -> &'static str { match a { "aarch64" => "arm64", "x86_64" => "x64", _ => "" } }

// a command's output, or None if it fails, is missing, or takes more than 4 seconds
fn out(prog: &str, args: &[&str]) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let (prog, args): (String, Vec<String>) = (prog.to_string(), args.iter().map(|a| a.to_string()).collect());
    std::thread::spawn(move || {
        let r = Command::new(&prog).args(&args).stderr(Stdio::null()).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
        let _ = tx.send(r);
    });
    rx.recv_timeout(Duration::from_secs(4)).ok().flatten()
}

fn ram_gb(os: &str) -> u64 {
    match os {
        "macos" => out("sysctl", &["-n", "hw.memsize"]).and_then(|s| s.trim().parse::<u64>().ok()).map(|b| ((b as f64) / 1_073_741_824.0).round() as u64).unwrap_or(0),
        "linux" => std::fs::read_to_string("/proc/meminfo").ok().and_then(|s| parse_meminfo_gb(&s)).unwrap_or(0),
        _ => 0,
    }
}

pub fn hardware() -> Value {
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    let vram = out("nvidia-smi", &["--query-gpu=memory.total", "--format=csv,noheader,nounits"]).map(|s| parse_nvidia_gb(&s)).unwrap_or(0);
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    json!({ "ram": ram_gb(os), "vram": vram, "cores": cores, "os": os_name(os), "arch": arch_name(arch), "unified": os == "macos" && arch == "aarch64" })
}
pub fn cached() -> &'static Value {
    static HW: OnceLock<Value> = OnceLock::new();
    HW.get_or_init(hardware)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn meminfo_is_read_in_gb() {
        assert_eq!(parse_meminfo_gb("MemTotal:       32768000 kB\nMemFree: 1 kB\n"), Some(31)); // 31.25 GB
        assert_eq!(parse_meminfo_gb("MemFree: 1 kB\nMemTotal: 65536000 kB\n"), Some(63));
        assert_eq!(parse_meminfo_gb("MemTotal: 8388608 kB\n"), Some(8));
        assert_eq!(parse_meminfo_gb("nothing here"), None);
        assert_eq!(parse_meminfo_gb("MemTotal: lots kB"), None);
    }
    #[test]
    fn nvidia_memory_is_summed_over_gpus_and_odd_lines_add_nothing() {
        assert_eq!(parse_nvidia_gb("24564\n24564\n"), 48);
        assert_eq!(parse_nvidia_gb("12288\n"), 12);
        assert_eq!(parse_nvidia_gb(" 49152 \n"), 48);
        assert_eq!(parse_nvidia_gb(""), 0);
        assert_eq!(parse_nvidia_gb("N/A\n[Not Supported]\n8192\n"), 8);
    }
    #[test]
    fn names_are_the_help_desks_words_and_unknown_ones_are_blank() {
        assert_eq!((os_name("macos"), os_name("linux"), os_name("windows"), os_name("freebsd")), ("darwin", "linux", "windows", ""));
        assert_eq!((arch_name("aarch64"), arch_name("x86_64"), arch_name("riscv64")), ("arm64", "x64", ""));
    }
    #[test]
    fn this_machine_reports_the_fields_the_help_desk_reads_and_nothing_else() {
        let h = hardware();
        let mut keys: Vec<&String> = h.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["arch", "cores", "os", "ram", "unified", "vram"]);
        assert!(h["cores"].as_u64().unwrap() > 0);
        if cfg!(any(target_os = "macos", target_os = "linux")) { assert!(h["ram"].as_u64().unwrap() > 0); }
        assert_eq!(h["unified"].as_bool().unwrap(), cfg!(all(target_os = "macos", target_arch = "aarch64")));
        assert_eq!(cached(), cached());
    }
    #[test]
    fn a_command_that_hangs_gives_up_after_its_wait() {
        let t = std::time::Instant::now();
        assert_eq!(out("sleep", &["30"]), None);
        assert!(t.elapsed() < Duration::from_secs(8));
        assert_eq!(out("this-command-does-not-exist-here", &[]), None);
    }
}
