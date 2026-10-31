#!/bin/sh
# Prove wraps for Tacit's proof pool from this computer, for TAC points. This installs tacit-prover (the release pinned below, its
# sha256 checked before anything is run), sets it to start at login, and has it prove the pool's wraps while it has nothing of its
# own to prove.
#
#   curl -fsSL https://tacit.finance/prove.sh | sh -s -- 0xYourAddress     install it; the points go to that address
#   curl -fsSL https://tacit.finance/prove.sh | sh -s -- --status          is it running, what the pool has, what the address earned
#   curl -fsSL https://tacit.finance/prove.sh | sh -s -- --uninstall       stop it and take it away
#
# Apple-silicon Macs and x86-64 Linux. The whole script is one function called on the last line, so a download cut short runs nothing.
# Environment: TACIT_PROVER_NO_SERVICE=1 installs the program and stops there (run it by hand: tacit-prover mine 0x...); TACIT_PROVER_HOME
# is where it lives (~/.tacit-prover); TACIT_PROVER_TAG, TACIT_PROVER_BASE and TACIT_PROVER_SHA256 install a build of your own (with no
# sha256 given, the release's own .sha256 file is used). The pins are changed with tools/prove-pins.mjs when a release is cut.

set -eu

PIN_TAG=tacit-prover-v0.2.0
PIN_MACOS_ARM64=98ea307b8bb36eda3546d9b6bf0d8b31fe5197f696cba524ba3c30224bd283f5
PIN_LINUX_X86_64=1a9807db0b35a80b7dad0aca3478625484c7ed8d79074c9d0f7fc56bcc5e2ab1

say() { printf '%s\n' "$*"; }
warn() { printf 'note: %s\n' "$*" >&2; }
die() { printf 'prove.sh: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: sh -s -- [0xAddress] [--status] [--uninstall]
  0xAddress    install tacit-prover and have it prove the pool's wraps, the TAC points going to this address
  (nothing)    install it for this computer's own pages; the address of an earlier install is kept
  --status     is it running, what the pool has, what the address has earned (the address is the installed one unless given)
  --uninstall  stop it and take it away
EOF
}

# The release asset for this machine, in PLAT.
platform() {
  os=$(uname -s 2>/dev/null || echo unknown)
  arch=$(uname -m 2>/dev/null || echo unknown)
  case $os in
    Darwin)
      # A shell started under Rosetta says x86_64 on an Apple-silicon Mac; the machine is still arm64.
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
      [ "$arch" = arm64 ] || die "tacit-prover needs an Apple-silicon Mac (M1 or newer); this one says $arch."
      PLAT=macos-arm64 ;;
    Linux)
      case $arch in
        x86_64|amd64) PLAT=linux-x86_64 ;;
        *) die "there is no Linux build for $arch yet, only for x86-64." ;;
      esac ;;
    MINGW*|MSYS*|CYGWIN*) die "Windows runs this inside WSL: install it with wsl --install, then run the command in its Ubuntu window." ;;
    *) die "tacit-prover has builds for Apple-silicon Macs and x86-64 Linux; this is $os $arch." ;;
  esac
}

pin_for() {
  case $1 in
    macos-arm64) printf '%s' "$PIN_MACOS_ARM64" ;;
    linux-x86_64) printf '%s' "$PIN_LINUX_X86_64" ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/^.*= //'
  else die "sha256sum, shasum or openssl is needed to check the download."
  fi
}

# 0x and 40 hex digits, as tacit-prover reads it: any other TACIT_MINE it leaves unset, and the prover would run and mine for no one.
is_address() {
  case $1 in 0x*) ;; *) return 1 ;; esac
  hex=${1#0x}
  [ "${#hex}" -eq 40 ] && [ -z "$(printf '%s' "$hex" | tr -d '0-9a-fA-F')" ]
}

short_addr() { printf '%s...%s' "$(printf '%s' "$1" | cut -c1-6)" "$(printf '%s' "$1" | cut -c39-42)"; }

# The address a service installed earlier mines for (a re-run without one keeps it): launchd's plist, or systemd's unit.
existing_mine() {
  for f in "$HOME/Library/LaunchAgents/finance.tacit.prover.plist" "$HOME/.config/systemd/user/tacit-prover.service"; do
    [ -f "$f" ] && { grep -Eo '0x[0-9a-fA-F]{40}' "$f" | head -1; return 0; }
  done
  return 0
}

# Wei as TAC, four places.
tac_text() {
  w=$1
  case $w in ''|*[!0-9]*) printf '?'; return 0 ;; esac
  while [ "${#w}" -lt 19 ]; do w=0$w; done
  frac=${w#"${w%??????????????????}"}
  whole=${w%"$frac"}
  printf '%s.%s' "$whole" "$(printf '%s' "$frac" | cut -c1-4)"
}

# "1 wrap", "2 wraps".
plural() { if [ "$1" = 1 ]; then printf '%s %s' "$1" "$2"; else printf '%s %ss' "$1" "$2"; fi; }

# A number out of a flat JSON answer: json_num '{"queued":3}' queued gives 3.
json_num() { printf '%s' "$1" | sed -n "s/.*\"$2\":\([0-9][0-9]*\).*/\1/p" | head -1; }

# What a proof asks of this computer, said once; none of it stops the install.
check_machine() {
  if [ "$(uname -s 2>/dev/null)" = Darwin ]; then
    bytes=$(sysctl -n hw.memsize 2>/dev/null || echo 0); mem=$(( ${bytes:-0} / 1073741824 ))
  else
    kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0); mem=$(( ${kb:-0} / 1048576 ))
  fi
  if [ "$mem" -gt 0 ] && [ "$mem" -lt 7 ]; then
    warn "this computer has about $mem GB of memory; a proof wants 8 GB, and may fail or take very long here."
  fi
  free=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print int($4 / 1048576)}')
  if [ -n "${free:-}" ] && [ "$free" -lt 16 ]; then
    warn "the first proof downloads a 6.2 GB circuit and unpacks it to 8.4 GB; this disk has $free GB free."
  fi
}

do_install() {
  addr=$1
  [ -n "$addr" ] || addr=$(existing_mine)
  command -v curl >/dev/null 2>&1 || die "curl is needed."
  command -v tar >/dev/null 2>&1 || die "tar is needed."
  platform
  asset=tacit-prover-$PLAT.tar.gz
  check_machine

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/tacit-prover.XXXXXX") || die "could not make a temporary folder."
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 1' INT TERM HUP

  say "Downloading $asset ($TAG)"
  if [ -t 2 ]; then bar=-#; else bar=-sS; fi
  curl -fL "$bar" --retry 3 --connect-timeout 20 -o "$tmp/$asset" "$BASE/$asset" || die "could not download $BASE/$asset"

  # The pin in this script is what is checked, so a release changed on GitHub is refused. A build of your own is checked against the
  # sha256 given, or failing that the release's own .sha256 file (which is only as good as the place it is downloaded from).
  want=${TACIT_PROVER_SHA256:-}; from="the sha256 you gave"
  if [ -z "$want" ] && [ "$TAG" = "$PIN_TAG" ]; then want=$(pin_for "$PLAT"); from="the sha256 pinned in this script"; fi
  if [ -z "$want" ]; then
    want=$(curl -fsSL --retry 3 --connect-timeout 20 "$BASE/$asset.sha256" | awk '{print $1}') || die "could not read $BASE/$asset.sha256"
    from="the release's own checksum file ($TAG is not pinned in this script)"
  fi
  want=$(printf '%s' "$want" | tr 'A-F' 'a-f')
  got=$(sha256_of "$tmp/$asset")
  [ "$got" = "$want" ] || die "the download's sha256 is $got, not $want, so nothing was installed."
  say "Checked its sha256 ($(printf '%s' "$got" | cut -c1-12)...) against $from"

  mkdir "$tmp/x"
  tar xzf "$tmp/$asset" -C "$tmp/x" || die "could not unpack $asset"
  [ -f "$tmp/x/tacit-prover" ] || die "$asset has no tacit-prover in it."
  mkdir -p "$HOME_DIR/bin"
  cp "$tmp/x/tacit-prover" "$HOME_DIR/bin/.tacit-prover.new"
  chmod 755 "$HOME_DIR/bin/.tacit-prover.new"
  mv -f "$HOME_DIR/bin/.tacit-prover.new" "$BIN"
  say "Installed $BIN"
  # On the PATH too where there is a folder for it already; a program of the same name that is not ours stays.
  lb=$HOME/.local/bin
  if [ -d "$lb" ] && [ -w "$lb" ] && { [ ! -e "$lb/tacit-prover" ] || [ -L "$lb/tacit-prover" ]; }; then
    ln -sf "$BIN" "$lb/tacit-prover"
  fi

  if [ -n "${TACIT_PROVER_NO_SERVICE:-}" ]; then
    say "It is not set to start at login. To run it in a terminal:"
    say "  $BIN mine ${addr:-0xYourAddress}"
    return 0
  fi
  if ! out=$(TACIT_PROVER_DIR="$HOME_DIR" TACIT_MINE="$addr" "$BIN" install 2>&1); then
    printf '%s\n' "$out" >&2
    say "It could not be set to start at login. It is installed, and runs in a terminal (leave the window open) with:" >&2
    say "  $BIN mine ${addr:-0xYourAddress}" >&2
    [ "$(uname -s)" != Darwin ] || say "(On a Mac this needs the desktop session, not ssh: run the command in Terminal on the Mac.)" >&2
    exit 1
  fi
  say "$out"
  # launchd's install boots the old program out first; systemd leaves a unit that is already running alone, so an update is restarted here.
  if [ "$(uname -s)" = Linux ] && command -v systemctl >/dev/null 2>&1; then systemctl --user restart tacit-prover >/dev/null 2>&1 || true; fi

  say "Waiting for it to load its keys (up to a minute)..."
  up=
  n=0
  while [ "$n" -lt 30 ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then up=1; break; fi
    n=$((n + 1)); sleep 2
  done

  say ""
  if [ -n "$up" ]; then say "tacit-prover is running."; else say "tacit-prover has not answered yet; it may still be loading. Check in a minute with --status."; fi
  if [ -n "$addr" ]; then
    say "It checks the pool once a minute and proves one wrap at a time, for $(short_addr "$addr"). Each wrap the pool accepts earns points."
    say "The first proof downloads a 6.2 GB circuit; a proof then takes about 5 to 10 minutes on a Mac with 16 GB or more, longer on less."
  else
    say "No address was given, so it proves for this computer's own pages and earns nothing. Run this again with 0x... to mine for points."
  fi
  say "It starts at login and uses the processor while it proves, so a laptop does best plugged in."
  if [ "$(uname -s)" = Linux ] && command -v loginctl >/dev/null 2>&1 && ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q yes; then
    say "On Linux it stops when you log out. To keep it running: sudo loginctl enable-linger $(id -un)"
  fi
  say "Check on it:  curl -fsSL https://tacit.finance/prove.sh | sh -s -- --status"
  say "Remove it:    curl -fsSL https://tacit.finance/prove.sh | sh -s -- --uninstall"
  say "Its log:      $HOME_DIR/daemon.log"
}

do_status() {
  addr=$1
  [ -n "$addr" ] || addr=$(existing_mine)
  if [ -x "$BIN" ]; then say "Program    $BIN"; else say "Program    not installed (curl -fsSL https://tacit.finance/prove.sh | sh -s -- 0xYourAddress)"; fi

  if [ "$(uname -s)" = Darwin ]; then
    unit=$HOME/Library/LaunchAgents/finance.tacit.prover.plist
    state=$(launchctl print "gui/$(id -u)/finance.tacit.prover" 2>/dev/null | sed -n 's/^[[:space:]]*state = //p' | head -1 || true)
  else
    unit=$HOME/.config/systemd/user/tacit-prover.service
    state=$(systemctl --user is-active tacit-prover 2>/dev/null || true)
  fi
  if [ ! -f "$unit" ]; then
    say "Service    not set to start at login"
  else
    case $state in
      running|active) say "Service    running, and starts at login" ;;
      '') say "Service    set to start at login, but not loaded (log out and in again, or run the install again)" ;;
      *) say "Service    $state (set to start at login)" ;;
    esac
  fi
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then say "Answering  yes, on 127.0.0.1:$PORT"; else say "Answering  no (stopped, or still loading its keys)"; fi
  if [ -n "$addr" ]; then say "Mining for $addr"; else say "Mining for no address (it proves for this computer's pages only)"; fi

  log=$HOME_DIR/daemon.log
  if [ -f "$log" ]; then
    last=$(grep -E 'pool job|mining the proof pool' "$log" 2>/dev/null | tail -1 | sed 's/^tacit-prover: //' || true)
    [ -z "$last" ] || say "Last       $last"
    n=$(grep -c ' points to ' "$log" 2>/dev/null || true)
    say "Accepted   ${n:-0} in this log"
  fi

  pool=$(curl -fsS --max-time 10 "$API/prover/pool" 2>/dev/null || true)
  if [ -n "$pool" ]; then
    say "The pool   $(plural "$(json_num "$pool" queued)" wrap) waiting, $(json_num "$pool" doneToday) proved today by $(plural "$(json_num "$pool" minersToday)" prover)"
  else
    say "The pool   could not be read just now"
  fi
  if [ -n "$addr" ]; then
    # Today's proofs come from the pool's own tally of the UTC day, so a first proof shows now and not when the day is paid.
    lc=$(printf '%s' "$addr" | tr 'A-F' 'a-f')
    tally=$(curl -fsS --max-time 10 "$API/prover/pool/credits?day=$(( $(date +%s) / 86400 ))" 2>/dev/null || true)
    row=$(printf '%s' "$tally" | sed -n 's/.*{"miner":"'"$lc"'","proofs":\([0-9][0-9]*\),"points":\([0-9][0-9]*\)}.*/\1 \2/p' | head -1)
    if [ -z "$tally" ]; then say "Today      could not be read just now"
    elif [ -n "$row" ]; then say "Today      $(plural "${row% *}" proof), $(plural "${row#* }" point) to $(short_addr "$addr")"
    else say "Today      no proofs yet from $(short_addr "$addr")"
    fi
    mine=$(curl -fsS --max-time 10 "$POINTS/mine?address=$addr" 2>/dev/null || true)
    wei=$(printf '%s' "$mine" | sed -n 's/.*"account":{[^}]*"creditedWei":"\([0-9]*\)".*/\1/p' | head -1)
    if [ -n "$wei" ]; then say "Credited   $(tac_text "$wei") TAC to $(short_addr "$addr") (a day's points are paid after the day ends)"; else say "Credited   could not be read just now"; fi
  fi
}

do_uninstall() {
  if [ -x "$BIN" ]; then
    TACIT_PROVER_DIR="$HOME_DIR" "$BIN" uninstall || true
  elif [ "$(uname -s)" = Darwin ]; then
    launchctl bootout "gui/$(id -u)/finance.tacit.prover" >/dev/null 2>&1 || true
    rm -f "$HOME/Library/LaunchAgents/finance.tacit.prover.plist"
  else
    systemctl --user disable --now tacit-prover >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/tacit-prover.service"
  fi
  lb=$HOME/.local/bin/tacit-prover
  if [ -L "$lb" ] && [ "$(readlink "$lb")" = "$BIN" ]; then rm -f "$lb"; fi
  rm -f "$BIN"
  rmdir "$HOME_DIR/bin" 2>/dev/null || true
  say "tacit-prover is stopped and removed."
  say "Kept: the 6.2 GB circuit (rm -rf ~/.sp1/circuits) and $HOME_DIR with its log and finished proofs (rm -rf $HOME_DIR)."
}

main() {
  [ -n "${HOME:-}" ] || die "HOME is not set."
  TAG=${TACIT_PROVER_TAG:-$PIN_TAG}
  BASE=${TACIT_PROVER_BASE:-https://github.com/src-company/tacit/releases/download/$TAG}
  HOME_DIR=${TACIT_PROVER_HOME:-$HOME/.tacit-prover}
  API=${TACIT_POOL_API:-https://api.tacit.finance}
  POINTS=${TACIT_POINTS_API:-https://tacit-points.onrender.com}
  PORT=${TACIT_PROVER_PORT:-47815}
  BIN=$HOME_DIR/bin/tacit-prover

  cmd=install
  addr=
  for a in "$@"; do
    case $a in
      -h|--help) usage; exit 0 ;;
      --status) cmd=status ;;
      --uninstall) cmd=uninstall ;;
      -*) usage >&2; die "unknown option $a" ;;
      *) addr=$a ;;
    esac
  done
  if [ -n "$addr" ] && ! is_address "$addr"; then
    die "$addr is not an address: the TAC points go to an Ethereum address, 0x and 40 hex digits."
  fi
  case $cmd in
    install) do_install "$addr" ;;
    status) do_status "$addr" ;;
    uninstall) do_uninstall ;;
  esac
}

main "$@"
