# Reorg validation — cBTC.zk slot ops

## What this covers

SPEC §5.10 mandates that mixer-pool state changes (leaves, nullifiers,
pool-init records) are reverted-or-kept atomically with Bitcoin's
3-confirmation reorg window. cBTC.zk slot ops inherit this gate via the
mixer-pool primitive: slot mint / rotate / split / merge all write to the
same `poolLeafKeyFor` / `poolNullifierKey` KV namespaces and therefore
the same depth gate applies.

## Implementation strategy — read-time annotation, not write-time rollback

The worker's cron writes to KV optimistically (records land in storage at
first observation, regardless of depth). Correctness is enforced at
**read time** via the `_annotateLeaves` and `_annotateNullifiers` helpers
in the `/pools/:aid/:denom` handler: each record is stamped with a
computed `depth` field and a `status` of `'included'` (depth ≥ 3),
`'pending'` (depth < 3 with explorer tip), or `'unknown_depth'`
(explorer tip unavailable).

The dapp's `scanPools` filters `status === 'included'` for both leaves
and nullifiers before mutating the local merkle tree / spent-set. An
orphaned record that reorgs out before reaching depth 3 stays as
`'pending'` in worker KV indefinitely (the tx no longer exists, so the
height-pin / depth-pin computation surfaces `'pending'` forever) and is
never applied to the dapp's view.

## Why we don't engineer a synthetic signet reorg test pre-launch

Bitcoin reorgs are non-deterministic. Signet has them but they aren't on
demand — observing one against a specific test slot mint would require
either luck or a regtest setup, neither of which gives a tight CI signal.
The structural defense (depth gate) is unit-tested from the dapp side
(`tests/mixer-nullifier-depth-gate.test.mjs` — 6/6 covering pending /
included / reorg-out / promotion transitions), which is the layer that
matters for protocol correctness.

## Post-launch monitoring

Two signals to watch in prod:

1. **Cron-error Analytics Engine index** — the worker emits a datapoint
   at `cron:scanForEtches:<network>` whenever `scanForEtches` throws.
   Query for non-zero counts; investigate immediately. This was added
   after the signet cron freeze incident; documented at
   `memory/project_signet_cron_freeze.md`.

2. **Leaf-status accumulation** — query `/pools/:aid/:denom` for the
   `pending_leaf_count` field. Persistent non-zero pending counts hours
   after a confirmed slot mint indicate either ongoing reorg activity OR
   a stale orphan that's never going to clear. Acceptable up to ~10
   pending leaves on a busy pool; sustained > 50 is a signal to inspect.

## Cleanup of stale entries — deferred

The worker has no explicit cron job to drop orphaned pending entries
from KV. Storage accumulates over time. Not a correctness or safety
issue (depth gate excludes them from any state computation) but an
operational cost concern. Estimate: ~50 bytes per leaf × low-double-
digit orphan rate per network per year. Cleanup task is a v1.x optimization,
not a pre-launch blocker.

## Production red flags vs OK signals

| Signal | What it means | Action |
|---|---|---|
| `cron:scanForEtches:<net>` Analytics datapoint | Cron is throwing for that network | Inspect; manual `/scan` unstick if needed (memory: `project_signet_cron_freeze`) |
| Leaf at depth ≥ 3 but `status === 'pending'` | Worker's tip-fetch is timing out | Transient; will self-correct when explorer recovers |
| Leaf at `status === 'unknown_depth'` for hours | Worker's tip-fetch consistently failing | Investigate explorer health |
| Pending leaf count grows unbounded | Stale orphans accumulating | Cleanup job (deferred) or manual KV prune |
| Dapp users report "burn fails: leaf not in local tree" | Either user is on stale worker view OR a real index gap | Check `last_scanned` vs tip; check the slot's confirmation depth |

## Related

- `MIXER.md` § Status — see the reorg-safety bullet (covers leaves + nullifiers)
- `tests/mixer-nullifier-depth-gate.test.mjs` — depth-gate behavior pinned
- `tests/cbtc-zk-slot-lifecycle-signet.mjs` — live e2e at the user-facing layer
- SPEC §5.10 — normative depth-gate spec
- `worker/src/index.js:_logCronError` — the silent-failure observability fix
