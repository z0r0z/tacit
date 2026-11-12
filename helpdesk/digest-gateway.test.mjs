// node digest-gateway.test.mjs -- the running gateway sends the day's digest to the API once, with the secret, and only when it is set up to; with the review swarm on
// (the default) only findings the skeptics confirmed go, and /stats shows how the review stands
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
let fails = 0; const check = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const here = path.dirname(new URL(import.meta.url).pathname);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(path.join(tmpdir(), 'dgw-')); const repo = path.join(root, 'repo'); mkdirSync(path.join(repo, 'dapp'), { recursive: true });
const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
git('init', '-q', '-b', 'main'); writeFileSync(path.join(repo, 'dapp/a.js'), 'const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'one');

const posts = []; const api = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { posts.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b || '{}') }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }); });
await new Promise((r) => api.listen(8795, '127.0.0.1', r));

const MINER = '0x' + 'a'.repeat(40);
const ID = 'abc1234567';
function boot(name, env, { votes = [] } = {}) {
  const data = path.join(root, name); mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, 'suggestions.jsonl'), JSON.stringify({ t: Date.now() - 1000, id: ID, miner: MINER, file: 'dapp/a.js', commit: 'abcdef0123', window: '1-1', line: 1, why: 'the constant should be 2', old: 'const a = 1;', new: 'const a = 2;', status: 'syntax-ok', review: 'new' }) + '\n');
  writeFileSync(path.join(data, 'scan-results.jsonl'), JSON.stringify({ t: Date.now() - 2000, miner: MINER, n: 1 }) + '\n');
  if (votes.length) writeFileSync(path.join(data, 'scan-checks.jsonl'), votes.map((v) => JSON.stringify({ t: Date.now() - 500, id: ID, miner: '0x' + 'b'.repeat(40), tier: 'small', verdict: 'real', vote: 'real', grounded: true, ...v })).join('\n') + '\n');
  const gw = spawn('node', ['server.mjs', 'serve'], { cwd: here, stdio: 'ignore', env: { ...process.env, EMB: 'off', LLM_URLS: '', DATA_DIR: data, PORT: env.PORT, SCAN_REPO: repo, SCAN_REF: 'main', NUDGER_API: 'http://127.0.0.1:8795', NUDGER_HOUR_UTC: '0', NUDGER_TICK_MS: '300', ...env } });
  return { data, port: env.PORT, stop: () => gw.kill('SIGTERM') };
}
async function waitPost(ms = 20000) { const end = Date.now() + ms; while (!posts.length && Date.now() < end) await sleep(200); await sleep(1500); }   // then several more ticks: the day is posted once
const stats = async (g) => { for (let i = 0; i < 20; i++) { try { return await (await fetch(`http://127.0.0.1:${g.port}/stats`)).json(); } catch { await sleep(300); } } return null; };

// legacy: SWARM=0 posts what was filed, checked or not
{
  const g = boot('legacy', { PORT: '8796', NUDGER_SECRET: 's3cret', SWARM: '0' }); await waitPost();
  check('the gateway posts the digest to the API with the secret', posts.length === 1 && posts[0].url === '/nudger/digest' && posts[0].auth === 'Bearer s3cret');
  check('it carries the filed suggestion, credited to its reviewer, and the windows counted', posts[0]?.body.findings?.length === 1 && posts[0].body.findings[0].by === '0xaaaa…aaaa' && posts[0].body.findings[0].status === 'candidate' && posts[0].body.reviewed === 1 && posts[0].body.unit === 'window' && posts[0].body.findings[0].subject === 'window 1-1');
  check('the day is kept on the data disk', existsSync(path.join(g.data, 'digest-state.json')) && JSON.parse(readFileSync(path.join(g.data, 'digest-state.json'), 'utf8')).lastDay === new Date().toISOString().slice(0, 10));
  check('with the swarm off /stats has no swarm', (await stats(g)).swarm === null);
  g.stop();
}
// swarm, confirmed by two skeptics
posts.length = 0;
{
  const g = boot('confirmed', { PORT: '8797', NUDGER_SECRET: 's3cret' }, { votes: [{ node: 'n1' }, { node: 'n2' }] }); await waitPost();
  check('with the swarm on, a finding two skeptics confirmed is posted, with how they voted', posts.length === 1 && posts[0].body.findings.length === 1 && posts[0].body.findings[0].subject === 'window 1-1 · 2 of 2 checkers say real');
  const st = await stats(g);
  check('/stats shows the findings by state and the exam results', st.swarm && st.swarm.findings.confirmed === 1 && st.swarm.findings.pending === 0 && st.swarm.exam.scout.n === 0 && st.swarm.exam.skeptic.n === 0);
  g.stop();
}
// swarm, not yet checked
posts.length = 0;
{
  const g = boot('unchecked', { PORT: '8798', NUDGER_SECRET: 's3cret' }); await waitPost();
  check('with the swarm on, a finding nobody has checked is not posted: a quiet day is', posts.length === 1 && posts[0].body.findings.length === 0 && posts[0].body.reviewed === 1);
  const st = await stats(g);
  check('and /stats says it is waiting', st.swarm.findings.pending === 1 && st.swarm.findings.confirmed === 0);
  g.stop();
}
// a node that says what model it runs is shown by it, and takes review work like any other
posts.length = 0;
{
  const g = boot('node', { PORT: '8799', NUDGER_SECRET: '' });
  await stats(g);
  const lease = await fetch(`http://127.0.0.1:${g.port}/helpdesk/lease`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ miner: '0x' + 'e'.repeat(40), kinds: ['scan'], model: 'qwen3.5-4b-q4_k_m', hw: { ram: 16, vram: 6, cores: 8, os: 'linux', arch: 'x64' } }) });
  const job = lease.status === 200 ? await lease.json() : null;
  check('a node asking for scan work is given a job that looks like any other', job && job.kind === 'scan' && Array.isArray(job.messages) && !('meta' in job) && !('exam' in job));
  const local = await (await fetch(`http://127.0.0.1:${g.port}/helpdesk/stats`)).json();
  check('the stats name the model each node says it runs', local.nodes.some((n) => n.model === 'qwen3.5-4b-q4_k_m' && n.tier === 'small'));
  check('with no secret nothing is posted', posts.length === 0 && !existsSync(path.join(g.data, 'digest-state.json')));
  g.stop();
}
api.close(); rmSync(root, { recursive: true, force: true });
console.log(fails ? `${fails} digest gateway test(s) failed` : 'digest gateway: all tests passed'); process.exit(fails ? 1 : 0);
