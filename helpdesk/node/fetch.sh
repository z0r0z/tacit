#!/bin/bash
# Puts the two files a help desk node needs in ~/.tacit-helpdesk-node/ (HELPDESK_NODE_DIR): llama.cpp's llama-server (release b12211) and the
# 2.7 GB Qwen3.5-4B model file. Both are checked against pinned SHA-256 sums before anything is used; a mismatch stops here.
#   bash fetch.sh                 fetch what is missing (resumable: run it again if it is interrupted)
#   bash fetch.sh --no-model      only llama-server
#   bash fetch.sh --model-only    only the model
#   bash fetch.sh --status | --uninstall
# run.sh calls this for you.
set -u
BASE=https://github.com/ggml-org/llama.cpp/releases/download/b12211
MODEL_URL=${HELPDESK_MODEL_URL:-https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf}
MODEL_SHA=${HELPDESK_MODEL_SHA:-00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4}; MODEL_SIZE=${HELPDESK_MODEL_SIZE:-2740937888}   # the three overrides are for tests
D=${HELPDESK_NODE_DIR:-$HOME/.tacit-helpdesk-node}; mkdir -p "$D"
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
# The CUDA runtime is a second tarball and unpacks beside llama-server's folder, not into it. The server's GPU backend finds libcublas only next to itself, so
# without these links it sees no GPU and quietly runs on the CPU. Safe to repeat (it also repairs an install made before this).
link_cuda_libs() {
  bin=$(find "$D/llama" -name llama-server -type f 2>/dev/null | head -1); [ -n "$bin" ] || return 0
  libdir=$(dirname "$bin")
  for c in "$D"/llama/cudart-*; do [ -d "$c" ] || continue; for f in "$c"/*.so*; do [ -e "$f" ] && ln -sf "$f" "$libdir/$(basename "$f")"; done; done
  return 0
}
install_llama() {
  [ -x "$D/llama-server" ] && { link_cuda_libs; return 0; }
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) ASSETS="llama-b12211-bin-macos-arm64.tar.gz:4da4edb437358d31d55938ad849d262ca31b0e0ffb35e9caedb727a0cd5a8f0f";;
    Linux-x86_64)
      # the prebuilt llama-server is built on Ubuntu 24.04: say so up front rather than let it fail at start
      g=$(ldd --version 2>&1 | head -1 | grep -o '[0-9][0-9]*\.[0-9][0-9]*$')
      [ -n "$g" ] && [ "$(printf '%s\n2.38\n' "$g" | sort -V | head -1)" = "2.38" ] || die "this llama.cpp build needs glibc 2.38 or newer (Ubuntu 24.04, Debian 13, Fedora 39); this system has ${g:-an unknown version}"
      ldconfig -p 2>/dev/null | grep -q 'libgomp\.so\.1' || die "libgomp is missing: install it first (apt install libgomp1)"
      vram=0; command -v nvidia-smi >/dev/null && vram=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -dc 0-9)
      if [ "${vram:-0}" -ge 6000 ]; then ASSETS="llama-b12211-bin-ubuntu-cuda-12.8-x64.tar.gz:103fac975e807da6cdb5717e87ca594e25bb7703dd8a7f10c22269c124e1a552 cudart-llama-b12211-bin-ubuntu-cuda-12.8-x64.tar.gz:d66dba34f0e45c66ce7d4484116c681aa71ff257ee1e47b02d9775aa59b5ef77"
      else ASSETS="llama-b12211-bin-ubuntu-x64.tar.gz:962924b5431bc1237a9e5d26ba072d37b6fe05f79b495206e7ff6134887624c5"; fi;;
    *) die "this package supports macOS on Apple silicon and Linux x86_64";;
  esac
  mkdir -p "$D/llama"
  for a in $ASSETS; do f=${a%%:*}; s=${a##*:}; say "downloading $f"; fetch_verified "$BASE/$f" "$D/$f" "$s"; tar -xzf "$D/$f" -C "$D/llama" && rm -f "$D/$f"; done
  bin=$(find "$D/llama" -name llama-server -type f | head -1); [ -n "$bin" ] || die "llama-server not found in the download"
  chmod +x "$bin"; ln -sf "$bin" "$D/llama-server"; link_cuda_libs
}
install_model() {
  M="$D/model.gguf"; [ -f "$M" ] && [ "$(fsize "$M")" = "$MODEL_SIZE" ] && [ "$(sha "$M")" = "$MODEL_SHA" ] && return 0
  say "downloading the model (2.7 GB, resumable)"
  STALL=${HELPDESK_FETCH_STALL:-20}   # seconds under 20 KB/s before an attempt is given up (and so how long a silent connection can hold one)
  parts="$D/.model-parts"; mkdir -p "$parts"; n=8; ch=$(( (MODEL_SIZE + n - 1) / n ))
  for i in 0 1 2 3 4 5 6 7; do
    s=$(( i * ch )); e=$(( s + ch - 1 )); [ $e -ge $MODEL_SIZE ] && e=$(( MODEL_SIZE - 1 )); want=$(( e - s + 1 )); p="$parts/p$i"
    # Each chunk keeps asking until it is whole. The CDN's link expires after about an hour, so it is looked up again every time; -f means an error
    # page is never written into the chunk; a stall, a silent or dropped connection, or a sleeping computer just costs the next attempt.
    ( for t in $(seq 1 "${HELPDESK_FETCH_TRIES:-1000}"); do have=0; [ -f "$p" ] && have=$(fsize "$p"); [ "$have" -ge "$want" ] && break
        final=$(curl -sL --connect-timeout 15 --max-time $(( STALL + 15 )) -r 0-0 -o /dev/null -w '%{url_effective}' "$MODEL_URL") || { sleep 5; continue; }
        curl -sfL --connect-timeout 15 --speed-limit 20000 --speed-time "$STALL" -r $(( s + have ))-$e "$final" >> "$p" || sleep 3; done ) &
  done; wait
  got=0; for i in 0 1 2 3 4 5 6 7; do got=$(( got + $(fsize "$parts/p$i") )); done
  [ "$got" = "$MODEL_SIZE" ] || die "the download is incomplete ($(( got / 1048576 )) of $(( MODEL_SIZE / 1048576 )) MB): run this again, it carries on from here"
  : > "$M.part"; for i in 0 1 2 3 4 5 6 7; do cat "$parts/p$i" >> "$M.part"; done
  [ "$(sha "$M.part")" = "$MODEL_SHA" ] || { rm -rf "$M.part" "$parts"; die "the model's checksum does not match, so the download was thrown away: run this again to start over"; }
  mv "$M.part" "$M"; rm -rf "$parts"
}
[ "$(df -k "$D" | awk 'NR==2 {print int($4/1024)}')" -ge 4000 ] || die "needs about 4 GB free in $D"
[ "${1:-}" = --model-only ] || install_llama; [ "${1:-}" = --no-model ] || install_model
say "done."
