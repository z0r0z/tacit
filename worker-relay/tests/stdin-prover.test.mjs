// lib/stdin-prover.js: the relay's direct network request over several ops (the input it builds, the limits it asks for, how
// the env chooses private or public, how a refusal is marked). The network itself is stood in for.
//
// Run: node --test worker-relay/tests/stdin-prover.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeStdinProver, inputPolicy, notExecuted } from '../src/lib/stdin-prover.js';
import { batchStdin, LIMITS } from '../src/lib/spn/sp1-stdin.js';

const KEY = '0x' + '11'.repeat(32);
const FIX = new URL('../../tests/fixtures/sp1-stdin/', import.meta.url);
const op = (name) => JSON.parse(readFileSync(new URL(`${name}.op.json`, FIX), 'utf8'));
const hex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

test('inputPolicy follows the binaries\' env: PRIVATE_STDIN, PRIVATE_FALLBACK_PUBLIC and PROVER_WHITELIST', () => {
  assert.deepEqual(inputPolicy({}), { input: 'public', whitelist: undefined });
  assert.deepEqual(inputPolicy({ PRIVATE_STDIN: '1' }), { input: 'auto', whitelist: undefined });
  assert.deepEqual(inputPolicy({ PRIVATE_STDIN: '1', PRIVATE_FALLBACK_PUBLIC: '0' }), { input: 'private', whitelist: undefined });
  assert.deepEqual(inputPolicy({ PRIVATE_STDIN: '1', PROVER_WHITELIST: '0xaa, 0xbb,' }), { input: 'auto', whitelist: ['0xaa', '0xbb'] });
});

test('proveBatch builds one input over the ops with their memo hashes in order, asks with the summed limits and a deadline inside the timeout', async () => {
  const calls = [];
  const prover = { proveStdin: async (a) => { calls.push(a); a.onUpdate({ status: 'proving', stage: 'requested', requestId: '0x' + 'ab'.repeat(32) }); return { requestId: '0x' + 'ab'.repeat(32), publicValues: '0x01', proof: '0x02', private: false }; } };
  const p = makeStdinProver({ key: KEY, env: {}, prover, transport: { close() {} } });
  assert.match(p.address, /^0x[0-9a-f]{40}$/);
  const memosW = ['0x' + 'aa'.repeat(10)], memosU = ['0x' + 'bb'.repeat(5), '0xcc'];
  const items = [{ type: 'wrap', op: op('wrap'), memos: memosW }, { type: 'unwrap', op: { ...op('unwrap'), spendRoot: op('unwrap').spendRoot }, memos: memosU }];
  const updates = [];
  const r = await p.proveBatch({ items, timeoutMs: 900_000, onUpdate: (u) => updates.push(u) });
  assert.deepEqual(r, { publicValues: '0x01', proof: '0x02', requestId: '0x' + 'ab'.repeat(32), private: false, numOps: 2 });
  assert.equal(calls.length, 1);
  const want = batchStdin([
    { type: 'wrap', op: { ...op('wrap'), memoHashes: memosW.map((m) => hex(keccak_256(Buffer.from(m.slice(2), 'hex')))) } },
    { type: 'unwrap', op: { ...op('unwrap'), memoHashes: memosU.map((m) => hex(keccak_256(Buffer.from(m.slice(2), 'hex')))) } },
  ]);
  assert.equal(Buffer.compare(Buffer.from(calls[0].stdin), Buffer.from(want.stdin)), 0, 'the input is batchStdin over the ops with their memo hashes');
  assert.equal(calls[0].cycleLimit, LIMITS.wrap.cycleLimit + LIMITS.unwrap.cycleLimit);
  assert.equal(calls[0].gasLimit, LIMITS.wrap.gasLimit + LIMITS.unwrap.gasLimit);
  assert.equal(calls[0].timeoutSecs, 900 - 180, 'the request\'s deadline sits three minutes inside the job\'s time');
  assert.equal(updates.length, 1);
});

test('a refusal for credit is marked creditShort, as the binaries\' is; the network not executing the input is recognised', async () => {
  const short = makeStdinProver({ key: KEY, env: {}, transport: { close() {} }, prover: { proveStdin: async () => { throw Object.assign(new Error('your prover credit is 0.10 PROVE; this proof needs 0.80 PROVE on hand'), { code: 'prover_credit' }); } } });
  await assert.rejects(short.proveBatch({ items: [{ type: 'wrap', op: op('wrap'), memos: [] }] }), (e) => e.creditShort === true);
  const exhausted = makeStdinProver({ key: KEY, env: {}, transport: { close() {} }, prover: { proveStdin: async () => { throw Object.assign(new Error('insufficient balance 0.5 for request cost 0.9'), { grpcStatus: 8 }); } } });
  await assert.rejects(exhausted.proveBatch({ items: [{ type: 'wrap', op: op('wrap'), memos: [] }] }), (e) => e.creditShort === true);
  assert.equal(notExecuted(Object.assign(new Error('x'), { code: 'not_proved', reason: 'unexecutable: fulfillment UNFULFILLABLE (4), execution UNEXECUTABLE (3)' })), true);
  assert.equal(notExecuted(Object.assign(new Error('x'), { code: 'not_proved', reason: 'expired: …', network: { executionStatus: 2 } })), false);
  assert.equal(notExecuted(Object.assign(new Error('x'), { code: 'proof_mismatch' })), true);
  assert.equal(notExecuted(Object.assign(new Error('x'), { code: 'wait_timeout' })), false);
  assert.equal(notExecuted(null), false);
});

test('a wrap and a transfer that name different spend roots cannot share a request', async () => {
  const p = makeStdinProver({ key: KEY, env: {}, transport: { close() {} }, prover: { proveStdin: async () => { throw new Error('not reached'); } } });
  const t = op('transfer');
  await assert.rejects(p.proveBatch({ items: [{ type: 'transfer', op: t, memos: [] }, { type: 'transfer', op: { ...t, spendRoot: '0x' + 'ab'.repeat(32) }, memos: [] }] }), /another spendRoot/);
});
