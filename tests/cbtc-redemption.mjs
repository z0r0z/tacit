import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCrossChainOrderbook } from '../dapp/cross-chain-orderbook.js';
import { makeCbtcRedemption } from '../dapp/cbtc-redemption.js';

const CBTC = 'cb'.repeat(32); // a 64-hex cBTC asset id
const BTC = 'bt'.repeat(32); // the BTC "asset" id (Bitcoin lane)

function setup() {
  // A mock adaptor swap: the redemption module only needs the orderbook to compose it; the adaptor
  // crypto is exercised by tests/adaptor-swap.mjs. `open` records the binding.
  const swap = { open: ({ t, nearDeadline, farDeadline }) => ({ ctx: 'adaptor', t, nearDeadline, farDeadline }) };
  const orderbook = makeCrossChainOrderbook({ swap });
  const redeem = makeCbtcRedemption({ orderbook, cbtcAsset: CBTC, btcAsset: BTC });
  return { orderbook, redeem };
}

test('postClose + redeem: atomic 1:1, burn == unlock, lock unwound', () => {
  const { redeem } = setup();
  const id = redeem.postClose({ locker: 'L', lockId: 'txid:0', btcAmount: 100n, cbtcWanted: 100n });
  const q = redeem.quoteRedeem();
  assert.equal(q.length, 1, 'holder finds the close offer');

  const r = redeem.redeem(id, { holder: 'H', btcToTake: 100n, t: 0xabcn, nearDeadline: 10, farDeadline: 20 });
  assert.equal(r.cbtcBurned, 100n, 'holder burns 100 cBTC');
  assert.equal(r.btcUnlocked, 100n, 'holder receives 100 BTC');
  assert.equal(r.lockId, 'txid:0', 'the locker lock unwound');
  assert.equal(r.holder, 'H');
  assert.equal(r.locker, 'L');
  assert.equal(r.swap.t, 0xabcn, 'the adaptor swap is bound to t');
});

test('peg-protective: a close that would pay out more BTC than it retires is rejected', () => {
  const { redeem } = setup();
  assert.throws(
    () => redeem.postClose({ locker: 'L', lockId: 'x', btcAmount: 100n, cbtcWanted: 99n }),
    /peg-protective/,
  );
});

test('fee/spread: close may retire MORE cBTC than the BTC it unlocks (>= holds, locker keeps the spread)', () => {
  const { redeem } = setup();
  const id = redeem.postClose({ locker: 'L', lockId: 'x', btcAmount: 100n, cbtcWanted: 101n }); // 1% fee
  const r = redeem.redeem(id, { holder: 'H', btcToTake: 100n, t: 1n, nearDeadline: 1, farDeadline: 2 });
  assert.equal(r.btcUnlocked, 100n);
  assert.equal(r.cbtcBurned, 101n, 'burns 101 cBTC for 100 BTC — supply drops > backing drops');
  assert.ok(r.cbtcBurned >= r.btcUnlocked, 'invariant holds');
});

test('partial redemption', () => {
  const { redeem, orderbook } = setup();
  const id = redeem.postClose({ locker: 'L', lockId: 'x', btcAmount: 100n, cbtcWanted: 100n });
  const r = redeem.redeem(id, { holder: 'H', btcToTake: 40n, t: 1n, nearDeadline: 1, farDeadline: 2 });
  assert.equal(r.btcUnlocked, 40n);
  assert.equal(r.cbtcBurned, 40n);
  assert.equal(orderbook.get(id).remaining, 60n, '60 BTC of the lock still offered');
});

test('missing lockId is rejected (no BTC source)', () => {
  const { redeem } = setup();
  assert.throws(() => redeem.postClose({ locker: 'L', btcAmount: 100n, cbtcWanted: 100n }), /lockId/);
  assert.throws(() => redeem.postClose({ locker: 'L', lockId: 'x', btcAmount: 0n, cbtcWanted: 0n }), /zero BTC/);
});

test('redeem on a non-close offer id is rejected', () => {
  const { redeem, orderbook } = setup();
  // a plain (non-redemption) cross-chain offer posted directly
  const other = orderbook.post({ maker: 'X', giveAsset: BTC, giveAmount: 1n, giveLane: 'bitcoin', wantAsset: CBTC, wantAmount: 1n, wantLane: 'tacit' });
  assert.throws(() => redeem.redeem(other, { holder: 'H', btcToTake: 1n, t: 1n, nearDeadline: 1, farDeadline: 2 }), /not a redemption/);
});

test('cancelClose by the locker', () => {
  const { redeem, orderbook } = setup();
  const id = redeem.postClose({ locker: 'L', lockId: 'x', btcAmount: 100n, cbtcWanted: 100n });
  assert.equal(redeem.cancelClose(id, 'L'), true);
  assert.equal(orderbook.get(id).status, 'cancelled');
});
