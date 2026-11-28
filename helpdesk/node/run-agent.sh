#!/bin/bash
# Runs a BIG-model node for tacit-bot's code agent: llama.cpp's llama-server with Qwen3.6-35B-A3B (a 22 GB file, 3B parameters active per token), and worker.mjs, which takes agent
# turns from the help desk (a turn is one step of a coding agent: the model reads the conversation and replies with a tool call or words). Nothing the model says is run on this machine:
# the tools and the tests run on the project's CI; this machine only answers.
#   MINER=0x… bash run-agent.sh        the first run downloads 22 GB (checked against a pinned SHA-256); stop it with Ctrl-C
# What it needs: about 30 GB of memory (the model's experts sit in RAM), 26 GB of free disk, Node 18+. It answers one turn at a time and uses most of the CPU while it does, so run it when
# the machine is otherwise idle. A GPU is optional: with 6+ GB of GPU memory the attention runs there and the experts stay in RAM (measured: 3.4 GB of VRAM, decode 39 tokens/s and prompts
# 800+ tokens/s on a 16-core server CPU; a laptop CPU will be slower); with 24+ GB the whole model sits on the GPU; Apple silicon uses its unified memory.
# Settings: HELPDESK_API, HELPDESK_NODE_DIR (default ~/.tacit-helpdesk-node-big), PORT (default 8096), CTX (default 32768), THREADS (default half the cores, 4 to 16), KINDS (default agent),
# DRY_RUN=1 (print what it would do and stop), HW_JSON (a hardware report to use instead of measuring, for tests).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
D=${HELPDESK_NODE_DIR:-$HOME/.tacit-helpdesk-node-big}; PORT=${PORT:-8096}; CTX=${CTX:-32768}
MODEL_ID=qwen3.6-35b-a3b-ud-q4_k_xl
MODEL_URL=https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf
MODEL_SHA=707a55a8a4397ecde44de0c499d3e68c1ad1d240d1da65826b4949d1043f4450; MODEL_SIZE=22360456160
NEED_RAM_GB=30; NEED_DISK_MB=26000
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[[ "${MINER:-}" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "set MINER to an Ethereum address (0x and 40 hex digits): the help desk credits your work to it"
command -v node >/dev/null || die "Node 18 or newer is needed (https://nodejs.org)"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || die "Node 18 or newer is needed, this is $(node --version)"

# what this machine has: the same measurement the worker reports to the help desk
HW=${HW_JSON:-$(node -e 'import(process.argv[1]).then((m) => console.log(JSON.stringify(m.hardware())))' "$HERE/worker.mjs")}
read -r RAM VRAM CORES UNI < <(node -e 'const h = JSON.parse(process.argv[1]); console.log(h.ram, h.vram, h.cores, h.unified ? 1 : 0)' "$HW")
[ "${RAM:-0}" -ge "$NEED_RAM_GB" ] || die "this needs about $NEED_RAM_GB GB of memory (the model is 22 GB); this machine has ${RAM:-0} GB. The small help desk node (run.sh, 4 GB) fits smaller machines."
THREADS=${THREADS:-$(( CORES / 2 ))}; [ "$THREADS" -ge 4 ] || THREADS=4; [ "$THREADS" -le 16 ] || THREADS=16
if [ "$UNI" = 1 ]; then GPU="-ngl 99"; WHERE="Apple silicon: the model sits in unified memory"
elif [ "$VRAM" -ge 24 ]; then GPU="-ngl 99"; WHERE="the whole model on the GPU"
elif [ "$VRAM" -ge 6 ]; then GPU="-ngl 99 --n-cpu-moe 99"; WHERE="attention on the GPU, the experts in RAM"
else GPU="-ngl 0"; WHERE="on the CPU (slow: a GPU of 6 GB or more helps a lot)"; fi
# the flags are what was measured: a batch of 2048 lets big prompts use the GPU (3-4x faster prompt reading), flash attention keeps the 32k context small, --jinja is what makes tool calls work
FLAGS=(--jinja -c "$CTX" -np 1 -fa on -b 2048 -ub 2048 --cache-reuse 256 -t "$THREADS" $GPU --host 127.0.0.1 --port "$PORT")
if [ "${DRY_RUN:-}" = 1 ]; then
  echo "plan: model $MODEL_ID, $WHERE"; echo "plan: llama-server -m $D/model.gguf ${FLAGS[*]}"; echo "plan: worker KINDS=${KINDS:-agent} MODEL_ID=$MODEL_ID LLM_URL=http://127.0.0.1:$PORT"; exit 0
fi

mkdir -p "$D"
FREE_MB=$(df -k "$D" | awk 'NR==2 {print int($4/1024)}'); HAVE_MODEL=0; [ -f "$D/model.gguf" ] && HAVE_MODEL=1
[ "$HAVE_MODEL" = 1 ] || [ "${FREE_MB:-0}" -ge "$NEED_DISK_MB" ] || die "the model needs about 26 GB of free disk in $D; there is ${FREE_MB:-0} MB"
# the download takes a while (22 GB): an idle laptop is kept awake for it. fetch.sh checks the pinned SHA-256 of llama.cpp and of the model before anything is used.
run_fetch() { HELPDESK_NODE_DIR="$D" HELPDESK_MODEL_URL="$MODEL_URL" HELPDESK_MODEL_SHA="$MODEL_SHA" HELPDESK_MODEL_SIZE="$MODEL_SIZE" bash "$HERE/fetch.sh"; }
if command -v caffeinate >/dev/null 2>&1; then caffeinate -i bash -c "$(declare -f run_fetch); HERE='$HERE' D='$D' MODEL_URL='$MODEL_URL' MODEL_SHA='$MODEL_SHA' MODEL_SIZE='$MODEL_SIZE' run_fetch" || exit 1; else run_fetch || exit 1; fi

LPID=
stop() { [ -n "$LPID" ] && kill "$LPID" 2>/dev/null; }
trap stop EXIT; trap 'exit 130' INT TERM
if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "a model server is already answering on port $PORT: using it"
else
  bin=$(find "$D/llama" -name llama-server -type f | head -1); [ -n "$bin" ] || die "llama-server was not installed, see $D"; libdir=$(dirname "$bin")
  echo "starting the model, $WHERE (log: $D/llama.log)"
  LD_LIBRARY_PATH="$libdir:${LD_LIBRARY_PATH:-}" DYLD_LIBRARY_PATH="$libdir:${DYLD_LIBRARY_PATH:-}" nice -n 5 "$bin" -m "$D/model.gguf" "${FLAGS[@]}" > "$D/llama.log" 2>&1 &
  LPID=$!
  for _ in $(seq 1 300); do   # loading 22 GB can take a few minutes
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
    kill -0 "$LPID" 2>/dev/null || die "the model stopped at start, see $D/llama.log"
    sleep 2
  done
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || die "the model did not come up in 10 minutes, see $D/llama.log"
  echo "model ready"
fi
LLM_URL="http://127.0.0.1:$PORT" MODEL_ID="$MODEL_ID" KINDS="${KINDS:-agent}" node "$HERE/worker.mjs"
