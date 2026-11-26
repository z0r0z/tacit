// The daemon's BTC-ETH pair mode (fastbridge-lp/lib/pair.mjs, lib/env-config.mjs): the config it checks and fills in, the price feed it builds from Chainlink and the
// exchange tickers, the confirmations schedule in sats, the reverse side's options and inventory, and the environment knobs. Nothing reads a network.
//   node tests/fastbridge-lp-pair.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pairConfig, pairFeed, satsConfsFor, pairReverseOptions, satsInventory, isPair, PAIR } from '../fastbridge-lp/lib/pair.mjs';
import { applyEnv } from '../fastbridge-lp/lib/env-config.mjs';
import { SATS_ASSET, ETH_ASSET } from '../dapp/fastbridge-pair.js';
import { makeFlatFee, flatCeiling } from '../fastbridge-lp/lib/flatfee.mjs';
import { makeQuoter } from '../dapp/fastbridge-provider.js';
import { memStore } from './lib/fastbridge-world.mjs';

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

test('the Render config is a valid pair config on the Render disk, priced from what a swap costs the provider, with the reverse side off until it is switched on', () => {
  const R = JSON.parse(readFileSync(new URL('../fastbridge-lp/config.btc-eth.render.json', import.meta.url), 'utf8'));
  const C = pairConfig(R);
  assert.equal(C.btcAsset, SATS_ASSET); assert.equal(C.evmAsset, ETH_ASSET); assert.equal(C.refill, false);
  assert.equal(C.dataDir, '/var/lib/tacit-fastbridge-pair', 'a disk of its own, not the house provider\'s');
  assert.equal(C.port, 10000);
  assert.deepEqual([C.quote.minAmount, C.quote.maxAmount, C.quote.feeBps, C.quote.flatFee], ['120000', '1000000', 20, '800']);
  assert.equal(C.reverse.enabled, false);
  // reverse terms are in pool ETH units (1e-8 ETH)
  const rv = pairConfig({ ...R, reverse: { ...R.reverse, enabled: true } }).reverse;
  assert.deepEqual([rv.minAmount, rv.maxAmount, rv.feeBps, rv.flatFee, rv.maxOpen, rv.maxSats, rv.lockFeeReserve], ['4000000', '25000000', 20, '30000', 2, '1000000', '2000']);
  // the smallest swap each way stays under the 1% at which a page warns of a price below the market (a fee of F sats and B bps on X sats, X the least taken)
  const RATE = 35.5;                                                      // pool ETH units per sat (about 35.5 ETH per BTC)
  const fwd = (Number(C.quote.flatFee) + Number(C.quote.minAmount) * C.quote.feeBps / 10000) / Number(C.quote.minAmount);
  const rev = (Number(rv.flatFee) + Number(rv.minAmount) * rv.feeBps / 10000) / Number(rv.minAmount);
  assert.ok(fwd < 0.01, `forward minimum costs ${(fwd * 100).toFixed(2)}%`);
  assert.ok(rev < 0.01, `reverse minimum costs ${(rev * 100).toFixed(2)}%`);
  assert.ok(Number(rv.minAmount) / RATE >= 20000, 'the reverse minimum buys more sats than the least a lock may hold');
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
// ── the flat part of the fee following the provider's cost (lib/flatfee.mjs) ──
const RATE = { num: 3550n, den: 100n };                                    // 35.5 pool units per sat
const mkFlat = (o = {}) => {
  const env = { feeRate: 3, relayEth: 20000n, rate: RATE, ok: true };
  const f = makeFlatFee({
    dynamic: true, subsidy: 1, now: () => env.t ?? 1000, alpha: 1,
    fwd: { flat: '400', min: '100', max: '5000', minAmount: '1000000', feeBps: 20 }, rev: { flat: '10000', min: '2000', max: '10000000', minAmount: '40000000', feeBps: 20 },
    read: () => (env.ok ? { feeRate: env.feeRate, relayEth: env.relayEth, rate: RATE } : null), ...o,
  });
  return { f, env };
};
test('the flat part follows the cost at the current feerate, within its limits', () => {
  const { f, env } = mkFlat();
  assert.equal(f.update(), true);
  // forward: 160 vB x 3 + 20000 units / 35.5 = 480 + 563; reverse: 160 x 3 x 35.5 + 20000
  assert.equal(f.fwd(), 1043n);
  assert.equal(f.rev(), 37040n);
  env.feeRate = 30; f.update();
  assert.equal(f.fwd(), 4800n + 563n > 5000n ? 5000n : 4800n + 563n, 'the max holds');
  assert.equal(f.rev(), 170400n + 20000n);
  env.feeRate = 0.0001; env.relayEth = 0n; f.update();
  assert.equal(f.fwd(), 100n, 'the min holds');
  assert.equal(f.rev(), 2000n);
  assert.equal(f.view().dynamic, true);
  assert.equal(f.view().costSats, 0);
});
test('the subsidy is the share of the cost the flat part covers, and 1 from the subsidy date on', () => {
  const { f, env } = mkFlat({ subsidy: 0.5, subsidyUntil: 5000 });
  f.update();
  assert.equal(f.fwd(), 522n);
  assert.equal(f.rev(), 18520n);
  env.t = 6000; f.update();
  assert.equal(f.fwd(), 1043n, 'after the intro the whole cost');
  assert.equal(f.view().subsidy, 1);
});
test('the smallest swap stays well under the pages\' 3% guard: the flat part is capped at 1.5% of the least amount, and the guard less the rate part', () => {
  const { f, env } = mkFlat({ fwd: { flat: '400', min: '100', max: null, minAmount: '25000', feeBps: 20 }, rev: { flat: '10000', min: '2000', max: null, minAmount: '800000', feeBps: 20 } });
  env.feeRate = 500; f.update();
  assert.equal(f.fwd(), 375n);
  assert.equal(f.rev(), 12000n);
  assert.ok((Number(f.fwd()) / 25000 + 0.002) < 0.03 && (Number(f.rev()) / 800000 + 0.002) < 0.03);
  // an explicit max over the cap does not lift it; the guard trims a big rate part
  assert.equal(flatCeiling({ minAmount: '25000', feeBps: 20, max: '99999' }), 375n);
  assert.equal(flatCeiling({ minAmount: '10000', feeBps: 200 }), 50n, 'a 2% rate leaves 0.5% of the 2.5% guard');
});
test('the figure moves only when it is 10% off, and an unreadable estimate keeps the figure, then falls back to the configured fee', () => {
  const { f, env } = mkFlat({ alpha: 1, hysteresis: 0.1 });
  f.update(); const first = f.fwd();
  env.relayEth = 20000n; env.feeRate = 3.1; f.update();
  assert.equal(f.fwd(), first, 'a 3% move is not followed');
  env.feeRate = 4; f.update();
  assert.ok(f.fwd() > first);
  const kept = f.fwd();
  env.ok = false; env.t = 1000 + 600; assert.equal(f.update(), false);
  assert.equal(f.fwd(), kept, 'a read that fails keeps the last figure for a while');
  env.t = 1000 + 3600;
  assert.equal(f.fwd(), 400n, 'then the configured one'); assert.equal(f.rev(), 10000n);
  assert.equal(f.view().live, false);
  const never = mkFlat(); never.env.ok = false;
  assert.equal(never.f.update(), false); assert.equal(never.f.fwd(), 400n);
  const off = makeFlatFee({ dynamic: false, fwd: { flat: '400', minAmount: '1000000', feeBps: 20 }, read: () => ({ feeRate: 50, relayEth: 1n, rate: RATE }) });
  assert.equal(off.update(), false); assert.equal(off.fwd(), 400n, 'off: the configured fee');
});
test('a quote already given is sealed with its amounts, so it does not change when the flat part moves; off, the quote is the static one', async () => {
  const { f, env } = mkFlat();
  f.update();
  const mk = (flatFee) => makeQuoter({ store: memStore(), now: () => 1_800_000_000, macKey: new Uint8Array(32).fill(7), params: { btcAsset: SATS_ASSET, evmAsset: ETH_ASSET, minAmount: 25000, maxAmount: 1_000_000, feeBps: 20, flatFee, rate: RATE, claimPub: '02' + 'aa'.repeat(32), csvBlocks: 144, evmWindowSecs: 14400, minConfsFor: () => 1, takeSats: null } });
  const dyn = mk(() => f.fwd()), stat = mk('400');
  const q = await dyn.quote(200000);
  assert.equal(BigInt(q.evmAmount), ((200000n - (200000n * 20n) / 10000n - 1043n) * 3550n) / 100n);
  env.feeRate = 20; f.update();
  assert.ok(f.fwd() > 1043n);
  const again = await dyn.get(q.id);
  assert.equal(again.evmAmount, q.evmAmount, 'the sealed quote reads back as it was given');
  assert.equal(again.btcValue, q.btcValue);
  assert.notEqual((await dyn.quote(200000)).evmAmount, q.evmAmount, 'a new quote follows');
  assert.equal(BigInt((await stat.quote(200000)).evmAmount), ((200000n - 400n - 400n) * 3550n) / 100n, 'a static number is what it was');
  assert.equal(dyn.flat(), f.fwd()); assert.equal(stat.flat(), 400n);
});
test('the environment: the dynamic fee is off unless set, and every value that is set is checked', () => {
  assert.equal(applyEnv({ pair: 'btc-eth' }, {}).feeModel, undefined);
  const C = applyEnv({}, { FB_LP_DYNAMIC_FEE: 'on', FB_LP_FEE_SUBSIDY: '0.25', FB_LP_FEE_SUBSIDY_UNTIL: '2026-12-31', FB_LP_FLAT_FEE_MIN: '100', FB_LP_FLAT_FEE_MAX: '900', FB_LP_REVERSE_FLAT_FEE_MIN: '2000', FB_LP_REVERSE_FLAT_FEE_MAX: '50000' }).feeModel;
  assert.deepEqual([C.dynamic, C.subsidy, C.fwd.min, C.fwd.max, C.rev.min, C.rev.max], [true, 0.25, '100', '900', '2000', '50000']);
  assert.equal(C.subsidyUntil, Math.floor(Date.parse('2026-12-31') / 1000));
  assert.equal(applyEnv({}, { FB_LP_DYNAMIC_FEE: 'off' }).feeModel.dynamic, false);
  assert.throws(() => applyEnv({}, { FB_LP_DYNAMIC_FEE: 'yes' }), /on or off/);
  assert.throws(() => applyEnv({}, { FB_LP_FEE_SUBSIDY: '1.5' }), /0 to 1/);
  assert.throws(() => applyEnv({}, { FB_LP_FLAT_FEE_MAX: '1.5' }), /whole number/);
  assert.throws(() => applyEnv({}, { FB_LP_FEE_SUBSIDY_UNTIL: 'soon' }), /unix seconds or a date/);
});
test('the reverse options carry the flat fee as a function when one is given', () => {
  const R = JSON.parse(readFileSync(new URL('../fastbridge-lp/config.btc-eth.render.json', import.meta.url), 'utf8'));
  const C = pairConfig({ ...R, reverse: { ...R.reverse, enabled: true } });
  assert.equal(pairReverseOptions(C, { rate: () => RATE }).quote.flatFee, '30000');
  assert.equal(pairReverseOptions(C, { rate: () => RATE }, () => 777n).quote.flatFee(), 777n);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} pair provider checks passed`);
process.exit(process.exitCode || 0);
