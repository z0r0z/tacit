// The settle relay's check of a swap's or an add's pinned reserves before it is proved (src/lib/reserves-precheck.js), and where settle-relay.js calls it.
//   node worker-relay/tests/reserves-precheck.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256, hexToBytes } from 'viem';
import { poolMovedAck, poolIdOf, pinsOf, poolIdsOf, splitByPool, POOL_RESERVE_MISMATCH } from '../src/lib/reserves-precheck.js';
import { makeConfidentialRoute } from '../../dapp/confidential-route.js';

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const ETH = '0x3cba71e111' + '11'.repeat(27), TAC = '0xf0bbe868af' + '22'.repeat(27), USD = '0x8f4490dd37' + '33'.repeat(27);   // three 32-byte asset ids
const dappPoolId = makeConfidentialRoute({ keccak256: (b) => hexToBytes(keccak256(b)), pool: {} }).poolId;

// A pool contract whose pools(id) answers from `table` (id -> [reserveA, reserveB, totalShares]); `reads` records each id asked, `fail` makes every read throw.
const chain = (table, reads = [], fail = null) => ({
  readContract: async ({ address, functionName, args }) => {
    assert.equal(address, POOL); assert.equal(functionName, 'pools');
    reads.push(args[0]);
    if (fail) throw fail;
    const r = table[args[0]];
    return r ? [true, ETH, TAC, r[0], r[1], 30, r[2] ?? 0n] : [false, '0x' + '00'.repeat(32), '0x' + '00'.repeat(32), 0n, 0n, 0, 0n];
  },
});
const sleeps = [];
const ctx = (client, extra = {}) => ({ client, pool: POOL, lookAgainMs: [3000, 3000], sleep: async (ms) => { sleeps.push(ms); }, ...extra });
const ack = (j, c, extra) => { sleeps.length = 0; return poolMovedAck(j, ctx(c, extra)); };

const ETH_TAC = poolIdOf(ETH, TAC, 30), TAC_USD = poolIdOf(TAC, USD, 5);
const route = (hops, over = {}) => ({ type: 'route', op: { asset0: ETH, hops, ...over } });
const hop = (assetNext, feeBps, a, b) => ({ assetNext, feeBps, reserveAPre: String(a), reserveBPre: String(b) });
const swap = (over = {}) => ({ type: 'wrapswap', op: { assetA: ETH, assetB: TAC, feeBps: 30, protocolFeeBps: 0, reserveAPre: '1000', reserveBPre: '5000', direction: 0, ...over } });
const add = (over = {}) => ({ type: 'wraplp', op: { assetA: ETH, assetB: TAC, feeBps: 30, protocolFeeBps: 0, reserveAPre: '1000', reserveBPre: '5000', sharesPre: '300', ...over } });

await test('a pool id is the one the page derives, whichever way round the pair is given', () => {
  for (const [x, y, f] of [[ETH, TAC, 30], [TAC, ETH, 30], [ETH, USD, 5], [USD, TAC, 100], [TAC, USD, 1]]) assert.equal(poolIdOf(x, y, f), dappPoolId(x, y, f), `${x.slice(0, 8)} ${y.slice(0, 8)} ${f}`);
});

await test('a swap on the reserves the pool holds is proved, and the pool read is the hop\'s own', async () => {
  const reads = [];
  assert.equal(await ack(route([hop(TAC, 30, 1000, 5000)]), chain({ [ETH_TAC]: [1000n, 5000n] }, reads)), null);
  assert.deepEqual(reads, [ETH_TAC]);
  assert.deepEqual(sleeps, [], 'nothing to wait for');
});

await test('a swap built on older reserves is not proved: the ack names the revert and says nothing was spent', async () => {
  const why = await ack(route([hop(TAC, 30, 1000, 5000)]), chain({ [ETH_TAC]: [1000n, 4900n] }));
  assert.match(why, /^swap not proved: the pool moved after this was built/);
  assert.match(why, /nothing was spent/);
  assert.ok(why.endsWith(`(${POOL_RESERVE_MISMATCH})`), 'the selector ends the ack, where the pages read it');
  assert.equal(POOL_RESERVE_MISMATCH, '0x29b3c833');
});

await test('a mismatch is read again, twice, before it is believed', async () => {
  const reads = [];
  assert.match(await ack(route([hop(TAC, 30, 1000, 5000)]), chain({ [ETH_TAC]: [1000n, 4900n] }, reads)), /not proved/);
  assert.equal(reads.length, 3, 'one reading and two looks again');
  assert.deepEqual(sleeps, [3000, 3000]);
});

await test('a node a block behind the page that built the op: the second reading agrees, so the job is proved', async () => {
  const reads = [], table = { [ETH_TAC]: [999n, 5001n] };
  const c = { readContract: async (a) => { const r = await chain(table, reads).readContract(a); if (reads.length === 1) table[ETH_TAC] = [1000n, 5000n]; return r; } };
  assert.equal(await ack(route([hop(TAC, 30, 1000, 5000)]), c), null);
  assert.deepEqual(sleeps, [3000], 'it waited once');
});

await test('a two-hop route is held to both pools: the second moving is enough', async () => {
  const reads = [], table = { [ETH_TAC]: [1000n, 5000n], [TAC_USD]: [7000n, 8000n] };
  const j = route([hop(TAC, 30, 1000, 5000), hop(USD, 5, 7000, 8000)]);
  assert.equal(await ack(j, chain(table, reads)), null);
  assert.deepEqual(reads, [ETH_TAC, TAC_USD], 'each hop\'s pool, in route order');
  table[TAC_USD] = [7000n, 8001n];
  assert.match(await ack(j, chain(table)), /^swap not proved/);
});

await test('a route through one pool twice is let through: its second hop binds the first hop\'s result', async () => {
  const reads = [];
  assert.equal(await ack(route([hop(TAC, 30, 1000, 5000), hop(ETH, 30, 1100, 4600)]), chain({ [ETH_TAC]: [1, 1] }, reads)), null);
  assert.deepEqual(reads, [], 'the chain was not read');
});

await test('a wrap-swap is held to its pool\'s reserves', async () => {
  const table = { [ETH_TAC]: [1000n, 5000n] };
  assert.equal(await ack(swap(), chain(table)), null);
  table[ETH_TAC] = [1000n, 5100n];
  assert.match(await ack(swap(), chain(table)), /^swap not proved/);
});

await test('a liquidity add is held to its reserves and its share total, in words that say it is an add', async () => {
  const table = { [ETH_TAC]: [1000n, 5000n, 300n] };
  assert.equal(await ack(add(), chain(table)), null);
  table[ETH_TAC] = [1000n, 5000n, 301n];
  assert.match(await ack(add(), chain(table)), /^liquidity add not proved: the pool moved/);
});

await test('the first add into a pool nobody has funded matches an empty pool', async () => {
  assert.equal(await ack(add({ reserveAPre: '0', reserveBPre: '0', sharesPre: '0' }), chain({})), null);
});

await test('a swap does not look at the share total, only an add does', async () => {
  assert.equal(await ack(swap(), chain({ [ETH_TAC]: [1000n, 5000n, 999999n] })), null);
});

await test('a pool with a protocol fee has another id, so it is let through unread', async () => {
  const reads = [];
  assert.equal(await ack(swap({ protocolFeeBps: 5 }), chain({ [ETH_TAC]: [1n, 1n] }, reads)), null);
  assert.deepEqual(reads, []);
});

await test('other ops are never looked at, the removal of liquidity among them (it settles against the live reserves)', async () => {
  for (const type of ['transfer', 'unwrap', 'lpremove', 'lp_remove', 'swap', 'lpbond', 'cbtcmint']) {
    const reads = [];
    assert.equal(await ack({ type, op: { assetA: ETH, assetB: TAC, feeBps: 30, reserveAPre: '1', reserveBPre: '1', sharesPre: '1' } }, chain({}, reads)), null, type);
    assert.deepEqual(reads, [], type);
  }
});

await test('anything unreadable lets the job through: a failing node, a missing field, no op', async () => {
  assert.equal(await ack(route([hop(TAC, 30, 1000, 5000)]), chain({}, [], new Error('429'))), null);
  assert.equal(await ack(swap({ reserveAPre: undefined }), chain({ [ETH_TAC]: [1n, 1n] })), null);
  assert.equal(await ack(route([]), chain({})), null);
  assert.equal(await ack({ type: 'route' }, chain({})), null);
  assert.equal(pinsOf({ type: 'wrapswap', op: null }), null);
});

await test('reserves given as numbers or decimal strings read the same', async () => {
  assert.equal(await ack(route([{ assetNext: TAC, feeBps: '30', reserveAPre: 1000, reserveBPre: '5000' }]), chain({ [ETH_TAC]: [1000n, 5000n] })), null);
});

// Where settle-relay.js calls it: after the consumed-input check at all three places a job can be proved, so a job that already landed (which moved the pool
// itself) is acked settled, not failed as moved; and the batch member that a refused batch sends to settleOne is checked after the one before it settled.
await test('settle-relay.js checks every job it is about to prove, after the consumed-input check', () => {
  const src = readFileSync(new URL('../src/settle-relay.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ poolMovedAck(, splitByPool)? \} from '\.\/lib\/reserves-precheck\.js';/);
  const fn = src.slice(src.indexOf('async function skipMovedPool('), src.indexOf('async function settleOne('));
  assert.match(fn, /poolMovedAck\(job, \{ client: publicClient, pool: POOL \}\)/);
  assert.match(fn, /confidentialAck\(\{ jobId: job\.jobId, error \}\)/, 'the ack carries the lib\'s text as it is, selector and all');
  const lines = src.split('\n'), at = lines.map((l, i) => (/await skipMovedPool\(/.test(l) ? i : -1)).filter((i) => i >= 0);
  assert.equal(at.length, 3, 'the single path, the batch path and the batch member\'s own path');
  for (const i of at) {
    const l = lines[i], here = l.indexOf('skipConsumed(');
    // on the same line, ahead of it, or (the batch path) on the line just above it
    assert.ok(here !== -1 ? here < l.indexOf('skipMovedPool(') : /await skipConsumed\(/.test(lines[i - 1]), `skipConsumed comes first: ${l.trim()}`);
  }
  assert.ok(at.some((i) => /mode !== 'preproven'/.test(lines[i])), 'a proof that already exists (preproven) is not checked: the settle simulation covers it');
});

// A refusal of a swap the pool moved under comes back in about two seconds, not seven: one look again, 2 s on, where it was two looks 3 s apart.
await test('the default is one look again, two seconds on', async () => {
  const reads = [], slept = [];
  const c = chain({ [ETH_TAC]: [1000n, 4900n] }, reads);
  const why = await poolMovedAck(route([hop(TAC, 30, 1000, 5000)]), { client: c, pool: POOL, sleep: async (ms) => { slept.push(ms); } });
  assert.match(why, /^swap not proved/);
  assert.deepEqual(slept, [2000]);
  assert.equal(reads.length, 2, 'the reading and the one look again');
});

// Jobs claimed together that pin the same pool cannot settle in one batch (the second's reserves are the first's result): the first stays, the rest follow on their own.
const J = (id, over) => ({ jobId: id, ...over });
const POOL_A = ETH_TAC;
await test('the pools a job pins, by id; none for a job that pins none or does not parse', () => {
  assert.deepEqual(poolIdsOf(J('r', route([hop(TAC, 30, 1, 1)]))), [ETH_TAC]);
  assert.deepEqual(poolIdsOf(J('r2', route([hop(TAC, 30, 1, 1), hop(USD, 5, 1, 1)]))), [ETH_TAC, TAC_USD], 'a two-hop route pins both, in order');
  assert.deepEqual(poolIdsOf(J('w', swap())), [ETH_TAC]);
  for (const j of [J('t', { type: 'transfer', op: {} }), J('u', { type: 'unwrap', op: {} }), J('l', { type: 'lpremove', op: { assetA: ETH, assetB: TAC, feeBps: 30 } }), J('x', { type: 'route' }), J('y', { type: 'wrapswap', op: { reserveAPre: undefined } }), J('z', null), J('p', swap({ protocolFeeBps: 5 }))])
    assert.deepEqual(poolIdsOf(j), [], String(j?.jobId));
});

await test('two jobs on the same pool: the first stays in the batch, the second waits to settle on its own', () => {
  const a = J('a', route([hop(TAC, 30, 1, 1)])), b = J('b', route([hop(TAC, 30, 2, 2)]));
  const { keep, later } = splitByPool([a, b]);
  assert.deepEqual(keep.map((j) => j.jobId), ['a']);
  assert.deepEqual(later.map((j) => j.jobId), ['b']);
});

await test('jobs on different pools all stay, in order; a wrap-swap and a route on one pool are the same pool', () => {
  const r1 = J('r1', route([hop(TAC, 30, 1, 1)])), r2 = J('r2', route([hop(USD, 30, 1, 1)]));       // ETH/TAC and ETH/USD: two pools
  const w = J('w', swap());                                   // the ETH/TAC pool, like r1
  const { keep, later } = splitByPool([r1, r2, w]);
  assert.deepEqual(keep.map((j) => j.jobId), ['r1', 'r2']);
  assert.deepEqual(later.map((j) => j.jobId), ['w']);
});

await test('a two-hop route holds back any later job that touches either of its pools, and three on one pool leave two waiting, in order', () => {
  const two = J('two', route([hop(TAC, 30, 1, 1), hop(USD, 5, 1, 1)])), onSecond = J('onSecond', { type: 'route', op: { asset0: TAC, hops: [hop(USD, 5, 1, 1)] } });
  assert.deepEqual(splitByPool([two, onSecond]).later.map((j) => j.jobId), ['onSecond'], 'the second hop\'s pool is shared');
  const a = J('a', swap()), b = J('b', swap({ reserveAPre: '9' })), c = J('c', add());
  const { keep, later } = splitByPool([a, b, c]);
  assert.deepEqual(keep.map((j) => j.jobId), ['a']);
  assert.deepEqual(later.map((j) => j.jobId), ['b', 'c'], 'the order they came in');
});

await test('jobs that pin no pool are never held back for another\'s sake, however many there are', () => {
  const jobs = [J('t1', { type: 'transfer', op: {} }), J('t2', { type: 'transfer', op: {} }), J('u', { type: 'unwrap', op: {} }), J('bad', { type: 'route' }), J('bad2', { type: 'route' })];
  const { keep, later } = splitByPool(jobs);
  assert.equal(keep.length, 5); assert.equal(later.length, 0);
  assert.deepEqual(splitByPool([]), { keep: [], later: [] });
});

await test('settle-relay.js groups a claimed batch by pool before it decides what to prove, and settles the ones held back on their own afterwards', () => {
  const src = readFileSync(new URL('../src/settle-relay.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function batchCycle('), src.indexOf('async function batchCycle(') + 9000);
  const grouped = fn.indexOf('splitByPool(jobs)'), single = fn.indexOf('jobs.length === 1'), tail = fn.indexOf('for (const j of later) await settleOne(j)');
  assert.ok(grouped > 0, 'the batch is grouped by pool');
  assert.match(fn.slice(grouped, grouped + 200), /jobs = byPool\.keep;[\s\S]*later\.push\(\.\.\.byPool\.later\)/, 'the first of each pool stays and the rest join the ones held back');
  assert.ok(single > grouped, 'the grouping comes before the lone-job shortcut and the batch proof');
  assert.ok(tail > single, 'the ones held back are settled on their own after the batch, whatever happened to it');
});

console.log(`${n} reserves-precheck checks passed`);
