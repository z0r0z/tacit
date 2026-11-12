// node digest-gateway.test.mjs -- the running gateway sends the day's digest to the API once, with the secret, and only when it is set up to
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

function boot(name, env) {
  const data = path.join(root, name); mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, 'suggestions.jsonl'), JSON.stringify({ t: Date.now() - 1000, miner: '0x' + 'a'.repeat(40), file: 'dapp/a.js', commit: 'abcdef0123', window: '1-1', line: 1, why: 'the constant should be 2', old: 'const a = 1;', new: 'const a = 2;', status: 'syntax-ok', review: 'new' }) + '\n');
  writeFileSync(path.join(data, 'scan-results.jsonl'), JSON.stringify({ t: Date.now() - 2000, miner: '0x' + 'a'.repeat(40), n: 1 }) + '\n');
  const gw = spawn('node', ['server.mjs', 'serve'], { cwd: here, stdio: 'ignore', env: { ...process.env, EMB: 'off', LLM_URLS: '', DATA_DIR: data, PORT: env.PORT, SCAN_REPO: repo, SCAN_REF: 'main', NUDGER_API: 'http://127.0.0.1:8795', NUDGER_HOUR_UTC: '0', NUDGER_TICK_MS: '300', ...env } });
  return { data, stop: () => gw.kill('SIGTERM') };
}

const on = boot('on', { PORT: '8796', NUDGER_SECRET: 's3cret' });
const deadline = Date.now() + 20000; while (!posts.length && Date.now() < deadline) await sleep(200);
await sleep(1500);   // several more ticks: the day is posted once
check('the gateway posts the digest to the API with the secret', posts.length === 1 && posts[0].url === '/nudger/digest' && posts[0].auth === 'Bearer s3cret');
check('it carries the filed suggestion, credited to its reviewer, and the windows counted', posts[0]?.body.findings?.length === 1 && posts[0].body.findings[0].by === '0xaaaa…aaaa' && posts[0].body.findings[0].status === 'candidate' && posts[0].body.reviewed === 1 && posts[0].body.unit === 'window');
check('the day is kept on the data disk', existsSync(path.join(on.data, 'digest-state.json')) && JSON.parse(readFileSync(path.join(on.data, 'digest-state.json'), 'utf8')).lastDay === new Date().toISOString().slice(0, 10));
on.stop();

posts.length = 0;
const off = boot('off', { PORT: '8797', NUDGER_SECRET: '' });
await sleep(2500);
check('without the secret nothing is posted', posts.length === 0 && !existsSync(path.join(off.data, 'digest-state.json')));
off.stop();

api.close(); rmSync(root, { recursive: true, force: true });
console.log(fails ? `${fails} digest gateway test(s) failed` : 'digest gateway: all tests passed'); process.exit(fails ? 1 : 0);
