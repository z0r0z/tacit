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
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now });
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
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now });
  await assert.rejects(() => q.submitJob({ type: 'bridge', op: {} }), /unknown type/);
  await assert.rejects(() => q.submitJob({ type: 'swap' }), /type \+ op required/);
  const r = await q.submitJob({ type: 'route', op: routeOp });
  assert.strictEqual(r.status, 'pending', 'route op type is accepted');
  ok('submit rejects unknown op types + missing op, and accepts route ops');
}

// ───────────────── 3. FIFO claim + claim-lock prevents double-prove ─────────────────
{
  const store = freshStore();
  const q = makeConfidentialSettler({ storage: store, hash, now });
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
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now });
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
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now });
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
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now });
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

console.log(`\n${n} confidential-settle checks passed.`);
