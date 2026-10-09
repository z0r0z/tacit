// Key copies in memory (dapp/confidential-pool-ux.js, dapp/tacit.js).
//
// The pool helpers keep the wallet keys identity() was handed (for the recovery guard) and caches read with them. Their
// keys are pubkey-derived, never the private key itself, and forgetKeys() empties every instance; tacit.js calls it on
// lock, forget and any key switch. A key derived for a refused Ethereum or Bitcoin unlock is zeroed before the refusal.
//
// Run: `node tests/key-hygiene.test.mjs`

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;
globalThis.fetch = async () => { throw new Error('offline'); };
globalThis.__TACIT_NO_INIT__ = true;
localStorage.setItem('tacit-network-v1', 'mainnet');

const { secp, sha256, keccak_256, bytesToHex } = await import('../dapp/vendor/tacit-deps.min.js');
const { makeConfidentialPoolUx, forgetKeys } = await import('../dapp/confidential-pool-ux.js');
const T = await import('../dapp/tacit.js');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
};

const priv = new Uint8Array(32); priv[31] = 21;
const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'mainnet' });
const ux2 = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, network: 'mainnet' });
const id = ux.identity(priv);
ux2.identity(priv);
ok('identity() hands back the pubkey', /^0x0[23][0-9a-f]{64}$/.test(id.pubHex));
ok('forgetKeys is exported, and each instance has its own', typeof forgetKeys === 'function' && typeof ux.forgetKeys === 'function' && typeof ux2.forgetKeys === 'function');
forgetKeys();
const src = (await import('node:fs')).readFileSync(new URL('../dapp/confidential-pool-ux.js', import.meta.url), 'utf8');
ok('the history cache is keyed by a pubkey hash, not the private key', /const key = _hex\(sha256\(secp\.getPublicKey\(privBytes\(priv\), true\)\)\);/.test(src) && !/const key = _hex\(privBytes\(priv\)\)/.test(src));
ok('the bridge-mint memo is keyed by the pubkey', /const wk = lc\(id\.pubHex\);/.test(src) && !/_hex\(privBytes\(id\.priv\)\)/.test(src));
ok('forgetKeys clears the key map and the caches read with it', /const forget = \(\) => \{ _ownKeys\.clear\(\); _btcHistoryCache\.clear\(\); _bridgeFound\.clear\(\); \};/.test(src));

console.log('\ntacit.js: lock, key switch and refused unlocks');
const tsrc = (await import('node:fs')).readFileSync(new URL('../dapp/tacit.js', import.meta.url), 'utf8');
ok('the lock button forgets the pool helpers\' copies', /\/\/ The pool helpers' copies of the key go too, so locking forgets every one\.\n\s+try \{ forgetPoolKeys\(\); \} catch \{\}/.test(tsrc));
ok('every identity change forgets them', /function _onIdentityChanged\(prevPubHex\) \{[\s\S]{0,600}forgetPoolKeys\(\)/.test(tsrc));
ok('a refused Ethereum unlock zeroes its key first', /if \(!this\.state\.netUnverified\) \{\n\s+priv\.fill\(0\);/.test(tsrc));
ok('a refused Bitcoin unlock zeroes its key first', /if \(!cached\.netUnverified\) \{\n\s+priv\.fill\(0\);/.test(tsrc));

// Behaviour of the refusal: an Ethereum account whose signature now derives a different key.
const enc = new TextEncoder();
const ETH_PRIV = sha256(enc.encode('key-hygiene eth signer'));
const ETH_ADDR = bytesToHex(keccak_256(secp.getPublicKey(ETH_PRIV, false).slice(1)).slice(12));
const derived = [];
window.ethereum = {
  request: async ({ method, params }) => {
    if (method === 'eth_getCode') return '0x';
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x' + ETH_ADDR];
    if (method === 'personal_sign') {
      const b = new Uint8Array(String(params[0]).slice(2).match(/../g).map((h) => parseInt(h, 16)));
      const h = keccak_256(new Uint8Array([...enc.encode(`\x19Ethereum Signed Message:\n${b.length}`), ...b]));
      const sig = secp.sign(h, ETH_PRIV);
      return '0x' + bytesToHex(sig.toCompactRawBytes()) + (sig.recovery + 27).toString(16).padStart(2, '0');
    }
    throw new Error('unexpected ' + method);
  },
};
const realDerive = T.ethWallet.deriveKey.bind(T.ethWallet);
T.ethWallet.deriveKey = async (...a) => { const r = await realDerive(...a); derived.push(r.priv); return r; };
T.ethWallet.state = { address: ETH_ADDR, pubkey: '02' + '33'.repeat(32) };   // the key it derived before
let err = null;
try { await T.ethWallet.login({ address: ETH_ADDR }); } catch (e) { err = e; }
ok('the changed signature is refused', /refusing to derive a different identity/.test(err?.message || ''));
ok('the key it derived is zeroed', derived.length >= 1 && derived.every((p) => p.every((b) => b === 0)));
ok('no key is left open', T.wallet.priv === null && T.wallet.pub === null);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
