# Slot-120 exclusion-proof fix — APPLIED + VALIDATED LIVE (2026-06-18)

**Status:** applied on the prover box (`/root/sp1-helios/primitives/src/lib.rs`) and **validated end-to-end**:
the eth-reflection guest rebuilt clean → recursion vkey rotated `0x0025ad24 → 0x0081d2c6`; reflection-prover
rebuilt → BITCOIN_RELAY_VKEY `0x003281ea → 0x00155dba` (PROGRAM_VKEY unchanged `0x0073ee38`). A full
`eth_prove` against the live pool `0x3D38a004` then SUCCEEDED: `eth_getProof proved 2 slot(s) incl.
bitcoinConsumedCount` (the exact preflight that failed before), compressed proof rc=0, `WROTE eth_set.json`
(crossOutSetRoot `0xc905fff9`, ethPool `0x3D38a004`). The exact applied diff is below.

**Beacon note (period gap — resolved without re-anchor):** publicnode's `light_client/updates` endpoint is
inconsistent (returned 3 updates for the genesis period while finality was 2 periods ahead → the guest's
`verify_finality_update` failed). **`https://lodestar-sepolia.chainsafe.io` serves the full update set** (6
updates bridging genesis 10462624 → finality), so the existing genesis pin works — NO re-anchor needed. Use
lodestar as `SOURCE_CONSENSUS_RPC` and `https://sepolia.gateway.tenderly.co` for execution (publicnode caps
eth_getLogs ranges).

**Exact applied diff** (`verify_storage_slot_proofs` per-slot loop — the real source, confirmed on the box):
```rust
// BEFORE:                                          // AFTER:
let mut rlp_encoded_value = Vec::new();             let expected_value = if value.is_zero() {
value.encode(&mut rlp_encoded_value);                   None  // zero slot is deleted from the trie → exclusion proof
if let Err(e) = proof::verify_proof(               } else {
    contract_storage.value.storage_root,               let mut rlp_encoded_value = Vec::new();
    key_nibbles,                                       value.encode(&mut rlp_encoded_value);
    Some(rlp_encoded_value),                           Some(rlp_encoded_value)
    &slot.mpt_proof,                               };
) { anyhow::bail!(...); }                          if let Err(e) = proof::verify_proof(
                                                       contract_storage.value.storage_root, key_nibbles,
                                                       expected_value, &slot.mpt_proof,
                                                   ) { anyhow::bail!(...); }
// the slot is still pushed with value 0, so the guest's bitcoinConsumedCount read returns 0 (no guest change).
```

**Related finding — crossOut dest-owner (fund-loss footgun), FIXED.** Driving the fold surfaced that the
prior drive's crossOut recorded `destCommitment` binding a NON-ZERO owner ("btc-dest-owner"), but
`fold_crossout` mints `leaf(asset,cx,cy,ZERO_OWNER)` (the Bitcoin bearer convention) — so that crossOut is
**unfoldable** (the Ethereum note is burned into a Bitcoin note no reflection can mint = self-inflicted fund
loss). Fixed: the crossOut builder now uses ZERO_OWNER (`tests/gen-cxfer-crossout-fixture.mjs`), and the
settle guest now FORCES ZERO_OWNER for Bitcoin-dest crossOuts (`contracts/sp1/confidential/src/main.rs`,
folds into the settle re-prove — rotates PROGRAM_VKEY). The fold logic itself is correct (the ZERO_OWNER
synthetic mode-b fixture mints 1 note; the live JS resume reproduced the on-chain digest `0x95f38b9e` exactly).

**Problem.** The Mode-B eth-reflection guest reads `ConfidentialPool.bitcoinConsumedCount` (storage slot
120) every cycle as the fast-lane freshness anchor (`src/main.rs:149-157`). At count 0 the slot has never
been `SSTORE`'d, so it is **absent from the storage trie** and `eth_getProof` returns an **exclusion**
proof. The current `verify_storage_slot_proofs` only verifies **inclusion** (it RLP-encodes the claimed
value and looks for that leaf), so it rejects the absent slot:

```
Storage proof invalid for slot ...0078: value mismatch. got: None. expected: Some(0x80)
```

(`0x78` = 120; `0x80` = RLP of 0.) This blocks BOTH the `eth_prove` host preflight (`eth_prove.rs:237`)
and the in-circuit guest verification (`main.rs:130`). Seeding the slot to 0 in the ctor is impossible —
the EVM deletes zero-valued slots, so a 0 slot is always an exclusion. The correct fix is to verify the
**exclusion proof** (the key is provably absent ⇒ value 0), which is exactly as sound as an inclusion
proof. It keeps `bitcoinConsumedCount`, the eth/Bitcoin consumed sets, and the freshness gate all at 0
(no sentinel pollution).

## The fix — ONE change, in the vendored verifier (guest needs NO change)

File: `/root/sp1-helios/primitives/src/lib.rs` (the `sp1-helios-primitives` crate; **not** in this repo —
it is path-deped from the box). Function: `verify_storage_slot_proofs`. In the per-storage-slot loop that
calls `alloy_trie` proof verification, treat a claimed value of 0 as an **exclusion** proof:

```rust
// BEFORE (inclusion-only — rejects an absent/zero slot):
for slot in &contract_storage.storage_slots {
    let key = keccak256(slot.key.as_slice());
    let expected = alloy_rlp::encode_fixed_size(&slot.value.into()); // RLP(value); RLP(0)=0x80
    verify_proof(storage_root, Nibbles::unpack(key), Some(expected.to_vec()), &slot.mpt_proof)
        .map_err(|e| /* "value mismatch ..." */)?;
    out.push(StorageSlot { contractAddress: contract_storage.address, key: slot.key, value: slot.value });
}

// AFTER (accept a valid exclusion proof for a zero slot ⇒ value 0):
for slot in &contract_storage.storage_slots {
    let key = keccak256(slot.key.as_slice());
    // A storage slot equal to 0 is DELETED from the trie (EVM clears zero slots), so its proof is an
    // exclusion proof. Verify absence (expected = None) instead of inclusion; any non-zero value still
    // verifies as inclusion exactly as before. Soundness is unchanged — a verified exclusion proves the
    // slot is genuinely 0, which is all the freshness anchor needs at count 0.
    let expected: Option<Vec<u8>> = if slot.value.is_zero() {
        None
    } else {
        Some(alloy_rlp::encode_fixed_size(&slot.value.into()).to_vec())
    };
    verify_proof(storage_root, Nibbles::unpack(key), expected, &slot.mpt_proof)
        .map_err(|e| /* same error wrap */)?;
    out.push(StorageSlot { contractAddress: contract_storage.address, key: slot.key, value: slot.value });
}
```

Notes for the applier (line numbers depend on the box source — confirm against the actual loop):
- `alloy_trie::proof::verify_proof(root, key, expected_value: Option<Vec<u8>>, proof)` already supports
  `None` = exclusion. The only change is computing `expected` conditionally on `value.is_zero()`.
- The excluded slot is STILL pushed to the result with `value = 0`, so `main.rs:149-157` finds it by key
  and `slot_value_to_u64` returns 0. **No guest (`main.rs`) change is required.**
- If the verifier returns a different slot struct (`StorageSlotWithProof` / a tuple), keep its existing
  shape — only the `expected` argument and the zero-branch change.

## Why no guest change
`main.rs:128-131` does `verified.extend(verify_storage_slot_proofs(...)?)`. With the fix, the count slot
is in `verified` with value 0. `main.rs:149-157` then reads `onchain_consumed_count = 0`, the consumed
fold is empty (`consumed_count = 0`), and the freshness assert `consumed_count == onchain_consumed_count`
holds (0 == 0). The contract gate `r.consumedCount != bitcoinConsumedCount` is `0 != 0` ⇒ passes. Once a
real consume lands, the slot becomes non-zero and is verified by inclusion as before — fully forward
compatible.

## Apply / verify checklist (folds into the alpha re-prove)
1. Apply the change to `/root/sp1-helios/primitives/src/lib.rs`; rebuild the eth-reflection guest ELF.
2. `eth_vkey` → the recursion `hash_u32` ROTATES. Re-pin it into `contracts/sp1/confidential/src/reflect.rs`
   `ETH_REFLECTION_VKEY` (the committed value is the reverted mainnet placeholder; the box build sets the
   real one). Also re-pin `ETH_GENESIS_SYNC_COMMITTEE` if re-anchoring `GENESIS_SLOT` (see below).
3. Rebuild the reflection-prover ELF → `BITCOIN_RELAY_VKEY` rotates → deploy a FRESH ConfidentialPool with
   the new vkeys (the live pool pins the old `0x003281ea`). Rebuild the host bins (`eth_prove`/`bitcoin_prove`
   `include_bytes!` the ELFs).
4. Re-do wrap → crossOut → 0x65 on the fresh pool, then run `eth_prove` (POOL=fresh,
   `SOURCE_EXECUTION_RPC=https://sepolia.gateway.tenderly.co`) → `bitcoin_prove mode_b` → `attest` → fast-spend.

## Also fold in (same cycle)
- **Genesis re-pin (period gap):** the pinned `GENESIS_SLOT=10462624` is several sync periods behind, and
  `get_updates` can return a set that doesn't bridge the store to the finality period (seen live: updates
  to period 1279, finality 1281). Re-pin `GENESIS_SLOT` / `ETH_GENESIS_SYNC_COMMITTEE` to a recent
  finalized checkpoint at re-prove time, and use a consensus RPC that serves the full update chain.
- See `ops/PLAN-fast-lane-shared-nullifier.md` ("Live Mode-B drive") and memory `project_modeb_live_drive`.
