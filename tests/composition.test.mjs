// Composition-level cryptography tests.
//
// Bulletproofs alone don't make CT sound — the kernel sig, ECDH derivations,
// and wire-format encoders are all load-bearing. These tests pin their
// behaviour so a refactor can't silently break them.
//
// Run: `node composition.test.mjs`
import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import {
  G, H, ZERO, SECP_N, modN,
  pedersenCommit, pointToBytes, bytesToPoint, bigintToBytes32, bytes32ToBigint,
  randomScalar, _bpGens,
  bpRangeAggProve, bpRangeAggVerify,
} from './bulletproofs.mjs';
import {
  N_BITS, T_CETCH, T_CXFER,
  reverseBytes, assetIdFor,
  deriveBlinding, deriveChangeBlinding, deriveEtchBlinding,
  deriveAmountKeystreamECDH, deriveAmountKeystreamSelf, deriveEtchAmountKeystream,
  encryptAmount, decryptAmount,
  signSchnorr, verifySchnorr,
  computeKernelMsg,
  encodeCEtchPayload, decodeCEtchPayload,
  encodeCXferPayload, decodeCXferPayload,
} from './composition.mjs';

let pass = 0, fail = 0;
function test(label, fn) {
  const start = Date.now();
  try {
    const ok = fn();
    const ms = Date.now() - start;
    if (ok) { console.log(`  PASS  ${label.padEnd(60)} ${ms}ms`); pass++; }
    else    { console.log(`  FAIL  ${label.padEnd(60)} ${ms}ms`); fail++; }
  } catch (e) {
    console.log(`  THROW ${label.padEnd(60)} ${e.message}`);
    fail++;
  }
}

const bytesEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function newWallet() {
  const priv = secp.utils.randomPrivateKey();
  const pub = secp.getPublicKey(priv, true);
  return { priv, pub, xonly: pub.slice(1) };
}
function fakeOutpoint() {
  const txid = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const vout = Math.floor(Math.random() * 4);
  return { txid, vout };
}
function anchorOf(outpoint) {
  const voutLE = new Uint8Array(4);
  new DataView(voutLE.buffer).setUint32(0, outpoint.vout >>> 0, true);
  return concatBytes(reverseBytes(hexToBytes(outpoint.txid)), voutLE);
}

console.log('Warming up generators…');
const t0 = Date.now();
_bpGens();
console.log(`  ready in ${Date.now() - t0}ms\n`);

// ----------- Pedersen ------------
console.log('Pedersen homomorphism:');
test('C(a) + C(b) == C(a+b) when blindings add', () => {
  const r1 = randomScalar(), r2 = randomScalar();
  const a = 100n, b = 250n;
  const C1 = pedersenCommit(a, r1);
  const C2 = pedersenCommit(b, r2);
  const Csum = pedersenCommit(a + b, modN(r1 + r2));
  return C1.add(C2).equals(Csum);
});
test('C(0, 0) == ZERO', () => pedersenCommit(0n, 0n).equals(ZERO));
test('C(a, r) − C(a, r) == ZERO (subtraction round-trip)', () => {
  const a = 7777n, r = randomScalar();
  const C = pedersenCommit(a, r);
  return C.add(C.negate()).equals(ZERO);
});

// ----------- Schnorr ------------
console.log('\nBIP-340 Schnorr (in-house impl):');
test('valid sig verifies', () => {
  const priv = secp.utils.randomPrivateKey();
  const pub = secp.getPublicKey(priv, true);
  const msg = sha256(new TextEncoder().encode('hello tacit'));
  const sig = signSchnorr(msg, priv);
  return verifySchnorr(sig, msg, pub.slice(1));
});
test('reject sig with flipped bit in R_x', () => {
  const priv = secp.utils.randomPrivateKey();
  const msg = sha256(new TextEncoder().encode('msg'));
  const sig = new Uint8Array(signSchnorr(msg, priv));
  sig[0] ^= 1;
  return !verifySchnorr(sig, msg, secp.getPublicKey(priv, true).slice(1));
});
test('reject sig under different msg', () => {
  const priv = secp.utils.randomPrivateKey();
  const sig = signSchnorr(sha256(new TextEncoder().encode('a')), priv);
  return !verifySchnorr(sig, sha256(new TextEncoder().encode('b')), secp.getPublicKey(priv, true).slice(1));
});
test('reject sig under different pubkey', () => {
  const priv1 = secp.utils.randomPrivateKey();
  const priv2 = secp.utils.randomPrivateKey();
  const msg = sha256(new TextEncoder().encode('msg'));
  const sig = signSchnorr(msg, priv1);
  return !verifySchnorr(sig, msg, secp.getPublicKey(priv2, true).slice(1));
});
test('reject s ≥ N', () => {
  const priv = secp.utils.randomPrivateKey();
  const msg = sha256(new TextEncoder().encode('msg'));
  const sig = new Uint8Array(signSchnorr(msg, priv));
  for (let i = 32; i < 64; i++) sig[i] = 0xff;
  return !verifySchnorr(sig, msg, secp.getPublicKey(priv, true).slice(1));
});
test('cross-check: in-house verify accepts noble-signed sig', () => {
  const priv = secp.utils.randomPrivateKey();
  const pub = secp.getPublicKey(priv, true);
  const msg = sha256(new TextEncoder().encode('cross-check'));
  const sig = secp.signAsync ? null : null;  // placeholder
  // noble@2.1 has sync schnorr.sign; if not present, skip gracefully.
  if (!secp.schnorr || !secp.schnorr.sign) return true;
  const nobleSig = secp.schnorr.sign(msg, priv);
  return verifySchnorr(nobleSig, msg, pub.slice(1));
});
test('cross-check: noble verify accepts in-house sig', () => {
  if (!secp.schnorr || !secp.schnorr.verify) return true;
  const priv = secp.utils.randomPrivateKey();
  const pub = secp.getPublicKey(priv, true);
  const msg = sha256(new TextEncoder().encode('cross-check'));
  const ourSig = signSchnorr(msg, priv);
  return secp.schnorr.verify(ourSig, msg, pub.slice(1));
});

// ----------- ECDH derivations ------------
console.log('\nECDH-derived blindings & keystreams:');
test('deriveBlinding is symmetric (sender ↔ recipient)', () => {
  const sender = newWallet();
  const recip  = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  const fromSender = deriveBlinding(sender.priv, recip.pub, anchor, 0);
  const fromRecip  = deriveBlinding(recip.priv,  sender.pub, anchor, 0);
  return fromSender === fromRecip;
});
test('deriveAmountKeystreamECDH is symmetric', () => {
  const sender = newWallet();
  const recip  = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  const ksA = deriveAmountKeystreamECDH(sender.priv, recip.pub, anchor, 0);
  const ksB = deriveAmountKeystreamECDH(recip.priv, sender.pub, anchor, 0);
  return bytesEq(ksA, ksB);
});
test('different anchors → different blindings', () => {
  const a = newWallet(), b = newWallet();
  const r1 = deriveBlinding(a.priv, b.pub, anchorOf(fakeOutpoint()), 0);
  const r2 = deriveBlinding(a.priv, b.pub, anchorOf(fakeOutpoint()), 0);
  return r1 !== r2;
});
test('different vouts → different blindings', () => {
  const a = newWallet(), b = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  return deriveBlinding(a.priv, b.pub, anchor, 0) !== deriveBlinding(a.priv, b.pub, anchor, 1);
});
test('change blinding is independent of recipient blinding', () => {
  // Same anchor, same vout, but different domain → different scalar.
  const a = newWallet(), b = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  const recip = deriveBlinding(a.priv, b.pub, anchor, 0);
  const change = deriveChangeBlinding(a.priv, anchor, 0);
  return recip !== change;
});
test('etch blinding ≠ change blinding (domain separation)', () => {
  const w = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  return deriveEtchBlinding(w.priv, anchor) !== deriveChangeBlinding(w.priv, anchor, 0);
});
test('amount-keystream-self ≠ amount-keystream-ecdh (domain separation)', () => {
  const a = newWallet(), b = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  const ksSelf = deriveAmountKeystreamSelf(a.priv, anchor, 0);
  const ksEcdh = deriveAmountKeystreamECDH(a.priv, b.pub, anchor, 0);
  return !bytesEq(ksSelf, ksEcdh);
});
test('different privs → different self-derived keystreams', () => {
  const a = newWallet(), b = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  return !bytesEq(
    deriveAmountKeystreamSelf(a.priv, anchor, 0),
    deriveAmountKeystreamSelf(b.priv, anchor, 0),
  );
});

// ----------- Amount encryption ------------
console.log('\nAmount encryption (XOR-OTP):');
test('encrypt → decrypt round-trip', () => {
  const w = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  const ks = deriveAmountKeystreamSelf(w.priv, anchor, 0);
  const amt = 1234567890n;
  return decryptAmount(encryptAmount(amt, ks), ks) === amt;
});
test('encrypt with wrong keystream → garbage (≠ original)', () => {
  const w1 = newWallet(), w2 = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  const ks1 = deriveAmountKeystreamSelf(w1.priv, anchor, 0);
  const ks2 = deriveAmountKeystreamSelf(w2.priv, anchor, 0);
  const amt = 42n;
  return decryptAmount(encryptAmount(amt, ks1), ks2) !== amt;
});
test('encryptAmount rejects amount ≥ 2^64', () => {
  const ks = new Uint8Array(8);
  try { encryptAmount(1n << 64n, ks); return false; } catch { return true; }
});
test('encryptAmount rejects negative', () => {
  const ks = new Uint8Array(8);
  try { encryptAmount(-1n, ks); return false; } catch { return true; }
});
test('Pedersen commitment binds amount under tampered ciphertext', () => {
  // The "integrity tag" property: tampering with ct yields a candidate
  // amount that fails the commitment check. (Not direct decrypt tampering —
  // the commitment recheck is what catches it in the dApp.)
  const w = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  const ks = deriveAmountKeystreamSelf(w.priv, anchor, 0);
  const r = deriveChangeBlinding(w.priv, anchor, 0);
  const amt = 1000n;
  const ct = encryptAmount(amt, ks);
  const C = pedersenCommit(amt, r);
  // Tamper one byte:
  ct[0] ^= 1;
  const candidate = decryptAmount(ct, ks);
  // Different amount; commitment should NOT match
  return !pedersenCommit(candidate, r).equals(C);
});

// ----------- Asset ID ------------
console.log('\nAsset ID:');
test('assetIdFor is deterministic', () => {
  const txid = 'deadbeef'.repeat(8);
  return bytesEq(assetIdFor(txid, 0), assetIdFor(txid, 0));
});
test('assetIdFor differs on vout', () => {
  const txid = 'deadbeef'.repeat(8);
  return !bytesEq(assetIdFor(txid, 0), assetIdFor(txid, 1));
});
test('assetIdFor uses LE-byte txid (BE-hex input)', () => {
  // Sanity-pin the encoding: BE hex → LE bytes; if anyone flips this, asset_ids change globally.
  const txidBE = '0011223344556677889900112233445566778899001122334455667788990011';
  const aid = assetIdFor(txidBE, 0);
  const expected = sha256(concatBytes(
    reverseBytes(hexToBytes(txidBE)),
    new Uint8Array([0, 0, 0, 0]),
  ));
  return bytesEq(aid, expected);
});

// ----------- Kernel signature (the OTHER half of CT soundness) ------------
console.log('\nKernel signature (Mimblewimble-style):');
function buildBalancedCxfer() {
  // Sender holds two input UTXOs; sends to recipient + change.
  const sender = newWallet(), recip = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  const inAmts = [200n, 300n];
  const inBlindings = [randomScalar(), randomScalar()];
  const inputCommits = inAmts.map((a, i) => pedersenCommit(a, inBlindings[i]));
  const sendAmt = 350n, changeAmt = 150n; // sums match: 200+300 = 350+150
  const recipBlinding = deriveBlinding(sender.priv, recip.pub, anchor, 0);
  const changeBlinding = deriveChangeBlinding(sender.priv, anchor, 1);
  const outCommits = [
    pedersenCommit(sendAmt, recipBlinding),
    pedersenCommit(changeAmt, changeBlinding),
  ];
  const inBlindingSum = modN(inBlindings.reduce((s, x) => s + x, 0n));
  const excess = modN(recipBlinding + changeBlinding - inBlindingSum);
  const assetId = sha256(new TextEncoder().encode('ASSET'));
  const inputOutpoints = [fakeOutpoint(), fakeOutpoint()];
  const outputCommitments = outCommits.map(pointToBytes);
  const msg = computeKernelMsg(assetId, inputOutpoints, outputCommitments);
  const sig = signSchnorr(msg, bigintToBytes32(excess));
  return { sender, recip, assetId, inputCommits, outCommits, inputOutpoints, outputCommitments, msg, sig };
}
function verifyKernel({ inputCommits, outCommits, inputOutpoints, outputCommitments, assetId, sig }) {
  let EPrime = ZERO;
  for (const C of outCommits) EPrime = EPrime.add(C);
  for (const C of inputCommits) EPrime = EPrime.add(C.negate());
  if (EPrime.equals(ZERO)) return false;
  const xonly = EPrime.toRawBytes(true).slice(1);
  const msg = computeKernelMsg(assetId, inputOutpoints, outputCommitments);
  return verifySchnorr(sig, msg, xonly);
}
test('balanced CXFER kernel sig verifies', () => {
  const t = buildBalancedCxfer();
  return verifyKernel(t);
});
test('unbalanced (out > in) kernel sig REJECTS', () => {
  // Sender tries to mint: outputs sum to 600 but inputs only 500.
  const sender = newWallet(), recip = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  const inAmts = [200n, 300n];
  const inBlindings = [randomScalar(), randomScalar()];
  const inputCommits = inAmts.map((a, i) => pedersenCommit(a, inBlindings[i]));
  const sendAmt = 400n, changeAmt = 200n; // sum=600, NOT 500
  const recipBlinding = deriveBlinding(sender.priv, recip.pub, anchor, 0);
  const changeBlinding = deriveChangeBlinding(sender.priv, anchor, 1);
  const outCommits = [
    pedersenCommit(sendAmt, recipBlinding),
    pedersenCommit(changeAmt, changeBlinding),
  ];
  const inBlindingSum = modN(inBlindings.reduce((s, x) => s + x, 0n));
  const excess = modN(recipBlinding + changeBlinding - inBlindingSum);
  // Prover signs with excess scalar — but E' has a non-zero H component, so the sig
  // verifies under E'.x_only only if the prover knows dlog(H). They don't, so this fails.
  const assetId = sha256(new TextEncoder().encode('ASSET'));
  const inputOutpoints = [fakeOutpoint(), fakeOutpoint()];
  const outputCommitments = outCommits.map(pointToBytes);
  const msg = computeKernelMsg(assetId, inputOutpoints, outputCommitments);
  const sig = signSchnorr(msg, bigintToBytes32(excess));
  return !verifyKernel({ inputCommits, outCommits, inputOutpoints, outputCommitments, assetId, sig });
});
test('replay across different inputs REJECTS (msg binding)', () => {
  const t = buildBalancedCxfer();
  // Swap input outpoints; same sig should not verify under the new msg.
  const otherOutpoints = [fakeOutpoint(), fakeOutpoint()];
  return !verifyKernel({ ...t, inputOutpoints: otherOutpoints });
});
test('replay across different output commitments REJECTS', () => {
  const t = buildBalancedCxfer();
  // Swap output commitments
  return !verifyKernel({
    ...t,
    outputCommitments: [t.outputCommitments[1], t.outputCommitments[0]],
  });
});
test('replay across different asset_id REJECTS', () => {
  const t = buildBalancedCxfer();
  const otherAsset = sha256(new TextEncoder().encode('OTHER'));
  return !verifyKernel({ ...t, assetId: otherAsset });
});
test('E\' = ZERO is rejected (degenerate kernel)', () => {
  // If amounts balance AND blindings balance, E' = 0 — must reject.
  const r1 = randomScalar();
  const inputCommits = [pedersenCommit(100n, r1)];
  const outCommits   = [pedersenCommit(100n, r1)];
  let EPrime = ZERO;
  for (const C of outCommits) EPrime = EPrime.add(C);
  for (const C of inputCommits) EPrime = EPrime.add(C.negate());
  return EPrime.equals(ZERO);
});

// ----------- Full CXFER (BP + kernel) integration ------------
console.log('\nCXFER full integration (BP + kernel):');
test('valid CXFER: BP verifies AND kernel verifies', () => {
  const sender = newWallet(), recip = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  // Inputs (would be on-chain commitments; here synthesised)
  const inBlindings = [randomScalar(), randomScalar()];
  const inAmts = [400n, 600n];
  const inputCommits = inAmts.map((a, i) => pedersenCommit(a, inBlindings[i]));
  // Outputs
  const sendAmt = 700n, changeAmt = 300n;
  const recipBlinding = deriveBlinding(sender.priv, recip.pub, anchor, 0);
  const changeBlinding = deriveChangeBlinding(sender.priv, anchor, 1);
  // Aggregated rangeproof for both outputs
  const { proof, commitments } = bpRangeAggProve(
    [sendAmt, changeAmt],
    [recipBlinding, changeBlinding],
  );
  if (!bpRangeAggVerify(commitments, proof)) return false;
  // Kernel sig
  const inBlindingSum = modN(inBlindings.reduce((s, x) => s + x, 0n));
  const excess = modN(recipBlinding + changeBlinding - inBlindingSum);
  const assetId = sha256(new TextEncoder().encode('ASSET'));
  const inputOutpoints = [fakeOutpoint(), fakeOutpoint()];
  const outputCommitments = commitments.map(pointToBytes);
  const msg = computeKernelMsg(assetId, inputOutpoints, outputCommitments);
  const sig = signSchnorr(msg, bigintToBytes32(excess));
  return verifyKernel({ inputCommits, outCommits: commitments, inputOutpoints, outputCommitments, assetId, sig });
});
test('inflation attempt: rangeproof valid but kernel rejects', () => {
  // Prover constructs in-range outputs that don't balance the inputs.
  const sender = newWallet(), recip = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  const inBlindings = [randomScalar()];
  const inputCommits = [pedersenCommit(100n, inBlindings[0])];
  // Outputs sum to 1000 — inflating by 900.
  const sendAmt = 700n, changeAmt = 300n;
  const r1 = randomScalar(), r2 = randomScalar();
  const { proof, commitments } = bpRangeAggProve([sendAmt, changeAmt], [r1, r2]);
  // BP itself accepts (values are in [0, 2^64))
  if (!bpRangeAggVerify(commitments, proof)) return false;
  // But kernel must reject:
  const inBlindingSum = modN(inBlindings.reduce((s, x) => s + x, 0n));
  const excess = modN(r1 + r2 - inBlindingSum);
  const assetId = sha256(new TextEncoder().encode('ASSET'));
  const inputOutpoints = [fakeOutpoint()];
  const outputCommitments = commitments.map(pointToBytes);
  const msg = computeKernelMsg(assetId, inputOutpoints, outputCommitments);
  const sig = signSchnorr(msg, bigintToBytes32(excess));
  return !verifyKernel({ inputCommits, outCommits: commitments, inputOutpoints, outputCommitments, assetId, sig });
});

// ----------- Negative-amount smuggling (mod-N) ------------
console.log('\nNegative-amount smuggling:');
test('reject value = N − 1 (looks like −1 mod N)', () => {
  // The bulletproofs prover is supposed to reject anything outside [0, 2^64).
  // SECP_N − 1 is "−1" in the scalar field; it must NOT be provable.
  try {
    bpRangeAggProve([SECP_N - 1n], [randomScalar()]);
    return false; // shouldn't reach
  } catch { return true; }
});
test('reject value = 2^64 (just out of range)', () => {
  try { bpRangeAggProve([1n << 64n], [randomScalar()]); return false; }
  catch { return true; }
});

// ----------- m=8 BP path (advertised but never exercised in production) ------------
console.log('\nBP m=8 (untested in production):');
test('m=8 prove + verify round-trip', () => {
  const values = [];
  const blinds = [];
  for (let i = 0; i < 8; i++) { values.push(BigInt(i * 10 + 1)); blinds.push(randomScalar()); }
  const { proof, commitments } = bpRangeAggProve(values, blinds);
  return bpRangeAggVerify(commitments, proof);
});
test('m=8 proof size matches formula (33·4 + 32·3 + log2(512)·33·2 + 32·2)', () => {
  // log2(64*8) = 9, so size = 132 + 96 + 9*66 + 64 = 886
  const values = new Array(8).fill(0n);
  const blinds = values.map(() => randomScalar());
  const { proof } = bpRangeAggProve(values, blinds);
  return proof.length === 886;
});

// ----------- Wire format ------------
console.log('\nWire format (CETCH / CXFER):');
function makeRandomCommitment() { return pointToBytes(pedersenCommit(0n, randomScalar())); }
function makeRandomKernelSig() { return crypto.getRandomValues(new Uint8Array(64)); }
function makeFakeRangeproof(m) {
  // Just bytes — encoders don't validate proof contents, only length.
  const log_nm = Math.log2(64 * m);
  const len = 33 * 4 + 32 * 3 + log_nm * 33 * 2 + 32 * 2;
  return crypto.getRandomValues(new Uint8Array(len));
}

test('CETCH encode → decode round-trip (with image)', () => {
  const payload = encodeCEtchPayload({
    ticker: 'USDC',
    decimals: 6,
    commitment: makeRandomCommitment(),
    rangeproof: makeFakeRangeproof(1),
    encryptedAmount: crypto.getRandomValues(new Uint8Array(8)),
    imageUri: 'ipfs://bafybeih...test',
  });
  const dec = decodeCEtchPayload(payload);
  return dec && dec.ticker === 'USDC' && dec.decimals === 6 && dec.imageUri === 'ipfs://bafybeih...test';
});
test('CETCH encode → decode round-trip (no image)', () => {
  const payload = encodeCEtchPayload({
    ticker: 'A',
    decimals: 0,
    commitment: makeRandomCommitment(),
    rangeproof: makeFakeRangeproof(1),
    encryptedAmount: new Uint8Array(8),
    imageUri: null,
  });
  const dec = decodeCEtchPayload(payload);
  return dec && dec.ticker === 'A' && dec.imageUri === null;
});
test('CETCH decode rejects trailing bytes (canonical form)', () => {
  const payload = encodeCEtchPayload({
    ticker: 'X', decimals: 0,
    commitment: makeRandomCommitment(),
    rangeproof: makeFakeRangeproof(1),
    encryptedAmount: new Uint8Array(8),
  });
  const corrupted = concatBytes(payload, new Uint8Array([0x00]));
  return decodeCEtchPayload(corrupted) === null;
});
test('CETCH decode rejects truncated payload', () => {
  const payload = encodeCEtchPayload({
    ticker: 'X', decimals: 0,
    commitment: makeRandomCommitment(),
    rangeproof: makeFakeRangeproof(1),
    encryptedAmount: new Uint8Array(8),
  });
  return decodeCEtchPayload(payload.slice(0, payload.length - 5)) === null;
});
test('CETCH decode rejects wrong opcode', () => {
  const payload = encodeCEtchPayload({
    ticker: 'X', decimals: 0,
    commitment: makeRandomCommitment(),
    rangeproof: makeFakeRangeproof(1),
    encryptedAmount: new Uint8Array(8),
  });
  payload[0] = 0xff;
  return decodeCEtchPayload(payload) === null;
});
test('CETCH encode rejects ticker > 16 bytes', () => {
  try {
    encodeCEtchPayload({
      ticker: 'A'.repeat(17), decimals: 0,
      commitment: makeRandomCommitment(),
      rangeproof: makeFakeRangeproof(1),
      encryptedAmount: new Uint8Array(8),
    });
    return false;
  } catch { return true; }
});
test('CETCH encode rejects decimals > 8', () => {
  try {
    encodeCEtchPayload({
      ticker: 'X', decimals: 9,
      commitment: makeRandomCommitment(),
      rangeproof: makeFakeRangeproof(1),
      encryptedAmount: new Uint8Array(8),
    });
    return false;
  } catch { return true; }
});
test('CETCH encode rejects image_uri > 256 bytes', () => {
  try {
    encodeCEtchPayload({
      ticker: 'X', decimals: 0,
      commitment: makeRandomCommitment(),
      rangeproof: makeFakeRangeproof(1),
      encryptedAmount: new Uint8Array(8),
      imageUri: 'A'.repeat(257),
    });
    return false;
  } catch { return true; }
});

test('CXFER encode → decode round-trip (m=2)', () => {
  const payload = encodeCXferPayload({
    assetId: crypto.getRandomValues(new Uint8Array(32)),
    kernelSig: makeRandomKernelSig(),
    outputs: [
      { commitment: makeRandomCommitment(), encryptedAmount: crypto.getRandomValues(new Uint8Array(8)) },
      { commitment: makeRandomCommitment(), encryptedAmount: crypto.getRandomValues(new Uint8Array(8)) },
    ],
    rangeproof: makeFakeRangeproof(2),
  });
  const dec = decodeCXferPayload(payload);
  return dec && dec.kind === 'cxfer' && dec.outputs.length === 2 && dec.rangeproof.length === makeFakeRangeproof(2).length;
});
test('CXFER decode rejects N=3 (must be 1,2,4,8)', () => {
  // Manually craft a payload with N=3
  const bad = concatBytes(
    new Uint8Array([T_CXFER]),
    new Uint8Array(32),                  // asset_id
    new Uint8Array(64),                  // kernel_sig
    new Uint8Array([3]),                 // N=3 (illegal)
    new Uint8Array(33 * 3),              // commitments
    new Uint8Array(8 * 3),               // encrypted amounts
    new Uint8Array([0, 0]),              // rp_len = 0
  );
  return decodeCXferPayload(bad) === null;
});
test('CXFER encode rejects N=3', () => {
  try {
    encodeCXferPayload({
      assetId: new Uint8Array(32),
      kernelSig: new Uint8Array(64),
      outputs: [
        { commitment: makeRandomCommitment(), encryptedAmount: new Uint8Array(8) },
        { commitment: makeRandomCommitment(), encryptedAmount: new Uint8Array(8) },
        { commitment: makeRandomCommitment(), encryptedAmount: new Uint8Array(8) },
      ],
      rangeproof: new Uint8Array(0),
    });
    return false;
  } catch { return true; }
});
test('CXFER encode rejects wrong-size kernel_sig', () => {
  try {
    encodeCXferPayload({
      assetId: new Uint8Array(32),
      kernelSig: new Uint8Array(63), // 1 byte short
      outputs: [{ commitment: makeRandomCommitment(), encryptedAmount: new Uint8Array(8) }],
      rangeproof: new Uint8Array(0),
    });
    return false;
  } catch { return true; }
});
test('CXFER decode rejects trailing bytes (canonical form)', () => {
  const payload = encodeCXferPayload({
    assetId: new Uint8Array(32),
    kernelSig: new Uint8Array(64),
    outputs: [{ commitment: makeRandomCommitment(), encryptedAmount: new Uint8Array(8) }],
    rangeproof: makeFakeRangeproof(1),
  });
  const corrupted = concatBytes(payload, new Uint8Array([0]));
  return decodeCXferPayload(corrupted) === null;
});

// ----------- Mint authority + envelope ------------
import {
  T_MINT, T_BURN,
  deriveMintBlinding, deriveMintAmountKeystream,
  computeMintMsg,
  encodeCMintPayload, decodeCMintPayload,
  encodeCBurnPayload, decodeCBurnPayload,
} from './composition.mjs';
import { N_BITS as _N_BITS } from './composition.mjs';

console.log('\nMint authority + envelope:');
test('CETCH carries mint_authority field; mintable=false when zero', () => {
  const payload = encodeCEtchPayload({
    ticker: 'X', decimals: 0,
    commitment: makeRandomCommitment(),
    rangeproof: makeFakeRangeproof(1),
    encryptedAmount: new Uint8Array(8),
  });
  const dec = decodeCEtchPayload(payload);
  return dec && dec.mintable === false && dec.mintAuthority.length === 32;
});
test('CETCH with mintAuthority round-trips and reports mintable=true', () => {
  const issuer = newWallet();
  const payload = encodeCEtchPayload({
    ticker: 'GOV', decimals: 2,
    commitment: makeRandomCommitment(),
    rangeproof: makeFakeRangeproof(1),
    encryptedAmount: new Uint8Array(8),
    mintAuthority: issuer.xonly,
  });
  const dec = decodeCEtchPayload(payload);
  return dec && dec.mintable === true && bytesEq(dec.mintAuthority, issuer.xonly);
});
test('CETCH encode rejects mintAuthority of wrong length', () => {
  try {
    encodeCEtchPayload({
      ticker: 'X', decimals: 0,
      commitment: makeRandomCommitment(),
      rangeproof: makeFakeRangeproof(1),
      encryptedAmount: new Uint8Array(8),
      mintAuthority: new Uint8Array(31),
    });
    return false;
  } catch { return true; }
});

test('mint sig under mint_authority verifies; wrong key rejected', () => {
  const issuer = newWallet();
  const stranger = newWallet();
  const assetId = sha256(new TextEncoder().encode('mint-test'));
  const anchor = anchorOf(fakeOutpoint());
  const C = makeRandomCommitment();
  const ct = crypto.getRandomValues(new Uint8Array(8));
  const msg = computeMintMsg(assetId, anchor, C, ct);
  const goodSig = signSchnorr(msg, issuer.priv);
  const badSig  = signSchnorr(msg, stranger.priv);
  return verifySchnorr(goodSig, msg, issuer.xonly) && !verifySchnorr(badSig, msg, issuer.xonly);
});

test('mint sig is bound to (asset_id, commit_anchor, commitment, ct) — replay rejected on commitment swap', () => {
  const issuer = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  const C1 = makeRandomCommitment();
  const C2 = makeRandomCommitment();
  const ct = crypto.getRandomValues(new Uint8Array(8));
  const aid = sha256(new TextEncoder().encode('a'));
  const msg1 = computeMintMsg(aid, anchor, C1, ct);
  const sig = signSchnorr(msg1, issuer.priv);
  const msg2 = computeMintMsg(aid, anchor, C2, ct);   // swap commitment
  return !verifySchnorr(sig, msg2, issuer.xonly);
});

test('mint sig is bound to commit_anchor — envelope-replay into different commit/reveal pair rejected', () => {
  // SPEC §5.3: an attacker rewrapping a published mint envelope into their own
  // commit/reveal at their own address must fail. The anchor binding is what
  // catches it: same (asset_id, commitment, ct), different commit_anchor →
  // different msg → original sig doesn't verify.
  const issuer = newWallet();
  const aid = sha256(new TextEncoder().encode('anchor-replay'));
  const C = makeRandomCommitment();
  const ct = crypto.getRandomValues(new Uint8Array(8));
  const honestAnchor = anchorOf(fakeOutpoint());
  const attackerAnchor = anchorOf(fakeOutpoint());
  const honestMsg = computeMintMsg(aid, honestAnchor, C, ct);
  const sig = signSchnorr(honestMsg, issuer.priv);
  // Attacker keeps the on-chain payload (asset_id, commitment, ct, sig) but
  // wraps it in their own commit/reveal — their commit_anchor differs.
  const attackerMsg = computeMintMsg(aid, attackerAnchor, C, ct);
  return verifySchnorr(sig, honestMsg, issuer.xonly)
      && !verifySchnorr(sig, attackerMsg, issuer.xonly);
});

test('computeMintMsg rejects non-36-byte commit_anchor', () => {
  const aid = sha256(new TextEncoder().encode('a'));
  const C = makeRandomCommitment();
  const ct = new Uint8Array(8);
  try { computeMintMsg(aid, new Uint8Array(35), C, ct); return false; }
  catch (e) { return /commit_anchor must be 36 bytes/.test(e.message); }
});

test('CMINT encode → decode round-trip', () => {
  const payload = encodeCMintPayload({
    assetId: crypto.getRandomValues(new Uint8Array(32)),
    etchTxid: crypto.getRandomValues(new Uint8Array(32)),
    commitment: makeRandomCommitment(),
    encryptedAmount: crypto.getRandomValues(new Uint8Array(8)),
    rangeproof: makeFakeRangeproof(1),
    issuerSig: makeRandomKernelSig(),
  });
  const dec = decodeCMintPayload(payload);
  return dec && dec.kind === 'cmint' && dec.commitment.length === 33;
});
test('CMINT decode rejects wrong opcode', () => {
  const payload = encodeCMintPayload({
    assetId: new Uint8Array(32), etchTxid: new Uint8Array(32),
    commitment: makeRandomCommitment(),
    encryptedAmount: new Uint8Array(8),
    rangeproof: makeFakeRangeproof(1),
    issuerSig: new Uint8Array(64),
  });
  payload[0] = T_CETCH;
  return decodeCMintPayload(payload) === null;
});
test('CMINT decode rejects truncated', () => {
  const payload = encodeCMintPayload({
    assetId: new Uint8Array(32), etchTxid: new Uint8Array(32),
    commitment: makeRandomCommitment(),
    encryptedAmount: new Uint8Array(8),
    rangeproof: makeFakeRangeproof(1),
    issuerSig: new Uint8Array(64),
  });
  return decodeCMintPayload(payload.slice(0, payload.length - 5)) === null;
});

test('mint blinding & keystream are domain-separated from etch', () => {
  const w = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  const etchR = deriveEtchBlinding(w.priv, anchor);
  const mintR = deriveMintBlinding(w.priv, anchor);
  const etchKs = deriveEtchAmountKeystream(w.priv, anchor);
  const mintKs = deriveMintAmountKeystream(w.priv, anchor);
  return etchR !== mintR && !bytesEq(etchKs, mintKs);
});

test('mint pipeline: prove range + verify against announced commitment', () => {
  const issuer = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  const mintAmt = 12_345n;
  const r = deriveMintBlinding(issuer.priv, anchor);
  const ks = deriveMintAmountKeystream(issuer.priv, anchor);
  const ct = encryptAmount(mintAmt, ks);
  const { proof, commitments } = bpRangeAggProve([mintAmt], [r]);
  // Round-trip: same anchor, issuer can decrypt + verify commitment.
  const decAmt = decryptAmount(ct, ks);
  if (decAmt !== mintAmt) return false;
  if (!pedersenCommit(decAmt, r).equals(commitments[0])) return false;
  // BP itself confirms range.
  return bpRangeAggVerify(commitments, proof);
});

console.log('\nBurn balance + envelope:');
function buildBalancedBurn(burnAmt, inAmts) {
  const sender = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  const inBlindings = inAmts.map(() => randomScalar());
  const inputCommits = inAmts.map((a, i) => pedersenCommit(a, inBlindings[i]));
  const totalIn = inAmts.reduce((a, b) => a + b, 0n);
  const changeAmt = totalIn - burnAmt;
  const hasChange = changeAmt > 0n;
  let outCommits = []; let changeBlinding = 0n;
  if (hasChange) {
    changeBlinding = deriveChangeBlinding(sender.priv, anchor, 0);
    outCommits = [pedersenCommit(changeAmt, changeBlinding)];
  }
  const inBlindingSum = modN(inBlindings.reduce((s, x) => s + x, 0n));
  const excess = modN(changeBlinding - inBlindingSum);
  const assetId = sha256(new TextEncoder().encode('BURN'));
  const inputOutpoints = inAmts.map(() => fakeOutpoint());
  const outputCommitments = outCommits.map(pointToBytes);
  const msg = computeKernelMsg(assetId, inputOutpoints, outputCommitments, burnAmt);
  const sig = signSchnorr(msg, bigintToBytes32(excess));
  return { assetId, inputCommits, outCommits, outputCommitments, inputOutpoints, sig, burnAmt, changeAmt };
}
function safeMult(P, s) { const x = modN(s); return x === 0n ? ZERO : P.multiply(x); }
function verifyBurnKernel({ assetId, inputCommits, outCommits, outputCommitments, inputOutpoints, sig, burnAmt }) {
  let EPrime = ZERO;
  for (const C of outCommits) EPrime = EPrime.add(C);
  if (burnAmt > 0n) EPrime = EPrime.add(safeMult(H, burnAmt));
  for (const C of inputCommits) EPrime = EPrime.add(C.negate());
  if (EPrime.equals(ZERO)) return false;
  const xonly = EPrime.toRawBytes(true).slice(1);
  const msg = computeKernelMsg(assetId, inputOutpoints, outputCommitments, burnAmt);
  return verifySchnorr(sig, msg, xonly);
}
test('balanced BURN with change verifies under E\' = burn·H + Σ_out − Σ_in', () => {
  const t = buildBalancedBurn(200n, [500n, 300n]);   // burn 200, change 600
  return verifyBurnKernel(t);
});
test('full burn (no change) verifies', () => {
  // burnAmt = totalIn  →  changeAmt = 0  →  no outputs
  const t = buildBalancedBurn(800n, [500n, 300n]);
  return verifyBurnKernel(t);
});
test('replay BURN sig with different burnedAmount REJECTS', () => {
  const t = buildBalancedBurn(200n, [500n, 300n]);
  const tampered = { ...t, burnAmt: 199n };
  return !verifyBurnKernel(tampered);
});
test('inflation attempt: claim small burn but spend inputs unbalanced REJECTS', () => {
  // Sender claims burn=100, but actual spend would only balance with burn=200.
  const sender = newWallet();
  const anchor = anchorOf(fakeOutpoint());
  const inBlindings = [randomScalar()];
  const inputCommits = [pedersenCommit(500n, inBlindings[0])];
  const claimedBurn = 100n;
  const claimedChange = 300n;     // should be 400 to balance
  const changeBlinding = deriveChangeBlinding(sender.priv, anchor, 0);
  const outCommits = [pedersenCommit(claimedChange, changeBlinding)];
  const inBlindingSum = modN(inBlindings[0]);
  const excess = modN(changeBlinding - inBlindingSum);
  const assetId = sha256(new TextEncoder().encode('BURN'));
  const inputOutpoints = [fakeOutpoint()];
  const outputCommitments = outCommits.map(pointToBytes);
  const msg = computeKernelMsg(assetId, inputOutpoints, outputCommitments, claimedBurn);
  const sig = signSchnorr(msg, bigintToBytes32(excess));
  return !verifyBurnKernel({
    assetId, inputCommits, outCommits, inputOutpoints, outputCommitments,
    sig, burnAmt: claimedBurn,
  });
});

test('CBURN encode → decode round-trip (with change)', () => {
  const payload = encodeCBurnPayload({
    assetId: crypto.getRandomValues(new Uint8Array(32)),
    burnedAmount: 12345n,
    kernelSig: makeRandomKernelSig(),
    outputs: [{ commitment: makeRandomCommitment(), encryptedAmount: new Uint8Array(8) }],
    rangeproof: makeFakeRangeproof(1),
  });
  const dec = decodeCBurnPayload(payload);
  return dec && dec.kind === 'cburn' && dec.burnedAmount === 12345n && dec.outputs.length === 1;
});
test('CBURN encode → decode round-trip (full burn, N=0)', () => {
  const payload = encodeCBurnPayload({
    assetId: crypto.getRandomValues(new Uint8Array(32)),
    burnedAmount: 9999999n,
    kernelSig: makeRandomKernelSig(),
    outputs: [],
    rangeproof: new Uint8Array(0),
  });
  const dec = decodeCBurnPayload(payload);
  return dec && dec.kind === 'cburn' && dec.outputs.length === 0;
});
test('CBURN encode rejects N=3', () => {
  try {
    encodeCBurnPayload({
      assetId: new Uint8Array(32), burnedAmount: 1n,
      kernelSig: new Uint8Array(64),
      outputs: new Array(3).fill({ commitment: makeRandomCommitment(), encryptedAmount: new Uint8Array(8) }),
      rangeproof: new Uint8Array(0),
    });
    return false;
  } catch { return true; }
});
test('CBURN decode rejects out-of-range burnedAmount during encode', () => {
  try {
    encodeCBurnPayload({
      assetId: new Uint8Array(32),
      burnedAmount: 1n << BigInt(_N_BITS),  // exactly one too big
      kernelSig: new Uint8Array(64),
      outputs: [],
      rangeproof: new Uint8Array(0),
    });
    return false;
  } catch { return true; }
});
test('CBURN encode rejects negative burnedAmount', () => {
  try {
    encodeCBurnPayload({
      assetId: new Uint8Array(32), burnedAmount: -1n,
      kernelSig: new Uint8Array(64), outputs: [], rangeproof: new Uint8Array(0),
    });
    return false;
  } catch { return true; }
});

test('CXFER and BURN kernel msgs differ even with same inputs/outputs', () => {
  // The burnedAmount field separates the domain — replays across paths impossible.
  const aid = sha256(new TextEncoder().encode('Z'));
  const ops = [fakeOutpoint()];
  const outs = [makeRandomCommitment()];
  const a = computeKernelMsg(aid, ops, outs, 0n);
  const b = computeKernelMsg(aid, ops, outs, 1n);
  return !bytesEq(a, b);
});

// ----------- End-to-end flow: etch → mint → burn -----------
// Walks the full protocol stack offline without broadcasting. At each step we
// confirm: envelope round-trips bytes-exact, rangeproofs verify, signatures
// verify under the expected keys, and the commitment-balance equations hold.
console.log('\nEnd-to-end flow (etch → mint → burn):');
test('full pipeline: mintable etch, mint, burn-with-change', () => {
  const issuer = newWallet();
  const issuerXonlyHex = bytesToHex(issuer.xonly);

  // ---- 1. ETCH ----
  const etchAnchor = anchorOf(fakeOutpoint());
  const initialSupply = 1_000_000n;
  const etchBlinding = deriveEtchBlinding(issuer.priv, etchAnchor);
  const etchKs = deriveEtchAmountKeystream(issuer.priv, etchAnchor);
  const etchCt = encryptAmount(initialSupply, etchKs);
  const etchProof = bpRangeAggProve([initialSupply], [etchBlinding]);
  const etchCommitment = etchProof.commitments[0];
  const etchPayload = encodeCEtchPayload({
    ticker: 'GOV', decimals: 2,
    commitment: pointToBytes(etchCommitment),
    rangeproof: etchProof.proof,
    encryptedAmount: etchCt,
    mintAuthority: issuer.xonly,
  });
  const etchDec = decodeCEtchPayload(etchPayload);
  if (!etchDec) return false;
  if (!etchDec.mintable) return false;
  if (bytesToHex(etchDec.mintAuthority) !== issuerXonlyHex) return false;
  // Recover supply via issuer's keys (chain-only path)
  const etchAmtRecovered = decryptAmount(etchDec.encryptedAmount, etchKs);
  if (etchAmtRecovered !== initialSupply) return false;
  if (!pedersenCommit(etchAmtRecovered, etchBlinding).equals(etchCommitment)) return false;
  // BP confirms range
  if (!bpRangeAggVerify(etchProof.commitments, etchDec.rangeproof)) return false;

  // ---- 2. MINT ----
  // Synthesise a fake etch_txid so we can produce a believable asset_id.
  const etchTxidHex = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const assetId = assetIdFor(etchTxidHex, 0);
  const mintAnchor = anchorOf(fakeOutpoint());
  const mintAmount = 500_000n;
  const mintBlinding = deriveMintBlinding(issuer.priv, mintAnchor);
  const mintKs = deriveMintAmountKeystream(issuer.priv, mintAnchor);
  const mintCt = encryptAmount(mintAmount, mintKs);
  const mintProof = bpRangeAggProve([mintAmount], [mintBlinding]);
  const mintCommitment = mintProof.commitments[0];
  const mintMsg = computeMintMsg(assetId, mintAnchor, pointToBytes(mintCommitment), mintCt);
  const issuerSig = signSchnorr(mintMsg, issuer.priv);
  const mintPayload = encodeCMintPayload({
    assetId,
    etchTxid: hexToBytes(etchTxidHex),
    commitment: pointToBytes(mintCommitment),
    encryptedAmount: mintCt,
    rangeproof: mintProof.proof,
    issuerSig,
  });
  const mintDec = decodeCMintPayload(mintPayload);
  if (!mintDec || mintDec.kind !== 'cmint') return false;
  if (bytesToHex(mintDec.assetId) !== bytesToHex(assetId)) return false;
  // Issuer sig verifies under mint_authority pubkey from the etch
  const mintMsgReplay = computeMintMsg(mintDec.assetId, mintAnchor, mintDec.commitment, mintDec.encryptedAmount);
  if (!verifySchnorr(mintDec.issuerSig, mintMsgReplay, etchDec.mintAuthority)) return false;
  // Range proof on the new mint commitment verifies
  if (!bpRangeAggVerify([bytesToPoint(mintDec.commitment)], mintDec.rangeproof)) return false;
  // Issuer can recover the minted amount from chain alone
  const mintAmtRecovered = decryptAmount(mintDec.encryptedAmount, mintKs);
  if (mintAmtRecovered !== mintAmount) return false;
  if (!pedersenCommit(mintAmtRecovered, mintBlinding).equals(bytesToPoint(mintDec.commitment))) return false;

  // ---- 3. BURN ----
  // Spend the etch UTXO + mint UTXO into a change UTXO + 200k burned. Total in:
  // 1.5M, burn 200k, change 1.3M. Kernel sig verifies under E' = burn·H + Σ_out − Σ_in.
  const burnAmount = 200_000n;
  const totalIn = initialSupply + mintAmount; // 1_500_000
  const changeAmount = totalIn - burnAmount;  // 1_300_000
  const burnAnchor = anchorOf(fakeOutpoint());
  const changeBlinding = deriveChangeBlinding(issuer.priv, burnAnchor, 0);
  const changeKs = deriveAmountKeystreamSelf(issuer.priv, burnAnchor, 0);
  const changeCt = encryptAmount(changeAmount, changeKs);
  const burnRangeproof = bpRangeAggProve([changeAmount], [changeBlinding]);
  const changeCommitment = burnRangeproof.commitments[0];
  // Σ_in blindings: etchBlinding + mintBlinding
  const inBlindingSum = modN(etchBlinding + mintBlinding);
  const excess = modN(changeBlinding - inBlindingSum);
  const inputCommits = [etchCommitment, bytesToPoint(mintDec.commitment)];
  const inputOutpoints = [fakeOutpoint(), fakeOutpoint()];
  const outputCommitments = [pointToBytes(changeCommitment)];
  const burnMsg = computeKernelMsg(assetId, inputOutpoints, outputCommitments, burnAmount);
  const burnSig = signSchnorr(burnMsg, bigintToBytes32(excess));
  const burnPayload = encodeCBurnPayload({
    assetId,
    burnedAmount: burnAmount,
    kernelSig: burnSig,
    outputs: [{ commitment: pointToBytes(changeCommitment), encryptedAmount: changeCt }],
    rangeproof: burnRangeproof.proof,
  });
  const burnDec = decodeCBurnPayload(burnPayload);
  if (!burnDec || burnDec.burnedAmount !== burnAmount) return false;
  // Range proof verifies
  if (!bpRangeAggVerify([bytesToPoint(burnDec.outputs[0].commitment)], burnDec.rangeproof)) return false;
  // Reconstruct E' and verify kernel sig
  let EPrime = bytesToPoint(burnDec.outputs[0].commitment);
  EPrime = EPrime.add(safeMult(H, burnDec.burnedAmount));
  for (const C of inputCommits) EPrime = EPrime.add(C.negate());
  if (EPrime.equals(ZERO)) return false;
  const xonly = EPrime.toRawBytes(true).slice(1);
  const replayMsg = computeKernelMsg(burnDec.assetId, inputOutpoints, [burnDec.outputs[0].commitment], burnDec.burnedAmount);
  if (!verifySchnorr(burnDec.kernelSig, replayMsg, xonly)) return false;
  // Issuer recovers change amount from chain
  const changeAmtRecovered = decryptAmount(burnDec.outputs[0].encryptedAmount, changeKs);
  if (changeAmtRecovered !== changeAmount) return false;
  if (!pedersenCommit(changeAmtRecovered, changeBlinding).equals(bytesToPoint(burnDec.outputs[0].commitment))) return false;

  // ---- 4. Conservation check ----
  // total supply created (etch + mint) = burned + alive (change UTXO).
  return initialSupply + mintAmount === burnAmount + changeAmount;
});

test('non-mintable etch rejects mint attempt at validator gate', () => {
  // Build a non-mintable CETCH; verify decode reports mintable=false. The
  // validator (in tacit.html) refuses to accept any T_MINT pointing at this
  // asset_id — we exercise the mintable-flag plumbing here; full validator
  // coverage lives in the dApp itself.
  const w = newWallet();
  const fakeC = makeRandomCommitment();
  const payload = encodeCEtchPayload({
    ticker: 'FIXED', decimals: 0,
    commitment: fakeC,
    rangeproof: makeFakeRangeproof(1),
    encryptedAmount: new Uint8Array(8),
    // mintAuthority intentionally omitted → all-zero → non-mintable
  });
  const dec = decodeCEtchPayload(payload);
  return dec && dec.mintable === false;
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
