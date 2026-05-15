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
to the tacit protocol. It contributes five normative opcodes
already in `SPEC.md` (§§5.14–5.18) — three core trading opcodes
(`T_LP_ADD` `0x2D`, `T_LP_REMOVE` `0x2E`, `T_SWAP_BATCH` `0x2F`
batched-uniform-price MEV-resistant mode) plus two auxiliary
infrastructure opcodes (`T_INTENT_ATTEST` `0x30` for preconfirmation
soft-confirms, `T_PROTOCOL_FEE_CLAIM` `0x31` for accrued
protocol-fee withdrawal) — and **reserves slot `0x32` for
`T_SWAP_VAR`** (per-trade variable-amount mode reusing
`T_AXFER_VAR` cryptography), specified in the draft amendment
[`SPEC-VARIABLE-AMOUNT-AMENDMENT.md`'s sibling
`SPEC-SWAP-VAR-AMENDMENT.md`](./SPEC-SWAP-VAR-AMENDMENT.md) and
not yet merged into `SPEC.md`. The set adds a deterministic
`lp_asset_id` derivation rule, AMM-specific receipt-recovery
derivations, and an envelope-hash `OP_RETURN` binding rule for
batched settlement — all built on the same indexer-validated
virtual-pool pattern as tacit's mixer (SPEC §5.10–§5.11). The
five live opcodes are normative in `SPEC.md`; `T_SWAP_VAR`'s slot
is reserved here and becomes normative once the amendment lands.

**Last harmonized:** 2026-05-15 (P0 + P1 fixes + variable-amount
integration — pseudocode signature, arithmetic-width normativity,
orderbook DEX + wrapper integration, solve-algorithm proof
sketches, first-LP misprice mitigation cascade, arbiter-
confidentiality trade-off, tip-output layout reconciliation,
**`T_SWAP_VAR` `0x32` reserved as the variable-amount per-trade
AMM mode reusing `T_AXFER_VAR` cryptography — opt-in alongside
the existing batched-uniform `T_SWAP_BATCH`**). See
[`AMENDMENTS.md`](./AMENDMENTS.md) for the surrounding amendment
dependency graph.

**Dapp implementation status (as of 2026-05-15):** This document
specifies the AMM but the reference dapp (`dapp/tacit.js`) does NOT
yet implement the trader surface — `grep T_SWAP_BATCH|T_LP_ADD|
T_LP_REMOVE|amm_intent` returns zero matches. The dapp's swap tile
routes through the orderbook DEX (variable-fill asks/bids) only; an
AMM `kind: 'amm'` candidate path in `planBuy` / `planBuyExactOut` is
the next implementation step once the V1 ceremony completes. Until
then, this spec describes a not-yet-shipped trader experience and
indexer behaviour. The pool-state validator + crypto have been
prototyped against the test harness, but no on-chain `T_SWAP_BATCH`
has ever been broadcast by a tacit dapp.

### Relationship to the orderbook DEX

Tacit also ships a continuous-amount orderbook DEX via
[`SPEC.md` §5.7.6.1 + §5.7.9](./SPEC.md) (`T_AXFER_VAR` `0x37` —
landed via [the variable-amount T_AXFER amendment](./SPEC-VARIABLE-AMOUNT-AMENDMENT.md),
now merged into SPEC.md), and the variable-fill bid layer drafted
in [`SPEC-BID-VARIABLE-AMOUNT-AMENDMENT.md`](./SPEC-BID-VARIABLE-AMOUNT-AMENDMENT.md),
which together provide a pure-form Bitcoin orderbook with maker-quoted
prices and taker-driven partial fills. **The AMM is not the only path
to liquidity.** The reference dapp's swap tile today routes
exclusively through orderbook asks (fill-then-bid; commit `7f68faa`);
once the AMM trader surface lands (see "Dapp implementation status"
above), the routing will compose the two — orderbook first for
range-tolerant flow, then AMM for residual exact-amount flow, falling
through the second only when the user opts into AMM-specific
semantics.

Practical implications for readers:

- **The "Without AMM" diagram below** (peer-to-peer atomic-intent
  flow) describes what is now a fully-featured orderbook DEX, not a
  primitive fallback. The orderbook handles continuous maker quotes
  and arbitrary-amount taker fills; AMM handles deep-liquidity
  passive market-making.
- **Settler economics** assume orderbook competition. A settler that
  bundles an AMM batch knows traders had the option to route through
  asks; AMM tips have to be competitive with orderbook taker fees,
  not with a "no alternative" baseline.
- **Arbitrage flow.** With both surfaces live, arbitrageurs trade
  between them — orderbook asks priced above AMM spot get filled by
  AMM-side flow and vice versa. This is the price-coherence mechanism
  in V1; the AMM does not need a separate oracle for the orderbook to
  track its prices.
- **Two AMM trader paths (both V1).** The AMM offers two settlement
  modes that traders/dapps choose between per intent. They have
  different privacy and amount-range trade-offs:
  1. **`T_SWAP_BATCH` (`0x2F`) — batched uniform clearing,
     fixed-amount.** Per-intent commitment to one cleartext
     `amount_in_swap` plus `min_out` slippage floor (§"1. Envelope
     byte layouts"). All intents in the batch settle at one
     deterministically-solved `P_clear` (§"4. Deterministic
     clearing-solve algorithm"). **Trader amounts are hidden** from
     chain observers via the batched Groth16 proof — only aggregate
     deltas `(Δa_net, Δb_net)` are public, the same amount-
     confidentiality story as the mixer. Cost: fixed-amount only,
     no range semantics; whole-UTXO consumption requires pre-split
     via CXFER if the trader's UTXO is larger than the intent
     amount.
  2. **`T_SWAP_VAR` (`0x32`) — per-trade against curve, variable
     amount.** Single-fill opcode reusing CXFER N=2 cryptography
     (Pedersen + bulletproof + kernel sig, same primitives as
     `T_AXFER_VAR` `0x37` from the variable-amount amendment). The
     trader posts an `[Y, X]` range; the fill amount `Δ ∈ [Y, X]` is
     bounded by the user's range and the pool's per-fill output at
     the spot curve `Δ_out = R_B · γ · Δ / (R_A · γ_den + γ · Δ)`.
     No clearing solve, no batch, no Groth16 — just a per-fill
     curve evaluation against virtual reserves. **Trader amounts are
     public** (the chosen `Δ` is in cleartext on chain), but the
     trader gets variable-amount semantics: typed budgets, residual
     fills, partial-balance trades all compose naturally.

  `T_SWAP_VAR` is the natural primary path for the dapp's swap
  tile — it composes with the fill-then-bid orderbook routing
  (orderbook ask first, then AMM `T_SWAP_VAR` for the residual at
  whatever depth is available, then variable-fill bid for any
  remaining). `T_SWAP_BATCH` is the opt-in MEV-resistant mode for
  privacy-sensitive flow (large trades that want amount
  confidentiality from chain observers and willing to batch with
  others). The dapp UX should default to `T_SWAP_VAR` and surface
  `T_SWAP_BATCH` as "private mode" with the trade-off explained
  (longer settlement latency, fixed-amount commitment, hidden
  trade size).

  Wire format and circuit details for `T_SWAP_VAR` will land as a
  follow-up amendment (`SPEC-SWAP-VAR-AMENDMENT.md`); this section
  reserves opcode `0x32` and the design slot. The remaining V2
  range-LP opcode suggestions (LP_ADD_RANGE, LP_REMOVE_RANGE, etc.)
  shift to `0x33`–`0x36` in the "Opcode space reservation" table
  (the 5th V2-range opcode `T_SWAP_BATCH_RANGE` moves to TBD since
  `0x37`–`0x42` are claimed by `T_AXFER_VAR`, `T_WRAPPER_ATTEST`,
  and the cUSD CDP amendment).
- **Cross-amendment dependency.** AMM pool initialization (POOL_INIT,
  §"POOL_INIT") of [wrapper-tagged assets](./SPEC-WRAPPER-AMENDMENT.md)
  (`tacit_wrapper` CETCH metadata field) is permissionless — the AMM
  treats wrapped and unwrapped assets identically by `asset_id`. The
  wrapper convention's coverage check is the dapp's responsibility,
  not the AMM indexer's; pool soundness depends only on the
  invariant on `R_A`, `R_B`, and `S`, not on whether `asset_A` is
  itself backed by something off-protocol.

The protocol-oracle + canonical-cUSD work
([`SPEC-CUSD-CDP-AMENDMENT.md`](./SPEC-CUSD-CDP-AMENDMENT.md))
extends this by sourcing prices from AMM TWAPs of canonical pools.
That dependency runs in the other direction (oracle depends on AMM),
so AMM V1 operates standalone; the oracle ships only after AMM has
TVL.

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

The on-chain footprint is six envelope opcodes — four core trading
(`T_LP_ADD` `0x2D`, `T_LP_REMOVE` `0x2E`, `T_SWAP_BATCH` `0x2F`
batched-uniform mode, `T_SWAP_VAR` `0x32` per-trade variable-amount
mode) plus two auxiliary (`T_INTENT_ATTEST` `0x30` preconf, and
`T_PROTOCOL_FEE_CLAIM` `0x31` fee withdrawal) — riding on regular
Bitcoin commit + reveal taproot transactions.
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
already there. The AMM adds six envelope opcodes — three core
trading + two auxiliary infrastructure + one per-trade variable-
amount mode reusing CXFER N=2 crypto — and a new batch-clearing
Groth16 circuit for the batched mode; everything else recombines
existing machinery.

### Cryptographic flow (batched swap)

```
┌─── INTENT POOL (off-chain) ────────┐  ┌─── SETTLER (anyone) ─────────────────────────┐
│                                    │  │                                              │
│  trader 1 (A→B):                   │  │  reads current pool state (R_A, R_B, S)      │
│    input UTXO of A                 │  │  reads queued intents for this pool          │
│    Pedersen commit C_in_secp       │  │                                              │
│    Pedersen commit C_in_BJJ (aux)  │  │  picks subset {i₁, …, iₙ}; runs deterministic│
│    sigma cross-curve binding (169B)│  │  clearing solve over public reserves + γ:    │
│    min_out, tip, expiry            │  │    Δa_in_net = gross A-side residual         │
│    intent_sig (BIP-340)            │  │    Δb_out_net = floor(R_B·γ·Δa_in_net /      │
│                                    │  │                       (R_A + γ·Δa_in_net))   │
│  trader 2 (B→A): symmetric         │  │    P_clear   = Δa_in_net / Δb_out_net        │
│  …                                 │  │                                              │
│                                    │  │  drops any intent failing min_out at P_clear │
│  trader dapps keep websockets      │  │  re-solves until stable                      │
│  open to a worker (relay only)     │  │                                              │
│  through `expiry`                  │  │  RTT 1: asks each trader for opening blob    │
└──────────────────┬─────────────────┘  │  (amount_in, r_in_secp, r_in_BJJ,          │
                   │                    │  r_out_secp, r_out_BJJ) encrypted to       │
                   │ envelope assembled │  settler pubkey                              │
                   │ with proof first;  │                                              │
                   │ RTT 2: traders     │  GENERATES Groth16 proof first, embeds it    │
                   │ auto-sign PSBT     │  in envelope, THEN computes envelope_hash;   │
                   ▼                    │  assembles PSBT with vout[0]=OP_RETURN(hash);│
                                        │  RTT 2: traders return SIGHASH_ALL sigs      │
┌─────────────────────────────────────┐ │  generates one Groth16 batch proof asserting:│
│ ONE BITCOIN TRANSACTION             │ │    • each C_in_BJJ opens (native BJJ) to a   │
│                                     │ │      witness amount; sum matches public Δ    │
│  vin[0] : settler envelope input    │ │    • each receipt's amount_out_i derived     │
│  vin[1+i]: trader inputs (sorted    │ │      from amount_in_i and P_clear            │
│            by intent_id ascending)  │ │    • each C_out_BJJ opens to that amount_out │
│                                     │ │      under the trader's deterministic r_BJJ  │
│  vout[0]: OP_RETURN(envelope_hash)  │ │    • each amount_out_i ≥ min_out_i           │
│  vout[1+i]: trader receipt outputs  │ │    • range proofs on every amount, in/out    │
│             (dust to receive script)│ │   (per-receipt cross-curve binding is a      │
│  vout[N+1]: aggregated settler tip  │ │    separate sigma proof, NOT in-circuit)     │
│  vout[N+2..]: optional BTC change   │ └─────────────────────┬────────────────────────┘
│                                     │                       │
│  envelope: T_SWAP_BATCH payload     │                       ▼
│   - per-receipt C_out_secp + C_out_ │ ┌────────────────────────────────────────────┐
│     BJJ (one pair per trader)       │ │  INDEXER                                   │
│   - per-receipt sigma cross-curve   │ │                                            │
│     proofs (169 B each)             │ │  • verify each per-intent and per-receipt  │
│   - public Δa_net, Δb_net           │ │    sigma cross-curve proof (out-of-circuit)│
│   - per-asset R_net (aggregate r)   │ │                                            │
│   - per-intent trader_pubkey +      │ │                                            │
│     C_in_BJJ                        │ │                                            │
│   - one Groth16 batch proof         │ │                                            │
└─────────────────────────────────────┘ │    + intent_sig (BIP-340)                  │
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
the two `asset_id` byte strings, with **strict byte inequality**
required — `POOL_INIT` MUST reject `asset_A == asset_B` (a same-
asset pool is degenerate: swap directions collapse, the curve has
no meaning, and kernel sigs lose disambiguation between A-side and
B-side balance closures). The canonical `pool_id =
SHA256("tacit-amm-pool-v1" || asset_A || asset_B)`. Pool init pins
the Groth16 verifying key and fee basis points; the LP-share
asset's `lp_asset_id` is **deterministically derived** as
`lp_asset_id = SHA256("tacit-amm-lp-v1" || pool_id)`. This is a
new asset-identity rule: SPEC §4 derives `asset_id` from a `CETCH`
or `T_PETCH` reveal txid (`SHA256(reveal_txid_BE || 0_LE)`), and
the AMM adds a third valid origin — a deterministic derivation
from a confirmed `POOL_INIT`. No `CETCH` is required for LP shares.

**Three-origin asset_id resolution (indexer rule).** When a wallet
or recursive validator encounters an `asset_id` it doesn't yet
recognise, the indexer resolves the origin by checking, in order:

1. Is there a confirmed `CETCH` whose reveal-tx satisfies
   `asset_id == SHA256(reveal_txid_BE || 0_LE)`?
2. Is there a confirmed `T_PETCH` whose reveal-tx satisfies the
   same equation? (CETCH and T_PETCH are mutually exclusive — a
   given asset_id matches at most one.)
3. Is there a confirmed canonical `POOL_INIT` whose `pool_id`
   satisfies `asset_id == SHA256("tacit-amm-lp-v1" || pool_id)`?

The lookup is constant-time given an indexer-maintained reverse
map keyed by `asset_id`. Domain separation between paths is
structural — the SHA256 preimages are disjoint by construction
("tacit-amm-lp-v1" || pool_id is 53 bytes; reveal_txid_BE || 0_LE
is 36 bytes), so cross-origin collisions reduce to SHA256
preimage-finding under different domains and are negligible.
Indexers treat the first canonical `T_LP_ADD(variant=1)` (=
`POOL_INIT`) for a pair as the genesis of that pool's
`lp_asset_id`; subsequent `T_LP_ADD(variant=0)` and `T_LP_REMOVE`
envelopes mint/burn against the same `lp_asset_id`. The validator
algorithm in SPEC §5.5 extends with one additional branch: when
walking an ancestry that lands on a `T_LP_ADD` or `T_LP_REMOVE`
producing an `lp_asset_id` UTXO, resolution path (3) above is what
authorises that UTXO as a real tacit asset.

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
asset's **IPFS metadata blob** — the same content-addressed JSON
the etcher already pins under the envelope's `image_uri` and which
already carries `tacit_attest` per SPEC §7.3. Because the blob is
content-addressed and the CID is committed in the on-chain CETCH /
T_PETCH envelope, the field is immutable at etch time, recoverable
from chain + IPFS by any indexer, and requires **zero changes** to
the existing on-chain envelope wire format. Concretely the blob
gains one optional field:

```json
{
  "tacit_attest":      { "supply": "...", "blinding": "...", "commitment": "..." },
  "tacit_amm_launcher": "<33-byte compressed pubkey, hex>"
}
```

Indexers validating `POOL_INIT` for `(asset_A, asset_B)` fetch each
asset's metadata blob by its envelope-committed CID, read
`tacit_amm_launcher` (if present), and gate as follows:

- If both assets declare a launcher, `POOL_INIT` is rejected unless
  the envelope carries a BIP-340 signature from each declared
  launcher pubkey over `SHA256("tacit-amm-launcher-gate-v1" ||
  pool_id || vk_cid || fee_bps_LE)`.
- If only one declares, only that one must co-sign.
- If neither declares, first-canonical-wins applies.

Assets etched before this convention exists, or that omit the
field, transparently default to first-mover. The blob is fetched
once at pool-init validation; pool state thereafter is purely
chain-local. **The field cannot be added or rotated after etch** —
the CID is fixed in the envelope, so changing the blob would change
its CID and the on-chain reference would no longer resolve. Issuers
who care about controlled launches set the field at etch time;
issuers who later regret the choice cannot retrofit it.

The field is **load-bearing** when set: a lost privkey permanently
prevents pool initialization for any pair involving that asset
under the gate. Issuers SHOULD use a multisig or backed-up key if
they set the field at all.

#### Indexer-determinism for the metadata blob

JSON is non-canonical by default (key order, whitespace, number
formats, Unicode escapes), so naive parsing could let two indexers
disagree on whether the field is present or what value it holds.
Two normative rules close this:

1. **The blob is content-addressed.** The IPFS CID in the asset's
   `image_uri` resolves to byte-identical content for every
   retriever. There is no parsing ambiguity at the bytes layer —
   the question is purely how to extract the launcher pubkey from
   those bytes deterministically.
2. **The blob MUST be canonical JSON per RFC 8785 (JCS).** JCS
   defines a deterministic serialization (sorted keys, no
   redundant whitespace, normalized number forms, NFC Unicode).
   The dapp's etch-metadata builder canonicalizes before pinning;
   downstream indexers re-canonicalize on fetch and reject the
   blob (treating the gate as absent) if the fetched bytes
   differ from their canonicalized form.

Field-extraction rule for indexers: after JCS verification, find
the top-level key `tacit_amm_launcher` whose value is a 66-char
lowercase hex string (33-byte compressed secp256k1 pubkey). If
present exactly once at top level → gate is set; absent or
malformed → no gate. Conservative default ("no gate" on any
ambiguity) means a malformed blob falls back to first-mover, not
to a hard pool-init failure.

Existing CETCH/T_PETCH metadata blobs that predate this convention
are already pinned to fixed CIDs and may not be JCS-compliant.
Indexers SHOULD treat any pre-AMM blob as "no launcher gate"
regardless of canonicalization status — the AMM rule applies
only to new etches that opt in.

## The six opcodes

Three core trading opcodes (`T_LP_ADD` `0x2D`, `T_LP_REMOVE` `0x2E`,
`T_SWAP_BATCH` `0x2F`) plus one auxiliary preconfirmation opcode
(`T_INTENT_ATTEST` `0x30`) plus one protocol-fee-withdrawal opcode
(`T_PROTOCOL_FEE_CLAIM` `0x31`) — fully specified in this document.
Plus the per-trade variable-amount AMM swap opcode `T_SWAP_VAR`
(`0x32`), specified in
[`SPEC-SWAP-VAR-AMENDMENT.md`](./SPEC-SWAP-VAR-AMENDMENT.md), which
reuses CXFER N=2 cryptography from `T_AXFER_VAR` (`0x37`) and
shares the pool-state model defined here.

The sections below cover the three core trading opcodes in detail;
the auxiliary opcodes are specified separately under
"## Preconfirmation layer" and "## Protocol fee mechanism" later in
this document, and `T_SWAP_VAR` lives in its own amendment file.

Wire formats are normative in `SPEC.md §5.14–§5.16`. Summary:

**`T_LP_ADD` (`0x2D`)** — Adds liquidity at the current pool ratio.
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
- in-circuit opening of the new LP-share BabyJubJub commitment
  `C_share_BJJ` against `share_amount` and the deterministic
  `r_share_BJJ` (native BJJ via `EscalarMulFix` against pinned NUMS
  bases, ~5K constraints).

The at-the-ratio check and share-formula correctness
(`share_amount = floor(min(Δa·S/R_A, Δb·S/R_B))`) are enforced by
the indexer **out-of-circuit** — both `(Δa, Δb)` and `share_amount`
are public envelope fields, so the indexer recomputes the formula
byte-deterministically (`lpAddShares` / `lpInitShares` in
`tests/amm-clearing.mjs`) and rejects any mismatch. Keeping these
checks out-of-circuit drops the LP_ADD constraint count to ~5K
without weakening soundness: the Groth16 binds the BJJ commitment
to the public `share_amount`, and the indexer pins `share_amount`
to the formula. A malicious LP cannot satisfy both unless they
provide the correct `share_amount`.

A **per-receipt sigma cross-curve proof** (same construction as
the swap path) binds the on-chain `C_share_secp` to the envelope's
`C_share_BJJ`, verified out-of-circuit by indexers.

Generic CXFER kernel sigs are not used here — the mixer-style
construction is more appropriate because each input must net to a
public amount (the published `Δa` / `Δb`), exactly the assertion
`T_DEPOSIT` already makes.

**`T_LP_REMOVE` (`0x2E`)** — Burns `share_amount` of `lp_asset_id`
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
Groth16 proof asserts proportional withdrawal and in-circuit
BabyJubJub openings of both receipt commitments. Two per-receipt
sigma cross-curve proofs (one per leg) bind each on-chain
`C_out_secp` to its envelope `C_out_BJJ`, verified out-of-circuit
by indexers — same construction as the swap path.

**`T_SWAP_BATCH` (`0x2F`)** — Settles N swap intents at one uniform
clearing price in a single reveal transaction (riding on a settler-
funded commit tx per SPEC §5's standard envelope pattern; see
"Commit/reveal layering" under Implementation specification).
Per-trader amounts are confidential; net batch deltas
`(Δa_net, Δb_net)` are public. See
"Cross-asset authorization for swaps" and "Uniform clearing" below
for the authorization mechanism and settlement flow.

### POOL_INIT (sentinel variant of `T_LP_ADD`)

Pool creation reuses opcode `0x2D` with a `variant = 1` sentinel —
the same pattern the mixer uses for `POOL_INIT` (§5.10.1). The init
payload pins `(asset_A, asset_B, fee_bps, vk_cid, ceremony_cid,
min_liquidity, inclusion_arbiter_pubkeys[])` and seeds initial
reserves. Initial **total shares** = `isqrt(Δa · Δb)` (Uniswap V2
convention); the founder receives `isqrt(Δa · Δb) −
MINIMUM_LIQUIDITY` of those shares, and the remaining
`MINIMUM_LIQUIDITY` (V2: 1000 base units) is locked at init via the
construction below. The optional `inclusion_arbiter_pubkeys` field
gates mandatory-inclusion enforcement (see Indexer determinism).
First canonically-ordered confirmed init wins, subject to any
`amm_launcher_pubkey` gate declared by the assets; **no other
privilege governs pool initialization**.

#### MINIMUM_LIQUIDITY burn-output construction

The locked LP-share is a tacit UTXO of `lp_asset_id` — *not* BTC
dust — so "send to NUMS P2WPKH" alone isn't enough. We need both
(a) a Pedersen commitment whose opening anyone can recompute (so
anyone can verify the locked amount is exactly `MINIMUM_LIQUIDITY`),
and (b) a recipient pubkey with no known privkey (so the locked
share can never be CXFER'd out). Two deterministic constructions:

```
r_burn        = SHA256("tacit-amm-min-liq-blind-v1" || pool_id) mod n_secp
amount_ct     = MINIMUM_LIQUIDITY  XOR  HMAC-SHA256(
                                          SHA256("tacit-amm-min-liq-ks-v1" || pool_id),
                                          envelope_anchor)[:8]
C_min_liq     = MINIMUM_LIQUIDITY · H_secp + r_burn · G_secp
NUMS_recipient = (try-and-increment, domain "tacit-amm-min-liq-pubkey-v1" || pool_id)
```

The `NUMS_recipient` is derived by the same try-and-increment as
SPEC §3.1's H-generator: hash `pool_id` under the domain tag,
treat the digest as a candidate x-only secp256k1 x-coordinate,
increment a counter on parse failure. The result is a 32-byte
x-only pubkey with no known privkey. The pool-init reveal tx's
`vout[k]` (for the locked LP-share) MUST be a P2WPKH paying
`HASH160(0x02 || NUMS_recipient_x)`.

Anyone can verify the lock by recomputing `r_burn` and
`C_min_liq` from `pool_id` and checking the on-chain commitment.
The locked share is provably forever unspendable: spending would
require a Schnorr signature under `NUMS_recipient`, which would
require its discrete log, which the NUMS construction makes
infeasible by the same DLP argument that justifies `H_secp` in
SPEC §3.1.

### Cross-asset authorization for swaps

Standard CXFER kernel sigs are single-asset and require *public*
input/output amounts to construct the verifier's expected signing
key. `T_SWAP_BATCH` consumes one asset and emits another with
*hidden* per-trader amounts, so the CXFER mechanism doesn't fit.
Two concerns have to be addressed: per-trader intent authentication,
and consistency between Bitcoin's secp256k1 Pedersen commitments
and the BN254-Fr Groth16 circuit that enforces batch constraints.

**Hybrid commitments (secp256k1 + BabyJubJub).** Tacit asset UTXOs
use secp256k1 Pedersen commitments — load-bearing for Bitcoin
compatibility. Groth16 circuits over BN254-Fr can do **native**
EC arithmetic on **BabyJubJub** (the Edwards curve over BN254 Fr,
shipped in circomlib at ~5–10K constraints per scalar mult). Doing
secp256k1 EC arithmetic inside a BN254 circuit, by contrast, is
non-native and costs ~600K–1M constraints per Pedersen opening —
the trap the original cross-curve design fell into. The AMM avoids
that trap entirely by binding secp256k1 and BabyJubJub commitments
via a **Camenisch-Stadler sigma protocol** (SNARK-free, no trusted
setup, microseconds), then doing all in-circuit work on BabyJubJub
where it's native.

Per intent:

- `C_in_secp = a·H_secp + r_secp·G_secp` is the on-chain Pedersen
  commitment carried by the trader's input UTXO(s) on secp256k1.
  When an intent draws on multiple input UTXOs of the same asset,
  `C_in_secp` is the homomorphic sum `Σᵢ C_in_secp,i` and `r_secp`
  is `Σᵢ r_secp,i`.
- `C_in_BJJ = a·H_BJJ + r_BJJ·G_BJJ` is an auxiliary Pedersen
  commitment on **BabyJubJub** (the embedded curve over BN254 Fr).
  `H_BJJ` and `G_BJJ` are NUMS generators (derivation below).
  Published `vk` for any AMM pool pins them as protocol constants
  alongside circomlib's standard BJJ parameters.

  **BabyJubJub NUMS try-and-increment.** BabyJubJub is the twisted
  Edwards curve `a·u² + v² = 1 + d·u²·v²` over BN254 Fr, with
  `a = 168700` and `d = 168696` (circomlib parameters), cofactor
  8, and prime subgroup order `n_BJJ ≈ 2^251`. For each generator
  derivation seed (`"tacit-amm-bjj-H-v1"` for `H_BJJ`,
  `"tacit-amm-bjj-G-v1"` for `G_BJJ`):

  ```
  counter = 0
  loop:
      digest = SHA256(seed || counter_LE(4))
      u      = digest mod p_Fr                        # candidate u-coordinate
      lhs    = a·u² mod p_Fr                          # left side of Edwards eq
      num    = (1 - lhs) mod p_Fr
      den    = (1 - d·u²) mod p_Fr
      if den == 0: counter += 1; continue
      v_sq   = num · den⁻¹ mod p_Fr
      if v_sq is not a quadratic residue mod p_Fr:
          counter += 1; continue
      v      = sqrt(v_sq); take the root with even least-significant bit
      P      = (u, v)
      Q      = 8 · P                                  # multiply by cofactor
      if Q == identity:  counter += 1; continue       # rare; lands in small subgroup
      if order(Q) ≠ n_BJJ: counter += 1; continue
      generator = Q
      break
  ```

  Reference test vectors (normative for cross-implementation parity;
  any deviation indicates a domain-tag typo, wrong endianness, or
  incorrect sqrt sign rule):

  ```
  H_BJJ counter = 2
  H_BJJ.u = 0x13969c921b0a36e78280a9ff5415b7756761b630fd5fa30d7537e3640cbf6da5
  H_BJJ.v = 0x1553d34ea48b8d61df6de5ca9ae5d95183746714ba21af253a46c18a6c2279e4

  G_BJJ counter = 2
  G_BJJ.u = 0x16b271021d857578ee55d438a32eed9081bfe28579f6e671c87c58a035b49b7b
  G_BJJ.v = 0x2447904d61713ffa77c624c908255001a5f369e2548764cb4adbc6e454ae9884
  ```

  These vectors are the canonical generators — same normative role
  as SPEC §3.1's secp256k1 generator test vectors. Reference
  implementation: `tests/amm-bjj.mjs` (pure-JS BigInt derivation);
  parity suite: `tests/amm-bjj.test.mjs`. Indexers and the dapp
  MUST agree byte-for-byte with these coordinates after running the
  try-and-increment algorithm above; any indexer producing
  different coordinates is broken.
- The intent carries a **sigma cross-curve binding proof** —
  Camenisch-Stadler-style proof of knowledge of `(a, r_secp, r_BJJ)`
  such that the same `a` underlies both `C_in_secp` and `C_in_BJJ`,
  with `a < 2^64` (range-bounded by the standard 64-bit
  bulletproof on `C_in_secp` that tacit already requires for asset
  amounts). The protocol:

  ```
  prover picks    α        uniform in [0, 2^320 − 2^192)  (integer mask)
                  β_secp   uniform in [0, n_secp)         (mod secp256k1 order)
                  β_BJJ    uniform in [0, n_BJJ)          (mod BabyJubJub order)
  prover computes A_secp   = α·H_secp + β_secp·G_secp     (on secp256k1)
                  A_BJJ    = α·H_BJJ  + β_BJJ·G_BJJ       (on BabyJubJub)
  challenge       e        = SHA256("tacit-amm-xcurve-v1"
                                     || C_in_secp || C_in_BJJ
                                     || A_secp || A_BJJ) low-16 bytes
                                                          (e < 2^128)
  responses       z_a      = α       + e·a                (over the integers!)
                  z_r_secp = β_secp  + e·r_secp           (mod n_secp)
                  z_r_BJJ  = β_BJJ   + e·r_BJJ            (mod n_BJJ)
  proof bytes     A_secp(33) || A_BJJ(32) || z_a(40) || z_r_secp(32) || z_r_BJJ(32)
                  = 169 bytes total
  ```

  Verifier reduces `z_a` modulo each group's scalar field (since
  `z_a < 2^320` may exceed `n_secp ≈ 2^256` and certainly exceeds
  `n_BJJ ≈ 2^251`), then checks
  `z_a·H_secp + z_r_secp·G_secp == A_secp + e·C_secp` on secp256k1
  AND `z_a·H_BJJ + z_r_BJJ·G_BJJ == A_BJJ + e·C_BJJ` on BabyJubJub.
  **The same integer `z_a` is sent on the wire and used in both
  equations** — the binding comes from a shared integer response,
  not from `z_a` fitting unreduced in either group's scalar field.
  A cheater wanting to bind one commitment to `a_s` and the other
  to `a_b ≠ a_s` would need to find a single integer `z_a` whose
  modular reductions satisfy two different congruences post-hoc —
  a CRT problem at > 2^128 work given `e < 2^128`.

  **Parameter rationale.** Given `a < 2^64` (range-bounded by the
  standard 64-bit bulletproof on `C_in_secp` that tacit already
  requires) and `e < 2^128`, the product `e·a < 2^192`. To preserve
  ≥ 128-bit statistical zero-knowledge on `a`, the prover
  rejection-samples `α` uniformly in `[0, 2^320 − 2^192)`, giving
  `z_a = α + e·a < 2^320` deterministically (40 bytes BE). The mask
  margin `(2^320 − 2^192) / 2^192 ≈ 2^128` is the statistical-ZK
  bound. The 16-byte (128-bit) Fiat-Shamir challenge gives **128-bit
  Camenisch-Stadler soundness** under standard random-oracle
  assumptions. Reference implementation: `tests/amm-sigma-xcurve.mjs`.

  Cost: **~110 ms prover, ~95 ms verifier** in the reference pure-JS
  implementation (BigInt arithmetic); a production WASM build using
  circomlib's curve primitives drops both an order of magnitude.
  **169 bytes wire.** No trusted setup. No SNARK circuit.
  ~1000× cheaper than the in-circuit secp256k1 non-native gadget
  the original draft assumed.

**Intent authentication is out-of-circuit.** Each intent's
`intent_sig` (BIP-340 over the canonical `intent_msg`) is verified
by the indexer at envelope ingest, not in-circuit. BIP-340
verification is microseconds in native code; in-circuit it would
cost ~2M constraints per sig. This matches the mixer's posture of
keeping expensive secp256k1 checks outside the circuit.

The canonical `intent_msg` MUST commit to (concatenated in this
order, domain-tagged with `"tacit-amm-intent-v1"`):

```
domain_tag                 -- "tacit-amm-intent-v1" (UTF-8)
pool_id                    -- 32 B
direction                  -- 1 B (0 = A→B, 1 = B→A)
input_utxos[]              -- length-prefixed: count u8, then [txid_BE(32) || vout_LE(4)] each
C_in_secp                  -- 33 B (compressed) — aggregate of input UTXO commitments
C_in_BJJ                   -- 32 B (compressed BabyJubJub point) — aux Pedersen commit
xcurve_sigma_proof         -- 169 B (sigma proof binding C_in_secp and C_in_BJJ; see above)
receive_scriptPubKey       -- length-prefixed: count u16_LE, then bytes
min_out                    -- 8 B (u64 LE)
tip_amount                 -- 8 B (u64 LE)
tip_asset                  -- 1 B (0 = asset_A, 1 = asset_B)
expiry_height              -- 4 B (u32 LE)
trader_pubkey              -- 33 B (compressed)
```

The full sigma-proof bytes (not a hash of them) are carried inline:
the proof is small enough (169 B) that committing the hash would
buy nothing and would force a separate fetch path.

`intent_id = sha256(intent_msg)` is what the canonical-ordering
rule sorts on (`vin[1+i]` and `vout[1+i]` MUST appear in
`intent_id` ascending byte-order; see Indexer determinism).

**Batch proof: native BabyJubJub work, no in-circuit secp256k1.**
With the sigma-protocol cross-curve binding above, the settler's
Groth16 batch proof never has to do non-native secp256k1 EC
arithmetic. All in-circuit commitment openings happen on
BabyJubJub, where they cost ~5–10K constraints each. The proof
asserts:

- **Per-intent input opening (BabyJubJub).** For each trader `i`,
  knowledge of `(amount_in_swap_i, tip_amount_witness_i, r_in_BJJ_i)`
  such that `C_in_BJJ_i = (amount_in_swap_i + tip_amount_witness_i)
  · H_BJJ + r_in_BJJ_i · G_BJJ`, with `tip_amount_witness_i`
  equality-bound to the public per-intent `tip_amount_i` (which the
  trader's `intent_sig` covers via `intent_msg`). Native in-circuit
  BabyJubJub via `EscalarMulFix` against the pinned NUMS bases;
  ~5K constraints per opening (fixed-base is ~5× cheaper than the
  variable-base `escalarmulany` the original draft costed).
- **Per-trader fills at the uniform clearing price `P_clear`.** The
  circuit derives `P_clear_num` / `P_clear_den` in-circuit from
  private aggregates `X = Σ_{direction=0} amount_in_swap_i` and
  `Y = Σ_{direction=1} amount_in_swap_i`, plus the public envelope
  delta magnitudes and reserves:
  - A-dom (`delta_A_net_sign = 0`, non-spot): `P_clear_num = X`,
    `P_clear_den = Y + |Δb_net|`
  - B-dom (`delta_A_net_sign = 1`, non-spot): `P_clear_num = X + |Δa_net|`,
    `P_clear_den = Y`
  - Spot (both magnitudes 0, sign bits canonicalized to 0):
    `P_clear_num = R_A_pre`, `P_clear_den = R_B_pre`

  Then per trader:
  - `amount_out_i = ⌊amount_in_swap_i · P_clear_den / P_clear_num⌋`
    for an A→B trader (input A, receipt B)
  - `amount_out_i = ⌊amount_in_swap_i · P_clear_num / P_clear_den⌋`
    for a B→A trader (input B, receipt A)

  Enforced via the division-with-remainder pattern
  `amount_in_swap_i · multiplier === amount_out_i · divisor + rem_i`
  with `rem_i < divisor_i` (`LessThan(70)` plus explicit `Num2Bits(70)`
  on both operands, sized for worst-case ~2^68 aggregates per the
  pre-ceremony review). The X/Y-based formulation is what makes
  the chain-side aggregate Pedersen identity balance **exactly**
  — the delta-only ratio `|Δb|/|Δa|` is equivalent in real
  arithmetic but diverges under integer floor for multi-trader
  batches (which the indexer would then reject).
- **Per-receipt output opening (BabyJubJub).** Each receipt
  commitment `C_out_BJJ_i = amount_out_i · H_BJJ + r_out_BJJ_i ·
  G_BJJ` is opened in-circuit against the derived `amount_out_i`
  and the trader's deterministic `r_out_BJJ_i` (see "Receipt
  recovery" below). ~5K constraints per opening.
- Each `amount_out_i ≥ min_out_i` via `GreaterEqThan(64)`.
- Range proofs (`Num2Bits(64)`) on every per-trader amount —
  `amount_in_swap`, `tip_amount_witness`, `amount_out`, and the
  Pedersen-opening internal range checks compose to bound the
  combined inputs into u64.

**Per-receipt cross-curve binding moves to a sigma proof.** The
output-side binding that was previously in-circuit (the
load-bearing fix preventing a malicious settler from shuffling
which receipt secp commitment belongs to which trader) is now a
sigma proof per receipt, generated by the settler using the
trader-supplied `(amount_out, r_out_secp, r_out_BJJ)` from the
opening blob. Each per-receipt sigma proof is 169 bytes,
microseconds to produce and verify. Indexers verify all per-intent
and per-receipt sigma proofs out-of-circuit alongside the chain-
side aggregate Pedersen check. The four-way binding chain is:

1. Per-intent sigma proof binds chain `C_in_secp` to envelope
   `C_in_BJJ` (same `a_in`).
2. Per-receipt sigma proof binds chain `C_out_secp` to envelope
   `C_out_BJJ` (same `a_out`).
3. Groth16 batch proof binds envelope `C_in_BJJ` and `C_out_BJJ`
   to in-circuit `a_in` / `a_out` via native BJJ openings, and
   binds `a_out` to `a_in` via the clearing-price arithmetic.
4. Chain-side aggregate Pedersen check on secp256k1 binds the
   batch totals to `Δ_net`.

Together these close the soundness loop — individual amounts bound
to individual chain commitments, batch totals bound to declared
deltas, all without any in-circuit secp256k1 EC work.

**Total batch-proof constraint count for N inputs + N receipts (empirical,
post-hardening):** `172,158` constraints at `N_MAX = 16` (164,476
non-linear + 7,683 linear), well under the original 300K projection
because fixed-base `EscalarMulFix` per Pedersen opening is ~5×
cheaper than the variable-base `escalarmulany` the original draft
costed. Per-N scaling is roughly `2N × 5K (BJJ openings) + 2N × small
(range proofs + division-with-remainder) + ~5K (global checks +
P_clear derivation)`. Anticipated browser proving time ~5–10s on a
modern laptop, ~30s on mid-range mobile (pending empirical benchmark
once Phase 1 ptau is downloaded; see "Benchmarking methodology + pass
criteria"). The footprint is **comparable to the mixer's withdraw-
proof cost** rather than 10× larger as the original draft assumed.

The v1 cap `N ≤ 16` was originally driven by the per-receipt
non-native gadget cost. With native BJJ openings, the cap is
governed by **Bitcoin tx vbyte budget + sigma-proof wire size**
instead: each receipt adds ~169 B sigma + ~32 B BJJ commit + ~33 B
secp commit ≈ 230 B per receipt. N=64 stays well under standard tx
size; N=128 fits if the envelope is segmented across PUSHDATA
chunks. v1 retains `N ≤ 16` as a UX latency cap (settler has to
collect 16 RTT-2 signatures within a few seconds), not a circuit
constraint; v2 deployments can push higher.

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
  `r_out_secp` and `r_out_BJJ` from the deterministic
  Receipt-recovery formula and returns the encrypted opening
  blob (5 fields, see below).
- **Settler computes.** The settler decrypts openings, runs the
  deterministic clearing solve, derives `amount_out_i` for each
  trader, and computes `C_out_secp_i = amount_out_i · H +
  r_out_secp_i · G`. If any trader's `amount_out_i` failed
  `min_out_i`, the settler drops them and re-iterates (which may
  require re-soliciting openings if the subset changed).
  **Critically, the settler generates the Groth16 batch proof
  here** — using openings as private witness and the per-trader
  commitments + public deltas as public input. Only then does the
  settler assemble the **complete** envelope payload (including
  the proof bytes) and compute `envelope_hash =
  sha256(envelope_payload-with-proof)`. The hash MUST cover the
  proof, otherwise a settler could generate a fresh proof after
  signing and the broadcast envelope would not match what traders
  signed against.
- **RTT 2 — sig collection.** The settler forwards the assembled
  PSBT (including `vout[0] = OP_RETURN(envelope_hash)`) to each
  included trader's dapp. Each dapp validates locally: `min_out`,
  `tip`, `expiry`, receipt `scriptPubKey`, derived `amount_out_i`
  against the public deltas, and `envelope_hash` matching the
  assembled payload (including the embedded proof). On pass, it
  auto-signs `SIGHASH_ALL` over its trader's input — no
  confirmation prompt — and returns the sig.
- **Settler broadcasts.** With all sigs collected, the settler
  splices them into the tx and broadcasts. The proof is already
  inside the envelope; nothing about the envelope changes between
  trader sig and broadcast.

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
 r_in_secp,    -- trader's existing input UTXO blinding (secp256k1 scalar)
 r_in_BJJ,     -- trader-chosen blinding for C_in_BJJ (BabyJubJub scalar)
 r_out_secp,   -- deterministic per-receipt secp blinding (see Receipt recovery)
 r_out_BJJ)    -- deterministic per-receipt BJJ blinding (see Receipt recovery)
```

— enough material for the settler to compute `C_out_secp` and
`C_out_BJJ` for the trader's receipt, populate the per-asset
aggregate `R_net` in the envelope, generate the per-receipt sigma
cross-curve proof, and supply the witness inputs (`a, r_BJJ`) for
the BabyJubJub Pedersen openings in the in-circuit batch proof. This blob is **not** held by the worker. The trader's
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
input. Tacit-layer consumption is jointly authorized by:

- `intent_sig` (out-of-circuit, BIP-340),
- the per-intent sigma cross-curve binding proof (out-of-circuit,
  trader-paid at intent-post),
- the per-receipt sigma cross-curve binding proof (out-of-circuit,
  settler-generated using the trader's opening blob),
- the Groth16 batch proof (BN254, settler-paid, in-circuit
  BabyJubJub openings + clearing arithmetic + range bounds),
- the aggregate Pedersen check (secp256k1, indexer-checked).

Bitcoin-layer consumption is the `SIGHASH_ALL` signature above,
bound to `envelope_hash` via `vout[0]` `OP_RETURN`.

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
BabyJubJub-Pedersen `C_in_BJJ`), a 169-byte sigma cross-curve
binding proof, `min_out`, `tip`, `input_utxos` references,
receive script, `expiry`, and a per-intent `intent_sig` under
`trader_pubkey`. The full opening blob
`(amount_in, r_in_secp, r_in_BJJ, r_out_secp, r_out_BJJ)` —
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
   never the cleartext amount, which is hidden by both Pedersen
   commitments). Subset must include all qualifying intents if the
   pool pins an arbiter.

2. **RTT 1 — opening collection.** Settler sends each included
   trader (via the worker websocket) the candidate composition
   `(included_intent_ids, settler_pubkey, vin[0].outpoint,
   trader's vout_index)`. Each trader's dapp validates the
   composition is sane, derives `r_out_secp` and `r_out_BJJ`
   from the deterministic Receipt-recovery formula against
   `recipient_anchor_outpoint = trader_input_outpoint`, and
   returns the full opening blob `(amount_in, r_in_secp,
   r_in_BJJ, r_out_secp, r_out_BJJ)` encrypted to
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
   `r_out_secp_i`).

5. **Settler generates the Groth16 batch proof** using the
   collected openings as private witness and the per-trader
   commitments + public deltas as public input. The proof is
   computed here, not after sig collection — the envelope_hash
   over which traders sign MUST cover the actual proof bytes,
   otherwise a settler could swap the proof post-sign and the
   broadcast envelope would not match what traders signed.

6. Settler assembles the **complete** `T_SWAP_BATCH` envelope
   payload — per-receipt commitments, public deltas, per-asset
   `R_net`, **and the Groth16 proof from step 5** — and computes
   `envelope_hash = sha256(envelope_payload-with-proof)`.

7. Settler builds the candidate Bitcoin tx with the normative
   layout (see Indexer determinism): `vin[0]` envelope-bearing
   settler input; `vin[1+i]` trader inputs in `intent_id`
   ascending byte-order; `vout[0] = OP_RETURN(envelope_hash)`;
   `vout[1+i]` trader receipt outputs at matching indices;
   `vout[N+1]` aggregated settler tip; optional `vout[N+2]`
   settler BTC change. All settler funding inputs, output
   amounts, sequences, locktime, and fee selection MUST be final
   at this point; any subsequent change forces a full re-sign
   round (RBF / fee-bump is not free under `SIGHASH_ALL`).

8. **RTT 2 — sig collection.** Settler forwards the assembled
   PSBT to each included trader's dapp via the worker websocket.
   Each dapp validates locally: (a) `min_out`, `tip`, `expiry`,
   receipt `scriptPubKey` match its trader's intent; (b) derived
   `amount_out_i` from public deltas matches; (c) `vout[0]` data
   equals `sha256(envelope_payload)` against the assembled
   payload (including the embedded proof); (d) the trader's
   input is at the expected `vin` index. On pass, it auto-signs
   `SIGHASH_ALL` over its trader's input — no confirmation
   prompt — and returns the sig.

9. On full sig set, settler splices sigs into the tx and
   broadcasts. The envelope (including proof) is already final;
   nothing changes between trader sig and broadcast.

The two RTTs both ride the worker websocket and complete in a
few seconds end-to-end under normal conditions. Total per-batch
latency from settler claim to broadcast is bounded by the slowest
trader's response in either RTT plus the settler's batch-proof
generation time (~5–10s for `N = 16` on a modern laptop, per
"Batch proof: native BabyJubJub work").

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

**Single-batch sig discipline (normative dapp rule).** The trader
dapp MUST NOT auto-sign two PSBTs whose `vin` sets overlap on the
same trader-owned outpoint within the same block window. The dapp
maintains a per-block reservation map keyed by `(outpoint,
target_block_height)`: when one settler's RTT-2 PSBT is signed,
the included outpoints are locked until either (a) the settler
broadcasts and the tx confirms or rejects, or (b) the
`expiry_height` is crossed without confirmation. Concurrent RTT-2
PSBTs from competing settlers reach the same outpoint find it
reserved and the dapp refuses to sign — the second settler must
wait for the first to resolve. This is a dapp-side rule, not an
indexer rule (the indexer already rejects double-spends at
Bitcoin-consensus level), but it eliminates wasted settler proof
work and protects traders from accidentally signing a batch their
worker routed to a stale settler.

**Settler abandon-after-K-rounds rule (normative settler rule).**
If a settler's batch construction must re-sign because one or
more included traders fail to return `SIGHASH_ALL` within
`AMM_RTT_TIMEOUT_MS = 5000` (a normative default), the settler
MAY re-solicit at most `AMM_RESIGN_ATTEMPTS = 2` additional times,
shrinking the included subset each round to exclude any
non-responsive trader. After the third combined attempt the
settler MUST abandon the batch and forward all unresponsive
trader intents to the next block's open pool (they remain valid
until `expiry`). This prevents pathological re-sign loops where
a flaky trader keeps every other trader's signature stale across
many rounds. `AMM_RTT_TIMEOUT_MS` and `AMM_RESIGN_ATTEMPTS` are
operational settler knobs; the values above are recommended
defaults the reference settler ships with.

**Settler economics.** Each intent specifies a `tip` value and
`tip_asset` (either of the pool's two assets). The settler
aggregates tips into one tip output and pays the Bitcoin tx fee
from their own BTC inputs, recouping via the tip mechanism.
Permissionless — any tacit user with a chain view + intent-pool
read can become a settler.

**Fee-market sensitivity.** The settler's Bitcoin cost has two
components: a ~150-vbyte commit tx and a reveal tx whose vbyte
count scales linearly in `N`. For a `T_SWAP_BATCH` envelope of
size `E` bytes (mostly witness data), the reveal tx is roughly
`E / 4 + 100` vbytes (witness data at the 1:4 discount plus
~100 vbytes of non-witness header + outputs). Concrete budget at
several batch sizes (envelope per "Envelope byte layouts"):

| N (intents) | envelope size | reveal vbytes | total vbytes (commit + reveal) | cost @ 10 sat/vB | cost @ 50 sat/vB |
|---|---|---|---|---|---|
| 1  | ~830 B  | ~310  | ~460  | ~4,600 sat   | ~23,000 sat  |
| 4  | ~2.5 KB | ~720  | ~870  | ~8,700 sat   | ~43,500 sat  |
| 8  | ~4.8 KB | ~1,300| ~1,450| ~14,500 sat  | ~72,500 sat  |
| 16 | ~9.5 KB | ~2,500| ~2,650| ~26,500 sat  | ~132,500 sat |

At BTC ≈ $100K, a busy-mempool 50-sat/vB N=16 batch costs the
settler ~$130. A trader's minimum viable tip therefore scales
with both `N` and the mempool fee rate:

```
min_tip_per_trader_btc_value ≈ total_vbytes · sat_per_vbyte / N
```

For thin pools (`N` small) at high fees, the minimum viable tip
per trader can spike above what casual swappers will pay,
collapsing settler economics for those pools. Settlers manage
this by (a) batching across blocks when fees spike (delays
inclusion but reduces per-batch fee per trader), (b) refusing
batches whose total tip aggregate falls below a settler-set
minimum (a `min_total_tip_btc_value` threshold), and (c) using
RBF on the commit tx (allowed; doesn't invalidate the reveal as
long as the commit's outpoint is unchanged) to start at a lower
fee rate and bump as needed before reveal signs.

**Tip denomination.** Tips are denominated in tacit-asset units,
not BTC sats. A settler converting tip revenue to BTC for fee
recoupment must price the conversion themselves; a settler-side
oracle (e.g., "1 cBTC = 1 BTC", "1 USDC = 1 USDC at market") or
arbitrage via the same AMM is how tip-to-BTC conversion happens
in practice. The protocol does not specify the conversion path;
settlers compete on tip-conversion efficiency.

**No tip-based MEV.** Intent ordering within a batch is by
`intent_id` ascending, not by tip. A high tip does not buy
priority within a batch — pricing is uniform clearing for
everyone in the batch. Tips only buy *inclusion* across batches:
a settler picking a candidate subset has an economic incentive
to maximize aggregate tip, which means including all intents
whose `min_out` is satisfiable. This is the protocol's primary
defense against settler curation MEV in pools without an
inclusion arbiter.

**Deterministic clearing solve.** v1 specifies an **exact-output**
clearing rule, not an inequality with slack. The solve takes only
quantities **known up front**: the included subset's per-trader
gross **inputs** (which the settler decrypted from RTT-1 opening
blobs). Receipts are derived from the solve; they are not solve
inputs.

Define:

```
X = Σ amount_in_i  over A→B traders   (gross A input)
Y = Σ amount_in_i  over B→A traders   (gross B input)
γ = (10000 − fee_bps) / 10000          (fee multiplier)
P_spot = R_A / R_B                     (pool's pre-batch spot ratio)
```

The clearing price `P_clear` (units: A per B) is the unique
non-negative root of the CFMM equation given `(X, Y, R_A, R_B, γ)`,
recomputed byte-identically by every indexer:

- **A→B-dominant batch** (`X > Y · P_spot`): net A enters the
  pool, net B leaves. Solve for `P_clear` such that the
  net-residual matches the curve:
  ```
  Δa_net  = X − ⌊Y · P_clear⌋        (positive, A into pool)
  Δb_net  = R_B · γ · Δa_net / (R_A + γ · Δa_net)
  Δb_net == ⌊X / P_clear⌋ − Y         (positive, B out of pool)
  ```
  Specified canonically as a **bounded integer binary search** on
  `P_clear` over `[P_spot, P_spot · (X / max(1, Y))]` (or
  `[P_spot, X · 2⁶⁴]` when `Y = 0`). All multiplications in u128;
  all divisions floor toward the pool. Convergence is guaranteed
  in `≤ 64` iterations. The indexer-canonical algorithm pinned in
  `SPEC.md §11` fixes the bracket-update rule, halt condition, and
  floor-rounding direction byte-for-byte.

  Final values: `Δa_net = X − ⌊Y · P_clear⌋`,
  `Δb_net = ⌊R_B · γ · Δa_net / (R_A + γ · Δa_net)⌋`. New
  reserves: `R_A' = R_A + Δa_net`, `R_B' = R_B − Δb_net`.

- **B→A-dominant batch** (`Y · P_spot > X`): symmetric. Net B
  enters the pool, net A leaves. Solve in
  `[P_spot · (X / max(1, Y)), P_spot]` (or `[0, P_spot]` when
  `X = 0`). Final: `Δb_net = Y − ⌊X / P_clear⌋`,
  `Δa_net = ⌊R_A · γ · Δb_net / (R_B + γ · Δb_net)⌋`. New reserves:
  `R_A' = R_A − Δa_net`, `R_B' = R_B + Δb_net`.

- **Spot-clearing (zero-residual) batch**: when the binary search
  converges to `Δa_net = 0` AND `Δb_net = 0` (intents exactly
  cancel at `P_clear = P_spot` within deterministic rounding),
  reserves are unchanged and no fee is charged. Trader receipts
  use `P_clear = P_spot`. This is the precise definition of "zero
  net" — it falls out of the solve, not a separate input case.

- **Degenerate-empty batch** (`N = 0`): forbidden; indexers reject
  any `T_SWAP_BATCH` envelope with no included intents.

**Per-trader fills.** Once `P_clear` is solved, every A→B trader
receives `amount_out_i = ⌊amount_in_i / P_clear⌋` (in B), every
B→A trader receives `amount_out_i = ⌊amount_in_i · P_clear⌋` (in
A). All floor-rounding favors the pool; truncated dust accrues as
fee-revenue to LPs (bounded above by `N` base units per batch).

The result `(Δa_net, Δb_net, P_clear)` is **the** answer the
indexer expects. Envelopes whose declared deltas differ from the
indexer's re-derived solve at the post-prior-batch reserves — by
even one base unit — are rejected. There is no settler freedom in
pricing, only in subset selection.

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
`P_clear` exactly as specified in "Batch proof: native BabyJubJub
work, no in-circuit secp256k1" above; floor-rounding
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
| `vout[N+1]` | Aggregated asset-A tip — a tacit UTXO holding the sum of all per-intent `tip_amount` values where `tip_asset == A`, dust-value at Bitcoin layer with the aggregate tip Pedersen commitment in the envelope payload. |
| `vout[N+2]` | Aggregated asset-B tip — symmetric. Present iff either aggregate is nonzero; if exactly one asset's aggregate is zero the corresponding output is omitted (and its envelope-recorded `tip_X_amount_LE == 0`). Both omitted only when every intent in the batch set `tip_amount = 0`. |
| `vout[N+2..]` or `vout[N+3..]` | Optional settler BTC change (index depends on how many tip outputs are present). |

See §"1. Envelope byte layouts" for the authoritative per-asset
tip mechanic — tips are per-trader-chosen-asset, aggregated per-asset
at settlement, producing zero, one, or two `tip_*_amount` outputs.

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

**Reorg handling for arbiter pools.** The `qualifying_set_hash` +
`arbiter_sig` in a `T_SWAP_BATCH` are cryptographic commitments
over `(pool_id, expected_height, list_hash)`. The signature is
**height-bound but reorg-stable**: it doesn't matter whether the
batch eventually confirms at `expected_height` or at a shifted
height after a reorg — the arbiter's claim "these intents were
canonical at expected_height" is a historical statement, not a
prediction. Concretely:

- If the batch confirms at exactly `expected_height` with no
  reorg, indexer crediting at depth-3 runs the deterministic
  qualifying-intent computation against the chain state at
  `expected_height` and verifies the listed intents match.
- If the batch confirms at a different height (e.g., mining was
  slow, no reorg), indexer still uses `expected_height` from the
  envelope as the reference height for the qualifying computation.
  The arbiter's signature is over that height; the indexer's
  determinism check is against that height.
- If the chain reorgs between broadcast and depth-3 crediting,
  the batch's expected_height may now point to a different chain
  state than originally signed. The indexer re-runs the qualifying
  computation against the new canonical chain at `expected_height`.
  If the new canonical chain at H makes a different intent set
  qualifying, the previously-signed list may now be wrong (missing
  intents that newly qualify, or including intents whose UTXOs
  were reorged out). The batch becomes invalid and the settler
  must re-broadcast with a fresh arbiter signature.

**The arbiter does NOT need to re-sign on every reorg.** Their
signature is purely an attestation of "I observed this set at
this height under this chain"; the indexer's verification is the
authoritative reconciliation. Arbiter liveness during reorgs is
only required if settlers want to immediately re-broadcast a
reorged batch — otherwise the next block's normal flow resumes
with the next height's freshly-signed list. The arbiter is a
data attestor, not a chain participant.

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

**On-chain commitment to the canonical list.** For arbiter-pinned
pools, every `T_SWAP_BATCH` envelope MUST carry two extra fields:

```
expected_height      -- 4 B   u32 LE, equals settle height
qualifying_set_hash  -- 32 B  sha256("tacit-amm-qset-v1" || pool_id
                                      || height_LE(4) || canonical_list_bytes)
m                    -- 1 B   u8, threshold (1..16), MUST equal
                              pool.inclusion_arbiter_threshold_m
signer_indices       -- m B   u8[m] ascending distinct indices into
                              pool.inclusion_arbiter_pubkeys
arbiter_sigs         -- 64m B BIP-340 sigs over qualifying_set_hash,
                              one per signer_index, in the same order
```

`canonical_list_bytes` is the sorted, length-prefixed concatenation of
the qualifying `intent_id`s for that height:
`u8(count) || count × intent_id(32)`, `intent_id`s in ascending byte
order. Count is bounded by N_MAX (=16 in v1). The hash + sigs commit
the chain to *which* list was canonical at H; the list bytes themselves
remain off-chain, served by the worker at
`GET /pools/:pool_id/qualifying-intents/:height`. Indexers verify all
`m` `arbiter_sigs` against `pool.inclusion_arbiter_pubkeys[signer_index]`,
fetch the list by its hash from any available source (worker, peer
indexer, archival pin), and reject the envelope if any listed
`intent_id` is missing from the batch.

The commitment closes the worst arbiter abuse: an arbiter cannot sign
one list off-chain and then claim a different list was canonical
later. Indexers that disagree about list contents reach the same
accept/reject verdict because the hash they're each checking against
is the same on-chain value. The residual off-chain dependency is
narrower than before — it's "fetch the list bytes by their hash,"
not "trust whatever the worker serves." Content-addressed retrieval
plus signature verification means any indexer with the bytes reaches
the canonical answer.

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
where curation profit could become material.

**Trust shape: m-of-n threshold.** The arbiter is a true m-of-n
threshold: the pool pins `n ≤ 16` arbiter pubkeys at `POOL_INIT`
plus a threshold `m ∈ [1, n]`. Every arbiter-pinned envelope carries
`m` BIP-340 signatures (each from a distinct pinned key, identified
by ascending `signer_index`), all over the same `qualifying_set_hash`.
Indexers verify all `m` signatures against the declared signer
pubkeys before accepting the envelope.

`m = 1` is the lightest setup — any one of `n` keys can sign. Good
for high-availability pools that want operator diversity for liveness;
*not* a Byzantine-fault-tolerance posture (any single compromised key
can curate). `m = 2..n` is the BFT-shape: requires a coalition to
curate, defends against single-key compromise. Typical high-volume
deployments pick `m ≥ ⌈n/2⌉ + 1` or `m = 2` for a small `n = 3` quorum.

Pools that pin a single key (`n = m = 1`) are explicitly fragile —
a lost or compromised key kills mandatory-inclusion enforcement for
that pool — and the dapp SHOULD warn at pool-creation time if `n = 1`.

**MuSig2 as a compact-sig usage pattern (no protocol change).** Pool
launchers who want a k-of-n threshold quorum WITHOUT growing the
envelope linearly in `m` can use MuSig2 (BIP-327) off-chain:

1. The quorum runs MuSig2 KeyAgg over their n individual keys to
   produce a single aggregated pubkey.
2. The pool pins `(n=1, threshold_m=1, pubkeys=[aggregated_musig2_key])`
   at `POOL_INIT`.
3. To sign a `qualifying_set_hash`, the quorum runs the MuSig2 two-round
   nonce-coordination + partial-sig protocol off-chain and produces a
   single 64-byte BIP-340 signature under the aggregated key.
4. On chain, the envelope's arbiter_block carries this single signature
   under the 1-of-1 wire format. The indexer's standard BIP-340 check
   accepts it.

Trade-off: MuSig2 requires interactive nonce coordination among the
quorum signers (off-chain); the m-of-n separate-sig path is
non-interactive but grows wire size linearly in `m`. Both are
supported by the same on-chain wire format.

Default pools (no arbiter pinned) are the right v1 starting point
and what the dapp creates by default. Pinning an arbiter is a
deliberate choice the pool founder makes to delegate one specific
MEV defense to a quorum, in exchange for the off-chain data
dependency described next.

**Trade-off vs. L1-only reconstruction.** Mandatory-inclusion
enforcement is the one place this protocol references data outside
the Bitcoin chain, but the on-chain `qualifying_set_hash` +
`arbiter_sig` commitment narrows that dependency to **content
addressing**, not trust. An indexer with only confirmed L1 envelopes
can verify (a) the arbiter signature, (b) what list-hash was
canonical at H. To check (c) "did the settler honor that list,"
the indexer additionally needs the list bytes — but they're
content-addressed by the chain-committed hash, so any source (worker,
peer indexer, archival pin, gossip) returning the right bytes is
indistinguishable from any other. Indexers that disagree about list
contents reach the same accept/reject verdict because they're all
checking against the same on-chain hash.

Pools that pin no `inclusion_arbiter_pubkey` keep zero off-chain
dependency at the cost of weaker cross-batch MEV resistance; pools
that pin one gain MEV resistance at the cost of needing access to
the list bytes (not trust in their source). This is the strongest
mandatory-inclusion guarantee achievable without smart-contract
enforcement at L1 — the arbiter is bounded to picking the list at
sign time and cannot rewrite history afterwards.

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
can run their own indexer **from chain data alone** — validation
is fully chain-local. Running a settler additionally requires
access to the intent-relay layer (worker websocket, Nostr, or
direct trader↔settler messaging) so that openings and sigs can
be exchanged with traders during the two-RTT settlement flow.

**Worker is a message relay, not an escrow or privacy
intermediary.** Under v1's interactive PSBT signing, per-trader
opening blobs `(amount_in, r_in_secp, r_in_BJJ, r_out_secp,
r_out_BJJ)` are encrypted directly by the trader's dapp to the
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

**Default-deployment trust posture (v1).** Distinct *protocol*
roles do not imply distinct *operators*. Soundness (no rug, no
inflation, no burn-grief) is cryptographically enforced regardless
of who runs the worker or settler. But **privacy** depends on
operator separation: the claiming settler decrypts per-trader
opening blobs for its batch, so any operator running both the
worker and the default settler observes every routed trader's
cleartext amount. v1 ships a centralized worker (`worker/src/`)
that doubles as the default settler in the reference dapp's
"automatic" route. Privacy-conscious traders MUST either (a) pick
a settler distinct from the worker operator via the dapp's
"choose settler" flow, (b) self-host both a worker and a settler,
or (c) wait for the v2 multi-settler discovery layer. The dapp
SHOULD surface the operator identity of the chosen settler at
intent-post time and warn if it matches the worker. This caveat
applies only to per-trader *amount* privacy — soundness against
the worker-and-settler-collocated operator is unchanged (they
cannot cheat trader funds, only observe per-trader amounts inside
batches they claim).

**Cryptographic strength.** All primitives sit at ≥ ~100 bits:
BIP-340 (≈ 128), Pedersen binding under DLP (≈ 128 secp256k1, ≈ 125
BJJ prime subgroup), Groth16 over BN254 (≈ 100–110 with knowledge
soundness in the AGM, standard for production Groth16), bulletproofs
(≈ 128), and the sigma cross-curve binding (128-bit Fiat-Shamir
soundness with ≈ 128-bit statistical ZK margin, see "Parameter
rationale" under Hybrid commitments). The shared-integer `z_a`
design lets the sigma binding achieve symmetric 128-bit security
without the constraint that `z_a` fit unreduced in
`min(n_secp, n_BJJ) ≈ 2^251` — each curve's scalar multiplication
reduces internally, and the binding survives because a cheating
prover would need to satisfy two different congruences post-hoc on
a single wire integer (a CRT problem at > 2^128 work). The weakest
primitive is Groth16 knowledge-soundness at the AGM ~100–110-bit
level; the rest sit at ≥ 128 bits.

## Soundness chain (per opcode)

For each of the three core AMM opcodes (`T_LP_ADD`, `T_LP_REMOVE`,
`T_SWAP_BATCH`), the protocol binds an on-chain
secp256k1 Pedersen commitment to a hidden u64 amount through a chain
of primitives. This subsection traces every link in that chain,
naming exactly which check closes which attack vector. Every
attack-vector category covered here has an adversarial test in
`dapp/circuits/amm/adversarial-test.mjs` confirming the constraint
actually rejects the cheat (25 cases at time of writing).

### T_LP_ADD

```
chain UTXO C_share_secp                                  (33-byte compressed Pedersen on secp256k1)
       ↓ verified by
sigma cross-curve binding (§3.10, 169 B)                 (out-of-circuit, indexer-verified)
       ↓ binds to same hidden `a` as
envelope C_share_BJJ                                     (32-byte packed BJJ point)
       ↓ opened by
Groth16 in-circuit PedersenBJJ                           (amm_lp_add.circom line ~77, openShare component)
       ↓ proves equality with
public share_amount                                      (in envelope payload + public-input vector)
       ↓ verified against
indexer share-formula check (lpAddShares / lpInitShares) (out-of-circuit, deterministic)
       ↓ derived from
pool reserves R_A, R_B, S_pre                            (indexer-tracked virtual quantities;
                                                          R_A and R_B feed the Groth16 public
                                                          signals vector, S_pre is checked
                                                          out-of-circuit by the indexer and is
                                                          NOT in the 123-signal public vector
                                                          — see optimization note in §"Groth16
                                                          public-input vector")
```

Asset-side balance (one chain per asset X ∈ {A, B}):

```
trader's asset-X input UTXOs                             (chain Pedersen commitments)
       ↓ summed and
kernel signing key (Σ C_in_X − Δx · H_secp).x_only()    (§5.14 kernel_msg_X)
       ↓ Mimblewimble balance: signable iff
excess_X = Σ r_in_secp,X,i AND consumed inputs sum to Δx·H
       ↓ verified by
BIP-340 kernel_sig_X (envelope payload)
```

POOL_INIT variant additionally binds:

```
asset metadata blob (IPFS CID-pinned at etch)
       ↓ canonicalized via
JCS (RFC 8785, tests/amm-jcs.mjs)
       ↓ extracts
optional tacit_amm_launcher field
       ↓ if present, gates
launcher_sigs verification (BIP-340 over launcher-gate msg)
       ↓ which the indexer verifies before accepting POOL_INIT
```

And the MINIMUM_LIQUIDITY locked output (§"MINIMUM_LIQUIDITY burn-output construction"):
the indexer recomputes `r_burn`, `C_min_liq`, `NUMS_recipient` from pool_id alone and verifies the on-chain vout[1] matches byte-for-byte.

### T_LP_REMOVE

Two parallel chains (one per asset side):

```
chain receipt UTXO (recv_A_secp, recv_B_secp)
       ↓ sigma cross-curve binding (per receipt)
envelope BJJ commitments (recv_A_BJJ, recv_B_BJJ)
       ↓ Groth16 openings (amm_lp_remove.circom openA, openB components)
public delta_A, delta_B
       ↓ indexer formula check (lpRemoveOutputs)
proportional withdrawal: delta_X = floor(R_X · share_amount / S)
```

LP-share input balance:

```
consumed lp_asset_id UTXO(s)                             (each is Pedersen on chain)
       ↓ kernel signing key (Σ C_in_LP − share_amount · H_secp).x_only()
kernel_sig_LP proves Σ r_in == excess AND inputs sum to share_amount · H
       ↓ verified BIP-340
binds share_amount to consumed value
```

### T_SWAP_BATCH

The most intricate chain. For each trader `i` in the batch:

```
trader's chain input UTXO(s) C_in_secp,i                 (33-byte compressed Pedersen, possibly aggregated)
       ↓ verified by
sigma cross-curve binding C_in_secp ↔ C_in_BJJ           (per-intent, 169 B, out-of-circuit)
       ↓ binds same hidden `a_in_total` as
envelope C_in_BJJ_i
       ↓ Groth16 in-circuit PedersenBJJ opening          (amm_swap_batch.circom openIn[i])
       ↓ enforces
a_in_total === amount_in_swap_i + tip_amount_witness_i   (in-circuit addition + sum range check)
       ↓ AND
tip_amount_witness_i === tip_amount_i (public)           (in-circuit direct equality)
       ↓ where tip_amount_i is bound by
trader's intent_sig (BIP-340 over intent_msg)            (out-of-circuit at envelope ingest)
```

Then the per-trader fill chain:

```
amount_in_swap_i (private, in-circuit)
       ↓ via in-circuit division-with-remainder constraint
amount_in_swap_i · multiplier_i === amount_out_i · divisor_i + rem_i;  rem_i < divisor_i
       ↓ where multiplier_i, divisor_i are direction-multiplexed:
direction = 0:  multiplier = P_clear_den, divisor = P_clear_num
direction = 1:  multiplier = P_clear_num, divisor = P_clear_den
       ↓ and P_clear is derived in-circuit from private aggregates:
X_sum = Σ_{direction=0} amount_in_swap_i
Y_sum = Σ_{direction=1} amount_in_swap_i
A-dom (delta_A_net_sign = 0, non-spot): P_clear_num = X_sum, P_clear_den = Y_sum + |Δb_net|
B-dom (delta_A_net_sign = 1, non-spot): P_clear_num = X_sum + |Δa_net|, P_clear_den = Y_sum
spot   (both magnitudes = 0):           P_clear_num = R_A_pre, P_clear_den = R_B_pre
       ↓ amount_out_i ≥ min_out_i      (in-circuit GreaterEqThan(64))
       ↓ amount_out_i opens C_out_BJJ_i (in-circuit PedersenBJJ openOut[i])
       ↓ sigma cross-curve binding (per receipt, out-of-circuit)
chain receipt UTXO C_out_secp,i
```

Aggregate-side chain (one per asset, indexer-verified out-of-circuit):

```
Σ_{X→Y traders} C_in_secp,i  −  Σ_{Y→X traders} C_out_secp,i
       −  tip_X_C_secp  −  delta_X_net_signed · H_secp  ==  R_net_X · G_secp
       ↓ binds
public delta_X_net to actual chain aggregate
```

And the envelope-binding chain (closes the burn-grief attack):

```
trader's vin[1+i] tacit input
       ↓ Bitcoin SIGHASH_ALL signature
covers vout[0]'s 32-byte data
       ↓ which the indexer requires to equal
SHA256(envelope_payload)                                 (envelope_hash binding rule, SPEC §11.1)
       ↓ so any envelope substitution post-sign
invalidates the trader's Bitcoin sig
```

### T_SWAP_VAR

Specified by [`SPEC-SWAP-VAR-AMENDMENT.md`](./SPEC-SWAP-VAR-AMENDMENT.md);
the soundness chain summary, mirroring T_SWAP_BATCH's structure:

```
trader's intent_sig (BIP-340 over intent_msg) binds
  (pool_id, direction, delta_in, delta_out, min_out, tip,
   asset_input_outpoint, receipt_scriptPubKey, C_receipt_secp,
   C_change_or_sentinel)
       ↓ committing the trader to a specific Δ + receipt + change
kernel_sig (BIP-340 under excess · G_secp) verifies under
  (C_change_or_sentinel − C_in_secp + delta_in_total · H_secp).x_only
       ↓ closing the asset-A side balance (CXFER-style)
m=2 bulletproof verifies (C_change_or_sentinel, C_receipt_secp)
  are in [0, 2^64) (overflow guard; C_receipt opens to delta_out
  by trader-side construction — incentive-aligned, no in-protocol
  proof needed)
       ↓ which the indexer cross-checks against
curve recompute: delta_out_expected = ⌊R_B · γ · Δ / (R_A · γ_den + γ · Δ)⌋
+ freshness gate (R_A_pre, R_B_pre) == running pool state immediately
  before this tx_index
       ↓ which the OP_RETURN(envelope_hash) at vout[0] binds to the tx
SHA256(envelope_payload) == OP_RETURN data
       ↓ so any envelope substitution post-sign invalidates the trader's
intent_sig + kernel_sig
```

Closes free-rider attacks (no kernel sig without trader privkey),
front-running of an in-flight intent (intent_sig binds the asset_
input_outpoint — a settler can't substitute a different trader's
UTXO), and curve fraud (the indexer recomputes delta_out from the
public reserves, fee_bps, and Δ and requires exact equality).

### T_INTENT_ATTEST (preconfirmation soft-confirm)

```
worker_sig (BIP-340 under tacit-intent-attest-v1 domain) binds
  (pool_id, intent_pool_hash, observed_height)
       ↓ where intent_pool_hash = SHA256(canonical-sorted intent_ids)
indexer cross-checks the hash against the worker's published intent
list at observed_height (rejection if the worker equivocates: two
attestations from the same worker at the same observed_height with
different intent_pool_hashes → evidence of double-signing)
       ↓ which gives clients soft-confirm UX before depth-3 finality
without granting the worker any state-mutation power (T_INTENT_ATTEST
emits no pool delta — it is a non-mutating commitment).
```

Closes false-confirmation attacks: a worker who signs and then
reorgs out a corresponding T_SWAP_BATCH leaves an on-chain
intent_pool_hash that cannot be reconciled with the canonical pool
history, giving clients evidence to slash / blacklist the worker
(off-protocol, via the dapp's worker selection logic).

### T_PROTOCOL_FEE_CLAIM

```
recipient_sig (BIP-340 under recipient_pubkey) binds
  (pool_id, claim_height, k_growth_witness)
       ↓ authorising the claim to the founder-pinned recipient
indexer recomputes k_growth since last fee event, derives mintable
LP-share amount via Uniswap V2 lazy mintFee formula, mints the
resulting LP-share UTXO at the recipient's pre-declared address.
       ↓ which the OP_RETURN(envelope_hash) at vout[0] binds to the tx
```

Closes mis-claim: only the founder-pinned recipient_pubkey can
sign the claim sig; protocol_fee_bps and recipient_pubkey are
pinned at POOL_INIT and immutable thereafter.

### Where each attack vector is closed

| Attack vector | Closed by |
|---|---|
| Settler substitutes per-trader amount | sigma binding C_in_secp ↔ C_in_BJJ + Groth16 input opening |
| Settler claims wrong tip | tip_amount_witness === tip_amount + intent_sig over intent_msg |
| Settler computes wrong amount_out_i | Groth16 division-with-remainder + amount_out_i ≥ min_out_i + chain-side aggregate |
| Settler fakes P_clear | P_clear derived in-circuit from private X/Y aggregates + chain-side aggregate Pedersen binds totals |
| Settler swaps two traders' commitments | per-intent sigma proof verifies against per-intent commitment pair; can't shuffle without breaking |
| Settler claims spot when non-spot (or vice versa) | is_spot derivation via IsZero + sign-bit consistency check on declared deltas |
| Settler exploits padding slot | padded slots use identity (0, 1) commitment + zero amounts; circuit constraints hold trivially only for that exact pattern (adversarial-test.mjs validates) |
| Settler burns trader's UTXO via re-witness | vout[0] OP_RETURN(envelope_hash) bound by SIGHASH_ALL |
| Settler skips an intent (curation MEV) | tip economics + optional arbiter mandatory-inclusion rule |
| Trader inflates input via fake C_in_BJJ | chain UTXO's secp256k1 commitment is what counts; sigma binding to BJJ + Groth16 opening to amount means same `a` |
| LP claims wrong share_amount | indexer share-formula check (out-of-circuit) + Groth16 BJJ opening to public share_amount |
| LP claims wrong receipt deltas in LP_REMOVE | proportional formula check (out-of-circuit) + two Groth16 BJJ openings |
| Pool double-init for same (A, B) pair | first-mover wins, indexer-enforced + canonical asset pair ordering |
| Cross-pool replay of LP_ADD proof | pool_id_fr in public-input vector, squared into proof's polynomial system |
| Forgery of sigma proof | 128-bit Fiat-Shamir soundness (≈ 2^128 SHA256 hashes for forgery) |
| Forgery of Groth16 proof | Groth16 knowledge soundness under BN254 ≈ 100–110 bit AGM |
| Forgery of intent_sig | BIP-340 Schnorr ≈ 128-bit secp256k1 |

All primitives sit at ≥ 100 bits: BIP-340, Pedersen binding (≈128 secp / ≈125 BJJ prime subgroup), bulletproofs, sigma cross-curve binding (128-bit Fiat-Shamir + ≈128-bit statistical ZK), and the weakest — Groth16 knowledge-soundness at the AGM ~100–110-bit level.

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
seed_secp = HMAC-SHA256(recipient_privkey,
                         "tacit-amm-receipt-secp-v1"
                         || pool_id
                         || recipient_anchor_outpoint
                         || asset_id)
seed_BJJ  = HMAC-SHA256(recipient_privkey,
                         "tacit-amm-receipt-bjj-v1"
                         || pool_id
                         || recipient_anchor_outpoint
                         || asset_id)
r_out_secp_i = seed_secp mod n_secp  (n_secp = secp256k1 group order)
r_out_BJJ_i  = seed_BJJ  mod n_BJJ   (n_BJJ  = BabyJubJub subgroup order)
```

The receipt commitments are dual Pedersen:

```
C_out_secp_i = amount_out_i · H_secp + r_out_secp_i · G_secp   (on chain, secp256k1)
C_out_BJJ_i  = amount_out_i · H_BJJ  + r_out_BJJ_i  · G_BJJ    (in envelope, BabyJubJub)
```

The settler binds them via a per-receipt sigma proof (same shape
as the trader's per-intent sigma in "Hybrid commitments
(secp256k1 + BabyJubJub)") using the trader-supplied
`(amount_out, r_out_secp, r_out_BJJ)` from the encrypted opening
blob. The Groth16 batch proof additionally opens `C_out_BJJ_i`
in-circuit against the derived `amount_out_i` (native BJJ
arithmetic via `EscalarMulFix`, ~5K constraints per opening), closing the loop from
chain commitment → sigma proof → envelope BJJ commitment →
in-circuit amount. The settler / LP-op assembler does not derive
these blindings — it receives them from the recipient's
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
4. Re-deriving `r_out_secp` and `r_out_BJJ` from privkey +
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

**Hidden from public chain observers** (cryptographic,
unconditional under Pedersen + Groth16). Note: the **claiming
settler** sees per-trader openings (amount + blindings) for the
intents in its batch — it must, to construct the proof — but
chain observers do not.

- Each trader's per-intent amount in a batch (only the public batch
  deltas are revealed on chain; the claiming settler decrypts
  amounts for its included intents).
- Each LP's per-UTXO LP-share holding.
- Which LP redeemed at any given `T_LP_REMOVE`, if the LP mixed
  their share UTXO before redeeming.
- Recipient blindings on receipt UTXOs (deterministic from
  privkey; the claiming settler/assembler also learns these for
  its batch's receipts in order to populate `C_out_secp`).

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

**MEV-resistance vs amount-confidentiality trade-off.** Pools may
opt in to a mandatory-inclusion arbiter (see §"5. Qualifying-intent
fixed-point algorithm") to obtain MEV resistance against settler
censorship. **This trade-off is normative and unavoidable: traders
who want their intents force-included by an arbiter MUST send
cleartext amounts to that arbiter (encrypted to the arbiter's
pubkey at intent-post time) so the arbiter can run the deterministic
qualifying-set fixed-point.** The arbiter therefore learns
per-trader amounts for every intent in its pool. Two consequences:

- The arbiter is a confidentiality-trusted party for amounts in
  arbiter-pinned pools, even though it is NOT trusted for batch
  validity (the Groth16 proof binds that independently). Arbiter
  compromise leaks historical amounts; it does not allow theft.
- Default (no-arbiter) pools retain full amount confidentiality from
  every observer including settlers (settlers only learn amounts of
  intents they include in their own batch). Arbiter-pinned pools
  trade some confidentiality for MEV protection.

The dapp MUST surface this trade-off at pool-creation time and at
intent-post time for arbiter-pinned pools, so traders make the
choice explicitly rather than discovering it after the fact.

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
| Per-trade privacy | None | Hidden | Hidden from chain observers; claiming settler learns its batch's per-trader amounts |
| Settlement actor | Anyone (gas-paid tx) | Validator set | Permissionless settler |
| Trust beyond consensus | Contract bug ⇒ total loss | Cosmos validators | Indexer rules + Groth16 — no custody surface |

## Implementation specification

This section pins the byte-level wire formats, exact algorithms,
and Bitcoin-tx layering needed to actually build an implementation.
All earlier sections describe *what* the AMM does; this section
describes *how* to encode and validate it byte-for-byte.

### 1. Envelope byte layouts

All AMM envelopes ride in `vin[0].witness[1]` as taproot script-path
leaf data, per SPEC §5 (`OP_FALSE OP_IF "TACIT" 0x01 <payload>
OP_ENDIF` wrapping; the payload is what's specified below). Integer
fields are little-endian; secp256k1 / SHA256 byte fields are
big-endian network order; BabyJubJub points are compressed-Edwards
(32 bytes encoding the v-coordinate with the sign of u in the high
bit of the last byte, matching circomlib's `packPoint`).

**T_LP_ADD (`0x2D`), standard variant (variant=0):**
```
opcode(1)                  = 0x2D
variant(1)                 = 0x00
asset_A(32)                # the lexicographically smaller asset_id;
                           # "smaller" = unsigned big-endian byte compare
asset_B(32)                # the larger asset_id
delta_A_LE(8)              # u64, > 0 — public amount of asset A added
delta_B_LE(8)              # u64, > 0 — public amount of asset B added
share_amount_LE(8)         # u64, > 0 — public LP shares minted
share_C_secp(33)           # compressed Pedersen on secp256k1
share_C_BJJ(32)            # compressed BabyJubJub Pedersen
share_xcurve_sigma(157)    # cross-curve binding (§hybrid commitments)
kernel_sig_A(64)           # BIP-340 over kernel_msg_A
kernel_sig_B(64)           # BIP-340 over kernel_msg_B
proof_len_LE(2)            # u16
proof(proof_len)           # Groth16 batch proof
```

Fixed-size prefix is `1+1+32+32+8+8+8+33+32+157+64+64+2 = 442` bytes
plus the proof bytes (~256 B Groth16 ⇒ ~700 B total).

**T_LP_ADD (`0x2D`), POOL_INIT variant (variant=1):**
Standard layout above, plus appended at the end (before proof):
```
fee_bps_LE(2)              # u16, 0..1000 (capped at 10%)
vk_cid_len(1)              # u8, 1..64
vk_cid(vk_cid_len)         # IPFS CID, UTF-8
ceremony_cid_len(1)        # u8, 1..64
ceremony_cid(ceremony_cid_len)  # IPFS CID, UTF-8
arbiter_count(1)           # u8, 0..16
arbiter_pubkeys(33 * arbiter_count)  # compressed secp256k1
launcher_sig_count(1)      # u8, 0..2 — number of launcher-gate sigs
launcher_sigs(64 * launcher_sig_count)  # BIP-340 each, ordered by
                                        # asset_A's pubkey first
protocol_fee_address(33)   # compressed secp256k1; all-zeros = disabled
protocol_fee_bps_LE(2)     # u16, 0..1000 (= 0..10% of LP-fee growth)
```
`protocol_fee_address` and `protocol_fee_bps` are founder-set and
immutable. All-zeros address with bps=0 disables the protocol fee
(default); the decoder rejects mismatched (zero address with non-zero
bps, or non-zero address with zero bps). See "Protocol fee mechanism".
The MINIMUM_LIQUIDITY locked LP-share is at `vout[k_min_liq]` where
`k_min_liq = 1` (POOL_INIT's `vout[0]` is the LP-share output for
the founder, `vout[1]` is the MINIMUM_LIQUIDITY lock). The founder's
share at `vout[0]` and the locked share at `vout[1]` are both tacit
UTXOs of `lp_asset_id`; the locked one's recipient is the NUMS
P2WPKH per "MINIMUM_LIQUIDITY burn-output construction".

**T_LP_REMOVE (`0x2E`):**
```
opcode(1)                  = 0x2E
asset_A(32)
asset_B(32)
share_amount_LE(8)         # u64, > 0 — public LP shares burned
delta_A_LE(8)              # u64, public — receipt amount of asset A
delta_B_LE(8)              # u64, public — receipt amount of asset B
recv_A_C_secp(33)
recv_A_C_BJJ(32)
recv_A_xcurve_sigma(157)
recv_B_C_secp(33)
recv_B_C_BJJ(32)
recv_B_xcurve_sigma(157)
kernel_sig_LP(64)          # BIP-340 over kernel_msg_LP
proof_len_LE(2)
proof(proof_len)
```
Fixed prefix: `1+32+32+8+8+8+33+32+157+33+32+157+64+2 = 599` bytes
plus proof. `vout[0]` is the asset-A receipt, `vout[1]` is the
asset-B receipt.

**T_SWAP_BATCH (`0x2F`):**
```
opcode(1)                  = 0x2F
asset_A(32)
asset_B(32)
n_intents(1)               # u8, 1..16
delta_A_net_signed(9)      # 1-byte sign (0=positive A-in, 1=negative)
                           # || 8-byte u64 LE magnitude
delta_B_net_signed(9)      # same encoding
R_net_A(32)                # secp256k1 scalar (BE), aggregate r residual
R_net_B(32)
fee_bps_at_settle_LE(2)    # u16, captured pool.fee_bps at settle height
tip_A_amount_LE(8)         # u64, aggregate asset-A tip
tip_B_amount_LE(8)         # u64, aggregate asset-B tip
tip_A_C_secp(33)           # aggregate asset-A tip commitment
tip_B_C_secp(33)
r_tip_A_LE(32)             # secp256k1 scalar — opening for tip_A_C_secp
r_tip_B_LE(32)             # opening for tip_B_C_secp
# arbiter block (present iff pool has inclusion_arbiter_pubkeys):
expected_height_LE(4)
qualifying_set_hash(32)
arbiter_sig(64)
# per-intent block, repeated n_intents times in intent_id ascending order:
direction(1)               # 0 = A→B (input asset A), 1 = B→A
trader_pubkey(33)
C_in_secp(33)
C_in_BJJ(32)
in_xcurve_sigma(157)
min_out_LE(8)
tip_amount_LE(8)
expiry_height_LE(4)
intent_sig(64)
# per-receipt block, repeated n_intents times in same intent_id order:
C_out_secp(33)
C_out_BJJ(32)
out_xcurve_sigma(157)
# tail:
proof_len_LE(2)
proof(proof_len)
```

Per-intent block is `1+33+33+32+157+8+8+4+64 = 340` bytes; per-receipt
block is `33+32+157 = 222` bytes. For N=16, the per-trader portion
is `(340+222)*16 = 8992` bytes; plus global prefix of ~270 bytes,
optional arbiter block (~100 bytes), and proof (~256 bytes) ⇒
~9.5 KB envelope. Standard tx allows up to ~100 KB, so N up to ~150
fits at the tx layer — the N≤16 cap is purely a UX-latency choice.

**Bitcoin-tx layout for T_SWAP_BATCH** (normative, indexers reject
deviations):

| Index | Role |
|---|---|
| `vin[0]` | Settler's envelope-bearing input (Taproot script-path) |
| `vin[1+i]` | Trader inputs in `intent_id` ascending byte-order, `i ∈ [0,N)` |
| `vin[N+1..]` | Optional settler BTC funding inputs |
| `vout[0]` | `OP_RETURN(envelope_hash)` — 0 sat, 32-byte data; `envelope_hash = SHA256(payload)` where `payload` is the bytes from the opcode byte through the final byte of `proof` (i.e., the entire payload table above, **excluding** the OP_FALSE/OP_IF/TACIT/0x01 script-wrapping that lives in `witness[1]`'s script bytes) |
| `vout[1+i]` | Trader receipt: dust P2WPKH paying the trader's pre-declared `receive_scriptPubKey` |
| `vout[N+1]` | Aggregate asset-A tip output (dust P2WPKH paying settler) |
| `vout[N+2]` | Aggregate asset-B tip output (dust P2WPKH paying settler) — present iff either tip aggregate is nonzero; otherwise both tip outputs are omitted; if exactly one asset has tips, the other side's output is also omitted (its envelope-recorded `tip_X_amount_LE == 0`) |
| `vout[N+3..]` | Optional settler BTC change |

Indexers MUST reject any `T_SWAP_BATCH` whose tx layout deviates,
whose `vout[0]` OP_RETURN data ≠ recomputed `envelope_hash`, or whose
per-intent / per-receipt ordering ≠ `intent_id` ascending byte-order.

### 2. Kernel-msg construction

For T_LP_ADD's two per-asset kernel sigs (one for asset A, one for
asset B). The sig for asset X (X ∈ {A,B}) verifies under
`(Σᵢ C_in_secp,X,i − delta_X · H_secp).x_only()`:

```
kernel_msg_X = SHA256(
    "tacit-amm-lp-add-v1"
    || variant(1)
    || pool_id(32)                          # derived: SHA256("tacit-amm-pool-v1" || asset_A || asset_B)
    || asset_X(32)
    || delta_X_LE(8)
    || share_amount_LE(8)
    || share_C_secp(33)
    || in_count_X(1)                        # number of asset-X UTXOs being consumed
    || (in_txid_BE(32) || in_vout_LE(4))*in_count_X
)
```
Sign with `excess_X = Σᵢ r_in_secp,X,i`. The `variant` byte
distinguishes regular `LP_ADD` (variant=0) sigs from `POOL_INIT`
(variant=1) sigs, so the same bytes can't be replayed across modes.

For T_LP_REMOVE's single kernel sig (one consumed LP-share UTXO
side). Verifies under
`(Σᵢ C_in_secp,LP,i − share_amount · H_secp).x_only()`:

```
kernel_msg_LP = SHA256(
    "tacit-amm-lp-remove-v1"
    || pool_id(32)
    || share_amount_LE(8)
    || delta_A_LE(8)
    || delta_B_LE(8)
    || recv_A_C_secp(33)
    || recv_B_C_secp(33)
    || lp_in_count(1)
    || (lp_in_txid_BE(32) || lp_in_vout_LE(4))*lp_in_count
)
```
Sign with `excess_LP = Σᵢ r_in_secp,LP,i`.

`T_SWAP_BATCH` has no per-`vin` tacit kernel sig — see "Per-`vin`
Bitcoin-layer signature" under Cross-asset authorization for swaps.

### 3. Tip mechanics

Tips flow **from the trader's input side** in v1. The trader's
input UTXO's Pedersen commitment commits to
`a_in_total = amount_in_swap + tip_amount`, where both summands are
> 0. The `tip_asset` field in `intent_msg` MUST equal the trader's
direction.input (asset A for A→B, asset B for B→A); indexers reject
mismatches. The pool's clearing math operates only on
`amount_in_swap`; the `tip_amount` portion of the trader's input
flows directly to the per-asset aggregate tip output.

Concrete encoding:

- **Trader private witness for the Groth16 batch proof:**
  `(amount_in_swap_i, tip_amount_i, r_in_BJJ_i)` per intent. The
  circuit asserts:
  - `C_in_BJJ_i = (amount_in_swap_i + tip_amount_i) · H_BJJ
                  + r_in_BJJ_i · G_BJJ` (BJJ Pedersen opening)
  - `0 ≤ amount_in_swap_i < 2^64`, `0 ≤ tip_amount_i < 2^64`,
    `amount_in_swap_i + tip_amount_i < 2^64` (three range proofs
    per intent at ~3K constraints each)
  - `tip_amount_i == intent_msg.tip_amount` (public input matches
    private witness)
  - The chain-recorded `intent_msg.direction` matches the trader's
    A→B or B→A side, and the public `intent_msg.tip_asset` equals
    direction.input.

- **Settler-published tip output for asset X:**
  - `tip_X_amount = Σ tip_amount_i over traders with direction.input == X`
  - `r_tip_X` is a deterministic scalar derived as
    `HMAC-SHA256(settler_privkey,
                  "tacit-amm-tip-blind-v1"
                  || pool_id
                  || asset_X
                  || envelope_anchor) mod n_secp`,
    where `envelope_anchor = SHA256(opcode_byte || asset_A || asset_B
    || n_intents || sorted intent_ids concatenated)`.
    The settler can recover and spend the tip output from privkey
    alone. Indexers don't need to verify the settler's privkey
    knowledge; the soundness of the tip output (it commits to the
    cleartext `tip_X_amount`) is enforced by publishing both
    `tip_X_amount_LE` and `r_tip_X_LE` in the envelope and
    verifying `pedersenCommit(tip_X_amount, r_tip_X) == tip_X_C_secp`
    out-of-circuit.

- **Chain-side aggregate Pedersen check (per asset X):**

  ```
  Σ_{X→Y traders} C_in_secp,i
      − Σ_{Y→X traders} C_out_secp,i
      − tip_X_C_secp
      − delta_X_net_signed · H_secp
  ==  R_net_X · G_secp
  ```

  where `delta_X_net_signed = (Σ amount_in_swap_X) − (Σ amount_out_X)`,
  positive when X flows into the pool. Tips never enter `delta_X_net`
  — they're explicitly subtracted as a separate term. `R_net_X` is
  the corresponding aggregate-blinding residual the settler reveals.

This keeps the tip mechanism honest: the trader's `intent_sig`
commits to `tip_amount`, the circuit binds the input commitment to
`amount_in_swap + tip_amount`, the chain check subtracts the tip
output, and the settler can't pocket more than the declared tip
without invalidating the Pedersen balance.

### 4. Deterministic clearing-solve algorithm

The canonical algorithm. Bit-exact reproduction across implementations
is normative.

Inputs: `X, Y, R_A, R_B, fee_bps` (all u64 base units, `0 ≤ fee_bps ≤ 1000`).

Arithmetic widths in the pseudocode below are normative. Where an
expression is annotated `(u128)` or `(u256)`, conforming
implementations MUST evaluate the entire expression at least that
width — narrower widths can silently overflow on the highest-reserve
pools and cause two indexers to disagree on the canonical clear.
Final results in `(Δa_net, Δb_net, R_A', R_B')` are u64.

```
SOLVE_CLEARING(X, Y, R_A, R_B, fee_bps):
    require fee_bps <= 1000
    γ_num = 10000 - fee_bps                 # u16
    γ_den = 10000                           # u16

    # Note: (X, Y) = (0, 0) is rejected upstream as a degenerate-empty
    # batch (N = 0 is forbidden — see §"Uniform clearing" bullet
    # "Degenerate-empty batch"), so SOLVE_CLEARING is never entered
    # with both inputs zero. No branch needed here.

    # Identify direction by comparing X * R_B vs Y * R_A (in u128).
    # X * R_B > Y * R_A  ⇒ X dominates spot-rate ⇒ A→B-dominant batch
    # equal ⇒ spot-clearing (zero residual)
    lhs = (u128)X * (u128)R_B
    rhs = (u128)Y * (u128)R_A
    if lhs > rhs: return SOLVE_A_TO_B_DOMINANT(X, Y, R_A, R_B, γ_num, γ_den)
    if lhs < rhs: return SOLVE_B_TO_A_DOMINANT(X, Y, R_A, R_B, γ_num, γ_den)
    return SPOT_CLEARING(X, Y, R_A, R_B)    # exact-cancel batch


SOLVE_A_TO_B_DOMINANT(X, Y, R_A, R_B, γ_num, γ_den):
    # Binary search on Δa_net ∈ [1, X]. Each candidate Δa_net implies a
    # Δb_net (curve) and a P_clear (X / (Y + Δb_net)) which then implies
    # a Δa_net' (X − ⌊Y·X/(Y+Δb_net)⌋). Fixed point: Δa_net' == Δa_net.
    #
    # Termination: the search range has width ≤ X ≤ 2^64, so 64
    # halvings exhaust it; the `for iter in 0..64` bound is sufficient.
    # In practice `lo > hi` triggers before iteration 64 fires.
    #
    # Monotonicity: as `mid` increases, `Δb_net(mid)` is non-decreasing
    # (more A in → more B out under the curve), so
    # `Δa_net_implied(mid) = X − ⌊Y·X/(Y+Δb_net(mid))⌋` is non-decreasing.
    # The fixed-point equation may have no integer solution because of
    # floor rounding, but monotonicity guarantees the search converges
    # to a tight bracket: a largest `best` where the curve still gives
    # `Δa_net_implied(best) ≥ best` (the "too-small" side) and a
    # smallest `best+1` where `Δa_net_implied(best+1) < best+1`
    # (the "too-big" side). See the post-loop return for which side is
    # canonical.

    lo = 1
    hi = X
    best = lo
    for iter in 0..64:
        if lo > hi: break
        mid = lo + (hi - lo) / 2            # integer floor, prevents overflow

        # Δb_net from curve, with fee on net A inflow:
        # Δb_net = ⌊R_B · γ_num · mid / (R_A · γ_den + γ_num · mid)⌋
        num_db = (u256) R_B * γ_num * mid
        den_db = (u256) R_A * γ_den + (u256) γ_num * mid
        Δb_net = (u64)(num_db / den_db)     # floor

        # P_clear = X / (Y + Δb_net); compute floor(Y · X / (Y + Δb_net)).
        # Underflow safety: yx/denom = Y·X/(Y+Δb_net) ≤ Y·X/Y = X since
        # Δb_net ≥ 0 (so denom ≥ Y > 0 in the non-degenerate branch).
        # Therefore X − (yx/denom) ≥ 0 and the u64 subtraction below is
        # well-defined.
        denom = (u128)(Y + Δb_net)
        if denom == 0:                      # only when Y=0 and Δb_net=0; pool empty edge
            Δa_net_implied = X
        else:
            yx = (u128)Y * (u128)X
            Δa_net_implied = X - (u64)(yx / denom)

        if Δa_net_implied == mid:
            return (mid, Δb_net, P_clear_num = X, P_clear_den = Y + Δb_net)
        if Δa_net_implied < mid:
            hi = mid - 1                    # candidate too big
        else:
            best = mid
            lo = mid + 1                    # candidate too small

    # No exact integer fixed point exists — common case under floor
    # rounding, NOT rare. By the monotonicity argument above, after the
    # loop terminates `best` is the largest mid with
    # `Δa_net_implied(best) ≥ best`, and `best+1` (or `X` if the loop
    # never recorded a too-small mid) is the smallest mid with
    # `Δa_net_implied(best+1) < best+1`. The canonical choice is
    # `best`, NOT `best+1`: conservation requires
    # `Δa_net_declared ≤ Δa_net_implied(Δa_net_declared)` so that the
    # pool actually has enough B to pay out at the declared price.
    # Picking `best+1` would let the settler claim more Δa_net than the
    # curve produces at that mid — a soundness violation. Picking
    # `best` underfills by at most one base unit, accepted as
    # rounding dust that accumulates to LPs (the standard "rounding
    # in pool's favor" convention).
    Δb_net_best = ⌊R_B · γ_num · best / (R_A · γ_den + γ_num · best)⌋
    return (best, Δb_net_best, X, Y + Δb_net_best)


SOLVE_B_TO_A_DOMINANT(X, Y, R_A, R_B, γ_num, γ_den):
    # Symmetric: swap (X,Y) ↔ (Y,X), (R_A,R_B) ↔ (R_B,R_A), run the
    # A→B-dominant solve, swap output (Δa_net, Δb_net) accordingly.
    (Δb_net, Δa_net, num, den) = SOLVE_A_TO_B_DOMINANT(Y, X, R_B, R_A, γ_num, γ_den)
    return (Δa_net, Δb_net, P_clear_num = den, P_clear_den = num)


SPOT_CLEARING(X, Y, R_A, R_B):
    # Exact-cancel: Δa_net = Δb_net = 0. P_clear = R_A / R_B (= spot).
    return (Δa_net=0, Δb_net=0, P_clear_num=R_A, P_clear_den=R_B)
```

Per-trader fills, once `(Δa_net, Δb_net, P_clear_num, P_clear_den)`
is fixed:

- A→B trader: `amount_out_i = ⌊amount_in_swap_i · P_clear_den / P_clear_num⌋`
- B→A trader: `amount_out_i = ⌊amount_in_swap_i · P_clear_num / P_clear_den⌋`

All multiplications in u128/u256 to avoid overflow; all divisions
floor toward the pool. The bracket-update rule (`lo = mid + 1` /
`hi = mid - 1`) and the `mid = lo + (hi - lo)/2` floor choice are
normative — different rules silently produce different `Δa_net` at
rare integer boundaries and break indexer determinism.

### 5. Qualifying-intent fixed-point algorithm

Inputs: `candidate_set` (all open intents at height H satisfying
the `K`-block-window + non-expired conditions, deterministically
sorted by `intent_id` ascending), `R_A`, `R_B`, `fee_bps`.

```
QUALIFYING_FIXED_POINT(candidate_set, R_A, R_B, fee_bps):
    set = candidate_set
    for iter in 0..len(candidate_set):
        # Run the deterministic clearing solve over set's amounts
        # (the arbiter has access to cleartext amounts via off-chain
        # opening blobs the traders share with the arbiter, OR the
        # arbiter publishes the qualifying list based on amount
        # commitments alone if traders pre-disclose min_out
        # satisfiability).
        if set is empty: return set
        (Δa_net, Δb_net, P_num, P_den) = SOLVE_CLEARING(
                                            sum_X(set), sum_Y(set),
                                            R_A, R_B, fee_bps)
        new_set = {}
        for intent in set (sorted ascending by intent_id):
            amount_out = compute_amount_out(intent, P_num, P_den)
            if amount_out >= intent.min_out:
                new_set.add(intent)
        if new_set == set:
            return set                      # converged
        set = new_set                       # strictly shrinks ⇒ guaranteed termination
    return {}                               # didn't converge (shouldn't reach)
```

Each iteration strictly removes at least one intent (otherwise we
would have returned), so the algorithm terminates in at most
`len(candidate_set)` iterations. The loop cap matches that bound;
the final empty-return is a safety net never reached in practice.

For the arbiter to produce the qualifying list deterministically,
it needs cleartext amounts. v1 protocol: traders who want to be
eligible for mandatory-inclusion in arbiter-pinned pools send
their cleartext `amount_in_swap` to the arbiter (encrypted to
arbiter's pubkey) at intent-post time. The arbiter privately
runs the fixed-point and publishes the signed list. Trust
implication: the arbiter learns cleartext amounts for arbiter-
pinned-pool intents. Pools whose participants want amount
confidentiality from the arbiter must use default (no-arbiter)
pools, which trade MEV resistance for amount confidentiality.

### 6. Groth16 public-input vector

The batch circuit's `vk` is fixed at compile time for a maximum
batch size `N_MAX = 16`. Batches with `n_intents < N_MAX` pad
unused slots with the BabyJubJub identity `(0, 1)` and zero
amounts/tips/directions/min_outs — all in-circuit constraints
hold trivially for that exact pattern, so the circuit always
evaluates all 16 slots. The public-signals array (decimal-string
BN254 Fr elements, passed to `snarkjs.groth16.verify`) is **123
signals** total, laid out as:

```
publicSignals[0]   = pool_id_fr                     # SHA256(pool_id) mod p_Fr
publicSignals[1]   = R_A_pre
publicSignals[2]   = R_B_pre
publicSignals[3]   = delta_A_net_sign               # 0 = positive (A-dom or spot), 1 = negative (B-dom)
publicSignals[4]   = delta_A_net_magnitude          # u64
publicSignals[5]   = delta_B_net_sign
publicSignals[6]   = delta_B_net_magnitude          # u64
publicSignals[7]   = tip_A_amount
publicSignals[8]   = tip_B_amount
publicSignals[9]   = fee_bps                        # 0..1000 (in-circuit cap via LessThan(11) vs 1001)
publicSignals[10]  = n_intents                      # 0..31, public hint; indexer matches signed intents
# Per-intent (5 elements × N_MAX, in intent_id ascending order):
publicSignals[11 + 5*i + 0] = direction_i           # 0 = A→B, 1 = B→A
publicSignals[11 + 5*i + 1] = C_in_BJJ_u_i
publicSignals[11 + 5*i + 2] = C_in_BJJ_v_i
publicSignals[11 + 5*i + 3] = min_out_i
publicSignals[11 + 5*i + 4] = tip_amount_i          # binds in-circuit tip_amount_witness to intent_msg.tip_amount
# Per-receipt (2 elements × N_MAX):
publicSignals[11 + 5*N_MAX + 2*i + 0] = C_out_BJJ_u_i
publicSignals[11 + 5*N_MAX + 2*i + 1] = C_out_BJJ_v_i
```

For N_MAX=16: `11 + 5·16 + 2·16 = 123` public signals. (Dropped
`S_pre` in the optimization pass — it was a range-checked public
input that didn't bind to any pool state in-circuit; cross-pool
replay protection comes from `pool_id_fr`. The indexer can still
cross-check `pool.lp_total_shares` against chain state separately.) Padded
intents use `direction=0, C_in_BJJ=(0,1), min_out=0, tip_amount=0`
(BJJ identity is the only valid u/v pair for an inactive opening —
`(0, 0)` is off-curve and would fail the in-circuit constraint).
Padded receipts use `C_out_BJJ=(0,1)` similarly. All in-circuit
constraints (range checks, Pedersen openings, division-with-
remainder, min_out, aggregate tip sum) hold trivially under this
padding convention.

Reference impl: `dapp/circuits/amm/amm_swap_batch.circom`. Witness
generation + adversarial tests in `dapp/circuits/amm/witness-test.mjs`
and `dapp/circuits/amm/adversarial-test.mjs` (28 cases). Pre-ceremony
review at `dapp/circuits/amm/REVIEW.md`. Drift guard (catches any
post-ceremony source change) at `dapp/circuits/amm/drift-guard.test.mjs`.

For LP_ADD / LP_REMOVE the circuit and `vk` are different
(per-op circuit, not shared with swap). Their public-input
vectors are smaller and pool-op-specific; spec the same way at
implementation time.

### 7. Commit/reveal layering

Earlier sections say `T_SWAP_BATCH` settles in "one Bitcoin
transaction." Strictly that's one **reveal** transaction; per
SPEC §5 every tacit envelope rides in a Taproot script-path leaf
that must be committed first. The settler's full ceremony is:

1. **After RTT 1** (openings collected, solve done, proof
   generated, envelope assembled, envelope_hash computed):
   build a **commit tx** that pays to a P2TR output whose internal
   key is BIP-341 NUMS and whose tap-tree single leaf is
   `envelope_script`. The commit tx is ~150 vbytes, pays BTC fees,
   and locks no tacit value. Broadcast.
2. **Build reveal tx skeleton:** `vin[0]` = the commit tx's
   `vout[0]` outpoint; `vout[0]` = `OP_RETURN(envelope_hash)`; per-
   trader `vin`/`vout` slots populated as per the layout table
   above. The commit tx's outpoint is now fixed (commit broadcast
   in step 1), so the reveal tx's structure is fully determined
   modulo the trader sigs.
3. **RTT 2:** forward the reveal-tx PSBT to each trader's dapp.
   Each trader's dapp verifies (commit-tx outpoint is plausible,
   payload matches their intent, etc.) and signs `SIGHASH_ALL`
   over the reveal tx.
4. **Broadcast reveal tx** with all sigs spliced in.

Both commit and reveal txs can sit unconfirmed in the mempool
simultaneously — Bitcoin allows spending unconfirmed mempool
outputs. Typical confirmation: commit and reveal land in the same
block. Settler's BTC cost is two tx fees instead of one (~$1–2 on
mainnet for a typical batch). Settler recoups via the tip
mechanism.

**Reorg implications.** If the commit tx is reorged out, the
reveal tx becomes invalid (spends a non-existent UTXO). Settler
must re-broadcast both, recomputing trader sigs because the
reveal's `vin[0]` outpoint shifts. Practical impact: same depth-3
gate as the mixer (`MIXER_DEPOSIT_CONFIRMATION_DEPTH`) applies;
indexers don't credit batch results until commit + reveal both
sit at depth ≥ 3. Reorgs at this depth are below 1% per Bitcoin's
hashrate assumptions, so the operational cost of re-broadcast is
amortized.

**RBF / fee-bumping.** `SIGHASH_ALL` forbids fee bumps on the
reveal tx without re-signing. Settlers SHOULD seed the BTC fee
generously at sign-time rather than relying on RBF. The commit
tx is RBF-safe (settler's own input + change, no trader sigs);
fee-bumping the commit is allowed and doesn't invalidate the
reveal so long as the commit's spendable outpoint is unchanged.

This two-tx framing is the only Bitcoin-layer subtlety that
diverges from the doc's earlier "one Bitcoin transaction"
shorthand. From the trader's POV the experience is still "one
PSBT signature, then done" — the commit tx is settler-funded and
settler-managed.

## SPEC.md integration plan

AMM stays unshippable until SPEC.md is extended with the additions
below. Each item is small and self-contained; together they make
AMM normative under tacit's existing indexer-validation framework.

**§3 (Cryptographic primitives) — add §3.9, BabyJubJub.**
Specify the curve equation, the circomlib parameters
(`a = 168700, d = 168696`), the cofactor 8, the prime subgroup
order `n_BJJ`, the NUMS try-and-increment algorithm for `H_BJJ` /
`G_BJJ` (copied from the algorithm in "Hybrid commitments
(secp256k1 + BabyJubJub)" above), and the reference test vectors
once they're computed by the reference implementation.

**§3 (Cryptographic primitives) — add §3.10, sigma cross-curve
binding.** Specify the Camenisch-Stadler protocol parameters
(challenge `e < 2^80`, mask `α < 2^224 − 2^144` rejection-sampled,
response `z_a < 2^224` encoded in 28 bytes BE), the canonical
proof bytes layout (169 bytes: `A_secp(33) || A_BJJ(32) ||
z_a(28) || z_r_secp(32) || z_r_BJJ(32)`), the Fiat-Shamir
challenge derivation (`e = SHA256(domain || C_secp || C_BJJ ||
A_secp || A_BJJ)` then take the low 80 bits as the challenge —
i.e., the last 10 bytes of the digest interpreted big-endian),
and the verifier procedure including explicit range checks
`z_a < 2^224`, `z_r_secp < n_secp`, `z_r_BJJ < n_BJJ`.

**§4 (Asset identity) — extend with LP origin path.** Add a third
canonical asset-id origin: `lp_asset_id = SHA256("tacit-amm-lp-v1"
|| pool_id)`, valid whenever a canonical `POOL_INIT` exists for
the corresponding pair. The three-origin resolution rule (CETCH /
T_PETCH / POOL_INIT) becomes normative for every indexer's
asset-lookup path.

**§5.5 (Validator algorithm) — add three opcode branches.**

```
if envelope.opcode == T_LP_ADD:
    # See §5.14. Public (Δa, Δb, share_amount); mixer-style kernel sigs
    # for each input asset; Groth16 proof asserts at-the-ratio + share
    # formula. If variant=1 sentinel, this is POOL_INIT (one-shot;
    # registers vk_cid, fee_bps, etc.). Otherwise mints LP-share UTXO
    # at vout[k_share] under lp_asset_id origin.
    decode payload; if variant==1 register pool metadata + verify
        launcher gate via per-asset metadata-blob fetch + JCS extract
    verify each per-asset kernel sig (one per asset side)
    verify Groth16 batch proof under pool.vk
    verify per-receipt sigma cross-curve binding for the share output
    credit LP-share UTXO at the share vout under lp_asset_id
    return true

if envelope.opcode == T_LP_REMOVE:
    # See §5.15. Public share_amount; mixer-style kernel sig over the
    # consumed LP-share UTXO under (Σ C_in_LP − share_amount·H).x_only();
    # Groth16 asserts proportional withdrawal. Mints two receipt UTXOs
    # (one of asset A, one of asset B) under the deterministic
    # receipt-recovery rule.
    ...

if envelope.opcode == T_SWAP_BATCH:
    # See §5.16. Confidential per-trader amounts; settler-bundled.
    # Sigma cross-curve proofs verified out-of-circuit (per-intent
    # AND per-receipt). Groth16 batch proof under pool.vk verifies
    # in-circuit BJJ openings + clearing arithmetic. Chain-side
    # aggregate Pedersen check on secp256k1.
    require vout[0] == OP_RETURN(envelope_hash)
    decode payload; verify arbiter_sig + qualifying_set_hash if pool
        has inclusion_arbiter_pubkeys
    for each per-intent sigma proof: verify against (C_in_secp_i, C_in_BJJ_i)
    for each per-receipt sigma proof: verify against (C_out_secp_j, C_out_BJJ_j)
    verify Groth16 batch proof under pool.vk over public inputs:
        [pool_id, R_A_pre, R_B_pre, Δa_net, Δb_net, fee_bps,
         per-intent C_in_BJJ list, per-receipt C_out_BJJ list,
         per-receipt min_out list, per-intent direction list]
    verify chain-side aggregate Pedersen check per asset
    re-run deterministic clearing solve; reject if declared (Δa_net,
        Δb_net) don't match
    advance pool reserves; credit each receipt UTXO at vout[1+i]
    return true
```

The Validator algorithm pseudocode in SPEC §5.5 grows by these
three branches; the existing logic for CETCH / CXFER / T_MINT /
T_BURN / T_AXFER / T_PETCH / T_PMINT / T_DEPOSIT / T_WITHDRAW /
T_DROP / T_DCLAIM is unchanged.

**§5.14, §5.15, §5.16 — three new opcode wire-format sections.**
Copy the wire formats from "The six opcodes" above, expanded
with byte layouts to the same level of detail as SPEC §5.1
(CETCH) and SPEC §5.10 (T_DEPOSIT). The hot spots: T_LP_ADD's
two-kernel-sig structure, T_SWAP_BATCH's per-intent input layout
+ OP_RETURN binding rule + sigma-proof slots, T_LP_REMOVE's
proportional-withdrawal share-burn. The auxiliary opcodes
`T_INTENT_ATTEST` (`0x30`, §5.16.1 preconf) and
`T_PROTOCOL_FEE_CLAIM` (`0x31`, §5.16.2 fee withdrawal) merge
under the same §5.16 AMM block. `T_SWAP_VAR` (`0x32`) merges as
§5.16.3 from
[`SPEC-SWAP-VAR-AMENDMENT.md`](./SPEC-SWAP-VAR-AMENDMENT.md).

**§6 (Recovery semantics) — add three paths.** Receipt-recovery
HMAC seeds anchored on `recipient_anchor_outpoint`; same posture
as path 7 (T_WITHDRAW) and path 8 (T_DCLAIM). Spell out the
domain tags (`tacit-amm-receipt-{secp,bjj}-v1`) and the dual-curve
verification.

**§11 (Indexer determinism) — add AMM section.** Rounding rules
(floor toward pool), deterministic clearing-solve algorithm
(bounded binary search), JCS canonical JSON for metadata blobs,
qualifying-intent fixed-point computation, T_SWAP_BATCH tx
layout, reorg handling for arbiter pools. Same role as the
existing §11 for the mixer.

## Preconfirmation layer (T_INTENT_ATTEST) — tacit channel

The protocol layer (T_SWAP_BATCH, T_SWAP_VAR, T_LP_ADD, T_LP_REMOVE)
settles at the Bitcoin block clock (~10 min). For perceived-UX
latency the preconf layer runs as a **tacit channel** — an
off-chain commitment scheme where the worker maintains a signed
snapshot of the open intent pool, and traders verify their intents
are included by reconstructing the snapshot hash locally.

The construction is **trustless** in the sense that:

- A misbehaving worker (omits intents, equivocates) can be
  cryptographically detected — its signed snapshots are evidence on
  chain.
- Traders have an **unconditional unilateral exit**: at any time,
  any trader can self-broadcast their intent directly on chain
  (T_SWAP_VAR self-broadcast path, or T_SWAP_BATCH via any settler),
  bypassing the channel entirely. The worker has no power to lock
  funds, censor unilaterally, or steal — its only role is to
  accelerate UX.
- Settlement soundness does NOT depend on worker honesty. The
  preconf layer's only output is the soft-confirm UX bit; if it
  fails, traders fall back to ~10 min Bitcoin finality with no loss
  of safety.

The design is intentionally simpler than an SMT-based commitment:
no sparse Merkle tree, no 8 KB membership proofs, no depth-256
storage tables. The commitment is a **single linear hash** over the
canonical-ordered intent-id list at the attested height — same
32-byte on-chain footprint, dramatically simpler implementation.
Trade-off: membership "proofs" are the worker's published snapshot
itself (a list of intent_ids over RPC), not a logarithmic Merkle
path. For tacit's expected pool sizes (hundreds of intents in
flight) this is the right point on the Pareto curve — fetching the
full snapshot is one HTTP roundtrip and a SHA-256 over the
published bytes. Future amendments can swap in a vector commitment
(KZG/FRI) for large-N regimes without changing the on-chain wire.

### Two layers, independent

```
SOFT CONFIRM (channel layer, ~30 s):
    trader → worker (any P2P channel; the worker is fungible)
              ↓
    worker adds intent_id to its open pool
              ↓
    worker periodically publishes
        (sorted_intent_ids[], pool_id, height, timestamp, worker_sig)
    AND broadcasts T_INTENT_ATTEST envelope on chain with
        intent_pool_hash = SHA256(canonical-sorted intent_ids)
              ↓
    trader fetches sorted_intent_ids[], verifies their intent_id is
    present, verifies SHA256(list) matches the on-chain hash,
    verifies worker_sig → "soft confirmed"

HARD CONFIRM (settlement layer, ~10 min):
    trader ↔ settler RTT (independent of preconf layer)
              ↓
    T_SWAP_BATCH or T_SWAP_VAR envelope on chain
              ↓
    indexer credits receipt at depth-3

UNILATERAL EXIT (always available):
    trader broadcasts T_SWAP_VAR self-broadcast directly on chain
              ↓
    no worker, no channel — standard Bitcoin finality applies

L1 ANCHOR (worker → chain, per block):
    worker (or any party) broadcasts T_INTENT_ATTEST envelope
              ↓
    indexer records (pool_id, worker_pubkey, height) → intent_pool_hash
              ↓
    equivocation detection: two valid attestations from same
    (worker, pool, height) with different hashes ⇒ worker flagged
```

The two layers compose: the preconf layer gives modern-dApp
responsiveness; the hard-confirm layer gives Bitcoin-L1 settlement.
**If the preconf layer is offline or compromised, the hard-confirm
layer still works trustlessly** — traders just don't get the soft
confirm. Settlement does not depend on worker honesty for soundness.

### T_INTENT_ATTEST (opcode `0x30`) wire format

```
opcode(1)             = 0x30
pool_id(32)
intent_pool_hash(32)  SHA256(canonical-sorted concatenation of intent_ids in
                              the worker's open pool at observed_height — see below)
observed_height_LE(4) u32 — Bitcoin block height the snapshot is "as of"
timestamp_LE(8)       u64 — worker's wall-clock unix seconds at sign
intent_count_LE(2)    u16 — number of intents committed in this snapshot
snapshot_uri_len(1)   u8, 0..255 (0 = no URI; worker reachable only via direct P2P)
snapshot_uri(snapshot_uri_len) UTF-8 — HTTP(S) endpoint or IPFS CID prefix where
                                       the full sorted_intent_ids[] can be fetched.
                                       Informational only; the indexer never fetches
                                       it (not consensus-bound).
worker_pubkey(33)     compressed secp256k1
worker_sig(64)        BIP-340 over SHA256("tacit-intent-attest-v1" || all preceding fields)
```

Wire size: 1 + 32 + 32 + 4 + 8 + 2 + 1 + uri_len + 33 + 64 = 177 + uri_len bytes (typical ~210 B with HTTP URL).

### Intent-pool hash construction (normative)

```
sorted_intent_ids = sort_lex_ascending([intent_id for each open intent in worker's pool])
intent_pool_hash  = SHA256(intent_id_0 || intent_id_1 || ... || intent_id_{N-1})
```

Where each `intent_id` is 32 bytes (canonical SHA-256 of the
intent_msg). The sort is byte-lexicographic ascending, producing a
canonical ordering independent of insertion order or worker-internal
data structures. Two workers with identical pools produce identical
hashes.

`intent_count` in the wire format MUST equal `N`. If a verifier
fetches the worker's published snapshot and the list length differs
from `intent_count`, the attestation is considered forged.

Empty pool: `intent_count = 0`, `intent_pool_hash = SHA256("")` (the
empty-string hash). A worker attesting to an empty pool is a valid
no-op — useful for proving liveness when no intents are flowing.

### Indexer determinism rules

For `T_INTENT_ATTEST` (extends §11):

- Decode envelope. Reject on structural error.
- Verify `worker_sig` under `worker_pubkey` against the canonical
  hash `SHA256("tacit-intent-attest-v1" || preceding_fields)`.
- Reject if `observed_height > envelope_height` (worker cannot
  claim a future state).
- Index the attestation by `(pool_id, worker_pubkey, observed_height)`.
  If an entry with the **same** key but **different**
  `intent_pool_hash` already exists, flag the worker as an
  equivocator and reject the incoming envelope. Same hash at same
  key is accepted idempotently.
- Multi-worker support: different `worker_pubkey` values can attest
  to the same pool + height with different hashes; that's normal
  multi-worker operation, not equivocation.
- Different-pool attestations from the same worker at the same
  height are independent — no equivocation check across pools.
- The indexer does NOT fetch `snapshot_uri`. The URI is informational
  metadata for off-chain trader verification; not consensus-bound,
  not validated.

### No-single-point-of-failure properties

The preconf layer adds operational dependency on the worker for
*soft-confirm UX*, but **no protocol-soundness dependency**:

| Property | Without preconf | With preconf |
|---|---|---|
| Settlement requires worker honesty | No | No (worker can be ignored) |
| Settlement requires snapshot fetchability | No | No (chain-side settlement doesn't fetch off-chain data) |
| Trader funds at risk if worker malicious | No | No (sig binding to envelope_hash + intent_sig holds) |
| Soft-confirm requires worker honesty | N/A | Yes, but equivocation detectable at depth-1 |
| Multi-worker fallback supported | N/A | Yes — trader registers with ≥ 2 workers |
| Unilateral exit available | N/A | Yes — trader self-broadcasts T_SWAP_VAR |
| Indexer single point of failure | No (anyone runs one) | No (anyone runs one) |

The worker is operationally important for low-latency UX but is
functionally fungible at the soundness layer. **The channel is
trustless in the cryptographic sense: any worker misbehavior is
either detectable (equivocation evidence on chain) or
circumventable (unilateral exit via self-broadcast).**

### Trader-side soft-confirm verification

Given a worker-supplied bundle `{my_intent_id, sorted_intent_ids[],
pool_id, observed_height, timestamp, worker_pubkey, worker_sig}`
and the corresponding on-chain `T_INTENT_ATTEST` envelope (the
trader's dapp watches the chain for it), the trader verifies:

1. Worker is in the trader's trusted-worker set (locally configured).
2. Worker is not in the indexer's equivocation-flag set.
3. `timestamp` is fresh (default TTL: 300 s).
4. `worker_sig` is valid BIP-340 under `worker_pubkey` over the
   canonical attestation message.
5. The on-chain `intent_pool_hash` equals
   `SHA256(sorted_intent_ids[0] || … || sorted_intent_ids[N-1])`
   computed locally over the worker-provided list. `N` matches
   `intent_count` in the envelope.
6. `my_intent_id` is present in `sorted_intent_ids[]` (binary search
   over the lex-sorted list).

If all pass: status `soft_confirmed`. Dapp surfaces "soft confirmed
at hash H, anchored at block H+1 (~10 min)." If any fails: status
`stale` / `forged` / `equivocator` / `untrusted_worker` /
`intent_missing`.

Compared to the SMT-based v0 design, step 5 trades an O(log N)
Merkle path (~8 KB) for an O(N) full-list rehash (32 bytes × N
over the wire). For N = 500, that's 16 KB of intent_ids —
comparable to the SMT proof — and the verification is one SHA-256
sweep. For large pools (N > 10 K), a future amendment can swap in a
vector commitment (KZG/FRI) without changing the on-chain wire
format; the chain just records `intent_pool_hash` regardless of its
preimage structure.

### Worker as channel operator (informative)

Framing the preconf layer as a payment-channel analogue: the
worker is the channel operator, the open intent pool is the channel
state, and each `T_INTENT_ATTEST` is a periodic anchor of the state to
L1. The analogy:

| Payment channel | Tacit channel |
|---|---|
| 2-party state | N-party state (N traders contributing intents) |
| Latest signed state | Latest signed `intent_pool_hash` |
| Cooperative close | T_SWAP_BATCH / T_SWAP_VAR settles intent on chain |
| Unilateral close (dispute) | Self-broadcast T_SWAP_VAR; worker has no veto |
| Watchtower (anti-old-state) | Equivocation detector (anyone runs an indexer) |
| Fee for operator | Settler tip (paid in-band per fill) |

The simplification vs traditional channels: no funding transaction,
no commitment-tx exchange, no penalty-tx mechanism. The worker
can't steal because it never holds funds — it only sequences
intents. Traders' UTXOs stay on chain throughout; the channel state
is just *which intents the worker has acknowledged*, not where the
value lives. This is what makes the preconf layer fit Bitcoin
natively: no covenants needed, no script-side state machine, no
exit-game challenge protocol. Just a hash commitment and a
signature, anchored to chain at the worker's chosen cadence.

Reference impl: `tests/amm-attest.mjs`. Parity suite: `tests/amm-attest.test.mjs` (32 tests, pending update to drop SMT proofs and add full-list verification — implementation work item, not consensus).

## Protocol fee mechanism (founder-set, immutable)

V1 pools support an **optional, founder-set, immutable** protocol-fee skim. At `POOL_INIT`, the pool founder MAY pin two additional fields:

- `protocol_fee_address` (33-byte compressed pubkey) — recipient of protocol fee accrual
- `protocol_fee_bps` (u16, 0..1000) — fraction of LP-fee growth skimmed to the recipient, in basis points of the fee growth itself (max 10% of LP fees)

A pool with `protocol_fee_address = 33 × 0x00` has no protocol fee; the indexer treats this as the default no-op path and the pool behaves as a pure V2-style LP-fee model. A non-zero address requires `protocol_fee_bps > 0` (and vice-versa) — the envelope decoder rejects mismatched configurations to prevent dead-weight states where an address is pinned but earns nothing or where a non-zero rate is configured but unclaimable.

The pool founder picks the recipient address. It can be:

- The founder's own wallet (asset issuer captures fees on their own pool)
- The TAC treasury (or any aligned address) — supports value-capture stories without governance complexity
- A multisig (committee captures fees, e.g., a foundation)
- A burn address (fees are removed from circulation, deflationary)

Once pinned at `POOL_INIT`, the address and rate are **immutable for the pool's lifetime**. There is no governance opcode in V1 that can mutate these fields. This is a deliberate constraint: V1 pools have founder-time fee decisions, period. Future versions MAY introduce governance-controlled fee adjustment for V2+ pools, but V1 pools are exempt from those mechanics by construction.

### Accrual model: Uniswap V2 lazy `mintFee`

Tacit AMM uses the same accrual model Uniswap V2 uses for its `feeTo` mechanism: protocol fee accrues *lazily* as new LP shares, computed at LP events (LP_ADD, LP_REMOVE) and at `T_PROTOCOL_FEE_CLAIM`. `T_SWAP_BATCH` itself does **not** crystallize the fee — the fee accrues virtually between fee events, captured implicitly in the growth of `k = R_A · R_B`.

State the indexer maintains per pool:

```
protocol_fee_address    : 33-byte compressed pubkey, all-zeros = disabled
protocol_fee_bps        : u16, 0..1000
protocol_fee_accrued    : u128 — LP-share counter owed to the recipient (virtual claim)
k_last                  : u256 — R_A · R_B snapshot at the last fee-crystallization event
```

**Crystallization formula** (matches Uniswap V2 `mintFee`, integerized for BigInt arithmetic):

```
if k_now > k_last:
    rootK_pre  = isqrt(k_last)
    rootK_now  = isqrt(k_now)
    numerator   = S · bps · (rootK_now − rootK_pre)
    denominator = (10000 − bps) · rootK_now + bps · rootK_pre
    new_shares  = floor(numerator / denominator)
    pool.protocol_fee_accrued += new_shares
    pool.lp_total_shares      += new_shares      # dilutes existing LPs
    pool.k_last                = k_now            # new baseline
```

**Properties:**
- Protocol's value share ≈ `(bps / 10000) · (sqrt(k_now) − sqrt(k_last)) / sqrt(k_now)` — i.e., `bps` basis-points of the LP-fee growth in value terms.
- Existing LPs are diluted by exactly that fraction; the pool's total share value is conserved (sum of share values = pool value).
- `T_SWAP_BATCH` does not trigger crystallization — fees accrue virtually until the next LP event or claim.

**LP-side awareness:** because crystallization mutates `lp_total_shares` (which appears in the share-mint formula `floor(min(δA · S / R_A, δB · S / R_B))`), LPs joining pools with protocol fees MUST query the indexer's current `k_last` and `protocol_fee_accrued` and pre-compute the crystallized `S` themselves before constructing their `T_LP_ADD` envelope. Pools without protocol fees are unaffected (their `S` doesn't drift between LP events). Indexers SHOULD expose `(R_A, R_B, S, k_last, protocol_fee_accrued, protocol_fee_address, protocol_fee_bps)` as part of pool state queries.

### Claiming: `T_PROTOCOL_FEE_CLAIM` (opcode `0x31`)

The recipient address claims accrued fees by broadcasting a `T_PROTOCOL_FEE_CLAIM` envelope:

```
opcode(1) = 0x31
pool_id(32)
claimer_pubkey_x_only(32)
claim_amount_LE(8)            # u64; must equal pool.protocol_fee_accrued post-crystallization
claim_C_secp(33)              # Pedersen commitment of claim_amount
claim_blinding(32)            # r_secp (revealed; opening is public)
claim_sig(64)                 # BIP-340 over claim_msg
```

Fixed envelope size: **202 bytes**. No Groth16. The validator:

1. Confirms `claimer_pubkey_x_only` matches the x-only of `pool.protocol_fee_address`.
2. Crystallizes the protocol fee (V2-lazy `mintFee`).
3. Confirms `claim_amount == pool.protocol_fee_accrued` post-crystallization.
4. Verifies `claim_sig` (BIP-340) and the public commitment opening `claim_C_secp == claim_amount · H + claim_blinding · G`.
5. Emits an `lp_asset_id` UTXO at `vout[0]` payable to a P2TR/P2WPKH script under `claimer_pubkey_x_only`.
6. Resets `pool.protocol_fee_accrued = 0`.

After claiming, the recipient holds `lp_asset_id` UTXOs that can be redeemed via `T_LP_REMOVE` (or held to compound — they accrue fees like any other LP position from that point on).

### Forward-compatibility implications

V1's protocol-fee mechanism is **forward-compatible by omission**:
- Pools with `protocol_fee_address = 33 × 0x00` have no fee mechanism active and behave identically to a pure V2-style LP pool. These pools can never have a protocol fee added retroactively.
- Pools with a non-zero address have founder-set parameters that V2+ ceremonies will not override (the address and rate are pinned at POOL_INIT in the on-chain envelope).
- Future ceremonies MAY introduce alternative fee mechanisms (governance-controlled rates, dynamic fees, fee-on-swap vs. fee-on-growth). Those mechanisms apply only to pools that opt into them via their respective POOL_INIT variants.

The reserved opcode space (§"Opcode space reservation") includes slots for governance and treasury operations; the v1 mechanism is intentionally minimal and does not depend on those for correctness.

Reference impl: `tests/amm-protocol-fee.mjs` (math, crystallization, claim message construction); `tests/amm-validator.mjs` (`validateProtocolFeeClaim`). Parity suite: `tests/amm-protocol-fee.test.mjs` (31 tests covering math, codec, and adversarial paths).

## Forward compatibility (V1 → V2 evolution path)

V1 of the AMM is intentionally a V2-style full-range constant-product model. The protocol is **forward-compatible**: future versions ship as additive ceremonies that coexist with V1, never replace or mutate it. This subsection documents what's locked, what's extensible, and what to expect when V2 lands.

### What's immutable post-V1-ceremony

Once a V1 pool is created via `POOL_INIT`:

- The pool's `vk_cid` is fixed. Its proofs verify under the V1 verifying key forever.
- The pool's `fee_bps` is fixed.
- The pool operates with **full-range** liquidity semantics. Every LP earns proportional fees on every trade; no tick concept.
- LP shares are fungible: same `lp_asset_id` per pool.
- The pool's `(asset_A, asset_B)` pair and canonical ordering are fixed.
- The three ceremony-locked V1 opcodes (`T_LP_ADD`, `T_LP_REMOVE`, `T_SWAP_BATCH`) interact only with V1 pools using V1 wire formats. The non-ceremony V1 opcodes (`T_INTENT_ATTEST`, `T_PROTOCOL_FEE_CLAIM`, `T_SWAP_VAR`) are version-agnostic at the wire-format level — they work against V1 pools but their semantics also apply to V2 / future versions without re-spec.

**V1 pools never auto-upgrade.** A V1 LP can hold their `lp_asset_id` UTXO indefinitely; the V1 pool will continue accepting V1-shape swap batches and crediting V1-shape LP withdrawals as long as anyone runs a V1 indexer. No protocol-level deprecation; no forced migration.

This matters for ceremony participants: contributors to the V1 Phase 2 ceremony are committing to one specific circuit. The verifying key derived from that ceremony serves V1 pools forever. Future versions are separate ceremonies that don't affect V1's contributions.

### Versioning hooks built into the protocol

Every domain tag in the AMM is explicitly versioned:

```
"tacit-amm-pool-v1"           → pool_id derivation
"tacit-amm-lp-v1"             → lp_asset_id derivation
"tacit-amm-bjj-H-v1"          → NUMS generator H_BJJ
"tacit-amm-bjj-G-v1"          → NUMS generator G_BJJ
"tacit-amm-xcurve-v1"         → sigma cross-curve challenge
"tacit-amm-intent-v1"         → intent_msg domain (T_SWAP_BATCH)
"tacit-amm-swap-var-v1"       → T_SWAP_VAR intent_msg domain (per-trade variable-amount mode; kernel sig reuses `tacit-kernel-v1` from CXFER)
"tacit-amm-swap-var-receipt-v1" → T_SWAP_VAR receipt-blinding HMAC keystream (r_receipt derivation)
"tacit-amm-swap-var-recv-v1"  → T_SWAP_VAR receipt-address derivation (fresh P2WPKH per intent)
"tacit-amm-swap-var-change-v1" → T_SWAP_VAR change-blinding HMAC keystream (fresh r_change derivation + on-chain recovery)
"tacit-amm-swap-var-tip-v1"   → T_SWAP_VAR settler-tip blinding HMAC keystream
"tacit-intent-attest-v1"         → T_INTENT_ATTEST signature domain
"tacit-amm-launcher-gate-v1"  → launcher gate signature
"tacit-amm-min-liq-blind-v1"  → MINIMUM_LIQUIDITY blinding
"tacit-amm-qset-v1"           → arbiter qualifying-set hash
"tacit-amm-receipt-secp-v1"   → receipt blinding (secp side)
"tacit-amm-receipt-bjj-v1"    → receipt blinding (BJJ side)
```

A V2 deployment uses `-v2` variants of the relevant tags, producing entirely different SHA-256 outputs. So:

- `pool_id_v2 = SHA256("tacit-amm-pool-v2" || asset_A || asset_B)` is distinct from `pool_id_v1` for the same pair. Both pools coexist on chain with different `pool_id` values.
- `lp_asset_id_v2 = SHA256("tacit-amm-lp-range-v2" || pool_id_v2)` is distinct from `lp_asset_id_v1`. LP shares from V1 and V2 pools cannot be confused.
- New cryptographic primitives in V2 (e.g., new NUMS generators if the curve changes) get their own `-v2` derivations.

### Opcode space reservation

The AMM occupies opcodes `0x2D`–`0x32` in V1 (`0x2D`–`0x31` live in `SPEC.md` §§5.14–5.18; `0x32` reserved here for `T_SWAP_VAR`, draft amendment pending merge). The remaining opcode space is open for forward extensions. Suggested allocations for V2+ (not normative, not yet implemented):

```
V1 ceremony-locked (Groth16 circuits frozen at the V1 ceremony):
  0x2D  T_LP_ADD                full-range LP deposit (uses lp_add circuit)
  0x2E  T_LP_REMOVE             full-range LP withdrawal (uses lp_remove circuit)
  0x2F  T_SWAP_BATCH            batched uniform-price settlement (uses swap_batch circuit;
                                fixed-amount, MEV-resistant via batch-auction privacy)

V1 non-ceremony (no Groth16; safe to add post-ceremony without re-running it):
  0x30  T_INTENT_ATTEST            preconfirmation worker attestation (BIP-340 sig only)
  0x31  T_PROTOCOL_FEE_CLAIM    mint accrued protocol fee to founder-pinned recipient
                                (Pedersen opening + BIP-340 sig)
  0x32  T_SWAP_VAR              per-trade against-curve fill, variable-amount [Y,X] range
                                (reuses CXFER N=2 crypto from T_AXFER_VAR; no batch proof;
                                public amounts; specified in SPEC-SWAP-VAR-AMENDMENT.md)

V2 (hypothetical concentrated-liquidity extension):
  0x33  T_LP_ADD_RANGE          deposit liquidity within [lower_tick, upper_tick]
  0x34  T_LP_REMOVE_RANGE       burn a range LP position
  0x35  T_LP_REPOSITION         atomic burn+remint of a range position at new ticks
  0x36  T_LP_MIGRATE_V1_TO_V2   atomic burn of V1 share + mint of V2 full-range position
  TBD   T_SWAP_BATCH_RANGE      batched settlement against tick-walking liquidity
                                (different circuit, fresh ceremony; slot TBD post-V2)

Note: 0x37–0x42 are claimed by other amendments (T_AXFER_VAR 0x37,
T_WRAPPER_ATTEST 0x38, oracle + cBTC + cUSD 0x39–0x42 per the
cUSD CDP amendment), so V2-AMM range work past 0x36 must claim
fresh slots at the time of that amendment.
```

A pre-`T_SWAP_VAR` indexer happily ignores unknown opcodes (`0x32+`); upgrading to support `T_SWAP_VAR` adds the per-trade variable-amount validator branch, and upgrading to support V2 range-LP means the indexer learns to parse and validate `0x33+` against the V2 circuit's vk. V1 pools and the live V1 opcodes (`0x2D`–`0x31`) are unaffected; `T_SWAP_VAR` (`0x32`) is a draft amendment additive to the live V1 set.

### Migration paths for V1 → V2 LPs

When V2 ships, a V1 LP has three options:

1. **Stay put.** V1 pool keeps operating with V1 semantics. The LP earns V1-style fees on V1 swap batches. No action needed.

2. **Manual migration (two transactions).** LP issues `T_LP_REMOVE` on the V1 pool (recovers `(R_A, R_B)`-proportional assets), then `T_LP_ADD_RANGE` on the V2 pool with desired range. Costs two Bitcoin tx fees and momentary slippage exposure.

3. **Atomic migration (one envelope).** A V2 opcode `T_LP_MIGRATE_V1_TO_V2` burns a V1 share UTXO and mints an equivalent V2 full-range position UTXO in one transaction. No slippage exposure. Requires the V2 ceremony to include a migration circuit.

After migrating to V2, the LP can use `T_LP_REPOSITION` freely (a V2 opcode, no new ceremony per use) to change their range. Atomic burn-and-remint within the V2 circuit.

### How indexers handle multi-version coexistence

Indexers maintain version-tagged state:

```
pools: Map<pool_id, PoolState>
  // pool_id distinguishes V1 vs V2 via its domain tag
asset_id_origins: Map<asset_id, OriginInfo>
  // three-origin resolution extends to four+: CETCH, T_PETCH, V1-LP, V2-LP, ...
verifying_keys: Map<vk_cid, GrothVK>
  // V1 and V2 vk's pinned at their respective pool inits
```

The §5.5 validator dispatch grows new branches for V2 opcodes. Existing V1 branches remain byte-identical; V1's `validateLpAdd` / `validateLpRemove` / `validateSwapBatch` never change. Any indexer running V1 code can keep doing so; V2-aware indexers add new branches without touching V1's.

### Preconfirmation layer is forward-compatible

`T_INTENT_ATTEST` (opcode `0x30`) is **version-agnostic** — it just commits a SHA-256 hash over an open intent set. The linear-hash commitment (sort intent_ids lex-ascending, hash the concatenation) and signature domain (`tacit-intent-attest-v1`) work for any AMM version that maintains an intent pool, including V2's range-aware swap batches. A future amendment can swap in a vector commitment (KZG/FRI) for large-pool regimes without changing the on-chain wire format.

A worker serving both V1 and V2 pools can use the same attestation infrastructure for both. The opcode's wire format doesn't need to change between versions. Soft-confirm UX for traders is identical regardless of whether their target pool is V1 or V2.

If a future version introduces a different intent shape entirely (e.g., V3 with hooks), a new attestation opcode `T_INTENT_ATTEST_V3` could be added — but the existing `T_INTENT_ATTEST` continues to serve V1 and V2 unchanged.

### Net statement

The V1 ceremony commits to a specific R1CS and produces a specific verifying key. That commitment is permanent and serves V1 pools forever. The protocol is designed so future capabilities (concentrated liquidity, weighted multi-asset pools, custom hooks, alternative curves) ship as additive opcodes and ceremonies, coexisting with V1 rather than replacing it.

LPs and ceremony participants can be confident that signing up for V1 doesn't pre-commit them to any future direction — V1 just keeps working with V1 semantics, and they can voluntarily migrate to future versions when they want those features.

## Worker / relay threat model

The worker is a **message relay**, not a custody intermediary or
privacy intermediary. Its capabilities and limits, explicitly:

**What a malicious worker CAN do:**
- **Drop messages.** Refuse to forward intents, refuse to forward
  settler claims, refuse to forward openings or sigs. Pure DoS.
- **Reorder or delay messages.** Same DoS surface, slightly
  different shape. A worker that consistently delays one
  trader's messages can deny them inclusion in the next block.
- **Log ciphertext.** The encrypted opening blob and encrypted
  signature payload are visible to the worker as ciphertext.
  The worker cannot decrypt either (the opening is encrypted to
  the settler's pubkey; the sig is encrypted to the worker only
  insofar as the dapp chooses to route through TLS, which is
  separate). Logging ciphertext lets the worker reconstruct
  *connection topology*: which trader pubkey is talking to which
  settler pubkey, and when.
- **Learn intent metadata.** Direction, pool_id, min_out, tip,
  expiry, input_utxos, receive_scriptPubKey, trader_pubkey,
  C_in_secp, C_in_BJJ — all public inputs to the canonical
  intent_msg are visible to the worker. Per-trader cleartext
  amounts are NOT visible — they're hidden by Pedersen commitments.
- **Front-run a settler's claim.** A worker observing an inbound
  settler claim could publish its own competing claim to a
  conspiring settler. Mitigations: workers SHOULD be permission-
  less + replicated; settlers SHOULD multi-home to several
  workers; trust-conscious traders SHOULD self-host.

**What a malicious worker CANNOT do:**
- **Decrypt opening blobs.** Encrypted to the settler's pubkey
  via ECDH + AEAD; worker has neither key.
- **Forge intent_sigs.** BIP-340 under `trader_pubkey`.
- **Forge settler-side cross-curve sigma proofs.** Requires
  knowledge of the trader's blindings, which the worker doesn't
  have.
- **Broadcast invalid batches that confirm as tacit-valid.**
  Indexer determinism + cryptographic verification rules out
  any malformed batch.
- **Cause trader UTXOs to be burned.** The envelope_hash binding
  in `vout[0]` OP_RETURN + `SIGHASH_ALL` makes burn-grief
  structurally impossible (see Cross-asset authorization for
  swaps).

**Mitigations available to the protocol:**
1. **Multi-worker fallback.** Trader dapps SHOULD register
   intents with ≥ 2 independent workers; settlers SHOULD scan ≥
   2 workers. Single-worker dependence is a deployment choice,
   not a protocol requirement.
2. **Self-hosting.** The worker is `worker/src/index.js` ~few
   hundred LOC; trust-conscious participants run their own.
3. **Peer-to-peer relays.** The relay role is a Nostr-style
   pubsub primitive in principle; v1 ships a centralized worker
   for UX but the protocol is relay-agnostic.
4. **Encrypted ciphertext only.** No cleartext openings or sigs
   ever pass through the worker.

The worker is the operational dependency analog of the mixer's
worker (SPEC §8): cannot make invalid valid, can refuse service,
and is replaceable.

## Benchmarking methodology + pass criteria

The cryptographic claims rest on circomlib's published
BabyJubJub performance + standard sigma-protocol primitives, both
shipping in production codebases elsewhere. Empirical validation
before mainnet should measure:

**Sigma cross-curve binding (per-intent and per-receipt).**
- Target: < 1 ms prove, < 2 ms verify, on a modern laptop (Apple
  M-series or equivalent x86).
- Method: implement in pure JS using `@noble/curves` for both
  secp256k1 and BabyJubJub; benchmark 1000 iterations.
- Pass criterion: median < target; 99th percentile < 3× target.

**Groth16 batch proof for T_SWAP_BATCH, N = 16.**
- Target: < 10 s prove on a modern laptop, < 50 ms verify.
- Method: `amm_swap_batch.circom` compiled with circom 2.1.6+
  (shipped at `dapp/circuits/amm/`); BJJ Pedersen openings use
  circomlib's **fixed-base** `EscalarMulFix` against the pinned
  NUMS bases (~5K constraints per opening, ~5× cheaper than
  variable-base `escalarmulany`). Trusted setup uses snarkjs
  Phase 1 from the same Polygon Hermez ceremony as the mixer,
  but a larger pot file: **pot18** (262,144 constraints) instead
  of pot14, sized for the batch circuit's 172K constraints.
- Pass criterion: constraint count ≤ 300K (achieved: **172,158**);
  median prove < 10 s on M-series; median verify < 50 ms;
  empirical wall-clock benchmark pending Phase 1 ptau download.

**Worker + dapp end-to-end (RTT 1 + RTT 2).**
- Target: < 3 s total wall-clock from settler claim to all
  signatures collected, N = 16 traders, all online.
- Method: spin up `worker/src/index.js` locally, simulate 16
  trader dapps over websockets, measure claim → broadcast time.
- Pass criterion: median < 3 s; 99th percentile < 8 s.

**Reorg-recovery time at depth 3.**
- Target: < 30 s to re-derive pool state after a depth-3 reorg
  affecting one pool.
- Method: regtest harness with manual block re-org; measure
  indexer's catch-up latency.

If any target is missed by more than 2× empirically, the spec is
NOT frozen. The mixer's analogous benchmarks all passed on the
first pass; AMM's expected to as well, given the design uses the
same primitives at similar scale.

## Status

Legend: ✅ shipped (reference implementation + tests pass) · 🟡 design
final, implementation in progress · ⏸ design complete, implementation
pending · 🔴 design open.

- ✅ **BabyJubJub primitives + NUMS generators.** Field arithmetic
  (BN254 Fr), Edwards-form point ops, Tonelli-Shanks sqrt,
  packed-point encoding (circomlib `packPoint` parity), and the
  try-and-increment NUMS derivation for `H_BJJ` / `G_BJJ`.
  Canonical generator coordinates pinned and tested. See
  `tests/amm-bjj.mjs` and `tests/amm-bjj.test.mjs` (36 tests).
- ✅ **Sigma cross-curve binding library.** Camenisch-Stadler
  prover + verifier producing 169-byte proofs binding
  `(C_in_secp, C_in_BJJ)` to a shared u64 witness `a`. 128-bit
  Fiat-Shamir soundness, ≈ 128-bit statistical ZK, rejection-sampled
  α in `[0, 2^320 − 2^192)` to guarantee 40-byte `z_a` encoding. See
  `tests/amm-sigma-xcurve.mjs` and `tests/amm-sigma-xcurve.test.mjs`
  (30 tests including mutation rejection, range-check rejection,
  cross-pairing soundness, and a microbenchmark).
- ✅ **Deterministic clearing-solve algorithm.** SOLVE_CLEARING /
  SOLVE_A_TO_B_DOMINANT / SOLVE_B_TO_A_DOMINANT / SPOT_CLEARING /
  QUALIFYING_FIXED_POINT, plus LP-add/remove/init formulas and
  Newton's-method integer square root. BigInt-typed for u128/u256
  width. See `tests/amm-clearing.mjs` and
  `tests/amm-clearing.test.mjs` (31 tests).
- ✅ **Asset-id derivations + three-origin resolution.** `pool_id`,
  `lp_asset_id`, canonical asset-pair ordering, and the
  CETCH/T_PETCH/POOL_INIT resolution rule. See `tests/amm-asset.mjs`
  and `tests/amm-asset.test.mjs` (23 tests).
- ✅ **Receipt blinding derivation.** HMAC-anchored
  `(r_out_secp, r_out_BJJ)` seeds for swap receipts, LP-share
  receipts, and LP-withdraw two-leg receipts. Domain tags
  `tacit-amm-receipt-{secp,bjj}-v1`. See `tests/amm-receipt.mjs`
  and `tests/amm-receipt.test.mjs` (21 tests).
- ✅ **Mixer-style kernel sigs for T_LP_ADD / T_LP_REMOVE.**
  Per-asset kernel_msg construction, signing-key derivation
  `(Σ C_in,X − Δx·H).x_only()`, sign + verify with BIP-340
  parity adjustment. Mimblewimble balance check structurally
  prevents inflation. See `tests/amm-kernel.mjs` and
  `tests/amm-kernel.test.mjs` (15 tests).
- ✅ **MINIMUM_LIQUIDITY NUMS burn-output.** Deterministic `r_burn`,
  amount keystream, Pedersen commitment, NUMS recipient via
  try-and-increment, aggregate verify path. See
  `tests/amm-min-liq.mjs` and `tests/amm-min-liq.test.mjs`
  (23 tests).
- ✅ **Intent message + envelope_hash + qualifying_set_hash +
  cancel.** Canonical intent_msg with all 12 committed fields,
  intent_id derivation, BIP-340 sign/verify, cancel_msg,
  envelope_hash, arbiter-signed qualifying-set list. See
  `tests/amm-intent.mjs` and `tests/amm-intent.test.mjs`
  (26 tests).
- ✅ **JCS canonicalization + launcher gate extraction.** RFC 8785
  canonical JSON (sorted keys, no whitespace, deterministic numbers)
  with `tacit_amm_launcher` field extraction and conservative-default
  "no gate" on any malformation. See `tests/amm-jcs.mjs` and
  `tests/amm-jcs.test.mjs` (32 tests).
- ✅ **Envelope encoders/decoders.** Wire-format round-trip for
  T_LP_ADD (variants 0 and 1), T_LP_REMOVE, T_SWAP_BATCH (with
  optional arbiter block). Strict length checks, ordering
  enforcement, malformed-payload rejection. See
  `tests/amm-envelope.mjs` and `tests/amm-envelope.test.mjs`
  (25 tests).
- ✅ **Indexer validator reference impl.** `validateLpAdd`,
  `validateLpRemove`, `validateSwapBatch` mirroring SPEC §5.5
  branches. Full pipeline: decode → kernel sigs → sigma proofs →
  Pedersen aggregate check → constant-product invariant →
  state transition. Includes OP_RETURN envelope_hash binding,
  arbiter-block handling, intent-id ordering, expiry, and
  three-origin asset-id resolution. See `tests/amm-validator.mjs`
  and `tests/amm-validator.test.mjs` (18 tests).
- ✅ **SPEC.md normative additions.** §3.9 BabyJubJub primitives +
  pinned NUMS vectors. §3.10 sigma cross-curve binding protocol.
  §4.1 LP-share third asset-id origin path. §5.5 validator
  algorithm extension (five new opcode branches: T_LP_ADD,
  T_LP_REMOVE, T_SWAP_BATCH, T_INTENT_ATTEST, T_PROTOCOL_FEE_CLAIM;
  plus the T_SWAP_VAR branch from
  [`SPEC-SWAP-VAR-AMENDMENT.md`](./SPEC-SWAP-VAR-AMENDMENT.md)).
  §5.14 / §5.15 / §5.16 wire formats for T_LP_ADD / T_LP_REMOVE /
  T_SWAP_BATCH (T_INTENT_ATTEST + T_PROTOCOL_FEE_CLAIM nested under
  §5.16; T_SWAP_VAR merges as §5.16.3).
  §6 receipt recovery path 10 (AMM receipts). §11.1 AMM
  determinism rules.
- ✅ **Groth16 circuits — pre-ceremony hardened.** Compiled, constraint-
  budgets verified, witnesses generate end-to-end for honest inputs, 28
  adversarial attack-vector cases all rejected, independent pre-ceremony
  review pass complete (see `dapp/circuits/amm/REVIEW.md`):
  - `dapp/circuits/amm/bjj_pedersen.circom` — shared PedersenBJJ template
    using circomlib's **fixed-base** `EscalarMulFix` against the pinned
    NUMS generators. ~5K constraints per opening (5× cheaper than the
    variable-base `escalarmulany` estimate in the original draft, because
    H_BJJ and G_BJJ are compile-time constants).
  - `amm_lp_add.circom` — **5,153 constraints** (budget 30K). Single PedersenBJJ
    opening binding share commitment to public `share_amount`.
  - `amm_lp_remove.circom` — **10,369 constraints** (budget 30K). Two PedersenBJJ
    openings (asset-A and asset-B receipts).
  - `amm_swap_batch.circom` — **172,158 constraints** (budget 300K) for
    `N_MAX = 16`. Per-intent input opening + tip binding + per-receipt
    output opening at the in-circuit-derived clearing price `P_clear`
    (computed from private aggregates X, Y of A→B and B→A inputs to match
    the deterministic clearing-solve formula in §4 of "Implementation
    specification" — `X / (Y + |Δb_net|)` for A-dom, symmetric for B-dom,
    `R_A_pre / R_B_pre` for spot). Plus min_out check via GreaterEqThan(64),
    aggregate tip-by-direction sum check, direction discrimination via
    delta-net sign bits, spot-sign canonicalization, in-circuit fee_bps
    cap at 1000, and division-with-remainder enforced via `LessThan(70)`
    with explicit `Num2Bits(70)` on both operands (closes the worst-case
    completeness gap surfaced in pre-ceremony review). **No non-native
    secp256k1 EC arithmetic anywhere inside the circuit.**
  - Build script + constraint-budget validator at `dapp/circuits/amm/build.sh`.
  - Witness-generation correctness suite at
    `dapp/circuits/amm/witness-test.mjs` (9 tests).
  - Adversarial attack-vector test suite at
    `dapp/circuits/amm/adversarial-test.mjs` (28 tests covering direction
    forgery, tip binding bypass, amount_out floor manipulation, padding
    exploitation, spot/non-spot discrimination, fee_bps cap, min_out
    violation, Pedersen commitment swaps).
  - Pre-ceremony drift guard at `dapp/circuits/amm/drift-guard.test.mjs`
    — pins SHA-256 hashes of all 4 `.circom` sources + all 3 compiled
    `.r1cs` files + constraint-count fingerprints. Wired into
    `build.sh` so any inadvertent edit during ongoing product work fails
    the build with a clear pointer to update pins + plan a new ceremony.
    Catches ceremony-invalidating drift at build time.
- ✅ **Preconfirmation layer (T_INTENT_ATTEST, tacit channel for soft-confirm UX).**
  Worker maintains the open-intent set off-chain, publishes the sorted
  list periodically, and broadcasts `T_INTENT_ATTEST` envelopes on chain
  carrying `intent_pool_hash = SHA256(canonical-sorted intent_ids)`
  (~every ~30 s). Trader's dapp fetches the published list, verifies
  the hash matches on-chain, verifies their intent_id is in the list,
  verifies worker_sig + freshness ⇒ "soft confirmed" status within ~30 s
  of intent post. Settlement still happens via T_SWAP_BATCH / T_SWAP_VAR
  at the block clock (~10 min); if the preconf layer is offline or
  compromised, traders fall back to self-broadcast (T_SWAP_VAR) or
  ~10 min Bitcoin finality. Multi-worker fallback; unconditional
  unilateral exit; no single point of failure for soundness. See
  `tests/amm-attest.mjs` and `tests/amm-attest.test.mjs` (32 tests covering
  intent_pool_hash construction, envelope codec, worker_sig verification,
  equivocation detection, multi-worker independence, soft-confirm
  verification with stale / forged / untrusted / equivocator status
  discrimination; tests require update to swap SMT proof verification
  for full-list rehash verification — implementation work, not
  consensus-relevant).
- ✅ **End-to-end harness (closes the circuit ⇄ indexer ⇄ chain-state loop).**
  Mock Bitcoin chain + asset etching + LP/Trader/Settler actors + production-
  shape indexer + (optional) real circom witness calculation. Exercises six
  scenarios:
  - Full lifecycle: POOL_INIT → LP_ADD (second LP) → multi-trader swap →
    LP_REMOVE. Verifies pool state at each step and chain-side aggregate
    Pedersen balances exactly.
  - Receipt recovery: trader recovers swap-receipt amount + blinding from
    privkey + on-chain anchor outpoint alone.
  - Spot batch: intents cancel exactly at spot ratio; reserves unchanged;
    settler outputs `direction: 'spot'`.
  - min_out drop: deterministic clearing iteration excludes intent whose
    `min_out` is unsatisfiable; surviving intent settles cleanly.
  - Reorg recovery: chain rewind past confirmed swap; indexer reset to
    snapshot height.
  - Actual circom witness calculation: real `amm_swap_batch.wasm` accepts
    the witness inputs produced by the e2e pipeline for a 2-trader batch.
  See `tests/amm-e2e-harness.mjs` + `tests/amm-e2e.test.mjs` (6 scenarios).
- ⏸ Phase 2 ceremony coordination (reuses mixer's coordinator)
- ⏸ Browser-side prover + verifier (reuses mixer's snarkjs vendoring)
- ⏸ Worker as message relay (websocket fanout between trader dapps
  and settlers; no opening-blob or signature escrow in v1)
- ⏸ Worker `qualifying-intents/:height` endpoint (content-addressed
  list under pool-pinned `inclusion_arbiter_pubkey`; `T_SWAP_BATCH`
  envelope carries the list's `qualifying_set_hash` + `arbiter_sig`
  so chain commits to which list was canonical)
- ⏸ Trader dapp interactive PSBT auto-signing flow (validate
  candidate batch locally; auto-sign `SIGHASH_ALL` + encrypt
  opening to settler pubkey)
- ⏸ Dapp UI (pool browser, LP add/remove, swap intent posting,
  cancel)
- ⏸ End-to-end regtest harness (commit + reveal pair, full settler
  flow against a regtest Bitcoin node + regtest indexer)
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
- **Circuit cost is mixer-tier.** Cross-curve binding is a
  SNARK-free sigma protocol (~169 B wire, microseconds
  prove/verify). The Groth16 batch proof does native BabyJubJub
  Pedersen openings in-circuit via `EscalarMulFix` against the
  pinned NUMS bases (~5K constraints each) plus per-trader
  division-with-remainder, range checks, and aggregate tip sums.
  For `N_MAX = 16` inputs + 16 receipts the batch circuit is
  **172,158 constraints** post-hardening — fits comfortably in
  pot18 (262K constraint ceiling). Anticipated ~5–10s browser
  proving on a modern laptop, ~30s on mid-range mobile (empirical
  benchmark pending). `N_MAX = 16` is governed by UX latency
  (settler collecting RTT-2 sigs within a block) and Bitcoin tx
  vbyte budget, not by circuit cost; v2 deployments can push
  higher with a fresh ceremony. The original cryptographic risk
  ("non-native secp256k1 inside BN254 might be ~600K–1M constraints
  per opening") is resolved by construction — no in-circuit secp
  EC arithmetic anywhere.
- **First-LP price-setting.** Whoever runs `POOL_INIT` sets the
  initial price (ratio `Δa_init / Δb_init`). `MINIMUM_LIQUIDITY`
  defends against the share-dilution / donation-inflation attack
  (Uniswap V2's classic problem), but it does NOT defend against the
  misprice attack: a malicious first depositor can seed at any ratio
  and a naive second depositor at that ratio gets imprice-extracted
  by arbitrageurs before any further LP correction.
  Mitigations, in order of strength:
  - **Dapp-side warnings (mandatory).** Reference dapp implementations
    MUST surface "low-TVL pool — initial price may be mispriced; check
    spot vs orderbook/oracle before swapping or adding liquidity" on
    any pool below a TVL threshold the dapp picks (suggested:
    USD-denominated, configurable per-network — e.g., `< $10k` on
    mainnet, `< 0.01 BTC` if no fiat oracle). The threshold lives in
    dapp config, not protocol state; lifting it post-launch doesn't
    require a ceremony.
  - **Orderbook cross-check (V1 mechanism).** Since the orderbook DEX
    runs alongside the AMM (see "Relationship to the orderbook DEX"
    above), a mispriced AMM pool is corrected by any arbitrageur
    routing orderbook fills against it. The misprice window is
    bounded by the time-to-first-arbitrage, not by LP behaviour.
  - **Oracle cross-check (V2+ when oracle ships).** The canonical
    cUSD work (`SPEC-CUSD-CDP-AMENDMENT.md`) introduces a
    protocol-level oracle that the dapp can consult to flag any pool
    deviating from oracle price by more than a configured threshold.
    Not in V1's critical path.
  - **Not adding a min-TVL gate at POOL_INIT.** Considered and
    rejected: gating POOL_INIT on TVL doesn't compose with permissionless
    pool creation and would block legitimate new-asset bootstrapping.
    The defence belongs in the trader surface (the dapp), not in the
    indexer rules.
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
