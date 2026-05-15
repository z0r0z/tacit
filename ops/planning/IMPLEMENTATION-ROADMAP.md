# Tacit V1 — Implementation Roadmap

> Status: 🛠️ Engineering reference for parallel-track execution
> toward V1 launch (orderbook channel + AMM + AMM channel + mesh
> phase 0). Maps the protocol spec stack onto concrete file-level
> work that engineers can pick up and ship without further design
> discussion.
>
> Audience: implementing engineers + the ceremony coordinator.
> Reading order: skim the "tracks at a glance" table, pick your
> track, read its section in detail.

---

## Tracks at a glance

| Track | Scope | Owner | Effort | Critical-path? | Depends on |
|---|---|---|---|---|---|
| **1** | Orderbook channel (T_INTENT_ATTEST + orderbook scopes) | Backend + indexer | ~2 weeks | No | None |
| **2** | Mesh phase 0 (cross-worker validation) | Dapp | ~1 week | No | Track 1 |
| **3** | AMM Phase 2 ceremony coordination | Crypto coordinator | ~6-8 weeks | Yes (blocks Track 5) | None |
| **4** | `T_SWAP_VAR` implementation (per-trade AMM) | Backend + indexer + dapp | ~3-4 weeks | No | None |
| **5** | `T_SWAP_BATCH` + LP ops implementation | Backend + indexer + dapp | ~6-8 weeks | Yes | Track 3 |
| **6** | Channel UX (dapp state machine, Service Worker) | Dapp + @thanksia for market/trade UI | ~2 weeks | No | Tracks 1, 4 |

**Critical path: Tracks 3 → 5.** Everything else finishes earlier
and parallelizes freely. Total realistic time to V1 launch:
**~2-3 months** of focused engineering across 4-6 contributors.

---

## Repo layout reference

For this roadmap:
- **Dapp**: `/Users/z/tacit/dapp/tacit.js` (large single-file dapp)
- **Worker**: `/Users/z/tacit/worker/src/index.js` (Cloudflare Worker)
- **Tests**: `/Users/z/tacit/tests/` (per-feature test files, .mjs)
- **Circuits**: `/Users/z/tacit/dapp/circuits/amm/` (Circom + ptau)
- **Specs**: `SPEC.md` + `AMM.md` + `SPEC-*-AMENDMENT.md` files at repo root

**Convention**: per-track sections below reference spec authority
by file path + section anchor; engineers read the spec for
correctness arguments, follow this doc for what-to-implement-where.

---

## Track 1: Orderbook channel implementation

**Goal**: deploy `T_INTENT_ATTEST` (`0x30`) with orderbook scope
schemas. Traders verify their orderbook intents are
cryptographically tracked by the worker via on-chain attestations
cross-checked across multiple workers.

**Spec authority**:
- `SPEC.md` §5.17 (T_INTENT_ATTEST normative)
- `SPEC-ORDERBOOK-CHANNEL-AMENDMENT.md` (orderbook scope schemas)
- `AMM.md` §"Preconfirmation layer (T_INTENT_ATTEST) — tacit channel" (architectural)

### Worker tasks

File: `worker/src/index.js`

1. **Per-scope intent-pool tracking** — add internal data structure
   indexed by `scope_id`:
   ```js
   const intentPools = new Map(); // scope_id_hex → SortedSet of intent_id
   ```
   Existing orderbook intent acceptance code already lives here;
   extend it to record per-scope membership. Per-pair scope_id =
   `SHA256("tacit-orderbook-pair-v1" || asset_id_min || asset_id_max)`
   (per the amendment). Per-worker-global scope_id =
   `SHA256("tacit-orderbook-global-v1" || worker_pubkey)`.

2. **Attestation cadence scheduler**:
   ```js
   async function broadcastIntentAttestation(scope_id) {
       const sorted_intent_ids = intentPools.get(scope_id).sortedAscending();
       const intent_pool_hash = sha256(concat(sorted_intent_ids));
       const observed_height = await getCurrentBlockHeight();
       const timestamp = unixSeconds();
       const payload = buildAttestationPayload({
           scope_id, intent_pool_hash, observed_height, timestamp,
           intent_count: sorted_intent_ids.length,
           snapshot_uri: `https://${HOST}/v1/snapshot/${scope_id}`,
           worker_pubkey: WORKER_PUBKEY,
       });
       const sig = signSchnorr(workerPrivkey, sha256("tacit-intent-attest-v1" + payload));
       const envelope = composeEnvelope(payload, sig);
       await broadcastBitcoinTx(envelope);
   }
   ```
   Trigger via cron-style scheduler. Default cadence: one
   attestation per Bitcoin block per non-empty scope. Tune per
   ops experience.

3. **HTTP endpoint** `/v1/snapshot/:scope_id`:
   Returns the worker's current `sorted_intent_ids[]` as JSON for
   the scope. Used by dapps for verification (the on-chain
   `intent_pool_hash` is matched against `SHA256` of this list).

4. **WebSocket events** for connected dapps:
   - `intent_pool_update` (scope_id, added_intent_ids[], removed_intent_ids[])
   - `attestation_broadcast` (envelope_bytes, btc_txid)

5. **Equivocation defense**: refuse to sign two attestations with
   different `intent_pool_hash` for the same `(scope_id,
   observed_height)`. Idempotent re-signing of the same hash is
   fine.

### Indexer tasks

Likely also in `worker/src/index.js` (or split if you've separated
the indexer):

1. **Opcode `0x30` dispatch branch**:
   ```js
   if (envelope.opcode === 0x30) {
       return validateIntentAttest(envelope, tx, chainState);
   }
   ```

2. **Validator algorithm** (per SPEC.md §5.17):
   ```js
   function validateIntentAttest(env, tx, state) {
       if (env.observed_height > tx.block_height) return reject;
       const msg = sha256("tacit-intent-attest-v1" + env.preceding_fields);
       if (!verifySchnorr(env.worker_sig, msg, env.worker_pubkey)) return reject;
       const key = `${env.scope_id}:${env.worker_pubkey}:${env.observed_height}`;
       const existing = state.attestations.get(key);
       if (existing && existing.intent_pool_hash !== env.intent_pool_hash) {
           state.equivocationFlags.add(env.worker_pubkey);
           return reject;
       }
       state.attestations.set(key, env);
       return accept;
   }
   ```

3. **Query endpoint** `/v1/attestations/:scope_id?worker=&from_height=&to_height=`:
   Returns indexer-recorded attestations matching the filter.
   Used by dapp's mesh phase 0 cross-check.

### Tests

File: `tests/intent-attest.test.mjs` (new)

- `intent_pool_hash` construction matches between dapp and worker
- Sort order: lex-ascending byte order over 32-byte intent_ids
- Empty pool case: `intent_count = 0`, `intent_pool_hash = SHA256("")`
- Worker_sig verification (positive + tampered cases)
- Equivocation detection: two attests, same scope+height, different hashes → flag
- Multi-worker: same scope+height, different worker_pubkeys → both accepted (not equivocation)
- Snapshot HTTP endpoint returns sorted list; SHA256 matches on-chain hash

### Acceptance criteria

- [ ] 15-item test plan from `SPEC-ORDERBOOK-CHANNEL-AMENDMENT.md` passes
- [ ] Cross-impl parity: 5 canonical envelopes byte-identical between dapp + worker
- [ ] Signet deployment with 7-day soak
- [ ] Mainnet deployment

### Estimated effort: 2 weeks

Risk: low. No new crypto, no new opcode complexity beyond the SHA256+sig mechanism. Mostly indexer wiring + scheduler.

---

## Track 2: Mesh phase 0 (cross-worker validation)

**Goal**: dapp cross-checks `T_INTENT_ATTEST` envelopes from
multiple workers for the same scope; surfaces inconsistencies in
UI; gives traders cryptographic confidence beyond single-worker
trust.

**Spec authority**: `SPEC-TACIT-MESH-AMENDMENT.md` (phase 0
section only; phases 1+2 are exploratory, not for V1).

### Dapp tasks

File: `dapp/tacit.js` (extend channel-status logic, hand the
visual UI to @thanksia)

1. **Trusted-worker set** (locally configured):
   ```js
   const trustedWorkers = [
       { pubkey: "02abc...", host: "worker-a.tacit.dev" },
       { pubkey: "02def...", host: "worker-b.tacit.dev" },
       { pubkey: "02ghi...", host: "worker-c.tacit.dev" },
   ];
   ```
   Default N=3; user can add/remove via settings.

2. **Cross-worker fetch + verify**:
   ```js
   async function verifyChannelInclusion(intent_id, scope_id, height) {
       const attestations = await Promise.all(
           trustedWorkers.map(w => fetchAttestationFromIndexer(w.pubkey, scope_id, height))
       );
       const valid = attestations.filter(a => verifyAttestation(a));
       const lists = await Promise.all(
           valid.map(a => fetchSnapshotList(a.snapshot_uri, scope_id))
       );
       const inclusionResults = lists.map((list, i) => {
           const hash = sha256(concat(list));
           if (hash !== valid[i].intent_pool_hash) {
               return { worker: valid[i].worker_pubkey, status: 'forged' };
           }
           return {
               worker: valid[i].worker_pubkey,
               status: binarySearch(list, intent_id) !== -1 ? 'included' : 'omitted',
           };
       });
       const confirmedBy = inclusionResults.filter(r => r.status === 'included');
       const omittedBy = inclusionResults.filter(r => r.status === 'omitted');
       return { confirmedBy, omittedBy, forged: inclusionResults.filter(r => r.status === 'forged') };
   }
   ```

3. **Status escalation logic**:
   - All workers confirm → ✅ "Cross-confirmed (N of N)"
   - Only some workers confirm → ⚠️ "Weak confirmation (M of N)"
   - Workers disagree at same height → 🔥 "Cross-worker inconsistency"
   - All workers omit → ❌ "Not in pool"

4. **Run cross-check in a Web Worker** so it doesn't block the
   main UI thread. Standard `new Worker()` pattern.

### Tests

File: `tests/mesh-phase-0.test.mjs` (new)

- Mock 3 workers all confirming: status = "cross-confirmed"
- Mock 1 worker omitting: status = "weak"
- Mock 2 workers disagreeing at same height: status = "inconsistent"
- Mock worker publishing list whose hash doesn't match chain: status = "forged"
- Performance: cross-check N workers in <500ms with reasonable list sizes (~hundreds of intents)

### Acceptance criteria

- [ ] 4 phase-0 test items from `SPEC-TACIT-MESH-AMENDMENT.md` pass
- [ ] UI accurately surfaces all 4 status states (escalate to @thanksia for visual design)
- [ ] Performance: full cross-check completes within 2 seconds for 3-worker × 500-intent pools

### Estimated effort: 1 week

Risk: very low. Pure dapp-side logic, no new crypto, no new
protocol primitives. Reads existing T_INTENT_ATTEST data, applies
straightforward set comparison.

---

## Track 3: AMM Phase 2 ceremony coordination

**Goal**: produce the final `vk` for `amm_swap_batch.circom`,
matching the multi-party-computation pattern used by tacit's
existing mixer ceremony (finalized 2026-05-11 with 2,227
contributions + Bitcoin-block beacon, per SPEC.md §10).

**Spec authority**: `AMM.md` §"Status" (ceremony pending) +
SPEC.md §10 (mixer ceremony as pattern reference).

### Coordinator tasks

This is the only track that's not pure engineering — it requires
ceremony coordination. Reference the existing mixer ceremony's
process to keep consistency.

1. **Participant recruitment**:
   - Goal: ≥ 3 unbiased contributors. More is better.
   - Target diversity: geographic, organizational, hardware-stack.
   - Each participant runs a contribution round on a clean
     machine (ideally air-gapped), produces a transcript +
     attestation.

2. **Contribution rounds**:
   - Each participant pulls the prior contribution's output,
     applies their entropy (mouse/keyboard noise, OS random,
     hardware entropy), produces the next contribution.
   - Toxic waste destruction: each participant attests they
     destroyed their entropy source (e.g., wiped/destroyed the
     contribution machine after).

3. **Finalization beacon**:
   - Pick a target Bitcoin block height in advance (e.g.,
     "ceremony finalizes at block H").
   - At that block, hash the block's contents into the final
     contribution. Provides public, unmanipulable randomness.

4. **Publication**:
   - Publish full ceremony transcripts (each contribution + attestation).
   - Publish the final `vk` with content-addressed CID.
   - Publish a verification script that anyone can run to
     confirm the `vk` derives correctly from the published
     transcripts.

5. **Pin the vk**:
   ```
   dapp/circuits/amm/amm_swap_batch.vk.json
   ```
   Content-addressed via IPFS CID + Bitcoin tx anchoring (commit
   message pinning the CID).

### Tests

- Run the published verification script: it must derive the same
  `vk` from the public transcripts.
- Generate a sample T_SWAP_BATCH proof using the final `vk`; verify it.
- Generate an adversarial proof (under a faked vk); verify it FAILS.

### Acceptance criteria

- [ ] ≥ 3 contributions verified
- [ ] Bitcoin-block beacon applied at finalization
- [ ] Public transcripts published
- [ ] Verification script reproduces the `vk` from transcripts
- [ ] Final `vk` pinned in `dapp/circuits/amm/`

### Estimated effort: 6-8 weeks calendar time

Most of the time is participant recruitment + scheduling +
contribution rounds. Actual coordinator effort is intermittent.

---

## Track 4: `T_SWAP_VAR` implementation (per-trade AMM)

**Goal**: deploy `T_SWAP_VAR` (`0x32`) — per-trade AMM swap with
tick-fan coordination. **No ceremony dependency** (reuses CXFER N=2
crypto from `T_AXFER_VAR`). Can run in parallel with Tracks 3 + 5.

**Spec authority**: `SPEC-SWAP-VAR-AMENDMENT.md` (full normative
spec, 1190 lines).

### Indexer tasks

File: `worker/src/index.js` (validator dispatch section)

1. **Opcode `0x32` dispatch branch**:
   ```js
   if (envelope.opcode === 0x32) {
       return validateSwapVar(envelope, tx, chainState);
   }
   ```

2. **Validator algorithm** (per amendment §"Indexer validation algorithm"):
   - Decode envelope, check basic structure
   - Look up pool by pool_id in chainState
   - Reserves freshness gate: pool's running state immediately before this tx_index matches (R_A_pre, R_B_pre)
   - Curve recompute: delta_out_expected = ⌊R_B · γ_num · delta_in / (R_A · γ_den + γ_num · delta_in)⌋
   - Compare delta_out == delta_out_expected (strict equality)
   - Check delta_out ≥ min_out
   - Check R_A_post > 0 ∧ R_B_post > 0
   - **Receipt-binding check**: `C_receipt_secp == delta_out · H_secp + r_receipt · G_secp` (the inflation-defense check; do NOT skip)
   - Verify intent_sig (BIP-340 over intent_msg)
   - Verify kernel_sig (BIP-340 under `(C_change_or_sentinel − C_in_secp + delta_in_total · H_secp).x_only`)
   - Verify m=2 bulletproof
   - Tip mechanics: open tip commit, verify amount matches
   - Apply state: pool.R_A, pool.R_B advance; emit receipt UTXO; mark trader input consumed; emit tip UTXO

3. **Identity-point sentinel handling**: 33 bytes of 0x00 → treat as additive identity in verifier equations (per amendment).

### Worker tasks

File: `worker/src/index.js`

1. **Tick-fan intent record format** (off-chain intent-pool record per amendment):
   ```js
   {
       pool_id, direction, R_A_pre, R_B_pre,
       delta_in_min, delta_in_max, min_out,
       tip_amount, tip_asset, expiry_height,
       trader_pubkey, asset_input_outpoint,
       C_in_secp, receipt_scriptPubKey,
       excess,            // r_change - r_in (tick-independent)
       r_receipt,         // tick-independent
       K,                 // tick count ∈ {2, 4, 8, 16}
       ticks: [           // length K
           { delta_in, delta_out, C_change_secp, C_receipt_secp, bulletproof, intent_sig },
           ...
       ]
   }
   ```

2. **Settler assembly path** (relayed flow):
   - Fetch tick-fan from intent pool
   - Verify trader pool-state still matches (R_A_pre, R_B_pre)
   - Pick the tick whose delta_out is best given current reserves
   - Build Bitcoin tx with trader's input + settler funding + receipt vout + tip vout + OP_RETURN(envelope_hash)
   - Sign settler's BTC funding inputs (SIGHASH_ALL)
   - Broadcast

3. **Self-broadcast path**: trader signs + builds + broadcasts themselves. K=1 fan; no settler involved.

### Dapp tasks

File: `dapp/tacit.js`. **Market/trade UI specifics defer to
@thanksia per memory; this track focuses on the protocol-layer
envelope building.**

1. **Envelope builder** `buildSwapVarEnvelope(intent, openings)`:
   - Derive `r_receipt = HMAC(trader_privkey, "tacit-amm-swap-var-receipt-v1" || pool_id || asset_input_outpoint)` (tick-independent)
   - Derive `r_change = HMAC(trader_privkey, "tacit-amm-swap-var-change-v1" || pool_id || asset_input_outpoint)` (tick-independent)
   - For each tick k in fan:
     - Compute delta_out_k via curve
     - Build C_receipt_secp_k = delta_out_k · H + r_receipt · G
     - Build C_change_secp_k = (amount_in − tick_k − tip_amount) · H + r_change · G (or NO-CHANGE SENTINEL if full-input case)
     - Build m=2 bulletproof
     - Build intent_msg + intent_sig
   - Compute excess = r_change - r_in

2. **Tick schedule** (normative; matches amendment):
   ```js
   for (let k = 0; k < K; k++) {
       ticks[k] = Math.floor(delta_in_min * Math.pow(delta_in_max / delta_in_min, k / (K - 1)));
   }
   ```
   K ∈ {2, 4, 8, 16}; default 8.

3. **Self-broadcast assembly** (simpler path; K=1):
   Same builder but with K=1; trader signs all inputs SIGHASH_ALL and broadcasts.

### Tests

File: `tests/swap-var.test.mjs` (new)

Per the amendment's §"Test plan":
- Self-broadcast end-to-end on signet
- Relayed broadcast with tick-fan
- Multi-fill: 3 successive T_SWAP_VAR against same pool; verify k = R_A · R_B growth
- Reorg safety: induce 1-block reorg; verify rollback
- Stale reserves: broadcast with stale R_A_pre/R_B_pre; verify rejection
- Slippage: broadcast with min_out above curve output; verify rejection
- Range bounds: broadcast with delta_in > delta_in_max; verify rejection
- Receipt recovery: wipe wallet, restore from seed, verify receipt UTXO recovers
- Inflation attack defense: attempt to publish C_receipt with wrong value; verify validator rejection (r_receipt binding catches it)
- Cross-impl parity: dapp + worker produce byte-identical envelopes for same inputs

### Acceptance criteria

- [ ] All test items pass
- [ ] Cross-impl parity verified
- [ ] Signet rehearsal 7-day soak
- [ ] Independent crypto-review confirms r_receipt binding closes the inflation attack
- [ ] Production deployment

### Estimated effort: 3-4 weeks

Risk: medium. The receipt-binding logic (r_receipt opening check) is the only crypto-new piece since prior reviews; implement to spec carefully and validate against the test vectors.

---

## Track 5: `T_SWAP_BATCH` + LP ops implementation

**Goal**: deploy the full AMM trader surface (T_SWAP_BATCH +
T_LP_ADD + T_LP_REMOVE + T_PROTOCOL_FEE_CLAIM). **Gated on Track 3
ceremony completion** for the vk.

**Spec authority**: `AMM.md` (full architectural) + `SPEC.md`
§5.14-§5.18 (normative wire formats).

### Indexer tasks

File: `worker/src/index.js`

1. **Opcode dispatch branches** for 0x2D (T_LP_ADD), 0x2E (T_LP_REMOVE), 0x2F (T_SWAP_BATCH), 0x31 (T_PROTOCOL_FEE_CLAIM).

2. **T_LP_ADD validator**:
   - Verify two per-asset kernel sigs (asset A + asset B)
   - Verify Groth16 proof against pool's vk (note: same circuit, different proof per LP_ADD vs LP_REMOVE)
   - Pool state update: R_A += δa, R_B += δb, S += share_amount
   - MINIMUM_LIQUIDITY locked output handling (variant=1, POOL_INIT only)
   - Emit LP-share UTXO at lp_asset_id

3. **T_LP_REMOVE validator**: symmetric.

4. **T_SWAP_BATCH validator** (the heaviest):
   - Per-intent sigma cross-curve proof verification (N ≤ 16 traders)
   - Per-receipt sigma cross-curve proof verification
   - Groth16 batch proof verification against pool.vk
   - Deterministic clearing-solve recompute (Δa_net, Δb_net, P_clear); compare to envelope claims
   - Chain-side aggregate Pedersen check per asset (R_net_A, R_net_B)
   - Per-trader intent_sig verification
   - OP_RETURN(envelope_hash) binding check
   - Within-block ordering rule (tx_index ascending, then vin[0] outpoint)
   - Apply state: pool.R_A and pool.R_B advance; emit per-trader receipts; emit tip outputs

5. **T_PROTOCOL_FEE_CLAIM validator**:
   - Verify claim_sig under pool.protocol_fee_address pubkey
   - Crystallize protocol fee via lazy mintFee formula
   - Emit lp_asset_id UTXO to recipient

### Worker tasks

File: `worker/src/index.js`

1. **Per-pool state tracking**: maintain (R_A, R_B, S, k_last,
   protocol_fee_accrued, fee_bps) per pool_id. Read from chain on
   bootstrap; update on each confirmed AMM tx.

2. **Intent-pool relay** for T_SWAP_BATCH intents: traders POST,
   worker tracks per-pool open intents, exposes via WebSocket.

3. **Settler-side batch assembly**:
   - Pick N candidate traders from pool
   - Run deterministic clearing-solve (per AMM.md §4)
   - RTT 1: request per-trader opening blobs
   - Generate Groth16 proof using openings + public deltas + per-trader commits
   - Assemble envelope
   - RTT 2: collect per-trader sigs over envelope_hash
   - Splice sigs into final tx, broadcast

4. **Clearing-solve implementation** (per AMM.md §"4. Deterministic clearing-solve algorithm"):
   - `SOLVE_CLEARING(X, Y, R_A, R_B, fee_bps)`
   - Direction detection: lhs = X·R_B, rhs = Y·R_A
   - Binary search for Δa_net fixed point (64-iter cap)
   - u128 / u256 arithmetic per the normative width rule

### Dapp tasks

File: `dapp/tacit.js`. UI specifics defer to @thanksia.

1. **T_LP_ADD / T_LP_REMOVE envelope builder**:
   - Two per-asset kernel sigs
   - Sigma cross-curve proofs
   - Groth16 proof generation via snarkjs (in browser; ~5-10s wall-clock)
   - MINIMUM_LIQUIDITY burn-output construction at POOL_INIT

2. **T_SWAP_BATCH per-trader intent submission**:
   - Sign intent_msg
   - Open WebSocket to worker for the trader's session
   - Auto-sign RTT 1 opening blob (Service Worker)
   - Auto-sign RTT 2 envelope_hash (Service Worker; ~few seconds)

3. **Groth16 proof generation in browser** (settler path):
   - snarkjs verifier already exists in mixer code; reuse pattern
   - Witness generation from per-trader openings
   - Proof generation ~5-10s on modern laptop
   - Constraint budget verified (172K constraints; well within snarkjs capacity)

### Tests

File: `tests/amm-full.test.mjs` (new)

- POOL_INIT with MINIMUM_LIQUIDITY lock
- LP_ADD post-init; verify share mint
- LP_REMOVE proportional withdrawal
- T_SWAP_BATCH 2-trader batch (A→B + B→A, exact-cancel case)
- T_SWAP_BATCH N=16 batch with mixed directions
- Clearing-solve correctness vs reference implementation
- Reorg safety at depth ≥ 3
- Protocol-fee accrual + T_PROTOCOL_FEE_CLAIM
- Inclusion arbiter (if pool has one)
- Cross-impl parity for all opcodes

### Acceptance criteria

- [ ] All test items pass
- [ ] Cross-impl parity verified
- [ ] Signet rehearsal 30-day soak (longer due to AMM complexity)
- [ ] vk pinned correctly from Track 3 ceremony
- [ ] Production deployment

### Estimated effort: 6-8 weeks

Risk: high. The Groth16 + sigma + chain-aggregate stack is the
most complex part of V1. Front-load adversarial testing.

---

## Track 6: Channel UX (dapp state machine)

**Goal**: implement the `../../spec/design/CHANNEL-UX-DESIGN.md` state machine and
supporting infrastructure. **Market/trade UI specifics defer to
@thanksia** per memory; this track is the underlying state +
data + Service Worker plumbing that the trade UI consumes.

**Spec authority**: `../../spec/design/CHANNEL-UX-DESIGN.md` (full implementation reference).

### Dapp tasks

File: `dapp/tacit.js` (extract into module if it gets large)

1. **State machine** for intent lifecycle (9 states per ../../spec/design/CHANNEL-UX-DESIGN.md):
   ```js
   const IntentState = {
       COMPOSING, POSTED, ATTESTED, CROSS_CONFIRMED,
       AWAITING_SETTLEMENT, SETTLING, SETTLED,
       PARTIAL, FAILED, CANCELLED, EXPIRED, INCONSISTENT,
   };
   ```
   Transitions triggered by:
   - Worker WebSocket events
   - Chain block-source updates
   - User actions (cancel, settle-now)
   - Timeouts (expiry_height passed)

2. **Real-time data sources** (4 parallel subscriptions per ../../spec/design/CHANNEL-UX-DESIGN.md):
   - Worker WebSocket (intent-pool updates, settler activity)
   - Block source (Bitcoin RPC or block-explorer WS) for new blocks + mempool detection
   - Indexer query endpoint for attestation lookups (mesh phase 0)
   - Local Service Worker for background RTT signing

3. **Service Worker integration**:
   - Register SW in main bundle
   - SW responds to T_SWAP_BATCH RTT messages even when dapp tab backgrounded
   - SW signs using IndexedDB-stored keys (deterministically derived from seed; never crosses origins)
   - Auto-respond timeout: 5 seconds (matches `AMM_RTT_TIMEOUT_MS`)

4. **Cross-tab coordination** (BroadcastChannel):
   - One tab is "leader" for each `trader_pubkey`; other tabs defer
   - Prevents double-signing equivocation when user has multiple tabs

5. **Countdown logic** (per ../../spec/design/CHANNEL-UX-DESIGN.md):
   - EWMA over recent inter-block intervals
   - Display "Next batch settles in ~X min"
   - Update every second; recompute on each new block

6. **Cancel-by-CXFER**:
   - Build a self-CXFER of the trader's input UTXO
   - Sign + broadcast
   - Bitcoin-level invalidation of any pre-signed intent referencing that input

### Hand-off to @thanksia

The state machine produces a stream of state updates. The market/
trade UI is @thanksia's domain — they consume the state stream and
render the 9 UI states (composing, posted, attested, etc.) per
their design judgment.

Coordination point: agree on the state-update event shape:
```js
{
    intentId: '0xabc...',
    state: 'cross_confirmed',
    metadata: {
        scope_id, batch_composition, settlement_eta_ms,
        cross_check_results, ...
    },
}
```

### Tests

File: `tests/channel-ux.test.mjs` (new)

- State machine transitions: 9 states × valid transitions
- Service Worker auto-signs RTTs while tab is backgrounded
- Cross-tab BroadcastChannel leader-election works
- Cancel-by-CXFER invalidates pending intent at Bitcoin level
- Reconnect: WebSocket drops mid-RTT; recovers and re-delivers signing request

### Acceptance criteria

- [ ] All test items pass
- [ ] Integration with @thanksia's market/trade UI
- [ ] Service Worker reliability across major browsers (Chrome, Safari, Firefox)
- [ ] Cross-tab discipline prevents double-signing
- [ ] Cancel UX works in <2 seconds

### Estimated effort: 2 weeks (state + plumbing) + @thanksia's market/trade UI work (separate)

Risk: low for the state machine; medium for Service Worker reliability across browsers.

---

## Critical-path coordination

```
Day 0      Track 1: orderbook channel starts
Day 0      Track 2: mesh phase 0 starts
Day 0      Track 3: ceremony recruitment starts
Day 0      Track 4: T_SWAP_VAR starts (no ceremony dependency)
Day 0      Track 6: channel UX state machine starts

Day 7      Track 2: mesh phase 0 done
Day 14     Track 1: orderbook channel done; merge → mainnet candidate
Day 14     Track 6: state machine done; hand off to @thanksia
Day 14-28  Track 4: T_SWAP_VAR done; signet rehearsal

Day 42-56  Track 3: ceremony complete; vk pinned
Day 42     Track 5: T_SWAP_BATCH impl starts (uses ceremony vk)

Day 100    Track 5: T_SWAP_BATCH + LP ops complete
Day 100    V1 LAUNCH: full surface (orderbook + AMM + channel + mesh)
```

Total: ~100 days (~3 months) calendar time on the critical path.

## Cross-track coordination notes

- **Track 1 → Track 6**: the channel state machine consumes Track
  1's WebSocket events. Define the event shapes early so Track 6
  can develop against mocks.

- **Track 2 → Track 6**: mesh phase 0 results feed into Track 6's
  `CROSS_CONFIRMED / WEAK_CONFIRMATION / INCONSISTENT` state.
  Coordinate the result-object schema.

- **Track 4 ↔ Track 5**: T_SWAP_VAR and T_SWAP_BATCH share pool
  state. Indexer code must handle both opcodes touching the same
  pool in the same block (within-block ordering rule per AMM.md).

- **Track 3 → Track 5**: T_SWAP_BATCH cannot deploy without
  Track 3's vk. Plan Track 5's implementation timeline to land
  ~2 weeks after Track 3 finalizes.

- **Track 6 → all**: channel UX is the user's window into all
  other tracks. Get it stable early so trader experience is
  consistent.

---

## Definition of done for V1 launch

- [ ] All 6 tracks signed off
- [ ] Mainnet deployment plan executed (separate runbook)
- [ ] Worker + indexer monitoring live (uptime, equivocation alerts, etc.)
- [ ] Dapp deployed (incl. @thanksia's market/trade UI changes)
- [ ] Documentation published (user-facing channel docs + dev docs)
- [ ] Independent crypto review confirmation on T_SWAP_VAR + chain-aggregate logic

---

## What I (the spec) can keep producing while engineering proceeds

- Cross-impl test vectors (canonical envelopes for parity testing)
- Ceremony coordination runbook (Track 3 detailed steps)
- Indexer reference pseudocode (for tracks 1, 4, 5)
- Deployment runbook (for launch day)
- Spec patches if engineering identifies edge cases needing clarification

Engineers should reference this roadmap for what-to-build; consult
the spec files for correctness arguments. If the two diverge,
spec is authoritative — this doc is a translation, not a
re-specification.

---

## Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Groth16 prover too slow in browser | Low | Already verified 172K constraints fits snarkjs; pre-launch benchmark on typical laptop hardware |
| Ceremony participant dropout | Medium | Recruit N+2 for buffer; Bitcoin-block beacon mitigates partial-contribution risk |
| Cross-impl parity bugs surfacing late | High | Front-load shared test vectors from spec; CI runs parity checks every commit |
| Service Worker unreliable across browsers | Medium | Fallback to foreground signing if SW kills; clear UX about "keep tab open" |
| Indexer state-machine bugs | High | Extensive signet adversarial testing; replay historical txs at each indexer version |
| Equivocation false positives | Low | Idempotent same-hash acceptance; clear UX for "your worker is flagged, switch to another" |

---

End of roadmap. Engineers: pick a track, read its section, start
shipping.
