#!/usr/bin/env node
// tacit-bot's code agent. One task in (a request from Discord, a reviewer's finding, or an autonomous touch-up pass), one outcome out:
//   pr          a small change that passed every gate: a DRAFT pull request (a person reviews and merges)
//   suggestion  something found, or a change that failed a gate: reported in Discord, never opened as a PR
//   nothing     nothing obvious to do
// The model is a community node's (through the help desk gateway's /agent/chat) or any OpenAI-compatible server; this program is the hands and the gates.
//
//   node tools/pr-agent/pr-agent.mjs --task task.json --out out/ --chat-url https://tacit-helpdesk.onrender.com/agent/chat --token-env AGENT_SECRET [--deliver none|pr|report|both]
//   node tools/pr-agent/pr-agent.mjs --auto-touchup --out out/ ...      pick the files changed in the last days and look for one obvious mistake
//   task.json: { "id": "r-1a2b3c", "kind": "request" | "finding" | "touchup", "text": "…", "finding": { file, line, claim, old, new }, "files": [...], "source": { "via": "discord", "ref": "…" } }
//   --repo DIR (default .)  --base REV (default HEAD)  --build-cmd "npm run build && npm run build:verify"  --turns 40  --max-lines 150  --dry-run (no push, no PR, no post)
//   --report-api URL --report-secret-env NAME      where the Discord report goes (the API's /pr-agent/report)
// RUN IT ONLY IN A THROWAWAY CHECKOUT (a CI runner): the model's edits and the tests it runs execute there. It exits 0 for every outcome; look at out/result.json.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, NO_WRITE, NO_READ, isTestPath } from './engine.mjs';
import { checkPatch } from './gates.mjs';
import { deliverPr, postReport, reportPayload, prTitle } from './deliver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const repo = resolve(flag('--repo', '.')), out = resolve(flag('--out', 'pr-agent-out')), base = flag('--base', 'HEAD');
const noweb = resolve(flag('--noweb', join(HERE, '..', 'noweb.cjs')));
const dry = has('--dry-run'), deliver = flag('--deliver', 'none');
const say = (t) => console.error(`${new Date().toISOString().slice(11, 19)} ${t}`);
const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
const reset = (rev) => { git('checkout', '-q', '-f', '--detach', rev); git('clean', '-fdq', '-e', 'node_modules'); };

// the files changed lately that a bot may write and a person would read: what an autonomous pass looks at
export function recentFiles(days = 3, max = 8) {
  const r = git('log', `--since=${days} days ago`, '--no-merges', '--name-only', '--pretty=format:', '--', 'dapp', 'worker', 'worker-relay', 'server', 'helpdesk', 'tools');
  const count = new Map(); for (const f of (r.stdout || '').split('\n').filter(Boolean)) if (/\.(m?js|cjs)$/.test(f) && !isTestPath(f) && !NO_WRITE.test(f) && !NO_READ.test(f) && !/(^|\/)(vendor|generated)\//.test(f)) count.set(f, (count.get(f) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([f]) => f);
}

export function decide(agent, check) {
  const sum = (agent.summary || '').trim();
  if (check && check.gates?.[0]?.gate === 'has a change' && !check.files?.length) check = null;
  // a run that was cut off (the gateway went away for good) after it had already edited is still judged by the gates: a patch that passes every one is as reviewable as any other
  if (agent.finish === 'error' && !check) return { status: 'error', note: agent.error };
  if (check) return check.ok ? { status: 'pr' } : { status: 'suggestion', note: 'a change was written but did not pass every check' };
  if (!sum || /^NOTHING\b/i.test(sum)) return { status: 'nothing' };
  if (/^SUGGEST:/i.test(sum) || sum.length >= 15) return { status: 'suggestion', note: 'no change was made' };
  return { status: 'nothing' };
}

async function main() {
  mkdirSync(out, { recursive: true });
  let task;
  if (has('--auto-touchup')) { const files = recentFiles(Number(flag('--days', 3))); task = { id: `t-${Date.now().toString(36)}`, kind: 'touchup', files, source: { via: 'autonomous pass' } }; if (!files.length) { writeFileSync(join(out, 'result.json'), JSON.stringify({ id: task.id, kind: 'touchup', status: 'nothing', summary: 'NOTHING: no recently changed files', gates: [] }, null, 1)); say('no recently changed files'); return; } }
  else { try { task = JSON.parse(readFileSync(flag('--task', 'task.json'), 'utf8')); } catch (e) { console.error(`cannot read the task: ${e.message}`); process.exit(2); } }
  if (!task || !/^[A-Za-z0-9-]{3,40}$/.test(task.id || '') || !['request', 'finding', 'touchup'].includes(task.kind)) { console.error('task needs an id (3-40 letters, digits, dashes) and a kind: request, finding or touchup'); process.exit(2); }
  if (task.kind === 'request' && !String(task.text || '').trim()) { console.error('a request needs text'); process.exit(2); }
  const chatUrl = flag('--chat-url', process.env.PR_AGENT_CHAT_URL || ''); if (!chatUrl) { console.error('give --chat-url (the gateway /agent/chat, or any OpenAI-compatible chat-completions URL)'); process.exit(2); }
  const token = process.env[flag('--token-env', 'AGENT_SECRET')] || '';
  const result = { id: task.id, kind: task.kind, status: 'error', summary: '', gates: [], files: [], lines: 0, turns: 0, tokens: 0 };
  const finishUp = async () => {
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 1));
    let prUrl;
    if (!dry && (deliver === 'pr' || deliver === 'both') && result.status === 'pr') { const d = deliverPr({ repo, task, result }); if (d.error) { result.deliverError = d.error; say(d.error); } else { prUrl = d.url; result.prUrl = prUrl; say(`draft PR: ${prUrl}`); } writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 1)); }
    if (dry && result.status === 'pr') { const d = deliverPr({ repo, task, result, dryRun: true }); writeFileSync(join(out, 'pr-body.md'), `# ${d.title}\nbranch: ${d.branch}\n\n${d.body}\n`); }
    if (deliver === 'report' || deliver === 'both') {
      const api = flag('--report-api', process.env.PR_AGENT_REPORT_API || ''), secret = process.env[flag('--report-secret-env', 'NUDGER_SECRET')] || '';
      const payload = reportPayload({ task, result, prUrl });
      if (dry || !api || !secret) { writeFileSync(join(out, 'report.json'), JSON.stringify(payload, null, 1)); say(dry ? 'dry run: report written, not sent' : 'no report API or secret: report written, not sent'); }
      else { try { const r = await postReport({ api, secret, payload }); say(`report ${r.ok ? 'sent' : 'REFUSED'} (${r.status})`); result.reported = r.ok; } catch (e) { say(`report failed: ${e.message}`); } writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 1)); }
    }
    if (!has('--keep')) reset(base);
    console.log(JSON.stringify({ id: result.id, status: result.status, title: result.title, prUrl: result.prUrl }));
  };

  // is any node able to take a turn? (the gateway says; any other endpoint is assumed up) -- do not start, and do not burn a run, when nothing can answer
  if (/\/agent\/chat$/.test(chatUrl) && !has('--no-status-check')) {
    try { const r = await fetch(chatUrl.replace(/\/chat$/, '/status'), { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => ({})); if (!r.ok || !(j.nodes > 0)) { Object.assign(result, { status: 'unavailable', summary: r.ok ? 'no community node can take an agent turn right now' : `the model gateway answered ${r.status}` }); say(result.summary); return finishUp(); } }
    catch (e) { Object.assign(result, { status: 'unavailable', summary: `the model gateway is unreachable: ${e.message}` }); say(result.summary); return finishUp(); }
  }
  reset(base);
  say(`task ${task.id} (${task.kind}) on ${git('rev-parse', '--short', 'HEAD').stdout.trim()}`);
  const agent = await runAgent({ repo, noweb, task, model: { url: chatUrl, token, retryMs: Number(process.env.PR_AGENT_RETRY_MS) || undefined }, limits: { turns: Number(flag('--turns', 40)), wallMs: Number(flag('--wall-min', 25)) * 60000 }, say });
  writeFileSync(join(out, 'transcript.json'), JSON.stringify(agent.log, null, 1));
  const check = checkPatch({ repo, noweb, buildCmd: flag('--build-cmd', ''), limits: { maxLines: Number(flag('--max-lines', 150)), maxFiles: Number(flag('--max-files', 5)), requireFailBefore: !has('--allow-weak-test') }, say });
  if (check.patch) writeFileSync(join(out, 'patch.diff'), check.patch);
  const d = decide(agent, check);
  Object.assign(result, { status: d.status, note: d.note, summary: agent.summary || (d.status === 'error' ? agent.error : ''), title: prTitle(agent.summary), gates: check.gates, files: check.files, lines: check.lines, weakTest: check.weakTest,
    turns: agent.turns, tokens: agent.tokens, calls: agent.calls, finish: agent.finish, repeats: agent.repeats, toolErrors: agent.toolErrors, compactions: agent.compactions, node: agent.node, wallMs: agent.wallMs });
  say(`${d.status}${d.note ? ` (${d.note})` : ''}: ${result.summary.slice(0, 100)}`);
  await finishUp();
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
