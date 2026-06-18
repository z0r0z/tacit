// LOCAL execute-mode validator for the full-scan reflection guest. Runs a reflection-prover ELF
// (RISC-V emulator on the host — no GPU) against an assembled reflection_input.json, using the SHARED
// `reflect_stdin::write_stdin` serializer (the SAME bytes the box recursion prover writes), and reports
// the committed BitcoinReflectionPublicValues. Closes the witness-stream contract loop without a GPU proof.
//
//   REFLECT_ELF=<path> cargo run --release --bin reflect-execute -- <reflection_input.json>
//   (REFLECT_ELF defaults to the committed pinned ELF; set it to a local build to validate new guest code.)
use sp1_sdk::{blocking::{ProverClient, Prover}, Elf};
use reflect_stdin::write_stdin;

fn word(pv: &[u8], i: usize) -> String { format!("0x{}", hex::encode(&pv[i * 32..i * 32 + 32])) }

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input_path = args.get(1).cloned()
        .unwrap_or_else(|| "/Users/z/tacit/contracts/sp1/confidential/fixtures/reflection_input.json".to_string());
    let elf_path = std::env::var("REFLECT_ELF")
        .unwrap_or_else(|_| "/Users/z/tacit/contracts/sp1/confidential/elf/reflection-prover".to_string());
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&input_path).unwrap()).unwrap();
    let elf: &'static [u8] = Box::leak(std::fs::read(&elf_path).expect("read REFLECT_ELF").into_boxed_slice());
    eprintln!("ELF {} ({} bytes), input {}", elf_path, elf.len(), input_path);

    let s = write_stdin(&f);
    let client = ProverClient::builder().cpu().build();
    let (out, rep) = client.execute(Elf::Static(elf), s).run().expect("execute failed (guest panicked / witness desync)");
    // BitcoinReflectionPublicValues is now a DYNAMIC tuple (it carries cbtcLocksFolded[]/cbtcLocksSpent[]),
    // so abi_encode prepends a 0x20 offset word — skip it so word(i) indexes struct field i again.
    let raw = out.as_slice();
    let pv = if raw.len() >= 32 && raw[..31].iter().all(|&b| b == 0) && raw[31] == 0x20 { &raw[32..] } else { raw };
    println!("EXECUTE_OK cycles={} pv_bytes={}", rep.total_instruction_count(), pv.len());
    // BitcoinReflectionPublicValues: [0]priorDigest [1]poolRoot [2]spentRoot [3]burnRoot [4]height
    // [5]newDigest [6]prevHash [7]tipHash [8]ethPoolReflected [9]cbtcBackingSats.
    let prior_burn = f["prior"]["burnRoot"].as_str().unwrap_or("").to_lowercase();
    let new_burn = word(pv, 3);
    println!("bitcoinBurnRoot  prior={prior_burn}  new={new_burn}");
    println!("bitcoinSpentRoot new={}", word(pv, 2));
    if new_burn != prior_burn { println!("BURN FOLDED ✓ (burn-set advanced — the burn-deposit recorded ν → dest)"); }
    else { println!("burn-set UNCHANGED (nothing folded)"); }
    // Guest↔JS digest parity: the fixture carries the JS assembler's newDigest; the guest must land on it.
    let new_digest = word(pv, 5);
    let expected = f["newDigest"].as_str().unwrap_or("").to_lowercase();
    if !expected.is_empty() {
        if new_digest == expected { println!("DIGEST_MATCH ✓ guest newDigest == JS assembler ({new_digest})"); }
        else { eprintln!("DIGEST_MISMATCH ✗ guest={new_digest} js={expected}"); std::process::exit(1); }
    }
}
