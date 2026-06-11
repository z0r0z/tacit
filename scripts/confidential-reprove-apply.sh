#!/bin/bash
# Apply a fresh confidential-guest re-prove from the vast.ai box into the local repo:
# pulls the two rebuilt ELFs + the 7 op artifacts (vkey/pv/proof), updates
# elf-vkey-pin.json + the 7 real-proof fixtures, and runs the coherence checks. Two
# phases so nothing is overwritten blind:
#   bash scripts/confidential-reprove-apply.sh pull    # stage to /tmp + print a summary
#   bash scripts/confidential-reprove-apply.sh apply    # write pin + fixtures, then verify
#
# Box access (the prover box this session brought up):
BOX=root@217.171.200.22
PORT=53359
KEY=~/.ssh/vast_prover
SSHO="-i $KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
RC=/root/work/cxfer
ELFDIR=$RC/guest/target/elf-compilation/riscv64im-succinct-zkvm-elf/release
STAGE=/tmp/reprove-staging
REPO=$(cd "$(dirname "$0")/.." && pwd)

# op  ->  fixture file  ->  which vkey (settle|reflection)
MAP=(
  "transfer:confidential_groth16.json:settle"
  "swap:swap_groth16.json:settle"
  "lp:lp_groth16.json:settle"
  "otc:otc_groth16.json:settle"
  "bid:bid_groth16.json:settle"
  "crosslane:crosslane_groth16.json:settle"
  "reflection:reflection_groth16.json:reflection"
)

ssh_box() { ssh $SSHO -p "$PORT" "$BOX" "$@" 2>/dev/null; }
scp_box() { scp $SSHO -P "$PORT" "$BOX:$1" "$2" 2>/dev/null | grep -viE "Welcome|Have fun"; }
norm() { grep -oE '0x[0-9a-fA-F]{64}' "$1" 2>/dev/null | head -1; }  # extract the 64-char vkey from any LABEL=0x... line

phase=${1:-pull}

if [ "$phase" = "pull" ]; then
  mkdir -p "$STAGE"
  echo "== pulling ELFs =="
  scp_box "$ELFDIR/cxfer-guest"       "$STAGE/cxfer-guest"
  scp_box "$ELFDIR/reflection-prover" "$STAGE/reflection-prover"
  echo "== pulling 7 op artifacts =="
  for e in "${MAP[@]}"; do op=${e%%:*}
    scp_box "$RC/out-fee-$op-vkey.txt"  "$STAGE/$op.vkey"
    scp_box "$RC/out-fee-$op-pv.hex"    "$STAGE/$op.pv"
    scp_box "$RC/out-fee-$op-proof.hex" "$STAGE/$op.proof"
  done
  echo ""
  echo "== SUMMARY (verify before apply) =="
  sg=$(shasum -a 256 "$STAGE/cxfer-guest" | cut -d' ' -f1); rg=$(shasum -a 256 "$STAGE/reflection-prover" | cut -d' ' -f1)
  echo "  cxfer-guest      sha256=$sg  bytes=$(wc -c <"$STAGE/cxfer-guest")"
  echo "  reflection-prover sha256=$rg  bytes=$(wc -c <"$STAGE/reflection-prover")"
  echo "  settle vkeys (transfer/swap/lp/otc/bid/crosslane should all match):"
  for e in "${MAP[@]}"; do op=${e%%:*}; printf '    %-10s %s\n' "$op" "$(norm "$STAGE/$op.vkey")"; done
  echo "  → if the 6 settle vkeys agree and reflection has its own, run: bash $0 apply"
  exit 0
fi

if [ "$phase" = "apply" ]; then
  command -v jq >/dev/null || { echo "need jq"; exit 1; }
  SETTLE_VK=$(norm "$STAGE/swap.vkey"); REFL_VK=$(norm "$STAGE/reflection.vkey")
  echo "settle vkey=$SETTLE_VK  reflection vkey=$REFL_VK"
  # 1. ELFs + pin
  cp "$STAGE/cxfer-guest"       "$REPO/contracts/sp1/confidential/elf/cxfer-guest"
  cp "$STAGE/reflection-prover" "$REPO/contracts/sp1/confidential/elf/reflection-prover"
  PIN="$REPO/contracts/sp1/confidential/elf-vkey-pin.json"
  sg=$(shasum -a 256 "$STAGE/cxfer-guest" | cut -d' ' -f1); sb=$(wc -c <"$STAGE/cxfer-guest")
  rg=$(shasum -a 256 "$STAGE/reflection-prover" | cut -d' ' -f1); rb=$(wc -c <"$STAGE/reflection-prover")
  jq --arg pv "$SETTLE_VK" --arg rv "$REFL_VK" --arg es "$sg" --argjson eb "$sb" --arg rs "$rg" --argjson rb "$rb" \
     '.program_vkey=$pv | .bitcoin_relay_vkey=$rv | .elf_sha256=$es | .elf_bytes=$eb | .reflection_elf_sha256=$rs | .reflection_elf_bytes=$rb' \
     "$PIN" > "$PIN.tmp" && mv "$PIN.tmp" "$PIN"
  echo "updated pin"
  # 2. fixtures
  for e in "${MAP[@]}"; do op=${e%%:*}; fx=$(echo "$e"|cut -d: -f2); which=$(echo "$e"|cut -d: -f3)
    vk=$([ "$which" = settle ] && echo "$SETTLE_VK" || echo "$REFL_VK")
    pv=$(cat "$STAGE/$op.pv"|tr -d '[:space:]'); [ "${pv:0:2}" = "0x" ] || pv="0x$pv"
    pf=$(cat "$STAGE/$op.proof"|tr -d '[:space:]'); [ "${pf:0:2}" = "0x" ] || pf="0x$pf"
    F="$REPO/contracts/test/fixtures/$fx"
    jq --arg vk "$vk" --arg pv "$pv" --arg pf "$pf" '.vkey=$vk | .publicValues=$pv | .proofBytes=$pf' "$F" > "$F.tmp" && mv "$F.tmp" "$F"
    echo "  updated $fx (vkey=$which)"
  done
  # 3. verify
  echo "== verify-vkey-pin.sh =="; ( cd "$REPO/contracts/sp1/confidential" && bash verify-vkey-pin.sh )
  echo "== run the 7 real-proof forge tests + the pin test =="
  echo "   forge test --match-path 'contracts/test/Confidential*ProofReal.t.sol'"
  exit 0
fi
echo "usage: $0 pull|apply"
