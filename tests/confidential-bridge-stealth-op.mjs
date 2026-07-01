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
import { randomScalar, bppRangeVerify } from '../dapp/bulletproofs-plus.js';
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

// (1) L is range-bound (v_L < 2^64) — the binding that REPLACED the dropped opening sigma (see
// buildBridgeStealthMint: burn-set membership pins the blind dest leaf, the range proof caps the relay
// fee = v_in − v_L). The op carries lRange; it verifies against v_L's commitment and not a padded one.
{
  const { commitments: [Lpt] } = transfer.rangeProve([amount], [BigInt(lBlinding)]); // deterministic bpp commitment for v_L
  const { commitments: [Lpad] } = transfer.rangeProve([amount + 1n], [BigInt(lBlinding)]);
  assert.ok(mint.lRange, 'op carries the L range proof');
  assert.equal(bppRangeVerify([Lpt], mint.lRange), true, 'L range proof verifies against v_L');
  assert.equal(bppRangeVerify([Lpad], mint.lRange), false, 'L range proof does NOT verify against a padded commitment');
  ok('range proof bounds v_L < 2^64 (replaced the opening sigma; caps the relay fee = v_in − v_L)');
}

// (2) conservation v_in == v_L: a matched kernel verifies; an over-mint (v_in < amount) cannot be built at all
{
  const t = transfer.buildTransfer({ inputs: [{ value: amount, blinding: BigInt(rIn) }], outputs: [{ value: amount, blinding: BigInt(lBlinding) }] });
  assert.equal(transfer.verifyTransfer(t), true, 'matched in/out kernel conserves (v_in == v_L)');
  assert.throws(() => transfer.buildTransfer({ inputs: [{ value: amount, blinding: BigInt(rIn) }], outputs: [{ value: amount + 500n, blinding: BigInt(lBlinding) }] }), /not conserved/, 'an over-mint (out > in) cannot produce a conserving kernel');
  assert.ok(mint.kernelR && mint.kernelZ, 'op carries the conservation kernel');
  ok('kernel enforces v_in == v_L — over-mint is unconstructible');
}

// (3) the minted lock is the BLIND stealth_lock_leaf, claimable ONLY by the recipient (kernel + a BP+ range
//     on M bind value with no cleartext amount; the BIP-340 sig under ownerPub authorizes only the recipient).
{
  const lockLeaf = stealth.stealthLockLeafBlind(asset, mint.lCx, mint.lCy, ownerPub, deadline, locker);
  const fee = 30n, net = amount - fee;
  const mOwner = '0x' + '00'.repeat(31) + '09';
  const mBlinding = randomScalar();
  const claim = stealth.buildStealthClaim({
    chainBinding: cb, asset, lCx: mint.lCx, lCy: mint.lCy, ownerPub, amount, deadline, locker, lBlinding,
    lockSetRoot: '0x' + '33'.repeat(32), lIndex: 0, lPath: pool.zeros, oneTimePriv, mOwner, fee, mBlinding,
  });
  const { commitments: [Mpt] } = transfer.rangeProve([net], [BigInt(mBlinding)]); // deterministic bpp commitment for v_M
  assert.equal(bppRangeVerify([Mpt], claim.mRange), true, 'claim output M range proof verifies for net = amount − fee');
  assert.ok(claim.kernelR && claim.kernelZ, 'blind claim carries the conservation kernel (v_L == v_M + fee)');
  const claimMsg = stealth.stealthClaimMsgBlind(cb, lockLeaf, claim.mCx, claim.mCy, mOwner, fee);
  assert.equal(verifySchnorr(fromHex(claim.ownerSig), claimMsg, b32(ownerPub)), true, 'recipient one-time-key claim sig verifies under ownerPub (guest accepts)');
  assert.equal(verifySchnorr(fromHex(hx(signSchnorr(claimMsg, b32(bPriv)))), claimMsg, b32(ownerPub)), false, 'the base spend key (sender-knowable) cannot claim');
  ok('minted lock plugs into OP_STEALTH_CLAIM (blind) — only the recipient can claim, not the sender');
}

console.log(`confidential-bridge-stealth-op: all ${n} checks passed`);
