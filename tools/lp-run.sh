#!/bin/sh
# Runs one of the reverse-side tools of the house fast bridge provider with the provider's key. The key is read from the macOS keychain item `tacit-fastbridge-lp`
# in here, handed to the tool in its environment only, and never printed or passed on a command line. Only the two tools named below can be run through it.
#
#   tools/lp-run.sh status [--address-only] [--copy]                       the reverse address, its tacit1 address, what is at it (reads only)
#   tools/lp-run.sh normalize --txid <id> [--send --confirm <token>]       moves TAC sent silently (to the reverse tcs1 address) onto the plain address:
#                                                                          without --send it only says what it would do
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
case "${1:-}" in
  status) tool=fastbridge-lp-reverse-status.mjs ;;
  normalize) tool=fastbridge-lp-reverse-normalize.mjs ;;
  *) echo "usage: lp-run.sh status|normalize [arguments of that tool]" >&2; exit 2 ;;
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
