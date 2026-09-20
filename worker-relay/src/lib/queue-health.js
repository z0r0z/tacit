// Is the settle queue healthy? Pure, so the thresholds can be tested with real numbers.
//
// A relayed job should be picked up within seconds and settled within a couple of minutes (proving ~1 min, then
// inclusion). An empty queue says nothing — the relay may simply be idle — but a queue whose OLDEST pending job
// keeps aging is the signature of a settle service that is down or hung, and every second of it is a user waiting.
//
//   -> { level: 'ok' | 'warning' | 'critical', reason }
export function queueVerdict(stats, { pendingWarnSec, pendingCriticalSec, provingStuckSec }) {
  if (!stats || !Number.isFinite(stats.oldestPendingSec)) return { level: 'unknown', reason: 'no queue stats' };
  if (stats.oldestPendingSec >= pendingCriticalSec) {
    return { level: 'critical', reason: `${stats.pending} job(s) waiting, the oldest for ${stats.oldestPendingSec}s (>= ${pendingCriticalSec}s) — the settle service looks down or stuck` };
  }
  if (stats.oldestProvingSec >= provingStuckSec) {
    return { level: 'warning', reason: `a job has been "proving" for ${stats.oldestProvingSec}s (>= ${provingStuckSec}s) — past the prove timeout; it will be re-queued but is worth a look` };
  }
  if (stats.oldestPendingSec >= pendingWarnSec) {
    return { level: 'warning', reason: `${stats.pending} job(s) waiting, the oldest for ${stats.oldestPendingSec}s (>= ${pendingWarnSec}s)` };
  }
  return { level: 'ok', reason: `${stats.pending} pending, ${stats.proving} proving` };
}
