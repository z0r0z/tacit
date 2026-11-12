// The Bitcoin lock a bridge waits on is not sent at the least the network relays: when the explorers' estimates run under 2 sat/vB (as they do while the
// pool is busy with transactions above that line) the user's page still asks for 2, a real estimate above it is kept, and the provider's own adapter (which
// sets no floor) keeps reading what the explorers say. A lock sent at 1.06 sat/vB sat unconfirmed for over an hour on 2026-11-12, and its offer was declined.
//   node tests/fastbridge-fee-floor.test.mjs        (Node 22)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeEsploraBtcChain } from '../dapp/fastbridge-btc.js';

const { prims } = makeBtcWallet({ priv: new Uint8Array(32).fill(7), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
const estimates = (byHost) => async (url) => {
  const host = new URL(url).host;
  if (!url.endsWith('/fee-estimates')) throw new Error('unexpected ' + url);
  return new Response(JSON.stringify(byHost[host]), { status: 200, headers: { 'content-type': 'application/json' } });
};
const chain = (byHost, over = {}) => makeEsploraBtcChain({ bases: Object.keys(byHost).map((h) => 'http://' + h), prims, builder: null, fetchImpl: estimates(byHost), feeFreshMs: 0, ...over });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('estimates under the floor are raised to it; a real estimate above it stands; the default has no floor beyond the network\'s 1', async () => {
  const quiet = { 'a.test': { 1: 0.34, 3: 0.3, 6: 0.2 }, 'b.test': { 1: 0.9, 3: 0.8, 6: 0.3 } };
  assert.equal(await chain(quiet, { feeTarget: '1', minFeeRate: 2 }).feeRate(0), 2, 'the explorers say under 1 and the lock still asks for 2');
  assert.equal(await chain(quiet).feeRate(0), 1, 'a provider\'s own adapter reads them as it always did');
  const busy = { 'a.test': { 1: 7.2 }, 'b.test': { 1: 8.8 } };
  assert.equal(await chain(busy, { feeTarget: '1', minFeeRate: 2 }).feeRate(0), 8, 'above the floor the median stands (rounded up)');
});

test('the target is the next block and not the six-block one the estimates run low on', async () => {
  const split = { 'a.test': { 1: 5, 3: 3, 6: 1 }, 'b.test': { 1: 5, 3: 3, 6: 1 } };
  assert.equal(await chain(split, { feeTarget: '1', minFeeRate: 2 }).feeRate(0), 5);
  assert.equal(await chain(split, { feeTarget: '6' }).feeRate(0), 1);
});

test('the user\'s page asks for it: dapp/fast/wire.js builds its Bitcoin side with the next-block target and the floor', () => {
  const wire = readFileSync(new URL('../dapp/fast/wire.js', import.meta.url), 'utf8');
  assert.match(wire, /feeTarget: '1', minFeeRate: 2/, 'a page that goes back to the cheapest tier sends locks that wait for hours');
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (e) { console.log(`  FAIL - ${name}\n${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} fee-floor checks passed`);
process.exit(process.exitCode || 0);
