// Consistency check for the prover-blind stealth witness builders (dapp/confidential-stealth.js): each builder
// must produce a witness the guest re-accepts — the kernel conserves + binds the right leaf, the claim/refund
// range proofs verify, and the claim's one-time signature verifies under ownerPub. Mirrors the guest's checks
// (verify_kernel_with_fee_bound / verify_range / bip340_verify). Run: node tests/blind-stealth-builders.test.mjs
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { createHash } from 'node:crypto';
import { G as bpG, randomScalar, bppRangeVerify } from '../dapp/bulletproofs-plus.js';
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

// Build all points through transfer's own world (its point class differs from the raw secp import).
const PtT = bpG.constructor;
const ptHexT = (h) => PtT.fromHex(String(h).replace(/^0x/, ''));
const C = (v, r) => transfer.commit(BigInt(v), BigInt(r));
const xyOf = (P) => { const a = P.toAffine(); const h = (x) => '0x' + x.toString(16).padStart(64, '0'); return { cx: h(a.x), cy: h(a.y) }; };
const kern = (w) => ({ R: ptHexT(w.kernelR), z: BigInt(w.kernelZ) });
const asset = '0x' + 'aa'.repeat(32), chainBinding = '0x' + 'bb'.repeat(32);
const deadline = 5_000_000_000;
// `locker` is now an x-only refund pubkey (the blind refund requires a BIP-340 sig under it).
const lockerBig = randomScalar();
const lockerPriv = '0x' + lockerBig.toString(16).padStart(64, '0');
const locker = '0x' + [...secp.ProjectivePoint.BASE.multiply(lockerBig).toRawBytes(true).slice(1)].map((b) => b.toString(16).padStart(2, '0')).join('');

// Direct one-time keypair (the ECDH derivation that produces this pair is covered by the existing stealth
// tests; here we just need a consistent (oneTimePriv, ownerPub) so the blind claim signature verifies).
const oneTimeBig = randomScalar();
const oneTimePriv = '0x' + oneTimeBig.toString(16).padStart(64, '0');
const ownerPub = '0x' + [...secp.ProjectivePoint.BASE.multiply(oneTimeBig).toRawBytes(true).slice(1)].map((b) => b.toString(16).padStart(2, '0')).join('');

const amount = 1000n;
const rN = randomScalar(), rL = randomScalar();
const { cx: nCx, cy: nCy } = xyOf(C(amount, rN));

// ── LOCK: N→L value-equal kernel binding the BLIND lock leaf ──
{
  const w = stealth.buildStealthLock({ chainBinding, asset, locker, ownerPub, amount, deadline,
    spendRoot: '0x' + '00'.repeat(32), nNote: { cx: nCx, cy: nCy, blinding: rN, leafIndex: 0, path: [] }, lBlinding: rL });
  const lockLeaf = stealth.stealthLockLeafBlind(asset, w.lCx, w.lCy, ownerPub, deadline, locker);
  assert(transfer.verifyKernel({ inC: [C(amount, rN)], outC: [C(amount, rL)], fee: 0n, kernel: kern(w), outLeaves: [lockLeaf] }), 'lock kernel verifies + binds blind leaf');
  const badLeaf = stealth.stealthLockLeafBlind(asset, w.lCx, w.lCy, '0x' + 'ee'.repeat(32), deadline, locker);
  assert(!transfer.verifyKernel({ inC: [C(amount, rN)], outC: [C(amount, rL)], fee: 0n, kernel: kern(w), outLeaves: [badLeaf] }), 'lock kernel rejects a mutated leaf');
  ok('blind lock: kernel conserves + binds the blind lock leaf');
}

// ── CLAIM: L→M+fee kernel + BP+ range on M + owner signature ──
{
  const fee = 7n, rM = randomScalar();
  const { cx: lCx, cy: lCy } = xyOf(C(amount, rL));
  const w = stealth.buildStealthClaim({ chainBinding, asset, lCx, lCy, ownerPub, amount, deadline, locker, lBlinding: rL,
    lockSetRoot: '0x' + '00'.repeat(32), lIndex: 0, lPath: [], oneTimePriv, mOwner: '0x' + 'd1'.repeat(32), fee, mBlinding: rM });
  assert.equal(w.blind, 1, 'claim flagged blind');
  const mLeaf = transfer.destLeaf(asset, w.mCx, w.mCy, w.mOwner);
  assert(transfer.verifyTransfer({ inC: [C(amount, rL)], outC: [C(amount - fee, rM)], rangeProof: w.mRange, kernel: kern(w), fee, outLeaves: [mLeaf] }), 'claim kernel + M range verify');
  const lockLeaf = stealth.stealthLockLeafBlind(asset, lCx, lCy, ownerPub, deadline, locker);
  const fromHex = (h) => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
  const b32b = (h) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(64, '0').match(/../g).map((x) => parseInt(x, 16)));
  assert(verifySchnorr(fromHex(w.ownerSig), claimMsgBlind(chainBinding, lockLeaf, w.mCx, w.mCy, w.mOwner, fee), b32b(ownerPub)), 'claim one-time signature verifies under ownerPub');
  ok('blind claim: kernel + range + one-time sig');
}

// ── REFUND: L→O+fee kernel + BP+ range on O ──
{
  const fee = 3n, rO = randomScalar();
  const { cx: lCx, cy: lCy } = xyOf(C(amount, rL));
  const w = stealth.buildStealthRefund({ chainBinding, asset, lCx, lCy, ownerPub, amount, deadline, locker, lockerPriv,
    lockSetRoot: '0x' + '00'.repeat(32), lIndex: 0, lPath: [], lBlinding: rL, fee, oBlinding: rO });
  const oLeaf = transfer.destLeaf(asset, w.oCx, w.oCy, locker);
  assert(transfer.verifyTransfer({ inC: [C(amount, rL)], outC: [C(amount - fee, rO)], rangeProof: w.oRange, kernel: kern(w), fee, outLeaves: [oLeaf] }), 'refund kernel + O range verify');
  // F-02 fix: the refund must be locker-authorized (a claimant holding r_L can't forge this).
  const fromHex = (h) => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16)));
  const b32b = (h) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(64, '0').match(/../g).map((x) => parseInt(x, 16)));
  const lockLeaf = stealth.stealthLockLeafBlind(asset, lCx, lCy, ownerPub, deadline, locker);
  assert(verifySchnorr(fromHex(w.lockerSig), stealth.stealthRefundMsg(chainBinding, lockLeaf, w.oCx, w.oCy, fee), b32b(locker)), 'refund locker signature verifies under the locker refund key');
  ok('blind refund: kernel + range + locker auth (F-02)');
}

// ── BRIDGE-STEALTH MINT: unbound kernel v_in = v_L + fee ──
{
  const fee = 11n, rIn = randomScalar(), vin = 2000n;
  const { cx: bCx, cy: bCy } = xyOf(C(vin, rIn));
  const rLb = randomScalar();
  const w = stealth.buildBridgeStealthMint({ chainBinding, asset, poolRoot: '0x' + '00'.repeat(32),
    burned: { cx: bCx, cy: bCy, owner: '0x' + '00'.repeat(32), blinding: rIn, leafIndex: 0, path: [] },
    ownerPub, amount: vin, deadline, locker, lBlinding: rLb, bmNext: '0x' + '00'.repeat(32), bmIndex: 0, bmPath: [], fee });
  assert(transfer.verifyKernel({ inC: [C(vin, rIn)], outC: [C(vin - fee, rLb)], fee, kernel: kern(w), outLeaves: [] }), 'bridge-stealth kernel conserves v_in = v_L + fee');
  assert(bppRangeVerify([C(vin - fee, rLb)], w.lRange), 'bridge-stealth L range verifies (v_L < 2^64 ⇒ fee ≤ v_in)');
  ok('blind bridge-stealth mint: unbound kernel + L range (fee bound)');
}

function claimMsgBlind(cb, lockLeaf, mCx, mCy, mOwner, fee) {
  const b32 = (h) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(64, '0').match(/../g).map((x) => parseInt(x, 16)));
  const be8 = (v) => { const o = new Uint8Array(8); let x = BigInt(v); for (let i = 7; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
  const enc = new TextEncoder();
  const parts = [enc.encode('tacit-stealth-claim-v1'), b32(cb), b32(lockLeaf), b32(mCx), b32(mCy), b32(mOwner), enc.encode('blind'), be8(fee)];
  const tot = parts.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(tot); let p = 0; for (const a of parts) { o.set(a, p); p += a.length; }
  return keccak256(o);
}

console.log(`\n${n} blind stealth-builder checks passed`);
