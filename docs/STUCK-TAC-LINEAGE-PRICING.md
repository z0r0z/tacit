# Stuck TAC: exact-note pricing, exposure caps and reverse recycling

This is a mixed entry: the pricing-and-policy rule of option C plus the smallest useful part of option B. It lets a fast-bridge
provider take clean, long-history and pool-exit TAC at different fees, binds the quote to the exact Bitcoin note outpoints the lock
must spend, caps how much unsold stuck face value the provider is willing to hold, and moves completed stuck takes onto the reverse
side's dedicated address so they can be sold back into pool TAC. The provider enforces the price, exact inputs and cap before it
locks anything in the pool.

## What it does

A provider that opts in sets `quote.lineageFees` in `fastbridge-lp/config.json`:

```json
"lineageFees": {
  "defaultClass": "pool-exit",
  "long": { "feeBps": 100, "flatFee": "0" },
  "poolExit": { "feeBps": 250, "flatFee": "0" },
  "caps": { "long": "25000000000", "poolExit": "10000000000", "total": "30000000000" }
}
```

The class values are **additions** to the provider's ordinary `feeBps` and `flatFee`; `clean` may be omitted and is zero in this
example. The numbers are configuration, not a market opinion: the operator sets its expected haircut and can read that floor in its
own config. Caps are base units of face value. A missing cap is unbounded, and zero refuses that class. The environment overrides
are `FB_LP_LINEAGE_DEFAULT_CLASS`, `FB_LP_LINEAGE_LONG_FEE_BPS`, `FB_LP_LINEAGE_LONG_FLAT_FEE`,
`FB_LP_LINEAGE_POOL_EXIT_FEE_BPS`, `FB_LP_LINEAGE_POOL_EXIT_FLAT_FEE`, `FB_LP_LINEAGE_LONG_CAP`,
`FB_LP_LINEAGE_POOL_EXIT_CAP` and `FB_LP_LINEAGE_TOTAL_CAP`.

The classes come from the existing `lineage` verdicts: `tracked` or `traced` is **clean**, `long` is **long**, and every
`unprovable` kind is priced conservatively as **pool-exit** (the class also covers pool/farm trades and TAC whose history arrives
from Ethereum). If a lock spends several notes, the worst input prices the whole lock. If history cannot be read, the offer is
retried rather than refused or guessed.

Compatibility is by optional fields only:

- `POST /quote` accepts optional `lineage: "clean" | "long" | "pool-exit"` and optional `inputs: [{ "txid", "vout" }]`. Old clients do not send them; old providers ignore them.
- An exact-input quote carries those inputs in the quote and is stored rather than compressed into the sealed quote-id format. The lock must spend exactly those note inputs; adding, removing or replacing an input makes the provider refuse the offer before the pool lock is built.
- Quotes with class pricing include `lineage`, and `/info` includes a `lineagePricing` schedule with `exactInputs: true`, any caps, and the currently counted exposure. Signed ads keep the same schema; because they cannot name per-class fees, the ad's ordinary fee terms are posted as the conservative maximum the schedule can charge.
- A request without a hint is priced as `defaultClass`, which should remain `pool-exit` for a safe default.
- The fast page estimates which notes each kind of provider would be given and sends both the class and the exact outpoints as a hint to a provider that takes any TAC or publishes class pricing. A read failure sends no class hint rather than stopping the quote. Split bridges do not yet send per-note hints and therefore use the conservative default.

The important checks are on the provider side. When an offer arrives, the daemon traces the lock's note inputs with the same lineage
service, compares them with the quoted outpoints when present, compares the stored quote with the price of the actual class, and
checks the class cap. A cheaper clean quote cannot be spent as long or pool-exit TAC; a quote priced at the actual or a worse class
is accepted if the cap has room. This happens before the provider's pool lock is built. With `anyTac: false`, pool-exit inputs are
still refused outright, while long inputs can be priced rather than treated as a binary refusal.

Caps count stuck face value in active reservations, in-flight swaps, and completed swaps not yet made saleable. Refunded, rejected,
aborted and lost swaps do not count because the provider did not keep the note.

### Reverse recycling loop

When the daemon's reverse side is enabled, `fastbridge-lp/lib/stuck-recycle.mjs` watches completed forward swaps whose lock inputs
were classed `long` or `pool-exit`. A completed take writes the acquired TAC as the first note output of the take transaction. The
recycler selects exactly that outpoint (`<take txid>:0`), never arbitrary stock at the provider's main address, and transfers the
whole note to the reverse side's derived Bitcoin public key. Once the transfer confirms, the reverse side's ordinary inventory scan
sees the note and can sell it through `/reverse/...` like any other reverse inventory.

Safety properties:

- key separation is kept: the main key signs the transfer, the reverse key only receives the note, and neither side takes custody of user funds;
- the first sighting after startup is a dry run and is only logged; a later tick sends at most `stuckRecycle.maxPerTick` (default 1);
- the transfer is forced to the exact take note, so market-maker stock or clean proceeds at the same address are not spent;
- clean-class proceeds are ignored;
- a broadcast error is recorded and not retried automatically, because the failure may be after a relay accepted the reveal; the operator inspects that swap before touching it;
- when the move confirms the forward swap record is marked `stuckInventoryAt`; reverse sales are attributed without guessing input ownership: a sale made only from tracked recycled notes reduces the corresponding recovered amount, a partial sale of one tracked note is followed through its deterministic change output, and a partial sale mixed with untracked inventory stays as exposure. The record is marked `stuckRecoveredAt` and stops counting against lineage caps only when the whole original amount has been sold back for pool TAC;
- `stuckRecycle.enabled` defaults on only when the reverse side is on, and can be disabled in config or with `FB_LP_STUCK_RECYCLE=off`. Manual `recoveredSwaps` / `FB_LP_RECOVERED_SWAPS` remains available for notes recovered outside this loop.

## Numbers

`tests/fastbridge-lineage-pricing-sim.test.mjs` models a provider starting with 100,000 base units of lendable TAC. Each bridge is
for 10,000, the ordinary fee is 0.30%, and the operator prices the class addition at the expected haircut: +10% for long and +25%
for pool-exit. “Without rule” charges only the ordinary 0.30% to every class. The recovered value of a stuck note is its face value
minus its haircut; clean TAC is recovered in full over the regular bridge.

| class | bridges | without rule | with lineage fee |
|---|---:|---:|---:|
| clean | 1 | 100,030 | 100,030 |
| clean | 10 | 100,300 | 100,300 |
| clean | 25 | 100,750 | 100,750 |
| long | 1 | 99,030 | 100,030 |
| long | 10 | 90,300 | 100,300 |
| long | 25 | 75,750 | 100,750 |
| pool-exit | 1 | 97,530 | 100,030 |
| pool-exit | 10 | 75,300 | 100,300 |
| pool-exit | 25 | 38,250 | 100,750 |

The stress model is harsher: the payout leaves immediately, the Bitcoin-side note is recovered only five bridges later, the mix
rises from clean to long to pool-exit, and realized haircuts are worse than configured (12% for long instead of 10%, 30% for
pool-exit instead of 25%). Inventory after 25 bridges:

| stress scenario | inventory after 25 | refused | stuck exposure |
|---|---:|---:|---:|
| worse haircut, no rule | 23,750 | 0 | 50,000 |
| worse haircut, lineage fee | 58,750 | 0 | 50,000 |
| worse haircut, fee + caps | 91,530 | 14 | 10,000 |
| illiquid long, caps | 82,060 | 23 | 20,000 |
| illiquid long, no caps | -124,250 | 0 | 250,000 |

The point is not that 10% and 25% are the right market haircuts. It is that when the configured addition equals the expected
haircut, the provider keeps the same 30-unit base margin per 10,000 bridge instead of watching lendable inventory drain. If the
real haircut is worse than configured, the residual loss is the difference; caps bound how much illiquid face value can accumulate
while that mistake is being corrected.

## Assumptions and risks

- The operator can estimate a haircut for each class. The recycling loop provides a sale rail, but this entry still has no market oracle and does not promise a clearing price.
- `pool-exit` is deliberately conservative for every proof-unfollowable history, not only opcode `0x6d` pool exits.
- A multi-input lock is priced by its worst input. This is simple and safe, but one bad input makes the whole lock pay the worst class.
- Exact-outpoint quotes are strict. The page's quote-time pick can change before the lock is built if notes are spent or locked by another tab. The provider-side offer check is authoritative, so a mismatch never prices stuck TAC as clean; it can still cost the user time and Bitcoin fees if an offer is refused after the lock confirms.
- Classification adds lineage reads before quoting and again when the offer is checked. The UX cache reduces repeats, but a very long history can still be expensive to trace. A read failure means no hint at quote time and a retryable refusal at offer time.
- Caps are an intake limiter, not a guarantee of demand. A cap reached means the provider refuses new stuck intake even when it would be profitable; that is the cost of bounding inventory risk. The recycler makes acquired notes saleable, but if no reverse buyer appears the value still sits in reverse inventory.
- Old clients are safe for the provider but may be quoted the conservative `pool-exit` default even for clean TAC. Operators that mostly serve old clients should understand this trade-off before opting in. Class-blind ad readers likewise see the worst-case fee, so a provider can look dearer before the class of the notes is known.
- A class addition is capped at 9,000 bps, the page's existing hard fee ceiling. Very high additions are possible configuration, not a recommendation.

## Tests

Offline tests cover class reduction, unread/retry behavior, quote math, exact-outpoint binding and rejection, exposure-cap intake,
`/info` publication, environment overrides, provider-side enforcement before a pool lock, page quote hints with exact inputs,
candidate selection, dry-run/send/confirm behavior, exact forced-outpoint movement, clean-note exclusion, failure non-retry, and
the numeric tables above:

```sh
node tests/fastbridge-lineage-pricing.test.mjs
node tests/fastbridge-lineage-pricing-sim.test.mjs
node tests/fastbridge-stuck-recycle.test.mjs
node tests/fastbridge-wire.test.mjs
node tests/fastbridge-lp-env.test.mjs
```

Not tested: a live mainnet or signet bridge, a real reverse sale of a recycled note, fee bumping of a stuck recycle transfer (a stalled move alerts rather than replaces itself), the real reflection service's latency on a maximally long history, browser UI copy, and market measurement of actual haircuts. No contracts, keys, pool parameters or deployed services change.
