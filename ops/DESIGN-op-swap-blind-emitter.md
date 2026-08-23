# OP_SWAP_BLIND (31) emitter spec — exact stdin the guest reads (main.rs:1665, swap_blind.rs)

Emitter builds the settle stdin for a 1-intent, **tips=0** batch. Guest is UNCHANGED (op already in the
vkey); this is pure off-chain plumbing. Gated: no live dapp/worker emit until the box e2e (step 5) is GREEN
(runbook F-1). Build order: emitter → harness → decoder → fixture → (box e2e at reprove).

## Op header (in read order)
- `asset_a` (32), `asset_b` (32)
- `fee_bps` (u32 LE via io::read), `protocol_fee_bps` (u32), `protocol_fee_recipient` (33 = compressed secp)
- `reserve_a_pre` (u64), `reserve_b_pre` (u64)
- `delta_a_net_sign` (u8), `delta_a_net_mag` (u64), `delta_b_net_sign` (u8), `delta_b_net_mag` (u64)  ← public net deltas
- `r_net_a` (32), `r_net_b` (32)  ← aggregate net blinding per asset (Pedersen identity residue)
- `tip_a_amount` (u64=**0**), `tip_a_c_secp` (33), `r_tip_a` (32); same for `tip_b_*`  ← **all zero for arming**
- `n_intents` (u32 = **1**)
- `proof` (Vec<u8>) ← the `amm_swap_batch` Groth16 proof bytes (snarkjs → guest groth16.rs parse fmt)

## Per-intent (× n_intents)
- `direction` (u8: SWAP_DIR_A_TO_B / B_TO_A)
- input: `r_commitment` (in_cx/in_cy/in_pt), `in_owner` (32), `in_leaf_index` (u64), `in_path` (merkle path)
- `c_in_bjj` (32), `in_sig` (**169-byte** cross-curve sigma: secp C_in ↔ BJJ C_in; guest `babyjubjub::verify_xcurve`)
- `min_out` (u64), `intent_deadline` (u64)
- output: `r_commitment` (out_cx/out_cy/out_pt), `out_owner` (32), `c_out_bjj` (32), `out_sig` (**169-byte** xcurve)
- opening-PoK-blind: `pok_r` (33), `pok_z_v` (32), `pok_z_r` (32) — over `intent_context(pool_id, chain,
  [(in_cx,in_cy,in_owner),(out_cx,out_cy,out_owner)], [direction, min_out, intent_deadline])`, guest
  `verify_opening_pok_blind(in_pt, pok_r, pok_z_v, pok_z_r, ctx)` (value-hiding, context-bound).

Guest then: nu = nullifier(leaf(in_asset,in_cx,in_cy,in_owner)); pushes leaf(out_asset,out_cx,out_cy,out_owner);
builds SwapBatchEnvelope; `swap_blind::verify_clearing(env, circuit_pool_id, reserve_a_pre, reserve_b_pre)`
returns post-reserves; `circuit_pool_id` = pool_id_with_protocol_fee(asset_a, asset_b, fee_bps, recipient, protocol_fee_bps).

## Crypto pieces the emitter must produce (with reuse map)
1. **amm_swap_batch Groth16** — `snarkjs.groth16.fullProve(inputs, dapp/vendor/amm_swap_batch.wasm,
   dapp/circuits/ceremony-genesis-amm/amm_swap_batch_0000.zkey)`. Public signals = `swapBatchPublicSignals`
   (already in `dapp/confidential-swapbatch.js`); circuit inputs from `dapp/circuits/amm/amm_swap_batch.circom`.
   Serialize proof to the guest's parse format (`confidential-swapbatch.js` has the inverse parser to mirror).
2. **Cross-curve sigma (169 B)** — PROVE side of `dapp/amm-sigma.js:verifyXCurve` (secp value == BJJ value);
   guest mirror `babyjubjub::verify_xcurve`. Need prove(secp C, BJJ C, value, blindings) → 169-byte sig.
3. **opening-PoK-blind** — PROVE side of cxfer-core `verify_opening_pok_blind`; challenge from `intent_context`.
   Produces (pok_r=compressed R, pok_z_v, pok_z_r) hiding value while binding owner/min_out/direction/chain.
4. **Aggregate Pedersen identity** — `r_net_{a,b}` = Σ input blindings − Σ output blindings − tip(0) per asset,
   so `Σin − Σout − Δ·H = R_net·G` (swap_blind.rs). Public `delta_*_net` from the clearing.

## Notes
- BabyJubJub JS = `dapp/amm-bjj.js` (guest `babyjubjub.rs` mirrors byte-for-byte). Pedersen gens shared with BP+.
- Reuse `dapp/confidential-swapbatch.js` (verify side + public signals + proof parser) — extend it with the
  fullProve/emit side rather than duplicating.
- 1-intent, tips=0, self-settle keeps every dormant/relay path out — matches the validated conservative arm.
