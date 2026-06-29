#!/usr/bin/env bash
# One-command FAST re-prove for the Sepolia V1 freeze. Drives the 128-core prover box end-to-end:
#   sync source/fixtures/harnesses → (opt) rebuild ELF + derive vkeys → PARALLEL native-gnark prove (N-way,
#   CPU, no GPU) → pull artifacts → apply pins + real-proof fixtures → forge *ProofReal green/red.
#
# At greenlight:   bash scripts/fast-reprove.sh
#   REBUILD_ELF=1  rebuild the guest ELF first (set this if the guest/cxfer-core changed since the last build)
#   N=<n>          prove concurrency (tune from the calibration; 128 cores ⇒ ~16; lower if RAM/load spikes)
#   BOX/PORT/KEY/REMOTE_ROOT override the prover box (defaults = the current Vast workspace)
#
# Idempotent + resumable: the prove phase skips ops whose artifacts already exist; rerun safely after a fix.
#
# SCOPE: this covers the SETTLE + REFLECTION guests (the 33 ops + 2 reflection fixtures). The eth-reflection
# (Mode-B) guest is a THIRD ELF — the ETHR-1/2 chain-bind + weak-subjectivity fixes rotate ETH_REFLECTION_VKEY,
# so re-derive it (contracts/sp1/eth-reflection eth_vkey.rs) + re-pin in reflect.rs SEPARATELY, and re-anchor
# the 3 eth chain values for mainnet IN LOCKSTEP (ops/CHECKLIST-mainnet-reprove.md). Not done here (its proof
# needs live ETH beacon data).
#
# PARITY GATE (run FIRST): bash contracts/sp1/confidential/verify-reflection-fixtures.sh — builds a fresh
# current-source reflection ELF + reflect-executes all 16 fixtures for guest↔JS DIGEST_MATCH. Catches a JS
# reflection-producer drift (e.g. the 2026-06-27 coinbase-at-index-0 divergence) BEFORE spending box prove
# time. If it's red, fix the producer first — proving a diverged fixture wastes the run.
#   GOTCHAS (verify-reflection-fixtures.sh): it FALLS BACK to the stale pinned ELF if `cargo prove build`
#   fails (false PASS), and gives false-negative FAILs if run concurrently with `cargo test`. ALWAYS confirm
#   the built ELF mtime/strings are current, and run it SERIALLY (no concurrent cargo test). swapbatch is an
#   EXPECTED skip (box-gated ceremony zkey, resolved at box-prove time) — not a failure.
#
# THREE-VKEY ORDERING (all three rotate from the current ELFs; reflect.rs EMBEDS ETH_REFLECTION_VKEY, so order
# is load-bearing — wrong order ⇒ BITCOIN_RELAY_VKEY derived against a stale eth vkey):
#   (a) build eth-reflection ELF (contracts/sp1/eth-reflection) → derive ETH_REFLECTION_VKEY (eth_vkey.rs,
#       a [u32;8] array) → re-pin it in reflect.rs:~301. SEPOLIA REHEARSAL: do NOT re-anchor the ETH genesis/
#       checkpoint/sync-committee constants — they are already the correct Sepolia anchor (re-anchor is a
#       MAINNET-only step, ops/CHECKLIST-mainnet-reprove.md H-1/2/3).
#   (b) build reflection ELF → BITCOIN_RELAY_VKEY    (c) build settle ELF → PROGRAM_VKEY
#   NOTE: confidential-reprove-apply.sh reconciles (b)+(c) [program_vkey/DEFAULT_VKEY + FROZEN_REFLECTION_*]
#   but NOT the eth [u32;8] re-pin — that's the manual pre-step in (a) above.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BOX=${BOX:-ssh8.vast.ai}; PORT=${PORT:-27240}; KEY=${KEY:-$HOME/.ssh/vast_prover}
CX=${REMOTE_ROOT:-/root/work/cxfer}
N=${N:-10}; REBUILD_ELF=${REBUILD_ELF:-0}   # 6 min/op solo on 128 cores ⇒ the prove already uses many cores; N=10 (driver default) avoids oversubscription. Watch the first batch's per-op time and bump only if cores sit idle.
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=20 -p $PORT root@$BOX"
RS="rsync -az -e"; SSHCMD="ssh -i $KEY -p $PORT"
say(){ echo "[fast-reprove $(date -u +%H:%M:%SZ)] $*"; }
remote_path(){ printf '%s' "$CX/$1"; }

say "1/6 sync guest + cxfer-core + harnesses + fixtures + prove driver → box"
$RS "$SSHCMD" "$ROOT/contracts/sp1/confidential/src/"             "root@$BOX:$CX/guest/src/"
$RS "$SSHCMD" "$ROOT/contracts/sp1/confidential/cxfer-core/src/"  "root@$BOX:$CX/cxfer-core/src/"
$RS "$SSHCMD" "$ROOT/contracts/sp1/confidential/harnesses/"       "root@$BOX:$CX/harnesses/"
$RS "$SSHCMD" "$ROOT/contracts/sp1/confidential/fixtures/"        "root@$BOX:$CX/fixtures/"
$RS "$SSHCMD" "$ROOT/scripts/parallel-ng-prove.sh"               "root@$BOX:$CX/parallel-ng-prove.sh"

ENVP='source $HOME/.cargo/env 2>/dev/null; export PATH=/usr/local/go/bin:$HOME/.sp1/bin:$HOME/.cargo/bin:$PATH'
if [ "$REBUILD_ELF" = "1" ]; then
  say "2/6 rebuild guest ELF (cargo prove build) — only after a guest/cxfer-core change"
  $SSH "$ENVP; cd $CX/guest && cargo prove build" 2>&1 | tail -3
fi
say "    deriving settle + reflection vkeys from the live ELF"
DERIVE=$($SSH "$ENVP; cd $CX/exec && cargo run --release --bin derive_v1 2>/dev/null")
PVK=$(printf '%s' "$DERIVE" | grep -oiE 'PROGRAM_VKEY=0x[0-9a-f]+' | grep -oE '0x[0-9a-f]+')
RVK=$(printf '%s' "$DERIVE" | grep -oiE 'BITCOIN_RELAY_VKEY=0x[0-9a-f]+' | grep -oE '0x[0-9a-f]+')
[ -z "$PVK" ] && { say "ABORT: could not derive PROGRAM_VKEY"; exit 2; }
say "    settle vkey  $PVK"
say "    reflect vkey $RVK"

say "3/6 PARALLEL native-gnark prove (N=$N) — the long pole (~45-75 min on 128 cores)"
$SSH "$ENVP; cd $CX && N=$N PVK=$PVK timeout 9000 bash $CX/parallel-ng-prove.sh" 2>&1 | tail -30

say "4/6 pull ELFs + Groth16 artifacts from box"
BOX=$BOX PORT=$PORT KEY=$KEY bash "$ROOT/scripts/confidential-reprove-apply.sh" pull 2>&1 | tail -20

say "5/6 apply: update pins (elf-vkey-pin.json / DEFAULT_VKEY / FROZEN_*) + all real-proof fixtures"
BOX=$BOX PORT=$PORT KEY=$KEY bash "$ROOT/scripts/confidential-reprove-apply.sh" apply 2>&1 | tail -20

say "6/6 forge *ProofReal (on-chain verify vs the freshly-pinned vkey)"
( cd "$ROOT/contracts" && forge test --match-path "test/Confidential*ProofReal*.t.sol" 2>&1 | grep -iE "Suite result|FAIL|passed|skipped|protofee" | tail -30 )
say "DONE. If all suites GREEN: commit the pin/fixture changes, then redeploy Sepolia (same salts) + seed."
