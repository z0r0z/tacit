pragma circom 2.1.6;

// AMM T_LP_REMOVE circuit (SPEC §5.15).
//
// Binds the two on-chain receipt BabyJubJub commitments (one per asset side)
// to the public delta_A / delta_B amounts via in-circuit Pedersen openings.
// The sigma cross-curve proofs (out-of-circuit) extend each binding to the
// respective secp256k1 Pedersen commitments on the actual receipt UTXOs.
//
// The proportional-withdrawal correctness check (delta_X = floor(R_X · shares / S))
// is performed by the indexer OUT-OF-CIRCUIT — see tests/amm-clearing.mjs
// `lpRemoveOutputs`. This circuit only enforces the commitment-to-amount
// bindings.
//
// Public inputs:
//   pool_id_fr      — SHA256(pool_id) mod p_Fr
//   share_amount    — u64, public — LP shares burned
//   delta_A         — u64, public — asset A receipt amount
//   delta_B         — u64, public — asset B receipt amount
//   recv_A_BJJ_u    — packed BJJ point u-coord (asset-A receipt commitment)
//   recv_A_BJJ_v    — packed BJJ point v-coord
//   recv_B_BJJ_u    — packed BJJ point u-coord (asset-B receipt commitment)
//   recv_B_BJJ_v    — packed BJJ point v-coord
//
// Private witness:
//   r_recv_A_BJJ    — BJJ blinding for asset-A receipt (deterministic from LP privkey
//                     anchored on lpShareInputOutpoint with asset_id = asset_A)
//   r_recv_B_BJJ    — BJJ blinding for asset-B receipt (same anchor, asset_id = asset_B)
//
// Constraint budget: ~10K NL constraints (two PedersenBJJ openings).

include "./bjj_pedersen.circom";

template AmmLpRemove() {
    // ---- public inputs ----
    signal input pool_id_fr;
    signal input share_amount;
    signal input delta_A;
    signal input delta_B;
    signal input recv_A_BJJ_u;
    signal input recv_A_BJJ_v;
    signal input recv_B_BJJ_u;
    signal input recv_B_BJJ_v;

    // ---- private witness ----
    signal input r_recv_A_BJJ;
    signal input r_recv_B_BJJ;

    // pool_id_fr is a public input; modern circom + snarkjs preserves it
    // without needing an explicit squaring constraint (REVIEW.md finding #5).

    // Asset-A receipt: C_recv_A_BJJ == delta_A·H_BJJ + r_recv_A_BJJ·G_BJJ
    component openA = PedersenBJJ();
    openA.amount <== delta_A;
    openA.r <== r_recv_A_BJJ;
    openA.cx === recv_A_BJJ_u;
    openA.cy === recv_A_BJJ_v;

    // Asset-B receipt: C_recv_B_BJJ == delta_B·H_BJJ + r_recv_B_BJJ·G_BJJ
    component openB = PedersenBJJ();
    openB.amount <== delta_B;
    openB.r <== r_recv_B_BJJ;
    openB.cx === recv_B_BJJ_u;
    openB.cy === recv_B_BJJ_v;

    // Range-check share_amount so the public input cannot be a value outside
    // u64 range that would corrupt the indexer's downstream computation. The
    // delta_A / delta_B amounts are already range-checked inside PedersenBJJ.
    component shareBits = Num2Bits(64);
    shareBits.in <== share_amount;
}

component main {public [
    pool_id_fr,
    share_amount,
    delta_A,
    delta_B,
    recv_A_BJJ_u,
    recv_A_BJJ_v,
    recv_B_BJJ_u,
    recv_B_BJJ_v
]} = AmmLpRemove();
