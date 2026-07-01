#!/usr/bin/env bash
# One entrypoint for the Tacit V1 Sepolia + Signet rehearsal.
#
# Sequences the full bring-up that ops/runbooks/V1-TESTNET-LAUNCH-PLAYBOOK.md spells out as separate steps:
#   1. deploy the suite            contracts/deploy-v1-suite-testnet.sh        (§1)
#   2. wire dapp + worker config   tools/sync-deployment-config.mjs            (§2)
#   3. fund the run wallets        tests/v1-fund-wallets.mjs                    (§4 prereq)
#   4. day-1 bootstrap             tests/v1-day1-bootstrap-signet.mjs          (§4)
#   5. orchestrated test matrix    tests/run-v1-testnet.mjs (live)             (§5a)
#
# Two modes:
#   DRY_RUN=1 (default)  — env preflight (lenient) + the orchestrator PLAN + bootstrap VALIDATE. No deploy,
#                          no funding, no broadcast. CI-safe and fast; needs only node + the repo.
#   DRY_RUN=0            — the live sequence end-to-end: deploy → sync → fund → bootstrap → live matrix, with
#                          a strict env preflight up front (every downstream-required var checked at once).
#
# Re-run friendly: a live re-run reuses an existing contracts/deployments/<chainid>.json (skips deploy) when
# REUSE_MANIFEST=1, and the underlying deploy refuses a dirty tree unless ALLOW_DIRTY=1.
#
# Usage:
#   scripts/v1-testnet-rehearsal.sh                              # dry-run (plan + validate)
#   DRY_RUN=0 DEPLOYER_PRIVATE_KEY=… SP1_VERIFIER=… \
#     [REFLECTION=1 GENESIS_REFLECTION_ANCHOR=…] scripts/v1-testnet-rehearsal.sh
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

DRY_RUN="${DRY_RUN:-1}"
REFLECTION="${REFLECTION:-0}"
SEPOLIA_RPC="${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}"
MAX_PARALLEL="${MAX_PARALLEL:-8}"
CHAINID_DEFAULT=11155111

phase() { echo; echo "==== $* ===="; }

# ── env preflight ────────────────────────────────────────────────────────────
# Collect every missing required var and report them together, so a live run never fails deep into a long
# sequence on the first var it happens to hit. The required set is derived from what the downstream scripts
# actually read.
preflight() {
  local missing=()
  local need=(DEPLOYER_PRIVATE_KEY SP1_VERIFIER)

  # Live funding + the orchestrator's live matrix.
  need+=(FUND_PK)

  # Cross-chain bring-up pulls in the relay anchor + advancer inputs.
  if [ "$REFLECTION" = "1" ]; then
    need+=(GENESIS_REFLECTION_ANCHOR)
  fi

  for v in "${need[@]}"; do
    [ -n "${!v:-}" ] || missing+=("$v")
  done

  if [ "${#missing[@]}" -gt 0 ]; then
    echo "missing required env var(s) for a live rehearsal:" >&2
    for v in "${missing[@]}"; do
      echo "  - $v" >&2
    done
    cat >&2 <<'EOF'

set them and re-run. reference:
  DEPLOYER_PRIVATE_KEY   Sepolia-funded deployer key (contracts/deploy-v1-suite-testnet.sh)
  SP1_VERIFIER           immutable Sepolia SP1VerifierGroth16 leaf (never the gateway)
  FUND_PK                key that funds the run wallets (tests/v1-fund-wallets.mjs)
  GENESIS_REFLECTION_ANCHOR  near-tip matured signet block hash (REFLECTION=1 only)
optional knobs (defaults shown in the playbook):
  SEPOLIA_RPC, REFLECTION, MAX_PARALLEL, REUSE_MANIFEST, ALLOW_DIRTY,
  REFLECTION_CONFIRMATIONS, MEMPOOL_API
EOF
    exit 1
  fi
}

# Resolve the deployment manifest path. Live deploy writes contracts/deployments/<chainid>.json; in dry-run
# we use the default Sepolia chainid so the validate/plan steps can read an existing manifest if present.
manifest_path() {
  local chainid="$CHAINID_DEFAULT"
  if [ "$DRY_RUN" != "1" ]; then
    chainid="$(cast chain-id --rpc-url "$SEPOLIA_RPC")"
  fi
  echo "contracts/deployments/$chainid.json"
}

# ── dry-run path: plan + validate, no broadcast ──────────────────────────────
if [ "$DRY_RUN" = "1" ]; then
  phase "DRY RUN — orchestrator plan + bootstrap validate (no broadcast)"

  phase "orchestrator plan (DAG + schedule + coverage)"
  MAX_PARALLEL="$MAX_PARALLEL" node tests/run-v1-testnet.mjs

  phase "fund-wallets plan"
  node tests/v1-fund-wallets.mjs eth

  local_manifest="$(manifest_path)"
  if [ -f "$local_manifest" ]; then
    phase "day-1 bootstrap validate ($local_manifest)"
    node tests/v1-day1-bootstrap-signet.mjs "$local_manifest"
  else
    phase "day-1 bootstrap validate — skipped (no $local_manifest yet; produced by the live deploy)"
  fi

  echo
  echo "DRY RUN OK — plan valid, coverage complete. set DRY_RUN=0 (+ the live env) for the real rehearsal."
  exit 0
fi

# ── live path: full sequence ─────────────────────────────────────────────────
preflight

MANIFEST="$(manifest_path)"
export SEPOLIA_RPC FUND_PK

phase "1/5 deploy the suite"
if [ "${REUSE_MANIFEST:-0}" = "1" ] && [ -f "$MANIFEST" ]; then
  echo "REUSE_MANIFEST=1 and $MANIFEST exists — skipping deploy"
else
  REFLECTION="$REFLECTION" SEPOLIA_RPC="$SEPOLIA_RPC" contracts/deploy-v1-suite-testnet.sh
fi
[ -f "$MANIFEST" ] || { echo "deploy did not produce $MANIFEST"; exit 1; }

DEPLOY_BLOCK="$(jq -r '.deployBlock // empty' "$MANIFEST")"

phase "2/5 sync dapp + worker config"
node tools/sync-deployment-config.mjs "$MANIFEST" --network signet \
  ${DEPLOY_BLOCK:+--deploy-block "$DEPLOY_BLOCK"} --write

phase "3/5 fund the run wallets"
MODE=live FUND_PK="$FUND_PK" SEPOLIA_RPC="$SEPOLIA_RPC" node tests/v1-fund-wallets.mjs eth

phase "4/5 day-1 bootstrap (liquidity + farms)"
MODE=live node tests/v1-day1-bootstrap-signet.mjs "$MANIFEST"

phase "5/5 orchestrated test matrix (live)"
MODE=live MANIFEST="$MANIFEST" MAX_PARALLEL="$MAX_PARALLEL" node tests/run-v1-testnet.mjs

echo
echo "==== rehearsal complete — manifest: $MANIFEST ===="
echo "next: readiness-gate.sh (POOL + BRIDGE + DAY1) green, then the gate flip per playbook §7."
