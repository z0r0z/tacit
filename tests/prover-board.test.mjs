// The prover board (worker/src/prover-board.js) and its routes: the relay posts and reads jobs with the box token, a worker
// claims and answers with its own token for its classes, a lease that lapses re-opens the job, a cancelled job ignores a
// late result, the summary carries no inputs; the Ethereum-state program goes only to a trusted worker that says it proves
// it, and its compressed proof is kept apart from the job. Run: node --test tests/prover-board.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProverBoard, parseWorkerTokens, workerOf, proverBoardConfig, PROVER_BOARD } from '../worker/src/prover-board.js';
import worker from '../worker/src/index.js';

const store = () => {
  const m = new Map(), days = new Map(); let pend = [], ws = {};
  return { getDay: async (d) => (days.has(d) ? JSON.parse(days.get(d)) : null), putDay: async (d, r) => { days.set(d, JSON.stringify(r)); }, getPending: async () => pend.slice(), putPending: async (ids) => { pend = ids.slice(); }, getJob: async (id) => (m.has(id) ? JSON.parse(m.get(id)) : null), putJob: async (id, j) => { m.set(id, JSON.stringify(j)); }, getWorkers: async () => JSON.parse(JSON.stringify(ws)), putWorkers: async (w) => { ws = JSON.parse(JSON.stringify(w)); } };
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
  assert.equal(sum.workers.find((w) => w.name === 'tacit-a5000').lastBadSeconds, 0, 'when the last refusal was, so the monitor warns on a new one, not the lifetime count');
  assert.equal(sum.workers.find((w) => w.name === 'alice').lastBadSeconds, null);
  t += 90_000;
  assert.equal((await b.summary()).workers.find((w) => w.name === 'tacit-a5000').lastBadSeconds, 90);
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

test('community: anyone races a public job without taking it; a candidate is the job\'s proof only once the relay takes it, a bad one marks its maker', async () => {
  t = 2_000_000;
  const b = makeProverBoard({ storage: store(), now });
  const c1 = { name: 'c-0x' + '11'.repeat(20), classes: ['public'], community: true }, c2 = { name: 'c-0x' + '22'.repeat(20), classes: ['public'], community: true };
  const priv = await b.post({ class: 'private', stdin: Buffer.from('a witness').toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 });
  const pub = await b.post({ class: 'public', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600, label: 'wrapswap' });
  const j1 = await b.claim({ worker: c1, classes: ['public'] });
  assert.equal(j1.jobId, pub.jobId, 'a community machine is offered the public job, never the private one');
  assert.equal(j1.race, true);
  assert.equal(await b.claim({ worker: c1, classes: ['public'] }), null, 'one race at a time per machine');
  assert.equal((await b.status(pub.jobId)).status, 'queued', 'the claim took the job from no one');
  const house = await b.claim({ worker: tacit, classes: ['private', 'public'] });
  assert.equal(house.jobId, priv.jobId, 'Tacit\'s worker takes the oldest, the private job');
  const house2 = await b.claim({ worker: tacit, classes: ['private', 'public'] });
  assert.equal(house2.jobId, pub.jobId, 'and still the public one a community machine races');
  assert.equal((await b.claim({ worker: c2, classes: ['public'] })).jobId, pub.jobId, 'a second machine joins the race');
  // a bad candidate: dropped, marked, the job goes on
  assert.deepEqual(await b.result({ worker: c2, jobId: pub.jobId, publicValues: '0x' + '33'.repeat(64), proof: '0x' + '44'.repeat(260) }), { ok: true, status: 'candidate' });
  let st = await b.status(pub.jobId);
  assert.equal(st.status, 'claimed'); assert.equal(st.race.length, 1, 'the relay sees the candidate');
  assert.deepEqual(await b.raceVerdict({ jobId: pub.jobId, worker: c2.name, ok: false }), { ok: true, status: 'claimed' });
  assert.equal((await b.status(pub.jobId)).race.length, 0);
  // a good candidate wins over the house worker still proving
  await b.result({ worker: c1, jobId: pub.jobId, publicValues: '0x' + '55'.repeat(64), proof: '0x' + '66'.repeat(260) });
  assert.deepEqual(await b.raceVerdict({ jobId: pub.jobId, worker: c1.name, ok: true }), { ok: true, status: 'proved' });
  st = await b.status(pub.jobId);
  assert.equal(st.status, 'proved'); assert.equal(st.worker, c1.name); assert.equal(st.proof, '0x' + '66'.repeat(260)); assert.deepEqual(st.race, []);
  assert.equal((await b.result({ worker: tacit, jobId: pub.jobId, publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(260) })).ok, false, 'the house worker\'s late answer is not taken');
  const s = await b.summary();
  const row = (n) => s.workers.find((w) => w.name === n);
  assert.equal(row(c1.name).proved, 1); assert.equal(row(c1.name).community, true);
  assert.equal(row(c2.name).bad, 1);
  assert.equal(row('tacit-a5000').community, undefined);
});

test('community: a sealed public job, or a racer that drops out, are handled; a machine not racing cannot answer', async () => {
  t = 3_000_000;
  const b = makeProverBoard({ storage: store(), now });
  const c = { name: 'c-0x' + '77'.repeat(20), classes: ['public'], community: true };
  const pub = await b.post({ class: 'public', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 });
  assert.equal((await b.result({ worker: c, jobId: pub.jobId, publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(260) })).ok, false, 'not racing it');
  await b.claim({ worker: c, classes: ['public'] });
  assert.deepEqual(await b.result({ worker: c, jobId: pub.jobId, error: 'out of memory' }), { ok: true, status: 'dropped' });
  assert.equal((await b.status(pub.jobId)).status, 'queued', 'a racer that could not prove it fails nothing');
  assert.equal((await b.claim({ worker: c, classes: ['public'] })), null, 'nor is it offered the job again');
});

test('tokens: a token trusted with private work takes public work too', () => {
  assert.deepEqual(parseWorkerTokens('box:aaaaaaaaaaaaaaaaaaaa:private')[0].classes, ['private', 'eth-state', 'public']);
});

test('routes: a community machine claims and answers with only an address; the relay judges its candidate with the box token; PROVER_BOARD_COMMUNITY=0 closes it', async () => {
  const kv = () => { const m = new Map(); return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); } }; };
  const env = { REGISTRY_KV: kv(), CONFIDENTIAL_BOX_TOKEN: 'box-token-box-token-box', PROVER_WORKER_TOKENS: 'gpu1:worker-token-worker-tok:private' };
  const call = (path, init = {}, e = env) => worker.fetch(new Request(`https://api.tacit.finance${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } }), e, { waitUntil() {} });
  const post = (o, headers = {}) => ({ method: 'POST', body: JSON.stringify(o), headers });
  const box = { Authorization: 'Bearer box-token-box-token-box' };
  const MINER = '0x' + 'ab'.repeat(20);
  const pub = await (await call('/prover/jobs', post({ class: 'public', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: Math.floor(Date.now() / 1000) + 600, label: 'wrapswap' }, box))).json();
  assert.equal((await call('/prover/community/claim', post({ miner: 'nobody' }))).status, 400, 'a claim names the address its points go to');
  const { job } = await (await call('/prover/community/claim', post({ miner: MINER }))).json();
  assert.equal(job.jobId, pub.jobId); assert.equal(job.stdin, stdin); assert.equal(job.race, true);
  assert.deepEqual(await (await call('/prover/community/result', post({ miner: MINER, jobId: job.jobId, publicValues: '0x' + 'ab'.repeat(64), proof: '0x' + 'cd'.repeat(260) }))).json(), { ok: true, status: 'candidate' });
  let st = await (await call(`/prover/jobs?id=${pub.jobId}`, { headers: box })).json();
  assert.equal(st.race.length, 1); assert.equal(st.race[0].worker, `c-${MINER}`);
  assert.equal((await call('/prover/jobs/race', post({ jobId: pub.jobId, worker: `c-${MINER}`, ok: true }))).status, 404, 'only the relay judges a candidate');
  assert.deepEqual(await (await call('/prover/jobs/race', post({ jobId: pub.jobId, worker: `c-${MINER}`, ok: true }, box))).json(), { ok: true, status: 'proved' });
  st = await (await call(`/prover/jobs?id=${pub.jobId}`, { headers: box })).json();
  assert.equal(st.status, 'proved'); assert.equal(st.worker, `c-${MINER}`);
  const sum = await (await call('/prover/board')).json();
  assert.equal(sum.workers.find((w) => w.name === `c-${MINER}`).community, true);
  assert.equal((await call('/prover/community/claim', post({ miner: MINER }), { ...env, PROVER_BOARD_COMMUNITY: '0' })).status, 404);
  // the taken proof is credited to the address for today, open to any page
  const today = Math.floor(Date.now() / 86400e3);
  const cr = await call(`/prover/board/credits?day=${today}`, { headers: { Origin: 'https://some-page.example' } });
  assert.equal(cr.status, 200); assert.equal(cr.headers.get('Access-Control-Allow-Origin'), '*');
  assert.deepEqual(await cr.json(), { day: today, over: false, pointsPerProof: 20, miners: [{ miner: MINER, proofs: 1, points: 20 }] });
  assert.ok(env.REGISTRY_KV && JSON.parse(await env.REGISTRY_KV.get(`pb:day:${today}`)).miners[MINER].credited === 1, 'kept under pb:day:<day>');
  assert.equal((await call(`/prover/board/credits?day=${today + 1}`)).status, 400, 'not a day in the future');
  assert.equal((await call('/prover/board/credits?day=x')).status, 400);
  assert.deepEqual((await (await call(`/prover/board/credits?day=${today}`, {}, { ...env, POINTS_BOARD_PER_PROOF: '0' })).json()).pointsPerProof, 0);
});

test('points: each proof the relay takes from a community machine counts for its address on its UTC day, up to the day\'s cap; bad ones, house workers and unchecked ones earn nothing', async () => {
  const DAY = 86_400_000, D = 20_800;
  t = D * DAY + 3600_000;
  const b = makeProverBoard({ storage: store(), now, cfg: { ...PROVER_BOARD, pointsPerProof: 20, proofsPerMinerDay: 2 } });
  const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20);
  const ca = { name: `c-${A}`, classes: ['public'], community: true }, cb = { name: `c-${B}`, classes: ['public'], community: true };
  let n = 0;
  // a public job raced by `c`, answered, and judged `ok`
  const race = async (c, ok) => {
    const p = await b.post({ class: 'public', stdin: Buffer.from(`input ${++n}`).toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 });
    assert.equal((await b.claim({ worker: c, classes: ['public'] })).jobId, p.jobId);
    await b.result({ worker: c, jobId: p.jobId, publicValues: '0x' + '55'.repeat(64), proof: '0x' + '66'.repeat(260) });
    if (ok !== undefined) await b.raceVerdict({ jobId: p.jobId, worker: c.name, ok });
    return p.jobId;
  };
  await race(ca, true); await race(ca, true); await race(ca, true);
  await race(cb, false);
  const unchecked = await race(cb);
  await b.raceVerdict({ jobId: unchecked, worker: cb.name, ok: null });
  // a house worker's proof of a public job (the oldest still open: the one the bad candidate raced)
  const h = await b.claim({ worker: tacit, classes: ['public'] });
  assert.equal((await b.result({ worker: tacit, jobId: h.jobId, publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(260) })).status, 'proved');
  assert.deepEqual((await b.credits(D)).body, { day: D, over: false, pointsPerProof: 20, miners: [{ miner: A, proofs: 3, points: 40 }] }, 'past the cap a proof is counted, not credited');
  await race(cb, true);
  t = (D + 1) * DAY + 1;
  await race(ca, true);
  assert.deepEqual((await b.credits(D)).body, { day: D, over: true, pointsPerProof: 20, miners: [{ miner: A, proofs: 3, points: 40 }, { miner: B, proofs: 1, points: 20 }] });
  assert.deepEqual((await b.credits(D + 1)).body.miners, [{ miner: A, proofs: 1, points: 20 }], 'a new day, a new cap');
  assert.equal((await b.credits(D + 2)).status, 400);
  assert.equal((await b.credits(1.5)).status, 400);
  assert.equal((await b.credits(-1)).status, 400);
  // switched off: proofs counted, nothing listed
  const off = makeProverBoard({ storage: store(), now, cfg: { ...PROVER_BOARD, pointsPerProof: 0 } });
  const p = await off.post({ class: 'public', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 });
  await off.claim({ worker: ca, classes: ['public'] });
  await off.result({ worker: ca, jobId: p.jobId, publicValues: '0x' + '55'.repeat(64), proof: '0x' + '66'.repeat(260) });
  await off.raceVerdict({ jobId: p.jobId, worker: ca.name, ok: true });
  assert.deepEqual((await off.credits(D + 1)).body, { day: D + 1, over: false, pointsPerProof: 0, miners: [] });
});

test('points config: env sets the points and a count a day, 0 points pays nothing, no count or 0 is no count, nonsense keeps the default', () => {
  const btc = (n) => ({ pointsByProgram: { 'btc-state': n } });
  assert.deepEqual(proverBoardConfig({}), { pointsPerProof: 20, proofsPerMinerDay: Infinity, ...btc(500) });
  assert.deepEqual(proverBoardConfig({ POINTS_BOARD_PER_PROOF: '50', POINTS_BOARD_DAILY_CAP: '10', POINTS_BOARD_BTC_PER_PROOF: '800' }), { pointsPerProof: 50, proofsPerMinerDay: 10, ...btc(800) });
  assert.deepEqual(proverBoardConfig({ POINTS_BOARD_PER_PROOF: '0', POINTS_BOARD_DAILY_CAP: '0', POINTS_BOARD_BTC_PER_PROOF: '0' }), { pointsPerProof: 0, proofsPerMinerDay: Infinity, ...btc(0) });
  assert.deepEqual(proverBoardConfig({ POINTS_BOARD_PER_PROOF: 'lots', POINTS_BOARD_DAILY_CAP: '-1' }), { pointsPerProof: 20, proofsPerMinerDay: Infinity, ...btc(500) });
});

test('the Bitcoin-state program: public groth16 work, its input kept apart and deleted with the job, leased for hours, raced only by machines that prove it', async () => {
  const s = store(), kept = new Map();
  Object.assign(s, { putStdin: async (id, v) => { kept.set(id, v); }, getStdin: async (id) => kept.get(id) ?? null, deleteStdin: async (id) => { kept.delete(id); } });
  const b = makeProverBoard({ storage: s, now });
  const big = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64');
  await assert.rejects(b.post({ class: 'private', program: 'btc-state', stdin: big, cycleLimit: 1e11, gasLimit: 1e11, deadline: now() / 1000 + 7200 }), /class is public/);
  await assert.rejects(b.post({ class: 'public', program: 'btc-state', mode: 'compressed', stdin: big, cycleLimit: 1e11, gasLimit: 1e11, deadline: now() / 1000 + 7200 }), /proved groth16/);
  await assert.rejects(b.post({ class: 'public', program: 'btc-state', stdin: Buffer.alloc(17 * 1024 * 1024).toString('base64'), cycleLimit: 1e11, gasLimit: 1e11, deadline: now() / 1000 + 7200 }), /at most 16777216 bytes/);
  const { jobId } = await b.post({ class: 'public', program: 'btc-state', mode: 'groth16', stdin: big, cycleLimit: 1e11, gasLimit: 1e11, deadline: now() / 1000 + 7200, label: 'btc-state' });
  assert.equal(kept.get(jobId), big, 'the input is under its own key');
  assert.equal(JSON.parse(JSON.stringify(await s.getJob(jobId))).stdin, null, 'and not on the record every read loads');
  assert.equal(await b.claim({ worker: tacit, classes: ['private', 'public'] }), null, 'a worker that does not say it proves btc-state is not offered it');
  assert.equal(await b.claim({ worker: { name: 'c-0x' + '11'.repeat(20), classes: ['public'], community: true }, classes: ['public'] }), null, 'nor is a community machine that names no programs');
  const raced = await b.claim({ worker: { name: 'c-0x' + '22'.repeat(20), classes: ['public'], community: true }, classes: ['public'], programs: ['btc-state'] });
  assert.deepEqual([raced.jobId, raced.program, raced.mode, raced.stdin === big, raced.race], [jobId, 'btc-state', 'groth16', true, true], 'a community machine that proves it races it, with the input');
  const job = await b.claim({ worker: tacit, classes: ['private', 'public'], programs: ['confidential', 'eth-state', 'btc-state'] });
  assert.deepEqual([job.jobId, job.program, job.mode, job.stdin === big, job.leaseUntil], [jobId, 'btc-state', 'groth16', true, now() + 2 * 3600_000]);
  t += PROVER_BOARD.leaseMs + 1;
  assert.equal((await b.status(jobId)).status, 'claimed', 'five minutes in, the claim still holds');
  assert.deepEqual(await b.result({ worker: tacit, jobId, publicValues: '0x' + '11'.repeat(64 * 8), proof: '0x' + '22'.repeat(260) }), { ok: true, status: 'proved' });
  assert.equal(kept.has(jobId), false, 'the input goes when the job is over');
  assert.equal((await b.status(jobId)).proof, '0x' + '22'.repeat(260));
});

test('a community racer that never answers gives its place up after the job\'s lease, and a candidate\'s public values are capped', async () => {
  const b = makeProverBoard({ storage: store(), now });
  const { jobId } = await b.post({ class: 'public', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 7200 });
  const racers = Array.from({ length: PROVER_BOARD.communityRacers }, (_, i) => ({ name: `c-0x${String(i + 1).padStart(40, '0')}`, classes: ['public'], community: true }));
  for (const r of racers) assert.equal((await b.claim({ worker: r, classes: ['public'] })).jobId, jobId);
  const late = { name: 'c-0x' + 'ee'.repeat(20), classes: ['public'], community: true };
  assert.equal(await b.claim({ worker: late, classes: ['public'] }), null, 'every place taken');
  t += PROVER_BOARD.leaseMs + 1;
  assert.equal((await b.claim({ worker: late, classes: ['public'] })).jobId, jobId, 'silent racers give their places up');
  const big = '0x' + '11'.repeat(PROVER_BOARD.maxCandidatePvBytes + 1);
  assert.match((await b.result({ worker: late, jobId, publicValues: big, proof: '0x' + '22'.repeat(260) })).error, /public values/);
  const { jobId: second } = await b.post({ class: 'public', stdin: Buffer.from('another input').toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 7200 });
  assert.equal((await b.claim({ worker: racers[0], classes: ['public'] })).jobId, second, 'a racer whose old place lapsed may race again');
});

test('a community Bitcoin batch earns its own points, and the summary says what each program pays', async () => {
  const s = store(), kept = new Map();
  Object.assign(s, { putStdin: async (id, v) => { kept.set(id, v); }, getStdin: async (id) => kept.get(id) ?? null, deleteStdin: async (id) => { kept.delete(id); } });
  const b = makeProverBoard({ storage: s, now, cfg: { ...PROVER_BOARD, pointsByProgram: { 'btc-state': 500 } } });
  const { jobId } = await b.post({ class: 'public', program: 'btc-state', stdin: Buffer.from('batch').toString('base64'), cycleLimit: 1e11, gasLimit: 1e11, deadline: now() / 1000 + 7200 });
  const miner = '0x' + '42'.repeat(20), w = { name: `c-${miner}`, classes: ['public'], community: true };
  assert.equal((await b.claim({ worker: w, classes: ['public'], programs: ['btc-state'] })).jobId, jobId);
  assert.equal((await b.result({ worker: w, jobId, publicValues: '0x' + '11'.repeat(64 * 8), proof: '0x' + '22'.repeat(260) })).status, 'candidate');
  assert.deepEqual(await b.raceVerdict({ jobId, worker: w.name, ok: true }), { ok: true, status: 'proved' });
  const day = Math.floor(now() / 86400000);
  assert.deepEqual((await b.credits(day)).body.miners, [{ miner, proofs: 1, points: 500 }]);
  assert.deepEqual((await b.summary()).pay, { pointsPerProof: 20, pointsByProgram: { 'btc-state': 500 } });
});
