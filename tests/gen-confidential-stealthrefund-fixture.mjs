#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/stealthrefund_op.json — a single OP_STEALTH_REFUND (airdrop reclaim).
// After the deadline the LOCKER reclaims an unclaimed stealth lock (typo / dead-address safety). Same lock-set
// membership + ν_L as CLAIM, but kernel-gated like OP_ADAPTOR_REFUND: the conservation kernel over (L_C − O_C)
// can only be produced by the locker (who alone knows L's blinding), so a non-locker can neither refund nor
// redirect — the reclaimed note O is the locker's. Optional relay fee (O opens to amount − fee). Everything is
// DETERMINISTIC (no wall-clock / RNG). A REAL lock-set tree is built (insert stealth_lock_leaf → lockSetRoot +
// lPath) and the membership + the reclaimed-commitment conservation self-verify before the JSON is written.
// Field names + order match exec-stealthrefund.rs. Run: node tests/gen-confidential-stealthrefund-fixture.mjs

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

const CHAIN_BINDING = '0x' + '00'.repeat(32);
const ASSET = '0x' + 'a5'.repeat(32);
const LOCKER = '0x' + Buffer.from('stealth-refund-locker'.padEnd(32, '\0')).toString('hex');
const AMOUNT = 1500n;
const FEE = 100n; // non-zero (< amount) ⇒ O opens to 1400 and the fee leg pays 100
const DEADLINE = 2_000_000_000n;

const det = (tag) => (BigInt('0x' + Buffer.from(keccak256(new TextEncoder().encode('cstealthrefund-' + tag))).toString('hex')) % SECP_N) || 1n;
const detHex = (tag) => '0x' + det(tag).toString(16).padStart(64, '0');

// 1) The one-time stealth address the lock was created under (only its pubkey matters for refund — the locker
//    never holds the recipient's key; membership re-pins ownerPub).
const bPriv = detHex('recipient-spend');
const B = '0x' + secp.ProjectivePoint.BASE.multiply(BigInt(bPriv)).toRawBytes(true).reduce((s, x) => s + x.toString(16).padStart(2, '0'), '');
const { ownerPub } = stealth.oneTimeAddress({ recipientSpendPub: B, ephemeralPriv: detHex('ephemeral') });

// 2) Build the locked note L = commit(amount, r_L) + its stealth_lock_leaf, insert into a REAL lock-set tree.
const lBlinding = detHex('lock-blinding');
const { cx: lCx, cy: lCy } = pool.commitXY(AMOUNT, lBlinding);
const lockLeaf = stealth.stealthLockLeaf(ASSET, lCx, lCy, ownerPub, AMOUNT, DEADLINE, LOCKER);

const tree = new pool.Tree();
const lIndex = tree.insert(lockLeaf);
const { root: lockSetRoot, path: lPath } = tree.rootAndPath(lIndex);
if (!pool.verifyPath(lockLeaf, lIndex, lPath, lockSetRoot)) throw new Error('lock-set membership self-check failed');

// 3) Assemble the refund (reclaimed note O + locker-only conservation kernel via the proven transfer kernel).
const oBlinding = detHex('o-blinding');
const refund = stealth.buildStealthRefund({
  chainBinding: CHAIN_BINDING, asset: ASSET, lCx, lCy, ownerPub, amount: AMOUNT, deadline: DEADLINE,
  locker: LOCKER, lockSetRoot, lIndex, lPath, lBlinding, fee: FEE, oBlinding,
});

// 4) Self-verify the reclaimed commitment + conservation exactly as the guest re-checks them.
const net = AMOUNT - FEE;
const { cx: oCxExp, cy: oCyExp } = pool.commitXY(net, oBlinding);
if (refund.oCx !== oCxExp || refund.oCy !== oCyExp) throw new Error('reclaimed-note commitment self-check failed (O ≠ commit(amount−fee))');
if (!refund.kernelR || !refund.kernelZ) throw new Error('refund kernel missing');
if (BigInt(refund.amount) - BigInt(refund.fee) !== net) throw new Error('conservation self-check failed (amount − fee ≠ reclaimed)');

const fixture = {
  note: 'OP_STEALTH_REFUND (airdrop reclaim): L ∈ lock-set, spend ν_L, mint O=amount−fee to locker via the locker-only conservation kernel, gated by refundNotBefore=deadline. Fields in the guest io::read order; names match exec-stealthrefund.rs.',
  chainBinding: CHAIN_BINDING,
  lockSetRoot,
  asset: ASSET,
  lCx, lCy, ownerPub,
  amount: Number(AMOUNT), deadline: Number(DEADLINE),
  locker: LOCKER,
  lIndex, lPath,
  oCx: refund.oCx, oCy: refund.oCy,
  fee: Number(FEE),
  kernelR: refund.kernelR, kernelZ: refund.kernelZ,
  expected: {
    lockNullifier: pool.nullifier(lCx, lCy),
    oLeaf: pool.leaf(ASSET, refund.oCx, refund.oCy, LOCKER),
    oValue: net.toString(),
    feeValue: FEE.toString(),
    refundNotBefore: DEADLINE.toString(),
  },
};

const out = 'contracts/sp1/confidential/fixtures/stealthrefund_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, '— refund', AMOUNT.toString(), '→ O', net.toString(), '+ fee', FEE.toString(), 'lockSetRoot', lockSetRoot);
console.log('lockNullifier', fixture.expected.lockNullifier);
