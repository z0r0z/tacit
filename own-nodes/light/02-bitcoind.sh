#!/bin/bash
# Bitcoin Core 30.5, pruned (30 GB of blocks), verified like bitcoind/Dockerfile: sha256 AND >=5 builder signatures. Credentials made here (0600), never printed.
set -euo pipefail
V=30.5; SHA=593de13690ea3ef15e7ac3a695cc60ca9c2d576a184aeec69c69f458c7707568; SIGS=93aacee89333de43a96e7d128baa84e737c41b0b
mkdir -p /opt/btc /data/bitcoin /root/.tacit && cd /opt/btc
T=bitcoin-$V-x86_64-linux-gnu.tar.gz; B=https://bitcoincore.org/bin/bitcoin-core-$V
[ -f $T ] || curl -fsSLO $B/$T
curl -fsSLO $B/SHA256SUMS; curl -fsSLO $B/SHA256SUMS.asc
echo "$SHA  $T" | sha256sum -c -
grep " $T\$" SHA256SUMS | sha256sum -c -
[ -d guix.sigs-$SIGS ] || curl -fsSL https://codeload.github.com/bitcoin-core/guix.sigs/tar.gz/$SIGS | tar xz
export GNUPGHOME=$(mktemp -d)
gpg --batch --import guix.sigs-*/builder-keys/*.gpg 2>/dev/null
GOOD=$(gpg --batch --status-fd 1 --verify SHA256SUMS.asc SHA256SUMS 2>/dev/null | awk '$2=="VALIDSIG"{print $3}' | sort -u | wc -l)
echo "good builder signatures: $GOOD"; [ "$GOOD" -ge 5 ]
tar xzf $T; ln -sfn /opt/btc/bitcoin-$V /opt/btc/current
/opt/btc/current/bin/bitcoind --version | head -1
# credentials: made here, kept here (0600), never printed
if [ ! -f /root/.tacit/btc-rpc ]; then
  PASS=$(openssl rand -hex 24); SALT=$(openssl rand -hex 16)
  HMAC=$(printf %s "$PASS" | openssl dgst -sha256 -hmac "$SALT" | awk '{print $NF}')
  printf 'user=tacit\npass=%s\nrpcauth=tacit:%s$%s\n' "$PASS" "$SALT" "$HMAC" > /root/.tacit/btc-rpc; chmod 600 /root/.tacit/btc-rpc
fi
RPCAUTH=$(grep ^rpcauth= /root/.tacit/btc-rpc | cut -d= -f2-)
cat > /data/bitcoin/bitcoin.conf <<CONF
server=1
disablewallet=1
txindex=0
prune=30000
dbcache=12000
listen=0
maxconnections=24
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcauth=$RPCAUTH
CONF
chmod 600 /data/bitcoin/bitcoin.conf
echo "bitcoind installed; supervisor starts it (03, 04)"
