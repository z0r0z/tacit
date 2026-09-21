// The prover's eth-state proof fetch: a 404 is a real miss, anything transient is retried.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.WORKER_BASE = process.env.WORKER_BASE || 'https://api.example.test';
process.env.BOX_TOKEN = process.env.BOX_TOKEN || 'test-token';
process.env.RPC_URL = process.env.RPC_URL || 'https://rpc.example.test';
process.env.RELAY_KEY = process.env.RELAY_KEY || '0x' + '11'.repeat(32);
const { reflectionEthProofPatient } = await import('../worker-relay/src/lib/worker-client.js');

const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('a 200 returns the blob on the first try', async () => {
  const c = clock(); let calls = 0;
  const out = await reflectionEthProofPatient('0xaa', { ...c, fetchImpl: async () => { calls++; return res(200, { ethCompressedProofB64: 'QQ==' }); } });
  assert.equal(out.ethCompressedProofB64, 'QQ=='); assert.equal(calls, 1);
});

test('a 404 is final and is not retried', async () => {
  const c = clock(); let calls = 0;
  const out = await reflectionEthProofPatient('0xaa', { ...c, fetchImpl: async () => { calls++; return res(404, { error: 'replaced' }); } });
  assert.deepEqual(out, {}); assert.equal(calls, 1);
});

test('5xx answers and dropped connections are retried until the blob arrives', async () => {
  const c = clock(); const script = [() => res(502, {}), () => { throw new Error('socket hang up'); }, () => res(503, {}), () => res(200, { ethCompressedProofB64: 'QQ==' })];
  let i = 0;
  const out = await reflectionEthProofPatient('0xaa', { ...c, pollMs: 10000, fetchImpl: async () => script[i++]() });
  assert.equal(out.ethCompressedProofB64, 'QQ=='); assert.equal(i, 4);
});

test('a truncated body reads as transient', async () => {
  const c = clock(); let i = 0;
  const out = await reflectionEthProofPatient('0xaa', { ...c, fetchImpl: async () => (i++ === 0 ? { ok: true, status: 200, json: async () => { throw new Error('unexpected end'); } } : res(200, { ethCompressedProofB64: 'QQ==' })) });
  assert.equal(out.ethCompressedProofB64, 'QQ=='); assert.equal(i, 2);
});

test('gives up with an empty result once the wait is over', async () => {
  const c = clock(); let calls = 0;
  const out = await reflectionEthProofPatient('0xaa', { ...c, waitSecs: 60, pollMs: 10000, fetchImpl: async () => { calls++; return res(502, {}); } });
  assert.deepEqual(out, {}); assert.ok(calls >= 6 && calls <= 8, `polled ${calls} times`);
});
