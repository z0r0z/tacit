// The team's private review channel. A code reviewer sends one digest of findings in a single authenticated POST; the Discord bot posts each finding to
// the channel with a row of buttons, and every click is stored as a label on that finding. The bot token stays on this server: the reviewer holds only
// NUDGER_SECRET, which can post a digest and read labels and nothing else.
//
// KV keys: nudge:f:<id> (the finding, its message id and its label), nudge:day:<YYYY-MM-DD> (the ids posted that day, so a retried digest posts nothing twice).

export const NUDGE_PREFIX = 'nudge:';
export const NUDGE_LABELS = Object.freeze({ useful: 'Useful', noise: 'Noise', known: 'Already known' });

const MAX_FINDINGS = 8, MAX_BODY = 40_000, KEEP_SECONDS = 120 * 86400, MAX_REPORT_DAYS = 120;
const SEVERITY = ['low', 'med', 'high'];
const STATUS_TEXT = { real: 'verified', outside: 'needs a fact from outside the code' };
const ID = /^n\d{6}-\d{1,2}$/;

// One line of plain text: a link or an invite code becomes "[link]" (a finding describes code and never needs one), control characters and runs of
// whitespace become one space, backticks become quotes (the renderer wraps some fields in backticks), and an @ is followed by a zero-width space so no
// pasted text can name a role or everyone.
export function clean(s, max) {
  return String(s ?? '').replace(/\b(?:https?:\/\/|discord(?:app)?\.(?:gg|com\/invite)\/)\S*/gi, '[link]').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/`/g, "'").replace(/@/g, '@​').replace(/\s+/g, ' ').trim().slice(0, max);
}

export const idPrefix = (day) => `n${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}-`;

// The request body -> { digest } with every field bounded and typed, or { error }.
export function parseDigest(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'bad body' };
  const day = String(b.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) return { error: 'bad day' };
  const list = Array.isArray(b.findings) ? b.findings : [];
  if (list.length > MAX_FINDINGS) return { error: 'too many findings' };
  const seen = new Set(), findings = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') return { error: 'bad finding' };
    const id = String(f.id || '');
    if (!ID.test(id) || !id.startsWith(idPrefix(day)) || seen.has(id)) return { error: 'bad finding id' };
    seen.add(id);
    findings.push({
      id,
      file: clean(f.file, 120),
      line: Number.isInteger(f.line) && f.line >= 0 && f.line <= 10_000_000 ? f.line : 0,
      commit: /^[0-9a-f]{7,40}$/.test(String(f.commit)) ? String(f.commit).slice(0, 12) : '',
      subject: clean(f.subject, 140),
      claim: clean(f.claim, 600),
      evidence: clean(f.evidence, 500),
      severity: SEVERITY.includes(f.severity) ? f.severity : 'low',
      status: f.status === 'outside' ? 'outside' : 'real',
    });
    if (!findings[findings.length - 1].claim) return { error: 'a finding has no claim' };
  }
  const reviewed = Number.isInteger(b.reviewed) && b.reviewed >= 0 && b.reviewed <= 1000 ? b.reviewed : 0;
  return { digest: { day, reviewed, findings } };
}

export function renderFinding(f) {
  const where = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
  const lines = [
    `**${f.severity} · ${STATUS_TEXT[f.status]}** ${where}${f.commit ? ` · \`${f.commit.slice(0, 7)}\`` : ''}${f.subject ? ` ${f.subject}` : ''}`,
    f.claim,
    f.evidence ? `> ${f.evidence}` : '',
    `\`${f.id}\``,
  ].filter(Boolean);
  return {
    content: lines.join('\n').slice(0, 1900),
    allowed_mentions: { parse: [] },
    flags: 4,
    components: [{ type: 1, components: Object.entries(NUDGE_LABELS).map(([k, label]) => ({ type: 2, style: k === 'useful' ? 3 : k === 'noise' ? 4 : 2, label, custom_id: `${NUDGE_PREFIX}${k}:${f.id}` })) }],
  };
}

export const renderQuiet = (day, reviewed) => ({
  content: `Nothing worth a look today: ${reviewed} commit${reviewed === 1 ? '' : 's'} reviewed (${day}).`,
  allowed_mentions: { parse: [] },
  flags: 4,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST one message as the bot; a rate-limited reply is waited out once.
async function sendMessage(env, message, fetchImpl) {
  const url = `https://discord.com/api/v10/channels/${env.NUDGER_CHANNEL_ID}/messages`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchImpl(url, { method: 'POST', headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
    if (res.status === 429 && attempt === 0) {
      let wait = 1;
      try { wait = Number((await res.json())?.retry_after) || 1; } catch {}
      await sleep(Math.min(5, Math.max(0, wait)) * 1000);
      continue;
    }
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) return { ok: false, status: res.status, error: String(data?.message || 'discord refused').slice(0, 120) };
    return { ok: true, id: String(data?.id || '') };
  }
  return { ok: false, status: 429, error: 'rate limited' };
}

// Posts a digest: each finding once (one already stored is skipped, so a retry after a partial failure completes the day), or one short line when there
// are none. Resolves { status, body } for the route to return.
export async function postDigest(env, digest, fetchImpl = fetch) {
  if (!/^\d{17,20}$/.test(String(env.NUDGER_CHANNEL_ID || '')) || !env.DISCORD_BOT_TOKEN) return { status: 500, body: { ok: false, error: 'review channel not configured' } };
  const dayKey = `nudge:day:${digest.day}`;
  const done = await env.REGISTRY_KV.get(dayKey);
  if (done) return { status: 200, body: { ok: true, duplicate: true, ids: JSON.parse(done) } };
  const posted = [];
  if (!digest.findings.length) {
    const r = await sendMessage(env, renderQuiet(digest.day, digest.reviewed), fetchImpl);
    if (!r.ok) return { status: 502, body: { ok: false, error: r.error } };
  }
  for (const f of digest.findings) {
    const key = `nudge:f:${f.id}`;
    if (await env.REGISTRY_KV.get(key)) { posted.push(f.id); continue; }
    const r = await sendMessage(env, renderFinding(f), fetchImpl);
    if (!r.ok) return { status: 502, body: { ok: false, error: r.error, posted } };
    await env.REGISTRY_KV.put(key, JSON.stringify({ ...f, day: digest.day, message: r.id, posted_at: Date.now(), label: null }), { expirationTtl: KEEP_SECONDS });
    posted.push(f.id);
  }
  await env.REGISTRY_KV.put(dayKey, JSON.stringify(posted), { expirationTtl: KEEP_SECONDS });
  return { status: 200, body: { ok: true, posted } };
}

// A click on a finding's buttons: only in the review channel (and by the listed people when NUDGER_USER_IDS names them). The label is stored and the message
// is edited in place to show it; another click replaces it.
export async function nudgeButton(env, interaction) {
  const reply = (content) => ({ type: 4, data: { content, flags: 64 } });
  const m = String(interaction.data?.custom_id || '').match(/^nudge:(useful|noise|known):(n\d{6}-\d{1,2})$/);
  if (!m) return reply('Unknown action.');
  if (!env.NUDGER_CHANNEL_ID || interaction.channel_id !== env.NUDGER_CHANNEL_ID) return reply('These buttons only work in the review channel.');
  const user = interaction.member?.user || interaction.user || {};
  const allowed = String(env.NUDGER_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(user.id))) return reply('Only the reviewers can mark findings.');
  const key = `nudge:f:${m[2]}`, raw = await env.REGISTRY_KV.get(key);
  if (!raw) return reply('That finding is no longer stored.');
  const rec = JSON.parse(raw);
  rec.label = m[1]; rec.by = String(user.id || '').slice(0, 20); rec.by_name = clean(user.global_name || user.username || '', 40); rec.labelled_at = Date.now();
  await env.REGISTRY_KV.put(key, JSON.stringify(rec), { expirationTtl: KEEP_SECONDS });
  const base = String(interaction.message?.content || '').replace(/\n\n_marked [^\n]*_$/, '');
  return { type: 7, data: { content: `${base}\n\n_marked ${NUDGE_LABELS[m[1]].toLowerCase()}${rec.by_name ? ` by ${rec.by_name}` : ''}_`.slice(0, 2000), allowed_mentions: { parse: [] }, components: interaction.message?.components || [] } };
}

// Findings posted from `since` (YYYY-MM-DD, default 30 days back) through today (a day ahead of this clock is allowed for), with their labels and the totals.
export async function labelsReport(env, since, now = new Date()) {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(since || '')) ? new Date(`${since}T00:00:00Z`) : new Date(now.getTime() - 30 * 86400_000);
  const rows = [];
  for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())), n = 0; d.getTime() <= now.getTime() + 86400_000 && n < MAX_REPORT_DAYS; d = new Date(d.getTime() + 86400_000), n++) {
    const day = d.toISOString().slice(0, 10), raw = await env.REGISTRY_KV.get(`nudge:day:${day}`);
    if (!raw) continue;
    for (const id of JSON.parse(raw)) {
      const f = await env.REGISTRY_KV.get(`nudge:f:${id}`);
      if (f) { const r = JSON.parse(f); rows.push({ id, day, file: r.file, line: r.line, commit: r.commit, severity: r.severity, status: r.status, label: r.label || null, by_name: r.by_name || null }); }
    }
  }
  const count = (k) => rows.filter((r) => r.label === k).length;
  return { findings: rows, totals: { posted: rows.length, labelled: rows.filter((r) => r.label).length, useful: count('useful'), noise: count('noise'), known: count('known') } };
}

export async function findingById(env, id) {
  if (!ID.test(String(id))) return null;
  const raw = await env.REGISTRY_KV.get(`nudge:f:${id}`);
  return raw ? JSON.parse(raw) : null;
}

export const MAX_NUDGER_BODY = MAX_BODY;
