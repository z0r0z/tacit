# Bitcoin AMM/LP stale-state refund (C-01 redesign)

Closes C-01: Bitcoin-native swaps/LP spend a user's note UTXO but mutate *virtual* pool-registry state, so a
concurrent op (or attacker ordering) can advance the pool between signing and reflection. The victim's tx still
confirms (no shared-UTXO conflict), reflection nullifies the input BEFORE the state-dependent fold, the fold
fails the exact-pre-reserve check, and today it SKIPS — destroying the input with no receipt/change/refund.

**Fix (two tiers, for standard-AMM UX + a safe floor):**
1. **Execute at the current price (VAR/ROUTE/LP — public amounts).** The trader signs `delta_in` + `min_out` +
   a receipt blinding + destinations — NOT an exact `delta_out` against a pinned reserve snapshot. The fold
   computes the clearing `delta_out'` against CURRENT reserves (the same constant-product formula), checks
   `delta_out' >= min_out` (the trader's slippage guard), FORMS the receipt `C_receipt' = delta_out'·H +
   r_receipt·G` itself, and onboards it. This is exactly standard AMM behaviour: a concurrent swap moves the
   price, the trade still executes, slippage is bounded by `min_out`. Reserves advance by the real deltas.
2. **Refund floor (slippage exceeded, or the Groth16-pinned BATCH).** If `delta_out' < min_out`, or for
   `T_SWAP_BATCH` whose Groth16 proof is bound to the reserves it was generated against and cannot be recleared
   in-guest, onboard a user-authorized REFUND note of the exact input value instead of skipping. The input is
   still nullified (no cross-lane double-spend), but its value returns to a destination the trader signed — so
   a stale/over-slipped swap costs a Bitcoin fee, not principal.

This restores functional parity with the EVM AMM (which gets the same behaviour for free via atomic settlement)
as closely as a deferred-settlement lane can: swaps clear at the confirmed-reflection price, bounded by
slippage, and never destroy principal.

### What the trader signs now (VAR/ROUTE)
Drop the exact `delta_out` and the pinned `r_a_pre`/`r_b_pre` from the *authorization* (they may still ride the
wire for the worker's convenience, but the fold ignores them for clearing). The signed intent binds: pool,
direction, `delta_in`, `min_out`, `r_receipt` (public receipt blinding), `tip`, `expiry`, input outpoint,
`receipt_spk`, and `refund_spk`. The guest recomputes everything state-dependent.

### Receipt/range-proof mechanics (VAR)
- `C_receipt' = delta_out'·H + r_receipt·G` is formed by the guest; `delta_out'` is a guest-computed u64
  (bounded by `r_out_pre < 2^64`), so it needs no range proof. Only the trader-supplied CHANGE note still needs
  a range proof (m=1 over `[C_change]`), since the input-side kernel conserves only mod the group order.
- The kernel still binds `delta_in_total = delta_in + tip` on the input side (unchanged).

### BATCH (refund-only)
`fold_swap_batch` re-derives the circuit's public signals from the CURRENT reserves and verifies the Groth16
proof. A stale batch's proof was generated against the old reserves, so it fails against the current ones and
cannot be recleared in-guest (only the prover can produce a proof for new reserves). So BATCH keeps its
proof check; on failure it onboards each intent's refund (to that intent's signed `refund_spk`) instead of
skipping. No circuit change.

## No circuit change
This is **guest (Rust) + emitter (worker/dapp JS) only**. `amm_swap_batch.circom` / `bjj_pedersen.circom` and
the locked ceremony key are UNCHANGED. The circuit still proves clearing against whatever reserves it was given;
the guest re-derives the public signals from CURRENT reserves and, if the Groth16 proof (or the exact-reserve /
per-hop / share checks for var/route/LP) does not hold, onboards the refund rather than skipping. No new
ceremony, no new Groth16 vkey.

## The refund note
For each real input the op consumes (commitment `C_in = (Cx,Cy)` of asset `A`, nullified by the general scan):
the refund note is `btc_note_leaf(A, Cx, Cy, refund_auth_key)` onboarded at a dedicated refund output. It
commits the input's EXACT value (same `C_in`), so value is conserved; it is a FRESH note (new leaf/outpoint,
distinct nullifier), so the retired input can't be double-spent. The trader controls it via `refund_auth_key`.

## Authorization (no coordinator redirect)
The refund destination MUST be bound in the trader's signed intent — exactly as the receipt destination already
is (the H-01 work). Extend each op's signed intent message to append the refund output's P2TR script (verbatim,
read from the confirmed tx), so a coordinator cannot point the refund at its own key:
- `T_SWAP_VAR` (`swap_var_intent_msg`): append `refund_spk`.
- `T_SWAP_ROUTE` (`swap_route_intent_msg`): append `refund_spk`.
- `T_SWAP_BATCH` (`swap_batch_intent_msg`, per intent): append the intent's `refund_spk`.
- `T_LP_ADD` / `T_LP_REMOVE`: bind each input's `refund_spk` in the per-op signed message.
All are dormant, so the message content changes in place (no version bump), KAT-pinned to the worker/dapp.

## Fold behavior (per op)
Replace the `is_ok() { … } // else skip` / `let _ =` skip with an explicit branch:
1. Run the existing validation (exact reserves / per-hop floor / Groth16 clearing / share opening).
2. **On success:** onboard the receipt(s)/change/shares as today.
3. **On any state-dependent failure:** onboard the refund note(s) at the signed `refund_spk` output(s) — for
   BATCH, one refund per intent. Fail closed (skip) ONLY for a bad prover witness / non-canonical envelope /
   invalid signature (never for a valid confirmed op that merely lost the race), never abort.
The refund and the receipt are DIFFERENT tx outputs; on success the refund output is an unused dust P2TR the
trader controls, on staleness it homes the refund note. Both are read verbatim from the confirmed tx and both
are bound in the signed intent, so exactly one is onboarded and neither is coordinator-mutable.

## Emitter (worker/dapp)
Every stateful Bitcoin AMM/LP tx builder MUST add the refund output(s) (P2TR to the trader's key) and sign the
extended intent message (receipt dest + refund dest). The worker verifier reconstructs both from the confirmed
tx. Refund outputs are P2TR (so the refund note has a real auth key — reuse the zero-auth fail-closed guard).

## Tests
- KAT: each extended intent message byte-matches the real worker/dapp builder (append refund_spk).
- Guest: a stale swap (env pre-reserves != tracked) onboards the refund note (exact input value, at the signed
  refund dest), input stays nullified, reserves untouched; a fresh swap onboards the receipt (no refund).
- Redirected refund (refund dest != signed) → auth fails.
- BATCH: a stale batch refunds ALL intents to their own signed refund dests.
- Box MODE=execute: two concurrent swaps on one pool — first folds its receipt, second folds its refund; both
  users whole, reflection advances (no skip-loss, no halt).

## Why not the shared pool-state UTXO
A shared pool-state UTXO (every op consumes+recreates it, so concurrent ops conflict at Bitcoin consensus) is
the "clean" serialization, but it rearchitects Bitcoin pools from virtual registry state into UTXOs and touches
every pool a route/batch spans. The refund fallback preserves the current model, removes the principal-loss
harm, needs no circuit/ceremony change, and is guest+emitter only — the right V1 fix. (A future generation may
still adopt the UTXO model for true first-confirm ordering.)
