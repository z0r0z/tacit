# Tacit ↔ Ethereum — architecture & layering

A bird's-eye view of how the Tacit metaprotocol (on Bitcoin) and Ethereum compose into
one confidential, cross-chain system. Companion to the per-piece plans
(`PLAN-confidential-*`, `PLAN-canonical-asset-hub.md`, `STATUS-confidential-system.md`).

## The layers (sovereign at the bottom, public at the top)

```
┌───────────────────────────────────────────────────────────────────────┐
│ 5. Public Ethereum DeFi   Uniswap / aggregators trade the canonical     │
│                           ERC20s (the public face). Compose freely.     │
├───────────────────────────────────────────────────────────────────────┤
│ 4. Ethereum confidential  ConfidentialPool — a shielded pool mirroring  │
│    layer (fast lane)       the Bitcoin one. SP1-verified settle (~12s    │
│                           provisional). Canonical ERC20 hub = the public │
│                           face of any Tacit asset (mint on exit/burn on  │
│                           entry). Wraps external ERC20s too.             │
├───────────────────────────────────────────────────────────────────────┤
│ 3. The bridge / relay      Same secp256k1 NOTE object on both chains.    │
│                           BitcoinLightRelay (SPV) + SP1PoolRootVerifier  │
│                           reflect Bitcoin state → Ethereum. SP1 guest    │
│                           proves note validity (wrap/xfer/unwrap/        │
│                           bridge_burn/bridge_mint + cross-lane gate).    │
├───────────────────────────────────────────────────────────────────────┤
│ 2. Tacit metaprotocol      Confidential notes, shielded pool/mixer, AMM  │
│    (on Bitcoin)            (BabyJubJub batch swaps), collateral          │
│                           (cBTC.tac). Indexer-validated, no operator.    │
├───────────────────────────────────────────────────────────────────────┤
│ 1. Bitcoin L1              Canonical asset registry (etch/CETCH/T_PETCH; │
│    (sovereign + final)     asset_id = sha256(reveal_txid‖0)) + sole      │
│                           finality. The arbiter.                         │
└───────────────────────────────────────────────────────────────────────┘
```

## Trust / finality model — "improved (asymmetric) platinum"

- **Bitcoin is the canonical arbiter and sole finality** (the sovereign lane). A spend is
  final when Bitcoin says so.
- **Ethereum is a fast provisional cache** (the fast lane) — confidential transfers and
  matched swaps settle in ~12s, then reconcile to Bitcoin finality.
- **Cross-lane consistency** is enforced *in-guest*: an indexed-Merkle non-membership
  check of each spent nullifier against the **reflected Bitcoin spent-set root**
  (`bitcoinSpentRoot`), gated on-chain so a fast-lane spend can't contradict the
  sovereign lane.
- Net: **Bitcoiners stay sovereign, Ethereans get speed, and anyone who traverses
  confidentially joins one shared anonymity set.**

## The objects that span both chains

| Object | Definition | Spans |
|---|---|---|
| **Note** | `C = v·H + r·G` on **secp256k1** (Bitcoin's curve) | identical object on Bitcoin + Ethereum — the cross-chain primitive |
| **asset_id** | Bitcoin: `sha256(reveal_txid_BE‖0_LE)`; EVM-etch: `sha256(tag‖chainid‖factory‖salt‖etcher‖meta_hash)` | the canonical identity (ticker is a non-unique label) |
| **Canonical ERC20** | `address = f(asset_id)` (CREATE2, fixed initcode); `name="Tacit Token"`; `(symbol,decimals)` deterministic-to-real; decimals harmonized 8↔18 | the public face on Ethereum |
| **Sigma binding** | proves a secp Pedersen and a BabyJubJub Pedersen hide the same `v` (169 B) | the hinge from notes → the BN254 AMM world |

## The proof stack

- **One SP1 zkVM guest** (Rust) — 5 ops (wrap / transfer / unwrap / bridge_burn /
  bridge_mint) + the cross-lane non-membership gate — wrapped to **Groth16**, verified
  on-chain (~250k gas). SP1's verifier is universal → **no new trusted setup** when the
  guest changes (only a re-prove). Current guest vkey `0x00f02859…`; the live Sepolia
  deployment pins `0x0063293d…` until the redeploy with the re-proven guest.
- **AMM circuits** (Groth16, BabyJubJub) — `T_SWAP_BATCH` etc., Bitcoin-side today; an
  Ethereum-side verifier is the roadmap for confidential swaps on Ethereum.

## What lives where

- **Bitcoin:** canonical assets, collateralization (cBTC.tac = TAC/tETH-backed), finality,
  the AMM (today). *Collateral is a Tacit concern — there is no Ethereum collateral vault.*
- **Ethereum (contracts):** `ConfidentialPool` (settlement + the universal minter),
  `CanonicalAssetFactory` + `CanonicalBridgedERC20` (public face), the SP1 verifier, and
  the reused tETH relay (`BitcoinLightRelay` + `SP1PoolRootVerifier`).
- **Off-chain:** the SP1 prover box, the worker/indexer, the dapp.

## Status (2026-06-08)

Live on Sepolia: pool `0xA0f42c5C…`, factory `0xe7BD6549…`, verifier `0x5657FD7b…`;
canonical-asset-hub flow (lazy-deploy + decimals harmonization) verified on-chain.
Remaining contract pieces: (A) trustless first-mint metadata (guest exposes
`(ticker,decimals)` from the etch → new vkey; cxfer-core primitive `asset_id_from_etch` /
`parse_etch_meta` is built), (C) confidential-swap settlement on Ethereum (a BabyJubJub
verifier). Done: (B) SP1-relay-verified Bitcoin state — `attestBitcoinStateProven` is the
sole attestation path, no trusted oracle; (D) `registerWrappedAuto` symmetry.
