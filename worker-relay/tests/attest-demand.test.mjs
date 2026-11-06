// Whether someone waits on the next attest: a bonded cBTC lock old enough to fold, or cross-outs and consumes the pool recorded past the
// last landed batch. node --test tests/attest-demand.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { noteLockDemand, noteFoldedCounts, attestDemand, resetAttestDemand } from '../src/lib/attest-demand.js';

const live = { crossOuts: 19n, consumed: 2n };

test('nothing noted, nothing waiting', () => {
  resetAttestDemand();
  assert.equal(attestDemand({ live, now: 0 }), null);
});

test('a ripe bonded lock makes the attest go; one still gathering confirmations does not', () => {
  resetAttestDemand();
  noteLockDemand({ waiting: 1, ripe: false }, 0);
  assert.equal(attestDemand({ live, now: 1 }), null);
  noteLockDemand({ waiting: 2, ripe: true }, 0);
  assert.match(attestDemand({ live, now: 1 }), /^2 bonded cBTC lock/);
  assert.equal(attestDemand({ live, now: 16 * 60_000 }), null, 'a note the header feeder has not renewed lapses');
});

test('cross-outs the last batch did not carry make it go; at the pool\'s counts it waits for company', () => {
  resetAttestDemand();
  noteFoldedCounts({ crossOuts: 16n, consumed: 2n }, 0);
  assert.match(attestDemand({ live, now: 1 }), /carried 16 cross-out\(s\)\/2 consumed against the pool's 19\/2/);
  noteFoldedCounts({ crossOuts: 19n, consumed: 2n }, 0);
  assert.equal(attestDemand({ live, now: 1 }), null);
  assert.equal(attestDemand({ live: null, now: 1 }), null, 'an unreadable pool is not a reason to hurry');
  noteFoldedCounts(null, 0);
  assert.equal(attestDemand({ live, now: 1 }), null, 'no confirmed candidate yet');
});
