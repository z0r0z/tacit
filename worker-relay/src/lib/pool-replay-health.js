// The Bitcoin pool's replay service (tacit-btc-pool-mainnet, GET /btc-pool/status). Wallets read their notes, roots and
// paths from it and spend only while it runs: when it cannot read a transaction it needs (a source limiting it, or down) or
// its proof verifier is missing, it stops at that block and every shield, send and withdraw answers "the pool replay is
// paused". Nothing is lost, but nobody can move anything until it is running again.
//
// → { level: 'ok' | 'warning' | 'critical' | 'unknown', lag, why }
// `lag` is the blocks the replay still owes: the tip less the confirmations it waits for, less where it is. A replay
// that is halted but a block or two behind is catching its breath (it retries); one that stays behind is stuck.

export function poolReplayVerdict(status, { warn = 3, critical = 12 } = {}) {
  if (!status || typeof status !== 'object') return { level: 'unknown', lag: null, why: 'the pool replay status could not be read' };
  const conf = Number.isInteger(status.confirmations) ? status.confirmations : 1;
  if (status.verifierEnabled === false) return { level: 'critical', lag: null, why: `the pool replay has no proof verifier (${status.verifierReason || 'no reason given'}): it halts at the first pool envelope` };
  if (!Number.isInteger(status.height)) return { level: 'critical', lag: null, why: 'the pool replay has not started' };
  if (!Number.isInteger(status.tip)) return { level: 'unknown', lag: null, why: `the pool replay is at ${status.height} and has not read the chain tip${status.lastError ? ` (${status.lastError})` : ''}` };
  const lag = Math.max(0, status.tip - conf + 1 - status.height);
  const resting = Array.isArray(status.sources) ? status.sources.filter((s) => s && s.restingSecs > 0) : [];
  const detail = [
    status.halted ? `halted at ${status.halted.height}: ${status.halted.reason}` : null,
    !status.halted && status.lastError ? `last error: ${status.lastError}` : null,
    resting.length ? `sources resting: ${resting.map((s) => `${s.source} ${s.restingSecs} s (${s.last})`).join(', ')}` : null,
  ].filter(Boolean).join('; ');
  const why = `the pool replay is at ${status.height}, ${lag} block${lag === 1 ? '' : 's'} behind (tip ${status.tip})${detail ? `; ${detail}` : ''}`;
  if (lag >= critical) return { level: 'critical', lag, why };
  if (lag >= warn || (status.halted && lag >= 2)) return { level: 'warning', lag, why };
  return { level: 'ok', lag, why };
}
