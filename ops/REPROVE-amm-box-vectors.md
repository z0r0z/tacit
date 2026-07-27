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
7. positive 2-hop and 4-hop.
8. negative: redirected receipt → skip.
9. negative: expiry_height == 0 → skip.

## BATCH (real envelope + Groth16 proof from the worker's builder)
10. positive n=1, n=2, n=16 — all receipts onboard at vouts 1..n.
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
