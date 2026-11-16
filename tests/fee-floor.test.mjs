// dapp/fee-floor.js (the floor and the priority rate for pages that do not load tacit.js) and the floor on a transaction's fee in the wallet module (dapp/bitcoin-taproot-wallet.js feeFor).
//   node --test tests/fee-floor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floorFromBlocks, priorityRate, NET_MIN_FLOOR } from '../dapp/fee-floor.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';

const blocks = (lows) => lows.map((n, i) => ({ height: 976119 - i, extras: { feeRange: [n, 2, 5, 9, 30, 80, 300], medianFee: 0.12 } }));

test('the floor is twice the worst "lowest included" of the last six blocks, within 0.2 and 1', () => {
  assert.equal(floorFromBlocks(blocks([0.12, 0.12, 0.12, 0.12, 0.12, 0.12])), 0.24, 'the 2026-11-16 backlog');
  assert.equal(floorFromBlocks(blocks([0.12, 0.12, 1.02, 0.12, 0.12, 0.12])), 1, 'one block that took nothing under 1 keeps the floor at 1');
  assert.equal(floorFromBlocks(blocks([0.05, 0.05, 0.05, 0.05, 0.05, 0.05])), NET_MIN_FLOOR, 'never under 0.2');
  assert.equal(floorFromBlocks(blocks([0.3, 0.3, 0.3, 0.3, 0.3, 0.3])), 0.6);
  assert.equal(floorFromBlocks(blocks([2, 2, 2, 2, 2, 2])), 1, 'never above 1');
});

test('unreadable blocks leave the floor at 1, as it always was', () => {
  for (const bad of [null, undefined, {}, [], blocks([0.12, 0.12, 0.12]), blocks([0.12, 0.12, 0.12, 0.12, 0.12, NaN]), blocks([0.12, 0.12, 0.12, 0.12, 0.12, 0]), [{}, {}, {}, {}, {}, {}]]) {
    assert.equal(floorFromBlocks(bad), 1, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('priorityRate: the recommended fee stands unless it is at its floor of 1 and Core\'s next-block estimate is lower', () => {
  assert.equal(priorityRate({ recommended: { fastestFee: 1 }, estimates: { 1: 0.35 }, floor: 0.24 }), 0.35, 'backlog: Core says 0.35');
  assert.equal(priorityRate({ recommended: { fastestFee: 1 }, estimates: { 1: 0.35 }, floor: 0.4 }), 0.4, 'never under the floor');
  assert.equal(priorityRate({ recommended: { fastestFee: 1 }, estimates: { 2: 0.35 } }), 1, 'with the floor at 1 (blocks unread) it stays 1');
  assert.equal(priorityRate({ recommended: { fastestFee: 1 }, estimates: { 1: 2 }, floor: 0.24 }), 1, 'a higher estimate does not raise it');
  assert.equal(priorityRate({ recommended: { fastestFee: 1 }, estimates: null, floor: 0.24 }), 1);
  assert.equal(priorityRate({ recommended: { fastestFee: 3 }, estimates: { 1: 0.35 }, floor: 0.24 }), 3, 'above 1 the recommended fee is untouched');
  assert.equal(priorityRate({ recommended: { fastestFee: 20 }, estimates: { 1: 19 }, floor: 0.24 }), 20);
  assert.equal(priorityRate({ recommended: null, estimates: { 1: 0.35 } }), null, 'nothing to start from');
  assert.equal(priorityRate({}), null);
});

test('the wallet module\'s feeFor: 500 sats at least, 150 when the rate is under 1 sat/vB', () => {
  const { prims } = makeBtcWallet({ priv: new Uint8Array(32).fill(7), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('offline'); }, fetchFeeRate: async () => 1 });
  assert.equal(prims.feeFor(152, 0.26), 150, 'a commit at a backlog-time rate');
  assert.equal(prims.feeFor(954, 0.26), 249, 'a reveal is its size times the rate');
  assert.equal(prims.feeFor(109, 0.9), 150);
  assert.equal(prims.feeFor(152, 1), 500, 'at 1 sat/vB and up the floor is as it was');
  assert.equal(prims.feeFor(152, 1.2), 500);
  assert.equal(prims.feeFor(526, 1.4), 737);
});
