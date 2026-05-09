// Boundary tests for prfBytesToScalar in dapp/prf-wallet.js. Pins the four
// load-bearing branches of the deterministic guard so a future refactor of
// the rejection logic can't silently drop the recovery fallback.
//
// The PRF input per credential is constant — if a (vanishing) raw output of
// 0 or ≥ N is ever returned as-is, the user is wedged forever (same passkey
// will reproduce the same bad output, no retry path exists). These vectors
// fail loudly if that property is broken.
//
// Also covers the WebAuthn glue: register/login determinism via mocked
// navigator.credentials, the resultsByCredential fallback paths (load-bearing
// for password-manager passkeys like Bitwarden), and the localStorage map
// helpers + restore ordering.
//
// jsdom shim mirrors dapp-parity.test.mjs — prf-wallet.js has top-level
// `new TextEncoder()` and a sha256() of a domain string, neither of which
// strictly needs DOM globals, but the vendor bundle expects them at
// import time on some Node versions.
//
// Run: `node prf-wallet.test.mjs`

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
// jsdom exposes window.crypto but doesn't proxy it onto globalThis.crypto.
// prf-wallet.js calls `crypto.getRandomValues(...)` as a top-level global.
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;

const {
  prfBytesToScalar,
  loadPrfMap, savePrfMap, clearPrfMap,
  prfTryRestore,
  isPasskeyAvailable,
  prfRegister, prfLogin,
} = await import('../dapp/prf-wallet.js');
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function bigintToBytes32(n) {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}
function isValidScalar(b) {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n > 0n && n < SECP_N;
}

let pass = 0, fail = 0;
function test(label, fn) {
  try {
    const ok = fn();
    if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
    else             { console.log(`  FAIL  ${label}`); fail++; }
  } catch (e) {
    console.log(`  FAIL  ${label} — ${e.message}`); fail++;
  }
}

console.log('prfBytesToScalar boundary vectors:');

// Valid scalars: returned unchanged so determinism is preserved for the
// 1 - 2⁻¹²⁸ of the input space that doesn't need reduction.
test('raw = 1 → returned unchanged', () => {
  const raw = bigintToBytes32(1n);
  const out = prfBytesToScalar(raw);
  return bytesToHex(out) === bytesToHex(raw) && isValidScalar(out);
});

test('raw = N - 1 (max valid) → returned unchanged', () => {
  const raw = bigintToBytes32(SECP_N - 1n);
  const out = prfBytesToScalar(raw);
  return bytesToHex(out) === bytesToHex(raw) && isValidScalar(out);
});

test('raw = some random valid scalar → returned unchanged', () => {
  const raw = hexToBytes('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
  const out = prfBytesToScalar(raw);
  return bytesToHex(out) === bytesToHex(raw) && isValidScalar(out);
});

// Invalid scalars: must be reduced via deterministic fallback. Output must
// never equal the bad input (would mean the guard didn't fire).
test('raw = 0 → reduced to a valid scalar', () => {
  const raw = new Uint8Array(32); // all-zero
  const out = prfBytesToScalar(raw);
  return isValidScalar(out) && bytesToHex(out) !== bytesToHex(raw);
});

test('raw = N (one past max) → reduced to a valid scalar', () => {
  const raw = bigintToBytes32(SECP_N);
  const out = prfBytesToScalar(raw);
  return isValidScalar(out) && bytesToHex(out) !== bytesToHex(raw);
});

test('raw = 2^256 - 1 (max 32-byte value, > N) → reduced to a valid scalar', () => {
  const raw = new Uint8Array(32).fill(0xff);
  const out = prfBytesToScalar(raw);
  return isValidScalar(out) && bytesToHex(out) !== bytesToHex(raw);
});

// Determinism: same input → same output (across calls). The fallback is a
// single sha256 with a fixed domain string, so reduced outputs are stable.
test('reduction is deterministic for raw = 0', () => {
  const raw = new Uint8Array(32);
  const a = prfBytesToScalar(raw);
  const b = prfBytesToScalar(new Uint8Array(32));
  return bytesToHex(a) === bytesToHex(b);
});

test('reduction is deterministic for raw = N', () => {
  const a = prfBytesToScalar(bigintToBytes32(SECP_N));
  const b = prfBytesToScalar(bigintToBytes32(SECP_N));
  return bytesToHex(a) === bytesToHex(b);
});

// ---------- localStorage map helpers ----------
console.log('\nPRF map helpers:');

test('loadPrfMap returns empty object when nothing saved', () => {
  clearPrfMap();
  const m = loadPrfMap();
  return typeof m === 'object' && m !== null && Object.keys(m).length === 0;
});

test('savePrfMap + loadPrfMap round-trip', () => {
  clearPrfMap();
  savePrfMap({ alice: { credentialId: 'abc', pubkey: 'deadbeef', lastUsed: 100 } });
  const m = loadPrfMap();
  return m.alice && m.alice.credentialId === 'abc' && m.alice.pubkey === 'deadbeef' && m.alice.lastUsed === 100;
});

test('clearPrfMap empties the map', () => {
  savePrfMap({ x: { credentialId: 'y' } });
  clearPrfMap();
  return Object.keys(loadPrfMap()).length === 0;
});

test('loadPrfMap survives corrupt JSON without throwing', () => {
  localStorage.setItem('tacit-prf-v1', '{not-json');
  const m = loadPrfMap();
  clearPrfMap();
  return typeof m === 'object' && Object.keys(m).length === 0;
});

// ---------- prfTryRestore ordering ----------
console.log('\nprfTryRestore:');

test('returns null when no entries', () => {
  clearPrfMap();
  return prfTryRestore() === null;
});

test('picks the entry with highest lastUsed', () => {
  clearPrfMap();
  savePrfMap({
    older: { credentialId: 'A', pubkey: '01', lastUsed: 100 },
    newer: { credentialId: 'B', pubkey: '02', lastUsed: 999 },
    middle: { credentialId: 'C', pubkey: '03', lastUsed: 500 },
  });
  const r = prfTryRestore();
  return r.label === 'newer' && r.credentialId === 'B' && r.pubkey === '02';
});

test('falls back when entries are missing lastUsed (no throw, returns one)', () => {
  clearPrfMap();
  savePrfMap({
    legacy: { credentialId: 'X', pubkey: '0a' },
    newish: { credentialId: 'Y', pubkey: '0b', lastUsed: 1 },
  });
  const r = prfTryRestore();
  // Whichever wins, it must be a valid pointer (not null, not undefined fields).
  return !!r && typeof r.label === 'string' && typeof r.credentialId === 'string';
});

// ---------- isPasskeyAvailable ----------
console.log('\nisPasskeyAvailable:');

test('falsy in environment without PublicKeyCredential', () => {
  // jsdom doesn't implement PublicKeyCredential or isSecureContext, so the
  // function short-circuits on the first missing global. Either undefined
  // or false is acceptable — it just must not be truthy.
  return !isPasskeyAvailable();
});

test('truthy once PublicKeyCredential is present in a secure context', () => {
  const hadPKC = 'PublicKeyCredential' in window;
  const hadSec = 'isSecureContext' in window && window.isSecureContext;
  if (!hadPKC) window.PublicKeyCredential = function () {};
  if (!hadSec) Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  const ok = !!isPasskeyAvailable();
  if (!hadPKC) delete window.PublicKeyCredential;
  if (!hadSec) Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
  return ok;
});

// ---------- WebAuthn glue (mocked navigator.credentials) ----------
// These pin the load-bearing properties of register/login: same passkey →
// same priv (determinism), and the read-side fallbacks for PRF results
// keyed by credential ID (the path that breaks for password-manager
// passkeys when results land under `resultsByCredential` instead of
// `results`).
console.log('\nWebAuthn glue (mocked):');

function strToB64Url(s) {
  return Buffer.from(s, 'utf8').toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

// Build a fake credential the way a browser would: rawId is a buffer, and
// getClientExtensionResults().prf shape is configurable per test (results
// vs resultsByCredential, etc).
function makeFakeCred({ rawIdStr, prfShape }) {
  const rawId = new TextEncoder().encode(rawIdStr).buffer;
  return {
    rawId,
    getClientExtensionResults() { return { prf: prfShape }; },
  };
}

// 32-byte deterministic PRF output — fed back identically on every login so
// the derived priv must match across calls.
const FIXED_PRF = new Uint8Array(32);
for (let i = 0; i < 32; i++) FIXED_PRF[i] = (i * 7 + 13) & 0xff;

async function withMockedCredentials({ create, get }, fn) {
  const orig = navigator.credentials;
  // jsdom's navigator.credentials is a getter; replace via defineProperty.
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: { create, get },
  });
  try { return await fn(); }
  finally {
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: orig });
  }
}

await (async () => {
  // ---- determinism: register then login produce the same priv ----
  let registered;
  await withMockedCredentials({
    create: async () => makeFakeCred({
      rawIdStr: 'cred-abc',
      prfShape: { results: { first: FIXED_PRF } },
    }),
    get: async () => makeFakeCred({
      rawIdStr: 'cred-abc',
      prfShape: { results: { first: FIXED_PRF } },
    }),
  }, async () => {
    registered = await prfRegister('alice');
    const logged = await prfLogin({ credentialId: registered.credentialId });
    test('register + login derive identical priv from same PRF output', () => {
      return bytesToHex(registered.priv) === bytesToHex(logged.priv)
        && registered.pubHex === logged.pubHex
        && registered.credentialId === logged.credentialId;
    });
    test('credentialId round-trips through base64url', () => {
      // The fake rawId encodes 'cred-abc'; toB64 of that should decode back.
      const decoded = Buffer.from(
        registered.credentialId.replaceAll('-', '+').replaceAll('_', '/') + '==='.slice((registered.credentialId.length + 3) % 4),
        'base64'
      ).toString('utf8');
      return decoded === 'cred-abc';
    });
  });

  // ---- bug-3 path: PRF result delivered via resultsByCredential[gotId] ----
  await withMockedCredentials({
    create: async () => null,
    get: async () => makeFakeCred({
      rawIdStr: 'cred-discover',
      // No `results`. Result is keyed by the actually-used credential ID.
      // Discoverable login (no credentialId arg) used to silently drop this.
      prfShape: { resultsByCredential: { [strToB64Url('cred-discover')]: { first: FIXED_PRF } } },
    }),
  }, async () => {
    let result, err;
    try { result = await prfLogin({}); } catch (e) { err = e; }
    test('discoverable login reads PRF from resultsByCredential[gotId]', () => {
      if (err) { console.log('     err:', err.message); return false; }
      return result && result.priv && result.priv.length === 32;
    });
  });

  // ---- bug-3 path: explicit credentialId, result keyed by gotId only ----
  // Browser may normalize credentialId encoding; keying by gotId protects us.
  await withMockedCredentials({
    create: async () => null,
    get: async () => makeFakeCred({
      rawIdStr: 'cred-xyz',
      prfShape: { resultsByCredential: { [strToB64Url('cred-xyz')]: { first: FIXED_PRF } } },
    }),
  }, async () => {
    let result, err;
    try { result = await prfLogin({ credentialId: strToB64Url('cred-xyz') }); }
    catch (e) { err = e; }
    test('login with credentialId reads PRF via resultsByCredential', () => {
      if (err) { console.log('     err:', err.message); return false; }
      return result && result.priv && result.priv.length === 32;
    });
  });

  // ---- prfRegister rejects when authenticator never returns PRF ----
  await withMockedCredentials({
    create: async () => makeFakeCred({
      rawIdStr: 'no-prf',
      prfShape: { enabled: true }, // no results — current behavior throws
    }),
    get: async () => null,
  }, async () => {
    let threw = false;
    try { await prfRegister('bob'); } catch { threw = true; }
    test('register throws when PRF output absent (sentinels future fix)', () => threw);
  });

  // ---- prfLogin rejects when no credential returned ----
  await withMockedCredentials({
    create: async () => null,
    get: async () => null,
  }, async () => {
    let threw = false;
    try { await prfLogin({}); } catch { threw = true; }
    test('login throws when no credential returned', () => threw);
  });

  // ---- prfRegister requires a non-empty label ----
  await withMockedCredentials({
    create: async () => { throw new Error('should not be called'); },
    get: async () => null,
  }, async () => {
    let threwEmpty = false, threwBlank = false;
    try { await prfRegister(''); } catch { threwEmpty = true; }
    try { await prfRegister('   '); } catch { threwBlank = true; }
    test('register rejects empty / whitespace label before touching authenticator', () => threwEmpty && threwBlank);
  });
})();

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
