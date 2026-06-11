#!/usr/bin/env node
// Build a full SETTLE witness in IMPROVED-PLATINUM mode (bitcoinSpentRoot != 0) for
// the SP1 guest: a 2-in/2-out confidential transfer PLUS, per spent input, an
// indexed-Merkle non-membership proof that the input's nullifier is NOT in the
// reflected Bitcoin spent set. Exercises the guest's cross-lane gate end-to-end
// (header bitcoinSpentRoot + per-input check_btc_nonmembership read order).
//
// The Bitcoin spent set here is empty — a single sentinel leaf keccak(0 ‖ MAX) — so
// every nullifier (0 < ν < MAX) is a non-member via that leaf. That validates the
// wiring; a populated set is the same primitive (cxfer-core imt_non_membership 8/8).
//
// Run: node tests/gen-cxfer-crosslane-fixture.mjs > contracts/sp1/confidential/fixtures/crosslane_op.json

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const ct = makeConfidentialTransfer({ keccak256: keccak_256 });
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

const ASSET = '0x' + 'a5'.repeat(32);
const OWNER = '0x' + Buffer.from('owner-stealth'.padEnd(32, '\0')).toString('hex');
const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
const ptHex = (P) => '0x' + Buffer.from(P.toRawBytes(true)).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const cat = (a) => { const t = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

const ZERO = beHex(0n), MAX = '0x' + 'ff'.repeat(32);
const imtLeaf = (v, n) => '0x' + Buffer.from(keccak_256(cat([bytes(v), bytes(n)]))).toString('hex');

const inputs = [
  { value: 1000n, blinding: randomScalar(), secret: '0x' + '11'.repeat(32) },
  { value: 500n, blinding: randomScalar(), secret: '0x' + '22'.repeat(32) },
];
const outputs = [{ value: 900n, blinding: randomScalar() }, { value: 600n, blinding: randomScalar() }];

const t = ct.buildTransfer({ inputs: inputs.map((i) => ({ value: i.value, blinding: i.blinding })), outputs });
if (!ct.verifyTransfer(t)) throw new Error('JS self-verify failed');

// Pool tree (input membership) → spendRoot + paths.
const tree = new pool.Tree();
const inMeta = inputs.map((inp, i) => { const { cx, cy } = xy(t.inC[i]); pool && tree.insert(pool.leaf(ASSET, cx, cy, OWNER)); return { cx, cy, secret: inp.secret }; });
const spendRoot = tree.root();
inMeta.forEach((m, i) => { m.path = tree.rootAndPath(i).path; m.leafIndex = i; });

// Empty Bitcoin spent set: one sentinel leaf {0 → MAX}. Every ν is a non-member.
const spentTree = new pool.Tree();
spentTree.insert(imtLeaf(ZERO, MAX));
const bitcoinSpentRoot = spentTree.root();
const sentinelPath = spentTree.rootAndPath(0).path;
const nonMember = { lowValue: ZERO, lowNext: MAX, lowIndex: 0, path: sentinelPath };

process.stdout.write(JSON.stringify({
  note: 'platinum-mode settle witness (2-in/2-out transfer + per-input cross-lane non-membership)',
  chainBinding: '0x' + '00'.repeat(32),
  spendRoot,
  bitcoinSpentRoot,
  asset: ASSET,
  owner: OWNER,
  inputs: inMeta.map((m) => ({ cx: m.cx, cy: m.cy, owner: OWNER, leafIndex: m.leafIndex, path: m.path, secret: m.secret, nonMember })),
  outputs: t.outC.map((P) => { const { cx, cy } = xy(P); return { cx, cy, owner: OWNER }; }),
  rangeProof: '0x' + Buffer.from(t.rangeProof).toString('hex'),
  kernel: { R: ptHex(t.kernel.R), z: beHex(t.kernel.z) },
}, null, 2) + '\n');
