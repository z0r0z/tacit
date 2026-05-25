# tETH: Trustless ETH-Bitcoin Bridge

tETH lets users deposit ETH (or any ERC-20) on Ethereum, mint composable tETH on Tacit (Bitcoin L1), trade/transfer it freely, burn it, and withdraw the original asset — all without trusted roles, attestors, or multisigs.

```
                          FULLY TRUSTLESS

    Ethereum                                Bitcoin (Tacit)
    --------                                ---------------

    deposit(commitment, denom)
      |
      | ETH/ERC-20 locked
      | leaf added to Poseidon tree
      |
      |              T_BRIDGE_DEPOSIT (OP_RETURN)
      |  - - - - - - - - - - - - - - - - - ->  SP1 verifies Groth16,
      |                                         inserts leaf into pool
      |
      |                                         tETH is composable:
      |                                           transfer, trade,
      |                                           LP, farm, swap
      |
      |              T_BRIDGE_BURN (OP_RETURN)
      |  < - - - - - - - - - - - - - - - - -   burn tETH on Tacit
      |
      | SP1 proof submitted (permissionless)
      | burn claim accepted
      |
    withdrawFromBurn(rawBtcTx, ...)
      |
      ETH/ERC-20 released to recipient


  +--------------------------------------------------+
  |              TacitBridgeMixer                     |
  |                                                   |
  |  deposit()         -> Poseidon tree, funds locked |
  |  batchDeposit()    -> multi-denom in one tx       |
  |                                                   |
  |  withdrawFromBurn() ->                            |
  |    1. relay-verified Bitcoin inclusion             |
  |    2. SP1-accepted exact burn claim               |
  |    3. Groth16 burn proof + bindHash               |
  |    4. pool balance solvency check                 |
  |                                                   |
  |  No attestor. No guardian. No owner.              |
  |  No trusted roles of any kind.                    |
  +--------------------------------------------------+
           |                          |
  +------------------+   +-------------------------+
  | BitcoinLightRelay|   | SP1PoolRootVerifier     |
  | (heaviest chain) |   | (anyone can prove)      |
  | (permissionless) |   | (one per denomination)  |
  +------------------+   +-------------------------+
```

## Security layers

Each withdrawal must pass all of these independently:

1. **Bitcoin relay** — proves the burn tx is on canonical Bitcoin (heaviest chain, 6 confirmation depth)
2. **SP1 state proof** — proves the pool root from complete Bitcoin blocks with Groth16 verification of every envelope inside the zkVM
3. **Accepted burn registry** — only SP1-proven burns (exact claim ID bound to nullifier + denomination + pool root + recipient + bind hash) can trigger withdrawals. Burns survive later state advancement.
4. **Groth16 burn proof** — proves the withdrawer knows a leaf's preimage (secret + nullifier) without revealing which deposit it corresponds to
5. **bindHash** — domain-bound to chainid + contract address + all envelope fields, verified independently by both SP1 guest and Solidity mixer, preventing cross-chain replay and envelope field substitution
6. **Pool balance** — withdrawals cannot exceed deposited funds

No single layer is sufficient alone. An attacker would need to break Bitcoin PoW, forge an SP1 proof, forge a Groth16 proof, AND have the pool contain funds.

## Ethereum-only privacy

Users can use the bridge purely for Ethereum privacy without interacting with Tacit:

1. Deposit ETH from address A
2. Mint tETH on Bitcoin (OP_RETURN, can be automated)
3. Immediately burn tETH, naming a fresh Ethereum address B as recipient
4. Wait for SP1 proof
5. Withdraw ETH to address B

There is no on-chain link between A and B. The Groth16 proof proves knowledge of a deposit commitment without revealing which one. The anonymity set is the entire pool for that denomination — shared between privacy users and users who actually transact on Tacit.

Steps 2-4 can be abstracted by a relayer or the dApp so the user just sees "deposit, wait, withdraw to new address."

## ERC-20 support

The same `TacitBridgeMixer` contract handles native ETH and any ERC-20. The `TOKEN` immutable determines the asset:

- `address(0)` — native ETH. Deposits via `msg.value`, withdrawals via `forceSafeTransferETH`.
- Any ERC-20 — deposits via `safeTransferFrom` with exact balance-delta accounting (rejects fee-on-transfer tokens). Withdrawals via `safeTransfer`.

```
TOKEN = address(0)    ->  ETH bridge
TOKEN = 0xA0b8...     ->  USDC bridge
TOKEN = 0x2260...     ->  WBTC bridge
```

Same contract, same bytecode, different constructor args. Deploy once per asset.

### Decimal handling

The contract queries `decimals()` on-chain at deployment and computes `UNIT_SCALE`:

| Token | Decimals | UNIT_SCALE | Alignment |
|-------|----------|------------|-----------|
| ETH   | 18       | 10^10      | denom must be divisible by 1e10 |
| DAI   | 18       | 10^10      | same as ETH |
| USDC  | 6        | 1          | any denomination works |
| WBTC  | 8        | 1          | perfect 1:1 with Tacit |
| USDT  | 6        | 1          | any denomination works |

Tokens with >8 decimals are automatically aligned so every denomination maps to a whole Tacit unit (8 decimals, Bitcoin standard). Tokens with <=8 decimals need no alignment. Denominations must also be less than the BN254 field size (required for Groth16 provability). A misaligned or out-of-range denomination reverts the deploy.

### Denomination pools

The mixer supports fixed denomination pools. For ETH: 0.001 / 0.01 / 0.1 / 1 / 10 / 100 ETH (6 pools). Each denomination has its own Poseidon tree, root history, and SP1 verifier. Denomination is inside the Groth16 public inputs — cross-denomination proofs fail at the circuit level.

`batchDeposit()` splits a single transaction into multiple denomination commitments. The dApp decomposes arbitrary amounts into denomination chunks automatically — a 2.731 ETH deposit becomes `2x1 + 7x0.1 + 3x0.01 + 1x0.001` in one transaction. Dust below 0.001 ETH stays in the user's wallet.

### Groth16 circuit

The bridge reuses the existing Tacit `withdraw.circom` circuit and trusted setup ceremony. The circuit proves:

- Knowledge of `(secret, nullifier)` such that `PoseidonT3(secret, nullifier) = commitment`
- `commitment` is a leaf in the Poseidon Merkle tree at the claimed root
- The nullifier hash, denomination, recipient leaf, and bind hash are correctly derived

This is the same circuit used for all Tacit privacy operations (transfers, burns). No new ceremony is needed for the bridge.

## Architecture

```
+---------------------+     +-------------------+
|  TacitBridgeMixer   |     | BitcoinLightRelay |
|  (one per asset)    |     | (shared, one)     |
|                     |     |                   |
|  pools[]:           |     | epoch targets     |
|    0.001 ETH pool   |---->| cumulative work   |
|    0.01  ETH pool   |     | heaviest-chain    |
|    0.1   ETH pool   |     | tip tracking      |
|    1     ETH pool   |     +-------------------+
|    10    ETH pool   |
|    100   ETH pool   |     +-------------------------+
|                     |     | SP1PoolRootVerifier     |
|  per pool:          |     | (one per denomination)  |
|    Poseidon tree    |     |                         |
|    root accumulator |     | incremental state       |
|    burn nullifiers  |<----| accepted burn claims    |
|    balance          |     | state commitment        |
|    verifier link    |     | domain binding          |
+---------------------+     +-------------------------+
```

### SP1 guest program

The guest runs inside the zkVM and processes complete Bitcoin blocks:

- Reads previous state (pool frontier + nullifier set) as private witness
- Verifies state commitment ties frontier/nullifiers to the previous proof's public values
- For each block: verifies header PoW + chain linkage, reads ALL transactions, recomputes the block merkle root from all txids (Bitcoin's own completeness rule)
- Scans every OP_RETURN for Tacit envelopes matching the target denomination
- Verifies bindHash for every envelope (mint and burn) by recomputing from the full domain preimage — prevents envelope field substitution/front-running
- Verifies the Groth16 proof inside each envelope using a cached prepared verifying key (ark-groth16 BN254), rejecting non-canonical field elements (>= BN254 modulus) in both public inputs and inserted leaves
- Burns must reference a pool root the guest has actually produced (tracked via `known_pool_roots`) — prevents fake-tree membership proofs
- Invalid or malformed envelopes (bad proofs, wrong bindHash, duplicate nullifiers, short payloads) are silently skipped, not panicked — the guest cannot be bricked by adversarial Bitcoin OP_RETURN data
- Deposits: verifies deposit bindHash, inserts leaf into pool tree
- Burns: validates pool root + burn bindHash, consumes nullifier, records exact burn claim ID = SHA256(nullifier + denom + poolRoot + recipient + bindHash)
- Rotations: not yet implemented (§5.62 dual-proof format); tETH transfers use native Tacit operations instead
- Commits 461 bytes of public values: prev/new roots, state commitment, deposit accumulator, VK hash, burn batch hash, domain binding (asset, network, chain, mixer, denomination)

### Incremental proofs

Each SP1 proof chains from the previous proven state:

```
Proof N                          Proof N+1
-------                          ---------
processes blocks 100-200         processes blocks 201-300
state: root_A -> root_B         state: root_B -> root_C
commitment_B stored              must match commitment_B to start
```

- Pool tree restored from frontier (verified against root via `verify_root_from_frontier`)
- Nullifier set restored from pre-sorted list (hash verified against committed state)
- State commitment = SHA256(pool root + null set hash + height + pool frontier + null count)
- Verifier checks all 5 prev-state fields + state commitment before accepting
- Only new Bitcoin blocks since the last proof are processed

### Nullifier set

Cross-batch nullifier uniqueness is enforced via a hash-committed sorted set:

```
from_sorted():  O(n) verify sorted + unique
insert():       O(log n) vs sorted history + O(k) vs pending batch
finalize():     O(k log k) sort pending, O(k) dedup, O(n + k) merge
hash():         O(n) SHA256 of sorted set (must call finalize first)
```

The prover supplies the full historical nullifier list (pre-sorted). The guest verifies sorted order, checks new nullifiers via binary search against history and linear scan against pending, collects pending inserts, then merge-sorts new into old with duplicate detection at every stage. Duplicate nullifiers from adversarial envelopes are rejected at insert time — they cannot brick the proof.

The Ethereum contract's `burnNullifiers` mapping provides a second layer of double-spend protection at withdrawal time.

## Scaling

### V1 capacity

| Component | Cost | Notes |
|-----------|------|-------|
| Deposit (on-chain) | O(1) | Poseidon tree insert + root accumulator update |
| Withdrawal (on-chain) | O(1) | Relay check + Groth16 verify + burn claim lookup |
| SP1 proof submission | O(1) | Accumulator comparison, constant SP1 verify |
| SP1 proving (off-chain) | O(new blocks + n + k log n) | n = total nullifiers, k = new transitions |

V1 comfortably handles tens of thousands of deposits per pool — comparable to Tornado Cash's largest pool (~30k lifetime deposits). The prover is nearly stateless: fetch blocks, pass sorted nullifier list, generate proof. No database, no persistent state.

Each pool caps at 2^20 (~1M) leaves. Across 6 denominations that's ~6M total deposits per mixer deployment.

### Scaling roadmap

| Threshold | Approach | Status |
|-----------|----------|--------|
| 0 - 30k deposits | Sorted nullifier list, full deposit root witness | Shipped |
| 30k - 100k | Benchmark SP1 proving times, optimize witness packing | Planned |
| 100k+ | Sparse Merkle nullifier tree (O(log n) per insert, no full list) | Designed |
| 100k+ | Delta deposit root accumulator (only new roots in witness) | Designed |

The sparse Merkle upgrade is a drop-in replacement for the nullifier module in the SP1 guest. Since the mixer is immutable (no admin keys), upgrading requires deploying new verifiers and a new mixer. Users migrate by withdrawing from the old mixer and depositing into the new one. This is a deliberate trustlessness tradeoff.

## Deployment

Each bridge deployment consists of:

- 1 `BitcoinLightRelay` (shared across all bridges on the same chain)
- 1 `TacitBridgeMixer` per asset (ETH, USDC, etc.)
- 1 `SP1PoolRootVerifier` per denomination per asset (6 for ETH)
- 1 Groth16 verifier (reuses existing Tacit withdraw.circom ceremony)

The deploy script predicts the mixer address via nonce, deploys all verifiers with that address baked in, then deploys the mixer which validates the wiring at construction (pool ID, denomination, asset ID, mixer address). Any mismatch reverts the entire transaction.

For an ETH bridge: 1 relay + 6 verifiers + 1 mixer = 8 contracts. For USDC: reuse the same relay, deploy 1 mixer + N verifiers.

## Proving

The SP1 host program fetches Bitcoin blocks from any block explorer API, feeds headers + all raw transactions to the guest, and generates proofs. Run it periodically to advance pool state:

```
cargo run --release -- --start-height <last_proven + 1> --num-blocks <n>
```

Anyone can run the prover. It is fully permissionless. Multiple provers can race — the first valid submission wins.

If a deposit occurs between proof generation and submission, the deposit root accumulator changes and the proof becomes stale. The prover retries with updated state. Same if the relay tip advances. This is a liveness constraint, not a security issue.

## Known limitations

### Relay reorg recovery

The V1 verifier assumes the relay tip extends the last SP1-proven block. If the relay reorgs onto a branch that does not descend from the last SP1-proven block, SP1 state advancement is blocked — no valid proof can chain from the stored state to the new tip. This requires redeployment of the affected verifiers (users migrate via withdraw + re-deposit). On Bitcoin mainnet, reorgs deeper than a few blocks are essentially unprecedented. A future relay upgrade could add ancestor checking or finality-depth targeting to handle this automatically.

### Migration path

The mixer is intentionally immutable with no admin keys. Upgrading the SP1 program (e.g., sparse Merkle nullifier tree) requires deploying new verifiers and a new mixer. Users migrate by withdrawing from the old mixer and depositing into the new one. This is a deliberate trustlessness tradeoff — no upgrade mechanism means no one can change the rules after deployment.

### One burn per Bitcoin transaction

Both the Solidity mixer and the SP1 guest process at most one burn envelope per Bitcoin transaction. If a user constructs a transaction with two burn envelopes, only the first is processed. This is enforced for consistency between on-chain extraction and off-chain proving.

### Bitcoin OP_RETURN envelope size

Bridge envelopes (281-537 bytes) exceed historical default OP_RETURN limits. Bitcoin Core 30.0+ sets `datacarriersize` to 100,000 bytes by default, which accommodates bridge envelopes. The canonical encoding is a single OP_RETURN output with OP_PUSHDATA2 (0x4D) followed by the envelope payload. Both Solidity and SP1 parsers handle OP_PUSHDATA1 (0x4C) and OP_PUSHDATA2 (0x4D); OP_PUSHDATA4 (0x4E) is not supported (non-standard, never seen in practice).

### Relay consensus subset

The Bitcoin light relay implements a simplified subset of Bitcoin consensus: header PoW, chain linkage, difficulty retarget with 4x clamping, and heaviest-chain fork choice via cumulative work. It does not enforce median-time-past or future-time constraints. The primary security guarantee is real Bitcoin PoW — producing valid headers requires the same hash power as attacking Bitcoin itself.
