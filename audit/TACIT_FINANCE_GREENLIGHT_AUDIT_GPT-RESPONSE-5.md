# Maintainer response — GPT greenlight audit, round 5 (bundle @ `7b5dc2c`)

Fifth pre-reprove pass, into the Bitcoin-reflection / farm composition. Three findings — the two
fund-critical ones fixed; the defensive class hardened at its reachable instances.

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| F-01 | Zero-share `T_LP_BOND` panics the guest → permanently stalls the forward-only reflection | Critical | **Real** | **Fixed** |
| F-02 | Bitcoin farm refund/timing not proof-enforced (launcher can refund mid-farm; window dropped) | High | **Real (split)** | **Both fixed** (refund-rug + accrual window) |
| Q-01 | Adversarially-reachable `assert!/expect` panics in farm helpers | Medium | **Real** | **Fixed** at the reachable instances |

Commit: (this batch). All guest-only — no new committed reflection state, so the genesis digest is
unchanged; only `reflection_farmrefund` (a scenario change) regenerates. cxfer-core 151/151; the guest↔JS
DIGEST_MATCH gate is green (`swapbatch` remains the ceremony-zkey box-regen item from round 4).

## F-01 — Zero-share bond panic / reflection stall — FIXED

Confirmed and serious. `lp_bond_kernel_verify` rejected empty inputs but **not `bond_amount == 0`**, and
`fold_lp_bond` called `FarmRewardState::bond(shares, …)` which does `assert!(shares > 0)`. A panic inside a
reflection fold can't be caught — it aborts the SP1 program, so **no proof can be produced for that block or
any state continuing it**, and because the contract chains `priorDigest == knownReflectionDigest` the chain
can't skip the block. Any attacker who confirms one cheap Bitcoin tx (a zero-value LP-asset note bonded with
`bond_amount = 0`) permanently bricks Bitcoin reflection, cBTC, reverse mints, and cross-lane freshness.
**Fixed:** `lp_bond_kernel_verify` rejects `bond_amount == 0` (the dispatcher's `bond_backed` gate then fails
→ `fold_lp_bond` is never called), plus a defense-in-depth `shares == 0` skip in `fold_lp_bond`. The
malformed bond is now skipped (skip-not-panic), the block reflects normally.

## F-02 — Bitcoin farm refund / timing — REFUND-RUG FIXED, accrual-window follow-up

Two separable issues:
- **Refund-rug (fund-critical) — FIXED.** `fold_farm_refund` verified the launcher sig but gated nothing
  else, so a launcher could sign a refund **mid-farm** and `fold_harvest`-debit the C0-backed treasury below
  the accrued liability of live receipts, leaving stakers unable to harvest. **Fixed** by the audit's
  endorsed option: refund is rejected while `total_shares != 0` — only once every bond has unbonded may the
  launcher reclaim the unspent treasury (no live-staker rug). Mirrored in the JS attester; the
  `reflection_farmrefund` fixture now models the all-exited scenario.
- **Accrual window (fairness) — FIXED.** `parse_farm_init_envelope`'s offset reserved
  `start_height`/`end_height` but the parser skipped them, so `accrue()` wasn't clamped to the campaign
  window — a bonder could earn pre-start or keep earning post-end (treasury-bounded, so unfair *timing*, not
  inflation). **Fixed** by threading the window through the whole farm state machine: the parser now reads
  `start/end`; `FarmRewardState` carries them; `accrue()` clamps emission to `[start, end]` (`end == 0` ⇒
  perpetual) — EVM `periodStart/periodFinish` parity; a malformed `end ≤ start` init is rejected. They ride
  the `FarmRewardSet` leaf → `digest()` → resume read → the `reflect_stdin` serializer → the JS attester, so
  the guest↔JS DIGEST_MATCH gate stays green (the empty farm set is unchanged, so the genesis digest does
  not rotate — only farm-containing fixtures regenerated). A unit test asserts the clamp.

## Q-01 — Reachable panics in farm helpers — FIXED at the reachable instances

The concrete exploitable instance was F-01 (`bond(0)`). The other reachable one: `verify_farm_harvest` calls
`farm_harvest_new_entry` (which asserts `shares > 0`) **before** the receipt membership check, so a forged
`shares = 0, reward = 0` harvest panics. **Fixed** by rejecting `shares == 0` in `harvest_ok` (fail-closed →
`verify_farm_harvest` returns `None` → the harvest skips). `unbond` is already membership-gated (its
`shares > 0` assert is unreachable — a zero-share receipt can't exist now that `bond` rejects it). The
`accrue`/`harvest_ok` arithmetic is already saturating/checked. Net: no `panic!/assert!/expect!` reachable
from a tx-controlled field in the farm fold path.

## Prior-finding regression check
The auditor independently re-verified the round-4 fixes hold (the consumed-cross-out replay gate validates
the insert before appending and commits only after `fold_output`; the four fold-atomicity fixes intact) and
found no new cross-out replay, digest rollback, delegated-proving replay, or pool-identity collision.

## Net
F-01 (the Critical reflection-stall DoS), the F-02 refund-rug (the fund-loss) AND the F-02 accrual window
(the fairness gap) are all closed; Q-01's reachable panics are gone. cxfer-core 152/152 (incl. the new
window-clamp test); the guest↔JS DIGEST_MATCH gate is green (only the ceremony-zkey `swapbatch` regenerates
on the box). Surface is greenlight-ready for the re-prove.
