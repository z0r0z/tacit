# Tacit V1 — Launch Deployment Runbook

> Status: 🛠️ Operational reference for V1 mainnet launch day(s).
>
> Scope: ties the 6 implementation tracks + ceremony into a
> coordinated rollout. Covers pre-launch verification, launch-day
> sequencing, monitoring, and rollback procedures.
>
> Prerequisites (from other docs):
> - All 6 tracks signed off per `../planning/IMPLEMENTATION-ROADMAP.md`
> - AMM Phase 2 ceremony complete per `AMM-CEREMONY-RUNBOOK.md`
> - 30-day signet soak completed for full V1 surface
>
> Audience: launch coordinator + on-call engineers during launch.

---

## Launch architecture (what's actually being deployed)

V1 launch isn't a single Bitcoin tx — it's a coordinated rollout
of:

1. **New indexer software** (worker code with full V1 dispatch:
   T_INTENT_ATTEST, T_SWAP_BATCH, T_SWAP_VAR, T_LP_ADD/REMOVE,
   T_PROTOCOL_FEE_CLAIM). Backwards compatible: indexes existing
   chain history correctly; adds new dispatch for new envelopes.

2. **New worker software** (intent pool tracking for AMM scopes,
   batch assembly, T_INTENT_ATTEST broadcast scheduler). Live
   service; rolling deploy possible.

3. **New dapp release** (channel UX state machine, AMM trader
   surface, LP UX, mesh phase 0 cross-validation, Service Worker
   for background signing). Static asset deploy; users get the
   new UI on next page load.

4. **First on-chain envelopes** (POOL_INIT for canonical pools,
   first T_INTENT_ATTEST broadcasts).

5. **Public announcements** (ceremony bundle CID, opcode list,
   trusted-worker set, etc.).

Nothing requires Bitcoin consensus changes. Everything is opcode
additions readable by upgraded indexers + ignored as
unknown-opcode by un-upgraded ones.

---

## T-30 days: pre-launch verification

A month before target launch date.

### Engineering tracks status

- [ ] Track 1 (orderbook channel): deployed to mainnet for ≥ 2
      weeks; equivocation alerts wired up; cross-worker test
      across ≥ 3 production workers passes
- [ ] Track 2 (mesh phase 0): integrated into dapp; UI states
      surface correctly across all 4 status conditions
      (confirmed, weak, inconsistent, missing)
- [ ] Track 3 (ceremony): complete; bundle CID hardcoded in dapp +
      worker; verification script in bundle reproduces vk
- [ ] Track 4 (T_SWAP_VAR): signet soak ≥ 14 days complete;
      cross-impl parity verified; receipt-binding inflation
      defense audited
- [ ] Track 5 (T_SWAP_BATCH + LP ops): signet soak ≥ 30 days
      complete; Groth16 proof generation + verification stable
      across browser hardware
- [ ] Track 6 (channel UX): state machine handles all 9 states
      correctly; Service Worker reliable across Chrome / Firefox
      / Safari; cross-tab discipline tested

### Cross-impl parity

- [ ] Dapp + worker produce byte-identical envelopes for 20+
      canonical test vectors per opcode
- [ ] Indexer accept/reject decisions identical across dapp +
      worker for adversarial inputs
- [ ] At least one independent third-party indexer
      implementation (Rust / Go / Python) running against the
      same Bitcoin chain produces identical KV state

### Spec freeze

- [ ] All amendment files marked at their final round-N
- [ ] No outstanding P0 / P1 spec changes
- [ ] SPEC.md preamble accurately lists active opcodes
- [ ] `AMENDMENTS.md` changelog reflects all changes since last
      release

### Operational readiness

- [ ] Monitoring dashboards live (per the "Monitoring" section
      below)
- [ ] On-call rotation scheduled across launch week
- [ ] Communication channels prepared (status page, social
      announcements, support email)
- [ ] Trusted-worker set finalized + announced (default 3 workers
      shipped in dapp config)
- [ ] Indexer KV state backups verified (can restore from
      snapshot in < 1 hour if needed)

### Public communication

- [ ] Ceremony announcement published (≥ 2 weeks before launch)
- [ ] Documentation site updated (user-facing channel docs +
      developer docs)
- [ ] Tacit community notified of launch date
- [ ] @thanksia's market/trade UI changes coordinated with launch
      timing

---

## T-7 days: dress rehearsal

One week before target launch.

### Full dry-run on signet

Execute the entire launch sequence on signet:

1. Indexer rolls out new code (rolling deploy)
2. Worker rolls out new code (rolling deploy)
3. Dapp deployment to staging
4. Test trader: post intent → soft-confirm → settlement → verify
5. Test LP: deposit → withdraw → verify shares + reserves
6. Test arbitrageur: cross-surface trade → verify atomicity
   (if T_TRADE_BATCH impl shipped)
7. Test edge cases: equivocation, expiry, reorg, partial fill
8. Test monitoring: trigger each alert + verify on-call response

### Sign-off

- [ ] Dress rehearsal completed without unexpected issues
- [ ] All alerts fired correctly during induced failures
- [ ] On-call engineers practiced rollback procedures
- [ ] Coordinator sign-off on the launch sequence

---

## T-1 day: final checks

Day before target launch.

- [ ] Final indexer state snapshot taken
- [ ] Worker state backed up
- [ ] Bitcoin node + block-source endpoints verified live
- [ ] All team members confirmed available for launch window
- [ ] Communication templates pre-written (success, partial,
      rollback)
- [ ] Emergency contact list distributed
- [ ] Status page set to "Maintenance: V1 launch in progress
      (start time TBD ±1 hour)"

---

## T-0 (launch day) sequence

### Step 1: Indexer rollout (T+0:00 to T+1:00)

Roll out new indexer software in this order:

1. **Internal indexer first** (the worker's indexer dispatch).
   Rolling deploy across instances. Verify it picks up the AMM
   opcodes correctly when test envelopes are broadcast to a
   testnet pool.

2. **Public indexer endpoints** updated. Anyone running their
   own indexer can update at their pace; the protocol doesn't
   require coordinated indexer upgrades because of the
   purely-additive design.

3. **Verify indexer parity**: query `/v1/state-hash` (or
   equivalent) on multiple indexer instances; confirm they
   produce identical state hashes from the same chain history.

If parity breaks: stop launch, investigate, do not proceed to
worker rollout.

### Step 2: Worker rollout (T+1:00 to T+2:00)

Roll out worker software:

1. Update worker code to include AMM intent-pool tracking +
   T_INTENT_ATTEST broadcast scheduler for both orderbook + AMM
   scopes.

2. Verify worker is signing T_INTENT_ATTEST envelopes for the
   new AMM scopes (initially empty pools).

3. Verify worker's intent-pool relay accepts AMM intents (post a
   test intent; confirm acceptance + attestation broadcast on
   chain).

4. Verify cross-worker connectivity: if you operate ≥ 2 workers,
   confirm they can attest to the same scope at the same height
   with their respective pubkeys without flagging each other.

### Step 3: Dapp deployment (T+2:00 to T+2:30)

Deploy new dapp release:

1. Deploy static assets to CDN.
2. Verify Service Worker registers correctly on first page load.
3. Verify cross-tab BroadcastChannel coordination works.
4. Verify channel UX state machine renders correctly for a
   test intent.

5. **Update the dapp's hardcoded constants** (these are
   load-bearing):
   - `AMM_CEREMONY_CID` — pinned ceremony bundle CID from Track 3
   - `AMM_VK_CID` — vk.json CID specifically
   - Trusted-worker set (default 3 worker pubkeys)
   - Block-source endpoints

### Step 4: First AMM pool POOL_INIT (T+2:30 to T+3:00)

Optional but recommended: launch with at least one canonical AMM
pool already initialized. Pick the most-anticipated pair (e.g.,
TAC / cBTC).

1. POOL_INIT envelope built with:
   - `asset_A` / `asset_B` (canonical-ordered)
   - `fee_bps = 30` (recommended default)
   - `vk_cid` = AMM_VK_CID from ceremony
   - `ceremony_cid` = AMM_CEREMONY_CID
   - `min_liquidity = 1000` (MINIMUM_LIQUIDITY default)
   - Initial reserves (seed by deployer)
   - MINIMUM_LIQUIDITY burn output construction per AMM.md §"MINIMUM_LIQUIDITY burn-output construction"

2. Broadcast POOL_INIT.

3. Verify indexer accepts and registers the pool.

4. Verify dapp displays the new pool's spot price + depth.

### Step 5: First T_INTENT_ATTEST for AMM scope (T+3:00 to T+3:30)

Worker broadcasts the first T_INTENT_ATTEST for the new AMM
pool's scope (initially empty pool → `intent_pool_hash =
SHA256("")`, `intent_count = 0`).

This is the symbolic moment: AMM channel is now live for that
pool.

### Step 6: Public announcement (T+3:30)

Once all above checks pass, announce launch via:
- Status page: "V1 launch complete — full surface live"
- Social channels
- Documentation site updates
- Notify ecosystem partners

### Step 7: First-trader test (T+3:30 onwards)

A coordinator-affiliated trader posts the first real-money AMM
intent (small amount, ~$10 equivalent). End-to-end flow:

1. Trader posts T_SWAP_VAR intent via dapp
2. Trader sees "soft-confirmed" (~30s after worker attestation)
3. Trader sees "cross-confirmed" across ≥ 2 workers (mesh phase 0)
4. Settler broadcasts T_SWAP_VAR tx (within ~10 min)
5. Trader sees "settling" → "settled (depth 1)" → "settled (final, depth 3)"
6. Trader's receipt UTXO visible in their wallet, opens correctly

If the end-to-end flow works for the first trader: launch is
successful. Open to public traders.

---

## Monitoring during + after launch

### Indexer health

- KV state hash consistency across indexer instances
- Per-opcode validator success rate (look for unusual
  rejection spikes)
- Reorg events at depth < 3 (rare; alert if frequency > 1/day)
- Bitcoin chain catch-up lag (alert if > 6 blocks behind)

### Worker health

- T_INTENT_ATTEST broadcast cadence (per scope, per worker)
- Intent-pool acceptance rate
- WebSocket connection count + churn
- Equivocation flag-set state (any worker flagged → page on-call)

### AMM pool health

- Pool reserves drift vs expected (compare to pre-launch baseline)
- LP-share supply growth (track in conjunction with reserves)
- Protocol fee accrual rate
- T_SWAP_BATCH proof verification success rate (should be ≈ 100%)
- T_SWAP_VAR settlement success rate
- Settler activity (which entities are bundling batches)

### Channel layer health

- T_INTENT_ATTEST broadcast frequency per scope
- Cross-worker agreement rate (should be ≈ 100% in steady state)
- Mesh phase 0 verification success rate from dapp telemetry
- Soft-confirm latency (intent post → soft-confirmed)

### Dapp telemetry

- State machine transition rates (look for stuck states)
- Service Worker reliability (% of RTT signatures completed)
- Cross-tab coordination effectiveness
- Cancel-by-CXFER rate

### Alert thresholds

| Metric | Warning | Page |
|---|---|---|
| Indexer state-hash mismatch | Any | Any |
| Worker equivocation flag | Any | Any |
| Reorg at depth < 3 | 1/week | 1/day |
| AMM proof verification failure rate | > 0.1% | > 1% |
| T_SWAP_BATCH 2-RTT timeout rate | > 5% | > 20% |
| Settler activity drop | < expected baseline | < 10% baseline |
| Dapp Service Worker failure | > 5% | > 20% |

---

## Rollback procedures

### If indexer-level bug is discovered

1. Pause new envelope broadcasts (worker stops T_INTENT_ATTEST
   cadence)
2. Investigate; produce a patch
3. Deploy patch to indexer; verify state-hash consistency restored
4. Resume worker activity

Indexer state can be re-derived from chain history, so
"rollback" is really "fix the bug and re-scan."

### If worker-level bug is discovered

Rolling deploy of fix; if worker is producing bad attestations,
it gets flagged + dapp users switch to alternate workers. No
chain-level rollback needed.

### If dapp bug is discovered

CDN rollback to prior dapp version. Service Worker may persist
old code briefly; users can hard-refresh or wait for SW update
cycle.

### If AMM proof verification fails (catastrophic; ceremony bug or circuit bug)

1. **Stop**. Do not broadcast more T_SWAP_BATCH.
2. Investigate the failed proof. Specifically:
   - Was the proof generated correctly?
   - Was the vk loaded correctly?
   - Does the public-input vector match the circuit's expectations?
3. If the issue is in dapp / worker code: patch + redeploy.
4. **If the issue is in the circuit or ceremony**: catastrophic.
   The vk is permanent; a new circuit requires a new ceremony.
   In the worst case, this means freezing T_SWAP_BATCH pools and
   announcing a V2 ceremony. Mitigation: pre-launch testing
   should make this scenario vanishingly rare.

### If a malicious settler is detected

The protocol's permissionless settler model means anyone can
broadcast batches. If a settler is observed misbehaving (e.g.,
constructing batches that include traders' intents on terms
worse than min_out — these would be rejected by the indexer
anyway), the dapp can:

1. Add the settler's pubkey to a local-policy untrusted-set
2. Surface a UI warning when traders interact with batches
   bundled by that settler
3. Refuse to deliver opening blobs to that settler in RTT 1

These are dapp-side policy choices, not protocol-level.

---

## Post-launch (T+7 days)

### Soak observations

- [ ] No state-hash divergence across indexer instances
- [ ] No catastrophic alerts triggered
- [ ] Steady-state worker + dapp behavior matches signet
      observations
- [ ] Trader UX feedback collected (specifically channel-layer
      soft-confirm clarity, RTT signing reliability)

### Adjustments

Common post-launch adjustments (none of these require protocol
changes):

- Tune `AMM_RTT_TIMEOUT_MS` if 2-RTT failure rate is higher than
  expected
- Adjust attestation cadence per scope based on actual intent
  flow
- Update trusted-worker set based on observed reliability
- Add/remove pools based on demand

### Public retrospective

Within 30 days, publish:
- Launch metrics (total trades, unique traders, total volume)
- Operational incidents (if any) + root-cause analysis
- Performance numbers (proof gen time, settlement latency,
  channel cross-confirm latency)
- Next-quarter roadmap (T_TRADE_BATCH impl if demand justifies,
  cBTC / cUSD canonical wrappers per CDP amendment)

---

## Definition of "launched"

V1 is "launched" when:

- [ ] All 7 launch-day steps completed without rollback
- [ ] First non-coordinator trader completes a full trade cycle
- [ ] First non-coordinator LP completes deposit + withdraw cycle
- [ ] Channel layer cross-confirms across ≥ 3 production workers
- [ ] AMM pools accumulate ≥ 100 trades in the first week
- [ ] No critical alerts triggered during launch week
- [ ] Documentation site reflects launched state (not "coming
      soon" anywhere)

When all checked: V1 is in production. Update SPEC.md preamble
status from "Phase 2 trusted setup pending" to reflect launched
state.

---

End of runbook. Next operational doc: post-launch operations
guide (separate document covering steady-state ops, settler
economics, ecosystem growth).
