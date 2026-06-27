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

Mode-B (the eth-reflection recursion + btcHomed fast lane) is **live at day-1 v1**, so these are
**required**, not deferred: the mainnet eth-reflection ELF must be built and its anchor/vkey pinned
coherently in the same re-prove that sets a non-zero `BITCOIN_RELAY_VKEY`. (A Sepolia run is correctly
Sepolia-anchored with the in-source values below.) The 2026-06-27 Mode-B audit reduced the two
fund-critical findings (ETHR-1 chain-blind recursion gate via CREATE3, ETHR-2 unconstrained light-client
store) to **fail-closed source asserts** — both now landed in `eth-reflection/src/main.rs` — leaving the
re-anchor of their chain-specific *values* as the box/deploy obligation:

H-1. **Re-anchor (required)** — items 1–2 above ARE the H-01 fix: the mainnet
   `ETH_GENESIS_SYNC_COMMITTEE` is a chain/fork-specific value, so pinning it (plus the matching
   `ETH_REFLECTION_VKEY`) binds the reflection to the mainnet domain. Capturing those two values needs
   live mainnet beacon data (a finalized checkpoint's sync-committee root) + a run of the eth prover.

H-2. **Chain binding — IMPLEMENTED (re-anchor the value).** The eth guest now asserts
   `genesis_root == ETH_GENESIS_VALIDATORS_ROOT` (`eth-reflection/src/main.rs`, after the
   `ProofInputs` destructure). This closes ETHR-1: a proof generated on a different chain (whose pool
   shares the CREATE3 address) carries that chain's `genesis_validators_root` and fails the assert —
   so the on-chain address-only `ethPool == address(this)` gate is no longer the sole chain selector.
   The committed value is the **Sepolia** rehearsal root (`0xd8ea171f…`); **RE-ANCHOR to mainnet**
   (`0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95`) in lockstep with
   `ETH_GENESIS_SYNC_COMMITTEE`. This is in-guest (no `EthReflectionPublicValues` ABI change, so
   `reflect.rs` by-offset reads + the JS mirror are untouched). It rotates the eth ELF ⇒ re-derive +
   re-pin `ETH_REFLECTION_VKEY` (item 2) in the same step.

H-3. **Weak-subjectivity store validation — IMPLEMENTED (confirm + re-anchor the slot).** The eth guest
   now asserts `store.next_sync_committee.is_none()` and `store.finalized_header.beacon().slot ==
   ETH_GENESIS_SLOT` (`eth-reflection/src/main.rs`). This closes ETHR-2: without it the witnessed CBOR
   `store` could carry a pre-loaded attacker `next_sync_committee` that signs a forged period+1 chain past
   the genesis committee (forging the exec stateRoot ⇒ forged crossOut/consumed sets). The honest host
   serializes a fresh genesis bootstrap (`next=None`, pinned at `genesis_slot`, no updates applied —
   `prover-host/eth_prove.rs:189-202,335-339`), so both asserts are liveness-safe. **BOX CONFIRM**: that
   `helios-consensus-core 0.11.1`'s `verify_*update` would otherwise trust a pre-set `next_sync_committee`
   (the Altair-spec behavior these asserts neutralize) — confirm against the live library before lock-in.
   `ETH_GENESIS_SLOT` is the Sepolia rehearsal slot (`10462624`); **RE-ANCHOR to the chosen mainnet
   checkpoint slot** alongside H-1/H-2. Rotates the eth ELF ⇒ same re-pin step.

F-1. **Box-produce the OP_LP_BOND (op 29) ProofReal fixture (required before mainnet — all ops ship enabled).**
   OP_LP_BOND (the LP_ADD⊕FARM_BOND fusion, settle guest main.rs:1411-1557) is live + reachable
   (ConfidentialRouter §726/766, no disable guard) but had NO proof fixture/forge test. The forge test is now
   written (`contracts/test/ConfidentialLpBondProofReal.t.sol`) and asserts the fused shape (1 CdpMint
   positionLeaf==RECEIPT/debtValue==0/legs[shares,rps_entry], 1 leaf = the receipt note with NO intermediate
   LP-share leaf, 2 contribution nullifiers, 1 LpSettlement) — it FAILS only on missing
   `contracts/test/fixtures/lpbond_groth16.json`. Box steps (same flow as the other `*_groth16.json` fixtures, run
   from the SAME committed source as the rest of this re-prove so the vkey is coherent): (1)
   `node tests/gen-confidential-lpbond-fixture.mjs > fixtures/lpbond_op.json`; (2) scp it to the box +
   `OP_FILE=…/lpbond_op.json MODE=groth16 EXPECT_VKEY=<the re-proven program_vkey> cargo run --release --bin exec`
   (the exec harness has the fail-closed vkey guard); (3) assemble `{vkey, publicValues:public_values.hex,
   proofBytes:proof_bytes.hex}` → `contracts/test/fixtures/lpbond_groth16.json`; the forge test then passes (it
   skips until present). NOTE: this MUST ride the coordinated re-prove — the settle vkey rotates with the
   committed guest changes (a 2026-06-27 check showed three divergent vkeys: pin 0x00f36e4c, working-tree build
   0x00cfbefe, the stale box 0x001ac2a2), so ALL settle `*_groth16.json` fixtures regenerate together against the
   final vkey; do not land lpbond in isolation. The other three
   fusion ops (27 wrap_transfer, 28 send_and_unwrap, 30 wrap_cdp_mint) ALREADY pass their new ProofReal tests
   (12/12) against committed fixtures — prod-verified. (bid 0x5B/0x5C stays guest-supported so a covenant flip
   needs no re-prove; its standalone reflection fixture is deferred — see [[bid_walkaway_watchtower_gated]].)

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
   FIXED engine-side (transient guard in `CollateralEngine._savingsReceipt`/`_accrueFee`): a TSR savings bond and
   a stability-fee accrual REVERT (`SameSettleSavingsBondAndFee`) if in the same tx — fail-closed. RESIDUAL (a
   prover-side batching rule, NOT griefing: the prover controls batch composition + the revert is pre-state-change):
   the box/SDK assembler + the (not-yet-built) dapp TSR-bond builder must not co-batch a savings bond with a
   fee-bearing close/liquidation. Redistribution-only (no insolvency), so it does NOT block the
   immutable pool lock; it blocks TSR activation.

X-4. **Lockstep pin rotation (CI gate).** The production cutover moves these pinned constants together —
   `ETH_REFLECTION_VKEY`, `ETH_GENESIS_SYNC_COMMITTEE`, plus the two new eth-guest chain pins
   `ETH_GENESIS_VALIDATORS_ROOT` + `ETH_GENESIS_SLOT` (`eth-reflection/src/main.rs`, H-2/H-3 — all four
   describe the SAME mainnet checkpoint), the batch VK SHA-256 (`BATCH_VK_SHA256` in `groth16.rs`, if the
   ceremony rotates), and the outer ELF/`BITCOIN_RELAY_VKEY`. A partial rotation is fail-closed (mismatch
   revert), not silent, but assert in release CI that all were regenerated from the same production
   checkpoint so a stale pin can't ship. (`ETH_GENESIS_SYNC_COMMITTEE`, `ETH_GENESIS_VALIDATORS_ROOT`, and
   `ETH_GENESIS_SLOT` are all properties of the one chosen finalized checkpoint — capture them in a single
   bootstrap run.)

## Deploy-time safety parameters (choose a production value, not a test value)

D-1. **`REFLECTION_CONFIRMATIONS` reorg-finality depth.** Ctor immutable on `ConfidentialPool` (bounded ≤144).
   This is the entire Bitcoin reorg margin for the burn→mint path: the reflection only anchors to blocks buried
   this deep under the relay tip, so a reorg shallower than it can't strand an already-folded burn. Set to a
   production-grade depth (not a low test value) and assert the deployed value before lock.

D-2. **CollateralEngine owner = timelock/DAO; second oracle source.** The mutable engine can never mint a
   confidential asset or break a peg, but its policy fields are governance-set. Deploy with the owner as a
   timelock/multisig (not an EOA), and wire the deviation-bounded second source (`maxDeviationBps` + AMM TWAP)
   for the cUSD BTC/USD feed once the TWAP has depth — until then cUSD's mark is single-source Chainlink.

D-3. **SDK guardrail — never address value to the relayer/router.** `TacitRelayer` (and the router) treat any
   resident balance as sweepable relay fees, so SDKs must never set a `Withdrawal`/fee recipient to the
   `TacitRelayer` or `ConfidentialRouter` address. Encode this as a builder-side reject in the dapp/SDK.

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
