# EVM pool: integration guide

A native-ETH shielded pool that users prove on their own device. Balances are fungible notes of any amount; a
single transaction can deposit, pay someone privately with change, withdraw, and pay a relayer. The contracts are
immutable: no owner, no pause, no upgrade. Design and measurements: [`DESIGN-evm-client-pool.md`](../contracts/sp1/confidential/DESIGN-evm-client-pool.md).

**Status.** The circuit is frozen and its public trusted-setup ceremony runs on tacit.finance. The contracts deploy
when the ceremony finalizes, at the addresses below, which are fixed now. Integrate against them today and treat the
pool as live once it has code on chain (`eth_getCode(pool) != "0x"`).

## Addresses

Identical on every EVM chain (CreateX CREATE3, salts locked to deployer `0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7`;
no other sender can deploy at these addresses).

| Contract | Address |
|---|---|
| Pool (`TacitEvmPool`, native ETH) | `0x000000c2A20657CE25f2Ba99737933D031AFBEE9` |
| Router (`TacitEvmPoolRouter`) | `0x0000006C96Afa6f1cD4DF8FE19bc0d8B6A6Cd7B5` |
| Groth16 verifier | `0x000000b1c0e84CEc8AdF8278B90c4d6400DfB153` |

Related Ethereum mainnet contracts:

| Contract | Address |
|---|---|
| Confidential pool (V1) | `0x000000000Ed1eabD231Be41d93b719056F7febFC` |
| ConfidentialRouter (V1 exit recipes) | `0x000000005dA3E3B73726af3c774Deeb9472D4992` |
| Native ETH asset id on V1 | `0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34` |

ABIs: [`docs/evm-pool/abi/`](./evm-pool/abi/). The script that deploys them is
`contracts/script/DeployEvmPoolCreateX.s.sol`; it refuses any verifier other than the ceremony's.

## Proving on the user's device

The relation is one Groth16 circuit, [`transact.circom`](../dapp/circuits/evm-pool/transact.circom): 2 inputs,
2 outputs, 120-bit values, a depth-32 Poseidon tree, 44,414 constraints. Proofs are 256 bytes and verify in one
pairing check on chain.

| Artifact | Size | Where |
|---|---|---|
| `transact.wasm` (witness generator) | ~4.9 MB | pinned on IPFS at finalize |
| `transact_final.zkey` (proving key) | ~28.5 MB | pinned on IPFS at finalize |
| verification key hash | 32 B | published at finalize; clients refuse any other key |

The reference client is plain ES modules with no build step:

- [`dapp/evm-pool-zk.js`](../dapp/evm-pool-zk.js): keys, notes, tree, nullifiers, witness.
- [`dapp/evm-pool-zk-prover.js`](../dapp/evm-pool-zk-prover.js): `makeGroth16System({ vk, wasm, zkey, pinnedVkHash })`
  → `prove(input)` / `verify(publics, wire)`. snarkjs, in the browser or Node.
- [`dapp/evm-pool-gateway.js`](../dapp/evm-pool-gateway.js): deposit-box intents, keeper completions, withdrawals to a
  box or escrow.

Proving time on a laptop is 5–14 s in Node. Phone and browser measurements are published with the final artifacts.
A signature, not the spending key, authorizes a spend (EdDSA-Poseidon over the transaction message), so a device
too slow to prove can hand the witness to another prover without giving up custody.

### Note model

```
npk  = Poseidon(Ak.x, Ak.y, NK.x, NK.y)            Ak = per-note spend key, NK = nk·Base8 (BabyJubJub)
leaf = Poseidon(asset, v, npk, rho)                v < 2^120
nf   = Poseidon(nk, leaf, index)
asset        = keccak256(abi.encode(chainId, pool, address(0))) mod p
extDataHash  = keccak256(abi.encode(chainId, pool, recipient, extAmount, relayer, fee,
                                    keccak256(memo0), keccak256(memo1))) mod p
publicAmount = extAmount − fee mod p
Σ inputs + publicAmount = Σ outputs
```

Keys and stealth derivation are the Bitcoin shielded pool's (`dapp/btc-pool-zk.js`): one wallet seed serves both.
Public signal order: `root, oldRoot, newRoot, startIndex, publicAmount, extDataHash, asset, nf[2], outLeaf[2]`.

## Calling the pool

```solidity
function transact(
    uint256[2] pA, uint256[2][2] pB, uint256[2] pC, uint256[11] publicInputs,
    address recipient, int256 extAmount, address relayer, uint256 fee, bytes memo0, bytes memo1
) external payable;
```

| `extAmount` | Effect |
|---|---|
| `> 0` | Deposit: send exactly `extAmount` wei as `msg.value`. |
| `< 0` | Withdraw `-extAmount` wei to `recipient` (must be non-zero). |
| `0` | Private transfer inside the pool. |

`fee` goes to `relayer` in the same call (a non-zero fee needs a non-zero relayer). The contract recomputes the asset,
`extDataHash` and `publicAmount` itself, so recipient, amounts, relayer, fee and memos cannot be altered after the
owner signs.

**Ordering.** A transaction with an output inserts two leaves at the pool's current size and must be proven
against the current root (`oldRoot == root()`, `startIndex == nextIndex()`). If another transaction lands first it
reverts with `StaleRoot` or `WrongInsertionIndex`: rebuild the witness against the new leaves and prove again; the
owner's signature does not change. Submit through private order flow. A transaction with no outputs (a full
withdrawal) inserts nothing and never goes stale. Membership may be proven against any root the pool has held
(`everKnownRoot`).

**Indexing.** Rebuild the tree from `Transact` events in `firstIndex` order, appending `(outLeaf0, outLeaf1)`; skip
events where both are zero (nothing was inserted). Notes are found by trial-decrypting the memos. Key notes by
`(leaf, index)`: the same leaf can appear twice if a deposit box is paid twice, and each copy is separately spendable.

## Router

The router is optional periphery; everything it does can be done by calling the pool directly.

**Deposit boxes: pay an address now, get a note later.** A `DepositIntent` fixes the amount, both output leaves, both
memo hashes, a refund address and a deadline. `depositBoxOf(intent)` is a counterfactual address that holds only
what is paid to it. Any source can pay it: a wallet, an exchange withdrawal, a bridge, or a V1 withdrawal. Anyone
then calls `completeDeposit(intent, tx)` with a proof against the pool's root at that moment and collects the fee,
which is `amount − Σ output values`. The intent pins the notes, so a completer can only deliver exactly what the
owner chose. After the deadline, `reclaimDeposit(intent, token)` returns any token or ETH in the box to the refund
address. The completer learns each output's value (the leaves hide it) but cannot link later spends.

A keeper service completes boxes for its fee: `POST /evm-pool/keeper/deposit` with `{ intent, hint }` from
`depositIntent()` (endpoint published at launch). Anyone can run one (`worker-relay/src/evm-pool-keeper.js`).

**Wrap boxes and `withdrawToV1`.** A `WrapIntent` fixes a V1 asset id, amount, tip, tip recipient (zero = whoever
completes), V1 note commitment, refund and deadline. `completeWrap(intent)` wraps the box's funds into that V1 note.
`withdrawToV1(tx, intent)` withdraws from the pool into the wrap box and wraps in one transaction; the proof binds
the box as recipient.

**Zaps.** `zapTokenToDepositWithPermit2(tx, amountIn, permit, sig, swapData)` swaps any ERC-20 to ETH through the
pinned aggregator and deposits exactly the proven amount, refunding the rest.

## Moving between V1 and this pool

The pools keep separate notes, so value moves by a public exit from one and a public entry into the other. Both
ends show the amount: a hop is linkable by amount, and by address once a box is completed. What the V1 route adds is
that the funds' origin is any V1 note holder rather than a public wallet.

| From → to | How |
|---|---|
| V1 → pool | A V1 settle withdrawal with `recipient = depositBoxOf(intent)` (native ETH, `value × 10^10` wei). `settle` pays an address with no code, so it cannot revert on the box. A keeper completes the deposit afterwards. |
| V1, other asset → pool | A V1 exit recipe (`ConfidentialRouter.exitAndExecute`) swaps to ETH and sweeps to `finalRecipient = depositBoxOf(intent)`. |
| Pool → V1 | `withdrawToV1(tx, intent)` with `intent.assetId` = the native ETH id above and `intent.commit` = the V1 note commitment. |
| Pool → anything | Withdraw with `recipient = ConfidentialRouter.escrowAddressFor(recipe)`, then anyone calls `activateExit(recipe)`. Every recipe V1 supports applies. |

## Checklist

- Detect deployment by code at the pool address; fetch the final `wasm`/`zkey` by CID and pin the verification key
  hash in `makeGroth16System({ pinnedVkHash })`.
- Retry stale proofs automatically; send through private order flow.
- Always set a non-zero refund address on a box intent, and amounts below 2^120.
- Relayers: never submit someone else's deposit (`extAmount > 0` pulls `msg.value` from the sender).
- Chains need Shanghai (PUSH0) and Cancun (transient storage).
