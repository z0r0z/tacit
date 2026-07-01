# PLAN — Day-1 Assets & Incentives (Tacit V1)

Day-1 asset register, the TAC-centric pool set, the LP/farm incentive split, and the public-TAC airdrop.
Companion to `ops/runbooks/V1-TESTNET-LAUNCH-PLAYBOOK.md` (how to deploy/seed) and
`ops/DESIGN-confidential-defi-v1.md` (the cBTC/cUSD architecture). Numbers here are launch parameters —
tune them per market conditions; the scripts read them from env / tweakable constants.

## Asset register

| Asset | What | How it comes to exist on Ethereum | Decimals |
|------|------|-----------------------------------|----------|
| **TAC** | Platform token (public canonical ERC20) | Mainnet: the real TAC bridged from Bitcoin (`f0bbe868…`, already hardcoded in the dapp). Testnet: a fixed-supply 21,000,000 etch via `DeployCanonicalTac` / the suite's `DEPLOY_TESTNET_TAC`. | 8 |
| **cTAC** | Confidential TAC inside the pool | `registerWrapped(TAC, scale=1, …)` (escrow). The Bitcoin-side link is set later by the guest-proven attest_meta path, never at registration. | 8 |
| **cETH** | Confidential / shielded ETH | Native-ETH slot pinned at pool construction via `TETH_BITCOIN_ID`. Wrap ETH → cETH; bridges to Bitcoin and back like tETH. | 8 (native 18 → scale 1e10) |
| **cBTC** | Confidential Bitcoin (cBTC.zk → cBTC.tac) | A real-BTC self-custody lock on Bitcoin, reflected to Ethereum, mints a cBTC note 1:1 gated on a slashable native-ETH escrow (`CollateralEngine`). Exits to the pool-minted `tacBTC` ERC20. | 8 |
| **cUSD** | Confidential dollar (tacUSD) | Minted as a CDP against cBTC collateral, Chainlink-priced, DAI-like (`CollateralEngine`). Optional stability fee + TSR savings rate, dormant at launch under governance. | 8 |

TAC is the **common leg + incentive currency**: every day-1 farm emits cTAC so liquidity and trading
concentrate on TAC pairs and routing flows through TAC.

## Day-1 pools (TAC-centric core)

Founded by the suite (`createPair`, direct); liquidity added via the box-proven bootstrap (or the public
AMM path for the TAC/cETH leg). Fee tier defaults to **30 bps** (`DAY1_FEE_BPS`), Uniswap-V2-like;
optional protocol fee is governance-controlled and off at launch.

| Pool | Tier | Incentive (of ~1,000,000 TAC) | Rationale |
|------|------|-------------------------------|-----------|
| **TAC/cETH** | primary | 250,000 (25%) | The deepest on-ramp pair; ETH is the most-held leg. |
| **TAC/cBTC** | primary | 250,000 (25%) | TAC ↔ Bitcoin exposure; anchors the Bitcoin community. |
| **cUSD/cBTC** | primary | 200,000 (20%) | Bootstraps the stablecoin against its own collateral; supports CDP unwinds. |
| **cUSD/cETH** | secondary | 150,000 (15%) | Stable/ETH depth for pricing + exits. |
| **cETH/cBTC** | secondary | 150,000 (15%) | Cross-asset depth not requiring TAC; rounds out routing. |

Each pool gets a `FarmController` staking its LP-share id (`keccak(poolId‖"lp")`), reward = cTAC, escrow
mode (refundable, no inflation), receipt mode (no bare-lock dilution). Funding is a direct
`pool.farmEscrow(farm, cTAC, amount)` then `farm.notifyRewardAmount(reward, duration)` by farm gov.

The suite degrades gracefully: a pool whose legs didn't resolve (no engine ⇒ no cBTC/cUSD; no TAC) is
skipped with a log line, never silently zero-funded (asserted in `DeployV1Suite.t.sol`).

## Airdrop (public TAC, phase-0)

A Uniswap-style merkle distributor with a clawback deadline — `contracts/src/MerkleDistributor.sol`
(Solady), distinct from the Bitcoin-side stealth airdrop and the in-pool stealth-receive path.

- **Size:** ~2,000,000 TAC (first tranche). Iterative tranches reuse the same contract pattern (one
  instance per merkle root).
- **Build:** `tools/airdrop/build-merkle.mjs <snapshot.json>` → root + per-account proofs. Leaf =
  `keccak256(index, account, amount)`, Solady-compatible sorted-pair internal hashing. JS↔Solidity parity
  is gated (`tests/airdrop-merkle-evm.test.mjs` + `test/MerkleDistributorParity.t.sol`).
- **Deploy:** `DeployMerkleDistributor` with `TOKEN`, `MERKLE_ROOT`, `CLAIM_DEADLINE`, `OWNER` (ops
  multisig); fund by transferring the tranche total of TAC to it.
- **Claim:** recipients call `claim(index, account, amount, proof)` (permissionless; tokens always go to
  the committed account). **Clawback:** after `CLAIM_DEADLINE`, owner `sweep(to)` returns the unclaimed
  remainder — funds are never stranded.

## Governance / privileged surfaces

Per `ops/TRUST-REGISTER-production.md`: the pool is immutable; the engine + farms have an owner/gov.
Testnet uses the existing `TEST_BOT_ADMIN` (env-overridable). Mainnet swaps in the ops multisig/timelock
via the same env vars (`ENGINE_ADMIN`, `FARM_GOV`, distributor `OWNER`). The suite hands engine ownership
to the admin only **after** `setPool` (the circular-dep break), asserted in the rehearsal test.

## Sequencing

1. Deploy + wire the suite (`deploy-v1-suite-testnet.sh`) → testnet TAC etched, 5 pools + farms founded.
2. Seed liquidity + fund farms (`tests/v1-day1-bootstrap-signet.mjs`, box-proven legs; public path for TAC/cETH).
3. Deploy + fund the airdrop distributor; publish proofs.
4. Open claims; after the deadline, sweep the remainder.
