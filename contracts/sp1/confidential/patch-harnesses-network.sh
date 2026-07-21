#!/usr/bin/env bash
# Convert every confidential host harness from box-only local proving (.cpu() + hardcoded /root/work ELF path)
# to the Succinct hosted-network prover (.network()) + the committed portable ELF. Host-only change — the
# guest ELF (elf/cxfer-guest, vkey 0x003a21ba) is unchanged, so the deployed pool needs NO redeploy.
# Idempotent. Run from contracts/sp1/confidential/. Only touches harnesses/exec-*.rs.
set -euo pipefail
cd "$(dirname "$0")"

for f in harnesses/exec-*.rs; do
  [ -f "$f" ] || continue
  python3 - "$f" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
orig = s
# 1) portable ELF path (committed elf/cxfer-guest via CARGO_MANIFEST_DIR) — drop the /root/work box path
import re
s = re.sub(
    r'include_bytes!\(\s*"/root/work/cxfer/guest/[^"]*cxfer-guest"\s*\)',
    'include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../elf/cxfer-guest"))',
    s)
# 2) hosted (Reserved-capacity) Succinct network prover instead of forced-local CPU. .hosted() sets
#    NetworkMode::Reserved to match the rpc.production.succinct.xyz endpoint (default would be Mainnet/auction).
s = s.replace('ProverClient::builder().cpu().build()', 'ProverClient::builder().network().build()')
# 3) feed the REAL memo hashes (OP_FILE memoHashes) instead of 64 placeholder empty hashes, so the guest
#    commits to the real memos and settle() matches them (else the contract reverts MemoLeafMismatch).
s = s.replace(
    'for _ in 0..64u32 { stdin.write(&hexv("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")); }',
    '{ let empty = "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"; let mh: Vec<String> = f.get("memoHashes").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default(); for i in 0..64usize { stdin.write(&hexv(mh.get(i).map(|s| s.as_str()).unwrap_or(empty))); } }')
if s != orig:
    open(p, 'w').write(s)
    print("patched", p)
else:
    print("unchanged", p)
PY
done
echo "done — features must be network in harnesses/Cargo.toml (network, not native-gnark)"
