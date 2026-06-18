#!/bin/bash
# Verify the TAC Sepolia public round-trip on-chain, phase by phase (companion to
# ops/CHECKLIST-tac-sepolia-roundtrip.md). Read-only assertions against the live pool: the
# proof-gated submissions (attestBitcoinStateProven / settle) are driven out-of-band by the
# prover + settler; this confirms each resulting state transition. `submit-wrap` is the one
# user-side tx that needs no proof (gated behind PRIVATE_KEY).
#
# Usage:
#   POOL=0x<pool> ./scripts/tac-roundtrip-verify.sh state           # Phase 0/1/2 + invariants (no args)
#   POOL=0x<pool> ./scripts/tac-roundtrip-verify.sh bridgemint <nu>
#   POOL=0x<pool> ./scripts/tac-roundtrip-verify.sh unwrap <recipient> <expectedBalance>
#   POOL=0x<pool> ./scripts/tac-roundtrip-verify.sh rewrap <depositId> [expectedStatus=2]
#   POOL=0x<pool> ./scripts/tac-roundtrip-verify.sh crossout <claimId> <destCommitment> <nu>
#   POOL=0x<pool> PRIVATE_KEY=0x.. AMOUNT=.. CX=.. CY=.. OWNER=.. ./scripts/tac-roundtrip-verify.sh submit-wrap
#
# Env: RPC (auto-fallback), POOL (required), FACTORY (default: read from pool), TAC, TAC_CID, PIN.
set -uo pipefail

POOL="${POOL:?set POOL to the deployed ConfidentialPool address}"
TAC="${TAC:-0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b}"
TAC_CID="${TAC_CID:-0x0000000000000000000000000000000000000000000000000000000000000000}"
PIN="${PIN:-$(cd "$(dirname "$0")/.." && pwd)/contracts/sp1/confidential/elf-vkey-pin.json}"
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
ZEROADDR=0x0000000000000000000000000000000000000000

command -v cast >/dev/null || { echo "cast not found (install foundry)"; exit 2; }

# Pick a responsive Sepolia RPC.
RPC="${RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
for r in "$RPC" https://ethereum-sepolia-rpc.publicnode.com https://1rpc.io/sepolia https://sepolia.drpc.org; do
  if cast chain-id --rpc-url "$r" >/dev/null 2>&1; then RPC="$r"; break; fi
done
cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 || { echo "no responsive Sepolia RPC"; exit 2; }

lc(){ printf '%s' "$1" | tr 'A-Z' 'a-z'; }
num(){ printf '%s' "$1" | awk '{print $1}'; }          # strip cast's "1234 [1.2e3]" annotation
unq(){ printf '%s' "$1" | tr -d '"'; }                 # strip quotes from string returns
call(){ cast call "$POOL" "$@" --rpc-url "$RPC" 2>/dev/null; }
fcall(){ cast call "$FACTORY" "$@" --rpc-url "$RPC" 2>/dev/null; }
tcall(){ local t="$1"; shift; cast call "$t" "$@" --rpc-url "$RPC" 2>/dev/null; }

FACTORY="${FACTORY:-$(call 'CANONICAL_FACTORY()(address)')}"

fail=0
ck(){   if [ "$(lc "$(unq "$2")")" = "$(lc "$(unq "$3")")" ]; then echo "  PASS $1"; else echo "  FAIL $1 — got [$2] want [$3]"; fail=1; fi; }
ckne(){ if [ "$(lc "$2")" != "$(lc "$3")" ]; then echo "  PASS $1"; else echo "  FAIL $1 — got [$2], must differ from [$3]"; fail=1; fi; }
ckgt(){ if [ "$(num "$2")" -gt "$3" ] 2>/dev/null; then echo "  PASS $1 ($(num "$2") > $3)"; else echo "  FAIL $1 — got [$2], must be > $3"; fail=1; fi; }
ckge(){ if [ "$(num "$2")" -ge "$(num "$3")" ] 2>/dev/null; then echo "  PASS $1 ($(num "$2") >= $(num "$3"))"; else echo "  FAIL $1 — got [$2], must be >= [$3]"; fail=1; fi; }

preflight(){
  echo "Phase 0 — preconditions (deployed circuit == pin)"
  ck   "PROGRAM_VKEY == pin"       "$(call 'PROGRAM_VKEY()(bytes32)')"       "$(jq -r '.program_vkey' "$PIN")"
  ck   "BITCOIN_RELAY_VKEY == pin" "$(call 'BITCOIN_RELAY_VKEY()(bytes32)')" "$(jq -r '.bitcoin_relay_vkey' "$PIN")"
  ckne "CANONICAL_FACTORY != 0"    "$(call 'CANONICAL_FACTORY()(address)')"  "$ZEROADDR"
  ckne "HEADER_RELAY != 0"         "$(call 'HEADER_RELAY()(address)')"       "$ZEROADDR"
}

reflection(){
  echo "Phase 1 — reflection bootstrapped (Bitcoin state attested)"
  ckne "knownReflectionDigest advanced off genesis" "$(call 'knownReflectionDigest()(bytes32)')" "$(call 'REFLECTION_GENESIS_DIGEST()(bytes32)')"
  ckgt "lastRelayHeight > 0"        "$(call 'lastRelayHeight()(uint64)')"      0
  ckne "knownBitcoinBurnRoot != 0"  "$(call 'knownBitcoinBurnRoot()(bytes32)')"  "$ZERO32"
  ckne "knownBitcoinSpentRoot != 0" "$(call 'knownBitcoinSpentRoot()(bytes32)')" "$ZERO32"
}

onboard(){
  echo "Phase 2 — TAC onboarded + canonical ERC20 deployed at f(asset_id)"
  local predicted token
  predicted=$(fcall 'predict(bytes32,address,string,uint8,bytes32)(address)' "$TAC" "$POOL" "TAC" 18 "$TAC_CID")
  token=$(call 'canonicalTokenFor(bytes32)(address)' "$TAC")
  ck   "canonicalTokenFor(TAC) == predicted" "$token" "$predicted"
  ckne "localAssetOf(TAC) linked"            "$(call 'localAssetOf(bytes32)(bytes32)' "$TAC")" "$ZERO32"
  if [ "$(lc "$token")" != "$ZEROADDR" ] && [ -n "$token" ]; then
    ck "token.MINTER == pool"  "$(tcall "$token" 'MINTER()(address)')"  "$POOL"
    ck "token.ASSET_ID == TAC" "$(tcall "$token" 'ASSET_ID()(bytes32)')" "$TAC"
    ck "token.symbol == TAC"   "$(tcall "$token" 'symbol()(string)')"   "TAC"
    ck "token.decimals == 18"  "$(tcall "$token" 'decimals()(uint8)')"  "18"
  fi
}

bridgemint(){ # <nu>
  local nu="${1:?bridgemint needs the burned-note nullifier ν}"
  echo "Phase 3 — bridge_mint fired for ν=$nu"
  ck   "bridgeMinted[ν] == true"   "$(call 'bridgeMinted(bytes32)(bool)' "$nu")"    "true"
  ck   "nullifierSpent[ν] == true" "$(call 'nullifierSpent(bytes32)(bool)' "$nu")" "true"
  ckgt "nextLeafIndex > 0"         "$(call 'nextLeafIndex()(uint256)')"             0
}

unwrap(){ # <recipient> <expectedBalance underlying units>
  local r="${1:?unwrap needs <recipient>}" exp="${2:?unwrap needs <expectedBalance>}" token
  token=$(call 'canonicalTokenFor(bytes32)(address)' "$TAC")
  echo "Phase 4 — unwrap minted public TAC ERC20 to $r"
  ck "balanceOf(recipient) == expected" "$(num "$(tcall "$token" 'balanceOf(address)(uint256)' "$r")")" "$exp"
  ck "totalSupply == expected (no unbacked supply)" "$(num "$(tcall "$token" 'totalSupply()(uint256)')")" "$exp"
}

rewrap(){ # <depositId> [expectedStatus=2]
  local id="${1:?rewrap needs <depositId>}" want="${2:-2}"
  echo "Phase 5 — re-wrap: ERC20 burned, deposit status == $want (1=pending, 2=consumed)"
  ck "depositStatus(depositId) == $want" "$(num "$(call 'depositStatus(bytes32)(uint8)' "$id")")" "$want"
}

crossout(){ # <claimId> <destCommitment> <nu>
  local cid="${1:?crossout needs <claimId>}" dest="${2:?<destCommitment>}" nu="${3:?<ν>}"
  echo "Phase 6 — crossOut recorded (bridge back to Bitcoin)"
  ck "crossOutCommitment[claimId] == destCommitment" "$(call 'crossOutCommitment(bytes32)(bytes32)' "$cid")" "$dest"
  ck "nullifierSpent[ν] == true"                     "$(call 'nullifierSpent(bytes32)(bool)' "$nu")"      "true"
}

invariants(){
  echo "Invariants"
  ckge "evmNullifiersSpent <= nextLeafIndex (no-inflation floor)" "$(call 'nextLeafIndex()(uint256)')" "$(call 'evmNullifiersSpent()(uint256)')"
}

submit_wrap(){ # state-changing — needs PRIVATE_KEY + a funded caller holding the TAC ERC20
  : "${PRIVATE_KEY:?set PRIVATE_KEY}" "${AMOUNT:?set AMOUNT}" "${CX:?set CX}" "${CY:?set CY}" "${OWNER:?set OWNER}"
  local localId; localId=$(call 'localAssetOf(bytes32)(bytes32)' "$TAC")
  [ "$(lc "$localId")" != "$ZERO32" ] || { echo "TAC not onboarded yet (localAssetOf == 0); run Phase 2 first"; exit 1; }
  # wrap takes only the commit digest keccak(Cx‖Cy‖owner); the raw coords stay in the OP_WRAP witness.
  local commit; commit=$(cast keccak "0x${CX#0x}${CY#0x}${OWNER#0x}")
  echo "submit wrap(localAssetOf(TAC)=$localId, amount=$AMOUNT) — burns the ERC20, records the deposit"
  cast send "$POOL" 'wrap(bytes32,uint256,bytes32)' "$localId" "$AMOUNT" "$commit" \
    --rpc-url "$RPC" --private-key "$PRIVATE_KEY"
}

echo "pool=$POOL  factory=$FACTORY  rpc=$RPC"
cmd="${1:-state}"; shift 2>/dev/null || true
case "$cmd" in
  preflight)  preflight;;
  reflection) reflection;;
  onboard)    onboard;;
  bridgemint) bridgemint "$@";;
  unwrap)     unwrap "$@";;
  rewrap)     rewrap "$@";;
  crossout)   crossout "$@";;
  invariants) invariants;;
  submit-wrap) submit_wrap "$@";;
  state)      preflight; reflection; onboard; invariants;;
  *) echo "usage: $0 {state|preflight|reflection|onboard|invariants|bridgemint <ν>|unwrap <recipient> <amount>|rewrap <depositId> [status]|crossout <claimId> <destCommitment> <ν>|submit-wrap}"; exit 2;;
esac

if [ "$fail" -eq 0 ]; then echo "ALL PASS"; else echo "FAILURES ABOVE"; exit 1; fi
