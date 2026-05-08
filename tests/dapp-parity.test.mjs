// Differential parity test: dApp source vs test-side mirror in composition.mjs.
//
// This is the F6 closure. Earlier audit work caught two silent drifts (F1 BP
// generator domain strings; T7 mint anchor binding) where the test-side
// reference diverged from the canonical dApp implementation but every
// internally-consistent test still passed. This file imports the actual
// dapp/tacit.js under a jsdom shim and asserts byte-equal output for every
// shared protocol function. Future drift fails this test on the next CI run.
//
// jsdom lets the dApp's top-level DOM access (document.addEventListener,
// localStorage init) succeed; __TACIT_NO_INIT__ prevents init() from running
// (no DOM/network/extension dependencies needed).
//
// Run: `node dapp-parity.test.mjs`

import { JSDOM } from 'jsdom';

// Boot the jsdom shim BEFORE importing the dapp. The dapp expects browser
// globals at module-load time (top-level addEventListener, localStorage reads).
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
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

// Static imports of the test-side mirror.
import * as comp from './composition.mjs';
import * as bp from './bulletproofs.mjs';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import * as secp from '@noble/secp256k1';

// Dynamic import so jsdom shim is in place first.
const dapp = await import('../dapp/tacit.js');

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

const eqBytes = (a, b) => bytesToHex(a) === bytesToHex(b);
// Cross-realm point equality: dapp's `secp.ProjectivePoint` and ours are
// different module instances. Compare via compressed-bytes encoding.
const eqPoint = (p1, p2) => bytesToHex(p1.toRawBytes(true)) === bytesToHex(p2.toRawBytes(true));

// -- Test fixtures (deterministic) --
const SK_A = hexToBytes('0101010101010101010101010101010101010101010101010101010101010101');
const SK_B = hexToBytes('0202020202020202020202020202020202020202020202020202020202020202');
const PK_A = secp.getPublicKey(SK_A, true);
const PK_B = secp.getPublicKey(SK_B, true);
const TXID  = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const ANCHOR = concatBytes(
  Uint8Array.from(hexToBytes('11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff').reverse()),
  (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, 7, true); return b; })(),
);

console.log('§3.1 Generators (dApp ↔ bulletproofs.mjs):');
await test('H matches bulletproofs.mjs H', () => eqPoint(dapp.H, bp.H));
await test('H pins SPEC §3.1 reference vector', () => bytesToHex(dapp.H.toRawBytes(true)) ===
  '02bd7bf40fb5db2f7e0a1e8660ca13df55bb0d9f904e36e6297361f00376865e56');
await test('G is secp256k1 base point', () => bytesToHex(dapp.G.toRawBytes(true)) ===
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
await test('SECP_N matches', () => dapp.SECP_N === 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n);
await test('N_BITS matches', () => dapp.N_BITS === comp.N_BITS);

console.log('\n§3.2 Pedersen commitment:');
await test('pedersenCommit(1000, 7) matches bulletproofs.mjs', () => eqPoint(
  dapp.pedersenCommit(1000n, 7n), bp.pedersenCommit(1000n, 7n),
));
await test('pedersenCommit(1000, 7) pins SPEC vector', () =>
  bytesToHex(dapp.pedersenCommit(1000n, 7n).toRawBytes(true)) ===
  '03925611857a1dcb094300ea201b3c963d1d144fd2b1c502022f14e4c234a02fcb');
await test('pedersenCommit homomorphism: C(3,5)+C(7,11) = C(10,16)', () => eqPoint(
  dapp.pedersenCommit(3n, 5n).add(dapp.pedersenCommit(7n, 11n)),
  dapp.pedersenCommit(10n, 16n),
));

console.log('\n§4 assetIdFor:');
await test('assetIdFor(TXID, 0)', () => eqBytes(
  dapp.assetIdFor(TXID, 0),
  comp.assetIdFor(TXID, 0),
));
await test('assetIdFor(TXID, 1) differs from vout=0', () => !eqBytes(
  dapp.assetIdFor(TXID, 0),
  dapp.assetIdFor(TXID, 1),
));

console.log('\n§3.5 Blinding + keystream derivations:');
await test('deriveBlinding ECDH', () =>
  dapp.deriveBlinding(SK_A, PK_B, ANCHOR, 0) === comp.deriveBlinding(SK_A, PK_B, ANCHOR, 0));
await test('deriveBlinding sender↔recipient symmetric', () =>
  dapp.deriveBlinding(SK_A, PK_B, ANCHOR, 0) === dapp.deriveBlinding(SK_B, PK_A, ANCHOR, 0));
await test('deriveChangeBlinding', () =>
  dapp.deriveChangeBlinding(SK_A, ANCHOR, 1) === comp.deriveChangeBlinding(SK_A, ANCHOR, 1));
await test('deriveEtchBlinding', () =>
  dapp.deriveEtchBlinding(SK_A, ANCHOR) === comp.deriveEtchBlinding(SK_A, ANCHOR));
await test('deriveMintBlinding', () =>
  dapp.deriveMintBlinding(SK_A, ANCHOR) === comp.deriveMintBlinding(SK_A, ANCHOR));
await test('deriveAmountKeystreamECDH', () => eqBytes(
  dapp.deriveAmountKeystreamECDH(SK_A, PK_B, ANCHOR, 0),
  comp.deriveAmountKeystreamECDH(SK_A, PK_B, ANCHOR, 0),
));
await test('deriveAmountKeystreamSelf', () => eqBytes(
  dapp.deriveAmountKeystreamSelf(SK_A, ANCHOR, 1),
  comp.deriveAmountKeystreamSelf(SK_A, ANCHOR, 1),
));
await test('deriveEtchAmountKeystream', () => eqBytes(
  dapp.deriveEtchAmountKeystream(SK_A, ANCHOR),
  comp.deriveEtchAmountKeystream(SK_A, ANCHOR),
));
await test('deriveMintAmountKeystream', () => eqBytes(
  dapp.deriveMintAmountKeystream(SK_A, ANCHOR),
  comp.deriveMintAmountKeystream(SK_A, ANCHOR),
));

console.log('\n§3.5 Amount encryption (XOR-OTP) round-trip:');
const ks = dapp.deriveAmountKeystreamSelf(SK_A, ANCHOR, 1);
await test('dapp encryptAmount = comp encryptAmount', () => eqBytes(
  dapp.encryptAmount(0xdeadbeefn, ks), comp.encryptAmount(0xdeadbeefn, ks),
));
await test('dapp decryptAmount = comp decryptAmount', () =>
  dapp.decryptAmount(dapp.encryptAmount(42n, ks), ks) === comp.decryptAmount(dapp.encryptAmount(42n, ks), ks));

console.log('\n§5 Protocol message hashes:');
const ASSET_ID = dapp.assetIdFor(TXID, 0);
const C1 = dapp.pointToBytes(dapp.pedersenCommit(500n, 42n));
const C2 = dapp.pointToBytes(dapp.pedersenCommit(700n, 99n));
const inputOps = [{ txid: '11'.repeat(32), vout: 3 }];

await test('computeKernelMsg (CXFER, burned=0)', () => eqBytes(
  dapp.computeKernelMsg(ASSET_ID, inputOps, [C1, C2], 0n),
  comp.computeKernelMsg(ASSET_ID, inputOps, [C1, C2], 0n),
));
await test('computeKernelMsg (BURN, burned=42)', () => eqBytes(
  dapp.computeKernelMsg(ASSET_ID, inputOps, [C1], 42n),
  comp.computeKernelMsg(ASSET_ID, inputOps, [C1], 42n),
));
await test('computeMintMsg (with commit_anchor binding)', () => eqBytes(
  dapp.computeMintMsg(ASSET_ID, ANCHOR, C1, new Uint8Array(8)),
  comp.computeMintMsg(ASSET_ID, ANCHOR, C1, new Uint8Array(8)),
));
await test('openingMsg', () => eqBytes(
  dapp.openingMsg(ASSET_ID, TXID, 0, 1000n, hexToBytes('11'.repeat(32)), PK_A),
  comp.openingMsg(ASSET_ID, TXID, 0, 1000n, hexToBytes('11'.repeat(32)), PK_A),
));
await test('disclosureMsg', () => eqBytes(
  dapp.disclosureMsg(ASSET_ID, [{ txid: TXID, vout: 0 }], 250n, hexToBytes('aa'.repeat(688)), PK_A),
  comp.disclosureMsg(ASSET_ID, [{ txid: TXID, vout: 0 }], 250n, hexToBytes('aa'.repeat(688)), PK_A),
));
await test('listingMsgBytes (dApp) ↔ listingMsg (composition)', () => eqBytes(
  dapp.listingMsgBytes(ASSET_ID, TXID, 0, 50000, 1700000000, 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', new Uint8Array(64)),
  comp.listingMsg(ASSET_ID, TXID, 0, 50000, 1700000000, 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', new Uint8Array(64)),
));
await test('cancelMsgBytes (dApp) ↔ cancelMsg (composition)', () => eqBytes(
  dapp.cancelMsgBytes(ASSET_ID, TXID, 0),
  comp.cancelMsg(ASSET_ID, TXID, 0),
));
await test('claimMsgBytes (dApp) ↔ claimMsg (composition)', () => eqBytes(
  dapp.claimMsgBytes(ASSET_ID, TXID, 0, PK_A),
  comp.claimMsg(ASSET_ID, TXID, 0, PK_A),
));

console.log('\n§5b Atomic-intent message hashes:');
const INTENT_ID = hexToBytes('cd'.repeat(16));
const COMMIT_TXID = 'd'.repeat(64);
const ASSET_UTXO_TXID = 'e'.repeat(64);
const ASSET_UTXO_VOUT = 1;
await test('axintentMsg', () => eqBytes(
  dapp.axintentMsg(ASSET_ID, INTENT_ID, PK_A, 1234n, 50000, 1700000000, COMMIT_TXID, ASSET_UTXO_TXID, ASSET_UTXO_VOUT),
  comp.axintentMsg(ASSET_ID, INTENT_ID, PK_A, 1234n, 50000, 1700000000, COMMIT_TXID, ASSET_UTXO_TXID, ASSET_UTXO_VOUT),
));
await test('axintentClaimMsg (v2: binds taker_utxo)', () => eqBytes(
  dapp.axintentClaimMsg(ASSET_ID, INTENT_ID, PK_B, ASSET_UTXO_TXID, ASSET_UTXO_VOUT),
  comp.axintentClaimMsg(ASSET_ID, INTENT_ID, PK_B, ASSET_UTXO_TXID, ASSET_UTXO_VOUT),
));
await test('axintentFulfilmentMsg', () => {
  const partialJson = '{"version":2,"locktime":0,"inputs":[],"outputs":[]}';
  return eqBytes(
    dapp.axintentFulfilmentMsg(ASSET_ID, INTENT_ID, PK_B, partialJson),
    comp.axintentFulfilmentMsg(ASSET_ID, INTENT_ID, PK_B, partialJson),
  );
});
await test('axintentCancelMsg', () => eqBytes(
  dapp.axintentCancelMsg(ASSET_ID, INTENT_ID),
  comp.axintentCancelMsg(ASSET_ID, INTENT_ID),
));

console.log('\n§5c Atomic-intent recipient_blinding ECDH encryption (round-trip):');
await test('keystream symmetric maker(SK_A,PK_B) === taker(SK_B,PK_A)', () => eqBytes(
  dapp.deriveAxintentBlindingKeystream(SK_A, PK_B, INTENT_ID, ASSET_ID),
  dapp.deriveAxintentBlindingKeystream(SK_B, PK_A, INTENT_ID, ASSET_ID),
));
await test('dapp keystream === comp keystream', () => eqBytes(
  dapp.deriveAxintentBlindingKeystream(SK_A, PK_B, INTENT_ID, ASSET_ID),
  comp.deriveAxintentBlindingKeystream(SK_A, PK_B, INTENT_ID, ASSET_ID),
));
await test('keystream depends on intent_id (different intent → different keystream)', () => {
  const k1 = dapp.deriveAxintentBlindingKeystream(SK_A, PK_B, INTENT_ID, ASSET_ID);
  const otherIntent = hexToBytes('ab'.repeat(16));
  const k2 = dapp.deriveAxintentBlindingKeystream(SK_A, PK_B, otherIntent, ASSET_ID);
  return !eqBytes(k1, k2);
});
await test('keystream depends on asset_id (different asset → different keystream)', () => {
  const k1 = dapp.deriveAxintentBlindingKeystream(SK_A, PK_B, INTENT_ID, ASSET_ID);
  const otherAsset = sha256(new TextEncoder().encode('different-asset'));
  const k2 = dapp.deriveAxintentBlindingKeystream(SK_A, PK_B, INTENT_ID, otherAsset);
  return !eqBytes(k1, k2);
});
await test('encrypt/decrypt round-trip recovers r', () => {
  const r = hexToBytes('5a'.repeat(32));
  const ksMaker = dapp.deriveAxintentBlindingKeystream(SK_A, PK_B, INTENT_ID, ASSET_ID);
  const enc = dapp.xor32(r, ksMaker);
  const ksTaker = dapp.deriveAxintentBlindingKeystream(SK_B, PK_A, INTENT_ID, ASSET_ID);
  const dec = dapp.xor32(enc, ksTaker);
  return eqBytes(dec, r);
});
await test('outsider cannot decrypt (wrong privkey → wrong r)', () => {
  const r = hexToBytes('5a'.repeat(32));
  const ksMaker = dapp.deriveAxintentBlindingKeystream(SK_A, PK_B, INTENT_ID, ASSET_ID);
  const enc = dapp.xor32(r, ksMaker);
  // Outsider has SK_C and tries to decrypt using their priv against maker.pub.
  const SK_C = hexToBytes('07'.repeat(32));
  const ksOut = dapp.deriveAxintentBlindingKeystream(SK_C, PK_A, INTENT_ID, ASSET_ID);
  const decBad = dapp.xor32(enc, ksOut);
  return !eqBytes(decBad, r);
});

console.log('\n§5 Envelope encoders / decoders (cross-decode round-trip):');
const fakeRangeproof = hexToBytes('aa'.repeat(688));
const fakeKernelSig = hexToBytes('bb'.repeat(64));
const fakeIssuerSig = hexToBytes('cc'.repeat(64));

await test('CETCH: dapp.encode → comp.decode round-trips', () => {
  const payload = dapp.encodeCEtchPayload({
    ticker: 'TEST', decimals: 4,
    commitment: C1, rangeproof: fakeRangeproof,
    encryptedAmount: hexToBytes('1122334455667788'),
    mintAuthority: null, imageUri: 'ipfs://bafkfake',
  });
  const dec = comp.decodeCEtchPayload(payload);
  return dec && dec.ticker === 'TEST' && dec.decimals === 4 && dec.imageUri === 'ipfs://bafkfake';
});
await test('CETCH: comp.encode → dapp.decode round-trips', () => {
  const payload = comp.encodeCEtchPayload({
    ticker: 'XYZ', decimals: 0,
    commitment: C1, rangeproof: fakeRangeproof,
    encryptedAmount: new Uint8Array(8),
    mintAuthority: null, imageUri: null,
  });
  const dec = dapp.decodeCEtchPayload(payload);
  return dec && dec.ticker === 'XYZ' && dec.decimals === 0 && !dec.imageUri;
});
await test('CXFER: dapp.encode → comp.decode round-trips', () => {
  const payload = dapp.encodeCXferPayload({
    assetId: ASSET_ID, kernelSig: fakeKernelSig,
    outputs: [
      { commitment: C1, encryptedAmount: new Uint8Array(8) },
      { commitment: C2, encryptedAmount: new Uint8Array(8) },
    ],
    rangeproof: fakeRangeproof,
  });
  const dec = comp.decodeCXferPayload(payload);
  return dec && dec.outputs.length === 2 && bytesToHex(dec.assetId) === bytesToHex(ASSET_ID);
});
await test('CMINT: dapp.encode → comp.decode round-trips', () => {
  const payload = dapp.encodeCMintPayload({
    assetId: ASSET_ID, etchTxid: hexToBytes(TXID),
    commitment: C1, encryptedAmount: new Uint8Array(8),
    rangeproof: fakeRangeproof, issuerSig: fakeIssuerSig,
  });
  const dec = comp.decodeCMintPayload(payload);
  return dec && bytesToHex(dec.assetId) === bytesToHex(ASSET_ID);
});
await test('CBURN: dapp.encode (N=0) → comp.decode round-trips', () => {
  const payload = dapp.encodeCBurnPayload({
    assetId: ASSET_ID, burnedAmount: 1000n,
    kernelSig: fakeKernelSig, outputs: [], rangeproof: new Uint8Array(0),
  });
  const dec = comp.decodeCBurnPayload(payload);
  return dec && dec.burnedAmount === 1000n && dec.outputs.length === 0;
});

console.log('\n§3.4 BIP-340 Schnorr cross-impl:');
const SK = hexToBytes('0000000000000000000000000000000000000000000000000000000000000003');
const PUB_X = secp.getPublicKey(SK, true).slice(1);
const MSG = hexToBytes('00'.repeat(32));
await test('dapp.sign verifies under comp.verify', () => {
  const sig = dapp.signSchnorr(MSG, SK);
  return comp.verifySchnorr(sig, MSG, PUB_X) === true;
});
await test('comp.sign verifies under dapp.verify', () => {
  const sig = comp.signSchnorr(MSG, SK);
  return dapp.verifySchnorr(sig, MSG, PUB_X) === true;
});
await test('both verifiers reject R = ∞ forgery (regression)', () => {
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  // Build sig where R = sG − eP = identity (s = e·d, d = 3, Rx = 0).
  const Rx = new Uint8Array(32);
  // tagged_hash via direct sha256
  const enc = new TextEncoder();
  const t = sha256(enc.encode('BIP0340/challenge'));
  const buf = new Uint8Array(t.length * 2 + 32 + PUB_X.length + 32);
  buf.set(t, 0); buf.set(t, t.length);
  buf.set(Rx, t.length * 2);
  buf.set(PUB_X, t.length * 2 + 32);
  buf.set(MSG, t.length * 2 + 32 + PUB_X.length);
  const e = BigInt('0x' + bytesToHex(sha256(buf))) % N;
  const s = (e * 3n) % N;
  const sBytes = new Uint8Array(32);
  let v = s;
  for (let i = 31; i >= 0; i--) { sBytes[i] = Number(v & 0xffn); v >>= 8n; }
  const sig = new Uint8Array(64);
  sig.set(Rx, 0); sig.set(sBytes, 32);
  return dapp.verifySchnorr(sig, MSG, PUB_X) === false
      && comp.verifySchnorr(sig, MSG, PUB_X) === false;
});

console.log('\nEncrypted-at-rest privkey storage cross-impl:');
const PRIV = hexToBytes('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const PASSPHRASE = 'correct horse battery staple';

await test('dapp.encryptPrivkey → dapp.decryptPrivkey round-trip', async () => {
  const blob = await dapp.encryptPrivkey(PRIV, PASSPHRASE);
  const recovered = await dapp.decryptPrivkey(blob, PASSPHRASE);
  return bytesToHex(recovered) === bytesToHex(PRIV);
});
await test('dapp.encryptPrivkey produces blob shape compatible with tests/storage.mjs', async () => {
  const blob = await dapp.encryptPrivkey(PRIV, PASSPHRASE);
  const parsed = JSON.parse(blob);
  return parsed.v === 1 && parsed.kdf === 'pbkdf2' && parsed.iter === 600000
    && /^[0-9a-f]{32}$/.test(parsed.salt) && /^[0-9a-f]{24}$/.test(parsed.iv);
});
await test('dapp.encryptPrivkey blob decrypts via tests/storage.mjs decryptPrivkey', async () => {
  const blob = await dapp.encryptPrivkey(PRIV, PASSPHRASE);
  const { decryptPrivkey } = await import('./storage.mjs');
  const recovered = await decryptPrivkey(blob, PASSPHRASE);
  return bytesToHex(recovered) === bytesToHex(PRIV);
});

// SPEC §5.8 / §5.9 — permissionless mint (T_PETCH / T_PMINT). Pin the dapp
// encoder against the worker decoder so wire-format drift between the two
// halves shows up as a test failure rather than as a silently-rejected
// envelope at indexing time. Same purpose as the existing CETCH/MINT/BURN
// parity rows above.
console.log('\nT_PETCH / T_PMINT cross-impl:');

const worker = await import('../worker/src/index.js');

await test('dapp.encodeCPetchPayload bytes decode via worker.decodeCPetchPayload', () => {
  const bytes = dapp.encodeCPetchPayload({
    ticker: 'FAIR',
    decimals: 2,
    capAmount: 21_000_000_00n,
    mintLimit: 1000_00n,
    mintStartHeight: 0,
    mintEndHeight: 0,
    imageUri: 'ipfs://bafkreitestcid',
  });
  const dec = worker.decodeCPetchPayload(bytes);
  if (!dec) return false;
  return dec.ticker === 'FAIR'
      && dec.decimals === 2
      && dec.cap_amount === '2100000000'
      && dec.mint_limit === '100000'
      && dec.mint_start_height === 0
      && dec.mint_end_height === 0
      && dec.image_uri === 'ipfs://bafkreitestcid';
});

await test('dapp.encodeCPetchPayload with height window decodes correctly', () => {
  const bytes = dapp.encodeCPetchPayload({
    ticker: 'TIMED',
    decimals: 0,
    capAmount: 1000n,
    mintLimit: 10n,
    mintStartHeight: 100_000,
    mintEndHeight: 200_000,
  });
  const dec = worker.decodeCPetchPayload(bytes);
  return dec?.mint_start_height === 100_000 && dec?.mint_end_height === 200_000;
});

await test('dapp.encodeCPetchPayload throws on cap not divisible by limit', () => {
  try {
    dapp.encodeCPetchPayload({ ticker: 'X', decimals: 0, capAmount: 1000n, mintLimit: 333n });
    return false;
  } catch (e) {
    return /divisible/.test(e.message);
  }
});

await test('dapp.encodeCPetchPayload throws on mint_limit > cap_amount', () => {
  try {
    dapp.encodeCPetchPayload({ ticker: 'X', decimals: 0, capAmount: 100n, mintLimit: 1000n });
    return false;
  } catch (e) {
    return /out of range/.test(e.message);
  }
});

await test('dapp.encodeCPmintPayload bytes decode via worker.decodeCPmintPayload', () => {
  const assetId = new Uint8Array(32); assetId[0] = 1;
  const etchTxid = new Uint8Array(32); etchTxid[31] = 0xff;
  const commitment = new Uint8Array(33); commitment[0] = 0x02; commitment[32] = 1;
  const blinding = new Uint8Array(32); blinding[31] = 7;
  const bytes = dapp.encodeCPmintPayload({
    assetId, etchTxid, commitment, amount: 1000_00n, blinding,
  });
  // SPEC §5.9: total length must be exactly 138 bytes
  if (bytes.length !== 138) return false;
  const dec = worker.decodeCPmintPayload(bytes);
  if (!dec) return false;
  return dec.amount === '100000'
      && dec.asset_id === bytesToHex(assetId)
      && dec.etch_txid === bytesToHex(etchTxid)
      && dec.commitment === bytesToHex(commitment)
      && dec.blinding === bytesToHex(blinding);
});

await test('dapp.encodeCPmintPayload throws on all-zero blinding', () => {
  try {
    dapp.encodeCPmintPayload({
      assetId: new Uint8Array(32),
      etchTxid: new Uint8Array(32),
      commitment: (() => { const c = new Uint8Array(33); c[0] = 2; return c; })(),
      amount: 100n,
      blinding: new Uint8Array(32),
    });
    return false;
  } catch (e) {
    return /non-zero/.test(e.message);
  }
});

await test('dapp.decodeCPetchPayload accepts dapp-encoded bytes (round-trip)', () => {
  const bytes = dapp.encodeCPetchPayload({
    ticker: 'AB', decimals: 0, capAmount: 100n, mintLimit: 10n,
  });
  const dec = dapp.decodeCPetchPayload(bytes);
  return dec?.kind === 'cpetch' && dec.ticker === 'AB' && dec.capAmount === 100n;
});

await test('dapp.decodeCPmintPayload accepts dapp-encoded bytes (round-trip)', () => {
  const blinding = new Uint8Array(32); blinding[0] = 1;
  const commitment = new Uint8Array(33); commitment[0] = 2;
  const bytes = dapp.encodeCPmintPayload({
    assetId: new Uint8Array(32),
    etchTxid: new Uint8Array(32),
    commitment, amount: 50n, blinding,
  });
  const dec = dapp.decodeCPmintPayload(bytes);
  return dec?.kind === 'cpmint' && dec.amount === 50n;
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
