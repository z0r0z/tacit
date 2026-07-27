# Manifest — in-scope files, line counts, build & validate

Every file in the immutable surface, with its line count and a one-line purpose, followed by the build/test
commands and the local reflection execute-mode validator. Line counts are `wc -l` at bundle assembly and are
orientation, not a checksum — verify against the tree.

## SP1 zkVM guests (Rust)

### Settle guest — `contracts/sp1/confidential/src/`
| file | lines | purpose |
|---|---:|---|
| `main.rs` | 5234 | settle-guest entrypoint + op dispatch; per-op conservation / authorization / destination binding for every settle op |
| `reflect.rs` | 2047 | reflection guest — per-op Bitcoin-state folds into the resumable `digest()` chain |
| `swap_batch.rs` | 487 | `T_SWAP_BATCH` in-guest matching/clearing over the batched blind-swap intents |
| `swap_blind.rs` | 145 | `OP_SWAP_BLIND` prover-blind AMM path (present in vkey; no live emitter) |
| `groth16.rs` | 258 | in-guest BN254 Groth16 verifier + baked `batch_vk` ceremony key |
| `babyjubjub.rs` | 259 | BabyJubJub curve ops for the blind-swap circuit binding |

### Shared crypto library — `contracts/sp1/confidential/cxfer-core/src/`
| file | lines | purpose |
|---|---:|---|
| `lib.rs` | 9623 | notes/commitments, accumulators (note tree, spent/UTXO/consumed-outpoints IMTs, burn & lock sets), kernels, range proofs (BP+ / classic), AMM math, the reflection folds' shared logic |
| `bitcoin.rs` | 4022 | Bitcoin tx/relay/header parsing, witness-commitment + PoW binding, envelope decoders, output-script/authority extraction |
| `burn_deposit.rs` | 1003 | scan-free onboarding — the provenance DAG from an asset's etch supply |
| `eth_reflection.rs` | 344 | Mode-B (ETH→BTC) fold helpers shared with the eth-reflection guest |
| `bjj.rs` | 292 | BabyJubJub field/curve primitives |
| `sigma.rs` | 138 | Fiat-Shamir sigma / Schnorr transcript helpers |

### Mode-B beacon light client — `contracts/sp1/eth-reflection/src/`
| file | lines | purpose |
|---|---:|---|
| `main.rs` | 412 | Ethereum finalized-state proof (beacon light client + MPT storage proofs) → `fold_crossout` mints the Bitcoin-side note |

### Shared stdin serializer — `contracts/sp1/reflect-stdin/src/`
| file | lines | purpose |
|---|---:|---|
| `lib.rs` | 488 | serializes the reflection prior-state stream the guest reads (live entries, roots, counts) — must byte-match the guest's read order |

## Solidity — `contracts/src/`
| file | lines | purpose |
|---|---:|---|
| `ConfidentialPool.sol` | 2601 | core: `settle`, reflection attest + accumulators, bridge-mint/burn gates, fast-lane consume records, wrap/unwrap escrow, per-op value re-checks |
| `ConfidentialRouter.sol` | 1648 | atomic exit-and-execute (recipe-bound CREATE2 escrow into external DeFi) + public swap entrypoints + permissionless activation/rescue |
| `CollateralEngine.sol` | 935 | CDP/cUSD collateral, oracle adapter, liquidation, cBTC escrow, TSR savings — **DAO-governed** (Solady Ownable) |
| `lib/BitcoinLightRelay.sol` | 504 | Bitcoin light client — the reflection anchor; header-chain / PoW / per-block-target fork choice |
| `FarmController.sol` | 368 | escrow-funded + inflationary farm rewards; accumulator-per-share receipts |
| `CanonicalAssetFactory.sol` | 234 | CREATE2 cross-chain-identical canonical assets (address = f(assetId)) |
| `TacitRelayer.sol` | 161 | gasless relay entrypoint |
| `CanonicalMinters.sol` | 145 | canonical mint authority wiring |
| `CanonicalBridgedERC20.sol` | 114 | bridged canonical ERC20 |
| `BtcCallExecutor.sol` | 73 | bound external-call executor for the BtcCall op |
| `ChainlinkEthBtcAdapter.sol` | 59 | ETH/BTC oracle adapter for the CDP |

`ConfidentialPool` verifies SP1 proofs through the generic `ISP1Verifier` interface (constructor-injected); the
"SP1PoolRootVerifier pattern" it cites in comments is the shared Bitcoin-relay-vkey anchoring idiom, not an
import of the mixer contract.

**Out of scope:** the legacy denomination-pool mixer `TacitBridgeMixer.sol` (537) and the `SP1PoolRootVerifier.sol`
(322) + standalone `Groth16Verifier.sol` (196) it imports (mixer proof path), plus `ICreateX.sol` (27, deploy
interface) and `MerkleDistributor.sol` (112, airdrop). Not part of the confidential surface. **Open question for
the auditors:** `SP1PoolRootVerifier.sol` is imported only by the mixer today; confirm no in-scope contract
depends on it before treating it as fully excludable.

## Reflection assembler (mutable, but consensus-critical) — `dapp/`
| file | lines | purpose |
|---|---:|---|
| `confidential-pool.js` | 2430 | off-chain reflection fold — must mirror every guest fold's accept/skip verdict exactly |
| `confidential-swapbatch.js` | 279 | `T_SWAP_BATCH` assembler fold + per-intent intent-message reconstruction |
| `burn-deposit-bitcoin.js` | 763 | scan-free onboarding assembler (provenance walk) |

## Build & test

```
# Rust: shared lib + guests
cd contracts/sp1/confidential && cargo test -p cxfer-core        # crypto/accumulator/KAT tests
cargo prove build --bin confidential-pool-prover                 # settle guest ELF -> PROGRAM_VKEY
cargo prove build --bin reflection-prover                        # reflection guest ELF -> BITCOIN_RELAY_VKEY
cd ../eth-reflection && cargo prove build --bin eth_reflection   # Mode-B ELF -> eth_reflection_vkey

# Solidity
cd contracts && forge build && forge test                        # incl. the *ProofReal real-Groth16 suites

# JS assembler / mirror-parity suites
node tests/confidential-swapvar-fold.mjs
node tests/confidential-swaproute-fold.mjs
node tests/confidential-swapbatch-fold.mjs
node tests/amm-intent-msg-pin.mjs                                # runs the REAL worker/dapp emitters vs guest KATs
```

## Local reflection execute-mode validator (reflect-exec → DIGEST_MATCH)

The reflection guest can be run in `MODE=execute` against the box vectors in `ops/REPROVE-amm-box-vectors.md`
(and the `ops/box-artifacts/amm-c01-fixtures/` fixtures) without producing a proof. The validator:

1. feeds the guest the `reflect-stdin` prior-state stream + the confirmed-tx witnesses,
2. runs each per-op fold, and
3. asserts the guest's recomputed `digest()` equals the assembler's (`DIGEST_MATCH`).

A divergence means a guest fold and its assembler mirror disagree on accept/skip for some op — exactly the
class of bug the last validation round surfaced (see `CHANGES-SINCE-LAST-ROUND.md`). On every negative vector,
assert reflection STILL ADVANCES (a malformed op self-strands only its initiator; no abort/halt). See
`BUILD-AND-VALIDATE.md` for the hermetic, execution-capable path.

## Total in-scope source

Guests + cxfer-core + eth-reflection + reflect-stdin (Rust): **24,752** lines. In-scope Solidity: **6,642**
lines. Reflection assembler (JS): **3,472** lines — **34,866** lines total in scope. Excludes the out-of-scope
mixer, its verifiers, the deploy interface, and the airdrop distributor listed above.
