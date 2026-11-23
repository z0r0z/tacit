#!/bin/bash
# Node 20 (checksum-verified), the gateway (copied to /opt/gateway/gateway.mjs beforehand), its env with a fresh internal key, and the supervisor programs.
set -euo pipefail
mkdir -p /opt/gateway /opt/node /root/.tacit /var/log/tacit
# Node 20 from nodejs.org, checked against the published SHASUMS256
if [ ! -x /opt/node/bin/node ]; then
  NV=v20.18.1; F=node-$NV-linux-x64.tar.xz; cd /tmp
  curl -fsSLO https://nodejs.org/dist/$NV/$F; curl -fsSL https://nodejs.org/dist/$NV/SHASUMS256.txt -o SHASUMS256.txt
  grep " $F\$" SHASUMS256.txt | sha256sum -c -
  tar xJf $F -C /opt/node --strip-components=1
fi
/opt/node/bin/node -v
# gateway env: the internal key is made here once and kept (0600)
if [ ! -f /root/.tacit/gateway.env ]; then
  KEY=$(openssl rand -hex 16)
  cat > /root/.tacit/gateway.env <<ENV
PORT=8080
ETH_UPSTREAM=http://127.0.0.1:8545
BTC_ESPLORA_UPSTREAM=
ALLOW_ORIGINS=https://tacit.finance,https://www.tacit.finance
LOGS_MAX_SPAN=512
BUDGET_PER_MIN=600
INTERNAL_KEYS=$KEY
INTERNAL_SENDS=0
ALLOW_BROADCAST=0
TRUST_PROXY=0
ENV
  chmod 600 /root/.tacit/gateway.env
fi
# the pruned bitcoind's RPC (02-bitcoind.sh made the credentials) behind the gateway's esplora-shaped paths
if ! grep -q '^BTC_RPC_URL=' /root/.tacit/gateway.env && [ -f /root/.tacit/btc-rpc ]; then
  printf 'BTC_RPC_URL=http://127.0.0.1:8332\nBTC_RPC_AUTH=tacit:%s\n' "$(grep '^pass=' /root/.tacit/btc-rpc | cut -d= -f2-)" >> /root/.tacit/gateway.env
fi
cat > /opt/gateway/run.sh <<'RUN'
#!/bin/bash
set -a; . /root/.tacit/gateway.env; set +a
exec /opt/node/bin/node --max-old-space-size=256 /opt/gateway/gateway.mjs
RUN
chmod +x /opt/gateway/run.sh
# supervisor: the three programs, restarted if they die
cat > /etc/supervisor/conf.d/tacit.conf <<'SUP'
[program:lc]
command=/opt/nlc/root/nethermind-light-client/Nethermind.LightClient --urls http://127.0.0.1:8545 --data-dir /data/nlc --beacon-port 9050 --beacon-quic-port 9051 --execution-port 30303 --checkpoint-url https://mainnet.checkpoint.sigp.io
directory=/opt/nlc/root/nethermind-light-client
environment=DOTNET_ROOT="/opt/nlc/root/usr/share/dotnet",DOTNET_SYSTEM_GLOBALIZATION_INVARIANT="1",DOTNET_EnableDiagnostics="0"
autostart=true
autorestart=true
startsecs=10
stopwaitsecs=60
stdout_logfile=/var/log/tacit/lc.log
stdout_logfile_maxbytes=20MB
stdout_logfile_backups=2
redirect_stderr=true

[program:bitcoind]
command=/opt/btc/current/bin/bitcoind -datadir=/data/bitcoin -printtoconsole=0
autostart=true
autorestart=true
startsecs=20
stopwaitsecs=300
stdout_logfile=/var/log/tacit/bitcoind.out
redirect_stderr=true

[program:gateway]
command=/opt/gateway/run.sh
autostart=true
autorestart=true
startsecs=3
stdout_logfile=/var/log/tacit/gateway.log
stdout_logfile_maxbytes=1MB
stdout_logfile_backups=1
redirect_stderr=true
SUP
