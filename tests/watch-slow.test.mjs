// The GPU box's slow-regime watcher (contracts/sp1/confidential/prover-worker/watch-slow.sh), and its rolling restarts across two boxes.
//
// 2026-11-19: the box restarts its GPU server about 31 times a day (a Groth16 step over 14 s), each restart takes about a minute, and a user's job posted meanwhile waits: it did in
// 53% of 163 restarts. With a peer box (PEER_WORKERS) a restart is asked for only while the peer is polling the board, so one worker is always warm. A peer seen lately but not polling is
// restarting: wait, at most RECYCLE_PEER_HOLD_SECS. A peer gone for ten minutes, never seen, or a board that cannot be read is no peer to wait for, and a box with no PEER_WORKERS
// recycles exactly as before. The board here is a stand-in server; the script runs for real, on a temp log.
//
// Run: node tests/watch-slow.test.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts/sp1/confidential/prover-worker/watch-slow.sh');
let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
const test = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let workers = [];
const board = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ workers })); });
await new Promise((r) => board.listen(0, '127.0.0.1', r));
const URL_ = `http://127.0.0.1:${board.address().port}`;
const dir = mkdtempSync(join(tmpdir(), 'watch-slow-'));
const envFile = (lines) => { const f = join(dir, `env-${Math.random().toString(36).slice(2)}`); writeFileSync(f, lines.join('\n') + '\n'); return f; };
const BASE = { PATH: process.env.PATH, HOME: process.env.HOME };

// not spawnSync: the stand-in board lives in this process and must be able to answer while the script asks it
const run = (cmd, env) => new Promise((resolve) => {
  const c = spawn('bash', ['-c', cmd], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
  c.on('close', (status) => resolve({ status, stdout, stderr }));
});
const peerReady = (env, peers = 'tacit-b5000') => run(`source "${SCRIPT}"; peer_ready`, { ...BASE, WORKER_ENV: envFile([`PEER_WORKERS="${peers}"`, `BOARD_URL=${URL_}`, 'WORKER_TOKEN=not-printed']), ...env });

await test('no PEER_WORKERS: nothing to wait for', async () => {
  const r = await run(`source "${SCRIPT}"; peer_ready`, { ...BASE, WORKER_ENV: envFile(['WORKER_NAME=tacit-a5000']) });
  ok(r.status === 0, `exit ${r.status}`);
});

await test('a peer polling now takes the jobs: go ahead', async () => {
  workers = [{ name: 'tacit-b5000', lastSeenSeconds: 2 }, { name: 'tacit-a5000', lastSeenSeconds: 0 }];
  ok((await peerReady({})).status === 0, 'did not go ahead');
});

await test('a peer seen lately but not polling is restarting: wait', async () => {
  workers = [{ name: 'tacit-b5000', lastSeenSeconds: 40 }];
  ok((await peerReady({})).status === 1, 'went ahead while the peer restarted');
  workers = [{ name: 'tacit-b5000', lastSeenSeconds: 6 }];
  ok((await peerReady({})).status === 1, 'six seconds is not polling');
  workers = [{ name: 'tacit-b5000', lastSeenSeconds: 600 }];
  ok((await peerReady({})).status === 1, 'ten minutes is still the edge of a restart');
});

await test('a peer gone for over ten minutes, or never seen, or not on the board: no peer to wait for', async () => {
  workers = [{ name: 'tacit-b5000', lastSeenSeconds: 601 }]; ok((await peerReady({})).status === 0, 'waited for a peer that is gone');
  workers = [{ name: 'tacit-b5000', lastSeenSeconds: null }]; ok((await peerReady({})).status === 0, 'waited for a peer never seen');
  workers = [{ name: 'tacit-a5000', lastSeenSeconds: 0 }]; ok((await peerReady({})).status === 0, 'waited for a peer not on the board');
});

await test('any of several peers polling is enough, and only the named peers count', async () => {
  workers = [{ name: 'tacit-b5000', lastSeenSeconds: 50 }, { name: 'tacit-c5000', lastSeenSeconds: 1 }];
  ok((await peerReady({}, 'tacit-b5000,tacit-c5000')).status === 0, 'one of two polling is enough');
  ok((await peerReady({}, 'tacit-b5000')).status === 1, 'a worker that is not a named peer counted');
  workers = [{ name: 'c-0xabc', community: true, lastSeenSeconds: 1 }, { name: 'tacit-b5000', lastSeenSeconds: 50 }];
  ok((await peerReady({})).status === 1, 'a community machine stood in for the peer');
});

await test('a board that cannot be read is no reason to hold the recycle', async () => {
  const r = await run(`source "${SCRIPT}"; peer_ready`, { ...BASE, WORKER_ENV: envFile(['PEER_WORKERS=tacit-b5000', 'BOARD_URL=http://127.0.0.1:9']) });
  ok(r.status === 0, `exit ${r.status}`);
});

await test('the settings come from the environment first, and worker.env is never echoed', async () => {
  workers = [{ name: 'tacit-z', lastSeenSeconds: 40 }];
  const r = await run(`source "${SCRIPT}"; peer_ready; echo "rc=$?"`, { ...BASE, PEER_WORKERS: 'tacit-z', BOARD_URL: URL_, WORKER_ENV: envFile(['PEER_WORKERS=tacit-other', 'WORKER_TOKEN=s3cret-token']) });
  ok(/rc=1/.test(r.stdout), `got ${r.stdout}`);
  ok(!/s3cret/.test(r.stdout + r.stderr), 'a worker.env value was printed');
});

// the script itself, on a temp log
async function watch({ env, lines, waitMs, peerAfterMs = null }) {
  const log = join(dir, `w-${Math.random().toString(36).slice(2)}.log`), flag = `${log}.recycle`;
  writeFileSync(log, '');
  const child = spawn('bash', [SCRIPT], { env: { ...BASE, WORKER_LOG: log, RECYCLE_FLAG: flag, ...env }, detached: true, stdio: 'ignore' });
  await sleep(400);
  for (const l of lines) appendFileSync(log, l + '\n');
  const t0 = Date.now();
  let at = null;
  while (Date.now() - t0 < waitMs) { if (peerAfterMs != null && Date.now() - t0 > peerAfterMs) workers = [{ name: 'tacit-b5000', lastSeenSeconds: 1 }]; if (existsSync(flag)) { at = Date.now() - t0; break; } await sleep(100); }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { }
  await sleep(100);
  return { at, said: readFileSync(log, 'utf8') };
}
const slow = (ms) => `\u001b[90m01:33:53\u001b[0m DBG prover done \u001b[36mbackend=\u001b[0mgroth16 \u001b[36mtook=\u001b[0m${ms}`;
const FAST = { RECYCLE_JITTER_SECS: '1', RECYCLE_PEER_POLL_SECS: '1' };

await test('a box with no peer recycles at once on a slow step, as it always did, and a healthy step asks for nothing', async () => {
  const a = await watch({ env: { WORKER_ENV: envFile(['WORKER_NAME=tacit-a5000']) }, lines: [slow(15000)], waitMs: 4000 });
  ok(a.at != null && a.at < 3000, `no flag in time (${a.at})`);
  ok(/recycle asked\n/.test(a.said) && !/after \d+ s/.test(a.said), 'the log line changed');
  const b = await watch({ env: { WORKER_ENV: envFile(['WORKER_NAME=tacit-a5000']) }, lines: [slow(9000), slow(13999)], waitMs: 2000 });
  ok(b.at == null, 'a step under 14 s asked for a recycle');
});

await test('with a peer polling, the recycle is asked for after only the short pause', async () => {
  workers = [{ name: 'tacit-b5000', lastSeenSeconds: 1 }];
  const r = await watch({ env: { ...FAST, WORKER_ENV: envFile(['PEER_WORKERS=tacit-b5000', `BOARD_URL=${URL_}`]) }, lines: [slow(27000)], waitMs: 5000 });
  ok(r.at != null && r.at < 3500, `slow to ask (${r.at})`);
});

await test('with a peer restarting, the recycle waits for it and then goes ahead', async () => {
  workers = [{ name: 'tacit-b5000', lastSeenSeconds: 30 }];
  const r = await watch({ env: { ...FAST, WORKER_ENV: envFile(['PEER_WORKERS=tacit-b5000', `BOARD_URL=${URL_}`]) }, lines: [slow(27000)], waitMs: 9000, peerAfterMs: 2500 });
  ok(r.at != null && r.at >= 2500, `asked while the peer was still restarting (${r.at})`);
  ok(/after \d+ s for a peer to be back/.test(r.said), `the log does not say it waited: ${r.said}`);
});

await test('a peer that never comes back holds the recycle only for the hold, then it goes ahead', async () => {
  workers = [{ name: 'tacit-b5000', lastSeenSeconds: 30 }];
  const r = await watch({ env: { ...FAST, RECYCLE_PEER_HOLD_SECS: '3', WORKER_ENV: envFile(['PEER_WORKERS=tacit-b5000', `BOARD_URL=${URL_}`]) }, lines: [slow(27000)], waitMs: 9000 });
  ok(r.at != null && r.at >= 3000 && r.at < 8000, `the hold was ${r.at} ms`);
});

board.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
