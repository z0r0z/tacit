#!/usr/bin/env bash
# box-prove-pull.sh — pull the box's per-op proof artifacts (out-v1/<op>_{pv,pb}.hex) and assemble
# contracts/test/fixtures/<op>_groth16.json {note, vkey, publicValues, proofBytes}. PRESERVES every
# other field already in the fixture (e.g. crosslane's bitcoinSpentRoot) — only vkey/publicValues/
# proofBytes are overwritten. vkey is read from elf-vkey-pin.json (program_vkey for settle ops,
# bitcoin_relay_vkey for the two reflection ops). The settle box op `bridge_stealth_mint` maps to the
# `bridgestealthmint` fixture name; every other op is identity.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
KEY_FILE="${SSH_KEY:-$HOME/.ssh/vast_prover}"
PIN=contracts/sp1/confidential/elf-vkey-pin.json
FX=contracts/test/fixtures

VAST_KEY="$(grep -oE 'VAST_API_KEY=[^ ]+' ~/.zshrc 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"'"'"'')"
read -r BOX_HOST BOX_PORT < <(curl -s --max-time 25 "https://console.vast.ai/api/v0/instances/" -H "Authorization: Bearer $VAST_KEY" \
  | python3 -c "import sys,json; ins=[i for i in json.load(sys.stdin).get('instances',[]) if i.get('actual_status')=='running']; print(ins[0]['ssh_host'], ins[0]['ssh_port']) if ins else print('', '')")
[ -n "${BOX_HOST:-}" ] || { echo "no RUNNING vast instance"; exit 1; }
echo "== pull from root@$BOX_HOST:$BOX_PORT =="
rm -rf /tmp/box-out && mkdir -p /tmp/box-out
scp -i "$KEY_FILE" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -P "$BOX_PORT" \
  "root@$BOX_HOST:/root/work/cxfer/out-v1/*.hex" /tmp/box-out/ >/dev/null
echo "  pulled $(ls /tmp/box-out/*_pv.hex 2>/dev/null | wc -l) ops"

python3 - "$PIN" "$FX" <<'PY'
import json, os, sys, glob
pin = json.load(open(sys.argv[1])); FX = sys.argv[2]
program = pin["program_vkey"]; relay = pin["bitcoin_relay_vkey"]
relay_ops = {"reflection", "reflection_burn_deposit"}
fixname = lambda op: "bridgestealthmint" if op == "bridge_stealth_mint" else op
ops = sorted(os.path.basename(f)[:-7] for f in glob.glob("/tmp/box-out/*_pv.hex"))
n = 0
for op in ops:
    pvf, pbf = f"/tmp/box-out/{op}_pv.hex", f"/tmp/box-out/{op}_pb.hex"
    if not (os.path.exists(pvf) and os.path.exists(pbf)):
        print(f"  WARN {op}: missing pv/pb, skipped"); continue
    fn = f"{FX}/{fixname(op)}_groth16.json"
    d = json.load(open(fn)) if os.path.exists(fn) else {}
    d.setdefault("note", f"Real SP1 Groth16 proof of {op}, verified on-chain against the pinned vkey.")
    d["vkey"] = relay if op in relay_ops else program
    d["publicValues"] = "0x" + open(pvf).read().strip()
    d["proofBytes"] = "0x" + open(pbf).read().strip()
    json.dump(d, open(fn, "w"), indent=2)
    n += 1
print(f"  assembled {n} fixtures (fields preserved)")
PY
