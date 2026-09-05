#!/usr/bin/env node
// End-to-end stealth send/scan/claim/refund round trip through confidential-pool-ux.js, against a fully
// mocked relay + RPC (no network). This is the integration test the individual pieces (confidential-
// stealth.js, confidential-airdrop.js, confidential-lock-scan.js — each unit-tested on their own) don't
// cover: that stealthSend's OWN output actually decodes back out through scanStealthLocks' calldata walk
// and claims cleanly, using nothing but what a real recipient would have (their wallet key + chain data).
//
// The "chain" is simulated by hand-encoding exactly what stealthSend's built op would produce as a real
// settle() transaction + its LeavesInserted log — using an ABI encoder written independently of
// confidential-lock-scan.js's decoder and confidential-evm-log.js's decoder, so agreement is a real
// cross-check of all three, not a tautology.
//
// Run: node tests/confidential-stealth-send.mjs

import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { makeConfidentialPoolUx } from '../dapp/confidential-pool-ux.js';
import { getConfidentialDeployment } from '../dapp/confidential-deployments.js';

const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const deps = { secp, keccak256: keccak_256, sha256 };
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

// ── minimal, independent ABI helpers (deliberately not shared with the modules under test) ──
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const bytes32 = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
function encBytes(hex) { const b = String(hex).replace(/^0x/, ''); return word(b.length / 2) + b + '0'.repeat((64 - (b.length % 64)) % 64); }
function encBytes32Array(items) { return word(items.length) + items.map(bytes32).join(''); }
function encBytesArray(items) {
  const encs = items.map(encBytes);
  let off = items.length * 32, head = '';
  for (const e of encs) { head += word(off); off += e.length / 2; }
  return word(items.length) + head + encs.join('');
}
const selector = (sig) => Array.from(keccak_256(new TextEncoder().encode(sig)).slice(0, 4), (x) => x.toString(16).padStart(2, '0')).join('');
function encodeSettleCalldata({ publicValues, proof, memos }) {
  const pvEnc = encBytes(publicValues), proofEnc = encBytes(proof), memosEnc = encBytesArray(memos);
  const offPv = 3 * 32, offProof = offPv + pvEnc.length / 2, offMemos = offProof + proofEnc.length / 2;
  return '0x' + selector('settle(bytes,bytes,bytes[])') + word(offPv) + word(offProof) + word(offMemos) + pvEnc + proofEnc + memosEnc;
}
// PublicValues prefix (fields 0..17) for a PURE LOCK settle: leaves=[] (no note leaf), given lockLeaves.
function encodePublicValuesForLock(lockLeaves) {
  const zero32 = bytes32('0x' + '00'.repeat(32));
  const FIELDS = [
    { static: word(1) }, { static: zero32 }, { static: zero32 },
    { dynEnc: encBytes32Array([]) },       // 3 nullifiers
    { dynEnc: encBytes32Array([]) },       // 4 leaves — EMPTY: a pure lock mints no note leaf
    { dynEnc: encBytes32Array([]) }, { dynEnc: word(0) }, { dynEnc: word(0) },
    { dynEnc: encBytes32Array([]) }, { dynEnc: word(0) }, { dynEnc: encBytes32Array([]) },
    { static: zero32 }, { static: zero32 }, { dynEnc: word(0) }, { dynEnc: word(0) },
    { static: word(0) },
    { static: zero32 },                    // 16 lockSetRoot (unused by this test's assertions)
    { dynEnc: encBytes32Array(lockLeaves) }, // 17 lockLeaves
  ];
  let head = '', tail = '', tailPos = FIELDS.length * 32;
  for (const f of FIELDS) { if (f.static != null) { head += f.static; continue; } head += word(tailPos); tail += f.dynEnc; tailPos += f.dynEnc.length / 2; }
  return '0x' + head + tail;
}
// LeavesInserted(uint256 indexed firstLeafIndex, bytes32[] leaves, bytes[] memos) log — independent of
// confidential-evm-log.js's own decoder.
const LEAVES_INSERTED_TOPIC0 = '0x' + Array.from(keccak_256(new TextEncoder().encode('LeavesInserted(uint256,bytes32[],bytes[])')), (x) => x.toString(16).padStart(2, '0')).join('');
function encodeLeavesInsertedLog({ firstLeafIndex, leaves, memos }) {
  const leavesEnc = encBytes32Array(leaves), memosEnc = encBytesArray(memos);
  const offLeaves = 2 * 32, offMemos = offLeaves + leavesEnc.length / 2;
  const data = '0x' + word(offLeaves) + word(offMemos) + leavesEnc + memosEnc;
  return { topics: [LEAVES_INSERTED_TOPIC0, '0x' + word(firstLeafIndex)], data };
}

// A wallet's own REAL wrapped note, in a real 1-leaf tree — mirrors tests/confidential-pool-ux.mjs's
// (now-fixed) transferFixture pattern.
function wrapFixture(ux, walletPriv, amountWei) {
  const w = ux.buildWrap({ walletPriv, amountWei, ticker: 'cETH', index: 0 });
  const events = [{ type: 'LeavesInserted', firstLeafIndex: 0, leaves: [w.leaf], memos: [w.memo] }];
  const note = ux.indexer.recover(events, walletPriv)[0];
  const tree = new ux.pool.Tree();
  const leafIndex = tree.insert(w.leaf);
  note.root = tree.root();
  note.path = tree.rootAndPath(leafIndex).path;
  note.leafIndex = leafIndex;
  return note;
}

const DEPLOY_BLOCK = getConfidentialDeployment('signet').deployBlock; // fetchEvents' scan starts here — a
// log outside [deployBlock, headBlock] would never be found by the real windowed getLogsChunked either.
const SENDER = '0x' + '51'.repeat(32);
const RECIPIENT = '0x' + '52'.repeat(32);
const OUTSIDER = '0x' + '53'.repeat(32);
const AMOUNT_WEI = '1000000000000000'; // 0.001 ETH

let capturedSubmit = null;
function mockFetch(txByHash) {
  return async (urlStr, opts = {}) => {
    const reply = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
    if (String(urlStr).includes('/confidential/submit')) {
      capturedSubmit = JSON.parse(opts.body);
      return reply({ ok: true, jobId: 'job-' + Math.random().toString(36).slice(2), status: 'settled' });
    }
    const body = JSON.parse(opts.body);
    const m = body.method;
    // Must be >= the active network's deployBlock (signet: 11175726+) or getLogsChunked's window loop
    // (`from <= to`) never runs at all and eth_getLogs is never called — silently returning zero events.
    if (m === 'eth_blockNumber') return reply({ result: '0xffffff' });
    if (m === 'eth_gasPrice') return reply({ result: '0x3b9aca00' });
    if (m === 'eth_getTransactionCount') return reply({ result: '0x0' });
    if (m === 'eth_sendRawTransaction') return reply({ result: '0x' + 'cd'.repeat(32) });
    if (m === 'eth_getLogs') {
      // Respect the requested block window like a real provider would — fetchEvents chunks in LOG_WINDOW
      // (2000-block) steps from the deploy block, so a mock that ignores the window and always returns
      // everything would return the same log thousands of times over (harmless — scanLockLeaves dedupes
      // by txHash — but slow and not representative of the real RPC contract this exercises).
      const params = body.params[0];
      const from = parseInt(params.fromBlock, 16), to = parseInt(params.toBlock, 16);
      const logs = Object.values(txByHash).map((tx) => tx.log).filter((l) => l && parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= to);
      return reply({ result: logs });
    }
    if (m === 'eth_getTransactionByHash') {
      const tx = txByHash[body.params[0]];
      return reply({ result: tx ? { input: tx.input } : null });
    }
    return reply({ result: '0x0' });
  };
}

// ───────────────── 1. stealthSend builds a complete, well-formed lock and dispatches it ─────────────────
let sendResult, senderNote;
{
  const uxS = makeConfidentialPoolUx({ ...deps, fetchImpl: mockFetch({}) });
  senderNote = wrapFixture(uxS, SENDER, AMOUNT_WEI);
  const recipientPubHex = uxS.identity(RECIPIENT).pubHex;
  let built = null;
  sendResult = await uxS.stealthSend({
    walletPriv: SENDER, recipientPubHex, notes: [senderNote], amount: senderNote.value,
    onBuilt: (b) => { built = b; },
  });
  assert.ok(built, 'onBuilt fires before dispatch');
  assert.strictEqual(built.lockLeaf, sendResult.lockLeaf, 'onBuilt and the return value agree on the lock leaf');
  assert.strictEqual(capturedSubmit.type, 'stealthlock', 'dispatched as a stealthlock job');
  assert.deepStrictEqual(capturedSubmit.memos, [sendResult.memo], 'the lock memo rides the submission as lockMemos, not the note-output guard path');
  assert.ok(capturedSubmit.op.nk, 'the submitted op carries the spent note\'s real nk (2026-09 buildStealthLock fix)');
  assert.notEqual(sendResult.refundPub.toLowerCase(), uxS.identity(SENDER).pubHex.toLowerCase(), 'refund key is freshly generated, not the wallet\'s own key');
  ok('stealthSend: builds a complete lock witness, dispatches it, and returns a persistable refund record');

  // Sending to yourself is refused up front — that is plain transfer()'s job, and doesn't need a proof round trip.
  await assert.rejects(
    () => uxS.stealthSend({ walletPriv: SENDER, recipientPubHex: uxS.identity(SENDER).pubHex, notes: [senderNote], amount: senderNote.value }),
    /own address/,
    'stealthSend refuses a self-send',
  );
  ok('stealthSend: refuses sending to your own address (use transfer() instead)');
}

// ───────────────── 2. scanStealthLocks discovers the lock — as chain data, not from the local build —
// and only for the actual recipient; nobody else's key opens it ─────────────────
let scanned, txByHash;
{
  const settleCalldata = encodeSettleCalldata({
    publicValues: encodePublicValuesForLock([sendResult.lockLeaf]),
    proof: '0x' + 'aa'.repeat(32),
    memos: [sendResult.memo], // leavesCount=0 for a pure lock ⇒ the WHOLE memos array is the lock-memo tail
  });
  const log = encodeLeavesInsertedLog({ firstLeafIndex: 0, leaves: [], memos: [sendResult.memo] });
  txByHash = { '0xsettletx1': {
    input: settleCalldata,
    log: { ...log, transactionHash: '0xsettletx1', blockNumber: '0x' + (DEPLOY_BLOCK + 5).toString(16), logIndex: '0x0', address: '0x' + '00'.repeat(20) },
  } };

  const uxR = makeConfidentialPoolUx({ ...deps, fetchImpl: mockFetch(txByHash) });
  const { mine, lockSetRoot } = await uxR.scanStealthLocks({ walletPriv: RECIPIENT });
  assert.strictEqual(mine.length, 1, 'the recipient finds exactly the one lock addressed to them');
  assert.strictEqual(mine[0].leaf.toLowerCase(), sendResult.lockLeaf.toLowerCase());
  assert.strictEqual(BigInt(mine[0].amount), BigInt(senderNote.value), 'the scanned amount matches what was actually sent');
  assert.strictEqual(mine[0].asset.toLowerCase(), senderNote.asset.toLowerCase());
  assert.ok(mine[0].lBlinding, 'the recovered record carries lBlinding — spendable, not just discoverable');
  assert.ok(mine[0].oneTimePriv, 'the recipient recovers the one-time spending key');
  scanned = { record: mine[0], lockSetRoot };

  const uxOutsider = makeConfidentialPoolUx({ ...deps, fetchImpl: mockFetch(txByHash) });
  const outsiderScan = await uxOutsider.scanStealthLocks({ walletPriv: OUTSIDER });
  assert.strictEqual(outsiderScan.mine.length, 0, 'a third party\'s key does not open the memo');
  ok('scanStealthLocks: finds the lock purely from simulated chain data (calldata decode + memo decrypt), for the recipient only');
}

// ───────────────── 3. stealthClaim: the recipient spends the discovered lock into their own note,
// using ONLY what scanStealthLocks recovered — self-verified exactly as the guest re-checks it ─────────────────
{
  const uxR = makeConfidentialPoolUx({ ...deps, fetchImpl: mockFetch({}) });
  const claimed = await uxR.stealthClaim({ walletPriv: RECIPIENT, lockRecord: scanned.record, lockSetRoot: scanned.lockSetRoot });
  assert.strictEqual(capturedSubmit.type, 'stealthclaim');
  assert.strictEqual(claimed.net, BigInt(senderNote.value), 'no fee ⇒ full value claimed');
  ok('stealthClaim: spends the scanned lock using only the recipient\'s own key + the scan result');

  // A fee larger than the locked amount is refused before any op is built.
  await assert.rejects(
    () => uxR.stealthClaim({ walletPriv: RECIPIENT, lockRecord: scanned.record, lockSetRoot: scanned.lockSetRoot, fee: BigInt(senderNote.value) + 1n }),
    /exceeds the locked amount/,
  );
  ok('stealthClaim: refuses a fee that would exceed the locked amount');
}

// ───────────────── 4. stealthRefund: the SENDER reclaims an unclaimed lock with the refund key
// stealthSend's onBuilt exposed — nobody else's key can produce the required signature ─────────────────
{
  const uxS = makeConfidentialPoolUx({ ...deps, fetchImpl: mockFetch({}) });
  const refunded = await uxS.stealthRefund({ walletPriv: SENDER, lockRecord: { ...scanned.record, refundPub: sendResult.refundPub }, refundPriv: sendResult.refundPriv, lockSetRoot: scanned.lockSetRoot });
  assert.strictEqual(capturedSubmit.type, 'stealthrefund');
  assert.strictEqual(refunded.net, BigInt(senderNote.value));
  ok('stealthRefund: the sender reclaims an unclaimed lock with the persisted refund key');
}

// ───────────────── 5. stealthLockPosition: the SENDER-side refund path a UI actually has to use — the
// sender only ever has `onBuilt`'s record (lCx/lCy/ownerPub/lBlinding/refundPub/refundPriv), never the
// recipient's decrypted `scanned.record` from block 3/4 above. stealthLockPosition is what supplies the
// missing lIndex/lPath from chain data alone, keyed on the known lock leaf — no memo decryption at all. ───
{
  let built = null;
  const uxS = makeConfidentialPoolUx({ ...deps, fetchImpl: mockFetch({}) });
  const secondNote = wrapFixture(uxS, SENDER, AMOUNT_WEI);
  const recipientPubHex = uxS.identity(RECIPIENT).pubHex;
  const secondSend = await uxS.stealthSend({
    walletPriv: SENDER, recipientPubHex, notes: [secondNote], amount: secondNote.value,
    onBuilt: (b) => { built = b; },
  });
  assert.ok(built.lCx && built.lCy && built.ownerPub && built.lBlinding, 'onBuilt exposes everything stealthRefund needs except position — lCx/lCy/ownerPub/lBlinding');

  // Same chain-lookup mock as block 2, now carrying BOTH locks (this one appended after the first).
  const settleCalldata2 = encodeSettleCalldata({
    publicValues: encodePublicValuesForLock([secondSend.lockLeaf]),
    proof: '0x' + 'bb'.repeat(32),
    memos: [secondSend.memo],
  });
  const log2 = encodeLeavesInsertedLog({ firstLeafIndex: 0, leaves: [], memos: [secondSend.memo] });
  const txByHash2 = { ...txByHash, '0xsettletx2': {
    input: settleCalldata2,
    log: { ...log2, transactionHash: '0xsettletx2', blockNumber: '0x' + (DEPLOY_BLOCK + 6).toString(16), logIndex: '0x0', address: '0x' + '00'.repeat(20) },
  } };
  const uxS2 = makeConfidentialPoolUx({ ...deps, fetchImpl: mockFetch(txByHash2) });
  const pos = await uxS2.stealthLockPosition({ lockLeaf: secondSend.lockLeaf });
  assert.ok(pos, 'the sender\'s own lock is found in the reconstructed lock-set tree');
  assert.strictEqual(pos.lIndex, 1, 'this lock is the SECOND leaf in the tree (index 1), after the first test\'s lock');

  const lockRecord = { asset: built.asset, lCx: built.lCx, lCy: built.lCy, ownerPub: built.ownerPub,
    amount: built.amount, deadline: built.deadline, refundPub: built.refundPub, lBlinding: built.lBlinding,
    lIndex: pos.lIndex, lPath: pos.lPath };
  const uxS3 = makeConfidentialPoolUx({ ...deps, fetchImpl: mockFetch({}) });
  const refunded = await uxS3.stealthRefund({ walletPriv: SENDER, lockRecord, refundPriv: built.refundPriv, lockSetRoot: pos.lockSetRoot });
  assert.strictEqual(capturedSubmit.type, 'stealthrefund');
  assert.strictEqual(refunded.net, BigInt(secondNote.value), 'refunds using ONLY sender-side data: onBuilt + stealthLockPosition, no memo decryption');

  const missing = await uxS2.stealthLockPosition({ lockLeaf: '0x' + 'ff'.repeat(32) });
  assert.strictEqual(missing, null, 'a lock leaf that was never mined resolves to null, not a crash or a bogus index');
  ok('stealthLockPosition: reconstructs a known lock\'s membership witness from chain data alone, enabling a refund built purely from onBuilt\'s record');
}

console.log(`\n${n}/${n} confidential-stealth-send checks passed`);
