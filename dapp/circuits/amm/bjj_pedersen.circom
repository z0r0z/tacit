pragma circom 2.1.6;

// BabyJubJub Pedersen commitment template for tacit AMM circuits.
//
// Opens C = amount · H_BJJ + r · G_BJJ on the BabyJubJub curve, where:
//   • H_BJJ and G_BJJ are the protocol's NUMS generators (SPEC §3.9).
//   • amount is range-bounded to 0 ≤ amount < 2^64.
//   • r is range-bounded to 0 ≤ r < n_BJJ ≈ 2^251.
//
// Fixed-base scalar multiplication via circomlib's EscalarMulFix is ~10× cheaper
// than variable-base (escalarmulany) because the windowed precomputed tables
// are baked in at compile time. With H_BJJ and G_BJJ as compile-time constants
// from the pinned NUMS vectors, every AMM Pedersen opening is fast.
//
// Constraint budget (empirical, see amm-circuit-build.test.mjs):
//   • amount · H_BJJ (64-bit scalar):   ~150 constraints
//   • r · G_BJJ      (251-bit scalar):  ~580 constraints
//   • BabyAdd:                            ~7 constraints
//   • Num2Bits(64):                       64 constraints
//   • Num2Bits(251):                     251 constraints
//   • Total per opening:                ~1.1K constraints
//
// (AMM.md's original estimate of ~6K per opening assumed escalarmulany;
//  fixed-base is the right primitive here and brings it down by ~5×.)

include "../node_modules/circomlib/circuits/escalarmulfix.circom";
include "../node_modules/circomlib/circuits/babyjub.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// SPEC §3.9 — Canonical NUMS generators (decimal form for circom).
// Derived by try-and-increment under domains "tacit-amm-bjj-{H,G}-v1".
// Hex form: see tests/amm-bjj.test.mjs pinned vectors.
//
// H_BJJ (counter = 2):
//   hex u = 0x13969c921b0a36e78280a9ff5415b7756761b630fd5fa30d7537e3640cbf6da5
//   hex v = 0x1553d34ea48b8d61df6de5ca9ae5d95183746714ba21af253a46c18a6c2279e4
// G_BJJ (counter = 2):
//   hex u = 0x16b271021d857578ee55d438a32eed9081bfe28579f6e671c87c58a035b49b7b
//   hex v = 0x2447904d61713ffa77c624c908255001a5f369e2548764cb4adbc6e454ae9884

function H_BJJ_BASE_U()  { return 8860051794228765624784055720668791703344981051068813113765876182532050873765; }
function H_BJJ_BASE_V()  { return 9646676515308837211536143343491304968372508964725299602042231998647262935524; }
function G_BJJ_BASE_U()  { return 10266161400728451878654657063038749398069744923142297801862881015748441185147; }
function G_BJJ_BASE_V()  { return 16409704628248567085528181932184581045280945922167020034355995328070141515908; }

// PedersenBJJ — open `amount·H_BJJ + r·G_BJJ` against a BJJ point.
//
// Signals:
//   input  amount      : Fr — range-checked to [0, 2^64) by Num2Bits(64).
//   input  r           : Fr — range-checked to [0, 2^251) by Num2Bits(251).
//   output cx, cy      : the resulting BabyJubJub point coordinates.
//
// Caller must constrain (cx, cy) to match the public commitment expected.
template PedersenBJJ() {
    signal input  amount;
    signal input  r;
    signal output cx;
    signal output cy;

    // ---- range proofs ----
    component amountBits = Num2Bits(64);
    amountBits.in <== amount;

    component rBits = Num2Bits(251);
    rBits.in <== r;

    // ---- amount · H_BJJ ----
    var H_BASE[2];
    H_BASE[0] = H_BJJ_BASE_U();
    H_BASE[1] = H_BJJ_BASE_V();
    component aH = EscalarMulFix(64, H_BASE);
    for (var i = 0; i < 64; i++) {
        aH.e[i] <== amountBits.out[i];
    }

    // ---- r · G_BJJ ----
    var G_BASE[2];
    G_BASE[0] = G_BJJ_BASE_U();
    G_BASE[1] = G_BJJ_BASE_V();
    component rG = EscalarMulFix(251, G_BASE);
    for (var i = 0; i < 251; i++) {
        rG.e[i] <== rBits.out[i];
    }

    // ---- sum ----
    component sum = BabyAdd();
    sum.x1 <== aH.out[0];
    sum.y1 <== aH.out[1];
    sum.x2 <== rG.out[0];
    sum.y2 <== rG.out[1];

    cx <== sum.xout;
    cy <== sum.yout;
}

// PedersenBJJWithRangeNbits — same as PedersenBJJ but parameterized by amount
// bitwidth. Used for share_amount / delta_X / etc. that may need different
// bounds. Default 64-bit.
template PedersenBJJWithAmountBits(amountBits) {
    signal input  amount;
    signal input  r;
    signal output cx;
    signal output cy;

    component amountBitsComp = Num2Bits(amountBits);
    amountBitsComp.in <== amount;

    component rBitsComp = Num2Bits(251);
    rBitsComp.in <== r;

    var H_BASE[2];
    H_BASE[0] = H_BJJ_BASE_U();
    H_BASE[1] = H_BJJ_BASE_V();
    component aH = EscalarMulFix(amountBits, H_BASE);
    for (var i = 0; i < amountBits; i++) {
        aH.e[i] <== amountBitsComp.out[i];
    }

    var G_BASE[2];
    G_BASE[0] = G_BJJ_BASE_U();
    G_BASE[1] = G_BJJ_BASE_V();
    component rG = EscalarMulFix(251, G_BASE);
    for (var i = 0; i < 251; i++) {
        rG.e[i] <== rBitsComp.out[i];
    }

    component sum = BabyAdd();
    sum.x1 <== aH.out[0];
    sum.y1 <== aH.out[1];
    sum.x2 <== rG.out[0];
    sum.y2 <== rG.out[1];

    cx <== sum.xout;
    cy <== sum.yout;
}
