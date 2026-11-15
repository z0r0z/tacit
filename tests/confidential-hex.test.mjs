// The pool's two conversions (dapp/confidential-pool.js hexToBytes, bytesToHex) read a character or a byte at a time through a table where the answer is the generic one's, and are the generic
// ones for everything else. Held to each other over inputs of every kind: digits of either case, odd lengths, characters that are not digits, '0X', newlines, empty, long, bytes in a Uint8Array
// and in a plain array, and every byte value. And the live set built the way it is now (keys compared as strings, the leaf from one definition of its preimage) gives the order and the leaves
// it gave when the keys were compared as numbers.
//   node --test tests/confidential-hex.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const { hexToBytes, bytesToHex, hexToBytesSlow, bytesToHexSlow } = pool._hex;
let seed = 0x1badf00d;
const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const same = (a, b, what) => assert.deepStrictEqual(Array.from(a), Array.from(b), what);

test('hexToBytes is the generic one for every kind of string', () => {
  const alphabet = '0123456789abcdefABCDEF', odd = 'xzg \n\t-+é🙂0X';
  const cases = ['', '0x', '0x0', '0', 'a', 'ab', '0xab', '0xABCDEF', '0Xab', '0x0xab', 'ab\ncd', 'zz', '1z', 'z1', '0x1z2y', 'abc', '  ', '00'.repeat(64), '0x' + 'ff'.repeat(33), 'ab cd', 'é1', '1é', '\u0000a'];
  for (let i = 0; i < 4000; i++) {
    const len = rnd(70), pool_ = rnd(10) === 0 ? alphabet + odd : alphabet;
    cases.push((rnd(2) ? '0x' : '') + Array.from({ length: len }, () => pool_[rnd(pool_.length)]).join(''));
  }
  for (const c of cases) same(hexToBytes(c), hexToBytesSlow(c), JSON.stringify(c));
  for (const c of [123, 0xabcd, null, undefined, true, ['a', 'b'], { toString: () => '0x1234' }]) same(hexToBytes(c), hexToBytesSlow(c), String(c));
});

test('bytesToHex is the generic one for every byte value and every kind of container', () => {
  const every = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.strictEqual(bytesToHex(every), bytesToHexSlow(every), 'every byte');
  for (let i = 0; i < 3000; i++) {
    const b = Uint8Array.from({ length: rnd(80) }, () => rnd(256));
    assert.strictEqual(bytesToHex(b), bytesToHexSlow(b));
    const from = rnd(b.length + 1), to = from + rnd(b.length - from + 1);
    assert.strictEqual(bytesToHex(b.subarray(from, to)), bytesToHexSlow(b.subarray(from, to)), 'a view into a larger buffer');
  }
  for (const c of [[1, 2, 255], [256, 4096, 0], [], Buffer.from([0, 15, 16, 255]), [1.5], ['a']]) assert.strictEqual(bytesToHex(c), bytesToHexSlow(c), JSON.stringify(c));
  assert.strictEqual(bytesToHex(new Uint8Array(0)), '');
});

test('they are each other\'s inverses on whole values, as the generic ones are', () => {
  for (let i = 0; i < 2000; i++) {
    const b = Uint8Array.from({ length: rnd(70) }, () => rnd(256));
    same(hexToBytes(bytesToHex(b)), b, 'bytes → hex → bytes');
    const h = bytesToHex(b);
    assert.strictEqual(bytesToHex(hexToBytes(h)), h, 'hex → bytes → hex');
  }
});

// the live set
const word = () => '0x' + Array.from({ length: 32 }, () => rnd(256).toString(16).padStart(2, '0')).join('');
const forms = (w) => [w, w.slice(2), w.toUpperCase().replace('0X', '0x'), '0x' + w.slice(2).replace(/^0+/, '')].filter((x) => x !== '0x' && x !== '');
test('a live set is in the order of its keys as numbers and has the leaves the entries make, whatever form the entries come in', () => {
  const triples = [];
  for (let i = 0; i < 300; i++) {
    const key = word(), pick = (x) => forms(x)[rnd(forms(x).length)];
    triples.push([pick(key), pick(word()), pick(word()), rnd(3) === 0 ? null : pick(word()), rnd(2)]);
  }
  triples.push(['0x' + '00'.repeat(31) + '01', word(), word(), word(), 1], ['0x' + 'ff'.repeat(32), word(), word(), word(), 0]);
  const set = pool.makeLiveUtxoSet();
  set.load(triples);
  const got = set.triples();
  const norm = (x) => '0x' + Buffer.from(pool._hex.hexToBytes(String(x).replace(/^0x/, '').padStart(64, '0'))).toString('hex');
  const want = triples.map(([k, v, a, ak, b]) => [norm(k), norm(v), norm(a), norm(ak || '0x' + '00'.repeat(32)), b ? 1 : 0]).sort((x, y) => (BigInt(x[0]) < BigInt(y[0]) ? -1 : BigInt(x[0]) > BigInt(y[0]) ? 1 : 0));
  assert.deepStrictEqual(got, want, 'the entries, normalized, in the order of their keys as numbers');
  // the leaves and the root: by the definition of a leaf
  const t = new pool.Tree();
  for (const [k, v, a, ak, b] of want) t.insert('0x' + Buffer.from(keccak_256(Uint8Array.from([...pool._hex.hexToBytes(k), ...pool._hex.hexToBytes(a), ...pool._hex.hexToBytes(v), ...pool._hex.hexToBytes(ak), b & 1]))).toString('hex'));
  assert.strictEqual(set.root(), t.rootAndPathFresh(0).root, 'the root of the leaves hashed as the definition says');
  assert.strictEqual(pool.liveLeaf(...want[0].slice(0, 4), want[0][4]).length, 66);
});
