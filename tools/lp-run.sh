#!/bin/sh
# Runs one of the reverse-side tools of the house fast bridge provider with the provider's key. The key is read from the macOS keychain item `tacit-fastbridge-lp`
# in here, handed to the tool in its environment only, and never printed or passed on a command line. Only the five tools named below can be run through it.
#
#   tools/lp-run.sh status [--address-only] [--copy]                       the reverse address, its tacit1 address, what is at it (reads only)
#   tools/lp-run.sh normalize --txid <id> [--send --confirm <token>]       moves TAC sent silently (to the reverse tcs1 address) onto the plain address:
#                                                                          without --send it only says what it would do
#   tools/lp-run.sh fund --tac 3 --note <txid:vout> --coin <txid:vout> [--mode silent|plain] [--send --confirm <token>]
#                                                                          sends a little TAC from named notes of the main address to the reverse key: without --send it only says what it would do
#   tools/lp-run.sh bump --txid <stuck transfer> [--rate 2] [--send --confirm <token>]
#                                                                          speeds up a stuck transfer of the reverse key by spending only its sats-change output and one plain coin (never the TAC): without --send it only says what it would do
#   tools/lp-run.sh pool-send --tac 1.6 --to <identity public key> [--send --confirm <token>]
#                                                                          sends a little private TAC (at most 5) from the provider's pool account to a test identity: without --send it only says what it would do
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
case "${1:-}" in
  status) tool=fastbridge-lp-reverse-status.mjs ;;
  normalize) tool=fastbridge-lp-reverse-normalize.mjs ;;
  fund) tool=fastbridge-lp-reverse-fund.mjs ;;
  bump) tool=fastbridge-lp-reverse-bump.mjs ;;
  pool-send) tool=fastbridge-lp-pool-send.mjs ;;
  *) echo "usage: lp-run.sh status|normalize|fund|bump|pool-send [arguments of that tool]" >&2; exit 2 ;;
esac
shift
# the tools need Node 22: the newest 22 under nvm if there is one, else the node on the PATH
NODE=node
for d in "$HOME"/.nvm/versions/node/v22*/bin; do [ -x "$d/node" ] && NODE="$d/node"; done
if [ -z "${FB_LP_KEY:-}" ]; then
  FB_LP_KEY=$(security find-generic-password -s tacit-fastbridge-lp -w) || { echo "the keychain has no item tacit-fastbridge-lp (or it was not unlocked)" >&2; exit 1; }
  export FB_LP_KEY
fi
exec "$NODE" "$HERE/$tool" "$@"
