#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/wrap_op.json — a single OP_WRAP (public-deposit on-ramp) batch
// the box's exec-wrap harness feeds to the guest (compressed → groth16). A deposit commitment
// C = value·H + r·G is built with a DETERMINISTIC blinding, then opened to the in-system `value` via a
// real OPENING SIGMA over the `tacit-wrap-intent-v1` context — the SAME machinery the dapp's buildWrap
// uses (no raw blinding is serialized; only sigma R/z cross the box boundary). The fields are emitted in
// the guest's io::read order; names match what exec-wrap.rs reads via f["..."].
//
// Run: node tests/gen-confidential-wrap-fixture.mjs

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
const VALUE = 1500n; // in-system value the deposit note commits to

// Deterministic blinding so the fixture is reproducible across re-proves (no wall-clock / RNG).
const det = (tag) => BigInt('0x' + Buffer.from(keccak256(new TextEncoder().encode('cwrap-fixture-' + tag))).toString('hex')) % secp.CURVE.n;
const BLINDING = det('note-blinding') || 1n;
const BLINDING_HEX = '0x' + BLINDING.toString(16).padStart(64, '0');

// Build the deposit commitment C = value·H + r·G and its pool leaf / deposit id.
const { cx, cy } = pool.commitXY(VALUE, BLINDING_HEX);
const lf = pool.leaf(ASSET, cx, cy, OWNER);
const commit = pool.depositCommit(cx, cy, OWNER);                 // keccak(Cx‖Cy‖owner) — the on-chain wrap arg
const depositId = pool.depositId(ASSET, VALUE, cx, cy, OWNER);    // keccak(asset ‖ value_be32 ‖ commit)

// Opening sigma over `value` under the wrap intent context (mirrors dapp buildWrap + the guest):
// intent_context('tacit-wrap-intent-v1', chainBinding, asset, depositId, [(cx,cy,owner)], [value]).
const ctx = pool.intentContext('tacit-wrap-intent-v1', CHAIN_BINDING, ASSET, depositId,
  [[cx, cy, OWNER]], [VALUE]);
const nonce = pool.deriveOpeningNonce(BLINDING_HEX, ctx, 'wrap');
const sig = pool.openingSigma(VALUE, BLINDING_HEX, ctx, nonce);
if (!pool.verifyOpeningSigma(cx, cy, VALUE, sig.R, sig.z, ctx)) throw new Error('wrap opening-sigma self-verify failed');

const fixture = {
  note: 'OP_WRAP public-deposit witness (1 deposit note) for the SP1 guest op loop',
  chainBinding: CHAIN_BINDING,
  asset: ASSET,
  value: VALUE.toString(),
  cx, cy, owner: OWNER,
  sigR: sig.R, sigZ: sig.z,
  expected: {
    leaf: lf,
    commit,
    depositId,
  },
};

const out = 'contracts/sp1/confidential/fixtures/wrap_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, '— wrap', VALUE.toString(), 'asset', ASSET);
console.log('leaf     ', lf);
console.log('depositId', depositId);
