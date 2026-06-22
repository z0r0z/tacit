// OP_BRIDGE_STEALTH_MINT op-assembler validation (dapp/confidential-stealth.js buildBridgeStealthMint).
// Cross-chain confidential PAY-TO-STEALTH: a note burned on Bitcoin is minted into the shared lock-set under
// the recipient's one-time pubkey, so the sender can't spend it — only the recipient's BIP-340 claim can.
// This checks the witness is internally consistent + the conservation that keeps it inflation-safe:
//   (1) the L opening sigma binds L to the cleartext `amount` (and FAILS at a wrong amount) — so the
//       leaf-pinned amount a later claim mints can't exceed L's committed value;
//   (2) the kernel conserves v_in == v_L — transfer.buildTransfer enforces it, so an over-mint (v_in < amount)
//       cannot produce a valid kernel at all;
//   (3) the minted lock is the existing stealth_lock_leaf and is claimable ONLY by the recipient (the
//       recovered one-time key signs a claim verifySchnorr/bip340_verify accepts; a non-recipient cannot).
// Pins the assembler + the conservation to the guest before the re-prove. Run: node tests/confidential-bridge-stealth-op.mjs
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
const poolRoot = '0x' + '22'.repeat(32);   // the (gated) Bitcoin pool root the burned note is a member of
const locker = '0x' + '00'.repeat(31) + '01';
const amount = 1000n, deadline = 1_700_000_000n;
const ZERO_OWNER = '0x' + '00'.repeat(32); // Bitcoin-homed notes are owner-free (bearer)

// recipient static key + sender-derived one-time stealth address
const bPriv = rand();
const B = hx(secp.ProjectivePoint.BASE.multiply(BigInt(bPriv)).toRawBytes(true));
const { ephemeralPub, ownerPub } = stealth.oneTimeAddress({ recipientSpendPub: B, ephemeralPriv: rand() });
const { oneTimePriv } = stealth.recoverOneTimeKey({ recipientSpendPriv: bPriv, ephemeralPub });

// the burned Bitcoin note (value == amount; the bridge conserves it into the lock)
const rIn = randomScalar();
const burned = { ...pool.commitXY(amount, rIn), owner: ZERO_OWNER, blinding: rIn, leafIndex: 0, path: pool.zeros };
const lBlinding = randomScalar();
const mint = stealth.buildBridgeStealthMint({
  chainBinding: cb, asset, poolRoot, burned, ownerPub, amount, deadline, locker, lBlinding,
  bmNext: '0x' + 'ff'.repeat(32), bmIndex: 0, bmPath: pool.zeros,
});

// (1) the L opening sigma binds L to `amount`, and does NOT verify at a different amount
{
  const ctx = pool.intentContext('tacit-bridge-stealth-mint-v1', cb, asset, asset, [[mint.lCx, mint.lCy, ownerPub]], [amount, deadline]);
  assert.equal(pool.verifyOpeningSigma(mint.lCx, mint.lCy, amount, mint.lSigR, mint.lSigZ, ctx), true, 'L opens to amount');
  assert.equal(pool.verifyOpeningSigma(mint.lCx, mint.lCy, amount + 1n, mint.lSigR, mint.lSigZ, ctx), false, 'L does NOT open to a padded amount');
  ok('opening sigma binds L to the cleartext amount (a padded amount is rejected)');
}

// (2) conservation v_in == v_L: a matched kernel verifies; an over-mint (v_in < amount) cannot be built at all
{
  const t = transfer.buildTransfer({ inputs: [{ value: amount, blinding: BigInt(rIn) }], outputs: [{ value: amount, blinding: BigInt(lBlinding) }] });
  assert.equal(transfer.verifyTransfer(t), true, 'matched in/out kernel conserves (v_in == v_L)');
  assert.throws(() => transfer.buildTransfer({ inputs: [{ value: amount, blinding: BigInt(rIn) }], outputs: [{ value: amount + 500n, blinding: BigInt(lBlinding) }] }), /not conserved/, 'an over-mint (out > in) cannot produce a conserving kernel');
  assert.ok(mint.kernelR && mint.kernelZ, 'op carries the conservation kernel');
  ok('kernel enforces v_in == v_L — over-mint is unconstructible');
}

// (3) the minted lock is the existing stealth_lock_leaf, claimable ONLY by the recipient
{
  const lockLeaf = stealth.stealthLockLeaf(asset, mint.lCx, mint.lCy, ownerPub, amount, deadline, locker);
  const fee = 30n, net = amount - fee;
  const mOwner = '0x' + '00'.repeat(31) + '09';
  const claim = stealth.buildStealthClaim({
    chainBinding: cb, asset, lCx: mint.lCx, lCy: mint.lCy, ownerPub, amount, deadline, locker,
    lockSetRoot: '0x' + '33'.repeat(32), lIndex: 0, lPath: pool.zeros, oneTimePriv, mOwner, fee, mBlinding: randomScalar(),
  });
  const mCtx = pool.intentContext('tacit-stealth-claim-out-v1', cb, asset, asset, [[claim.mCx, claim.mCy, mOwner]], [amount, fee]);
  assert.equal(pool.verifyOpeningSigma(claim.mCx, claim.mCy, net, claim.mSigR, claim.mSigZ, mCtx), true, 'claim output M opens to amount − fee');
  const claimMsg = stealth.stealthClaimMsg(cb, lockLeaf, claim.mCx, claim.mCy, mOwner, amount, fee);
  assert.equal(verifySchnorr(fromHex(claim.ownerSig), claimMsg, b32(ownerPub)), true, 'recipient one-time-key claim sig verifies under ownerPub (guest accepts)');
  assert.equal(verifySchnorr(fromHex(hx(signSchnorr(claimMsg, b32(bPriv)))), claimMsg, b32(ownerPub)), false, 'the base spend key (sender-knowable) cannot claim');
  ok('minted lock plugs into OP_STEALTH_CLAIM — only the recipient can claim, not the sender');
}

console.log(`confidential-bridge-stealth-op: all ${n} checks passed`);
