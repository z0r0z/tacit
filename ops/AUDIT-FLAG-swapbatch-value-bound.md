# RESOLVED (2026-09-16 final audit) — see the resolution at the end of this file.

# swap-batch receipt value bound — needs cryptographic review before launch

`fold_swap_batch` (`contracts/sp1/confidential/src/swap_batch.rs`) onboards each receipt's secp256k1
Pedersen commitment (`c_out_secp`) as a live confidential note with no independent range proof — the
only binding on its value is `babyjubjub::verify_xcurve` (`c_out_secp` ↔ `c_out_bjj`), whose own header
comment (`cxfer-core/src/sigma.rs:11-18`) states plainly:

> modular equality ⇒ integer equality ONLY when the amount is independently range-bounded well below
> both orders. It is the CALLER's invariant that every C_secp / C_BJJ accepted through this proof is
> also range-checked.

The BJJ side's range is presumably enforced by the Groth16 circuit (`amm_swap_batch.circom`) as part of
proving the clearing computation. The secp side has no analogous check in this guest: `grep -n
"bp_proof\|verify_range" contracts/sp1/confidential/src/swap_batch.rs` returns nothing, and the wire
format (`env.receipts[i]`) carries no range-proof field for `c_out_secp` at all — so adding one is a
wire-format change (guest + circom + the JS batch builder), not a quick guest-side patch.

This was accepted as low-risk in an earlier audit round specifically because swap-batch was dormant
(never armed). It is now live (`main.rs:1766-1767`, `reflect.rs:1761`), so that premise no longer holds.

**Why I did not attempt a fix myself:** whether this is actually exploitable depends on subtle
properties of the cross-curve sigma construction (whether a value that is small mod `n_BJJ`, as the
circuit enforces, can also be made to look like a completely different, "wrapped" value once treated as
a real integer on the secp side) that need a cryptographer's judgment, not a guess made under time
pressure. Getting a "fix" wrong here — either adding a redundant check that doesn't actually close
anything, or missing the real attack — is worse than flagging it precisely and deferring the fix design
to the external audit.

**Ask of the auditor:** confirm whether `verify_xcurve`'s mod-n equality, combined with the BJJ circuit's
in-circuit range constraint, is sufficient to bound `c_out_secp`'s real value below both curve orders, or
whether an additional range proof on the secp side is required before this can safely stay armed for
launch. If required, scope the wire-format addition (guest field, circom constraint, JS builder) as part
of the same reprove this redeploy already needs.


---

## Resolution (2026-09-16, final pre-lock audit)

The concern was valid in principle and is closed on both lanes by code that predates this audit in the
working tree and was independently verified during it: every swap-batch receipt now carries its own m=1
Bulletproofs+ range proof over `C_out_secp` (wire field `range_proof_len ‖ range_proof` per receipt), verified
in `swap_batch.rs` (reflection) and `swap_blind.rs` (settle) against the exact commitment that is onboarded,
before any state mutation, with no skip path (an empty proof is length-rejected). With both the BJJ side
(in-circuit `Num2Bits(64)`) and the secp side (BP+) independently bounded below 2^64, the cross-curve sigma's
modular equality is an integer equality, and the aggregate identity's terms (≤ 16 receipts + inputs + tips,
all < 2^64) sum far below either group order. A quantified check of the residue-gap attack (`u·n_BJJ mod
n_secp` deviations, continued-fraction convergents of `n_secp/n_BJJ`) found no shortcut below the 2^-123
per-grind bound. The flag can be removed once the reflection ELF is re-pinned.
