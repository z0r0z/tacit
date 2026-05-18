// cBTC.tac lien-edge recovery: deterministic openings for
//   - T_SHARE_SLASH_CLAIM (0x4C): new LP-share UTXO whose blinding is
//     HMAC(priv, "tacit-share-slash-claim-blind-v1" || first_burn_outpoint).
//   - T_CTAC_LIEN_SPLIT (0x4F): N output UTXOs whose (amount, blinding) pairs
//     are entirely PUBLIC in the envelope, so anyone with the chain tx
//     recovers them by decoding alone.
//
// These tests assert the cryptographic property only — that the derivation
// scheme produces a blinding that opens the on-chain commit. The dapp scanner
// branches in dapp/tacit.js apply the same derivation; this test fixes drift
// between the scanner and the encoder.

import { JSDOM } from 'jsdom';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import * as secp from '@noble/secp256k1';

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

import { SECP_N, pedersenCommit } from './bulletproofs.mjs';

const dapp = await import('../dapp/tacit.js');
const {
  encodeTShareSlashClaimPayload, decodeTShareSlashClaimPayload,
  encodeTCtacLienSplitPayload, decodeTCtacLienSplitPayload,
  computeShareSlashClaimBindHash, computeCtacLienSplitBindHash,
} = dapp;

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const r = fn();
    if (r === true) { console.log(`  PASS  ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}: ${r}`); fail++; }
  } catch (e) { console.log(`  THROW ${label}: ${e.message}`); fail++; }
}

function bytes32ToBigint(b) {
  let x = 0n;
  for (let i = 0; i < 32; i++) x = (x << 8n) | BigInt(b[i]);
  return x;
}
function bigintTo32(x) {
  const b = new Uint8Array(32);
  let v = BigInt(x);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}
function u32LE(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}
function reverseBytes(b) {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i];
  return out;
}

// Re-derivation as used by the scanner branch — must match dapp/tacit.js's
// _deriveShareSlashClaimBlinding.
const _SHARE_SLASH_BLIND_DOMAIN = new TextEncoder().encode('tacit-share-slash-claim-blind-v1');
function deriveShareSlashClaimBlinding(privkey, anchorOutpoint) {
  const base = concatBytes(_SHARE_SLASH_BLIND_DOMAIN, anchorOutpoint);
  let seed = hmac(sha256, privkey, base);
  let r = bytes32ToBigint(seed) % SECP_N;
  for (let counter = 1; r === 0n && counter < 256; counter++) {
    seed = hmac(sha256, privkey, concatBytes(base, new Uint8Array([counter & 0xff])));
    r = bytes32ToBigint(seed) % SECP_N;
  }
  return r;
}

// ---- T_SHARE_SLASH_CLAIM tests ------------------------------------------

test('share-slash-claim: blinding is deterministic from priv + first-burn outpoint', () => {
  const priv = new Uint8Array(32).fill(0x44);
  const anchor = concatBytes(reverseBytes(new Uint8Array(32).fill(0xaa)), u32LE(0));
  const r1 = deriveShareSlashClaimBlinding(priv, anchor);
  const r2 = deriveShareSlashClaimBlinding(priv, anchor);
  if (r1 !== r2) return 'derivation not deterministic';
  if (r1 === 0n) return 'derivation produced 0 (rejection sampling broken)';
  return true;
});

test('share-slash-claim: different anchor → different blinding', () => {
  const priv = new Uint8Array(32).fill(0x44);
  const anchorA = concatBytes(reverseBytes(new Uint8Array(32).fill(0xaa)), u32LE(0));
  const anchorB = concatBytes(reverseBytes(new Uint8Array(32).fill(0xbb)), u32LE(0));
  return deriveShareSlashClaimBlinding(priv, anchorA) !== deriveShareSlashClaimBlinding(priv, anchorB)
    || 'collision across anchors';
});

test('share-slash-claim: full encode-decode-recover roundtrip', () => {
  const priv = new Uint8Array(32).fill(0x44);
  const firstBurnTxidHex = 'aa' + '11'.repeat(31);
  const firstBurnVout = 1;
  const anchor = concatBytes(reverseBytes(hexToBytes(firstBurnTxidHex)), u32LE(firstBurnVout));

  const claimLpShares = 12345n;
  const rBig = deriveShareSlashClaimBlinding(priv, anchor);
  const recipientCommit = pedersenCommit(claimLpShares, rBig).toRawBytes(true);

  // Build minimal valid envelope (1 burn, placeholders for rangeproof/proof).
  const shareNullifiers = [new Uint8Array(32).fill(0x77)];
  const shareCommits = [pedersenCommit(100n, 200n).toRawBytes(true)];
  const shareBalanceProof = new Uint8Array([0x01, 0x02]);
  const bindHash = computeShareSlashClaimBindHash({
    networkTag: 1, shareCount: 1, shareNullifiers, shareCommits,
    shareBurnAmount: 100n, claimTAC: claimLpShares, recipientCommit,
  });
  const proof = new Uint8Array([0xff]);
  const payload = encodeTShareSlashClaimPayload({
    networkTag: 1, shareNullifiers, shareCommits, shareBurnAmount: 100n,
    shareBalanceProof, claimTAC: claimLpShares, recipientCommit,
    bindHash, proof,
  });

  const dec = decodeTShareSlashClaimPayload(payload);
  if (!dec) return 'decode failed';
  if (dec.claimTAC !== claimLpShares) return `claimTAC ${dec.claimTAC} !== ${claimLpShares}`;
  if (bytesToHex(dec.recipientCommit) !== bytesToHex(recipientCommit)) return 'recipient_commit mismatch';

  // Recover the opening just like the scanner does.
  const recovered = deriveShareSlashClaimBlinding(priv, anchor);
  const reCommit = pedersenCommit(dec.claimTAC, recovered).toRawBytes(true);
  return bytesToHex(reCommit) === bytesToHex(dec.recipientCommit) || 'recovered opening does not match commit';
});

// ---- T_CTAC_LIEN_SPLIT tests --------------------------------------------

test('lien-split: openings are fully public; decoder returns them verbatim', () => {
  const positionLeafHash = new Uint8Array(32).fill(0xbe);
  const sourceOutpoint = concatBytes(reverseBytes(new Uint8Array(32).fill(0xee)), u32LE(0));
  const outputCount = 3;
  const outputAmounts = [100n, 250n, 50n];
  const outputBlindings = [
    bigintTo32(7n), bigintTo32(11n), bigintTo32(13n),
  ];
  const outputCommits = outputBlindings.map((b, i) =>
    pedersenCommit(outputAmounts[i], bytes32ToBigint(b)).toRawBytes(true)
  );
  const depositorSig = new Uint8Array(64).fill(0x42);
  const bindHash = computeCtacLienSplitBindHash({
    networkTag: 1, positionLeafHash, sourceOutpoint, outputCount,
    outputAmounts, outputBlindings, outputCommits, lienInheritIndex: 0,
  });
  const payload = encodeTCtacLienSplitPayload({
    networkTag: 1, positionLeafHash, sourceOutpoint,
    outputAmounts, outputBlindings, outputCommits,
    lienInheritIndex: 0, depositorSig, bindHash,
  });
  const dec = decodeTCtacLienSplitPayload(payload);
  if (!dec) return 'decode failed';
  if (dec.outputCount !== outputCount) return `outputCount ${dec.outputCount} !== ${outputCount}`;
  for (let i = 0; i < outputCount; i++) {
    if (dec.outputAmounts[i] !== outputAmounts[i]) return `amount[${i}] mismatch`;
    const r = bytes32ToBigint(dec.outputBlindings[i]) % SECP_N;
    const reCommit = pedersenCommit(dec.outputAmounts[i], r).toRawBytes(true);
    if (bytesToHex(reCommit) !== bytesToHex(dec.outputCommits[i])) {
      return `commit[${i}] does not reproduce from opening`;
    }
  }
  return true;
});

test('lien-split: openings recover by chain-only inspection (no privkey needed)', () => {
  // The recovery property: anyone — including a fresh wallet — who reads the
  // envelope can credit the matching UTXO. We simulate "fresh wallet" by
  // computing recovery without any priv input.
  const positionLeafHash = new Uint8Array(32).fill(0xbe);
  const sourceOutpoint = concatBytes(reverseBytes(new Uint8Array(32).fill(0xee)), u32LE(0));
  const outputAmounts = [777n, 333n];
  const outputBlindings = [bigintTo32(999n), bigintTo32(1234567n)];
  const outputCommits = outputBlindings.map((b, i) =>
    pedersenCommit(outputAmounts[i], bytes32ToBigint(b)).toRawBytes(true)
  );
  const bindHash = computeCtacLienSplitBindHash({
    networkTag: 1, positionLeafHash, sourceOutpoint, outputCount: 2,
    outputAmounts, outputBlindings, outputCommits, lienInheritIndex: 1,
  });
  const payload = encodeTCtacLienSplitPayload({
    networkTag: 1, positionLeafHash, sourceOutpoint,
    outputAmounts, outputBlindings, outputCommits,
    lienInheritIndex: 1, depositorSig: new Uint8Array(64).fill(0x01), bindHash,
  });
  const dec = decodeTCtacLienSplitPayload(payload);

  // Recover each output's opening using only the envelope (no priv).
  for (let v = 0; v < dec.outputCount; v++) {
    const amount = dec.outputAmounts[v];
    const r = bytes32ToBigint(dec.outputBlindings[v]) % SECP_N;
    const reC = pedersenCommit(amount, r).toRawBytes(true);
    if (bytesToHex(reC) !== bytesToHex(dec.outputCommits[v])) return `opening[${v}] doesn't open commit`;
  }
  return true;
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
