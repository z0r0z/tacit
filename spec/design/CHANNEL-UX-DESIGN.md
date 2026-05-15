# Channel Period UX — Design Reference

> Status: 🛠️ Implementation reference (not a normative amendment).
> Scope: dapp-side UX for trading via the tacit channel layer
> (`T_INTENT_ATTEST` `0x30`, SPEC.md §5.17) with mesh phase 0
> cross-worker verification.
>
> Purpose: give an implementer a self-contained brief to build the
> trader-facing UX that makes the existing channel + per-surface
> settlement primitives FEEL like an "atomic at end of channel
> period" experience, without requiring any protocol-level
> changes.
>
> Audience: dapp engineers, designers, anyone implementing the
> trader-facing trading UI.

---

## What this design accomplishes

The protocol settles via per-surface primitives that confirm in
the same block (T_AXFER_VAR for orderbook fills, T_SWAP_BATCH /
T_SWAP_VAR for AMM swaps). At the Bitcoin layer they're separate
transactions; at the user-perceived layer they should feel like
one batch executing at the end of a channel period.

This document specifies the dapp state machine, UI states, and
data plumbing that delivers that experience.

The key reframe: a "channel period" is the interval between
`T_INTENT_ATTEST` envelopes (~1 Bitcoin block). During the period,
intents accumulate; at period boundary, a settler bundles and
broadcasts. The trader sees one logical action (their intent)
flow through that rhythm to a clean settlement summary.

---

## What this design does NOT specify

- The on-chain wire format. That's in SPEC.md + amendments;
  unchanged by this doc.
- The worker's intent-pool data structures. Worker implementation
  choice.
- The settler bundling algorithm. Settler implementation choice.
- Mesh phases 1 + 2 (relay + active attestation). See
  `SPEC-TACIT-MESH-AMENDMENT.md`; this doc only uses phase 0
  (cross-worker verification).

---

## Trader journey (narrative walkthrough)

A user wants to swap 100,000 sats for TAC tokens at no worse than
10% slippage. From their perspective:

1. **They open the swap tile and type the amount.** Dapp shows
   estimated routing across orderbook depth + AMM, projected
   effective price, and "next batch settles in ~6 min" countdown.

2. **They click "Submit to channel."** Their dapp signs the intent
   (locally, no BTC needed for typical asset-for-asset swaps) and
   POSTs it to the worker's intent-pool relay. Dapp transitions to
   a "soft-confirming" state.

3. **~30 seconds later**, the worker's next `T_INTENT_ATTEST`
   envelope hits chain. The dapp watches for it, fetches the
   worker's published sorted intent-id list, verifies the trader's
   intent_id is in it, and verifies the hash matches what's on
   chain. State: "soft-confirmed."

4. **In parallel**, the dapp fetches ≥ 1 other worker's
   attestation for the same scope (mesh phase 0). Cross-checks
   confirm the intent is in their pools too. Status escalates to
   "cross-confirmed."

5. **The trader sees a countdown** to the next Bitcoin block + a
   summary of the current batch composition ("13 intents, 2.4M
   sats total volume"). They can:
   - Wait (most common — a settler will bundle the batch and
     broadcast)
   - Click "Settle now" (themselves become the settler; pay BTC
     fee, claim aggregate tips)
   - Click "Cancel" (one-click — dapp self-spends their input UTXO
     to invalidate the intent at Bitcoin level)

6. **Within the next 1-3 Bitcoin blocks**, a settler broadcasts a
   bundled tx. The dapp detects it via mempool/block-source
   subscription. State transitions to "settling."

7. **At confirmation depth ≥ 1** (or ≥ 3 for canonical pool-state
   advance, per AMM.md reorg discipline), the dapp displays the
   settlement summary: per-leg breakdown (orderbook fills + AMM
   swap), effective price, settler tip paid, tx links.

8. **If the trader had multiple intents** in the same channel
   period, all of them land in the summary view together (whether
   they hit the same settlement tx or different ones in the same
   block).

The user perceives this as: "I posted, it processed, my fills
landed in block H, here's the breakdown." Atomicity at the
user-perceived layer.

---

## State machine

```
┌──────────────┐
│  COMPOSING   │ user is building the intent
└──────┬───────┘
       │ user submits
       ▼
┌──────────────┐
│   POSTED     │ intent in worker's pool, awaiting attestation
└──┬─────┬─────┘
   │     │ worker drops / fails to attest
   │     └──────────────► DROPPED
   │ worker's T_INTENT_ATTEST
   │ confirms inclusion
   ▼
┌──────────────┐
│   ATTESTED   │ inclusion verified vs primary worker
└──┬───────────┘
   │ mesh phase 0 cross-worker confirms
   ▼
┌──────────────────────┐
│ CROSS_CONFIRMED      │ ≥ 1 other worker agrees on inclusion
└──┬───────────┬───────┘
   │           │ mismatch between workers
   │           └──► INCONSISTENT (raised to user)
   │ awaiting settlement
   ▼
┌────────────────────────┐
│ AWAITING_SETTLEMENT    │ in pool; settler hasn't broadcast yet
└──┬─────────┬───────┬───┘
   │         │       │ expiry_height passes
   │         │       └──► EXPIRED (refund input UTXO)
   │         │ user cancels
   │         └──────────► CANCELLED (self-CXFER input)
   │ settler broadcast detected
   ▼
┌──────────────┐
│  SETTLING    │ tx in mempool, awaiting confirmation
└──┬───────────┘
   │ confirms at depth ≥ 1
   ▼
┌──────────────┐
│   SETTLED    │ on chain
└──────────────┘
```

Transitions are signal-driven, not time-driven (except `EXPIRED`,
which is height-driven). UI surfaces the active state + relevant
context; user actions are available where they make sense.

---

## UI states with reference copy

### State 1: Composing

```
┌─ Swap ──────────────────────────────────┐
│ I want: [100,000] sats → ?? TAC         │
│                                          │
│ Min received: 950 TAC                   │
│ (slippage limit: 5%)                    │
│                                          │
│ Routing preview:                        │
│   ~58% orderbook (3 active asks)        │
│   ~42% AMM (TAC/cBTC pool)              │
│                                          │
│ Estimated effective price: 103.4 sats/TAC│
│ Settler tip: ~32 sats                   │
│                                          │
│ Next batch settles in ~6 min            │
│                                          │
│ [Submit to channel]                     │
└──────────────────────────────────────────┘
```

Implementation:
- Routing preview is computed locally from worker's published
  orderbook + indexer's published AMM pool state.
- Settlement countdown estimates time-to-next-block via EWMA over
  recent inter-block intervals.
- "Submit to channel" triggers the intent-signing + relay-POST
  flow.

### State 2: Posted (awaiting worker attestation)

```
┌─ Your swap ─────────────────────────────┐
│ 100k sats → ≥ 950 TAC                  │
│                                         │
│ ⏳ Worker confirming inclusion…         │
│ Posted 12 sec ago                       │
│                                         │
│ [Cancel]                                │
└─────────────────────────────────────────┘
```

Implementation:
- Spinner runs until next worker attestation containing the
  trader's intent_id arrives on chain (typically < 30 sec).
- "Cancel" is one-click: dapp self-spends the trader's input UTXO
  via CXFER. Bitcoin-level invalidation; intent is forever
  unfillable.
- Cancel is available freely in this state — no settler has
  consumed the input yet.

### State 3: Attested (single-worker)

```
┌─ Your swap — confirmed by worker A ─────┐
│ 100k sats → ≥ 950 TAC                  │
│                                         │
│ ✓ In worker A's pool                    │
│ ⏳ Cross-confirming with other workers… │
│                                         │
│ Batch composition: 13 intents,         │
│   2.4M sats total volume                │
│                                         │
│ Settlement in: ~4 min                   │
│                                         │
│ [Cancel]                                │
└─────────────────────────────────────────┘
```

Implementation:
- Single-worker confirmation comes ~one Bitcoin block after
  intent post.
- Cross-confirmation runs in parallel via mesh phase 0.
- Batch composition data comes from fetching the worker's
  published sorted_intent_ids[].

### State 4: Cross-confirmed (mesh phase 0 result)

Three sub-states depending on cross-check outcome:

**4a. ✓ Cross-confirmed:**
```
┌─ Your swap — cross-confirmed ───────────┐
│ 100k sats → ≥ 950 TAC                  │
│                                         │
│ ✓ Confirmed by 3 of 3 watched workers   │
│ Batch: 13 intents · 2.4M sats           │
│ Settlement in: ~4 min                   │
│ Settler tip share: 32 sats              │
│                                         │
│ [Cancel] [Settle now (+800 sat fee)]    │
└─────────────────────────────────────────┘
```

**4b. ⚠ Weak confirmation (only one worker agrees):**
```
┌─ Your swap — weak confirmation ─────────┐
│ 100k sats → ≥ 950 TAC                  │
│                                         │
│ ⚠ Confirmed in only 1 of 3 workers      │
│   (other workers haven't yet seen your  │
│    intent — could be relay lag, or      │
│    censorship)                          │
│                                         │
│ Recommended: wait for cross-confirm or  │
│ re-post via a different worker          │
│                                         │
│ [Cancel] [Re-post via worker B]         │
└─────────────────────────────────────────┘
```

**4c. 🔥 Inconsistency detected:**
```
┌─ Your swap — INCONSISTENCY ─────────────┐
│ 100k sats → ≥ 950 TAC                  │
│                                         │
│ 🔥 Workers disagree about intent set    │
│   at block H                            │
│ Worker A: 13 intents (yours included)   │
│ Worker B: 12 intents (yours NOT included)│
│ Worker C: 13 intents (yours included)   │
│                                         │
│ Worker B may be censoring or lagging.   │
│ This evidence is on chain; settlement   │
│ should still proceed via A or C.        │
│                                         │
│ [Cancel] [View evidence] [Continue]     │
└─────────────────────────────────────────┘
```

The "View evidence" link surfaces the on-chain attestation hashes
+ the published lists from each worker — auditable record of the
disagreement.

### State 5: Awaiting settlement

```
┌─ Your swap — settlement window ─────────┐
│ 100k sats → ≥ 950 TAC                  │
│                                         │
│ ✓ Cross-confirmed (3 of 3 workers)      │
│ Batch: 13 intents · 2.4M sats           │
│                                         │
│ Next block: ~3 min                      │
│ Settler tip: 32 sats (your share)       │
│                                         │
│ A settler will likely bundle in the     │
│ next block. You can also settle now to  │
│ guarantee inclusion.                    │
│                                         │
│ [Cancel] [Settle now (+800 sat fee)]    │
└─────────────────────────────────────────┘
```

The "Settle now" button lets the user become the settler for the
batch. Cost-benefit they need to understand:
- Pays BTC tx fee (~800 sats today, variable)
- Claims aggregate tip outputs from other traders
- Their trade is guaranteed in the next block (no risk of being
  bumped by a competing batch)

For high-urgency trades worth fronting the fee. Otherwise, wait.

### State 6: Settling (broadcast detected)

```
┌─ Your swap — settling ──────────────────┐
│ 100k sats → ≥ 950 TAC                  │
│                                         │
│ 📡 Broadcast at block H+0               │
│ Tx: a3f8…c1d2  [view on explorer]       │
│                                         │
│ Awaiting confirmation:                  │
│   ▓▓▓░░░ 1 of 3 blocks                 │
│                                         │
│ Cancel no longer available              │
│ (input is in the broadcast tx)          │
└─────────────────────────────────────────┘
```

Implementation:
- Triggered when the dapp's mempool subscription detects a tx
  containing the trader's input outpoint.
- Confirmation progress bar advances per new block depth.
- Cancel is removed: the input is already committed; the only way
  to undo now is if the tx fails to confirm (mempool drop /
  RBF / reorg).

### State 7: Settled — full fill

```
┌─ Your swap — settled ───────────────────┐
│ 100k sats → 967 TAC                    │
│ Block H+0 · depth 3 (final)             │
│                                         │
│ Routed via:                             │
│   • 58k sats → orderbook (2 fills)      │
│     ↳ maker X: 30k → 290 TAC            │
│     ↳ maker Y: 28k → 271 TAC            │
│   • 42k sats → AMM pool TAC/cBTC        │
│     ↳ swap @ P_clear = 103.6            │
│                                         │
│ Effective price: 103.4 sats / TAC       │
│ vs your limit (105.3): 1.8% better      │
│                                         │
│ Settler: bc1q…xyz                       │
│ Settler tip: 32 sats                    │
│                                         │
│ [View txs] [Trade again]                │
└─────────────────────────────────────────┘
```

The post-settlement summary is the highest-value piece of UX. It
turns "your swap completed" into legible execution data.

### State 8: Settled — partial fill

```
┌─ Your swap — partially settled ─────────┐
│ Intent: 100k sats → ≥ 950 TAC          │
│                                         │
│ Filled: 73k sats → 705 TAC              │
│ Unfilled: 27k sats (expired)            │
│                                         │
│ Min-out target: 950 TAC                 │
│ Actual: 705 TAC                         │
│ Status: ❌ Below your minimum            │
│                                         │
│ Refund: 27k sats returned to your       │
│ wallet (orderbook insufficient depth +  │
│ AMM moved past your slippage limit)     │
│                                         │
│ ☐ Re-post remainder with adjusted price │
│ ☐ Just accept the partial fill          │
└─────────────────────────────────────────┘
```

Partial fills happen when orderbook depth + AMM curve can't
satisfy the full intent within slippage limits. The unfilled
portion either refunds (preserved as a usable input UTXO) or can
be re-posted with adjusted parameters.

If the partial fill DID meet `min_out` (e.g., trader's limit was
500 TAC and they got 705 TAC for the filled portion), display the
state as "✓ Min-out met (partial fill)" without the failure
framing.

### State 9: Cancelled / expired

```
┌─ Your swap — cancelled ─────────────────┐
│ Intent: 100k sats → ≥ 950 TAC          │
│ Cancelled at block H+2 · no fills       │
│                                         │
│ Input UTXO refunded to your wallet      │
│                                         │
│ [Re-post] [Adjust slippage] [Done]      │
└─────────────────────────────────────────┘
```

Cancellation displays differently depending on cause:
- User-initiated: "Cancelled at block H+2 · no fills"
- Expiry: "Expired at block H+expiry · no fills"
- Worker-dropped: "Worker dropped your intent at block H+N. Re-post via a different worker?"

---

## Countdown logic

The "next batch settles in ~X min" countdown is dapp-computed from
recent Bitcoin block intervals. Concrete:

```js
// State
const recentBlockIntervals = []; // ms between recent block confirmations
const EWMA_ALPHA = 0.3;

// On each new block, update the moving average
mempoolWebSocket.on('block', (newBlock) => {
  const interval = newBlock.timestamp - lastBlockTimestamp;
  recentBlockIntervals.push(interval);
  if (recentBlockIntervals.length > 20) recentBlockIntervals.shift();
  lastBlockTimestamp = newBlock.timestamp;
});

function computeNextBlockEstimate() {
  if (recentBlockIntervals.length === 0) return 600_000; // 10 min nominal
  const ewma = computeEWMA(recentBlockIntervals, EWMA_ALPHA);
  const elapsed = Date.now() - lastBlockTimestamp;
  return Math.max(0, ewma - elapsed);
}

// Update display every second
setInterval(() => {
  const ms = computeNextBlockEstimate();
  renderCountdown(ms);
}, 1000);
```

Display variants:
- `> 5 min`: "Next batch settles in ~X min"
- `1-5 min`: "Settlement in ~X min" (smaller, more attention)
- `< 1 min`: "Settlement imminent (any block)"
- `block found, no settlement tx in mempool yet`: "Block H+0 found, awaiting settlement"
- `settlement tx in mempool`: transition to State 6 (settling)

If multiple blocks pass without a settlement tx including the
trader's intent, surface a "Settler delay — consider settling
yourself" hint after ~3 blocks of waiting.

---

## Real-time data sources

The dapp opens four parallel subscriptions:

### 1. Worker websocket (per worker the user subscribes to)

```js
ws = new WebSocket(`wss://${worker.host}/v1/subscribe`);
ws.send({ subscribe: ['scope', scope_id, 'intent', my_intent_id] });

ws.on('message', (msg) => {
  switch (msg.type) {
    case 'intent_pool_update': /* re-render batch composition */ break;
    case 'attestation_broadcast': /* worker just attested; verify */ break;
    case 'settlement_broadcast': /* settler tx hit mempool */ break;
    case 'intent_dropped': /* worker dropped your intent */ break;
  }
});
```

### 2. Block source (Bitcoin RPC or block-explorer WebSocket)

Watches for:
- New block confirmations (drives countdown reset + settlement confirmation depth)
- Mempool tx detection matching the trader's input outpoint
- Reorg events (rare; trigger State 6 rollback to State 5 if pool-advance gets reverted)

### 3. Indexer query endpoint

Periodic polls (every ~30 sec) for:
- Latest `T_INTENT_ATTEST` envelope per subscribed scope per worker
- Cross-worker comparison (mesh phase 0 verification)
- Equivocation flag-set state

### 4. Local Service Worker

Handles the T_SWAP_BATCH 2-RTT signing flow in the background so
the trader doesn't have to keep the foreground tab open during
settlement. See AMM.md §"UX mitigations for the 2-RTT cost" for
the underlying spec.

---

## Mesh phase 0 cross-worker verification (concrete flow)

```js
async function verifyIntentInclusion(intent_id, scope_id, height) {
  // Fetch all watched workers' attestations for this scope at this height
  const workers = userPreferences.trustedWorkers;
  const attestations = await Promise.all(
    workers.map(w => fetchAttestation(w.pubkey, scope_id, height))
  );

  // Verify each attestation's signature + freshness
  const validAttestations = attestations.filter(a =>
    verifyWorkerSig(a) && isFresh(a, 300_000) // 5 min TTL
  );

  // Fetch each worker's published sorted_intent_ids list
  const lists = await Promise.all(
    validAttestations.map(a => fetchSnapshotList(a.worker_pubkey, scope_id, height))
  );

  // For each, verify the list's hash matches the attestation's intent_pool_hash
  const consistentLists = lists.filter((list, i) =>
    sha256(list.join('')) === validAttestations[i].intent_pool_hash
  );

  // Check our intent_id is in each consistent list
  const inclusionResults = consistentLists.map(list => ({
    worker: list.worker,
    included: binarySearch(list, intent_id) !== -1,
  }));

  return {
    confirmedBy: inclusionResults.filter(r => r.included).map(r => r.worker),
    excludedBy: inclusionResults.filter(r => !r.included).map(r => r.worker),
    inconsistent: inclusionResults.length < validAttestations.length, // some lists didn't match their hashes
  };
}
```

UI displays the result as one of 4a / 4b / 4c above.

---

## Edge cases

### Worker dropout mid-channel-period

Trader posted intent to worker A. Before A's next attestation, A
goes offline (no attestation hits chain). Dapp detects this via:
- Heartbeat timeout on worker A's websocket
- Expected attestation block passes with no envelope from A

UX: surface "Worker A is unresponsive. Re-post via worker B?" with
one-click re-post.

### Settler race (two settlers bundle same intent)

Two settlers each include the trader's input in their bundle.
Only one tx confirms (the other's input is double-spent). Dapp
detects this via mempool watching: when two txs reference the
same outpoint, the winning one is determined by block confirmation.

UX: this happens transparently — the trader sees one settlement,
not two. No action required.

### Trader's intent expires unfilled

`expiry_height` passes without inclusion in any settlement tx.
Indexer treats the intent as expired; worker drops it from its
pool.

UX: transition to State 9 with "Expired at block H+expiry · no
fills." Offer re-post with adjusted slippage or different
worker.

### Bitcoin reorg invalidates settlement

Rare but possible. Settlement tx confirmed at depth 1, then a
reorg replaces the block. The settlement tx may or may not be in
the new block.

UX: if the tx reappears in the new chain → State 6 progress bar
restarts. If the tx is gone → revert to State 5, surface "Reorg
event — settlement rolled back, awaiting re-broadcast."

For canonical pool-state advance (depth ≥ 3 per AMM.md), AMM swaps
only "finalize" after depth-3. Orderbook fills are atomic at
depth-1 (standard Bitcoin finality). Display depth-aware status:
- Depth 0-2: "Settling (provisional)"
- Depth ≥ 3: "Settled (final)"

### Trader's input gets pre-spent (race with intent post)

Trader's input UTXO is consumed by another tx (e.g., they
self-CXFER'd it from another tab) between posting the intent and
settlement.

UX: dapp's mempool subscription detects the conflict. Surface
"Your input UTXO was consumed elsewhere. Intent cancelled."

---

## Implementation notes

### Service Worker lifecycle

- Register the auto-signer worker in the dapp's main bundle.
- SW receives `T_SWAP_BATCH` RTT messages even when the dapp tab
  is backgrounded.
- SW signs using IndexedDB-stored signing keys (deterministically
  derived from the dapp's seed; never crosses origins).
- Auto-respond timeout: 5 seconds (matches `AMM_RTT_TIMEOUT_MS`).
- SW lifetime: ~30 sec of inactivity before browser kills it; the
  active worker websocket keeps it alive longer.

### Cross-tab discipline

If the trader has multiple dapp tabs open, they could double-sign
RTT messages and trigger equivocation flags on themselves. Defend
via:
- BroadcastChannel API: one tab is "leader" for each
  `trader_pubkey`; others defer.
- Or: shared Service Worker (single instance across tabs).

### WebSocket reconnect

Worker websockets are best-effort. Dapp must:
- Detect disconnect within 5 sec via missed pings.
- Reconnect with exponential backoff (1s, 2s, 5s, 15s, max 60s).
- On reconnect, re-subscribe to all relevant scopes + re-request
  any missed messages (worker side replays the last N seconds of
  events).

### Cancel-by-CXFER (one-click)

When user clicks "Cancel":
1. Dapp builds a self-CXFER tx: trader's input UTXO → fresh
   trader-owned UTXO of the same asset, same value.
2. Dapp signs + broadcasts.
3. Bitcoin-level double-spend invalidates the trader's intent.
4. Dapp also POSTs a cancel notification to the worker relay so
   the worker can drop the intent from its pool faster.

The cancel CXFER costs a small Bitcoin tx fee (typically <1000
sats). The user should see this cost upfront before confirming
cancellation.

---

## Open questions / decisions for implementer

1. **Default trusted-worker set.** How is it seeded? Dapp ships
   with N=3 known workers (configurable); users can add or
   remove. What's the bootstrapping list at launch?

2. **Cross-worker inconsistency threshold.** 4c (red flag) fires
   when workers disagree. What threshold is "report this as
   suspicious vs benign relay lag"? Suggested default: flag if a
   worker's list is more than 5 intents behind another's after
   500 ms.

3. **Settler-now fee disclosure.** "Settle now (+800 sat fee)"
   button cost estimate: how often re-compute? Suggested: re-fetch
   estimated fee on click, not continuously.

4. **History view.** Should the dapp surface a "your past trades"
   panel? Useful for diagnostic / proof-of-trade. Probably yes
   but not blocking V1 launch.

5. **Notifications.** Should the dapp send native browser
   notifications when settlement happens, even if the tab is
   backgrounded? Probably yes for "settled" and "failed"; opt-in
   for everything else.

---

## Implementation effort estimate

- State machine + transition logic: ~2 days
- 9 UI states with copy + visual polish: ~3-4 days
- Real-time data plumbing (4 streams): ~2 days
- Cross-worker mesh phase 0 verification: ~1 day
- Service Worker integration: ~1-2 days
- Edge case handling: ~2 days
- Polish, accessibility, edge-case copy: ~2 days

**Total: ~2 focused weeks** for a high-quality channel-period UX
on top of the existing orderbook channel implementation.

This delivers the "atomic at end of channel period" trader
experience using only existing protocol primitives — no new
opcode, no new ceremony, no protocol-level rework.
