pragma circom 2.1.6;

// AMM T_LP_ADD circuit (SPEC §5.14).
//
// Binds the on-chain LP-share BabyJubJub commitment to the public share_amount
// via an in-circuit Pedersen opening. The sigma cross-curve proof (out-of-circuit)
// extends this binding to the secp256k1 Pedersen commitment on the actual tacit
// UTXO. Together: chain UTXO C_secp ↔ (sigma) ↔ envelope C_BJJ ↔ (this proof) ↔
// public share_amount.
//
// The at-the-ratio / share-formula correctness check is performed by the
// indexer OUT-OF-CIRCUIT (it's pure integer arithmetic over public values; see
// tests/amm-clearing.mjs `lpAddShares` and `lpInitShares`). Both variants of
// T_LP_ADD (variant=0 standard add, variant=1 POOL_INIT) reuse this circuit
// because the in-circuit work — the Pedersen opening — is identical; only the
// out-of-circuit share-formula differs.
//
// Public inputs (must match the on-chain envelope's public-input vector):
//   pool_id_fr     — SHA256(pool_id) mod p_Fr, binds the proof to a pool
//   variant        — 0 standard add, 1 POOL_INIT (informational, no in-circuit
//                    behavioral difference; bound into the proof to prevent
//                    cross-variant replay)
//   share_amount   — u64, public — LP shares minted
//   C_share_BJJ_u  — packed BJJ point u-coordinate
//   C_share_BJJ_v  — packed BJJ point v-coordinate
//
// Private inputs (witness):
//   r_share_BJJ    — BJJ scalar, deterministic from LP's privkey
//                    (HMAC-SHA256 anchored on lpInputAOutpoint per SPEC §6.10)
//
// Constraint budget: ~5K NL constraints (single PedersenBJJ opening).

include "./bjj_pedersen.circom";

template AmmLpAdd() {
    // ---- public inputs ----
    signal input pool_id_fr;
    signal input variant;
    signal input share_amount;
    signal input C_share_BJJ_u;
    signal input C_share_BJJ_v;

    // ---- private witness ----
    signal input r_share_BJJ;

    // (1) variant ∈ {0, 1} — bind into proof, prevent cross-variant replay.
    variant * (variant - 1) === 0;

    // (2) pool_id_fr is a public input. Modern circom (2.1.6+) + snarkjs
    //     preserves every declared public signal in the proof's polynomial
    //     system without needing an explicit squaring constraint. The
    //     defensive `pool_id_squared` pattern from withdraw.circom is
    //     unnecessary here per the pre-ceremony circuit review (REVIEW.md
    //     finding #5); omitted to save one constraint.

    // (3) In-circuit Pedersen opening: C_share_BJJ == share_amount·H_BJJ + r_share_BJJ·G_BJJ.
    //     Constrains the BJJ commitment to commit to the public share_amount.
    //     The Num2Bits(64) inside PedersenBJJ range-checks share_amount < 2^64.
    component openShare = PedersenBJJ();
    openShare.amount <== share_amount;
    openShare.r <== r_share_BJJ;

    openShare.cx === C_share_BJJ_u;
    openShare.cy === C_share_BJJ_v;
}

component main {public [
    pool_id_fr,
    variant,
    share_amount,
    C_share_BJJ_u,
    C_share_BJJ_v
]} = AmmLpAdd();
