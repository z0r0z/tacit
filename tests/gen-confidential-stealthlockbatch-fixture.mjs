#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/stealthlockbatch_op.json — ONE proof that locks N funding notes
// into the SHARED lock-set under N recipients' one-time stealth pubkeys (the airdrop path: N recipients in a
// single settle instead of N proofs). The guest loops `for _ in 0..num_ops` reading an OP_STEALTH_LOCK block
// per iteration (main.rs:3050), so the batch is exec-stealthlock's single-op block written N times against ONE
// shared header. Each funding note N is a REAL member of a shared spendRoot tree (the guest verifies N
// membership), spends its nullifier, and appends a locked note L bound to the recipient's one-time pubkey.
// Fields + order match what exec-stealthlockbatch.rs reads. Everything is DETERMINISTIC so the fixture is
// reproducible across re-proves (no wall-clock / RNG). Run: node tests/gen-confidential-stealthlockbatch-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { signSchnorr, SECP_N } from '../dapp/bulletproofs.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialStealth } from '../dapp/confidential-stealth.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const transfer = makeConfidentialTransfer({ keccak256 });
const stealth = makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool, transfer });

const ASSET = '0x' + 'a5'.repeat(32);
const LOCKER = '0x' + Buffer.from('stealth-batch-locker'.padEnd(32, '\0')).toString('hex'); // == each N's owner
const CHAIN_BINDING = '0x' + '00'.repeat(32);
const DEADLINE = 2_000_000_000n; // fixed (reproducible), bound in the lock leaf + opening sigma
const N = 3; // batch of three recipients exercises the num_ops loop
const AMOUNTS = [1500n, 800n, 2200n];

// Deterministic scalar from a tag (reproducible across re-proves).
const det = (tag) => (BigInt('0x' + Buffer.from(keccak256(new TextEncoder().encode('cstealthbatch-' + tag))).toString('hex')) % SECP_N) || 1n;
const detHex = (tag) => '0x' + det(tag).toString(16).padStart(64, '0');

// 1) Build the shared funding-note tree: insert leaf(asset, nCx, nCy, locker) for each note, then read paths.
const tree = new pool.Tree();
const notes = [];
for (let i = 0; i < N; i++) {
  const nBlinding = detHex('note-blinding-' + i);
  const { cx, cy } = pool.commitXY(AMOUNTS[i], nBlinding);
  const lf = pool.leaf(ASSET, cx, cy, LOCKER);
  const leafIndex = tree.insert(lf);
  notes.push({ cx, cy, blinding: nBlinding, leafIndex, amount: AMOUNTS[i] });
}
const spendRoot = tree.root();
for (const nt of notes) {
  const { path } = tree.rootAndPath(nt.leafIndex);
  nt.path = path;
  if (!pool.verifyPath(pool.leaf(ASSET, nt.cx, nt.cy, LOCKER), nt.leafIndex, path, spendRoot))
    throw new Error('funding-note membership self-check failed at index ' + nt.leafIndex);
}

// 2) For each note, derive a one-time stealth address and assemble the lock (N + L openings under the lock ctx).
const ops = [];
for (let i = 0; i < N; i++) {
  const nt = notes[i];
  const bPriv = detHex('recipient-spend-' + i);
  const B = '0x' + secp.ProjectivePoint.BASE.multiply(BigInt(bPriv)).toRawBytes(true).reduce((s, x) => s + x.toString(16).padStart(2, '0'), '');
  const { ownerPub } = stealth.oneTimeAddress({ recipientSpendPub: B, ephemeralPriv: detHex('ephemeral-' + i) });
  const lBlinding = detHex('lock-blinding-' + i);
  const nNote = { cx: nt.cx, cy: nt.cy, blinding: nt.blinding, leafIndex: nt.leafIndex, path: nt.path };
  const lock = stealth.buildStealthLock({ chainBinding: CHAIN_BINDING, asset: ASSET, locker: LOCKER, ownerPub, amount: nt.amount, deadline: DEADLINE, spendRoot, nNote, lBlinding });

  // Self-verify both openings against the reconstructed lock context (the guest asserts the same).
  const ctx = pool.intentContext('tacit-stealth-lock-intent-v1', CHAIN_BINDING, ASSET, ASSET,
    [[nt.cx, nt.cy, LOCKER], [lock.lCx, lock.lCy, ownerPub]], [nt.amount, DEADLINE]);
  if (!pool.verifyOpeningSigma(nt.cx, nt.cy, nt.amount, lock.nSigR, lock.nSigZ, ctx)) throw new Error('N opening self-verify failed @' + i);
  if (!pool.verifyOpeningSigma(lock.lCx, lock.lCy, nt.amount, lock.lSigR, lock.lSigZ, ctx)) throw new Error('L opening self-verify failed @' + i);

  ops.push({
    asset: ASSET, locker: LOCKER, ownerPub, amount: Number(nt.amount), deadline: Number(DEADLINE),
    nCx: nt.cx, nCy: nt.cy, nIndex: nt.leafIndex, nPath: nt.path, nSigR: lock.nSigR, nSigZ: lock.nSigZ,
    lCx: lock.lCx, lCy: lock.lCy, lSigR: lock.lSigR, lSigZ: lock.lSigZ,
    expected: { nullifier: pool.nullifier(nt.cx, nt.cy), lockLeaf: stealth.stealthLockLeaf(ASSET, lock.lCx, lock.lCy, ownerPub, nt.amount, DEADLINE, LOCKER) },
  });
}

const fixture = {
  note: 'OP_STEALTH_LOCK batch (airdrop): N funding notes → N lock-set leaves in one proof. Fields in the guest io::read order; names match exec-stealthlockbatch.rs.',
  chainBinding: CHAIN_BINDING,
  spendRoot,
  ops,
};

const out = 'contracts/sp1/confidential/fixtures/stealthlockbatch_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, '—', N, 'locks, amounts', AMOUNTS.map(String).join('/'), 'spendRoot', spendRoot);
