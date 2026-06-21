#!/usr/bin/env node
// Build the last three settle-op execute/prove fixtures — OP_ADAPTOR_LOCK(12), OP_ADAPTOR_REFUND(14),
// OP_LP_REMOVE(8) — byte-aligned to the guest io::read order (main.rs). Reuses the adaptor kernel/leaf/sigma
// machinery (scripts/build-adaptor-exec-fixture.mjs) + dapp/confidential-pool.js. Lock spends a note N into the
// lock-set as L under a REAL curve point T; refund spends a locked L back to the locker (kernel, no s); lp_remove
// burns a shielded LP-share note for the proportional A/B (3 opening sigmas + floored pool math).
//   node scripts/build-remaining-exec-fixtures.mjs
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const dir = new URL('../contracts/sp1/confidential/fixtures/', import.meta.url);

const N = secp.CURVE.n;
const enc = (s) => new TextEncoder().encode(s);
const KERNEL_DOMAIN = enc('tacit-evm-cxfer-kernel-v1');
const ADAPTOR_LOCK_DOMAIN = enc('tacit-adaptor-lock-v1');
const ZERO = '0x' + '00'.repeat(32);

const _cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const b32 = (h) => Uint8Array.from(String(h).replace(/^0x/, '').padStart(64, '0').match(/../g).map((x) => parseInt(x, 16)));
const hx = (b) => '0x' + Buffer.from(b).toString('hex');
const be = (v, n) => { let x = BigInt(v); const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const bBig = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const mod = (a) => ((a % N) + N) % N;
const ptFrom = (cx, cy) => new secp.ProjectivePoint(BigInt(cx), BigInt(cy), 1n);
const compress = (P) => P.toRawBytes(true);
const kc = (...parts) => hx(keccak_256(_cat(parts.map(b32))));

const noteLeaf = (asset, cx, cy, owner) => kc(asset, cx, cy, owner); // == guest leaf(asset, cx, cy, owner)
const adaptorLockLeaf = (asset, lx, ly, tx, ty, deadline, recipient, locker) =>
  hx(keccak_256(_cat([ADAPTOR_LOCK_DOMAIN, b32(asset), b32(lx), b32(ly), b32(tx), b32(ty), be(deadline, 8), b32(recipient), b32(locker)])));
const singleLeafRootPath = (leafHex) => { let h = b32(leafHex); for (let i = 0; i < 32; i++) h = keccak_256(_cat([h, b32(ZERO)])); return { root: hx(h), path: Array(32).fill(ZERO) }; };
const poolId = (a, b, feeBps) => hx(keccak_256(_cat([b32(a), b32(b), be(feeBps, 32)])));
const lpShareId = (pid) => hx(keccak_256(_cat([b32(pid), enc('lp')])));
const buildKernel = (lcx, lcy, ocx, ocy, rL, rO) => {
  const L = ptFrom(lcx, lcy), O = ptFrom(ocx, ocy);
  const secret = mod(BigInt(rL) - BigInt(rO));
  const cL = compress(L), cO = compress(O);
  const k = mod(bBig(keccak_256(_cat([be(secret, 32), cL, cO, enc('adaptor-kernel-nonce')])))) || 1n;
  const R = secp.ProjectivePoint.BASE.multiply(k);
  const e = mod(bBig(keccak_256(_cat([KERNEL_DOMAIN, cL, cO, compress(R)]))));
  const z = mod(k + e * secret);
  return { kernelR: hx(compress(R)), kernelS: hx(be(z, 32)) };
};

const chainBinding = '0x' + '11'.repeat(32);

// ── OP_ADAPTOR_LOCK (12): spend N → append L under a REAL curve point T ──
{
  const asset = '0x' + 'a5'.repeat(32), locker = '0x' + 'c0'.repeat(32), recipient = '0x' + 'b0'.repeat(32);
  const amount = 5000, deadline = 4000000000;
  const rN = '0x' + '0'.repeat(60) + '3333', rL = '0x' + '0'.repeat(60) + '4444';
  const T = secp.ProjectivePoint.BASE.multiply(7777n).toAffine(); // real curve point
  const tx = hx(be(T.x, 32)), ty = hx(be(T.y, 32));
  const Nn = pool.commitXY(amount, rN), L = pool.commitXY(amount, rL);
  const { root: spendRoot, path: nPath } = singleLeafRootPath(noteLeaf(asset, Nn.cx, Nn.cy, locker));
  const ctx = pool.intentContext('tacit-adaptor-lock-intent-v1', chainBinding, asset, asset,
    [[Nn.cx, Nn.cy, locker], [L.cx, L.cy, recipient], [tx, ty, ZERO]], [BigInt(amount), BigInt(deadline)]);
  const nSig = pool.openingSigma(BigInt(amount), rN, ctx, pool.deriveOpeningNonce(rN, ctx, 'lock-n'));
  const lSig = pool.openingSigma(BigInt(amount), rL, ctx, pool.deriveOpeningNonce(rL, ctx, 'lock-l'));
  writeFileSync(new URL('adaptor_lock_op.json', dir), JSON.stringify({
    chainBinding, spendRoot, asset, locker, recipient, amount, tx, ty, deadline,
    nCx: Nn.cx, nCy: Nn.cy, nIndex: 0, nPath, nSigR: nSig.R, nSigZ: nSig.z,
    lCx: L.cx, lCy: L.cy, lSigR: lSig.R, lSigZ: lSig.z,
    expected: { nullifiers: 1, lockLeaves: 1 },
  }, null, 2));
  console.log('wrote adaptor_lock_op.json (T on-curve ' + tx.slice(0, 12) + '…)');
}

// ── OP_ADAPTOR_REFUND (14): spend a locked L back to the locker (kernel, no s) ──
{
  const asset = '0x' + 'a6'.repeat(32), locker = '0x' + 'c1'.repeat(32), recipient = '0x' + 'b1'.repeat(32);
  const amount = 5000, deadline = 4000000000;
  const tx = '0x' + 'd1'.repeat(32), ty = '0x' + 'd2'.repeat(32); // T bytes (refund reads it for the leaf, no on-curve check)
  const rL = '0x' + '0'.repeat(60) + '5555', rO = '0x' + '0'.repeat(60) + '6666';
  const L = pool.commitXY(amount, rL), O = pool.commitXY(amount, rO);
  const { root: lockSetRoot, path: lPath } = singleLeafRootPath(adaptorLockLeaf(asset, L.cx, L.cy, tx, ty, deadline, recipient, locker));
  const { kernelR, kernelS } = buildKernel(L.cx, L.cy, O.cx, O.cy, rL, rO);
  writeFileSync(new URL('adaptor_refund_op.json', dir), JSON.stringify({
    chainBinding, lockSetRoot, asset, lCx: L.cx, lCy: L.cy, tx, ty, deadline, recipient, locker,
    lIndex: 0, lPath, oCx: O.cx, oCy: O.cy, kernelR, kernelS,
    expected: { lockNullifiers: 1, leaves: 1 },
  }, null, 2));
  console.log('wrote adaptor_refund_op.json');
}

// ── OP_LP_REMOVE (8): burn a shielded LP-share note for the proportional A/B ──
{
  const assetA = '0x' + '11'.repeat(32), assetB = '0x' + '22'.repeat(32); // assetA < assetB (canonical)
  const feeBps = 30, rA_pre = 100000, rB_pre = 200000, sharesPre = 100000, dShares = 1000;
  const dA = Math.floor((rA_pre * dShares) / sharesPre), remA = (rA_pre * dShares) % sharesPre; // 1000, 0
  const dB = Math.floor((rB_pre * dShares) / sharesPre), remB = (rB_pre * dShares) % sharesPre; // 2000, 0
  const opDeadline = 4000000000;
  const sOwner = '0x' + 'e0'.repeat(32), aOwner = '0x' + 'e1'.repeat(32), bOwner = '0x' + 'e2'.repeat(32);
  const rS = '0x' + '0'.repeat(60) + '7777', rAo = '0x' + '0'.repeat(60) + '8888', rBo = '0x' + '0'.repeat(60) + '9999';
  const pid = poolId(assetA, assetB, feeBps), lpAsset = lpShareId(pid);
  const S = pool.commitXY(dShares, rS), A = pool.commitXY(dA, rAo), B = pool.commitXY(dB, rBo);
  const { root: spendRoot, path: sPath } = singleLeafRootPath(noteLeaf(lpAsset, S.cx, S.cy, sOwner));
  const ctx = pool.intentContext('tacit-lp-remove-v1', chainBinding, assetA, assetB,
    [[S.cx, S.cy, sOwner], [A.cx, A.cy, aOwner], [B.cx, B.cy, bOwner]],
    [BigInt(dShares), BigInt(dA), BigInt(dB), BigInt(opDeadline)]);
  const sSig = pool.openingSigma(BigInt(dShares), rS, ctx, pool.deriveOpeningNonce(rS, ctx, 'lpr-s'));
  const aSig = pool.openingSigma(BigInt(dA), rAo, ctx, pool.deriveOpeningNonce(rAo, ctx, 'lpr-a'));
  const bSig = pool.openingSigma(BigInt(dB), rBo, ctx, pool.deriveOpeningNonce(rBo, ctx, 'lpr-b'));
  writeFileSync(new URL('lp_remove_op.json', dir), JSON.stringify({
    chainBinding, spendRoot, assetA, assetB, feeBps, rAPre: rA_pre, rBPre: rB_pre, sharesPre,
    sCx: S.cx, sCy: S.cy, sOwner, sIndex: 0, sPath, dShares, sSigR: sSig.R, sSigZ: sSig.z,
    dA, remA, dB, remB,
    aCx: A.cx, aCy: A.cy, aOwner, aSigR: aSig.R, aSigZ: aSig.z,
    bCx: B.cx, bCy: B.cy, bOwner, bSigR: bSig.R, bSigZ: bSig.z, opDeadline,
    expected: { nullifiers: 1, leaves: 2, liquidity: 1, poolId: pid },
  }, null, 2));
  console.log('wrote lp_remove_op.json (pid ' + pid.slice(0, 12) + '…)');
}
