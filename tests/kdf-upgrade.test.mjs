// Passphrase blobs below PBKDF2_ITER (600k) are re-encrypted on a successful unlock (dapp/tacit.js wallet.load).
//
// Same slot, same key and pub; the new blob is written only after it decrypts back to the same key, and a failed write
// leaves the old blob as it was (it still unlocks).
//
// Run: `node tests/kdf-upgrade.test.mjs`

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;
globalThis.fetch = async () => { throw new Error('offline'); };
globalThis.__TACIT_NO_INIT__ = true;
localStorage.setItem('tacit-network-v1', 'mainnet');

const { secp, bytesToHex } = await import('../dapp/vendor/tacit-deps.min.js');
const T = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
};

// The unlock modal, answered as a user would.
document.body.innerHTML = `
  <div id="pass-modal" style="display:none;"><form id="pass-form">
    <div id="pass-title"></div><div id="pass-reason"></div>
    <label id="pass-label-1"></label><input id="pass-input-1"><div id="pass-hint-1"></div>
    <div id="pass-field-2"><input id="pass-input-2"><div id="pass-hint-2"></div></div>
    <div id="pass-warn"></div><button id="pass-submit" type="submit"></button><button id="pass-cancel" type="button"></button>
  </form></div>`;
const PASS = 'correct horse battery staple';
const autoFill = setInterval(() => {
  if (document.getElementById('pass-modal').style.display !== 'grid') return;
  const el = document.getElementById('pass-input-1');
  el.value = PASS; el.dispatchEvent(new dom.window.Event('input'));
  document.getElementById('pass-form').onsubmit({ preventDefault() {} });
}, 5);

// A blob as an older build wrote it: PBKDF2-SHA256 at `iter`, AES-GCM.
const hex = (b) => bytesToHex(new Uint8Array(b));
async function oldBlob(priv, iter) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASS), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, 256);
  const aes = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, priv);
  return JSON.stringify({ v: 1, kdf: 'pbkdf2', iter, salt: hex(salt), iv: hex(iv), ct: hex(ct), pub: bytesToHex(secp.getPublicKey(priv, true)) });
}
const SLOT = 'tacit-wallet-v1:mainnet';
const priv = new Uint8Array(32); priv[31] = 33;
const pubHex = bytesToHex(secp.getPublicKey(priv, true));
const reset = () => { T.wallet.priv = null; T.wallet.pub = null; T.wallet.mode = null; };

console.log('A blob at 200k iterations');
localStorage.setItem(SLOT, await oldBlob(priv, 200000));
reset();
await T.wallet.load();
let b = JSON.parse(localStorage.getItem(SLOT));
ok('unlocks to the same key', bytesToHex(T.wallet.pub) === pubHex);
ok('re-encrypted at 600k in the same slot, same pub', b.iter === 600000 && b.pub === pubHex);
reset();
await T.wallet.load();
ok('the new blob unlocks to the same key', bytesToHex(T.wallet.priv) === bytesToHex(priv));

console.log('\nA blob at 600k is left as it is');
const at600 = localStorage.getItem(SLOT);
reset();
await T.wallet.load();
ok('unchanged', localStorage.getItem(SLOT) === at600);

console.log('\nThe write fails');
const old = await oldBlob(priv, 150000);
localStorage.setItem(SLOT, old);
const realSet = Object.getPrototypeOf(localStorage).setItem;
Object.getPrototypeOf(localStorage).setItem = function (k, v) { if (k === SLOT) throw new Error('QuotaExceededError'); return realSet.call(this, k, v); };
reset();
let err = null;
try { await T.wallet.load(); } catch (e) { err = e; }
Object.getPrototypeOf(localStorage).setItem = realSet;
ok('the unlock still succeeds', err === null && bytesToHex(T.wallet.pub) === pubHex);
ok('the old blob is kept as it was', localStorage.getItem(SLOT) === old);

clearInterval(autoFill);
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
