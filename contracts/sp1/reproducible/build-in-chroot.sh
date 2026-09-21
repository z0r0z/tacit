#!/usr/bin/env bash
# Rebuild the three pinned gen5 SP1 guest ELFs from their source commits and compare each result with the
# pinned sha256 and verifying key. See docs/REPRODUCIBLE-BUILDS.md for the full procedure and its rationale.
#
# Run this INSIDE a container or chroot whose filesystem has the tacit source tree layout at /workspace/tacit
# and the toolchain described in expected.json. Two of the inputs are embedded in the ELF bytes, so they are not
# free choices:
#   - the location of the Cargo home (dependency source paths appear in panic locations), and
#   - for the eth-reflection guest only, the absolute path of the source tree (/workspace/tacit/...).
# Building outside a private mount namespace (unshare / container / chroot) is fine as long as those paths match.
#
# What the script does, per ELF:
#   1. wipe $TREE/contracts/sp1 and extract the pinned commit into it with `git archive` (a clean tree, no
#      working-copy edits, no stale target/),
#   2. apply the one-line patch (eth-reflection only),
#   3. run the pinned `cargo prove build ... --locked` with the Cargo home that ELF was originally built under,
#   4. sha256sum the output and derive its verifying key with `cargo prove vkey --elf`,
#   5. print both next to the pinned values (expected.json, and elf-vkey-pin.json when present in $REPO).
#
# Usage:
#   REPO=/path/to/tacit-clone bash build-in-chroot.sh [settle|reflection|eth_reflection ...]
#
# Environment (defaults in brackets):
#   REPO        git clone that contains both pinned commits          [repository containing this script]
#   TREE        where the tree is placed; must stay /workspace/tacit [/workspace/tacit]
#   OUT         directory receiving the rebuilt ELFs                 [$PWD/repro-out]
#   SP1_BIN     directory holding cargo-prove                        [$HOME/.sp1/bin]
#   CARGO_BIN   directory holding the rustup cargo/rustc proxies     [/workspace/.cargo/bin]
#   RUSTUP_HOME rustup home whose `succinct` toolchain is rustc 1.94.0-dev [/workspace/.rustup]
#   RPC_URL     optional Ethereum RPC; if set, the pool bytecode is checked for the vkeys (via `cast`, else curl)
#
# Network access is required the first time: the locked git/registry dependencies are fetched into CARGO_HOME (a fresh,
# empty CARGO_HOME was verified to reproduce the pinned bytes). No /proc (bare chroot): see the shim section below.
# Exit status is 0 only if every requested ELF matches both its sha256 and its vkey.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPECTED="$HERE/expected.json"
PATCH_FILE="$HERE/eth-main-rs-original-build.patch"
REPO="${REPO:-$(git -C "$HERE" rev-parse --show-toplevel)}"
TREE="${TREE:-/workspace/tacit}"
OUT="${OUT:-$PWD/repro-out}"
SP1_BIN="${SP1_BIN:-$HOME/.sp1/bin}"
CARGO_BIN="${CARGO_BIN:-/workspace/.cargo/bin}"
export RUSTUP_HOME="${RUSTUP_HOME:-/workspace/.rustup}"
export PATH="$SP1_BIN:$CARGO_BIN:$PATH"
export LC_ALL=C

case "$TREE" in
  /workspace/tacit) ;;
  *) [ "${ALLOW_OTHER_TREE:-0}" = "1" ] \
       || { echo "refusing TREE=$TREE: the eth-reflection ELF embeds /workspace/tacit (set ALLOW_OTHER_TREE=1 to override)"; exit 2; } ;;
esac
[ -n "$TREE" ] && [ "$TREE" != "/" ] || { echo "bad TREE"; exit 2; }

# --- bare chroot without /proc -------------------------------------------------------------------------------------
# rustup's cargo/rustc proxies, rustc's own sysroot lookup and the rust-lld linker wrapper all locate themselves through
# /proc/self/exe. In a container (Docker) or a chroot with procfs mounted nothing below applies. In a bare chroot (no
# /proc, and often no way to mount it) the script therefore builds a small shim directory: cargo/rustc shims that run the
# toolchain binaries directly (honouring `+toolchain`), a host-linker shim that drops -fuse-ld=lld (only build scripts
# and proc-macros are linked with it; the guest ELF is linked by the succinct toolchain and is unaffected), and an
# LD_LIBRARY_PATH for every rustc (their $ORIGIN rpath cannot be resolved either).
if [ ! -e /proc/self/exe ]; then
  echo "note: /proc is not mounted; using direct toolchain shims instead of the rustup proxies"
  TCDIR="$RUSTUP_HOME/toolchains"
  if [ ! -e "$TCDIR/succinct/bin/rustc" ]; then   # `rustup toolchain link` may have recorded a path from outside the chroot
    cands=("$(dirname "$SP1_BIN")"/toolchains/*/)
    [ ${#cands[@]} -eq 1 ] && [ -x "${cands[0]}bin/rustc" ] && ln -sfn "${cands[0]%/}" "$TCDIR/succinct"
  fi
  [ -e "$TCDIR/succinct/bin/rustc" ] || { echo "no succinct toolchain under $TCDIR/succinct or $(dirname "$SP1_BIN")/toolchains"; exit 2; }
  HOST_TC=$(sed -n 's/^default_toolchain *= *"\(.*\)"/\1/p' "$RUSTUP_HOME/settings.toml" 2>/dev/null | head -1)
  if [ -z "$HOST_TC" ]; then
    for d in "$TCDIR"/*/; do [ "$(basename "$d")" = succinct ] || { HOST_TC=$(basename "$d"); break; }; done
  fi
  [ -x "$TCDIR/$HOST_TC/bin/cargo" ] || { echo "no host cargo under $TCDIR/$HOST_TC (install a stable toolchain with rustup)"; exit 2; }
  export TACIT_HOST_TC="$HOST_TC"
  SHIMS="${TMPDIR:-/tmp}/tacit-repro-shims"; rm -rf "$SHIMS"; mkdir -p "$SHIMS"
  cat > "$SHIMS/tool" <<'SHIM'
#!/bin/sh
name=$(basename "$0"); tc=${RUSTUP_TOOLCHAIN:-$TACIT_HOST_TC}
case "${1:-}" in +*) tc=${1#+}; shift ;; esac
d="$RUSTUP_HOME/toolchains"
[ -x "$d/$tc/bin/$name" ] || tc=$TACIT_HOST_TC
LD_LIBRARY_PATH="$d/$tc/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"; export LD_LIBRARY_PATH
exec "$d/$tc/bin/$name" "$@"
SHIM
  cat > "$SHIMS/hostcc" <<'SHIM'
#!/bin/sh
n=$#; i=0
while [ $i -lt $n ]; do
  a=$1; shift
  case "$a" in -fuse-ld=lld|-B*/gcc-ld) ;; *) set -- "$@" "$a" ;; esac
  i=$((i + 1))
done
exec cc "$@"
SHIM
  chmod +x "$SHIMS/tool" "$SHIMS/hostcc"
  ln -s tool "$SHIMS/cargo"; ln -s tool "$SHIMS/rustc"
  export PATH="$SHIMS:$PATH"
  export LD_LIBRARY_PATH="$(readlink -f "$TCDIR/succinct")/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="$SHIMS/hostcc"
fi

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# jget SECTION KEY -> value of "KEY" inside the "SECTION": { ... } object of expected.json (flat scalar fields).
jget() {
  awk -v s="\"$1\": {" -v k="\"$2\":" '
    index($0, s) { on = 1; next }
    on && index($0, k) { v = $0; sub(/^[^:]*: */, "", v); sub(/,? *$/, "", v); gsub(/"/, "", v); print v; exit }
  ' "$EXPECTED"
}
# pinget KEY -> top-level string field of the repo's elf-vkey-pin.json (empty if the file is absent).
pinget() {
  local f="$REPO/contracts/sp1/confidential/elf-vkey-pin.json"
  [ -f "$f" ] && sed -n "s/^  \"$1\": *\"\\([^\"]*\\)\".*/\\1/p" "$f" | head -1 || true
}

# --- toolchain preflight (informational: a mismatch here is the first thing to check when a hash differs) ---
echo "== toolchain"
echo "cargo-prove : $(cargo prove --version 2>&1 | head -1)"
echo "   expected : cargo-prove sp1 (4809e79 2026-06-01T14:24:14.406056341Z)"
echo "succinct    : $(rustc +succinct --version 2>&1 | head -1)   (expected: rustc 1.94.0-dev)"
echo "host cargo  : $(cargo --version 2>&1 | head -1)   (verified with cargo 1.98.1)"
echo

mkdir -p "$OUT"
FAIL=0
declare -a SUMMARY

# name  pin-sha-key  pin-vkey-key
build_one() {
  local name="$1" pin_sha_key="$2" pin_vkey_key="$3"
  local bin commit dir cmd chome want_sha want_vkey
  bin=$(jget "$name" bin); commit=$(jget "$name" source_commit); dir=$(jget "$name" build_dir)
  cmd=$(jget "$name" build_command); chome=$(jget "$name" cargo_home)
  want_sha=$(jget "$name" elf_sha256); want_vkey=$(jget "$name" vkey)

  echo "== $name  (commit ${commit:0:8}, CARGO_HOME=$chome)"
  rm -rf "$TREE/contracts/sp1"
  mkdir -p "$TREE"
  git -C "$REPO" -c safe.directory='*' archive --format=tar "$commit" \
      contracts/sp1/confidential contracts/sp1/eth-reflection | tar -x -C "$TREE"
  if [ "$name" = "eth_reflection" ]; then
    patch -p1 -d "$TREE" < "$PATCH_FILE"
  fi

  local elf="$TREE/$dir/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/$bin"
  ( cd "$TREE/$dir" && read -r -a argv <<< "$cmd" && CARGO_HOME="$chome" "${argv[@]}" ) || { echo "build failed"; FAIL=1; return; }
  cp "$elf" "$OUT/$name.elf"

  local got_sha got_vkey
  got_sha=$(sha256 "$OUT/$name.elf")
  got_vkey=$(cargo prove vkey --elf "$OUT/$name.elf" 2>&1 | grep -Eo '0x[0-9a-f]{64}' | head -1)

  local ok_sha=MISMATCH ok_vkey=MISMATCH
  [ "$got_sha" = "$want_sha" ] && ok_sha=match
  [ "$got_vkey" = "$want_vkey" ] && ok_vkey=match
  [ "$ok_sha" = match ] && [ "$ok_vkey" = match ] || FAIL=1

  echo "sha256 built  : $got_sha"
  echo "sha256 pinned : $want_sha   (expected.json)  -> $ok_sha"
  echo "               $(pinget "$pin_sha_key")   (elf-vkey-pin.json:$pin_sha_key)"
  echo "vkey built    : $got_vkey"
  echo "vkey pinned   : $want_vkey   (expected.json)  -> $ok_vkey"
  echo "               $(pinget "$pin_vkey_key")   (elf-vkey-pin.json:$pin_vkey_key)"
  echo
  SUMMARY+=("$name sha256=$ok_sha vkey=$ok_vkey")
}

WANT=("$@"); [ ${#WANT[@]} -gt 0 ] || WANT=(settle reflection eth_reflection)
for t in "${WANT[@]}"; do
  case "$t" in
    settle)         build_one settle         elf_sha256                 program_vkey ;;
    reflection)     build_one reflection     reflection_elf_sha256      bitcoin_relay_vkey ;;
    eth_reflection) build_one eth_reflection eth_reflection_elf_sha256  eth_reflection_vkey ;;
    *) echo "unknown target: $t"; exit 2 ;;
  esac
done

# --- optional on-chain cross-check: the settle and relay vkeys are PUSH32 immutables in the pool runtime code ---
# Uses `cast` when installed, otherwise a plain eth_getCode JSON-RPC call through curl.
if [ -n "${RPC_URL:-}" ]; then
  POOL=$(awk -F'"' '/"pool":/ {print $4}' "$EXPECTED")
  if command -v cast >/dev/null 2>&1; then
    code=$(cast code "$POOL" --rpc-url "$RPC_URL")
  elif command -v curl >/dev/null 2>&1; then
    code=$(curl -sS -m 60 -X POST -H 'content-type: application/json' \
      --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getCode\",\"params\":[\"$POOL\",\"latest\"]}" "$RPC_URL" \
      | sed -n 's/.*"result" *: *"\(0x[0-9a-fA-F]*\)".*/\1/p')
  else
    code=""
  fi
  if [ ${#code} -lt 100 ]; then
    echo "on-chain check: could not read runtime code of $POOL from $RPC_URL"; FAIL=1
  else
    for t in settle reflection; do
      v=$(jget "$t" vkey)
      n=$(printf '%s' "$code" | grep -o "7f${v#0x}" | wc -l | tr -d ' ')
      echo "on-chain $t vkey occurrences in $POOL runtime code: $n (expected 1)"
      [ "$n" = "1" ] || FAIL=1
    done
  fi
  echo
fi

echo "== summary"
printf '%s\n' "${SUMMARY[@]}"
exit "$FAIL"
