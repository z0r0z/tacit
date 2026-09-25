// Linked-wallet identities are kept per network in dapp/tacit.js.
//
// The identity message names the network, so an Ethereum or Bitcoin wallet
// derives one key on mainnet and another on signet. Each network keeps its own
// record (`tacit-eth-identity:<net>`, `tacit-btc-identity:<net>`); switching
// networks asks for one signature on a network the wallet hasn't signed for
// yet, and never refuses. Also covers the one-time migration of the old
// unscoped records.
//
// A network switch reloads the page, so each "load" here imports a fresh copy
// of tacit.js over the same localStorage, then runs the same restore steps as
// init() (which __TACIT_NO_INIT__ skips).
//
// Run: `node tests/identity-per-network.test.mjs`

import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
globalThis.prompt = () => null;
globalThis.alert = () => {};
globalThis.confirm = () => false;
if (!globalThis.crypto) globalThis.crypto = dom.window.crypto;
if (!globalThis.atob) globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
if (!globalThis.btoa) globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'denied', json: async () => ({}) });
globalThis.__TACIT_NO_INIT__ = true;

import { secp, sha256, keccak_256, bytesToHex, hexToBytes, concatBytes } from '../dapp/vendor/tacit-deps.min.js';
import { prfBytesToScalar as toValidScalar } from '../dapp/prf-wallet.js';
import { identityMessage } from '../dapp/identity-message.js';
// Importing tacit.js once wires the hmac that secp.sign needs.
await import('../dapp/tacit.js');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond === true) { console.log(`  PASS  ${label}`); pass++; }
  else               { console.log(`  FAIL  ${label}`); fail++; }
};

const enc = new TextEncoder();
const pubOfPriv = (priv) => bytesToHex(secp.getPublicKey(priv, true));
const tacitPubFromSig = (sigBytes) => pubOfPriv(toValidScalar(sha256(sigBytes)));
const netOfMsg = (msg) => (/network: (\w+)/.exec(msg) || [])[1];

// ---- Ethereum: EIP-1193 provider that really signs (EIP-191) ----
function eip191Hash(msg) {
  const b = enc.encode(msg);
  return keccak_256(concatBytes(enc.encode(`\x19Ethereum Signed Message:\n${b.length}`), b));
}
const ethAddrOf = (priv) => bytesToHex(keccak_256(secp.getPublicKey(priv, false).slice(1)).slice(12));
function personalSign(priv, msg) {
  const sig = secp.sign(eip191Hash(msg), priv);
  return '0x' + bytesToHex(sig.toCompactRawBytes()) + (sig.recovery + 27).toString(16).padStart(2, '0');
}
const ETH_PRIV = sha256(enc.encode('identity-per-network eth signer'));
const ETH_ADDR = ethAddrOf(ETH_PRIV);
const ethKeyFor = (net) => tacitPubFromSig(hexToBytes(personalSign(ETH_PRIV, identityMessage({ netName: net })).slice(2)));

const ethSigns = []; // network named in each personal_sign
window.ethereum = {
  request: async ({ method, params }) => {
    if (method === 'eth_getCode') return '0x';
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0x' + ETH_ADDR];
    if (method === 'personal_sign') {
      const msg = new TextDecoder().decode(hexToBytes(String(params[0]).slice(2)));
      ethSigns.push(netOfMsg(msg));
      return personalSign(ETH_PRIV, msg);
    }
    throw new Error('unexpected method ' + method);
  },
};

// ---- Bitcoin: UniSat signer, deterministic per message ----
const BTC_ADDR = 'bc1qidentitypernetworktestxxxxxxxxxxxxxxx';
const btcSigFor = (msg) => { const h = sha256(enc.encode('btc-signer|' + msg)); return concatBytes(h, h.slice(0, 33)); };
const btcKeyFor = (net) => tacitPubFromSig(btcSigFor(identityMessage({ netName: net })));
const btcSigns = [];
window.unisat = {
  signMessage: async (msg, kind) => {
    btcSigns.push(netOfMsg(msg) + '/' + kind);
    return Buffer.from(btcSigFor(msg)).toString('base64');
  },
};
const EXT_STATE = { provider: 'unisat', address: BTC_ADDR, pubkey: '02' + 'ab'.repeat(32), network: 'mainnet' };

// ---- one page load on `net` ----
let loads = 0;
async function load(net) {
  localStorage.setItem('tacit-network-v1', net);
  const T = await import(`../dapp/tacit.js?load=${++loads}`);
  const { wallet, ethWallet, btcWallet, extWallet } = T;
  // Same restore steps as init().
  const mode = T.getActiveWalletMode();
  if (mode === 'eth') {
    const r = ethWallet.tryRestore();
    if (r?.pubkey) { wallet.pub = hexToBytes(r.pubkey); wallet.mode = 'eth'; }
    else if (r?.address) wallet.mode = 'eth';
  }
  if (mode === 'btc') {
    const r = btcWallet.tryRestore();
    if (r?.tacitPubkey) { await extWallet.tryRestore(); wallet.pub = hexToBytes(r.tacitPubkey); wallet.mode = 'btc'; }
    else if (r?.address) { await extWallet.tryRestore(); wallet.mode = 'btc'; }
  }
  return T;
}
const pubHexOf = (T) => (T.wallet.pub ? bytesToHex(T.wallet.pub) : null);
async function unlock(T) {
  try { await T.ensurePrivkey(); return null; }
  catch (e) { return e; }
}
const refused = (e) => !!e && /signature changed|refusing/i.test(e.message || '');
const rec = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
function freshStorage() {
  localStorage.clear();
  ethSigns.length = 0;
  btcSigns.length = 0;
}

const ETH_MAIN = ethKeyFor('mainnet');
const ETH_SIG = ethKeyFor('signet');
const BTC_MAIN = btcKeyFor('mainnet');
const BTC_SIG = btcKeyFor('signet');
ok('the two networks derive different keys (premise)', ETH_MAIN !== ETH_SIG && BTC_MAIN !== BTC_SIG);

console.log('\nEthereum wallet: link on mainnet, switch to signet, switch back');
freshStorage();
{
  let T = await load('mainnet');
  await T.ethWallet.login();
  ok('linked on mainnet with the mainnet key', pubHexOf(T) === ETH_MAIN);
  ok('record stored under tacit-eth-identity:mainnet', rec('tacit-eth-identity:mainnet')?.pubkey === ETH_MAIN);
  ok('no unscoped record written', localStorage.getItem('tacit-eth-identity') === null);

  ethSigns.length = 0;
  T = await load('signet');
  ok('signet load stays linked (eth mode, no key yet)', T.wallet.mode === 'eth' && T.wallet.pub === null);
  ok('signet load shows the linked account', T.ethWallet.state?.address === ETH_ADDR);
  ok('no signature asked at load', ethSigns.length === 0);
  const e = await unlock(T);
  ok('signet unlock succeeds', e === null);
  ok('signet unlock never refuses', !refused(e));
  ok('signet unlock asks for exactly one signature, over the signet message', ethSigns.length === 1 && ethSigns[0] === 'signet');
  ok('signet key is the signet derivation', pubHexOf(T) === ETH_SIG && !!T.wallet.priv);
  ok('signet record stored', rec('tacit-eth-identity:signet')?.pubkey === ETH_SIG);
  ok('mainnet record untouched', rec('tacit-eth-identity:mainnet')?.pubkey === ETH_MAIN);

  ethSigns.length = 0;
  T = await load('mainnet');
  ok('mainnet load restores the mainnet key with no prompt', pubHexOf(T) === ETH_MAIN && ethSigns.length === 0);
  const e2 = await unlock(T);
  ok('mainnet unlock succeeds (one signature, as before)', e2 === null && ethSigns.length === 1 && ethSigns[0] === 'mainnet');
  ok('mainnet key unchanged', pubHexOf(T) === ETH_MAIN);

  ethSigns.length = 0;
  T = await load('signet');
  ok('signet reload restores the signet key with no prompt', pubHexOf(T) === ETH_SIG && ethSigns.length === 0);
  const e3 = await unlock(T);
  ok('signet re-unlock succeeds with one signature', e3 === null && ethSigns.length === 1 && pubHexOf(T) === ETH_SIG);

  // Same-network drift is still refused for a record whose network is known.
  T = await load('signet');
  T.ethWallet.state = { address: ETH_ADDR, pubkey: ETH_MAIN };
  const e4 = await unlock(T);
  ok('a different key on the same network is still refused', refused(e4));
}

console.log('\nBitcoin wallet (UniSat): link on mainnet, switch to signet, switch back');
freshStorage();
{
  let T = await load('mainnet');
  T.extWallet.state = { ...EXT_STATE };
  localStorage.setItem('tacit-ext-state-v1', JSON.stringify(EXT_STATE));
  await T.btcWallet.enroll();
  ok('enrolled on mainnet with the mainnet key (two signatures)', pubHexOf(T) === BTC_MAIN && btcSigns.length === 2);
  ok('anchor stored under tacit-btc-identity:mainnet', rec('tacit-btc-identity:mainnet')?.tacitPubkey === BTC_MAIN);

  btcSigns.length = 0;
  T = await load('signet');
  ok('signet load stays linked (btc mode, no key yet)', T.wallet.mode === 'btc' && T.wallet.pub === null);
  const e = await unlock(T);
  ok('signet unlock succeeds', e === null);
  ok('signet unlock never refuses', !refused(e));
  ok('signet unlock asks for exactly one signature, same protocol', btcSigns.length === 1 && btcSigns[0] === 'signet/ecdsa');
  ok('signet key is the signet derivation', pubHexOf(T) === BTC_SIG);
  ok('signet anchor stored', rec('tacit-btc-identity:signet')?.tacitPubkey === BTC_SIG);
  ok('mainnet anchor untouched', rec('tacit-btc-identity:mainnet')?.tacitPubkey === BTC_MAIN);

  btcSigns.length = 0;
  T = await load('mainnet');
  ok('mainnet load restores the mainnet key with no prompt', pubHexOf(T) === BTC_MAIN && btcSigns.length === 0);
  const e2 = await unlock(T);
  ok('mainnet unlock: one signature, key unchanged', e2 === null && btcSigns.length === 1 && pubHexOf(T) === BTC_MAIN);
}

console.log('\nMigration of the unscoped records');

// Legacy ETH record made on mainnet, user now on signet. Network unknown, so it
// goes to mainnet marked unverified; signet asks for one signature.
freshStorage();
localStorage.setItem('tacit-eth-identity', JSON.stringify({ address: ETH_ADDR, pubkey: ETH_MAIN }));
localStorage.setItem('tacit-active-mode-v1', 'eth');
{
  let T = await load('signet');
  ok('legacy ETH record filed under mainnet', rec('tacit-eth-identity:mainnet')?.pubkey === ETH_MAIN);
  ok('marked netUnverified', rec('tacit-eth-identity:mainnet')?.netUnverified === true);
  ok('nothing filed under signet', rec('tacit-eth-identity:signet') === null);
  ok('unscoped record kept as a copy', rec('tacit-eth-identity')?.pubkey === ETH_MAIN);
  ok('signet load is linked, awaiting a signature', T.wallet.mode === 'eth' && T.wallet.pub === null);
  const e = await unlock(T);
  ok('signet unlock: one signature, signet key, no refusal', e === null && ethSigns.length === 1 && pubHexOf(T) === ETH_SIG);

  ethSigns.length = 0;
  T = await load('mainnet');
  ok('mainnet load shows the migrated key', pubHexOf(T) === ETH_MAIN);
  const e2 = await unlock(T);
  ok('mainnet unlock matches, no refusal', e2 === null && pubHexOf(T) === ETH_MAIN);
  ok('mainnet record now verified', rec('tacit-eth-identity:mainnet')?.netUnverified === undefined);
}

// Legacy ETH record actually made on signet: filed under mainnet (unknown), so
// a mainnet unlock derives a different key. It is taken as mainnet's, and the
// old record moves to signet, instead of being refused.
freshStorage();
localStorage.setItem('tacit-eth-identity', JSON.stringify({ address: ETH_ADDR, pubkey: ETH_SIG }));
localStorage.setItem('tacit-active-mode-v1', 'eth');
{
  let T = await load('mainnet');
  const e = await unlock(T);
  ok('mainnet unlock of a signet-made record is not refused', e === null && !refused(e));
  ok('mainnet gets its own key', pubHexOf(T) === ETH_MAIN && rec('tacit-eth-identity:mainnet')?.pubkey === ETH_MAIN);
  ok('mainnet record now verified', rec('tacit-eth-identity:mainnet')?.netUnverified === undefined);
  ok('old record moved to signet', rec('tacit-eth-identity:signet')?.pubkey === ETH_SIG);

  ethSigns.length = 0;
  T = await load('signet');
  ok('signet load restores the old key with no prompt', pubHexOf(T) === ETH_SIG && ethSigns.length === 0);
  const e2 = await unlock(T);
  ok('signet unlock matches, no refusal', e2 === null && pubHexOf(T) === ETH_SIG);
  ok('signet record now verified', rec('tacit-eth-identity:signet')?.netUnverified === undefined);
}

// Secret Sats' per-network record holds the same key: the network is known.
freshStorage();
localStorage.setItem('tacit-eth-identity', JSON.stringify({ address: ETH_ADDR, pubkey: ETH_SIG }));
localStorage.setItem('tacit-sats-id-v1:signet', JSON.stringify({ mode: 'eth', address: ETH_ADDR, pubkey: ETH_SIG }));
await load('mainnet');
ok('ETH record matched by the sats page goes to signet, verified',
  rec('tacit-eth-identity:signet')?.pubkey === ETH_SIG && rec('tacit-eth-identity:signet')?.netUnverified === undefined
  && rec('tacit-eth-identity:mainnet') === null);

// Bitcoin records name their network through the address.
freshStorage();
localStorage.setItem('tacit-btc-identity', JSON.stringify({ address: 'tb1qsignetaddrxxxxxxxxxxxxxxxxxxxxxxxxxxx', provider: 'unisat', btcPubkey: '02' + 'cd'.repeat(32), tacitPubkey: BTC_SIG, kind: 'ecdsa' }));
await load('mainnet');
ok('tb1 BTC record goes to signet, verified', rec('tacit-btc-identity:signet')?.tacitPubkey === BTC_SIG && !rec('tacit-btc-identity:signet')?.netUnverified && rec('tacit-btc-identity:mainnet') === null);

freshStorage();
localStorage.setItem('tacit-btc-identity', JSON.stringify({ address: BTC_ADDR, provider: 'unisat', btcPubkey: EXT_STATE.pubkey, tacitPubkey: BTC_MAIN, kind: 'ecdsa' }));
localStorage.setItem('tacit-active-mode-v1', 'btc');
localStorage.setItem('tacit-ext-state-v1', JSON.stringify(EXT_STATE));
{
  let T = await load('signet');
  ok('bc1 BTC record goes to mainnet', rec('tacit-btc-identity:mainnet')?.tacitPubkey === BTC_MAIN && rec('tacit-btc-identity:signet') === null);
  const e = await unlock(T);
  ok('signet unlock after BTC migration: one signature, signet key, no refusal', e === null && btcSigns.length === 1 && pubHexOf(T) === BTC_SIG);
}

// Runs once, and never overwrites a per-network record.
freshStorage();
localStorage.setItem('tacit-eth-identity:mainnet', JSON.stringify({ address: ETH_ADDR, pubkey: ETH_MAIN }));
localStorage.setItem('tacit-eth-identity', JSON.stringify({ address: ETH_ADDR, pubkey: ETH_SIG }));
await load('mainnet');
ok('existing per-network record not overwritten', rec('tacit-eth-identity:mainnet')?.pubkey === ETH_MAIN && !rec('tacit-eth-identity:mainnet')?.netUnverified);
ok('migration marked done', localStorage.getItem('tacit-identity-per-net-v1') === '1');
localStorage.removeItem('tacit-eth-identity:mainnet');
await load('mainnet');
ok('migration does not run a second time', rec('tacit-eth-identity:mainnet') === null);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
