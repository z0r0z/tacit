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
