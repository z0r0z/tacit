#!/usr/bin/env node
// KAT for the Phase-1 confidential pool: locks the leaf / nullifier / deposit-id
// byte layouts and the Keccak incremental Merkle (root + membership path) across
// the JS client (dapp/confidential-pool.js), the Solidity contract
// (ConfidentialPool.sol), and — by matching preimages — the SP1 guest.
// A passing contracts/test/ConfidentialPoolKAT.t.sol proves the three agree.
//
// Run: node tests/gen-confidential-pool-fixture.mjs

import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'contracts', 'test', 'fixtures', 'confidential_pool.json');

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

const ASSET_ID = '0x' + 'a5'.repeat(32);
const OWNER = '0x' + Buffer.from('owner-stealth-pubkey-commit'.padEnd(32, '\0')).toString('hex');
const UNIT_SCALE = 1n;

function main() {
  // Three notes with distinct (value, secret, blinding); build their leaves.
  const notes = [
    { value: 100n, secret: '0x' + '11'.repeat(32), blinding: 0x1234n },
    { value: 250n, secret: '0x' + '22'.repeat(32), blinding: 0xbeefn },
    { value: 7n,   secret: '0x' + '33'.repeat(32), blinding: 0xc0den },
  ].map((n) => {
    const { cx, cy } = pool.commitXY(n.value, n.blinding);
    return {
      ...n,
      value: n.value.toString(),
      blinding: '0x' + n.blinding.toString(16).padStart(64, '0'),
      cx, cy,
      amount: (n.value * UNIT_SCALE).toString(),
      leaf: pool.leaf(ASSET_ID, cx, cy, OWNER),
      nullifier: pool.nullifier(n.secret),
      depositId: pool.depositId(ASSET_ID, n.value * UNIT_SCALE, cx, cy, OWNER),
    };
  });

  // Insert the leaves into a Keccak incremental Merkle and take root + a path.
  const tree = new pool.Tree();
  for (const n of notes) tree.insert(n.leaf);
  const memberIndex = 1;
  const { root, path: memberPath } = tree.rootAndPath(memberIndex);

  // self-check: the membership path must fold the member leaf to the root.
  if (!pool.verifyPath(notes[memberIndex].leaf, memberIndex, memberPath, root)) {
    throw new Error('JS membership self-check failed');
  }

  const fixture = {
    note: 'Confidential-pool KAT generated via dapp/confidential-pool.js. Regenerate: node tests/gen-confidential-pool-fixture.mjs.',
    assetId: ASSET_ID,
    owner: OWNER,
    unitScale: UNIT_SCALE.toString(),
    notes,
    treeLeaves: notes.map((n) => n.leaf),
    treeRoot: root,
    memberIndex,
    memberPath,
  };

  return fs.mkdir(path.dirname(OUT), { recursive: true })
    .then(() => fs.writeFile(OUT, JSON.stringify(fixture, null, 2)))
    .then(() => {
      console.log('==> wrote', path.relative(path.join(__dirname, '..'), OUT));
      console.log('   treeRoot:', root);
      console.log('   note[0] leaf:', notes[0].leaf, 'nullifier:', notes[0].nullifier);
    });
}

main().catch((e) => { console.error(e); process.exit(1); });
