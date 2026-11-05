# The Tacit chain

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

## Who proved a block

A block names its prover when a community prover made the proof of one of its notes: the proof pool records, for each proof it takes, the
leaf it inserts and the address its points went to (`proof-pool.js minedBy`). That block shows the address and the points the proof earned,
paid in TAC by the points service (points × the day's most per point). Proofs made any other way, including by Tacit's own provers, name
nobody.

## Roles, now and next

- **Holders** prove what holds their key on their own device (the stage of a staged swap, a send): no one else ever sees it.
- **Provers** prove what holds no secret (deposits, presses, batches of deposits) and are paid in TAC for each proof the pool takes:
  tacit-prover on a laptop today, GPUs for the work that must be fast next.
- **Relays** send proved settles to Ethereum and are paid the settle's fee. Anyone may: `settle` takes any caller with a valid proof. A prover
  may run one too; the open board (`GET /confidential/open`) is what a relay reads.

The aim is a network: every role taken by whoever shows up, Tacit's own provers and relay one participant among them, and in time not needed.
A chain whose blocks anyone can rebuild, and whose block producers are named by what they proved, is what a rollup of Tacit's own would need
first; the block format above is meant to carry over unchanged.
