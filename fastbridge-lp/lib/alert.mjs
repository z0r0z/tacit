// Alerts: each goes to the log and, when a webhook is set, is POSTed there as JSON. The body carries the alert's own fields, and two more that put
// one readable line where a chat service looks for it: `text` (Slack and the services that copy it) and `content` (Discord), so a channel's incoming
// webhook can be pointed at the provider with nothing between them. A webhook that does not answer costs the provider nothing.

const MAX_LINE = 1800;                                           // Discord takes 2000 characters of content

export function alertLine(o, name = 'fast bridge LP') {
  const { level = 'info', msg = '', ...rest } = o || {};
  const parts = [];
  for (const [k, v] of Object.entries(rest)) {
    if (v == null || typeof v === 'object') continue;
    parts.push(`${k}: ${String(v).replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  const line = `[${name}] ${String(level).toUpperCase()}: ${msg}${parts.length ? ` (${parts.join(', ')})` : ''}`;
  return line.length > MAX_LINE ? line.slice(0, MAX_LINE - 1) + '…' : line;
}

export function makeAlert({ log, webhook = null, name, fetchImpl = (...a) => fetch(...a) }) {
  return (o) => {
    log(o);
    if (!webhook) return;
    const line = alertLine(o, name);
    try {
      Promise.resolve(fetchImpl(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...o, text: line, content: line }) })).catch(() => {});
    } catch { /* a webhook that cannot be reached is not the provider's trouble */ }
  };
}
