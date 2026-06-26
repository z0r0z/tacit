#!/usr/bin/env node
// Build a full OP_SEND_AND_UNWRAP witness for the SP1 guest: spend ONE hidden note → a PUBLIC withdrawal
// of `payout` to an EVM recipient + HIDDEN change note(s) back to the sender. The note value stays PRIVATE
// (only payout + fee are public). The opening sigma binds (recipient, value, payout, fee, deadline) so a
// relay box can't redirect/skim; conservation kernel proves value == Σchange + payout + fee; the range
// proof bounds the hidden change.
//
//   FEE=0 (default) → self-settle (user pays gas); FEE=<n> → relayed exit (relay paid `fee`).
// Run: node tests/gen-confidential-sendunwrap-fixture.mjs > contracts/sp1/confidential/fixtures/sendunwrap_op.json

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
const RECIPIENT = '0x' + '1234567890abcdef1234567890abcdef12345678'; // 20-byte EVM address
const CHAIN_BINDING = '0x' + '00'.repeat(32);
const beHex = (n) => '0x' + n.toString(16).padStart(64, '0');
const xy = (P) => { const a = P.toAffine(); return { cx: beHex(a.x), cy: beHex(a.y) }; };
const ptHex = (P) => '0x' + Buffer.from(P.toRawBytes(true)).toString('hex');

const FEE = BigInt(process.env.FEE || '0');
const VALUE = 1500n;       // PRIVATE note value
const PAYOUT = 900n;       // public withdrawal to the recipient
const changeValue = VALUE - PAYOUT - FEE;
if (changeValue < 0n) throw new Error('payout + fee exceeds value');
const noteBlinding = randomScalar();
const change = [{ value: changeValue, blinding: randomScalar(), owner: OWNER }];

// Conservation kernel + BP+ range over the hidden change; the single input is the spent note; the public
// leaving amount is payout + fee.
const t = ct.buildTransfer({
  inputs: [{ value: VALUE, blinding: noteBlinding }],
  outputs: change,
  fee: PAYOUT + FEE,
  assetId: ASSET, // bind change leaves (owner) into the kernel
});
if (!ct.verifyTransfer({ ...t, fee: PAYOUT + FEE })) throw new Error('JS self-verify failed');

// Input note commitment + membership.
const { cx, cy } = pool.commitXY(VALUE, beHex(noteBlinding));
const inLeaf = pool.leaf(ASSET, cx, cy, OWNER);
const tree = new pool.Tree();
tree.insert(inLeaf);
const spendRoot = tree.root();
const { path } = tree.rootAndPath(0);

// Opening sigma binding (recipient, value, payout, fee, deadline). recip32 = recipient in the low 20 bytes.
const recip32 = '0x' + '00'.repeat(12) + RECIPIENT.replace(/^0x/, '');
const OP_DEADLINE = 0n; // 0 = no expiry (self-settle); a relayed exit would pin a real deadline
const ctx = pool.intentContext('tacit-send-unwrap-intent-v1', CHAIN_BINDING, ASSET, recip32,
  [[cx, cy, OWNER]], [VALUE, PAYOUT, FEE, OP_DEADLINE]);
const nonce = pool.deriveOpeningNonce(beHex(noteBlinding), ctx, 'send-unwrap');
const sig = pool.openingSigma(VALUE, beHex(noteBlinding), ctx, nonce);

const changeMeta = change.map((_, j) => ({ ...xy(t.outC[j]), owner: OWNER }));

process.stdout.write(JSON.stringify({
  note: 'OP_SEND_AND_UNWRAP: spend one hidden note → public payout + hidden change (value stays private)',
  op: 'sendunwrap',
  chainBinding: CHAIN_BINDING,
  spendRoot,
  asset: ASSET,
  input: { cx, cy, owner: OWNER, leafIndex: 0, path, secret: '0x' + '11'.repeat(32) },
  value: Number(VALUE),
  recipient: RECIPIENT,
  payout: Number(PAYOUT),
  fee: Number(FEE),
  opDeadline: Number(OP_DEADLINE),
  sigR: sig.R,
  sigZ: sig.z,
  change: changeMeta.map((m) => ({ cx: m.cx, cy: m.cy, owner: m.owner })),
  rangeProof: '0x' + Buffer.from(t.rangeProof).toString('hex'),
  kernel: { R: ptHex(t.kernel.R), z: beHex(t.kernel.z) },
}, null, 2) + '\n');
