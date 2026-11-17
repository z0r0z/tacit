#!/usr/bin/env node
// What the relay keeps and republishes about who a job paid: the exit recipe is dropped once its activation is reported,
// error text carries no address or calldata, and a rate-limit key is not an address.
// Run: node tests/relay-neutrality.test.mjs
import assert from 'node:assert';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeConfidentialSettler, scrubPublic } from '../worker/src/confidential-settle.js';
import { scrubPublic as relayScrub, safeErr } from '../worker-relay/src/lib/safe-err.js';

const hash = (s) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex');
const sleep = () => Promise.resolve();
function freshStore() {
  const jobs = new Map(); let pending = [];
  return {
    getPending: async () => pending.slice(), putPending: async (ids) => { pending = ids.slice(); },
    getJob: async (id) => (jobs.has(id) ? JSON.parse(JSON.stringify(jobs.get(id))) : null),
    putJob: async (id, job) => { jobs.set(id, JSON.parse(JSON.stringify(job))); },
  };
}
const ADDR = '0x' + 'ab'.repeat(20), TX = '0x' + 'cd'.repeat(32);
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// error text: addresses and blobs go, hashes and selectors stay
for (const f of [scrubPublic, relayScrub]) {
  const out = f(`reverted to ${ADDR} data 0x${'12'.repeat(200)} pending ${TX} sel 0x8a98f245 at https://rpc.example/v2/KEY`);
  assert.ok(!out.includes(ADDR) && !out.includes('KEY') && !out.includes('1212'), out);
  assert.ok(out.includes(TX) && out.includes('0x8a98f245') && out.includes('<addr>') && out.includes('<hex>'), out);
}
assert.ok(!safeErr(new Error(`from ${ADDR} failed`)).includes(ADDR));
ok('error text drops addresses, calldata and URLs; keeps tx hashes and selectors');

// an exit's recipe is forgotten when the activation is reported
for (const report of [{ activateTx: TX }, { activateError: `activateExit to ${ADDR} reverted` }]) {
  const store = freshStore();
  const q = makeConfidentialSettler({ storage: store, hash, now: () => 1000, sleep });
  const j = await q.submitJob({ type: 'unwrap', op: { chainBinding: '0x01', spendRoot: '0x02' } });
  { const r = await store.getJob(j.jobId); r.exit = { exitedAsset: '0x' + '11'.repeat(32), finalRecipient: ADDR, calls: [] }; await store.putJob(j.jobId, r); }
  await q.nextJob();
  await q.ackJob(j.jobId, { txHash: TX });
  assert.strictEqual((await store.getJob(j.jobId)).exit.finalRecipient, ADDR, 'kept until the activation is reported');
  await q.ackJob(j.jobId, report);
  const rec = await store.getJob(j.jobId);
  assert.ok(!JSON.stringify(rec).includes(ADDR), 'no recipient left on the record: ' + JSON.stringify(rec));
  const st = await q.jobStatus(j.jobId);
  assert.ok(!JSON.stringify(st).includes(ADDR), 'status shows no recipient');
  assert.ok(['done', 'failed'].includes(st.activation), 'activation still reads as reported');
}
ok('a settled exit loses its recipe once the activation is reported, and still reports it');

// a failed job's error is scrubbed on the way in
{
  const store = freshStore();
  const q = makeConfidentialSettler({ storage: store, hash, now: () => 1000, sleep });
  const j = await q.submitJob({ type: 'swap', op: { reserveAPre: 1, reserveBPre: 1 } });
  await q.nextJob();
  await q.ackJob(j.jobId, { error: `settle reverted: to ${ADDR}` });
  assert.ok(!(await q.jobStatus(j.jobId)).error.includes(ADDR));
  ok('a failed job publishes no address in its error');
}
// a prove-only job keeps its proof for the page and drops the witness it was made from
{
  const store = freshStore();
  const q = makeConfidentialSettler({ storage: store, hash, now: () => 1000, sleep });
  const j = await q.submitJob({ type: 'swap', op: { reserveAPre: 1, reserveBPre: 1, secretNote: 'witness' }, mode: 'prove' });
  await q.nextJob({ mode: 'prove' });
  await q.ackJob(j.jobId, { publicValues: '0xaa', proof: '0xbb' });
  const rec = await store.getJob(j.jobId);
  assert.ok(!('op' in rec) && !JSON.stringify(rec).includes('witness'), 'no witness left on a proven job: ' + JSON.stringify(rec));
  const st = await q.jobStatus(j.jobId);
  assert.ok(st.status === 'proven' && st.publicValues === '0xaa' && st.proof === '0xbb', 'the proof is still served');
  assert.strictEqual((await q.submitJob({ type: 'swap', op: { reserveAPre: 1, reserveBPre: 1, secretNote: 'witness' }, mode: 'prove' })).deduped, true, 'asking again still finds the job');
  ok('a proven job keeps its proof and drops its witness');
}
console.log(`${n} passed`);
