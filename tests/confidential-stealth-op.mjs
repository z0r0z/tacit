// Stealth-receive op-assembler validation (dapp/confidential-stealth.js buildStealthLock/Claim/Refund). Builds
// each witness exactly as the box harness feeds the guest, and checks it is internally consistent: the lock's N
// and L openings verify against the reconstructed lock context, the claim's M opening verifies + the one-time
// claim signature verifies under ownerPub (so the guest's bip340_verify will), and the refund's reclaimed
// commitment + conservation are correct. Box parity (the exact witness order) is the harness run; this catches
// assembler bugs (wrong context / value / fee) before the re-prove. Run: node tests/confidential-stealth-op.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash, webcrypto } from 'node:crypto';
import { randomScalar } from '../dapp/bulletproofs-plus.js';
import { signSchnorr, verifySchnorr, SECP_N } from '../dapp/bulletproofs.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialTransfer } from '../dapp/confidential-transfer.js';
import { makeConfidentialStealth } from '../dapp/confidential-stealth.js';
import assert from 'node:assert';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const keccak256 = (b) => keccak_256(b);
const pool = makeConfidentialPool({ secp, keccak256, sha256 });
const transfer = makeConfidentialTransfer({ keccak256 });
const stealth = makeConfidentialStealth({ keccak256, secp, signSchnorr, curveOrder: SECP_N, pool, transfer });
let n = 0; const ok = (s) => { console.log('  ok -', s); n++; };

const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const b32 = (h) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(64, '0').match(/../g).map((x) => parseInt(x, 16)));
const fromHex = (h) => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
const rand = () => { const b = new Uint8Array(32); (globalThis.crypto || webcrypto).getRandomValues(b); return hx(b); };

const cb = '0x' + '11'.repeat(32);
const asset = '0x' + 'aa'.repeat(32);
const locker = '0x' + '00'.repeat(31) + '01';
const amount = 1000n, deadline = 1_700_000_000n;

// recipient static key + sender-derived one-time address
const bPriv = rand();
const B = hx(secp.ProjectivePoint.BASE.multiply(BigInt(bPriv)).toRawBytes(true));
const { ephemeralPub, ownerPub } = stealth.oneTimeAddress({ recipientSpendPub: B, ephemeralPriv: rand() });
const { oneTimePriv } = stealth.recoverOneTimeKey({ recipientSpendPriv: bPriv, ephemeralPub });

// ── LOCK: N and L both open to `amount` against the reconstructed lock context ──
const nBlinding = randomScalar();
const nNote = { ...pool.commitXY(amount, nBlinding), blinding: nBlinding, leafIndex: 0, path: pool.zeros };
const lBlinding = randomScalar();
const lock = stealth.buildStealthLock({ chainBinding: cb, asset, locker, ownerPub, amount, deadline, spendRoot: '0x' + '22'.repeat(32), nNote, lBlinding });
{
  const ctx = pool.intentContext('tacit-stealth-lock-intent-v1', cb, asset, asset,
    [[nNote.cx, nNote.cy, locker], [lock.lCx, lock.lCy, ownerPub]], [amount, deadline]);
  assert.equal(pool.verifyOpeningSigma(nNote.cx, nNote.cy, amount, lock.nSigR, lock.nSigZ, ctx), true, 'N opening verifies');
  assert.equal(pool.verifyOpeningSigma(lock.lCx, lock.lCy, amount, lock.lSigR, lock.lSigZ, ctx), true, 'L opening verifies (value carry)');
  assert.equal(lock.ownerPub, ownerPub, 'lock binds the one-time pubkey');
  ok('buildStealthLock: N + L openings verify against the lock context');
}

// ── CLAIM: M opens to amount − fee; the one-time-key claim signature verifies under ownerPub ──
const fee = 30n, net = amount - fee;
const mOwner = '0x' + '00'.repeat(31) + '09';
const mBlinding = randomScalar();
const claim = stealth.buildStealthClaim({ chainBinding: cb, asset, lCx: lock.lCx, lCy: lock.lCy, ownerPub, amount, deadline, locker, lockSetRoot: '0x' + '33'.repeat(32), lIndex: 0, lPath: pool.zeros, oneTimePriv, mOwner, fee, mBlinding });
{
  const mCtx = pool.intentContext('tacit-stealth-claim-out-v1', cb, asset, asset, [[claim.mCx, claim.mCy, mOwner]], [amount, fee]);
  assert.equal(pool.verifyOpeningSigma(claim.mCx, claim.mCy, net, claim.mSigR, claim.mSigZ, mCtx), true, 'M opens to amount − fee');
  assert.equal(pool.verifyOpeningSigma(claim.mCx, claim.mCy, amount, claim.mSigR, claim.mSigZ, mCtx), false, 'M does NOT open to the gross amount');
  const lockLeaf = stealth.stealthLockLeaf(asset, lock.lCx, lock.lCy, ownerPub, amount, deadline, locker);
  const claimMsg = stealth.stealthClaimMsg(cb, lockLeaf, claim.mCx, claim.mCy, mOwner, amount, fee);
  assert.equal(verifySchnorr(fromHex(claim.ownerSig), claimMsg, b32(ownerPub)), true, 'one-time claim sig verifies under ownerPub (guest accepts)');
  assert.equal(claim.fee, Number(fee), 'fee leg = the carved fee');
  ok('buildStealthClaim: M opens to net, claim sig binds the output + verifies under ownerPub');
}

// ── REFUND: the reclaimed note opens to amount − fee (to the locker); conservation holds ──
const rfee = 21n, oBlinding = randomScalar();
const refund = stealth.buildStealthRefund({ chainBinding: cb, asset, lCx: lock.lCx, lCy: lock.lCy, ownerPub, amount, deadline, locker, lockSetRoot: '0x' + '33'.repeat(32), lIndex: 0, lPath: pool.zeros, lBlinding, fee: rfee, oBlinding });
{
  const { cx: oCxExp, cy: oCyExp } = pool.commitXY(amount - rfee, oBlinding);
  assert.equal(refund.oCx, oCxExp, 'reclaimed note commits to amount − fee');
  assert.equal(refund.oCy, oCyExp, 'reclaimed note Cy');
  assert.ok(refund.kernelR && refund.kernelZ, 'refund kernel present (built via the proven transfer kernel)');
  assert.equal(BigInt(refund.amount) - BigInt(refund.fee), amount - rfee, 'conservation: amount − fee = reclaimed');
  ok('buildStealthRefund: reclaimed commitment + conservation correct');
}

console.log(`confidential-stealth-op: all ${n} checks passed`);
