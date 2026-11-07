#!/bin/sh
# fetches SP1's Groth16 proving files into $HOME/.sp1/circuits/groth16/v6.1.0 over 8 connections (from dapp/prove-gpu.sh's fetch_circuits)
PIN_CIRCUITS=v6.1.0
PIN_CIRCUITS_BYTES=6211807514
PIN_CIRCUITS_SHA256=18beebb6cd0cc9b4d4a240ee4f49511da6c2a7e51724bad4232de538a9147810
CIRCUITS_URL="https://sp1-circuits.s3-us-east-2.amazonaws.com/$PIN_CIRCUITS-groth16.tar.gz"
say() { printf "%s\n" "$*"; }
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
fetch_circuits || say "fetch did not finish"
