pragma circom 2.1.6;

// T_BTC_SPEND / T_BTC_SHIELD relation for the Bitcoin shielded pool, client-proved (Groth16).
// Reference: dapp/btc-pool-zk.js, contracts/sp1/confidential/btc-pool-zk-core.
//
//   npk  = Poseidon(Ak.x, Ak.y, NK.x, NK.y)        Ak = per-note spend key, NK = nk_note·Base8
//   leaf = Poseidon(asset, v, npk, rho)
//   nf   = Poseidon(nk_note, leaf, index)           0 ≤ nk_note < l, index < 2^32
//   tree = Poseidon(2), depth 32
//
// Input slot i is empty iff nf[i] = 0: its value must be 0 and nothing else about it is checked.
// A non-empty slot with v = 0 skips membership only. Output slot k is empty iff outLeaf[k] = 0 and then
// carries value 0. exitC / depC are BabyJub Pedersen commitments v·H + r·G; the indexer passes the
// identity (0, 1) for an absent exit or deposit, which forces that value to 0.
//
// Spend authority: EdDSA-Poseidon under Ak over bodyHash. The witness holds the signature, never the
// spend scalar, so a delegated prover can only prove the body the owner signed.
//
//   Σ inV + depV = Σ outV + exitV, every term < 2^64.

include "./btc_pool_templates.circom";
include "../amm/bjj_pedersen.circom";
include "../node_modules/circomlib/circuits/eddsaposeidon.circom";

template BtcPoolSpend(depth, nIn, nOut) {
    // public
    signal input root;
    signal input bodyHash;
    signal input asset;
    signal input nf[nIn];
    signal input outLeaf[nOut];
    signal input exitC[2];
    signal input depC[2];

    // private
    signal input inV[nIn];
    signal input inRho[nIn];
    signal input inNk[nIn];
    signal input inAk[nIn][2];
    signal input inIndex[nIn];
    signal input inPath[nIn][depth];
    signal input sigR8[nIn][2];
    signal input sigS[nIn];
    signal input outV[nOut];
    signal input outNpk[nOut];
    signal input outRho[nOut];
    signal input exitV;
    signal input exitR;
    signal input depV;
    signal input depR;

    signal bodyHashSq;
    bodyHashSq <== bodyHash * bodyHash;

    component inEmpty[nIn];
    component inRange[nIn];
    component nk[nIn];
    component npk[nIn];
    component leaf[nIn];
    component tree[nIn];
    component inZero[nIn];
    component nfh[nIn];
    component sig[nIn];

    var sumIn = depV;
    for (var i = 0; i < nIn; i++) {
        inEmpty[i] = IsZero();
        inEmpty[i].in <== nf[i];

        inRange[i] = Num2Bits(64);
        inRange[i].in <== inV[i];
        inV[i] * inEmpty[i].out === 0;

        nk[i] = CanonicalKeyMul();
        nk[i].k <== inNk[i];

        npk[i] = Poseidon(4);
        npk[i].inputs[0] <== inAk[i][0];
        npk[i].inputs[1] <== inAk[i][1];
        npk[i].inputs[2] <== nk[i].out[0];
        npk[i].inputs[3] <== nk[i].out[1];

        leaf[i] = NoteLeaf();
        leaf[i].asset <== asset;
        leaf[i].v <== inV[i];
        leaf[i].npk <== npk[i].out;
        leaf[i].rho <== inRho[i];

        tree[i] = MerkleRoot(depth);
        tree[i].leaf <== leaf[i].out;
        tree[i].index <== inIndex[i];
        for (var j = 0; j < depth; j++) tree[i].path[j] <== inPath[i][j];
        inZero[i] = IsZero();
        inZero[i].in <== inV[i];
        (tree[i].root - root) * (1 - inZero[i].out) === 0;

        nfh[i] = Poseidon(3);
        nfh[i].inputs[0] <== inNk[i];
        nfh[i].inputs[1] <== leaf[i].out;
        nfh[i].inputs[2] <== inIndex[i];
        (nfh[i].out - nf[i]) * (1 - inEmpty[i].out) === 0;

        sig[i] = EdDSAPoseidonVerifier();
        sig[i].enabled <== 1 - inEmpty[i].out;
        sig[i].Ax <== inAk[i][0];
        sig[i].Ay <== inAk[i][1];
        sig[i].R8x <== sigR8[i][0];
        sig[i].R8y <== sigR8[i][1];
        sig[i].S <== sigS[i];
        sig[i].M <== bodyHash;

        sumIn += inV[i];
    }

    component outEmpty[nOut];
    component outRange[nOut];
    component outH[nOut];
    var sumOut = exitV;
    for (var k = 0; k < nOut; k++) {
        outEmpty[k] = IsZero();
        outEmpty[k].in <== outLeaf[k];

        outRange[k] = Num2Bits(64);
        outRange[k].in <== outV[k];
        outV[k] * outEmpty[k].out === 0;

        outH[k] = NoteLeaf();
        outH[k].asset <== asset;
        outH[k].v <== outV[k];
        outH[k].npk <== outNpk[k];
        outH[k].rho <== outRho[k];
        (outH[k].out - outLeaf[k]) * (1 - outEmpty[k].out) === 0;

        sumOut += outV[k];
    }

    // PedersenBJJ range-checks amount < 2^64 and r < 2^251.
    component ex = PedersenBJJ();
    ex.amount <== exitV;
    ex.r <== exitR;
    ex.cx === exitC[0];
    ex.cy === exitC[1];

    component dep = PedersenBJJ();
    dep.amount <== depV;
    dep.r <== depR;
    dep.cx === depC[0];
    dep.cy === depC[1];

    sumIn === sumOut;
}

component main {public [root, bodyHash, asset, nf, outLeaf, exitC, depC]} = BtcPoolSpend(32, 2, 3);
