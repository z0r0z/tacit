// The listing tool (tools/vanity-shop-list.mjs): prices, the calldata the shop decodes, and the plan from the pool's bank.
//   node --test tests/vanity-shop-list.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { priceTac, priceAnchored, MARKET_ANCHORS, encodeList, encodeKeep, buildPlan, buildCalls, chunks, makeChain } from '../tools/vanity-shop-list.mjs';
import { marketAddress } from '../worker/src/salt-pool.js';

const SHOP = '0x' + 'aa'.repeat(20);
const OPS = '0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2';
const W = 10n ** 18n;
const P = { tacUsd: 0.05, usdPerHour: 0.45, rate: 1.43e9, markup: 1, minPrice: 1 };

// a market entry of the shop with exactly `bits` zero bits at `nonce`, as the pool's bank lists it
function entry(bits, nonce = 0, shop = SHOP, at = 1) {
  for (;;) {
    const salt = '0x' + shop.slice(2) + '00' + '5125' + randomBytes(9).toString('hex');
    const a = marketAddress(salt, nonce);
    if (a.bits === bits) return { salt, address: a.address, bits: a.bits, nonce, miner: '0x' + '11'.repeat(20), at };
  }
}

test('the price is the cost of grinding it in TAC, doubling with every bit, rounded up to two figures, never under the floor', () => {
  // 2^48 tries at 1.43e9 a second is 54.7 hours of a $0.45 card = $24.6 = 492 TAC at $0.05, which reads as 500
  assert.equal(priceTac({ bits: 48, ...P }), 500n * W);
  assert.equal(priceTac({ bits: 20, ...P }), 1n * W, 'the floor');
  assert.equal(priceTac({ bits: 49, ...P }), 990n * W, '984 TAC reads as 990');
  assert.equal(priceTac({ bits: 40, ...P, minPrice: 1 }), 2n * W, '1.92 TAC reads as 2');
  const p = (bits) => Number(priceTac({ bits, ...P }) / 10n ** 12n) / 1e6;
  for (let b = 41; b < 60; b++) {
    assert.ok(p(b) >= p(b - 1), `never cheaper for a rarer one (${b})`);
    assert.ok(p(b) / p(b - 1) > 1.8 && p(b) / p(b - 1) < 2.25, `about double per bit (${b}: ${p(b) / p(b - 1)})`);
  }
  assert.equal(priceTac({ bits: 48, ...P, markup: 2 }), 990n * W, 'the markup scales it (984 reads as 990)');
  assert.equal(priceTac({ bits: 48, ...P, tacUsd: 0.5 }), 50n * W, 'a dearer TAC is fewer of them');
  assert.ok(priceTac({ bits: 59, ...P }) > 1_000_000n * W, 'the 59-bit one is a million TAC and more at these terms');
  assert.throws(() => priceTac({ bits: 48, ...P, tacUsd: 0 }), /positive/);
  assert.throws(() => priceTac({ bits: 120, ...P, tacUsd: 1e-12 }), /cost more than a listing can hold/);
});

test('the anchored price follows the market\'s points on a log scale: its own at each, between them in proportion, halving every four bits below the first', () => {
  const A = { tacUsd: 0.1, ethUsd: 2000 };           // an ETH is 20,000 TAC
  const t = (bits, o = {}) => Number(priceAnchored({ bits, ...A, ...o }) / 10n ** 12n) / 1e6;
  assert.deepEqual(MARKET_ANCHORS, [[40, 0.005], [48, 0.02], [52, 0.05], [56, 2]], '10, 12, 13 and 14 leading zero digits');
  assert.deepEqual([40, 48, 52, 56].map((b) => t(b)), [100, 400, 1000, 40000], 'at each point: its ETH price in TAC');
  assert.equal(t(44), 200, 'halfway between two points is the geometric mean (the straight line on a log scale)');
  assert.equal(t(50), 640, '632 TAC reads as 640, up to two figures');
  assert.equal(t(54), 6400, '6,325 reads as 6,400');
  assert.equal(t(36), 50); assert.equal(t(32), 25); assert.equal(t(28), 13, 'below the first point it halves for every four bits fewer (12.5 reads as 13)');
  assert.equal(t(60), 1_600_000, 'and above the last it goes on at the last two points\' slope, forty times for four bits');
  for (let b = 21; b < 70; b++) assert.ok(t(b) >= t(b - 1), `never cheaper for a rarer one (${b})`);
  assert.equal(t(40, { discount: 0.5 }), 50); assert.equal(t(40, { discount: 0.25 }), 75, 'a discount scales it');
  assert.equal(t(40, { tacUsd: 0.2 }), 50, 'a dearer TAC is fewer of them'); assert.equal(t(40, { ethUsd: 4000 }), 200, 'a dearer ETH is more');
  assert.equal(t(8), 1, 'never under the floor'); assert.equal(t(8, { minPrice: 5 }), 5);
  const mine = { tacUsd: 1, ethUsd: 1 };
  assert.deepEqual([5, 10, 15, 20].map((b) => Number(priceAnchored({ bits: b, ...mine, anchors: [[20, 100], [10, 1]], minPrice: 0.01 }) / 10n ** 12n) / 1e6), [0.1, 1, 10, 100], 'points of your own, in any order');
  assert.throws(() => priceAnchored({ bits: 40, ...A, discount: 1 }), /discount/);
  assert.throws(() => priceAnchored({ bits: 40, ...A, discount: -0.1 }), /discount/);
  assert.throws(() => priceAnchored({ bits: 40, ...A, discount: NaN }), /discount/);
  assert.throws(() => priceAnchored({ bits: 40, ...A, ethUsd: 0 }), /positive/);
  assert.throws(() => priceAnchored({ bits: 40, ...A, tacUsd: -1 }), /positive/);
  assert.throws(() => priceAnchored({ bits: 40, ...A, anchors: [[40, 1]] }), /anchors/);
  assert.throws(() => priceAnchored({ bits: 40, ...A, anchors: [[40, 1], [40, 2]] }), /anchors/);
  assert.throws(() => priceAnchored({ bits: 40, ...A, anchors: [[40, 1], [48, 0]] }), /anchors/);
  assert.throws(() => priceAnchored({ bits: 200, ...A }), /cost more than a listing can hold/);
});

test('the calldata is what cast and the contract encode for the same calls', () => {
  // `cast calldata`, and contracts/test/VanityShop.t.sol testTheCalldataTheListingToolBuildsIsWhatTheContractDecodes, for the same ids
  const id1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0051250123456789abcdef01', id2 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa005125ffeeddccbbaa998877';
  assert.equal(encodeList([{ id: id1, price: 100n * W, nonce: 3 }, { id: id2, price: 5n * W, nonce: 0 }]),
    '0x5e80527b00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0051250123456789abcdef010000000000000000000000000000000000000000000000056bc75e2d631000000000000000000000000000000000000000000000000000000000000000000003aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa005125ffeeddccbbaa9988770000000000000000000000000000000000000000000000004563918244f400000000000000000000000000000000000000000000000000000000000000000000');
  assert.equal(encodeKeep({ id: id1, nonce: 7, to: OPS }),
    '0x3960bb02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0051250123456789abcdef010000000000000000000000000000000000000000000000000000000000000007000000000000000000000000006cd14f36f65ecbb29b2519ccbe63a0dc8549f2');
});

test('the plan: the best are kept, the rest listed at their prices, and everything that cannot be listed is left out with the reason', async () => {
  const best = entry(13), second = entry(12), mid = entry(11), low = entry(8), nonced = entry(10, 5);
  const foreign = entry(10, 0, '0x' + 'bb'.repeat(20));
  const tampered = { ...entry(10), address: '0x' + '12'.repeat(20) };
  const price = (bits) => BigInt(bits) * W;
  const plan = await buildPlan([low, mid, foreign, best, tampered, nonced, second], { shop: SHOP, keep: 2, minBits: 10, price });
  const by = (a) => plan.find((p) => p.id === a.salt);
  assert.equal(by(best).action, 'keep'); assert.equal(by(second).action, 'keep');
  assert.equal(by(mid).action, 'list'); assert.equal(by(mid).priceWei, BigInt(mid.bits) * W);
  assert.equal(by(nonced).action, 'list'); assert.equal(by(nonced).nonce, 5, 'a salt keeps the nonce its address was found at');
  assert.match(by(low).reason, /under the listing bar/);
  assert.equal(by(foreign).reason, 'not a salt of this shop');
  assert.match(plan.find((p) => p.address === tampered.address).reason, /not the one the market derives/);
  const kept = plan.filter((p) => p.action === 'keep').map((p) => p.bits);
  assert.ok(kept.every((b) => plan.filter((p) => p.action === 'list').every((l) => l.bits <= b)), 'every kept salt is at least as good as every listed one');
});

test('against the chain: a token already minted is left out, one already listed is left alone unless it is to be kept, and an address the market computes differently is refused', async () => {
  const [a, b, c, d] = [entry(12), entry(11), entry(10), entry(10)];
  const chain = {
    computeAddress: async (id, nonce) => (id === d.salt ? '0x' + '99'.repeat(20) : marketAddress(id, nonce).address),
    tokenData: async (id) => ({ minted: id === c.salt }),
    listing: async (id) => (id === a.salt || id === b.salt ? { price: 7n * W, nonce: 0 } : { price: 0n, nonce: 0 }),
  };
  const plan = await buildPlan([a, b, c, d], { shop: SHOP, keep: 1, minBits: 8, price: () => W }, chain);
  const by = (x) => plan.find((p) => p.id === x.salt);
  assert.equal(by(a).action, 'keep'); assert.match(by(a).note, /listed at 7 TAC: keeping it takes it off the shelf/);
  assert.equal(by(b).action, 'skip'); assert.match(by(b).reason, /already listed at 7 TAC/);
  assert.equal(by(c).reason, 'already a token');
  assert.match(by(d).reason, /computes another address/);
});

test('the calls: one keep each, the listings in chunks, every id of the shop', () => {
  const plan = [];
  for (let i = 0; i < 45; i++) plan.push({ action: 'list', id: '0x' + 'aa'.repeat(20) + '00'.repeat(11) + i.toString(16).padStart(2, '0'), nonce: i % 3, bits: 40, address: '0x' + '00'.repeat(20), priceWei: BigInt(i + 1) * W });
  plan.push({ action: 'keep', id: '0x' + 'aa'.repeat(20) + '00'.repeat(12), nonce: 2, bits: 50, address: '0x' + '00'.repeat(20) });
  plan.push({ action: 'skip', id: 'x' });
  const calls = buildCalls(plan, { shop: SHOP, keepTo: OPS, chunk: 40 });
  assert.equal(calls.length, 3);
  assert.match(calls[0].label, /^keep /); assert.equal(calls[0].data.slice(0, 10), '0x3960bb02');
  assert.equal(calls[1].data.slice(0, 10), '0x5e80527b'); assert.equal(BigInt('0x' + calls[1].data.slice(10 + 64, 10 + 128)), 40n);
  assert.equal(BigInt('0x' + calls[2].data.slice(10 + 64, 10 + 128)), 5n);
  assert.ok(calls.every((c) => c.to === SHOP && c.value === '0'));
  // every listed item comes out as the id, the price and the nonce it went in with
  const decode = (data) => { const h = data.slice(10); const n = Number(BigInt('0x' + h.slice(64, 128))); const out = []; for (let i = 0; i < n; i++) { const w = h.slice(128 + i * 192, 128 + (i + 1) * 192); out.push({ id: '0x' + w.slice(0, 64), price: BigInt('0x' + w.slice(64, 128)), nonce: Number(BigInt('0x' + w.slice(128, 192))) }); } return out; };
  const listed = plan.filter((p) => p.action === 'list');
  assert.deepEqual([...decode(calls[1].data), ...decode(calls[2].data)], listed.map((p) => ({ id: p.id, price: p.priceWei, nonce: p.nonce })));
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunks([], 3), []);
});

test('the reads encode the market\'s and the shop\'s calls and decode their answers', async () => {
  const seen = [];
  const fetchImpl = async (_url, init) => {
    const { params: [{ to, data }] } = JSON.parse(init.body);
    seen.push({ to, data });
    const reply = data.startsWith('0xb09afec1') ? '0x' + '00'.repeat(31) + '01' + '00'.repeat(31) + '03'       // getTokenData: minted, nonce 3
      : data.startsWith('0xde74e57b') ? '0x' + '00'.repeat(31) + '0a' + '00'.repeat(31) + '02'                   // listings: price 10 wei, nonce 2
        : '0x' + '00'.repeat(12) + '12'.repeat(20);                                                               // computeAddress
    return { json: async () => ({ result: reply }) };
  };
  const chain = makeChain({ rpc: 'http://x', market: '0x' + '22'.repeat(20), shop: SHOP, fetchImpl });
  const id = '0x' + 'aa'.repeat(20) + '00'.repeat(12);
  assert.deepEqual(await chain.tokenData(id), { minted: true });
  assert.deepEqual(await chain.listing(id), { price: 10n, nonce: 2 });
  assert.equal(await chain.computeAddress(id, 9), '0x' + '12'.repeat(20));
  assert.deepEqual(seen.map((s) => [s.to.slice(0, 6), s.data.slice(0, 10)]), [['0x2222', '0xb09afec1'], ['0xaaaa', '0xde74e57b'], ['0x2222', '0xe7139a09']]);
  assert.equal(seen[2].data.slice(-2), '09', 'the nonce rides in the last word');
});

test('the command: a bank file in, a plan and the calls out, no RPC needed (it warns), bad arguments refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vsl-'));
  const bank = [entry(12), entry(11), entry(10), entry(9)];
  writeFileSync(join(dir, 'bank.json'), JSON.stringify({ bank: [], marketBank: bank }));
  const run = (...a) => spawnSync(process.execPath, ['tools/vanity-shop-list.mjs', ...a], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  const r = run('--model', 'cost', '--shop', SHOP, '--bank', join(dir, 'bank.json'), '--tac-usd', '1', '--keep', '1', '--min-bits', '10', '--out', join(dir, 'plan.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WARNING: no --rpc/);
  assert.match(r.stdout, /4 salts in the bank, 1 to keep, 2 to list, 1 left out/);
  const out = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  assert.equal(out.calls.length, 2); assert.equal(out.shop, SHOP);
  assert.ok(out.plan.every((p) => p.priceWei === undefined || /^\d+$/.test(p.priceWei)));
  assert.notEqual(run('--bank', join(dir, 'bank.json'), '--tac-usd', '1').status, 0, 'no shop');
  assert.notEqual(run('--shop', SHOP, '--bank', join(dir, 'bank.json')).status, 0, 'no TAC price');
  writeFileSync(join(dir, 'old.json'), JSON.stringify({ bank: [] }));
  const old = run('--model', 'cost', '--shop', SHOP, '--bank', join(dir, 'old.json'), '--tac-usd', '1');
  assert.notEqual(old.status, 0); assert.match(old.stderr, /not taking market salts yet/);
});

test('the command prices by the market by default: the points, the ETH and TAC prices and the discount in, each price and the whole listing out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vsl-'));
  const bank = [entry(12), entry(11), entry(10), entry(9)];
  writeFileSync(join(dir, 'bank.json'), JSON.stringify({ bank: [], marketBank: bank }));
  const run = (...a) => spawnSync(process.execPath, ['tools/vanity-shop-list.mjs', ...a], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  // the market's own points sit at 40 bits and up, which a test cannot grind: the same shape at 10, 12, 13 and 14
  const base = ['--shop', SHOP, '--bank', join(dir, 'bank.json'), '--tac-usd', '0.1', '--eth-usd', '2000', '--anchors', '10:0.005,12:0.02,13:0.05,14:2', '--keep', '1', '--min-bits', '10'];
  const r = run(...base, '--discount', '0.5', '--out', join(dir, 'plan.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pricing: the market's prices \(10 bits 0\.005 ETH, 12 bits 0\.02 ETH, 13 bits 0\.05 ETH, 14 bits 2 ETH\), ETH at \$2000, TAC at \$0\.1, 50% off/);
  assert.match(r.stdout, /4 salts in the bank, 1 to keep, 2 to list, 1 left out/);
  assert.match(r.stdout, /list\s+11 bits .* 100 TAC ≈ \$10\.00/); assert.match(r.stdout, /list\s+10 bits .* 50 TAC ≈ \$5\.00/);
  assert.match(r.stdout, /the listing comes to 150 TAC \(≈ \$15\.00 at \$0\.1 a TAC\) for 2 salts/);
  const out = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  assert.deepEqual(out.plan.filter((p) => p.action === 'list').map((p) => p.priceWei), [String(100n * W), String(50n * W)]);
  assert.equal(out.params.model, 'anchored'); assert.equal(out.params.discount, 0.5); assert.equal(out.params.ethUsd, 2000);
  const full = run(...base);
  assert.match(full.stdout, /list\s+11 bits .* 200 TAC/); assert.doesNotMatch(full.stdout, /% off/, 'no discount, none said');
  assert.notEqual(run('--shop', SHOP, '--bank', join(dir, 'bank.json'), '--tac-usd', '0.1').status, 0, 'no ETH price');
  assert.match(run('--shop', SHOP, '--bank', join(dir, 'bank.json'), '--tac-usd', '0.1').stderr, /--eth-usd/);
  assert.notEqual(run(...base, '--discount', '1').status, 0, 'a discount of all of it');
  assert.match(run(...base, '--discount', '1').stderr, /discount/);
  assert.notEqual(run(...base, '--model', 'nonsense').status, 0, 'a model that is neither');
  const one = run('--shop', SHOP, '--bank', join(dir, 'bank.json'), '--tac-usd', '0.1', '--eth-usd', '2000', '--anchors', '10:0.005', '--min-bits', '10');
  assert.notEqual(one.status, 0, 'one point is not a curve'); assert.match(one.stderr, /anchors/);
});
