# DESIGN — adaptor-swap settle-guest op-set (OP_ADAPTOR_{LOCK,CLAIM,REFUND})

> **STATUS: near-term priority — rides the v1 settle re-prove.** The settle guest's `PROGRAM_VKEY` is
> already rotating this cycle (the asset-preservation cxfer-core change rebuilds both ELFs), so the
> adaptor ops + their one contract change ride the same re-prove + deploy — no separate settle re-prove.
> **Gate:** this is a fund-critical conditional-spend op-set; its adversarial KATs + review MUST hit the
> v1 bar **before the vkey locks**. This is the guest hand-off; the app layer is already built + tested
> (`dapp/adaptor-signature.js` BIP-340-faithful, `dapp/adaptor-swap.js` orchestration,
> `dapp/cross-chain-orderbook.js`). Companion to [`PLAN-confidential-adaptor-swap.md`](./PLAN-confidential-adaptor-swap.md).
>
> **What's testable where:** because the ops mirror `OP_OTC` (§"It mirrors OP_OTC"), the only NEW
> cxfer-core surface is the **lock-set leaf** — `adaptor_lock_leaf` — which is **implemented + KAT'd
> natively (cxfer-core, 67 tests green)**: it binds every field (no redirect / re-time / T-swap) and is
> domain-separated from the note-tree `leaf` (a locked note is never normal-spendable). The op DISPATCH,
> the `settle` refund-time gate, and the public-values are `main.rs` / the contract (box-only). The
> adaptor *signature* math is off-chain (the dapp, already built + tested) — the guest just verifies a
> normal kernel sig (an adaptor-completed kernel **is** a valid kernel) and commits its `s` so the
> Bitcoin counterparty extracts `t`.

## The model (EVM confidential leg)

The adaptor makes the *claim* scriptless, but atomicity needs a **deadline-gated lock/refund** — a
confidential note can only be conditionally locked + refunded through the settle guest:

```
LOCK   maker note N ─▶ spend N (ν_N) + create locked note L in the LOCK SET,
                       committing (Tx,Ty adaptor point ‖ deadline ‖ recipient ‖ locker). Value v hidden.
CLAIM  L ─▶ spend L + create the RECIPIENT's note, IFF block.timestamp < deadline, with the
            adaptor-completed kernel; the guest commits the completed kernel `s` → t = σ·(s−s̃) public.
REFUND L ─▶ spend L + create the LOCKER's note, IFF block.timestamp ≥ deadline.
```

A locked note lives in a **separate lock-set accumulator**, NOT the note tree — so a normal
`OP_TRANSFER` can't spend it; only `OP_ADAPTOR_CLAIM`/`REFUND` can, deadline-gated. Value conserves at
every hop (the kernel), so no inflation. Exactly one of claim/refund spends each lock (its nullifier).

## The op-set

New op codes (settle guest; current ops run 0–11): `OP_ADAPTOR_LOCK = 12`, `OP_ADAPTOR_CLAIM = 13`,
`OP_ADAPTOR_REFUND = 14`.

### OP_ADAPTOR_LOCK (12)
Witness: the spent note `N` (membership in `spendRoot` + `ν_N` + the opening), the lock fields
`(Tx, Ty, deadline:u64, recipient:[u8;32], locker:[u8;32])`, the locked-note commitment `L_C` + its
append path. Validate (cxfer-core `verify_adaptor_lock` — testable):
- membership of `N` + `ν_N` (the normal spend checks, reused);
- **value carry:** `L` commits to the SAME value as `N` (an opening sigma binding `L_C`'s value to
  `N`'s — the guest never learns it; reuses `verify_opening_sigma` over the kernel/intent context);
- `deadline != 0` and `(Tx,Ty)` is a curve point.
Effect: `ν_N` → spent set; append `adaptor_lock_leaf(L_C, Tx, Ty, deadline, recipient, locker)` to the
**lock set**; insert `(L_C → lock nullifier)` so it's spendable-once.

### OP_ADAPTOR_CLAIM (13)
Witness: the locked note `L` (membership in the lock-set root, `ν_L`, the lock fields), the output note
to `recipient`, the **adaptor-completed kernel** (a normal BIP-340 kernel sig, valid by construction),
`block.timestamp` (header witness, §contract). Validate (`verify_adaptor_claim`):
- `L`'s lock-set membership + `ν_L` (spend-once);
- `block.timestamp < deadline` (the claim window);
- the output note's owner == `recipient` (bound in the lock) — no redirection;
- value conservation `L_in − out = 0` (the kernel, reused `verify_kernel`).
Effect: `ν_L` → lock-spent set; append the output note to the **note tree**; **commit the completed
kernel `s` into `pv.adaptorClaimS[]`** so the Bitcoin counterparty (holding `s̃`) extracts `t = σ·(s−s̃)`.

### OP_ADAPTOR_REFUND (14)
Same as CLAIM but: `block.timestamp ≥ deadline`, the output owner == `locker`, no `s` exposure. So a
stalled swap returns the maker's value after the deadline.

## It mirrors OP_OTC — most of this already exists

The op reads (membership + `ν` + opening sigma + `intent_context` + per-asset conservation) are
**exactly the `OP_OTC` pattern** (main.rs:700–818): values are prover-visible but bound by an opening
sigma (never in PublicValues), owners + amounts + deadline ride the `intent_context`, and `verify_kernel`
conserves. So the adaptor ops **reuse the audited primitives wholesale** — the only NEW cxfer-core
surface is the lock-set leaf (below).

**The deadline is half-built already.** `OP_OTC` reads an `op_deadline` (main.rs:776) bound into the
sigmas and surfaced as `min_deadline` (the batch must settle *before* it). So:
- **CLAIM reuses `op_deadline`** — a claim is valid only if the batch settles **before** the deadline.
  No new mechanism; it's the existing "settle-before" gate.
- **REFUND needs the mirror** — valid only **after** the deadline. This is the **one new contract
  gate**: `settle` reads `block.timestamp`, the guest emits the refund's `validAfter`, and the contract
  asserts `block.timestamp >= validAfter` for each refund op (the "≥" the existing "≤" doesn't cover).
  A small, isolated `settle` + PublicValues addition; deploy-gated (rides this redeploy).

## Public-values additions
- `uint64 settleTimestamp` — the verified chain time the deadline gates used.
- `bytes32[] adaptorClaimS` — the completed kernel `s` per claim (the `t`-reveal channel; alternatively an
  event). The Bitcoin counterparty reads it off-chain.
- The lock-set root + the lock-spent root join the committed state roots (the guest advances them; the
  contract carries them like the note/nullifier roots). **Design choice for the guest owner:** a
  dedicated lock-set accumulator (cleanest, two new roots) vs. tagging locked leaves inside the note
  tree (fewer roots, but every transfer must reject a locked leaf). Recommend the dedicated lock set.

## Soundness invariants (the v1-bar checks)
1. **No inflation / no redirection.** Value conserves lock→claim/refund (the kernel); the output owner
   is bound to the lock's `recipient` (claim) / `locker` (refund) — the relayer can't redirect.
2. **A locked note is spend-restricted.** `L` lives in the lock set, not the note tree, so no
   `OP_TRANSFER` touches it; only claim/refund, each spending `ν_L` once.
3. **Claim XOR refund, deadline-exclusive.** The same `ν_L` can be spent once; `claim` requires
   `ts < deadline`, `refund` requires `ts ≥ deadline` — never both, and the time is the verified
   `block.timestamp`.
4. **`t` reveal is exact + bound.** The claim's kernel is the adaptor-completed sig (valid under the
   even-y `R+T`); committing `s` lets the counterparty extract `t` (the swap linchpin) and nothing else.
5. **Cross-domain.** The lock/claim/refund contexts bind `chainBinding` + the lock fields, so a pre-sig
   can't be replayed across swaps or chains.

## The Bitcoin leg (lighter — likely no reflection re-prove)
The Bitcoin-side *claim* is a **normal `T_CXFER`** (an adaptor-completed kernel is a valid kernel — the
validator + the reflection already accept it, fold it as any output). The *refund* is a Taproot `CLTV`
spend the **validator** recognizes; the reflection folds it as a normal spend. So the Bitcoin leg is
**validator + off-chain protocol**, with **no reflection guest change** anticipated — confirm during build.

## cxfer-core testable core
- **`adaptor_lock_leaf(Cx, Cy, Tx, Ty, deadline, recipient, locker) -> [u8;32]` — DONE, KAT green
  (cxfer-core, 67 tests).** The lock-set leaf; `ADAPTOR_LOCK_DOMAIN`-tagged so it's disjoint from the
  note tree. KAT `adaptor_lock_leaf_is_deterministic_and_binds_every_field` proves determinism +
  every-field binding + domain separation from `leaf`. This is the ONLY new cxfer-core primitive.
- **The claim/refund VALIDATION is main.rs assembly of EXISTING, audited cxfer-core primitives** — not
  new cxfer-core code: `keccak_merkle_verify` (lock-set membership), `nullifier` (`ν_L` spend-once),
  `verify_opening_sigma` (value-binding, no reveal — the OTC pattern), `verify_kernel` (conservation),
  `intent_context` (owner + amount + deadline binding), and the deadline comparison. So the soundness
  rests on already-tested checks composed the way `OP_OTC` composes them, plus the lock-leaf above.
- The lock-set + lock-spent transitions reuse the existing note-tree append / nullifier-insert
  machinery (a second accumulator instance, not new logic).
- **Adversarial coverage** then lives in the box real-proof fixtures (like swap/lp/otc/bid): a
  claim-after-deadline, a refund-before-deadline, an output to the wrong owner, a double-spend of `ν_L`,
  and a normal-transfer attempt on a locked leaf must each reject. The lock-leaf field-binding KAT
  already discharges the redirect/re-time/T-swap class natively.

## Remaining (guest owner) + why it rides v1
- **Guest:** the `main.rs` dispatch for ops 12–14 (read witnesses → call the cxfer-core checks → effects),
  + the lock-set/lock-spent state, + the `settleTimestamp`/`adaptorClaimS` public values.
- **Contract:** the `block.timestamp` pass-through + the two new state roots in `settle`.
- **Box:** `cargo prove` → the rotated `PROGRAM_VKEY` (rides this re-prove) + the swap/lp/otc/bid/adaptor
  real-proof fixtures.
Because the settle guest + the contract are already changing this cycle (asset-preservation + cBTC),
the adaptor ops add **no extra re-prove or deploy** — only the review burden, which the §"soundness
invariants" + the cxfer-core adversarial KATs must discharge to the v1 bar before the vkey locks.
