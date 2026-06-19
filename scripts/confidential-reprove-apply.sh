#!/bin/bash
# Apply a coordinated confidential-guest re-prove from a prover box into this repo.
#
# The script is intentionally two-phase:
#
#   bash scripts/confidential-reprove-apply.sh pull
#   bash scripts/confidential-reprove-apply.sh apply
#
# `pull` stages remote ELFs + Groth16 artifacts under STAGE and prints their
# hashes/vkeys. `apply` updates the committed ELFs, pin JSON, deploy default,
# reflection frozen guard, and all real-proof fixtures.
#
# Defaults match the Sepolia E2 Vast workspace used by the current run; override
# BOX/PORT/KEY/REMOTE_ROOT/ARTIFACT_DIR/STAGE for another box.
set -euo pipefail
export LC_ALL=C
export LANG=C

BOX="${BOX:-root@ssh8.vast.ai}"
PORT="${PORT:-27240}"
KEY="${KEY:-$HOME/.ssh/vast_prover}"
SSHO=(-i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
REMOTE_ROOT="${REMOTE_ROOT:-/root/work/confidential}"
ARTIFACT_DIR="${ARTIFACT_DIR:-/root/work/e2-reprove/artifacts}"
ELFDIR="${ELFDIR:-$REMOTE_ROOT/target/elf-compilation/riscv64im-succinct-zkvm-elf/release}"
STAGE="${STAGE:-/tmp/reprove-staging}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# op -> fixture file -> which vkey (settle|reflection)
MAP=(
  "transfer:confidential_groth16.json:settle"
  "swap:swap_groth16.json:settle"
  "lp:lp_groth16.json:settle"
  "otc:otc_groth16.json:settle"
  "bid:bid_groth16.json:settle"
  "crosslane:crosslane_groth16.json:settle"
  "reflection:reflection_groth16.json:reflection"
  "reflection_burn_deposit:reflection_burn_deposit_groth16.json:reflection"
)

ssh_box() { ssh "${SSHO[@]}" -p "$PORT" "$BOX" "$@"; }
scp_box() { scp "${SSHO[@]}" -P "$PORT" "$BOX:$1" "$2"; }
norm() { grep -oE '0x[0-9a-fA-F]{64}' "$1" 2>/dev/null | head -1; }
sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    sha256sum "$1" | cut -d' ' -f1
  fi
}
json_hex() {
  local f="$1" x
  x="$(tr -d '[:space:]' < "$f")"
  [ "${x:0:2}" = "0x" ] || x="0x$x"
  printf '%s' "$x"
}

need_stage_file() {
  [ -s "$STAGE/$1" ] || { echo "missing staged file: $STAGE/$1"; exit 1; }
}

phase="${1:-pull}"

if [ "$phase" = "pull" ]; then
  mkdir -p "$STAGE"
  echo "== remote summary =="
  ssh_box "sha256sum '$ELFDIR/confidential-pool-prover' '$ELFDIR/reflection-prover' && wc -c '$ELFDIR/confidential-pool-prover' '$ELFDIR/reflection-prover'"

  echo "== pulling ELFs =="
  scp_box "$ELFDIR/confidential-pool-prover" "$STAGE/cxfer-guest"
  scp_box "$ELFDIR/reflection-prover" "$STAGE/reflection-prover"

  echo "== pulling Groth16 artifacts =="
  for e in "${MAP[@]}"; do
    op="${e%%:*}"
    scp_box "$ARTIFACT_DIR/$op.vkey" "$STAGE/$op.vkey"
    scp_box "$ARTIFACT_DIR/$op.pv" "$STAGE/$op.pv"
    scp_box "$ARTIFACT_DIR/$op.proof" "$STAGE/$op.proof"
  done

  echo
  echo "== staged summary =="
  echo "  cxfer-guest       sha256=$(sha256_file "$STAGE/cxfer-guest") bytes=$(wc -c < "$STAGE/cxfer-guest" | tr -d ' ')"
  echo "  reflection-prover sha256=$(sha256_file "$STAGE/reflection-prover") bytes=$(wc -c < "$STAGE/reflection-prover" | tr -d ' ')"
  echo "  artifact vkeys:"
  for e in "${MAP[@]}"; do
    op="${e%%:*}"
    printf '    %-25s %s\n' "$op" "$(norm "$STAGE/$op.vkey")"
  done
  echo
  echo "If every settle vkey matches and both reflection vkeys match, run:"
  echo "  STAGE=$STAGE bash scripts/confidential-reprove-apply.sh apply"
  exit 0
fi

if [ "$phase" = "apply" ]; then
  command -v jq >/dev/null || { echo "need jq"; exit 1; }
  command -v perl >/dev/null || { echo "need perl"; exit 1; }

  need_stage_file cxfer-guest
  need_stage_file reflection-prover
  for e in "${MAP[@]}"; do
    op="${e%%:*}"
    need_stage_file "$op.vkey"
    need_stage_file "$op.pv"
    need_stage_file "$op.proof"
  done

  SETTLE_VKEY="$(norm "$STAGE/transfer.vkey")"
  REFLECTION_VKEY="$(norm "$STAGE/reflection.vkey")"
  [ -n "$SETTLE_VKEY" ] || { echo "missing settle vkey"; exit 1; }
  [ -n "$REFLECTION_VKEY" ] || { echo "missing reflection vkey"; exit 1; }

  for op in transfer swap lp otc bid crosslane; do
    got="$(norm "$STAGE/$op.vkey")"
    [ "$got" = "$SETTLE_VKEY" ] || { echo "settle vkey mismatch for $op: $got != $SETTLE_VKEY"; exit 1; }
  done
  for op in reflection reflection_burn_deposit; do
    got="$(norm "$STAGE/$op.vkey")"
    [ "$got" = "$REFLECTION_VKEY" ] || { echo "reflection vkey mismatch for $op: $got != $REFLECTION_VKEY"; exit 1; }
  done

  SETTLE_SHA="$(sha256_file "$STAGE/cxfer-guest")"
  SETTLE_BYTES="$(wc -c < "$STAGE/cxfer-guest" | tr -d ' ')"
  REFLECTION_SHA="$(sha256_file "$STAGE/reflection-prover")"
  REFLECTION_BYTES="$(wc -c < "$STAGE/reflection-prover" | tr -d ' ')"

  echo "settle:     $SETTLE_VKEY $SETTLE_SHA ${SETTLE_BYTES}B"
  echo "reflection: $REFLECTION_VKEY $REFLECTION_SHA ${REFLECTION_BYTES}B"

  cp "$STAGE/cxfer-guest" "$REPO/contracts/sp1/confidential/elf/cxfer-guest"
  cp "$STAGE/reflection-prover" "$REPO/contracts/sp1/confidential/elf/reflection-prover"

  PIN="$REPO/contracts/sp1/confidential/elf-vkey-pin.json"
  STATE="Sepolia E2 coordinated re-prove finalized: settle guest $SETTLE_VKEY (ELF sha $SETTLE_SHA, ${SETTLE_BYTES} bytes) and reflection guest $REFLECTION_VKEY (ELF sha $REFLECTION_SHA, ${REFLECTION_BYTES} bytes). Real Groth16 fixtures for transfer/swap/lp/otc/bid/crosslane/reflection/reflection_burn_deposit were regenerated from the same staged ELFs and locally verified before pinning. Mainnet re-anchor/re-prove remains a separate checklist."
  jq \
    --arg pv "$SETTLE_VKEY" \
    --arg rv "$REFLECTION_VKEY" \
    --arg es "$SETTLE_SHA" \
    --argjson eb "$SETTLE_BYTES" \
    --arg rs "$REFLECTION_SHA" \
    --argjson rb "$REFLECTION_BYTES" \
    --arg state "$STATE" \
    '.program_vkey=$pv
     | .bitcoin_relay_vkey=$rv
     | .elf_sha256=$es
     | .elf_bytes=$eb
     | .reflection_elf_sha256=$rs
     | .reflection_elf_bytes=$rb
     | .guest_state=$state' \
    "$PIN" > "$PIN.tmp" && mv "$PIN.tmp" "$PIN"

  for e in "${MAP[@]}"; do
    op="${e%%:*}"
    rest="${e#*:}"
    fx="${rest%%:*}"
    which="${rest##*:}"
    if [ "$which" = settle ]; then vk="$SETTLE_VKEY"; else vk="$REFLECTION_VKEY"; fi
    pv="$(json_hex "$STAGE/$op.pv")"
    proof="$(json_hex "$STAGE/$op.proof")"
    F="$REPO/contracts/test/fixtures/$fx"
    jq --arg vk "$vk" --arg pv "$pv" --arg proof "$proof" \
      '.vkey=$vk | .publicValues=$pv | .proofBytes=$proof' \
      "$F" > "$F.tmp" && mv "$F.tmp" "$F"
    echo "updated $fx"
  done

  DEPLOY="$REPO/contracts/script/DeployConfidentialPool.s.sol"
  perl -0pi -e "s/bytes32 constant DEFAULT_VKEY = 0x[0-9a-fA-F]{64};/bytes32 constant DEFAULT_VKEY = $SETTLE_VKEY;/" "$DEPLOY"

  GUARD="$REPO/contracts/sp1/confidential/verify-vkey-pin.sh"
  perl -0pi -e "s/FROZEN_REFLECTION_VKEY=\"0x[0-9a-fA-F]{64}\"/FROZEN_REFLECTION_VKEY=\"$REFLECTION_VKEY\"/" "$GUARD"
  perl -0pi -e "s/FROZEN_REFLECTION_ELF_SHA=\"[0-9a-fA-F]{64}\"/FROZEN_REFLECTION_ELF_SHA=\"$REFLECTION_SHA\"/" "$GUARD"

  echo "== verify-vkey-pin.sh =="
  (cd "$REPO/contracts/sp1/confidential" && bash verify-vkey-pin.sh)
  echo
  echo "Now run the real-proof suite:"
  echo "  forge test --root contracts --offline --match-path 'test/*ProofReal.t.sol'"
  exit 0
fi

echo "usage: $0 pull|apply"
exit 2
