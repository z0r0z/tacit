# tacit AMM — approach

> A **Runes-style indexer-validated meta-protocol** that adds a
> **uniform-clearing-price block-batched AMM** between any two
> tacit-native confidential assets — built on the same virtual-pool
> architecture as the mixer (no UTXO custody anywhere in the
> protocol). Confidential per-trader amounts via Pedersen, public
> aggregate reserves for trustless reconstruction, mixer-composable
> LP shares for anonymous positions. All anchored to Bitcoin L1
> data availability. No bridges, no sidechains, no federation, no
> smart contracts. The cryptographic primitives reuse the mixer's
> stack (§5.10–§5.11); the *composition* of these specific things
> into an AMM on Bitcoin L1 appears to be without a direct production
> peer at the time of writing.

This document is the architecture summary for the AMM extension
to the tacit protocol. It adds three new opcodes (`T_LP_ADD`
`0x2B`, `T_LP_REMOVE` `0x2C`, `T_SWAP_BATCH` `0x2D`), a
deterministic `lp_asset_id` derivation rule, AMM-specific
receipt-recovery derivations, and an envelope-hash `OP_RETURN`
binding rule for batched settlement — all built on the same
indexer-validated virtual-pool pattern as tacit's mixer
(SPEC §5.10–§5.11). The normative spec lands in
[`SPEC.md` §5.12–§5.14 and §11](./SPEC.md) once this design
solidifies.

## In plain English

The mixer's central trick is that **the pool is just a number**. No
UTXO holds the deposit funds; the indexer tracks "this pool has N
deposits at denomination D" by reading the chain. Withdrawals
present a ZK proof and the indexer credits a fresh UTXO. Nobody
custodies anything; the pool is an attestation.

The AMM is the same trick with two numbers and a curve. A pool of
asset A and asset B is just two reserves the indexer tracks. LPs
deposit, reserves go up. Traders swap, reserves rebalance along a
constant-product curve. LPs withdraw, reserves go down. No UTXO
holds the pool, so no party can rug.

Beyond what the mixer needs, the AMM adds three things:

1. **A price curve** — `R_A · R_B` stays roughly constant per
   Uniswap V2.
2. **Batched settlement at one fair price** — each block, anyone
   can act as a settler: pick up outstanding swap intents, compute
   one clearing price, settle them in one Bitcoin transaction.
   Everyone in a batch trades at the same price, so sandwich
   attacks become structurally impossible.
3. **LP shares as a confidential tacit asset** — minted at deposit
   time. Because LP shares are themselves tacit assets, the
   existing mixer just works on them: an LP can mix their share
   UTXO between deposit and redemption to get an anonymous LP
   position, with no new privacy machinery invented.

Real BTC sats can't fit the virtual-pool model (they would need
real custody, and Bitcoin Script can't enforce "this UTXO can only
be spent into a valid pool transition"). BTC trading therefore goes
through cBTC, a wrapped-BTC tacit asset with its own bridge trust
model — a separate document, isolated from the AMM's design.

## What it is

A confidential AMM for **tacit-asset ↔ tacit-asset** trading pairs.
Each pool is keyed by an unordered pair of tacit asset_ids. Pool
reserves and LP-share supply are tracked as **virtual public
quantities** by the indexer — no pool UTXO holds any value, and no
party — founder, federation, settler — custodies anything. Once per
Bitcoin block a permissionless settler bundles all queued swap
intents and settles them in a single batch transaction at one
**uniform clearing price**, derived from the constant-product curve
at the batch's net delta. Liquidity providers deposit at the current
ratio and receive **confidential LP-share asset UTXOs**; LPs who
want anonymous positions deposit those LP-shares into the existing
mixer and withdraw to a fresh address.

The on-chain footprint is three new envelope opcodes — `T_LP_ADD`
(`0x2B`), `T_LP_REMOVE` (`0x2C`), and `T_SWAP_BATCH` (`0x2D`) —
riding on regular Bitcoin commit + reveal taproot transactions.
Bitcoin nodes don't interpret the envelopes; indexers reconstruct
pool state from chain alone and enforce the protocol's rules
client-side. Pool creation reuses the mixer's `POOL_INIT` pattern
(§5.10.1) as a `T_LP_ADD` sentinel variant.

### Trading BTC: via cBTC

The AMM doesn't directly trade native BTC — every reserve in every
pool is a tacit asset. To trade sats, users wrap into **cBTC**
(tacit's wrapped-BTC asset; see README) and trade `cBTC ↔ tacit-X`
in the AMM. The cBTC bridge has its own custody trust assumption,
documented separately; the AMM inherits that trust without
compounding it. Restricting the AMM to virtual-asset-only pools is
what removes any need for in-protocol custody.

### At a glance

```
  WITHOUT AMM                          WITH TACIT AMM

  Alice has TACIT-X                    Alice ──┐  swap intent
  Bob has cBTC                         Bob ────┤  swap intent
  Carol has cBTC                       Carol ──┤  swap intent
                                               ▼
  must find each other,     ┌──────────────────────────────────────┐
  agree price, run          │   POOL  (asset_A, asset_B)  VIRTUAL  │
  atomic-intent flow,       │                                      │
  one trade at a time       │   reserves:  R_A  (public u64)       │
                            │              R_B  (public u64)       │
                            │   lp shares: S    (public u64)       │
                            │                                      │
                            │   ★ no UTXO holds these reserves ★   │
                            │   indexer reconstructs from chain    │
                            │                                      │
                            │   each block, settler bundles all    │
                            │   queued intents at one price:       │
                            │                                      │
                            │     P_clear = |Δa_net| / |Δb_net|    │
                            │     subject to constant-product +    │
                            │     fee invariant on net flow        │
                            │                                      │
                            │   one Bitcoin tx consumes N intent   │
                            │   UTXOs → emits N receipts (opposite │
                            │   asset, one per leg)                │
                            └──────────────────────────────────────┘

                            observer sees:
                              pool reserves R_A, R_B   (public)
                              clearing price           (Δa_net / Δb_net)
                              individual trade amounts ✗ hidden
                              which trader did what    ✗ hidden in batch
                              which LP redeemed        ✗ hidden (if mixed)
```

Bitcoin carries the batch state-transition proofs as opaque taproot
envelope data; indexers reconstruct reserves and the LP-share supply
ledger; Groth16 binds each per-trader commitment to a shared uniform
clearing price; aggregate pool state is public and trustlessly
auditable, individual participation is hidden.

## What it is not

- **Not a smart-contract AMM.** Bitcoin has no execution layer. The
  "contract" is the Groth16 circuit + indexer rules, fixed at pool
  init by content-addressed `vk_cid`.
- **Not a per-swap CFMM.** Pricing is per-batch uniform clearing, not
  per-swap constant product. Within a block all traders pay or
  receive the same price; the constant-product invariant binds the
  batch's net flow, not individual fills.
- **Not a BTC-paired AMM.** BTC trading happens via cBTC. The
  wrapping has its own trust model; the AMM does not.
- **Not a custodial protocol.** No party holds any pool's funds.
  Reserves are virtual quantities the indexer attests to, identical
  in posture to the mixer's `(deposits − withdrawals)` accounting.
- **Not a fully private AMM.** Pool reserves are public — the cost
  of trustless reconstruction. Individual trades and LP positions
  are confidential. The privacy story is **per-participant
  confidential, per-pool transparent**, the same posture as the
  mixer.
- **Not novel cryptography.** Constant-product AMMs (Uniswap V2),
  uniform-clearing batch auctions (Gnosis Protocol, Penumbra ZSwap),
  Pedersen on Bitcoin envelopes (MimbleWimble / RGB / tacit's
  CXFER), Groth16 in indexer-validated meta-protocols (tacit's
  mixer) — all prior art.
- **Not an L2.** Pool state is reconstructed from confirmed Bitcoin
  transactions. Any indexer can rebuild every pool from L1 alone.

## How it works (architectural)

Uniswap V2 on Ethereum is a smart contract: reserves live in
storage, the constant-product check is EVM bytecode, atomic
swap+update is the transaction's revert-safety, LP shares are an
ERC20. Penumbra's ZSwap on Cosmos is a per-block batch auction over
shielded amounts. Bitcoin has neither runtime. The mixer already
shows that tacit can host a UTXO-less indexer-tracked virtual pool
with cryptographic enforcement; the AMM extends the same pattern
from leaf-membership accounting to curve-respecting state
transitions.

| AMM needs | On Ethereum (V2) | On Penumbra (ZSwap) | In tacit |
|---|---|---|---|
| Place to hold reserves | Contract storage | Validator-tracked notes | Indexer-tracked virtual quantity (mixer pattern) |
| Pool spend authorization | Implicit in contract call | Validator consensus | N/A — there is no pool UTXO to spend |
| Constant-product check | EVM bytecode | Action handler | Indexer arithmetic on public reserves; Groth16 binds hidden per-trader amounts |
| Atomic settle | EVM tx revert | End-of-block batch action | Bitcoin tx all-or-nothing: consumes N trader inputs, emits N receipts |
| LP share token | ERC20 | LPNFT (Penumbra position) | Confidential tacit asset minted at pool init; mixer-composable |
| Pricing model | Per-swap constant product | Per-block uniform clearing | Per-block uniform clearing |
| MEV mitigation | None native | Eliminated within batch | Intra-batch eliminated (uniform price); cross-batch curation mitigated by opt-in arbiter |
| BTC custody | N/A | N/A | Out of scope — handled by cBTC wrapper |

Every primitive the AMM needs was already in tacit. Pedersen
amount commitments existed for `CXFER`. The virtual-pool pattern
(no UTXO custody, indexer attests to balances) was proven by the
mixer. Per-pool `vk_cid` content addressing, Phase 2 ceremony
coordination, and browser-side Groth16 proof generation /
verification were already designed for the mixer (§5.10–§5.11).
Asset-level identity (`asset_id` = sha256 of an etch tx) was
already there. The AMM adds three envelope opcodes and a new
batch-clearing Groth16 circuit; everything else recombines existing
machinery.

### Cryptographic flow (batched swap)

```
┌─── INTENT POOL (off-chain) ────────┐  ┌─── SETTLER (anyone) ─────────────────────────┐
│                                    │  │                                              │
│  trader 1 (A→B):                   │  │  reads current pool state (R_A, R_B, S)      │
│    input UTXO of A                 │  │  reads queued intents for this pool          │
│    Pedersen commit C_in_secp       │  │                                              │
│    Poseidon commit C_in_BN254      │  │  picks subset {i₁, …, iₙ}; runs deterministic│
│    cross-curve binding proof       │  │  clearing solve over public reserves + γ:    │
│    min_out, tip, expiry            │  │    Δa_in_net = gross A-side residual         │
│    intent_sig (BIP-340)            │  │    Δb_out_net = floor(R_B·γ·Δa_in_net /      │
│                                    │  │                       (R_A + γ·Δa_in_net))   │
│  trader 2 (B→A): symmetric         │  │    P_clear   = Δa_in_net / Δb_out_net        │
│  …                                 │  │                                              │
│                                    │  │  drops any intent failing min_out at P_clear │
│  trader dapps keep websockets      │  │  re-solves until stable                      │
│  open to a worker (relay only)     │  │                                              │
│  through `expiry`                  │  │  RTT 1: asks each trader for opening blob    │
└──────────────────┬─────────────────┘  │  (amount_in, r_in_secp, r_in_BN254,          │
                   │                    │  r_out_secp, r_out_BN254) encrypted to       │
                   │ envelope assembled │  settler pubkey                              │
                   │ from openings;     │                                              │
                   │ RTT 2: traders     │  computes envelope_hash; assembles PSBT      │
                   │ auto-sign PSBT     │  with vout[0] = OP_RETURN(envelope_hash);    │
                   ▼                    │  RTT 2: traders return SIGHASH_ALL sigs      │
┌─────────────────────────────────────┐ │  generates one Groth16 batch proof asserting:│
│ ONE BITCOIN TRANSACTION             │ │    • each per-intent BN254 commit opens to   │
│                                     │ │      its claimed amount_in                   │
│  vin[0] : settler envelope input    │ │    • each receipt's amount_out_i derived     │
│  vin[1+i]: trader inputs (sorted    │ │      from amount_in_i and P_clear            │
│            by intent_id ascending)  │ │    • per-receipt BN254 binding (Poseidon)    │
│                                     │ │    • per-receipt cross-curve binding         │
│  vout[0]: OP_RETURN(envelope_hash)  │ │      (each C_out_secp opens to the same      │
│  vout[1+i]: trader receipt outputs  │ │       amount_out as the BN254 commitment)    │
│             (dust to receive script)│ │    • each amount_out_i ≥ min_out_i           │
│  vout[N+1]: aggregated settler tip  │ │    • range proofs on every amount, in/out    │
│  vout[N+2..]: optional BTC change   │ └─────────────────────┬────────────────────────┘
│                                     │                       │
│  envelope: T_SWAP_BATCH payload     │                       ▼
│   - per-receipt C_out_secp + C_out_ │ ┌────────────────────────────────────────────┐
│     BN254 (one pair per trader)     │ │  INDEXER                                   │
│   - public Δa_net, Δb_net           │ │                                            │
│   - per-asset R_net (aggregate r)   │ │  • verify each per-intent intent_sig +     │
│   - per-intent trader_pubkey +      │ │    cross-curve proof (out-of-circuit)      │
│     C_in_amount_BN254               │ │                                            │
│   - one Groth16 batch proof         │ │                                            │
└─────────────────────────────────────┘ │    cross-curve proof (out-of-circuit)      │
                                        │  • re-verify vout[0] OP_RETURN data ==     │
                                        │    sha256(envelope_payload)                │
                                        │  • re-run deterministic clearing solve;    │
                                        │    reject if declared deltas don't match   │
                                        │  • re-verify batch Groth16 against pool.vk │
                                        │  • check chain-side aggregate Pedersen     │
                                        │    on secp256k1 (one equation per asset,   │
                                        │    inputs and receipts both included)      │
                                        │  • for A→B-dominant: R_A += Δa_in_net;     │
                                        │    R_B -= Δb_out_net (B→A symmetric)       │
                                        │  • credit each receipt UTXO as spendable   │
                                        └────────────────────────────────────────────┘
```

There is no pool UTXO to spend or recreate. The Bitcoin tx is
strictly trader-input → trader-receipt + settler-tip. Pool reserves
move as a public bookkeeping update inside the indexer's
reconstruction. The constant-product invariant is checked by the
indexer as plain arithmetic against public reserves and net deltas.
The Groth16 proof's job is narrower: bind hidden per-trader amounts
to public batch deltas, enforce uniform pricing, satisfy `min_out`,
and prove range bounds.

`T_LP_ADD` and `T_LP_REMOVE` follow the same pattern but for one LP
per envelope (LP operations don't naturally batch — they're
at-the-ratio, not at-a-price).

### Pool state

A pool is uniquely identified by an unordered pair `(asset_A,
asset_B)`. Convention: `asset_A` is the lexicographically smaller of
the two `asset_id` byte strings. The canonical `pool_id =
SHA256("tacit-amm-pool-v1" || asset_A || asset_B)`. Pool init pins
the Groth16 verifying key and fee basis points; the LP-share
asset's `lp_asset_id` is **deterministically derived** as
`lp_asset_id = SHA256("tacit-amm-lp-v1" || pool_id)`. This is a
new asset-identity rule: where SPEC §5.1 / §5.8 derive `asset_id`
from a `CETCH` or `T_PETCH` reveal txid, the AMM adds a third
valid origin — a deterministic derivation from a confirmed
`POOL_INIT`. Indexers treat the first canonical
`T_LP_ADD(variant=1)` (= `POOL_INIT`) for a pair as the genesis of
that pool's `lp_asset_id`; subsequent `T_LP_ADD(variant=0)` and
`T_LP_REMOVE` envelopes mint/burn against the same `lp_asset_id`.
No `CETCH` is required for LP shares.

| Field | Type | Visibility |
|---|---|---|
| `pool_id` | 32 B | public |
| `asset_A`, `asset_B` | 32 B each | public |
| `lp_asset_id` | 32 B | public |
| `vk_cid` | UTF-8 IPFS CID | public |
| `fee_bps` | u16 | public |
| `reserve_A`, `reserve_B` | u64 | public |
| `lp_total_shares` | u64 | public |
| `last_update_height` | u32 | public |

Public reserves and supply are how the protocol stays purely
indexer-validated — anyone can reconstruct exactly what every
reserve is at every height by replaying confirmed envelopes.
**Per-trader amounts** within a batch are hidden via Pedersen;
**per-LP holdings** are hidden via the confidentiality of
`lp_asset_id` UTXOs (CXFER-style). LPs who want anonymous positions
deposit their LP-share UTXO into the mixer's `(lp_asset_id,
denomination)` pool and withdraw to a fresh address.

### One canonical pool per pair

Multiple competing pools for the same `(asset_A, asset_B)` would
fragment liquidity. The indexer enforces **one canonical pool per
pair** by the same first-mover rule as ticker disambiguation in
CETCH (§4): the first canonically-ordered confirmed `POOL_INIT` for
a pair becomes canonical; subsequent inits for the same pair are
silently ignored. A given asset can participate in multiple pools
(one per counterparty asset).

### Optional launcher gate

Asset issuers may declare an `amm_launcher_pubkey` field in their
CETCH / T_PETCH metadata (see `SPEC.md` §5.1 / §5.8). If both
assets in a pair declare a launcher, `POOL_INIT` for that pair is
rejected unless co-signed by both launcher pubkeys. If neither
declares one, the first-canonical-wins rule above applies. The
field is a per-asset opt-in mitigation against `POOL_INIT`
front-running: issuers who care about controlled launches set the
field, assets that prefer fair-launch dynamics leave it unset.
Backward-compatible — existing asset etches without the field
default to first-mover.

The field is **load-bearing** when set: a lost privkey
permanently prevents pool initialization for any pair involving
that asset under the gate. Issuers SHOULD use a multisig or
backed-up key if they set the field at all.

## The three opcodes

Wire formats are normative in `SPEC.md §5.12–§5.14`. Summary:

**`T_LP_ADD` (`0x2B`)** — Adds liquidity at the current pool ratio.
Per-op amounts `(Δa, Δb, share_amount)` are **public** — LP_ADD is
a public deposit action, like depositing into Aave/Uniswap V2. The
LP consumes input UTXOs of asset A and asset B; the envelope
authenticates this consumption with **mixer-style kernel
signatures** (the same shape as `T_DEPOSIT` per SPEC §5.10), one
per asset:

- For asset A: the LP signs BIP-340 over the canonical kernel
  message under the secp256k1 key
  `(Σᵢ C_in_secp,A,i − Δa · H).x_only()`. This proves they know
  `Σᵢ r_in_secp,A,i` AND that the consumed inputs net to exactly
  `Δa · H` of asset value, without the indexer needing to see
  individual blindings.
- For asset B: symmetric, under
  `(Σᵢ C_in_secp,B,i − Δb · H).x_only()`.

Mints `share_amount` of `lp_asset_id` to the depositor as a
fresh tacit UTXO (Pedersen commitment to `share_amount` with
deterministic blinding derived from depositor privkey + pool_id +
the LP's canonical asset-A input outpoint + `lp_asset_id`; see
Receipt recovery below). The Groth16 proof asserts:
- at-the-ratio: `Δa / Δb == R_A / R_B` (with floor-rounding),
- share formula: `share_amount = floor(min(Δa·S/R_A, Δb·S/R_B))`,
- correct opening of the new LP-share commitment under both
  curves (per-receipt cross-curve binding, same gadget as the
  swap path).

Generic CXFER kernel sigs are not used here — the mixer-style
construction is more appropriate because each input must net to a
public amount (the published `Δa` / `Δb`), exactly the assertion
`T_DEPOSIT` already makes.

**`T_LP_REMOVE` (`0x2C`)** — Burns `share_amount` of `lp_asset_id`
and withdraws proportional reserves of both assets. The LP
consumes one (or more aggregated) `lp_asset_id` UTXO(s) via a
mixer-style kernel sig under
`(Σᵢ C_in_secp,LP,i − share_amount · H).x_only()`, proving the
public `share_amount` was burned. The pool credits two fresh
receipt UTXOs to the LP — one of asset A with public `Δa = floor(R_A
· share_amount / S)` and one of asset B with public `Δb = floor(R_B
· share_amount / S)`, both using deterministic blinding derived
from the LP's privkey + pool_id + the consumed lp-share input
outpoint + per-leg asset_id (see Receipt recovery below). The
Groth16 proof asserts proportional withdrawal and correct
receipt-commitment openings under both curves (per-receipt
cross-curve binding).

**`T_SWAP_BATCH` (`0x2D`)** — Settles N swap intents at one uniform
clearing price in a single Bitcoin tx. Per-trader amounts are
confidential; net batch deltas `(Δa_net, Δb_net)` are public. See
"Cross-asset authorization for swaps" and "Uniform clearing" below
for the authorization mechanism and settlement flow.

### POOL_INIT (sentinel variant of `T_LP_ADD`)

Pool creation reuses opcode `0x2B` with a `variant = 1` sentinel —
the same pattern the mixer uses for `POOL_INIT` (§5.10.1). The init
payload pins `(asset_A, asset_B, fee_bps, vk_cid, ceremony_cid,
min_liquidity, inclusion_arbiter_pubkeys[])` and seeds initial
reserves. Initial **total shares** = `isqrt(Δa · Δb)` (Uniswap V2
convention); the founder receives `isqrt(Δa · Δb) −
MINIMUM_LIQUIDITY` of those shares, and the remaining
`MINIMUM_LIQUIDITY` (V2: 1000 base units) is locked at init via a
NUMS-derived P2WPKH recipient (no recoverable privkey,
Bitcoin-unspendable forever). The optional
`inclusion_arbiter_pubkeys` field gates mandatory-inclusion
enforcement (see Indexer determinism). First canonically-ordered
confirmed init wins, subject to any `amm_launcher_pubkey` gate
declared by the assets; **no other privilege governs pool
initialization**.

### Cross-asset authorization for swaps

Standard CXFER kernel sigs are single-asset and require *public*
input/output amounts to construct the verifier's expected signing
key. `T_SWAP_BATCH` consumes one asset and emits another with
*hidden* per-trader amounts, so the CXFER mechanism doesn't fit.
Two concerns have to be addressed: per-trader intent authentication,
and consistency between Bitcoin's secp256k1 Pedersen commitments
and the BN254-Fr Groth16 circuit that enforces batch constraints.

**Hybrid commitments (secp256k1 + BN254).** Tacit asset UTXOs use
secp256k1 Pedersen commitments — load-bearing for Bitcoin
compatibility. Groth16 circuits operate efficiently over BN254-Fr.
The AMM bridges the two per-trader, at intent-post time:

- `C_in_secp` is the on-chain Pedersen commitment carried by the
  trader's input UTXO(s) on secp256k1. When an intent draws on
  multiple input UTXOs of the same asset, `C_in_secp` is the
  homomorphic sum `Σᵢ C_in_secp,i` and `r_secp` is `Σᵢ r_secp,i` —
  the trader signs the cross-curve proof under the aggregate.
- The intent publishes `C_amount_BN254 = Poseidon(amount, r_BN254)`
  — BN254-native, cheap inside Groth16.
- The intent includes a one-shot **cross-curve binding proof**: a
  small Groth16 attestation that the trader knows openings to both
  commitments with the same `amount`. The secp256k1 side uses
  non-native arithmetic inside BN254 — published designs of
  comparable shape land in the **~100K–400K constraint range**
  (rough browser proving time ~10–30s); precise numbers depend on
  the chosen circuit and need empirical benchmarking before the
  spec is fixed. Cost is paid **once per intent by the trader**,
  not per batch by the settler. The verifying key for this circuit
  is **protocol-wide** (single `cross_curve_vk_cid` pinned in
  `SPEC.md`, not per-pool) — every trader uses the same vk.

**Intent authentication is out-of-circuit.** Each intent's
`intent_sig` (BIP-340 over the canonical `intent_msg`) is verified
by the indexer at envelope ingest, not in-circuit. BIP-340
verification is microseconds in native code; in-circuit it would
cost ~2M constraints per sig. This matches the mixer's posture of
keeping expensive secp256k1 checks outside the circuit.

**Batch proof: per-intent BN254 work + per-receipt cross-curve
binding.** The settler's single Groth16 batch proof asserts:

- **Opening of each per-intent input commitment.** Knowledge of
  `(amount_in_i, r_in_BN254_i)` such that
  `Poseidon(amount_in_i, r_in_BN254_i) = C_in_amount_BN254_i`. The
  circuit recomputes each Poseidon hash against the witness;
  per-direction `Σᵢ amount_in_i` is computed in-circuit over the
  cleartext amounts and exposed as a public input. (Poseidon is
  not additively homomorphic — the sum is over re-opened
  cleartext, not over commitments. Pedersen on secp256k1 is what
  carries homomorphic structure for the chain-side aggregate
  check below.)
- **Direction-aware receipt amounts at the deterministic clearing
  ratio.** For each trader `i` the circuit derives:
  - `amount_out_i = amount_in_i · |Δb_net| / |Δa_net|` for an A→B
    trader (input A, receipt B)
  - `amount_out_i = amount_in_i · |Δa_net| / |Δb_net|` for a B→A
    trader (input B, receipt A)
  Both sides of every division are public inputs; the circuit
  enforces floor-rounding toward zero (favoring the pool).
- **Per-receipt BN254 binding.** Each receipt commitment
  `C_out_BN254_i = Poseidon(amount_out_i, r_out_BN254_i)` is opened
  in-circuit against the derived `amount_out_i` and the trader's
  deterministic `r_out_BN254_i` (see "Receipt recovery" below).
- **Per-receipt cross-curve binding.** This is the load-bearing
  fix for output-side soundness. For each receipt `i`, the circuit
  proves — via the same non-native-secp gadget the trader uses for
  input cross-curve binding — that the on-chain
  `C_out_secp_i = amount_out_i · H + r_out_secp_i · G` opens to the
  same `amount_out_i` as the BN254 commitment. Without this,
  the chain-side aggregate Pedersen equation could balance under a
  malicious settler who assigned the wrong secp commitment to a
  specific trader's receipt (totals match, individual receipt is
  unrecoverable). Cost: each receipt binding is the same shape as
  the trader's per-intent input cross-curve gadget — roughly
  100K–400K constraints per receipt — so the settler-side proof is
  N times that for a batch of size N. v1 caps `N ≤ 16` to keep
  browser proving under ~2 minutes; production deployments running
  on a beefier prover machine can lift this.
- Each `amount_out_i ≥ min_out_i`.
- Range proofs on every per-trader amount, in and out.

The cross-curve gadget is the dominant cost; the Poseidon openings
and range proofs are mixer-tier (~3K constraints per intent in
BN254 land).

**Chain-side aggregate Pedersen check.** The on-chain envelope
carries `R_net_A` and `R_net_B` — the per-asset net sums of
trader blindings revealed by the settler (input-side blindings
minus receipt-side blindings, on each asset). For each asset
`X ∈ {A, B}` the indexer verifies, directly on secp256k1:

```
  Σᵢ C_in_secp,X,i  −  Σⱼ C_out_secp,X,j  −  Δx_net · H  =  R_net_X · G
```

where the input sum ranges over the batch's trader inputs of
asset X and the receipt sum over the batch's receipts of asset X.
Two equations total (one per asset).

Aggregate-blinding leakage scales inversely with batch diversity:
at N=1 the aggregate IS the individual blinding (and the trader's
amount is recoverable); at N=2 a colluding settler-trader who
knows their own blinding recovers the other trader's exactly; at
N≥3 with no collusion the aggregate reveals only the sum of N
unknown blindings. The dapp warns when an intent is likely to
settle in a low-diversity batch.

**Per-`vin` Bitcoin-layer signature: SIGHASH_ALL bound to
`envelope_hash`.** Each trader's tacit input needs a Bitcoin-
consensus signature, but batch composition, clearing price,
receipt commitments, and the envelope payload are all settler-
determined *after* the trader posts the intent. A naive pre-signed
`SIGHASH_SINGLE | ANYONECANPAY` (the discipline tacit's atomic-
listing flow uses, `dapp/tacit.js` `SIGHASH_SINGLE_ACP`) is
**unsafe here**: BIP-143 sighash never commits to witness data, so
the envelope at `vin[0].witness` lives entirely outside the trader's
sighash domain. A malicious settler holding a pre-signed
`SIGHASH_SINGLE | ANYONECANPAY` could consume the trader's tacit
UTXO into any tx whose `vout[k]` matches the trader's declared
receive script + dust value — including a tx whose envelope is
garbage, which the indexer rejects. Bitcoin accepts the spend; the
indexer credits no receipt; the trader's tacit value is destroyed.
This is the burn-grief vector. The atomic-listing pattern is safe
only because there the maker fixes the entire tacit output
commitment *before* signing; the AMM batch case inverts that
ordering, so the listing pattern cannot be reused unchanged.

v1 closes the burn-grief vector by binding every trader signature
to the envelope content via two normative rules:

1. **Mandatory `vout[0]` = `OP_RETURN(envelope_hash)`.** Every
   `T_SWAP_BATCH` Bitcoin tx MUST have `vout[0]` as a 0-sat
   `OP_RETURN` whose 32-byte data is `sha256(envelope_payload)` —
   the SHA-256 of the entire `T_SWAP_BATCH` payload at
   `vin[0].witness`, starting from the opcode byte. Indexers
   reject any `T_SWAP_BATCH` tx whose `vout[0]` data does not
   equal the actual envelope hash. The OP_RETURN moves a 32-byte
   commitment from the unsigned witness domain into the signed
   output domain.
2. **Trader signs `SIGHASH_ALL` (P2WPKH) or `SIGHASH_DEFAULT`
   (P2TR key-path).** The trader's signature commits to every
   output's `(scriptPubKey, value)` — including `vout[0]`'s
   OP_RETURN data. Any envelope swap by the settler changes
   `envelope_hash`, changes `vout[0]`, and invalidates **every**
   trader signature in the batch. The malicious-broadcast attack
   becomes structurally impossible: either the broadcast tx
   contains exactly the envelope all traders signed against, or
   it does not satisfy Bitcoin consensus.

Because `SIGHASH_ALL` commits to the full output set (including
`vout[0]`'s `envelope_hash`), the trader must sign **after** the
settler has assembled the envelope. The envelope contains
`C_out_secp_i` for each receipt, which depends on `r_out_secp_i`
from the trader's opening blob. So the protocol is **two round
trips** between settler and trader (both via the worker websocket):

- **Intent post.** The trader posts an intent (commitments,
  pubkey, `min_out`, `tip`, `expiry`, `intent_sig`, cross-curve
  binding proof, receive script, `input_utxos` references) to a
  worker; the trader's dapp opens a websocket to that worker and
  keeps it open through `expiry`.
- **RTT 1 — opening collection.** A claiming settler picks a
  candidate subset and forwards `(included_intent_ids,
  settler_pubkey, vin[0].outpoint, trader's vout_index)` to each
  included trader's dapp via the worker. Each dapp derives
  `r_out_secp` and `r_out_BN254` from the deterministic
  Receipt-recovery formula and returns the encrypted opening
  blob (5 fields, see below).
- **Settler computes.** The settler decrypts openings, runs the
  deterministic clearing solve, derives `amount_out_i` for each
  trader, and computes `C_out_secp_i = amount_out_i · H +
  r_out_secp_i · G`. It assembles the envelope payload and
  computes `envelope_hash`. If any trader's `amount_out_i`
  failed `min_out_i`, the settler drops them and re-iterates
  (which may require re-soliciting openings if the subset
  changed).
- **RTT 2 — sig collection.** The settler forwards the assembled
  PSBT (including `vout[0] = OP_RETURN(envelope_hash)`) to each
  included trader's dapp. Each dapp validates locally: `min_out`,
  `tip`, `expiry`, receipt `scriptPubKey`, derived `amount_out_i`
  against the public deltas, and `envelope_hash` matching the
  assembled payload. On pass, it auto-signs `SIGHASH_ALL` over
  its trader's input — no confirmation prompt — and returns the
  sig.
- **Settler broadcasts.** With all sigs collected, the settler
  generates the Groth16 batch proof using the openings as
  witness, splices it into the envelope, and broadcasts.

The trader's wallet must be online during both RTTs (a few
seconds end-to-end), not for the entire intent lifetime.
Closing the dapp tab simply stops auto-signing; pending intents
that don't get a sig in time are excluded from the next batch and
remain in the open pool until the trader reconnects or `expiry`
lapses. Composition changes (intent added/dropped, rank shifts)
require all included traders to re-sign, since `envelope_hash`
shifts; the worker websocket pushes a fresh PSBT and the dapp
auto-re-signs without prompt.

**Trader-mediated opening release.** The full opening blob the
settler needs is

```
(amount_in,
 r_in_secp,    -- trader's existing input UTXO blinding
 r_in_BN254,   -- trader-chosen blinding for C_in_amount_BN254
 r_out_secp,   -- deterministic per-receipt secp blinding (see Receipt recovery)
 r_out_BN254)  -- deterministic per-receipt BN254 blinding (see Receipt recovery)
```

— enough material for the settler to compute `C_out_secp` and
`C_out_BN254` for the trader's receipt, populate the per-asset
aggregate `R_net` in the envelope, and supply the witness inputs
to both the per-intent and per-receipt cross-curve gadgets in the
batch proof. This blob is **not** held by the worker. The trader's
dapp transmits it directly to the claiming settler — encrypted to
the settler's published pubkey — during RTT 1 of the interactive
flow above (before the envelope can be assembled). The worker is
a **message relay**, not a custodian of pre-signed sigs or
openings; it forwards the encrypted blob from trader to settler
without being able to decrypt it. A settler that never receives
opening + sig cannot construct a Bitcoin-valid tx (no trader
sig) and cannot construct a valid batch proof (no openings); a
settler that does receive both can broadcast only the exact tx
the trader signed against, since the trader's sig binds the
envelope via `vout[0]`. Burn-grief is impossible at both layers.

There is no separate tacit kernel sig per `vin` of a trader's
input. Tacit-layer consumption is jointly authorized by
`intent_sig` (out-of-circuit, BIP-340), the cross-curve binding
proof (per intent, trader-paid), the batch proof (BN254,
settler-paid, with per-receipt binding), and the aggregate
Pedersen check (secp256k1, indexer-checked). Bitcoin-layer
consumption is the `SIGHASH_ALL` signature above, bound to
`envelope_hash` via `vout[0]` `OP_RETURN`.

A future BIP-119/OP_CTV adoption would let traders pre-commit to a
covenant template and remove the interactive-signing requirement,
preserving burn-grief immunity for fully-async UX. v1 accepts the
online-window cost as the price of working on today's Bitcoin.

**Trader binding to clearing price.** The trader's `intent_sig`
commits `min_out`. Because `P_clear` is itself fully determined by
the deterministic clearing solve over the included subset, the
settler has no pricing freedom to abuse — only subset-selection
freedom (further constrained by mandatory-inclusion for pools
that pin an arbiter). The in-circuit `amount_out_i ≥ min_out_i`
check is the trader's per-intent veto: any subset whose solve
produces a `P_clear` that fails the trader's `min_out` drops the
intent and re-solves. No delegated clearing-price-signing needed.

## Uniform clearing

Each Bitcoin block, a settler — any participant — selects a subset
of queued swap intents, computes one clearing price for the whole
batch, and settles them in a single transaction.

**Intent collection.** Traders post signed swap intents to a
worker — direction, dual commitments to the input amount
(`C_in_secp` from the trader's existing input UTXO plus a fresh
BN254-friendly `C_in_amount_BN254`), a one-shot cross-curve
binding proof for the input, `min_out`, `tip`, `input_utxos`
references, receive script, `expiry`, and a per-intent
`intent_sig` under `trader_pubkey`. The full opening blob
`(amount_in, r_in_secp, r_in_BN254, r_out_secp, r_out_BN254)` —
spec'd in "Trader-mediated opening release" under Cross-asset
authorization for swaps — is **held by the trader's dapp** and
transmitted directly to the claiming settler, encrypted to the
settler's published pubkey, at the same moment the dapp returns
its `SIGHASH_ALL` signature against the assembled candidate
batch. The worker is a message relay between trader dapps and
settlers; it cannot decrypt openings or pre-stage signatures.
Chain observers see only commitments and aggregate batch deltas
— never the cleartext per-trader amount.

**Whole-UTXO consumption only.** If a trader's available UTXO is
larger than their intended `amount_in`, they pre-split via `CXFER`
(§5.2) before posting the intent. v1 does not support partial-UTXO
draws inside a swap batch; the additional split is one extra
Bitcoin tx of trader latency.

**Settlement.** Settlement is a **two-round-trip** flow because
the settler cannot run the deterministic clearing solve without
per-trader cleartext amounts (which live in opening blobs), and
the trader cannot sign `SIGHASH_ALL` without the assembled
envelope (which depends on the solve's output). The protocol is:

1. Settler picks a candidate subset from the open intent pool
   using only public intent metadata (direction, pubkey,
   `min_out`, `tip`, `expiry`, `input_utxos`, receive script —
   never the cleartext amount, which is hidden by Pedersen +
   Poseidon). Subset must include all qualifying intents if the
   pool pins an arbiter.

2. **RTT 1 — opening collection.** Settler sends each included
   trader (via the worker websocket) the candidate composition
   `(included_intent_ids, settler_pubkey, vin[0].outpoint,
   trader's vout_index)`. Each trader's dapp validates the
   composition is sane, derives `r_out_secp` and `r_out_BN254`
   from the deterministic Receipt-recovery formula against
   `recipient_anchor_outpoint = trader_input_outpoint`, and
   returns the full opening blob `(amount_in, r_in_secp,
   r_in_BN254, r_out_secp, r_out_BN254)` encrypted to
   `settler_pubkey`.

3. Settler decrypts openings, computes per-direction gross flows,
   runs the deterministic clearing solve, derives `P_clear` and
   `amount_out_i` for each trader. If any `amount_out_i <
   min_out_i`, drops that intent and re-solves (which may push
   other intents below their `min_out` — iterate until stable, or
   until the subset cannot satisfy mandatory-inclusion, in which
   case abort and try a different subset).

4. Settler computes each receipt's `C_out_secp_i = amount_out_i ·
   H + r_out_secp_i · G` (using the trader's revealed
   `r_out_secp_i`), assembles the `T_SWAP_BATCH` envelope payload
   (per-receipt commitments, public deltas, per-asset `R_net`,
   reserved space for the batch proof), and computes
   `envelope_hash = sha256(envelope_payload)`.

5. Settler builds the candidate Bitcoin tx with the normative
   layout (see Indexer determinism): `vin[0]` envelope-bearing
   settler input; `vin[1+i]` trader inputs in `intent_id`
   ascending byte-order; `vout[0] = OP_RETURN(envelope_hash)`;
   `vout[1+i]` trader receipt outputs at matching indices;
   `vout[N+1]` aggregated settler tip; optional `vout[N+2]`
   settler BTC change.

6. **RTT 2 — sig collection.** Settler forwards the assembled
   PSBT to each included trader's dapp via the worker websocket.
   Each dapp validates locally: (a) `min_out`, `tip`, `expiry`,
   receipt `scriptPubKey` match its trader's intent; (b) derived
   `amount_out_i` from public deltas matches; (c) `vout[0]` data
   equals `sha256(envelope_payload)` against the assembled
   payload; (d) the trader's input is at the expected `vin`
   index. On pass, it auto-signs `SIGHASH_ALL` over its trader's
   input — no confirmation prompt — and returns the sig.

7. On full sig set, settler generates the Groth16 batch proof
   using the collected openings as witness, splices the proof
   into the envelope, and broadcasts.

The two RTTs both ride the worker websocket and complete in a
few seconds end-to-end under normal conditions. Total per-batch
latency from settler claim to broadcast is bounded by the slowest
trader's response in either RTT plus the settler's batch-proof
generation time (capped under ~2 minutes for `N ≤ 16`).

**Fairness within a batch.** Every trader pays/receives the same
`P_clear`. There is no in-batch ordering, no sandwich, no
priority-fee MEV. The settler's only freedom is which subset to
include; their incentive maximizes by including everyone whose
`min_out` is satisfiable, since excluded intents leave tip revenue
on the table.

**Cross-batch ordering.** Bitcoin consensus admits one batch tx
per pool per block as the typical case (each batch consumes the
same trader UTXOs once, and traders won't sign two competing
batches against the same input). If multiple batches against the
same pool nonetheless confirm in the same block (settlers racing
with disjoint intent sets), the indexer applies them in
`(tx_index, vin[0] outpoint)` order and re-runs the deterministic
clearing solve for each subsequent batch against the post-earlier
reserves; any later batch whose declared `(Δa_net, Δb_net)` does
not match its solve at the post-earlier reserves is rejected.
Settlers SHOULD coordinate off-chain on a one-batch-per-pool-per-
block convention to avoid wasted proof work.

**Settler economics.** Each intent specifies a `tip` value and
`tip_asset` (either of the pool's two assets). The settler
aggregates tips into one tip output and pays the Bitcoin tx fee
from their own BTC inputs, recouping via the tip mechanism.
Permissionless — any tacit user with a chain view + intent-pool
read can become a settler.

**Deterministic clearing solve.** v1 specifies an **exact-output**
clearing rule, not an inequality with slack. Given the included
intent set's signed gross flows on each side, the settler computes
the net asset-A flow from intents `Δa_gross_in` (sum of A→B inputs)
and `Δa_gross_out` (sum of B→A receipts in asset A), and likewise
for B. The CFMM solve is direction-aware with
`γ = (10000 − fee_bps) / 10000`:

- **A→B-dominant batch** (`Δa_gross_in > Δa_gross_out`):
  let `Δa_in_net = Δa_gross_in − Δa_gross_out` (positive, the
  residual that hits the curve). Then
  `Δb_out_net = floor( R_B · γ · Δa_in_net / (R_A + γ · Δa_in_net) )`
  with the multiplication carried in u128 to avoid overflow. The
  pool's new reserves are `R_A' = R_A + Δa_in_net`,
  `R_B' = R_B − Δb_out_net`. The clearing ratio for trader receipt
  derivation is `P_clear = Δa_in_net / Δb_out_net`.
- **B→A-dominant batch** (`Δb_gross_in > Δb_gross_out`):
  symmetric — let `Δb_in_net = Δb_gross_in − Δb_gross_out`,
  `Δa_out_net = floor( R_A · γ · Δb_in_net / (R_B + γ · Δb_in_net) )`,
  `P_clear = Δa_out_net / Δb_in_net`.
- **Zero-net batch** (`Δa_gross_in == Δa_gross_out` AND
  `Δb_gross_in == Δb_gross_out`): the included intents perfectly
  cancel; reserves are unchanged. `P_clear` is set to the pool's
  current spot ratio `R_A / R_B` (with deterministic
  floor-rounding) so trader receipts are still well-defined. No
  fee is charged in the zero-net case.
- **Degenerate-empty batch** (`N = 0`): `T_SWAP_BATCH` envelopes
  with zero included intents are forbidden — indexers reject.

The result `Δb_out_net` (or `Δa_out_net`) is **the** answer the
indexer expects; envelopes whose declared `(Δa_net, Δb_net)` differ
from this exact value by even one base unit are rejected. There is
no settler freedom in pricing — only in subset selection. Settlers
do all the math off-chain and the indexer re-derives the same
result byte-identically; any disagreement rejects the envelope.

Fee `γ` applies only to the **net-inflowing side**: the offsetting
portion of intents that cancel within a batch pays no fee; only
the residual that actually hits the curve does. This is the
Penumbra-style net-flow fee policy. A v2 variant could charge fees
on gross flow (Uniswap V2 style) — that would extract more from
two-sided batches but requires a per-direction gross-flow field in
the envelope. v1 chose net-flow for envelope simplicity; the
trade-off is documented for LPs.

**No "slack accrues to LPs."** Earlier drafts allowed settlers to
submit inequalities and called the slack a fee bonus to LPs; that
let a settler-LP extract value from traders by deliberately
mispricing toward themselves. v1 forbids slack: the deterministic
solve above pins exactly one valid answer per included subset.

**Per-trader pro-rata fills.** Each included trader's
`amount_out_i` is derived in-circuit from `amount_in_i` and
`P_clear` exactly as specified in "Batch proof: per-intent BN254
work + per-receipt cross-curve binding" above; floor-rounding
favors the pool (truncated dust accrues as fee revenue to LPs, the
only intentional source of slack and bounded above by `N` base
units per batch).

## Indexer determinism rules

Every indexer must follow these byte-identically to arrive at the
same pool state from the same chain history (mirrors the mixer's
§11-style determinism contract).

**Rounding.** All AMM arithmetic operates on u64 base units; all
divisions floor toward the pool, so rounding errors accrue as fees
to existing LPs:

- LP_ADD: `share_amount = floor(min(Δa·S/R_A, Δb·S/R_B))`.
- POOL_INIT: total shares at init = `isqrt(Δa·Δb)` (deterministic
  integer square root); founder allocation =
  `isqrt(Δa·Δb) − MINIMUM_LIQUIDITY`, with `MINIMUM_LIQUIDITY`
  minted to the NUMS-locked output.
- LP_REMOVE: `Δa = floor(R_A · share_amount / S)`,
  `Δb = floor(R_B · share_amount / S)`.
- T_SWAP_BATCH net-output: per "Deterministic clearing solve"
  above — γ-scaling carried in u128, floor toward zero (favoring
  the pool); indexer recomputes byte-identically and rejects any
  declared `(Δa_net, Δb_net)` that disagrees.

**Envelope-hash binding (`T_SWAP_BATCH` only).** Every
`T_SWAP_BATCH` Bitcoin tx MUST include `vout[0]` as a 0-sat
`OP_RETURN` whose 32-byte data is `sha256(envelope_payload)` —
the SHA-256 of the entire `T_SWAP_BATCH` payload at
`vin[0].witness`, starting from the opcode byte. Indexers reject
any `T_SWAP_BATCH` whose `vout[0]` data does not equal the actual
envelope hash. This rule is what makes trader `SIGHASH_ALL`
signatures bind to the envelope content; see "Per-`vin`
Bitcoin-layer signature" under Cross-asset authorization for
swaps for the full reasoning. `T_LP_ADD` and `T_LP_REMOVE`
envelopes do NOT require this OP_RETURN — they are single-party
ops where the LP signs their own envelope and no third-party
substitution is possible.

**T_SWAP_BATCH transaction layout.** The Bitcoin tx structure is
fully normative (indexers reject deviations):

| Index | Role |
|---|---|
| `vin[0]` | Settler's envelope-bearing input (Taproot script-path); witness carries the `T_SWAP_BATCH` payload. |
| `vin[1+i]` | Trader inputs in `intent_id` ascending byte-order, `i ∈ [0, N)`. |
| `vin[N+1..]` | Optional settler BTC funding inputs (used to pay tx fee + dust). |
| `vout[0]` | `OP_RETURN(envelope_hash)`, 0 sat, 32-byte data. |
| `vout[1+i]` | Trader receipt outputs at matching indices; each is a dust-value (e.g., 546 sat) output to the trader's pre-declared receive script. |
| `vout[N+1]` | Aggregated settler tip — a tacit UTXO of `tip_asset`, dust-value at Bitcoin layer with the tip Pedersen commitment in the envelope payload. |
| `vout[N+2..]` | Optional settler BTC change. |

**UTXO-race during batch construction.** Between batch construction
and Bitcoin broadcast, a trader could spend one of their referenced
`input_utxos` elsewhere. Bitcoin would reject the swap-batch tx
(unknown input), failing the entire batch and wasting the settler's
proof work. Mitigations are operational: settlers pre-check UTXO
availability immediately before broadcast; workers reject
overlapping intents; trader UI warns on locked UTXOs; intent expiry
defaults to ~3 blocks. A future BIP-119 / OP_CTV could close the
race fully via covenant-restricted trader inputs.

**Reorg safety.** Pool state advances at depth ≥ 3 blocks
(`AMM_OP_CONFIRMATION_DEPTH = 3`, mirroring
`MIXER_DEPOSIT_CONFIRMATION_DEPTH`). Reorgs deeper than 3 force the
indexer to roll back to the last common ancestor and replay
forward.

**Canonical ordering.** Within a block, AMM envelopes apply in
`(tx_index, vin[0] outpoint)` order. Within a `T_SWAP_BATCH`
envelope, per-trader inputs (`vin[1+i]`) and outputs (`vout[1+i]`)
MUST appear in `intent_id` ascending byte-order, with the OP_RETURN
at `vout[0]` ahead of all receipts; indexers reject violations.

**Mandatory inclusion of qualifying intents (opt-in mitigation).**
To **mitigate** cross-batch curation MEV (the settler's incentive
to selectively exclude intents that would move price against their
own LP position), pools that pin an inclusion arbiter enforce a
forced-inclusion rule. Pools without an arbiter operate in
best-effort mode and rely on tip-revenue economics alone.

An intent is **qualifying for height H against the pool's
spot-price-derived candidate set** if (a) it has been open in the
worker's intent pool since at least height `H − K` (default
`AMM_MANDATORY_INCLUSION_DEPTH = 2`), (b) its `expiry` has not
lapsed, and (c) its `min_out` is satisfiable against the **spot
clearing price** the pool would produce if the qualifying set
alone were settled (recursively: re-run the deterministic clearing
solve over the qualifying set; check `min_out` for each member
against that solve's `P_clear`). This is a deterministic
fixed-point computation over the qualifying-set seed, not a free
parameter the settler can tune; if it does not converge in 3
iterations the indexer treats the empty set as canonical for that
height.

When validating a `T_SWAP_BATCH` at height H, the indexer fetches
the canonical signed list of qualifying intents for that pool and
rejects the envelope if any qualifying intent was excluded. The
worker exposes a `GET /pools/:pool_id/qualifying-intents/:height`
endpoint returning a height-stamped, BIP-340-signed list.

**Inclusion arbiter pubkey (optional).** The default for `POOL_INIT`
is to pin **no arbiter**. Default pools work fine for trading —
they are fully trustless, fully L1-reconstructible, and rely on
tip economics + arbitrage to keep settlers from chronically
curating (excluded intents leave tip revenue on the table; a
chronically curating settler loses fees to less-curating
competitors; arbitrageurs realign any spot drift). The worst case
is **delayed inclusion + bounded slippage drift**, never value
extraction or burn.

Pools that want a stronger cryptographic guarantee against
cross-batch curation MEV can additionally pin one or more
`inclusion_arbiter_pubkey` values at `POOL_INIT`. Indexers then
accept the qualifying-intents list for that pool only if signed
by at least one of the pinned arbiters, and reject any
`T_SWAP_BATCH` that excludes a qualifying intent. This is an
opt-in upgrade — typically wanted only by very-high-volume pools
where curation profit could become material — and it MUST be a
multisig or independent-operator quorum (`k`-of-`n`); a single
key is fragile and not recommended.

Default pools (no arbiter pinned) are the right v1 starting point
and what the dapp creates by default. Pinning an arbiter is a
deliberate choice the pool founder makes to delegate one specific
MEV defense to a quorum, in exchange for the off-chain data
dependency described next.

**Trade-off vs. L1-only reconstruction.** Mandatory-inclusion
enforcement is the one place this protocol relies on data outside
the Bitcoin chain. An indexer with only confirmed L1 envelopes can
reconstruct every pool's reserves, supply, and per-batch deltas
exactly — but it cannot tell whether a confirmed `T_SWAP_BATCH`
violated mandatory inclusion at its height, because the qualifying
set was a worker-signed off-chain artifact. To enforce the rule, an
indexer must additionally fetch and retain the historical signed
lists (or trust the broadcasting settler). Pools that pin no
`inclusion_arbiter_pubkey` keep strict L1-only reconstruction at
the cost of weaker cross-batch MEV resistance; pools that pin one
gain MEV resistance at the cost of an off-chain data dependency.
This is the structural cost of binding a settler to a "must
include" rule under indexer-validated semantics — without
smart-contract enforcement at L1, no fully-trustless mechanism
exists.

This closes the curation loop for opt-in pools: settlers may pick
which fresh-arrival intents to include from the current block's
pool, but anything ≥ K blocks old MUST be included if
`min_out`-satisfiable. A settler trying to chronically curate
would fail to settle.

**Intent cancellation.** A trader can cancel an intent before
expiry by signing a cancel message under `trader_pubkey` (BIP-340
over `SHA256("tacit-amm-intent-cancel-v1" || pool_id ||
intent_id)`). The worker removes the intent from the open pool and
from the qualifying set on receipt; the cancel propagates into the
next signed list at height H+1.

## Trust model

Soundness (= "is the pool's accounting correct?") is **trustless
under standard cryptographic assumptions**, with the same trust
profile as the mixer:

- Groth16 proofs verify under the published `vk` regardless of who
  runs the verifier.
- Pool state is byte-deterministic from chain.
- Pedersen commitments are publicly checkable; range proofs prevent
  underflow.
- The constant-product invariant is verified by the indexer as
  plain arithmetic on public reserves.

**No party custodies any pool's reserves.** This is the structural
consequence of the virtual-pool architecture: there is no UTXO
holding pool funds, so there is no key that can rug. Reserves are
virtual quantities the indexer attests to, exactly as in the mixer.

The reference worker (and any settler) can DoS users (refuse to
relay, refuse to settle) but cannot cheat them. Traders' `min_out`
defends against settler price manipulation. **Intra-batch MEV
(sandwich, priority-fee ordering) is eliminated** by uniform
clearing. **Cross-batch curation MEV is mitigated** by the opt-in
mandatory-inclusion rule for pools that pin an arbiter; for pools
that do not pin one, curation MEV is bounded only by tip-revenue
economics. Burn-grief — settlers broadcasting Bitcoin-valid but
tacit-invalid txs to destroy trader UTXOs — is structurally
impossible because trader `SIGHASH_ALL` sigs commit to
`envelope_hash` via `vout[0]` `OP_RETURN` (see Cross-asset
authorization for swaps). Liveness depends on at least one working
indexer + one available settler; both are permissionless. Anyone
can run their own indexer + settler from chain data alone.

**Worker is a message relay, not an escrow or privacy
intermediary.** Under v1's interactive PSBT signing, per-trader
opening blobs `(amount_in, r_in_secp, r_in_BN254, r_out_secp,
r_out_BN254)` are encrypted directly by the trader's dapp to the
claiming settler's published pubkey at sign time; the trader's
`SIGHASH_ALL` signature is returned through the worker websocket
but the worker cannot decrypt the opening payload.
The worker is therefore **neither a custody intermediary nor a
privacy intermediary** — it can only DoS (refuse to forward
messages). Pre-signed sigs and openings never sit on the worker.
Trust-conscious traders self-host a worker, use a peer-to-peer
pubsub layer (e.g., Nostr) instead, or run their own settler with
direct trader↔settler messaging. Pools that pin an
`inclusion_arbiter_pubkey` add the arbiter as a separate liveness
+ data-availability dependency for that pool's mandatory-inclusion
enforcement; that role is independent of the worker role and can
be carried by a different operator or a quorum.

## Receipt recovery

Tacit's standard recovery posture (SPEC §6) is that a wallet armed
with the in-page privkey can reconstruct every UTXO it owns from
chain alone — no off-chain secret material required. AMM receipts
must extend this property.

**Deterministic blinding derivation.** Every receipt UTXO emitted
by `T_LP_ADD`, `T_LP_REMOVE`, or `T_SWAP_BATCH` uses blindings
derived from the recipient's privkey + on-chain identifiers known
at intent-post / LP-op-construction time, so a wallet restoring
from privkey alone can re-open the commitment without external
state. The seed must be **anchored on data that is fixed before
the envelope is assembled** — using `batch_txid` would be circular
(the envelope contains `C_out_secp_i` which depends on
`r_out_secp_i` which would depend on the seed which would depend
on the txid which depends on the envelope). The anchor is instead
the recipient's consumed input outpoint, which is known at
intent-post and recoverable from chain.

For each receipt:

- **Swap receipt** (`T_SWAP_BATCH`): the recipient is a trader
  whose tacit input outpoint `trader_input_outpoint` is consumed
  at `vin[1+rank]`. The seed binds to that outpoint.
- **LP-share receipt** (`T_LP_ADD`): the recipient is the LP
  whose canonical asset-A input outpoint
  `lp_inputA_outpoint` is consumed first.
- **LP-withdraw receipts** (`T_LP_REMOVE`): the recipient is the
  LP whose lp-share input outpoint `lp_share_input_outpoint` is
  consumed.

In every case let `recipient_anchor_outpoint` be that 36-byte
outpoint (32-byte txid BE || 4-byte vout LE). Then:

```
seed_secp  = HMAC-SHA256(recipient_privkey,
                          "tacit-amm-receipt-secp-v1"
                          || pool_id
                          || recipient_anchor_outpoint
                          || asset_id)
seed_BN254 = HMAC-SHA256(recipient_privkey,
                          "tacit-amm-receipt-bn254-v1"
                          || pool_id
                          || recipient_anchor_outpoint
                          || asset_id)
r_out_secp_i  = seed_secp  mod n_secp     (n_secp = secp256k1 group order)
r_out_BN254_i = seed_BN254 mod p_BN254_Fr (BN254 scalar field prime)
```

The receipt commitments are then the standard Pedersen / Poseidon:

```
C_out_secp_i  = amount_out_i · H_secp + r_out_secp_i · G_secp
C_out_BN254_i = Poseidon(amount_out_i, r_out_BN254_i)
```

Both blindings are committed to inside the batch / LP-op proof's
per-receipt cross-curve binding; the indexer validates that the
on-chain `C_out_secp_i` opens to the same `amount_out_i` as the
in-circuit BN254 commitment. The settler / LP-op assembler does
not derive these blindings — it receives them from the recipient's
opening blob (encrypted to the settler/assembler's published
pubkey) at the same moment it receives the recipient's
`SIGHASH_ALL` sig.

The asset_id field in the seed is what disambiguates the LP_REMOVE
recipient's two receipts (one of asset A, one of asset B) emitted
against the same `lp_share_input_outpoint` anchor — each has its
own `r_out` because the asset_id differs.

**Recovery algorithm.** A wallet restoring from privkey alone
recovers AMM receipts by:

1. Scanning chain for `T_SWAP_BATCH`, `T_LP_ADD`, and
   `T_LP_REMOVE` envelopes that consume any of the wallet's known
   tacit UTXO outpoints in `vin[1..]`.
2. For each match, identifying the receipt vouts that correspond
   to the wallet (per the canonical layout: a swap trader's
   receipt is at `vout[1 + rank_in_intent_id_sort]`; an LP_ADD
   share is at the share-output position the envelope declares;
   LP_REMOVE legs are at the two declared positions).
3. Reading public envelope data (deltas, reserves at parent
   height for swaps; declared `(Δa, Δb, share_amount)` for LP
   ops) and computing the wallet's `amount_out` from the
   deterministic solve / formulas.
4. Re-deriving `r_out_secp` and `r_out_BN254` from privkey +
   `(pool_id, recipient_anchor_outpoint, asset_id)`.
5. Verifying the computed commitment against the on-chain
   `C_out_secp` carried in the envelope at the corresponding
   `vout` slot. Match → receipt credited; no match → wallet flags
   a recovery anomaly (rare; indicates an indexer disagreement or
   a corrupted wallet state).

This makes AMM receipts first-class recoverable UTXOs, identical
in posture to mixer-withdraw outputs (SPEC §5.11) and CXFER
recipient outputs (SPEC §3.5). No "ghost UTXOs" after restore.

**Posted intents in flight.** A wallet that restores while one of
its intents is still open in a worker pool — or pre-included in a
candidate batch the wallet missed signing — recovers nothing for
that intent (the input UTXO is still spendable; the trader can
re-post or wait for `expiry`). Only confirmed receipts are
recoverable, by design.

## Privacy model

**Hidden** (cryptographic, unconditional under Pedersen + Groth16):

- Each trader's per-intent amount in a batch (only the public batch
  deltas are revealed).
- Each LP's per-UTXO LP-share holding.
- Which LP redeemed at any given `T_LP_REMOVE`, if the LP mixed
  their share UTXO before redeeming.
- Recipient blindings on receipt UTXOs (deterministic from privkey).

**Public** (intentional — the cost of trustless reconstruction):

- Pool reserves `R_A`, `R_B` and total LP supply `S` of every pool.
- Each batch's net deltas `(Δa_net, Δb_net)` and inferable
  clearing price `P_clear`. The sign and magnitude of `Δa_net`
  reveal the batch's aggregate **direction skew** (net buy vs net
  sell pressure on the pool that block) even when individual
  trader amounts are hidden.
- Per-op amounts on `T_LP_ADD` / `T_LP_REMOVE` (each LP op is solo).
- Pool init parameters.
- **Per-trader pubkey** (`trader_pubkey`) for each intent —
  `intent_sig` is verified out-of-circuit, so the pubkey appears
  on chain in `T_SWAP_BATCH` envelopes. Per-trader identity is
  linkable across intents under the same pubkey; only per-trader
  *amounts* are hidden. Traders who want intent-level identity
  privacy SHOULD use a fresh `trader_pubkey` per intent.

This is the **same posture as the mixer**: aggregate state visible,
individual user activity hidden — for the same reason (trustless
reconstruction requires aggregate transparency).

**LP_ADD is a public deposit action.** A depositor's contribution
`(Δa, Δb, share_amount)` is visible on chain — analogous to
depositing into Aave or Uniswap V2. The privacy story for LPs
applies to the *post-deposit holding*, not to the deposit event
itself: the LP-share UTXO that gets minted is per-UTXO confidential
(Pedersen-committed CXFER-style), and can be made anonymous via
mixer composition.

**LP privacy via mixer composition.** After `T_LP_ADD`, the
depositor holds an LP-share UTXO of `lp_asset_id`. To anonymize:
deposit the UTXO into the mixer's `(lp_asset_id, denomination)`
pool, wait for anonymity-set growth, withdraw to a fresh address.
At redemption time, `T_LP_REMOVE` consumes the freshly-minted
LP-share UTXO and observers cannot link back to the original
deposit. Anonymity scales with concurrent LP-share activity in that
pool's `lp_asset_id`; the dapp surfaces a live anonymity-set count,
same UX discipline as the mixer.

**Trader privacy in a batch.** With `n_intents ≥ 2`, no observer
can attribute a specific amount to a specific trader — per-intent
commitments are Pedersen-hiding, and the batch proof reveals only
the aggregate. With `n_intents = 1`, **privacy is zero**: the batch
deltas equal the single trader's amount and direction in the clear,
and the trader_pubkey is on chain. The dapp MUST surface a hard
warning when an intent is likely to settle solo — this is not a
soft caution, it is a complete privacy collapse for that intent.

**Operational privacy** depends on the same three things as the
mixer (§5.11.4): anonymity-set size for LP withdraws, Bitcoin-level
fee linkage on the broadcast tx (use a fresh wallet or a relayer),
and network/timing correlation (Tor + delay).

## What's novel here

The novelty is the **composition**, not any single piece. Each
piece is prior art:

- **Constant-product AMMs:** Uniswap V2 (2020), Bancor (2017).
- **Uniform-clearing batch auctions:** Walras (1874), Gnosis
  Protocol (2019), Penumbra ZSwap (2023).
- **Pedersen on Bitcoin envelopes:** MimbleWimble (2016), RGB,
  tacit's CXFER.
- **Virtual indexer-tracked pools (no UTXO custody):** tacit's
  mixer.
- **Groth16 in indexer-validated meta-protocols:** tacit's mixer.
- **ERC20-style transferable LP shares:** Uniswap V2.
- **Privacy via mixer composition for fungible tokens:** Tornado
  Cash pattern; tacit's mixer for any tacit asset.
- **Routing through a single quote asset:** Tempo's pathUSD model;
  cBTC plays the analogous role for tacit.

The claim — narrower and harder to attack than "novel cryptography"
or "first AMM" — is that **this specific composition on Bitcoin L1**
doesn't have a live production peer:

- Indexer-validated Bitcoin meta-protocols have been **transparent**
  (Runes, BRC-20, Ordinals, STAMPS, Alkanes, OP_NET) and **non-AMM**
  (no protocol-level price discovery; trading is OTC marketplaces
  atop the asset layer).
- AMMs on Bitcoin sidechains (Liquid SideSwap) execute under
  federation trust models, not as L1 meta-protocols.
- AMMs on Bitcoin rollups (Citrea, Botanix) inherit rollup operator-
  set / fraud-proof / BitVM trust assumptions.
- Confidential AMMs (Penumbra ZSwap, Aztec) live on Cosmos / their
  own L1.
- Bitcoin-native trading (Magic Eden runes, Bisq, atomic-swap
  markets) is OTC / RFQ, not pooled-liquidity AMM.
- Uniform-clearing-price batch AMMs (Gnosis, Penumbra) have not
  been adapted to a Bitcoin L1 meta-protocol.

The achievement is the assembly: a uniform-clearing-price
confidential AMM with mixer-composable LP shares, content-addressed
Groth16 governance, permissionless settlers, and **zero in-protocol
custody** — running as a meta-protocol on Bitcoin L1.

### Adjacent designs reviewers will bring up

- **Penumbra ZSwap.** Closest cryptographic + pricing analog —
  same uniform-clearing batch model, same Pedersen-shielded amounts.
  Runs on Cosmos as its own L1, not as a meta-protocol on Bitcoin.
- **Gnosis Protocol / CowSwap.** Uniform-clearing batch auctions on
  Ethereum. Different cryptographic posture (transparent amounts,
  solver competition).
- **SideSwap / Liquid AMMs.** Confidential amounts via Liquid CT,
  but federation trust. Different category.
- **Cardano DEXes (SundaeSwap, Minswap, Spectrum).** Single-pool-
  UTXO + batcher pattern for eUTXO chains. Different VM (Plutus,
  transparent amounts) and different custody model (pool funds *do*
  live in script-locked UTXOs on Cardano — Plutus scripts can
  enforce state transitions; Bitcoin Script cannot).
- **Bitcoin rollup DEXes (Citrea, Botanix, BOB).** Off-chain
  execution with L1 verification or fraud proofs. Different
  category — they inherit the rollup's trust model.
- **RGB AMMs (research-stage).** Client-side validation on Bitcoin,
  conceptually adjacent. No shipped pooled-liquidity AMM at the
  time of writing.

## What's not novel

- Constant-product AMM (Uniswap V2, 2020).
- Uniform-clearing batch auction pricing (academic since Walras;
  Gnosis 2019; Penumbra 2023).
- Pedersen commitments + bulletproofs for confidential amounts
  (2015–2018).
- Virtual indexer-tracked pools on Bitcoin (tacit's own mixer).
- ERC20-style transferable LP shares (Uniswap V2).
- Indexer-validated meta-protocols on Bitcoin (Ordinals 2023, etc.).
- `MINIMUM_LIQUIDITY` lockup against the first-LP attack (Uniswap V2).
- Privacy-via-composition for token positions (Tornado-on-ERC20
  pattern).

## Differences from Uniswap V2 and Penumbra ZSwap

| | Uniswap V2 | Penumbra ZSwap | tacit AMM |
|---|---|---|---|
| Substrate | Ethereum smart contract | Penumbra L1 (Cosmos) | Bitcoin L1 meta-protocol |
| Reserve location | EVM storage | Validator-tracked notes | Indexer state — no UTXO holds them |
| Reserve visibility | Public | Shielded | Public (cost of trustless reconstruction) |
| Pool custody | Pool contract holds tokens | Validator notes | None — virtual reserves |
| Pricing model | Per-swap CFMM | Per-block uniform clearing | Per-block uniform clearing |
| LP shares | ERC20 (public balances) | Concentrated-liquidity NFT | Confidential tacit asset; mixer-composable |
| MEV (sandwich) | Native exposure | Eliminated within batch | Intra-batch eliminated; cross-batch curation mitigated by opt-in arbiter |
| Per-trade privacy | None | Hidden | Hidden |
| Settlement actor | Anyone (gas-paid tx) | Validator set | Permissionless settler |
| Trust beyond consensus | Contract bug ⇒ total loss | Cosmos validators | Indexer rules + Groth16 — no custody surface |

## Status

- ⏸ Wire format + envelope opcodes (`SPEC.md §5.12–§5.14`)
- ⏸ Pool state object normative spec
- ⏸ Groth16 circuits:
  - `amm_lp_add.circom`, `amm_lp_remove.circom`, `amm_swap_batch.circom`
  - `amm_cross_curve.circom` — per-receipt AND per-intent
    secp256k1↔BN254 binding gadget; protocol-wide
    `cross_curve_vk_cid` pinned in `SPEC.md`. Note: the batch
    circuit invokes this gadget once per input (trader-paid at
    intent-post) AND once per receipt (settler-paid in batch
    proof) — output-side binding is load-bearing for soundness.
- ⏸ Phase 2 ceremony coordination (reuses mixer's coordinator)
- ⏸ Browser-side prover + verifier (reuses mixer's snarkjs vendoring)
- ⏸ Worker as message relay (websocket fanout between trader dapps
  and settlers; no opening-blob or signature escrow in v1)
- ⏸ Worker `qualifying-intents/:height` endpoint (signed list under
  pool-pinned `inclusion_arbiter_pubkey`)
- ⏸ Trader dapp interactive PSBT auto-signing flow (validate
  candidate batch locally; auto-sign `SIGHASH_ALL` + encrypt
  opening to settler pubkey)
- ⏸ Indexer envelope-hash OP_RETURN binding rule
- ⏸ Indexer per-receipt cross-curve binding verification path
- ⏸ Intent cancellation message + worker handling
- ⏸ Dapp UI (pool browser, LP add/remove, swap intent posting,
  cancel)
- ⏸ Deterministic clearing solve + zero-net case in `SPEC.md §11`
- ⏸ Determinism rules in `SPEC.md §11` (rounding, reorg depth,
  canonical ordering, T_SWAP_BATCH tx layout, mandatory inclusion)
- ⏸ Receipt blinding derivation + recovery rules (HMAC domains
  `tacit-amm-receipt-{secp,bn254}-v1`)
- ⏸ Deterministic `lp_asset_id = SHA256("tacit-amm-lp-v1" || pool_id)`
  origin rule (extends SPEC §5.1's `asset_id` derivation)
- ⏸ Mixer-style kernel sigs for `T_LP_ADD` / `T_LP_REMOVE`
- ⏸ NUMS-derived burn-output derivation for `MINIMUM_LIQUIDITY`
- ⏸ CETCH / T_PETCH `amm_launcher_pubkey` field (`SPEC.md` §5.1 / §5.8)
- ⏸ POOL_INIT `inclusion_arbiter_pubkey` field
- ⏸ Tests
- ⏸ cBTC bridge (separate document — required for BTC trading)

## Open / honest caveats

- **Reserves are public.** Full pool transparency is the cost of
  trustless reconstruction — same trade the mixer makes. Per-trade
  and per-LP privacy is preserved.
- **BTC trading depends on cBTC.** Native sat trading goes through
  the cBTC wrapper, which has its own trust model. The AMM doesn't
  add custody risk on top of whatever the wrapper assumes.
- **Single batch per pool per block.** Bitcoin's ~10-min block time
  caps swap latency at ~10 min. The model trades latency for
  fairness — every trader in a batch gets the same price. Not
  suitable for HFT.
- **Settlers see per-trader openings.** Per-trader openings are
  released by the trader's dapp directly to the claiming settler
  (encrypted to settler pubkey) so it can construct the batch
  proof. Settler cannot extract value (intent_sig + min_out
  constraint + envelope_hash binding prevent it) and cannot burn
  trader UTXOs (envelope_hash binding prevents it), but does
  learn the batch composition and per-trader amounts of intents
  it claims. Trust-conscious traders can route intents only to
  self-run settlers.
- **Interactive trader signing.** v1 requires the trader's dapp
  to be online during the worker→dapp PSBT-forwarding window in
  the block they want to settle (typically a few seconds). Closing
  the dapp tab simply defers inclusion to the next block when the
  trader reconnects, until `expiry`. This is the cost of binding
  trader sigs to envelope content without covenants; a future
  BIP-119 / OP_CTV adoption removes it.
- **Resign-on-composition-change.** Under `SIGHASH_ALL`, any
  change to the included intent set or batch structure shifts
  `envelope_hash` and forces all included traders to re-sign. The
  worker websocket pushes the fresh PSBT and the dapp auto-re-signs
  without prompt as long as the trader's `(min_out, tip, expiry,
  receipt scriptPubKey)` are still honored.
- **Two-layer circuit cost, with output-side binding.** Per intent,
  the trader pays a one-shot cross-curve binding proof bridging
  secp256k1 to BN254 (~100K–400K constraints, ~10–30s browser
  proving; needs empirical benchmarking before the spec is fixed).
  Per batch, the settler's proof now includes per-receipt
  cross-curve binding (same gadget shape, applied once per
  receipt) on top of mixer-tier BN254 work — total settler cost
  is roughly `N · cross_curve_cost + N · 3K` constraints. v1
  caps `N ≤ 16` to keep settler proving under ~2 minutes on a
  modern browser; production deployments running on a beefier
  prover machine can lift this. Bitcoin tx size also bounds N
  (standard-tx ceiling sits well above 16).
- **First-LP price-setting.** Whoever runs `POOL_INIT` sets the
  initial price. Standard problem; standard fix (founder seeds at
  fair market price; arbitrage corrects misprice quickly).
- **LP anonymity scales with mixer activity.** A pool whose
  `lp_asset_id` mixer pool sees few deposits gives weak anonymity
  for redemption. Same UX warning as the mixer.
- **Solo-intent batches expose the trader.** A batch with
  `n_intents = 1` has its full amounts publicly inferable from
  the batch deltas. The dapp warns when an intent is likely to
  settle solo.
- **Settler races waste proof work.** When multiple settlers race
  to include the next batch, only one wins. Off-chain coordination
  reduces this; in steady state it's a manageable cost.
- **Indexer-validated, not Bitcoin-consensus-enforced.** Same trust
  model as Runes / Ordinals / tacit's mixer. Well-established but
  readers should understand it.

## Defensible one-paragraph summary

> A Runes-style indexer-validated meta-protocol on Bitcoin L1 that
> adds a uniform-clearing-price block-batched AMM between any two
> tacit-native confidential assets. Pool reserves are virtual public
> quantities tracked by the indexer; **no UTXO anywhere holds pool
> funds** — the protocol custodies nothing, exactly mirroring the
> mixer's architecture. Per-trader amounts in a batch are confidential
> via Pedersen; LP positions are confidential tacit assets that
> compose with the existing mixer for anonymous participation. Each
> Bitcoin block, a permissionless settler bundles all queued swap
> intents and settles them in one transaction at one uniform price —
> eliminating intra-batch MEV by construction. BTC trading flows
> through cBTC (a separate wrapper) so the AMM never directly
> custodies sats. The cryptographic primitives reuse tacit's mixer
> stack; the *composition* of these specific things into an AMM on
> Bitcoin L1 doesn't appear to have a live production peer.
> Engineering and integration achievement, not cryptographic
> invention.

## References

- SPEC: [`SPEC.md`](./SPEC.md) — normative tacit spec
- MIXER: [`MIXER.md`](./MIXER.md) — companion architecture summary
  (the AMM extends the same virtual-pool pattern)
- Uniswap V2 whitepaper: <https://uniswap.org/whitepaper.pdf>
- Penumbra ZSwap: <https://protocol.penumbra.zone/main/zswap.html>
- Gnosis Protocol (uniform-clearing batch auction):
  <https://docs.gnosis.io/protocol/>
- Cardano DEX batcher pattern (Minswap docs):
  <https://docs.minswap.org/>
- Tempo DEX (pathUSD routing):
  <https://docs.tempo.xyz/guide/stablecoin-dex>
- Tornado Cash whitepaper: <https://tornado.cash/Tornado.pdf>
- Indexer-validated meta-protocol pattern: <https://docs.ordinals.com/>
