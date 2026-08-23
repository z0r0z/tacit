#!/usr/bin/env node
// Build the OP_ADAPTOR_CLAIM execute/prove fixture (contracts/sp1/confidential/fixtures/adaptor_claim_op.json),
// byte-aligned to the settle guest's io::read order (main.rs OP_ADAPTOR_CLAIM). The claim spends a locked note L
// (∈ a single-leaf lock-set) and mints the recipient output O, value-conserved by the adaptor-completed kernel
// over (L_C − O_C); committing the kernel s is the t-reveal. We build, from scratch:
//   • adaptor_lock_leaf  = keccak(ADAPTOR_LOCK_DOMAIN ‖ asset ‖ Lx ‖ Ly ‖ Tx ‖ Ty ‖ deadline_be8 ‖ recipient ‖ locker)
//   • O opening-sigma    = pool.openingSigma over ctx "tacit-adaptor-claim-out-v1" (recipient controls O)
//   • conservation kernel = Schnorr PoK of (r_L − r_O) for L_C − O_C: e=keccak(KERNEL_DOMAIN‖L_C‖O_C‖R), z=k+e·secret
//   node scripts/build-adaptor-exec-fixture.mjs
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { signSchnorr, verifySchnorr } from '../dapp/bulletproofs.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const dir = new URL('../contracts/sp1/confidential/fixtures/', import.meta.url);

const N = secp.CURVE.n;
const enc = (s) => new TextEncoder().encode(s);
const KERNEL_DOMAIN = enc('tacit-evm-cxfer-kernel-v1');
const ADAPTOR_LOCK_DOMAIN = enc('tacit-adaptor-lock-v1');
const ADAPTOR_CLAIM_DOMAIN = enc('tacit-adaptor-claim-auth-v1');
const ZERO = '0x' + '00'.repeat(32);

const _cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const b32 = (h) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(64, '0').match(/../g).map((x) => parseInt(x, 16)));
const fh = (h) => Uint8Array.from(String(h).replace(/^0x/, '').match(/../g).map((x) => parseInt(x, 16))); // raw (any length; kernelR is 33B)
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const xonly = (k) => hx(secp.ProjectivePoint.BASE.multiply(BigInt(k)).toRawBytes(true).slice(1)); // x-only BIP-340 pubkey
const be = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const be8 = (v) => be(v, 8);
const bBig = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const mod = (a) => ((a % N) + N) % N;
const ptFrom = (cx, cy) => new secp.ProjectivePoint(BigInt(cx), BigInt(cy), 1n);
const compress = (P) => P.toRawBytes(true); // 33-byte compressed point

// guest adaptor_lock_leaf (raw concat keccak)
const adaptorLockLeaf = (asset, lx, ly, tx, ty, deadline, recipient, locker) =>
  hx(keccak_256(_cat([ADAPTOR_LOCK_DOMAIN, b32(asset), b32(lx), b32(ly), b32(tx), b32(ty), be8(deadline), b32(recipient), b32(locker)])));

// single-leaf (index 0) lock-set: root + 32-deep zero-sibling path
const singleLeafRootPath = (leafHex) => { let h = b32(leafHex); for (let i = 0; i < 32; i++) h = keccak_256(_cat([h, b32(ZERO)])); return { root: hx(h), path: Array(32).fill(ZERO) }; };

// conservation kernel over (L_C − O_C) = (r_L − r_O)·G (same value): Schnorr PoK of the blinding difference.
const buildKernel = (lcx, lcy, ocx, ocy, rL, rO) => {
  const L = ptFrom(lcx, lcy), O = ptFrom(ocx, ocy);
  const secret = mod(BigInt(rL) - BigInt(rO));
  const cL = compress(L), cO = compress(O);
  const k = mod(bBig(keccak_256(_cat([be(secret, 32), cL, cO, enc('adaptor-kernel-nonce')]))) ) || 1n;
  const R = secp.ProjectivePoint.BASE.multiply(k);
  const e = mod(bBig(keccak_256(_cat([KERNEL_DOMAIN, cL, cO, compress(R)]))));
  const z = mod(k + e * secret);
  return { kernelR: hx(compress(R)), kernelS: hx(be(z, 32)) };
};

const chainBinding = '0x' + '11'.repeat(32);
const asset = '0x' + 'a5'.repeat(32);
// The recipient is a REAL x-only BIP-340 pubkey: the claim path verifies the recipient's signature under it,
// and only the recipient (who does NOT know rL) can produce the completed-adaptor kernel.
const recipientPriv = '0x' + '0'.repeat(60) + 'b0b0';
const recipient = xonly(recipientPriv);
// `locker` in the CLAIM fixture = the lock leaf's REFUND field = refund_pub (a real x-only key, DISTINCT from
// N's H(nk) spend-owner). CLAIM only reconstructs the leaf with it (no sig under it here); the refund path signs.
const refundPriv = '0x' + '0'.repeat(60) + 'c0c0';
const locker = xonly(refundPriv);
// The claimed output's SPEND owner = H(nk) (a hash, no key) — distinct from the recipient BIP-340 auth key.
const outNk = '0x' + 'f0'.repeat(32);
const outOwner = pool.nkToOwner(outNk);
const tx = '0x' + 'd1'.repeat(32), ty = '0x' + 'd2'.repeat(32); // the adaptor point T (bytes; the lock leaf binds it)
const deadline = 4000000000; // far future
const amount = 5000;
const rL = '0x' + '0'.repeat(60) + '1111'; // locker's blinding (L's secret)
const rO = '0x' + '0'.repeat(60) + '2222'; // recipient's blinding (O's secret)

const L = pool.commitXY(amount, rL);
const O = pool.commitXY(amount, rO);
const lockLeaf = adaptorLockLeaf(asset, L.cx, L.cy, tx, ty, deadline, recipient, locker);
const { root: lockSetRoot, path: lPath } = singleLeafRootPath(lockLeaf);

// O opening-sigma — guest ctx: tacit-adaptor-claim-out-v1, assetA=assetB=asset, notes=[(O,recipient),(L,locker)], amounts=[amount,deadline]
const oCtx = pool.intentContext('tacit-adaptor-claim-out-v1', chainBinding, asset, asset,
  [[O.cx, O.cy, recipient], [L.cx, L.cy, locker]], [BigInt(amount), BigInt(deadline)]);
const oNonce = pool.deriveOpeningNonce(rO, oCtx, 'adaptor-claim-out');
const oSig = pool.openingSigma(BigInt(amount), rO, oCtx, oNonce);

const { kernelR, kernelS } = buildKernel(L.cx, L.cy, O.cx, O.cy, rL, rO);

// RECIPIENT AUTHORIZATION — BIP-340 sig under `recipient` over adaptor_claim_msg (cxfer-core lib.rs:1974):
//   keccak(ADAPTOR_CLAIM_DOMAIN ‖ chainBinding ‖ lockLeaf ‖ lockNu ‖ outLeaf ‖ amount_be8 ‖ kernelR(33) ‖ kernelS(32))
const lockNu = pool.nullifier(lockLeaf); // guest l_nu = nullifier(lock_lf)
const outLeaf = pool.leaf(asset, O.cx, O.cy, outOwner);
const claimMsg = keccak_256(_cat([
  ADAPTOR_CLAIM_DOMAIN, b32(chainBinding), b32(lockLeaf), b32(lockNu), b32(outLeaf), be8(amount), fh(kernelR), fh(kernelS),
]));
const recipientSig = hx(signSchnorr(claimMsg, b32(recipientPriv)));

// ── self-verification (mirror the guest asserts; throw before the box ever sees a bad fixture) ──
if (!pool.verifyPath(lockLeaf, 0, lPath, lockSetRoot)) throw new Error('claim: lock-set membership self-check failed');
if (!pool.verifyOpeningSigma(O.cx, O.cy, amount, oSig.R, oSig.z, oCtx)) throw new Error('claim: O opening-sigma self-check failed');
{
  // guest verify_kernel over (L_C − O_C): G·z == R + x·e, x = L − O, e = keccak(DOMAIN ‖ cL ‖ cO ‖ compress(R))
  const Lp = ptFrom(L.cx, L.cy), Op = ptFrom(O.cx, O.cy), R = secp.ProjectivePoint.fromHex(kernelR.replace(/^0x/, ''));
  const e = mod(bBig(keccak_256(_cat([KERNEL_DOMAIN, compress(Lp), compress(Op), compress(R)]))));
  const x = Lp.add(Op.negate());
  const ok = compress(secp.ProjectivePoint.BASE.multiply(mod(BigInt(kernelS)))).join() === compress(R.add(x.multiply(e))).join();
  if (!ok) throw new Error('claim: kernel self-check failed');
}
if (!verifySchnorr(fh(recipientSig), claimMsg, b32(recipient))) throw new Error('claim: recipient BIP-340 self-check failed');

const fx = {
  chainBinding, spendRoot: ZERO, lockSetRoot,
  asset, lCx: L.cx, lCy: L.cy, tx, ty, deadline, recipient, locker,
  lIndex: 0, lPath, amount, oCx: O.cx, oCy: O.cy, oSigR: oSig.R, oSigZ: oSig.z, kernelR, kernelS,
  outOwner, recipientSig,
  expected: { lockNullifiers: 1, leaves: 1, adaptorClaimS: 1, lockNullifier: lockNu, outLeaf },
};
writeFileSync(new URL('adaptor_claim_op.json', dir), JSON.stringify(fx, null, 2));
console.log('wrote adaptor_claim_op.json (self-checks PASS; lockSetRoot ' + lockSetRoot.slice(0, 14) + '…, kernelS ' + kernelS.slice(0, 14) + '…)');
