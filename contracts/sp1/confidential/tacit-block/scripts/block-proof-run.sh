#!/bin/sh
# usage: block-proof-run.sh PORT HOST : builds tacit-block-gpu on a rented CUDA box, proves the mainnet fixture's nine blocks to Groth16
# (the proofs land in /root/tb/*.groth16; copy them back with block-proof-fetch.sh)
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"; TB="$HERE/.."
P=$1; H=$2
ssh_() { ssh -i ~/.ssh/vast_prover -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -o BatchMode=yes -o LogLevel=ERROR -o ServerAliveInterval=30 -p "$P" root@"$H" "$@"; }
F=tacit-blocks-mainnet.json
tar czf - -C "$TB" gpu/Cargo.toml gpu/Cargo.lock gpu/src elf/tacit-block -C "$TB/../../../test/fixtures" $F.b0.stdin $F.b1.stdin $F.b2.stdin $F.b3.stdin $F.b4.stdin $F.b5.stdin $F.b6.stdin $F.b7.stdin $F.b8.stdin | ssh_ 'mkdir -p /root/tb && tar xzf - -C /root/tb'
ssh_ 'cat > /root/fetch-circuits.sh' < "$HERE/fetch-circuits.sh"
ssh_ 'cat > /root/run.sh <<"EOS"
set -e
cd /root
(sh /root/fetch-circuits.sh > /root/fetch.log 2>&1 &)
apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq protobuf-compiler pkg-config libssl-dev build-essential clang curl git >/dev/null 2>&1
[ -x /root/.cargo/bin/cargo ] || curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null 2>&1
. /root/.cargo/env
cd /root/tb/gpu && cargo build --release > /root/build.log 2>&1
echo BUILD_DONE >> /root/build.log
while [ ! -d /root/.sp1/circuits/groth16/v6.1.0 ]; do grep -q -E "did not|short|free where" /root/fetch.log && break; sleep 10; done
cd /root/tb && ./gpu/target/release/tacit-block-gpu elf/tacit-block tacit-blocks-mainnet.json.b0.stdin tacit-blocks-mainnet.json.b1.stdin tacit-blocks-mainnet.json.b2.stdin tacit-blocks-mainnet.json.b3.stdin tacit-blocks-mainnet.json.b4.stdin tacit-blocks-mainnet.json.b5.stdin tacit-blocks-mainnet.json.b6.stdin tacit-blocks-mainnet.json.b7.stdin tacit-blocks-mainnet.json.b8.stdin --groth16 > /root/prove.log 2>&1 || echo "PROVE_FAILED rc=$?" >> /root/prove.log
echo PROVE_DONE >> /root/prove.log
EOS
(setsid sh /root/run.sh > /root/run.log 2>&1 < /dev/null &); echo started'
