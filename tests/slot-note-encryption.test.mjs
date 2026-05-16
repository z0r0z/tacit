// SPEC-CBTC-ZK-FUNGIBILITY-AMENDMENT §5.26 — slot-note encryption primitives.
//
// Standalone test of the ECDH + AES-GCM encrypted-note construction that
// powers recipient detection for T_SLOT_ROTATE (and eventually cBTC.tac
// deposit notes + T_SLOT_MERGE notes). Doesn't depend on dapp/tacit.js
// — exercises the wire-format primitives directly using @noble/secp256k1 +
// the platform's WebCrypto API.
//
// Why this lives standalone:
//   The dapp/tacit.js high-level encrypt/decrypt wrapper is appropriate for
//   in-dapp callers, but the cryptographic round-trip is best tested at the
//   primitive layer where we can pin byte-for-byte interop with any
//   third-party implementation. The reference impl here is what a wallet
//   author would consult to implement compatible note scanning.
//
// What this covers:
//   • ECDH round-trip: sender(eph_priv, recipient_view_pub) ↔ recipient(view_priv, eph_pub)
//   • AES-256-GCM correctness over the 73-byte plaintext
//   • Total note size = 33 (eph_pub) + 89 (89 = 73 plaintext + 16 GCM tag) = 122 bytes
//   • Tamper resistance: 1-byte mutation anywhere in the note breaks decryption
//   • Recipient mismatch: a different recipient's viewing key returns null (not garbage)
//   • Domain separation: the AES key derivation uses the v1 domain tag
//   • Determinism: same (eph_priv, recipient_view) produces the same ciphertext
//
// Run: `node slot-note-encryption.test.mjs`

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}
function group(t) { console.log(`\n${t}:`); }

// ============== Reference implementation (mirror of dapp/tacit.js §5.26) ==============

const SLOT_NOTE_VERSION_TAG = new TextEncoder().encode('tacit-slot-note-v1');
const SLOT_NOTE_KIND_ROTATE = 0x01;
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const bytes32ToBigint = b => BigInt('0x' + bytesToHex(b));
const bigintToBytes32 = n => {
  const v = ((n % SECP_N) + SECP_N) % SECP_N;
  const h = v.toString(16).padStart(64, '0');
  return hexToBytes(h);
};

// HKDF-derived viewing privkey from a wallet privkey. v1 domain tag.
function viewingPrivkeyFromWallet(walletPriv32) {
  const prk = hmac(sha256, SLOT_NOTE_VERSION_TAG, walletPriv32);
  const t1 = hmac(sha256, prk, concatBytes(new TextEncoder().encode('view'), new Uint8Array([0x01])));
  let bn = bytes32ToBigint(t1) % SECP_N;
  if (bn === 0n) bn = 1n;
  return bigintToBytes32(bn);
}

async function _slotNoteSymKey(sharedX32) {
  const keyMaterial = sha256(concatBytes(SLOT_NOTE_VERSION_TAG, sharedX32));
  const subtle = (typeof crypto !== 'undefined' && crypto.subtle)
    || (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle);
  return await subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Encrypt a 73-byte plaintext to a recipient's viewing pubkey.
// Plaintext layout: kind(1) || secret(32) || nullifier_preimage(32) || amount_LE(8)
async function encryptSlotNote({ ephPrivOverride = null, recipientViewingPub33, kind, secretBytes32, nullifierPreimageBytes32, amountSats }) {
  let ePriv;
  if (ephPrivOverride) {
    ePriv = ephPrivOverride;
  } else {
    const e = new Uint8Array(32); crypto.getRandomValues(e);
    let eBig = bytes32ToBigint(e) % SECP_N;
    if (eBig === 0n) eBig = 1n;
    ePriv = bigintToBytes32(eBig);
  }
  const eBig = bytes32ToBigint(ePriv);
  const ephemeralPub = secp.getPublicKey(ePriv, true);
  const V = secp.ProjectivePoint.fromHex(bytesToHex(recipientViewingPub33));
  const sharedPoint = V.multiply(eBig);
  const sharedX = sharedPoint.toRawBytes(true).slice(1);

  const amtLE = new Uint8Array(8);
  const v = new DataView(amtLE.buffer);
  const a = BigInt(amountSats);
  v.setUint32(0, Number(a & 0xffffffffn), true);
  v.setUint32(4, Number((a >> 32n) & 0xffffffffn), true);

  const plaintext = concatBytes(
    new Uint8Array([kind & 0xff]),
    secretBytes32, nullifierPreimageBytes32, amtLE,
  );
  const subtle = crypto.subtle || globalThis.crypto.subtle;
  const key = await _slotNoteSymKey(sharedX);
  const ctBuf = await subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, plaintext);
  const ciphertext = new Uint8Array(ctBuf);
  return concatBytes(ephemeralPub, ciphertext);
}

async function decryptSlotNote(noteBytes, viewingPriv32) {
  if (!(noteBytes instanceof Uint8Array) || noteBytes.length !== 122) return null;
  if (viewingPriv32.length !== 32) return null;
  const ephemeralPub = noteBytes.slice(0, 33);
  const ciphertext = noteBytes.slice(33);
  let sharedX;
  try {
    const E = secp.ProjectivePoint.fromHex(bytesToHex(ephemeralPub));
    const sharedPoint = E.multiply(bytes32ToBigint(viewingPriv32));
    sharedX = sharedPoint.toRawBytes(true).slice(1);
  } catch { return null; }
  let plaintext;
  try {
    const subtle = crypto.subtle || globalThis.crypto.subtle;
    const key = await _slotNoteSymKey(sharedX);
    const ptBuf = await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, ciphertext);
    plaintext = new Uint8Array(ptBuf);
  } catch { return null; }
  if (plaintext.length !== 73) return null;
  const amtView = new DataView(plaintext.buffer, plaintext.byteOffset + 65, 8);
  const amountSats = (BigInt(amtView.getUint32(4, true)) << 32n) | BigInt(amtView.getUint32(0, true));
  return {
    kind: plaintext[0],
    secretBytes: plaintext.slice(1, 33),
    nullifierPreimageBytes: plaintext.slice(33, 65),
    amountSats,
  };
}

// ============== fixtures ==============

const senderWalletPriv = sha256(new TextEncoder().encode('test-sender-wallet'));
const receiverWalletPriv = sha256(new TextEncoder().encode('test-receiver-wallet'));
const thirdPartyWalletPriv = sha256(new TextEncoder().encode('test-thirdparty-wallet'));

const senderViewingPriv = viewingPrivkeyFromWallet(senderWalletPriv);
const receiverViewingPriv = viewingPrivkeyFromWallet(receiverWalletPriv);
const thirdPartyViewingPriv = viewingPrivkeyFromWallet(thirdPartyWalletPriv);

const senderViewingPub = secp.getPublicKey(senderViewingPriv, true);
const receiverViewingPub = secp.getPublicKey(receiverViewingPriv, true);
const thirdPartyViewingPub = secp.getPublicKey(thirdPartyViewingPriv, true);

const noteSecret = sha256(new TextEncoder().encode('note-payload-secret'));
const noteNullPre = sha256(new TextEncoder().encode('note-payload-nu'));
const NOTE_AMOUNT = 100_000n;

// ============== group 1: viewing-key derivation ==============
group('HKDF-derived viewing keys');

ok('viewing privkey is 32 bytes', receiverViewingPriv.length === 32);
ok('viewing privkey is non-zero', bytes32ToBigint(receiverViewingPriv) !== 0n);
ok('viewing privkey < curve order', bytes32ToBigint(receiverViewingPriv) < SECP_N);
ok('different wallets → different viewing keys',
  bytesToHex(senderViewingPriv) !== bytesToHex(receiverViewingPriv));
ok('deterministic: same wallet → same viewing key',
  bytesToHex(viewingPrivkeyFromWallet(senderWalletPriv)) === bytesToHex(senderViewingPriv));
ok('viewing pubkey is 33-byte compressed',
  receiverViewingPub.length === 33 && (receiverViewingPub[0] === 0x02 || receiverViewingPub[0] === 0x03));

// ============== group 2: encrypt/decrypt round-trip ==============
group('Encrypt → decrypt round-trip');

const note = await encryptSlotNote({
  recipientViewingPub33: receiverViewingPub,
  kind: SLOT_NOTE_KIND_ROTATE,
  secretBytes32: noteSecret,
  nullifierPreimageBytes32: noteNullPre,
  amountSats: NOTE_AMOUNT,
});

ok('note is exactly 122 bytes', note.length === 122);
ok('first 33 bytes are a valid compressed point',
  (() => { try { secp.ProjectivePoint.fromHex(bytesToHex(note.slice(0, 33))); return true; } catch { return false; } })());

const decoded = await decryptSlotNote(note, receiverViewingPriv);
ok('recipient decrypts successfully', decoded !== null);
ok('decoded kind matches', decoded && decoded.kind === SLOT_NOTE_KIND_ROTATE);
ok('decoded secret matches', decoded && bytesToHex(decoded.secretBytes) === bytesToHex(noteSecret));
ok('decoded nullifier_preimage matches', decoded && bytesToHex(decoded.nullifierPreimageBytes) === bytesToHex(noteNullPre));
ok('decoded amount matches', decoded && decoded.amountSats === NOTE_AMOUNT);

// ============== group 3: recipient mismatch ==============
group('Recipient mismatch returns null (not garbage)');

const wrongDecoded = await decryptSlotNote(note, thirdPartyViewingPriv);
ok('third-party viewing key decrypt returns null', wrongDecoded === null);

const senderSelfDecoded = await decryptSlotNote(note, senderViewingPriv);
ok('sender\'s own viewing key cannot decrypt own note (no leak-back)', senderSelfDecoded === null);

// ============== group 4: tamper resistance ==============
group('Single-byte tampers break decryption');

// Tamper a byte in ephemeral_pubkey region (0..33)
{
  const t = new Uint8Array(note); t[10] ^= 0x01;
  const r = await decryptSlotNote(t, receiverViewingPriv);
  ok('tamper in ephemeral_pubkey region → null', r === null);
}
// Tamper a byte in ciphertext (33..122)
{
  const t = new Uint8Array(note); t[60] ^= 0x01;
  const r = await decryptSlotNote(t, receiverViewingPriv);
  ok('tamper in ciphertext middle → null (AEAD tag rejects)', r === null);
}
// Tamper the AEAD tag (last 16 bytes)
{
  const t = new Uint8Array(note); t[121] ^= 0x01;
  const r = await decryptSlotNote(t, receiverViewingPriv);
  ok('tamper in last AEAD tag byte → null', r === null);
}

// ============== group 5: determinism + freshness ==============
group('Determinism + ephemeral-key freshness');

// Pin a deterministic ephemeral key; encrypt twice; same output.
const fixedEphPriv = sha256(new TextEncoder().encode('fixed-ephemeral-for-determinism'));
const note1 = await encryptSlotNote({
  ephPrivOverride: fixedEphPriv,
  recipientViewingPub33: receiverViewingPub,
  kind: SLOT_NOTE_KIND_ROTATE,
  secretBytes32: noteSecret,
  nullifierPreimageBytes32: noteNullPre,
  amountSats: NOTE_AMOUNT,
});
const note2 = await encryptSlotNote({
  ephPrivOverride: fixedEphPriv,
  recipientViewingPub33: receiverViewingPub,
  kind: SLOT_NOTE_KIND_ROTATE,
  secretBytes32: noteSecret,
  nullifierPreimageBytes32: noteNullPre,
  amountSats: NOTE_AMOUNT,
});
ok('same ephemeral key → byte-identical note', bytesToHex(note1) === bytesToHex(note2));

// Fresh ephemeral key per encrypt produces distinct notes for the same plaintext.
const noteA = await encryptSlotNote({
  recipientViewingPub33: receiverViewingPub,
  kind: SLOT_NOTE_KIND_ROTATE,
  secretBytes32: noteSecret,
  nullifierPreimageBytes32: noteNullPre,
  amountSats: NOTE_AMOUNT,
});
const noteB = await encryptSlotNote({
  recipientViewingPub33: receiverViewingPub,
  kind: SLOT_NOTE_KIND_ROTATE,
  secretBytes32: noteSecret,
  nullifierPreimageBytes32: noteNullPre,
  amountSats: NOTE_AMOUNT,
});
ok('different ephemeral keys → different notes (per-note unlinkability)',
  bytesToHex(noteA) !== bytesToHex(noteB));

// Both still decrypt to the same plaintext.
const decA = await decryptSlotNote(noteA, receiverViewingPriv);
const decB = await decryptSlotNote(noteB, receiverViewingPriv);
ok('both distinct ciphertexts decrypt to the same plaintext',
  decA && decB
  && bytesToHex(decA.secretBytes) === bytesToHex(decB.secretBytes)
  && decA.amountSats === decB.amountSats);

// ============== group 6: amount-hint round-trips at boundary values ==============
group('Amount-hint u64 boundary values');

for (const amt of [1n, 100_000n, 1_000_000n, 21_000_000_00000000n, (1n << 63n) - 1n, (1n << 64n) - 1n]) {
  const n = await encryptSlotNote({
    recipientViewingPub33: receiverViewingPub,
    kind: SLOT_NOTE_KIND_ROTATE,
    secretBytes32: noteSecret,
    nullifierPreimageBytes32: noteNullPre,
    amountSats: amt,
  });
  const d = await decryptSlotNote(n, receiverViewingPriv);
  ok(`amount=${amt} round-trips`, d && d.amountSats === amt);
}

// ============== group 7: domain separation ==============
group('Domain separation (negative test)');

// A "v2" domain that an attacker might attempt to substitute. Different
// derived key → decryption fails. This is implicit AEAD behavior but worth
// pinning so a future code change to the domain tag is caught.
async function _wrongDomainSymKey(sharedX32) {
  const wrongDomain = new TextEncoder().encode('tacit-slot-note-v2-attacker');
  const keyMaterial = sha256(concatBytes(wrongDomain, sharedX32));
  const subtle = crypto.subtle || globalThis.crypto.subtle;
  return await subtle.importKey('raw', keyMaterial, { name: 'AES-GCM' }, false, ['decrypt']);
}
const ephemeralPub = note.slice(0, 33);
const ciphertext = note.slice(33);
const E = secp.ProjectivePoint.fromHex(bytesToHex(ephemeralPub));
const sharedPoint = E.multiply(bytes32ToBigint(receiverViewingPriv));
const sharedX = sharedPoint.toRawBytes(true).slice(1);
const wrongKey = await _wrongDomainSymKey(sharedX);
let wrongDomainAccepts = false;
try {
  await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, wrongKey, ciphertext);
  wrongDomainAccepts = true;
} catch { wrongDomainAccepts = false; }
ok('wrong domain tag → decryption fails', !wrongDomainAccepts);

// ============== summary ==============
console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
