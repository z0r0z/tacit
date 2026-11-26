# Stuck TAC: risk-aware quotes and admission (option C)

The provider can opt into a fixed TAC/TAC haircut schedule. It does not sell,
move or custody funds on its own, change the bridge proof, or change a contract.
Without the option, provider and client behaviour is unchanged.

## Operator setup

In `fastbridge-lp/config.json`, inside the existing `quote` object, add for example:

```json
"riskPricing": { "clean": 0, "long": 500, "poolExit": 800, "maxTotalBps": 1000 }
```

With `feeBps: 100` and `flatFee: "0"` this gives 1%, 6%, 9% respectively.
All four risk settings are integer basis points; the numbers above are assumptions,
not market estimates. Set them from expected liquidation loss, costs and your
risk appetite. Only a fixed 1:1 TAC/TAC quote with a fixed flat fee is supported.
The browser provider's `openProvider().start({settings})` supports the same
optional `riskPricing` setting when `anyTac` is not false. Existing browser UI
settings are not changed. Do not change policy while quotes/swaps are open: stop
accepting new swaps, let the existing ones complete/refund, and then restart.

`POST /quote` accepts optional `riskClass: "clean" | "long" | "poolExit"` in
addition to the existing `amount` (integer base units). For instance, a client can
use `counter.quote(10000000000n, 'long')` or send
`{"amount":"10000000000","riskClass":"long"}`. The regular page can keep
requesting quotes without a class; these use the highest configured haircut.
`/info` includes optional `riskPricing` and advertises the worst percentage plus
one base unit of rounding headroom in the flat fee, so existing ads and old pages
still understand the fee bound. No board signing or quote ID format changes.
Class-aware callers must vet/select their notes before requesting a cheaper quote.
The standard UI does not automatically select or request a class-specific quote.

## Admission and limits

Charge `ceil(amount * (baseBps + haircutBps) / 10000) + flatFee` in integer
units; refuse a zero payout or a fee beyond the operator's total ceiling. The
sealed quote commits to both amounts, so the declared class is not trusted.
Before accepting a confirmed Bitcoin lock, the existing Ethereum-locker screen
receives the authenticated quote and the lock's actual note inputs. It uses the
existing `bridgeUx().lineage()` verdicts: tracked and short traced are clean;
long (including traced histories of 254+ hops, reserving lock/claim headroom)
are long; shielded (`0x6c/0x6d`, grouped by upstream) is poolExit. Other
unprovable notes are declined. Unknown/unread inputs are not accepted. For mixed
inputs charge at least the largest haircut on the whole quote, since note
amounts are private. Reject underpriced locks before Ethereum is locked; the
existing refund path remains available on Bitcoin. The actual fee must also
remain within the total ceiling. No new dependencies or external services.

## Inventory example and risks

Run `node tests/stuck-tac-sim.mjs`. Start with 10,000 TAC on Ethereum, 100
bridges of 100 TAC (90 clean, 5 long, 5 shielded), clean notes returned at par,
5% and 8% stuck haircuts, and 1% base fee. No other costs or price changes.

| After 100 bridges | Flat 1% | Class pricing |
|---|---:|---:|
| Ethereum liquid TAC | 9,100 | 9,165 |
| Bitcoin stuck TAC (face) | 1,000 | 1,000 |
| Marked total TAC | 10,035 | 10,100 |

Pricing offsets the assumed haircut (65 TAC) but does **not** restore spendable
Ethereum inventory: even with correct haircuts, continued stuck arrivals can
exhaust capacity. Existing inventory limits still apply. Actual losses can
exceed assumed haircuts; liquidity, network fees, time to sell, trace latency,
reorgs and adverse selection are not modelled. A wrong class claim can cause
rejection after BTC lock and require waiting for refund. Worst-class pricing can
be expensive for legacy clean users. Policy changes may invalidate older quotes.

## Tests

`node --test tests/stuck-tac-risk.test.mjs` tests class fees, rounding/ceilings,
unknown/mixed lineage, sealed quotes, legacy behaviour and actual provider
admission against mocked confirmed Bitcoin locks with real commitments/scripts.
No mainnet transactions, signet, Ethereum fork, real lineage network calls,
full live daemon startup, or browser end-to-end UI were tested. The full existing
integration suite requires the repository's dependencies; see PR test results.
