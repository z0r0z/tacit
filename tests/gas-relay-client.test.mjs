// The page side of TacitGasRelay: an order built here is what the contract hashes and what the board accepts. Run: node --test tests/gas-relay-client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeGasBoard, checkGasOrder, orderDigest, GAS_TARGETS } from '../worker/src/gas-relay-queue.js';
import * as gr from '../dapp/gas-relay.js';
import { encodeExecute as encodeViem } from '../worker-relay/src/lib/gas-calls.js';
const require = createRequire(new URL('../worker-relay/package.json', import.meta.url));
const { privateKeyToAccount } = require('viem/accounts');
const acct = privateKeyToAccount('0x' + 'a1b2c3d4'.repeat(8));
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', ZR = '0x000000000000FB114709235f1ccBFfb925F600e4', NOW = 1_800_000_000;
const data = '0x5f3bd1c8' + '11'.repeat(100);
const mk = (over = {}) => gr.buildOrder({ payer: acct.address, tokenIn: gr.TAC, amountIn: 100n * 10n ** 18n, feeToken: gr.TAC, fee: 3n * 10n ** 18n, tokenOut: USDC, minOut: 11_000_000n,
  recipient: acct.address, target: ZR, data, now: NOW, nonce: 7n, ...over });
async function signed(over) {
  const { order, data: d } = mk(over), t = gr.orderTypedData(order);
  const signature = await acct.signTypedData({ domain: t.domain, types: { Order: gr.ORDER_TYPES.Order }, primaryType: 'Order', message: order });
  return { order, data: d, signature, inPermit: gr.NO_PERMIT, feePermit: gr.NO_PERMIT, p2: gr.NO_P2 };
}
const kvOf = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } }; };

test('a signed order is listed, and the digest the board hashes is the one the wallet signed', async () => {
  const x = await signed();
  assert.equal(checkGasOrder(x, { now: NOW }), null);
  const board = makeGasBoard({ kv: kvOf(), now: () => NOW }), r = await board.post(x);
  assert.equal(r.ok, true);
  assert.equal((await board.list()).length, 1);
  assert.equal((await board.post(x)).existing, true);
  assert.equal(r.id.length, 66);
  assert.equal(r.id, '0x' + Buffer.from(orderDigest(x.order)).toString('hex'));
  await board.remove(r.id);
  assert.equal((await board.list()).length, 0);
});

test('every way an order can be junk is refused', async () => {
  const x = await signed();
  const bad = (m) => checkGasOrder(m, { now: NOW });
  assert.match(bad({ ...x, data: x.data + '00' }), /not the one signed/);
  assert.match(bad({ ...x, order: { ...x.order, fee: '1' } }), /not signed by its payer/);
  assert.match(bad({ ...x, order: { ...x.order, deadline: String(NOW + 5) } }), /too near/);
  assert.match(bad({ ...x, order: { ...x.order, deadline: String(NOW + 99999) } }), /too far/);
  assert.match(bad({ ...x, order: { ...x.order, target: '0x00000000000000000000000000000000000dEaD0' } }), /allowed contract/);
  assert.match(bad({ ...x, order: { ...x.order, feeToken: USDC } }), /TAC or the token spent/);
  assert.match(bad({ ...x, signature: '0x00' }), /signature is malformed/);
  assert.match(bad(null), /not an order/);
  assert.ok(GAS_TARGETS.length === 8);
});

test('the fee is paid in TAC or the token spent, and a swap into itself is refused', () => {
  assert.throws(() => mk({ feeToken: USDC }), /TAC or the token spent/);
  assert.throws(() => mk({ tokenOut: gr.TAC }), /nothing to swap/);
  assert.equal(mk({ feeToken: gr.TAC, tokenIn: USDC, tokenOut: '0x0000000000000000000000000000000000000000' }).order.tokenIn, USDC);
});

test('fee and the no-ETH test', async () => {
  assert.equal(await gr.feeFor({ gasPriceWei: 10n ** 9n, ethToToken: async (w) => w * 20000n }), (10n ** 9n * 450000n * 15000n / 10000n) * 20000n);
  assert.equal(await gr.feeFor({ gasPriceWei: 1n, ethToToken: async () => null }), null);
  assert.equal(gr.needsRelay({ ethWei: 0n, gasPriceWei: 10n ** 9n }), true);
  assert.equal(gr.needsRelay({ ethWei: 10n ** 17n, gasPriceWei: 10n ** 9n }), false);
});

test('the permit typed data names the relay as spender', () => {
  const p = gr.permitTypedData({ token: gr.TAC, owner: acct.address, value: 5n, nonce: 0n, deadline: NOW });
  assert.equal(p.message.spender, gr.GAS_RELAY[1]);
  assert.equal(p.domain.name, 'Tacit Token');
  assert.equal(gr.permitTypedData({ token: '0xdAC17F958D2ee523a2206206994597C13D831ec7', owner: acct.address, value: 1n, nonce: 0n, deadline: NOW }), null);
});

test('the page encodes execute(...) exactly as the relay does (a permit order and a Permit2 order)', async () => {
  const x = await signed({ feeToken: USDC, tokenIn: USDC, tokenOut: '0x0000000000000000000000000000000000000000' });
  x.inPermit = { value: '123', deadline: String(NOW + 600), v: 27, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) };
  assert.equal(gr.encodeExecute(x), encodeViem(x));
  const y = { ...x, p2: { use: true, batch: { details: [{ token: USDC, amount: '500', expiration: String(NOW + 600), nonce: '3' }, { token: gr.TAC, amount: '9', expiration: '5', nonce: '0' }], spender: gr.GAS_RELAY[1], sigDeadline: String(NOW + 600) }, sig: '0x' + 'ab'.repeat(65) } };
  assert.equal(gr.encodeExecute(y), encodeViem(y));
});

test('the board keeps an order\'s own fields, and refuses one too large to be an order', async () => {
  const x = await signed();
  const kv = kvOf(), board = makeGasBoard({ kv, now: () => NOW });
  const r = await board.post({ ...x, junk: 'x'.repeat(200_000), extra: { a: 'y'.repeat(1000) } });
  assert.equal(r.ok, true);
  const kept = await kv.get(`gr:order:${r.id}`);
  assert.ok(kept.length < 20_000 && !kept.includes('junk') && !kept.includes('extra'));
  const big = await signed({ nonce: 8n });
  assert.deepEqual(await makeGasBoard({ kv: kvOf(), now: () => NOW }).post({ ...big, p2: { ...big.p2, pad: 'z'.repeat(60_000) } }), { ok: false, error: 'the order is too large' });
});

test('an order is removed only for the payer and nonce the relay reports used', async () => {
  const x = await signed();
  const board = makeGasBoard({ kv: kvOf(), now: () => NOW }), r = await board.post(x);
  const other = '0x' + '22'.repeat(20);
  assert.equal((await board.remove(r.id, { payer: other, nonce: '7' })).ok, false);
  assert.equal((await board.remove(r.id, { payer: acct.address, nonce: '9' })).ok, false);
  assert.equal((await board.list()).length, 1);
  assert.equal((await board.remove(r.id, { payer: acct.address.toLowerCase(), nonce: '7' })).ok, true);
  assert.equal((await board.list()).length, 0);
});
