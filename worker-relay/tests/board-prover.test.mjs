// lib/board-prover.js: the relay's board lane, with the API and the chain stood in for.
// Run: node --test worker-relay/tests/board-prover.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBoardProver } from '../src/lib/board-prover.js';

function fakeBoard({ script = [], verifyOk = true, postOk = true } = {}) {
  const calls = { post: [], cancel: [], verify: [] };
  let i = 0;
  let t = 0;
  const api = {
    post: async (b) => { calls.post.push(b); return postOk ? { ok: true, jobId: '0xjob1234567890', status: 'queued' } : { ok: false, error: 'the board is full' }; },
    status: async () => script[Math.min(i++, script.length - 1)] || { status: 'queued' },
    cancel: async (jobId, reason) => { calls.cancel.push({ jobId, reason }); return { ok: true }; },
    verify: async (a) => { calls.verify.push(a); return verifyOk; },
    now: () => t,
    sleep: async (ms) => { t += ms; },
    waitMs: 30_000, pollMs: 1000,
  };
  return { api, calls };
}
const stdin = new Uint8Array([1, 2, 3, 4]);
const PV = '0x' + 'aa'.repeat(64), PROOF = '0x' + 'bb'.repeat(260);

test('posts the input with its class and limits, follows the job, verifies the proof and returns it', async () => {
  const { api, calls } = fakeBoard({ script: [{ status: 'queued' }, { status: 'claimed', worker: 'gpu1' }, { status: 'proved', worker: 'gpu1', publicValues: PV, proof: PROOF }] });
  const lane = makeBoardProver(api);
  const r = await lane.prove({ stdin, cycleLimit: 256_000_000n, gasLimit: 1_000_000_000n, cls: 'private', label: 'wrap', memos: ['0x01'] });
  assert.deepEqual(r, { publicValues: PV, proof: PROOF, worker: 'gpu1', jobId: '0xjob1234567890' });
  assert.equal(calls.post.length, 1);
  assert.equal(calls.post[0].class, 'private'); assert.equal(calls.post[0].stdin, Buffer.from(stdin).toString('base64'));
  assert.equal(calls.post[0].cycleLimit, 256_000_000); assert.equal(calls.post[0].gasLimit, 1_000_000_000);
  assert.equal(calls.post[0].deadline, 30 + 60, 'the deadline is a minute past the wait');
  assert.deepEqual(calls.verify, [{ publicValues: PV, proof: PROOF, memos: ['0x01'] }]);
  assert.equal(calls.cancel.length, 0);
});

test('a sealed input is posted as it came, with no stdin, and proved like any other', async () => {
  const { api, calls } = fakeBoard({ script: [{ status: 'claimed', worker: 'tacit-a5000' }, { status: 'proved', worker: 'tacit-a5000', publicValues: PV, proof: PROOF }] });
  const sealed = { worker: 'tacit-a5000', epk: '0x02' + 'ab'.repeat(32), iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJD'.repeat(10) };
  const r = await makeBoardProver(api).prove({ sealed, cycleLimit: 1n, gasLimit: 1n, label: 'sealed transfer', memos: ['0x01'] });
  assert.equal(r.worker, 'tacit-a5000'); assert.equal(r.publicValues, PV);
  assert.equal(calls.post.length, 1);
  assert.deepEqual(calls.post[0].sealed, sealed); assert.equal(calls.post[0].stdin, undefined);
  await assert.rejects(makeBoardProver(api).prove({ sealed: { worker: 'x' }, cycleLimit: 1n, gasLimit: 1n }), /sealed must be/);
  await assert.rejects(makeBoardProver(api).prove({ cycleLimit: 1n, gasLimit: 1n }), /stdin must be/);
});

test('a proof the pool refuses is cancelled as bad and misses; a failed, expired or unposted job misses', async () => {
  let f = fakeBoard({ script: [{ status: 'proved', worker: 'eve', publicValues: PV, proof: PROOF }], verifyOk: false });
  await assert.rejects(makeBoardProver(f.api).prove({ stdin, cycleLimit: 1, gasLimit: 1 }), (e) => e.code === 'board_miss' && /did not pass/.test(e.message) && e.worker === 'eve');
  assert.deepEqual(f.calls.cancel, [{ jobId: '0xjob1234567890', reason: 'bad' }]);
  f = fakeBoard({ script: [{ status: 'failed', worker: 'gpu1', error: 'CUDA died' }] });
  await assert.rejects(makeBoardProver(f.api).prove({ stdin, cycleLimit: 1, gasLimit: 1 }), (e) => e.code === 'board_miss' && /CUDA died/.test(e.message));
  f = fakeBoard({ script: [{ status: 'expired' }] });
  await assert.rejects(makeBoardProver(f.api).prove({ stdin, cycleLimit: 1, gasLimit: 1 }), (e) => e.code === 'board_miss' && /expired/.test(e.message));
  f = fakeBoard({ postOk: false });
  await assert.rejects(makeBoardProver(f.api).prove({ stdin, cycleLimit: 1, gasLimit: 1 }), (e) => e.code === 'board_miss' && /the board is full/.test(e.message));
  await assert.rejects(makeBoardProver(f.api).prove({ stdin: 'nope', cycleLimit: 1, gasLimit: 1 }), /input bytes/);
});

test('a proof for roots the pool has moved past is cancelled as stale, not held against the worker', async () => {
  const f = fakeBoard({ script: [{ status: 'proved', worker: 'tacit-a5000', publicValues: PV, proof: PROOF }] });
  f.api.verify = async () => 'stale';
  await assert.rejects(makeBoardProver(f.api).prove({ stdin, cycleLimit: 1n, gasLimit: 1n }), (e) => e.code === 'board_miss' && e.stale === true && /moved past/.test(e.message));
  assert.deepEqual(f.calls.cancel, [{ jobId: '0xjob1234567890', reason: 'stale' }]);
});

test('nobody in time: the job is cancelled and the miss says who had claimed it; a shorter job timeout bounds the wait', async () => {
  const f = fakeBoard({ script: [{ status: 'claimed', worker: 'gpu1' }] });
  await assert.rejects(makeBoardProver(f.api).prove({ stdin, cycleLimit: 1, gasLimit: 1, timeoutMs: 10_000 }), (e) => e.code === 'board_miss' && /within 10 s/.test(e.message) && /gpu1 had claimed it/.test(e.message));
  assert.deepEqual(f.calls.cancel, [{ jobId: '0xjob1234567890', reason: 'timeout' }]);
  assert.equal(f.calls.post[0].deadline, 10 + 60);
});

test('with no worker seen lately the job is not posted at all', async () => {
  const f = fakeBoard({ script: [{ status: 'queued' }] });
  await assert.rejects(makeBoardProver({ ...f.api, alive: async () => false }).prove({ stdin, cycleLimit: 1, gasLimit: 1 }), (e) => e.code === 'board_miss' && /no worker/.test(e.message));
  assert.equal(f.calls.post.length, 0);
  const g = fakeBoard({ script: [{ status: 'proved', worker: 'gpu1', publicValues: PV, proof: PROOF }] });
  const r = await makeBoardProver({ ...g.api, alive: async () => { throw new Error('unreadable'); } }).prove({ stdin, cycleLimit: 1, gasLimit: 1 });
  assert.equal(r.worker, 'gpu1', 'an unreadable liveness read does not hold the job back');
});

test('another program: posted with its program and mode, and checked by the caller\'s check instead of the settle check', async () => {
  const f = fakeBoard({ script: [{ status: 'proved', worker: 'tacit-a5000', publicValues: PV, proof: 'QUJD' }], verifyOk: false });
  const seen = [];
  const r = await makeBoardProver(f.api).prove({ stdin, cycleLimit: 3e9, gasLimit: 3e9, cls: 'eth-state', program: 'eth-state', mode: 'compressed', check: async (a) => { seen.push(a); return true; } });
  assert.equal(r.proof, 'QUJD');
  assert.equal(f.calls.post[0].program, 'eth-state'); assert.equal(f.calls.post[0].mode, 'compressed'); assert.equal(f.calls.post[0].class, 'eth-state');
  assert.equal(f.calls.verify.length, 0, 'the settle check is not run for it');
  assert.deepEqual(seen, [{ publicValues: PV, proof: 'QUJD', memos: [] }]);
  const g = fakeBoard({ script: [{ status: 'proved', worker: 'tacit-a5000', publicValues: PV, proof: PROOF }] });
  await makeBoardProver(g.api).prove({ stdin, cycleLimit: 1, gasLimit: 1 });
  assert.equal(g.calls.post[0].program, 'confidential'); assert.equal('mode' in g.calls.post[0], false, 'a settle job is posted as before');
});

test('a check that could not run cancels without a mark against the worker; a refusal counts as bad', async () => {
  let f = fakeBoard({ script: [{ status: 'proved', worker: 'tacit-a5000', publicValues: PV, proof: 'QUJD' }] });
  await assert.rejects(makeBoardProver(f.api).prove({ stdin, cycleLimit: 1, gasLimit: 1, program: 'eth-state', check: async () => 'unchecked' }), (e) => e.code === 'board_miss' && /could not be checked here/.test(e.message));
  assert.deepEqual(f.calls.cancel, [{ jobId: '0xjob1234567890', reason: 'unchecked' }]);
  f = fakeBoard({ script: [{ status: 'proved', worker: 'tacit-a5000', publicValues: PV, proof: 'QUJD' }] });
  await assert.rejects(makeBoardProver(f.api).prove({ stdin, cycleLimit: 1, gasLimit: 1, program: 'eth-state', check: async () => { throw new Error('spawn failed'); } }), (e) => e.code === 'board_miss' && /could not be checked/.test(e.message));
  assert.deepEqual(f.calls.cancel, [{ jobId: '0xjob1234567890', reason: 'unchecked' }], 'a check that throws is not the worker\'s fault');
  f = fakeBoard({ script: [{ status: 'proved', worker: 'eve', publicValues: PV, proof: 'QUJD' }] });
  await assert.rejects(makeBoardProver(f.api).prove({ stdin, cycleLimit: 1, gasLimit: 1, program: 'eth-state', check: async () => false }), (e) => e.code === 'board_miss' && /did not pass the check/.test(e.message));
  assert.deepEqual(f.calls.cancel, [{ jobId: '0xjob1234567890', reason: 'bad' }]);
});

test('community candidates: each is checked as a board proof is; a bad one is reported and the wait goes on, the first good one is the proof', async () => {
  const BAD = '0x' + 'cc'.repeat(260);
  const { api, calls } = fakeBoard({ script: [
    { status: 'claimed', worker: 'tacit-a5000', race: [{ worker: 'c-0x01', publicValues: PV, proof: BAD }] },
    { status: 'claimed', worker: 'tacit-a5000', race: [{ worker: 'c-0x01', publicValues: PV, proof: BAD }, { worker: 'c-0x02', publicValues: PV, proof: PROOF }] },
  ] });
  const verdicts = [];
  api.verify = async (a) => { calls.verify.push(a); return a.proof === PROOF; };
  api.race = async (jobId, worker, ok) => { verdicts.push([worker, ok]); };
  const r = await makeBoardProver(api).prove({ stdin, cycleLimit: 1n, gasLimit: 1n, cls: 'public', label: 'wrapswap', memos: [] });
  assert.deepEqual(r, { publicValues: PV, proof: PROOF, worker: 'c-0x02', jobId: '0xjob1234567890' });
  assert.deepEqual(verdicts, [['c-0x01', false], ['c-0x02', true]], 'each candidate judged once');
  assert.equal(calls.verify.length, 2);
  assert.equal(calls.post[0].class, 'public');
});

test('community candidates: with only bad ones, the house worker\'s proof is still taken', async () => {
  const BAD = '0x' + 'cc'.repeat(260);
  const { api } = fakeBoard({ script: [
    { status: 'claimed', worker: 'tacit-a5000', race: [{ worker: 'c-0x01', publicValues: PV, proof: BAD }] },
    { status: 'proved', worker: 'tacit-a5000', publicValues: PV, proof: PROOF },
  ] });
  api.verify = async (a) => a.proof === PROOF;
  const verdicts = [];
  api.race = async (jobId, worker, ok) => { verdicts.push([worker, ok]); };
  const r = await makeBoardProver(api).prove({ stdin, cycleLimit: 1n, gasLimit: 1n, cls: 'public', memos: [] });
  assert.equal(r.worker, 'tacit-a5000');
  assert.deepEqual(verdicts, [['c-0x01', false]]);
});

test('a community candidate is judged as such (community: true), Tacit\'s own worker\'s proof without it', async () => {
  const { api } = fakeBoard({ script: [
    { status: 'claimed', worker: 'tacit-a5000', race: [{ worker: 'c-0x01', publicValues: PV, proof: PROOF }] },
    { status: 'proved', worker: 'tacit-a5000', publicValues: PV, proof: PROOF },
  ] });
  const seen = [];
  api.verify = async (a) => { seen.push(!!a.community); return a.community ? 'unchecked' : true; };
  const verdicts = [];
  api.race = async (jobId, worker, ok) => { verdicts.push([worker, ok]); };
  const r = await makeBoardProver(api).prove({ stdin, cycleLimit: 1n, gasLimit: 1n, cls: 'public', memos: [] });
  assert.equal(r.worker, 'tacit-a5000', 'an unchecked candidate is not taken; the house proof is');
  assert.deepEqual(seen, [true, false]);
  assert.deepEqual(verdicts, [['c-0x01', null]], 'nor marked');
});

// A wrap proved before its deposit: the pool's settle simulation can only refuse it, so each proof is judged as board-check.js judgeNodeposit judges it.
import { judgeNodeposit, consumesJobDeposits } from '../src/lib/board-check.js';
const DEP = '0x' + 'aa'.repeat(32);
const word32 = (x) => BigInt(x).toString(16).padStart(64, '0');
const pvOf = (deposit) => {
  const head = Array.from({ length: 32 }, () => word32(0)); head[0] = word32(32); head[6] = word32(31 * 32);
  return '0x' + head.join('') + word32(1) + deposit.slice(2);
};
// the check proveSettle builds for a public job, with the verifier answering for a sound proof
const nodepositCheck = (verdicts) => (c) => (c.community && !consumesJobDeposits(c.publicValues, [DEP]) ? false : judgeNodeposit({ community: c.community, publicValues: c.publicValues, proof: c.proof, want: [DEP], expect: null, verify: async () => verdicts(c) }));

test('prove-first wrap: a community proof of the job\'s own deposit that arrives first is the job\'s proof, and Tacit\'s worker is not waited for', async () => {
  const { api } = fakeBoard({ script: [
    { status: 'claimed', worker: 'tacit-a5000', race: [{ worker: 'c-0x01', publicValues: pvOf(DEP), proof: PROOF }] },
    { status: 'proved', worker: 'tacit-a5000', publicValues: pvOf(DEP), proof: PROOF },
  ] });
  const verdicts = [];
  api.race = async (jobId, worker, ok) => { verdicts.push([worker, ok]); };
  const r = await makeBoardProver(api).prove({ stdin, cycleLimit: 1n, gasLimit: 1n, cls: 'public', memos: [], check: nodepositCheck(() => true) });
  assert.equal(r.worker, 'c-0x01');
  assert.deepEqual(verdicts, [['c-0x01', true]]);
});

test('prove-first wrap: a community proof of someone else\'s deposit is marked bad and Tacit\'s worker\'s proof is taken', async () => {
  const { api } = fakeBoard({ script: [
    { status: 'claimed', worker: 'tacit-a5000', race: [{ worker: 'c-0x01', publicValues: pvOf('0x' + 'bb'.repeat(32)), proof: PROOF }] },
    { status: 'proved', worker: 'tacit-a5000', publicValues: pvOf(DEP), proof: PROOF },
  ] });
  const verdicts = [];
  api.race = async (jobId, worker, ok) => { verdicts.push([worker, ok]); };
  const r = await makeBoardProver(api).prove({ stdin, cycleLimit: 1n, gasLimit: 1n, cls: 'public', memos: [], check: nodepositCheck(() => true) });
  assert.equal(r.worker, 'tacit-a5000');
  assert.deepEqual(verdicts, [['c-0x01', false]]);
});

test('prove-first wrap: when Tacit\'s worker is first, its proof is taken after the verifier, and a later community proof is never needed', async () => {
  const { api } = fakeBoard({ script: [{ status: 'proved', worker: 'tacit-a5000', publicValues: pvOf(DEP), proof: PROOF }] });
  api.race = async () => { throw new Error('no candidate was offered'); };
  const r = await makeBoardProver(api).prove({ stdin, cycleLimit: 1n, gasLimit: 1n, cls: 'public', memos: [], check: nodepositCheck(() => true) });
  assert.equal(r.worker, 'tacit-a5000');
});
