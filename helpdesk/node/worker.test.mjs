// node node/worker.test.mjs -- the standalone node against the REAL gateway (server.mjs as a process, community-nodes-only) and a stand-in for the model.
// A visitor's question reaches the node, the node's answer reaches the visitor and is credited, an empty model answer is handed back and the question
// is answered on the next try, a job the node will not run is refused, and the program wants an address.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clampJob, run, MAX_JOB, hardware } from './worker.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname), ROOT = path.dirname(HERE);
const PORT = 8795, API = `http://127.0.0.1:${PORT}`, data = mkdtempSync(path.join(tmpdir(), 'wk-'));
let fails = 0; const check = (n, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── clampJob ──
const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
check('a job is cut down to its id, its messages, a token budget of 16-500 and a temperature of 0-1',
  JSON.stringify(clampJob({ id: 'a', messages: msgs, max_tokens: 5000, temperature: 7 })) === JSON.stringify({ id: 'a', messages: msgs, max_tokens: 500, temperature: 1 })
  && clampJob({ id: 'a', messages: msgs, max_tokens: 1, temperature: -1 }).max_tokens === 16 && clampJob({ id: 'a', messages: msgs }).max_tokens === 300 && clampJob({ id: 'a', messages: msgs }).temperature === 0.2);
check('jobs this node will not run: no id, a long id, no messages, five messages, a message without text, too many bytes',
  [{ messages: msgs }, { id: 'x'.repeat(65), messages: msgs }, { id: 'a', messages: [] }, { id: 'a', messages: Array(5).fill(msgs[0]) }, { id: 'a', messages: [{ role: 'user' }] },
    { id: 'a', messages: [{ role: 'user', content: 'x'.repeat(MAX_JOB) }] }, null, {}].every((j) => clampJob(j) === null));

// ── hardware: what the node says of its machine ──
{ const nv = (text) => () => text; const fake = (o) => hardware({ platform: 'linux', arch: 'x64', totalmem: 64 * 2 ** 30, cores: 16, ...o });
  const a = fake({ run: nv('24564\n24564\n') });
  check('hardware: memory in GB, GPU memory summed over the GPUs, cores, system and chip', a.ram === 64 && a.vram === 48 && a.cores === 16 && a.os === 'linux' && a.arch === 'x64' && a.unified === false, JSON.stringify(a));
  check('hardware: no nvidia-smi (it throws) means no GPU memory, and a blank or odd reply adds none', fake({ run: () => { throw new Error('not found'); } }).vram === 0 && fake({ run: nv('') }).vram === 0 && fake({ run: nv('N/A\n[Not Supported]\n') }).vram === 0);
  const m = fake({ platform: 'darwin', arch: 'arm64', totalmem: 16 * 2 ** 30, cores: 8, run: () => { throw new Error('x'); } });
  check('hardware: Apple silicon shares its memory; an Intel Mac or a Linux box on arm does not', m.os === 'darwin' && m.unified === true && m.vram === 0 && fake({ platform: 'darwin', arch: 'x64', run: nv('') }).unified === false && fake({ platform: 'linux', arch: 'arm64', run: nv('') }).unified === false);
  check('hardware: a system or chip it does not know is left blank, never passed through', (() => { const h = fake({ platform: 'plan9', arch: 'mips', run: nv('') }); return h.os === '' && h.arch === ''; })());
  check('hardware: the real machine answers with sane numbers and nothing that names it', (() => { const h = hardware(); return h.ram > 0 && h.cores > 0 && Object.keys(h).sort().join() === 'arch,cores,os,ram,unified,vram'; })()); }

// ── the gateway and the model ──
let mode = 'ok'; const seen = [];
const STOP = new Set('the and for are you can how what who which with from that this have will does about into your them there'.split(' '));
const model = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const body = JSON.parse(b || '{}'); seen.push(body);
    const user = (body.messages || []).find((m) => m.role === 'user')?.content || '';
    const q = (user.split('QUESTION:').pop() || '').toLowerCase(), ex = user.split('QUESTION:')[0];
    const words = (q.match(/[a-z0-9]{4,}/g) || []).filter((w) => !STOP.has(w));
    const sents = ex.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 20 && s.length < 400);
    const top = sents.map((s) => [words.filter((w) => s.toLowerCase().includes(w)).length, s]).sort((a, c) => c[0] - a[0]).slice(0, 6).map((x) => x[1]);
    const content = mode === 'empty' ? '' : ('FAKE ANSWER. ' + (ex.split('\n').find((l) => l.startsWith('A: '))?.slice(3) ?? top.join(' '))).slice(0, 1200);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => model.on('listening', r));
const LLM = `http://127.0.0.1:${model.address().port}`;

const gw = spawn(process.execPath, ['server.mjs', 'serve'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, EMB: 'off', LLM_URLS: '', DATA_DIR: data, PORT: String(PORT), TRUST_PROXY: '1', RATE_PER_MIN: '1000', LEASE_WAIT_MS: '15000', POINTS_MAX_DAY: '100', SCAN_REPO: '' } });
let log = ''; gw.stderr.on('data', (d) => (log += d)); gw.stdout.on('data', (d) => (log += d));
const ac = new AbortController();
let loop;
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${API}/health`)).ok) break; } catch {} await sleep(250); }
  const miner = '0x' + 'ab'.repeat(20);
  const lines = [];
  loop = run({ api: API, llm: LLM, miner, say: (t) => lines.push(t), signal: ac.signal, idleMs: 200 });
  const ask = async (q) => (await fetch(`${API}/ask`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '7.7.7.7' }, body: JSON.stringify({ q }) })).json();

  const a = await ask('How many TAC exist, and can more be minted?');
  check("a visitor's question is answered by the node", typeof a.answer === 'string' && a.answer.startsWith('FAKE ANSWER') && !a.unavailable, `"${String(a.answer).slice(0, 60)}"`);
  const call = seen.find((c) => c.model === 'local');
  check('the model is asked with thinking off, the job\'s messages and a bounded budget', call?.chat_template_kwargs?.enable_thinking === false && Array.isArray(call.messages) && call.max_tokens >= 16 && call.max_tokens <= 500);
  const cap = (await (await fetch(`${API}/health`)).json()).capacity;
  check('the help desk counts the node by the size of model it can hold, from what the node reported', cap && cap.tiers.big + cap.tiers.small === 1 && cap.tiers.unknown === 0 && cap.ramGb > 0, JSON.stringify(cap));
  const st = await (await fetch(`${API}/helpdesk/stats`)).json();
  check('the answer is credited to the node\'s address', st.miners.some((m) => m.miner === miner.slice(0, 8) + '…' + miner.slice(-4) && m.answered >= 1 && m.points >= 1), JSON.stringify(st.miners));

  mode = 'empty';
  const pending = ask('What do I get for holding TAC?');
  for (let i = 0; i < 500 && !lines.some((l) => /gave up/.test(l)); i++) await sleep(20);   // the first try has failed: the model works from here
  mode = 'ok';
  const b = await pending;
  check('an empty model answer is handed back, and the question is answered on the next try', typeof b.answer === 'string' && b.answer.startsWith('FAKE ANSWER'), `"${String(b.answer).slice(0, 60)}"`);
  check('the node said it gave up', lines.some((l) => /gave up .*no answer/.test(l)), lines.join(' | ').slice(0, 200));
  const st2 = await (await fetch(`${API}/helpdesk/stats`)).json();
  check('and the help desk counted the error against it', st2.miners[0].errors >= 1);

  ac.abort();
  const t0 = Date.now(); await loop;
  check('the node stops when told to', Date.now() - t0 < 3000);

  // a node that takes code reviews only (a slow laptop) leaves a visitor's question in the queue, untouched
  const ac2 = new AbortController();
  const loop2 = run({ api: API, llm: LLM, miner, kinds: ['scan'], say: () => {}, signal: ac2.signal, idleMs: 200 });
  const callsBefore = seen.length;
  const waiting = ask('What backs cBTC?').catch(() => null);   // answered only if some node takes it: none will
  await sleep(3000);
  const st3 = await (await fetch(`${API}/helpdesk/stats`)).json();
  check('a node that takes scan only leaves a visitor question waiting in the queue', st3.queued >= 1 && !seen.slice(callsBefore).some((c) => JSON.stringify(c.messages).includes('cBTC')), `queued ${st3.queued}, model calls since: ${seen.length - callsBefore}`);
  ac2.abort(); await loop2; void waiting;

  const bare = spawnSync(process.execPath, [path.join(HERE, 'worker.mjs')], { env: { ...process.env, MINER: '' }, encoding: 'utf8' });
  check('started without an address it says so and exits', bare.status === 2 && /MINER/.test(bare.stderr));
} finally {
  ac.abort(); gw.kill('SIGTERM'); model.close(); await sleep(100); rmSync(data, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAILED` : 'worker: all tests passed'); if (fails) console.log(log.slice(-600));
process.exit(fails ? 1 : 0);
