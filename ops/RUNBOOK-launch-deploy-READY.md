# V1 launch deploy — runbook

The mainnet broadcast runs from the deployer EOA `0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7`.

**This is NOT ready to broadcast today.** Two things stand between here and a deploy, and they are ordered:
the outbox salt must be mined before the ELF build, and the guests must be re-proven. Everything else below
is a gate that mechanically checks one of them. Read the ordering section before touching anything.

## Where the tree actually stands

- Solidity: 867/868 forge tests green. The one failure is `ConfidentialLpBondProofReal` — a real-proof
  fixture that went stale when the lp-bond bonder-signature check landed; it regenerates at the re-prove.
- Rust: 203/203 `cxfer-core`, including guest↔JS parity, BP/BP+ adversarial, and the attacker-facing
  Bitcoin/provenance parser panic-freedom sweep.
- Guest SOURCE carries the whole round-6 hardening round: C-01 generation-bound notes and the settle-side
  fast-lane containment, H-01 fee accounting, H-02 POOL_INIT founder refund, M-01 funding binding plus
  refund-on-race, and the D1/D2 worker↔dapp kernel-parity fixes.
- Guest BINARIES do not. `elf/cxfer-guest` was built 2026-07-23; the consensus source has moved ~69 commits
  since. **The committed ELFs do not contain the fixes above.** `verify-vkey-pin.sh` now says so out loud.

## ORDERING — these two steps cannot be swapped

### 1. Mine `SALT_ETH_CALL_OUTBOX` (before any ELF build)

`EthCallOutbox` is pinned BY ADDRESS inside both the eth-reflection and Bitcoin reflection guests
(`reflect.rs`, currently the all-zero placeholder `ETH_CALL_OUTBOX: [u8; 20] = [0u8; 20]`). CREATE3 makes
the address a pure function of the salt, independent of init code, which is the only reason it can be
pinned before the contract exists. Mining it AFTER the re-prove costs an ELF rebuild and a second re-prove.

    salt mined + frozen -> address predicted -> pinned in both guests -> ELF build -> re-prove -> deploy

Mine it in the same permissioned form as the other 7 (`salt[0:20] == 0x68575B07…`) via
`tools/mine-vanity-salts.sh`, paste into `deployments/vanity-salts-launch-permissioned.env`, and fill the
address table below.

### 2. Re-prove all three guests, in lockstep

Rebuilding the eth-reflection ELF rotates its recursion digest, which the reflection guest embeds as
`ETH_REFLECTION_VKEY`. The four pinned constants — `ETH_REFLECTION_VKEY`, `ETH_GENESIS_SYNC_COMMITTEE`,
`BATCH_VK_SHA256`, and the outer reflection vkey/ELF — must all come from ONE prover-host checkpoint. A
partial rotation is fail-closed at run time but painful to diagnose, so it is caught before deploy:

    bash contracts/sp1/confidential/verify-lockstep-pins.sh            # asserts all four are one set
    bash contracts/sp1/confidential/verify-lockstep-pins.sh --record   # after a rotation, same commit

The re-prove also regenerates the stale `ConfidentialLpBondProofReal` fixture and lands the deferred
DIGEST_MATCH validations. Update `elf-vkey-pin.json` (both sha256s, both vkeys, `lockstep_checkpoint`,
`guest_state`) and `DeployConfidentialPool`'s `DEFAULT_VKEY` in the SAME commit as the ELFs.

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
| ETH_CALL_OUTBOX | **not yet mined — see step 1** |

These SUPERSEDE the live `deployments/1.json` pool: a fresh immutable pool at a new address.

## Pre-broadcast battery

Run the whole thing on the box (not a laptop) and require GREEN:

```bash
bash ops/box-confidence.sh
```

Phase 0 is the one that matters for a deploy: it runs `verify-vkey-pin.sh` in STRICT mode plus the
lockstep gate, so it fails if the ELFs are uncommitted, disagree with their pins, are older than the guest
source, or the four constants are not from one rotation. Phases 1–4 (forge, cargo, the reflection
DIGEST_MATCH board, the JS mirror suite) all test SOURCE; phase 0 is what tests the artifact that ships.

## Broadcast

```bash
cd contracts
source deployments/vanity-salts-launch-permissioned.env   # SALT_POOL … bound to 0x68575B…

# fail-closed preflight (both must be green)
READINESS_STRICT=1 bash sp1/confidential/readiness-gate.sh
VERIFY_VKEY_STRICT=1 bash sp1/confidential/verify-vkey-pin.sh

forge script script/DeployV1SuiteCreateX.s.sol \
  --rpc-url "$MAINNET_RPC" --private-key "$DEPLOYER_PK" --broadcast --verify
```

Mainnet requires `ENGINE_ADMIN` == the ops multisig `0x006CD14F…` (script-checked). The script re-verifies
each address against `predict()` and reverts on mismatch, and writes `deployments/1.json` on success.
Confirm the printed pool address matches the table before and after.

## After broadcast — cold-start ordering is load-bearing

**Seed the fast-lane consume counter BEFORE opening the pool to anyone.**

`crossOut` bumps `crossOutCount` unconditionally, and a forward reflection batch commits `crossOutCount=0`,
so once `crossOutCount >= 1` every forward attest reverts `ConsumedCountStale` and only Mode-B can advance.
Mode-B's `eth_prove` inclusion-reads `bitcoinConsumedCount` and has no exclusion path for an unwritten slot.
So if that counter is still 0 when the first `crossOut` lands, reflection FREEZES — forward bridging past
that height, reverse bridging, and every reflection-dependent op — and only a fast-lane spend by a holder of
a note in the current reflected Bitcoin root recovers it. Any user holding a note can trigger this.

The counter is monotone, so one seed makes the freeze impossible on that pool forever. Seed it with a single
btcHomed fast-lane spend: a note live in the reflected Bitcoin root, spent on Ethereum. A bridge-MINTED note
is EVM-homed and will NOT seed it.

```bash
RPC=$MAINNET_RPC POOL=<new pool> bash ops/verify-coldstart-seeded.sh
```

Gate it until it PASSes, and only then allow `crossOut` or public access. (The gate resolves the slot from
the compiled layout — it has moved between generations, so do not hardcode it.)

Then, in order:
1. Update `deployments/1.json` + `docs/DEPLOYMENTS.md` together with the new addresses and the vkeys the
   re-prove produced. Do not copy the values from an older revision of this runbook; read them from
   `elf-vkey-pin.json` at the re-prove commit.
2. Bootstrap reflection (first attest), then run a two-way round-trip (BTC→ETH forward + ETH→BTC Mode-B)
   with an interleaved cross-out from a second party — confirming forward reflection is not stalled and
   Mode-B completes.
3. Confirm every superseded pool is inert: `bash ops/verify-predecessor-inert.sh`.
4. Point the dapp/worker config at the new pool. Worker reads `REFLECTION_CHAIN_BINDING` from env.

## Known-dormant this generation

`OP_SWAP_BLIND` (31) and `T_SWAP_BATCH` (0x2F) are HARD-DISABLED: both guest arms panic, so neither can be
proven at all. This retires the X-1 arming gate by construction — re-enabling them is a future guest that
must first pass the on-box ceremony-VK validation. Anything in the tree exercising those paths (including
the batch-clearing e2e scenarios) is dormant-path coverage, not launch-blocking.

## Boxes

Prover/mining boxes are powered down. Both must come back up for this launch: mining for step 1, proving
for step 2.
