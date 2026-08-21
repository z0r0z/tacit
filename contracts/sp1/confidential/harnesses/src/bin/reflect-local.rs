// Local reflection DIGEST_MATCH runner (execute mode — no proving, no box).
//
// Feeds a mirror-produced fixture (gen-reflection-*-synth.mjs / gen-reflection-input.mjs) through the SHARED
// reflect_stdin::write_stdin serializer, executes the guest ELF on CPU, and compares the guest's committed
// newDigest to the fixture's. A desync (the harvest / zero-input class) either panics the guest here or
// yields a MISMATCH — so this catches the whole guest↔mirror parity class locally.
//
// Usage: reflect-local <elf_path> <fixture.json>
//   exit 0 = MATCH, 1 = MISMATCH, 2 = guest execute failed (halt/panic), 3 = serializer panic.
use sp1_sdk::{blocking::{Prover, ProverClient}, Elf};
use reflect_stdin::write_stdin;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: reflect-local <elf_path> <fixture.json>");
        std::process::exit(4);
    }
    let elf = std::fs::read(&args[1]).expect("read elf");
    let f: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&args[2]).expect("read fixture")).expect("parse fixture");
    let expected = f["newDigest"].as_str().unwrap_or("").to_lowercase();

    // The serializer itself can panic on a stale-shape fixture (the harvest #5 class) — catch it as a finding.
    let stdin = match std::panic::catch_unwind(|| write_stdin(&f)) {
        Ok(s) => s,
        Err(_) => {
            println!("SERIALIZER_PANIC expected={expected} — the mirror fixture shape does not match write_stdin");
            std::process::exit(3);
        }
    };

    let client = ProverClient::builder().cpu().build();
    match client.execute(Elf::Static(Box::leak(elf.into_boxed_slice())), stdin).run() {
        Ok((out, rep)) => {
            let pv = out.as_slice();
            if std::env::var("DUMP_PV").is_ok() { eprintln!("PV[0..256]={}", hex::encode(&pv[..pv.len().min(256)])); }
            // The struct has dynamic tail fields, so abi_encode wraps it as a dynamic tuple: a 32-byte offset
            // word is prepended. newDigest is head field 5 → 32 (prefix) + 5*32 = byte offset 192.
            let got = if pv.len() >= 224 { format!("0x{}", hex::encode(&pv[192..224])) } else { "0x<short-pv>".into() };
            let ok = !expected.is_empty() && got == expected;
            println!(
                "{} cycles={} guest_newDigest={} expected={}",
                if ok { "MATCH" } else { "MISMATCH" },
                rep.total_instruction_count(),
                got,
                if expected.is_empty() { "<none>" } else { &expected }
            );
            std::process::exit(if ok { 0 } else { 1 });
        }
        Err(e) => {
            println!("EXECUTE_FAILED (guest halt/panic) expected={expected}: {e}");
            std::process::exit(2);
        }
    }
}
