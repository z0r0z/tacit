# tacit — glossary

Terms with specific meanings that overlap across surfaces. This is
the one-page reference; the canonical normative definitions live in
`SPEC.md`, `AMM.md`, `MIXER.md`, and the per-feature amendments
under `spec/amendments/`.

## Assets and tokens

- **Tacit asset** — any value commitment recognised by the protocol.
  Created by `CETCH` (confidential supply), `T_PETCH` (permissionless
  fair-launch), or as the deterministic `lp_asset_id` of an AMM pool.
  Every tacit asset has a 32-byte `asset_id`.
- **`asset_id`** — 32-byte canonical identifier. Three valid origins:
  `SHA256(reveal_txid_BE || 0_LE)` for CETCH / T_PETCH; or
  `SHA256("tacit-amm-lp-v1" || pool_id)` for an LP-share asset of a
  canonical AMM pool. See SPEC.md §4.1.
- **LP-share** — confidential tacit asset minted at `T_LP_ADD`,
  representing a share of an AMM pool's reserves. Same shape as any
  other tacit asset (Pedersen-committed, CXFER-transferable,
  mixer-composable).
- **cBTC.zk** — trustless wrapped BTC. One `cBTC.zk` unit corresponds
  to one Bitcoin UTXO locked at `K_btc = r_leaf · G_secp256k1`,
  derived from a mixer leaf's secret. Unit-granular at fixed
  denominations; no federation, no co-signer.
- **cBTC.tac** — fungible wrapped BTC. Standard tacit asset minted by
  attaching an LP-share lien on the canonical (cBTC.zk, TAC) AMM
  pool with TAC over-collateralization. Amount-granular; trustless
  on the cBTC.zk anchor side, market-collateralized on the TAC
  fungibility side.
- **TAC** — the protocol's native indexer-validated asset that backs
  cBTC.tac via over-collateralization. Same shape as any Rune at the
  consensus layer; its market-validated value is the bond mechanism.

## Privacy primitives

- **Shielded amount** — default privacy capability. Pedersen
  commitments + aggregated bulletproofs hide on-chain amounts;
  `T_SWAP_BATCH` extends this to per-trader amounts in batched AMM
  settlement via BabyJubJub Pedersen + Groth16.
- **Shielded address** — opt-in privacy capability via the blinded-
  pubkey commit primitive `commit = recipient_pubkey + blinding · G`
  (BIP-341-style). Hides the recipient pubkey itself; the on-chain
  marker sits at a per-transaction unique address. See
  `spec/amendments/SPEC-BLINDED-PUBKEY-AMENDMENT.md`.
- **Mixer pool** — shielded anonymity set per `(asset_id, denomination)`.
  Deposit a fixed-denomination UTXO, later withdraw to a fresh
  address under a Groth16 proof of unspent-leaf membership. Breaks
  the on-chain link between deposit and withdraw. See SPEC.md
  §5.10–§5.11 and `MIXER.md`.

### Two privacy layers, not one

The protocol distinguishes between privacy *at the protocol-tree
layer* and privacy *at the Bitcoin-chain-graph layer*. Same
`withdraw.circom` is reused across surfaces, but the user-facing
outcome differs because of how each surface lays UTXOs out on
Bitcoin.

- **Protocol-tree-layer privacy** — the SNARK hides *which leaf*
  in the per-pool Merkle tree was touched. True for every
  `withdraw.circom` use. Protects against an observer who only
  reads protocol-layer envelopes (tacit-spec aware).
- **Bitcoin-chain-graph privacy** — the BTC UTXO graph is
  obscured against an observer reading raw Bitcoin (txids,
  outpoints). True for the **mixer pool over tacit assets**
  (deposits and withdrawals at the same `(asset_id, denom)` form
  one anonymity set whose tacit-asset chain graph is broken).
  **False for cBTC.zk slot operations** (each slot is its own
  BTC UTXO with a unique `K_btc`; the BTC chain graph is a
  public linear sequence — mint → burn / mint → rotate →
  rotate → burn). Aggregated-UTXO mixing for cBTC.zk requires
  Bitcoin covenants (Stage 3 of the cBTC.zk roadmap) or a
  separate CoinSwap-style coordinator amendment.

A cBTC.zk slot operation gets the *first* property automatically
and *not the second*. A regular mixer-pool withdrawal of a tacit
asset gets both. Lumping the two together as "the mixer property"
is a category error.

## ZK objects

- **Leaf** — a Poseidon hash appended to a per-pool Merkle tree.
  Two contexts: a *mixer leaf* (Poseidon₃(secret, ν, denomination))
  added at `T_DEPOSIT` and consumed at `T_WITHDRAW`; a *slot leaf*
  (same Poseidon shape) added at `T_SLOT_MINT` and consumed at
  `T_SLOT_BURN` / ROTATE / SPLIT / MERGE. Both live in mixer-shape
  trees but back different surfaces.
- **`r_leaf`** — the Poseidon-derived value `Poseidon₂(secret, ν)`
  inside a leaf. Used as a secp256k1 scalar to derive the cBTC.zk
  slot's BTC spending key `K_btc = r_leaf · G_secp256k1`. The
  cryptographic crossover that makes one secret prove mixer-set
  membership AND sign the backing BTC UTXO.
- **Nullifier** — `Poseidon₁(ν)` revealed at withdraw / burn /
  rotate. Indexer tracks the spent-nullifier set; rejects any
  envelope reusing a known nullifier. Defeats double-spend in the
  mixer + slot lifecycles.
- **Pedersen commitment** — `C = a·H + r·G`, additively homomorphic.
  Hides amount `a` behind blinding `r`. Used on secp256k1 for chain
  commitments; used on BabyJubJub inside Groth16 circuits where
  secp256k1 EC math would be prohibitively expensive.
- **Sigma cross-curve binding** — 169-byte Camenisch–Stadler proof
  that a secp256k1 Pedersen commit and a BabyJubJub Pedersen commit
  share the same hidden amount. Verified out-of-circuit; no setup;
  microseconds to prove and verify. Bridges chain commitments
  (secp256k1) to in-circuit commitments (BJJ over BN254 Fr).
- **`withdraw.circom`** — the mixer's Groth16 circuit. Proves
  Poseidon-Merkle leaf membership + nullifier reveal. Reused without
  modification for cBTC.zk slot spend operations. The protocol's
  anonymous-unique-spend primitive.
- **AMM circuits** — three Groth16 circuits (`amm_lp_add`,
  `amm_lp_remove`, `amm_swap_batch`) sharing one Phase 1 ceremony
  (`pot18`). Bind hidden per-trader / per-LP amounts to public pool
  state. The protocol's amount-confidentiality primitive at AMM
  scale.

## AMM-specific terms

- **Pool** — keyed by `(asset_A, asset_B, fee_bps, capability_flags,
  protocol_fee_config)`. Reserves `R_A`, `R_B`, and share supply `S`
  are public quantities the indexer tracks — no UTXO holds the
  pool's funds.
- **`pool_id`** — 32-byte canonical pool identifier. Distinct fee
  tiers / capability flags yield distinct `pool_id`s and distinct
  `lp_asset_id`s; LP shares from different tiers are not fungible.
- **`P_clear`** — uniform clearing price in a `T_SWAP_BATCH`.
  Derived in-circuit from private aggregates of A→B and B→A trader
  inputs plus public batch deltas, so every trader in the batch
  settles at one price (no intra-batch sandwich attacks).
- **`T_SWAP_BATCH`** (`0x2F`) — batched AMM swap path. Hidden
  per-trader amounts, uniform clearing price, ceremony-gated.
  Privacy mode for size-sensitive flow.
- **`T_SWAP_VAR`** (`0x32`) — per-trade AMM swap path. Cleartext
  amount, variable-amount `[Y, X]` range against the spot curve, no
  Groth16, no ceremony coupling. Default trader path for casual
  flow; settles immediately at known pre-state reserves.
- **`T_SWAP_ROUTE`** (`0x33`) — atomic multi-hop swap (2–4 pools).
  One Bitcoin tx, one kernel sig, one trader input → one trader
  receipt. Reuses `T_SWAP_VAR`'s cryptography; no ceremony coupling.
- **Settler** — anyone who bundles queued swap intents into a
  `T_SWAP_BATCH` envelope and broadcasts it. Permissionless;
  competes on tip revenue. Sees per-trader cleartext amounts for
  the batch they construct (decrypted from RTT-1 opening blobs).
  Privacy-conscious traders pick a settler distinct from their
  worker operator, or self-settle.
- **Worker** — operational off-chain relay. Coordinates intent
  submission, settler claiming, and `T_INTENT_ATTEST`
  soft-confirmations. Cannot make invalid envelopes valid; only
  signed worker attestations carry weight. Permissionless and
  replaceable.

## Wrapping + collateral

- **Slot** — a cBTC.zk unit. Backed by a real BTC UTXO at L1 locked
  to `K_btc = r_leaf · G_secp256k1`. The same leaf secret that proves
  mixer-set membership signs the backing BTC. One leaf, two locks.
- **Lien** — indexer-enforced restriction on a tacit-asset UTXO
  (specifically, an LP-share UTXO backing a cBTC.tac position). The
  liened UTXO can be observed but tacit-aware wallets refuse to
  construct txs that spend it in lien-violating ways. Violations
  are slashed (TAC bond moves to insurance pool, compensating
  cBTC.tac holders). Distinct from a Bitcoin-consensus lock — same
  trust model that already makes Runes/Ordinals tradeable, applied
  to a restriction semantic.
- **Bond** — separate concept from lien: an `T_LP_BOND` envelope
  attaches LP-share value to a yield farm for streamed reward
  emissions. Bond receipts are non-transferable in v1. Farm
  refunds unspent treasury after `end_height + ~7 days`. See
  `spec/amendments/SPEC-AMM-FARM-AMENDMENT.md`.

## Trust legs

- **Indexer consensus** — same trust model as Runes / Ordinals.
  Anyone runs an indexer; all reach the same verdict from chain
  data alone. Underwrites every tacit asset's value, including
  TAC's role as collateral.
- **Cryptographic** — Pedersen binding (DLP on secp256k1 or BJJ
  prime subgroup), Groth16 knowledge soundness (BN254 AGM), BIP-340
  Schnorr, sigma cross-curve binding (Fiat-Shamir under random
  oracle). What rules out inflation, double-spend, and recipient
  substitution.
- **Economic** — TAC over-collateralization for cBTC.tac (MakerDAO-
  shape), slash-on-violation for liened LP-share UTXOs, tip
  competition for settlers, arbitrage realignment for AMM curation
  MEV. What aligns honest behavior when cryptography can't directly
  enforce it.

## References

- [`SPEC.md`](./SPEC.md) — canonical wire-format authority.
- [`AMM.md`](./AMM.md) — AMM architecture.
- [`MIXER.md`](./MIXER.md) — mixer architecture.
- [`spec/CIRCUITS.md`](./CIRCUITS.md) — how the ZK stack composes.
- [`spec/amendments/`](./amendments/) — per-feature specifications.
- [`AMENDMENTS.md`](./AMENDMENTS.md) — amendment index + status.
