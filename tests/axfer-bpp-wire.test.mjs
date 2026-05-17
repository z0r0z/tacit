// Wire-format tests for T_AXFER_BPP (0x3C) and T_AXFER_VAR_BPP (0x3D)
// per SPEC-AXFER-BPP-AMENDMENT.
//
// These opcodes are byte-for-byte parallels of T_AXFER (0x26) and
// T_AXFER_VAR (0x37) respectively, with two changes:
//   - the leading opcode byte
//   - the rangeproof field carries a Bulletproofs+ proof rather than a
//     standard Bulletproofs proof
//
// Every other field — asset_id, asset_input_count, kernel_sig, outputs,
// amount_ct — is encoded identically. This test pins that invariant and
// confirms the encoder/decoder roundtrip is lossless across both opcodes.

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => true;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import { bytesToHex } from '@noble/hashes/utils';

const dapp = await import('../dapp/tacit.js');
const { bppRangeProve } = await import('../dapp/bulletproofs-plus.js');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(name) { console.log(`\n${name}:`); }

function dummyAssetId() { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = (i * 13 + 7) & 0xff; return b; }
function dummyKernelSig() { const b = new Uint8Array(64); for (let i = 0; i < 64; i++) b[i] = (i * 17 + 3) & 0xff; return b; }
function dummyCommit(seed) { const b = new Uint8Array(33); b[0] = 0x02; for (let i = 1; i < 33; i++) b[i] = (i * seed + 11) & 0xff; return b; }
function dummyAmountCt(seed) { const b = new Uint8Array(8); for (let i = 0; i < 8; i++) b[i] = (i * seed + 5) & 0xff; return b; }

// Real BP+ proofs for the bulletproof field. Verifies the test exercises a
// well-formed proof, not just random bytes — useful for the validator-side
// integration that follows.
function makeBppProof(m) {
  const values = Array.from({ length: m }, (_, i) => BigInt(100 + i));
  const blindings = Array.from({ length: m }, (_, i) => BigInt(i + 1));
  return bppRangeProve(values, blindings).proof;
}

group('T_AXFER_BPP encode → decode roundtrip');
for (const N of [1, 2, 4, 8]) {
  const assetId = dummyAssetId();
  const kernelSig = dummyKernelSig();
  const outputs = Array.from({ length: N }, (_, i) => ({
    commitment: dummyCommit(i + 1),
    encryptedAmount: dummyAmountCt(i + 1),
  }));
  const rangeproof = makeBppProof(N);
  const payload = dapp.encodeAxferBppPayload({ assetId, assetInputCount: N, kernelSig, outputs, rangeproof });
  ok(`N=${N}: encode returns Uint8Array`, payload instanceof Uint8Array);
  ok(`N=${N}: opcode byte = 0x3C`, payload[0] === 0x3C);
  const dec = dapp.decodeAxferBppPayload(payload);
  ok(`N=${N}: decode returns non-null`, dec !== null);
  if (!dec) continue;
  ok(`N=${N}: kind = "axfer_bpp"`, dec.kind === 'axfer_bpp');
  ok(`N=${N}: asset_id roundtrips`, bytesToHex(dec.assetId) === bytesToHex(assetId));
  ok(`N=${N}: asset_input_count roundtrips`, dec.assetInputCount === N);
  ok(`N=${N}: kernel_sig roundtrips`, bytesToHex(dec.kernelSig) === bytesToHex(kernelSig));
  ok(`N=${N}: outputs.length matches`, dec.outputs.length === N);
  for (let i = 0; i < N; i++) {
    ok(`N=${N}: outputs[${i}].commitment roundtrips`,
       bytesToHex(dec.outputs[i].commitment) === bytesToHex(outputs[i].commitment));
    ok(`N=${N}: outputs[${i}].encryptedAmount roundtrips`,
       bytesToHex(dec.outputs[i].encryptedAmount) === bytesToHex(outputs[i].encryptedAmount));
  }
  ok(`N=${N}: rangeproof roundtrips`, bytesToHex(dec.rangeproof) === bytesToHex(rangeproof));
}

group('T_AXFER_VAR_BPP encode → decode roundtrip');
{
  const assetId = dummyAssetId();
  const kernelSig = dummyKernelSig();
  const outputs = [
    { commitment: dummyCommit(7), encryptedAmount: dummyAmountCt(7) },   // recipient
    { commitment: dummyCommit(11), encryptedAmount: dummyAmountCt(11) }, // maker change
  ];
  const rangeproof = makeBppProof(2);
  const payload = dapp.encodeAxferVarBppPayload({ assetId, kernelSig, outputs, rangeproof });
  ok('encode returns Uint8Array', payload instanceof Uint8Array);
  ok('opcode byte = 0x3D', payload[0] === 0x3D);
  const dec = dapp.decodeAxferVarBppPayload(payload);
  ok('decode returns non-null', dec !== null);
  if (dec) {
    ok('kind = "axfer_var_bpp"', dec.kind === 'axfer_var_bpp');
    ok('asset_id roundtrips', bytesToHex(dec.assetId) === bytesToHex(assetId));
    ok('asset_input_count = 1', dec.assetInputCount === 1);
    ok('outputs.length = 2', dec.outputs.length === 2);
    ok('outputs[0].commitment roundtrips',
       bytesToHex(dec.outputs[0].commitment) === bytesToHex(outputs[0].commitment));
    ok('outputs[1].commitment roundtrips',
       bytesToHex(dec.outputs[1].commitment) === bytesToHex(outputs[1].commitment));
    ok('rangeproof roundtrips', bytesToHex(dec.rangeproof) === bytesToHex(rangeproof));
  }
}

group('Rejections — malformed payloads');
{
  // Wrong opcode byte (T_AXFER instead of T_AXFER_BPP)
  const validBpp = dapp.encodeAxferBppPayload({
    assetId: dummyAssetId(),
    assetInputCount: 1,
    kernelSig: dummyKernelSig(),
    outputs: [{ commitment: dummyCommit(1), encryptedAmount: dummyAmountCt(1) }],
    rangeproof: makeBppProof(1),
  });
  const wrongOpcode = new Uint8Array(validBpp);
  wrongOpcode[0] = 0x26;  // T_AXFER
  ok('decodeAxferBppPayload rejects wrong opcode byte',
     dapp.decodeAxferBppPayload(wrongOpcode) === null);
  ok('decodeAxferVarBppPayload rejects wrong opcode byte',
     dapp.decodeAxferVarBppPayload(wrongOpcode) === null);

  // Truncated payload
  const truncated = validBpp.slice(0, validBpp.length - 1);
  ok('decode rejects truncated payload',
     dapp.decodeAxferBppPayload(truncated) === null);

  // Asset_input_count = 0 (invalid; T_AXFER_BPP requires ≥ 1)
  const zeroAic = new Uint8Array(validBpp);
  zeroAic[1 + 32] = 0x00;  // assetInputCount byte position
  ok('decode rejects asset_input_count = 0',
     dapp.decodeAxferBppPayload(zeroAic) === null);

  // T_AXFER_VAR_BPP with N=4 (must be exactly 2)
  // Build a T_AXFER_BPP with N=4 then flip the opcode to T_AXFER_VAR_BPP
  const fourOutN = dapp.encodeAxferBppPayload({
    assetId: dummyAssetId(),
    assetInputCount: 1,
    kernelSig: dummyKernelSig(),
    outputs: Array.from({ length: 4 }, (_, i) => ({
      commitment: dummyCommit(i + 1),
      encryptedAmount: dummyAmountCt(i + 1),
    })),
    rangeproof: makeBppProof(4),
  });
  const wrongNVar = new Uint8Array(fourOutN);
  wrongNVar[0] = 0x3D;  // T_AXFER_VAR_BPP
  ok('decodeAxferVarBppPayload rejects N≠2',
     dapp.decodeAxferVarBppPayload(wrongNVar) === null);
}

group('Cross-codec: T_AXFER decoder must reject BPP-opcode payloads');
{
  const validBpp = dapp.encodeAxferBppPayload({
    assetId: dummyAssetId(),
    assetInputCount: 1,
    kernelSig: dummyKernelSig(),
    outputs: [{ commitment: dummyCommit(1), encryptedAmount: dummyAmountCt(1) }],
    rangeproof: makeBppProof(1),
  });
  ok('decodeAxferPayload rejects T_AXFER_BPP opcode (0x3C)',
     dapp.decodeAxferPayload(validBpp) === null);
  ok('decodeAxferVarPayload rejects T_AXFER_BPP opcode (0x3C)',
     dapp.decodeAxferVarPayload(validBpp) === null);
}

group('Byte-level structural invariants');
{
  // T_AXFER_BPP and T_AXFER must produce byte-identical payloads modulo the
  // leading opcode byte and the rangeproof bytes, for matching field inputs.
  // The kernel sig, asset_id, asset_input_count, N, commitments, and
  // amount_ct portions sit at the same byte offsets in both wire formats.
  const assetId = dummyAssetId();
  const kernelSig = dummyKernelSig();
  const outputs = [{ commitment: dummyCommit(1), encryptedAmount: dummyAmountCt(1) }];
  // Use a fixed-size placeholder rangeproof for both so the comparison isolates
  // header structure rather than proof bytes.
  const placeholderRp = new Uint8Array(500);
  const axferPayload = dapp.encodeAxferPayload({
    assetId, assetInputCount: 1, kernelSig, outputs, rangeproof: placeholderRp,
  });
  const bppPayload = dapp.encodeAxferBppPayload({
    assetId, assetInputCount: 1, kernelSig, outputs, rangeproof: placeholderRp,
  });
  ok('payloads same length', axferPayload.length === bppPayload.length);
  // Bytes 0: opcode differs. Bytes 1..end-of-non-rangeproof: must match.
  // Both decoders include a 2-byte rp_len at the same offset; the
  // rangeproof bytes that follow are equal because we used a placeholder.
  let differOpcodeOnly = (axferPayload[0] !== bppPayload[0]);
  for (let i = 1; i < axferPayload.length; i++) {
    if (axferPayload[i] !== bppPayload[i]) { differOpcodeOnly = false; break; }
  }
  ok('T_AXFER vs T_AXFER_BPP differ in opcode byte only (when rangeproof bytes match)',
     differOpcodeOnly);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
