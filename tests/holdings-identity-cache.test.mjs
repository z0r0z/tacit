// Holdings caches follow the open key in dapp/tacit.js.
//
// A scan still running for key A is never handed to key B, its result is not cached once B is open, and a cache read
// for one key is never served to another. The switch here is a real one: an Ethereum wallet signs in (ethWallet.login),
// which goes through the same identity-change path as a passkey, a Bitcoin wallet, an extension rebind or a key import.
//
// Run: `node tests/holdings-identity-cache.test.mjs`

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.location = dom.window.location;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;
globalThis.__TACIT_NO_INIT__ = true;
localStorage.setItem('tacit-network-v1', 'mainnet');

const gates = new Map();   // address -> { promise, release }
const utxoCalls = [];
globalThis.fetch = async (input) => {
  const url = String(input?.url ?? input);
  const m = /\/address\/([a-z0-9]+)\/utxo$/.exec(url);
  if (m) {
    utxoCalls.push(m[1]);
    const g = gates.get(m[1]);
    if (g) await g.promise;
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error('offline: ' + url);
};
const gate = (addr) => { let release; const promise = new Promise((r) => { release = r; }); gates.set(addr, { promise, release }); return release; };

const { secp, sha256, keccak_256, bytesToHex, hexToBytes, concatBytes } = await import('../dapp/vendor/tacit-deps.min.js');
const T = await import('../dapp/tacit.js');
const { wallet, ethWallet } = T;

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
};
const settle = (p) => p.then((v) => ({ v }), (e) => ({ e }));

// An Ethereum wallet that really signs (EIP-191), so ethWallet.login derives key B.
const enc = new TextEncoder();
const ETH_PRIV = sha256(enc.encode('holdings-identity-cache eth signer'));
const ETH_ADDR = bytesToHex(keccak_256(secp.getPublicKey(ETH_PRIV, false).slice(1)).slice(12));
window.ethereum = {
  request: async ({ method, params }) => {
    if (method === 'eth_getCode') return '0x';
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x' + ETH_ADDR];
    if (method === 'personal_sign') {
      const b = hexToBytes(String(params[0]).slice(2));
      const h = keccak_256(concatBytes(enc.encode(`\x19Ethereum Signed Message:\n${b.length}`), b));
      const sig = secp.sign(h, ETH_PRIV);
      return '0x' + bytesToHex(sig.toCompactRawBytes()) + (sig.recovery + 27).toString(16).padStart(2, '0');
    }
    throw new Error('unexpected method ' + method);
  },
};

const privA = new Uint8Array(32); privA[31] = 7;
wallet.priv = privA; wallet.pub = secp.getPublicKey(privA, true); wallet.mode = null;
const addrA = wallet.address();

console.log('A scan running for key A when key B opens');
const releaseA = gate(addrA);
const scanA = settle(T.scanHoldings());
for (let i = 0; i < 500 && !utxoCalls.includes(addrA); i++) await new Promise((r) => setTimeout(r, 20));
ok('key A scan is reading A\'s address', utxoCalls.includes(addrA));
await ethWallet.login();
const addrB = wallet.address();
ok('key B is open', wallet.mode === 'eth' && addrB !== addrA);
const pB = T.scanHoldings();
const resB = await pB;
ok('key B gets a scan of its own address', utxoCalls.includes(addrB) && resB instanceof Map);
releaseA();
const a = await scanA;
ok('key A\'s scan, finished after the switch, returns nothing', !!a.e && /open wallet changed/.test(a.e.message));
ok('the cache serves key B\'s result', (await T.scanHoldings()) === resB);

console.log('\nA cache read for another key is not served');
T._testInjectHoldingsCache({ pubHex: bytesToHex(secp.getPublicKey(privA, true)), net: 'mainnet', fetchedAt: Date.now(), holdings: new Map([['aa'.repeat(32), { balance: 5n, utxos: [] }]]) });
const r = await T.scanHoldings();
ok('key B is not shown key A\'s cached holdings', r instanceof Map && r.size === 0);

console.log('\nLocking out (key B closed) drops B\'s cache');
const resB2 = await T.scanHoldings();
ethWallet.lock();
wallet.priv = privA; wallet.pub = secp.getPublicKey(privA, true);
const resA2 = await T.scanHoldings();
ok('key A scans afresh rather than reading key B\'s cache', resA2 !== resB2 && utxoCalls[utxoCalls.length - 1] === addrA);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
