#!/usr/bin/env node
// Confidential relay client ↔ queue round-trip (dapp/confidential-relay.js over worker/src/
// confidential-settle.js). A mock fetch routes the client's HTTP calls into the real in-memory
// queue; the "box" is simulated by claiming + acking between polls. Validates submitOp → status →
// waitForSettle (settled + failed + timeout) with no network/worker/box.
//
// Run: node tests/confidential-relay.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeConfidentialSettler } from '../worker/src/confidential-settle.js';
import { makeConfidentialRelay } from '../dapp/confidential-relay.js';
import assert from 'node:assert';

const hash = (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
function freshStore() {
  const jobs = new Map(); let pending = [];
  return {
    getPending: async () => pending.slice(),
    putPending: async (ids) => { pending = ids.slice(); },
    getJob: async (id) => (jobs.has(id) ? JSON.parse(JSON.stringify(jobs.get(id))) : null),
    putJob: async (id, job) => { jobs.set(id, JSON.parse(JSON.stringify(job))); },
  };
}
// a mock fetch that serves /confidential/submit + /confidential/status from a queue instance
function mockFetch(q) {
  return async (urlStr, opts = {}) => {
    const url = new URL(urlStr, 'http://relay.test');
    const reply = (status, obj) => ({ ok: status >= 200 && status < 300, status, statusText: String(status), text: async () => JSON.stringify(obj) });
    if (url.pathname === '/confidential/submit' && opts.method === 'POST') {
      const b = JSON.parse(opts.body);
      try { return reply(200, { ok: true, ...(await q.submitJob({ type: b.type, op: b.op, memos: b.memos, mode: b.mode })) }); }
      catch (e) { return reply(400, { error: String(e.message) }); }
    }
    if (url.pathname === '/confidential/status') {
      const st = await q.jobStatus(url.searchParams.get('id'));
      return st ? reply(200, st) : reply(404, { error: 'unknown job' });
    }
    return reply(404, { error: 'no route' });
  };
}
const noSleep = () => Promise.resolve();
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };
const swapOp = { reserveAPre: 1000, reserveBPre: 1000, intents: [{ amountIn: 100 }] };

// ───────────────── 1. submit → box settles → waitForSettle resolves ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  const relay = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q) });
  const { jobId, status } = await relay.submitOp({ type: 'swap', op: swapOp, memos: ['0xaa'] });
  assert.strictEqual(status, 'pending');

  // simulate the box: claim + settle on-chain + ack
  const claimed = await q.nextJob();
  assert.strictEqual(claimed.jobId, jobId);
  assert.deepStrictEqual(claimed.memos, ['0xaa'], 'box receives the memos to pass to settle()');
  await q.ackJob(jobId, { txHash: '0xcafe' });

  const seen = [];
  const final = await relay.waitForSettle(jobId, { intervalMs: 0, sleep: noSleep, onUpdate: (s) => seen.push(s.status) });
  assert.strictEqual(final.status, 'settled');
  assert.strictEqual(final.txHash, '0xcafe');
  assert.ok(seen.includes('settled'), 'onUpdate fired for the settled state');
  ok('submitOp → (box claims + acks) → waitForSettle resolves with the settle tx');
}

// ───────────────── 2. a failed prove surfaces as a thrown error ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  const relay = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q) });
  const { jobId } = await relay.submitOp({ type: 'lp', op: { reserveAPre: 1, reserveBPre: 2 } });
  await q.nextJob();
  await q.ackJob(jobId, { error: 'groth16 proof failed' });
  await assert.rejects(() => relay.waitForSettle(jobId, { intervalMs: 0, sleep: noSleep }), /settle failed: groth16 proof failed/);
  ok('a box-reported prove failure throws out of waitForSettle');
}

// ───────────────── 3. settle() convenience returns immediately on a deduped-settled job ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  const relay = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q) });
  // first submit + settle out of band
  const { jobId } = await relay.submitOp({ type: 'swap', op: swapOp });
  await q.nextJob(); await q.ackJob(jobId, { txHash: '0xbeef' });
  // re-submitting the same op dedups to the settled job → settle() short-circuits
  const r = await relay.settle({ type: 'swap', op: swapOp }, { intervalMs: 0, sleep: noSleep });
  assert.strictEqual(r.status, 'settled');
  ok('settle() short-circuits when an identical op already settled (submit dedup)');
}

// ───────────────── 4. timeout when the box never picks the job up ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  const relay = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q) });
  const { jobId } = await relay.submitOp({ type: 'transfer', op: { inputs: [], outputs: [] } });
  await assert.rejects(
    () => relay.waitForSettle(jobId, { intervalMs: 1, timeoutMs: -1, sleep: noSleep }),
    /timed out/,
    'never-claimed job times out',
  );
  ok('waitForSettle times out if the box never settles');
}

// ───────────────── 5. recovery-guard chokepoint: seal + assert before queuing ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  // a mock guard standing in for makeRecoveryGuard (the real seal/assert is covered by
  // confidential-recovery-guard.mjs): seals one memo per output, asserts every leaf is recoverable.
  const guard = {
    sealMemosForOutputs: ({ outputs, ephRand }) => {
      void ephRand();
      return outputs.map((o) => (o && o.seedDerived ? '0x' : '0x' + 'cc'.repeat(68)));
    },
    assertOutputsRecoverable: ({ leaves, outputs, memos }) => {
      if (leaves.length !== outputs.length || memos.length !== outputs.length) throw new Error('aligned');
      outputs.forEach((o, i) => { if (!(o && o.seedDerived) && memos[i] === '0x') throw new Error('recovery channel'); });
    },
  };
  const relay = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q), guard });
  const eph = () => 7n;

  // (a) an op with outputs gets its memos sealed + asserted, and the box receives the sealed memos
  const { jobId } = await relay.submitOp({
    type: 'transfer', op: { inputs: [], outputs: [] },
    leaves: ['0x' + '11'.repeat(32)], outputs: [{ ownerPub: '0x02' + 'ab'.repeat(32) }], ephRand: eph,
  });
  const claimed = await q.nextJob();
  assert.strictEqual(claimed.jobId, jobId);
  assert.deepStrictEqual(claimed.memos, ['0x' + 'cc'.repeat(68)], 'box receives the guard-sealed memos');
  ok('submitOp seals + asserts an op output before queuing');

  // (b) raw memos without outputs descriptors cannot bypass the guard
  await assert.rejects(
    () => relay.submitOp({ type: 'transfer', op: {}, memos: ['0xdead'] }),
    /bypass the recovery guard/,
    'a leaf-bearing op without outputs descriptors is rejected',
  );

  // (c) outputs without an ephRand scalar source is rejected before sealing
  await assert.rejects(
    () => relay.submitOp({ type: 'transfer', op: {}, leaves: ['0x' + '11'.repeat(32)], outputs: [{ ownerPub: '0x02' }] }),
    /ephRand/,
    'sealing needs an ephRand source',
  );

  // (d) a seed-derived output carries an empty-memo placeholder and asserts clean (the BID-style channel)
  const r2 = await relay.submitOp({
    type: 'bid', op: {}, leaves: ['0x' + '22'.repeat(32)], outputs: [{ seedDerived: true }], ephRand: eph,
  });
  assert.ok(r2.jobId, 'seed-derived output submits with an empty-memo placeholder');
  ok('seed-derived outputs pass with an empty memo; bypass + missing-ephRand are rejected');
}

// ───────────────── 6. prove-only mode: box returns artifacts, waitForProof resolves (router flow) ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  const relay = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q) });
  const payOp = { depositsConsumed: ['0xdep'], leaves: ['0xleaf'] };

  // prove-only submit: distinct jobId from a settle-mode submit of the SAME op (they coexist)
  const settleId = q.jobIdOf('wrap', payOp, 'settle');
  const { jobId, status } = await relay.submitOp({ type: 'wrap', op: payOp, mode: 'prove' });
  assert.strictEqual(status, 'pending');
  assert.notStrictEqual(jobId, settleId, 'prove-only job has a distinct id from the settle job');

  // box claims → sees mode 'prove' → proves (no on-chain submit) → acks the artifacts
  const claimed = await q.nextJob();
  assert.strictEqual(claimed.jobId, jobId);
  assert.strictEqual(claimed.mode, 'prove', 'box is told to prove-only');
  await q.ackJob(jobId, { publicValues: '0xpv', proof: '0xpf' });

  const seen = [];
  const final = await relay.waitForProof(jobId, { intervalMs: 0, sleep: noSleep, onUpdate: (s) => seen.push(s.status) });
  assert.strictEqual(final.status, 'proven');
  assert.strictEqual(final.publicValues, '0xpv');
  assert.strictEqual(final.proof, '0xpf');
  assert.ok(seen.includes('proven'), 'onUpdate fired for the proven state');
  ok('prove-only: submit(mode:prove) → box acks {publicValues,proof} → waitForProof resolves with artifacts');

  // a prove-only ack missing the artifacts fails closed
  const q2 = makeConfidentialSettler({ storage: freshStore(), hash });
  const relay2 = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q2) });
  const j2 = (await relay2.submitOp({ type: 'wrap', op: payOp, mode: 'prove' })).jobId;
  await q2.nextJob();
  const ack = await q2.ackJob(j2, { txHash: '0xnope' }); // settle-style ack on a prove job → fail
  assert.strictEqual(ack.status, 'failed');
  await assert.rejects(() => relay2.waitForProof(j2, { intervalMs: 0, sleep: noSleep }), /prove failed/);
  ok('a prove-only ack without publicValues/proof fails closed');
}

console.log(`\n${n} confidential-relay checks passed.`);
