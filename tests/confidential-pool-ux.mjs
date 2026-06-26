import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';

// secp.sign (RFC 6979) needs the sync HMAC set — the dapp's vendor bundle does this; do it for the test too.
const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };
// Derive the live signet config so these tests track the deploy sync instead of going stale on every
// re-pin (the DeployV1Suite manifest → confidential-deployments.generated.js overwrites pool/deployBlock).
const SIGNET = getConfidentialDeployment('signet');
const POOL = SIGNET.pool;
const DEPLOY_BLOCK = SIGNET.deployBlock;
// cETH unit math, derived from config so the tests track the live scale (1e10) instead of hardcoding it.
// A wrap of `amountWei` produces an in-system note value of amountWei / CETH_SCALE; the relay floor is the
// wei floor (1e14) ÷ scale.
const CETH_SCALE = BigInt(SIGNET.assets.find((a) => a.ticker === 'cETH').unitScale);
const inSys = (amountWei) => BigInt(amountWei) / CETH_SCALE;
const CETH_FLOOR = 100000000000000n / CETH_SCALE;

test('config: Sepolia pilot pool + cETH', () => {
  const c = getConfidentialDeployment('signet');
  assert.match(c.pool, /^0x[0-9a-fA-F]{40}$/, 'pool address pinned');
  assert.equal(c.chainId, 11155111);
  assert.ok(Number.isInteger(c.deployBlock) && c.deployBlock > 0, 'deployBlock pinned');
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
  assert.equal(captured.params[0].fromBlock, '0x' + (DEPLOY_BLOCK).toString(16));
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
  const amountWei = '1000000000000000'; // 0.001 ETH; in-system value = amountWei / cETH scale
  const w = ux.buildWrap({ walletPriv, amountWei, ticker: 'cETH', index: 0 });
  // the commitment re-derives from the opening
  const { cx, cy } = ux.pool.commitXY(BigInt(w.note.value), w.note.blinding);
  assert.equal(cx, w.note.cx);
  assert.equal(cy, w.note.cy);
  assert.equal(BigInt(w.note.value), inSys(amountWei));
  assert.equal(w.leaf, ux.pool.leaf(w.note.asset, cx, cy, w.note.owner));
  assert.equal(w.to, POOL);
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
  assert.equal(BigInt(notes[0].value), inSys(amountWei));
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

  // fee = max(floor, ceil(0.3%)); the per-asset wei floor (1e14 wei ÷ unitScale) dominates a small exit
  const q = ux.quoteUnwrapFee(note.value, 'cETH');
  assert.equal(q.fee, CETH_FLOOR, 'floor fee dominates small exit');
  assert.equal(q.net, inSys(amountWei) - CETH_FLOOR, 'user receives value − fee');
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

  // a dust note that can't be relayed gaslessly CAN still self-settle (fee 0). Use a REAL note (proper
  // blinding + commitment) so the opening sigma is well-formed — a real note never has a zero blinding.
  const z = '0x' + '00'.repeat(32);
  const asset0 = getConfidentialDeployment('signet').assets[0].assetId;
  const idd = ux.identity(walletPriv);
  const dn = ux.pool.deriveNote(idd.priv, asset0, 7);
  const dnBlind = '0x' + BigInt(dn.blinding).toString(16).padStart(64, '0');
  const dc = ux.pool.commitXY(50000000000000n, dnBlind);
  const dust = { asset: asset0, value: '50000000000000', root: z, cx: dc.cx, cy: dc.cy, owner: idd.owner, leafIndex: 0, path: [z], secret: dn.secret, blinding: dnBlind };
  const dustSelf = ux.buildUnwrap({ note: dust, walletPriv, selfSettle: true });
  assert.equal(dustSelf.fee, 0n);
  assert.equal(dustSelf.net, 50000000000000n, 'dust note exits in full when self-settled');
});

// A note + recipient pubkey suitable for driving ux.transfer with a mocked relay/RPC.
function transferFixture(ux, walletPriv) {
  const w = ux.buildWrap({ walletPriv, amountWei: '1000000000000000', ticker: 'cETH', index: 0 });
  const events = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }];
  const note = ux.indexer.recover(events, walletPriv)[0];
  note.root = '0x' + '00'.repeat(31) + '01';   // membership isn't checked off-chain; any non-zero root works here
  note.path = note.path || ['0x' + '00'.repeat(32)];
  const recipientPubHex = ux.identity('0x' + '77'.repeat(32)).pubHex;
  return { note, recipientPubHex };
}

// Routes relay submit / status / RPC through one fetch mock; records which legs fired.
function relayRpcMock(seen, submitStatus = 'proven') {
  return async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    let obj;
    if (String(url).includes('/confidential/submit')) { seen.submitMode = body && body.mode; obj = { jobId: 'j1', status: submitStatus }; }
    else if (String(url).includes('/confidential/status')) { obj = { jobId: 'j1', status: submitStatus, publicValues: '0xaa', proof: '0xbb' }; }
    else { const m = body && body.method; if (m === 'eth_sendRawTransaction') seen.broadcast = true; obj = { result: m === 'eth_gasPrice' ? '0x3b9aca00' : m === 'eth_sendRawTransaction' ? '0x' + 'cd'.repeat(32) : '0x0' }; }
    return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
  };
}

test('transfer selfRelay: box proves (mode=prove) then broadcasts settle from the user EOA', async () => {
  const seen = {};
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: relayRpcMock(seen, 'proven') });
  const walletPriv = '0x' + '66'.repeat(32);
  const { note, recipientPubHex } = transferFixture(ux, walletPriv);
  const r = await ux.transfer({ walletPriv, notes: [note], recipientPubHex, amount: 40000n, selfRelay: true });
  assert.equal(seen.submitMode, 'prove', 'self-relay submits a PROVE-only job (no settler)');
  assert.equal(seen.broadcast, true, 'self-relay broadcasts settle() from the user EOA');
  assert.equal(r.from, ux.account(walletPriv).address, 'settle sent from the user EVM account');
  assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
});

test('transfer default: relays the settle (no prove, no user broadcast)', async () => {
  const seen = {};
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: relayRpcMock(seen, 'settled') });
  const walletPriv = '0x' + '66'.repeat(32);
  const { note, recipientPubHex } = transferFixture(ux, walletPriv);
  await ux.transfer({ walletPriv, notes: [note], recipientPubHex, amount: 40000n });
  assert.equal(seen.submitMode, undefined, 'default path submits a settle job (no prove mode)');
  assert.notEqual(seen.broadcast, true, 'default path never broadcasts from the user EOA');
});

test('quoteUnwrapFee: percent dominates a large exit; a dust note is rejected for gasless exit', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  // 1 ETH: 0.3% = 3e15 > floor 1e14 → percent applies
  const big = ux.quoteUnwrapFee(1000000000000000000n, 'cETH');
  assert.equal(big.fee, 3000000000000000n, '0.3% of 1e18');
  assert.equal(big.net, 997000000000000000n);
  // a note at/under the floor can't be relayed (the fee would eat it) → buildUnwrap throws
  const z = '0x' + '00'.repeat(32);
  const dust = { asset: getConfidentialDeployment("signet").assets[0].assetId, value: "5000", root: z, cx: z, cy: z, owner: z, leafIndex: 0, path: [z], secret: z, blinding: z };
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

test('buildWrapTransferOp: deposit consumed into hidden recipient + change, conservation self-verifies', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + '88'.repeat(32);
  const recipientPubHex = ux.identity('0x' + '99'.repeat(32)).pubHex;
  const amountWei = '1000000000000000'; // 0.001 ETH; at cETH scale 1e10 the in-system value = amountWei/1e10
  // build() throws on conservation/range/recovery failure, so a returned op IS self-verified.
  const b = ux.buildWrapTransferOp({ walletPriv, amountWei, ticker: 'cETH', recipientPubHex, amount: 60000n });
  // recipient + change outputs sum to the deposit value inSys(amountWei) (fee 0): 60000 + 40000 = 100000
  assert.equal(b.op.outputs.length, 2, 'recipient + change');
  assert.equal(b.amount, 60000n);
  assert.equal(b.change, 40000n);
  assert.equal(b.fee, 0n);
  // deposit binding is identical to a plain buildWrap of the same deposit (same wallet-derived blinding) —
  // so the guest's deposit_id + opening sigma match either entrypoint.
  const w = ux.buildWrap({ walletPriv, amountWei, ticker: 'cETH', index: 0 });
  assert.equal(b.depositCommit, w.commit, 'deposit commit == buildWrap commit (reproducible deposit)');
  assert.equal(b.depositId, w.depositId, 'deposit id matches buildWrap');
  assert.ok(b.op.deposit.sigR && b.op.deposit.sigZ, 'deposit opening sigma present');
  // the recipient output is owned by the recipient pubkey, the change by the sender
  assert.equal(b.op.outputs[0].owner, '0x' + recipientPubHex.replace(/^0x/, '').slice(2, 66), 'recipient note bound to their pubkey');
  // one aligned recovery memo per output (guard tripwire already ran inside build)
  assert.equal(b.memos.length, 2, 'one memo per output');
  assert.equal(b.leaves.length, 2);
  // rejects an over-spend (amount + fee > deposit)
  assert.throws(() => ux.buildWrapTransferOp({ walletPriv, amountWei, ticker: 'cETH', recipientPubHex, amount: 2000000000000000n }), /exceeds the deposit/);
});

test('wrapAndSend (native, fee 0): prove-only then user broadcasts router.wrapAndSettleETH{value}', async () => {
  const seen = {};
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: relayRpcMock(seen, 'proven') });
  const walletPriv = '0x' + 'a1'.repeat(32);
  const recipientPubHex = ux.identity('0x' + 'b2'.repeat(32)).pubHex;
  const amountWei = '1000000000000000';
  const r = await ux.wrapAndSend({ walletPriv, amountWei, ticker: 'cETH', recipientPubHex, amount: 60000n });
  assert.equal(seen.submitMode, 'prove', 'wrap-and-send submits a PROVE-only job (proof embedded in the user tx)');
  assert.equal(seen.broadcast, true, 'the user broadcasts the wrap-and-settle tx themselves');
  assert.equal(r.from, ux.account(walletPriv).address, 'sent from the user EVM account');
  assert.equal(r.to, ux.cfg.router, 'targets the ConfidentialRouter');
  assert.equal(r.value, amountWei, 'the ETH deposit rides as msg.value');
  assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
  // the fee-bearing relayed path is a follow-up — the user-sent router gate is fee-free
  await assert.rejects(() => ux.wrapAndSend({ walletPriv, amountWei, ticker: 'cETH', recipientPubHex, amount: 1n, fee: 5n }), /fee-free|fee must be 0/);
});

test('buildLpBondOp: fused add+bond witness — canonical order, derived shares, A/B sigmas self-verify', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + 'c3'.repeat(32);
  const id = ux.identity(walletPriv);
  const controller = '0x' + 'fa'.repeat(20);
  const z = '0x' + '00'.repeat(32);
  // Two real notes of a canonical pair (assetA < assetB), each with a proper blinding so the opening sigma
  // is well-formed. Reserves/shares 10000 each → an in-ratio 1000/1000 add.
  const assetLow = '0x0a' + 'a'.repeat(62);
  const assetHigh = '0x' + 'b0'.repeat(32);
  const mkNote = (asset, val, idx) => {
    const dn = ux.pool.deriveNote(id.priv, asset, idx);
    const blind = '0x' + BigInt(dn.blinding).toString(16).padStart(64, '0');
    const { cx, cy } = ux.pool.commitXY(BigInt(val), blind);
    return { asset, value: String(val), cx, cy, owner: id.owner, blinding: blind, leafIndex: idx, path: [z], root: '0x' + '00'.repeat(31) + '01' };
  };
  const aNote = mkNote(assetLow, 1000, 0);
  const bNote = mkNote(assetHigh, 1000, 1);
  // Pass the notes in REVERSE (high, low) to exercise canonicalization.
  const b = ux.buildLpBondOp({
    walletPriv, controller, aNote: bNote, bNote: aNote, feeBps: 30,
    reserveAPre: 10000n, reserveBPre: 10000n, sharesPre: 10000n, bondNonce: '0x' + '77'.repeat(32),
  });
  assert.equal(b.assetA, assetLow, 'canonicalized: assetA is the lex-smaller id');
  assert.equal(b.assetB, assetHigh);
  assert.equal(b.dShares, ux.pool.lpAddShares(10000n, 1000n, 1000n, 10000n, 10000n), 'shares = lpAddShares(...)');
  assert.equal(b.op.controller, controller, '20-byte controller in the op');
  assert.ok(b.op.a.sigR && b.op.a.sigZ && b.op.b.sigR && b.op.b.sigZ, 'A + B opening sigmas present');
  // both legs re-verify against the SAME bound context the build assembled
  const ctx = ux.pool.intentContext('tacit-lp-bond-v1', b.op.chainBinding, assetLow, assetHigh,
    [[aNote.cx, aNote.cy, id.owner], [bNote.cx, bNote.cy, id.owner], ['0x' + '00'.repeat(12) + controller.replace(/^0x/, ''), '0x' + '77'.repeat(32), id.owner]],
    [1000n, 1000n, b.dShares, 0n, 0n]);
  assert.ok(ux.pool.verifyOpeningSigma(aNote.cx, aNote.cy, 1000n, b.op.a.sigR, b.op.a.sigZ, ctx), 'A sigma opens under the bound bond context');
  assert.ok(ux.pool.verifyOpeningSigma(bNote.cx, bNote.cy, 1000n, b.op.b.sigR, b.op.b.sigZ, ctx), 'B sigma opens under the bound bond context');
  // a missing controller is refused (no silent unbonded add)
  assert.throws(() => ux.buildLpBondOp({ walletPriv, aNote, bNote, reserveAPre: 10000n, reserveBPre: 10000n, sharesPre: 10000n, bondNonce: z }), /controller/);
});

test('buildUnwrap: the opening sigma binds recipient + fee, and no raw blinding reaches the settler', () => {
  const ux = makeConfidentialPoolUx({ ...deps, fetchImpl: async () => {} });
  const walletPriv = '0x' + '55'.repeat(32);
  const w = ux.buildWrap({ walletPriv, amountWei: '1000000000000000', ticker: 'cETH', index: 0 });
  const events = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }];
  const note = ux.indexer.recover(events, walletPriv)[0];

  const recip = '0x' + 'cc'.repeat(20);
  const built = ux.buildUnwrap({ note, walletPriv, recipient: recip, selfSettle: true }); // fee = 0
  const op = built.op;
  // the gasless-exit op hands the box the SIGMA, never the raw blinding (the redirect/fee-pad surface)
  assert.equal(op.blinding, undefined, 'no raw blinding handed to the settler');
  assert.ok(op.sigR && op.sigZ, 'opening sigma (R, z) present');

  const pool = ux.pool;
  const dl = BigInt(op.deadline);
  const ctxOf = (recipientHex, feeUnits, deadlineUnits = dl) => pool.intentContext(
    'tacit-unwrap-intent-v1', op.chainBinding, note.asset,
    '0x' + '0'.repeat(24) + recipientHex.replace(/^0x/, ''),
    [[note.cx, note.cy, note.owner]], [BigInt(note.value), feeUnits, deadlineUnits],
  );
  // verifies against the committed (recipient, value, fee, deadline)
  assert.ok(pool.verifyOpeningSigma(note.cx, note.cy, BigInt(note.value), op.sigR, op.sigZ, ctxOf(recip, 0n)),
    'sigma opens the note under the committed intent');
  // a settler redirecting the recipient to itself yields a DIFFERENT context → the sigma fails
  assert.ok(!pool.verifyOpeningSigma(note.cx, note.cy, BigInt(note.value), op.sigR, op.sigZ, ctxOf('0x' + 'ee'.repeat(20), 0n)),
    'redirecting the recipient breaks the sigma (no settler theft)');
  // padding the fee (moving value from the recipient leg to the settler) also breaks the sigma
  assert.ok(!pool.verifyOpeningSigma(note.cx, note.cy, BigInt(note.value), op.sigR, op.sigZ, ctxOf(recip, BigInt(note.value))),
    'padding the fee breaks the sigma');
  // stretching the expiry (a box submitting the exit past its deadline) also breaks the sigma
  assert.ok(!pool.verifyOpeningSigma(note.cx, note.cy, BigInt(note.value), op.sigR, op.sigZ, ctxOf(recip, 0n, dl + 86400n)),
    'stretching the deadline breaks the sigma (no stale-submit grief)');
});
