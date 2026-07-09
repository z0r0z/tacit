// Integration test for the "bitcoin wallet as identity" onboarding wiring.
// Where btc-wallet.test.mjs unit-tests the enroll/login derivation in
// isolation, this drives the REAL welcome-modal handler and the lazy
// sign-time unlock against a minimal jsdom DOM:
//
//   1. build the welcome-modal markup the real _showWelcomeModal reads,
//   2. click the actual #welcome-btc-id button → _runFirstLoadChoice's
//      'btc-id' branch → connectDefault → reconcile → btcWallet.enroll,
//   3. simulate a reload: btcWallet.tryRestore hydrates the pubkey anchor
//      (what init() does for activeMode==='btc'), no signature yet,
//   4. take a signing action → ensurePrivkey → btcWallet.login re-derives
//      and matches the anchor, with exactly one signature (no re-enroll).
//
// Only the two true external edges are stubbed — the wallet-extension connect
// (extWallet.connectDefault) and the live signer (window.unisat.signMessage) —
// because no headless test can drive a real browser extension. Everything
// between (modal handler, choice dispatch, enroll, anchor persistence,
// restore hydration, lazy unlock) is the real module code.
//
// Run: `node tests/btc-wallet-welcome.test.mjs`

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => true;
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;
if (!globalThis.atob) globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
if (!globalThis.btoa) globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'denied', json: async () => ({}) });
globalThis.__TACIT_NO_INIT__ = true; globalThis.__FLC_DEBUG__ = true;

import { secp, sha256 } from '../dapp/vendor/tacit-deps.min.js';
import { prfBytesToScalar as toValidScalar } from '../dapp/prf-wallet.js';
const {
  btcWallet, extWallet, wallet,
  _runFirstLoadChoice, ensurePrivkey,
  getActiveWalletMode, NET, hexToBytes, bytesToHex,
} = await import('../dapp/tacit.js');

const BTC_WALLET_KEY = 'tacit-btc-wallet-v1';
const ONBOARDED_KEY = 'tacit-onboarded-v1';
const ENROLLED_ADDR = 'tb1qenrolledtestaddrxxxxxxxxxxxxxxxxxxxx';

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- deterministic signer (the only "live wallet" stand-in) ----
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const SIG_A = new Uint8Array(65).map((_, i) => (i * 7 + 11) & 0xff);
const expectedPubHex = bytesToHex(secp.getPublicKey(toValidScalar(sha256(SIG_A)), true));
let signerCalls = [];
function installSigner() {
  signerCalls = [];
  globalThis.window.unisat = {
    signMessage: async (msg, kind) => { signerCalls.push({ msg, kind }); return b64(SIG_A); },
  };
}

// ---- stub the wallet-extension connect edge ----
// Mirrors a real connect: populates extWallet.state with an address + the
// active network so reconcileWalletNetwork returns 'ok' and the flow proceeds
// to enrollment. Provider 'unisat' routes _signOnce to window.unisat above.
extWallet.connectDefault = async () => {
  extWallet.state = { provider: 'unisat', address: ENROLLED_ADDR, pubkey: '02' + 'ab'.repeat(32), network: NET.name };
  return extWallet.state;
};

// ---- build the minimal welcome-modal DOM _showWelcomeModal reads ----
document.body.innerHTML = `
  <div id="toast-container"></div>
  <div id="welcome-modal" style="display:none;">
    <div id="welcome-ceremony-context" style="display:none;"></div>
    <button id="welcome-eth"></button>
    <button id="welcome-passkey"><span id="welcome-passkey-rec"></span></button>
    <button id="welcome-local"><span id="welcome-local-rec"></span></button>
    <button id="welcome-crossnet"><span id="welcome-crossnet-title"></span><span id="welcome-crossnet-meta"></span></button>
    <a id="welcome-import" href="#"></a>
    <button id="welcome-xverse"></button>
    <button id="welcome-unisat"></button>
    <button id="welcome-btc-id"></button>
    <button id="welcome-browse"></button>
  </div>`;

console.log('welcome-modal — browse without wallet:');

// Scenario 0: a fresh visitor can browse read-only without creating or
// connecting a wallet. This keeps market/discover onboarding non-custodial:
// the first signing action can still prompt later, but app boot itself must
// not force a wallet decision.
localStorage.clear();
extWallet.state = null;
wallet.priv = null; wallet.pub = null; wallet.mode = null;
btcWallet.state = null;
{
  const done = _runFirstLoadChoice();
  await tick();
  const btn = document.getElementById('welcome-browse');
  ok('browse-first button is wired', typeof btn.onclick === 'function');
  btn.click();
  const result = await done;
  ok('browse-first returns read-only choice', result === 'browse');
  ok('browse-first does not create a wallet', wallet.pub === null && wallet.priv === null && wallet.mode === null);
  ok('browse-first suppresses future setup nag', localStorage.getItem(ONBOARDED_KEY) === '1');
}
{
  const unlock = ensurePrivkey().then(
    () => ({ ok: true }),
    (e) => ({ ok: false, message: e?.message || String(e), cancelled: !!e?.unlockCancelled }),
  );
  await tick();
  document.getElementById('welcome-browse').click();
  const result = await unlock;
  ok('signing after browse reopens setup instead of silently creating a local wallet', result.ok === false && result.cancelled === true);
  ok('cancelled action still leaves no wallet', wallet.pub === null && wallet.priv === null && wallet.mode === null);
}

console.log('btc-id onboarding — welcome-modal click → enroll:');

// Scenario 1: click "bitcoin wallet as identity" and run it through to a
// loaded btc identity.
localStorage.clear();
extWallet.state = null;
wallet.priv = null; wallet.pub = null; wallet.mode = null;
btcWallet.state = null;
installSigner();
{
  const done = _runFirstLoadChoice();    // awaits _showWelcomeModal internally
  await tick();                          // let the modal wire its onclick
  const btn = document.getElementById('welcome-btc-id');
  ok('welcome btc-id button is enabled when a BTC wallet is present', btn.disabled === false);
  btn.click();                           // user picks "bitcoin wallet as identity"
  await done;
  // A clean run must not have flashed any error toast (e.g. the welcome modal
  // returning early and tripping the local-burner path). Guards the missing-
  // return regression this test originally surfaced.
  ok('no setup-error toast during onboarding', !(document.getElementById('toast-container').textContent || '').includes('Setup failed'));

  ok('enroll loaded a btc-mode identity', wallet.mode === 'btc');
  ok('derived pubkey matches the deterministic signature', bytesToHex(wallet.pub) === expectedPubHex);
  ok('anchor persisted to localStorage', JSON.parse(localStorage.getItem(BTC_WALLET_KEY) || '{}').tacitPubkey === expectedPubHex);
  ok('active wallet mode set to btc', getActiveWalletMode() === 'btc');
  ok('user marked onboarded', localStorage.getItem(ONBOARDED_KEY) === '1');
  ok('enrollment proved determinism with two signatures', signerCalls.length === 2);
}

console.log('\nbtc-id onboarding — reload restore + lazy recovery:');

// Scenario 2: simulate a fresh page load. init() hydrates the pubkey from the
// persisted anchor (no signature), then a signing action lazily re-derives.
wallet.priv = null; wallet.pub = null; wallet.mode = null;
btcWallet.state = null;       // in-memory state gone, as after a reload
extWallet.state = null;       // ext wallet not yet reconnected
{
  // What init() does for activeMode === 'btc': anchor → pubkey, no signature.
  const restored = btcWallet.tryRestore();
  ok('tryRestore recovers the anchor after reload', restored?.tacitPubkey === expectedPubHex);
  wallet.pub = hexToBytes(restored.tacitPubkey);
  wallet.mode = 'btc';
  ok('reload hydrates pubkey without unlocking the private key', wallet.pub !== null && wallet.priv === null);

  // A signing action triggers the lazy unlock path.
  installSigner();              // reset call counter; ext reconnect happens in login
  await ensurePrivkey();
  ok('ensurePrivkey re-derives the private key on demand', wallet.priv !== null);
  ok('recovered key matches the enrolled identity', bytesToHex(secp.getPublicKey(wallet.priv, true)) === expectedPubHex);
  ok('recovery signs exactly once (no re-enrollment)', signerCalls.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
