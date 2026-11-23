// The vault oracle's proof relay (worker/src/oracle-proof.js): only a proof the verifier takes is kept, only a newer one replaces it, a post
// the chain could not check is not a verdict, and one client posts once in a while.
//   node --test tests/oracle-proof.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOracleProof, ORACLE_PROOF, proofInterval } from '../worker/src/oracle-proof.js';

const kvStore = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } }; };
const pvFor = (x) => '0x' + 'ab'.repeat(32) + x.toString(16).padStart(64, '0') + 'cd'.repeat(32);
const PROOF = '0x' + '11'.repeat(288);
const make = (verify, t = { now: 1_000_000 }) => {
  const kv = kvStore();
  return { kv, t, op: makeOracleProof({ kv, cfg: ORACLE_PROOF, verify, now: () => t.now }) };
};

test('the interval is the low 32 bits of the second word', () => {
  assert.equal(proofInterval(pvFor(529504).slice(2)), 529504);
});

test('a proof the verifier takes is kept and read back', async () => {
  const seen = [];
  const { op } = make(async (c) => { seen.push(c); return { ok: true }; });
  assert.equal((await op.get()).status, 404);
  const r = await op.submit({ publicValues: pvFor(100), proof: PROOF, client: 'a' });
  assert.deepEqual([r.status, r.body], [200, { ok: true, x: 100 }]);
  assert.equal(seen[0].vkey, ORACLE_PROOF.vkey);
  assert.equal(seen[0].verifier, ORACLE_PROOF.verifier);
  assert.equal(seen[0].proof, '0x4388a21c' + '00'.repeat(32) + '002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f25352' + PROOF.slice(2), 'the verifier is given the proof with its selector, exit code and vk root in front');
  const g = await op.get();
  assert.equal(g.status, 200);
  assert.equal(g.body.x, 100);
  assert.equal(g.body.publicValues, pvFor(100));
  assert.equal(g.body.proof, PROOF);
});

test('a proof the verifier refuses is not kept', async () => {
  const { op } = make(async () => ({ ok: false, reverted: true, definite: true }));
  assert.equal((await op.submit({ publicValues: pvFor(100), proof: PROOF, client: 'a' })).status, 400);
  assert.equal((await op.get()).status, 404);
});

test('a check the chain could not answer is not a verdict', async () => {
  const { op } = make(async () => ({ ok: false }));
  assert.equal((await op.submit({ publicValues: pvFor(100), proof: PROOF, client: 'a' })).status, 503);
  assert.equal((await op.get()).status, 404);
});

test('only a newer interval replaces the one held, and an old one is not even checked', async () => {
  let calls = 0;
  const { op, t } = make(async () => { calls++; return { ok: true }; });
  await op.submit({ publicValues: pvFor(100), proof: PROOF, client: 'a' });
  t.now += 60_000;
  assert.equal((await op.submit({ publicValues: pvFor(100), proof: PROOF, client: 'a' })).status, 409);
  assert.equal((await op.submit({ publicValues: pvFor(99), proof: PROOF, client: 'a' })).status, 409);
  assert.equal(calls, 1);
  assert.equal((await op.submit({ publicValues: pvFor(101), proof: PROOF, client: 'a' })).status, 200);
  assert.equal((await op.get()).body.x, 101);
});

test('what is not a proof is refused before anything is asked', async () => {
  let calls = 0;
  const { op } = make(async () => { calls++; return { ok: true }; });
  for (const bad of [
    { publicValues: '0x12', proof: PROOF },
    { publicValues: pvFor(5) + 'zz', proof: PROOF },
    { publicValues: pvFor(5), proof: '0x1234' },
    { publicValues: pvFor(5), proof: PROOF + '00' },
    { publicValues: undefined, proof: PROOF },
    { publicValues: '0x' + '00'.repeat(2000), proof: PROOF },
  ]) assert.equal((await op.submit({ ...bad, client: 'a' })).status, 400, JSON.stringify(bad).slice(0, 60));
  assert.equal(calls, 0);
});

test('one client posts once in a while, another is not held up by it', async () => {
  const { op, t } = make(async () => ({ ok: true }));
  assert.equal((await op.submit({ publicValues: pvFor(1), proof: PROOF, client: 'a' })).status, 200);
  assert.equal((await op.submit({ publicValues: pvFor(2), proof: PROOF, client: 'a' })).status, 429);
  assert.equal((await op.submit({ publicValues: pvFor(2), proof: PROOF, client: 'b' })).status, 200);
  t.now += ORACLE_PROOF.rateMs + 1;
  assert.equal((await op.submit({ publicValues: pvFor(3), proof: PROOF, client: 'a' })).status, 200);
});
