pragma circom 2.1.6;

// AMM T_SWAP_BATCH circuit (SPEC §5.16).
//
// Binds the on-chain per-intent and per-receipt BabyJubJub commitments to
// per-trader hidden amounts at a uniform clearing price `P_clear` derived from
// the public envelope-declared net deltas. The sigma cross-curve proofs
// (out-of-circuit) extend each binding to the corresponding secp256k1 Pedersen
// commitments on the actual chain UTXOs.
//
// Architectural sketch in AMM.md §"Batch proof: native BabyJubJub work"; §4
// "Deterministic clearing-solve algorithm"; §"Tip mechanics".
//
// Per-intent constraints:
//   • C_in_BJJ_i opens to (amount_in_swap_i + tip_amount_i, r_in_BJJ_i).
//   • tip_amount_i (private witness) == tip_amount_i (public — bound to the
//     trader's intent_sig via intent_msg).
//   • amount_in_swap_i and tip_amount_i are individually range-bounded to u64.
//   • amount_out_i = floor(amount_in_swap_i · P_clear_den / P_clear_num) for
//     A→B traders (direction == 0); floor(amount_in_swap_i · P_clear_num /
//     P_clear_den) for B→A traders (direction == 1). Enforced via
//     division-with-remainder.
//   • C_out_BJJ_i opens to (amount_out_i, r_out_BJJ_i).
//   • amount_out_i ≥ min_out_i.
//
// Aggregate constraints:
//   • Σ_{direction=0} tip_amount_i == tip_A_amount.
//   • Σ_{direction=1} tip_amount_i == tip_B_amount.
//
// P_clear derivation (in-circuit, deterministic from public deltas + reserves):
//   • Non-spot batch (|delta_A_net| > 0 AND |delta_B_net| > 0):
//       P_clear_num = |delta_A_net|, P_clear_den = |delta_B_net|
//   • Spot batch (both deltas zero — intents exactly cancel at spot ratio):
//       P_clear_num = R_A_pre, P_clear_den = R_B_pre
//
// (Derivation: in an A-dominant batch, X = gross A in, Y = gross B in, every
//  A→B trader's amount_out is amount_in / P_clear in B units, B→A trader's is
//  amount_in · P_clear in A units, where P_clear is in A-per-B units. Net A in
//  = X − Y·P_clear; net B out = X/P_clear − Y. Substituting yields
//  P_clear = |delta_A_net| / |delta_B_net|. Symmetric for B-dom; equal under
//  uniform clearing. In spot, deltas are 0 and the price collapses to the
//  pool's spot ratio R_A/R_B.)
//
// The CFMM curve constraint on declared deltas (post-batch reserves still
// satisfy the constant-product invariant with fee) is enforced OUT-OF-CIRCUIT
// by the indexer via the deterministic clearing-solve algorithm (SPEC §11.1).
// The circuit only enforces that per-trader fills are consistent with the
// declared P_clear; the indexer separately re-derives the deltas from public
// X, Y, R_A_pre, R_B_pre, fee_bps and rejects any envelope whose declared
// deltas diverge.
//
// Padding: this circuit always processes N_MAX = 16 intent slots. When the
// batch has fewer real intents, padding slots use amount_in_swap = 0,
// tip_amount = 0, direction = 0, min_out = 0, with public BJJ commitment
// (0, 1) (the BabyJubJub identity, NOT (0,0) which is off-curve). All
// constraints hold trivially for padded slots.
//
// Constraint budget (empirical, pinned by drift-guard.test.mjs against the
// compiled r1cs):
//   • Per-intent BJJ opening:  ~5K
//   • Per-receipt BJJ opening: ~5K
//   • Division-with-remainder, range proofs, min_out check: ~200
//   • For N_MAX=16: ~16 × (5K + 5K + 200) + globals ≈ 171K NL+linear
//     (163,478 non-linear + 7,684 linear).
//
// (AMM.md's original sketch projected ~300K with a variable-base sigma in-
//  circuit; the fixed-base PedersenBJJ primitive brings this down by ~2×.)

include "./bjj_pedersen.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

template AmmSwapBatch(N_MAX) {
    // ---- public inputs (globals) ----
    signal input pool_id_fr;
    signal input R_A_pre;
    signal input R_B_pre;
    // (S_pre removed per pre-ceremony optimization pass — it was range-checked
    //  but never used in swap math, and the comment about "cross-pool replay
    //  prevention" was misleading: pool_id_fr is the actual binding. Indexer
    //  cross-checks pool's lp_total_shares against chain state separately.
    //  See REVIEW.md finding #4.)
    signal input delta_A_net_sign;            // 0 = positive (A-dom or spot), 1 = negative (B-dom)
    signal input delta_A_net_magnitude;
    signal input delta_B_net_sign;
    signal input delta_B_net_magnitude;
    signal input tip_A_amount;
    signal input tip_B_amount;
    signal input fee_bps;
    signal input n_intents;

    // ---- public inputs (per-intent: 5 × N_MAX) ----
    signal input direction[N_MAX];
    signal input C_in_BJJ_u[N_MAX];
    signal input C_in_BJJ_v[N_MAX];
    signal input min_out[N_MAX];
    signal input tip_amount[N_MAX];

    // ---- public inputs (per-receipt: 2 × N_MAX) ----
    signal input C_out_BJJ_u[N_MAX];
    signal input C_out_BJJ_v[N_MAX];

    // ---- private witness (per-intent) ----
    signal input amount_in_swap[N_MAX];       // ∈ [0, 2^64)
    signal input tip_amount_witness[N_MAX];   // must equal public tip_amount[i]
    signal input r_in_BJJ[N_MAX];             // BJJ scalar, ∈ [0, n_BJJ)
    signal input amount_out[N_MAX];           // ∈ [0, 2^64), derived from amount_in_swap at P_clear
    signal input rem[N_MAX];                  // remainder of the floor division
    signal input r_out_BJJ[N_MAX];

    // -------------- global bindings --------------

    // pool_id_fr is a public input; modern circom + snarkjs preserves it
    // without needing an explicit squaring constraint (REVIEW.md finding #5).

    // Sign bits ∈ {0, 1}.
    delta_A_net_sign * (delta_A_net_sign - 1) === 0;
    delta_B_net_sign * (delta_B_net_sign - 1) === 0;

    // Sign consistency: in a non-spot batch the two signs must differ (one
    // asset flows in, the other out). In a spot batch both magnitudes are 0
    // and sign is free (we conventionally use 0).
    // is_spot = 1 iff both magnitudes are 0.
    component isZeroDA = IsZero();
    isZeroDA.in <== delta_A_net_magnitude;
    component isZeroDB = IsZero();
    isZeroDB.in <== delta_B_net_magnitude;
    signal is_spot;
    is_spot <== isZeroDA.out * isZeroDB.out;

    // For non-spot: delta_A_net_sign + delta_B_net_sign == 1 (signs differ).
    // For spot: signs MUST both be 0 (canonicalize, otherwise two distinct
    // proofs differ only in inert sign bits — public-input non-canonicality).
    (1 - is_spot) * (delta_A_net_sign + delta_B_net_sign - 1) === 0;
    is_spot * (delta_A_net_sign + delta_B_net_sign) === 0;

    // Range-check global u64 fields.
    component raPreBits = Num2Bits(64); raPreBits.in <== R_A_pre;
    component rbPreBits = Num2Bits(64); rbPreBits.in <== R_B_pre;
    component dAmagBits = Num2Bits(64); dAmagBits.in <== delta_A_net_magnitude;
    component dBmagBits = Num2Bits(64); dBmagBits.in <== delta_B_net_magnitude;
    component tipABits  = Num2Bits(64); tipABits.in  <== tip_A_amount;
    component tipBBits  = Num2Bits(64); tipBBits.in  <== tip_B_amount;

    // fee_bps ∈ [0, 1001]. Strict in-circuit cap matches the spec (0..1000)
    // via LessThan(11) against 1001 — eliminates the structural mismatch
    // between the 10-bit Num2Bits range (0..1023) and the normative cap.
    component feeBpsBits = Num2Bits(10);
    feeBpsBits.in <== fee_bps;
    component feeBpsCap = LessThan(11);
    feeBpsCap.in[0] <== fee_bps;
    feeBpsCap.in[1] <== 1001;
    feeBpsCap.out === 1;

    // n_intents ∈ [0, 17). 5-bit range covers 0..31.
    component nIntentsBits = Num2Bits(5);
    nIntentsBits.in <== n_intents;

    // -------------- direction discrimination --------------
    //
    // is_spot     = 1 iff both deltas are 0 (intents exactly cancel at spot ratio)
    // is_A_dom    = 1 iff non-spot AND A flows INTO pool (delta_A_net_sign == 0)
    // is_B_dom    = 1 iff non-spot AND A flows OUT of pool (delta_A_net_sign == 1)
    //
    signal nonSpot;
    nonSpot <== 1 - is_spot;
    signal is_A_dom;
    signal is_B_dom;
    is_A_dom <== nonSpot * (1 - delta_A_net_sign);
    is_B_dom <== nonSpot * delta_A_net_sign;

    // -------------- aggregate per-side flows (X = Σ A→B, Y = Σ B→A) --------------
    //
    // Solver-style P_clear requires the private aggregates of trader inputs.
    // We compute them in-circuit from the per-intent witness; they remain
    // private (not in the public-signals vector).
    signal X_per[N_MAX];
    signal Y_per[N_MAX];
    signal X_sum_acc[N_MAX + 1];
    signal Y_sum_acc[N_MAX + 1];
    X_sum_acc[0] <== 0;
    Y_sum_acc[0] <== 0;

    // -------------- P_clear derivation --------------
    //
    // For A-dom (X·R_B > Y·R_A):
    //     P_clear_num = X, P_clear_den = Y + |Δb_net|
    // For B-dom (X·R_B < Y·R_A):
    //     P_clear_num = X + |Δa_net|, P_clear_den = Y
    // For spot (both deltas = 0):
    //     P_clear_num = R_A_pre, P_clear_den = R_B_pre
    //
    // These match the deterministic clearing-solve algorithm (AMM.md §4) and
    // ensure the chain-side aggregate Pedersen identity balances EXACTLY:
    //     X − Σ_{B→A} amount_out_A = |Δa_net|
    //     Σ_{A→B} amount_out_B − Y = |Δb_net|
    //
    // (The delta-only ratio Δa/Δb is mathematically equivalent in real
    //  arithmetic but diverges under integer floor for multi-trader batches.
    //  The X-Y-based formulation is the one that matches the solver and the
    //  chain-side check exactly.)
    //
    // Signals declared at top scope; binding deferred until X_sum, Y_sum
    // are computed in the per-intent loop below.
    signal P_clear_num;
    signal P_clear_den;
    signal P_num_AB;
    signal P_num_BA;
    signal P_den_AB;
    signal P_den_BA;
    signal P_num_spot;
    signal P_num_nonspot;
    signal P_den_spot;
    signal P_den_nonspot;
    signal P_num_AB_term;
    signal P_num_BA_term;
    signal P_den_AB_term;
    signal P_den_BA_term;

    // -------------- per-intent / per-receipt --------------

    component openIn[N_MAX];
    component openOut[N_MAX];
    component amountSwapBits[N_MAX];
    component tipBits[N_MAX];
    component remBits[N_MAX];                  // explicit range proof on rem (≤ 2^69 fits 16 × u64 + |Δ|)
    component remLT[N_MAX];
    component minCheck[N_MAX];

    // Per-intent derived signals lifted to top scope (circom 2 forbids signal
    // declarations inside loops). Optimized to single-mult mux form per slot
    // with linear-free siblings:
    //   mulOffset  = direction · (P_num − P_den)           ⇒ 1 NL per slot
    //   multiplier = mulOffset + P_den                     ⇒ linear, free
    //   divisor    = P_num − mulOffset                     ⇒ linear, free
    //   tipB_i     = direction · tip_amount                ⇒ 1 NL per slot
    //   tipA_i     = tip_amount − tipB_i                   ⇒ linear, free
    //   X_per      = (1 − direction) · amount_in_swap      ⇒ 1 NL per slot
    //   Y_per      = amount_in_swap − X_per                ⇒ linear, free
    // (Earlier passes used 4 multiplications per direction-mux + 2 for X/Y_per;
    //  this form is 3 multiplications per slot total, plus linear derivations.
    //  Divisor range bound is hoisted to global Num2Bits(69) on P_clear_num /
    //  P_clear_den, since divisor[i] is always one of those two by construction.)
    signal multiplier[N_MAX];
    signal divisor[N_MAX];
    signal mulOffset[N_MAX];   // direction · (P_num − P_den)
    signal tipB_i_arr[N_MAX];  // direction · tip_amount (B-side accumulator term)
    signal div_lhs[N_MAX];     // amount_in_swap · multiplier  (quadratic term 1)
    signal div_rhs[N_MAX];     // amount_out · divisor          (quadratic term 2)

    // Accumulators for tip aggregates.
    signal tipSumA[N_MAX + 1];
    signal tipSumB[N_MAX + 1];
    tipSumA[0] <== 0;
    tipSumB[0] <== 0;

    // -------- Pass 1: per-intent independent constraints + X/Y aggregation --------
    for (var i = 0; i < N_MAX; i++) {
        // (1) direction ∈ {0, 1}
        direction[i] * (direction[i] - 1) === 0;

        // (2) tip_amount_witness === public tip_amount  (binds witness to intent_sig)
        tip_amount_witness[i] === tip_amount[i];

        // (3) Range-check amount_in_swap[i] and tip_amount_witness[i] each < 2^64.
        amountSwapBits[i] = Num2Bits(64);
        amountSwapBits[i].in <== amount_in_swap[i];
        tipBits[i] = Num2Bits(64);
        tipBits[i].in <== tip_amount_witness[i];

        // (3.5) Aggregate X and Y by direction (private aggregates needed for P_clear).
        //       Single-mult form: X_per is the quadratic term; Y_per derives
        //       linearly from amount_in_swap − X_per (free).
        X_per[i] <== (1 - direction[i]) * amount_in_swap[i];
        Y_per[i] <== amount_in_swap[i] - X_per[i];
        X_sum_acc[i + 1] <== X_sum_acc[i] + X_per[i];
        Y_sum_acc[i + 1] <== Y_sum_acc[i] + Y_per[i];

        // (4) PedersenBJJ open: C_in_BJJ commits to (amount_in_swap + tip, r_in_BJJ).
        openIn[i] = PedersenBJJ();
        openIn[i].amount <== amount_in_swap[i] + tip_amount_witness[i];
        openIn[i].r <== r_in_BJJ[i];
        openIn[i].cx === C_in_BJJ_u[i];
        openIn[i].cy === C_in_BJJ_v[i];

        // (9) Tip aggregation by direction (single-mult form: compute B-side
        //     term as `direction · tip`, derive A-side as `tip − tipB_i`).
        tipB_i_arr[i] <== direction[i] * tip_amount_witness[i];
        tipSumA[i + 1] <== tipSumA[i] + tip_amount_witness[i] - tipB_i_arr[i];
        tipSumB[i + 1] <== tipSumB[i] + tipB_i_arr[i];
    }

    // Aggregate tip checks.
    tipSumA[N_MAX] === tip_A_amount;
    tipSumB[N_MAX] === tip_B_amount;

    // -------------- P_clear binding (between passes) --------------
    //
    // P_clear is determined by direction:
    //   • Spot: (R_A_pre, R_B_pre)
    //   • A-dom: (X_sum, Y_sum + |Δb_net|)
    //   • B-dom: (X_sum + |Δa_net|, Y_sum)
    //
    // These match the deterministic clearing-solve algorithm (AMM.md §4) and
    // ensure the chain-side aggregate Pedersen identity balances EXACTLY.

    P_num_AB <== X_sum_acc[N_MAX];
    P_num_BA <== X_sum_acc[N_MAX] + delta_A_net_magnitude;
    P_den_AB <== Y_sum_acc[N_MAX] + delta_B_net_magnitude;
    P_den_BA <== Y_sum_acc[N_MAX];

    P_num_AB_term <== is_A_dom * P_num_AB;
    P_num_BA_term <== is_B_dom * P_num_BA;
    P_num_nonspot <== P_num_AB_term + P_num_BA_term;
    P_num_spot    <== is_spot * R_A_pre;
    P_clear_num   <== P_num_spot + P_num_nonspot;

    P_den_AB_term <== is_A_dom * P_den_AB;
    P_den_BA_term <== is_B_dom * P_den_BA;
    P_den_nonspot <== P_den_AB_term + P_den_BA_term;
    P_den_spot    <== is_spot * R_B_pre;
    P_clear_den   <== P_den_spot + P_den_nonspot;

    // -------------- divisor range bound (hoisted from per-trader to global) ----
    //
    // Per-trader divisor[i] is always either P_clear_num (direction=0) or
    // P_clear_den (direction=1) by construction. Range-checking the two global
    // P_clear values here means each trader's LessThan(69) on (rem[i],
    // divisor[i]) is sound without a per-trader Num2Bits(69) on divisor.
    //
    // Worst-case bound: P_clear_num ≤ X_sum + |Δa_net| ≤ 16·(2^64 − 1) +
    // (2^64 − 1) = 17·(2^64 − 1) < 2^69. Symmetric for P_clear_den. Num2Bits(69)
    // is the tight bound (LessThan(69) safely handles the comparison without
    // field wraparound).
    component pClearNumBits = Num2Bits(69);
    pClearNumBits.in <== P_clear_num;
    component pClearDenBits = Num2Bits(69);
    pClearDenBits.in <== P_clear_den;

    // -------- Pass 2: per-intent constraints that reference P_clear --------
    for (var i = 0; i < N_MAX; i++) {
        // (5) Direction-multiplexed P_clear application.
        //     A→B trader (direction=0): amount_out = floor(amount_in_swap · P_den / P_num)
        //     B→A trader (direction=1): amount_out = floor(amount_in_swap · P_num / P_den)
        //     One NL multiplication per slot via single-mult mux:
        //       mulOffset  = direction · (P_num − P_den)   ⇒ NL
        //       multiplier = mulOffset + P_den             ⇒ linear, free
        //       divisor    = P_num − mulOffset             ⇒ linear, free
        //     At direction=0: mulOffset=0    ⇒ (multiplier, divisor) = (P_den, P_num).
        //     At direction=1: mulOffset=P_num−P_den ⇒ (multiplier, divisor) = (P_num, P_den).
        mulOffset[i]  <== direction[i] * (P_clear_num - P_clear_den);
        multiplier[i] <== mulOffset[i] + P_clear_den;
        divisor[i]    <== P_clear_num - mulOffset[i];

        // amount_in_swap · multiplier === amount_out · divisor + rem;  rem < divisor.
        div_lhs[i] <== amount_in_swap[i] * multiplier[i];
        div_rhs[i] <== amount_out[i] * divisor[i];
        div_lhs[i] === div_rhs[i] + rem[i];

        // (6) rem < divisor — explicit range proof on rem only. Divisor's
        //     bound is enforced globally above via Num2Bits(69) on
        //     P_clear_num / P_clear_den, and divisor[i] is provably one of
        //     those two by the single-mult mux construction, so its range
        //     is closed by construction without a per-trader check.
        remBits[i] = Num2Bits(69);
        remBits[i].in <== rem[i];
        remLT[i] = LessThan(69);
        remLT[i].in[0] <== rem[i];
        remLT[i].in[1] <== divisor[i];
        remLT[i].out === 1;

        // (7) PedersenBJJ open: C_out_BJJ commits to (amount_out, r_out_BJJ).
        openOut[i] = PedersenBJJ();
        openOut[i].amount <== amount_out[i];
        openOut[i].r <== r_out_BJJ[i];
        openOut[i].cx === C_out_BJJ_u[i];
        openOut[i].cy === C_out_BJJ_v[i];

        // (8) amount_out >= min_out — slippage protection.
        minCheck[i] = GreaterEqThan(64);
        minCheck[i].in[0] <== amount_out[i];
        minCheck[i].in[1] <== min_out[i];
        minCheck[i].out === 1;
    }
}

component main {public [
    pool_id_fr,
    R_A_pre,
    R_B_pre,
    delta_A_net_sign,
    delta_A_net_magnitude,
    delta_B_net_sign,
    delta_B_net_magnitude,
    tip_A_amount,
    tip_B_amount,
    fee_bps,
    n_intents,
    direction,
    C_in_BJJ_u,
    C_in_BJJ_v,
    min_out,
    tip_amount,
    C_out_BJJ_u,
    C_out_BJJ_v
]} = AmmSwapBatch(16);
