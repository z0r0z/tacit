// The monitor's reading of the prover board (worker/src/prover-board.js GET /prover/board) and of the RunPod account that once rented
// its GPU box: pure verdicts, so balance-monitor.js only fetches and alerts. Each returns { alerts: [{ level, msg, extra }], log }.

// Tacit's own workers (community machines race public jobs only: they neither keep the board alive for Tacit's jobs nor are Tacit's
// boxes to check). A worker the board never saw poll has no lastSeenSeconds and is not live.
export function boardVerdict(s, { quietSecs, badWindowSecs, waitWarnSecs }) {
  const alerts = [];
  if (!s || !Array.isArray(s.workers)) return { alerts: [{ level: 'warning', msg: 'prover board unreadable: settle proofs may be going to the prover network', extra: {} }], log: null };
  const workers = s.workers.filter((w) => !w.community);
  const live = workers.filter((w) => w.lastSeenSeconds != null && Number(w.lastSeenSeconds) <= quietSecs);
  if (!live.length) {
    const seen = workers.map((w) => `${w.name} ${w.lastSeenSeconds == null ? 'never' : `${Math.round(Number(w.lastSeenSeconds) / 60)} min ago`}`).join(', ') || 'none ever';
    alerts.push({ level: 'critical', msg: `no prover-board worker has polled in ${Math.round(quietSecs / 60)} min (last: ${seen}): settle proofs go to the prover network with public inputs until the GPU box is back (stopped instance, out of credit, or the worker loop down)`, extra: { workers } });
    return { alerts, log: null };
  }
  // `bad` is a lifetime count, so it warns only on a refusal within the window (the board's lastBadSeconds); a board that predates the field
  // gives no time, and its count is only logged.
  const bad = workers.filter((w) => Number(w.bad) > 0 && w.lastBadSeconds != null && Number(w.lastBadSeconds) <= badWindowSecs);
  if (bad.length) alerts.push({ level: 'warning', msg: `prover board: ${bad.map((w) => `${w.name} had a proof refused ${Math.round(Number(w.lastBadSeconds) / 60)} min ago (${w.bad} in all)`).join(', ')} — a proof the pool would not settle; check that box's guest and server versions`, extra: { workers } });
  // A worker failing a good share of what it takes (a GPU server that keeps dying, inputs it cannot read): the jobs
  // still land, after a wait, on the prover network, but the box is not earning its keep.
  const failing = workers.filter((w) => Number(w.failed) >= 3 && Number(w.failed) * 2 >= Number(w.proved));
  if (failing.length) alerts.push({ level: 'warning', msg: `prover board: ${failing.map((w) => `${w.name} failed ${w.failed} of ${Number(w.failed) + Number(w.proved)} jobs`).join(', ')} — jobs then wait out the board before the prover network takes them; check the worker's log`, extra: { workers } });
  // What a user's proof waits for the GPU: the wait for a claim over the last hour's finished jobs. A worker busy with the proof pool's stock or an
  // Ethereum-state proof leaves a user's job queued behind it (on 2026-10-30: 1 s at the median, 24 s at the 90th percentile, 70 jobs in 12 hours), and
  // a second worker, or less stock, is what lowers it.
  const r = s.recent;
  if (r && r.n >= 10 && Number(r.waitP90) > waitWarnSecs) {
    alerts.push({ level: 'warning', msg: `prover board: a user's proof waited ${r.waitP90} s for a free GPU at the 90th percentile (${r.waitP50} s at the median, ${r.n} jobs in the last hour, ${r.proveP50} s to prove): the worker is busy with other work; a second worker would cut the wait`, extra: { recent: r } });
  }
  const line = `prover board: ${live.map((w) => `${w.name} seen ${w.lastSeenSeconds}s ago, proved ${w.proved}${Number(w.bad) > 0 ? `, refused ${w.bad}${w.lastBadSeconds != null ? ` (last ${Math.round(Number(w.lastBadSeconds) / 60)} min ago)` : ''}` : ''}`).join('; ')}; queued ${s.queued}, claimed ${s.claimed}${r && r.n ? `; last hour: ${r.n} jobs, waited ${r.waitP50}/${r.waitP90} s (median/90th), proved in ${r.proveP50}/${r.proveP90} s` : ''}`;
  return { alerts, log: line };
}

// The RunPod account's rent: RunPod stops a pod at a zero balance. Hours left = balance over the running pods' hourly cost; a warning under
// RUNPOD_HOURS_WARN, critical under RUNPOD_HOURS_CRITICAL. No pod running is only logged: the board check above pages when no worker polls, wherever
// the box runs (it now runs off RunPod), so an empty RunPod account says nothing about the board.
export function runpodVerdict(m, { hoursWarn, hoursCritical }) {
  if (!m) return { alerts: [], log: 'runpod: balance unreadable' };
  const running = (m.pods || []).filter((p) => p.desiredStatus === 'RUNNING');
  const perHour = running.reduce((a, p) => a + Number(p.costPerHr || 0), 0);
  const balance = Number(m.clientBalance || 0);
  if (!running.length) return { alerts: [], log: `runpod: no pod running (balance $${balance.toFixed(2)}); the board check covers the GPU worker` };
  if (perHour <= 0) return { alerts: [], log: `runpod: balance $${balance.toFixed(2)}, cost unknown` };
  const hours = balance / perHour;
  const what = `runpod balance $${balance.toFixed(2)} lasts about ${hours.toFixed(0)} h for ${running.map((p) => p.name).join(', ')} at $${perHour.toFixed(2)}/h`;
  if (hours < hoursCritical) return { alerts: [{ level: 'critical', msg: `${what} — top it up or the pod stops`, extra: {} }], log: null };
  if (hours < hoursWarn) return { alerts: [{ level: 'warning', msg: `${what} — top it up soon`, extra: {} }], log: null };
  return { alerts: [], log: what };
}
