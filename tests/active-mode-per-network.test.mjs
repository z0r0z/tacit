// The wallet mode init() restores is kept per network in dapp/tacit.js (`tacit-active-mode-v1:<net>`).
//
// A choice made on one network never hides a wallet saved for the other: a network with no choice of its own uses an
// Ethereum or Bitcoin link from the other network only when it has no wallet saved in this browser. Disconnect /
// Forget clears the choice for its network only. The single record kept before is moved once.
//
// A network switch reloads the page, so each "load" imports a fresh copy of tacit.js over the same localStorage.
//
// Run: `node tests/active-mode-per-network.test.mjs`

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
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'denied', json: async () => ({}) });
globalThis.__TACIT_NO_INIT__ = true;

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
};
let loads = 0;
async function load(net) {
  localStorage.setItem('tacit-network-v1', net);
  return import(`../dapp/tacit.js?load=${++loads}`);
}
const PUB_A = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const PUB_B = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';
const blob = (pub) => JSON.stringify({ v: 1, kdf: 'pbkdf2', iter: 600000, salt: '00', iv: '00', ct: '00', pub });
const ETH = { address: 'ab'.repeat(20), pubkey: PUB_B };
const fresh = () => { localStorage.clear(); localStorage.setItem('tacit-identity-per-net-v1', '1'); };

console.log('Ethereum linked on signet, a local wallet saved on mainnet (the single record said eth)');
fresh();
localStorage.setItem('tacit-active-mode-v1', 'eth');
localStorage.setItem('tacit-eth-identity:signet', JSON.stringify(ETH));
localStorage.setItem('tacit-wallet-v1:mainnet', blob(PUB_A));
{
  let T = await load('mainnet');
  ok('mainnet opens its saved wallet', T.getActiveWalletMode() === 'local');
  ok('old record moved and removed', localStorage.getItem('tacit-active-mode-v1') === null);
  T = await load('signet');
  ok('signet keeps the Ethereum link', T.getActiveWalletMode() === 'eth');
  T = await load('mainnet');
  ok('mainnet still opens its saved wallet after a round trip', T.getActiveWalletMode() === 'local');
}

console.log('\nThe single record said eth and the link already holds a verified key on mainnet');
fresh();
localStorage.setItem('tacit-active-mode-v1', 'eth');
localStorage.setItem('tacit-eth-identity:mainnet', JSON.stringify(ETH));
localStorage.setItem('tacit-wallet-v1:mainnet', blob(PUB_A));
{
  const T = await load('mainnet');
  ok('mainnet keeps the link it signed for', T.getActiveWalletMode() === 'eth');
}

console.log('\nA link made after the move');
fresh();
{
  let T = await load('signet');
  T.setActiveWalletMode('eth');
  ok('signet records eth for itself only', localStorage.getItem('tacit-active-mode-v1:signet') === 'eth' && localStorage.getItem('tacit-active-mode-v1:mainnet') === null);
  localStorage.setItem('tacit-wallet-v1:mainnet', blob(PUB_A));
  T = await load('mainnet');
  ok('mainnet with a saved wallet does not take the signet link', T.getActiveWalletMode() === null);
  localStorage.removeItem('tacit-wallet-v1:mainnet');
  T = await load('mainnet');
  ok('mainnet with nothing saved uses the signet link (one signature derives its key)', T.getActiveWalletMode() === 'eth');
  T.setActiveWalletMode('local');
  T = await load('signet');
  ok('a choice on mainnet leaves signet as it was', T.getActiveWalletMode() === 'eth');
}

console.log('\nDisconnect on one network');
fresh();
localStorage.setItem('tacit-active-mode-v1:mainnet', 'eth');
localStorage.setItem('tacit-active-mode-v1:signet', 'eth');
{
  let T = await load('signet');
  T.clearActiveWalletMode();
  T = await load('signet');
  ok('signet has no mode and does not take the mainnet link back', T.getActiveWalletMode() === null);
  T = await load('mainnet');
  ok('mainnet keeps its link', T.getActiveWalletMode() === 'eth');
}

console.log('\nOther single records');
fresh();
localStorage.setItem('tacit-active-mode-v1', 'local');
localStorage.setItem('tacit-wallet-v1:signet', blob(PUB_A));
{
  let T = await load('mainnet');
  ok('local: kept on the network with a local key', localStorage.getItem('tacit-active-mode-v1:signet') === 'local');
  ok('local: nothing pinned where no key is saved', T.getActiveWalletMode() === null && localStorage.getItem('tacit-active-mode-v1:mainnet') === null);
}
fresh();
localStorage.setItem('tacit-active-mode-v1', 'passkey');
localStorage.setItem('tacit-wallet-v1:mainnet', blob(PUB_A));
{
  const T = await load('mainnet');
  ok('passkey: kept on both networks', T.getActiveWalletMode() === 'passkey' && localStorage.getItem('tacit-active-mode-v1:signet') === 'passkey');
}
fresh();
localStorage.setItem('tacit-active-mode-v1', 'btc');
localStorage.setItem('tacit-ext-state-v1', JSON.stringify({ provider: 'unisat', address: 'bc1qextaddr', pubkey: '02' + '11'.repeat(32) }));
localStorage.setItem('tacit-wallet-v1:mainnet:by:bc1qextaddr', blob(PUB_A));
{
  const T = await load('mainnet');
  ok('btc with no verified key here: the network opens the key saved for the extension address', T.getActiveWalletMode() === 'ext');
  ok('btc kept on the network with nothing saved', localStorage.getItem('tacit-active-mode-v1:signet') === 'btc');
}
fresh();
localStorage.setItem('tacit-active-mode-v1', 'local');
localStorage.setItem('tacit-ext-state-v1', JSON.stringify({ provider: 'unisat', address: 'bc1qextaddr', pubkey: '02' + '11'.repeat(32) }));
localStorage.setItem('tacit-wallet-v1:mainnet:by:bc1qextaddr', blob(PUB_B));
localStorage.setItem('tacit-wallet-v1:mainnet', blob(PUB_A));
{
  const T = await load('mainnet');
  ok('local with an extension wallet also saved: the local wallet still opens', T.getActiveWalletMode() === 'local');
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
