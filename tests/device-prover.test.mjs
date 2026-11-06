// dapp/device-prover.js: the relay.useProver contract for the prover on the holder's own machine, with its local API stubbed: the
// health check only trusts a prover for this pool, the input it sends is sp1-stdin.js's byte for byte, ops whose proofs would go stale
// are declined (so the relay keeps them), and a proof comes back as relay.proveOwn expects it.
//
// Run: node --test tests/device-prover.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeDeviceProver, DEVICE_TYPES, DEVICE_LIVE_TYPES } from '../dapp/device-prover.js';
import { stdinFor } from '../dapp/sp1-stdin.js';

const VKEY = '0x006cd47fd23937a6d247696cace28c22d2c6a8280447e6ac45a3571de232d6e3';
const hex = (b) => '0x' + Buffer.from(b).toString('hex');
const wrap = JSON.parse(readFileSync(new URL('./fixtures/sp1-stdin/wrap.op.json', import.meta.url), 'utf8'));
const memo = '0x' + 'ab'.repeat(40);

function stub(script) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: u.pathname + u.search, body });
    const [status, json] = script(u, body, calls);
    return { ok: status < 400, status, json: async () => json };
  };
  return { fetchImpl, calls };
}

test('health trusts only a prover for this pool', async () => {
  const good = makeDeviceProver({ keccak256: keccak_256, fetchImpl: stub(() => [200, { ok: true, vkey: VKEY, busy: false, gpu: 'Apple M2' }]).fetchImpl });
  assert.equal((await good.health()).gpu, 'Apple M2');
  const other = makeDeviceProver({ keccak256: keccak_256, fetchImpl: stub(() => [200, { ok: true, vkey: '0x00' + '11'.repeat(31) }]).fetchImpl });
  assert.equal(await other.health(), null);
  const none = makeDeviceProver({ keccak256: keccak_256, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(await none.health(), null);
});

test('by default it takes only ops whose proofs pin no moving state', () => {
  const d = makeDeviceProver({ keccak256: keccak_256, fetchImpl: async () => { throw new Error('unused'); } });
  for (const t of ['wrap', 'transfer', 'unwrap', 'sendunwrap', 'stealthlock', 'stealthclaim', 'farmbond']) assert.ok(d.supports(t) && d.prove.supports(t), t);
  for (const t of ['swap', 'route', 'lp', 'cdpmint', 'bridgemint', 'wrapswap', 'farmharvest']) assert.ok(!d.supports(t), t);
  assert.ok(DEVICE_TYPES.every((t) => d.supports(t)));
});

test('ops that pin a pool\'s reserves only once allowed, and only those', () => {
  const d = makeDeviceProver({ keccak256: keccak_256, fetchImpl: async () => { throw new Error('no network in this test'); } });
  d.allowLive(true);
  for (const t of DEVICE_LIVE_TYPES) assert.ok(d.supports(t) && d.prove.supports(t), t);
  for (const t of ['cdpmint', 'bridgemint', 'farmharvest', 'bridgeburn']) assert.ok(!d.supports(t), t);
  d.allowLive(false);
  for (const t of DEVICE_LIVE_TYPES) assert.ok(!d.supports(t), t);
  assert.deepEqual([...DEVICE_LIVE_TYPES].sort(), ['lp', 'lpbond', 'lpremove', 'route', 'swap', 'wraplp', 'wrapswap']);
});

test('prove sends sp1-stdin.js\'s input and returns the proof as relay.proveOwn reads it', async () => {
  let polls = 0;
  const { fetchImpl, calls } = stub((u) => {
    if (u.pathname === '/prove') return [200, { id: 'abc' }];
    if (u.pathname === '/job') return ++polls < 3 ? [200, { status: polls === 1 ? 'queued' : 'proving', secs: polls }] : [200, { status: 'done', publicValues: '0x01', proof: '0x02', secs: 300 }];
    return [404, {}];
  });
  const stages = [];
  const d = makeDeviceProver({ keccak256: keccak_256, fetchImpl, sleep: async () => {} });
  const r = await d.prove({ type: 'wrap', op: wrap, memos: [memo], onUpdate: (u) => stages.push(u.stage) });
  assert.deepEqual(r, { requestId: 'device-abc', publicValues: '0x01', proof: '0x02', private: true, secs: 300 });
  assert.deepEqual(stages, ['queued', 'queued', 'device']);
  const sent = calls.find((c) => c.path === '/prove').body;
  assert.equal(sent.type, 'wrap');
  assert.equal(sent.stdin, hex(stdinFor('wrap', { ...wrap, memoHashes: [hex(keccak_256(Buffer.from(memo.slice(2), 'hex')))] })));
});

test('a failed or refused proof surfaces as a device_prover error', async () => {
  const failed = makeDeviceProver({ keccak256: keccak_256, sleep: async () => {}, fetchImpl: stub((u) => (u.pathname === '/prove' ? [200, { id: 'x' }] : [200, { status: 'failed', error: 'the guest rejects this input' }])).fetchImpl });
  await assert.rejects(failed.prove({ type: 'wrap', op: wrap, memos: [memo] }), (e) => e.code === 'device_prover' && /rejects this input/.test(e.message));
  const refused = makeDeviceProver({ keccak256: keccak_256, fetchImpl: stub(() => [403, { error: 'origin not allowed' }]).fetchImpl });
  await assert.rejects(refused.prove({ type: 'wrap', op: wrap, memos: [memo] }), (e) => e.code === 'device_prover' && /origin not allowed/.test(e.message));
  await assert.rejects(refused.prove({ type: 'swap', op: {}, memos: [] }), (e) => e.code === 'device_prover');
});
