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
# 2) hosted-network prover instead of forced-local CPU (respects SP1_PROVER=network)
s = s.replace('ProverClient::builder().cpu().build()', 'ProverClient::builder().network().build()')
if s != orig:
    open(p, 'w').write(s)
    print("patched", p)
else:
    print("unchanged", p)
PY
done
echo "done — features must be network in harnesses/Cargo.toml (network, not native-gnark)"
