// Delivery: a DRAFT pull request for a change that passed every gate, and/or a report to the team's Discord channel (as tacit-bot, through the API) for anything: a PR, a
// suggestion that did not pass, or a note that nothing was found. Nothing here merges, approves or marks ready for review: a person does that.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Text that came from a person or a model is shown as text: GitHub notifies whoever is @mentioned and links #123 to an issue, so neither survives into a PR body.
export const defang = (t, n = 2000) => String(t ?? '').replace(/\r/g, '').replace(/@(?=[A-Za-z0-9_-])/g, '@​').replace(/#(?=\d)/g, '#​').slice(0, n);
export const prTitle = (summary) => { const t = String(summary || '').replace(/\s+/g, ' ').replace(/^["'`]+|["'`]+$/g, '').replace(/^(SUGGEST|NOTHING):\s*/i, '').trim().slice(0, 72); return t.length >= 8 ? defang(t, 72) : 'small fix'; };
export const branchOf = (id) => `bot/${String(id).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'change'}`;

export function prBody({ task, result }) {
  const asked = task.kind === 'finding' ? `A reviewer's finding: ${defang(task.finding?.claim, 600)} (${defang(task.finding?.file, 120)}${task.finding?.line ? ':' + defang(task.finding.line, 12) : ''})`
    : task.kind === 'touchup' ? 'An autonomous touch-up pass over recently changed files.' : `A request${task.source?.via ? ` from ${defang(task.source.via, 40)}` : ''}: ${defang(task.text, 800)}`;
  const rows = (result.gates || []).map((g) => `| ${g.gate} | ${g.ok ? 'pass' : '**no**'} | ${defang(g.note, 200).replace(/\|/g, '/')} |`).join('\n');
  return [`Opened by tacit-bot as a **draft**. A person must read this before anything is merged; nothing here merges itself.`, '',
    `**Asked for.** ${asked}`, '', `**What changed.** ${defang(result.summary, 300)}`, '', `Files: ${(result.files || []).map((f) => '`' + f + '`').join(', ')} (${result.lines} changed lines)`, '',
    '**Checks.** Every one of these passed, or this would have been a suggestion in Discord and not a pull request.', '', '| check | result | detail |', '|---|---|---|', rows, '',
    `**How it was made.** ${result.node?.model ? `Model \`${defang(result.node.model, 60)}\` on a community node${result.node.tier ? ` (${result.node.tier})` : ''}` : 'An open model'}; ${result.turns} turns, about ${result.tokens} tokens. The conversation is in the workflow run's artifacts.`, '',
    'The change was written by a small open model and has had only the checks above. Review it as you would an outside contribution.'].join('\n');
}

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 << 20, ...opts });

// Commits the working tree to a new branch and opens a draft PR. dryRun: only says what it would do.
export function deliverPr({ repo, task, result, remote = 'origin', baseBranch = 'main', gh = 'gh', dryRun = false }) {
  const branch = branchOf(task.id), title = prTitle(result.summary), body = prBody({ task, result });
  if (dryRun) return { dryRun: true, branch, title, body };
  const git = (...a) => sh('git', ['-C', repo, ...a]);
  // The push token (GH_TOKEN, set by the workflow) goes in as a one-shot header for the push alone: it is never written to .git/config, where a test the model wrote could read it.
  const tok = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  const auth = tok ? ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${tok}`).toString('base64')}`] : [];
  const redact = (t) => { let x = String(t || ''); if (tok) x = x.split(tok).join('***').split(Buffer.from(`x-access-token:${tok}`).toString('base64')).join('***'); return x.trim().slice(0, 300); };
  const steps = [['checkout', ['checkout', '-q', '-b', branch]], ['add', ['add', '-A', '--', '.', ':(exclude)node_modules', ':(exclude)*/node_modules']],
    ['commit', ['-c', 'user.name=tacit-bot', '-c', 'user.email=tacit-bot@users.noreply.github.com', 'commit', '-q', '-m', title]], ['push', [...auth, 'push', '-q', remote, branch]]];
  for (const [label, args] of steps) { const r = git(...args); if (r.status !== 0) return { error: `git ${label} failed: ${redact(r.stderr)}`, branch }; }
  const dir = mkdtempSync(join(tmpdir(), 'prbody-')); const f = join(dir, 'body.md');
  try {
    writeFileSync(f, body);
    const mk = (labels) => sh(gh, ['pr', 'create', '--draft', '--base', baseBranch, '--head', branch, '--title', title, '--body-file', f, ...(labels ? ['--label', 'bot-pr'] : [])], { cwd: repo });
    let r = mk(true); if (r.status !== 0 && /label/i.test(r.stderr || '')) r = mk(false);   // the label may not exist yet
    if (r.status !== 0) return { error: `gh pr create failed: ${redact(r.stderr)}`, branch };
    return { url: (r.stdout || '').trim().split('\n').pop(), branch, title };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// What the Discord side is told (the API turns it into a message from tacit-bot): the outcome, a short text, which checks failed, and the PR address if there is one.
export function reportPayload({ task, result, prUrl }) {
  const failed = (result.gates || []).filter((g) => !g.ok);
  return { id: String(task.id).slice(0, 40), kind: task.kind, status: result.status, title: defang(result.title || prTitle(result.summary), 90),
    text: defang(result.summary, 700), failedGates: failed.map((g) => `${g.gate}: ${defang(g.note, 120)}`).slice(0, 5), files: (result.files || []).slice(0, 6), lines: result.lines || 0,
    prUrl: prUrl && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(prUrl) ? prUrl : undefined, turns: result.turns, model: result.node?.model || null,
    source: task.source?.ref ? String(task.source.ref).slice(0, 60) : undefined };
}
export async function postReport({ api, secret, payload, fetchImpl = fetch }) {
  const r = await fetchImpl(`${String(api).replace(/\/+$/, '')}/pr-agent/report`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
  return { ok: r.ok, status: r.status };
}
