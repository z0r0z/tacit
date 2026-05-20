// Stealth-credit persistence shape test.
//
// Verifies the localStorage JSON shape used by recordStealthCredit /
// getStealthCredit / loadStealthCredits (defined in dapp/tacit.js). The
// persistence layer is what enables recovery-from-seed for stealth-received
// UTXOs: without it, a page reload silently drops stealth credits from the
// user's balance (same class as the AMM-recovery gap fixed 2026-05-18).
//
// We can't import dapp/tacit.js directly in node (DOM + localStorage), so
// this test mirrors the JSON shape and exercises the round-trip semantics
// the dapp relies on at rehydration time.

import * as fs from 'node:fs';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const src = fs.readFileSync('dapp/tacit.js', 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.error(`✗ ${name}\n  ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'assertEq'}: ${a} !== ${b}`); }

// --- Shape mirror -----------------------------------------------------------
// Mirrors the dapp's recordStealthCredit / getStealthCredit semantics.
function makeShape({ amount, blinding, tweakedSkHex, commitmentHex, senderPubHex, assetIdHex, blockTime }) {
  return {
    assetIdHex,
    amount: amount.toString(),
    // bigintToBytes32 is bytes-be; tests use a fixed 32-byte hex
    blinding: bytesToHex(_be32(blinding)),
    tweakedSkHex,
    commitmentHex: commitmentHex || null,
    senderPubHex: senderPubHex || null,
    blockTime: blockTime || null,
  };
}
function loadShape(s) {
  return {
    assetIdHex: s.assetIdHex,
    amount: BigInt(s.amount),
    blinding: BigInt('0x' + s.blinding),
    tweakedSkHex: s.tweakedSkHex,
    commitmentHex: s.commitmentHex || null,
    senderPubHex: s.senderPubHex || null,
    blockTime: s.blockTime || null,
  };
}
function _be32(n) {
  if (typeof n !== 'bigint') throw new Error('bigint expected');
  if (n < 0n) throw new Error('non-negative bigint expected');
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

// --- Tests ------------------------------------------------------------------
test('shape: amount/blinding bigint round-trip via decimal+hex strings', () => {
  const amount = 1234567890n;
  const blinding = 0x9a4b3c2d1e0f1a2b3c4d5e6f0a1b2c3d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5bn;
  const s = makeShape({
    amount, blinding,
    tweakedSkHex: 'aa'.repeat(32),
    commitmentHex: '02' + 'bb'.repeat(32),
    senderPubHex: '03' + 'cc'.repeat(32),
    assetIdHex: 'dd'.repeat(32),
    blockTime: 1716000000,
  });
  const r = loadShape(s);
  assertEq(r.amount, amount, 'amount round-trip');
  assertEq(r.blinding, blinding, 'blinding round-trip');
  assertEq(r.tweakedSkHex, 'aa'.repeat(32), 'tweakedSk preserved');
  assertEq(r.commitmentHex, '02' + 'bb'.repeat(32), 'commitment preserved');
  assertEq(r.senderPubHex, '03' + 'cc'.repeat(32), 'senderPub preserved');
  assertEq(r.assetIdHex, 'dd'.repeat(32), 'assetId preserved');
  assertEq(r.blockTime, 1716000000, 'blockTime preserved');
});

test('shape: nullable fields tolerate undefined inputs', () => {
  const s = makeShape({
    amount: 0n, blinding: 1n,
    tweakedSkHex: 'aa'.repeat(32),
    assetIdHex: 'ee'.repeat(32),
  });
  assertEq(s.commitmentHex, null);
  assertEq(s.senderPubHex, null);
  assertEq(s.blockTime, null);
  const r = loadShape(s);
  assertEq(r.commitmentHex, null);
  assertEq(r.senderPubHex, null);
  assertEq(r.blockTime, null);
});

test('shape: blinding hex is exactly 64 chars (32 bytes BE)', () => {
  const s = makeShape({
    amount: 1n,
    blinding: 0x01n,  // small bigint → must still be 32-byte BE
    tweakedSkHex: 'aa'.repeat(32),
    assetIdHex: 'ee'.repeat(32),
  });
  assertEq(s.blinding.length, 64, 'blinding hex must be 64 chars');
  assert(s.blinding.endsWith('01'), 'blinding hex BE-encodes correctly');
  const r = loadShape(s);
  assertEq(r.blinding, 1n, 'blinding round-trip preserves small bigint');
});

test('shape: large bigint amount survives JSON.stringify round-trip', () => {
  const amount = (1n << 60n) - 1n;  // beyond Number.MAX_SAFE_INTEGER (2^53-1)
  const s = makeShape({
    amount, blinding: 1n,
    tweakedSkHex: 'aa'.repeat(32),
    assetIdHex: 'ee'.repeat(32),
  });
  const stored = JSON.stringify(s);
  const reread = JSON.parse(stored);
  const r = loadShape(reread);
  assertEq(r.amount, amount, 'big amount survives JSON round-trip');
});

test('integration: dapp/tacit.js exports the new persistence helpers', () => {
  // Smoke check that the helper names exist in the dapp file. Failure here
  // means the helpers were renamed without updating call sites.
  for (const name of [
    'recordStealthCredit', 'getStealthCredit', 'loadStealthCredits',
    'removeStealthCredit',
    'scanAssetForStealthReceipts',
    'parseRecipientInput',
  ]) {
    assert(src.includes(`function ${name}`) || src.includes(`async function ${name}`),
      `missing function: ${name}`);
  }
  // Persistence key follows the standard tacit-v1 naming convention.
  assert(src.includes("`tacit-stealth-credits-v1:${NET.name}:${pubHex}`"),
    'stealth-credits localStorage key naming drifted');
});

test('integration: scanHoldings rehydrates stealth credits before returning', () => {
  // The rehydration block is bounded by two distinctive comments. Failing
  // this test means the block was deleted or moved out of scope and reload
  // recovery is silently broken — same class of bug as the AMM-UTXO gap
  // fixed 2026-05-18.
  const rehydrateStart = '// SPEC-BLINDED-PUBKEY §A.2 recovery: rehydrate persisted stealth credits.';
  const rehydrateEnd = '// Merge confirmed-true entries into the session-persistent cache so the';
  const startIdx = src.indexOf(rehydrateStart);
  const endIdx = src.indexOf(rehydrateEnd);
  assert(startIdx > 0, 'rehydration header comment missing');
  assert(endIdx > startIdx, 'rehydration footer comment missing or out of order');
  const block = src.slice(startIdx, endIdx);
  assert(block.includes('loadStealthCredits('), 'rehydration block does not load credits');
  assert(block.includes('getOutspend('), 'rehydration block does not check liveness');
  assert(block.includes('removeStealthCredit('), 'rehydration block does not clean spent credits');
});

test('integration: CXFER sender accepts stealthAddress recipient', () => {
  // The build-and-broadcast-CXfer single-recipient wrapper now accepts
  // stealthAddress alongside the legacy recipientPubHex. Without this,
  // the send-form's stealth-detected path would have no plumbing.
  assert(src.includes('async function buildAndBroadcastCXfer({ assetIdHex, recipientPubHex, stealthAddress'),
    'buildAndBroadcastCXfer wrapper missing stealthAddress parameter');
});

test('integration: AXFER family guard refuses tcs1 input', () => {
  // Forward-compat: AXFER stealth domains are registered but no builder
  // implements them in v1. The guard ensures a mispasted tcs1 surfaces at
  // the form edge rather than mid-broadcast.
  const guard = "shielded addresses on AXFER are not supported yet";
  assert(src.includes(guard),
    'buildAxferOffer no longer guards against shielded address mispaste');
});

test('integration: receive panel renders shielded address', () => {
  assert(src.includes("encodeStealthAddress({ network: currentNetworkName(), recipientPub: wallet.pub })"),
    'receive panel no longer generates shielded address');
  assert(src.includes("data-act=\"copy-stealth\""),
    'receive panel missing copy-shielded-address button');
  assert(src.includes("data-act=\"rescan-stealth\""),
    'receive panel missing rescan-for-shielded-receipts button');
});

test('integration: send form recognizes tcs HRPs', () => {
  // parseRecipientInput tests for the bech32m HRPs that decodeStealthAddress
  // accepts. Without this regex the send field would silently treat a paste
  // of a stealth address as an invalid pubkey hex.
  assert(src.includes("/^tcs(ts|rt)?1[02-9ac-hj-np-z]+$/"),
    'parseRecipientInput stealth HRP regex missing or drifted');
});

test('integration: importShareLink persists stealth credit on shielded receipts', () => {
  // After a recipient imports a share-link for a shielded send, the credit
  // must be persisted (the on-chain output is at a non-classical address
  // and scanHoldings won't re-find it without the persisted credit).
  const linkStart = src.indexOf('async function importShareLink(');
  const linkEnd = src.indexOf('\n}\n', linkStart);
  assert(linkStart > 0 && linkEnd > linkStart, 'importShareLink not found');
  const fn = src.slice(linkStart, linkEnd);
  assert(fn.includes('recordStealthCredit('),
    'importShareLink does not persist stealth credit for shielded receipts');
});

test('integration: self-shielded send auto-persists credit at broadcast time', () => {
  // When the user sends to their own shielded address, the sender knows the
  // recipient priv (== wallet.priv) and the blinding. Persisting the credit
  // at broadcast time prevents the UTXO from silently vanishing in the
  // holdings UI until the user runs a manual rescan. Same fix as the AMM-
  // UTXO recovery gap (2026-05-18) but for self-shielded CXFER.
  assert(src.includes('selfStealthBlinding'),
    'self-stealth detection field missing from CXFER sender');
  assert(src.includes('Self-shielded send: when the sender used their own shielded address'),
    'self-shielded post-broadcast persistence block missing');
  assert(src.includes("extra: { shielded: true, self: true"),
    'self-shielded transfer-in activity entry missing');
});

test('integration: Activity feed renders SHIELDED badge', () => {
  // The renderActivity row template surfaces a SHIELDED badge when
  // entry.extra.shielded is truthy. Without this the user can't audit which
  // of their sends/receipts were shielded.
  assert(src.includes("e.extra?.shielded ? ' <span class=\"badge\""),
    'renderActivity does not surface SHIELDED badge');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
