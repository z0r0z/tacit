# Tiered prover — network default · cold-box failover · user-local (private)

Goal: confidential ops prove on Succinct's **hosted network** by default (no infra), fail over to a **cold
standby box** if the network degrades, and defer to a **user's own prover** when they opt in (fee-free +
private). One `prove(op) → { publicValues, proof }` abstraction; backends are priority-ordered.

## Backends
| Tier | Backend | Binary | Cost | Notes |
|---|---|---|---|---|
| 1 default | Succinct hosted network (`rpc.production.succinct.xyz`) | **network** exec-* (`.network()`) | PROVE per op | no box; what the Render worker runs |
| 2 failover | cold standby GPU box | **local** exec-* (`.cpu()`/`.cuda()`, the original "box" binaries) | ~cents/day idle + GPU-hrs only when active | self-contained; no PROVE spend (own GPU) |
| 3 user | user's local prover daemon | same local exec-* (packaged) | free to protocol | witness never leaves user machine → private |

Key: Tier 2 **reuses the original box binaries** (the `.cpu()`/`native-gnark` ones) — no new build. The
network rebuild is only for Tier 1.

## Priority
`user-local (if daemon detected) → network → cold-box (on network failure)`. A user who opts in is never
silently downgraded to the relay.

## The one hook: `preproven` jobs
The relay must accept a job that already carries a proof: `{ type, op, publicValues, proof, mode: 'preproven' }`
→ it skips proving and just calls `settle()` (gasless for the user). This single hook enables **both** Tier 3
(user hands the relay a proof) **and** a clean Tier 2 (box proves, hands the relay a proof). Bake it into the
job schema now — `settle-relay` branches: `mode==='preproven' ? settle(job.publicValues, job.proof) : proveSettle(...)`.

## Cold-box mechanics (cents/day)
- RunPod **stopped** pod bills only volume storage (~$0.14/day for 20GB); GPU bills only while running.
- Pre-load: the local exec-* binaries + `elf/cxfer-guest` + cached gnark circuit artifacts.
- **Wake:** `prover.js` failover calls `runpodctl start <pod>` on N consecutive network failures → waits for
  the box to register its endpoint (writes to a KV/health the worker polls) → routes proving there.
- **Sleep:** a watchdog `runpodctl stop <pod>` after M minutes idle / once the network health probe recovers.
- **Credit:** keep a small RunPod balance (box GPU-hrs during outages) + Succinct PROVE balance (default path).
  Two independent, cheap buffers.

## Failover trigger (in prover.js)
```
proveWithFailover(job):
  if userLocalPresent(): return proveViaLocal(job)          // Tier 3, if user opted in
  try: return proveViaNetwork(job)                            // Tier 1 default
  catch after K retries / Unimplemented / timeout:
     wakeBox(); await boxReady()
     mark job status 'degraded: backup prover'                // honest UI signal
     return proveViaBox(job)                                  // Tier 2
```
Network-health probe (separate cron): periodic tiny prove/ping; if healthy again → stop the box, clear degraded.

## User-local (Tier 3) — packaging
- Ship the local exec-* as a small daemon/Docker (`native-gnark` variant proves OP_WRAP ~42s on 6 CPU cores).
- Dapp probes `localhost:<port>/prove`; if up, routes the op there; the user's witness never leaves the box.
- The daemon returns `{ publicValues, proof }`; dapp submits a `preproven` job → relay settles gasless.
- Privacy win: today the relay sees the op witness (cleartext amounts) to prove it; self-proving removes that.

## Rollout order
1. Land Tier 1 (network rebuild) — the unlock. (build-all-network.sh)
2. Add the `preproven` branch to settle-relay + the `prove(op)` abstraction shell.
3. Tier 2: cold-box + wake/sleep watchdog + failover in proveWithFailover.
4. Tier 3: package the local daemon + dapp detection.

See [[project_confidential_prover_cpu_blocker]].
