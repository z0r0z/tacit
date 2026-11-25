#!/bin/sh
# Reproduce the start of the Tacit Praxis ceremony's chain: SP1 v6.1.0's Groth16 setup, from the Hermez Powers of Tau file
# to the key Succinct's deployed verifier uses. Each step prints MATCHES or stops at the first value that differs.
#
#   1. powersOfTau28_hez_final_24.ptau has the BLAKE2b-512 in the snarkjs README (and, with VERIFY_PTAU=1, snarkjs verifies it)
#   2. Phase 1, converted from it, equals Succinct's trusted-setup/phase1
#   3. the initial Phase 2 file and the evaluations, derived from Phase 1 and the circuit, equal Succinct's phase2 and evals
#      (with this repository's parallel fastp2n, which gives gnark's Initialize byte for byte; Succinct's own `sg11 p2n` does the same
#      in one thread, about two days on a 48-core server of 2014, and gives the same files: SG11_P2N=1 uses it)
#   4. all 18 contributions (phase2 -> phase2-0 -> ... -> phase2-17) verify, link by link
#   5. the keys extracted from phase2-17 equal Succinct's groth16_vk.bin (4388a21c...) and groth16_pk.bin (c3760e0e...), by
#      Succinct's tool and by this repository's `tacit-ceremony seal` (their seal value, drand round 2000's randomness)
#   6. that vk is the one deployed on Ethereum: VERIFIER_HASH() of SP1 v6.1.0's Groth16 verifier, and every constant of
#      its Solidity verifier in the deployed bytecode
#
# Needs: Go 1.24+, git, curl, python3, sha256sum (or shasum); about 80 GB of disk and 64 GB of RAM (more is faster: 64 threads and
# 128 GB took, in this repository's runs: the seal of step 5 about 55 minutes and the evaluations of step 3 about 3 hours; Succinct's
# own tools are slower, one thread at their slowest steps: about 22 hours for p2n on a 48-core server of 2014). Plus the downloads
# (about 45 GB).
#
#   sh reproduce.sh [work-dir]        # log in <work-dir>/reproduce.log
set -eu

W=${1:-./genesis-work}
RPC=${RPC:-https://ethereum-rpc.publicnode.com}
PTAU_URL=${PTAU_URL:-https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_24.ptau}
PTAU_MIRROR=https://circom.info/powersOfTau28_hez_final_24.ptau
S3=https://sp1-circuits.s3-us-east-2.amazonaws.com

# pinned values
PTAU_B2=fa404d140d5819d39984833ca5ec3632cd4995f81e82db402371a4de7c2eae8687c62bc632a95b0c6aadba3fb02680a94e09174b7233ccd26d78baca2647c733
TS_TAR=874287a24fa8fc6158ea10b46b633235d01197d0bbbcc943d9b92a20dea9eb9c   # v6.1.0-trusted-setup.tar.gz
G16_TAR=18beebb6cd0cc9b4d4a240ee4f49511da6c2a7e51724bad4232de538a9147810  # v6.1.0-groth16.tar.gz
CIRCUIT=d6a66be2702206e2b1a20bebf7096142864feac9e399a309e5e6e00353264cbc
PHASE1=6acd8f6517f1d911a1eb12bdd7f0b817ba9e8fea33e34564c45cd50706976edb
PHASE2=948132ccc8c0de3fd1bf4b9dc625f6b35914625ab80d6c964daf811c1fdfc759
EVALS=53373457073ca7cd0756fc1e64a9f0391769bb8870ba1f8d54a678b2a35e4155
P2_17=bf6f7799c77a90009ae356fd0d3a69a91cf153825e6762ce344fe804cf5db2df
VK=4388a21c687fdd5f218d7e3d13190cac4c5355818d3605fd5fb811df468ee696
PK=c3760e0e3b58487f8704680d5b3ad32a9fbca9f3cb0749d69055c4f1271ca167
VERIFIER=0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2   # V6_1_0_SP1_VERIFIER_GROTH16, succinctlabs/sp1-contracts deployments/1.json
SG11_COMMIT=6d6ebc3                                    # succinctlabs/semaphore-gnark-11, the tool Succinct's transcript was made with
HERE=$(cd "$(dirname "$0")/.." && pwd)                 # ceremony-phase2

mkdir -p "$W"
cd "$W"
LOG=$PWD/reproduce.log
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
same() { # name want got
  if [ "$2" = "$3" ]; then log "$1 MATCHES ($3)"; else log "$1 DIFFERS: want $2, got $3"; exit 1; fi
}
fetch() { [ -s "$2" ] || curl -fL --retry 5 -C - -o "$2" "$1"; }

log "reproduce start; tool $(git -C "$HERE" rev-parse HEAD 2>/dev/null || echo '?')"

# tools: Succinct's semaphore-gnark-11 at the pinned commit, and this repository's tacit-ceremony
if [ ! -x sg11 ]; then
  [ -d semaphore-gnark-11 ] || git clone -q https://github.com/succinctlabs/semaphore-gnark-11
  git -C semaphore-gnark-11 checkout -q "$SG11_COMMIT"
  (cd semaphore-gnark-11 && go build -o ../sg11 .)
fi
[ -x tacit-ceremony ] || (cd "$HERE" && go build -o "$OLDPWD/tacit-ceremony" ./cmd/tacit-ceremony)

# 1. the Hermez Phase 1 file
fetch "$PTAU_URL" powersOfTau28_hez_final_24.ptau || fetch "$PTAU_MIRROR" powersOfTau28_hez_final_24.ptau
B2=$(python3 -c "
import hashlib
h = hashlib.blake2b()
with open('powersOfTau28_hez_final_24.ptau', 'rb') as f:
    for c in iter(lambda: f.read(1 << 24), b''): h.update(c)
print(h.hexdigest())")
same "1. ptau BLAKE2b (snarkjs README)" "$PTAU_B2" "$B2"
if [ "${VERIFY_PTAU:-}" = 1 ]; then
  log "1b. snarkjs powersoftau verify (long)"
  npx -y snarkjs@0.7.5 powersoftau verify powersOfTau28_hez_final_24.ptau >> snarkjs-verify.log 2>&1 && log "1b. snarkjs verify OK" || { log "1b. snarkjs verify FAILED (snarkjs-verify.log)"; exit 1; }
fi

# Succinct's transcript and circuit
fetch "$S3/v6.1.0-trusted-setup.tar.gz" v6.1.0-trusted-setup.tar.gz
same "transcript archive" "$TS_TAR" "$(sha v6.1.0-trusted-setup.tar.gz)"
fetch "$S3/v6.1.0-groth16.tar.gz" v6.1.0-groth16.tar.gz
same "circuit archive" "$G16_TAR" "$(sha v6.1.0-groth16.tar.gz)"
[ -d trusted-setup ] || tar -xzf v6.1.0-trusted-setup.tar.gz
[ -d g16 ] || { mkdir g16 && tar -xzf v6.1.0-groth16.tar.gz -C g16; }
same "circuit" "$CIRCUIT" "$(sha g16/groth16_circuit.bin)"

# 2. Phase 1
[ -s phase1.rederived ] || ./sg11 p1i powersOfTau28_hez_final_24.ptau phase1.rederived >> sg11.log 2>&1
same "2. phase1 re-derived" "$PHASE1" "$(sha phase1.rederived)"
same "   phase1 in the transcript" "$PHASE1" "$(sha trusted-setup/phase1)"

# 3. the initial Phase 2 file and the evaluations (Phase 1 is sealed with drand round 1000, as in the transcript)
if [ ! -s evals.rederived ]; then
  if [ "${SG11_P2N:-}" = 1 ]; then
    ./sg11 p2n --beacon-round 1000 phase1.rederived g16/groth16_circuit.bin phase2.rederived evals.rederived >> sg11.log 2>&1
  else
    [ -x fastp2n ] || (cd "$HERE" && go build -o "$OLDPWD/fastp2n" ./rehearsal/fastp2n)
    ./fastp2n run phase1.rederived g16/groth16_circuit.bin phase2.rederived evals.rederived >> fastp2n.log 2>&1
  fi
fi
same "3. phase2 re-derived" "$PHASE2" "$(sha phase2.rederived)"
same "   phase2 in the transcript" "$PHASE2" "$(sha trusted-setup/phase2)"
same "3. evals re-derived" "$EVALS" "$(sha evals.rederived)"
same "   evals in the transcript" "$EVALS" "$(sha trusted-setup/evals)"

# 4. the 18 contributions
./tacit-ceremony verify trusted-setup/phase2 trusted-setup/phase2-0 >> verify.log 2>&1 || { log "4. phase2 -> phase2-0 does not verify"; exit 1; }
./tacit-ceremony verify-chain trusted-setup 0 17 >> verify.log 2>&1 || { log "4. the chain does not verify (verify.log)"; exit 1; }
same "4. all 18 contributions verify; phase2-17" "$P2_17" "$(sha trusted-setup/phase2-17)"

# 5. the keys
if [ ! -s vk ]; then
  ./sg11 key trusted-setup/phase1 trusted-setup/phase2-17 trusted-setup/evals g16/groth16_circuit.bin powersOfTau28_hez_final_24.ptau >> sg11.log 2>&1
fi
same "5. vk extracted" "$VK" "$(sha vk)"
same "   vk Succinct ships" "$VK" "$(sha g16/groth16_vk.bin)"
same "5. pk extracted" "$PK" "$(sha pk)"
same "   pk Succinct ships" "$PK" "$(sha g16/groth16_pk.bin)"
# and by this repository's seal, from the same three files and the transcript's own seal value (drand round 2000)
R2000=a7cce6db014177c3e2844b0ccea8145bf10c1823606709279ddeeb3aeb6b2f53
if [ ! -s seal/groth16_vk.bin ]; then
  ./tacit-ceremony seal trusted-setup/phase1 trusted-setup/phase2-17 trusted-setup/evals "$R2000" seal >> seal.log 2>&1
fi
same "5. vk by tacit-ceremony seal" "$VK" "$(sha seal/groth16_vk.bin)"
same "5. pk by tacit-ceremony seal" "$PK" "$(sha seal/groth16_pk.bin)"

# 6. on Ethereum
H=$(curl -s -m 30 -X POST "$RPC" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"'$VERIFIER'","data":"0x2a510436"},"latest"]}' |
  python3 -c "import json,sys; print(json.load(sys.stdin)['result'][2:])")
same "6. VERIFIER_HASH() at $VERIFIER" "$VK" "$H"
./tacit-ceremony solidity vk Groth16Verifier.reproduced.sol > /dev/null
curl -s -m 30 -X POST "$RPC" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["'$VERIFIER'","latest"]}' > verifier-code.json
python3 - "$LOG" <<'EOF'
import json, re, sys
code = json.load(open('verifier-code.json'))['result'].lower()
sol = open('Groth16Verifier.reproduced.sol').read()
skip = {'R', 'P', 'MOD_EXP', 'EXP_SQRT_FP', 'EXP_INVERSE_FP', 'EXP_SQRT_FP_NEG', 'FRACTION_1_2_FP', 'FRACTION_27_82_FP', 'FRACTION_3_82_FP'}
found, missing = 0, []
for name, v in re.findall(r'uint256 constant (\w+) = (\d+);', sol):
    if name in skip:
        continue
    h = format(int(v), 'x')
    n = (len(h) + 1) // 2  # pushed with the fewest bytes: PUSHn = 0x5f + n
    if format(0x5f + n, '02x') + h.rjust(2 * n, '0') in code:
        found += 1
    else:
        missing.append(name)
line = f"6. {found} key constants found in the deployed bytecode" + (f"; MISSING {missing}" if missing else " (all) MATCHES")
print(line)
open(sys.argv[1], 'a').write(line + '\n')
sys.exit(1 if missing else 0)
EOF
log "DONE: the transcript's starting files, its 18 contributions and the deployed key all reproduce"
