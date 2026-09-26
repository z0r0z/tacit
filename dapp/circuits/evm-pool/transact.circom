pragma circom 2.1.6;

// EVM shielded pool transaction: deposit, private transfer and withdraw in one relation, client-proved
// (Groth16). The note and key model is the Bitcoin pool's (../btc-pool/spend.circom, dapp/btc-pool-zk.js):
//
//   npk  = Poseidon(Ak.x, Ak.y, NK.x, NK.y)        Ak = per-note spend key, NK = nk_note·Base8
//   leaf = Poseidon(asset, v, npk, rho)
//   nf   = Poseidon(nk_note, leaf, index)           0 ≤ nk_note < l, index < 2^depth
//   tree = Poseidon(2), empty leaf 0
//
// Value crosses the pool boundary only through publicAmount, which the contract derives from the public
// deposit/withdraw amount and the relayer fee (ext − fee mod p):
//
//   Σ inV + publicAmount = Σ outV,   every note value < 2^120
//
// Input slot i is empty iff nf[i] = 0 and then carries value 0. A non-empty slot with v = 0 skips membership
// only. Output slot k is empty iff outLeaf[k] = 0 and then carries value 0. The same note may fill both input
// slots; the contract rejects equal non-zero nullifiers.
//
// Insertion is proven here, so the contract never hashes: the two output leaves fill leaves startIndex and
// startIndex + 1 (startIndex even) of the tree whose root is oldRoot, giving newRoot. Membership of inputs is
// proven against root, any root the pool has held.
//
// Spend authority: EdDSA-Poseidon under Ak over M = Poseidon(asset, nf, outLeaf, publicAmount, extDataHash).
// M leaves out the tree position, so a proof that loses the race for oldRoot is re-proven without a new
// signature.

include "../btc-pool/btc_pool_templates.circom";
include "../node_modules/circomlib/circuits/eddsaposeidon.circom";

// Poseidon(0, 0): an empty pair of leaves.
function EMPTY_PAIR() { return 14744269619966411208579211824598458697587494354926760081771325075741142829156; }

template EvmPoolTransact(depth, nIn, nOut, valueBits) {
    assert(nOut == 2);
    assert(valueBits <= 124);

    // public
    signal input root;
    signal input oldRoot;
    signal input newRoot;
    signal input startIndex;
    signal input publicAmount;
    signal input extDataHash;
    signal input asset;
    signal input nf[nIn];
    signal input outLeaf[nOut];

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
    signal input insPath[depth - 1];

    component msg = Poseidon(3 + nIn + nOut);
    msg.inputs[0] <== asset;
    for (var i = 0; i < nIn; i++) msg.inputs[1 + i] <== nf[i];
    for (var k = 0; k < nOut; k++) msg.inputs[1 + nIn + k] <== outLeaf[k];
    msg.inputs[1 + nIn + nOut] <== publicAmount;
    msg.inputs[2 + nIn + nOut] <== extDataHash;

    component inEmpty[nIn];
    component inRange[nIn];
    component nk[nIn];
    component npk[nIn];
    component leaf[nIn];
    component tree[nIn];
    component inZero[nIn];
    component nfh[nIn];
    component sig[nIn];

    var sumIn = publicAmount;
    for (var i = 0; i < nIn; i++) {
        inEmpty[i] = IsZero();
        inEmpty[i].in <== nf[i];

        inRange[i] = Num2Bits(valueBits);
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
        sig[i].M <== msg.out;

        sumIn += inV[i];
    }

    component outEmpty[nOut];
    component outRange[nOut];
    component outH[nOut];
    var sumOut = 0;
    for (var k = 0; k < nOut; k++) {
        outEmpty[k] = IsZero();
        outEmpty[k].in <== outLeaf[k];

        outRange[k] = Num2Bits(valueBits);
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

    sumIn === sumOut;

    // Insertion of the output pair at position s = startIndex / 2 of the level above the leaves. The same
    // sibling path must lead from an empty pair to oldRoot and from the new pair to newRoot. MerkleRoot's
    // bit decomposition bounds s < 2^(depth − 1).
    signal s;
    s <-- startIndex \ 2;
    2 * s === startIndex;

    component pair = Poseidon(2);
    pair.inputs[0] <== outLeaf[0];
    pair.inputs[1] <== outLeaf[1];

    component before = MerkleRoot(depth - 1);
    before.leaf <== EMPTY_PAIR();
    before.index <== s;
    component after = MerkleRoot(depth - 1);
    after.leaf <== pair.out;
    after.index <== s;
    for (var j = 0; j < depth - 1; j++) {
        before.path[j] <== insPath[j];
        after.path[j] <== insPath[j];
    }
    before.root === oldRoot;
    after.root === newRoot;

    signal extDataHashSq;
    extDataHashSq <== extDataHash * extDataHash;
}

component main {public [root, oldRoot, newRoot, startIndex, publicAmount, extDataHash, asset, nf, outLeaf]} =
    EvmPoolTransact(32, 2, 2, 120);
