#!/bin/sh
# Prove Bitcoin batches for Tacit from a machine with a large NVIDIA GPU, for TAC. This installs tacit-prover-worker (the build pinned below, its
# sha256 checked before anything is run) and keeps it running in community mode: it races the prover board's public Bitcoin-state batches,
# and each batch the relay takes earns the address the board's points for it, paid in TAC by the points service. No key, no token, no ETH.
#
#   curl -fsSL https://tacit.finance/prove-gpu.sh | sh -s -- 0xYourAddress    install it and start it; the TAC goes to that address
#   curl -fsSL https://tacit.finance/prove-gpu.sh | sh -s -- --status         is it running, and its last lines
#   curl -fsSL https://tacit.finance/prove-gpu.sh | sh -s -- --stop           stop it
#
# x86-64 Linux with an NVIDIA GPU of 24 GB or more, its CUDA 12 driver and the CUDA 12 runtime, libcudart.so.12 (a rented RTX 3090, 4090,
# A5000 or larger works). A batch is billions of cycles: tens of minutes on such a GPU. The first start fetches SP1's GPU server and its
# Groth16 artifacts (about 8 GB). Under WSL 2 the GPU is the Windows driver's, and nothing here has been run there yet.
# The whole script is one function called on the last line, so a download cut short runs nothing. Environment: TACIT_GPU_HOME is where it
# lives (~/.tacit-gpu).

set -eu

PIN_TAG=prover-bins-v17
PIN_WORKER=9c8297ad19808b033301e25e37206e26f0e300f7aec03a730b52b45b6f5a4327
BASE="https://github.com/z0r0z/tacit/releases/download"
POOL_VKEY=0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3

say() { printf '%s\n' "$*"; }
die() { printf 'prove-gpu.sh: %s\n' "$*" >&2; exit 1; }

is_addr() { hex=${1#0x}; [ "$1" != "$hex" ] && [ "${#hex}" -eq 40 ] && [ -z "$(printf '%s' "$hex" | tr -d '0-9a-fA-F')" ]; }

is_wsl() { [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft "${TACIT_PROC_VERSION:-/proc/version}" 2>/dev/null; }

# SP1's GPU server, which the worker fetches and starts, is linked against libcudart.so.12, the CUDA runtime: it comes with the toolkit, not
# the driver, and has to be where the loader looks (its cache, or LD_LIBRARY_PATH).
has_cudart() {
  { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep -q 'libcudart\.so\.12 ' && return 0
  ifs=$IFS; IFS=:
  for d in ${LD_LIBRARY_PATH:-}; do [ -e "$d/libcudart.so.12" ] && { IFS=$ifs; return 0; }; done
  IFS=$ifs
  return 1
}

main() {
  HOME_DIR="${TACIT_GPU_HOME:-$HOME/.tacit-gpu}"
  BIN="$HOME_DIR/tacit-prover-worker"
  case "${1:-}" in
    --status)
      if [ -f "$HOME_DIR/run.pid" ] && kill -0 "$(cat "$HOME_DIR/run.pid")" 2>/dev/null; then say "running (pid $(cat "$HOME_DIR/run.pid"))"; else say "not running"; fi
      [ -f "$HOME_DIR/worker.log" ] && tail -n 8 "$HOME_DIR/worker.log"
      return 0 ;;
    --stop)
      if [ -f "$HOME_DIR/run.pid" ]; then kill -- "-$(cat "$HOME_DIR/run.pid")" 2>/dev/null || kill "$(cat "$HOME_DIR/run.pid")" 2>/dev/null || true; rm -f "$HOME_DIR/run.pid"; fi
      say "stopped"
      return 0 ;;
  esac
  ADDR="${1:-}"
  is_addr "$ADDR" || die "give the 0x address the TAC goes to: sh -s -- 0xYourAddress"
  case $(uname -s) in MINGW*|MSYS*|CYGWIN*) die "this does not run in Git Bash. On Windows it would run inside WSL 2 (in PowerShell: wsl --install), in the Ubuntu window." ;; esac
  [ "$(uname -s)" = Linux ] && { [ "$(uname -m)" = x86_64 ] || [ "$(uname -m)" = amd64 ]; } || die "this needs x86-64 Linux with an NVIDIA GPU."
  # In WSL the driver's tools are the Windows driver's, in /usr/lib/wsl/lib: on the PATH of Ubuntu's user, not of root.
  smi=$(command -v nvidia-smi 2>/dev/null || true)
  if [ -z "$smi" ] && [ -x /usr/lib/wsl/lib/nvidia-smi ]; then smi=/usr/lib/wsl/lib/nvidia-smi; fi
  if [ -z "$smi" ]; then
    if is_wsl; then die "no NVIDIA driver found (nvidia-smi). In WSL it is the Windows one: install NVIDIA's driver on Windows, and no Linux driver inside Ubuntu."; fi
    die "no NVIDIA driver found (nvidia-smi). This proves on a GPU."
  fi
  mem=$("$smi" --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
  case $mem in ''|*[!0-9]*) die "nvidia-smi did not say how much memory the GPU has (${mem:-nothing}); a Bitcoin batch needs 24 GB or more." ;; esac
  [ "$mem" -ge 23000 ] || die "the GPU has $mem MiB; a Bitcoin batch needs 24 GB or more."
  # Under WSL the card also draws Windows' desktop, and what Windows holds is not there for a batch.
  if is_wsl; then
    used=$("$smi" --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
    case $used in ''|*[!0-9]*) ;; *) [ "$used" -lt 1024 ] || say "note: Windows is using $used MiB of this GPU now, and a Bitcoin batch is sized for a 24 GB card: close games and other GPU programs while it proves." ;; esac
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
  # One worker at a time, restarted after a crash with a pause; it re-reads nothing between starts but this script's settings.
  if [ -f "$HOME_DIR/run.pid" ]; then kill -- "-$(cat "$HOME_DIR/run.pid")" 2>/dev/null || true; fi
  cat > "$HOME_DIR/run.sh" <<EOF
#!/bin/sh
cd "$HOME_DIR"
while true; do
  COMMUNITY_MINER=$ADDR WORKER_NAME=gpu-$(printf '%s' "$ADDR" | cut -c3-8) EXPECT_VKEY=$POOL_VKEY WARM=0 RELOAD_FLAG="$HOME_DIR/reload" "$BIN"
  sleep 15
done
EOF
  chmod +x "$HOME_DIR/run.sh"
  (setsid sh "$HOME_DIR/run.sh" >> "$HOME_DIR/worker.log" 2>&1 & echo $! > "$HOME_DIR/run.pid")
  say ""
  say "tacit-prover-worker is running for $(printf '%s' "$ADDR" | cut -c1-6)...$(printf '%s' "$ADDR" | cut -c39-42). Bitcoin batches the relay takes from it earn that address TAC."
  say "Watch it:  tacit.finance/prove   or   curl -fsSL https://tacit.finance/prove-gpu.sh | sh -s -- --status"
  say "Its log:   $HOME_DIR/worker.log"
  if is_wsl; then say "WSL stops Ubuntu a few seconds after its last window closes, and the worker with it: keep an Ubuntu window open while it proves."; fi
}

main "$@"
