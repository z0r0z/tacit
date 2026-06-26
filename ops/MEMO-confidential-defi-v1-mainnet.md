# Launch memo — confidential DeFi v1 (cBTC + cUSD) to mainnet

Tight, ordered go-to-mainnet for the confidential-DeFi v1 surface: the shielded pool + bidirectional
bridge **plus** tokenized real BTC (**cBTC**) and a cBTC-collateralized confidential stablecoin (**cUSD**)
on a generic basket-CDP primitive + the unified `CollateralEngine`. This is the **§A re-prove bundle** of
`CHECKLIST-mainnet-launch.md`, expanded for the new ops; the bridge / AMM / mixer gates there are unchanged.
The re-prove mechanics live in `CHECKLIST-mainnet-reprove.md`; the architecture in `DESIGN-confidential-defi-v1.md`.

## Status (2026-06-19)
Built + committed (`df98d38`, `39b3aed`, `0fa28ac`) and **all green locally**: 214 confidential + 36
canonical + 8 engine forge, 123 cxfer-core, 5 confidential-JS; both guests `cargo prove build` for RISC-V.
**Adversarial pre-deploy audit done** (4 reviewers + verify): no fund-critical, no inflation/double-spend;
ABI alignment, storage slots, reentrancy, derive-authority, reflection forge/omit/digest/witness-alignment
all verified clean; the two real findings (cBTC-mint owner-binding, guest/JS curve-check parity) fixed +
CollateralEngine hardened. **Remaining = the box re-prove + deploy below.** The immutable surface is frozen.

## 0. Freeze the immutable constants BEFORE the box (the vkeys bake these in)
- [ ] **Reflection mainnet constants** (`CHECKLIST-mainnet-reprove.md` §1–3): `ETH_GENESIS_SYNC_COMMITTEE`
      → a recent **mainnet** beacon checkpoint; `ETH_REFLECTION_VKEY` → recomputed from the mainnet
      eth-reflection ELF (load-bearing, not a formality); the genesis Bitcoin anchor = a near-tip mainnet
      block hash.
- [ ] **`REFLECTION_GENESIS_DIGEST`** = `ScanReflection::genesis().digest()` (currently
      `0xeab17bcb…126388`; the cBTC/CDP work did **not** change it — `genesis_digest_matches_contract_constant`
      pins it; confirm still green).
- [ ] **No placeholders**: `CBTC_ZK_ASSET_ID` is final (`keccak("tacit-cbtc-zk-lock-v1")` = `0x62a20d98…`);
      the cBTC.tac bond consts (`BOND_ORACLE_PUBKEY_X` etc.) are deleted — nothing left to pin.
- [ ] **Reflection-read storage slots** (`forge inspect ConfidentialPool storageLayout` on the FINAL
      contract): `crossOutCommitment`=76, `bitcoinConsumed`=119, `bitcoinConsumedCount`=120 — the
      eth-reflection guest hardcodes them; the new cBTC/CDP storage is appended after `lpShares` so they
      don't shift (CI guard `bad3d4f` pins them; re-run it).
- [ ] **Build the working tree, not a clean checkout** — `BitcoinReflectionPublicValues` carries
      `consumedCount` + `cbtcLocksFolded[]` + `cbtcLocksSpent[]`, and `PublicValues` carries the CDP/cBTC
      arrays; a clean checkout that drops any of them makes every decode revert. `git status` clean of these.

## 1. Re-prove on the box (vast.ai — `reference_vast_prover_access`)
- [ ] Build the canonical **eth-reflection** ELF → recompute `ETH_REFLECTION_VKEY` → set it in lockstep.
- [ ] Build the canonical **settle** + **reflection** ELFs (`include_bytes!` the committed canonical ELF;
      a native rebuild that drifts → `ProofInvalid`). New op surface: `OP_CDP_MINT/CLOSE/LIQUIDATE` (15/16/17)
      + `OP_CBTC_MINT` (18) in settle; cBTC per-lock surfacing in reflection.
- [ ] `cargo prove` → mainnet **`PROGRAM_VKEY`** (settle) + **`BITCOIN_RELAY_VKEY`** (reflection). Derive
      both from the canonical mainnet bundle; the current Sepolia pins live in
      `contracts/sp1/confidential/elf-vkey-pin.json` and are not mainnet deploy targets.
- [ ] **DIGEST_MATCH gate (the one end-to-end check the static audit could not run):** reflect-exec the new
      reflection ELF on a **cBTC-lock fixture** and the settle ELF on a **CDP-mint + cBTC-mint fixture**;
      confirm the guest accepts + the committed digest/PV equals the JS mirror (`confidential-cdp.js` /
      `confidential-pool.js`). The pinned ELF predates this code, so this is mandatory before deploy.

## 2. Pin + reconcile (one commit)
- [ ] `sp1/confidential/elf-vkey-pin.json`: both ELF sha256 + both vkeys.
- [ ] `DeployConfidentialPool.DEFAULT_VKEY` = the new settle vkey; `BITCOIN_RELAY_VKEY` env = the pin
      (the script `require`s it == the pin — fails closed on a stale literal).
- [ ] Regenerate the `*ProofReal` fixtures against the new ELFs; update the `FROZEN_*` drift guards +
      the readiness-gate allowlist.
- [ ] `readiness-gate.sh` → GOLD; re-run forge + cxfer-core + confidential-JS green against the pinned ELFs.

## 3. Deploy (engine ↔ pool wired so cBTC/cUSD are live, not foreclosed)
The pool's `COLLATERAL_ENGINE` is immutable; the engine's `POOL` is **set-once** (`setPool`, owner) — this
breaks the circular dep (both can't be immutable-constructor). Order:
- [ ] Deploy `CollateralEngine(pool=0, CBTC_ZK_ASSET_ID, 8, 8, admin)` FIRST (pool unknown yet; it IS the
      cUSD controller — `CUSD_ASSET_ID` = `derive(engine)`).
- [ ] Deploy `ConfidentialPool` with `COLLATERAL_ENGINE` = the engine address (immutable), the new vkeys,
      the genesis anchor, `HEADER_RELAY` (mainnet Bitcoin relay), `REFLECTION_CONFIRMATIONS` (6 = pilot),
      `EXPECTED_VERIFIER_CODEHASH` (mainnet-required: the immutable SP1 Groth16 leaf, never the gateway),
      `EXPECTED_FACTORY_CODEHASH`.
- [ ] `engine.setPool(pool)` (owner, one-shot — reverts if re-set). Then set feeds (Chainlink ETH/BTC +
      BTC/USD) + ratios; `setDeviationBound` stays 0 until the cUSD pool deepens (then wire the BTC/USD TWAP).
- [ ] *(Alternative, cBTC as a fast-follow:)* deploy the pool with `COLLATERAL_ENGINE=0` — cBTC mint fails
      closed (dormant) — but this FORECLOSES turn-on without a fresh pool. Prefer the engine-first wiring.

## 4. Verify on-chain + activate
- [ ] A forward **bridge_mint** prove + an **attestBitcoinStateProven** accept at the new vkeys.
- [ ] Register **cBTC** as a canonical (mint-backed) asset; confirm `cbtcBackingSats()` reads 0 (no locks yet)
      and an `OP_CBTC_MINT` against a real lock + a funded escrow mints 1:1.
- [ ] cUSD: open a CDP (lock cBTC → mint cUSD) within `cdpRatio`; confirm `onCdpMint` gates it and a
      liquidation below `liqRatio` burns exact cUSD debt in-proof, then seizes collateral to the liquidator.
- [ ] Flip the dapp gate for the confidential-DeFi surface (alongside the §A items in
      `CHECKLIST-mainnet-launch.md`).

## Carry-forward (accepted for the pilot, not blockers)
- `releaseEscrow` is **owner-attested** for v1 (the trustless proven-redemption gate needs the
  matching-burn classification — a clean follow-up); the DAO is the bounded trust there.
- cUSD's peg is **Chainlink BTC/USD-load-bearing** (CDP-stablecoin, DAI-model); size conservatively + wire
  the deviation bound as the 2nd source once the pool deepens.
- The native-ETH reserve is a **protocol backstop**, not user insurance. V1 keeps one DAO/timelock-managed
  reserve with purpose-tagged draws; a later policy contract can own the engine for programmatic draws.
- Reorg posture (deep-reorg-beyond-`REFLECTION_CONFIRMATIONS`) = accept-and-document, as on the bridge/mixer
  (`ACK_REFLECTION_ANCHORED`).
- Mode-B eth-reflection re-anchors periodically (proving cost grows with chain-age since genesis).
