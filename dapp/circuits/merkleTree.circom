pragma circom 2.1.6;

// SPEC §3.6 — per-pool append-only Merkle tree at fixed depth L=20.
// Adapted from Tornado Cash's circuits/merkleTree.circom (MIT, tornado-cash/
// tornado-core), simplified: Poseidon leaves throughout (Tornado used Pedersen
// hash on Baby-Jubjub for the leaf and MiMC for the tree path; we use Poseidon
// for both, matching SPEC §3.6 and the dApp's poseidonStub call sites).

include "../node_modules/circomlib/circuits/poseidon.circom";

// 1-bit selector for left/right hash inputs at each tree level.
// path_index ∈ {0, 1}: 0 = leaf is the left child, 1 = right child.
template Selector() {
    signal input in[2];
    signal input s;
    signal output out[2];

    // Force s to be a bit (constraint, not just a hint).
    s * (1 - s) === 0;

    // Conditional swap. When s=0: out[0]=in[0], out[1]=in[1].
    //                  When s=1: out[0]=in[1], out[1]=in[0].
    out[0] <== (in[1] - in[0]) * s + in[0];
    out[1] <== (in[0] - in[1]) * s + in[1];
}

// Verify a leaf is at (path_indices, path_elements) under a given merkle root.
// Hashes are Poseidon(2) at every level — matches what the indexer's
// computePoolRoot() in tacit.js produces.
template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input root;
    signal input path_elements[levels];
    signal input path_indices[levels];

    component selectors[levels];
    component hashers[levels];

    for (var i = 0; i < levels; i++) {
        selectors[i] = Selector();
        selectors[i].in[0] <== i == 0 ? leaf : hashers[i - 1].out;
        selectors[i].in[1] <== path_elements[i];
        selectors[i].s <== path_indices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== selectors[i].out[0];
        hashers[i].inputs[1] <== selectors[i].out[1];
    }

    root === hashers[levels - 1].out;
}
