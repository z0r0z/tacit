// The prover board (worker/src/prover-board.js) and its routes: the relay posts and reads jobs with the box token, a worker
// claims and answers with its own token for its classes, a lease that lapses re-opens the job, a cancelled job ignores a
// late result, the summary carries no inputs; the Ethereum-state program goes only to a trusted worker that says it proves
// it, and its compressed proof is kept apart from the job. Run: node --test tests/prover-board.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProverBoard, parseWorkerTokens, workerOf, PROVER_BOARD } from '../worker/src/prover-board.js';
import worker from '../worker/src/index.js';

const store = () => {
  const m = new Map(); let pend = [], ws = {};
  return { getPending: async () => pend.slice(), putPending: async (ids) => { pend = ids.slice(); }, getJob: async (id) => (m.has(id) ? JSON.parse(m.get(id)) : null), putJob: async (id, j) => { m.set(id, JSON.stringify(j)); }, getWorkers: async () => JSON.parse(JSON.stringify(ws)), putWorkers: async (w) => { ws = JSON.parse(JSON.stringify(w)); } };
};
const stdin = Buffer.from('program input bytes').toString('base64');
let t = 1_000_000;
const now = () => t;
const tacit = { name: 'tacit-a5000', classes: ['private', 'public'] };
const guest = { name: 'alice', classes: ['public'] };

test('tokens: name:token[:classes]; short tokens are ignored; a bearer names its worker', () => {
  const raw = 'tacit-a5000:aaaaaaaaaaaaaaaaaaaa:private+public, alice:bbbbbbbbbbbbbbbbbbbb, bad:short, eve:cccccccccccccccccccc:secret';
  assert.deepEqual(parseWorkerTokens(raw), [{ name: 'tacit-a5000', token: 'aaaaaaaaaaaaaaaaaaaa', classes: ['private', 'public', 'eth-state'] }, { name: 'alice', token: 'bbbbbbbbbbbbbbbbbbbb', classes: ['public'] }, { name: 'eve', token: 'cccccccccccccccccccc', classes: ['public'] }], 'a token trusted with private work may prove the Ethereum-state input');
  assert.deepEqual(workerOf('Bearer bbbbbbbbbbbbbbbbbbbb', raw), { name: 'alice', classes: ['public'] });
  assert.equal(workerOf('Bearer bbbbbbbbbbbbbbbbbbbc', raw), null);
  assert.equal(workerOf('', raw), null);
  assert.equal(workerOf('Bearer aaaaaaaaaaaaaaaaaaaa', ''), null);
});

test('post, claim by class, result, status; the same input is one job; a worker without the class never sees it', async () => {
  const b = makeProverBoard({ storage: store(), now });
  const { jobId, status } = await b.post({ class: 'private', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600, label: 'wrap' });
  assert.equal(status, 'queued');
  assert.deepEqual(await b.post({ class: 'private', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 }), { jobId, status: 'queued', deduped: true });
  assert.equal(await b.claim({ worker: guest, classes: ['public'] }), null, 'a public-only worker is not offered a private job');
  assert.equal(await b.claim({ worker: guest, classes: ['private'] }), null, 'nor can it ask for the class');
  const job = await b.claim({ worker: tacit, classes: ['private', 'public'] });
  assert.equal(job.jobId, jobId); assert.equal(job.stdin, stdin); assert.equal(job.label, 'wrap'); assert.equal(job.leaseUntil, now() + PROVER_BOARD.leaseMs);
  assert.equal((await b.status(jobId)).status, 'claimed');
  assert.equal(await b.claim({ worker: tacit, classes: ['private'] }), null, 'nothing else is queued');
  const r = await b.result({ worker: guest, jobId, publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(260) });
  assert.equal(r.ok, false, 'another worker cannot answer for it');
  assert.deepEqual(await b.result({ worker: tacit, jobId, publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(260) }), { ok: true, status: 'proved' });
  const st = await b.status(jobId);
  assert.equal(st.status, 'proved'); assert.equal(st.worker, 'tacit-a5000'); assert.equal(st.proof, '0x' + '22'.repeat(260)); assert.equal(st.stdin, undefined, 'the status never carries the input');
  const sum = await b.summary();
  assert.equal(sum.proved, 1); assert.equal(sum.workers[0].name, 'tacit-a5000'); assert.equal(sum.workers[0].proved, 1);
  assert.equal(JSON.stringify(sum).includes(stdin), false);
  assert.deepEqual(await b.post({ class: 'private', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 }), { jobId, status: 'queued' }, 'once finished, the same input can be posted again');
});

test('a lapsed lease re-opens the job for the next claim; a cancelled job takes no late result; a bad proof counts against its worker', async () => {
  const b = makeProverBoard({ storage: store(), now });
  const { jobId } = await b.post({ class: 'public', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 3600 });
  assert.equal((await b.claim({ worker: guest, classes: ['public'] })).jobId, jobId);
  t += PROVER_BOARD.leaseMs + 1;
  assert.equal((await b.status(jobId)).status, 'queued', 'read as queued once the lease lapsed');
  const again = await b.claim({ worker: tacit, classes: ['public'] });
  assert.equal(again.jobId, jobId);
  assert.equal((await b.result({ worker: guest, jobId, error: 'late' })).ok, false, 'the worker that lost the lease cannot answer');
  assert.deepEqual(await b.cancel({ jobId, reason: 'bad' }), { ok: true, status: 'cancelled' });
  assert.equal((await b.result({ worker: tacit, jobId, publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(100) })).ok, false);
  const sum = await b.summary();
  assert.equal(sum.workers.find((w) => w.name === 'tacit-a5000').bad, 1);
  assert.equal((await b.status(jobId)).lapsed, 1);
  // A job past its deadline is expired, not offered.
  const late = await b.post({ class: 'public', stdin: Buffer.from('other').toString('base64'), cycleLimit: 1, gasLimit: 1, deadline: now() / 1000 + 1 });
  t += 2000;
  assert.equal(await b.claim({ worker: guest, classes: ['public'] }), null);
  assert.equal((await b.status(late.jobId)).status, 'expired');
  await assert.rejects(b.post({ class: 'secret', stdin, cycleLimit: 1, gasLimit: 1, deadline: now() / 1000 + 10 }), /class must be/);
  await assert.rejects(b.post({ class: 'public', stdin: 'not base64!', cycleLimit: 1, gasLimit: 1, deadline: now() / 1000 + 10 }), /base64/);
  await assert.rejects(b.post({ class: 'public', stdin, cycleLimit: 1, gasLimit: 1, deadline: now() / 1000 - 10 }), /deadline/);
});

test('the input leaves the record the moment a job ends, and the record leaves storage once it leaves the list', async () => {
  const st = store();
  const deleted = [];
  st.deleteJob = async (id) => { deleted.push(id); };
  const b = makeProverBoard({ storage: st, now });
  const { jobId } = await b.post({ class: 'public', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 });
  await b.claim({ worker: guest, classes: ['public'] });
  assert.equal((await st.getJob(jobId)).stdin, stdin, 'claimed: the worker still needs it');
  await b.result({ worker: guest, jobId, publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(100) });
  assert.equal((await st.getJob(jobId)).stdin, null, 'proved: dropped');
  const c = await b.post({ class: 'public', stdin: Buffer.from('two').toString('base64'), cycleLimit: 1, gasLimit: 1, deadline: now() / 1000 + 600 });
  await b.cancel({ jobId: c.jobId });
  assert.equal((await st.getJob(c.jobId)).stdin, null, 'cancelled: dropped');
  t += PROVER_BOARD.keepMs + 1;
  await b.summary(); await b.post({ class: 'public', stdin: Buffer.from('three').toString('base64'), cycleLimit: 1, gasLimit: 1, deadline: now() / 1000 + 600 });
  assert.ok(deleted.includes(jobId) && deleted.includes(c.jobId), 'kept long enough, then deleted from storage');
});

test('a sealed job is offered only to the worker it is sealed to; keys ride on the summary; the sealed input leaves the record when the job ends', async () => {
  const st = store();
  const b = makeProverBoard({ storage: st, now });
  const pub = '0x02' + 'ab'.repeat(32);
  await b.claim({ worker: tacit, classes: ['private'], pubkey: pub });            // nothing queued, but the key is now known
  assert.equal((await b.summary()).workers.find((w) => w.name === 'tacit-a5000').pubkey, pub);
  const sealed = { worker: 'tacit-a5000', epk: '0x03' + 'cd'.repeat(32), iv: Buffer.alloc(12, 1).toString('base64'), ct: Buffer.alloc(40, 2).toString('base64') };
  const { jobId } = await b.post({ class: 'private', sealed, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 });
  assert.equal((await b.status(jobId)).sealedTo, 'tacit-a5000');
  assert.equal(await b.claim({ worker: { name: 'other', classes: ['private'] }, classes: ['private'] }), null, 'another private worker is not offered it');
  const job = await b.claim({ worker: tacit, classes: ['private'] });
  assert.equal(job.jobId, jobId); assert.equal(job.stdin, null); assert.deepEqual(job.sealed, { epk: sealed.epk, iv: sealed.iv, ct: sealed.ct }, 'the worker gets the ciphertext, not the name');
  await b.result({ worker: tacit, jobId, publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(100) });
  assert.equal((await st.getJob(jobId)).sealed, null, 'dropped once proved');
  await assert.rejects(b.post({ class: 'private', sealed: { ...sealed, epk: '0x04' + 'cd'.repeat(32) }, cycleLimit: 1, gasLimit: 1, deadline: now() / 1000 + 600 }), /sealed must be/);
  await assert.rejects(b.post({ class: 'private', cycleLimit: 1, gasLimit: 1, deadline: now() / 1000 + 600 }), /stdin must be/);
});

test('a warming worker is counted as seen and takes nothing; its first real claim takes the job waiting for it', async () => {
  const b = makeProverBoard({ storage: store(), now });
  const { jobId } = await b.post({ class: 'private', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600, label: 'wrap' });
  assert.equal(await b.claim({ worker: tacit, classes: ['private'], warming: true }), null, 'a warming ping claims nothing');
  assert.equal((await b.status(jobId)).status, 'queued');
  const w = (await b.summary()).workers.find((x) => x.name === tacit.name);
  assert.ok(w && w.lastSeenSeconds <= 1, 'but the worker reads as seen, so the relay keeps posting here');
  assert.equal((await b.claim({ worker: tacit, classes: ['private'] })).jobId, jobId);
});

test('routes: box token for posting and reading, worker tokens for claiming and answering, the summary open to any page', async () => {
  const kv = () => { const m = new Map(); return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } }; };
  const env = { REGISTRY_KV: kv(), CONFIDENTIAL_BOX_TOKEN: 'box-token-box-token-box', PROVER_WORKER_TOKENS: 'gpu1:worker-token-worker-tok:private+public,alice:alice-token-alice-token' };
  const call = (path, init = {}) => worker.fetch(new Request(`https://api.tacit.finance${path}`, { ...init, headers: { Origin: 'https://some-page.example', ...(init.headers || {}) } }), env, { waitUntil() {} });
  const json = (o) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
  const box = { Authorization: 'Bearer box-token-box-token-box' };
  let r = await call('/prover/jobs', json({ class: 'private', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: Math.floor(Date.now() / 1000) + 600 }));
  assert.equal(r.status, 404, 'posting needs the box token');
  r = await call('/prover/jobs', { ...json({ class: 'private', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: Math.floor(Date.now() / 1000) + 600, label: 'wrap' }), headers: { 'content-type': 'application/json', ...box } });
  const posted = await r.json();
  assert.equal(r.status, 200); assert.equal(posted.ok, true); assert.equal(posted.status, 'queued');
  r = await call('/prover/claim', json({ classes: ['private'] }));
  assert.equal(r.status, 404, 'claiming needs a worker token');
  r = await call('/prover/claim', { ...json({ classes: ['private', 'public'] }), headers: { 'content-type': 'application/json', Authorization: 'Bearer alice-token-alice-token' } });
  assert.deepEqual(await r.json(), {}, 'a public-only worker gets nothing for a private job');
  r = await call('/prover/claim', { ...json({ classes: ['private', 'public'] }), headers: { 'content-type': 'application/json', Authorization: 'Bearer worker-token-worker-tok' } });
  const { job } = await r.json();
  assert.equal(job.jobId, posted.jobId); assert.equal(job.stdin, stdin);
  r = await call(`/prover/jobs?id=${posted.jobId}`, { headers: box });
  assert.equal((await r.json()).status, 'claimed');
  r = await call('/prover/result', { ...json({ jobId: job.jobId, publicValues: '0x' + 'ab'.repeat(64), proof: '0x' + 'cd'.repeat(260) }), headers: { 'content-type': 'application/json', Authorization: 'Bearer worker-token-worker-tok' } });
  assert.deepEqual(await r.json(), { ok: true, status: 'proved' });
  r = await call(`/prover/jobs?id=${posted.jobId}`, { headers: box });
  const st = await r.json();
  assert.equal(st.status, 'proved'); assert.equal(st.proof, '0x' + 'cd'.repeat(260)); assert.equal(st.worker, 'gpu1'); assert.equal('stdin' in st, false);
  r = await call('/prover/board');
  assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), '*'); assert.equal(r.headers.get('cache-control'), 'max-age=10');
  const sum = await r.json();
  assert.equal(sum.proved, 1); assert.equal(sum.workers[0].name, 'gpu1');
  r = await call('/prover/jobs/cancel', { ...json({ jobId: posted.jobId }), headers: { 'content-type': 'application/json', ...box } });
  assert.deepEqual(await r.json(), { ok: true, status: 'cancelled' });
  r = await call('/prover/jobs?id=nope', { headers: box });
  assert.equal(r.status, 404);
});

// ── The Ethereum-state program (eth_prove's input, proved compressed) ──
const ethJob = (over = {}) => ({ class: 'eth-state', program: 'eth-state', mode: 'compressed', stdin, cycleLimit: 3e9, gasLimit: 3e9, deadline: now() / 1000 + 600, label: 'eth-state', ...over });
const tacitEth = { name: 'tacit-a5000', classes: ['private', 'public', 'eth-state'] };
const bigProof = Buffer.alloc(1_300_000, 7).toString('base64');
const ETH_PV = '0x' + '5a'.repeat(448);

test('eth-state: the program fixes its class and mode; it cannot be sealed', async () => {
  const b = makeProverBoard({ storage: store(), now });
  await assert.rejects(b.post(ethJob({ class: 'public' })), /class is eth-state/);
  await assert.rejects(b.post(ethJob({ class: 'private' })), /class is eth-state/);
  await assert.rejects(b.post({ ...ethJob(), program: 'confidential' }), /class is private or public/);
  await assert.rejects(b.post(ethJob({ mode: 'groth16' })), /proved compressed/);
  await assert.rejects(b.post(ethJob({ program: 'other' })), /program must be one of/);
  await assert.rejects(b.post(ethJob({ stdin: undefined, sealed: { worker: 'tacit-a5000', epk: '0x02' + '11'.repeat(32), iv: Buffer.alloc(12).toString('base64'), ct: Buffer.alloc(40).toString('base64') } })), /only a confidential job can be sealed/);
  const cold = Buffer.alloc(2_022_672, 1).toString('base64'); // a cold start's input (34 sync-committee periods)
  assert.equal((await b.post(ethJob({ stdin: cold }))).status, 'queued', 'an eth-state input may run to 4 MiB');
  await assert.rejects(b.post({ class: 'private', stdin: cold, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 }), /at most 1048576 bytes/, 'a settle input keeps the 1 MiB cap');
  const { jobId } = await b.post(ethJob({ mode: undefined }));
  const st = await b.status(jobId);
  assert.equal(st.program, 'eth-state'); assert.equal(st.mode, 'compressed'); assert.equal(st.class, 'eth-state');
});

test('eth-state: offered only to a trusted token that says it proves the program; an older worker never sees it', async () => {
  const b = makeProverBoard({ storage: store(), now });
  const { jobId } = await b.post(ethJob());
  assert.equal(await b.claim({ worker: guest, classes: ['public', 'eth-state'], programs: ['confidential', 'eth-state'] }), null, 'a public-only token is not offered it');
  assert.equal(await b.claim({ worker: tacitEth, classes: ['private', 'public', 'eth-state'] }), null, 'a worker that names no programs proves the pool guest only');
  assert.equal(await b.claim({ worker: tacitEth, classes: ['private', 'public'], programs: ['confidential', 'eth-state'] }), null, 'nor one that does not ask for the class');
  const job = await b.claim({ worker: tacitEth, classes: ['private', 'public', 'eth-state'], programs: ['confidential', 'eth-state'] });
  assert.equal(job.jobId, jobId); assert.equal(job.program, 'eth-state'); assert.equal(job.mode, 'compressed'); assert.equal(job.stdin, stdin);
  const w = (await b.summary()).workers.find((x) => x.name === tacitEth.name);
  assert.deepEqual(w.programs, ['confidential', 'eth-state'], 'the summary says what the worker proves, for the relay to read');
});

test('eth-state: the compressed proof is base64 (hex and oversized are refused), kept apart from its job and dropped with it', async () => {
  const st = store();
  const proofs = new Map();
  Object.assign(st, { putProof: async (id, p) => { proofs.set(id, p); }, getProof: async (id) => proofs.get(id) ?? null, deleteProof: async (id) => { proofs.delete(id); }, deleteJob: async () => {} });
  const b = makeProverBoard({ storage: st, now });
  const { jobId } = await b.post(ethJob());
  await b.claim({ worker: tacitEth, classes: ['eth-state'], programs: ['eth-state'] });
  assert.equal((await b.result({ worker: tacitEth, jobId, publicValues: ETH_PV, proof: '0x' + 'cd'.repeat(260) })).ok, false, 'a groth16-style hex proof is not a compressed proof');
  assert.equal((await b.result({ worker: tacitEth, jobId, publicValues: ETH_PV, proof: Buffer.alloc(PROVER_BOARD.maxCompressedProofBytes + 1).toString('base64') })).ok, false, 'over the cap');
  assert.deepEqual(await b.result({ worker: tacitEth, jobId, publicValues: ETH_PV, proof: bigProof }), { ok: true, status: 'proved' });
  assert.equal(proofs.get(jobId), bigProof, 'stored under its own key');
  const raw = JSON.parse(JSON.stringify(await st.getJob(jobId)));
  assert.equal(raw.proof, null, 'the record every claim reads stays small');
  const s1 = await b.status(jobId);
  assert.equal(s1.status, 'proved'); assert.equal(s1.proof, bigProof); assert.equal(s1.publicValues, ETH_PV);
  t += PROVER_BOARD.keepMs + 1;
  await b.claim({ worker: tacitEth, classes: ['eth-state'], programs: ['eth-state'] });
  assert.equal(proofs.has(jobId), false, 'the proof leaves storage with its job');
});

test('eth-state: without separate proof storage the proof rides on the record', async () => {
  const b = makeProverBoard({ storage: store(), now });
  const { jobId } = await b.post(ethJob());
  await b.claim({ worker: tacitEth, classes: ['eth-state'], programs: ['eth-state'] });
  await b.result({ worker: tacitEth, jobId, publicValues: ETH_PV, proof: bigProof });
  assert.equal((await b.status(jobId)).proof, bigProof);
});

test('routes: an eth-state claim and its 1.7 MB answer through the API and its KV; the server lets the answer through', async () => {
  const kv = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } }; };
  const KV = kv();
  const env = { REGISTRY_KV: KV, CONFIDENTIAL_BOX_TOKEN: 'box-token-box-token-box', PROVER_WORKER_TOKENS: 'gpu1:worker-token-worker-tok:private+public,alice:alice-token-alice-token:public' };
  const call = (path, init = {}) => worker.fetch(new Request(`https://api.tacit.finance${path}`, { ...init, headers: { Origin: 'https://some-page.example', ...(init.headers || {}) } }), env, { waitUntil() {} });
  const json = (o, h = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(o) });
  const box = { Authorization: 'Bearer box-token-box-token-box' };
  let r = await call('/prover/jobs', json({ class: 'eth-state', program: 'eth-state', mode: 'compressed', stdin, cycleLimit: 3e9, gasLimit: 3e9, deadline: Math.floor(Date.now() / 1000) + 600, label: 'eth-state' }, box));
  const posted = await r.json();
  assert.equal(posted.ok, true);
  r = await call('/prover/claim', json({ classes: ['public', 'eth-state'], programs: ['eth-state'] }, { Authorization: 'Bearer alice-token-alice-token' }));
  assert.deepEqual(await r.json(), {}, 'a public-only token gets nothing');
  r = await call('/prover/claim', json({ classes: ['private', 'public'] }, { Authorization: 'Bearer worker-token-worker-tok' }));
  assert.deepEqual(await r.json(), {}, 'an older worker (no programs, no eth-state class) gets nothing');
  r = await call('/prover/claim', json({ classes: ['private', 'public', 'eth-state'], programs: ['confidential', 'eth-state'] }, { Authorization: 'Bearer worker-token-worker-tok' }));
  const { job } = await r.json();
  assert.equal(job.jobId, posted.jobId); assert.equal(job.program, 'eth-state'); assert.equal(job.mode, 'compressed');
  r = await call('/prover/result', json({ jobId: job.jobId, publicValues: ETH_PV, proof: bigProof }, { Authorization: 'Bearer worker-token-worker-tok' }));
  assert.deepEqual(await r.json(), { ok: true, status: 'proved' });
  assert.equal(KV.m.get('pb:proof:' + job.jobId), bigProof);
  r = await call(`/prover/jobs?id=${posted.jobId}`, { headers: box });
  const st = await r.json();
  assert.equal(st.status, 'proved'); assert.equal(st.proof, bigProof); assert.equal(st.mode, 'compressed');
  const sum = await (await call('/prover/board')).json();
  assert.deepEqual(sum.workers.find((w) => w.name === 'gpu1').programs, ['confidential', 'eth-state']);
  const { maxRequestBytes, PROVER_RESULT_MAX_BYTES, DEFAULT_MAX_ANON_REQUEST_BYTES } = await import('../server/harness.mjs');
  const req = (url) => ({ url, headers: { authorization: 'Bearer worker-token-worker-tok' } });
  assert.equal(maxRequestBytes({}, req('/prover/result')), PROVER_RESULT_MAX_BYTES);
  assert.ok(PROVER_RESULT_MAX_BYTES > bigProof.length + 4096, 'room for the base64 proof and the JSON around it');
  assert.equal(maxRequestBytes({}, req('/prover/claim')), DEFAULT_MAX_ANON_REQUEST_BYTES);
});

test('the summary says how long the last hour\'s finished jobs waited for a claim and took to prove', async () => {
  const b = makeProverBoard({ storage: store(), now });
  assert.deepEqual((await b.summary()).recent, { n: 0, waitP50: null, waitP90: null, proveP50: null, proveP90: null }, 'an empty board has no figures');
  const run = async (tag, waitMs, proveMs) => {
    const { jobId } = await b.post({ class: 'public', stdin: Buffer.from(tag).toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 3600 });
    t += waitMs; await b.claim({ worker: tacit, classes: ['public'] });
    t += proveMs; await b.result({ worker: tacit, jobId, publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(260) });
  };
  await run('a', 1000, 34000); await run('b', 2000, 36000); await run('c', 30000, 40000); await run('d', 1000, 35000);
  const r = (await b.summary()).recent;
  assert.deepEqual(r, { n: 4, waitP50: 2, waitP90: 30, proveP50: 36, proveP90: 40 });
  // a job still waiting, or failed, is not in the figures
  await b.post({ class: 'public', stdin: Buffer.from('queued').toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 3600 });
  assert.equal((await b.summary()).recent.n, 4);
});
