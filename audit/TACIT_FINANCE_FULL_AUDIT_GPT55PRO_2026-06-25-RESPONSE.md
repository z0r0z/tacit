# Maintainer response — GPT-5.5 Pro full-scope pre-lock audit (round 3, 2026-06-25)

Round-3 full-scope audit (core + cross-chain + the new wrap/send ops). Three findings, all on the
new op family; each independently re-verified against source before patching.

| ID | Severity | Verdict | Status |
|----|----------|---------|--------|
| 1 | Critical | `OP_SEND_AND_UNWRAP` `payout+fee` overflow | **MITIGATED already; hardened anyway** |
| 2 | Critical | `OP_WRAP_CDP_MINT` reuses plain-wrap context (replay) | **Fixed (guest)** |
| 3 | High | transfer-family output `owner` not bound (delegated-proving lock) | **Fixed (guest)** |

All three are **guest changes** → they rotate the settle vkey and require the coordinated re-prove,
and the JS prover mirrors + op fixtures must be regenerated to match (see "Re-prove / mirror" below).

## 1 — `OP_SEND_AND_UNWRAP` overflow — mitigated, hardened

Verified the finding's source reading is accurate (`main.rs` had `assert!(payout + fee <= value)` with a
plain add, and the kernel was called with `payout + fee`). But it is **not exploitable as shipped**:
(a) the proving profile sets `overflow-checks = true` (`Cargo.toml [profile.release]`), so the add
*panics* (no satisfiable proof) rather than wrapping; and (b) the conservation kernel + the value-binding
opening sigma constrain the true amounts as group elements, and the emitted `Withdrawal`/`FeePayment`
reuse those exact scalars — a wrapped scalar that passed the bound would fail the kernel. Patched
regardless so correctness never silently depends on the build profile for an immutable vkey:
`let public_exit = payout.checked_add(fee).expect(...)`, used for both the bound and the kernel call.

## 2 — `OP_WRAP_CDP_MINT` collateral context replay — FIXED

Confirmed real and fund-critical (cUSD CDP is live, not dormant). The collateral opening sigma reused the
**identical** `tacit-wrap-intent-v1` context as a plain `OP_WRAP` (same tag + same bound fields, byte-for-byte
preimage), so a depositor's plain-wrap authorization handed to a relay/proving box could be replayed to lock
their deposit into an attacker-chosen CDP (attacker picks controller/debt_value/debt-note and self-signs the
debt leg). Fixed: the collateral sigma now uses an op-specific tag `tacit-wrap-cdp-mint-collateral-v1` and binds
`(controller, position nonce, debt_value)` in addition to the deposit — mirroring `OP_CDP_MINT`'s collateral
context. A plain-wrap sigma no longer satisfies it (different tag + extra bound fields), and a wrap-cdp-mint
sigma can't be replayed to different CDP parameters.

## 3 — Transfer-family output `owner` not bound — FIXED

Confirmed real under Tacit's **delegated-proving** model (the relay/GPU box receives the raw op witness —
including each output `owner` — and produces the SP1 proof). The range proof + conservation kernel bound only
the output commitment points `(Cx,Cy)`; the tree leaf is `leaf(asset,Cx,Cy,owner)`, so a malicious box could
flip an output `owner`, keep a valid range+kernel proof, and emit a leaf the intended recipient can't
reconstruct → permanent fund lock (the wrap deposit / input is consumed once). The other 5 kernel callers are
safe (crossout forces ZERO_OWNER; bridge-mint dest is burn-pinned; bridge-stealth-mint / adaptor-refund /
stealth-refund bind owner via an `intent_context` opening sigma). Fixed by binding the ordered output **leaf
hashes** into the kernel challenge: new `verify_kernel_with_fee_bound(in, out, fee, out_leaves, r, z)` (hashes
`out_leaves` before `R`); `verify_kernel_with_fee` is now a wrapper passing `&[]` (byte-identical transcript,
so the owner-elsewhere-bound ops are untouched). `OP_TRANSFER`, `OP_WRAP_TRANSFER`, and the `OP_SEND_AND_UNWRAP`
change outputs pass their leaves. A mutated owner now changes the transcript and invalidates the proof. This is
the analogue of the bundle-1 `OP_UNWRAP` recipient-binding fix, extended to the transfer family.

## Safe / rechecked areas
The audit's positive checks (PublicValues ABI parity, one-time deposit/nullifier, router fee-free self-settle,
`OP_LP_BOND` target binding, and the prior Bitcoin witness/merkle fixes) match our own review and are confirmed
intact.

## Re-prove / prover-mirror follow-on (on the critical path)
C-2 and H-3 change what the honest prover must sign/hash, so before (or with) the coordinated re-prove:
- **JS mirror:** `kernelChallenge` (dapp/confidential-transfer.js + the wrap-transfer / send-unwrap builders)
  must hash the ordered output leaves for the three transfer-family ops (and only those); the wrap-cdp-mint
  collateral sigma builder (dapp/confidential-router.js / gen-confidential-wrapcdpmint-fixture.mjs) must sign
  the new `tacit-wrap-cdp-mint-collateral-v1` context.
- **Fixtures:** regenerate `transfer_op.json`, `wraptransfer_op.json`, `sendunwrap_op.json`,
  `wrapcdpmint_op.json` (+ their `*_groth16.json`) against the patched guest; the readiness-gate
  reflection-conservation / fold DIGEST_MATCH tests gate guest↔JS parity.
- **Re-prove:** rebuild the settle ELF → new `program_vkey`, redeploy with the new immutable pin.

## Verification
- `cargo check` — both guest binaries compile.
- `cargo test -p cxfer-core --lib` — 149/149 (the kernel refactor preserves the unbound transcript exactly).
