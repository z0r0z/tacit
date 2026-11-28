# Stuck TAC entry A: a desk for stuck TAC

**What it does.** `btcswap-desk/lib/stuck-desk.mjs` is the quoting and pledge-bookkeeping core of a
desk that swaps stuck TAC for tracked TAC on Bitcoin at a clear, bounded discount, funded by pledged
tracked TAC. It sits in front of the desk that already exists (`btcswap-desk/server.mjs`,
`dapp/btcswap-desk.js`): that desk swaps any note the bridge's proof does not follow at one flat fee
out of its own wallet. This entry adds the three things it does not have — classes, a bounded
discount schedule, and funding by pledges from more than one wallet.

**Classes and discounts.** Intake classifies a note from the same reads the screens already make
(the reflection trace, as in `lineageScreen` in `dapp/fast/wire.js`), with the same answers as the
pricing-rule entry: clean, long-history (more than 255 transfers), pool-exit (opcode `0x6d`), or
unknown — and unknown is refused with a retry, never guessed. Clean notes are refused too: they
bridge on their own. A quote is `amount × (1 − discount)` in BigInt base units, the discount per
class read from the desk's config (`btcswap-desk/config.stuck-desk.example.json`) but clamped in
code to a hard band (long-history 500–6,000 bps, pool-exit 1,000–7,500 bps) whatever the config
says. The defaults, 3,680 and 4,255 bps, are the pricing rule's fees for the same classes, so a
holder pays one schedule at either door. A quote is never made below the floor the config states
for the class (the least share of face a holder is offered): the floor caps the discount, and a
floor no allowed discount can honour disables the class rather than break either bound.

**Pledges, and who holds what.** The desk's tracked TAC is pledged, per pledger, in a pure
bookkeeping ledger: pledges, reservations against open quotes (oldest pledge first), settlements.
No one's funds are held under one key: this module holds no key at all. In the model implemented
here a pledger's TAC stays in the pledger's own wallet until the pledger itself locks it into a
swap the desk has quoted (the two-lock swap of `dapp/btcswap.js`, whose desk half a pledger's
daemon can equally make); the book is how the desk knows whose TAC a quote may promise, and a
pledger can withdraw whatever is neither reserved nor settled.

**Limits, all enforced in code.** Per-note cap (1,000 TAC), per-day cap on what the desk pays out
(5,000 TAC), one quote takes at most 20% of pledged inventory, the last 10% of pledged inventory
is a reserve that is never quoted away, quotes expire (600 s) and an expired quote frees its
reservation whole. Compatibility: nothing deployed changes, no message gains a required field — a
desk that loads this quotes through the same `/quote` shape with the same members; the class and
discount ride in the quote it already returns, and a desk that does not load it answers as today.

**Numbers** (`node btcswap-desk/stuck-desk-sim.mjs`, deterministic). 1,000 bridges of 100 TAC,
5% of notes stuck (the brief's count: 230 of 4,546 over the history limit; of the stuck, 70%
long-history / 30% pool-exit is an assumption, as pool exits were not counted), provider starting
with 10,000 TAC lendable, desk funded by 10,000 TAC pledged. Without the desk the provider ends
with **5,000 TAC lendable and 5,000 TAC stuck** on Bitcoin. With the desk it ends with
**8,073.75 TAC lendable and nothing stuck**: all 50 stuck notes swap, the desk pays out 3,073.75
tracked TAC, and the provider's whole loss is the 1,926.25 TAC of discount — against 5,000 TAC of
dead inventory without it. The desk's busiest day pays out 172.35 TAC of its 5,000 TAC cap, and
6,926.25 TAC of pledges is never spent.

**Risks.** The discount is the desk's whole protection and it is a guess about what stuck TAC
realises; the bands and floors bound a bad guess, they do not remove it. A desk whose pledgers all
withdraw at once can quote nothing (it refuses, with a retry, rather than promise what it does not
hold). Whoever runs the desk still carries the existing desk's risk that a holder who never claims
leaves locked TAC to come back untracked after its timelock.

**What was not tested.** Offline only: the module, its tests (19, `node tests/stuck-desk.test.mjs`)
and the simulation. No live Bitcoin signing or settlement, no signet run, no HTTP wiring into
`btcswap-desk/server.mjs` — quotes are modelled and accepted in-process, and the step where a
pledger's own daemon makes the desk's lock from its own wallet is described, not built. The trace
a note arrives with is taken as read; reading it from the chain is the screens' existing work.

**Payout.** 300 TAC, once merged, to `0x8D639F9033a1bD321404A9Ed667a9d396d1fecaE` (burner 2, confirmed
by the user 2026-11-25).
