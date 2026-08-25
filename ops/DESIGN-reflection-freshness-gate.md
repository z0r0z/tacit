# DESIGN — reflection attest freshness gate (Fable #3)

Status: ANALYSIS / not implemented. No code or reprove yet. Decision owed.

## The gate

`ReflectionLib.attest` (src/ReflectionLib.sol:148-150):

```solidity
if (r.consumedCount != cfg.bitcoinConsumedCount) revert ConsumedCountStale();
if ((ethPool == address(this) ? r.crossOutCount : r.foldedCrossOutCount) != cfg.crossOutCount)
    revert ConsumedCountStale();
```

`r.consumedCount` / `r.crossOutCount` are what the reflection proof folded, at its **finalized** ETH slot
(helios `finalized_header`, ~2 epochs / ~13 min behind head). `cfg.bitcoinConsumedCount` / `crossOutCount`
are read **live** at attest-tx execution.

## Fable #3 — the grief (REAL)

Because `r.consumedCount` is a finalized-slot value, `== live` can pass only if **no** fast-lane consume or
crossOut landed between the reflection's finalized slot and the attest tx. Any EVM note holder can emit a
crossOut for pennies; under any such traffic the attest reverts `ConsumedCountStale`. Fail-closed, but it
stalls reflection (spent-set advance + bridge freshness) under trivial contention. Matches the known
cold-start reflection-freeze note and "crossOutCount persist unsafe".

## Why `== live` is ALSO load-bearing (the trap that killed the naive fix)

Relaxing to `<= live` (allow lag) was implemented and **reverted**. The gate is a compromised-guest
**double-credit backstop**, not only liveness:

- reflect.rs:96-99 — the eth-consumed ν are folded **into the Bitcoin spent set**; `consumedCount` counts how
  many. The attest gates `consumedCount == bitcoinConsumedCount` so the spent set advances **only after every
  eth-consume is folded into it**.
- Mechanism: when a reflection folds a Bitcoin-lane spend of note N, `== live` guarantees it has
  *simultaneously* absorbed **every** eth-consume up to now — so a note spent on BOTH lanes is detected at the
  reflection that processes the second-lane spend. (Prior C-01, GPT round 3: an un-reflected consume leaves the
  source live on the other lane → cross-lane double-spend.)
- `<= live` lets a reflection fold a Bitcoin-lane spend of N while N's recent eth-consume is unfolded → the
  published spent set omits N → N double-spent. Reintroduces exactly C-01.

## The fundamental tension

Soundness wants "folded to **live**" at the moment a Bitcoin-lane spend is folded. The prover can only prove
"folded to **finalized**" (can't prove unfinalized state). So today's soundness rests on: attest only succeeds
during an eth-consume/crossOut **quiescent window** spanning finality, and in that window finalized == live.
The grief is an attacker denying quiescence. Tightening liveness and preserving the backstop pull opposite ways
on the same equality — that is why this is not a one-liner.

## The lever

`REFLECTION_CONFIRMATIONS = 6` Bitcoin blocks (~60 min) ≫ ETH finality (~13 min). A reflected batch's Bitcoin
tip must be buried ≥ 6 blocks (ReflectionLib:262-273; deploy default 6). So the Bitcoin-lane maturity window
already exceeds the ETH finality lag by ~4-5×.

**Hypothesis to prove/refute:** if a Bitcoin-lane spend of N is only *credited* once its reflecting batch is
matured (≥6 conf), then any racing eth-consume of N — which finalizes within ~13 min — is guaranteed finalized
(hence foldable, hence in the spent set) **before** N's Bitcoin-lane spend matures. If so, comparing
`r.consumedCount` against the **eth-consume count at the reflection's own finalized slot** (which the guest
already reads via storage proof and asserts complete — eth-reflection main.rs:292/412) is SOUND: the maturity
delay, not the attest equality, covers the finality gap. That removes the grief (finalized-slot count is
satisfiable regardless of live traffic) while keeping the backstop.

**Why this is not yet a green light:** the double-credit is detected at the reflection folding the *second-lane*
spend, and I have not yet proven that the maturity gate strictly orders "eth-consume finalized+foldable" before
"Bitcoin-lane spend credited" for ALL interleavings (esp. the reverse order: Bitcoin-lane spend first, then a
racing eth-consume; and crossOut, whose semantics differ from consume). Needs the exact Bitcoin-lane
spend-credit path in the settle guest (main.rs) traced against the maturity boundary, and an adversarial pass
that tries to construct a same-note both-lanes interleaving that clears a finalized-slot gate.

## Candidate designs

1. **Finalized-slot count + rely on maturity (preferred IF the hypothesis holds).** Contract compares
   `r.consumedCount` against a guest-proven finalized-slot count, not live. Guest already proves
   `folded == onchain_count @ finalized-slot`; expose that as the compared value / bound. Removes grief,
   keeps backstop via the confirmation delay. Guest+lib change → **reprove all 3 ELFs**.

2. **Bounded-staleness on live.** Keep live comparison but allow `live - r.consumedCount <= K` for small K.
   Rejected: still racy (K-th consume re-triggers), and picking K trades grief for a bounded double-credit
   window — weakens the backstop by exactly K. No.

3. **Decouple spent-set advance from crossOut freshness.** The crossOut half (reverse-bridge completeness) and
   the consume half (double-credit backstop) may not need the same gate. crossOut omission is a *censorship*
   liveness issue (reverse mint skipped), not a double-credit. Possibly the crossOut count can use design (1)
   while the consume count keeps a stricter rule. Worth separating in the analysis.

## Trace verdict (evidence gathered, cited)

- **No per-spend maturity gate.** btcHomed spend = leaf membership vs `spend_root` + `check_btc_nonmembership`
  vs `bitcoin_spent_root` (main.rs:677-683, 534-543); maturity is ONLY on the reflection anchor
  (ReflectionLib:262-273), never on the individual spent outpoint. So the "6-block maturity covers the ~13-min
  finality gap" lever does not exist at the spend.
- **The consume gate `== live` IS the soundness mechanism, not merely liveness.** Eth-consumes fold
  Ethereum-senior — `fold_consumed` removes the source outpoint from `live` (reflect.rs:583-585, lib.rs:4393),
  so a racing Bitcoin-lane spend is rejected only because that outpoint is already gone. `== live` forces the
  reflection to wait until a racing eth-consume FINALIZES before it can advance. The grief and the backstop are
  the same mechanism for the consume count.

**Design (1) is REFUTED for the consume count.** Interleaving that breaks a finalized-slot relaxation:
`t0` attacker Bitcoin-lane-spends N (needs 6 conf, ~60m to reflect); `t57m` attacker eth-consumes N on the fast
lane — passes (N not yet in the spent set); `t60m` the reflection folding N's Bitcoin spend, under a
finalized-slot gate (finalized ≈ t47m), does NOT see the t57m eth-consume, so N's outpoint is still `live` and
the Bitcoin spend is credited → N double-spent. Under `== live` the t60m attest is forced to revert until the
t57m consume finalizes (~t70m), by which point the consume fold has removed N and the Bitcoin spend is rejected.
No fixed per-spend burial fixes this — the racing eth-consume can land arbitrarily close to the fold.

**Design (3) is the sound win — decouple the two counts:**
- crossOut `== live` is anti-censorship only, NOT a double-credit backstop (ConfidentialPool:526-533,
  reflect.rs:100-103; double-mint guarded separately by claimId re-derivation :2172-2174, destChain==1 :2180,
  ν-spent binding :2181-2184, per-batch ν-distinctness :2185-2190). A lagging crossOut fold DEFERS a reverse
  mint, never loses it; the digest chain (priorDigest==known) forces continuation and the guest forces
  completeness to its finalized slot, so a specific claimId cannot be permanently censored (the monotone
  finalized-slot advance folds it within ~13m of finalizing).
- crossOut is the CHEAP grief Fable named ("any EVM note holder can produce a cheap crossOut"). Consume is
  expensive/self-funded (the attacker must spend their own btcHomed note).
- So: relax ONLY the crossOut gate to `r.crossOutCount > live` reverts (allow lag); keep the consume gate at
  `!= live`. Kills the cheap grief, keeps the double-credit backstop intact.

## Design (3) — REFUTED by two independent adversarial passes (unanimous UNSAFE)

The crossOut gate is NOT anti-censorship bookkeeping — it is the anti-censorship **enforcement** for a
forward-only target chain, and the skip-not-panic 0x65 fold is sound ONLY under the strict `==`
(reflect.rs:104-109, :1370-1376).

Break: relax the forward-batch branch (`foldedCrossOutCount`, ReflectionLib:149) to `<=` and a prover submits a
forward batch (`mode_b==0`) committing `foldedCrossOutCount = 0` while a real recorded crossOut C (crossOutCount
= 1, ETH source already burned at ConfidentialPool:2195-2197) is pending. Strict `==` reverts (`0 != 1`); `<=`
accepts (`0 <= 1`). The Bitcoin guest then evaluates C's confirmed 0x65 against an INCOMPLETE crossOut set → C
is a non-member → `fold_crossout` skips it → the reverse mint folds nothing, and Bitcoin is forward-only so the
scan never revisits C's block. Because finalized ≤ live and the count is monotone, `>` never occurs — the
relaxed check is effectively a no-op, deleting the forcing function entirely.

Severity: the claimId is NOT consumed on a non-member skip (spent-IMT insert only on a member fold,
reflect.rs:1379-1382), so the user can RE-BROADCAST — not permanent loss. But the delay becomes UNBOUNDED and
prover-discretionary (strict `==` bounds it to the next attest ~finality); a censoring prover can starve a
specific claimId indefinitely, each retry costing the user another Bitcoin tx. Plus a generational-rebase
**drain-gate stall**: reflect.rs:400-406 asserts `folded_crossout_count == crossOutCount` at successor genesis,
so a predecessor allowed to freeze with an unfolded crossOut deadlocks migration.

The consume/crossOut counts are read from the SAME finalized-block MPT proof (eth-reflection main.rs:292-311),
so keeping consume strict does not rescue crossOut — a proof can be consume-current yet crossOut-stale exactly
in the window where crossOuts landed after the last consume, and `attest` advances the Bitcoin-side digest +
spent root over that incomplete set (ReflectionLib:152-166).

## FINAL DISPOSITION

Neither count's gate can be relaxed. Both are load-bearing soundness enforcement:
- consume `== live` → double-credit backstop (design 1 refuted),
- crossOut `== live` → reverse-mint completeness forcing function on a forward-only chain (design 3 refuted).

Fable #3's grief is therefore **inherent** to fold-completeness, not a fixable gate bug. The gate correctly
refuses to advance while a reverse mint or racing consume is pending. Both grief vectors are self-funded (a
crossOut BURNS a source note per attempt, CrossOutNullifierNotSpent :2182; a consume spends the attacker's own
btcHomed note). **Accept + document** as a fail-closed liveness limit; mitigate operationally: honest-folder
Mode-B cadence, private-mempool attest submission, and the `reflectionConfirmations` grace window (already sized
for folder downtime). NOT a soundness freeze-blocker. No code change, no reprove.

## Anti-grief lever enumeration (design pass) — confirms accept + operational

Reframing finding: BOTH live counters are bumpable ONLY through a full `settle` carrying a valid SP1 proof —
`crossOutCount` at ConfidentialPool.sol:2197 (guarded by CrossOutNullifierNotSpent :2184, burns a source note),
`bitcoinConsumedCount` at :1895 (btcHomed batch only, :1776/:1877). There is NO cheap standalone bump path. So
the true grief floor is ~1 SP1 settle proof per finality window (~110 proofs/day) — a real, ongoing proving +
gas cost, not "pennies." The per-bump proof cost IS the anti-spam fee.

Levers ranked (effectiveness / risk):
- L1b faster proving (`.network()`): zero risk, no reprove; shrinks only the additive proving term — the ~13-min
  ETH-finality floor is irreducible. DO IT (bounded benefit).
- L1c quiescence-targeted attest cadence: zero risk; meaningful vs organic contention, no help vs a determined
  spammer who denies quiescence. Already the documented mitigation.
- L2b monitor sustained `ConsumedCountStale` reverts + rely on the SP1-proof-per-bump floor. Right response.
- L2a relay pricing: LOW — `settle`/`attestBitcoinStateProven` are permissionless (:1740/:1681), so an attacker
  bypasses the relay entirely by submitting on-chain. Deters only casual relay-routed spam.
- L1a private-mempool attest: near-ZERO vs sustained spam — the grief is count-bumps in EARLIER blocks, not a
  frontrun of the attest. (Correction: earlier notes overweighted this; keep only as generic frontrun hygiene.)
- L3a assert-live-count arg / L3c bundle attest+settle: ZERO grief benefit, cost scarce EIP-170 bytes. REJECT.
- L3b bundle attest + catch-up-fold "just-landed" entries: REFUTED by construction — those entries are
  unfinalized; folding them re-opens the double-credit / forward-only-censorship holes. Do not pursue.
- L3d contract anti-spam fee: UNAVAILABLE (immutable bytecode + would need reprove).

Consume vs crossOut asymmetry: crossOut is the cheaper vector (any EVM note); consume is self-throttling (needs
a btcHomed note = prior Bitcoin bridge-in). Any finite mitigation targets crossOut. No contract/guest change is
warranted; posture unchanged.
