# tacit-leader

Follows `TacitBlocks` on Ethereum, keeps `tacit-block-node` (the chain's state and the mempool wallets submit to) in step with it, and when it
is this leader's turn builds a block from what is waiting and the forced queue, proves it, and lands it (then sends the block's hops into the
confidential pool). Configuration is in the header of `leader.mjs`.

    cargo build --release --manifest-path contracts/sp1/confidential/tacit-block/node/Cargo.toml
    RPC_URL=… BLOCKS=0x… FROM_BLOCK=… LEADER_KEY=0x… PROVER='tacit-block-gpu elf/tacit-block {stdin} --groth16' node tacit-leader/leader.mjs

Wallets talk to the node's HTTP API (`NODE_ADDR`; see `node/src/serve.rs`): reads, and `POST /spend` and `POST /settle`, which check what they
are given. `POST /build`, `/landed`, `/pending`, `/drop` and `/fee` are the leader's own and need `Authorization: Bearer $TACIT_NODE_ADMIN` (or a
loopback caller when none is set), because `/landed` takes the caller's word that a block landed: run the node behind a proxy that exposes only
the public routes. Every waiting spend stays one a block could take on its own (checked at admission, at each build and after each landing), so
no one entry stops blocks being built; one that stops passing is refused with its reason on its receipt.

**The fee.** With `LEADER_CHAIN_SEED` set, every spend pays the leader a note to its chain address, worth at least the fee it quotes on
`GET /fee`: a spend's share of a landing's gas (`FEE_SPEND_GAS` + `FEE_BLOCK_GAS` / `FEE_BATCH`) at the base fee and the leader's tip, in TAC at
the confidential pool's TAC/tETH price (the median of its last reads; `FEE_TAC_PER_ETH` while it cannot be read), plus `FEE_MARGIN_BPS`, at least
`FEE_MIN` (`fees.mjs` has the defaults). Before each block the leader opens the memos of the spends it has not seen (`POST /pending`), keeps those
that pay at least the lowest fee it quoted in the last `FEE_WINDOW_SECS`, and refuses the rest (`POST /drop` with the reason). With no seed, no fee
is asked.

**The escape hatch.** A spend no leader takes is posted to Ethereum by its owner: `POST /forced` on any node returns the bytes `TacitBlocks.force`
takes (the spend's hints worked out natively; `tacit-block-node forced FILE` reads such bytes back as the program does), and every block must take
the queue's entries within `FORCE_DELAY`. A shield of a `deposit()` is posted by its depositor; a swept inbox's by anyone.

`tests/tacit-chain-fee-force.test.mjs` runs the fee check, the forced bytes and the mempool's pruning against the node with real spend proofs;
`tests/tacit-chain-force-fork.mjs` runs the leader with its fee and spends posted to the forced queue on a mainnet fork.
`tests/tacit-leader-anvil.mjs` runs all of it on a mainnet fork (real TAC, the live confidential pool, the fixture chain's real spends, a verifier
that takes any proof): the contract's state must be the fixture's after every block. `PROVER=stub` is that test's verifier; a real run proves each
block with `tacit-block-gpu` (see `contracts/sp1/confidential/tacit-block/scripts/`) or, once the prover board has a `tacit-block` program, there.

Not built yet: sending blocks whose data is in blobs (the program, contract and node do it; the sender must use the post-Fusaka blob transaction
format), replaying blob blocks another leader landed (needs a beacon node's blob sidecars), the prover board job, and a status page.
