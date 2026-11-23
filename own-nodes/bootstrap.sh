#!/usr/bin/env bash
# Brings a fresh Ubuntu 24.04 machine to "nodes syncing behind the gateway". Run as root from this directory:
#
#   bash bootstrap.sh            # Ethereum and Bitcoin on this machine
#   bash bootstrap.sh eth        # only Ethereum   (also empty BTC_ESPLORA_UPSTREAM in .env)
#   bash bootstrap.sh btc        # only Bitcoin    (also empty ETH_UPSTREAM in .env)
#
# Safe to run again: it never replaces an existing .env, jwt secret or chain data. It does not touch DNS (README: one A record).
set -euo pipefail
cd "$(dirname "$0")"
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

ROLES=("$@"); [ ${#ROLES[@]} -gt 0 ] || ROLES=(eth btc)
for r in "${ROLES[@]}"; do case "$r" in eth|btc) ;; *) echo "unknown role: $r (eth or btc)" >&2; exit 1;; esac; done
has() { for r in "${ROLES[@]}"; do [ "$r" = "$1" ] && return 0; done; return 1; }

# ── packages: Docker, its compose plugin, the firewall, openssl ───────────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends docker.io docker-compose-v2 ufw openssl ca-certificates curl
systemctl enable --now docker

# ── env (secrets generated here, never printed) ───────────────────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp env.example .env
  PASS="$(openssl rand -hex 24)"; SALT="$(openssl rand -hex 16)"
  HMAC="$(printf %s "$PASS" | openssl dgst -sha256 -hmac "$SALT" | awk '{print $NF}')"
  K1="$(openssl rand -hex 16)"; K2="$(openssl rand -hex 16)"
  sed -i "s|^BTC_RPC_PASS=.*|BTC_RPC_PASS=${PASS}|" .env
  sed -i "s|^BTC_RPCAUTH=.*|BTC_RPCAUTH='tacit:${SALT}\$${HMAC}'|" .env        # single-quoted: compose must not expand the $
  sed -i "s|^INTERNAL_KEYS=.*|INTERNAL_KEYS=${K1},${K2}|" .env
  has eth || sed -i "s|^ETH_UPSTREAM=.*|ETH_UPSTREAM=|" .env
  has btc || sed -i "s|^BTC_ESPLORA_UPSTREAM=.*|BTC_ESPLORA_UPSTREAM=|" .env
  chmod 600 .env
  echo "wrote .env (0600): edit NODE_HOST if it is not node.tacit.finance"
fi
set -a; . ./.env; set +a
CHAIN_DIR="${CHAIN_DIR:-/srv/chain}"

# ── chain directories, the engine-API secret, and a disk check ───────────────────────────────────────────────────────────────
mkdir -p "$CHAIN_DIR"/{reth,lighthouse,bitcoin,electrs,caddy,jwt}
chown 1000:1000 "$CHAIN_DIR/bitcoin"                      # bitcoind runs as uid 1000; electrs (root) reads its files
[ -f "$CHAIN_DIR/jwt/jwt.hex" ] || { openssl rand -hex 32 > "$CHAIN_DIR/jwt/jwt.hex"; chmod 644 "$CHAIN_DIR/jwt/jwt.hex"; }
FREE_GB=$(df -BG --output=avail "$CHAIN_DIR" | tail -1 | tr -dc 0-9)
NEED=0; has eth && NEED=$((NEED + 1500)); has btc && NEED=$((NEED + 2200))
[ "$FREE_GB" -ge "$NEED" ] || echo "WARNING: ${FREE_GB} GB free under $CHAIN_DIR, README sizing says about ${NEED} GB for ${ROLES[*]} with room to grow" >&2

# ── firewall: ssh, web, and the peer-to-peer ports of what runs here (the RPC ports are never published) ──────────────────────
ufw allow OpenSSH
ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp
has eth && { ufw allow 30303; ufw allow 9000; ufw allow 9001/udp; }
has btc && ufw allow 8333/tcp
ufw --force enable

# ── go ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
PROFILES=(); for r in "${ROLES[@]}"; do PROFILES+=(--profile "$r"); done
docker compose "${PROFILES[@]}" up -d --build
echo
echo "Syncing. Ethereum is usable within hours (checkpoint sync, then reth catches up); Bitcoin takes days (bitcoind, then electrs)."
echo "Next: README 'Bring-up', point the A record for ${NODE_HOST:-NODE_HOST} here, then run tools/node-check.mjs against it."
