#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/unwrap_op.json — a single OP_UNWRAP (gasless exit) batch the
// box's exec-unwrap harness feeds to the guest (compressed → groth16). A real spendable note is built
// in a Keccak Merkle tree (membership path + spendRoot), then spent to a PUBLIC recipient via a real
// OPENING SIGMA over `value` under the `tacit-unwrap-intent-v1` context — the SAME machinery the dapp's
// buildUnwrap uses (no raw blinding is serialized). A NON-ZERO fee exercises BOTH legs: the recipient
// gets value−fee (Withdrawal) and the settler gets fee (FeePayment). The fields are emitted in the
// guest's io::read order; names match what exec-unwrap.rs reads via f["..."].
//
// Run: node tests/gen-confidential-unwrap-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });

const ASSET = '0x' + 'a5'.repeat(32);
const OWNER = '0x' + Buffer.from('owner-stealth'.padEnd(32, '\0')).toString('hex');
const CHAIN_BINDING = '0x' + '00'.repeat(32); // guest passes through to PublicValues
const RECIPIENT = '0xD5B75Ea6dfC22E234ecA88e5C75f5E1972b2C6E1'; // public EVM recipient
const VALUE = 1500n;
const FEE = 100n; // non-zero, < VALUE ⇒ both the Withdrawal (1400) and FeePayment (100) legs fire
const DEADLINE = 2_000_000_000n; // fixed (reproducible across re-proves), bound in the opening sigma

// Deterministic blinding so the fixture is reproducible across re-proves.
const det = (tag) => BigInt('0x' + Buffer.from(keccak256(new TextEncoder().encode('cunwrap-fixture-' + tag))).toString('hex')) % secp.CURVE.n;
const BLINDING = det('note-blinding') || 1n;

// Build the spendable note commitment C = value·H + r·G and its pool leaf.
const { cx, cy } = pool.commitXY(VALUE, BLINDING);
const lf = pool.leaf(ASSET, cx, cy, OWNER);

const tree = new pool.Tree();
const leafIndex = tree.insert(lf);
const { root: spendRoot, path } = tree.rootAndPath(leafIndex);
if (!pool.verifyPath(lf, leafIndex, path, spendRoot)) throw new Error('leaf membership self-check failed');

// Opening sigma over `value` under the unwrap intent context (mirrors dapp buildUnwrap + the guest):
// intent_context('tacit-unwrap-intent-v1', chainBinding, asset, recip32, [(cx,cy,owner)], [value, fee]),
// recipient right-aligned into 32 bytes (the asset_b slot). The box never sees the blinding r.
const to = RECIPIENT.toLowerCase();
const recip32 = '0x' + '0'.repeat(24) + to.replace(/^0x/, '');
const ctx = pool.intentContext('tacit-unwrap-intent-v1', CHAIN_BINDING, ASSET, recip32,
  [[cx, cy, OWNER]], [VALUE, FEE, DEADLINE]);
const nonce = pool.deriveOpeningNonce(BLINDING, ctx, 'unwrap');
const sig = pool.openingSigma(VALUE, BLINDING, ctx, nonce);
if (!pool.verifyOpeningSigma(cx, cy, VALUE, sig.R, sig.z, ctx)) throw new Error('opening-sigma self-verify failed');

const fixture = {
  note: 'OP_UNWRAP gasless-exit witness (1-note spend, fee>0) for the SP1 guest op loop',
  chainBinding: CHAIN_BINDING,
  spendRoot,
  asset: ASSET,
  cx, cy, owner: OWNER,
  leafIndex,
  path,
  secret: '0x' + '00'.repeat(32), // vestigial (ν is note-bound), but the guest still reads it
  value: VALUE.toString(),
  recipient: to,
  fee: FEE.toString(),
  deadline: DEADLINE.toString(),
  sigR: sig.R, sigZ: sig.z,
  expected: {
    nullifier: pool.nullifier(cx, cy),
    withdrawalValue: (VALUE - FEE).toString(), // recipient receives value − fee
    feeValue: FEE.toString(),
  },
};

const out = 'contracts/sp1/confidential/fixtures/unwrap_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, '— spend', VALUE.toString(), '→ withdraw', (VALUE - FEE).toString(), '+ fee', FEE.toString(), 'to', to);
console.log('nullifier', fixture.expected.nullifier);
