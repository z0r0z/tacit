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
      try { return reply(200, { ok: true, ...(await q.submitJob({ type: b.type, op: b.op, memos: b.memos })) }); }
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

console.log(`\n${n} confidential-relay checks passed.`);
