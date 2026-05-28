// Determinism-guard tests for the Bitcoin wallet-as-identity path
// (`btcWallet` in dapp/tacit.js). These pin the load-bearing recovery-safety
// properties: a BTC wallet derives a *recoverable* tacit identity only if it
// signs deterministically, and a later signing drift must be refused rather
// than silently dropping the user into a different (empty) wallet.
//
// Unlike ETH EOAs (RFC-6979 ECDSA, always deterministic), BTC wallets may
// randomize message-signature nonces (BIP-322 over Schnorr permits aux_rand).
// enroll() proves determinism by signing the same message twice and requiring
// byte-identical signatures; login() re-derives and cross-checks against the
// persisted pubkey anchor. Both are exercised here against the real module
// code with a mocked `window.unisat` signer.
//
// jsdom + __TACIT_NO_INIT__ shim mirrors the other tacit.js-importing tests
// (fee-tier-low-rate.test.mjs et al.) — skips the auto-init IIFE so the
// wallet objects can be driven without DOM/network/extension dependencies.
//
// Run: `node tests/btc-wallet.test.mjs`

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;
if (!globalThis.atob) globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
if (!globalThis.btoa) globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
// No network during import; anything that slips through gets a hard 404.
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'denied', json: async () => ({}) });
globalThis.__TACIT_NO_INIT__ = true;

import { randomBytes } from 'node:crypto';
import { secp, sha256 } from '../dapp/vendor/tacit-deps.min.js';
const {
  btcWallet, extWallet, wallet,
  getActiveWalletMode,
  bytesToHex,
} = await import('../dapp/tacit.js');

const BTC_WALLET_KEY = 'tacit-btc-wallet-v1';
const ENROLLED_ADDR = 'tb1qenrolledtestaddrxxxxxxxxxxxxxxxxxxxx';

// ---- tiny test harness (matches prf-wallet.test.mjs) ----
let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
}
async function expectThrow(label, fn, check) {
  try { await fn(); ok(label + ' (expected throw)', false); }
  catch (e) { ok(label, check ? !!check(e) : true); }
}

// ---- signer mocks: control exactly what the "wallet" returns ----
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
// Two distinct fixed 65-byte signatures (recoverable-ECDSA shape). Derivation
// is sha256 over the raw bytes, so any fixed bytes give a stable identity.
const SIG_A = new Uint8Array(65).map((_, i) => (i * 7 + 11) & 0xff);
const SIG_B = new Uint8Array(65).map((_, i) => (i * 13 + 3) & 0xff);

const expectedPriv = (sig) => sha256(sig);
const expectedPubHex = (sig) => bytesToHex(secp.getPublicKey(expectedPriv(sig), true));

let signerCalls = []; // [{ msg, kind }]
function installSigner(fn) {
  signerCalls = [];
  globalThis.window.unisat = {
    signMessage: async (msg, kind) => {
      signerCalls.push({ msg, kind });
      return fn(msg, kind);
    },
  };
}
// Common signer shapes.
const det = (sig) => () => b64(sig);                        // always same sig
const nondet = () => () => b64(randomBytes(65));            // fresh sig each call
const rejectEcdsa = (sig) => (_msg, kind) => {              // ECDSA unsupported -> bip322
  if (kind === 'ecdsa') throw new Error('method not supported');
  return b64(sig);
};

function reset() {
  localStorage.clear();
  btcWallet.state = null;
  wallet.priv = null; wallet.pub = null; wallet.mode = null;
  extWallet.state = { provider: 'unisat', address: ENROLLED_ADDR, pubkey: '02' + 'ab'.repeat(32) };
}

console.log('btcWallet — enrollment determinism guard:');

// 1. Deterministic wallet: enroll succeeds, derives sha256(sig), persists anchor.
reset();
installSigner(det(SIG_A));
{
  const st = await btcWallet.enroll();
  ok('enroll derives priv = sha256(signature)', bytesToHex(wallet.priv) === bytesToHex(expectedPriv(SIG_A)));
  ok('enroll sets wallet.mode = btc', wallet.mode === 'btc');
  ok('enroll anchors tacitPubkey to derived pubkey', st.tacitPubkey === expectedPubHex(SIG_A));
  ok('enroll persists kind = ecdsa (preferred protocol)', st.kind === 'ecdsa');
  ok('enroll records the enrolled BTC address', st.address === ENROLLED_ADDR);
  ok('enroll signs the message exactly twice (determinism proof)', signerCalls.length === 2);
  ok('both enrollment signs used the same protocol', signerCalls[0].kind === 'ecdsa' && signerCalls[1].kind === 'ecdsa');
  ok('enroll sets active wallet mode to btc', getActiveWalletMode() === 'btc');
  ok('enroll writes the anchor to localStorage', !!localStorage.getItem(BTC_WALLET_KEY));
}

// 2. Non-deterministic wallet: enroll refuses, leaves no identity behind.
reset();
installSigner(nondet());
await expectThrow(
  'enroll rejects a non-deterministic wallet',
  () => btcWallet.enroll(),
  (e) => e && e._btcNonDeterministic === true,
);
ok('rejected enroll does not load a key', wallet.priv === null && wallet.mode === null);
ok('rejected enroll persists no anchor', !localStorage.getItem(BTC_WALLET_KEY));

// 3. ECDSA unsupported -> deterministic BIP-322 fallback enrolls, kind recorded.
reset();
installSigner(rejectEcdsa(SIG_A));
{
  const st = await btcWallet.enroll();
  ok('enroll falls back to bip322 when ECDSA is rejected', st.kind === 'bip322');
  ok('bip322 fallback still anchors a derived identity', st.tacitPubkey === expectedPubHex(SIG_A));
}

console.log('\nbtcWallet — login / recovery cross-check:');

// 4. login re-derives a matching pubkey -> unlocks, reusing the stored protocol.
reset();
installSigner(det(SIG_A));
await btcWallet.enroll();
wallet.priv = null; wallet.pub = null; wallet.mode = null; // simulate a locked reload
installSigner(det(SIG_A));
{
  await btcWallet.login();
  ok('login restores the same pubkey from the anchor', bytesToHex(wallet.pub) === expectedPubHex(SIG_A));
  ok('login restores wallet.mode = btc', wallet.mode === 'btc');
  ok('login signs once (no determinism re-proof needed)', signerCalls.length === 1);
  ok('login reuses the enrolled protocol (ecdsa)', signerCalls[0].kind === 'ecdsa');
}

// 5. Signing drift: a different (but stable) signature must be REFUSED, not
//    silently re-derived into a different empty wallet.
reset();
installSigner(det(SIG_A));
await btcWallet.enroll();
wallet.priv = null; wallet.pub = null; wallet.mode = null;
installSigner(det(SIG_B)); // wallet/version changed its signing
await expectThrow(
  'login refuses when the re-derived key differs from the anchor',
  () => btcWallet.login(),
  (e) => /signature changed/i.test(e?.message || ''),
);
ok('refused login leaves the wallet locked', wallet.priv === null && wallet.mode === null);

// 6. Address mismatch: connecting a different BTC account is refused.
reset();
installSigner(det(SIG_A));
await btcWallet.enroll();
wallet.priv = null; wallet.pub = null; wallet.mode = null;
extWallet.state = { provider: 'unisat', address: 'tb1qsomeotheraccountxxxxxxxxxxxxxxxxxxxx', pubkey: '02' + 'cd'.repeat(32) };
installSigner(det(SIG_A));
await expectThrow(
  'login refuses a different connected BTC account',
  () => btcWallet.login(),
  (e) => /differs from the enrolled|reconnect/i.test(e?.message || ''),
);

// 7. login with no anchor yet routes through full enrollment.
reset();
installSigner(det(SIG_A));
{
  await btcWallet.login(); // no cached anchor -> enroll()
  ok('first-ever login enrolls (two signs)', signerCalls.length === 2);
  ok('first-ever login anchors an identity', btcWallet.state?.tacitPubkey === expectedPubHex(SIG_A));
}

// 8. kind reuse: a bip322-enrolled anchor makes login request bip322 first.
reset();
installSigner(rejectEcdsa(SIG_A));
await btcWallet.enroll(); // settles on bip322
wallet.priv = null; wallet.pub = null; wallet.mode = null;
installSigner(det(SIG_A));
{
  await btcWallet.login();
  // _signOnce maps the internal 'bip322' kind to UniSat's wire protocol name
  // 'bip322-simple'; the mock records the wire name the wallet actually sees.
  ok('login reuses the persisted bip322 protocol', signerCalls[0].kind === 'bip322-simple');
}

console.log('\nbtcWallet — anchor persistence:');

// 9. _read / tryRestore validate the stored anchor shape.
reset();
localStorage.setItem(BTC_WALLET_KEY, JSON.stringify({ address: ENROLLED_ADDR })); // missing tacitPubkey
ok('tryRestore rejects an anchor missing tacitPubkey', btcWallet.tryRestore() === null || btcWallet.state === null);

reset();
localStorage.setItem(BTC_WALLET_KEY, JSON.stringify({ address: ENROLLED_ADDR, tacitPubkey: 'not-a-pubkey', kind: 'ecdsa' }));
ok('tryRestore rejects a malformed tacitPubkey', btcWallet.tryRestore() === null);

reset();
const goodAnchor = { address: ENROLLED_ADDR, provider: 'unisat', btcPubkey: '02' + 'ab'.repeat(32), tacitPubkey: expectedPubHex(SIG_A), kind: 'ecdsa' };
localStorage.setItem(BTC_WALLET_KEY, JSON.stringify(goodAnchor));
{
  const r = btcWallet.tryRestore();
  ok('tryRestore accepts a well-formed anchor', !!r && r.tacitPubkey === goodAnchor.tacitPubkey);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
