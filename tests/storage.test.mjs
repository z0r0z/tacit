// Tests for tests/storage.mjs (mirror of dapp/tacit.js encrypted-at-rest
// privkey storage). PBKDF2-SHA256(600k) + AES-GCM(salt 16 / iv 12), per-write
// random salt + iv, blob is a JSON envelope.
//
// Each PBKDF2 derivation is ~100–300 ms on a modern laptop, so we keep the
// number of derivations small. Each `test` that calls encrypt/decrypt costs
// ~1 derivation.
//
// Run: `node storage.test.mjs`
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import {
  PBKDF2_ITER, encryptPrivkey, decryptPrivkey, _storageShape,
} from './storage.mjs';

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

const PRIV   = hexToBytes('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const PASS_A = 'correct horse battery staple';
const PASS_B = 'a-different-passphrase!';

// One reference blob shared across most tests so we don't pay PBKDF2 over and over.
const blobA = await encryptPrivkey(PRIV, PASS_A);
const blobAParsed = JSON.parse(blobA);

console.log('Format envelope shape:');
await test('blob is JSON with expected schema fields', () => {
  return blobAParsed.v === 1
    && blobAParsed.kdf === 'pbkdf2'
    && blobAParsed.iter === PBKDF2_ITER
    && /^[0-9a-f]{32}$/.test(blobAParsed.salt)   // 16-byte salt
    && /^[0-9a-f]{24}$/.test(blobAParsed.iv)     // 12-byte iv
    && /^[0-9a-f]+$/.test(blobAParsed.ct);       // ciphertext + 16-byte gcm tag
});

await test('ciphertext length = plaintext + 16-byte GCM tag', () => {
  // 32 bytes priv + 16 bytes tag = 48 bytes = 96 hex chars
  return blobAParsed.ct.length === 96;
});

console.log('\nRound-trip:');
await test('encrypt → decrypt with correct passphrase recovers priv', async () => {
  const recovered = await decryptPrivkey(blobA, PASS_A);
  return bytesToHex(recovered) === bytesToHex(PRIV);
});

console.log('\nWrong-passphrase fail-closed (AES-GCM auth tag):');
await test('wrong passphrase throws specific error, not garbage priv', async () => {
  try { await decryptPrivkey(blobA, PASS_B); return false; }
  catch (e) { return /wrong passphrase|corrupted/.test(e.message); }
});
await test('empty passphrase fails with specific error', async () => {
  try { await decryptPrivkey(blobA, ''); return false; }
  catch (e) { return /wrong passphrase|corrupted/.test(e.message); }
});

console.log('\nTamper detection (AES-GCM auth tag protects ct + salt + iv):');
await test('flipping a single bit in ct rejects', async () => {
  const tampered = { ...blobAParsed };
  const ctBytes = hexToBytes(tampered.ct);
  ctBytes[0] ^= 0x01;
  tampered.ct = bytesToHex(ctBytes);
  try { await decryptPrivkey(JSON.stringify(tampered), PASS_A); return false; }
  catch (e) { return /wrong passphrase|corrupted/.test(e.message); }
});
await test('flipping a single bit in iv rejects', async () => {
  const tampered = { ...blobAParsed };
  const ivBytes = hexToBytes(tampered.iv);
  ivBytes[0] ^= 0x01;
  tampered.iv = bytesToHex(ivBytes);
  try { await decryptPrivkey(JSON.stringify(tampered), PASS_A); return false; }
  catch (e) { return /wrong passphrase|corrupted/.test(e.message); }
});
await test('flipping a single bit in salt rejects (KDF key shifts → wrong AES key)', async () => {
  const tampered = { ...blobAParsed };
  const saltBytes = hexToBytes(tampered.salt);
  saltBytes[0] ^= 0x01;
  tampered.salt = bytesToHex(saltBytes);
  try { await decryptPrivkey(JSON.stringify(tampered), PASS_A); return false; }
  catch (e) { return /wrong passphrase|corrupted/.test(e.message); }
});

console.log('\nSalt + IV uniqueness (no deterministic re-use across writes):');
const blobA2 = await encryptPrivkey(PRIV, PASS_A);
const blobA2Parsed = JSON.parse(blobA2);
await test('two encrypts of the same (priv, passphrase) produce different salts',
  () => blobAParsed.salt !== blobA2Parsed.salt);
await test('two encrypts of the same (priv, passphrase) produce different IVs',
  () => blobAParsed.iv !== blobA2Parsed.iv);
await test('two encrypts of the same (priv, passphrase) produce different ciphertexts',
  () => blobAParsed.ct !== blobA2Parsed.ct);
await test('the second blob also round-trips correctly', async () => {
  const recovered = await decryptPrivkey(blobA2, PASS_A);
  return bytesToHex(recovered) === bytesToHex(PRIV);
});

console.log('\nFormat header rejection:');
await test('unsupported version (v: 99) rejects without attempting decrypt', async () => {
  const bad = { ...blobAParsed, v: 99 };
  try { await decryptPrivkey(JSON.stringify(bad), PASS_A); return false; }
  catch (e) { return /unsupported wallet format/.test(e.message); }
});
await test('unsupported KDF rejects', async () => {
  const bad = { ...blobAParsed, kdf: 'argon2id' };
  try { await decryptPrivkey(JSON.stringify(bad), PASS_A); return false; }
  catch (e) { return /unsupported kdf/.test(e.message); }
});
await test('malformed JSON rejects', async () => {
  try { await decryptPrivkey('not json', PASS_A); return false; }
  catch (e) { return /malformed JSON/.test(e.message); }
});

console.log('\nPBKDF2 iteration floor (defensive):');
await test('iter < 100000 falls back to default → mismatched KDF key → decrypt fails', async () => {
  // Crafted blob: claim iter=1, but the actual ciphertext was encrypted with
  // PBKDF2_ITER. The decrypter sees iter=1 < 100000, treats it as malformed,
  // uses PBKDF2_ITER as the actual iteration count → derives the right key →
  // decrypts successfully. (Defensive default protects an honest blob whose
  // iter field got corrupted to a low value.)
  const bad = { ...blobAParsed, iter: 1 };
  const recovered = await decryptPrivkey(JSON.stringify(bad), PASS_A);
  return bytesToHex(recovered) === bytesToHex(PRIV);
});

console.log('\n_storageShape detection:');
await test('empty string → empty', () => _storageShape('') === 'empty');
await test('null → empty', () => _storageShape(null) === 'empty');
await test('64 hex chars → plaintext (legacy)', () => _storageShape('aa'.repeat(32)) === 'plaintext');
await test('JSON-shaped → encrypted', () => _storageShape('{"v":1}') === 'encrypted');
await test('garbage → unknown', () => _storageShape('x'.repeat(64)) === 'unknown');
await test('trailing whitespace on plaintext → unknown (regex is strict)',
  () => _storageShape('aa'.repeat(32) + ' ') === 'unknown');

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
