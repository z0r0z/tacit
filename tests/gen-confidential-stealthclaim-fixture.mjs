#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/stealthclaim_op.json — a single OP_STEALTH_CLAIM (airdrop claim).
// The recipient proves a stealth lock L ∈ the lock-set (reconstructing stealth_lock_leaf pins
// asset/ownerPub/amount/deadline/locker), spends ν_L, and mints output M to an owner THEY choose, net of an
// optional gasless relay fee. Authorized by a BIP-340 sig under the lock's one-time pubkey over the exact
// (lock, M, fee). Everything is DETERMINISTIC (no wall-clock / RNG) so the fixture is reproducible across
// re-proves. A REAL lock-set tree is built (insert stealth_lock_leaf → lockSetRoot + lPath) and the membership,
// the M opening sigma, and the one-time claim signature all self-verify before the JSON is written. Field names
// + order match exec-stealthclaim.rs. Run: node tests/gen-confidential-stealthclaim-fixture.mjs

import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { signSchnorr, verifySchnorr, SECP_N } from '../dapp/bulletproofs.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialStealth } from '../dapp/confidential-stealth.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const transfer = makeConfidentialTransfer({ keccak256 });
const stealth = makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool, transfer });

const fromHex = (h) => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
const b32 = (h) => fromHex(String(h).replace(/^0x/, '').padStart(64, '0'));

const CHAIN_BINDING = '0x' + '00'.repeat(32);
const ASSET = '0x' + 'a5'.repeat(32);
const LOCKER = '0x' + Buffer.from('stealth-claim-locker'.padEnd(32, '\0')).toString('hex');
const M_OWNER = '0x' + Buffer.from('claim-recipient-mowner'.padEnd(32, '\0')).toString('hex');
const AMOUNT = 1500n;
const FEE = 100n; // non-zero (< amount) ⇒ M opens to 1400 and the fee leg pays 100
const DEADLINE = 2_000_000_000n;

// Deterministic scalar from a tag (reproducible across re-proves).
const det = (tag) => (BigInt('0x' + Buffer.from(keccak256(new TextEncoder().encode('cstealthclaim-' + tag))).toString('hex')) % SECP_N) || 1n;
const detHex = (tag) => '0x' + det(tag).toString(16).padStart(64, '0');

// 1) Derive the one-time stealth address + the recipient's one-time spending key (dapp-side ECDH).
const bPriv = detHex('recipient-spend');
const B = '0x' + secp.ProjectivePoint.BASE.multiply(BigInt(bPriv)).toRawBytes(true).reduce((s, x) => s + x.toString(16).padStart(2, '0'), '');
const { ephemeralPub, ownerPub } = stealth.oneTimeAddress({ recipientSpendPub: B, ephemeralPriv: detHex('ephemeral') });
const { oneTimePriv, ownerPub: recovered } = stealth.recoverOneTimeKey({ recipientSpendPriv: bPriv, ephemeralPub });
if (recovered.toLowerCase() !== ownerPub.toLowerCase()) throw new Error('one-time-key recovery self-check failed');

// 2) Build the locked note L = commit(amount, r_L) and its stealth_lock_leaf, insert into a REAL lock-set tree.
const lBlinding = detHex('lock-blinding');
const { cx: lCx, cy: lCy } = pool.commitXY(AMOUNT, lBlinding);
const lockLeaf = stealth.stealthLockLeaf(ASSET, lCx, lCy, ownerPub, AMOUNT, DEADLINE, LOCKER);

const tree = new pool.Tree();
const lIndex = tree.insert(lockLeaf);
const { root: lockSetRoot, path: lPath } = tree.rootAndPath(lIndex);
if (!pool.verifyPath(lockLeaf, lIndex, lPath, lockSetRoot)) throw new Error('lock-set membership self-check failed');

// 3) Assemble the claim (M opening sigma + one-time-key BIP-340 claim sig).
const claim = stealth.buildStealthClaim({
  chainBinding: CHAIN_BINDING, asset: ASSET, lCx, lCy, ownerPub, amount: AMOUNT, deadline: DEADLINE,
  locker: LOCKER, lockSetRoot, lIndex, lPath, oneTimePriv, mOwner: M_OWNER, fee: FEE, mBlinding: detHex('m-blinding'),
});

// 4) Self-verify the openings + the claim signature exactly as the guest re-checks them.
const net = AMOUNT - FEE;
const mCtx = pool.intentContext('tacit-stealth-claim-out-v1', CHAIN_BINDING, ASSET, ASSET, [[claim.mCx, claim.mCy, M_OWNER]], [AMOUNT, FEE]);
if (!pool.verifyOpeningSigma(claim.mCx, claim.mCy, net, claim.mSigR, claim.mSigZ, mCtx)) throw new Error('M opening self-verify failed');
if (pool.verifyOpeningSigma(claim.mCx, claim.mCy, AMOUNT, claim.mSigR, claim.mSigZ, mCtx)) throw new Error('M must NOT open to the gross amount');
const claimMsg = stealth.stealthClaimMsg(CHAIN_BINDING, lockLeaf, claim.mCx, claim.mCy, M_OWNER, AMOUNT, FEE);
if (!verifySchnorr(fromHex(claim.ownerSig), claimMsg, b32(ownerPub))) throw new Error('claim Schnorr sig self-verify failed under ownerPub');

const fixture = {
  note: 'OP_STEALTH_CLAIM (airdrop claim): L ∈ lock-set, spend ν_L, mint M=amount−fee to mOwner, BIP-340-authorized. Fields in the guest io::read order; names match exec-stealthclaim.rs.',
  chainBinding: CHAIN_BINDING,
  lockSetRoot,
  asset: ASSET,
  lCx, lCy, ownerPub,
  amount: Number(AMOUNT), deadline: Number(DEADLINE),
  locker: LOCKER,
  lIndex, lPath,
  mCx: claim.mCx, mCy: claim.mCy, mOwner: M_OWNER,
  fee: Number(FEE),
  mSigR: claim.mSigR, mSigZ: claim.mSigZ,
  ownerSig: claim.ownerSig,
  expected: {
    lockNullifier: pool.nullifier(lCx, lCy),
    mLeaf: pool.leaf(ASSET, claim.mCx, claim.mCy, M_OWNER),
    mValue: net.toString(),
    feeValue: FEE.toString(),
  },
};

const out = 'contracts/sp1/confidential/fixtures/stealthclaim_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, '— claim', AMOUNT.toString(), '→ M', net.toString(), '+ fee', FEE.toString(), 'lockSetRoot', lockSetRoot);
console.log('lockNullifier', fixture.expected.lockNullifier);
