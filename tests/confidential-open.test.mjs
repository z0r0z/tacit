// The open board (worker/src/confidential-open.js + the board half of worker/src/confidential-settle.js): a relayed job
// the relay proved but is not sending goes on the board; a proof made elsewhere can be posted there; any sender closes a
// job by a transaction the API checks; a relay takes one to send and gives it back. In-memory storage, injected clock.
//
// Run: node --test tests/confidential-open.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeConfidentialSettler, OPEN_TYPES } from '../worker/src/confidential-settle.js';
import { pvDeadline, pvFees, settleCalldata, carriesPublicValues, checkPostedShape, SETTLE_SELECTOR } from '../worker/src/confidential-open.js';

const hash = (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
const instantSleep = () => Promise.resolve();
function freshStore() {
  const jobs = new Map(); let pending = [], open = [];
  return {
    getPending: async () => pending.slice(), putPending: async (ids) => { pending = ids.slice(); },
    getOpen: async () => open.slice(), putOpen: async (ids) => { open = ids.slice(); },
    getJob: async (id) => (jobs.has(id) ? JSON.parse(JSON.stringify(jobs.get(id))) : null),
    putJob: async (id, job) => { jobs.set(id, JSON.parse(JSON.stringify(job))); },
  };
}
function setup(opts = {}) {
  const clock = { t: 1_000_000 };
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now: () => clock.t, sleep: instantSleep, ...opts });
  return { q, clock };
}

// A real mainnet settle (a relay cut that paid a tETH fee), split back into its three arguments.
function splitSettle(data) {
  const h = data.trim().replace(/^0x/, '').slice(8);
  const word = (i) => Number(BigInt('0x' + h.slice(i * 64, i * 64 + 64)));
  const bytesAt = (off) => { const n = word(off / 32); return '0x' + h.slice(off * 2 + 64, off * 2 + 64 + n * 2); };
  const memosOff = word(2), count = word(memosOff / 32);
  const memos = [];
  for (let i = 0; i < count; i++) memos.push(bytesAt(memosOff + 32 + word(memosOff / 32 + 1 + i)));
  return { publicValues: bytesAt(word(0)), proof: bytesAt(word(1)), memos };
}
const REAL = readFileSync(new URL('./fixtures/settle-split-0xf033a9be.hex', import.meta.url), 'utf8').trim();
const real = splitSettle(REAL);

test('public values: fee legs and deadline read from a real settle, and settle() re-encodes it byte for byte', () => {
  assert.deepEqual(pvFees(real.publicValues), [{ assetId: '0x3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34', value: '41000' }]);
  assert.equal(pvDeadline(real.publicValues), 0);
  assert.equal(settleCalldata(real), REAL.toLowerCase());
  assert.ok(settleCalldata(real).startsWith(SETTLE_SELECTOR));
  assert.ok(carriesPublicValues(REAL, real.publicValues));
  assert.ok(carriesPublicValues('0xabcdef' + REAL.slice(2) + '00', real.publicValues), 'wrapped calldata still carries them');
  assert.ok(!carriesPublicValues(REAL, '0x' + 'ab'.repeat(64)));
  assert.equal(checkPostedShape(real), null);
  assert.match(checkPostedShape({ ...real, publicValues: '0x1234' }), /publicValues/);
  assert.match(checkPostedShape({ ...real, memos: 'x' }), /memos/);
});

const PV = real.publicValues, PROOF = real.proof, MEMOS = real.memos;
const transferOp = { spendRoot: '0x01', chainBinding: '0x02', inputs: [{ x: 1 }] };

test('a relayed job the relay proved but cannot send goes on the board, and reads open with what a sender needs', async () => {
  const { q } = setup();
  const j = await q.submitJob({ type: 'transfer', op: transferOp, memos: MEMOS });
  await q.nextJob();
  const r = await q.ackJob(j.jobId, { publicValues: PV, proof: PROOF, open: true });
  assert.equal(r.status, 'open');
  assert.equal(await q.pendingCount(), 0, 'off the pending queue');
  const st = await q.jobStatus(j.jobId);
  assert.equal(st.status, 'open');
  assert.equal(st.publicValues, PV);
  assert.deepEqual(st.memos, MEMOS);
  const board = await q.openList();
  assert.equal(board.length, 1);
  assert.equal(board[0].jobId, j.jobId);
  assert.equal(board[0].posted, false);
  assert.deepEqual((await q.queueStats()).open, 1);
});

test('a job with an exit recipe, a prove-mode job, or a router-embedded type stays off the board', async () => {
  const { q } = setup();
  const p = await q.submitJob({ type: 'transfer', op: transferOp, memos: [], mode: 'prove' });
  await q.nextJob();
  assert.equal((await q.ackJob(p.jobId, { publicValues: PV, proof: PROOF, open: true })).ok, false);
  const w = await q.submitJob({ type: 'wraptransfer', op: { a: 1 } });
  await q.nextJob();
  assert.equal((await q.ackJob(w.jobId, { publicValues: PV, proof: PROOF, open: true })).ok, false);
  assert.ok(!OPEN_TYPES.includes('bridgemint') && !OPEN_TYPES.includes('fastlane'), 'root-pinned proofs never go on the board');
  assert.ok(!OPEN_TYPES.some((t) => t.startsWith('adaptor')), 'an adaptor-swap leg is never published before it lands');
  assert.equal((await q.openList()).length, 0);
});

test('a relay takes an open job to send: sending, then settled by its transaction', async () => {
  const { q } = setup();
  const j = await q.submitJob({ type: 'transfer', op: transferOp, memos: MEMOS });
  await q.nextJob();
  await q.ackJob(j.jobId, { publicValues: PV, proof: PROOF, open: true });
  const got = await q.nextOpen({ id: j.jobId });
  assert.equal(got.jobId, j.jobId);
  assert.equal(got.mode, 'open');
  assert.equal(got.publicValues, PV);
  assert.equal(await q.nextOpen({ id: j.jobId }), null, 'not taken twice');
  assert.equal((await q.openList())[0].status, 'sending');
  const r = await q.ackJob(j.jobId, { txHash: '0xfeed' });
  assert.equal(r.status, 'settled');
  assert.equal((await q.openList()).length, 0);
});

test('a send the relay gives back, or never finishes, is open again for anyone', async () => {
  const { q, clock } = setup();
  const j = await q.submitJob({ type: 'transfer', op: transferOp, memos: MEMOS });
  await q.nextJob();
  await q.ackJob(j.jobId, { publicValues: PV, proof: PROOF, open: true });
  await q.nextOpen();
  await q.ackJob(j.jobId, { release: true });
  assert.equal((await q.jobStatus(j.jobId)).status, 'open');
  await q.nextOpen();
  assert.equal((await q.jobStatus(j.jobId)).status, 'sending');
  clock.t += 6 * 60 * 1000;
  assert.equal((await q.jobStatus(j.jobId)).status, 'open', 'a lapsed send reads open');
  assert.equal((await q.nextOpen()).jobId, j.jobId, 'and can be taken again');
});

test('a proof that no longer fits the chain is proved again when the relay holds the witness, and fails when it does not', async () => {
  const { q } = setup({ verifyPosted: async () => ({ ok: true }) });
  const j = await q.submitJob({ type: 'transfer', op: transferOp, memos: MEMOS });
  await q.nextJob();
  await q.ackJob(j.jobId, { publicValues: PV, proof: PROOF, open: true });
  await q.nextOpen();
  await q.ackJob(j.jobId, { error: 'settle reverts (0x8a98f245)', requeue: true });
  const st = await q.jobStatus(j.jobId);
  assert.equal(st.status, 'pending');
  assert.equal(st.publicValues, null);
  assert.equal(await q.pendingCount(), 1, 'back in the queue to be proved');
  const p = await q.submitJob({ type: 'transfer', mode: 'preproven', publicValues: PV, proof: PROOF, memos: MEMOS });
  await q.nextOpen({ id: p.jobId });
  await q.ackJob(p.jobId, { error: 'settle reverts', requeue: true });
  assert.equal((await q.jobStatus(p.jobId)).status, 'failed', 'a posted proof has no witness to prove again');
});

test('a posted proof is simulated first, deduplicated by its public values, and listed as posted', async () => {
  let calls = 0;
  const { q } = setup({ verifyPosted: async ({ publicValues }) => { calls++; return publicValues === PV ? { ok: true } : { ok: false, error: 'settle reverts (0xb115d857)' }; } });
  const a = await q.submitJob({ type: 'transfer', mode: 'preproven', publicValues: PV.toUpperCase().replace('0X', '0x'), proof: PROOF, memos: MEMOS });
  assert.equal(a.status, 'open');
  const b = await q.submitJob({ type: 'transfer', mode: 'preproven', publicValues: PV, proof: PROOF, memos: MEMOS });
  assert.equal(b.jobId, a.jobId);
  assert.ok(b.deduped);
  assert.equal(calls, 1, 'a duplicate is not simulated again');
  await assert.rejects(() => q.submitJob({ type: 'transfer', mode: 'preproven', publicValues: '0x' + 'ab'.repeat(64), proof: PROOF, memos: [] }), /would not take this proof now \(settle reverts \(0xb115d857\)\)/);
  await assert.rejects(() => q.submitJob({ type: 'wraptransfer', mode: 'preproven', publicValues: PV, proof: PROOF, memos: [] }), /cannot be posted/);
  const board = await q.openList();
  assert.equal(board.length, 1);
  assert.equal(board[0].posted, true);
  const none = setup();
  await assert.rejects(() => none.q.submitJob({ type: 'transfer', mode: 'preproven', publicValues: PV, proof: PROOF, memos: [] }), /not taken here/);
  // a wrap-swap posts only while its deposit waits in the pool: the simulated settle is what tells the two apart
  const ws = setup({ verifyPosted: async ({ publicValues }) => (publicValues === PV ? { ok: true } : { ok: false, error: 'settle reverts (DepositNotPending)' }) });
  await assert.rejects(() => ws.q.submitJob({ type: 'wrapswap', mode: 'preproven', publicValues: '0x' + 'cd'.repeat(64), proof: PROOF, memos: [] }), /would not take this proof now \(settle reverts \(DepositNotPending\)\)/);
  assert.equal((await ws.q.submitJob({ type: 'wrapswap', mode: 'preproven', publicValues: PV, proof: PROOF, memos: MEMOS })).status, 'open');
  assert.ok(!OPEN_TYPES.includes('wrapswap'), 'a relayed wrap-swap job is not put on the board by the relay');
});

test('a reported landing closes the job only when the check passes, and a proven prove-mode job can be closed too', async () => {
  const { q } = setup();
  const j = await q.submitJob({ type: 'transfer', op: transferOp, memos: MEMOS });
  await q.nextJob();
  await q.ackJob(j.jobId, { publicValues: PV, proof: PROOF, open: true });
  const no = await q.landedJob(j.jobId, '0x' + '11'.repeat(32), async () => ({ ok: false, error: 'that transaction reverted' }));
  assert.equal(no.ok, false);
  assert.equal((await q.jobStatus(j.jobId)).status, 'open');
  const yes = await q.landedJob(j.jobId, '0x' + '22'.repeat(32), async (job, tx) => ({ ok: job.publicValues === PV && tx.startsWith('0x22') }));
  assert.equal(yes.status, 'settled');
  assert.equal((await q.openList()).length, 0);
  const p = await q.submitJob({ type: 'unwrap', op: { v: 1 }, memos: [], mode: 'prove' });
  await q.nextJob();
  await q.ackJob(p.jobId, { publicValues: PV, proof: PROOF });
  assert.equal((await q.landedJob(p.jobId, '0x' + '33'.repeat(32), async () => ({ ok: true }))).status, 'settled');
  const pending = await q.submitJob({ type: 'transfer', op: { other: 1 } });
  assert.equal((await q.landedJob(pending.jobId, '0x' + '44'.repeat(32), async () => ({ ok: true }))).ok, false, 'a job with no proof yet is not closed this way');
});

test('a job leaves the board as failed at its own deadline; a posted proof also after a day, a relayed one does not', async () => {
  const { q, clock } = setup({ expiryOf: ({ op }) => (op && op.deadline) || 0, verifyPosted: async () => ({ ok: true }) });
  const by = Math.floor(clock.t / 1000) + 600;
  const j = await q.submitJob({ type: 'transfer', op: { ...transferOp, deadline: by }, memos: MEMOS });
  await q.nextJob();
  await q.ackJob(j.jobId, { publicValues: PV, proof: PROOF, open: true });
  const k = await q.submitJob({ type: 'transfer', op: { ...transferOp, n: 2 }, memos: MEMOS });
  await q.nextJob();
  await q.ackJob(k.jobId, { publicValues: PV, proof: PROOF, open: true });
  const p = await q.submitJob({ type: 'transfer', mode: 'preproven', publicValues: '0x' + 'cd'.repeat(64), proof: PROOF, memos: [] });
  assert.equal((await q.openList()).length, 3);
  clock.t += 601 * 1000;
  assert.equal(await q.nextOpen({ id: j.jobId }), null, 'a job past its deadline is not taken to send');
  assert.equal((await q.openList()).length, 2);
  assert.match((await q.jobStatus(j.jobId)).error, /before its deadline/);
  clock.t += 24 * 3600 * 1000;
  const left = await q.openList();
  assert.deepEqual(left.map((x) => x.jobId), [k.jobId], 'the relayed job with no deadline stays for the relay to send');
  assert.match((await q.jobStatus(p.jobId)).error, /within a day/);
});

test('one landing closes every job on the board that carries the same proof', async () => {
  const { q } = setup({ verifyPosted: async () => ({ ok: true }) });
  const j = await q.submitJob({ type: 'transfer', op: transferOp, memos: MEMOS });
  await q.nextJob();
  await q.ackJob(j.jobId, { publicValues: PV, proof: PROOF, open: true });
  const p = await q.submitJob({ type: 'transfer', mode: 'preproven', publicValues: PV, proof: PROOF, memos: MEMOS });
  assert.notEqual(p.jobId, j.jobId);
  assert.equal((await q.openList()).length, 2);
  await q.landedJob(p.jobId, '0x' + '55'.repeat(32), async () => ({ ok: true }));
  assert.equal((await q.openList()).length, 0);
  assert.equal((await q.jobStatus(j.jobId)).status, 'settled');
  assert.equal((await q.jobStatus(j.jobId)).txHash, '0x' + '55'.repeat(32));
});
