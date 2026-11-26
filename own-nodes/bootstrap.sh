#!/usr/bin/env bash
# A fresh Debian 12/13 or Ubuntu 24.04 box (Hetzner) -> both nodes syncing behind the gateway, with TLS. As root, in tmux (the snapshot takes hours):
#
#   curl -fsSL https://raw.githubusercontent.com/z0r0z/tacit/main/own-nodes/bootstrap.sh | NODE_HOST=node.tacit.finance bash
#
# or from a clone: `NODE_HOST=node.tacit.finance bash own-nodes/bootstrap.sh`. Roles: `bash bootstrap.sh eth` or `btc` for one chain only.
# RETH_FROM_SCRATCH=1 skips reth's snapshot and executes the chain from genesis (days, and more disk at the peak).
#
# Safe to run again: it never replaces .env, the jwt secret or chain data. It does not touch DNS (README: one A record).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
REPO=https://github.com/z0r0z/tacit.git

# Piped from curl: get the repo, then run the copy in it.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ ! -f "$HERE/docker-compose.yml" ]; then
  apt-get update -y && apt-get install -y --no-install-recommends git ca-certificates
  if [ -d /opt/tacit/.git ]; then git -C /opt/tacit pull --ff-only; else git clone --depth 1 "$REPO" /opt/tacit; fi
  exec bash /opt/tacit/own-nodes/bootstrap.sh "$@"
fi
cd "$HERE"

ROLES=("$@"); [ ${#ROLES[@]} -gt 0 ] || ROLES=(eth btc)
for r in "${ROLES[@]}"; do case "$r" in eth|btc) ;; *) echo "unknown role: $r (eth or btc)" >&2; exit 1;; esac; done
has() { for r in "${ROLES[@]}"; do [ "$r" = "$1" ] && return 0; done; return 1; }
. /etc/os-release
case "$ID" in debian|ubuntu) ;; *) echo "Debian or Ubuntu only (this is $ID)" >&2; exit 1;; esac

# ── packages: Docker from Docker's own apt repository (signed), the firewall, automatic security updates ───────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl gnupg openssl ufw unattended-upgrades apt-listchanges tmux
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
# security updates every day, no automatic reboot (a reboot is a restart of both nodes: do it by hand)
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
APT
# the host's own journal stays small (the containers' logs are capped in docker-compose.yml)
mkdir -p /etc/systemd/journald.conf.d && printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/size.conf && systemctl restart systemd-journald

# ── SSH: keys only (only when a key is installed, so this can never lock the owner out) ──────────────────────────────────────────────
if [ -s /root/.ssh/authorized_keys ]; then
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/10-keys-only.conf
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
else
  echo "WARNING: no /root/.ssh/authorized_keys: password login left as it is. Add a key and run this again." >&2
fi

# ── .env (secrets generated here, never printed) ───────────────────────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp env.example .env
  PASS="$(openssl rand -hex 24)"; SALT="$(openssl rand -hex 16)"
  HMAC="$(printf %s "$PASS" | openssl dgst -sha256 -hmac "$SALT" | awk '{print $NF}')"
  sed -i "s|^BTC_RPC_PASS=.*|BTC_RPC_PASS=${PASS}|" .env
  sed -i "s|^BTC_RPCAUTH=.*|BTC_RPCAUTH='tacit:${SALT}\$${HMAC}'|" .env        # single-quoted: compose must not expand the $
  sed -i "s|^INTERNAL_KEYS=.*|INTERNAL_KEYS=$(openssl rand -hex 16),$(openssl rand -hex 16)|" .env
  [ -n "${NODE_HOST:-}" ] && sed -i "s|^NODE_HOST=.*|NODE_HOST=${NODE_HOST}|" .env
  has eth || sed -i "s|^ETH_UPSTREAM=.*|ETH_UPSTREAM=|" .env
  has btc || sed -i -e "s|^BTC_RPC_URL=.*|BTC_RPC_URL=|" -e "s|^ELECTRUM_URL=.*|ELECTRUM_URL=|" .env
  chmod 600 .env
  echo "wrote .env (0600). The service keys are the INTERNAL_KEYS line: grep INTERNAL_KEYS $(pwd)/.env"
fi
set -a; . ./.env; set +a
CHAIN_DIR="${CHAIN_DIR:-/srv/chain}"

# ── chain directories, the engine-API secret, and a disk check ─────────────────────────────────────────────────────────────────────
mkdir -p "$CHAIN_DIR"/{reth,lighthouse,bitcoin,electrs,caddy,jwt}
chown 1000:1000 "$CHAIN_DIR/bitcoin"; chown 1001:1001 "$CHAIN_DIR/electrs"     # bitcoind runs as uid 1000, electrs as 1001
[ -f "$CHAIN_DIR/jwt/jwt.hex" ] || { openssl rand -hex 32 > "$CHAIN_DIR/jwt/jwt.hex"; chmod 644 "$CHAIN_DIR/jwt/jwt.hex"; }
FREE_GB=$(df -BG --output=avail "$CHAIN_DIR" | tail -1 | tr -dc 0-9)
NEED=0; has eth && NEED=$((NEED + 800)); has btc && NEED=$((NEED + 1100))
[ "$FREE_GB" -ge "$NEED" ] || echo "WARNING: ${FREE_GB} GB free under $CHAIN_DIR; README sizing wants about ${NEED} GB for ${ROLES[*]} with a year of growth" >&2

# ── firewall: ssh, web, and the peer-to-peer ports (the RPC ports are never published) ──────────────────────────────────────────────
ufw allow OpenSSH
ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp
has eth && { ufw allow 30303; ufw allow 9000; ufw allow 9001/udp; }
has btc && ufw allow 8333/tcp
ufw --force enable

# ── go: Bitcoin first (its first sync is the long one), the gateway and TLS, then reth from its snapshot, then Ethereum ─────────────
docker compose build
has btc && docker compose --profile btc up -d bitcoind electrs
docker compose up -d gateway caddy
if has eth; then
  if [ ! -e "$CHAIN_DIR/reth/db" ] && [ "${RETH_FROM_SCRATCH:-0}" != 1 ]; then
    echo "downloading reth's snapshot (~212 GB): an hour or a few. Interrupted? Run this script again; the download resumes."
    docker compose --profile eth-snapshot run --rm reth-snapshot
  fi
  docker compose --profile eth up -d reth lighthouse
fi
echo
echo "Running. Watch: docker compose logs -f --tail 50 reth lighthouse bitcoind electrs;  curl -s https://${NODE_HOST}/health"
echo "Bitcoin: bitcoind's first sync ~12-24 h, then electrs ~2-4 h. Ethereum: a few hours after the snapshot. Then README 'Acceptance'."
