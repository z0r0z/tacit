# Maintainer response — GPT greenlight audit, round 12 (bundle @ `82ea3bf`)

Twelfth (final belt-and-suspenders) pass. It did **not** stay clean: it found one **Medium fund-loss** in the
Bitcoin LP-add pool-disambiguation (the prior "LP pid binding" class), plus two no-exploit defensive items.
The reflection block-authentication, cross-chain conservation, relayer, cBTC, and ETH-recursion surfaces were
all re-confirmed safe (four whole-system safety confirmations).

| ID | Finding | Severity | Verdict | Disposition |
|----|---------|----------|---------|-------------|
| M-01 | Bitcoin variant-0 `T_LP_ADD` resolves the FIRST same-pair pool, not the kernel-bound one | Medium (user fund-loss) | **Real** | **Fixed** |
| L-01 | SegWit `compute_txid` parser not fully exact/canonical | Low | **Real** | **Fixed** (safe subset) |
| L-02 | cBTC backing uses `saturating_*` arithmetic | Low | **Accepted** | **Documented** |

## M-01 — variant-0 LP-add pool disambiguation — FIXED

Confirmed. A variant-0 `T_LP_ADD` carries no pool identity, so the guest must pick which same-pair pool the
add targets. It picked `pool_ids_for_assets(&ca,&cb).first()` instead of the candidate whose LP-add kernels
actually verify. With multiple same-pair pools (e.g. distinct protocol-fee tiers), a victim's valid add to a
non-first pool binds the intended `pool_id`, but reflection scans the tx, nullifies the victim's input notes
in `scan_tx_spends`, then runs `fold_lp_add` against the **wrong** (first) pool — both kernels fail, no
reserves advance, no LP-share note is onboarded, and the input notes are already gone → user fund loss/grief
(no attacker theft or inflation). `fold_lp_remove` already did this correctly (iterate candidates, pick the
one whose kernel verifies).

**Fixed** by mirroring the LP-remove disambiguation: compute the per-asset spend groups first, then for
variant-0 select the unique same-pair candidate for which **both** `lp_add_kernel_verify` calls pass (the
kernel sig binds `pool_id`, so at most one matches), and fold against that. Mirrored byte-for-byte in the JS
attester (`foldLpAdd`). Single-pool pairs are unaffected (the one candidate's kernel verifies → same result),
so the DIGEST_MATCH gate stays green.

## L-01 — SegWit txid parser exactness — FIXED (safe subset)

The non-witness 64-byte path already parses exactly; the segwit path did not require nonzero vin/vout or exact
consumption. No fund path (the wtxid commitment binds the full bytes where a commitment exists; non-committed
blocks fold no envelopes; a non-exact txid fails the merkle check), but it is a brittle consensus-boundary
after two 64-byte reflection bugs. **Fixed** with the unambiguously consensus-matching subset: reject
`input_count == 0`, reject `output_count == 0`, and require exact consumption (`pos + 4 == len`, no trailing
bytes) — every consensus-valid segwit tx passes (DIGEST_MATCH gate green), malformed/non-exact synthetic forms
reject. (Canonical-CompactSize enforcement, which the auditor marked "optional," is intentionally NOT added —
over-strict varint rules risk rejecting a consensus-valid form and stalling the forward-only chain.)

## L-02 — cBTC backing saturating arithmetic — accepted, documented

`cbtc_backing_sats` is a **tracking** total, not the mint-safety gate (the contract enforces backing per-lock:
exact `vBtc` + one-mint-per-lock). It provably cannot overflow (it sums distinct live-lock `v_btc`, bounded by
Bitcoin's ~2.1e15-sat supply ≪ `u64::MAX`) and the subtract always removes exactly the `v_btc` a **present**
lock contributed (the `if let Some(..) = cbtc_locks.get(..)` guard), so it never underflows — `saturating_*`
is mathematically equivalent to `checked_*` here. Converting to `checked_*().expect()` would convert a
hypothetical (unreachable) invariant break into a **panic in the forward-only reflection scan** — i.e. a
permanent-stall vector — for a value that isn't the safety gate. That is the wrong trade for an immutable
chain, so we kept `saturating_*` and **documented the no-overflow/no-underflow invariant + the deliberate
liveness rationale** at the call site.

## Whole-system safety confirmations (re-verified by the auditor)
No renewed 64-byte/coinbase/witness reflection bypass; burn→mint-once + cross-lane consumed freshness +
ETH-reflection recursion compose; cBTC lock/mint/redeem/rug/escrow backing conserved; relayer cannot inflate
fees, redirect payouts, or profitably replay/reorder. (Details in the auditor's four confirmation rows.)

## Net
M-01 (the Medium fund-loss) is closed and the class swept (it was the only position-based pool disambiguation;
every other op carries an explicit/derived `pool_id`); L-01 hardened; L-02 documented. cxfer-core 154/154; the
reflection DIGEST_MATCH gate is green; forge unaffected (no contract changes). Because this "final" pass again
surfaced a real fund-impacting finding, a further confirmatory round on the M-01-fixed commit is warranted
before the re-prove + immutable lock.
