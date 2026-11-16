// The chain lane a page makes from a key alone is the one the chain wallet makes with the real chain and asset, and the one a unified address names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp, bytesToHex, hexToBytes } from '../dapp/vendor/tacit-deps.min.js';
import { poseidon2, poseidon3, poseidon4, poseidon5 } from '../dapp/vendor/tacit-poseidon.min.js';
import { makeChainWallet } from '../dapp/tacit-chain-wallet.js';
import { chainLane, chainSeed } from '../dapp/tacit-chain-lane.js';
import { chainSeed as clientSeed } from '../dapp/tacit-chain-client.js';
import { unifiedAddress } from '../dapp/tacit-unified.js';
import { makeTacitAddress } from '../dapp/tacit-address.js';

const POSEIDON = { 2: poseidon2, 3: poseidon3, 4: poseidon4, 5: poseidon5 };
const poseidon = (xs) => POSEIDON[xs.length](xs);
const KEYS = ['11'.repeat(32), '07'.repeat(31) + 'a9', 'c3'.repeat(32)];
const hx = (b) => bytesToHex(b);

test('the lane from the key alone equals the chain wallet\'s, with a real chain, asset and Poseidon', () => {
  const w = makeChainWallet({ poseidon, prover: null, chain: '0x' + '5a'.repeat(32), asset: 123456789n });
  for (const k of KEYS) {
    const want = w.chainAddressHash(w.address(w.keys(chainSeed(hexToBytes(k)))));
    assert.equal(hx(chainLane(k)), hx(want));
    assert.equal(hx(chainLane(hexToBytes(k))), hx(want));
  }
});

test('the lane is 32 bytes, differs by key, and the key given is left as given', () => {
  const a = chainLane(KEYS[0]), b = chainLane(KEYS[1]);
  assert.equal(a.length, 32);
  assert.notEqual(hx(a), hx(b));
  const k = hexToBytes(KEYS[2]), copy = Uint8Array.from(k);
  chainLane(k);
  assert.deepEqual(k, copy);
});

test('the chain client derives its seed the same way', () => {
  const k = hexToBytes(KEYS[0]);
  assert.equal(hx(clientSeed(k)), hx(chainSeed(k)));
});

test('a unified address made with the lane names it, and only the lane differs from the plain one', () => {
  const { decodeTacitAddress } = makeTacitAddress({ secp });
  for (const k of KEYS) {
    const lane = chainLane(k), withLane = decodeTacitAddress(unifiedAddress(k, lane).address), plain = decodeTacitAddress(unifiedAddress(k).address);
    assert.equal(hx(withLane.lanes.chain.hash), hx(lane));
    assert.equal(plain.lanes.chain, undefined);
    assert.equal(hx(withLane.lanes.pool.keys), hx(plain.lanes.pool.keys));
    assert.equal(hx(withLane.lanes.btc.spendPub), hx(plain.lanes.btc.spendPub));
  }
});
