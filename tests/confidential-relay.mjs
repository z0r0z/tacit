#!/usr/bin/env node
// Confidential relay client ↔ queue round-trip (dapp/confidential-relay.js over worker/src/
// confidential-settle.js). A mock fetch routes the client's HTTP calls into the real in-memory
// queue; the "box" is simulated by claiming + acking between polls. Validates submitOp → status →
// waitForSettle (settled + failed + timeout) with no network/worker/box.
//
// Run: node tests/confidential-relay.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeConfidentialSettler } from '../worker/src/confidential-settle.js';
import { makeConfidentialRelay, relayCanProve } from '../dapp/confidential-relay.js';
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
      try { return reply(200, { ok: true, ...(await q.submitJob({ type: b.type, op: b.op, memos: b.memos, mode: b.mode, sealed: b.sealed, cancel: b.cancel })) }); }
      catch (e) { return reply(400, { error: String(e.message) }); }
    }
    if (url.pathname === '/confidential/cancel' && opts.method === 'POST') {
      const b = JSON.parse(opts.body);
      const r = await q.cancelJob(b);
      return reply(r.ok ? 200 : 409, r);
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

// ───────────────── 2b. a fee the relay's gate turns down after taking the job reads as a fee under the floor ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  const relay = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q) });
  const { jobId } = await relay.submitOp({ type: 'lp', op: { reserveAPre: 1, reserveBPre: 2 } });
  await q.nextJob();
  await q.ackJob(jobId, { error: 'feeGate: bound fee is below the marginal cost of $0.2404 at current gas and PROVE prices' });
  await assert.rejects(() => relay.waitForSettle(jobId, { intervalMs: 0, sleep: noSleep }),
    (e) => /^settle failed: relay fee below the current floor \(bound fee is below the marginal cost of \$0\.2404/.test(e.message) && !/feeGate/.test(e.message));
  ok('a feeGate refusal throws as a fee under the floor, so the pages ask again at a higher fee or offer the account');
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

  // (e) lockMemos: a stealth-lock op mints no note leaf, so it has no `outputs` for the guard to check —
  // its already-sealed memo must still reach the box untouched, even with a guard wired (unlike plain
  // `memos` with no `outputs`, which (b) above confirms the guard rejects).
  await q.nextJob(); // drain r2 (from (d), never claimed) so the next claim below is unambiguously r3
  const r3 = await relay.submitOp({ type: 'stealthlock', op: {}, lockMemos: ['0x' + 'ee'.repeat(68)] });
  const claimedLock = await q.nextJob();
  assert.strictEqual(claimedLock.jobId, r3.jobId);
  assert.deepStrictEqual(claimedLock.memos, ['0x' + 'ee'.repeat(68)], 'the lock memo reaches the box exactly as given, unsealed by the guard');
  ok('lockMemos bypasses the note-output guard for leaf-less stealth-lock ops');
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

// ───────────────── 3. a transient status-poll error does not abandon a running job ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  const base = mockFetch(q);
  let failNext = 3;
  const flaky = async (u, o) => { if (String(u).includes('/confidential/status') && failNext > 0) { failNext--; throw new Error('fetch failed'); } return base(u, o); };
  const relay = makeConfidentialRelay({ base: '', fetchImpl: flaky });
  const { jobId } = await relay.submitOp({ type: 'swap', op: swapOp, memos: ['0xbb'] });
  await q.nextJob(); await q.ackJob(jobId, { txHash: '0xfeed' });
  const final = await relay.waitForSettle(jobId, { intervalMs: 0, sleep: noSleep });
  assert.strictEqual(final.status, 'settled');
  assert.strictEqual(failNext, 0, 'the three transient failures were all retried');
  ok('waitForSettle retries transient status errors and still resolves');

  const dead = async (u, o) => { if (String(u).includes('/confidential/status')) throw new Error('connect timeout'); return base(u, o); };
  const relay2 = makeConfidentialRelay({ base: '', fetchImpl: dead });
  const j2 = (await relay2.submitOp({ type: 'swap', op: swapOp, memos: ['0xcc'] })).jobId;
  await assert.rejects(() => relay2.waitForSettle(j2, { intervalMs: 0, sleep: noSleep }), (e) => e.message.includes(j2) && /8 times in a row/.test(e.message));
  ok('persistent status errors still fail, naming the job so a caller can resume');
}

// ───────── a relay answering "settled" with no tx hash cannot skip the memo check ─────────
// The whole defence against memo substitution is comparing the emitted memos against the sealed ones, and
// that comparison needs the settle tx. settle() used to rebuild a bare {jobId, status:'settled'} on the
// submit-dedup path, dropping any hash, so verifyEmittedMemos returned clean without checking anything —
// a bypass the relay could take unilaterally on every leaf-bearing op. Now the hash is preserved, re-queried
// when absent, and an op that still has none is reported unverified rather than clean.
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  const base = mockFetch(q);
  // A hostile relay: claims "settled" on submit, and never yields a tx hash on status either.
  const hostile = async (u, o) => {
    const url = new URL(String(u), 'http://relay.test');
    if (url.pathname === '/confidential/submit') return { ok: true, status: 200, statusText: '200', text: async () => JSON.stringify({ ok: true, jobId: '0xdead', status: 'settled' }) };
    if (url.pathname === '/confidential/status') return { ok: true, status: 200, statusText: '200', text: async () => JSON.stringify({ jobId: '0xdead', status: 'settled' }) };
    return base(u, o);
  };
  const relay = makeConfidentialRelay({ base: '', fetchImpl: hostile, checkEmittedMemos: async () => { throw new Error('must not be reachable without a tx hash'); } });
  const r = await relay.settle({ type: 'swap', op: swapOp, leaves: ['0x11'], memos: ['0x22'] }, { intervalMs: 0, sleep: noSleep });
  assert.strictEqual(r.status, 'settled');
  assert.ok(r.memoCheck && r.memoCheck.ok === null, 'an unverifiable settle reports memoCheck.ok === null, not a clean result');
  ok('a relay that withholds the settle tx hash is reported unverified, not verified');

  // And the honest path still verifies: a hash is present, so checkEmittedMemos actually runs.
  let checked = false;
  const q2 = makeConfidentialSettler({ storage: freshStore(), hash });
  const relay2 = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q2), checkEmittedMemos: async () => { checked = true; return { ok: true }; } });
  const { jobId } = await relay2.submitOp({ type: 'swap', op: swapOp, leaves: ['0x11'], memos: ['0x22'] });
  await q2.nextJob(); await q2.ackJob(jobId, { txHash: '0xcafe' });
  await relay2.waitForSettle(jobId, { intervalMs: 0, sleep: noSleep })
    .then((st) => relay2.verifyEmittedMemos(st, ['0x11'], ['0x22']));
  assert.ok(checked, 'the memo check still runs when the settle tx hash is present');
  ok('an honest settle still runs the emitted-memo comparison');
}

// The caller that queued a job hears its id first: waitOpts.onJob runs before `tacit:job` announces it, so a page
// can tell its own jobs from any other queued meanwhile. The same holds for a prove-only job.
{
  // Polls here yield to timers (a microtask-only wait would starve the simulated box below).
  const order = [], was = globalThis.dispatchEvent, tick = () => new Promise((r) => setTimeout(r, 1));
  globalThis.dispatchEvent = (e) => { if (e.type === 'tacit:job') order.push(`event ${e.detail.status} ${e.detail.jobId}`); return true; };
  try {
    const q = makeConfidentialSettler({ storage: freshStore(), hash });
    const relay = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q) });
    const settling = relay.settle({ type: 'swap', op: swapOp, memos: [] }, { intervalMs: 0, sleep: tick, onJob: (id, type) => order.push(`onJob ${type} ${id}`) });
    while (!order.length) await tick();
    const { jobId } = await q.nextJob(); await q.ackJob(jobId, { txHash: '0xbeef' });
    await settling;
    assert.deepStrictEqual(order.slice(0, 2), [`onJob swap ${jobId}`, `event pending ${jobId}`], `onJob comes first (${order.join(' | ')})`);
    assert.strictEqual(order.filter((x) => x.startsWith('onJob')).length, 1, 'onJob fires once per job');
    const pq = makeConfidentialSettler({ storage: freshStore(), hash });
    const prelay = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(pq) });
    const seen = [];
    const proving = prelay.prove({ type: 'swap', op: swapOp, memos: [] }, { intervalMs: 0, sleep: tick, onJob: (id) => seen.push(id) });
    while (!seen.length) await tick();
    const pj = await pq.nextJob(); await pq.ackJob(pj.jobId, { publicValues: '0x01', proof: '0x02' });
    await proving;
    assert.deepStrictEqual(seen, [pj.jobId], 'a prove-only job names itself to onJob once');
  } finally { globalThis.dispatchEvent = was; }
  ok('onJob names a queued job to its caller before the job is announced, once, for settles and proofs');
}

// An op that expires says when, on the event its page follows it by: its own deadline, in ms, for the types the pool gates with
// Expired(), and nothing for the rest (a lock's deadline is a refund time, valid only after it).
{
  const { opExpiry, EXPIRY_TYPES } = await import('../dapp/confidential-relay.js');
  const { opExpiry: relayExpiry } = await import('../worker-relay/src/lib/revert-data.js');
  assert.strictEqual(opExpiry('unwrap', { opDeadline: 1_800_000_000n }), 1_800_000_000, 'a BigInt deadline reads');
  assert.strictEqual(opExpiry('unwrap', { deadline: '1800000600' }), 1_800_000_600, 'a string deadline reads');
  assert.strictEqual(opExpiry('unwrap', { opDeadline: 0 }), 0, 'no deadline is no expiry');
  assert.strictEqual(opExpiry('wrap', { deadline: 1_800_000_000 }), 0, 'a type outside the list never expires');
  assert.strictEqual(opExpiry('lock', { deadline: 1_800_000_000 }), 0, 'a lock deadline is a refund time, not an expiry');
  // The page and the relay read the same types and the same field, so what the page says is when the relay fails it.
  for (const type of [...EXPIRY_TYPES, 'wrap', 'lock', 'transfer', 'bridgemint']) {
    for (const op of [{ opDeadline: 1_800_000_000 }, { deadline: 1_800_000_000 }, { opDeadline: 5, deadline: 9 }, {}]) {
      assert.strictEqual(opExpiry(type, op), relayExpiry({ type, op }), `page and relay agree on ${type} ${JSON.stringify(op)}`);
    }
  }
  const events = [], was = globalThis.dispatchEvent;
  globalThis.dispatchEvent = (e) => { if (e.type === 'tacit:job') events.push(e.detail); return true; };
  try {
    const q = makeConfidentialSettler({ storage: freshStore(), hash });
    const relay = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q) });
    const dl = Math.floor(Date.now() / 1000) + 3600;
    const a = await relay.submitOp({ type: 'swap', op: { ...swapOp, opDeadline: dl }, memos: [] });
    const b = await relay.submitOp({ type: 'swap', op: { ...swapOp, opDeadline: 0, deadline: 0 }, memos: [] }).catch(() => null);
    const first = events.find((d) => d.jobId === a.jobId);
    assert.strictEqual(first.by, dl * 1000, `the event carries when it expires (${JSON.stringify(first)})`);
    if (b) assert.ok(!('by' in events.find((d) => d.jobId === b.jobId)), 'an op with no deadline carries no time');
  } finally { globalThis.dispatchEvent = was; }
  ok('an op that expires carries its deadline on the job event; the page and the relay read the same types and field');
}

// ───────────────── the memos a proof commits to ─────────────────
// The same op asked for twice is proved once, with its first memos: prove() hands those back once the guard has
// checked them, refuses memos that do not check out, and leaves the caller's own when the relay returns none.
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  const BAD = '0x' + 'ee'.repeat(68), checked = [];
  const guard = {
    sealMemosForOutputs: ({ outputs }) => outputs.map(() => '0x' + 'cc'.repeat(68)),
    assertOutputsRecoverable: ({ memos }) => { checked.push(memos[0]); if (memos[0] === BAD) throw new Error('recovery-guard: leaf 0 memo does not open to its leaf'); },
  };
  const relay = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q), guard });
  const tick = () => new Promise((r) => setImmediate(r)), opts = { intervalMs: 0, sleep: tick };
  const spec = { type: 'wrap', op: { asset: '0x01', value: '5', cx: '0x02', cy: '0x03', owner: '0x04' }, leaves: ['0x' + '11'.repeat(32)], outputs: [{ ownerPub: '0x02' + 'ab'.repeat(32) }] };
  const first = ['0x' + 'aa'.repeat(68)], again = ['0x' + 'bb'.repeat(68)];
  const a = relay.prove({ ...spec, memos: first }, opts);
  let j; while (!(j = await q.nextJob({ mode: 'prove' }))) await tick();
  await q.ackJob(j.jobId, { publicValues: '0x01', proof: '0x02' });
  assert.deepStrictEqual((await a).memos, first, 'a fresh proof carries the memos this call sealed');
  const b = await relay.prove({ ...spec, memos: again }, opts);
  assert.strictEqual(b.jobId, j.jobId, 'the same op joins the proven job');
  assert.deepStrictEqual(b.memos, first, 'the memos the proof commits to, not the second call\'s');
  assert.ok(checked.includes(first[0]), 'checked by the guard before being handed back');

  // memos that do not open are refused (queued past this client, which would not have sent them)
  const q2 = makeConfidentialSettler({ storage: freshStore(), hash });
  const r2 = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q2), guard });
  const j2 = await q2.submitJob({ type: spec.type, op: spec.op, memos: [BAD], mode: 'prove' });
  await q2.nextJob({ mode: 'prove' });
  await q2.ackJob(j2.jobId, { publicValues: '0x01', proof: '0x02' });
  await assert.rejects(r2.prove({ ...spec, memos: again }, opts), /recovery-guard/);

  // an older relay that returns no memos leaves the caller's own
  const r3 = makeConfidentialRelay({ base: '', guard, fetchImpl: async (url, init) => {
    const res = await mockFetch(q)(url, init);
    if (!String(url).includes('/confidential/status')) return res;
    const body = JSON.parse(await res.text()); delete body.memos;
    return { ...res, text: async () => JSON.stringify(body) };
  } });
  assert.deepStrictEqual((await r3.prove({ ...spec, memos: again }, opts)).memos, again);
  ok('prove() hands back the memos its proof commits to, checked; refuses ones that do not open; keeps the caller\'s when none come back');
}

// ───────────────── a refusal keeps the relay's code; an open job is offered to the holder with its proof ─────────────────
{
  const refusing = async () => ({ ok: false, status: 429, statusText: '429', text: async () => JSON.stringify({ ok: false, error: 'the relay can’t take this one just now', code: 'relay_held', retryAfter: 300 }) });
  const relay = makeConfidentialRelay({ base: '', fetchImpl: refusing });
  const e = await relay.submitOp({ type: 'unwrap', op: { v: 1 } }).then(() => null, (x) => x);
  assert.ok(e, 'refused');
  assert.strictEqual(e.code, 'relay_held');
  assert.strictEqual(e.httpStatus, 429);
  assert.strictEqual(e.retryAfter, 300);
  assert.match(e.message, /^relay 429: the relay can’t take this one/, 'the words the pages read are unchanged');

  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  const relay2 = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q) });
  const tick = () => new Promise((r) => setImmediate(r));
  const memos = ['0x' + 'ab'.repeat(40)];
  const pending = relay2.settle({ type: 'transfer', op: { n: 1 }, memos }, { intervalMs: 0, sleep: tick, openGraceMs: 0 }).then(() => null, (x) => x);
  let j; while (!(j = await q.nextJob())) await tick();
  await q.ackJob(j.jobId, { publicValues: '0x' + '01'.repeat(64), proof: '0x' + '02'.repeat(64), open: true });
  const held = await pending;
  assert.strictEqual(held.code, 'open');
  assert.strictEqual(held.open.jobId, j.jobId);
  assert.strictEqual(held.open.publicValues, '0x' + '01'.repeat(64));
  assert.deepStrictEqual(held.open.memos, memos, 'the memos this call sealed');

  // memos other than the ones sealed here are not offered to send
  const swapped = async (url, init) => {
    const res = await mockFetch(q)(url, init);
    if (!String(url).includes('/confidential/status')) return res;
    const body = JSON.parse(await res.text()); if (body.memos) body.memos = ['0x' + 'ee'.repeat(40)];
    return { ...res, text: async () => JSON.stringify(body) };
  };
  const relay3 = makeConfidentialRelay({ base: '', fetchImpl: swapped });
  const e3 = await relay3.settle({ type: 'transfer', op: { n: 1 }, memos }, { intervalMs: 0, sleep: tick, openGraceMs: 0 }).then(() => null, (x) => x);
  assert.ok(e3 && e3.open === null && e3.code === undefined, 'no offer to send memos this page did not seal');

  // a job that is still waiting when the wait runs out carries its proof too
  const e4 = await relay2.waitForSettle(j.jobId, { intervalMs: 0, sleep: tick, openGraceMs: 60_000, timeoutMs: -1 }).then(() => null, (x) => x);
  assert.match(e4.message, /settle timed out/);
  assert.strictEqual(e4.code, 'open');
  ok('a refusal keeps its code; a job the relay proved but holds is offered with its proof, only with the memos sealed here');
}

// ───────────────── a settle sent outside the relay is reported and the job reads settled ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  const j = await q.submitJob({ type: 'transfer', op: { n: 2 } });
  await q.nextJob();
  await q.ackJob(j.jobId, { publicValues: '0x' + '01'.repeat(64), proof: '0x02', open: true });
  const seen = [];
  globalThis.dispatchEvent = (ev) => seen.push(ev.detail);
  globalThis.CustomEvent = class { constructor(type, { detail }) { this.type = type; this.detail = detail; } };
  const fetchImpl = async (urlStr, opts = {}) => {
    const url = new URL(urlStr, 'http://relay.test');
    if (url.pathname === '/confidential/landed') {
      const b = JSON.parse(opts.body);
      const r = await q.landedJob(b.jobId, b.txHash, async () => ({ ok: true }));
      return { ok: r.ok !== false, status: r.ok === false ? 409 : 200, statusText: '', text: async () => JSON.stringify(r) };
    }
    return mockFetch(q)(urlStr, opts);
  };
  const relay = makeConfidentialRelay({ base: '', fetchImpl });
  const r = await relay.landed(j.jobId, '0x' + '33'.repeat(32));
  assert.strictEqual(r.status, 'settled');
  assert.strictEqual((await relay.status(j.jobId)).status, 'settled');
  assert.ok(seen.some((d) => d.jobId === j.jobId && d.status === 'settled'), 'announced to the page');
  const bad = await makeConfidentialRelay({ base: '', fetchImpl: async () => { throw new Error('offline'); } }).landed(j.jobId, '0x' + '33'.repeat(32));
  assert.strictEqual(bad.ok, false, 'never throws');
  delete globalThis.dispatchEvent; delete globalThis.CustomEvent;
  ok('landed() reports a settle sent outside the relay, the job reads settled, and it never throws');
}

// ───────────────── proving with the holder's own prover account: nothing reaches the relay ─────────────────
{
  const calls = [];
  const relay = makeConfidentialRelay({ base: '', fetchImpl: async (url) => { calls.push(String(url)); throw new Error('the relay must not be asked'); } });
  const seen = [];
  relay.useProver(async ({ type, op, memos, onUpdate }) => {
    seen.push({ type, op, memos });
    onUpdate({ requestId: '0xabc', status: 'proving', stage: 'requested' });
    return { requestId: '0xabc', publicValues: '0x' + '01'.repeat(64), proof: '0x02' };
  });
  assert.ok(relay.ownProving());
  const jobs = [];
  const r = await relay.prove({ type: 'unwrap', op: { v: 1 }, memos: [] }, { onJob: (id) => jobs.push(id) });
  assert.strictEqual(r.status, 'proven');
  assert.strictEqual(r.jobId, 'spn:0xabc');
  assert.strictEqual(r.publicValues, '0x' + '01'.repeat(64));
  assert.deepStrictEqual(jobs, ['spn:0xabc'], 'onJob names the network request');
  assert.deepStrictEqual(seen, [{ type: 'unwrap', op: { v: 1 }, memos: [] }]);
  assert.strictEqual((await relay.status('spn:0xabc')).status, 'proven');
  assert.strictEqual((await relay.landed('spn:0xabc', '0x' + '33'.repeat(32))).status, 'settled');
  assert.strictEqual((await relay.status('spn:0xabc')).status, 'settled');
  assert.deepStrictEqual(calls, [], 'no request went to the relay');
  // memos are sealed and checked as for a relay job: raw leaf memos without outputs are refused before the prover is asked
  const guarded = makeConfidentialRelay({ base: '', fetchImpl: async () => { throw new Error('no'); }, guard: { sealMemosForOutputs: () => [], assertOutputsRecoverable: () => {} } });
  guarded.useProver(async () => { throw new Error('must not be reached'); });
  await assert.rejects(guarded.prove({ type: 'transfer', op: {}, memos: ['0x' + 'aa'.repeat(40)] }), /raw memos bypass the recovery guard/);
  // A proof whose input went public (the network refusing private inputs) says so on each step and on its result, for the page to say.
  const said = [];
  relay.useProver(async ({ onUpdate }) => {
    onUpdate({ status: 'proving', stage: 'uploading', public: true });
    onUpdate({ requestId: '0xpub', status: 'proving', stage: 'requested', public: true });
    return { requestId: '0xpub', publicValues: '0x' + '01'.repeat(64), proof: '0x02', private: false };
  });
  const rp = await relay.prove({ type: 'unwrap', op: { v: 2 }, memos: [] }, { onUpdate: (st) => said.push(`${st.jobId}:${st.stage}:${!!st.inputPublic}`) });
  assert.deepStrictEqual(said, ['null:uploading:true', 'spn:0xpub:requested:true']);
  assert.strictEqual(rp.inputPublic, true);
  assert.strictEqual((await relay.status('spn:0xpub')).inputPublic, true);
  relay.useProver(null);
  assert.ok(!relay.ownProving());
  ok('useProver: prove() goes to the holder\'s own prover with the memos sealed here, reads as a proven job, and never asks the relay');
}

// ───────────────── the prover is chosen per call: viaRelay goes to the relay, and a call never re-reads the slot ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  const tick = () => new Promise((r) => setImmediate(r));
  const submitted = [];
  const fetchImpl = async (url, init) => { if (String(url).includes('/confidential/submit')) submitted.push(JSON.parse(init.body)); return mockFetch(q)(url, init); };
  const relay = makeConfidentialRelay({ base: '', fetchImpl });
  let ownCalls = 0;
  relay.useProver(async () => { ownCalls++; return { requestId: '0xdef', publicValues: '0x' + '05'.repeat(64), proof: '0x06' }; });
  const opts = { intervalMs: 0, sleep: tick };
  const viaRelay = relay.prove({ type: 'unwrap', op: { v: 7 }, memos: [] }, { ...opts, viaRelay: true });
  let j; while (!(j = await q.nextJob({ mode: 'prove' }))) await tick();
  await q.ackJob(j.jobId, { publicValues: '0x' + '07'.repeat(64), proof: '0x08' });
  const r1 = await viaRelay;
  assert.strictEqual(r1.status, 'proven');
  assert.strictEqual(r1.publicValues, '0x' + '07'.repeat(64), 'proved by the relay');
  assert.strictEqual(ownCalls, 0, 'viaRelay never reaches the own prover');
  assert.strictEqual(submitted.length, 1);
  assert.strictEqual(submitted[0].mode, 'prove');
  assert.ok(relay.ownProving(), 'ownProving() still reports the slot');
  const r2 = await relay.prove({ type: 'unwrap', op: { v: 8 }, memos: [] }, {});
  assert.strictEqual(r2.jobId, 'spn:0xdef');
  assert.strictEqual(ownCalls, 1, 'without viaRelay the own prover takes it');
  assert.strictEqual(submitted.length, 1, 'and nothing more reached the relay');

  // A call that chose the own prover keeps it when the slot is cleared while it runs (another action switching to the relay).
  let release;
  const relay2 = makeConfidentialRelay({ base: '', fetchImpl: async () => { throw new Error('the relay must not be asked'); } });
  relay2.useProver(async ({ onUpdate }) => { onUpdate({ requestId: '0xaaa' }); await new Promise((r) => { release = r; }); return { requestId: '0xaaa', publicValues: '0x01', proof: '0x02' }; });
  const running = relay2.prove({ type: 'unwrap', op: { v: 9 }, memos: [] }, {});
  while (!release) await tick();
  relay2.useProver(null);
  release();
  assert.strictEqual((await running).jobId, 'spn:0xaaa', 'finished on the prover it chose');
  ok('prove() chooses its prover per call: viaRelay goes to the relay, otherwise the own prover, and clearing the slot mid-call changes nothing');
}

// ───────────────── where the relay stands: state(), relayCanProve, and the relay_paused refusal ─────────────────
{
  let reads = 0, answer = { state: 'held', proving: true, settling: false, board: true, ageSeconds: 12 };
  const fetchImpl = async (urlStr) => {
    const url = new URL(urlStr, 'http://relay.test');
    if (url.pathname !== '/confidential/relay') throw new Error(`unexpected ${url.pathname}`);
    reads++;
    if (answer instanceof Error) throw answer;
    if (answer === 503) return { ok: false, status: 503, statusText: '503', text: async () => JSON.stringify({ ok: false, error: 'unreadable' }) };
    return { ok: true, status: 200, statusText: '200', text: async () => JSON.stringify(answer) };
  };
  const realNow = Date.now; let now = 1_000_000; Date.now = () => now;
  try {
    const relay = makeConfidentialRelay({ base: 'https://api.test/', fetchImpl });
    assert.deepStrictEqual(await relay.state(), { state: 'held', proving: true, settling: false, board: true }, 'the four fields, nothing about age or why');
    answer = { state: 'paused', proving: false, settling: false, board: false };
    now += 14_000;
    assert.strictEqual((await relay.state()).state, 'held', 'read again only after 15 seconds');
    assert.strictEqual(reads, 1);
    now += 1_000;
    assert.strictEqual((await relay.state()).state, 'paused');
    assert.strictEqual(reads, 2);
    now += 20_000;
    const [a, b] = await Promise.all([relay.state(), relay.state()]);
    assert.strictEqual(reads, 3, 'two callers at once share one read');
    assert.deepStrictEqual(a, b);
    answer = new Error('offline'); now += 20_000;
    assert.strictEqual(await relay.state(), null, 'unreadable: null, never a throw');
    answer = 503; now += 20_000;
    assert.strictEqual(await relay.state(), null, 'an API without the route, or a 503: null');
    answer = { nonsense: true }; now += 20_000;
    assert.strictEqual(await relay.state(), null, 'an answer with no state: null');
  } finally { Date.now = realNow; }

  assert.strictEqual(relayCanProve({ state: 'paused' }), false);
  assert.strictEqual(relayCanProve({ state: 'down' }), false);
  for (const s of ['ok', 'busy', 'held']) assert.strictEqual(relayCanProve({ state: s }), true, s);
  assert.strictEqual(relayCanProve(null), true, 'an unread state is no reason to go another way');
  assert.strictEqual(relayCanProve(undefined), true);

  const paused = async () => ({ ok: false, status: 503, statusText: '503', text: async () => JSON.stringify({ ok: false, error: 'the relay isn’t proving right now — prove it with your own prover account, or try again later', code: 'relay_paused', retryAfter: 300 }) });
  const e = await makeConfidentialRelay({ base: '', fetchImpl: paused }).prove({ type: 'unwrap', op: { v: 1 }, memos: [] }).then(() => null, (x) => x);
  assert.ok(e, 'refused');
  assert.strictEqual(e.code, 'relay_paused');
  assert.strictEqual(e.httpStatus, 503);
  assert.strictEqual(e.retryAfter, 300);

  const accepted = async () => ({ ok: true, status: 200, statusText: '200', text: async () => JSON.stringify({ ok: true, jobId: '0x' + '11'.repeat(32), status: 'pending', relay: 'held' }) });
  const sub = await makeConfidentialRelay({ base: '', fetchImpl: accepted }).submitOp({ type: 'unwrap', op: { v: 1 }, memos: [], mode: 'prove' });
  assert.strictEqual(sub.relay, 'held', 'the submit answer keeps where the relay stood');
  ok('state() reads where the relay stands every 15 s at most and never throws; relayCanProve; relay_paused keeps its code, status and retryAfter; a submit keeps `relay`');
}

// ───────────────── sealed: with a sealer set, a relayed settle sends ciphertext and memos, never the op ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash, now: () => Date.now(), sleep: async () => {} });
  const bodies = [];
  const f = mockFetch(q);
  const spy = async (u, o) => { if (o && o.body) bodies.push(JSON.parse(o.body)); return f(u, o); };
  const relay = makeConfidentialRelay({ base: '', fetchImpl: spy });
  const sealedBox = { worker: 'tacit-a5000', epk: '0x02' + 'ab'.repeat(32), iv: 'AAAAAAAAAAAAAAAA', ct: 'QUJD'.repeat(10) };
  const seen = [];
  assert.strictEqual(relay.sealing(), false);
  relay.useSealer(async (x) => { seen.push(x); return sealedBox; });
  assert.strictEqual(relay.sealing(), true);
  const op = { chainBinding: '0xcb', spendRoot: '0xr', fee: 1, secret: 'witness' };
  const r = await relay.submitOp({ type: 'transfer', op, memos: ['0x01'] });
  assert.strictEqual(r.status, 'pending');
  assert.strictEqual(seen.length, 1); assert.strictEqual(seen[0].type, 'transfer'); assert.strictEqual(seen[0].op, op); assert.deepStrictEqual(seen[0].memos, ['0x01']);
  assert.match(String(bodies[0].cancel), /^0x[0-9a-f]{64}$/, 'a sealed job carries its cancel hash too');
  { const { cancel: _c, ...rest } = bodies[0]; assert.deepStrictEqual(rest, { type: 'transfer', mode: 'sealed', sealed: sealedBox, memos: ['0x01'] }, 'the op is not in the body'); }
  const st = await relay.status(r.jobId);
  assert.strictEqual(st.sealed, true);
  const job = await q.nextJob();
  assert.strictEqual(job.op, null); assert.deepStrictEqual(job.sealed, sealedBox);
  // a prove-only call, a call sent to the relay on purpose and a wrap with its deposit go unsealed
  await relay.submitOp({ type: 'transfer', op, memos: ['0x02'], mode: 'prove' });
  assert.strictEqual(bodies[1].mode, 'prove'); assert.ok(bodies[1].op);
  await relay.submitOp({ type: 'transfer', op: { ...op, secret: 'w2' }, memos: ['0x03'] }, { viaRelay: true });
  assert.strictEqual(bodies[2].mode, undefined); assert.ok(bodies[2].op);
  await relay.submitOp({ type: 'transfer', op: { ...op, secret: 'w3' }, memos: ['0x04'], depositTx: '0xdep' });
  assert.ok(bodies[3].op); assert.strictEqual(bodies[3].depositTx, '0xdep');
  assert.strictEqual(seen.length, 1, 'the sealer was asked once');
  // a sealer that answers null sends the op as usual; a sealer that throws stops the submit with its error, nothing sent
  relay.useSealer(async () => null);
  await relay.submitOp({ type: 'transfer', op: { ...op, secret: 'w4' }, memos: ['0x05'] });
  assert.ok(bodies[4].op); assert.strictEqual(bodies[4].mode, undefined);
  relay.useSealer(async () => { throw Object.assign(new Error('machine away'), { code: 'sealed_unavailable' }); });
  await assert.rejects(() => relay.submitOp({ type: 'transfer', op: { ...op, secret: 'w5' }, memos: ['0x06'] }), (e) => e.code === 'sealed_unavailable');
  assert.strictEqual(bodies.length, 5, 'nothing was sent');
  // the same op sent again is the job this client already made for it: no second sealing, no second job; a failed one is sent again
  let sealings = 0;
  relay.useSealer(async () => { sealings++; return { ...sealedBox, ct: 'QUJD'.repeat(10 + sealings) }; });
  const first = await relay.submitOp({ type: 'transfer', op: { ...op, secret: 'w6' }, memos: ['0x07'] });
  const again = await relay.submitOp({ type: 'transfer', op: { ...op, secret: 'w6' }, memos: ['0x07'] });
  assert.strictEqual(again.jobId, first.jobId); assert.ok(again.deduped); assert.strictEqual(sealings, 1, 'sealed once');
  await q.nextJob(); await q.nextJob(); await q.nextJob();                      // claim what is queued so the sealed job can be acked
  await q.ackJob(first.jobId, { error: 'the sealed prover is not available right now' });   // the relay's own failure: one more try, still the same job
  const held = await relay.submitOp({ type: 'transfer', op: { ...op, secret: 'w6' }, memos: ['0x07'] });
  assert.strictEqual(held.jobId, first.jobId); assert.strictEqual(sealings, 1, 'a job back in line is still this client’s job');
  await q.ackJob(first.jobId, { error: 'the sealed prover is not available right now' });   // the second failure is final
  const third = await relay.submitOp({ type: 'transfer', op: { ...op, secret: 'w6' }, memos: ['0x07'] });
  assert.notStrictEqual(third.jobId, first.jobId); assert.strictEqual(sealings, 2, 'a failed sealed job is sealed and sent again');
  relay.useSealer(null);
  assert.strictEqual(relay.sealing(), false);
  ok('useSealer: a relayed settle goes as { type, mode: sealed, sealed, memos } without the op; prove, viaRelay and a wrap go unsealed; null sends as usual; a throw sends nothing');
}

// ───────────────── a settled answer that comes without its transaction is read again, for an op that makes no notes too ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  const inner = mockFetch(q);
  let dropped = 0;
  const fetchImpl = async (u, o) => {
    const res = await inner(u, o);
    if (new URL(u, 'http://relay.test').pathname !== '/confidential/status' || dropped >= 1) return res;
    const j = JSON.parse(await res.text());
    if (j.status !== 'settled') return res;
    dropped++; delete j.txHash;                                                  // the first settled answer has no hash yet
    return { ok: true, status: 200, statusText: '200', text: async () => JSON.stringify(j) };
  };
  const relay = makeConfidentialRelay({ base: '', fetchImpl });
  let acked = false;
  const sleep = async () => { if (!acked) { acked = true; const { jobId } = await q.nextJob(); await q.ackJob(jobId, { txHash: '0xcafe' }); } };
  const st = await relay.settle({ type: 'swap', op: swapOp, memos: ['0xaa'] }, { intervalMs: 0, sleep });
  assert.strictEqual(dropped, 1, 'the first settled answer carried no hash');
  assert.strictEqual(st.txHash, '0xcafe', 'and the settle’s transaction is read again (a bridge burn has no leaves, and was never read again)');
  ok('settle: a settled answer without its transaction hash is read again whether or not the op makes notes');
}

// A page can end a proof's wait early: the wait pauses through `waitOpts.sleep` between the relay's answers, and a pause that throws ends it at once with that error, for the
// proof (an add whose pool a trade has moved, which nothing can send) and for a settle alike. The relay is not asked again after it, and its job is left as it is.
{
  const asked = [], tick = () => new Promise((r) => setTimeout(r, 1));
  for (const how of ['prove', 'settle']) {
    const q = makeConfidentialSettler({ storage: freshStore(), hash });
    const base = mockFetch(q);
    const relay = makeConfidentialRelay({ base: '', fetchImpl: async (u, o) => { if (String(u).includes('/confidential/status')) asked.push(how); return base(u, o); } });
    let pauses = 0, jobId = null;
    const moved = Object.assign(new Error('The pool traded while this was being proved.'), { moved: true, early: true });
    const waitOpts = { intervalMs: 0, onJob: (id) => { jobId = id; }, sleep: async () => { await tick(); if (++pauses >= 3) throw moved; } };
    const before = asked.length;
    await assert.rejects(() => relay[how]({ type: 'swap', op: swapOp, memos: [] }, waitOpts), (e) => e === moved && e.moved === true);
    const polls = asked.length - before;
    assert.ok(jobId && pauses === 3, `${how}: three pauses and out (${pauses})`);
    await tick(); await tick();
    assert.equal(asked.length - before, polls, `${how}: the relay is not asked again once the wait has ended`);
    assert.ok(polls >= 2 && polls <= 5, `${how}: it had been asking each pause (${polls} answers)`);
    assert.equal((await q.jobStatus(jobId)).status, 'pending', `${how}: and the job itself is left as it was`);
  }
  ok('a pause that throws ends a proof\'s or a settle\'s wait at once, and the relay is not asked again');
}

// ───────────────── a prove-only job may wait out the queue (queuedTimeoutMs), and the same op asked again is the same job ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  const relay = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q) });
  const op = { depositsConsumed: ['0xhome'], leaves: ['0xleafhome'] };
  const { jobId } = await relay.submitOp({ type: 'wrap', op, mode: 'prove' });

  // without the opt-in, a queued job's wait runs out on the one clock, as it always did
  await assert.rejects(() => relay.waitForProof(jobId, { intervalMs: 0, timeoutMs: -1, sleep: noSleep }), /prove timed out \(box offline/);
  // with it, a job still in the queue is waited for past timeoutMs, and the proof is taken when it comes
  let polls = 0;
  const sleep = async () => { if (++polls === 3) await q.nextJob(); if (polls === 5) await q.ackJob(jobId, { publicValues: '0xpv', proof: '0xpf' }); };
  const st = await relay.waitForProof(jobId, { intervalMs: 0, timeoutMs: 60_000, queuedTimeoutMs: 60_000, sleep });
  assert.strictEqual(st.status, 'proven');
  ok('a queued prove-only job is waited for under queuedTimeoutMs, and resolves once proved');

  // the queued clock running out says the job is still waiting its turn, naming it
  const j2 = (await relay.submitOp({ type: 'wrap', op: { ...op, leaves: ['0xother'] }, mode: 'prove' })).jobId;
  await assert.rejects(() => relay.waitForProof(j2, { intervalMs: 0, queuedTimeoutMs: -1, sleep: noSleep }), (e) => /still waiting its turn/.test(e.message) && e.message.includes(j2));
  // once the relay takes it, timeoutMs counts from then
  await q.nextJob();
  await assert.rejects(() => relay.waitForProof(j2, { intervalMs: 0, timeoutMs: -1, queuedTimeoutMs: 60_000, sleep: noSleep }), /prove timed out \(box offline/);
  ok('the queued wait runs out naming the job; once taken, the proving clock applies');

  // the same op asked again (a try whose wait ran out) is answered with the job already held, not a second job
  const again = await relay.submitOp({ type: 'wrap', op: { ...op, leaves: ['0xother'] }, mode: 'prove' });
  assert.strictEqual(again.jobId, j2);
  ok('the same prove-only op submitted again is the same job');
}

// ───────────────── a job left in the queue when its swap is built again is dropped there ─────────────────
{
  const q = makeConfidentialSettler({ storage: freshStore(), hash });
  const relay = makeConfidentialRelay({ base: '', fetchImpl: mockFetch(q) });
  const { jobId } = await relay.submitOp({ type: 'route', op: { asset0: 'aa', assetFinal: 'bb', hops: [{ reserveAPre: '1', reserveBPre: '1' }] }, memos: [] });
  const left = [];
  await assert.rejects(relay.waitForSettle(jobId, { intervalMs: 0, sleep: noSleep, queuedCheckMs: 0, whileQueued: async () => true, onLeft: (id) => left.push(id) }), (e) => e.staleQueued === true);
  assert.deepStrictEqual(left, [jobId]);
  const st = await q.jobStatus(jobId);
  assert.strictEqual(st.status, 'failed', 'the relay will not take it');
  assert.match(st.error, /cancelled by its sender/);
  assert.strictEqual(await q.pendingCount(), 0, 'out of the queue');
  assert.strictEqual(await relay.cancel(jobId), false, 'its secret is spent');

  const b = await relay.submitOp({ type: 'route', op: { asset0: 'aa', assetFinal: 'bb', hops: [{ reserveAPre: '2', reserveBPre: '2' }] }, memos: [] });
  await q.nextJob();
  assert.strictEqual(await relay.cancel(b.jobId), false, 'one the relay has taken runs its course');
  assert.strictEqual((await q.jobStatus(b.jobId)).status, 'proving');
  const p = await relay.submitOp({ type: 'swap', op: swapOp, memos: [], mode: 'prove' });
  assert.strictEqual(await relay.cancel(p.jobId), false, 'a prove-only job carries no secret');
  ok('a stale queued job is cancelled with its secret before the wait ends; a claimed or prove-only one is not');
}

console.log(`\n${n} confidential-relay checks passed.`);
