# tacit-leader

Follows `TacitBlocks` on Ethereum, keeps `tacit-block-node` (the chain's state and the mempool wallets submit to) in step with it, and when it
is this leader's turn builds a block from what is waiting and the forced queue, proves it, and lands it (then sends the block's hops into the
confidential pool). Configuration is in the header of `leader.mjs`.

    cargo build --release --manifest-path contracts/sp1/confidential/tacit-block/node/Cargo.toml
    RPC_URL=… BLOCKS=0x… FROM_BLOCK=… LEADER_KEY=0x… PROVER='tacit-block-gpu elf/tacit-block {stdin} --groth16' node tacit-leader/leader.mjs

Wallets talk to the node's HTTP API (`NODE_ADDR`; see `node/src/serve.rs`): reads, and `POST /spend` and `POST /settle`, which check what they
are given. `POST /build` and `POST /landed` are the leader's own and need `Authorization: Bearer $TACIT_NODE_ADMIN` (or a loopback caller when none
is set), because `/landed` takes the caller's word that a block landed: run the node behind a proxy that exposes only the public routes.

`tests/tacit-leader-anvil.mjs` runs all of it on a mainnet fork (real TAC, the live confidential pool, the fixture chain's real spends, a verifier
that takes any proof): the contract's state must be the fixture's after every block. `PROVER=stub` is that test's verifier; a real run proves each
block with `tacit-block-gpu` (see `contracts/sp1/confidential/tacit-block/scripts/`) or, once the prover board has a `tacit-block` program, there.

Not built yet: sending blocks whose data is in blobs (the program, contract and node do it; the sender must use the post-Fusaka blob transaction
format), replaying blob blocks another leader landed (needs a beacon node's blob sidecars), the prover board job, and a status page.
