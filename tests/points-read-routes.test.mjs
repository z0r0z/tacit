// The points service's two reads that go to a chain: /tasks/claim takes a limiter token for every five transactions it is asked about (and
// reads the chain's head once for all of them), and /claim reads what the distributor shows as claimed once per ten seconds per account.
//   node tests/points-read-routes.test.mjs
import assert from 'node:assert';
import { createTasks } from '../worker-relay/src/lib/points-tasks-service.js';
import { makeTokenBucket } from '../worker-relay/src/lib/token-bucket.js';
import { makeTtlCache } from '../worker-relay/src/lib/ttl-cache.js';

// the bucket: a call may take more than one token
{
  let t = 0;
  const allow = makeTokenBucket({ perMin: 6, burst: 6, now: () => t });
  assert.ok(allow('k', 5) && !allow('k', 2) && allow('k', 1) && !allow('k'), 'five tokens, then two do not fit, then one does');
  t += 10_000;                                           // a minute's six per minute: one more token
  assert.ok(allow('k') && !allow('k'), 'tokens come back with time');
  assert.ok(makeTokenBucket({ perMin: 1, burst: 1 })('a') === true, 'a call with no cost named takes one');
}

// /tasks/claim
{
  const calls = { tx: 0, receipt: 0, head: 0 };
  const client = {
    getChainId: async () => 1,
    getTransaction: async () => { calls.tx++; throw new Error('not found'); },
    getTransactionReceipt: async () => { calls.receipt++; throw new Error('not found'); },
    getBlockNumber: async () => { calls.head++; return 100n; },
  };
  const tasks = createTasks({ store: {}, cfg: { budgetWei: 1n, endSec: 4e9, claimsPerMin: 12, claimBurst: 6 }, jobs: [{ id: 'j', chainId: 1, steps: [{ id: 's', gas: 1 }] }], client, fundingInputs: async () => null, budgetFor: () => 0n, graceSecs: 0 });
  const hashes = (n, salt = 0) => Array.from({ length: n }, (_, i) => '0x' + (BigInt(i + 1 + salt * 100)).toString(16).padStart(64, '0'));
  const one = await tasks.claim({ txHashes: hashes(1) }, { client: 'a' });
  assert.equal(one.status, 200, 'one transaction is asked about as before');
  assert.deepEqual([calls.tx, calls.head], [1, 1]);
  calls.tx = calls.receipt = calls.head = 0;
  const big = await tasks.claim({ txHashes: hashes(25, 1) }, { client: 'b' });
  assert.equal(big.status, 200);
  assert.equal(calls.tx, 25, 'every hash is looked up');
  assert.equal(calls.head, 1, 'the chain head is read once for the request, not once per hash');
  const again = await tasks.claim({ txHashes: hashes(25, 2) }, { client: 'b' });
  assert.equal(again.status, 429, 'burst 6: 25 hashes cost five tokens, so a second of the same size does not fit');
  // before: each request took one token, so six of 25 hashes (450 reads) passed back to back
  let served = 0;
  for (let i = 4; i < 12; i++) { const r = await tasks.claim({ txHashes: hashes(25, i) }, { client: 'c' }); if (r.status === 200) served++; }
  assert.equal(served, 1, `25-hash requests from one client: one in a burst (${served} passed)`);
  const small = await tasks.claim({ txHashes: hashes(5, 9) }, { client: 'd' });
  assert.equal(small.status, 200, 'five hashes still cost one token');
  assert.equal((await tasks.claim({ txHashes: [] }, { client: 'e' })).status, 400);
}

// /claim: one read per account per ten seconds
{
  let t = 0, reads = 0;
  const cache = makeTtlCache({ ttlMs: 10_000, max: 3, now: () => t });
  const load = (v) => async () => { reads++; return v; };
  assert.equal(await cache.get('a', load(1n)), 1n);
  assert.equal(await cache.get('a', load(2n)), 1n, 'a second ask within the ten seconds is the first answer');
  assert.equal(reads, 1);
  const [x, y] = await Promise.all([cache.get('b', load(5n)), cache.get('b', load(6n))]);
  assert.deepEqual([x, y, reads], [5n, 5n, 2], 'two asks together share one read');
  t = 10_000;
  assert.equal(await cache.get('a', load(2n)), 2n, 'after ten seconds it is read again');
  await assert.rejects(cache.get('c', async () => { throw new Error('rpc down'); }), /rpc down/);
  assert.equal(await cache.get('c', load(7n)), 7n, 'a read that failed is not kept');
  for (const k of ['d', 'e', 'f']) await cache.get(k, load(0n));
  assert.ok(cache.size <= 3, `at most max keys are kept (${cache.size})`);
}
console.log('points read routes: all passed');
