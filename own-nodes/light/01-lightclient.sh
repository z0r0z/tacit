#!/bin/bash
# Nethermind light client 1.0.1 (linux/amd64) from the published image, fetched by DIGEST with every layer hash-checked, unpacked, not run in Docker.
# For hosts that are themselves containers (a rented container, for example) and cannot run Docker. Run as root.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates jq tar gzip supervisor xz-utils gnupg libssl3 > /dev/null
R=nethermindeth/nethermind
MAN=sha256:be2e1a626e6bb236b1511895598d435d5c2aad15440cb68998ae161efa7a6807     # linux/amd64 of light-client-1.0.1
TOKEN=$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$R:pull" | jq -r .token)
A='Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
mkdir -p /opt/nlc/blobs /opt/nlc/root && cd /opt/nlc
curl -fsS -H "Authorization: Bearer $TOKEN" -H "$A" "https://registry-1.docker.io/v2/$R/manifests/$MAN" -o manifest.json
echo "$MAN" | sed 's/sha256://' | awk '{print $1"  manifest.json"}' | sha256sum -c -
for d in $(jq -r '.layers[].digest' manifest.json); do
  h=${d#sha256:}
  curl -fsSL -H "Authorization: Bearer $TOKEN" "https://registry-1.docker.io/v2/$R/blobs/$d" -o blobs/$h
  echo "$h  blobs/$h" | sha256sum -c - > /dev/null && echo "layer ok $h" 
  tar -xzf blobs/$h -C root 2>/dev/null || tar -xf blobs/$h -C root
done
echo "light client unpacked: /opt/nlc/root/nethermind-light-client"
