// The prover board (worker/src/prover-board.js) and its routes: the relay posts and reads jobs with the box token, a worker
// claims and answers with its own token for its classes, a lease that lapses re-opens the job, a cancelled job ignores a
// late result, the summary carries no inputs; the Ethereum-state program goes only to a trusted worker that says it proves
// it, and its compressed proof is kept apart from the job. Run: node --test tests/prover-board.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProverBoard, parseWorkerTokens, workerOf, proverBoardConfig, goesByRecord, PROVER_BOARD } from '../worker/src/prover-board.js';
import worker from '../worker/src/index.js';

const store = () => {
  const m = new Map(), days = new Map(); let pend = [], ws = {}, trouble = {};
  return { getDay: async (d) => (days.has(d) ? JSON.parse(days.get(d)) : null), putDay: async (d, r) => { days.set(d, JSON.stringify(r)); }, getPending: async () => pend.slice(), putPending: async (ids) => { pend = ids.slice(); }, getJob: async (id) => (m.has(id) ? JSON.parse(m.get(id)) : null), putJob: async (id, j) => { m.set(id, JSON.stringify(j)); }, getWorkers: async () => JSON.parse(JSON.stringify(ws)), putWorkers: async (w) => { ws = JSON.parse(JSON.stringify(w)); },
    getTrouble: async () => ({ ...trouble }), putTrouble: async (x) => { trouble = { ...x }; } };
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
  assert.equal(await b.claim({ worker: tacit, classes: ['private', 'public'] }), null, 'the public job a community machine races waits its window: first pick is the community\'s');
  t += PROVER_BOARD.communityFirstMs.confidential;
  const house2 = await b.claim({ worker: tacit, classes: ['private', 'public'] });
  assert.equal(house2.jobId, pub.jobId, 'once the window has passed Tacit\'s worker takes it too, so a press is never left to one machine');
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
  // a race is answered from the place that claimed it (its /24): the same address from elsewhere is not racing it
  const from = (ip) => ({ 'CF-Connecting-IP': ip });
  const pub2 = await (await call('/prover/jobs', post({ class: 'public', stdin: Buffer.from('another public input').toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: Math.floor(Date.now() / 1000) + 600 }, box))).json();
  const two = (await (await call('/prover/community/claim', post({ miner: MINER }, from('203.0.113.5')))).json()).job;
  assert.equal(two.jobId, pub2.jobId);
  const cand = { miner: MINER, jobId: pub2.jobId, publicValues: '0x' + 'ab'.repeat(64), proof: '0x' + 'cd'.repeat(260) };
  assert.deepEqual(await (await call('/prover/community/result', post(cand, from('198.51.100.9')))).json(), { ok: false, error: 'not racing this job' });
  assert.deepEqual(await (await call('/prover/community/result', post(cand, from('203.0.113.77')))).json(), { ok: true, status: 'candidate' });
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
  const b = makeProverBoard({ storage: store(), now, cfg: { ...PROVER_BOARD, pointsPerProof: 20, proofsPerMinerDay: 2, communityFirstMs: { confidential: 0, 'tacit-block': 0 } } });
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
  const btc = (n, k = 100, f = 20_000, fb = 120_000) => ({ pointsByProgram: { 'btc-state': n, 'tacit-block': k }, communityFirstMs: { confidential: f, 'tacit-block': fb }, bestPct: 50, bestOf: 3 });
  assert.deepEqual(proverBoardConfig({}), { pointsPerProof: 20, proofsPerMinerDay: Infinity, ...btc(1000) });
  assert.deepEqual(proverBoardConfig({ POINTS_BOARD_PER_PROOF: '50', POINTS_BOARD_DAILY_CAP: '10', POINTS_BOARD_BTC_PER_PROOF: '800' }), { pointsPerProof: 50, proofsPerMinerDay: 10, ...btc(800) });
  assert.deepEqual(proverBoardConfig({ POINTS_BOARD_PER_PROOF: '0', POINTS_BOARD_DAILY_CAP: '0', POINTS_BOARD_BTC_PER_PROOF: '0' }), { pointsPerProof: 0, proofsPerMinerDay: Infinity, ...btc(0) });
  assert.deepEqual(proverBoardConfig({ POINTS_BOARD_PER_PROOF: 'lots', POINTS_BOARD_DAILY_CAP: '-1' }), { pointsPerProof: 20, proofsPerMinerDay: Infinity, ...btc(1000) });
  assert.deepEqual(proverBoardConfig({ POINTS_BOARD_BLOCK_PER_PROOF: '250' }), { pointsPerProof: 20, proofsPerMinerDay: Infinity, ...btc(1000, 250) });
  assert.deepEqual(proverBoardConfig({ PROVER_BOARD_FIRST_MS: '0', PROVER_BOARD_BLOCK_FIRST_MS: '60000' }).communityFirstMs, { confidential: 0, 'tacit-block': 60_000 }, 'the first-pick windows: 0 is no wait');
  assert.deepEqual(proverBoardConfig({ PROVER_BOARD_FIRST_MS: 'soon' }).communityFirstMs, { confidential: 20_000, 'tacit-block': 120_000 }, 'nonsense keeps the default');
  assert.deepEqual([proverBoardConfig({ PROVER_BOARD_BEST_PCT: '0' }).bestPct, proverBoardConfig({ PROVER_BOARD_BEST_PCT: '100' }).bestPct, proverBoardConfig({ PROVER_BOARD_BEST_PCT: '101' }).bestPct], [0, 100, 50], 'batches by record: 0 to 100, past it the default');
  assert.deepEqual([proverBoardConfig({ PROVER_BOARD_BEST_OF: '1' }).bestOf, proverBoardConfig({ PROVER_BOARD_BEST_OF: '0' }).bestOf], [1, 3], 'at least one machine');
});

test('community first pick: a fresh public job waits for a ready community machine before Tacit\'s worker takes it, private work never waits', async () => {
  t = 7_000_000;
  const b = makeProverBoard({ storage: store(), now });
  const g = { name: 'c-0x' + '9a'.repeat(20), classes: ['public'], community: true }, h = { name: 'c-0x' + '9b'.repeat(20), classes: ['public'], community: true };
  const house = () => b.claim({ worker: tacit, classes: ['private', 'public'] });
  const pub = (k) => b.post({ class: 'public', stdin: Buffer.from(`press ${k} ${t}`).toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 });
  // nobody from the community has asked: Tacit's worker takes a public job at once
  const p0 = await pub(0);
  assert.equal((await house()).jobId, p0.jobId, 'with no community machine about, nothing waits');
  assert.equal((await b.result({ worker: tacit, jobId: p0.jobId, publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(260) })).status, 'proved');
  // a machine asks (nothing to race yet), so it is ready: the next press waits for it
  assert.equal(await b.claim({ worker: g, classes: ['public'] }), null);
  const p1 = await pub(1);
  assert.equal(await house(), null, 'a ready community machine has first pick of a fresh press');
  const priv0 = await b.post({ class: 'private', stdin: Buffer.from(`a first witness ${t}`).toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 });
  assert.equal((await house()).jobId, priv0.jobId, 'private work is not held for it, even with a machine ready: only Tacit proves it');
  assert.equal((await b.result({ worker: tacit, jobId: priv0.jobId, publicValues: '0x' + '11'.repeat(64), proof: '0x' + '22'.repeat(260) })).status, 'proved');
  assert.equal((await b.claim({ worker: g, classes: ['public'] })).jobId, p1.jobId, 'and takes it');
  assert.equal(await house(), null, 'while it races, inside the window, Tacit\'s worker leaves it');
  // private work is Tacit's alone and never waits
  const priv = await b.post({ class: 'private', stdin: Buffer.from(`a witness ${t}`).toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 });
  assert.equal((await house()).jobId, priv.jobId, 'a private job is taken at once');
  // the only community machine is busy racing p1: a new press has nobody ready, so Tacit's worker takes it at once
  const p2 = await pub(2);
  assert.equal((await house()).jobId, p2.jobId, 'a press nobody ready can take is not held');
  // past the window Tacit's worker joins the race for p1
  t += PROVER_BOARD.communityFirstMs.confidential;
  assert.equal(await house(), null, 'two open already: Tacit\'s worker holds at most two');
  // a machine seen longer ago than turnSeenMs is not waited for
  const quiet = makeProverBoard({ storage: store(), now });
  assert.equal(await quiet.claim({ worker: h, classes: ['public'] }), null);
  t += PROVER_BOARD.turnSeenMs + 1;
  const q = await quiet.post({ class: 'public', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 });
  assert.equal((await quiet.claim({ worker: tacit, classes: ['private', 'public'] })).jobId, q.jobId, 'a machine that has stopped asking is not waited for');
  // a machine that proves only Bitcoin batches is not waited for on a press
  const batches = makeProverBoard({ storage: store(), now });
  assert.equal(await batches.claim({ worker: h, classes: ['public'], programs: ['btc-state'] }), null);
  const bp = await batches.post({ class: 'public', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 });
  assert.equal((await batches.claim({ worker: tacit, classes: ['private', 'public'] })).jobId, bp.jobId, 'a machine that does not prove presses is not waited for');
  // a tacit chain block waits longer for a community machine that proves blocks, and with the window set to 0 nothing waits
  const blocks = makeProverBoard({ storage: store(), now });
  const bw = { ...tacit, name: 'tacit-blocks' };
  assert.equal(await blocks.claim({ worker: h, classes: ['public'], programs: ['tacit-block'] }), null);
  const blk = await blocks.post({ class: 'public', program: 'tacit-block', stdin: Buffer.from(`block ${t}`).toString('base64'), cycleLimit: 1e8, gasLimit: 1e9, deadline: now() / 1000 + 900 });
  const bclaim = () => blocks.claim({ worker: bw, classes: ['public'], programs: ['confidential', 'tacit-block'] });
  assert.equal(await bclaim(), null, 'a block waits for the community machine that proves blocks');
  t += PROVER_BOARD.communityFirstMs.confidential;
  assert.equal(await blocks.claim({ worker: h, classes: ['public'], programs: ['tacit-block'] }) !== null, true, 'which races it');
  assert.equal(await bclaim(), null, 'still inside the block window');
  t += PROVER_BOARD.communityFirstMs['tacit-block'];
  assert.equal((await bclaim()).jobId, blk.jobId, 'past it, Tacit\'s worker takes the block too');
  const open = makeProverBoard({ storage: store(), now, cfg: { ...PROVER_BOARD, communityFirstMs: { confidential: 0, 'tacit-block': 0 } } });
  assert.equal(await open.claim({ worker: g, classes: ['public'] }), null);
  const o = await open.post({ class: 'public', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 });
  assert.equal((await open.claim({ worker: tacit, classes: ['private', 'public'] })).jobId, o.jobId, 'windows of 0: nothing waits');
});

test('the tacit chain\'s block program: public groth16 work any community machine that proves it may race', async () => {
  const b = makeProverBoard({ storage: store(), now });
  const stdin = Buffer.alloc(64 * 1024, 3).toString('base64');
  await assert.rejects(b.post({ class: 'private', program: 'tacit-block', stdin, cycleLimit: 1e9, gasLimit: 1e9, deadline: now() / 1000 + 900 }), /class is public/);
  await assert.rejects(b.post({ class: 'public', program: 'tacit-block', mode: 'compressed', stdin, cycleLimit: 1e9, gasLimit: 1e9, deadline: now() / 1000 + 900 }), /proved groth16/);
  const { jobId } = await b.post({ class: 'public', program: 'tacit-block', stdin, cycleLimit: 1e9, gasLimit: 1e9, deadline: now() / 1000 + 900, label: 'tacit-block' });
  const st = await b.status(jobId);
  assert.equal(st.program, 'tacit-block');
  assert.equal(st.mode, 'groth16');
  assert.ok(PROVER_BOARD.communityPrograms.includes('tacit-block'));
  assert.ok(!PROVER_BOARD.turnPrograms.includes('tacit-block'), 'raced, not taken in turns: a block is minutes of work');
});

test('the Bitcoin-state program: public groth16 work, its input kept apart and deleted with the job, leased for hours, raced only by machines that prove it', async () => {
  const s = store(), kept = new Map();
  const notes = new Map();
  Object.assign(s, { putStdin: async (id, v) => { kept.set(id, v); }, getStdin: async (id) => kept.get(id) ?? null, deleteStdin: async (id) => { kept.delete(id); }, putNote: async (k, v) => { notes.set(k, v); } });
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
  assert.equal(notes.get('btc:0x' + '11'.repeat(32)).worker, tacit.name, 'who proved the batch is noted under its new digest (word 6), for the cross-chain block it lands as');
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

// a community machine named by its address, asking from a place of its own (`at`: another place, under the same address)
const gpu = (h, at = `place-${h}`) => ({ name: 'c-0x' + h.repeat(20), classes: ['public'], community: true, client: at });
const batchOn = (b) => { let k = 0; return () => b.post({ class: 'public', program: 'btc-state', stdin: Buffer.from(`batch ${++k} ${t}`).toString('base64'), cycleLimit: 1e11, gasLimit: 1e11, deadline: now() / 1000 + 7200 }); };
const answer = async (b, w, jobId, ok = true) => {
  await b.result({ worker: w, jobId, publicValues: '0x' + '11'.repeat(64 * 8), proof: '0x' + '22'.repeat(260) });
  return b.raceVerdict({ jobId, worker: w.name, ok });
};

test('community: Bitcoin batches go to one machine at a time, in turn, the one longest since its last turn first', async () => {
  t = 5_000_000;
  const b = makeProverBoard({ storage: store(), now }), batch = batchOn(b);
  const a = gpu('a1'), c = gpu('c3');
  const ask = (w) => b.claim({ worker: w, classes: ['public'], programs: ['btc-state'] });
  assert.equal(await ask(a), null); assert.equal(await ask(c), null);
  const b1 = await batch();
  assert.equal(await ask(c), null, 'not c\'s turn: a has waited as long and its name comes first');
  assert.equal((await ask(a)).jobId, b1.jobId, 'a\'s turn');
  assert.equal(await ask(c), null, 'one machine to a batch');
  let row = async (w) => (await b.summary()).workers.find((x) => x.name === w.name);
  assert.equal((await row(a)).racing, 'btc-state', 'the summary says a is proving');
  assert.equal((await row(c)).racing, null);
  t += 1000;
  const b2 = await batch();
  assert.equal(await ask(a), null, 'a is proving');
  assert.equal((await ask(c)).jobId, b2.jobId, 'so the next batch is c\'s');
  assert.deepEqual(await answer(b, a, b1.jobId), { ok: true, status: 'proved' });
  assert.deepEqual(await answer(b, c, b2.jobId), { ok: true, status: 'proved' });
  t += 1000;
  assert.equal(await ask(c), null); assert.equal(await ask(a), null);
  const b3 = await batch();
  assert.equal(await ask(c), null, 'a had its last turn longer ago');
  assert.equal((await ask(a)).jobId, b3.jobId);
  assert.deepEqual([(await row(a)).turns, (await row(c)).turns], [2, 1]);
  const day = Math.floor(now() / 86400000);
  assert.deepEqual((await b.credits(day)).body.miners.map((m) => m.points), [1000, 1000], 'each batch taken pays its machine');
  // a public settle job is still raced by any machine that proves it
  const pub = await b.post({ class: 'public', stdin, cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 });
  const both = [gpu('e5'), gpu('f6')];
  for (const w of both) assert.equal((await b.claim({ worker: w, classes: ['public'] })).jobId, pub.jobId);
});

test('community: a machine that has stopped asking is not waited for, and one that gave a turn back or let it lapse goes after the others', async () => {
  t = 6_000_000;
  const b = makeProverBoard({ storage: store(), now }), batch = batchOn(b);
  const ask = (w) => b.claim({ worker: w, classes: ['public'], programs: ['btc-state'] });
  const x = gpu('a7'), y = gpu('b8');
  assert.equal(await ask(x), null);
  t += PROVER_BOARD.turnSeenMs + 1;
  assert.equal(await ask(y), null);
  const b1 = await batch();
  assert.equal((await ask(y)).jobId, b1.jobId, 'x has not asked in half a minute: y\'s turn');
  assert.deepEqual(await answer(b, y, b1.jobId), { ok: true, status: 'proved' });
  // p gives its turn back: the batch is q's, and p waits behind q next time though its last turn is older (x and y have gone quiet)
  const p = gpu('c9'), q = gpu('da');
  t += PROVER_BOARD.turnSeenMs + 1;
  assert.equal(await ask(p), null); assert.equal(await ask(q), null);
  const b2 = await batch();
  assert.equal((await ask(p)).jobId, b2.jobId);
  assert.deepEqual(await b.result({ worker: p, jobId: b2.jobId, error: 'out of memory' }), { ok: true, status: 'dropped' });
  assert.equal(await ask(p), null, 'a batch is offered to a machine once');
  assert.equal((await ask(q)).jobId, b2.jobId, 'the batch p gave back is q\'s turn');
  assert.deepEqual(await answer(b, q, b2.jobId), { ok: true, status: 'proved' });
  t += 1000;
  assert.equal(await ask(p), null); assert.equal(await ask(q), null);
  const b3 = await batch();
  assert.equal(await ask(p), null, 'p gave its last turn back: q first');
  assert.equal((await ask(q)).jobId, b3.jobId);
  // q's turn lapses (the relay stops waiting and the network proves it): q goes behind p for a while
  assert.deepEqual(await b.cancel({ jobId: b3.jobId }), { ok: true, status: 'cancelled' });
  const s = await b.summary();
  assert.deepEqual([s.workers.find((w) => w.name === p.name).lapsed, s.workers.find((w) => w.name === q.name).lapsed], [1, 1]);
  t += PROVER_BOARD.turnTroubleMs + 1;
  assert.equal(await ask(q), null); assert.equal(await ask(p), null);
  const b4 = await batch();
  assert.equal(await ask(q), null, 'both troubles are old now: p, whose last turn is older, first');
  assert.equal((await ask(p)).jobId, b4.jobId);
});

test('community: a place whose turn went unanswered goes after the others under any address it names, and an address it names is not held to it', async () => {
  t = 7_000_000;
  const b = makeProverBoard({ storage: store(), now }), batch = batchOn(b);
  const ask = (w) => b.claim({ worker: w, classes: ['public'], programs: ['btc-state'] });
  const p = gpu('f1');
  assert.equal(await ask(p), null);
  const b1 = await batch();
  assert.equal((await ask(p)).jobId, b1.jobId);
  assert.deepEqual(await answer(b, p, b1.jobId), { ok: true, status: 'proved' });
  // a machine that has had no turn is next, ahead of p
  t += 1000;
  const x1 = gpu('e1', 'place-x');
  assert.equal(await ask(x1), null); assert.equal(await ask(p), null);
  const b2 = await batch();
  assert.equal(await ask(p), null);
  assert.equal((await ask(x1)).jobId, b2.jobId);
  assert.deepEqual(await b.cancel({ jobId: b2.jobId }), { ok: true, status: 'cancelled' });
  // its turn lapsed: another address from the same place goes after p
  t += 1000;
  const x2 = gpu('e2', 'place-x');
  assert.equal(await ask(x2), null); assert.equal(await ask(p), null);
  const b3 = await batch();
  assert.equal(await ask(x2), null, 'its place let its last turn lapse: p first, whatever address it names');
  assert.equal((await ask(p)).jobId, b3.jobId);
  assert.deepEqual(await answer(b, p, b3.jobId), { ok: true, status: 'proved' });
  // p's address named from another place: a turn that lapses there counts against that place, and p, back at its own, is first again
  t += 1000;
  const elsewhere = gpu('f1', 'place-y');
  assert.equal(await ask(elsewhere), null);
  const b4 = await batch();
  assert.equal((await ask(elsewhere)).jobId, b4.jobId);
  assert.deepEqual(await b.cancel({ jobId: b4.jobId }), { ok: true, status: 'cancelled' });
  t += 1000;
  assert.equal(await ask(x2), null); assert.equal(await ask(p), null);
  const b5 = await batch();
  assert.equal(await ask(x2), null);
  assert.equal((await ask(p)).jobId, b5.jobId, 'the lapse stayed with place-y');
});

test('community: a race is answered only from the place that claimed it, and an address racing from one place may race from another', async () => {
  t = 8_000_000;
  const b = makeProverBoard({ storage: store(), now });
  const job = (s) => b.post({ class: 'public', stdin: Buffer.from(s).toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600 });
  const j1 = await job('race one'), j2 = await job('race two');
  const home = gpu('ab'), away = gpu('ab', 'place-elsewhere');
  assert.equal((await b.claim({ worker: home, classes: ['public'] })).jobId, j1.jobId);
  const cand = { publicValues: '0x' + 'ab'.repeat(64), proof: '0x' + 'cd'.repeat(260) };
  assert.deepEqual(await b.result({ worker: away, jobId: j1.jobId, error: 'gave up' }), { ok: false, error: 'not racing this job' });
  assert.deepEqual(await b.result({ worker: away, jobId: j1.jobId, ...cand }), { ok: false, error: 'not racing this job' });
  assert.equal((await b.claim({ worker: away, classes: ['public'] })).jobId, j2.jobId, 'the same address from another place races the next job');
  assert.equal(await b.claim({ worker: home, classes: ['public'] }), null, 'one job at a time from one place');
  assert.deepEqual(await b.result({ worker: home, jobId: j1.jobId, ...cand }), { ok: true, status: 'candidate' });
  const st = await b.status(j1.jobId);
  assert.deepEqual(st.race.map((c) => Object.keys(c).sort()), [['proof', 'publicValues', 'worker']], 'the relay reads no place');
});

test('a token machine takes the pool\'s waiting jobs before a tacit chain block, and the block once none waits', async () => {
  const b = makeProverBoard({ storage: store(), now });
  const block = await b.post({ class: 'public', program: 'tacit-block', stdin: Buffer.from('a block').toString('base64'), cycleLimit: 1e9, gasLimit: 1e9, deadline: now() / 1000 + 900, label: 'tacit-block' });
  t += 1000;
  const wrap = await b.post({ class: 'private', stdin: Buffer.from('a wrap').toString('base64'), cycleLimit: 1e6, gasLimit: 1e8, deadline: now() / 1000 + 600, label: 'wrap' });
  const ask = (worker) => b.claim({ worker, classes: ['private', 'public'], programs: ['confidential', 'tacit-block'] });
  assert.equal((await ask(tacit)).jobId, wrap.jobId, 'the wrap posted after the block goes first');
  const other = await ask({ name: 'tacit-4090', classes: ['private', 'public'] });
  assert.equal(other.jobId, block.jobId, 'the block, once no other job waits');
  assert.equal(other.program, 'tacit-block');
});

// Batches of a fixed size (1 MB of input unless `mb` says otherwise), so a machine's time per MB is its time.
const sizedBatches = (b) => { let k = 0; return (mb = 1) => b.post({ class: 'public', program: 'btc-state', stdin: Buffer.alloc(Math.round(mb * 1_000_000), ++k % 251).toString('base64'), cycleLimit: 1e11, gasLimit: 1e11, deadline: now() / 1000 + 7200 }); };
// A machine's record from batches it proved in `secs` each: alone on the board (the others last asked over turnSeenMs ago), it takes each
// batch and its proof is taken.
const recordOf = async (b, batch, w, secs, n = 2) => {
  for (let i = 0; i < n; i++) {
    t += PROVER_BOARD.turnSeenMs + 1;
    await b.claim({ worker: w, classes: ['public'], programs: ['btc-state'] });
    const job = await batch();
    assert.equal((await b.claim({ worker: w, classes: ['public'], programs: ['btc-state'] })).jobId, job.jobId);
    t += secs * 1000;
    assert.deepEqual(await answer(b, w, job.jobId), { ok: true, status: 'proved' });
  }
};

test('batches by record: a machine\'s record is the batches taken from it and its usual time; a refused proof or a turn given back adds nothing', async () => {
  t = 20_000_000;
  const b = makeProverBoard({ storage: store(), now, cfg: { ...PROVER_BOARD, bestPct: 0 } }), batch = sizedBatches(b);
  const f = gpu('f1');
  await recordOf(b, batch, f, 100, 1);
  let row = (await b.summary()).workers.find((x) => x.name === f.name);
  assert.deepEqual([row.batches, row.batchSecs], [1, 100]);
  await recordOf(b, batch, f, 200, 1);
  row = (await b.summary()).workers.find((x) => x.name === f.name);
  assert.deepEqual([row.batches, row.batchSecs], [2, 130], 'a running average: 0.7 of what it was and 0.3 of the new time');
  // a refused proof and a given-back turn
  t += PROVER_BOARD.turnSeenMs + 1;
  await b.claim({ worker: f, classes: ['public'], programs: ['btc-state'] });
  const bad = await batch();
  await b.claim({ worker: f, classes: ['public'], programs: ['btc-state'] });
  t += 10_000;
  assert.deepEqual(await answer(b, f, bad.jobId, false), { ok: true, status: 'queued' });
  row = (await b.summary()).workers.find((x) => x.name === f.name);
  assert.deepEqual([row.batches, row.batchSecs], [2, 130], 'only a proof the relay took counts');
  assert.equal((await b.summary()).workers.find((x) => x.name === gpu('99').name), undefined);
  assert.equal(goesByRecord('anything', 0), false, 'at 0 no batch goes by record');
  assert.equal(goesByRecord('anything', 100), true, 'at 100 every one does');
  const ids = Array.from({ length: 2000 }, (_, i) => `pb_job_${i}`), share = ids.filter((x) => goesByRecord(x, 50)).length / ids.length;
  assert.ok(share > 0.45 && share < 0.55, `about half by record at 50 (${share})`);
  assert.equal(goesByRecord('pb_job_7', 50), goesByRecord('pb_job_7', 50), 'the same batch the same way');
});

test('batches by record: a batch that goes by record goes to the fastest machines with a record, in turn among the best few; one in turn still goes to the longest waiting', async () => {
  t = 30_000_000;
  const fast = gpu('a1'), quick = gpu('b2'), slow = gpu('c3'), fresh = gpu('d4');
  for (const [pct, label] of [[100, 'by record'], [0, 'in turn']]) {
    const b = makeProverBoard({ storage: store(), now, cfg: { ...PROVER_BOARD, bestPct: pct, bestOf: 2 } }), batch = sizedBatches(b);
    await recordOf(b, batch, fast, 90);
    await recordOf(b, batch, quick, 120);
    await recordOf(b, batch, slow, 1500);
    const ask = (w) => b.claim({ worker: w, classes: ['public'], programs: ['btc-state'] });
    const got = [];
    for (let i = 0; i < 4; i++) {
      t += 1000;
      for (const w of [fresh, slow, quick, fast]) await ask(w);          // all four waiting, none proving
      const job = await batch();
      let who = null;
      for (const w of [fresh, slow, quick, fast]) { const r = await ask(w); if (r && r.jobId === job.jobId) { who = w; break; } }
      got.push(who.name.slice(4, 6));
      t += 30_000;
      await answer(b, who, job.jobId);
    }
    if (pct === 100) assert.deepEqual(got, ['a1', 'b2', 'a1', 'b2'], `${label}: the two fastest take turns, the slow machine and the new one wait`);
    else assert.deepEqual(got, ['d4', 'a1', 'b2', 'c3'], `${label}: the machine that never had a turn first, then each by how long since its last, the slow one included`);
  }
});

test('batches by record: a machine with a record has three times its usual time to answer a turn, then the batch goes on and its place waits behind the others; one without keeps the batch\'s lease', async () => {
  t = 40_000_000;
  const b = makeProverBoard({ storage: store(), now, cfg: { ...PROVER_BOARD, bestPct: 100 } }), batch = sizedBatches(b);
  const fast = gpu('a1'), other = gpu('e5'), fresh = gpu('d4');
  await recordOf(b, batch, fast, 150);                 // 150 s: 450 s to answer
  const ask = (w) => b.claim({ worker: w, classes: ['public'], programs: ['btc-state'] });
  t += PROVER_BOARD.turnSeenMs + 1;
  await ask(other); await ask(fast);
  const job = await batch();
  const turn = await ask(fast);
  assert.equal(turn.jobId, job.jobId);
  assert.equal(turn.leaseUntil, now() + 450_000, 'it is told how long it has');
  t += 449_000;
  await ask(other); await ask(fast);
  assert.equal(await ask(other), null, 'still its turn');
  t += 2000;
  await ask(fast);
  assert.equal((await ask(other)).jobId, job.jobId, 'past three times its usual time, the batch goes to the next machine');
  const s = await b.summary();
  assert.equal(s.workers.find((x) => x.name === fast.name).lapsed, 1, 'the unanswered turn counts against it');
  assert.equal((await b.result({ worker: fast, jobId: job.jobId, publicValues: '0x' + '11'.repeat(64 * 8), proof: '0x' + '22'.repeat(260) })).error, 'not racing this job', 'its late answer is not taken');
  // its place now waits behind the others, under any address: a fresh machine with no record takes the next batch, and keeps it past 450 s
  t += 1000;
  await ask(fast); await ask(fresh);
  const next = await batch();
  assert.equal(await ask(fast), null, 'a place whose turn went unanswered goes after the others');
  const mine = await ask(fresh);
  assert.equal(mine.jobId, next.jobId);
  assert.equal(mine.leaseUntil, Math.min(next ? (now() / 1000 + 7200) * 1000 : 0, now() + PROVER_BOARD.leaseMsByProgram['btc-state']), 'no record: the batch\'s own lease');
  t += 30 * 60_000;
  await ask(fresh);
  assert.equal(await ask(other), null, 'half an hour on, still the new machine\'s turn');
});

test('batches by record: a machine is timed per MB of input, so a bigger batch gives it longer to answer and a big one proved does not make it look slow', async () => {
  t = 50_000_000;
  const b = makeProverBoard({ storage: store(), now, cfg: { ...PROVER_BOARD, bestPct: 100 } }), batch = sizedBatches(b);
  const big = gpu('a1'), small = gpu('b2');
  // big proves 3 MB batches in 300 s (100 s per MB); small proves 1 MB batches in 150 s (150 s per MB)
  for (let i = 0; i < 2; i++) {
    t += PROVER_BOARD.turnSeenMs + 1;
    await b.claim({ worker: big, classes: ['public'], programs: ['btc-state'] });
    const job = await batch(3);
    assert.equal((await b.claim({ worker: big, classes: ['public'], programs: ['btc-state'] })).jobId, job.jobId);
    t += 300_000;
    await answer(b, big, job.jobId);
  }
  await recordOf(b, (mb) => batch(mb), small, 150);
  const rows = (await b.summary()).workers;
  assert.deepEqual(['a1', 'b2'].map((h) => rows.find((x) => x.name === gpu(h).name).batchSecs), [300, 150], 'the summary shows each machine\'s usual time');
  t += 1000;
  const ask = (w) => b.claim({ worker: w, classes: ['public'], programs: ['btc-state'] });
  await ask(small); await ask(big);
  const two = await batch(2);
  assert.equal(await ask(small), null, 'per MB, big is the faster machine though its batches took longer');
  const turn = await ask(big);
  assert.equal(turn.jobId, two.jobId);
  assert.equal(turn.leaseUntil, now() + 3 * 100 * 2 * 1000, 'three times 100 s per MB for a 2 MB batch: 600 s');
});
