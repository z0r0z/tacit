#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ELF=${REFLECT_ELF:?set REFLECT_ELF to the freshly built reflection-prover ELF}
EXEC=(cargo run --release --manifest-path "$ROOT/contracts/sp1/reflect-exec/Cargo.toml" --bin reflect-execute --)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

run_valid() {
  node "$ROOT/tests/gen-reflection-burn-deposit.mjs" > "$tmp/valid.json"
  out=$(REFLECT_ELF="$ELF" "${EXEC[@]}" "$tmp/valid.json")
  echo "$out"
  grep -q 'EXECUTE_OK' <<<"$out"
  grep -q 'DIGEST_MATCH' <<<"$out"
}

run_invalid() {
  local name=$1; shift
  env "$@" node "$ROOT/tests/gen-reflection-burn-deposit.mjs" > "$tmp/$name.json"
  set +e
  out=$(REFLECT_ELF="$ELF" "${EXEC[@]}" "$tmp/$name.json" 2>&1)
  status=$?
  set -e
  echo "$out"
  grep -q 'EXECUTE_OK' <<<"$out"
  grep -q 'DIGEST_MISMATCH' <<<"$out"
  if [[ $status -eq 0 ]] || grep -q 'DIGEST_MATCH' <<<"$out"; then
    echo "invalid burn-deposit case unexpectedly folded: $name" >&2
    return 1
  fi
}

run_valid
run_invalid bad-etch ETCH_WITNESS_TAMPER=1
run_invalid bad-cmint MINTABLE=1 CMINT_TAMPER=1
run_invalid nonconserving TAMPER=1
run_invalid witness-mismatch WITNESS_TAMPER=1
echo 'burn-deposit full-stream invalid KATs PASS'
