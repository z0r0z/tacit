# PLAN — Walk-away limit bids via an opt-in watchtower

> **Status: design.** Delivers the "post a limit bid, close the tab, it fills
> in chunks, the unfilled part stays yours" UX on top of primitives that are
> sound today. The active bid path (`bid-intent`, SPEC §5.7.7) is unchanged;
> this adds an optional liveness helper that completes fills while the buyer
> is away. Buyer-offline pre-signed bids (`T_PREAUTH_BID` / `T_PREAUTH_BID_VAR`)
> stay parked behind their flags.

## Why a helper is needed

A limit buyer needs one guarantee: *I receive N units of the asset for my
sats.* On Bitcoin that quantity lives in a Pedersen commitment, which Script
and the sighash cannot observe — so a standalone pre-signature over the
funding UTXO cannot, by itself, tie "sats released" to "asset delivered."
(The seller-offline direction, SPEC §5.7.8 preauth-sale, works precisely
because its offline party only needs *sats*, which Bitcoin can bind to its own
payout.) Completing a buyer's fill while they're away therefore requires a
party that is **online at settlement time** and **checks delivery before
paying**. That party is the watchtower.

## Trust boundary (stated plainly)

The watchtower is a **liveness helper with bounded, opt-in custody** — not a
zero-trust construction:

- It holds a **hot key for one dedicated bid-funding UTXO only**, sized to the
  bid (`max_fill × price + fee budget`). The buyer's main wallet key is never
  shared.
- **Worst case (watchtower compromised/malicious): exposure is capped at the
  one dedicated bid UTXO** — the amount the buyer already chose to commit. The
  main wallet is untouchable.
- The dedicated UTXO is **self-reclaimable by the buyer** (key-path the buyer
  also holds, or a CSV branch after timeout), so a watchtower that goes dark or
  censors causes a *liveness* failure, never fund loss.
- The watchtower **verifies before it relays**: it completes a take only for a
  seller intent that delivers ≥ the agreed amount to the buyer's recipient
  (Pedersen opening checked against the buyer's `recipient_blinding`), at ≤ the
  bid's unit price, with correct change.
- The fill authorization is **private to the watchtower**, not a public record
  any party can pick up.

This is the same shape as a Lightning watchtower or a bounded exchange order:
opt-in, capped, self-reclaimable, main wallet isolated.

## Flow

1. **Post** — buyer creates a `bid-intent` (SPEC §5.7.7, signed, no funds
   committed) and a dedicated funding UTXO. Buyer hands the watchtower the
   dedicated hot key + the bid parameters + `recipient_blinding`.
2. **Walk away** — buyer closes the tab. The bid is discoverable like any
   `bid-intent`.
3. **Seller fills** — a seller publishes an atomic intent (SPEC §5.7.6 /
   §5.7.6.1) targeting the buyer's recipient for a chunk ≤ remaining.
4. **Watchtower completes** — on a verified intent, the watchtower funds the
   take from the dedicated UTXO and signs the take over the **full settlement**
   (SIGHASH_ALL — non-redirectable), then broadcasts. Remaining decremented.
5. **Done / expire** — when filled or expired, the buyer reclaims any
   unspent funding from the dedicated UTXO. "Refund of the unfilled portion" is
   automatic: it was never spent.

## Components

- **`fulfiller/buyer-watchtower.mjs`** — new daemon, mirrors the existing
  `auto-fulfil.mjs` scaffold (imports `dapp/tacit.js` under jsdom, drives the
  real take path; no crypto reimplementation). Per bid: poll targeted intents,
  verify (opening + price + recipient + change), complete the take, track
  remaining, stop at fill/expiry. Self-hostable; an optional hosted instance
  can be offered.
- **Dedicated funding UTXO** — v1: single-key UTXO whose key the buyer holds
  and copies to the watchtower (buyer reclaims by spending it). v2: P2TR with a
  watchtower take branch + a buyer CSV-timeout reclaim branch, so reclaim does
  not race the watchtower.
- **dapp UX** — a "complete while I'm away (watchtower)" toggle on the
  Place-a-bid form: generate the dedicated key, fund it, register with the
  chosen watchtower, show running/remaining + a one-click reclaim. Default
  remains the plain `bid-intent` (manual take).
- **Worker** — no consensus change. Optional: a thin registration record so a
  hosted watchtower can enumerate bids it is authorized for (the daemon can
  also read the existing `bid-intent` endpoints directly).

## Build order (signet-first)

1. `buyer-watchtower.mjs` against the existing `bid-intent` + atomic-intent
   endpoints, single-key dedicated UTXO, verify-before-take.
2. Signet e2e: post → close → watchtower fills 2 chunks → buyer reclaims
   remainder. Adversarial case: watchtower refuses an intent that under-delivers
   or over-prices.
3. dapp toggle + reclaim UX.
4. v2 timelock-reclaim script; optional hosted watchtower.
5. SPEC §5.7.7 amendment note: document the watchtower-completed bid as the
   offline-buyer path and the trust boundary above.

## Out of scope

A fully-offline, zero-infrastructure, zero-trust buyer bid for a confidential
asset is not constructible on today's Bitcoin: the asset quantity lives in a
Pedersen commitment that Script cannot introspect. The named covenant proposals
(CTV/CSFS/APO) do not change this — they constrain transaction structure (output
scripts, sat values, templates, signature rebinding), not the hidden commitment
value. A trustless version would require verifying a range/opening proof inside
Script (OP_CAT / STARK-class introspection), a much longer horizon; until then
the watchtower is the durable walk-away path.
