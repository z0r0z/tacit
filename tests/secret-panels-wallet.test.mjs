// The Secret Sats panels (dapp/sats/secret.js mount, mountMainnet) hold the pool wallet of the open key rather than making it again for every render and action (about fifteen
// milliseconds each: it was made seventeen times for an unlock and ten renders). Mounted with a stand-in for the wallet's page: the wallet is made once for the key that is open, again only for
// a different key or after a lock, and a lock lets it go. Whatever the panels do, the wallet they use is the one poolWalletFor makes for the key.
//   node tests/secret-panels-wallet.test.mjs
import assert from 'node:assert/strict';
import { JSDOM } from './_jsdom.mjs';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.localStorage = dom.window.localStorage; globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.fetch = async (u) => { throw new Error('offline ' + String(u).slice(0, 60)); };
const S = await import('../dapp/sats/secret.js');

let derived = 0;
const real = S.pool.walletFromSeed.bind(S.pool);
S.pool.walletFromSeed = (...a) => { derived++; return real(...a); };
const key = (n) => Uint8Array.from({ length: 32 }, (_, i) => (n * 11 + i + 1) & 255);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const pubOf = (n) => Uint8Array.of(2, ...Array.from({ length: 32 }, (_, i) => (n * 5 + i) & 255));
const tick = () => new Promise((r) => setTimeout(r, 30));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

for (const [label, mountOf, network] of [['mainnet', S.mountMainnet, 'mainnet'], ['signet', S.mount, 'signet']]) {
  await test(`${label}: an unlock, ten renders, a lock and the same key unlocked again, then another key`, async () => {
    const listeners = new Set();
    const T = { NET: { name: network, explorer: 'https://mempool.space', api: 'http://x', api2: '' }, bytesToHex: hex };
    const ctx = { tacit: T, network, wallet: { priv: key(1), pub: pubOf(1) }, onWallet: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, log() {}, toast() {}, errMsg: (e) => String(e?.message || e), ensureKey: async () => {}, hold: () => () => {} };
    const root = document.createElement('div'); document.body.append(root);
    derived = 0;
    const api = mountOf(root, ctx);
    const emit = (d) => { for (const fn of listeners) fn(d); };
    const unlocked = (n) => ({ connected: true, unlocked: true, pubHex: hex(pubOf(n)) });
    emit(unlocked(1)); await tick();
    for (let i = 0; i < 10; i++) api.render();
    assert.ok(derived <= 1, `${label}: the wallet was made ${derived} times for an unlock and ten renders`);
    const first = derived;
    // a lock: no key, nothing made, nothing used
    ctx.wallet.priv = null; ctx.wallet.pub = null;
    emit({ connected: false, unlocked: false, pubHex: null }); await tick();
    for (let i = 0; i < 5; i++) api.render();
    assert.strictEqual(derived, first, `${label}: a locked wallet makes nothing`);
    // the same key unlocked again (a new array, as the wallet makes it): made again, once
    ctx.wallet = { priv: key(1), pub: pubOf(1) };
    emit(unlocked(1)); await tick();
    for (let i = 0; i < 10; i++) api.render();
    assert.ok(derived - first <= 1, `${label}: ${derived - first} made after the unlock`);
    // another key: made again, once
    const second = derived;
    ctx.wallet = { priv: key(2), pub: pubOf(2) };
    emit(unlocked(2)); await tick();
    for (let i = 0; i < 10; i++) api.render();
    assert.ok(derived - second <= 1, `${label}: ${derived - second} made for the other key`);
    root.remove();
  });
}

console.log(`\n${passed} passed`);
process.exit(0);
