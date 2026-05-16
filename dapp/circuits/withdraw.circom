pragma circom 2.1.6;

// SPEC §3.8 — Tacit mixer-pool withdrawal circuit.
//
// Adapted from Tornado Cash's circuits/withdraw.circom (MIT, tornado-cash/
// tornado-core). Differences from the original Tornado:
//
//   1. Leaf commitment is poseidon(secret, nullifier_preimage, denomination)
//      — three inputs, not two — so the leaf is bound to a specific pool's
//      denomination. Tornado's pools fix denomination at the contract level;
//      tacit pools fix it at the leaf level so a single circuit can serve
//      every pool size with denomination as a public input.
//
//   2. Nullifier hash is poseidon(nullifier_preimage) — a single Poseidon
//      hash over one input, replacing Tornado's Pedersen-on-Baby-Jubjub.
//
//   3. **Deterministic r_leaf binding (SPEC §3.8 constraint 4).** The
//      Pedersen blinding scalar `r_leaf` is forced to equal
//      poseidon(secret, nullifier_preimage) and exposed as a public output.
//      The validator (off-circuit) does the secp256k1 Pedersen equality check
//      `recipient_commitment == denomination · H + r_leaf · G`. Together,
//      these close the inflation-attack vector at ~100× lower circuit cost
//      than an in-circuit secp256k1 multi-scalar mult: a malicious withdrawer
//      cannot pick `r_leaf` freely (the circuit constrains it) and cannot
//      pick `recipient_commitment` freely (the validator constrains it to
//      `denomination · H + r_leaf · G`). The result is the same soundness
//      guarantee as in-circuit secp256k1 with a 5–7k-constraint circuit
//      instead of a ~300k one. SPEC §5.11.1 spells out the soundness chain.
//
//   4. Adds `bind_hash` as a public input squared into the constraint
//      system. The dApp computes bind_hash as
//      SHA256(domain || asset_id || denom_LE || nullifier_hash || recipient_commitment || r_leaf),
//      so a relayer or mempool observer cannot replay a copied proof against
//      substituted public inputs — the proof's polynomial system is bound to
//      the exact tuple.
//
// Public inputs (must match the on-chain T_WITHDRAW envelope's public inputs):
//   - root            — pool merkle root the prover is proving against
//   - nullifier_hash  — published in plaintext to mark the leaf spent
//   - denomination    — pool denomination (u64, fits in BN254 Fr)
//   - r_leaf          — public Pedersen blinding scalar, deterministic in (secret, ν)
//   - bind_hash       — SHA256-derived binding (truncated to Fr)
//
// Private inputs (witness):
//   - secret              — random Fr the depositor stored
//   - nullifier_preimage  — random Fr the depositor stored
//   - path_elements[L]    — merkle proof siblings
//   - path_indices[L]     — left/right bits

include "../node_modules/circomlib/circuits/poseidon.circom";
include "./merkleTree.circom";

template Withdraw(levels) {
    // ----------------- public inputs -----------------
    signal input root;
    signal input nullifier_hash;
    signal input denomination;
    signal input r_leaf;
    signal input bind_hash;

    // ----------------- private inputs (witness) -----------------
    signal input secret;
    signal input nullifier_preimage;
    signal input path_elements[levels];
    signal input path_indices[levels];

    // (1) leaf = poseidon(secret, nullifier_preimage, denomination).
    component leafHasher = Poseidon(3);
    leafHasher.inputs[0] <== secret;
    leafHasher.inputs[1] <== nullifier_preimage;
    leafHasher.inputs[2] <== denomination;

    // (2) verify the leaf is a member of the pool tree at `root`.
    component tree = MerkleTreeChecker(levels);
    tree.leaf <== leafHasher.out;
    tree.root <== root;
    for (var i = 0; i < levels; i++) {
        tree.path_elements[i] <== path_elements[i];
        tree.path_indices[i] <== path_indices[i];
    }

    // (3) nullifier_hash = poseidon(nullifier_preimage).
    component nullifierHasher = Poseidon(1);
    nullifierHasher.inputs[0] <== nullifier_preimage;
    nullifierHasher.out === nullifier_hash;

    // (4) r_leaf = poseidon(secret, nullifier_preimage). Forces the Pedersen
    //     blinding to a deterministic function of the depositor's secret pair.
    //     Combined with the validator's external secp256k1 Pedersen check
    //     (recipient_commitment == denomination·H + r_leaf·G), this closes
    //     the inflation-attack vector documented in SPEC §5.11.1.
    component blindHasher = Poseidon(2);
    blindHasher.inputs[0] <== secret;
    blindHasher.inputs[1] <== nullifier_preimage;
    blindHasher.out === r_leaf;

    // (5) Bind public-input tuple into the proof so a relayer cannot replace
    //     bind_hash (or any input it covers — recipient_commit, r_leaf, etc.)
    //     on a captured proof. The squaring is mathematically a no-op for
    //     correctness, but the R1CS lowering MUST retain it: the constraint
    //     `bind_hash * bind_hash === bind_hash_squared` ties bind_hash into
    //     the polynomial system Groth16 builds the proof over, so a captured
    //     proof cannot be replayed against a substituted bind_hash. A
    //     re-implementer optimizing this as dead code (or skipping it because
    //     bind_hash_squared is unused outside this line) silently re-opens
    //     the recipient-substitution attack documented in SPEC §5.11.4.
    //     DO NOT REMOVE OR SIMPLIFY THIS CONSTRAINT.
    signal bind_hash_squared;
    bind_hash_squared <== bind_hash * bind_hash;
}

component main {public [
    root,
    nullifier_hash,
    denomination,
    r_leaf,
    bind_hash
]} = Withdraw(20);
