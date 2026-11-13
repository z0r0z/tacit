#!/bin/sh
# Prove for Tacit from a machine with an NVIDIA GPU, for TAC. This installs tacit-prover-worker (the build pinned below, its sha256 checked
# before anything is run) and keeps it running in community mode. A card of 24 GB or more takes its turn at the prover board's public
# Bitcoin-state batches (the board gives each batch to one machine, in turn), and each batch the relay takes earns the address the board's
# points for it. A card of 16 to 23 GB, which a batch does not fit, proves the proof pool's wraps instead (deposits proved ahead for the pages;
# their inputs hold no secret) with SP1's GPU server built for less memory, pinned below, and each wrap the pool takes earns the pool's points.
# Bigger cards prove wraps too, between batches. The TAC comes from the points service. No key, no token, no ETH.
#
#   curl -fsSL https://tacit.finance/prove-gpu.sh | sh -s -- 0xYourAddress    install it and start it; the TAC goes to that address
#   curl -fsSL https://tacit.finance/prove-gpu.sh | sh -s -- --status         is it running, and its last lines
#   curl -fsSL https://tacit.finance/prove-gpu.sh | sh -s -- --stop           stop it
#
# x86-64 Linux with an NVIDIA GPU of 16 GB or more and compute capability 8.0 or newer (an RTX A4000, 4060 Ti 16 GB, 4080, 5080 or larger), its
# CUDA 12 driver and the CUDA 12 runtime, libcudart.so.12. A batch is billions of cycles: tens of minutes on a 24 GB GPU; a wrap a minute or
# two. The first start fetches SP1's GPU server and its Groth16 artifacts (about 8 GB). Under WSL 2 the GPU is the Windows driver's, and
# nothing here has been run there yet. A smaller or older card gets the regular node instead (prove.sh, for the same address).
# The whole script is one function called on the last line, so a download cut short runs nothing. Environment: TACIT_GPU_HOME is where it
# lives (~/.tacit-gpu).

set -eu

PIN_TAG=prover-bins-v21
PIN_WORKER=706f69d58147aacabcd30d3a5f5293f527e0f8f9d883a6631b07490593575726
# SP1's GPU server for a card under 24 GB: sp1 v6.3.1 with contracts/sp1/confidential/prover-worker/sp1-gpu/lowmem.patch, built by
# .github/workflows/build-sp1-gpu-lowmem.yml. It is the stock server unless the SP1_GPU_* settings are set, which run.sh does for such a card:
# smaller shards, so a proof fits in the card's memory. It takes the stock server's place in ~/.sp1/bin, where the worker's SDK looks for it.
PIN_SERVER_LOWMEM=399f57725142ad827fcf4631131571279348566d5960849f5926e5573fbe05b5
# A 16 GB card's core-shard size (SP1_GPU_ELEMENT_THRESHOLD). Measured on an RTX A4000 (16 GB): a wrap peaks at 15.3 GB of the card, at this
# size or half of it. A 12 GB card does not fit SP1 6.3.1's GPU prover: its proving keys alone hold about 8.6 GB of the card.
SHARD_16GB=134217728
# SP1's Groth16 proving files the worker's SP1 version asks for (its first proof fetches them over one connection, slowly, and a fetch cut
# short leaves a folder it takes for finished): pinned with the worker, fetched here over several connections and checked.
PIN_CIRCUITS=v6.1.0
PIN_CIRCUITS_BYTES=6211807514
PIN_CIRCUITS_SHA256=18beebb6cd0cc9b4d4a240ee4f49511da6c2a7e51724bad4232de538a9147810
CIRCUITS_URL="https://sp1-circuits.s3-us-east-2.amazonaws.com/$PIN_CIRCUITS-groth16.tar.gz"
BASE="https://github.com/z0r0z/tacit/releases/download"
POOL_VKEY=0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3

say() { printf '%s\n' "$*"; }
die() { printf 'prove-gpu.sh: %s\n' "$*" >&2; exit 1; }

is_addr() { hex=${1#0x}; [ "$1" != "$hex" ] && [ "${#hex}" -eq 40 ] && [ -z "$(printf '%s' "$hex" | tr -d '0-9a-fA-F')" ]; }

is_wsl() { [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft "${TACIT_PROC_VERSION:-/proc/version}" 2>/dev/null; }

# SP1's GPU server, which the worker fetches and starts, is linked against libcudart.so.12, the CUDA runtime: it comes with the toolkit, not
# the driver, and has to be where the loader looks (its cache, LD_LIBRARY_PATH or its own folders). Where the cache cannot be read, nothing is
# refused: the server says so itself if the library is missing.
has_cudart() {
  cache=$(ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null) || cache=
  [ -n "$cache" ] || return 0
  printf '%s\n' "$cache" | grep -q 'libcudart\.so\.12 ' && return 0
  ifs=$IFS; IFS=':;'
  for d in ${LD_LIBRARY_PATH:-} /lib /usr/lib /lib64 /usr/lib64 /lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu; do
    [ -e "$d/libcudart.so.12" ] && { IFS=$ifs; return 0; }
  done
  IFS=$ifs
  return 1
}

# The worker and SP1's GPU server are built against glibc 2.34; on an older one neither starts. Another libc is left to them.
# A card SP1's GPU server cannot take still sits in a computer that can prove: the regular node (prove.sh) proves the pool's deposits and
# mines salts on its CPU, for the same address. TACIT_GPU_ONLY=1 stops here instead; TACIT_NODE_SCRIPT is where prove.sh comes from.
node_instead() {
  say "$1. Setting up the regular node instead: it proves the pool's deposits and mines salts on this computer's CPU, for $ADDR."
  [ "${TACIT_GPU_ONLY:-}" != 1 ] || exit 1
  command -v curl >/dev/null 2>&1 || die "curl is needed."
  node=$(mktemp)
  curl -fsSL "${TACIT_NODE_SCRIPT:-https://tacit.finance/prove.sh}" -o "$node" || { rm -f "$node"; die "the node's installer did not download: run curl -fsSL https://tacit.finance/prove.sh | sh -s -- $ADDR"; }
  rc=0; sh "$node" "$ADDR" || rc=$?
  rm -f "$node"
  exit "$rc"
}

check_glibc() {
  v=$(ldd --version 2>&1 | head -n 1 | awk '{print $NF}')
  maj=${v%%[!0-9]*}; rest=${v#*.}; min=${rest%%[!0-9]*}
  { [ -n "$maj" ] && [ -n "$min" ] && [ "$v" != "$rest" ]; } || return 0
  if [ "$maj" -lt 2 ] || { [ "$maj" -eq 2 ] && [ "$min" -lt 34 ]; }; then die "this Linux has glibc $v, and the prover needs 2.34 or newer: Ubuntu 22.04, Debian 12 or newer."; fi
}

# The pid in run.pid while that process is still this install's run.sh (a pid left from before a reboot can be anyone's).
run_pid() {
  p=$(cat "$HOME_DIR/run.pid" 2>/dev/null || true)
  case $p in ''|*[!0-9]*) return 0 ;; esac
  case $(tr '\0' ' ' 2>/dev/null < "/proc/$p/cmdline" || ps -p "$p" -o args= 2>/dev/null || true) in *"$HOME_DIR/run.sh"*) printf '%s' "$p" ;; esac
}

# SP1's Groth16 files in the folder the SDK reads them from ($HOME/.sp1/circuits/groth16/<version>; the SDK skips its own fetch when the folder
# exists), fetched in CIRCUITS_PARTS ranges at once, checked against the pin, unpacked beside it and moved into place whole. A folder left by
# a fetch cut short (it still holds artifacts.tar.gz) is cleared first, and so are the parts of one. Returns 1, having said why, when it could not: the worker then does
# its own, slower fetch.
fetch_circuits() {
  dir="${SP1_GROTH16_CIRCUIT_PATH:-$HOME/.sp1/circuits/groth16}"; dest="$dir/$PIN_CIRCUITS"
  if [ -d "$dest" ]; then
    [ -e "$dest/artifacts.tar.gz" ] || return 0
    rm -rf "$dest"
  fi
  parts="${TACIT_CIRCUITS_PARTS:-8}"; url="${TACIT_CIRCUITS_URL:-$CIRCUITS_URL}"
  mkdir -p "$dir" || return 1
  need="${TACIT_CIRCUITS_MIN_GB:-20}"; free=$(df -Pk "$dir" | awk 'NR==2 {print int($4 / 1048576)}')
  case $free in ''|*[!0-9]*) ;; *) [ "$free" -ge "$need" ] || { say "note: only $free GB are free where SP1's files go (it needs about $need GB while it unpacks)"; return 1; } ;; esac
  tmp="$dir/.part-$$"; rm -rf "$dir"/.part-*; mkdir -p "$tmp/x" || return 1
  say "Fetching SP1's Groth16 proving files (about $((PIN_CIRCUITS_BYTES / 1000000000)) GB) over $parts connections"
  chunk=$(( (PIN_CIRCUITS_BYTES + parts - 1) / parts ))
  # one range into its file, picking up where a dropped or stalled connection left it (what curl got is appended as it comes)
  fetch_range() {
    f="$tmp/p$1"; want=$(($3 - $2 + 1)); tries=0
    : > "$f"
    while [ "$(wc -c < "$f")" -lt "$want" ] && [ "$tries" -lt 30 ]; do
      curl -fsS --connect-timeout 20 --speed-limit 20000 --speed-time 20 -r "$(($2 + $(wc -c < "$f")))-$3" "$url" >> "$f" 2>/dev/null || sleep 2
      tries=$((tries + 1))
    done
  }
  (
    i=0
    while [ "$i" -lt "$parts" ]; do
      a=$((i * chunk)); b=$((a + chunk - 1)); [ "$b" -lt "$PIN_CIRCUITS_BYTES" ] || b=$((PIN_CIRCUITS_BYTES - 1))
      fetch_range "$i" "$a" "$b" &
      i=$((i + 1))
    done
    wait
  ) &
  dl=$!
  # a run cut short takes its half-fetched parts with it
  trap 'kill "$dl" 2>/dev/null; rm -rf "$tmp"; exit 1' INT TERM
  while kill -0 "$dl" 2>/dev/null; do
    sleep "${TACIT_CIRCUITS_POLL:-15}"
    say "  $(du -sk "$tmp" | awk '{print int($1 / 1024)}') MB of $((PIN_CIRCUITS_BYTES / 1000000))"
  done
  i=0; list=""
  while [ "$i" -lt "$parts" ]; do
    a=$((i * chunk)); b=$((a + chunk - 1)); [ "$b" -lt "$PIN_CIRCUITS_BYTES" ] || b=$((PIN_CIRCUITS_BYTES - 1))
    [ "$(wc -c < "$tmp/p$i" 2>/dev/null || echo 0)" -eq $((b - a + 1)) ] || { say "note: the fetch of SP1's files came up short"; rm -rf "$tmp"; return 1; }
    list="$list $tmp/p$i"; i=$((i + 1))
  done
  # shellcheck disable=SC2086
  got=$(cat $list | sha256sum | cut -d' ' -f1)
  [ "$got" = "$PIN_CIRCUITS_SHA256" ] || { say "note: SP1's files did not match their pin ($got): not used"; rm -rf "$tmp"; return 1; }
  say "Unpacking them"
  # shellcheck disable=SC2086
  cat $list | tar -Pxzf - -C "$tmp/x" 2>/dev/null || { say "note: SP1's files did not unpack"; rm -rf "$tmp"; return 1; }
  rm -f $list
  # the folder is replaced whole: moved into one that appeared meanwhile, the files would land in a subfolder of it
  rm -rf "$dest"
  mv "$tmp/x" "$dest" || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  trap - INT TERM
}

main() {
  HOME_DIR="${TACIT_GPU_HOME:-$HOME/.tacit-gpu}"
  BIN="$HOME_DIR/tacit-prover-worker"
  case "${1:-}" in
    --status)
      p=$(run_pid); if [ -n "$p" ]; then say "running (pid $p)"; else say "not running"; fi
      [ -f "$HOME_DIR/worker.log" ] && tail -n 8 "$HOME_DIR/worker.log"
      return 0 ;;
    --stop)
      p=$(run_pid); [ -z "$p" ] || kill -- "-$p" 2>/dev/null || true; rm -f "$HOME_DIR/run.pid"
      say "stopped"
      return 0 ;;
  esac
  ADDR="${1:-}"
  is_addr "$ADDR" || die "give the 0x address the TAC goes to: sh -s -- 0xYourAddress"
  case $(uname -s) in MINGW*|MSYS*|CYGWIN*) die "this does not run in Git Bash. On Windows it would run inside WSL 2 (in PowerShell: wsl --install), in the Ubuntu window." ;; esac
  [ "$(uname -s)" = Linux ] && { [ "$(uname -m)" = x86_64 ] || [ "$(uname -m)" = amd64 ]; } || die "this needs x86-64 Linux with an NVIDIA GPU."
  check_glibc
  # In WSL the driver's tools are the Windows driver's, in /usr/lib/wsl/lib: on the PATH of Ubuntu's user, not of root.
  smi=$(command -v nvidia-smi 2>/dev/null || true)
  if [ -z "$smi" ] && [ -x /usr/lib/wsl/lib/nvidia-smi ]; then smi=/usr/lib/wsl/lib/nvidia-smi; fi
  if [ -z "$smi" ]; then
    if is_wsl; then die "no NVIDIA driver found (nvidia-smi). In WSL it is the Windows one: install NVIDIA's driver on Windows, and no Linux driver inside Ubuntu."; fi
    die "no NVIDIA driver found (nvidia-smi). This proves on a GPU."
  fi
  # The card with the most memory proves, and the others (one driving the display, say) are left alone. nvidia-smi numbers the cards in PCI
  # order, as CUDA does with CUDA_DEVICE_ORDER=PCI_BUS_ID, which run.sh sets.
  best=$("$smi" --query-gpu=index,memory.total --format=csv,noheader,nounits 2>/dev/null | tr -d ' ' | sort -t, -k2 -rn | head -1)
  gpu=${best%%,*}; mem=${best#*,}
  case $gpu in ''|*[!0-9]*) die "nvidia-smi did not list the GPUs (${best:-nothing}); the GPU prover needs one of 16 GB or more." ;; esac
  case $mem in ''|*[!0-9]*) die "nvidia-smi did not say how much memory the GPU has (${mem:-nothing}); the GPU prover needs 16 GB or more." ;; esac
  [ "$mem" -ge 15000 ] || node_instead "This GPU has $mem MiB, and SP1's GPU prover needs a 16 GB card"
  # SP1's GPU server carries code for sm_80 (Ampere) and newer only; a driver too old to say is left to the server.
  cc=$("$smi" --id="$gpu" --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | tr -d ' ' | head -1)
  case $cc in [1-7].[0-9]) node_instead "This GPU is compute capability $cc, and SP1's GPU server needs 8.0 or newer (an RTX A4000, 3090 or later)" ;; esac
  # A card under 24 GB takes no Bitcoin batch: it proves the pool's wraps with the smaller server, its shards sized for its memory.
  small=
  [ "$mem" -ge 23000 ] || small="BTC_STATE=0 SP1_GPU_MIN_GB=16 SP1_GPU_ELEMENT_THRESHOLD=$SHARD_16GB"
  # Under WSL the card also draws Windows' desktop, and what Windows holds is not there for a proof.
  if is_wsl; then
    used=$("$smi" --id="$gpu" --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
    case $used in ''|*[!0-9]*) ;; *) [ "$used" -lt 1024 ] || say "note: Windows is using $used MiB of this GPU now, and a proof is sized for the card's whole memory: close games and other GPU programs while it proves." ;; esac
  fi
  has_cudart || die "SP1's GPU server needs the CUDA 12 runtime, libcudart.so.12, which comes with the CUDA toolkit and not with the driver. On Ubuntu: add NVIDIA's CUDA repository (https://developer.nvidia.com/cuda-downloads, Linux > x86_64 > Ubuntu, or WSL-Ubuntu inside WSL) and sudo apt install cuda-cudart-12-8; or set LD_LIBRARY_PATH to the folder that has it."
  command -v curl >/dev/null 2>&1 || die "curl is needed."
  mkdir -p "$HOME_DIR"
  say "Downloading tacit-prover-worker ($PIN_TAG)"
  curl -fsSL -o "$BIN.part" "$BASE/$PIN_TAG/tacit-prover-worker"
  got=$(sha256sum "$BIN.part" | cut -d' ' -f1)
  [ "$got" = "$PIN_WORKER" ] || { rm -f "$BIN.part"; die "the download's sha256 is $got, not the pinned $PIN_WORKER: nothing was run."; }
  chmod +x "$BIN.part" && mv -f "$BIN.part" "$BIN"
  say "Checked its sha256 ($(printf '%s' "$got" | cut -c1-12)...)"
  # A run from before goes first, with its group (SP1's server in it), before the folder its first batch may be fetching into is touched.
  p=$(run_pid); [ -z "$p" ] || kill -- "-$p" 2>/dev/null || true
  n=0; while [ "$n" -lt 10 ] && [ -n "$(run_pid)" ]; do sleep 1; n=$((n + 1)); done
  if [ -n "$small" ]; then
    srv="$HOME/.sp1/bin/sp1-gpu-server"
    mkdir -p "$HOME/.sp1/bin"
    say "Downloading SP1's GPU server for a card under 24 GB ($PIN_TAG)"
    curl -fsSL -o "$srv.part" "$BASE/$PIN_TAG/sp1-gpu-server-lowmem"
    got=$(sha256sum "$srv.part" | cut -d' ' -f1)
    [ "$got" = "$PIN_SERVER_LOWMEM" ] || { rm -f "$srv.part"; die "the server's sha256 is $got, not the pinned $PIN_SERVER_LOWMEM: nothing was run."; }
    chmod +x "$srv.part" && mv -f "$srv.part" "$srv"
    say "Checked its sha256 ($(printf '%s' "$got" | cut -c1-12)...)"
  fi
  fetch_circuits || say "The worker fetches SP1's files itself on its first start instead; that takes longer."
  # One worker at a time, restarted after a crash with a pause; it re-reads nothing between starts but this script's settings.
  cat > "$HOME_DIR/run.sh" <<EOF
#!/bin/sh
cd "$HOME_DIR"
pause=15
while true; do
  t=\$(date +%s)
  # CUDA numbers the cards as nvidia-smi does (PCI order), so SP1's server proves on the card the checks above measured (GPU_DEVICE).
  # The pool's wraps go to whoever asks first, and a GPU proves one in a minute or two: it asks every 10 s, and stops for the day once
  # the pool pays its address nothing more.
  COMMUNITY_MINER=$ADDR WORKER_NAME=gpu-$(printf '%s' "$ADDR" | cut -c3-8) EXPECT_VKEY=$POOL_VKEY WARM=0 POLL_MS=4000 CUDA_DEVICE_ORDER=PCI_BUS_ID GPU_DEVICE=$gpu RELOAD_FLAG="$HOME_DIR/reload" \\
    WORKER_KEY_FILE="$HOME_DIR/worker.key" PAUSE_FLAG="$HOME_DIR/pause" RECYCLE_FLAG="$HOME_DIR/recycle" POOL_LEASE_FILE="$HOME_DIR/pool-lease.json" POOL_EVERY_SECS=10 $small "$BIN"
  # SP1's GPU server goes when the worker lets it go, not when the worker aborts: what is left in this group (this script leads it) goes
  # before the next start, so a crash never leaves a server holding the GPU's memory.
  trap '' TERM; kill -- -\$\$ 2>/dev/null; trap - TERM
  # A worker that stops within five minutes did not start: wait twice as long each time, up to an hour.
  if [ \$((\$(date +%s) - t)) -lt 300 ]; then pause=\$((pause < 1800 ? pause * 2 : 3600)); else pause=15; fi
  sleep \$pause
done
EOF
  chmod +x "$HOME_DIR/run.sh"
  (setsid sh "$HOME_DIR/run.sh" >> "$HOME_DIR/worker.log" 2>&1 & echo $! > "$HOME_DIR/run.pid")
  say ""
  who="$(printf '%s' "$ADDR" | cut -c1-6)...$(printf '%s' "$ADDR" | cut -c39-42)"
  if [ -n "$small" ]; then
    say "tacit-prover-worker is running for $who. This card proves the pool's wraps (a Bitcoin batch needs 24 GB), and each wrap the pool takes earns that address TAC."
  else
    say "tacit-prover-worker is running for $who. Bitcoin batches the relay takes from it earn that address TAC, and wraps for the pool between them."
  fi
  say "Watch it:  tacit.finance/prove   or   curl -fsSL https://tacit.finance/prove-gpu.sh | sh -s -- --status"
  say "Its log:   $HOME_DIR/worker.log"
  if is_wsl; then say "WSL stops Ubuntu a few seconds after its last window closes, and the worker with it: keep an Ubuntu window open while it proves."; fi
}

main "$@"
