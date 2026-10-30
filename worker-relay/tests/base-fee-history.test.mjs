// The last day's base fees, read in chunks, kept for half an hour, shared, and never the reason a stage stops.
// node --test tests/base-fee-history.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBaseFeeHistory } from '../src/lib/base-fee-history.js';

// A node whose base fee at block n is (n % 100 + 1) mwei, serving feeHistory like the real one: blockCount entries and the next block's.
function fakeClient({ head = 100_000n, failFrom = Infinity, calls = [] } = {}) {
  let n = 0;
  return {
    calls,
    getBlockNumber: async () => head,
    getFeeHistory: async ({ blockCount, blockNumber }) => {
      calls.push(blockNumber);
      if (++n > failFrom) throw new Error('Archive requests require a personal token');
      const out = [];
      for (let b = blockNumber - BigInt(blockCount) + 1n; b <= blockNumber + 1n; b++) out.push((b % 100n + 1n) * 1_000_000n);
      return { baseFeePerGas: out };
    },
  };
}

test('a day is read as seven-odd chunks, oldest first, ending at the newest block', async () => {
  const c = fakeClient();
  const read = makeBaseFeeHistory(c);
  const h = await read();
  assert.equal(h.length, 7200);
  assert.equal(c.calls.length, 8, 'eight chunks of 1,024 cover 7,200 blocks');
  assert.equal(c.calls[0], 100_000n, 'the newest chunk first');
  assert.equal(h[h.length - 1], (100_000 % 100 + 1) * 1e-3, 'the last entry is the newest block\'s base fee, in gwei');
  assert.equal(h[h.length - 2], (99_999 % 100 + 1) * 1e-3);
});

test('it is kept for the ttl and shared by callers that ask together', async () => {
  const c = fakeClient();
  let t = 0;
  const read = makeBaseFeeHistory(c, { now: () => t });
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(a, b);
  assert.equal(c.calls.length, 8, 'two callers, one read');
  t = 29 * 60_000;
  await read();
  assert.equal(c.calls.length, 8, 'still fresh');
  t = 31 * 60_000;
  await read();
  assert.equal(c.calls.length, 16, 'read again after half an hour');
});

test('a node that will not serve older blocks gives the shorter history it has, if that is a norm', async () => {
  const c = fakeClient({ failFrom: 3 });
  const h = await makeBaseFeeHistory(c)();
  assert.equal(h.length, 3072, 'three chunks');
  const tooShort = await makeBaseFeeHistory(fakeClient({ failFrom: 0 }))();
  assert.equal(tooShort, null, 'no chunk at all is no history');
  const few = await makeBaseFeeHistory(fakeClient({ failFrom: 0 }), { chunk: 1024 })();
  assert.equal(few, null);
});

test('a failed refresh leaves the last good history standing and tries again soon, not at once', async () => {
  let t = 0, broken = false;
  const c = fakeClient();
  const real = c.getFeeHistory;
  c.getFeeHistory = async (a) => { if (broken) throw new Error('down'); return real(a); };
  const read = makeBaseFeeHistory(c, { now: () => t });
  const good = await read();
  assert.equal(good.length, 7200);
  broken = true; t = 31 * 60_000;
  const again = await read();
  assert.equal(again, good, 'the stale norm is better than none');
  const before = c.calls.length;
  t += 60_000;
  await read();
  assert.equal(c.calls.length, before, 'it does not hammer a node that just failed');
  t += 6 * 60_000;
  broken = false;
  const fresh = await read();
  assert.equal(fresh.length, 7200);
});

test('an unreadable head is no history, not a thrown error', async () => {
  const c = { getBlockNumber: async () => { throw new Error('rpc down'); }, getFeeHistory: async () => ({}) };
  assert.equal(await makeBaseFeeHistory(c)(), null);
});
