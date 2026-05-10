# tacit AMM — approach

> A **Runes-style indexer-validated meta-protocol** that adds an
> **automated market maker** with confidential trade amounts (Pedersen),
> mixer-style **anonymous LP positions** (Poseidon merkle tree +
> nullifiers), and constant-product price discovery (Groth16-enforced) —
> all anchored to Bitcoin L1 data availability. No bridges, no
> sidechains, no federation. The cryptographic primitives reuse the
> mixer's stack (§5.10–§5.11); the *composition* of these specific
> things into an AMM on Bitcoin L1 appears to be without a direct
> production peer at the time of writing.

This document is a **design sketch** — a positioning + architecture
summary for an AMM that builds on tacit's mixer infrastructure. The
normative wire format will live in `SPEC.md §5.12–§5.14` once the
sketch settles. **Status: design phase.** Nothing here ships yet.

## What it is

A confidential AMM for **tacit-native assets paired against BTC**.
A pool holds asset reserves (Pedersen-committed, confidential) and BTC
reserves (the pool UTXO's satoshi value, public). Anyone can swap BTC
for asset (or asset for BTC) at the constant-product price; the pool's
state transitions are enforced by Groth16 proofs the indexer verifies.
Liquidity providers deposit at the current ratio and receive a hidden
share leaf (mixer-style) they later nullify to withdraw their
proportional reserves plus accumulated fees.

The on-chain footprint is three new envelope opcodes — `T_LP_ADD`
(`0x2B`), `T_LP_REMOVE` (`0x2C`), and `T_SWAP` (`0x2D`) — riding on
regular Bitcoin commit + reveal taproot transactions. Bitcoin nodes
don't interpret the envelopes; indexers (reference: tacit's worker +
every dapp client) reconstruct pool state from chain alone and enforce
the protocol's rules client-side. The mixer's `POOL_INIT` pattern
(§5.10.1) is reused for AMM-pool creation as a `T_LP_ADD` sentinel
variant.

### At a glance

```
  WITHOUT AMM                         WITH TACIT AMM

  Alice has BTC                       Alice ──┐
  Bob has TACIT-X                             │  swap BTC → TACIT-X
                                              ▼
  must find each other,    ┌──────────────────────────────────────┐
  agree price, run         │   POOL  (asset_id, BTC)              │
  atomic-intent flow,      │                                      │
  one trade at a time      │   reserves:  C_A (Pedersen, hidden)  │
                           │              N sats (public)         │
                           │                                      │
                           │   LP shares: ●  ●  ●  ●  ●  ●  ●     │
                           │              opaque hidden leaves    │
                           │                                      │
                           │   invariant: (A - Δa)·(N + Δb·γ) ≥   │
                           │              A·N    [γ = 1 - fee]    │
                           └──────────────────────────────────────┘
                                              ▲
                                              │  swap or LP add/remove,
                                              │  Groth16-proved
                                              │
                                             Bob (LP, earns fees)

                           observer sees:
                             pool's BTC depth  (public sats)
                             swap volume       (BTC side public)
                             asset reserves    ✗ hidden
                             trade asset Δ     ✗ hidden
                             which LP withdrew ✗ hidden
```

That's the whole idea. Bitcoin carries the pool UTXO and the
state-transition proofs as opaque taproot envelope data; indexers
reconstruct reserves and the LP tree; Groth16 enforces the
constant-product invariant; nullifiers prevent double-withdrawal of LP
positions. The only public information is the BTC side — unavoidable,
since sats live in UTXO values, not envelopes.

## What it is not

- **Not a smart-contract AMM.** Bitcoin has no execution layer, no
  reentrancy concerns, no upgradable contracts. The "contract" is the
  Groth16 circuit + indexer rules, fixed at pool init by content-
  addressed `vk_cid` (same governance posture as the mixer).
- **Not a generalized DEX.** Each pool is a single `(asset_id, BTC)`
  pair. Asset-to-asset trades route through BTC as two sequential swaps
  in v1 (cf. Tempo's pathUSD hub model — BTC plays the role of the
  routing token, with the natural advantage of being the chain's
  native unit).
- **Not a fully private AMM.** BTC reserves and BTC trade volumes are
  public (UTXO values are unavoidable on Bitcoin). Asset reserves and
  asset trade amounts are confidential (Pedersen). LP positions are
  anonymous bearer secrets (mixer-style). The privacy story is
  **asymmetric by construction**, not by negligence.
- **Not novel cryptography.** Constant-product AMMs (Uniswap V2, 2020),
  Tornado-style anonymous-bearer positions (2019), Pedersen
  commitments on Bitcoin envelopes (MimbleWimble 2016 / RGB / tacit's
  CXFER), Groth16 in indexer-validated meta-protocols (tacit's mixer
  itself) — all prior art. The contribution is composition.
- **Not an L2.** Pool state is reconstructed from confirmed Bitcoin
  transactions; no sidechain, no bridge, no federation operates the
  pool. Any indexer can rebuild every pool from L1 alone.

## How it works (architectural)

Uniswap V2 on Ethereum is a smart contract: reserves live in contract
storage, the constant-product check is EVM bytecode, atomic
swap+update is one transaction's revert-safety, LP shares are an ERC20.
Bitcoin has none of those. Each V2-required function maps to a
different layer in tacit:

| V2 needs | On Ethereum | In tacit |
|---|---|---|
| Place to hold pool reserves | Contract storage slots `reserve0`, `reserve1` | A single tacit pool UTXO whose sats value is BTC reserve and whose envelope commits to the asset reserve |
| Constant-product invariant check | EVM bytecode `(x' * y') >= (x * y)` | Groth16 circuit verified by indexer over old/new reserve openings |
| Atomic swap + update | `swap()` transaction's all-or-nothing semantics | Bitcoin tx atomicity: spending pool UTXO + creating new pool UTXO + paying trader output happens in one tx or not at all |
| LP share token | ERC20 with `mint()` / `burn()` | Either (a) Tornado-style hidden bearer leaves in a per-pool merkle tree (default), or (b) a fresh tacit asset minted at pool init (alternative) |
| Reentrancy guard | `nonReentrant` modifier | Not applicable — no callbacks exist |

Why this works for tacit specifically: every primitive an AMM needs
was already shipped or designed for non-AMM flows. Pedersen amount
commitments were already there for `CXFER`. Pool merkle trees +
nullifiers + Groth16 + per-pool `vk_cid` content addressing were
already designed for the mixer (§5.10–§5.11). Asset-level identity
(`asset_id` = sha256 of an etch tx) was already there. The AMM adds
three envelope opcodes and a new (more complex) Groth16 circuit;
everything else recombines existing machinery.

### Cryptographic flow (swap)

```
┌─── TRADER ─────────────────────────┐  ┌─── INDEXER ──────────────────────────────────┐
│                                    │  │                                              │
│  inputs:                           │  │  on receiving the T_SWAP envelope:           │
│    pool UTXO                       │  │                                              │
│      (carries C_A, N_btc, root)    │  │   1. fetch current pool state                │
│    trader's BTC payment            │  │      (C_A_old, N_btc_old) for this asset_id  │
│                                    │  │                                              │
│  outputs:                          │  │   2. parse envelope:                         │
│    new pool UTXO                   │  │      C_A_new, N_btc_new (= new pool sats),   │
│      (C_A', N_btc + Δb)            │  │      C_out (trader's asset receipt),         │
│    trader's asset UTXO             │  │      Δb_LE (BTC paid to pool, public),       │
│      (carries C_out)               │  │      bind_hash, proof                        │
│                                    │  │                                              │
│  envelope payload:                 │  │   3. recompute bind_hash; reject on mismatch │
│    new pool commitments            │  │                                              │
│    trader output commitment        │  │   4. Groth16.verify(pool.vk,                 │
│    Δb (public, BTC side)           │  │        public_inputs = [                     │
│    Groth16 proof                   │  │          C_A_old, N_btc_old,                 │
│      • knows openings to all       │  │          C_A_new, N_btc_new,                 │
│        Pedersen commitments        │  │          C_out, Δb, fee_bps,                 │
│      • (A - Δa)·(N + Δb·γ) ≥ A·N   │  │          bind_hash                           │
│      • C_A' = (A - Δa)·H + r'·G    │  │        ], proof)                             │
│      • C_out = Δa·H + r_out·G      │  │                                              │
│      • range proofs on Δa, A'      │  │   5. external Pedersen / range checks (those │
│                                    │  │      cheap to do outside the circuit)        │
│  signs spend of pool UTXO via      │  │                                              │
│  envelope-script taproot path      │  │   6. on accept: replace pool state with new  │
│                                    │  │      (C_A', N_btc'), credit trader's UTXO    │
└──── broadcast to Bitcoin ──────────┘  │      as a spendable opening to (Δa, r_out)   │
                                        └──────────────────────────────────────────────┘
```

The pool UTXO is consumed and immediately recreated at the same
(deterministic) script address with updated state. Bitcoin enforces
that the new pool UTXO's sats value equals `N_btc_old + Δb` (because
the trader's BTC input + the pool's old sats must equal the new pool
output + the trader's optional change); the Groth16 proof enforces
that the asset side respects the constant-product invariant at the
declared `Δb` and `Δa`.

**LP add/remove use the same pool UTXO mechanism** — `T_LP_ADD` spends
the pool UTXO, deposits asset + BTC at the current ratio, recreates
the pool UTXO with larger reserves, and appends a new leaf to the LP
share tree. `T_LP_REMOVE` is the mixer-style mirror: prove unspent
membership in the share tree, nullify the leaf, withdraw proportional
reserves, recreate the pool UTXO smaller.

## The pool object

A pool is uniquely identified by `asset_id` (BTC is the implicit
counterparty). Pool init pins the Groth16 verifying key, the fee
basis points, and any other consensus-relevant parameters at content-
addressed `vk_cid` time, fixed forever — same posture as `POOL_INIT`
in §5.10.1.

Pool state, as reconstructed by the indexer:

| Field | Type | Visibility | Source of truth |
|---|---|---|---|
| `asset_id` | 32 B | public | pool init envelope |
| `vk_cid` | UTF-8 IPFS CID | public | pool init envelope |
| `fee_bps` | u16 (e.g., 30 = 0.3%) | public | pool init envelope |
| `reserve_btc` | u64 sats | public | the pool UTXO's `value` |
| `reserve_asset` | Pedersen commitment | hidden amount | the pool UTXO's envelope `C_A` field |
| `lp_share_root` | 32 B (Poseidon) | public | running merkle root over LP leaves |
| `lp_total_shares` | Pedersen commitment | hidden amount | running commitment updated by each ADD/REMOVE |
| `lp_nullifier_set` | set<32 B> | public | accumulated from accepted T_LP_REMOVE envelopes |
| `pool_outpoint` | (txid, vout) | public | the current head pool UTXO |

The indexer's job each block: walk new tacit envelopes in canonical
order, and for each AMM envelope spending the current `pool_outpoint`,
verify the proof, update reserves, advance `pool_outpoint` to the new
output. Conflicting spends of the same `pool_outpoint` are resolved
by Bitcoin consensus (only one wins); the indexer follows the chain.

### Why one canonical pool per asset

Multiple competing pools for the same `asset_id` would fragment
liquidity and complicate routing. v1 enforces **one canonical pool
per `asset_id`** by the same first-mover rule as ticker
disambiguation in CETCH (§4): the first canonically-ordered confirmed
`POOL_INIT` for `asset_id` becomes canonical; subsequent inits for
the same asset are silently ignored by the indexer.

## Operations

### `T_LP_ADD` (`0x2B`)

Adds liquidity at the current pool ratio. Mints a hidden LP share
leaf `poseidon(secret, ν, share_amount)` into the pool's merkle tree.

```
T_LP_ADD(1)
|| asset_id(32)
|| variant(1)                   0 = add, 1 = POOL_INIT sentinel
|| Δb_LE(8)                     BTC contributed (public, must equal sats delta)
|| C_asset_in(33)               Pedersen commitment to asset contributed
|| C_pool_asset_new(33)         new pool asset reserve commitment
|| C_pool_shares_new(33)        new total-shares commitment
|| leaf_commitment(32)          poseidon(secret, ν, share_amount) — appended to tree
|| bind_hash(32)
|| proof_len(2)
|| proof(proof_len)             Groth16 proof
```

Public inputs to the Groth16 verifier:
`[C_pool_asset_old, reserve_btc_old, C_pool_asset_new, reserve_btc_new,
  C_asset_in, Δb, C_pool_shares_old, C_pool_shares_new, leaf_commitment,
  bind_hash]`.

The circuit proves:
1. Knowledge of openings for all Pedersen commitments.
2. Contributed at the current ratio: `Δa / A_old == Δb / N_btc_old` (with
   tolerance handled by the dust-rounding rule the circuit encodes).
3. Shares minted = `min(Δa/A_old, Δb/N_btc_old) · S_old` where `S_old`
   is the prior total share supply.
4. New pool reserves are `A_old + Δa` and `N_btc_old + Δb`.
5. New share total is `S_old + share_amount`.
6. `leaf_commitment == poseidon(secret, ν, share_amount)` (binds the
   secret leaf to the deposit).
7. Range proofs on `Δa`, `A_new`, `share_amount` (≤ 64 bits, mixer's
   bulletproof model).

#### POOL_INIT variant (`variant = 1`)

Pool creation is `T_LP_ADD` with `variant = 1`. The remainder of the
payload differs:

```
T_LP_ADD (POOL_INIT shape)
|| asset_id(32)
|| variant(1) = 1
|| Δb_LE(8)                     initial BTC reserve
|| C_asset_in(33)               initial asset reserve commitment
|| fee_bps(2)                   pool fee in basis points (e.g. 30 = 0.3%)
|| vk_cid_len(1)
|| vk_cid(vk_cid_len)
|| ceremony_cid_len(1)
|| ceremony_cid(...)
|| leaf_commitment(32)          poseidon(secret, ν, sqrt(Δa·Δb))
|| init_sig(64)                 BIP-340 over init_msg
```

Initial total shares = `sqrt(Δa · Δb)` (Uniswap V2 convention; pinned
in the circuit). `MINIMUM_LIQUIDITY` lockup analogous to V2 may apply
— see open questions.

Once a pool is initialized, its `vk_cid` and `fee_bps` are fixed
forever. No upgrade path; new fee tier or new circuit ⇒ new asset_id
or a separately-named pool variant. **No special privilege governs
pool initialization** — first canonically-ordered confirmed init wins.

### `T_LP_REMOVE` (`0x2C`)

Burns an LP share leaf and withdraws proportional reserves. Mixer-
style: nullifier prevents double-spend, Groth16 hides which leaf was
the redeemer's.

```
T_LP_REMOVE(1)
|| asset_id(32)
|| merkle_root(32)              claimed LP-tree root (must match a recent canonical root)
|| nullifier_hash(32)           public; must be unique within this pool
|| Δb_LE(8)                     BTC withdrawn (public, equals sats delta out of pool)
|| C_asset_out(33)              Pedersen commitment to asset withdrawn
|| C_pool_asset_new(33)         new pool asset reserve commitment
|| C_pool_shares_new(33)        new total-shares commitment
|| recipient_btc(20)            P2WPKH hash160 for BTC payout
|| recipient_asset_commit(33)   Pedersen commitment for the asset UTXO
|| bind_hash(32)
|| proof_len(2)
|| proof(proof_len)
```

Public inputs:
`[C_pool_asset_old, reserve_btc_old, C_pool_asset_new, reserve_btc_new,
  C_asset_out, Δb, C_pool_shares_old, C_pool_shares_new, merkle_root,
  nullifier_hash, recipient_asset_commit, bind_hash]`.

The circuit proves:
1. The redeemer knows `(secret, ν, share_amount)` such that
   `poseidon(secret, ν, share_amount)` is in the tree at `merkle_root`.
2. `nullifier_hash == poseidon(ν)` (mixer convention, §3.8).
3. Withdrawn at the current ratio: `Δa / A_old == Δb / N_btc_old ==
   share_amount / S_old`.
4. New pool reserves are `A_old − Δa` and `N_btc_old − Δb`.
5. New share total is `S_old − share_amount`.
6. `recipient_asset_commit` opens to the same `Δa` (with a fresh
   blinding the redeemer chose).
7. Range proofs.

External Pedersen check (mixer pattern, §5.11):
`recipient_asset_commit` opens to the declared `Δa` against a
revealed `r_out` published in the envelope (omitted from the wire
sketch above for brevity — same role as `r_leaf` in §5.11).

### `T_SWAP` (`0x2D`)

Executes a swap through the pool. Direction is encoded by sign of the
deltas (one side's δ is into the pool, the other's is out).

```
T_SWAP(1)
|| asset_id(32)
|| direction(1)                 0 = BTC→asset, 1 = asset→BTC
|| Δb_LE(8)                     public BTC delta (signed by direction)
|| C_asset_io(33)               Pedersen commitment to trader's asset I/O
|| C_pool_asset_new(33)         new pool asset reserve commitment
|| recipient_or_input_proof_data(varies by direction)
|| bind_hash(32)
|| proof_len(2)
|| proof(proof_len)
```

Public inputs (BTC→asset direction):
`[C_pool_asset_old, reserve_btc_old, C_pool_asset_new, reserve_btc_new,
  C_asset_io, Δb, fee_bps, recipient_asset_commit, bind_hash]`.

The circuit proves the constant-product invariant with fee:
```
(A_old − Δa) · (N_btc_old + Δb) ≥ A_old · N_btc_old · (1 + Δb·fee_bps / (N·10000))
```
…or the more standard V2 form:
```
γ := (10000 − fee_bps) / 10000
(A_old − Δa) · (N_btc_old + Δb·γ) ≥ A_old · N_btc_old
```
(exact form pinned by the circuit; both are constant-product with a
0.3%-style cut routed to the pool). Plus knowledge of openings,
recipient binding, and range proofs.

Asset→BTC is symmetric.

`fee_bps` is a public input fixed at pool init. Fee revenue accrues
in-place: the invariant inflates by the fee fraction every swap, so
the per-share value monotonically rises and LPs realize fees on
withdraw. Same accounting as Uniswap V2.

## Contention model — the batcher

Single pool UTXO ⇒ at most one tx per Bitcoin block can touch it. This
is the same constraint Cardano DEXes hit (eUTXO inheritance) and the
same answer applies: **batchers**.

### Direct mode (single trader, single block)

A trader can spend the pool UTXO themselves. Works fine when contention
is low; degrades to "first-broadcast wins, others get evicted" under
contention. Acceptable for low-volume pools.

### Batched mode (recommended for any non-trivial volume)

Traders post **swap intents** as off-chain signed records:

```
swap_intent {
  intent_id     16 B (sha256(asset_id || trader_pubkey || nonce)[:16])
  asset_id      32 B
  direction     u8 (0 = BTC→asset, 1 = asset→BTC)
  amount_in     u64 (cleartext for the public side, Pedersen commit for the hidden side)
  min_out       u64 — slippage protection: settlement aborts the trader's leg if violated
  expiry        unix-seconds
  trader_pubkey 33 B
  intent_sig    BIP-340 over the canonical msg
}
```

Anyone can run a **batcher**: collect N intents, build one Bitcoin tx
that spends the pool UTXO, consumes each intent's BTC inputs, and
produces N+1 outputs (new pool UTXO + N trader receipts). The envelope
carries one aggregate Groth16 proof showing each intent settled at the
sequentially-applied constant-product price.

**Batcher economics.** Each intent specifies a tip (sats) the batcher
keeps. Batchers compete on inclusion latency. Trader's `min_out`
defends against adversarial reordering — if the batcher sandwiches an
intent past its `min_out`, the proof for that intent fails and the
intent is dropped from the batch. Permissionless (anyone can batch),
no protocol-level batcher set.

**Worker endpoints (reference, mirrors §5.7.6 atomic-intent layout):**

```
POST   /pools/:asset_id/swap-intents
GET    /pools/:asset_id/swap-intents
DELETE /pools/:asset_id/swap-intents/:intent_id          (signed cancel)
GET    /pools/:asset_id/state                            (current reserves, root, etc.)
```

Like atomic intents (§5.7.7), the swap-intent layer is implementation-
defined and sits entirely outside the on-chain protocol. The on-chain
T_SWAP envelope is identical whether the trade went through a batcher
or direct.

## Trust model

**Soundness** (= "is the pool's accounting correct?") is **trustless
under standard cryptographic assumptions**:

- Groth16 proofs verify under the published `vk` regardless of who runs
  the verifier; the dapp re-runs verification client-side.
- Pool state reconstruction is byte-deterministic from chain (the
  current pool UTXO carries the latest state in its envelope; full
  history is recoverable from chain).
- Nullifier set is content-addressable. Worker, dapp, third-party
  indexers arrive at the same spent-set (SPEC §11 determinism).
- Pedersen commitments are publicly checkable; range proofs prevent
  negative-balance underflow.

The reference worker (and any batcher) can DoS users (refuse to relay,
refuse to batch) but cannot cheat them. Traders' `min_out` defends
against batcher sandwich. Anyone can run their own indexer + batcher
from chain data alone.

**Liveness** (= "can you trade?") depends on at least one working
indexer + at least one available batcher (or willingness to spend the
pool UTXO directly). Both are permissionless. The reference worker
provides one indexer + one batcher; the dapp can swap to self-hosted
in a one-line edit.

## Privacy model

**What's hidden (cryptographic, unconditional under Pedersen + Groth16):**

- Asset reserves of every pool.
- The asset side of every swap (how much asset moved).
- Each LP's share size (committed in their leaf).
- Which LP withdrew at any given `T_LP_REMOVE` (Tornado-style
  unlinkability within the pool's anonymity set).

**What's public (unavoidable):**

- BTC reserves of every pool (UTXO sats).
- The BTC side of every swap (delta in pool UTXO sats).
- Total LP share supply (it's a Pedersen commitment but bracketed by
  observable swap sizes — over time, it can be approximated). Mitigation
  if needed: per-block reserve commitments only; no exposed totals
  field. See open questions.
- Pool `vk_cid`, `fee_bps`, current `pool_outpoint`.

**Operational privacy** (= "is your trade or LP position linkable to
your other Bitcoin activity?") depends on the same three things as the
mixer (§5.11.4): anonymity-set size for LP withdraws (live count
surfaced in the dapp), Bitcoin-level fee linkage on the broadcast tx
(use a fresh wallet or a relayer), and network/timing correlation
(Tor + delay).

A swap is trivially linkable to the trader's Bitcoin wallet (the BTC
input/output is theirs). The asset side is hidden, but observers learn
"this Bitcoin wallet swapped X sats with the pool." If the trader
wants the asset-side recipient to be unlinkable from their BTC wallet,
they should subsequently CXFER the received UTXO to a fresh address —
the asset blinding is only known to them, so the chain-graph link
exists only on the BTC side.

## What's novel here

The novelty is the **composition**, not any single piece. Each piece
is prior art and we concede that immediately:

- **Constant-product AMMs:** Uniswap V2 (2020), Bancor (2017).
- **Tornado-style hidden-bearer LP positions:** Tornado Cash (2019),
  Aztec (LP positions in private Plonk circuits), Penumbra (shielded
  pool positions in ZSwap).
- **Pedersen on Bitcoin envelopes:** MimbleWimble (2016), RGB,
  tacit's CXFER.
- **Groth16 in indexer-validated meta-protocols:** tacit's mixer.
- **Batcher pattern for UTXO-DEX contention:** Cardano DEXes
  (SundaeSwap, Minswap, Spectrum — 2022).
- **Routing through a single quote asset:** Tempo's pathUSD model
  (BTC plays the analogous role for tacit).

The claim — narrower and harder to attack than "novel cryptography" or
"first AMM" — is that **this specific composition on Bitcoin L1**
doesn't have a live production peer:

- Indexer-validated Bitcoin meta-protocols so far have been
  **transparent** (Runes, BRC-20, Ordinals, STAMPS, Alkanes, OP_NET)
  and **non-AMM** (no protocol-level price discovery; trading is
  entirely OTC marketplaces atop the asset layer).
- AMMs on Bitcoin sidechains and rollups (Liquid SideSwap, BOB,
  Citrea) execute off-chain with L1 verification, not as L1
  meta-protocols.
- Confidential AMMs (Penumbra ZSwap, Aztec) live on Cosmos / their
  own L1.
- Bitcoin-native trading (Magic Eden runes, Bisq, atomic-swap markets)
  is OTC / RFQ, not pooled-liquidity AMM.

The achievement, if shipped, is the assembly: a pooled-liquidity AMM
with confidential trade amounts, anonymous LP positions, content-
addressed Groth16 governance, and permissionless batchers, running as
a meta-protocol on Bitcoin L1.

### Adjacent designs reviewers will bring up

- **SideSwap / Liquid AMMs.** Run on Liquid Network (federated
  sidechain). Confidential amounts via Liquid's CT, but federation
  trust model. Different category.
- **Penumbra ZSwap.** Closest cryptographic analog — confidential
  Pedersen amounts + ZK-enforced AMM. Runs on Cosmos as its own L1,
  not as a meta-protocol on Bitcoin.
- **Citrea / Botanix DEXes.** Bitcoin rollups with EVM execution;
  inherit the rollup's trust model (challenge-game operator set,
  fraud proofs, BitVM 1-of-n). Tacit's AMM doesn't need any of that
  — it reads from L1 envelope data and computes the answer
  deterministically.
- **Cardano DEXes (SundaeSwap, Minswap, Spectrum).** Closest
  architectural analog for the batcher pattern. Different VM (eUTXO
  with Plutus scripts), but the batcher solution to single-pool-UTXO
  contention is direct prior art.
- **RGB AMMs (research-stage).** Client-side validation on Bitcoin,
  conceptually adjacent. No shipped pooled-liquidity AMM at the time
  of writing.

## What's not novel

- Constant-product AMM (Uniswap V2, 2020).
- Tornado-style nullifier-based unlinkability (2019).
- Pedersen commitments + bulletproofs for confidential amounts (2015–
  2018).
- Indexer-validated meta-protocols on Bitcoin (Ordinals 2023, etc.).
- Batcher pattern for UTXO-DEX parallelism (Cardano, 2022).
- Pool-share lockup (`MINIMUM_LIQUIDITY`) to prevent first-LP attacks
  (Uniswap V2 inherited from earlier Bancor designs).

## Differences from Uniswap V2

| | Uniswap V2 | tacit AMM |
|---|---|---|
| Reserves | EVM storage slots, public uint112 | One pool UTXO; BTC = sats (public), asset = Pedersen commit (hidden) |
| LP shares | ERC20 with public balances | Hidden bearer leaves in Poseidon merkle tree, mixer-style |
| Invariant check | EVM bytecode | Groth16 verified by indexer |
| Atomicity | EVM transaction revert | Bitcoin tx all-or-nothing (one tx spends pool, recreates pool, pays trader) |
| Concurrency | Many traders per block | One pool spend per block ⇒ batcher pattern (Cardano-style) |
| Fee | 0.3% per swap, accumulates in reserves | Same — `fee_bps` pinned at pool init, accumulates in reserves |
| Pool creation | Permissionless (factory contract) | Permissionless (first canonical `POOL_INIT` wins per asset_id) |
| Routing | Many pairs, n² liquidity fragmentation | One pool per asset (vs. BTC); asset↔asset routes via two swaps through BTC (Tempo pathUSD analog) |
| Privacy | None (everything public) | Asset side hidden; BTC side public |
| Upgrades | None (V2 is immutable) | None (each pool's `vk_cid` is content-addressed and fixed) |

## Differences from Penumbra ZSwap

| | Penumbra ZSwap | tacit AMM |
|---|---|---|
| Substrate | Penumbra L1 (Cosmos) | Bitcoin L1 (meta-protocol) |
| Pricing model | **Frequent batch auctions** (uniform clearing price per block) | Constant product per swap; sequential within a batcher's tx |
| MEV story | Eliminated within a batch (uniform price) | `min_out` slippage protection; uniform-price upgrade is a future extension (see open questions) |
| LP positions | Concentrated-liquidity ranges (Uniswap V3-style), confidential | Constant-product, range = full curve; hidden bearer leaves |
| Confidentiality | Both sides hidden (Penumbra's UM is shielded by default) | Asymmetric: asset side hidden, BTC side public |

## Open design questions

These are deliberately left unresolved in this sketch. Each one swings
the design materially.

1. **LP-share scheme: anonymous-bearer (mixer-style) vs. tacit-asset
   (ERC20-style).** Sketch above assumes mixer-style. The alternative
   is to mint a fresh tacit asset at `POOL_INIT` and use ordinary
   `T_MINT` / `T_BURN` for LP add/remove. Pros: simpler circuit, LP
   shares composable with the existing mixer (privacy via
   composition), LP shares transferable / collateralizable. Cons:
   not "mixer-AMM" anymore in the same direct sense.

2. **Pricing model: per-swap constant product vs. per-batch uniform
   clearing.** Sketch assumes per-swap. Uniform-clearing (Penumbra-
   style) eliminates intra-batch MEV entirely but needs a more complex
   circuit and a coordinator-of-record per batch.

3. **MINIMUM_LIQUIDITY lockup.** Uniswap V2 burns 1000 wei of LP shares
   at first deposit to prevent a class of share-rounding attacks. Same
   problem applies; same fix should apply. Pin in circuit.

4. **Batcher economics.** Tip-per-intent, fixed-fee, or
   priority-auction? Affects intent record schema.

5. **Pool UTXO loss recovery.** If a pool UTXO is malformed or burned,
   reserves are stranded. Options: (a) accept it (the asset-side
   reserves are still recoverable in principle from envelope data,
   even if the BTC side is gone); (b) define an indexer-level recovery
   rule that "republishes" the pool from the last valid state via a
   special envelope; (c) require pool UTXOs to be created at a
   deterministic well-known script anyone can rebuild from. Probably
   (a) for v1 with operational discipline, (c) as a hardening measure.

6. **Asset↔asset routing.** Two-hop through BTC works but doubles fees
   and breaks atomicity (each hop is a separate Bitcoin tx). A
   single-tx multi-hop swap envelope is feasible but adds circuit
   complexity. Defer to v2.

7. **Concentrated liquidity (V3-style).** Significantly more complex
   circuit; defer entirely; v1 is V2-style full-range only.

8. **Public vs. hidden total share supply.** Sketch above commits
   `lp_total_shares` as a Pedersen commitment but practical observers
   may infer it from the sequence of public BTC deltas. Decide whether
   to even pretend it's hidden.

## Status

- ⏸ Wire format + envelope opcodes (sketched here; not yet in `SPEC.md`)
- ⏸ Pool state object (sketched; not yet in `SPEC.md §11`)
- ⏸ Groth16 circuits (`add.circom`, `remove.circom`, `swap.circom`)
- ⏸ Phase 2 ceremony coordination (will reuse mixer's coordinator)
- ⏸ Browser-side prover + verifier (will reuse mixer's snarkjs vendoring)
- ⏸ Worker indexing of pool state, swap-intent layer, batcher logic
- ⏸ Dapp UI (pool browser, LP add/remove, swap, intent posting)
- ⏸ Determinism rules in `SPEC.md §11` for pool reconstruction
- ⏸ Recovery semantics (pool UTXO loss, intent expiry, etc.)
- ⏸ Tests

Everything is design-phase. Nothing is implemented.

## Open / honest caveats

- **Asymmetric privacy.** BTC reserves and BTC trade volumes are
  public. This is unavoidable on Bitcoin L1 — sats live in UTXO values.
  The asset side is fully confidential, which is still a meaningful
  privacy gain over transparent meta-protocols (Runes, BRC-20).
- **Single-pool-UTXO contention.** Direct mode handles ≤ 1 tx per
  block; meaningful throughput requires a working batcher layer, which
  is permissionless but coordination-dependent. Same constraint
  Cardano DEXes operate under daily.
- **Circuit complexity.** Constant-product + fee + range proofs +
  Pedersen openings + (for `T_LP_REMOVE`) Poseidon merkle proof is
  meaningfully larger than the mixer's circuit. Per-pool `vk_cid`
  governance applies; per-circuit Phase 2 ceremony applies.
- **First-LP price-setting.** Whoever runs `POOL_INIT` sets the
  initial price. Standard problem; standard fix (founder seeds at fair
  market price; arbitrage corrects misprice quickly post-launch).
- **Anonymity-set strength scales with pool LP count.** A pool with 3
  LPs gives ≤ 3 anonymity for `T_LP_REMOVE`. The dapp surfaces a
  warning, same UX as the mixer.
- **Indexer-validated, not Bitcoin-consensus-enforced.** Same trust
  model as Runes / Ordinals / tacit's mixer. Well-established but
  readers should understand it.

## Defensible one-paragraph summary

> A Runes-style indexer-validated meta-protocol on Bitcoin L1 that
> adds a constant-product AMM with confidential trade amounts
> (Pedersen commitments) and Tornado-style anonymous LP positions
> (Groth16 + nullifiers + Poseidon merkle tree). Reserves live in a
> single pool UTXO per asset (BTC side public via UTXO sats; asset
> side hidden via envelope commitment); state transitions are enforced
> by per-pool Groth16 circuits the indexer verifies. Single-pool-UTXO
> contention is solved by a Cardano-style permissionless batcher
> layer. No bridges, no sidechains, no federation — pool state is
> reconstructed from L1 envelope data; proofs are verified
> client-side. The cryptographic primitives reuse tacit's mixer stack;
> the *composition* of these specific things into an AMM on Bitcoin L1
> doesn't appear to have a live production peer. Engineering and
> integration achievement, not cryptographic invention.

## References

- SPEC: [`SPEC.md`](./SPEC.md) — normative tacit spec
- MIXER: [`MIXER.md`](./MIXER.md) — companion architecture summary
- Uniswap V2 whitepaper: <https://uniswap.org/whitepaper.pdf>
- Penumbra ZSwap: <https://protocol.penumbra.zone/main/zswap.html>
- Cardano DEX batcher pattern (SundaeSwap design notes,
  Minswap docs): <https://docs.minswap.org/>
- Tempo DEX (pathUSD routing): <https://docs.tempo.xyz/guide/stablecoin-dex>
- Tornado Cash whitepaper: <https://tornado.cash/Tornado.pdf>
- Indexer-validated meta-protocol pattern: <https://docs.ordinals.com/>
