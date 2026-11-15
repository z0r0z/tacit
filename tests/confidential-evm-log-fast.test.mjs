// The decoder's fast path (dapp/confidential-evm-log.js: fields cut out of the log's hex with slice) against its byte path (decodeLogSlow, what every
// log was read by before): the same event for every shape of log, valid, truncated, upper-case, unprefixed, odd or not hex. And decodeLogs reading a log
// object once however many times it is asked, handing each caller its own copy of the event.
//   node --test tests/confidential-evm-log-fast.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeConfidentialEvmLog } from '../dapp/confidential-evm-log.js';

const dec = makeConfidentialEvmLog({ keccak256: (b) => keccak_256(b) });
const T = dec.TOPIC0;
let seed = 0x9e3779b9;
const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const bytes = (n) => Array.from({ length: n }, () => rnd(256).toString(16).padStart(2, '0')).join('');
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const pad = (hex) => hex + '00'.repeat((32 - ((hex.length / 2) % 32)) % 32);
const b32s = (n) => Array.from({ length: n }, () => bytes(32));
const topicN = (n) => '0x' + w(n);

function encode(kind) {
  if (kind === 'LeavesInserted') {
    const leaves = b32s(rnd(7)), memos = Array.from({ length: leaves.length }, () => bytes(rnd(3) ? 169 : rnd(200)));
    const offLeaves = 64, offMemos = 64 + 32 + 32 * leaves.length;
    let tail = '';
    const offs = []; let at = 32 * memos.length;
    for (const m of memos) { offs.push(at); const body = w(m.length / 2) + pad(m); tail += body; at += body.length / 2; }
    return { topics: [T.LeavesInserted, topicN(rnd(100000))], data: '0x' + w(offLeaves) + w(offMemos) + w(leaves.length) + leaves.join('') + w(memos.length) + offs.map(w).join('') + tail };
  }
  if (kind === 'LockLeavesInserted') { const l = b32s(rnd(6)); return { topics: [T.LockLeavesInserted, topicN(rnd(1000))], data: '0x' + w(32) + w(l.length) + l.join('') }; }
  if (kind === 'NullifiersSpent') { const l = b32s(rnd(8)); return { topics: [T.NullifiersSpent], data: '0x' + w(32) + w(l.length) + l.join('') }; }
  if (kind === 'CrossOutRecorded') return { topics: [T.CrossOutRecorded, '0x' + bytes(32)], data: '0x' + w(rnd(70000)) + bytes(32) + bytes(32) + bytes(32) };
  if (kind === 'Wrap') return { topics: [T.Wrap, '0x' + bytes(32), '0x' + bytes(32)], data: '0x' + w(BigInt(rnd(2 ** 31)) * BigInt(rnd(2 ** 31))) };
  if (kind === 'Bonded') return { topics: [T.Bonded, '0x' + bytes(32), topicN(rnd(50))], data: '0x' + w(BigInt(rnd(2 ** 31)) * 1000003n) + w(1_700_000_000 + rnd(1e6)) };
  if (kind === 'Harvested') return { topics: [T.Harvested, '0x' + bytes(32), topicN(rnd(50))], data: '0x' + w(rnd(2 ** 31)) };
  return { topics: [T.CdpPositionInserted, '0x' + bytes(32)], data: '0x' };
}
const KINDS = ['LeavesInserted', 'LockLeavesInserted', 'NullifiersSpent', 'CrossOutRecorded', 'Wrap', 'Bonded', 'Harvested', 'CdpPositionInserted'];
const same = (log, what) => assert.deepStrictEqual(dec.decodeLog(log), dec.decodeLogSlow(log), what);

test('the fast path reads every kind of log as the byte path does', () => {
  for (let i = 0; i < 400; i++) { const kind = KINDS[rnd(KINDS.length)]; same(encode(kind), `${kind} #${i}`); }
});

test('and a log that is not plain hex, or not whole bytes, or cut short, is read the same', () => {
  for (let i = 0; i < 400; i++) {
    const log = encode(KINDS[rnd(KINDS.length)]);
    const d = log.data.slice(2);
    same({ ...log, data: log.data.toUpperCase().replace('0X', '0x') }, 'upper-case hex');
    same({ ...log, data: d }, 'no 0x');
    same({ ...log, data: log.data + 'a' }, 'an odd number of digits');
    same({ ...log, data: log.data.slice(0, 2 + 2 * rnd(d.length / 2 + 1)) }, 'cut at a byte');
    same({ ...log, data: log.data.slice(0, 2 + rnd(d.length + 1)) }, 'cut anywhere');
    if (d.length > 8) same({ ...log, data: '0x' + d.slice(0, 6) + 'zz' + d.slice(8) }, 'a digit that is not hex');
  }
  for (const data of ['', '0x', null, undefined, 0, '0X00', '0x00']) for (const kind of ['Wrap', 'Bonded', 'CdpPositionInserted', 'CrossOutRecorded']) same({ ...encode(kind), data }, `${kind} with data ${JSON.stringify(data)}`);
  assert.strictEqual(dec.decodeLog({ topics: [] }), null);
  assert.strictEqual(dec.decodeLog({ topics: ['0x' + '11'.repeat(32)], data: '0x00' }), null, 'a log that is not the pool\'s');
});

test('decodeLogs reads a log object once, and hands each caller its own copy of the event', () => {
  let reads = 0;
  const log = encode('LeavesInserted');
  const counted = { topics: log.topics, get data() { reads++; return log.data; }, transactionHash: '0xabc', blockNumber: '0x10', logIndex: 3 };
  const foreign = { topics: ['0x' + '22'.repeat(32)], get data() { reads++; return '0x'; } };
  const a = dec.decodeLogs([counted, foreign]), b = dec.decodeLogs([counted, foreign]), c = dec.decodeLogs([foreign, counted]);
  assert.strictEqual(reads, 1, 'the pool\'s log is read once however many times it is asked for, and a foreign one is never read at all');
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.length, 1, 'the foreign log is dropped every time');
  assert.strictEqual(c.length, 1);
  assert.deepStrictEqual([a[0].txHash, a[0].blockNumber, a[0].logIndex], ['0xabc', 16, 3], 'with where it came from');
  a[0].txHash = 'changed'; a[0].type = 'x';
  assert.strictEqual(b[0].txHash, '0xabc', 'a field set on one caller\'s event is not set on the next');
  assert.strictEqual(dec.decodeLogs([counted])[0].type, 'LeavesInserted');
  assert.deepStrictEqual(dec.decodeLogs(null), []);
});

test('the same decode as before for a whole history, and faster', () => {
  const logs = Array.from({ length: 3000 }, () => encode('LeavesInserted'));
  logs.push(...Array.from({ length: 600 }, () => encode('NullifiersSpent')));
  const t0 = performance.now(); const slow = logs.map((l) => dec.decodeLogSlow(l)); const tSlow = performance.now() - t0;
  const fresh = makeConfidentialEvmLog({ keccak256: (b) => keccak_256(b) });
  const t1 = performance.now(); const fast = logs.map((l) => fresh.decodeLog(l)); const tFast = performance.now() - t1;
  assert.deepStrictEqual(fast, slow);
  const mb = logs.reduce((s, l) => s + l.data.length, 0) / 1e6;
  console.log(`  ${logs.length} logs, ${mb.toFixed(1)} MB of hex: bytes ${tSlow.toFixed(0)} ms, slices ${tFast.toFixed(0)} ms (${(tSlow / tFast).toFixed(1)}x)`);
  assert.ok(tFast < tSlow, 'the fast path is the faster');
});
