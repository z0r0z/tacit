#!/bin/bash
# Live-node round-trip: deploy the confidential factory to a local anvil, etch a
# token, then mint with a proof built by the prover module (dapp/evm-confidential.js)
# and submitted over real RPC. Proves the module -> tx -> contract path on a real
# EVM node — the testnet flow minus the public network.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC=http://127.0.0.1:8545
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil account 0
CHAINID=31337

anvil --silent --chain-id $CHAINID &
ANVIL=$!
trap "kill $ANVIL 2>/dev/null || true" EXIT
for i in $(seq 1 30); do cast block-number --rpc-url $RPC >/dev/null 2>&1 && break || sleep 0.3; done

echo "== deploy =="
OUT=$(cd contracts && forge script script/DeployConfidential.s.sol --rpc-url $RPC --private-key $PK --broadcast 2>&1)
TOKEN=$(echo "$OUT" | grep "sample token:" | awk '{print $NF}')
echo "token: $TOKEN"

echo "== build mint proof via the prover module =="
read CX CY RADDR Z < <(node --input-type=module -e "
import { keccak_256 } from './node_modules/@noble/hashes/sha3.js';
import * as secp from './node_modules/@noble/secp256k1/index.js';
import { makeConfidentialProver } from './dapp/evm-confidential.js';
import { createHash } from 'node:crypto';
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const p = makeConfidentialProver({ secp, keccak256: keccak_256, sha256 });
const N = secp.CURVE.n;
let s = 7; const rand = () => { const b = sha256(new Uint8Array([s++, 0x11])); return (BigInt('0x'+Buffer.from(b).toString('hex')) % N) || 1n; };
const r = rand();
const o = p.proveOpen({ chainId: $CHAINID, contract: '$TOKEN', denomIdx: 2, r, to: '0x0000000000000000000000000000000000000000', rand });
console.log(o.cx, o.cy, o.rAddr, o.z);
")
echo "note C.x: $CX"

echo "== mint (denom idx 2 = 100) over RPC =="
cast send "$TOKEN" "mint(uint8,uint256,uint256,address,uint256)" 2 "$CX" "$CY" "$RADDR" "$Z" \
  --rpc-url $RPC --private-key $PK >/dev/null
SUPPLY=$(cast call "$TOKEN" "supply()(uint256)" --rpc-url $RPC)
NOTEID=$(cast keccak "$(cast abi-encode 'f(uint256,uint256)' "$CX" "$CY")")
STATUS=$(cast call "$TOKEN" "noteStatus(bytes32)(uint8)" "$NOTEID" --rpc-url $RPC)

echo "== result =="
echo "supply:      $SUPPLY   (expect 100)"
echo "note status: $STATUS   (expect 1 = active)"
[ "$SUPPLY" = "100" ] && [ "$STATUS" = "1" ] && echo "ROUND-TRIP OK" || { echo "ROUND-TRIP FAILED"; exit 1; }
