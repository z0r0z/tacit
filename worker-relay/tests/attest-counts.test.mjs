// The counts a reflection batch and a bought proof commit, against the pool's live ones: a batch behind them is not proved, a held proof
// behind them is let go. node --test tests/attest-counts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jobCounts, pvCounts, proofCounts, countsBehind } from '../src/lib/attest-counts.js';

const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
// The head of the proof the pool refused on 2026-11-05 (ConsumedCountStale): batch to 974642, 2 consumed, 11 cross-outs, 9 folded.
const REFUSED = '0x0000000000000000000000000000000000000000000000000000000000000020dd08c04038ade4f8db59aaffd89481f4b40e0e16e82410cbc9dda05ba25506a9da660aa7d7e7662212dd7945705df4b196bda8fcc99f60a49f9641a89892e5060d4b336d6f20dbd5ba59a2a8c1868d790a551fd3c349f3de9d2cdd2e88a34d5103e22e938848af141fa85c4755a2385502a69163c608cf0a87a6fe237aa28e1a00000000000000000000000000000000000000000000000000000000000edf32c9afd62586900165f6f0d53972be9d4e7355fe5817454ce1d37a058b5ea06531306b120e7c45141f9040e30a241525b6b5542b132c1501000000000000000000c1d5d94c67d7e8cb99f2f14db8a12be3656e326ad75500000000000000000000000000000000000000000000000000000ed1eabd231be41d93b719056f7febfc0000000000000000000000000000000000000000000000000000000000b656ba0000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000032000000000000000000000000000000000000000000000000000000000000003400000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000b0000000000000000000000000000000000000000000000000000000000000009';

const w = (n) => BigInt(n).toString(16).padStart(64, '0');
// An eth-state public values blob (14 words) with the cumulative cross-outs at word 4 and consumes at word 10.
const ethPv = (crossOuts, consumed) => '0x' + Array.from({ length: 14 }, (_, i) => (i === 4 ? w(crossOuts) : i === 10 ? w(consumed) : w(0xaa))).join('');

test('the refused proof reads as 11 cross-outs and 2 consumed, the pool\'s 14/2 is ahead of it', () => {
  const have = proofCounts(REFUSED, POOL);
  assert.deepEqual(have, { crossOuts: 11n, consumed: 2n });
  assert.equal(countsBehind(have, { crossOuts: 14n, consumed: 2n }), '11 cross-out(s)/2 consumed against the pool\'s 14/2');
  assert.equal(countsBehind(have, { crossOuts: 11n, consumed: 2n }), null, 'at the pool\'s counts it lands');
});

test('a proof that reflects another pool is checked on its folded cross-out count', () => {
  assert.deepEqual(proofCounts(REFUSED, '0x0000000000000000000000000000000000000001'), { crossOuts: 9n, consumed: 2n });
});

test('a real Mode-B prover input is read: the eth-state public values sit beside the modeB flag', () => {
  const input = JSON.parse(readFileSync(new URL('../../contracts/sp1/confidential/fixtures/reflection_modeb.json', import.meta.url), 'utf8'));
  assert.equal(input.modeB, 1);
  assert.deepEqual(jobCounts({ input }), { crossOuts: 1n, consumed: 1n });
  assert.equal(countsBehind(jobCounts({ input }), { crossOuts: 3n, consumed: 1n }), '1 cross-out(s)/1 consumed against the pool\'s 3/1');
});

test('a Mode-B job reads its counts from the eth-state public values; a forward job has none', () => {
  assert.deepEqual(jobCounts({ input: { modeB: 1, ethPv: ethPv(14, 2) } }), { crossOuts: 14n, consumed: 2n });
  assert.deepEqual(jobCounts({ input: { modeB: 1, ethPv: ethPv(11, 2).slice(2) } }), { crossOuts: 11n, consumed: 2n }, 'without 0x');
  assert.equal(jobCounts({ input: { modeB: 0, ethPv: ethPv(14, 2) } }), null, 'a forward batch');
  assert.equal(jobCounts({ input: {} }), null);
  assert.equal(jobCounts(null), null);
  assert.equal(jobCounts({ input: { modeB: 1, ethPv: '0x1234' } }), null, 'too short to hold them');
  assert.deepEqual(pvCounts(ethPv(19, 2)), { crossOuts: 19n, consumed: 2n });
});

test('a job behind the pool on either count is behind; an unknown side never stops the lane', () => {
  const live = { crossOuts: 14n, consumed: 2n };
  assert.match(countsBehind(jobCounts({ input: { modeB: 1, ethPv: ethPv(11, 2) } }), live), /^11 cross-out/);
  assert.match(countsBehind({ crossOuts: 14n, consumed: 1n }, live), /1 consumed/);
  assert.equal(countsBehind(jobCounts({ input: { modeB: 1, ethPv: ethPv(14, 2) } }), live), null);
  assert.equal(countsBehind(null, live), null);
  assert.equal(countsBehind({ crossOuts: 1n, consumed: 1n }, null), null);
});

test('short public values are not read', () => {
  assert.equal(proofCounts('0x' + '00'.repeat(64), POOL), null);
  assert.equal(proofCounts(null, POOL), null);
});
