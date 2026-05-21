// Integration test for T_PREAUTH_BID's chain-only recipient-credit path
// shipped in dapp/tacit.js scanHoldings (Stage 2b).
//
// What this protects:
//   1. Recipient credit happens when output[0].commitment opens to the
//      inline (amount, blinding) under Pedersen.
//   2. Wrong (amount, blinding) opening rejects (no credit).
//   3. The wire format the test synthesises is byte-identical to what
//      dapp/tacit.js encodePreauthBidPayload + worker/src/index.js
//      decodePreauthBidPayload agree on.
//
// We don't drive the actual scanHoldings function here (that's wired
// deep into the dapp's wallet/UTXO loop and pulls a lot of context).
// Instead we exercise the LOGIC path: decode envelope → recover
// (amount, blinding) from the inline section → verify Pedersen
// consistency → produce a credit.

import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));

const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = secp.ProjectivePoint.BASE;
const ZERO = secp.ProjectivePoint.ZERO;

function deriveH() {
  const seed = sha256(new TextEncoder().encode('tacit-generator-H-v1'));
  for (let counter = 0; counter < 256; counter++) {
    const x = sha256(concatBytes(seed, new Uint8Array([counter])));
    const candidate = concatBytes(new Uint8Array([0x02]), x);
    try {
      const p = secp.ProjectivePoint.fromHex(bytesToHex(candidate));
      if (!p.equals(ZERO)) return p;
    } catch {}
  }
  throw new Error('failed');
}
const H = deriveH();
const modN = x => ((x % SECP_N) + SECP_N) % SECP_N;
function pedersenCommit(amount, blinding) {
  const a = modN(BigInt(amount));
  const r = modN(BigInt(blinding));
  const aH = a === 0n ? ZERO : H.multiply(a);
  const rG = r === 0n ? ZERO : G.multiply(r);
  return aH.add(rG);
}
const bytes32ToBigint = b => BigInt('0x' + bytesToHex(b));

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

// Parallel decoder, byte-identical to dapp/tacit.js:decodePreauthBidPayload.
const T_PREAUTH_BID_OPCODE = 0x5B;
const PREAUTH_BID_INLINE_BYTES = 16 + 33 + 8 + 32 + 8;
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
  return {
    kind: 'preauth_bid',
    assetId, assetInputCount,
    bidId, recipientPubkey, amount, blinding, priceSats,
    kernelSig, outputs,
    rangeproof: payload.slice(p, p + rpLen),
  };
}

// Mirror of the recovery branch in dapp/tacit.js:scanHoldings.
//
// Given a decoded T_PREAUTH_BID envelope and the on-chain commitment
// at vout[0], try to recover the recipient lot's (amount, blinding)
// from the inline section. Returns { amount, blinding } on success or
// null if the inline opening doesn't match the commitment.
function recoverPreauthBidRecipientOpening(dec, onChainCommitment) {
  if (!dec || dec.kind !== 'preauth_bid') return null;
  try {
    const amt = dec.amount;
    const r = bytes32ToBigint(dec.blinding) % SECP_N;
    const pointFromBytes = b => secp.ProjectivePoint.fromHex(bytesToHex(b));
    if (pedersenCommit(amt, r).equals(pointFromBytes(onChainCommitment))) {
      return { amount: amt, blinding: r };
    }
  } catch {}
  return null;
}

// Synthesise a valid T_PREAUTH_BID envelope payload. The output[0]
// commitment is the canonical Pedersen of (amount, blinding) from the
// inline section.
function synthValidPayload({ amount = 1000n, blinding = null } = {}) {
  const _blinding = blinding || new Uint8Array(32).fill(0x55);
  const recipientCommit = pedersenCommit(amount, bytes32ToBigint(_blinding) % SECP_N).toRawBytes(true);
  const opcode = new Uint8Array([T_PREAUTH_BID_OPCODE]);
  const assetId = new Uint8Array(32).fill(0xab);
  const aic = new Uint8Array([1]);
  const bidId = new Uint8Array(16).fill(0x33);
  const recipientPubkey = new Uint8Array(33); recipientPubkey[0] = 0x03; recipientPubkey.fill(0x77, 1);
  const amountLE = new Uint8Array(8); new DataView(amountLE.buffer).setBigUint64(0, BigInt(amount), true);
  const priceLE = new Uint8Array(8); new DataView(priceLE.buffer).setBigUint64(0, 12345n, true);
  const kernelSig = new Uint8Array(64).fill(0xcd);
  const nByte = new Uint8Array([1]);
  const rpLen = new Uint8Array(2); new DataView(rpLen.buffer).setUint16(0, 16, true);
  const rangeproof = new Uint8Array(16).fill(0x99);
  return concatBytes(
    opcode, assetId, aic, bidId, recipientPubkey, amountLE, _blinding, priceLE,
    kernelSig, nByte, recipientCommit, rpLen, rangeproof,
  );
}

console.log('\n=== T_PREAUTH_BID scan-side recovery ===');

test('recovers (amount, blinding) when commitment matches inline opening', () => {
  const payload = synthValidPayload({ amount: 5000n });
  const dec = decodePreauthBidPayload(payload);
  if (!dec) return false;
  const onChainCommit = dec.outputs[0].commitment;
  const recovered = recoverPreauthBidRecipientOpening(dec, onChainCommit);
  return recovered !== null && recovered.amount === 5000n;
});

test('rejects when commitment in tx does not match inline opening', () => {
  const payload = synthValidPayload({ amount: 5000n });
  const dec = decodePreauthBidPayload(payload);
  if (!dec) return false;
  // Tamper: replace commit with a pedersen of a DIFFERENT amount.
  const tampered = pedersenCommit(9999n, bytes32ToBigint(dec.blinding) % SECP_N).toRawBytes(true);
  const recovered = recoverPreauthBidRecipientOpening(dec, tampered);
  return recovered === null;
});

test('rejects when inline blinding differs from the one used in commit', () => {
  const payload = synthValidPayload({ amount: 5000n });
  const dec = decodePreauthBidPayload(payload);
  if (!dec) return false;
  // Tamper: commit uses the right amount but a different blinding.
  const tamperedBlinding = new Uint8Array(32).fill(0x77);
  const tamperedCommit = pedersenCommit(5000n, bytes32ToBigint(tamperedBlinding) % SECP_N).toRawBytes(true);
  const recovered = recoverPreauthBidRecipientOpening(dec, tamperedCommit);
  // The inline blinding (0x55) is what the wallet uses; if the on-chain
  // commit was built from a DIFFERENT blinding (0x77), Pedersen check
  // fails and the wallet correctly refuses the credit.
  return recovered === null;
});

test('handles u64 boundary amount (2^63 - 1)', () => {
  const big = (1n << 63n) - 1n;
  const payload = synthValidPayload({ amount: big });
  const dec = decodePreauthBidPayload(payload);
  if (!dec) return false;
  const recovered = recoverPreauthBidRecipientOpening(dec, dec.outputs[0].commitment);
  return recovered !== null && recovered.amount === big;
});

test('handles amount = 0 (degenerate but legal Pedersen of 0)', () => {
  const payload = synthValidPayload({ amount: 0n });
  const dec = decodePreauthBidPayload(payload);
  if (!dec) return false;
  const recovered = recoverPreauthBidRecipientOpening(dec, dec.outputs[0].commitment);
  return recovered !== null && recovered.amount === 0n;
});

console.log(`\n${pass + fail} tests, ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
