#!/usr/bin/env node
// Build an indexed-Merkle-tree (IMT) non-membership fixture for cxfer-core's
// imt_non_membership (the cross-lane gate's accumulator). The set is the sorted
// linked list of spent nullifiers as keccak(value ‖ next) leaves in a depth-32
// keccak Merkle tree (the same tree the confidential pool + guest use). Emits
// non-membership witnesses (below min / between / above max) that must verify, and
// a member that must NOT (you can't prove a present nullifier absent).
//
// Run: node tests/gen-imt-fixture.mjs > contracts/sp1/confidential/fixtures/imt.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

const b32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

// Sorted spent nullifiers a<b<c (spaced so values exist strictly between them).
const ZERO = b32(0), a = b32(0x10), b = b32(0x20), c = b32(0x30);
// Linked low-nullifier leaves: {0→a}, {a→b}, {b→c}, {c→0 (max)}.
const links = [[ZERO, a], [a, b], [b, c], [c, ZERO]];

// Build via the dapp's accumulator primitive (single source of truth, mirrored by
// cxfer-core::imt_root / imt_empty_root and locked by both KATs).
const tree = new pool.Tree();
links.forEach(([v, n]) => tree.insert(pool.imtLeaf(v, n)));
const root = pool.imtRoot(links);
const pathOf = (i) => tree.rootAndPath(i).path;
const emptyRoot = pool.imtEmptyRoot();

// Stateful accumulator scenario: insert spends in CHRONOLOGICAL (unsorted) order —
// the index layout (and thus the root) is insertion-order-dependent. cxfer-core's
// ImtAccumulator must reach the same root from the same sequence, and a non-member
// must prove absent against that incrementally-built root.
const acc = pool.makeImtAccumulator();
const insertSeq = [b32(0x20), b32(0x10), b32(0x30)];
insertSeq.forEach((nu) => acc.insert(nu));
const nmNu = b32(0x18); // between 0x10 and 0x20
const accumulator = {
  insertSeq,
  root: acc.root(),
  links: acc.links(),
  nonMember: { nu: nmNu, ...acc.nonMembershipWitness(nmNu) },
};

const witnesses = [
  { note: 'below min', nu: b32(0x08), lowValue: ZERO, lowNext: a, lowIndex: 0, path: pathOf(0), expect: true },
  { note: 'between a,b', nu: b32(0x18), lowValue: a, lowNext: b, lowIndex: 1, path: pathOf(1), expect: true },
  { note: 'above max', nu: b32(0x40), lowValue: c, lowNext: ZERO, lowIndex: 3, path: pathOf(3), expect: true },
  { note: 'member b (must fail: cannot prove a present nullifier absent)', nu: b, lowValue: a, lowNext: b, lowIndex: 1, path: pathOf(1), expect: false },
  { note: 'wrong low leaf (range does not straddle)', nu: b32(0x18), lowValue: b, lowNext: c, lowIndex: 2, path: pathOf(2), expect: false },
];

process.stdout.write(JSON.stringify({
  note: 'IMT non-membership witnesses for cxfer-core::imt_non_membership',
  root, emptyRoot, links, witnesses, accumulator,
}, null, 2) + '\n');
