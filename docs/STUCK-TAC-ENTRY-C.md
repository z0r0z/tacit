# Stuck TAC entry C: a pricing and policy rule — generik

**What it is.** One pure module, [`fastbridge-lp/lib/stuck-pricing.mjs`](../fastbridge-lp/lib/stuck-pricing.mjs),
that a provider daemon asks before it quotes: what class is this lock's TAC, what fee covers it, and
may this provider take it at all today. Plus its tests
([`tests/stuck-pricing.test.mjs`](../tests/stuck-pricing.test.mjs)), a worked simulation
([`fastbridge-lp/stuck-sim.mjs`](../fastbridge-lp/stuck-sim.mjs)), and an example config section
([`fastbridge-lp/config.stuck.example.json`](../fastbridge-lp/config.stuck.example.json)). Nothing
deployed changes: the module is additive, no existing file is touched, a provider that does not load
it quotes exactly as before, and a quote made with it carries no new field — the fee is in the
members a quote already has.

**The rule.** A lock takes the worst class of the notes it spends, told apart by the same trace reads
the screens already make (`lineageScreen`, `policy.screen`):

| class | told by | expected recovery | fee (bps of amount) |
|---|---|---|---|
| clean | the proof follows it home | 100% — it bridges home | 30 (the ordinary fee) |
| long history | more than 255 transfers behind it | 65% of face | 3,680 |
| pool exit | opcode `0x6d`, out of the shielded pool | 60% of face | 4,255 |
| unknown | the trace could not be read | — | refused, with a retry |

`feeBps = baseFeeBps + (10000 − recoveryBps) + lockupBpsPerDay × expectedDaysStuck`. That is
break-even by construction: the provider pays out `amount − fee` and holds a note expected to realise
`recoveryBps` of face, so the payout never passes what the note is expected to be worth once the
wait (30 days long-history, 45 pool-exit, at 5 bps a day) is paid for. Recovery is a config value,
meant to be read from what stuck TAC actually trades at on Bitcoin, not a constant of the protocol.

**Limits, all read from the provider's own config** (the `stuck` section; defaults in the code):
a class expected to realise under the floor (50% of face) is refused rather than priced; a stuck take
is capped at 100 TAC a note and 200 TAC a day; stuck face held may not pass 20% of the provider's TAC
inventory; and a fee past 90% — what a bridger's client will quote at all — is refused, not quoted.
A bad recovery guess can therefore only cost a bounded slice of one provider's book.

**Numbers** (`node fastbridge-lp/stuck-sim.mjs`; 100 TAC a bridge, 10,000 TAC starting inventory,
mix per the brief's count: 5% long history, plus an assumed 2% pool exit — the brief counts none):

| bridges | rule | ETH inventory left | stuck face held | value held (ETH + realisable stuck − lockup) |
|---|---|---|---|---|
| 100 | without | 9,340 | 700 | 9,785 |
| 100 | with | 9,607 | 700 | 10,040 |
| 1,000 | without | 3,400 | 7,000 | 7,850 |
| 1,000 | with | 9,110 | 2,000 (cap; 50 takes refused) | 10,380 |

Without the rule the drain is the bounty's problem statement in numbers: 70% of the provider's
capacity gone after 1,000 bridges, 2,150 TAC of it unrecoverable. With the rule, capacity holds and
the priced fees cover the haircut on what is taken.

**Assumptions.** Recovery and days-stuck are estimates a provider sets from its own sale experience;
the trace verdicts a daemon already gets are enough to classify (no new read is added); a refused
holder keeps their note and may sell it on Bitcoin themselves, as today.

**Risks I see.** Recovery is the whole rule: if stuck TAC trades worse than the configured recovery,
the provider loses on the slice the caps allow — bounded, not zero. Fees of 37–43% will send most
stuck holders elsewhere, which may be the right outcome (the provider is a bridge, not a buyer of
last resort) but means the rule mostly protects capacity rather than moving stuck TAC. Classification
inherits the trace's limits: a note misread as clean is taken at the clean fee.

**What I did not test.** No wiring into the running daemon or the page provider (the rule is a gate
in front of the quoter; the integration is a call in `makeQuoter`'s path and is deliberately left as
the daemon owner's step); no chain, fork or signet run — classification consumes verdicts, it does
not make them; no live order-book data behind the recovery defaults; the simulation is a fixed-mix
accounting model, not the simulated-chain swap harness.

**Tests.** `node tests/stuck-pricing.test.mjs` — 11/11 checks pass offline (Node 24): each class, the
255/256 boundary, worst-note locks, unknown refused with retry, fee monotonicity and haircut
coverage, the floor, all three caps, the 90% quote ceiling, and the safe defaults.

**Payout.** 300 TAC, once merged, to `0x53d0438e746575aAfb90f092162e1c4143C5EAe1` (burner 1, confirmed
by the entrant).
