#!/usr/bin/env node
// Build a full confidential-transfer witness (2-in/2-out) for the FULL SP1 guest
// (contracts/sp1/confidential): real input notes in a Keccak Merkle tree with
// membership paths, real aggregated BP+ range proof + conservation kernel over
// the outputs. The Rust host feeds this to the guest and executes it, validating
// the whole op loop (membership + range + conservation + leaves + nullifiers +
// PublicValues) end-to-end in the zkVM — not just the range check.
//
// Run: node tests/gen-cxfer-fullop-fixture.mjs > contracts/sp1/confidential/fixtures/transfer_op.json

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
const ptHex = (P) => '0x' + Buffer.from(P.toRawBytes(true)).toString('hex'); // 33B compressed

const inputs = [
  { value: 1000n, blinding: randomScalar(), secret: '0x' + '11'.repeat(32) },
  { value: 500n, blinding: randomScalar(), secret: '0x' + '22'.repeat(32) },
];
const outputs = [
  { value: 900n, blinding: randomScalar() },
  { value: 600n, blinding: randomScalar() }, // 900+600 = 1500 = 1000+500
];

const t = ct.buildTransfer({
  inputs: inputs.map((i) => ({ value: i.value, blinding: i.blinding })),
  outputs,
});
if (!ct.verifyTransfer(t)) throw new Error('JS self-verify failed');

// Build the Keccak tree with the input leaves, take spendRoot + membership paths.
const tree = new pool.Tree();
const inMeta = inputs.map((inp, i) => {
  const { cx, cy } = xy(t.inC[i]);
  const lf = pool.leaf(ASSET, cx, cy, OWNER);
  tree.insert(lf);
  return { cx, cy, secret: inp.secret };
});
const spendRoot = tree.root();
inMeta.forEach((m, i) => { m.path = tree.rootAndPath(i).path; m.leafIndex = i; });
const outMeta = outputs.map((_, j) => xy(t.outC[j]));

process.stdout.write(JSON.stringify({
  note: 'full confidential-transfer witness (2-in/2-out) for the SP1 guest op loop',
  chainBinding: '0x' + '00'.repeat(32), // guest passes through to PublicValues
  spendRoot,
  asset: ASSET,
  owner: OWNER,
  inputs: inMeta.map((m) => ({ cx: m.cx, cy: m.cy, owner: OWNER, leafIndex: m.leafIndex, path: m.path, secret: m.secret })),
  outputs: outMeta.map((m) => ({ cx: m.cx, cy: m.cy, owner: OWNER })),
  rangeProof: '0x' + Buffer.from(t.rangeProof).toString('hex'),
  kernel: { R: ptHex(t.kernel.R), z: beHex(t.kernel.z) },
}, null, 2) + '\n');
