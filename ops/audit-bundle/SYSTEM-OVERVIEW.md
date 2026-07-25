# Tacit V1 — system overview (orientation for reviewers)

This document orients an auditor across the whole protocol before the source. It describes *what the system is*
and *where each property lives*. It is not a claim of correctness — verify everything against the code.

## What Tacit is

Tacit is an **immutable, shielded, cross-chain DeFi protocol** spanning Ethereum and a Tacit Bitcoin asset
layer. Users hold **confidential bearer notes** (hidden amounts) and transact through a fixed op set — wrap/
unwrap, private transfer, an AMM (cleartext-amount and prover-blind), multi-hop routing, OTC and bid orders,
concentrated LP + LP-bond-to-farm, a CDP stablecoin (cUSD), Synthetix-style farms, pay-to-stealth, adaptor
(atomic-swap) locks, self-custody BTC tokenization (cBTC), and a **two-way BTC↔ETH bridge** with a fast lane —
all settled by zero-knowledge proofs against on-chain accumulators. No admin, no pause, no upgrade.

## The note & accumulator model (`cxfer-core`)

- **Commitment.** A note's value+blinding is a secp256k1 Pedersen commitment `C = v·H + r·G` (`H`,`G` are
  independent NUMS). The commitment is **asset-blind** — the asset lives in the leaf, not the point.
- **Leaf.** A note's membership leaf is `leaf(asset,Cx,Cy,owner)` (native / Ethereum-homed) or
  `btc_note_leaf(asset,Cx,Cy,auth_key)` (Bitcoin-homed; `auth_key` = the note's Bitcoin Taproot x-only key).
- **Bearer model.** Spend authority is **knowledge of the blinding** `r`, proven by a Fiat-Shamir Schnorr
  "kernel" over `ΣC_in − ΣC_out` (which simultaneously proves value conservation `Σv_in = Σv_out`). The `owner`
  label in a native leaf is **not** spend authority. A Bitcoin-homed note additionally requires a **BIP-340
  signature under `auth_key`** for any spend (so a delegated prover or observer who learns the public blinding
  still cannot move it or re-point its outputs).
- **Nullifier.** `ν = keccak(note_leaf ‖ "spent")` — a function of the full authenticated leaf, chain-
  independent (both lanes reconstruct the identical leaf), so a note has exactly one nullifier.
- **Accumulators.** An append-only keccak Merkle **note tree** (leaves), an **IMT spent set** (nullifiers), a
  **UTXO IMT** (outpoint → commitment), plus a **bridge-burn set** and a **lock set**. Range proofs are
  Bulletproofs+ (BP+).

## The two chains and the bridge

- **Ethereum** is the settlement chain: `ConfidentialPool.settle(publicValues, proof, memos)` verifies an SP1
  proof of the **settle guest** and applies its effects (spend nullifiers, append note leaves, move reserves,
  pay escrow, etc.). The SP1 **program vkey is burned into the constructor**.
- **The Tacit Bitcoin layer** carries the same confidential notes in Bitcoin transactions. A **reflection
  guest** folds confirmed Bitcoin state (spends, outputs, burns, AMM folds) into a resumable `digest()`, anchored
  to a **Bitcoin light relay** at a matured depth; `ConfidentialPool.attestBitcoinStateProven` records the
  attested roots. Reflection is O(Δ) per cycle (witnessed accumulator transitions), not full replay.
- **BTC → ETH bridge.** A Bitcoin note burned for the bridge records `burn_id → destCommitment` (source-
  specific: `burn_id = keccak(domain ‖ source_kind ‖ spent_txid ‖ spent_vout ‖ source_leaf)`). On Ethereum,
  `OP_BRIDGE_MINT` / `OP_BRIDGE_STEALTH_MINT` prove membership of the burned note's leaf in a relay-attested
  Bitcoin pool root AND membership of `burn_id → dest_leaf` in the relay-attested burn set, then mint — value
  carried verbatim by the conservation kernel; one mint per burn.
- **ETH → BTC bridge / crossOut.** An Ethereum burn records a cross-out; the **eth-reflection (Mode-B) guest**
  proves finalized Ethereum state and `fold_crossout` mints the Bitcoin-side note to the burner-named Taproot
  key.
- **Fast lane.** A Bitcoin-homed note may be spent directly on Ethereum; its consumed source is recorded
  (`bitcoinConsumed`, carrying the full authenticated source leaf) and the **Mode-B reverse reflection** retires
  the source outpoint on Bitcoin, so value never exists live on both chains.

## The op set (guest `main.rs` dispatch)

Wrap / unwrap / send-and-unwrap · private transfer · **AMM** `OP_SWAP` (cleartext amount, hidden to chain) and
`OP_SWAP_BLIND` (prover-blind via an in-guest BN254 Groth16 over `amm_swap_batch.circom`) · `OP_SWAP_ROUTE`
(multi-hop) · LP add / remove / bond · **OTC** and **BID** (pre-authorized) orders · **CDP** mint / close /
top-up / liquidate (the cUSD stablecoin, via `CollateralEngine`) · **farms** init / bond / harvest / unbond /
refund (`FarmController`) · **stealth** lock / claim / refund · **adaptor** lock / claim / refund · **bridge**
mint / stealth-mint / burn · **crossOut** · **cBTC** lock / redeem (self-custody BTC tokenization) · **cmint**
(issuer-authorized additional supply) · **burn-deposit** (scan-free onboarding via a provenance DAG from an
asset's etch supply). Each op enforces per-asset conservation, authorization, and destination binding in-guest;
the contract independently re-checks the value-bearing gates (pre-reserves, k-non-decrease, escrow, roots).

## The contracts

- **`ConfidentialPool.sol`** — the core: `settle`, the reflection attest + accumulators, the bridge-mint/burn
  gates, the fast-lane consume records, wrap/unwrap escrow, and the per-op value re-checks.
- **`ConfidentialRouter.sol`** — atomic exit-and-execute: unwrap a note to a recipe-bound CREATE2 escrow that
  runs a batch into external DeFi and sweeps to a bound recipient, plus a permissionless activation/rescue path.
- **`CollateralEngine.sol`** — CDP/cUSD collateral, oracle (Chainlink adapter), liquidation. DAO-governed
  parameters (an explicit trust posture, see `DESIGN-NOTES.md`).
- **`FarmController.sol`** — escrow-funded + inflationary farm rewards.
- **`CanonicalAssetFactory` / `CanonicalMinters` / `CanonicalBridgedERC20`** — CREATE2 cross-chain-identical
  canonical assets (address = f(assetId)).
- **`BitcoinLightRelay.sol` (Bitcoin light client)**, **`TacitRelayer.sol`** (gasless relay), **`BtcCallExecutor.sol`**,
  **`ChainlinkEthBtcAdapter.sol`**.

## Trust & operational model (intentional — see `DESIGN-NOTES.md`)

Immutable (no admin/pause/upgrade); SP1 vkey + the AMM ceremony key burned/locked. Relay fees are an
**open-settlement bounty** (fee → `msg.sender`; settles are copyable by design). One **live funded generation**
per lineage is an operational deployment invariant. The `CollateralEngine` parameters are DAO-governed. The
native-nullifier invariants in `DESIGN-NOTES.md §3` are constraints on any future op/vkey. Bytecode/vkey
reproducibility and the guest↔dapp mirror parity are a separate build/reprove step (the guest source here may
be ahead of any currently-deployed instance).

## File map

`guest/cxfer-core/` shared crypto (notes, accumulators, Bitcoin tx/relay, provenance, BP+, sigma, BJJ) ·
`guest/settle/` the settle guest (`main.rs` dispatch, `reflect.rs` reflection fold, `swap_batch.rs`/
`swap_blind.rs`, `groth16.rs`, `babyjubjub.rs`) · `guest/eth-reflection/` the Mode-B guest ·
`contracts/src/` the Solidity · `circuits/` the blind-swap circom · `fixtures/` the blind-swap ceremony vk +
verify vector · `pins/` the deployed vkey/bytecode pins · `DESIGN-*.md` / `OP-REVIEW-CHECKLIST.md` design intent.
