import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPoolUx, CONFIDENTIAL_POOL_UX } from '../dapp/confidential-pool-ux.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };
const POOL = '0x32e46B097830D93d50b0CBC89c018bCFD79b7B5a';

test('config: Sepolia pilot pool + cETH', () => {
  const c = CONFIDENTIAL_POOL_UX.sepolia;
  assert.equal(c.pool, POOL);
  assert.equal(c.chainId, 11155111);
  assert.equal(c.deployBlock, 11052948);
  const ceth = c.assets.find((a) => a.ticker === 'cETH');
  assert.ok(ceth, 'cETH registered');
  assert.equal(ceth.assetId, '0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2');
  assert.equal(ceth.underlying, '0x0000000000000000000000000000000000000000');
});

test('account: deterministic, domain-separated Sepolia EVM derivation', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const priv = '0x' + '11'.repeat(32);
  const a1 = ux.account(priv);
  const a2 = ux.account(priv);
  assert.match(a1.address, /^0x[0-9a-f]{40}$/);
  assert.equal(a1.address, a2.address, 'deterministic');
  assert.notEqual(a1.priv.toLowerCase(), priv.toLowerCase(), 'EVM key is domain-separated, not the wallet key');
});

test('fetchEvents: pool-scoped LeavesInserted/NullifiersSpent filter from the deploy block', async () => {
  let captured = null;
  const ux = makeConfidentialPoolUx({
    ...deps,
    fetchImpl: async (_url, opts) => { captured = JSON.parse(opts.body); return { ok: true, json: async () => ({ result: [] }) }; },
  });
  const evs = await ux.fetchEvents();
  assert.deepEqual(evs, []);
  assert.equal(captured.method, 'eth_getLogs');
  assert.equal(captured.params[0].address, POOL);
  assert.equal(captured.params[0].fromBlock, '0x' + (11052948).toString(16));
  assert.equal(captured.params[0].topics[0].length, 2, 'topic0 OR-filter = [LeavesInserted, NullifiersSpent]');
});

test('balance: empty pool -> zero, no off-chain storage', async () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }) });
  const b = await ux.balance('0x' + '22'.repeat(32));
  assert.deepEqual(b.notes, []);
  assert.deepEqual(b.byAsset, {});
});

test('rpc: falls over to the next endpoint on failure', async () => {
  let calls = 0;
  const ux = makeConfidentialPoolUx({
    ...deps,
    fetchImpl: async (url) => { calls++; if (calls === 1) throw new Error('down'); return { ok: true, json: async () => ({ result: '0x1' }) }; },
  });
  const r = await ux.rpc('eth_blockNumber', []);
  assert.equal(r, '0x1');
  assert.equal(calls, 2, 'used the fallback after the first RPC threw');
});

test('tickerOf: resolves cETH, null for unknown', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  assert.equal(ux.tickerOf('0x2a0f3cb492f4add38bada8b7ef18de79445846ce7c5b7dc1c4b0d768467a04c2'), 'cETH');
  assert.equal(ux.tickerOf('0xdead'), null);
});
