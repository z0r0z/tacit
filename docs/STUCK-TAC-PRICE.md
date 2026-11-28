# stuck TAC: a pricing and policy rule (entry C)

Entry for [`STUCK-TAC-BOUNTY.md`](STUCK-TAC-BOUNTY.md), option **C**.

## What it does

`dapp/fast/stuck-price.js` adds `stuckPriceScreen(vet, rule)`, a `policy.screen` of the same shape as `lineageScreen` in
[`dapp/fast/wire.js`](../dapp/fast/wire.js). A provider uses it in place of the all-or-nothing choice between `anyTac` (take everything,
drain capacity) and screening (refuse every stuck note). It sorts a lock's inputs into classes from the lineage verdicts the bridge
already reads:

| class | verdict | default |
|---|---|---|
| clean | `tracked`, `traced` | goes on, as today |
| long | `long` (history over the proof's bound) | taken only at `baseFeeBps + haircutBps.long` |
| poolExit | `unprovable` (pool exit and the like) | taken only at `baseFeeBps + haircutBps.poolExit` |
| unread | none or `unread` | refused with `retry`, as today |

A lock is priced by its worst input, on its whole value. A class with no haircut in the config is refused. A lock that would put the
provider's stuck holding over `maxStuck` is refused with `retry`. Every limit sits in the provider's own config:

```js
import { stuckPriceScreen } from './fast/stuck-price.js';
policy.screen = stuckPriceScreen(vet, { baseFeeBps: 30, haircutBps: { long: 200, poolExit: 500 }, maxStuck: 50_000n * 10n ** 8n },
  { stuckHeld: async () => myStuckBalance() });
```

## The one change outside the new file

`dapp/fastbridge-el.js` now passes `{ value, amount }` of the offer as a second argument to `policy.screen`. `lineageScreen` takes one
argument and ignores it. Nothing else moves: no quote, ad, request, reply, contract, key or proof changes. A page or provider that
knows nothing of this keeps working.

## What it assumes

- The fee a lock pays is `offer.btc.value - offer.evm.amount` (same asset, base units), already held equal to the quote.
- Today a quote is made before the notes are known, so a holder of stuck TAC gets a refusal that names the fee needed. They then ask
  for a quote at that fee. A later step, not in this entry, is an optional `stuck` field in the ad's terms (`{ long, poolExit }` in bps)
  so pages can quote it up front.
- `stuckHeld()` should be the provider's real holding of stuck TAC. Without it the cap counts only what this screen let through since
  start (in memory). That is the safe default only for a provider that restarts empty.

## Numbers

From `model()` in the same file (also printed by the test). 1,000 bridges of 1,000 TAC, 5% stuck (the 2026-11-22 count), fee 30 bps,
stuck TAC assumed to sell 400 bps under par, surcharge 500 bps, cap 30,000 TAC:

| | stuck TAC held | refused | net fee after haircut |
|---|---|---|---|
| `anyTac`, today | 50,000 | 0 | 1,000 TAC |
| with this rule | 30,000 (capped) | 20,000 | 3,240 TAC |

The stuck holding stops at the cap, and what is taken pays for its own haircut. The haircut figure is an assumption, not measured.

## A finding

`lineageScreen` and `followed` refuse only `unprovable`. A `long` verdict passes them, even though such a note cannot go home either
(bounty §1). This rule treats `long` as stuck. It may be worth the same change in `lineageScreen`.

## Tests

`node tests/fastbridge-stuck-price.test.mjs`: 10 offline checks (classes, worst input, config checks, rounding up, fee floor,
refused classes, no-ctx fallback, cap with and without a reported holding, model). `fastbridge-bl-guards` and
`fastbridge-el-prepare` still pass.

## Not tested

Not run against a live provider, signet or a fork. The ad-terms field above is not built. The haircut a real market gives stuck TAC is
not measured.

## Risks

- A surcharge set too low leaves the provider holding stuck TAC at a loss. The cap bounds that loss.
- Pricing by worst input overcharges a lock that mixes one stuck note with many clean ones. That is safe, but less friendly.
- An in-memory cap without `stuckHeld` resets on restart.
