// The eth-state stage against the pool's counts: a pending candidate the pool has moved past is replaced at once, and no candidate is
// proved while the pool's latest counts are not final, for a bounded time. node --test tests/eth-state-counts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflightRecord, inflightCounts, makeCoverWait } from '../src/lib/eth-state-counts.js';
import { countsBehind } from '../src/lib/attest-counts.js';

const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const ethPv = (crossOuts, consumed) => '0x' + Array.from({ length: 14 }, (_, i) => (i === 4 ? w(crossOuts) : i === 10 ? w(consumed) : w(0xaa))).join('');

test('the in-flight record keeps the counts the candidate commits, and reads them back', () => {
  const rec = JSON.parse(JSON.stringify(inflightRecord({ contentHash: '0xd0fb', publishedAt: 1, ethPv: ethPv(17, 2) })));
  assert.deepEqual(rec, { contentHash: '0xd0fb', publishedAt: 1, counts: { crossOuts: '17', consumed: '2' } });
  assert.deepEqual(inflightCounts(rec), { crossOuts: 17n, consumed: 2n });
  assert.equal(inflightRecord({ contentHash: '0x1', ethPv: '0x12' }).counts, undefined, 'unreadable public values carry no counts');
});

test('a record without counts (or with garbage) is unknown, so the candidate is held as before', () => {
  assert.equal(inflightCounts({ contentHash: '0x1', publishedAt: 1 }), null);
  assert.equal(inflightCounts({ counts: { crossOuts: 'x', consumed: '2' } }), null);
  assert.equal(inflightCounts(null), null);
  assert.equal(countsBehind(inflightCounts({ contentHash: '0x1' }), { crossOuts: 19n, consumed: 2n }), null);
});

test('the 07:57 candidate (17 cross-outs) is behind a pool at 19 and is replaced; one at 19 is held', () => {
  const live = { crossOuts: 19n, consumed: 2n };
  const behind = inflightRecord({ contentHash: '0x67e9', ethPv: ethPv(17, 2) });
  assert.equal(countsBehind(inflightCounts(behind), live), '17 cross-out(s)/2 consumed against the pool\'s 19/2');
  assert.equal(countsBehind(inflightCounts(inflightRecord({ contentHash: '0x126e', ethPv: ethPv(19, 2) })), live), null);
  assert.equal(countsBehind(inflightCounts(behind), null), null, 'an unreadable pool never clears a candidate');
});

test('the finality wait holds while the head is behind, goes at the bound, and starts over after', () => {
  let t = 0;
  const wait = makeCoverWait({ boundMs: 30 * 60_000, now: () => t });
  assert.equal(wait(null), false, 'covered: go');
  assert.equal(wait('17/2 against 19/2'), true, 'first sight: wait');
  t = 29 * 60_000;
  assert.equal(wait('17/2 against 19/2'), true, 'inside the bound: wait');
  t = 30 * 60_000;
  assert.equal(wait('18/2 against 19/2'), false, 'at the bound: go anyway');
  t = 31 * 60_000;
  assert.equal(wait('18/2 against 20/2'), true, 'the next episode gets its own bound');
  assert.equal(wait(null), false, 'covered again: go');
  t = 32 * 60_000;
  assert.equal(wait('19/2 against 20/2'), true, 'covering resets the clock');
});
