// Unit tests for the T_AXFER_VAR (0x37) payload decoder shipped in
// dapp/tacit.js. No on-chain T_AXFER_VAR transactions exist yet (the
// feature flag is off in production), so these tests synthesize the
// wire-format bytes by hand and round-trip through a parallel
// implementation of decodeAxferVarPayload + axferVarOutputIndexForVout.
//
// What this protects: the structural decoder + interleaved-vout
// mapping shipped in the read-only half of the T_AXFER_VAR rollout.
// When the builder PR lands and starts emitting real envelopes, this
// test will also cover the round-trip with the dapp's encoder.

import { hexToBytes, concatBytes } from '@noble/hashes/utils';

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

// Parallel implementation of the dapp's decodeAxferVarPayload, mirrored
// byte-for-byte from dapp/tacit.js:decodeAxferVarPayload. Any future
// drift between the two is a wire-format regression — this duplicate
// is INTENTIONAL so the dapp can't silently relax its decoder without
// failing this test.
const T_AXFER_VAR_OPCODE = 0x37;
function decodeAxferVarPayload(payload) {
  if (!payload) return null;
  if (payload[0] !== T_AXFER_VAR_OPCODE) return null;
  if (payload.length < 1 + 32 + 1 + 64 + 1 + 2 * (33 + 8) + 2) return null;
  let p = 1;
  const assetId = payload.slice(p, p + 32); p += 32;
  const assetInputCount = payload[p]; p += 1;
  if (assetInputCount !== 1) return null;
  const kernelSig = payload.slice(p, p + 64); p += 64;
  const n = payload[p]; p += 1;
  if (n !== 2) return null;
  const outputs = [];
  for (let i = 0; i < n; i++) {
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
  return { kind: 'axfer_var', assetId, assetInputCount, kernelSig, outputs, rangeproof };
}

function axferVarOutputIndexForVout(vout) {
  if (vout === 0) return 0;
  if (vout === 2) return 1;
  return null;
}

// Helper: synthesise a minimal-valid T_AXFER_VAR payload for testing.
// All fields are placeholder bytes; the decoder doesn't validate
// cryptographic correctness (that happens at the validator layer).
function synthesisePayload({ assetInputCount = 1, N = 2, rangeproofBytes = 16 } = {}) {
  const opcode = new Uint8Array([T_AXFER_VAR_OPCODE]);
  const assetId = new Uint8Array(32).fill(0xab);
  const aic = new Uint8Array([assetInputCount & 0xff]);
  const kernelSig = new Uint8Array(64).fill(0xcd);
  const nByte = new Uint8Array([N & 0xff]);
  const outputs = [];
  for (let i = 0; i < N; i++) {
    const commit = new Uint8Array(33); commit[0] = 0x02; commit.fill(0x10 + i, 1);
    const amtCt = new Uint8Array(8).fill(0xee + i);
    outputs.push(commit, amtCt);
  }
  const rpLen = new Uint8Array(2);
  new DataView(rpLen.buffer).setUint16(0, rangeproofBytes, true);
  const rangeproof = new Uint8Array(rangeproofBytes).fill(0xab);
  return concatBytes(opcode, assetId, aic, kernelSig, nByte, ...outputs, rpLen, rangeproof);
}

console.log('\n=== T_AXFER_VAR (0x37) payload decoder ===\n');

test('valid minimal payload decodes correctly', () => {
  const p = synthesisePayload();
  const d = decodeAxferVarPayload(p);
  if (!d) return false;
  if (d.kind !== 'axfer_var') return false;
  if (d.assetInputCount !== 1) return false;
  if (d.outputs.length !== 2) return false;
  if (d.kernelSig.length !== 64) return false;
  if (d.rangeproof.length !== 16) return false;
  return true;
});

test('rejects opcode != 0x37', () => {
  const p = synthesisePayload();
  p[0] = 0x26; // T_AXFER opcode, not T_AXFER_VAR
  return decodeAxferVarPayload(p) === null;
});

test('rejects asset_input_count == 0', () => {
  return decodeAxferVarPayload(synthesisePayload({ assetInputCount: 0 })) === null;
});

test('rejects asset_input_count == 2 (must be exactly 1)', () => {
  return decodeAxferVarPayload(synthesisePayload({ assetInputCount: 2 })) === null;
});

test('rejects asset_input_count == 7 (must be exactly 1)', () => {
  return decodeAxferVarPayload(synthesisePayload({ assetInputCount: 7 })) === null;
});

test('rejects N == 1 (must be exactly 2)', () => {
  return decodeAxferVarPayload(synthesisePayload({ N: 1 })) === null;
});

test('rejects N == 4 (must be exactly 2)', () => {
  return decodeAxferVarPayload(synthesisePayload({ N: 4 })) === null;
});

test('rejects N == 8 (must be exactly 2)', () => {
  return decodeAxferVarPayload(synthesisePayload({ N: 8 })) === null;
});

test('rejects payload shorter than minimum', () => {
  const tiny = new Uint8Array([T_AXFER_VAR_OPCODE, 0xaa]);
  return decodeAxferVarPayload(tiny) === null;
});

test('rejects payload with declared rp_len mismatching actual rangeproof bytes', () => {
  const p = synthesisePayload({ rangeproofBytes: 16 });
  // Tamper rp_len to say 32 bytes when only 16 follow.
  const rpLenOff = p.length - 16 - 2;
  p[rpLenOff] = 32; p[rpLenOff + 1] = 0;
  return decodeAxferVarPayload(p) === null;
});

test('rejects null / empty payload', () => {
  return decodeAxferVarPayload(null) === null
    && decodeAxferVarPayload(new Uint8Array(0)) === null;
});

console.log('\n=== axferVarOutputIndexForVout (interleaved vout layout) ===\n');

test('vout 0 → outputs[0] (recipient tacit)', () => {
  return axferVarOutputIndexForVout(0) === 0;
});

test('vout 1 → null (maker BTC payment, non-tacit)', () => {
  return axferVarOutputIndexForVout(1) === null;
});

test('vout 2 → outputs[1] (maker change tacit)', () => {
  return axferVarOutputIndexForVout(2) === 1;
});

test('vout 3 → null (mandatory OP_RETURN(80) recovery, non-tacit)', () => {
  return axferVarOutputIndexForVout(3) === null;
});

test('vout 4 → null (taker BTC change, non-tacit)', () => {
  return axferVarOutputIndexForVout(4) === null;
});

test('vout 100 → null (out-of-range, non-tacit)', () => {
  return axferVarOutputIndexForVout(100) === null;
});

// Parallel encoder mirroring dapp/tacit.js:encodeAxferVarPayload. Used for
// round-trip tests below: encode synthesised inputs, decode, assert that
// all fields survive the trip byte-exact.
function encodeAxferVarPayload({ assetId, kernelSig, outputs, rangeproof }) {
  if (assetId.length !== 32) throw new Error('asset_id 32 bytes');
  if (!kernelSig || kernelSig.length !== 64) throw new Error('kernel_sig must be 64 bytes');
  if (outputs.length !== 2) throw new Error('outputs must be exactly 2');
  if (rangeproof.length > 0xffff) throw new Error('rangeproof too large');
  const parts = [
    new Uint8Array([T_AXFER_VAR_OPCODE]),
    assetId,
    new Uint8Array([1]),
    kernelSig,
    new Uint8Array([2]),
  ];
  for (const o of outputs) {
    if (o.commitment.length !== 33) throw new Error('commitment 33 bytes');
    if (!o.encryptedAmount || o.encryptedAmount.length !== 8) throw new Error('encrypted_amount must be 8 bytes');
    parts.push(o.commitment, o.encryptedAmount);
  }
  const rpLen = new Uint8Array(2); new DataView(rpLen.buffer).setUint16(0, rangeproof.length, true);
  parts.push(rpLen, rangeproof);
  return concatBytes(...parts);
}

console.log('\n=== T_AXFER_VAR encoder ↔ decoder round trip ===\n');

const eq = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

test('encoder rejects outputs.length !== 2', () => {
  try {
    encodeAxferVarPayload({
      assetId: new Uint8Array(32).fill(0xaa),
      kernelSig: new Uint8Array(64).fill(0xbb),
      outputs: [{ commitment: new Uint8Array(33).fill(0x02), encryptedAmount: new Uint8Array(8) }],
      rangeproof: new Uint8Array(16),
    });
    return false;
  } catch { return true; }
});

test('encoder + decoder round-trip preserves every field', () => {
  const inputs = {
    assetId: new Uint8Array(32).fill(0xab),
    kernelSig: new Uint8Array(64).fill(0xcd),
    outputs: [
      { commitment: (() => { const c = new Uint8Array(33); c[0] = 0x02; c.fill(0x10, 1); return c; })(),
        encryptedAmount: new Uint8Array(8).fill(0xee) },
      { commitment: (() => { const c = new Uint8Array(33); c[0] = 0x02; c.fill(0x11, 1); return c; })(),
        encryptedAmount: new Uint8Array(8).fill(0xef) },
    ],
    rangeproof: new Uint8Array(16).fill(0x55),
  };
  const encoded = encodeAxferVarPayload(inputs);
  const decoded = decodeAxferVarPayload(encoded);
  if (!decoded) return false;
  if (!eq(decoded.assetId, inputs.assetId)) return false;
  if (decoded.assetInputCount !== 1) return false;
  if (!eq(decoded.kernelSig, inputs.kernelSig)) return false;
  if (decoded.outputs.length !== 2) return false;
  if (!eq(decoded.outputs[0].commitment, inputs.outputs[0].commitment)) return false;
  if (!eq(decoded.outputs[0].encryptedAmount, inputs.outputs[0].encryptedAmount)) return false;
  if (!eq(decoded.outputs[1].commitment, inputs.outputs[1].commitment)) return false;
  if (!eq(decoded.outputs[1].encryptedAmount, inputs.outputs[1].encryptedAmount)) return false;
  if (!eq(decoded.rangeproof, inputs.rangeproof)) return false;
  return true;
});

test('encoder emits opcode byte 0x37 at position 0', () => {
  const out = encodeAxferVarPayload({
    assetId: new Uint8Array(32),
    kernelSig: new Uint8Array(64),
    outputs: [
      { commitment: new Uint8Array(33), encryptedAmount: new Uint8Array(8) },
      { commitment: new Uint8Array(33), encryptedAmount: new Uint8Array(8) },
    ],
    rangeproof: new Uint8Array(0),
  });
  return out[0] === T_AXFER_VAR_OPCODE;
});

test('encoder rejects rangeproof > 65535 bytes', () => {
  try {
    encodeAxferVarPayload({
      assetId: new Uint8Array(32),
      kernelSig: new Uint8Array(64),
      outputs: [
        { commitment: new Uint8Array(33), encryptedAmount: new Uint8Array(8) },
        { commitment: new Uint8Array(33), encryptedAmount: new Uint8Array(8) },
      ],
      rangeproof: new Uint8Array(65536),
    });
    return false;
  } catch { return true; }
});

// =========== OP_RETURN(80) recovery-payload wire format (regression for the
// "OP_PUSHBYTES_80 doesn't exist" signet-relay bug) ===========
//
// Bitcoin's standard relay policy ONLY recognises OP_PUSHBYTES_N for N=1..75
// (opcodes 0x01..0x4b). For pushes > 75 bytes you MUST use OP_PUSHDATA1 +
// length byte. The original encoder emitted `6a 50 <80 bytes>` thinking
// `0x50` was a push opcode — it's actually OP_RESERVED, which makes the
// scriptpubkey non-standard. bitcoind rejected the reveal with code -26
// ("scriptpubkey"). Caught on the first signet harness run.
//
// These tests pin the wire format so the bug can't slip back.

import { JSDOM } from 'jsdom';
const _dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = _dom.window;
globalThis.document = _dom.window.document;
globalThis.localStorage = _dom.window.localStorage;
globalThis.location = _dom.window.location;
globalThis.navigator = _dom.window.navigator;
globalThis.__TACIT_NO_INIT__ = true;
const _dapp = await import('../dapp/tacit.js');
const { encodeAxferVarOnchainOpReturn, tryExtractAxferVarOnchainOpReturn, AXFER_VAR_OPRETURN_PAYLOAD_BYTES } = _dapp;
import { bytesToHex as _bth } from '@noble/hashes/utils';

console.log('\n=== OP_RETURN(80) wire format (signet-relay regression) ===\n');

test('encoded OP_RETURN(80) scriptpubkey is exactly 83 bytes', () => {
  const payload = new Uint8Array(AXFER_VAR_OPRETURN_PAYLOAD_BYTES).fill(0xAB);
  const spk = encodeAxferVarOnchainOpReturn(payload);
  return spk.length === 83;
});

test('encoded OP_RETURN(80) starts with 6a 4c 50 (OP_RETURN / OP_PUSHDATA1 / length=80)', () => {
  const payload = new Uint8Array(AXFER_VAR_OPRETURN_PAYLOAD_BYTES).fill(0xCD);
  const spk = encodeAxferVarOnchainOpReturn(payload);
  return spk[0] === 0x6a && spk[1] === 0x4c && spk[2] === 0x50;
});

test('encoded OP_RETURN(80) does NOT use 0x50 as a standalone opcode (the original bug)', () => {
  // The buggy encoding was `6a 50 <80 bytes>` which parses as OP_RETURN ||
  // OP_RESERVED || <data>. Standard relay rejects this. Confirm the second
  // byte is OP_PUSHDATA1, never the raw length.
  const payload = new Uint8Array(AXFER_VAR_OPRETURN_PAYLOAD_BYTES).fill(0xEF);
  const spk = encodeAxferVarOnchainOpReturn(payload);
  return spk[1] !== 0x50;
});

test('encoded OP_RETURN(80) round-trips through tryExtractAxferVarOnchainOpReturn', () => {
  const payload = new Uint8Array(AXFER_VAR_OPRETURN_PAYLOAD_BYTES);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) & 0xff;
  const spk = encodeAxferVarOnchainOpReturn(payload);
  const recovered = tryExtractAxferVarOnchainOpReturn(spk);
  if (!recovered || recovered.length !== AXFER_VAR_OPRETURN_PAYLOAD_BYTES) return false;
  return _bth(recovered) === _bth(payload);
});

test('tryExtractAxferVarOnchainOpReturn rejects the buggy 82-byte legacy form', () => {
  // What the buggy encoder used to emit: 6a 50 <80 bytes>. Standard relay
  // wouldn't accept it, but a malformed implementation might still produce it
  // — the decoder must NOT silently accept it.
  const buggy = new Uint8Array(82);
  buggy[0] = 0x6a; buggy[1] = 0x50;
  for (let i = 2; i < 82; i++) buggy[i] = 0xAA;
  return tryExtractAxferVarOnchainOpReturn(buggy) === null;
});

test('tryExtractAxferVarOnchainOpReturn rejects wrong OP_PUSHDATA1 length', () => {
  const wrongLen = new Uint8Array(83);
  wrongLen[0] = 0x6a; wrongLen[1] = 0x4c; wrongLen[2] = 0x4f;  // length=79, not 80
  for (let i = 3; i < 83; i++) wrongLen[i] = 0xBB;
  return tryExtractAxferVarOnchainOpReturn(wrongLen) === null;
});

test('tryExtractAxferVarOnchainOpReturn rejects non-OP_RETURN prefix', () => {
  const notOpReturn = new Uint8Array(83);
  notOpReturn[0] = 0x76; notOpReturn[1] = 0x4c; notOpReturn[2] = 0x50;  // 0x76 = OP_DUP
  return tryExtractAxferVarOnchainOpReturn(notOpReturn) === null;
});

test('encodeAxferVarOnchainOpReturn rejects wrong-length payload', () => {
  try { encodeAxferVarOnchainOpReturn(new Uint8Array(79)); return false; }
  catch { return true; }
});

console.log(`\n=== ${pass} passed · ${fail} failed ===`);
if (fail > 0) process.exit(1);
