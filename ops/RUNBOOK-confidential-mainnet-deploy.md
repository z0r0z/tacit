# RUNBOOK — Confidential pool + bidirectional bridge on Ethereum mainnet

The mainnet deployment is the Sepolia pilot's pattern (see `RUNBOOK-confidential-pool-deploy.md`) pointed at
**Ethereum mainnet + Bitcoin mainnet**, with three things the pilot didn't need: a reflection-guest
**re-anchor + re-prove**, the deploy script's **mainnet hardening gates**, and **real-ETH funding**. tETH +
TAC come on under their real etch ids via `attest_meta` (`PLAN-teth-confidential-onboarding.md`).

Verify-by-construction trust root is unchanged: SP1 + the immutable Groth16 leaf + Bitcoin PoW + the
Ethereum sync committee. No admin/oracle on the verify path.

---

## 0. The one non-mechanical prerequisite — re-anchor the reflection guest

The current Sepolia E2 reflection vkey `0x008c9fa6` pins the eth-reflection **genesis sync-committee anchor**
`0x8a83…` = **Sepolia** finalizedSlot 10462624. helios bootstraps from a chain-specific weak-subjectivity
checkpoint, so an eth-reflection proof produced on **Ethereum mainnet** carries mainnet's sync-committee
root — the Sepolia-anchored guest would reject it. So the Sepolia reflection guest **cannot be reused on
mainnet**.

Required, in one coordinated re-prove (the box step; correctness, not convenience):
1. Re-anchor `eth-reflection` to Ethereum mainnet's weak-subjectivity checkpoint (new `GENESIS_SLOT` + the
   mainnet `prevSyncCommitteeRoot`), rebuild → **new `ETH_REFLECTION_VKEY`**.
2. Rebuild the Bitcoin reflection guest (it pins `ETH_REFLECTION_VKEY` + the anchor) → **new
   `BITCOIN_RELAY_VKEY`**. Regenerate `ConfidentialReflectionProofReal` + `elf-vkey-pin.json`
   (`bitcoin_relay_vkey` + the `FROZEN_*` drift guards + the readiness-gate allowlist), all in one commit.
- **`PROGRAM_VKEY` starts from the current pinned settle vkey (`0x005c8a3d`)**, but derive it from the same
  canonical box bundle: if the mainnet source snapshot changes settle code, rotate and re-pin it in the
  same commit as the reflection leg. Deploy mainnet with the re-anchored `BITCOIN_RELAY_VKEY` and the
  reconciled `PROGRAM_VKEY`.
- (Alternative, if the reverse bridge isn't wanted at launch: a forward-only Mode-A reflection guest with no
  `verify_sp1_proof` — also a re-prove, also a new reflection vkey. Mode B is the recommended path so
  ETH→BTC works day one.)

---

## 1. Inputs (mainnet)

| arg | value | note |
|---|---|---|
| `PROGRAM_VKEY` | current pinned settle vkey (`0x005c8a3d…` unless the mainnet bundle rotates it) | settle guest; script cross-checks `elf-vkey-pin.json` |
| `BITCOIN_RELAY_VKEY` | the **re-anchored** reflection vkey (§0) | must == pin `bitcoin_relay_vkey` |
| `SP1_VERIFIER` | Succinct's **mainnet** `SP1VerifierGroth16` immutable leaf | NOT the gateway; obtain its address + `extcodehash` |
| `EXPECTED_VERIFIER_CODEHASH` | the leaf's codehash | **REQUIRED on chainid 1** (ctor + script enforce) |
| `EXPECTED_CHAIN_ID` | `1` | fail a wrong-network broadcast |
| `CANONICAL_FACTORY` | a freshly deployed `CanonicalAssetFactory` on mainnet | the tETH/TAC mint seam |
| `HEADER_RELAY` | a freshly deployed `BitcoinLightRelay` (Bitcoin mainnet) | §2 |
| `GENESIS_REFLECTION_ANCHOR` | the relay's tip at activation (Bitcoin mainnet, internal-LE) | **near the matured tip — §3** |
| `REFLECTION_CONFIRMATIONS` | `6` | reorg/finality window |
| `ACK_REFLECTION_ANCHORED` | `1` | acknowledges the deep-reorg + relay-liveness posture |

Keys / funding (real ETH):
- **Deployer** — funded mainnet key for the factory + relay + pool deploys (~0.05–0.1 ETH at sane gas).
- **Reflection + settle relayer** — the box key; funds attests + settles. Keep it on the box
  (`/root/loop-state/.ethpk` pattern); since `advanceTip` is permissionless, the relay-advancer can be a
  separate gas-only key.

---

## 2. BitcoinLightRelay (Bitcoin mainnet)

Deploy a fresh `BitcoinLightRelay` and `genesis()` it at a **retarget-safe, near-tip** Bitcoin-mainnet block
(deployer-only; the anchor must sit in-epoch, `epochStart % 2016 == 0`, with the epoch-start block's real
timestamp). Then `advanceTip` to the current tip (permissionless). Do NOT reuse the deprecated tETH relay
`0x45AA7939…` (it's 880+ blocks stale and on a wind-down path) — a clean near-tip relay avoids any bootstrap
catch-up.

Cadence: re-enable the `advance-mainnet` job (set `RELAY_PK_MAINNET` / `RELAY_ADDRESS_MAINNET` /
`ETH_RPC_MAINNET`, flip its `if` back to schedule) **or** run advance from the box; call `retarget()` at each
2016-block boundary or the tip stalls.

---

## 3. ⚠ Near-tip anchor + continuous attest — mandatory on mainnet

Same rule as the pilot, but the stakes are higher: **Bitcoin mainnet blocks are full (~2–4k txs each)**, so a
genesis-anchor-to-matured-tip gap of even a few blocks is a multi-thousand-tx full-scan that will exhaust a
24 GB GPU. Therefore:
- Deploy `GENESIS_REFLECTION_ANCHOR` at the **live matured relay tip** (`RELAY.tip() − REFLECTION_CONFIRMATIONS`).
- Stand up the reflection loop and **attest from the first block** — 1–few-block batches, ~minutes each.
- Never let the anchor→tip gap grow before the first attest. (If it ever does, an 80 GB GPU or a fresh
  near-tip redeploy is the only out — see the pilot runbook's launch rule.)

---

## 4. Deploy sequence

```
cd contracts
# a) factory
forge create src/CanonicalAssetFactory.sol:CanonicalAssetFactory --rpc-url $ETH_MAINNET --private-key $PK --broadcast
# b) relay: forge create BitcoinLightRelay, then cast send genesis(...) at the near-tip anchor, then advance to tip
# c) pool
SP1_VERIFIER=<mainnet groth16 leaf> EXPECTED_VERIFIER_CODEHASH=<leaf codehash> EXPECTED_CHAIN_ID=1 \
BITCOIN_RELAY_VKEY=<re-anchored reflection vkey> CANONICAL_FACTORY=<factory> HEADER_RELAY=<relay> \
GENESIS_REFLECTION_ANCHOR=<relay tip, internal-LE> ACK_REFLECTION_ANCHORED=1 \
  forge script script/DeployConfidentialPool.s.sol --rpc-url $ETH_MAINNET --private-key $PK --broadcast --verify
```
`PROGRAM_VKEY` defaults to the pinned `0x005c8a3d`; the script reverts on a pin mismatch and on a missing
`EXPECTED_VERIFIER_CODEHASH` at chainid 1.

---

## 5. Reflection loop (the box, mainnet)

Two-stage Mode B prove (`RUNBOOK-confidential-pool-deploy.md` §"Proven manual pipeline"), repointed at mainnet:
- **eth_prove**: `SOURCE_CONSENSUS_RPC=<Ethereum mainnet beacon API>`, `SOURCE_CHAIN_ID=1`,
  `GENESIS_SLOT=<mainnet weak-subjectivity slot>` (the §0 anchor), `POOL=<mainnet pool>`.
- **bitcoin_prove**: the batch fixture from `scripts/build-reflection-bootstrap-fixture.mjs` pointed at a
  **Bitcoin mainnet** esplora (`SIGNET_API=https://mempool.space/api`), small near-tip ranges.
- **attest**: `cast send attestBitcoinStateProven(bytes,bytes)` from the relayer.
- Box hygiene: fresh `sp1-gpu-server` per prove; the box runs the committed canonical ELFs (the re-proven
  mainnet ones), never a rebuild.

Run it continuously (small batches) so the Bitcoin pool root stays canonical + current.

---

## 6. Post-deploy — assets + wiring

1. **cETH** (native ETH escrow): `registerWrapped(address(0), 1, 0, "Confidential ETH", "cETH", 18)`.
2. **tETH** under id `3cba71e1…`: reflect the etch block, then `OP_ATTEST_META` → `_autoRegisterFromMeta`
   registers it + lazy-deploys the canonical ERC20 + binds `localAssetOf[3cba71e1…]`
   (`PLAN-teth-confidential-onboarding.md`).
3. **TAC** under its real Bitcoin etch id: same `attest_meta` path once its etch block is reflected.
4. **dapp/worker**: add a `mainnet` entry to `CONFIDENTIAL_POOL_UX` + `CONFIDENTIAL_POOL_DEPLOYMENTS`
   (pool, deployBlock); repoint the settle box scripts; deploy dapp + `tacit-api`.
5. **Verify the seams** (read-only): `PROGRAM_VKEY`/`BITCOIN_RELAY_VKEY`/`SP1_VERIFIER` == intended,
   `knownReflectionDigest` == the prover genesis digest, `CANONICAL_FACTORY` set, one attest lands and
   advances the digest chain.

---

## 7. Go-live posture

- Start **capped** (small per-deposit + total backing limits), widen as the loop proves itself live.
- Residuals are operational, accept-and-document (as on the tETH bridge / AMM): a Bitcoin reorg deeper than
  `REFLECTION_CONFIRMATIONS`, and relay/prover liveness.
- Rollback: the contracts are immutable; "rollback" = stop attesting + pause front-end exposure. Funds in
  escrow-backed lanes (cETH) are bounded to deposits; the digest chain bars stale-state replay.

---

## Pre-deploy checklist
- [ ] Reflection guest re-anchored to Ethereum mainnet + re-proven; new `BITCOIN_RELAY_VKEY` pinned in
      `elf-vkey-pin.json` (+ drift guards + allowlist) in one commit; `ConfidentialReflectionProofReal` green.
- [ ] Mainnet `SP1VerifierGroth16` leaf address + codehash obtained; `EXPECTED_VERIFIER_CODEHASH` set.
- [ ] `CanonicalAssetFactory` deployed on mainnet.
- [ ] `BitcoinLightRelay` deployed + genesis at a retarget-safe near-tip + advanced to tip.
- [ ] Deployer + relayer funded with real ETH.
- [ ] Box: re-proven canonical ELFs in place; eth_prove pointed at the mainnet beacon; bitcoin_prove at
      Bitcoin-mainnet esplora; gpu-server healthy.
- [ ] Deploy with near-tip `GENESIS_REFLECTION_ANCHOR`; attest from block one (continuous, small batches).
