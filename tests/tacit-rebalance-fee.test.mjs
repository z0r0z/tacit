// Focused offline checks for the rebalancer's fee-source and builder ceilings in dapp/tacit.js.
// node tests/tacit-rebalance-fee.test.mjs

import assert from 'node:assert/strict';
import { JSDOM } from './_jsdom.mjs';

const dom = new JSDOM('', { url: 'http://localhost/' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  location: dom.window.location, __TACIT_NO_INIT__: true,
});
if (!globalThis.navigator) globalThis.navigator = dom.window.navigator;
localStorage.setItem('tacit-network-v1', 'mainnet');
localStorage.setItem('tacit-fee-tier-v1', 'standard');

let calls = [];
globalThis.fetch = async (input, init) => {
  calls.push({ url: String(input?.url ?? input), method: init?.method || 'GET' });
  return new Response('offline', { status: 503 });
};

const T = await import('../dapp/tacit.js');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('requireSource throws when every fee endpoint fails instead of returning the fallback', async () => {
  await assert.rejects(() => T.getFeeRate(null, { fresh: true, requireSource: true }), /every fee source failed/);
  assert.ok(calls.some((c) => c.url.includes('/v1/fees/recommended')));
  assert.ok(calls.some((c) => c.url.includes('/fee-estimates')));
});

test('the same total failure retains the legacy fallback when requireSource is absent', async () => {
  assert.equal(await T.getFeeRate('standard', { fresh: true }), 15.75);
});

test('a real source answer is returned with requireSource', async () => {
  globalThis.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    calls.push({ url, method: init?.method || 'GET' });
    if (url.includes('/v1/fees/recommended')) return new Response(JSON.stringify({ fastestFee: 9, halfHourFee: 8, hourFee: 7, economyFee: 4, minimumFee: 1 }), { status: 200 });
    if (url.includes('/fee-estimates')) return new Response(JSON.stringify({ 1: 9, 2: 8, 3: 8, 6: 7, 12: 5, 25: 4 }), { status: 200 });
    return new Response('offline', { status: 503 });
  };
  assert.equal(await T.getFeeRate('standard', { fresh: true, requireSource: true }), 7.35);
});

test('the real builder rejects an above-cap supplied rate before any fee read, commit or reveal broadcast', async () => {
  calls = [];
  await assert.rejects(() => T.buildAndBroadcastCXferMulti({
    assetIdHex: 'aa'.repeat(32), recipients: [], forceUtxos: [], feeRate: 11, maxFeeRate: 10,
  }), /exceeds the 10 sat\/vB ceiling/);
  assert.deepEqual(calls, []);
  await assert.rejects(() => T.buildAndBroadcastCXferMulti({
    assetIdHex: 'aa'.repeat(32), recipients: [], forceUtxos: [], feeRate: 0, maxFeeRate: 10,
  }), /positive finite/);
  assert.deepEqual(calls, []);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} rebalancer fee primitive checks passed`);
process.exit(process.exitCode || 0);
