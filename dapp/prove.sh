#!/bin/sh
# Prove wraps for Tacit's proof pool from this computer, for TAC points. This installs tacit-prover (the release pinned below, its
# sha256 checked before anything is run), sets it to start at login, and has it prove the pool's wraps while it has nothing of its
# own to prove.
#
#   curl -fsSL https://tacit.finance/prove.sh | sh -s -- 0xYourAddress     install it; the points go to that address
#   curl -fsSL https://tacit.finance/prove.sh | sh -s -- --status          is it running, what the pool has, what the address earned
#   curl -fsSL https://tacit.finance/prove.sh | sh -s -- --uninstall       stop it and take it away
#
# Apple-silicon Macs and x86-64 Linux (Ubuntu 22.04, Debian 12 or newer), and so Windows through WSL 2: run it in the Ubuntu window. Where
# systemd's user manager is not running (WSL with systemd off, a container) it runs in the background instead, until the computer stops.
# The whole script is one function called on the last line, so a download cut short runs nothing.
# Environment: TACIT_PROVER_NO_SERVICE=1 installs the program and stops there (run it by hand: tacit-prover mine 0x...); TACIT_PROVER_HOME
# is where it lives (~/.tacit-prover); TACIT_PROVER_TAG, TACIT_PROVER_BASE and TACIT_PROVER_SHA256 install a build of your own (with no
# sha256 given, the release's own .sha256 file is used). The pins are changed with tools/prove-pins.mjs when a release is cut.

set -eu

PIN_TAG=tacit-prover-v0.6.4
PIN_MACOS_ARM64=3ccbe19f5155afedc7b6dae748bcf7c184ae5d1eaf0bab991baf79ddd525965c
PIN_LINUX_X86_64=eb28461fe8469dc772342c38d52993e329c543c1c6864a9a6ddcf995dea1f867

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
      esac
      check_glibc
      # WSL 1 has no Linux kernel of its own (its version line says Microsoft with a capital M, WSL 2's says microsoft-standard-WSL2).
      if is_wsl && grep -q Microsoft "${TACIT_PROC_VERSION:-/proc/version}" 2>/dev/null; then
        warn "this looks like WSL 1, and tacit-prover is made for WSL 2. In PowerShell: wsl --set-version ${WSL_DISTRO_NAME:-Ubuntu} 2"
      fi ;;
    MINGW*|MSYS*|CYGWIN*) die "this does not run in Git Bash. On Windows, install WSL 2 (in PowerShell: wsl --install), open Ubuntu from the Start menu, and run the command there." ;;
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

# The address an install from before mines for (a re-run without one keeps it): what the page last set (mine.json, which wins over
# TACIT_MINE while it exists), else launchd's plist, systemd's unit or the run script.
existing_mine() {
  for f in "$HOME_DIR/mine.json" "$HOME/Library/LaunchAgents/finance.tacit.prover.plist" "$HOME/.config/systemd/user/tacit-prover.service" "$RUN_SH"; do
    [ -f "$f" ] && { grep -Eo '0x[0-9a-fA-F]{40}' "$f" | head -1; return 0; }
  done
  return 0
}

# Inside WSL uname says Linux: WSL sets WSL_DISTRO_NAME, and its kernel's version line names Microsoft.
is_wsl() { [ -n "${WSL_DISTRO_NAME:-}" ] || { [ ! -f /.dockerenv ] && [ ! -f /run/.containerenv ] && grep -qi microsoft "${TACIT_PROC_VERSION:-/proc/version}" 2>/dev/null; }; }

# The Linux build asks for glibc 2.34 or newer and would not start on an older one, so that is said before the download. A version that
# does not read as one (another libc) is left to the program.
check_glibc() {
  v=$(ldd --version 2>&1 | head -n 1 | awk '{print $NF}')
  maj=${v%%[!0-9]*}; rest=${v#*.}; min=${rest%%[!0-9]*}
  { [ -n "$maj" ] && [ -n "$min" ] && [ "$v" != "$rest" ]; } || return 0
  if [ "$maj" -lt 2 ] || { [ "$maj" -eq 2 ] && [ "$min" -lt 34 ]; }; then
    hint="Ubuntu 22.04, Debian 12 or newer."
    if is_wsl; then hint="$hint In PowerShell: wsl --install -d Ubuntu-24.04, then run the command in that window."; fi
    die "this Linux has glibc $v, and tacit-prover needs 2.34 or newer: $hint"
  fi
}

# systemd's user manager, which keeps the prover running and starts it at login. WSL runs it only when /etc/wsl.conf turns systemd on,
# and a container has none.
user_systemd() {
  command -v systemctl >/dev/null 2>&1 || return 1
  # su and sudo -u leave XDG_RUNTIME_DIR unset though the user's manager may run (linger); systemctl --user finds it there.
  if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ]; then XDG_RUNTIME_DIR=/run/user/$(id -u); export XDG_RUNTIME_DIR; fi
  systemctl --user show-environment >/dev/null 2>&1
}

# A value as one single-quoted shell word, for the run script.
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Without one the prover runs in the background from $RUN_SH, which writes its own pid before it becomes the program. The pid is only
# taken as the prover's while that process is running the installed program.
background_pid() {
  [ -f "$RUN_PID" ] || return 0
  bgp=$(cat "$RUN_PID" 2>/dev/null || true)
  case $bgp in ''|*[!0-9]*) return 0 ;; esac
  kill -0 "$bgp" 2>/dev/null || return 0
  if [ -r "/proc/$bgp/cmdline" ]; then args=$(tr '\0' ' ' < "/proc/$bgp/cmdline" 2>/dev/null || true); else args=$(ps -p "$bgp" -o args= 2>/dev/null || true); fi
  case $args in *"$BIN serve"*) printf '%s' "$bgp" ;; esac
  return 0
}

stop_background() {
  bgp=$(background_pid)
  if [ -n "$bgp" ]; then
    kill "$bgp" 2>/dev/null || true
    n=0
    while [ "$n" -lt 10 ] && kill -0 "$bgp" 2>/dev/null; do sleep 1; n=$((n + 1)); done
    # Still the prover after 10 s: killed outright, as systemd and launchd would, rather than forgotten while it holds the port.
    if [ "$(background_pid)" = "$bgp" ]; then kill -9 "$bgp" 2>/dev/null || true; sleep 1; fi
  fi
  rm -f "$RUN_PID"
}

start_background() {
  stop_background
  cat > "$RUN_SH" <<EOF
#!/bin/sh
echo \$\$ > $(shq "$RUN_PID")
cd $(shq "$HOME_DIR") || exit 1
export TACIT_PROVER_DIR=$(shq "$HOME_DIR") TACIT_MINE=$(shq "$1")
exec $(shq "$BIN") serve >> $(shq "$HOME_DIR/daemon.log") 2>&1
EOF
  chmod 755 "$RUN_SH"
  # Out of the terminal's session, so closing the terminal or pressing Ctrl-C there leaves it running.
  if command -v setsid >/dev/null 2>&1; then nohup setsid sh "$RUN_SH" >/dev/null 2>&1 < /dev/null &
  else nohup sh "$RUN_SH" >/dev/null 2>&1 < /dev/null &
  fi
  n=0
  while [ "$n" -lt 10 ] && [ -z "$(background_pid)" ]; do sleep 1; n=$((n + 1)); done
  [ -n "$(background_pid)" ] || die "tacit-prover did not start; its log is $HOME_DIR/daemon.log"
}

# What WSL does to a program that keeps running, said once after an install there.
wsl_notes() {
  say ""
  say "Keep an Ubuntu window open while it proves: WSL stops Ubuntu, and tacit-prover with it, soon after the last one closes."
  say "To prove with none open, put these lines in %UserProfile%\\.wslconfig and run wsl --shutdown in PowerShell:"
  say "  [general]"
  say "  instanceIdleTimeout=-1"
  say "If wsl --list --running no longer shows Ubuntu once its windows are closed, keep one open."
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
  # WSL's Linux gets half the PC's memory unless told otherwise, which is what /proc/meminfo shows (a little under what .wslconfig sets,
  # so the memory=12GB this suggests reads as 11).
  if is_wsl && [ "$mem" -gt 0 ] && [ "$mem" -lt 11 ]; then
    warn "WSL gives Linux about $mem GB here (half of this PC's memory, unless %UserProfile%\\.wslconfig says otherwise); a proof wants 8 GB, and is quicker with 16."
    warn "To give it more, put these two lines in %UserProfile%\\.wslconfig on Windows (memory= what you can spare, say 12GB on a 16 GB PC), run wsl --shutdown in PowerShell and open Ubuntu again:"
    warn "  [wsl2]"
    warn "  memory=12GB"
  elif [ "$mem" -gt 0 ] && [ "$mem" -lt 7 ]; then
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
    want=$(curl -fsSL --retry 3 --connect-timeout 20 "$BASE/$asset.sha256") || die "could not read $BASE/$asset.sha256"
    want=$(printf '%s' "$want" | awk '{print $1}')
    [ -n "$want" ] || die "$BASE/$asset.sha256 is empty, so nothing was installed."
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
  bg=
  # A unit installed earlier stays in charge while systemd runs: from a shell where systemctl --user does not answer for it (sudo, su,
  # cron), a second copy beside it would only load the keys twice and fight it for the port. With systemd off since (WSL), it is inert.
  if [ "$(uname -s)" = Linux ] && { [ ! -f "$HOME/.config/systemd/user/tacit-prover.service" ] || [ ! -d "$SYSTEMD_RUN" ]; } && ! user_systemd; then
    bg=1
    if is_wsl && [ -d "$SYSTEMD_RUN" ]; then
      say "systemd runs in this Ubuntu, but not for $(id -un) (systemctl --user does not answer), so tacit-prover runs in the background"
      say "until WSL stops. To have it start by itself, run wsl --shutdown in PowerShell, open Ubuntu again and run this command again."
    elif is_wsl; then
      say "systemd is off in this Ubuntu, so tacit-prover runs in the background until WSL stops. To have it start by itself, add these"
      say "two lines to /etc/wsl.conf (sudo nano /etc/wsl.conf), run wsl --shutdown in PowerShell, open Ubuntu again and run this command again:"
      say "  [boot]"
      say "  systemd=true"
    else
      say "systemd's user manager does not answer here (systemctl --user), so tacit-prover runs in the background until this computer stops."
    fi
    # What the page last set (mine.json) wins over TACIT_MINE, so an address given here is made to win, as the service's install does.
    [ -z "$1" ] || rm -f "$HOME_DIR/mine.json"
    start_background "$addr"
  else
    # A background run from an install before systemd was on would hold the port.
    stop_background
    # An update on a Mac: the old program is booted out and gone before the new one is loaded. launchctl bootout returns before the old
    # process has exited, and loading the label meanwhile fails ("Bootstrap failed: 5: Input/output error"), so this waits for it (up to
    # 30 s), and tries the load once more after a pause if it still fails.
    if [ "$(uname -s)" = Darwin ]; then
      dom="gui/$(id -u)"
      launchctl bootout "$dom/finance.tacit.prover" >/dev/null 2>&1 || true
      n=0
      while [ "$n" -lt 30 ] && launchctl print "$dom/finance.tacit.prover" >/dev/null 2>&1; do sleep 1; n=$((n + 1)); done
    fi
    if ! out=$(TACIT_PROVER_DIR="$HOME_DIR" TACIT_MINE="$addr" "$BIN" install 2>&1) && { sleep 5; ! out=$(TACIT_PROVER_DIR="$HOME_DIR" TACIT_MINE="$addr" "$BIN" install 2>&1); }; then
      printf '%s\n' "$out" >&2
      say "It could not be set to start at login. It is installed, and runs in a terminal (leave the window open) with:" >&2
      say "  $BIN mine ${addr:-0xYourAddress}" >&2
      [ "$(uname -s)" != Darwin ] || say "(On a Mac this needs the desktop session, not ssh: run the command in Terminal on the Mac.)" >&2
      exit 1
    fi
    say "$out"
    # launchd's install boots the old program out first; systemd leaves a unit that is already running alone, so an update is restarted here.
    if [ "$(uname -s)" = Linux ]; then systemctl --user restart tacit-prover >/dev/null 2>&1 || true; fi
  fi

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
    say "It proves one wrap at a time, the next as soon as one is done, for $(short_addr "$addr"). Each wrap the pool accepts earns points."
    say "The first proof downloads a 6.2 GB circuit; a proof then takes about 5 to 10 minutes on a Mac with 16 GB or more, longer on less."
  else
    say "No address was given, so it proves for this computer's own pages and earns nothing. Run this again with 0x... to mine for points."
  fi
  if [ -n "$bg" ]; then
    say "It uses the processor while it proves, so a laptop does best plugged in. It does not start by itself: after a restart, run this again."
  else
    say "It starts at login and uses the processor while it proves, so a laptop does best plugged in."
  fi
  if [ -z "$bg" ] && [ "$(uname -s)" = Linux ] && command -v loginctl >/dev/null 2>&1 && ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q yes; then
    say "On Linux it stops when you log out. To keep it running: sudo loginctl enable-linger $(id -un)"
  fi
  # The page runs in the Windows browser, which reaches 127.0.0.1 inside WSL through WSL's localhost forwarding; Windows' own curl checks it.
  if is_wsl && [ -n "$up" ] && command -v curl.exe >/dev/null 2>&1; then
    if curl.exe -fsS --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      say "Windows reaches it at 127.0.0.1:$PORT, so the page in your Windows browser finds it."
    else
      warn "Windows could not reach it at 127.0.0.1:$PORT, so the page in your Windows browser will not find it (it proves all the same). Check that %UserProfile%\\.wslconfig does not set localhostForwarding=false."
    fi
  fi
  if is_wsl; then wsl_notes; fi
  say "Watch, pause or start it: https://tacit.finance/prove/"
  say "Check on it:  curl -fsSL https://tacit.finance/prove.sh | sh -s -- --status"
  say "Remove it:    curl -fsSL https://tacit.finance/prove.sh | sh -s -- --uninstall"
  # systemd's unit logs to the journal, not to a file.
  if [ -z "$bg" ] && [ "$(uname -s)" = Linux ]; then say "Its log:      journalctl --user -u tacit-prover -f"; else say "Its log:      $HOME_DIR/daemon.log"; fi
}

# The prover's log as daemon.log has it, or with no such file the unit's journal (systemd's unit logs there), its messages alone.
prover_log() {
  if [ -f "$HOME_DIR/daemon.log" ]; then cat "$HOME_DIR/daemon.log"
  else journalctl --user -u tacit-prover --no-pager -o cat 2>/dev/null || true
  fi
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
  bgp=$(background_pid)
  if [ -n "$bgp" ]; then
    say "Service    running in the background (pid $bgp); after a restart, run the install again"
  elif [ ! -f "$unit" ] && [ -f "$RUN_SH" ]; then
    say "Service    stopped (it ran in the background; run the install again, and if it stops by itself see its log)"
  elif [ ! -f "$unit" ]; then
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

  if [ -f "$HOME_DIR/daemon.log" ] || { [ "$(uname -s)" != Darwin ] && [ -f "$unit" ] && command -v journalctl >/dev/null 2>&1; }; then
    last=$(prover_log | grep -E 'pool job|mining the proof pool' | tail -1 | sed 's/^tacit-prover: //' || true)
    [ -z "$last" ] || say "Last       $last"
    n=$(prover_log | grep -c ' points to ' || true)
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
  stop_background
  rm -f "$RUN_SH"
  if [ -x "$BIN" ] && { [ "$(uname -s)" = Darwin ] || user_systemd; }; then
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
  case $HOME_DIR in /*) ;; *) HOME_DIR=$PWD/$HOME_DIR ;; esac
  API=${TACIT_POOL_API:-https://api.tacit.finance}
  POINTS=${TACIT_POINTS_API:-https://tacit-points.onrender.com}
  PORT=${TACIT_PROVER_PORT:-47815}
  BIN=$HOME_DIR/bin/tacit-prover
  RUN_SH=$HOME_DIR/run.sh
  RUN_PID=$HOME_DIR/run.pid
  # systemd is the init here (sd_booted); TACIT_SYSTEMD_RUN stands in for it in the tests, as TACIT_PROC_VERSION does for /proc/version
  SYSTEMD_RUN=${TACIT_SYSTEMD_RUN:-/run/systemd/system}

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
