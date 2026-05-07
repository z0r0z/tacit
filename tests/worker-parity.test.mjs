// Cross-impl message-byte parity between the worker's helpers and the
// test-side mirror of the dApp (composition.mjs). The worker has its own copies
// of openingMsg / disclosureMsg / listingMsg / cancelMsg / claimMsg + a
// verifySchnorr — drift here is silent: every signed POST starts failing with
// "invalid sig" and the user can't tell whether the bug is theirs or ours.
//
// We feed both sides the same inputs and assert byte-equal output.
//
// The signatures differ at the boundary (worker takes hex strings for most
// args; composition takes Uint8Arrays). The bytes flowing into sha256 must
// still match, so we normalise at the call site.
//
// Run: `node worker-parity.test.mjs`
import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import * as worker from '../worker/src/index.js';
import * as composition from './composition.mjs';
import { signSchnorr } from './composition.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(ok => {
      if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
      else             { console.log(`  FAIL  ${label}`); fail++; }
    })
    .catch(e => { console.log(`  THROW ${label}: ${e.message}`); fail++; });
}
const eq = (a, b) => bytesToHex(a) === bytesToHex(b);

// -- Fixtures --
const ASSET_ID_HEX = 'a'.repeat(64);
const ASSET_ID_BYTES = hexToBytes(ASSET_ID_HEX);
const TXID_HEX = 'b'.repeat(64);
const VOUT = 7;
const AMOUNT = 12345n;
const BLINDING_HEX = '11'.repeat(32);
const BLINDING_BYTES = hexToBytes(BLINDING_HEX);
const OWNER_SK = hexToBytes('0000000000000000000000000000000000000000000000000000000000000003');
const OWNER_PUB_BYTES = secp.ProjectivePoint.BASE.multiply(3n).toRawBytes(true);
const OWNER_PUB_HEX = bytesToHex(OWNER_PUB_BYTES);
const OWNER_XONLY = OWNER_PUB_BYTES.slice(1);

const UTXOS = [
  { txid: TXID_HEX, vout: VOUT },
  { txid: 'c'.repeat(64), vout: 0 },
];
const THRESHOLD = 1000n;
const RANGEPROOF_HEX = 'aa'.repeat(688); // m=1, n=64 BP size
const RANGEPROOF_BYTES = hexToBytes(RANGEPROOF_HEX);
const PRICE_SATS = 50000;
const EXPIRY = 1700000000;
const MAKER_ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const OPENING_SIG_HEX = 'ee'.repeat(64);
const OPENING_SIG_BYTES = hexToBytes(OPENING_SIG_HEX);

console.log('Message-byte parity (worker vs composition.mjs):');

await test('openingMsg', () => eq(
  worker.openingMsg(ASSET_ID_HEX, TXID_HEX, VOUT, AMOUNT.toString(), BLINDING_HEX, OWNER_PUB_HEX),
  composition.openingMsg(ASSET_ID_BYTES, TXID_HEX, VOUT, AMOUNT, BLINDING_BYTES, OWNER_PUB_BYTES),
));

await test('disclosureMsg', () => eq(
  worker.disclosureMsg(ASSET_ID_HEX, UTXOS, THRESHOLD, RANGEPROOF_HEX, OWNER_PUB_HEX),
  composition.disclosureMsg(ASSET_ID_BYTES, UTXOS, THRESHOLD, RANGEPROOF_BYTES, OWNER_PUB_BYTES),
));

await test('listingMsg', () => eq(
  worker.listingMsg(ASSET_ID_HEX, TXID_HEX, VOUT, PRICE_SATS, EXPIRY, MAKER_ADDR, OPENING_SIG_HEX),
  composition.listingMsg(ASSET_ID_BYTES, TXID_HEX, VOUT, PRICE_SATS, EXPIRY, MAKER_ADDR, OPENING_SIG_BYTES),
));

await test('cancelMsg', () => eq(
  worker.cancelMsg(ASSET_ID_HEX, TXID_HEX, VOUT),
  composition.cancelMsg(ASSET_ID_BYTES, TXID_HEX, VOUT),
));

await test('claimMsg', () => eq(
  worker.claimMsg(ASSET_ID_HEX, TXID_HEX, VOUT, OWNER_PUB_HEX),
  composition.claimMsg(ASSET_ID_BYTES, TXID_HEX, VOUT, OWNER_PUB_BYTES),
));

// Atomic-intent message hashes — same byte-parity discipline. The worker uses
// these to verify intent_sig / claim sig / fulfilment sig / cancel sig at
// every endpoint; if the dapp's mirror drifts, signatures stop validating.
const INTENT_ID_HEX = 'cd'.repeat(16);                    // 16-byte intent_id
const INTENT_ID_BYTES = hexToBytes(INTENT_ID_HEX);
const COMMIT_TXID_HEX = 'd'.repeat(64);
const ASSET_UTXO_TXID_HEX = 'e'.repeat(64);
const ASSET_UTXO_VOUT = 1;

await test('atomicIntentMsg', () => eq(
  worker.atomicIntentMsg(ASSET_ID_HEX, INTENT_ID_HEX, OWNER_PUB_HEX, AMOUNT.toString(), PRICE_SATS, EXPIRY, COMMIT_TXID_HEX, ASSET_UTXO_TXID_HEX, ASSET_UTXO_VOUT),
  composition.axintentMsg(ASSET_ID_BYTES, INTENT_ID_BYTES, OWNER_PUB_BYTES, AMOUNT, PRICE_SATS, EXPIRY, COMMIT_TXID_HEX, ASSET_UTXO_TXID_HEX, ASSET_UTXO_VOUT),
));

await test('atomicIntentClaimMsg (v2: binds taker_utxo)', () => eq(
  worker.atomicIntentClaimMsg(ASSET_ID_HEX, INTENT_ID_HEX, OWNER_PUB_HEX, TXID_HEX, VOUT),
  composition.axintentClaimMsg(ASSET_ID_BYTES, INTENT_ID_BYTES, OWNER_PUB_BYTES, TXID_HEX, VOUT),
));

await test('atomicIntentFulfilmentMsg', () => {
  const partialJson = '{"version":2,"locktime":0,"inputs":[],"outputs":[]}';
  return eq(
    worker.atomicIntentFulfilmentMsg(ASSET_ID_HEX, INTENT_ID_HEX, OWNER_PUB_HEX, partialJson),
    composition.axintentFulfilmentMsg(ASSET_ID_BYTES, INTENT_ID_BYTES, OWNER_PUB_BYTES, partialJson),
  );
});

// Drop-announcement message hashes — pinned-vector regression sentinels.
// composition.mjs doesn't (yet) mirror these helpers, so we pin the worker's
// expected output for a known fixture; any drift in the field layout, domain
// tag, network byte, or endianness fails this test loudly. The dApp's
// `dropAnnounceMsgBytes` is byte-equal by construction (mirrored), and the
// dapp-parity suite covers their cross-realm equality once added there.
await test('dropAnnounceMsg signet vector', () => eq(
  worker.dropAnnounceMsg('signet', 'a'.repeat(64), 'b'.repeat(64), 'bafybeihtest', 1700000000, 'Q1 2026 community drop'),
  hexToBytes('cc0bcd08c5de66019892b7bec59f5b40955dd72ddf30b03e063e3e5de1ab2ae4'),
));
await test('dropAnnounceMsg mainnet vector (different network → different hash)', () => eq(
  worker.dropAnnounceMsg('mainnet', 'a'.repeat(64), 'b'.repeat(64), 'bafybeihtest', 1700000000, 'Q1 2026 community drop'),
  hexToBytes('3e7b2fe9cf3da00654f880ed7d7edecdaedf8446980a99d15074206e6c4d5685'),
));
await test('dropAnnounceMsg empty-note vector', () => eq(
  worker.dropAnnounceMsg('signet', 'a'.repeat(64), 'b'.repeat(64), 'bafybeihtest', 1700000000, ''),
  hexToBytes('12b6a6972bc2a55d40c110c61ad8dca9bc4286c77af97175fa9f0a91846a079f'),
));
await test('dropAnnounceCancelMsg signet vector', () => eq(
  worker.dropAnnounceCancelMsg('signet', 'b'.repeat(64), '02' + '11'.repeat(32)),
  hexToBytes('a4998333b6e8337c5a20d7e5c10a61c5fd2e0b0e34bf5c3e6ea589e7f4f5ebe9'),
));
await test('dropAnnounceCancelMsg mainnet vector', () => eq(
  worker.dropAnnounceCancelMsg('mainnet', 'b'.repeat(64), '02' + '11'.repeat(32)),
  hexToBytes('dd187a0472371b993ec3459e0b10d283e9957c310c29ba7fe7d915b5589da4a5'),
));

await test('atomicIntentCancelMsg', () => eq(
  worker.atomicIntentCancelMsg(ASSET_ID_HEX, INTENT_ID_HEX),
  composition.axintentCancelMsg(ASSET_ID_BYTES, INTENT_ID_BYTES),
));

console.log('\nverifySchnorr parity:');
// Sign with composition's signer; verify with both. They must agree.
const sigOK = signSchnorr(
  composition.openingMsg(ASSET_ID_BYTES, TXID_HEX, VOUT, AMOUNT, BLINDING_BYTES, OWNER_PUB_BYTES),
  OWNER_SK,
);
const msg = composition.openingMsg(ASSET_ID_BYTES, TXID_HEX, VOUT, AMOUNT, BLINDING_BYTES, OWNER_PUB_BYTES);

await test('valid sig: both verifiers accept', () => {
  const w = worker.verifySchnorr(sigOK, msg, OWNER_XONLY);
  const c = composition.verifySchnorr(sigOK, msg, OWNER_XONLY);
  return w === true && c === true;
});

await test('tampered sig: both verifiers reject', () => {
  const bad = new Uint8Array(sigOK);
  bad[10] ^= 0x01;
  const w = worker.verifySchnorr(bad, msg, OWNER_XONLY);
  const c = composition.verifySchnorr(bad, msg, OWNER_XONLY);
  return w === false && c === false;
});

await test('R = ∞ regression: both verifiers reject (BIP-340 conformance)', () => {
  // Construct a sig that forces R = sG − eP = identity (s = e·d, d = 3, Rx = 0).
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const Rx = new Uint8Array(32);
  const m = new Uint8Array(32); // any msg
  // tagged_hash("BIP0340/challenge", Rx || P_x || m)
  const enc = new TextEncoder();
  const t = sha256(enc.encode('BIP0340/challenge'));
  const inputBuf = new Uint8Array(t.length * 2 + Rx.length + OWNER_XONLY.length + m.length);
  inputBuf.set(t, 0); inputBuf.set(t, t.length);
  inputBuf.set(Rx, t.length * 2);
  inputBuf.set(OWNER_XONLY, t.length * 2 + Rx.length);
  inputBuf.set(m, t.length * 2 + Rx.length + OWNER_XONLY.length);
  const e = BigInt('0x' + bytesToHex(sha256(inputBuf))) % N;
  const s = (e * 3n) % N;
  const sBytes = new Uint8Array(32);
  let v = s;
  for (let i = 31; i >= 0; i--) { sBytes[i] = Number(v & 0xffn); v >>= 8n; }
  const sig = new Uint8Array(64);
  sig.set(Rx, 0); sig.set(sBytes, 32);
  const w = worker.verifySchnorr(sig, m, OWNER_XONLY);
  const c = composition.verifySchnorr(sig, m, OWNER_XONLY);
  return w === false && c === false;
});

console.log('\ncompressedPointFromHex (worker-only guard):');

// Compare points by their compressed-bytes representation: the worker uses a
// different `@noble/secp256k1` realm than this test, so direct .equals() across
// realms throws "Point expected". Bytes round-trip is the realm-safe check.
const pointEqBytes = (p, expectedBytes) =>
  bytesToHex(p.toRawBytes(true)) === bytesToHex(expectedBytes);

await test('valid compressed G accepts and round-trips', () => {
  const G = secp.ProjectivePoint.BASE.toRawBytes(true);
  const p = worker.compressedPointFromHex(bytesToHex(G));
  return pointEqBytes(p, G);
});

await test('32-byte hex (x-only) rejects', () => {
  try { worker.compressedPointFromHex('aa'.repeat(32)); return false; }
  catch (e) { return /must be 33 bytes/.test(e.message); }
});

await test('65-byte hex (uncompressed) rejects', () => {
  try { worker.compressedPointFromHex('04' + 'aa'.repeat(64)); return false; }
  catch (e) { return /must be 33 bytes/.test(e.message); }
});

await test('33-byte hex with 04 prefix rejects', () => {
  try { worker.compressedPointFromHex('04' + 'aa'.repeat(32)); return false; }
  catch (e) { return /prefix must be 02\/03/.test(e.message); }
});

await test('33-byte hex with 05 prefix rejects', () => {
  try { worker.compressedPointFromHex('05' + 'aa'.repeat(32)); return false; }
  catch (e) { return /prefix must be 02\/03/.test(e.message); }
});

await test('uppercase hex normalises (case-insensitive)', () => {
  const G = secp.ProjectivePoint.BASE.toRawBytes(true);
  const p = worker.compressedPointFromHex(bytesToHex(G).toUpperCase());
  return pointEqBytes(p, G);
});

await test('Uint8Array input also accepted (33-byte buffer)', () => {
  const G = secp.ProjectivePoint.BASE.toRawBytes(true);
  const p = worker.compressedPointFromHex(G);
  return pointEqBytes(p, G);
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
