// dapp/tacit-wallet-known.js: every page offers the wallet tacit.finance is logged in with first, and a different key a
// page opened before only second.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const { siteWallet, rememberedWallet, knownWallets } = await import('../dapp/tacit-wallet-known.js');

const SITE = '03f88dcf3d6de510dcc50d134c678d9488c85e23036db9871b338cbc62d6cab07f';
const OTHER = '03570b5ef6f092377d51cb0686fae187b7d5ae5394d1012d5220cd1db13b184388';
const LITE = 'tacit-lite-id-v1';
const put = (k, v) => localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
const reset = () => store.clear();

test('the key tacit.finance saved comes first; a different key weld opened before is offered second', () => {
  reset();
  put('tacit-active-mode-v1', 'local');
  put('tacit-wallet-v1:mainnet', { pub: SITE, enc: 'x' });
  put('tacit-prf-v1', { mine: { pubkey: OTHER, credentialId: 'c', lastUsed: 2 } });
  put(LITE, { mode: 'passkey', pubHex: OTHER, label: 'mine', tacit: 'tacit1qzz…' });
  const { primary, other } = knownWallets([LITE]);
  assert.equal(primary.mode, 'local'); assert.equal(primary.pubHex, SITE);
  assert.equal(other.pubHex, OTHER); assert.equal(other.mode, 'passkey');
});

test("a page's own record of tacit.finance's key stands in for it, with nothing second", () => {
  reset();
  put('tacit-active-mode-v1', 'local');
  put('tacit-wallet-v1:mainnet', { pub: SITE });
  put(LITE, { mode: 'local', pubHex: SITE, tacit: 'tacit1qzzsite' });
  const { primary, other } = knownWallets([LITE]);
  assert.equal(primary.tacit, 'tacit1qzzsite'); assert.equal(other, null);
});

test('with no wallet on tacit.finance, the remembered key is the one offered', () => {
  reset();
  put(LITE, { mode: 'passkey', pubHex: OTHER, label: 'mine' });
  const { primary, other } = knownWallets([LITE]);
  assert.equal(primary.pubHex, OTHER); assert.equal(other, null);
});

test('tacit.finance restore order: eth and btc when active, passkey unless ext or local was chosen, then ext, then saved', () => {
  reset();
  put('tacit-prf-v1', { old: { pubkey: OTHER, lastUsed: 1 } });
  put('tacit-wallet-v1:mainnet', { pub: SITE });
  assert.equal(siteWallet().mode, 'passkey', 'no mode: the last passkey');
  put('tacit-active-mode-v1', 'local');
  assert.equal(siteWallet().mode, 'local', 'the saved key once it was chosen');
  put('tacit-active-mode-v1', 'eth');
  put('tacit-eth-identity:mainnet', { address: 'AbCd'.padEnd(40, '0'), pubkey: SITE.toUpperCase() });
  const e = siteWallet();
  assert.equal(e.mode, 'eth'); assert.equal(e.pubHex, SITE); assert.equal(e.address, '0x' + 'abcd'.padEnd(40, '0'));
  put('tacit-active-mode-v1', 'ext');
  put('tacit-ext-state-v1', { address: 'bc1qext' });
  put('tacit-wallet-v1:mainnet:by:bc1qext', { pub: OTHER });
  assert.equal(siteWallet().mode, 'ext');
  assert.equal(siteWallet().pubHex, OTHER);
});

test("tacit.finance's mainnet mode is read from its per-network record first, and a cleared one reads as none", () => {
  reset();
  put('tacit-prf-v1', { old: { pubkey: OTHER, lastUsed: 1 } });
  put('tacit-wallet-v1:mainnet', { pub: SITE });
  put('tacit-active-mode-v1', 'passkey');
  put('tacit-active-mode-v1:mainnet', 'local');
  put('tacit-active-mode-v1:signet', 'eth');
  assert.equal(siteWallet().mode, 'local', 'the mainnet record wins over the old single record');
  put('tacit-active-mode-v1:mainnet', '');
  assert.equal(siteWallet().mode, 'passkey', 'cleared on mainnet: the restore order with no mode');
});

test('a stale or pasted record is never offered', () => {
  reset();
  put('tacit-wallet-v1:mainnet', { pub: SITE });
  put(LITE, { mode: 'local', pubHex: OTHER });
  assert.equal(rememberedWallet([LITE]), null, 'a saved-key record whose key is no longer the saved one');
  put(LITE, { mode: 'key', pubHex: OTHER });
  assert.equal(rememberedWallet([LITE]), null, 'a pasted key');
  put('tacit-pay-hub-id-v1', { mode: 'eth', pubHex: OTHER, address: '0xabc' });
  assert.equal(rememberedWallet([LITE, 'tacit-pay-hub-id-v1']).pubHex, OTHER, 'the next page’s record is read when the first fails');
});

test('nothing known', () => {
  reset();
  assert.deepEqual(knownWallets([LITE]), { primary: null, other: null });
});
