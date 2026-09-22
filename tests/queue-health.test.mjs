// The settle queue is observable via /confidential/queue, and a stopped relay is distinguishable from an
// idle one. The settle service only heartbeats on job events, so a stalled queue would otherwise go
// unnoticed until pending jobs pile up. The signature of a dead relay is a queue whose OLDEST pending job
// keeps aging; an empty queue means nothing (it may simply be idle).
//
// Run: node tests/queue-health.test.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeConfidentialSettler } from '../worker/src/confidential-settle.js';
import { queueVerdict } from '../worker-relay/src/lib/queue-health.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const hash = (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
const test = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; } };

let t = 1_000_000; const now = () => t;
function store() {
  const jobs = new Map(); let pending = [];
  return {
    getPending: async () => pending.slice(), putPending: async (ids) => { pending = ids.slice(); },
    getJob: async (id) => (jobs.has(id) ? JSON.parse(JSON.stringify(jobs.get(id))) : null),
    putJob: async (id, job) => { jobs.set(id, JSON.parse(JSON.stringify(job))); },
  };
}
const mk = () => makeConfidentialSettler({ storage: store(), hash, now, sleep: () => Promise.resolve() });
const opN = (n) => ({ reserveAPre: 1000 + n, reserveBPre: 1000, intents: [{ amountIn: 100 + n }] });

console.log('queue health:\n');

await test('an empty queue reports zeros — idle, not broken', async () => {
  const q = mk();
  const s = await q.queueStats();
  ok(s.pending === 0 && s.proving === 0 && s.oldestPendingSec === 0 && s.oldestProvingSec === 0, JSON.stringify(s));
});

await test('the oldest pending job\'s age grows with the clock', async () => {
  const q = mk();
  await q.submitJob({ type: 'swap', op: opN(1) });
  t += 40_000;
  await q.submitJob({ type: 'swap', op: opN(2) }); // a NEWER job must not hide the older one
  t += 20_000;
  const s = await q.queueStats();
  ok(s.pending === 2, `pending ${s.pending}`);
  ok(s.oldestPendingSec === 60, `oldest pending should be 60s (the first job), got ${s.oldestPendingSec}`);
});

await test('a claimed job moves from pending to proving and is aged from its claim, not its creation', async () => {
  const q = mk();
  await q.submitJob({ type: 'swap', op: opN(10) });
  t += 100_000;                       // waited 100s before anyone claimed it
  await q.nextJob();                  // claimed now
  t += 30_000;
  const s = await q.queueStats();
  ok(s.pending === 0 && s.proving === 1, JSON.stringify(s));
  ok(s.oldestProvingSec === 30, `proving age should count from the claim (30s), got ${s.oldestProvingSec}`);
});

await test('settled and failed jobs leave the queue stats', async () => {
  const q = mk();
  const a = await q.submitJob({ type: 'swap', op: opN(20) });
  const b = await q.submitJob({ type: 'swap', op: opN(21) });
  await q.nextJob(); await q.nextJob();
  await q.ackJob(a.jobId, { txHash: '0x' + '11'.repeat(32) });
  await q.ackJob(b.jobId, { error: 'boom' });
  const s = await q.queueStats();
  ok(s.pending === 0 && s.proving === 0, `finished jobs must not count as waiting: ${JSON.stringify(s)}`);
});

await test('the stats carry counts and ages ONLY — nothing about any job\'s contents', async () => {
  const q = mk();
  await q.submitJob({ type: 'swap', op: opN(30) });
  const s = await q.queueStats();
  ok(JSON.stringify(Object.keys(s).sort()) === JSON.stringify(['oldestPendingSec', 'oldestProvingSec', 'pending', 'proving']), `unexpected fields: ${Object.keys(s)}`);
});

// ── the verdict ──
const TH = { pendingWarnSec: 300, pendingCriticalSec: 900, provingStuckSec: 1200 };
await test('verdict: healthy, waiting, and stuck are distinguished by the oldest pending age', () => {
  ok(queueVerdict({ pending: 0, proving: 0, oldestPendingSec: 0, oldestProvingSec: 0 }, TH).level === 'ok', 'an empty queue is ok');
  ok(queueVerdict({ pending: 1, proving: 0, oldestPendingSec: 20, oldestProvingSec: 0 }, TH).level === 'ok', 'a job seconds old is ok');
  ok(queueVerdict({ pending: 2, proving: 0, oldestPendingSec: 400, oldestProvingSec: 0 }, TH).level === 'warning', '400s is a warning');
  ok(queueVerdict({ pending: 2, proving: 0, oldestPendingSec: 1000, oldestProvingSec: 0 }, TH).level === 'critical', '1000s is critical — a dead relay');
});
await test('verdict: a job stuck "proving" past the timeout is flagged even when nothing is pending', () => {
  const v = queueVerdict({ pending: 0, proving: 1, oldestPendingSec: 0, oldestProvingSec: 1500 }, TH);
  ok(v.level === 'warning' && /proving/.test(v.reason), JSON.stringify(v));
});
await test('verdict: critical wins over a proving warning; missing stats are unknown, never ok', () => {
  ok(queueVerdict({ pending: 3, proving: 1, oldestPendingSec: 2000, oldestProvingSec: 2000 }, TH).level === 'critical', 'critical must win');
  ok(queueVerdict(null, TH).level === 'unknown' && queueVerdict({}, TH).level === 'unknown', 'no stats must not read as healthy');
});

// ── wiring ──
const worker = readFileSync(join(ROOT, 'worker/src/index.js'), 'utf8');
const monitor = readFileSync(join(ROOT, 'worker-relay/src/balance-monitor.js'), 'utf8');
await test('the route is registered and box-token gated', () => {
  ok(/url\.pathname === '\/confidential\/queue' && req\.method === 'GET'\) return handleConfidentialQueue/.test(worker), 'route not registered');
  const fn = worker.slice(worker.indexOf('async function handleConfidentialQueue'), worker.indexOf('async function handleConfidentialJob'));
  ok(/checkConfidentialAuth\(req, env\)\) return jsonResponse\(\{ error: 'not found' \}, 404/.test(fn), 'the queue route must be auth-gated (404 when unauthenticated)');
});
await test('the monitor runs the queue check, and a critical/warning becomes an alert', () => {
  ok(/checkQueue\(\)\]/.test(monitor), 'checkQueue is not run');
  ok(/if \(v\.level === 'critical' \|\| v\.level === 'warning'\) await alert\(v\.level/.test(monitor), 'the verdict must raise an alert');
  ok(/\/confidential\/queue/.test(monitor) && /Bearer \$\{CFG\.boxToken\}/.test(monitor), 'the monitor must call the gated route with the box token');
});
await test('a worker that predates the route degrades quietly instead of failing the run', () => {
  ok(/worker predates the route/.test(monitor) && /return;/.test(monitor.slice(monitor.indexOf('async function checkQueue'), monitor.indexOf('async function checkSnapshotCapacity'))), 'a 404 must be logged and skipped');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
