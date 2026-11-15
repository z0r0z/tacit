// The settle relay's pass over the gas relay's board (worker-relay/src/lib/gas-solver.js). Run: node --test tests/gas-relay-solver.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGasSolver } from '../worker-relay/src/lib/gas-solver.js';

const order = (id, over = {}) => ({ id, order: { payer: '0x' + '11'.repeat(20), nonce: '1', deadline: String(2_000_000_000), fee: '100', feeToken: '0xa1313eb9f3a445606d9583bcac3ebeb56a858279', ...over } });
const rig = (o = {}) => {
  const calls = { send: 0, clear: 0 };
  const s = makeGasSolver({
    listOrders: async () => o.orders ?? [order('0xaa' + '00'.repeat(31))], used: async () => o.used ?? false, simulate: o.simulate ?? (async () => 400_000n),
    feeWei: async () => (o.fee === undefined ? 10n ** 16n : o.fee), gasPrice: async () => 10n ** 9n, send: async () => { calls.send++; return '0xtx'; }, clear: async () => { calls.clear++; },
    now: () => 1_900_000_000_000, ...(o.extra || {}),
  });
  return { s, calls };
};

test('a profitable order that simulates is sent and cleared', async () => {
  const { s, calls } = rig();
  assert.equal(await s.pass(), true);
  assert.deepEqual(calls, { send: 1, clear: 1 });
});
test('an order the contract would refuse is not sent, and not tried again at once', async () => {
  const { s, calls } = rig({ simulate: async () => { throw new Error('BelowMin'); } });
  assert.equal(await s.pass(), true);
  assert.equal(calls.send, 0);
  assert.equal(await s.pass(), false);   // within the retry window: skipped
});
test('a fee under the gas is left alone', async () => {
  const { s, calls } = rig({ fee: 1000n });
  await s.pass();
  assert.equal(calls.send, 0);
});
test('a fee that cannot be valued is left alone', async () => {
  const { s, calls } = rig({ fee: null });
  await s.pass();
  assert.equal(calls.send, 0);
});
test('an order already used leaves the board without a send', async () => {
  const { s, calls } = rig({ used: true });
  assert.equal(await s.pass(), false);
  assert.deepEqual(calls, { send: 0, clear: 1 });
});
test('an order about to expire is skipped', async () => {
  const { s, calls } = rig({ orders: [order('0xbb' + '00'.repeat(31), { deadline: String(1_900_000_010) })] });
  assert.equal(await s.pass(), false);
  assert.equal(calls.send, 0);
});
test('an order whose fields cannot be read into a call is said once and left alone for good', async () => {
  const lines = [];
  let clock = 1_900_000_000_000, sims = 0;
  const { s } = rig({ simulate: async () => { sims++; throw new RangeError('The number NaN cannot be converted to a BigInt because it is not an integer'); }, extra: { now: () => clock, log: (m) => lines.push(m) } });
  assert.equal(await s.pass(), true);
  clock += 10 * 60_000;                                   // well past the retry window
  assert.equal(await s.pass(), false);
  assert.equal(sims, 1, 'it is not simulated again');
  assert.equal(lines.filter((m) => /leaving it for good/.test(m)).length, 1);
});
test('a failure that is not about the order itself is tried again after the retry window', async () => {
  let clock = 1_900_000_000_000, sims = 0;
  const { s } = rig({ simulate: async () => { sims++; throw new TypeError('fetch failed'); }, extra: { now: () => clock } });
  await s.pass();
  clock += 2 * 60_000;
  await s.pass();
  assert.equal(sims, 2);
});
test('an unreadable order does not hold up the orders behind it', async () => {
  const bad = order('0xcc' + '00'.repeat(31)), good = order('0xdd' + '00'.repeat(31));
  const { s, calls } = rig({ orders: [bad, good], simulate: async (x) => { if (x.id === bad.id) throw new RangeError('The number NaN cannot be converted to a BigInt because it is not an integer'); return 400_000n; } });
  assert.equal(await s.pass(), true);   // the bad one is looked at and set aside
  assert.equal(await s.pass(), true);   // the next pass sends the good one
  assert.equal(calls.send, 1);
});
