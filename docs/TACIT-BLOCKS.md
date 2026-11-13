# The tacit chain: private TAC in blocks

A validity rollup for one asset, TAC. Spenders prove their own spends on their own devices (the Bitcoin shielded pool's Halo2 circuit,
unchanged); a block program checks a whole block of them in one SP1 run; Ethereum checks one Groth16 proof, holds the TAC, and takes the
block's data. Nothing in it has an owner or an upgrade key: the program, the verifier and the contract are fixed at deployment, and a new
design is a new chain that each user moves their own notes to (Migrate, below).

Live on Ethereum mainnet: `TacitBlocks` `0x00000000000a9147ffd8d41d152d730ca5f84e6c`, `TacitSeats`
`0x00000000001f703eae70de3b528213e4802790fb`, the leader's API at https://tacit-chain-leader.onrender.com
([deployments](./DEPLOYMENTS.md#tacit-chain-ethereum)). Using it: [tacit.finance/docs/chain](https://tacit.finance/docs/chain/); the
live chain: [tacit.finance/tac](https://tacit.finance/tac/).

| Piece | Where |
|---|---|
| Block program (SP1 guest) | `contracts/sp1/confidential/tacit-block/{guest,common}` |
| Landing contract | `contracts/src/TacitBlocks.sol` |
| Whose turn it is (seat holders) | `contracts/src/TacitSeats.sol` |
| Replays the chain, builds blocks | `contracts/sp1/confidential/tacit-block/node` |
| The leader (follows the contract, proves and lands blocks) | `tacit-leader/` |
| Proves a block on a GPU | `contracts/sp1/confidential/tacit-block/gpu`, or the prover board's `tacit-block` program (`worker/src/prover-board.js`) |
| Wallet and formats | `dapp/tacit-chain-wallet.js`, `dapp/tacit-chain-lock.js`, `dapp/tacit-chain-memo.js` (vectors: `tests/vectors/`) |
| Live view | `dapp/chain/live.js`, on tacit.finance/tac/ |

## Notes and spends

The spend relation is `btc-pool-halo2`'s: two inputs, three outputs, one asset, a deposit and an exit as BabyJubJub Pedersen
commitments, owner signatures over a body hash. `leaf = Poseidon(asset, v, npk, rho)`, `nullifier = Poseidon(nk, leaf, index)`; a note's
keys come from a 33-byte shared secret `s` its sender and recipient both derive (`btc-pool-zk.js` `outputKeys` / `ownedKeys`). The asset
is TAC alone: `SHA-256("tacit-btc-pool-zk-asset-v1" ‖ token) mod r`. TAC amounts are `u64` counts of **UNIT = 10^-8 TAC** (10^10 of the
token's smallest units), the unit the confidential pool and Bitcoin count TAC in. A note's value is a count of **shares** (below).

## Shares and fees

Notes count shares of the chain's pool. The state keeps `pool` (the TAC behind every note, in units) and `shares`; a share is worth
`(pool + V) / (shares + V)` units, `V = 10^8` (a virtual TAC of each, which no note holds: no deposit or burn can set the price alone, and
what is left in a pool with no shares is not the next depositor's). Every spend in a block is priced at the rate before the block.

* **In.** A deposit's opening is shares; its `amount` (TAC) must buy them at the rate (wallets pay a small margin over, 2 bps once the pool
  is large, which stays with the pool).
* **Out.** An exit's, hop's or migration's opening is shares; its `amount` (TAC paid out) is at most their worth less the exit fee:
  `EXIT_FEE_BPS = 10` (0.1%, rounded up) and at least `MIN_POOL_FEE = 200,000` units (0.002 TAC).
* **Payments.** A spend of notes must use its exit slot: an exit, hop, lock, migration, or a **pool share** (`OP_POOL`, 4), shares worth
  at least `MIN_POOL_FEE` that end. A lock's claim or refund note is worth the lock less `lock_fee` (0.1% of its shares, at least one).
* What stays (fees, pool shares, margins) raises every share's worth: holders earn pro rata from what others pay, and no balance is
  shown. The rate only rises. Public word 18 carries `pool ‖ shares` after the block, and the contract requires its pool to equal the TAC
  it holds for the notes (`inChain`).
* The deposit's and exit's amounts are in the body the owners sign: no one between them and the block can change what crosses the edge.

A spend's **body** is what its owners sign. Which kind it is, is fixed by what its data names:

* a payment: `"tacit-block-body-v1" ‖ chain ‖ 3 output leaves ‖ 3 memo hashes ‖ exit address ‖ deposit amount ‖ exit amount ‖ salt`;
* an operation: `"tacit-block-op-body-v1" ‖ chain ‖ 3 output leaves ‖ 3 memo hashes ‖ op ‖ deposit amount ‖ exit amount ‖ salt`, the exit's
  value going into the operation instead of to an address (amounts u64 big-endian, zero for none).

`chain = SHA-256("tacit-block-chain-v1" ‖ chain id ‖ contract)`: derived by the contract, so a spend made for one deployment is void on
any other. The block program checks every body, every opening of a deposit or exit, and that no note is spent twice.

## Operations

* **Hop** (`OP_HOP`, 1): the exit's value is a deposit into the confidential pool for the note `commit` names there. The block publishes
  `asset ‖ value ‖ commit` (96 bytes). Anyone sends it on with `sendHop` / `sendHops`, which calls the pool's `wrap`: the pool burns the TAC
  (it is TAC's minter) and records the deposit. No address of the spender's is in between.
* **Lock** (`OP_LOCK`, 2): the exit's value is put in a leaf of the note tree no spend proof can open, with terms `recipient (BIP-340 key) ‖
  deadline ‖ claimTo ‖ refundTo`. Before the deadline the recipient **claims** it with a BIP-340 signature over
  `SHA-256("tacit-block-claim-v1" ‖ chain ‖ leaf)`, and the block makes the `claimTo` note and publishes the signature; from the deadline
  anyone **refunds** it, making the `refundTo` note. A lock is spent once, by a nullifier in the same tree. This is the chain's half of the
  fast bridge's adaptor swap: the recipient pre-signs its claim adapted to the swap's point T, and the signature the block publishes gives
  the other leg's party the secret `t = s - s~`. A block names a time and lands only within `TIME_WINDOW` (1 h) of it; a claim is taken while
  `time + TIME_WINDOW <= deadline`, a refund from `time >= deadline`. Forced, a claim is posted at least `FORCE_DELAY + WINDOW + TIME_WINDOW`
  and a day before its deadline (the chain must reach it, then prove and land a block early enough), and a refund from `TIME_WINDOW` after
  it; the swap's other leg leaves the same headroom on its own timelock.

* **Migrate** (`OP_MIGRATE`, 3): the exit's value moves to a successor chain the spender names (`to`, its landing contract), for a
  note `note` names there (the successor's own commitment, opaque here). The block publishes the move as `to ‖ SHA-256("tacit-block-
  migrate-v1" ‖ to ‖ note ‖ value)` (52 bytes: the item binds the value and hides it, `note` carrying randomness) and, per successor,
  only the block's total to it; the landing contract sends each total to its successor as the block lands and keeps the hash of the
  block's moves (`migrationsOf(height)`) and each successor's total (`migrated(height, to)`). A successor makes a note from a move
  once it is shown a list with that hash, the move's position in it and the note and value its item binds, using each (height,
  position) once and making no more from a block than its total there. The spend
  proves its notes are among all of this chain's, so a migrated note keeps this chain's anonymity set and its amount stays hidden
  (a block's total to a successor shows what moved there in that block, so a wallet moves in a block others move in too). This is how
  a future chain (post-quantum proofs, or one that does what the confidential pool does) takes users and their privacy with it, with
  no owner or upgrade key: each user names the successor of their own notes.

The chain has no pools or liquidity of its own: swaps and liquidity happen in the confidential pool, where this chain's value arrives by a hop.

## A block

Input: the state, the block's own spends and settles (claims and refunds), the time, an optional blob buffer, and the next entries of the
forced queue (below), with the builder's answers about them. The state is the note tree (Poseidon, depth 32), the nullifier tree (indexed,
SHA-256), the last 32 note roots, the chain binding and the queue's position. The program verifies every proof in **one pairing** (a random
linear combination), applies the block, and commits nineteen 32-byte words:

| # | word | | # | word |
|---|---|---|---|---|
| 0 | state digest before | | 8 | exits hash (tag 5) |
| 1 | state digest after | | 9 | spend relation (its key's hash) |
| 2 | note root before | | 10 | queue position after |
| 3 | note root after | | 11 | queue hash after |
| 4 | new notes hash (leaf ‖ memo hash, tag 1) | | 12 | hops hash (tag 6) |
| 5 | nullifiers hash (tag 2) | | 13 | claims hash (tag 7) |
| 6 | old anchors hash (tag 3) | | 14 | the block's time |
| 7 | deposits hash (tag 4) | | 15 | blobs hash (zero in calldata mode) |
| | | | 16 | migrations hash (tag 8) |
| | | | 17 | successors' totals hash (tag 9) |
| | | | 18 | 16 zero bytes ‖ pool ‖ shares (u64 each) |

Every list is `SHA-256("tacit-block-list-v1" ‖ tag ‖ count ‖ items)`, sorted, so a list's order says nothing of which spend an item came from.
Anyone can rebuild the chain's state from the lists alone (`tacit-block-node replay`).

## Landing (`TacitBlocks.land`)

Only the leader of the current turn may land until `WINDOW` seconds pass with no block, or until a queued entry has waited `FORCE_DELAY +
WINDOW` (leaders that land only the entries they must cannot hold the queue back); then anyone may. Turns (`TacitSeats`) go to seat
holders. A seat is `SEAT` TAC locked with `join()`, given up with `leave(i)` and claimed `EXIT_DELAY` (7 days) later. Time runs in slots of
`SLOT_BLOCKS` Ethereum blocks and epochs of 16 slots; each slot one seat leads, and while no seat is held `BOOTSTRAP` leads. The seat is
drawn by the epoch's seed: the beacon chain's randomness (`prevrandao`) in the first of the epoch's blocks 1 to `SEED_BLOCKS` (4) in which
anyone keeps it (`turn()`), which a leader does as the epoch begins. A block hash would not do (its builder can try as many as it likes); this
way the most anyone chooses is which of four blocks keeps it, and an epoch whose seed no one kept in time has no leader, so anyone may land in
it. On mainnet `WINDOW` is 10 minutes, `FORCE_DELAY` 1 hour, a seat 1,000 TAC and a slot 50 blocks. The contract checks the proof, that the
block extends the held state, the time, the queue, and:

* **Calldata mode** (word 15 = 0): the new notes and memos, nullifiers and claims are in the call, each list checked against its hash.
* **Blob mode** (word 15 != 0): they are in the transaction's blobs. The program builds the data stream, and for each blob (KZG commitment
  `C`) evaluates the blob's polynomial at `z = SHA-256(C ‖ SHA-256(stream)) mod r` itself; it commits SHA-256 of every (versioned hash, `z`,
  `y`). The contract checks each versioned hash is the transaction's blob and that `C` opens to `y` at `z` (the point-evaluation precompile):
  two polynomials that agree at a point drawn after both were fixed are the same, so the blobs hold exactly the stream. The program,
  contract and node build both modes; the live leader lands its blocks in calldata mode. Blob data is pruned by Ethereum after about 18
  days, so wallets and indexers must keep or fetch an archive; calldata is kept for good.
* Deposits, exits, hops, migrations and anchors are always in calldata, since the contract acts on them. A deposit taken in must have been made on L1,
  bound to the shield spend that takes it in, and a spend takes in one deposit ever (its deposit's nullifier, `Poseidon(tag, C, body)`,
  enters the nullifier tree); an exit is credited to its address (`withdraw` sends it on, by anyone). The contract keeps what the chain's
  notes are worth (`inChain`: deposits' amounts taken in, less exits, hops and migrations paid out) and refuses a block that would take out
  more, or whose pool is not that, whatever its proof.
* **Deposits.** `deposit(shares, amount, C, body)` takes approved TAC (records are asset ‖ shares ‖ C ‖ body ‖ amount, 192 bytes). An
  **inbox** takes TAC with no approval and no call: `inbox(shares, amount, C, body, back)` is a CREATE2 address the confidential pool's
  unwrap (which only mints to an address) or anyone pays, and `sweep` (the leader's, or anyone's) takes it in. `sweepWithPermit` takes it
  from a holder with no ETH: the holder's ERC-2612 permit names the inbox, the inbox pulls what it lacks when it is created, and the
  caller, who pays the gas, takes the permit's `fee`. A holder with ETH sends it themselves, their permit naming no fee: one transaction,
  and the deposit is held at once. Anyone may queue the one spend that takes a swept deposit in; if none does within 7 days, `giveBack` wraps it into the
  confidential pool for `back`, and a sweep that finds the spend's key already held by another deposit wraps it there at once. An inbox is
  created once: what is paid to it after its sweep stays there.
* **Hops** are sent by anyone (`sendHop(s)`); one the confidential pool refuses (it takes a commitment once) stays, to be sent again, and
  wallets use a fresh commitment for each.

**Forced inclusion.** Anyone posts a spend (or a claim or refund) to the queue with `force`. Every block takes the queue's next entries in
order, the program taking each sound one and passing over the rest, and a block lands only if it reaches every entry posted `FORCE_DELAY`
or more before (or takes `MAX_FORCED`). So a leader cannot keep a spend out and go on landing, and when leaders stop landing anyone may.

## Memos

Every note is published with a 1,152-byte memo whatever it holds. The program and contract see only its hash and length; what is inside is
the wallets' business. The wallets' memo (`tacit-chain-memo.js`) is hybrid: an ML-KEM-768 ciphertext (1,088) ‖ a secp256k1 ephemeral key
(33) ‖ the value, encrypted (8) ‖ a tag (16) ‖ 7 random bytes, and the shared secret `s` hashes in BOTH exchanges. So an attacker who
later breaks elliptic curves cannot read a recorded memo, compute a note's keys or nullifiers, or link a note to its owner without also
breaking ML-KEM. A wallet recovers its notes from its seed and the published memos alone.

## Wallets and leaders

A wallet (`dapp/tacit-chain-wallet.js`) builds a spend from a seed: the body, the notes with their hybrid memos, each input's EdDSA signature
and the Halo2 proof (the pool's wasm prover, 17-24 s a spend in Node), padded to two output notes so every spend adds the same number of
leaves. It submits to a leader (`POST /spend`), which checks the proof natively, that the spend's asset is TAC, that its root is one a block ended
at, and that a trial block takes it; it finds its notes by trying every published memo (`scan`), which costs a hybrid decapsulation each (8 ms in
pure JS: a wallet recovered from its seed at 100k notes takes minutes, so a WASM ML-KEM and workers are the wallet's to add; no protocol change).
A shield's TAC reaches L1 first, by `TacitBlocks.deposit` or by an inbox the leader sweeps (above); the wallet's spend names its commitment
and body hash, and a leader includes a shield only once its deposit is waiting there.

A leader (`tacit-leader/`) admits only what can land: a block that held a spend of another asset, a deposit not on L1 or a root no block ended at
would revert and could be made to by anyone. Its `POST /build`, `/landed`, `/pending`, `/drop`, `/fee` and `/restore` routes are its own, behind
an admin token. It proves each block on its own GPU (`tacit-block-gpu`) or through the prover board's `tacit-block` program, which community
GPUs race ([tacit.finance/prove](https://tacit.finance/prove/)), and uses the first proof a simulated landing of that block accepts.

### A leader's API

What a wallet uses is public, served by the leader's node (`tacit-block-node`; the live one is https://tacit-chain-leader.onrender.com):

* `GET /state`: height, state digest, note root, counts, the forced queue's position, the chain binding, and `pool` and `shares` (the rate a
  deposit buys at and an exit pays at).
* `GET /notes?from=N&limit=M`, `/pending-notes`, `/path/N`, `/spent/0x…`, `/leaf/0x…`, `/receipt/ID`, `/mempool`: what a wallet scans and
  follows (`/pending-notes`: the new notes of the payments waiting for a block).
* `GET /fee`: `{ address, fee, sweepFee, shieldCap, at, window }`. A spend pays `fee` (units of 1e-8 TAC) in a note to `address`, the leader's
  chain address. `sweepFee` (TAC's own wei) is what a shield paid by permit adds on top, for the leader to send it in (`sweepWithPermit`):
  the gas of the sweep at the base fee and TAC's price, with a margin. `shieldCap` (units) is the most one shield may deposit through this
  leader for now, the launch cap. A quote is honoured for `window` seconds.
* `POST /spend` (a spend, with `back` for a shield paid to its inbox and `permit` for one paid by permit), `POST /settle`, `POST /address`
  and `GET /address/<hash>` (the chain lane's directory), and `POST /forced`: the bytes `TacitBlocks.force` takes for a spend no leader takes.
* `POST /address` with `key` and `sig` also keeps the address under a Tacit key: `sig` is the key's signature over
  SHA-256("tacit-chain-key-v1" ‖ key ‖ address), checked by the leader. `GET /address/key/<key>` returns `{ address, sig }`, so a Tacit address
  from before the chain (it carries the key, not the chain lane) is paid on the chain; the payer checks the signature again.

What waits is written to a file (`TACIT_NODE_MEMPOOL`) and admitted again after a restart, each entry checked as a new submission; wallets
also hand their kept spends over again the next time they open. A deposit or a paid inbox waits on Ethereum, so nothing is lost. A leader
rebuilds the chain when it starts, from its archive of landed blocks or from the contract's events.

## What each party sees

* **Everyone**: deposits, exits and hops (amounts and addresses, on Ethereum), each block's total to a successor chain, the count of notes
  and nullifiers per block, the time.
* **Not the public**: which spend made which note, any amount inside the chain, who paid whom.
* **A block's prover**: each spend's nullifiers beside its output leaves, within one block. A nullifier cannot be tied to the leaf it spends
  without its owner's key, so the prover cannot tie a spend's new notes to the notes it spent. It never sees keys, values or owners.
* **Quantum**: hidden amounts and note linkage hold (above). Proof forgery does not: Halo2-KZG and the Groth16 wrap are pairing-based, as is
  Ethereum's verifier, so the chain's soundness waits on post-quantum proofs, as every Ethereum rollup's does.

## Tests

`tacit-block test` (the program on a test chain, with its refusals), `tacit-block fixture` (a nine-block chain with the landing contract's
inputs), `tacit-block-node replay` (the same chain rebuilt from published data alone), `tests/tacit-chain-wallet.test.mjs` (the wallet's real proofs against the leader's node), `tests/tacit-leader-anvil.mjs` and `tests/tacit-chain-user-story.mjs` (the leader, and a user's whole story from an L1 deposit to a withdrawal and a hop, on a mainnet fork), `forge test` (`TacitBlocks.t.sol`: the landing rules;
`TacitBlocksFork.t.sol`: the real Groth16 proofs through SP1's verifier and hops into the live confidential pool on a mainnet fork, with
`TACIT_BLOCKS_FORK_RPC`), and `node --test tests/tacit-chain-*.test.mjs`.
