// The shop page's shelf (dapp/shop/shelf.js): the shelf read from the shop's events, an address as its zeros and the rest, and the calls a buyer makes, against `cast calldata`.
//   node --test tests/shop-shelf.test.mjs
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { SHOP, MARKET, TAC, ROUTER, TOPICS, foldShelf, sortShelf, zeroBits, addressParts, tacText, buyData, buyWithPermitData, approveData, listingsData, balanceOfData, allowanceData, noncesData, decodeListing, decodeWord, refusalWords, badRecipient, isAddress, isId,
  zerosOf, zerosText, usdText, tacUsdFrom, priceUsd, zeroTiers, filterShelf, tokenNumber, tokenUrl, ownerOfData, addressOfData, parseTokenId, soldTo, forwarderRuntime, forwarderInit, forwardRefusal, deployData, decodeAddress, initcodeOf, deployRefusal, deployFailed, ETH_AT_DEPLOY_ADDRESS, ZAP, ZAP_MARGIN_BPS, buyWithEthData, retryAmountIn, ethText } from '../dapp/shop/shelf.js';

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
  assert.deepEqual(Object.keys(gold).filter((k) => !/error:/.test(k)), ['buy', 'buyWithPermit', 'approve', 'listings', 'balanceOf', 'allowance', 'nonces', 'ownerOf', 'deploy', 'deployLong', 'addressOf', 'buyWithEth']);
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

test('a recipient is refused when it is nothing, this shop, the market, TAC or the router, in any case', () => {
  for (const bad of ['', null, undefined, '0x12', SHOP, SHOP.toUpperCase().replace('0X', '0x'), MARKET, TAC, TAC.toUpperCase().replace('0X', '0x'), ROUTER, ROUTER.toUpperCase().replace('0X', '0x')]) assert.equal(badRecipient(bad), true, String(bad));
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

test('the list says an address\'s zeros in digits and its price in dollars when TAC has one, and the filter keeps the rows it should', () => {
  assert.equal(zerosOf(40), 10); assert.equal(zerosOf(39), 9); assert.equal(zerosOf(36), 9); assert.equal(zerosOf(3), 0); assert.equal(zerosOf(0), 0);
  assert.equal(zerosText(10), '10 zeros'); assert.equal(zerosText(1), '1 zero'); assert.equal(zerosText(0), '0 zeros');
  assert.equal(usdText(4.654), '$4.65'); assert.equal(usdText(99.994), '$99.99'); assert.equal(usdText(100), '$100'); assert.equal(usdText(1234.5), '$1,235'); assert.equal(usdText(3652), '$3,652');
  assert.equal(tacUsdFrom({ ethUsd: 2000, tacEth: 0.0001 }), 0.2);
  for (const bad of [{}, { ethUsd: 0, tacEth: 1 }, { ethUsd: 2000 }, { tacEth: 1 }, { ethUsd: 2000, tacEth: NaN }, { ethUsd: -1, tacEth: 1 }]) assert.equal(tacUsdFrom(bad), null, JSON.stringify(bad));
  assert.ok(Math.abs(priceUsd(28n * W, 0.166) - 4.648) < 1e-9); assert.equal(priceUsd(28n * W, null), null); assert.equal(priceUsd(28n * W, 0), null);
  const row = (n, bits, v) => ({ id: id(n), vanity: v, nonce: 0, price: BigInt(n) * W, bits });
  const shelf = [row(1, 40, '0x0000000000f5e9a4599fb175ca03db96a7e19bb3'), row(2, 39, '0x000000000110d317ed602ca7ef10a72bd72bd56f'), row(3, 36, '0x000000000a2ebf67bc9794f7a504e10c3b859cbc'), row(4, 37, '0x0000000001dead0000000000000000000000beef')];
  const ids = (list) => list.map((x) => x.id);
  assert.deepEqual(zeroTiers(shelf), [9, 10]); assert.deepEqual(zeroTiers([]), []);
  assert.deepEqual(ids(filterShelf(shelf)), ids(shelf), 'no filter keeps all, in order');
  assert.deepEqual(ids(filterShelf(shelf, { zeros: 10 })), [id(1)]);
  assert.deepEqual(ids(filterShelf(shelf, { zeros: 9 })), [id(2), id(3), id(4)]);
  assert.deepEqual(ids(filterShelf(shelf, { q: 'dead' })), [id(4)]); assert.deepEqual(ids(filterShelf(shelf, { q: 'BEEF' })), [id(4)]);
  assert.deepEqual(ids(filterShelf(shelf, { q: '0xF5E9' })), [id(1)], 'case and a 0x do not matter');
  assert.deepEqual(ids(filterShelf(shelf, { q: ' a2eb f6 ' })), [id(3)], 'spaces are dropped');
  assert.deepEqual(ids(filterShelf(shelf, { zeros: 9, q: 'a2eb' })), [id(3)]); assert.deepEqual(filterShelf(shelf, { zeros: 10, q: 'dead' }), [], 'both must hold');
  assert.deepEqual(filterShelf(shelf, { q: 'xyz' }), [], 'not hex finds nothing'); assert.deepEqual(filterShelf(shelf, { q: 'g0' }), []);
  assert.equal(filterShelf(shelf, { q: '   ' }).length, 4); assert.equal(filterShelf(shelf, { q: null }).length, 4); assert.equal(filterShelf(shelf, { zeros: 11 }).length, 0);
});

test('a bought token: its number and page, the calls that read and use it against cast, and what pasted bytecode may be', () => {
  const gold = Object.fromEntries(readFileSync(new URL('./fixtures/vanity-shop-calldata.txt', import.meta.url), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(' ')));
  const ID = '0x00000000000785882df83d4cc6ed45c21eb1176c0051250123456789abcdef01';
  assert.match(tokenNumber(ID), /^[1-9]\d+$/); assert.equal(BigInt(tokenNumber(ID)), BigInt(ID));
  assert.equal(tokenUrl(ID), `https://etherscan.io/nft/${MARKET}/${BigInt(ID)}`);
  assert.equal(ownerOfData(ID), gold.ownerOf);
  assert.equal(deployData(ID, '0x60016000f3'), gold.deploy, 'five bytes: the code is padded to the word');
  assert.equal(deployData(ID, '0x' + '6001'.repeat(35)), gold.deployLong, 'seventy bytes: two words and a little over');
  assert.equal(deployData(ID.toUpperCase().replace('0X', '0x'), '0X60016000F3'), gold.deploy, 'case and the prefix do not matter');
  assert.equal(decodeAddress('0x' + '00'.repeat(12) + 'ab'.repeat(20)), '0x' + 'ab'.repeat(20)); assert.equal(decodeAddress('0x12'), null); assert.equal(decodeAddress(null), null);
  assert.equal(initcodeOf(' 0x6001 6000\nF3 '), '0x60016000f3'); assert.equal(initcodeOf('60016000f3'), '0x60016000f3');
  for (const bad of ['0x600', '0xzz', '', '0x', '   ', null, undefined, '6001 6000 f']) assert.equal(initcodeOf(bad), null, String(bad));
  assert.equal(initcodeOf('00'.repeat(49152)).length, 2 + 98304, '49,152 bytes is the most the EVM takes'); assert.equal(initcodeOf('00'.repeat(49153)), null);
  assert.ok(deployRefusal(gold['market-error:DeploymentFailed']) && deployRefusal(gold['market-error:NotOwnerNorApproved']));
  assert.notEqual(deployRefusal(gold['market-error:DeploymentFailed']), deployRefusal(gold['market-error:NotOwnerNorApproved']));
  assert.equal(deployRefusal(gold['market-error:DeploymentFailed'] + '00'.repeat(28)), deployRefusal(gold['market-error:DeploymentFailed']), 'with revert data after the selector');
  assert.equal(deployRefusal('0xdeadbeef'), null); assert.equal(deployRefusal(undefined), null);
  // a failed deploy is told apart by its selector, so that the page can ask whether the code works when simply created (ETH sent to the deploy address beforehand is what stops one that does)
  assert.equal(deployFailed(gold['market-error:DeploymentFailed']), true); assert.equal(deployFailed(gold['market-error:DeploymentFailed'].toUpperCase().replace('0X', '0x') + '00'.repeat(28)), true);
  assert.equal(deployFailed(gold['market-error:NotOwnerNorApproved']), false); assert.equal(deployFailed(undefined), false); assert.equal(deployFailed('0x'), false);
  assert.match(ETH_AT_DEPLOY_ADDRESS, /payable/);
});

test('the forwarder is the 35 bytes it is said to be, with the receiver inside and nothing else to change', () => {
  const to = '0x00000000000000000000000000000000000000b2';
  const rt = forwarderRuntime(to);
  // spelled out opcode by opcode: PUSH0 x4, SELFBALANCE, PUSH20 <to>, GAS, CALL, PUSH1 0x22, JUMPI, PUSH0, PUSH0, REVERT, JUMPDEST
  assert.equal(rt, '0x' + '5f5f5f5f' + '47' + '73' + to.slice(2) + '5a' + 'f1' + '6022' + '57' + '5f5f' + 'fd' + '5b');
  assert.equal((rt.length - 2) / 2, 35, 'thirty-five bytes');
  assert.equal(parseInt(rt.slice(2 + 34 * 2, 2 + 35 * 2), 16), 0x5b, 'the jump lands on the JUMPDEST at 0x22, the last byte');
  assert.equal(forwarderInit(to), '0x' + '602380' + '6009' + '5f' + '39' + '5f' + 'f3' + rt.slice(2), 'its creation code copies 0x23 bytes from offset 9 and returns them');
  assert.equal((forwarderInit(to).length - 2) / 2, 44);
  assert.equal(forwarderRuntime(to.toUpperCase().replace('0X', '0x')), rt, 'the case of the address does not matter');
  assert.notEqual(forwarderRuntime('0x00000000000000000000000000000000000000b3'), rt);
});

test('what stops an address from being the one ETH is passed on to', () => {
  const vanity = '0x0000000000f5e9a4599fb175ca03db96a7e19bb3', fine = '0x1111111111111111111111111111111111111111';
  assert.equal(forwardRefusal(fine, vanity), null);
  for (const [bad, re] of [['', /Name the address/], ['0x12', /Name the address/], [null, /Name the address/], ['0x' + '0'.repeat(40), /empty address/], [vanity, /itself/], [vanity.toUpperCase().replace('0X', '0x'), /itself/], [SHOP, /shop, the market, TAC or the swap contracts/], [MARKET, /shop, the market, TAC or the swap contracts/], [TAC, /shop, the market, TAC or the swap contracts/], [ROUTER, /swap contracts/]]) assert.match(forwardRefusal(bad, vanity) ?? '', re, String(bad));
  assert.equal(forwardRefusal(fine, null), null, 'with no address to compare to it is only the others');
});

test('a token id is read as a person types it, and the tokens a wallet bought are found in the shop\'s logs', () => {
  const ID = '0x00000000000785882df83d4cc6ed45c21eb1176c0051250123456789abcdef01';
  assert.equal(parseTokenId(ID), ID); assert.equal(parseTokenId(BigInt(ID).toString()), ID); assert.equal(parseTokenId(' ' + BigInt(ID).toString().replace(/(\d{3})/g, '$1 ') + ' '), ID, 'spaces inside are dropped');
  assert.equal(parseTokenId('0x1'), '0x' + '0'.repeat(63) + '1'); assert.equal(parseTokenId('255'), '0x' + '0'.repeat(62) + 'ff'); assert.equal(parseTokenId('0XFF'), '0x' + '0'.repeat(62) + 'ff');
  for (const bad of ['', '  ', 'abc', '0x', '-1', '1.5', null, undefined, '0x' + '1'.repeat(65), (2n ** 256n).toString()]) assert.equal(parseTokenId(bad), null, String(bad));
  assert.equal(parseTokenId((2n ** 256n - 1n).toString()), '0x' + 'f'.repeat(64));
  const me = '0x1111111111111111111111111111111111111111', you = '0x2222222222222222222222222222222222222222';
  const sold = (n, to, block, idx = 0) => ({ topics: [TOPICS.sold, id(n), topicAddr(to), topicAddr(you)], data: '0x' + w32(5n * W), blockNumber: '0x' + block.toString(16), logIndex: '0x' + idx.toString(16) });
  const logs = [sold(1, me, 100), sold(2, you, 101), sold(3, me, 102, 1), sold(4, me, 102, 0), listed(5, vanityOf(5), 0, 5n * W, 103), gone('unlisted', 6, 104), sold(1, me, 105), null, {}];
  assert.deepEqual(soldTo(logs.filter(Boolean), me), [id(1), id(3), id(4)].sort((a, b) => 0) && [id(1), id(3), id(4)], 'newest first, once each');
  assert.deepEqual(soldTo(logs.filter(Boolean), you), [id(2)]);
  assert.deepEqual(soldTo(logs.filter(Boolean), me.toUpperCase().replace('0X', '0x')), [id(1), id(3), id(4)], 'the case of the address does not matter');
  assert.deepEqual(soldTo(logs.filter(Boolean), '0x3333333333333333333333333333333333333333'), []); assert.deepEqual(soldTo(logs, 'nope'), []); assert.deepEqual(soldTo(null, me), []); assert.deepEqual(soldTo([], me), []);
  assert.equal(addressOfData(ID), readFileSync(new URL('./fixtures/vanity-shop-calldata.txt', import.meta.url), 'utf8').split('\n').find((l) => l.startsWith('addressOf ')).split(' ')[1], 'addressOf against cast');
});

test('paying with ETH: the call to the zap against cast, the next amount of ETH to try, and ETH as text', () => {
  const gold = Object.fromEntries(readFileSync(new URL('./fixtures/vanity-shop-calldata.txt', import.meta.url), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(' ')));
  const ID = '0x00000000000785882df83d4cc6ed45c21eb1176c0051250123456789abcdef01', TO = '0x1111111111111111111111111111111111111111';
  assert.equal(buyWithEthData({ swapData: '0xabcdef', id: ID, to: TO, nonce: 3, maxPrice: 28n * W, deadline: 1800000000 }), gold.buyWithEth);
  // swap data that fills whole words, and longer than one
  const long = '0x' + 'ab'.repeat(64), longer = '0x' + 'cd'.repeat(100);
  for (const sw of [long, longer, '0x']) { const d = buyWithEthData({ swapData: sw, id: ID, to: TO, nonce: 0, maxPrice: 1n, deadline: 1 }); assert.equal((d.length - 2) % 64, 8, 'the selector and whole words'); assert.equal(BigInt('0x' + d.slice(10 + 6 * 64, 10 + 7 * 64)), BigInt((sw.length - 2) / 2), 'the length word'); }
  assert.equal(ZAP, '0x000000000110d317ed602ca7ef10a72bd72bd56f', 'the deployed zap, in lower case like the other addresses the page compares'); assert.equal(ZAP_MARGIN_BPS, 150n);
  assert.equal(retryAmountIn(10n ** 15n, 28n * W, 20n * W), 1400000000000001n, 'scaled to what is wanted, and a wei over');
  assert.ok(retryAmountIn(1000n, 7n, 3n) * 3n >= 7000n, 'never short');
  assert.equal(ethText(12345678901234567n), '0.0123'); assert.equal(ethText(123456789012345n), '0.00012'); assert.equal(ethText(2500000000000000000n), '2.500'); assert.equal(ethText(0n), '0'); assert.equal(ethText(999999999999999999n), '1.000');
});
