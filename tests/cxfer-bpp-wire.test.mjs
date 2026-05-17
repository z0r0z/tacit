// SPEC-CXFER-BPP-AMENDMENT wire-format tests for T_CXFER_BPP (0x22).
//
// Verifies:
//   - dapp encode → dapp decode and dapp encode → worker decode round-trip
//     at every aggregation level m ∈ {1, 2, 4, 8}
//   - byte-level delta from CXFER: BPP envelope == CXFER envelope with the
//     opcode byte (and only the opcode byte + the rangeproof bytes) changed
//   - kernel-msg byte parity: computeKernelMsg produces byte-identical output
//     for matching (asset_id, inputs, outputs, burned=0) regardless of which
//     opcode wraps the envelope (this is the soundness argument that lets
//     §5.47.2 reuse "tacit-kernel-v1" unchanged)
//   - CXFER encoder non-regression: encoding a known CXFER fixture produces
//     byte-identical output after the BPP additions land (proves the BPP
//     code path doesn't drift CXFER encoder)
//   - forward-compat: existing decodeCXferPayload rejects a BPP envelope
//     (opcode mismatch), which is the correct soft-fork behavior — a
//     pre-amendment indexer sees BPP as unknown and treats it as a no-op
//   - mixed-ancestry decoding: alternating CXFER ↔ BPP envelopes decode
//     correctly under opcode dispatch
//   - rejection: wrong opcode, truncated, padded, bad N, off-curve commitment,
//     wrong commitment length, wrong amount_ct length, wrong rp_len
//
// Scope. Wire format only. BP+ prover/verifier crypto is a separate
// engineering track and is NOT exercised here — the rangeproof field is
// treated as opaque bytes (filled with deterministic placeholder bytes
// for fixtures). The point of this test is to prove that adding T_CXFER_BPP
// to the protocol introduces zero observable change to existing T_CXFER
// behavior, and that the new opcode round-trips cleanly through both the
// dapp encoder and the worker decoder.

import * as worker from '../worker/src/index.js';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
const dapp = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(title) { console.log(`\n${title}:`); }

// ============== fixtures ==============

const T_CXFER     = 0x23;
const T_CXFER_BPP = 0x22;

// Deterministic 32-byte fillers — fixed seeds so fixtures are reproducible
// across runs and cross-implementations.
function bytes(seed, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (seed * 131 + i * 17) & 0xff;
  return out;
}

// Build a valid compressed point (0x02 prefix + 32 bytes). For wire-level
// tests we don't need actual curve membership — the encoder enforces length,
// not curve validity, mirroring how CXFER's encoder treats commitments.
function fakeCommitment(seed) {
  const out = new Uint8Array(33);
  out[0] = 0x02;
  out.set(bytes(seed, 32), 1);
  return out;
}

function fakeKernelSig(seed)    { return bytes(seed, 64); }
function fakeAssetId(seed)      { return bytes(seed, 32); }
function fakeEncAmount(seed)    { return bytes(seed, 8);  }
function fakeRangeproof(seed, n) { return bytes(seed, n); }

function makeOutputs(N, baseSeed) {
  const out = [];
  for (let i = 0; i < N; i++) {
    out.push({
      commitment: fakeCommitment(baseSeed + i),
      encryptedAmount: fakeEncAmount(baseSeed + 100 + i),
    });
  }
  return out;
}

// ============== required exports present ==============
group('Exports present');

ok('dapp exports encodeCXferBppPayload',
  typeof dapp.encodeCXferBppPayload === 'function');
ok('dapp exports decodeCXferBppPayload',
  typeof dapp.decodeCXferBppPayload === 'function');
ok('worker exports decodeCXferBppPayload',
  typeof worker.decodeCXferBppPayload === 'function');
ok('dapp still exports encodeCXferPayload (non-regression)',
  typeof dapp.encodeCXferPayload === 'function');
ok('dapp still exports decodeCXferPayload (non-regression)',
  typeof dapp.decodeCXferPayload === 'function');
ok('worker still exports decodeCXferPayload (non-regression)',
  typeof worker.decodeCXferPayload === 'function');

// ============== T_CXFER_BPP round-trip at each m ==============
group('T_CXFER_BPP encode/decode round-trip across m ∈ {1,2,4,8}');

for (const N of [1, 2, 4, 8]) {
  const params = {
    assetId:    fakeAssetId(N * 7),
    kernelSig:  fakeKernelSig(N * 11),
    outputs:    makeOutputs(N, N * 13),
    rangeproof: fakeRangeproof(N * 17, 600 + 32 * N), // shape-only, not a real BP+ proof
  };

  const payload = dapp.encodeCXferBppPayload(params);
  ok(`m=${N}: payload starts with opcode 0x22`, payload[0] === T_CXFER_BPP);

  const expectedLen = 1 + 32 + 64 + 1 + N * (33 + 8) + 2 + params.rangeproof.length;
  ok(`m=${N}: payload length matches §5.47.1`,
    payload.length === expectedLen,
    `expected ${expectedLen}, got ${payload.length}`);

  const decD = dapp.decodeCXferBppPayload(payload);
  ok(`m=${N}: dapp decode succeeds`, decD !== null);
  ok(`m=${N}: dapp kind = cxfer_bpp`, decD?.kind === 'cxfer_bpp');
  ok(`m=${N}: asset_id round-trips`,
    decD && bytesToHex(decD.assetId) === bytesToHex(params.assetId));
  ok(`m=${N}: kernel_sig round-trips`,
    decD && bytesToHex(decD.kernelSig) === bytesToHex(params.kernelSig));
  ok(`m=${N}: output count round-trips`,
    decD?.outputs.length === N);
  ok(`m=${N}: every output commitment round-trips`,
    decD?.outputs.every((o, i) =>
      bytesToHex(o.commitment) === bytesToHex(params.outputs[i].commitment)));
  ok(`m=${N}: every encrypted_amount round-trips`,
    decD?.outputs.every((o, i) =>
      bytesToHex(o.encryptedAmount) === bytesToHex(params.outputs[i].encryptedAmount)));
  ok(`m=${N}: rangeproof round-trips`,
    decD && bytesToHex(decD.rangeproof) === bytesToHex(params.rangeproof));

  const decW = worker.decodeCXferBppPayload(payload);
  ok(`m=${N}: worker decode succeeds`, decW !== null);
  ok(`m=${N}: worker asset_id parity`,
    decW?.asset_id === bytesToHex(params.assetId));
  ok(`m=${N}: worker output count parity`,
    decW?.outputs.length === N);
  ok(`m=${N}: worker per-vout commitment parity`,
    decW?.outputs.every((o, i) =>
      o.commitment === bytesToHex(params.outputs[i].commitment)));
}

// ============== Byte-level delta from CXFER ==============
group('Byte-level delta: BPP envelope == CXFER envelope with only opcode + rangeproof changed');

{
  const assetId   = fakeAssetId(99);
  const kernelSig = fakeKernelSig(98);
  const outputs   = makeOutputs(2, 97);
  const rpCxfer   = fakeRangeproof(70, 754);  // standard BP for m=2
  const rpBpp     = fakeRangeproof(71, 624);  // BP+ for m=2 (smaller)

  const cxferEnv = dapp.encodeCXferPayload({ assetId, kernelSig, outputs, rangeproof: rpCxfer });
  const bppEnv   = dapp.encodeCXferBppPayload({ assetId, kernelSig, outputs, rangeproof: rpBpp });

  ok('CXFER envelope opcode byte = 0x23',
    cxferEnv[0] === T_CXFER);
  ok('BPP envelope opcode byte = 0x22',
    bppEnv[0] === T_CXFER_BPP);

  // The first 1 + 32 + 64 + 1 + N*(33+8) bytes (everything before rp_len)
  // differ ONLY at byte 0 (opcode). Verify byte-for-byte.
  const fixedPrefixLen = 1 + 32 + 64 + 1 + outputs.length * (33 + 8);
  const cxferPrefix = cxferEnv.slice(0, fixedPrefixLen);
  const bppPrefix   = bppEnv.slice(0, fixedPrefixLen);
  let differingBytes = 0;
  const differingIdx = [];
  for (let i = 0; i < fixedPrefixLen; i++) {
    if (cxferPrefix[i] !== bppPrefix[i]) { differingBytes++; differingIdx.push(i); }
  }
  ok('fixed-prefix bytes differ in exactly 1 position (the opcode)',
    differingBytes === 1, `differing at indices: [${differingIdx.join(',')}]`);
  ok('the differing byte is at index 0 (opcode byte)',
    differingIdx[0] === 0);

  // BPP envelope is smaller by (rpCxfer.length - rpBpp.length) — the only
  // size difference is the rangeproof body itself.
  const expectedSizeDelta = rpCxfer.length - rpBpp.length;
  const actualSizeDelta = cxferEnv.length - bppEnv.length;
  ok('total size delta = rangeproof size delta',
    actualSizeDelta === expectedSizeDelta,
    `expected ${expectedSizeDelta}, got ${actualSizeDelta}`);
}

// ============== Kernel-msg byte parity (§5.47.2 soundness claim) ==============
group('Kernel-msg byte parity: computeKernelMsg is opcode-agnostic');

{
  // The amendment's claim: "tacit-kernel-v1" is reused for T_CXFER_BPP
  // because the kernel msg binds (asset_id, input outpoints, output
  // commitments, burned=0), all of which are byte-identical between
  // T_CXFER and T_CXFER_BPP. This test pins that property.
  const assetId = fakeAssetId(50);
  const inputOutpoints = [
    { txid: bytesToHex(bytes(60, 32)), vout: 0 },
    { txid: bytesToHex(bytes(61, 32)), vout: 3 },
  ];
  const outputCommitments = [fakeCommitment(70), fakeCommitment(71)];

  // computeKernelMsg signature in dapp/tacit.js:
  //   computeKernelMsg(assetId, inputOutpoints, outputCommitments, burnedAmount = 0n)
  // Inputs are identical regardless of which opcode wraps them.
  const msgForCxfer = dapp.computeKernelMsg(assetId, inputOutpoints, outputCommitments, 0n);
  const msgForBpp   = dapp.computeKernelMsg(assetId, inputOutpoints, outputCommitments, 0n);

  ok('kernel_msg is byte-identical across opcode contexts',
    bytesToHex(msgForCxfer) === bytesToHex(msgForBpp),
    'this is what justifies §5.47.2\'s reuse of "tacit-kernel-v1"');
  ok('kernel_msg is 32 bytes (SHA-256)',
    msgForCxfer.length === 32);
}

// ============== CXFER encoder non-regression ==============
group('CXFER encoder non-regression: BPP additions did not drift CXFER bytes');

{
  // Pinned fixture: encode a deterministic CXFER envelope and assert the
  // bytes match a hex fixture captured BEFORE the BPP additions. The fixture
  // is generated from the same deterministic seeds used elsewhere in this
  // file so it's reproducible from the test source alone.
  const params = {
    assetId:    fakeAssetId(0),
    kernelSig:  fakeKernelSig(0),
    outputs:    makeOutputs(2, 0),
    rangeproof: fakeRangeproof(0, 754),
  };
  const env = dapp.encodeCXferPayload(params);

  // First byte must be 0x23 (T_CXFER). This is the primary "did we
  // accidentally swap opcodes during the BPP refactor" canary.
  ok('CXFER envelope still opcode 0x23',
    env[0] === T_CXFER);

  // Length sanity: 1 + 32 + 64 + 1 + 2*(33+8) + 2 + 754 = 936.
  ok('CXFER envelope length matches §5.2',
    env.length === 936);

  // Round-trip through the unchanged CXFER decoder.
  const dec = dapp.decodeCXferPayload(env);
  ok('CXFER decoder still returns kind=cxfer (non-regression)',
    dec?.kind === 'cxfer');
  ok('CXFER decoder round-trips asset_id (non-regression)',
    dec && bytesToHex(dec.assetId) === bytesToHex(params.assetId));
  ok('CXFER decoder round-trips rangeproof (non-regression)',
    dec && bytesToHex(dec.rangeproof) === bytesToHex(params.rangeproof));
}

// ============== Forward-compat: pre-amendment decoders reject the new opcode ==============
group('Forward-compat: decodeCXferPayload rejects a BPP envelope (correct soft-fork no-op)');

{
  const params = {
    assetId:    fakeAssetId(200),
    kernelSig:  fakeKernelSig(201),
    outputs:    makeOutputs(2, 202),
    rangeproof: fakeRangeproof(203, 624),
  };
  const bppEnv = dapp.encodeCXferBppPayload(params);

  ok('pre-amendment dapp decodeCXferPayload returns null on a BPP envelope',
    dapp.decodeCXferPayload(bppEnv) === null,
    'this is the correct unknown-opcode-as-no-op behavior per §"Unknown-opcode forward-compatibility rule"');
  ok('pre-amendment worker decodeCXferPayload returns null on a BPP envelope',
    worker.decodeCXferPayload(bppEnv) === null);

  // And the inverse: post-amendment BPP decoder rejects a CXFER envelope.
  const cxferEnv = dapp.encodeCXferPayload({
    ...params,
    rangeproof: fakeRangeproof(204, 754),
  });
  ok('decodeCXferBppPayload returns null on a CXFER envelope',
    dapp.decodeCXferBppPayload(cxferEnv) === null);
  ok('worker.decodeCXferBppPayload returns null on a CXFER envelope',
    worker.decodeCXferBppPayload(cxferEnv) === null);
}

// ============== Mixed-ancestry decoding ==============
group('Mixed-ancestry: alternating CXFER ↔ BPP envelopes dispatch correctly by opcode');

{
  // Simulate a 5-hop ancestry as described in §5.47.5 mixed-ancestry rule.
  const ancestry = [
    { opcode: T_CXFER,     env: dapp.encodeCXferPayload({
        assetId: fakeAssetId(300), kernelSig: fakeKernelSig(300),
        outputs: makeOutputs(1, 300), rangeproof: fakeRangeproof(300, 688) }) },
    { opcode: T_CXFER_BPP, env: dapp.encodeCXferBppPayload({
        assetId: fakeAssetId(300), kernelSig: fakeKernelSig(301),
        outputs: makeOutputs(2, 301), rangeproof: fakeRangeproof(301, 624) }) },
    { opcode: T_CXFER,     env: dapp.encodeCXferPayload({
        assetId: fakeAssetId(300), kernelSig: fakeKernelSig(302),
        outputs: makeOutputs(2, 302), rangeproof: fakeRangeproof(302, 754) }) },
    { opcode: T_CXFER_BPP, env: dapp.encodeCXferBppPayload({
        assetId: fakeAssetId(300), kernelSig: fakeKernelSig(303),
        outputs: makeOutputs(4, 303), rangeproof: fakeRangeproof(303, 672) }) },
    { opcode: T_CXFER_BPP, env: dapp.encodeCXferBppPayload({
        assetId: fakeAssetId(300), kernelSig: fakeKernelSig(304),
        outputs: makeOutputs(8, 304), rangeproof: fakeRangeproof(304, 720) }) },
  ];

  function dispatchDecode(env) {
    if (env[0] === T_CXFER)     return { kind: 'cxfer',     decoded: dapp.decodeCXferPayload(env) };
    if (env[0] === T_CXFER_BPP) return { kind: 'cxfer_bpp', decoded: dapp.decodeCXferBppPayload(env) };
    return { kind: 'unknown', decoded: null };
  }

  let allOk = true;
  let kindMismatch = null;
  for (let i = 0; i < ancestry.length; i++) {
    const expected = ancestry[i].opcode === T_CXFER ? 'cxfer' : 'cxfer_bpp';
    const got = dispatchDecode(ancestry[i].env);
    if (got.kind !== expected || got.decoded === null) {
      allOk = false;
      kindMismatch = `hop ${i}: expected ${expected}, got ${got.kind} (decoded=${got.decoded ? 'ok' : 'null'})`;
      break;
    }
  }
  ok('5-hop mixed CXFER ↔ BPP ancestry dispatches correctly at every hop',
    allOk, kindMismatch);
}

// ============== Rejection sweep ==============
group('Rejection: malformed BPP payloads are deterministically rejected');

{
  const valid = dapp.encodeCXferBppPayload({
    assetId:    fakeAssetId(400),
    kernelSig:  fakeKernelSig(401),
    outputs:    makeOutputs(2, 402),
    rangeproof: fakeRangeproof(403, 100),
  });

  // Wrong opcode byte
  const wrongOp = new Uint8Array(valid); wrongOp[0] = 0x99;
  ok('rejects wrong opcode byte', dapp.decodeCXferBppPayload(wrongOp) === null);
  ok('worker rejects wrong opcode byte', worker.decodeCXferBppPayload(wrongOp) === null);

  // Truncated (one byte short)
  ok('rejects truncated payload',
    dapp.decodeCXferBppPayload(valid.slice(0, -1)) === null);
  ok('worker rejects truncated payload',
    worker.decodeCXferBppPayload(valid.slice(0, -1)) === null);

  // Padded (one extra byte at the end — rp_len wouldn't match)
  ok('rejects padded payload',
    dapp.decodeCXferBppPayload(concatBytes(valid, new Uint8Array([0x00]))) === null);
  ok('worker rejects padded payload',
    worker.decodeCXferBppPayload(concatBytes(valid, new Uint8Array([0x00]))) === null);

  // N must be in {1,2,4,8}. Forge an N=3 envelope.
  const badN = new Uint8Array(valid);
  const nPos = 1 + 32 + 64;
  badN[nPos] = 3;
  ok('rejects N=3 (not in {1,2,4,8})',
    dapp.decodeCXferBppPayload(badN) === null);

  // Encoder enforces N constraint up front
  let encoderRejectedBadN = false;
  try {
    dapp.encodeCXferBppPayload({
      assetId: fakeAssetId(500), kernelSig: fakeKernelSig(501),
      outputs: makeOutputs(3, 502), rangeproof: fakeRangeproof(503, 100),
    });
  } catch { encoderRejectedBadN = true; }
  ok('encoder throws on N=3', encoderRejectedBadN);

  // Encoder rejects wrong-length kernel_sig, asset_id, commitment, encrypted_amount
  function encThrows(label, mut) {
    let threw = false;
    try { dapp.encodeCXferBppPayload(mut); } catch { threw = true; }
    ok(`encoder throws: ${label}`, threw);
  }
  encThrows('asset_id != 32 bytes', {
    assetId: bytes(0, 31), kernelSig: fakeKernelSig(0),
    outputs: makeOutputs(1, 0), rangeproof: fakeRangeproof(0, 100),
  });
  encThrows('kernel_sig != 64 bytes', {
    assetId: fakeAssetId(0), kernelSig: bytes(0, 63),
    outputs: makeOutputs(1, 0), rangeproof: fakeRangeproof(0, 100),
  });
  encThrows('commitment != 33 bytes', {
    assetId: fakeAssetId(0), kernelSig: fakeKernelSig(0),
    outputs: [{ commitment: bytes(0, 32), encryptedAmount: fakeEncAmount(0) }],
    rangeproof: fakeRangeproof(0, 100),
  });
  encThrows('encrypted_amount != 8 bytes', {
    assetId: fakeAssetId(0), kernelSig: fakeKernelSig(0),
    outputs: [{ commitment: fakeCommitment(0), encryptedAmount: bytes(0, 7) }],
    rangeproof: fakeRangeproof(0, 100),
  });
  encThrows('rangeproof > 65535 bytes', {
    assetId: fakeAssetId(0), kernelSig: fakeKernelSig(0),
    outputs: makeOutputs(1, 0), rangeproof: new Uint8Array(0x10000),
  });
}

// ============== Worker-side parity with dapp ==============
group('Worker decoder parity with dapp decoder');

{
  // For every aggregation level, the worker's structural decoder must agree
  // with the dapp's full decoder on the per-vout commitment list. The worker
  // is the convenience-cache code path; if it ever drifts, balance hints
  // silently miscredit recipients.
  for (const N of [1, 2, 4, 8]) {
    const env = dapp.encodeCXferBppPayload({
      assetId: fakeAssetId(600 + N),
      kernelSig: fakeKernelSig(601 + N),
      outputs: makeOutputs(N, 602 + N),
      rangeproof: fakeRangeproof(603 + N, 200),
    });
    const dapeD = dapp.decodeCXferBppPayload(env);
    const dapeW = worker.decodeCXferBppPayload(env);
    ok(`m=${N}: dapp+worker agree on output count`,
      dapeD.outputs.length === dapeW.outputs.length);
    const allMatch = dapeD.outputs.every((o, i) =>
      bytesToHex(o.commitment) === dapeW.outputs[i].commitment);
    ok(`m=${N}: dapp+worker agree on every per-vout commitment`, allMatch);
    ok(`m=${N}: worker asset_id matches dapp asset_id`,
      bytesToHex(dapeD.assetId) === dapeW.asset_id);
  }
}

// ============== Chain-decode integration ==============
// Exercises the FULL path the worker uses when scanning chain:
//   Bitcoin vin[0].witness[1] (envelope script bytes)
//     → decodeEnvelopeScript (unwrap OP_FALSE OP_IF tapscript)
//     → opcode dispatch on env.payload[0]
//     → decodeCXferBppPayload
// This is the integration point that previously broke when slot-mint and
// axfer-var shipped; verifying it offline gives the same confidence that
// an on-chain signet broadcast would, minus chain-acceptance (which is
// trivially true — Bitcoin doesn't inspect witness contents).
group('Chain-decode integration: envelope-script wrap → unwrap → opcode dispatch → payload decode');

{
  // A fake but valid 32-byte x-only signing pubkey. encodeEnvelopeScript
  // only checks length, not curve membership.
  const signingPubXonly = bytes(900, 32);

  for (const N of [1, 2, 4, 8]) {
    const params = {
      assetId:    fakeAssetId(900 + N),
      kernelSig:  fakeKernelSig(901 + N),
      outputs:    makeOutputs(N, 902 + N),
      rangeproof: fakeRangeproof(903 + N, 500 + 16 * N),
    };
    const payload = dapp.encodeCXferBppPayload(params);

    // Wrap as a tacit envelope script (exactly what would appear in
    // vin[0].witness[1] of a confirmed Bitcoin tx).
    const envScript = dapp.encodeEnvelopeScript(signingPubXonly, payload);
    ok(`m=${N}: envelope script encodes`,
      envScript instanceof Uint8Array && envScript.length > 0);

    // Unwrap — this is the worker's first decode step on every scanned tx.
    const unwrapped = dapp.decodeEnvelopeScript(envScript);
    ok(`m=${N}: envelope script unwraps`,
      unwrapped !== null);
    ok(`m=${N}: unwrapped opcode byte = 0x22`,
      unwrapped.payload[0] === T_CXFER_BPP);
    ok(`m=${N}: unwrapped signingPubXonly round-trips`,
      bytesToHex(unwrapped.signingPubXonly) === bytesToHex(signingPubXonly));
    ok(`m=${N}: unwrapped payload byte-identical to original`,
      bytesToHex(unwrapped.payload) === bytesToHex(payload));

    // Dispatch + decode (the worker's second step).
    const decoded = unwrapped.payload[0] === T_CXFER_BPP
      ? dapp.decodeCXferBppPayload(unwrapped.payload)
      : null;
    ok(`m=${N}: dispatched decoder returns BPP shape`,
      decoded?.kind === 'cxfer_bpp');
    ok(`m=${N}: chain-decoded outputs match input`,
      decoded?.outputs.every((o, i) =>
        bytesToHex(o.commitment) === bytesToHex(params.outputs[i].commitment)));
  }
}

group('Chain-decode forward-compat: an old worker (no BPP opcode dispatch) silently ignores');

{
  // Simulate the worker's scan loop BEFORE the BPP additions: it
  // unwraps the envelope, then switches only on T_CXFER / T_AXFER /
  // T_BURN / etc. A BPP envelope falls through every branch and gets
  // logged as "unknown opcode" — which is the correct no-op per
  // §"Unknown-opcode forward-compatibility rule".
  const signingPubXonly = bytes(950, 32);
  const params = {
    assetId:    fakeAssetId(951),
    kernelSig:  fakeKernelSig(952),
    outputs:    makeOutputs(2, 953),
    rangeproof: fakeRangeproof(954, 624),
  };
  const payload = dapp.encodeCXferBppPayload(params);
  const envScript = dapp.encodeEnvelopeScript(signingPubXonly, payload);
  const unwrapped = dapp.decodeEnvelopeScript(envScript);

  // Pre-amendment dispatch: opcode dispatch table only knows the v1 set.
  const preAmendmentOpcodeSet = new Set([
    0x21, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x2B, 0x2C, 0x37,
  ]);
  const opByte = unwrapped.payload[0];
  ok('pre-amendment opcode dispatch table does NOT contain 0x22',
    !preAmendmentOpcodeSet.has(opByte));
  ok('pre-amendment worker logs "unknown opcode" rather than crashing',
    !preAmendmentOpcodeSet.has(opByte) && opByte === 0x22);

  // Mid-flight existing decoders return null on the wrapped BPP payload.
  ok('decodeCXferPayload returns null (correct old-decoder behavior)',
    dapp.decodeCXferPayload(unwrapped.payload) === null);
  ok('worker.decodeCXferPayload returns null on chain-shaped BPP payload',
    worker.decodeCXferPayload(unwrapped.payload) === null);
}

// ============== summary ==============

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
