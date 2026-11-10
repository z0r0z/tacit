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

**Leading blocks.** Turns come from `TacitSeats`, which has no owner. A seat is `SEAT` TAC (1,000 today), locked with `join()` after approving TAC to the contract
and given up with `leave(i)`; its TAC is claimed `EXIT_DELAY` (7 days) later with `claim()`. Time runs in slots of `SLOT_BLOCKS` Ethereum blocks (50 today, about ten
minutes) and epochs of 16 slots. Each slot one seat leads, drawn from the epoch's seats by the beacon chain's randomness; a seat taken or given up counts from the next
epoch, and while none is held `BOOTSTRAP` leads. A seat holder runs the node and this leader with a funded `LEADER_KEY` (a landing costs gas; the fees spends carry pay for
it when `LEADER_CHAIN_SEED` is set) and a prover (`PROVER`: the board, or its own `tacit-block-gpu`), and calls `announce(url)` once with where its node takes spends. In its
slot a leader builds and lands what is waiting; the landing contract lets anyone land once `WINDOW` has passed since the last landing, and takes a posted spend within
`FORCE_DELAY` whoever leads. `leader()` says who leads now, and `seatAt(i, next)` and `seats()` who holds what.

**Spends reach the slot's leader.** Every spend pays its fee to one leader's chain address, so a wallet makes each spend for the leader whose turn it will land in: it reads `leaderAt`
for the current slot, and for the next one within two minutes of the slot's end (`dapp/tacit-chain-route.js`), finds that leader's latest `announce(url)`, asks its `GET /fee`, and proves,
hands over and follows the spend there. A proof made for a leader is dropped when its slot is over. A leader with no endpoint, one that does not answer, or one asking more than 2 TAC a spend
is skipped: the spend goes to the house leader as before, and waits for its turn or for `WINDOW`. The page names the hosts it talks to, so an endpoint is reachable from it once its origin is in
the front page's `connect-src`: `node tools/tacit-chain-seat-host.mjs https://your-leader.example.com` checks it is a seat holder's latest announcement, adds it and rebuilds; the change is
committed and pushed with the dapp. The endpoint must be `https` on a DNS name and answer cross-origin reads and posts as the house leader does.

Not built yet: sending blocks whose data is in blobs (the program, contract and node do it; the sender must use the post-Fusaka blob transaction
format), replaying blob blocks another leader landed (needs a beacon node's blob sidecars), the prover board job, and a status page.

**Restarts.** A restart rebuilds the node, from the blocks kept in `ARCHIVE_DIR` when they are the whole chain (every block from 1 to the contract's height is there, each starts where the one before ended, the last ends at the contract's `state`, and no forced entry waits), else from the logs of `BLOCKS` from `FROM_BLOCK`. Every block this leader builds or reads is kept there. `RPC_URL` may list several endpoints, comma apart (`https://a,https://b`): the first that answers is used, and one that refuses, rate-limits or has dropped old logs is passed over. Keep `ARCHIVE_DIR` on the persistent disk.

