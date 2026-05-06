// Mirror of dapp/tacit.js encrypted-at-rest privkey storage. PBKDF2-SHA256 at
// 600k iterations + AES-GCM with random salt(16) + iv(12) per write.
//
// This file is the test-side copy; the canonical impl lives in dapp/tacit.js.
// Tested in storage.test.mjs.
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const PBKDF2_ITER = 600000;
const STORAGE_FORMAT_VERSION = 1;

async function _deriveKDFKey(passphrase, salt, iterations) {
  const pwBytes = new TextEncoder().encode(passphrase);
  const baseKey = await crypto.subtle.importKey('raw', pwBytes, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey, 256,
  );
  return new Uint8Array(bits);
}

async function encryptPrivkey(privBytes, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const keyBytes = await _deriveKDFKey(passphrase, salt, PBKDF2_ITER);
  const aesKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, privBytes);
  return JSON.stringify({
    v: STORAGE_FORMAT_VERSION, kdf: 'pbkdf2', iter: PBKDF2_ITER,
    salt: bytesToHex(salt), iv: bytesToHex(iv),
    ct: bytesToHex(new Uint8Array(ct)),
  });
}

async function decryptPrivkey(blobJson, passphrase) {
  let blob;
  try { blob = JSON.parse(blobJson); } catch { throw new Error('storage blob is malformed JSON'); }
  if (blob.v !== STORAGE_FORMAT_VERSION) throw new Error(`unsupported wallet format v${blob.v}`);
  if (blob.kdf !== 'pbkdf2') throw new Error(`unsupported kdf: ${blob.kdf}`);
  const iter = Number.isInteger(blob.iter) && blob.iter >= 100000 ? blob.iter : PBKDF2_ITER;
  const salt = hexToBytes(blob.salt);
  const iv   = hexToBytes(blob.iv);
  const ct   = hexToBytes(blob.ct);
  const keyBytes = await _deriveKDFKey(passphrase, salt, iter);
  const aesKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  let ptBuf;
  try { ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct); }
  catch { throw new Error('wrong passphrase or corrupted wallet data'); }
  const priv = new Uint8Array(ptBuf);
  if (priv.length !== 32) throw new Error('decrypted blob is not a 32-byte privkey');
  return priv;
}

function _storageShape(raw) {
  if (!raw) return 'empty';
  if (/^[0-9a-f]{64}$/.test(raw)) return 'plaintext';
  if (raw.startsWith('{')) return 'encrypted';
  return 'unknown';
}

export {
  PBKDF2_ITER, STORAGE_FORMAT_VERSION,
  encryptPrivkey, decryptPrivkey, _storageShape,
};
