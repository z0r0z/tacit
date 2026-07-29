# On-chain generational retirement (C-01)

Design for sign-off. Addresses the confirmed cross-generation double-spend: after a non-empty authenticated
resume, the predecessor pool is NOT retired on-chain, so a Bitcoin-homed note live in the shared reflected
state can be spent once through the (still-live, permissionlessly re-fundable) predecessor and once through the
successor before reverse reflection reconciles — draining honest successor escrow.

## The hard constraint that shapes everything

A ConfidentialPool is **immutable**. The predecessor being superseded is **already deployed**. It therefore has
**no retirement hook and cannot be given one** — we cannot make an *existing* contract consult a lineage
registry, check a `retired` flag, or disable `wrap`/`settle` it was deployed without. Any "the predecessor
itself enforces retirement" mechanism only works for a predecessor that was *built* with the hook — i.e. from
**this generation forward**, never for the pool we are about to supersede.

This splits the problem cleanly:

- **(A) This launch** — protecting against C-01 for the pool we resume *now* is a **deploy-time decision**, not
  a code mechanism, because the current live pool has no hook.
- **(B) Every future migration** — we bake the retirement hook into **this** immutable generation so its
  successor can atomically freeze it. This is the code change.

## (A) This launch — the deploy-time decision

C-01 is exploitable only when a successor **resumes a predecessor that still holds spendable Bitcoin-homed
value** while that predecessor stays live. So the launch is safe iff one of:

1. **Genesis-fresh** (`predecessor == 0`, `reflectionResumeDigest` = a genuine empty/genesis anchor, no inherited
   note set). No inherited notes ⇒ nothing to double-spend ⇒ C-01 fully dormant. **Cleanest; recommended if the
   current live pool's state does not need to carry over.**
2. **Resume a provably value-empty predecessor.** If the superseded pool's note set / escrow / cBTC backing are
   provably drained to zero at supersession AND it is quiesced (no worker, no further attests), a resume carries
   no spendable note. Residual risk: the predecessor stays permissionlessly re-fundable via `wrap`, so this
   rests on the operational guarantee that no one re-funds it — the exact posture the auditors flag. Acceptable
   ONLY if the carried-over state is genuinely empty of value; NOT acceptable for a pool with live user notes.

**What is NOT safe:** resuming the current live pool `0x…f88564` *with* live user Bitcoin-homed notes/escrow.
That pool has no retirement hook (immutable), so C-01 cannot be closed on-chain for it. If its state must carry
forward with value, the only sound route is to drain/exit users out of it first (so the resumed set is empty),
then resume empty — i.e. collapse to case 1/2.

> **Decision needed from owner:** does this launch resume the live non-empty pool, or start genesis-fresh /
> resume-empty? The `DeployV1SuiteCreateX` script now takes `PREDECESSOR` (defaults to `address(0)`), so this is
> an explicit, auditable deploy env choice. My recommendation: **genesis-fresh** unless there is a concrete need
> to inherit non-trivial state, in which case drain-then-resume-empty.

## (B) The forward mechanism — self-retirement hook in this generation

So that *future* supersessions are closed on-chain (and this generation can itself be safely retired later),
add to `ConfidentialPool`:

### State
- `bool public retired;` — once true, this generation is frozen.
- Reuse the existing generational-resume handshake in reverse: the constructor already knows its `PREDECESSOR`;
  add the symmetric idea that a pool can be *told by its successor* to retire.

### Retirement entrypoint
```
function retire(bytes calldata pv, bytes calldata proof) external
```
- Verifies a reflection/attest proof from the **successor** that authenticates the successor has taken over this
  pool's exact attested state — i.e. the successor's `rebasedFromDigest` handshake computed against THIS pool's
  live `attestedReflectionDigest()` / counters (the same binding the successor's first attest already proves,
  ConfidentialPool.sol:1749-1771). Concretely: this pool checks that a deployed successor (recorded at
  construction as an immutable `SUCCESSOR` set by… — see open question below) has settled its generational
  rebase against this pool. On success set `retired = true`.
- One-shot, permissionless to CALL (anyone can finalize a proven handoff), but only provable by a genuine
  successor takeover — so it cannot be used to grief a live generation.

### Freeze gate
Add `require(!retired)` (a `notRetired` modifier) to **every value-bearing entrypoint**: `wrap`, `settle`,
`attestBitcoinStateProven`, the public AMM/router entrypoints, farm treasury flows, unwrap-that-creates-escrow,
CDP/cBTC flows. Read-only exits (letting users withdraw already-owned notes) should remain — retirement must not
strand funds; it must stop NEW value-bearing state transitions and cross-lane spends. This needs care: the
freeze has to block the double-spend primitive (fresh fast-lane consumes / wraps) while still letting a user
exit a note they hold. Enumerate each entrypoint and classify freeze vs allow.

### Open design question (needs a decision before build)
How does a pool learn its successor's address to authenticate `retire()`?
- **Option B1 — forward pointer set post-deploy:** the predecessor exposes a one-shot `setSuccessor(addr)` callable
  only by a trusted deployer/DAO before handoff. Simple, but reintroduces a privileged step.
- **Option B2 — shared immutable lineage registry:** a single registry contract (deployed once, same address every
  generation via CREATE3) records `active generation`; every pool consults it in `notRetired` and the handoff
  atomically advances it. Cleanest "one live generation" enforcement, but adds an external SLOAD to every
  value op and a new immutable dependency to audit. Only works from this generation forward (same constraint).
- **Option B3 — proof-only, no pointer:** `retire()` accepts any successor proof whose `rebasedFromDigest`
  authenticates against THIS pool's getters; no stored successor needed. Attractive (no privileged step), but
  must ensure only the *intended* successor can produce such a proof and that it can't be forged/replayed to
  freeze a pool prematurely. Requires the successor's takeover proof to uniquely bind this predecessor.

My lean: **B2 (shared lineage registry)** for the strongest, privilege-free "exactly one active generation"
guarantee, accepting the extra SLOAD and the new audited dependency — with B3's proof-binding as the handoff
trigger. But this is the biggest immutable addition on the table and I want your call on B1/B2/B3 before I build.

## Scope / sequencing
- (A) is a **deploy-config decision** — no code beyond the `PREDECESSOR` arg already added. It makes THIS launch
  sound regardless of (B).
- (B) is an immutable-core addition to `ConfidentialPool` (+ possibly a registry contract). It does NOT rotate a
  guest vkey if done purely contract-side (the `retire()` proof reuses the existing attest verification); if the
  successor-takeover binding needs a guest-surfaced field, it folds into the same held reprove as H-01.
- Re-audit the retirement seam specifically (freeze-vs-allow classification is the risk surface: a wrong
  classification either strands user exits or leaves a spend path open).

## Bottom line
This launch does not *need* (B) to be safe — it needs the (A) deploy decision (genesis-fresh or resume-empty).
(B) is what lets this immutable generation ever be safely superseded in the future. Both should land before we
commit to a launch that could later want a non-empty migration, since the hook cannot be added after deploy.
