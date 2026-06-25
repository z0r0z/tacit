# Mainnet re-prove checklist — confidential guests

The settle + reflection ELFs pin a set of constants into their vkeys. The vkeys are immutable
once a pool is deployed, so every value below must carry its **mainnet** form **before** the
re-prove that produces the mainnet `PROGRAM_VKEY` / `BITCOIN_RELAY_VKEY`. Several currently hold
Sepolia / placeholder values. This list is the gate.

The confidential **pool + settle** path is mainnet-config-independent; only the **cross-chain
bridge / reflection** path depends on the reflection-guest constants (items 1–4).

## Reflection guest — `contracts/sp1/confidential/src/reflect.rs`

1. **`ETH_GENESIS_SYNC_COMMITTEE`** (`reflect.rs` ~L127)
   - Currently the **Sepolia** beacon weak-subjectivity checkpoint (captured @ finalizedSlot 10462624).
   - Set to a recent **mainnet** finalized sync-committee checkpoint. This is the genesis anchor the
     Mode-B eth-reflection chains from (`prevSyncCommitteeRoot == ETH_GENESIS_SYNC_COMMITTEE`).

2. **`ETH_REFLECTION_VKEY`** (`reflect.rs` ~L119)
   - The recursion vkey (`vk.hash_u32()`) of the **eth-reflection** ELF that `verify_sp1_proof` checks.
   - Rebuild the eth-reflection ELF for mainnet, recompute via `prover-host/eth_vkey`, and set this in
     lockstep. A drift here makes every reflection proof reject (`verify_sp1_proof` fails).

3. **Genesis Bitcoin anchor + `REFLECTION_GENESIS_DIGEST`** (ctor + `reflect.rs` anchor read)
   - Deploy with `genesisReflectionAnchor_` = a recent mainnet Bitcoin block hash (near-tip launch
     pattern; a deep-from-zero bootstrap OOMs the prover).
   - `ConfidentialPool.REFLECTION_GENESIS_DIGEST` must equal `ScanReflection::genesis().digest()`
     (empty live set @ height 0); the cxfer-core test `genesis_digest_matches_contract_constant`
     pins it. The empty live set is correct iff the pool has no UTXOs at/below the anchor block.

## cxfer-core — `contracts/sp1/confidential/cxfer-core/src/lib.rs`

4. **(removed)** The cBTC.tac confidential-bond guest primitives (`BOND_ORACLE_PUBKEY_X`,
   `bond_position_leaf`, `BondMintAttest`, `verify_bond_mint`/`_slash_health`) were deleted — the
   cBTC design no longer uses a confidential CDP bond (see `DESIGN-cbtc.md`; cBTC is real-BTC-backed
   with a native-ETH slashable escrow on Ethereum). There is no bond constant to finalize before the
   re-prove.

## H-01 / N-01 close-out (cross-chain enablement)

The 2026-06-24/25 reviews flagged the Mode-B eth-reflection source binding (H-01) and the
fast-lane btcHomed exit's dependency on it (N-01). Both are **cross-chain-only** — an EVM-only
launch (`BITCOIN_RELAY_VKEY = 0`) makes them moot, and a Sepolia run is correctly Sepolia-anchored.
They close out as part of this mainnet re-anchor:

H-1. **Re-anchor (required)** — items 1–2 above ARE the H-01 fix: the mainnet
   `ETH_GENESIS_SYNC_COMMITTEE` is a chain/fork-specific value, so pinning it (plus the matching
   `ETH_REFLECTION_VKEY`) binds the reflection to the mainnet domain. Capturing those two values needs
   live mainnet beacon data (a finalized checkpoint's sync-committee root) + a run of the eth prover.

H-2. **Explicit domain field (optional, belt-and-suspenders).** Append a `sourceChainId` (and/or the
   beacon fork-digest from `current_fork_version` + `genesis_validators_root`, both already inputs at
   `eth-reflection/src/main.rs` ~L106) as the **last** field of `EthReflectionPublicValues`
   (`eth-reflection/src/main.rs` struct + commit site). Appending keeps every existing by-offset read in
   `reflect.rs` unchanged; then bump the length check (`reflect.rs` ~L310, `11*32`→`12*32`) and add one
   assert against a pinned mainnet constant after the existing sync-committee assert. Update the layout
   doc in `cxfer-core/eth_reflection.rs`. Redundant with H-1 (the sync-committee anchor already
   domain-separates) but makes the binding explicit. Folds into the same re-prove.

N-1. **Enable-ordering invariant (required before arming btcHomed value exits).** The EVM side is
   already fail-closed (the `ConsumedCountStale` gate). Do not arm fast-lane btcHomed value exits until
   the mainnet reflection is live AND a first production reflection has advanced the spent set — i.e.
   `BITCOIN_RELAY_VKEY` pins the regenerated mainnet program and one `attestBitcoinStateProven` has
   landed. Treat as a hard enable-ordering step, not a runbook nicety: keep the exit path unreachable
   (relay vkey 0, or no production reflection yet) until then.

X-1. **Batch path box-validation (required before arming `T_SWAP_BATCH`).** The in-guest BN254 verifier's
   LOGIC is covered by a native test (`groth16::tests::swapbatch_verifier_accepts_real_and_rejects_forgeries`,
   real dev-zkey vector). Before arming the batch lane, additionally run on the box: (1) a real
   **ceremony-zkey** `swap_batch` proof verifies against `groth16.rs` (the native test uses the dev VK, whose
   `delta2` differs from the baked `batch_vk.bin`); (2) `bn` resolves to the SP1-accelerated build; (3)
   `babyjubjub::verify_xcurve` against real cross-curve vectors; (4) a full envelope+proof `swap_batch`
   end-to-end. `fold_swap_batch` is reachable on-chain via the in-guest dispatch, so this is mandatory before
   arming — but enabling later is a free off-chain flip (no re-prove, no contract change).

Q-1. **TSR same-settle fee gate (required before arming the cUSD stability fee / TSR).** While the stability
   fee is dormant (`stabilityFeePerSecond == 0`) no fee accrues, so TSR savings is inert. Before governance
   ever calls `setStabilityFee(>RAY)`: fix the engine so a TSR savings bond (a `positionLeaf==1`,
   `debtValue==0` cdpMint) created in a settle cannot share in stability fees accrued by a close/liquidation in
   that SAME settle (the pool processes all cdpMints before any close/liquidation). The fix is engine-side
   (`CollateralEngine._savingsReceipt`/`_accrueFee`, mutable) — an activation checkpoint so a same-settle bond's
   `rpsEntry` excludes the same-settle delta. Redistribution-only (no insolvency), so it does NOT block the
   immutable pool lock; it blocks TSR activation.

X-4. **Lockstep pin rotation (CI gate).** The production cutover moves four pinned constants together —
   `ETH_REFLECTION_VKEY`, `ETH_GENESIS_SYNC_COMMITTEE`, the batch VK SHA-256 (`BATCH_VK_SHA256` in
   `groth16.rs`, if the ceremony rotates), and the outer ELF/`BITCOIN_RELAY_VKEY`. A partial rotation is
   fail-closed (mismatch revert), not silent, but assert in release CI that all four were regenerated from the
   same production checkpoint so a stale pin can't ship.

## Cross-contract pins (verify, no value to choose)

5. **`CROSSOUT_SLOT_INDEX`** (`eth-reflection/src/main.rs` ~L31) `= 76`.
   - Must equal `forge inspect ConfidentialPool storageLayout` for `crossOutCommitment`.
   - **Verified 76** on the current contract (after the dead-code cleanup). Re-check on any pool
     storage relayout.

5b. **`CONSUMED_SLOT_INDEX = 119` / `CONSUMED_COUNT_SLOT_INDEX = 120`** (`cxfer-core/eth_reflection.rs`
    ~L114/117; imported by `eth-reflection/src/main.rs` + `eth_prove.rs`) — the fast-lane consumed-ν
    map + the freshness counter.
    - Must equal `forge inspect ConfidentialPool storageLayout` (after `forge clean`) for
      `bitcoinConsumed` (119) and `bitcoinConsumedCount` (120). `eth_prove` proves these slots and the
      guest folds them; a wrong index silently reads zero → the freshness gate never advances.
    - Re-check on any pool storage relayout (these sit just past `crossOutCommitment` @ 76).

6. **`CHAIN_BINDING`** — derived in the pool ctor from `block.chainid` + `address(this)`; the guest
   stamps it into every proof. Mainnet chainid + the deployed pool address are bound automatically;
   no manual value, but confirm the deploy script reads the right chain.

## Re-prove / deploy order

0. **Build the committed working tree (it carries the full PV surface).** Both public-value structs grew
   and the contract decodes the grown shapes, so the box must `cargo prove build` the committed source —
   any drift makes `abi.decode` revert. As of the confidential-DeFi v1 work (committed `df98d38`/`0fa28ac`):
   - **Reflection** `BitcoinReflectionPublicValues`: `consumedCount` (fast-lane) **+** `cbtcLocksFolded[]`
     **+** `cbtcLocksSpent[]` (cBTC per-lock surfacing) — all committed; the contract's
     `BitcoinRelayPublicValues` matches.
   - **Settle** `PublicValues`: `cdpPositionRoot` + `CdpMint[]`/`CdpClose[]`/`CdpLiquidate[]` + `CbtcMint[]`
     (ops 15–18) appended last; the contract's `PublicValues` matches. New header input: `cdp_position_root`.
   - The cBTC lock-fold is **track-not-mint** + the cBTC note is **owner-free (bearer)**; `fold_cbtc_lock`
     re-validates the (Cx,Cy) curve point. Confirm `git status` is clean of these before building.
   - The committed `ETH_REFLECTION_VKEY [u32;8]` is **stale** (set in `f405e62`, before the eth-reflection
     guest gained the consumed-set in `c5b319a`). Item 2 (recompute it) is therefore load-bearing, not a
     formality — and because the reflection ELF embeds it, the resulting `BITCOIN_RELAY_VKEY` will **differ
     from the staged `0x00d06eda`**. Treat the `_staged_reprove_*` vkeys in `elf-vkey-pin.json` as a
     prediction to sanity-check against, not values to promote blind.
1. Set items 1–4 to mainnet values.
2. Build the canonical eth-reflection ELF → recompute `ETH_REFLECTION_VKEY` → set it (item 2).
3. Build the canonical settle + reflection ELFs. The prover box must run the **committed canonical
   ELF** (`include_bytes!`), never a native rebuild — drift → `ProofInvalid`.
4. **DIGEST_MATCH** on the new ELFs: reflect-exec a cBTC-lock reflection fixture + a CDP-mint/cBTC-mint
   settle fixture and confirm the guest accepts + the digest/PV equals the JS mirror. The pinned ELF
   predates the cBTC/CDP code, so this is the one end-to-end gate the static audit could not run.
5. Pin the resulting `PROGRAM_VKEY` / `BITCOIN_RELAY_VKEY` in `sp1/confidential/elf-vkey-pin.json`.
6. Deploy `ConfidentialPool` with the mainnet vkeys + genesis anchor + `HEADER_RELAY` + the
   `COLLATERAL_ENGINE` (CREATE2-predict it so cBTC/cUSD are live/turn-on-able, or 0 to launch cBTC dormant —
   note 0 forecloses turn-on without a fresh pool). The deploy script's `require`s enforce vkey↔pin
   coherence, the verifier/factory codehashes, and a wired relay.
7. Re-run `readiness-gate.sh` and the forge + cxfer-core suites against the pinned ELFs.

See `MEMO-confidential-defi-v1-mainnet.md` for the consolidated, ordered launch sequence (cBTC + cUSD).

## Known limitations to carry into the runbook (not blockers)

- Mode-B eth-reflection chains from genesis each proof, so its proving cost grows with chain-age
  since the genesis checkpoint (~1 sync-committee update / 27h). The per-period digest-chaining is a
  follow-up; fine at launch with a recent genesis, re-anchor periodically until it lands.
- Settler `fees` is empty in the settle guest (self-settle / out-of-band only); no in-proof fee yet.
