// The pool wallet the Secret Sats panels use (dapp/sats/secret.js poolWalletHolder): made once for as long as the key is open, as it was made again on every render and every action (about
// fifteen milliseconds each, and the note scan keeps what it read for each wallet object), and never past the key: a different key is a different wallet, and it is let go when the key is
// locked, zeroed under it, or changes.
//   node tests/secret-pool-wallet-holder.test.mjs
import assert from 'node:assert/strict';
import { JSDOM } from './_jsdom.mjs';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.localStorage = dom.window.localStorage;
const S = await import('../dapp/sats/secret.js');

let derived = 0;
const real = S.pool.walletFromSeed.bind(S.pool);
S.pool.walletFromSeed = (...a) => { derived++; return real(...a); };
const key = (n) => Uint8Array.from({ length: 32 }, (_, i) => (n * 7 + i + 1) & 255);
const open = (n) => ({ priv: key(n), pub: Uint8Array.of(2, n) });
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

await test('asked again and again for the same open key, it is the same wallet, made once', () => {
  const ctx = { wallet: open(1) }, get = S.poolWalletHolder(ctx, () => 'mainnet');
  derived = 0;
  const a = get();
  for (let i = 0; i < 50; i++) assert.strictEqual(get(), a);
  assert.strictEqual(derived, 1);
  assert.strictEqual(a.network, 'mainnet');
  assert.deepStrictEqual(a, S.poolWalletFor(ctx.wallet.priv, 'mainnet'), 'and it is the wallet poolWalletFor makes');
});

await test('no key, no wallet: a locked wallet gives null and nothing is kept', () => {
  const ctx = { wallet: open(2) }, get = S.poolWalletHolder(ctx, () => 'signet');
  const a = get();
  assert.ok(a);
  ctx.wallet.priv = null; ctx.wallet.pub = null;
  assert.strictEqual(get(), null);
  ctx.wallet = null;
  assert.strictEqual(get(), null);
  ctx.wallet = open(2);                                      // the same key unlocked again, as a new array
  derived = 0;
  const b = get();
  assert.notStrictEqual(b, a, 'a wallet made after the lock is a new one');
  assert.strictEqual(derived, 1);
});

await test('a different key is a different wallet, and the same key as a new array is made again, not carried over', () => {
  const ctx = { wallet: open(3) }, get = S.poolWalletHolder(ctx, () => 'mainnet');
  const a = get();
  ctx.wallet = open(4);
  const b = get();
  assert.notStrictEqual(b, a);
  assert.notStrictEqual(b.addressString, a.addressString);
  assert.strictEqual(get(), b);
  ctx.wallet = { priv: key(4), pub: ctx.wallet.pub };       // the same bytes, an array the wallet made anew
  derived = 0;
  const c = get();
  assert.notStrictEqual(c, b);
  assert.strictEqual(c.addressString, b.addressString);
  assert.strictEqual(derived, 1);
  ctx.wallet = { priv: ctx.wallet.priv, pub: Uint8Array.of(2, 99) };       // the key kept, the public key replaced: not the same open key
  assert.notStrictEqual(get(), c);
});

await test('a key zeroed under the wallet is a key that is gone: null, and what was held is let go', () => {
  const ctx = { wallet: open(5) }, get = S.poolWalletHolder(ctx, () => 'mainnet');
  const a = get();
  assert.ok(a);
  ctx.wallet.priv.fill(0);                                   // zeroed, the reference still there
  assert.strictEqual(get(), null);
  ctx.wallet.priv = key(5);                                  // a new array of the same key (as the wallet does on unlock)
  derived = 0;
  assert.notStrictEqual(get(), a);
  assert.strictEqual(derived, 1, 'made again: the old one was not kept');
});

await test('drop() lets go at once, and each holder has its own, per network', () => {
  const ctx = { wallet: open(6) };
  const main = S.poolWalletHolder(ctx, () => 'mainnet'), sig = S.poolWalletHolder(ctx, () => 'signet');
  derived = 0;
  const m = main(), s = sig();
  assert.notStrictEqual(m, s);
  assert.strictEqual(m.network, 'mainnet');
  assert.strictEqual(s.network, 'signet');
  assert.strictEqual(derived, 2);
  main.drop();
  derived = 0;
  assert.notStrictEqual(main(), m);
  assert.strictEqual(sig(), s, 'the other holder is untouched');
  assert.strictEqual(derived, 1);
  let net = 'signet';
  const flip = S.poolWalletHolder(ctx, () => net);
  const f1 = flip(); net = 'mainnet'; const f2 = flip();
  assert.notStrictEqual(f1, f2, 'a network that changes is another wallet');
  assert.strictEqual(f2.network, 'mainnet');
});

console.log(`\n${passed} passed`);
process.exit(0);
