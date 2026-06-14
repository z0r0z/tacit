# ARCH — Tacit as a chain-abstraction layer over Bitcoin + Ethereum

> The user-facing abstraction model: **Tacit is the layer; Bitcoin and Ethereum are
> settlement backends.** A holder thinks in *Tacit assets and notes*, not "BTC vs ETH."
> This is the layering doc [`ARCH-tacit-ethereum.md`](./ARCH-tacit-ethereum.md) viewed from
> the abstraction angle, updated for **bidirectional** reflection (forward live + reverse
> trustless, [`PLAN-eth-reflection-modeB.md`](./PLAN-eth-reflection-modeB.md)). It defines
> the normative coherence invariants and the **unified-surface contract** the app layer
> implements to.
>
> Normative sources it composes: `spec/amendments/SPEC-EVM-CONFIDENTIAL-TOKEN-AMENDMENT.md`
> (note model, canonical hub, B1–B6), `spec/amendments/SPEC-BITCOIN-REFLECTION-AMENDMENT.md`
> (forward reflection), `spec/amendments/SPEC-TETH-BRIDGE-AMENDMENT.md` (the first wrapped
> asset), `PLAN-eth-reflection-modeB.md` (reverse trustless reflection).

## The thesis

Every comparable cross-chain system makes the chain a first-class concept the user must
reason about (which bridge, which wrapped representation, which custodian). Tacit's
construction lets the chain recede: because one seed, one note, and one asset id already
span both chains, the protocol can present a **single Tacit layer** whose value happens to
settle on Bitcoin or Ethereum. Which chain a unit currently sits on is an implementation
detail — like which UTXO holds your balance.

This is not aspirational glue; it is four primitives that already exist, plus bidirectional
reflection that makes value movable both ways without the user choosing a rail.

## The four abstraction primitives (already built)

| # | Primitive | What makes it one object across both chains |
|---|---|---|
| 1 | **One identity** | A single wallet seed derives both lanes: Bitcoin `p2wpkhAddress(wallet.pub)` and EVM `deriveEvmAccount(wallet.priv, network)` (`dapp/evm-account.js:41`, domain-separated `"tacit-evm-account-v1"`, network-bound, one-way). One unlock, both chains; the user never manages two keys. |
| 2 | **One note** | A confidential note is a secp256k1 Pedersen commitment `C = a·H + r·G` (`H = NUMS("tacit-generator-H-v1")`), **byte-identical** on Bitcoin and Ethereum. Its spend identity is the chain-independent nullifier `ν = keccak(Cx‖Cy‖"spent")` (spec B3), so a spend serializes across both lanes. Same commitment, same range disclosure, same stealth address, both chains. |
| 3 | **One asset** | A shared `asset_id` binds an asset's Bitcoin etch, its EVM canonical ERC20 (`address = f(asset_id)`, CREATE2 fixed-initcode), and its confidential-note form. A "Tacit asset" is the id; its on-Bitcoin and on-Ethereum representations are faces of it, not separate tokens. Ticker is a non-unique label. |
| 4 | **One value, routable** | Value moves between lanes without leaving the system: **forward** (Bitcoin→Ethereum) via reflection + `bridge_mint` (live), **reverse** (Ethereum→Bitcoin) via Mode B trustless reflection + `T_CROSSOUT_MINT` (building). Each crossing is **source-consuming**, so a unit exists on exactly one lane at a time. |

## Coherence invariants (NORMATIVE)

These are the contract that keeps "one Tacit layer" sound, not just a UX veneer. All are
enforced by the SP1 guests + `ConfidentialPool`, not by the app layer:

1. **Cross-lane nullifier serialization.** A note spent on one lane cannot be re-spent on
   the other. The reflection prover maps a Bitcoin spend's `ν` into the Ethereum spent set;
   the EVM `settle` proves non-membership of every Bitcoin-homed input `ν` against the
   reflected `bitcoinSpentRoot` (spec B4). The same `ν` is the identity on both sides.
2. **Source-consuming value movement.** Value crosses only by consuming its source:
   Bitcoin→Ethereum burns the Bitcoin note into the relay-attested bridge-burn set and
   `bridge_mint`s exactly one Ethereum note per burned `ν` (spec B5); Ethereum→Bitcoin
   records a `crossOutCommitment` whose value the reverse-reflection fold mints as one
   Bitcoin note bound to that `destCommitment`. A unit is never live on both lanes.
3. **Conservation across the boundary.** Every crossing carries the commitment verbatim and
   re-proves conservation in-guest, so no value is created or destroyed by moving lanes
   (`v_mint == v_burn`; the kernel is re-checked).
4. **One trust root, no operator.** Both directions reduce to SP1 soundness + the immutable
   Groth16 verifier + Bitcoin PoW (forward anchor) + Ethereum sync-committee (reverse
   anchor). No admin, no oracle, no custodian, no swappable prover. The worker is an indexer
   that can never inflate, steal, or mislead — anyone re-derives.

## Bidirectional reflection — what changes

The forward-only design read as "Bitcoin is the sovereign arbiter, Ethereum a provisional
cache" (`ARCH-tacit-ethereum.md`). Mode B closes the loop **trustlessly**: a recursive
`eth-reflection` proof (an Ethereum beacon light client) is folded into the Bitcoin
reflection guest, so a cross-out recorded on finalized Ethereum mints a Bitcoin note with
**no one trusting the worker** — symmetric to how the forward bridge already works. Once
value is routable both ways at the same trust level, the global "sovereign" framing
dissolves into a **per-note home**.

### Finality is per-note (home lane), not global

There is no global "everything defers to Bitcoin" rule. Each note has a **home lane** — the
chain whose root proves its membership — and that lane's consensus is its finality:

- **Ethereum-native value** (factory-etched, ERC20-wrapped, or produced by an Ethereum op)
  proves against an EVM root → **Ethereum-final, full stop**; Bitcoin is never consulted.
  Value settled solely on the Ethereum AMM is not a "cache" of anything.
- **Bridged value** is **source-consuming**: `bridge_mint` burns the Bitcoin source and the
  minted Ethereum note is itself **not** Bitcoin-homed (it proves against an EVM pool root).
  Crossing a lane is a *move*, not a tether — once moved, value inherits the new lane's
  finality and stops deferring to the old one.
- **The only "defers to Bitcoin" case** is a still-Bitcoin-homed note *spent on Ethereum*,
  which the contract restricts to **nullifier-marking only** (`BtcHomedValueExitMustBridge`:
  no withdrawal / leaf / swap / LP). To *use* Bitcoin value on Ethereum you bridge it (→ it
  becomes Ethereum-native). A rich "spend Bitcoin value fast on Ethereum and reconcile back"
  fast lane needs a finality-gated shared nullifier set (a deferred enhancement that Mode B's
  bidirectional reflection is what makes buildable) and is not in the base design.

So the accurate statement: **each note inherits its home lane's finality; the home changes
when value bridges (source-consuming); and the *source chain's consensus arbitrates value
leaving it*** — Bitcoin PoW anchors the forward proof, the Ethereum sync-committee the
reverse. Neither chain is sovereign over the other's native value.

## Fast-finality routes for source-chain value

Moving a Bitcoin-homed note's value onto Ethereum trades among three properties — you can
have any **two of {fast, final, no-intermediary}**, never all three. The wall is
structural: a Bitcoin spend is final only at Bitcoin confirmation, and async chains can't be
synchronously consistent (the same note could be spent on Bitcoin inside the reflection
lag), so a pure single-tx *instant-final* route is impossible, not merely unbuilt.

| Route | Fast | Final | Intermediary | Trust | Status |
|---|---|---|---|---|---|
| A — bridge-then-op | once (slow) | yes | none | trustless | live |
| B — HTLC LP fast-swap | yes | yes | LP (capital) | trustless (atomic swap) | near-term |
| C — optimistic shared-nullifier lane | yes (provisional) | after window | none (bond + watchtower) | trust-minimized | Mode B-enabled |

- **A — bridge-then-op.** `bridge_burn` → `bridge_mint`; slow once (~6 conf + prove), then
  Ethereum-native and fast forever. The trustless floor.
- **B — HTLC LP fast-swap.** Atomically swap the Bitcoin note for an LP's already-
  Ethereum-native value (hash/timelock over the `OP_OTC` swap primitive). The user gets fast
  *final* Ethereum value; the LP holds the note and eats the bridge lag as a priced fee. No
  bridge change; needs LP liquidity + a confidential-HTLC construction. See
  [`PLAN-confidential-htlc-fastswap.md`](./PLAN-confidential-htlc-fastswap.md).
- **C — optimistic shared-nullifier lane.** Lift the `BtcHomedValueExitMustBridge` value
  restriction but make the Ethereum fast-spend provisional + bonded; a one-shot fraud proof
  (a conflicting Bitcoin spend of `ν`, provable via the relay) reverts it + slashes; final
  after the challenge window. **Mode B's bidirectional reflection is what makes the fraud
  proof constructible** (both chains' spends become trustlessly knowable). Fast provisional,
  bonded final, no LP capital; costs a window + bond + a 1-honest-watchtower assumption.

The clean non-optimistic, no-LP, single-tx fast *final* lane does not exist: any exclusive
"check-out to one lane" reduces to a slow Bitcoin action — i.e. back to route A.

## Confidential trading under the abstraction (AMM LP + OTC)

Plain value abstracts as **one object, relocatable** (a note is the same on both chains;
bridging *moves* it). LP positions and OTC orders cannot be single cross-chain objects,
because each binds something **chain-located**: an LP share is a stake in a *specific pool*
whose reserves sit on one chain; an order is collateralized by *home-located notes*. So for
trading the abstraction moves up a level — from the *object* to the **intent** ("provide
TAC/tETH liquidity", "sell TAC at X") and the **view**.

### AMM LP

| Dimension | Where it lands |
|---|---|
| **Unifies** | the asset/intent (same `asset_id` pair across venues); the **view** (one "my liquidity" portfolio over the Bitcoin confidential AMM, the EVM `OP_LP` pool, and the public Uniswap on the canonical ERC20); recovery (`lp_share_id` / `T_LP_ADD`/`T_LP_REMOVE` share notes are seed-recoverable); identity; per-venue finality (fees accrue on the pool's chain) |
| **Stays chain-located** | liquidity does **not** merge — a TAC/tETH pool on Bitcoin and one on Ethereum are separate pools with separate depth + price; arbitrage links them but they are not one price |
| **Unlock** | **cross-venue routing** — express "swap TAC→tETH" against the asset, route to the best of the venues (best execution); plus a unified LP-yield view |
| **Hard limit** | a true cross-chain AMM (one pool, reserves spanning chains) is the LP analog of the fast-finality trichotomy — *fragmented-but-fast* (separate pools, today) vs *merged-but-bonded/slow* (reflection-synced reserves, a research lift). Sound design: **per-venue pools + a routing layer + an LP-rebalancing layer** (the HTLC/bridge primitives keep venues balanced) |

### OTC orders

Same-chain is native — `OP_OTC` (atomic direct swap) and `OP_BID` (resting offline
partial-fill), funded by home-located notes. **Cross-chain OTC _is_ the HTLC swap**: an order
with maker on one chain and taker on the other is exactly a hash-timelocked atomic swap
(Route B's primitive generalized), so a resting cross-chain bid is a posted HTLC offer a
counterparty takes by revealing `R`. The cross-chain orderbook and the fast-swap are the
**same machinery**.

- **Unlock:** a **cross-chain confidential orderbook** — one orderbook view; same-chain fills
  native, cross-chain fills via HTLC; the maker quotes against the asset and the protocol
  matches a taker on either chain.
- **Constraint:** an order's collateral is a home-located note, so a cross-chain fill inherits
  the {fast / final / intermediary} trichotomy (instant cross-chain fills want an LP/relayer
  or a bonded lane).

### Surface extension + the generalization

The unified surface (`dapp/unified-holdings.js`) extends from *balances* to **categories** —
`balance | lp | order` — merged by `asset_id` (balances), `pool_id` + venue-lane (LP), and
`order_id` (orders; cross-chain ones flagged HTLC): "holdings + liquidity + open orders," one
venue-aware view. So the slogan generalizes — for value it is "one object, both chains"; for
LP/OTC it is **"one intent and one view across venues, with routing and HTLC bridging the
gaps."** Forcing LP/OTC into single cross-chain objects re-hits the async wall; per-venue
objects + a routing/HTLC layer + a unified view is the correct shape.

**Status:** the per-venue primitives exist (Bitcoin AMM/orderbook live; EVM
`OP_SWAP`/`OP_LP`/`OP_OTC`/`OP_BID` proven, pool gated on deploy). The unifying layer —
cross-venue routing, the cross-chain HTLC orderbook, the LP/order categories in the unified
view — is design, not built.

## The unified-surface contract (what the app layer implements)

The abstraction is only real if the surface presents it. Normative requirements for the
app layer (implemented in `dapp/`, `worker/`, run on Render):

- **One portfolio.** A holder sees a single balance per `asset_id`, equal to the sum of its
  lanes: `total = btcLane + ethLane`. The same asset's Bitcoin-side and Ethereum-side
  balances merge into **one row**, keyed by the shared `asset_id` — never two entries.
- **Lane breakdown is auditable, not primary.** The unified total is the headline; a
  per-asset breakdown (how much sits on each lane) is available but secondary. Because
  finality is per-lane, this breakdown *is* the finality breakdown — a split balance is
  partly Bitcoin-final, partly Ethereum-final.
- **Chain-agnostic operations.** Send / swap / bridge are expressed against the Tacit asset;
  the protocol routes settlement to the lane that holds the value (or moves it via §4).
- **One identity surface.** Both lanes derive from the single unlocked seed (primitive 1);
  the user is never asked which chain's key to use.

This contract is what `scanHoldingsUnified()` + the portfolio bar + `renderHoldings()`
satisfy (see the unified-surface work-stream).

## What is a backend detail (invisible to the user model)

- **Which lane a note currently lives on** — a routing fact, surfaced only in the auditable
  breakdown.
- **Gas / fees / settlement latency** — per-lane: Ethereum's ~12s vs Bitcoin's confirmation
  depth. A property of the lane a note currently sits on, surfaced in the lane breakdown,
  not a global asset property.
- **The wrapped representation** (canonical ERC20 vs Bitcoin etch vs confidential note) —
  faces of one `asset_id`, chosen by the operation, not by the user.
- **The bridge mechanics** (reflection roots, recursion, relay anchors) — trustless plumbing
  beneath the asset.

## Cross-references

- Layering + trust/finality detail: [`ARCH-tacit-ethereum.md`](./ARCH-tacit-ethereum.md).
- Note model / canonical hub / guest bindings B1–B6: `SPEC-EVM-CONFIDENTIAL-TOKEN-AMENDMENT.md`.
- Forward reflection: `SPEC-BITCOIN-REFLECTION-AMENDMENT.md`. Reverse (Mode B):
  `PLAN-eth-reflection-modeB.md` + [`DESIGN-mode-b-recursion.md`](./DESIGN-mode-b-recursion.md).
- First wrapped asset (the pattern generalized): `SPEC-TETH-BRIDGE-AMENDMENT.md`.
