// Is the reflection lane stalled? Two signals a lost ack produces and the block-lag alert does not name.
//
//   stall  no successful attest for `stallHours` while Bitcoin has un-attested blocks in range. An idle lane
//          (nothing left to attest) is healthy however long ago it last attested.
//   drift  the API's cursor digest differs from the pool's on-chain digest on two consecutive runs. One run is
//          the ordinary window between an attest landing and its ack, so it only counts when it persists.
//
//   -> { level: 'ok' | 'critical' | 'unknown', reason }

export function stallVerdict({ attestedHeight, tipHeight, lastAckAt, now, stallHours }) {
  if (!Number.isFinite(attestedHeight) || !Number.isFinite(tipHeight)) return { level: 'unknown', reason: 'cursor heights unavailable' };
  if (tipHeight <= attestedHeight) return { level: 'ok', reason: 'nothing to attest' };
  if (!Number.isFinite(lastAckAt)) return { level: 'unknown', reason: 'no last-ack time recorded' };
  const hours = (now - lastAckAt) / 3_600_000;
  if (hours > stallHours) {
    return { level: 'critical', reason: `no successful attest for ${hours.toFixed(1)}h (> ${stallHours}h) while blocks ${attestedHeight + 1}..${tipHeight} wait to be attested` };
  }
  return { level: 'ok', reason: `last attest ${hours.toFixed(1)}h ago` };
}

export const DRIFT_RUNS_TO_ALERT = 2;

export function driftVerdict({ cursorDigest, onchainDigest, streak }) {
  if (!cursorDigest || !onchainDigest) return { level: 'unknown', drifting: false, reason: 'digest unavailable' };
  if (String(cursorDigest).toLowerCase() === String(onchainDigest).toLowerCase()) return { level: 'ok', drifting: false, reason: 'cursor matches the pool' };
  if (streak >= DRIFT_RUNS_TO_ALERT) {
    return { level: 'critical', drifting: true, reason: `cursor digest ${cursorDigest} != pool digest ${onchainDigest} on ${streak} consecutive runs — an attest landed without its ack, so every new batch is built on a stale prior` };
  }
  return { level: 'ok', drifting: true, reason: `cursor digest differs from the pool (${streak} of ${DRIFT_RUNS_TO_ALERT} runs)` };
}
