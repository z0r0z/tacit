// The real server (server/index.mjs, memory storage) and the community ask over HTTP: an ask with nothing to race answers {}, a posted job is
// raced by the very next ask, a machine's sighting shows on /prover/board, and the same holds with PROVER_BOARD_COMMUNITY_FAST=0. Prints the time
// the asks took with the board holding a long pending list. Not part of the automatic tests (it starts the server):
//   node tests/prover-board-fast-ask-http.mjs [fast|lock]
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const mode = process.argv[2] || 'fast', PORT = 19100 + Math.floor(Math.random() * 400), TOKEN = 'box-token-box-token-1234';
const env = { ...process.env, PORT: String(PORT), CRON_DISABLED: '1', TRUST_PROXY: '1', CONFIDENTIAL_BOX_TOKEN: TOKEN, CACHE_MAX_MB: '16', ...(mode === 'lock' ? { PROVER_BOARD_COMMUNITY_FAST: '0' } : {}) };
delete env.DATABASE_URL; delete env.RENDER;
const child = spawn('node', ['server/index.mjs'], { cwd: new URL('..', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addr = (i) => '0x' + i.toString(16).padStart(40, '0');
const call = async (path, body, auth, ip) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}), ...(ip ? { 'True-Client-IP': ip } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ipOf = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
const claim = (i) => call('/prover/community/claim', { miner: addr(i) }, false, ipOf(i));
const post = (label) => call('/prover/jobs', { class: 'public', stdin: Buffer.from(label).toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: Math.floor(Date.now() / 1000) + 3600, label }, true);
try {
  let up = false;
  for (let i = 0; i < 80 && !up && child.exitCode === null; i++) { await sleep(250); up = /listening on/.test(out); }
  assert.ok(up, `the server did not start:\n${out.slice(-1200)}`);

  // a long pending list: finished jobs stay on it for an hour
  const ids = [];
  for (let i = 0; i < 60; i++) { const r = await post(`old job ${i}`); assert.equal(r.status, 200, JSON.stringify(r)); ids.push(r.body.jobId); }
  for (const id of ids) assert.equal((await call('/prover/jobs/cancel', { jobId: id }, true)).status, 200);

  // nothing to race: {}
  for (let i = 1; i <= 25; i++) { const r = await claim(i); assert.equal(r.status, 200, JSON.stringify(r)); assert.deepEqual(r.body, {}); }

  // time the asks: one after another, then fifty at once
  const t0 = Date.now(); const lat = [];
  for (let k = 0; k < 300; k++) { const s = Date.now(); const r = await claim(1 + (k % 25)); lat.push(Date.now() - s); assert.deepEqual(r.body, {}); }
  const seqMs = (Date.now() - t0) / 300, maxMs = Math.max(...lat);
  const t1 = Date.now();
  const burst = [];                                                              // 200 asks, fifty connections at a time (more overflow the listen backlog of a busy machine)
  for (let g = 0; g < 4; g++) burst.push(...await Promise.all(Array.from({ length: 50 }, (_, k) => { const s = Date.now(); return claim(100 + g * 50 + k).then((r) => { assert.deepEqual(r.body, {}); return Date.now() - s; }); })));
  const burstTotal = Date.now() - t1, burstMean = burst.reduce((a, b) => a + b, 0) / burst.length, burstMax = Math.max(...burst);

  // a posted job is raced by the very next ask, whoever asks
  const posted = await post('a new wrap');
  const j = await claim(7);
  assert.equal(j.status, 200); assert.ok(j.body.job, JSON.stringify(j.body)); assert.equal(j.body.job.jobId, posted.body.jobId); assert.equal(j.body.job.race, true);
  assert.deepEqual((await claim(7)).body, {}, 'one race at a time per machine');
  assert.equal((await claim(8)).body.job.jobId, posted.body.jobId, 'a second machine joins the race');

  // the sighting shows on the board
  const board = await call('/prover/board');
  assert.equal(board.status, 200);
  const w = board.body.workers.find((x) => x.name === 'c-' + addr(7));
  assert.ok(w, 'the machine is on the board'); assert.ok(w.lastSeenSeconds <= 2, `last seen ${w.lastSeenSeconds} s ago`); assert.equal(w.community, true);
  assert.ok(board.body.workers.filter((x) => x.community).length >= 25, 'the others are listed too');
  console.log(`ok (${mode}) - asks: ${seqMs.toFixed(1)} ms each one at a time (slowest ${maxMs} ms); 200 in groups of fifty: mean ${burstMean.toFixed(0)} ms, slowest ${burstMax} ms, all done in ${burstTotal} ms`);
} finally {
  child.kill('SIGKILL');
}
