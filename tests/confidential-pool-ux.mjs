import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx, CONFIDENTIAL_POOL_UX } from '../dapp/confidential-pool-ux.js';

// secp.sign (RFC 6979) needs the sync HMAC set — the dapp's vendor bundle does this; do it for the test too.
const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));

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

test('buildWrap: coherent note + pool.wrap calldata', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + '33'.repeat(32);
  const amountWei = '1000000000000000'; // 0.001 ETH, unitScale 1 -> value == amount
  const w = ux.buildWrap({ walletPriv, amountWei, ticker: 'cETH', index: 0 });
  // the commitment re-derives from the opening
  const { cx, cy } = ux.pool.commitXY(BigInt(w.note.value), w.note.blinding);
  assert.equal(cx, w.note.cx);
  assert.equal(cy, w.note.cy);
  assert.equal(BigInt(w.note.value), BigInt(amountWei));
  assert.equal(w.leaf, ux.pool.leaf(w.note.asset, cx, cy, w.note.owner));
  assert.equal(w.to, '0x32e46B097830D93d50b0CBC89c018bCFD79b7B5a');
  assert.equal(w.amount, amountWei);
  // calldata = 4-byte selector + 5 × 32-byte words
  assert.equal(w.calldata.length, 2 + 2 * (4 + 5 * 32));
  // rejects misaligned / non-positive amounts
  assert.throws(() => ux.buildWrap({ walletPriv, amountWei: '0', ticker: 'cETH' }));
});

test('buildWrap + recovery round-trip: the wrapped note recovers seed-only from its leaf+memo', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + '33'.repeat(32);
  const amountWei = '1000000000000000';
  const w = ux.buildWrap({ walletPriv, amountWei, ticker: 'cETH', index: 0 });
  // synthesize the LeavesInserted event the box emits at OP_WRAP settle, then scan with the wallet key
  const events = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }];
  const notes = ux.indexer.recover(events, walletPriv);
  assert.equal(notes.length, 1, 'wrapped note recovered from chain + seed alone');
  assert.equal(BigInt(notes[0].value), BigInt(amountWei));
  assert.equal(notes[0].cx.toLowerCase(), w.note.cx.toLowerCase());
});

test('wrap: signs an EIP-1559 deposit tx (no broadcast)', async () => {
  const ux = makeConfidentialPoolUx({
    ...deps,
    fetchImpl: async (_url, opts) => {
      const m = JSON.parse(opts.body).method;
      const result = m === 'eth_getTransactionCount' ? '0x0' : m === 'eth_gasPrice' ? '0x3b9aca00' : '0x';
      return { ok: true, json: async () => ({ result }) };
    },
  });
  const walletPriv = '0x' + '33'.repeat(32);
  const r = await ux.wrap({ walletPriv, amountWei: '1000000000000000', broadcast: false });
  assert.match(r.signedRaw, /^0x02/, 'EIP-1559 typed-tx envelope');
  assert.equal(r.txHash, null);
  assert.equal(r.from, ux.account(walletPriv).address);
});
