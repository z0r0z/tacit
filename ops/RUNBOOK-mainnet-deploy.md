# tETH bridge — mainnet deploy runbook

End-to-end ops procedure for promoting the bridge from signet pilot to
Bitcoin/Ethereum mainnet. Covers pre-deploy preflight, the deploy itself,
and the post-deploy gates the audit asks be cleared before admitting
real value.

## 0. Prerequisites

- `DEPLOYER_PRIVATE_KEY` mainnet-funded with **~0.15 ETH** (current
  deploy gas estimate plus headroom).
- `MAINNET_RPC` set to a reliable Ethereum mainnet endpoint
  (Alchemy/Infura/QuickNode etc).
- Local `bitcoin-cli` access (Bitcoin Core full node) for fetching
  cumulative chainwork. The mempool.space API does not expose it.
- The current branch is **clean** under `git status --porcelain` for
  the bridge source files. `deploy-mainnet.sh` refuses a dirty tree
  unless `ALLOW_DIRTY_DEPLOY=1` is set (don't override).
- CI is green on `main`:
  - `canonical-elf.yml` (Docker rebuild matches pinned ELF byte-for-byte).
  - `bridge-guards.yml` (Groth16VerifierReal + BridgeWithdrawRealProof +
    ceremony-vk-pin + ELF-vkey-pin + SP1 tree crate tests + T3-03
    invariants).

## 1. Cumulative chainwork

`BTC_TIP_WORK` is the only mandatory env that `deploy-mainnet.sh` cannot
derive — it requires a Bitcoin Core node.

```bash
# Pick the anchor (tip - 6 for stability; the wrapper does the same):
BTC_TIP_HEIGHT=$(bitcoin-cli getblockcount)
ANCHOR_HEIGHT=$((BTC_TIP_HEIGHT - 6))
ANCHOR_HASH=$(bitcoin-cli getblockhash $ANCHOR_HEIGHT)
CHAINWORK_HEX=$(bitcoin-cli getblockheader $ANCHOR_HASH | jq -r .chainwork)
BTC_TIP_WORK=$(python3 -c "print(int('0x${CHAINWORK_HEX}', 16))")
echo "BTC_TIP_WORK=$BTC_TIP_WORK"
```

A low/wrong baseline lets an attacker submit a competing chain with
**higher** cumulative work to advanceTip; for mainnet difficulty the
honest tip's chainwork is the only safe baseline.

## 2. Sensitive env

Source these from the canonical references (the wrapper requires every
one of them — no defaults for fund-critical values):

| Env | Source |
|---|---|
| `TETH_ASSET_ID` | Production tETH asset id (etched on Bitcoin mainnet — confirm before deploy) |
| `SP1_VERIFIER` | Succinct's deployed Groth16 gateway on Ethereum mainnet |
| `BURN_VERIFIER` | The ceremony-key Groth16Verifier (deploy from in-repo source if not yet deployed) |
| `SP1_PROGRAM_VKEY` | `contracts/sp1/elf-vkey-pin.json` → `program_vkey` (wrapper cross-checks) |
| `GROTH16_VK_HASH` | `contracts/sp1/elf-vkey-pin.json` → `groth16_vk_hash` |
| `POSEIDON_T3` | Default `0x3333333c0a88f9be4fd23ed0536f9b6c427e3b93`; wrapper cast-codes to confirm |

## 3. Deploy

```bash
cd contracts
DEPLOYER_PRIVATE_KEY=... \
MAINNET_RPC=https://... \
TETH_ASSET_ID=0x... BURN_VERIFIER=0x... SP1_VERIFIER=0x... \
SP1_PROGRAM_VKEY=0x... GROTH16_VK_HASH=0x... \
BTC_TIP_WORK=<from step 1> \
bash deploy-mainnet.sh
```

The wrapper does:
- `eth_chainId == 1` sanity-check the RPC.
- Refuse dirty bridge-source tree.
- Run `verify-vkey-pin.sh` (committed ELF sha256 == pin).
- Refuse if `SP1_PROGRAM_VKEY` env ≠ `elf-vkey-pin.json:program_vkey`.
- `cast code` preflight that PoseidonT3 has bytecode at the expected
  address (a wrong/missing PoseidonT3 silently desyncs deposit/withdraw
  hashing on the immutable mixer).
- Fetch BTC anchor (tip - 6) + derive LITTLE-ENDIAN tip hash, epoch
  start, target, timestamp (the wrapper handles the byte-order trap
  that bricked the earlier signet redeploy — see commit history).
- Broadcast `Deploy.s.sol` with `--libraries
  src/lib/PoseidonT3.sol:PoseidonT3:${POSEIDON_T3}`.

Addresses land in `broadcast/Deploy.s.sol/1/run-latest.json`.

The mixer constructor cross-checks (`TacitBridgeMixer:178-186`, audit
blocker #3) that the bound verifier's `denominations(i)` matches the
mixer's `denominations_[i] / UNIT_SCALE` at every index. A
denomination-order divergence between the two constructors will fail
loud at deploy — *not* a runtime surprise. Soft-skip when the verifier
returns 0 (test mocks); a real `SP1PoolRootVerifier`'s denominations()
is non-zero by construction.

## 4. Post-deploy validation (BEFORE admitting value)

### 4.1 Cross-check on-chain bytecode

```bash
MIXER=<from broadcast/run-latest.json>
VERIFIER=<...>
RELAY=<...>

# Mixer should link to the canonical PoseidonT3
cast call $MIXER 'POSEIDON_T3()(address)' --rpc-url $MAINNET_RPC \
  | grep -i "${POSEIDON_T3:2}" || echo "MISMATCH — abort"

# Verifier's PROGRAM_VKEY matches the canonical pin
PIN=$(jq -r .program_vkey contracts/sp1/elf-vkey-pin.json)
ONCHAIN=$(cast call $VERIFIER 'PROGRAM_VKEY()(bytes32)' --rpc-url $MAINNET_RPC)
[ "$ONCHAIN" = "$PIN" ] || echo "VKEY MISMATCH — abort"
```

### 4.2 Cross-check ceremony VK in the burn verifier

`BURN_VERIFIER` is **not** cross-checked against `GROTH16_VK_HASH`
on-chain. Verify by hand:

```bash
# Compare the deployed Groth16Verifier's vk constants to the ceremony key.
# Use tests/ceremony-vk-pin.test.mjs targeting the live BURN_VERIFIER
# (extend its CLI args to accept a custom address).
node tests/ceremony-vk-pin.test.mjs --verifier $BURN_VERIFIER --rpc $MAINNET_RPC
```

A wrong `BURN_VERIFIER` makes the mixer accept any burn proof —
existential drain. **Do not proceed without this check passing.**

### 4.3 First retarget advance (audit 🟡 should-fix)

`startTimestamp` passed at genesis must be the timestamp of the first
block in the genesis epoch (height % 2016 == 0). `deploy-mainnet.sh`
derives this correctly, but a wrong value only surfaces at the **first
2016-block retarget** as a hard-to-diagnose `UnknownEpoch` /
`InvalidPoW` freeze on the immutable relay (no recovery).

Before admitting value, advance the prover across one real retarget on
mainnet (~2 weeks at 10-min blocks). Confirm `pendingEpochTs` /
`epochStartTimestamp` populate as expected.

If you can't wait 2 weeks: replay the genesis epoch's first block's
timestamp on a fresh test deploy + watch the retarget transition on a
disposable instance first.

### 4.4 Pool-tree capacity gate (audit blocker #3)

`TacitBridgeMixer.deposit()` rejects when
`verifier.lastProvenPoolIndex(denomIdx) + POOL_TREE_RESERVE >= MAX_LEAVES`
(`POOL_TREE_RESERVE = 1024`, `MAX_LEAVES = 2²⁰`). This closes the
rotate-DoS path where an adversary fills the SP1 pool tree off-chain
via 0x62 rotates and leaves honest deposits to lock ETH on a mint the
guest silently can't insert. `lastProvenPoolIndex` is populated from
the SP1-authenticated public-values tail (see
`SP1PoolRootVerifier:247-255`).

Smoke-test at deploy:

```bash
# Right after the first prover cycle lands, all denoms should read 0.
for i in 0 1 2 3 4 5 6 7; do
  echo "denom $i: $(cast call $VERIFIER 'lastProvenPoolIndex(uint8)(uint64)' $i --rpc-url $MAINNET_RPC)"
done
```

If any denom returns a value near `MAX_LEAVES - POOL_TREE_RESERVE` on a
fresh deploy, the SP1 host's tail emission is corrupted and the gate
will reject legit deposits — abort + investigate before admitting value.

### 4.5 PoseidonT3 hashing parity

Run a deposit + tree-build round-trip locally and cross-check the
on-chain `getPoolRoot` matches the dapp's `computePoolRoot`. The bridge
tests (`tests/bridge-3a.mjs`'s deposit step) already do this — point
them at the mainnet mixer and verify ✓ before any user deposit.

## 5. Single-prover bootstrap

The deployed verifier expects proofs from any prover with the canonical
ELF (`PROGRAM_VKEY` matches). For v1 launch we operate the initial
prover:

1. Set up the box (a vast.ai instance per `scripts/vastai-setup.sh` or
   equivalent; CPU is sufficient for low traffic, ~50 min/proof on the
   tested 504GB-mem box).
2. Build the host once: `cd contracts/sp1/script && cargo build --release`.
3. Write `/workspace/prover.env` with the new mainnet addresses, the
   pinned ELF's `GENESIS_ANCHOR` (LE format — same as `BTC_TIP_HASH`),
   `BLOCKS_PER_PROOF`, `WORKER_BASE`, etc.
4. Launch via `bash /workspace/run-prover.sh` (the supervised wrapper
   sources `prover.env` + `.ethpk` then runs `sp1-prover-loop.sh` in a
   restart loop).

The prover script now:
- Fetches CXFER openings from the worker for the block range before
  each cycle (`fetch-cxfer-openings.py` → `CXFER_WITNESSES_PATH`).
- Loads `STATE_FILE` if present + matching verifier state (incremental
  prev_state; otherwise falls back to genesis/empty-pools).
- After a successful prove + on-chain submission, the host parses the
  SP1-authenticated state tail from `public_values` and persists it
  to `STATE_FILE` atomically (tmp + rename).

## 6. Monitoring

Minimum signals:

- `cast call $VERIFIER 'currentState()(bytes32,bytes32,uint64,bytes32)' --rpc-url $MAINNET_RPC`
  — should advance with each cycle (~50 min on CPU + signet cadence
  for mainnet ~10 min blocks → batch-behind tip is normal).
- `cast call $RELAY 'tipHeight()(uint256)' --rpc-url $MAINNET_RPC` —
  catches up with Bitcoin's tip; advances on each `advanceTip` call.
- `cast call $MIXER 'totalBalance()(uint256)' --rpc-url $MAINNET_RPC`
  — never decreases more than the latest `Withdrawal` event sum.
- Prover process: `tmux ls`, `ps -p $(pgrep teth-prover)`. RSS in the
  60-100 GB range during gnark wrap is normal.

Failure modes + recovery:
- **Prover stuck > 90 min on gnark wrap**: kill + restart (`tmux
  kill-session -t prover`); host loads `STATE_FILE` cleanly.
- **`advanceTip` failure**: likely a reorg the relay rejects (heavier
  chain not seen yet) or stale headers; check `relay.tip()` vs BTC tip,
  re-fetch fresh headers.
- **Verifier rejects proof** (`StateMismatch` / `NotRelayTip` / etc.):
  diagnose via `print_public_values` output in the prover log. A
  `StalePrevBlock` is recoverable within `FINALITY_WINDOW=6`; a
  `StateMismatch` means the saved STATE_FILE is stale — delete it and
  let the host fall back to verifier-only reconstruction (empty pools
  path; only works while no activity has hit the verifier).
- **Deep reorg (> 6) orphans state**: explicitly accepted v1 risk per
  user — bridge halts, requires fresh redeploy + re-prove (this runbook
  from §1).

## 7. Audit acceptance log (mainnet readiness as of last commit)

| Audit item | Status |
|---|---|
| #1 G2 swap | ✅ committed + CI gate |
| #2 reorg finality window + sync-gate | ✅ FINALITY_WINDOW=6 + per-pool root |
| #3 pool-tree exhaustion | ✅ active gate: mixer.deposit() queries verifier.lastProvenPoolIndex; rejects within POOL_TREE_RESERVE (1024) of 2²⁰ |
| #4 vkey↔ELF canonical | ✅ Docker reproducible + CI gate |
| #5 omitted-leaf | ✅ per-pool + aggregate, on burn + export + rotate |
| #6 dapp rotate/import dispatch | ✅ in tree |
| #7 T5 export→CXFER→withdraw | ⚠ wired + all 5 bridge ops on Taproot reveal (mainnet-relayable); awaiting one live signet round-trip of the full Alice→Bob→withdraw flow before it's a mainnet capability |
| #7 CI cargo test | ✅ |
| #8 atomic fail-closed mainnet deploy | ✅ + chainid + vkey-pin + PoseidonT3 link + cast-code preflight |
| WD-3 burn solvency pre-check | ✅ |
| BIND-01 non-reducing serializer | ✅ |
| RELAY-3 header timestamp validation | ✅ |
| BTC-1/2 64-byte-tx reject + coinbase invariant | ✅ |
| T3-03 denom-bound nullifier | ⚠ requires new ceremony; CI pins fresh-preimage + global null_set invariants |
| Prover incremental state | ✅ load + save + script wiring |
| 🟡 genesis startTimestamp consistency | ⚠ check during §4.3 (deploy-time runbook) |
| 🟡 retarget timespan underflow | ⚠ accepted; fails closed under 2-week MTP |

## 8. Round-trip validation gates (run on signet before promoting artifacts)

Both must pass on signet before the same artifacts are promoted to mainnet
(supersedes the standalone audit-readiness runbook; the accepted-risk items it
listed are now implemented gates — see #2/#3 above).

**8a. Definitive deploy test — one real `withdrawFromBurn`.** Proves the G2 fix +
real verifier + re-proven state line up on-chain. Deposit one whole denomination
(e.g. 0.001 ETH) → broadcast the `0x60` mint → wait for the prover to accept it
(`stateHeight`/`poolsHash` advance) → burn (`0x61`) → wait for `isAcceptedBurn(claimId)`
→ `withdrawFromBurn` (`bridgeWithdrawETH`) after ≥6 confirmations. **It must release
exactly the denomination to the recipient.** `InvalidGroth16Proof` ⇒ wrong G2 order
(re-check deploy); `UnprovenRoot` ⇒ prover hasn't accepted the burn.

**8b. T5 fractional round-trip (Alice→Bob 0.1) — gates the dapp send.** A deposits
1 ETH (mint accepted) → in the Send box, recipient = B's pubkey, amount `0.1`
routes to `bridgeSendFractional`: EXPORT (`0x63`) the 1-ETH note → CXFER-split 0.1
to B + 0.9 change to A. B "Recover Notes" discovers the 0.1 from B's key alone →
redeems via `bridgeQuickBurnFromHoldings(0.1)` → import (`0x64`) → burn (`0x61`) →
`withdrawFromBurn` → **0.1 ETH to B**. Conservation: A locked 1, B redeemed 0.1, A
holds 0.9 redeemable; no escrow negative; total released ≤ deposited.
