// Intent / cancel / envelope_hash / qualifying_set_hash tests.

import {
  buildIntentMsg, deriveIntentId, signIntent, verifyIntent,
  buildIntentCancelMsg, signIntentCancel, verifyIntentCancel,
  computeEnvelopeHash,
  buildCanonicalListBytes, computeQualifyingSetHash,
  signQualifyingSet, verifyQualifyingSet,
} from './amm-intent.mjs';
import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';

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

const POOL_ID = new Uint8Array(32).fill(0x77);
const C_IN_SECP = new Uint8Array(33); C_IN_SECP[0] = 0x02; C_IN_SECP.set(new Uint8Array(32).fill(0xa1), 1);
const C_IN_BJJ = new Uint8Array(32).fill(0xb2);
const X_SIGMA = new Uint8Array(157).fill(0xc3);
const RECV_SPK = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xd4)]); // OP_0 14 <20-byte hash>
const TRADER_SK = new Uint8Array(32);
for (let i = 0; i < 32; i++) TRADER_SK[i] = i + 1;
const TRADER_PUB = secp.ProjectivePoint.fromPrivateKey(TRADER_SK).toRawBytes(true);

const intentArgs = {
  poolId: POOL_ID, direction: 0,
  inputUtxos: [{ txid: 'deadbeefcafef00d0123456789abcdef0123456789abcdef0123456789abcdef', vout: 0 }],
  cInSecp: C_IN_SECP, cInBjj: C_IN_BJJ, xcurveSigma: X_SIGMA,
  receiveScriptPubKey: RECV_SPK,
  minOut: 1000n, tipAmount: 50n, tipAsset: 0,
  expiryHeight: 800000, traderPubkey: TRADER_PUB,
};

console.log('intent_msg construction');
test('produces deterministic bytes', () => {
  const m1 = buildIntentMsg(intentArgs);
  const m2 = buildIntentMsg(intentArgs);
  return bytesToHex(m1) === bytesToHex(m2);
});
test('intent_msg starts with domain tag', () => {
  const m = buildIntentMsg(intentArgs);
  const expected = new TextEncoder().encode('tacit-amm-intent-v1');
  for (let i = 0; i < expected.length; i++) if (m[i] !== expected[i]) return false;
  return true;
});
test('changing pool_id changes intent_msg', () => {
  const m1 = buildIntentMsg(intentArgs);
  const m2 = buildIntentMsg({ ...intentArgs, poolId: new Uint8Array(32).fill(0x66) });
  return bytesToHex(m1) !== bytesToHex(m2);
});
test('changing direction changes intent_msg', () => {
  const m1 = buildIntentMsg(intentArgs);
  const m2 = buildIntentMsg({ ...intentArgs, direction: 1 });
  return bytesToHex(m1) !== bytesToHex(m2);
});
test('changing min_out changes intent_msg', () => {
  const m1 = buildIntentMsg(intentArgs);
  const m2 = buildIntentMsg({ ...intentArgs, minOut: 1001n });
  return bytesToHex(m1) !== bytesToHex(m2);
});
test('rejects invalid direction', () => {
  try { buildIntentMsg({ ...intentArgs, direction: 2 }); return false; }
  catch (e) { return /direction/.test(e.message); }
});
test('rejects invalid tip_asset', () => {
  try { buildIntentMsg({ ...intentArgs, tipAsset: 2 }); return false; }
  catch (e) { return /tipAsset/.test(e.message); }
});
test('rejects too-long receive script', () => {
  try {
    buildIntentMsg({ ...intentArgs, receiveScriptPubKey: new Uint8Array(70000) });
    return false;
  } catch (e) { return /receiveScriptPubKey too large/.test(e.message); }
});
test('rejects empty input_utxos', () => {
  try { buildIntentMsg({ ...intentArgs, inputUtxos: [] }); return false; }
  catch (e) { return /1..255 entries/.test(e.message); }
});

console.log('\nintent_id derivation');
test('intent_id is 32 bytes', () => deriveIntentId(buildIntentMsg(intentArgs)).length === 32);
test('intent_id is SHA256(intent_msg)', () => {
  const m = buildIntentMsg(intentArgs);
  const expected = sha256(m);
  const got = deriveIntentId(m);
  return bytesToHex(expected) === bytesToHex(got);
});

console.log('\nIntent signing + verification');
test('honest sig verifies', () => {
  const m = buildIntentMsg(intentArgs);
  const sig = signIntent(m, TRADER_SK);
  return verifyIntent(m, sig, TRADER_PUB);
});
test('tampered intent_msg ⇒ sig rejects', () => {
  const m = buildIntentMsg(intentArgs);
  const sig = signIntent(m, TRADER_SK);
  const tampered = new Uint8Array(m); tampered[20] ^= 0x01;
  return !verifyIntent(tampered, sig, TRADER_PUB);
});
test('wrong pubkey ⇒ sig rejects', () => {
  const m = buildIntentMsg(intentArgs);
  const sig = signIntent(m, TRADER_SK);
  const wrongSk = new Uint8Array(32); for (let i = 0; i < 32; i++) wrongSk[i] = i + 100;
  const wrongPub = secp.ProjectivePoint.fromPrivateKey(wrongSk).toRawBytes(true);
  return !verifyIntent(m, sig, wrongPub);
});

console.log('\nIntent cancel');
test('cancel_msg depends on (pool_id, intent_id)', () => {
  const iid1 = deriveIntentId(buildIntentMsg(intentArgs));
  const iid2 = deriveIntentId(buildIntentMsg({ ...intentArgs, minOut: 999n }));
  const c1 = buildIntentCancelMsg({ poolId: POOL_ID, intentId: iid1 });
  const c2 = buildIntentCancelMsg({ poolId: POOL_ID, intentId: iid2 });
  return bytesToHex(c1) !== bytesToHex(c2);
});
test('honest cancel sig verifies', () => {
  const iid = deriveIntentId(buildIntentMsg(intentArgs));
  const sig = signIntentCancel({ poolId: POOL_ID, intentId: iid }, TRADER_SK);
  return verifyIntentCancel({ poolId: POOL_ID, intentId: iid, sig64: sig, traderPubkey33: TRADER_PUB });
});
test('cancel sig over wrong intent_id ⇒ rejects', () => {
  const iid = deriveIntentId(buildIntentMsg(intentArgs));
  const sig = signIntentCancel({ poolId: POOL_ID, intentId: iid }, TRADER_SK);
  const otherIid = new Uint8Array(32).fill(0xff);
  return !verifyIntentCancel({ poolId: POOL_ID, intentId: otherIid, sig64: sig, traderPubkey33: TRADER_PUB });
});

console.log('\nenvelope_hash');
test('envelope_hash is SHA256 of payload', () => {
  const payload = new Uint8Array([0x2f, 0x01, 0x02, 0x03]);
  const h = computeEnvelopeHash(payload);
  return bytesToHex(h) === bytesToHex(sha256(payload));
});
test('different payloads ⇒ different hashes', () => {
  const h1 = computeEnvelopeHash(new Uint8Array([1, 2, 3]));
  const h2 = computeEnvelopeHash(new Uint8Array([1, 2, 4]));
  return bytesToHex(h1) !== bytesToHex(h2);
});

console.log('\nqualifying_set_hash');
const id1 = new Uint8Array(32).fill(0x10);
const id2 = new Uint8Array(32).fill(0x20);
const id3 = new Uint8Array(32).fill(0x30);
test('canonical list is sorted ascending', () => {
  const bytes = buildCanonicalListBytes([id3, id1, id2]);
  // bytes: u16 count(2) || id1(32) || id2(32) || id3(32)
  return bytes[0] === 3 && bytes[1] === 0 && bytes[2] === 0x10 && bytes[34] === 0x20 && bytes[66] === 0x30;
});
test('qualifying_set_hash deterministic', () => {
  const h1 = computeQualifyingSetHash({ poolId: POOL_ID, height: 800_000, intentIds: [id1, id2] });
  const h2 = computeQualifyingSetHash({ poolId: POOL_ID, height: 800_000, intentIds: [id2, id1] });
  // Same set, different order — hash should match.
  return bytesToHex(h1) === bytesToHex(h2);
});
test('different heights ⇒ different hashes', () => {
  const h1 = computeQualifyingSetHash({ poolId: POOL_ID, height: 800_000, intentIds: [id1] });
  const h2 = computeQualifyingSetHash({ poolId: POOL_ID, height: 800_001, intentIds: [id1] });
  return bytesToHex(h1) !== bytesToHex(h2);
});
test('different pool_ids ⇒ different hashes', () => {
  const h1 = computeQualifyingSetHash({ poolId: POOL_ID, height: 800_000, intentIds: [id1] });
  const h2 = computeQualifyingSetHash({
    poolId: new Uint8Array(32).fill(0x66), height: 800_000, intentIds: [id1],
  });
  return bytesToHex(h1) !== bytesToHex(h2);
});
test('different intent sets ⇒ different hashes', () => {
  const h1 = computeQualifyingSetHash({ poolId: POOL_ID, height: 800_000, intentIds: [id1] });
  const h2 = computeQualifyingSetHash({ poolId: POOL_ID, height: 800_000, intentIds: [id2] });
  return bytesToHex(h1) !== bytesToHex(h2);
});

console.log('\nArbiter signing');
test('arbiter sig over qualifying set verifies', () => {
  const args = { poolId: POOL_ID, height: 800_000, intentIds: [id1, id2] };
  const sig = signQualifyingSet(args, TRADER_SK);
  return verifyQualifyingSet({ ...args, sig64: sig, arbiterPubkey33: TRADER_PUB });
});
test('arbiter sig over different set ⇒ rejects', () => {
  const sig = signQualifyingSet({ poolId: POOL_ID, height: 800_000, intentIds: [id1] }, TRADER_SK);
  return !verifyQualifyingSet({
    poolId: POOL_ID, height: 800_000, intentIds: [id2],
    sig64: sig, arbiterPubkey33: TRADER_PUB,
  });
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
