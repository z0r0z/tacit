#!/usr/bin/env bash
# Mine CreateX CREATE3 vanity salts for the Tacit V1 suite — cross-chain-identical 0x00000000… addresses.
#
# WHAT THIS DOES (and why createXcrunch, not create2crunch):
#   We deploy via CreateX.deployCreate3(salt, initCode). The final address = f(CreateX, guardedSalt),
#   INDEPENDENT of initCode, where for our portable "Random" salt form
#       guardedSalt = keccak256(abi.encode(salt))
#   (no msg.sender, no chainid mixed in — see ops/CREATEX-VANITY-DEPLOY.md). Because the address is
#   independent of initCode and the guard is sender/chainid-free, the SAME salt yields the SAME address
#   on Sepolia, mainnet, and every L2.
#
#   plain create2crunch is WRONG: it mines CREATE2 = f(deployer, salt, keccak256(initCode)) and does NOT
#   model CreateX's salt-guard or the proxy→CREATE3 hop. createXcrunch (CreateX-aware fork) models the
#   full salt -> keccak256(abi.encode(salt)) -> CREATE2 proxy -> CREATE3 child chain.
#
# WHERE: GPU box 40707240 (see reference_vast_prover_access). Requires a CUDA GPU + Rust toolchain.
#
# install (one-time on the box):
#   git clone https://github.com/HrikB/createXcrunch && cd createXcrunch && cargo build --release
#
# KEY PARAMS:
#   --factory   the CreateX address (same on every chain).
#   --caller    the deployer EOA. For the PORTABLE "Random" salt form the caller is IRRELEVANT to the
#               final address (the guard does NOT mix msg.sender), so any value works — but pass our
#               broadcaster anyway for reproducibility. (createXcrunch still wants it for its salt layout;
#               we use the "create3" subcommand which targets the proxy-based CREATE3 derivation.)
#   --pattern / --leading-zeros  4  → 4 leading ZERO BYTES → 0x00000000…
#
# IMPORTANT salt-form note: createXcrunch emits a 32-byte salt. Keep byte[20] != 0x01 (no
# cross-chain-redeploy-protection flag) and the high 20 bytes as free entropy (Random form) so the guard
# stays keccak256(abi.encode(salt)). createXcrunch's create3 mode already produces guard-correct salts;
# just verify the emitted salt's byte[20] is not 0x01 before use (the script's guardRandom() reverts otherwise).

set -euo pipefail

CREATEX="0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed"
CALLER="${CALLER:-0x000000000e8CB9ed9DC2114d79d9215eacb9cB07}" # broadcaster (irrelevant to address for Random salts)
LEADING="${LEADING:-4}"                                        # 4 leading zero BYTES => 0x00000000...
CRUNCH="${CRUNCH:-./target/release/createxcrunch}"
OUT="${OUT:-vanity-salts.env}"

# Contracts to mine a salt for (suite CORE — must match DeployV1SuiteCreateX env var names).
CONTRACTS=(FACTORY ADAPTER ENGINE POOL ROUTER RELAYER BTC_CALL_EXECUTOR)

echo "# Tacit V1 CreateX vanity salts (4 leading zero bytes, cross-chain-identical)" > "$OUT"
echo "# factory=$CREATEX caller=$CALLER leading-zero-bytes=$LEADING" >> "$OUT"

for NAME in "${CONTRACTS[@]}"; do
  echo ">>> mining $NAME ..."
  # createXcrunch create3 mode: address is initCode-independent, so NO init-code hash is supplied.
  # --zeros N requests N leading zero BYTES. Adjust flag names to your createXcrunch build (--help).
  SALT="$("$CRUNCH" create3 \
            --factory "$CREATEX" \
            --caller "$CALLER" \
            --zeros "$LEADING" \
            --output - | grep -Eo '0x[0-9a-fA-F]{64}' | head -n1)"

  if [ -z "${SALT:-}" ]; then echo "FAILED to mine $NAME"; exit 1; fi
  # Reject the redeploy-protection flag byte (byte index 20 = chars 42..43 of 0x+64).
  FLAG="${SALT:42:2}"
  if [ "$FLAG" = "01" ]; then echo "REJECT $NAME: salt byte[20]=0x01 (non-portable). Re-mine."; exit 1; fi
  echo "SALT_${NAME}=${SALT}" >> "$OUT"
  echo "    $NAME -> $SALT"
done

echo
echo "Done. Salts written to $OUT. Feed them into the deploy:"
echo "  source $OUT && export SALT_FACTORY SALT_ADAPTER SALT_ENGINE SALT_POOL SALT_ROUTER SALT_RELAYER SALT_BTC_CALL_EXECUTOR"
echo "Then dry-run the address prediction (no broadcast) on any RPC with CreateX deployed:"
echo "  cd contracts && forge script script/DeployV1SuiteCreateX.s.sol --rpc-url \$RPC --sig run()"
echo "The script's predict()/REQUIRE_VANITY guard will assert each address carries the 0x00000000 prefix,"
echo "and the per-deploy 'address mismatch' requires confirm the live CreateX lands exactly where predicted."
echo "Because the guard is sender/chainid-free, the SAME salts reproduce the SAME addresses on every chain."
