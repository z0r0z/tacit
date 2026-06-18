#!/bin/bash
# One-off: drive the OP_WRAP on-ramp for the settle-relay e2e — wrap() on-chain, GPU-prove the
# deposit-consume, settle() it (inserting tree leaf 0), and check currentRoot advanced to the
# locally-computed R1. Run in tmux on the box; reads /root/work/cxfer/e2e/wrap_op.json.
set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.sp1/bin:$HOME/.foundry/bin:$PATH"
POOL=0xdd08be04b9831115dD8c7B50A26C36B333a72E2a
RPC=https://ethereum-sepolia-rpc.publicnode.com
PK=$(cat /root/loop-state/.ethpk)
D=/root/work/cxfer; OP=$D/e2e/wrap_op.json
ASSET=$(jq -r .asset "$OP"); VALUE=$(jq -r .value "$OP")
CX=$(jq -r .cx "$OP"); CY=$(jq -r .cy "$OP"); OWNER=$(jq -r .owner "$OP")
# wrap takes only the commit digest keccak(Cx‖Cy‖owner); the raw coords stay in the OP_WRAP witness.
COMMIT=$(cast keccak "0x${CX#0x}${CY#0x}${OWNER#0x}")
EXPECT_R1=0x807b865fc9644436ccffd5d82c0fa1dfb563b8c14e545cb8edc3af8ed78b96a6

echo "[W1] wrap(asset,$VALUE,commit) value=$VALUE wei"
cast send "$POOL" "wrap(bytes32,uint256,bytes32)" "$ASSET" "$VALUE" "$COMMIT" \
  --value "$VALUE" --private-key "$PK" --rpc-url "$RPC" 2>&1 | grep -iE "status|transactionHash" | head -2

echo "[W2] fresh gpu-server + groth16-prove OP_WRAP..."
pkill -9 -f "[s]p1-gpu-server" 2>/dev/null; sleep 2; rm -f /tmp/sp1-cuda-0.sock
CUDA_VISIBLE_DEVICES=0 setsid nohup "$HOME/.sp1/bin/sp1-gpu-server" >"$D/cps-gpu-server.log" 2>&1 </dev/null &
for _ in $(seq 1 20); do sleep 2; [ -S /tmp/sp1-cuda-0.sock ] && break; done
cp "$D/harnesses/exec-wrap.rs" "$D/exec/src/main.rs"
rm -f "$D/exec/public_values.hex" "$D/exec/proof_bytes.hex"
( cd "$D/exec" && OP_FILE="$OP" MODE=groth16 CUDA_VISIBLE_DEVICES=0 cargo run --release ) >"$D/wrap-prove.log" 2>&1
echo "  prove rc=$? (134=cosmetic teardown) pv=$(wc -c <"$D/exec/public_values.hex" 2>/dev/null)B proof=$(wc -c <"$D/exec/proof_bytes.hex" 2>/dev/null)B"
[ -s "$D/exec/public_values.hex" ] && [ -s "$D/exec/proof_bytes.hex" ] || { echo "WRAP-E2E FAIL: no proof artifacts"; tail -8 "$D/wrap-prove.log"; exit 1; }
PV=0x$(tr -d '[:space:]' <"$D/exec/public_values.hex")
PROOF=0x$(tr -d '[:space:]' <"$D/exec/proof_bytes.hex")

echo "[W3] settle(pv,proof,[]) ..."
cast send "$POOL" "settle(bytes,bytes,bytes[])" "$PV" "$PROOF" "[]" \
  --private-key "$PK" --rpc-url "$RPC" 2>&1 | grep -iE "status|transactionHash" | head -2

ROOT=$(cast call "$POOL" "currentRoot()(bytes32)" --rpc-url "$RPC")
echo "[W4] currentRoot=$ROOT"
echo "     expected R1=$EXPECT_R1"
[ "$ROOT" = "$EXPECT_R1" ] && echo "WRAP-E2E DONE: root matches — leaf 0 inserted, deposit consumed" || echo "WRAP-E2E MISMATCH: root != R1"
