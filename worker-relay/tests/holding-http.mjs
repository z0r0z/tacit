// The real points service (src/points-indexer.js) with the holding reward on, over a temporary database that already holds a pool's events and a snapshot of them:
// what GET /holding/nullifiers/<chain>/<day> sends (the bytes of the answer, with their length, as JSON), what it says for a day with no snapshot, and that a caller
// who reads too often is turned away. Not part of the automatic tests (it starts the service); run it after changing how the route answers:
//   node worker-relay/tests/holding-http.mjs
// Every chain RPC points at a dead local port, so nothing reaches the network: the scan fails and is logged, and the route answers from what the database holds.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { openStore } from '../src/lib/points-store.js';

const PORT = 19300 + Math.floor(Math.random() * 300), CHAIN = 1, EPOCH = 20800, EVENTS = 3000;
const ZERO = `0x${'0'.repeat(64)}`;
const dir = mkdtempSync(join(tmpdir(), 'holding-http-'));
const db = join(dir, 'p.db'), vkFile = join(dir, 'vk.json');
const vk = JSON.stringify({ protocol: 'groth16', nPublic: 7 });
writeFileSync(vkFile, vk);

// A pool's events: every other one inserts a pair of leaves, every one spends two notes.
const w = (n) => { const b = randomBytes(32 * n); return Array.from({ length: n }, (_, i) => `0x${b.toString('hex', i * 32, i * 32 + 32)}`); };
const words = w(EVENTS * 5), events = [];
let size = 0;
for (let i = 0; i < EVENTS; i++) {
  const leaves = i % 2 === 0;
  events.push({ block: 500 + Math.floor(i / 3), logIndex: i % 3, firstIndex: String(leaves ? size : 0), outLeaf0: leaves ? words[i * 5] : ZERO, outLeaf1: leaves ? words[i * 5 + 1] : ZERO, nf0: words[i * 5 + 2], nf1: words[i * 5 + 3], newRoot: words[i * 5 + 4] });
  if (leaves) size += 2;
}
const store = openStore(db);
store.saveHoldingEvents(CHAIN, events);
store.saveHoldingSnapshot({ epoch: EPOCH, chainId: CHAIN, block: events[events.length - 1].block, moment: 1, root: '123', nfRoot: '456', size, nullifiers: EVENTS * 2, takenAt: 1 });
const want = {
  epoch: EPOCH, chainId: CHAIN, block: events[events.length - 1].block, root: '123', nfRoot: '456', size,
  leaves: events.flatMap((e) => (e.outLeaf0 === ZERO && e.outLeaf1 === ZERO ? [] : [e.outLeaf0, e.outLeaf1])), nullifiers: events.flatMap((e) => [e.nf0, e.nf1]),
};

const today = Math.floor(Date.now() / 86400e3), DAY = 86400;
const env = {
  ...process.env, PORT: String(PORT), POINTS_DB_PATH: db, RPC_URL: 'http://127.0.0.1:9', RPC_URLS_FALLBACK: 'http://127.0.0.1:9', POINTS_START_BLOCK: '99999999', POINTS_POLL_SECS: '3600',
  POINTS_PROGRAM_START_SEC: String((today - 24) * DAY),
  HOLDING_ENABLED: '1', HOLDING_VKEY_FILE: vkFile, HOLDING_VKEY_SHA256: createHash('sha256').update(vk).digest('hex'), POINTS_HOLDING_RATE: '500', HOLDING_CHAINS: String(CHAIN),
};
const child = spawn('node', ['src/points-indexer.js'], { cwd: new URL('..', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let up = false;
  for (let i = 0; i < 120 && !up && child.exitCode === null; i++) { await sleep(500); up = /http listening/.test(out); }
  assert.ok(up, `the service did not start:\n${out.slice(-1500)}`);
  assert.match(out, /holding reward on: 1/, 'the holding reward is on');

  const res = await fetch(`http://127.0.0.1:${PORT}/holding/nullifiers/${CHAIN}/${EPOCH}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(Number(res.headers.get('content-length')), bytes.length, 'it says how long the answer is');
  assert.deepEqual(JSON.parse(bytes.toString()), want, 'the leaves and the spent notes are those of the events');
  assert.equal(bytes.toString(), JSON.stringify(want), 'byte for byte what JSON.stringify writes');
  console.log(`ok - GET /holding/nullifiers/${CHAIN}/${EPOCH}: ${(bytes.length / 1024).toFixed(0)} KB, ${want.leaves.length} leaves, ${want.nullifiers.length} spent notes, content-length ${res.headers.get('content-length')}`);

  const none = await fetch(`http://127.0.0.1:${PORT}/holding/nullifiers/${CHAIN}/${EPOCH + 1}`);
  assert.equal(none.status, 404);
  assert.deepEqual(await none.json(), { error: 'no snapshot for that day and chain' });
  const status = await (await fetch(`http://127.0.0.1:${PORT}/holding`)).json();
  assert.equal(status.enabled, true);
  console.log('ok - a day with no snapshot is 404, and /holding says the reward is on');

  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await fetch(`http://127.0.0.1:${PORT}/holding/nullifiers/${CHAIN}/${EPOCH}`)).status);
  assert.equal(codes.includes(429), true, `a caller who reads again and again is turned away: ${codes.join(' ')}`);
  console.log('ok - a caller who reads again and again is turned away:', codes.join(' '));
} finally {
  child.kill('SIGTERM');
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}
console.log('\n3 holding-http checks passed');
process.exit(0);
