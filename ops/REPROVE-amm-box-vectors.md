# Box MODE=execute validation vectors — Bitcoin AMM folds (reprove gate)

The T_SWAP_VAR / T_SWAP_ROUTE / T_SWAP_BATCH reflection folds are byte-bound and unit-tested for message parity
(cxfer-core KATs + tests/amm-intent-msg-pin against the real worker/dapp), but they have NEVER run end-to-end:
`fold_swap_batch` links `bn` (Groth16 + BabyJubJub, box-only), and the var/route folds need real keccak-tree
append paths. These vectors MUST pass on the box before the AMM ops are relied on. On every negative, assert the
block's reflection STILL ADVANCES (a malformed swap self-strands only its initiator; no abort/halt).

## VAR
1. positive, whole-input (sentinel change, empty bound change script): receipt onboards, reserves advance, one note appended.
2. positive, partial input: receipt @vout1 + change @vout2 onboard atomically, note_count += 2, each leaf carries its own output's x-only key.
3. negative: change paid to a script other than the signed one → skip, nothing folded, reserves untouched.
4. negative: non-sentinel change with only 2 outputs (no vout 2) → skip.
5. negative: change output non-P2TR (P2WPKH) → skip.
6. negative: expiry_height == 0, and expiry_height == block_height − 1 → skip.

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

## Residual after this pass
Nothing unbound is named in the three ops (per-op binding matrix all green: destination/auth/terms bound in the
intent, enforced in the guest, byte-matched worker+dapp, fail-closed on malformed). The remaining exposure is
entirely that the folds have never executed — these vectors close it.
