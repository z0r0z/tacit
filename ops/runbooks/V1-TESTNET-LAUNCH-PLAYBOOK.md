# RUNBOOK — Tacit V1 Testnet Launch Playbook (Sepolia + Signet)

The single runnable sequence to stand up the full Tacit V1 suite on Sepolia + Signet, exercise every
day-1 flow, and produce the immutable mainnet candidate. It operationalizes the checklist in
`ops/CHECKLIST-sepolia-full-suite.md` into one timeline and is the **template for the mainnet deploy**
(swap the env — see §9). The legacy tETH bridge/mixer is **sunset** (recovery/migration only) and out of
scope; `TETH_DEPLOYMENTS.*.live` stays `false`.

Cross-references (authoritative, do not duplicate): `ops/CHECKLIST-mainnet-launch.md` (the four mainnet
gates), `ops/STATUS-confidential-system.md` (current pins), `ops/TRUST-REGISTER-production.md` (privileged
surfaces), `ops/PLAN-day1-assets-and-incentives.md` (assets/pools/airdrop), `ops/CHECKLIST-mainnet-reprove.md`
(the re-prove constants).

---

## 0. Preflight — coherence + readiness gate

- [ ] Clean tree on the launch branch; the committed guest ELF is the one that will be proven (§8).
- [ ] `bash contracts/sp1/confidential/verify-vkey-pin.sh` passes (ELF sha == pin; deploy DEFAULT_VKEY == pin).
- [ ] `bash contracts/sp1/confidential/readiness-gate.sh` — **POOL + DAY1 must be READY**; BRIDGE READY if
      cross-chain is in this launch. The new **DAY1 tier** gates the launch-asset engine (oracle / escrow /
      slash / CDP / cBTC lifecycle), the airdrop distributor, the orchestrated-suite rehearsal, the
      day-1 wired walkthrough, and the airdrop JS↔Solidity parity.
- [ ] Confirm `SP1_VERIFIER` for Sepolia is the **immutable SP1VerifierGroth16 leaf** (never the gateway).

## 1. Deploy the suite (one command)

```
DEPLOYER_PRIVATE_KEY=… SP1_VERIFIER=<sepolia leaf> \
  [REFLECTION=1 GENESIS_REFLECTION_ANCHOR=<near-tip matured signet block hash>] \
  contracts/deploy-v1-suite-testnet.sh
```

`script/DeployV1Suite.s.sol` deploys + wires, in the one order the immutable pool + engine↔pool circular
dep allow: CanonicalAssetFactory → ChainlinkEthBtcAdapter + CollateralEngine → ConfidentialPool (ctor pins
cBTC.tac + cUSD.tac + cETH) → `engine.setPool` → ownership handoff → ConfidentialRouter + TacitRelayer +
BtcCallExecutor → testnet 21M TAC etch + `registerWrapped` (cTAC) → the five TAC-centric pools → a cTAC
farm per pool. Writes `contracts/deployments/<chainid>.json`.

- `REFLECTION=0` (default): Ethereum-only bring-up — wrap/transfer/swap/LP/farm; cBTC mint dormant.
- `REFLECTION=1`: also deploys the signet relay (`DeployTestnetRelay`) and enables cBTC + cross-chain.

Choosing `GENESIS_REFLECTION_ANCHOR` (same rule as the mainnet runbook,
`ops/RUNBOOK-confidential-mainnet-deploy.md:61-63`): query the live signet tip, walk back
`REFLECTION_CONFIRMATIONS` (default 6) so the anchor is already matured, and pick that **in-epoch** block hash
(internal-LE) — never the first block of a 2016-block epoch. A near-tip anchor keeps the genesis→matured-tip
gap tiny so the first attest is a 1–few-block scan, not a multi-thousand-tx full scan:

```
H=$(curl -s https://mempool.space/signet/api/blocks/tip/height); A=$((H - 6))
GENESIS_REFLECTION_ANCHOR=$(curl -s "https://mempool.space/signet/api/block-height/$A")   # internal-LE hash
```

The deploy script (`deploy-v1-suite-testnet.sh`) then advances the relay tip until this anchor is matured
before printing success and syncing the dapp/worker config — see §3 for the standing advancer.

## 2. Wire the dapp + worker

```
node tools/sync-deployment-config.mjs contracts/deployments/<chainid>.json --network signet --deploy-block <N> --write
```

Patches `CONFIDENTIAL_POOL_DEPLOYMENTS` (worker indexer) + `CROSSLANE_DEPLOYMENTS` (dapp). It does **not**
flip any asset `live:true` — that is a deliberate gate (§7). Redeploy dapp + worker together.

## 3. Start services

- [ ] **Relay-header advancer (cross-chain only) — start FIRST and keep running.** `DeployTestnetRelay`
      only `genesis()`-es the relay at the anchor epoch; nothing advances the tip on its own. The pool's
      `_anchorReflection` (`contracts/src/ConfidentialPool.sol`) bars **every** `attestBitcoinStateProven`
      (and thus the whole cross-chain lane — bridge mint, reflection, Mode-B) with `UnanchoredReflection`
      until the relay tip walked back `REFLECTION_CONFIRMATIONS` (default 6) reaches
      `GENESIS_REFLECTION_ANCHOR`. So loop the advancer:

      ```
      while :; do
        ETH_RPC=$SEPOLIA_RPC RELAY_PK=$DEPLOYER_PRIVATE_KEY RELAY_ADDRESS=<relay from manifest deploy> \
          MEMPOOL_API=https://mempool.space/signet/api scripts/advance-relay.sh --count 20
        sleep 600   # ~one signet block; retarget at each 2016-block boundary (see below)
      done
      ```

      This is **distinct from the attest loop** (`ops/scripts/reflection-relay-loop.sh`), which only
      proves + submits attests — it does NOT advance headers. The deploy script (§1) does the initial
      maturity advance; this loop keeps the tip live afterward. When `advance-relay.sh` stops at an epoch
      boundary, run `scripts/retarget-relay.sh` once, then resume (signet retargets every 2016 blocks too —
      same cadence as the mainnet runbook, `RUNBOOK-confidential-mainnet-deploy.md:67-69`).
- [ ] **Confirm `RELAY.tip()` ≥ `GENESIS_REFLECTION_ANCHOR` height + `REFLECTION_CONFIRMATIONS`** before
      expecting any attest to land (the deploy script blocks on this; re-check if you redeployed the relay):
      `cast call <relay> 'tipHeight()(uint256)'` vs `cast call <relay> 'blockHeight(bytes32)(uint256)'
      <anchor>` + 6.
- [ ] Worker: `CONFIDENTIAL_SETTLE=1`, KV bindings, `CONFIDENTIAL_BOX_TOKEN`; if cross-chain,
      `REFLECTION_ATTEST=1` + `REFLECTION_GENESIS_HEIGHT`.
- [ ] Box: settle loop (claims jobs → `pool.settle`) and, if cross-chain, the reflection loop
      (`attestBitcoinStateProven`).
- [ ] Confirm the relay/settle allowlist accepts every day-1 op (`worker/src/confidential-settle.js`).

## 4. Day-1 bootstrap (assets, liquidity, farms, airdrop)

- [ ] `node tests/v1-day1-bootstrap-signet.mjs` — wraps/mints seed balances, opens a cUSD CDP for the
      cUSD legs, adds LP to each pool (box-proven; public path for TAC/cETH), funds each farm
      (`farmEscrow` → `notifyRewardAmount`). Allocations per `ops/PLAN-day1-assets-and-incentives.md`.
- [ ] Airdrop: `tools/airdrop/build-merkle.mjs <snapshot.json>` → root; deploy `DeployMerkleDistributor`
      (TOKEN=TAC, the tranche root, a claim deadline, OWNER=ops); fund it; publish proofs.

## 5. Test matrix (each day-1 flow → its harness)

Extends `CHECKLIST-sepolia-full-suite.md` §5. Run the live `tests/*-signet.mjs` harnesses; each
self-verifies via the worker/indexer:

- [ ] Native wrap → settle → seed-only recover → unwrap; transfer note → recover on recipient seed.
- [ ] Swap, route, LP add/remove (relayed **and** self-settle); OTC + BID fill/refund.
- [ ] Farm bond/harvest/unbond; relayer fee collection (`relayer-fee-collection-signet.mjs`).
- [ ] CDP lifecycle: cUSD mint/topup/close + an oracle-driven liquidation (`cdp-lifecycle-signet.mjs`).
- [ ] cBTC.zk lock broadcast → reflect → mint, with native-ETH escrow + a slashing path
      (`cbtc-lock-broadcast-signet.mjs`).
- [ ] Bridge: BTC→ETH deposit (`bridge-btc-to-eth-deposit-signet.mjs`) + `bridge_burn`/`crossOut` reverse.
- [ ] cETH round-trip (ETH→cETH→Bitcoin→back); fast-lane consumed-nullifier reflect/reject.
- [ ] Router zap (`router-zap-signet.mjs`); confidential orderbook + cross-chain RFQ
      (`confidential-orderbook-e2e-signet.mjs`).
- [ ] Bridge-stealth-mint (`OP_BRIDGE_STEALTH_MINT`): Bitcoin burn → reflect → mint into the stealth
      lock-set → recipient `OP_STEALTH_CLAIM` (cross-chain confidential pay-to-address). Dedicated harness
      `tests/bridge-stealth-mint-signet-e2e.mjs` (wallets: `gen-bridge-stealth-mint-signet-wallets.mjs`,
      preflight runs locally; `MODE=live` broadcasts) + phase 9 of `v1-day1-e2e-signet.mjs`. Off-chain
      coverage today: cxfer-core KATs + `tests/confidential-bridge-stealth-op.mjs` (in the gate node_suite)
      + the gated forge `ConfidentialBridgeStealthMintProofReal` (auto-verifies post-re-prove) + the box
      harness `exec-bridgestealthmint.rs`.

## 5a. Orchestrated parallel run (fast greenlight)

Don't run the §5 matrix serially — real Bitcoin blocks + the reflection confirmation depth + the prove
cycle dominate, so a serial run is ~6.5h while the work only needs ~1.3h. Use the orchestrator:

```
node tests/run-v1-testnet.mjs                              # plan: DAG + parallel schedule + coverage
MODE=live MANIFEST=contracts/deployments/<chainid>.json MAX_PARALLEL=12 node tests/run-v1-testnet.mjs
```

It runs the day-1 feature matrix as a dependency DAG over distinct per-role wallets (no UTXO/nonce
contention), with the five Bitcoin-confirmation-heavy cross-chain flows (`cbtc`, `deposit`, `ceth`,
`reflection`, `bridge-stealth`) on their OWN wallets so their confirmation windows OVERLAP. Signet funding
(`fund-btc`) starts at t+0 in parallel with the Ethereum deploy, so confirmations accrue during bring-up.
Per-feature flows run via `PHASE=n MODE=live tests/v1-day1-e2e-signet.mjs`; wallets are batch-funded once
(`v1-fund-wallets.mjs`). The plan mode asserts **coverage completeness** (every day-1 feature maps to a
job) — a green run is a complete run. With `MAX_PARALLEL` high enough the wall-clock converges to the
critical path (~79m: deploy → bootstrap → one confirmation+prove window).

**Greenlight criterion:** `run-v1-testnet.mjs` live exits 0 (every feature passed on real blocks) AND
`readiness-gate.sh` (POOL + BRIDGE + DAY1) is green AND the re-prove lockdown (§8) is frozen. Then the
mainnet template (§9) is a parameter swap.

## 6. Monitor

Queue depth, failed proofs, `knownReflectionDigest`/`lastRelayHeight`/`bitcoinConsumedCount` advancing,
**relay tip advancing (`RELAY.tip()` keeping pace with the signet tip, staying matured ahead of the attested
batch) and the next 2016-block retarget boundary** (`currentEpoch`·2016 — run `scripts/retarget-relay.sh`
before the advancer stalls there; signet retargets too), `engine.POOL()` wired, cBTC.tac pinned, prover
health. A stalled relay tip silently freezes every attest (`UnanchoredReflection`); do not advertise a route
whose settle queue is failing proofs.

## 7. Gate flip (deliberate, per surface)

Only after a surface passes §5: set the relevant `CROSSLANE_DEPLOYMENTS[net].assets[].live = true` and
redeploy. Keep `TETH_DEPLOYMENTS.*.live = false`.

## 8. Re-prove + lockdown → mainnet candidate

Per `ops/CHECKLIST-mainnet-reprove.md` + `H` in the build plan: on the prover box, rebuild both ELFs from
the committed source, derive vkeys, regenerate every Groth16 fixture — incl. the farm ops, the stale
burn-deposit fixture, and the stealth family (`stealthlock/claim/refund` + the new
`OP_BRIDGE_STEALTH_MINT`), which have no on-chain fixture yet — and reconcile the pin atomically
(`elf-vkey-pin.json`
4 fields, `DEFAULT_VKEY`, `DeployV1Suite`/`DeployConfidentialPool` defaults, the `FROZEN_*` guards). Then
`verify-vkey-pin.sh` + `readiness-gate.sh` all green → the immutable bytecode + pinned ELF/vkeys are the
frozen mainnet candidate; redeploy the freshly-pinned suite to Sepolia so testnet runs the mainnet
artifacts.

## 9. Mainnet delta (same scripts, different env)

`contracts/deploy-v1-suite-mainnet.sh` (fail-closed): `EXPECTED_VERIFIER_CODEHASH` pinned, `ENGINE_ADMIN ==`
the ops multisig, the **real bridged TAC** (`TAC_UNDERLYING`, no testnet etch), mainnet Chainlink feeds
(auto by chainid), a mainnet `HEADER_RELAY` anchored near the tip, `DRY_RUN=1` first to confirm the guards
fire. The actual mainnet broadcast + gate flip remains an explicit ops go/no-go
(`ops/CHECKLIST-mainnet-launch.md`).

## Stop conditions

- Any guest source change: stop, re-prove, rotate pin/default/fixtures together (§8).
- Any pin mismatch: do not deploy. Reflection not advancing: do not flip cross-lane UI.
- Settle queue failing proofs: do not advertise DeFi routes.
- Legacy mixer surfaces as an active bridge: stop and re-check `TETH_DEPLOYMENTS.*.live`.
