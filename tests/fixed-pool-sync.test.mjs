// dapp/fixed-pool-sync.js with a stand-in chunk cache and node: the cache's files are checked against their
// digests, order and block ranges; the last stretch comes from the node, in pieces it can answer; a hole in the
// leaves is an error; and a cache that fails leaves the node to give the whole history.
//
// Run: node tests/fixed-pool-sync.test.mjs

import { register } from 'node:module';
// the page's modules import each other by site path ("/x.js?cb="); this maps those to dapp/
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const { readChunkCache, readTail, fixedPoolLeaves, readHistory, HISTORY_PAGE } = await import('../dapp/fixed-pool-sync.js');
import { keccak_256, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';

let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}: ${e.message}`); fail++; }
};
const eq = (a, b, what = '') => { if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`); };
const rejects = async (p, re) => {
  try { await p; } catch (e) { if (!re.test(e.message)) throw new Error(`wrong error: ${e.message}`); return; }
  throw new Error('did not throw');
};

const TOPIC = '0x' + bytesToHex(keccak_256(new TextEncoder().encode('Deposit(bytes32,uint32,uint256)')));
const POOL = { address: '0x8C4A04d872a6C1BE37964A21ba3a138525dFF50b', denomination: 10n ** 17n, deployBlock: 1000 };
const hex = (n, w = 64) => n.toString(16).padStart(w, '0');
const commit = (i) => '0x' + hex(BigInt(i + 1) * 7919n);
const line = (i, block, log) => JSON.stringify({
  contractAddress: POOL.address.toLowerCase(), eventTopic: TOPIC, topics: [TOPIC, commit(i)],
  data: '0x' + hex(BigInt(i)) + hex(1700000000n), blockNumber: '0x' + block.toString(16), logIndex: '0x' + log.toString(16),
});
const sha = (b) => '0x' + createHash('sha256').update(b).digest('hex');

// a cache with one pool stream: deposits 0..4 in blocks [1000, 1100)
function cache({ lines, from = 1000, to = 1100, tamper = false, address = POOL.address.toLowerCase(), missing = false } = {}) {
  const raw = Buffer.from(lines.join('\n') + '\n');
  const file = 'stream-hot.jsonl.gz';
  const manifest = {
    availableProtocols: {
      'tornado-cash-11155111-eth-0.1': {
        trackedAddresses: [address], trackedEventTopics: [TOPIC], chunks: [],
        hotHead: { fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), file, size: '0x1', digest: { type: 'sha256', data: sha(raw) } },
      },
    },
  };
  const served = gzipSync(tamper ? Buffer.concat([raw, Buffer.from('\n')]) : raw);
  const fetchImpl = async (url) => {
    if (url.endsWith('/index.json')) return { ok: true, json: async () => manifest };
    if (url.endsWith(file) && !missing) return { ok: true, arrayBuffer: async () => served.buffer.slice(served.byteOffset, served.byteOffset + served.length) };
    return { ok: false };
  };
  return fetchImpl;
}
const fiveLines = () => [0, 1, 2, 3, 4].map((i) => line(i, 1000 + i * 10, 0));
const logOf = (i, block) => ({ topics: [TOPIC, commit(i)], data: '0x' + hex(BigInt(i)) + hex(1n), blockNumber: '0x' + block.toString(16) });
const node = (logs, { maxSpan = Infinity } = {}) => ({
  calls: [],
  getLogs: async function (f) {
    const a = Number(BigInt(f.fromBlock)), b = Number(BigInt(f.toBlock));
    this.calls.push([a, b]);
    if (b - a + 1 > maxSpan) throw new Error('range too large');
    return logs.filter((l) => Number(BigInt(l.blockNumber)) >= a && Number(BigInt(l.blockNumber)) <= b);
  },
});
const leafHex = (r, i) => bytesToHex(r.bytes.subarray(i * 32, i * 32 + 32));

console.log('cache');
await test('reads the deposits and where it stops', async () => {
  const r = await readChunkCache({ base: 'http://c', chainId: 11155111, denomination: '0.1', address: POOL.address, fetchImpl: cache({ lines: fiveLines() }) });
  eq(r.deposits.length, 5); eq(r.upTo, 1100); eq(r.deposits[3].index, 3); eq(r.deposits[3].commitment, commit(3));
});
await test('other events in the file are skipped', async () => {
  const lines = [...fiveLines(), JSON.stringify({ contractAddress: POOL.address, eventTopic: '0x' + '11'.repeat(32), topics: ['0x' + '11'.repeat(32)], data: '0x', blockNumber: '0x41a', logIndex: '0x0' })];
  const r = await readChunkCache({ base: 'http://c', chainId: 11155111, denomination: '0.1', address: POOL.address, fetchImpl: cache({ lines }) });
  eq(r.deposits.length, 5);
});
await test('a file that does not match its digest is refused', async () => {
  await rejects(readChunkCache({ base: 'http://c', chainId: 11155111, denomination: '0.1', address: POOL.address, fetchImpl: cache({ lines: fiveLines(), tamper: true }) }), /digest/);
});
await test('events out of order are refused', async () => {
  const lines = [line(0, 1010, 0), line(1, 1005, 0)];
  await rejects(readChunkCache({ base: 'http://c', chainId: 11155111, denomination: '0.1', address: POOL.address, fetchImpl: cache({ lines }) }), /out of order/);
});
await test('an event outside its file\'s blocks is refused', async () => {
  await rejects(readChunkCache({ base: 'http://c', chainId: 11155111, denomination: '0.1', address: POOL.address, fetchImpl: cache({ lines: [line(0, 1200, 0)] }) }), /outside/);
});
await test('a stream that tracks another address is refused', async () => {
  await rejects(readChunkCache({ base: 'http://c', chainId: 11155111, denomination: '0.1', address: POOL.address, fetchImpl: cache({ lines: fiveLines(), address: '0x' + '22'.repeat(20) }) }), /another address/);
});
await test('a stream the cache lacks is refused', async () => {
  await rejects(readChunkCache({ base: 'http://c', chainId: 11155111, denomination: '10', address: POOL.address, fetchImpl: cache({ lines: fiveLines() }) }), /no stream/);
});

console.log('node');
await test('a piece the node will not answer is halved until it will', async () => {
  const n = node([logOf(5, 1105), logOf(6, 1190)], { maxSpan: 10 });
  const out = await readTail({ getLogs: n.getLogs.bind(n), address: POOL.address, from: 1100, to: 1200, piece: 50 });
  eq(out.length, 2);
  if (!n.calls.every(([a, b], i) => i < 2 || b - a + 1 <= 50)) throw new Error('did not narrow');
});
await test('a node that always refuses is an error, not a short list', async () => {
  const n = node([], { maxSpan: 0 });
  await rejects(readTail({ getLogs: n.getLogs.bind(n), address: POOL.address, from: 1100, to: 1105, piece: 5 }), /too large/);
});

console.log('leaves');
const tail = [logOf(5, 1105), logOf(6, 1150)];
await test('the cache and the node together give every leaf in order', async () => {
  const n = node(tail);
  const r = await fixedPoolLeaves({ chainId: 11155111, pool: POOL, getLogs: n.getLogs.bind(n), blockNumber: async () => 1200, base: 'http://c', fetchImpl: cache({ lines: fiveLines() }) });
  eq(r.count, 7);
  for (let i = 0; i < 7; i++) eq('0x' + leafHex(r, i), commit(i), `leaf ${i}`);
  eq(n.calls[0][0], 1100, 'the node is asked from where the cache stops');
});
await test('a deposit both sources hold counts once', async () => {
  const n = node([logOf(4, 1099), ...tail]);
  const r = await fixedPoolLeaves({ chainId: 11155111, pool: POOL, getLogs: n.getLogs.bind(n), blockNumber: async () => 1200, base: 'http://c', fetchImpl: cache({ lines: fiveLines() }) });
  eq(r.count, 7);
});
await test('a hole in the leaves is an error', async () => {
  const n = node([logOf(6, 1150)]);
  await rejects(fixedPoolLeaves({ chainId: 11155111, pool: POOL, getLogs: n.getLogs.bind(n), blockNumber: async () => 1200, base: 'http://c', fetchImpl: cache({ lines: fiveLines() }) }), /leaf 5 is missing/);
});
await test('a failing cache leaves the node to give the whole history', async () => {
  const all = [0, 1, 2, 3, 4].map((i) => logOf(i, 1000 + i * 10)).concat(tail);
  const n = node(all); const notes = [];
  const r = await fixedPoolLeaves({ chainId: 11155111, pool: POOL, getLogs: n.getLogs.bind(n), blockNumber: async () => 1200, base: 'http://c', fetchImpl: cache({ lines: fiveLines(), tamper: true }), onProgress: (p) => p.note && notes.push(p.note) });
  eq(r.count, 7); eq(n.calls[0][0], POOL.deployBlock, 'from the pool\'s first block'); eq(notes.length, 1);
});
await test('no cache for the chain: the node alone', async () => {
  const all = [0, 1, 2].map((i) => logOf(i, 1000 + i));
  const n = node(all);
  const r = await fixedPoolLeaves({ chainId: 8453, pool: POOL, getLogs: n.getLogs.bind(n), blockNumber: async () => 1200 });
  eq(r.count, 3);
});

console.log('the gateway\'s history');
// a history of `total` leaves served as the gateway serves it: pages of at most HISTORY_PAGE, with the total and where it ends on each
const leafBytes = (i) => Buffer.from(commit(i).slice(2), 'hex');
const historyOf = (total, { upTo = 1100, bad = null } = {}) => async ({ from, n: want }) => {
  const count = Math.max(0, Math.min(want, HISTORY_PAGE, total - from)), buf = Buffer.concat(Array.from({ length: count }, (_, k) => leafBytes(from + k)));
  return { total, upTo, from, n: count + (bad === 'size' ? 1 : 0), leaves: buf.toString('base64') };
};
await test('a history of more than one page is read page by page into the deposits, with where it ends', async () => {
  const total = HISTORY_PAGE + 5, steps = [];
  const r = await readHistory({ history: historyOf(total), pool: POOL, onProgress: (p) => steps.push(p.done + '/' + p.of) });
  eq(r.deposits.length, total); eq(r.upTo, 1100); eq(r.deposits[HISTORY_PAGE + 2].index, HISTORY_PAGE + 2); eq(r.deposits[HISTORY_PAGE + 2].commitment, commit(HISTORY_PAGE + 2));
  eq(steps.join(','), '1/2,2/2');
});
await test('a page that is the wrong size, a missing page and a history that is not ready are refused', async () => {
  await rejects(readHistory({ history: historyOf(5, { bad: 'size' }), pool: POOL }), /wrong/);
  await rejects(readHistory({ history: async () => null, pool: POOL }), /not ready/);
  let calls = 0;
  await rejects(readHistory({ history: async (q) => (calls++ ? null : historyOf(HISTORY_PAGE + 5)(q)), pool: POOL }), /missing/);
});
await test('the read takes the gateway\'s history first and does not ask the published cache or the chain for what it holds; the node gives only the last stretch', async () => {
  const n = node([logOf(5, 1150)]);
  const r = await fixedPoolLeaves({ chainId: 11155111, pool: POOL, getLogs: n.getLogs.bind(n), blockNumber: async () => 1200, base: 'http://c', fetchImpl: async () => { throw new Error('the cache was asked'); }, history: historyOf(5) });
  eq(r.count, 6); eq(leafHex(r, 4), commit(4).slice(2)); eq(leafHex(r, 5), commit(5).slice(2));
  eq(n.calls[0][0], 1100, 'the node was asked from where the history ends');
});
await test('a history that is not ready, or fails, leaves the published cache to give it, and then the chain', async () => {
  const n = node([logOf(5, 1150)]);
  const viaCache = await fixedPoolLeaves({ chainId: 11155111, pool: POOL, getLogs: n.getLogs.bind(n), blockNumber: async () => 1200, base: 'http://c', fetchImpl: cache({ lines: fiveLines() }), history: async () => null });
  eq(viaCache.count, 6);
  const all = [0, 1, 2, 3].map((i) => logOf(i, 1000 + i)), n2 = node(all);
  const viaChain = await fixedPoolLeaves({ chainId: 11155111, pool: POOL, getLogs: n2.getLogs.bind(n2), blockNumber: async () => 1200, base: null, history: async () => { throw new Error('down'); } });
  eq(viaChain.count, 4);
});
await test('a history with a hole is an error marked as not to be trusted (the flow then reads from the chain)', async () => {
  const n = node([logOf(7, 1150)]);
  let err = null;
  try { await fixedPoolLeaves({ chainId: 11155111, pool: POOL, getLogs: n.getLogs.bind(n), blockNumber: async () => 1200, base: null, history: historyOf(5) }); } catch (e) { err = e; }
  eq(/leaf 5 is missing/.test(err?.message || ''), true, 'the error'); eq(err.untrusted, true, 'marked');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
