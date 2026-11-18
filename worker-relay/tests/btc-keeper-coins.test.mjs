import { keeperCoinsVerdict as v } from '../src/lib/btc-keeper-coins.js';
import assert from 'node:assert/strict';
const c = (...a) => a.map((value) => ({ value, status: { confirmed: true } }));
assert.equal(v('pool', c(23176, 12911, 1438, 1308, 693)).level, 'ok');
assert.equal(v('pool', c(16350)).level, 'critical');
assert.equal(v('pool', c(693, 1308, 1000)).level, 'critical');
assert.equal(v('pool', c(5000, 4000, 3000, 2000)).level, 'warning');      // 14000 sats
assert.equal(v('pool', c(20000, 5000)).level, 'warning');                  // two coins
assert.equal(v('pool', [{ value: 90000, status: { confirmed: false } }, ...c(500)]).level, 'critical');
assert.equal(v('pool', null).level, 'unknown');
assert.equal(v('crossout', c(31152)).level, 'ok');
assert.equal(v('crossout', c(5000)).level, 'warning');
assert.equal(v('crossout', c(1000)).level, 'critical');
console.log('ok btc-keeper-coins');
