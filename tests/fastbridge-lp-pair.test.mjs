// The daemon's BTC-ETH pair mode (fastbridge-lp/lib/pair.mjs, lib/env-config.mjs): the config it checks and fills in, the price feed it builds from Chainlink and the
// exchange tickers, the confirmations schedule in sats, the reverse side's options and inventory, and the environment knobs. Nothing reads a network.
//   node tests/fastbridge-lp-pair.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pairConfig, pairFeed, satsConfsFor, pairReverseOptions, satsInventory, isPair, PAIR } from '../fastbridge-lp/lib/pair.mjs';
import { applyEnv } from '../fastbridge-lp/lib/env-config.mjs';
import { SATS_ASSET, ETH_ASSET } from '../dapp/fastbridge-pair.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const example = JSON.parse(readFileSync(new URL('../fastbridge-lp/config.btc-eth.example.json', import.meta.url), 'utf8'));

test('the example config is a valid pair config, and the assets are the sats asset and the pool\'s ETH whatever the file says', () => {
  assert.equal(isPair(example), true);
  const C = pairConfig({ ...example, btcAsset: 'ff'.repeat(32), evmAsset: '0x' + 'ee'.repeat(32), refill: { treasury: '0x' + '11'.repeat(20) } });
  assert.equal(C.btcAsset, SATS_ASSET);
  assert.equal(C.evmAsset, ETH_ASSET);
  assert.equal(C.refill, false, 'there is no TAC to lend, so no refill from a treasury');
  assert.deepEqual([C.quote.minAmount, C.quote.maxAmount, C.quote.feeBps, C.quote.flatFee], ['50000', '5000000', 30, '1000']);
  assert.equal(isPair({}), false);
  assert.equal(isPair({ pair: 'tac' }), false);
});

test('the Render config is a valid pair config on the Render disk, canary-sized, with the reverse side off until it is switched on', () => {
  const R = JSON.parse(readFileSync(new URL('../fastbridge-lp/config.btc-eth.render.json', import.meta.url), 'utf8'));
  const C = pairConfig(R);
  assert.equal(C.btcAsset, SATS_ASSET); assert.equal(C.evmAsset, ETH_ASSET); assert.equal(C.refill, false);
  assert.equal(C.dataDir, '/var/lib/tacit-fastbridge-pair', 'a disk of its own, not the house provider\'s');
  assert.equal(C.port, 10000);
  assert.deepEqual([C.quote.minAmount, C.quote.maxAmount], ['50000', '300000'], 'a canary: 0.0005 to 0.003 BTC');
  assert.equal(C.reverse.enabled, false);
  assert.deepEqual([C.reverse.maxSats, C.reverse.maxOpen], ['300000', 1]);
  assert.deepEqual(applyEnv(R, { FB_LP_REVERSE: 'on' }).reverse.enabled, true, 'switched on by the environment, without a new image');
  assert.equal(applyEnv(R, { FB_LP_MAX_AMOUNT: '0' }).quote.maxAmount, '0', 'and stopped the way the TAC provider is');
  // not the house provider's: its config names TAC and no pair
  const house = JSON.parse(readFileSync(new URL('../fastbridge-lp/config.render.json', import.meta.url), 'utf8'));
  assert.notEqual(R.dataDir, house.dataDir);
  assert.equal(house.pair, undefined);
});

test('defaults fill what is left out, and a value that is not valid stops the process in a sentence', () => {
  const C = pairConfig({ pair: PAIR, policy: {} });
  assert.deepEqual([C.quote.minAmount, C.quote.maxAmount, C.quote.feeBps, C.quote.flatFee, C.quote.validSecs], ['50000', '5000000', 30, '1000', 300]);
  assert.deepEqual(C.policy.confs, [['0', 1], ['1000000', 2], ['10000000', 3], ['100000000', 6]]);
  assert.throws(() => pairConfig({ pair: PAIR, quote: { minAmount: '19999' } }), /quote\.minAmount \(sats\) must be at least 20000/);
  assert.throws(() => pairConfig({ pair: PAIR, quote: { minAmount: 'abc' } }), /must be a whole number/);
  assert.throws(() => pairConfig({ pair: PAIR, quote: { feeBps: 501 } }), /quote\.feeBps must be 0 to 500/);
  assert.throws(() => pairConfig({ pair: PAIR, quote: { flatFee: '-1' } }), /quote\.flatFee/);
  // a maximum under the minimum is the way to stop taking swaps and finish the open ones, as for the TAC provider
  assert.equal(pairConfig({ pair: PAIR, quote: { minAmount: '100000', maxAmount: '0' } }).quote.maxAmount, '0');
});

test('the reverse side is checked when it is on and left alone when it is not', () => {
  assert.equal(pairConfig({ pair: PAIR, reverse: { enabled: false } }).reverse.enabled, false);
  const C = pairConfig({ pair: PAIR, reverse: { enabled: true } });
  assert.deepEqual([C.reverse.minAmount, C.reverse.maxAmount, C.reverse.feeBps, C.reverse.flatFee, C.reverse.maxSats, C.reverse.maxOpen, C.reverse.lockFeeReserve], ['1000000', '100000000', 30, '20000', '5000000', 2, '20000']);
  assert.throws(() => pairConfig({ pair: PAIR, reverse: { enabled: true, maxSats: '100' } }), /reverse\.maxSats must be at least 20000/);
  assert.throws(() => pairConfig({ pair: PAIR, reverse: { enabled: true, feeBps: 900 } }), /reverse\.feeBps must be 0 to 500/);
});

const REAL_ROUND = '0x000000000000000000000000000000000000000000000002000000000000637e00000000000000000000000000000000000000000000000000000000002ad77e000000000000000000000000000000000000000000000000000000006b042d18000000000000000000000000000000000000000000000000000000006b042d2f000000000000000000000000000000000000000000000002000000000000637e';
const call = async (to, data) => (data === '0x313ce567' ? '0x' + '0'.repeat(63) + '8' : REAL_ROUND);
const fetchImpl = async (u) => (/coinbase/.test(u) ? { ok: true, json: async () => ({ price: '0.02808' }) } : { ok: true, json: async () => ({ result: { X: { c: ['0.02806'] } } }) });

test('the price feed is Chainlink through the RPC and the exchange tickers, which agree here: three sources, ETH per BTC near 35.6', async () => {
  const feed = pairFeed({ call, fetchImpl, now: () => 0x6b042d2f + 60, C: example });
  const r = await feed.refresh();
  assert.equal(r.n, 3);
  assert.ok(r.ethPerBtc > 35.5 && r.ethPerBtc < 35.7, String(r.ethPerBtc));
  assert.ok(feed.rate());
  const only = pairFeed({ call, fetchImpl, now: () => 0x6b042d2f + 60, C: { rate: { sources: ['chainlink', 'coinbase'], minSources: 2 } } });
  assert.equal((await only.refresh()).n, 2);
  assert.throws(() => pairFeed({ call, fetchImpl, C: { rate: { sources: ['chainlink', 'bitstamp'] } } }), /bitstamp, which is not one of/);
});

test('a feed whose sources disagree gives no price, so the provider quotes nothing', async () => {
  const off = async (u) => (/coinbase/.test(u) ? { ok: true, json: async () => ({ price: '0.0310' }) } : { ok: true, json: async () => ({ result: { X: { c: ['0.02806'] } } }) });
  const feed = pairFeed({ call, fetchImpl: off, now: () => 0x6b042d2f + 60, C: { rate: { sources: ['coinbase', 'kraken'], minSources: 2, maxSpreadBps: 100 } } });
  assert.equal(await feed.refresh(), null);
  assert.equal(feed.rate(), null);
});

test('the confirmations schedule is in sats: one under 0.01 BTC, two, three and six above', () => {
  const f = satsConfsFor(example.policy.confs);
  assert.deepEqual([0n, 999_999n, 1_000_000n, 9_999_999n, 10_000_000n, 99_999_999n, 100_000_000n].map((v) => f(v)), [1, 1, 2, 2, 3, 3, 6]);
  assert.equal(satsConfsFor(null)(500_000_000n), 6, 'the default schedule');
});

test('the reverse options carry the price as a function of the feed, the sats ceiling, and the confirmations the user wants on the provider\'s lock', () => {
  assert.equal(pairReverseOptions(pairConfig({ pair: PAIR }), { rate: () => null }), null);
  let live = { num: 3_560_000_000n, den: 100_000_000n };
  const o = pairReverseOptions(pairConfig({ ...example, reverse: { ...example.reverse, enabled: true } }), { rate: () => live });
  assert.deepEqual([o.quote.btcAsset, o.quote.evmAsset, o.quote.minAmount, o.quote.maxAmount, o.quote.feeBps, o.quote.flatFee], [SATS_ASSET, ETH_ASSET, '1000000', '100000000', 30, '20000']);
  assert.equal(o.quote.rate().num, 3_560_000_000n);
  live = null;
  assert.equal(o.quote.rate(), null, 'the price follows the feed, and is none when the feed has none');
  assert.deepEqual([o.maxLocked, o.maxOpen, o.csvBlocks, o.lockFeeReserve], [5_000_000n, 2, 96, '20000']);
  assert.deepEqual([999_999n, 1_000_000n, 10_000_000n, 100_000_000n].map((v) => o.minConfsFor(v)), [1, 2, 3, 6]);
});

test('the reverse inventory is the coins of the dedicated address, each with its value as its amount', async () => {
  const inv = satsInventory({ satsUtxos: async () => [{ txid: 'aa', vout: 1, value: 300_000 }, { txid: 'bb', vout: 0, value: 20_000 }] });
  assert.deepEqual(await inv.notes(), [{ txid: 'aa', vout: 1, value: 300_000, amount: 300_000n }, { txid: 'bb', vout: 0, value: 20_000, amount: 20_000n }]);
});

test('the environment can switch pair mode on or off and cap what the reverse side puts out; a value that is not valid is an error', () => {
  assert.equal(applyEnv({}, { FB_LP_PAIR: 'btc-eth' }).pair, 'btc-eth');
  assert.equal(applyEnv({ pair: 'btc-eth' }, { FB_LP_PAIR: 'off' }).pair, undefined);
  assert.equal(applyEnv({ pair: 'btc-eth' }, {}).pair, 'btc-eth');
  assert.throws(() => applyEnv({}, { FB_LP_PAIR: 'tac-tac' }), /FB_LP_PAIR must be btc-eth or off/);
  assert.equal(applyEnv({ reverse: { enabled: true } }, { FB_LP_REVERSE_MAX_SATS: '2500000' }).reverse.maxSats, '2500000');
  assert.throws(() => applyEnv({}, { FB_LP_REVERSE_MAX_SATS: '2.5' }), /whole number/);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} pair provider checks passed`);
process.exit(process.exitCode || 0);
