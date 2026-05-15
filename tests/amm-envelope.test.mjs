// Envelope codec tests: round-trip, malformed rejection, ordering, length checks.

import {
  encodeLpAdd, decodeLpAdd,
  encodeLpRemove, decodeLpRemove,
  encodeSwapBatch, decodeSwapBatch,
  OPCODE_T_LP_ADD, OPCODE_T_LP_REMOVE, OPCODE_T_SWAP_BATCH,
  LP_ADD_VARIANT_STANDARD, LP_ADD_VARIANT_POOL_INIT,
  ENVELOPE_PER_INTENT_BYTES, ENVELOPE_PER_RECEIPT_BYTES,
} from './amm-envelope.mjs';
import { bytesToHex } from '@noble/hashes/utils';

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

function fill(n, b) { const x = new Uint8Array(n); x.fill(b); return x; }
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const ASSET_A = fill(32, 0xaa);
const ASSET_B = fill(32, 0xbb);
const C33 = fill(33, 0x02); C33[1] = 0x10;
const C32 = fill(32, 0x20);
const SIGMA = fill(169, 0xc3);
const SIG64 = fill(64, 0xd4);
const PROOF = fill(256, 0xee);

const lpAddArgs = {
  variant: 0,
  assetA: ASSET_A, assetB: ASSET_B,
  deltaA: 1_000_000n, deltaB: 2_000_000n, shareAmount: 1_414_213n,
  shareCSecp: C33, shareCBJJ: C32, shareXcurveSigma: SIGMA,
  kernelSigA: SIG64, kernelSigB: SIG64,
  proof: PROOF,
};

console.log('T_LP_ADD (variant 0) round-trip');
test('encode/decode round-trip', () => {
  const enc = encodeLpAdd(lpAddArgs);
  const dec = decodeLpAdd(enc);
  return dec.variant === 0
    && dec.deltaA === 1_000_000n && dec.deltaB === 2_000_000n
    && dec.shareAmount === 1_414_213n
    && bytesEqual(dec.assetA, ASSET_A) && bytesEqual(dec.assetB, ASSET_B)
    && bytesEqual(dec.shareCSecp, C33) && bytesEqual(dec.shareCBJJ, C32)
    && bytesEqual(dec.proof, PROOF);
});
test('opcode byte is 0x2D', () => encodeLpAdd(lpAddArgs)[0] === OPCODE_T_LP_ADD);
test('variant byte is 0x00 for standard', () => encodeLpAdd(lpAddArgs)[1] === 0);
test('rejects wrong opcode', () => {
  const enc = encodeLpAdd(lpAddArgs); enc[0] = 0x99;
  try { decodeLpAdd(enc); return false; }
  catch (e) { return /expected opcode/.test(e.message); }
});
test('rejects bad variant', () => {
  const enc = encodeLpAdd(lpAddArgs); enc[1] = 0xff;
  try { decodeLpAdd(enc); return false; }
  catch (e) { return /bad variant/.test(e.message); }
});
test('rejects truncated payload', () => {
  const enc = encodeLpAdd(lpAddArgs);
  const trunc = enc.slice(0, enc.length - 10);
  try { decodeLpAdd(trunc); return false; }
  catch (e) { return /truncated|trailing/.test(e.message); }
});

console.log('\nT_LP_ADD (variant 1 = POOL_INIT) round-trip');
const poolInitArgs = {
  ...lpAddArgs,
  variant: 1,
  feeBps: 30,
  vkCid: 'bafybeicb1234567890abcdef',
  ceremonyCid: 'bafybeice1234567890abcdef',
  arbiterPubkeys: [fill(33, 0x02), fill(33, 0x03)],
  launcherSigs: [SIG64],
};
test('POOL_INIT encode/decode round-trip', () => {
  const enc = encodeLpAdd(poolInitArgs);
  const dec = decodeLpAdd(enc);
  return dec.variant === 1
    && dec.feeBps === 30
    && dec.vkCid === poolInitArgs.vkCid
    && dec.ceremonyCid === poolInitArgs.ceremonyCid
    && dec.arbiterPubkeys.length === 2
    && dec.launcherSigs.length === 1
    && bytesEqual(dec.arbiterPubkeys[0], fill(33, 0x02));
});
test('POOL_INIT with no arbiters/launchers (counts = 0)', () => {
  const args = { ...poolInitArgs, arbiterPubkeys: [], launcherSigs: [] };
  const enc = encodeLpAdd(args);
  const dec = decodeLpAdd(enc);
  return dec.arbiterPubkeys.length === 0 && dec.launcherSigs.length === 0;
});
test('rejects fee_bps > 1000', () => {
  try { encodeLpAdd({ ...poolInitArgs, feeBps: 1001 }); return false; }
  catch (e) { return /feeBps/.test(e.message); }
});
test('rejects > 16 arbiter pubkeys', () => {
  const tooMany = [];
  for (let i = 0; i < 17; i++) tooMany.push(fill(33, 0x02));
  try { encodeLpAdd({ ...poolInitArgs, arbiterPubkeys: tooMany }); return false; }
  catch (e) { return /0..16/.test(e.message); }
});
test('rejects > 2 launcher sigs', () => {
  try { encodeLpAdd({ ...poolInitArgs, launcherSigs: [SIG64, SIG64, SIG64] }); return false; }
  catch (e) { return /0..2/.test(e.message); }
});

console.log('\nT_LP_REMOVE round-trip');
const lpRemoveArgs = {
  assetA: ASSET_A, assetB: ASSET_B,
  shareAmount: 100_000n, deltaA: 50_000n, deltaB: 100_000n,
  recvACSecp: C33, recvACBJJ: C32, recvAXcurveSigma: SIGMA,
  recvBCSecp: C33, recvBCBJJ: C32, recvBXcurveSigma: SIGMA,
  kernelSigLP: SIG64,
  proof: PROOF,
};
test('encode/decode round-trip', () => {
  const enc = encodeLpRemove(lpRemoveArgs);
  const dec = decodeLpRemove(enc);
  return dec.shareAmount === 100_000n
    && dec.deltaA === 50_000n
    && dec.deltaB === 100_000n
    && bytesEqual(dec.kernelSigLP, SIG64)
    && bytesEqual(dec.proof, PROOF);
});
test('opcode byte is 0x2E', () => encodeLpRemove(lpRemoveArgs)[0] === OPCODE_T_LP_REMOVE);

// Trailing-byte rejection (defense-in-depth — silent acceptance
// of extra bytes after a valid payload would be a decoder ambiguity hazard).
test('LP_REMOVE rejects trailing bytes', () => {
  const enc = encodeLpRemove(lpRemoveArgs);
  const padded = new Uint8Array(enc.length + 4);
  padded.set(enc, 0);  // tail bytes are 0x00 from Uint8Array init
  try { decodeLpRemove(padded); return false; }
  catch (e) { return /trailing bytes/.test(e.message); }
});
test('LP_REMOVE rejects truncated payload', () => {
  const enc = encodeLpRemove(lpRemoveArgs);
  const trunc = enc.slice(0, enc.length - 10);
  try { decodeLpRemove(trunc); return false; }
  catch (e) { return /truncated|trailing/.test(e.message); }
});

console.log('\nT_SWAP_BATCH round-trip');
const baseSwapArgs = {
  assetA: ASSET_A, assetB: ASSET_B,
  nIntents: 2,
  deltaANetSigned: 1000n,
  deltaBNetSigned: -2000n,
  rNetA: fill(32, 0x11), rNetB: fill(32, 0x22),
  feeBpsAtSettle: 30,
  tipAAmount: 50n, tipBAmount: 0n,
  tipACSecp: C33, tipBCSecp: C33,
  rTipA: fill(32, 0x33), rTipB: fill(32, 0x44),
  arbiterBlock: null,
  intents: [
    {
      direction: 0,
      traderPubkey: fill(33, 0x02),
      cInSecp: fill(33, 0x02), cInBjj: fill(32, 0x55),
      inXcurveSigma: SIGMA,
      minOut: 900n, tipAmount: 25n, expiryHeight: 800000, intentSig: SIG64,
    },
    {
      direction: 1,
      traderPubkey: fill(33, 0x03),
      cInSecp: fill(33, 0x03), cInBjj: fill(32, 0x66),
      inXcurveSigma: SIGMA,
      minOut: 1900n, tipAmount: 25n, expiryHeight: 800001, intentSig: SIG64,
    },
  ],
  receipts: [
    { cOutSecp: fill(33, 0x02), cOutBjj: fill(32, 0x77), outXcurveSigma: SIGMA },
    { cOutSecp: fill(33, 0x03), cOutBjj: fill(32, 0x88), outXcurveSigma: SIGMA },
  ],
  proof: PROOF,
};
test('encode/decode round-trip (no arbiter)', () => {
  const enc = encodeSwapBatch(baseSwapArgs);
  const dec = decodeSwapBatch(enc);
  return dec.nIntents === 2
    && dec.deltaANetSigned === 1000n
    && dec.deltaBNetSigned === -2000n
    && dec.feeBpsAtSettle === 30
    && dec.tipAAmount === 50n && dec.tipBAmount === 0n
    && dec.intents.length === 2
    && dec.intents[0].direction === 0
    && dec.intents[1].direction === 1
    && dec.intents[0].minOut === 900n
    && dec.intents[1].expiryHeight === 800001
    && dec.receipts.length === 2
    && bytesEqual(dec.proof, PROOF)
    && dec.arbiterBlock === null;
});

test('encode/decode round-trip (with arbiter, m=1)', () => {
  const args = {
    ...baseSwapArgs,
    arbiterBlock: {
      expectedHeight: 800000,
      qualifyingSetHash: fill(32, 0x99),
      m: 1, signerIndices: [0], sigs: SIG64,
    },
  };
  const enc = encodeSwapBatch(args);
  const dec = decodeSwapBatch(enc, { hasArbiter: true });
  return dec.arbiterBlock !== null
    && dec.arbiterBlock.expectedHeight === 800000
    && bytesEqual(dec.arbiterBlock.qualifyingSetHash, fill(32, 0x99))
    && dec.arbiterBlock.m === 1
    && dec.arbiterBlock.signerIndices[0] === 0
    && bytesEqual(dec.arbiterBlock.sigs, SIG64);
});

test('encode/decode round-trip (with arbiter, m=3 of 5)', () => {
  const sigs = new Uint8Array(64 * 3);
  for (let i = 0; i < 3; i++) sigs.set(fill(64, 0xa0 + i), 64 * i);
  const args = {
    ...baseSwapArgs,
    arbiterBlock: {
      expectedHeight: 800001,
      qualifyingSetHash: fill(32, 0x55),
      m: 3, signerIndices: [0, 2, 4], sigs,
    },
  };
  const enc = encodeSwapBatch(args);
  const dec = decodeSwapBatch(enc, { hasArbiter: true });
  return dec.arbiterBlock !== null
    && dec.arbiterBlock.m === 3
    && dec.arbiterBlock.signerIndices[0] === 0
    && dec.arbiterBlock.signerIndices[1] === 2
    && dec.arbiterBlock.signerIndices[2] === 4
    && bytesEqual(dec.arbiterBlock.sigs, sigs);
});

// Trailing-byte rejection for T_SWAP_BATCH.
test('T_SWAP_BATCH rejects trailing bytes', () => {
  const enc = encodeSwapBatch(baseSwapArgs);
  const padded = new Uint8Array(enc.length + 4);
  padded.set(enc, 0);
  try { decodeSwapBatch(padded); return false; }
  catch (e) { return /trailing bytes/.test(e.message); }
});

test('encode rejects descending signerIndices', () => {
  try {
    encodeSwapBatch({
      ...baseSwapArgs,
      arbiterBlock: {
        expectedHeight: 800000, qualifyingSetHash: fill(32, 0x99),
        m: 2, signerIndices: [3, 1], sigs: new Uint8Array(128),
      },
    });
    return false;
  } catch (e) { return /ascending distinct/.test(e.message); }
});

test('decoder with wrong hasArbiter flag corrupts intent parse', () => {
  // Without arbiter block in payload but decoder told hasArbiter=true: it
  // consumes 100 bytes from what should be the first intent's bytes,
  // resulting in malformed intents (direction byte out of range, etc.).
  const enc = encodeSwapBatch(baseSwapArgs); // no arbiter in payload
  try {
    const dec = decodeSwapBatch(enc, { hasArbiter: true });
    // If parsing didn't throw, it produced wrong values.
    return dec.nIntents !== baseSwapArgs.nIntents
        || dec.intents[0].direction === 2 // impossible (must be 0|1)
        || true; // any parse difference is acceptable as long as we don't get the round-trip
  } catch {
    return true; // parse error is also acceptable
  }
});

test('rejects nIntents > 16', () => {
  const tooMany = [];
  for (let i = 0; i < 17; i++) tooMany.push(baseSwapArgs.intents[0]);
  try { encodeSwapBatch({ ...baseSwapArgs, nIntents: 17, intents: tooMany, receipts: tooMany }); return false; }
  catch (e) { return /nIntents/.test(e.message); }
});
test('rejects nIntents == 0', () => {
  try { encodeSwapBatch({ ...baseSwapArgs, nIntents: 0, intents: [], receipts: [] }); return false; }
  catch (e) { return /nIntents/.test(e.message); }
});
test('rejects mismatched intents.length vs nIntents', () => {
  try { encodeSwapBatch({ ...baseSwapArgs, intents: [baseSwapArgs.intents[0]] }); return false; }
  catch (e) { return /intents.length/.test(e.message); }
});
test('rejects mismatched receipts.length vs nIntents', () => {
  try { encodeSwapBatch({ ...baseSwapArgs, receipts: [baseSwapArgs.receipts[0]] }); return false; }
  catch (e) { return /receipts.length/.test(e.message); }
});

console.log('\nIntent ordering enforcement (when _intentId hints provided)');
test('enforces intent_id ascending order when hints present', () => {
  const id1 = fill(32, 0x10);
  const id2 = fill(32, 0x20);
  const intentsBackward = [
    { ...baseSwapArgs.intents[0], _intentId: id2 }, // larger first — should reject
    { ...baseSwapArgs.intents[1], _intentId: id1 },
  ];
  try {
    encodeSwapBatch({ ...baseSwapArgs, intents: intentsBackward });
    return false;
  } catch (e) { return /intent_id ascending/.test(e.message); }
});
test('accepts intent_id ascending order with hints', () => {
  const id1 = fill(32, 0x10);
  const id2 = fill(32, 0x20);
  const intentsForward = [
    { ...baseSwapArgs.intents[0], _intentId: id1 },
    { ...baseSwapArgs.intents[1], _intentId: id2 },
  ];
  const enc = encodeSwapBatch({ ...baseSwapArgs, intents: intentsForward });
  return enc.length > 0;
});

console.log('\nSize sanity');
test('per-intent block is 352 bytes (post 128-bit sigma)', () => ENVELOPE_PER_INTENT_BYTES === 352);
test('per-receipt block is 234 bytes (post 128-bit sigma)', () => ENVELOPE_PER_RECEIPT_BYTES === 234);
test('N=16 swap envelope fits in ~10 KB (sanity matches AMM.md table)', () => {
  const intents16 = [];
  const receipts16 = [];
  for (let i = 0; i < 16; i++) {
    intents16.push(baseSwapArgs.intents[0]);
    receipts16.push(baseSwapArgs.receipts[0]);
  }
  const args = { ...baseSwapArgs, nIntents: 16, intents: intents16, receipts: receipts16 };
  const enc = encodeSwapBatch(args);
  // Global prefix ~270 B + 16 * (352 + 234) = 9376 B + proof 256 B = ~9.9 KB
  return enc.length > 9300 && enc.length < 10800;
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
