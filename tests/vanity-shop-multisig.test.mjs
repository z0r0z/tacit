// The multisig step for stocking the vanity shop (tools/vanity-shop-multisig.mjs): what it reads out of a plan's calldata, and what it refuses to put in front of the owners.
//   node --test tests/vanity-shop-multisig.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadCalls, describeCalls } from '../tools/vanity-shop-multisig.mjs';
import { buildPlan, buildCalls, encodeKeep, encodeList } from '../tools/vanity-shop-list.mjs';
import { marketAddress } from '../worker/src/salt-pool.js';

const SHOP = '0x00000000000785882df83d4cc6ed45c21eb1176c';
const OPS = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
const W = 10n ** 18n;

// a market entry of the shop with exactly `bits` zero bits at `nonce`, as the pool's bank lists it
function entry(bits, nonce = 0, shop = SHOP) {
  for (;;) {
    const salt = '0x' + shop.slice(2) + '00' + '5125' + randomBytes(9).toString('hex');
    const a = marketAddress(salt, nonce);
    if (a.bits === bits) return { salt, address: a.address, bits: a.bits, nonce, miner: '0x' + '11'.repeat(20), at: 1 };
  }
}
const price = (bits) => BigInt(bits) * 10n * W;
async function planOf(entries, o = {}) {
  const plan = await buildPlan(entries, { shop: SHOP, keep: 1, minBits: 9, price });
  return { shop: SHOP, calls: buildCalls(plan, { shop: SHOP, keepTo: OPS, chunk: 2, ...o }) };
}
const bank = [entry(12, 3), entry(11, 0), entry(10, 126), entry(9, 200)];

test('a plan\'s keeps and listings are read back from the calldata: ids, nonces, recipients, prices, and the addresses the market gives them', async () => {
  const p = await planOf(bank);
  const calls = loadCalls(p);
  assert.deepEqual(calls.map((c) => c.kind), ['keep', 'list', 'list']);
  const [k, l1, l2] = calls;
  assert.equal(k.id, bank[0].salt); assert.equal(k.nonce, 3); assert.equal(k.to.toLowerCase(), OPS.toLowerCase()); assert.equal(k.vanity, bank[0].address); assert.equal(k.bits, 12);
  assert.deepEqual(l1.items.map((x) => [x.id, x.nonce, x.price, x.vanity, x.bits]), [[bank[1].salt, 0, price(11), bank[1].address, 11], [bank[2].salt, 126, price(10), bank[2].address, 10]]);
  assert.deepEqual(l2.items.map((x) => [x.id, x.nonce, x.price]), [[bank[3].salt, 200, price(9)]]);
  assert.equal(l1.total, price(11) + price(10));
  assert.ok(calls.every((c) => c.data.startsWith('0x')));
});

test('what the owners are shown is said from the calldata, in words', async () => {
  const lines = describeCalls(loadCalls(await planOf(bank)));
  assert.equal(lines.length, 3);
  assert.equal(lines[0], `keep ${bank[0].address} (12 bits, nonce 3): mint its token to ${OPS.toLowerCase()}`);
  assert.equal(lines[1], 'list 2 salts (10 to 11 bits) at 100 to 110 TAC each, 210 TAC in all');
  assert.equal(lines[2], 'list 1 salt (9 bits) at 90 TAC');
  const ids = [bank[0].salt, bank[1].salt];
  const same = describeCalls(loadCalls({ shop: SHOP, calls: [{ label: 'x', to: SHOP, value: '0', data: encodeList(ids.map((id) => ({ id, price: 28n * W, nonce: 0 }))) }] }));
  assert.match(same[0], /^list 2 salts \(\d+( to \d+)? bits\) at 28 TAC each, 56 TAC in all$/, 'one price for them all');
  // a label that lies changes nothing: the words come from the data
  const p = await planOf(bank); p.calls[0].label = 'keep 0xdead (99 bits) to 0xbeef';
  assert.equal(describeCalls(loadCalls(p))[0], lines[0]);
});

test('a plan for another shop, a call that is not to the shop or carries value, and anything but a keep or a list are refused', async () => {
  const p = await planOf(bank), fresh = () => JSON.parse(JSON.stringify(p));
  const refused = (mutate, re) => { const q = fresh(); mutate(q); assert.throws(() => loadCalls(q), re); };
  assert.throws(() => loadCalls(null), /another shop/);
  refused((q) => { q.shop = '0x' + 'aa'.repeat(20); }, /another shop/);
  refused((q) => { q.calls = []; }, /no calls/);
  refused((q) => { delete q.calls; }, /no calls/);
  refused((q) => { q.calls[1].to = OPS; }, /call 2 is not to the shop/);
  refused((q) => { q.calls[0].value = '1'; }, /call 1 carries value/);
  refused((q) => { q.calls[0].data = '0xdeadbeef' + '00'.repeat(96); }, /neither keep nor list/);
  refused((q) => { q.calls[0].data = '0x'; }, /no calldata/);
  refused((q) => { q.calls[0].data = 'not hex'; }, /no calldata/);
  // the same selector with the wrong shape
  refused((q) => { q.calls[0].data = q.calls[0].data + '00'; }, /keep is three words/);
  refused((q) => { q.calls[0].data = encodeKeep({ id: bank[0].salt, nonce: 3, to: OPS }).slice(0, -64) + '01' + '00'.repeat(11) + OPS.slice(2).toLowerCase(); }, /not an address/);
  refused((q) => { q.calls[1].data = q.calls[1].data.slice(0, -64); }, /array of/);
  refused((q) => { q.calls[1].data = q.calls[1].data + '00'.repeat(32); }, /array of/);
});

test('an id that is not the shop\'s, a nonce over 254, a price of nothing and an id twice are refused', async () => {
  const other = entry(9, 0, '0x' + 'bb'.repeat(20));
  const item = (e, o = {}) => ({ id: e.salt, price: price(e.bits), nonce: e.nonce, ...o });
  const planWith = (calls) => ({ shop: SHOP, calls: calls.map((data) => ({ label: 'x', to: SHOP, value: '0', data })) });
  assert.throws(() => loadCalls(planWith([encodeList([item(other)])])), /not an id of this shop/);
  assert.throws(() => loadCalls(planWith([encodeKeep({ id: other.salt, nonce: 0, to: OPS })])), /not an id of this shop/);
  assert.throws(() => loadCalls(planWith([encodeList([item(bank[0], { nonce: 255 })])])), /out of range/);
  assert.throws(() => loadCalls(planWith([encodeKeep({ id: bank[0].salt, nonce: 255, to: OPS })])), /out of range/);
  assert.throws(() => loadCalls(planWith([encodeList([item(bank[0], { price: 0n })])])), /a price of 0/);
  assert.throws(() => loadCalls(planWith([encodeList([item(bank[0], { price: 1n << 128n })])])), /a price of/);
  assert.throws(() => loadCalls(planWith([encodeList([item(bank[0]), item(bank[0])])])), /twice/);
  assert.throws(() => loadCalls(planWith([encodeList([item(bank[0])]), encodeKeep({ id: bank[0].salt, nonce: 0, to: OPS })])), /twice/);
  assert.equal(loadCalls(planWith([encodeList([item(bank[0]), item(bank[1])])]))[0].items.length, 2);
});

test('the command wants a plan, a step and an RPC, and says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vsm-'));
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ shop: SHOP, calls: [] }));
  const run = (env, ...a) => spawnSync(process.execPath, ['tools/vanity-shop-multisig.mjs', ...a], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  assert.equal(run({}).status, 2);
  const noRpc = run({}, join(dir, 'plan.json'), 'plan');
  assert.equal(noRpc.status, 2); assert.match(noRpc.stderr, /set RPC/);
  const empty = run({ RPC: 'http://127.0.0.1:1' }, join(dir, 'plan.json'), 'plan');
  assert.notEqual(empty.status, 0); assert.match(empty.stderr, /no calls/);
});
