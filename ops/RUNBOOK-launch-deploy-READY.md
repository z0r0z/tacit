# V1 launch deploy — READY (2026-07-13)

Everything below is done, committed, and green. This is the one remaining step: the mainnet broadcast,
which YOU run from the deployer key `0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7` (I don't hold it).

## Pre-broadcast state (all committed)
- Commits: `6be97d8`, `757bc6b`, `6864620`, `5208dc6` (all as z0r0z). 791 forge tests green.
- Reflection reproved: `bitcoin_relay_vkey = 0x000240e5…`, verified on-chain (ConfidentialReflection[BurnDeposit]ProofReal).
  `program_vkey = 0x0093404c…` (settle, unchanged). Genesis digest rotated to `0xe9e59ecb…` (in the contract + KATs).
- Pool 23,653 B → +523 with the quote views; under EIP-170.
- Vanity salts: `contracts/deployments/vanity-salts-launch-permissioned.env` — PERMISSIONED (bound to the deployer,
  front-run-proof), all 7 verified against `predict()`.

## Verified launch addresses (permissioned salts → these exact addresses)
| contract | address |
|---|---|
| POOL | `0x000000000013f1c523585cd98e527c7f9285a21c` |
| FACTORY | `0x0000000000ef2a407a4e63cad0294888b124e3bf` |
| ENGINE | `0x000000000049f0912cecca72512dc9f66b7b4af8` |
| ADAPTER | `0x0000000000d7dedfa8ccc94169573ade94e040a2` |
| ROUTER | `0x0000000000c132b5f37cc579b800bd939521447e` |
| RELAYER | `0x000000000059a74ff8f88cd5dc2a77ed94084ed9` |
| BTC_CALL_EXECUTOR | `0x000000000027058a780bc4e68b6fd90f6789d8c9` |

(These SUPERSEDE the current live `deployments/1.json` pool `0x…f88564…` — a fresh immutable pool at a new address.)

## Broadcast (from the deployer EOA)
```bash
cd contracts
source deployments/vanity-salts-launch-permissioned.env   # SALT_POOL … bound to 0x68575B…

# fail-closed preflight (must be green)
READINESS_STRICT=1 bash sp1/confidential/readiness-gate.sh
VERIFY_VKEY_STRICT=1 bash sp1/confidential/verify-vkey-pin.sh

# deploy (broadcaster MUST be 0x68575B…; the script re-verifies each address == predict() and reverts on mismatch)
forge script script/DeployV1SuiteCreateX.s.sol \
  --rpc-url "$MAINNET_RPC" --private-key "$DEPLOYER_PK" --broadcast --verify
```
Notes: mainnet requires ENGINE_ADMIN == the ops multisig `0x006CD14F…` (script-checked); it writes the manifest
(`deployments/1.json`) on success. Confirm the printed pool address == `0x000000000013f1c5…` before/after.

## After broadcast
1. Update `deployments/1.json` + `docs/DEPLOYMENTS.md` together (new addresses + `bitcoinRelayVkey 0x000240e5…` +
   genesis digest `0xe9e59ecb…`; `programVkey`/`ethReflectionVkey` unchanged).
2. Bootstrap reflection (first attest), then a two-way round-trip (BTC→ETH forward + ETH→BTC Mode-B) with an
   interleaved cross-out from a second party — confirming forward reflection is not stalled and Mode-B completes.
3. Point the dapp/worker config at the new pool.

## Boxes
Prover/mining boxes powered down to save credits (reprove + mining are complete; artifacts pulled + committed).
Resume only if a re-prove is needed (it isn't for this launch).
