
import { secp, sha256, bytesToHex } from './vendor/tacit-deps.min.js';

const enc = new TextEncoder();
const PRF_SALT = sha256(enc.encode('tacit-prf-v1'));
const PRF_MAP_KEY = 'tacit-prf-v1';
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

export function prfBytesToScalar(raw32) {
  let n = 0n;
  for (const b of raw32) n = (n << 8n) | BigInt(b);
  if (n === 0n || n >= SECP_N) {
    const fallback = sha256(new Uint8Array([...raw32, ...enc.encode('tacit-prf-recovery')]));
    return prfBytesToScalar(fallback);
  }
  return raw32;
}

export function loadPrfMap() {
  try { return JSON.parse(localStorage.getItem(PRF_MAP_KEY) || '{}'); } catch { return {}; }
}
export function savePrfMap(m) {
  try { localStorage.setItem(PRF_MAP_KEY, JSON.stringify(m)); return true; } catch { return false; }
}
export function clearPrfMap() { localStorage.removeItem(PRF_MAP_KEY); }

export async function prfRegister(label) {
  const name = (label || '').trim();
  if (!name) throw new Error('label required');
  const rpId = window.location.hostname;
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
  const raw = prfOut?.results?.first || (prfOut?.enabled === false ? null : (await prfEval(credentialId)).raw);
  if (!raw) throw new Error('PRF not supported by this authenticator');
  return keyOf(credentialId, raw);
}

function keyOf(credentialId, raw) {
  const priv = prfBytesToScalar(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
  const pub = secp.getPublicKey(priv, true);
  return { credentialId, priv, pub, pubHex: bytesToHex(pub) };
}

export function isPasskeyAvailable() {
  return window.isSecureContext && !!window.PublicKeyCredential;
}

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
  const { gotId, raw } = await prfEval(credentialId);
  if (!raw) throw new Error('PRF result not returned');
  return keyOf(gotId, raw);
}

async function prfEval(credentialId) {
  const rpId = window.location.hostname;
  const rawId = credentialId ? fromB64(credentialId) : undefined;
  const prfExtension = { prf: { eval: { first: PRF_SALT } } };
  const publicKey = rawId
    ? {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId,
        userVerification: 'required',
        timeout: 60000,
        allowCredentials: [{ type: 'public-key', id: rawId }],
        extensions: prfExtension,
      }
    : {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId,
        userVerification: 'required',
        timeout: 60000,
        allowCredentials: [],
        extensions: prfExtension,
      };
  const cred = await navigator.credentials.get({ publicKey, mediation: 'optional' });
  if (!cred) throw new Error('no passkey selected');
  const gotId = toB64(cred.rawId);
  const prfExt = cred.getClientExtensionResults()?.prf || {};
  let results = prfExt.results;
  if (!results && prfExt.resultsByCredential) {
    results = (credentialId && prfExt.resultsByCredential[credentialId]) || prfExt.resultsByCredential[gotId];
  }
  return { gotId, raw: results?.first || null };
}
