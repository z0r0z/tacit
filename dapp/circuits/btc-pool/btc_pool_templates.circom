pragma circom 2.1.6;

// Building blocks for spend.circom. Hashes are circomlib Poseidon over BN254 Fr; keys live on BabyJubJub
// at circomlib's Base8 (the EdDSA base); value commitments use Tacit's NUMS H_BJJ / G_BJJ
// (../amm/bjj_pedersen.circom).

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/compconstant.circom";
include "../node_modules/circomlib/circuits/escalarmulfix.circom";
include "../node_modules/circomlib/circuits/switcher.circom";

function BASE8_U() { return 5299619240641551281634865583518297030282874472190772894086521144482721001553; }
function BASE8_V() { return 16950150798460657717958625567821834550301663161624707787222815936182638968203; }
// Prime subgroup order l of BabyJubJub, minus one.
function BJJ_L_MINUS_1() { return 2736030358979909402780800718157159386076813972158567259200215660948447373040; }

// out = k·Base8 for a canonical scalar 0 ≤ k < l. l < 2^251, so Num2Bits(251) plus k ≤ l−1 gives each
// point exactly one scalar.
template CanonicalKeyMul() {
    signal input k;
    signal output out[2];

    component bits = Num2Bits(251);
    bits.in <== k;

    component lt = CompConstant(BJJ_L_MINUS_1());
    for (var i = 0; i < 251; i++) lt.in[i] <== bits.out[i];
    lt.in[251] <== 0;
    lt.in[252] <== 0;
    lt.in[253] <== 0;
    lt.out === 0;

    var B[2];
    B[0] = BASE8_U();
    B[1] = BASE8_V();
    component m = EscalarMulFix(251, B);
    for (var i = 0; i < 251; i++) m.e[i] <== bits.out[i];
    out[0] <== m.out[0];
    out[1] <== m.out[1];
}

// Poseidon(2) Merkle path of fixed depth. index < 2^depth is enforced by the bit decomposition.
template MerkleRoot(depth) {
    signal input leaf;
    signal input index;
    signal input path[depth];
    signal output root;

    component bits = Num2Bits(depth);
    bits.in <== index;

    component sw[depth];
    component h[depth];
    for (var i = 0; i < depth; i++) {
        sw[i] = Switcher();
        sw[i].L <== i == 0 ? leaf : h[i - 1].out;
        sw[i].R <== path[i];
        sw[i].sel <== bits.out[i];
        h[i] = Poseidon(2);
        h[i].inputs[0] <== sw[i].outL;
        h[i].inputs[1] <== sw[i].outR;
    }
    root <== h[depth - 1].out;
}

// leaf = Poseidon(asset, v, npk, rho)
template NoteLeaf() {
    signal input asset;
    signal input v;
    signal input npk;
    signal input rho;
    signal output out;

    component h = Poseidon(4);
    h.inputs[0] <== asset;
    h.inputs[1] <== v;
    h.inputs[2] <== npk;
    h.inputs[3] <== rho;
    out <== h.out;
}
