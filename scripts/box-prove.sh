#!/usr/bin/env bash
# box-prove.sh — ONE command to (re)prove the confidential guest on the vast box. Encodes every fix that
# used to break this by hand:
#   • auto-discovers the RUNNING box via the vast API (no stale hardcoded ssh host)
#   • regenerates the op-input fixtures from the JS generators (a stale witness layout makes the guest
#     commit empty public_values — the #1 silent failure)
#   • heals the box (full PATH incl. /usr/local/go/bin for the gnark-ffi build, clean /dev/shm, kill strays)
#   • syncs the committed guest source + harnesses + fixtures and SHA-VERIFIES them
#   • builds the ELFs, then runs box-prove-remote.sh (per-op groth16 → public_values + proofBytes)
#   • pulls the artifacts and assembles contracts/test/fixtures/<op>_groth16.json
#
# Usage:
#   scripts/box-prove.sh                 # discover box, regenerate inputs, sync, build, prove ALL, pull
#   ONLY=swap scripts/box-prove.sh       # one op
#   SKIP_REGEN=1 scripts/box-prove.sh    # don't regenerate op-inputs (use what's committed)
#   NO_PULL=1 scripts/box-prove.sh       # prove only, don't pull/assemble
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
KEY_FILE="${SSH_KEY:-$HOME/.ssh/vast_prover}"
GUEST_DIR=contracts/sp1/confidential
FX_LOCAL="$GUEST_DIR/fixtures"

# ── 1. discover the running box ─────────────────────────────────────────────
VAST_KEY="$(grep -oE 'VAST_API_KEY=[^ ]+' ~/.zshrc 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"'"'"'')"
read -r BOX_HOST BOX_PORT < <(curl -s --max-time 25 "https://console.vast.ai/api/v0/instances/" -H "Authorization: Bearer $VAST_KEY" \
  | python3 -c "import sys,json; ins=[i for i in json.load(sys.stdin).get('instances',[]) if i.get('actual_status')=='running']; print(ins[0]['ssh_host'], ins[0]['ssh_port']) if ins else print('', '')")
[ -n "${BOX_HOST:-}" ] || { echo "no RUNNING vast instance (start one: PUT /api/v0/instances/<id>/ {\"state\":\"running\"})"; exit 1; }
SSH="ssh -i $KEY_FILE -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o StrictHostKeyChecking=accept-new -p $BOX_PORT root@$BOX_HOST"
SCP="scp -i $KEY_FILE -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -P $BOX_PORT"
echo "== box: root@$BOX_HOST:$BOX_PORT =="
$SSH 'echo "  reachable: $(hostname); gpu free $(nvidia-smi --query-gpu=memory.free --format=csv,noheader 2>/dev/null)"' || { echo "ssh failed"; exit 1; }

# ── 2. regenerate op-input fixtures (stale layout => empty PV) ───────────────
if [ "${SKIP_REGEN:-0}" != "1" ]; then
  echo "== regenerating op-input fixtures =="
  # (generator, target). Generators that print JSON are redirected; those that write the file are run as-is.
  regen() { local gen=$1 tgt=$2; [ -f "tests/$gen" ] || { echo "  (no $gen)"; return; }
    out=$(node "tests/$gen" 2>/dev/null) || { echo "  FAIL $gen"; return; }
    if printf '%s' "$out" | head -c1 | grep -q '{'; then printf '%s\n' "$out" > "$FX_LOCAL/$tgt"; fi
    echo "  $tgt <- $gen ($(wc -c <"$FX_LOCAL/$tgt" 2>/dev/null||echo 0)B)"; }
  regen gen-cxfer-fullop-fixture.mjs       transfer_op.json
  regen gen-confidential-unwrap-fixture.mjs unwrap_op.json
  regen gen-confidential-swap-fixture.mjs  swap_op.json
  regen gen-confidential-lp-fixture.mjs    lp_op.json
  regen gen-confidential-otc-fixture.mjs   otc_op.json
  regen gen-confidential-bid-fixture.mjs   bid_op.json
  regen gen-confidential-route-fixture.mjs route_op.json
  regen gen-cxfer-crosslane-fixture.mjs    crosslane_op.json
  regen gen-bridgestealthmint-fixture.mjs  bridgestealthmint_op.json
  echo "  NOTE: cdp_*/cbtc_mint/adaptor_*/farm_*/lp_remove have no JS generator (Rust reflect-exec) —"
  echo "        using committed inputs; box-prove-remote flags any that yield empty PV (stale layout)."
fi

# ── 3. sync source + harnesses + fixtures, sha-verify ───────────────────────
echo "== sync guest source + harnesses + fixtures =="
tar czf /tmp/bp-sync.tgz -C "$GUEST_DIR" cxfer-core/src cxfer-core/Cargo.toml src harnesses fixtures \
  exec-crosslane.rs exec-gap.rs exec-farm.rs exec-reflect-prove.rs 2>/dev/null
$SCP /tmp/bp-sync.tgz scripts/box-prove-remote.sh scripts/parallel-ng-prove.sh "root@$BOX_HOST:/root/work/cxfer/" >/dev/null
LIB_SHA=$(shasum -a 256 "$GUEST_DIR/cxfer-core/src/lib.rs" | cut -d' ' -f1)
MAIN_SHA=$(shasum -a 256 "$GUEST_DIR/src/main.rs" | cut -d' ' -f1)
$SSH "cd /root/work/cxfer && rm -rf /tmp/bp && mkdir -p /tmp/bp && tar xzf bp-sync.tgz -C /tmp/bp \
  && cp -f /tmp/bp/cxfer-core/src/*.rs cxfer-core/src/ && cp -f /tmp/bp/src/* guest/src/ \
  && cp -f /tmp/bp/harnesses/*.rs /tmp/bp/exec-*.rs harnesses/ && cp -f /tmp/bp/fixtures/* fixtures/ \
  && chmod +x box-prove-remote.sh \
  && [ \"\$(sha256sum cxfer-core/src/lib.rs|cut -d' ' -f1)\" = \"$LIB_SHA\" ] || { echo 'SHA MISMATCH lib.rs'; exit 3; } \
  && [ \"\$(sha256sum guest/src/main.rs|cut -d' ' -f1)\" = \"$MAIN_SHA\" ] || { echo 'SHA MISMATCH main.rs'; exit 3; } \
  && echo '  source sha-verified == local'"

# ── 4. build ELFs (Go on PATH; ensure the bn dep the reflection bin needs) ──
echo "== build guest ELFs (both bins) =="
$SSH 'source ~/.cargo/env 2>/dev/null; export PATH="$PATH:/root/.sp1/bin:$HOME/.cargo/bin:/usr/local/go/bin"; cd /root/work/cxfer/guest
  # the box guest manifest (cxfer-core path/bin names are box-local) must declare bn for the reflection bin
  grep -q substrate-bn-succinct-rs Cargo.toml || sed -i "s|^alloy-sol-types = \"0.8\"|&\nbn = { package = \"substrate-bn-succinct-rs\", version = \"0.6.0\", default-features = false }|" Cargo.toml
  rm -f target/elf-compilation/*/release/cxfer-guest target/elf-compilation/*/release/reflection-prover
  cargo prove build 2>&1 | grep -iE "error|Finished" | tail -3
  ls target/elf-compilation/*/release/{cxfer-guest,reflection-prover} >/dev/null 2>&1 && echo "  both ELFs built" || { echo "  ELF BUILD FAILED (no fallback to stale)"; exit 4; }'

# ── 4.5. auto-derive the settle vkey from the freshly-built ELF (never hardcode) ─
echo "== derive settle vkey =="
PVK=$($SSH 'source ~/.cargo/env 2>/dev/null; export PATH="$PATH:/root/.sp1/bin:$HOME/.cargo/bin:/usr/local/go/bin"; cd /root/work/cxfer && cp -f harnesses/exec-swap.rs exec/src/main.rs && cd exec && MODE=execute OP_FILE=/root/work/cxfer/fixtures/swap_op.json cargo run --release 2>/dev/null | grep -oE "^VKEY=0x[0-9a-f]+" | head -1 | cut -d= -f2')
[ -n "$PVK" ] || { echo "vkey derive failed"; exit 5; }
echo "  PROGRAM_VKEY = $PVK"
[ "${BUILD_ONLY:-0}" = "1" ] && { echo "== BUILD_ONLY=1: stopping after fresh rebuild + vkey derive (no prove) =="; exit 0; }

# ── 5. prove (detached) + poll ──────────────────────────────────────────────
if [ "${PARALLEL:-0}" = "1" ]; then
  echo "== PARALLEL prove (detached on box, N=${N:-6}) — tail: parallel.status =="
  $SSH "cd /root/work/cxfer && chmod +x parallel-ng-prove.sh && PVK='$PVK' N='${N:-6}' TO='${TO:-2400}' setsid nohup bash parallel-ng-prove.sh >/root/parallel.out 2>&1 < /dev/null & echo started"
  SFILE=/root/work/cxfer/parallel.status
else
  echo "== prove (detached on box) — tail: box-prove.status =="
  $SSH "cd /root/work/cxfer && PVK='$PVK' ONLY='${ONLY:-}' TO='${TO:-900}' setsid nohup bash box-prove-remote.sh >/root/box-prove.out 2>&1 < /dev/null & echo started"
  SFILE=/root/work/cxfer/box-prove.status
fi
echo "poll:  ssh ... 'grep -E \"OK|FAIL|DONE\" $SFILE'"
until $SSH "grep -q '=== DONE' $SFILE 2>/dev/null"; do sleep 60; $SSH "tail -1 $SFILE" 2>/dev/null || true; done
$SSH 'echo "=== manifest ==="; cat /root/work/cxfer/out-v1/manifest.tsv'

# ── 6. pull + assemble fixtures ─────────────────────────────────────────────
if [ "${NO_PULL:-0}" != "1" ]; then
  echo "== pull + assemble *_groth16.json =="
  echo "  (run: scripts/box-prove-pull.sh — assembles {vkey, publicValues, proofBytes} per op)"
fi
echo "== box-prove done =="
