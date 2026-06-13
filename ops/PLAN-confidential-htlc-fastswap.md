# PLAN — Confidential HTLC fast-swap (fast finality for Bitcoin value on Ethereum)

> **STATUS: TABLED (decoupled).** v1 needs **no SP1 re-prove and no `ConfidentialPool`
> redeploy** — it is a standalone ERC20 HTLC escrow contract (a fresh, additive deploy) +
> Bitcoin Taproot scripts + app orchestration, plus the existing `wrap`. It can be added at
> any time without disturbing the proven/deployed confidential infra. Parked for now; this
> doc is the pickup point. (v2, the end-to-end-confidential legs, is the only part that would
> touch the guest + redeploy — explicitly the deferred follow-up.)

> **Goal.** Give a holder of Bitcoin-homed Tacit value **fast, final** value on Ethereum
> without waiting out the bridge (~6 Bitcoin confirmations + a prove cycle). The route is an
> **atomic swap**: the user trades their Bitcoin note for a liquidity provider's
> *already-Ethereum-native* value, hash/timelock-linked so neither side can cheat. The user
> gets fast final Ethereum value; the LP holds the Bitcoin note and absorbs the bridge lag,
> priced as a fee. This is **Route B** in
> [`ARCH-tacit-chain-abstraction.md`](./ARCH-tacit-chain-abstraction.md) — the near-term path
> that needs **no bridge change and no Mode B dependency**.
>
> Why an intermediary at all: final settlement of a Bitcoin spend requires Bitcoin
> confirmation, and async chains can't be synchronously consistent — so {fast, final,
> no-intermediary} can't all hold. The LP supplies the missing leg (capital fronted across
> the lag). The swap is atomic, so the LP takes a *timing* cost, not a custody risk.

## The atomic-swap mechanics

A hash preimage `R` (known to the user) with `H = sha256(R)` links the two legs; timeouts
`T_btc > T_eth` order the claims so the LP is always safe.

```
user (holds a Bitcoin-homed note, value v)              LP (holds Ethereum-native value v)
─────────────────────────────────────────              ──────────────────────────────────
1. agree (asset, v, fee, H) off-chain; user picks R, H = sha256(R)
2. LOCK Bitcoin leg: note → claimable by (LP with R) before T_btc, else refund user
                                                  ──▶  3. verify the Bitcoin lock, then
                                                       LOCK Ethereum leg: value → claimable
                                                       by (user with R) before T_eth (< T_btc),
                                                       else refund LP
4. CLAIM Ethereum leg with R  ◀──────────────────────  (R now public on Ethereum)
   → user has fast FINAL Ethereum value (~12s)
                                                  ──▶  5. CLAIM Bitcoin leg with R before T_btc
                                                       → LP has the note; it bridges/holds at leisure
```

**Safety (atomic, by construction):**
- If the LP never locks (step 3), the user refunds after `T_btc`. User locks first, so the
  LP commits only after seeing the user's lock.
- If the user never claims (step 4), both legs refund after their timeouts — no value moves.
- If the user claims (reveals `R`), the LP has until `T_btc > T_eth` to claim the Bitcoin
  leg with the now-public `R`. The timeout gap is the LP's guarantee.
- Same asset on both legs (X on Bitcoin ↔ X on Ethereum), so there is **no price risk** —
  the LP's only cost is locked capital over the bridge-lag window, which the fee covers.
- **Reorg note:** a deep Bitcoin reorg after step 5 is the standard HTLC consideration; set
  `T_btc` to clear the bridge's own confirmation depth so the LP's claim is buried before it
  bridges. Accept-and-document for the pilot (as tETH/AMM do), parameterized per asset/size.

## The two legs and their primitive needs

| Leg | What it needs | v1 (no ConfidentialPool/guest change) | v2 (end-to-end confidential) |
|---|---|---|---|
| **Bitcoin** | lock the user's value claimable by `(LP, R)` or `(user, T_btc)` | a Taproot HTLC on the **unwrapped asset** (script path `OP_SHA256 H OP_EQUALVERIFY <LP> OP_CHECKSIG` ∨ `<T_btc> OP_CLTV <user>`); confidentiality of this leg is dropped for the swap | a pool-recognized **HTLC-CXFER** envelope (the note stays confidential; the validator + reflection recognize the conditioned output) — a guest/validator change |
| **Ethereum** | LP value claimable by `(user, R)` or `(LP, T_eth)` | a standalone **ERC20 HTLC escrow** over the canonical token; the user `wrap`s the claimed ERC20 into `ConfidentialPool` afterward to restore amount privacy | an `OP_OTC`-derived **conditional swap** op (claim a confidential note on `R`) — a guest/contract change |

**v1 is entirely app + standalone-contract layer** (a small ERC20-HTLC escrow contract +
Bitcoin Taproot scripts + dapp/worker orchestration) — it touches neither `ConfidentialPool`
nor the SP1 guests. Amounts are visible at the HTLC boundary (like any wrap boundary); the
user re-wraps to regain confidentiality, and can mix after. **v2** moves both legs inside the
confidential note model (no boundary reveal) and is the richer follow-up — it requires guest
work and therefore coordinates with the reflection/settle guest owner.

## Reuse

- **`OP_OTC`** (the direct confidential-swap primitive) is the base the v2 Ethereum leg
  conditions on `R`; v1 uses a plain ERC20 HTLC escrow instead.
- **The bridge** (`bridge_burn` → `bridge_mint`) is how the LP eventually settles/replenishes
  the Bitcoin note it received — the fast-swap front-runs the bridge for the *user*, the LP
  runs the bridge on its own schedule.
- **The unified surface** (`dapp/unified-holdings.js`, `scanHoldingsUnified`) is the UX home:
  "move to Ethereum — fast (fee F) or bridge (free, slower)", routing to this swap or Route A.
- **The relayer/quote pattern** from the tETH bridge (the spec already names "fast-exit via
  atomic swap with LP (HTLC)") — the LP discovery/quote endpoint mirrors it.

## LP economics

- **Fee = cost of capital over the bridge-lag window + the bridge's own cost + a margin.** No
  custody risk (atomic), no price risk (same asset). The fee is a *time-value* charge.
- **Capital efficiency:** an LP can serve many swaps from one Ethereum float, refilling by
  bridging the accumulated Bitcoin notes in batches.
- **Exposure bound:** an LP that locks (step 3) and whose counterparty then abandons waits out
  `T_eth` to refund — bound this with a short quote TTL and the user-locks-first ordering, so
  an LP only commits capital against an already-locked counterparty leg.

## Coordination boundary

- **v1 is mine to own** (app + a standalone HTLC escrow contract; no `ConfidentialPool` /
  guest edits). It composes with the unified surface and the existing bridge.
- **v2 touches the SP1 guest / `ConfidentialPool`** (the confidential HTLC ops) — coordinate
  with the reflection/settle-guest owner; it rides a redeploy like any guest change.

## Open decisions

- **Quote / discovery protocol:** how the user finds an LP + gets a signed quote `(asset, v,
  fee, T_eth, T_btc, H-binding)`; reuse the bridge relayer endpoint shape.
- **Denominated vs exact `v`:** denominations improve the LP's anonymity-set + inventory
  management and keep the boundary uniform (privacy); exact amounts are simpler UX. Pick per
  asset.
- **v1 Bitcoin-leg confidentiality:** v1 drops it (plain-asset HTLC). Confirm that's
  acceptable for the pilot given the user re-wraps on the Ethereum side, or fast-track v2 for
  assets where the Bitcoin-leg reveal matters.
- **Timeout parameters** (`T_btc`, `T_eth`) per asset/size vs the bridge confirmation depth +
  the reorg posture.
- **Refund/abort UX:** the dapp must track the swap state machine (locked → claimed → settled
  / refunded) and drive the refund path on timeout.

## Phasing

1. **v1 contracts + scripts:** the ERC20 HTLC escrow (claim-on-`R` / refund-on-timeout) + the
   Bitcoin Taproot HTLC builder. Forge + node KATs (claim, refund, wrong-preimage reject,
   timeout ordering).
2. **Orchestration:** the dapp swap state machine (quote → lock → claim → settle/refund) + a
   worker LP-quote endpoint (mirrors the bridge relayer). Inert until an LP float is funded.
3. **Unified-surface entry:** the "fast move" option on the holdings/send surface, routing to
   the swap with the quoted fee vs the free-but-slow bridge.
4. **v2 (follow-up):** confidential both legs via the pool HTLC ops — guest work, coordinated +
   re-proven.
