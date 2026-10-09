// Import key / New wallet (wallet.setPriv / wallet.regenerate) against the storage slots in dapp/tacit.js.
//
// A slot is written only when it is empty or holds the wallet that is open now, so a key saved in this browser but
// never shown (a passkey, Ethereum or Bitcoin-derived key was open) is not overwritten. A write that goes ahead leaves
// the derived key first: the new key is the open one, with mode null (its own backup gate) and the local or ext mode
// pinned for reload.
//
// Run: `node tests/wallet-slots.test.mjs`

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'denied', json: async () => ({}) });
globalThis.__TACIT_NO_INIT__ = true;

const { secp, bytesToHex, hexToBytes } = await import('../dapp/vendor/tacit-deps.min.js');
const T = await import('../dapp/tacit.js');
const { wallet, ethWallet, btcWallet, extWallet, prfWallet, getActiveWalletMode } = T;

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
};

// The passphrase modal the real _promptNewPassphrase drives; filled and submitted as a user would.
document.body.innerHTML = `
  <div id="toast-container"></div>
  <div id="pass-modal" style="display:none;"><form id="pass-form">
    <div id="pass-title"></div><div id="pass-reason"></div>
    <label id="pass-label-1"></label><input id="pass-input-1"><div id="pass-hint-1"></div>
    <div id="pass-field-2"><input id="pass-input-2"><div id="pass-hint-2"></div></div>
    <div id="pass-warn"></div><button id="pass-submit" type="submit"></button><button id="pass-cancel" type="button"></button>
  </form></div>`;
let prompts = 0;
const autoFill = setInterval(() => {
  const m = document.getElementById('pass-modal');
  if (m.style.display !== 'grid') return;
  prompts++;
  for (const id of ['pass-input-1', 'pass-input-2']) {
    const el = document.getElementById(id);
    el.value = 'correct horse battery staple';
    el.dispatchEvent(new dom.window.Event('input'));
  }
  document.getElementById('pass-form').onsubmit({ preventDefault() {} });
}, 5);

const privOf = (n) => { const b = new Uint8Array(32); b[31] = n; return b; };
const pubHexOf = (priv) => bytesToHex(secp.getPublicKey(priv, true));
const blobFor = (pubHex) => JSON.stringify({ v: 1, kdf: 'pbkdf2', iter: 600000, salt: '00'.repeat(16), iv: '00'.repeat(12), ct: '00'.repeat(48), pub: pubHex });
const LOCAL = 'tacit-wallet-v1:mainnet';
const ETH_ADDR = 'ab'.repeat(20);
const SAVED = pubHexOf(privOf(1));      // a local key saved in this browser
const DERIVED = pubHexOf(privOf(2));    // the derived key open now
const IMPORTED = privOf(3);

function reset() {
  localStorage.clear();
  wallet.priv = null; wallet.pub = null; wallet.mode = null;
  ethWallet.state = null; btcWallet.state = null; extWallet.state = null; prfWallet.state = null;
  prompts = 0;
}
function openEth() {
  wallet.pub = hexToBytes(DERIVED); wallet.priv = privOf(2); wallet.mode = 'eth';
  ethWallet.state = { address: ETH_ADDR, pubkey: DERIVED };
  localStorage.setItem('tacit-eth-identity:mainnet', JSON.stringify(ethWallet.state));
  T.setActiveWalletMode('eth');
}
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };

console.log('Ethereum key open, another local key saved');
reset(); openEth();
localStorage.setItem(LOCAL, blobFor(SAVED));
{
  const e1 = await err(wallet.regenerate());
  ok('New wallet refuses', /Another wallet \(bc1q.*\) is saved in this browser/.test(e1?.message || ''));
  ok('the refusal says nothing changed', /Nothing was changed/.test(e1?.message || ''));
  const e2 = await err(wallet.setPriv(bytesToHex(IMPORTED)));
  ok('Import key refuses', /Another wallet/.test(e2?.message || ''));
  ok('no passphrase asked', prompts === 0);
  ok('saved key untouched', JSON.parse(localStorage.getItem(LOCAL)).pub === SAVED);
  ok('Ethereum key still open', wallet.mode === 'eth' && bytesToHex(wallet.pub) === DERIVED && ethWallet.state?.address === ETH_ADDR);
  ok('Ethereum mode still pinned', getActiveWalletMode() === 'eth');
}

console.log('\nEthereum key open, no local key saved');
reset(); openEth();
{
  const e = await err(wallet.setPriv(bytesToHex(IMPORTED)));
  ok('Import key goes ahead', e === null);
  ok('one passphrase asked', prompts === 1);
  ok('imported key saved in the local slot', JSON.parse(localStorage.getItem(LOCAL) || '{}').pub === pubHexOf(IMPORTED));
  ok('imported key is the open one', bytesToHex(wallet.pub) === pubHexOf(IMPORTED));
  ok('Ethereum mode left: mode null, so the backup gate applies', wallet.mode === null);
  ok('Ethereum link record for this network dropped', ethWallet.state === null && localStorage.getItem('tacit-eth-identity:mainnet') === null);
  ok('local mode pinned for reload', getActiveWalletMode() === 'local');
}

console.log('\nThe open local key may be replaced (the page asks first)');
reset();
localStorage.setItem(LOCAL, blobFor(SAVED));
wallet.pub = hexToBytes(SAVED);
{
  const e = await err(wallet.regenerate());
  ok('New wallet goes ahead over the open key', e === null);
  const now = JSON.parse(localStorage.getItem(LOCAL) || '{}').pub;
  ok('slot holds the new key', /^0[23][0-9a-f]{64}$/.test(now) && now !== SAVED && now === bytesToHex(wallet.pub));
}

console.log('\nBitcoin-derived key open, a key saved for the connected address');
reset();
{
  const addr = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const slot = `tacit-wallet-v1:mainnet:by:${addr}`;
  localStorage.setItem(slot, blobFor(SAVED));
  extWallet.state = { provider: 'unisat', address: addr, pubkey: '02' + '11'.repeat(32), network: 'livenet' };
  wallet.pub = hexToBytes(DERIVED); wallet.mode = 'btc';
  btcWallet.state = { address: addr, provider: 'unisat', tacitPubkey: DERIVED, kind: 'ecdsa' };
  const e = await err(wallet.setPriv(bytesToHex(IMPORTED), addr));
  ok('Import key into the address slot refuses', /Another wallet/.test(e?.message || ''));
  ok('address slot untouched', JSON.parse(localStorage.getItem(slot)).pub === SAVED);
  ok('Bitcoin key still open', wallet.mode === 'btc' && btcWallet.state?.tacitPubkey === DERIVED);
}

console.log('\nSlots a key cannot be read from');
reset();
localStorage.setItem(LOCAL, JSON.stringify({ v: 1, kdf: 'pbkdf2', iter: 600000, salt: '00'.repeat(16), iv: '00'.repeat(12), ct: '00'.repeat(48) }));
{
  const e = await err(wallet.regenerate());
  ok('an encrypted key that names no pubkey is kept (unlock it first)', /Another wallet is saved/.test(e?.message || '') && !JSON.parse(localStorage.getItem(LOCAL)).pub);
}
reset();
localStorage.setItem(LOCAL, 'not a wallet');
{
  const e = await err(wallet.regenerate());
  ok('a slot holding no key is written', e === null && JSON.parse(localStorage.getItem(LOCAL) || '{}').pub === bytesToHex(wallet.pub));
}

clearInterval(autoFill);
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
