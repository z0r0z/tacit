# Maintainer response — GPT greenlight audit, round 15 (bundle @ `3421640`)

Fifteenth pass — the tightest yet. **No** Critical/High; the spend-nullifying reflection folds and the
round-13/14 boundary fixes were re-confirmed correctly narrowed. One **Medium** fund-liveness miss in the
ETH→BTC cross-out fold (the same silent-omit class as round-14's burn-deposit), plus four **Low/Quality**
retryable-omission inconsistencies in the entitlement folds. All addressed.

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| M-01 | Fresh ETH→BTC cross-out mint can be silently omitted by a bad consumed-set / note-append witness | Medium (strand/censor) | **Real** | **Fixed** |
| L-01 | Harvest reward append retry-skipped on a bad append witness | Low | **Real** | **Fixed** |
| L-02 | Farm-refund append retry-skipped on a bad append witness | Low | **Real** | **Fixed** |
| L-03 | LP-unbond return append retry-skipped on a bad append witness | Low | **Real** | **Fixed** |
| L-04 | Protocol-fee-claim append retry-skipped on a bad append witness | Low | **Real** | **Fixed** |

## M-01 — cross-out silent-omit (the round-14 class, in the consumed-set fold) — FIXED

`fold_crossout` gated the whole onboard on `imt_insert_transition(...).ok_or(...)?` — which returns `None` for
**both** a genuine replay (claim_id already consumed) **and** a bad fresh insert witness — and the dispatcher
consumed that `Err` with `let _ = …` (skip). So after the ETH cross-out membership passes (the cross-out is a
real, authorized burn), a malicious prover could supply a bad consumed-set insert or note-append witness and
the confirmed Bitcoin mint would be silently dropped from the reflected live set. As the auditor noted, it
isn't inflation/double-mint (the claim stays unconsumed), but it strands/censors the confirmed mint, so it
violates the skip-vs-abort line.

**Fixed** by adopting the spent-set's repurposed-witness discipline (the same shape the burn-deposit fold uses
since round 14): a genuine replay presents `c_low_value == claim_id` (impossible for a real insert, which needs
`low_value < claim_id`) → membership-gated no-op skip; a **fresh** claim_id must insert and append, and a
failure there now **aborts** (a confirmed authorized cross-out is recorded or the proof is rejected). The
worker (`foldCrossout`) emits the repurposed membership witness for a replay (it already detected replays via
`contains`) and the straddling insert witness for a fresh claim — mirrored byte-for-byte. The forward batch
(`crossout_set_root == 0`) and non-members still skip at the membership check, before the insert. The crossout
fixture (a fresh mint with a valid witness) regenerates to a byte-identical digest, so the gate stays green.

## L-01..L-04 — entitlement-fold append atomicity (uniformity) — FIXED

The auditor correctly classed these as **not lock-blocking**: harvest / farm-refund / LP-unbond / protocol-fee
claim each stage their note append before committing the spend/entitlement (or the dispatcher snapshots and
restores), so a bad append commits nothing and is retryable — no strand, no theft. But it left a malicious
prover able to *force a retry* (a griefing/censorship inconsistency with the skip-vs-abort discipline). **Fixed**
for uniformity by aborting the **deterministic note-append** (`fold_output`) in `fold_harvest` (covers harvest
+ refund), `fold_lp_unbond`, and `fold_protocol_fee_claim`: the note-frontier append path is a deterministic
prover witness reached only after every tx-controlled check (owner/launcher/recipient sig, reward-≤-treasury,
exact-accrued, opening) has passed — exactly the round-13 boundary, with no round-14 over-abort exposure (the
append is never tx-controlled). The preceding tx-controlled semantic checks remain skips. The honest worker
always derives valid append paths, so the JS attester needs no change and the gate is unaffected.

## Skip-vs-abort, both directions — re-confirmed
The auditor independently re-derived the boundary across every spend-nullifying fold (block/header/ETH-recursion
auth, fast-lane consumed-ν, vin-scan + spent insert, bridge/burn-deposit, cxfer/preauth, swap var/route/batch,
LP add/remove/bond, farm-init, cBTC, burn→mint) and found **no** round-14-style over-abort and **no**
round-13-style strand remaining — only the cross-out under-abort (M-01) and the four retryable Lows, now closed.

## Verification
cxfer-core 154/154 (the crossout test now asserts: a member fresh-folds, a replay membership-gates as a no-op,
and a **fresh claim with a bad insert witness aborts**; the four entitlement appends abort on a bad path while
tx-controlled failures still skip). The reflection DIGEST_MATCH gate is green — the crossout fixture
regenerates byte-identically (the fresh/valid path is unchanged). Forge unaffected (no contract changes).

## Net
M-01 (the Medium strand/censor) and the four Low retryable-omissions are closed; the cross-out fold now matches
the round-14 burn-deposit discipline and the entitlement appends match the round-13 one. Because this pass —
the first with no Critical/High — still surfaced a real fund-liveness finding (the fifth "final" round to find
something), a further confirmatory round on this commit is warranted before the re-prove + immutable lock.
