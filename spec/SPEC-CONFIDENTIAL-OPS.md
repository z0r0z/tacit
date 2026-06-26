# Confidential-pool ops — canonical opcode table (Ethereum lane)

> **Status:** v1. This is the `§1.1`-analog for the **cross-chain confidential
> pool**: the op set the SP1 settle guest verifies and `ConfidentialPool.sol`
> applies. It is the single source of truth for these opcodes; the normative
> implementation is the guest constants block at
> [`contracts/sp1/confidential/src/main.rs`](../contracts/sp1/confidential/src/main.rs)
> (lines ~31–88) — this table MUST agree with it byte-for-byte.

These ops live in a **separate namespace** from the Bitcoin-side wire opcodes
in [`SPEC.md` §1.1](../SPEC.md). Bitcoin ops are envelope bytes (`0x21`–`0x5E`)
carried in Taproot witnesses; confidential-pool ops are a `u8` op tag (0–30)
inside a proven settlement batch and never appear on a Bitcoin wire. They
touch the Bitcoin lane only at the four reflection seams noted below.

## Op table

| Op | Name | Status | Purpose |
|----|------|--------|---------|
| 0 | `OP_WRAP` | ✅ shipped | Public deposit → new shielded note (escrow the underlying). |
| 1 | `OP_TRANSFER` | ✅ shipped | n→m notes, hidden amounts (conservation kernel). |
| 2 | `OP_UNWRAP` | ✅ shipped | Note → public payout (opening-sigma binds recipient/amount/fee). |
| 3 | `OP_BRIDGE_BURN` | ✅ shipped | Ethereum note → Bitcoin: burn + emit cross-out (reflection seam). |
| 4 | `OP_BRIDGE_MINT` | ✅ shipped | Bitcoin burn → Ethereum note (verified by reflection). |
| 5 | `OP_COVENANT_MINT` | 🔒 reserved | Held for the Bitcoin-covenant era — escrow-free cBTC mint against a covenant-enforced lock. No handler (rejected as unknown until a future guest gen claims it). |
| 6 | `OP_SWAP` | ✅ shipped | Confidential AMM batch: hidden-amount swaps vs public reserves. |
| 7 | `OP_LP_ADD` | ✅ shipped | Add liquidity in-ratio → shielded LP-share note. |
| 8 | `OP_LP_REMOVE` | ✅ shipped | Burn LP-share note → withdraw the underlying. |
| 9 | `OP_OTC` | ✅ shipped | 2-party direct shielded swap (no pool). |
| 10 | `OP_BID` | ✅ shipped | Partial-fill buyer-offline limit order. |
| 11 | `OP_SWAP_ROUTE` | ✅ shipped | Multihop route through ≤ `MAX_ROUTE_HOPS` (4) pools. |
| 12 | `OP_ADAPTOR_LOCK` | ✅ shipped | Lock a note into the lock-set under (T, deadline, recipient). |
| 13 | `OP_ADAPTOR_CLAIM` | ✅ shipped | Claim a locked note before deadline, revealing the kernel `s`. |
| 14 | `OP_ADAPTOR_REFUND` | ✅ shipped | Refund a locked note to its locker after the deadline. |
| 15 | `OP_CDP_MINT` | ✅ shipped | Lock a collateral basket → mint a controller-derived debt note (**cUSD** is the first instance). Pricing/ratio policy lives in the mutable controller. |
| 16 | `OP_CDP_CLOSE` | ✅ shipped | Burn the exact debt → reclaim the basket (no oracle/veto). |
| 17 | `OP_CDP_LIQUIDATE` | ✅ shipped | Burn exact debt, seize basket (controller proves unhealthy). |
| 18 | `OP_CBTC_MINT` | ✅ shipped | Mint **cBTC** against a reflection-recorded self-custody lock (contract gates the lock + native-ETH escrow). This is V1's fungible-cBTC path. |
| 19 | `OP_CDP_TOPUP` | ✅ shipped | Consume an open position + append a replacement with a larger basket. |
| 20 | `OP_FARM_BOND` | ✅ shipped | Lock LP-share notes → a receipt note (shares, `rps_entry`). |
| 21 | `OP_FARM_HARVEST` | ✅ shipped | Prove receipt → bound reward, advance the receipt. |
| 22 | `OP_FARM_UNBOND` | ✅ shipped | Prove receipt → nullify, re-mint the LP-share notes. |
| 23 | `OP_STEALTH_LOCK` | ✅ shipped | Lock a note under the recipient's one-time pubkey (shared lock-set). |
| 24 | `OP_STEALTH_CLAIM` | ✅ shipped | Recipient claims via a BIP-340 sig under that one-time pubkey. |
| 25 | `OP_STEALTH_REFUND` | ✅ shipped | Locker reclaims an unclaimed lock after the deadline. |
| 26 | `OP_BRIDGE_STEALTH_MINT` | ✅ shipped | Bitcoin burn → Ethereum stealth lock (cross-chain confidential pay). |
| 27 | `OP_WRAP_TRANSFER` | ✅ shipped | Atomic wrap-and-send: a pending public deposit → hidden recipient (+ change) notes in one settle. |
| 28 | `OP_SEND_AND_UNWRAP` | ✅ shipped | Partial public exit: one hidden note → public payout + hidden change. |
| 29 | `OP_LP_BOND` | ✅ shipped | 1-click farm entry: `OP_LP_ADD` fused with `OP_FARM_BOND`. |
| 30 | `OP_WRAP_CDP_MINT` | ✅ shipped | 1-click cUSD: public deposit collateral → confidential debt note in one settle. |

Bytes 31–255 are free for a future guest generation. Byte 5 is reserved (do
not reuse). Every settled op balances through the same conservation kernel as
`OP_TRANSFER`, and any op may be relayed gaslessly with the fee bound in-proof.

## Tangent map — where this lane touches the Bitcoin SPEC

The two op namespaces are disjoint by encoding and meet only at these seams,
each with a single owner so they never silently disagree:

| Concept | Bitcoin lane (`SPEC.md`) | Confidential-pool lane (this table) | Bridge / owner |
|---|---|---|---|
| Cross-chain value | the burned Bitcoin envelope | `OP_BRIDGE_MINT` / `OP_BRIDGE_BURN` / `OP_BRIDGE_STEALTH_MINT` | `SPEC-BITCOIN-REFLECTION-AMENDMENT.md` (binds the existing envelope; adds no Bitcoin opcode) |
| cBTC | self-custody slots `T_SLOT_*` (`0x43`–`0x47`) | `OP_CBTC_MINT` (mints the fungible cBTC against a reflection-recorded slot lock + escrow) | reflection lock-fold; the slot is Bitcoin-side, the cBTC note Ethereum-side |
| cUSD | `T_CUSD_TAC_*` (`0x54`–`0x56`, drafted Bitcoin-lane, **not active in V1**) | `OP_CDP_MINT` / `OP_WRAP_CDP_MINT` (the **shipped** cUSD CDP) | the Ethereum-lane CDP is canonical for V1 cUSD |
| AMM / farms | `T_LP_*` / `T_SWAP_*` / `T_FARM_*` (`0x2D`–`0x3E`) | `OP_SWAP` / `OP_LP_*` / `OP_SWAP_ROUTE` / `OP_FARM_*` / `OP_LP_BOND` | parallel stacks, one per lane; same product semantics, distinct wire formats |

The Bitcoin-native fungible-cBTC lien family (`SPEC.md` `0x49`–`0x4F`, `0x57`–`0x5A`)
is **reserved, not active in V1** — V1's fungible cBTC is `OP_CBTC_MINT` above.

## Where the design lives

The model and trust framing are in
[`spec/SPEC-CONFIDENTIAL-POOL.md`](./SPEC-CONFIDENTIAL-POOL.md); the cross-lane
relay in [`spec/amendments/SPEC-BITCOIN-REFLECTION-AMENDMENT.md`](./amendments/SPEC-BITCOIN-REFLECTION-AMENDMENT.md);
the CDP/cBTC controller logic in `ops/DESIGN-confidential-defi-v1.md` and
`ops/DESIGN-cbtc-tac.md`. This table is the opcode index; the guest source is
the normative implementation.
