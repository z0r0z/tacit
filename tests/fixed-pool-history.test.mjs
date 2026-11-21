// The gateway's fixed-pool history (worker-relay/src/lib/fixed-pool-history.js): leaves in order from the chain's logs, seeded once from the published cache, kept current, and
// served in pages; a gap drops the history and it is read again; the pools are the ones the page uses.
//
// Run: node tests/fixed-pool-history.test.mjs

import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const { makePoolHistory, POOLS, PAGE } = await import('../worker-relay/src/lib/fixed-pool-history.js');
const { FIXED_POOLS } = await import('../dapp/fixed-pool-notes.js');
import { keccak_256, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';

let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`); };

const TOPIC = '0x' + bytesToHex(keccak_256(new TextEncoder().encode('Deposit(bytes32,uint32,uint256)')));
const POOL = POOLS[1][0];                                         // the 0.1 ETH pool
const hex = (n, w = 64) => n.toString(16).padStart(w, '0');
const commit = (i) => '0x' + hex(BigInt(i + 1) * 7919n);
const log = (i, block) => ({ address: POOL.address.toLowerCase(), topics: [TOPIC, commit(i)], data: '0x' + hex(BigInt(i)) + hex(1700000000n), blockNumber: '0x' + block.toString(16), logIndex: '0x0' });
const B0 = POOL.deployBlock;

// a chain that has deposits 0..n-1, deposit i in block B0 + 10 + 10 * i, and a head at `tip`; `drop` hides one index (a node that lost a log)
function chain({ n, tip = B0 + 100 + 10 * n, drop = null, late = Infinity } = {}) {
  const calls = { logs: 0 };
  const request = async (method, params) => {
    if (method === 'eth_blockNumber') return '0x' + tip.toString(16);
    if (method === 'eth_getLogs') {
      calls.logs++;
      const f = params[0], a = Number(BigInt(f.fromBlock)), b = Number(BigInt(f.toBlock));
      return Array.from({ length: n }, (_, i) => ({ i, block: i >= late ? B0 + 1000 + 10 * i : B0 + 10 + 10 * i })).filter((x) => x.i !== drop && x.block >= a && x.block <= b && f.address.toLowerCase() === POOL.address.toLowerCase()).map((x) => log(x.i, x.block));
    }
    throw new Error('unexpected ' + method);
  };
  return { request, calls, set n(v) { n = v; }, set tip(v) { tip = v; }, set drop(v) { drop = v; } };
}
const sha = (b) => '0x' + createHash('sha256').update(b).digest('hex');
// the published cache holding deposits 0..k-1 of this pool, covering blocks [B0, to)
function published(k, to) {
  const raw = Buffer.from(Array.from({ length: k }, (_, i) => JSON.stringify({ topics: [TOPIC, commit(i)], data: '0x' + hex(BigInt(i)) + hex(1700000000n), blockNumber: '0x' + (B0 + 10 + 10 * i).toString(16), logIndex: '0x0' })).join('\n') + '\n');
  const file = 'hot.jsonl.gz', served = gzipSync(raw);
  const manifest = { availableProtocols: { 'tornado-cash-1-eth-0.1': { trackedAddresses: [POOL.address.toLowerCase()], trackedEventTopics: [TOPIC], chunks: [], hotHead: { fromBlock: '0x' + B0.toString(16), toBlock: '0x' + to.toString(16), file, size: '0x1', digest: { type: 'sha256', data: sha(raw) } } } } };
  return async (url) => (url.endsWith('/index.json') ? { ok: true, json: async () => manifest } : url.endsWith(file) ? { ok: true, arrayBuffer: async () => served.buffer.slice(served.byteOffset, served.byteOffset + served.length) } : { ok: false });
}
const leavesOf = (p) => Buffer.from(p.leaves, 'base64');
const leaf = (buf, i) => '0x' + buf.subarray(i * 32, i * 32 + 32).toString('hex');

console.log('the pools');
await test('are the page\'s pools: the same addresses, deploy blocks and sizes', () => {
  const mine = POOLS[1], theirs = FIXED_POOLS[1];
  eq(mine.length, theirs.length, 'how many');
  mine.forEach((p, i) => { eq(p.address, theirs[i].address, 'address'); eq(p.deployBlock, theirs[i].deployBlock, 'deploy block'); eq(String(Number(theirs[i].denomination / 10n ** 15n) / 1000), p.denomination, 'size'); });
});

console.log('read from the chain');
await test('with no seed the logs give every leaf in order, and a page returns them', async () => {
  const c = chain({ n: 5 });
  const h = makePoolHistory({ chainId: 1, request: c.request, seedBase: null, confirmations: 0 });
  const p = await h.page(POOL.address, 0, PAGE);
  eq(p.total, 5, 'total'); eq(p.n, 5, 'n'); eq(p.from, 0);
  const b = leavesOf(p);
  eq(b.length, 5 * 32, 'bytes');
  for (let i = 0; i < 5; i++) eq(leaf(b, i), commit(i), `leaf ${i}`);
  eq(p.upTo > B0 + 10 + 10 * 4, true, 'covers the last deposit');
});
await test('a page is cut to the asked range and never past PAGE or the end; an unknown pool is not served', async () => {
  const c = chain({ n: 5 });
  const h = makePoolHistory({ chainId: 1, request: c.request, seedBase: null, confirmations: 0 });
  const p = await h.page(POOL.address, 2, 2);
  eq(p.n, 2); eq(p.from, 2); eq(leaf(leavesOf(p), 0), commit(2));
  eq((await h.page(POOL.address, 4, 10)).n, 1, 'to the end');
  eq((await h.page(POOL.address, 99, 10)).n, 0, 'past the end');
  eq(await h.page('0x' + '11'.repeat(20), 0, 10), null, 'not a pool');
  eq(h.has('0x' + '11'.repeat(20)), false); eq(h.has(POOL.address), true);
});
await test('a deposit made later is added on the next refresh, and the held history is served while it is read', async () => {
  const c = chain({ n: 3, late: 3 });
  let t = 1_000_000;
  const h = makePoolHistory({ chainId: 1, request: c.request, seedBase: null, confirmations: 0, now: () => t, maxAgeMs: 20_000 });
  eq((await h.page(POOL.address, 0, PAGE)).total, 3);
  c.n = 5; c.tip = B0 + 2000;
  eq((await h.page(POOL.address, 0, PAGE)).total, 3, 'not yet: the history is recent');
  t += 30_000;
  await h.page(POOL.address, 0, PAGE);                                   // the stale history is served, a refresh starts
  await h.state(POOL.address).task;
  const p = await h.page(POOL.address, 0, PAGE);
  eq(p.total, 5, 'now'); eq(leaf(leavesOf(p), 4), commit(4));
});

console.log('seeded from the published cache');
await test('the seed gives the first leaves and the chain only the rest', async () => {
  const c = chain({ n: 6 });
  const h = makePoolHistory({ chainId: 1, request: c.request, seedFetch: published(4, B0 + 10 + 10 * 4), seedBase: 'https://cache.test', confirmations: 0 });
  const p = await h.page(POOL.address, 0, PAGE);
  eq(p.total, 6); for (let i = 0; i < 6; i++) eq(leaf(leavesOf(p), i), commit(i), `leaf ${i}`);
});
await test('a seed that fails or does not match leaves the chain to give the whole history', async () => {
  const c = chain({ n: 4 });
  const h = makePoolHistory({ chainId: 1, request: c.request, seedFetch: async () => { throw new Error('down'); }, seedBase: 'https://cache.test', confirmations: 0 });
  eq((await h.page(POOL.address, 0, PAGE)).total, 4);
});

console.log('a gap');
await test('a log a node lost is a gap: nothing is served from it, the history is dropped and read again', async () => {
  const c = chain({ n: 5, drop: 2 });
  const h = makePoolHistory({ chainId: 1, request: c.request, seedBase: null, confirmations: 0, waitMsDefault: 0 });
  eq(await h.page(POOL.address, 0, PAGE, { waitMs: 50 }), null, 'a history with a hole is not served');
  c.drop = null;
  await h.state(POOL.address).task;
  const p = await h.page(POOL.address, 0, PAGE, { waitMs: 50 }) || await (async () => { await h.ensure(POOL.address, { waitMs: 200 }); return h.page(POOL.address, 0, PAGE); })();
  eq(p.total, 5, 'whole once the node has every log'); eq(leaf(leavesOf(p), 2), commit(2));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
