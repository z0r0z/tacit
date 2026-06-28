# Maintainer response — GPT greenlight audit, round 7 (bundle @ `37b94da`)

Seventh pre-reprove pass. One High fund-loss (CDP liquidation), fixed + proven; one defensive pool-init gap,
fixed; one relay deploy-invariant, documented.

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| F-01 | CDP liquidation burns the liquidator's debt notes without binding the seized-collateral recipient or fee | High (fund loss) | **Real** | **Fixed + proven** |
| D-01 | BitcoinLightRelay MTP under-seeded if genesis is mid-epoch | Medium (needs confirmation) | **Deploy invariant** | **Documented** |
| D-02 | Protocol-fee pool can be funded with an off-curve recipient (trap pool) | Low | **Real** | **Fixed** |

## F-01 — CDP-liquidation payout not bound to the debt-note authorization — FIXED

Confirmed and serious — the same authorization-binding class as round 4 (transfer output-owner) and round 6
(protocol-fee claim). `OP_CDP_LIQUIDATE` reads a public `liquidator` (the seized-collateral recipient) and a
public `fee`, then withdraws the basket to `liquidator` and pays `fee` to the settler. But the debt-note
opening-sigma context bound only the position, debt asset, note, and amounts — **not** `liquidator` or `fee`.
A delegated prover/worker holding the keeper's valid debt-note witnesses could mutate only the public
`liquidator`/`fee` fields and redirect the seized basket to itself while still burning the keeper's notes.

**Fixed:** every burned debt note's `intent_context` now binds the `liquidator` (a left-padded address word)
and the `fee` (a trailing amount). Re-deriving the context with a different liquidator/fee changes the
challenge, so the opening sigma fails. Mirrored byte-for-byte in the dapp (`cdpLiquidateDebtSigma` +
assembler) and the fixture generator.

**Proven** (guest-level, fresh ELF): the liquidate exec harness EXECUTE_OKs the correctly-bound witness
(full execution, 1.26M cycles) and the guest **panics at the debt-opening-sigma assert** when only the
`liquidator` field is tampered. A JS check independently confirms the sigma verifies under the correct
liquidator+fee and fails under either tampered.

## D-01 — BitcoinLightRelay genesis MTP seeding — deploy invariant

The relay accepts a mid-epoch genesis checkpoint while storing a single timestamp for the tip, so the first
post-genesis headers are compared against an under-seeded median-time-past window until 11 relay-known
ancestors exist. On mainnet this still requires valid PoW at target, so it is not a theft path; it is a
consensus-divergence footgun only under a mid-epoch genesis. **Disposition:** this is enforced as a deploy
invariant — the genesis checkpoint is anchored at an epoch boundary (or seeded with the true prior-11
timestamp window) in the deployment playbook, which is also where the mainnet Bitcoin anchor is set (a
tracked deploy-time item, not an in-source value). No code change to the immutable contract; the invariant is
recorded with the other genesis-anchor deploy gates.

## D-02 — Off-curve protocol-fee recipient (trap pool) — FIXED

`OP_LP_ADD` funded a protocol-fee pool without validating the recipient is a valid curve point. An off-curve
recipient produces a fundable pool whose accrued skim is permanently unclaimable (the claim verifies a sig
under the recipient) and whose swaps fail closed — a trap/dead pool. Not third-party theft (the recipient is
bound into the pool id, so it can't be front-run), but an avoidable production hazard accepted at funding and
only discovered later. **Fixed:** `OP_LP_ADD` now rejects funding a `protocol_fee_bps != 0` pool whose
recipient does not decompress (the same on-curve gate `OP_SWAP` already applies before any skim), at the
earliest funding boundary.

## Bonus — local exec-harness suite hardening

While proving F-01, the local execute-mode harnesses (`reflect-exec/*_execute.rs`) were found to report
`EXECUTE_OK` even for a rejected witness: `client.execute().run()` returns `Ok` on a guest panic (the
rejection is a non-zero `exit_code`, not an `Err`), and the harnesses printed the fixture's *expected* values
without asserting the guest's exit code. Added an `assert_eq!(report.exit_code, 0, …)` to every local
harness so a rejecting guest now fails the harness. (The box re-prove is unaffected — it runs in prove mode,
which cannot produce a proof for a panicking execution, so drift/rejection already fails the re-prove loudly.)
This surfaced pre-existing stdin write-order drift in several local harnesses (they predate later-added guest
fields), now being realigned to the current guest read order.

## Net
F-01 (the High fund-loss) is closed and proven; D-02 is closed; D-01 is a documented deploy invariant.
cxfer-core 152/152; the F-01 guest binding verified accept/reject on a fresh ELF.
