// Pure health verdict for the public Tacit Praxis ceremony endpoints.
// The monitor deliberately needs no coordinator/admin key.

const seconds = (value, nowMs) => {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? Math.max(0, (nowMs - ms) / 1000) : null;
};

export function praxisVerdict(head, transcript, { nowMs = Date.now(), warnSecs = 2 * 60 * 60, criticalSecs = 3 * 60 * 60 } = {}) {
  if (!head || !transcript) return { alerts: [{ level: 'critical', msg: 'Praxis ceremony is unreachable or returned unreadable state' }], log: 'Praxis: unreadable' };
  const index = Number(head.index);
  const queue = Number(head.queue);
  if (!Number.isInteger(index) || !Number.isFinite(queue)) return { alerts: [{ level: 'critical', msg: 'Praxis ceremony returned malformed head state' }], log: 'Praxis: malformed head' };
  if (head.closed || transcript.closed) return { alerts: [], log: `Praxis closed at phase2-${index}` };

  const receipts = Array.isArray(transcript.receipts) ? transcript.receipts : [];
  const last = receipts.at(-1);
  const age = seconds(last?.at, nowMs);
  const alerts = [];
  if (queue > 0 && age != null && age >= criticalSecs) alerts.push({ level: 'critical', msg: `Praxis head phase2-${index} has not advanced for ${Math.floor(age / 60)} min with ${queue} queued`, extra: { index, queue, lastAcceptedAt: last.at } });
  else if (queue > 0 && age != null && age >= warnSecs) alerts.push({ level: 'warning', msg: `Praxis head phase2-${index} has not advanced for ${Math.floor(age / 60)} min with ${queue} queued`, extra: { index, queue, lastAcceptedAt: last.at } });
  if (last && Number(last.index) !== index) alerts.push({ level: 'critical', msg: `Praxis head phase2-${index} disagrees with latest receipt phase2-${last.index}` });
  return { alerts, log: `Praxis open at phase2-${index}; ${receipts.length} contributions, queue ${queue}${age == null ? '' : `, last accepted ${Math.floor(age / 60)} min ago`}` };
}
