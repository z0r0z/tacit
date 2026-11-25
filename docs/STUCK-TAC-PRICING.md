# Stuck TAC: a pricing and policy rule (bounty option C)

**What this is.** A provider takes stuck TAC only at a fee that covers its expected haircut, by class — implemented as one
dependency-free module (`dapp/fastbridge-stuck.js`), a `policy.screen` built from it (`stuckScreen`, in the shape of `lineageScreen`
in `dapp/fast/wire.js`), and offline tests (`tests/fastbridge-stuck.test.mjs`, 9/9 passing). Nothing deployed changes; new terms
fields are optional, and a page or provider that does not know them keeps working unchanged.

## The rule

Notes are classed by the verdicts the bridge's own trace already gives (`vet`, as in `dapp/fast/wire.js`):

| class | verdicts | meaning |
|---|---|---|
| clean | `tracked`, `traced` | the burn proof follows it; it goes home |
| long | `long` | more transfers than the proof folds (255) |
| pool | `unprovable` | the proof does not follow it (shielded-pool exit, pool/farm trade) |

A lock is priced by its **worst** note. A note whose verdict is `unread` (or missing) has no class: the lock is refused with
`retry`, exactly as `lineageScreen` treats it — what cannot be read is not priced on a guess.

For a stuck class, the provider's fee is its ordinary fee (`feeOf`: a rate plus a flat part) **plus a premium**:

```
premium_bps(class) = haircut_bps(class) + margin_bps
```

Defaults, stated as assumptions a provider replaces with its own numbers: haircut **5%** for long (ordinary Bitcoin TAC with a long
past; it trades, to a smaller set of takers), **10%** for pool (it can never be followed, even by a proof that folds further, and its
takers are fewer), margin **2%** — so default premiums are **7%** (long) and **12%** (pool) of the amount, on top of the ordinary fee.

On top of pricing, a **limit**: a stuck take is refused when it would put more than a stated share of the provider's Bitcoin-side
holdings in stuck notes — **20%** by default. A provider at its limit keeps lending clean TAC and turns stuck TAC away. A class can
also be switched off entirely (`take: { pool: false }`), which reproduces today's screening behaviour for that class.

The provider advertises the premiums as an optional `stuckFees: { long, pool }` field in its terms (`advertisedStuckFees`). The page
already reads a lock's notes before building the lock, so the take a lock pays is the fee of its worst class; the provider's screen
is the backstop that refuses what its policy does not take at any price.

## Numbers: what a provider holds after N bridges

From the simulation in `tests/fastbridge-stuck.test.mjs` (deterministic, offline). A provider starts with 1,000,000 units of
Ethereum-side inventory and is offered 2,000 bridges of 10,000. Mix per 100 locks: 93 clean, 5 long (the brief's count: 230 of 4,546
notes past the fold on 2026-11-22), 2 pool (assumption, stated). A clean note takes ten bridges to come home and is lent again; a
stuck note stays on Bitcoin and is worth its face less its class's haircut when sold there. Ordinary fee 30 bps.

| provider | bridges served | stuck held (face) | stuck worth | fees kept | net vs start |
|---|---|---|---|---|---|
| takes any TAC, ordinary fee | 1,406 — then out of lendable TAC | 980,000 | 917,000 | 42,180 | +21,360 |
| prices by class (this rule) | 1,508 | 1,050,000 | 982,500 | 133,740 | +199,980 |
| prices + holds the 20% limit | 1,862 (+138 stuck refused) | 20,000 | 19,000 | 57,260 | +113,520 |

Reading them plainly: the unpriced provider's capacity runs out first, and the 63,000 haircut on its book is quietly paid out of the
fees its clean bridges earned. Pricing by class ends ahead of it on the same offers, is still lending after it stops (premiums
replenish inventory), and the premium income alone (88,500) covers the haircut on what it holds (67,500). The limit is the
conservative dial: it strands almost nothing (20,000 face, at most ~1,000 of haircut) and never runs dry, at the cost of turning
stuck holders away once the limit binds.

## What it assumes

- The haircuts (5% / 10%) are **assumptions, not measurements** — there is no deep market in stuck TAC to read them from today. The
  rule's claim is narrower than the numbers: *if* a provider's haircut estimates are right, the premium covers them with the margin
  over. A provider that has actually sold stuck TAC should put its own realised discounts in its policy.
- The mix (93/5/2) follows the brief's 2026-11-22 count for long notes; the pool share is an assumption.
- Fees are counted as value wherever they are kept (a take on Bitcoin or a smaller payout on Ethereum).

## Risks and what was not tested

- **A worse-than-assumed haircut still loses.** If pool TAC sells at 25% off, a 12% premium does not cover it. The limit is the
  protection that does not depend on the estimate: it bounds how much face can be stranded at all.
- **Premiums can price a provider out.** Holders may take a cheaper any-TAC provider that has not priced its risk. That is the
  market working as intended, but a provider should expect less stuck flow, not the same flow at a higher price.
- **Not tested against a live provider.** The module is pure and the screen is unit-tested against fake verdicts, but it has not
  been run inside `fastbridge-el.js` or the LP daemon against real locks, and the quote path (a page paying the worst class's fee
  from advertised `stuckFees`) is specified and unit-tested at the fee functions, not exercised end to end on signet. The integration
  points are deliberately the two the brief names — `lineageScreen`'s verdicts and `policy.screen`'s shape — so wiring it into a
  provider is a small, reviewable step.
- **Change-note interaction:** a lock whose notes are mixed is charged for its worst note on the whole amount. That overcharges a
  lock that is mostly clean with one small stuck note. Splitting the premium by note share is a refinement; the worst-note rule was
  kept because it is simple, never undercharges, and matches how the screen already judges a lock by its worst note.
