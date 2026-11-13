#!/usr/bin/env node
// Confidential settle relay — job-queue unit test (worker/src/confidential-settle.js).
// In-memory storage + injected clock; exercises submit/dedup, FIFO claim, claim-lock against
// double-prove, stale-claim reclaim, ack (settled + failed), and status. No network/KV/box.
//
// Run: node tests/confidential-settle.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeConfidentialSettler } from '../worker/src/confidential-settle.js';
import assert from 'node:assert';

const hash = (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
let t = 1000; const now = () => t; // controllable clock
const instantSleep = () => Promise.resolve(); // skip the real claim-verify wait — no real concurrency in these tests
function freshStore() {
  const jobs = new Map(); let pending = [];
  return {
    getPending: async () => pending.slice(),
    putPending: async (ids) => { pending = ids.slice(); },
    getJob: async (id) => (jobs.has(id) ? JSON.parse(JSON.stringify(jobs.get(id))) : null),
    putJob: async (id, job) => { jobs.set(id, JSON.parse(JSON.stringify(job))); },
  };
}
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const swapOp = { reserveAPre: 1000, reserveBPre: 1000, intents: [{ amountIn: 100 }] };
const lpOp = { reserveAPre: 1000, reserveBPre: 2000, dShares: 100 };
const routeOp = { asset0: 'aa', assetFinal: 'bb', hops: [{ reserveAPre: '1000', reserveBPre: '1000' }] };

// ───────────────── 1. submit enqueues a pending job, dedups on resubmit ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const a = await q.submitJob({ type: 'swap', op: swapOp, memos: ['0x01'] });
  assert.strictEqual(a.status, 'pending');
  assert.strictEqual(await q.pendingCount(), 1);
  const b = await q.submitJob({ type: 'swap', op: swapOp, memos: ['0x01'] }); // identical → same id
  assert.strictEqual(b.jobId, a.jobId, 'same witness → same jobId');
  assert.ok(b.deduped, 'resubmit is deduped');
  assert.strictEqual(await q.pendingCount(), 1, 'no duplicate enqueue');
  ok('submit enqueues; an identical resubmit dedups to the same job');
}

// ───────────────── 2. unknown type is rejected ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  await assert.rejects(() => q.submitJob({ type: 'bridge', op: {} }), /unknown type/);
  await assert.rejects(() => q.submitJob({ type: 'swap' }), /type \+ op required/);
  const r = await q.submitJob({ type: 'route', op: routeOp });
  assert.strictEqual(r.status, 'pending', 'route op type is accepted');
  ok('submit rejects unknown op types + missing op, and accepts route ops');
}

// ───────────────── 3. FIFO claim + claim-lock prevents double-prove ─────────────────
{
  const store = freshStore();
  const q = makeConfidentialSettler({ storage: store, hash, now, sleep: instantSleep });
  const j1 = await q.submitJob({ type: 'swap', op: swapOp });
  const j2 = await q.submitJob({ type: 'lp', op: lpOp });
  const first = await q.nextJob();
  assert.strictEqual(first.jobId, j1.jobId, 'FIFO: first submitted claimed first');
  assert.strictEqual(first.type, 'swap');
  const second = await q.nextJob();
  assert.strictEqual(second.jobId, j2.jobId, 'a second poll skips the claimed job, returns the next');
  const third = await q.nextJob();
  assert.strictEqual(third, null, 'both claimed → nothing left to claim (no double-prove)');
  ok('claims are FIFO and locked — a claimed job is not handed out again');
}

// ───────────────── 3b. a claim can ask for one mode: prove-only jobs go through while settle jobs wait ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const settle = await q.submitJob({ type: 'swap', op: swapOp });
  const prove = await q.submitJob({ type: 'lp', op: lpOp, mode: 'prove' });
  const p1 = await q.nextJob({ mode: 'prove' });
  assert.strictEqual(p1.jobId, prove.jobId, 'the prove-only job is handed out ahead of an older settle job');
  assert.strictEqual(p1.mode, 'prove');
  assert.strictEqual(await q.nextJob({ mode: 'prove' }), null, 'no other prove-only job: the settle job is not taken');
  assert.strictEqual((await q.jobStatus(settle.jobId)).status, 'pending', 'the settle job stays queued');
  const s1 = await q.nextJob();
  assert.strictEqual(s1.jobId, settle.jobId, 'an unfiltered claim still takes it');
  ok('a claim filtered to prove mode takes only prove-only jobs; settle jobs stay queued');
}

// ───────────────── 3c. a proven job hands back the memos its proof commits to ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const memos = ['0xaa01', '0xbb02'];
  const j = await q.submitJob({ type: 'lp', op: lpOp, memos, mode: 'prove' });
  assert.strictEqual((await q.jobStatus(j.jobId)).memos, null, 'no memos before it is proven');
  const again = await q.submitJob({ type: 'lp', op: lpOp, memos: ['0xcc03'], mode: 'prove' });
  assert.strictEqual(again.jobId, j.jobId, 'the same op asked again joins the same job');
  await q.nextJob({ mode: 'prove' });
  await q.ackJob(j.jobId, { publicValues: '0x01', proof: '0x02' });
  const st = await q.jobStatus(j.jobId);
  assert.strictEqual(st.status, 'proven');
  assert.deepStrictEqual(st.memos, memos, 'the proven job returns the memos it was proved with, not the second press\'s');
  ok('a proven job returns the memos its proof commits to');

  // A prove job whose deposit was settled from elsewhere first is acked as settled by that transaction: done, not
  // failed. (A bare txHash on a prove job still fails closed: tests/confidential-relay.mjs.)
  const w = await q.submitJob({ type: 'wrap', op: { asset: '0x01', value: '5', cx: '0x02', cy: '0x03', owner: '0x04' }, memos: ['0xdd04'], mode: 'prove' });
  await q.nextJob({ mode: 'prove' });
  await q.ackJob(w.jobId, { txHash: '0xfeed', settledBy: '0xfeed' });
  const ws = await q.jobStatus(w.jobId);
  assert.strictEqual(ws.status, 'settled');
  assert.strictEqual(ws.txHash, '0xfeed');
  assert.strictEqual(ws.memos, null);
  ok('a prove job whose deposit was already settled reads as settled, with that transaction');
}

// ───────────────── 4. stale claim is reclaimable (box crash) ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const j = await q.submitJob({ type: 'swap', op: swapOp });
  const claimed = await q.nextJob();
  assert.strictEqual(claimed.jobId, j.jobId);
  assert.strictEqual(await q.nextJob(), null, 'freshly claimed → not reclaimable yet');
  t += 15 * 60 * 1000; // a proof still inside the relay's own 15-minute limit is not handed to a second prover
  assert.strictEqual(await q.nextJob(), null, 'a claim inside the relay job timeout is not reclaimable');
  t += 2 * 60 * 1000; // past CLAIM_TTL_MS (16 min)
  const reclaimed = await q.nextJob();
  assert.strictEqual(reclaimed.jobId, j.jobId, 'after the TTL a crashed claim is reclaimable');
  t -= 17 * 60 * 1000;
  ok('a stale (crashed-box) claim is reclaimable after the TTL, and not while the relay may still be proving it');
}

// ───────────────── 5. ack settles, drains the queue, is idempotent ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const j = await q.submitJob({ type: 'lp', op: lpOp });
  await q.nextJob();
  const r = await q.ackJob(j.jobId, { txHash: '0xdeadbeef' });
  assert.strictEqual(r.status, 'settled');
  assert.strictEqual(await q.pendingCount(), 0, 'settled job leaves the pending queue');
  const st = await q.jobStatus(j.jobId);
  assert.strictEqual(st.status, 'settled');
  assert.strictEqual(st.txHash, '0xdeadbeef');
  const again = await q.ackJob(j.jobId, { txHash: '0xother' }); // idempotent
  assert.strictEqual(again.txHash, '0xdeadbeef', 'second ack is a no-op, keeps the first tx');
  ok('ack settles + drains the queue + records the tx; re-ack is idempotent');
}

// ───────────────── 6. a failed prove leaves the queue but can be resubmitted ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const j = await q.submitJob({ type: 'swap', op: swapOp });
  await q.nextJob();
  await q.ackJob(j.jobId, { error: 'groth16 proof failed' });
  assert.strictEqual((await q.jobStatus(j.jobId)).status, 'failed');
  assert.strictEqual(await q.pendingCount(), 0, 'failed job drains the pending queue');
  const re = await q.submitJob({ type: 'swap', op: swapOp }); // failed → resubmittable
  assert.strictEqual(re.status, 'pending', 'a failed job can be resubmitted');
  assert.ok(!re.deduped);
  ok('a failed prove leaves the queue + is resubmittable (not dedup-locked)');
}

// ───────────────── 7. feeGate: awaited (an async gate, reading live gas price, must be supported), only
// gates mode:'settle', and a rejection doesn't enqueue or lock out a later, better-fee resubmit ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, feeGate: async ({ op }) => op.fee >= 100 });
  await assert.rejects(
    () => q.submitJob({ type: 'transfer', op: { fee: 10 } }),
    /below the current floor/,
    'a settle job below the gate is rejected before it is ever enqueued',
  );
  assert.strictEqual(await q.pendingCount(), 0, 'the rejected submit never touched the queue');
  const passed = await q.submitJob({ type: 'transfer', op: { fee: 100 } });
  assert.strictEqual(passed.status, 'pending', 'a fee clearing the gate enqueues normally');
  ok('feeGate: an async gate is awaited; a rejection never enqueues, a clearing fee is unaffected');
}

// ───────────────── 8. feeGate: a SYNCHRONOUS gate (returns a plain boolean, not a Promise) still works —
// `await` on a non-Promise resolves immediately, so this must not require every gate to be async ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, feeGate: ({ op }) => op.fee >= 100 });
  await assert.rejects(() => q.submitJob({ type: 'transfer', op: { fee: 0 } }), /below the current floor/);
  const passed = await q.submitJob({ type: 'transfer', op: { fee: 500 } });
  assert.strictEqual(passed.status, 'pending');
  ok('feeGate: a plain synchronous gate function still works under await');
}

// ───────────────── 9. feeGate only applies to mode:'settle' — a prove-only job is user-sent (the user pays
// gas), so it is never gated even at fee=0 ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, feeGate: () => false }); // gate rejects EVERYTHING
  const proved = await q.submitJob({ type: 'transfer', op: { fee: 0 }, mode: 'prove' });
  assert.strictEqual(proved.status, 'pending', 'prove-only bypasses the fee gate entirely');
  ok('feeGate: mode:\'prove\' is never gated, even against a gate that rejects everything');
}

// ───────────────── 10. concurrent claim race: a second poller's write landing during the verify wait
// is detected and backed off from, rather than both pollers proving the same job ─────────────────
{
  const store = freshStore();
  const jobA = await makeConfidentialSettler({ storage: store, hash, now, sleep: instantSleep })
    .submitJob({ type: 'swap', op: swapOp });
  // A `sleep` that simulates a second poller's claim landing on THIS job during the wait window —
  // exercises the exact mechanism nextJob() relies on (re-read after the wait, compare the nonce),
  // deterministically, rather than racing real Promise scheduling.
  const rival = makeConfidentialSettler({ storage: store, hash, now, sleep: async () => {
    const rec = await store.getJob(jobA.jobId);
    rec.claimNonce = 'rival-poller-nonce';
    rec.claimedAt = now();
    await store.putJob(jobA.jobId, rec);
  } });
  const lost = await rival.nextJob();
  assert.strictEqual(lost, null, 'a claim overwritten by a rival poller during the verify wait is not returned');
  const rec = await store.getJob(jobA.jobId);
  assert.strictEqual(rec.claimNonce, 'rival-poller-nonce', 'the rival\'s claim is the one left standing');
  ok('nextJob: a claim raced out from under it during the verify wait backs off instead of also proving it');
}

// ───────────────── 11. nextBatch applies the same race-narrowing, in one shared wait for the batch ─────────────────
{
  const store = freshStore();
  const jobA = await makeConfidentialSettler({ storage: store, hash, now, sleep: instantSleep })
    .submitJob({ type: 'transfer', op: { spendRoot: '0xroot', chainBinding: '0xcb', fee: 0 } });
  let waits = 0;
  const rival = makeConfidentialSettler({ storage: store, hash, now, sleep: async () => {
    waits++;
    const rec = await store.getJob(jobA.jobId);
    rec.claimNonce = 'rival-batch-nonce';
    await store.putJob(jobA.jobId, rec);
  } });
  const picked = await rival.nextBatch({ types: ['transfer'] });
  assert.strictEqual(picked.length, 0, 'the only candidate lost its race and is excluded from the batch');
  assert.strictEqual(waits, 1, 'one shared wait for the whole batch, not one per claimed job');
  ok('nextBatch: race-narrowing applies per-batch with a single shared wait, not per-job');
}

// ───────────────── 12. nextBatch({ mixed }) claims any board-eligible type whose roots agree; the plain batch stays transfer-only ─────────────────
{
  const store = freshStore();
  const q = makeConfidentialSettler({ storage: store, hash, now, sleep: instantSleep });
  const cb = '0xcb', root = '0xr1';
  const wrap = await q.submitJob({ type: 'wrap', op: { chainBinding: cb, value: '1' } });                       // no roots of its own
  const xfer = await q.submitJob({ type: 'transfer', op: { chainBinding: cb, spendRoot: root, fee: 0 } });
  const cdp = await q.submitJob({ type: 'cdpclose', op: { chainBinding: cb, spendRoot: root, cdpPositionRoot: '0xp1' } });
  const other = await q.submitJob({ type: 'transfer', op: { chainBinding: cb, spendRoot: '0xr2', fee: 1 } });    // another spend root
  const cdp2 = await q.submitJob({ type: 'cdptopup', op: { chainBinding: cb, spendRoot: root, cdpPositionRoot: '0xp2' } }); // another position root
  const exit = await q.submitJob({ type: 'unwrap', op: { chainBinding: cb, spendRoot: root } });
  { const rec = await store.getJob(exit.jobId); rec.exit = { exitedAsset: '0x' + '11'.repeat(32) }; await store.putJob(exit.jobId, rec); } // a relayed exit, activated after its own settle
  const embedded = await q.submitJob({ type: 'wraptransfer', op: { chainBinding: cb, spendRoot: root } });        // not a plain pool.settle
  const proveOnly = await q.submitJob({ type: 'unwrap', op: { chainBinding: cb, spendRoot: root, value: '2' }, mode: 'prove' });
  const picked = await q.nextBatch({ max: 8, mixed: true });
  assert.deepEqual(picked.map((j) => j.jobId), [wrap.jobId, xfer.jobId, cdp.jobId], 'the wrap, the transfer and the close share roots; the rest wait');
  assert.deepEqual(picked.map((j) => j.type), ['wrap', 'transfer', 'cdpclose']);
  for (const left of [other, cdp2, exit, embedded, proveOnly]) assert.strictEqual((await store.getJob(left.jobId)).status, 'pending', `${left.jobId} is left in the queue`);
  // The next mixed round takes what agrees with the first job it reaches.
  const next = await q.nextBatch({ max: 8, mixed: true });
  assert.deepEqual(next.map((j) => j.jobId), [other.jobId], 'the other spend root leads its own batch; nothing else agrees with it');
  ok('nextBatch mixed: board-eligible types with agreeing roots travel together; exits, embedded proofs and prove-only jobs do not');
}
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  await q.submitJob({ type: 'wrap', op: { chainBinding: '0xcb', value: '1' } });
  const t1 = await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0 } });
  const t2 = await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 1 } });
  await q.submitJob({ type: 'cdpclose', op: { chainBinding: '0xcb', spendRoot: '0xr', cdpPositionRoot: '0xp' } });
  const picked = await q.nextBatch({ max: 8 });
  assert.deepEqual(picked.map((j) => j.jobId), [t1.jobId, t2.jobId], 'without mixed: transfers only, as the transfer batch binary expects');
  ok('nextBatch: the plain batch is still transfers that share a spend root');
}

// ───────────────── 14. a settle's ack carries where its proof was made; the status reports it; junk is dropped ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const a = await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0, n: 'a' } });
  await q.nextJob();
  await q.ackJob(a.jobId, { txHash: '0xtx1', lane: 'board' });
  assert.strictEqual((await q.jobStatus(a.jobId)).lane, 'board');
  const b = await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0, n: 'b' } });
  await q.nextJob();
  await q.ackJob(b.jobId, { txHash: '0xtx2', lane: 'somewhere-else' });
  const sb = await q.jobStatus(b.jobId);
  assert.strictEqual(sb.status, 'settled'); assert.strictEqual(sb.lane, null, 'an unknown lane is not kept');
  ok('ack: the proof\'s lane (board / network-private / network-public) rides on the settled job\'s status');
}

// ───────────────── 15. a settled job keeps no witness: the op is dropped from its record ─────────────────
{
  const store = freshStore();
  const q = makeConfidentialSettler({ storage: store, hash, now, sleep: instantSleep });
  const a = await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0, secret: 'witness' } });
  await q.nextJob();
  assert.ok((await store.getJob(a.jobId)).op, 'a claimed job carries its op');
  await q.ackJob(a.jobId, { txHash: '0xtx' });
  const rec = await store.getJob(a.jobId);
  assert.strictEqual(rec.status, 'settled'); assert.strictEqual(rec.op, undefined, 'the witness is gone once settled');
  assert.strictEqual((await q.jobStatus(a.jobId)).txHash, '0xtx');
  const b = await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0, secret: 'witness' } });
  assert.strictEqual(b.jobId, a.jobId, 'and the same op still dedupes to the same job by id');
  ok('a settled job drops its op (the witness); its id, memos and transaction stay');
}

// ───────────────── 16. a sealed job: no op, the ciphertext for one worker, the fee read later from its proof ─────────────────
{
  const store = freshStore();
  const q = makeConfidentialSettler({ storage: store, hash, now, sleep: instantSleep });
  const sealed = { worker: 'tacit-a5000', epk: '0x02' + 'ab'.repeat(32), iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJD'.repeat(10) };
  const a = await q.submitJob({ type: 'transfer', mode: 'sealed', sealed, memos: ['0x01'] });
  assert.strictEqual(a.status, 'pending');
  const again = await q.submitJob({ type: 'transfer', mode: 'sealed', sealed: { ...sealed, epk: '0x03' + 'cd'.repeat(32) }, memos: ['0x01'] });
  assert.strictEqual(again.jobId, a.jobId, 'the same ciphertext is one job'); assert.ok(again.deduped);
  await assert.rejects(() => q.submitJob({ type: 'transfer', mode: 'sealed', sealed: { ...sealed, ct: 'short' } }), /sealed \{ worker, epk, iv, ct \}/);
  await assert.rejects(() => q.submitJob({ type: 'bridgemint', mode: 'sealed', sealed, memos: [] }), /cannot be sent sealed/);
  await assert.rejects(() => q.submitJob({ type: 'transfer', mode: 'sealed', sealed, memos: [], exit: { to: '0x1' } }), /exit recipe/);
  const st = await q.jobStatus(a.jobId);
  assert.strictEqual(st.sealed, true); assert.strictEqual(st.mode, 'settle');
  const job = await q.nextJob();
  assert.strictEqual(job.jobId, a.jobId); assert.strictEqual(job.op, null); assert.deepStrictEqual(job.sealed, sealed);
  assert.strictEqual(job.feeUsd, null, 'no fee is known before the proof');
  await q.ackJob(a.jobId, { txHash: '0xtx', lane: 'board' });
  const rec = await store.getJob(a.jobId);
  assert.strictEqual(rec.status, 'settled'); assert.deepStrictEqual(rec.sealed, { worker: 'tacit-a5000' }, 'the ciphertext is dropped once settled');
  const done = await q.jobStatus(a.jobId);
  assert.strictEqual(done.sealed, true); assert.strictEqual(done.lane, 'board'); assert.strictEqual(done.txHash, '0xtx');
  const b = await q.submitJob({ type: 'transfer', mode: 'sealed', sealed: { ...sealed, ct: 'REVG'.repeat(10) }, memos: [] });
  await q.nextJob();
  await q.ackJob(b.jobId, { error: 'the sealed prover is not available right now' });
  assert.strictEqual((await q.jobStatus(b.jobId)).status, 'pending', 'a sealed prover away is the relay’s failure: one more try later');
  await q.ackJob(b.jobId, { error: 'the sealed prover is not available right now' });
  assert.strictEqual((await q.jobStatus(b.jobId)).status, 'failed');
  const c = await q.submitJob({ type: 'transfer', mode: 'sealed', sealed: { ...sealed, ct: 'REVG'.repeat(10) }, memos: [] });
  assert.strictEqual(c.jobId, b.jobId); assert.strictEqual(c.status, 'pending', 'a failed sealed job can be sent again');
  ok('sealed: queued without an op, deduped by ciphertext, handed to the relay as sealed, ciphertext dropped once settled, resendable once failed');
}

// ───────────────── 17. a failed job goes back in line as it was ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const a = await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0, n: 'rq' }, memos: ['0x01'] });
  assert.deepStrictEqual(await q.requeueJob(a.jobId), { ok: false, error: 'the job is pending, not failed' });
  await q.nextJob();
  await q.ackJob(a.jobId, { error: 'prove failed: the binary could not run' });
  assert.strictEqual((await q.jobStatus(a.jobId)).status, 'failed');
  const r = await q.requeueJob(a.jobId);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.status, 'pending'); assert.strictEqual(r.type, 'transfer');
  const st = await q.jobStatus(a.jobId);
  assert.strictEqual(st.status, 'pending'); assert.strictEqual(st.error, null);
  const job = await q.nextJob();
  assert.strictEqual(job.jobId, a.jobId); assert.strictEqual(job.op.n, 'rq', 'the op it kept is handed out again');
  await q.ackJob(a.jobId, { txHash: '0xtx', lane: 'board' });
  assert.deepStrictEqual(await q.requeueJob(a.jobId), { ok: false, error: 'the job is settled, not failed' });
  assert.deepStrictEqual(await q.requeueJob('0x' + 'ee'.repeat(32)), { ok: false, error: 'unknown job' });
  ok('requeue: a failed job goes back to pending with its op, is handed out again, and nothing else can be requeued');
}

// ───────────────── 18. a relay-side failure gets one more try a few minutes later; an op's own failure is final ─────────────────
{
  let t = 1_000_000; const clockNow = () => t;
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now: clockNow, sleep: instantSleep });
  const a = await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0, n: 'retry' }, memos: ['0x01'] });
  await q.nextJob();
  await q.ackJob(a.jobId, { error: 'prove failed: exec:transfer produced no proof (code=101): ENOENT' });
  let st = await q.jobStatus(a.jobId);
  assert.strictEqual(st.status, 'pending', 'the relay’s own failure puts the job back in line'); assert.strictEqual(st.error, null);
  assert.strictEqual(await q.nextJob(), null, 'not handed out again at once');
  t += 3 * 60_000 + 1;
  const again = await q.nextJob();
  assert.strictEqual(again?.jobId, a.jobId, 'handed out again after the wait');
  await q.ackJob(a.jobId, { error: 'prove failed: exec:transfer produced no proof (code=101): ENOENT' });
  assert.strictEqual((await q.jobStatus(a.jobId)).status, 'failed', 'the second failure is final');
  const b = await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0, n: 'own' }, memos: ['0x01'] });
  await q.nextJob();
  await q.ackJob(b.jobId, { error: 'prove failed: unexecutable: the op does not execute' });
  assert.strictEqual((await q.jobStatus(b.jobId)).status, 'failed', 'a failure in the op itself is final at once');
  ok('one automatic retry for a relay-side failure, after a wait; an op’s own failure and a second failure are final');
}

// ───────────────── 19. the queue says how many pending jobs are relayed settles, the only ones that can share a settle ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0, n: 'qs1' }, memos: [] });
  await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0, n: 'qs2' }, memos: [], mode: 'prove' });
  await q.submitJob({ type: 'transfer', op: { chainBinding: '0xcb', spendRoot: '0xr', fee: 0, n: 'qs3' }, memos: [], mode: 'prove' });
  const st = await q.queueStats();
  assert.strictEqual(st.pending, 3); assert.strictEqual(st.pendingSettle, 1, 'two of the three are prove-only and cannot join a batch');
  assert.ok(Number.isFinite(st.oldestPendingSettleSec));
  ok('queueStats: pendingSettle counts only relayed settles');
}

// ───────────────── 20. the queue is served by sender: one who queues many jobs delays only their own ─────────────────
{
  const store = freshStore();
  const q = makeConfidentialSettler({ storage: store, hash, now, sleep: instantSleep, senders: new Map() });
  const op = (n) => ({ chainBinding: '0xcb', spendRoot: '0xr', fee: 0, n });
  const legacy = await q.submitJob({ type: 'transfer', op: op('old'), mode: 'prove' });          // queued with no sender (as before senders were kept)
  const busy = [];
  for (let i = 0; i < 6; i++) busy.push((await q.submitJob({ type: 'transfer', op: op(`f${i}`), mode: 'prove', client: '203.0.113.0/24' })).jobId);
  const alice = await q.submitJob({ type: 'transfer', op: op('alice'), mode: 'prove', client: '10.1.2.0/24' });
  const bob = await q.submitJob({ type: 'transfer', op: op('bob'), mode: 'prove', client: '2001:db8:1:2::/64' });
  const bob2 = await q.submitJob({ type: 'transfer', op: op('bob2'), mode: 'prove', client: '2001:db8:1:2::/64' });
  assert.strictEqual((await q.jobStatus(alice.jobId)).ahead, 2, 'behind the older job and the busy sender’s first only, not all six');
  assert.strictEqual((await q.jobStatus(bob.jobId)).ahead, 3);
  assert.strictEqual((await q.jobStatus(bob2.jobId)).ahead, 5, 'a sender’s second job waits for everyone’s first and the busy sender’s second');
  assert.strictEqual((await q.jobStatus(busy[5])).ahead, 9, 'the busy sender’s last job is last');
  const got = [];
  for (let k = 0; k < 10; k++) got.push((await q.nextJob()).jobId);
  assert.deepStrictEqual(got, [legacy.jobId, busy[0], alice.jobId, bob.jobId, busy[1], bob2.jobId, ...busy.slice(2)],
    'taken in rounds: each sender’s first in arrival order, then each one’s second, …');
  ok('jobs are taken by sender in turn, and `ahead` counts in that same order');

  // a job taken stays its sender's turn: while it proves, the sender's next waits behind the others' first
  const q2 = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const g1 = await q2.submitJob({ type: 'transfer', op: op('g1'), mode: 'prove', client: 'a/24' });
  const g2 = await q2.submitJob({ type: 'transfer', op: op('g2'), mode: 'prove', client: 'a/24' });
  assert.strictEqual((await q2.nextJob()).jobId, g1.jobId);
  const h1 = await q2.submitJob({ type: 'transfer', op: op('h1'), mode: 'prove', client: 'c/24' });
  assert.strictEqual((await q2.nextJob()).jobId, h1.jobId, 'a newcomer goes before the second job of a sender whose first is proving');
  assert.strictEqual((await q2.nextJob()).jobId, g2.jobId);
  ok('a sender whose job is proving waits for the others before their next');

  // a settler built afresh over the same store with a shared map (the worker builds one per request) reads each sender once
  const store3 = freshStore(), shared = new Map();
  const q3 = makeConfidentialSettler({ storage: store3, hash, now, sleep: instantSleep, senders: new Map() });
  for (let i = 0; i < 5; i++) await q3.submitJob({ type: 'transfer', op: op(`k${i}`), mode: 'prove', client: `s${i % 2}/24` });
  let reads = 0;
  const counted = { ...store3, getJob: async (id) => { reads++; return store3.getJob(id); } };
  const fresh = () => makeConfidentialSettler({ storage: counted, hash, now, sleep: instantSleep, senders: shared });
  await fresh().nextJob();
  const firstLook = reads;
  reads = 0;
  await fresh().nextJob();
  assert.ok(firstLook >= 5 && reads < firstLook, `a later settler over the same map reads no sender again (${firstLook} reads, then ${reads})`);
  ok('a sender is read from the store once, across the settlers sharing a map');
}

// ───────────────── 21. one sender's share of the queue is capped; others still get in ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const op = (n) => ({ chainBinding: '0xcb', spendRoot: '0xr', fee: 0, n });
  for (let i = 0; i < 32; i++) await q.submitJob({ type: 'transfer', op: op(`c${i}`), mode: 'prove', client: '203.0.113.0/24' });
  await assert.rejects(q.submitJob({ type: 'transfer', op: op('c32'), mode: 'prove', client: '203.0.113.0/24' }), /32 of your jobs are already waiting/);
  const again = await q.submitJob({ type: 'transfer', op: op('c3'), mode: 'prove', client: '203.0.113.0/24' });
  assert.ok(again.deduped, 'the same job sent again is still answered (it takes no new place)');
  assert.strictEqual((await q.submitJob({ type: 'transfer', op: op('d0'), mode: 'prove', client: '10.0.0.0/24' })).status, 'pending', 'another sender still gets in');
  assert.strictEqual((await q.submitJob({ type: 'transfer', op: op('e0'), mode: 'prove' })).status, 'pending', 'a job with no sender is held to no one’s share');
  const sealed = { worker: 'w1', epk: '0x02' + '11'.repeat(32), iv: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(32) };
  await assert.rejects(q.submitJob({ type: 'transfer', memos: [], mode: 'sealed', sealed, client: '203.0.113.0/24' }), /32 of your jobs/);
  assert.strictEqual((await q.submitJob({ type: 'transfer', memos: [], mode: 'sealed', sealed, client: '10.9.9.0/24' })).status, 'pending');
  ok('a sender with 32 jobs waiting is refused a 33rd (a sealed one too); a resend, another sender and a job with no sender still get in');
}

console.log(`\n${n} confidential-settle checks passed.`);
