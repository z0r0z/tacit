// tacit-bot's code agent, Discord side, on the REAL worker over an in-memory store (Discord's and GitHub's APIs are the only things stood in):
//   /pr-agent/report: only with the secret; one message per report (a retry posts nothing twice); no pings, no links but a GitHub PR address, buttons that label it; a touch-up pass
//     that found nothing says nothing.
//   /improve and the "Prepare a PR" message command: only for the people the maintainers allowed, capped per day, text cleaned, one GitHub workflow_dispatch each, and an honest
//     answer when GitHub says no.
//   the "Prepare a fix" button: only when switched on, only in the review channel, once per finding.
// Run: `node tests/pr-agent-api.test.mjs`
import { generateKeyPairSync, sign } from 'node:crypto';
import { createMemDriver } from '../server/driver-mem.mjs';
import { createCacheStorage } from '../server/cache-mem.mjs';
import { parseReport, renderReport, cleanText, parseReport as pr } from '../worker/src/pr-agent.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); } };

globalThis.caches = createCacheStorage({ maxBytes: 8 * 1024 * 1024 });
const { buildEnv, createCtxFactory, createTacitServer } = await import('../server/harness.mjs');
const workerModule = (await import('../worker/src/index.js')).default;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const driver = createMemDriver(); const env = buildEnv(driver);
env.DISCORD_PUBLIC_KEY = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const server = createTacitServer({ workerModule, env, driver, ctxFactory: createCtxFactory() });
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const SECRET = 's'.repeat(40), CH = '323456789012345678', OTHER = '423456789012345678', ASKER = '523456789012345678', STRANGER = '623456789012345678';
const post = (path, body, secret = SECRET) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (path, secret = SECRET) => fetch(`${base}${path}`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
const interact = (payload) => { const body = JSON.stringify(payload), ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${base}/discord/interaction`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': sign(null, Buffer.from(ts + body), privateKey).toString('hex'), 'X-Signature-Timestamp': ts }, body }).then((r) => r.json()); };
const slash = (text, user = ASKER, extra = {}) => interact({ type: 2, id: '777', channel_id: OTHER, member: { user: { id: user, username: 'u' }, roles: [] }, data: { name: 'improve', type: 1, options: text === undefined ? [] : [{ name: 'text', type: 3, value: text }] }, ...extra });
const msgCmd = (content, user = ASKER) => interact({ type: 2, id: '778', channel_id: OTHER, member: { user: { id: user, username: 'u' }, roles: [] }, data: { name: 'Prepare a PR', type: 3, target_id: '999', resolved: { messages: { 999: { id: '999', content } } } } });
const click = (custom_id, { channel = CH, user = ASKER, message } = {}) => interact({ type: 3, channel_id: channel, member: { user: { id: user, username: 'u', global_name: 'U' }, roles: [] }, data: { component_type: 2, custom_id }, message });

const realFetch = globalThis.fetch; const sent = [], gh = []; let nextId = 1, ghStatus = 204;
globalThis.fetch = (url, init) => {
  const u = String(url);
  if (u.startsWith('https://discord.com/')) { sent.push({ url: u, body: JSON.parse(init.body) }); return Promise.resolve(new Response(JSON.stringify({ id: `9${String(nextId++).padStart(17, '0')}` }), { status: 200 })); }
  if (u.startsWith('https://api.github.com/')) { gh.push({ url: u, init, body: JSON.parse(init.body) }); return Promise.resolve(new Response(ghStatus === 204 ? null : '{}', { status: ghStatus })); }
  return realFetch(url, init);
};

const rep = (o = {}) => ({ id: 'r-abc123', kind: 'request', status: 'pr', title: 'add returns the sum of its arguments', text: 'add returns the sum', failedGates: [], files: ['src/add.mjs', 'tests/add-new.test.mjs'], lines: 5, prUrl: 'https://github.com/z0r0z/tacit/pull/4242', turns: 9, model: 'qwen3.6-35b-a3b-q4', source: 'discord', ...o });

// ---- the pure parts
ok('a request\'s text loses links and invites, cannot name anyone, and keeps its lines', cleanText('fix it https://evil.example/x and discord.gg/abc @everyone\n\n\n\nsecond `line`') === "fix it [link] and [link] @​everyone\n\nsecond 'line'");
ok('a report is refused for a bad id, kind or status', [parseReport(null), parseReport({ ...rep(), id: 'x' }), parseReport({ ...rep(), kind: 'rm' }), parseReport({ ...rep(), status: 'merged' }), parseReport([])].every((r) => r.error));
ok('a PR address that is not a GitHub pull request is dropped, and odd numbers fall back', pr(rep({ prUrl: 'https://evil.example/pull/1' })).report.prUrl === '' && pr(rep({ lines: -4, turns: 'x' })).report.lines === 0 && pr(rep()).report.prUrl === 'https://github.com/z0r0z/tacit/pull/4242');
{ const m = renderReport(parseReport(rep()).report, 'n261128-20'); ok('a PR message shows the PR, the files and who made it, pings nobody, shows no previews, and has the three labels', m.content.includes('https://github.com/z0r0z/tacit/pull/4242') && m.content.includes('src/add.mjs') && m.content.includes('qwen3.6-35b-a3b-q4') && m.allowed_mentions.parse.length === 0 && m.flags === 4 && m.components[0].components.map((b) => b.custom_id).join() === 'nudge:useful:n261128-20,nudge:noise:n261128-20,nudge:known:n261128-20'); }

// ---- the report route
ok('without NUDGER_SECRET configured the report route refuses', (await post('/pr-agent/report', rep())).status === 500);
env.NUDGER_SECRET = SECRET;
ok('no token and a wrong token are refused', (await post('/pr-agent/report', rep(), null)).status === 401 && (await post('/pr-agent/report', rep(), 'w'.repeat(40))).status === 401);
ok('a malformed report is refused (400)', (await post('/pr-agent/report', { ...rep(), status: 'merged' })).status === 400 && (await post('/pr-agent/report', 'not json')).status === 400);
ok('with the secret but no channel configured it is refused and posts nothing', (await post('/pr-agent/report', rep())).status === 500 && sent.length === 0);
env.NUDGER_CHANNEL_ID = CH; env.DISCORD_BOT_TOKEN = 'bot-token';
const r1 = await (await post('/pr-agent/report', rep())).json();
ok('a PR report is posted as one message in the review channel', r1.ok && /^n\d{6}-20$/.test(r1.id) && sent.length === 1 && sent[0].url.endsWith(`/channels/${CH}/messages`), r1);
const again = await (await post('/pr-agent/report', rep())).json();
ok('the same report sent again posts nothing twice', again.duplicate === true && again.id === r1.id && sent.length === 1);
const r2 = await (await post('/pr-agent/report', rep({ id: 'r-def456', status: 'suggestion', prUrl: '', title: 'trim the name', text: 'greet should trim @everyone see https://evil.example/a', failedGates: ['new tests fail without the fix: no test was added for the change'], files: ['src/greet.mjs'] }))).json();
const sug = sent[1].body;
ok('a suggestion says it is not a PR and why it was held back, with no link and no ping', r2.ok && sug.content.includes('not a PR') && sug.content.includes('Held back by') && !sug.content.includes('evil.example') && sug.content.includes('[link]') && sug.content.includes('@​everyone') && sug.allowed_mentions.parse.length === 0);
const none = await (await post('/pr-agent/report', rep({ id: 'r-nada01', status: 'nothing', text: 'NOTHING: could not find where' }))).json();
ok('a request that found nothing still gets an answer, without the labels', none.ok && sent[2].body.content.includes('Nothing to change') && sent[2].body.components.length === 0);
const before = sent.length;
const quiet = [await (await post('/pr-agent/report', rep({ id: 't-quiet01', kind: 'touchup', status: 'nothing' }))).json(), await (await post('/pr-agent/report', rep({ id: 't-quiet02', kind: 'touchup', status: 'unavailable' }))).json()];
ok('an autonomous pass that found nothing, or could not run, says nothing in the channel', quiet.every((q) => q.skipped) && sent.length === before);
const t1 = await (await post('/pr-agent/report', rep({ id: 't-found01', kind: 'touchup', title: 'fix a missing await', files: ['dapp/x.js'] }))).json();
ok('but one that opened a PR is posted', t1.ok && sent.length === before + 1);

// ---- a click labels it, and the labels report counts the bot apart
const label = await click(`nudge:useful:${r1.id}`, { user: ASKER });
ok('a click on the report\'s Useful button labels it (the same buttons as a finding)', label.type === 7 && /marked useful/.test(label.data.content), label);
const labels = await (await get('/nudger/labels?since=2026-11-01')).json();
ok('the labels report lists the bot\'s reports, marked as the bot\'s, with its own totals', labels.findings.some((f) => f.id === r1.id && f.agent === true && f.label === 'useful' && f.pr === 'https://github.com/z0r0z/tacit/pull/4242') && labels.agent.posted >= 3 && labels.agent.useful === 1, labels.agent);

// ---- /improve and the message command
ok('with nobody allowed the commands say they are not enabled and call nothing', /not enabled/.test((await slash('make the swap button blue please')).data.content) && gh.length === 0);
env.IMPROVE_USER_IDS = `${ASKER}, 999999999999999999`; env.GITHUB_DISPATCH_TOKEN = 'ghs_' + 'x'.repeat(30);
ok('someone who is not allowed is refused, and nothing is called', /Only the people/.test((await slash('make the swap button blue please', STRANGER)).data.content) && gh.length === 0);
ok('an allowed person with a request that is too short is told so', /dozen characters/.test((await slash('fix it')).data.content) && gh.length === 0);
const q = await slash('Make the swap page say "fee" in the button, see https://evil.example/x and @everyone');
ok('an allowed request starts ONE workflow run, and the answer is private to the asker', /Queued as `r-/.test(q.data.content) && q.data.flags === 64 && gh.length === 1);
const call = gh[0], task = JSON.parse(call.body.inputs.task);
ok('the call goes to the repo\'s workflow with the least-privilege token and nothing else in it', call.url === 'https://api.github.com/repos/z0r0z/tacit/actions/workflows/pr-agent.yml/dispatches' && call.init.headers.Authorization === `Bearer ${env.GITHUB_DISPATCH_TOKEN}` && call.body.ref === 'main' && Object.keys(call.body.inputs).join() === 'task');
ok('the task carries the cleaned text: no link, no way to name anyone, and where it came from', task.kind === 'request' && /^r-[a-z0-9]{6}$/.test(task.id) && !task.text.includes('evil.example') && task.text.includes('[link]') && task.text.includes('@​everyone') && task.source.via === 'discord' && task.source.ref === `${OTHER}:777`, task);
const mc = await msgCmd('The relay fee label on /swap/ still says "gas" after the change; it should say "network fee".');
ok('the "Prepare a PR" message command takes the text of the message it was used on', /Queued as/.test(mc.data.content) && JSON.parse(gh[1].body.inputs.task).text.includes('network fee') && JSON.parse(gh[1].body.inputs.task).source.ref === `${OTHER}:999`);
env.IMPROVE_MAX_DAY = '3'; await slash('Rename the confusing button on the pay page to say Send');
ok('a day\'s total is capped: the fourth ask is refused and calls nothing', /limit/.test((await slash('One more small copy change on the bridge page')).data.content) && gh.length === 3);
delete env.IMPROVE_MAX_DAY;
ok('a person with an allowed ROLE may ask even when not on the list', (() => { env.IMPROVE_ROLE_IDS = '888888888888888888'; return true; })() && /Queued as/.test((await interact({ type: 2, id: '1', channel_id: OTHER, member: { user: { id: STRANGER, username: 's' }, roles: ['888888888888888888'] }, data: { name: 'improve', type: 1, options: [{ name: 'text', type: 3, value: 'Fix the typo in the farm page heading' }] } })).data.content));
delete env.IMPROVE_ROLE_IDS;
ghStatus = 403;
const refused = await slash('Fix the typo in the pool page footer text');
ok('when GitHub refuses the run the asker is told so, plainly', /could not start/.test(refused.data.content) && /403/.test(refused.data.content), refused);
ghStatus = 204; delete env.GITHUB_DISPATCH_TOKEN;
ok('with no GitHub token configured the asker is told it cannot start', /could not start/.test((await slash('Fix the typo in the pool page footer text again')).data.content));
env.GITHUB_DISPATCH_TOKEN = 'ghs_' + 'x'.repeat(30);

// ---- the Prepare a fix button
const fid = 'n261128-3';
ok('with the code agent off a finding has three buttons and no fix button', (await (async () => { const m = (await import('../worker/src/nudger.js')).renderFinding({ id: fid, severity: 'low', status: 'candidate', file: 'a.js', line: 1, claim: 'c' }); return m.components[0].components.length === 3; })()));
ok('with it on a finding has a fourth button, Prepare a fix, with the finding in its id', (await (async () => { const m = (await import('../worker/src/nudger.js')).renderFinding({ id: fid, severity: 'low', status: 'candidate', file: 'a.js', line: 1, claim: 'c' }, { fix: true }); const b = m.components[0].components[3]; return b.label === 'Prepare a fix' && b.custom_id === `nudge:fix:${fid}`; })()));
// post a digest so the finding is stored, with the agent switched on
const dig = await post('/nudger/digest', { day: '2026-11-28', reviewed: 4, findings: [{ id: fid, file: 'dapp/confidential-relay.js', line: 46, severity: 'low', status: 'real', claim: 'status() is not retried, so one failed read ends the poll.', evidence: 'pollStatus() has the retry' }] });
const posted = sent.at(-1).body;
ok('the digest posts the fix button when the agent is on', (await dig.json()).ok && posted.components[0].components.length === 4 && posted.components[0].components[3].custom_id === `nudge:fix:${fid}`);
const before2 = gh.length;
ok('the button refuses another channel and someone who may not ask, and calls nothing', /review channel/.test((await click(`nudge:fix:${fid}`, { channel: OTHER })).data.content) && /Only the people/.test((await click(`nudge:fix:${fid}`, { user: STRANGER })).data.content) && gh.length === before2);
const fx = await click(`nudge:fix:${fid}`, { message: { content: posted.content, components: posted.components } });
ok('a click by an allowed person starts a run for the finding and notes it on the message', fx.type === 7 && /fix requested/.test(fx.data.content) && gh.length === before2 + 1, fx);
const ft = JSON.parse(gh.at(-1).body.inputs.task);
ok('the task is the finding: file, line and claim, with where it came from', ft.kind === 'finding' && ft.id === `f-${fid}` && ft.finding.file === 'dapp/confidential-relay.js' && ft.finding.line === 46 && ft.finding.claim.includes('not retried') && ft.source.ref === fid, ft);
ok('a second click does not start a second run', /already requested/.test((await click(`nudge:fix:${fid}`)).data.content) && gh.length === before2 + 1);
ok('an unknown finding is refused', /no longer stored/.test((await click('nudge:fix:n261128-9')).data.content));

globalThis.fetch = realFetch; server.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
