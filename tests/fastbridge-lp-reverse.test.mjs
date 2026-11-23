// What the provider process puts around the reverse side (fastbridge-lp/lib/reverse.mjs): the key and seed of its own, the options (off unless switched on, the
// cautious defaults), the notes it reads from the address, and the routing of /reverse/ to it.
//   node tests/fastbridge-lp-reverse.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reverseKeyOf, reverseSeedOf, reverseOptions, makeReverseInventory, routed } from '../fastbridge-lp/lib/reverse.mjs';
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
  assert.equal(o.csvBlocks, 72); assert.equal(o.evmWindowSecs, 14400); assert.equal(o.anyTac, true); assert.equal(o.refreshSecs, 60);
  assert.deepEqual(o.policy, { minClaimSecs: 3600, offerWaitSecs: 7200, maxEvmWindowSecs: 21600 });
  assert.equal(o.alertSecs, 3600);
});

test('the terms and the ceiling follow what is set; more confirmations for a larger send', () => {
  const o = reverseOptions({ ...FULL, alertSecs: 60, reverse: { enabled: true, feeBps: 0, flatFee: '5', minAmount: '7', maxAmount: '9', maxOpen: 4, maxTac: '1500.5', anyTac: false } });
  assert.equal(o.quote.feeBps, 0, 'a fee of 0 is a fee of 0, not the default');
  assert.deepEqual([o.quote.flatFee, o.quote.minAmount, o.quote.maxAmount, o.maxOpen, o.anyTac, o.alertSecs], ['5', '7', '9', 4, false, 60]);
  assert.equal(o.maxLocked, 150050000000n, '1500.5 TAC in the pool\'s 8 places');
  assert.equal(reverseOptions({ ...FULL, reverse: { enabled: true, maxOpen: 0 } }).maxOpen, 0, 'a config with 0 sends at once takes none (it is not the default of 2)');
  assert.equal(reverseOptions({ ...FULL, reverse: { enabled: true, maxTac: '0.00000001' } }).maxLocked, 1n);
  assert.equal(reverseOptions({ ...FULL, reverse: { enabled: true, maxTac: '12' } }).maxLocked, 1200000000n);
  const c = o.minConfsFor, T = 10n ** 8n;
  assert.deepEqual([c(1n), c(999n * T), c(1000n * T), c(9999n * T), c(10000n * T), c('10000' + '00000000')], [1, 1, 2, 2, 3, 3]);
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
  assert.deepEqual(notes[0], { txid: 'dd'.repeat(32), vout: 0, value: 700, amount: 12345678901234n, blinding: 7n });
  assert.deepEqual([notes[1].amount, notes[1].blinding, notes[1].value], [42n, 77n, 546], 'amounts read as numbers or strings come out as BigInt');
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
