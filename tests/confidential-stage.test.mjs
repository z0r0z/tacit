// Where a job being proved stands at the prover board (worker/src/confidential-settle.js stageJob, jobStatus; worker/src/index.js POST /confidential/stage).
//
// 2026-11-19: a withdrawal waited 54 s for the GPU box, which was restarting its GPU server, and the page showed one bar for the whole 89 s. The relay now says where the job
// stands ('queued', 'starting', 'claimed') and the page names it. The word is the relay's, kept on the job while it is proved, read only while it is proved, and cleared when the job
// is claimed again; a job that is not being proved takes none, and nothing but the three words is kept.
//
// Run: node tests/confidential-stage.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeConfidentialSettler } from '../worker/src/confidential-settle.js';

const hash = (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
const test = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; } };

function kvStorage() {
  const m = new Map();
  return {
    getPending: async () => JSON.parse(m.get('pending') || '[]'), putPending: async (ids) => { m.set('pending', JSON.stringify(ids)); },
    getJob: async (id) => (m.has('job:' + id) ? JSON.parse(m.get('job:' + id)) : null), putJob: async (id, j) => { m.set('job:' + id, JSON.stringify(j)); },
  };
}
const settler = () => makeConfidentialSettler({ storage: kvStorage(), hash, sleep: () => Promise.resolve() });
const op = (n) => ({ reserveAPre: 1000 + n, reserveBPre: 1000, intents: [{ amountIn: 100 + n }] });
const claimed = async (q) => { const { jobId } = await q.submitJob({ type: 'swap', op: op(1) }); await q.nextJob(); return jobId; };

await test('a job being proved carries the stage the relay last said, and says so on its status', async () => {
  const q = settler(), id = await claimed(q);
  ok((await q.jobStatus(id)).stage === undefined, 'a stage before one was said');
  ok((await q.stageJob(id, 'queued')).ok, 'queued refused');
  let st = await q.jobStatus(id);
  ok(st.status === 'proving' && st.stage === 'queued' && st.stageAt > 0, JSON.stringify(st));
  await q.stageJob(id, 'starting'); ok((await q.jobStatus(id)).stage === 'starting', 'starting not kept');
  await q.stageJob(id, 'claimed'); ok((await q.jobStatus(id)).stage === 'claimed', 'claimed not kept');
});

await test('only the three words are kept, and the same word again changes nothing', async () => {
  const q = settler(), id = await claimed(q);
  await q.stageJob(id, 'claimed');
  const at = (await q.jobStatus(id)).stageAt;
  for (const bad of ['proving', '', 'CLAIMED', '<b>x</b>', null, undefined]) { const r = await q.stageJob(id, bad); ok(r.ok === false, `${bad} taken`); }
  ok((await q.jobStatus(id)).stage === 'claimed', 'a refused word changed the stage');
  await q.stageJob(id, 'claimed');
  ok((await q.jobStatus(id)).stageAt === at, 'the same word moved its time');
});

await test('a job that is not being proved takes no stage, and an unknown job is refused', async () => {
  const q = settler();
  const { jobId } = await q.submitJob({ type: 'swap', op: op(2) });
  const r = await q.stageJob(jobId, 'queued');
  ok(r.ok && r.ignored, 'a pending job took one');
  ok((await q.jobStatus(jobId)).stage === undefined, 'a pending job shows one');
  ok((await q.stageJob('0x' + '00'.repeat(32), 'queued')).ok === false, 'an unknown job was accepted');
});

await test('the stage is gone once the job settles, and a job claimed again starts without one', async () => {
  const q = settler(), id = await claimed(q);
  await q.stageJob(id, 'claimed');
  await q.ackJob(id, { txHash: '0x' + '11'.repeat(32) });
  const done = await q.jobStatus(id);
  ok(done.status === 'settled' && done.stage === undefined, JSON.stringify(done));
  // a failed-and-requeued job: claimed twice, the second time with nothing said yet
  const q2 = settler(), { jobId } = await q2.submitJob({ type: 'swap', op: op(3) });
  await q2.nextJob(); await q2.stageJob(jobId, 'starting');
  await q2.ackJob(jobId, { error: 'prove failed: the prover network timed out', requeue: true });
  const again = await q2.nextJob();
  if (again) ok((await q2.jobStatus(jobId)).stage === undefined, 'the stage of the earlier claim came back');
});

await test('the route is the relay\'s own: it checks the token and the job id, and nothing else reads the stage in', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'worker/src/index.js'), 'utf8');
  const h = src.slice(src.indexOf('async function handleConfidentialStage'), src.indexOf('let _openCache = null;'));
  ok(/checkConfidentialAuth\(req, env\)\) return jsonResponse\(\{ error: 'not found' \}, 404/.test(h), 'no token check');
  ok(/\^0x\[0-9a-f\]\{64\}\$/.test(h), 'no job id check');
  ok(/url\.pathname === '\/confidential\/stage' && req\.method === 'POST'/.test(src), 'route not wired');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
