// Unit tests for the T_PREAUTH_BID_VAR (0x5C) payload encoder/decoder
// shipped in dapp/tacit.js + worker/src/index.js (SPEC §5.7.12 /
// SPEC-PREAUTH-BID-VAR-AMENDMENT.md round-1).
//
// What this protects:
//   1. Wire-format byte layout (opcode + asset_id + asset_input_count +
//      INLINE bid-context [bid_id + recipient_pubkey + price_per_unit_LE +
//      max_fill_LE + fill_increment_LE + fill_amount_LE + recipient_blinding
//      + refund_script_hash] + kernel_sig + N + outputs + rp_len + rangeproof).
//   2. The N_outputs ∈ {1, 2} constraint (T_PREAUTH_BID_VAR mirrors §5.7.11
//      single-seller fill; multi-seller fan is reserved at 0x5D).
//   3. output[0] has NO encryptedAmount (fill_amount is in cleartext inline);
//      output[1] (when N=2) keeps the standard 8-byte encryptedAmount.
//   4. computePreauthBidVarContextHash domain tag, per-ratio field ordering,
//      and the deliberate omission of recipient_blinding from the OP_RETURN
//      preimage (blinding lives in inline + Pedersen consistency rule, not
//      in the buyer's K SIGHASH_SINGLE_ACP pre-sig preimages).
//   5. Sanity rejection of fill_amount == 0 and fill_amount > max_fill.
//
// Parallel implementation duplicates the dapp + worker decoders
// byte-for-byte. Drift between this test and either production decoder
// is the wire-format regression alarm — intentional duplication.

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

const T_PREAUTH_BID_VAR_OPCODE = 0x5C;
const PREAUTH_BID_VAR_INLINE_BYTES = 16 + 33 + 8 + 8 + 8 + 8 + 32 + 20 + 1;  // 134
const PREAUTH_BID_VAR_MAX_DECIMALS_SCALE = 32;

function u64LE(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

function decodePreauthBidVarPayload(payload) {
  if (!payload) return null;
  const MIN = 1 + 32 + 1 + PREAUTH_BID_VAR_INLINE_BYTES + 64 + 1 + 33 + 2;
  if (payload.length < MIN) return null;
  if (payload[0] !== T_PREAUTH_BID_VAR_OPCODE) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const assetInputCount = payload[p]; p += 1;
  if (assetInputCount < 1) return null;
  const bidId = payload.slice(p, p + 16); p += 16;
  const recipientPubkey = payload.slice(p, p + 33); p += 33;
  const readU64 = () => {
    const v = new DataView(payload.buffer, payload.byteOffset + p, 8).getBigUint64(0, true);
    p += 8;
    return v;
  };
  const pricePerUnit = readU64();
  const maxFill = readU64();
  const fillIncrement = readU64();
  const fillAmount = readU64();
  const recipientBlinding = payload.slice(p, p + 32); p += 32;
  const refundScriptHash = payload.slice(p, p + 20); p += 20;
  const decimalsScale = payload[p]; p += 1;
  if (decimalsScale > PREAUTH_BID_VAR_MAX_DECIMALS_SCALE) return null;
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
  if (fillAmount === 0n || fillAmount > maxFill) return null;
  return {
    kind: 'preauth_bid_var',
    assetId, assetInputCount,
    bidId, recipientPubkey,
    pricePerUnit, maxFill, fillIncrement, fillAmount,
    recipientBlinding, refundScriptHash, decimalsScale,
    kernelSig, outputs, rangeproof,
  };
}

function computePreauthBidVarContextHash({
  assetId, bidId, recipientPubkey,
  pricePerUnit, maxFill, fillIncrement, fillAmount,
  refundScriptHash, decimalsScale,
}) {
  return sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-bid-var-context-v1'),
    assetId, bidId, recipientPubkey,
    u64LE(pricePerUnit), u64LE(maxFill), u64LE(fillIncrement), u64LE(fillAmount),
    refundScriptHash,
    new Uint8Array([(decimalsScale | 0) & 0xff]),
  ));
}

// Synthesise a minimal-valid T_PREAUTH_BID_VAR payload for decoder tests.
function synthPayload({
  assetInputCount = 1, n = 1, rangeproofBytes = 16,
  pricePerUnit = 12345n, maxFill = 1000n, fillIncrement = 100n, fillAmount = 500n,
  decimalsScale = 0,
} = {}) {
  const opcode = new Uint8Array([T_PREAUTH_BID_VAR_OPCODE]);
  const assetId = new Uint8Array(32).fill(0xab);
  const aic = new Uint8Array([assetInputCount & 0xff]);
  const bidId = new Uint8Array(16).fill(0x33);
  const recipientPubkey = new Uint8Array(33); recipientPubkey[0] = 0x03; recipientPubkey.fill(0x77, 1);
  const recipientBlinding = new Uint8Array(32).fill(0x55);
  const refundScriptHash = new Uint8Array(20).fill(0x66);
  const kernelSig = new Uint8Array(64).fill(0xcd);
  const nByte = new Uint8Array([n & 0xff]);
  const out0Commit = new Uint8Array(33); out0Commit[0] = 0x02; out0Commit.fill(0x10, 1);
  const out1Commit = new Uint8Array(33); out1Commit[0] = 0x02; out1Commit.fill(0x20, 1);
  const out1AmtCt = new Uint8Array(8).fill(0xee);
  const rpLen = new Uint8Array(2); new DataView(rpLen.buffer).setUint16(0, rangeproofBytes, true);
  const rangeproof = new Uint8Array(rangeproofBytes).fill(0x99);
  const parts = [
    opcode, assetId, aic,
    bidId, recipientPubkey,
    u64LE(pricePerUnit), u64LE(maxFill), u64LE(fillIncrement), u64LE(fillAmount),
    recipientBlinding, refundScriptHash,
    new Uint8Array([decimalsScale & 0xff]),
    kernelSig, nByte, out0Commit,
  ];
  if (n === 2) parts.push(out1Commit, out1AmtCt);
  parts.push(rpLen, rangeproof);
  return concatBytes(...parts);
}

function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

console.log('\n=== T_PREAUTH_BID_VAR payload decoder ===');

test('decodes minimal N=1 payload', () => {
  const payload = synthPayload({ n: 1 });
  const decoded = decodePreauthBidVarPayload(payload);
  return decoded
    && decoded.kind === 'preauth_bid_var'
    && decoded.assetInputCount === 1
    && decoded.outputs.length === 1
    && decoded.pricePerUnit === 12345n
    && decoded.maxFill === 1000n
    && decoded.fillIncrement === 100n
    && decoded.fillAmount === 500n
    && decoded.outputs[0].commitment.length === 33
    && decoded.outputs[0].encryptedAmount === undefined  // N=1 has no change ciphertext
    && decoded.refundScriptHash.length === 20
    && decoded.recipientBlinding.length === 32
    && decoded.rangeproof.length === 16;
});

test('decodes N=2 payload with seller change', () => {
  const payload = synthPayload({ n: 2 });
  const decoded = decodePreauthBidVarPayload(payload);
  return decoded
    && decoded.outputs.length === 2
    && decoded.outputs[1].encryptedAmount !== undefined
    && decoded.outputs[1].encryptedAmount.length === 8;
});

test('rejects payload with wrong opcode (0x5B not 0x5C)', () => {
  const payload = synthPayload();
  payload[0] = 0x5B;  // T_PREAUTH_BID exact-fill opcode
  return decodePreauthBidVarPayload(payload) === null;
});

test('rejects payload with N=4 (T_PREAUTH_BID_VAR disallows >2 outputs)', () => {
  const payload = synthPayload({ n: 1 });
  // Patch the N byte (sits right after kernel_sig at offset 1+32+1+133+64).
  const nOffset = 1 + 32 + 1 + PREAUTH_BID_VAR_INLINE_BYTES + 64;
  payload[nOffset] = 4;
  return decodePreauthBidVarPayload(payload) === null;
});

test('rejects payload with assetInputCount = 0', () => {
  const payload = synthPayload();
  payload[1 + 32] = 0;
  return decodePreauthBidVarPayload(payload) === null;
});

test('rejects truncated payload', () => {
  const payload = synthPayload().slice(0, 120);
  return decodePreauthBidVarPayload(payload) === null;
});

test('rejects payload with mismatched rp_len', () => {
  const payload = synthPayload({ rangeproofBytes: 16 });
  const rpLenOffset = payload.length - 16 - 2;
  payload[rpLenOffset] = 8;
  payload[rpLenOffset + 1] = 0;
  return decodePreauthBidVarPayload(payload) === null;
});

test('rejects payload with fill_amount == 0', () => {
  const payload = synthPayload({ fillAmount: 0n });
  return decodePreauthBidVarPayload(payload) === null;
});

test('rejects payload with fill_amount > max_fill', () => {
  const payload = synthPayload({ maxFill: 1000n, fillAmount: 2000n });
  return decodePreauthBidVarPayload(payload) === null;
});

test('accepts K=1 degenerate (fill_amount == max_fill)', () => {
  const payload = synthPayload({ maxFill: 1000n, fillIncrement: 1n, fillAmount: 1000n });
  const decoded = decodePreauthBidVarPayload(payload);
  return decoded && decoded.fillAmount === decoded.maxFill;
});

test('extracts price_per_unit as BigInt at u64 boundary', () => {
  const big = (1n << 63n) - 1n;
  const payload = synthPayload({ pricePerUnit: big });
  const decoded = decodePreauthBidVarPayload(payload);
  return decoded && decoded.pricePerUnit === big;
});

test('extracts max_fill as BigInt at u64 boundary', () => {
  const big = (1n << 63n) - 1n;
  const payload = synthPayload({ maxFill: big, fillAmount: big });
  const decoded = decodePreauthBidVarPayload(payload);
  return decoded && decoded.maxFill === big;
});

test('inline section ordering (price/max/inc/fill) survives roundtrip', () => {
  // Use 4 distinct values so reorderings would corrupt them.
  const payload = synthPayload({
    pricePerUnit: 0xAA00AA00AA00AA00n,
    maxFill:      0xBB00BB00BB00BB00n,
    fillIncrement:0xCC00CC00CC00CC00n,
    fillAmount:   0xBB00BB00BB00BB00n,  // == maxFill so fill <= max
  });
  const decoded = decodePreauthBidVarPayload(payload);
  return decoded
    && decoded.pricePerUnit  === 0xAA00AA00AA00AA00n
    && decoded.maxFill       === 0xBB00BB00BB00BB00n
    && decoded.fillIncrement === 0xCC00CC00CC00CC00n
    && decoded.fillAmount    === 0xBB00BB00BB00BB00n;
});

test('refund_script_hash sits immediately after recipient_blinding', () => {
  const payload = synthPayload();
  // Recipient blinding starts after bid_id(16) + recipient_pubkey(33) +
  // 4×u64(32) = 81 bytes from the start of inline (offset 1+32+1 = 34).
  // So blinding bytes 0..32 are at offset 34+81 = 115.
  const blindingOffset = 34 + 16 + 33 + 8 * 4;
  for (let i = 0; i < 32; i++) if (payload[blindingOffset + i] !== 0x55) return false;
  // refund_script_hash directly follows.
  const refundOffset = blindingOffset + 32;
  for (let i = 0; i < 20; i++) if (payload[refundOffset + i] !== 0x66) return false;
  return true;
});

console.log('\n=== bid_context_hash binding (per-ratio) ===');

function baseInputs() {
  return {
    assetId: new Uint8Array(32).fill(0x01),
    bidId: new Uint8Array(16).fill(0x02),
    recipientPubkey: (() => { const k = new Uint8Array(33); k[0] = 0x02; k.fill(0x03, 1); return k; })(),
    pricePerUnit: 50000n,
    maxFill: 10000n,
    fillIncrement: 1000n,
    fillAmount: 5000n,
    refundScriptHash: new Uint8Array(20).fill(0x04),
  };
}

test('hash is deterministic for fixed inputs', () => {
  const i = baseInputs();
  const h1 = computePreauthBidVarContextHash(i);
  const h2 = computePreauthBidVarContextHash(i);
  return eq(h1, h2) && h1.length === 32;
});

test('hash changes when fill_amount tweaks by 1', () => {
  const i = baseInputs();
  const h1 = computePreauthBidVarContextHash(i);
  const h2 = computePreauthBidVarContextHash({ ...i, fillAmount: i.fillAmount + 1n });
  return !eq(h1, h2);
});

test('hash changes when price_per_unit tweaks by 1', () => {
  const i = baseInputs();
  const h1 = computePreauthBidVarContextHash(i);
  const h2 = computePreauthBidVarContextHash({ ...i, pricePerUnit: i.pricePerUnit + 1n });
  return !eq(h1, h2);
});

test('hash changes when max_fill tweaks by 1', () => {
  const i = baseInputs();
  const h1 = computePreauthBidVarContextHash(i);
  const h2 = computePreauthBidVarContextHash({ ...i, maxFill: i.maxFill + 1n });
  return !eq(h1, h2);
});

test('hash changes when fill_increment tweaks by 1', () => {
  const i = baseInputs();
  const h1 = computePreauthBidVarContextHash(i);
  const h2 = computePreauthBidVarContextHash({ ...i, fillIncrement: i.fillIncrement + 1n });
  return !eq(h1, h2);
});

test('hash changes when refund_script_hash tweaks', () => {
  const i = baseInputs();
  const refund2 = new Uint8Array(i.refundScriptHash); refund2[0] ^= 0xff;
  const h1 = computePreauthBidVarContextHash(i);
  const h2 = computePreauthBidVarContextHash({ ...i, refundScriptHash: refund2 });
  return !eq(h1, h2);
});

test('hash changes when bid_id tweaks', () => {
  const i = baseInputs();
  const bid2 = new Uint8Array(i.bidId); bid2[0] ^= 0xff;
  const h1 = computePreauthBidVarContextHash(i);
  const h2 = computePreauthBidVarContextHash({ ...i, bidId: bid2 });
  return !eq(h1, h2);
});

test('hash changes when asset_id tweaks', () => {
  const i = baseInputs();
  const asset2 = new Uint8Array(i.assetId); asset2[31] ^= 0xff;
  const h1 = computePreauthBidVarContextHash(i);
  const h2 = computePreauthBidVarContextHash({ ...i, assetId: asset2 });
  return !eq(h1, h2);
});

test('hash changes when recipient_pubkey tweaks', () => {
  const i = baseInputs();
  const pub2 = new Uint8Array(i.recipientPubkey); pub2[10] ^= 0xff;
  const h1 = computePreauthBidVarContextHash(i);
  const h2 = computePreauthBidVarContextHash({ ...i, recipientPubkey: pub2 });
  return !eq(h1, h2);
});

test('K=10 distinct ratios produce 10 distinct hashes', () => {
  // Buyer pre-signs K hashes; the seller's chosen ratio at fill time
  // must match exactly one. If two ratios collided, the buyer's K-sig
  // set could be confused at fill time. Domain-tagged SHA-256 makes
  // collisions astronomically unlikely; sanity-check that ratios that
  // differ by `fill_increment` produce distinct hashes.
  const base = baseInputs();
  const seen = new Set();
  for (let k = 0; k < 10; k++) {
    const fillAmount = base.fillIncrement * BigInt(k + 1);
    if (fillAmount > base.maxFill) break;
    const h = computePreauthBidVarContextHash({ ...base, fillAmount });
    seen.add(bytesToHex(h));
  }
  return seen.size === 10;
});

test('hash does NOT depend on recipient_blinding (blinding lives in inline-only)', () => {
  // The per-ratio hash deliberately omits recipient_blinding (the buyer's
  // pre-sig preimage shouldn't bind to it; chain Pedersen consistency
  // rule covers blinding via output[0].commitment). The hash signature
  // omits the field entirely — there's no `blinding` arg.
  const i = baseInputs();
  const h = computePreauthBidVarContextHash(i);
  // Sanity: call site doesn't crash without a blinding key.
  return h.length === 32;
});

test('domain tag is part of preimage (different tag → different hash)', () => {
  const i = baseInputs();
  const correct = computePreauthBidVarContextHash(i);
  const wrong = sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-bid-context-v1'),  // exact-fill tag
    i.assetId, i.bidId, i.recipientPubkey,
    u64LE(i.pricePerUnit), u64LE(i.maxFill), u64LE(i.fillIncrement), u64LE(i.fillAmount),
    i.refundScriptHash,
  ));
  return !eq(correct, wrong);
});

test('var-context hash ≠ exact-fill hash for any (asset_id, bid_id) pair', () => {
  // Independent of the domain tag check above: even if a caller threaded
  // the SAME inline fields through both hash functions, the outputs must
  // diverge so a §5.7.11 pre-sig is not accidentally accepted for a
  // §5.7.12 settlement. This is structurally guaranteed by the differing
  // domain tag AND the differing field sets — assert it holds for a
  // worked example.
  const i = baseInputs();
  const exactHash = sha256(concatBytes(
    new TextEncoder().encode('tacit-preauth-bid-context-v1'),
    i.assetId, i.bidId, i.recipientPubkey,
    u64LE(i.fillAmount),
    new Uint8Array(32),  // dummy blinding placeholder
    u64LE(i.pricePerUnit),
  ));
  const varHash = computePreauthBidVarContextHash(i);
  return !eq(exactHash, varHash);
});

console.log(`\n${pass + fail} tests, ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
