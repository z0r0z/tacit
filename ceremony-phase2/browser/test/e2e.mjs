// node test/e2e.mjs <workdir> : the whole thing on the toy fixture, with the real coordinator and proxy.
//   two contributions made by the browser code through the HTTPS window's routes (each from its own caller address),
//   one by the existing command straight to the coordinator, and the chain verified link by link.
import { spawn as sp, execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runContribution, useFetch } from '../flow.js';

const W = resolve(process.argv[2] || '.');
const ROOT = resolve(new URL('../..', import.meta.url).pathname);
mkdirSync(W, { recursive: true });
const sh = (cmd, args, opts) => execFileSync(cmd, args, { cwd: W, encoding: 'utf8', ...opts });
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); process.exit(1); } console.log('ok:', m); };

sh('go', ['build', '-o', join(W, 'tacit-ceremony'), './cmd/tacit-ceremony'], { cwd: ROOT });
sh('go', ['build', '-o', join(W, 'fixture'), './rehearsal/fixture'], { cwd: ROOT });
if (!existsSync(join(W, 'fix'))) sh('./fixture', ['make', 'fix'], { env: { ...process.env, FIXTURE_PAD: process.env.PAD || '3000' } });
if (!existsSync(join(W, 'chain'))) sh('./tacit-ceremony', ['init', 'chain', 'fix/phase2-17', '17', 'e2e']);
const key = JSON.parse(readFileSync(join(W, 'chain/state.json'), 'utf8')).coordinator_pubkey;

const CP = 18200, PP = 18202;
const coord = sp(join(W, 'tacit-ceremony'), ['serve', '--per-ip', '1', '--accepted-per-ip', '5', '--heartbeat', '20s', '--claim-window', '60s',
  '--client-ip-header', 'X-Tacit-Client-IP', '--trusted-proxies', '127.0.0.1/32', 'chain', `127.0.0.1:${CP}`], { cwd: W, stdio: ['ignore', 'pipe', 'pipe'] });
const proxy = sp('node', [join(ROOT, 'proxy/server.mjs')], { env: { ...process.env, COORDINATOR_URL: `http://127.0.0.1:${CP}`, PORT: String(PP), ALLOWED_ORIGINS: 'https://tacit.finance' }, stdio: ['ignore', 'pipe', 'pipe'] });
const stop = () => { coord.kill(); proxy.kill(); };
process.on('exit', stop);
await new Promise((r) => setTimeout(r, 2000));

const API = `http://127.0.0.1:${PP}/api/c`;
const asCaller = (ip) => useFetch((u, o = {}) => fetch(u, { ...o, headers: { ...(o.headers || {}), 'true-client-ip': ip } }));
const spawn = () => {
  const w = new Worker(new URL('../worker.js', import.meta.url));
  return { post: (m, t) => w.postMessage(m, t), onmessage: (f) => w.on('message', f), onerror: (f) => w.on('error', f), terminate: () => w.terminate() };
};

asCaller('203.0.113.7');
const who = await (await fetch(`${API}/whoami`, { headers: { 'true-client-ip': '203.0.113.7' } })).json();
ok(who.ip === '203.0.113.7', 'the proxy reports the caller address it forwards');

let seen = [];
const r1 = await runContribution({ api: API, name: 'browser one', spawn, workers: 2, partSize: 1 << 20, onStatus: (s) => seen.push(s.phase) });
ok(r1.index === 18 && seen.includes('work') && seen.at(-1) === 'done', `a contribution through the proxy is accepted as #${r1.index}`);

asCaller('203.0.113.8');
const r2 = await runContribution({ api: API, name: 'browser two', spawn, workers: 2, partSize: 1 << 20 });
ok(r2.index === 19, `and a second one from another address is #${r2.index}`);

// the existing command, straight to the coordinator, still works
const out = sh('./tacit-ceremony', ['contribute', '--coordinator', `http://127.0.0.1:${CP}`, '--coordinator-key', key.trim(), '--name', 'the command', '--receipt-dir', W]);
ok(/contribution|receipt|accepted/i.test(out), 'the existing command still contributes');

const head = JSON.parse(await (await fetch(`http://127.0.0.1:${CP}/api/head`)).text()).index;
sh('./tacit-ceremony', ['verify-chain', 'chain', '17', String(head)]);
ok(true, `phase2-17 .. phase2-${head} verify link by link`);
stop();
console.log('E2E PASSED');
