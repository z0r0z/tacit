#!/bin/bash
# The light profile on a host with no Docker: Nethermind light client + pruned bitcoind + the gateway, under supervisor. Run as root from this directory.
# These steps were run one at a time on a container host; this runs them in order (not yet run end to end as one command).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p /opt/gateway && cp ../gateway.mjs /opt/gateway/gateway.mjs
bash 01-lightclient.sh
bash 02-bitcoind.sh
bash 03-gateway.sh
bash 04-start.sh
