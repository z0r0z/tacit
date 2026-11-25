// What the provider process puts around the reverse side (fastbridge-lp/lib/reverse.mjs): the key and seed of its own, the options (off unless switched on, the
// cautious defaults), the notes it reads from the address, and the routing of /reverse/ to it.
//   node tests/fastbridge-lp-reverse.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reverseKeyOf, reverseSeedOf, reverseOptions, rebalanceOptions, makeReverseInventory, routed } from '../fastbridge-lp/lib/reverse.mjs';
import { SECP_N } from '../dapp/bulletproofs.js';
import { hmac, sha256 } from '../dapp/vendor/tacit-deps.min.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const hex = (b) => Buffer.from(b).toString('hex');
const K1 = Uint8Array.from({ length: 32 }, (_, i) => i + 1), K2 = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const FWD_SEED = (k) => hmac(sha256, k, new TextEncoder().encode('tacit-fastbridge-lp-seed'));

test('the reverse key and seed: fixed by the provider\'s key, a valid scalar, and neither the key nor the forward seed nor each other', () => {
  const k = reverseKeyOf(K1), s = reverseSeedOf(K1);
  assert.equal(hex(k), hex(reverseKeyOf(K1)), 'the same key gives the same address every start');
  assert.equal(k.length, 32); assert.equal(s.length, 32);
  const n = BigInt('0x' + hex(k)); assert.ok(n > 0n && n < SECP_N, 'a private key of the curve');
  assert.notEqual(hex(k), hex(K1), 'not the provider\'s own Bitcoin key (that would be the same address)');
  assert.notEqual(hex(s), hex(FWD_SEED(K1)), 'the swap secrets of the two directions are not drawn from one seed');
  assert.notEqual(hex(s), hex(k), 'a key and a seed are not one thing');
  assert.notEqual(hex(reverseKeyOf(K2)), hex(k), 'another provider key, another address');
  assert.notEqual(hex(reverseSeedOf(K2)), hex(s));
});

const FULL = { btcAsset: 'aa'.repeat(32), evmAsset: '0x' + 'bb'.repeat(20), policy: { evmWindowSecs: 14400, minClaimSecs: 3600 }, quote: {} };

test('off unless the config says on (an absent, empty or any other value is off)', () => {
  assert.equal(reverseOptions(FULL), null);
  assert.equal(reverseOptions({ ...FULL, reverse: {} }), null);
  assert.equal(reverseOptions({ ...FULL, reverse: { enabled: false } }), null);
  for (const v of ['on', 'true', 1, 'yes']) assert.equal(reverseOptions({ ...FULL, reverse: { enabled: v } }), null, 'only the boolean true switches it on: ' + String(v));
  assert.notEqual(reverseOptions({ ...FULL, reverse: { enabled: true } }), null);
});

test('the defaults are the cautious ones, and are the forward side\'s own windows', () => {
  const o = reverseOptions({ ...FULL, reverse: { enabled: true } });
  assert.deepEqual(o.quote, { btcAsset: FULL.btcAsset, evmAsset: FULL.evmAsset, minAmount: '1000000000', maxAmount: '100000000000', feeBps: 30, flatFee: '10000000', validSecs: 600 });
  assert.equal(o.maxOpen, 2); assert.equal(o.maxLocked, 2000n * 10n ** 8n, 'at most 2,000 TAC out at once');
  assert.equal(o.maxOpenPerKey, undefined, 'the TAC service keeps its existing unlimited per-key default');
  assert.equal(o.csvBlocks, 96, 'a lock of 96 blocks leaves the user\'s lock room at once: 72 left no margin at the moment the lock confirms (see fastbridge-el.js)'); assert.equal(o.evmWindowSecs, 14400); assert.equal(o.anyTac, true); assert.equal(o.refreshSecs, 60);
  assert.deepEqual(o.policy, { minClaimSecs: 3600, offerWaitSecs: 7200, maxEvmWindowSecs: 21600 });
  assert.equal(o.alertSecs, 3600);
  assert.equal(o.minProceedsBps, 10000); assert.equal(o.maxFeeRate, null);
  assert.equal(o.rebalance.enabled, false, 'turning reverse on does not turn rebalance on');
});

test('rebalance defaults to disabled and remains readable and validated while reverse is off', () => {
  const T = 10n ** 8n;
  assert.deepEqual(rebalanceOptions(FULL), {
    enabled: false, leases: 'fastbridge-lp/data/reverse/rebalance-leases.json',
    maxNote: 250n * T, maxDaily: 1000n * T, maxInventory: 2000n * T, maxStuck: null,
    maxNoteTac: '250', maxDailyTac: '1000', maxInventoryTac: '2000', maxStuckTac: null,
    maxFeeRate: 25, minSourceConfs: 1, tickSecs: 60, stallSecs: 900,
  });
  const c = { ...FULL, reverse: { enabled: false, rebalance: { enabled: true, maxNoteTac: '2' } } };
  assert.equal(reverseOptions(c), null, 'rebalance on never switches the reverse service on');
  assert.equal(rebalanceOptions(c).enabled, true, 'its own dry-run setting is still available');
  assert.equal(rebalanceOptions(c).maxNote, 2n * T);
  assert.throws(() => rebalanceOptions({ ...FULL, reverse: { enabled: false, rebalance: { maxDailyTac: '0' } } }), /maxDailyTac/, 'an off reverse side does not hide invalid rebalance config');
});

test('proceeds, fee and rebalance settings parse exactly into provider and sidecar options', () => {
  const T = 10n ** 8n;
  const o = reverseOptions({ ...FULL, dataDir: '/srv/lp', reverse: {
    enabled: true, minProceedsBps: 10500, maxFeeRate: 0.75,
    rebalance: { enabled: true, leases: ' /srv/lp/leases/rebalance.json ', maxNoteTac: '0.00000001', maxDailyTac: '1500.12345678', maxInventoryTac: '2000.00000000', maxStuckTac: '2500.5', maxFeeRate: 3.5, minSourceConfs: 6, tickSecs: 5, stallSecs: 45 },
  } });
  assert.equal(o.minProceedsBps, 10500); assert.equal(o.maxFeeRate, 0.75);
  assert.deepEqual(o.rebalance, {
    enabled: true, leases: '/srv/lp/leases/rebalance.json',
    maxNote: 1n, maxDaily: 1500n * T + 12345678n, maxInventory: 2000n * T, maxStuck: 2500n * T + 50000000n,
    maxNoteTac: '0.00000001', maxDailyTac: '1500.12345678', maxInventoryTac: '2000.00000000', maxStuckTac: '2500.5',
    maxFeeRate: 3.5, minSourceConfs: 6, tickSecs: 5, stallSecs: 45,
  });
  assert.equal(rebalanceOptions({ ...FULL, dataDir: '/srv/lp' }).leases, '/srv/lp/reverse/rebalance-leases.json', 'the default lease path follows dataDir');
});

test('maxStuckTac is separate from maxInventoryTac and is required for enabled live rebalance', () => {
  const rebalance = { enabled: true, maxNoteTac: '10', maxDailyTac: '100', maxInventoryTac: '20' };
  const live = { ...FULL, reverse: { enabled: true, rebalance } };
  assert.throws(() => reverseOptions(live), /maxStuckTac.*required.*live/);
  const dry = rebalanceOptions({ ...FULL, reverse: { enabled: false, rebalance } });
  assert.equal(dry.maxInventory, 20n * 10n ** 8n);
  assert.equal(dry.maxStuck, null, 'a dry-run parser can still read the other settings');
  const parsed = reverseOptions({ ...FULL, reverse: { enabled: true, rebalance: { ...rebalance, maxStuckTac: '30' } } }).rebalance;
  assert.equal(parsed.maxInventory, 20n * 10n ** 8n, 'the reverse-stock admission cap is unchanged');
  assert.equal(parsed.maxStuck, 30n * 10n ** 8n, 'total measured stuck exposure has its own ceiling');
});

test('invalid proceeds floors, fee ceilings, caps, paths and timing values are refused', () => {
  for (const value of [9999, 1000001, 10000.5, -1, 0, '1e4', 'lots']) {
    assert.throws(() => reverseOptions({ ...FULL, reverse: { enabled: true, minProceedsBps: value } }), /minProceedsBps/, String(value));
  }
  for (const value of [0, -1, '0', '1e2', 'Infinity', Infinity, NaN, true]) {
    assert.throws(() => reverseOptions({ ...FULL, reverse: { enabled: true, maxFeeRate: value } }), /maxFeeRate/, String(value));
  }
  for (const key of ['maxNoteTac', 'maxDailyTac', 'maxInventoryTac', 'maxStuckTac']) {
    for (const value of ['0', '0.00000000', '-1', '1.123456789', '1.', '.5', '1e2', 'lots']) {
      assert.throws(() => rebalanceOptions({ ...FULL, reverse: { enabled: false, rebalance: { [key]: value } } }), new RegExp(key), `${key}=${value}`);
    }
  }
  for (const value of ['', '  ', 'bad\0path', 42]) assert.throws(() => rebalanceOptions({ ...FULL, reverse: { rebalance: { leases: value } } }), /leases/);
  for (const [key, values, max] of [['minSourceConfs', [0, -1, 1.5, 1001], 1000], ['tickSecs', [0, -1, 1.5, 3601], 3600], ['stallSecs', [0, -1, 1.5, 86401], 86400]]) {
    for (const value of values) assert.throws(() => rebalanceOptions({ ...FULL, reverse: { rebalance: { [key]: value } } }), new RegExp(key), `${key}=${value}`);
    assert.equal(rebalanceOptions({ ...FULL, reverse: { rebalance: { [key]: 1 } } })[key], 1);
    assert.equal(rebalanceOptions({ ...FULL, reverse: { rebalance: { [key]: max } } })[key], max);
  }
  for (const value of ['0', '-2', '1e2', 'lots']) assert.throws(() => rebalanceOptions({ ...FULL, reverse: { rebalance: { maxFeeRate: value } } }), /maxFeeRate/);
  for (const value of ['yes', [], 1]) assert.throws(() => rebalanceOptions({ ...FULL, reverse: { rebalance: value } }), /reverse\.rebalance must be an object/);
});

test('the terms and the ceiling follow what is set; more confirmations for a larger send', () => {
  const o = reverseOptions({ ...FULL, alertSecs: 60, reverse: { enabled: true, feeBps: 0, flatFee: '5', minAmount: '7', maxAmount: '9', maxOpen: 4, maxTac: '1500.5', anyTac: false } });
  assert.equal(o.quote.feeBps, 0, 'a fee of 0 is a fee of 0, not the default');
  assert.deepEqual([o.quote.flatFee, o.quote.minAmount, o.quote.maxAmount, o.maxOpen, o.anyTac, o.alertSecs], ['5', '7', '9', 4, false, 60]);
  assert.equal(o.maxLocked, 150050000000n, '1500.5 TAC in the pool\'s 8 places');
  assert.equal(reverseOptions({ ...FULL, reverse: { enabled: true, maxOpen: 20 } }).maxOpen, 20, 'the configured upper bound remains valid');
  assert.equal(reverseOptions({ ...FULL, reverse: { enabled: true, maxTac: '0.00000001' } }).maxLocked, 1n);
  assert.equal(reverseOptions({ ...FULL, reverse: { enabled: true, maxTac: '12' } }).maxLocked, 1200000000n);
  const c = o.minConfsFor, T = 10n ** 8n;
  assert.deepEqual([c(1n), c(999n * T), c(1000n * T), c(9999n * T), c(10000n * T), c('10000' + '00000000')], [1, 1, 2, 2, 3, 3]);
});

test('maxTac uses strict decimal parsing and maxOpen is an integer from 1 to 20', () => {
  for (const value of ['0', '0.00000000', '-1', '1.', '.5', '1.123456789', '1e2', 'lots', Infinity, NaN, true]) {
    assert.throws(() => reverseOptions({ ...FULL, reverse: { enabled: true, maxTac: value } }), /reverse\.maxTac/, String(value));
  }
  for (const value of [0, 21, -1, 1.5, '1.5', '1e2', 'lots', Infinity, NaN, true]) {
    assert.throws(() => reverseOptions({ ...FULL, reverse: { enabled: true, maxOpen: value } }), /reverse\.maxOpen/, String(value));
  }
  const o = reverseOptions({ ...FULL, reverse: { enabled: true, maxTac: ' 12.50000000 ', maxOpen: ' 3 ' } });
  assert.equal(o.maxLocked, 1250000000n);
  assert.equal(o.maxOpen, 3);
});

// The user's lock follows the provider's once the user's client is satisfied that the Bitcoin refund opens two hours after the Ethereum deadline, counting blocks at five minutes (adaptor-xswap.js
// checkEvmDeadline). The deadline is the window after the lock's block; at 72 blocks the refund is 71 * 300 s away at that moment, 300 s short of window + two hours, so the lock waited some minutes for time to pass (the
// swap of 11-23 was ended by this check before the machine waited for it).
test('the default lock length leaves the user\'s lock room the moment the provider\'s lock confirms (72 blocks was 300 s short)', async () => {
  const X = await import('../dapp/adaptor-xswap.js'), { lockDeadline } = await import('../dapp/fastbridge-el.js');
  const o = reverseOptions({ ...FULL, reverse: { enabled: true } });
  const blockTime = 1_800_000_123, lockHeight = 100_000;
  const margin = (csvBlocks) => {
    const deadline = lockDeadline({ blockTime, windowSecs: o.evmWindowSecs, roundSecs: 600 });
    const opens = X.btcRefundOpensAt({ lockHeight, csvBlocks, tipHeight: lockHeight, nowSecs: blockTime });
    return { reasons: X.checkEvmDeadline({ deadline, nowSecs: blockTime, btcRefundOpens: opens, minClaimSecs: 3600, claimSlackSecs: 7200 }), by: opens - (deadline + 7200) };
  };
  assert.deepEqual(margin(o.csvBlocks).reasons, [], 'the default passes at the moment the lock confirms, by ' + margin(o.csvBlocks).by + ' s');
  assert.ok(margin(o.csvBlocks).by >= 3600, 'with an hour to spare, so a late look does not fail it either');
  assert.equal(margin(72).reasons.length, 1, '72 blocks does not (the reason is the refund margin)');
});

const ASSET = 'cc'.repeat(32);
const held = (o) => ({ utxo: { txid: 'dd'.repeat(32), vout: 0, value: 700, status: { confirmed: true }, ...(o.utxo || {}) }, amount: o.amount ?? 5n, blinding: o.blinding ?? 9n, ...(o.stealth ? { stealthTweakedSk: 1n } : {}) });

test('the notes it reads: this asset\'s confirmed ones at the address, as the lock takes them, and nothing it cannot spend', async () => {
  const all = [
    held({ utxo: { vout: 0 }, amount: 12345678901234n, blinding: 7n }),
    held({ utxo: { vout: 1, status: { confirmed: false } } }),
    held({ utxo: { vout: 2, status: undefined } }),
    held({ utxo: { vout: 3 }, stealth: true }),
    held({ utxo: { vout: 4, txid: 'ee'.repeat(32), value: 546 }, amount: '42', blinding: '77' }),
  ];
  const tacit = { scanHoldings: async () => new Map([[ASSET, { utxos: all }], ['ff'.repeat(32), { utxos: [held({ utxo: { vout: 9 } })] }]]) };
  const notes = await makeReverseInventory({ tacit, asset: ASSET }).notes();
  assert.deepEqual(notes.map((n) => `${n.txid.slice(0, 2)}:${n.vout}`), ['dd:0', 'ee:4'], 'an unconfirmed note, one with no status, a stealth one and another asset\'s are left out');
  assert.deepEqual(notes[0], { txid: 'dd'.repeat(32), vout: 0, value: 700, amount: 12345678901234n, blinding: 7n, confirmed: true });
  assert.deepEqual([notes[1].amount, notes[1].blinding, notes[1].value], [42n, 77n, 546], 'amounts read as numbers or strings come out as BigInt');
  const accounting = await makeReverseInventory({ tacit, asset: ASSET, includeUnconfirmed: true }).notes();
  assert.deepEqual(accounting.map((n) => [n.vout, n.confirmed]), [[0, true], [1, false], [4, true]], 'accounting alone includes unconfirmed notes with their flags; missing status and stealth notes stay excluded');
});

test('no notes when the scan finds none of the asset, and it does not guess when the scan is not what it expects', async () => {
  const none = (v) => makeReverseInventory({ tacit: { scanHoldings: async () => v }, asset: ASSET }).notes();
  assert.deepEqual(await none(new Map()), []);
  assert.deepEqual(await none(new Map([[ASSET, {}]])), []);
  assert.deepEqual(await none(new Map([[ASSET, { utxos: [] }]])), []);
  assert.deepEqual(await none(null), []);
  assert.deepEqual(await none({ [ASSET]: { utxos: [held({})] } }), [], 'a plain object is not the scan\'s map');
  const logged = [];
  await assert.rejects(() => makeReverseInventory({ tacit: { scanHoldings: async () => { throw new Error('indexer down'); } }, asset: ASSET, log: (o) => logged.push(o) }).notes(), /indexer down/, 'a failed scan is a failure, never an empty address');
  assert.equal(logged.length, 1); assert.equal(logged[0].level, 'warn'); assert.match(logged[0].error, /indexer down/, 'and it is logged, with the reason');
  await assert.rejects(() => makeReverseInventory({ tacit: { scanHoldings: async () => { throw new Error('x'); } }, asset: ASSET }).notes(), /x/, 'no logger given: still thrown');
});

test('/reverse/ goes to the reverse service and everything else to the one it had', () => {
  const seen = [];
  const h = routed((r) => { seen.push(['fwd', r?.path]); return 'F'; }, (r) => { seen.push(['rev', r?.path]); return 'R'; });
  assert.equal(h({ path: '/reverse/info' }), 'R'); assert.equal(h({ path: '/reverse/swap/' + 'ab'.repeat(36) + '/offer' }), 'R');
  assert.equal(h({ path: '/info' }), 'F'); assert.equal(h({ path: '/quote' }), 'F'); assert.equal(h({ path: '/swap/abc' }), 'F');
  assert.equal(h({ path: '/reverse' }), 'F', 'only the /reverse/ tree');
  assert.equal(h({ path: '/reversed/x' }), 'F'); assert.equal(h({ path: '/x/reverse/info' }), 'F');
  assert.equal(h({ path: undefined }), 'F'); assert.equal(h({}), 'F'); assert.equal(h(null), 'F');
  assert.deepEqual(seen.filter(([w]) => w === 'rev').length, 2);
});

test('the example is disabled, contains no lease data, and its rebalance settings pass validation', () => {
  const example = JSON.parse(readFileSync(new URL('../fastbridge-lp/config.example.json', import.meta.url), 'utf8'));
  assert.equal(example.reverse.enabled, false); assert.equal(example.reverse.rebalance.enabled, false);
  assert.equal(reverseOptions(example), null);
  assert.equal(rebalanceOptions(example).leases, example.reverse.rebalance.leases);
  assert.equal(rebalanceOptions(example).maxNote, 250n * 10n ** 8n);
  assert.equal(rebalanceOptions(example).maxStuckTac, example.reverse.rebalance.maxStuckTac);
});

test('the daemon logs the proceeds floor and alerts on reverse tick failure and recovery, with repeats throttled', () => {
  const src = readFileSync(new URL('../fastbridge-lp/server.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('let rbusy = false'), end = src.indexOf('handle = routed', start);
  assert.ok(start > 0 && end > start);
  const tick = src.slice(start, end);
  assert.match(tick, /const summary = await reverse\.tick\(\)/);
  assert.match(tick, /summary\.tickOk !== true/, 'an internally failed tick takes the daemon failure path even though the service returned normally');
  assert.match(tick, /summary\.lastError/, 'the service health summary supplies the failure reason');
  assert.match(tick, /error\.reverseAlerted = true/, 'the service has already alerted for a failure returned in its health summary');
  assert.match(tick, /!e\?\.reverseAlerted && \(!rtickFailed/, 'the daemon does not send a second alert for that same failure');
  assert.doesNotMatch(tick, /summary\.(?:ok|swapsReadable)/, 'record health does not stop readable swaps from being ticked');
  assert.match(tick, /alert\(failure\)/); assert.match(tick, /C\.alertSecs \?\? 3600/); assert.match(tick, /reverse tick recovered/);
  assert.equal(tick.split('alert(failure)').length - 1, 1, 'one daemon failure alert path handles thrown and returned failures');
  assert.match(tick, /else log\(\{ \.\.\.failure, level: 'error' \}\)/, 'failures inside the alert interval remain in the local log');
  assert.match(src, /feeBps: ropts\.quote\.feeBps, minProceedsBps: ropts\.minProceedsBps/);
  const forward = src.slice(src.indexOf('let busy = false'), src.indexOf('// Keeping the private TAC filled'));
  assert.doesNotMatch(forward, /alert\(|reverse/, 'the forward tick wiring is unchanged');
});

// The reverse side reads its notes with the wallet module. Loaded in the daemon, the module treats the Tacit API's chain proxy as unusable unless it is told it is a headless host
// (before it loads), and then reads the public explorers directly: from Render's shared address every one of those reads was refused "rate limited", so the reverse side could
// not read its own notes ("available: null") for as long as it ran. Measured: flag off, 16 reads to mempool.space and blockstream; flag on, none, all through the proxy.
test('the daemon tells the wallet module it is a headless host, before the module loads and only when the reverse side is on', () => {
  const src = readFileSync(new URL('../fastbridge-lp/server.mjs', import.meta.url), 'utf8');
  const set = src.indexOf('__TACIT_CHAIN_VIA_WORKER__ = true'), load = src.indexOf('await loadTacit(');
  assert.ok(set > 0 && load > 0 && set < load, 'set before the module is loaded (it reads the flag once, as it loads)');
  const line = src.slice(src.lastIndexOf('\n', set) + 1, src.indexOf('\n', set));
  assert.match(line, /^if \(C\.reverse && C\.reverse\.enabled === true\) \{/, 'only for the reverse side, which is the one thing here that reads through the module');
  assert.match(line, /__TACIT_WORKER_BASE__ = process\.env\.TACIT_WORKER_BASE \|\| 'https:\/\/api\.tacit\.finance'/);
  assert.equal(src.split('__TACIT_CHAIN_VIA_WORKER__').length - 1, 1, 'set once, nowhere else');
});

let passed = 0;
for (const [name, fn] of tests) { try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; } }
console.log(`\n${passed}/${tests.length} provider reverse-wiring checks passed`);
process.exit(process.exitCode || 0);
