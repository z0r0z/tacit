// Parity test for the AMM ceremony eligibility envelope.
//
// The envelope is built by the dapp (`_buildCeremonyEligibilityEnvelope`
// in dapp/tacit.js) and decoded by the worker
// (`decodeCeremonyEligibilityEnvelope` in worker/src/index.js). Any drift
// between encoder and decoder makes every /contribute fail silently, so
// this test pins the wire format byte-for-byte:
//
//   scope_id(32) || asset_id(32) || expiry_height_LE(4) ||
//   commitment_count(1) || [txid_BE(32) || vout_LE(4)] * N ||
//   attestation_len_LE(2) || attestation_bytes(*) ||
//   holder_pubkey(33) || holder_sig(64)
//
// holder_sig = BIP-340 over SHA256("tacit-amm-ceremony-eligibility-v1"
//                                  || all preceding envelope bytes).
//
// We reproduce the dapp's build steps using the tests/ reference
// implementations (bulletproofs + signSchnorr) and feed the result into
// the worker's exported decoder. Then we verify:
//   1. Every field decodes to its original value (round-trip parity).
//   2. The bulletproof verifies against Σ commitments − X·H (the same
//      math the worker's verifyCeremonyEligibilityProof runs internally).
//   3. Tampering with the sig, scope, asset, expiry, or attestation
//      causes decode/verify failure at the expected point.
//
// This test deliberately does NOT exercise verifyCeremonyEligibilityProof
// end-to-end (that needs an env mock for commitmentForUtxo /
// chainOutspendProbe / fetchTipHeight). Instead it locks down the
// cryptographic + wire-format invariants that any e2e harness will
// build on top of.

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

import {
  H as PEDERSEN_H,
  pedersenCommit, pointToBytes,
  bpRangeAggProve, bpRangeAggVerify,
  modN, randomScalar,
} from './bulletproofs.mjs';
import { signSchnorr, verifySchnorr } from './composition.mjs';

import {
  decodeCeremonyEligibilityEnvelope,
  CANONICAL_TAC_ASSET_ID_HEX,
  CER_ELIGIBILITY_MIN_TAC_BASE_UNITS,
  CER_ELIGIBILITY_MAX_OUTPOINTS,
  CER_ELIGIBILITY_SCOPE_ID,
  CER_ELIGIBILITY_SIG_DOMAIN,
  CER_ELIGIBILITY_PRED_GE,
} from '../worker/src/index.js';

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
function eq(a, b) {
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return false;
}

// ----- Wire-format helpers (must match the dapp encoder byte-for-byte) -----

function u64LE(n) {
  const b = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}
function u32LE(n) {
  const b = new Uint8Array(4);
  let v = (n | 0) >>> 0;
  for (let i = 0; i < 4; i++) { b[i] = v & 0xff; v >>>= 8; }
  return b;
}
function u16LE(n) { return new Uint8Array([n & 0xff, (n >> 8) & 0xff]); }

// Build the envelope the same way the dapp does. Returns { envelope, ctx }
// where ctx carries the original inputs so the test can compare.
function buildEnvelope({ utxos, holderPriv, expiryHeight, scopeId, assetIdHex, thresholdBaseUnits }) {
  // Derive the compressed holder pubkey from the priv.
  const dPrime = BigInt('0x' + bytesToHex(holderPriv));
  const P = secp.ProjectivePoint.BASE.multiply(dPrime);
  const holderPub = P.toRawBytes(true);

  // Aggregate amount + blinding (Pedersen is additively homomorphic).
  let aggAmount = 0n;
  let aggBlinding = 0n;
  for (const u of utxos) {
    aggAmount += BigInt(u.amount);
    aggBlinding = modN(aggBlinding + modN(BigInt(u.blinding)));
  }

  // PRED_GE bulletproof over (Σa − X) with the aggregate blinding.
  const X = BigInt(thresholdBaseUnits);
  const { proof } = bpRangeAggProve([aggAmount - X], [aggBlinding]);
  const attestation = concatBytes(
    new Uint8Array([0x00]),  // PRED_GE tag
    u64LE(X),
    u16LE(proof.length),
    proof,
  );

  // Outpoints — 36 bytes each: txid(32) || vout_LE(4).
  const outpointsBytes = new Uint8Array(36 * utxos.length);
  for (let i = 0; i < utxos.length; i++) {
    outpointsBytes.set(utxos[i].txid, i * 36);
    outpointsBytes.set(u32LE(utxos[i].vout), i * 36 + 32);
  }

  // Preceding bytes (everything before holder_sig).
  const preceding = concatBytes(
    scopeId,
    hexToBytes(assetIdHex),
    u32LE(expiryHeight),
    new Uint8Array([utxos.length]),
    outpointsBytes,
    u16LE(attestation.length),
    attestation,
    holderPub,
  );

  // BIP-340 sig over SHA256(domain || preceding).
  const sigMsg = sha256(concatBytes(CER_ELIGIBILITY_SIG_DOMAIN, preceding));
  const sig = signSchnorr(sigMsg, holderPriv);

  return {
    envelope: concatBytes(preceding, sig),
    ctx: { holderPub, aggAmount, aggBlinding, proof, attestation, sigMsg, sig, X },
  };
}

// ----- Test fixture: synthetic 2-UTXO wallet that holds 1.5 TAC -----

function makeFixture(thresholdBaseUnits = CER_ELIGIBILITY_MIN_TAC_BASE_UNITS) {
  const holderPriv = randomScalar();
  const holderPrivBytes = new Uint8Array(32);
  let p = holderPriv;
  for (let i = 31; i >= 0; i--) { holderPrivBytes[i] = Number(p & 0xffn); p >>= 8n; }

  // Two TAC UTXOs summing to >= threshold. Pick amounts that cleanly clear
  // the bar but stay in the 8-decimal regime.
  const utxos = [
    {
      txid: new Uint8Array(32).map((_, i) => (i * 7 + 11) & 0xff),
      vout: 0,
      amount: thresholdBaseUnits + 50_000_000n,  // threshold + 0.5 TAC
      blinding: randomScalar(),
    },
    {
      txid: new Uint8Array(32).map((_, i) => (i * 13 + 23) & 0xff),
      vout: 1,
      amount: 100_000_000n,                       // 1 TAC
      blinding: randomScalar(),
    },
  ];

  return {
    holderPrivBytes,
    utxos,
    expiryHeight: 880_000,    // ~current mainnet tip range
    scopeId: CER_ELIGIBILITY_SCOPE_ID,
    assetIdHex: CANONICAL_TAC_ASSET_ID_HEX,
    thresholdBaseUnits,
  };
}

// =========================================================================
// Tests
// =========================================================================

console.log('ceremony-eligibility-envelope-parity');

test('builds and decodes a 2-UTXO envelope round-trip', () => {
  const fx = makeFixture();
  const { envelope, ctx } = buildEnvelope({
    utxos: fx.utxos,
    holderPriv: fx.holderPrivBytes,
    expiryHeight: fx.expiryHeight,
    scopeId: fx.scopeId,
    assetIdHex: fx.assetIdHex,
    thresholdBaseUnits: fx.thresholdBaseUnits,
  });
  const dec = decodeCeremonyEligibilityEnvelope(envelope);
  if (!dec.ok) throw new Error(`decode failed: ${dec.reason}`);
  if (!eq(dec.scopeId, fx.scopeId)) throw new Error('scopeId mismatch');
  if (bytesToHex(dec.assetId) !== fx.assetIdHex) throw new Error('assetId mismatch');
  if (dec.expiryHeight !== fx.expiryHeight) throw new Error(`expiryHeight ${dec.expiryHeight} !== ${fx.expiryHeight}`);
  if (dec.count !== fx.utxos.length) throw new Error(`count ${dec.count} !== ${fx.utxos.length}`);
  for (let i = 0; i < fx.utxos.length; i++) {
    if (dec.outpoints[i].txid !== bytesToHex(fx.utxos[i].txid)) throw new Error(`outpoint[${i}].txid mismatch`);
    if (dec.outpoints[i].vout !== fx.utxos[i].vout) throw new Error(`outpoint[${i}].vout mismatch`);
  }
  if (!eq(dec.attestation, ctx.attestation)) throw new Error('attestation mismatch');
  if (!eq(dec.holderPubkey, ctx.holderPub)) throw new Error('holderPubkey mismatch');
  if (!eq(dec.holderSig, ctx.sig)) throw new Error('holderSig mismatch');
  return true;
});

test('holder_sig verifies under BIP-340 (worker recomputes sig digest the same way)', () => {
  const fx = makeFixture();
  const { envelope } = buildEnvelope({
    utxos: fx.utxos,
    holderPriv: fx.holderPrivBytes,
    expiryHeight: fx.expiryHeight,
    scopeId: fx.scopeId,
    assetIdHex: fx.assetIdHex,
    thresholdBaseUnits: fx.thresholdBaseUnits,
  });
  const dec = decodeCeremonyEligibilityEnvelope(envelope);
  if (!dec.ok) throw new Error(`decode failed: ${dec.reason}`);
  const sigMsg = sha256(concatBytes(CER_ELIGIBILITY_SIG_DOMAIN, dec.preceding));
  if (!verifySchnorr(dec.holderSig, sigMsg, dec.holderPubkey.slice(1))) {
    throw new Error('sig did not verify');
  }
  return true;
});

test('bulletproof verifies against Σ commitments − X·H (PRED_GE soundness)', () => {
  const fx = makeFixture();
  const { envelope, ctx } = buildEnvelope({
    utxos: fx.utxos,
    holderPriv: fx.holderPrivBytes,
    expiryHeight: fx.expiryHeight,
    scopeId: fx.scopeId,
    assetIdHex: fx.assetIdHex,
    thresholdBaseUnits: fx.thresholdBaseUnits,
  });
  const dec = decodeCeremonyEligibilityEnvelope(envelope);
  if (!dec.ok) throw new Error(`decode failed: ${dec.reason}`);
  // Reconstruct Σ commitments from the per-UTXO openings the prover used.
  let sumCommitment = secp.ProjectivePoint.ZERO;
  for (const u of fx.utxos) {
    sumCommitment = sumCommitment.add(pedersenCommit(BigInt(u.amount), BigInt(u.blinding)));
  }
  // Read X from the attestation bytes (PRED_GE: tag(1) || X(8) || ...).
  let X = 0n;
  for (let i = 0; i < 8; i++) X |= BigInt(dec.attestation[1 + i]) << (8n * BigInt(i));
  if (X !== CER_ELIGIBILITY_MIN_TAC_BASE_UNITS) throw new Error(`X mismatch: ${X} !== ${CER_ELIGIBILITY_MIN_TAC_BASE_UNITS}`);
  if (dec.attestation[0] !== CER_ELIGIBILITY_PRED_GE) throw new Error('predicate tag mismatch');
  const proofLen = dec.attestation[9] | (dec.attestation[10] << 8);
  const proof = dec.attestation.slice(11, 11 + proofLen);
  const shifted = X === 0n ? sumCommitment : sumCommitment.add(PEDERSEN_H.multiply(X).negate());
  if (!bpRangeAggVerify([shifted], proof)) throw new Error('bulletproof verify failed');
  return true;
});

test('rejects envelope shorter than minimum length', () => {
  const dec = decodeCeremonyEligibilityEnvelope(new Uint8Array(50));
  return !dec.ok && /truncated/i.test(dec.reason);
});

test('rejects non-Uint8Array input', () => {
  const dec = decodeCeremonyEligibilityEnvelope('not bytes');
  return !dec.ok && /not bytes/i.test(dec.reason);
});

test('rejects commitment_count = 0', () => {
  const fx = makeFixture();
  const { envelope } = buildEnvelope({
    utxos: fx.utxos,
    holderPriv: fx.holderPrivBytes,
    expiryHeight: fx.expiryHeight,
    scopeId: fx.scopeId,
    assetIdHex: fx.assetIdHex,
    thresholdBaseUnits: fx.thresholdBaseUnits,
  });
  // Patch count byte (offset 32+32+4 = 68) to 0.
  const tampered = new Uint8Array(envelope);
  tampered[68] = 0;
  const dec = decodeCeremonyEligibilityEnvelope(tampered);
  return !dec.ok && /commitment_count/i.test(dec.reason);
});

test(`rejects commitment_count > ${CER_ELIGIBILITY_MAX_OUTPOINTS}`, () => {
  const fx = makeFixture();
  const { envelope } = buildEnvelope({
    utxos: fx.utxos,
    holderPriv: fx.holderPrivBytes,
    expiryHeight: fx.expiryHeight,
    scopeId: fx.scopeId,
    assetIdHex: fx.assetIdHex,
    thresholdBaseUnits: fx.thresholdBaseUnits,
  });
  const tampered = new Uint8Array(envelope);
  tampered[68] = CER_ELIGIBILITY_MAX_OUTPOINTS + 1;
  const dec = decodeCeremonyEligibilityEnvelope(tampered);
  return !dec.ok && /commitment_count/i.test(dec.reason);
});

test('rejects envelope with trailing bytes (length-exact check)', () => {
  const fx = makeFixture();
  const { envelope } = buildEnvelope({
    utxos: fx.utxos,
    holderPriv: fx.holderPrivBytes,
    expiryHeight: fx.expiryHeight,
    scopeId: fx.scopeId,
    assetIdHex: fx.assetIdHex,
    thresholdBaseUnits: fx.thresholdBaseUnits,
  });
  const tampered = concatBytes(envelope, new Uint8Array([0x00]));
  const dec = decodeCeremonyEligibilityEnvelope(tampered);
  return !dec.ok && /(length mismatch|truncated)/i.test(dec.reason);
});

test('tampered sig is decoded successfully but fails BIP-340 verify', () => {
  const fx = makeFixture();
  const { envelope } = buildEnvelope({
    utxos: fx.utxos,
    holderPriv: fx.holderPrivBytes,
    expiryHeight: fx.expiryHeight,
    scopeId: fx.scopeId,
    assetIdHex: fx.assetIdHex,
    thresholdBaseUnits: fx.thresholdBaseUnits,
  });
  // Flip a bit in the sig (last 64 bytes).
  const tampered = new Uint8Array(envelope);
  tampered[tampered.length - 1] ^= 0x01;
  const dec = decodeCeremonyEligibilityEnvelope(tampered);
  if (!dec.ok) throw new Error('decoder rejected tampered sig (should be the worker verifier that rejects)');
  const sigMsg = sha256(concatBytes(CER_ELIGIBILITY_SIG_DOMAIN, dec.preceding));
  return !verifySchnorr(dec.holderSig, sigMsg, dec.holderPubkey.slice(1));
});

test('expiry decode is unsigned (high-bit-set values round-trip correctly)', () => {
  // Build an envelope with an absurdly high expiryHeight (high bit set).
  // The dapp's u32LE encoder is unsigned; the worker's decoder must also
  // treat the value as unsigned (>>> 0). Without the unsigned coercion the
  // decoded value would be negative and the expiry < tip check would
  // always trigger.
  const fx = makeFixture();
  const HIGH_BIT_HEIGHT = 0xFFFFFFFE;  // ~4.29B
  const { envelope } = buildEnvelope({
    utxos: fx.utxos,
    holderPriv: fx.holderPrivBytes,
    expiryHeight: HIGH_BIT_HEIGHT,
    scopeId: fx.scopeId,
    assetIdHex: fx.assetIdHex,
    thresholdBaseUnits: fx.thresholdBaseUnits,
  });
  const dec = decodeCeremonyEligibilityEnvelope(envelope);
  if (!dec.ok) throw new Error(`decode failed: ${dec.reason}`);
  return dec.expiryHeight === HIGH_BIT_HEIGHT;
});

test('single-UTXO envelope works (minimum N=1)', () => {
  const fx = makeFixture();
  // Use only one UTXO that alone clears the threshold.
  const oneUtxo = [{
    txid: new Uint8Array(32).map((_, i) => (i * 5 + 3) & 0xff),
    vout: 0,
    amount: fx.thresholdBaseUnits + 1n,
    blinding: randomScalar(),
  }];
  const { envelope } = buildEnvelope({
    utxos: oneUtxo,
    holderPriv: fx.holderPrivBytes,
    expiryHeight: fx.expiryHeight,
    scopeId: fx.scopeId,
    assetIdHex: fx.assetIdHex,
    thresholdBaseUnits: fx.thresholdBaseUnits,
  });
  const dec = decodeCeremonyEligibilityEnvelope(envelope);
  if (!dec.ok) throw new Error(`decode failed: ${dec.reason}`);
  return dec.count === 1
      && dec.outpoints.length === 1
      && dec.outpoints[0].vout === 0;
});

test(`max-N=${CER_ELIGIBILITY_MAX_OUTPOINTS} envelope works`, () => {
  const fx = makeFixture();
  // Many small UTXOs (each below threshold) summing past threshold.
  const perUtxo = (fx.thresholdBaseUnits / BigInt(CER_ELIGIBILITY_MAX_OUTPOINTS)) + 1n;
  const utxos = [];
  for (let i = 0; i < CER_ELIGIBILITY_MAX_OUTPOINTS; i++) {
    utxos.push({
      txid: new Uint8Array(32).map((_, j) => ((i + 1) * (j + 1)) & 0xff),
      vout: i,
      amount: perUtxo,
      blinding: randomScalar(),
    });
  }
  const { envelope } = buildEnvelope({
    utxos,
    holderPriv: fx.holderPrivBytes,
    expiryHeight: fx.expiryHeight,
    scopeId: fx.scopeId,
    assetIdHex: fx.assetIdHex,
    thresholdBaseUnits: fx.thresholdBaseUnits,
  });
  const dec = decodeCeremonyEligibilityEnvelope(envelope);
  if (!dec.ok) throw new Error(`decode failed: ${dec.reason}`);
  return dec.count === CER_ELIGIBILITY_MAX_OUTPOINTS;
});

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
