#!/usr/bin/env python3
# Deploy the tacit IPFS node: dialable Kubo node that self-heals its FULL pin
# set on boot from the ipfs-gateway-pins branch. Survives pod termination.
import json, ssl, urllib.request
import os
API = os.environ["RUNPOD_API_KEY"]  # export RUNPOD_API_KEY before running
RAW = "https://raw.githubusercontent.com/z0r0z/tacit/ipfs-gateway-pins/ipfs-gateway/pins"

# Single files re-added as CIDv1 (their published bafk…/bafy… CIDs).
CIDV1 = " ".join(f"{RAW}/{n}" for n in [
    "index-1.html", "src-co.html", "src-8244.html",
    "token-list-wei.html", "zSwap.html", "zswap-docs.html", "zswap-shot.png",
])
# CIDv0 index (QmWZ3X).
CIDV0 = "https://raw.githubusercontent.com/z0r0z/tacit/main/ipfs-gateway/index.html"
# Pre-built content whose exact DAG is preserved via CAR (dag import).
CARS = " ".join(f"{RAW}/{n}" for n in ["audit.car", "multisig-dist.car"])

script = r'''
set -e
apt-get update -qq && apt-get install -y -qq openssh-server wget ca-certificates >/dev/null 2>&1
mkdir -p /root/.ssh
printf '%s\n' "$PUBLIC_KEY" > /root/.ssh/authorized_keys
sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
service ssh start
cd /root
wget -qO kubo.tar.gz https://dist.ipfs.tech/kubo/v0.41.0/kubo_v0.41.0_linux-amd64.tar.gz
tar xzf kubo.tar.gz
mv kubo/ipfs /usr/local/bin/ipfs
ipfs init --profile server || true
ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080
ipfs config --json Addresses.Swarm '["/ip4/0.0.0.0/tcp/4001","/ip4/0.0.0.0/udp/4001/quic-v1"]'
ipfs config --json Addresses.AppendAnnounce "[\"/ip4/$RUNPOD_PUBLIC_IP/tcp/$RUNPOD_TCP_PORT_4001\"]"
mkdir -p /root/pins /root/cars
i=0; for u in __CIDV1__; do wget -qO "/root/pins/v1_$i" "$u"; i=$((i+1)); done
wget -qO /root/pins/v0_index.html "__CIDV0__"
j=0; for u in __CARS__; do wget -qO "/root/cars/c_$j.car" "$u" || true; j=$((j+1)); done
for f in /root/pins/v1_*; do ipfs add -Q --cid-version=1 "$f" >/dev/null 2>&1 || true; done
ipfs add -Q /root/pins/v0_index.html >/dev/null 2>&1 || true
for c in /root/cars/*.car; do [ -s "$c" ] && ipfs dag import "$c" >/dev/null 2>&1 || true; done
( sleep 25
  for f in /root/pins/v1_*; do ipfs routing provide $(ipfs add -Q --only-hash --cid-version=1 "$f") >/dev/null 2>&1 || true; done
  ipfs routing provide $(ipfs add -Q --only-hash /root/pins/v0_index.html) >/dev/null 2>&1 || true
) &
exec ipfs daemon --migrate=true
'''
script = (script.replace("__CIDV1__", CIDV1)
                .replace("__CIDV0__", CIDV0)
                .replace("__CARS__", CARS))
body = {"name":"tacit-ipfs-node","imageName":"ubuntu:22.04","computeType":"CPU","vcpuCount":2,
        "containerDiskInGb":10,"ports":["22/tcp","4001/tcp","8080/http"],"dockerStartCmd":["bash","-c",script]}
req = urllib.request.Request("https://rest.runpod.io/v1/pods", data=json.dumps(body).encode(), method="POST",
    headers={"Authorization": f"Bearer {API}", "Content-Type":"application/json"})
try:
    d = json.load(urllib.request.urlopen(req, timeout=60, context=ssl.create_default_context()))
    print("OK pod id:", d.get("id"), "| cost/hr:", d.get("costPerHr"), "| status:", d.get("desiredStatus"))
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:400])
