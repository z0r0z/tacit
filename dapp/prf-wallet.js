
import { secp, sha256, bytesToHex } from './vendor/tacit-deps.min.js';
import { keepRoot, keptRoot } from './tacit-chain-root.js';

const enc = new TextEncoder();
const PRF_SALT = sha256(enc.encode('tacit-prf-v1'));
// The Tacit chain's root is a passkey's output for another salt. The authenticator computes each output from a secret it never shows, so the
// Tacit key (a passkey wallet's output for the first salt, whose public key is in every Tacit address) says nothing about the root.
const CHAIN_SALT = sha256(enc.encode('tacit-chain-root-v1'));
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

// A PQ ID's TAC needs its passkey as well as the Tacit key, so a PQ ID is only made from a passkey that is backed up (synced by iCloud Keychain,
// Google Password Manager or a password manager): losing one device then loses nothing. The authenticator says so in every ceremony, in the backup
// state bit of its authenticator data. → true, false, or null when the browser does not show it
const backedUp = (data) => { try { const b = new Uint8Array(data); return b.length > 32 ? (b[32] & 0x10) !== 0 : null; } catch { return null; } };

// A passkey wallet's sign-in also asks its passkey for the chain's root (the second salt of the same ceremony: no other prompt) and keeps it on this
// device when the passkey is backed up, so the wallet's Tacit chain keys are its PQ ID from the start. The Tacit key is the first salt's output either
// way. An authenticator that mishandles the second salt marks this device ('tacit-pq-second' = 'no'), which then asks the first salt alone, as
// before: an error of its own, or no output, marks it and is asked again at once with the first salt alone; a cancel is not asked again, and marks
// the device only when it is the second in a row (a refusal can look like a cancel, a person closing the prompt once must not turn the device's PQ ID
// off), so such an authenticator costs at most two sign-ins. The page's own errors, a cancel by the page, a request already pending and a security
// error say nothing about the second salt and mark nothing. A ceremony that asked both salts and went well clears the count. A ceremony that made a
// passkey is never repeated. Off in a browser where localStorage 'tacit-pq-signin' is '0'.
const ls = (k) => { try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; } };
const lsSet = (k, v) => { try { const s = globalThis.localStorage; if (!s) return false; v == null ? s.removeItem(k) : s.setItem(k, v); return true; } catch { return false; } };
// (kept in this page's memory instead when its storage refuses writes)
const here = { no: false, cancels: 0 };
const pqAtSignIn = () => !here.no && ls('tacit-pq-signin') !== '0' && ls('tacit-pq-second') !== 'no';
const noSecondHere = () => { if (!lsSet('tacit-pq-second', 'no')) here.no = true; };
const AGAIN = new Set(['NotSupportedError', 'UnknownError', 'DataError', 'SyntaxError', 'ConstraintError', 'NotReadableError', 'EncodingError', 'OperationError']);
const refusedSecond = (e) => typeof DOMException === 'function' && e instanceof DOMException && AGAIN.has(e.name);
function failedTwoSalt(e) {
  if (refusedSecond(e)) return noSecondHere();
  if (e?.name !== 'NotAllowedError' || !(typeof DOMException === 'function' && e instanceof DOMException)) return;
  const kept = ls('tacit-pq-cancels'), n = (kept != null ? Number(kept) || 0 : here.cancels) + 1;
  if (!lsSet('tacit-pq-cancels', String(n))) here.cancels = n;
  if (n >= 2) noSecondHere();
}
const wentWell = () => { here.cancels = 0; lsSet('tacit-pq-cancels', null); };
async function withChainRoot(ask) {
  let r;
  try { r = await ask(CHAIN_SALT); } catch (e) {
    failedTwoSalt(e);
    if (!refusedSecond(e)) throw e;
    return ask(null);
  }
  if (r?.raw) { wentWell(); return r; }
  noSecondHere();
  return ask(null);
}

export async function prfRegister(label, { signal } = {}) {
  const r = await prfCreate(label, PRF_SALT, { signal, second: pqAtSignIn() ? CHAIN_SALT : null });
  return keyOf(r.credentialId, r.raw, r.backedUp === true ? r.second : null);
}

// The Tacit chain's root from a passkey: credentialId names one (null lets the person pick any of theirs). → { credentialId, root (32 bytes),
// backedUp }. The caller makes a PQ ID from it only when backedUp is true.
export async function prfChainRoot({ credentialId = null, signal } = {}) {
  const { gotId, raw, backedUp: b } = await prfEval(credentialId, { signal, salt: CHAIN_SALT });
  if (!raw) throw new Error('This passkey cannot make a key (it has no PRF).');
  return { credentialId: gotId, root: new Uint8Array(raw), backedUp: b };
}

// A new passkey made to hold the Tacit chain's root, for a wallet opened another way (an Ethereum or Bitcoin wallet, or a key kept here).
export async function prfRegisterChainRoot(label, { signal } = {}) {
  const { credentialId, raw, backedUp: b } = await prfCreate(label, CHAIN_SALT, { signal });
  return { credentialId, root: new Uint8Array(raw), backedUp: b };
}

async function prfCreate(label, salt, { signal, second = null } = {}) {
  const name = (label || '').trim();
  if (!name) throw new Error('label required');
  const rpId = window.location.hostname;
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const publicKey = (s) => ({
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { name: 'Tacit', id: rpId },
    user: { id: userId, name, displayName: name },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
    timeout: 60000,
    attestation: 'none',
    extensions: { prf: { eval: { first: salt, ...(s ? { second: s } : {}) } } },
  });
  const create = (s) => navigator.credentials.create({ publicKey: publicKey(s), ...(signal ? { signal } : {}) });
  // (a refused creation made no passkey, so it is asked again with the first salt alone; once one is made, only the ceremony that reads it is)
  let cred;
  try { cred = await create(second); } catch (e) {
    if (second) failedTwoSalt(e);
    if (!second || !refusedSecond(e)) throw e;
    second = null; cred = await create(null);
  }
  if (!cred) throw new Error('creation cancelled');
  if (second) wentWell();
  const credentialId = toB64(cred.rawId);
  const prfOut = cred.getClientExtensionResults()?.prf;
  let made = null;
  try { made = backedUp(cred.response?.getAuthenticatorData?.()); } catch { }
  if (prfOut?.results?.first) return { credentialId, raw: prfOut.results.first, second: second ? prfOut.results.second || null : null, backedUp: made };
  const later = prfOut?.enabled === false ? null : second ? await withChainRoot((s) => prfEval(credentialId, { signal, salt, second: s })) : await prfEval(credentialId, { signal, salt });
  if (!later?.raw) throw new Error('PRF not supported by this authenticator');
  return { credentialId, raw: later.raw, second: later.second, backedUp: later.backedUp ?? made };
}

function keyOf(credentialId, raw, second = null) {
  const priv = prfBytesToScalar(raw instanceof Uint8Array ? raw : new Uint8Array(raw));
  const pub = secp.getPublicKey(priv, true);
  // (a root already kept for the key, as one made with another passkey, is left as it is)
  if (second) { try { if (!keptRoot(priv)) keepRoot(priv, new Uint8Array(second), credentialId); } catch { } }
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

// The key a passkey opened before (its entry in this browser's passkey list), and the key raw PRF output makes.
const knownPub = (credentialId) => { const e = Object.values(loadPrfMap()).find((x) => x?.credentialId === credentialId); return e?.pubkey ? String(e.pubkey).replace(/^0x/, '').toLowerCase() : null; };
const pubOf = (raw) => bytesToHex(secp.getPublicKey(prfBytesToScalar(raw instanceof Uint8Array ? raw : new Uint8Array(raw)), true));

export async function prfLogin({ credentialId, signal }) {
  let r = pqAtSignIn() ? await withChainRoot((s) => prfEval(credentialId, { signal, second: s })) : await prfEval(credentialId, { signal });
  if (!r.raw) throw new Error('PRF result not returned');
  // A passkey opens the key it opened before. One that gives another (an authenticator whose first output were to change with the second salt asked,
  // or not) is asked once the other way, and the answer that opens the known key is the one used; neither does, the sign-in stands as it always did.
  const known = knownPub(r.gotId);
  if (known && pubOf(r.raw) !== known) {
    const other = await prfEval(r.gotId, { signal, second: r.asked ? null : CHAIN_SALT }).catch(() => null);
    if (other?.raw && pubOf(other.raw) === known) { if (r.asked) noSecondHere(); r = other; }
  }
  return keyOf(r.gotId, r.raw, r.backedUp === true ? r.second : null);
}

async function prfEval(credentialId, { signal, salt = PRF_SALT, second = null } = {}) {
  const rpId = window.location.hostname;
  const rawId = credentialId ? fromB64(credentialId) : undefined;
  const prfExtension = { prf: { eval: { first: salt, ...(second ? { second } : {}) } } };
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
  const cred = await navigator.credentials.get({ publicKey, mediation: 'optional', ...(signal ? { signal } : {}) });
  if (!cred) throw new Error('no passkey selected');
  const gotId = toB64(cred.rawId);
  const prfExt = cred.getClientExtensionResults()?.prf || {};
  let results = prfExt.results;
  if (!results && prfExt.resultsByCredential) {
    results = (credentialId && prfExt.resultsByCredential[credentialId]) || prfExt.resultsByCredential[gotId];
  }
  let b = null;
  try { b = backedUp(cred.response?.authenticatorData); } catch { }
  return { gotId, raw: results?.first || null, second: second ? results?.second || null : null, backedUp: b, asked: !!second };
}
