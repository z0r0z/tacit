// The vanity page's shelf (dapp/vanity/shelf.js): the shelf read from the shop's events, an address as its zeros and the rest, and the calls a buyer makes, against `cast calldata`.
//   node --test tests/vanity-shelf.test.mjs
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { SHOP, MARKET, TAC, TOPICS, foldShelf, sortShelf, zeroBits, addressParts, tacText, buyData, buyWithPermitData, approveData, listingsData, balanceOfData, allowanceData, noncesData, decodeListing, decodeWord, refusalWords, badRecipient, isAddress, isId } from '../dapp/vanity/shelf.js';

const W = 10n ** 18n, w32 = (n) => BigInt(n).toString(16).padStart(64, '0');
const id = (n) => '0x' + SHOP.slice(2) + '00' + '5125' + n.toString(16).padStart(18, '0');
const vanityOf = (n) => '0x' + (n.toString(16).padStart(40, '0'));
const topicAddr = (a) => '0x' + a.slice(2).padStart(64, '0');
const listed = (n, v, nonce, price, block, idx = 0) => ({ topics: [TOPICS.listed, id(n), topicAddr(v)], data: '0x' + w32(nonce) + w32(price), blockNumber: '0x' + block.toString(16), logIndex: '0x' + idx.toString(16) });
const gone = (kind, n, block, idx = 0) => ({ topics: [TOPICS[kind], id(n)], data: '0x', blockNumber: '0x' + block.toString(16), logIndex: '0x' + idx.toString(16) });

test('the constants are the live shop, the market and TAC, and the topics are the events\' signatures', () => {
  assert.equal(SHOP, '0x00000000000785882df83d4cc6ed45c21eb1176c'); assert.equal(MARKET, '0x000000000000b361194cfe6312ee3210d53c15aa'); assert.equal(TAC, '0xa1313eb9f3a445606d9583bcac3ebeb56a858279');
  // `cast sig-event` for each
  assert.deepEqual(TOPICS, {
    listed: '0x2802f06388a3e8067e9fa7f668de2f85c52cddb739522134cdda89f30ede0c85', unlisted: '0x6318005f6dc5a71d3e4ad5b4d1fe455ef3402d62b64573777af55bb6bfe3daab',
    sold: '0x127eb22cbd9a50e7b18b046b3212e650943b4a1c981c96f699611b1f32097eae', kept: '0x38f594ca806dd6ce2b91f6224c6b232cabf998685d3f4d40ad1aee78ba576354' });
});

test('zero bits are counted from the first digit', () => {
  assert.equal(zeroBits(SHOP), 45, 'the shop\'s own address: eleven zero digits and a 7');
  assert.equal(zeroBits('0x0000000000000000000000000000000000000000'), 160);
  assert.equal(zeroBits('0x8000000000000000000000000000000000000000'), 0);
  assert.equal(zeroBits('0x1abc000000000000000000000000000000000000'), 3);
  assert.equal(zeroBits('0x00ffee0000000000000000000000000000000000'), 8);
  assert.equal(zeroBits('0x0000000000000000000000000000000000000001'), 159);
  assert.equal(zeroBits('0X00FF'.toLowerCase()), 8);
});

test('the shelf is what was listed and not taken down, sold or kept, whatever order the logs come in', () => {
  const logs = [
    listed(1, vanityOf(0x100), 3, 100n * W, 100, 0), listed(2, vanityOf(0x200), 0, 5n * W, 100, 1), gone('unlisted', 2, 101),
    listed(3, vanityOf(0x300), 5, 7n * W, 102), gone('sold', 3, 103),
    listed(4, vanityOf(0x400), 1, 9n * W, 104), listed(4, vanityOf(0x401), 2, 12n * W, 105),       // listed again at another price and nonce: the last stands
    listed(5, vanityOf(0x500), 0, 1n * W, 106), gone('kept', 5, 107),
    listed(6, vanityOf(0x600), 4, 3n * W, 108, 2), gone('unlisted', 6, 108, 1),                    // taken down before it was listed, in the same block: the list was later
  ];
  const shuffled = [...logs].sort(() => Math.random() - 0.5);
  for (const input of [logs, shuffled]) {
    const shelf = foldShelf(input).sort((a, b) => (a.id < b.id ? -1 : 1));
    assert.deepEqual(shelf.map((x) => [x.id, x.vanity, x.nonce, x.price, x.block]), [
      [id(1), vanityOf(0x100), 3, 100n * W, 100],
      [id(4), vanityOf(0x401), 2, 12n * W, 105],
      [id(6), vanityOf(0x600), 4, 3n * W, 108],
    ]);
    assert.equal(shelf[0].bits, zeroBits(vanityOf(0x100)));
  }
});

test('a log that is not what the shop emits is left out: no price, a nonce that is not an address\'s, a topic that is not an id', () => {
  const bad = [listed(1, vanityOf(0x1), 3, 0n, 100), listed(2, vanityOf(0x2), 255, 5n * W, 100), { topics: [TOPICS.listed, '0x12', topicAddr(vanityOf(3))], data: '0x' + w32(1) + w32(5), blockNumber: '0x64', logIndex: '0x0' },
    { topics: [TOPICS.listed, id(4), topicAddr(vanityOf(4))], data: '0x' + w32(1), blockNumber: '0x64', logIndex: '0x0' }, { topics: ['0x' + '00'.repeat(32), id(5)], data: '0x', blockNumber: '0x64', logIndex: '0x0' }, null, {}];
  assert.deepEqual(foldShelf(bad.filter(Boolean)), []);
  assert.deepEqual(foldShelf(null), []); assert.deepEqual(foldShelf([]), []);
  // and one good one among them stands
  assert.equal(foldShelf([...bad.filter(Boolean), listed(9, vanityOf(0x9), 1, 5n * W, 101)]).length, 1);
});

test('the rarest address is first, the cheaper first among equals', () => {
  const mk = (n, bits, price) => ({ id: id(n), bits, price: BigInt(price) * W });
  assert.deepEqual(sortShelf([mk(1, 40, 10), mk(2, 46, 90), mk(3, 40, 5), mk(4, 46, 90), mk(5, 44, 1)]).map((x) => x.id), [id(2), id(4), id(5), id(3), id(1)]);
});

test('an address is shown whole, its zeros apart from the rest; a price is whole TAC, with cents under a hundred', () => {
  const p = addressParts(SHOP, 45);
  assert.equal(p.zeros + p.rest, SHOP); assert.equal(p.zeros, '0x00000000000'); assert.equal(p.rest, '785882df83d4cc6ed45c21eb1176c');
  assert.equal(addressParts(SHOP).zeros, '0x00000000000', 'the bits are worked out when they are not given');
  assert.equal(addressParts('0x' + '00'.repeat(20), 160).rest, '');
  assert.equal(tacText(100n * W), '100'); assert.equal(tacText(12n * W + W / 2n), '12.5'); assert.equal(tacText(1234567n * W), '1,234,567'); assert.equal(tacText(W / 100n * 1n + 5n), '0.01');
  assert.equal(tacText(1n * W), '1'); assert.equal(tacText(0n), '0'); assert.equal(tacText(99n * W + W * 99n / 100n), '99.99'); assert.equal(tacText(100n * W + W / 2n), '100');
});

test('the calls are what `cast calldata` encodes for the same arguments', () => {
  const gold = Object.fromEntries(readFileSync(new URL('./fixtures/vanity-shop-calldata.txt', import.meta.url), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(' ')));
  assert.deepEqual(Object.keys(gold).filter((k) => !k.startsWith('error:')), ['buy', 'buyWithPermit', 'approve', 'listings', 'balanceOf', 'allowance', 'nonces']);
  const ID = '0x00000000000785882df83d4cc6ed45c21eb1176c0051250123456789abcdef01', TO = '0x1111111111111111111111111111111111111111';
  const R = '0x' + '00'.repeat(31) + '01', S = '0x' + '00'.repeat(31) + '02';
  assert.equal(buyData({ id: ID, to: TO, nonce: 3, maxPrice: 100n * W, deadline: 1800000000 }), gold.buy);
  assert.equal(buyWithPermitData({ id: ID, to: TO, nonce: 3, maxPrice: 100n * W, deadline: 1800000000, v: 27, r: R, s: S }), gold.buyWithPermit);
  assert.equal(approveData(SHOP, 100n * W), gold.approve);
  assert.equal(listingsData(ID), gold.listings);
  assert.equal(balanceOfData(TO), gold.balanceOf);
  assert.equal(allowanceData(TO, SHOP), gold.allowance);
  assert.equal(noncesData(TO), gold.nonces);
  // a signature a wallet hands back with a short r or s still fills its word, and an upper-case id or address is the same call
  assert.equal(buyWithPermitData({ id: ID, to: TO, nonce: 0, maxPrice: 1n, deadline: 1, v: 28, r: '0x1', s: '0x2' }).slice(-128), '0'.repeat(63) + '1' + '0'.repeat(63) + '2');
  assert.equal(buyData({ id: ID.toUpperCase().replace('0X', '0x'), to: TO.toUpperCase().replace('0X', '0x'), nonce: 3, maxPrice: 100n * W, deadline: 1800000000 }), gold.buy);
});

test('what the shop answers is read as words', () => {
  assert.deepEqual(decodeListing('0x' + w32(5n * W) + w32(3)), { price: 5n * W, nonce: 3 });
  assert.deepEqual(decodeListing('0x' + w32(0) + w32(0)), { price: 0n, nonce: 0 });
  assert.equal(decodeListing('0x12'), null); assert.equal(decodeListing(undefined), null);
  assert.equal(decodeWord('0x' + w32(77)), 77n); assert.equal(decodeWord('0x'), null); assert.equal(decodeWord(null), null);
});

test('a recipient is refused when it is nothing, this shop, the market or TAC, in any case', () => {
  for (const bad of ['', null, undefined, '0x12', SHOP, SHOP.toUpperCase().replace('0X', '0x'), MARKET, TAC, TAC.toUpperCase().replace('0X', '0x')]) assert.equal(badRecipient(bad), true, String(bad));
  assert.equal(badRecipient('0x1111111111111111111111111111111111111111'), false);
  assert.equal(isAddress(SHOP), true); assert.equal(isAddress('0x12'), false); assert.equal(isId(id(1)), true); assert.equal(isId(SHOP), false);
});

test('a refusal is told in words by its error selector (the shop\'s own and the TAC transfer\'s), and what is not one is not', () => {
  const errs = Object.entries(Object.fromEntries(readFileSync(new URL('./fixtures/vanity-shop-calldata.txt', import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('error:')).map((l) => l.split(' ')))).map(([k, v]) => [k.slice(6), v]);
  assert.deepEqual(errs.map(([k]) => k), ['NotListed', 'ListingChanged', 'PriceAboveMax', 'Expired', 'BadRecipient', 'TransferFromFailed']);
  for (const [name, sel] of errs) { assert.ok(refusalWords(sel), name); assert.equal(refusalWords(sel + '00'.repeat(28)), refusalWords(sel), `${name} with revert data after it`); assert.equal(refusalWords(sel.toUpperCase().replace('0X', '0x')), refusalWords(sel)); }
  assert.notEqual(refusalWords(errs[0][1]), refusalWords(errs[2][1]), 'a sale lost and a price changed are not told alike');
  assert.equal(refusalWords('0xdeadbeef'), null); assert.equal(refusalWords(undefined), null); assert.equal(refusalWords('0x'), null); assert.equal(refusalWords(null), null);
});
