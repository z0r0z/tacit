# Price hard-to-bridge TAC before it is locked

This is option C of the stuck TAC bounty. An opt-in TAC-to-TAC daemon quotes from the provider's own estimates of recovery costs. A user can request a note-specific quote on the Fast bridge page, see the exact payout, then use the existing swap under that quote. Slow note checks return a short-lived check ID, so the page can show progress and resume the same request while ordinary quotes continue. The quote stays tied to the ordered Bitcoin outpoints. The daemon verifies the actual lock inputs against them and still runs the existing asset, commitment, confirmations, script and cross-lane checks.

**Policy.** The fee is the normal fee plus the configured class haircut. The normal fee is the provider's usual service margin (unchanged); the haircut is the provider's own estimate of the loss it expects when it eventually realizes the stuck TAC, charged on top and rounded up to a whole base unit, so a held lock is never billed twice. A quote pays at the highest-risk input's class because the provider cannot safely apportion a commitment across input classes. Clean covers reflected tracked notes and traced notes with room for the fast lock and take (up to 253 hops in the original trace). Longer histories and known shielded-pool provenance are priced separately. When the reflection tracer gives a generic non-transfer result for a direct exit, the daemon uses the existing Bitcoin and pool validator to verify the exact confirmed TAC output. Unsupported verdicts, temporary read failure, or exhausted capacity produce no classified quote. No market price or sale is assumed by the code.

**Why the haircut is added, not a floor.** The bounty asks for "a fee that covers its expected haircut." A minimum-total-fee (`max(normalFee, haircut)`) reads that as a floor: whenever the haircut meets or beats the normal fee, the provider's service margin is swallowed by the loss allowance, so it works a stuck swap for nothing. The additive model keeps the normal margin and separately covers the expected loss. The replay below shows the difference: on the same fills, additive pricing retains 3 more TAC than the floor model and leaves the provider's margin intact at 17 TAC.

**Operation.** The feature is off unless a provider adds this object to its own daemon config. The example uses 8 and 15 percent haircuts, a 250 TAC long-history cap, a 100 TAC shielded cap, and a 300 TAC combined cap. Amounts in the config are TAC base units (eight decimals). Set each opening amount to the outstanding exposure already held from before the feature was enabled. Choose actual haircuts and caps from the provider's own recovery assumptions. Use a single daemon and its existing durable stores.

```json
{
  "stuckPricing": {
    "longHaircutBps": 800,
    "shieldedHaircutBps": 1500,
    "longLimit": "25000000000",
    "shieldedLimit": "10000000000",
    "totalLimit": "30000000000",
    "openingLong": "0",
    "openingShielded": "0",
    "recoveredSwaps": []
  }
}
```

Checks and quotes reserve nothing. The daemon runs one background quote check per instance, bounds its duration and retained results, and keeps legacy offer verification separate. Check IDs are bound to the quoted amount and inputs. The browser stops polling when the amount or wallet changes. Unexpired reservations and accepted swaps count against their class and total. Confirmed refunds and lost swaps (a pool lock claimed with no t, so no stuck TAC was ever taken) release exposure; the loss from a lost lock is alerted separately. Completed swaps retain it until an operator verifies recovery and adds the completed swap ID to `recoveredSwaps` in the config. A timeout or restart never assumes a sale. Review any irrecoverable records and reconcile inventories before resuming classified quotes after storage loss. Enable on a fresh provider or after draining outstanding legacy offers. A legacy amount-only caller can still get a base quote for clean notes. The new flow is for a single provider on the Fast page. Existing signed ads and disabled providers keep their original wire format.

An opening amount above a configured cap triggers a startup warning. Admission still checks the requested class and the combined cap: exceeding the long cap does not by itself pause shielded quotes that fit both their own and the combined limit. Opening amounts are configuration snapshots; reduce them only after verified recovery and restart with the reconciled config. A confirmed Bitcoin take is receipt of stuck inventory, not its recovery into lendable Ethereum TAC.

Older experimental configs used `longBps` and `shieldedBps` as minimum total fees. This version requires `longHaircutBps` and `shieldedHaircutBps` as additional loss allowances; old fields alone fail validation rather than silently changing price. Recalculate them from recovery assumptions, rather than simply renaming an old total-fee target.

**Risk and privacy.** Quote opt-in shares only the proposed Bitcoin outpoints with responding providers that support this feature. It links those inputs earlier than a broadcast lock would. The provider may still be unable to realize its estimated recovery price, and taking stuck TAC spends Ethereum inventory. The cap limits that drawdown but cannot refill it. A haircut is an estimate: the replay's first stress case shows a realized loss beyond the estimate still lands on the provider.

**Replay.** Run `node tests/fastbridge-stuck-simulation.mjs`. All strategies start with 1,000 TAC on Ethereum and see the same 20 requests of 100 TAC: 14 clean, four long, and two shielded. The normal fee is 1%, clean TAC returns home at full face, and stuck TAC recovers at the haircut rate in the base case. The report keeps the face value of the stuck lock, its assumed recoverable value (face minus the haircuts) and the realized gain distinct.

| Policy | Filled | Refused | Fees | Ethereum TAC left | Stuck face | Net gain |
|---|---:|---:|---:|---:|---:|---:|
| Clean only | 14 | 6 | 14 | 1,014 | 0 | 14 |
| Any, flat fee | 20 | 0 | 20 | 420 | 600 | −42 |
| Flat fee with a 300 TAC cap | 17 | 3 | 17 | 717 | 300 | −14 |
| Classified with caps | 17 | 3 | 48 | 748 | 300 | 17 |

For the same 17 fills, class pricing retains 31 more TAC than the capped flat-fee baseline and leaves the normal margin intact. The caps account for the reduction from 600 to 300 TAC of stuck inventory. The script then runs five stress cases on the classified policy: a realized haircut worse than the estimate (the provider eats the shortfall), a rising stuck ratio (the caps, not the mix, bound exposure), a long lock that cannot sell (the cap is the only limit on the loss), cap exhaustion (clean TAC keeps flowing while stuck refuses), and a refund that frees cap for a repeat request.

These gains are modeled under the stated recovery assumptions, before operating and transaction costs; the replay does not execute a sale. Its refund scenario returns exactly the original payout, including the deduction of the normal fee, and asserts conservation after the replacement swap.

**Verification.** Run `node --test --test-force-exit tests/fastbridge-stuck-pricing.test.mjs` and `node tests/fastbridge-lp-livepool.test.mjs`. The offline Bitcoin and Ethereum simulators exercise quote, reserve, lock verification, payout, taking the Bitcoin lock and persisted exposure. The cold-check tests cover progress, input binding, simultaneous ordinary quotes, and the exact confirmed exit and payout from upstream's public mainnet fixture. Explorer and pool responses are replayed locally, so these checks do not measure live trace latency or validate Signet/mainnet execution, realized haircuts or liquidation fills. Fork scenario F (`SCENARIOS=F node tests/fastbridge-fork.mjs`) replays the same against a local Anvil fork for the settlement path. Deployed contract code, proof rules and protocol settlement are unchanged.
