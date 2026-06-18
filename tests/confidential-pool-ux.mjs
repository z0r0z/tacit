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
const POOL = '0x991726A547DCdB57ba660E395D9c7D7C3FcAdF79';

test('config: Sepolia pilot pool + cETH', () => {
  const c = CONFIDENTIAL_POOL_UX.sepolia;
  assert.equal(c.pool, POOL);
  assert.equal(c.chainId, 11155111);
  assert.equal(c.deployBlock, 11057316);
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
  assert.equal(captured.params[0].fromBlock, '0x' + (11057316).toString(16));
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
  assert.equal(w.to, '0x991726A547DCdB57ba660E395D9c7D7C3FcAdF79');
  assert.equal(w.amount, amountWei);
  // calldata = 4-byte selector + 3 × 32-byte words (assetId, amount, commit) — the raw coords + owner
  // are NOT in calldata; only commit = keccak(Cx‖Cy‖owner) is, so the note's ν stays uncomputable.
  assert.equal(w.calldata.length, 2 + 2 * (4 + 3 * 32));
  assert.equal(w.commit, ux.pool.depositCommit(cx, cy, w.note.owner));
  const cd = w.calldata.toLowerCase();
  for (const secret of [cx, cy, w.note.owner]) {
    assert.ok(!cd.includes(secret.toLowerCase().replace(/^0x/, '')), 'raw commitment coord/owner must not appear in wrap calldata');
  }
  // the depositId still binds value over the digest (the on-chain no-inflation gate)
  assert.equal(w.depositId, ux.pool.depositId(w.note.asset, BigInt(w.note.value), cx, cy, w.note.owner));
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

test('buildWrap: the output passes the recovery guard, and a stripped memo is caught before submit', async () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const { makeRecoveryGuard } = await import('../dapp/confidential-recovery-guard.js');
  const guard = makeRecoveryGuard({ memo: ux.indexer._memo });
  const w = ux.buildWrap({ walletPriv: '0x' + '33'.repeat(32), amountWei: '1000000000000000', ticker: 'cETH', index: 0 });
  // buildWrap routes its seal through the guard and exposes the aligned outputs/memos it validated.
  assert.equal(w.outputs.length, 1, 'one output descriptor');
  assert.equal(w.memos.length, 1, 'one aligned memo');
  assert.equal(w.memos[0], w.memo, 'singular memo == memos[0] (back-compat)');
  guard.assertOutputsRecoverable({ leaves: [w.leaf], outputs: w.outputs, memos: w.memos });
  // a memo-sealed (non-seed-derived) output with its memo stripped is an unrecoverable leaf — the
  // submit-time tripwire rejects it BEFORE it can reach the chain (= permanent fund loss).
  assert.throws(
    () => guard.assertOutputsRecoverable({ leaves: [w.leaf], outputs: w.outputs, memos: ['0x'] }),
    /unrecoverable|recovery channel/,
    'a wrap output with its memo stripped is rejected at submit'
  );
});

test('buildUnwrap: gasless exit splits value into net + relay fee, op matches the box harness', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + '44'.repeat(32);
  const amountWei = '1000000000000000'; // 0.001 ETH
  const w = ux.buildWrap({ walletPriv, amountWei, ticker: 'cETH', index: 0 });
  const events = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }];
  const note = ux.indexer.recover(events, walletPriv)[0];

  // fee = max(floor 1e14, ceil(0.3% of 1e15 = 3e12)) = 1e14; the floor dominates a small exit
  const q = ux.quoteUnwrapFee(note.value, 'cETH');
  assert.equal(q.fee, 100000000000000n, 'floor fee dominates small exit');
  assert.equal(q.net, 900000000000000n, 'user receives value − fee');
  assert.equal(q.fee + q.net, BigInt(note.value), 'fee + net == proven value (conserved)');

  const built = ux.buildUnwrap({ note, walletPriv });
  assert.equal(built.fee, q.fee);
  assert.equal(built.net, q.net);
  // op shape == the fields exec-unwrap.rs reads (same stdin order as the guest)
  assert.equal(built.op.spendRoot, note.root);
  assert.equal(built.op.asset, note.asset);
  assert.equal(built.op.value, String(note.value));
  assert.equal(built.op.fee, q.fee.toString());
  assert.equal(built.op.leafIndex, 0);
  assert.ok(Array.isArray(built.op.path) && built.op.path.length > 0, 'membership path present');
  assert.equal(built.op.recipient, ux.account(walletPriv).address.toLowerCase(), 'defaults to the user EVM account');
  // chainBinding == keccak(abi.encodePacked(chainid, pool)) — what the contract stamps + the guest commits
  const cid = (11155111n).toString(16).padStart(64, '0');
  const addr = POOL.replace(/^0x/, '').toLowerCase();
  const expect = '0x' + Buffer.from(keccak_256(Uint8Array.from((cid + addr).match(/../g).map((h) => parseInt(h, 16))))).toString('hex');
  assert.equal(built.op.chainBinding, expect, 'chainBinding = keccak(chainid‖pool)');
});

test('buildUnwrap selfSettle: no-fee exit preserved — full value to recipient, fee 0', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + '55'.repeat(32);
  const w = ux.buildWrap({ walletPriv, amountWei: '1000000000000000', ticker: 'cETH', index: 0 });
  const events = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }];
  const note = ux.indexer.recover(events, walletPriv)[0];

  const self = ux.buildUnwrap({ note, walletPriv, selfSettle: true });
  assert.equal(self.fee, 0n, 'self-settle pays no fee');
  assert.equal(self.net, BigInt(note.value), 'full value exits to the recipient');
  assert.equal(self.op.fee, '0', 'witness carries fee = 0 (guest: net = value, no FeePayment)');

  // a dust note that can't be relayed gaslessly CAN still self-settle (fee 0)
  const z = '0x' + '00'.repeat(32);
  const dust = { asset: CONFIDENTIAL_POOL_UX.sepolia.assets[0].assetId, value: '50000000000000', root: z, cx: z, cy: z, owner: z, leafIndex: 0, path: [z], secret: z, blinding: z };
  const dustSelf = ux.buildUnwrap({ note: dust, walletPriv, selfSettle: true });
  assert.equal(dustSelf.fee, 0n);
  assert.equal(dustSelf.net, 50000000000000n, 'dust note exits in full when self-settled');
});

test('quoteUnwrapFee: percent dominates a large exit; a dust note is rejected for gasless exit', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  // 1 ETH: 0.3% = 3e15 > floor 1e14 → percent applies
  const big = ux.quoteUnwrapFee(1000000000000000000n, 'cETH');
  assert.equal(big.fee, 3000000000000000n, '0.3% of 1e18');
  assert.equal(big.net, 997000000000000000n);
  // a note at/under the floor can't be relayed (the fee would eat it) → buildUnwrap throws
  const z = '0x' + '00'.repeat(32);
  const dust = { asset: CONFIDENTIAL_POOL_UX.sepolia.assets[0].assetId, value: '50000000000000', root: z, cx: z, cy: z, owner: z, leafIndex: 0, path: [z], secret: z, blinding: z };
  assert.throws(() => ux.buildUnwrap({ note: dust, walletPriv: '0x' + '44'.repeat(32) }), /too small/);
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
