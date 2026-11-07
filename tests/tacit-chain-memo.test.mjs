// The tacit chain's hybrid post-quantum memo: it opens for its recipient and no one else, any change to it is refused, every memo is the
// same size, its hash is the block program's, and the shared secret it gives is the one the pool's note keys are derived from.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from 'poseidon-lite';
import { makeBtcPoolZk } from '../dapp/btc-pool-zk.js';
import { memoKeys, sealMemo, openMemo, memoHash, MEMO_LEN, KEM_CT } from '../dapp/tacit-chain-memo.js';

const V = JSON.parse(readFileSync(new URL('./vectors/tacit-chain-lock-vectors.json', import.meta.url)));
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const seed = (n) => new Uint8Array(32).fill(n);
const alice = memoKeys(seed(1));
const bob = memoKeys(seed(2));

test('a memo is MEMO_LEN bytes and its hash is the program\'s', () => {
  assert.equal(MEMO_LEN, 1152);
  const { memo } = sealMemo(alice.address, 5n);
  assert.equal(memo.length, MEMO_LEN);
  assert.equal(hx(memoHash(new Uint8Array(MEMO_LEN).fill(0x77))), V.memoHashOf77);
});

test('keys come from the seed alone', () => {
  const again = memoKeys(seed(1));
  assert.deepEqual(again.address.scanPub, alice.address.scanPub);
  assert.deepEqual(again.address.kemPub, alice.address.kemPub);
  assert.equal(alice.address.kemPub.length, 1184);
  assert.notDeepEqual(bob.address.scanPub, alice.address.scanPub);
});

test('it opens for its recipient, with the value and the shared secret both sides derive', () => {
  for (const v of [0n, 1n, 123456789012345678n, (1n << 64n) - 1n]) {
    const { memo, s } = sealMemo(alice.address, v);
    const got = openMemo(memo, alice.secret);
    assert.equal(got.value, v);
    assert.deepEqual(got.s, s);
    assert.equal(s.length, 33);
  }
});

test('not for anyone else, and any change to it is refused', () => {
  const { memo } = sealMemo(alice.address, 42n);
  assert.equal(openMemo(memo, bob.secret), null);
  for (const at of [0, 500, KEM_CT - 1, KEM_CT, KEM_CT + 20, KEM_CT + 33, KEM_CT + 40, KEM_CT + 41, KEM_CT + 56]) {
    const bad = Uint8Array.from(memo);
    bad[at] ^= 1;
    assert.equal(openMemo(bad, alice.secret), null, `byte ${at}`);
  }
  assert.equal(openMemo(memo.slice(1), alice.secret), null);
});

test('a memo to oneself is the same as any other', () => {
  const a = sealMemo(alice.address, 7n);
  const b = sealMemo(bob.address, 7n);
  assert.equal(a.memo.length, b.memo.length);
  assert.equal(openMemo(a.memo, alice.secret).value, 7n);
});

test('entropy makes it deterministic, and without it every memo is fresh', () => {
  const e = seed(9);
  assert.deepEqual(sealMemo(alice.address, 3n, e).memo, sealMemo(alice.address, 3n, e).memo);
  assert.notDeepEqual(sealMemo(alice.address, 3n).memo, sealMemo(alice.address, 3n).memo);
});

test('the shared secret derives the pool\'s note keys the same way for sender and recipient', () => {
  const poseidon = (xs) => ({ 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 })[xs.length](xs);
  const Z = makeBtcPoolZk({ poseidon });
  const wallet = Z.walletKeys(seed(5), 'mainnet');
  const { memo, s } = sealMemo(alice.address, 99n);
  const opened = openMemo(memo, alice.secret);
  const sender = Z.outputKeys(wallet.A, wallet.N, s);
  const owner = Z.ownedKeys(wallet, opened.s);
  assert.equal(sender.npk, owner.npk);
  assert.equal(sender.rho, owner.rho);
  // a different memo to the same address gives other keys
  const other = sealMemo(alice.address, 99n);
  assert.notEqual(Z.outputKeys(wallet.A, wallet.N, other.s).npk, sender.npk);
});
