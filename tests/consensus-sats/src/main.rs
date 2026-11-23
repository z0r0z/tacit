// Runs Bitcoin Core's own script verifier (libbitcoinconsensus, via the bitcoinconsensus crate) over transactions the dapp's builders made.
// Each line of the case file: name <TAB> raw tx hex <TAB> input index <TAB> ok|fail <TAB> prevouts as script:value,script:value (one per input).
// Taproot rules are on (VERIFY_ALL_PRE_TAPROOT | VERIFY_TAPROOT), so a key-path spend, a script-path spend with OP_CHECKSEQUENCEVERIFY,
// and the BIP143 spends of the funding coins are all judged by the node's code. Exits non-zero when any case does not come out as expected.
use bitcoinconsensus as bc;
use std::fs;

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex")).collect()
}

fn main() {
    let path = std::env::args().nth(1).expect("case file");
    let text = fs::read_to_string(path).expect("read");
    let mut bad = 0;
    let mut n = 0;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let f: Vec<&str> = line.split('\t').collect();
        let (name, tx, idx, expect, prev) = (f[0], unhex(f[1]), f[2].parse::<usize>().unwrap(), f[3], f[4]);
        let prevs: Vec<(Vec<u8>, i64)> = prev
            .split(',')
            .map(|p| {
                let (s, v) = p.split_once(':').unwrap();
                (unhex(s), v.parse().unwrap())
            })
            .collect();
        let utxos: Vec<bc::Utxo> = prevs
            .iter()
            .map(|(s, v)| bc::Utxo { script_pubkey: s.as_ptr(), script_pubkey_len: s.len() as u32, value: *v })
            .collect();
        let r = bc::verify_with_flags(&prevs[idx].0, prevs[idx].1 as u64, &tx, Some(&utxos), idx, bc::VERIFY_ALL_PRE_TAPROOT | bc::VERIFY_TAPROOT);
        let ok = r.is_ok();
        let want = expect == "ok";
        n += 1;
        println!("{} {} -> {:?}", if ok == want { "PASS    " } else { "MISMATCH" }, name, r);
        if ok != want {
            bad += 1;
        }
    }
    println!("{} cases, {} not as expected", n, bad);
    std::process::exit(if bad == 0 { 0 } else { 1 });
}
