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

4. **`BOND_ORACLE_PUBKEY_X`** (`lib.rs` ~L124) — currently `[0xba; 32]` **placeholder**.
   - No settle op uses the bond path today, so this is **not** a pool/bridge launch blocker. It is
     baked into the vkey only if a bond op is wired. Set the production relay/bond-oracle key before
     any `OP_BOND_*` ships.

## Cross-contract pins (verify, no value to choose)

5. **`CROSSOUT_SLOT_INDEX`** (`eth-reflection/src/main.rs` ~L31) `= 76`.
   - Must equal `forge inspect ConfidentialPool storageLayout` for `crossOutCommitment`.
   - **Verified 76** on the current contract (after the dead-code cleanup). Re-check on any pool
     storage relayout.

6. **`CHAIN_BINDING`** — derived in the pool ctor from `block.chainid` + `address(this)`; the guest
   stamps it into every proof. Mainnet chainid + the deployed pool address are bound automatically;
   no manual value, but confirm the deploy script reads the right chain.

## Re-prove / deploy order

1. Set items 1–4 to mainnet values.
2. Build the canonical eth-reflection ELF → recompute `ETH_REFLECTION_VKEY` → set it (item 2).
3. Build the canonical settle + reflection ELFs. The prover box must run the **committed canonical
   ELF** (`include_bytes!`), never a native rebuild — drift → `ProofInvalid`.
4. Pin the resulting `PROGRAM_VKEY` / `BITCOIN_RELAY_VKEY` in `sp1/confidential/elf-vkey-pin.json`.
5. Deploy `ConfidentialPool` with the mainnet vkeys + genesis anchor + `HEADER_RELAY` (the deploy
   script's `require`s enforce vkey↔pin coherence and a wired relay).
6. Re-run `readiness-gate.sh` and the forge + cxfer-core suites against the pinned ELFs.

## Known limitations to carry into the runbook (not blockers)

- Mode-B eth-reflection chains from genesis each proof, so its proving cost grows with chain-age
  since the genesis checkpoint (~1 sync-committee update / 27h). The per-period digest-chaining is a
  follow-up; fine at launch with a recent genesis, re-anchor periodically until it lands.
- Settler `fees` is empty in the settle guest (self-settle / out-of-band only); no in-proof fee yet.
