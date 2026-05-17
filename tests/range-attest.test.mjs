// Tests for T_RANGE_ATTEST opcode wire format + validator.

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

import {
  encodeRangeAttest, decodeRangeAttest, verifyRangeAttestSig,
  validateRangeAttest, OPCODE_T_RANGE_ATTEST,
} from './range-attest.mjs';
import {
  proveRange, verifyRange,
  PRED_GE, PRED_LE, PRED_IN_RANGE, PRED_GT_HIDDEN, PRED_EQ,
} from './range-proof.mjs';
import {
  pedersenCommit, pointToBytes, randomScalar, modN,
} from './bulletproofs.mjs';

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

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// =========================================================================
// Test setup: holder, commitments, attestation bytes
// =========================================================================
const holderSk = new Uint8Array(32); for (let i = 0; i < 32; i++) holderSk[i] = i + 1;
const holderPk = secp.ProjectivePoint.fromPrivateKey(holderSk).toRawBytes(true);

const SCOPE_ID = new Uint8Array(32).fill(0x42);
const ASSET_ID = new Uint8Array(32).fill(0xaa);
const OTHER_ASSET_ID = new Uint8Array(32).fill(0xbb);

// A single UTXO with hidden amount 5000.
const valueA = 5000n;
const blindingA = randomScalar();
const commitmentA = pointToBytes(pedersenCommit(valueA, blindingA));
const outpointA = { txid: 'aa'.repeat(32), vout: 0 };

const attestationGE = proveRange(
  { value: valueA, blinding: blindingA },
  { type: 'ge', X: 1000n },
);

// =========================================================================
// Wire-format round-trip
// =========================================================================
console.log('Encode/decode round-trip');
{
  test('encode → decode preserves all fields', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID,
      expiryHeight: 900_000,
      commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE,
      holderPrivkey: holderSk,
    });
    const dec = decodeRangeAttest(enc);
    return bytesEqual(dec.scopeId, SCOPE_ID)
      && dec.expiryHeight === 900_000
      && dec.commitmentOutpoints.length === 1
      && dec.commitmentOutpoints[0].txid === outpointA.txid
      && dec.commitmentOutpoints[0].vout === outpointA.vout
      && bytesEqual(dec.attestationBytes, attestationGE)
      && bytesEqual(dec.holderPubkey, holderPk)
      && dec.holderSig.length === 64;
  });

  test('opcode byte is 0x3A', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 1, commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE, holderPrivkey: holderSk,
    });
    return enc[0] === OPCODE_T_RANGE_ATTEST && OPCODE_T_RANGE_ATTEST === 0x3A;
  });

  test('encode rejects empty commitment list', () => {
    try {
      encodeRangeAttest({
        scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 1, commitmentOutpoints: [],
        attestationBytes: attestationGE, holderPrivkey: holderSk,
      });
      return false;
    } catch (e) { return /1\.\.16/.test(e.message); }
  });

  test('encode rejects > 16 commitments', () => {
    try {
      encodeRangeAttest({
        scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 1,
        commitmentOutpoints: new Array(17).fill(outpointA),
        attestationBytes: attestationGE, holderPrivkey: holderSk,
      });
      return false;
    } catch (e) { return /1\.\.16/.test(e.message); }
  });

  test('decode rejects wrong opcode', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 1, commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE, holderPrivkey: holderSk,
    });
    const corrupted = new Uint8Array(enc); corrupted[0] = 0x99;
    try {
      decodeRangeAttest(corrupted);
      return false;
    } catch (e) { return /expected opcode/.test(e.message); }
  });

  test('decode rejects trailing bytes', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 1, commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE, holderPrivkey: holderSk,
    });
    const extra = concatBytes(enc, new Uint8Array([0xff]));
    try {
      decodeRangeAttest(extra);
      return false;
    } catch (e) { return /trailing|attestation_len/.test(e.message); }
  });
}

// =========================================================================
// Signature verification
// =========================================================================
console.log('\nholder_sig verification');
{
  test('honest envelope ⇒ sig verifies', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE,
      holderPrivkey: holderSk,
    });
    const dec = decodeRangeAttest(enc);
    return verifyRangeAttestSig(dec) === true;
  });

  test('tampered scope_id ⇒ sig fails', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE,
      holderPrivkey: holderSk,
    });
    const dec = decodeRangeAttest(enc);
    dec.scopeId = new Uint8Array(32).fill(0x99);
    return verifyRangeAttestSig(dec) === false;
  });

  test('tampered expiry_height ⇒ sig fails', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE,
      holderPrivkey: holderSk,
    });
    const dec = decodeRangeAttest(enc);
    dec.expiryHeight = 1;
    return verifyRangeAttestSig(dec) === false;
  });

  test('different signer (wrong privkey) ⇒ sig fails', () => {
    const otherSk = new Uint8Array(32); for (let i = 0; i < 32; i++) otherSk[i] = (i * 7 + 13) & 0xff;
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE,
      holderPubkey: holderPk,                       // claims `holderPk`
      holderPrivkey: otherSk,                       // but signs with otherSk
    });
    const dec = decodeRangeAttest(enc);
    return verifyRangeAttestSig(dec) === false;
  });
}

// =========================================================================
// Validator — full envelope check
// =========================================================================
console.log('\nValidator (full envelope check)');
{
  // Test commitmentResolver — returns the on-chain commitment for an outpoint.
  function makeResolver(map) {
    return (op) => {
      const key = `${op.txid}:${op.vout}`;
      return map.get(key) || null;
    };
  }

  const resolver = makeResolver(new Map([
    [`${outpointA.txid}:${outpointA.vout}`, { commitment: commitmentA, assetId: ASSET_ID }],
  ]));

  test('valid attestation with resolved commitment ⇒ accepted', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE,
      holderPrivkey: holderSk,
    });
    const result = validateRangeAttest({
      payload: enc, envelopeHeight: 800_000, commitmentResolver: resolver,
    });
    if (!result.valid) console.log(`     reason: ${result.reason}`);
    return result.valid === true
      && result.predicate.type === 'ge'
      && result.predicate.X === 1000n
      && result.attestationId.length === 32;
  });

  test('expired attestation ⇒ rejected', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 500_000,
      commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE,
      holderPrivkey: holderSk,
    });
    const result = validateRangeAttest({
      payload: enc, envelopeHeight: 800_000, commitmentResolver: resolver,
    });
    return !result.valid && /expired/.test(result.reason);
  });

  test('unresolvable outpoint ⇒ rejected', () => {
    const wrongOp = { txid: 'cc'.repeat(32), vout: 7 };
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: [wrongOp],
      attestationBytes: attestationGE,
      holderPrivkey: holderSk,
    });
    const result = validateRangeAttest({
      payload: enc, envelopeHeight: 800_000, commitmentResolver: resolver,
    });
    return !result.valid && /not a confirmed UTXO/.test(result.reason);
  });

  test('attestation against WRONG commitment (substitute outpoint at indexer) ⇒ rejected', () => {
    // Attestation was constructed for valueA=5000. We try to point the
    // outpoint at a different commitment (4-of-some-other-value).
    const otherValue = 999n;
    const otherBlinding = randomScalar();
    const otherCommitment = pointToBytes(pedersenCommit(otherValue, otherBlinding));
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE,
      holderPrivkey: holderSk,
    });
    const wrongResolver = makeResolver(new Map([
      [`${outpointA.txid}:${outpointA.vout}`, { commitment: otherCommitment, assetId: ASSET_ID }],
    ]));
    const result = validateRangeAttest({
      payload: enc, envelopeHeight: 800_000, commitmentResolver: wrongResolver,
    });
    return !result.valid && /verify failed/.test(result.reason);
  });

  test('forged holder_sig ⇒ rejected', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE,
      holderPrivkey: holderSk,
    });
    // Flip a bit in the signature.
    const bad = new Uint8Array(enc); bad[enc.length - 5] ^= 0x01;
    const result = validateRangeAttest({
      payload: bad, envelopeHeight: 800_000, commitmentResolver: resolver,
    });
    return !result.valid && /holder_sig/.test(result.reason);
  });

  test('missing commitmentResolver ⇒ rejected', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE,
      holderPrivkey: holderSk,
    });
    const result = validateRangeAttest({ payload: enc, envelopeHeight: 800_000 });
    return !result.valid && /commitmentResolver/.test(result.reason);
  });
}

// =========================================================================
// Multi-UTXO aggregate (Σ a_i ≥ X)
// =========================================================================
console.log('\nMulti-UTXO aggregate attestation');
{
  const utxos = [
    { value: 1000n, blinding: randomScalar(), txid: 'b1'.repeat(32), vout: 0 },
    { value: 2000n, blinding: randomScalar(), txid: 'b2'.repeat(32), vout: 1 },
    { value: 3000n, blinding: randomScalar(), txid: 'b3'.repeat(32), vout: 2 },
  ];
  const commitments = utxos.map(u => pointToBytes(pedersenCommit(u.value, u.blinding)));

  // Aggregate value + blinding for the sum. Blindings sum modulo n_secp
  // because Pedersen blindings are scalars in Z_{n_secp} — the point-wise
  // sum Σ C_i opens to (Σ a_i, Σ r_i mod n_secp), so the proof's blinding
  // must match this exactly.
  const sumValue = utxos.reduce((s, u) => s + u.value, 0n);
  let sumBlinding = 0n;
  for (const u of utxos) sumBlinding = modN(sumBlinding + u.blinding);

  const attestation = proveRange(
    { value: sumValue, blinding: sumBlinding },
    { type: 'ge', X: 5000n },
  );

  const resolver = (op) => {
    const idx = utxos.findIndex(u => u.txid === op.txid && u.vout === op.vout);
    if (idx === -1) return null;
    return { commitment: commitments[idx], assetId: ASSET_ID };
  };

  test('3-UTXO aggregate (sum=6000) ≥ 5000 ⇒ accepted', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: utxos.map(u => ({ txid: u.txid, vout: u.vout })),
      attestationBytes: attestation,
      holderPrivkey: holderSk,
    });
    const result = validateRangeAttest({
      payload: enc, envelopeHeight: 800_000, commitmentResolver: resolver,
    });
    if (!result.valid) console.log(`     reason: ${result.reason}`);
    return result.valid === true && result.predicate.X === 5000n;
  });

  test('aggregate with one missing outpoint ⇒ rejected', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: utxos.map(u => ({ txid: u.txid, vout: u.vout })),
      attestationBytes: attestation,
      holderPrivkey: holderSk,
    });
    const partialResolver = (op) => {
      if (op.txid === utxos[1].txid && op.vout === utxos[1].vout) return null;  // hide one
      return resolver(op);
    };
    const result = validateRangeAttest({
      payload: enc, envelopeHeight: 800_000, commitmentResolver: partialResolver,
    });
    return !result.valid && /not a confirmed UTXO/.test(result.reason);
  });
}

// =========================================================================
// PRED_IN_RANGE through the opcode
// =========================================================================
console.log('\nPRED_IN_RANGE via T_RANGE_ATTEST opcode');
{
  const attestationInRange = proveRange(
    { value: valueA, blinding: blindingA },
    { type: 'in_range', X: 1000n, Y: 10000n },
  );
  const resolver = (op) => {
    if (op.txid === outpointA.txid && op.vout === outpointA.vout) return { commitment: commitmentA, assetId: ASSET_ID };
    return null;
  };

  test('5000 ∈ [1000, 10000] via opcode ⇒ accepted', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: [outpointA],
      attestationBytes: attestationInRange,
      holderPrivkey: holderSk,
    });
    const result = validateRangeAttest({
      payload: enc, envelopeHeight: 800_000, commitmentResolver: resolver,
    });
    return result.valid === true
      && result.predicate.type === 'in_range'
      && result.predicate.X === 1000n
      && result.predicate.Y === 10000n;
  });
}

// =========================================================================
// Asset-id binding (audit H2 fix)
// =========================================================================
console.log('\nAsset-id binding (cross-asset replay defense)');
{
  const resolverDifferentAsset = (op) => {
    if (op.txid === outpointA.txid && op.vout === outpointA.vout) {
      // Resolver reports the UTXO is of a DIFFERENT asset than the holder
      // signed. This is the cross-asset replay scenario.
      return { commitment: commitmentA, assetId: OTHER_ASSET_ID };
    }
    return null;
  };
  const resolverMatching = (op) => {
    if (op.txid === outpointA.txid && op.vout === outpointA.vout) {
      return { commitment: commitmentA, assetId: ASSET_ID };
    }
    return null;
  };

  test('asset_id match (resolver returns signed asset_id) ⇒ accepted', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE,
      holderPrivkey: holderSk,
    });
    const result = validateRangeAttest({
      payload: enc, envelopeHeight: 800_000, commitmentResolver: resolverMatching,
    });
    return result.valid === true;
  });

  test('asset_id mismatch (resolver returns different asset) ⇒ rejected', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE,
      holderPrivkey: holderSk,
    });
    const result = validateRangeAttest({
      payload: enc, envelopeHeight: 800_000, commitmentResolver: resolverDifferentAsset,
    });
    return !result.valid && /asset_id mismatch/.test(result.reason);
  });

  test('resolver omits assetId ⇒ rejected gracefully', () => {
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: [outpointA],
      attestationBytes: attestationGE,
      holderPrivkey: holderSk,
    });
    const resolverNoAsset = (op) => {
      if (op.txid === outpointA.txid && op.vout === outpointA.vout) return { commitment: commitmentA };
      return null;
    };
    const result = validateRangeAttest({
      payload: enc, envelopeHeight: 800_000, commitmentResolver: resolverNoAsset,
    });
    return !result.valid && /32-byte assetId/.test(result.reason);
  });

  test('multi-commitment mixed-asset aggregate ⇒ rejected (same-asset rule)', () => {
    const utxoX = { value: 1000n, blinding: randomScalar(), txid: 'a1'.repeat(32), vout: 0 };
    const utxoY = { value: 2000n, blinding: randomScalar(), txid: 'a2'.repeat(32), vout: 1 };
    const cX = pointToBytes(pedersenCommit(utxoX.value, utxoX.blinding));
    const cY = pointToBytes(pedersenCommit(utxoY.value, utxoY.blinding));
    const sumValue = utxoX.value + utxoY.value;
    const sumBlinding = modN(utxoX.blinding + utxoY.blinding);
    const att = proveRange({ value: sumValue, blinding: sumBlinding }, { type: 'ge', X: 2500n });
    const enc = encodeRangeAttest({
      scopeId: SCOPE_ID, assetId: ASSET_ID, expiryHeight: 900_000,
      commitmentOutpoints: [{ txid: utxoX.txid, vout: utxoX.vout }, { txid: utxoY.txid, vout: utxoY.vout }],
      attestationBytes: att,
      holderPrivkey: holderSk,
    });
    // resolver: one UTXO is of ASSET_ID, the other is of OTHER_ASSET_ID
    const mixedResolver = (op) => {
      if (op.txid === utxoX.txid && op.vout === utxoX.vout) return { commitment: cX, assetId: ASSET_ID };
      if (op.txid === utxoY.txid && op.vout === utxoY.vout) return { commitment: cY, assetId: OTHER_ASSET_ID };
      return null;
    };
    const result = validateRangeAttest({
      payload: enc, envelopeHeight: 800_000, commitmentResolver: mixedResolver,
    });
    return !result.valid && /asset_id mismatch/.test(result.reason);
  });
}

console.log(`\n${pass}/${pass + fail} T_RANGE_ATTEST tests passed`);
if (fail > 0) process.exit(1);
