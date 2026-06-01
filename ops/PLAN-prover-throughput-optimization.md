# Prover throughput optimization — slim guest input (txids + bridge txs)

## Problem
Mainnet blocks are ~4,000 txs (≈16× signet). The prover currently fetches every
`/tx/raw` (~4,000 calls/block, rate-limited) and the guest parses every full tx
(compute_txid + envelope scan) — so a ~10-block proof is ~1,600 fetches + multiple
hours of zkVM cycles + OOM risk. Not viable for mainnet density. The bridge
contracts are live + correct; this is the one remaining production-readiness gap.

## Design (no new trust dependency)
The guest needs **all txids** (to verify the block's merkle root against the
header) but only the **full data of the coinbase + bridge txs** (to enforce the
coinbase invariant + process ops). Everything else in a block is irrelevant.

**Host** (`contracts/sp1/script/src/main.rs`):
- Per block, fetch `/block/<hash>/raw` (ONE ~1.5 MB request) instead of N `/tx/raw`.
- Parse the raw block natively (fast, off-circuit): header(80) + varint tx_count +
  each tx. For each tx compute txid; flag it "interesting" if it's the coinbase
  (idx 0) OR carries a TACIT-framed Taproot envelope in vin[0] witness item 1
  (mirror `bitcoin::extract_taproot_envelope`'s structural check) OR has an
  OP_RETURN we still dispatch.
- Feed the guest: header + num_txs + all txids (32B each) + a list of
  `(tx_idx, full_tx_data)` for the interesting txs only.

**Guest** (`contracts/sp1/program/src/main.rs`):
- Per block: read header (verify PoW + chain linkage — unchanged). Read num_txs.
  Read num_txs txids directly. `compute_merkle_root(&txids)` must == header merkle
  root (this AUTHENTICATES the txids as the real block's). 
- Read the provided-tx list. For each `(idx, data)`: assert `compute_txid(data) ==
  txids[idx]` (authenticates the tx is genuinely in the block at that position),
  then run the EXISTING dispatch: idx 0 → coinbase invariant; else → op_returns +
  extract_taproot_envelope → bridge op handlers (mint/burn/export/import/cxfer/
  T_WITHDRAW). Unchanged op logic.
- Skip all non-provided txs (no per-tx parse).

## Safety argument
- Merkle root computed from ALL txids vs the verified header → the txid set is
  authentic + complete; the host cannot hide or fabricate txids.
- Each processed tx's txid is checked against `txids[idx]` → the host cannot inject
  a tx that isn't in the block, nor mis-place it.
- A bridge UTXO spent by a NON-bridge tx the host omitted: the guest keeps a stale
  utxo_set entry, but it can never be reused — re-spending it in a later bridge
  reveal is a Bitcoin double-spend (rejected on-chain, never confirmed, guest never
  sees it). No theft/double-spend; at worst the holder lost that note off-bridge.
- Host omitting a real BRIDGE tx = liveness only (that mint/burn isn't processed
  until reprocessed) — same class as the existing worker-indexing dependency, and
  the host parses the block itself (no external index trusted).

## Cost after
Per block ≈ merkle root over N txids (N sha256, precompiled — cheap) + a handful
of bridge-tx parses + the bridge Groth16 verifications (fixed, ~signet cost). Block
density no longer drives cycles. Fetch = 1 request/block.

## Rollout (vkey-affecting → redeploy)
1. Guest + host changes above.
2. Rebuild guest ELF on the box → new program_vkey → re-pin `elf-vkey-pin.json`
   (same commit) → rebuild host (embeds ELF).
3. Re-validate on signet: full 3a + 3b round-trip (deposit→mint→burn→withdraw +
   Alice→Bob fractional) with the new ELF. MUST pass before mainnet.
4. Redeploy mainnet (deploy-mainnet.sh — fresh relay genesis at tip-6 + new verifier
   with the new vkey + new mixer; reuse the burn verifier + the etched tETH asset
   0x3cba71e1). Verify all bindings (the same preflight).
5. Mainnet round-trip with the slim prover.

## Status
Design fixed. Implementing guest first (security-critical), then host, then the
rebuild/validate/redeploy chain.
