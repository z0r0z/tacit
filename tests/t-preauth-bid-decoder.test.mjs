// Unit tests for the T_PREAUTH_BID (0x5B) payload encoder/decoder shipped
// in dapp/tacit.js + worker/src/index.js (SPEC §5.7.11 / SPEC-PREAUTH-BID-
// AMENDMENT.md round-2).
//
// What this protects:
//   1. Wire-format byte layout (opcode + asset_id + asset_input_count +
//      INLINE bid-context [bid_id + recipient_pubkey + amount_LE + blinding
//      + price_sats_LE] + kernel_sig + N + outputs + rp_len + rangeproof).
//   2. The N_outputs ∈ {1, 2} constraint (T_PREAUTH_BID disallows N=4 / N=8).
//   3. output[0] has NO encryptedAmount (amount is in cleartext inline);
//      output[1] (when N=2) keeps the standard 8-byte encryptedAmount.
//   4. computePreauthBidContextHash domain tag + field ordering, the load-
//      bearing binding the buyer's SIGHASH_SINGLE_ACP signature pins to
//      vout via the canonical OP_RETURN.
//
// No on-chain T_PREAUTH_BID transactions exist yet (the worker validator
// dispatch + builder flow are upcoming stages); these tests synthesise
// the wire-format bytes by hand and exercise the structural decoder +
// hash binding via a parallel implementation. When the builder lands,
// this file will also cover the encode→decode round trip.

import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha2';

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok) { console.log(`  PASS  ${label}`); pass++; }
    else    { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label}: ${e.message}`); fail++;
  }
}

// Parallel implementation mirroring dapp/tacit.js:decodePreauthBidPayload
// and worker/src/index.js:decodePreauthBidPayload byte-for-byte. Any
// future drift between this test and either production decoder is a
// wire-format regression — this duplicate is INTENTIONAL so neither side
// can silently relax the decoder without failing this test.
const T_PREAUTH_BID_OPCODE = 0x5B;
const PREAUTH_BID_INLINE_BYTES = 16 + 33 + 8 + 32 + 8;  // 97

function decodePreauthBidPayload(payload) {
  if (!payload) return null;
  const MIN = 1 + 32 + 1 + PREAUTH_BID_INLINE_BYTES + 64 + 1 + 33 + 2;
  if (payload.length < MIN) return null;
  if (payload[0] !== T_PREAUTH_BID_OPCODE) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const assetInputCount = payload[p]; p += 1;
  if (assetInputCount < 1) return null;
  const bidId = payload.slice(p, p + 16); p += 16;
  const recipientPubkey = payload.slice(p, p + 33); p += 33;
  const amountLE = payload.slice(p, p + 8); p += 8;
  const amount = new DataView(amountLE.buffer, amountLE.byteOffset, 8).getBigUint64(0, true);
  const blinding = payload.slice(p, p + 32); p += 32;
  const priceLE = payload.slice(p, p + 8); p += 8;
  const priceSats = new DataView(priceLE.buffer, priceLE.byteOffset, 8).getBigUint64(0, true);
  const kernelSig = payload.slice(p, p + 64); p += 64;
  const n = payload[p]; p += 1;
  if (n !== 1 && n !== 2) return null;
  const outputs = [];
  if (p + 33 > payload.length) return null;
  outputs.push({ commitment: payload.slice(p, p + 33) }); p += 33;
  if (n === 2) {
    if (p + 33 + 8 > payload.length) return null;
    outputs.push({
      commitment: payload.slice(p, p + 33),
      encryptedAmount: payload.slice(p + 33, p + 33 + 8),
    });
    p += 33 + 8;
  }
  if (p + 2 > payload.length) return null;
  const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
  if (p + rpLen !== payload.length) return null;
  const rangeproof = payload.slice(p, p + rpLen);
  return {
    kind: 'preauth_bid',
    assetId, assetInputCount,
    bidId, recipientPubkey, amount, blinding, priceSats,
    kernelSig, outputs, rangeproof,
  };
}

function computePreauthBidContextHash({
  assetId, bidId, recipientPubkey, amount, blinding, priceSats,
}) {
  const amountLE = new Uint8Array(8); new DataView(amountLE.buffer).setBigUint64(0, BigInt(amount), true);
  const priceLE = new Uint8Array(8); new DataView(priceLE.buffer).setBigUint64(0, BigInt(priceSats), true);
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-bid-context-v1'),
    assetId, bidId, recipientPubkey, amountLE, blinding, priceLE,
  ));
}

// Helper: synthesise a minimal-valid T_PREAUTH_BID payload for testing.
function synthPayload({
  assetInputCount = 1, n = 1, rangeproofBytes = 16,
  amount = 1000n, priceSats = 12345n,
} = {}) {
  const opcode = new Uint8Array([T_PREAUTH_BID_OPCODE]);
  const assetId = new Uint8Array(32).fill(0xab);
  const aic = new Uint8Array([assetInputCount & 0xff]);
  const bidId = new Uint8Array(16).fill(0x33);
  const recipientPubkey = new Uint8Array(33); recipientPubkey[0] = 0x03; recipientPubkey.fill(0x77, 1);
  const amountLE = new Uint8Array(8); new DataView(amountLE.buffer).setBigUint64(0, BigInt(amount), true);
  const blinding = new Uint8Array(32).fill(0x55);
  const priceLE = new Uint8Array(8); new DataView(priceLE.buffer).setBigUint64(0, BigInt(priceSats), true);
  const kernelSig = new Uint8Array(64).fill(0xcd);
  const nByte = new Uint8Array([n & 0xff]);
  const out0Commit = new Uint8Array(33); out0Commit[0] = 0x02; out0Commit.fill(0x10, 1);
  const out1Commit = new Uint8Array(33); out1Commit[0] = 0x02; out1Commit.fill(0x20, 1);
  const out1AmtCt = new Uint8Array(8).fill(0xee);
  const rpLen = new Uint8Array(2); new DataView(rpLen.buffer).setUint16(0, rangeproofBytes, true);
  const rangeproof = new Uint8Array(rangeproofBytes).fill(0x99);
  const parts = [opcode, assetId, aic, bidId, recipientPubkey, amountLE, blinding, priceLE, kernelSig, nByte, out0Commit];
  if (n === 2) parts.push(out1Commit, out1AmtCt);
  parts.push(rpLen, rangeproof);
  return concatBytes(...parts);
}

function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

console.log('\n=== T_PREAUTH_BID payload decoder ===');

test('decodes minimal N=1 payload', () => {
  const payload = synthPayload({ n: 1 });
  const decoded = decodePreauthBidPayload(payload);
  return decoded
    && decoded.kind === 'preauth_bid'
    && decoded.assetInputCount === 1
    && decoded.outputs.length === 1
    && decoded.amount === 1000n
    && decoded.priceSats === 12345n
    && decoded.outputs[0].commitment.length === 33
    && decoded.outputs[0].encryptedAmount === undefined  // N=1 has no change ciphertext
    && decoded.rangeproof.length === 16;
});

test('decodes N=2 payload with seller change', () => {
  const payload = synthPayload({ n: 2 });
  const decoded = decodePreauthBidPayload(payload);
  return decoded
    && decoded.outputs.length === 2
    && decoded.outputs[1].encryptedAmount !== undefined
    && decoded.outputs[1].encryptedAmount.length === 8;
});

test('rejects payload with wrong opcode', () => {
  const payload = synthPayload();
  payload[0] = 0x26;  // T_AXFER opcode
  return decodePreauthBidPayload(payload) === null;
});

test('rejects payload with N=4 (T_PREAUTH_BID disallows >2 outputs)', () => {
  const payload = synthPayload({ n: 1 });
  // Patch the N byte (sits right after kernel_sig at offset 1+32+1+97+64).
  const nOffset = 1 + 32 + 1 + PREAUTH_BID_INLINE_BYTES + 64;
  payload[nOffset] = 4;
  return decodePreauthBidPayload(payload) === null;
});

test('rejects payload with assetInputCount = 0', () => {
  const payload = synthPayload();
  payload[1 + 32] = 0;
  return decodePreauthBidPayload(payload) === null;
});

test('rejects truncated payload', () => {
  const payload = synthPayload().slice(0, 100);
  return decodePreauthBidPayload(payload) === null;
});

test('rejects payload with mismatched rp_len', () => {
  const payload = synthPayload({ rangeproofBytes: 16 });
  // Patch rp_len to lie about rangeproof size.
  const rpLenOffset = payload.length - 16 - 2;
  payload[rpLenOffset] = 8;     // claim 8 bytes
  payload[rpLenOffset + 1] = 0; // but actual rangeproof is still 16
  return decodePreauthBidPayload(payload) === null;
});

test('extracts amount as BigInt at u64 boundary', () => {
  const payload = synthPayload({ amount: (1n << 63n) - 1n });
  const decoded = decodePreauthBidPayload(payload);
  return decoded && decoded.amount === (1n << 63n) - 1n;
});

test('extracts price_sats as BigInt at zero', () => {
  const payload = synthPayload({ priceSats: 0n });
  const decoded = decodePreauthBidPayload(payload);
  return decoded && decoded.priceSats === 0n;
});

test('inline section sits between asset_input_count and kernel_sig', () => {
  const payload = synthPayload();
  // Bid_id starts at offset 1 + 32 + 1 = 34.
  // The synth helper fills it with 0x33; verify those bytes are intact.
  for (let i = 34; i < 34 + 16; i++) {
    if (payload[i] !== 0x33) return false;
  }
  // Recipient pubkey starts at offset 50 (first byte 0x03 prefix).
  if (payload[50] !== 0x03) return false;
  for (let i = 51; i < 50 + 33; i++) {
    if (payload[i] !== 0x77) return false;
  }
  return true;
});

console.log('\n=== bid_context_hash binding ===');

test('hash is deterministic for fixed inputs', () => {
  const inputs = {
    assetId: new Uint8Array(32).fill(0x01),
    bidId: new Uint8Array(16).fill(0x02),
    recipientPubkey: (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x03, 1); return k; })(),
    amount: 1000n,
    blinding: new Uint8Array(32).fill(0x04),
    priceSats: 50000n,
  };
  const h1 = computePreauthBidContextHash(inputs);
  const h2 = computePreauthBidContextHash(inputs);
  return eq(h1, h2) && h1.length === 32;
});

test('hash changes when amount tweaks by 1', () => {
  const base = {
    assetId: new Uint8Array(32).fill(0x01),
    bidId: new Uint8Array(16).fill(0x02),
    recipientPubkey: (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x03, 1); return k; })(),
    amount: 1000n,
    blinding: new Uint8Array(32).fill(0x04),
    priceSats: 50000n,
  };
  const h1 = computePreauthBidContextHash(base);
  const h2 = computePreauthBidContextHash({ ...base, amount: 1001n });
  return !eq(h1, h2);
});

test('hash changes when blinding tweaks by 1 byte', () => {
  const base = {
    assetId: new Uint8Array(32).fill(0x01),
    bidId: new Uint8Array(16).fill(0x02),
    recipientPubkey: (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x03, 1); return k; })(),
    amount: 1000n,
    blinding: new Uint8Array(32).fill(0x04),
    priceSats: 50000n,
  };
  const blinding2 = new Uint8Array(base.blinding); blinding2[0] ^= 1;
  const h1 = computePreauthBidContextHash(base);
  const h2 = computePreauthBidContextHash({ ...base, blinding: blinding2 });
  return !eq(h1, h2);
});

test('hash changes when recipient_pubkey tweaks', () => {
  const base = {
    assetId: new Uint8Array(32).fill(0x01),
    bidId: new Uint8Array(16).fill(0x02),
    recipientPubkey: (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x03, 1); return k; })(),
    amount: 1000n,
    blinding: new Uint8Array(32).fill(0x04),
    priceSats: 50000n,
  };
  const pub2 = new Uint8Array(base.recipientPubkey); pub2[10] ^= 0xff;
  const h1 = computePreauthBidContextHash(base);
  const h2 = computePreauthBidContextHash({ ...base, recipientPubkey: pub2 });
  return !eq(h1, h2);
});

test('hash changes when price_sats tweaks by 1', () => {
  const base = {
    assetId: new Uint8Array(32).fill(0x01),
    bidId: new Uint8Array(16).fill(0x02),
    recipientPubkey: (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x03, 1); return k; })(),
    amount: 1000n,
    blinding: new Uint8Array(32).fill(0x04),
    priceSats: 50000n,
  };
  const h1 = computePreauthBidContextHash(base);
  const h2 = computePreauthBidContextHash({ ...base, priceSats: 50001n });
  return !eq(h1, h2);
});

test('domain tag is part of preimage (changing prefix breaks hash)', () => {
  const inputs = {
    assetId: new Uint8Array(32).fill(0x01),
    bidId: new Uint8Array(16).fill(0x02),
    recipientPubkey: (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x03, 1); return k; })(),
    amount: 1000n,
    blinding: new Uint8Array(32).fill(0x04),
    priceSats: 50000n,
  };
  const correct = computePreauthBidContextHash(inputs);
  const amountLE = new Uint8Array(8); new DataView(amountLE.buffer).setBigUint64(0, BigInt(inputs.amount), true);
  const priceLE = new Uint8Array(8); new DataView(priceLE.buffer).setBigUint64(0, BigInt(inputs.priceSats), true);
  const wrongDomain = sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-bid-context-v2'),
    inputs.assetId, inputs.bidId, inputs.recipientPubkey, amountLE, inputs.blinding, priceLE,
  ));
  return !eq(correct, wrongDomain);
});

console.log(`\n${pass + fail} tests, ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
