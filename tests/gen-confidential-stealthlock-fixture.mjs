#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/stealthlock_op.json — ONE OP_STEALTH_LOCK: lock a single funding
// note N into the lock-set under the recipient's one-time stealth pubkey. This is the single-op form of
// gen-confidential-stealthlockbatch-fixture.mjs (the batch writes this same per-op block N times); fields +
// order match what exec-stealthlock.rs reads. Deterministic (no wall-clock / RNG) so it is reproducible across
// re-proves. Run: node tests/gen-confidential-stealthlock-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { signSchnorr, SECP_N } from '../dapp/bulletproofs.js';
import { G as bpG } from '../dapp/bulletproofs-plus.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialStealth } from '../dapp/confidential-stealth.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const transfer = makeConfidentialTransfer({ keccak256 });
const stealth = makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool, transfer });

const PtT = bpG.constructor;
const ptHexT = (h) => PtT.fromHex(String(h).replace(/^0x/, ''));
const C = (v, r) => transfer.commit(BigInt(v), BigInt(r));

const ASSET = '0x' + 'a5'.repeat(32);
const LOCKER = '0x' + Buffer.from('stealth-batch-locker'.padEnd(32, '\0')).toString('hex'); // == N's owner
const CHAIN_BINDING = '0x' + '00'.repeat(32);
const DEADLINE = 2_000_000_000n; // fixed (reproducible), bound in the lock leaf
const AMOUNT = 1500n;

const det = (tag) => (BigInt('0x' + Buffer.from(keccak256(new TextEncoder().encode('cstealthlock-' + tag))).toString('hex')) % SECP_N) || 1n;
const detHex = (tag) => '0x' + det(tag).toString(16).padStart(64, '0');

// 1) Build the funding-note tree: insert leaf(asset, nCx, nCy, locker), read its path.
const tree = new pool.Tree();
const nBlinding = detHex('note-blinding');
const { cx: nCx, cy: nCy } = pool.commitXY(AMOUNT, nBlinding);
const leafIndex = tree.insert(pool.leaf(ASSET, nCx, nCy, LOCKER));
const spendRoot = tree.root();
const { path: nPath } = tree.rootAndPath(leafIndex);
if (!pool.verifyPath(pool.leaf(ASSET, nCx, nCy, LOCKER), leafIndex, nPath, spendRoot))
  throw new Error('funding-note membership self-check failed');

// 2) Derive the recipient's one-time stealth address and assemble the lock (value-hidden N→L kernel).
const bPriv = detHex('recipient-spend');
const B = '0x' + secp.ProjectivePoint.BASE.multiply(BigInt(bPriv)).toRawBytes(true).reduce((s, x) => s + x.toString(16).padStart(2, '0'), '');
const { ownerPub } = stealth.oneTimeAddress({ recipientSpendPub: B, ephemeralPriv: detHex('ephemeral') });
const lBlinding = detHex('lock-blinding');
const nNote = { cx: nCx, cy: nCy, blinding: nBlinding, leafIndex, path: nPath };
const lock = stealth.buildStealthLock({ chainBinding: CHAIN_BINDING, asset: ASSET, locker: LOCKER, ownerPub, amount: AMOUNT, deadline: DEADLINE, spendRoot, nNote, lBlinding });

// Self-verify the value-hidden N→L kernel binds the BLIND lock leaf (the guest asserts the same).
const lockLeaf = stealth.stealthLockLeafBlind(ASSET, lock.lCx, lock.lCy, ownerPub, DEADLINE, LOCKER);
if (!transfer.verifyKernel({ inC: [C(AMOUNT, BigInt(nBlinding))], outC: [C(AMOUNT, BigInt(lBlinding))], fee: 0n, kernel: { R: ptHexT(lock.kernelR), z: BigInt(lock.kernelZ) }, outLeaves: [lockLeaf] }))
  throw new Error('lock kernel self-verify failed');

const fixture = {
  note: 'OP_STEALTH_LOCK (single): one funding note → one lock-set leaf. Fields in the guest io::read order; names match exec-stealthlock.rs.',
  chainBinding: CHAIN_BINDING,
  spendRoot,
  asset: ASSET,
  locker: LOCKER,
  ownerPub,
  deadline: Number(DEADLINE),
  nCx, nCy, nIndex: leafIndex, nPath,
  lCx: lock.lCx, lCy: lock.lCy, kernelR: lock.kernelR, kernelZ: lock.kernelZ,
  expected: { nullifier: pool.nullifier(nCx, nCy), lockLeaf },
};

const out = 'contracts/sp1/confidential/fixtures/stealthlock_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, '— 1 lock, amount', String(AMOUNT), 'spendRoot', spendRoot);
