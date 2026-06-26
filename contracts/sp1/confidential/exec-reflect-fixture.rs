// Execute the reflection prover on an indexer-assembled input (reflection_input.json, built by
// tests/gen-reflection-input.mjs via dapp assembleReflectionInput) — validates the assembler
// serializes the guest's io::read order AND the guest verifies a REAL Bitcoin header chain (PoW)
// end-to-end. Effect serialization is included so the same harness drives a full-fold fixture
// once a real CXFER/burn tx is wired.
//
// The SP1Stdin byte stream is built by the SHARED `reflect_stdin::write_stdin` — the SINGLE source of
// truth for reflect.rs's io::read order (the SAME writer reflect-exec validates via DIGEST_MATCH and
// eth-reflection/prover-host `bitcoin_prove` proves with). This file previously carried its OWN copy of
// the writer, which fell behind the guest (it lacked the fast-lane consumed-ν loop + the resume
// consumedCount/ethReflDigest fields and still wrote a 9-word eth_pv); that copy is DELETED so it can
// never silently desync the stream again. The box exec crate this is built in must depend on the
// `reflect-stdin` crate (pure sp1-sdk/serde_json/hex; builds locally + on the box).
use sp1_sdk::{blocking::{ProverClient, Prover}, Elf};
use reflect_stdin::write_stdin;
const ELF: &[u8] = include_bytes!("/root/work/cxfer/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/reflection-prover");

fn main() {
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("/root/work/cxfer/fixtures/reflection_input.json").unwrap()).unwrap();
    let s = write_stdin(&f);

    let client = ProverClient::builder().cpu().build();
    let (out, rep) = client.execute(Elf::Static(ELF), s).run().expect("execute failed");
    println!("REFLECT_FIXTURE_OK cycles={} pv_bytes={}", rep.total_instruction_count(), out.as_slice().len());
    println!("PV={}", hex::encode(out.as_slice()));
}
