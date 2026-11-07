# The pool's blocks

The live pool's history, read as a chain of blocks. Ethereum orders it and its logs hold it; nothing here is decided by Tacit, and anyone can
rebuild every block and its hash from the pool's logs alone. `GET https://api.tacit.finance/prover/blocks` serves it (worker/src/tacit-chain.js),
and [tacit prove](https://tacit.finance/prove/) draws it.

## Blocks

A block is one Ethereum transaction that changed the pool's notes: a `settle`, alone or with the deposit it consumes in the same transaction. A
deposit alone (`Wrap` with no note inserted or spent) changes no note and is not a block; it waits for the settle that consumes it.

Blocks are numbered from 0, the first such transaction after the pool's deployment, in Ethereum's order (block number, then log index).

| Field | What it is |
|---|---|
| `height` | the block's number, 0 first |
| `ethBlock`, `tx` | the Ethereum block and transaction |
| `leaves` | the leaves inserted, in log order: `LeavesInserted` leaves, then `LockLeavesInserted` lock leaves |
| `nullifiers` | the nullifiers spent, in log order: `NullifiersSpent`, then the lock nullifiers |
| `notes`, `spent`, `deposits` | counts of note leaves, note nullifiers and `Wrap` logs in the transaction |
| `prev`, `hash` | the previous block's hash and this one's |

```
hash = keccak256(prev ‖ uint64(height) ‖ uint64(ethBlock) ‖ tx ‖ keccak256(leaves[0] ‖ leaves[1] ‖ …) ‖ keccak256(nullifiers[0] ‖ …))
```

Numbers are 8-byte big-endian, hashes and leaves 32 bytes, `prev` of block 0 is 32 zero bytes, and an empty list hashes as `keccak256("")`.

## Cross-chain blocks

The pool spans two chains, and the proofs that carry state between them are blocks too. A cross-chain block is one reflection batch landing
on Ethereum (`attestBitcoinStateProven`): a proof of Bitcoin's tacit transactions up to a Bitcoin height, checked against the light relay's
headers and taken by the pool's verifier, which also folds the newest eth-state proof (Ethereum's finalized state, checked against the beacon
chain's sync committee) that carries the pool's state to the Bitcoin side. Each batch continues the last: its proof starts from the digest
the pool holds and ends at a new one, so the batches chain inside the proofs themselves.

| Field | What it is |
|---|---|
| `digest` | the reflection digest the batch ends at (the pool's `knownReflectionDigest` once it lands) |
| `bitcoin` | the Bitcoin height the batch takes the pool to |
| `ethereum` | the eth-state proof it folds: its digest and the beacon slot it was finalized at |
| `tx`, `ethBlock` | the Ethereum transaction and block it landed in |
| `by` | who proved the batch, when a board worker did (a community address, or Tacit's GPU) |

`GET /prover/blocks` serves the newest as `cross`, and tacit prove draws them among the settles by the Ethereum block they landed in.

## Checkpoints

Once a day the pool's snapshot on IPFS carries a checkpoint, and the text record `tacit.snapshot` of snapshot.tacit.wei names it:

| Part | What it is | Checked against |
|---|---|---|
| `eth` | an Ethereum block and its hash | any Ethereum node |
| `tacit` | the newest block above at or before it: its height and hash | rebuilding the chain from the pool's logs |
| `trees` | the note, lock and position trees' counts and roots | the pool's storage at that block |
| `bitcoin` | the light relay's tip, and the reflection the pool holds: its digest, Bitcoin height and block | the pool's and the relay's storage |
| `ethereum` | the newest eth-state proof folded: its digest, finalized slot and the execution state root it proves | a beacon node: the slot's execution state root |

The execution state root is what makes the rest checkable from proofs alone: any value of the pool (a tree root, a count, whether a given
nullifier is spent) is checked against it with one storage proof (`eth_getProof`), and the root itself is the sync committee's, carried by a
proof the Bitcoin side checks inside its own.

## Who proved a block

A block names its prover when a community prover made the proof of one of its notes: the proof pool records, for each proof it takes, the
leaf it inserts and the address its points went to (`proof-pool.js minedBy`). That block shows the address and the points the proof earned,
paid in TAC by the points service (points × the day's most per point). Proofs made any other way, including by Tacit's own provers, name
nobody. A cross-chain block names its prover the same way, from the board (`prover-board.js`, the Bitcoin-state program).

Between proofs the same machines mine deploy salts: CreateX salts that only Tacit's deployer can use, for addresses with leading zero bytes
(`salt-pool.js`). They share what the day's proofs leave of the mining campaign's daily points.

## Roles, now and next

- **Holders** prove what holds their key on their own device (the stage of a staged swap, a send): no one else ever sees it.
- **Provers** prove what holds no secret (deposits, presses, batches of deposits) and are paid in TAC for each proof the pool takes:
  tacit-prover on a laptop today, GPUs for the work that must be fast next.
- **Relays** send proved settles to Ethereum and are paid the settle's fee. Anyone may: `settle` takes any caller with a valid proof. A prover
  may run one too; the open board (`GET /confidential/open`) is what a relay reads.
- **Bitcoin provers** prove the reflection batches, the cross-chain blocks (large GPUs, `prove-gpu.sh`), and are paid in TAC for each one
  the relay takes from the board.

The aim is a network: every role taken by whoever shows up, Tacit's own provers and relay one participant among them, and in time not needed.
A chain whose blocks anyone can rebuild, and whose block producers are named by what they proved, is what a rollup of Tacit's own would need
first; the block format above is meant to carry over unchanged.
