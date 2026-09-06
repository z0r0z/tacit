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

// ───────────────── 4. stale claim is reclaimable (box crash) ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now, sleep: instantSleep });
  const j = await q.submitJob({ type: 'swap', op: swapOp });
  const claimed = await q.nextJob();
  assert.strictEqual(claimed.jobId, j.jobId);
  assert.strictEqual(await q.nextJob(), null, 'freshly claimed → not reclaimable yet');
  t += 11 * 60 * 1000; // advance past CLAIM_TTL_MS (10 min)
  const reclaimed = await q.nextJob();
  assert.strictEqual(reclaimed.jobId, j.jobId, 'after the TTL a crashed claim is reclaimable');
  t -= 11 * 60 * 1000;
  ok('a stale (crashed-box) claim is reclaimable after the TTL');
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

console.log(`\n${n} confidential-settle checks passed.`);
