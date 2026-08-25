#!/bin/bash
set -euo pipefail

# Guard the immutable ConfidentialPool artifact on every PR.
#
#   1. EIP-170 (ALWAYS hard-fail): runtime bytecode <= 24576 bytes. The pool ships ~20 bytes under the
#      limit, so an added require/event/getter can silently produce an UNDEPLOYABLE contract. Catching that
#      at deploy time means discovering it after the guest re-prove and the vanity-salt grind.
#   2. Artifact identity: keccak(LINK-NORMALIZED runtime) == pool-bytecode-pin.json:runtime_keccak, plus the
#      pinned set of library link references. The pool delegatecalls ReflectionLib, so the raw runtime carries
#      link placeholders until an address is chosen; normalizing them keeps the identity address-independent
#      while the separate link-reference pin catches any change to what the pool links. A mismatch means the
#      bytecode changed — legitimately (code/compiler change: update the pin IN THE SAME COMMIT) or
#      accidentally (a floating solc, a dependency bump). Same discipline as sp1/confidential/elf-vkey-pin.json.
#
# The compiler is pinned at the source (`pragma solidity 0.8.34;`) rather than in foundry.toml, because the
# *ProofReal units pin 0.8.20 for the vendored SP1 Groth16Verifier — the build is intentionally multi-version.
#
# Exit non-zero on any mismatch.

cd "$(dirname "$0")"
PIN="pool-bytecode-pin.json"
[ -f "$PIN" ] || { echo "FAIL: missing $PIN"; exit 1; }

want_size=$(grep -o '"runtime_size"[[:space:]]*:[[:space:]]*[0-9]*' "$PIN" | grep -o '[0-9]*$')
want_hash=$(grep -o '"runtime_keccak"[[:space:]]*:[[:space:]]*"[^"]*"' "$PIN" | sed 's/.*"\(0x[^"]*\)"/\1/')
limit=24576

# The pool links ReflectionLib (the attest/drain surface lives there so the immutable pool fits EIP-170), so
# the compiled runtime carries unresolved `__$<hash>$__` link placeholders until a library address is chosen.
# Hash the LINK-NORMALIZED runtime (every placeholder zeroed): that identity is what was reviewed and is
# independent of which address the library lands at, so the pin stays stable across deploy rehearsals while
# still catching any real code or compiler drift. The link references themselves are pinned separately below,
# so a NEW unlinked dependency can never slip in unnoticed.
code=$(python3 -c 'import json,re,sys; a=json.load(open("out/ConfidentialPool.sol/ConfidentialPool.json")); sys.stdout.write(re.sub(r"__\$[0-9a-f]{34}\$__","00"*20,a["deployedBytecode"]["object"]))')
case "$code" in 0x*) ;; *) echo "FAIL: could not read deployedBytecode"; exit 1;; esac
size=$(( (${#code} - 2) / 2 ))
hash=$(cast keccak "$code")

# Pinned link references: which libraries the runtime links, and at which byte offsets. A drift here means the
# deploy-time linking surface changed — the pool would be deployed against a library set nobody reviewed.
links=$(python3 -c 'import json,sys; r=json.load(open("out/ConfidentialPool.sol/ConfidentialPool.json"))["deployedBytecode"].get("linkReferences",{}); sys.stdout.write(";".join(f"{f}:{lib}:"+",".join(str(x["start"]) for x in occ) for f,libs in sorted(r.items()) for lib,occ in sorted(libs.items())))')
want_links=$( (grep -o '"link_references"[[:space:]]*:[[:space:]]*"[^"]*"' "$PIN" || true) | sed 's/.*: *"\(.*\)"/\1/' | tail -1)

echo "ConfidentialPool runtime: $size bytes (limit $limit, headroom $(( limit - size )))"
echo "  link references:        ${links:-<none>}"

if [ "$size" -gt "$limit" ]; then
  echo "FAIL: EIP-170 EXCEEDED by $(( size - limit )) bytes — this contract CANNOT be deployed."
  echo "      Reduce pool code or move a surface behind the router before proceeding."
  exit 1
fi

if [ "$links" != "$want_links" ]; then
  echo "FAIL: link references differ from the reviewed pin."
  echo "      pinned: ${want_links:-<none>}"
  echo "      built:  ${links:-<none>}"
  echo "      The set of libraries the pool delegatecalls changed. Review it, then update $PIN"
  echo "      in the SAME commit."
  exit 1
fi

if [ "$size" != "$want_size" ] || [ "$hash" != "$want_hash" ]; then
  echo "FAIL: artifact differs from the reviewed pin."
  echo "      pinned: $want_size bytes  $want_hash"
  echo "      built:  $size bytes  $hash"
  echo "      If this change is intentional, update $PIN in the SAME commit."
  exit 1
fi

echo "OK: runtime matches the pinned artifact ($hash)"
