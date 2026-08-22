# Reflection liveness batch — coordinated design (F-9-cap / F-13 / F-10 / F-11 / F-14-mirror)

All five change the reflection or eth-reflection guest and its committed digest, so they land as ONE build → ONE
reprove (both ELFs) → ONE fixture-board regen. F-13 is fund-safety-delicate; the rest are liveness. No feature is
removed — fast-lane, Mode-B, cross-out, cBTC, gasless tip all stay live; these only bound work and decouple gates.

## Shared digest change
ScanReflection gains three carry-over accumulators, committed in `digest()` after `consumed_outpoints_*`:
- `pending_effects_root` / `pending_effects_count` — the deferred (asset-meta | cbtc-lock | btc-call) queue.
- `consume_cutoff` (u64) — the eth consumedCount the guest has folded THROUGH this cycle (F-13).
- `pending_consume_root` — the set of eth-recorded-but-unfolded consume OUTPOINTS (F-13 refuse-gate).
The reflect-stdin serializer + `dapp/confidential-pool.js` assembler must serialize/mirror these in `prior`, and
every committed reflection fixture regenerates. Validate with `reflect-exec` DIGEST_MATCH per fixture.

## F-9-cap — bound surfaced effects per cycle
- Constant `MAX_SURFACED_PER_CYCLE` (start 16). During the block scan, push newly-authenticated asset-metas,
  cBTC-lock folds, and btc-calls into a single ordered `pending_effects` list (tagged by kind) instead of the PV
  arrays directly. After the scan: prepend the prior `pending_effects` (from resume state), surface the first K
  into the PV arrays (`attestedAssetMetas` / `cbtcLocksFolded` / `btcCallsFolded`), keep the remainder as the new
  `pending_effects`, and commit its root. Contract attest already caps meta deploys (landed); with the guest cap
  the per-cycle SSTORE count is O(K), closing the residual ~$1-3K SSTORE-bomb.
- Ordering note: cbtc-lock SPENT/REDEEMED deltas are NOT deferrable (security — a spent lock must retire before a
  mint can race it), but their count is already bounded by the FOLD cap over time (you can't spend more locks than
  were folded), so capping folds suffices.

## F-13 — split the freshness gate, safely (the delicate one)
Problem: `consumedCount == bitcoinConsumedCount` (ConfidentialPool.sol:1788) is unsatisfiable under sustained
fast-lane/cross-out traffic (one spend / ~15 min freezes attest forever). A NAIVE phase-split reopens cross-lane
double-spend: the block-scan must never advance a Bitcoin spend/burn-deposit of a note whose consume is recorded
on Ethereum but not yet folded here.

Safe design (hybrid of report options a+c):
1. The eth-reflection proof surfaces, in addition to the folded consume set, the set of eth-recorded consume
   OUTPOINTS up to `bitcoinConsumedCount` — i.e. BOTH folded (≤ cutoff C) and pending (C..bitcoinConsumedCount).
2. The reflection guest folds consumes up to a cutoff `C` IT commits (`C ≤ bitcoinConsumedCount`), advancing the
   spent set + `consumed_outpoints_root` for those only.
3. The block scan REFUSES (refunds, never onboards) any Bitcoin spend or burn-deposit whose outpoint is in the
   PENDING set (recorded on Ethereum, not yet folded — beyond `C`). This preserves Ethereum-senior ordering: a
   racing Bitcoin spend of a consumed-but-unfolded note is refunded, not double-spent.
4. Contract gate relaxes: `consumedCount` (== `C`) must be monotonically non-decreasing and `≤ bitcoinConsumedCount`
   (not `==`); the pending set the guest refused-against is bound into the PV so the contract can trust the cutoff.
Result: attest always lands (pick `C` = whatever finalized slot the proof binds); consumes catch up over cycles;
no note can be spent on both lanes. THE DOUBLE-SPEND IS THE EXPLICIT TEST: a fixture where a consumed-but-unfolded
outpoint appears as a Bitcoin spend must fold to a REFUND, and its later consume-fold must still succeed.

### GAP found in the refuse-pending plan above (deeper analysis, 2026-08-22)
The refuse-set the guest commits is fixed at PROVE time. But a fast-lane consume proves non-membership against the
CURRENT reflected spent root, which the contract forces `== knownBitcoinSpentRoot` (ConfidentialPool.sol:340) — i.e.
the LATEST attested tip. During this batch's prove+attest window (minutes-hours), the latest attested tip is still
`prev` (this batch not yet landed). So a consume recorded in that window proves against `prev` and its racing
Bitcoin spend is in `[prev+1..tip]` — inside THIS batch, yet NOT in the guest's prove-time refuse-set. Double-spend
reopens. Refuse-pending ALONE cannot close it; the refuse-set can never be current at attest for the exact window
that matters. Two mechanisms actually close it — this is a DIRECTOR decision (fast-lane UX + settle-guest blast
radius differ):

- **(B) Time-locked fast-lane output** — decouple safety from timing entirely. The Ethereum note minted by a
  fast-lane consume is NOT spendable until the reflection has folded that consume (source marked spent). Both lanes
  may be attempted; the reflection reconciles in canonical order — if the Bitcoin spend folds first, the later
  consume-fold sees the source already spent → INVALID → the time-locked output is reclaimed, never released. No
  ==NOW gate; attest always lands. COST: fast lane is no longer instant (output delayed ~reflection latency +
  confirmations). Touches settle guest (mint a locked output + a reclaim path) + reflection (fold reconciliation).

- **(D) Delayed-root source-freshness — DISPROVEN 2026-08-22, do not revive.** Proving the source unspent against
  an OLDER spent root LOOSENS freshness: it permits N to have been Bitcoin-spent during the DELAY window, ADDING
  double-spend surface. Reversing the direction doesn't help either — this batch reflects `[prev+1..tip]` for the
  FIRST time, so every consume recorded before this attest can race it; a racing consume proves against the latest
  attested tip (`prev` during the window) and its spend lands in `[prev+1..tip]`. Therefore any reflection-side-only
  or older-root gate reduces exactly to `C == bitcoinConsumedCount@attest` (==NOW). Safety CANNOT be decoupled from
  timing on the reflection side alone.

Only two things actually close it: **(B)** time-lock the fast-lane output (decouple safety from timing — robust,
costs instant UX), or accept the **F-10 probabilistic mitigation** (small prefix batches prove fast enough to hit
==NOW between consumes — instant UX, not a hard guarantee). (B) touches the settle guest; the mitigation is
reflection-only. Pick before writing immutable code.

### CHOSEN: (B) time-locked fast-lane output (2026-08-22) — precise design
The fast-lane consume's OUTPUT (the consumer's Ethereum credit) is NOT immediately spendable; it is released only
after the reflection folds the consume and confirms the source was still live at fold time. Reuses the cross-out
PENDING→CONFIRMED scaffolding (crossOutCommitment/crossOutCount/foldedCrossOutCount) — mirror it, do not invent a
parallel mechanism (elegance).

Derived invariants / decisions (all confirmed against code):
1. A fast-lane consume can still only be RECORDED if its source N is non-member of the CURRENT reflected spent root
   (ConfidentialPool.sol:340 unchanged) → N's Bitcoin spend, if any, is always in a not-yet-reflected block.
2. `fold_consumed` (cxfer-core:4323) MUST gain a REVOKE outcome instead of PANIC-on-already-spent (currently
   `live.get(...).ok_or(...)?` + `.expect()` at reflect.rs:608). RELEASE = source live + ν/leaf checks pass (fold
   spent set + consumed_outpoints as today). REVOKE = source proven a MEMBER of the spent set (genuinely
   Bitcoin-spent first) → advance consumed_count + record resolution, but DO NOT re-fold spent. REVOKE requires a
   spent-set MEMBERSHIP proof, never "prover supplied no live witness" (else a prover griefs an honest consume).
3. The reflection surfaces per-consume RESOLUTIONS (RELEASE|REVOKE, keyed to the consume) in the PV, bounded per
   cycle (cap + overflow-root, same shape as F-9-cap) so it can't SSTORE-bomb.
4. Contract: settle records the pending fast-lane output (consumeId → output leaf) WITHOUT inserting it spendable;
   attest applies resolutions — RELEASE inserts the output leaf (now spendable), REVOKE discards it (consumer keeps
   N live on Bitcoin, no double). The `consumedCount == bitcoinConsumedCount` ==NOW gate (line 1794) is REMOVED;
   consumedCount may lag (monotone, ≤ bitcoinConsumedCount).
5. Blast radius — SETTLE GUEST UNCHANGED (settle ELF stays frozen). The fast-lane consume already surfaces
   `bitcoinConsumedSources` (non-empty ⟺ batch_authenticated ⟺ every input is a btcHomed fast-lane source,
   main.rs:5376-5390), so the contract detects a fast-lane settle from `pv.bitcoinConsumedSources.length > 0` and
   escrows its output leaves with NO new settle signal. Changes are reflection guest (fold_consumed REVOKE +
   bounded resolutions PV) + cxfer-core + contract only → reprove the REFLECTION ELF only (F-10/F-11 ride the same
   reflection/eth-reflection reprove; settle untouched).
   - ESCROW representation (reuses F-9-cap drain shape): at settle, if fast-lane, store
     `pendingFastBatch[batchId] = {leavesCommit = keccak(leaves), numConsumes, numResolved, revoked}` and record
     `consumeBatch[ν] = batchId` per consumed ν — do NOT `_appendLeaves`. Emit a PendingLeaves DA event.
   - RESOLUTION: reflection surfaces `(ν, RELEASE|REVOKE)` per folded consume (bounded, cap+overflow). attest maps
     ν→batchId: REVOKE ⇒ mark batch revoked; RELEASE ⇒ ++numResolved. When numResolved==numConsumes && !revoked,
     a permissionless `releaseFastBatch(batchId, leaves)` (leaves match leavesCommit) `_appendLeaves` them (now
     spendable) + emits LeavesInserted. A revoked batch is deleted (outputs never mint; consumer keeps N live on
     Bitcoin — no double).
   - Batch-atomicity: a fast-lane batch's conservation binds ALL its inputs, so ONE revoked consume invalidates the
     whole batch's outputs (release iff every consume RELEASEs). Batches are self-contained (BIP-340-signed by the
     submitter) so a griefer can't inject someone else's note.
6. Contract gate: REMOVE the `r.consumedCount == bitcoinConsumedCount` ==NOW gate (line 1794); keep consumedCount
   monotone and ≤ bitcoinConsumedCount. The cutoff C is naturally the eth proof's finalized-slot consumedCount
   (already bound), so no arbitrary prover choice. (Scope: the sibling cross-out ==NOW gate at line 1807 is a
   DISTINCT concern — its BTC mint is already pending-by-construction; leave it, F-13 is the consume path.)
7. UX: fast-lane credit is spendable after ~reflection latency + REFLECTION_CONFIRMATIONS (no longer instant) —
   the accepted cost of the hard guarantee.

### FINAL DECISION 2026-08-22 — keep ==NOW, the fast lane stays instant + atomic (powerful). F-10 is the fix.
The powerful fast lane the product wants is INSTANT (credit spendable now) + ATOMIC (fast-lane straight into a
swap/CDP in one settle). That combination is inherently optimistic and, by the impossible-trinity below, REQUIRES
the ==NOW timing gate — no relaxation preserves instant+atomic (all of D, B, refuse-sets, two-phase, soft/hard-tip,
bonds, insurance collapse; bonds/insurance fail because the double-spend is profitable inside the confirmation
window). So ==NOW is RETAINED. F-13 is therefore a LIVENESS knob, not a safety change:

IMPOSSIBLE TRINITY (any two, never three): INSTANT · ATOMIC · SMOOTH-under-arbitrary-load. instant+atomic ⇒ the
owner can extract the ETH-side value (swap→withdraw) inside the ~1h confirmation window then double-spend the BTC
source; only ==NOW (hold the spent-set advance) or a provisional-output hold stops it. We choose instant+atomic, so
SMOOTH is the tradeoff — and smooth is a THROUGHPUT dial, not a wall: staleness happens only when a consume lands
DURING the block-scan proof. F-10 (small prefix batches) + prover throughput shrink that window → retry rate → 0.
The residual is a self-healing re-prove (fresher eth proof), never a fund gap, never an indefinite freeze. Future
escalation IF extreme scale ever bites: restructure the reflection so the consumed-outpoint handling is a separable
layer and the consume-fold is a cheap final proof increment (drives the stale window to seconds). NOT a launch
blocker; does not touch the safety model.

ACTION: implement F-10 + F-11 + F-14 (reflection/eth-reflection reprove); the ==NOW gate at ConfidentialPool.sol:1794
stays exactly as-is. The (B)/(D) analyses below are retained as the WHY-NOT record so they are never re-litigated.

### (B) BLOCKER found 2026-08-22 — intractable for the full fast-lane feature set. Do not implement as scoped.
A btcHomed (fast-lane) batch may produce the FULL value-effect set (ConfidentialPool.sol:2039-2043): withdrawals,
fees, leaves, SWAPS, liquidity, cdpMints/Closes/Liquidations/Topups, cbtcMints, crossOuts — all gated to pool-minted
assets. For (B) escrow to be sound, EVERY effect a revocable source funds must be deferred until RELEASE. Leaves/fees
are deferrable (commitment escrow). SWAPS and CDP mints are NOT — a swap has already moved AMM reserves at settle,
and there is no escrow-then-rollback for AMM/CDP state. So (B) either (a) removes fast-lane→swap/CDP/cross-out (a
real feature loss), or (b) needs a defer-and-rollback of AMM/CDP state that doesn't exist. The ==NOW gate's virtue is
precisely that it makes the WHOLE batch atomic-and-final (source can never be revoked), which is what lets a fast
lane safely feed an irreversible swap. Conclusion: the ONLY option preserving the full feature set without
unbacked-value risk is to KEEP ==NOW and take the F-10 probabilistic mitigation. F-13 is liveness-only (stale attest
reverts → retry with a fresher eth proof; never a fund gap); F-10 small prefix batches make ==NOW satisfiable at
realistic volume; (B) stays documented as a hardening path IF the fast lane is ever restricted to simple transfers.

Adversarial cases the fixtures MUST cover: (i) honest consume, no racing spend → RELEASE; (ii) owner double-spends
(consume + racing Bitcoin spend in a later-scanned block) → REVOKE, the Bitcoin spend stands, output discarded;
(iii) prover tries to REVOKE an honest (still-live) consume with a bad membership witness → rejected; (iv) prover
tries to RELEASE a consume whose source was already spent → rejected (must prove live).

## F-10 — prefix (chunked) catch-up batches
Relax the strict `prev == lastReflectionBlockHash` + `tip ∈ [matured-36, matured]` so a batch may prove a PREFIX
(any tip between `prev` and the matured anchor). Guest: `anchor_height == state.height + 1` stays, but the batch
may stop short of the matured tip; the contract accepts a tip ≤ matured. Safety unchanged (each block still fully
scanned + witness-committed); only the monolithic-catch-up-after-downtime failure mode is removed.

## F-11 — carry the sync-committee root forward (Mode-B time-bomb)
eth-reflection currently asserts the store starts at the pinned genesis bootstrap (`next_sync_committee.is_none()`),
so every cycle replays all period updates from slot 14,745,600 — cost grows with deploy age forever. Fix: carry
`current_sync_committee` (its tree-hash root — the digest already has word 7 as the anchor) forward in the
eth-reflection digest, and let a cycle RESUME from a committee whose hash == the prior cycle's committed root,
verifying only NEW period updates since. Keep the anti-forgery property: the resumed committee is authenticated by
the digest chain (word 7), NOT a free witness — a mismatched resume root fails.

## H-trio — concrete designs (2026-08-22, after the external partial audit rated H-1/H-2/H-3 GO-blockers)
External audit independently confirmed all three as real GO-blockers (+ a CRITICAL C-1: class-0 bridge-mint used
the secret-key ν for an owner=0 bearer note → unmintable → FIXED commit 3450db66, leaf-bound ν). The trio:

**H-2 (sync-committee carry) — DESIGN LOCKED, eth-guest groundwork landed (inert until reflection side).**
Use CONTRACT-STATE + PV OUTPUT (F-9-cap pattern), NOT the reflection digest → no fixture ripple. eth_refl_digest
commits crossout/consumed/msg state but NOT the committee, so it can't carry it for free. Steps:
- eth guest (DONE, inert): removed the `finalized_header.slot == ETH_GENESIS_SLOT` pin; keeps genesis_validators_root
  + next_sync_committee==None. The head>prev_head gate (reads exec_state_root only from the REPLACED header) keeps
  the resumed header's exec root out of the proof regardless of resume slot. Safe/inert: reflect.rs STILL pins
  word 8 == ETH_GENESIS_SYNC_COMMITTEE, so nothing resumes yet.
- reflection guest (TODO): capture eth_pv word 7 (syncCommitteeRoot) + word 8 (prevSyncCommitteeRoot); REMOVE the
  static genesis pin (reflect.rs ~471-479); surface both as PV outputs (sentinels 0 for mode_b==0).
- contract (TODO): `bytes32 lastEthSyncCommitteeRoot` (init ETH_GENESIS_SYNC_COMMITTEE); Mode-B attest asserts
  `r.ethPrevSyncCommitteeRoot == lastEthSyncCommitteeRoot` then advances it to `r.ethSyncCommitteeRoot`; +2 PV
  struct fields. No eth-head-slot monotonicity needed — the ==NOW count gates already bar a regressed eth head.
- Ripple: Mode-B fixtures only (PV byte length; newDigest unchanged). Forge PV-construction sites +2 fields.

**H-1 (freshness-gate DoS) — the auditor's dust-crossOut exploit is the CROSSOUT gate, and THAT one is fixable.**
Split by gate: (a) CROSSOUT: relax `r.crossOutCount == crossOutCount` to `<=` and make a non-member 0x65 DEFER (a
PREFIX batch that stops before it) instead of skip — so a lagging eth set can't censor a confirmed claim and a
stale eth proof can still land. This CLOSES the auditor's exploit (dust crossOut every 30min). (b) CONSUME: stays
==NOW — proven (impossible-trinity, this doc) that an instant+atomic fast lane REQUIRES it; F-10 small batches keep
it satisfiable. So H-1 = the crossout-defer half + H-3's prefix capability. Entangled with H-3.

**H-3 (catch-up cliff) — prefix batches + bounded per-proof memory.** (a) prefix/chunked batches (relax the exact
`prev == lastReflectionBlockHash` + tip-within-36; the canonicity snag is the relay retaining fork blocks, so a
deep-prefix tip needs guest PoW-linkage from the pinned prev + a burial check — NOT blockHeight-burial alone, which
a low-work fork defeats). (b) the live-set OOM is the deeper limit — Merkleize the live UTXO set with witnessed
lookups so per-proof memory is O(Δ) not O(full live set). (a) also provides the "defer" mechanism H-1(a) needs.

NOTE: full implementation needs MANY reliable guest-rebuild + fixture-regen + forge cycles + a coordinated 3-ELF
reprove. Do it in a STABLE environment / on the prover box — the local machine currently times out compile-checks.

## Order of implementation (one reprove at the end)
1. F-14 JS mirror (bid `!spends.is_empty()` — guest landed) — trivial, do first.
2. F-9-cap (self-contained, gas-only, non-fund-safety) — build + DIGEST_MATCH.
3. F-11 (eth-reflection, isolated to the light-client resume) — build + eth-reflection fixtures.
4. F-10 (anchor relaxation) — build + catch-up fixtures.
5. F-13 (LAST — the delicate one; the whole batch's digest is settled by now) — build with the double-spend
   fixture as the gate.
6. Regenerate the full reflection fixture board, reprove BOTH ELFs, rotate the pinned vkeys + slot/vkey gates in
   lockstep, run the DIGEST_MATCH board + a real recursion proof on a Mode-B-with-consume + a pending-consume-race
   vector on the box. THEN freeze.
