// dapp/swap/slip.js: the room a private swap has to be built again when the pool moves under it.
//   node tests/swap-slip.test.mjs
import assert from 'node:assert/strict';
import { poolSlipBps, netOfFees, floorOf, POOL_SLIP_FLOOR_BPS, POOL_SLIP_CEIL_BPS } from '../dapp/swap/slip.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };

test('a swap that moves the pool next to nothing keeps the 1% it always had', () => {
  for (const x of [0, 0.00001, undefined, null, NaN, -0.5, 'x', Infinity * 0]) assert.equal(poolSlipBps(x), 100, String(x));
  assert.equal(POOL_SLIP_FLOOR_BPS, 100);
});

test('the room is 1% and twice the swap\'s own impact on top, in whole basis points', () => {
  assert.equal(poolSlipBps(0.004), 180);
  assert.equal(poolSlipBps(0.008), 260);
  assert.equal(poolSlipBps(0.01), 300);
  assert.equal(poolSlipBps(0.0025), 150);
  for (let x = 0; x <= 0.1; x += 0.0007) assert.ok(Number.isInteger(poolSlipBps(x)), `whole at ${x}`);
});

test('it never goes under the floor, never over 5%, and never shrinks as the pool gets thinner', () => {
  let prev = 0;
  for (let x = 0; x <= 0.2; x += 0.0005) {
    const b = poolSlipBps(x);
    assert.ok(b >= 100 && b <= 500 && b >= prev, `${x} -> ${b}`);
    prev = b;
  }
  assert.equal(poolSlipBps(0.02), 500, 'a 2% impact already reaches the ceiling');
  assert.equal(poolSlipBps(0.5), 500);
  assert.equal(POOL_SLIP_CEIL_BPS, 500);
});

test('an impact that includes the pools\' fees is taken net of them, hop by hop', () => {
  assert.ok(Math.abs(netOfFees(0.011, [{ feeBps: 30 }]) - 0.008) < 1e-12);
  assert.ok(Math.abs(netOfFees(0.02, [{ feeBps: 30 }, { feeBps: 5 }]) - 0.0165) < 1e-12);
  assert.equal(netOfFees(0.002, [{ feeBps: 30 }]), 0, 'a swap that costs only the fee has no impact of its own');
  assert.ok(Math.abs(netOfFees(0.01, [{}]) - 0.007) < 1e-12, 'a hop with no fee named is the 30 bps tier');
  assert.equal(netOfFees(undefined, [{ feeBps: 30 }]), 0);
  assert.equal(netOfFees(0.01, undefined), 0.01);
});

test('the least a swap takes is that far under its quote, rounded down', () => {
  assert.equal(floorOf(1000n, 100), 990n);
  assert.equal(floorOf(1000n, 500), 950n);
  assert.equal(floorOf(999n, 100), 989n, '989.01 rounds down');
  assert.equal(floorOf(12345678901234567890n, 180), 12345678901234567890n * 9820n / 10000n);
  assert.equal(floorOf(7n, 100), 6n);
});

// The live cETH/cTAC pool (read from the chain 11-22: 12.6 ETH against 56,666 TAC, a 30 bps tier) and a 0.05 ETH swap: what one, two and three other swaps like it do to it.
const out = (inn, rIn, rOut, fee = 30n) => (rOut * inn * (10000n - fee)) / (rIn * 10000n + inn * (10000n - fee));
test('on a thin live pool, two swaps like yours landing first no longer stop it, and three still do', () => {
  const rIn = 1_264_454_250n, rOut = 5_666_633_559_319n, swap = 5_000_000n;
  const quote = out(swap, rIn, rOut);
  const impact = 1 - (Number(quote) / Number(swap)) / (Number(rOut) / Number(rIn));         // what the card shows: the fee included
  const room = poolSlipBps(netOfFees(impact, [{ feeBps: 30 }]));
  assert.ok(room > 100 && room < 300, `about 1.8% here (${room} bps)`);
  const after = (k) => { let a = rIn, b = rOut; for (let i = 0; i < k; i++) { const o = out(swap, a, b); a += swap; b -= o; } return out(swap, a, b); };
  const flat = floorOf(quote, 100), wide = floorOf(quote, room);
  assert.ok(after(1) >= flat, 'one other swap fit the old 1% too');
  assert.ok(after(2) < flat && after(2) >= wide, 'two others stopped the swap at 1%, and now it is built again');
  assert.ok(after(3) < wide, 'three others still stop it: this is room for a pool that moved, not for any price');
});

test('on a deep pool the room stays at the floor, so a swap there is held as tightly as before', () => {
  const rIn = 100n * 10n ** 8n, rOut = 450_000n * 10n ** 8n, swap = 5_000_000n;
  const quote = out(swap, rIn, rOut);
  const impact = 1 - (Number(quote) / Number(swap)) / (Number(rOut) / Number(rIn));
  assert.ok(poolSlipBps(netOfFees(impact, [{ feeBps: 30 }])) <= 110, 'a 0.05 ETH swap into 100 ETH');
});

console.log(`${n} swap-slip checks passed`);
