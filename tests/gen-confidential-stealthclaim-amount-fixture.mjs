#!/usr/bin/env node
// Emit contracts/sp1/confidential/fixtures/stealthclaim_amount_op.json — a single OP_STEALTH_CLAIM `blind=0`
// (the AMM protocol-fee-skim claim). Unlike the prover-blind user-send arm (stealthclaim_op.json), this lock is
// never built via a dedicated lock op: OP_SWAP (main.rs) carves the pool's protocol-fee cut directly into a
// `stealth_lock_leaf` (amount-bearing) as a side effect of any swap on a protocol-fee pool, using
// `protofee_blind` — deterministic from PUBLIC swap data — as the note's blinding. This script exercises BOTH
// halves of that gap end-to-end:
//   1) RECOVERY: `recoverProtocolFeeLock` rebuilds the exact commitment + leaf OP_SWAP would have created, from
//      synthetic-but-representative public swap data (pool id, first spent-input nullifier, pre-swap reserves,
//      published cut, recipient key) — mirroring cxfer-core `protofee_blind` byte-for-byte.
//   2) CLAIM: `buildStealthClaimAmount` assembles the `blind=0` OP_STEALTH_CLAIM witness — an opening SIGMA
//      (amount is public/leaf-pinned, no value-hiding kernel/range needed) + a BIP-340 sig under the
//      recipient's key.
// Everything is DETERMINISTIC (no wall-clock / RNG) so the fixture is reproducible. A REAL lock-set tree is
// built and every guest-side check (lock-set membership, the M opening sigma, the claim signature) is
// self-verified via the SAME JS mirrors the guest's Rust checks are pinned against (pool.verifyOpeningSigma ==
// cxfer-core verify_opening_sigma, bulletproofs.js verifySchnorr == cxfer-core bip340_verify) before the JSON is
// written. Field names mirror the guest's blind=0 io::read order (main.rs OP_STEALTH_CLAIM `else` arm); NOTE the
// existing exec-stealthclaim.rs box harness only serializes blind=1 today — wiring this fixture into (or a
// sibling of) that harness is a follow-up, not part of this fixture generator.
// Run: node tests/gen-confidential-stealthclaim-amount-fixture.mjs

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
const POOL_ID = '0x' + 'b6'.repeat(32);
const M_OWNER = '0x' + Buffer.from('protofee-claim-mowner'.padEnd(32, '\0')).toString('hex');
const RESERVE_A_PRE = 5_000_000n;
const RESERVE_B_PRE = 7_500_000n;
const CUT = 42n; // the swap's published SwapSettlement.cutA/cutB for this leg
const FEE = 10n; // non-zero relay fee (< cut)

// Deterministic scalar/leaf inputs from a tag (reproducible across re-proves).
const det = (tag) => (BigInt('0x' + Buffer.from(keccak256(new TextEncoder().encode('cstealthclaim-amount-' + tag))).toString('hex')) % SECP_N) || 1n;
const detHex = (tag) => '0x' + det(tag).toString(16).padStart(64, '0');
const detLeaf = (tag) => '0x' + Buffer.from(keccak256(new TextEncoder().encode('cstealthclaim-amount-leaf-' + tag))).toString('hex');

// A swap always spends >= 1 input; its first spent-input nullifier is globally unique (spent at most once
// ever) — stand in a deterministic 32-byte value for it here.
const FIRST_INPUT_NU = detLeaf('first-input-nu');

// The AMM protocol-fee recipient's static key (configured on pool creation) — NOT a per-payment one-time
// ECDH key like the prover-blind user-send arm.
const recipientPriv = detHex('recipient-priv');
const recipientX = '0x' + secp.ProjectivePoint.BASE.multiply(BigInt(recipientPriv)).toRawBytes(true).slice(1).reduce((s, x) => s + x.toString(16).padStart(2, '0'), '');

// 1) RECOVER the fee-lock exactly as OP_SWAP would have created it.
const lock = stealth.recoverProtocolFeeLock({
  asset: ASSET, poolId: POOL_ID, firstInputNu: FIRST_INPUT_NU,
  reserveAPre: RESERVE_A_PRE, reserveBPre: RESERVE_B_PRE, cut: CUT, recipientX,
});
if (lock.amount !== CUT) throw new Error('recovered lock amount != published cut');
if (lock.deadline !== (1n << 64n) - 1n) throw new Error('recovered lock deadline != u64::MAX');

// Independent recomputation of the fee-lock leaf via the low-level stealth_lock_leaf primitive (not through
// recoverProtocolFeeLock) — confirms the recovery helper didn't silently diverge from the byte layout.
const independentLeaf = stealth.stealthLockLeaf(ASSET, lock.lCx, lock.lCy, recipientX, CUT, (1n << 64n) - 1n, recipientX);
if (independentLeaf.toLowerCase() !== lock.lockLeaf.toLowerCase()) throw new Error('recovered lock leaf mismatch vs direct stealthLockLeaf() call');

// 2) Insert into a REAL lock-set tree (the guest proves membership against its root).
const tree = new pool.Tree();
const lIndex = tree.insert(lock.lockLeaf);
const { root: lockSetRoot, path: lPath } = tree.rootAndPath(lIndex);
if (!pool.verifyPath(lock.lockLeaf, lIndex, lPath, lockSetRoot)) throw new Error('lock-set membership self-check failed');

// 3) CLAIM: assemble the M opening sigma + BIP-340 claim signature.
const mBlinding = detHex('m-blinding');
const claim = stealth.buildStealthClaimAmount({
  chainBinding: CHAIN_BINDING, asset: ASSET, lCx: lock.lCx, lCy: lock.lCy, ownerPub: lock.ownerPub,
  amount: lock.amount, deadline: lock.deadline, locker: lock.locker,
  lockSetRoot, lIndex, lPath, oneTimePriv: recipientPriv, mOwner: M_OWNER, fee: FEE, mBlinding,
});

// 4) Self-verify EVERYTHING the guest's blind=0 arm checks, using the SAME verifier mirrors main.rs is pinned
//    against (verify_opening_sigma / bip340_verify).
const net = CUT - FEE;
if (net <= 0n) throw new Error('fee must be < amount');
const mCtx = pool.intentContext('tacit-stealth-claim-out-v1', CHAIN_BINDING, ASSET, ASSET, [[claim.mCx, claim.mCy, M_OWNER]], [CUT, FEE]);
if (!pool.verifyOpeningSigma(claim.mCx, claim.mCy, net, claim.mSigR, claim.mSigZ, mCtx))
  throw new Error('M opening-sigma self-verify failed');
const claimMsg = stealth.stealthClaimMsg(CHAIN_BINDING, lock.lockLeaf, claim.mCx, claim.mCy, M_OWNER, CUT, FEE);
if (!verifySchnorr(fromHex(claim.ownerSig), claimMsg, b32(recipientX)))
  throw new Error('claim Schnorr sig self-verify failed under recipientX (ownerPub)');
const mLeaf = pool.leaf(ASSET, claim.mCx, claim.mCy, M_OWNER);
const lockNullifier = pool.nullifier(lock.lockLeaf);

const fixture = {
  note: 'OP_STEALTH_CLAIM blind=0 (amount-bearing AMM protocol-fee skim): L ∈ lock-set (stealth_lock_leaf, amount-bearing), spend ν_L, mint M to mOwner via an opening SIGMA (amount is public/leaf-pinned; no kernel/range needed), BIP-340-authorized under the pool\'s static fee-recipient key. Fields in the guest OP_STEALTH_CLAIM blind=0 io::read order (main.rs); the harness this fixture is meant for (exec-stealthclaim.rs) currently only serializes blind=1 — see the header comment. `deadline`/`amount` are decimal STRINGS (this arm\'s canonical deadline is u64::MAX, unrepresentable as a JS/JSON number).',
  blind: 0,
  chainBinding: CHAIN_BINDING,
  lockSetRoot,
  asset: ASSET,
  lCx: lock.lCx, lCy: lock.lCy, ownerPub: lock.ownerPub,
  amount: claim.amount, deadline: claim.deadline,
  locker: lock.locker,
  lIndex, lPath,
  mCx: claim.mCx, mCy: claim.mCy, mOwner: M_OWNER,
  fee: Number(FEE),
  mSigR: claim.mSigR, mSigZ: claim.mSigZ,
  ownerSig: claim.ownerSig,
  recovery: {
    poolId: POOL_ID, firstInputNu: FIRST_INPUT_NU,
    reserveAPre: RESERVE_A_PRE.toString(), reserveBPre: RESERVE_B_PRE.toString(),
    cut: CUT.toString(), recipientX, lBlinding: '0x' + lock.lBlinding.toString(16).padStart(64, '0'),
  },
  expected: {
    lockNullifier,
    mLeaf,
    mValue: net.toString(),
    feeValue: FEE.toString(),
  },
};

const out = 'contracts/sp1/confidential/fixtures/stealthclaim_amount_op.json';
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', out, '— claim cut', CUT.toString(), '→ M', net.toString(), '+ fee', FEE.toString(), 'lockSetRoot', lockSetRoot);
console.log('lockNullifier', lockNullifier);
console.log('self-verify OK: lock-set membership, M opening sigma, claim Schnorr sig');
