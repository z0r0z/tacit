# Stuck TAC: a pricing and policy rule for the TAC the bridge cannot carry

Entry for the [stuck TAC bounty](STUCK-TAC-BOUNTY.md), option C. A provider takes TAC on Bitcoin that the regular bridge cannot carry, so it has
to charge a fee that covers what it loses on it — and refuse a lock that pays less than the class it spends. One module prices the classes, a
quote names the class it was priced for, and the locker refuses a lock whose class is worse than its quote.

- Code: [`dapp/fast/stuck.js`](../dapp/fast/stuck.js)
- Wired into: the quoter and the offer path both a page and the daemon run (`dapp/fastbridge-provider.js`, `dapp/fastbridge-el.js`), the page's
  screen and its way of asking for a quote (`dapp/fast/wire.js`), the user side's quote check (`dapp/fastbridge-client.js`), the daemon's config
  and its read of a note's history (`fastbridge-lp/`).
- Tests: `node tests/stuck-tac.test.mjs` (offline, no dependencies)

## The classes

The class of a note is the verdict the bridge already gives it (`lineage` in `dapp/burndep-ux.js`), named:

| class | verdict | why it is that class |
|---|---|---|
| `clean` | `tracked`, `traced` | the reflection tracks it from birth, or reads its history back to the etch in at most 255 transfers: the burn proof follows it |
| `long` | `long` | more than 255 transfers behind it. The proof's walk is bounded (`ncx > 256` in `cxfer-core/src/burn_deposit.rs`) and a split inherits the whole history, so it cannot be burned |
| `poolExit` | `unprovable` | a history the proof does not follow at all: a shielded-pool exit (`opcode 0x6d`, and `0x6c`), a pool or farm trade, TAC that came over from Ethereum (`crossout_mint`). `through` on the verdict says which; all four are the same price |

A lock is the worst class among the notes it spends, and has no class at all while one of them is unread: a provider waits rather than guesses.

`long` is worth a separate class because the code already treats it separately: `lineageScreen` has never refused it (the bridge's answer on it
is a limit, not a refusal), so a provider that screens today takes long notes at the clean price. That is the under-pricing this rule fixes.

## The price

A provider that takes a note of class `c` ends up holding Bitcoin-side TAC it cannot lend again: it can only recover the note's Bitcoin-side
price, `1 − haircut(c)`. So the fee for `c` is

```
feeBps(c) = feeBps + haircutBps(c) + marginBps        (clean: feeBps, exactly as before)
fee      = ceil(amount × feeBps(c) / 10000) + flatFee  (clean: floored, exactly as before)
```

The flat part is not multiplied: it pays the relay's fee for cutting a note to size, which does not change with the class. The clean price is
the price it was, to the base unit, so a quote that names no class is unchanged and `tests/fastbridge-lp.test.mjs`'s exact fee arithmetic still
holds. A stuck price rounds up: it is a floor.

```json
"quote": {
  "feeBps": 30, "flatFee": "10000000",
  "stuck": { "take": ["clean", "long"], "haircutBps": { "long": 900, "poolExit": 2500 }, "marginBps": 100 }
}
```

`take` is what the provider will take at all; a class it takes must carry a haircut it chose, or the process stops at start. So a class can be
priced without being taken (`poolExit` above: 2630 bps if it ever is), and a class cannot be taken at the clean price by a forgotten field.
`haircutBps` is the provider's estimate of the Bitcoin-side discount for that class — the one number only the provider can know.

## What carries the class

- `POST /quote {amount}` is unchanged. `POST /quote {amount, class}` prices that class and the quote carries `class`. A provider with no schedule
  ignores the word and names no class, which reads as the clean price: the provider it was, byte for byte.
- The page asks by class: `openFast` reads the class of the notes a lock for that amount would spend (`classesOf`, through the same `vet` the
  lock uses) and passes it to every provider, so a provider that prices stuck TAC prices what will really be spent.
- At offer time the locker reads the class again from the chain and gives it to the provider's screen along with the quote
  (`policy.screen(notes, { quote })`). The screen refuses a lock whose class is worse than the class its quote was priced for. This is the
  guarantee: nothing is taken below the floor in the provider's config, whatever the page said when it asked.
- The user side refuses a quote that names another class (`fastbridge-client.js`), so a lock is not built on a quote for something else. A
  class-priced quote is not held to the provider's one-fee ad (`aboveTerms`), since the ad never spoke for stuck TAC.

## The numbers

200 bridges of 100 TAC, one in twenty stuck (190 clean, 6 long, 4 poolExit), the provider's own haircuts 9% and 25%, margin 1%. The model is in
`tests/stuck-tac.test.mjs` and the figures are asserted there: a bridge lends what it pays out and hands the provider a Bitcoin note of the
amount, which is worth its face if clean and `1 − haircut` if not.

| | TAC lent | Bitcoin side (face) | worth | net |
|---|---|---|---|---|
| without the rule | 19,920 | 20,000 | 19,846 | **−74 TAC** |
| with it | 19,756 | 20,000 | 19,846 | **+90 TAC** |

Read it as: the fee alone does not cover the haircut, so every stuck bridge pays the provider a little less than the value it hands over; at 5%
stuck that is 74 TAC out of 20,000 of volume, and the hole grows with the stuck share (the same model at 25% stuck is −1,100 TAC without the
rule and +260 with it). With the rule the provider is whole on what it takes and keeps the margin, holds 164 TAC less of its own inventory, and
prices the stuck 5% at 10.3%/26.3% instead of 0.4%. A book with nothing stuck behaves identically under both, which is the point of pricing by
class and not by provider.

## What it assumes

- The Bitcoin-side price of a stuck note is `1 − haircut`, and the provider knows its own haircut. If there is no market at all, the haircut is
  100% and the fee is not a fee any holder would pay; that is a true answer, and `take` is how a provider says so.
- All four `unprovable` histories are priced the same. A note that merely came over from Ethereum (`arrived`) may sell better than a
  shielded-pool exit; a provider that thinks so can raise or lower `poolExit` only as one class. Splitting the class further is a change to the
  class list and to every caller, and was not made.
- `long` and `poolExit` cannot be bridged home by any route this rule knows. If a desk for stuck TAC (option A) starts buying them at a better
  price, the provider's haircut should come down with it: it is config, not code.

## Risks

- **The haircut is an estimate.** The rule makes the provider's floor explicit, not its profit. A provider that sets it too low is still short;
  the default in `config.example.json` is a guess, not a market read.
- **A wrong class is refused after the lock is on Bitcoin.** A client that asks for the clean price and then locks a stuck note spends the lock's
  fees and waits out the timelock before its refund. The page asks by class so this should not happen from `/fast/`; an integrator that quotes
  clean and locks stuck will meet it. The refusal is deliberate: the alternative is taking TAC below the provider's floor.
- **The quote path now reads the trace** for notes the reflection does not track. A slow or unreadable trace delays a quote; a verdict that
  cannot be read is treated as clean for the quote and stops the lock at `followed` (code `lineage_unread`), so nothing is locked at a price
  that was never read, but a page can be quoted a price it will not use.
- **The ad has no room for the class list.** `AD_MEMBERS` is closed and both the boards and every page refuse a member they do not know, so the
  schedule is not in the ad: a page asks every provider with the class it will spend and a provider that does not take it answers no. Adding it
  to the ad needs a coordinated deploy of the boards and the pages, which this entry does not do.

## What I did not test

- Nothing ran against a funded Bitcoin address, the live trace service, or a real pool: the chain parts are unrun (`--dry-run` was not run
  either; the daemon needs a key and an RPC).
- The offer path is tested at the screen (`stuckScreen`) and at the quoter, not through `makeEthereumLocker.receive` with a real Bitcoin lock
  transaction; that machine's own tests (`tests/fastbridge-sim.test.mjs`) are unchanged and still pass.
- The daemon's read of a note's history (`tacit.bridgeUx().lineage`) is the same code the page runs and is not exercised here; the model of the
  classes is tested on the verdicts it produces, not on the service.
- The page's provider panel has no control for the schedule: a provider at a page can carry `stuck` in its settings and price by class, but
  nothing sets it from the UI, so in practice the daemon is where this runs.
- No fork or signet run. The numbers above are a model, not a measurement of a live book.

## Trying it

```
node tests/stuck-tac.test.mjs                      # the rule, the screen, the quoter, the numbers
cp fastbridge-lp/config.example.json fastbridge-lp/config.json
FB_LP_KEY=<64 hex> node fastbridge-lp/server.mjs --dry-run
```

The daemon logs `stuck TAC: pricing clean, long at 1030 bps, …` at start and answers `POST /quote {amount, class}` accordingly. Remove
`quote.stuck` and it is the provider it was.
