# Production relay backbone — making the prover box unattended

The reflection/settle backbone is already the right shape: a **control plane** (the
Cloudflare Worker, `worker/`) that never proves and never holds funds, plus a
**data plane** (a self-hosted GPU box, outbound-only behind NAT) running the poll
loops in `ops/scripts/`. The worker only queues opaque witnesses in KV and relays
proofs the contract independently verifies against its pinned vkeys.

Nothing here needs new architecture. What stands between "works when hand-run" and
"works unattended" is that the box today is an ephemeral pod (dies on credit runout
/ preemption, loses its local ELFs + built provers) and nothing watches its health.
This runbook is the checklist to close that.

## What already exists (do not rebuild)

Control plane — `worker/src/index.js`:
- Cron `*/5 * * * *`: scans Bitcoin (signet + mainnet) for envelopes, advances the indexer.
- `/reflection/job` → assembles the next batch (streaming assembler, bounded memory),
  stashes `newSnapshot` in KV keyed by jobId. `/reflection/ack` advances the
  un-rewindable attested cursor. `/reflection/ethbundle` stores the Mode-B eth bundle.
- `/confidential/submit` (permissionless, capped queue) → `/confidential/job` →
  `/confidential/ack`: the settle relay for user ops (transfer/swap/route/lp).
- `/prover-heartbeat` (box POSTs every ~2m) and `/prover-health` (GET; stale >10m ⇒ down).

Data plane — `ops/scripts/`:
- `reflection-relay-loop.sh` — poll `/reflection/job` → GPU groth16 → `attestBitcoinStateProven`
  (RELAY_KEY) → `/reflection/ack`. Idempotent: re-reads `knownReflectionDigest`, re-acks a
  lost ack, never double-attests (digest chain reverts a re-submit).
- `confidential-settle-loop.sh` — poll `/confidential/job` → prove settle guest → `settle(pv,proof,memos)` → ack.
- `modeb-prover-loop.sh` — reverse bridge (CrossOutRecorded → eth-reflection fold), emits heartbeat.

## The gap → the plan

### P0 — Box durability + supervision (this is what bit us this weekend)
The loops are `while true`, but nothing restarts them on crash, OOM, or box reboot,
and a pod that evaporates takes its built provers with it.

1. **Persistent host.** Move off preemptible/credit-metered pods to a host that does not
   evaporate: a reserved GPU instance, or (cheaper) a CPU host that offloads groth16 to the
   **network prover** (Succinct) — the same `.network()` path already used for
   bitcoin_prove/eth_prove. Network-prover means the box needs no local GPU/gpu-server at all,
   only the ELFs + a funded prover key; that removes the single most fragile dependency.
2. **systemd units, `Restart=always`.** One unit per loop (`tacit-reflection`, `tacit-settle`,
   `tacit-modeb`), `RestartSec=15`, `WantedBy=multi-user.target` so they come back on reboot.
   `EnvironmentFile=/etc/tacit/relay.env` holds WORKER_BASE, POOL_ADDR, RPC_URL, RELAY_KEY,
   box token. Loops already log to stdout → `journalctl` captures it.
3. **Provers + ELFs on persistent disk, checked at boot.** Keep the built `bitcoin_prove` /
   `eth_prove` / settle `exec` + the pinned ELFs on a non-ephemeral volume with sha256 pins;
   a pre-start check aborts loudly if an ELF sha drifts from the deployed vkey (the loops
   already assert vkey match before spending a prove).

### P1 — Someone gets paged
`/prover-health` exists but nothing consumes it.

4. **External uptime monitor** on `GET {WORKER_BASE}/prover-health` (any of UptimeRobot /
   Betterstack / a 1-min cron). Alert when `healthy:false` — the endpoint already reports
   `no heartbeat for Nm` and lag fields. This is the "box died" pager.
5. **RELAY_KEY balance alert.** attest + settle pay gas from RELAY_KEY. A cheap watcher
   (worker cron or the health monitor) that flags balance < N reverts-worth of gas. An
   unfunded relay key silently stalls every cross-lane gate.

### P2 — Queue can't wedge
Single-prover FIFO is fine at launch volume, but a stuck job blocks everyone.

6. **Per-job timeout / dead-letter.** If a `/confidential/job` is claimed but not acked within
   T minutes, requeue or park it so one poison witness can't starve the queue. `/confidential/submit`
   is already rate-capped; add the claim-side timeout.
7. **Fee gate on relayed settles** (the `feeGate` hook already stubbed in `confidential-settle.js`)
   so relaying stays profitable / spam-resistant when it's paying gas.

### P3 — Cross-lane ordering discipline (codify what we did by hand)
The forward reflection loop and any crossOut share the `crossOutCount` pin; interleaving them
wrong is exactly the manual fragility we hit.

8. **Single writer for the reflection cursor.** Only `reflection-relay-loop.sh` advances the
   attested cursor; crossOut minting waits behind the reflection fold (a note is
   `pending-reflection` until folded — the worker is indexer-only, never authoritative).
9. **Don't advance the relay past an un-attested crossOut's maturity window.** The maturity gate
   (`_anchorReflection`) already fails closed; the discipline is operational — the modeb loop
   should attest a folded crossOut before the header relay walks past its window. Encode as a
   guard in the loop, not just a runbook line.

## Acceptance test (unattended for 48h)
- Kill the box mid-prove → systemd restarts the loop → it re-fetches the same job and completes
  (idempotency proven).
- Reboot the host → all three units come back, ELFs pass the sha check, loops resume from KV cursor.
- Drain RELAY_KEY below threshold → alert fires before the queue stalls.
- Reflection stays current (no growing gap between chain tip and attested cursor) across the window.

## Notes
- Snapshot/resume + streaming assembler already landed (bounded-memory catch-up), so even after
  downtime the box only re-folds the small gap since the last snapshot, not from genesis.
- The worker is stateless-relay by design: losing it loses no funds and no authority; a fresh
  deploy re-reads KV and resumes. All safety lives in the contract's vkey verification.
