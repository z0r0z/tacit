// batchReads (dapp/trade/batch.js): reads started in the same moment go out as one Multicall3 call, encoded and decoded as viem does, and a read the batch
// cannot answer (a revert, a failed batch, a reply that is not the batch's) is asked again alone, so a caller sees what the page's own call says.
import assert from 'node:assert/strict';
import { batchReads, encodeBatch, decodeBatch, MULTICALL3 } from '../dapp/trade/batch.js';

const { encodeFunctionResult, decodeFunctionData } = await import('../worker-relay/node_modules/viem/_esm/index.js');
const abi = [{ type: 'function', name: 'aggregate3', stateMutability: 'payable', inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' }] }], outputs: [{ name: 'returnData', type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }] }];
const reply = (rs) => encodeFunctionResult({ abi, functionName: 'aggregate3', result: rs.map(([success, returnData]) => ({ success, returnData })) });
const A = '0x0155358241411dB868BA714aE7c83A27087e3D6E', B = '0x0000003bF4BA0B21f5e0d35119b337F4d4CF82E0';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const word = (v) => `0x${BigInt(v).toString(16).padStart(64, '0')}`;

// a page's own call: answers by the data's last byte, reverts for 0xee, and counts what it was asked
function page({ batch = 'ok' } = {}) {
  const asked = [];
  const call = async (tx) => {
    asked.push(tx);
    if (tx.to.toLowerCase() === MULTICALL3.toLowerCase()) {
      if (batch === 'throw') throw new Error('node down');
      if (batch === 'junk') return '0x1234';
      const { args: [calls] } = decodeFunctionData({ abi, data: tx.data });
      return reply(calls.map((c) => (c.callData.endsWith('ee') ? [false, '0x'] : [true, word(parseInt(c.callData.slice(-2), 16))])));
    }
    if (tx.data.endsWith('ee')) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x797dba54' });
    return word(parseInt(tx.data.slice(-2), 16));
  };
  return { asked, call, read: batchReads(call, { wait: 2 }) };
}

await check('the encoding is the one aggregate3 decodes, odd-length data padded', async () => {
  const calls = [{ to: A, data: '0x70a08231' + '0'.repeat(24) + 'ab'.repeat(20) }, { to: B, data: '0x817b1cd2' }, { to: A, data: '0xfeaf968c' }];
  const { functionName, args: [got] } = decodeFunctionData({ abi, data: encodeBatch(calls) });
  assert.equal(functionName, 'aggregate3');
  assert.deepEqual(got.map((c) => [c.target.toLowerCase(), c.allowFailure, c.callData]), calls.map((c) => [c.to.toLowerCase(), true, c.data]));
});

await check('the decoding reads what the node returned, null for a failure or an empty answer', async () => {
  const out = decodeBatch(reply([[true, word(7)], [false, '0x'], [true, '0x'], [true, '0x' + 'ab'.repeat(96)]]), 4);
  assert.deepEqual(out, [word(7), null, null, '0x' + 'ab'.repeat(96)]);
  assert.throws(() => decodeBatch('0x1234', 1));
  assert.throws(() => decodeBatch(reply([[true, word(1)]]), 2), /not this batch/);
});

await check('reads started together are one request; each caller gets its own answer', async () => {
  const p = page();
  const got = await Promise.all([1, 2, 3, 4, 5].map((i) => p.read({ to: i % 2 ? A : B, data: `0x000000${String(i).padStart(2, '0')}` })));
  assert.deepEqual(got.map((x) => BigInt(x)), [1n, 2n, 3n, 4n, 5n]);
  assert.equal(p.asked.length, 1);
  assert.equal(p.asked[0].to, MULTICALL3);
});

await check('a lone read goes alone, not as a batch of one', async () => {
  const p = page();
  assert.equal(BigInt(await p.read({ to: A, data: '0x01' })), 1n);
  assert.deepEqual(p.asked.map((t) => t.to), [A]);
});

await check('a read that reverts in the batch is asked again alone and rejects as the call does; the others are answered', async () => {
  const p = page();
  const [ok1, bad, ok2] = await Promise.allSettled([p.read({ to: A, data: '0x01' }), p.read({ to: B, data: '0xee' }), p.read({ to: A, data: '0x03' })]);
  assert.equal(BigInt(ok1.value), 1n); assert.equal(BigInt(ok2.value), 3n);
  assert.equal(bad.status, 'rejected'); assert.equal(bad.reason.code, 3); assert.equal(bad.reason.data, '0x797dba54');
  assert.equal(p.asked.length, 2);
});

await check('a batch the node fails, or answers with something else, falls back to each read alone', async () => {
  for (const batch of ['throw', 'junk']) {
    const p = page({ batch });
    const got = await Promise.all([1, 2, 3].map((i) => p.read({ to: A, data: `0x0${i}` })));
    assert.deepEqual(got.map((x) => BigInt(x)), [1n, 2n, 3n], batch);
    assert.equal(p.asked.length, 4, batch);
  }
});

await check('a read that names `from`, or is a Multicall3 call, is never batched', async () => {
  const p = page();
  await Promise.all([p.read({ to: A, data: '0x01', from: B }), p.read({ to: MULTICALL3, data: encodeBatch([{ to: A, data: '0x02' }]) }), p.read({ to: A, data: '0x03' })]);
  assert.equal(p.asked.length, 3);
  assert.ok(p.asked.filter((t) => t.to === MULTICALL3).length === 1 && p.asked.filter((t) => t.from).length === 1);
});

await check('reads that start apart are separate batches, and a full queue goes at once', async () => {
  const p = page();
  await p.read({ to: A, data: '0x01' }); await tick();
  await Promise.all([p.read({ to: A, data: '0x02' }), p.read({ to: A, data: '0x03' })]);
  assert.deepEqual(p.asked.map((t) => t.to === MULTICALL3), [false, true]);
  const q = page(), many = batchReads(q.call, { wait: 1e6, max: 3 });
  assert.deepEqual((await Promise.all([1, 2, 3].map((i) => many({ to: A, data: `0x0${i}` })))).map((x) => BigInt(x)), [1n, 2n, 3n]);
  assert.equal(q.asked.length, 1);
});

console.log(`${n} passed`);
