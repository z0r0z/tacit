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


---

## As-built notes (implementation deltas from the design above)

Five commits, `1bb472eb`..`8f76039c`. Where the build diverged from this spec, and why:

**The pool's LP fee tier had to become registry state first (`1bb472eb`).** This spec says the fold computes the
clearing with `get_amount_out(delta_in, r_in, r_out, fee_bps)`, but no fold had a trustworthy `fee_bps`:
`PoolReserveState` tracked only the protocol-fee skim. Trusting an envelope-declared tier is LP theft — an intent
signed with `fee_bps = 0` takes the no-fee price, which passes the no-fee constant-product floor *exactly*.
`fold_swap_batch` had dodged this by deriving `pool_id` from the declared tier, but that only works for no-skim
pools (`amm_derive_pool_id_v1` hardcodes `protocol_fee_bps = 0` and the registry does not store the fee
recipient), which would have silently excluded creator-skim pools from the whole Bitcoin swap lane. So `fee_bps`
is now stored, seeded at POOL_INIT from the `T_LP_ADD` envelope's `fee_bps` — which the `pool_id` already commits,
so the stored tier is the one the pool's identity was derived from — and bounded by `AMM_MAX_POOL_FEE_BPS`.
**This changes the committed pool leaf and the resume handoff format**, so it is a consensus change beyond the
folds themselves; the guest reader, the shared `reflect-stdin` writer, and the JS mirror all moved together, and
a pre-change handoff fails the digest chain rather than being silently accepted.

**`r_receipt` had to enter the signed intent, and the declared receipt commitment had to leave it.** Not stated
above but forced: once the guest forms `C_receipt'`, an unsigned blinding is a coordinator's choice.

**The VAR/ROUTE refund needs no append path of its own.** It lands at the same tree index the receipt would have,
and an append path is the sibling path for that index — dependent only on the leaves below it, never on the leaf
being appended. So it reuses the receipt's path and the prover's witness stream is unchanged, which is what keeps
the state-dependent branch from desyncing it. BATCH is the exception (n receipts OR n refunds, starting at a
different index), so it reads n refund paths unconditionally.

**Refund destinations are validated up front, not lazily.** Which branch runs is a function of pool state, so a
swap that reached the refund path with a missing or non-P2TR refund output would have nothing onboardable — the
exact loss the refund exists to prevent. The VAR refund output is therefore unconditional at a FIXED vout 3 (a
whole-input swap pads vout 2 with the trader's own change script) so the index never moves with the swap shape.

**The refund pays no settler tip, and does not onboard the change.** Forced by conservation: the refund returns
the whole input, `delta_in + tip` included, so onboarding the change too would double-count it. A settler is out
a Bitcoin fee on a swap that did not execute. The JS reference validator already modelled exactly this
("pass-through refund includes the tip"), independently of the guest.

**ROUTE's per-hop terms left the authorization entirely.** Each hop binds only `pool_id ‖ direction` — the route's
shape. Its fee tier, pre-reserves and output magnitudes are recomputed, so signing a snapshot would just recreate
the staleness; and signing a fee tier would reopen the LP-theft path. That a moved pool no longer invalidates the
trader's signature is itself pinned in the message KATs. A hop clearing to zero is tracked with a flag rather
than falling through, because a mid-route break leaves the chain partway along and the output-asset check would
otherwise reject and strand.

**LP_ADD and LP_REMOVE needed NO refund tier, and no new authorization message.** This spec assumed both would
bind `refund_spk` "in the per-op signed message" — but neither op has a signed intent message at all (no trader
pubkey, no `intent_sig`; only kernels). It turned out not to be needed: neither op has a signed slippage floor, so
there is nothing to miss, and both simply execute at current state. LP_REMOVE recomputes the proportional payout
and debits by what it actually paid (the kernel still covers the LP's declared pair, so their authorization is
unchanged — only the amount is state-derived). LP_ADD already sized shares from current reserves; its C-01 loss
was subtler and is worth recording: the share NOTE was onboarded only if the LP's declared `share_csecp` opened to
the reflection-computed `lp_shares`, so a concurrent swap — or the protocol-fee crystallization inside
`fold_lp_add`, which moves `total_shares` on its own — nullified the LP's deposit and issued no shares. Both now
FORM the commitment from the computed amount under the blindings the envelope already publishes on-chain
(`share_r`, `r_recv_a`, `r_recv_b`). Those being public is load-bearing: a witness-supplied blinding would have
made the note tree prover-dependent and diverged the digest chain.

**BATCH required reordering the fold, which is the highest-risk change in the set.** The one-to-one spend matching
and per-intent authorization ran AFTER the clearing checks, so a stale batch failed before any `c_in_secp` was
proven to be a real, distinct, authorized spend — and minting refunds against unverified commitments would itself
be an inflation path. Those checks now run first. `fold_swap_batch` links `bn` and is box-only: it type-checks
locally but nothing in it has ever executed here, so the message builder and refund-note derivation are
unit-tested in `cxfer-core` and the fold itself is validated only by the box vectors.

**Destination binding for LP ops remains open** (H-01 scope, not C-01): the LP withdrawal outputs are not
script-bound in any signed message, because there is no such message. This work does not worsen it — forming the
commitments in-guest makes each note's VALUE forced correct, where previously a settler could not change the
value but the destination was equally unbound.

**Expiry now refunds too (`8613e182`), same branch.** Found after the set above: `expiry_height` is a
guest-semantic deadline ONLY. Bitcoin has no tx-expiry primitive — `nLocktime` means "invalid BEFORE N", the
opposite — and these txs are built with locktime 0 (worker `index.js:9156`), so a late broadcast cannot be made
unconfirmable at consensus. A coordinator could hold a trader's pre-signed swap/route/batch and broadcast it past
the deadline: it confirms, the vin scan nullifies the input, and the expiry check skipped → principal destroyed.
Same class as the reserve race, lower severity (needs a malicious coordinator, griefing-only, no profit), same
outcome. Routing it to the refund branch honours expiry completely — the intent does not execute, so there is no
stale-price fill — while returning the input. The signed message is UNCHANGED (expiry was already bound); only the
fold's response changes, and the 19/19 pin still holds byte-for-byte, which is the check that nothing bound expiry
differently. VAR/ROUTE needed the expiry check moved below the destination guards (and below ROUTE's input-asset
check) so the refund destination is known-good before it is relied on. Zero expiry is still not read as
"unlimited" but refunds for the same reason. BATCH refunds the WHOLE batch on any expired intent: the fold has no
partial-fold mode (every other per-intent failure already fails the batch) and the aggregate identity binds all
receipts to all inputs, so a subset cannot execute; the flag is recorded in the matching loop and acted on after
it, since `intent_in_assets` is still being built mid-loop. The hard skip is kept only for what is not a confirmed
authorized op: bad/missing `intent_sig`, a refund output missing/redirected/non-P2TR, a non-canonical envelope, a
bad prover witness. The three VAR/ROUTE refund sites are now one `onboard_btc_refund` helper keyed to the asset of
the note ACTUALLY spent, not one derived from pool state and direction — refunding `c_in` under any other asset
would mint value backed by a note of a different one. An op that is both expired and over-slipped onboards exactly
one refund (the expiry branch returns first). The JS reference validator already treated an expired envelope as
pass-through, independently matching this.

### Verified locally
cxfer-core `cargo test --release` 175/175 (includes the expired→refund cases for var and route); guest `cargo check --release --bins` clean on both bins;
`amm-intent-msg-pin` 19/19 (guest == worker == dapp == reference harness on all three messages, every destination
pinned load-bearing, and ROUTE's hop state pinned NOT authorized); `swap-var.test.mjs` 53/53;
`swap-route-dapp-worker-parity` 15/15; plus swap-var / swap-route / worker-amm-parity / amm-uniswap-v2-parity /
amm-validator-robustness / confidential-swapvar-fold / confidential-swaproute-fold / poolresume-synth.

### NOT verified — the box owes these
No fold in this set has ever run end-to-end. `ops/REPROVE-amm-box-vectors.md` carries the vectors; the ones that
actually demonstrate C-01 is closed are the concurrent-op cases (16, 21, 26-28, 30) and the held-broadcast expiry
cases (33-39), each of which should be run once against the OLD ELF to confirm it reproduces the principal loss. `amm-foundation.test.mjs` has 30 failing
cases in `decodeTLpAddPayload` that PRE-DATE this work (confirmed identical against the pre-work worker) — they
are in LP_ADD's area and worth a separate look.
