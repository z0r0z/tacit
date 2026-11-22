// The relay job queue keeps its pending list and job records consistent when requests overlap.
//
// Storage here resolves every get/put on a later timer tick (like a networked KV), so two requests that
// interleave really do interleave. Each accepted submit must be claimable, a terminal ack must leave the
// queue, and a queue entry must never be replaced by a concurrent request's stale copy.
//
// Run: node tests/confidential-queue-atomic.test.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeConfidentialSettler, buildConfidentialSettler } from '../worker/src/confidential-settle.js';

const hash = (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
let pass = 0, fail = 0;
const ok = (c, m) => { if (!c) throw new Error(m); };
const test = async (label, fn) => { try { await fn(); console.log(`  PASS  ${label}`); pass++; } catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; } };
const tick = () => new Promise((r) => setTimeout(r, 1));

// Raw string KV whose every operation completes on a separate timer tick.
function slowKV({ failPendingPut = false } = {}) {
  const m = new Map();
  const kv = {
    m,
    failPendingPut,
    get: async (k) => { await tick(); return m.has(k) ? m.get(k) : null; },
    put: async (k, v) => { await tick(); if (kv.failPendingPut && k === 'cps:pending') throw new Error('kv write failed'); m.set(k, String(v)); },
  };
  return kv;
}
const storageOver = (kv) => ({
  getPending: async () => { const s = await kv.get('cps:pending'); return s ? JSON.parse(s) : []; },
  putPending: async (ids) => kv.put('cps:pending', JSON.stringify(ids)),
  getJob: async (id) => { const s = await kv.get('cps:job:' + id); return s ? JSON.parse(s) : null; },
  putJob: async (id, job) => kv.put('cps:job:' + id, JSON.stringify(job)),
});
const noSleep = () => Promise.resolve();
const settlerOver = (kv, extra = {}) => makeConfidentialSettler({ storage: storageOver(kv), hash, sleep: noSleep, ...extra });
const opN = (n) => ({ reserveAPre: 1000 + n, reserveBPre: 1000, intents: [{ amountIn: 100 + n }] });
const queued = async (kv) => JSON.parse(kv.m.get('cps:pending') || '[]');

console.log('confidential queue atomicity:\n');

await test('concurrent submits of different ops are all queued', async () => {
  const kv = slowKV(); const q = settlerOver(kv);
  const rs = await Promise.all([1, 2, 3, 4].map((n) => q.submitJob({ type: 'swap', op: opN(n) })));
  const ids = new Set(rs.map((r) => r.jobId));
  ok(ids.size === 4, `distinct ids ${ids.size}`);
  const pend = await queued(kv);
  for (const id of ids) ok(pend.includes(id), `accepted ${id.slice(0, 10)} missing from queue ${pend.length}/4`);
});

await test('every accepted submit is claimable in turn', async () => {
  const kv = slowKV(); const q = settlerOver(kv);
  const rs = await Promise.all([1, 2].map((n) => q.submitJob({ type: 'swap', op: opN(n) })));
  const got = new Set();
  for (let i = 0; i < 2; i++) { const j = await q.nextJob(); ok(j, `claim ${i} came back empty`); got.add(j.jobId); }
  for (const r of rs) ok(got.has(r.jobId), 'an accepted job was never handed out');
});

await test('submits through separate per-request settlers over one KV do not overwrite each other', async () => {
  const kv = slowKV();
  const env = { CONFIDENTIAL_KV: kv };
  const mk = () => buildConfidentialSettler(env, { hash });
  const rs = await Promise.all([1, 2, 3].map((n) => mk().submitJob({ type: 'swap', op: opN(n) })));
  const pend = await queued(kv);
  for (const r of rs) ok(pend.includes(r.jobId), 'accepted job missing from queue');
});

await test('per-request settlers over one KV read each queued job once for the order, not on every request', async () => {
  const kv = slowKV();
  const env = { CONFIDENTIAL_KV: kv };
  const mk = () => buildConfidentialSettler(env, { hash });
  for (const n of [1, 2, 3, 4]) await mk().submitJob({ type: n % 2 ? 'swap' : 'transfer', op: opN(n), client: `c${n}/24` });
  let reads = 0;
  const getOrig = kv.get;
  kv.get = async (k) => { if (String(k).startsWith('cps:job:')) reads++; return getOrig(k); };
  await mk().nextJob();
  kv.get = getOrig;
  ok(reads <= 2, `the order reads no job record (the claim reads one twice): ${reads} reads for four queued jobs`);
});

await test('submit racing a claim keeps both the claim and the new entry', async () => {
  const kv = slowKV(); const q = settlerOver(kv);
  const a = await q.submitJob({ type: 'swap', op: opN(1) });
  const [claimed, b] = await Promise.all([q.nextJob(), q.submitJob({ type: 'swap', op: opN(2) })]);
  ok(claimed && claimed.jobId === a.jobId, 'claim should hand out the first job');
  const pend = await queued(kv);
  ok(pend.includes(a.jobId) && pend.includes(b.jobId), `queue ${JSON.stringify(pend.map((x) => x.slice(0, 8)))}`);
  const st = await q.jobStatus(a.jobId);
  ok(st.status === 'proving', `first job status ${st.status}`);
});

await test('submit racing an ack leaves the acked job out and the new job in', async () => {
  const kv = slowKV(); const q = settlerOver(kv);
  const a = await q.submitJob({ type: 'swap', op: opN(1) });
  await q.nextJob();
  const [, b] = await Promise.all([q.ackJob(a.jobId, { txHash: '0x' + '11'.repeat(32) }), q.submitJob({ type: 'swap', op: opN(2) })]);
  const pend = await queued(kv);
  ok(!pend.includes(a.jobId), 'acked job is still queued');
  ok(pend.includes(b.jobId), 'new job dropped from the queue');
});

await test('two acks racing each other both leave the queue', async () => {
  const kv = slowKV(); const q = settlerOver(kv);
  const a = await q.submitJob({ type: 'swap', op: opN(1) });
  const b = await q.submitJob({ type: 'swap', op: opN(2) });
  await Promise.all([q.ackJob(a.jobId, { txHash: '0x' + '11'.repeat(32) }), q.ackJob(b.jobId, { txHash: '0x' + '22'.repeat(32) })]);
  const pend = await queued(kv);
  ok(pend.length === 0, `queue still holds ${pend.length}`);
});

await test('a job record that never reached the queue is re-queued by the retry', async () => {
  const kv = slowKV(); const q = settlerOver(kv);
  const id = q.jobIdOf('swap', opN(9));
  kv.m.set('cps:job:' + id, JSON.stringify({ id, type: 'swap', op: opN(9), mode: 'settle', memos: [], status: 'pending', createdAt: 1, claimedAt: 0 }));
  ok((await queued(kv)).length === 0, 'precondition: queue empty');
  const r = await q.submitJob({ type: 'swap', op: opN(9) });
  ok(r.jobId === id, 'same id expected');
  ok((await queued(kv)).includes(id), 'orphaned job was not re-queued');
  const j = await q.nextJob();
  ok(j && j.jobId === id, 'the recovered job is claimable');
});

await test('a healthy duplicate submit is still a plain dedupe hit', async () => {
  const kv = slowKV(); const q = settlerOver(kv);
  const a = await q.submitJob({ type: 'swap', op: opN(3) });
  const again = await q.submitJob({ type: 'swap', op: opN(3) });
  ok(again.deduped === true && again.jobId === a.jobId && again.status === 'pending', JSON.stringify(again));
  ok((await queued(kv)).length === 1, 'duplicate must not add a second entry');
});

await test('concurrent duplicates of one op yield one queue entry', async () => {
  const kv = slowKV(); const q = settlerOver(kv);
  const rs = await Promise.all([1, 2, 3].map(() => q.submitJob({ type: 'swap', op: opN(4) })));
  ok((await queued(kv)).length === 1, 'one entry expected');
  ok(rs.filter((r) => !r.deduped).length === 1, 'exactly one submit is the accepting one');
});

await test('a failed queue write does not leave a submit blocked as a duplicate', async () => {
  const kv = slowKV({ failPendingPut: true }); const q = settlerOver(kv);
  let threw = false;
  try { await q.submitJob({ type: 'swap', op: opN(5) }); } catch { threw = true; }
  ok(threw, 'submit should report the failed write');
  kv.failPendingPut = false;
  const r = await q.submitJob({ type: 'swap', op: opN(5) });
  ok((await queued(kv)).includes(r.jobId), 'retry did not reach the queue');
});

await test('a waiting job says how many are ahead of it in the queue; one being proved or done says nothing of the queue', async () => {
  const kv = slowKV(), q = settlerOver(kv);
  const ids = [];
  for (const n of [1, 2, 3]) ids.push((await q.submitJob({ type: 'swap', op: opN(n) })).jobId);
  const st = await Promise.all(ids.map((id) => q.jobStatus(id)));
  ok(st.map((x) => x.ahead).join() === '0,1,2', `ahead ${st.map((x) => x.ahead)}`);
  const claimed = await q.nextJob();
  ok(claimed && claimed.jobId === ids[0], 'the first is claimed first');
  const [a, b] = await Promise.all([q.jobStatus(ids[0]), q.jobStatus(ids[1])]);
  ok(a.status === 'proving' && !('ahead' in a), `a job being proved carries no place in line (${a.status} ${a.ahead})`);
  ok(b.status === 'pending' && b.ahead === 1, `the next counts the one being proved ahead of it (${b.ahead})`);
});

await test('a proof asked for ahead of its press waits for the jobs people have pressed, and is not counted ahead of them', async () => {
  const kv = slowKV(), q = settlerOver(kv);
  const early = (await q.submitJob({ type: 'sendunwrap', op: opN(7), mode: 'prove', early: true })).jobId;
  const pressed = (await q.submitJob({ type: 'swap', op: opN(8) })).jobId;
  const [e, p] = await Promise.all([q.jobStatus(early), q.jobStatus(pressed)]);
  ok(p.ahead === 0 && e.ahead === 1, `the pressed job is next, the early one does not count ahead of it, and it waits for the pressed one (${e.ahead}, ${p.ahead})`);   // a swap pins reserves, so it is served before a send queued earlier (confidential-settle.js PINNED_TYPES)
  const first = await q.nextJob(), second = await q.nextJob();
  ok(first?.jobId === pressed && second?.jobId === early, `the pressed job is taken first (${first?.jobId === pressed}, ${second?.jobId === early})`);
  const settleOnly = (await q.submitJob({ type: 'swap', op: opN(9), early: true })).jobId;
  ok(!(await kv.get('cps:job:' + settleOnly)).includes('"early"'), 'only a prove-only job is marked early');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
