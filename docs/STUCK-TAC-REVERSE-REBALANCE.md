# Stuck TAC reverse rebalance: Track B submission

I built an opt-in sidecar that moves selected stuck Bitcoin TAC notes into the LP's reverse wallet for gross private Ethereum proceeds.

**This is a Track B variant using the existing direct reverse atomic market, not the literal sats order book.**

## Selection, settlement and limits

Version 1 leases are the spending authority and measurement boundary, naming exact note outpoints and amounts plus fee coins. Candidates are confirmed, unspent, note-sized main-address outputs with exact wallet amounts; the smallest eligible whole note wins, with outpoint tie-breaks. Only `long` and `unprovable` lineage `through: "shielded"` pass. `tracked`, `traced`, other unprovable histories and unread lineage are excluded. Unread lineage alerts and remains residual outside eligible measured stock; unleased notes are outside funding and measurement.

Exposure rechecks sources, fee coins and second-read confirmations. Leases are checked on selection, resume, pre-broadcast and pre-execution. Revocation or an amount change halts without another broadcast. Funding is whole-note with no change. Production sales may combine notes and return change; whole-note sales are a fixture assumption.

From the separate reverse wallet derived from `FB_LP_KEY`, the provider locks `B` and the buyer locks gross private Ethereum `E`. The claim reveals the secret, the buyer takes `B`, and the provider receives `E` at its forward pool account.

For equal TAC asset identifiers, pricing and first start enforce `E*10000 >= B*floor`, where `floor = minProceedsBps` and `10000 <= floor <= 1000000`. Clients reject `B > E`, preventing below-par sales. At default 30 bps + 0.1 terms, `B = E - floor(E*30/10000) - 0.1`. Production takes the greatest exact `E` on each fee plateau, following `maxInFor`. `B = 100` has only `E = 100.40120361`; figures unchanged. Candidates need exact quotes. Malformed terms, nonpositive outputs, missing exact quotes and unreachable floors fail closed and exclude eligible stock.

- `maxNoteTac` limits one funding move. `maxDailyTac` limits UTC-day funding-selection commitments, including unsold moves. `maxInventoryTac` limits post-move unsold stock, unresolved funding and active-sale exposure.
- `maxStuckTac` adds eligible leased main candidates for the forward circuit. Reverse `maxOpen` bounds active sales; `maxLocked`, configured as `maxTac`, bounds their combined Bitcoin TAC.
- Reverse `maxFeeRate` requires fresh, non-stale estimates for quotes and starts; funding estimates require a live source. The accepted rate and ceiling reach the real builder, which rejects invalid or above-cap rates before commit or reveal. Reverse start supplies them to `bl.start` once, with no second estimate.

## Journals, recovery and intake

Sidecar funding and reverse journals are primary-only strict, never backup-restored; torn or missing primaries, orphan backups and unreadable journals fail closed. The reverse service retains ordinary backup reads, but problems close sales. Inventory precedes the journal. Every pre-existing `rebalance.pid` requires operator-verified manual removal; no stale reclaim.

The journal records `selected -> broadcasting -> moved -> done`, or `halted`. An ambiguous halt with `broadcastAttempted: true` blocks all new funding and forward intake while `moved` records reconcile. `moved` becomes `done` from confirmed inventory or early swap evidence. Funding completion is not recovery. Contradictory `done` evidence means manual reconciliation; transient reads stay `done` for retry. Nothing ambiguous is rebroadcast.

New reverse `noteInputs` persist `amount: String(n.amount)`, allowing partial-sale residuals to be reconstructed. Status allocates unsold notes, unresolved funding and active-sale exposure once; unconfirmed change remains exposed, with `unconfirmedReverseStockBaseUnits` reporting that subset. `includeUnconfirmed` is accounting-only and never makes notes sellable. Refund reuse follows the later active, done or refunded lifecycle.

Historical unlinked inputs without learnable amounts set `exposureUnknown` and `unknownExposure`, refuse admission with `reverse_exposure_unknown`, and force `intakeAllowed: false` and `newFundingAllowed: false` with `reverse_input_amount_unknown`. Existing reverse swaps finish. Known residuals use `unlinked:` pending items; unknown inputs use `unknown:`. Supply the verified base-unit amount on the correct primary-journal input, then verify repaired status; never assume zero change.

Completed sales alone reset `lastSaleAt`; new exposure gets a full `stallSecs` interval. `measurementScope` remains `eligible_leased_main_candidates_plus_reverse_stock_and_pending`, with `pending` including active-sale exposure.

New forward quotes require fresh status with `kind: "status"`, `id: "status"`, `enabled: true`, `dryRun: false`, matching TAC text and base-unit duplicates, and the configured ceiling. Missing, malformed, non-live, mismatched, future, stale, unreadable or denied status fails closed with zero availability and a retryable 503. Existing swaps finish without it. Pair `maxFeeRate` reaches reverse options; reverse tick summaries drive server failure and recovery handling.

Both switches default off. Optional fields preserve compatibility, with no new dependencies or deployed changes and a standalone sidecar. Alerts cover lineage, leases, chain evidence and reconciliation.

## Risks and untested behaviour

**No funded mainnet or signet TAC reverse sale, live explorer/wallet CLI test, real reorganisation test, real settle-guest run or fork evidence is claimed.** Demand is unproven; buyers receive the same unbridgeable history, with no v1 discounts. BTC fees and downtime can delay recovery. A down/stale sidecar closes forward intake. Ambiguous broadcasts need operator reconciliation. Unleased and unread-lineage notes are outside eligible measured stock, so status is not all stranded value.

## N-bridge gross accounting

This worst case is not a forecast. Open with 10,000 **gross private Ethereum TAC**, not quotable capacity. Every one of `N` forward receipts is a 100 TAC long-history note. Forward fee is 30 bps + 0.1, so `y = 99.6`. Every reverse sale completes at default terms with `B = 100` and `E = 100.40120361`.

Without the loop, gross private Ethereum TAC is `10000 - N*99.6` and residual stuck TAC is `100N`. With the loop and all sales completed, gross private Ethereum TAC is `10000 - N*99.6 + N*100.40120361` and residual stuck TAC is 0.

| N | Without loop: gross private Ethereum TAC | Residual stuck | With loop: gross private Ethereum TAC | Residual stuck |
|---:|---:|---:|---:|---:|
| 1 | 9900.4 | 100 | 10000.80120361 | 0 |
| 10 | 9004 | 1000 | 10008.0120361 | 0 |
| 100 | 40 | 10000 | 10080.120361 | 0 |

Excluded: native sats, pool exact-note cuts and reserves. Quotable capacity is lower and depends on those costs and reservations; `E-B` is gross spread, not net profit. The baseline excludes top-ups, and the loop assumes buyer demand. A clean receipt would return full `A` over the ordinary bridge by the horizon; this table has none. `230 / 4,546` is a note count excluding pool exits, not a forecast.

## Offline evidence and review

Commands:

```sh
node tests/fastbridge-lp-reverse-rebalance.test.mjs
node tests/fastbridge-lp-rebalance-gate.test.mjs
node tests/tacit-rebalance-fee.test.mjs
node tests/fastbridge-reverse-fee-adapter.test.mjs
node tests/stuck-tac-scenarios.test.mjs
node tests/stuck-tac-production-parity.test.mjs
node tests/stuck-tac-page.test.mjs
node tests/fastbridge-reverse-service.test.mjs
node tests/fastbridge-lp-reverse.test.mjs
node tests/fastbridge-reverse.test.mjs
node tests/fastbridge-lp.test.mjs
```

These commands passed under Node `v24.3.0`; Node 22 was unavailable on this machine. Rebalancer tests use the real state machine and funder against fake chains and wallets. Reverse and gate tests use real machines and services over simulated chains. Fee tests cover builder preflight and esplora freshness.

The scenarios and review UI are economics only, excluding lease admission and revocation, `maxNoteTac`, `maxInventoryTac`, `maxOpen`, `maxLocked`, pool exact-note cuts, reservations and native sats. Whole-note sales are fixtures, not production rules. `B-06` is time-driven and sale-aware, not production three-poll evidence.

Run `npm run serve` and open `http://127.0.0.1:8787/stuck-tac-review/`. If occupied, set a free `PORT` and use it in the URL. The UI has no keys, chains, storage or production modules; quotes, buyers and economics are simulation, not live validation or demand evidence.

The page test starts an ephemeral loopback server, not `npm run serve` or `PORT`. `PLAYWRIGHT` sets the module passed to `require` (default `playwright-core`). `CHROME` then `CHROME_PATH` selects an existing executable, then macOS Chrome/Chromium and Playwright's default.
