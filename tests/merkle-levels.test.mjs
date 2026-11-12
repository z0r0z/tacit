// The worker's level-kept note tree gives the roots and paths the wallets' own Tree gives, at every size around a power of two.
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { buildTreeLevels } from '../worker/src/merkle-levels.js';
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const leaf = (i) => '0x' + Buffer.from(keccak_256(new TextEncoder().encode('leaf/' + i))).toString('hex');
let n = 0;
for (const size of [0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 33, 100]) {
  const leaves = Array.from({ length: size }, (_, i) => leaf(i));
  const t = new pool.Tree(); leaves.forEach((l) => t.insert(l));
  const lv = buildTreeLevels(leaves, keccak_256);
  assert.strictEqual(lv.root, t.root(), `root at ${size} leaves`);
  for (const i of size ? [0, size - 1, size >> 1] : []) assert.deepStrictEqual(lv.path(i), t.rootAndPath(i).path, `path ${i} at ${size} leaves`);
  n++;
}
console.log(`${n} tree sizes: roots and paths match the wallet tree`);
