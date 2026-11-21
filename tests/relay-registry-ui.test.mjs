// dapp/relay-registry-ui.js: the registry calls, their answers, and what each entry is. The calldata is what `cast calldata` makes and the answers are the registry's own,
// read from Ethereum (tests/fixtures/relay-registry-ui.json), so the encoding is checked against something other than itself.
//   node tests/relay-registry-ui.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calls, decodeRelay, decodeString, readEntries, stateOf, mine, urlProblem, tacText, parseTac, RELAY_REGISTRY, TAC } from '../dapp/relay-registry-ui.js';

let n = 0;
const check = async (name, fn) => { await fn(); n++; console.log(`ok - ${name}`); };
const fx = JSON.parse(readFileSync(new URL('./fixtures/relay-registry-ui.json', import.meta.url), 'utf8'));
const E18 = 10n ** 18n;

await check('every call is the calldata cast makes, to the registry (or to TAC for the allowance and the approval)', () => {
  const same = (c, to, data) => { assert.equal(c.to, to); assert.equal(c.data.toLowerCase(), data.toLowerCase()); };
  same(calls.count(), RELAY_REGISTRY, fx.calldata.count);
  same(calls.minStake(), RELAY_REGISTRY, fx.calldata.minStake);
  same(calls.unstakeDelay(), RELAY_REGISTRY, fx.calldata.unstakeDelay);
  same(calls.relays(1), RELAY_REGISTRY, fx.calldata.relays1);
  same(calls.urlOf(1), RELAY_REGISTRY, fx.calldata.urlOf1);
  same(calls.topUp(1, 1000n * E18), RELAY_REGISTRY, fx.calldata.topUp1);
  same(calls.startExit(1), RELAY_REGISTRY, fx.calldata.startExit1);
  same(calls.finishExit(1), RELAY_REGISTRY, fx.calldata.finishExit1);
  same(calls.setUrl(1, fx.url), RELAY_REGISTRY, fx.calldata.setUrl1);
  same(calls.setUrl(77, 'https://' + 'a'.repeat(104) + '/evm-pool/keeper'), RELAY_REGISTRY, fx.calldata.setUrlLong);
  same(calls.approve(1000n * E18), TAC, fx.calldata.approve);
  same(calls.allowance(fx.owner), TAC, fx.calldata.allowance);
  same(calls.balanceOf(fx.owner), TAC, fx.calldata.balanceOf);
});
await check('the registry\'s real answers decode: the entry, its url, and the numbers', () => {
  const r = decodeRelay(fx.real.relays1);
  assert.equal(r.relayer.toLowerCase(), '0x7c9f8ae4e48cbb2727f95b6477a1cf92bcfc43d0');
  assert.equal(r.owner.toLowerCase(), fx.owner.toLowerCase());
  assert.equal(r.chainId, 1); assert.equal(r.exitAt, 0); assert.equal(r.stake, 1000n * E18);
  assert.equal(decodeString(fx.real.urlOf1), 'https://tacit-evm-pool-keepers.onrender.com/1/evm-pool/keeper');
  assert.equal(BigInt(fx.real.count), 1n); assert.equal(BigInt(fx.real.minStake), 1000n * E18); assert.equal(BigInt(fx.real.unstakeDelay), 7n * 86400n);
});
await check('an entry that does not exist, and answers of the wrong shape, are null and never a throw', () => {
  assert.equal(decodeRelay('0x' + '00'.repeat(192)), null, 'relayer zero: no such entry');
  for (const bad of [null, undefined, 5, '', '0x', '0x00', fx.real.relays1.slice(0, -2), fx.real.relays1 + '00', 'nonsense']) { assert.equal(decodeRelay(bad), null); assert.equal(decodeString(bad), null); }
  assert.equal(decodeString('0x' + (32).toString(16).padStart(64, '0') + '00'.repeat(32)), '', 'an empty string');
  assert.equal(decodeString('0x' + '00'.repeat(64)), null, 'an offset that is not 32');
  const long = '0x' + (32).toString(16).padStart(64, '0') + (100000).toString(16).padStart(64, '0');
  assert.equal(decodeString(long), null, 'a length beyond the answer');
});
await check('every entry is read with its url, a few at a time; one that cannot be read, or has left, is left out; no registry is []', async () => {
  const live = new Map([[1, fx.real.relays1]]);
  const asked = [];
  const call = async (to, data) => {
    asked.push(data.slice(0, 10));
    if (data.startsWith('0x06661abd')) return '0x' + (3).toString(16).padStart(64, '0');
    const id = Number(BigInt('0x' + data.slice(10, 74)));
    if (data.startsWith('0xe1137f19')) { if (id === 2) throw new Error('node'); return id === 3 ? '0x' + '00'.repeat(192) : fx.real.relays1; }
    return fx.real.urlOf1;
  };
  const entries = await readEntries({ call });
  assert.deepEqual(entries.map((e) => e.id), [1], 'entry 2 failed to read and entry 3 has left');
  assert.equal(entries[0].url, 'https://tacit-evm-pool-keepers.onrender.com/1/evm-pool/keeper');
  assert.deepEqual(await readEntries({ call: async () => { throw new Error('no node'); } }).catch(() => 'threw'), 'threw', 'a registry that cannot be asked at all is the caller\'s to report');
  assert.deepEqual(await readEntries({ call: async () => '0x' + '00'.repeat(32) }), [], 'none made');
  const big = await readEntries({ call: async (to, data) => (data.startsWith('0x06661abd') ? '0x' + (10 ** 9).toString(16).padStart(64, '0') : '0x' + '00'.repeat(192)), limit: 20 });
  assert.deepEqual(big, [], 'a count beyond the limit is read only up to it');
});
await check('what an entry is: listed, below the minimum, leaving until a date, and ready to take out', () => {
  const min = 1000n * E18, now = 2_000_000_000;
  const e = { stake: min, exitAt: 0 };
  assert.equal(stateOf(e, { now, minStake: min }), 'listed');
  assert.equal(stateOf({ ...e, stake: min - 1n }, { now, minStake: min }), 'below');
  assert.equal(stateOf({ ...e, exitAt: now + 5 }, { now, minStake: min }), 'leaving');
  assert.equal(stateOf({ ...e, exitAt: now }, { now, minStake: min }), 'ready', 'the moment it is reached');
  assert.equal(stateOf({ ...e, stake: 1n, exitAt: now - 1 }, { now, minStake: min }), 'ready', 'leaving wins over below');
});
await check('the entries an account owns, in any case; none for something that is not an address', () => {
  const es = [{ id: 1, owner: fx.owner }, { id: 2, owner: '0x' + 'ab'.repeat(20) }];
  assert.deepEqual(mine(es, fx.owner.toUpperCase().replace('0X', '0x')).map((e) => e.id), [1]);
  assert.deepEqual(mine(es, 'nope'), []); assert.deepEqual(mine(es, null), []);
});
await check('the contract\'s url rule, before a transaction is asked for', () => {
  assert.equal(urlProblem('https://relay.example/1/evm-pool/keeper'), null);
  assert.equal(urlProblem('https://a/evm-pool/keeper'), null, 'the shortest the contract takes (25): which hosts a wallet calls is the wallet\'s rule');
  assert.equal(urlProblem('https://' + 'a'.repeat(104) + '/evm-pool/keeper'), null, '128 characters');
  for (const bad of ['', null, 'http://relay.example/evm-pool/keeper', 'https://relay.example/evm-pool/keepers', 'https://./evm-pool/keeper', 'https://relay example/evm-pool/keeper', 'https://relay.example/evm-pool/keeper?x', 'https://' + 'a'.repeat(105) + '/evm-pool/keeper']) assert.notEqual(urlProblem(bad), null, String(bad));
});
await check('TAC amounts: written as people write them, read back exactly, and refused when they are not amounts', () => {
  assert.equal(tacText(1000n * E18), '1,000'); assert.equal(tacText(1500n * E18 / 1000n), '1.5'); assert.equal(tacText(0n), '0'); assert.equal(tacText(2500n * E18 + E18 / 100n), '2,500.01');
  assert.equal(parseTac('1,000'), 1000n * E18); assert.equal(parseTac(' 2.5 '), 25n * E18 / 10n); assert.equal(parseTac('0.000000000000000001'), 1n);
  for (const bad of ['', 'abc', '1e3', '-1', '1.', '.5', '1.0000000000000000001', null]) assert.equal(parseTac(bad), null, String(bad));
});
console.log(`\n${n} passed`);
