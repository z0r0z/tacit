# The tacit chain: private TAC in blocks

A validity rollup for one asset, TAC. Spenders prove their own spends on their own devices (the Bitcoin shielded pool's Halo2 circuit,
unchanged); a block program checks a whole block of them in one SP1 run; Ethereum checks one Groth16 proof, holds the TAC, and takes the
block's data. Nothing in it has an owner or an upgrade key: the program, the verifier and the contract are fixed at deployment, and a new
design is a new chain that users move to through the confidential pool (V1) in one transaction.

| Piece | Where |
|---|---|
| Block program (SP1 guest) | `contracts/sp1/confidential/tacit-block/{guest,common}` |
| Landing contract | `contracts/src/TacitBlocks.sol` |
| Whose turn it is (TAC stakers) | `contracts/src/TacitSeats.sol` |
| Replays the chain, builds blocks | `contracts/sp1/confidential/tacit-block/node` |
| Wallet formats | `dapp/tacit-chain-lock.js`, `dapp/tacit-chain-memo.js` (vectors: `tests/vectors/`) |

## Notes and spends

The spend relation is `btc-pool-halo2`'s: two inputs, three outputs, one asset, a deposit and an exit as BabyJubJub Pedersen
commitments, owner signatures over a body hash. `leaf = Poseidon(asset, v, npk, rho)`, `nullifier = Poseidon(nk, leaf, index)`; a note's
keys come from a 33-byte shared secret `s` its sender and recipient both derive (`btc-pool-zk.js` `outputKeys` / `ownedKeys`). The asset
is TAC alone: `SHA-256("tacit-btc-pool-zk-asset-v1" ‖ token) mod r`. A value is a `u64` count of **UNIT = 10^-8 TAC** (10^10 of the token's
smallest units), the unit the confidential pool and Bitcoin count TAC in, so a value moves between them unchanged.

A spend's **body** is what its owners sign. Which kind it is, is fixed by what its data names:

* a payment: `"tacit-block-body-v1" ‖ chain ‖ 3 output leaves ‖ 3 memo hashes ‖ exit address ‖ salt`;
* an operation: `"tacit-block-op-body-v1" ‖ chain ‖ 3 output leaves ‖ 3 memo hashes ‖ op ‖ salt`, the exit's value going into the operation
  instead of to an address.

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

The chain has no pools or liquidity of its own: swaps and liquidity happen in the confidential pool, where this chain's value arrives by a hop.

## A block

Input: the state, the block's own spends and settles (claims and refunds), the time, an optional blob buffer, and the next entries of the
forced queue (below), with the builder's answers about them. The state is the note tree (Poseidon, depth 32), the nullifier tree (indexed,
SHA-256), the last 32 note roots, the chain binding and the queue's position. The program verifies every proof in **one pairing** (a random
linear combination), applies the block, and commits sixteen 32-byte words:

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

Every list is `SHA-256("tacit-block-list-v1" ‖ tag ‖ count ‖ items)`, sorted, so a list's order says nothing of which spend an item came from.
Anyone can rebuild the chain's state from the lists alone (`tacit-block-node replay`).

## Landing (`TacitBlocks.land`)

Only the leader of the current turn may land until `WINDOW` seconds pass with no block, or until a queued entry has waited `FORCE_DELAY +
WINDOW` (leaders that land only the entries they must cannot hold the queue back); then anyone may. Turns (`TacitSeats`) are TAC stakers
drawn by the epoch's seed: the beacon chain's randomness (`prevrandao`) in the first block of the epoch's first `SEED_BLOCKS` (4) in which
anyone keeps it, which a leader does as the epoch begins. A block hash would not do (its builder can try as many as it likes); this way the
most anyone chooses is which of four blocks keeps it, and an epoch whose seed no one kept in time has no leader, so anyone may land in it. The contract checks the proof, that the block extends the held state, the time, the queue, and:

* **Calldata mode** (word 15 = 0): the new notes and memos, nullifiers and claims are in the call, each list checked against its hash.
* **Blob mode** (word 15 != 0): they are in the transaction's blobs. The program builds the data stream, and for each blob (KZG commitment
  `C`) evaluates the blob's polynomial at `z = SHA-256(C ‖ SHA-256(stream)) mod r` itself; it commits SHA-256 of every (versioned hash, `z`,
  `y`). The contract checks each versioned hash is the transaction's blob and that `C` opens to `y` at `z` (the point-evaluation precompile):
  two polynomials that agree at a point drawn after both were fixed are the same, so the blobs hold exactly the stream. The leader picks
  the mode per block, whichever costs less. Blob data is pruned by Ethereum after about 18 days, so wallets and indexers must keep or fetch
  an archive; calldata is kept for good.
* Deposits, exits, hops and anchors are always in calldata, since the contract acts on them. A deposit taken in must have been made on L1,
  bound to the shield spend that takes it in, and a spend takes in one deposit ever (its deposit's nullifier, `Poseidon(tag, C, body)`,
  enters the nullifier tree); an exit is credited to its address (`withdraw` sends it on, by anyone). The contract keeps what the chain's
  notes are worth (`inChain`: deposits taken in, less exits and hops) and refuses a block that would take out more, whatever its proof.
* **Deposits.** `deposit` takes approved TAC. An **inbox** takes TAC with no approval and no call: `inbox(value, C, body, back)` is a
  CREATE2 address the confidential pool's unwrap (which only mints to an address) or anyone pays, and `sweep` (the leader's, or anyone's)
  takes it in. Anyone may queue the one spend that takes a swept deposit in; if none does within 7 days, `giveBack` wraps it into the
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
A shield first makes the deposit on L1 (`TacitBlocks.deposit`), whose commitment and body hash the wallet's spend names; a leader includes a
shield only once its deposit is waiting there.

A leader (`tacit-leader/`) admits only what can land: a block that held a spend of another asset, a deposit not on L1 or a root no block ended at
would revert and could be made to by anyone. Its `/build` and `/landed` routes are its own.

## What each party sees

* **Everyone**: deposits, exits and hops (amounts and addresses, on Ethereum), the count of notes and nullifiers per block, the time.
* **Not the public**: which spend made which note, any amount inside the chain, who paid whom.
* **A block's prover**: each spend's nullifiers beside its output leaves, within one block. A nullifier cannot be tied to the leaf it spends
  without its owner's key, so this is less than Zcash shows the whole world. It never sees keys, values or owners.
* **Quantum**: hidden amounts and note linkage hold (above). Proof forgery does not: Halo2-KZG and the Groth16 wrap are pairing-based, as is
  Ethereum's verifier, so the chain's soundness waits on post-quantum proofs, as every Ethereum rollup's does.

## Tests

`tacit-block test` (the program on a test chain, with its refusals), `tacit-block fixture` (a nine-block chain with the landing contract's
inputs), `tacit-block-node replay` (the same chain rebuilt from published data alone), `tests/tacit-chain-wallet.test.mjs` (the wallet's real proofs against the leader's node), `tests/tacit-leader-anvil.mjs` and `tests/tacit-chain-user-story.mjs` (the leader, and a user's whole story from an L1 deposit to a withdrawal and a hop, on a mainnet fork), `forge test` (`TacitBlocks.t.sol`: the landing rules;
`TacitBlocksFork.t.sol`: the real Groth16 proofs through SP1's verifier and hops into the live confidential pool on a mainnet fork, with
`TACIT_BLOCKS_FORK_RPC`), and `node --test tests/tacit-chain-*.test.mjs`.
