#!/bin/bash
# Puts the two files the prover's help desk job needs in ~/.tacit-prover/helpdesk/: llama.cpp's llama-server (release b12211) and the
# 2.7 GB Qwen3.5-4B model file. Both are checked against pinned SHA-256 sums before anything is used; a mismatch stops here.
#   sh helpdesk-fetch.sh                 fetch what is missing (resumable: run it again if it is interrupted)
#   sh helpdesk-fetch.sh --no-model      only llama-server
#   sh helpdesk-fetch.sh --status | --uninstall
# Then switch the job on: curl -s -X POST 127.0.0.1:47815/helpdesk -d '{"on":true,"api":"https://<the help desk API>"}'
set -u
BASE=https://github.com/ggml-org/llama.cpp/releases/download/b12211
MODEL_URL=https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf
MODEL_SHA=00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4; MODEL_SIZE=2740937888
D=${TACIT_PROVER_DIR:-$HOME/.tacit-prover}/helpdesk; mkdir -p "$D"
say() { printf '%s\n' "$*"; }; die() { printf 'error: %s\n' "$*" >&2; exit 1; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
fsize() { wc -c < "$1" | tr -d ' '; }
case "${1:-}" in
  --status) [ -x "$D/llama-server" ] && say "llama-server: installed" || say "llama-server: missing"; [ -f "$D/model.gguf" ] && [ "$(fsize "$D/model.gguf")" = "$MODEL_SIZE" ] && say "model: installed" || say "model: missing"; exit 0;;
  --uninstall) rm -rf "$D"; say "removed $D"; exit 0;;
esac
fetch_verified() {   # url file sha
  curl -fL -C - --retry 5 --retry-delay 3 -o "$2" "$1" || die "could not download $1"
  [ "$(sha "$2")" = "$3" ] || { rm -f "$2"; die "checksum mismatch for $1, refusing to use it"; }
}
install_llama() {
  [ -x "$D/llama-server" ] && return 0
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) ASSETS="llama-b12211-bin-macos-arm64.tar.gz:4da4edb437358d31d55938ad849d262ca31b0e0ffb35e9caedb727a0cd5a8f0f";;
    Linux-x86_64)
      vram=0; command -v nvidia-smi >/dev/null && vram=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -dc 0-9)
      if [ "${vram:-0}" -ge 6000 ]; then ASSETS="llama-b12211-bin-ubuntu-cuda-12.8-x64.tar.gz:103fac975e807da6cdb5717e87ca594e25bb7703dd8a7f10c22269c124e1a552 cudart-llama-b12211-bin-ubuntu-cuda-12.8-x64.tar.gz:d66dba34f0e45c66ce7d4484116c681aa71ff257ee1e47b02d9775aa59b5ef77"
      else ASSETS="llama-b12211-bin-ubuntu-x64.tar.gz:962924b5431bc1237a9e5d26ba072d37b6fe05f79b495206e7ff6134887624c5"; fi;;
    *) die "this package supports macOS on Apple silicon and Linux x86_64";;
  esac
  mkdir -p "$D/llama"
  for a in $ASSETS; do f=${a%%:*}; s=${a##*:}; say "downloading $f"; fetch_verified "$BASE/$f" "$D/$f" "$s"; tar -xzf "$D/$f" -C "$D/llama" && rm -f "$D/$f"; done
  bin=$(find "$D/llama" -name llama-server -type f | head -1); [ -n "$bin" ] || die "llama-server not found in the download"
  chmod +x "$bin"; ln -sf "$bin" "$D/llama-server"
}
install_model() {
  M="$D/model.gguf"; [ -f "$M" ] && [ "$(fsize "$M")" = "$MODEL_SIZE" ] && [ "$(sha "$M")" = "$MODEL_SHA" ] && return 0
  say "downloading the model (2.7 GB, resumable)"
  final=$(curl -sL -r 0-0 -o /dev/null -w '%{url_effective}' "$MODEL_URL"); parts="$D/.model-parts"; mkdir -p "$parts"; n=8; ch=$(( (MODEL_SIZE + n - 1) / n ))
  for i in 0 1 2 3 4 5 6 7; do
    s=$(( i * ch )); e=$(( s + ch - 1 )); [ $e -ge $MODEL_SIZE ] && e=$(( MODEL_SIZE - 1 )); want=$(( e - s + 1 )); p="$parts/p$i"
    ( for t in $(seq 1 40); do have=0; [ -f "$p" ] && have=$(fsize "$p"); [ "$have" -ge "$want" ] && break
        curl -sL --speed-limit 20000 --speed-time 20 -r $(( s + have ))-$e "$final" >> "$p" || true; done ) &
  done; wait
  : > "$M.part"; for i in 0 1 2 3 4 5 6 7; do cat "$parts/p$i" >> "$M.part"; done
  [ "$(sha "$M.part")" = "$MODEL_SHA" ] || { rm -f "$M.part"; die "model checksum mismatch (the partial download is kept in $parts: run this again)"; }
  mv "$M.part" "$M"; rm -rf "$parts"
}
[ "$(df -k "$D" | awk 'NR==2 {print int($4/1024)}')" -ge 4000 ] || die "needs about 4 GB free in $D"
install_llama; [ "${1:-}" = --no-model ] || install_model
say "done. Switch the job on with: curl -s -X POST 127.0.0.1:47815/helpdesk -d '{\"on\":true,\"api\":\"https://tacit-helpdesk.onrender.com\"}'"
