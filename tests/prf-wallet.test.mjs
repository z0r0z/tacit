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

import { JSDOM } from './_jsdom.mjs';
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

test('savePrfMap returns true when it saved', () => {
  clearPrfMap();
  return savePrfMap({ a: { credentialId: 'abc' } }) === true && loadPrfMap().a.credentialId === 'abc';
});

// A full or refusing storage (QuotaExceededError: Safari/Firefox "The quota has been exceeded.") must not stop a
// sign-in the passkey already answered; the caller carries on with the key and only the "last used" memory is lost.
test('savePrfMap does not throw when storage is full, and reports it', () => {
  const S = dom.window.Storage.prototype, real = S.setItem;
  S.setItem = () => { throw new dom.window.DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
  let r, threw = false;
  try { r = savePrfMap({ a: { credentialId: 'abc' } }); } catch { threw = true; }
  finally { S.setItem = real; }
  return !threw && r === false;
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
function makeFakeCred({ rawIdStr, prfShape, flags = null }) {
  const rawId = new TextEncoder().encode(rawIdStr).buffer;
  // (authenticator data: the rp id hash, then the flags byte: 0x10 is backed up)
  const data = flags == null ? null : (() => { const d = new Uint8Array(37); d[32] = flags; return d.buffer; })();
  return {
    rawId,
    ...(data ? { response: { authenticatorData: data, getAuthenticatorData: () => data } } : {}),
    getClientExtensionResults() { return { prf: prfShape }; },
  };
}
const SYNCED = 0x1d, ONE_DEVICE = 0x05;

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

  // ---- PRF result delivered via resultsByCredential[gotId] ----
  await withMockedCredentials({
    create: async () => null,
    get: async () => makeFakeCred({
      rawIdStr: 'cred-discover',
      // No `results`. Result is keyed by the actually-used credential ID; a discoverable
      // login (no credentialId arg) must still read it from resultsByCredential.
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

  // ---- explicit credentialId, result keyed by gotId only ----
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

  // ---- an authenticator that evaluates PRF only at sign-in ----
  // Registration reports { enabled: true } (or no prf at all) and no output: the new passkey signs in once more, by its
  // own id, and that sign-in's output is the key.
  for (const shape of [{ enabled: true }, undefined]) {
    const asked = [];
    await withMockedCredentials({
      create: async () => makeFakeCred({ rawIdStr: 'late-prf', prfShape: shape }),
      get: async ({ publicKey }) => {
        asked.push(publicKey.allowCredentials.map((c) => Buffer.from(c.id).toString('utf8')));
        return makeFakeCred({ rawIdStr: 'late-prf', prfShape: { results: { first: FIXED_PRF } } });
      },
    }, async () => {
      let r, err;
      try { r = await prfRegister('carol'); } catch (e) { err = e; }
      test(`register with ${shape ? '{ enabled: true }' : 'no prf result'} takes the key from one sign-in with the new passkey`, () => {
        if (err) { console.log('     err:', err.message); return false; }
        return asked.length === 1 && asked[0].join() === 'late-prf'
          && r.credentialId === strToB64Url('late-prf')
          && bytesToHex(r.priv) === bytesToHex(registered.priv) && r.pubHex === registered.pubHex;
      });
    });
  }

  // ---- prfRegister refuses an authenticator that gives no PRF output at sign-in either ----
  await withMockedCredentials({
    create: async () => makeFakeCred({ rawIdStr: 'no-prf', prfShape: { enabled: true } }),
    get: async () => makeFakeCred({ rawIdStr: 'no-prf', prfShape: { enabled: true } }),
  }, async () => {
    let err = null;
    try { await prfRegister('bob'); } catch (e) { err = e; }
    test('register throws when the sign-in after it gives no PRF output either', () => /PRF not supported/.test(err?.message || ''));
  });

  // ---- prfRegister refuses at once an authenticator that reports no PRF ----
  let gets = 0;
  await withMockedCredentials({
    create: async () => makeFakeCred({ rawIdStr: 'off-prf', prfShape: { enabled: false } }),
    get: async () => { gets++; return null; },
  }, async () => {
    let err = null;
    try { await prfRegister('dave'); } catch (e) { err = e; }
    test('register with { enabled: false } throws without asking for a sign-in', () => /PRF not supported/.test(err?.message || '') && gets === 0);
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

  // ---- the Tacit chain's root: the same passkey's output for its own salt ----
  // An authenticator answers HMAC(its secret, salt) for whatever salt it is asked, as hmac-secret does: the root and the Tacit key are two
  // outputs of one passkey, and neither follows from the other.
  const { prfChainRoot, prfRegisterChainRoot } = await import('../dapp/prf-wallet.js');
  const { hmac } = await import('@noble/hashes/hmac');
  const { sha256 } = await import('@noble/hashes/sha256');
  const SECRET = new Uint8Array(32).fill(0x5c), salts = [];
  const answer = (o) => { const salt = new Uint8Array(o.publicKey.extensions.prf.eval.first); salts.push(bytesToHex(salt)); return makeFakeCred({ rawIdStr: 'cred-pq', prfShape: { results: { first: hmac(sha256, SECRET, salt) } }, flags: SYNCED }); };
  await withMockedCredentials({ create: async (o) => answer(o), get: async (o) => answer(o) }, async () => {
    const key = await prfLogin({ credentialId: strToB64Url('cred-pq') });
    const a = await prfChainRoot({ credentialId: strToB64Url('cred-pq') });
    const b = await prfChainRoot({});
    const made = await prfRegisterChainRoot('Tacit PQ ID');
    const enc = new TextEncoder();
    test('the chain root is asked under its own salt, not the Tacit key\'s', () => salts[0] === bytesToHex(sha256(enc.encode('tacit-prf-v1'))) && salts[1] === bytesToHex(sha256(enc.encode('tacit-chain-root-v1'))));
    test('the same passkey gives the same root, picked or named', () => a.root.length === 32 && bytesToHex(a.root) === bytesToHex(b.root) && a.credentialId === strToB64Url('cred-pq'));
    test('a passkey made for the root gives it at creation', () => bytesToHex(made.root) === bytesToHex(a.root));
    test('the root is not the Tacit key', () => bytesToHex(a.root) !== bytesToHex(key.priv));
    test('the root comes with whether its passkey is backed up', () => a.backedUp === true && made.backedUp === true);
  });
  await withMockedCredentials({ create: async () => null, get: async (o) => makeFakeCred({ rawIdStr: 'cred-pq', prfShape: { results: { first: hmac(sha256, SECRET, new Uint8Array(o.publicKey.extensions.prf.eval.first)) } }, flags: ONE_DEVICE }) }, async () => {
    const r = await prfChainRoot({ credentialId: strToB64Url('cred-pq') });
    test('a passkey kept on one device says so', () => r.backedUp === false);
  });

  // ---- a passkey wallet's sign-in can bring its PQ ID: the chain's salt asked as the second of the same ceremony ----
  const { keptRoot, dropRoot } = await import('../dapp/tacit-chain-root.js');
  const enc2 = new TextEncoder(), LOGIN = sha256(enc2.encode('tacit-prf-v1')), CHAIN = sha256(enc2.encode('tacit-chain-root-v1'));
  const prfOf = (salt) => hmac(sha256, SECRET, new Uint8Array(salt));
  // an authenticator that answers every salt it is asked (hmac-secret), one that answers only the first, and one that refuses a second
  const both = (o, flags = SYNCED) => { const e = o.publicKey.extensions.prf.eval; return makeFakeCred({ rawIdStr: 'cred-pq', prfShape: { results: { first: prfOf(e.first), ...(e.second ? { second: prfOf(e.second) } : {}) } }, flags }); };
  const firstOnly = (o) => makeFakeCred({ rawIdStr: 'cred-pq', prfShape: { results: { first: prfOf(o.publicKey.extensions.prf.eval.first) } }, flags: SYNCED });
  // on by default; off in a browser where 'tacit-pq-signin' is '0': sign-in asks the first salt alone and keeps nothing, as it always did
  const fresh = (k) => { if (k) dropRoot(k); localStorage.removeItem('tacit-pq-second'); localStorage.removeItem('tacit-pq-cancels'); };
  {
    const asked = [];
    localStorage.setItem('tacit-pq-signin', '0');
    await withMockedCredentials({ create: async (o) => { asked.push(o.publicKey.extensions.prf.eval); return both(o); }, get: async (o) => { asked.push(o.publicKey.extensions.prf.eval); return both(o); } }, async () => {
      const k = await prfLogin({ credentialId: strToB64Url('cred-pq') });
      dropRoot(k.priv);
      const n = await prfRegister('alice');
      test('off by the switch: sign-in and a new passkey wallet ask the first salt alone and keep no root', () => asked.length === 2 && asked.every((e) => !e.second) && keptRoot(k.priv) === null && keptRoot(n.priv) === null);
    });
    localStorage.removeItem('tacit-pq-signin');
  }
  let calls = 0;
  const refusesSecond = (name) => async (o) => { calls++; if (o.publicKey.extensions.prf.eval.second) throw new DOMException('second salt', name); return firstOnly(o); };
  const cid = strToB64Url('cred-pq');
  let plainKey;
  fresh();
  await withMockedCredentials({ create: async () => null, get: async (o) => firstOnly(o) }, async () => { plainKey = await prfLogin({ credentialId: cid }); });
  fresh(plainKey.priv);
  await withMockedCredentials({ create: async () => null, get: async (o) => both(o) }, async () => {
    const k = await prfLogin({ credentialId: cid });
    const kept = keptRoot(k.priv);
    test('on by default: asking for the second salt leaves the Tacit key as it was', () => bytesToHex(k.priv) === bytesToHex(plainKey.priv));
    test('and the PQ ID\'s root is kept on this device, the same one Generate PQ ID asks for', () => !!kept && bytesToHex(kept.root) === bytesToHex(prfOf(CHAIN)) && kept.credentialId === cid);
    test('the root is not the Tacit key\'s salt output', () => bytesToHex(kept.root) !== bytesToHex(prfOf(LOGIN)));
    test('a ceremony that went well leaves the device asking both salts', () => localStorage.getItem('tacit-pq-second') === null);
  });
  // a passkey kept on one device makes no PQ ID: its loss would lose the TAC
  fresh(plainKey.priv);
  await withMockedCredentials({ create: async () => null, get: async (o) => both(o, ONE_DEVICE) }, async () => {
    const k = await prfLogin({ credentialId: cid });
    test('a passkey that is not backed up keeps no root, and opens the same key', () => keptRoot(k.priv) === null && bytesToHex(k.priv) === bytesToHex(plainKey.priv));
  });
  // nor one whose browser does not say
  await withMockedCredentials({ create: async () => null, get: async (o) => { const e = o.publicKey.extensions.prf.eval; return makeFakeCred({ rawIdStr: 'cred-pq', prfShape: { results: { first: prfOf(e.first), ...(e.second ? { second: prfOf(e.second) } : {}) } } }); } }, async () => {
    const k = await prfLogin({ credentialId: cid });
    test('a browser that does not say whether it is backed up keeps no root', () => keptRoot(k.priv) === null);
  });
  fresh(plainKey.priv); calls = 0;
  await withMockedCredentials({ create: async () => null, get: refusesSecond('NotSupportedError') }, async () => {
    const k = await prfLogin({ credentialId: cid });
    test('an authenticator that refuses a second salt is asked again at once with the first alone, and opens the same key', () => calls === 2 && bytesToHex(k.priv) === bytesToHex(plainKey.priv) && keptRoot(k.priv) === null);
    test('and the device asks the first salt alone from then on', () => localStorage.getItem('tacit-pq-second') === 'no');
  });
  // a refusal that looks like a cancel: not asked again now; one cancel turns nothing off, the second in a row does, and the next press opens the wallet
  fresh(plainKey.priv); calls = 0;
  await withMockedCredentials({ create: async () => null, get: refusesSecond('NotAllowedError') }, async () => {
    let threw = null;
    try { await prfLogin({ credentialId: cid }); } catch (e) { threw = e; }
    test('a cancel (or a refusal that looks like one) is not asked again, and one alone turns nothing off', () => calls === 1 && threw?.name === 'NotAllowedError' && localStorage.getItem('tacit-pq-second') === null);
    threw = null;
    try { await prfLogin({ credentialId: cid }); } catch (e) { threw = e; }
    test('the second in a row with both salts asked makes the device ask the first salt alone', () => calls === 2 && threw?.name === 'NotAllowedError' && localStorage.getItem('tacit-pq-second') === 'no');
    const k = await prfLogin({ credentialId: cid });
    test('the next press opens the same key: an authenticator refusing as a cancel costs two sign-ins at most', () => calls === 3 && bytesToHex(k.priv) === bytesToHex(plainKey.priv));
  });
  // a person who closes the prompt once, then signs in: the PQ ID comes with it, and the count is cleared
  fresh(plainKey.priv); calls = 0;
  await withMockedCredentials({ create: async () => null, get: async (o) => { calls++; if (calls === 1) throw new DOMException('closed', 'NotAllowedError'); return both(o); } }, async () => {
    try { await prfLogin({ credentialId: cid }); } catch { }
    const k = await prfLogin({ credentialId: cid });
    test('one closed prompt, then a sign-in: the PQ ID comes with it and the count is cleared', () => !!keptRoot(k.priv) && localStorage.getItem('tacit-pq-cancels') === null && localStorage.getItem('tacit-pq-second') === null);
  });
  // the page's own errors (no passkey picked, a request already pending) say nothing about the second salt
  fresh(plainKey.priv);
  await withMockedCredentials({ create: async () => null, get: async () => null }, async () => {
    try { await prfLogin({ credentialId: cid }); } catch { }
  });
  await withMockedCredentials({ create: async () => null, get: async () => { throw new DOMException('pending', 'InvalidStateError'); } }, async () => {
    try { await prfLogin({ credentialId: cid }); } catch { }
    test('the page\'s own errors and a pending request mark nothing', () => localStorage.getItem('tacit-pq-second') === null && localStorage.getItem('tacit-pq-cancels') === null);
  });
  // an authenticator whose first output changed with the second salt asked would open another wallet: the known key is asked for again the other way
  fresh(plainKey.priv); calls = 0;
  savePrfMap({ alice: { credentialId: cid, pubkey: plainKey.pubHex } });
  await withMockedCredentials({ create: async () => null, get: async (o) => { calls++; const e = o.publicKey.extensions.prf.eval; return e.second ? makeFakeCred({ rawIdStr: 'cred-pq', prfShape: { results: { first: prfOf(e.second), second: prfOf(e.first) } }, flags: SYNCED }) : firstOnly(o); } }, async () => {
    const k = await prfLogin({ credentialId: cid });
    test('a passkey opens the key it opened before: asked again with the first salt alone when two salts gave another', () => calls === 2 && bytesToHex(k.priv) === bytesToHex(plainKey.priv) && keptRoot(k.priv) === null && localStorage.getItem('tacit-pq-second') === 'no');
  });
  clearPrfMap();
  // a cancel by the page (its own Cancel, an AbortError) is not the authenticator's doing: the device keeps asking both salts
  fresh(plainKey.priv);
  await withMockedCredentials({ create: async () => null, get: async () => { throw new DOMException('aborted', 'AbortError'); } }, async () => {
    try { await prfLogin({ credentialId: cid }); } catch { }
    test('the page\'s own cancel leaves the device asking both salts', () => localStorage.getItem('tacit-pq-second') === null);
  });
  // an authenticator that gives no output at all when asked two salts is asked again with the first alone
  fresh(plainKey.priv); calls = 0;
  await withMockedCredentials({ create: async () => null, get: async (o) => { calls++; return o.publicKey.extensions.prf.eval.second ? makeFakeCred({ rawIdStr: 'cred-pq', prfShape: {} }) : firstOnly(o); } }, async () => {
    const k = await prfLogin({ credentialId: cid });
    test('no output for two salts: asked again with the first alone, the same key', () => calls === 2 && bytesToHex(k.priv) === bytesToHex(plainKey.priv) && localStorage.getItem('tacit-pq-second') === 'no');
  });
  // creation that gives no PRF output, then a ceremony that refuses the second salt: one passkey made, read again with the first salt alone
  fresh(plainKey.priv); calls = 0;
  let creates = 0;
  await withMockedCredentials({ create: async () => { creates++; return makeFakeCred({ rawIdStr: 'cred-pq', prfShape: { enabled: true } }); }, get: refusesSecond('NotSupportedError') }, async () => {
    const k = await prfRegister('alice');
    test('a refused second salt after creation never makes a second passkey', () => creates === 1 && calls === 2 && bytesToHex(k.priv) === bytesToHex(plainKey.priv) && keptRoot(k.priv) === null);
  });
  // a creation the user cancels (or the platform refuses as a cancel): not repeated now; two in a row and the next asks the first salt alone
  fresh(plainKey.priv); creates = 0;
  await withMockedCredentials({ create: async (o) => { creates++; if (o.publicKey.extensions.prf.eval.second) throw new DOMException('no', 'NotAllowedError'); return firstOnly(o); }, get: async (o) => firstOnly(o) }, async () => {
    const threw = [];
    for (let i = 0; i < 2; i++) { try { await prfRegister('alice'); } catch (e) { threw.push(e?.name); } }
    const k = await prfRegister('alice');
    test('a cancelled creation is not repeated; after two in a row the next asks the first salt alone and makes the wallet', () => threw.join() === 'NotAllowedError,NotAllowedError' && creates === 3 && bytesToHex(k.priv) === bytesToHex(plainKey.priv));
  });
  // a root kept for the key (made with another passkey) is not replaced by a sign-in
  fresh(plainKey.priv);
  const { keepRoot } = await import('../dapp/tacit-chain-root.js');
  const other = new Uint8Array(32).fill(0x42);
  keepRoot(plainKey.priv, other, 'cred-other');
  await withMockedCredentials({ create: async () => null, get: async (o) => both(o) }, async () => {
    const k = await prfLogin({ credentialId: cid });
    test('a root already kept for the key is left as it is', () => bytesToHex(keptRoot(k.priv).root) === bytesToHex(other) && keptRoot(k.priv).credentialId === 'cred-other');
  });
  // a new passkey wallet: the root at creation, or from the ceremony that follows when creation gives no PRF output
  for (const [label, create] of [['at creation', async (o) => both(o)], ['after creation', async () => makeFakeCred({ rawIdStr: 'cred-pq', prfShape: { enabled: true } })]]) {
    fresh(plainKey.priv);
    await withMockedCredentials({ create, get: async (o) => both(o) }, async () => {
      const k = await prfRegister('alice');
      test(`a new passkey wallet keeps its PQ ID's root (${label})`, () => bytesToHex(k.priv) === bytesToHex(plainKey.priv) && bytesToHex(keptRoot(k.priv)?.root || []) === bytesToHex(prfOf(CHAIN)));
    });
  }
  fresh(plainKey.priv);
  localStorage.removeItem('tacit-pq-signin');
})();

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
