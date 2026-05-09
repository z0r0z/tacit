// PRF-based passkey wallet — WebAuthn PRF extension derives a deterministic
// 32-byte secp256k1 private key from the user's biometric. Same passkey +
// same RP salt = same key every session. The PRF output is mapped through
// `prfBytesToScalar` so a (vanishingly rare) raw value of 0 or ≥ N can't
// wedge the user with an unrecoverable credential.

import { secp, sha256, bytesToHex } from './vendor/tacit-deps.min.js';

const enc = new TextEncoder();
const PRF_SALT = sha256(enc.encode('tacit-prf-v1'));
const PRF_MAP_KEY = 'tacit-prf-v1';
// secp256k1 group order N. Defined locally so this module stays
// self-contained — the value is a curve constant, not a tacit choice.
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

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

// Map a 32-byte PRF output deterministically into [1, N-1]. The probability
// the raw bytes are already valid is ~1 - 2⁻¹²⁸, so this is a no-op in every
// realistic case. The fallback rehash + recovery domain string keeps the
// mapping deterministic without ever returning out-of-range scalars — same
// passkey will always reproduce the same priv. Without this guard a user
// drawing the pathological output is wedged forever (PRF input is constant).
//
// Exported so tests/prf-wallet.test.mjs can pin the boundary branches
// (0, N-1, N, N+1) — the load-bearing cases for the deterministic guard.
export function prfBytesToScalar(raw32) {
  let n = 0n;
  for (const b of raw32) n = (n << 8n) | BigInt(b);
  if (n === 0n || n >= SECP_N) {
    const fallback = sha256(new Uint8Array([...raw32, ...enc.encode('tacit-prf-recovery')]));
    return prfBytesToScalar(fallback); // P[recurse twice] ≈ 2⁻²⁵⁶
  }
  return raw32;
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
  // user.id MUST be opaque per WebAuthn — deriving it from the label means
  // two registrations with the same label collide on user.id and the second
  // overwrites the first per spec. Use random bytes; the label is purely a
  // human-readable display name.
  const userId = crypto.getRandomValues(new Uint8Array(16));
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
  const priv = prfBytesToScalar(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
  const pub = secp.getPublicKey(priv, true);
  return { credentialId, priv, pub, pubHex: bytesToHex(pub) };
}

// WebAuthn requires a secure context (HTTPS or localhost).
export function isPasskeyAvailable() {
  return window.isSecureContext && !!window.PublicKeyCredential;
}

// Returns the saved passkey entry preferred for auto-login, or null.
// Prefers the most recently used label (highest `lastUsed`); falls back
// to insertion order so legacy entries without `lastUsed` still resolve.
export function prfTryRestore() {
  const map = loadPrfMap();
  const labels = Object.keys(map);
  if (!labels.length) return null;
  labels.sort((a, b) => (map[b].lastUsed || 0) - (map[a].lastUsed || 0));
  const lbl = labels[0];
  const entry = map[lbl];
  return { label: lbl, credentialId: entry.credentialId, pubkey: entry.pubkey };
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
        // Omit `transports`: it's a hint that filters which authenticators the
        // browser queries. Hardcoding ['internal'] hides credentials stored in
        // password managers (Bitwarden, 1Password) and roaming authenticators,
        // because their providers don't report the 'internal' transport — the
        // user gets a successful registration but no login prompt ever appears.
        allowCredentials: [{ type: 'public-key', id: rawId }],
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
  const priv = prfBytesToScalar(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
  const pub = secp.getPublicKey(priv, true);
  return { credentialId: gotId, priv, pub, pubHex: bytesToHex(pub) };
}
