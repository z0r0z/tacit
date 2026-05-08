// PRF-based passkey wallet — WebAuthn PRF extension derives a deterministic
// 32-byte secp256k1 private key from the user's biometric. The same passkey +
// same RP salt = same key every session. No additional derivation (HMAC, etc.)
// — the PRF output IS the private key. The caller wraps it in a random session
// password + PBKDF2+AES-GCM blob for drop-in compatibility with all signing
// paths (ECDSA, Schnorr, blinding derivation, etc.) — zero special-case code.

import { secp, sha256, bytesToHex } from './vendor/tacit-deps.min.js';

const enc = new TextEncoder();
const PRF_SALT = sha256(enc.encode('tacit-prf-v1'));
const PRF_MAP_KEY = 'tacit-prf-v1';

function toB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function fromB64(s) {
  s = s.replaceAll('-', '+').replaceAll('_', '/');
  if (s.length % 4) s += '='.repeat(4 - s.length % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function loadPrfMap() {
  try { return JSON.parse(localStorage.getItem(PRF_MAP_KEY) || '{}'); } catch { return {}; }
}
export function savePrfMap(m) { localStorage.setItem(PRF_MAP_KEY, JSON.stringify(m)); }
export function clearPrfMap() { localStorage.removeItem(PRF_MAP_KEY); }

export async function prfRegister(label) {
  const name = (label || '').trim();
  if (!name) throw new Error('label required');
  const rpId = window.location.hostname;
  const userId = sha256(enc.encode(name)).slice(0, 16);
  const publicKey = {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { name: 'Tacit', id: rpId },
    user: { id: userId, name, displayName: name },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
    timeout: 60000,
    attestation: 'none',
    extensions: { prf: { eval: { first: PRF_SALT } } },
  };
  const cred = await navigator.credentials.create({ publicKey });
  if (!cred) throw new Error('creation cancelled');
  const credentialId = toB64(cred.rawId);
  const prfOut = cred.getClientExtensionResults()?.prf;
  if (!prfOut?.results?.first) throw new Error('PRF not supported by this authenticator');
  const raw = prfOut.results.first;
  const priv = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const pub = secp.getPublicKey(priv, true);
  return { credentialId, priv, pub, pubHex: bytesToHex(pub) };
}

// WebAuthn requires a secure context (HTTPS or localhost).
export function isPasskeyAvailable() {
  return window.isSecureContext && !!window.PublicKeyCredential;
}

// Returns the first saved passkey entry from the label map, or null.
// Used by init() for silent auto-login on page reload.
export function prfTryRestore() {
  const map = loadPrfMap();
  const labels = Object.keys(map);
  if (!labels.length) return null;
  const entry = map[labels[0]];
  return { label: labels[0], credentialId: entry.credentialId, pubkey: entry.pubkey, address: entry.address };
}

export async function prfLogin({ credentialId }) {
  const rpId = window.location.hostname;
  const rawId = credentialId ? fromB64(credentialId) : undefined;
  const publicKey = rawId
    ? {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId,
        userVerification: 'required',
        timeout: 60000,
        allowCredentials: [{ type: 'public-key', id: rawId, transports: ['internal'] }],
        extensions: { prf: { evalByCredential: { [credentialId]: { first: PRF_SALT } } } },
      }
    : {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId,
        userVerification: 'required',
        timeout: 60000,
        allowCredentials: [],
        extensions: { prf: { eval: { first: PRF_SALT } } },
      };
  const cred = await navigator.credentials.get({ publicKey, mediation: 'optional' });
  if (!cred) throw new Error('no passkey selected');
  const gotId = toB64(cred.rawId);
  const prfExt = cred.getClientExtensionResults()?.prf || {};
  let results = prfExt.results;
  if (!results && prfExt.resultsByCredential && credentialId) results = prfExt.resultsByCredential[credentialId];
  if (!results?.first) throw new Error('PRF result not returned');
  const raw = results.first;
  const priv = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const pub = secp.getPublicKey(priv, true);
  return { credentialId: gotId, priv, pub, pubHex: bytesToHex(pub) };
}
