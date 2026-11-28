// tacit-bot's code agent, Discord side. Three ways in -- the /improve command, the "Prepare a PR" message command, and a "Prepare a fix" button on a review finding -- each
// starts ONE GitHub Actions run of tools/pr-agent (workflow_dispatch: the token needs Actions:write on the repo and nothing else); the run reports back to /pr-agent/report,
// which posts the outcome in the review channel as tacit-bot: a draft PR to read, a suggestion that did not pass the checks, or a note that nothing was found.
//
// Who may ask: the people in IMPROVE_USER_IDS, or holders of a role in IMPROVE_ROLE_IDS (neither set: the commands answer "not enabled"). A day's total is capped (IMPROVE_MAX_DAY,
// default 10). The text of a request is data: it is cleaned (no links, no @mentions) before it is stored, sent to the runner or shown, and the runner treats it as a description,
// never as instructions. Nothing here merges, approves or marks a PR ready.
import { clean, NUDGE_LABELS, NUDGE_PREFIX, sendBotMessage } from './nudger.js';

export const IMPROVE_COMMAND = 'improve', IMPROVE_MESSAGE_COMMAND = 'Prepare a PR', FIX_PREFIX = 'nudge:fix:';
const KEEP_SECONDS = 120 * 86400;
const STATUSES = ['pr', 'suggestion', 'nothing', 'unavailable', 'error'], KINDS = ['request', 'finding', 'touchup'];
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
const REPORT_ID = /^n\d{6}-\d{2}$/;

// A request's text: control characters out (new lines kept), a link or invite becomes "[link]", an @ cannot name anyone, backticks become quotes, at most `max` characters.
export const cleanText = (s, max = 1500) => String(s ?? '').replace(/\b(?:https?:\/\/|discord(?:app)?\.(?:gg|com\/invite)\/)\S*/gi, '[link]').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').replace(/`/g, "'").replace(/@/g, '@​').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const today = (now = new Date()) => now.toISOString().slice(0, 10);
const idPrefix = (day) => `n${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}-`;
const rid = () => { const b = new Uint8Array(4); crypto.getRandomValues(b); return [...b].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 6); };
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const reply = (content) => ({ type: 4, data: { content: String(content).slice(0, 1800), flags: 64, allowed_mentions: { parse: [] } } });

// Is this person allowed to ask? (IMPROVE_USER_IDS by id, IMPROVE_ROLE_IDS by role)
export function mayAsk(env, interaction) {
  const users = list(env.IMPROVE_USER_IDS), roles = list(env.IMPROVE_ROLE_IDS);
  if (!users.length && !roles.length) return { ok: false, why: 'This is not enabled yet.' };
  const user = interaction.member?.user || interaction.user || {};
  if (users.includes(String(user.id))) return { ok: true, user };
  if ((interaction.member?.roles || []).some((r) => roles.includes(String(r)))) return { ok: true, user };
  return { ok: false, why: 'Only the people the maintainers have allowed can ask for a change.' };
}

// A day's asks, counted in the store (read, then write: one person at a time is the use, and being a little over is harmless).
async function underCap(env, now = new Date()) {
  const key = `pra:cap:${today(now)}`, cap = Math.max(1, Number(env.IMPROVE_MAX_DAY) || 10), n = Number(await env.REGISTRY_KV.get(key)) || 0;
  if (n >= cap) return false;
  await env.REGISTRY_KV.put(key, String(n + 1), { expirationTtl: 3 * 86400 }); return true;
}

// Starts the runner: one workflow_dispatch with the task as one input. Resolves { ok } or { ok: false, status | error }.
export async function dispatchTask(env, task, fetchImpl = fetch) {
  if (!env.GITHUB_DISPATCH_TOKEN) return { ok: false, error: 'not configured' };
  const repo = /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPO || '') ? env.GITHUB_REPO : 'z0r0z/tacit';
  const wf = /^[\w.-]+\.ya?ml$/.test(env.PRAGENT_WORKFLOW || '') ? env.PRAGENT_WORKFLOW : 'pr-agent.yml';
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${wf}/dispatches`, { method: 'POST',
      headers: { Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'tacit-bot', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: /^[\w./-]{1,60}$/.test(env.PRAGENT_REF || '') ? env.PRAGENT_REF : 'main', inputs: { task: JSON.stringify(task) } }) });
    return res.status === 204 ? { ok: true } : { ok: false, status: res.status };
  } catch { return { ok: false, error: 'unreachable' }; }
}

// /improve text:"…"  or  the "Prepare a PR" message command (the text is the message's)
export async function improveCommand(env, interaction, fetchImpl = fetch) {
  const who = mayAsk(env, interaction); if (!who.ok) return reply(who.why);
  const d = interaction.data || {};
  let text = '', ref = '';
  if (d.type === 3) {   // a message command: the target message
    const m = d.resolved?.messages?.[d.target_id]; text = m?.content || ''; ref = `${interaction.channel_id}:${d.target_id}`;
  } else { text = (d.options || []).find((o) => o.name === 'text')?.value || ''; ref = `${interaction.channel_id}:${interaction.id || ''}`; }
  text = cleanText(text);
  if (text.length < 12) return reply('Tell me what should change in a sentence or two (at least a dozen characters).');
  if (!(await underCap(env))) return reply('Today\'s limit for requests has been used. Try again tomorrow.');
  const task = { id: `r-${rid()}`, kind: 'request', text, source: { via: 'discord', ref: ref.slice(0, 60) } };
  const r = await dispatchTask(env, task, fetchImpl);
  if (!r.ok) return reply(`I could not start it (${r.status ? `GitHub answered ${r.status}` : r.error}).`);
  return reply(`Queued as \`${task.id}\`. tacit-bot will try it and post the result in the review channel: a draft PR to read, or a note on what it found. Nothing is merged without a person.`);
}

// The "Prepare a fix" button under a review finding
export async function fixButton(env, interaction, fetchImpl = fetch) {
  const m = String(interaction.data?.custom_id || '').match(/^nudge:fix:(n\d{6}-\d{1,2})$/);
  if (!m) return reply('Unknown action.');
  if (!env.NUDGER_CHANNEL_ID || interaction.channel_id !== env.NUDGER_CHANNEL_ID) return reply('This button only works in the review channel.');
  const who = mayAsk(env, interaction); if (!who.ok) return reply(who.why);
  const key = `nudge:f:${m[1]}`, raw = await env.REGISTRY_KV.get(key);
  if (!raw) return reply('That finding is no longer stored.');
  const rec = JSON.parse(raw);
  if (rec.fix_id) return reply(`A fix was already requested for this finding (\`${rec.fix_id}\`).`);
  if (!(await underCap(env))) return reply('Today\'s limit for requests has been used. Try again tomorrow.');
  const task = { id: `f-${m[1]}`, kind: 'finding', finding: { file: cleanText(rec.file, 160), line: Number(rec.line) || 0, claim: cleanText([rec.claim, rec.evidence].filter(Boolean).join(' '), 900) }, source: { via: 'review finding', ref: m[1] } };
  const r = await dispatchTask(env, task, fetchImpl);
  if (!r.ok) return reply(`I could not start it (${r.status ? `GitHub answered ${r.status}` : r.error}).`);
  rec.fix_id = task.id; rec.fix_by = String(who.user.id || '').slice(0, 20); rec.fix_at = Date.now();
  await env.REGISTRY_KV.put(key, JSON.stringify(rec), { expirationTtl: KEEP_SECONDS });
  const base = String(interaction.message?.content || '').replace(/\n\n_fix requested[^\n]*_$/, '');
  return { type: 7, data: { content: `${base}\n\n_fix requested by ${clean(who.user.global_name || who.user.username || 'a reviewer', 40)}: I will post the outcome here_`.slice(0, 2000), allowed_mentions: { parse: [] }, components: interaction.message?.components || [] } };
}

// ---- the report the runner posts -----------------------------------------------------------------------------------------------------------------------------------
// The body -> { report } with every field bounded and typed, or { error }.
export function parseReport(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'body must be an object' };
  if (!/^[A-Za-z0-9-]{3,40}$/.test(String(b.id || ''))) return { error: 'id must be 3-40 letters, digits and dashes' };
  if (!KINDS.includes(b.kind)) return { error: 'unknown kind' };
  if (!STATUSES.includes(b.status)) return { error: 'unknown status' };
  const strs = (v, n, max) => (Array.isArray(v) ? v.slice(0, n).map((x) => clean(x, max)).filter(Boolean) : []);
  return { report: { id: String(b.id), kind: b.kind, status: b.status, title: clean(b.title, 90), text: cleanText(b.text, 700), failedGates: strs(b.failedGates, 5, 160), files: strs(b.files, 6, 120),
    lines: Math.max(0, Math.min(100000, Math.round(Number(b.lines) || 0))), prUrl: PR_URL.test(String(b.prUrl || '')) ? String(b.prUrl) : '', turns: Math.max(0, Math.min(1000, Math.round(Number(b.turns) || 0))), model: clean(b.model, 40), source: clean(b.source, 60) } };
}

// The message: plain text, no pings, no previews, with the same Useful / Noise / Already known buttons the review channel uses, so the labels measure the bot too.
export function renderReport(r, id) {
  const head = { pr: '**Draft PR for review**', suggestion: '**Suggestion** (not a PR)', nothing: '**Nothing to change**', unavailable: '**Could not run**', error: '**Could not run**' }[r.status];
  const lines = [`${head} · ${r.kind}${r.model ? ` · ${r.model}` : ''}`, r.title && r.status !== 'nothing' ? `**${r.title}**` : '',
    r.status === 'pr' && r.prUrl ? r.prUrl : '', r.status === 'suggestion' && r.text ? `> ${r.text.replace(/\n+/g, ' ').slice(0, 500)}` : (r.status !== 'pr' && r.text ? r.text.replace(/\n+/g, ' ').slice(0, 300) : ''),
    r.failedGates.length ? `Held back by: ${r.failedGates.join('; ')}` : '', r.files.length ? `${r.files.map((f) => `\`${f}\``).join(', ')} · ${r.lines} lines` : '', `\`${id}\``].filter(Boolean);
  return { content: lines.join('\n').slice(0, 1900), allowed_mentions: { parse: [] }, flags: 4,
    components: r.status === 'pr' || r.status === 'suggestion' ? [{ type: 1, components: Object.entries(NUDGE_LABELS).map(([k, label]) => ({ type: 2, style: k === 'useful' ? 3 : k === 'noise' ? 4 : 2, label, custom_id: `${NUDGE_PREFIX}${k}:${id}` })) }] : [] };
}

// Posts a report. A touch-up pass that found nothing, or could not run, says nothing (every day would be noise); a person's request or a finding always gets an answer.
// -> { status, body }
export async function postReport(env, report, now = new Date()) {
  if (report.kind === 'touchup' && ['nothing', 'unavailable', 'error'].includes(report.status)) return { status: 200, body: { ok: true, skipped: true } };
  if (!/^\d{17,20}$/.test(String(env.NUDGER_CHANNEL_ID || '')) || !env.DISCORD_BOT_TOKEN) return { status: 500, body: { ok: false, error: 'review channel not configured' } };
  const day = today(now), dayKey = `pra:day:${day}`, ids = JSON.parse((await env.REGISTRY_KV.get(dayKey)) || '[]');
  const seen = await env.REGISTRY_KV.get(`pra:report:${report.id}`);
  if (seen) return { status: 200, body: { ok: true, duplicate: true, id: JSON.parse(seen).nid } };   // a retry posts nothing twice
  if (ids.length >= 79) return { status: 429, body: { ok: false, error: 'too many reports today' } };
  const nid = `${idPrefix(day)}${20 + ids.length}`;
  if (!REPORT_ID.test(nid)) return { status: 500, body: { ok: false, error: 'bad id' } };
  const r = await sendBotMessage(env, renderReport(report, nid));
  if (!r.ok) return { status: 502, body: { ok: false, error: r.error } };
  await env.REGISTRY_KV.put(`nudge:f:${nid}`, JSON.stringify({ id: nid, status: `agent-${report.status}`, severity: 'low', file: report.files[0] || '', line: 0, commit: '', claim: report.title || report.text.slice(0, 200), by: 'tacit-bot', unit: 'agent', pr: report.prUrl || null, report_id: report.id, day, message: r.id, posted_at: Date.now(), label: null }), { expirationTtl: KEEP_SECONDS });
  await env.REGISTRY_KV.put(dayKey, JSON.stringify([...ids, nid]), { expirationTtl: KEEP_SECONDS });
  await env.REGISTRY_KV.put(`pra:report:${report.id}`, JSON.stringify({ nid }), { expirationTtl: KEEP_SECONDS });
  return { status: 200, body: { ok: true, id: nid } };
}
