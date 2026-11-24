// The pair's page wiring (dapp/fast/pair-wire.js) and the discovery it relies on (dapp/fast/discover.js): providers are found by what they swap, so a provider of Bitcoin
// for ETH is never taken for one that bridges TAC (and its sats read as TAC), the page's own price is read from Chainlink through the pool's RPC, the Bitcoin address the
// key makes must be the one the wallet reads, and one tab at a time takes the swaps' steps. The modules import by site path, which a loader hook maps to dapp/.
//   node tests/fastbridge-pair-wire.test.mjs        (Node 22)

import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`const D = ${JSON.stringify(new URL('../dapp', import.meta.url).href)};
export async function resolve(spec, ctx, next) {
  if (spec.startsWith('/') && !spec.startsWith('//')) return next(D + spec.split('?')[0], ctx);
  return next(spec, ctx);
}`));

import assert from 'node:assert/strict';
import { tacit as T, fetched } from './lib/btc-sim.mjs';
import { secp, bytesToHex } from '../dapp/vendor/tacit-deps.min.js';
import { signAd } from '../dapp/fastbridge-board.js';
import { gatewayOf } from '../dapp/fastbridge-mailbox.js';

const { discoverProviders, TAC_PAIR } = await import('../dapp/fast/discover.js');
const { openPair, loadLists } = await import('../dapp/fast/pair-wire.js');
const { SATS_ASSET, ETH_ASSET } = await import('../dapp/fastbridge-pair.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const TAC = TAC_PAIR.btcAsset;
const key = (n) => new Uint8Array(32).fill(n);
const openWallet = (priv) => { T.wallet.priv = priv; T.wallet.pub = secp.getPublicKey(priv, true); };
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const T0 = Math.floor(Date.now() / 1000);
const ad = (n, over = {}) => {
  const p = key(n), gw = gatewayOf(p);
  return signAd({ claimPub: bytesToHex(secp.getPublicKey(p, true)), gateway: bytesToHex(gw.pub), btcAsset: TAC, evmAsset: TAC, minAmount: '1000000000', maxAmount: '5000000000', available: '2000000000', feeBps: 30, flatFee: '10000000', csvBlocks: 144, evmWindowSecs: 14400, name: 'p' + n, at: T0, until: T0 + 300, ...over }, p);
};
const reverse = { minAmount: '1000000', maxAmount: '100000000', available: '50000000', feeBps: 30, flatFee: '20000', csvBlocks: 96, evmWindowSecs: 14400 };
const pairAd = (n, over = {}) => ad(n, { btcAsset: SATS_ASSET, evmAsset: ETH_ASSET, minAmount: '50000', maxAmount: '5000000', available: '4000000', flatFee: '1000', ...over });

test('a provider of Bitcoin for ETH on the same board is not listed on the TAC bridge page, whose amounts would be read in the wrong unit, and a page of the pair finds it and not the TAC providers', async () => {
  const ads = [ad(3), pairAd(4, { reverse }), pairAd(5)];
  const fetchImpl = async (url) => (String(url) === 'https://board.example/ads' ? json({ ads }) : json({ error: 'no' }, 404));
  const tac = await discoverProviders({ providers: [], boards: ['https://board.example'], fetchImpl });
  assert.deepEqual(tac.map((p) => p.id), [ads[0].claimPub], 'the bridge page, by default, sees TAC providers only');
  assert.deepEqual(tac[0].assets, { btcAsset: TAC, evmAsset: TAC });
  const pair = await discoverProviders({ providers: [], boards: ['https://board.example'], fetchImpl, assets: { btcAsset: SATS_ASSET, evmAsset: ETH_ASSET } });
  assert.deepEqual(pair.map((p) => p.id).sort(), [ads[1].claimPub, ads[2].claimPub].sort());
  assert.deepEqual(pair.find((p) => p.id === ads[1].claimPub).assets, { btcAsset: SATS_ASSET, evmAsset: ETH_ASSET });
  assert.equal(pair.find((p) => p.id === ads[1].claimPub).reverse.minAmount, 1000000n);
  assert.equal('reverse' in pair.find((p) => p.id === ads[2].claimPub), false);
});

test('the same for a provider that serves HTTP, and an ad that names its assets with 0x and capitals is still the same asset', async () => {
  const info = (btcAsset, evmAsset) => ({ claimPub: '02' + 'ab'.repeat(32), btcAsset, evmAsset, minAmount: '1', maxAmount: '9', available: null, feeBps: 1, flatFee: '0', csvBlocks: 144, evmWindowSecs: 14400 });
  const serve = (i) => async (url) => (String(url).endsWith('/info') ? json(i) : json({ error: 'no' }, 404));
  const p = [{ base: 'https://lp.example', claimPub: '02' + 'ab'.repeat(32) }];
  assert.equal((await discoverProviders({ providers: p, boards: [], fetchImpl: serve(info(SATS_ASSET, '0x' + ETH_ASSET)) })).length, 0, 'not on the TAC page');
  const found = await discoverProviders({ providers: p, boards: [], fetchImpl: serve(info(SATS_ASSET, '0x' + ETH_ASSET.toUpperCase())), assets: { btcAsset: SATS_ASSET, evmAsset: ETH_ASSET } });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].assets, { btcAsset: SATS_ASSET, evmAsset: ETH_ASSET });
  assert.equal((await discoverProviders({ providers: p, boards: [], fetchImpl: serve(info(TAC, TAC)) })).length, 1, 'a TAC provider is still listed for the TAC page');
  assert.equal((await discoverProviders({ providers: p, boards: [], fetchImpl: serve({ ...info(TAC, TAC), btcAsset: undefined, evmAsset: undefined }) })).length, 1, 'one that names no assets (an old one) is taken as TAC\'s');
});

// the pool's RPC answers Chainlink's ETH / BTC aggregator with a real round (see tests/fastbridge-rate.test.mjs)
const REAL_ROUND = '0x000000000000000000000000000000000000000000000002000000000000637e00000000000000000000000000000000000000000000000000000000002ad77e000000000000000000000000000000000000000000000000000000006b042d18000000000000000000000000000000000000000000000000000000006b042d2f000000000000000000000000000000000000000000000002000000000000637e';
const uxFor = (rpc) => ({ cfg: { pool: POOL }, chainBindingHex: () => '0x' + '11'.repeat(32), rpc, pool: {}, balance: async () => ({ byAsset: {} }) });
const chainlinkRpc = async (m, p) => (m === 'eth_call' ? (p[0].data === '0x313ce567' ? '0x' + '0'.repeat(63) + '8' : REAL_ROUND) : '0x0');
const mem = new Map();
const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); }, key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };

test('openPair: the page\'s own price is Chainlink read through the pool\'s RPC, the providers are the pair\'s, and the Bitcoin address is the key\'s', async () => {
  const priv = key(31), pubHex = bytesToHex(secp.getPublicKey(priv, true));
  openWallet(priv);
  const fetchImpl = async (url) => (String(url) === 'https://board.example/ads' ? json({ ads: [ad(3), pairAd(4, { reverse })] }) : json({ error: 'no' }, 404));
  const { pair, address, lists } = await openPair({ T, ux: uxFor(chainlinkRpc), priv, pubHex, hrp: 'tb', storage, fetchImpl, now: () => T0, lists: { providers: [], boards: ['https://board.example'] } });
  assert.equal(address, T.wallet.address());
  assert.deepEqual(lists.boards, ['https://board.example']);
  const ref = await pair.reference();
  assert.ok(Math.abs(ref.ethPerBtc - 1 / 0.02807678) < 1e-9);
  assert.equal(ref.source, '1 source');
  const ps = await pair.providers();
  assert.deepEqual(ps.map((p) => [p.id, p.dirs, p.minSats, p.maxSats]), [[pairAd(4).claimPub, ['b2e', 'e2b'], 50000n, 5000000n]], 'the TAC provider on the same board is not offered Bitcoin for ETH');
  assert.deepEqual(await pair.records(), [], 'a key that has swapped nothing has nothing to show');
});

test('openPair refuses a key whose Bitcoin address is not the one the wallet reads, before anything is built that could spend from the wrong one', async () => {
  const priv = key(32);
  openWallet(key(33));
  await assert.rejects(() => openPair({ T, ux: uxFor(chainlinkRpc), priv, pubHex: 'aa', hrp: 'tb', storage, lists: { providers: [], boards: [] } }), /not the one the wallet reads\. Nothing was done/);
});

test('one tab at a time takes the steps: a pass that finds the lock held by another tab reads and steps nothing', async () => {
  const priv = key(34), pubHex = bytesToHex(secp.getPublicKey(priv, true));
  openWallet(priv);
  const asked = [];
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (name, opts, cb) => { asked.push([name, opts]); return cb(held ? null : {}); } } } });
  let held = true;
  try {
    const { pair } = await openPair({ T, ux: uxFor(chainlinkRpc), priv, pubHex, hrp: 'tb', storage, lists: { providers: [], boards: [] }, discover: async () => [] });
    assert.deepEqual(await pair.pump(), [], 'another tab holds the lock: only the records are read');
    held = false;
    assert.deepEqual(await pair.pump(), []);
    assert.deepEqual(asked.map((a) => a[0]), [`tacit-fastbridge-pair-tend:${pubHex}`, `tacit-fastbridge-pair-tend:${pubHex}`], 'the lock is the key\'s own');
    assert.deepEqual(asked[0][1], { ifAvailable: true }, 'never waited for: a tab that cannot have it reads instead');
  } finally { if (had) Object.defineProperty(globalThis, 'navigator', had); else delete globalThis.navigator; }
});

test('the lists are the ones the fast page names, and a file that cannot be read leaves no provider to ask rather than an error', async () => {
  assert.deepEqual(await loadLists(async () => json({ providers: [{ base: 'https://x' }], boards: ['https://b'] })), { providers: [{ base: 'https://x' }], boards: ['https://b'] });
  assert.deepEqual(await loadLists(async () => json({}, 404)), { providers: [], boards: [] });
  assert.deepEqual(await loadLists(async () => { throw new Error('offline'); }), { providers: [], boards: [] });
  assert.deepEqual(await loadLists(async () => json({ providers: 'no', boards: 7 })), { providers: [], boards: [] });
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
if (fetched.length) { console.log('network reads attempted:', [...new Set(fetched)]); process.exitCode = 1; }
console.log(`\n${passed}/${tests.length} pair wiring checks passed`);
process.exit(process.exitCode || 0);
