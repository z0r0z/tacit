# Box MODE=execute validation vectors — Bitcoin AMM folds (reprove gate)

The T_SWAP_VAR / T_SWAP_ROUTE / T_SWAP_BATCH reflection folds are byte-bound and unit-tested for message parity
(cxfer-core KATs + tests/amm-intent-msg-pin against the real worker/dapp), but they have NEVER run end-to-end:
`fold_swap_batch` links `bn` (Groth16 + BabyJubJub, box-only), and the var/route folds need real keccak-tree
append paths. These vectors MUST pass on the box before the AMM ops are relied on. On every negative, assert the
block's reflection STILL ADVANCES (a malformed swap self-strands only its initiator; no abort/halt).

## VAR
Every VAR tx now carries a REFUND output at vout 3 (P2TR to the trader), bound in the intent alongside the
receipt and change destinations. The receipt commitment is no longer on the wire — the guest forms
`C_receipt' = delta_out'·H + r_receipt·G` from the `delta_out'` it recomputes against the CURRENT reserves — and
the BP+ aggregate is m=1 over `[C_change]` only. Vectors 1-6 keep their meaning; 1a/2a/3a/16-19 are new.

1. positive, whole-input (sentinel change, empty bound change script): receipt onboards, reserves advance, one note appended.
1a. the onboarded receipt's commitment equals `get_amount_out(delta_in, r_in, r_out, pool.fee_bps)·H + r_receipt·G` — i.e. the guest priced it, and at the pool's REGISTRY fee tier, not one the envelope declared.
2. positive, partial input: receipt @vout1 + change @vout2 onboard atomically, note_count += 2, each leaf carries its own output's x-only key.
2a. the m=1 change range proof is accepted and an m=2 (old-shape) proof is REJECTED — the wire shape really moved.
3. negative: change paid to a script other than the signed one → skip, nothing folded, reserves untouched.
3a. negative: refund output paid to a script other than the signed one → skip (a coordinator must not be able to force staleness and collect the refund).
4. negative: non-sentinel change with only 2 outputs (no vout 2) → skip.
5. negative: change output non-P2TR (P2WPKH) → skip.
6. negative: expiry_height == 0, and expiry_height == block_height − 1 → skip.
16. **THE C-01 VECTOR — two concurrent swaps on one pool, same block.** Both spend their own note, both confirm.
    The first folds its receipt and advances the reserves; the SECOND is priced against those ADVANCED reserves
    and folds its own receipt at the moved price. Assert: both traders hold a live receipt note, neither input is
    stranded, `note_count` grew by both, the reserves reflect both trades, and the reflection advances. Before
    this change the second swap folded NOTHING and its principal was destroyed — that is the regression this
    vector exists to catch, so run it against the OLD ELF once to confirm it reproduces the loss.
17. over-slippage refund: a swap whose `min_out` exceeds what the moved reserves clear → the REFUND note onboards
    at vout 3 committing the input's exact (Cx,Cy), the input stays nullified, the reserves are UNTOUCHED, the
    change note is NOT onboarded, and the trader can spend the refund with the vout-3 key.
18. negative: refund output missing (only 3 outputs) or non-P2TR → skip. Checked up front, so it cannot be
    reached only on the refund branch.
19. an empty-sided pool (reserve_in == 0) → skip rather than price (the formula would degenerate to the whole
    out-side reserve).

## ROUTE
Each hop is re-cleared against that pool's CURRENT reserves at its REGISTRY fee tier, chained from the amount the
previous hop really produced; the refund lands at vout 2 (a route has no change output). The signed intent binds
the route's SHAPE (pool + direction per hop), its input amount, min_out, the receipt blinding, and both
destinations — NOT any hop's fee tier, pre-reserves, or output magnitudes.
7. positive 2-hop and 4-hop.
8. negative: redirected receipt → skip.
9. negative: expiry_height == 0 → skip.
21. **THE C-01 VECTOR for routes** — a pool the route spans is advanced by a concurrent op in the same block. The
    route still executes, re-cleared at the moved price, and the trader holds a receipt. Also run the 4-hop case
    with a MIDDLE pool moved. Against the OLD ELF this stranded the whole route's input.
22. over-slippage refund: min_out above what the chain can clear → the refund note onboards at vout 2 committing
    the input's exact (Cx,Cy) of the INPUT asset, and NO pool along the route moves.
23. a hop that re-clears to zero (dust input against a large pool) → refund, not a skip and not a reject.
24. negative: refund output missing / non-P2TR / redirected → skip.
25. a stale hop snapshot (declared r_*_pre and delta mags disagree with the tracked reserves) must NOT require
    re-signing: the same signature verifies and the route folds. This is the property that closes C-01.

## LP_ADD / LP_REMOVE
Both pay from CURRENT pool state and FORM their note commitments from the amount computed, under the blindings the
envelope publishes on-chain (`share_r`, `r_recv_a`, `r_recv_b`). Neither has a signed slippage floor, so neither
has a refund tier — they always execute.
26. LP_REMOVE against a pool moved by a concurrent swap → pays the NEW proportion, onboards both withdrawn notes,
    debits the reserves by what was actually paid. Against the OLD ELF the LP's shares were burned for nothing.
27. LP_REMOVE against a pool whose total_shares moved via protocol-fee crystallization (an LP event in the same
    block) → same: pays out rather than skipping.
28. LP_ADD whose declared `share_csecp` no longer opens to the reflection-computed `lp_shares` (because a
    concurrent swap/LP event moved the reserves or total_shares) → the share note is onboarded for the REAL
    minted amount. Against the OLD ELF the deposit was nullified and no shares were issued.
29. LP_ADD minting zero shares → still restores the registry and skips (no note to onboard).

## BATCH (real envelope + Groth16 proof from the worker's builder)
`fold_swap_batch` links `bn`, so it is box-only: it type-checks locally but NOTHING in it has ever executed here.
Its per-intent message now binds a refund destination (receipt i at vout i+1, refund i at vout n+1+i), and the
one-to-one spend matching + per-intent authorization were REORDERED ahead of the clearing checks so a refund is
only ever minted against a proven real, distinct, authorized input. That reorder is the highest-risk change in
this set and needs explicit coverage: re-run EVERY existing batch negative (11-15) to confirm the reorder did not
weaken any of them.
10. positive n=1, n=2, n=16 — all receipts onboard at vouts 1..n.
30. **stale batch** — a concurrent op advances the pool after the batch's proof was generated. The Groth16 check
    fails against the current reserves and ALL intents refund, each to its OWN signed vout n+1+i, each committing
    that intent's input commitment verbatim on that intent's input asset. Reserves untouched, reflection
    advances. Verify with n=2 and n=16 (the refund vout indices are where an off-by-one would surface).
31. negative: one intent's refund output redirected / missing / non-P2TR → the whole batch skips (fail closed
    BEFORE any refund is onboarded, since the auth loop now runs first).
32. a batch whose intents do NOT one-to-one match the detected spends (reused or unaccounted spend) → skip, and
    critically NO refunds onboarded — this is the inflation path the reorder had to avoid opening.
11. negative: receipt i redirected to another script → whole batch skips.
12. negative: receipts permuted between two intents (Groth16 public-signal mismatch) → skip.
13. negative: substituted c_in_bjj (input xcurve) → skip.
14. negative: one intent expiry_height == 0, and one expired → whole batch skips.
15. negative: two intents sharing one real spend (double-count) → skip.

## Registry / resume
20. The pool leaf and the resume handoff now carry `fee_bps`. Run a resume from a NON-EMPTY registry seeded with a
    non-zero swap-fee tier AND a non-zero protocol skim (tests/gen-reflection-poolresume-synth.mjs) and assert
    DIGEST_MATCH — the leaf order is `.. c0_backed ‖ fee_bps ‖ protocol_fee_bps ‖ k_last ‖ accrued`, and the
    reflect-stdin writer / JS mirror must agree with the guest reader on it. A pre-change handoff MUST fail the
    priorDigest chain rather than be silently accepted.

## Residual after this pass
Nothing unbound is named in the three ops (per-op binding matrix all green: destination/auth/terms bound in the
intent, enforced in the guest, byte-matched worker+dapp, fail-closed on malformed). The remaining exposure is
entirely that the folds have never executed — these vectors close it.
