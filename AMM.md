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

This document is a positioning + architecture summary. The normative
spec will live in [`SPEC.md` §5.12–§5.14 and §11](./SPEC.md).

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
| MEV mitigation | None native | Eliminated within batch | Eliminated within batch |
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
│    Pedersen commit C_in            │  │                                              │
│    min_out, expiry                 │  │  picks subset {i₁, …, iₙ} that all clear     │
│                                    │  │  at one uniform price within each min_out    │
│  trader 2 (B→A):                   │  │                                              │
│    input UTXO of B                 │  │  computes net flow against pool curve:       │
│    Pedersen commit C_in            │  │    Δa_net = Σ signed_amount_A_i              │
│    min_out, expiry                 │  │    Δb_net solved from constant-product +     │
│                                    │  │              fee invariant                   │
│  …                                 │  │    P_clear = |Δa_net| / |Δb_net|             │
│                                    │  │                                              │
│  signed by trader, BIP-340 over    │  │  for each trader i, derive their share at    │
│  intent_msg; opening encrypted to  │  │  P_clear; verify min_out_i satisfied         │
│  worker for settler release        │  │                                              │
└──────────────────┬─────────────────┘  │  generates one Groth16 batch proof binding:  │
                   │                    │    • each per-intent BN254 commit opens to   │
                   │ batched            │      declared amount                         │
                   ▼                    │    • each receipt opens to derived amount    │
┌─────────────────────────────────────┐ │      with deterministic blinding             │
│ ONE BITCOIN TRANSACTION             │ │    • Σ amounts = public Δa_net, Δb_net       │
│                                     │ │    • uniform price across intents            │
│  inputs:                            │ │    • each min_out_i satisfied                │
│   N trader intent UTXOs             │ │    • range proofs                            │
│                                     │ └─────────────────────┬────────────────────────┘
│  outputs:                           │                       │
│   N trader receipt UTXOs            │                       ▼
│   1 settler tip output              │ ┌────────────────────────────────────────────┐
│                                     │ │  INDEXER                                   │
│  envelope: T_SWAP_BATCH with        │ │                                            │
│  per-intent binding + 1 proof       │ │  • verify each per-intent intent_sig and   │
│  + public Δa_net, Δb_net            │ │    cross-curve proof (out-of-circuit)      │
└─────────────────────────────────────┘ │  • re-verify batch Groth16 against pool.vk │
                                        │  • check constant-product invariant on     │
                                        │    public deltas vs. current public R_A,R_B│
                                        │  • check chain-side aggregate Pedersen     │
                                        │    on secp256k1 (one equation per asset,   │
                                        │    inputs and receipts both included)      │
                                        │  • R_A → R_A + Δa_net                      │
                                        │  • R_B → R_B + Δb_net                      │
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
the Groth16 verifying key, fee basis points, and the LP-share
asset's `lp_asset_id` at content-addressed `vk_cid` time, fixed
forever.

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
Consumes the LP's `asset_A` and `asset_B` input UTXOs via standard
CXFER-style kernel signatures (Mimblewimble: signing scalar is the
input blinding, message binds public per-leg amount). Mints
`share_amount` of `lp_asset_id` to the depositor. Per-op amounts
`(Δa, Δb, share_amount)` are public; the LP-share UTXO itself is
per-UTXO confidential. The Groth16 proof asserts at-the-ratio
deposit, share-formula correctness, and correct opening of the new
LP-share commitment.

**`T_LP_REMOVE` (`0x2C`)** — Burns `share_amount` of `lp_asset_id`
and withdraws proportional reserves of both assets. CXFER-style
kernel sig on the consumed LP-share UTXO. The Groth16 proof asserts
proportional withdrawal and correct receipt-commitment openings.

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

**Batch proof operates only on BN254 commitments.** The settler's
single Groth16 batch proof asserts:

- **Opening of each per-intent commitment.** Knowledge of
  `(amount_i, r_BN254_i)` such that
  `Poseidon(amount_i, r_BN254_i) = C_amount_BN254_i`. The circuit
  recomputes each Poseidon hash against the witness; per-direction
  `Σᵢ amount_i` is then computed in-circuit over the cleartext
  amounts and exposed as a public input. (Poseidon is not
  additively homomorphic — the sum is over re-opened cleartext,
  not over commitments. Pedersen on secp256k1 is what carries
  homomorphic structure for the chain-side aggregate check below.)
- **Direction-aware receipt amounts at the uniform clearing
  ratio.** Each receipt commitment `C_receipt_BN254` opens with a
  deterministically-derived blinding (so the trader can recover
  the receipt offline from privkey alone) to:
  - `amount_out_i = amount_in_i · |Δb_net| / |Δa_net|` for an A→B
    trader (input A, receipt B)
  - `amount_out_i = amount_in_i · |Δa_net| / |Δb_net|` for a B→A
    trader (input B, receipt A)
- Each `amount_out_i ≥ min_out_i`.
- Range proofs on every per-trader amount.

All in BN254 land — circuit cost is mixer-tier (~3K constraints per
intent, ~5s browser proving for N=20).

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

**Per-`vin` Bitcoin-layer signature.** Each trader's tacit input
needs a Bitcoin-consensus signature at broadcast time, but batch
composition, clearing price, and per-receipt amount are settler-
determined *after* the trader posts the intent — so a plain
`SIGHASH_ALL` pre-sign over an unknown tx is impossible. v1
exploits two structural properties of tacit receipts to make a
pre-signed sighash safe: (1) tacit value lives in the envelope's
Pedersen commitment, not in the Bitcoin output's `value` field;
(2) the receipt's `scriptPubKey` is the trader's own receive
address, fixed at intent-post time. The trader's receipt vout is
therefore a known `(scriptPubKey, dust_value)` pair before any
settler work.

Traders pre-sign their input spend with **`SIGHASH_SINGLE |
ANYONECANPAY` (0x83)** — the same sighash discipline tacit's
atomic-listing flow uses (see `dapp/tacit.js`, search
`SIGHASH_SINGLE_ACP`). The signature binds only the trader's own
input prevout and the same-index output's `(scriptPubKey, value)`;
other traders' inputs, the settler tip, and other receipt vouts
are uncommitted — exactly what batch settlement needs. Position
binding is the wrinkle: `SIGHASH_SINGLE` ties input index `k` to
output index `k`, and `k` is the trader's rank in `intent_id`
ascending sort within the included subset (per "Canonical
ordering" under Indexer determinism). If a higher-ranked intent
expires or cancels between sign and broadcast the trader's rank
shifts and the sig breaks; v1 handles this with **resign-on-shift**
— the dapp keeps a worker websocket open and auto-re-signs a fresh
PSBT on rank change, with no confirmation prompt as long as
`min_out`, `tip`, `expiry`, and the receipt scriptPubKey are
unchanged. Traders offline at broadcast time accept that their
intent may settle one block late if their rank shifts. A future
BIP-119/OP_CTV adoption would let the trader pre-commit to a
covenant template and remove resigning entirely.

**Burn risk and worker-escrow mitigation.** A pre-signed input
that Bitcoin accepts but the tacit indexer rejects burns the
trader's tacit value: Bitcoin sees a valid spend, the indexer sees
an invalid batch and credits no receipt. v1 closes this by making
the worker the **opening-blob escrow**: the trader's
`(amount_in, r_BN254)` opening is encrypted to the worker, not to
any settler. A settler claims an intent by submitting a candidate
batch (composition + proposed `(Δa_net, Δb_net)` + proposed
Bitcoin tx skeleton with assigned indices) to the worker; the
worker re-runs the indexer's full validation against the candidate
— constant-product invariant, `min_out` for every included intent,
canonical-ordering check, mandatory-inclusion check — and only on
pass releases the openings the settler needs to construct the
batch proof. A settler cannot broadcast a tacit-invalid batch
because they cannot construct a valid batch proof without
worker-released openings. The worker becomes a trust dependency
for **liveness** (it can refuse to release openings, denying the
settler proof material) but not for **soundness** (it cannot forge
intents, alter `min_out`, or extract value — those are pinned by
the trader's `intent_sig` and the in-circuit `min_out`
constraint). Trust-conscious traders self-host a worker, run their
own settler, or encrypt openings directly to a nominated
settler's published key — trading the burn-risk mitigation for
fully-trustless operation.

There is no separate tacit kernel sig per `vin`. Tacit-layer
consumption is jointly authorized by `intent_sig` (out-of-circuit,
BIP-340), the cross-curve binding proof (per intent), the batch
proof (BN254), and the aggregate Pedersen check (secp256k1);
Bitcoin-layer consumption is the `SIGHASH_SINGLE | ANYONECANPAY`
signature above.

**Trader binding to clearing price.** The trader's one-shot
`intent_sig` over `intent_msg` commits `min_out`, and the in-circuit
`amount_out_i ≥ min_out_i` constraint ensures any settler-chosen
`P_clear` honors the trader's worst-acceptable price. No delegated
clearing-price-signing needed.

## Uniform clearing

Each Bitcoin block, a settler — any participant — selects a subset
of queued swap intents, computes one clearing price for the whole
batch, and settles them in a single transaction.

**Intent collection.** Traders post signed swap intents to a
worker — direction, dual commitments to the input amount
(`C_in_secp` from the trader's existing input UTXO plus a fresh
BN254-friendly `C_amount_BN254`), a one-shot cross-curve binding
proof, `min_out`, tip, `input_utxos` references, `expiry`, and a
per-intent `intent_sig` under `trader_pubkey`. The opening
`(amount_in, r_BN254)` needed to construct the batch proof is
encrypted in an `opening_blob` released to the claiming settler at
batch construction time. Chain observers see only commitments and
aggregate batch deltas — never the cleartext per-trader amount.

**Whole-UTXO consumption only.** If a trader's available UTXO is
larger than their intended `amount_in`, they pre-split via `CXFER`
(§5.2) before posting the intent. v1 does not support partial-UTXO
draws inside a swap batch; the additional split is one extra
Bitcoin tx of trader latency.

**Settlement.** A settler reads the open intent set + current pool
state and:

1. Selects a subset that all clear at one price within each
   trader's `min_out`.
2. Computes `Δa_net` numerically and solves `Δb_net` from the
   constant-product curve at the pool's current reserves with fee
   `γ = (10000 − fee_bps) / 10000`.
3. Computes `P_clear = |Δa_net| / |Δb_net|`. If any `min_out_i`
   fails at `P_clear`, drops that intent and re-solves.
4. Builds the Bitcoin tx: consumes N intent UTXOs → emits N
   trader receipts + 1 settler tip.
5. Generates one Groth16 batch proof.
6. Broadcasts.

**Fairness within a batch.** Every trader pays/receives the same
`P_clear`. There is no in-batch ordering, no sandwich, no
priority-fee MEV. The settler's only freedom is which subset to
include; their incentive maximizes by including everyone whose
`min_out` is satisfiable, since excluded intents leave tip revenue
on the table.

**Cross-batch ordering.** Bitcoin consensus admits one batch tx
per pool per block as the typical case (each batch consumes the
same trader UTXOs once). If multiple batches against the same pool
confirm in the same block, the indexer applies them in `(tx_index,
vin[0] outpoint)` order and rejects later batches whose deltas
violate the constant-product invariant against post-earlier-batch
reserves. Settlers SHOULD coordinate off-chain on a one-batch-per-
pool-per-block convention to avoid wasted proof work.

**Settler economics.** Each intent specifies a `tip` value and
`tip_asset` (either of the pool's two assets). The settler
aggregates tips into one tip output and pays the Bitcoin tx fee
from their own BTC inputs, recouping via the tip mechanism.
Permissionless — any tacit user with a chain view + intent-pool
read can become a settler.

**Pricing invariant.** The constant-product check is
direction-aware. With `γ = (10000 − fee_bps) / 10000` and v1's
net-flow fee policy:

- **A→B-dominant batch** (`Δa_net > 0`, `Δb_net < 0`):
  `(R_A + γ·Δa_net) · (R_B + Δb_net) ≥ R_A · R_B`
- **B→A-dominant batch** (`Δa_net < 0`, `Δb_net > 0`):
  `(R_A + Δa_net) · (R_B + γ·Δb_net) ≥ R_A · R_B`

Fee `γ` applies only to the **net-inflowing side** — the cancelled
portion of intents that net against each other within a batch pays
no fee, only the residual that actually hits the curve does. This
is the Penumbra-style fee policy, chosen for envelope simplicity
(no per-direction gross-flow field on chain). A V2-style gross-
input fee policy is a v2 variant.

Settlers solve for `(Δa_net, Δb_net)` off-chain; the indexer
accepts the solution as an inequality, so any slack between LHS
and RHS accrues to LPs as fee revenue beyond the nominal
`fee_bps`. The inequality direction prevents settlers from
extracting value from the pool — only from being marginally
generous to it.

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
- T_SWAP_BATCH constant-product check: γ-scaling done in u128 to
  avoid overflow; the looser inequality direction wins.

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
MUST appear in `intent_id` ascending byte-order; indexers reject
violations.

**Mandatory inclusion of qualifying intents.** To eliminate
cross-batch curation MEV (the settler's incentive to selectively
exclude intents that would move price against their own LP
position), the indexer enforces a forced-inclusion rule:

An intent is **qualifying for height H** if (a) it has been open
in the worker's intent pool since at least height `H − K` (default
`AMM_MANDATORY_INCLUSION_DEPTH = 2`), (b) its `expiry` has not
lapsed, and (c) its `min_out` is satisfiable at the candidate
batch's `P_clear`.

When validating a `T_SWAP_BATCH` at height H, the indexer fetches
the canonical signed list of qualifying intents for that pool and
rejects the envelope if any qualifying intent was excluded. The
worker exposes a `GET /pools/:pool_id/qualifying-intents/:height`
endpoint returning a height-stamped, BIP-340-signed list.

**Inclusion arbiter pubkey.** The signed list's authority comes
from one or more `inclusion_arbiter_pubkey` values pinned at
`POOL_INIT`. Indexers accept the qualifying-intents list for a
pool only if signed by at least one of that pool's pinned
arbiters. If `POOL_INIT` pins no arbiter, mandatory inclusion is
unenforceable for that pool and settlers operate in best-effort
mode — curation MEV is bounded only by tip-revenue economics.
Pools that care about strong MEV resistance SHOULD pin a multisig
or independent-operator quorum (`k`-of-`n`) rather than a single
key; pools that prefer minimal trust delegation leave the field
unset and accept the weaker guarantee.

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
defends against settler price manipulation. **MEV is eliminated
intra-batch by uniform pricing and cross-batch by the
mandatory-inclusion rule** (see Indexer determinism); the settler's
remaining freedom is timing — when to broadcast — not censorship.
Liveness depends on at least one working indexer + one available
settler; both are permissionless. Anyone can run their own indexer
+ settler from chain data alone.

**Privacy delegation for swap intents.** Per-trader openings
`(amount_in, blinding_in)` are released to the claiming settler so
it can construct the batch Groth16 proof. The worker mediates this
via short-lived encrypted blobs. The worker is a **privacy
intermediary** (it can decrypt openings), not a **custody
intermediary** (it cannot forge intents or extract value — the
trader's `intent_sig` and the in-circuit `min_out` constraint
prevent it). Trust-conscious traders can self-host a worker, run
their own settler, or encrypt openings directly to a nominated
settler's published key.

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
| MEV (sandwich) | Native exposure | Eliminated within batch | Eliminated within batch |
| Per-trade privacy | None | Hidden | Hidden |
| Settlement actor | Anyone (gas-paid tx) | Validator set | Permissionless settler |
| Trust beyond consensus | Contract bug ⇒ total loss | Cosmos validators | Indexer rules + Groth16 — no custody surface |

## Status

- ⏸ Wire format + envelope opcodes (`SPEC.md §5.12–§5.14`)
- ⏸ Pool state object normative spec
- ⏸ Groth16 circuits:
  - `amm_lp_add.circom`, `amm_lp_remove.circom`, `amm_swap_batch.circom`
  - `amm_cross_curve.circom` — per-intent secp256k1↔BN254 binding,
    protocol-wide `cross_curve_vk_cid` pinned in `SPEC.md`
- ⏸ Phase 2 ceremony coordination (reuses mixer's coordinator)
- ⏸ Browser-side prover + verifier (reuses mixer's snarkjs vendoring)
- ⏸ Worker indexing + intent-pool + settler logic
- ⏸ Worker `qualifying-intents/:height` endpoint (signed list under
  pool-pinned `inclusion_arbiter_pubkey`)
- ⏸ Worker intent-opening encryption / settler-claim release flow
- ⏸ Intent cancellation message + worker handling
- ⏸ Dapp UI (pool browser, LP add/remove, swap intent posting,
  cancel)
- ⏸ Determinism rules in `SPEC.md §11` (rounding, reorg depth,
  canonical ordering, mandatory inclusion)
- ⏸ Trader receipt blinding derivation + recovery rules
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
  released to the claiming settler so it can construct the batch
  proof. Settler cannot extract value (intent_sig + min_out
  constraint prevent it) but does learn batch composition.
- **Two-layer circuit cost.** Per intent, the trader pays a
  one-shot cross-curve binding proof bridging secp256k1 to BN254.
  Comparable published designs land in the ~100K–400K constraint
  range (~10–30s browser proving); precise numbers need
  benchmarking before the spec is fixed. Per batch, the settler's
  proof is mixer-tier (~3K constraints per intent in BN254, ~5s
  for N=20). Trader cost dominates per-swap UX latency; settler
  cost bounds throughput. Bitcoin tx size also bounds N (the
  standard-tx ceiling sits in the hundreds-of-intents range).
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
