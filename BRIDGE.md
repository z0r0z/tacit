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
      |              T_BRIDGE_DEPOSIT (Taproot reveal)
      |  - - - - - - - - - - - - - - - - - ->  SP1 verifies Groth16,
      |                                         inserts leaf into pool
      |
      |                                         tETH is composable:
      |                                           transfer, trade,
      |                                           LP, farm, swap
      |
      |              T_BRIDGE_BURN (Taproot reveal)
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
  | (permissionless) |   | (one per asset)         |
  +------------------+   +-------------------------+
```

## Where it sits vs. existing bridges

| Bridge | Trust model | Privacy |
|--------|------------|---------|
| Multichain / Ronin | Multisig (both hacked) | None |
| Wormhole | Guardian set (hacked) | None |
| tBTC v2 | Random beacon + bonds | None |
| zkBridge / Succinct | ZK light client | None |
| **tETH (Tacit)** | **ZK light client + mixer** | **Full: deposit ↔ withdrawal unlinkable** |

tETH is in the ZK light-client category (same trust assumptions as zkBridge) but with a mixer privacy layer that none of the others have. The Groth16 anonymity set means there is no on-chain link between a deposit and its corresponding withdrawal — shared across all users of the same denomination pool.

## Security layers

Each withdrawal must pass all of these independently:

1. **Bitcoin relay** — proves the burn tx is on canonical Bitcoin (heaviest chain, 6 confirmation depth)
2. **SP1 state proof** — proves the pool root from complete Bitcoin blocks with Groth16 verification of every envelope inside the zkVM
3. **Accepted burn registry** — only SP1-proven burns (exact claim ID bound to nullifier + denomination + pool root + recipient + bind hash) can trigger withdrawals. Burns survive later state advancement.
4. **Groth16 burn proof** — proves the withdrawer knows a leaf's preimage (secret + nullifier) without revealing which deposit it corresponds to
5. **bindHash** — domain-bound to chainid + contract address + all envelope fields, verified independently by both SP1 guest and Solidity mixer, preventing cross-chain replay and envelope field substitution
6. **Pool balance** — withdrawals cannot exceed deposited funds

No single layer is sufficient alone. An attacker would need to break Bitcoin PoW, forge an SP1 proof, forge a Groth16 proof, AND have the pool contain funds.

### Client-side verification

Every dApp client independently verifies bridge deposit leaves before accepting them into the local pool tree:

1. **Groth16 proof** — the proof in the reveal-witness envelope is re-verified against the canonical VK (inlined, no IPFS dependency)
2. **Ethereum deposit root** — the `ethRoot` in the envelope is checked against the mixer contract's `isKnownDepositRoot` via `eth_call` to public RPCs (publicnode, llamarpc, 1rpc, drpc — no API key required)

Invalid proofs or fabricated roots are rejected before entering anyone's local state. Fake tETH cannot circulate in DeFi — it's caught at every layer.

### Recovery

All bridge state is deterministically recoverable from the wallet's private key:

- **Deposit keys**: `HMAC(privkey, domain || index)` for each deposit index
- **Pool notes**: re-derive (secret, nullifier) → compute commitment → match against Ethereum deposit events
- **Shielded UTXOs**: re-derive stealth blinding → compute stealth address → scan chain for UTXOs

No localStorage, no server state, no backup phrases beyond the wallet key. The dApp's "Recover Notes" function and "Rescan UTXOs" button both trigger this recovery automatically.

## User flow

Deposit ETH to spendable tETH in one click:

1. User connects MetaMask, picks amount, signs one Ethereum tx
2. dApp auto-detects Ethereum confirmation
3. Auto-mints tETH on Bitcoin (Groth16 proof, ~1-2s)
4. Polls for 3 Bitcoin confirmations
5. Auto-withdraws to a shielded address (second Groth16 proof)
6. tETH appears in Holdings as a regular spendable coin

Burn tETH back to ETH:

1. User enters Ethereum recipient address
2. dApp builds merkle proof, generates Groth16 proof (~1-2s)
3. Broadcasts T_BRIDGE_BURN on Bitcoin
4. Waits for 6 confirmations
5. Submits Bitcoin inclusion proof to Ethereum contract
6. ETH released to recipient

Quick burn from holdings (for users who received tETH via transfer):

1. dApp imports the tETH UTXO into a matching denomination pool
2. Waits for pool indexing
3. Burns the pool note in one flow

## Ethereum-only privacy

Users can use the bridge purely for Ethereum privacy without interacting with Tacit:

1. Deposit ETH from address A
2. Mint tETH on Bitcoin (Taproot reveal, can be automated)
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

The Poseidon commitment uses the 8-decimal Tacit denomination, not the native token denomination. For ETH: `commitment = poseidon3(secret, nu, denomination / UNIT_SCALE)`. The Solidity contract maps back to wei at withdrawal time via `weiDenom = denomTacit * UNIT_SCALE`. The circuit, ceremony, and VK are unchanged — only the denomination value changes. This keeps tETH an 8-decimal asset on Tacit, consistent with all other Tacit assets.

### Denomination pools

The mixer supports fixed denomination pools. For ETH: 0.00001 / 0.0001 / 0.001 / 0.01 / 0.1 / 1 / 10 / 100 ETH (8 pools). Each denomination has its own Poseidon Merkle tree on both Ethereum and Bitcoin. A single SP1 guest processes all denominations for the asset, maintaining one tree per denomination, one shared nullifier set, and one shared UTXO set. Denomination is inside the Groth16 public inputs — cross-denomination proofs fail at the circuit level.

`batchDeposit()` splits a single transaction into multiple denomination commitments. The dApp decomposes arbitrary amounts into denomination chunks automatically — a 2.731 ETH deposit becomes `2x1 + 7x0.1 + 3x0.01 + 1x0.001` in one transaction. Dust below 0.00001 ETH stays in the user's wallet.

### UTXO fungibility

tETH is fully fungible as a UTXO asset outside the pool. The pool is a denomination-specific "slot" for privacy and ETH withdrawal; the UTXO layer is free-form.

- **Export** (T_BRIDGE_EXPORT, 0x63): Groth16-proven, consumes pool note nullifier, creates a denomination-tagged UTXO in the shared set
- **CXFER**: transfer any amount to anyone, split/merge freely. The SP1 guest verifies Pedersen conservation: each output commitment is opened (amount + blinding verified against the NUMS generator H), and `sum(output amounts) == sum(input amounts)`. Amounts are u64, no negatives.
- **Import** (T_BRIDGE_IMPORT, 0x64): consumes a UTXO whose verified amount matches the target pool denomination, creates a new pool leaf. Cross-denomination: export 0.1, CXFER 0.01 to someone, they import into the 0.01 pool.

The CXFER conservation witness (Pedersen openings) is provided by the host prover via a JSON file. CXFERs without openings are not tracked — tETH still transfers on Bitcoin, but those outputs cannot re-enter the pool until a prover provides the openings in a subsequent proof batch.

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
|  pools[] (8 denoms):|     | epoch targets     |
|    0.00001 ETH      |---->| cumulative work   |
|    0.0001 ETH       |     | heaviest-chain    |
|    0.001 / 0.01 ETH |     | tip tracking      |
|    0.1 / 1 ETH      |     +-------------------+
|    10 / 100 ETH     |
|    one tree each    |     +-------------------------+
|                     |     | SP1PoolRootVerifier     |
|  per pool:          |     | (one per ASSET)         |
|    Poseidon tree    |     |                         |
|    root accumulator |     | all denomination state  |
|    burn nullifiers  |<----| accepted burn claims    |
|    balance          |     | state commitment        |
|    verifier link ---+---->| domain binding          |
+---------------------+     +-------------------------+
```

### SP1 guest program

The guest runs inside the zkVM and processes complete Bitcoin blocks for ALL denominations of an asset in a single proof:

- Reads N denomination configs, per-denomination previous state (tree frontier + index), and shared state (nullifier set + UTXO set) as private witness
- Verifies state commitment ties all trees/nullifiers/UTXOs to the previous proof's public values
- For each block: verifies header PoW + chain linkage, reads ALL transactions, recomputes the block merkle root from all txids (Bitcoin's own completeness rule)
- Extracts each Tacit envelope from its Taproot script-path reveal (`vin[0]` witness item 1), routes each to the correct denomination tree by matching `env_denom` against the denomination list
- Verifies bindHash for every envelope by recomputing from the full domain preimage — prevents envelope field substitution/front-running
- Verifies the Groth16 proof inside each envelope using a cached prepared verifying key (ark-groth16 BN254), rejecting non-canonical field elements (>= BN254 modulus) in both public inputs and inserted leaves
- Burns/exports/rotates must reference a pool root the guest has actually produced for that denomination (tracked via per-denomination `known_pool_roots`) — prevents fake-tree membership proofs
- CXFER conservation: when a CXFER consumes tracked tETH UTXOs, verifies Pedersen openings (amount + blinding against NUMS generator H) for each output, checks `sum(outputs) == sum(inputs)`, then tracks the new outputs with their verified amounts
- Invalid or malformed envelopes (bad proofs, wrong bindHash, duplicate nullifiers, short payloads) are silently skipped, not panicked — the guest cannot be bricked by adversarial Bitcoin OP_RETURN data
- Commits 461 bytes of compact public values: hashed per-denomination pool roots, shared nullifier set hash, hashed deposit accumulators, hashed burn batches, VK hash, domain binding (asset, network, chain, mixer, denomination set hash), state commitments

### Incremental proofs

Each SP1 proof chains from the previous proven state:

```
Proof N                          Proof N+1
-------                          ---------
processes blocks 100-200         processes blocks 201-300
state: root_A -> root_B         state: root_B -> root_C
commitment_B stored              must match commitment_B to start
```

- Per-denomination pool trees restored from frontiers (each verified against its root via `verify_root_from_frontier`)
- Nullifier set restored from pre-sorted list (hash verified against committed state)
- UTXO set restored from previous state (hash verified against committed state)
- State commitment = SHA256(per-tree roots + frontiers + indices + null set hash + height + null count + utxo set hash)
- Verifier checks prev pools hash, prev null hash, prev height, prev block hash, and state commitment before accepting
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

### Current capacity

| Component | Cost | Notes |
|-----------|------|-------|
| Deposit (on-chain) | O(1) | Poseidon tree insert + root accumulator update |
| Withdrawal (on-chain) | O(1) | Relay check + Groth16 verify + burn claim lookup |
| SP1 proof submission | O(1) | Accumulator comparison, constant SP1 verify |
| SP1 proving (off-chain) | O(new blocks + n + k log n) | n = total nullifiers, k = new transitions |

Comfortably handles tens of thousands of deposits per pool — comparable to Tornado Cash's largest pool (~30k lifetime deposits). The prover is nearly stateless: fetch blocks, pass sorted nullifier list, generate proof. No database, no persistent state.

Each pool caps at 2^20 (~1M) leaves. Across 8 denominations that's ~8M total deposits per mixer deployment.

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
- 1 `SP1PoolRootVerifier` per asset (covers all denominations)
- 1 Groth16 verifier (reuses existing Tacit withdraw.circom ceremony)

The deploy script predicts the mixer address via nonce, deploys the verifier with all pool IDs and denominations baked in, then deploys the mixer which validates the wiring at construction (`coversPool`, asset ID, mixer address). All denomination pools point to the same verifier instance. Any mismatch reverts the entire transaction.

For an ETH bridge: 1 relay + 1 verifier + 1 mixer + 1 Groth16 verifier = 4 contracts. For USDC: reuse the same relay, deploy 1 mixer + 1 SP1 verifier.

### Live on Ethereum mainnet

The ETH ↔ tETH bridge is deployed and Etherscan-verified on Ethereum mainnet (chain ID 1), bridging mainnet Bitcoin. The contracts are immutable and permissionless — anyone can advance the relay or submit state proofs; funds are protected by the proofs, not by any privileged caller.

**Status:** live and Etherscan-verified, with the in-dApp bridge flow open as a capped pilot — 0.001 ETH per deposit, 10 ETH total backing — enforced dApp-side while the deposit base grows.

| Contract | Address |
| --- | --- |
| `BitcoinLightRelay` | [`0x45AA793952A710E61D456deAcA13E29d8E5c0951`](https://etherscan.io/address/0x45AA793952A710E61D456deAcA13E29d8E5c0951) |
| `TacitBridgeMixer` (native ETH) | [`0x6929acf0a8dDe761Bf16A54B61473e89124FECbf`](https://etherscan.io/address/0x6929acf0a8dDe761Bf16A54B61473e89124FECbf) |
| `SP1PoolRootVerifier` | [`0x19CC65a1B4e3C9516Cc648182bdeb1116A7cA701`](https://etherscan.io/address/0x19CC65a1B4e3C9516Cc648182bdeb1116A7cA701) |
| Groth16 burn verifier | [`0x031b22ba49e38212fdeB92b31fe2f718567Ab2ca`](https://etherscan.io/address/0x031b22ba49e38212fdeB92b31fe2f718567Ab2ca) |

- **tETH asset ID:** `0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34` — `SHA256(etch_reveal_txid_BE ‖ vout 0)`. Etched supply is 0, so every tETH in existence is backed 1:1 by ETH locked in the mixer.
- **Bitcoin etch reveal:** `8c31974d6060dcf400f4a13ac8344a46a7a71e561d15577915f6eef06880af8d` (block 951992), 8 decimals.
- **SP1 proof verification:** the verifier calls the immutable SP1 Groth16 verifier (v6.1.0) at `0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2` directly, not Succinct's upgradeable gateway — so no party can pause or alter proof verification.
- **SP1 program vkey:** `0x003e5d7431b415385b0184af2b0e6b0a4728270ca345c4259162ed505f4d7402` (pinned in `contracts/sp1/elf-vkey-pin.json`; the committed guest ELF is reproduced byte-for-byte in CI).
- **PoseidonT3:** `0x3333333c0a88f9be4fd23ed0536f9b6c427e3b93` (canonical poseidon-solidity, byte-identical across chains).
- **Relay genesis anchor:** Bitcoin block 952127. **Confirmation depth:** 6. **Finality window:** 6. **Network tag:** 0 (mainnet).
- **Mixer deploy block:** 25,231,174 (`0x180ff46`) — deposits are indexed from here.

Circulating tETH equals the mixer's `totalBalance()` (deposits − withdrawals) and is readable on-chain at any time.

## Proving

The SP1 host program fetches Bitcoin blocks from any block explorer API, feeds headers + all raw transactions to the guest, and generates proofs. Run it periodically to advance pool state:

```
cargo run --release -- --start-height <last_proven + 1> --num-blocks <n>
```

Anyone can run the prover. It is fully permissionless. Multiple provers can race — the first valid submission wins.

If a deposit occurs between proof generation and submission, the deposit root accumulator changes and the proof becomes stale. The prover retries with updated state. Same if the relay tip advances. This is a liveness constraint, not a security issue.

## Known limitations

### Relay reorg recovery

The current verifier assumes the relay tip extends the last SP1-proven block. If the relay reorgs onto a branch that does not descend from the last SP1-proven block, SP1 state advancement is blocked — no valid proof can chain from the stored state to the new tip. This requires redeployment of the affected verifiers (users migrate via withdraw + re-deposit). On Bitcoin mainnet, reorgs deeper than a few blocks are essentially unprecedented. A future relay upgrade could add ancestor checking or finality-depth targeting to handle this automatically.

### Migration path

The mixer is intentionally immutable with no admin keys. Upgrading the SP1 program (e.g., sparse Merkle nullifier tree) requires deploying new verifiers and a new mixer. Users migrate by withdrawing from the old mixer and depositing into the new one. This is a deliberate trustlessness tradeoff — no upgrade mechanism means no one can change the rules after deployment.

### One burn per Bitcoin transaction

Both the Solidity mixer and the SP1 guest process at most one burn envelope per Bitcoin transaction. If a user constructs a transaction with two burn envelopes, only the first is processed. This is enforced for consistency between on-chain extraction and off-chain proving.

### Taproot envelope encoding

Bridge envelopes (281-537 bytes) far exceed the 80-byte standard OP_RETURN datacarrier limit, so each bridge operation rides in a **Taproot script-path reveal** instead: a commit tx funds a P2TR output that commits to the envelope as a tapleaf, and a reveal tx spends it, exposing the envelope in `vin[0]`'s witness item 1. The SP1 guest (`extract_taproot_envelope`) and the Solidity mixer (`_extractTaprootEnvelope`) read the same witness payload, so on-chain extraction and off-chain proving see byte-identical bytes. Each operation is therefore two Bitcoin transactions (commit + reveal); indexers scan witness data, not OP_RETURN outputs. This keeps the bridge on entirely standard, relay-safe transactions regardless of envelope size.

### Relay consensus subset

The Bitcoin light relay implements a simplified subset of Bitcoin consensus: header PoW, chain linkage, difficulty retarget with 4x clamping, and heaviest-chain fork choice via cumulative work. It does not enforce median-time-past or future-time constraints. The primary security guarantee is real Bitcoin PoW — producing valid headers requires the same hash power as attacking Bitcoin itself.
